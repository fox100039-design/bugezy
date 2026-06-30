// offscreen.ts — PM-86：麥克風錄音（offscreen document，USER_MEDIA 用途）
// 一次授權麥克風（授給 chrome-extension://），之後所有網站通用，不再每站彈授權。
// background 經 chrome.runtime.sendMessage 下 OFFSCREEN_START_MIC / OFFSCREEN_STOP_MIC 指令。

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];

async function startRecording(): Promise<void> {
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
    console.log('[BugEzy offscreen] 錄音開始');
  } catch (err) {
    console.error('[BugEzy offscreen] getUserMedia 失敗:', err);
  }
}

function stopRecording(): Promise<{ audioBlob?: string; error?: string }> {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      resolve({ error: '未在錄音中' });
      return;
    }
    const rec = mediaRecorder;
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
    void startRecording();
    sendResponse({ ok: true });
  } else if (msg?.type === 'OFFSCREEN_STOP_MIC') {
    stopRecording().then(sendResponse);
    return true; // async 回應
  }
});
