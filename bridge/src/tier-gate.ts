// PM-362（Phase 6 PM-P）：方案分層。PM-321 的閘門雛形升級成「每支工具知道自己屬於哪個方案」。
//
// PM-374：**閘門已改為預設開啟**，方案來源也換掉了。
//   舊版：`ENFORCE_TIER_GATE=true` + `BUGEZY_USER_TIER=<tier>`（自由字串，等於誰都能自稱 agent）
//   現在：預設開啟；方案由 `BUGEZY_SESSION_TOKEN` 向 Workers 查回來，查不到一律 free。
//   要關閘門只能明確設 `ENFORCE_TIER_GATE=false`（保留逃生門，方便排除閘門因素）。
//
// ⚠ 這代表**沒設 token 的 bridge 只剩 ping / get_page_url 可用**。這是刻意的，
//   但升級後第一次啟動會很有感 —— 錯誤訊息因此一定要講清楚是「沒設 token」還是「真的沒訂閱」。

export type Tier = 'free' | 'ticket' | 'day_pass' | 'pro' | 'max' | 'agent';

/** 方案高低。ticket／day_pass 只含 v1 錄製，**不含任何 v2 工具**，所以排在 pro 之下。 */
const TIER_RANK: Record<Tier, number> = {
  free: 0,
  ticket: 1,
  day_pass: 1,
  pro: 2,
  max: 3,
  agent: 4,
};

export const TIER_LABEL: Record<Tier, string> = {
  free: 'Free（免費）',
  ticket: '票券',
  day_pass: '日票',
  pro: 'Pro NT$80/月',
  max: 'Max NT$200/月',
  agent: 'Agent NT$500/月',
};

export function tierRank(t: Tier): number {
  return TIER_RANK[t] ?? 0;
}

/**
 * 工具 → 最低方案。**必須涵蓋全部 51 支**，`_verify362` 會雙向比對註冊清單，
 * 新增工具卻忘了列進來會直接測試失敗（而不是默默套用預設值）。
 */
export const TOOL_TIER_MAP: Record<string, Tier> = {
  // ── 不擋（否則使用者無法排查「為什麼 bridge 不能用」）──────────────────
  ping: 'free',
  get_page_url: 'free',

  // ── v2 瀏覽器操作（11 支扣掉上面兩支 = 9）────────────────────────────────
  navigate_to: 'pro',
  click_element: 'pro',
  type_text: 'pro',
  read_page: 'pro',
  take_screenshot: 'pro',
  get_browser_errors: 'pro',
  analyze_element: 'pro',
  get_web_vitals: 'pro',
  get_page_health: 'pro',

  // ── 圖釘 6 ───────────────────────────────────────────────────────────────
  pin_element: 'pro',
  pin_analyze: 'pro',
  get_pin_results: 'pro',
  patrol_pins: 'pro',
  remove_pin: 'pro',
  clear_pins: 'pro',

  // ── Zone Grid 8 ──────────────────────────────────────────────────────────
  map_page_zones: 'pro',
  get_zone_health: 'pro',
  get_zone_errors: 'pro',
  show_zone_overlay: 'pro',
  hide_zone_overlay: 'pro',
  watch_zones: 'pro',
  get_zone_changes: 'pro',
  stop_watching_zones: 'pro',

  // ── 即時面板 2 ───────────────────────────────────────────────────────────
  show_debug_panel: 'pro',
  hide_debug_panel: 'pro',

  // ── 終端機監控 3 ─────────────────────────────────────────────────────────
  start_terminal_monitor: 'pro',
  get_terminal_live_errors: 'pro',
  stop_terminal_monitor: 'pro',

  // ── 嚴重度 + 自動化 7 ────────────────────────────────────────────────────
  get_error_summary: 'pro',
  add_severity_rule: 'pro',
  list_severity_rules: 'pro',
  remove_severity_rule: 'pro',
  // quick 模式 pro 就能用；**full 模式要 Max**（見 autoDetectTier）
  start_auto_detect: 'pro',
  get_detect_report: 'pro',
  correlate_errors: 'pro',

  // ── 記憶矩陣 14 ──────────────────────────────────────────────────────────
  memory_save: 'pro',
  memory_learn: 'pro',
  memory_search: 'pro',
  memory_get: 'pro',
  memory_audit: 'pro',
  memory_perf_check: 'pro',
  memory_biz_validate: 'pro',
  memory_update: 'pro',
  memory_delete: 'pro',
  memory_list: 'pro',
  memory_clear: 'pro',
  memory_export: 'pro',
  memory_import: 'pro',
  memory_stats: 'pro',
};

/** `start_auto_detect` 的方案依 depth 而定：quick = Pro、full = Max（§2 的「AI 自動化 debug」）。 */
export function autoDetectTier(depth: 'quick' | 'full'): Tier {
  return depth === 'full' ? 'max' : 'pro';
}

/**
 * PM-374：**閘門預設開啟**。不設 `ENFORCE_TIER_GATE` 就是開著；
 * 只有明確設成 `'false'` 才關（保留這個逃生門是為了讓人能在出事時快速排除閘門因素）。
 */
export function isGateEnabled(): boolean {
  return process.env.ENFORCE_TIER_GATE !== 'false';
}

