// edit-report.ts — 停止錄製後的報告編輯頁（PM-24）
// 從 storage 讀 payload + summary → 顯示摘要 + 語音記錄 → 使用者補描述（可語音）→ 上傳。

import { Replayer } from '@rrweb/replay';
import '@rrweb/replay/dist/style.css';
import {
  API_BASE,
  KEYBOARD_MODE_KEY,
  LANG_KEY,
  STATE_KEY,
  STORAGE_KEY,
  blog,
  type ControlMessage,
  type RecordingPayload,
  type RecordingSummary,
  type TimeMarker,
} from './types';
import { getAuthHeaders } from './auth';
import { getUILang, t, type UILang } from './i18n';

// PM-215：編輯報告頁 UI 語言 + 語音辨識語言跟隨 popup 的語言設定（LANG_KEY）。
let uiLang: UILang = 'zh';
let srLang = 'zh-TW'; // SpeechRecognition.lang（zh→zh-TW / yue→yue-Hant-HK / en→en-US）
let reportLang = 'zh'; // PM-217：popup 原始語言碼（LANG_KEY 值）——傳給 /api/correct、/api/summarize 切 prompt
const T = (key: string, params?: Record<string, string | number>): string => t(key, uiLang, params);
// 錄製語言（LANG_KEY 存的 whisper 語言碼）→ Web Speech 的 BCP-47 lang
function speechToSrLang(speechLang: string): string {
  if (speechLang === 'en') return 'en-US';
  if (speechLang === 'yue') return 'yue-Hant-HK';
  if (speechLang === 'zh-CN') return 'zh-CN'; // PM-232：簡體中文語音辨識
  if (speechLang === 'ja') return 'ja'; // PM-233：日語語音辨識
  if (speechLang === 'ko') return 'ko'; // PM-234：韓語語音辨識
  if (speechLang === 'vi') return 'vi'; // PM-235：越南語語音辨識
  return 'zh-TW'; // zh 及其餘一律繁中
}
// PM-215：套用 [data-i18n]/[data-i18n-ph] 靜態翻譯（mirror annotate.applyAnnotateTranslations）
function applyEditTranslations() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key, uiLang);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-ph]').forEach((el) => {
    const key = el.getAttribute('data-i18n-ph');
    if (key) (el as HTMLTextAreaElement | HTMLInputElement).placeholder = t(key, uiLang);
  });
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const summaryEl = $('summary');
const voiceText = $<HTMLTextAreaElement>('voiceText');
const descInput = $<HTMLTextAreaElement>('descInput');
const voiceBtn = $<HTMLButtonElement>('voiceBtn');
const voiceStatus = $<HTMLDivElement>('voiceStatus');
const discardBtn = $<HTMLButtonElement>('discardBtn');
const uploadBtn = $<HTMLButtonElement>('uploadBtn');
const summarizeBtn = $<HTMLButtonElement>('summarizeBtn');
const correctBtn = $<HTMLButtonElement>('correctBtn');
const result = $('result');

