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
  // PM-369：targetOrigin 由 '*' 收緊為 '/'（僅同源）。這是 content↔inject 的同頁通訊，
  // 用 '*' 等於允許任何 origin 接收；'/' 表示「只送給與本文件同源者」。
  window.postMessage(msg, '/');
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

  // PM-369（資安）：**已移除 REQUEST_VOICE_HISTORY / VOICE_HISTORY 這條路徑。**
  //
  // 原本的行為是：inject（MAIN world）建好語音面板後跟 content 要歷史逐字稿，
  // content 從 background 撈出**跨頁累積的整份語音緩存**再 postMessage 回 MAIN world。
  // MAIN world 與頁面共用同一個 JS 環境，頁面只要監聽 `message` 就能收到
  // ——等於使用者在**別的分頁／別的網站**講過的話，全部送到當前這個網站手上。
  //
  // 代價：跳頁之後頁面上的語音面板只顯示當前頁的逐字稿，不再回填先前頁面的。
  // **錄製本身完全不受影響** —— 逐字稿走 FLUSH_VOICE（inject → content → background）
  // 單向往外推，報告內容一段都不會少。

  if (data.kind === 'READY') {
    injectReady = true;
    blog('✓ inject 已報到（READY）');
    // PM-37：回 ACK 讓 inject 停止重複發 READY（解載入順序競爭）
    window.postMessage({ source: BUGEZY_SOURCE, dir: 'to-inject', kind: 'READY_ACK' }, '/');
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
          '/',
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

  // PM-337：點擊前閃一下，讓使用者看得到 AI 點了哪裡
  highlightElement(selector, { durationMs: 500, label: '點擊' });
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

// ── PM-341~346：Zone Grid（規格書 §15）─────────────────────────────────────
//
// 依 §15.2 的四層規則自動分區；error 歸類走 PM-342 的「現場元素」而非 stack trace
// （§15.3 已查證 stack trace 反推 DOM 是做不出來的）。

interface Zone {
  zone_id: string;
  name: string;
  selector: string;
  tag: string;
  element_count: number;
  rect: { x: number; y: number; width: number; height: number };
}

interface ZoneHealth {
  status: 'healthy' | 'warning' | 'error' | 'unknown';
  error_count: number;
  warning_count: number;
}

/** §15.2 規則 1：HTML5 語意標籤 */
const ZONE_SEMANTIC_TAGS = ['header', 'nav', 'main', 'aside', 'footer', 'section', 'article'];
/** §15.2 規則 2：role 屬性 */
const ZONE_ROLES: Record<string, string> = {
  banner: 'Header',
  navigation: 'Navigation',
  main: 'Main',
  complementary: 'Sidebar',
  contentinfo: 'Footer',
  search: 'Search',
  form: 'Form',
};
/** §15.2 規則 3：常見 class/id 命名 */
const ZONE_NAME_HINTS = [
  'header', 'nav', 'navbar', 'sidebar', 'aside', 'footer', 'cart', 'checkout',
  'product', 'search', 'menu', 'content', 'main', 'hero', 'banner', 'toolbar',
];

let zoneList: Zone[] = [];
let zoneSeq = 0;
/** zone_id 依「名稱」保持穩定 —— 否則 §15.4 的時間軸每次重建就會斷掉。 */
const zoneIdByName = new Map<string, string>();
let zonesStale = false;
/** map_page_zones 是否呼叫過。**與「有幾個 zone」是兩回事** —— 見 bridgeGetZoneHealth 的說明。 */
let zonesMapped = false;

function titleCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** 依 §15.2 的命名邏輯替 zone 取名。 */
function nameZone(el: Element, tag: string, index: number): string {
  const role = el.getAttribute('role');
  if (role && ZONE_ROLES[role]) return ZONE_ROLES[role];

  const aria = el.getAttribute('aria-label');
  if (aria) return titleCase(aria.slice(0, 30));

  // class/id 裡的描述性字眼
  const cn = typeof el.className === 'string' ? el.className : '';
  for (const hint of ZONE_NAME_HINTS) {
    if (new RegExp(`(^|[-_\\s])${hint}([-_\\s]|$)`, 'i').test(cn) || new RegExp(hint, 'i').test(el.id)) {
      return titleCase(hint);
    }
  }
  if (el.id) return titleCase(el.id.slice(0, 30));
  if (cn.trim()) return titleCase(cn.trim().split(/\s+/)[0].slice(0, 30));

  // section/article → 用子標題
  if (tag === 'section' || tag === 'article') {
    const h = el.querySelector('h1,h2,h3,h4,h5,h6');
    const t = h?.textContent?.trim();
    if (t) return titleCase(t.slice(0, 30));
  }
  if (ZONE_SEMANTIC_TAGS.includes(tag)) return titleCase(tag);
  return `Section-${index + 1}`;
}

/** 給 zone 一個穩定的 id（同名沿用），避免時間軸斷裂。 */
function zoneIdFor(name: string): string {
  const existing = zoneIdByName.get(name);
  if (existing) return existing;
  const id = `zone${++zoneSeq}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  zoneIdByName.set(name, id);
  return id;
}

function bridgeMapPageZones(): Record<string, unknown> {
  const root = document.body;
  if (!root) return { zones: [], unassigned_count: 0, note: '頁面尚無 body' };

  const found: Element[] = [];
  // 規則 1+2：語意標籤與 role（一次撈完，之後用 contains 去掉巢狀的內層）
  for (const tag of ZONE_SEMANTIC_TAGS) {
    for (const el of Array.from(root.querySelectorAll(tag))) found.push(el);
  }
  for (const role of Object.keys(ZONE_ROLES)) {
    for (const el of Array.from(root.querySelectorAll(`[role="${role}"]`))) {
      if (!found.includes(el)) found.push(el);
    }
  }
  // 規則 3：class/id 命名推測（只看 body 的直接子層，避免把整頁都切碎）
  for (const el of Array.from(root.children)) {
    if (found.includes(el)) continue;
    const cn = typeof el.className === 'string' ? el.className : '';
    if (ZONE_NAME_HINTS.some((h) => new RegExp(h, 'i').test(cn) || new RegExp(h, 'i').test(el.id))) {
      found.push(el);
    }
  }

  // 去掉被其他 zone 包住的內層（避免 header 內的 nav 又切一塊，造成歸類歧義）
  const outermost = found.filter((el) => !found.some((o) => o !== el && o.contains(el)));

  const zones: Zone[] = outermost
    .filter((el) => isElementVisible(el))
    .map((el, i) => {
      const tag = el.tagName.toLowerCase();
      const name = nameZone(el, tag, i);
      const r = el.getBoundingClientRect();
      return {
        zone_id: zoneIdFor(name),
        name,
        selector: uniqueSelector(el),
        tag,
        element_count: el.querySelectorAll('*').length,
        rect: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
      };
    });

  // 🔴 §15.3：沒落進任何 zone 的頂層元素必須計數。
  //    不揭露的話，AI 看到「全部 zone 都健康」就會結案，而問題正藏在沒被歸類的那些裡。
  const unassigned = Array.from(root.children).filter(
    (el) => !zones.some((z) => el.matches(z.selector) || el.contains(document.querySelector(z.selector) as Node)),
  ).length;

  zoneList = zones;
  zonesStale = false;
  zonesMapped = true;
  return {
    zones,
    unassigned_count: unassigned,
    ...(zones.length === 0
      ? { note: '這一頁沒有可辨識的語意區域（header/nav/main/aside/footer/section/article/role）。所有錯誤都會歸入 Unassigned。' }
      : {}),
  };
}

/**
 * PM-342：把一筆錯誤歸到某個 zone。
 * 走的是「錯誤發生當下記下的現場元素 selector」（inject.ts 的 elementSelector），
 * 從該元素往上找第一個屬於某 zone 的祖先。抓不到 → 'Unassigned'（**絕不靜默丟掉**）。
 */
function classifyToZone(elementSelector: string | undefined): string {
  if (!elementSelector) return 'Unassigned';
  let el: Element | null;
  try {
    el = document.querySelector(elementSelector);
  } catch {
    return 'Unassigned';
  }
  while (el) {
    for (const z of zoneList) {
      try {
        if (el.matches(z.selector)) return z.zone_id;
      } catch {
        /* selector 不合法就跳過這個 zone */
      }
    }
    el = el.parentElement;
  }
  return 'Unassigned';
}

/** 依 §15.3 判定 zone 狀態；§15.8：嚴重度繼承最高等級。 */
function zoneStatusOf(errorCount: number, warningCount: number): ZoneHealth['status'] {
  if (errorCount > 0) return 'error';
  if (warningCount > 0) return 'warning';
  return 'healthy';
}

/** PM-346：依狀態給出「下一步該做什麼」，healthy 回 null（省 token）。 */
function suggestedActionFor(z: { name: string; selector?: string }, status: string): string | null {
  if (status === 'healthy' || status === 'unknown') return null;
  if (!z.selector) return `這些錯誤沒有可定位的現場元素（Unassigned），建議用 get_zone_errors('Unassigned') 看完整清單。`;
  return `呼叫 pin_analyze("${z.selector}") 深度分析「${z.name}」這一區`;
}

async function collectZoneBuckets(): Promise<{
  buckets: Map<string, { errors: ConsoleLog[]; net: NetworkError[] }>;
}> {
  const { consoleLogs, networkErrors } = await queryInjectLiveErrors();
  const buckets = new Map<string, { errors: ConsoleLog[]; net: NetworkError[] }>();
  const put = (id: string) => {
    if (!buckets.has(id)) buckets.set(id, { errors: [], net: [] });
    return buckets.get(id)!;
  };
  for (const z of zoneList) put(z.zone_id);
  put('Unassigned');
  for (const c of consoleLogs) {
    if (c.level === 'info') continue; // Web Vitals 之類不算錯誤（同 PM-313）
    put(classifyToZone(c.elementSelector)).errors.push(c);
  }
  for (const n of networkErrors) put(classifyToZone(n.elementSelector)).net.push(n);
  return { buckets };
}

async function bridgeGetZoneHealth(): Promise<Record<string, unknown>> {
  // 🔴 判斷依據是「有沒有分過區」，**不是「有沒有 zone」**。
  //    很多頁面（例如純內容頁）根本沒有語意標籤 → zones 為 0，但它照樣會有錯誤。
  //    若因為 zones 為 0 就整支拒絕回應，那些錯誤會**完全無法透過 zone 工具看到** ——
  //    這正是 §15.3 要防的「錯誤被吞掉」，只是換成在工具層發生。
  //    （這個洞是 PM-348 在真實的 /test-errors 頁上抓到的。）
  if (!zonesMapped) {
    return {
      error: '尚未分區。請先呼叫 map_page_zones()。',
      hint: 'Zone Grid 的健康狀態建立在分區結果上，請先呼叫 map_page_zones()。',
    };
  }
  const { buckets } = await collectZoneBuckets();
  const zones = zoneList.map((z) => {
    const b = buckets.get(z.zone_id) ?? { errors: [], net: [] };
    const errCount = b.errors.filter((e) => e.level === 'error').length + b.net.length;
    const warnCount = b.errors.filter((e) => e.level === 'warn').length;
    const status = zoneStatusOf(errCount, warnCount);
    return {
      zone_id: z.zone_id,
      name: z.name,
      selector: z.selector,
      status,
      error_count: errCount,
      warning_count: warnCount,
      suggested_action: suggestedActionFor(z, status), // PM-346
    };
  });
  const u = buckets.get('Unassigned') ?? { errors: [], net: [] };
  const uErr = u.errors.filter((e) => e.level === 'error').length + u.net.length;
  const uWarn = u.errors.filter((e) => e.level === 'warn').length;
  const summary = { healthy: 0, warning: 0, error: 0, unknown: 0 } as Record<string, number>;
  for (const z of zones) summary[z.status]++;
  return {
    zones,
    // 🔴 §15.3：Unassigned 一定要單獨回報。歸不了類的錯誤若被吞掉，
    //    畫面會是一片令人安心的綠，而 §15.8 的規則正是「✅ 就跳過，省 token」。
    unassigned: {
      error_count: uErr,
      warning_count: uWarn,
      suggested_action: suggestedActionFor({ name: 'Unassigned' }, zoneStatusOf(uErr, uWarn)),
    },
    summary,
    zones_stale: zonesStale,
    ...(zoneList.length === 0
      ? { note: '這一頁沒有可辨識的語意區域，因此所有錯誤都在 unassigned 裡——請務必讀它。' }
      : {}),
    ...(zonesStale ? { note: 'DOM 已大幅變動（可能是 SPA 換頁），建議重新呼叫 map_page_zones()。' } : {}),
  };
}

async function bridgeGetZoneErrors(zoneId: string): Promise<Record<string, unknown>> {
  if (!zonesMapped) return { error: '尚未分區。請先呼叫 map_page_zones()。' };
  const z = zoneList.find((x) => x.zone_id === zoneId || x.name === zoneId);
  if (!z && zoneId !== 'Unassigned') {
    return {
      error: `找不到 zone「${zoneId}」`,
      available: [...zoneList.map((x) => ({ zone_id: x.zone_id, name: x.name })), { zone_id: 'Unassigned', name: 'Unassigned' }],
    };
  }
  const key = z ? z.zone_id : 'Unassigned';
  const { buckets } = await collectZoneBuckets();
  const b = buckets.get(key) ?? { errors: [], net: [] };
  const errCount = b.errors.filter((e) => e.level === 'error').length + b.net.length;
  const warnCount = b.errors.filter((e) => e.level === 'warn').length;
  return {
    zone: {
      zone_id: key,
      name: z ? z.name : 'Unassigned',
      status: zoneStatusOf(errCount, warnCount),
      ...(z ? { selector: z.selector } : {}),
    },
    errors: b.errors.map((e) => ({
      level: e.level,
      message: e.message,
      source: e.source ?? 'console',
      element_selector: e.elementSelector ?? null,
      timestamp: e.timestamp,
    })),
    network_fails: b.net.map((n) => ({
      url: n.url,
      status: n.status,
      method: n.method,
      element_selector: n.elementSelector ?? null,
      timestamp: n.timestamp,
    })),
    total_count: b.errors.length + b.net.length,
    window_seconds: 30,
    note: '錯誤來自 inject 的 30 秒滾動緩存（同 get_browser_errors）；element_selector 為 null 代表當下抓不到現場元素，該筆歸入 Unassigned。',
  };
}

// ── PM-344：Zone Grid 視覺化覆蓋層 ─────────────────────────────────────────
const ZONE_BORDER: Record<string, string> = {
  healthy: 'rgba(0,200,83,0.15)',
  warning: 'rgba(255,214,0,0.15)',
  error: 'rgba(255,23,68,0.25)',
  unknown: 'rgba(158,158,158,0.1)',
};
const ZONE_LINE: Record<string, string> = {
  healthy: '#00c853',
  warning: '#ffd600',
  error: '#ff1744',
  unknown: '#9e9e9e',
};
let zoneLayer: HTMLElement | null = null;
let zoneOverlayOn = false;
let zoneHealthCache: Array<{ zone_id: string; status: string; error_count: number; warning_count: number }> = [];

function ensureZoneLayer(): HTMLElement {
  if (zoneLayer && zoneLayer.isConnected) return zoneLayer;
  const el = document.createElement('div');
  el.setAttribute('data-bugezy-zones', '1');
  Object.assign(el.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483644', // 最底層：高亮 645、圖釘 646、面板 647
    pointerEvents: 'none', // §15.5 正解：外層穿透
  } as CSSStyleDeclaration);
  document.documentElement.appendChild(el);
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('@keyframes bugezy-zone-blink{0%,100%{opacity:1}50%{opacity:.45}}');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    /* 不支援就沒有閃爍，框仍在 */
  }
  zoneLayer = el;
  return el;
}

function renderZoneOverlay(): void {
  if (!zoneOverlayOn) return;
  const layer = ensureZoneLayer();
  while (layer.firstChild) layer.removeChild(layer.firstChild);
  for (const z of zoneList) {
    let el: Element | null;
    try {
      el = document.querySelector(z.selector);
    } catch {
      continue;
    }
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const h = zoneHealthCache.find((x) => x.zone_id === z.zone_id);
    const status = h?.status ?? 'unknown';

    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'absolute',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      border: `2px solid ${ZONE_LINE[status]}`,
      background: ZONE_BORDER[status],
      boxSizing: 'border-box',
      pointerEvents: 'none',
      ...(status === 'error' ? { animation: 'bugezy-zone-blink 1.2s ease-in-out infinite' } : {}),
    } as CSSStyleDeclaration);

    // 左上角名稱標籤 —— pointer-events: auto（§15.5 正解：只有小元件可點）
    const label = document.createElement('div');
    label.textContent = z.name;
    Object.assign(label.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      padding: '1px 6px',
      background: ZONE_LINE[status],
      color: '#fff',
      fontSize: '11px',
      fontFamily: 'system-ui,sans-serif',
      pointerEvents: 'auto',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    } as CSSStyleDeclaration);
    label.title = `${z.name}\n${z.selector}\n${z.element_count} 個元素`;

    // 右上角錯誤 badge
    const badge = document.createElement('div');
    const ec = h?.error_count ?? 0;
    const wc = h?.warning_count ?? 0;
    badge.textContent = ec ? `🔴 ×${ec}` : wc ? `🟡 ×${wc}` : status === 'unknown' ? '⚫' : '✅';
    Object.assign(badge.style, {
      position: 'absolute',
      right: '0',
      top: '0',
      padding: '1px 6px',
      background: 'rgba(0,0,0,.65)',
      color: '#fff',
      fontSize: '11px',
      fontFamily: 'system-ui,sans-serif',
      pointerEvents: 'auto',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    } as CSSStyleDeclaration);
    badge.title = `${z.name}：${ec} 個錯誤、${wc} 個警告`;

    box.append(label, badge);
    layer.appendChild(box);
  }
}

let zoneRepositionQueued = false;
function queueZoneReposition(): void {
  if (!zoneOverlayOn || zoneRepositionQueued) return;
  zoneRepositionQueued = true;
  requestAnimationFrame(() => {
    zoneRepositionQueued = false;
    renderZoneOverlay();
  });
}
window.addEventListener('scroll', queueZoneReposition, { passive: true });
window.addEventListener('resize', queueZoneReposition, { passive: true });

async function bridgeShowZoneOverlay(): Promise<Record<string, unknown>> {
  if (zoneList.length === 0) return { error: '尚未分區。請先呼叫 map_page_zones()。' };
  // 順手更新健康狀態，否則覆蓋層會全部是灰色的 unknown
  const health = await bridgeGetZoneHealth();
  const zs = (health.zones ?? []) as typeof zoneHealthCache;
  zoneHealthCache = zs;
  zoneOverlayOn = true;
  renderZoneOverlay();
  return { overlay: 'shown', zone_count: zoneList.length };
}

function bridgeHideZoneOverlay(): Record<string, unknown> {
  zoneOverlayOn = false;
  zoneLayer?.remove();
  zoneLayer = null;
  return { overlay: 'hidden' };
}

// ── PM-345：watch_zones 持續監控（Pull 模式，§15.7 綠框②）──────────────────
//
// MCP 沒有 server 主動推播給模型的通道，所以這裡只做「本地定期掃描 + 累積變化」，
// AI 主動呼叫 get_zone_changes 時才取走。
interface ZoneChange {
  zone_id: string;
  name: string;
  previous_status: string;
  current_status: string;
  timestamp: number;
  new_errors: number;
  suggested_action: string | null;
}
let zoneWatchTimer: number | undefined;
let zoneWatchStartedAt = 0;
let zoneWatchInterval = 10;
let zoneChanges: ZoneChange[] = [];
let zoneTotalChanges = 0;
let lastZoneStatus = new Map<string, { status: string; errors: number }>();

async function scanZones(): Promise<void> {
  if (zoneList.length === 0) return;
  const health = await bridgeGetZoneHealth();
  const zs = (health.zones ?? []) as Array<{
    zone_id: string; name: string; selector: string; status: string; error_count: number; warning_count: number;
  }>;
  zoneHealthCache = zs;
  for (const z of zs) {
    const prev = lastZoneStatus.get(z.zone_id);
    if (prev && prev.status !== z.status) {
      const change: ZoneChange = {
        zone_id: z.zone_id,
        name: z.name,
        previous_status: prev.status,
        current_status: z.status,
        timestamp: Date.now(),
        new_errors: Math.max(0, z.error_count - prev.errors),
        // PM-346：惡化 → 建議深入；好轉 → 建議清理
        suggested_action:
          z.status === 'healthy'
            ? `「${z.name}」已恢復正常，可用 remove_pin("${z.selector}") 清掉先前的圖釘`
            : `呼叫 pin_analyze("${z.selector}") 深度分析「${z.name}」這一區`,
      };
      zoneChanges.push(change);
      zoneTotalChanges++;
    }
    lastZoneStatus.set(z.zone_id, { status: z.status, errors: z.error_count });
  }
  if (zoneOverlayOn) renderZoneOverlay();
}

function bridgeWatchZones(intervalSeconds?: number): Record<string, unknown> {
  if (zoneList.length === 0) return { error: '尚未分區。請先呼叫 map_page_zones()。' };
  zoneWatchInterval = Math.max(2, intervalSeconds ?? 10);
  // 重複呼叫 → **更新間隔而不是再開一個 watcher**（驗收條件 6）
  const restarting = zoneWatchTimer !== undefined;
  if (zoneWatchTimer !== undefined) clearInterval(zoneWatchTimer);
  if (!restarting) {
    zoneWatchStartedAt = Date.now();
    zoneChanges = [];
    zoneTotalChanges = 0;
    lastZoneStatus = new Map();
  }
  void scanZones();
  zoneWatchTimer = setInterval(() => void scanZones(), zoneWatchInterval * 1000) as unknown as number;
  return {
    watching: true,
    zone_count: zoneList.length,
    interval_seconds: zoneWatchInterval,
    ...(restarting ? { note: '已在監控中 → 更新掃描間隔（沒有建立第二個 watcher）' } : {}),
  };
}

function bridgeGetZoneChanges(): Record<string, unknown> {
  const since = zoneWatchStartedAt;
  const out = zoneChanges;
  zoneChanges = []; // 取走即清空 —— 「自上次查詢後的變化」
  return {
    changes: out,
    since_last_check: since,
    watching: zoneWatchTimer !== undefined,
    ...(zoneWatchTimer === undefined
      ? { note: '目前沒有在監控。先呼叫 watch_zones() 才會累積變化。' }
      : out.length === 0
        ? { note: '自上次查詢以來沒有 zone 狀態變化。' }
        : {}),
  };
}

function bridgeStopWatchingZones(): Record<string, unknown> {
  if (zoneWatchTimer === undefined) return { stopped: false, error: '目前沒有在監控 zones。' };
  clearInterval(zoneWatchTimer);
  zoneWatchTimer = undefined;
  return {
    stopped: true,
    duration_seconds: Math.round((Date.now() - zoneWatchStartedAt) / 1000),
    total_changes_detected: zoneTotalChanges,
  };
}

// 分頁關閉／換頁時自動收斂（§15.7 橘框）——不收的話 setInterval 會跟著殘留
window.addEventListener('pagehide', () => {
  if (zoneWatchTimer !== undefined) clearInterval(zoneWatchTimer);
  zoneWatchTimer = undefined;
});

// §15.2 紅框：SPA 換頁後 selector 全部失效。這裡只**標記 stale 不主動重建**——
// 重建成本高，且 AI 下次呼叫 map_page_zones 時本來就會重算。
try {
  const mo = new MutationObserver((records) => {
    let churn = 0;
    for (const r of records) churn += r.addedNodes.length + r.removedNodes.length;
    if (churn >= 10 && zoneList.length > 0) zonesStale = true;
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
} catch {
  /* 極端環境下 MutationObserver 不可用 → 就不標 stale */
}

// ── PM-339：右下角即時面板 ─────────────────────────────────────────────────
//
// 用 **shadow DOM** 隔離：面板注入的是任意使用者的網站，若用一般 DOM，
// 對方的 CSS（`div{...}`、`* { box-sizing }`、reset）會把面板樣式弄爛，
// 而我們的樣式也可能反過來影響對方頁面。shadow root 是唯一能雙向隔離的做法。

interface PanelData {
  pins: { total: number; byStatus: Record<string, number> };
  errors: number | null;
  lcp: { ms: number; rating: string } | null;
  monitoring: boolean;
}

let panelHost: HTMLElement | null = null;
let panelRoot: ShadowRoot | null = null;
let panelExpanded = false;
let panelTimer: number | undefined;
let panelPos = { right: 16, bottom: 16 };

function collectPanelData(): PanelData {
  const byStatus: Record<string, number> = {};
  for (const p of pins.values()) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const fcp = performance.getEntriesByType('paint').find((x) => x.name === 'first-contentful-paint');
  // 面板不主動去要 LCP（那要 async observer），改用同步就拿得到的 FCP 當近似，並標明
  const ms = fcp ? Math.round(fcp.startTime) : nav ? Math.round(nav.responseStart) : 0;
  return {
    pins: { total: pins.size, byStatus },
    errors: lastPanelErrorCount,
    lcp: ms ? { ms, rating: rateVital('FCP', ms) } : null,
    monitoring: pins.size > 0,
  };
}

/** 由 get_browser_errors / get_page_health 呼叫後更新，面板不自己去抓（避免每 10 秒打擾 inject）。 */
let lastPanelErrorCount: number | null = null;

function renderPanel(): void {
  if (!panelRoot) return;
  const d = collectPanelData();
  while (panelRoot.firstChild) panelRoot.removeChild(panelRoot.firstChild);

  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial}
    .wrap{position:fixed;right:${panelPos.right}px;bottom:${panelPos.bottom}px;z-index:2147483647;
      font:12px/1.6 system-ui,-apple-system,"Microsoft JhengHei",sans-serif;color:#e6e6e6}
    .icon{width:36px;height:36px;border-radius:50%;background:#1a1a2e;border:1px solid #7c3aed;
      display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;
      box-shadow:0 2px 10px rgba(0,0,0,.45)}
    .card{width:210px;background:#12121f;border:1px solid #7c3aed;border-radius:10px;
      box-shadow:0 4px 20px rgba(0,0,0,.5);overflow:hidden}
    .hd{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#1a1a2e;
      cursor:move;user-select:none;font-weight:700}
    .hd .sp{flex:1}
    .bd{padding:8px 10px}
    .row{display:flex;justify-content:space-between;padding:2px 0}
    .dim{color:#8b8b9e}
    .ft{display:flex;gap:6px;padding:6px 10px;border-top:1px solid #2a2a3e}
    button{flex:1;background:#232338;color:#c4b5fd;border:1px solid #3a3a52;border-radius:6px;
      padding:3px 0;font-size:11px;cursor:pointer;font-family:inherit}
    button:hover{background:#2d2d47}
  `;
  panelRoot.appendChild(style);

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  if (!panelExpanded) {
    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.textContent = '🐛';
    icon.title = 'BugEzy Debug — 點擊展開';
    icon.addEventListener('click', () => {
      panelExpanded = true;
      renderPanel();
    });
    wrap.appendChild(icon);
    panelRoot.appendChild(wrap);
    return;
  }

  const card = document.createElement('div');
  card.className = 'card';

  const hd = document.createElement('div');
  hd.className = 'hd';
  const t1 = document.createElement('span');
  t1.textContent = '🐛 BugEzy Debug';
  const sp = document.createElement('span');
  sp.className = 'sp';
  hd.append(t1, sp);
  // 拖動：改的是 right/bottom（面板釘在右下角，用 left/top 會在 resize 後跑掉）
  hd.addEventListener('mousedown', (e) => {
    const sx = e.clientX;
    const sy = e.clientY;
    const r0 = panelPos.right;
    const b0 = panelPos.bottom;
    const move = (ev: MouseEvent) => {
      panelPos = {
        right: Math.max(0, r0 - (ev.clientX - sx)),
        bottom: Math.max(0, b0 - (ev.clientY - sy)),
      };
      const w = panelRoot?.querySelector('.wrap') as HTMLElement | null;
      if (w) {
        w.style.right = `${panelPos.right}px`;
        w.style.bottom = `${panelPos.bottom}px`;
      }
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  const bd = document.createElement('div');
  bd.className = 'bd';
  const addRow = (label: string, value: string) => {
    const row = document.createElement('div');
    row.className = 'row';
    const a = document.createElement('span');
    a.textContent = label;
    const b = document.createElement('span');
    b.className = 'dim';
    b.textContent = value;
    row.append(a, b);
    bd.appendChild(row);
  };
  const pinBits = Object.entries(d.pins.byStatus)
    .map(([k, n]) => `${PIN_STATUS_EMOJI[k as Pin['status']] ?? ''}${n}`)
    .join(' ');
  addRow('📍 Pins', d.pins.total ? `${d.pins.total} (${pinBits})` : '0');
  addRow('❌ Errors', d.errors === null ? '未查詢' : String(d.errors));
  addRow('⚡ FCP', d.lcp ? `${(d.lcp.ms / 1000).toFixed(1)}s (${d.lcp.rating})` : '—');
  addRow('🕐 狀態', d.monitoring ? '監控中' : '待命');

  const ft = document.createElement('div');
  ft.className = 'ft';
  const bCollapse = document.createElement('button');
  bCollapse.textContent = 'Collapse';
  bCollapse.addEventListener('click', () => {
    panelExpanded = false;
    renderPanel();
  });
  const bClose = document.createElement('button');
  bClose.textContent = 'Close';
  bClose.addEventListener('click', () => hideDebugPanel());
  ft.append(bCollapse, bClose);

  card.append(hd, bd, ft);
  wrap.appendChild(card);
  panelRoot.appendChild(wrap);
}

function showDebugPanel(): Record<string, unknown> {
  if (!panelHost || !panelHost.isConnected) {
    panelHost = document.createElement('div');
    panelHost.setAttribute('data-bugezy-panel', '1');
    document.documentElement.appendChild(panelHost);
    panelRoot = panelHost.attachShadow({ mode: 'open' });
  }
  renderPanel();
  if (panelTimer === undefined) {
    panelTimer = setInterval(renderPanel, 10_000) as unknown as number; // 每 10 秒更新
  }
  return { panel: 'shown', expanded: panelExpanded };
}

function hideDebugPanel(): Record<string, unknown> {
  if (panelTimer !== undefined) {
    clearInterval(panelTimer);
    panelTimer = undefined;
  }
  panelHost?.remove();
  panelHost = null;
  panelRoot = null;
  return { panel: 'hidden' };
}

// ── PM-337：藍框巡察動畫（highlightElement）────────────────────────────────
//
// 純視覺增強，**不新增 MCP 工具**：讓使用者看得到「AI 現在在看哪個元素」。
// 與圖釘覆蓋層分開兩層 —— 高亮是短暫的、會自動消失，圖釘是常駐的，
// 混在同一層會讓高亮的清除邏輯把圖釘一起洗掉。

const HIGHLIGHT_MAX = 5; // 同時最多 5 個，超過先進先出
const HIGHLIGHT_COLOR = '#00bfff';
let highlightLayer: HTMLElement | null = null;
const activeHighlights: Array<{ el: HTMLElement; timer: number }> = [];

function ensureHighlightLayer(): HTMLElement {
  if (highlightLayer && highlightLayer.isConnected) return highlightLayer;
  const el = document.createElement('div');
  el.setAttribute('data-bugezy-highlights', '1');
  Object.assign(el.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483645', // 比圖釘層低一階，圖釘要蓋在高亮之上
    pointerEvents: 'none',
  } as CSSStyleDeclaration);
  document.documentElement.appendChild(el);
  // 脈衝動畫用 CSSStyleSheet 而非注入 <style> 字串（Trusted Types 網站會擋字串）
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      '@keyframes bugezy-pulse{0%,100%{opacity:1}50%{opacity:.35}}' +
        '.bugezy-hl{animation:bugezy-pulse 0.8s ease-in-out infinite}',
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    /* 舊瀏覽器不支援 adoptedStyleSheets → 沒有脈衝動畫，但框仍在 */
  }
  highlightLayer = el;
  return el;
}

function dropHighlight(entry: { el: HTMLElement; timer: number }): void {
  clearTimeout(entry.timer);
  entry.el.remove();
  const i = activeHighlights.indexOf(entry);
  if (i >= 0) activeHighlights.splice(i, 1);
}

/**
 * 在元素上畫一個藍色虛線框。找不到元素時**靜默略過** ——
 * 這是純視覺功能，不該讓它的失敗影響到呼叫端真正的工作。
 */
function highlightElement(
  selector: string,
  opts: { durationMs?: number; color?: string; label?: string } = {},
): void {
  let target: Element | null;
  try {
    target = document.querySelector(selector);
  } catch {
    return;
  }
  if (!target) return;
  const r = target.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return;

  const layer = ensureHighlightLayer();
  const box = document.createElement('div');
  box.className = 'bugezy-hl';
  Object.assign(box.style, {
    position: 'absolute',
    left: `${r.left - 2}px`,
    top: `${r.top - 2}px`,
    width: `${r.width + 4}px`,
    height: `${r.height + 4}px`,
    border: `2px dashed ${opts.color || HIGHLIGHT_COLOR}`,
    borderRadius: '4px',
    boxSizing: 'border-box',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);

  if (opts.label) {
    const tag = document.createElement('div');
    tag.textContent = opts.label; // textContent 而非 innerHTML
    Object.assign(tag.style, {
      position: 'absolute',
      left: '0',
      top: '-20px',
      padding: '1px 6px',
      background: opts.color || HIGHLIGHT_COLOR,
      color: '#fff',
      fontSize: '11px',
      borderRadius: '3px',
      whiteSpace: 'nowrap',
    } as CSSStyleDeclaration);
    box.appendChild(tag);
  }
  layer.appendChild(box);

  const entry = { el: box, timer: 0 };
  entry.timer = setTimeout(() => dropHighlight(entry), opts.durationMs ?? 2000) as unknown as number;
  activeHighlights.push(entry);
  // 超過上限 → 最舊的先消失
  while (activeHighlights.length > HIGHLIGHT_MAX) dropHighlight(activeHighlights[0]);
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
  /**
   * PM-387：使用者手動標記「我處理完了」。
   *
   * ⚠ **刻意做成獨立欄位，而不是加進 `status` 的列舉。** PM-329／335 已經確認
   * `resolved` 不是這個模型裡的狀態（合法值只有 active/warning/error/stale，
   * `clear_pins` 的參數驗證也是照這四種寫的）。而且語意上兩者是垂直的：
   * 一個被標記為「已解決」的圖釘，其元素狀態仍然可能是 active 或 error。
   * 混進同一個欄位會讓 `patrol_pins` 的狀態變化偵測失去意義。
   */
  resolved?: boolean;
}

const pins = new Map<string, Pin>();
let pinSeq = 0;
let pinLayer: HTMLElement | null = null;
let pinRepositionQueued = false;

// PM-338：圖釘狀態顏色系統。
//   卡片的色表列了 `resolved → 淡綠`，但 **`resolved` 在目前的模型裡不存在**
//   （PM-329 已把它換成 `warning`），所以這裡對應的是實際會出現的四種狀態。
const PIN_STATUS_COLOR: Record<Pin['status'], string> = {
  active: '#00c853', // 正常
  warning: '#ffd600', // 有警告（不可見／尺寸 0／disabled）
  error: '#ff1744', // 有錯誤
  stale: '#9e9e9e', // 元素已從 DOM 消失
};
/** 給 AI 掃讀用的狀態符號（patrol_pins 的 summary 前綴）。 */
const PIN_STATUS_EMOJI: Record<Pin['status'], string> = {
  active: '🟢',
  warning: '🟡',
  error: '🔴',
  stale: '⚪',
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
      // PM-387：已解決 → 淡綠（卡片色表裡的那一格，現在真的有東西對應了）
      background: pin.resolved ? '#a5d6a7' : PIN_STATUS_COLOR[pin.status],
      border: '2px solid #fff',
      boxShadow: '0 1px 4px rgba(0,0,0,.4)',
      pointerEvents: 'auto', // 只有圓點可點（PM-304 的結論：整層 none 就收不到點擊）
      cursor: 'context-menu',
      opacity: pin.resolved ? '0.75' : '1',
    } as CSSStyleDeclaration);
    dot.title = `📌 ${pin.description || '(無描述)'}
${pin.selector}
狀態：${pin.status}${pin.resolved ? '（已標記解決）' : ''}
右鍵：分析／修改描述／標記已解決／移除`;
    // PM-387：右鍵開自訂選單。**preventDefault 只針對圖釘本身**——
    //   釘選模式下頁面其他地方的右鍵不攔（卡片明訂保留正常右鍵選單）。
    dot.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openPinMenu(ev.clientX, ev.clientY, pin);
    });
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
  highlightElement(selector, { durationMs: 1000, label: '📌 釘選' }); // PM-337
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

