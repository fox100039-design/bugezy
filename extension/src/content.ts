// content.ts — 在 ISOLATED world 執行
// 橋接：background（chrome API）<->  inject.ts（MAIN world，window.postMessage）
// 自己不錄製，只負責轉送指令與打包資料。
//
// PM-04：加診斷 log，確認雙向 postMessage 通訊是否跑通。

import {
  BUGEZY_SOURCE,
  KEYBOARD_MODE_KEY,
  LANG_KEY,
  MIC_KEY,
  MIC_MODE_KEY,
  SPEECH_LANG_MAP,
  STORAGE_KEY,
  TOOLBAR_EFFECT_KEY,
  USER_PLAN_KEY,
  blog,
  type ConsoleLog,
  type ControlMessage,
  type InjectCommand,
  type InjectMessage,
  type NetworkError,
  type RecordingPayload,
  type RecordingSummary,
  type StateResponse,
} from './types';
import { t, getUILang, type UILang } from './i18n';

blog('content loaded（ISOLATED world）', location.href);

// PM-139：把語言設定注入 DOM（data-bugezy-lang），讓 MAIN world 的 inject.ts 讀得到（它沒有 chrome.storage）。
// 同時快取一份 UI 語言供 content 自己的截圖工具列翻譯用。
let contentUILang: UILang = 'zh';
function ct(key: string, params?: Record<string, string | number>): string {
  return t(key, contentUILang, params);
}
function applyBugezyLang(speechLang: string) {
  document.documentElement.setAttribute('data-bugezy-lang', speechLang);
  contentUILang = getUILang(speechLang);
}

// PM-193：精準轉錄麥克風失敗 → 頁面頂部橘色提示條（8 秒後移除）。content 與頁面共用 DOM，直接建節點。
function showMicFallbackTip() {
  document.getElementById('bugezy-mic-fallback-tip')?.remove();
  const tip = document.createElement('div');
  tip.id = 'bugezy-mic-fallback-tip';
  tip.style.cssText =
    'position:fixed;top:0;left:0;right:0;background:#f59e0b;color:#000;text-align:center;padding:10px;font-size:13px;font-weight:600;z-index:2147483647;font-family:system-ui,-apple-system,"Microsoft JhengHei",sans-serif;';
  tip.textContent = ct('mic-fallback-tip'); // i18n 值已含 ⚠️
  document.body.prepend(tip);
  setTimeout(() => tip.remove(), 8000);
}
void chrome.storage.local.get(LANG_KEY, (r) => applyBugezyLang((r[LANG_KEY] as string) || 'zh'));
// 使用者在 popup 改語言 → 即時更新 DOM attr（開著的頁面也跟著切）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[LANG_KEY]) {
    applyBugezyLang((changes[LANG_KEY].newValue as string) || 'zh');
  }
});

let injectReady = false;

function sendToInject(
  cmd: 'START' | 'STOP' | 'REWIND' | 'GET_LIVE_ERRORS' | 'SHOW_MONITOR' | 'HIDE_MONITOR',
  keyboardMode?: boolean,
  micEnabled?: boolean,
  whisperMode?: boolean,
  speechLang?: string,
) {
  const msg: InjectCommand = {
    source: BUGEZY_SOURCE,
    dir: 'to-inject',
    cmd,
    keyboardMode,
    micEnabled,
    whisperMode,
    speechLang,
  };
  blog(
    `→ 轉送 ${cmd} 給 inject（keyboardMode=${keyboardMode === true}, micEnabled=${micEnabled === true}, whisperMode=${whisperMode === true}）`,
  );
  window.postMessage(msg, '*');
}

/** PM-87/91：算出本次錄製的語音旗標。mic OFF → 都不錄；免費版→即時字幕(useOldVoice)；
 *  付費版依 MIC_MODE_KEY：realtime→即時字幕、whisper→Whisper 錄音 bar（不啟 SpeechRecognition）。 */
async function computeStartFlags(): Promise<{
  keyboardMode: boolean;
  useOldVoice: boolean;
  whisperMode: boolean;
  speechLang: string;
}> {
  const r = await chrome.storage.local.get([
    KEYBOARD_MODE_KEY,
    MIC_KEY,
    USER_PLAN_KEY,
    MIC_MODE_KEY,
    LANG_KEY,
  ]);
  const keyboardMode = r[KEYBOARD_MODE_KEY] === true;
  // PM-137：Web Speech BCP-47 語碼（inject 在 MAIN world 無 chrome.storage，由此帶入）
  const speechLang = SPEECH_LANG_MAP[(r[LANG_KEY] as string) || 'zh'] || 'zh-TW';
  const micEnabled = r[MIC_KEY] === true; // PM-90：預設關閉
  if (!micEnabled) return { keyboardMode, useOldVoice: false, whisperMode: false, speechLang };
  const plan = (r[USER_PLAN_KEY] as string) || 'free';
  const mode = plan === 'free' ? 'realtime' : (r[MIC_MODE_KEY] as string) || 'whisper';
  return {
    keyboardMode,
    useOldVoice: mode === 'realtime',
    whisperMode: mode === 'whisper',
    speechLang,
  };
}

function summarize(payload: RecordingPayload): RecordingSummary {
  return {
    domEvents: payload.rrwebEvents.length,
    consoleLogs: payload.consoleLogs.length,
    networkErrors: payload.networkErrors.length,
    pageInfo: payload.pageInfo,
    durationMs: 0, // 由 background 依 startedAt 回填
    voiceSegments: payload.voiceTranscript.length,
    uploadStatus: 'idle', // 由 background RECORDING_DONE 後接手上傳
    shareUrl: null,
    uploadError: null,
  };
}

// inject.ts 的回報訊息（READY / STARTED / RESULT）
window.addEventListener('message', async (e: MessageEvent) => {
  if (e.source !== window) return;
  const data = e.data as InjectMessage;
  if (!data || data.source !== BUGEZY_SOURCE || data.dir !== 'to-content') return;

  // PM-34：即時 flush 訊息 → 轉發給 background 暫存到 chrome.storage.local
  if (data.kind === 'FLUSH_VOICE') {
    chrome.runtime.sendMessage({ type: 'FLUSH_VOICE', segment: data.segment });
    return;
  }
  if (data.kind === 'FLUSH_CONSOLE') {
    chrome.runtime.sendMessage({ type: 'FLUSH_CONSOLE', log: data.log });
    return;
  }
  if (data.kind === 'FLUSH_NETWORK') {
    chrome.runtime.sendMessage({ type: 'FLUSH_NETWORK', error: data.error });
    return;
  }
  if (data.kind === 'FLUSH_RRWEB') {
    chrome.runtime.sendMessage({ type: 'FLUSH_RRWEB', events: data.events });
    return;
  }

  // PM-36：inject 要歷史語音 → 跟 background 拿 buffer → 回填給 inject（to-inject）
  if (data.kind === 'REQUEST_VOICE_HISTORY') {
    chrome.runtime.sendMessage({ type: 'GET_VOICE_BUFFER' }, (response) => {
      const segments = (response as { segments?: unknown[] } | undefined)?.segments;
      if (segments && segments.length > 0) {
        window.postMessage(
          { source: BUGEZY_SOURCE, dir: 'to-inject', kind: 'VOICE_HISTORY', segments },
          '*',
        );
      }
    });
    return;
  }

  if (data.kind === 'READY') {
    injectReady = true;
    blog('✓ inject 已報到（READY）');
    // PM-37：回 ACK 讓 inject 停止重複發 READY（解載入順序競爭）
    window.postMessage({ source: BUGEZY_SOURCE, dir: 'to-inject', kind: 'READY_ACK' }, '*');
    return;
  }

  if (data.kind === 'STARTED') {
    blog(`✓ inject 已開始錄製（rrwebOk=${data.rrwebOk}）`);
    return;
  }

  if (data.kind === 'RESULT') {
    const payload = data.payload;
    // 不再需要合併語音 — inject 已自帶 voiceTranscript（MAIN world 直接收音）
    blog('✓ 收到 inject 打包資料', {
      dom: payload.rrwebEvents.length,
      console: payload.consoleLogs.length,
      network: payload.networkErrors.length,
      voice: payload.voiceTranscript.length,
    });
    chrome.storage.local.set({ [STORAGE_KEY]: payload }, () => {
      chrome.runtime.sendMessage({ type: 'RECORDING_DONE', summary: summarize(payload) });
    });
  }

  // PM-124：即時監控 error panel 上傳報告——inject 打包 payload → 這裡轉給 background 上傳，
  // 拿到 share_url 後回傳給 inject 更新按鈕（inject 在 MAIN world 無 chrome.runtime，故經此橋接）。
  if (data.kind === 'UPLOAD_MONITOR') {
    chrome.runtime.sendMessage(
      { type: 'UPLOAD_MONITOR_REPORT', payload: data.payload } satisfies ControlMessage,
      (resp: { ok?: boolean; shareUrl?: string; error?: string } | undefined) => {
        window.postMessage(
          {
            source: BUGEZY_SOURCE,
            dir: 'to-inject',
            kind: 'MONITOR_UPLOADED',
            reportUrl: resp?.shareUrl,
            error: resp?.ok ? undefined : (resp?.error ?? '上傳失敗'),
          } satisfies InjectMessage,
          '*',
        );
      },
    );
  }

  // PM-50：⏪ 回溯打包結果 → 存 storage 後通知 background 開編輯頁
  if (data.kind === 'REWIND_RESULT') {
    const payload = data.payload;
    blog('✓ 收到 REWIND 打包資料', {
      dom: payload.rrwebEvents.length,
      console: payload.consoleLogs.length,
      network: payload.networkErrors.length,
    });
    chrome.storage.local.set({ [STORAGE_KEY]: payload }, () => {
      chrome.runtime.sendMessage({ type: 'REWIND_DONE', summary: summarize(payload) });
    });
  }
});

