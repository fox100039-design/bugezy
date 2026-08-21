// PM-297：與 BugEzy Extension 的通訊層（localhost WebSocket）。
//
// ⚠ 這支程式跑在 MCP 的 stdio 模式底下——**stdout 是 MCP 協定專用的**，
//   任何 console.log 都會污染協定讓 AI 端解析失敗。全部訊息一律走 stderr。

import { WebSocketServer, WebSocket } from 'ws';
import {
  BRIDGE_PORT,
  COMMAND_TIMEOUT_MS,
  HEARTBEAT_MS,
  isHeartbeat,
  isQuery,
  isResult,
  type BridgeCommand,
  type BridgeResult,
} from './types.js';

/** 一律寫 stderr（見檔頭說明）。 */
export function log(...args: unknown[]): void {
  process.stderr.write(args.map(String).join(' ') + '\n');
}

interface Pending {
  resolve: (r: BridgeResult) => void;
  timer: NodeJS.Timeout;
}

/**
 * PM-372：允許連線的擴充功能 origin。
 *
 * 預設是 BugEzy 的正式版 ID；`manifest.json` 有固定的 `key`，所以**開發版未封裝載入時
 * 的 ID 與正式版相同**，一般情況不需要另外設定。真的需要（例如改過 key）再用
 * `BUGEZY_EXTENSION_IDS` 逗號分隔加入。
 */
const PROD_EXTENSION_ID = 'hfnkjlbbpehkflgfbjenfmnmjkdjadcj';

function buildAllowedOrigins(): Set<string> {
  const ids = [PROD_EXTENSION_ID, ...(process.env.BUGEZY_EXTENSION_IDS || '').split(',')]
    .map((x) => x.trim())
    .filter(Boolean);
  const out = new Set<string>();
  for (const id of ids) {
    // 已經是完整 origin 就直接收；只給 id 就補上三種瀏覽器的 scheme
    if (id.includes('://')) out.add(id.replace(/\/$/, ''));
    else {
      out.add(`chrome-extension://${id}`);
      out.add(`moz-extension://${id}`);
      out.add(`safari-web-extension://${id}`);
    }
  }
  return out;
}

const ALLOWED_ORIGINS = buildAllowedOrigins();

export class ExtensionLink {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private heartbeat: NodeJS.Timeout | null = null;
  private seq = 0;
  /** PM-298：通訊 server 起不來時的原因；設了之後所有指令都直接回這個訊息。 */
  private disabledReason: string | null = null;

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * PM-298：停用 Extension 通道，但**不讓整個 bridge 死掉**。
   * 典型情境：多個 AI 工具各自 spawn 一個 bridge，只有第一個綁得到 port。
   * 後起的那些若直接 exit，AI 端只會看到空的「Failed to connect」，完全查不出原因；
   * 保持 MCP server 活著，至少能把「另一個 bridge 已在運行」這句話送到 AI 面前。
   */
  disable(reason: string): void {
    this.disabledReason = reason;
  }

