// popup.ts — Popup UI 邏輯（三態：閒置 / 錄製中 / 錄製完成）
// 與 background service worker 溝通：開始/停止/清除、輪詢狀態、顯示摘要、複製 JSON。

import {
  ALLOW_SCREENSHOT_KEY,
  KEYBOARD_MODE_KEY,
  LANG_KEY,
  LAST_SCREENSHOT_KEY,
  MIC_KEY,
  MIC_MODE_KEY,
  MIC_PERMISSION_KEY,
  MONITOR_MODE_KEY,
  TOOLBAR_EFFECT_KEY,
  USER_PLAN_KEY,
  SESSION_KEY,
  SESSION_TOKEN_KEY,
  API_BASE,
  type RecordingPayload,
  type RecordingSummary,
  type Session,
  type StateResponse,
} from './types';
import { getAuthHeaders, applyRotatedToken } from './auth';
import { t, getUILang, getDefaultPrompts, type UILang, type PromptItem } from './i18n';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const idleView = $('idleView');
const recordingView = $('recordingView');
const doneView = $('doneView');

const startBtn = $<HTMLButtonElement>('startBtn');
const stopBtn = $<HTMLButtonElement>('stopBtn');
const screenshotBtn = $<HTMLButtonElement>('screenshotBtn');
const copyBtn = $<HTMLButtonElement>('copyBtn');
const exportBtn = $<HTMLButtonElement>('exportBtn');
const clearBtn = $<HTMLButtonElement>('clearBtn');

const elapsed = $('elapsed');
const domCount = $('domCount');
const consoleCount = $('consoleCount');
const networkCount = $('networkCount');
const voiceCount = $('voiceCount');
const durationVal = $('durationVal');
const pageUrl = $('pageUrl');
const lastScreenshot = $('lastScreenshot');

const uploadStatusEl = $('uploadStatus');
const shareUrlRow = $('shareUrlRow');
const shareLink = $<HTMLAnchorElement>('shareLink');
const copyLinkBtn = $<HTMLButtonElement>('copyLinkBtn');

// PM-61：Google 登入 UI
const loginView = $('loginView');
const mainView = $('mainView');
const googleLoginBtn = $<HTMLButtonElement>('googleLoginBtn');
const logoutBtn = $<HTMLButtonElement>('logoutBtn');
const userAvatar = $<HTMLImageElement>('userAvatar');
const userName = $('userName');
// PM-63：用量上限提示
const upgradeHint = $('upgradeHint');
const upgradeBtn = $<HTMLButtonElement>('upgradeBtn');
// PM-73/75c：付費 / 已取消狀態徽章（三態互斥）
const paidBadge = $('paidBadge');
const cancelledBadge = $('cancelledBadge');
const expiresDate = $('expiresDate');
const cancelSubBtn = $<HTMLAnchorElement>('cancelSubBtn');
const resubBtn = $<HTMLAnchorElement>('resubBtn');
// PM-267：🎫 票券錢包（活動代碼兌換 / 啟用 / 到期提醒）
const ticketWallet = $('ticketWallet');
const promoCodeInput = $<HTMLInputElement>('promoCode');
const redeemBtn = $<HTMLButtonElement>('redeemBtn');
const redeemResult = $('redeemResult');
const redeemMsg = $('redeemMsg');
const redeemActions = $('redeemActions');
const activateNowBtn = $<HTMLButtonElement>('activateNowBtn');
const saveForLaterBtn = $<HTMLButtonElement>('saveForLaterBtn');
const activeTicketBox = $('activeTicket');
const activeTicketInfo = $('activeTicketInfo');
const ticketExpireWarn = $('ticketExpireWarn');
const savedTicketsBox = $('savedTickets');
const savedTicketsTitle = $('savedTicketsTitle');
const savedTicketsList = $('savedTicketsList');
// PM-273：票券錢包折疊
const ticketToggle = $('ticketToggle');
const ticketArrow = $('ticketArrow');
const ticketSummary = $('ticketSummary');
const ticketBadge = $('ticketBadge');
const ticketBody = $('ticketBody');
// PM-276：安裝碼
const installCodeRow = $('installCodeRow');
const installCodeValue = $('installCodeValue');
const installCodeCopy = $<HTMLButtonElement>('installCodeCopy');
// PM-274：啟用二次確認
const ticketConfirm = $('ticketConfirm');
const ticketConfirmInfo = $('ticketConfirmInfo');
const ticketConfirmYes = $<HTMLButtonElement>('ticketConfirmYes');
const ticketConfirmNo = $<HTMLButtonElement>('ticketConfirmNo');
// PM-111：日票升級鈕 + 日票中倒數狀態
const dayPassBtn = $<HTMLButtonElement>('dayPassBtn');
const dayPassStatus = $('dayPassStatus');
const dayPassCountdown = $('dayPassCountdown');
const dayPassHint = $('dayPassHint');
let dayPassTimer: number | undefined;
// PM-170：用完升級引導 overlay + 各卡片剩餘次數用的免費額度快取
const upgradeOverlay = $('upgradeOverlay');
const upgradeOverlayClose = $<HTMLButtonElement>('upgradeOverlayClose');
const upgradeOverlayTitle = $('upgradeOverlayTitle'); // PM-189：升級 overlay 標題（usage / json paid-only 共用）
const upgradeOverlayDesc = $('upgradeOverlayDesc');
const overlayDayPassBtn = $<HTMLButtonElement>('overlayDayPassBtn');
const overlayMonthlyBtn = $<HTMLButtonElement>('overlayMonthlyBtn');
// PM-189：JSON 複製/匯出免責警語 overlay
const jsonWarnOverlay = $('jsonWarnOverlay');
const jsonWarnConfirm = $<HTMLButtonElement>('jsonWarnConfirm');
const jsonWarnCancel = $<HTMLButtonElement>('jsonWarnCancel');
let isPaidMember = false; // PM-189：付費會員（paid/cancelled 未到期/day_pass 未到期）→ JSON 複製匯出解鎖
let freeLimits: PlanInfo['limits'] = null; // 最近一次 loadPlan 的免費額度（供 overlay 顯示 used/max）
// PM-171/172：非台灣 → 綠界收不了款，付費按鈕改 coming soon。
// PM-172：改用 IP 國家碼（來自 getUserPlan 的 request.cf.country），取代語言判斷——
// 台灣人選英文仍可付費、香港人選中文仍是 coming soon。
/**
 * PM-411：**國際付款還沒做，就不要對使用者說「即將開放」。**
 *
 * 這裡用一個開關而不是把 UI 刪掉／蓋 `display: none`，理由有三：
 *   ① 卡片明講「等真正實作時再打開」——留著開關，開啟就是改這一行
 *   ② `classList.remove('hidden')` 的呼叫點有三處，若改用 CSS 蓋掉，
 *      就會變成「程式說要顯示、樣式說不顯示」兩個真相，日後很難查
 *   ③ PM-171/172 的國家判斷邏輯（IP 國家碼）本身是對的，不該一起拆掉
 *
 * 關掉之後非台灣使用者看到的是：第一層沒有升級區塊（不是空白，那個區塊整塊不出現）；
 * 額度用完的 overlay 仍有標題、說明、「免費額度每月自動重置」與關閉鈕，不會變成死路。
 */
const SHOW_INTL_COMING_SOON = false;

const intlNotice = $('intlNotice');
const overlayIntlNotice = $('overlayIntlNotice');
let currentCountry = 'UNKNOWN'; // IP 國家碼（loadPlan 從 plan.country 更新）
const isTaiwanUser = () => currentCountry === 'TW';

// PM-49：鍵盤模式 toggle（關閉語音）— 狀態存 chrome.storage.local
const keyboardMode = $<HTMLInputElement>('keyboardMode');
chrome.storage.local.get(KEYBOARD_MODE_KEY, (r) => {
  keyboardMode.checked = r[KEYBOARD_MODE_KEY] === true;
});
keyboardMode.addEventListener('change', () => {
  chrome.storage.local.set({ [KEYBOARD_MODE_KEY]: keyboardMode.checked });
  // PM-194：勾鍵盤模式（=不用語音）→ 自動關麥克風。dispatch change 走 micToggle 既有關閉邏輯（含存 MIC_KEY）。
  //   取消勾選鍵盤模式 → 不自動開麥克風（使用者自己決定）。
  if (keyboardMode.checked && micToggle.checked) {
    micToggle.checked = false;
    micToggle.dispatchEvent(new Event('change'));
  }
});

// PM-51：即時監控 toggle — 開啟 → background 每 10s 推 live errors 給 AI 查
const monitorMode = $<HTMLInputElement>('monitorMode');
chrome.storage.local.get(MONITOR_MODE_KEY, (r) => {
  monitorMode.checked = r[MONITOR_MODE_KEY] === true;
});
monitorMode.addEventListener('change', async () => {
  const enabled = monitorMode.checked;
  await chrome.storage.local.set({ [MONITOR_MODE_KEY]: enabled });
  await send(enabled ? 'START_MONITORING' : 'STOP_MONITORING');
});

// PM-83：高畫質 AI 分析 toggle — 勾選後截圖上傳時帶入報告 allow_screenshot_images（讓 AI 自動看圖）
const allowScreenshots = $<HTMLInputElement>('allowScreenshots');
chrome.storage.local.get(ALLOW_SCREENSHOT_KEY, (r) => {
  allowScreenshots.checked = r[ALLOW_SCREENSHOT_KEY] === true;
});
allowScreenshots.addEventListener('change', () => {
  chrome.storage.local.set({ [ALLOW_SCREENSHOT_KEY]: allowScreenshots.checked });
});

// PM-104：工具列特效 toggle — 控制截圖工具列入場橘光脈衝（預設 ON，存 storage）
const toolbarEffect = $<HTMLInputElement>('toolbarEffect');
chrome.storage.local.get(TOOLBAR_EFFECT_KEY, (r) => {
  toolbarEffect.checked = r[TOOLBAR_EFFECT_KEY] !== false; // 預設 ON
});
toolbarEffect.addEventListener('change', () => {
  chrome.storage.local.set({ [TOOLBAR_EFFECT_KEY]: toolbarEffect.checked });
});

// PM-137/138：語音語言選擇（Whisper/Web Speech）+ 連動 popup UI 語言（中/英）
const langSelect = $<HTMLSelectElement>('langSelect');
let currentUILang: UILang = 'zh';

/** PM-138：依 currentUILang 把所有 [data-i18n] 元素的文字換掉。
 *  PM-415：字典值已經沒有 emoji 了（大黃蜂視覺系統全站禁用），圖示一律由 markup 的幾何 span 提供，
 *  所以這裡覆蓋 textContent 不會把圖示洗掉 —— 圖示是兄弟節點，不在 [data-i18n] 元素裡面。 */
function applyTranslations() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key, currentUILang);
  });
  // PM-267：placeholder 也要翻（比照 edit-report / annotate 的 data-i18n-ph 慣例）
  document.querySelectorAll<HTMLElement>('[data-i18n-ph]').forEach((el) => {
    const key = el.getAttribute('data-i18n-ph');
    if (key) (el as HTMLInputElement | HTMLTextAreaElement).placeholder = t(key, currentUILang);
  });
  renderTicketWallet(); // PM-267：票券區含動態文字，語言切換後要重繪
  // PM-408：第二層（圖釘清單／AI 監測／記憶矩陣）同樣是動態產生的文字。
  //   只跑 applyTranslations 的話，那些內容會停留在切換前的語言。
  void refreshPinList();
  void refreshMemoryStats();
  updateJsonLockUI(); // PM-189：靜態翻譯會把 copy/export 還原為預設文字，依付費狀態覆寫鎖頭
}

/** PM-189：依付費狀態設定「複製/匯出 JSON」按鈕文字（免費版標註「會員」）。 */
function updateJsonLockUI() {
  copyBtn.textContent = t(isPaidMember ? 'copy-json' : 'json-copy-locked', currentUILang);
  exportBtn.textContent = t(isPaidMember ? 'export-json' : 'json-export-locked', currentUILang);
}

