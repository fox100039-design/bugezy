// PM-297：MCP 工具定義。第一版只有 3 支，用途是驗證「AI → bridge → Extension → 回傳」整條通道。
//
// 命名遵循 PM-296 決策 2：**snake_case、不加 `bugezy:` 前綴**
// （MCP 用戶端本來就用 server 名稱做命名空間，再加前綴會變成 bugezy-bridge - bugezy:xxx）。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExtensionLink } from './extension-link.js';

/** 統一的回傳格式：MCP 只吃 content 陣列，這裡把物件序列化成文字。 */
function txt(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function createMcpServer(link: ExtensionLink): McpServer {
  const server = new McpServer({ name: 'bugezy-bridge', version: '0.1.0' });

  // ── 工具 1：ping —— 測試整條通道是否活著 ────────────────────────────────
  server.tool(
    'ping',
    'Check whether the BugEzy browser extension is connected to this bridge, and measure round-trip latency. 測試 BugEzy 擴充功能是否已連上 bridge，並量測往返延遲。',
    {},
    async () => {
      const t0 = Date.now();
      const r = await link.send('ping');
      const latency = Date.now() - t0;
      if (!r.ok) {
        return txt({ status: 'error', extension_connected: false, error: r.error, latency_ms: latency });
      }
      return txt({
        status: 'ok',
        extension_connected: true,
        latency_ms: latency,
        extension: r.data,
      });
    },
  );

  // ── 工具 2：get_page_url ────────────────────────────────────────────────
  server.tool(
    'get_page_url',
    "Get the URL and title of the user's currently active browser tab. 取得使用者當前分頁的網址與標題。",
    {},
    async () => {
      const r = await link.send('get_page_url');
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    },
  );

  // ── 工具 3：get_live_errors ─────────────────────────────────────────────
  // PM-296 決策 1：與雲端 MCP 的同名工具維持一致的 `source` 語意。
  //   本 bridge 只提供 source='browser'（即時）；'cache'（讀 R2 歷史）在雲端 MCP 上。
  server.tool(
    'get_live_errors',
    "Read console errors and failed network requests from the user's current tab in real time. 即時讀取當前分頁的 Console 錯誤與失敗的網路請求（4xx/5xx）。",
    {
      source: z
        .enum(['browser', 'cache'])
        .optional()
        .describe(
          "'browser'（預設）= 透過 bridge 即時讀當前分頁；'cache' = 讀雲端 R2 快取，請改用 bugezy.dev/mcp 上的同名工具。",
        ),
    },
    async (args) => {
      const source = args.source ?? 'browser';
      if (source === 'cache') {
        // 明講去哪裡拿，而不是靜默回空陣列讓 AI 以為「沒有錯誤」
        return txt({
          error: "本 bridge 只提供 source='browser'（即時）。",
          hint: "要讀歷史快取請改用雲端 MCP（https://bugezy.dev/mcp）的 get_live_errors。",
        });
      }
      const r = await link.send('get_live_errors');
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      const d = (r.data ?? {}) as { consoleLogs?: unknown[]; networkErrors?: unknown[] };
      const consoleLogs = d.consoleLogs ?? [];
      const networkErrors = d.networkErrors ?? [];
      return txt({
        source: 'browser',
        console_errors: consoleLogs,
        network_errors: networkErrors,
        count: consoleLogs.length + networkErrors.length,
      });
    },
  );

  return server;
}