// ── 載入摘要 + 語音記錄 ───────────────────────────────────
async function init() {
  const store = await chrome.storage.local.get([STORAGE_KEY, STATE_KEY, LANG_KEY]);
  const payload = store[STORAGE_KEY] as RecordingPayload | undefined;
  const state = store[STATE_KEY] as { summary?: RecordingSummary } | undefined;
  // PM-215：UI 語言 + 語音辨識語言跟隨 popup 設定（LANG_KEY）
  const speechLang = (store[LANG_KEY] as string) || 'zh';
  reportLang = speechLang; // PM-217：傳給 AI 校正/精簡 API
  uiLang = getUILang(speechLang);
  srLang = speechToSrLang(speechLang);
  applyEditTranslations(); // 先套靜態 UI 翻譯（後續 JS 動態文字用 T()）
  if (!payload) {
    summaryEl.textContent = T('er-no-report');
    return;
  }

  // PM-204：截圖標注報告（無 rrweb、有 screenshots）——顯示截圖預覽取代 rrweb 播放器；
  // 其餘區塊（語音 / 補充說明 / Token / AI 校正 / AI 精簡 / 上傳）完全複用。
  const isScreenshot =
    !payload.rrwebEvents?.length &&
    Array.isArray(payload.screenshots) &&
    payload.screenshots.length > 0;

  const dur = state?.summary?.durationMs ?? 0;
  const rows: Array<[string, string | number]> = isScreenshot
    ? [
        [T('er-row-screenshot'), payload.screenshots!.length],
        ['Console', payload.consoleLogs.length],
        ['Network', payload.networkErrors.length],
        [T('er-row-page'), payload.pageInfo.title || payload.pageInfo.url],
      ]
    : [
        [T('er-row-dom'), payload.rrwebEvents.length],
        ['Console', payload.consoleLogs.length],
        ['Network', payload.networkErrors.length],
        [T('er-row-voice'), payload.voiceTranscript.length],
        [T('er-row-duration'), `${Math.round(dur / 1000)} ${T('er-sec')}`],
        [T('er-row-page'), payload.pageInfo.title || payload.pageInfo.url],
      ];
  summaryEl.replaceChildren(
    ...rows.map(([k, v]) => {
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = `${v}`;
      d.append(`${k}${uiLang === 'en' ? ': ' : '：'}`, b);
      return d;
    }),
  );

  // PM-204：把 annotate（或先前）帶入的問題描述載入「補充說明」欄，避免上傳時被空值覆寫
  if (payload.description) descInput.value = payload.description;

  if (isScreenshot) {
    // PM-208：截圖報告的語音已併入補充說明 → 「語音記錄」區改標示（不顯示逐字稿），並隱藏 AI 校正/精簡
    voiceText.value = T('er-screenshot-voice');
    voiceText.readOnly = true;
    voiceText.style.color = 'var(--muted)';
    correctBtn.style.display = 'none';
    summarizeBtn.style.display = 'none';
    // 顯示截圖預覽，隱藏播放器控制列與時間軸標記
    showScreenshotPreview(payload.screenshots![0]?.dataUrl);
  } else {
    // 語音記錄合成一段（錄製報告的逐字稿）
    voiceText.value = payload.voiceTranscript.map((s) => s.text).join('');
    // PM-28：初始化 mini rrweb 播放器 + 時間軸標記
    initMiniPlayer(payload.rrwebEvents);
  }

  // PM-55：上傳前先讓使用者看到 AI 讀這份報告的 token 估算 + 省錢對比
  renderTokenEstimate(payload);
}

// PM-204：截圖報告——用截圖預覽圖取代 rrweb 播放器（標題改「截圖預覽」、隱藏播放/標記控制）
function showScreenshotPreview(dataUrl?: string) {
  const section = document.getElementById('markerSection');
  if (!section) return;
  const heading = section.querySelector('h2');
  if (heading) heading.textContent = T('er-screenshot-preview');
  const controls = section.querySelector('.marker-controls') as HTMLElement | null;
  if (controls) controls.style.display = 'none';
  const list = document.getElementById('markerList');
  if (list) list.style.display = 'none';
  const container = document.getElementById('miniPlayer');
  if (container && dataUrl) {
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = T('er-screenshot-preview');
    img.style.cssText = 'width:100%; display:block; border-radius:8px;';
    container.replaceChildren(img);
    container.style.background = 'transparent';
  }
}
void init();

// PM-55：報告各區塊 token 估算（上傳前顯示，讓客戶知道 AI 讀這份要花多少 token）
function renderTokenEstimate(payload: RecordingPayload) {
  const container = document.getElementById('tokenBreakdown');
  if (!container) return;

  const voiceTextStr = payload.voiceTranscript.map((s) => s.text).join('');
  const estimates = [
    { label: T('er-tok-voice'), text: voiceTextStr, icon: '🎤' },
    { label: 'Console logs', text: JSON.stringify(payload.consoleLogs), icon: '🖥' },
    { label: 'Network errors', text: JSON.stringify(payload.networkErrors), icon: '🌐' },
    { label: T('er-tok-desc'), text: descInput.value || '', icon: '📝' },
    { label: T('er-tok-markers'), text: JSON.stringify(markers), icon: '📌' },
  ];

  let totalTokens = 0;
  let html = '';
  for (const est of estimates) {
    const tokens = Math.ceil(est.text.length / 3.5);
    if (tokens > 0) {
      totalTokens += tokens;
      html += `<div class="token-row"><span class="label">${est.icon} ${est.label}</span><span>~${tokens.toLocaleString()} tokens</span></div>`;
    }
  }

  // rrweb 摘要（get_rrweb_summary 只回筆數，很小）
  const rrwebSummaryTokens = 30;
  totalTokens += rrwebSummaryTokens;
  html += `<div class="token-row"><span class="label">📹 ${T('er-tok-dom')}</span><span>~${rrwebSummaryTokens} tokens</span></div>`;

  // 總計 + 對比 Claude in Chrome
  const bugezyUSD = ((totalTokens * 8) / 1_000_000).toFixed(4);
  const chromeTokens = totalTokens * 15;
  const chromeUSD = ((chromeTokens * 8) / 1_000_000).toFixed(4);
  const savedPercent = chromeTokens > 0 ? Math.round((1 - totalTokens / chromeTokens) * 100) : 0;

  // PM-195：加 USD 單位，與最終報告頁（server）格式一致 `≈ USD $<amount>`
  html += `<div class="token-row total"><span>${T('er-tok-total')}</span><span>~${totalTokens.toLocaleString()} tokens ≈ USD $${bugezyUSD}</span></div>`;
  html += `<div class="token-save">${T('er-tok-compare')}~${chromeTokens.toLocaleString()} tokens ≈ USD $${chromeUSD}<br>${T('er-tok-saved')} ${savedPercent}%</div>`;

  container.innerHTML = html;
}

