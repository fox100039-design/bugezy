// inject.ts — 在頁面 MAIN world 執行
// 唯有 MAIN world 能攔截到頁面自己的 console / fetch / XHR，
// 因此 rrweb 側錄 + Console 攔截 + Network 攔截 三件事都在這裡做。
// 控制指令與結果透過 window.postMessage 與 ISOLATED world 的 content.ts 溝通。
//
// PM-04：全程加診斷 log、try/catch 硬化、防重複注入、READY/STARTED 握手，
//        讓「rrweb/console/network 全空」時能在 Console 直接看出斷點。

import { record } from 'rrweb';
import {
  BUGEZY_SOURCE,
  blog,
  type ConsoleLog,
  type InjectCommand,
  type InjectMessage,
  type NetworkError,
  type PageInfo,
  type RecordingPayload,
  type VoiceSegment,
} from './types';

// ── 最小 SpeechRecognition 型別（TS DOM lib 未含此 API 宣告）──
interface SRAlternative {
  readonly transcript: string;
}
interface SRResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SRAlternative;
}
interface SRResultList {
  readonly length: number;
  readonly [index: number]: SRResult;
}
interface SREvent {
  readonly resultIndex: number;
  readonly results: SRResultList;
}
interface SRErrorEvent {
  readonly error: string;
  readonly message: string;
}
interface SRInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SRCtor = new () => SRInstance;

// ── 防重複注入：同一頁若被注入兩次，第二次直接跳出 ────────
declare global {
  interface Window {
    __bugezyInjected?: boolean;
  }
}
if (window.__bugezyInjected) {
  blog('inject 已存在，略過重複注入', location.href);
} else {
  window.__bugezyInjected = true;
  main();
}

function post(msg: InjectMessage) {
  window.postMessage(msg, '*');
}

