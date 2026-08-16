// Phase 1 工具驗收（PM-307 navigate_to、PM-308 click_element）
//   ① 從 **實際打包產物** 抽出純函式測試（不另抄一份，原始碼結構變動時測試會失敗而非靜默通過）
//   ② 真 MCP JSON-RPC 檢查工具註冊與 schema
//   ③ 接真 Chrome 跑端到端（需擴充功能已重新載入 + port 19850 未被其他 bridge 占用）
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ── Windows 上的程序回收 ───────────────────────────────────────────────────
// `proc.kill()` 只殺得到直接 spawn 的那個 handle；Windows 上常常還隔著一層 wrapper，
// 結果 bridge 子程序活下來繼續占住 port 19850 —— **下一次驗證就會整段 SKIP，而且
// 看起來像環境問題**（PM-310 就是這樣卡掉的，連續兩次）。
// 一律用 taskkill /T（連同整棵 process tree）/F（強制）。
const isWin = process.platform === 'win32';
function killTree(pid) {
  if (!pid) return;
  try {
    if (isWin) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* 已經死了就算了 */ }
}

/** 誰占著這個 port：回傳 { pid, cmd, parent }，沒人占用回 null。 */
function portHolder(port) {
  if (!isWin) return null;
  try {
    const ps = [
      `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
      'if (-not $c) { return }',
      '$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"',
      '$q = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"',
      '"$($p.ProcessId)|$($p.CommandLine)|$($q.Name)"',
    ].join('; ');
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
    if (!out) return null;
    const [pid, cmd, parent] = out.split('|');
    return { pid: Number(pid), cmd: (cmd || '').trim(), parent: (parent || '').trim() };
  } catch { return null; }
}

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

console.log('\n=== ① PM-312 pngSize（函式抽自 dist/background.js，用真實 PNG 檔驗證）===');
const pngSize = grab(bg, 'function pngSize(base64)', 'pngSize');
globalThis.atob ??= (b64) => Buffer.from(b64, 'base64').toString('binary');
for (const [f, w, h] of [['icon-16.png', 16, 16], ['icon-48.png', 48, 48], ['icon-128.png', 128, 128]]) {
  const b64 = readFileSync(`../extension/icons/${f}`).toString('base64');
  const got = pngSize(b64);
  check(`${f} → ${w}x${h}`, got.width === w && got.height === h, JSON.stringify(got));
}
check('非 PNG 資料 → 回 0x0（不 crash）', JSON.stringify(pngSize(Buffer.from('not a png at all').toString('base64'))) === '{"width":0,"height":0}');
check('空字串 → 回 0x0（不 crash）', JSON.stringify(pngSize('')) === '{"width":0,"height":0}');

console.log('\n=== ① PM-308 click 前置檢查存在性（原始碼靜態檢查）===');
const content = readFileSync('../extension/src/content.ts', 'utf8');
const cb = content.slice(content.indexOf('function bridgeClick'), content.indexOf('// background → content'));
check('有 disabled 檢查', /\.disabled/.test(cb));
// bridgeClick 改用共用的 isElementVisible（優先 checkVisibility，才抓得到「祖先被隱藏」）
check('有可見性檢查且共用 isElementVisible', /!isElementVisible\(el\)/.test(cb), cb.slice(0, 200));
const vis = content.slice(content.indexOf('function isElementVisible'), content.indexOf('/** 只取「直接屬於這個元素」'));
check('isElementVisible 優先用 checkVisibility，並保留 computedStyle 後備', /checkVisibility/.test(vis) && /display !== 'none'/.test(vis) && /visibility !== 'hidden'/.test(vis), vis.slice(0, 200));
check('有尺寸為 0 檢查', /getBoundingClientRect/.test(cb));
check('有非法選擇器 try/catch', /catch\s*\{[\s\S]*?合法的 CSS 選擇器/.test(cb));
check('textContent 截斷 100', /slice\(0, 100\)/.test(cb));
check('先取 text 再點擊（點擊可能導航）', cb.indexOf('textContent') < cb.indexOf('.click()'));
check('找不到元素的錯誤含 selector', /找不到符合「\$\{selector\}」/.test(cb));

// ═══ ② + ③ 真 MCP ═══
// 啟動前先看 port 有沒有被占。**只有在確定是本 harness 洩漏的測試程序時才回收**
// （父程序是 cmd.exe = 從 shell 直接跑的），且需帶 --reclaim 明確授權；
// 若占用者是 Claude Code 自己 spawn 的 MCP server，一律不動它、只回報。
const holder = portHolder(19850);
if (holder) {
  const leaked = /cmd\.exe/i.test(holder.parent) && /dist[\\/]index\.js/.test(holder.cmd);
  console.log(`\n  ⚠ port 19850 已被 PID ${holder.pid} 占用（父程序 ${holder.parent}）`);
  if (leaked && process.argv.includes('--reclaim')) {
    console.log('    → 判定為本 harness 先前洩漏的測試程序，taskkill /T /F 回收');
    killTree(holder.pid);
    await sleep(1200);
  } else if (leaked) {
    console.log('    → 看起來是先前洩漏的測試程序；加上 --reclaim 參數即可自動回收');
  } else {
    console.log('    → 不是本 harness 的程序（可能是 Claude Code 的 MCP server），不會動它');
  }
}

const proc = spawn(process.execPath, ['dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
// 不論正常結束、例外、還是 Ctrl-C，都要把 bridge 收乾淨
const cleanup = () => killTree(proc.pid);
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { cleanup(); console.error(e); process.exit(1); });
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
check('工具總數 14（11 瀏覽器 + 3 終端機監控）', tools.length === 14, tools.map((t) => t.name).join(','));
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
const ph = tools.find((t) => t.name === 'get_page_health');
check('get_page_health 已註冊', !!ph, tools.map((x) => x.name).join(','));
check('  get_page_health.tab_id 可選 integer', ph?.inputSchema?.properties?.tab_id?.type === 'integer' && !(ph?.inputSchema?.required || []).includes('tab_id'));
check('  描述提醒高分可能只是「最近沒出事」', /nothing broke recently/i.test(ph?.description || '') && /最近沒出事/.test(ph?.description || ''));
const wv = tools.find((t) => t.name === 'get_web_vitals');
check('get_web_vitals 已註冊', !!wv, tools.map((x) => x.name).join(','));
check('  get_web_vitals.tab_id 可選 integer', wv?.inputSchema?.properties?.tab_id?.type === 'integer' && !(wv?.inputSchema?.required || []).includes('tab_id'));
check('  描述講明 FID 為 null 不是 0 + 資源大小是低估值', /null until/i.test(wv?.description || '') && /低估值/.test(wv?.description || ''));
const ae = tools.find((t) => t.name === 'analyze_element');
check('analyze_element 已註冊', !!ae, tools.map((x) => x.name).join(','));
check('  analyze_element.selector 必填 + tab_id 可選', (ae?.inputSchema?.required || []).includes('selector') && ae?.inputSchema?.properties?.tab_id?.type === 'integer' && !(ae?.inputSchema?.required || []).includes('tab_id'));
check('  描述警告「空清單不代表沒有事件處理器」', /does NOT mean/i.test(ae?.description || '') && /不代表沒有事件處理器/.test(ae?.description || ''));
const gbe = tools.find((t) => t.name === 'get_browser_errors');
check('get_browser_errors 已註冊', !!gbe, tools.map((x) => x.name).join(','));
check('  get_browser_errors.tab_id 可選 integer', gbe?.inputSchema?.properties?.tab_id?.type === 'integer' && !(gbe?.inputSchema?.required || []).includes('tab_id'));
check('  描述明講只涵蓋最近 30 秒（避免空陣列被誤讀成沒問題）', /30 seconds/i.test(gbe?.description || '') && /30 秒/.test(gbe?.description || ''));
check('  舊的 get_live_errors 已從工具清單移除（PM-314）', !tools.some((t) => t.name === 'get_live_errors'), tools.map((t) => t.name).join(','));
const ss = tools.find((t) => t.name === 'take_screenshot');
check('take_screenshot 已註冊', !!ss, tools.map((x) => x.name).join(','));
check('  take_screenshot.tab_id 可選 integer', ss?.inputSchema?.properties?.tab_id?.type === 'integer' && !(ss?.inputSchema?.required || []).includes('tab_id'));
check('  描述引導優先用 read_page（省 token）', /read_page/.test(ss?.description || '') && /95%/.test(ss?.description || ''));
const tt = tools.find((t) => t.name === 'type_text');
check('type_text 已註冊', !!tt, tools.map((x) => x.name).join(','));
check('  type_text.selector + text 必填', ['selector','text'].every((k) => (tt?.inputSchema?.required || []).includes(k)), JSON.stringify(tt?.inputSchema?.required));
check('  type_text.tab_id 可選 integer', tt?.inputSchema?.properties?.tab_id?.type === 'integer' && !(tt?.inputSchema?.required || []).includes('tab_id'));
check('  type_text 描述講明會「取代」原有內容', /取代/.test(tt?.description || '') && /Replaces/i.test(tt?.description || ''));
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

      // 點擊的目標**從 read_page 的輸出取**，不要寫死 selector：
      //   寫死的話測的是「我猜這頁有沒有這個元素」，猜錯就變成假的 FAIL（第一次跑就是這樣：
      //   分頁已經導到 /faq，頁面上自然沒有 a[href*="faq"]，工具其實正確回報了找不到）。
      //   從 read_page 拿 selector 也正好就是驗收條件 2 要證明的事。
      const pg = await call('read_page', { tab_id: r1.tab_id });
      const firstSel = (/click: "([^"]+)"/.exec(pg.content || '') || [])[1];
      check('308-1 前置：read_page 給得出可用的 selector', !!firstSel, (pg.content || '').slice(0, 200));
      const c1 = firstSel ? await call('click_element', { selector: firstSel, tab_id: r1.tab_id }) : {};
      console.log('    click_element(', firstSel, ') →', JSON.stringify(c1));
      check('308-1 點擊成功回 element_text', c1.clicked === true && typeof c1.element_text === 'string', JSON.stringify(c1));
      const c2 = await call('click_element', { selector: '#definitely-not-here-12345', tab_id: r1.tab_id });
      check('308-2 找不到元素 → error 含 selector', !!c2.error && String(c2.error).includes('definitely-not-here-12345'), JSON.stringify(c2));
      const c3 = await call('click_element', { selector: 'a', tab_id: 99999999 });
      check('308-3/4 分頁不存在 → error', !!c3.error, JSON.stringify(c3));
      const c4 = await call('click_element', { selector: 'a[[[bad' , tab_id: r1.tab_id });
      check('308 非法選擇器 → error（不 crash）', !!c4.error, JSON.stringify(c4));

      // 上面的 click 會觸發導航，分頁此刻可能還在載入（實測過一次讀到空的 content）。
      // 先用 navigate_to 把分頁帶到一個確定的頁面——它本來就會等 load 完成才回傳。
      await call('navigate_to', { url: 'https://bugezy.dev/guide', tab_id: r1.tab_id });
      const p1 = await call('read_page', { tab_id: r1.tab_id });
      console.log('    read_page →', JSON.stringify(p1).slice(0, 240));
      check('309-1 回傳結構化頁面文字', typeof p1.content === 'string' && p1.content.length > 0, JSON.stringify(p1).slice(0, 200));
      check('309-2 interactive 元素附 click: selector', /click: "/.test(p1.content || ''), (p1.content || '').slice(0, 300));
      check('309-4 不超過 50000 字元', (p1.content || '').length <= 50_020, String((p1.content || '').length));
      check('309-5 回傳 tab_id + element_count', p1.tab_id === r1.tab_id && typeof p1.element_count === 'number', JSON.stringify({ t: p1.tab_id, c: p1.element_count }));
      // PM-319（DONE-310 留項）
      check('319-1 read_page 回傳 ready_state（loading/interactive/complete）',
        ['loading', 'interactive', 'complete'].includes(p1.ready_state), String(p1.ready_state));
      check('319   navigate_to 等到載入完成後應為 complete', p1.ready_state === 'complete', String(p1.ready_state));
      // 用 read_page 給的 selector 真的去點一次——驗收條件 2 的真正意思
      // ── PM-311 type_text 端到端 ──
      // bugezy.dev 全站沒有任何 input/textarea，所以借一個有純 HTML 表單的頁面。
      // 用 html.duckduckgo.com（**沒有 JS 自動完成**，打字不會送出任何請求），
      // 而且欄位是從 read_page 的輸出找出來的，不寫死 markup。
      const fp = await call('navigate_to', { url: 'https://html.duckduckgo.com/html/', tab_id: r1.tab_id });
      if (fp.error) {
        console.log('  SKIP  311 端到端：表單頁開不起來 →', fp.error);
      } else {
        const fpg = await call('read_page', { tab_id: r1.tab_id });
        const inputLine = (fpg.content || '').split('\n').find((l) => /^\s*\[input/.test(l) && /click: "/.test(l));
        const inputSel = inputLine ? (/click: "([^"]+)"/.exec(inputLine) || [])[1] : null;
        check('311 前置：read_page 在真實頁面找得到 input 及其 selector', !!inputSel, (fpg.content || '').slice(0, 300));
        if (inputSel) {
          const ty = await call('type_text', { selector: inputSel, text: 'bugezy phase1 check', tab_id: r1.tab_id });
          console.log('    type_text(', inputSel, ') →', JSON.stringify(ty));
          check('311-1 輸入成功並回傳 previous/new value', ty.typed === true && ty.new_value === 'bugezy phase1 check', JSON.stringify(ty));
          // 再讀一次頁面，確認值真的寫進 DOM（不是只回報成功）
          const after = await call('read_page', { tab_id: r1.tab_id });
          check('311-1 read_page 讀回同一個值（確認真的寫進 DOM）', (after.content || '').includes('bugezy phase1 check'), (after.content || '').slice(0, 300));
          const bad = await call('type_text', { selector: 'body', text: 'x', tab_id: r1.tab_id });
          check('311-4 非表單元素 → error', !!bad.error && /不是可輸入的欄位/.test(String(bad.error)), JSON.stringify(bad));
        }
      }
      await call('navigate_to', { url: 'https://bugezy.dev/guide', tab_id: r1.tab_id });

      // ── PM-312 take_screenshot 端到端 ──
      // 圖片走 MCP 原生 image content，所以要看 raw result 而不是 call() 的 JSON。
      const shotRaw = await rpc('tools/call', { name: 'take_screenshot', arguments: { tab_id: r1.tab_id } });
      const parts = shotRaw.result?.content || [];
      const imgPart = parts.find((c) => c.type === 'image');
      const metaPart = parts.find((c) => c.type === 'text');
      const meta = metaPart ? JSON.parse(metaPart.text) : {};
      console.log('    take_screenshot meta →', JSON.stringify(meta).slice(0, 220));
      if (meta.error && /activeTab|all_urls/i.test(String(meta.error))) {
        // 已知的 Chrome 權限限制（PM-312 實測確認），**不是程式缺陷**，待 FOX 決策。
        // 標成 LIMIT 而不是 PASS——絕不假裝通過；也不標 FAIL，免得真正的迴歸被這條噪音蓋掉。
        // 若哪天權限情況改變（加了 <all_urls>，或使用者先點過圖示），這裡會自動改走下面的正常驗證。
        console.log('  LIMIT 312-1~3 未驗：captureVisibleTab 需 activeTab／<all_urls>，bridge 呼叫無使用者手勢');
        console.log('        → 這是 Chrome 權限模型的限制，非實作問題；處置方式待決策');
      } else if (meta.error) {
        check('312-1 截取分頁 → 回傳 PNG + 寬高', false, String(meta.error).slice(0, 300));
      } else {
        check('312-1 回傳 image content + 寬高', !!imgPart && meta.width > 0 && meta.height > 0, JSON.stringify(meta));
        // 驗收 2：base64 真的可解碼成有效 PNG（檢查簽章 + IHDR 尺寸與 meta 一致）
        const buf = Buffer.from(imgPart?.data || '', 'base64');
        const sigOk = buf.length > 24 && buf[0] === 0x89 && buf.subarray(1, 4).toString() === 'PNG';
        check('312-2 base64 是有效 PNG（簽章正確且可解碼）', sigOk, `len=${buf.length} head=${buf.subarray(0, 8).toString('hex')}`);
        check('312-2 解碼後尺寸與回報的一致', sigOk && buf.readUInt32BE(16) === meta.width && buf.readUInt32BE(20) === meta.height,
          `png=${sigOk ? buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20) : '?'} meta=${meta.width}x${meta.height}`);
        check('312   mimeType 為 image/png', imgPart?.mimeType === 'image/png', String(imgPart?.mimeType));
        check('312-3 非 active 分頁 → 有切換警告（方案 B）', typeof meta.warning === 'string' && /切換分頁/.test(meta.warning), JSON.stringify(meta.warning));
      }
      // 驗收 4：受限頁面 —— chrome:// 開不了（navigate_to 會擋），改用「分頁不存在」驗錯誤路徑
      const shotBad = await call('take_screenshot', { tab_id: 99999999 });
      check('312-4 分頁不存在 → error（不 crash）', !!shotBad.error, JSON.stringify(shotBad).slice(0, 200));

      // ── PM-317 get_page_health 端到端 ──
      const gh = await call('get_page_health', { tab_id: r1.tab_id });
      console.log('    get_page_health →', JSON.stringify(gh).slice(0, 320));
      if (gh.error) {
        check('317-1 回傳 score + summary + details', false, String(gh.error).slice(0, 200));
      } else {
        check('317-1 score 為 0~100 的數字 + 有 summary/details',
          typeof gh.score === 'number' && gh.score >= 0 && gh.score <= 100 && typeof gh.summary === 'string' && !!gh.details,
          JSON.stringify({ s: gh.score, sum: gh.summary }));
        check('317-3 details 含 errors/performance/accessibility/dom 四區塊',
          ['errors', 'performance', 'accessibility', 'dom'].every((k) => k in gh.details), Object.keys(gh.details).join(','));
        check('317-4 summary 是人類可讀的一句話（含分數且非空）',
          gh.summary.length > 5 && gh.summary.includes(String(gh.score)), gh.summary);
        check('317-2 乾淨頁面分數偏高（bugezy.dev/guide 應 ≥ 70）', gh.score >= 70, `score=${gh.score} deductions=${JSON.stringify(gh.deductions)}`);
        check('317   dom 統計為合理數值', gh.details.dom.element_count > 0 && gh.details.dom.max_depth > 0, JSON.stringify(gh.details.dom));
        check('317   有揭露錯誤只涵蓋 30 秒', gh.errors_window_seconds === 30 && typeof gh.note === 'string', JSON.stringify(gh.errors_window_seconds));
      }

      // ── PM-316 get_web_vitals 端到端 ──
      const wvR = await call('get_web_vitals', { tab_id: r1.tab_id });
      console.log('    get_web_vitals →', JSON.stringify(wvR).slice(0, 300));
      if (wvR.error) {
        check('316-1 回傳 LCP/FCP/TTFB', false, String(wvR.error).slice(0, 200));
      } else {
        const v = wvR.vitals || {};
        check('316-1 LCP/FCP/TTFB 至少這三個有值', !!v.LCP && !!v.FCP && !!v.TTFB, JSON.stringify(v).slice(0, 240));
        check('316-2 每個指標有 value + rating',
          [v.LCP, v.FCP, v.TTFB].every((m) => m && typeof m.rating === 'string' && (typeof m.value_ms === 'number' || typeof m.value === 'number')),
          JSON.stringify({ LCP: v.LCP, FCP: v.FCP, TTFB: v.TTFB }));
        check('316-3 rating 只會是三種合法值',
          [v.LCP, v.FCP, v.TTFB, v.CLS].filter(Boolean).every((m) => ['good', 'needs-improvement', 'poor'].includes(m.rating)),
          JSON.stringify([v.LCP?.rating, v.FCP?.rating, v.TTFB?.rating, v.CLS?.rating]));
        check('316   FID 未互動時為 null（不是 0）', v.FID === null, JSON.stringify(v.FID));
        check('316-4 resource_summary 有 total + by_type',
          typeof wvR.resource_summary?.total_requests === 'number' && !!wvR.resource_summary?.by_type,
          JSON.stringify(wvR.resource_summary).slice(0, 240));
        check('316   回傳 tab_id', wvR.tab_id === r1.tab_id, String(wvR.tab_id));
      }

      // ── PM-315 analyze_element 端到端 ──
      // 分析目標同樣從 read_page 的輸出取，不寫死 markup
      const anSel = (/click: "([^"]+)"/.exec(p1.content || '') || [])[1];
      const an = anSel ? await call('analyze_element', { selector: anSel, tab_id: r1.tab_id }) : { error: '沒有可用的 selector' };
      if (anSel && !an.error) {
        console.log('    analyze_element(', anSel, ') →', JSON.stringify(an).slice(0, 260));
        check('315-1 回傳 tag/attributes/computed_styles/box_model',
          !!an.tag && !!an.attributes && !!an.computed_styles && !!an.box_model, JSON.stringify(an).slice(0, 200));
        // 注意：這條若寫成 `Object.keys(an.computed_styles || {}).length <= 25`，
        // 在工具回 error（沒有 computed_styles）時會變成 0 <= 25 而**假通過**。
        // 所以整段放在 !an.error 之內，並額外要求欄位確實存在且非空。
        check('315-2 computed_styles 只有精選屬性且 1~25 個',
          Object.keys(an.computed_styles || {}).length > 0 && Object.keys(an.computed_styles || {}).length <= 25,
          String(Object.keys(an.computed_styles || {}).length));
        check('315   box_model 在真實版面上有非零尺寸', an.box_model?.width > 0 || an.box_model?.height > 0, JSON.stringify(an.box_model));
        check('315   visibility/accessibility 皆有回傳', !!an.visibility && !!an.accessibility, JSON.stringify(an).slice(0, 200));
        check('315   回傳 selector + tab_id', an.selector === anSel && an.tab_id === r1.tab_id, JSON.stringify({ s: an.selector, t: an.tab_id }));
      } else {
        check('315-1~2 analyze_element 可用', false, JSON.stringify(an).slice(0, 200));
      }
      const anBad = await call('analyze_element', { selector: '#nope-315-e2e', tab_id: r1.tab_id });
      check('315-3 找不到元素 → error 含 selector', !!anBad.error && String(anBad.error).includes('#nope-315-e2e'), JSON.stringify(anBad).slice(0, 200));

      // ── PM-313 get_browser_errors 端到端 ──
      // 驗收 4：乾淨的頁面要回**空陣列**而不是 error
      const clean = await call('get_browser_errors', { tab_id: r1.tab_id });
      console.log('    get_browser_errors (乾淨頁) →', JSON.stringify(clean).slice(0, 200));
      check('313-4 沒有錯誤時回空陣列（不是 error）',
        !clean.error && Array.isArray(clean.console_errors) && Array.isArray(clean.network_errors), JSON.stringify(clean).slice(0, 200));
      check('313-5 指定 tab_id → 回該分頁 + total_count', clean.tab_id === r1.tab_id && typeof clean.total_count === 'number', JSON.stringify(clean).slice(0, 200));
      check('313   回傳有標明 30 秒視窗（避免空陣列被誤讀成沒問題）', clean.window_seconds === 30 && typeof clean.note === 'string', JSON.stringify(clean).slice(0, 200));

      // 驗收 2/3：PM-328 建了一個**故意出錯的測試頁**（同源的 404 + 500 fetch + console.error + throw），
      // 因為導航到 404 只是文件請求，inject 攔的是 fetch/XHR，不會產生 network_errors。
      await call('navigate_to', { url: 'https://bugezy.dev/test-errors', tab_id: r1.tab_id });
      await sleep(1200); // 給頁面的 fetch 完成的時間
      const errs = await call('get_browser_errors', { tab_id: r1.tab_id });
      console.log('    get_browser_errors (404 頁) →', JSON.stringify(errs).slice(0, 400));
      check('313-1 回傳 console + network 兩個陣列', Array.isArray(errs.console_errors) && Array.isArray(errs.network_errors), JSON.stringify(errs).slice(0, 200));

      // 欄位結構要用**任何一次真的抓到東西**的結果來驗，不能只押在 404 那一次——
      // inject 的 buffer 每次換頁會重來，404 頁不一定會產生錯誤，
      // 押錯地方會讓驗收在「其實有資料」的情況下被跳過（第一次跑就是這樣）。
      const allConsole = [...(clean.console_errors || []), ...(errs.console_errors || [])];
      const allNetwork = [...(clean.network_errors || []), ...(errs.network_errors || [])];

      if (allConsole.length) {
        const c = allConsole[0];
        check(`313-2 console 每筆含 level/message/source（${String(c.message).slice(0, 28)}…）`,
          !!c.level && typeof c.message === 'string' && !!c.source, JSON.stringify(c).slice(0, 200));
        check('313   已濾掉 level:"info"（Web Vitals 之類不算錯誤）',
          allConsole.every((x) => x.level !== 'info'), JSON.stringify(allConsole.map((x) => x.level)));
      } else {
        console.log('  LIMIT 313-2 未驗：這次兩個頁面都沒產生 console 錯誤');
      }

      if (allNetwork.length) {
        const n = allNetwork[0];
        check(`313-3 network 每筆含 url/status/method（${n.status}）`,
          !!n.url && typeof n.status === 'number' && !!n.method, JSON.stringify(n).slice(0, 200));
        check('313   🔴 network 不含 requestBody/responseBody（可能有 token／個資）',
          !('requestBody' in n) && !('responseBody' in n), JSON.stringify(n).slice(0, 200));
      } else {
        check('313-3 network 每筆含 url/status/method', false, 'PM-328 測試頁應產生 network_errors，卻一筆都沒有');
      }
      await call('navigate_to', { url: 'https://bugezy.dev/guide', tab_id: r1.tab_id });

      const roundTripSel = (/click: "([^"]+)"/.exec(p1.content || '') || [])[1];
      if (roundTripSel) {
        const c5 = await call('click_element', { selector: roundTripSel, tab_id: r1.tab_id });
        check('309-2 read_page 的 selector 可直接餵給 click_element', c5.clicked === true, JSON.stringify(c5));
      }
    }
  }
}

killTree(proc.pid);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
