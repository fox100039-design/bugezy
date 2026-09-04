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
import { toSimplified } from './t2s'; // PM-243：zh-CN 語音轉錄繁轉簡
import { getNetworkSnapshot } from './net'; // PM-156：網路環境快照
import { getStorageSnapshot } from './storage'; // PM-157：儲存空間快照（本機遮罩）

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
  // PM-369：targetOrigin 由 '*' 收緊為 '/'（僅同源）——同頁通訊不需要對任何 origin 開放。
  window.postMessage(msg, '/');
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
  // PM-237 Bug2：語音面板拖曳後的位置記憶（頁面存活期間跨錄製保留；用 left/top）
  let voicePanelPos: { left: number; top: number } | null = null;

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
/**
 * PM-430：大黃蜂色票（DESIGN_SPEC §2.1）。
 *
 * inject.ts 是獨立的 bundle（MAIN world），不能共用 content.ts 那份 HZ，所以各自帶一份。
 * 這裡的 UI 全是 `createElement` + `style.cssText`，沒有 stylesheet 可以放 CSS 變數。
 *
 * ⚠ §2.2 **比例反轉**：底下是別人的網站，注入 UI 一律黑殼 + 黃強調。
 */
const HZ = {
  y: '#F7BE00',
  yDeep: '#DFA800',
  yPale: '#FFE9AE',
  ink: '#14110B',
  ink2: '#211C13',
  ink3: '#0E0C08',
  brown: '#7A4E1D',
  brownD: '#4A2F12',
  line: '#3A3122',
  line2: '#55492F',
  err: '#8A2A0F',
  errFg: '#E08B72',
  /** §2.4 深底上的次要文字**只有這兩階** */
  onDark: '#A08B62',
  onDark2: '#C9A15A',
  hex: 'polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)',
  fontUi: '"Noto Sans TC",system-ui,-apple-system,"Segoe UI","Microsoft JhengHei",sans-serif',
  fontMono: '"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
} as const;

/** 建一個純幾何的六角（§6 所有項目符號一律小六角）。 */
function hzHex(size = 9, color: string = HZ.y, pulse = false): HTMLElement {
  const el = document.createElement('span');
  el.style.cssText =
    `width:${size}px;height:${Math.round(size * 1.11)}px;flex-shrink:0;background:${color};` +
    `clip-path:${HZ.hex};` +
    (pulse ? 'animation:bugezy-hz-pulse 1.2s ease-in-out infinite;' : '');
  return el;
}

