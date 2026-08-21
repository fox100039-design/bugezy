// background.ts — Service Worker（Manifest V3）
// 管理錄製狀態，轉送 popup 的開始/停止指令到 active tab 的 content script。
// 狀態持久化到 chrome.storage.local，避免 service worker 被回收後遺失。

import {
  API_BASE,
  BUFFER_CONSOLE_KEY,
  BUFFER_NETWORK_KEY,
  BUFFER_RRWEB_KEY,
  BUFFER_VOICE_KEY,
  LANG_KEY,
  LAST_SCREENSHOT_KEY,
  MIC_KEY,
  MIC_MODE_KEY,
  MIC_PERMISSION_KEY,
  SESSION_KEY,
  STATE_KEY,
  STORAGE_KEY,
  USER_PLAN_KEY,
  VOICE_TRANSCRIPT_KEY,
  blog,
  type Session,
  type ConsoleLog,
  type ControlMessage,
  type NetworkError,
  type RecordingPayload,
  type RecordingSummary,
  type StateResponse,
  type TimeMarker,
  type VoiceSegment,
} from './types';
import { getAuthHeaders, getAuthHeaderOnly } from './auth';

/** PM-34：錄製中即時 flush 暫存的所有 buffer key */
const BUFFER_KEYS = [BUFFER_VOICE_KEY, BUFFER_CONSOLE_KEY, BUFFER_NETWORK_KEY, BUFFER_RRWEB_KEY];

/** 去重小工具：依 keyFn 取唯一 */
function dedupeBy<T>(arr: T[], keyFn: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/**
 * PM-34：把錄製期間即時 flush 到各 buffer 的資料，與 inject 在 STOP 時打包的
 * 單頁 payload 合併成完整 payload。因每筆資料「即時 flush 進 buffer」+「inject
 * 又在 RESULT 帶整包」兩條路徑都會帶到最終頁的資料，故四類都做去重避免重複。
 */
async function buildFullPayload(): Promise<RecordingPayload> {
  const [voiceR, consoleR, networkR, rrwebR, payloadR] = await Promise.all([
    chrome.storage.local.get(BUFFER_VOICE_KEY),
    chrome.storage.local.get(BUFFER_CONSOLE_KEY),
    chrome.storage.local.get(BUFFER_NETWORK_KEY),
    chrome.storage.local.get(BUFFER_RRWEB_KEY),
    chrome.storage.local.get(STORAGE_KEY),
  ]);

  const inj = payloadR[STORAGE_KEY] as Partial<RecordingPayload> | undefined;

  const voiceTranscript = dedupeBy<VoiceSegment>(
    [...((voiceR[BUFFER_VOICE_KEY] as VoiceSegment[]) ?? []), ...(inj?.voiceTranscript ?? [])],
    (s) => `${s.timestamp}-${s.text}`,
  );
  const consoleLogs = dedupeBy<ConsoleLog>(
    [...((consoleR[BUFFER_CONSOLE_KEY] as ConsoleLog[]) ?? []), ...(inj?.consoleLogs ?? [])],
    (l) => `${l.timestamp}-${l.level}-${l.message}`,
  );
  const networkErrors = dedupeBy<NetworkError>(
    [...((networkR[BUFFER_NETWORK_KEY] as NetworkError[]) ?? []), ...(inj?.networkErrors ?? [])],
    (e) => `${e.timestamp}-${e.method}-${e.url}-${e.status}`,
  );
  const rrwebEvents = dedupeBy<unknown>(
    [...((rrwebR[BUFFER_RRWEB_KEY] as unknown[]) ?? []), ...(inj?.rrwebEvents ?? [])],
    (ev) => JSON.stringify(ev),
  );

  return {
    rrwebEvents,
    consoleLogs,
    networkErrors,
    voiceTranscript,
    pageInfo: inj?.pageInfo ?? { url: '', title: '', browser: '', screenSize: '', timestamp: '' },
  };
}

interface PersistedState {
  recording: boolean;
  startedAt: number | null;
  tabId: number | null;
  summary: RecordingSummary | null;
}

const DEFAULT_STATE: PersistedState = {
  recording: false,
  startedAt: null,
  tabId: null,
  summary: null,
};

// ── Badge：錄製中於 icon 顯示紅色 REC ─────────────────────
function setBadgeRecording() {
  chrome.action.setBadgeText({ text: 'REC' });
  chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
}
function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
}
/** SW 重啟後依持久化狀態還原 badge */
async function syncBadge() {
  const s = await getState();
  if (s.recording) setBadgeRecording();
  else clearBadge();
}
chrome.runtime.onStartup.addListener(syncBadge);
chrome.runtime.onInstalled.addListener(syncBadge);
void syncBadge();

async function getState(): Promise<PersistedState> {
  const r = await chrome.storage.local.get(STATE_KEY);
  return { ...DEFAULT_STATE, ...(r[STATE_KEY] as Partial<PersistedState> | undefined) };
}

async function setState(patch: Partial<PersistedState>): Promise<PersistedState> {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * PM-63/170：操作前檢查免費版用量。POST /api/user/usage（type）同時遞增計數並檢查。
 * - 未登入（無 token）→ 不檢查，回 null（公測期不阻擋匿名使用）。
 * - 達上限 → 回傳升級訊息字串；否則回 null。
 * - API 不通 → 回 null（不因後端問題卡住操作）。
 */
async function checkUsage(type: 'recording' | 'rewind'): Promise<string | null> {
  const headers = await getAuthHeaders();
  if (!headers.Authorization) return null; // 未登入 → 不檢查（公測期不阻擋匿名使用）
  try {
    const res = await fetch(`${API_BASE}/api/user/usage`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type }),
    });
    if (res.status === 403) {
      const err = (await res.json()) as { error?: string; message?: string };
      if (err.error === 'limit_reached') return err.message || '免費版用量已達上限，請升級付費版';
    }
    return null;
  } catch (e) {
    blog('checkUsage failed', e);
    return null;
  }
}
const checkRecordingUsage = (): Promise<string | null> => checkUsage('recording');
// PM-170：回溯（30s）也遞增/檢查 rewind_count，達上限不進入回溯
const checkRewindUsage = (): Promise<string | null> => checkUsage('rewind');

// PM-97：本次錄製的 tab id 快取，供 MIC_VOLUME（每 200ms）轉發音量到頁面，免每次讀 storage。
let recordingTabId: number | null = null;
// PM-181：截圖時 content 帶來的當前頁 console/network 快照，供 annotate 頁上傳前取用（GET_COLLECTED_ERRORS）
let lastCollectedConsoleLogs: ConsoleLog[] = [];
let lastCollectedNetworkErrors: NetworkError[] = [];