// ── PM-28：時間軸標記 ─────────────────────────────────────
const markers: TimeMarker[] = [];
let replayer: Replayer | null = null;
let duration = 0; // 總時長（ms）
let playing = false;
// PM-40/41：mini player 放大/縮小切換旗標
let zoomed = false;

function $opt<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ── PM-68：跨頁回放滑鼠游標修復 ──────────────────────────
// 問題：跨頁錄製時，每換一頁 rrweb 都送一段新的 FullSnapshot，replayer 重建 DOM。
// 新頁在使用者下一次移動滑鼠前沒有 MouseMove 事件，replayer 的 .replayer-mouse 游標
// 因此「消失」到下一次移動為止。修法：在每個「非首段」FullSnapshot 後補一筆合成的
// MouseMove（座標沿用上一段最後已知值、hover 目標 id 指向新頁的 <html> 節點），讓
// 游標一進新頁就立刻現形。inject.ts 端不需改：rrweb 預設就會錄 mousemove，
// 且 mouseTail 是 Replayer（回放）選項而非 record() 選項。
type RRPos = { x?: number; y?: number; id?: number; timeOffset?: number };
type RREvent = {
  type?: number;
  timestamp?: number;
  data?: {
    source?: number;
    positions?: RRPos[];
    x?: number;
    y?: number;
    node?: { childNodes?: Array<{ type?: number; id?: number; tagName?: string }> };
  };
};

/** 從 FullSnapshot 取出 <html> 節點 id（合成 MouseMove 的 hover 目標需是新頁實際存在的節點）。 */
function findHtmlNodeId(snapshot: RREvent): number | null {
  const kids = snapshot?.data?.node?.childNodes;
  if (!Array.isArray(kids)) return null;
  // 序列化節點 type：Element = 2；優先取 <html>，否則退而求其次取任一元素節點
  let firstElementId: number | null = null;
  for (const k of kids) {
    if (k?.type === 2 && typeof k.id === 'number') {
      if (firstElementId === null) firstElementId = k.id;
      if (k.tagName?.toLowerCase() === 'html') return k.id;
    }
  }
  return firstElementId;
}

/** 跨頁游標修復：每個新頁 FullSnapshot 後注入一筆合成 MouseMove，初始化游標位置。 */
function injectCrossPageCursor(events: unknown[]): unknown[] {
  const list = events as RREvent[];
  let lastX = 0;
  let lastY = 0;
  let haveLastPos = false;
  let seenFullSnapshot = false;
  const out: RREvent[] = [];

  for (const ev of list) {
    out.push(ev);

    // 追蹤最後已知滑鼠座標（MouseMove positions / MouseInteraction x,y）
    if (ev?.type === 3 && ev.data) {
      const src = ev.data.source;
      if (src === 1 && Array.isArray(ev.data.positions) && ev.data.positions.length) {
        const p = ev.data.positions[ev.data.positions.length - 1];
        if (typeof p?.x === 'number' && typeof p?.y === 'number') {
          lastX = p.x;
          lastY = p.y;
          haveLastPos = true;
        }
      } else if (src === 2 && typeof ev.data.x === 'number' && typeof ev.data.y === 'number') {
        lastX = ev.data.x;
        lastY = ev.data.y;
        haveLastPos = true;
      }
    }

    // FullSnapshot（type 2）：首段不補；之後每段都是「新頁」→ 補合成游標
    if (ev?.type === 2) {
      if (seenFullSnapshot && haveLastPos) {
        const htmlId = findHtmlNodeId(ev);
        if (htmlId != null) {
          out.push({
            type: 3,
            data: { source: 1, positions: [{ x: lastX, y: lastY, id: htmlId, timeOffset: 0 }] },
            timestamp: (ev.timestamp || 0) + 1,
          });
        }
      }
      seenFullSnapshot = true;
    }
  }
  return out;
}

