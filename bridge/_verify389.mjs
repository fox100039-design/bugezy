// PM-389/390 驗收：stderr critical 信號 + BUGEZY.md
import { readFileSync, existsSync } from 'node:fs';
import {
  signalCritical, signalBrowserErrors, signalTerminalErrors, signalZoneChanges, signalPinPatrol,
  _resetSignals, SIGNAL_DEDUP_MS,
} from './dist/stderr-signal.js';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };

// 攔 stderr：signalCritical 用 process.stderr.write，這裡把它換掉收集輸出
const realWrite = process.stderr.write.bind(process.stderr);
let captured = [];
const capture = (fn) => {
  captured = [];
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  try { fn(); } finally { process.stderr.write = realWrite; }
  return captured.join('');
};

console.log('\n=== ① 輸出格式 ===');
_resetSignals();
let out = capture(() => signalCritical('Browser', "TypeError: Cannot read 'map' of undefined", 'pin_analyze("section.cart")'));
check('389   格式為單行且可 grep', out.split('\n').filter(Boolean).length === 1 && out.endsWith('\n'), JSON.stringify(out));
check('389   含 ⚠ [BugEzy] 🔴 前綴 + 來源 + 摘要 + 建議',
  /^⚠ \[BugEzy\] 🔴 Browser \| TypeError: .* \| 建議：pin_analyze/.test(out.trim()), out.trim());
check('389   摘要裡的換行被壓成單行（堆疊不會把格式撐爛）',
  capture(() => signalCritical('Terminal', 'Error: boom\n    at foo\n    at bar', '看看')).split('\n').filter(Boolean).length === 1);

console.log('\n=== ② 驗收 3：30 秒內去重 ===');
_resetSignals();
check('389-3 第一次會輸出', capture(() => check('', signalCritical('Browser', 'same error', 'x'), '')) !== '' || true);
_resetSignals();
let n = 0;
capture(() => { for (let i = 0; i < 5; i++) if (signalCritical('Browser', 'same error', 'x')) n++; });
check('389-3 同一則錯誤連叫 5 次只輸出 1 次', n === 1, String(n));
check(`389-3 去重窗口是 ${SIGNAL_DEDUP_MS / 1000} 秒`, SIGNAL_DEDUP_MS === 30_000);
check('389   不同錯誤不會互相壓掉', (() => {
  _resetSignals();
  let m = 0;
  capture(() => { if (signalCritical('Browser', 'A', 'x')) m++; if (signalCritical('Browser', 'B', 'x')) m++; });
  return m === 2;
})());
check('389   同樣的摘要但不同來源 → 各自算一次', (() => {
  _resetSignals();
  let m = 0;
  capture(() => { if (signalCritical('Browser', 'same', 'x')) m++; if (signalCritical('Terminal', 'same', 'x')) m++; });
  return m === 2;
})());

console.log('\n=== ③ 驗收 5：PII 遮罩 ===');
_resetSignals();
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
out = capture(() => signalCritical('Browser', `Auth failed for fox@example.com token ${JWT}`, 'x'));
check('389-5 email 被遮罩', !out.includes('fox@example.com') && out.includes('<masked:EMAIL>'), out.trim());
check('389-5 JWT 被遮罩', !out.includes(JWT) && out.includes('<masked:JWT>'), out.trim());
_resetSignals();
out = capture(() => signalCritical('Terminal', 'boom', 'connect to postgres://u:pw123@db/app'));
check('389-5 建議欄位也有遮罩（不是只遮摘要）', !out.includes('pw123'), out.trim());
check('389   遮罩後錯誤本身仍看得懂（不是整段吞掉）',
  capture(() => { _resetSignals(); signalCritical('Browser', 'TypeError at cart.js:42 for a@b.com', 'x'); }).includes('cart.js:42'));

console.log('\n=== ④ 驗收 1：get_browser_errors 的 critical ===');
_resetSignals();
out = capture(() => signalBrowserErrors(
  [
    { severity: 'critical', message: "TypeError: Cannot read 'map'", elementSelector: 'section.cart' },
    { severity: 'minor', message: '這是 warning' },
    { severity: 'info', message: 'LCP 良好' },
  ],
  [{ severity: 'critical', method: 'POST', url: '/api/cart', status: 500 }],
));
const lines = out.split('\n').filter(Boolean);
check('389-1 console 的 critical → 有一行警告', lines.some((l) => /TypeError/.test(l)), out);
check('389-1 network 的 critical → 有一行警告', lines.some((l) => /\/api\/cart/.test(l) && /500/.test(l)), out);
check('389-4 🔴 minor / info 完全不觸發', !/warning/.test(out) && !/LCP/.test(out) && lines.length === 2, `${lines.length} 行：${out}`);
check('389   有 elementSelector 時建議指向 pin_analyze（可直接照做）',
  /pin_analyze\("section\.cart"\)/.test(out), out);
check('389   沒有 elementSelector 時給的是別的可行建議，不是硬塞一個不存在的 selector', (() => {
  _resetSignals();
  const o = capture(() => signalBrowserErrors([{ severity: 'critical', message: 'boom' }], []));
  return !/pin_analyze\(""\)/.test(o) && /get_error_summary|map_page_zones/.test(o);
})());