async function startRecording(): Promise<StateResponse> {
  // PM-63：先檢查並遞增用量；達上限則不進入錄製，回傳升級提示
  const limitReached = await checkRecordingUsage();
  if (limitReached) {
    return { recording: false, startedAt: null, summary: null, limitReached };
  }
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('找不到 active tab');
  // PM-34：開錄前清空所有暫存 buffer，避免上一場殘留
  await chrome.storage.local.set({
    [BUFFER_VOICE_KEY]: [],
    [BUFFER_CONSOLE_KEY]: [],
    [BUFFER_NETWORK_KEY]: [],
    [BUFFER_RRWEB_KEY]: [],
  });
  // PM-87：付費版 + 麥克風開啟 → 用 offscreen 錄音（Groq Whisper，一次授權通用，不彈頁面授權橫幅）。
  // 免費版則由 inject.ts 的 SpeechRecognition 自行啟動（content 依 plan 決定 micEnabled）。
  // PM-91：只有付費版「精準轉錄(whisper)」模式才走 offscreen 錄音；即時字幕由 inject 處理
  // PM-193：offscreen getUserMedia 失敗（多半是使用者選「允許這次使用」→ 權限只給當前頁、offscreen 拿不到）
  //   → 自動 fallback 即時字幕（content 走頁面 SpeechRecognition，頁面有單次權限所以可用）+ 頁面橘色提示。
  let whisperMicFailed = false;
  if ((await getMicMode()) === 'whisper') {
    try {
      const ready = await ensureMicReady(); // PM-88/89：未授權 → 跳過語音（授權改由 popup toggle 觸發）
      if (ready) {
        // PM-192 修：offscreen 現在回報 getUserMedia 真實結果——失敗（如授權被撤/裝置佔用）就記錄，不再誤以為成功
        const micRes = (await chrome.runtime.sendMessage({ type: 'OFFSCREEN_START_MIC' })) as
          | { ok?: boolean; error?: string }
          | undefined;
        if (micRes?.ok) {
          blog('語音引擎：Groq Whisper（付費版精準轉錄）');
        } else {
          whisperMicFailed = true; // PM-193：fallback 即時字幕
          blog('⚠ offscreen 麥克風開啟失敗，fallback 即時字幕：', micRes?.error ?? '未知錯誤');
        }
      } else {
        blog('麥克風未授權，本次不錄語音（請在 popup 開麥克風 toggle 授權）');
      }
    } catch (err) {
      whisperMicFailed = true; // PM-193：例外也 fallback
      blog('offscreen 麥克風啟動失敗，fallback 即時字幕', err);
    }
  }
  // 截圖改為獨立功能（PM-18），不再混入錄製
  // PM-193：帶 micFallback → content 收到後改用即時字幕並在頁面顯示橘色提示
  await chrome.tabs.sendMessage(tab.id, {
    type: 'START_RECORDING',
    micFallback: whisperMicFailed,
  } satisfies ControlMessage);
  const s = await setState({
    recording: true,
    startedAt: Date.now(),
    tabId: tab.id,
    summary: null,
  });
  recordingTabId = tab.id; // PM-97：快取供 MIC_VOLUME 轉發
  setBadgeRecording();
  return toResponse(s);
}

async function stopRecording(): Promise<StateResponse> {
  const s = await getState();
  const tabId = s.tabId ?? (await getActiveTab())?.id;
  if (tabId) {
    await chrome.tabs.sendMessage(tabId, { type: 'STOP_RECORDING' } satisfies ControlMessage);
  }
  // 摘要由 content script 的 RECORDING_DONE 回填；這裡先標記停止。
  const next = await setState({ recording: false });
  recordingTabId = null; // PM-97：停止轉發音量
  clearBadge();
  return toResponse(next);
}

async function clearRecording(): Promise<StateResponse> {
  await chrome.storage.local.remove([STORAGE_KEY, STATE_KEY, ...BUFFER_KEYS]); // PM-34：一併清 buffer
  clearBadge();
  return toResponse(DEFAULT_STATE);
}

/**
 * 截圖（PM-19）：不再直接擷取，改為通知 content 在頁面注入截圖模式 overlay
 * （整頁 / 區域兩點 / 自由形狀）。實際擷取由 content 驅動 `CAPTURE_SEGMENT`。
 */
async function captureScreenshot(): Promise<{ ok: boolean; error?: string }> {
  const tab = await getActiveTab();
  if (!tab?.id) return { ok: false, error: '找不到 active tab' };
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_SCREENSHOT' } satisfies ControlMessage);
    return { ok: true };
  } catch (err) {
    // content 未注入（如 chrome:// 或商店頁）
    blog('START_SCREENSHOT 送達失敗（該頁無法截圖）', err);
    return { ok: false, error: '此頁面無法截圖' };
  }
}

/** content 區域/整頁/自由模式請求擷取目前可見分頁 */
async function captureSegment(): Promise<{ dataUrl: string } | { error: string }> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
    return { dataUrl };
  } catch (err) {
    blog('captureSegment 失敗', err);
    return { error: String(err) };
  }
}

/** content 截圖完成 → 暫存 + 開標注分頁 */
async function openAnnotate(dataUrl: string, pageUrl: string, pageTitle: string): Promise<void> {
  const ts = Date.now();
  const tempKey = `bugezy:ss-temp-${ts}`;
  await chrome.storage.local.set({ [tempKey]: dataUrl });
  const q = new URLSearchParams({ key: tempKey, timestamp: String(ts), pageUrl, pageTitle });
  await chrome.tabs.create({ url: `annotate.html?${q.toString()}` });
  blog('截圖完成，開標注頁', tempKey);
}

function toResponse(s: PersistedState): StateResponse {
  return { recording: s.recording, startedAt: s.startedAt, summary: s.summary };
}

/** PM-24：停止錄製後開「報告編輯頁」（不直接上傳） */
async function openEditReport(): Promise<void> {
  await chrome.tabs.create({ url: 'edit-report.html' });
  blog('開啟報告編輯頁');
}

/**
 * PM-24：edit-report 確認上傳時呼叫。讀 STORAGE_KEY payload + 合併 description → POST API。
 */
async function uploadReport(
  description: string,
  markers?: TimeMarker[],
): Promise<{ ok: boolean; shareUrl?: string; reportId?: string; error?: string }> {
  const r = await chrome.storage.local.get([STORAGE_KEY, SESSION_KEY]);
  const payload = r[STORAGE_KEY];
  if (!payload) return { ok: false, error: '沒有報告資料' };
  payload.description = description ?? '';
  payload.markers = markers ?? []; // PM-28：時間軸標記
  // PM-61：已登入則把報告綁到 user
  const userId = (r[SESSION_KEY] as Session | undefined)?.user_id;
  if (userId) payload.user_id = userId;
  try {
    const res = await fetch(`${API_BASE}/api/reports`, {
      method: 'POST',
      headers: await getAuthHeaders(), // PM-129：帶 session token（server 可從 header 補回 user_id）
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { report_id: string; share_url: string };
    blog('uploadReport: 上傳成功', data.share_url);
    await chrome.storage.local.remove(BUFFER_KEYS); // PM-34：上傳成功清空暫存 buffer
    return { ok: true, shareUrl: data.share_url, reportId: data.report_id };
  } catch (err) {
    blog('uploadReport: 上傳失敗', err);
    return { ok: false, error: String(err) };
  }
}

// ── PM-51：即時監控 — 每 10 秒把 active tab 的 live errors 推送到 API 暫存 ──
let monitorInterval: ReturnType<typeof setInterval> | null = null;

function startMonitoring() {
  if (monitorInterval) return;
  monitorInterval = setInterval(async () => {
    try {
      const tab = await getActiveTab();
      if (!tab?.id) return;
      const result = (await chrome.tabs.sendMessage(tab.id, {
        type: 'GET_LIVE_ERRORS',
      } satisfies ControlMessage)) as { consoleLogs?: unknown[]; networkErrors?: unknown[] } | undefined;
      if (!result) return;
      // PM-143：帶 session token（live-errors 端點已加認證 + per-user key）。
      // 未登入 → 無 Authorization → server 回 401（fetch 失敗靜默略過，不影響頁面）。
      const leHeaders = await getAuthHeaders();
      if (leHeaders.Authorization) {
        await fetch(`${API_BASE}/api/live-errors`, {
          method: 'POST',
          headers: leHeaders,
          body: JSON.stringify({
            url: tab.url,
            title: tab.title,
            consoleLogs: result.consoleLogs ?? [],
            networkErrors: result.networkErrors ?? [],
            timestamp: Date.now(),
          }),
        });
      }
      // PM-52：擴充圖示 badge 顯示 error 數（錄製中讓 REC badge 優先，不覆蓋）
      const total = (result.consoleLogs?.length ?? 0) + (result.networkErrors?.length ?? 0);
      if (!(await getState()).recording) {
        if (total > 0) {
          chrome.action.setBadgeText({ text: String(total) });
          chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
        } else {
          chrome.action.setBadgeText({ text: '' });
        }
      }
    } catch (err) {
      blog('即時監控推送失敗（已忽略）', err);
    }
  }, 10000);
  blog('即時監控已啟動');
}

function stopMonitoring() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  void syncBadge(); // PM-52：還原 badge（錄製中回 REC、否則清空），不誤清 REC
  blog('即時監控已停止');
}

// ── PM-86：offscreen 麥克風錄音（一次授權，所有網站通用）──────
const OFFSCREEN_URL = 'offscreen.html';

/** 確保 offscreen document 存在（沒有就建立，USER_MEDIA 用途）。 */
async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'BugEzy 麥克風錄音（語音 Bug 描述）',
  });
}