chrome.storage.local.get(LANG_KEY, (r) => {
  const speechLang = (r[LANG_KEY] as string) || 'zh';
  langSelect.value = speechLang;
  currentUILang = getUILang(speechLang);
  applyTranslations();
  void loadPlan(); // 依語言重繪動態文字（用量/倒數/paid 等）
  void initPrompts(); // PM-139：依當前 UI 語言初始化 AI 輪盤預設（currentUILang 已設好）
});
langSelect.addEventListener('change', () => {
  const speechLang = langSelect.value;
  void chrome.storage.local.set({ [LANG_KEY]: speechLang });
  const newUILang = getUILang(speechLang);
  // PM-172：付費資格改用 IP 國家（與語言無關）→ UI 語言沒變（zh↔yue）就不需重繪
  if (newUILang === currentUILang) return;
  // PM-139/175：AI 輪盤——只有使用者「沒自訂過」時，切語言才換成新語言預設。
  // PM-175：改用明確 flag（PROMPTS_CUSTOMIZED_KEY）取代 JSON.stringify 比對——後者因序列化微差異
  //         會誤判「已自訂」而不重置（英→中切不回來的 bug）。flag 不存在（舊使用者）預設 false → 允許重置。
  void chrome.storage.local.get(PROMPTS_CUSTOMIZED_KEY).then((store) => {
    const isCustomized = store[PROMPTS_CUSTOMIZED_KEY] === true;
    if (!isCustomized) {
      prompts = [...getDefaultPrompts(newUILang)];
      void chrome.storage.local.set({ [PROMPTS_KEY]: prompts });
      promptCurrent = 0;
      renderPrompt();
    }
  });
  currentUILang = newUILang;
  applyTranslations(); // 先套靜態文字（會覆寫 record-desc 等為預設）
  void loadPlan(); // 再依方案重繪動態文字（覆寫回用量/無限次/倒數）
});

// PM-86：麥克風 toggle（標題列）— offscreen 錄音 + Groq Whisper 架構；預設開啟，狀態存 storage
const micToggle = $<HTMLInputElement>('micToggle');
const micIcon = $('micIcon');
// PM-91：付費版語音模式（即時字幕 / 精準轉錄）— 免費版隱藏
const micMode = $('micMode');
const micPermHint = $('micPermHint'); // PM-193：精準轉錄需選永久允許的提示
const modeBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.mic-mode-btn'));
let micPlan = 'free';

function updateMicModeUI() {
  // 付費版（paid/cancelled）+ 麥克風開啟才顯示模式選擇
  const show = micPlan !== 'free' && micToggle.checked;
  micMode.style.display = show ? 'flex' : 'none';
  micPermHint.style.display = show ? 'block' : 'none'; // PM-193：跟模式選擇一起顯示
}
function updateMicUI() {
  micIcon.style.opacity = micToggle.checked ? '1' : '0.3';
  updateMicModeUI();
}

chrome.storage.local.get(MIC_KEY, (r) => {
  micToggle.checked = r[MIC_KEY] === true; // PM-90：預設關閉，要明確開過才是 ON
  updateMicUI();
});
micToggle.addEventListener('change', async () => {
  // PM-194：手動開麥克風 → 自動取消鍵盤模式（兩者互斥）。dispatch change 走 keyboardMode 既有邏輯（存 KEYBOARD_MODE_KEY）。
  //   （§1 關麥克風時 dispatch 進來的 micToggle.checked=false，不會誤觸此段。）
  if (micToggle.checked && keyboardMode.checked) {
    keyboardMode.checked = false;
    keyboardMode.dispatchEvent(new Event('change'));
  }
  // PM-89：開麥克風時若尚未授權 → 先開授權頁（toggle 暫回 OFF，授權頁授完會自動設 ON），
  // 把授權時機放在 toggle，而非錄製時（避免錄製中開頁搶焦點導致停止失效）。
  if (micToggle.checked) {
    const store = await chrome.storage.local.get(MIC_PERMISSION_KEY);
    if (!store[MIC_PERMISSION_KEY]) {
      // PM-105：未授權 + 正在錄製 → 只存偏好、不開授權頁（錄製中開頁會搶焦點卡死錄製）。
      // 下次錄製才觸發授權；toggle 維持 ON 反映偏好。
      const state = (await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' })) as
        | { recording?: boolean }
        | undefined;
      if (state?.recording) {
        await chrome.storage.local.set({ [MIC_KEY]: true });
        updateMicUI();
        return;
      }
      // 未錄製：正常開授權頁（toggle 暫回 OFF，授權完成後由授權頁流程設 ON）
      micToggle.checked = false;
      updateMicUI();
      await chrome.runtime.sendMessage({ type: 'REQUEST_MIC_PERMISSION' });
      return;
    }
  }
  await chrome.storage.local.set({ [MIC_KEY]: micToggle.checked });
  updateMicUI();
});

// PM-91：模式按鈕高亮 + 儲存（付費版預設精準轉錄 whisper）
chrome.storage.local.get([USER_PLAN_KEY, MIC_MODE_KEY], (r) => {
  micPlan = (r[USER_PLAN_KEY] as string) || 'free';
  const mode = (r[MIC_MODE_KEY] as string) || 'whisper';
  modeBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  updateMicModeUI();
});
modeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    modeBtns.forEach((b) => b.classList.toggle('active', b === btn));
    void chrome.storage.local.set({ [MIC_MODE_KEY]: btn.dataset.mode });
  });
});

// PM-50：⏪ 回溯 30 秒 — 打包背景緩存（不需先按錄製）
const rewindBtn = $<HTMLButtonElement>('rewindBtn');
rewindBtn.addEventListener('click', async () => {
  const label = rewindBtn.querySelector<HTMLElement>('.action-label');
  rewindBtn.disabled = true;
  if (label) label.textContent = '⏪ 擷取中...';
  try {
    // PM-170：回溯達上限 → background 回 { limitReached }，彈升級引導 overlay，不進入回溯
    const res = await send<{ ok?: boolean; limitReached?: string }>('REWIND_30S');
    if (res?.limitReached) {
      showUpgradeOverlay('rewind');
      void loadPlan();
    }
  } catch (err) {
    console.error('[BugEzy popup] rewind failed', err);
  }
  rewindBtn.disabled = false;
  if (label) label.textContent = '回溯 30s';
});

let startedAt: number | null = null;
let tick: number | undefined;
let uploadPoll: number | undefined;