  start(port = BRIDGE_PORT): Promise<void> {
    return new Promise((resolve, reject) => {
      // PM-366（P0）：**Origin 驗證**。`ws://127.0.0.1` 被瀏覽器視為 potentially trustworthy，
      // 不受 mixed-content 阻擋 —— 也就是說**任何使用者造訪的網站，其 JS 都能直接連上這個 port**。
      // 而下方的連線處理會「以新連線取代舊連線」，所以一個惡意頁面可以：
      //   ① 把真正的 Extension 踢掉（阻斷服務）
      //   ② 冒充 Extension，餵給 AI 捏造的頁面內容與錯誤
      // 瀏覽器對 WebSocket **一律**會送 Origin 且頁面無法竄改，因此擋掉「Origin 是網頁來源」
      // 就能封住這條路。沒有 Origin 的連線（本機 CLI／測試工具）放行 —— 本機程式本來就能
      // 偽造任何 header，擋它沒有意義，那是另一個層級的問題（見 DONE-365）。
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port,
        verifyClient: (info, done) => {
          const origin = info.origin || info.req.headers.origin || '';
          if (!origin) return done(true);
          if (ALLOWED_ORIGINS.has(origin)) return done(true);
          // PM-372：只放行 **BugEzy 自己的** 擴充功能。原本放行任何 `chrome-extension://`，
          //   等於使用者裝的任何一個擴充功能都能連上 bridge、冒充 BugEzy 餵資料給 AI。
          log(`⛔ 拒絕來自 ${origin} 的連線（只接受 BugEzy 擴充功能）`);
          log(`   若這是你的開發版擴充，請設 BUGEZY_EXTENSION_IDS=<你的 extension id>（逗號分隔可多個）`);
          done(false, 403, 'Forbidden origin');
        },
      });
      this.wss = wss;

      wss.on('listening', () => {
        log(`   Extension 通訊: ws://127.0.0.1:${port}`);
        resolve();
      });

      wss.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // 常見情境：使用者開了兩個 bridge。講清楚而不是丟一坨 stack。
          reject(new Error(`port ${port} 已被占用——可能已經有一個 bugezy-bridge 在跑。`));
        } else {
          reject(err);
        }
      });

      wss.on('connection', (ws) => {
        // 只服務一個 Extension；新連線取代舊的（例如使用者重新載入擴充功能）
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          log('🔄 新的 Extension 連線，關閉舊連線');
          this.socket.close(1000, 'replaced');
        }
        this.socket = ws;
        log('✅ Extension 已連線');

        ws.on('message', (raw) => this.onMessage(String(raw)));
        ws.on('close', () => {
          if (this.socket === ws) {
            this.socket = null;
            log('⚠ Extension 已斷線（bridge 仍在執行，等待重新連線）');
          }
        });
        ws.on('error', (e) => log('⚠ Extension 連線錯誤:', String(e)));
      });

      // 心跳保活：見 types.ts 的 HEARTBEAT_MS 說明
      this.heartbeat = setInterval(() => {
        if (this.connected) this.socket!.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      }, HEARTBEAT_MS);
    });
  }

  private onMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      log('⚠ 收到無法解析的訊息，已忽略');
      return;
    }
    if (isHeartbeat(msg)) return; // pong，不需處理
    // PM-404：Extension 主動發起的**唯讀**查詢（popup 的記憶矩陣區塊用）
    if (isQuery(msg)) {
      void this.onQuery(msg.id, msg.query);
      return;
    }
    if (!isResult(msg)) {
      log('⚠ 收到非預期格式的訊息，已忽略');
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return; // 逾時後才回來的遲到結果，直接丟棄
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    p.resolve(msg);
  }

  /**
   * PM-404：回應 Extension 的唯讀查詢。
   *
   * **白名單是硬編碼的**——不是「查表後找不到就拒絕」，而是 switch 只認得這幾個字串。
   * 這樣新增能力一定要有人動這段程式碼，不會因為某個設定檔被改掉就多開一條路。
   */
  private async onQuery(id: string, query: string): Promise<void> {
    const send = (r: { ok: boolean; data?: unknown; error?: string }) => {
      if (this.connected) this.socket!.send(JSON.stringify({ type: 'query_result', id, ...r }));
    };
    try {
      switch (query) {
        case 'memory_stats': {
          const { memoryStats } = await import('./memory-ops.js');
          send({ ok: true, data: memoryStats() });
          return;
        }
        default:
          send({ ok: false, error: `不支援的查詢：${query}（這條通道只開放唯讀查詢）` });
      }
    } catch (e) {
      send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * 送一則指令給 Extension 並等它回覆。
   * **Extension 沒連線時不會拋錯**，而是回一個帶說明的失敗結果——
   * 讓 MCP 工具可以回「bridge 沒連上」給 AI，而不是讓整個工具呼叫爆掉。
   */
  send(
    command: string,
    params?: Record<string, unknown>,
    /** PM-307：導航等慢指令要拉長，見 types.ts 的 NAVIGATE_TIMEOUT_MS。 */
    timeoutMs: number = COMMAND_TIMEOUT_MS,
  ): Promise<BridgeResult> {
    if (this.disabledReason) {
      return Promise.resolve({ id: '', ok: false, error: this.disabledReason });
    }
    if (!this.connected) {
      return Promise.resolve({
        id: '',
        ok: false,
        error:
          'Extension 尚未連上 bridge。請確認：① BugEzy 擴充功能已安裝並啟用 ② 瀏覽器有開著 ③ 已重新載入擴充功能。',
      });
    }
    const id = `c${++this.seq}-${Date.now().toString(36)}`;
    const cmd: BridgeCommand = { id, command, params };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, error: `指令 ${command} 逾時（${timeoutMs} ms 未回應）` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.socket!.send(JSON.stringify(cmd));
    });
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    this.socket?.close();
    this.wss?.close();
  }
}
