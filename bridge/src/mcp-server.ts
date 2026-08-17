// PM-297：MCP 工具定義。第一版只有 3 支，用途是驗證「AI → bridge → Extension → 回傳」整條通道。
//
// 命名遵循 PM-296 決策 2：**snake_case、不加 `bugezy:` 前綴**
// （MCP 用戶端本來就用 server 名稱做命名空間，再加前綴會變成 bugezy-bridge - bugezy:xxx）。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExtensionLink } from './extension-link.js';
import { NAVIGATE_TIMEOUT_MS } from './types.js';
import {
  addSeverityRule,
  classifySeverity,
  decorate,
  listSeverityRules,
  removeSeverityRule,
  severitySummary,
} from './severity.js';
import { correlateErrors, getDetectReport, startAutoDetect } from './autodetect.js';
import {
  getTerminalLiveErrors,
  startTerminalMonitor,
  stopTerminalMonitor,
  MAX_MONITORS,
  TERMINAL_WINDOW_MS,
} from './terminal-monitor.js';
import { LAYERS, L3_MESSAGE, LAYER_NAMES, type Layer } from './memory-store.js';
import {
  memorySave, memoryLearn, memorySearch, memoryGet,
  memoryAudit, memoryPerfCheck, memoryBizValidate,
  memoryUpdate, memoryDelete, memoryList, memoryClear,
  memoryExport, memoryImport, memoryStats,
  MAX_TOPIC_LEN, MAX_CONTENT_LEN, MAX_TAGS,
} from './memory-ops.js';
import { tierGateReject, autoDetectTier, TOOL_TIER_MAP } from './tier-gate.js';

// ── PM-355~360：§14 記憶矩陣 ────────────────────────────────────────────────
// `L3` **刻意收進 enum 裡**，不是漏掉：若把它排除在 enum 外，AI 傳 L3 只會拿到
// zod 的「Invalid enum value」，看不出「L3 在雲端」這件事，於是會一直重試。
// 收進來再明確擋掉，才講得清楚原因。
const LAYER_ENUM = z.enum([...LAYERS, 'L3'] as [string, ...string[]]);
const LAYER_DESC = `記憶層：${LAYERS.map((l) => `${l}=${LAYER_NAMES[l as Layer]}`).join('、')}。L3（客服知識庫）在雲端，本機沒有。`;

/** 回傳 null＝可用；回傳物件＝要直接吐給呼叫端的錯誤。 */
function layerOrReject(layer: string): Layer | { error: string } {
  if (layer === 'L3') return { error: L3_MESSAGE, layer: 'L3' } as unknown as { error: string };
  return layer as Layer;
}
function isReject(x: unknown): x is { error: string } {
  return typeof x === 'object' && x !== null && 'error' in x;
}

