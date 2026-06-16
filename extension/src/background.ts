// background.ts — Service Worker（Manifest V3）
// 管理錄製狀態，轉送 popup 的開始/停止指令到 active tab 的 content script。
// 狀態持久化到 chrome.storage.local，避免 service worker 被回收後遺失。

import {
  STORAGE_KEY,
  type ControlMessage,
  type RecordingSummary,
  type StateResponse,
} from './types';

const STATE_KEY = 'bugezy:state';

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
  // 語音改由 inject.ts（MAIN world）自行收集，background 不再管理 offscreen
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

function toResponse(s: PersistedState): StateResponse {
  return { recording: s.recording, startedAt: s.startedAt, summary: s.summary };
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
        case 'RECORDING_DONE': {
          // content script 打包完成 → 回填摘要，並依 startedAt 算出錄製時長
          const prev = await getState();
          const incoming = (msg as { summary: RecordingSummary }).summary;
          const summary: RecordingSummary = {
            ...incoming,
            durationMs: prev.startedAt ? Date.now() - prev.startedAt : 0,
          };
          const s = await setState({ recording: false, summary });
          clearBadge();
          sendResponse(toResponse(s));
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