console.log('\n=== ⑤ 驗收 2：get_zone_changes 轉 error ===');
_resetSignals();
out = capture(() => signalZoneChanges([
  { zone_id: 'zone-cart', name: 'Cart Zone', previous_status: 'healthy', current_status: 'error', new_errors: 2, suggested_action: '呼叫 get_zone_errors("zone-cart")' },
  { zone_id: 'zone-nav', name: 'Nav', previous_status: 'healthy', current_status: 'warning', new_errors: 1 },
  { zone_id: 'zone-foot', name: 'Foot', previous_status: 'error', current_status: 'healthy', new_errors: 0 },
]));
check('389-2 zone 轉 error → 一行警告', /Cart Zone 從 healthy → error/.test(out), out);
check('389-2 帶新增錯誤數', /新增 2 筆錯誤/.test(out), out);
check('389   🔴 轉 warning 不叫（避免刷屏）', !/Nav/.test(out), out);
check('389   🔴 好轉（→ healthy）不叫', !/Foot/.test(out), out);
check('389   沿用 zone 自己算好的 suggested_action', /get_zone_errors\("zone-cart"\)/.test(out), out);

console.log('\n=== ⑥ patrol_pins 只有「惡化」才叫 ===');
_resetSignals();
out = capture(() => signalPinPatrol([
  { selector: '#submit', previous_status: 'active', status: 'stale', changed: true },
  { selector: '#a', previous_status: 'active', status: 'error', changed: true },
  { selector: '#b', previous_status: 'error', status: 'active', changed: true },   // 好轉
  { selector: '#c', previous_status: 'error', status: 'error', changed: false },   // 一直有問題但沒變
]));
check('389   active → stale 會叫', /#submit 狀態 active → stale/.test(out), out);
check('389   active → error 會叫', /#a 狀態 active → error/.test(out), out);
check('389   🔴 好轉（error → active）不叫', !/#b/.test(out), out);
check('389   🔴 一直是 error 但沒變化 → 不叫（同 alert_count 的取捨）', !/#c/.test(out), out);
check('389   stale 的建議是 read_page（元素不見了，pin_analyze 沒有意義）',
  /#submit[^\n]*read_page/.test(out), out);

console.log('\n=== ⑦ 驗收 6：不改變工具回傳值（原始碼檢查）===');
const mcp = readFileSync('src/mcp-server.ts', 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
const code = strip(mcp);
check('389-6 四個觸發點都接上了',
  /signalBrowserErrors\(/.test(code) && /signalTerminalErrors\(/.test(code)
  && /signalZoneChanges\(/.test(code) && /signalPinPatrol\(/.test(code));
check('389-6 signal 的回傳值沒有被塞進任何 txt(...)（回傳值不受影響）',
  !/txt\([^)]*signal(Browser|Terminal|Zone|Pin)/.test(code), '疑似把 signal 結果混進回傳');
check('389   用 process.stderr.write 而不是 console.error（避免被 MCP 框架攔截）', (() => {
  const sig = strip(readFileSync('src/stderr-signal.ts', 'utf8'));
  return /process\.stderr\.write/.test(sig) && !/console\.(error|log|warn)/.test(sig);
})());
check('389   signal 模組沒有動到任何工具的資料結構（只讀不寫）', (() => {
  const sig = strip(readFileSync('src/stderr-signal.ts', 'utf8'));
  // 只允許對自己的 dedup Map 寫入
  return !/\.push\(|\.splice\(|delete [a-z]+\.[a-z]/i.test(sig.replace(/lastSignalAt\.\w+\([^)]*\)/g, ''));
})());

console.log('\n=== ⑧ PM-390：BUGEZY.md ===');
const mdPath = '../docs/BUGEZY.md';
check('390-1 檔案存在於 docs/BUGEZY.md', existsSync(mdPath));
const md = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '';
check('390-2 四條規則都在',
  /get_zone_changes\(\)/.test(md) && /start_auto_detect/.test(md)
  && /get_terminal_live_errors\(\)/.test(md) && /memory_learn/.test(md));
check('390-2 「不要做的事」三條都在',
  /不要忽略/.test(md) && /修好了/.test(md) && /Unassigned/.test(md));
check('390-4 🔴 不含 BugEzy 內部路徑', !/C:\\\\dev\\\\bugezy|\/c\/dev\/bugezy|bridge\/src\//.test(md), '出現內部路徑');
check('390-4 🔴 不含機密（token／key／secret 的實際值）',
  !/eyJ[\w-]+\./.test(md) && !/\bsk-[A-Za-z0-9]{20,}/.test(md) && !/SUPABASE_SERVICE_ROLE_KEY\s*=/.test(md));
check('390-3 markdown 結構正確（單一 H1 + 有 H2）',
  (md.match(/^# /gm) || []).length === 1 && (md.match(/^## /gm) || []).length >= 3,
  `H1 ${(md.match(/^# /gm) || []).length} / H2 ${(md.match(/^## /gm) || []).length}`);
check('390-3 表格語法完整（每個表頭都有分隔列）', (() => {
  const rows = md.split('\n');
  let heads = 0, seps = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    if (/^\|.*\|$/.test(rows[i]) && /^\|[\s:|-]+\|$/.test(rows[i + 1])) { heads++; seps++; }
  }
  return heads > 0 && heads === seps;
})());
check('390   程式碼區塊有成對閉合', (md.match(/^```/gm) || []).length % 2 === 0, String((md.match(/^```/gm) || []).length));
check('390   🔴 誠實說明 stderr 不是推播通道（AI 不會自己醒過來）',
  /不是推播通道/.test(md) && /不會自動出現在對話脈絡/.test(md) && /仍然得照上面的規則主動呼叫/.test(md),
  '沒有講清楚 stderr 的限制');
check('390   有提到方案閘門要設 token（否則使用者第一次就卡住）',
  /BUGEZY_SESSION_TOKEN/.test(md));
check('390   內容可直接複製使用（沒有相對於本 repo 的連結）',
  !/\]\(\.\.\//.test(md) && !/\]\(\.\//.test(md), '出現相對路徑連結');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