function initMiniPlayer(events: unknown[]) {
  const container = document.getElementById('miniPlayer');
  // rrweb 至少要 2 筆事件（Meta + FullSnapshot）才能回放
  if (!container || events.length < 2) {
    const section = document.getElementById('markerSection');
    if (section) section.style.display = 'none';
    return;
  }

  // PM-68：跨頁段落補合成游標，回放時每進新頁游標立即可見
  events = injectCrossPageCursor(events);

  try {
    replayer = new Replayer(events as ConstructorParameters<typeof Replayer>[0], {
      root: container,
      skipInactive: true,
      showWarning: false,
      mouseTail: true, // PM-45：開啟滑鼠軌跡，回放才看得到游標移動
    });
  } catch (err) {
    blog('mini player 建立失敗', err);
    const section = document.getElementById('markerSection');
    if (section) section.style.display = 'none';
    return;
  }

  // PM-38：預載第一幀，避免點播放時卡在開頭的 FullSnapshot 解析
  try {
    replayer.play(0);
    replayer.pause(0);
  } catch {
    /* 忽略 */
  }

  // PM-38：rrweb 以原始解析度渲染（如 1600x900），容器只有 960px → 不縮放會像
  // 放大鏡只看到左上角。等 iframe 渲染後依錄製原始尺寸算縮放比，用 transform 縮到容器寬。
  requestAnimationFrame(() => {
    const iframe = container.querySelector('iframe');
    if (!iframe) return;
    const metaEvent = (
      events as Array<{ type?: number; data?: { width?: number; height?: number } }>
    ).find((e) => e.type === 4); // type 4 = Meta，帶原始頁面寬高
    const pageWidth = metaEvent?.data?.width || 1920;
    const pageHeight = metaEvent?.data?.height || 1080;
    const containerWidth = container.clientWidth;
    const scale = containerWidth / pageWidth;
    iframe.style.width = `${pageWidth}px`;
    iframe.style.height = `${pageHeight}px`;
    iframe.style.border = 'none';
    // PM-47：縮放整個 .replayer-wrapper（含 .replayer-mouse 游標 + tail），而非只縮 iframe，
    // 否則游標停在原始座標被容器裁掉而看不見。
    const scaleTarget = (container.querySelector('.replayer-wrapper') as HTMLElement | null) ?? iframe;
    scaleTarget.style.transform = `scale(${scale})`;
    scaleTarget.style.transformOrigin = 'top left';
    // 容器高度配合縮放後的高度（取代固定 aspect-ratio）
    container.style.height = `${pageHeight * scale}px`;
    container.style.overflow = 'hidden';
  });

  duration = replayer.getMetaData().totalTime || 0;
  const seekBar = $opt<HTMLInputElement>('markerSeek');
  if (seekBar) seekBar.max = String(duration);
  updateTimeDisplay(0);

  // 播放 / 暫停
  $opt('markerPlayBtn')?.addEventListener('click', () => {
    if (!replayer) return;
    const playBtn = $opt('markerPlayBtn');
    if (playing) {
      replayer.pause();
      playing = false;
      if (playBtn) playBtn.textContent = '▶';
    } else {
      const current = replayer.getCurrentTime();
      if (current >= duration - 100) replayer.play(0);
      else replayer.resume(current);
      playing = true;
      if (playBtn) playBtn.textContent = '⏸';
      trackProgress();
    }
  });

  // seek
  seekBar?.addEventListener('input', (e) => {
    if (!replayer) return;
    const time = Number((e.target as HTMLInputElement).value);
    replayer.play(time);
    if (!playing) window.setTimeout(() => replayer?.pause(time), 50);
    updateTimeDisplay(time);
  });

  // 🔍 放大/縮小（PM-41）：容器物理變全寬（非 transform 拉 bar），scale 依新寬度重算 → 內容更清楚
  $opt('zoomBtn')?.addEventListener('click', () => {
    const iframe = container.querySelector('iframe');
    if (!iframe) return;
    zoomed = !zoomed;

    // 原始頁面寬高（initMiniPlayer 已把原始尺寸 inline 寫進 iframe）
    const pageWidth = parseInt(iframe.style.width) || 1920;
    const pageHeight = parseInt(iframe.style.height) || 1080;
    const wrap = document.querySelector('.wrap') as HTMLElement | null;

    if (zoomed) {
      // 2x：連外層 .wrap 一起撐寬，player 才真的變大（不被 720px wrap 卡住）
      if (wrap) wrap.style.maxWidth = '95vw';
      container.style.maxWidth = '100%';
      container.style.width = '100%';
    } else {
      // 1x：回到原始
      if (wrap) wrap.style.maxWidth = '720px';
      container.style.maxWidth = '960px';
      container.style.width = '100%';
    }
    const btn = $opt('zoomBtn');
    if (btn) btn.textContent = zoomed ? '🔍 1x' : '🔍 2x';

    // 容器寬度變了 → 等版面重排後依新寬度重算 scale（overflow:hidden，不用拉 bar）
    requestAnimationFrame(() => {
      const newScale = container.clientWidth / pageWidth;
      // PM-47：縮放 .replayer-wrapper（含游標），不只 iframe
      const scaleTarget =
        (container.querySelector('.replayer-wrapper') as HTMLElement | null) ?? iframe;
      scaleTarget.style.transform = `scale(${newScale})`;
      scaleTarget.style.transformOrigin = 'top left';
      container.style.height = `${pageHeight * newScale}px`;
      container.style.overflow = 'hidden';
    });
  });

  // 📌 標記此刻（mousedown preventDefault 避免搶焦點）
  const addBtn = $opt('addMarkerBtn');
  addBtn?.addEventListener('mousedown', (e) => e.preventDefault());
  addBtn?.addEventListener('click', () => {
    if (!replayer) return;
    const sec = Math.floor(replayer.getCurrentTime() / 1000);
    if (playing) {
      replayer.pause();
      playing = false;
      const playBtn = $opt('markerPlayBtn');
      if (playBtn) playBtn.textContent = '▶';
    }
    addMarker(sec);
  });

  // PM-46：乾淨/原始畫面 toggle（注入 CSS 到 Replayer iframe 控制 BugEzy overlay 顯示）
  initCleanModeToggle(container);
}