/**
 * PM-308：bridge 的 `click_element` 用。
 *
 * 幾個「靜默成功」的陷阱——這些情況 `el.click()` **不會拋錯，只是什麼都沒發生**，
 * 若照實回 `clicked: true`，AI 會以為點成功了，然後對著沒有反應的頁面繼續往下推理：
 *   · `disabled` 的 button / input
 *   · `display:none`、`visibility:hidden`、尺寸為 0 的元素
 *   · 沒有 `click()` 方法的節點（例如純 SVG 以外的非 HTMLElement）
 * 因此一律先檢查再點，並把不能點的原因講清楚。
 */
function bridgeClick(selector: string): Record<string, unknown> {
  if (typeof selector !== 'string' || !selector.trim()) {
    return { error: '缺少 selector 參數' };
  }
  let el: Element | null;
  try {
    el = document.querySelector(selector);
  } catch {
    // querySelector 對不合法的選擇器會丟 SyntaxError
    return { error: `不是合法的 CSS 選擇器：${selector}` };
  }
  if (!el) {
    return {
      error: `找不到符合「${selector}」的元素`,
      hint: '該元素可能尚未載入、位於 iframe 內（content script 只跑在最上層框架），或選擇器有誤。可先用 read_page 確認頁面上實際有哪些元素。',
    };
  }

  const tag = el.tagName.toLowerCase();
  // 先把描述資訊取好再點——點擊可能觸發導航，之後頁面就沒了
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);

  if ((el as HTMLInputElement).disabled) {
    return { error: `元素「${selector}」是 disabled 狀態，點了不會有任何反應`, tag, text };
  }
  // 用與 read_page 相同的 isElementVisible：它優先走 `checkVisibility()`，
  // 而 **`getComputedStyle` 只看元素自己**——父層 `display:none` 時，子元素的
  // computed display 仍然是 `block`（Chrome 也一樣），單看自己的樣式抓不到「被祖先隱藏」。
  if (!isElementVisible(el)) {
    return { error: `元素「${selector}」目前不可見（display/visibility/opacity 或其祖先被隱藏），點了不會有任何反應`, tag, text };
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return { error: `元素「${selector}」的尺寸為 0（不佔版面），點了不會有任何反應`, tag, text };
  }
  if (typeof (el as HTMLElement).click !== 'function') {
    return { error: `元素「${selector}」（<${tag}>）沒有 click() 方法，無法點擊`, tag, text };
  }

  (el as HTMLElement).click();
  return { clicked: true, tag, text };
}

// ── PM-311：type_text ──────────────────────────────────────────────────────
/** 這些 input type 不吃文字，硬寫 value 只會靜默無效（file 甚至會被瀏覽器擋下）。 */
const TYPE_TEXT_REJECTED_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'range', 'color',
]);

/** 敏感欄位的值不回傳原文，避免密碼／token 進到 AI 的 context（同 PM-309）。 */
function maskFieldValue(el: Element, value: string): string {
  if (!value) return '';
  const t = (el as HTMLInputElement).type;
  return t === 'password' || isSensitiveField(el) ? '<已遮蔽：敏感欄位>' : value;
}

/**
 * PM-311：bridge 的 `type_text`。
 *
 * 🔴 **不能只做 `el.value = text` 再 dispatch 事件**——React 會在 input 上掛一個
 *   內部的 `_valueTracker`，直接指定 `.value` 不會更新它，於是 React 收到 input 事件時
 *   比對「值沒變」就**整個忽略**：畫面上文字出現了，但 React state 完全沒動，
 *   接著送出表單會送出空值。**這是典型的假成功**，而且從回傳值上看不出來。
 *   正解是透過原型上的 **原生 value setter** 寫入，繞過 tracker，再 dispatch 事件。
 */
function bridgeTypeText(selector: string, text: string): Record<string, unknown> {
  if (typeof selector !== 'string' || !selector.trim()) return { error: '缺少 selector 參數' };
  if (typeof text !== 'string') return { error: 'text 必須是字串' };

  let el: Element | null;
  try {
    el = document.querySelector(selector);
  } catch {
    return { error: `不是合法的 CSS 選擇器：${selector}` };
  }
  if (!el) {
    return {
      error: `找不到符合「${selector}」的元素`,
      hint: '該元素可能尚未載入、位於 iframe 內（content script 只跑在最上層框架），或選擇器有誤。可先用 read_page 確認頁面上實際有哪些元素。',
    };
  }

  const tag = el.tagName.toLowerCase();
  const editable = el.getAttribute('contenteditable');
  const isCE = editable !== null && editable !== 'false';
  const isInput = tag === 'input';
  const isTextarea = tag === 'textarea';
  if (!isInput && !isTextarea && !isCE) {
    return { error: `元素「${selector}」是 <${tag}>，不是可輸入的欄位（需要 input / textarea / contenteditable）`, tag };
  }

  const input = el as HTMLInputElement | HTMLTextAreaElement;
  if (isInput) {
    const t = (input as HTMLInputElement).type;
    if (TYPE_TEXT_REJECTED_INPUT_TYPES.has(t)) {
      return {
        error: `元素「${selector}」是 <input type="${t}">，不接受文字輸入${t === 'file' ? '（瀏覽器基於安全性禁止用程式設定檔案欄位）' : t === 'checkbox' || t === 'radio' ? '（要改變勾選狀態請用 click_element）' : ''}`,
        tag,
      };
    }
  }

  // disabled 與 readonly 分開報——AI 需要知道是「不能用」還是「只能看」，兩者的下一步不同
  if (!isCE && input.disabled) {
    return { error: `元素「${selector}」是 disabled 狀態，無法輸入`, tag };
  }
  if (!isCE && input.readOnly) {
    return { error: `元素「${selector}」是 readonly 狀態，無法輸入（欄位存在但不允許修改）`, tag };
  }
  if (!isElementVisible(el)) {
    return { error: `元素「${selector}」目前不可見（display/visibility/opacity 或其祖先被隱藏），輸入不會有任何效果`, tag };
  }

  const previous = isCE ? (el.textContent ?? '') : input.value;

  try {
    (el as HTMLElement).focus?.();
  } catch {
    /* focus 失敗不影響輸入 */
  }

  if (isCE) {
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  } else {
    // 繞過 React 的 _valueTracker：用原型上的原生 setter 寫入（見上方說明）
    const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, text);
    else input.value = text; // 理論上不會走到，但不要因此整個失敗
    // bubbles 必須為 true：React 用的是掛在 root 的委派監聽，不冒泡就收不到
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const now = isCE ? (el.textContent ?? '') : input.value;
  return {
    typed: true,
    tag,
    previous_value: maskFieldValue(el, previous),
    new_value: maskFieldValue(el, now),
    // 寫進去之後再讀一次確認——有些欄位有 maxlength 或輸入遮罩，會把值改掉
    value_matches: now === text,
  };
}

// ── PM-330／331：圖釘系統（依 PM-329 設計）──────────────────────────────────
//
// 圖釘存在 **content script 的模組變數**裡：content script 本來就每個分頁一份，
// 分頁隔離天然成立，不需要另存 tab_id。分頁關閉／重整 → 圖釘消失是**正確語意**
// （圖釘綁的是「這一頁的這個元素」，頁面沒了就沒有指涉對象）。
//
// ⚠ 不放 background 的 Map：MV3 service worker 閒置 30 秒被回收，Map 會一起消失（PM-298 的坑）。
// ⚠ 不放 chrome.storage.session：頁面重整後 selector 可能指向不同元素，
//   復原一個指向錯元素的圖釘，比讓它消失更糟。

interface Pin {
  id: string;
  selector: string;
  description: string;
  status: 'active' | 'warning' | 'error' | 'stale';
  created_at: number;
  last_check: { at: number; summary: string } | null;
}

const pins = new Map<string, Pin>();
let pinSeq = 0;
let pinLayer: HTMLElement | null = null;
let pinRepositionQueued = false;

const PIN_STATUS_COLOR: Record<Pin['status'], string> = {
  active: '#22c55e',
  warning: '#eab308',
  error: '#ef4444',
  stale: '#6b7280',
};

/** 建立（或取得）覆蓋層容器。**一律用 DOM API，不用 innerHTML** —— Trusted Types 網站會擋掉字串賦值（PM-69）。 */
function ensurePinLayer(): HTMLElement {
  if (pinLayer && pinLayer.isConnected) return pinLayer;
  const el = document.createElement('div');
  el.setAttribute('data-bugezy-pins', '1');
  Object.assign(el.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483646',
    pointerEvents: 'none', // 讓點擊穿透到頁面
  } as CSSStyleDeclaration);
  document.documentElement.appendChild(el);
  pinLayer = el;
  return el;
}

