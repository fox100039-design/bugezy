// PM-369~378 驗收：路徑正規化、限長、regex 守衛、壞編碼、語音路徑移除、checkout DOM 建構
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { memoryExport, memoryImport, memorySave } from './dist/memory-ops.js';
import { _resetStore, ensureStore } from './dist/memory-store.js';
import { maskBrowserError, maskUrl, MAX_MESSAGE_LEN, MAX_URL_LEN } from './dist/pii-browser.js';
import { maskStderr } from './dist/vendor/pii-mask.js';
import { safeCompile, MAX_PATTERN_LEN } from './dist/regex-guard.js';
import { addSeverityRule, classifySeverity, _clearSeverityRules } from './dist/severity.js';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bugezy-p375-'));
const proj = path.join(tmp, 'proj');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
_resetStore(proj);
ensureStore();
memorySave('L1', { topic: 'seed', content: 'x' });

console.log('\n=== ① PM-370：匯出路徑用 realpath 正規化（symlink 擋得住）===');
let linkMade = false;
const link = path.join(proj, 'escape-link');
try {
  fs.symlinkSync(outside, link, 'junction'); // Windows 上目錄 symlink 需要權限，junction 不用
  linkMade = true;
} catch (e) {
  console.log('  SKIP  無法建立 junction（權限不足）：', String(e).slice(0, 80));
}
if (linkMade) {
  const via = memoryExport(['L1'], path.join(link, 'escaped.json'));
  check('370-1 🔴 專案內的 junction 指向專案外 → 被拒',
    !!via.error && !fs.existsSync(path.join(outside, 'escaped.json')), JSON.stringify(via).slice(0, 200));
  check('370   拒絕理由點出是解析後的真實路徑', /實際解析後是/.test(via.error || ''), String(via.error).slice(0, 160));
}
const normal = memoryExport(['L1'], path.join(proj, 'sub', 'ok-backup.json'));
check('370-2 正常專案內匯出照舊', !normal.error && fs.existsSync(normal.path), JSON.stringify(normal).slice(0, 140));

console.log('\n=== ② PM-371：匯入補路徑限制 + 錯誤訊息脫敏 ===');
const outFile = path.join(outside, 'backup.json');
fs.writeFileSync(outFile, JSON.stringify({ version: '1.0', layers: { L1: [] } }));
const outImp = memoryImport(outFile, 'merge');
check('371-1 🔴 指向專案外的檔案 → 被拒', !!outImp.error && /必須在專案目錄/.test(outImp.error), JSON.stringify(outImp).slice(0, 180));
if (linkMade) {
  check('371   透過 junction 繞出去也被拒', !!memoryImport(path.join(link, 'backup.json'), 'merge').error);
}
const badJson = path.join(proj, 'bad.json');
fs.writeFileSync(badJson, '{"secret":"hunter2-this-should-never-appear", oops');
const badImp = memoryImport(badJson, 'merge');
check('371-2 🔴 錯誤訊息不含檔案內容片段',
  !JSON.stringify(badImp).includes('hunter2') && !JSON.stringify(badImp).includes('oops'), JSON.stringify(badImp).slice(0, 200));
check('371-2 改回固定訊息', /不是合法 BugEzy 備份 JSON/.test(badImp.error || ''), String(badImp.error));
check('371-3 正常備份匯入照舊', !memoryImport(normal.path, 'merge').error, JSON.stringify(memoryImport(normal.path, 'merge')).slice(0, 140));

console.log('\n=== ③ PM-373：遮罩呼叫端限長（ReDoS 兜底）===');
// 特製的「差一點就是 email」超長字串：regex 會在這種輸入上大量回溯
const evil = 'a'.repeat(100_000) + '@';
for (const [label, fn, input] of [
  ['maskBrowserError', maskBrowserError, evil],
  ['maskUrl', maskUrl, `/x?token=${evil}`],
  ['maskStderr（終端機同樣受呼叫端保護）', maskStderr, evil.slice(0, 32_000)],
]) {
  const t0 = Date.now();
  fn(input);
  const ms = Date.now() - t0;
  check(`373-1 ${label} 100KB 惡意輸入在毫秒級完成（實測 ${ms}ms）`, ms < 1000, `${ms}ms`);
}
check('373   超長輸入會被截斷並標示', maskBrowserError('b'.repeat(MAX_MESSAGE_LEN + 10)).endsWith('...<truncated>'));
check('373   網址超長同樣截斷', maskUrl('c'.repeat(MAX_URL_LEN + 10)).endsWith('...<truncated>'));
check('373-2 🔴 正常長度輸入不截斷、遮罩行為不變',
  maskBrowserError('user fox@example.com failed') === 'user <masked:EMAIL> failed'
  && !maskBrowserError('short message').includes('truncated'),
  maskBrowserError('user fox@example.com failed'));
check('373-3 共用 regex 沒被動過（vendor 與 cli 仍逐字一致）',
  readFileSync('src/vendor/pii-mask.ts', 'utf8').slice(readFileSync('src/vendor/pii-mask.ts', 'utf8').indexOf('// pii-mask.ts'))
  === readFileSync('../cli/src/pii-mask.ts', 'utf8'));

console.log('\n=== ④ PM-375：自訂 regex 複雜度守衛 ===');
_clearSeverityRules();
for (const bad of ['(a+)+$', '(a*)*b', '(x+)*y', '(\\d+)+', '.*.*.*']) {
  const r = safeCompile(bad);
  check(`375-1 惡意 regex ${bad} 被拒`, !r.ok && !!r.error, JSON.stringify(r));
}
for (const good of ['/api/.*', '^https://', 'TypeError|ReferenceError', '\\bdeprecated\\b']) {
  check(`375-2 正常 regex ${good} 通過`, safeCompile(good).ok, JSON.stringify(safeCompile(good)));
}
check(`375   pattern 超過 ${MAX_PATTERN_LEN} 字元被拒`, !safeCompile('a'.repeat(MAX_PATTERN_LEN + 1)).ok);
check('375   不合法的 regex 仍回可讀原因', /不是合法的正規表示式/.test(safeCompile('([').error || ''), safeCompile('([').error);

