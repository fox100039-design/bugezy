// PM-350~353 驗收：嚴重度分類、自訂規則、關聯診斷（純邏輯，直接載入編譯後的模組）
import {
  classifySeverity, addSeverityRule, listSeverityRules, removeSeverityRule,
  _clearSeverityRules, decorate, severitySummary, SEVERITY_WEIGHT,
} from './dist/severity.js';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };

console.log('\n=== ① PM-350 §6 內建分級 ===');
const C = [
  ['TypeError → critical', { level: 'error', message: "TypeError: Cannot read 'map' of undefined" }, 'critical'],
  ['ReferenceError → critical', { level: 'error', message: 'ReferenceError: x is not defined' }, 'critical'],
  ['unhandledrejection → critical', { source: 'unhandledrejection', message: 'boom' }, 'critical'],
  ['console.warn → minor', { level: 'warn', message: '有點怪' }, 'minor'],
  ['console.info → info', { level: 'info', message: 'FYI' }, 'info'],
  ['Network 500 → critical', { status: 500, url: '/api/cart' }, 'critical'],
  ['Network 503 → critical', { status: 503, url: '/api/x' }, 'critical'],
  ['Network 404 → minor', { status: 404, url: '/img/a.png' }, 'minor'],
  ['Network 401 → minor', { status: 401, url: '/api/me' }, 'minor'],
  ['Web Vitals warn → minor', { source: 'web-vitals', level: 'warn', message: 'LCP 慢' }, 'minor'],
  ['Web Vitals info → info', { source: 'web-vitals', level: 'info', message: 'LCP 良好' }, 'info'],
  ['終端機 traceback（無 level）→ critical', { type: 'KeyError', message: "'id'", source: 'terminal' }, 'critical'],
];
for (const [label, err, want] of C) {
  const got = classifySeverity(err);
  check(`${label}`, got === want, `得到 ${got}`);
}
check('權重 critical 10 / minor 3 / info 0',
  SEVERITY_WEIGHT.critical === 10 && SEVERITY_WEIGHT.minor === 3 && SEVERITY_WEIGHT.info === 0);

console.log('\n=== ② PM-351 自訂規則 ===');
_clearSeverityRules();
const r1 = addSeverityRule({ pattern: '/api/', match_type: 'contains', target_field: 'url', severity: 'critical', description: 'API 的 404 也算嚴重' });
check('351-1 /api/ 的 404 升級為 critical', classifySeverity({ status: 404, url: '/api/cart' }) === 'critical', classifySeverity({ status: 404, url: '/api/cart' }));
check('351-1 非 /api/ 的 404 仍是 minor', classifySeverity({ status: 404, url: '/img/a.png' }) === 'minor');
const r2 = addSeverityRule({ pattern: 'deprecated', match_type: 'contains', target_field: 'message', severity: 'info' });
check('351-2 含 deprecated 的 warn 降級為 info', classifySeverity({ level: 'warn', message: 'X is deprecated' }) === 'info');
check('351-2 其他 warn 不受影響', classifySeverity({ level: 'warn', message: '一般警告' }) === 'minor');
check('351-3 list_severity_rules 列出兩條', listSeverityRules().length === 2, String(listSeverityRules().length));
check('   規則優先於內建（critical 覆蓋 minor）', classifySeverity({ status: 404, url: '/api/x' }) === 'critical');

const r3 = addSeverityRule({ pattern: '^noise:', match_type: 'regex', target_field: 'message', severity: 'ignore' });
check('351-5 ignore 的錯誤被完全濾掉',
  decorate([{ level: 'error', message: 'noise: 不要看我' }, { level: 'error', message: '真的錯誤' }],
    (e) => ({ level: e.level, message: e.message })).length === 1);
check('   非法 regex 不會炸掉分類', (() => {
  addSeverityRule({ pattern: '([', match_type: 'regex', target_field: 'message', severity: 'critical' });
  try { classifySeverity({ level: 'warn', message: 'x' }); return true; } catch { return false; }
})());

check('351-4 remove 後恢復內建行為', (() => {
  removeSeverityRule(r1.rule_id);
  return classifySeverity({ status: 404, url: '/api/cart' }) === 'minor';
})(), classifySeverity({ status: 404, url: '/api/cart' }));
check('   remove 不存在的規則 → false', removeSeverityRule('nope') === false);
_clearSeverityRules();
check('   清空後回內建判定', classifySeverity({ level: 'warn', message: 'X is deprecated' }) === 'minor');

console.log('\n=== ③ severitySummary ===');
check('有 critical+minor → 一句話含兩者', /1 critical/.test(severitySummary({ critical: 1, minor: 2, info: 0 })) && /2 minor/.test(severitySummary({ critical: 1, minor: 2, info: 0 })));
check('全零 → 明說沒有錯誤', /沒有錯誤/.test(severitySummary({ critical: 0, minor: 0, info: 0 })));
check('只有 info → 不謊報為錯誤', /沒有錯誤/.test(severitySummary({ critical: 0, minor: 0, info: 3 })), severitySummary({ critical: 0, minor: 0, info: 3 }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
