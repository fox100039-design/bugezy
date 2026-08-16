// PM-297：MCP 工具定義。第一版只有 3 支，用途是驗證「AI → bridge → Extension → 回傳」整條通道。
//
// 命名遵循 PM-296 決策 2：**snake_case、不加 `bugezy:` 前綴**
// （MCP 用戶端本來就用 server 名稱做命名空間，再加前綴會變成 bugezy-bridge - bugezy:xxx）。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExtensionLink } from './extension-link.js';
import { NAVIGATE_TIMEOUT_MS } from './types.js';

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

  // ── 工具 4：navigate_to（PM-307）─────────────────────────────────────────
  // 規格書 §13.2「出任務模式」：省略 tab_id → 開新分頁且 **active:false 不搶焦點**，
  //   並回傳 tab_id 供後續操作帶入；指定 tab_id → 在該分頁內導航。
  // 規格書 §13.3 邊界：tab_id 指到不存在的分頁要**明確報錯**，
  //   絕不可默默退回當前分頁——那會讓 AI 在使用者的分頁上執行破壞性操作。
  server.tool(
    'navigate_to',
    'Open a URL in the browser. Omit tab_id to open a NEW background tab (does not steal focus) and get its tab_id back for subsequent calls; pass tab_id to navigate an existing tab. Waits until the page finishes loading. 開啟網址：省略 tab_id 會開一個背景新分頁（不搶焦點）並回傳其 tab_id；指定 tab_id 則在該分頁內導航。會等頁面載入完成才回傳。',
    {
      url: z
        .string()
        .url()
        .describe('要開啟的網址，必須是 http:// 或 https://（chrome://、file:// 等會被拒絕）。'),
      tab_id: z
        .number()
        .int()
        .optional()
        .describe(
          '省略 → 開新分頁（active:false，不搶焦點）並回傳新的 tab_id；指定 → 在該分頁內導航。分頁若已關閉會回報錯誤，不會改動其他分頁。',
        ),
    },
    async (args) => {
      const r = await link.send(
        'navigate_to',
        { url: args.url, tab_id: args.tab_id },
        NAVIGATE_TIMEOUT_MS,
      );
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    },
  );

  // ── 工具 5：click_element（PM-308）───────────────────────────────────────
  server.tool(
    'click_element',
    'Click an element on the page by CSS selector. Returns the clicked element\'s tag and text so you can confirm you hit the right thing. Reports an error (instead of silently succeeding) when the element is missing, disabled, or invisible. 用 CSS 選擇器點擊頁面元素，回傳被點元素的標籤與文字供確認；元素不存在／disabled／不可見時會明確報錯，不會假裝點成功。',
    {
      selector: z
        .string()
        .min(1)
        .describe('CSS 選擇器，例如 `#submit-btn`、`button.primary`、`a[href="/cart"]`。可先用 read_page 確認頁面上有哪些元素。'),
      tab_id: z
        .number()
        .int()
        .optional()
        .describe('省略 → 使用者當前分頁；指定 → 該分頁（例如 navigate_to 開出來的背景分頁）。分頁已關閉會回報錯誤。'),
    },
    async (args) => {
      const r = await link.send('click_element', { selector: args.selector, tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, selector: args.selector, extension_connected: link.connected });
      return txt(r.data);
    },
  );

  // ── 工具 6：read_page（PM-309）───────────────────────────────────────────
  // 規格書 §8 的差異化重點：**用文字讀 DOM，而不是截圖**（省 95% token，且 AI 可以直接搜尋元素）。
  server.tool(
    'read_page',
    'Read the page as a compact text map instead of a screenshot (~95% fewer tokens). Every interactive element comes with a ready-to-use CSS selector you can pass straight to click_element. Hidden elements are omitted; sensitive field values (passwords, tokens, card numbers) are masked. 以文字地圖方式讀取頁面（非截圖，省 95% token）；每個可互動元素都附上可直接餵給 click_element 的 selector；隱藏元素不列入，敏感欄位的值一律遮蔽。',
    {
      tab_id: z
        .number()
        .int()
        .optional()
        .describe('省略 → 使用者當前分頁；指定 → 該分頁（例如 navigate_to 開出來的背景分頁）。分頁已關閉會回報錯誤。'),
    },
    async (args) => {
      const r = await link.send('read_page', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    },
  );

  return server;
}