/** PM-88/89：確保麥克風可用。未授權 → 跳過語音（**不開授權頁、不打斷錄製**；授權改由 popup toggle 觸發）；
 *  已授權 → 確保 offscreen 存在，回 true。 */
async function ensureMicReady(): Promise<boolean> {
  const store = await chrome.storage.local.get(MIC_PERMISSION_KEY);
  if (!store[MIC_PERMISSION_KEY]) {
    blog('麥克風未授權，跳過語音（請在 popup 開啟麥克風 toggle 授權）');
    return false;
  }
  await ensureOffscreen();
  return true;
}

/** PM-91：本次錄製的語音模式。'off'（mic 關）/'realtime'（即時字幕 Web Speech）/'whisper'（offscreen+Groq）。 */
async function getMicMode(): Promise<'off' | 'realtime' | 'whisper'> {
  const r = await chrome.storage.local.get([MIC_KEY, USER_PLAN_KEY, MIC_MODE_KEY]);
  if (r[MIC_KEY] !== true) return 'off'; // PM-90：預設關閉
  const plan = (r[USER_PLAN_KEY] as string) || 'free';
  if (plan === 'free') return 'realtime'; // 免費版只有即時字幕
  return (r[MIC_MODE_KEY] as string) === 'realtime' ? 'realtime' : 'whisper'; // 付費版預設精準轉錄
}

/** PM-86/87：停 offscreen 錄音 → 送 /api/transcribe（Groq Whisper）→ 存 VOICE_TRANSCRIPT_KEY，回轉錄結果。 */
async function stopMicAndTranscribe(): Promise<{ ok?: boolean; text?: string; error?: string }> {
  const res = (await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_MIC' })) as {
    audioBlob?: string;
    error?: string;
  };
  // PM-198：確認 offscreen 有把音訊（base64 dataURL）傳回來
  if (!res?.audioBlob) {
    console.warn('[BugEzy background] offscreen 未回傳音訊 →', res?.error ?? '未取得音訊');
    return res ?? { error: '未取得音訊' };
  }
  try {
    const blob = await (await fetch(res.audioBlob)).blob();
    // PM-198：診斷 log——送轉錄前確認 blob 有效
    console.log(`[BugEzy background] transcribe request sent, size=${blob.size}, type=${blob.type}`);
    if (blob.size < 100) {
      console.warn(`[BugEzy background] blob 太小（size=${blob.size}）→ 放棄轉錄`);
      return { error: '音訊太短' };
    }
    const form = new FormData();
    form.append('audio', blob, 'recording.webm');
    // PM-137：帶使用者選的 Whisper 語言（server 端有白名單驗證，非白名單 fallback zh）
    const langStore = await chrome.storage.local.get(LANG_KEY);
    form.append('language', (langStore[LANG_KEY] as string) || 'zh');
    // PM-135：帶 session token（transcribe 需登入 + 付費驗證）。multipart 不可手動設 Content-Type。
    const authHeader = await getAuthHeaderOnly();
    // PM-198：確認有帶 Authorization（無 token → server 回 401「請先登入」，語音會靜默消失）
    console.log(
      `[BugEzy background] POST ${API_BASE}/api/transcribe, hasAuth=${!!authHeader.Authorization}, lang=${(langStore[LANG_KEY] as string) || 'zh'}`,
    );
    const transcribeRes = await fetch(`${API_BASE}/api/transcribe`, {
      method: 'POST',
      headers: authHeader,
      body: form,
    });
    // PM-198：先讀 raw text，再嘗試 parse（非 JSON 回應如 401/502 HTML 才不會 throw 進 catch 被吞）
    const raw = await transcribeRes.text();
    let result: { ok?: boolean; text?: string; segments?: unknown[]; duration?: number; error?: string };
    try {
      result = JSON.parse(raw);
    } catch {
      console.error(
        `[BugEzy background] transcribe 回應非 JSON, status=${transcribeRes.status}, body=${raw.slice(0, 200)}`,
      );
      return { error: `轉錄失敗（HTTP ${transcribeRes.status}）` };
    }
    // PM-198：無條件印出 status + 轉錄文字（成功/失敗都看得到）
    console.log(
      `[BugEzy background] transcribe response status=${transcribeRes.status}, ok=${result.ok}, text=${(result.text ?? result.error ?? '').slice(0, 80)}`,
    );
    if (result.ok && (result.text ?? '').trim()) {
      await chrome.storage.local.set({
        [VOICE_TRANSCRIPT_KEY]: {
          text: result.text,
          segments: result.segments,
          duration: result.duration,
          timestamp: Date.now(),
        },
      });
      console.log('[BugEzy background] 語音轉錄完成，已存 VOICE_TRANSCRIPT_KEY:', (result.text ?? '').substring(0, 50));
    } else {
      // PM-198：ok=false（401/403 付費/未登入）或 text 空 → 明確 log，避免「靜默無文字」
      console.warn(
        `[BugEzy background] 轉錄無有效文字（status=${transcribeRes.status}, ok=${result.ok}, error=${result.error ?? '無'}）→ voice_count 將為 0`,
      );
    }
    return result;
  } catch (err) {
    console.error('[BugEzy background] 轉錄失敗（例外）:', err);
    return { error: '轉錄失敗' };
  }
}