// PM-46：隱藏 BugEzy 注入 overlay 的 CSS（注入到回放 iframe 內）
const BUGEZY_HIDE_CSS = `
  #bugezy-live-caption,
  #bugezy-voice-panel,
  #bugezy-voice-restart,
  #bugezy-mic-overlay,
  #bugezy-caption-text,
  #bugezy-panel-toggle {
    display: none !important;
  }
`;

// PM-47：rrweb seek/快轉會重建 iframe DOM 移除注入的 style，MutationObserver 不夠即時，
// 改為 setInterval 每 200ms 檢查並補回，更可靠。
let cleanModeInterval: ReturnType<typeof setInterval> | null = null;

function injectCleanCSS(iframe: HTMLIFrameElement | null) {
  const doc = iframe?.contentDocument;
  if (!doc) return;
  if (!doc.getElementById('bugezy-clean-style')) {
    const style = doc.createElement('style');
    style.id = 'bugezy-clean-style';
    style.textContent = BUGEZY_HIDE_CSS;
    doc.head?.appendChild(style);
  }
}

function removeCleanCSS(iframe: HTMLIFrameElement | null) {
  iframe?.contentDocument?.getElementById('bugezy-clean-style')?.remove();
}

function initCleanModeToggle(container: HTMLElement) {
  const checkbox = document.getElementById('cleanMode') as HTMLInputElement | null;
  if (!checkbox) return;

  function applyCleanMode(clean: boolean) {
    const iframe = container.querySelector('iframe') as HTMLIFrameElement | null;
    if (cleanModeInterval) {
      clearInterval(cleanModeInterval);
      cleanModeInterval = null;
    }
    if (clean) {
      injectCleanCSS(iframe);
      // 持續每 200ms 補注入（seek/快轉重建 iframe DOM 後也維持乾淨）
      cleanModeInterval = setInterval(() => {
        injectCleanCSS(container.querySelector('iframe') as HTMLIFrameElement | null);
      }, 200);
    } else {
      removeCleanCSS(iframe);
    }
  }

  // 等 Replayer iframe 有 contentDocument 後套用預設（乾淨模式開啟）
  const waitAndApply = () => {
    const iframe = container.querySelector('iframe') as HTMLIFrameElement | null;
    if (iframe?.contentDocument) applyCleanMode(checkbox.checked);
    else window.setTimeout(waitAndApply, 200);
  };
  window.setTimeout(waitAndApply, 500);

  // 切換：更新標籤文字 + 套用
  checkbox.addEventListener('change', () => {
    const label = checkbox.nextElementSibling as HTMLElement | null;
    if (label) label.textContent = checkbox.checked ? '🧹 乾淨模式' : '📋 原始模式';
    applyCleanMode(checkbox.checked);
  });

  // 頁面卸載時清掉 interval
  window.addEventListener('beforeunload', () => {
    if (cleanModeInterval) clearInterval(cleanModeInterval);
  });
}