/** 重畫所有圖釘的位置。滾動／resize 時用 rAF 節流。 */
function repositionPins(): void {
  if (!pins.size) return;
  const layer = ensurePinLayer();
  while (layer.firstChild) layer.removeChild(layer.firstChild);
  for (const pin of pins.values()) {
    let el: Element | null = null;
    try {
      el = document.querySelector(pin.selector);
    } catch {
      el = null;
    }
    if (!el) {
      pin.status = 'stale'; // 元素不見了 → 失去目標，但不刪除（AI 需要知道）
      continue;
    }
    const r = el.getBoundingClientRect();
    const dot = document.createElement('div');
    Object.assign(dot.style, {
      position: 'absolute',
      left: `${Math.max(0, r.left - 6)}px`,
      top: `${Math.max(0, r.top - 6)}px`,
      width: '14px',
      height: '14px',
      borderRadius: '50%',
      background: PIN_STATUS_COLOR[pin.status],
      border: '2px solid #fff',
      boxShadow: '0 1px 4px rgba(0,0,0,.4)',
      pointerEvents: 'auto', // 只有圓點可點（PM-304 的結論：整層 none 就收不到點擊）
      cursor: 'help',
    } as CSSStyleDeclaration);
    dot.title = `📌 ${pin.description || '(無描述)'}
${pin.selector}
狀態：${pin.status}`;
    layer.appendChild(dot);
  }
}

function queueReposition(): void {
  if (pinRepositionQueued) return;
  pinRepositionQueued = true;
  requestAnimationFrame(() => {
    pinRepositionQueued = false;
    repositionPins();
  });
}
window.addEventListener('scroll', queueReposition, { passive: true });
window.addEventListener('resize', queueReposition, { passive: true });

function findPinBySelector(selector: string): Pin | undefined {
  for (const p of pins.values()) if (p.selector === selector) return p;
  return undefined;
}

function bridgePinElement(selector: string, description: string): Record<string, unknown> {
  if (typeof selector !== 'string' || !selector.trim()) return { error: '缺少 selector 參數' };
  let el: Element | null;
  try {
    el = document.querySelector(selector);
  } catch {
    return { error: `不是合法的 CSS 選擇器：${selector}` };
  }
  if (!el) {
    return {
      error: `找不到符合「${selector}」的元素`,
      hint: '該元素可能尚未載入、位於 iframe 內（content script 只跑在最上層框架），或選擇器有誤。可先用 read_page 確認頁面上實際有哪些元素。',
    };
  }

  // 同一 selector 重複釘 → **更新描述，回原本的 pin_id**（不建立第二個）
  const existing = findPinBySelector(selector);
  const pin: Pin = existing ?? {
    id: `pin${++pinSeq}-${Date.now().toString(36)}`,
    selector,
    description: '',
    status: 'active',
    created_at: Date.now(),
    last_check: null,
  };
  if (typeof description === 'string' && description) pin.description = description;
  pins.set(pin.id, pin);
  queueReposition();

  return {
    pin_id: pin.id,
    selector,
    description: pin.description,
    element_found: true,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
    updated_existing: !!existing,
  };
}

function bridgePinAnalyze(selector: string): Record<string, unknown> {
  // 先確保有圖釘（沒有就自動建立）
  const pinned = bridgePinElement(selector, '');
  if (typeof pinned.error === 'string') return pinned;
  const pin = pins.get(String(pinned.pin_id));
  if (!pin) return { error: '建立圖釘失敗' };
  if (!pin.description) pin.description = 'pin_analyze 自動建立';

  // **直接複用 analyze_element 的分析，不另寫一套**
  const analysis = bridgeAnalyzeElement(selector);
  if (typeof analysis.error === 'string') {
    pin.status = 'stale';
    pin.last_check = { at: Date.now(), summary: String(analysis.error) };
    queueReposition();
    return { pin_id: pin.id, selector, status: pin.status, error: analysis.error };
  }

  // status 只用 analyze_element 已算出的資訊推導，**不引入新的錯誤來源**
  const vis = analysis.visibility as { visible?: boolean; has_size?: boolean } | undefined;
  const attrs = (analysis.attributes ?? {}) as Record<string, string>;
  const problems: string[] = [];
  if (!vis?.visible) problems.push('元素不可見');
  if (!vis?.has_size) problems.push('尺寸為 0');
  if ('disabled' in attrs) problems.push('disabled');
  pin.status = problems.length ? 'warning' : 'active';
  pin.last_check = {
    at: Date.now(),
    summary: problems.length ? `⚠ ${problems.join('、')}` : '✅ 可見且可互動',
  };
  queueReposition();

  return { pin_id: pin.id, selector, status: pin.status, summary: pin.last_check.summary, analysis };
}

function bridgeGetPinResults(): Record<string, unknown> {
  repositionPins(); // 順便重算，讓 stale 狀態即時更新
  return {
    pins: [...pins.values()].map((p) => ({
      pin_id: p.id,
      selector: p.selector,
      description: p.description,
      status: p.status,
      created_at: p.created_at,
      last_check: p.last_check,
    })),
    total_count: pins.size,
    // 無圖釘時回**空陣列**而不是 error（驗收條件 3）
    ...(pins.size === 0 ? { note: '這個分頁目前沒有任何圖釘。用 pin_element 或 pin_analyze 建立。' } : {}),
  };
}

// ── PM-317：get_page_health ────────────────────────────────────────────────
/** 這些 input type 沒有標籤是正常的，不該算成可及性問題。 */
const HEALTH_UNLABELLED_OK_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

function countInputsWithoutLabel(): number {
  const fields = Array.from(document.querySelectorAll('input, select, textarea'));
  return fields.filter((f) => {
    const t = (f as HTMLInputElement).type;
    if (f.tagName === 'INPUT' && HEALTH_UNLABELLED_OK_TYPES.has(t)) return false;
    // 有這幾種任何一種就算有標籤——只查 <label for> 會產生大量誤報
    if (f.getAttribute('aria-label') || f.getAttribute('aria-labelledby') || f.getAttribute('title')) return false;
    if (f.id) {
      try {
        if (document.querySelector(`label[for="${CSS.escape(f.id)}"]`)) return false;
      } catch {
        /* id 內容導致 selector 不合法，當作沒找到 */
      }
    }
    if (f.closest('label')) return false; // 被 <label> 包起來也算
    return true;
  }).length;
}

/** 最大巢狀深度。用顯式堆疊而非遞迴，避免病態深度的頁面爆掉 call stack。 */
function domMaxDepth(): number {
  let max = 0;
  const stack: Array<[Element, number]> = [[document.documentElement, 1]];
  while (stack.length) {
    const [el, d] = stack.pop() as [Element, number];
    if (d > max) max = d;
    for (const c of Array.from(el.children)) stack.push([c, d + 1]);
  }
  return max;
}

async function bridgeGetPageHealth(): Promise<Record<string, unknown>> {
  // 直接呼叫同一組函式，**不繞回 bridge**（卡片要求，也少一次往返）
  const [{ consoleLogs, networkErrors }, wv] = await Promise.all([
    queryInjectLiveErrors(),
    bridgeGetWebVitals(),
  ]);

  const consoleErrors = consoleLogs.filter((c) => c.level !== 'info');
  const criticalCount = consoleErrors.filter((c) => c.level === 'error').length;

  // 🔴 `alt=""` 是**合法的**（表示裝飾性圖片，螢幕閱讀器應略過）。
  //    只計「沒有 alt 屬性」的，把 alt="" 也算成問題會在做得好的網站上狂噴誤報。
  const imagesWithoutAlt = document.querySelectorAll('img:not([alt])').length;
  const inputsWithoutLabel = countInputsWithoutLabel();
  const missingLang = !document.documentElement.getAttribute('lang');
  const missingTitle = !document.title.trim();

  const elementCount = document.querySelectorAll('*').length;

  const vitals = (wv.vitals ?? {}) as Record<string, { rating?: string } | null>;
  const ratingOf = (k: string): string | null => vitals[k]?.rating ?? null;
  // 只看真的有量到的指標——null（例如使用者還沒互動的 FID）不能算成失分，
  // 否則每個「還沒被點過」的頁面都會被扣分。
  const rated = ['LCP', 'FID', 'CLS', 'FCP', 'TTFB'].map(ratingOf).filter((r): r is string => r !== null);
  const poorCount = rated.filter((r) => r === 'poor').length;
  const niCount = rated.filter((r) => r === 'needs-improvement').length;

  const deductions = {
    console: Math.min(consoleErrors.length * 5, 30),
    network: Math.min(networkErrors.length * 5, 20),
    poor_vitals: poorCount * 10,
    needs_improvement_vitals: niCount * 5,
    images_without_alt: Math.min(imagesWithoutAlt * 2, 10),
    inputs_without_label: Math.min(inputsWithoutLabel * 3, 10),
    missing_lang: missingLang ? 5 : 0,
    large_dom: elementCount > 3000 ? 5 : 0,
  };
  const total = Object.values(deductions).reduce((a, b) => a + b, 0);
  const score = Math.max(0, Math.min(100, 100 - total));

  const a11yIssues = imagesWithoutAlt + inputsWithoutLabel + (missingLang ? 1 : 0) + (missingTitle ? 1 : 0);
  const bits: string[] = [];
  if (consoleErrors.length || networkErrors.length) {
    bits.push(`${consoleErrors.length + networkErrors.length} 個錯誤`);
  }
  if (poorCount) bits.push(`${poorCount} 項效能不合格`);
  else if (niCount) bits.push(`${niCount} 項效能待改進`);
  if (a11yIssues) bits.push(`${a11yIssues} 個可及性問題`);
  const summary = bits.length
    ? `${score} 分：${bits.join('、')}。`
    : `${score} 分：最近 30 秒內沒有錯誤，效能與可及性檢查皆通過。`;

  return {
    score,
    summary,
    details: {
      errors: {
        console_count: consoleErrors.length,
        network_count: networkErrors.length,
        critical_count: criticalCount,
      },
      performance: {
        lcp_rating: ratingOf('LCP'),
        fcp_rating: ratingOf('FCP'),
        cls_rating: ratingOf('CLS'),
        ttfb_rating: ratingOf('TTFB'),
      },
      accessibility: {
        images_without_alt: imagesWithoutAlt,
        inputs_without_label: inputsWithoutLabel,
        missing_lang: missingLang,
        missing_title: missingTitle,
      },
      dom: {
        element_count: elementCount,
        max_depth: domMaxDepth(),
        inline_styles_count: document.querySelectorAll('[style]').length,
        iframes_count: document.querySelectorAll('iframe').length,
      },
    },
    deductions,
    // 分數的錯誤部分沿用 inject 的 30 秒滾動緩存（同 get_browser_errors），
    // 不講明的話「100 分」會被讀成「這頁沒問題」，但可能只是錯誤已被裁掉。
    errors_window_seconds: 30,
    note: '錯誤統計只涵蓋最近 30 秒（頁面內滾動緩存）。要納入「載入當下」的錯誤，請先重新整理該分頁再呼叫。可及性檢查不含連結有效性（需實際發出請求，本工具不做）。',
  };
}

