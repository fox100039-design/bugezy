// PM-362（Phase 6 PM-P）：方案分層。PM-321 的閘門雛形升級成「每支工具知道自己屬於哪個方案」。
//
// ⚠ 預設仍然關閉。bridge 跑在本機、拿不到使用者真實的 tier，預設開啟只有兩種結果：
//   全放行（等於沒閘門）或全擋掉（工具不能用）。要啟用必須同時設
//   `ENFORCE_TIER_GATE=true` 與 `BUGEZY_USER_TIER=<tier>`。
//   接上 Workers、能查到真實 tier 之後才會改預設值。

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

export function isGateEnabled(): boolean {
  return process.env.ENFORCE_TIER_GATE === 'true';
}

export function currentTier(): Tier {
  const t = (process.env.BUGEZY_USER_TIER || 'free') as Tier;
  return t in TIER_RANK ? t : 'free';
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
  return `${toolName} 需要 ${TIER_LABEL[required]}，你目前是 ${TIER_LABEL[tier]}。${extra}升級請見 https://bugezy.dev/checkout`;
}
