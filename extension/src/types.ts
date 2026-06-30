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
  | { type: 'UPLOAD_REPORT'; description: string; markers?: TimeMarker[] }
  // PM-34：即時 flush（content → background 暫存，頁面跳轉不丟資料）
  | { type: 'FLUSH_VOICE'; segment: VoiceSegment }
  | { type: 'FLUSH_CONSOLE'; log: ConsoleLog }
  | { type: 'FLUSH_NETWORK'; error: NetworkError }
  | { type: 'FLUSH_RRWEB'; events: unknown[] }
  // PM-36：跳頁恢復時讀回已累積語音 buffer，填回右上面板
  | { type: 'GET_VOICE_BUFFER' }
  // PM-50：⏪ 30 秒回溯（背景緩存打包成報告）
  | { type: 'REWIND_30S' }
  | { type: 'REWIND_DONE'; summary: RecordingSummary }
  // PM-51：🔍 即時監控（AI 透過 MCP 隨時查當前頁面 error）
  | { type: 'GET_LIVE_ERRORS' }
  | { type: 'START_MONITORING' }
  | { type: 'STOP_MONITORING' }
  // PM-52：通知 content/inject 顯示/隱藏頁面浮動監控 badge
  | { type: 'SET_MONITOR_BADGE'; show: boolean }
  // PM-86：offscreen 麥克風錄音（popup → background → offscreen）
  | { type: 'MIC_START' }
  | { type: 'MIC_STOP' }
  | { type: 'OFFSCREEN_START_MIC' }
  | { type: 'OFFSCREEN_STOP_MIC' };

/** background → popup 的狀態回應 */
export interface StateResponse {
  recording: boolean;
  startedAt: number | null;
  summary: RecordingSummary | null;
  /** PM-63：免費版用量已達上限時，background 回傳此訊息，popup 顯示升級提示而不進入錄製 */
  limitReached?: string;
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

/** content → inject：控制（PM-49 keyboardMode；PM-50 REWIND；PM-51 GET_LIVE_ERRORS；PM-52 SHOW/HIDE_MONITOR） */
export interface InjectCommand {
  source: typeof BUGEZY_SOURCE;
  dir: 'to-inject';
  cmd: 'START' | 'STOP' | 'REWIND' | 'GET_LIVE_ERRORS' | 'SHOW_MONITOR' | 'HIDE_MONITOR';
  keyboardMode?: boolean;
}

/** inject → content：狀態回報（握手 / 開始確認）與打包資料 */
export type InjectMessage =
  | { source: typeof BUGEZY_SOURCE; dir: 'to-content'; kind: 'READY' }
  | { source: typeof BUGEZY_SOURCE; dir: 'to-content'; kind: 'STARTED'; rrwebOk: boolean }
  | { source: typeof BUGEZY_SOURCE; dir: 'to-content'; kind: 'RESULT'; payload: RecordingPayload }
  // PM-34：即時 flush（inject MAIN world → content ISOLATED world → background 暫存）
  | { source: typeof BUGEZY_SOURCE; dir: 'to-content'; kind: 'FLUSH_VOICE'; segment: VoiceSegment }
  | { source: typeof BUGEZY_SOURCE; dir: 'to-content'; kind: 'FLUSH_CONSOLE'; log: ConsoleLog }
  | { source: typeof BUGEZY_SOURCE; dir: 'to-content'; kind: 'FLUSH_NETWORK'; error: NetworkError }
  | { source: typeof BUGEZY_SOURCE; dir: 'to-content'; kind: 'FLUSH_RRWEB'; events: unknown[] }
  // PM-36：inject 建面板後請求歷史語音（to-content）；content 讀 buffer 後回填（to-inject）
  | { source: typeof BUGEZY_SOURCE; dir: 'to-content'; kind: 'REQUEST_VOICE_HISTORY' }
  | { source: typeof BUGEZY_SOURCE; dir: 'to-inject'; kind: 'VOICE_HISTORY'; segments: VoiceSegment[] }
  // PM-37：content 收到 READY 後回 ACK，讓 inject 停止重複發 READY（解 READY 競爭條件）
  | { source: typeof BUGEZY_SOURCE; dir: 'to-inject'; kind: 'READY_ACK' }
  // PM-50：inject 打包背景緩存（最近 30 秒）回傳給 content
  | { source: typeof BUGEZY_SOURCE; dir: 'to-content'; kind: 'REWIND_RESULT'; payload: RecordingPayload }
  // PM-51：inject 回傳當前頁面即時 console/network errors
  | {
      source: typeof BUGEZY_SOURCE;
      dir: 'to-content';
      kind: 'LIVE_ERRORS_RESULT';
      consoleLogs: ConsoleLog[];
      networkErrors: NetworkError[];
    };

/** chrome.storage.local 的鍵 */
export const STORAGE_KEY = 'bugezy:lastPayload';

/** 錄製狀態鍵（background 持久化 + edit-report 讀摘要） */
export const STATE_KEY = 'bugezy:state';

/** 截圖獨立上傳後的最近一筆（給 popup 顯示連結） */
export const LAST_SCREENSHOT_KEY = 'bugezy:lastScreenshot';

/** PM-61：Google 登入後的使用者 session，存 chrome.storage.local */
export const SESSION_KEY = 'bugezy:session';

/** 登入 session（popup 存、background 上傳時帶 user_id） */
export interface Session {
  user_id: string;
  email: string;
  name: string;
  avatar_url: string;
  session_token: string;
}

/** PM-49：鍵盤模式（關閉所有語音）開關，存 chrome.storage.local */
export const KEYBOARD_MODE_KEY = 'bugezy:keyboardMode';

/** PM-51：即時監控模式（背景每 10s 推送 live errors 到 API）開關 */
export const MONITOR_MODE_KEY = 'bugezy:monitorMode';

/** PM-83：允許 AI 讀取截圖圖片（高畫質 AI 分析）開關；截圖上傳時帶入報告 allow_screenshot_images */
export const ALLOW_SCREENSHOT_KEY = 'bugezy:allow-screenshot-images';

/** PM-86：popup 麥克風 toggle（offscreen 錄音 + Groq Whisper 架構）開關，預設開啟 */
export const MIC_KEY = 'bugezy:mic-enabled';

/** PM-86：offscreen 錄音 → /api/transcribe 轉錄結果暫存（PM-87 錄製 payload 讀回） */
export const VOICE_TRANSCRIPT_KEY = 'bugezy:voice-transcript';

/** PM-34：錄製中即時 flush 的暫存 buffer（頁面跳轉不丟資料） */
export const BUFFER_VOICE_KEY = 'bugezy:buffer:voice';
export const BUFFER_CONSOLE_KEY = 'bugezy:buffer:console';
export const BUFFER_NETWORK_KEY = 'bugezy:buffer:network';
export const BUFFER_RRWEB_KEY = 'bugezy:buffer:rrweb';

/** 統一前綴的診斷 log */
export function blog(...args: unknown[]): void {
  if (BUGEZY_DEBUG) console.log('[BugEzy]', ...args);
}