function addMarker(sec: number) {
  // PM-29：按 📌 立刻彈原生對話框問描述，使用者一定看得到
  const note = window.prompt(`📌 ${formatSec(sec)} — 描述這個時間點的問題：`) ?? '';
  markers.push({ time_sec: sec, note: note.trim() }); // 按取消 → 空描述，只留時間點
  renderMarkers();
}

function renderMarkers() {
  const list = document.getElementById('markerList');
  if (!list) return;
  list.replaceChildren();
  markers.sort((a, b) => a.time_sec - b.time_sec);
  markers.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'marker-item';

    const timeBtn = document.createElement('span');
    timeBtn.className = 'marker-time';
    timeBtn.textContent = formatSec(m.time_sec);
    timeBtn.title = '點擊跳到此時間';
    timeBtn.addEventListener('click', () => {
      if (!replayer) return;
      replayer.play(m.time_sec * 1000);
      window.setTimeout(() => replayer?.pause(m.time_sec * 1000), 50);
      updateTimeDisplay(m.time_sec * 1000);
    });

    const noteInput = document.createElement('input');
    noteInput.className = 'marker-note';
    noteInput.type = 'text';
    noteInput.placeholder = '描述這個時間點的問題...';
    noteInput.value = m.note;
    noteInput.addEventListener('input', () => {
      m.note = noteInput.value;
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'marker-delete';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => {
      markers.splice(i, 1);
      renderMarkers();
    });

    item.append(timeBtn, noteInput, delBtn);
    list.appendChild(item);
  });
}

function formatSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateTimeDisplay(ms: number) {
  const el = document.getElementById('markerTime');
  if (el)
    el.textContent = `${formatSec(Math.floor(ms / 1000))} / ${formatSec(Math.floor(duration / 1000))}`;
  const seekBar = $opt<HTMLInputElement>('markerSeek');
  if (seekBar) seekBar.value = String(ms);
}

function trackProgress() {
  if (!playing || !replayer) return;
  const current = replayer.getCurrentTime();
  updateTimeDisplay(current);
  if (current < duration) {
    requestAnimationFrame(trackProgress);
  } else {
    playing = false;
    const playBtn = $opt('markerPlayBtn');
    if (playBtn) playBtn.textContent = '▶';
  }
}

// ── 語音輸入（補充說明用）────────────────────────────────
interface SRAlt {
  readonly transcript: string;
}
interface SRRes {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [i: number]: SRAlt;
}
interface SREvt {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [i: number]: SRRes };
}
interface SRErr {
  readonly error: string;
}
interface SRInst {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SREvt) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: SRErr) => void) | null;
  start(): void;
  stop(): void;
}
type SRCtor = new () => SRInst;

const win = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
const SR = win.SpeechRecognition || win.webkitSpeechRecognition;
let recognition: SRInst | null = null;
let listening = false;

function stopVoice() {
  listening = false;
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* 忽略 */
    }
    recognition = null;
  }
  voiceBtn.classList.remove('listening');
  voiceBtn.textContent = '🎤';
  voiceStatus.textContent = '';
}

// PM-42：套用 inject.ts PM-32/33 的穩定模式——工廠建全新實例 + onend 失敗計數。
let autoRestartFails = 0;