async function bridgePinAnalyze(selector: string): Promise<Record<string, unknown>> {
  const existingPin = findPinBySelector(selector);
  // 先確保有圖釘（沒有就自動建立）
  const pinned = bridgePinElement(selector, '');
  if (typeof pinned.error === 'string') {
    // 🔴 元素找不到時，**已存在的圖釘要標成 stale**，不能只回一個裸錯誤就走。
    //    否則巡檢（patrol_pins）看到的還是舊的 active，等於「元素消失了但沒人發現」。
    //    （這個洞是 PM-334 的測試抓到的：移除元素後巡檢仍回 status: 'active'、changed: false。）
    if (existingPin) {
      existingPin.status = 'stale';
      existingPin.last_check = { at: Date.now(), summary: '元素已從頁面消失' };
      queueReposition();
      return {
        pin_id: existingPin.id,
        selector,
        status: 'stale',
        summary: existingPin.last_check.summary,
      };
    }
    return pinned;
  }
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

  const vis = analysis.visibility as { visible?: boolean; has_size?: boolean } | undefined;
  const attrs = (analysis.attributes ?? {}) as Record<string, string>;
  const problems: string[] = [];
  if (!vis?.visible) problems.push('元素不可見');
  if (!vis?.has_size) problems.push('尺寸為 0');
  if ('disabled' in attrs) problems.push('disabled');

  // PM-392／393：靜態分析之後**再做動態探測**（追加，不取代）。
  //   不可見／尺寸 0 的元素不探測——點一個看不到的東西沒有意義，而且風險不對稱。
  const el2 = document.querySelector(selector);
  const probe: ProbeResult =
    el2 && vis?.visible && vis?.has_size
      ? await probeWithTimeout(el2)
      : { type: 'static_only', errors_triggered: [], network_errors_triggered: [], duration_ms: 0, note: '元素不可見或尺寸為 0，未做動態探測。' };

  const [status, summary] = pinStatusFromProbe(problems, probe);
  pin.status = status;
  pin.last_check = { at: Date.now(), summary };
  queueReposition();

  return { pin_id: pin.id, selector, status: pin.status, summary, analysis, probe };
}

