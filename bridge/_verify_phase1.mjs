// Phase 1 工具驗收（PM-307 navigate_to、PM-308 click_element）
//   ① 從 **實際打包產物** 抽出純函式測試（不另抄一份，原始碼結構變動時測試會失敗而非靜默通過）
//   ② 真 MCP JSON-RPC 檢查工具註冊與 schema
//   ③ 接真 Chrome 跑端到端（需擴充功能已重新載入 + port 19850 未被其他 bridge 占用）
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 從打包產物取出一個 top-level function 的原始碼。 */
function grab(src, signature, name) {
  const i = src.indexOf(signature);
  if (i < 0) throw new Error(`打包產物裡找不到 ${name} —— 原始碼結構已變，測試需同步更新`);
  const j = src.indexOf('\nfunction ', i + 10);
  return new Function(src.slice(i, j < 0 ? undefined : j) + `\nreturn ${name};`)();
}

console.log('\n=== ① PM-307 URL 驗證（函式抽自 extension/dist/background.js）===');
const bg = readFileSync('../extension/dist/background.js', 'utf8');
const parseNavigableUrl = grab(bg, 'function parseNavigableUrl(raw)', 'parseNavigableUrl');
const ok = (u) => { try { return parseNavigableUrl(u); } catch { return null; } };
const err = (u) => { try { parseNavigableUrl(u); return null; } catch (e) { return e.message; } };
check('https 通過', ok('https://example.com/') === 'https://example.com/');
check('http 通過', ok('http://example.com/a?b=1') === 'http://example.com/a?b=1');
for (const bad of ['chrome://extensions', 'file:///C:/secret.txt', 'javascript:alert(1)', 'data:text/html,<h1>x', 'ftp://x.com'])
  check(`拒絕 ${bad.slice(0, 28)}`, err(bad) !== null, '竟然通過了');
for (const bad of ['not a url', '', undefined]) check(`拒絕 ${JSON.stringify(bad)}（不 crash）`, err(bad) !== null);
check('錯誤訊息含 protocol 提示', (err('file:///x') || '').includes('http'), err('file:///x'));