// ── PM-316：get_web_vitals ─────────────────────────────────────────────────
/** Google 官方門檻（good / needs-improvement 的上界）。 */
const VITAL_THRESHOLDS: Record<string, [number, number]> = {
  LCP: [2500, 4000],
  FID: [100, 300],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

function rateVital(name: string, value: number): 'good' | 'needs-improvement' | 'poor' {
  const t = VITAL_THRESHOLDS[name];
  if (!t) return 'good';
  return value <= t[0] ? 'good' : value <= t[1] ? 'needs-improvement' : 'poor';
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}
interface FirstInputEntry extends PerformanceEntry {
  processingStart: number;
}

/**
 * 蒐集 LCP / CLS / FID。
 *
 * ⚠ 這三個只能透過 `PerformanceObserver` 拿，而**工具被呼叫時事件早就發生過了**。
 *   關鍵是 `buffered: true` —— 它會把註冊之前就已產生的 entry 補送過來；
 *   少了它，這支工具在任何「載入完才呼叫」的情境下都只會回 null（也就是永遠）。
 */
function collectObservedVitals(): Promise<{ lcp: number | null; cls: number; fid: number | null }> {
  return new Promise((resolve) => {
    let lcp: number | null = null;
    let cls = 0;
    let fid: number | null = null;
    const observers: PerformanceObserver[] = [];
    const watch = (type: string, cb: (l: PerformanceObserverEntryList) => void) => {
      try {
        const o = new PerformanceObserver(cb);
        o.observe({ type, buffered: true });
        observers.push(o);
      } catch {
        /* 該瀏覽器不支援這個 entry type，略過即可 */
      }
    };
    watch('largest-contentful-paint', (l) => {
      const es = l.getEntries();
      const last = es[es.length - 1]; // 專案的 tsconfig lib 沒有 Array.prototype.at
      if (last) lcp = Math.round(last.startTime);
    });
    watch('layout-shift', (l) => {
      for (const e of l.getEntries() as LayoutShiftEntry[]) if (!e.hadRecentInput) cls += e.value;
    });
    watch('first-input', (l) => {
      const e = l.getEntries()[0] as FirstInputEntry | undefined;
      if (e) fid = Math.round(e.processingStart - e.startTime);
    });
    // buffered entry 在下一個 task 才送達，給它一點時間再收網
    setTimeout(() => {
      for (const o of observers) o.disconnect();
      resolve({ lcp, cls, fid });
    }, 300);
  });
}

function summarizeResources(): Record<string, unknown> {
  const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const buckets: Record<string, { count: number; size_kb: number }> = {
    script: { count: 0, size_kb: 0 },
    css: { count: 0, size_kb: 0 },
    image: { count: 0, size_kb: 0 },
    font: { count: 0, size_kb: 0 },
    other: { count: 0, size_kb: 0 },
  };
  let totalBytes = 0;
  let unknownSize = 0;
  for (const r of res) {
    const it = r.initiatorType;
    const key =
      it === 'script' ? 'script'
      : it === 'link' || it === 'css' ? 'css'
      : it === 'img' || it === 'image' ? 'image'
      : /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(r.name) ? 'font'
      : 'other';
    buckets[key].count++;
    const bytes = r.transferSize || 0;
    // transferSize 為 0 有兩種可能：快取命中，或**跨網域且對方沒送 Timing-Allow-Origin**。
    // 後者很常見（CDN、字型、分析腳本），不講明的話總大小會系統性低估。
    if (bytes === 0) unknownSize++;
    buckets[key].size_kb += bytes / 1024;
    totalBytes += bytes;
  }
  for (const k of Object.keys(buckets)) buckets[k].size_kb = Math.round(buckets[k].size_kb * 10) / 10;
  return {
    total_requests: res.length,
    total_size_kb: Math.round((totalBytes / 1024) * 10) / 10,
    by_type: buckets,
    size_unknown_count: unknownSize,
    ...(unknownSize
      ? {
          size_note: `${unknownSize} 個資源的 transferSize 為 0（快取命中，或跨網域且未送 Timing-Allow-Origin），**總大小為低估值**。`,
        }
      : {}),
  };
}

async function bridgeGetWebVitals(): Promise<Record<string, unknown>> {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const fcpEntry = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
  const { lcp, cls, fid } = await collectObservedVitals();

  const vitals: Record<string, unknown> = {};
  const put = (name: string, value: number | null, key: 'value_ms' | 'value') => {
    // FID 沒有值代表「使用者還沒互動過」，不是 0 —— 回 null 才不會被讀成「延遲極低」
    vitals[name] = value === null ? null : { [key]: value, rating: rateVital(name, value) };
  };
  put('LCP', lcp, 'value_ms');
  put('FID', fid, 'value_ms');
  put('CLS', Math.round(cls * 1000) / 1000, 'value');
  put('FCP', fcpEntry ? Math.round(fcpEntry.startTime) : null, 'value_ms');
  put('TTFB', nav ? Math.round(nav.responseStart) : null, 'value_ms');
  if (nav) {
    vitals.domContentLoaded_ms = Math.round(nav.domContentLoadedEventEnd);
    vitals.load_ms = Math.round(nav.loadEventEnd);
  }
  if (fid === null) vitals.FID_note = '使用者尚未與頁面互動，FID 無法量測（回 null 而非 0）。';

  return { vitals, resource_summary: summarizeResources() };
}

// ── PM-315：analyze_element ────────────────────────────────────────────────
/**
 * 只取 debug 時真的會看的樣式。`getComputedStyle` 完整倒出來有數百個屬性，
 * 一次呼叫就能吃掉數千 token，而其中絕大多數（`-webkit-*` 之類）對找 bug 毫無幫助。
 */
const ANALYZE_STYLE_PROPS = [
  'display', 'position', 'visibility', 'opacity', 'overflow', 'zIndex',
  'width', 'height', 'margin', 'padding', 'border', 'boxSizing',
  'color', 'backgroundColor', 'fontSize', 'fontFamily', 'fontWeight',
  'flexDirection', 'justifyContent', 'alignItems',
] as const; // 20 個，未超過驗收上限 25

/** 值得回報的屬性；其餘（class/style 等已另外處理的）不重複倒出來。 */
const ANALYZE_ATTR_WHITELIST = new Set([
  'href', 'src', 'alt', 'title', 'type', 'name', 'placeholder', 'value',
  'role', 'target', 'rel', 'for', 'disabled', 'readonly', 'required',
  'checked', 'selected', 'hidden', 'tabindex', 'contenteditable',
]);

/** 常見標籤的隱含 ARIA role（沒寫 role 屬性時，瀏覽器實際採用的角色）。 */
function implicitRole(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
  if (tag === 'input') {
    const t = (el as HTMLInputElement).type;
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
    if (t === 'search') return 'searchbox';
    return 'textbox';
  }
  const map: Record<string, string> = {
    button: 'button', select: 'combobox', textarea: 'textbox', img: 'img',
    nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    aside: 'complementary', form: 'form', table: 'table', ul: 'list', ol: 'list',
    li: 'listitem', h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading',
  };
  return map[tag] ?? 'generic';
}

const NATURALLY_FOCUSABLE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);

