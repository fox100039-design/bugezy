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
 * PM-63：錄製前檢查免費版用量。POST /api/user/usage（type:recording）同時遞增計數並檢查。
 * - 未登入（無 token）→ 不檢查，回 null（公測期不阻擋匿名使用）。
 * - 達上限 → 回傳升級訊息字串；否則回 null。
 * - API 不通 → 回 null（不因後端問題卡住錄製）。
 */
async function checkRecordingUsage(): Promise<string | null> {
  const headers = await getAuthHeaders();
  if (!headers.Authorization) return null; // 未登入 → 不檢查（公測期不阻擋匿名使用）
  try {
    const res = await fetch(`${API_BASE}/api/user/usage`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'recording' }),
    });
    if (res.status === 403) {
      const err = (await res.json()) as { error?: string; message?: string };
      if (err.error === 'limit_reached') return err.message || '免費版用量已達上限，請升級付費版';
    }
    return null;
  } catch (e) {
    blog('checkRecordingUsage failed', e);
    return null;
  }
}

// PM-97：本次錄製的 tab id 快取，供 MIC_VOLUME（每 200ms）轉發音量到頁面，免每次讀 storage。
let recordingTabId: number | null = null;

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
  if ((await getMicMode()) === 'whisper') {
    try {
      const ready = await ensureMicReady(); // PM-88/89：未授權 → 跳過語音（授權改由 popup toggle 觸發）
      if (ready) {
        await chrome.runtime.sendMessage({ type: 'OFFSCREEN_START_MIC' });
        blog('語音引擎：Groq Whisper（付費版精準轉錄）');
      } else {
        blog('麥克風未授權，本次不錄語音（請在 popup 開麥克風 toggle 授權）');
      }
    } catch (err) {
      blog('offscreen 麥克風啟動失敗（不阻擋錄製）', err);
    }
  }
  // 截圖改為獨立功能（PM-18），不再混入錄製
  await chrome.tabs.sendMessage(tab.id, { type: 'START_RECORDING' } satisfies ControlMessage);
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
      await fetch(`${API_BASE}/api/live-errors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: tab.url,
          title: tab.title,
          consoleLogs: result.consoleLogs ?? [],
          networkErrors: result.networkErrors ?? [],
          timestamp: Date.now(),
        }),
      });
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
  if (!res?.audioBlob) return res ?? { error: '未取得音訊' };
  try {
    const blob = await (await fetch(res.audioBlob)).blob();
    const form = new FormData();
    form.append('audio', blob, 'recording.webm');
    // PM-137：帶使用者選的 Whisper 語言（server 端有白名單驗證，非白名單 fallback zh）
    const langStore = await chrome.storage.local.get(LANG_KEY);
    form.append('language', (langStore[LANG_KEY] as string) || 'zh');
    // PM-135：帶 session token（transcribe 需登入 + 付費驗證）。multipart 不可手動設 Content-Type。
    const transcribeRes = await fetch(`${API_BASE}/api/transcribe`, {
      method: 'POST',
      headers: await getAuthHeaderOnly(),
      body: form,
    });
    const result = (await transcribeRes.json()) as {
      ok?: boolean;
      text?: string;
      segments?: unknown[];
      duration?: number;
    };
    if (result.ok) {
      await chrome.storage.local.set({
        [VOICE_TRANSCRIPT_KEY]: {
          text: result.text,
          segments: result.segments,
          duration: result.duration,
          timestamp: Date.now(),
        },
      });
      blog('語音轉錄完成:', (result.text ?? '').substring(0, 50));
    }
    return result;
  } catch (err) {
    blog('轉錄失敗:', err);
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
          if ((await getMicMode()) === 'whisper') {
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
            await stopMicAndTranscribe();
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
          const m = msg as { dataUrl: string; pageUrl: string; pageTitle: string };
          await openAnnotate(m.dataUrl, m.pageUrl, m.pageTitle);
          sendResponse({ ok: true });
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
          } else {
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