function send<T = unknown>(type: string): Promise<T> {
  return chrome.runtime.sendMessage({ type }) as Promise<T>;
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function renderElapsed() {
  if (startedAt) elapsed.textContent = fmt(Date.now() - startedAt);
}

function show(view: 'idle' | 'recording' | 'done') {
  idleView.classList.toggle('hidden', view !== 'idle');
  recordingView.classList.toggle('hidden', view !== 'recording');
  doneView.classList.toggle('hidden', view !== 'done');
  // PM-416：錄製中整頁反黑（§9.3）。偵察模式（PM-418）也會掛同一個 class，
  //   所以這裡只在「不是偵察模式」時才由 view 決定，避免兩邊互相把對方關掉。
  if (!document.body.classList.contains('scout-open')) {
    document.body.classList.toggle('dark', view === 'recording');
  }
  if (view === 'recording') renderRecHint();
}

/** 錄製中的那一行小字：有開麥克風才說「正在聽你說話 · 語言」。 */
function renderRecHint() {
  const el = document.getElementById('recHint');
  if (!el) return;
  if (!micToggle.checked) {
    el.textContent = t('rec-no-voice', currentUILang);
    return;
  }
  const lang = langSelect.options[langSelect.selectedIndex]?.text ?? '';
  el.textContent = lang ? `${t('rec-listening', currentUILang)} · ${lang}` : t('rec-listening', currentUILang);
}

function stopTick() {
  if (tick !== undefined) {
    clearInterval(tick);
    tick = undefined;
  }
}

function stopUploadPoll() {
  if (uploadPoll !== undefined) {
    clearInterval(uploadPoll);
    uploadPoll = undefined;
  }
}

// 顯示上傳狀態（上傳中 / 已上傳含連結 / 失敗）
function renderUpload(summary: RecordingSummary | null) {
  if (!summary) {
    uploadStatusEl.textContent = '';
    shareUrlRow.style.display = 'none';
    return;
  }
  switch (summary.uploadStatus) {
    case 'uploading':
      uploadStatusEl.textContent = t('upload-uploading', currentUILang);
      shareUrlRow.style.display = 'none';
      break;
    case 'success':
      uploadStatusEl.textContent = t('upload-ok', currentUILang);
      if (summary.shareUrl) {
        shareUrlRow.style.display = 'flex';
        shareLink.href = summary.shareUrl;
        shareLink.textContent = summary.shareUrl;
      }
      break;
    case 'error':
      uploadStatusEl.textContent = t('upload-fail', currentUILang);
      shareUrlRow.style.display = 'none';
      break;
    default:
      uploadStatusEl.textContent = '';
      shareUrlRow.style.display = 'none';
  }
}

// PM-106：錄製中鎖定所有 popup 設定 toggle/按鈕（錄製中改設定會擾動 background 錄製狀態機 → stop 失效）。
// 由 render() 依 state.recording 統一驅動，涵蓋 popup 開啟時已在錄製、按錄製、按停止三種路徑。
const settingsHint = $('settingsHint');
function lockSettings(locked: boolean) {
  const toggles: HTMLInputElement[] = [
    micToggle, // 麥克風（標題列，錄製中仍可見 → 最關鍵）
    keyboardMode,
    monitorMode,
    allowScreenshots,
    toolbarEffect,
  ];
  toggles.forEach((t) => {
    t.disabled = locked;
    t.style.opacity = locked ? '0.4' : '1';
    t.style.cursor = locked ? 'not-allowed' : 'pointer';
  });
  modeBtns.forEach((b) => {
    b.disabled = locked;
    b.style.opacity = locked ? '0.4' : '1';
    b.style.cursor = locked ? 'not-allowed' : 'pointer';
  });
  // PM-137：語言下拉也一併鎖（錄製中改語言不會生效）
  langSelect.disabled = locked;
  langSelect.style.opacity = locked ? '0.4' : '1';
  langSelect.style.cursor = locked ? 'not-allowed' : 'pointer';
  settingsHint.style.display = locked ? 'block' : 'none';
}

// 依 background 回傳的狀態決定要顯示哪一態
function render(state: StateResponse) {
  startedAt = state.startedAt;
  lockSettings(!!state.recording); // PM-106：錄製中鎖設定，停止/閒置解鎖

  if (state.recording) {
    show('recording');
    renderElapsed();
    if (tick === undefined) tick = window.setInterval(renderElapsed, 500);
    return;
  }

  stopTick();

  if (state.summary) {
    show('done');
    domCount.textContent = String(state.summary.domEvents);
    consoleCount.textContent = String(state.summary.consoleLogs);
    networkCount.textContent = String(state.summary.networkErrors);
    voiceCount.textContent = String(state.summary.voiceSegments ?? 0);
    durationVal.textContent = t('duration-sec', currentUILang, {
      n: Math.round(state.summary.durationMs / 1000),
    });
    pageUrl.textContent = state.summary.pageInfo.url;
    renderUpload(state.summary);

    // 上傳是 background 非同步做的 → 上傳中時每秒輪詢更新
    if (state.summary.uploadStatus === 'uploading') {
      if (uploadPoll === undefined) {
        uploadPoll = window.setInterval(async () => {
          const fresh = await send<StateResponse>('GET_STATE');
          renderUpload(fresh.summary);
          if (fresh.summary?.uploadStatus !== 'uploading') stopUploadPoll();
        }, 1000);
      }
    } else {
      stopUploadPoll();
    }
  } else {
    stopUploadPoll();
    show('idle');
    void updateLastScreenshot();
  }
}

// 閒置畫面：若 5 分鐘內有截圖獨立上傳，顯示連結
async function updateLastScreenshot() {
  const r = await chrome.storage.local.get(LAST_SCREENSHOT_KEY);
  const last = r[LAST_SCREENSHOT_KEY] as { shareUrl: string; timestamp: number } | undefined;
  if (last?.shareUrl && Date.now() - last.timestamp < 5 * 60 * 1000) {
    lastScreenshot.textContent = '';
    const label = document.createTextNode('最近截圖：');
    const a = document.createElement('a');
    a.href = last.shareUrl;
    a.target = '_blank';
    a.textContent = last.shareUrl;
    a.style.color = '#818cf8';
    lastScreenshot.append(label, a);
    lastScreenshot.style.display = 'block';
  } else {
    lastScreenshot.style.display = 'none';
  }
}

async function doStartRecording() {
  startBtn.disabled = true;
  try {
    // 語音改由 inject.ts（MAIN world）處理，麥克風授權由網頁觸發，popup 不需先搶
    const res = await send<StateResponse>('START_RECORDING');
    // PM-63/170：免費版用量已達上限 → 不進入錄製，彈升級引導 overlay
    if (res.limitReached) {
      setRecordDesc(t('used-up', currentUILang));
      showUpgradeOverlay('recording');
      void loadPlan(); // 刷新剩餘次數顯示（0）
      return;
    }
    render(res); // render 內 lockSettings(true) 會鎖定設定（PM-106）
  } catch (err) {
    console.error('[BugEzy popup]', err);
  } finally {
    startBtn.disabled = false;
  }
}

// PM-107：mic OFF + 非鍵盤模式 → 按錄製先提示（避免錄完才發現沒語音）。
// 鍵盤模式 ON（使用者刻意）或 mic ON → 不提示，直接錄。
// PM-210：截圖流程共用此提示——micPromptFor 記錄提示是為「錄製」或「截圖」，讓提示按鈕導向正確流程。
const micPrompt = $('micPrompt');
let micPromptFor: 'record' | 'screenshot' = 'record';
function showMicPrompt() {
  micPrompt.style.display = 'flex';
}
function hideMicPrompt() {
  micPrompt.style.display = 'none';
}
// PM-210：提示按鈕統一分派——依 micPromptFor 進入錄製或截圖流程（避免截圖誤走錄製）。
function runMicPromptAction() {
  if (micPromptFor === 'screenshot') void doScreenshot();
  else void doStartRecording();
}
startBtn.addEventListener('click', async () => {
  const store = await chrome.storage.local.get([MIC_KEY, KEYBOARD_MODE_KEY]);
  const micOn = store[MIC_KEY] === true;
  const kbOn = store[KEYBOARD_MODE_KEY] === true;
  if (!micOn && !kbOn) {
    micPromptFor = 'record';
    showMicPrompt();
    return;
  }
  await doStartRecording();
});

// PM-107：「開啟並錄製」→ 開 mic；未授權則開授權頁（這次不錄，比照 PM-89/105 授權時機在 toggle）；
// 已授權則直接開始錄製。
$<HTMLButtonElement>('micPromptOn').addEventListener('click', async () => {
  const permStore = await chrome.storage.local.get(MIC_PERMISSION_KEY);
  if (!permStore[MIC_PERMISSION_KEY]) {
    // 未授權：不硬開 MIC_KEY（授權頁授完流程會設 ON），關提示 + 開授權頁，這次不錄
    hideMicPrompt();
    await chrome.runtime.sendMessage({ type: 'REQUEST_MIC_PERMISSION' });
    return;
  }
  // 已授權：開 mic + 同步 UI + 進入對應流程（錄製或截圖）
  await chrome.storage.local.set({ [MIC_KEY]: true });
  micToggle.checked = true;
  updateMicUI();
  hideMicPrompt();
  runMicPromptAction(); // PM-210：錄製 → doStartRecording；截圖 → doScreenshot（語音啟用）
});

// PM-107：「直接錄製（不錄語音）」→ 不開 mic，直接進入對應流程（PM-210：截圖則語音關閉）
$<HTMLButtonElement>('micPromptSkip').addEventListener('click', () => {
  hideMicPrompt();
  runMicPromptAction();
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  try {
    let state = await send<StateResponse>('STOP_RECORDING');
    // content script 打包是非同步的 → 短輪詢取回摘要
    for (let i = 0; i < 20 && !state.summary; i++) {
      await new Promise((r) => setTimeout(r, 150));
      state = await send<StateResponse>('GET_STATE');
    }
    render(state);
  } catch (err) {
    console.error('[BugEzy popup]', err);
  } finally {
    stopBtn.disabled = false;
  }
});

// 截圖標注：獨立入口（不需先錄製）。送 CAPTURE_SCREENSHOT → background 開標注分頁，
// popup 會在新分頁取得焦點時自動關閉。
async function doScreenshot() {
  screenshotBtn.disabled = true;
  try {
    await send('CAPTURE_SCREENSHOT');
  } catch (err) {
    console.error('[BugEzy popup]', err);
    screenshotBtn.disabled = false;
  }
}
// PM-210：截圖與錄製一致——mic OFF + 非鍵盤模式 → 先彈麥克風提示（標注頁有語音功能）；
//   選「開啟並錄製」開 mic 後進截圖（語音啟用）、「直接錄製（不錄語音）」直接進截圖（語音關閉）。
//   mic ON 或鍵盤模式 → 不提示，直接截圖。
screenshotBtn.addEventListener('click', async () => {
  const store = await chrome.storage.local.get([MIC_KEY, KEYBOARD_MODE_KEY]);
  const micOn = store[MIC_KEY] === true;
  const kbOn = store[KEYBOARD_MODE_KEY] === true;
  if (!micOn && !kbOn) {
    micPromptFor = 'screenshot';
    showMicPrompt();
    return;
  }
  await doScreenshot();
});

clearBtn.addEventListener('click', async () => {
  clearBtn.disabled = true;
  try {
    render(await send<StateResponse>('CLEAR_RECORDING'));
  } catch (err) {
    console.error('[BugEzy popup]', err);
  } finally {
    clearBtn.disabled = false;
  }
});

copyBtn.addEventListener('click', async () => {
  // PM-189：複製 JSON 為會員進階功能——免費 → 引導升級；付費 → 先過免責警語
  if (!isPaidMember) return showJsonPaidOverlay();
  if (!(await confirmJsonDisclaimer())) return;
  const { payload } = await send<{ payload: RecordingPayload | null }>('GET_LAST_PAYLOAD');
  if (!payload) return;
  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  copyBtn.textContent = currentUILang === 'en' ? '✅ Copied' : '✅ 已複製';
  copyBtn.classList.add('copied');
  setTimeout(() => {
    updateJsonLockUI(); // 還原（付費 → 📋 複製 JSON）
    copyBtn.classList.remove('copied');
  }, 1500);
});

// 複製分享連結
copyLinkBtn.addEventListener('click', () => {
  const url = shareLink.textContent?.trim();
  if (!url) return;
  navigator.clipboard.writeText(url);
  copyLinkBtn.textContent = '✅ 已複製';
  setTimeout(() => {
    copyLinkBtn.textContent = '📋 複製連結';
  }, 1500);
});

// 匯出 payload 成檔案 → Downloads/bugezy-debug/，給 Claude Chat 用 dc-light 直接讀
exportBtn.addEventListener('click', async () => {
  // PM-189：匯出 JSON 為會員進階功能——免費 → 引導升級；付費 → 先過免責警語
  if (!isPaidMember) return showJsonPaidOverlay();
  if (!(await confirmJsonDisclaimer())) return;
  const { payload } = await send<{ payload: RecordingPayload | null }>('GET_LAST_PAYLOAD');
  if (!payload) return;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  // 時間戳用 YYYYMMDD-HHmmss（不含 ':'，避免 Windows 非法檔名）
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: `bugezy-debug/payload-${ts}.json`, // 相對 Downloads 根；子資料夾自動建立
      saveAs: false,
    });
    exportBtn.textContent =
      currentUILang === 'en' ? '✅ Saved to Downloads/bugezy-debug' : '✅ 已匯出到 Downloads/bugezy-debug';
    exportBtn.classList.add('done');
    setTimeout(() => {
      updateJsonLockUI(); // 還原（付費 → 💾 匯出 JSON）
      exportBtn.classList.remove('done');
    }, 2000);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
});

// ── PM-61：Google 登入 ────────────────────────────────────
async function checkAuth(): Promise<Session | null> {
  const r = await chrome.storage.local.get(SESSION_KEY);
  return (r[SESSION_KEY] as Session | undefined) ?? null;
}

/** chrome.identity.getAuthToken 取 Google access token（需 manifest oauth2 + 擴充 ID 已註冊）。
 *  interactive=false 用於靜默續期（不彈視窗；未授權則回 null）。 */
function googleLogin(interactive = true): Promise<string | null> {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        if (interactive) reject(new Error(chrome.runtime.lastError?.message || 'login failed'));
        else resolve(null); // 靜默失敗不算錯誤
      } else {
        resolve(token);
      }
    });
  });
}

/** PM-133：取 Google userinfo 供「顯示用」name/picture（非信任邊界——真實身分由 server 從 token 推導）。*/
async function fetchGoogleProfile(
  token: string,
): Promise<{ name: string; picture: string; email: string }> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { name: '', picture: '', email: '' };
    const u = (await res.json()) as { name?: string; picture?: string; email?: string };
    return { name: u.name ?? '', picture: u.picture ?? '', email: u.email ?? '' };
  } catch {
    return { name: '', picture: '', email: '' };
  }
}

/** PM-133：用 Google access token 換 DB session（server 驗 audience + 推導 user_id）。 */
async function exchangeSession(
  googleToken: string,
  name: string,
): Promise<{ user_id: string; email: string; session_token: string } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ google_token: googleToken, name }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { user_id: string; email: string; session_token: string };
  } catch (err) {
    console.error('[BugEzy popup] exchangeSession', err);
    return null;
  }
}

/** PM-133：完整登入——取 Google token → profile（顯示）→ 換 session → 存 storage。 */
async function doLogin(interactive = true): Promise<Session | null> {
  const googleToken = await googleLogin(interactive);
  if (!googleToken) return null;
  const profile = await fetchGoogleProfile(googleToken);
  const data = await exchangeSession(googleToken, profile.name);
  if (!data?.session_token) return null;
  const session: Session = {
    user_id: data.user_id,
    email: data.email || profile.email,
    name: profile.name,
    avatar_url: profile.picture,
    session_token: data.session_token,
  };
  await chrome.storage.local.set({
    [SESSION_KEY]: session,
    [SESSION_TOKEN_KEY]: data.session_token,
  });
  return session;
}

/** PM-133：靜默把既有登入（可能是舊 base64 token）換成有效 DB session token。
 *  已授權過的用戶 interactive:false 可無感續期；失敗則等使用者手動重新登入。 */
async function refreshSessionSilently(): Promise<void> {
  const session = await doLogin(false);
  if (session) {
    userName.textContent = session.name || session.email;
    if (session.avatar_url) userAvatar.src = session.avatar_url;
    void loadPlan(); // 換到新 token 後刷新方案顯示
  }
}

function showLoginView() {
  loginView.classList.remove('hidden');
  mainView.classList.add('hidden');
}

function showMainView(session: Session) {
  loginView.classList.add('hidden');
  mainView.classList.remove('hidden');
  userName.textContent = session.name || session.email;
  if (session.avatar_url) userAvatar.src = session.avatar_url;
  // 進主畫面後才抓錄製狀態決定 idle/recording/done
  send<StateResponse>('GET_STATE').then(render).catch((e) => console.error('[BugEzy popup]', e));
  void loadPlan(); // PM-63：查方案 + 剩餘用量
}

interface PlanInfo {
  plan: string;
  install_code?: string | null; // PM-277：併進方案回應，popup 不再另打一支 API
  expires_at?: string | null;
  plan_expires_at?: string | null; // PM-134：月費到期日（cancelled 顯示用；與 expires_at 同值）
  day_pass_expires_at?: string | null; // PM-111：日票到期時間
  usage_reset_at?: string | null; // PM-170：免費額度上次重置時間
  country?: string; // PM-172：IP 國家碼（TW=可付費，其餘 coming soon）
  limits: null | {
    recording: { used: number; max: number };
    rewind: { used: number; max: number };
    mcp: { used: number; max: number };
  };
  // PM-266/267：活動票券。isPaid 已整合票券（ECPay 或 ACTIVE 票券任一成立即為 true）
  isPaid?: boolean;
  tickets?: {
    active: ActiveTicket | null;
    saved: SavedTicket[];
    savedCount: number;
    free_until?: string | null;
  };
}

// PM-267：票券型別（對應 PM-266 的 /api/user/plan、/api/promo/* 回傳）
interface ActiveTicket {
  ticket_id: string;
  code: string;
  duration_days: number;
  expires_at: string;
  days_left: number;
}
interface SavedTicket {
  ticket_id: string;
  code: string;
  duration_days: number;
  created_at?: string;
}
/** 票券快取（loadPlan 寫入；語言切換時重繪用）。 */
let ticketState: { active: ActiveTicket | null; saved: SavedTicket[] } = { active: null, saved: [] };
// PM-275：ECPay 訂閱中（paid / cancelled 未到期）。**刻意不用 plan.isPaid**——server 的 isPaid
//   把「持有有效票券」也算付費（getUserPlan: isActiveUser(u) || activeTickets.length > 0），
//   若拿它當判斷，票券用戶的啟用鈕會被一起藏掉（驗收 #5 要求票券用戶仍可啟用下一張）。
//   cancelled = 已取消但仍在有效期內（過期會被 getUserPlan 自動降回 free），故一樣算付費中。
let isEcpayPaid = false;
/** 剛兌換、尚未決定「立即啟用／儲存備用」的票券 id。 */
let pendingTicket: { id: string; code: string; days: number } | null = null;
const TICKET_WARN_DAYS = 10; // 剩 ≤10 天顯示到期提醒（卡片 2d）

