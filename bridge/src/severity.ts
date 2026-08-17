// PM-350／351：Bug 嚴重度分類（規格書 §6）+ 使用者自訂規則。
//
// 放在 bridge 而不是 content script，理由是**單一真相來源**：
// 瀏覽器錯誤、終端機錯誤、zone 錯誤三條路徑都要用同一套判定，
// 而終端機錯誤根本不經過瀏覽器 —— 規則只能放在三者的交會點，也就是 bridge。

export type Severity = 'critical' | 'minor' | 'info' | 'ignore';

/** 分類器吃的最小形狀；三條來源各自映射到這個介面。 */
export interface ClassifiableError {
  /** console 的 level（warn/error/info），終端機錯誤沒有 */
  level?: string;
  message?: string;
  /** 'console' / 'unhandledrejection' / 'resource-error' / 'web-vitals' / 'terminal' … */
  source?: string;
  /** 網路錯誤才有 */
  status?: number;
  url?: string;
  /** 解析出的錯誤型別（TypeError / KeyError …） */
  type?: string;
}

export interface SeverityRule {
  rule_id: string;
  pattern: string;
  match_type: 'contains' | 'starts_with' | 'regex';
  target_field: 'message' | 'url' | 'source';
  severity: Severity;
  description?: string;
}

// 使用者自訂規則：**bridge 記憶體內，重啟即清空**（卡片指定）。
// 未來要持久化再接設定檔；現在刻意不寫檔，避免在使用者機器上留下沒人記得的狀態。
const rules = new Map<string, SeverityRule>();
let ruleSeq = 0;

export function addSeverityRule(r: Omit<SeverityRule, 'rule_id'>): SeverityRule {
  const rule: SeverityRule = { ...r, rule_id: `rule${++ruleSeq}-${Date.now().toString(36)}` };
  rules.set(rule.rule_id, rule);
  return rule;
}
export function listSeverityRules(): SeverityRule[] {
  return [...rules.values()];
}
export function removeSeverityRule(ruleId: string): boolean {
  return rules.delete(ruleId);
}
/** 測試用：清空自訂規則。 */
export function _clearSeverityRules(): void {
  rules.clear();
  ruleSeq = 0;
}

function fieldValue(e: ClassifiableError, field: SeverityRule['target_field']): string {
  if (field === 'message') return e.message ?? '';
  if (field === 'url') return e.url ?? '';
  return e.source ?? '';
}

function ruleMatches(rule: SeverityRule, e: ClassifiableError): boolean {
  const v = fieldValue(e, rule.target_field);
  if (!v) return false;
  if (rule.match_type === 'contains') return v.includes(rule.pattern);
  if (rule.match_type === 'starts_with') return v.startsWith(rule.pattern);
  try {
    return new RegExp(rule.pattern).test(v);
  } catch {
    return false; // 使用者給了不合法的 regex → 當作沒命中，而不是讓整個分類炸掉
  }
}

/** §6 的內建規則。 */
function builtinSeverity(e: ClassifiableError): Severity {
  // 網路錯誤：5xx = server 壞了（critical）；4xx = 多半是找不到資源（minor）
  if (typeof e.status === 'number') return e.status >= 500 ? 'critical' : 'minor';

  const src = e.source ?? '';
  // 未處理的 Promise rejection / window.onerror → 一律 critical
  if (src === 'unhandledrejection' || src === 'window.onerror') return 'critical';
  // Web Vitals 超標屬效能問題，不是壞掉
  if (src === 'web-vitals') return e.level === 'warn' ? 'minor' : 'info';

  // 終端機解析出的錯誤型別，或 console 訊息裡的經典 JS 錯誤
  const text = `${e.type ?? ''} ${e.message ?? ''}`;
  if (/\b(TypeError|ReferenceError|SyntaxError|RangeError|Uncaught)\b/.test(text)) return 'critical';

  if (e.level === 'error') return 'critical';
  if (e.level === 'warn') return 'minor';
  if (e.level === 'info') return 'info';
  // 終端機錯誤沒有 level，但既然被解析成 traceback 就是真的錯誤
  return e.type ? 'critical' : 'info';
}

/**
 * 判定嚴重度。**自訂規則優先於內建規則**（卡片指定的優先順序）。
 * 回傳 'ignore' 代表呼叫端應該把這筆整個濾掉。
 */
export function classifySeverity(e: ClassifiableError): Severity {
  for (const rule of rules.values()) {
    if (ruleMatches(rule, e)) return rule.severity;
  }
  return builtinSeverity(e);
}

/** 依 severity 給分數權重（PM-350：critical -10、minor -3、info 0）。 */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 10,
  minor: 3,
  info: 0,
  ignore: 0,
};

/**
 * 幫一組錯誤標上 severity，並濾掉 'ignore'。
 * @param toClassifiable 把來源物件映射成分類器吃的形狀
 */
export function decorate<T extends object>(
  items: T[],
  toClassifiable: (x: T) => ClassifiableError,
): Array<T & { severity: Severity }> {
  const out: Array<T & { severity: Severity }> = [];
  for (const item of items) {
    const sev = classifySeverity(toClassifiable(item));
    if (sev === 'ignore') continue; // 使用者明確要求忽略 → 完全不出現在任何結果中
    out.push({ ...item, severity: sev });
  }
  return out;
}

/** 一句話摘要，例如「🔴 1 critical、🟡 2 minor」。 */
export function severitySummary(counts: { critical: number; minor: number; info: number }): string {
  const bits: string[] = [];
  if (counts.critical) bits.push(`🔴 ${counts.critical} critical`);
  if (counts.minor) bits.push(`🟡 ${counts.minor} minor`);
  if (!bits.length) return counts.info ? `⚪ 只有 ${counts.info} 筆 info，沒有錯誤` : '✅ 沒有錯誤';
  return bits.join('、') + (counts.info ? `（另有 ${counts.info} 筆 info）` : '');
}