function bridgeAnalyzeElement(selector: string): Record<string, unknown> {
  if (typeof selector !== 'string' || !selector.trim()) return { error: '缺少 selector 參數' };
  let el: Element | null;
  try {
    el = document.querySelector(selector);
  } catch {
    return { error: `不是合法的 CSS 選擇器：${selector}` };
  }
  if (!el) {
    return {
      error: `找不到符合「${selector}」的元素`,
      hint: '該元素可能尚未載入、位於 iframe 內（content script 只跑在最上層框架），或選擇器有誤。可先用 read_page 確認頁面上實際有哪些元素。',
    };
  }

  const tag = el.tagName.toLowerCase();
  const sensitive = isSensitiveField(el);

  // 屬性：白名單 + aria-* / data-*，並對敏感欄位的值遮蔽
  const attributes: Record<string, string> = {};
  let attrTruncated = false;
  for (const a of Array.from(el.attributes)) {
    const n = a.name.toLowerCase();
    if (n === 'class' || n === 'id' || n === 'style') continue; // 這三個另有欄位／太長
    if (!ANALYZE_ATTR_WHITELIST.has(n) && !n.startsWith('aria-') && !n.startsWith('data-')) continue;
    if (Object.keys(attributes).length >= 30) {
      attrTruncated = true;
      break;
    }
    // 🔴 敏感欄位的 value 不外送（同 PM-309/311）——結果會整份進 AI 的 context
    attributes[n] =
      n === 'value' && (sensitive || (el as HTMLInputElement).type === 'password')
        ? '<已遮蔽：敏感欄位>'
        : a.value.slice(0, 200);
  }

  const cs = getComputedStyle(el);
  const computed_styles: Record<string, string> = {};
  for (const p of ANALYZE_STYLE_PROPS) computed_styles[p] = cs[p as keyof CSSStyleDeclaration] as string;

  const r = el.getBoundingClientRect();
  const tabindexAttr = el.getAttribute('tabindex');

  // ⚠ 只列得出**行內 on* 屬性**。現代網站幾乎都用 addEventListener 綁定，
  //   那些在 content script 裡是**看不到的**（`getEventListeners` 只存在於 DevTools console）。
  //   所以空陣列**不代表沒有事件處理器**——必須講清楚，否則 AI 會據此誤判「這顆按鈕沒接事件」。
  const inline_attributes = Array.from(el.attributes)
    .filter((a) => a.name.toLowerCase().startsWith('on'))
    .map((a) => a.name.toLowerCase());

  return {
    tag,
    id: el.id || null,
    classes: Array.from(el.classList).slice(0, 50),
    attributes,
    ...(attrTruncated ? { attributes_truncated: true } : {}),
    computed_styles,
    box_model: {
      x: Math.round(r.x), y: Math.round(r.y),
      width: Math.round(r.width), height: Math.round(r.height),
      top: Math.round(r.top), left: Math.round(r.left),
    },
    event_listeners: {
      inline_attributes,
      note: 'ㄧ律只列得出行內 on* 屬性。用 addEventListener 綁的監聽器在 content script 無法列舉（getEventListeners 僅存在於 DevTools），**空陣列不代表沒有事件處理器**。完整列舉需要 chrome.debugger 權限，Phase 1 不支援。',
    },
    accessibility: {
      role: el.getAttribute('role') || implicitRole(el),
      role_is_implicit: !el.hasAttribute('role'),
      aria_label: el.getAttribute('aria-label'),
      aria_hidden: el.getAttribute('aria-hidden'),
      tabindex: tabindexAttr === null ? null : Number(tabindexAttr),
      focusable:
        !(el as HTMLInputElement).disabled &&
        (tabindexAttr !== null ? Number(tabindexAttr) >= 0 : NATURALLY_FOCUSABLE.has(tag)),
    },
    visibility: {
      visible: isElementVisible(el),
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      has_size: r.width > 0 || r.height > 0,
      in_viewport:
        r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0,
    },
    ...(sensitive ? { sensitive_field: true } : {}),
  };
}

// ── PM-309：read_page ──────────────────────────────────────────────────────
const READ_PAGE_MAX_CHARS = 50_000;
/** 這些標籤連同子樹整個跳過——對「頁面上有什麼可以操作」毫無幫助，卻很佔額度。 */
const READ_PAGE_SKIP_TAGS = new Set(['script', 'style', 'svg', 'noscript', 'template', 'link', 'meta', 'head']);
/** AI 後續會用 click_element 操作的元素，要特別標出並附上可直接使用的 selector。 */
const READ_PAGE_INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label']);

function isElementVisible(el: Element): boolean {
  const anyEl = el as Element & { checkVisibility?: (o?: unknown) => boolean };
  if (typeof anyEl.checkVisibility === 'function') {
    return anyEl.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
  }
  const s = getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0;
}

/** 只取「直接屬於這個元素」的文字，**不含子元素**。見 extractPageContent 的說明。 */
function ownText(el: Element): string {
  let t = '';
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) t += n.nodeValue ?? '';
  }
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * 產生**能唯一命中該元素**的 CSS selector，讓 AI 可以直接餵給 click_element。
 * 只給 `[tag#id.class]` 這種描述是不夠的——`.btn` 可能同時命中十個按鈕，
 * AI 照著點就會點錯，而且它無從得知自己點錯了。
 */