/** duration_days → 「N 個月」或「N 天」（整月才說月，避免 45 天顯示成 1.5 個月）。 */
function fmtDuration(days: number): string {
  return days % 30 === 0 && days >= 30
    ? t('promo_months', currentUILang, { n: days / 30 })
    : t('promo_days', currentUILang, { n: days });
}

/** ISO 日期 → YYYY/MM/DD（顯示用，避免依賴 Intl locale）。 */
function fmtDate(iso?: string | null): string {
  return iso ? iso.slice(0, 10).replace(/-/g, '/') : '本期結束';
}

/** 更新指定按鈕的 .action-desc（保留 icon/label span）；PM-170：low=剩 ≤2 次上紅色。 */
function setActionDesc(btn: HTMLButtonElement, text: string, low = false) {
  const desc = btn.querySelector<HTMLElement>('.action-desc');
  if (!desc) return;
  desc.textContent = text;
  desc.classList.toggle('low', low);
}
/** 只更新錄製按鈕的 .action-desc（保留既有呼叫端）。 */
function setRecordDesc(text: string) {
  setActionDesc(startBtn, text);
}

/** PM-170：三張免費卡片剩餘次數（record/rewind 顯示剩 N 次，剩 ≤2 紅色；screenshot 無限）。 */
function renderFreeUsage(limits: NonNullable<PlanInfo['limits']>) {
  const setRemain = (btn: HTMLButtonElement, used: number, max: number) => {
    const remain = Math.max(0, max - used);
    setActionDesc(
      btn,
      remain > 0 ? t('remaining', currentUILang, { n: remain }) : t('used-up', currentUILang),
      remain <= 2,
    );
  };
  setRemain(startBtn, limits.recording.used, limits.recording.max);
  setRemain(rewindBtn, limits.rewind.used, limits.rewind.max);
  setActionDesc(screenshotBtn, t('unlimited', currentUILang)); // 截圖免費無限
}

/** PM-170：本月額度用完 → 彈升級引導 overlay（day-pass / monthly + 每月重置提示）。 */
/**
 * PM-419：畫設計稿畫面 12 的用量滿格條。資料就是 renderFreeUsage 用的那份 freeLimits，
 * 沒有新增任何 API —— 只是把「剩幾次」換一種看得見的呈現。
 * JSON 付費牆共用這張卡但沒有用量概念，那條路徑會整塊隱藏（見 showJsonPaidOverlay）。
 */
function renderOverlayUsage(): void {
  const box = document.getElementById('overlayUsage');
  if (!box) return;
  while (box.firstChild) box.removeChild(box.firstChild);
  const rows: Array<[string, { used: number; max: number } | undefined]> = [
    [t('mode-record', currentUILang), freeLimits?.recording],
    [t('mode-rewind', currentUILang), freeLimits?.rewind],
  ];
  let shown = 0;
  for (const [label, lim] of rows) {
    if (!lim || !lim.max) continue;
    const row = document.createElement('div');
    row.className = 'usage-bar';
    const b = document.createElement('b');
    b.textContent = label;
    const track = document.createElement('i');
    const fill = document.createElement('em');
    // 用完就是滿格；還沒用完也照比例畫——overlay 不是只有「用完」一個進入點
    fill.style.width = `${Math.min(100, Math.round((lim.used / lim.max) * 100))}%`;
    track.appendChild(fill);
    const num = document.createElement('span');
    num.textContent = `${lim.used}/${lim.max}`;
    row.append(b, track, num);
    box.appendChild(row);
    shown++;
  }
  box.classList.toggle('hidden', shown === 0);
}

function showUpgradeOverlay(type: 'recording' | 'rewind' | 'mcp') {
  const lim = freeLimits?.[type];
  const max = lim?.max ?? 0;
  const descKey =
    type === 'recording' ? 'usage-desc-record' : type === 'rewind' ? 'usage-desc-rewind' : 'usage-desc-mcp';
  upgradeOverlayTitle.textContent = t('usage-exhausted', currentUILang); // PM-189：title 與 json 共用，明確設回
  // 用完 → used 已達上限，顯示 max/max
  upgradeOverlayDesc.textContent = t(descKey, currentUILang, { used: max, max });
  renderOverlayUsage();
  // PM-171：非台灣 → 隱藏日票/月費鈕（綠界收不了款），改顯示 coming soon
  const taiwan = isTaiwanUser();
  overlayDayPassBtn.classList.toggle('hidden', !taiwan);
  overlayMonthlyBtn.classList.toggle('hidden', !taiwan);
  overlayIntlNotice.classList.toggle('hidden', taiwan || !SHOW_INTL_COMING_SOON); // PM-411
  upgradeOverlay.classList.remove('hidden');
}

/** PM-189：免費用戶點 JSON 複製/匯出 → 沿用升級 overlay，改標題為「會員進階功能」引導付費。 */
function showJsonPaidOverlay() {
  upgradeOverlayTitle.textContent = t('json-paid-only', currentUILang);
  upgradeOverlayDesc.textContent = '';
  document.getElementById('overlayUsage')?.classList.add('hidden'); // 付費牆沒有用量概念
  const taiwan = isTaiwanUser();
  overlayDayPassBtn.classList.toggle('hidden', !taiwan);
  overlayMonthlyBtn.classList.toggle('hidden', !taiwan);
  overlayIntlNotice.classList.toggle('hidden', taiwan || !SHOW_INTL_COMING_SOON); // PM-411
  upgradeOverlay.classList.remove('hidden');
}

/** PM-189：JSON 敏感資料免責警語彈窗——每次操作都顯示（法律免責，不設「不再提示」）。
 *  resolve(true)=用戶按「我了解，繼續」；resolve(false)=取消/關背景。 */
