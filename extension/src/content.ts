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

// PM-193：精準轉錄麥克風失敗 → 頁面頂部提示條（8 秒後移除）。content 與頁面共用 DOM，直接建節點。
// PM-429：改成 §2.3 的咖啡底系統訊息 + 黃色六角；字典值的 ⚠️ 也一併清掉了。
function showMicFallbackTip() {
  document.getElementById('bugezy-mic-fallback-tip')?.remove();
  const tip = document.createElement('div');
  tip.id = 'bugezy-mic-fallback-tip';
  tip.style.cssText =
    `position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;gap:10px;` +
    `background:${HZ.brown};color:${HZ.yPale};padding:10px 16px;font:700 13px/1.5 ${HZ.fontUi};`;
  // PM-429：六角是文字的**兄弟節點** —— 文字用 ct() 塞進內層 span，
  //   直接對整條 tip 設 textContent 會把六角一起洗掉。
  const tipHex = document.createElement('span');
  tipHex.style.cssText = `width:8px;height:9px;flex-shrink:0;background:${HZ.y};clip-path:${HZ.hex};`;
  const tipTxt = document.createElement('span');
  tipTxt.textContent = ct('mic-fallback-tip');
  tip.append(tipHex, tipTxt);
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
 * PM-429：大黃蜂色票（DESIGN_SPEC §2.1）。
 *
 * 這個檔案的 UI 全是 `createElement` + `style.cssText`，沒有 stylesheet 可以放 CSS 變數，
 * 所以色碼集中成一個常數物件，別再散落在各處字串裡。
 *
 * ⚠ §2.2 **比例反轉**：底下是別人的網站，整條黃橫幅會蓋掉對方設計，所以注入 UI 一律
 *   黑殼 + 黃強調。**唯一例外是截圖工具列** —— 全寬且短暫存在的模態工具，用黃底宣告
 *   「現在是 BugEzy 在控制」。
 */
const HZ = {
  y: '#F7BE00',
  yDeep: '#DFA800',
  yPale: '#FFE9AE',
  cream: '#FFF4D6',
  ink: '#14110B',
  ink2: '#211C13',
  ink3: '#0E0C08',
  brown: '#7A4E1D',
  brownD: '#4A2F12',
  line: '#3A3122',
  line2: '#55492F',
  err: '#8A2A0F',
  errFg: '#E08B72',
  /** §2.4 深底上的次要文字**只有這兩階**（#8A7550 等在黑底上幾乎沒有亮度差） */
  onDark: '#A08B62',
  onDark2: '#C9A15A',
  /** §3.2 黃底上的說明文字 */
  onY: '#3A2409',
  hex: 'polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)',
  fontUi: '"Noto Sans TC",system-ui,-apple-system,"Segoe UI","Microsoft JhengHei",sans-serif',
  fontMono: '"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
} as const;

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
  // §2.3 咖啡卡 = 系統在跟你說話（敏感資料警示屬系統主動告知）
  card.style.cssText =
    `background:${HZ.brown};border:2px solid ${HZ.y};border-radius:16px;padding:22px 20px;` +
    `max-width:360px;text-align:center;font:${HZ.fontUi};`;
  // §6 警示三角（原本是 ⚠️）。⚠ clip-path 會裁掉 box-shadow 與 border，這裡兩者都不加。
  card.innerHTML =
    `<p style="margin:0 auto 10px;width:26px;height:24px;background:${HZ.y};` +
    `clip-path:polygon(50% 0,100% 100%,0 100%);"></p>` +
    `<p style="color:${HZ.yPale};font:700 16px/1.35 ${HZ.fontUi};margin:0 0 8px;"></p>` +
    `<p style="color:#F0D9A8;font:600 13px/1.7 ${HZ.fontUi};margin:0 0 4px;"></p>` +
    `<p style="color:#F0D9A8;font:500 12px/1.6 ${HZ.fontUi};margin:0 0 16px;"></p>` +
    `<div style="display:flex;gap:8px;justify-content:center;">` +
    `<button id="bz-sens-continue" style="background:${HZ.y};color:${HZ.ink};border:none;border-radius:10px;padding:10px 20px;font:700 13px/1 ${HZ.fontUi};cursor:pointer;"></button>` +
    `<button id="bz-sens-cancel" style="background:transparent;color:#F0D9A8;border:1px solid rgba(255,233,174,.45);border-radius:10px;padding:10px 20px;font:700 13px/1 ${HZ.fontUi};cursor:pointer;"></button>` +
    `</div>`;
  // textContent 設值（避免 fieldsDesc 進 innerHTML 的 XSS——雖為固定字典仍守則）
  const ps = card.querySelectorAll('p'); // ps[0] 是警示三角（沒有文字）
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
  // PM-429：橘光 #ff8c00 與大黃蜂品牌無關，換成黑色底線的脈衝。
  //   工具列本身已經是黃底，再往外發光只會糊掉；改成脈動底線比較收斂。
  if (!document.getElementById('bugezy-hornet-pulse-style')) {
    const style = document.createElement('style');
    style.id = 'bugezy-hornet-pulse-style';
    style.textContent = `
      @keyframes bugezy-hornet-pulse {
        0%, 100% { box-shadow: inset 0 -4px 0 rgba(20,17,11,0.18); }
        50% { box-shadow: inset 0 -4px 0 ${HZ.brownD}; }
      }
    `;
    document.head.appendChild(style);
  }
  bar.style.animation = 'bugezy-hornet-pulse 0.7s ease-in-out 10'; // 0.7×10 = 7 秒
  window.setTimeout(() => {
    bar.style.animation = 'none';
    bar.style.boxShadow = 'none';
    bar.style.transition = 'box-shadow 0.5s';
    document.getElementById('bugezy-hornet-pulse-style')?.remove();
  }, 7000);
}

