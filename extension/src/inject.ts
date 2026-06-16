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
  // 語音辨識（PM-08：直接跑在 MAIN world，麥克風授權歸屬網站）
  let voiceSegments: VoiceSegment[] = [];
  let recognition: SRInstance | null = null;
  let voiceActive = false;

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
      consoleLogs.push({ level: 'warn', message: stringifyArgs(args), timestamp: Date.now() });
    }
    return originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    if (recording) {
      consoleLogs.push({ level: 'error', message: stringifyArgs(args), timestamp: Date.now() });
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
        networkErrors.push({
          method: (init?.method || (input as Request).method || 'GET').toUpperCase(),
          url,
          status: response.status,
          responseBody: body.slice(0, 2000),
          timestamp: start,
          duration: Date.now() - start,
        });
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
          networkErrors.push({
            method: meta.method,
            url: meta.url,
            status: this.status,
            requestBody: meta.body,
            responseBody:
              typeof this.responseText === 'string' ? this.responseText.slice(0, 2000) : undefined,
            timestamp: meta.start,
            duration: Date.now() - meta.start,
          });
        }
      });
    }
    return originalSend.call(this, body ?? null);
  };

  // ── 控制：開始 / 停止 ─────────────────────────────────────
  function startRecording(): boolean {
    if (recording) {
      blog('START 重複呼叫，已在錄製中');
      return stopRrweb !== null;
    }
    recording = true;
    events = [];
    consoleLogs = [];
    networkErrors = [];
    let rrwebOk = false;
    try {
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

    // ── D. 語音辨識（需 user gesture 授權麥克風）──────────
    voiceSegments = [];
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

    blog('START：開始錄製');
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

  function initSpeechRecognition(SR: SRCtor) {
    try {
      const rec = new SR();
      rec.lang = 'zh-TW';
      rec.continuous = true;
      rec.interimResults = false;

      rec.onresult = (e: SREvent) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          if (!result.isFinal) continue;
          const text = result[0].transcript.trim();
          if (text) {
            voiceSegments.push({ text, timestamp: Date.now(), isFinal: true });
            blog('voice segment:', text.slice(0, 40));
          }
        }
      };

      rec.onend = () => {
        // Web Speech API 靜默幾秒會自動停，仍在錄製中就重啟以持續收音
        if (voiceActive) {
          blog('SpeechRecognition onend → auto restart');
          try {
            rec.start();
          } catch {
            /* 忽略 */
          }
        }
      };

      rec.onerror = (e: SRErrorEvent) => {
        blog('SpeechRecognition error:', e.error, e.message || '');
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          voiceActive = false;
          recognition = null;
          blog('麥克風被拒絕，語音停用');
        }
      };

      recognition = rec;
      rec.start();
      blog('SpeechRecognition started (zh-TW)');
    } catch (err) {
      blog('⚠ SpeechRecognition 建立失敗', err);
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
    // 停止語音辨識
    voiceActive = false;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        /* 忽略 */
      }
      recognition = null;
    }
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

  // ── 與 content.ts（ISOLATED world）溝通 ──────────────────
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return;
    const data = e.data as InjectCommand;
    if (!data || data.source !== BUGEZY_SOURCE || data.dir !== 'to-inject') return;

    if (data.cmd === 'START') {
      blog('收到 START 指令');
      const rrwebOk = startRecording();
      post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'STARTED', rrwebOk });
    } else if (data.cmd === 'STOP') {
      blog('收到 STOP 指令');
      const payload = stopRecording();
      post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'RESULT', payload });
    }
  });

  // 載入即向 content.ts 報到，content 可據此確認 inject 是否存活
  post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'READY' });
}