function confirmJsonDisclaimer(): Promise<boolean> {
  return new Promise((resolve) => {
    const close = (ok: boolean) => {
      jsonWarnOverlay.classList.add('hidden');
      jsonWarnConfirm.removeEventListener('click', onOk);
      jsonWarnCancel.removeEventListener('click', onCancel);
      jsonWarnOverlay.removeEventListener('click', onBackdrop);
      resolve(ok);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (e: MouseEvent) => {
      if (e.target === jsonWarnOverlay) close(false);
    };
    jsonWarnConfirm.addEventListener('click', onOk);
    jsonWarnCancel.addEventListener('click', onCancel);
    jsonWarnOverlay.addEventListener('click', onBackdrop);
    jsonWarnOverlay.classList.remove('hidden');
  });
}

// PM-63/75：查方案 → 依 plan 狀態（source of truth）控制 UI。
// paid：隱藏升級提示 + ✨ + 管理訂閱（含取消）；cancelled：隱藏升級提示 + 顯示到期日；free：剩餘次數 + 升級提示。
// ── PM-267：🎫 票券錢包 UI ────────────────────────────────────────────────
// ── PM-276：安裝碼 ────────────────────────────────────────────────────────
/** PM-277：安裝碼改由 /api/user/plan 一併帶回（原本另打 /api/user/install-code）。
 *  純渲染、不發請求——開 popup 時的併發 API 請求越少越好。 */
function renderInstallCode(code: string | null | undefined) {
  if (!code) {
    installCodeRow.classList.add('hidden');
    return;
  }
  installCodeValue.textContent = code;
  installCodeRow.classList.remove('hidden');
}

installCodeCopy.addEventListener('click', () => {
  const code = installCodeValue.textContent ?? '';
  if (!code) return;
  void navigator.clipboard.writeText(code).then(() => {
    installCodeCopy.textContent = t('install_code_copied', currentUILang);
    installCodeCopy.classList.add('copied');
    setTimeout(() => {
      installCodeCopy.textContent = t('install_code_copy', currentUILang);
      installCodeCopy.classList.remove('copied');
    }, 1500);
  });
});

// ── PM-273：票券錢包折疊（預設收合；狀態存 localStorage）──────────────────
// 用 localStorage 而非 PM-122 accordion 的 chrome.storage.local：後者是非同步的，
// popup 開啟瞬間會先套預設值再被覆蓋，展開狀態會閃一下；localStorage 同步讀取沒這問題。
const TICKET_OPEN_KEY = 'bugezy:ticket-open';
let ticketOpen = localStorage.getItem(TICKET_OPEN_KEY) === '1'; // 預設收合

/** 依 ticketOpen 更新箭頭、內容顯示，以及「收合才顯示」的摘要/庫存 badge。 */
function updateTicketFold() {
  // PM-415：箭頭改成 CSS 三角（.ticket-arrow / .open 轉 90 度）。
  //   原本用 ▼ / ▶ 兩個字元，那是 emoji-free 規則要清掉的東西之一。
  ticketArrow.classList.toggle('open', ticketOpen);
  ticketBody.style.display = ticketOpen ? 'block' : 'none';
  // 展開後下方已有完整的「使用中票券」與「庫存票券（N）」，標題列不再重複顯示
  ticketSummary.classList.toggle('hidden', ticketOpen || !ticketSummary.textContent);
  ticketBadge.classList.toggle('hidden', ticketOpen || !ticketBadge.textContent);
}

ticketToggle.addEventListener('click', () => {
  ticketOpen = !ticketOpen;
  localStorage.setItem(TICKET_OPEN_KEY, ticketOpen ? '1' : '0');
  updateTicketFold();
});
updateTicketFold(); // 初始套用（渲染前先收合，避免開 popup 閃一下完整內容）

/** 依 ticketState 重繪「使用中／到期提醒／庫存」三區（純渲染，不打 API）。 */
function renderTicketWallet() {
  const { active, saved } = ticketState;

  // 使用中票券
  if (active) {
    activeTicketInfo.textContent = '';
    const line1 = document.createElement('div');
    // PM-419：脈衝六角由 .active-ticket-row::before 畫（§7.4「票券生效中」的形狀分級）
    line1.className = 'active-ticket-row';
    line1.textContent = `${t('promo_active', currentUILang)}（${active.code}）`;
    const line2 = document.createElement('span');
    line2.className = 'ticket-sub';
    line2.textContent =
      `${t('promo_expires', currentUILang)}：${fmtDate(active.expires_at)}　` +
      t('promo_days_left', currentUILang, { n: active.days_left });
    activeTicketInfo.appendChild(line1);
    activeTicketInfo.appendChild(line2);
    activeTicketBox.classList.remove('hidden');

    // 到期提醒（剩 ≤10 天）：有庫存票就引導啟用，沒有就提示到期後轉月費
    if (active.days_left <= TICKET_WARN_DAYS) {
      ticketExpireWarn.textContent = '';
      const w1 = document.createElement('div');
      // PM-278：天數併進同一句（「免費體驗將於 N 天後結束」），不再另外接「（剩 N 天）」
      w1.textContent = t('promo_expiring_soon', currentUILang, { n: active.days_left });
      ticketExpireWarn.appendChild(w1);
      const w2 = document.createElement('div');
      // PM-278：到期後只是回到 free（不會自動扣款），文案不再提「月費 NT$80」
      w2.textContent = saved.length
        ? t('promo_expiring_saved', currentUILang, { n: saved.length })
        : t('promo_expiring_upgrade', currentUILang);
      ticketExpireWarn.appendChild(w2);
      ticketExpireWarn.classList.remove('hidden');
    } else {
      ticketExpireWarn.classList.add('hidden');
    }
  } else {
    activeTicketBox.classList.add('hidden');
    ticketExpireWarn.classList.add('hidden');
  }

  // 庫存票券
  if (saved.length) {
    savedTicketsTitle.textContent =
      `${t('promo_saved_tickets', currentUILang)}（${saved.length}）` +
      (isEcpayPaid ? ` — ${t('promo_backup_note', currentUILang)}` : '');
    savedTicketsList.textContent = '';
    for (const s of saved) {
      const row = document.createElement('div');
      row.className = 'saved-ticket-row';
      const label = document.createElement('span');
      // PM-419：票券圖示改由 .saved-ticket-row 的版面呈現，文字不再帶 emoji
    label.textContent = `${s.code} — ${fmtDuration(s.duration_days)}`;
      row.appendChild(label);
      if (isEcpayPaid) {
        // PM-275：ECPay 訂閱中啟用票券只會白燒天數（月費照扣），不給啟用入口
        const tag = document.createElement('span');
        tag.className = 'saved-ticket-member';
        tag.textContent = t('promo_already_member', currentUILang);
        row.appendChild(tag);
      } else {
        const btn = document.createElement('button');
        btn.className = 'saved-ticket-btn';
        btn.textContent = t('promo_activate', currentUILang);
        // PM-274：不直接啟用，先跳確認
        btn.addEventListener('click', () => askActivate(s.ticket_id, s.code, s.duration_days, btn));
        row.appendChild(btn);
      }
      savedTicketsList.appendChild(row);
    }
    savedTicketsBox.classList.remove('hidden');
  } else {
    savedTicketsBox.classList.add('hidden');
  }

  // PM-273：折疊標題列——完全沒有票券（無使用中、無庫存）時整列隱藏，
  // 免得留下一個點開來是空的區塊；此時只剩「輸入活動代碼」欄位。
  const hasAny = !!active || saved.length > 0;
  ticketToggle.classList.toggle('hidden', !hasAny);
  ticketSummary.textContent = active
    ? `${active.code} ${t('promo_days_left', currentUILang, { n: active.days_left })}`
    : '';
  ticketBadge.textContent = saved.length
    ? t('promo_stock', currentUILang, { n: saved.length })
    : '';
  updateTicketFold();
}

/** 顯示兌換結果訊息；ok=true 時一併給「立即啟用／儲存備用」兩顆按鈕。 */
function showRedeemMsg(text: string, ok: boolean, withActions = false) {
  redeemMsg.textContent = text;
  redeemMsg.className = `redeem-msg ${ok ? 'ok' : 'err'}`;
  redeemActions.classList.toggle('hidden', !withActions);
  // PM-275：ECPay 訂閱中不給「立即啟用」，只留「儲存備用」
  activateNowBtn.classList.toggle('hidden', isEcpayPaid);
  redeemResult.classList.remove('hidden');
}

// ── PM-274：啟用二次確認（啟用即開始倒數，不可逆，誤觸代價高）────────────────
/** 待確認的票券；null = 確認區未開啟。 */
let confirmTarget: {
  ticketId: string;
  code: string;
  days: number;
  btn?: HTMLButtonElement;
} | null = null;

/** 顯示確認區並帶入票券資訊（不打 API；真正啟用在使用者按下「確認啟用」後）。 */
function askActivate(ticketId: string, code: string, days: number, btn?: HTMLButtonElement) {
  confirmTarget = { ticketId, code, days, btn };
  ticketConfirmInfo.textContent = `${code}（${fmtDuration(days)}）`;
  ticketConfirm.classList.remove('hidden');
  // 觸發鈕可能在折疊區內、位置較低，確認區在其上方——不捲進畫面的話使用者會以為按鈕沒反應
  ticketConfirm.scrollIntoView({ block: 'nearest' });
}

function closeActivateConfirm() {
  confirmTarget = null;
  ticketConfirm.classList.add('hidden');
}

ticketConfirmYes.addEventListener('click', () => {
  const target = confirmTarget;
  closeActivateConfirm(); // 先關閉，避免連點兩次送出兩個啟用請求
  if (target) void activateTicket(target.ticketId, target.btn);
});
ticketConfirmNo.addEventListener('click', closeActivateConfirm);

/** 啟用一張票券；成功後重新 loadPlan 刷新全部狀態（含三張卡片、JSON 鎖）。 */
async function activateTicket(ticketId: string, btn?: HTMLButtonElement) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/promo/activate`, {
      method: 'POST',
      headers: { ...(await getAuthHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_id: ticketId }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      showRedeemMsg(data.error || t('promo_failed', currentUILang), false);
      return;
    }
    pendingTicket = null;
    redeemResult.classList.add('hidden'); // 啟用後結果區收起，狀態改由「使用中」區呈現
    await loadPlan();
  } catch {
    showRedeemMsg(t('promo_failed', currentUILang), false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 兌換代碼
redeemBtn.addEventListener('click', () => void redeemPromoCode());
promoCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void redeemPromoCode();
});

async function redeemPromoCode() {
  const code = promoCodeInput.value.trim();
  if (!code) return;
  closeActivateConfirm(); // 清掉前一張票殘留的確認框
  redeemBtn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/promo/redeem`, {
      method: 'POST',
      headers: { ...(await getAuthHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ticket_id?: string;
      duration_days?: number;
      error?: string;
    };
    if (!res.ok) {
      // 401 = 未登入（getAuthHeaders 無 token）→ 給明確指引而非後端的泛用訊息
      showRedeemMsg(
        res.status === 401 ? t('promo_need_login', currentUILang) : data.error || t('promo_failed', currentUILang),
        false,
      );
      return;
    }
    pendingTicket = data.ticket_id
      ? { id: data.ticket_id, code, days: data.duration_days ?? 0 }
      : null;
    promoCodeInput.value = '';
    showRedeemMsg(
      `${t('promo_success', currentUILang)}${data.duration_days ? ` ${fmtDuration(data.duration_days)}` : ''}`,
      true,
      true, // 顯示「立即啟用 / 儲存備用」
    );
    await loadPlan(); // 票券已存在 SAVED，先刷新庫存區
  } catch {
    showRedeemMsg(t('promo_failed', currentUILang), false);
  } finally {
    redeemBtn.disabled = false;
  }
}

activateNowBtn.addEventListener('click', () => {
  // PM-274：兌換後的「立即啟用」同樣先確認
  if (pendingTicket) askActivate(pendingTicket.id, pendingTicket.code, pendingTicket.days, activateNowBtn);
});
saveForLaterBtn.addEventListener('click', () => {
  // 「儲存備用」不需打 API——兌換當下票券已是 SAVED，這裡只收起選擇區
  pendingTicket = null;
  showRedeemMsg(t('promo_saved_done', currentUILang), true, false);
});

// PM-277：開 popup 時 loadPlan 會被呼叫兩次（LANG_KEY storage callback + showMainView），
//   /api/ 有 rate limit，併發重複請求容易被擋。以「進行中的 promise」去重：
//   同一時間只送一次，後到的呼叫共用同一個結果。
let planInflight: Promise<void> | null = null;

function loadPlan(): Promise<void> {
  if (planInflight) return planInflight;
  planInflight = fetchAndRenderPlan().finally(() => {
    planInflight = null;
  });
  return planInflight;
}

/** 取方案並渲染；失敗會重試一次，仍失敗則渲染「安全預設」而不是留白。 */
async function fetchAndRenderPlan(): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/api/user/plan`, { headers: await getAuthHeaders() });
      if (res.ok) {
        renderPlanUI((await res.json()) as PlanInfo);
        return;
      }
      if (res.status === 401) return; // 未登入——維持登入畫面，不是錯誤
      // PM-277：以前這裡是 `if (!res.ok) return;`（完全靜默），使用者只會看到一個少了
      //   次數/升級鈕/安裝碼/票券錢包的 popup，卻沒有任何線索可查。至少要留下痕跡。
      console.warn('[BugEzy popup] 取方案失敗:', res.status, attempt === 0 ? '→ 重試' : '→ 放棄');
    } catch (e) {
      console.warn('[BugEzy popup] 取方案例外:', e, attempt === 0 ? '→ 重試' : '→ 放棄');
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
  }
  renderPlanFallback();
}

/**
 * PM-277：方案取不到時的安全預設——**寧可顯示免費版 UI，也不要留白**。
 * 原本失敗就直接 return，導致三張卡片、升級鈕、安裝碼、票券錢包全部維持 HTML 的預設 hidden，
 * 使用者看到一個殘缺的 popup，而且要切換語言（重新觸發 loadPlan）才會恢復。
 */
function renderPlanFallback() {
  ticketWallet.classList.remove('hidden'); // 至少讓「輸入活動代碼」可用
  renderTicketWallet();
  if (isTaiwanUser()) upgradeHint.classList.remove('hidden');
  else if (SHOW_INTL_COMING_SOON) intlNotice.classList.remove('hidden'); // PM-411
}

/** PM-277：唯一的方案渲染路徑——初次載入與語言切換都走這裡，不會有分歧。 */
function renderPlanUI(plan: PlanInfo) {
    freeLimits = plan.limits; // PM-170：快取免費額度供 overlay 顯示 used/max
    currentCountry = plan.country ?? 'UNKNOWN'; // PM-172：IP 國家碼決定付費資格
    // PM-87：持久化 plan 供 background/content 路由語音引擎（free→Web Speech、paid/cancelled→Groq Whisper）
    // PM-267：票券生效時 server 端已視同付費（Whisper/額度皆放行），
    //   故 USER_PLAN_KEY 也要給非 'free' 值，否則 popup 不會顯示精準轉錄選項。
    const ticketActive = !!plan.tickets?.active;
    const effectivePlan = plan.plan === 'free' && ticketActive ? 'ticket' : plan.plan;
    void chrome.storage.local.set({ [USER_PLAN_KEY]: effectivePlan });
    // PM-91：更新模式選擇可見性（付費版才顯示）
    micPlan = effectivePlan;
    updateMicModeUI();

    // PM-267：票券狀態快取 + 重繪錢包（登入成功才顯示整個票券區）
    ticketState = { active: plan.tickets?.active ?? null, saved: plan.tickets?.saved ?? [] };
    isEcpayPaid = plan.plan === 'paid' || plan.plan === 'cancelled'; // PM-275（需在重繪前設定）
    renderInstallCode(plan.install_code); // PM-277：安裝碼隨方案回應一起來
    ticketWallet.classList.remove('hidden');
    renderTicketWallet();

    // 狀態互斥：先全部收起，再依 plan 開對應的一個（PM-111：多日票兩態）
    upgradeHint.classList.add('hidden');
    intlNotice.classList.add('hidden'); // PM-171
    paidBadge.classList.add('hidden');
    cancelledBadge.classList.add('hidden');
    dayPassStatus.classList.add('hidden');
    dayPassHint.classList.add('hidden');
    if (dayPassTimer !== undefined) {
      clearInterval(dayPassTimer);
      dayPassTimer = undefined;
    }

    const dayPassRemainMs = plan.day_pass_expires_at
      ? new Date(plan.day_pass_expires_at).getTime() - Date.now()
      : 0;

    // PM-189：付費會員（月費 paid / 取消未到期 cancelled / 日票未到期）→ 解鎖 JSON 複製匯出
    // PM-267：改以 server 的 plan.isPaid 為準（已整合活動票券）；
    //   舊版 server 沒有這個欄位時 fallback 回原本的 ECPay 判斷，避免付費用戶被誤鎖。
    const ecpayPaid =
      plan.plan === 'paid' ||
      plan.plan === 'cancelled' ||
      (plan.plan === 'day_pass' && dayPassRemainMs > 0);
    isPaidMember = plan.isPaid ?? ecpayPaid;
    updateJsonLockUI();

    // PM-170：付費/日票/取消 → 三張卡片皆「✨ 無限次」
    const setAllUnlimited = () => {
      setActionDesc(startBtn, t('unlimited', currentUILang));
      setActionDesc(rewindBtn, t('unlimited', currentUILang));
      setActionDesc(screenshotBtn, t('unlimited', currentUILang));
    };

    if (plan.plan === 'paid') {
      // 付費版 → 無限功能 + ✨付費版徽章（含取消訂閱）
      setAllUnlimited();
      startBtn.disabled = false;
      paidBadge.classList.remove('hidden');
    } else if (plan.plan === 'cancelled') {
      // 已取消未到期 → 仍享無限功能 + 到期日 + 重新訂閱
      setAllUnlimited();
      startBtn.disabled = false;
      expiresDate.textContent = fmtDate(plan.plan_expires_at ?? plan.expires_at);
      cancelledBadge.classList.remove('hidden');
    } else if (plan.plan === 'day_pass' && dayPassRemainMs > 0) {
      // PM-111：日票有效中 → 無限功能 + ⚡日票 badge + 倒數；隱藏升級鈕（鎖月費）+ 顯示到期提示
      setAllUnlimited();
      startBtn.disabled = false;
      showDayPassActive(dayPassRemainMs);
    } else if (ticketActive) {
      // PM-267：活動票券生效（plan 仍是 free）→ 比照付費：三張卡片無限次、不顯示升級提示。
      //   狀態由票券區的「🟢 免費體驗中」呈現，故不另開付費徽章。
      setAllUnlimited();
      startBtn.disabled = false;
    } else {
      // 免費版（含未知狀態 fallback）→ PM-170：三張卡片剩餘次數（record/rewind 剩 N 次、screenshot 無限）
      if (plan.limits) renderFreeUsage(plan.limits);
      startBtn.disabled = (plan.limits?.recording.max ?? 1) - (plan.limits?.recording.used ?? 0) <= 0;
      // PM-171：台灣 → 顯示付費按鈕；非台灣 → 綠界收不了款，改顯示 coming soon 藍框
      if (isTaiwanUser()) {
        upgradeHint.classList.remove('hidden');
      } else if (SHOW_INTL_COMING_SOON) {
        intlNotice.classList.remove('hidden'); // PM-411
      }
    }
}

/** 月費升級 → 開結帳跳板頁（該頁讀 session→POST /checkout→送出綠界表單）；未登入退回首頁價目表。
 *  PM-129：改 POST /checkout（session token 認證），不再把 user_id 放 GET URL。 */
async function openCheckout() {
  const session = await checkAuth();
  if (session) {
    void chrome.tabs.create({ url: 'checkout.html' });
  } else {
    chrome.tabs.create({ url: `${API_BASE}/#pricing` });
  }
}