function uniqueSelector(el: Element): string {
  const one = (s: string): boolean => {
    try {
      return document.querySelectorAll(s).length === 1;
    } catch {
      return false;
    }
  };
  if (el.id) {
    const s = `#${CSS.escape(el.id)}`;
    if (one(s)) return s;
  }
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.documentElement) {
    const tag = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    const parent: Element | null = cur.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === (cur as Element).tagName);
    parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(cur) + 1})` : tag);
    cur = parent;
  }
  return parts.join(' > ');
}

/** 這個 input 是不是敏感欄位——沿用 PM-186 既有的 SENSITIVE_RECT_SELECTORS，不另立一套定義。 */
function isSensitiveField(el: Element): boolean {
  return SENSITIVE_RECT_SELECTORS.some(({ sel }) => {
    try {
      return el.matches(sel);
    } catch {
      return false;
    }
  });
}

function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  // class 只取前 3 個：Tailwind 之類的原子式 CSS 一個元素可以掛 20 個 class，全印會吃光額度
  const cn = typeof el.className === 'string' ? el.className.trim() : '';
  const cls = cn ? '.' + cn.split(/\s+/).slice(0, 3).join('.') : '';
  return `${tag}${id}${cls}`;
}

/** input/select/textarea 的補充資訊：type + placeholder + value。 */
function describeFormField(el: Element): string {
  const bits: string[] = [];
  const input = el as HTMLInputElement;
  if (el.tagName === 'INPUT' && input.type) bits.push(`type=${input.type}`);
  if (input.placeholder) bits.push(`placeholder="${input.placeholder.slice(0, 60)}"`);
  if (input.disabled) bits.push('disabled');
  if (input.required) bits.push('required');
  // 🔴 敏感欄位（密碼／token／信用卡…）的值**絕不外送**。
  //   read_page 的結果會整份進到 AI 的 context，等於送出第三方；
  //   /privacy 承諾的遮蔽必須在這裡也成立（ARCHITECTURE §4-15：隱私政策要對得上程式碼）。
  if (input.type === 'password' || isSensitiveField(el)) {
    if (input.value) bits.push('value=<已遮蔽：敏感欄位>');
  } else if (input.value) {
    bits.push(`value="${input.value.slice(0, 60)}"`);
  }
  return bits.join(' ');
}

/**
 * 把頁面壓成「給 AI 讀的文字地圖」，而不是原始 HTML。
 *
 * ⚠ **不能對每個元素都印 `textContent`**：`textContent` 含所有子孫的文字，
 *   `<body>` 會印出整頁、它底下每一層 `<div>` 再各印一次同樣的內容。
 *   一個中等頁面就會產生數十倍的重複文字，50000 字元的額度在前幾個元素就被吃光，
 *   而真正有用的按鈕全部落在截斷線之後。所以這裡只印 **ownText（直屬文字節點）**，
 *   並且**只有 interactive 元素、或本身帶文字的元素才輸出一行**。
 */
function extractPageContent(): { content: string; truncated: boolean } {
  const root: Element | null = document.querySelector('main') ?? document.body;
  if (!root) return { content: '', truncated: false };

  const lines: string[] = [];
  let len = 0;
  let truncated = false;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node): number {
      const el = node as Element;
      if (READ_PAGE_SKIP_TAGS.has(el.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
      // 隱藏元素連同**整個子樹**一起跳過（父層看不見，子層也不可能看得見）。
      // 用 FILTER_REJECT 而不是 FILTER_SKIP，順便省下大量 getComputedStyle 呼叫。
      if (!isElementVisible(el)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const depthOf = (el: Element): number => {
    let d = 0;
    let p = el.parentElement;
    while (p && p !== root && d < 10) {
      d++;
      p = p.parentElement;
    }
    return d;
  };

  let node = walker.nextNode();
  while (node) {
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    const interactive = READ_PAGE_INTERACTIVE.has(tag);
    const text = ownText(el);

    let line = '';
    if (tag === 'iframe') {
      line = `${'  '.repeat(depthOf(el))}[${describeElement(el)}] （iframe 內容讀不到：content script 只跑在最上層框架）`;
    } else if (interactive) {
      const isField = tag === 'input' || tag === 'select' || tag === 'textarea';
      const extra = isField ? describeFormField(el) : '';
      // 🔴 表單欄位的 label **絕不可以退回 `.value`**——describeFormField 已經對敏感欄位
      //   做過遮蔽，這裡若再拿原始 value 當標籤，密碼／token 會從標籤那一欄整個漏出去。
      //   （這個洞是 PM-309 的 jsdom 測試抓到的，不是想出來的。）
      const label =
        text ||
        el.getAttribute('aria-label') ||
        (isField ? el.getAttribute('name') || '' : (el as HTMLInputElement).value || '');
      line = `${'  '.repeat(depthOf(el))}[${describeElement(el)}] ${label}${extra ? ` ${extra}` : ''} → click: "${uniqueSelector(el)}"`;
    } else if (text) {
      line = `${'  '.repeat(depthOf(el))}[${describeElement(el)}] ${text}`;
    }

    if (line) {
      if (len + line.length + 1 > READ_PAGE_MAX_CHARS) {
        truncated = true;
        break;
      }
      lines.push(line);
      len += line.length + 1;
    }
    node = walker.nextNode();
  }

  if (truncated) lines.push('… (truncated)');
  return { content: lines.join('\n'), truncated };
}

// background → content：控制指令
chrome.runtime.onMessage.addListener((msg: ControlMessage, _sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    // PM-49/87/91：送 START 前算語音旗標（即時字幕 / Whisper / 鍵盤），一併帶給 inject
    const micFallback = msg.micFallback === true; // PM-193：精準轉錄麥克風失敗 → 改即時字幕
    void computeStartFlags().then(({ keyboardMode, useOldVoice, whisperMode, speechLang }) => {
      if (micFallback && whisperMode) {
        // PM-193：offscreen 麥克風拿不到（多半是「允許這次使用」）→ 無縫切成即時字幕（頁面 SpeechRecognition）+ 橘色提示
        showMicFallbackTip();
        sendToInject('START', keyboardMode, true /* useOldVoice */, false /* whisperMode */, speechLang);
      } else {
        sendToInject('START', keyboardMode, useOldVoice, whisperMode, speechLang);
      }
      sendResponse({ ok: true });
    });
  } else if (msg.type === 'STOP_RECORDING') {
    sendToInject('STOP');
    sendResponse({ ok: true });
  } else if (msg.type === 'WHISPER_TRANSCRIBING') {
    // PM-91：Whisper 模式停止 → 字幕切成「轉錄中」（caption DOM 由 inject 建於頁面，content 共用 DOM 直接改）
    const el = document.getElementById('bugezy-caption-text');
    if (el) el.textContent = ct('transcribing');
    sendResponse({ ok: true });
  } else if (msg.type === 'MIC_VOLUME') {
    // PM-97：轉發即時音量給 inject（MAIN world）——CustomEvent 派在共用的 window EventTarget 上跨世界
    window.dispatchEvent(new CustomEvent('bugezy-mic-volume', { detail: { level: msg.level } }));
    sendResponse({ ok: true });
  } else if (msg.type === 'START_SCREENSHOT') {
    // PM-185：截圖前掃 DOM 敏感欄位——偵測到才彈警告（沒偵測到不打擾）
    const sensitive = detectSensitiveFields();
    if (sensitive.length > 0) {
      // PM-186：一併收集敏感欄位座標 + 當前 viewport 尺寸，供 annotate 自動遮罩（預設安全）
      const rectPayload = {
        rects: getSensitiveRects(),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
      showSensitiveWarning(sensitive, () => {
        void chrome.storage.local.set({ [SENSITIVE_DETECTED_KEY]: true, [SENSITIVE_RECTS_KEY]: rectPayload });
        injectScreenshotOverlay();
      });
    } else {
      void chrome.storage.local.remove([SENSITIVE_DETECTED_KEY, SENSITIVE_RECTS_KEY]); // 清掉舊 flag/座標
      injectScreenshotOverlay();
    }
    sendResponse({ ok: true });
  } else if (msg.type === 'REWIND_30S') {
    sendToInject('REWIND'); // PM-50：請 inject 打包背景緩存
    sendResponse({ ok: true });
  } else if (msg.type === 'GET_LIVE_ERRORS') {
    // PM-51：向 inject 要背景 buffer 的即時 errors（PM-181：抽成共用 queryInjectLiveErrors）
    void queryInjectLiveErrors().then(sendResponse);
  } else if (msg.type === 'GET_PAGE_INFO') {
    // PM-298：bridge 的 get_page_url 用。**不能用 chrome.tabs.query 的 url/title**——
    //   那需要 `tabs` 權限（activeTab 只在使用者主動叫用擴充功能後才生效），
    //   沒有權限時 Chrome 會靜默回空字串。content script 本來就在頁面裡，直接讀最準也不需任何權限。
    sendResponse({ url: location.href, title: document.title });
  } else if (msg.type === 'BRIDGE_CLICK') {
    sendResponse(bridgeClick(msg.selector));
  } else if (msg.type === 'BRIDGE_TYPE_TEXT') {
    sendResponse(bridgeTypeText(msg.selector, msg.text));
  } else if (msg.type === 'BRIDGE_PIN_ELEMENT') {
    sendResponse(bridgePinElement(msg.selector, msg.description));
  } else if (msg.type === 'BRIDGE_PIN_ANALYZE') {
    sendResponse(bridgePinAnalyze(msg.selector));
  } else if (msg.type === 'BRIDGE_GET_PIN_RESULTS') {
    sendResponse(bridgeGetPinResults());
  } else if (msg.type === 'BRIDGE_GET_PAGE_HEALTH') {
    void bridgeGetPageHealth().then(sendResponse);
  } else if (msg.type === 'BRIDGE_GET_WEB_VITALS') {
    void bridgeGetWebVitals().then(sendResponse);
  } else if (msg.type === 'BRIDGE_ANALYZE_ELEMENT') {
    sendResponse(bridgeAnalyzeElement(msg.selector));
  } else if (msg.type === 'BRIDGE_GET_BROWSER_ERRORS') {
    // PM-313：**沿用 inject.ts 既有的攔截機制**（PM-51 的通道），不另外掛一套。
    //   inject 在 document_start 就開始收，不需要先按錄製。
    void queryInjectLiveErrors().then(({ consoleLogs, networkErrors }) =>
      sendResponse({
        console_errors: consoleLogs
          // 'info' 是 Web Vitals 之類的中性訊息，產品內部本來就「不計入即時監控錯誤數」，
          // 一支叫 get_browser_errors 的工具把它們算成錯誤會誤導 AI
          .filter((c) => c.level !== 'info')
          .map((c) => ({
            level: c.level,
            message: c.message,
            source: c.source ?? 'console', // source 在既有型別是可選的（'console' 會省略），這裡補齊
            timestamp: c.timestamp,
          })),
        // 🔴 只帶 url/status/method/timestamp：requestBody / responseBody 可能含
        //    認證 token 或使用者個資，而這份結果會整份進到 AI 的 context（同 PM-309 的考量）
        network_errors: networkErrors.map((n) => ({
          url: n.url,
          status: n.status,
          method: n.method,
          timestamp: n.timestamp,
          duration: n.duration,
        })),
      }),
    );
  } else if (msg.type === 'BRIDGE_READ_PAGE') {
    const { content, truncated } = extractPageContent();
    sendResponse({
      url: location.href,
      title: document.title,
      content,
      truncated,
      element_count: document.querySelectorAll('*').length,
      // PM-319（DONE-310 留項）：頁面還在載入時 content 可能是空的或不完整，
      //   沒有這個欄位的話，AI 分不出「這頁真的沒東西」還是「還沒 render 完」，
      //   然後就會對著一個載到一半的頁面下結論。
      ready_state: document.readyState,
    });
  } else if (msg.type === 'SET_MONITOR_BADGE') {
    // PM-52：轉發給 inject 顯示/隱藏頁面浮動 badge
    sendToInject(msg.show ? 'SHOW_MONITOR' : 'HIDE_MONITOR');
    sendResponse({ ok: true });
  }
  return true;
});

// PM-35：頁面載入時自動恢復錄製。
// 使用者跳頁後新頁面是全新的 content + inject，本來不知道仍在錄製中。
// 載入時主動問 background 狀態，若 recording=true 就等 inject READY 後補送 START。
(async () => {
  try {
    const state = (await chrome.runtime.sendMessage({ type: 'GET_STATE' })) as StateResponse | undefined;
    if (!state?.recording) return;
    blog('偵測到正在錄製中，自動恢復 inject 錄製');
    // PM-49/87/91：跨頁恢復也帶語音旗標（付費 whisper 跨頁由 offscreen 持續錄、頁面只顯示錄音 bar）
    const { keyboardMode: km, useOldVoice, whisperMode, speechLang } = await computeStartFlags();
    const waitForInject = (retries = 0) => {
      if (injectReady) {
        sendToInject('START', km, useOldVoice, whisperMode, speechLang); // inject 全新（recording=false）會正常啟動
        blog('已送 START 給 inject（跳頁恢復）');
      } else if (retries < 40) {
        // PM-36：inject 尚未 READY，縮短為每 50ms 再試（最多 40×50ms = 2 秒），恢復更滑順
        setTimeout(() => waitForInject(retries + 1), 50);
      } else {
        blog('⚠ inject 未就緒，跳頁恢復失敗');
      }
    };
    waitForInject();
  } catch {
    // GET_STATE 失敗（background 未就緒），忽略
  }
})();

// ════════════════════════════════════════════════════════════
// PM-185：截圖前敏感欄位偵測（掃頁面 DOM，偵測到才提醒；沒偵測到不打擾）
// content.ts（ISOLATED world）能直接讀頁面 DOM，且截圖流程由此觸發——故偵測放這裡最直接。
// ════════════════════════════════════════════════════════════
const SENSITIVE_DETECTED_KEY = 'bugezy:sensitive-detected';
const SENSITIVE_RECTS_KEY = 'bugezy:sensitive-rects'; // PM-186：敏感欄位座標 + viewport 尺寸

// PM-186：敏感欄位座標選擇器（比 detectSensitiveFields 精一點，label 給英文供 annotate 顯示）
const SENSITIVE_RECT_SELECTORS: Array<{ sel: string; label: string }> = [
  { sel: 'input[type="password"]', label: 'password' },
  { sel: 'input[name*="password" i]', label: 'password' },
  { sel: 'input[name*="passwd" i]', label: 'password' },
  { sel: 'input[autocomplete="current-password"]', label: 'password' },
  { sel: 'input[autocomplete="new-password"]', label: 'password' },
  { sel: 'input[name*="secret" i]', label: 'secret' },
  { sel: 'input[name*="token" i]', label: 'token' },
  { sel: 'input[name*="key" i]:not([name*="keyboard" i])', label: 'key' },
  { sel: 'input[name*="card" i]', label: 'card' },
  { sel: 'input[autocomplete*="cc-"]', label: 'card' },
  { sel: 'input[name*="cvv" i]', label: 'cvv' },
  { sel: 'input[name*="cvc" i]', label: 'cvv' },
  { sel: '[data-sensitive]', label: 'sensitive' },
];

/** PM-186：收集敏感欄位在 viewport 的座標（getBoundingClientRect），供 annotate 截圖後自動遮罩。
 *  只收可見（寬高>0 且在視窗內）；同一元素被多選擇器命中只留一份（用 element Set 去重）。 */
function getSensitiveRects(): Array<{ x: number; y: number; width: number; height: number; label: string }> {
  const seen = new Set<Element>();
  const rects: Array<{ x: number; y: number; width: number; height: number; label: string }> = [];
  for (const { sel, label } of SENSITIVE_RECT_SELECTORS) {
    let els: NodeListOf<Element>;
    try {
      els = document.querySelectorAll(sel);
    } catch {
      continue; // 選擇器不合法（極少數瀏覽器）→ 略過
    }
    els.forEach((el) => {
      if (seen.has(el)) return;
      const r = el.getBoundingClientRect();
      // 只收可見且在視窗內（截圖只拍 viewport）
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth) {
        seen.add(el);
        rects.push({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), label });
      }
    });
  }
  return rects;
}

/** 掃 DOM 找敏感 input（密碼/token/key/card/cvv/secret/標記）。回 i18n 標籤 key 陣列（已去重）。 */
function detectSensitiveFields(): string[] {
  const groups: Array<{ sels: string[]; key: string }> = [
    { key: 'sf-password', sels: ['input[type="password"]', 'input[name*="password" i]', 'input[name*="passwd" i]', 'input[autocomplete="current-password"]', 'input[autocomplete="new-password"]'] },
    { key: 'sf-token', sels: ['input[name*="token" i]'] },
    { key: 'sf-secret', sels: ['input[name*="secret" i]'] },
    { key: 'sf-key', sels: ['input[name*="key" i]', 'input[name*="apikey" i]'] },
    { key: 'sf-card', sels: ['input[name*="card" i]', 'input[autocomplete*="cc-"]'] },
    { key: 'sf-cvv', sels: ['input[name*="cvv" i]', 'input[name*="cvc" i]'] },
    { key: 'sf-marked', sels: ['[data-sensitive]'] },
  ];
  const found: string[] = [];
  for (const g of groups) {
    if (g.sels.some((s) => document.querySelector(s))) found.push(g.key);
  }
  return found;
}

/** 偵測到敏感欄位時彈警告 overlay（繼續截圖 / 取消）。 */
function showSensitiveWarning(fieldKeys: string[], onContinue: () => void) {
  document.getElementById('bugezy-sensitive-warning')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'bugezy-sensitive-warning';
  overlay.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:-apple-system,system-ui,"Microsoft JhengHei",sans-serif;';
  const fieldsDesc = fieldKeys.map((k) => ct(k)).join(ct('sensitive-sep'));
  const card = document.createElement('div');
  card.style.cssText =
    'background:#1a1a2e;border:2px solid #f59e0b;border-radius:16px;padding:24px;max-width:360px;text-align:center;';
  card.innerHTML =
    `<p style="font-size:28px;margin:0 0 8px;">⚠️</p>` +
    `<p style="color:#f59e0b;font-size:16px;font-weight:700;margin:0 0 8px;"></p>` +
    `<p style="color:#e6edf3;font-size:13px;margin:0 0 4px;"></p>` +
    `<p style="color:#9aa3b2;font-size:12px;margin:0 0 16px;"></p>` +
    `<div style="display:flex;gap:8px;justify-content:center;">` +
    `<button id="bz-sens-continue" style="background:#7c3aed;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer;"></button>` +
    `<button id="bz-sens-cancel" style="background:transparent;color:#888;border:1px solid #444;border-radius:8px;padding:10px 20px;font-size:14px;cursor:pointer;"></button>` +
    `</div>`;
  // textContent 設值（避免 fieldsDesc 進 innerHTML 的 XSS——雖為固定字典仍守則）
  const ps = card.querySelectorAll('p');
  ps[1].textContent = ct('sensitive-title');
  ps[2].textContent = ct('sensitive-page-has', { fields: fieldsDesc });
  ps[3].textContent = ct('sensitive-hint');
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  card.querySelector<HTMLButtonElement>('#bz-sens-continue')!.textContent = ct('sensitive-continue');
  card.querySelector<HTMLButtonElement>('#bz-sens-cancel')!.textContent = ct('sensitive-cancel');
  card.querySelector<HTMLButtonElement>('#bz-sens-continue')!.onclick = () => {
    overlay.remove();
    onContinue();
  };
  card.querySelector<HTMLButtonElement>('#bz-sens-cancel')!.onclick = () => overlay.remove();
}

// ════════════════════════════════════════════════════════════
// PM-19：截圖模式 overlay（整頁 / 區域兩點可捲動 / 自由形狀）
// 注入頁面 DOM（ISOLATED world 共用頁面 DOM），擷取交由 background。
// ════════════════════════════════════════════════════════════

const SS_TOOLBAR_ID = 'bugezy-ss-toolbar';
const SS_OVERLAY_ID = 'bugezy-ss-overlay';
const SS_CANVAS_ID = 'bugezy-ss-canvas';
const SS_DOT_ID = 'bugezy-ss-dot';
const Z_TOP = '2147483647';
const Z_LAYER = '2147483646';

let ssKeyHandler: ((e: KeyboardEvent) => void) | null = null;

/** 移除所有截圖 overlay DOM + 鍵盤監聽 */
function ssCleanup() {
  [SS_TOOLBAR_ID, SS_OVERLAY_ID, SS_CANVAS_ID, SS_DOT_ID].forEach((id) =>
    document.getElementById(id)?.remove(),
  );
  if (ssKeyHandler) {
    window.removeEventListener('keydown', ssKeyHandler);
    ssKeyHandler = null;
  }
}

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
/** 等捲動/移除 overlay 後渲染完成，並避開 captureVisibleTab 速率限制 */
async function settle() {
  await raf();
  await raf();
  await new Promise((r) => setTimeout(r, 350));
}

/** 請 background 擷取目前可見分頁 */
async function captureSegment(): Promise<string> {
  const resp = (await chrome.runtime.sendMessage({ type: 'CAPTURE_SEGMENT' })) as {
    dataUrl?: string;
    error?: string;
  };
  if (!resp?.dataUrl) throw new Error(resp?.error ?? 'capture 失敗');
  return resp.dataUrl;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load 失敗'));
    img.src = dataUrl;
  });
}

/** PM-51/181：向 inject（MAIN world）要背景 buffer 的即時 console/network errors。
 *  一次性 listener + 2 秒超時（inject 通常立即回 LIVE_ERRORS_RESULT）。 */
function queryInjectLiveErrors(): Promise<{ consoleLogs: ConsoleLog[]; networkErrors: NetworkError[] }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: { consoleLogs: ConsoleLog[]; networkErrors: NetworkError[] }) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', handler);
      resolve(result);
    };
    const handler = (e: MessageEvent) => {
      const d = e.data as InjectMessage & { consoleLogs?: ConsoleLog[]; networkErrors?: NetworkError[] };
      if (e.source === window && d?.source === BUGEZY_SOURCE && d?.kind === 'LIVE_ERRORS_RESULT') {
        finish({ consoleLogs: d.consoleLogs ?? [], networkErrors: d.networkErrors ?? [] });
      }
    };
    window.addEventListener('message', handler);
    sendToInject('GET_LIVE_ERRORS');
    setTimeout(() => finish({ consoleLogs: [], networkErrors: [] }), 2000);
  });
}

async function sendReady(dataUrl: string) {
  // PM-181：截圖時一併帶上 inject 已收集的 console/network（讓截圖報告也有錯誤上下文，不再只有畫面+語音）
  const { consoleLogs, networkErrors } = await queryInjectLiveErrors();
  chrome.runtime.sendMessage({
    type: 'SCREENSHOT_READY',
    dataUrl,
    pageUrl: location.href,
    pageTitle: document.title,
    consoleLogs,
    networkErrors,
  } satisfies ControlMessage);
}

function setHint(text: string) {
  const hint = document.getElementById('bugezy-ss-hint');
  if (hint) hint.textContent = text;
}

/** 頂部模式選擇列 */
// PM-104：工具列入場橘光脈衝（0.7s×10≈7 秒後退回靜態）。PM-103 的紅色跑馬燈/isDarkBackground
// 已刪除（工具列本身深色底、跑馬燈永不觸發）；改為單一橘光脈衝，並由 popup 開關控制。
function applyOrangePulse(bar: HTMLElement): void {
  if (!document.getElementById('bugezy-orange-pulse-style')) {
    const style = document.createElement('style');
    style.id = 'bugezy-orange-pulse-style';
    style.textContent = `
      @keyframes bugezy-orange-pulse {
        0%, 100% { box-shadow: 0 0 8px rgba(255,140,0,0.3); border-color: #ff8c00; }
        50% { box-shadow: 0 0 30px rgba(255,140,0,1), 0 0 60px rgba(255,140,0,0.5); border-color: #ffaa00; }
      }
    `;
    document.head.appendChild(style);
  }
  bar.style.border = '2px solid #ff8c00';
  bar.style.boxShadow = '0 0 20px rgba(255,140,0,0.8)';
  bar.style.animation = 'bugezy-orange-pulse 0.7s ease-in-out 10'; // 0.7×10 = 7 秒
  window.setTimeout(() => {
    bar.style.animation = 'none';
    bar.style.borderColor = '#444';
    bar.style.boxShadow = '0 2px 8px rgba(255,140,0,0.15)';
    bar.style.transition = 'border-color 0.5s, box-shadow 0.5s';
    document.getElementById('bugezy-orange-pulse-style')?.remove();
  }, 7000);
}

function createToolbar(onMode: (mode: string) => void) {
  const bar = document.createElement('div');
  bar.id = SS_TOOLBAR_ID;
  bar.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:${Z_TOP};display:flex;align-items:center;gap:8px;padding:10px 16px;background:#16213e;border-bottom:1px solid #333;font-family:system-ui,sans-serif;font-size:14px;color:#fff;`;
  // PM-104：入場橘光脈衝（依 popup「工具列特效」開關，預設 ON）
  chrome.storage.local.get(TOOLBAR_EFFECT_KEY, (store) => {
    if (store[TOOLBAR_EFFECT_KEY] !== false) applyOrangePulse(bar);
  });
  const modes: Array<[string, string]> = [
    ['full', ct('toolbar-fullpage')],
    ['area', ct('toolbar-region')],
    ['free', ct('toolbar-freeform')],
    ['cancel', ct('toolbar-cancel')],
  ];
  for (const [mode, label] of modes) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.mode = mode;
    b.style.cssText = `background:${mode === 'cancel' ? '#dc2626' : '#333'};color:#fff;border:1px solid #555;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:14px;`;
    b.addEventListener('click', () => onMode(mode));
    bar.appendChild(b);
  }
  const hint = document.createElement('span');
  hint.id = 'bugezy-ss-hint';
  hint.textContent = ct('toolbar-select-mode');
  hint.style.cssText = 'margin-left:8px;color:#9aa3b2;';
  bar.appendChild(hint);
  document.body.appendChild(bar);
}