const rejected = addSeverityRule({ pattern: '(a+)+$', match_type: 'regex', target_field: 'message', severity: 'critical' });
check('375-1 add_severity_rule 擋下惡意 regex 並回原因', !!rejected.error && !rejected.rule_id, JSON.stringify(rejected).slice(0, 180));
const accepted = addSeverityRule({ pattern: '/api/.*', match_type: 'regex', target_field: 'url', severity: 'critical' });
check('375-2 正常 regex 規則可新增且生效',
  !!accepted.rule_id && classifySeverity({ status: 404, url: '/api/cart' }) === 'critical', JSON.stringify(accepted).slice(0, 150));
check('375   contains 規則不受 regex 守衛影響',
  !!addSeverityRule({ pattern: '(a+)+$', match_type: 'contains', target_field: 'message', severity: 'info' }).rule_id);
_clearSeverityRules();

console.log('\n=== ⑤ PM-376：maskUrl 的 decodeURIComponent 壞編碼 ===');
for (const u of ['/x?token=%ZZ', '/x?api_key=%E0%A4%A', '/x?password=100%', '/x?secret=%']) {
  let out = null, threw = false;
  try { out = maskUrl(u); } catch { threw = true; }
  check(`376-1 壞編碼 ${u} 不拋錯且仍完成遮罩`, !threw && /<masked:/.test(out || ''), threw ? 'threw' : String(out));
}
check('376-2 正常 URL 行為不變', maskUrl('/x?api_key=abc123def456') === '/x?api_key=<masked:API_KEY>', maskUrl('/x?api_key=abc123def456'));

console.log('\n=== ⑥ PM-369：語音逐字稿不再經 MAIN world 中轉（原始碼靜態檢查）===');
const content = readFileSync('../extension/src/content.ts', 'utf8');
const inject = readFileSync('../extension/src/inject.ts', 'utf8');
const types = readFileSync('../extension/src/types.ts', 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
const cCode = stripComments(content), iCode = stripComments(inject), tCode = stripComments(types);
check('369-1 content 不再送 VOICE_HISTORY 給 inject', !/VOICE_HISTORY/.test(cCode), 'content.ts 仍有 VOICE_HISTORY');
check('369-1 inject 不再請求／處理 VOICE_HISTORY', !/VOICE_HISTORY/.test(iCode) && !/REQUEST_VOICE_HISTORY/.test(iCode));
check('369-1 型別也一併移除（避免日後被加回去）', !/VOICE_HISTORY/.test(tCode));
check('369-3 inject → content 的觀測資料流保留',
  /FLUSH_CONSOLE/.test(iCode) && /FLUSH_NETWORK/.test(iCode) && /FLUSH_RRWEB/.test(iCode) && /FLUSH_VOICE/.test(iCode));
check('369-4 content 仍轉發四種 FLUSH 給 background（錄製不退化）',
  /FLUSH_VOICE/.test(cCode) && /FLUSH_CONSOLE/.test(cCode) && /FLUSH_NETWORK/.test(cCode) && /FLUSH_RRWEB/.test(cCode));
check('369-3 🔴 所有 postMessage 都不再用 targetOrigin "*"',
  !/postMessage\([^)]*,\s*'\*'\s*\)/.test(cCode) && !/postMessage\([^)]*,\s*'\*'\s*\)/.test(iCode)
  && !/^\s*'\*',\s*$/m.test(cCode) && !/^\s*'\*',\s*$/m.test(iCode));
check('369   改用 "/"（同源限定）', /postMessage\(msg, '\/'\)/.test(cCode) && /postMessage\(msg, '\/'\)/.test(iCode));

console.log('\n=== ⑦ PM-378：checkout 不再對網路回應做 innerHTML ===');
const checkout = readFileSync('../extension/src/checkout.ts', 'utf8');
const dayPass = readFileSync('../extension/src/day-pass-checkout.ts', 'utf8');
const ecpay = readFileSync('../extension/src/ecpay-form.ts', 'utf8');
check('378-2 checkout.ts 不再有 innerHTML', !/innerHTML/.test(stripComments(checkout)));
check('378-2 day-pass-checkout.ts 不再有 innerHTML', !/innerHTML/.test(stripComments(dayPass)));
check('378   兩支都改用 parseEcpayForm + submitEcpayForm',
  /parseEcpayForm/.test(checkout) && /submitEcpayForm/.test(checkout)
  && /parseEcpayForm/.test(dayPass) && /submitEcpayForm/.test(dayPass));
check('378-1 表單以 createElement 重建（不帶入回應的任何屬性）',
  /createElement\('form'\)/.test(ecpay) && /createElement\('input'\)/.test(ecpay) && !/innerHTML/.test(stripComments(ecpay)));
check('378-3 🔴 只接受 https 的綠界網域當 action（目的地被換掉＝訂單資料送給別人）',
  /ecpay\\\.com\\\.tw/.test(ecpay) || /ecpay\\.com\\.tw/.test(ecpay), '沒有看到綠界網域白名單');
check('378   只挑 name/value，不複製任何事件處理器屬性',
  /getAttribute\('name'\)/.test(ecpay) && !/onerror/.test(stripComments(ecpay)));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