/**
 * PM-334：巡檢所有圖釘。逐一跑 `analyze_element` 的邏輯，比對上次結果、回報變化。
 *
 * 巡檢順序**按建立時間**（先釘的先巡）—— Map 的插入順序剛好就是建立順序，
 * 但為了不依賴這個隱含性質，明確用 `created_at` 排序。
 */
/**
 * PM-394：巡檢的**總時間預算**。
 *
 * 每個圖釘的動態探測最多 5 秒，N 個圖釘就可能是 N×5 秒——bridge 那端的指令逾時
 * 會先炸掉，使用者只會看到「逾時」而完全不知道發生什麼事。所以這裡設總預算，
 * 超過之後剩下的圖釘**只做靜態分析並如實說明**，而不是默默截斷或整支失敗。
 */
const PATROL_PROBE_BUDGET_MS = 20_000;

async function bridgePatrolPins(): Promise<Record<string, unknown>> {
  const ordered = [...pins.values()].sort((a, b) => a.created_at - b.created_at);
  const startedAt = Date.now();
  let budgetExceeded = 0;
  const results = [];
  for (const pin of ordered) {
    const previous_status = pin.status;
    const prevSummary = pin.last_check?.summary ?? null;
    // 複用 pin_analyze 的分析路徑（它本身又複用 bridgeAnalyzeElement），不另寫一套
    //（bridgePinAnalyze → bridgeAnalyzeElement 內已含 PM-337 的高亮，巡檢時會依序閃過每個圖釘）
    if (Date.now() - startedAt < PATROL_PROBE_BUDGET_MS) {
      await bridgePinAnalyze(pin.selector);
    } else {
      budgetExceeded++;
      probeSkipForBudget(pin);
    }
    const changed = pin.status !== previous_status || pin.last_check?.summary !== prevSummary;
    let summary: string;
    if (pin.status === 'stale') {
      summary = previous_status === 'stale' ? '元素仍不存在' : `元素已消失（${previous_status} → stale）`;
    } else if (changed) {
      summary = `${previous_status} → ${pin.status}：${pin.last_check?.summary ?? ''}`;
    } else {
      summary = pin.last_check?.summary ?? '無變化';
    }
    results.push({
      pin_id: pin.id,
      selector: pin.selector,
      description: pin.description,
      status: pin.status,
      previous_status,
      changed,
      // PM-338：狀態顏色 emoji，讓 AI 掃一眼就知道輕重
      summary: `${PIN_STATUS_EMOJI[pin.status]} ${summary}`,
    });
  }
  queueReposition();
  // PM-394：alert_count 把「動態探測發現的問題」也算進去 ——
  //   一個狀態沒變但一直是 error 的圖釘，對「這次巡檢要不要理它」而言仍然是需要注意的。
  //   兩個數字都給，因為它們回答的是不同問題。
  const problem_count = results.filter((r) => r.status === 'error' || r.status === 'stale').length;
  return {
    patrolled: results.length,
    results,
    alert_count: results.filter((r) => r.changed || r.status === 'error').length,
    changed_count: results.filter((r) => r.changed).length,
    problem_count,
    ...(budgetExceeded
      ? { note: `時間預算（${PATROL_PROBE_BUDGET_MS / 1000} 秒）用完，最後 ${budgetExceeded} 個圖釘只做了靜態檢查。要完整探測請分批或減少圖釘數量。` }
      : {}),
    ...(results.length === 0
      ? { note: '這個分頁目前沒有任何圖釘。用 pin_element 或 pin_analyze 建立後再巡檢。' }
      : {}),
  };
}