/** 半透明遮罩 + 預覽 canvas（區域/自由形狀模式） */
function createSelectionLayer(): {
  overlay: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const overlay = document.createElement('div');
  overlay.id = SS_OVERLAY_ID;
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:${Z_LAYER};cursor:crosshair;`;
  document.body.appendChild(overlay);

  const canvas = document.createElement('canvas');
  canvas.id = SS_CANVAS_ID;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.style.cssText = `position:fixed;inset:0;z-index:${Z_LAYER};pointer-events:none;`;
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d 不可用');
  return { overlay, canvas, ctx };
}

function injectScreenshotOverlay() {
  ssCleanup();
  createToolbar((mode) => {
    if (mode === 'cancel') {
      ssCleanup();
    } else if (mode === 'full') {
      void startFullCapture();
    } else if (mode === 'area') {
      startAreaCapture();
    } else if (mode === 'free') {
      startFreeCapture();
    }
  });
}

// ── 模式 A：整頁（可見範圍）──────────────────────────────
async function startFullCapture() {
  ssCleanup(); // 擷取前移除工具列，避免入鏡
  await settle();
  try {
    await sendReady(await captureSegment());
  } catch (err) {
    blog('整頁截圖失敗', err);
  }
}

// ── 模式 B：區域（兩點式，可捲動拼接）────────────────────
function startAreaCapture() {
  setHint('點第一下標記起點');
  const { overlay, canvas, ctx } = createSelectionLayer();
  let start: { x: number; y: number } | null = null; // document 絕對座標

  const toDoc = (e: MouseEvent) => ({ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY });

  overlay.addEventListener('mousemove', (e) => {
    if (!start) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sx = start.x - window.scrollX;
    const sy = start.y - window.scrollY;
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(Math.min(sx, e.clientX), Math.min(sy, e.clientY), Math.abs(e.clientX - sx), Math.abs(e.clientY - sy));
  });

  overlay.addEventListener('click', (e) => {
    if (!start) {
      start = toDoc(e);
      setHint(ct('toolbar-region-hint'));
      const dot = document.createElement('div');
      dot.id = SS_DOT_ID;
      dot.style.cssText = `position:absolute;left:${start.x - 5}px;top:${start.y - 5}px;width:10px;height:10px;border-radius:50%;background:#ef4444;z-index:${Z_TOP};pointer-events:none;`;
      document.body.appendChild(dot);
      return;
    }
    const end = toDoc(e);
    const s = start;
    ssCleanup();
    void stitchArea(s, end);
  });
}