/**
 * PM-429：截圖工具列四個模式的幾何圖示（§6）。
 * 整頁 = 圓角框 + 中心圓點（相機）／區域 = 空心方框／自由形狀 = 虛線方框／取消 = 交叉線。
 * ⚠ 回傳的是 cssText —— 這個檔案沒有 stylesheet 可用，所有樣式都得走 inline。
 */
function ssModeIcon(mode: string, color: string): string {
  const base = 'width:14px;height:12px;flex-shrink:0;box-sizing:border-box;';
  if (mode === 'full') {
    return `${base}border:2px solid ${color};border-radius:3px;` +
      `background:radial-gradient(circle at 50% 50%,${color} 0 2.5px,transparent 2.5px);`;
  }
  if (mode === 'area') return `${base}border:2px solid ${color};border-radius:2px;`;
  if (mode === 'free') return `${base}border:2px dashed ${color};border-radius:2px;`;
  // 取消：兩條 45°／-45° 交叉線（§6）
  return `width:12px;height:12px;flex-shrink:0;background:` +
    `linear-gradient(45deg,transparent 43%,${color} 43% 57%,transparent 57%),` +
    `linear-gradient(-45deg,transparent 43%,${color} 43% 57%,transparent 57%);`;
}

function createToolbar(onMode: (mode: string) => void) {
  const bar = document.createElement('div');
  bar.id = SS_TOOLBAR_ID;
  // §2.2：**唯一用黃底的注入元件** —— 全寬且短暫存在的模態工具，
  //   用黃底宣告「現在是 BugEzy 在控制」。其餘注入 UI 一律黑殼 + 黃強調。
  bar.style.cssText =
    `position:fixed;top:0;left:0;right:0;z-index:${Z_TOP};display:flex;align-items:center;gap:10px;` +
    `padding:12px 18px;background:${HZ.y};border-bottom:2px solid ${HZ.ink};` +
    `font:${HZ.fontUi};font-size:14px;color:${HZ.ink};`;
  // §5.B 六角斜紋標記（黃底版：外黑內斜紋）
  const brandHex = document.createElement('span');
  brandHex.style.cssText =
    `width:22px;height:25px;flex-shrink:0;background:${HZ.ink};clip-path:${HZ.hex};` +
    `display:flex;align-items:center;justify-content:center;`;
  const brandCore = document.createElement('span');
  brandCore.style.cssText =
    `width:14px;height:17px;clip-path:${HZ.hex};` +
    `background:repeating-linear-gradient(162deg,${HZ.y} 0 3px,${HZ.ink} 3px 6px);`;
  brandHex.appendChild(brandCore);
  bar.appendChild(brandHex);
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
    b.dataset.mode = mode;
    // §7.1：整頁是主按鈕（黑底黃字 + 硬投影），其餘描邊；取消用磚紅（§2.1 --err）
    const isPrimary = mode === 'full';
    const isCancel = mode === 'cancel';
    b.style.cssText =
      `display:flex;align-items:center;gap:7px;padding:9px 14px;border-radius:10px;cursor:pointer;` +
      `font:700 13px/1 ${HZ.fontUi};border:2px solid ${isCancel ? HZ.err : HZ.ink};` +
      (isCancel
        ? `background:${HZ.err};color:${HZ.yPale};`
        : isPrimary
          ? `background:${HZ.ink};color:${HZ.y};box-shadow:2px 2px 0 ${HZ.brownD};`
          : `background:transparent;color:${HZ.ink};`);
    // §6 幾何圖示。圖示與文字各自是 span —— 這裡不用 textContent 直接寫，
    //   否則之後任何一次覆寫都會把圖示洗掉（popup / annotate 都踩過）。
    const ic = document.createElement('span');
    ic.style.cssText = ssModeIcon(mode, isCancel ? HZ.yPale : isPrimary ? HZ.y : HZ.ink);
    const tx = document.createElement('span');
    tx.textContent = label;
    b.append(ic, tx);
    b.addEventListener('click', () => onMode(mode));
    bar.appendChild(b);
  }
  const hint = document.createElement('span');
  hint.id = 'bugezy-ss-hint';
  hint.textContent = ct('toolbar-select-mode');
  // §3.2 黃底上的說明文字：≥11.5px、字重 ≥600、色票用 #3A2409
  hint.style.cssText = `margin-left:8px;font:600 12px/1.4 ${HZ.fontUi};color:${HZ.onY};`;
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
    ctx.strokeStyle = HZ.y;
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
      dot.style.cssText = `position:absolute;left:${start.x - 5}px;top:${start.y - 5}px;width:10px;height:11px;clip-path:${HZ.hex};background:${HZ.y};z-index:${Z_TOP};pointer-events:none;`;
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
    ctx.strokeStyle = HZ.y;
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
    ctx.fillStyle = HZ.y;
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