/** 預算用完時的退路：只做靜態檢查，並如實寫進 summary。 */
function probeSkipForBudget(pin: Pin): void {
  const el = document.querySelector(pin.selector);
  if (!el) {
    pin.status = 'stale';
    pin.last_check = { at: Date.now(), summary: '元素已從頁面消失' };
    return;
  }
  pin.last_check = { at: Date.now(), summary: '（巡檢時間預算用完，本次只做靜態檢查）' };
}

/** PM-335：移除單一圖釘（pin_id 優先，其次 selector）。 */
function bridgeRemovePin(pinId?: string, selector?: string): Record<string, unknown> {
  const pin = pinId ? pins.get(pinId) : selector ? findPinBySelector(selector) : undefined;
  if (!pin) {
    return {
      error: pinId
        ? `找不到圖釘 ${pinId}`
        : selector
          ? `找不到釘在「${selector}」的圖釘`
          : '需要提供 pin_id 或 selector 其中之一',
      available: [...pins.values()].map((p) => ({ pin_id: p.id, selector: p.selector })),
    };
  }
  pins.delete(pin.id);
  queueReposition(); // 重畫覆蓋層 → 該圖釘的圓點隨之消失
  return { removed: true, pin_id: pin.id, selector: pin.selector, remaining: pins.size };
}

/**
 * PM-335：批次清除圖釘。
 *
 * ⚠ 卡片的 status enum 寫 `'all' | 'resolved' | 'stale'`，但 **`resolved` 在目前的模型裡不存在**——
 *   PM-329 已把它換成 `warning`（`resolved` 當時沒有任何程式路徑會去設定它）。
 *   若照字面接受 `resolved`，會得到一個**永遠篩不到東西的過濾器**：AI 呼叫後拿到
 *   `cleared: 0`，卻無從得知是「沒有符合的」還是「這個值根本沒用」。
 *   所以這裡收的是**實際存在的狀態**，並在傳入 `resolved` 時明確告知。
 */
function bridgeClearPins(status?: string): Record<string, unknown> {
  const target = status || 'all';
  const VALID = ['all', 'active', 'warning', 'error', 'stale'];
  if (target === 'resolved') {
    return {
      error:
        "目前的圖釘狀態沒有 'resolved'（PM-329 已改為 active / warning / error / stale）。" +
        "要清掉已處理的圖釘請用 remove_pin，或改用 status: 'active'。",
      valid_status: VALID,
    };
  }
  if (!VALID.includes(target)) {
    return { error: `不支援的 status：${target}`, valid_status: VALID };
  }
  const doomed = [...pins.values()].filter((p) => target === 'all' || p.status === target);
  for (const p of doomed) pins.delete(p.id);
  queueReposition();
  return { cleared: doomed.length, status: target, remaining: pins.size };
}

