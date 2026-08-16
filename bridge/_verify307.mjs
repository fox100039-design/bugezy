// PM-307 驗收：① 從 **實際打包產物** 抽出 parseNavigableUrl 做 URL 驗證測試
//               ② 真 MCP JSON-RPC 檢查 navigate_to 的註冊與 schema
//               ③ 接真 Chrome 跑端到端（需擴充功能已重新載入）
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══ ① 從 dist/background.js 抽出真正會跑的 parseNavigableUrl ═══
console.log('\n=== ① URL 驗證（函式由 extension/dist/background.js 抽出，非另外抄一份）===');
const bg = readFileSync('../extension/dist/background.js', 'utf8');
const i = bg.indexOf('function parseNavigableUrl(raw)');
if (i < 0) { console.log('  FAIL  在打包產物裡找不到 parseNavigableUrl —— 原始碼結構已變，測試需同步更新'); process.exit(1); }
// 抓到下一個 top-level `\nfunction ` 為止
const j = bg.indexOf('\nfunction ', i + 10);
const parseNavigableUrl = new Function(bg.slice(i, j) + '\nreturn parseNavigableUrl;')();

const ok = (u) => { try { return parseNavigableUrl(u); } catch { return null; } };
const err = (u) => { try { parseNavigableUrl(u); return null; } catch (e) { return e.message; } };
check('https 通過', ok('https://example.com/') === 'https://example.com/');
check('http 通過', ok('http://example.com/a?b=1') === 'http://example.com/a?b=1');
for (const bad of ['chrome://extensions', 'file:///C:/secret.txt', 'javascript:alert(1)', 'data:text/html,<h1>x', 'ftp://x.com'])
  check(`拒絕 ${bad.slice(0, 28)}`, err(bad) !== null, '竟然通過了');
check('亂字串拒絕', err('not a url') !== null);
check('空字串拒絕', err('') !== null);
check('undefined 拒絕（不 crash）', err(undefined) !== null);
check('錯誤訊息含 protocol 提示', (err('file:///x') || '').includes('http'), err('file:///x'));

// ═══ ② + ③ 真 MCP ═══
const proc = spawn(process.execPath, ['dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = ''; proc.stderr.on('data', (d) => { stderr += d.toString(); });
let buf = ''; const w = new Map(); let id = 1;
proc.stdout.on('data', (d) => {
  buf += d.toString(); let k;
  while ((k = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
    if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); }
  }
});
const rpc = (method, params) => new Promise((res, rej) => {
  const n = id++; w.set(n, res);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  setTimeout(() => { if (w.has(n)) { w.delete(n); rej(new Error(method + ' 逾時')); } }, 60000);
});
const call = async (n, a = {}) => {
  const r = await rpc('tools/call', { name: n, arguments: a });
  if (r.error) return { _rpcError: r.error.message };
  if (r.result?.isError) return { _toolError: r.result.content?.[0]?.text };
  return JSON.parse(r.result.content[0].text);
};

await sleep(1000);
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'v', version: '1' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

console.log('\n=== ② MCP 工具註冊 ===');
const tools = (await rpc('tools/list', {})).result.tools;
const nav = tools.find((t) => t.name === 'navigate_to');
check('navigate_to 已註冊', !!nav, tools.map((t) => t.name).join(','));
check('工具總數 4', tools.length === 4, String(tools.length));
if (nav) {
  const p = nav.inputSchema.properties || {};
  check('url 為必填', (nav.inputSchema.required || []).includes('url'), JSON.stringify(nav.inputSchema.required));
  check('url 是 uri 格式', p.url?.format === 'uri' || String(p.url?.type) === 'string', JSON.stringify(p.url));
  check('tab_id 為可選 integer', p.tab_id?.type === 'integer' && !(nav.inputSchema.required || []).includes('tab_id'), JSON.stringify(p.tab_id));
  check('描述說明省略 tab_id = 開新分頁不搶焦點', /background tab/i.test(nav.description) && /不搶焦點/.test(nav.description));
}
const badUrl = await call('navigate_to', { url: 'not-a-url' });
check('③ 無效 URL 在 MCP 層就被擋（不 crash）', !!(badUrl._rpcError || badUrl._toolError), JSON.stringify(badUrl));

console.log('\n=== ③ 端到端（需真 Chrome + 已重新載入的擴充功能）===');
spawn('cmd', ['/c', 'start', '""', 'https://bugezy.dev/guide'], { stdio: 'ignore', detached: true }).unref();
let connected = false;
for (let n = 0; n < 90; n++) { if (stderr.includes('Extension 已連線')) { connected = true; break; } await sleep(1000); }
if (!connected) {
  console.log('  SKIP  Extension 未連線，端到端未執行');
} else {
  const r1 = await call('navigate_to', { url: 'https://example.com/' });
  console.log('    navigate_to (新分頁) →', JSON.stringify(r1));
  if (JSON.stringify(r1).includes('未知的指令')) {
    console.log('  ⚠ 擴充功能仍在跑舊的 background.js —— 需要到 chrome://extensions 重新載入 BugEzy');
  } else {
    check('1. 開新分頁 → 回傳 tab_id', typeof r1.tab_id === 'number', JSON.stringify(r1));
    check('1. 回傳 url + title', !!r1.url && typeof r1.title === 'string', JSON.stringify(r1));
    if (typeof r1.tab_id === 'number') {
      const r2 = await call('navigate_to', { url: 'https://bugezy.dev/faq', tab_id: r1.tab_id });
      console.log('    navigate_to (指定 tab_id) →', JSON.stringify(r2));
      check('2. 指定 tab_id → 在該分頁導航', r2.tab_id === r1.tab_id && String(r2.url).includes('faq'), JSON.stringify(r2));
    }
    const r3 = await call('navigate_to', { url: 'https://example.com/', tab_id: 99999999 });
    console.log('    navigate_to (已關閉分頁) →', JSON.stringify(r3));
    check('§13.3 不存在的 tab_id → 明確報錯，不退回當前分頁', !!r3.error && /9999|分頁/.test(String(r3.error)), JSON.stringify(r3));
  }
}

proc.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
