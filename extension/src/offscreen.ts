// offscreen.ts — PM-86：麥克風錄音（offscreen document，USER_MEDIA 用途）
// 一次授權麥克風（授給 chrome-extension://），之後所有網站通用，不再每站彈授權。
// background 經 chrome.runtime.sendMessage 下 OFFSCREEN_START_MIC / OFFSCREEN_STOP_MIC 指令。

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];

// PM-97：即時音量分析（AudioContext + AnalyserNode），每 200ms 回報 MIC_VOLUME 給 background。
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let volumeTimer: ReturnType<typeof setInterval> | null = null;

async function startVolumeMeter(stream: MediaStream): Promise<void> {
  try {
    audioCtx = new AudioContext();
    // PM-192 修：offscreen document 無 user gesture → AudioContext 預設 'suspended'，
    //   analyser 不會被推進、getByteFrequencyData 全 0 → 音量條完全不動（即時字幕走頁面 gesture 故正常）。
    //   必須 resume() 讓 context 運轉（麥克風擷取型 context 允許在無 gesture 下 resume）。
    if (audioCtx.state === 'suspended') {
      try {
        await audioCtx.resume();
      } catch (e) {
        console.warn('[BugEzy offscreen] AudioContext resume 失敗:', e);
      }
    }
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    volumeTimer = setInterval(() => {
      if (!analyser) return;
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const level = Math.min(avg / 128, 1);
      chrome.runtime.sendMessage({ type: 'MIC_VOLUME', level }).catch(() => {});
    }, 200);
    console.log('[BugEzy offscreen] 音量分析啟動（AudioContext state=' + audioCtx.state + '）');
  } catch (err) {
    console.error('[BugEzy offscreen] 音量分析啟動失敗:', err);
  }
}

function stopVolumeMeter(): void {
  if (volumeTimer) {
    clearInterval(volumeTimer);
    volumeTimer = null;
  }
  if (audioCtx) {
    void audioCtx.close();
    audioCtx = null;
    analyser = null;
  }
}

async function startRecording(): Promise<{ ok: boolean; error?: string }> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000, // Whisper 最佳
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.start(1000); // 每秒一個 chunk
    void startVolumeMeter(stream); // PM-97：同一條 stream 開音量表（PM-192：內含 AudioContext.resume）
    console.log('[BugEzy offscreen] 錄音開始');
    return { ok: true };
  } catch (err) {
    // PM-192 修：getUserMedia 失敗回報給 background（原本吞掉→背景以為成功，麥克風實則沒開）
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('[BugEzy offscreen] getUserMedia 失敗:', msg);
    return { ok: false, error: msg };
  }
}

function stopRecording(): Promise<{ audioBlob?: string; error?: string }> {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      resolve({ error: '未在錄音中' });
      return;
    }
    const rec = mediaRecorder;
    stopVolumeMeter(); // PM-97：先停音量表
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm;codecs=opus' });
      chunks = [];
      rec.stream.getTracks().forEach((t) => t.stop());
      mediaRecorder = null;

      if (blob.size < 100) {
        resolve({ error: '錄音太短' });
        return;
      }
      // 轉 base64 dataURL 傳給 background（service worker 無法直接持有 Blob 物件）
      const reader = new FileReader();
      reader.onloadend = () => resolve({ audioBlob: reader.result as string });
      reader.readAsDataURL(blob);
    };
    rec.stop();
  });
}

chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
  if (msg?.type === 'OFFSCREEN_START_MIC') {
    // PM-192 修：等 startRecording（getUserMedia）真正完成再回應，把成功/失敗如實回報（原本秒回 ok:true 蓋掉真實結果）
    startRecording().then(sendResponse);
    return true; // async 回應
  } else if (msg?.type === 'OFFSCREEN_STOP_MIC') {
    stopRecording().then(sendResponse);
    return true; // async 回應
  }
});
