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
import { getAuthHeaders } from './auth';
import { t, getUILang, type UILang } from './i18n';

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
// PM-111：日票升級鈕 + 日票中倒數狀態
const dayPassBtn = $<HTMLButtonElement>('dayPassBtn');
const dayPassStatus = $('dayPassStatus');
const dayPassCountdown = $('dayPassCountdown');
const dayPassHint = $('dayPassHint');
let dayPassTimer: number | undefined;

// PM-49：鍵盤模式 toggle（關閉語音）— 狀態存 chrome.storage.local
const keyboardMode = $<HTMLInputElement>('keyboardMode');
chrome.storage.local.get(KEYBOARD_MODE_KEY, (r) => {
  keyboardMode.checked = r[KEYBOARD_MODE_KEY] === true;
});
keyboardMode.addEventListener('change', () => {
  chrome.storage.local.set({ [KEYBOARD_MODE_KEY]: keyboardMode.checked });
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

/** PM-138：依 currentUILang 把所有 [data-i18n] 元素的文字換掉（保留 emoji，字典值已含）。 */
function applyTranslations() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key, currentUILang);
  });
}

chrome.storage.local.get(LANG_KEY, (r) => {
  const speechLang = (r[LANG_KEY] as string) || 'zh';
  langSelect.value = speechLang;
  currentUILang = getUILang(speechLang);
  applyTranslations();
  void loadPlan(); // 依語言重繪動態文字（用量/倒數/paid 等）
});
langSelect.addEventListener('change', () => {
  const speechLang = langSelect.value;
  void chrome.storage.local.set({ [LANG_KEY]: speechLang });
  currentUILang = getUILang(speechLang);
  applyTranslations(); // 先套靜態文字（會覆寫 record-desc 等為預設）
  void loadPlan(); // 再依方案重繪動態文字（覆寫回用量/無限次/倒數）
});

// PM-86：麥克風 toggle（標題列）— offscreen 錄音 + Groq Whisper 架構；預設開啟，狀態存 storage
const micToggle = $<HTMLInputElement>('micToggle');
const micIcon = $('micIcon');
// PM-91：付費版語音模式（即時字幕 / 精準轉錄）— 免費版隱藏
const micMode = $('micMode');
const modeBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.mic-mode-btn'));
let micPlan = 'free';