// ── tier 來源：改為向 Workers 查，不再讀自由字串 ──────────────────────────
//
// 🔴 PM-374 拿掉了 `BUGEZY_USER_TIER`。原本任何人只要設一個環境變數就能宣稱自己是 agent，
//    等於閘門形同虛設。現在唯一的來源是 `BUGEZY_SESSION_TOKEN` 向 Workers 查回來的結果。
//
// ⚠ `BUGEZY_WORKERS_URL` **不是繞過閘門的後門**：它只決定「去哪裡問」，
//    問到什麼 tier 仍然由那一端決定，閘門照常執行。測試用它指向本機 mock。

const DEFAULT_WORKERS_URL = 'https://bugezy.dev';
/** 查回來的 tier 快取多久（毫秒）。太短會每次工具呼叫都打一次網路。 */
const TIER_TTL_MS = 5 * 60 * 1000;

let cachedTier: Tier = 'free';
let cachedAt = 0;
let lastResolveNote = '尚未查詢';

export function tierResolutionNote(): string {
  return lastResolveNote;
}

/** 把 Workers 的方案字串對應到 bridge 的 Tier。 */
function normalizeTier(raw: unknown): Tier {
  const t = String(raw ?? '').toLowerCase();
  if (t === 'pro' || t === 'paid' || t === 'cancelled') return 'pro';
  if (t === 'max') return 'max';
  if (t === 'agent') return 'agent';
  if (t === 'day_pass') return 'day_pass';
  if (t === 'ticket') return 'ticket';
  return 'free';
}

/**
 * 向 Workers 的 MCP `get_usage_quota` 查目前方案。
 *
 * **任何失敗都降級為 `free`**（查不到、token 無效、Workers 不可達、逾時）。
 * 反過來寫（失敗＝放行）會讓「把網路拔掉」變成解鎖所有功能的方法。
 */
export async function resolveTier(): Promise<Tier> {
  const now = Date.now();
  if (now - cachedAt < TIER_TTL_MS && cachedAt !== 0) return cachedTier;

  const token = process.env.BUGEZY_SESSION_TOKEN || '';
  const email = process.env.BUGEZY_USER_EMAIL || '';
  if (!token) {
    cachedTier = 'free';
    cachedAt = now;
    lastResolveNote =
      '未設定 BUGEZY_SESSION_TOKEN，視為 Free。請在 MCP 設定的 env 加入 BUGEZY_SESSION_TOKEN（可從 BugEzy 擴充功能的進階設定複製）與 BUGEZY_USER_EMAIL。';
    return cachedTier;
  }

  const base = (process.env.BUGEZY_WORKERS_URL || DEFAULT_WORKERS_URL).replace(/\/$/, '');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${base}/mcp?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_usage_quota', arguments: { user_email: email, session_token: token } },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    let text = await res.text();
    if (text.includes('data: ')) text = text.slice(text.indexOf('data: ') + 6);
    const payload = JSON.parse(text) as { result?: { content?: Array<{ text?: string }> } };
    const inner = payload.result?.content?.[0]?.text ?? '';
    const quota = JSON.parse(inner.split('\n\n---')[0]) as { tier?: string };
    cachedTier = normalizeTier(quota.tier);
    cachedAt = now;
    lastResolveNote = `已向 ${base} 查得方案：${cachedTier}`;
    return cachedTier;
  } catch (e) {
    cachedTier = 'free';
    cachedAt = now;
    lastResolveNote = `無法向 ${base} 查詢方案（${e instanceof Error ? e.message : String(e)}），已降級為 Free。離線時 v2 功能會被閘門擋下——這是刻意的，否則「把網路拔掉」就會變成解鎖手段。`;
    return cachedTier;
  }
}

/** 目前快取的方案。第一次查詢由 bridge 啟動時觸發（見 index.ts）。 */
export function currentTier(): Tier {
  return cachedTier;
}

/** 測試用：清掉快取，強制下次重新查詢。 */
export function _resetTierCache(): void {
  cachedTier = 'free';
  cachedAt = 0;
  lastResolveNote = '尚未查詢';
}

/**
 * 回傳 null＝放行；回傳字串＝拒絕原因。
 *
 * `requiredOverride` 給 `start_auto_detect` 這種「同一支工具、不同參數屬於不同方案」的情況用。
 * 沒列在表裡的工具一律當作 `pro`（**fail closed**）——新工具忘了分層時，寧可擋下來讓人發現，
 * 也不要默默放行成免費功能。
 */
export function tierGateReject(toolName: string, requiredOverride?: Tier): string | null {
  if (!isGateEnabled()) return null;
  const tier = currentTier();
  const required = requiredOverride ?? TOOL_TIER_MAP[toolName] ?? 'pro';
  if (tierRank(tier) >= tierRank(required)) return null;

  const extra =
    tier === 'ticket' || tier === 'day_pass'
      ? '票券／日票僅包含 v1 錄製功能，不含 v2 瀏覽器與記憶功能。'
      : '';
  // 把「為什麼被判成這個方案」一起講出來 —— 否則付費使用者被擋時完全不知道
  // 是「沒設 token」還是「真的沒訂閱」。
  return `${toolName} 需要 ${TIER_LABEL[required]}，你目前是 ${TIER_LABEL[tier]}。${extra}方案判定：${lastResolveNote} 升級請見 https://bugezy.dev/checkout`;
}