function createEditRecognition(): SRInst | null {
  if (!SR) return null;
  const rec = new SR();
  rec.lang = srLang; // PM-215：跟隨 popup 語言（zh-TW / yue-Hant-HK / en-US）
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (e: SREvt) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) {
        // PM-31 Bug4：append 到末端，但若 cursor 原本不在末端則保留原位（不干擾中間編輯）
        const cursorPos = descInput.selectionStart;
        const isAtEnd = cursorPos === descInput.value.length;
        descInput.value += res[0].transcript;
        if (!isAtEnd) {
          descInput.selectionStart = cursorPos;
          descInput.selectionEnd = cursorPos;
        }
      } else {
        interim = res[0].transcript;
      }
    }
    voiceStatus.textContent = interim ? `🔴 ${interim}` : T('er-listening');
  };

  rec.onend = () => {
    if (listening) {
      try {
        rec.start();
        autoRestartFails = 0; // 成功歸零
      } catch {
        autoRestartFails++;
        if (autoRestartFails >= 3) {
          // PM-43：連續失敗 3 次 → getUserMedia 刷新音訊管線 + 建全新實例重啟
          void (async () => {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              stream.getTracks().forEach((t) => t.stop());
              await new Promise((r) => setTimeout(r, 300));
              if (!listening) return; // 期間使用者已停止
              recognition = createEditRecognition();
              if (recognition) {
                recognition.start();
                autoRestartFails = 0;
                voiceStatus.textContent = T('er-restarted');
              }
            } catch {
              voiceStatus.textContent = T('er-voice-interrupted');
              stopVoice();
            }
          })();
        }
      }
    }
  };

  rec.onerror = (e: SRErr) => {
    voiceStatus.textContent = `${T('er-voice-error')}${e.error}`;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') stopVoice();
  };

  return rec;
}

voiceBtn.addEventListener('click', async () => {
  if (!SR) {
    voiceStatus.textContent = T('er-no-sr');
    return;
  }
  if (listening) {
    stopVoice();
    return;
  }

  // PM-42：先用 getUserMedia 刷新音訊管線（edit-report 是 extension page，非 user-gesture 問題）
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    voiceStatus.textContent = T('er-no-mic');
    return;
  }

  autoRestartFails = 0;
  recognition = createEditRecognition();
  if (recognition) {
    recognition.start();
    listening = true;
    voiceBtn.classList.add('listening');
    voiceBtn.textContent = '⏹';
    voiceStatus.textContent = T('er-listening');
  }
});

// PM-49：鍵盤模式 → 隱藏補充說明的 🎤 按鈕
chrome.storage.local.get(KEYBOARD_MODE_KEY, (r) => {
  if (r[KEYBOARD_MODE_KEY] === true) {
    voiceBtn.style.display = 'none';
    voiceStatus.textContent = T('er-keyboard');
  }
});

// ── AI 校正（PM-60）：修語音辨識錯字/贅字/術語，保留原意，可多次按（不鎖死）──
correctBtn.addEventListener('click', async () => {
  const text = voiceText.value.trim();
  if (!text) return;

  correctBtn.disabled = true;
  correctBtn.textContent = T('er-correcting');
  try {
    const res = await fetch(`${API_BASE}/api/correct`, {
      method: 'POST',
      headers: await getAuthHeaders(), // PM-135：帶 session token（需登入）
      body: JSON.stringify({ text, language: reportLang }), // PM-217：帶語言切 prompt
    });
    const data = (await res.json()) as { corrected?: string };
    if (data.corrected) {
      voiceText.value = data.corrected;
      correctBtn.textContent = T('er-corrected');
    } else {
      correctBtn.textContent = T('er-correct-fail');
    }
  } catch (err) {
    blog('AI 校正失敗', err);
    correctBtn.textContent = T('er-correct-fail');
  }
  // 3 秒後恢復（校正可多次微調，不像 AI 精簡那樣永久鎖死）
  setTimeout(() => {
    correctBtn.disabled = false;
    correctBtn.textContent = T('er-ai-correct');
  }, 3000);
});

// ── AI 精簡：把語音記錄精簡成重點，替換語音記錄欄（成功後永久 disable）──
summarizeBtn.addEventListener('click', async () => {
  const text = voiceText.value.trim();
  if (!text || text.length < 10) {
    voiceStatus.textContent = T('er-too-short');
    return;
  }
  summarizeBtn.disabled = true;
  summarizeBtn.textContent = T('er-summarizing');
  try {
    const res = await fetch(`${API_BASE}/api/summarize`, {
      method: 'POST',
      headers: await getAuthHeaders(), // PM-135：帶 session token（需登入）
      body: JSON.stringify({ text, language: reportLang }), // PM-217：帶語言切 prompt
    });
    const data = (await res.json()) as { summary?: string };
    if (data.summary) {
      voiceText.value = data.summary;
      summarizeBtn.textContent = T('er-summarized');
      summarizeBtn.classList.add('done');
      summarizeBtn.disabled = true; // 永久 disable，不可再按
      blog('AI 精簡完成 → 替換語音記錄');
      return; // 跳過 finally 的重新啟用
    } else {
      summarizeBtn.textContent = T('er-fail');
    }
  } catch (err) {
    blog('AI 精簡失敗', err);
    summarizeBtn.textContent = T('er-fail');
  }
  // 只有失敗才重新啟用（成功已 return）
  setTimeout(() => {
    summarizeBtn.textContent = T('er-ai-summarize');
    summarizeBtn.classList.remove('done');
    summarizeBtn.disabled = false;
  }, 3000);
});