chrome.runtime.onMessage.addListener((msg: ControlMessage | { type: string; summary?: RecordingSummary }, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'START_RECORDING':
          sendResponse(await startRecording());
          break;
        case 'STOP_RECORDING': {
          // PM-87/91：Whisper 模式 → 先通知頁面顯示「轉錄中」，停 offscreen 並轉錄（存 VOICE_TRANSCRIPT_KEY）
          // → 再停錄製打包，讓隨後的 RECORDING_DONE 合併時能讀到 Whisper 結果。
          const micMode = await getMicMode();
          // PM-198：印出本次語音模式（若非 whisper 就不會跑 Groq 轉錄，voice_count 會是 0）
          console.log(`[BugEzy background] STOP_RECORDING, micMode=${micMode}`);
          if (micMode === 'whisper') {
            const st = await getState();
            const tid = st.tabId ?? (await getActiveTab())?.id;
            if (tid) {
              try {
                await chrome.tabs.sendMessage(tid, {
                  type: 'WHISPER_TRANSCRIBING',
                } satisfies ControlMessage);
              } catch {
                /* 頁面可能已關，忽略 */
              }
            }
            // PM-198：不再吞掉結果——記下轉錄成敗，方便 DevTools 追蹤
            const tr = await stopMicAndTranscribe();
            console.log(
              `[BugEzy background] 轉錄結果 ok=${tr.ok}, textLen=${(tr.text ?? '').length}, error=${tr.error ?? '無'}`,
            );
          }
          sendResponse(await stopRecording());
          break;
        }
        case 'MIC_VOLUME': {
          // PM-97：offscreen 每 200ms 送即時音量 → 轉發給錄製中的 tab（inject 更新音量條）
          if (recordingTabId !== null) {
            const level = (msg as { level?: number }).level ?? 0;
            chrome.tabs
              .sendMessage(recordingTabId, { type: 'MIC_VOLUME', level } satisfies ControlMessage)
              .catch(() => {});
          }
          sendResponse({ ok: true }); // 立即回應關閉通道，避免 200ms 一次的 port 未回覆警告
          break;
        }
        case 'GET_RECORDING_STATE':
          // PM-105：popup 在開麥克風前先問是否錄製中（錄製中不開授權頁，避免搶焦點卡死）
          sendResponse({ recording: recordingTabId !== null });
          break;
        case 'UPLOAD_MONITOR_REPORT': {
          // PM-124：即時監控 error panel 打包上傳 → 複用 /api/reports；綁 user_id（PM-98：list_reports 靠 user_id 過濾）
          const m = msg as { payload: RecordingPayload };
          const store = await chrome.storage.local.get(SESSION_KEY);
          const uid = (store[SESSION_KEY] as Session | undefined)?.user_id;
          const payload = uid ? { ...m.payload, user_id: uid } : m.payload;
          try {
            const res = await fetch(`${API_BASE}/api/reports`, {
              method: 'POST',
              headers: await getAuthHeaders(), // PM-129：帶 session token
              body: JSON.stringify(payload),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = (await res.json()) as { report_id?: string; share_url?: string };
            if (data.share_url) {
              await chrome.storage.local.set({ 'bugezy:latest-report-url': data.share_url });
              blog('即時監控報告上傳成功:', data.share_url);
              sendResponse({ ok: true, shareUrl: data.share_url, reportId: data.report_id });
            } else {
              sendResponse({ ok: false, error: '未取得報告連結' });
            }
          } catch (err) {
            blog('即時監控上傳失敗:', err);
            sendResponse({ ok: false, error: '上傳失敗' });
          }
          break;
        }
        case 'CLEAR_RECORDING':
          sendResponse(await clearRecording());
          break;
        case 'GET_STATE':
          sendResponse(toResponse(await getState()));
          break;
        case 'GET_LAST_PAYLOAD': {
          const r = await chrome.storage.local.get(STORAGE_KEY);
          sendResponse({ payload: r[STORAGE_KEY] ?? null });
          break;
        }
        case 'CAPTURE_SCREENSHOT':
          sendResponse(await captureScreenshot());
          break;
        case 'CAPTURE_SEGMENT':
          sendResponse(await captureSegment());
          break;
        case 'SCREENSHOT_READY': {
          const m = msg as {
            dataUrl: string;
            pageUrl: string;
            pageTitle: string;
            consoleLogs?: ConsoleLog[];
            networkErrors?: NetworkError[];
          };
          // PM-181：快取截圖當下的 console/network，annotate 頁上傳前經 GET_COLLECTED_ERRORS 取回
          lastCollectedConsoleLogs = m.consoleLogs ?? [];
          lastCollectedNetworkErrors = m.networkErrors ?? [];
          await openAnnotate(m.dataUrl, m.pageUrl, m.pageTitle);
          sendResponse({ ok: true });
          break;
        }
        case 'GET_COLLECTED_ERRORS': {
          // PM-181：annotate 頁上傳前取當前頁面收集的 console/network（截圖流程快取）
          sendResponse({
            consoleLogs: lastCollectedConsoleLogs,
            networkErrors: lastCollectedNetworkErrors,
          });
          break;
        }
        case 'SCREENSHOT_UPLOADED': {
          // 標注頁獨立上傳完成 → 記下最近一筆，供 popup 閒置畫面顯示連結
          const m = msg as { shareUrl: string; reportId: string };
          await chrome.storage.local.set({
            [LAST_SCREENSHOT_KEY]: { shareUrl: m.shareUrl, reportId: m.reportId, timestamp: Date.now() },
          });
          blog('截圖上傳完成:', m.shareUrl);
          sendResponse({ ok: true });
          break;
        }
        case 'RECORDING_DONE': {
          // content script 打包完成 → PM-34：合併 buffer + inject 單頁打包成完整 payload，
          // 覆寫 STORAGE_KEY（供 edit-report 上傳），摘要計數也以合併後為準。
          const prev = await getState();
          const incoming = (msg as { summary: RecordingSummary }).summary;
          const merged = await buildFullPayload();
          // PM-87：合併語音來源——付費版用 Groq Whisper 結果覆蓋；免費版維持 inject 的 Web Speech 並標記來源
          const wStore = await chrome.storage.local.get(VOICE_TRANSCRIPT_KEY);
          const whisper = wStore[VOICE_TRANSCRIPT_KEY] as
            | { text?: string; timestamp?: number }
            | undefined;
          if (whisper?.text?.trim()) {
            merged.voiceTranscript = [
              {
                text: whisper.text,
                timestamp: whisper.timestamp ?? Date.now(),
                isFinal: true,
                source: 'whisper',
              },
            ];
            await chrome.storage.local.remove(VOICE_TRANSCRIPT_KEY);
            // PM-198：確認 Whisper 文字有寫進報告 payload 的 voiceTranscript
            console.log('[BugEzy background] RECORDING_DONE 已併入 Whisper 語音:', whisper.text.substring(0, 50));
          } else {
            // PM-198：沒有 Whisper 文字 → 保留即時字幕（免費版）；付費版精準轉錄失敗時這裡會是空的
            console.log(
              `[BugEzy background] RECORDING_DONE 無 Whisper 文字（VOICE_TRANSCRIPT_KEY=${whisper ? '存在但空' : '不存在'}）→ 用 web-speech 段落 ${merged.voiceTranscript.length} 筆`,
            );
            merged.voiceTranscript.forEach((s) => {
              if (!s.source) s.source = 'web-speech';
            });
          }
          await chrome.storage.local.set({ [STORAGE_KEY]: merged });
          const summary: RecordingSummary = {
            ...incoming,
            domEvents: merged.rrwebEvents.length,
            consoleLogs: merged.consoleLogs.length,
            networkErrors: merged.networkErrors.length,
            voiceSegments: merged.voiceTranscript.length,
            pageInfo: merged.pageInfo,
            durationMs: prev.startedAt ? Date.now() - prev.startedAt : 0,
            uploadStatus: 'idle',
            shareUrl: null,
            uploadError: null,
          };
          blog('RECORDING_DONE 合併完成', {
            dom: merged.rrwebEvents.length,
            console: merged.consoleLogs.length,
            network: merged.networkErrors.length,
            voice: merged.voiceTranscript.length,
          });
          const s = await setState({ recording: false, startedAt: null, tabId: null, summary });
          clearBadge();
          await openEditReport(); // 開報告編輯頁，由使用者補描述後再上傳
          sendResponse(toResponse(s));
          break;
        }
        case 'UPLOAD_REPORT': {
          const m = msg as { description: string; markers?: TimeMarker[] };
          sendResponse(await uploadReport(m.description, m.markers));
          break;
        }
        // PM-50：⏪ 回溯——通知 active tab 的 content 打包背景緩存
        case 'REWIND_30S': {
          // PM-170：回溯前檢查並遞增 rewind 用量；達上限不進入回溯，回傳升級提示供 popup 彈引導
          const limitReached = await checkRewindUsage();
          if (limitReached) {
            sendResponse({ ok: false, limitReached });
            break;
          }
          const tab = await getActiveTab();
          if (tab?.id) {
            await chrome.tabs.sendMessage(tab.id, { type: 'REWIND_30S' } satisfies ControlMessage);
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: '找不到 active tab' });
          }
          break;
        }
        case 'REWIND_DONE': {
          // 回溯 payload 已由 content 寫進 STORAGE_KEY；回填摘要後開編輯頁（同 RECORDING_DONE）
          const incoming = (msg as { summary: RecordingSummary }).summary;
          const summary: RecordingSummary = {
            ...incoming,
            durationMs: 30000, // 回溯視窗約 30 秒
            uploadStatus: 'idle',
            shareUrl: null,
            uploadError: null,
          };
          const s = await setState({ recording: false, startedAt: null, tabId: null, summary });
          clearBadge();
          await openEditReport();
          sendResponse(toResponse(s));
          break;
        }
        // PM-51/52：即時監控開關 + 通知頁面顯示/隱藏浮動 badge
        case 'START_MONITORING': {
          startMonitoring();
          const tab = await getActiveTab();
          if (tab?.id) {
            await chrome.tabs
              .sendMessage(tab.id, { type: 'SET_MONITOR_BADGE', show: true } satisfies ControlMessage)
              .catch(() => {}); // 該頁無 content（如 chrome://）忽略
          }
          sendResponse({ ok: true });
          break;
        }
        case 'STOP_MONITORING': {
          stopMonitoring();
          const tab = await getActiveTab();
          if (tab?.id) {
            await chrome.tabs
              .sendMessage(tab.id, { type: 'SET_MONITOR_BADGE', show: false } satisfies ControlMessage)
              .catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        }
        // PM-34：即時 flush → 追加到對應 buffer（頁面跳轉時資料已落地）
        case 'FLUSH_VOICE': {
          const seg = (msg as { segment: VoiceSegment }).segment;
          const r = await chrome.storage.local.get(BUFFER_VOICE_KEY);
          const arr = (r[BUFFER_VOICE_KEY] as VoiceSegment[]) ?? [];
          arr.push(seg);
          await chrome.storage.local.set({ [BUFFER_VOICE_KEY]: arr });
          sendResponse({ ok: true });
          break;
        }
        case 'FLUSH_CONSOLE': {
          const log = (msg as { log: ConsoleLog }).log;
          const r = await chrome.storage.local.get(BUFFER_CONSOLE_KEY);
          const arr = (r[BUFFER_CONSOLE_KEY] as ConsoleLog[]) ?? [];
          arr.push(log);
          await chrome.storage.local.set({ [BUFFER_CONSOLE_KEY]: arr });
          sendResponse({ ok: true });
          break;
        }
        case 'FLUSH_NETWORK': {
          const error = (msg as { error: NetworkError }).error;
          const r = await chrome.storage.local.get(BUFFER_NETWORK_KEY);
          const arr = (r[BUFFER_NETWORK_KEY] as NetworkError[]) ?? [];
          arr.push(error);
          await chrome.storage.local.set({ [BUFFER_NETWORK_KEY]: arr });
          sendResponse({ ok: true });
          break;
        }
        case 'FLUSH_RRWEB': {
          const evs = (msg as { events: unknown[] }).events;
          const r = await chrome.storage.local.get(BUFFER_RRWEB_KEY);
          const arr = (r[BUFFER_RRWEB_KEY] as unknown[]) ?? [];
          arr.push(...evs);
          await chrome.storage.local.set({ [BUFFER_RRWEB_KEY]: arr });
          sendResponse({ ok: true });
          break;
        }
        // PM-36：回傳已累積的語音 buffer，供跳頁恢復時回填右上面板
        case 'GET_VOICE_BUFFER': {
          const r = await chrome.storage.local.get(BUFFER_VOICE_KEY);
          sendResponse({ segments: (r[BUFFER_VOICE_KEY] as VoiceSegment[]) ?? [] });
          break;
        }
        // PM-404：popup 的記憶矩陣區塊 —— 向 bridge 發唯讀查詢
        case 'BRIDGE_QUERY_MEMORY_STATS': {
          sendResponse(await queryBridge('memory_stats'));
          break;
        }
        // PM-86：麥克風錄音 — 建 offscreen + 開始錄音
        case 'MIC_START': {
          await ensureOffscreen();
          const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_START_MIC' });
          sendResponse(res);
          break;
        }
        // PM-86：停止錄音 → 取音訊 → 送 /api/transcribe 轉錄 → 存 storage
        case 'MIC_STOP': {
          sendResponse(await stopMicAndTranscribe());
          break;
        }
        // PM-88：麥克風授權頁回報授權完成 → 記錄，之後直接走 offscreen 不再開授權頁
        case 'MIC_PERMISSION_GRANTED': {
          await chrome.storage.local.set({ [MIC_PERMISSION_KEY]: true });
          blog('麥克風授權完成');
          sendResponse({ ok: true });
          break;
        }
        // PM-89：popup 開麥克風 toggle 時請求授權（未授權才開授權頁；授權時機在此，不在錄製時）
        case 'REQUEST_MIC_PERMISSION': {
          const store = await chrome.storage.local.get(MIC_PERMISSION_KEY);
          if (!store[MIC_PERMISSION_KEY]) {
            await chrome.tabs.create({ url: 'mic-permission.html' });
          }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // 非同步回應
});

// ── PM-297：bugezy-bridge 連線（localhost WebSocket，選用功能）─────────────
//
// 為什麼是 WebSocket 而不是 Native Messaging 或 HTTP 輪詢：
//   · Native Messaging 需要 `nativeMessaging` 權限 → 會觸發 Chrome Web Store 重新審核。
//   · HTTP 輪詢（每 500ms）撐不過 MV3：service worker 閒置 30 秒就被回收，
//     `setInterval` 隨之消失且沒有事件能喚醒它 → 半分鐘後就靜默失效。
//   · WebSocket 不受 CORS 限制、連 localhost 不需要任何 host 權限；
//     且 **Chrome 116 起 WebSocket 活動會重置 service worker 的閒置計時器**，
//     所以固定心跳＝官方認可的保活方式。
//
// 這是**選用**功能：bridge 沒開就靜默重試，完全不影響既有流程。
const BRIDGE_URL = 'ws://127.0.0.1:19850';
const BRIDGE_RETRY_MIN_MS = 5_000;
const BRIDGE_RETRY_MAX_MS = 60_000;
let bridgeSocket: WebSocket | null = null;
let bridgeRetryMs = BRIDGE_RETRY_MIN_MS;
let bridgeRetryTimer: number | undefined;

interface BridgeCommandMsg {
  id: string;
  command: string;
  params?: Record<string, unknown>;
}

/** 對「當前作用中分頁」發訊息；沒有可用分頁時回 null（不拋錯）。 */
async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

// ── PM-307：navigate_to ────────────────────────────────────────────────────
/** 頁面載入上限。bridge 端的 NAVIGATE_TIMEOUT_MS 必須比這個**更長**，兩邊要一起改。 */
const NAVIGATE_TIMEOUT_MS = 30_000;

/**
 * 只放行 http/https。擋掉 `chrome://`、`file://`、`javascript:`、`data:` 等——
 * 前兩者 Chrome 本來就會拒絕（但錯誤訊息很難懂），後兩者則是**讓 AI 能在使用者
 * 瀏覽器裡執行任意腳本或塞入任意內容**，不該由一支「開網頁」的工具提供。
 */
function parseNavigableUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('缺少 url 參數');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`不是合法的網址：${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`只接受 http:// 或 https:// 的網址，收到的是 ${u.protocol}//（${raw}）`);
  }
  return u.href;
}