// PM-72：升級；PM-75c：cancelled 用戶重新訂閱——皆走綠界結帳
upgradeBtn.addEventListener('click', () => void openCheckout());
resubBtn.addEventListener('click', () => void openCheckout());

// PM-111：日票升級 → 開結帳跳板頁（該頁讀 session→POST /api/day-pass/create→送出綠界表單）。
// 不能像月費直接 tabs.create 到 API（日票 create 是 POST+auth），故走擴充頁跳板。
dayPassBtn.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'day-pass-checkout.html' });
});

// PM-184：📋 我的報告 → 開 /reports 網頁
// PM-187（P0 資安）：token 改放 URL fragment（#token=）而非 query（?token=）——
//   fragment 不會送到 server、不會出現在 Referrer/歷史紀錄；頁面讀完立即存 localStorage 並清 URL。
const myReportsBtn = $<HTMLButtonElement>('myReportsBtn');
myReportsBtn.addEventListener('click', async () => {
  const store = await chrome.storage.local.get(SESSION_TOKEN_KEY);
  const token = (store[SESSION_TOKEN_KEY] as string) || '';
  void chrome.tabs.create({ url: `${API_BASE}/reports#token=${encodeURIComponent(token)}` });
});

// PM-191：一鍵複製完整 MCP 設定（含 session token）→ 貼給 Claude/Cursor，AI 零操作讀報告（配合 PM-190 URL token）
const copyMcpBtn = $<HTMLButtonElement>('copyMcpBtn');
const copyMcpFeedback = $('copyMcpFeedback');
copyMcpBtn.addEventListener('click', async () => {
  const store = await chrome.storage.local.get(SESSION_TOKEN_KEY);
  const token = (store[SESSION_TOKEN_KEY] as string) || '';
  // PM-417：回饋改成兩張卡（成功=米白確認卡、需登入=咖啡色系統訊息），
  //   顏色由 class 決定而不是 inline style —— inline 的 display:block 會讓
  //   ::before 的六角失去寬高（block 容器裡的 ::before 預設是 inline），所以這裡固定用 flex。
  const showFeedback = (msg: string, warn = false) => {
    copyMcpFeedback.textContent = msg;
    copyMcpFeedback.classList.toggle('warn', warn);
    copyMcpFeedback.style.display = 'flex';
    setTimeout(() => {
      copyMcpFeedback.style.display = 'none';
    }, 4000);
  };
  if (!token) {
    // 未登入 → 不複製空 token 的設定，改提示先登入
    showFeedback(t('copy-mcp-login', currentUILang), true);
    return;
  }
  const config = JSON.stringify(
    { mcpServers: { bugezy: { url: `${API_BASE}/mcp?token=${token}` } } },
    null,
    2,
  );
  await navigator.clipboard.writeText(config);
  showFeedback(t('copy-mcp-done', currentUILang));
});

// PM-170：升級引導 overlay 的按鈕（日票 / 月費 / 關閉）
overlayDayPassBtn.addEventListener('click', () => {
  upgradeOverlay.classList.add('hidden');
  void chrome.tabs.create({ url: 'day-pass-checkout.html' });
});
overlayMonthlyBtn.addEventListener('click', () => {
  upgradeOverlay.classList.add('hidden');
  void openCheckout();
});
upgradeOverlayClose.addEventListener('click', () => upgradeOverlay.classList.add('hidden'));
upgradeOverlay.addEventListener('click', (e) => {
  if (e.target === upgradeOverlay) upgradeOverlay.classList.add('hidden'); // 點背景關閉
});

// PM-111：顯示日票有效中狀態（⚡ badge + 每秒倒數；到期自動 reload 刷新回免費升級畫面）。
function updateCountdown(ms: number) {
  const clamped = Math.max(0, ms);
  const h = Math.floor(clamped / 3600000);
  const m = Math.floor((clamped % 3600000) / 60000);
  const s = Math.floor((clamped % 60000) / 1000);
  // PM-419：設計稿畫面 11 的倒數是純數字 HH:MM:SS（38px 等寬字，§3.3 機器產出）。
  //   原本用 'day-pass-remaining'（「剩餘 18h 42m 07s」）—— 那串在 38px 下塞不進 288px 內容寬，
  //   而且把語言混進了大數字。「這是什麼」交給上面的 DAY PASS 膠囊與下面的說明列講。
  const pad = (n: number) => String(n).padStart(2, '0');
  dayPassCountdown.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
}
function showDayPassActive(remainMs: number) {
  upgradeHint.classList.add('hidden'); // 鎖月費：日票中不顯示升級鈕
  dayPassStatus.classList.remove('hidden');
  dayPassHint.classList.remove('hidden');
  let remain = remainMs;
  updateCountdown(remain);
  if (dayPassTimer !== undefined) clearInterval(dayPassTimer);
  dayPassTimer = window.setInterval(() => {
    remain -= 1000;
    if (remain <= 0) {
      clearInterval(dayPassTimer);
      dayPassTimer = undefined;
      location.reload(); // 到期 → 重新載入 popup，回到免費/升級畫面
      return;
    }
    updateCountdown(remain);
  }, 1000);
}

// PM-73：取消訂閱（二次確認 → POST /api/user/cancel）
cancelSubBtn.addEventListener('click', async () => {
  const confirmed = confirm(t('confirm-cancel-sub', currentUILang));
  if (!confirmed) return;
  const session = await checkAuth();
  if (!session) return;
  try {
    const res = await fetch(`${API_BASE}/api/user/cancel`, {
      method: 'POST',
      headers: await getAuthHeaders(),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      message?: string;
      error?: string;
      new_session_token?: string;
    };
    // PM-166：取消訂閱後 server rotate token，先存新 token 再繼續（舊 token 已失效）
    await applyRotatedToken(data);
    if (data.ok) {
      alert(data.message ?? t('alert-cancelled', currentUILang));
      void loadPlan(); // 重新整理方案狀態（改顯示「已取消，可用到…」）
    } else {
      alert(data.error ?? t('alert-cancel-fail', currentUILang));
    }
  } catch (err) {
    console.error('[BugEzy popup] cancel', err);
    alert(t('alert-cancel-fail', currentUILang));
  }
});

// PM-414：只換 label 的文字，**不要**動整顆按鈕的 textContent ——
//   新版登入鈕裡有 Google logo 的 <img>，textContent 會把它一起洗掉，
//   按一次登入失敗之後 logo 就再也回不來了。
const googleLoginLabel = document.getElementById('googleLoginLabel');
const setLoginLabel = (key: string) => {
  const text = t(key, currentUILang);
  if (googleLoginLabel) googleLoginLabel.textContent = text;
  else googleLoginBtn.textContent = text;
};

googleLoginBtn.addEventListener('click', async () => {
  googleLoginBtn.disabled = true;
  setLoginLabel('login-loading');
  try {
    // PM-133：送 Google token 給 server 驗證 + 推導 user_id（extension 不再自決 user_id）
    const session = await doLogin(true);
    if (!session) throw new Error('auth failed');
    showMainView(session);
  } catch (err) {
    console.error('[BugEzy popup] login', err);
    googleLoginBtn.disabled = false;
    setLoginLabel('login-failed');
  }
});

// PM-414：大黃蜂影片畫出第一幀才把靜態備援藏起來。
//   反過來做（預設藏、載好再顯示）會在 webm 解不開時留一塊空白 —— 這樣至少永遠有隻蜂。
document.querySelector('.bee-stage')?.addEventListener('bee-ready', () => {
  document.getElementById('beeFallback')?.classList.add('hidden');
});

logoutBtn.addEventListener('click', async () => {
  // PM-146：先呼叫 server 撤銷 session（從 sessions 表刪 token，舊 token 立即失效）
  try {
    await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', headers: await getAuthHeaders() });
  } catch {
    /* 靜默失敗，不影響本地登出 */
  }
  await chrome.storage.local.remove([SESSION_KEY, SESSION_TOKEN_KEY]); // PM-129：一併清 session token
  chrome.identity.clearAllCachedAuthTokens(() => {});
  showLoginView();
});

// ── PM-71：版本更新通知 ───────────────────────────────────
const LAST_VERSION_KEY = 'bugezy:lastVersion';

function showUpdateNotice(version: string) {
  const notice = document.createElement('div');
  notice.className = 'update-notice';
  notice.innerHTML = `
    <div class="update-title">🎉 BugEzy 更新到 v${version}</div>
    <div class="update-body">感謝使用 BugEzy！此版本改善了穩定度和使用體驗。</div>
    <button class="update-dismiss" id="dismissUpdate">知道了</button>
  `;
  document.body.prepend(notice);
  document.getElementById('dismissUpdate')?.addEventListener('click', () => notice.remove());
}

/** 版本號從 manifest 讀；與上次記錄不同就顯示更新提示，然後寫回目前版本。 */
async function checkVersionNotice() {
  const currentVersion = chrome.runtime.getManifest().version;
  const stored = await chrome.storage.local.get(LAST_VERSION_KEY);
  const lastVersion = stored[LAST_VERSION_KEY] as string | undefined;
  // 首次安裝（無舊版本記錄）不顯示，只有「升級」才顯示
  if (lastVersion && lastVersion !== currentVersion) showUpdateNotice(currentVersion);
  await chrome.storage.local.set({ [LAST_VERSION_KEY]: currentVersion });
}

// ── PM-114/115：AI 慣用語輪盤（4 則可編輯 + 顏色標記 + ◀▶ 切換 + 複製全文，存 chrome.storage）──
const PROMPTS_KEY = 'bugezy:ai-prompts';
// PM-175：使用者是否手動編輯過 AI 輪盤。true=有自訂（切語言不重置）；false/缺=未自訂（切語言自動重置為新語言預設）。
// 取代原本 JSON.stringify 比對預設值（序列化微差異會誤判，導致英→中切不回來）。
const PROMPTS_CUSTOMIZED_KEY = 'bugezy:prompts-customized';
// PM-115：資料結構 { text, color }（PromptItem/DEFAULT_PROMPTS 移到 i18n.ts，PM-139 多語）。
const DEFAULT_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b'];

const promptPreview = $('prompt-preview');
const promptColorDot = $('prompt-color-dot');
const promptIndex = $('prompt-index');
const promptPrev = $<HTMLButtonElement>('prompt-prev');
const promptNext = $<HTMLButtonElement>('prompt-next');
const promptCopy = $<HTMLButtonElement>('prompt-copy');
const promptEdit = $<HTMLButtonElement>('prompt-edit');
const promptEditor = $('prompt-editor');
const promptTextarea = $<HTMLTextAreaElement>('prompt-textarea');
const promptSave = $<HTMLButtonElement>('prompt-save');
const promptCancel = $<HTMLButtonElement>('prompt-cancel');
const promptCopied = $('prompt-copied');
const colorOptions = Array.from(document.querySelectorAll<HTMLElement>('.color-option'));

let prompts: PromptItem[] = [];
let promptCurrent = 0;
let editingColor = DEFAULT_COLORS[0];

function renderPrompt() {
  const item = prompts[promptCurrent];
  if (!item) return;
  promptPreview.textContent = item.text.split('\n')[0]; // 只預覽第一行（CSS 再截斷 + …）
  promptColorDot.style.background = item.color;
  promptIndex.textContent = `${promptCurrent + 1}/${prompts.length}`;
}

// PM-115 向下相容：舊版存的是 string[]，自動轉成 PromptItem[]（依序分配預設顏色）。
function normalizePrompts(raw: unknown): PromptItem[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...getDefaultPrompts(currentUILang)];
  return raw.map((entry, i) => {
    if (typeof entry === 'string') {
      return { text: entry, color: DEFAULT_COLORS[i % DEFAULT_COLORS.length] };
    }
    const obj = entry as Partial<PromptItem>;
    return {
      text: typeof obj.text === 'string' ? obj.text : '',
      color: typeof obj.color === 'string' ? obj.color : DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    };
  });
}

async function initPrompts() {
  const store = await chrome.storage.local.get(PROMPTS_KEY);
  prompts = normalizePrompts(store[PROMPTS_KEY]);
  promptCurrent = 0;
  renderPrompt();
}