function bridgeGetPinResults(): Record<string, unknown> {
  repositionPins(); // 順便重算，讓 stale 狀態即時更新
  return {
    pins: [...pins.values()].map((p) => ({
      pin_id: p.id,
      selector: p.selector,
      description: p.description,
      status: p.status,
      // PM-387：人工標記「已處理」。status 仍是四種之一，這是額外的一維資訊。
      resolved: p.resolved === true,
      created_at: p.created_at,
      last_check: p.last_check,
    })),
    total_count: pins.size,
    // 無圖釘時回**空陣列**而不是 error（驗收條件 3）
    ...(pins.size === 0 ? { note: '這個分頁目前沒有任何圖釘。用 pin_element 或 pin_analyze 建立。' } : {}),
  };
}

// ── PM-392～394：動態探測（pin_analyze 從「看」升級成「試」）──────────────
//
// 🔴 **這是整個專案裡唯一會主動操作使用者頁面的功能。** 靜態分析只是讀 DOM，
//    動態探測會真的按下按鈕、真的往輸入框打字。因此每一項都必須是「可還原」或
//    「明確拒絕」，沒有中間地帶：
//
//    ① 改過的東西一定還原（值／checked／selectedIndex），並回報 `restored`
//    ② `a[href]` 絕對不 click（會導航，把使用者的頁面狀態帶走）
//    ③ 密碼欄位不碰
//    ④ 表單送出在探測期間被攔下來（click 一個 submit 鈕不該真的送出訂單）
//    ⑤ **看起來會造成破壞的按鈕直接跳過**（刪除／付款／送出…）——卡片沒列這條，
//       但 `patrol_pins` 會**每次巡檢都重跑一遍探測**，一個「刪除帳號」按鈕被反覆點
//       是不可接受的。寧可少測一個按鈕，也不要幫使用者按下他不想按的東西。
//    ⑥ 全程有時間上限，不會 hang 住

/**
 * PM-395 防線①：**探測期間**。
 *
 * `probeElement` 會呼叫 `el.click()` 模擬點擊，而釘選模式在 capture 階段攔所有 click——
 * 結果是「使用者在 popup 按 [分析]」竟然會跳出描述輸入框。這兩個功能單獨看都對，
 * 合在一起才壞掉（PM-384 的攔截 + PM-392 的模擬點擊）。
 *
 * ⚠ 用**模組層變數**而不是卡片寫的 `window.__bugezy_probing`：
 *   content script 的 window 雖然是 isolated 的，但把內部狀態掛上 window 沒有任何好處，
 *   反而多一個會被誤改的表面。這個旗標只有本檔案需要看得到。
 */
let isProbing = false;

/**
 * PM-395 防線③：**整個分析／巡檢期間**。
 *
 * 防線①只涵蓋 `el.click()` 那一瞬間；探測還會 dispatch input／change，
 * 頁面自己的 handler 也可能在稍後同步觸發 click。用計數器而不是布林——
 * 巡檢會對每個圖釘各跑一次分析，巢狀時不能被內層的「恢復」提前解除。
 */
let pinModeSuspendDepth = 0;

/** 分析／巡檢期間暫停釘選模式的攔截。**一定要用 try/finally**，否則探測一拋例外就永久卡住。 */
async function withPinModeSuspended<T>(fn: () => Promise<T>): Promise<T> {
  pinModeSuspendDepth++;
  try {
    return await fn();
  } finally {
    pinModeSuspendDepth--;
  }
}

/** 單次探測的硬上限（卡片指定 5 秒）。 */
const PROBE_HARD_TIMEOUT_MS = 5000;
/** 點擊之後等錯誤浮現的時間（卡片指定 2 秒）。 */
const PROBE_CLICK_WAIT_MS = 2000;
/** 其餘互動的等待時間（卡片指定 1 秒）。 */
const PROBE_INTERACT_WAIT_MS = 1000;
/** 探測時填進輸入框的值。刻意用一眼看得出是誰放的字串。 */
const PROBE_INPUT_VALUE = 'BugEzy_probe_test';

interface ProbeError {
  level: string;
  message: string;
  timestamp: number;
}

interface ProbeNetworkError {
  url: string;
  status: number;
  method: string;
  timestamp: number;
}

interface ProbeResult {
  type:
    | 'click'
    | 'link_check'
    | 'input'
    | 'select'
    | 'toggle'
    | 'media_check'
    | 'animation_check'
    | 'static_only'
    | 'skipped_destructive'
    | 'skipped_sensitive';
  errors_triggered: ProbeError[];
  /** PM-396：探測期間新增的失敗請求（4xx/5xx/網路失敗）。 */
  network_errors_triggered: ProbeNetworkError[];
  duration_ms: number;
  restored?: boolean;
  status?: number | null;
  reachable?: boolean;
  loaded?: boolean;
  media_error?: string;
  animations?: number;
  all_running?: boolean;
  note?: string;
}

/**
 * 看起來會造成破壞的動作。比對按鈕的可見文字、`aria-label`、`name`、`value`、`id`、class。
 *
 * 這是**保守的樣式比對，不是完備的判定** —— 它擋掉最明顯的那一類。
 * 擋錯（把安全的按鈕當成危險）的代價只是少測一個元素並如實說明；
 * 漏擋的代價是幫使用者按下刪除。兩邊不對稱，所以寧可寬鬆地擋。
 */
const DESTRUCTIVE_PATTERN =
  /(刪除|删除|移除|清除|清空|註銷|注销|登出|登出帳號|停用|解除|退訂|取消訂閱|送出|提交|下單|訂購|購買|付款|結帳|支付|確認付款|轉帳|匯款|發送|寄出|重設|重置|回復原廠)|(\b(delete|remove|destroy|erase|clear|wipe|drop|purge|deactivate|disable|unsubscribe|logout|sign\s*out|submit|checkout|purchase|buy|pay|order|charge|transfer|send|reset|revoke|terminate|cancel)\b)/i;

function looksDestructive(el: Element): string | null {
  const bits = [
    (el.textContent ?? '').slice(0, 120),
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('title') ?? '',
    el.getAttribute('name') ?? '',
    (el as HTMLInputElement).value ?? '',
    el.id ?? '',
    typeof el.className === 'string' ? el.className : '',
  ].join(' ');
  const m = DESTRUCTIVE_PATTERN.exec(bits);
  return m ? m[0] : null;
}

/**
 * 執行 `action`，並收集這段期間**新增**的瀏覽器錯誤。
 *
 * ⚠ 用的是 `queryInjectLiveErrors()`（inject.ts 在 MAIN world 攔下來的那一份），
 *   **不是在 content script 掛 `window.addEventListener('error')`** —— content script
 *   跑在 ISOLATED world，頁面 script 的 `console.error` 根本不會經過它。
 *   走既有的 inject 通道是這個專案裡唯一已經驗證過可行的路（PM-51／181／313）。
 */
interface CollectedDuring {
  errors: ProbeError[];
  networkErrors: ProbeNetworkError[];
}

type RawNet = { url?: string; status?: number; method?: string; timestamp?: number };
const netKey = (n: RawNet): string => `${n.method}:${n.url}:${n.status}:${n.timestamp}`;

async function collectErrorsDuring(action: () => void | Promise<void>, waitMs: number): Promise<CollectedDuring> {
  let beforeLogs: Array<{ level?: string; message?: string; timestamp?: number }> = [];
  let beforeNet: RawNet[] = [];
  try {
    const b = await queryInjectLiveErrors();
    beforeLogs = b.consoleLogs ?? [];
    beforeNet = (b.networkErrors ?? []) as RawNet[];
  } catch {
    /* 拿不到基準就當作空的——寧可多報幾筆，也不要因此整支探測失敗 */
  }
  const seenLogs = new Set(beforeLogs.map((e) => `${e.level}:${e.message}:${e.timestamp}`));
  const seenNet = new Set(beforeNet.map(netKey));

  try {
    await action();
  } catch (e) {
    // action 自己丟出來的例外也是一種「這個操作會炸」的證據，要記下來
    return {
      errors: [{ level: 'error', message: `探測動作本身拋出例外：${String(e)}`, timestamp: Date.now() }],
      networkErrors: [],
    };
  }

  await new Promise((r) => setTimeout(r, waitMs));

  try {
    const a = await queryInjectLiveErrors();
    return {
      errors: (a.consoleLogs ?? [])
        .filter((e) => e.level !== 'info' && !seenLogs.has(`${e.level}:${e.message}:${e.timestamp}`))
        .map((e) => ({
          level: String(e.level ?? 'error'),
          message: String(e.message ?? ''),
          timestamp: Number(e.timestamp ?? Date.now()),
        })),
      // PM-396：**點擊的後果常常不是 JS 例外，而是一個失敗的請求。**
      //   只看 console 的話，「點了按鈕 → 打 API → 回 500」會被判成 🟢，
      //   而那正是使用者最想抓到的那種 bug。
      //   inject.ts 的 network 攔截本來就只收 4xx/5xx（智能過濾），所以這裡不必再篩狀態碼。
      networkErrors: ((a.networkErrors ?? []) as RawNet[])
        .filter((n) => !seenNet.has(netKey(n)))
        .map((n) => ({
          url: String(n.url ?? ''),
          status: Number(n.status ?? 0),
          method: String(n.method ?? 'GET'),
          timestamp: Number(n.timestamp ?? Date.now()),
        })),
    };
  } catch {
    return { errors: [], networkErrors: [] };
  }
}

/** PM-396：網路失敗的嚴重度。5xx 與 0（CORS／連不上）算 critical，4xx 算 minor。 */
function isCriticalNetwork(n: ProbeNetworkError): boolean {
  return n.status >= 500 || n.status === 0;
}

/** 探測期間把表單送出攔下來。回傳解除函式。 */
function suppressFormSubmit(el: Element): () => void {
  const form = el.closest('form');
  if (!form) return () => {};
  const stop = (ev: Event): void => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  form.addEventListener('submit', stop, true);
  return () => form.removeEventListener('submit', stop, true);
}