/** 等某個分頁載入完成。逾時、分頁被關閉都會 reject，不會 hang 住。 */
function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      // 注意：沒有 `tabs` 權限時 changeInfo 不含 url/title，但 **status 仍然有**。
      if (id === tabId && info.status === 'complete') finish();
    };
    const onRemoved = (id: number) => {
      if (id === tabId) finish(new Error(`分頁 ${tabId} 在載入完成前被關閉`));
    };
    const timer = setTimeout(
      () => finish(new Error(`頁面載入逾時（${Math.round(timeoutMs / 1000)} 秒）`)),
      timeoutMs,
    ) as unknown as number;

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    // 補漏：`tabs.create` 要等它回傳才拿得到 id，這中間若頁面已經載完（快取／極小頁面），
    //   'complete' 事件就已經過去了，光靠監聽會一路等到逾時。這裡補查一次當下狀態。
    void chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') finish();
      })
      .catch(() => finish(new Error(`找不到分頁 ${tabId}（可能已被關閉）`)));
  });
}

/**
 * 讀分頁的 url/title。
 * PM-298 的教訓：`tab.url` / `tab.title` 需要 `tabs` 權限，只有 `activeTab` 時
 * Chrome 會**靜默回空字串**而不是報錯，所以一律問 content script。
 */