function highlightColorOption(color: string) {
  colorOptions.forEach((el) => el.classList.toggle('selected', el.dataset.color === color));
}

// PM-116：編輯器開著時把 textarea + 選色同步到目前這一則
function syncEditorToCurrentPrompt() {
  const item = prompts[promptCurrent];
  if (!item) return;
  promptTextarea.value = item.text;
  editingColor = item.color;
  highlightColorOption(editingColor);
}

// PM-116：◀▶ 切換——若編輯器開著，先自動存回當前修改，切換後再同步 textarea/選色
function switchPrompt(direction: number) {
  const editing = promptEditor.style.display !== 'none';
  if (editing) {
    const newText = promptTextarea.value.trim();
    if (newText && newText !== prompts[promptCurrent]?.text) {
      prompts[promptCurrent] = { text: newText, color: editingColor };
      // PM-175：切換時自動存回的編輯也算自訂 → 標記已自訂
      void chrome.storage.local.set({ [PROMPTS_KEY]: prompts, [PROMPTS_CUSTOMIZED_KEY]: true });
    }
  }
  promptCurrent = (promptCurrent + direction + prompts.length) % prompts.length;
  renderPrompt();
  if (editing) syncEditorToCurrentPrompt();
}

promptPrev.addEventListener('click', () => switchPrompt(-1));
promptNext.addEventListener('click', () => switchPrompt(1));
promptCopy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(prompts[promptCurrent]?.text ?? ''); // 複製完整全文（含換行）
  promptCopied.style.display = 'inline-block';
  setTimeout(() => {
    promptCopied.style.display = 'none';
  }, 2000);
});
promptEdit.addEventListener('click', () => {
  const item = prompts[promptCurrent];
  if (!item) return;
  promptTextarea.value = item.text;
  editingColor = item.color;
  highlightColorOption(editingColor);
  promptEditor.style.display = 'block';
});
colorOptions.forEach((el) => {
  el.addEventListener('click', () => {
    editingColor = el.dataset.color || DEFAULT_COLORS[0];
    highlightColorOption(editingColor);
  });
});
promptSave.addEventListener('click', async () => {
  prompts[promptCurrent] = { text: promptTextarea.value.trim(), color: editingColor };
  // PM-175：使用者手動儲存 → 標記已自訂，之後切語言不再重置
  await chrome.storage.local.set({ [PROMPTS_KEY]: prompts, [PROMPTS_CUSTOMIZED_KEY]: true });
  promptEditor.style.display = 'none';
  renderPrompt();
});
promptCancel.addEventListener('click', () => {
  promptEditor.style.display = 'none';
});

// PM-121：移除釘選/收合——輪盤永遠展開（prompt-body 於 HTML 即 display:block）。
// PM-139：initPrompts 改由語言初始化 callback 呼叫（確保依當前 UI 語言載入預設）。

// PM-122：進階設定 accordion（四個 toggle 折疊；預設收合，展開狀態存 storage）
const SETTINGS_OPEN_KEY = 'bugezy:settings-open';
const settingsHeader = $('settings-header');
const settingsBody = $('settings-body');
const settingsChevron = $('settings-chevron');
let settingsOpen = false;
function updateSettingsUI() {
  settingsBody.style.display = settingsOpen ? 'block' : 'none';
  settingsChevron.classList.toggle('open', settingsOpen);
}
chrome.storage.local.get(SETTINGS_OPEN_KEY, (r) => {
  settingsOpen = r[SETTINGS_OPEN_KEY] === true; // 預設收合
  updateSettingsUI();
});
settingsHeader.addEventListener('click', () => {
  settingsOpen = !settingsOpen;
  void chrome.storage.local.set({ [SETTINGS_OPEN_KEY]: settingsOpen });
  updateSettingsUI();
});

// PM-126：向 server 查最新版號，與 manifest 不一致 → popup 頂部亮燈提示（點擊開 /changelog）
async function checkNewVersion() {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    const res = await fetch(`${API_BASE}/api/version`);
    if (!res.ok) return;
    const data = (await res.json()) as { latest?: string; changelog_url?: string };
    if (data.latest && data.latest !== currentVersion) {
      const badge = $('update-badge');
      badge.style.display = 'flex';
      badge.textContent = t('update-available', currentUILang, {
        cur: currentVersion,
        new: data.latest,
      });
      const url = data.changelog_url || `${API_BASE}/changelog`;
      badge.addEventListener('click', () => void chrome.tabs.create({ url }));
    }
  } catch {
    /* 靜默失敗，不影響使用 */
  }
}

// PM-127：popup 底部永遠顯示目前版號（不管有無新版）
$('popup-version').textContent = `BugEzy v${chrome.runtime.getManifest().version}`;

// 開啟 popup：先看是否已登入，再決定畫面
void checkVersionNotice();
void checkNewVersion();
void checkAuth().then((session) => {
  if (session) {
    showMainView(session);
    // PM-133：既有登入若還是舊 base64 token，靜默換成有效 DB token（已授權者無感）
    void refreshSessionSilently();
  } else {
    showLoginView();
  }
});

// ── PM-383~386：手動釘選模式 + 圖釘清單 ──────────────────────────────────
//
// ⚠ **釘選模式不會因為 popup 關閉而結束。** 卡片 PM-383 的驗收 3 寫「popup 關閉 →
//   自動結束釘選模式」，但 popup 一失焦就會關閉，而使用者要點的正是頁面上的元素——
//   自動結束等於這個功能永遠用不到（詳見 DONE-383）。改為：再按一次按鈕、或在頁面上
//   按 ESC 才結束；模式啟動期間頁面上一直有一條橫幅，不會有「不知不覺還開著」的情況。

const PIN_MODE_KEY = 'bugezy_pin_mode';

interface PopupPin {
  pin_id: string;
  selector: string;
  description: string;
  status: 'active' | 'warning' | 'error' | 'stale';
  resolved: boolean;
  emoji: string;
}

/** 送訊息給當前分頁的 content script。沒有 content script（chrome:// 等）→ 回 null。 */
async function toContent<T = unknown>(msg: Record<string, unknown>): Promise<T | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  return (await chrome.tabs.sendMessage(tab.id, msg).catch(() => null)) as T | null;
}

// PM-393 的純文字版 formatProbeLine／formatPatrolResult 已於 PM-405 由結構化渲染取代，
// 沒有呼叫端就不留（死碼會讓下一個人以為還有第二條顯示路徑）。

function pinResultShow(text: string): void {
  const box = document.getElementById('pinResult');
  if (!box) return;
  box.textContent = text;
  box.classList.remove('hidden');
}

/**
 * PM-405：把巡檢／分析結果畫成有顏色的區塊，而不是一坨文字。
 *
 * **顏色來自 summary 開頭的 emoji**（🔴/🟡/🟢/⚪），那是 content script 已經算好的判定——
 * popup 不重新解讀 JSON 去猜嚴重度。兩邊各算一次判定遲早會分岔（PM-350 的
 * score/summary 不同步已經吃過這個虧）。
 *
 * PM-418：協定沒變，變的只是呈現 —— emoji 不再印在文字裡，改由 sevClass() 對照成
 * CSS class，色碼統一收在 popup.html 的 token（§7.7 左側 3px 色條）。
 */
/**
 * PM-418：判定訊號**還是** content script 開頭那顆圓點 emoji（協定沒變，popup 仍然不重算），
 * 但畫面上不再印出 emoji —— 改成 §7.7 的左側 3px 色條，色碼由 CSS class 決定。
 * 這裡只負責 emoji → class 的對照，顏色一律留在 popup.html 的 token 裡。
 */
function sevClass(emoji: string): string {
  if (emoji === '🔴') return 'sev-err';
  if (emoji === '🟡') return 'sev-warn';
  if (emoji === '🟢' || emoji === '✅') return 'sev-ok';
  return 'sev-none';
}

function pinResultRender(title: string, rows: Array<{ summary: string; selector: string; detail?: string }>, footer?: string): void {
  const box = document.getElementById('pinResult');
  if (!box) return;
  while (box.firstChild) box.removeChild(box.firstChild);
  box.classList.remove('hidden');

  const h = document.createElement('div');
  h.className = 'pin-res-title';
  h.textContent = title;
  box.appendChild(h);

  for (const r of rows) {
    const emoji = [...r.summary][0] ?? '';
    const item = document.createElement('div');
    item.className = `pin-res-row ${sevClass(emoji)}`;
    const sel = document.createElement('div');
    sel.className = 'pin-res-sel';
    // PM-418：emoji 不進畫面，嚴重度由左側色條表示
    sel.textContent = r.selector;
    item.appendChild(sel);
    const sum = document.createElement('div');
    sum.className = 'pin-res-sum';
    // 去掉開頭的判定 emoji（它現在是色條，不是文字）
    sum.textContent = r.summary.replace(/^[🔴🟡🟢⚪✅]\s*/u, '');
    item.appendChild(sum);
    if (r.detail) {
      const d = document.createElement('div');
      d.className = 'pin-res-detail';
      d.textContent = r.detail;
      item.appendChild(d);
    }
    box.appendChild(item);
  }

  if (footer) {
    const f = document.createElement('div');
    f.className = 'pin-res-foot';
    f.textContent = footer;
    box.appendChild(f);
  }
}

function renderPinModeBtn(on: boolean): void {
  const btn = document.getElementById('pinModeBtn');
  if (!btn) return;
  btn.classList.toggle('on', on);
  btn.textContent = on ? t('pin-mode-btn-on', currentUILang) : t('pin-mode', currentUILang);
}

async function refreshPinList(): Promise<void> {
  const list = document.getElementById('pinList');
  const bulk = document.getElementById('pinBulk');
  const count = document.getElementById('pinCount');
  if (!list || !bulk || !count) return;

  const data = await toContent<{ pins: PopupPin[]; total_count: number; pin_mode: boolean }>({
    type: 'GET_PIN_LIST',
  });
  while (list.firstChild) list.removeChild(list.firstChild);

  if (!data) {
    // 分頁沒有 content script（chrome://、應用程式商店、PDF）——講清楚而不是顯示成「沒有圖釘」
    count.textContent = t('pin-section-title', currentUILang);
    const p = document.createElement('div');
    p.className = 'pin-empty';
    p.textContent = t('pin-unsupported', currentUILang);
    list.appendChild(p);
    bulk.classList.add('hidden');
    return;
  }

  renderPinModeBtn(data.pin_mode);
  count.textContent = t('pin-count', currentUILang, { n: data.total_count });

  if (data.total_count === 0) {
    const p = document.createElement('div');
    p.className = 'pin-empty';
    p.textContent = t('pin-empty', currentUILang);
    list.appendChild(p);
    bulk.classList.add('hidden');
    return;
  }
  bulk.classList.remove('hidden');

  for (const pin of data.pins) {
    const item = document.createElement('div');
    // PM-418：狀態由左側 3px 色條表示，emoji 不進畫面（判定來源仍是 content script 的 pin.emoji）
    item.className = `pin-item ${sevClass(pin.emoji)}${pin.resolved ? ' resolved' : ''}`;

    const sel = document.createElement('div');
    sel.className = 'pin-sel';
    sel.textContent = `${pin.selector}${pin.status === 'stale' ? '（stale）' : ''}`;
    item.appendChild(sel);

    if (pin.description) {
      const d = document.createElement('div');
      d.className = 'pin-desc';
      d.textContent = `「${pin.description}」`;
      item.appendChild(d);
    }

    const acts = document.createElement('div');
    acts.className = 'pin-acts';

    const analyze = document.createElement('button');
    analyze.className = 'pin-act';
    analyze.textContent = t('pin-analyze', currentUILang);
    // stale = 元素已從 DOM 消失，沒有東西可分析。禁用比讓它跑出一個錯誤誠實。
    analyze.disabled = pin.status === 'stale';
    analyze.addEventListener('click', () => {
      void (async () => {
        analyze.disabled = true;
        const r = await toContent<Record<string, unknown>>({
          type: 'BRIDGE_PIN_ANALYZE',
          selector: pin.selector,
        });
        // PM-393：顯示人話而不是 JSON。summary 已經由 content script 組成
        //   「🔴 點擊觸發 TypeError: …」這種形式，直接用即可。
        if (r && typeof r.error === 'string') pinResultShow(r.error);
        else renderAnalyzeResult(pin.selector, r);
        await refreshPinList();
      })();
    });
    acts.appendChild(analyze);

    const remove = document.createElement('button');
    remove.className = 'pin-act';
    remove.textContent = t('pin-remove', currentUILang);
    remove.addEventListener('click', () => {
      void (async () => {
        await toContent({ type: 'BRIDGE_REMOVE_PIN', pin_id: pin.pin_id });
        await refreshPinList();
      })();
    });
    acts.appendChild(remove);

    item.appendChild(acts);
    list.appendChild(item);
  }
}