/** 依元素類型選擇探測動作。**一定回傳結果，不會拋例外。** */
async function probeElement(el: Element): Promise<ProbeResult> {
  const t0 = Date.now();
  const done = (r: Omit<ProbeResult, 'duration_ms'>): ProbeResult => ({ ...r, duration_ms: Date.now() - t0 });
  const tag = el.tagName.toLowerCase();

  try {
    // ── 敏感欄位一律不碰 ──
    if (isSensitiveField(el) || (el as HTMLInputElement).type === 'password') {
      return done({ type: 'skipped_sensitive', errors_triggered: [], network_errors_triggered: [], note: '敏感欄位（密碼／個資）不做動態探測。' });
    }

    // ── a[href]：**絕對不 click**，改用 HEAD 檢查可達性 ──
    if (tag === 'a' && el.hasAttribute('href')) {
      const href = (el as HTMLAnchorElement).href;
      if (!/^https?:/i.test(href)) {
        return done({ type: 'link_check', errors_triggered: [], network_errors_triggered: [], status: null, reachable: false, note: `非 http(s) 連結（${href.slice(0, 40)}），未檢查。` });
      }
      try {
        // no-cors 拿不到真實 status（opaque response），所以 status 誠實回 null，
        // 只回報「連得上／連不上」——編一個 200 出來比不給答案更糟。
        await fetch(href, { method: 'HEAD', mode: 'no-cors' });
        return done({ type: 'link_check', errors_triggered: [], network_errors_triggered: [], status: null, reachable: true, note: 'no-cors 模式拿不到實際狀態碼，只能確認連得上。' });
      } catch {
        return done({ type: 'link_check', errors_triggered: [], network_errors_triggered: [], status: null, reachable: false, note: '連線失敗（可能是網址錯誤或伺服器沒回應）。' });
      }
    }

    // ── button / [role=button] / input[type=submit|button] ──
    const isButton =
      tag === 'button' ||
      el.getAttribute('role') === 'button' ||
      (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes((el as HTMLInputElement).type));
    if (isButton) {
      const danger = looksDestructive(el);
      if (danger) {
        return done({
          type: 'skipped_destructive',
          errors_triggered: [], network_errors_triggered: [],
          note: `按鈕文字／屬性含「${danger}」，看起來會造成破壞性操作，已跳過點擊。要測請自己點一次再看 get_browser_errors()。`,
        });
      }
      const release = suppressFormSubmit(el);
      const got = await collectErrorsDuring(() => {
        // PM-395：模擬點擊期間掛旗標，讓釘選模式的 capture handler 放行
        isProbing = true;
        try {
          (el as HTMLElement).click();
        } finally {
          isProbing = false;
        }
      }, PROBE_CLICK_WAIT_MS);
      release();
      return done({
        type: 'click',
        errors_triggered: got.errors,
        network_errors_triggered: got.networkErrors,
        restored: true,
        note: got.errors.length === 0 && got.networkErrors.length === 0
          // 誠實揭露觀測窗口：慢於 2 秒才回來的請求這次看不到，不代表沒問題
          ? `探測期間已攔下表單送出；只涵蓋點擊後 ${PROBE_CLICK_WAIT_MS / 1000} 秒內完成的請求。`
          : '探測期間已攔下表單送出。',
      });
    }

    // ── 文字輸入 ──
    const isTextInput =
      (tag === 'input' && ['text', 'search', 'url', 'tel', 'number', ''].includes((el as HTMLInputElement).type)) ||
      tag === 'textarea';
    if (isTextInput) {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      if (input.disabled || input.readOnly) {
        return done({ type: 'static_only', errors_triggered: [], network_errors_triggered: [], note: 'disabled／readonly 欄位，不做輸入探測。' });
      }
      const original = input.value;
      const setValue = (v: string): void => {
        // 繞過 React 的 _valueTracker（沿用 bridgeTypeText 的做法，不另寫一套）
        const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, v);
        else input.value = v;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const got = await collectErrorsDuring(() => {
        input.focus?.();
        setValue(PROBE_INPUT_VALUE);
        input.blur?.();
      }, PROBE_INTERACT_WAIT_MS);
      setValue(original); // 還原
      return done({
        type: 'input',
        errors_triggered: got.errors,
        network_errors_triggered: got.networkErrors,
        restored: input.value === original,
      });
    }

    // ── select ──
    if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      if (sel.disabled || sel.options.length < 2) {
        return done({ type: 'static_only', errors_triggered: [], network_errors_triggered: [], note: sel.disabled ? 'disabled 的下拉選單。' : '只有一個選項，沒有可切換的對象。' });
      }
      const original = sel.selectedIndex;
      const next = (original + 1) % sel.options.length;
      const got = await collectErrorsDuring(() => {
        sel.selectedIndex = next;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }, PROBE_INTERACT_WAIT_MS);
      sel.selectedIndex = original;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return done({
        type: 'select',
        errors_triggered: got.errors,
        network_errors_triggered: got.networkErrors,
        restored: sel.selectedIndex === original,
      });
    }

    // ── checkbox / radio ──
    if (tag === 'input' && ['checkbox', 'radio'].includes((el as HTMLInputElement).type)) {
      const box = el as HTMLInputElement;
      if (box.disabled) return done({ type: 'static_only', errors_triggered: [], network_errors_triggered: [], note: 'disabled 的勾選欄位。' });
      // radio 一旦切走就回不到「全部都沒選」的狀態，但切回原本那顆是等價的
      const original = box.checked;
      const release = suppressFormSubmit(el);
      const got = await collectErrorsDuring(() => {
        isProbing = true; // PM-395：同上，change 也可能同步引發頁面的 click 邏輯
        try {
          box.checked = !original;
          box.dispatchEvent(new Event('input', { bubbles: true }));
          box.dispatchEvent(new Event('change', { bubbles: true }));
        } finally {
          isProbing = false;
        }
      }, PROBE_INTERACT_WAIT_MS);
      box.checked = original;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      release();
      return done({
        type: 'toggle',
        errors_triggered: got.errors,
        network_errors_triggered: got.networkErrors,
        restored: box.checked === original,
      });
    }

    // ── 媒體（純檢查，不播放）──
    if (tag === 'img') {
      const img = el as HTMLImageElement;
      const loaded = img.complete && img.naturalWidth > 0;
      return done({
        type: 'media_check',
        errors_triggered: [], network_errors_triggered: [],
        loaded,
        ...(loaded ? {} : { media_error: img.complete ? '已載入完成但寬度為 0（圖片壞掉或格式不支援）' : '尚未載入完成' }),
        note: img.currentSrc || img.src ? `來源：${(img.currentSrc || img.src).slice(0, 120)}` : '沒有 src',
      });
    }
    if (tag === 'video' || tag === 'audio' || tag === 'source') {
      const media = (tag === 'source' ? el.parentElement : el) as HTMLMediaElement | null;
      const readyState = media?.readyState ?? 0;
      const err = media?.error;
      return done({
        type: 'media_check',
        errors_triggered: [], network_errors_triggered: [],
        loaded: readyState >= 2, // HAVE_CURRENT_DATA 以上才算真的有東西
        ...(err ? { media_error: `MediaError code ${err.code}` } : {}),
        note: `readyState=${readyState}`,
      });
    }

    // ── 動畫 ──
    const anims = typeof (el as Element & { getAnimations?: () => Animation[] }).getAnimations === 'function'
      ? (el as Element & { getAnimations: () => Animation[] }).getAnimations()
      : [];
    if (anims.length > 0) {
      const running = anims.filter((a) => a.playState === 'running' || a.playState === 'finished');
      return done({
        type: 'animation_check',
        errors_triggered: [], network_errors_triggered: [],
        animations: anims.length,
        all_running: running.length === anims.length,
        ...(running.length === anims.length
          ? {}
          : { note: `${anims.length - running.length} 個動畫處於 ${anims.map((a) => a.playState).join('／')} 狀態` }),
      });
    }

    return done({ type: 'static_only', errors_triggered: [], network_errors_triggered: [], note: '這個元素沒有可自動探測的互動方式。' });
  } catch (e) {
    // 探測**永遠不該讓 pin_analyze 整支失敗** —— 靜態分析的結果仍然有價值
    return done({ type: 'static_only', errors_triggered: [], network_errors_triggered: [], note: `探測過程發生例外，已略過：${String(e).slice(0, 120)}` });
  }
}

/** 套上硬性逾時，避免頁面自己的 handler 卡住整個探測。 */
async function probeWithTimeout(el: Element): Promise<ProbeResult> {
  const t0 = Date.now();
  return Promise.race([
    probeElement(el),
    new Promise<ProbeResult>((resolve) =>
      setTimeout(
        () =>
          resolve({
            type: 'static_only',
            errors_triggered: [], network_errors_triggered: [],
            duration_ms: Date.now() - t0,
            note: `探測超過 ${PROBE_HARD_TIMEOUT_MS / 1000} 秒上限已中止（頁面的 handler 可能卡住了，這本身就值得看一下）。`,
          }),
        PROBE_HARD_TIMEOUT_MS,
      ),
    ),
  ]);
}

/**
 * PM-393：把靜態問題與探測結果合起來決定圖釘狀態。
 * 回傳 `[status, summary]`。
 */
function pinStatusFromProbe(
  staticProblems: string[],
  probe: ProbeResult,
): ['active' | 'warning' | 'error', string] {
  const errs = probe.errors_triggered;
  // critical 的判定與 §6 一致：error 級的 console 訊息、或經典 JS 錯誤型別
  const critical = errs.filter(
    (e) => e.level === 'error' || /\b(TypeError|ReferenceError|SyntaxError|RangeError|Uncaught)\b/.test(e.message),
  );
  const minor = errs.filter((e) => !critical.includes(e));

  // PM-396：網路失敗與 JS 錯誤**同等重要**。點一個按鈕最常見的後果不是拋例外，
  //   而是打出去的 API 回了 500 —— 只看 console 會把那種情況判成 🟢，
  //   而那正是使用者最想抓到的 bug。分級與 §6 一致：5xx／0 = critical、4xx = minor。
  const net = probe.network_errors_triggered ?? [];
  const netCritical = net.filter(isCriticalNetwork);
  const netMinor = net.filter((n) => !isCriticalNetwork(n));

  if (critical.length) {
    const first = critical[0].message.replace(/\s+/g, ' ').slice(0, 120);
    return ['error', `🔴 ${probeVerb(probe.type)}觸發 ${first}`];
  }
  if (netCritical.length) {
    const n = netCritical[0];
    const what = n.status === 0 ? '請求失敗（CORS 或連不上）' : String(n.status);
    return ['error', `🔴 ${probeVerb(probe.type)}觸發 ${n.method} ${shortenUrl(n.url)} → ${what}`];
  }

  const warnings: string[] = [...staticProblems];
  if (minor.length) warnings.push(`${probeVerb(probe.type)}產生 ${minor.length} 筆警告`);
  if (netMinor.length) {
    const n = netMinor[0];
    warnings.push(
      `${probeVerb(probe.type)}觸發 ${n.method} ${shortenUrl(n.url)} → ${n.status}`
        + (netMinor.length > 1 ? `（另有 ${netMinor.length - 1} 筆）` : ''),
    );
  }
  if (probe.type === 'media_check' && probe.loaded === false) warnings.push(probe.media_error || '媒體未載入');
  if (probe.type === 'link_check' && probe.reachable === false) warnings.push('連結無法連線');
  if (probe.type === 'animation_check' && probe.all_running === false) warnings.push('有動畫沒有在跑');
  if (probe.restored === false) warnings.push('探測後未能還原原值（請自行確認欄位內容）');

  if (warnings.length) return ['warning', `⚠ ${warnings.join('、')}`];
  return ['active', `✅ ${probeSummaryOk(probe)}`];
}

/** summary 是給人看的一行字，網址只留 path 就夠辨識——query string 會把整行撐爆。 */
function shortenUrl(url: string): string {
  try {
    const u = new URL(url, window.location.href); // 用 window.location 而非裸 location：兩者在瀏覽器等價，但前者不依賴「location 是全域」這個假設
    return u.pathname.length > 1 ? u.pathname : u.host;
  } catch {
    return url.slice(0, 60);
  }
}

function probeVerb(type: ProbeResult['type']): string {
  switch (type) {
    case 'click': return '點擊';
    case 'input': return '輸入';
    case 'select': return '切換選項';
    case 'toggle': return '勾選';
    default: return '探測';
  }
}