// ── 上傳 / 捨棄 ───────────────────────────────────────────
// PM-209：上傳成功 UI（✅ 已上傳 + 分享連結 + 📋 複製鈕）。錄製與截圖報告共用同一成功路徑。
async function showUploadSuccess(shareUrl: string) {
  blog('報告上傳完成', shareUrl);
  result.classList.remove('hidden');
  result.replaceChildren(T('er-uploaded'));
  const a = document.createElement('a');
  a.href = shareUrl;
  a.target = '_blank';
  a.textContent = shareUrl;
  result.appendChild(a);
  // PM-199：分享連結旁加「📋」複製按鈕（hidden input + select + execCommand，不用 clipboard API）
  const copyInput = document.createElement('input');
  copyInput.type = 'text';
  copyInput.readOnly = true;
  copyInput.value = shareUrl;
  // 保持可選取但視覺上不佔位（execCommand 需元素在視窗內且可 select，故非 display:none/離屏）
  copyInput.style.cssText =
    'position:absolute;width:1px;height:1px;padding:0;border:0;opacity:0;left:0;top:0;';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = '📋';
  copyBtn.title = T('er-copy-link');
  copyBtn.style.cssText =
    'margin-left:8px;background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:2px 8px;font-size:13px;cursor:pointer;vertical-align:middle;';
  copyBtn.addEventListener('click', () => {
    copyInput.select();
    copyInput.setSelectionRange(0, shareUrl.length);
    try {
      document.execCommand('copy');
    } catch {
      /* 極少數環境不支援，靜默略過 */
    }
    copyBtn.textContent = '✅';
    setTimeout(() => {
      copyBtn.textContent = '📋';
    }, 2000);
  });
  result.appendChild(copyInput);
  result.appendChild(copyBtn);
  uploadBtn.textContent = T('er-upload-done');
  discardBtn.textContent = T('er-close');
  await chrome.storage.local.remove(STORAGE_KEY); // 上傳後清本機 payload
}

// PM-209：截圖報告上傳成功後按鈕卡在「上傳中」修復——
//   原因：`await sendMessage` 無 try/catch 且 `resp` 未防呆；截圖 payload 較大、round-trip 較久，
//   一旦訊息通道關閉導致 sendMessage reject 或 resolve 成 undefined，`resp.ok` 直接 throw，
//   handler 中斷 → 按鈕永遠停在「⏳ 上傳中...」。修法：try/catch + `resp?.ok` 防呆，任何失敗都復原按鈕。
uploadBtn.addEventListener('click', async () => {
  stopVoice();
  uploadBtn.disabled = true;
  uploadBtn.textContent = T('er-uploading');
  let resp: { ok: boolean; shareUrl?: string; error?: string } | undefined;
  try {
    resp = (await chrome.runtime.sendMessage({
      type: 'UPLOAD_REPORT',
      description: descInput.value.trim(),
      markers, // PM-29：保留所有標記（含無文字的，時間點本身就有價值）
    } satisfies ControlMessage)) as { ok: boolean; shareUrl?: string; error?: string } | undefined;
  } catch (err) {
    blog('UPLOAD_REPORT 訊息傳遞失敗', err);
  }

  if (resp?.ok && resp.shareUrl) {
    await showUploadSuccess(resp.shareUrl);
  } else {
    result.classList.remove('hidden');
    result.textContent = `${T('er-upload-fail')}${resp?.error ?? T('er-unknown-err')}`;
    uploadBtn.disabled = false;
    uploadBtn.textContent = T('er-upload');
  }
});

discardBtn.addEventListener('click', async () => {
  stopVoice();
  await chrome.storage.local.remove([STORAGE_KEY, STATE_KEY]);
  window.close();
});