function updateMicModeUI() {
  // 付費版（paid/cancelled）+ 麥克風開啟才顯示模式選擇
  micMode.style.display = micPlan !== 'free' && micToggle.checked ? 'flex' : 'none';
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
    await send('REWIND_30S');
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
      uploadStatusEl.textContent = '⏳ 正在上傳到雲端...';
      shareUrlRow.style.display = 'none';
      break;
    case 'success':
      uploadStatusEl.textContent = '✅ 已上傳';
      if (summary.shareUrl) {
        shareUrlRow.style.display = 'flex';
        shareLink.href = summary.shareUrl;
        shareLink.textContent = summary.shareUrl;
      }
      break;
    case 'error':
      uploadStatusEl.textContent = '❌ 上傳失敗（可手動匯出 JSON）';
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
    // PM-63：免費版用量已達上限 → 不進入錄製，顯示升級提示
    if (res.limitReached) {
      setRecordDesc(t('used-up', currentUILang));
      const span = upgradeHint.querySelector('span');
      if (span) span.textContent = res.limitReached;
      upgradeHint.classList.remove('hidden');
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
const micPrompt = $('micPrompt');
function showMicPrompt() {
  micPrompt.style.display = 'flex';
}
function hideMicPrompt() {
  micPrompt.style.display = 'none';
}
startBtn.addEventListener('click', async () => {
  const store = await chrome.storage.local.get([MIC_KEY, KEYBOARD_MODE_KEY]);
  const micOn = store[MIC_KEY] === true;
  const kbOn = store[KEYBOARD_MODE_KEY] === true;
  if (!micOn && !kbOn) {
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
  // 已授權：開 mic + 同步 UI + 直接錄製
  await chrome.storage.local.set({ [MIC_KEY]: true });
  micToggle.checked = true;
  updateMicUI();
  hideMicPrompt();
  await doStartRecording();
});

// PM-107：「直接錄製（不錄語音）」→ 不開 mic，直接錄
$<HTMLButtonElement>('micPromptSkip').addEventListener('click', () => {
  hideMicPrompt();
  void doStartRecording();
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
screenshotBtn.addEventListener('click', async () => {
  screenshotBtn.disabled = true;
  try {
    await send('CAPTURE_SCREENSHOT');
  } catch (err) {
    console.error('[BugEzy popup]', err);
    screenshotBtn.disabled = false;
  }
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
  const { payload } = await send<{ payload: RecordingPayload | null }>('GET_LAST_PAYLOAD');
  if (!payload) return;
  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  copyBtn.textContent = '✅ 已複製';
  copyBtn.classList.add('copied');
  setTimeout(() => {
    copyBtn.textContent = '📋 複製 JSON';
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
    exportBtn.textContent = '✅ 已匯出到 Downloads/bugezy-debug';
    exportBtn.classList.add('done');
    setTimeout(() => {
      exportBtn.textContent = '💾 匯出 JSON（給 AI 讀）';
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
  expires_at?: string | null;
  plan_expires_at?: string | null; // PM-134：月費到期日（cancelled 顯示用；與 expires_at 同值）
  day_pass_expires_at?: string | null; // PM-111：日票到期時間
  limits: null | {
    recording: { used: number; max: number };
    rewind: { used: number; max: number };
    mcp: { used: number; max: number };
  };
}

/** ISO 日期 → YYYY/MM/DD（顯示用，避免依賴 Intl locale）。 */
function fmtDate(iso?: string | null): string {
  return iso ? iso.slice(0, 10).replace(/-/g, '/') : '本期結束';
}

/** 只更新錄製按鈕的 .action-desc（不覆寫整顆按鈕，保留 icon/label span）。 */
function setRecordDesc(text: string) {
  const desc = startBtn.querySelector<HTMLElement>('.action-desc');
  if (desc) desc.textContent = text;
}

// PM-63/75：查方案 → 依 plan 狀態（source of truth）控制 UI。
// paid：隱藏升級提示 + ✨ + 管理訂閱（含取消）；cancelled：隱藏升級提示 + 顯示到期日；free：剩餘次數 + 升級提示。
async function loadPlan() {
  try {
    const res = await fetch(`${API_BASE}/api/user/plan`, {
      headers: await getAuthHeaders(),
    });
    if (!res.ok) return; // 表未建/未授權等 → 不顯示用量，按鈕維持原樣（非阻擋）
    const plan = (await res.json()) as PlanInfo;
    // PM-87：持久化 plan 供 background/content 路由語音引擎（free→Web Speech、paid/cancelled→Groq Whisper）
    void chrome.storage.local.set({ [USER_PLAN_KEY]: plan.plan });
    // PM-91：更新模式選擇可見性（付費版才顯示）
    micPlan = plan.plan;
    updateMicModeUI();

    // 狀態互斥：先全部收起，再依 plan 開對應的一個（PM-111：多日票兩態）
    upgradeHint.classList.add('hidden');
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

    if (plan.plan === 'paid') {
      // 付費版 → 無限功能 + ✨付費版徽章（含取消訂閱）
      setRecordDesc(t('unlimited', currentUILang));
      startBtn.disabled = false;
      paidBadge.classList.remove('hidden');
    } else if (plan.plan === 'cancelled') {
      // 已取消未到期 → 仍享無限功能 + 到期日 + 重新訂閱
      setRecordDesc(t('unlimited', currentUILang));
      startBtn.disabled = false;
      expiresDate.textContent = fmtDate(plan.plan_expires_at ?? plan.expires_at);
      cancelledBadge.classList.remove('hidden');
    } else if (plan.plan === 'day_pass' && dayPassRemainMs > 0) {
      // PM-111：日票有效中 → 無限功能 + ⚡日票 badge + 倒數；隱藏升級鈕（鎖月費）+ 顯示到期提示
      setRecordDesc(t('unlimited', currentUILang));
      startBtn.disabled = false;
      showDayPassActive(dayPassRemainMs);
    } else {
      // 免費版（含未知狀態 fallback）→ 剩餘次數 + 升級提示
      const rec = plan.limits?.recording;
      if (rec) {
        const remain = rec.max - rec.used;
        if (remain > 0) {
          setRecordDesc(t('remaining', currentUILang, { n: remain }));
          startBtn.disabled = false;
        } else {
          setRecordDesc(t('used-up', currentUILang));
          startBtn.disabled = true;
        }
      }
      upgradeHint.classList.remove('hidden');
    }
  } catch {
    /* API 不通就維持預設按鈕 */
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

// PM-111：顯示日票有效中狀態（⚡ badge + 每秒倒數；到期自動 reload 刷新回免費升級畫面）。
function updateCountdown(ms: number) {
  const clamped = Math.max(0, ms);
  const h = Math.floor(clamped / 3600000);
  const m = Math.floor((clamped % 3600000) / 60000);
  const s = Math.floor((clamped % 60000) / 1000);
  dayPassCountdown.textContent = t('day-pass-remaining', currentUILang, { h, m, s });
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
  const confirmed = confirm(
    '確定要取消訂閱嗎？\n取消後當月剩餘天數仍可使用付費功能，下個月恢復為免費版。',
  );
  if (!confirmed) return;
  const session = await checkAuth();
  if (!session) return;
  try {
    const res = await fetch(`${API_BASE}/api/user/cancel`, {
      method: 'POST',
      headers: await getAuthHeaders(),
    });
    const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
    if (data.ok) {
      alert(data.message ?? '已取消訂閱');
      void loadPlan(); // 重新整理方案狀態（改顯示「已取消，可用到…」）
    } else {
      alert(data.error ?? '取消失敗，請稍後再試');
    }
  } catch (err) {
    console.error('[BugEzy popup] cancel', err);
    alert('取消失敗，請稍後再試');
  }
});

googleLoginBtn.addEventListener('click', async () => {
  googleLoginBtn.disabled = true;
  googleLoginBtn.textContent = t('login-loading', currentUILang);
  try {
    // PM-133：送 Google token 給 server 驗證 + 推導 user_id（extension 不再自決 user_id）
    const session = await doLogin(true);
    if (!session) throw new Error('auth failed');
    showMainView(session);
  } catch (err) {
    console.error('[BugEzy popup] login', err);
    googleLoginBtn.disabled = false;
    googleLoginBtn.textContent = t('login-failed', currentUILang);
  }
});

logoutBtn.addEventListener('click', async () => {
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
// PM-115：資料結構改為 { text, color }。
interface PromptItem {
  text: string;
  color: string;
}
const DEFAULT_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b'];
const DEFAULT_PROMPTS: PromptItem[] = [
  { text: '請讀取我最新的 BugEzy 報告，幫我找出問題並修復', color: '#ef4444' },
  {
    text: '請讀取最新 BugEzy 報告，分析：\n1. 真正的 root cause\n2. 修復方案\n3. 修改哪些檔案\n4. 產生 fix plan\n請不要猜測，如果資料不足請告知需要哪些資訊',
    color: '#3b82f6',
  },
  { text: '請讀取我最新的截圖報告，看畫面哪裡有問題，給我 CSS/HTML 修復建議', color: '#22c55e' },
  { text: '請讀取最新 BugEzy 報告，直接給我可以貼上的修復程式碼', color: '#f59e0b' },
];

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
  if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_PROMPTS];
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
      void chrome.storage.local.set({ [PROMPTS_KEY]: prompts });
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
  await chrome.storage.local.set({ [PROMPTS_KEY]: prompts });
  promptEditor.style.display = 'none';
  renderPrompt();
});
promptCancel.addEventListener('click', () => {
  promptEditor.style.display = 'none';
});

// PM-121：移除釘選/收合——輪盤永遠展開（prompt-body 於 HTML 即 display:block）。

void initPrompts();

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
