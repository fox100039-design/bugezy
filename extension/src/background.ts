// background.ts — Service Worker（Manifest V3）
// 管理錄製狀態，轉送 popup 的開始/停止指令到 active tab 的 content script。
// 狀態持久化到 chrome.storage.local，避免 service worker 被回收後遺失。

import {
  API_BASE,
  BUFFER_CONSOLE_KEY,
  BUFFER_NETWORK_KEY,
  BUFFER_RRWEB_KEY,
  BUFFER_VOICE_KEY,
  LAST_SCREENSHOT_KEY,
  SESSION_KEY,
  STATE_KEY,
  STORAGE_KEY,
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
  const r = await chrome.storage.local.get(SESSION_KEY);
  const token = (r[SESSION_KEY] as Session | undefined)?.session_token;
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}/api/user/usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
  // 語音改由 inject.ts（MAIN world）自行收集；截圖改為獨立功能（PM-18），不再混入錄製
  await chrome.tabs.sendMessage(tab.id, { type: 'START_RECORDING' } satisfies ControlMessage);
  const s = await setState({
    recording: true,
    startedAt: Date.now(),
    tabId: tab.id,
    summary: null,
  });
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
      headers: { 'Content-Type': 'application/json' },
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

chrome.runtime.onMessage.addListener((msg: ControlMessage | { type: string; summary?: RecordingSummary }, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'START_RECORDING':
          sendResponse(await startRecording());
          break;
        case 'STOP_RECORDING':
          sendResponse(await stopRecording());
          break;
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
          const res = (await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_MIC' })) as {
            audioBlob?: string;
            error?: string;
          };
          if (res?.audioBlob) {
            try {
              const blob = await (await fetch(res.audioBlob)).blob();
              const form = new FormData();
              form.append('audio', blob, 'recording.webm');
              const transcribeRes = await fetch(`${API_BASE}/api/transcribe`, {
                method: 'POST',
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
              sendResponse(result);
            } catch (err) {
              blog('轉錄失敗:', err);
              sendResponse({ error: '轉錄失敗' });
            }
          } else {
            sendResponse(res);
          }
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