async function readTabInfo(tabId: number): Promise<{ url: string; title: string } | null> {
  const info = (await chrome.tabs
    .sendMessage(tabId, { type: 'GET_PAGE_INFO' })
    .catch(() => null)) as { url?: string; title?: string } | null;
  if (!info) return null;
  return { url: info.url ?? '', title: info.title ?? '' };
}

/**
 * PM-308：把指令的 `tab_id` 參數解析成實際的分頁 id。
 *
 * 規格書 §13.3：**省略 → 當前分頁（偵察模式）；指定 → 只作用於該分頁（出任務模式）**，
 * 而且指到不存在的分頁必須**明確報錯，絕不默默退回當前分頁**——
 * 否則 AI 會在使用者正在用的分頁上，執行原本要在自己分頁跑的操作。
 */
async function resolveTargetTab(params: Record<string, unknown> | undefined): Promise<number> {
  const raw = params?.tab_id;
  if (raw === undefined || raw === null) {
    const tab = await activeTab();
    if (!tab?.id) throw new Error('找不到作用中的分頁');
    return tab.id;
  }
  if (typeof raw !== 'number') throw new Error(`tab_id 必須是數字，收到 ${typeof raw}`);
  try {
    await chrome.tabs.get(raw);
  } catch {
    throw new Error(`找不到分頁 ${raw}（可能已被關閉）`);
  }
  return raw;
}

/** 送訊息給某分頁的 content script；沒有 content script 時給一句能照著排查的錯誤。 */
async function sendToContent<T>(tabId: number, msg: unknown): Promise<T> {
  const res = (await chrome.tabs.sendMessage(tabId, msg).catch(() => null)) as T | null;
  if (res === null || res === undefined) {
    throw new Error(
      `分頁 ${tabId} 沒有 BugEzy content script（可能是 chrome://、Chrome 線上應用程式商店、PDF 檢視器，或該分頁需要重新整理）`,
    );
  }
  return res;
}

// ── PM-312：take_screenshot ────────────────────────────────────────────────
/** 切分頁之後給頁面 render 的時間。太短會截到白畫面或舊內容。 */
const SCREENSHOT_RENDER_WAIT_MS = 400;

/**
 * 從 PNG 的 IHDR 直接讀寬高。
 * service worker 裡沒有 `Image`，用 `createImageBitmap` 得多解一次整張圖；
 * PNG 的前 24 bytes 就有尺寸（8 bytes 簽章 + 4 長度 + 4 'IHDR' + 4 寬 + 4 高），直接讀最省。
 */
