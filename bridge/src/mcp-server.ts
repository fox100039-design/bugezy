// PM-297：MCP 工具定義。第一版只有 3 支，用途是驗證「AI → bridge → Extension → 回傳」整條通道。
//
// 命名遵循 PM-296 決策 2：**snake_case、不加 `bugezy:` 前綴**
// （MCP 用戶端本來就用 server 名稱做命名空間，再加前綴會變成 bugezy-bridge - bugezy:xxx）。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExtensionLink } from './extension-link.js';
import { NAVIGATE_TIMEOUT_MS } from './types.js';
import {
  getTerminalLiveErrors,
  startTerminalMonitor,
  stopTerminalMonitor,
  MAX_MONITORS,
  TERMINAL_WINDOW_MS,
} from './terminal-monitor.js';

/** 統一的回傳格式：MCP 只吃 content 陣列，這裡把物件序列化成文字。 */
function txt(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

// ── PM-321：方案等級閘門（雛形）────────────────────────────────────────────
// 決策 3：v2（bridge）功能只給 Pro 訂閱；**票券／日票只含 v1**。
//
// ⚠ 目前 bridge 完全跑在本機、沒有連 Cloudflare Workers，拿不到使用者的 tier。
//   所以閘門邏輯先寫好但**預設關閉**——要開必須同時：
//     ① 設 `ENFORCE_TIER_GATE=true`  ② 設 `BUGEZY_USER_TIER=<tier>`（暫代真實查詢）
//   **預設關閉是刻意的**：若預設開啟又查不到 tier，只有兩種結果——
//   全部放行（等於沒有閘門）或全部擋掉（工具直接不能用）。兩者都比「明確關閉」糟。
type UserTier = 'free' | 'ticket' | 'day_pass' | 'pro' | 'max' | 'agent';
const V2_ALLOWED_TIERS: readonly UserTier[] = ['pro', 'max', 'agent'];

/** 回傳 null＝放行；回傳字串＝拒絕原因。 */
function tierGateReject(): string | null {
  if (process.env.ENFORCE_TIER_GATE !== 'true') return null; // 預設不啟用
  const tier = (process.env.BUGEZY_USER_TIER || 'free') as UserTier;
  if (V2_ALLOWED_TIERS.includes(tier)) return null;
  return `v2 功能需要 Pro 訂閱（NT$80/月）。目前方案：${tier}${
    tier === 'ticket' || tier === 'day_pass' ? '——票券／日票僅包含 v1 錄製功能，不含 v2 瀏覽器工具。' : '。'
  }升級請見 https://bugezy.dev/checkout`;
}

/**
 * 包住需要 v2 權限的工具處理函式；閘門關閉時完全不影響行為。
 * 回傳型別泛型化——`take_screenshot` 回的是 image content，不是純文字。
 */
function gated<T extends unknown[], R>(handler: (...args: T) => Promise<R>) {
  return async (...args: T): Promise<R> => {
    const reject = tierGateReject();
    if (reject) return txt({ error: reject, tier_gate: true }) as R;
    return handler(...args);
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
    gated(async (args) => {
      const r = await link.send(
        'navigate_to',
        { url: args.url, tab_id: args.tab_id },
        NAVIGATE_TIMEOUT_MS,
      );
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
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
    gated(async (args) => {
      const r = await link.send('click_element', { selector: args.selector, tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, selector: args.selector, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  // ── 工具 11：get_page_health（PM-317）────────────────────────────────────
  server.tool(
    'get_page_health',
    'One-shot health check for a tab: a 0-100 score, a one-line summary, and a breakdown of errors, Core Web Vitals, accessibility and DOM stats. Use this first to decide whether a page needs deeper investigation — it replaces calling get_browser_errors + get_web_vitals separately. Note: the error portion only covers the last ~30 seconds, so a high score can mean "nothing broke recently" rather than "nothing is broken". 一鍵健檢：0~100 分數、一句話摘要，以及錯誤／Core Web Vitals／可及性／DOM 統計的細項。**建議先用這支決定要不要深入**，它可取代分別呼叫 get_browser_errors 與 get_web_vitals。注意：錯誤部分只涵蓋最近約 30 秒，高分可能只代表「最近沒出事」而非「沒有問題」。',
    {
      tab_id: z
        .number()
        .int()
        .optional()
        .describe('省略 → 使用者當前分頁；指定 → 該分頁。分頁已關閉會回報錯誤。'),
    },
    gated(async (args) => {
      const r = await link.send('get_page_health', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  // ── 工具 10：get_web_vitals（PM-316）─────────────────────────────────────
  server.tool(
    'get_web_vitals',
    'Read Core Web Vitals (LCP / FID / CLS) plus FCP, TTFB and a resource breakdown for a tab, each with a Google-standard rating. FID is null until the user has interacted with the page — that is not zero latency. Resource sizes come from transferSize, which is 0 for cached and for cross-origin responses without Timing-Allow-Origin, so the total is a lower bound. 讀取分頁的 Core Web Vitals（LCP／FID／CLS）與 FCP、TTFB 及資源彙總，各自附 Google 標準評級。**使用者尚未互動時 FID 為 null，不是 0**；資源大小取自 transferSize，快取命中與跨網域未送 Timing-Allow-Origin 者皆為 0，**總大小是低估值**。',
    {
      tab_id: z
        .number()
        .int()
        .optional()
        .describe('省略 → 使用者當前分頁；指定 → 該分頁。分頁已關閉會回報錯誤。'),
    },
    gated(async (args) => {
      const r = await link.send('get_web_vitals', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
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
    gated(async (args) => {
      const r = await link.send('analyze_element', { selector: args.selector, tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, selector: args.selector, extension_connected: link.connected });
      return txt(r.data);
    }),
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
    gated(async (args) => {
      const r = await link.send('get_browser_errors', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
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
    gated(async (args) => {
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
    }),
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
    gated(async (args) => {
      const r = await link.send('type_text', {
        selector: args.selector,
        text: args.text,
        tab_id: args.tab_id,
      });
      if (!r.ok) return txt({ error: r.error, selector: args.selector, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  // ── 工具 6：read_page（PM-309）───────────────────────────────────────────
  // 規格書 §8 的差異化重點：**用文字讀 DOM，而不是截圖**（省 95% token，且 AI 可以直接搜尋元素）。
  server.tool(
    'read_page',
    'Read the page as a compact text map instead of a screenshot (~95% fewer tokens). Every interactive element comes with a ready-to-use CSS selector you can pass straight to click_element. Hidden elements are omitted; sensitive field values (passwords, tokens, card numbers) are masked. The returned ready_state tells you whether the page had finished loading — if it is not complete, the content may be incomplete, so do not conclude the page is empty. 以文字地圖方式讀取頁面（非截圖，省 95% token）；每個可互動元素都附上可直接餵給 click_element 的 selector；隱藏元素不列入，敏感欄位的值一律遮蔽。**回傳的 ready_state 若不是 complete，代表頁面還在載入、content 可能不完整**，別據此判定頁面是空的。',
    {
      tab_id: z
        .number()
        .int()
        .optional()
        .describe('省略 → 使用者當前分頁；指定 → 該分頁（例如 navigate_to 開出來的背景分頁）。分頁已關閉會回報錯誤。'),
    },
    gated(async (args) => {
      const r = await link.send('read_page', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  // ── 工具 15~17：圖釘系統（PM-330／331，Phase 2）──────────────────────────
  // 圖釘存在 content script 裡，依分頁天然隔離；分頁關閉／重整即消失（見 PM-329 設計）。
  server.tool(
    'pin_element',
    'Pin an element on the page with a note, showing a coloured marker next to it. Pinning the same selector again UPDATES the existing pin instead of creating a duplicate. Pins live in the tab and disappear when it is closed or reloaded. 在頁面元素上釘一個帶註記的標記。**重複釘同一個 selector 會更新原有圖釘，不會建立第二個**；圖釘存在該分頁，關閉或重整即消失。',
    {
      selector: z.string().min(1).describe('CSS 選擇器。可先用 read_page 取得可用的 selector。'),
      description: z.string().describe('這個圖釘的用途／要觀察什麼。'),
      tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。'),
    },
    gated(async (args) => {
      const r = await link.send('pin_element', {
        selector: args.selector,
        description: args.description,
        tab_id: args.tab_id,
      });
      if (!r.ok) return txt({ error: r.error, selector: args.selector, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'pin_analyze',
    'Pin an element (creating the pin if needed) and immediately run the full analyze_element inspection on it, storing the result as that pin latest check and updating its marker colour (green ok / yellow problem / grey element gone). 釘選元素（尚未釘則自動建立）並立刻對它執行完整的 analyze_element 分析，結果存為該圖釘的最近一次檢查並更新標記顏色（綠＝正常／黃＝有問題／灰＝元素已消失）。',
    {
      selector: z.string().min(1).describe('CSS 選擇器。'),
      tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。'),
    },
    gated(async (args) => {
      const r = await link.send('pin_analyze', { selector: args.selector, tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, selector: args.selector, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'get_pin_results',
    'List all pins in a tab with their status and latest check. Returns an empty array (not an error) when there are no pins. Status "stale" means the pinned element no longer exists on the page — that is different from the element being broken. 列出分頁內所有圖釘及其狀態與最近一次檢查。**沒有圖釘時回空陣列，不是錯誤**。狀態 `stale` 代表被釘的元素已從頁面消失——這與「元素有問題」是兩回事。',
    {
      tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。'),
    },
    gated(async (args) => {
      const r = await link.send('get_pin_results', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  // ── 工具 23~30：Zone Grid（PM-341~346，規格書 §15）────────────────────────
  server.tool(
    'map_page_zones',
    'Split the page into semantic zones (header / nav / main / aside / footer / section / role / class-name heuristics) so errors can be given an ADDRESS instead of just "somewhere on the page". Elements that fall into no zone are counted in unassigned_count — that number is never hidden. Call this first; the other zone tools build on it. 依語意結構把頁面切成區域，讓錯誤有「地址」而不只是「頁面某處」。沒落進任何區域的頂層元素計入 unassigned_count（**永不隱藏**）。其他 zone 工具都建立在這支之上，請先呼叫它。',
    { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
    gated(async (args) => {
      const r = await link.send('map_page_zones', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'get_zone_health',
    'Health status per zone (healthy / warning / error / unknown) with error counts, plus a separate "unassigned" bucket for errors that could not be located. IMPORTANT: a page where every zone is healthy can still be broken — always read unassigned. Each unhealthy zone carries a suggested_action you can act on directly. 各區域的健康狀態與錯誤數，另有獨立的 unassigned 統計（**無法定位的錯誤都在那裡，全綠不代表沒問題**）。有問題的區域會附上可直接執行的 suggested_action。',
    { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
    gated(async (args) => {
      const r = await link.send('get_zone_health', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'get_zone_errors',
    "Full error detail for one zone, including each error's element_selector (null means it could not be located and was filed under Unassigned). Pass 'Unassigned' to inspect the un-locatable ones. 取得單一區域的完整錯誤，含每筆的 element_selector（null 代表當下抓不到現場元素、已歸入 Unassigned）。傳入 Unassigned 可查看那些無法定位的錯誤。",
    {
      zone_id: z.string().min(1).describe('zone_id 或 zone 名稱；也可傳 Unassigned。'),
      tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。'),
    },
    gated(async (args) => {
      const r = await link.send('get_zone_errors', { zone_id: args.zone_id, tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'show_zone_overlay',
    'Show the zone grid overlay on the page: a translucent border per zone with its name and an error badge (red zones blink). 顯示頁面上的區域覆蓋層：每區一個半透明邊框，附名稱標籤與錯誤 badge（紅色區域會閃爍）。',
    { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
    gated(async (args) => {
      const r = await link.send('show_zone_overlay', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'hide_zone_overlay',
    'Hide the zone grid overlay. 隱藏區域覆蓋層。',
    { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
    gated(async (args) => {
      const r = await link.send('hide_zone_overlay', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'watch_zones',
    'Start periodically re-checking every zone in the background. This is PULL-based: nothing is pushed to you — call get_zone_changes to collect what changed since your last check. Calling it again updates the interval instead of starting a second watcher. 開始定期重新檢查所有區域。**這是 Pull 模式**：不會主動推播給你，要用 get_zone_changes 取走自上次查詢後的變化。重複呼叫只會更新間隔，不會開第二個 watcher。',
    {
      interval_seconds: z.number().int().optional().describe('掃描間隔秒數，預設 10（最低 2）。'),
      tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。'),
    },
    gated(async (args) => {
      const r = await link.send('watch_zones', {
        interval_seconds: args.interval_seconds,
        tab_id: args.tab_id,
      });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'get_zone_changes',
    'Collect zone status changes since your last call (the list is cleared once read). Empty changes means nothing changed — not that monitoring failed. Each change carries a suggested_action: deeper analysis when a zone degrades, cleanup when it recovers. 取走自上次查詢後的區域狀態變化（**讀取即清空**）。changes 為空代表沒有變化，不是監控失敗。每筆變化都附 suggested_action：惡化時建議深入分析、好轉時建議清理圖釘。',
    { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
    gated(async (args) => {
      const r = await link.send('get_zone_changes', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'stop_watching_zones',
    'Stop zone monitoring and report how long it ran and how many changes were seen. 停止區域監控，並回報監控時長與偵測到的變化總數。',
    { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
    gated(async (args) => {
      const r = await link.send('stop_watching_zones', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  // ── 工具 21~22：即時面板（PM-339，Phase 3 PM-J）──────────────────────────
  // 頁面右下角的浮動面板，用 shadow DOM 隔離，顯示圖釘／錯誤／效能的即時狀態。
  for (const [name, cmd, zh] of [
    ['show_debug_panel', 'show_debug_panel', '顯示'],
    ['hide_debug_panel', 'hide_debug_panel', '隱藏'],
  ] as const) {
    server.tool(
      name,
      `${zh === '顯示' ? 'Show' : 'Hide'} the floating BugEzy debug panel in the bottom-right corner of the page (pins / errors / performance, isolated in a shadow DOM so it cannot clash with the site styles). ${zh}頁面右下角的 BugEzy 即時面板（圖釘／錯誤／效能；以 shadow DOM 隔離，不會與網站樣式互相干擾）。`,
      { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
      gated(async (args) => {
        const r = await link.send(cmd, { tab_id: args.tab_id });
        if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
        return txt(r.data);
      }),
    );
  }

  // ── 工具 18~20：圖釘巡察與清理（PM-334／335，Phase 2 PM-G）────────────────
  server.tool(
    'patrol_pins',
    'Re-check every pin in one call: each is re-analysed, its status updated, and any CHANGE since the last check is flagged. Use alert_count to decide whether anything needs attention — it counts pins whose state changed, not pins that are merely unhealthy. Returns patrolled: 0 (not an error) when there are no pins. 一次巡檢所有圖釘：逐一重新分析、更新狀態，並標出**與上次相比的變化**。`alert_count` 數的是「狀態有變」的圖釘（不是「有問題」的圖釘），適合用來判斷需不需要深入看。沒有圖釘時回 `patrolled: 0`，不是錯誤。',
    { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
    gated(async (args) => {
      const r = await link.send('patrol_pins', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'remove_pin',
    'Remove one pin by pin_id (preferred) or by selector. 移除單一圖釘：優先用 pin_id，也可用 selector。',
    {
      pin_id: z.string().optional().describe('要移除的圖釘 id（優先）。'),
      selector: z.string().optional().describe('也可改用 selector 指定；pin_id 存在時以 pin_id 為準。'),
      tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。'),
    },
    gated(async (args) => {
      const r = await link.send('remove_pin', {
        pin_id: args.pin_id,
        selector: args.selector,
        tab_id: args.tab_id,
      });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'clear_pins',
    "Remove pins in bulk, optionally filtered by status. Valid statuses are active / warning / error / stale (there is no 'resolved' — use remove_pin for pins you are done with). 批次清除圖釘，可依狀態篩選。合法狀態為 active／warning／error／stale（**沒有 resolved**，處理完的圖釘請用 remove_pin）。",
    {
      status: z
        .enum(['all', 'active', 'warning', 'error', 'stale'])
        .optional()
        .describe("預設 'all'。注意沒有 'resolved' 這個狀態。"),
      tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。'),
    },
    gated(async (args) => {
      const r = await link.send('clear_pins', { status: args.status, tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  // ── 工具 12~14：終端機即時監控（PM-327 / PM-D2）──────────────────────────
  // 走的是 bridge 自己的 child_process，**不經過 Extension**——後端錯誤與瀏覽器無關。
  server.tool(
    'start_terminal_monitor',
    'Run a shell command (e.g. "npm run dev") under BugEzy and watch its output for backend errors in real time. Python tracebacks and Node.js stacks are parsed into type/message/frames, and secrets (DB URIs, API keys, tokens, PII) are masked before anything is stored. Nothing is uploaded — the buffer stays on this machine. 在 BugEzy 底下執行指令（例如 `npm run dev`）並即時監看後端錯誤：Python traceback 與 Node.js stack 會被解析成 type/message/frames，DB 連線字串／金鑰／token／個資在存入前就遮罩。**資料不會上傳，緩存只留在本機。**',
    {
      command: z.string().min(1).describe('要執行並監控的指令，例如 `npm run dev`、`python app.py`。會透過 shell 執行。'),
      cwd: z.string().optional().describe('工作目錄；省略則使用 bridge 的當前目錄。'),
    },
    gated(async (args) => txt(startTerminalMonitor(args.command, args.cwd))),
  );

  server.tool(
    'get_terminal_live_errors',
    `Read backend errors captured from a monitored command. Covers the last ${TERMINAL_WINDOW_MS / 1000} seconds. Parsed tracebacks appear in "errors"; stderr that could not be parsed appears in "unparsed_stderr" — an empty "errors" list does NOT mean the process is healthy. 讀取被監控指令的後端錯誤，涵蓋最近 ${TERMINAL_WINDOW_MS / 1000} 秒。解析成功的 traceback 在 errors，解析不出結構的原文在 unparsed_stderr——**errors 為空不代表程式沒問題**。`,
    {
      monitor_id: z.string().optional().describe('省略 → 最近啟動的那個 monitor。'),
    },
    gated(async (args) => txt(getTerminalLiveErrors(args.monitor_id))),
  );

  server.tool(
    'stop_terminal_monitor',
    `Stop a monitored command and its child processes. Up to ${MAX_MONITORS} commands can be monitored at once. 停止被監控的指令（連同子程序一起收）。同時最多監控 ${MAX_MONITORS} 個。`,
    {
      monitor_id: z.string().optional().describe('省略 → 最近啟動的那個 monitor。'),
    },
    gated(async (args) => txt(stopTerminalMonitor(args.monitor_id))),
  );

  return server;
}
