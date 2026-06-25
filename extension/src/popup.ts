// popup.ts — Popup UI 邏輯（三態：閒置 / 錄製中 / 錄製完成）
// 與 background service worker 溝通：開始/停止/清除、輪詢狀態、顯示摘要、複製 JSON。

import {
  KEYBOARD_MODE_KEY,
  LAST_SCREENSHOT_KEY,
  MONITOR_MODE_KEY,
  SESSION_KEY,
  API_BASE,
  type RecordingPayload,
  type RecordingSummary,
  type Session,
  type StateResponse,
} from './types';

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

// 依 background 回傳的狀態決定要顯示哪一態
function render(state: StateResponse) {
  startedAt = state.startedAt;

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
    durationVal.textContent = `${Math.round(state.summary.durationMs / 1000)} 秒`;
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

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try {
    // 語音改由 inject.ts（MAIN world）處理，麥克風授權由網頁觸發，popup 不需先搶
    const res = await send<StateResponse>('START_RECORDING');
    // PM-63：免費版用量已達上限 → 不進入錄製，顯示升級提示
    if (res.limitReached) {
      setRecordDesc('已用完（升級解鎖）');
      const span = upgradeHint.querySelector('span');
      if (span) span.textContent = res.limitReached;
      upgradeHint.classList.remove('hidden');
      return;
    }
    render(res);
  } catch (err) {
    console.error('[BugEzy popup]', err);
  } finally {
    startBtn.disabled = false;
  }
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

/** chrome.identity.getAuthToken 取 Google access token（需 manifest oauth2 + 擴充 ID 已註冊）。*/
function googleLogin(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'login failed'));
      } else {
        resolve(token);
      }
    });
  });
}

/** 把 Google token 交給 server 驗證 + 查/建 user，回 session。*/
async function authenticate(googleToken: string): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: googleToken }),
  });
  if (!res.ok) throw new Error('auth failed');
  return (await res.json()) as Session;
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
  void loadPlan(session); // PM-63：查方案 + 剩餘用量
}

interface PlanInfo {
  plan: string;
  limits: null | {
    recording: { used: number; max: number };
    rewind: { used: number; max: number };
    mcp: { used: number; max: number };
  };
}

/** 只更新錄製按鈕的 .action-desc（不覆寫整顆按鈕，保留 icon/label span）。 */
function setRecordDesc(text: string) {
  const desc = startBtn.querySelector<HTMLElement>('.action-desc');
  if (desc) desc.textContent = text;
}

// PM-63：查方案 → 免費版顯示剩餘錄製次數 + 升級提示；付費版顯示無限
async function loadPlan(session: Session) {
  try {
    const res = await fetch(`${API_BASE}/api/user/plan`, {
      headers: { Authorization: `Bearer ${session.session_token}` },
    });
    if (!res.ok) return; // 表未建/未授權等 → 不顯示用量，按鈕維持原樣（非阻擋）
    const plan = (await res.json()) as PlanInfo;
    if (plan.limits) {
      const rec = plan.limits.recording;
      const remain = rec.max - rec.used;
      if (remain > 0) {
        setRecordDesc(`剩 ${remain} 次`);
        startBtn.disabled = false;
      } else {
        setRecordDesc('已用完（升級解鎖）');
        startBtn.disabled = true;
      }
      upgradeHint.classList.remove('hidden');
    } else {
      setRecordDesc('✨ 無限次');
      upgradeHint.classList.add('hidden');
    }
  } catch {
    /* API 不通就維持預設按鈕 */
  }
}

upgradeBtn.addEventListener('click', () => {
  // 付費尚未上線：先導到首頁價目表（PM-62）
  chrome.tabs.create({ url: `${API_BASE}/#pricing` });
});

googleLoginBtn.addEventListener('click', async () => {
  googleLoginBtn.disabled = true;
  googleLoginBtn.textContent = '登入中...';
  try {
    const session = await authenticate(await googleLogin());
    await chrome.storage.local.set({ [SESSION_KEY]: session });
    showMainView(session);
  } catch (err) {
    console.error('[BugEzy popup] login', err);
    googleLoginBtn.disabled = false;
    googleLoginBtn.textContent = '登入失敗，重試';
  }
});

logoutBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove(SESSION_KEY);
  chrome.identity.clearAllCachedAuthTokens(() => {});
  showLoginView();
});

// 開啟 popup：先看是否已登入，再決定畫面
void checkAuth().then((session) => {
  if (session) showMainView(session);
  else showLoginView();
});