function pngSize(base64: string): { width: number; height: number } {
  try {
    const head = atob(base64.slice(0, 64)); // 24 bytes 只需要前 32 個 base64 字元，多取一些保險
    const b = (i: number) => head.charCodeAt(i) & 0xff;
    const be32 = (o: number) => (b(o) << 24) | (b(o + 1) << 16) | (b(o + 2) << 8) | b(o + 3);
    if (b(0) !== 0x89 || b(1) !== 0x50) return { width: 0, height: 0 }; // 不是 PNG
    return { width: be32(16) >>> 0, height: be32(20) >>> 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** 執行一則 bridge 指令，回傳要送回去的 data；失敗請 throw，由呼叫端包成 error。 */
async function runBridgeCommand(cmd: BridgeCommandMsg): Promise<unknown> {
  switch (cmd.command) {
    case 'ping':
      return { pong: true, version: chrome.runtime.getManifest().version, t: Date.now() };

    case 'get_page_url': {
      const tab = await activeTab();
      if (!tab?.id) throw new Error('找不到作用中的分頁');
      // PM-298（實機驗收抓到）：`tab.url` / `tab.title` 需要 `tabs` 權限才會有值，
      //   只有 activeTab 的話 Chrome 會**靜默回空字串**（不是報錯，所以很容易誤以為正常）。
      //   改問 content script——它本來就宣告式注入在每個頁面，讀 location.href 不需要任何權限。
      const info = (await chrome.tabs
        .sendMessage(tab.id, { type: 'GET_PAGE_INFO' })
        .catch(() => null)) as { url?: string; title?: string } | null;
      if (!info) {
        throw new Error(
          '當前分頁沒有 BugEzy content script（可能是 chrome://、Chrome 線上應用程式商店或 PDF 頁面，或該分頁需要重新整理）',
        );
      }
      return { url: info.url ?? '', title: info.title ?? '', tab_id: tab.id };
    }

    // PM-314：舊的 `get_live_errors` 指令已移除，改由 PM-313 的 `get_browser_errors` 提供
    //   （同樣讀 inject 的背景緩存，但欄位更完整、支援 tab_id、且會標明 30 秒視窗）。
    //   content script 的 `GET_LIVE_ERRORS` 訊息**保留不動**——即時監控（PM-51/52）仍在用。

    // PM-307：規格書 §13.2「出任務模式」的入口。
    case 'navigate_to': {
      const url = parseNavigableUrl(cmd.params?.url);
      const rawTabId = cmd.params?.tab_id;
      const hasTabId = rawTabId !== undefined && rawTabId !== null;
      if (hasTabId && typeof rawTabId !== 'number') {
        throw new Error(`tab_id 必須是數字，收到 ${typeof rawTabId}`);
      }

      let tabId: number;
      if (hasTabId) {
        // §13.3 邊界：分頁不存在要**明確報錯**，絕不可默默退回當前分頁——
        //   那會讓 AI 在使用者正在用的分頁上執行原本要在自己分頁跑的操作。
        tabId = rawTabId as number;
        try {
          await chrome.tabs.update(tabId, { url });
        } catch (e) {
          throw new Error(
            `無法在分頁 ${tabId} 導航（該分頁可能已關閉）：${e instanceof Error ? e.message : String(e)}`,
          );
        }
      } else {
        // active:false = 不搶焦點，使用者可以繼續做自己的事（§13.2）
        const tab = await chrome.tabs.create({ url, active: false });
        if (typeof tab.id !== 'number') throw new Error('開啟新分頁失敗：Chrome 沒有回傳 tab id');
        tabId = tab.id;
      }

      await waitForTabComplete(tabId, NAVIGATE_TIMEOUT_MS);

      const info = await readTabInfo(tabId);
      if (!info) {
        // 導航本身成功了，只是讀不到標題（PDF 檢視器、下載頁、被政策擋住注入的頁面…）。
        // 這種情況回錯誤會誤導 AI 以為沒開成，所以照實回報並附註原因。
        return {
          tab_id: tabId,
          url,
          title: '',
          note: '導航已完成，但該分頁沒有 BugEzy content script（可能是 PDF、下載頁或 Chrome 政策不允許注入的頁面），因此無法讀取實際標題。',
        };
      }
      return { tab_id: tabId, url: info.url || url, title: info.title };
    }

    // PM-308
    case 'click_element': {
      const selector = cmd.params?.selector;
      if (typeof selector !== 'string' || !selector.trim()) throw new Error('缺少 selector 參數');
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, {
        type: 'BRIDGE_CLICK',
        selector,
      });
      // content script 判定不可點時會回 { error }，照實往上拋（含它給的 tag/text 線索）
      if (typeof res.error === 'string') {
        const extra = res.tag ? `（找到的是 <${String(res.tag)}>，文字「${String(res.text ?? '')}」）` : '';
        throw new Error(`${res.error}${extra}${res.hint ? `\n${String(res.hint)}` : ''}`);
      }
      return {
        clicked: true,
        selector,
        element_text: res.text ?? '',
        element_tag: res.tag ?? '',
        tab_id: tabId,
      };
    }

    // PM-330／331：圖釘系統
    case 'pin_element': {
      const selector = cmd.params?.selector;
      const description = cmd.params?.description;
      if (typeof selector !== 'string' || !selector.trim()) throw new Error('缺少 selector 參數');
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, {
        type: 'BRIDGE_PIN_ELEMENT',
        selector,
        description: typeof description === 'string' ? description : '',
      });
      if (typeof res.error === 'string') {
        throw new Error(`${res.error}${res.hint ? `
${String(res.hint)}` : ''}`);
      }
      return { ...res, tab_id: tabId };
    }

    case 'pin_analyze': {
      const selector = cmd.params?.selector;
      if (typeof selector !== 'string' || !selector.trim()) throw new Error('缺少 selector 參數');
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, {
        type: 'BRIDGE_PIN_ANALYZE',
        selector,
      });
      if (typeof res.error === 'string' && !res.pin_id) {
        throw new Error(`${res.error}${res.hint ? `
${String(res.hint)}` : ''}`);
      }
      return { ...res, tab_id: tabId };
    }

    // PM-341~345：Zone Grid
    case 'map_page_zones':
    case 'get_zone_health':
    case 'show_zone_overlay':
    case 'hide_zone_overlay':
    case 'get_zone_changes':
    case 'stop_watching_zones': {
      const MAP: Record<string, string> = {
        map_page_zones: 'BRIDGE_MAP_ZONES',
        get_zone_health: 'BRIDGE_ZONE_HEALTH',
        show_zone_overlay: 'BRIDGE_SHOW_ZONE_OVERLAY',
        hide_zone_overlay: 'BRIDGE_HIDE_ZONE_OVERLAY',
        get_zone_changes: 'BRIDGE_ZONE_CHANGES',
        stop_watching_zones: 'BRIDGE_STOP_WATCH_ZONES',
      };
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, { type: MAP[cmd.command] });
      return { ...res, tab_id: tabId };
    }

    case 'get_zone_errors': {
      const zoneId = cmd.params?.zone_id;
      if (typeof zoneId !== 'string' || !zoneId.trim()) throw new Error('缺少 zone_id 參數');
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, {
        type: 'BRIDGE_ZONE_ERRORS',
        zone_id: zoneId,
      });
      return { ...res, tab_id: tabId };
    }

    case 'watch_zones': {
      const iv = cmd.params?.interval_seconds;
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, {
        type: 'BRIDGE_WATCH_ZONES',
        interval_seconds: typeof iv === 'number' ? iv : undefined,
      });
      return { ...res, tab_id: tabId };
    }

    // PM-339：面板顯示／隱藏（AI 可控制）
    case 'show_debug_panel':
    case 'hide_debug_panel': {
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, {
        type: cmd.command === 'show_debug_panel' ? 'BRIDGE_SHOW_PANEL' : 'BRIDGE_HIDE_PANEL',
      });
      return { ...res, tab_id: tabId };
    }

    case 'patrol_pins': {
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, { type: 'BRIDGE_PATROL_PINS' });
      return { ...res, tab_id: tabId };
    }

    case 'remove_pin': {
      const pinId = cmd.params?.pin_id;
      const selector = cmd.params?.selector;
      if (typeof pinId !== 'string' && typeof selector !== 'string') {
        throw new Error('需要提供 pin_id 或 selector 其中之一');
      }
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, {
        type: 'BRIDGE_REMOVE_PIN',
        pin_id: typeof pinId === 'string' ? pinId : undefined,
        selector: typeof selector === 'string' ? selector : undefined,
      });
      if (typeof res.error === 'string') throw new Error(String(res.error));
      return { ...res, tab_id: tabId };
    }

    case 'clear_pins': {
      const status = cmd.params?.status;
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, {
        type: 'BRIDGE_CLEAR_PINS',
        status: typeof status === 'string' ? status : undefined,
      });
      if (typeof res.error === 'string') throw new Error(String(res.error));
      return { ...res, tab_id: tabId };
    }

    case 'get_pin_results': {
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, { type: 'BRIDGE_GET_PIN_RESULTS' });
      return { ...res, tab_id: tabId };
    }

    // PM-317
    case 'get_page_health': {
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, { type: 'BRIDGE_GET_PAGE_HEALTH' });
      return { ...res, tab_id: tabId };
    }

    // PM-316
    case 'get_web_vitals': {
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, { type: 'BRIDGE_GET_WEB_VITALS' });
      return { ...res, tab_id: tabId };
    }

    // PM-315
    case 'analyze_element': {
      const selector = cmd.params?.selector;
      if (typeof selector !== 'string' || !selector.trim()) throw new Error('缺少 selector 參數');
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, {
        type: 'BRIDGE_ANALYZE_ELEMENT',
        selector,
      });
      if (typeof res.error === 'string') {
        throw new Error(`${res.error}${res.hint ? `\n${String(res.hint)}` : ''}`);
      }
      return { selector, ...res, tab_id: tabId };
    }

    // PM-313
    case 'get_browser_errors': {
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<{
        console_errors?: unknown[];
        network_errors?: unknown[];
      }>(tabId, { type: 'BRIDGE_GET_BROWSER_ERRORS' });
      const consoleErrors = res.console_errors ?? [];
      const networkErrors = res.network_errors ?? [];
      return {
        console_errors: consoleErrors,
        network_errors: networkErrors,
        total_count: consoleErrors.length + networkErrors.length,
        tab_id: tabId,
        // inject 的背景 buffer 是 30 秒滾動視窗（REWIND_WINDOW），每 5 秒裁一次舊資料。
        // 不講明的話，「載入時就噴的錯誤」在 AI 過幾十秒才來問時會變成空陣列，
        // 而空陣列看起來就像「這頁沒問題」——必須讓 AI 知道要重新整理再問。
        window_seconds: 30,
        note: '只涵蓋最近 30 秒（頁面內的滾動緩存）。若要抓「頁面載入當下」的錯誤，請先 navigate_to 或重新整理該分頁，再立刻呼叫本工具。',
      };
    }

    // PM-312：FOX 選方案 B —— 目標分頁不是 active 時暫時切過去截圖，再切回原本那個。
    case 'take_screenshot': {
      const tabId = await resolveTargetTab(cmd.params);
      const tab = await chrome.tabs.get(tabId);
      const windowId = tab.windowId;

      let switched = false;
      let previousActiveId: number | undefined;
      if (!tab.active) {
        const [prev] = await chrome.tabs.query({ active: true, windowId });
        previousActiveId = prev?.id;
        await chrome.tabs.update(tabId, { active: true });
        switched = true;
        await new Promise((r) => setTimeout(r, SCREENSHOT_RENDER_WAIT_MS));
      }

      let dataUrl: string;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `截圖失敗：${msg}\n` +
            'captureVisibleTab 需要 `activeTab` 或 `<all_urls>` 權限。BugEzy 只有 `activeTab`，' +
            '而它**只在使用者主動叫用擴充功能之後**才會授予該分頁（點擴充圖示／快捷鍵／右鍵選單），bridge 的呼叫沒有使用者手勢。\n' +
            '可用的作法：請使用者在**要截圖的那個分頁**點一下 BugEzy 圖示，然後**直接呼叫 take_screenshot，中間不要再 navigate_to** ' +
            '——導航會讓 `activeTab` 失效，又得重點一次。\n' +
            '若只是要了解頁面內容，改用 read_page 不需要任何額外權限，而且省約 95% token。',
        );
      } finally {
        // 不論成功失敗都要切回去，否則使用者的分頁被我們留在別的地方
        if (switched && previousActiveId !== undefined) {
          await chrome.tabs.update(previousActiveId, { active: true }).catch(() => undefined);
        }
      }

      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const { width, height } = pngSize(base64);
      const info = await readTabInfo(tabId);
      return {
        image_base64: base64,
        format: 'png',
        width,
        height,
        bytes: Math.round((base64.length * 3) / 4),
        tab_id: tabId,
        url: info?.url ?? tab.url ?? '',
        ...(switched ? { warning: '已暫時切換分頁以截圖，截完已切回原本的分頁' } : {}),
      };
    }

    // PM-311
    case 'type_text': {
      const selector = cmd.params?.selector;
      const text = cmd.params?.text;
      if (typeof selector !== 'string' || !selector.trim()) throw new Error('缺少 selector 參數');
      if (typeof text !== 'string') throw new Error('缺少 text 參數（必須是字串）');
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<Record<string, unknown>>(tabId, {
        type: 'BRIDGE_TYPE_TEXT',
        selector,
        text,
      });
      if (typeof res.error === 'string') {
        const extra = res.tag ? `（找到的是 <${String(res.tag)}>）` : '';
        throw new Error(`${res.error}${extra}${res.hint ? `\n${String(res.hint)}` : ''}`);
      }
      return {
        typed: true,
        selector,
        tab_id: tabId,
        previous_value: res.previous_value ?? '',
        new_value: res.new_value ?? '',
        // 寫入後實際值與要求不符時明講（maxlength、輸入遮罩等會改動內容）
        ...(res.value_matches === false
          ? { warning: '欄位實際存下的值與要求的不同（可能有 maxlength 或輸入格式限制），請以 new_value 為準' }
          : {}),
      };
    }

    // PM-309
    case 'read_page': {
      const tabId = await resolveTargetTab(cmd.params);
      const res = await sendToContent<{
        url?: string;
        title?: string;
        content?: string;
        truncated?: boolean;
        element_count?: number;
        ready_state?: string;
      }>(tabId, { type: 'BRIDGE_READ_PAGE' });
      return {
        url: res.url ?? '',
        title: res.title ?? '',
        content: res.content ?? '',
        truncated: res.truncated ?? false,
        element_count: res.element_count ?? 0,
        // PM-319：'loading' / 'interactive' 代表頁面還沒 render 完，content 可能不完整
        ready_state: res.ready_state ?? 'unknown',
        tab_id: tabId,
      };
    }

    default:
      throw new Error(`未知的指令：${cmd.command}`);
  }
}