console.log('\n=== ① PM-308 click 前置檢查存在性（原始碼靜態檢查）===');
const content = readFileSync('../extension/src/content.ts', 'utf8');
const cb = content.slice(content.indexOf('function bridgeClick'), content.indexOf('// background → content'));
check('有 disabled 檢查', /\.disabled/.test(cb));
check('有 display:none / visibility:hidden 檢查', /display === 'none'/.test(cb) && /visibility === 'hidden'/.test(cb));
check('有尺寸為 0 檢查', /getBoundingClientRect/.test(cb));
check('有非法選擇器 try/catch', /catch\s*\{[\s\S]*?合法的 CSS 選擇器/.test(cb));
check('textContent 截斷 100', /slice\(0, 100\)/.test(cb));
check('先取 text 再點擊（點擊可能導航）', cb.indexOf('textContent') < cb.indexOf('.click()'));
check('找不到元素的錯誤含 selector', /找不到符合「\$\{selector\}」/.test(cb));

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
check('工具總數 6', tools.length === 6, tools.map((t) => t.name).join(','));
for (const [name, req, opt] of [['navigate_to', 'url', 'tab_id'], ['click_element', 'selector', 'tab_id']]) {
  const t = tools.find((x) => x.name === name);
  check(`${name} 已註冊`, !!t, tools.map((x) => x.name).join(','));
  if (!t) continue;
  const p = t.inputSchema.properties || {}, r = t.inputSchema.required || [];
  check(`  ${name}.${req} 必填`, r.includes(req), JSON.stringify(r));
  check(`  ${name}.${opt} 可選 integer`, p[opt]?.type === 'integer' && !r.includes(opt), JSON.stringify(p[opt]));
}
const rp = tools.find((t) => t.name === 'read_page');
check('read_page 已註冊', !!rp, tools.map((x) => x.name).join(','));
check('  read_page.tab_id 可選 integer', rp?.inputSchema?.properties?.tab_id?.type === 'integer' && !(rp?.inputSchema?.required || []).includes('tab_id'));
check('  read_page 描述提到敏感欄位遮蔽', /masked/i.test(rp?.description || '') && /遮蔽/.test(rp?.description || ''));
const cl = tools.find((t) => t.name === 'click_element');
check('  click_element 描述說明「不會假裝點成功」', /silently succeeding/i.test(cl?.description || '') && /不會假裝點成功/.test(cl?.description || ''));
// zod 驗證失敗由 MCP SDK 包成 isError 的 tool result（不是 JSON-RPC error），兩種都算擋下
const vBad = await call('navigate_to', { url: 'not-a-url' });
check('PM-307 無效 URL 在 MCP 層被擋', /validation/i.test(vBad._toolError || vBad._rpcError || ''), JSON.stringify(vBad));
const vSel = await call('click_element', { selector: '' });
check('PM-308 空 selector 在 MCP 層被擋', /validation/i.test(vSel._toolError || vSel._rpcError || ''), JSON.stringify(vSel));

console.log('\n=== ③ 端到端（需真 Chrome + 已重新載入的擴充功能）===');
if (/port 19850 被占用/.test(stderr)) {
  console.log('  SKIP  port 19850 被另一個 bugezy-bridge 占用（多半是本 session 自己的 MCP server）');
} else {
  spawn('cmd', ['/c', 'start', '""', 'https://bugezy.dev/guide'], { stdio: 'ignore', detached: true }).unref();
  let connected = false;
  for (let n = 0; n < 60; n++) { if (stderr.includes('Extension 已連線')) { connected = true; break; } await sleep(1000); }
  if (!connected) { console.log('  SKIP  Extension 未連線'); }
  else {
    const r1 = await call('navigate_to', { url: 'https://example.com/' });
    console.log('    navigate_to →', JSON.stringify(r1));
    if (JSON.stringify(r1).includes('未知的指令')) {
      console.log('  ⚠ 擴充功能仍在跑舊的 background.js —— 請到 chrome://extensions 重新載入 BugEzy');
    } else {
      check('307-1 開新分頁回 tab_id + url + title', typeof r1.tab_id === 'number' && !!r1.url && typeof r1.title === 'string', JSON.stringify(r1));
      const r2 = await call('navigate_to', { url: 'https://bugezy.dev/faq', tab_id: r1.tab_id });
      check('307-2 指定 tab_id 導航', r2.tab_id === r1.tab_id && String(r2.url).includes('faq'), JSON.stringify(r2));
      const r3 = await call('navigate_to', { url: 'https://example.com/', tab_id: 99999999 });
      check('307 §13.3 不存在 tab_id → 明確報錯', !!r3.error, JSON.stringify(r3));

      const c1 = await call('click_element', { selector: 'a[href*="faq"]', tab_id: r1.tab_id });
      console.log('    click_element →', JSON.stringify(c1));
      check('308-1 點擊成功回 element_text', c1.clicked === true && typeof c1.element_text === 'string', JSON.stringify(c1));
      const c2 = await call('click_element', { selector: '#definitely-not-here-12345', tab_id: r1.tab_id });
      check('308-2 找不到元素 → error 含 selector', !!c2.error && String(c2.error).includes('definitely-not-here-12345'), JSON.stringify(c2));
      const c3 = await call('click_element', { selector: 'a', tab_id: 99999999 });
      check('308-3/4 分頁不存在 → error', !!c3.error, JSON.stringify(c3));
      const c4 = await call('click_element', { selector: 'a[[[bad' , tab_id: r1.tab_id });
      check('308 非法選擇器 → error（不 crash）', !!c4.error, JSON.stringify(c4));

      const p1 = await call('read_page', { tab_id: r1.tab_id });
      console.log('    read_page →', JSON.stringify(p1).slice(0, 240));
      check('309-1 回傳結構化頁面文字', typeof p1.content === 'string' && p1.content.length > 0, JSON.stringify(p1).slice(0, 200));
      check('309-2 interactive 元素附 click: selector', /click: "/.test(p1.content || ''), (p1.content || '').slice(0, 300));
      check('309-4 不超過 50000 字元', (p1.content || '').length <= 50_020, String((p1.content || '').length));
      check('309-5 回傳 tab_id + element_count', p1.tab_id === r1.tab_id && typeof p1.element_count === 'number', JSON.stringify({ t: p1.tab_id, c: p1.element_count }));
      // 用 read_page 給的 selector 真的去點一次——驗收條件 2 的真正意思
      const firstSel = (/click: "([^"]+)"/.exec(p1.content || '') || [])[1];
      if (firstSel) {
        const c5 = await call('click_element', { selector: firstSel, tab_id: r1.tab_id });
        check('309-2 read_page 的 selector 可直接餵給 click_element', c5.clicked === true || !!c5.error === false, JSON.stringify(c5));
      }
    }
  }
}

proc.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
