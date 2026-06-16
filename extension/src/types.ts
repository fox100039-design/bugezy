// 共用型別 — BugEzy 擴充各模組間的訊息協定與資料結構

/** Console 攔截紀錄（只抓 warn / error） */
export interface ConsoleLog {
  level: 'warn' | 'error';
  message: string;
  timestamp: number;
}

/** Network 攔截紀錄（只抓 4xx / 5xx） */
export interface NetworkError {
  method: string;
  url: string;
  status: number;
  requestBody?: string;
  responseBody?: string;
  timestamp: number;
  duration: number;
}

/** 頁面資訊（停止時自動帶入） */
export interface PageInfo {
  url: string;
  title: string;
  browser: string;
  screenSize: string;
  timestamp: string;
}

/** 語音辨識片段 */
export interface VoiceSegment {
  text: string; // 辨識出的文字
  timestamp: number; // 該句開始的 Date.now()
  isFinal: boolean; // SpeechRecognition 的 isFinal
}

/** 一次完整錄製的打包結果 */
export interface RecordingPayload {
  rrwebEvents: unknown[];
  consoleLogs: ConsoleLog[];
  networkErrors: NetworkError[];
  pageInfo: PageInfo;
  voiceTranscript: VoiceSegment[]; // 語音轉文字（content.ts 合併）
}

/** 摘要（供 popup 顯示） */
export interface RecordingSummary {
  domEvents: number;
  consoleLogs: number;
  networkErrors: number;
  pageInfo: PageInfo;
  /** 錄製時長（毫秒）— 由 background 依 startedAt 回填 */
  durationMs: number;
  voiceSegments: number;
}

// ── 訊息協定 ──────────────────────────────────────────────

/** popup ↔ background ↔ content 的控制訊息 */
export type ControlMessage =
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'CLEAR_RECORDING' }
  | { type: 'GET_STATE' }
  | { type: 'GET_LAST_PAYLOAD' };

/** background → popup 的狀態回應 */
export interface StateResponse {
  recording: boolean;
  startedAt: number | null;
  summary: RecordingSummary | null;
}

/** 開發診斷 log 開關（PM-04 除錯用，全程印 [BugEzy] log） */
export const BUGEZY_DEBUG = true;

/**
 * MAIN world（inject.js）↔ ISOLATED world（content.js）
 * 透過 window.postMessage 傳遞，統一掛 source 識別。
 */
export const BUGEZY_SOURCE = 'bugezy';

/** content → inject：控制錄製 */
export interface InjectCommand {
  source: typeof BUGEZY_SOURCE;
  dir: 'to-inject';
  cmd: 'START' | 'STOP';
}

/** inject → content：狀態回報（握手 / 開始確認）與打包資料 */
export type InjectMessage =
  | { source: typeof BUGEZY_SOURCE; dir: 'to-content'; kind: 'READY' }
  | { source: typeof BUGEZY_SOURCE; dir: 'to-content'; kind: 'STARTED'; rrwebOk: boolean }
  | { source: typeof BUGEZY_SOURCE; dir: 'to-content'; kind: 'RESULT'; payload: RecordingPayload };

/** chrome.storage.local 的鍵 */
export const STORAGE_KEY = 'bugezy:lastPayload';

/** 統一前綴的診斷 log */
export function blog(...args: unknown[]): void {
  if (BUGEZY_DEBUG) console.log('[BugEzy]', ...args);
}
