// PM-367 驗收：瀏覽器錯誤 PII 遮罩（純邏輯，直接載入編譯後的模組）
import { readFileSync } from 'node:fs';
import { maskBrowserError, maskUrl, maskConsoleEntry, maskNetworkEntry, maskErrorPayload } from './dist/pii-browser.js';
import { maskStderr } from './dist/vendor/pii-mask.js';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const OPENAI = 'sk-abcdefghijklmnopqrstuvwxyz012345';
const AWS = 'AKIAIOSFODNN7EXAMPLE';

console.log('\n=== ⓪ 需求 7：與 maskStderr 用同一組 regex pattern ===');
const sharedRaw = readFileSync('src/pii-browser.ts', 'utf8');
// 檢查「有沒有偷偷重寫共用樣式」時要**先去掉註解** —— 說明文字裡引用 pattern 是正常的，
// 真正要防的是可執行的重複宣告。
const shared = sharedRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
check('7 pii-browser 從 vendor/pii-mask import 共用 pattern（不是另抄一份）',
  /from '\.\/vendor\/pii-mask\.js'/.test(sharedRaw)
  && /TOKEN_PATTERNS/.test(shared) && /GENERAL_PII/.test(shared)
  && /DB_URI/.test(shared) && /ENV_SENSITIVE_KEYS/.test(shared));
