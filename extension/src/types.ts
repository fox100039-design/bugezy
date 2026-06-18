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

/** 截圖（PM-18：截圖改為獨立功能，自行上傳一份報告） */
export interface Screenshot {
  dataUrl: string; // base64 PNG data URL（chrome.tabs.captureVisibleTab）
  timestamp: number; // Date.now()
}

/** 時間軸標記（PM-28：編輯頁在 mini player 上標記時間點 + 文字說明） */
export interface TimeMarker {
  time_sec: number; // 標記的播放秒數
  note: string; // 該時間點的問題描述
}

/** 一次完整錄製的打包結果（PM-18：錄製不再含截圖，截圖獨立上傳） */
export interface RecordingPayload {
  rrwebEvents: unknown[];
  consoleLogs: ConsoleLog[];
  networkErrors: NetworkError[];
  pageInfo: PageInfo;
  voiceTranscript: VoiceSegment[]; // 語音轉文字（content.ts 合併）
  markers?: TimeMarker[]; // PM-28：時間軸標記（選填，向後相容）
}

/** 上傳狀態 */
export type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

/** 摘要（供 popup 顯示） */
export interface RecordingSummary {
  domEvents: number;
  consoleLogs: number;
  networkErrors: number;
  pageInfo: PageInfo;
  /** 錄製時長（毫秒）— 由 background 依 startedAt 回填 */
  durationMs: number;
  voiceSegments: number;
  /** 雲端上傳狀態（PM-11） */
  uploadStatus: UploadStatus;
  shareUrl: string | null;
  uploadError: string | null;
}

// ── 訊息協定 ──────────────────────────────────────────────

/** popup ↔ background ↔ content 的控制訊息 */
export type ControlMessage =
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'CLEAR_RECORDING' }
  | { type: 'GET_STATE' }
  | { type: 'GET_LAST_PAYLOAD' }
  | { type: 'CAPTURE_SCREENSHOT' }
  | { type: 'SCREENSHOT_UPLOADED'; shareUrl: string; reportId: string }
  // PM-19：截圖模式 overlay（background ↔ content）
  | { type: 'START_SCREENSHOT' }
  | { type: 'CAPTURE_SEGMENT' }
  | { type: 'SCREENSHOT_READY'; dataUrl: string; pageUrl: string; pageTitle: string }
  // PM-24：編輯頁確認上傳錄製報告（PM-28：帶上時間軸標記）
  | { type: 'UPLOAD_REPORT'; description: string; markers?: TimeMarker[] };

/** background → popup 的狀態回應 */
export interface StateResponse {
  recording: boolean;
  startedAt: number | null;
  summary: RecordingSummary | null;
}

/** API base URL — 開發期 localhost，部署後改正式 URL */
export const API_BASE = 'https://bugezy-api.bugezy-api.workers.dev';

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

/** 錄製狀態鍵（background 持久化 + edit-report 讀摘要） */
export const STATE_KEY = 'bugezy:state';

/** 截圖獨立上傳後的最近一筆（給 popup 顯示連結） */
export const LAST_SCREENSHOT_KEY = 'bugezy:lastScreenshot';

/** 統一前綴的診斷 log */
export function blog(...args: unknown[]): void {
  if (BUGEZY_DEBUG) console.log('[BugEzy]', ...args);
}