function probeSummaryOk(probe: ProbeResult): string {
  switch (probe.type) {
    case 'click': return '點擊測試通過（沒有觸發錯誤）';
    case 'input': return '輸入測試通過，已還原';
    case 'select': return '切換選項測試通過，已還原';
    case 'toggle': return '勾選測試通過，已還原';
    case 'link_check': return '連結可連線';
    case 'media_check': return '媒體已載入';
    case 'animation_check': return `${probe.animations} 個動畫都在跑`;
    case 'skipped_destructive': return '可見且可互動（破壞性按鈕，未點擊）';
    case 'skipped_sensitive': return '可見且可互動（敏感欄位，未探測）';
    default: return '可見且可互動';
  }
}

// ── PM-383~387：手動釘選模式（人放圖釘，AI 去查）─────────────────────────
//
// 這是 §7「第三層：人指路，AI 偵測」的入口。原本圖釘只能由 AI 用 `pin_element`
// 建立，使用者沒有辦法把「我覺得這裡怪怪的」直接標出來。
//
// 三個一致的設計原則（沿用既有做法，不另立一套）：
//   ① **所有 UI 都在 shadow DOM 裡**——注入的是任意使用者的網站，一般 DOM 會被對方
//      的 CSS reset 弄爛，我們的樣式也可能反過來汙染人家（PM-339 的結論）。
//   ② **一律用 DOM API，不用 innerHTML**——Trusted Types 網站會擋掉字串賦值（PM-69）。
//   ③ 高亮沿用 `highlightElement`、selector 沿用 `uniqueSelector`，不重寫。

let pinModeActive = false;
let pinModeHost: HTMLElement | null = null;
let pinModeRoot: ShadowRoot | null = null;
let pinModeTooltip: HTMLElement | null = null;
let pinModeBanner: HTMLElement | null = null;
let pinModeStyleSheet: CSSStyleSheet | null = null;
let pinModeLastHover: Element | null = null;

/** 釘選模式的游標。用 CSSStyleSheet 而不是注入 `<style>` 字串——Trusted Types 會擋。 */
function ensurePinModeCursor(on: boolean): void {
  try {
    if (!pinModeStyleSheet) {
      pinModeStyleSheet = new CSSStyleSheet();
      pinModeStyleSheet.replaceSync(
        'html[data-bugezy-pin-mode], html[data-bugezy-pin-mode] * { cursor: crosshair !important; }',
      );
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, pinModeStyleSheet];
    }
  } catch {
    /* 舊瀏覽器不支援 adoptedStyleSheets → 沒有 crosshair，但功能仍可用 */
  }
  if (on) document.documentElement.setAttribute('data-bugezy-pin-mode', '1');
  else document.documentElement.removeAttribute('data-bugezy-pin-mode');
}