check('7 pii-browser 沒有自己重寫 JWT／email 這類共用樣式',
  !/eyJ\[/.test(shared) && !/\[\\w\.-\]\+@/.test(shared), '疑似重複宣告了共用 pattern');
const vend = readFileSync('src/vendor/pii-mask.ts', 'utf8');
const cli = readFileSync('../cli/src/pii-mask.ts', 'utf8');
check('7 vendor 與 cli/src 仍逐字一致（改的是共用源頭，不是分叉）',
  vend.slice(vend.indexOf('// pii-mask.ts')) === cli, `vendor ${vend.length} vs cli ${cli.length}`);
check('7 maskStderr 輸出格式未被改動（終端機仍是 ***MASKED***）',
  maskStderr(`token ${JWT} here`).includes('***MASKED***')
  && !maskStderr(`token ${JWT} here`).includes('<masked:'),
  maskStderr(`token ${JWT} here`));

console.log('\n=== ① 需求 1：console 訊息遮罩 + 型別標籤 ===');
const m1 = maskBrowserError(`TypeError: token ${JWT} expired`);
check('1 JWT → <masked:JWT>', m1 === 'TypeError: token <masked:JWT> expired', m1);
check('  錯誤型別與上下文都保留（AI 仍判斷得出是什麼問題）', /^TypeError: token .* expired$/.test(m1), m1);
check('  OpenAI key → <masked:API_KEY>', maskBrowserError(`key=${OPENAI}`).includes('<masked:API_KEY>'), maskBrowserError(`key=${OPENAI}`));
check('  AWS key → <masked:API_KEY>', maskBrowserError(`id ${AWS}`) === 'id <masked:API_KEY>', maskBrowserError(`id ${AWS}`));
check('  Stripe sk_live → <masked:API_KEY>', maskBrowserError('sk_live_abcdefghij0123456789').includes('<masked:API_KEY>'));
check('  Bearer token → <masked:TOKEN>', maskBrowserError('Authorization: Bearer abcdefghijklmnopqrstuvwxyz').includes('<masked:TOKEN>'), maskBrowserError('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'));
check('  email → <masked:EMAIL>', maskBrowserError('user not found: fox@example.com') === 'user not found: <masked:EMAIL>', maskBrowserError('user not found: fox@example.com'));
check('  信用卡 → <masked:CARD>', maskBrowserError('card 4111 1111 1111 1111 declined').includes('<masked:CARD>'));
check('  台灣手機 → <masked:PHONE>', maskBrowserError('phone 0912345678').includes('<masked:PHONE>'));
check('  身分證 → <masked:ID>', maskBrowserError('id A123456789 invalid').includes('<masked:ID>'));
check('  DB 連線字串保 scheme+host、只遮帳密',
  (() => { const r = maskBrowserError('postgres://admin:hunter2@db.internal:5432/app failed'); return r.includes('db.internal') && !r.includes('hunter2'); })(),
  maskBrowserError('postgres://admin:hunter2@db.internal:5432/app failed'));
check('  env 賦值保留 KEY 名', maskBrowserError('JWT_SECRET=supersecretvalue').startsWith('JWT_SECRET='), maskBrowserError('JWT_SECRET=supersecretvalue'));

console.log('\n=== ② 需求 2：網址只遮 query 的敏感參數值 ===');
const u1 = maskUrl(`/api/cart?api_key=${OPENAI}`);
check('2 api_key=sk-... → <masked:API_KEY>，參數名保留', u1 === '/api/cart?api_key=<masked:API_KEY>', u1);
const u2 = maskUrl(`https://x.com/api/v1/orders?token=${JWT}&page=2`);
check('  多參數只遮敏感的那個', u2 === 'https://x.com/api/v1/orders?token=<masked:JWT>&page=2', u2);
check('  🔴 path 一個字元都沒變（correlate_errors 靠 path 配對）',
  u2.startsWith('https://x.com/api/v1/orders?'), u2);
check('  password 參數 → <masked:PASSWORD>', maskUrl('/login?password=hunter2') === '/login?password=<masked:PASSWORD>', maskUrl('/login?password=hunter2'));
check('  secret 參數 → <masked:SECRET>', maskUrl('/x?client_secret=abc123').includes('<masked:SECRET>'), maskUrl('/x?client_secret=abc123'));
check('  非敏感參數不動', maskUrl('/search?q=hello&page=2') === '/search?q=hello&page=2', maskUrl('/search?q=hello&page=2'));
check('  沒有 query 的網址完全不動', maskUrl('https://x.com/a/b/c') === 'https://x.com/a/b/c');
check('  參數名不敏感但值是 token 也會遮', maskUrl(`/cb?state=${JWT}`).includes('<masked:JWT>'), maskUrl(`/cb?state=${JWT}`));
check('  參數名不敏感但值是 email 也會遮', maskUrl('/u?contact=fox@example.com').includes('<masked:EMAIL>'), maskUrl('/u?contact=fox@example.com'));
check('  hash 原樣保留', maskUrl('/a?token=abcdefghijklmnop#section-2').endsWith('#section-2'), maskUrl('/a?token=abcdefghijklmnop#section-2'));
check('  空值參數不動', maskUrl('/a?token=&b=1') === '/a?token=&b=1', maskUrl('/a?token=&b=1'));

console.log('\n=== ③ 需求 3：普通錯誤訊息不動 ===');
for (const plain of [
  "TypeError: Cannot read 'map' of undefined at cart.js:42",
  'ReferenceError: cartTotal is not defined',
  'Failed to load resource: the server responded with a status of 404 (Not Found)',
  'Uncaught (in promise) Error: Network request failed',
]) {
  check(`3 不動：${plain.slice(0, 42)}…`, maskBrowserError(plain) === plain, maskBrowserError(plain));
}
check('  版本號不會被誤判成信用卡或身分證', maskBrowserError('react@18.2.0 loaded in 1234 ms') === 'react@18.2.0 loaded in 1234 ms', maskBrowserError('react@18.2.0 loaded in 1234 ms'));
check('  堆疊行號不動', maskBrowserError('    at foo (bundle.js:1234:56)') === '    at foo (bundle.js:1234:56)');

console.log('\n=== ④ 需求 4：BugEzy 自己產生的欄位不動 ===');
const consoleEntry = {
  level: 'error', message: `Auth failed for fox@example.com token ${JWT}`,
  source: 'window.onerror', elementSelector: '#login-form > button.submit',
  severity: 'critical', timestamp: 123, line: 42,
};
const mc = maskConsoleEntry(consoleEntry);
check('4 message 有遮', mc.message.includes('<masked:EMAIL>') && mc.message.includes('<masked:JWT>'), mc.message);
check('4 elementSelector 不動', mc.elementSelector === '#login-form > button.submit');
check('4 level / source / severity / line / timestamp 全不動',
  mc.level === 'error' && mc.source === 'window.onerror' && mc.severity === 'critical' && mc.line === 42 && mc.timestamp === 123,
  JSON.stringify(mc));

const netEntry = { method: 'POST', url: `/api/cart?api_key=${OPENAI}`, status: 500, severity: 'critical', elementSelector: '#cart' };
const mn = maskNetworkEntry(netEntry);
check('4 url 的 query 有遮、其餘欄位不動',
  mn.url === '/api/cart?api_key=<masked:API_KEY>' && mn.method === 'POST' && mn.status === 500
  && mn.severity === 'critical' && mn.elementSelector === '#cart',
  JSON.stringify(mn));

const payload = maskErrorPayload({
  console_errors: [consoleEntry], network_errors: [netEntry],
  window_seconds: 30, zone_id: 'zone-cart', tag: 'section',
});
check('4 zone_id / tag / window_seconds 不動',
  payload.zone_id === 'zone-cart' && payload.tag === 'section' && payload.window_seconds === 30);
check('4 payload 內兩個陣列都有遮',
  payload.console_errors[0].message.includes('<masked:') && payload.network_errors[0].url.includes('<masked:'));
check('  errors 單一陣列形狀（get_zone_errors）也吃得到',
  maskErrorPayload({ errors: [consoleEntry, netEntry] }).errors.every((e) =>
    JSON.stringify(e).includes('<masked:')));
check('  沒有這些欄位時原樣回傳，不炸掉', JSON.stringify(maskErrorPayload({ a: 1 })) === '{"a":1}');

console.log('\n=== ⑤ 需求 5：遮罩後 AI 仍判斷得出類型與位置 ===');
const real = maskConsoleEntry({
  level: 'error',
  message: `TypeError: Cannot read 'email' of undefined — user fox@example.com, token ${JWT} at checkout.js:88`,
  elementSelector: '#checkout > form', source: 'window.onerror',
});
check('5 錯誤型別保留（TypeError）', real.message.includes('TypeError'), real.message);
check('5 檔名行號保留（checkout.js:88）', real.message.includes('checkout.js:88'), real.message);
check('5 屬性名保留（\'email\'）', real.message.includes("'email'"), real.message);
check('5 位置保留（elementSelector）', real.elementSelector === '#checkout > form');
check('5 🔴 型別標籤讓 AI 知道被遮的是什麼，而不是一坨 ***',
  real.message.includes('<masked:EMAIL>') && real.message.includes('<masked:JWT>')
  && !real.message.includes('***'), real.message);
check('5 敏感值本身完全不在輸出裡',
  !real.message.includes('fox@example.com') && !real.message.includes(JWT), real.message);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