/** §8 pulse / glow：注入 UI 用得到的兩個 keyframes（只注入一次）。 */
function ensureHzKeyframes(): void {
  if (document.getElementById('bugezy-hz-anim')) return;
  const st = document.createElement('style');
  st.id = 'bugezy-hz-anim';
  st.textContent =
    '@keyframes bugezy-hz-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.86)}}' +
    `@keyframes bugezy-hz-glow{0%,100%{box-shadow:0 2px 12px rgba(247,190,0,.35)}` +
    `50%{box-shadow:0 2px 22px rgba(247,190,0,.85),0 0 40px rgba(247,190,0,.35)}}` +
    '@keyframes bugezy-hz-bar{0%,100%{height:20%}50%{height:100%}}';
  document.head.appendChild(st);
}

  function showMonitorBadge() {
    if (monitorBadge) return;
    ensureHzKeyframes();
    const badge = document.createElement('div');
    badge.id = 'bugezy-monitor-badge';
    // §7.6：無錯誤 = 咖啡底 + 米白字（系統在待命）；有錯誤 = 黃底黑字 + glow（要你做決定）
    badge.style.cssText =
      `position:fixed;bottom:20px;right:20px;z-index:2147483647;pointer-events:auto;` +
      `display:flex;align-items:center;gap:8px;padding:9px 16px;border-radius:999px;` +
      `font:700 13px/1 ${HZ.fontUi};cursor:default;box-shadow:0 2px 12px rgba(0,0,0,0.3);` +
      `transition:background .3s,color .3s;user-select:none;background:${HZ.brown};color:${HZ.yPale};`;
    // 🔴 六角是文字的兄弟節點 —— updateMonitorBadge 會覆寫文字，放進去會被洗掉。
    const badgeHex = hzHex(9, HZ.y);
    const badgeTxt = document.createElement('span');
    badgeTxt.id = 'bugezy-monitor-badge-text';
    badgeTxt.textContent = it('monitor-active');
    badge.append(badgeHex, badgeTxt);
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
    // PM-430：只換內層 span 的文字（六角是兄弟節點，textContent 會把它洗掉）
    const bText = document.getElementById('bugezy-monitor-badge-text');
    const bHex = monitorBadge.firstElementChild as HTMLElement | null;
    if (total === 0) {
      monitorBadge.style.background = HZ.brown;
      monitorBadge.style.color = HZ.yPale;
      monitorBadge.style.cursor = 'default';
      monitorBadge.style.animation = 'none';
      if (bHex) bHex.style.background = HZ.y;
      if (bText) bText.textContent = it('monitor-active');
      monitorBadge.title = it('monitor-active');
      monitorBadge.onclick = null;
    } else {
      monitorBadge.style.background = HZ.y;
      monitorBadge.style.color = HZ.ink;
      monitorBadge.style.cursor = 'pointer';
      monitorBadge.style.animation = 'bugezy-hz-glow 1.6s ease-in-out infinite'; // §8 glow
      if (bHex) bHex.style.background = HZ.ink; // 黃底上的六角要反色才看得見
      if (bText) bText.textContent = it('monitor-errors', { n: total });
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
        // PM-430：上傳成功 → 退成描邊次要按鈕（事情做完了，不該再搶注意力）
        btn.style.background = 'transparent';
        btn.style.border = `1px solid ${HZ.line2}`;
        btn.style.color = HZ.onDark2;
        btn.disabled = false; // 再點由既有 handler 依 latestReportUrl 開報告頁
      }
    } else if (btn) {
      btn.textContent = it('monitor-upload-fail');
      // 失敗 → §2.1 磚紅
      btn.style.background = HZ.err;
      btn.style.border = 'none';
      btn.style.color = HZ.yPale;
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
      `position:fixed;bottom:80px;right:20px;z-index:2147483647;width:384px;max-height:400px;` +
      `overflow-y:auto;background:${HZ.ink};border:2px solid ${HZ.brown};border-radius:12px;padding:13px;` +
      `box-shadow:0 8px 32px rgba(0,0,0,0.4);font:13px/1.5 ${HZ.fontUi};color:${HZ.yPale};pointer-events:auto;`;

    // PM-69：改用 DOM 節點建構（textContent 天生防注入），不再拼 innerHTML 字串，
    // 避免在啟用 Trusted Types 的 CSP 網站（如 GitHub）assign innerHTML 直接拋錯。
    const title = document.createElement('div');
    title.style.cssText = `display:flex;align-items:center;gap:8px;margin-bottom:10px;font:700 12.5px/1 ${HZ.fontUi};color:${HZ.y};`;
    const titleTxt = document.createElement('span');
    titleTxt.textContent = it('monitor-panel-title');
    title.append(hzHex(9, HZ.y), titleTxt);
    panel.appendChild(title);

    /** 一列錯誤：彩色標記 span + 內容 span（內容走 textContent 自動轉義） */
    // §7.7：每列左側 3px 色條（ERR/5xx 磚紅、WRN 金黃），訊息本文一律米白等寬字。
    //   標籤是文字（ERR / WRN / RES / VITAL / NET），**不靠顏色傳達內容**。
    function appendRow(markText: string, markColor: string, body: string) {
      const row = document.createElement('div');
      row.style.cssText =
        `display:flex;gap:8px;align-items:baseline;margin:6px 0;padding:7px 9px;` +
        `background:${HZ.ink2};border-radius:8px;border-left:3px solid ${markColor};`;
      const mark = document.createElement('span');
      mark.style.cssText = `flex-shrink:0;font:700 10.5px/1.5 ${HZ.fontMono};letter-spacing:.06em;color:${markColor === HZ.err ? HZ.errFg : '#F0D9A8'};`;
      mark.textContent = markText;
      const text = document.createElement('span');
      text.style.cssText = `flex:1;min-width:0;font:500 11.5px/1.6 ${HZ.fontMono};color:${HZ.yPale};word-break:break-word;`;
      text.textContent = body;
      row.appendChild(mark);
      row.appendChild(text);
      panel.appendChild(row);
    }

    const cLogs = bgConsoleLogs.map((e) => e.data);
    cLogs.forEach((log) => {
      // PM-155：依 source 分圖示——resource 🖼️、web-vitals ⚡；否則依 level（error ❌ / warn ⚠）
      // PM-430：圖示換成文字標籤（§1 全站禁用 emoji、§7.7 不靠顏色傳達內容）
      let mark = 'WRN';
      // 明寫 string：HZ 是 as const，不標型別會被推成 "#DFA800" 這個字面型別，後面換色編不過
      let color: string = HZ.yDeep; // §7.7 WRN → 金黃
      if (log.source === 'resource-error') {
        mark = 'RES';
      } else if (log.source === 'web-vitals') {
        mark = 'VITAL';
        if (log.level === 'info') color = HZ.y; // 良好 → 黃（這套系統沒有綠色）
      } else if (log.level === 'error') {
        mark = 'ERR';
        color = HZ.err; // §7.7 ERR / 5xx → 磚紅
      }
      appendRow(mark, color, log.message.slice(0, 120));
    });
    const nErrs = bgNetworkErrors.map((e) => e.data);
    nErrs.forEach((err) => {
      // 5xx 算 ERR（§7.7），4xx 用金黃
      appendRow(`NET ${err.status}`, err.status >= 500 ? HZ.err : HZ.yDeep, `${err.method} ${err.url.slice(0, 80)}`);
    });
    if (!cLogs.length && !nErrs.length) {
      const empty = document.createElement('div');
      empty.style.cssText = `color:${HZ.onDark};text-align:center;padding:14px;font:600 12px/1.6 ${HZ.fontUi};`;
      empty.textContent = it('monitor-empty');
      panel.appendChild(empty);
    }

    // PM-124：panel 底部「上傳報告讓 AI 分析」——打包當前 buffer 的 errors 上傳，產生報告連結
    if (cLogs.length || nErrs.length) {
      const uploadBtn = document.createElement('button');
      uploadBtn.id = 'bugezy-monitor-upload';
      uploadBtn.textContent = latestReportUrl ? it('monitor-uploaded') : it('monitor-upload');
      // 已上傳 → 反黑描邊（次要）；未上傳 → 黃底主按鈕（要你做決定）
      uploadBtn.style.cssText =
        `pointer-events:auto;display:block;width:100%;margin-top:10px;border-radius:9px;padding:11px;` +
        `font:700 13px/1 ${HZ.fontUi};cursor:pointer;` +
        (latestReportUrl
          ? `background:transparent;border:1px solid ${HZ.line2};color:${HZ.onDark2};`
          : `background:${HZ.y};border:none;color:${HZ.ink};`);
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
          storageSnapshot: getStorageSnapshot(), // PM-157：儲存空間快照（本機遮罩）
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
    ensureHzKeyframes();
    // §3.4 即時字幕 17px —— 使用者邊操作邊講話，眼睛不在字幕上，只會餘光掃過。
    bar.style.cssText =
      `position:fixed;bottom:100px;left:50%;transform:translateX(-50%);z-index:2147483647;` +
      `pointer-events:none;background:${HZ.ink};border:1.5px solid ${HZ.brown};color:${HZ.yPale};` +
      `padding:11px 20px;border-radius:14px;font:500 17px/1.4 ${HZ.fontUi};max-width:80%;` +
      `transition:opacity 0.3s;display:flex;align-items:center;gap:10px;`;

    // 脈衝六角（原本靠字幕文字前面的 🟢/🔴 表示狀態，PM-430 改成獨立的標記）
    bar.appendChild(hzHex(9, HZ.y, true));

    // 文字部分用 span 包裹（PM-30：更新字幕只動這個 span，避免清掉重啟按鈕與六角）
    const textSpan = document.createElement('span');
    textSpan.id = 'bugezy-caption-text';
    textSpan.style.cssText = 'flex:1;pointer-events:none;text-align:center;';
    textSpan.textContent = it('caption-recording');

    // 永久重啟按鈕（PM-30：靜默中斷時使用者隨時可手動重啟）
    const restartBtn = document.createElement('button');
    restartBtn.id = 'bugezy-voice-restart';
    restartBtn.title = '重新啟動語音辨識';
    restartBtn.style.cssText =
      `pointer-events:auto;background:${HZ.ink2};border:1px solid ${HZ.line2};border-radius:8px;` +
      `width:30px;height:30px;padding:0;display:flex;align-items:center;justify-content:center;` +
      `cursor:pointer;margin-left:4px;flex-shrink:0;`;
    // §6 播放三角（原本是 🔄）—— 「再跑一次」用三角比旋轉箭頭好畫，語意也通
    const restartIcon = document.createElement('span');
    restartIcon.style.cssText =
      `width:10px;height:12px;background:${HZ.y};clip-path:polygon(0 0,100% 50%,0 100%);`;
    restartBtn.appendChild(restartIcon);
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
    // PM-237 Bug2：面板本體改 pointer-events:auto（否則拖不動）；預設 top:200px/right:12px，
    //   若使用者本頁曾拖曳過（voicePanelPos）則沿用該座標（改用 left 定位）。
    panel.style.cssText =
      `position:fixed;top:200px;right:12px;z-index:2147483647;pointer-events:auto;width:262px;` +
      `max-height:50vh;overflow-y:auto;background:${HZ.ink};border:2px solid ${HZ.brown};` +
      `border-radius:12px;padding:0;font:${HZ.fontUi};color:${HZ.yPale};transition:opacity 0.3s;`; // PM-40/44：60→140→200px 避免被書籤列/其他擴充遮擋
    if (voicePanelPos) {
      panel.style.left = `${voicePanelPos.left}px`;
      panel.style.top = `${voicePanelPos.top}px`;
      panel.style.right = 'auto';
    }

    // PM-237 Bug2：header 作為拖曳把手——改 pointer-events:auto + cursor:grab。
    //   （PM-31 Bug1 原設 none 防誤點；改用「只有 header 可拖、內容區仍 none」達成同樣防呆。）
    const header = document.createElement('div');
    header.style.cssText =
      `display:flex;justify-content:space-between;align-items:center;gap:8px;` +
      `padding:8px 11px;background:${HZ.ink2};border-bottom:1px solid ${HZ.line};` +
      `border-radius:10px 10px 0 0;pointer-events:auto;cursor:grab;user-select:none;`;
    // 三線拖曳把手（設計稿畫面 23）—— 讓「這裡可以拖」變成看得出來的事
    const grip = document.createElement('span');
    grip.style.cssText = 'display:flex;flex-direction:column;gap:2px;flex-shrink:0;';
    for (let i = 0; i < 3; i++) {
      const line = document.createElement('span');
      line.style.cssText = `width:13px;height:2px;border-radius:2px;background:${HZ.onDark2};`;
      grip.appendChild(line);
    }
    header.appendChild(grip);
    // PM-69：用 DOM 節點建構，避免 innerHTML 在 Trusted-Types CSP 網站（如 GitHub）拋錯
    const headerLabel = document.createElement('span');
    headerLabel.style.cssText = `flex:1;font:700 11.5px/1 ${HZ.fontUi};color:${HZ.y};`;
    headerLabel.textContent = it('caption-voice-log');
    header.appendChild(headerLabel);

    const content = document.createElement('div');
    content.id = 'bugezy-voice-content';
    // PM-237 Bug2：內容區維持 pointer-events:none（面板本體現為 auto，需顯式關掉內容區避免誤選文字干擾頁面）
    content.style.cssText =
      `white-space:pre-wrap;word-break:break-word;pointer-events:none;` +
      `padding:10px 12px;font:400 12px/1.6 ${HZ.fontUi};color:${HZ.yPale};`;

    // 收合按鈕獨立，只有它是 pointer-events:auto
    let collapsed = false;
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'bugezy-panel-toggle';
    toggleBtn.title = '收合/展開';
    toggleBtn.style.cssText =
      `pointer-events:auto;background:transparent;border:1px solid ${HZ.line2};border-radius:7px;` +
      `width:22px;height:20px;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;`;
    // §6 三角（原本是 ▼ / ▶ 兩個字元）。旋轉 -90 度就是「收合」。
    const toggleIcon = document.createElement('span');
    toggleIcon.style.cssText =
      `width:9px;height:6px;background:${HZ.onDark2};clip-path:polygon(0 0,100% 0,50% 100%);transition:transform .2s;`;
    toggleBtn.appendChild(toggleIcon);
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      content.style.display = collapsed ? 'none' : 'block';
      toggleIcon.style.transform = collapsed ? 'rotate(-90deg)' : 'none';
    });
    header.appendChild(toggleBtn);

    // PM-237 Bug2：header 拖曳——mousedown 記 offset → mousemove 更新 left/top（限制在視窗內）→ mouseup 結束。
    //   mousemove/mouseup 只在拖曳期間掛上 window，結束即移除（面板重建不累積監聽器）。
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    const onDragMove = (ev: MouseEvent) => {
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
      const left = Math.min(Math.max(0, ev.clientX - dragOffsetX), maxLeft);
      const top = Math.min(Math.max(0, ev.clientY - dragOffsetY), maxTop);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
      voicePanelPos = { left, top }; // 記憶（頁面存活期間）
    };
    const onDragEnd = () => {
      header.style.cursor = 'grab';
      window.removeEventListener('mousemove', onDragMove);
      window.removeEventListener('mouseup', onDragEnd);
    };
    header.addEventListener('mousedown', (ev) => {
      if (toggleBtn.contains(ev.target as Node)) return; // 點收合按鈕不觸發拖曳
      const rect = panel.getBoundingClientRect();
      dragOffsetX = ev.clientX - rect.left;
      dragOffsetY = ev.clientY - rect.top;
      header.style.cursor = 'grabbing';
      ev.preventDefault(); // 防拖曳時選字
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup', onDragEnd);
    });

    panel.appendChild(header);
    panel.appendChild(content);
    document.body.appendChild(panel);

    // PM-369（資安）：**不再向 content 索取歷史語音。**
    // 那條路徑會把跨頁累積的逐字稿送進 MAIN world，而 MAIN world 與頁面共用 JS 環境，
    // 任何網站監聽 `message` 就能全部收走。面板改為只顯示當前頁的即時逐字稿。
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
    // §3.4 鍵盤模式 16px；三條字幕條裡邊框最低調的一條（1.5px --line-dark-2）
    bar.style.cssText =
      `position:fixed;bottom:100px;left:50%;transform:translateX(-50%);z-index:2147483647;` +
      `pointer-events:none;background:${HZ.ink};border:1.5px solid ${HZ.line2};color:${HZ.onDark2};` +
      `padding:11px 20px;border-radius:14px;font:500 16px/1.4 ${HZ.fontUi};` +
      `display:flex;align-items:center;gap:10px;`;
    // §6 鍵盤 → 圓角方框 + 底部橫槓
    const kb = document.createElement('span');
    kb.style.cssText =
      `width:17px;height:12px;box-sizing:border-box;border:2px solid ${HZ.onDark2};border-radius:3px;` +
      `display:flex;align-items:flex-end;justify-content:center;padding-bottom:1.5px;flex-shrink:0;`;
    const kbBar = document.createElement('span');
    kbBar.style.cssText = `width:8px;height:2px;background:${HZ.onDark2};`;
    kb.appendChild(kbBar);
    const kbTxt = document.createElement('span');
    kbTxt.textContent = it('keyboard-bar');
    bar.append(kb, kbTxt);
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
    // §3.4 Whisper 錄音條 16px。邊框用黃色（比即時字幕的咖啡邊更強調 —— 這條是「正在錄，講完要按停止」）
    bar.style.cssText =
      `position:fixed;bottom:100px;left:50%;transform:translateX(-50%);z-index:2147483647;` +
      `pointer-events:none;background:${HZ.ink};border:1.5px solid ${HZ.y};color:${HZ.yPale};` +
      `padding:11px 20px;border-radius:14px;font:500 16px/1.4 ${HZ.fontUi};` +
      `display:flex;align-items:center;gap:10px;`;

    // PM-97：5 條音量條（取代原本 bugezy-pulse 靜態紅點）
    const bars = document.createElement('span');
    bars.id = 'bugezy-volume-bars';
    bars.style.cssText = 'display:flex;align-items:flex-end;gap:2px;height:20px;flex-shrink:0;';
    for (let i = 0; i < 5; i++) {
      const b = document.createElement('span');
      b.className = 'bugezy-vol-bar';
      // 柱色由內到外 brown → y-deep → y → y-deep → brown（設計稿畫面 26）
      const BAR_COLORS = [HZ.brown, HZ.yDeep, HZ.y, HZ.yDeep, HZ.brown];
      b.style.cssText =
        `width:4px;background:${BAR_COLORS[i]};border-radius:2px;transition:height 0.15s ease;height:4px;`;
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
      // PM-430：不要在這裡覆寫顏色。柱色是建立時依位置給的（brown → y-deep → y → …），
      //   inline style 一寫就永久蓋掉；「有沒有聽到聲音」由高度表達就夠了（§7.7）。
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
    // PM-216：狀態文字改 i18n（跟隨 data-bugezy-lang）
    const base =
      state === 'listening'
        ? it('caption-listening')
        : state === 'restarting'
          ? it('caption-restarting')
          : it('caption-stopped');
    setCaptionText(note ? `${base} — ${note}` : base);
  }

  // PM-33：自動重啟連續失敗計數（放在 createRecognition 外，建新實例不重置）
  let autoRestartFails = 0;
  // PM-240 問題1：interim 字幕節流——韓語等組合型文字每個組字步驟都觸發 onresult（每秒數十次），
  //   每次都做 DOM 更新會淹沒瀏覽器。interim 的 setCaptionText 最多每 150ms 更新一次（final 不受限）。
  let lastInterimUpdate = 0;
  const INTERIM_THROTTLE_MS = 150;
  // PM-247：只有這些語言的 Chrome Web Speech 很少送 isFinal（一直停在 interim），才需要 stale interim
  //   自動升級（currentSpeechLang 為 BCP-47：粵語=yue-Hant-HK、越南語=vi）。其餘語言正常 finalize，
  //   啟用會誤把停頓當結束、又被 PM-246 去重誤殺完整句子。
  const NEEDS_INTERIM_PROMOTE = new Set(['yue-Hant-HK', 'vi']);
  // PM-240 問題2：記錄本次 recognition session 啟動時間——onend 判斷 session 是否「短命」（<1s），
  //   短命不歸零失敗計數，避免韓語瞬間 onstart→onend 循環讓計數永遠到不了 3。
  let lastRecognitionStartTime = 0;
  // PM-241：越南語模型很少主動送 isFinal，長時間停在 interim。加「stale interim 自動升級」——
  //   interim 文字穩定不變超過 3 秒即視為 final（推 segments/flush/面板）。
  let interimPromoteTimer: ReturnType<typeof setTimeout> | null = null;
  let lastInterimText = '';
  // PM-246：記錄最近一次 stale interim 自動升級推送的文字，供 final handler 去重——
  //   Chrome（粵語/越南語）在 session 結束會補發同一段文字的 isFinal，避免再推一次造成重複。
  let lastPromotedText = '';
  let lastPromotedTime = 0;
  /** PM-241：取消待升級的 interim timer（僅動 timer + lastInterimText；不清 promoted 追蹤，
   *  留給 final handler 去重用）。final handler 開頭呼叫此函式。 */
  function cancelInterimTimer() {
    if (interimPromoteTimer) {
      clearTimeout(interimPromoteTimer);
      interimPromoteTimer = null;
    }
    lastInterimText = '';
  }
  /** PM-241/246：停錄 / 強制重啟時完整清除（timer + lastInterimText + promoted 去重追蹤）。 */
  function clearInterimPromote() {
    cancelInterimTimer();
    lastPromotedText = '';
    lastPromotedTime = 0;
  }

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
    rec.interimResults = true; // PM-237 Bug1：開啟暫時結果，底部字幕即時顯示辨識中文字

    rec.onresult = (e: SREvent) => {
      // PM-237 Bug1：本次事件的暫時（interim）文字，僅供底部字幕即時顯示，不推入 segments/面板
      let interim = '';
      let hadFinal = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          hadFinal = true;
          let text = e.results[i][0].transcript.trim();
          // PM-243：Chrome zh-CN 辨識回傳仍是繁體字，final 文字繁轉簡（其他語言零影響）。
          if (text && currentSpeechLang === 'zh-CN') text = toSimplified(text);
          if (text) {
            // PM-241：真 final 到達 → 取消待升級的 stale interim timer（僅動 timer，保留 promoted 供去重）。
            cancelInterimTimer();
            // PM-246：去重——若這段 final 在 5 秒內已被 stale interim 自動升級推送過（相同或互為子集），跳過。
            const dup =
              lastPromotedText !== '' &&
              Date.now() - lastPromotedTime < 5000 &&
              (text === lastPromotedText ||
                lastPromotedText.includes(text) ||
                text.includes(lastPromotedText));
            lastPromotedText = '';
            lastPromotedTime = 0;
            if (!dup) {
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
              setCaptionText(text); // PM-430：狀態由字幕條左側的脈衝六角表示，不再前綴 emoji
              window.setTimeout(() => {
                if (voiceActive) setVoiceStatus('listening');
              }, 1500);
            }
          }
        } else {
          // PM-237 Bug1：暫時結果累積（不 trim，保留空格讓即時字幕自然）
          // PM-243：zh-CN interim 也繁轉簡，底部即時字幕才是簡體。
          let seg = e.results[i][0].transcript;
          if (currentSpeechLang === 'zh-CN') seg = toSimplified(seg);
          interim += seg;
        }
      }
      // PM-237 Bug1：只在「本次沒有 final」時把 interim 顯示到底部字幕條
      //（有 final 時保留 ✅ 確認文字 1.5 秒不被 interim 蓋掉）
      // PM-240 問題1：interim 更新加節流（最多每 150ms 一次），避免韓語組字風暴淹沒 DOM。
      if (!hadFinal && interim.trim()) {
        const trimmed = interim.trim();
        const now = Date.now();
        if (now - lastInterimUpdate >= INTERIM_THROTTLE_MS) {
          setCaptionText(trimmed);
          lastInterimUpdate = now;
        }

        // PM-241：stale interim 自動升級——interim 文字每次變動就重設 3 秒 timer；
        //   若 3 秒內都沒再變（越南語模型停在 interim 不主動 finalize），視為 final 送出。
        // PM-247：僅粵語/越南語啟用（其餘語言正常 finalize，啟用會誤殺完整句子）。
        if (NEEDS_INTERIM_PROMOTE.has(currentSpeechLang) && trimmed !== lastInterimText) {
          lastInterimText = trimmed;
          if (interimPromoteTimer) clearTimeout(interimPromoteTimer);
          interimPromoteTimer = setTimeout(() => {
            interimPromoteTimer = null;
            if (lastInterimText && voiceActive) {
              const promoted = lastInterimText;
              blog('interim 自動升級 final:', promoted.slice(0, 40));
              const seg: VoiceSegment = { text: promoted, timestamp: Date.now(), isFinal: true };
              voiceSegments.push(seg);
              post({ source: BUGEZY_SOURCE, dir: 'to-content', kind: 'FLUSH_VOICE', segment: seg });

              // 右上面板追加
              const vc = document.getElementById('bugezy-voice-content');
              if (vc) {
                vc.textContent += (vc.textContent ? '\n' : '') + promoted;
                const panel = document.getElementById('bugezy-voice-panel');
                if (panel) panel.scrollTop = panel.scrollHeight;
              }

              // 底部字幕確認
              setCaptionText(promoted);
              window.setTimeout(() => {
                if (voiceActive) setVoiceStatus('listening');
              }, 1500);

              lastInterimText = '';
              // PM-246：記錄本次升級文字 + 時間，供隨後補發的 isFinal 去重。
              lastPromotedText = promoted;
              lastPromotedTime = Date.now();
            }
          }, 3000); // 3 秒穩定 → 升級
        }
      }
    };

    // PM-70：實際啟動成功才把狀態切到「聽取中」。
    // PM-240 問題2：記錄啟動時間，但**不**在此歸零 autoRestartFails——
    //   改在 onend 判斷 session 夠長（>1s）才歸零，防止韓語等短命 session 無限循環。
    rec.onstart = () => {
      if (voiceActive) {
        lastRecognitionStartTime = Date.now();
        setVoiceStatus('listening');
      }
    };

    rec.onend = () => {
      // 靜默自停 → 仍在錄製就自動重啟；連續失敗 3 次就停手，等使用者按 🔄
      if (!voiceActive) return;
      // PM-240 問題2：只有「持續超過 1 秒」的正常 session 才歸零計數；
      //   短命 session（<1s，疑似韓語辨識瞬間 onstart→onend）不歸零，讓計數累積到 3 次後停手。
      const sessionDuration = Date.now() - lastRecognitionStartTime;
      if (sessionDuration > 1000) {
        autoRestartFails = 0;
      }
      blog(`SpeechRecognition onend（session ${sessionDuration}ms）→ auto restart`);
      setVoiceStatus('restarting');
      try {
        rec.start();
      } catch {
        autoRestartFails++;
        blog(`auto restart 失敗 (第 ${autoRestartFails} 次)`);
        if (autoRestartFails >= 3) {
          setVoiceStatus('stopped', it('caption-note-restart'));
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
        setVoiceStatus('stopped', it('caption-note-denied'));
      } else if (err === 'audio-capture') {
        // 麥克風裝置問題（被佔用/拔除）→ 提示，但不關 voiceActive，
        // 交給 onend 自動重啟 + 失敗計數收斂
        setVoiceStatus('stopped', it('caption-note-nocapture'));
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

    // Step 1：先關 voiceActive，再停掉舊的並丟棄。
    // PM-238：關鍵修法——`stop()` 會觸發舊實例的 onend，而 onend 看到 voiceActive===true
    //   就會對「舊」rec 執行 start() 自動重啟；隨後 Step 4 又建新實例 start()，
    //   兩個 SpeechRecognition 搶麥克風互相觸發 onend → 無限「Restarting…」循環。
    //   先設 false 讓 onend 直接 return，等新實例建好再設回 true。
    voiceActive = false;
    clearInterimPromote(); // PM-241：重啟前清除待升級 timer
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
      voiceActive = true; // PM-238：恢復旗標，讓使用者可再次嘗試
      setVoiceStatus('stopped', it('caption-note-noaccess'));
      return;
    }

    // Step 3：等 500ms 讓 Chrome 清理舊的音訊資源
    await new Promise((r) => setTimeout(r, 500));

    // Step 4：恢復 voiceActive，建全新實例（全新 handlers）
    voiceActive = true; // PM-238：新實例的 onend 需要 voiceActive===true 才會自動重啟
    recognition = createRecognition();
    if (recognition) {
      try {
        recognition.start();
        autoRestartFails = 0; // 手動重啟 → 重置自動重啟失敗計數（onstart 也會再歸零）
        setVoiceStatus('listening'); // onstart 確認後也會再設一次
        blog('語音強制重啟成功');
      } catch (err) {
        blog('語音強制重啟失敗', err);
        setVoiceStatus('stopped', it('caption-note-restart-fail'));
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
  // ── PM-342：錯誤發生「當下」記下現場元素（Zone Grid 的 error 歸類地基）──────
  //
  // 🔴 規格書 §15.3 原本寫「從 stack trace 反推 DOM 元素」——**那做不出來**：
  //    stack trace 只有 `檔名:行:列`，瀏覽器不提供任何「frame → 節點」的 API。
  //    照字面實作會得到一個永遠回 null 的歸類器（PM-304 已查證）。
  //    正解是**在錯誤發生的那一刻抓現場**，而 inject 就在 MAIN world、抓得到。
  //
  // 記的是 **selector 字串**而不是元素本身：這筆資料要經 postMessage 送到 content script，
  // DOM 節點不可序列化，硬塞會整包丟失。
  let lastInteractedSelector: string | null = null;

  /** 產生一個短而夠用的 selector（不求絕對唯一，歸類只需要能往上找到 zone 祖先）。 */
  function sceneSelector(el: Element | null): string | null {
    if (!el || !(el instanceof Element)) return null;
    const parts: string[] = [];
    let cur: Element | null = el;
    let depth = 0;
    while (cur && cur !== document.documentElement && depth < 6) {
      if (cur.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break; // 有 id 就夠了，不必再往上
      }
      const tag = cur.tagName.toLowerCase();
      const cls =
        typeof cur.className === 'string' && cur.className.trim()
          ? '.' + CSS.escape(cur.className.trim().split(/\s+/)[0])
          : '';
      parts.unshift(tag + cls);
      cur = cur.parentElement;
      depth++;
    }
    return parts.length ? parts.join(' > ') : null;
  }

  // 使用者最後互動過的元素——fetch/XHR 失敗時多半沒有直接的「現場元素」，
  // 這是唯一還原得出「哪一區觸發了這個請求」的線索（§15.3 的第三條路徑）。
  for (const evt of ['click', 'input', 'focusin'] as const) {
    window.addEventListener(
      evt,
      (e: Event) => {
        const t = e.target;
        if (t instanceof Element) lastInteractedSelector = sceneSelector(t);
      },
      true, // capture：即使頁面自己 stopPropagation 也收得到
    );
  }

  /** 錯誤發生當下的現場元素 selector；抓不到回 null（→ 歸入 Unassigned，**絕不靜默丟掉**）。 */
  function currentSceneSelector(): string | null {
    const active = document.activeElement;
    if (active && active !== document.body && active instanceof Element) {
      const s = sceneSelector(active);
      if (s) return s;
    }
    return lastInteractedSelector;
  }

  // PM-154：統一收集入口 + 去重——console.error / window.onerror / unhandledrejection
  //         可能對同一錯誤重複觸發，去重避免報告塞滿重複列。
  const recentErrors = new Set<string>();
  function collectConsoleLog(entry: ConsoleLog): void {
    // PM-342：呼叫端沒指定現場元素時（window.onerror / unhandledrejection / console.error），
    //   用「當下的 activeElement 或最後互動元素」補上。抓不到就留 undefined → 歸入 Unassigned。
    if (entry.elementSelector === undefined && entry.level !== 'info') {
      const scene = currentSceneSelector();
      if (scene) entry.elementSelector = scene;
    }
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
        // PM-430：改文字標籤（§1 全站禁用 emoji）。這行會進 console log 與監控面板兩邊。
        message: `Web Vital ${name}: ${value}${unit} ${bad ? desc : '良好'}`,
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
        // PM-342：資源錯誤的 event.target **就是**出問題的元素——這條路徑最準，直接用
        elementSelector: sceneSelector(target) ?? undefined,
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
          // PM-342：fetch/XHR 沒有天然的「現場元素」，用發起當下的 activeElement／
          //   最後互動元素當線索（§15.3 第三條路徑）。抓不到 → Unassigned。
          elementSelector: currentSceneSelector() ?? undefined,
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
            elementSelector: currentSceneSelector() ?? undefined, // PM-342：XHR 同 fetch
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
    overlay.style.cssText =
      `position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;` +
      `background:rgba(14,12,8,.62);display:flex;align-items:center;justify-content:center;` +
      `font-family:${HZ.fontUi};`;

    const card = document.createElement('div');
    card.style.cssText =
      `width:308px;box-sizing:border-box;background:${HZ.ink};border:2px solid ${HZ.y};` +
      `border-radius:16px;padding:26px 24px;text-align:center;` +
      `display:flex;flex-direction:column;align-items:center;gap:14px;` +
      `box-shadow:0 8px 32px rgba(0,0,0,.5);`;

    // §6.1 四層麥克風，裝在 52px 的**黃色**六角殼裡（頁內是黑殼，所以殼反過來用黃、內部反色）
    const icon = document.createElement('div');
    icon.style.cssText =
      `width:52px;height:60px;flex-shrink:0;background:${HZ.y};clip-path:${HZ.hex};` +
      `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;`;
    const micParts = [
      `width:13px;height:19px;border-radius:7px;` +
        `background:repeating-linear-gradient(${HZ.ink} 0 2px,${HZ.y} 2px 4px);` +
        `box-shadow:0 0 0 2px ${HZ.ink} inset;`,
      `width:17px;height:7px;box-sizing:border-box;border:2px solid ${HZ.ink};border-top:none;border-radius:0 0 10px 10px;`,
      `width:2px;height:3px;background:${HZ.ink};`,
      `width:12px;height:2px;border-radius:2px;background:${HZ.ink};`,
    ];
    for (const cssText of micParts) {
      const part = document.createElement('span');
      part.style.cssText = cssText;
      icon.appendChild(part);
    }

    const title = document.createElement('h3');
    title.textContent = it('mic-perm-title');
    title.style.cssText = `color:${HZ.y};font:700 17px/1.35 ${HZ.fontUi};margin:0;`;

    const desc = document.createElement('p');
    desc.textContent = it('mic-perm-desc');
    desc.style.cssText = `color:${HZ.onDark2};font:500 13px/1.6 ${HZ.fontUi};margin:0;`;

    const allowBtn = document.createElement('button');
    allowBtn.textContent = it('mic-perm-allow');
    allowBtn.style.cssText =
      `display:block;width:100%;background:${HZ.y};color:${HZ.ink};border:none;` +
      `border-radius:11px;padding:12px;font:700 14px/1 ${HZ.fontUi};cursor:pointer;`;

    const skipBtn = document.createElement('button');
    skipBtn.textContent = it('mic-perm-skip');
    skipBtn.style.cssText =
      `display:block;width:100%;background:transparent;color:${HZ.onDark2};` +
      `border:1px solid ${HZ.line2};border-radius:11px;padding:11px;` +
      `font:700 13px/1 ${HZ.fontUi};cursor:pointer;`;

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
    clearInterimPromote(); // PM-241：停錄清除待升級 timer，避免停錄後還冒出過期文字
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
      storageSnapshot: getStorageSnapshot(), // PM-157：儲存空間快照（本機遮罩）
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
        storageSnapshot: getStorageSnapshot(), // PM-157：儲存空間快照（本機遮罩）
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