/** 統一的回傳格式：MCP 只吃 content 陣列，這裡把物件序列化成文字。 */
function txt(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

// ── PM-362：方案分層閘門（PM-321 雛形的完整版，對照表在 tier-gate.ts）──────
//
// **預設仍然關閉**：bridge 跑在本機拿不到真實 tier，預設開啟只會得到「全放行（等於
// 沒閘門）」或「全擋掉（工具不能用）」。要開必須同時設 `ENFORCE_TIER_GATE=true`
// 與 `BUGEZY_USER_TIER=<tier>`。`ping` / `get_page_url` 永遠不擋，否則使用者無法
// 排查「為什麼 bridge 不能用」。

/**
 * 包住需要方案權限的工具處理函式；閘門關閉時完全不影響行為。
 * @param name 工具名，用來查 TOOL_TIER_MAP —— **不是裝飾用的**，查錯表就等於沒有分層。
 * @param requiredOverride 同一支工具因參數而屬於不同方案時使用（見 start_auto_detect）。
 */
function gated<T extends unknown[], R>(name: string, handler: (...args: T) => Promise<R>) {
  return async (...args: T): Promise<R> => {
    const reject = tierGateReject(name);
    if (reject) return txt({ error: reject, tier_gate: true, tool: name }) as R;
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
    gated('navigate_to', async (args) => {
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
    gated('click_element', async (args) => {
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
    gated('get_page_health', async (args) => {
      const r = await link.send('get_page_health', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      const d = (r.data ?? {}) as Record<string, unknown>;
      // PM-350：錯誤部分改用 severity 權重（critical -10 / minor -3 / info 0）。
      //   多打一次 get_browser_errors 是為了拿到**每一筆**錯誤（health 本身只回計數，
      //   算不出加權）。同機 localhost 往返約幾毫秒，換到的是「critical 與 warn 不再等價」。
      const eRes = await link.send('get_browser_errors', { tab_id: args.tab_id });
      if (!eRes.ok) return txt(d);
      const e = (eRes.data ?? {}) as Record<string, unknown>;
      const graded = [
        ...decorate((e.console_errors ?? []) as Array<Record<string, unknown>>, (x) => ({
          level: x.level as string, message: x.message as string, source: x.source as string,
        })),
        ...decorate((e.network_errors ?? []) as Array<Record<string, unknown>>, (x) => ({
          status: x.status as number, url: x.url as string,
        })),
      ];
      const c = { critical: 0, minor: 0, info: 0 };
      for (const g of graded) c[g.severity as 'critical' | 'minor' | 'info']++;
      const errorPenalty = Math.min(c.critical * 10 + c.minor * 3, 50);
      const ded = (d.deductions ?? {}) as Record<string, number>;
      const nonErrorPenalty = Object.entries(ded)
        .filter(([k]) => k !== 'console' && k !== 'network')
        .reduce((n, [, v]) => n + Number(v || 0), 0);
      const newScore = Math.max(0, 100 - errorPenalty - nonErrorPenalty);
      // summary 是 content script 依「舊的分數」組出來的句子；這裡既然改了分數，
      // 就必須把句首的數字一起換掉 —— 否則回傳會自相矛盾（summary 說 90 分、score 卻是別的值），
      // 而 AI 通常只讀 summary，會拿到錯的數字。
      const newSummary =
        typeof d.summary === 'string' ? d.summary.replace(/^\d+ 分/, `${newScore} 分`) : d.summary;
      return txt({
        ...d,
        score: newScore,
        summary: newSummary,
        severity_breakdown: c,
        deductions: { ...ded, console: undefined, network: undefined, errors_by_severity: errorPenalty },
        score_note: '錯誤部分依 §6 嚴重度加權：critical -10、minor -3、info 0（上限 -50）；其餘扣分項不變。',
      });
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
    gated('get_web_vitals', async (args) => {
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
    gated('analyze_element', async (args) => {
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
    gated('get_browser_errors', async (args) => {
      const r = await link.send('get_browser_errors', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      // PM-350：在 bridge 這一層統一標 severity（三條錯誤來源共用同一套規則）
      const d = (r.data ?? {}) as Record<string, unknown>;
      return txt({
        ...d,
        console_errors: decorate((d.console_errors ?? []) as Array<Record<string, unknown>>, (e) => ({
          level: e.level as string, message: e.message as string, source: e.source as string,
        })),
        network_errors: decorate((d.network_errors ?? []) as Array<Record<string, unknown>>, (e) => ({
          status: e.status as number, url: e.url as string, message: `${String(e.method)} ${String(e.url)} → ${String(e.status)}`,
        })),
      });
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
    gated('take_screenshot', async (args) => {
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
    gated('type_text', async (args) => {
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
    gated('read_page', async (args) => {
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
    gated('pin_element', async (args) => {
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
    gated('pin_analyze', async (args) => {
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
    gated('get_pin_results', async (args) => {
      const r = await link.send('get_pin_results', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  // ── 工具 31~37：嚴重度／自動偵測／關聯診斷（PM-350~353，Phase 5）─────────
  server.tool(
    'get_error_summary',
    'Group the current page errors by severity (§6 rules, plus any custom rules you added). Use this to decide what to fix first instead of reading every error. Errors matched by an "ignore" rule are excluded entirely. 依嚴重度分組當前分頁的錯誤（§6 規則 + 你自訂的規則），用來決定「先修哪一個」而不必逐條讀。被 ignore 規則命中的錯誤完全不會出現。',
    { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
    gated('get_error_summary', async (args) => {
      const r = await link.send('get_browser_errors', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      const d = (r.data ?? {}) as Record<string, unknown>;
      const cons = decorate((d.console_errors ?? []) as Array<Record<string, unknown>>, (e) => ({
        level: e.level as string, message: e.message as string, source: e.source as string,
      }));
      const nets = decorate((d.network_errors ?? []) as Array<Record<string, unknown>>, (e) => ({
        status: e.status as number, url: e.url as string,
      }));
      const all = [
        ...cons.map((e) => ({ type: 'console', message: e.message, source: e.source, severity: e.severity })),
        ...nets.map((e) => ({ type: 'network', message: `${String(e.method)} ${String(e.url)} → ${String(e.status)}`, source: 'network', severity: e.severity })),
      ];
      const counts = { critical: 0, minor: 0, info: 0 };
      for (const e of all) counts[e.severity as 'critical' | 'minor' | 'info']++;
      return txt({
        critical: all.filter((e) => e.severity === 'critical'),
        minor: all.filter((e) => e.severity === 'minor'),
        info_count: counts.info,
        summary: severitySummary(counts),
        window_seconds: d.window_seconds ?? 30,
        note: '只涵蓋最近 30 秒（同 get_browser_errors）。空的結果代表「最近沒出事」，不一定是「沒有問題」。',
      });
    }),
  );

  server.tool(
    'add_severity_rule',
    'Add a custom severity rule that overrides the built-in §6 classification — e.g. treat 404s under /api/ as critical, or downgrade "deprecated" warnings to info. Use severity "ignore" to drop matching errors entirely. Rules live in memory and are lost when the bridge restarts. 新增自訂嚴重度規則，優先於內建的 §6 判定 —— 例如把 /api/ 的 404 升為 critical、把含 deprecated 的警告降為 info。severity 設 ignore 可讓命中的錯誤完全不出現。**規則存在記憶體，bridge 重啟即消失。**',
    {
      pattern: z.string().min(1).describe('要比對的字串或正規表示式。'),
      match_type: z.enum(['contains', 'starts_with', 'regex']).describe('比對方式。'),
      target_field: z.enum(['message', 'url', 'source']).describe('比對哪個欄位。'),
      severity: z.enum(['critical', 'minor', 'info', 'ignore']).describe('命中後要指定的嚴重度；ignore = 完全濾掉。'),
      description: z.string().optional().describe('這條規則的用途，方便日後回顧。'),
    },
    gated('add_severity_rule', async (args) =>
      txt(
        addSeverityRule({
          pattern: args.pattern,
          match_type: args.match_type,
          target_field: args.target_field,
          severity: args.severity,
          description: args.description,
        }),
      ),
    ),
  );

  server.tool(
    'list_severity_rules',
    'List all custom severity rules currently in effect. 列出目前生效的所有自訂嚴重度規則。',
    {},
    gated('list_severity_rules', async () => {
      const rules = listSeverityRules();
      return txt({
        rules,
        total_count: rules.length,
        ...(rules.length === 0 ? { note: '目前沒有自訂規則，全部使用 §6 的內建判定。' } : {}),
      });
    }),
  );

  server.tool(
    'remove_severity_rule',
    'Remove a custom severity rule; matching errors go back to the built-in §6 classification. 移除自訂嚴重度規則，命中的錯誤會回到 §6 的內建判定。',
    { rule_id: z.string().min(1).describe('要移除的規則 id（來自 add_severity_rule 或 list_severity_rules）。') },
    gated('remove_severity_rule', async (args) => {
      const ok = removeSeverityRule(args.rule_id);
      if (!ok) return txt({ error: `找不到規則 ${args.rule_id}`, available: listSeverityRules().map((r) => r.rule_id) });
      return txt({ removed: true, rule_id: args.rule_id, remaining: listSeverityRules().length });
    }),
  );

  server.tool(
    'start_auto_detect',
    'Run a full page sweep in one call: map zones, collect errors, read Core Web Vitals, compute zone health, and (in full mode) analyse every unhealthy zone. This is orchestration only — it adds no new detection, it just saves you many round trips. Then read the result with get_detect_report. 一次呼叫跑完整輪掃描：分區 → 收錯誤 → 讀效能 → 算區域健康 →（full 模式）逐一分析有問題的區域。**這只是編排，不新增偵測能力**，省的是多輪往返。結果用 get_detect_report 取。',
    {
      depth: z.enum(['quick', 'full']).optional().describe("'quick'（預設）跳過逐區深入分析；'full' 會對每個非健康區域再跑 analyze_element。"),
      tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。'),
    },
    gated('start_auto_detect', async (args) => {
      // full 模式屬於 §2 的「AI 自動化 debug」= Max；quick 模式 Pro 就能用。
      // 同一支工具因參數落在不同方案，所以要在這裡再擋一次，不能只靠 TOOL_TIER_MAP。
      const depth = args.depth ?? 'quick';
      const reject = tierGateReject('start_auto_detect（full 模式）', autoDetectTier(depth));
      if (reject) return txt({ error: reject, tier_gate: true, tool: 'start_auto_detect', depth });
      return txt(await startAutoDetect(link, args.tab_id, depth));
    }),
  );

  server.tool(
    'get_detect_report',
    'Read the result of a previous start_auto_detect: severity summary, per-zone status, critical errors, vitals, a score, and which elements are worth pinning. 讀取先前 start_auto_detect 的結果：嚴重度摘要、各區狀態、critical 錯誤、效能指標、分數，以及值得釘選深入看的元素。',
    { detect_id: z.string().optional().describe('省略 → 最近一次偵測。') },
    gated('get_detect_report', async (args) => txt(getDetectReport(args.detect_id))),
  );

  server.tool(
    'correlate_errors',
    'Pair frontend network failures with backend crashes by timestamp and URL path, so a 500 in the browser can be linked to the actual exception in your server logs. Requires start_terminal_monitor to be running for the backend side; unmatched items on both sides are counted, never dropped. 依時間戳與 URL path 配對前端網路錯誤與後端崩潰，讓瀏覽器看到的 500 能對上伺服器日誌裡真正的例外。後端需要先用 start_terminal_monitor 監控；**兩邊未配對的都會計數，不會被丟掉**。',
    {
      time_window_seconds: z.number().optional().describe('配對時間窗口，預設 2 秒（超出窗口但在 3 倍內者標為 low confidence）。'),
      tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。'),
    },
    gated('correlate_errors', async (args) => txt(await correlateErrors(link, args.tab_id, args.time_window_seconds ?? 2))),
  );

  // ── 工具 23~30：Zone Grid（PM-341~346，規格書 §15）────────────────────────
  server.tool(
    'map_page_zones',
    'Split the page into semantic zones (header / nav / main / aside / footer / section / role / class-name heuristics) so errors can be given an ADDRESS instead of just "somewhere on the page". Elements that fall into no zone are counted in unassigned_count — that number is never hidden. Call this first; the other zone tools build on it. 依語意結構把頁面切成區域，讓錯誤有「地址」而不只是「頁面某處」。沒落進任何區域的頂層元素計入 unassigned_count（**永不隱藏**）。其他 zone 工具都建立在這支之上，請先呼叫它。',
    { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
    gated('map_page_zones', async (args) => {
      const r = await link.send('map_page_zones', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'get_zone_health',
    'Health status per zone (healthy / warning / error / unknown) with error counts, plus a separate "unassigned" bucket for errors that could not be located. IMPORTANT: a page where every zone is healthy can still be broken — always read unassigned. Each unhealthy zone carries a suggested_action you can act on directly. 各區域的健康狀態與錯誤數，另有獨立的 unassigned 統計（**無法定位的錯誤都在那裡，全綠不代表沒問題**）。有問題的區域會附上可直接執行的 suggested_action。',
    { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
    gated('get_zone_health', async (args) => {
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
    gated('get_zone_errors', async (args) => {
      const r = await link.send('get_zone_errors', { zone_id: args.zone_id, tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      const d = (r.data ?? {}) as Record<string, unknown>;
      if (!Array.isArray(d.errors)) return txt(d);
      return txt({
        ...d,
        errors: decorate(d.errors as Array<Record<string, unknown>>, (e) => ({
          level: e.level as string, message: e.message as string, source: e.source as string,
        })),
        network_fails: decorate((d.network_fails ?? []) as Array<Record<string, unknown>>, (e) => ({
          status: e.status as number, url: e.url as string, message: `${String(e.method)} ${String(e.url)} → ${String(e.status)}`,
        })),
      });
    }),
  );

  server.tool(
    'show_zone_overlay',
    'Show the zone grid overlay on the page: a translucent border per zone with its name and an error badge (red zones blink). 顯示頁面上的區域覆蓋層：每區一個半透明邊框，附名稱標籤與錯誤 badge（紅色區域會閃爍）。',
    { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
    gated('show_zone_overlay', async (args) => {
      const r = await link.send('show_zone_overlay', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'hide_zone_overlay',
    'Hide the zone grid overlay. 隱藏區域覆蓋層。',
    { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
    gated('hide_zone_overlay', async (args) => {
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
    gated('watch_zones', async (args) => {
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
    gated('get_zone_changes', async (args) => {
      const r = await link.send('get_zone_changes', { tab_id: args.tab_id });
      if (!r.ok) return txt({ error: r.error, extension_connected: link.connected });
      return txt(r.data);
    }),
  );

  server.tool(
    'stop_watching_zones',
    'Stop zone monitoring and report how long it ran and how many changes were seen. 停止區域監控，並回報監控時長與偵測到的變化總數。',
    { tab_id: z.number().int().optional().describe('省略 → 使用者當前分頁；指定 → 該分頁。') },
    gated('stop_watching_zones', async (args) => {
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
      gated(name, async (args) => {
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
    gated('patrol_pins', async (args) => {
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
    gated('remove_pin', async (args) => {
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
    gated('clear_pins', async (args) => {
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
    gated('start_terminal_monitor', async (args) => txt(startTerminalMonitor(args.command, args.cwd))),
  );

  server.tool(
    'get_terminal_live_errors',
    `Read backend errors captured from a monitored command. Covers the last ${TERMINAL_WINDOW_MS / 1000} seconds. Parsed tracebacks appear in "errors"; stderr that could not be parsed appears in "unparsed_stderr" — an empty "errors" list does NOT mean the process is healthy. 讀取被監控指令的後端錯誤，涵蓋最近 ${TERMINAL_WINDOW_MS / 1000} 秒。解析成功的 traceback 在 errors，解析不出結構的原文在 unparsed_stderr——**errors 為空不代表程式沒問題**。`,
    {
      monitor_id: z.string().optional().describe('省略 → 最近啟動的那個 monitor。'),
    },
    gated('get_terminal_live_errors', async (args) => {
      const d = getTerminalLiveErrors(args.monitor_id) as Record<string, unknown>;
      if (!Array.isArray(d.errors)) return txt(d);
      return txt({
        ...d,
        errors: decorate(d.errors as Array<Record<string, unknown>>, (e) => ({
          type: e.type as string, message: e.message as string, source: 'terminal',
        })),
      });
    }),
  );

  server.tool(
    'stop_terminal_monitor',
    `Stop a monitored command and its child processes. Up to ${MAX_MONITORS} commands can be monitored at once. 停止被監控的指令（連同子程序一起收）。同時最多監控 ${MAX_MONITORS} 個。`,
    {
      monitor_id: z.string().optional().describe('省略 → 最近啟動的那個 monitor。'),
    },
    gated('stop_terminal_monitor', async (args) => txt(stopTerminalMonitor(args.monitor_id))),
  );


  // ── 工具 38~50：§14 八層記憶矩陣（PM-355~360）────────────────────────────
  // 全部走本機檔案系統，**不經過 Extension**——記憶跟瀏覽器無關，沒開分頁也能用。
  server.tool(
    'memory_save',
    'Store a piece of knowledge into one of the seven local memory layers so future sessions do not have to re-derive it. Persists to .bugezy/ in the project root; nothing is uploaded and no source file is touched. 把一則知識存進本機七層記憶之一，讓之後的 session 不必重新推理。寫入專案根目錄的 .bugezy/，**不上傳、也不會動到任何原始碼**。',
    {
      layer: LAYER_ENUM.describe(LAYER_DESC),
      entry: z.object({
        topic: z.string().min(1).max(MAX_TOPIC_LEN).describe('主題／關鍵字，越具體越容易被 memory_get 精準取回。'),
        content: z.string().min(1).max(MAX_CONTENT_LEN).describe('記憶內容。L7 效能基準請寫成 "200 ms" 或 {"value":200,"unit":"ms"} 以便自動比對。'),
        tags: z.array(z.string().max(MAX_TOPIC_LEN)).max(MAX_TAGS).optional().describe('標籤，搜尋時權重 ×2。L6／L4 的規則可加 "regex:<樣式>" 讓 memory_audit／memory_biz_validate 能機器逐條檢查。'),
      }),
    },
    gated('memory_save', async (args) => {
      const layer = layerOrReject(args.layer);
      if (isReject(layer)) return txt(layer);
      return txt(memorySave(layer, args.entry));
    }),
  );

  server.tool(
    'memory_learn',
    'Shortcut for memory_save into L1: record a finished debug session (symptom / root cause / fix) so the same bug is solved instantly next time. Tags are extracted automatically. Call this once after you actually fix something. memory_save(L1) 的快捷版：把一次除錯的症狀／根因／修法記下來，下次遇到同樣的 bug 直接給解法。tags 自動萃取。**真的修好之後呼叫一次就好。**',
    {
      debug_session: z.object({
        symptom: z.string().min(1).describe('bug 的症狀，例如 "TypeError: Cannot read \'map\' of undefined"。'),
        fix: z.string().min(1).describe('實際有效的修法。'),
        root_cause: z.string().optional().describe('根本原因。'),
        related_files: z.array(z.string()).optional().describe('關鍵檔案，會一併存成 tags。'),
      }),
    },
    gated('memory_learn', async (args) => txt(memoryLearn(args.debug_session))),
  );

  server.tool(
    'memory_search',
    'Full-text search across memory layers. Topic hits weigh 3x, tag hits 2x, body hits 1x. Reading counts as a hit (hit_count and last_hit_at are updated) because eviction keeps whatever is still being matched. An empty result means nothing has been learned yet — not that the search failed. 跨層全文搜尋。topic 命中權重 ×3、tags ×2、內文 ×1。**讀取也算命中**（會更新 hit_count／last_hit_at），因為淘汰保留的是「還在被匹配」的記憶。空結果代表還沒學過，不是搜尋失敗。',
    {
      query: z.string().min(1).describe('搜尋關鍵字，可用空白分隔多個詞。'),
      layers: z.array(LAYER_ENUM).optional().describe('省略 → 搜尋全部七層。'),
      limit: z.number().int().positive().max(100).optional().describe('預設 10。'),
    },
    gated('memory_search', async (args) => {
      const bad = (args.layers ?? []).find((l) => l === 'L3');
      if (bad) return txt({ error: L3_MESSAGE });
      return txt(memorySearch(args.query, args.layers as Layer[] | undefined, args.limit ?? 10));
    }),
  );

  server.tool(
    'memory_get',
    'Exact-match lookup: return every entry in one layer whose topic equals the given string. Unlike memory_search this does NOT update hit_count — a targeted fetch is not evidence the memory is still useful. Use memory_search for fuzzy lookup. 精準提取：回傳指定層裡 topic **完全相等**的所有記憶。**不更新 hit_count**（精準提取不算使用頻率）。要模糊找請用 memory_search。',
    {
      layer: LAYER_ENUM.describe(LAYER_DESC),
      topic: z.string().min(1).describe('必須與存入時的 topic 完全相同（忽略大小寫與前後空白）。'),
    },
    gated('memory_get', async (args) => {
      const layer = layerOrReject(args.layer);
      if (isReject(layer)) return txt(layer);
      return txt(memoryGet(layer, args.topic));
    }),
  );

  server.tool(
    'memory_audit',
    'Security self-review against L6: scan the ADDED lines of a git diff for hardcoded secrets (built-in patterns) plus any L6 rule that declares a "regex:" tag. IMPORTANT: passed:true only means the machine-checkable rules passed — natural-language rules are returned in rules_needing_ai_review for you to judge yourself. Writes nothing. 依 L6 資安鐵律自我審查：掃 git diff 的**新增行**，比對內建機密樣式與 L6 中宣告 `regex:` 的規則。⚠ **passed:true 只代表「可機檢的部分」通過**，自然語言的鐵律會放在 rules_needing_ai_review 交還給你自己判讀。**不寫任何檔案。**',
    { code_diff: z.string().min(1).describe('git diff 格式的文字。只會檢查 + 開頭的新增行。') },
    gated('memory_audit', async (args) => txt(memoryAudit(args.code_diff))),
  );

  server.tool(
    'memory_perf_check',
    'Compare a measurement against the L7 baseline for the same metric name. Understands metric direction (ops/s higher is better, ms/MB lower is better) and refuses to compare across different units. Beyond ±10% counts as improved/degraded. Writes nothing — update the baseline yourself with memory_update so a bad run cannot silently become the new normal. 拿一次量測與 L7 中同名的效能基準比對。**會判斷方向**（ops/s 越大越好、ms/MB 越小越好），**單位不同則拒絕比較**。超出 ±10% 才算進步／衰退。**不寫檔**——要更新基準請自行呼叫 memory_update，免得一次量壞的數字默默變成新標準。',
    {
      metrics: z.object({
        name: z.string().min(1).describe("指標名稱，必須與 L7 基準的 topic 相同，例如 'API response time'。"),
        value: z.number(),
        unit: z.string().min(1).describe("單位，例如 'ms' / 'MB' / 'ops/s'。必須與基準一致才會比較。"),
      }),
    },
    gated('memory_perf_check', async (args) => txt(memoryPerfCheck(args.metrics))),
  );

  server.tool(
    'memory_biz_validate',
    'Validate an output against the L4 business rules. Rules tagged with "regex:" are checked mechanically; the rest are handed back in rules_needing_ai_review. valid:true does NOT mean the business logic is correct — it means nothing machine-checkable was violated. Writes nothing. 拿輸出比對 L4 商業規則。標了 `regex:` 的規則會被機器逐條檢查，其餘放進 rules_needing_ai_review 交還給你。⚠ **valid:true 不代表商業邏輯正確**，只代表沒有違反可機檢的部分。**不寫任何檔案。**',
    {
      output: z.object({
        context: z.string().min(1).describe("這是什麼情境的輸出，例如 'prize calculation'。"),
        result: z.unknown().describe('要驗證的輸出，物件或字串皆可。'),
        related_rules: z.array(z.string()).optional().describe('只比對 topic 含這些字的規則；省略 → 比對 L4 全部。'),
      }),
    },
    gated('memory_biz_validate', async (args) => txt(memoryBizValidate(args.output as { context: string; result: unknown; related_rules?: string[] }))),
  );

  server.tool(
    'memory_update',
    'Partially update one memory entry (topic / content / tags). Use this when a fix evolves — the memory should improve, not stay stuck on the first workaround. 部分更新一則記憶（topic／content／tags）。修法進化時用它覆蓋舊經驗——記憶要會進步，不該永遠停在最初級的解法。',
    {
      layer: LAYER_ENUM.describe(LAYER_DESC),
      id: z.string().min(1).describe('要更新的記憶 id，可用 memory_list 取得。'),
      entry: z.object({
        topic: z.string().max(MAX_TOPIC_LEN).optional(),
        content: z.string().max(MAX_CONTENT_LEN).optional(),
        tags: z.array(z.string().max(MAX_TOPIC_LEN)).max(MAX_TAGS).optional(),
      }).describe('只帶要改的欄位；沒帶的保持原樣。'),
    },
    gated('memory_update', async (args) => {
      const layer = layerOrReject(args.layer);
      if (isReject(layer)) return txt(layer);
      return txt(memoryUpdate(layer, args.id, args.entry));
    }),
  );

  server.tool(
    'memory_delete',
    'Delete one memory entry by id. A missing id is reported as an error rather than a silent success. 依 id 刪除單一記憶。**id 不存在會明確報錯**，不會默默回成功。',
    {
      layer: LAYER_ENUM.describe(LAYER_DESC),
      id: z.string().min(1),
    },
    gated('memory_delete', async (args) => {
      const layer = layerOrReject(args.layer);
      if (isReject(layer)) return txt(layer);
      return txt(memoryDelete(layer, args.id));
    }),
  );

  server.tool(
    'memory_list',
    'List the entries in one layer. content is truncated to 200 characters (content_preview) to save tokens — use memory_get or memory_search for the full text. 列出某一層的記憶。content 截斷到 200 字（content_preview）以省 token，要完整內容請用 memory_get 或 memory_search。',
    {
      layer: LAYER_ENUM.describe(LAYER_DESC),
      limit: z.number().int().positive().max(500).optional().describe('預設 50。'),
      sort_by: z.enum(['created_at', 'updated_at', 'last_hit_at', 'hit_count']).optional().describe("預設 'updated_at'，皆為由新到舊／由多到少。"),
    },
    gated('memory_list', async (args) => {
      const layer = layerOrReject(args.layer);
      if (isReject(layer)) return txt(layer);
      return txt(memoryList(layer, args.limit ?? 50, args.sort_by ?? 'updated_at'));
    }),
  );

  server.tool(
    'memory_clear',
    'Wipe an entire memory layer. Requires confirm: true — without it the call is refused and tells you how many entries would be lost. Irreversible; export first if unsure. 清空整層記憶。**必須帶 confirm: true**，否則直接拒絕並告訴你會損失幾條。無法復原，不確定就先 memory_export。',
    {
      layer: LAYER_ENUM.describe(LAYER_DESC),
      confirm: z.boolean().describe('必須明確傳 true 才會執行。這是防呆，不要自動帶。'),
    },
    gated('memory_clear', async (args) => {
      const layer = layerOrReject(args.layer);
      if (isReject(layer)) return txt(layer);
      return txt(memoryClear(layer, args.confirm));
    }),
  );

  server.tool(
    'memory_export',
    'Export memory layers to a single JSON backup for machine migration or handover. WARNING: the file contains L1 real filenames/fixes and L6 security rules, and it lands in the project root where .bugezy/.gitignore does not protect it — treat it like a credential file. 把記憶匯出成單一 JSON 備份，供換電腦或專案交接。⚠ **檔案含 L1 的真實檔名／修法與 L6 資安鐵律，且落在專案根目錄、不受 .bugezy/.gitignore 保護**——請比照憑證檔對待。',
    {
      layers: z.array(LAYER_ENUM).optional().describe('省略 → 匯出全部七層。'),
      path: z.string().optional().describe('省略 → 專案根目錄的 .bugezy-backup-YYYYMMDD.json。'),
    },
    gated('memory_export', async (args) => {
      const bad = (args.layers ?? []).find((l) => l === 'L3');
      if (bad) return txt({ error: L3_MESSAGE });
      return txt(memoryExport(args.layers as Layer[] | undefined, args.path));
    }),
  );

  server.tool(
    'memory_import',
    "Import a backup produced by memory_export. 'merge' keeps existing entries on id collision, 'overwrite' replaces them. Layers that are not local (e.g. L3, which lives in the cloud) are reported as ignored rather than written. Writes only into .bugezy/ — never your source code. 匯入 memory_export 產生的備份。id 相撞時 merge 保留既有、overwrite 覆蓋。**不屬於本機七層的資料（例如雲端的 L3）會被列為 ignored 而不是寫入。** 只寫 .bugezy/，不碰原始碼。",
    {
      path: z.string().min(1).describe('備份檔路徑。'),
      strategy: z.enum(['merge', 'overwrite']).optional().describe("預設 'merge'（同 id 跳過，只加新的）。"),
    },
    gated('memory_import', async (args) => txt(memoryImport(args.path, args.strategy ?? 'merge'))),
  );

  server.tool(
    'memory_stats',
    'Show where the .bugezy/ store lives, how many entries each layer holds, and the active config. Use this first if memory tools behave unexpectedly — a missing store is the usual cause. 顯示 .bugezy/ 的位置、各層筆數與生效中的設定。記憶工具行為不如預期時先看這個——最常見的原因是還沒建立 .bugezy/。',
    {},
    gated('memory_stats', async () => txt(memoryStats())),
  );

  return server;
}

export { TOOL_TIER_MAP };

