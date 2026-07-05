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
  type NetworkSnapshot,
  type PageInfo,
  type RecordingPayload,
  type VoiceSegment,
} from './types';
import { t, getUILang } from './i18n';
import { getNetworkSnapshot } from './net'; // PM-156：網路環境快照

// PM-139：inject 在 MAIN world 無 chrome.storage，語言由 content.ts 注入 DOM（data-bugezy-lang）。
// it() = 讀 DOM 語言後翻譯（每次讀，支援使用者中途切語言）。
function getBugezyUILang() {
  return getUILang(document.documentElement.getAttribute('data-bugezy-lang') || 'zh');
}
function it(key: string, params?: Record<string, string | number>): string {
  return t(key, getBugezyUILang(), params);
}

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
  onstart: (() => void) | null;
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
  let networkAtStart: NetworkSnapshot | null = null; // PM-156：錄製開始時的網路快照
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

  // ===== PM-50：背景循環緩存（⏪ 回溯最近 30 秒，不需先按錄製）=====
  const REWIND_WINDOW = 30_000;
  let bgEvents: { data: unknown; timestamp: number }[] = [];
  let bgConsoleLogs: { data: ConsoleLog; timestamp: number }[] = [];
  let bgNetworkErrors: { data: NetworkError; timestamp: number }[] = [];
  let bgStopRrweb: (() => void) | null = null;

  /** 啟動 / 重啟背景 rrweb 緩存（與「錄製用 rrweb」互斥，同頁不能同時跑兩個 record）。*/
  function startBackgroundBuffer() {
    bgEvents = [];
    bgConsoleLogs = [];
    bgNetworkErrors = [];
    try {
      const stop = record({
        emit(event) {
          const ts = (event as { timestamp?: number }).timestamp || Date.now();
          bgEvents.push({ data: event, timestamp: ts });
        },
        // PM-50：週期性 FullSnapshot，循環裁切後仍有可回放的起點（否則只剩 incremental 無法回放）
        checkoutEveryNms: REWIND_WINDOW,
      });
      bgStopRrweb = stop ?? null;
      blog('背景緩存 rrweb 已啟動');
    } catch (err) {
      blog('⚠ 背景 rrweb 啟動失敗', err);
      bgStopRrweb = null;
    }
  }

  // 每 5 秒裁掉超過視窗的舊資料（循環 buffer）
  window.setInterval(() => {
    const cutoff = Date.now() - REWIND_WINDOW;
    bgEvents = bgEvents.filter((e) => e.timestamp > cutoff);
    bgConsoleLogs = bgConsoleLogs.filter((e) => e.timestamp > cutoff);
    bgNetworkErrors = bgNetworkErrors.filter((e) => e.timestamp > cutoff);
  }, 5000);

  // inject 載入即開始背景緩存（不需等使用者按錄製）
  startBackgroundBuffer();

  // ===== PM-52：即時監控視覺回饋（頁面右下角浮動 badge + error 清單）=====
  let monitorBadge: HTMLElement | null = null;
  // PM-124：本頁最近一次「上傳監控報告」成功後的報告連結（有值 → badge/按鈕改為開報告頁）
  let latestReportUrl: string | null = null;
  // PM-69：error 清單改用 DOM 節點 + textContent 建構（見 toggleErrorPanel），
  // 不再拼 HTML 字串，故移除原 escapeHtml（textContent 本身即防注入）。

  // PM-123：即時監控浮動 icon 改為直覺文字狀態條——
  // 無錯誤：綠色靜態「🟢 BugEzy 監控中」；有錯誤：橘色脈衝「⚠️ 發現 N 個錯誤（點我查看）」，
  // 點擊展開既有的即時 error 清單面板（toggleErrorPanel）＝「查看」。
  function showMonitorBadge() {
    if (monitorBadge) return;
    // 橘色脈衝 keyframes（有錯誤時用）
    if (!document.getElementById('bugezy-badge-pulse-style')) {
      const s = document.createElement('style');
      s.id = 'bugezy-badge-pulse-style';
      s.textContent =
        '@keyframes bugezy-badge-pulse{0%,100%{box-shadow:0 2px 12px rgba(245,158,11,0.3)}50%{box-shadow:0 2px 20px rgba(245,158,11,0.7),0 0 40px rgba(245,158,11,0.3)}}';
      document.head.appendChild(s);
    }
    const badge = document.createElement('div');
    badge.id = 'bugezy-monitor-badge';
    badge.style.cssText =
      'position:fixed;bottom:20px;right:20px;z-index:2147483647;pointer-events:auto;padding:8px 16px;border-radius:20px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;font-weight:600;cursor:default;box-shadow:0 2px 12px rgba(0,0,0,0.3);transition:all 0.3s;user-select:none;background:rgba(22,163,74,0.9);color:#fff;';
    badge.textContent = it('monitor-active');
    badge.title = it('monitor-active');
    document.body.appendChild(badge);
    monitorBadge = badge;
    updateMonitorBadge(); // 立即反映目前計數（含綁定/解綁點擊）
  }

  function updateMonitorBadge() {
    if (!monitorBadge) return; // 未開監控就是 no-op（攔截時每次呼叫也便宜）
    // PM-155：良好 Web Vitals 等 info 級不算「錯誤」，不計入 badge 數字（error/warn 才算問題）
    const consoleProblems = bgConsoleLogs.filter((e) => e.data.level !== 'info').length;
    const total = consoleProblems + bgNetworkErrors.length;
    if (total === 0) {
      monitorBadge.style.background = 'rgba(22,163,74,0.9)';
      monitorBadge.style.color = '#fff';
      monitorBadge.style.cursor = 'default';
      monitorBadge.style.animation = 'none';
      monitorBadge.textContent = it('monitor-active');
      monitorBadge.title = it('monitor-active');
      monitorBadge.onclick = null;
    } else {
      monitorBadge.style.background = 'rgba(245,158,11,0.95)';
      monitorBadge.style.color = '#000';
      monitorBadge.style.cursor = 'pointer';
      monitorBadge.style.animation = 'bugezy-badge-pulse 1.5s ease-in-out infinite';
      monitorBadge.textContent = it('monitor-errors', { n: total });
      monitorBadge.title = it('monitor-errors-title', { n: total });
      // PM-124：已上傳過報告 → 點 badge 直接開報告頁；否則展開 error 面板
      monitorBadge.onclick = () => {
        if (latestReportUrl) window.open(latestReportUrl, '_blank');
        else toggleErrorPanel();
      };
    }
  }

  function hideMonitorBadge() {
    monitorBadge?.remove();
    monitorBadge = null;
    document.getElementById('bugezy-error-panel')?.remove();
  }

  // PM-124：接收 content 轉回的監控報告上傳結果 → 更新按鈕 + 記住報告連結
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return;
    const d = e.data as InjectMessage;
    if (!d || d.source !== BUGEZY_SOURCE || d.dir !== 'to-inject' || d.kind !== 'MONITOR_UPLOADED') {
      return;
    }
    const btn = document.getElementById('bugezy-monitor-upload') as HTMLButtonElement | null;
    if (d.reportUrl) {
      latestReportUrl = d.reportUrl;
      updateMonitorBadge(); // badge 點擊改為開報告頁
      if (btn) {
        btn.textContent = it('monitor-uploaded');
        btn.style.background = '#238636';
        btn.disabled = false; // 再點由既有 handler 依 latestReportUrl 開報告頁
      }
    } else if (btn) {
      btn.textContent = it('monitor-upload-fail');
      btn.style.background = '#f85149';
      btn.disabled = false; // 再點由既有 handler（latestReportUrl 仍 null）重新上傳
    }
  });

  /** 點 badge 展開 / 收合即時 error 清單 */
  function toggleErrorPanel() {
    const existing = document.getElementById('bugezy-error-panel');
    if (existing) {
      existing.remove();
      return;
    }
    const panel = document.createElement('div');
    panel.id = 'bugezy-error-panel';
    panel.style.cssText =
      'position:fixed;bottom:80px;right:20px;z-index:2147483647;width:360px;max-height:400px;overflow-y:auto;background:#1a1a2e;border:1px solid #2a2a3e;border-radius:12px;padding:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);font-family:system-ui,sans-serif;font-size:13px;color:#eee;pointer-events:auto;';

    // PM-69：改用 DOM 節點建構（textContent 天生防注入），不再拼 innerHTML 字串，
    // 避免在啟用 Trusted Types 的 CSP 網站（如 GitHub）assign innerHTML 直接拋錯。
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:8px;color:#a78bfa;';
    title.textContent = it('monitor-panel-title');
    panel.appendChild(title);

    /** 一列錯誤：彩色標記 span + 內容 span（內容走 textContent 自動轉義） */
    function appendRow(markText: string, markColor: string, body: string) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:4px 0;border-bottom:1px solid #2a2a3e;';
      const mark = document.createElement('span');
      mark.style.cssText = `color:${markColor};font-weight:600;`;
      mark.textContent = markText;
      const text = document.createElement('span');
      text.style.cssText = 'color:#ccc;margin-left:4px;';
      text.textContent = body;
      row.appendChild(mark);
      row.appendChild(text);
      panel.appendChild(row);
    }

    const cLogs = bgConsoleLogs.map((e) => e.data);
    cLogs.forEach((log) => {
      // PM-155：依 source 分圖示——resource 🖼️、web-vitals ⚡；否則依 level（error ❌ / warn ⚠）
      let mark = '⚠';
      let color = '#f59e0b'; // warn 橘
      if (log.source === 'resource-error') {
        mark = '🖼️';
      } else if (log.source === 'web-vitals') {
        mark = '⚡';
        if (log.level === 'info') color = '#3fb950'; // 良好 → 綠
      } else if (log.level === 'error') {
        mark = '❌';
        color = '#ef4444'; // error 紅
      }
      appendRow(mark, color, log.message.slice(0, 120));
    });
    const nErrs = bgNetworkErrors.map((e) => e.data);
    nErrs.forEach((err) => {
      appendRow(`🌐 ${err.status}`, '#3b82f6', `${err.method} ${err.url.slice(0, 80)}`);
    });
    if (!cLogs.length && !nErrs.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#888;text-align:center;padding:12px;';
      empty.textContent = it('monitor-empty');
      panel.appendChild(empty);
    }

    // PM-124：panel 底部「上傳報告讓 AI 分析」——打包當前 buffer 的 errors 上傳，產生報告連結
    if (cLogs.length || nErrs.length) {
      const uploadBtn = document.createElement('button');
      uploadBtn.id = 'bugezy-monitor-upload';
      uploadBtn.textContent = latestReportUrl ? it('monitor-uploaded') : it('monitor-upload');
      uploadBtn.style.cssText =
        'pointer-events:auto;display:block;width:100%;margin-top:8px;background:' +
        (latestReportUrl ? '#238636' : '#7c3aed') +
        ';color:#fff;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:600;cursor:pointer;';
      uploadBtn.addEventListener('click', () => {
        if (latestReportUrl) {
          window.open(latestReportUrl, '_blank');
          return;
        }
        uploadBtn.disabled = true;
        uploadBtn.textContent = it('monitor-uploading');
        const total = bgConsoleLogs.length + bgNetworkErrors.length;
        // description 非 RecordingPayload 型別欄位（server 端選讀）→ 交集型別帶入
        const payload: RecordingPayload & { description: string } = {
          rrwebEvents: [],
          consoleLogs: bgConsoleLogs.map((e) => e.data),
          networkErrors: bgNetworkErrors.map((e) => e.data),
          voiceTranscript: [],
          pageInfo: buildPageInfo(),
          description: it('monitor-desc', { n: total }),
          markers: [],
          networkSnapshot: { atStart: getNetworkSnapshot() }, // PM-156：即時監控上傳也帶網路快照
        };
        // inject 在 MAIN world 無 chrome.runtime → 走 window.postMessage → content → background 通訊鏈
        post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'UPLOAD_MONITOR', payload });
      });
      panel.appendChild(uploadBtn);
    }
    document.body.appendChild(panel);
  }

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
    textSpan.textContent = it('caption-recording'); // PM-70：啟動後 onstart 會切到 🟢 聽取中

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
    // PM-69：用 DOM 節點建構，避免 innerHTML 在 Trusted-Types CSP 網站（如 GitHub）拋錯
    const headerLabel = document.createElement('span');
    headerLabel.style.cssText = 'font-size:12px;color:#a78bfa;';
    headerLabel.textContent = it('caption-voice-log');
    header.appendChild(headerLabel);

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
    bar.textContent = it('keyboard-bar');
    document.body.appendChild(bar);
    captionBar = bar;
  }

  /** PM-91/97：付費 Whisper 模式的「錄音中」反饋 bar。
   *  PM-97：靜態脈衝紅點改為 5 條即時音量條（安靜=矮紅、講話=綠色跳動），
   *  音量由 offscreen → background → content 以 `bugezy-mic-volume` CustomEvent 送進來。
   *  text span 用 id `bugezy-caption-text`，停止時 content 收 WHISPER_TRANSCRIBING 可改字。 */
  function showWhisperCaptionBar() {
    document.getElementById('bugezy-live-caption')?.remove();
    const bar = document.createElement('div');
    bar.id = 'bugezy-live-caption';
    bar.style.cssText =
      'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:rgba(0,0,0,0.85);color:#fff;padding:12px 28px;border-radius:12px;font-size:18px;font-family:system-ui,sans-serif;display:flex;align-items:center;gap:10px;';

    // PM-97：5 條音量條（取代原本 bugezy-pulse 靜態紅點）
    const bars = document.createElement('span');
    bars.id = 'bugezy-volume-bars';
    bars.style.cssText = 'display:flex;align-items:flex-end;gap:2px;height:20px;flex-shrink:0;';
    for (let i = 0; i < 5; i++) {
      const b = document.createElement('span');
      b.className = 'bugezy-vol-bar';
      b.style.cssText =
        'width:4px;background:#ef4444;border-radius:2px;transition:height 0.15s ease;height:4px;';
      bars.appendChild(b);
    }
    bar.appendChild(bars);

    const text = document.createElement('span');
    text.id = 'bugezy-caption-text';
    text.textContent = it('whisper-bar');
    bar.appendChild(text);
    document.body.appendChild(bar);
    captionBar = bar;
  }

  // PM-97：接 content relay 的即時音量，更新 5 條音量條高度 + 顏色（安靜矮紅、講話綠色跳動）。
  // 只註冊一次；bar 不存在時 querySelectorAll 回空、無副作用。
  window.addEventListener('bugezy-mic-volume', ((e: Event) => {
    const level = (e as CustomEvent).detail?.level ?? 0;
    document.querySelectorAll('.bugezy-vol-bar').forEach((b, i) => {
      const threshold = (i + 1) / 5;
      const h = level >= threshold ? 4 + 16 * level + Math.random() * 4 : 4;
      (b as HTMLElement).style.height = `${Math.min(h, 20)}px`;
      (b as HTMLElement).style.background = level > 0.3 ? '#3fb950' : '#ef4444';
    });
  }) as EventListener);

  /** PM-30：更新字幕文字只動 textSpan，保留 🔄 按鈕不被清掉 */
  function setCaptionText(text: string) {
    const el = document.getElementById('bugezy-caption-text');
    if (el) el.textContent = text;
  }

  // PM-70：統一語音狀態指示器（顯示在底部字幕區）。🟢 聽取中 / 🟡 重啟中 / 🔴 已停止
  type VoiceStatus = 'listening' | 'restarting' | 'stopped';
  function setVoiceStatus(state: VoiceStatus, note?: string) {
    const base =
      state === 'listening' ? '🟢 聽取中…' : state === 'restarting' ? '🟡 重啟中…' : '🔴 已停止';
    setCaptionText(note ? `${base} — ${note}` : base);
  }

  // PM-33：自動重啟連續失敗計數（放在 createRecognition 外，建新實例不重置）
  let autoRestartFails = 0;

  // PM-137：Web Speech 語言（BCP-47）。inject 在 MAIN world 無 chrome.storage，由 START 指令帶入。
  let currentSpeechLang = 'zh-TW';

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
    rec.lang = currentSpeechLang; // PM-137：使用者選的語言（預設 zh-TW）
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
              if (voiceActive) setVoiceStatus('listening');
            }, 1500);
          }
        }
      }
    };

    // PM-70：實際啟動成功才把狀態切到「聽取中」並重置失敗計數
    // （比在 start() 後立即歸零更準——start() 不拋例外不代表真的開始接收）。
    rec.onstart = () => {
      if (voiceActive) {
        autoRestartFails = 0;
        setVoiceStatus('listening');
      }
    };

    rec.onend = () => {
      // 靜默自停 → 仍在錄製就自動重啟；連續失敗 3 次就停手，等使用者按 🔄
      if (!voiceActive) return;
      blog('SpeechRecognition onend → auto restart');
      setVoiceStatus('restarting');
      try {
        rec.start();
        // 不在這裡歸零 autoRestartFails——交給 onstart（確認真的啟動）才歸零
      } catch {
        autoRestartFails++;
        blog(`auto restart 失敗 (第 ${autoRestartFails} 次)`);
        if (autoRestartFails >= 3) {
          setVoiceStatus('stopped', '按 🔄 重啟');
          blog('auto restart 連續失敗 3 次，等待手動重啟');
        }
      }
    };

    // PM-70：依錯誤類型分流處理（no-speech 正常續跑 / audio-capture / 權限 / 其他）
    rec.onerror = (e: SRErrorEvent) => {
      const err = e.error;
      blog('SpeechRecognition error:', err, e.message || '');
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        // 權限被拒 → 停止自動重啟，提示使用者
        voiceActive = false;
        setVoiceStatus('stopped', '麥克風被拒絕');
      } else if (err === 'audio-capture') {
        // 麥克風裝置問題（被佔用/拔除）→ 提示，但不關 voiceActive，
        // 交給 onend 自動重啟 + 失敗計數收斂
        setVoiceStatus('stopped', '麥克風無法擷取，請檢查裝置');
      } else if (err === 'no-speech') {
        // 正常：靜默太久觸發，onend 會自動重啟，不更動狀態
        blog('no-speech（正常），等 onend 自動重啟');
      } else if (err === 'aborted') {
        // 多半是自己 stop() 觸發，忽略
      } else {
        // 其他未分類錯誤：不關 voiceActive，交給 onend 嘗試重啟
        blog(`未分類語音錯誤 (${err})，交給 onend 重啟`);
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

    setVoiceStatus('restarting');

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
      setVoiceStatus('stopped', '麥克風無法存取');
      return;
    }

    // Step 3：等 500ms 讓 Chrome 清理舊的音訊資源
    await new Promise((r) => setTimeout(r, 500));

    // Step 4：建全新實例（全新 handlers）
    recognition = createRecognition();
    if (recognition) {
      try {
        recognition.start();
        autoRestartFails = 0; // 手動重啟 → 重置自動重啟失敗計數（onstart 也會再歸零）
        setVoiceStatus('listening'); // onstart 確認後也會再設一次
        blog('語音強制重啟成功');
      } catch (err) {
        blog('語音強制重啟失敗', err);
        setVoiceStatus('stopped', '重啟失敗，請重新整理頁面');
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

  // ── A. Console 攔截（只抓 warn + error）+ 全域錯誤兜底（PM-154）──────────
  // PM-50：永遠存背景 buffer（回溯用）；recording 時也存錄製 buffer + flush。
  // PM-154：統一收集入口 + 去重——console.error / window.onerror / unhandledrejection
  //         可能對同一錯誤重複觸發，去重避免報告塞滿重複列。
  const recentErrors = new Set<string>();
  function collectConsoleLog(entry: ConsoleLog): void {
    // 去重 key = level + 訊息前 100 字；5 秒後清除（允許相同錯誤日後再記）
    const key = `${entry.level}:${entry.message.slice(0, 100)}`;
    if (recentErrors.has(key)) return;
    recentErrors.add(key);
    setTimeout(() => recentErrors.delete(key), 5000);
    bgConsoleLogs.push({ data: entry, timestamp: entry.timestamp });
    updateMonitorBadge(); // PM-52
    if (recording) {
      consoleLogs.push(entry);
      post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'FLUSH_CONSOLE', log: entry }); // PM-34
    }
  }

  // PM-155：核心 Web Vitals（LCP/CLS/FID）收集。超標→warn，良好→info；皆走 collectConsoleLog（去重）。
  function collectWebVitals(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    const THRESHOLDS: Record<string, [number, string]> = {
      LCP: [2500, '慢（超過 2.5 秒）'],
      CLS: [0.1, '版面位移過大'],
      FID: [100, '互動延遲過高'],
    };
    const reportVital = (name: string, value: number, unit: string) => {
      const [threshold, desc] = THRESHOLDS[name] || [Infinity, ''];
      const bad = value > threshold;
      collectConsoleLog({
        level: bad ? 'warn' : 'info',
        message: `Web Vital ${name}: ${value}${unit} ${bad ? '⚠️ ' + desc : '✅ 良好'}`,
        timestamp: Date.now(),
        source: 'web-vitals',
      });
    };
    let lcp = 0;
    let cls = 0;
    const observe = (type: string, cb: (list: PerformanceObserverEntryList) => void) => {
      try {
        new PerformanceObserver(cb).observe({ type, buffered: true } as PerformanceObserverInit);
      } catch {
        /* 該瀏覽器不支援此 entry type → 靜默略過 */
      }
    };
    observe('largest-contentful-paint', (list) => {
      const es = list.getEntries();
      const last = es[es.length - 1] as (PerformanceEntry & { startTime: number }) | undefined;
      if (last) lcp = Math.round(last.startTime);
    });
    observe('layout-shift', (list) => {
      for (const e of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput?: boolean;
      })[]) {
        if (!e.hadRecentInput) cls += e.value;
      }
    });
    observe('first-input', (list) => {
      const e = list.getEntries()[0] as
        | (PerformanceEntry & { processingStart: number; startTime: number })
        | undefined;
      if (e) reportVital('FID', Math.round(e.processingStart - e.startTime), 'ms'); // 首次輸入即定案
    });
    // LCP/CLS 值會持續變動 → 頁面隱藏或載入 5 秒後「定案」回報一次（先到先報，只報一次）
    let finalized = false;
    const finalizeVitals = () => {
      if (finalized) return;
      finalized = true;
      if (lcp) reportVital('LCP', lcp, 'ms');
      reportVital('CLS', Math.round(cls * 1000) / 1000, '');
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') finalizeVitals();
    });
    setTimeout(finalizeVitals, 5000);
  }

  console.warn = (...args: unknown[]) => {
    collectConsoleLog({ level: 'warn', message: stringifyArgs(args), timestamp: Date.now() });
    return originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    collectConsoleLog({ level: 'error', message: stringifyArgs(args), timestamp: Date.now() });
    return originalError(...args);
  };

  // PM-154 #8：未捕捉的 Promise rejection（async/await 忘了 catch → console 什麼都沒有）
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? `Unhandled Promise Rejection: ${reason.message}${reason.stack ? '\n' + reason.stack : ''}`
        : `Unhandled Promise Rejection: ${stringifyArgs([reason])}`;
    collectConsoleLog({ level: 'error', message, timestamp: Date.now(), source: 'unhandledrejection' });
  });

  // PM-154 #6：框架吞掉的 JS 執行錯誤（React Error Boundary / Vue errorHandler 攔下不進 console）。
  // 只抓 JS 錯誤（target = window/document）；資源載入失敗（img/script/link，capture phase）留給 PM-155。
  window.addEventListener(
    'error',
    (event: ErrorEvent) => {
      if (event.target !== window && event.target !== document) return; // 資源載入錯誤 → 不在此處理
      const loc = `${event.filename || 'unknown'}:${event.lineno || 0}:${event.colno || 0}`;
      const message = `${event.message || 'Script Error'} at ${loc}`;
      collectConsoleLog({ level: 'error', message, timestamp: Date.now(), source: 'window.onerror' });
    },
    false, // bubbling phase：只收 JS 執行錯誤，不收不冒泡的資源載入錯誤
  );

  // PM-155 #9：資源載入失敗（img/script/link/video 的 404 / CORS 被擋 → 頁面破版但 console 無明顯 error）。
  // 資源錯誤事件不冒泡 → 必須 capture phase（true）才收得到；target 是元素（非 window/document）。
  window.addEventListener(
    'error',
    (event: Event) => {
      const target = event.target as (HTMLElement & { src?: string; href?: string }) | null;
      // 非元素（window/document 的 JS 執行錯誤）→ PM-154 bubbling 已處理，這裡只收資源元素
      if (!target || !(target instanceof HTMLElement)) return;
      const src = target.src || target.href || '';
      if (!src) return; // 非資源元素（無 src/href）→ 略過
      const tag = target.tagName ? target.tagName.toLowerCase() : 'unknown';
      collectConsoleLog({
        level: 'warn',
        message: `Resource load failed: <${tag}> ${src}`,
        timestamp: Date.now(),
        source: 'resource-error',
      });
    },
    true, // capture phase：資源載入錯誤不冒泡，必須 capture
  );

  // PM-155 #10：核心 Web Vitals（LCP/CLS/FID）——超標 warn、良好 info，皆透過 collectConsoleLog（去重）。
  // LCP/CLS 值會隨頁面變動 → 在頁面隱藏或載入 5 秒後「定案」回報一次（避免每次 observer 觸發都塞一列）。
  collectWebVitals();

  // ── B. Network 攔截 — fetch（只抓 4xx / 5xx）─────────────
  // PM-50：永遠存背景 buffer；recording 時也存錄製 buffer + flush。
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const start = Date.now();
    const [input, init] = args;
    const response = await originalFetch(...args);
    try {
      if (response.status >= 400) {
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
        bgNetworkErrors.push({ data: entry, timestamp: entry.timestamp });
        updateMonitorBadge(); // PM-52
        if (recording) {
          networkErrors.push(entry);
          post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'FLUSH_NETWORK', error: entry }); // PM-34
        }
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
        if (this.status >= 400) {
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
          bgNetworkErrors.push({ data: entry, timestamp: entry.timestamp }); // PM-50：永遠存背景 buffer
          updateMonitorBadge(); // PM-52
          if (recording) {
            networkErrors.push(entry);
            post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'FLUSH_NETWORK', error: entry }); // PM-34
          }
        }
      });
    }
    return originalSend.call(this, body ?? null);
  };

  // ── 控制：開始 / 停止 ─────────────────────────────────────
  function startRecording(options?: {
    keyboardMode?: boolean;
    micEnabled?: boolean;
    whisperMode?: boolean;
    speechLang?: string;
  }): boolean {
    if (recording) {
      blog('START 重複呼叫，已在錄製中');
      return stopRrweb !== null;
    }
    // PM-137：記住本次錄製的語音語言（createRecognition 讀取）
    currentSpeechLang = options?.speechLang || 'zh-TW';
    // PM-50：停掉背景 rrweb（同頁不能同時跑兩個 record），切換到錄製用 rrweb
    if (bgStopRrweb) {
      try {
        bgStopRrweb();
      } catch (err) {
        blog('停止背景 rrweb 拋錯（已忽略）', err);
      }
      bgStopRrweb = null;
      blog('已停止背景 rrweb（切換到錄製模式）');
    }

    recording = true;
    networkAtStart = getNetworkSnapshot(); // PM-156：錄製開始時的網路環境
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
    } else if (options?.whisperMode) {
      // PM-91：付費 Whisper 模式 — 顯示「錄音中」bar（不啟 SpeechRecognition；offscreen 負責錄音、停止後轉錄）
      blog('Whisper 模式：顯示錄音中 bar，不啟頁面語音');
      voiceActive = false;
      showWhisperCaptionBar();
    } else if (options?.micEnabled === false) {
      // PM-87/90：麥克風關閉 → 不啟動頁面 SpeechRecognition、不彈授權橫幅、不顯字幕
      blog('麥克風已關閉，跳過頁面語音');
      voiceActive = false;
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

    // PM-95：改成全頁半透明遮罩 + 居中卡片（原本是頂部橫條，跟網頁融在一起看不到）
    const overlay = document.createElement('div');
    overlay.id = 'bugezy-mic-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      z-index: 2147483647;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    `;

    const card = document.createElement('div');
    card.style.cssText = `
      background: #1a1a2e;
      border: 1px solid #7c3aed;
      border-radius: 16px;
      padding: 32px 40px;
      max-width: 380px;
      text-align: center;
      box-shadow: 0 8px 32px rgba(124, 58, 237, 0.3);
    `;

    const icon = document.createElement('div');
    icon.textContent = '🎙️';
    icon.style.cssText = 'font-size: 48px; line-height: 1;';

    const title = document.createElement('h3');
    title.textContent = it('mic-perm-title');
    title.style.cssText = `
      color: #fff;
      font-size: 18px;
      font-weight: 600;
      margin: 16px 0 8px;
    `;

    const desc = document.createElement('p');
    desc.textContent = it('mic-perm-desc');
    desc.style.cssText = `
      color: #aaa;
      font-size: 14px;
      line-height: 1.5;
      margin: 0 0 24px;
    `;

    const allowBtn = document.createElement('button');
    allowBtn.textContent = it('mic-perm-allow');
    allowBtn.style.cssText = `
      display: block;
      width: 100%;
      background: #7c3aed;
      color: #fff;
      border: none;
      border-radius: 10px;
      padding: 12px 32px;
      font-size: 16px;
      cursor: pointer;
      font-weight: 600;
    `;

    const skipBtn = document.createElement('button');
    skipBtn.textContent = it('mic-perm-skip');
    skipBtn.style.cssText = `
      display: block;
      width: 100%;
      background: transparent;
      color: #aaa;
      border: none;
      padding: 12px 0 0;
      font-size: 13px;
      cursor: pointer;
    `;

    card.appendChild(icon);
    card.appendChild(title);
    card.appendChild(desc);
    card.appendChild(allowBtn);
    card.appendChild(skipBtn);
    overlay.appendChild(card);
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
      // PM-156：錄製開始/結束各一份網路快照（AI 可看到「開始 4G、結束離線」）
      networkSnapshot: { atStart: networkAtStart ?? getNetworkSnapshot(), atEnd: getNetworkSnapshot() },
    };
    blog('STOP：打包', {
      dom: payload.rrwebEvents.length,
      console: payload.consoleLogs.length,
      network: payload.networkErrors.length,
      voice: payload.voiceTranscript.length,
    });
    // PM-50：錄製結束後重啟背景緩存（回到「隨時可回溯」狀態）
    startBackgroundBuffer();
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
      blog(
        '收到 START 指令',
        data.keyboardMode ? '(鍵盤模式)' : '',
        `micEnabled=${data.micEnabled === true} whisperMode=${data.whisperMode === true}`,
      );
      const rrwebOk = startRecording({
        keyboardMode: data.keyboardMode === true,
        micEnabled: data.micEnabled,
        whisperMode: data.whisperMode === true,
        speechLang: data.speechLang, // PM-137：使用者選的語音語言
      });
      post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'STARTED', rrwebOk });
    } else if (data.cmd === 'STOP') {
      blog('收到 STOP 指令');
      const payload = stopRecording();
      post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'RESULT', payload });
    } else if (data.cmd === 'REWIND') {
      // PM-50：打包背景緩存（最近 30 秒），不影響背景緩存持續運作
      blog('收到 REWIND 指令，打包最近 30 秒');
      const payload: RecordingPayload = {
        rrwebEvents: bgEvents.map((e) => e.data),
        consoleLogs: bgConsoleLogs.map((e) => e.data),
        networkErrors: bgNetworkErrors.map((e) => e.data),
        pageInfo: buildPageInfo(),
        voiceTranscript: [], // 回溯沒有語音
        networkSnapshot: { atStart: getNetworkSnapshot() }, // PM-156：回溯只有一個時間點
      };
      blog('REWIND 打包', {
        dom: payload.rrwebEvents.length,
        console: payload.consoleLogs.length,
        network: payload.networkErrors.length,
      });
      post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'REWIND_RESULT', payload });
    } else if (data.cmd === 'GET_LIVE_ERRORS') {
      // PM-51：回傳背景 buffer 的即時 console/network errors（即時監控用，不打包報告）
      post({
        source: BUGEZY_SOURCE,
        dir: 'to-content',
        kind: 'LIVE_ERRORS_RESULT',
        consoleLogs: bgConsoleLogs.map((e) => e.data),
        networkErrors: bgNetworkErrors.map((e) => e.data),
      });
    } else if (data.cmd === 'SHOW_MONITOR') {
      showMonitorBadge(); // PM-52：開即時監控 → 顯示頁面浮動 badge
    } else if (data.cmd === 'HIDE_MONITOR') {
      hideMonitorBadge();
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
