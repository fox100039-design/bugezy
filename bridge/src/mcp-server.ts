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

  // ── 工具 9：analyze_element（PM-315）─────────────────────────────────────
  server.tool(
    'analyze_element',
    'Deep-dive a single element: attributes, a curated set of computed styles, box model, accessibility info, and visibility breakdown. Use this after read_page when you need to know WHY an element looks or behaves wrong. Note: event listeners bound via addEventListener cannot be enumerated from a content script — an empty list does NOT mean there are no handlers. 深度分析單一元素：屬性、精選的計算樣式、box model、可及性資訊、可見性細節。適合在 read_page 之後用來查「這個元素為什麼長得不對／行為不對」。注意：用 addEventListener 綁的監聽器無法列舉，**空清單不代表沒有事件處理器**。',
    {
      selector: z
        .string()
        .min(1)
        .describe('CSS 選擇器。可先用 read_page 取得頁面上可用的 selector。'),
      tab_id: z
        .number()
        .int()
        .optional()
        .describe('省略 → 使用者當前分頁；指定 → 該分頁。分頁已關閉會回報錯誤。'),
    },
    async (args) => {
      const r = await link.send('analyze_element', { selector: args.selector, tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, selector: args.selector, extension_connected: link.connected });
      return txt(r.data);
    },
  );

  // ── 工具 10：get_browser_errors（PM-313）─────────────────────────────────
  // 讀的是 inject.ts 既有的背景緩存（PM-50/51），不另外掛一套攔截器。
  server.tool(
    'get_browser_errors',
    "Read console errors and failed network requests (4xx/5xx) from a tab in real time. IMPORTANT: only covers the last ~30 seconds (rolling in-page buffer) — to catch page-load errors, navigate_to or reload the tab and call this immediately after. Returns empty arrays (not an error) when the page is clean. 即時讀取分頁的 Console 錯誤與失敗的網路請求（4xx/5xx）。**注意：只涵蓋最近約 30 秒**（頁面內的滾動緩存）——要抓載入當下的錯誤，請先 navigate_to／重新整理再立刻呼叫。頁面沒問題時回空陣列（不是錯誤）。",
    {
      tab_id: z
        .number()
        .int()
        .optional()
        .describe('省略 → 使用者當前分頁；指定 → 該分頁。分頁已關閉會回報錯誤。'),
    },
    async (args) => {
      const r = await link.send('get_browser_errors', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    },
  );

  // ── 工具 8：take_screenshot（PM-312）─────────────────────────────────────
  server.tool(
    'take_screenshot',
    'Capture a PNG screenshot of a tab. Prefer read_page for understanding page structure — it costs ~95% fewer tokens and needs no extra permission; use screenshots only for visual layout, styling, or rendering bugs. REQUIRES the user to have clicked the BugEzy toolbar icon on that tab first (Chrome only grants activeTab after a user gesture), and you must NOT navigate in between — navigating revokes it. If the target tab is not active it will be focused briefly and then switched back. 截取分頁的 PNG 截圖。**想了解頁面結構請優先用 read_page**（省約 95% token 且不需額外權限）；只有在需要看視覺排版、樣式或渲染問題時才截圖。**前提：使用者必須先在該分頁點過 BugEzy 圖示**（Chrome 的 activeTab 只在使用者手勢後授予），而且中間不能再導航（導航會撤銷）。目標分頁若不是當前分頁，會短暫切過去截完再切回。',
    {
      tab_id: z
        .number()
        .int()
        .optional()
        .describe('省略 → 使用者當前分頁；指定 → 該分頁（非 active 時會暫時切換，截完切回）。'),
    },
    async (args) => {
      const r = await link.send('take_screenshot', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      const d = (r.data ?? {}) as {
        image_base64?: string;
        format?: string;
        width?: number;
        height?: number;
        bytes?: number;
        tab_id?: number;
        url?: string;
        warning?: string;
      };
      const { image_base64, ...meta } = d;
      if (!image_base64) return txt({ error: '擴充功能沒有回傳圖片資料', ...meta });
      // ⚠ 圖片走 MCP 原生的 image content，**不要塞進 JSON 文字裡**——
      //   一張全螢幕 PNG 的 base64 動輒數十萬字元，當成文字回傳會直接灌爆 AI 的 context，
      //   而且用戶端也無法把它當圖片顯示。
      return {
        content: [
          { type: 'image' as const, data: image_base64, mimeType: 'image/png' },
          { type: 'text' as const, text: JSON.stringify(meta, null, 2) },
        ],
      };
    },
  );

  // ── 工具 7：type_text（PM-311）───────────────────────────────────────────
  server.tool(
    'type_text',
    'Type text into an input, textarea, or contenteditable element. Replaces the existing value and fires input/change events the way a real user would, so React/Vue state actually updates. Returns previous_value so you can tell whether you overwrote something. 在 input / textarea / contenteditable 輸入文字：會取代原有內容，並以框架收得到的方式觸發 input/change 事件（React/Vue 的狀態會真的更新）；回傳 previous_value 讓你知道是否覆蓋掉了原本的值。',
    {
      selector: z
        .string()
        .min(1)
        .describe('CSS 選擇器，指向 input / textarea / contenteditable 元素。可先用 read_page 取得可用的 selector。'),
      text: z.string().describe('要輸入的文字。**會取代欄位原有的全部內容**，不是附加。'),
      tab_id: z
        .number()
        .int()
        .optional()
        .describe('省略 → 使用者當前分頁；指定 → 該分頁。分頁已關閉會回報錯誤。'),
    },
    async (args) => {
      const r = await link.send('type_text', {
        selector: args.selector,
        text: args.text,
        tab_id: args.tab_id,
      });
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
