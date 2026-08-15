// PM-297：bridge ⇄ Extension 之間的線上協定（wire protocol）。
// 這個檔案要與 extension/src/background.ts 的 bridge 區塊保持一致——兩邊各有一份定義，
// 因為 extension 打包在另一個 tsconfig 下，無法直接 import。改動時務必兩邊一起改。

/** bridge → Extension：一則待執行的指令 */
export interface BridgeCommand {
  /** 對應回覆用的識別碼（bridge 產生） */
  id: string;
  /** 指令名稱，例如 'ping' / 'get_page_url' / 'get_live_errors' */
  command: string;
  /** 指令參數（可省略） */
  params?: Record<string, unknown>;
}

/** Extension → bridge：指令執行結果 */
export interface BridgeResult {
  /** 對應 BridgeCommand.id */
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** 心跳：雙向，用來① 保活 MV3 service worker ② 偵測斷線 */
export interface BridgeHeartbeat {
  type: 'ping' | 'pong';
  t: number;
}

export type BridgeMessage = BridgeCommand | BridgeResult | BridgeHeartbeat;

export function isResult(m: unknown): m is BridgeResult {
  return typeof m === 'object' && m !== null && 'id' in m && 'ok' in m;
}

export function isHeartbeat(m: unknown): m is BridgeHeartbeat {
  return (
    typeof m === 'object' &&
    m !== null &&
    'type' in m &&
    ((m as BridgeHeartbeat).type === 'ping' || (m as BridgeHeartbeat).type === 'pong')
  );
}

/** 與 Extension 通訊用的 port（1985 = 第一隻電腦 bug 的年份）。 */
export const BRIDGE_PORT = 19850;

/** 指令逾時：Extension 沒在這個時間內回覆就視為失敗，避免 AI 端無限等待。 */
export const COMMAND_TIMEOUT_MS = 10_000;

/**
 * 心跳間隔。**必須明顯小於 30 秒**——MV3 的 service worker 閒置 30 秒就會被回收，
 * 而 Chrome 116 起 WebSocket 活動會重置這個閒置計時器，所以固定發心跳等於保活。
 * 這正是選 WebSocket 而非 HTTP 輪詢的關鍵理由（見 README）。
 */
export const HEARTBEAT_MS = 20_000;