/** 釘選模式的 shadow DOM 容器（tooltip／輸入框／toast／右鍵選單共用）。 */
function ensurePinModeRoot(): ShadowRoot {
  if (pinModeRoot && pinModeHost?.isConnected) return pinModeRoot;
  const host = document.createElement('div');
  host.setAttribute('data-bugezy-pin-ui', '1');
  Object.assign(host.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647', // 在圖釘層（…646）之上
    pointerEvents: 'none',
  } as CSSStyleDeclaration);
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; }
    .bz-tip {
      position: absolute; max-width: 320px; padding: 5px 9px; border-radius: 6px;
      background: rgba(17,24,39,.94); color: #e5e7eb; font: 12px/1.5 ui-monospace, monospace;
      pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      box-shadow: 0 2px 10px rgba(0,0,0,.4);
    }
    .bz-tip.warn { background: rgba(180,83,9,.96); color: #fff; font-family: system-ui, sans-serif; }
    .bz-banner {
      position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
      padding: 8px 16px; border-radius: 999px; pointer-events: none;
      background: #00bfff; color: #04222e; font: 600 13px/1 system-ui, sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.35);
    }
    .bz-card {
      position: absolute; width: 280px; padding: 12px; border-radius: 10px;
      background: #111827; color: #e5e7eb; font: 13px/1.5 system-ui, sans-serif;
      pointer-events: auto; box-shadow: 0 10px 30px rgba(0,0,0,.5);
      border: 1px solid rgba(255,255,255,.12);
    }
    .bz-card h4 { margin: 0 0 8px; font-size: 13px; font-weight: 700; }
    .bz-card input {
      width: 100%; box-sizing: border-box; padding: 7px 9px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,.18); background: #0b1220; color: #e5e7eb;
      font: 13px system-ui, sans-serif; outline: none;
    }
    .bz-card input:focus { border-color: #00bfff; }
    .bz-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
    .bz-btn {
      padding: 6px 14px; border-radius: 6px; border: none; cursor: pointer;
      font: 600 12px system-ui, sans-serif;
    }
    .bz-btn.primary { background: #00bfff; color: #04222e; }
    .bz-btn.ghost { background: rgba(255,255,255,.1); color: #e5e7eb; }
    .bz-toast {
      position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%);
      padding: 9px 16px; border-radius: 8px; pointer-events: none;
      background: rgba(0,200,83,.96); color: #04220e; font: 600 13px system-ui, sans-serif;
      box-shadow: 0 6px 20px rgba(0,0,0,.35);
    }
    .bz-menu {
      position: absolute; min-width: 160px; padding: 5px; border-radius: 8px;
      background: #111827; border: 1px solid rgba(255,255,255,.12);
      pointer-events: auto; box-shadow: 0 10px 30px rgba(0,0,0,.5);
    }
    .bz-menu button {
      display: block; width: 100%; text-align: left; padding: 7px 10px; border: none;
      border-radius: 5px; background: transparent; color: #e5e7eb; cursor: pointer;
      font: 13px system-ui, sans-serif;
    }
    .bz-menu button:hover { background: rgba(255,255,255,.1); }
    .bz-menu button:disabled { opacity: .4; cursor: not-allowed; }
  `);
  root.adoptedStyleSheets = [sheet];
  document.documentElement.appendChild(host);
  pinModeHost = host;
  pinModeRoot = root;
  return root;
}

/** 把浮層放進視窗內（靠近右下角時會超出邊界）。 */
function clampToViewport(el: HTMLElement, x: number, y: number): void {
  const w = el.offsetWidth || 280;
  const h = el.offsetHeight || 120;
  el.style.left = `${Math.max(6, Math.min(x, window.innerWidth - w - 6))}px`;
  el.style.top = `${Math.max(6, Math.min(y, window.innerHeight - h - 6))}px`;
}

function pinModeToast(text: string): void {
  const root = ensurePinModeRoot();
  root.querySelector('.bz-toast')?.remove();
  const t = document.createElement('div');
  t.className = 'bz-toast';
  t.textContent = text;
  root.appendChild(t);
  setTimeout(() => t.remove(), 2000);
}

// 元素簡短描述沿用檔案下方既有的 `describeElement`（PM-315），不另寫一份。

function autoDescription(el: Element): string {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return text ? `${describeElement(el)}「${text}」` : describeElement(el);
}

/** 這個元素是不是 BugEzy 自己的 UI（圖釘、面板、覆蓋層）——不能把自己釘起來。 */
function isBugezyOwnUi(el: Element | null): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (
      cur.hasAttribute?.('data-bugezy-pins') ||
      cur.hasAttribute?.('data-bugezy-pin-ui') ||
      cur.hasAttribute?.('data-bugezy-zones') ||
      cur.id === 'bugezy-debug-panel'
    ) {
      return true;
    }
  }
  return false;
}

// ── PM-385：描述輸入彈窗 ───────────────────────────────────────────────────
let pinPromptOpen = false;

/**
 * 彈出描述輸入框。`onDone(null)` = 取消、`onDone(text)` = 要釘（空字串代表跳過）。
 * 回傳前會把彈窗關掉。
 */
function openPinPrompt(
  x: number,
  y: number,
  target: Element,
  initial: string,
  onDone: (description: string | null) => void,
): void {
  const root = ensurePinModeRoot();
  root.querySelector('.bz-card')?.remove();
  pinPromptOpen = true;

  const card = document.createElement('div');
  card.className = 'bz-card';

  const title = document.createElement('h4');
  title.textContent = `📌 描述這個問題（選填）`;
  card.appendChild(title);

  const sub = document.createElement('div');
  Object.assign(sub.style, { fontSize: '11px', opacity: '.65', marginBottom: '8px' } as CSSStyleDeclaration);
  sub.textContent = describeElement(target);
  card.appendChild(sub);

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '例如：這個按鈕點了沒反應';
  input.value = initial;
  card.appendChild(input);

  const row = document.createElement('div');
  row.className = 'bz-row';
  const skip = document.createElement('button');
  skip.className = 'bz-btn ghost';
  skip.textContent = '跳過';
  const ok = document.createElement('button');
  ok.className = 'bz-btn primary';
  ok.textContent = '釘選';
  row.appendChild(skip);
  row.appendChild(ok);
  card.appendChild(row);

  root.appendChild(card);
  clampToViewport(card, x + 12, y + 12);
  // 自動 focus：**要等元素進 DOM 之後**，否則某些瀏覽器會忽略
  setTimeout(() => input.focus(), 0);

  const close = (result: string | null): void => {
    pinPromptOpen = false;
    document.removeEventListener('mousedown', onOutside, true);
    card.remove();
    onDone(result);
  };
  /** 點彈窗外 = 取消。用 capture 才不會被頁面自己的 handler 先吃掉。 */
  const onOutside = (ev: MouseEvent): void => {
    // 事件從 shadow DOM 冒出來時 target 是 host，用 composedPath 才看得到真正的節點
    if (ev.composedPath().includes(card)) return;
    ev.preventDefault();
    ev.stopPropagation();
    close(null);
  };
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);

  skip.addEventListener('click', () => close(''));
  ok.addEventListener('click', () => close(input.value.trim()));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      close(input.value.trim());
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation(); // 不要讓 ESC 一路傳上去把整個釘選模式也關掉
      close(null);
    }
  });
}

// ── PM-384：hover 高亮 + 點擊放圖釘 ────────────────────────────────────────
function onPinModeMove(ev: MouseEvent): void {
  if (pinPromptOpen || isProbing || pinModeSuspendDepth > 0) return; // PM-395
  const el = ev.target as Element | null;
  if (!el || isBugezyOwnUi(el)) return;

  const root = ensurePinModeRoot();
  if (!pinModeTooltip) {
    pinModeTooltip = document.createElement('div');
    pinModeTooltip.className = 'bz-tip';
    root.appendChild(pinModeTooltip);
  }
  // iframe 內的元素抓不到（content script 只跑在最上層框架），如實說明而不是假裝可以
  const isFrame = el.tagName === 'IFRAME' || el.tagName === 'FRAME';
  pinModeTooltip.className = isFrame ? 'bz-tip warn' : 'bz-tip';
  pinModeTooltip.textContent = isFrame
    ? '⚠ iframe 內的元素暫不支援（跨框架限制）'
    : describeElement(el);
  clampToViewport(pinModeTooltip, ev.clientX + 14, ev.clientY + 18);

  if (el !== pinModeLastHover && !isFrame) {
    pinModeLastHover = el;
    try {
      highlightElement(uniqueSelector(el), { durationMs: 600, color: '#00bfff' });
    } catch {
      /* selector 算不出來 → 只是沒有高亮，不影響點擊 */
    }
  }
}

function onPinModeClick(ev: MouseEvent): void {
  // 🔴 PM-395：**這一行是這張卡的核心。** 探測的模擬 click 與分析／巡檢期間的任何 click
  //    都要原樣放行——不 preventDefault、不彈描述框，否則 popup 按 [分析] 會跳出輸入框，
  //    而且探測的點擊會被吃掉、根本測不到頁面的反應。
  if (pinPromptOpen || isProbing || pinModeSuspendDepth > 0) return;
  const el = ev.target as Element | null;
  if (!el || isBugezyOwnUi(el)) return;

  // 🔴 一定要攔截：不攔的話點連結會導航、點按鈕會觸發表單送出，
  //    使用者只是想「標記這裡有問題」，結果把頁面狀態改掉了。
  ev.preventDefault();
  ev.stopPropagation();
  ev.stopImmediatePropagation();

  if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
    pinModeToast('⚠ iframe 內的元素暫不支援');
    return;
  }

  const selector = uniqueSelector(el);
  const auto = autoDescription(el);
  openPinPrompt(ev.clientX, ev.clientY, el, '', (description) => {
    if (description === null) return; // 取消
    const r = bridgePinElement(selector, description || auto);
    if (typeof r.error === 'string') {
      pinModeToast(`⚠ ${r.error}`);
      return;
    }
    // PM-395 防線②：釘完**立刻自動分析一次**，使用者釘上去就直接看到紅綠，
    //   不用再回 popup 多點一次 [分析]。
    //   ⚠ 分析包含動態探測，也就是說**剛剛被攔下來沒觸發的按鈕，這時會被探測點一次**。
    //     這是刻意的（釘一個按鈕的意思就是「幫我盯著它」），具破壞性的按鈕仍然會被跳過。
    pinModeToast(`📌 已釘選 ${describeElement(el)}，分析中…`);
    void withPinModeSuspended(() => bridgePinAnalyze(selector)).then((res) => {
      const emoji = PIN_STATUS_EMOJI[(res.status as Pin['status']) ?? 'active'] ?? '';
      pinModeToast(`${emoji} ${String(res.summary ?? '已釘選')}`);
    });
    // 留在釘選模式，可以繼續釘下一個
  });
}

function onPinModeKey(ev: KeyboardEvent): void {
  if (pinModeSuspendDepth > 0) return; // PM-395：分析中不要因為誤按 ESC 就把模式關掉
  if (ev.key === 'Escape' && !pinPromptOpen) {
    ev.preventDefault();
    setPinMode(false);
    pinModeToast('已結束釘選模式');
  }
}

/**
 * 開關釘選模式。
 *
 * ⚠ **不會因為 popup 關閉而自動結束**——popup 一失焦就會關閉，而使用者要點的正是
 * 頁面上的元素，自動結束等於這個功能永遠用不了（卡片 PM-383 的驗收 3 與功能本身相衝突，
 * 見 DONE-383 的說明）。改為：再按一次按鈕、或在頁面上按 ESC 才結束，
 * 並且**模式啟動期間頁面上一直有一條橫幅**，不會有「不知不覺還開著」的情況。
 */
function setPinMode(on: boolean): Record<string, unknown> {
  if (on === pinModeActive) return { pin_mode: pinModeActive };
  pinModeActive = on;
  ensurePinModeCursor(on);

  if (on) {
    const root = ensurePinModeRoot();
    pinModeBanner = document.createElement('div');
    pinModeBanner.className = 'bz-banner';
    pinModeBanner.textContent = '📌 釘選模式：點擊要標記的元素（ESC 結束）';
    root.appendChild(pinModeBanner);
    document.addEventListener('mousemove', onPinModeMove, true);
    document.addEventListener('click', onPinModeClick, true); // capture：最早攔到
    document.addEventListener('keydown', onPinModeKey, true);
  } else {
    document.removeEventListener('mousemove', onPinModeMove, true);
    document.removeEventListener('click', onPinModeClick, true);
    document.removeEventListener('keydown', onPinModeKey, true);
    pinModeBanner?.remove();
    pinModeBanner = null;
    pinModeTooltip?.remove();
    pinModeTooltip = null;
    pinModeLastHover = null;
    pinModeRoot?.querySelector('.bz-card')?.remove();
    pinPromptOpen = false;
  }
  // 通知 background：跨頁導航後 popup 才知道要不要恢復按鈕狀態
  try {
    chrome.runtime.sendMessage({ type: 'PIN_MODE_CHANGED', on: pinModeActive });
  } catch {
    /* background 可能正在休眠，不影響頁面行為 */
  }
  return { pin_mode: pinModeActive };
}

// ── PM-387：圖釘右鍵選單 ───────────────────────────────────────────────────
function closePinMenu(): void {
  pinModeRoot?.querySelector('.bz-menu')?.remove();
}

function openPinMenu(x: number, y: number, pin: Pin): void {
  const root = ensurePinModeRoot();
  closePinMenu();
  const menu = document.createElement('div');
  menu.className = 'bz-menu';

  const item = (label: string, disabled: boolean, fn: () => void): void => {
    const b = document.createElement('button');
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener('click', () => {
      closePinMenu();
      fn();
    });
    menu.appendChild(b);
  };

  // 元素已消失的圖釘沒有東西可分析，禁用而不是讓它跑出一個錯誤
  const stale = pin.status === 'stale';
  item('🔍 分析', stale, () => {
    pinModeToast('🔍 分析中…');
    void withPinModeSuspended(() => bridgePinAnalyze(pin.selector)).then((r) => {
      pinModeToast(
        typeof r.error === 'string' ? `⚠ ${String(r.error).slice(0, 60)}` : `🔍 ${String(r.summary ?? '分析完成')}`,
      );
    });
  });
  item('✏️ 修改描述', false, () => {
    const el = document.querySelector(pin.selector);
    if (!el) {
      pinModeToast('⚠ 元素已不存在，無法定位');
      return;
    }
    const r = el.getBoundingClientRect();
    openPinPrompt(r.left, r.bottom, el, pin.description, (d) => {
      if (d === null) return;
      pin.description = d || autoDescription(el);
      queueReposition();
      pinModeToast('✏️ 描述已更新');
    });
  });
  item(pin.resolved ? '↩️ 取消已解決' : '✅ 標記已解決', false, () => {
    pin.resolved = !pin.resolved;
    queueReposition();
    pinModeToast(pin.resolved ? '✅ 已標記為解決' : '↩️ 已取消解決標記');
  });
  item('🗑️ 移除', false, () => {
    bridgeRemovePin(pin.id);
    pinModeToast('🗑️ 圖釘已移除');
  });

  root.appendChild(menu);
  clampToViewport(menu, x, y);

  const onOutside = (ev: Event): void => {
    if (ev.composedPath().includes(menu)) return;
    closePinMenu();
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  };
  const onEsc = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation(); // ESC 只關選單，不要順手把釘選模式也關掉
    closePinMenu();
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onEsc, true);
  }, 0);
}

// ── PM-386：popup 圖釘清單用的資料 ─────────────────────────────────────────
function getPinListForPopup(): Record<string, unknown> {
  repositionPins(); // 順便更新 stale
  return {
    pin_mode: pinModeActive,
    pins: [...pins.values()].map((p) => ({
      pin_id: p.id,
      selector: p.selector,
      description: p.description,
      status: p.status,
      resolved: p.resolved === true,
      emoji: p.resolved ? '✅' : PIN_STATUS_EMOJI[p.status],
      last_check: p.last_check,
    })),
    total_count: pins.size,
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
  highlightElement(selector, { durationMs: 2000, label: '分析中' }); // PM-337

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
    // PM-395 防線③：整個分析期間暫停釘選攔截（popup 按 [分析] 不該跳出描述框）
    void withPinModeSuspended(() => bridgePinAnalyze(msg.selector)).then(sendResponse);
  } else if (msg.type === 'BRIDGE_MAP_ZONES') {
    sendResponse(bridgeMapPageZones());
  } else if (msg.type === 'BRIDGE_ZONE_HEALTH') {
    void bridgeGetZoneHealth().then(sendResponse);
  } else if (msg.type === 'BRIDGE_ZONE_ERRORS') {
    void bridgeGetZoneErrors(msg.zone_id).then(sendResponse);
  } else if (msg.type === 'BRIDGE_SHOW_ZONE_OVERLAY') {
    void bridgeShowZoneOverlay().then(sendResponse);
  } else if (msg.type === 'BRIDGE_HIDE_ZONE_OVERLAY') {
    sendResponse(bridgeHideZoneOverlay());
  } else if (msg.type === 'BRIDGE_WATCH_ZONES') {
    sendResponse(bridgeWatchZones(msg.interval_seconds));
  } else if (msg.type === 'BRIDGE_ZONE_CHANGES') {
    sendResponse(bridgeGetZoneChanges());
  } else if (msg.type === 'BRIDGE_STOP_WATCH_ZONES') {
    sendResponse(bridgeStopWatchingZones());
  } else if (msg.type === 'BRIDGE_SHOW_PANEL') {
    sendResponse(showDebugPanel());
  } else if (msg.type === 'BRIDGE_HIDE_PANEL') {
    sendResponse(hideDebugPanel());
  } else if (msg.type === 'BRIDGE_PATROL_PINS') {
    // PM-395 防線③：巡檢會對每個圖釘各探測一次，全程暫停釘選攔截
    void withPinModeSuspended(() => bridgePatrolPins()).then(sendResponse);
  } else if (msg.type === 'BRIDGE_REMOVE_PIN') {
    sendResponse(bridgeRemovePin(msg.pin_id, msg.selector));
  } else if (msg.type === 'BRIDGE_CLEAR_PINS') {
    sendResponse(bridgeClearPins(msg.status));
  } else if (msg.type === 'BRIDGE_GET_PIN_RESULTS') {
    sendResponse(bridgeGetPinResults());
  } else if (msg.type === 'PIN_MODE_ON') {
    sendResponse(setPinMode(true));
  } else if (msg.type === 'PIN_MODE_OFF') {
    sendResponse(setPinMode(false));
  } else if (msg.type === 'PIN_MODE_STATUS') {
    sendResponse({ pin_mode: pinModeActive });
  } else if (msg.type === 'GET_PIN_LIST') {
    sendResponse(getPinListForPopup());
  } else if (msg.type === 'BRIDGE_GET_PAGE_HEALTH') {
    void bridgeGetPageHealth().then(sendResponse);
  } else if (msg.type === 'BRIDGE_GET_WEB_VITALS') {
    void bridgeGetWebVitals().then(sendResponse);
  } else if (msg.type === 'BRIDGE_ANALYZE_ELEMENT') {
    sendResponse(bridgeAnalyzeElement(msg.selector));
  } else if (msg.type === 'BRIDGE_GET_BROWSER_ERRORS') {
    // PM-313：**沿用 inject.ts 既有的攔截機制**（PM-51 的通道），不另外掛一套。
    //   inject 在 document_start 就開始收，不需要先按錄製。
    void queryInjectLiveErrors().then(({ consoleLogs, networkErrors }) => {
      // PM-339：順手把錯誤數餵給面板（面板不自己去打擾 inject）
      lastPanelErrorCount =
        consoleLogs.filter((c) => c.level !== 'info').length + networkErrors.length;
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
      });
    });
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