/** 跨 viewport 捲動 + 逐段擷取 + 拼接 + 裁切 */
async function stitchArea(start: { x: number; y: number }, end: { x: number; y: number }) {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const rectW = Math.max(1, Math.abs(end.x - start.x));
  const rectH = Math.max(1, Math.abs(end.y - start.y));
  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const orig = { x: window.scrollX, y: window.scrollY };

  try {
    const big = document.createElement('canvas');
    big.width = Math.round(vw * dpr);
    big.height = Math.round(rectH * dpr);
    const bctx = big.getContext('2d');
    if (!bctx) throw new Error('canvas 2d 不可用');

    let target = top;
    let guard = 0;
    while (target < top + rectH && guard < 40) {
      guard++;
      window.scrollTo(0, target);
      await settle();
      const actualY = window.scrollY;
      const img = await loadImage(await captureSegment());
      bctx.drawImage(img, 0, Math.round((actualY - top) * dpr), Math.round(vw * dpr), Math.round(vh * dpr));
      if (actualY + vh >= top + rectH) break; // 已涵蓋底部
      target = actualY + vh;
    }
    window.scrollTo(orig.x, orig.y);

    const out = document.createElement('canvas');
    out.width = Math.round(rectW * dpr);
    out.height = Math.round(rectH * dpr);
    const octx = out.getContext('2d');
    if (!octx) throw new Error('canvas 2d 不可用');
    octx.drawImage(big, Math.round(left * dpr), 0, out.width, out.height, 0, 0, out.width, out.height);
    await sendReady(out.toDataURL('image/png'));
  } catch (err) {
    blog('區域截圖拼接失敗', err);
    window.scrollTo(orig.x, orig.y);
  }
}

// ── 模式 C：自由形狀（多邊形 clip，限可見範圍）────────────
function startFreeCapture() {
  setHint('連續點擊畫多邊形，雙擊或按 Enter 封閉');
  const { overlay, canvas, ctx } = createSelectionLayer();
  const points: Array<{ x: number; y: number }> = []; // viewport 座標

  function redraw(cursor?: { x: number; y: number }) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (points.length === 0) return;
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (cursor) {
      ctx.setLineDash([6, 4]);
      ctx.lineTo(cursor.x, cursor.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ef4444';
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  overlay.addEventListener('mousemove', (e) => redraw({ x: e.clientX, y: e.clientY }));
  overlay.addEventListener('click', (e) => {
    points.push({ x: e.clientX, y: e.clientY });
    redraw();
  });
  overlay.addEventListener('dblclick', () => void closeFree());
  ssKeyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Enter') void closeFree();
    else if (e.key === 'Escape') ssCleanup();
  };
  window.addEventListener('keydown', ssKeyHandler);

  async function closeFree() {
    if (points.length < 3) {
      setHint('至少需要 3 個點');
      return;
    }
    const pts = points.slice();
    const dpr = window.devicePixelRatio || 1;
    ssCleanup();
    await settle();
    try {
      const img = await loadImage(await captureSegment());
      const out = document.createElement('canvas');
      out.width = Math.round(window.innerWidth * dpr);
      out.height = Math.round(window.innerHeight * dpr);
      const octx = out.getContext('2d');
      if (!octx) throw new Error('canvas 2d 不可用');
      octx.beginPath();
      octx.moveTo(pts[0].x * dpr, pts[0].y * dpr);
      for (let i = 1; i < pts.length; i++) octx.lineTo(pts[i].x * dpr, pts[i].y * dpr);
      octx.closePath();
      octx.clip();
      octx.drawImage(img, 0, 0, out.width, out.height);
      await sendReady(out.toDataURL('image/png'));
    } catch (err) {
      blog('自由形狀截圖失敗', err);
    }
  }
}
