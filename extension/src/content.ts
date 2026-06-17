// content.ts — 在 ISOLATED world 執行
// 橋接：background（chrome API）<->  inject.ts（MAIN world，window.postMessage）
// 自己不錄製，只負責轉送指令與打包資料。
//
// PM-04：加診斷 log，確認雙向 postMessage 通訊是否跑通。

import {
  BUGEZY_SOURCE,
  STORAGE_KEY,
  blog,
  type ControlMessage,
  type InjectCommand,
  type InjectMessage,
  type RecordingPayload,
  type RecordingSummary,
} from './types';

blog('content loaded（ISOLATED world）', location.href);

let injectReady = false;

function sendToInject(cmd: 'START' | 'STOP') {
  const msg: InjectCommand = { source: BUGEZY_SOURCE, dir: 'to-inject', cmd };
  blog(`→ 轉送 ${cmd} 給 inject（injectReady=${injectReady}）`);
  window.postMessage(msg, '*');
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

  if (data.kind === 'READY') {
    injectReady = true;
    blog('✓ inject 已報到（READY）');
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
});

// background → content：控制指令
chrome.runtime.onMessage.addListener((msg: ControlMessage, _sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    sendToInject('START');
    sendResponse({ ok: true });
  } else if (msg.type === 'STOP_RECORDING') {
    sendToInject('STOP');
    sendResponse({ ok: true });
  }
  return true;
});