/**
 * PM-404：向 bridge 發一則**唯讀**查詢並等回覆。
 *
 * bridge 那端是硬編碼白名單（目前只有 `memory_stats`）。這裡不做重試——
 * popup 只是要顯示一個數字，連不上就如實說「Bridge 未連線」，
 * 硬撐重試只會讓 popup 卡住。
 */
interface BridgeQueryWaiter {
  resolve: (r: { ok: boolean; data?: unknown; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}
const bridgeQueries = new Map<string, BridgeQueryWaiter>();
let bridgeQuerySeq = 0;

function queryBridge(query: 'memory_stats'): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const ws = bridgeSocket;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ ok: false, error: 'Bridge 未連線' });
  }
  const id = `q${++bridgeQuerySeq}-${Date.now().toString(36)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      bridgeQueries.delete(id);
      resolve({ ok: false, error: 'Bridge 未在時間內回應' });
    }, 5000);
    bridgeQueries.set(id, { resolve, timer });
    try {
      ws.send(JSON.stringify({ type: 'query', id, query }));
    } catch (e) {
      clearTimeout(timer);
      bridgeQueries.delete(id);
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

function scheduleBridgeReconnect(): void {
  if (bridgeRetryTimer !== undefined) return;
  bridgeRetryTimer = setTimeout(() => {
    bridgeRetryTimer = undefined;
    connectBridge();
  }, bridgeRetryMs) as unknown as number;
  // 指數退避（上限 60 秒）：bridge 通常沒在跑，不該一直重試
  bridgeRetryMs = Math.min(bridgeRetryMs * 2, BRIDGE_RETRY_MAX_MS);
}

function connectBridge(): void {
  if (bridgeSocket && bridgeSocket.readyState <= WebSocket.OPEN) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch {
    scheduleBridgeReconnect();
    return;
  }
  bridgeSocket = ws;

  ws.onopen = () => {
    bridgeRetryMs = BRIDGE_RETRY_MIN_MS; // 連上就重設退避
    console.log('[BugEzy bridge] 已連上 bugezy-bridge');
  };

  ws.onmessage = (ev) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    // 心跳：回 pong（同時讓 service worker 的閒置計時器歸零）
    if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      return;
    }
    // PM-404：bridge 對「唯讀查詢」的回覆（popup 的記憶矩陣區塊用）
    if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'query_result') {
      const qr = msg as { id: string; ok: boolean; data?: unknown; error?: string };
      const waiter = bridgeQueries.get(qr.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        bridgeQueries.delete(qr.id);
        waiter.resolve(qr.ok ? { ok: true, data: qr.data } : { ok: false, error: qr.error ?? '查詢失敗' });
      }
      return;
    }
    const cmd = msg as BridgeCommandMsg;
    if (!cmd || typeof cmd.id !== 'string' || typeof cmd.command !== 'string') return;
    void runBridgeCommand(cmd)
      .then((data) => ws.send(JSON.stringify({ id: cmd.id, ok: true, data })))
      .catch((e: unknown) =>
        ws.send(JSON.stringify({ id: cmd.id, ok: false, error: e instanceof Error ? e.message : String(e) })),
      );
  };

  ws.onclose = () => {
    if (bridgeSocket === ws) bridgeSocket = null;
    scheduleBridgeReconnect();
  };
  // bridge 沒在跑時每次都會觸發 onerror——這是預期情形，不要吵使用者
  ws.onerror = () => {};
}

// PM-298（實機驗收抓到）：**`setTimeout` 的重連撐不過 service worker 被回收**。
//   bridge 關掉後 WebSocket 斷線 → 沒有 WS 活動 → SW 閒置 30 秒被殺 → 重連計時器一起消失，
//   而且沒有任何事件會喚醒它 → 即使之後 bridge 重新啟動，擴充功能也永遠不會自己連回去。
//   （這正是我們拒絕「HTTP 輪詢」方案的同一個坑，只是換個地方出現。）
//
//   正解是 `chrome.alarms`（能喚醒已被回收的 SW），但那需要新增 `alarms` 權限 →
//   會觸發 Chrome Web Store 重新審核，違反本階段「不加新權限」的硬條件。
//   因此改為**搭便車**：在 SW 本來就會被喚醒的事件上順手確保連線。
//   代價是「bridge 開著但瀏覽器完全閒置」時不會自動連上——只要切個分頁或開一次 popup 就會連。
const ensureBridge = () => {
  if (!bridgeSocket || bridgeSocket.readyState > WebSocket.OPEN) {
    bridgeRetryMs = BRIDGE_RETRY_MIN_MS; // 有人在動 → 重設退避，立刻試
    connectBridge();
  }
};
chrome.runtime.onMessage.addListener(() => {
  // popup／content script 來訊＝SW 醒著，順手確保 bridge 連線。回 false 不影響既有處理鏈。
  ensureBridge();
  return false;
});
chrome.runtime.onStartup.addListener(ensureBridge);
chrome.runtime.onInstalled.addListener(ensureBridge);
chrome.tabs.onActivated.addListener(ensureBridge); // 切換分頁（不需 tabs 權限也會觸發）
chrome.tabs.onUpdated.addListener(ensureBridge); // 分頁載入完成

connectBridge();