async function togglePinMode(): Promise<void> {
  const cur = await toContent<{ pin_mode: boolean }>({ type: 'PIN_MODE_STATUS' });
  if (!cur) {
    pinResultShow(t('pin-unsupported', currentUILang));
    return;
  }
  const next = !cur.pin_mode;
  const r = await toContent<{ pin_mode: boolean }>({ type: next ? 'PIN_MODE_ON' : 'PIN_MODE_OFF' });
  const on = r?.pin_mode === true;
  renderPinModeBtn(on);
  // chrome.storage.session：popup 重開時先用它畫，避免閃一下錯的狀態
  try {
    await chrome.storage.session.set({ [PIN_MODE_KEY]: on });
  } catch {
    /* session storage 不可用時只是少了預先渲染，不影響功能 */
  }
  if (on) {
    pinResultShow(t('pin-mode-on-hint', currentUILang));
  }
}

function initPinUi(): void {
  document.getElementById('pinModeBtn')?.addEventListener('click', () => void togglePinMode());
  document.getElementById('pinPatrolBtn')?.addEventListener('click', () => {
    void (async () => {
      pinResultShow(t('patrol-running', currentUILang));
      const r = await toContent<Record<string, unknown>>({ type: 'BRIDGE_PATROL_PINS' });
      renderPatrolResult(r);
      await refreshPinList();
    })();
  });
  document.getElementById('pinClearBtn')?.addEventListener('click', () => {
    void (async () => {
      if (!confirm(t('pin-clear-confirm', currentUILang))) return;
      await toContent({ type: 'BRIDGE_CLEAR_PINS', status: 'all' });
      document.getElementById('pinResult')?.classList.add('hidden');
      await refreshPinList();
    })();
  });

  // 先用 session 記住的狀態畫一次（避免閃爍），再向 content script 要真實狀態校正
  void (async () => {
    try {
      const cached = await chrome.storage.session.get(PIN_MODE_KEY);
      renderPinModeBtn(cached?.[PIN_MODE_KEY] === true);
    } catch {
      /* 忽略 */
    }
    await refreshPinList();
  })();
}

initPinUi();

// ── PM-403／404：兩層架構（第一層日常功能 ／ 第二層偵察模式）────────────────
//
// 實作方式刻意保守：**不去重排既有的 idleView**，而是把圖釘那一段整段搬到新的
// `#scoutView`，兩個 section 用既有的 `.hidden` 機制切換。popup 有太多既有功能
// 掛在 idleView 上（錄製／截圖／票券／提示詞／設定），把它拆成兩個滑動面板
// 風險遠大於收益，而使用者看到的結果是一樣的。

function showScout(on: boolean): void {
  const idle = document.getElementById('idleView');
  const scout = document.getElementById('scoutView');
  if (!idle || !scout) return;
  idle.classList.toggle('hidden', on);
  scout.classList.toggle('hidden', !on);
  // PM-418：第二層整頁反黑（§9.3）。scout-open 是給 show() 看的旗標——
  //   沒有它的話，錄製狀態一更新就會呼叫 show('idle') 把偵察模式的黑底關掉。
  document.body.classList.toggle('scout-open', on);
  document.body.classList.toggle('dark', on);
  if (on) {
    scout.classList.remove('slide-in');
    void scout.offsetWidth; // 重新觸發動畫（不 reflow 的話同一個 class 不會再播一次）
    scout.classList.add('slide-in');
    void refreshPinList();
    void refreshMemoryStats();
  }
}

/** 第一層的入口按鈕上顯示圖釘數，不進第二層也知道有沒有東西在盯。 */
async function refreshScoutBadge(): Promise<void> {
  const badge = document.getElementById('scoutPinBadge');
  if (!badge) return;
  const data = await toContent<{ total_count: number }>({ type: 'GET_PIN_LIST' });
  const n = data?.total_count ?? 0;
  badge.textContent = String(n);
  badge.classList.toggle('hidden', n === 0);
}

// ── PM-404：AI 監測 ────────────────────────────────────────────────────────
//
// ⚠ `start_auto_detect` 本身在 **bridge** 裡（它是編排既有工具的呼叫序列），
//   popup 沒有那條通道。但它編排的每一支底層工具 content script 都有，
//   所以這裡直接照同樣的順序問一遍 —— **不是重寫偵測邏輯，是重跑同一組查詢**。

async function runScanAll(): Promise<void> {
  const box = document.getElementById('scanResult');
  const btn = document.getElementById('scanAllBtn') as HTMLButtonElement | null;
  if (!box) return;
  if (btn) btn.disabled = true;
  box.textContent = t('scout-scanning', currentUILang);
  try {
    await toContent({ type: 'BRIDGE_MAP_ZONES' }); // 先分區，get_zone_health 才有東西可算
    const [health, zones, errs] = await Promise.all([
      toContent<Record<string, unknown>>({ type: 'BRIDGE_GET_PAGE_HEALTH' }),
      toContent<Record<string, unknown>>({ type: 'BRIDGE_ZONE_HEALTH' }),
      toContent<Record<string, unknown>>({ type: 'BRIDGE_GET_BROWSER_ERRORS' }),
    ]);
    if (!health && !zones && !errs) {
      box.textContent = t('scout-unsupported', currentUILang);
      return;
    }
    const zoneList = (zones?.zones ?? []) as Array<{ status?: string }>;
    const count = (st: string) => zoneList.filter((z) => z.status === st).length;
    const cons = (errs?.console_errors ?? []) as Array<{ severity?: string }>;
    const nets = (errs?.network_errors ?? []) as Array<{ severity?: string }>;
    const critical = [...cons, ...nets].filter((e) => e.severity === 'critical').length;
    const minor = [...cons, ...nets].filter((e) => e.severity === 'minor').length;

    while (box.firstChild) box.removeChild(box.firstChild);
    const line = (label: string, value: string) => {
      const d = document.createElement('div');
      d.textContent = `${label}${value}`;
      box.appendChild(d);
    };
    line(t('scout-zone', currentUILang), zoneList.length
      ? t('scout-zone-fmt', currentUILang, { n: zoneList.length, ok: count('healthy'), warn: count('warning'), err: count('error') })
      : t('scout-zone-none', currentUILang));
    line(t('scout-error', currentUILang), critical || minor
      ? t('scout-error-fmt', currentUILang, { critical, minor })
      : t('scout-error-none', currentUILang));
    if (typeof health?.score === 'number') line(t('scout-score', currentUILang), `${health.score}/100`);
    // 空結果的意思是「最近 30 秒沒出事」，不是「沒問題」——這句話不能省
    const note = document.createElement('div');
    note.className = 'scout-note';
    note.textContent = t('scout-window-note', currentUILang);
    box.appendChild(note);
  } catch (e) {
    box.textContent = `${t('scout-scan-failed', currentUILang)}：${String(e).slice(0, 120)}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── PM-404：記憶矩陣 ───────────────────────────────────────────────────────
// PM-408：層名走字典（原本是硬編碼中文，英文模式下會中英夾雜）
const memLayerName = (layer: string): string => t(`mem-${layer.toLowerCase()}`, currentUILang);

async function refreshMemoryStats(): Promise<void> {
  const box = document.getElementById('memResult');
  if (!box) return;
  box.textContent = t('scout-loading', currentUILang);
  const r = (await chrome.runtime.sendMessage({ type: 'BRIDGE_QUERY_MEMORY_STATS' }).catch(() => null)) as
    | { ok: boolean; data?: Record<string, unknown>; error?: string }
    | null;

  while (box.firstChild) box.removeChild(box.firstChild);
  if (!r || !r.ok) {
    // 「連不上」與「連上但出錯」是兩件事，訊息要分開，否則使用者不知道要去修哪個
    const d = document.createElement('div');
    d.textContent = r?.error === 'bridge_offline' || r?.error === 'bridge_timeout'
      ? t('mem-bridge-off', currentUILang)
      : `${t('mem-read-failed', currentUILang)}：${r?.error ?? t('mem-unknown', currentUILang)}`;
    box.appendChild(d);
    return;
  }
  const data = r.data ?? {};
  if (data.initialized === false) {
    const d = document.createElement('div');
    d.textContent = t('mem-not-init', currentUILang);
    box.appendChild(d);
    return;
  }
  const per = (data.entries_per_layer ?? {}) as Record<string, number>;
  const total = Object.values(per).reduce((a, b) => a + Number(b || 0), 0);

  const head = document.createElement('div');
  head.textContent = t('mem-summary', currentUILang, { n: total, layers: Object.keys(per).length });
  box.appendChild(head);
  for (const [layer, n] of Object.entries(per)) {
    const row = document.createElement('div');
    row.textContent = t('mem-layer-row', currentUILang, { layer, name: memLayerName(layer), n });
    box.appendChild(row);
  }
  const note = document.createElement('div');
  note.className = 'scout-note';
  // 🔴 為什麼不提供「清除全部」按鈕：見 DONE-404
  note.textContent = t('mem-readonly-note', currentUILang);
  box.appendChild(note);
}

// ── PM-405：巡檢／分析結果改成人類可讀 ─────────────────────────────────────
/** PM-405：巡檢結果 —— 每個圖釘一列，底部給「問題 N ｜ 正常 M」。 */
function renderPatrolResult(r: Record<string, unknown> | null): void {
  if (!r) return pinResultShow(t('patrol-failed', currentUILang));
  if (typeof r.error === 'string') return pinResultShow(r.error);
  const results = (r.results ?? []) as Array<Record<string, unknown>>;
  if (results.length === 0) return pinResultShow(String(r.note ?? t('patrol-no-pins', currentUILang)));

  const problems = Number(r.problem_count ?? 0);
  pinResultRender(
    t('patrol-title', currentUILang, { n: results.length }),
    results.map((x) => ({
      summary: String(x.summary ?? ''),
      selector: String(x.selector ?? ''),
      detail: x.changed ? t('patrol-changed', currentUILang, { from: String(x.previous_status), to: String(x.status) }) : undefined,
    })),
    t('patrol-footer', currentUILang, { bad: problems, ok: results.length - problems })
      + (r.note ? `
${String(r.note)}` : ''),
  );
}

/** PM-405：單一圖釘的分析結果 —— 探測類型／耗時／可見性都攤開。 */
function renderAnalyzeResult(selector: string, r: Record<string, unknown> | null): void {
  if (!r) return pinResultShow(t('analyze-failed', currentUILang));
  const probe = (r.probe ?? {}) as Record<string, unknown>;
  const analysis = (r.analysis ?? {}) as Record<string, unknown>;
  const vis = (analysis.visibility ?? {}) as Record<string, unknown>;
  const box = (analysis.box_model ?? {}) as Record<string, unknown>;

  const bits: string[] = [];
  if (probe.type) {
    bits.push(t('analyze-probe', currentUILang, { type: String(probe.type) })
      + (typeof probe.duration_ms === 'number' ? `（${probe.duration_ms} ms）` : ''));
  }
  if (probe.restored === false) bits.push(t('analyze-not-restored', currentUILang));
  if (typeof probe.note === 'string' && probe.note) bits.push(probe.note);
  // PM-418：原本塞 ✅ / ❌ 兩顆 emoji 進格式字串。改用「有／無」的文字 key，
  //   §7.7「不靠顏色傳達內容」同理也不該靠 emoji。
  const yn = (b: unknown) => t(b ? 'yes' : 'no', currentUILang);
  bits.push(t('analyze-visible', currentUILang, { v: yn(vis.visible), i: yn(vis.has_size) }));
  if (typeof box.width === 'number') {
    bits.push(t('analyze-size', currentUILang, { w: Math.round(Number(box.width)), h: Math.round(Number(box.height)) }));
  }

  pinResultRender(t('analyze-title', currentUILang), [{
    summary: String(r.summary ?? ''),
    selector,
    detail: bits.join('　'),
  }]);
}

function initScoutUi(): void {
  document.getElementById('scoutEnterBtn')?.addEventListener('click', () => showScout(true));
  document.getElementById('scoutBackBtn')?.addEventListener('click', () => showScout(false));
  document.getElementById('scanAllBtn')?.addEventListener('click', () => void runScanAll());
  document.getElementById('memRefreshBtn')?.addEventListener('click', () => void refreshMemoryStats());
  void refreshScoutBadge();
}

initScoutUi();