function main() {
  blog('inject loaded（MAIN world）', location.href);

  let recording = false;
  let stopRrweb: (() => void) | null = null;
  let events: unknown[] = [];
  let consoleLogs: ConsoleLog[] = [];
  let networkErrors: NetworkError[] = [];
  // PM-34：rrweb 太頻繁，改每 5 秒批次 flush；其餘資料每筆即時 flush
  let lastFlushedIndex = 0;
  let rrwebFlushInterval: ReturnType<typeof setInterval> | null = null;
  // 語音辨識（PM-08：直接跑在 MAIN world，麥克風授權歸屬網站）
  let voiceSegments: VoiceSegment[] = [];
  let recognition: SRInstance | null = null;
  let voiceActive = false;
  let captionBar: HTMLDivElement | null = null; // PM-24：錄製中即時字幕

  function showCaptionBar() {
    document.getElementById('bugezy-live-caption')?.remove();
    const bar = document.createElement('div');
    bar.id = 'bugezy-live-caption';
    // PM-30：改 flex 佈局，bar 本體 pointer-events:none，內部按鈕 auto
    bar.style.cssText =
      'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:rgba(0,0,0,0.85);color:#fff;padding:12px 28px;border-radius:12px;font-size:22px;max-width:80%;font-family:system-ui,sans-serif;transition:opacity 0.3s;letter-spacing:0.5px;display:flex;align-items:center;gap:8px;';

    // 文字部分用 span 包裹（PM-30：更新字幕只動這個 span，避免清掉 🔄 按鈕）
    const textSpan = document.createElement('span');
    textSpan.id = 'bugezy-caption-text';
    textSpan.style.cssText = 'flex:1;pointer-events:none;text-align:center;';
    textSpan.textContent = '🔴 錄製中，可以用中文描述問題...';

    // 永久重啟按鈕（PM-30：靜默中斷時使用者隨時可手動重啟）
    const restartBtn = document.createElement('button');
    restartBtn.id = 'bugezy-voice-restart';
    restartBtn.textContent = '🔄';
    restartBtn.title = '重新啟動語音辨識';
    restartBtn.style.cssText =
      'pointer-events:auto;background:rgba(124,58,237,0.8);color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:16px;cursor:pointer;margin-left:12px;flex-shrink:0;vertical-align:middle;';
    restartBtn.addEventListener('click', async () => {
      restartBtn.disabled = true;
      await forceRestartVoice();
      restartBtn.disabled = false;
    });

    bar.appendChild(textSpan);
    bar.appendChild(restartBtn);
    document.body.appendChild(bar);
    captionBar = bar;

    // ── 右上角已確認文字面板（PM-27：堆疊顯示 final，使用者看得到已收錄內容）──
    document.getElementById('bugezy-voice-panel')?.remove();
    const panel = document.createElement('div');
    panel.id = 'bugezy-voice-panel';
    panel.style.cssText =
      'position:fixed;top:200px;right:12px;z-index:2147483647;pointer-events:none;width:260px;max-height:50vh;overflow-y:auto;background:rgba(0,0,0,0.8);border:1px solid rgba(124,58,237,0.5);border-radius:12px;padding:10px 14px;font-family:system-ui,sans-serif;font-size:14px;color:#eee;line-height:1.6;transition:opacity 0.3s;'; // PM-40/44：60→140→200px 避免被書籤列/其他擴充遮擋

    // PM-31 Bug1：header 整列 pointer-events:none，只有收合按鈕本身可點，
    // 避免使用者誤點面板其他區域觸發奇怪行為導致頁面卡死。
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.15);pointer-events:none;';
    header.innerHTML = '<span style="font-size:12px;color:#a78bfa;">📝 語音記錄</span>';

    const content = document.createElement('div');
    content.id = 'bugezy-voice-content';
    content.style.cssText = 'white-space:pre-wrap;word-break:break-word;';

    // 收合按鈕獨立，只有它是 pointer-events:auto
    let collapsed = false;
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'bugezy-panel-toggle';
    toggleBtn.textContent = '▼';
    toggleBtn.title = '收合/展開';
    toggleBtn.style.cssText =
      'pointer-events:auto;background:rgba(124,58,237,0.6);border:none;border-radius:4px;color:#fff;font-size:12px;padding:2px 8px;cursor:pointer;';
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      content.style.display = collapsed ? 'none' : 'block';
      toggleBtn.textContent = collapsed ? '▶' : '▼';
    });
    header.appendChild(toggleBtn);

    panel.appendChild(header);
    panel.appendChild(content);
    document.body.appendChild(panel);

    // PM-36：建完面板後請 content 從 background buffer 取回歷史語音，填回面板
    // （跳頁恢復時面板才不會是空的）
    post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'REQUEST_VOICE_HISTORY' });
  }
  function hideCaptionBar() {
    captionBar?.remove();
    captionBar = null;
    document.getElementById('bugezy-voice-panel')?.remove();
  }

  /** PM-49：鍵盤模式提示條（語音關閉，僅告知錄製中） */
  function showKeyboardModeBar() {
    document.getElementById('bugezy-live-caption')?.remove();
    const bar = document.createElement('div');
    bar.id = 'bugezy-live-caption';
    bar.style.cssText =
      'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:rgba(0,0,0,0.85);color:#fff;padding:12px 28px;border-radius:12px;font-size:18px;font-family:system-ui,sans-serif;';
    bar.textContent = '🔇 鍵盤模式 — 錄製中（語音已關閉）';
    document.body.appendChild(bar);
    captionBar = bar;
  }

  /** PM-30：更新字幕文字只動 textSpan，保留 🔄 按鈕不被清掉 */
  function setCaptionText(text: string) {
    const el = document.getElementById('bugezy-caption-text');
    if (el) el.textContent = text;
  }

  // PM-33：自動重啟連續失敗計數（放在 createRecognition 外，建新實例不重置）
  let autoRestartFails = 0;

  /**
   * PM-32：建立一個全新的 SpeechRecognition 實例（可重複呼叫）。
   * 每次都掛上「全新」的 event handlers，不複製舊實例的閉包——
   * 這正是修掉「按 🔄 重啟後語音死掉」的關鍵（舊作法複製已失效的 handler）。
   */
  function createRecognition(): SRInstance | null {
    const win = window as unknown as {
      SpeechRecognition?: SRCtor;
      webkitSpeechRecognition?: SRCtor;
    };
    const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
    if (!SR) return null;

    const rec = new SR();
    rec.lang = 'zh-TW';
    rec.continuous = true;
    rec.interimResults = false;

    rec.onresult = (e: SREvent) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const text = e.results[i][0].transcript.trim();
          if (text) {
            const seg: VoiceSegment = { text, timestamp: Date.now(), isFinal: true };
            voiceSegments.push(seg); // 本地也存（同頁 STOP 用）
            post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'FLUSH_VOICE', segment: seg }); // PM-34
            blog('voice segment:', text.slice(0, 40));

            // 右上面板：堆疊已確認文字（PM-27）
            const voiceContent = document.getElementById('bugezy-voice-content');
            if (voiceContent) {
              voiceContent.textContent += (voiceContent.textContent ? '\n' : '') + text;
              const panel = document.getElementById('bugezy-voice-panel');
              if (panel) panel.scrollTop = panel.scrollHeight;
            }

            // 底部字幕：短暫顯示確認後回到聆聽中
            setCaptionText(`✅ ${text}`);
            window.setTimeout(() => {
              if (voiceActive) setCaptionText('🔴 聆聽中...');
            }, 1500);
          }
        }
      }
    };

    rec.onend = () => {
      // 靜默自停 → 仍在錄製就自動重啟；連續失敗 3 次就停手，等使用者按 🔄
      if (voiceActive) {
        blog('SpeechRecognition onend → auto restart');
        try {
          rec.start();
          autoRestartFails = 0; // 成功就歸零
        } catch {
          autoRestartFails++;
          blog(`auto restart 失敗 (第 ${autoRestartFails} 次)`);
          if (autoRestartFails >= 3) {
            setCaptionText('⚠ 語音中斷，按 🔄 重啟');
            blog('auto restart 連續失敗 3 次，等待手動重啟');
          }
        }
      }
    };

    rec.onerror = (e: SRErrorEvent) => {
      blog('SpeechRecognition error:', e.error, e.message || '');
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        voiceActive = false;
        setCaptionText('❌ 麥克風被拒絕');
      }
    };

    return rec;
  }

  /**
   * PM-33：手動強制重啟語音（永久 🔄 按鈕用）。
   * Chrome 多次 onend→restart 後音訊管線會卡死，新實例也連不上麥克風；
   * 因此先用 getUserMedia 刷新音訊連線（🔄 點擊是有效 user gesture，保證能過），
   * 等 500ms 讓 Chrome 清理舊資源，再建全新的 SpeechRecognition。
   */
  async function forceRestartVoice() {
    blog('手動強制重啟語音');
    if (!voiceActive) return;

    setCaptionText('🔄 重啟中...');

    // Step 1：停掉舊的並丟棄
    try {
      recognition?.stop();
    } catch {
      /* 忽略 */
    }
    recognition = null;

    // Step 2：用 getUserMedia 強制刷新瀏覽器音訊連線（拿到立刻釋放）
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      blog('getUserMedia 刷新成功');
    } catch (err) {
      blog('getUserMedia 刷新失敗（麥克風可能被封鎖）', err);
      setCaptionText('❌ 麥克風無法存取');
      return;
    }

    // Step 3：等 500ms 讓 Chrome 清理舊的音訊資源
    await new Promise((r) => setTimeout(r, 500));

    // Step 4：建全新實例（全新 handlers）
    recognition = createRecognition();
    if (recognition) {
      try {
        recognition.start();
        autoRestartFails = 0; // 手動重啟成功 → 重置自動重啟失敗計數
        setCaptionText('🔴 語音已重啟，繼續說...');
        blog('語音強制重啟成功');
      } catch (err) {
        blog('語音強制重啟失敗', err);
        setCaptionText('❌ 語音重啟失敗，請重新整理頁面');
      }
    }
  }

  // 保留原始參考（只 patch 一次，靠 recording 旗標決定是否收集）
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const originalFetch = window.fetch;
  const OriginalXHR = window.XMLHttpRequest;

  function stringifyArgs(args: unknown[]): string {
    return args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
  }

  // ── A. Console 攔截（只抓 warn + error）──────────────────
  console.warn = (...args: unknown[]) => {
    if (recording) {
      const entry: ConsoleLog = { level: 'warn', message: stringifyArgs(args), timestamp: Date.now() };
      consoleLogs.push(entry);
      post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'FLUSH_CONSOLE', log: entry }); // PM-34
    }
    return originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    if (recording) {
      const entry: ConsoleLog = { level: 'error', message: stringifyArgs(args), timestamp: Date.now() };
      consoleLogs.push(entry);
      post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'FLUSH_CONSOLE', log: entry }); // PM-34
    }
    return originalError(...args);
  };

  // ── B. Network 攔截 — fetch（只抓 4xx / 5xx）─────────────
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const start = Date.now();
    const [input, init] = args;
    const response = await originalFetch(...args);
    try {
      if (recording && response.status >= 400) {
        const body = await response
          .clone()
          .text()
          .catch(() => '');
        let url = '';
        if (typeof input === 'string') url = input;
        else if (input instanceof URL) url = input.href;
        else url = (input as Request).url;
        const entry: NetworkError = {
          method: (init?.method || (input as Request).method || 'GET').toUpperCase(),
          url,
          status: response.status,
          responseBody: body.slice(0, 2000),
          timestamp: start,
          duration: Date.now() - start,
        };
        networkErrors.push(entry);
        post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'FLUSH_NETWORK', error: entry }); // PM-34
      }
    } catch (err) {
      blog('fetch 攔截處理失敗（已忽略，不影響頁面）', err);
    }
    return response;
  };

  // ── B. Network 攔截 — XMLHttpRequest（只抓 4xx / 5xx）────
  const xhrMeta = new WeakMap<
    XMLHttpRequest,
    { method: string; url: string; start: number; body?: string }
  >();
  const originalOpen = OriginalXHR.prototype.open;
  const originalSend = OriginalXHR.prototype.send;

  OriginalXHR.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    xhrMeta.set(this, { method: method.toUpperCase(), url: String(url), start: 0 });
    // @ts-expect-error 透傳原生簽名
    return originalOpen.call(this, method, url, ...rest);
  };

  OriginalXHR.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const meta = xhrMeta.get(this);
    if (meta) {
      meta.start = Date.now();
      if (typeof body === 'string') meta.body = body.slice(0, 2000);
      this.addEventListener('loadend', () => {
        if (recording && this.status >= 400) {
          const entry: NetworkError = {
            method: meta.method,
            url: meta.url,
            status: this.status,
            requestBody: meta.body,
            responseBody:
              typeof this.responseText === 'string' ? this.responseText.slice(0, 2000) : undefined,
            timestamp: meta.start,
            duration: Date.now() - meta.start,
          };
          networkErrors.push(entry);
          post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'FLUSH_NETWORK', error: entry }); // PM-34
        }
      });
    }
    return originalSend.call(this, body ?? null);
  };

  // ── 控制：開始 / 停止 ─────────────────────────────────────
  function startRecording(options?: { keyboardMode?: boolean }): boolean {
    if (recording) {
      blog('START 重複呼叫，已在錄製中');
      return stopRrweb !== null;
    }
    recording = true;
    events = [];
    consoleLogs = [];
    networkErrors = [];
    lastFlushedIndex = 0; // PM-34
    let rrwebOk = false;
    try {
      // PM-46：不再用 blockSelector 排除 BugEzy overlay（改由編輯頁「乾淨/原始」toggle
      // 注入 CSS 控制顯示），這樣使用者可自由切換要不要看自家字幕/面板。
      const stop = record({
        emit(event) {
          events.push(event);
        },
      });
      stopRrweb = stop ?? null;
      rrwebOk = stopRrweb !== null;
      blog('rrweb record() 已啟動', rrwebOk ? 'OK' : '回傳 undefined');
    } catch (err) {
      // rrweb 啟動失敗不影響 console/network 攔截（recording 已為 true）
      blog('⚠ rrweb record() 拋錯，DOM 軌跡將為空，但 console/network 仍會收集', err);
    }

    // PM-34：每 5 秒批次 flush 新增的 rrweb 事件給 background 暫存（頁面跳轉不丟）
    if (rrwebFlushInterval !== null) clearInterval(rrwebFlushInterval);
    rrwebFlushInterval = setInterval(() => {
      if (events.length > lastFlushedIndex) {
        const batch = events.slice(lastFlushedIndex);
        lastFlushedIndex = events.length;
        post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'FLUSH_RRWEB', events: batch });
      }
    }, 5000);

    // ── D. 語音辨識（需 user gesture 授權麥克風）──────────
    voiceSegments = [];
    if (options?.keyboardMode) {
      // PM-49：鍵盤模式 — 完全跳過語音，只顯示簡單提示條（rrweb/console/network 照常）
      blog('鍵盤模式：跳過語音初始化');
      voiceActive = false;
      showKeyboardModeBar();
    } else {
      showCaptionBar(); // PM-24：錄製中浮動字幕
      voiceActive = true;
      const win = window as unknown as {
        SpeechRecognition?: SRCtor;
        webkitSpeechRecognition?: SRCtor;
      };
      const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
      if (SR) {
        tryStartVoice(SR);
      } else {
        blog('⚠ 此瀏覽器不支援 SpeechRecognition，語音不可用');
        voiceActive = false;
      }
    }

    blog('START：開始錄製', options?.keyboardMode ? '(鍵盤模式)' : '');
    return rrwebOk;
  }

  // ── 語音：依授權狀態決定直接啟動或彈授權浮層 ──────────────
  function tryStartVoice(SR: SRCtor) {
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((result) => {
        if (result.state === 'granted') {
          // 已授權 → 直接啟動，不彈按鈕
          blog('麥克風已授權，直接啟動語音');
          initSpeechRecognition(SR);
        } else {
          // 未授權或 prompt → 注入浮動按鈕，等使用者點擊（取得有效 user gesture）
          blog('麥克風未授權，注入授權按鈕');
          showMicPermissionOverlay(SR);
        }
      })
      .catch(() => {
        // Permissions API 不支援 → 直接試，失敗就算了
        blog('Permissions API 查詢失敗，直接嘗試啟動');
        initSpeechRecognition(SR);
      });
  }

  // 注入頁面頂部授權浮層：allowBtn 的 click 才是 Chrome 認可的 user gesture
  function showMicPermissionOverlay(SR: SRCtor) {
    // 避免重複注入
    const existing = document.getElementById('bugezy-mic-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'bugezy-mic-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 2147483647;
      background: rgba(0,0,0,0.85);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 12px 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.3);
    `;

    const label = document.createElement('span');
    label.textContent = '🎤 BugEzy 需要麥克風來錄語音';

    const allowBtn = document.createElement('button');
    allowBtn.textContent = '允許麥克風';
    allowBtn.style.cssText = `
      background: #7c3aed;
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 6px 16px;
      font-size: 14px;
      cursor: pointer;
      font-weight: 600;
    `;

    const skipBtn = document.createElement('button');
    skipBtn.textContent = '跳過（不錄語音）';
    skipBtn.style.cssText = `
      background: transparent;
      color: #aaa;
      border: 1px solid #555;
      border-radius: 6px;
      padding: 6px 16px;
      font-size: 13px;
      cursor: pointer;
    `;

    overlay.appendChild(label);
    overlay.appendChild(allowBtn);
    overlay.appendChild(skipBtn);
    document.body.appendChild(overlay);

    allowBtn.addEventListener('click', async () => {
      try {
        // 使用者在頁面上的直接點擊 = 有效 user gesture
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop()); // 只要權限，不要 stream
        blog('✓ 麥克風授權成功');
        overlay.remove();
        initSpeechRecognition(SR);
      } catch (err) {
        blog('✗ 麥克風授權被拒絕', err);
        overlay.remove();
        voiceActive = false;
      }
    });

    skipBtn.addEventListener('click', () => {
      blog('使用者跳過語音');
      overlay.remove();
      voiceActive = false;
    });
  }

  // PM-32：實際啟動語音——統一走 createRecognition() 工廠（與 🔄 重啟同一條路徑）。
  // 保留 SRCtor 參數讓上游 tryStartVoice / 授權浮層的呼叫端不必更動。
  function initSpeechRecognition(_SR: SRCtor) {
    recognition = createRecognition();
    if (!recognition) {
      blog('⚠ SpeechRecognition 建立失敗（不支援）');
      voiceActive = false;
      return;
    }
    try {
      recognition.start();
      blog('SpeechRecognition started (zh-TW)');
    } catch (err) {
      blog('⚠ SpeechRecognition start 失敗', err);
      recognition = null;
      voiceActive = false;
    }
  }

  function buildPageInfo(): PageInfo {
    return {
      url: window.location.href,
      title: document.title,
      browser: navigator.userAgent,
      screenSize: `${screen.width}x${screen.height}`,
      timestamp: new Date().toISOString(),
    };
  }

  function stopRecording(): RecordingPayload {
    recording = false;
    if (stopRrweb) {
      try {
        stopRrweb();
      } catch (err) {
        blog('rrweb stop 拋錯（已忽略）', err);
      }
      stopRrweb = null;
    }
    // PM-34：停掉定時器並 flush 最後一批 rrweb 事件
    if (rrwebFlushInterval !== null) {
      clearInterval(rrwebFlushInterval);
      rrwebFlushInterval = null;
    }
    const finalBatch = events.slice(lastFlushedIndex);
    if (finalBatch.length > 0) {
      lastFlushedIndex = events.length;
      post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'FLUSH_RRWEB', events: finalBatch });
    }
    // 停止語音辨識 + 移除即時字幕
    voiceActive = false;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        /* 忽略 */
      }
      recognition = null;
    }
    hideCaptionBar();
    const payload: RecordingPayload = {
      rrwebEvents: events,
      consoleLogs,
      networkErrors,
      pageInfo: buildPageInfo(),
      voiceTranscript: voiceSegments, // 直接用 MAIN world 收到的語音
    };
    blog('STOP：打包', {
      dom: payload.rrwebEvents.length,
      console: payload.consoleLogs.length,
      network: payload.networkErrors.length,
      voice: payload.voiceTranscript.length,
    });
    return payload;
  }

  // PM-37：READY 競爭條件——inject 若比 content 早載完，單次 READY 會丟失。
  // 改為重複發 READY，收到 content 的 READY_ACK 才停。
  let readyAcked = false;

  // ── 與 content.ts（ISOLATED world）溝通 ──────────────────
  // to-inject 方向同時承載 START/STOP 指令（cmd）與 PM-36 VOICE_HISTORY / PM-37 READY_ACK（kind）
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return;
    const data = e.data as InjectCommand & { kind?: string; segments?: VoiceSegment[] };
    if (!data || data.source !== BUGEZY_SOURCE || data.dir !== 'to-inject') return;

    if (data.cmd === 'START') {
      blog('收到 START 指令', data.keyboardMode ? '(鍵盤模式)' : '');
      const rrwebOk = startRecording({ keyboardMode: data.keyboardMode === true });
      post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'STARTED', rrwebOk });
    } else if (data.cmd === 'STOP') {
      blog('收到 STOP 指令');
      const payload = stopRecording();
      post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'RESULT', payload });
    } else if (data.kind === 'VOICE_HISTORY') {
      // PM-36：收到歷史語音 → 填入右上面板（跳頁恢復時不再是空的）
      const voiceContent = document.getElementById('bugezy-voice-content');
      if (voiceContent && data.segments && data.segments.length > 0) {
        voiceContent.textContent = data.segments.map((s) => s.text).join('\n');
        const panel = document.getElementById('bugezy-voice-panel');
        if (panel) panel.scrollTop = panel.scrollHeight;
        blog('載入歷史語音', data.segments.length, '段');
      }
    } else if (data.kind === 'READY_ACK') {
      readyAcked = true; // PM-37：content 已收到 READY，可停止重複發送
      blog('收到 READY_ACK');
    }
  });

  // 載入即向 content.ts 報到。PM-37：重複發 READY 直到 ACK，避免載入順序競爭丟失。
  const readyInterval = setInterval(() => {
    if (readyAcked) {
      clearInterval(readyInterval);
      return;
    }
    post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'READY' });
  }, 100);
  setTimeout(() => clearInterval(readyInterval), 5000); // 5 秒後一定停，避免無限發送
}
