// background.ts — Service Worker（Manifest V3）
// 管理錄製狀態，轉送 popup 的開始/停止指令到 active tab 的 content script。
// 狀態持久化到 chrome.storage.local，避免 service worker 被回收後遺失。

import {
  API_BASE,
  LAST_SCREENSHOT_KEY,
  STATE_KEY,
  STORAGE_KEY,
  blog,
  type ControlMessage,
  type RecordingSummary,
  type StateResponse,
  type TimeMarker,
} from './types';

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

async function startRecording(): Promise<StateResponse> {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error('找不到 active tab');
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
  await chrome.storage.local.remove([STORAGE_KEY, STATE_KEY]);
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
  const r = await chrome.storage.local.get(STORAGE_KEY);
  const payload = r[STORAGE_KEY];
  if (!payload) return { ok: false, error: '沒有報告資料' };
  payload.description = description ?? '';
  payload.markers = markers ?? []; // PM-28：時間軸標記
  try {
    const res = await fetch(`${API_BASE}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { report_id: string; share_url: string };
    blog('uploadReport: 上傳成功', data.share_url);
    return { ok: true, shareUrl: data.share_url, reportId: data.report_id };
  } catch (err) {
    blog('uploadReport: 上傳失敗', err);
    return { ok: false, error: String(err) };
  }
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
          // content script 打包完成 → 回填摘要（PM-24：不直接上傳，改開編輯頁）
          const prev = await getState();
          const incoming = (msg as { summary: RecordingSummary }).summary;
          const summary: RecordingSummary = {
            ...incoming,
            durationMs: prev.startedAt ? Date.now() - prev.startedAt : 0,
            uploadStatus: 'idle',
            shareUrl: null,
            uploadError: null,
          };
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
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // 非同步回應
});
