// PM-327 驗收：終端機即時監控（真的 spawn 子程序，不模擬）
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n=== ⓪ vendor 與 cli/src 逐字一致（避免默默漂移）===');
for (const f of ['parse-traceback.ts', 'pii-mask.ts']) {
  const orig = readFileSync(`../cli/src/${f}`, 'utf8');
  const vend = readFileSync(`src/vendor/${f}`, 'utf8');
  const body = vend.slice(vend.indexOf('// parse-traceback.ts') >= 0 ? vend.indexOf('// parse-traceback.ts') : vend.indexOf('// pii-mask.ts'));
  check(`${f} 與 cli/src 內容一致`, body === orig, `vendor 長度 ${body.length} vs 原始 ${orig.length}`);
}

const proc = spawn(process.execPath, ['dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  setTimeout(() => { if (w.has(n)) { w.delete(n); rej(new Error(method + ' 逾時')); } }, 30000);
});
const call = async (n, a = {}) => {
  const r = await rpc('tools/call', { name: n, arguments: a });
  if (r.error) return { _rpcError: r.error.message };
  return JSON.parse(r.result.content[0].text);
};

await sleep(900);
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'v', version: '1' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

console.log('\n=== ① 工具註冊 ===');
const tools = (await rpc('tools/list', {})).result.tools;
check('工具總數 37（30 + 7 Phase 5）', tools.length === 37, String(tools.length));
for (const n of ['start_terminal_monitor', 'get_terminal_live_errors', 'stop_terminal_monitor'])
  check(`${n} 已註冊`, tools.some((t) => t.name === n), tools.map((t) => t.name).join(','));
check('get_terminal_live_errors 描述講明「errors 為空不代表沒問題」',
  /does NOT mean/i.test(tools.find((t) => t.name === 'get_terminal_live_errors')?.description || ''));

console.log('\n=== ② 沒有 monitor 時 get 不應 crash ===');
const none = await call('get_terminal_live_errors');
check('回明確錯誤而非 crash', !!none.error && /沒有任何終端機監控/.test(none.error), JSON.stringify(none));

console.log('\n=== ③ 驗收 1：start_terminal_monitor 回 monitor_id ===');
// 故意噴一個 Node Error（有 stack）
const cmd = `node -e "setTimeout(()=>{const e=new Error('boom-test');console.error(e.stack)},150)"`;
const started = await call('start_terminal_monitor', { command: cmd });
console.log('   ', JSON.stringify(started));
check('1. 回傳 monitor_id + pid + status', !!started.monitor_id && !!started.pid && started.status === 'running', JSON.stringify(started));

await sleep(1500);
console.log('\n=== ④ 驗收 2：get_terminal_live_errors 拿到結構化錯誤 ===');
const errs = await call('get_terminal_live_errors');
console.log('   ', JSON.stringify(errs).slice(0, 320));
check('2. errors 含 type/message', Array.isArray(errs.errors) && errs.errors.length > 0 && !!errs.errors[0].type && !!errs.errors[0].message, JSON.stringify(errs.errors || []).slice(0, 240));
check('2. type/message 正確解析', errs.errors?.[0]?.type === 'Error' && /boom-test/.test(errs.errors?.[0]?.message || ''), JSON.stringify(errs.errors?.[0] || {}).slice(0, 200));
check('2. frames 有解析出堆疊', Array.isArray(errs.errors?.[0]?.frames) && errs.errors[0].frames.length > 0, JSON.stringify(errs.errors?.[0]?.frames || []).slice(0, 200));
check('   有標明 120 秒視窗 + errors 為空的警語', errs.window_seconds === 120 && /不代表沒問題/.test(errs.note || ''), String(errs.window_seconds));

console.log('\n=== ⑤ 驗收 4：process 結束後狀態更新 ===');
await sleep(1200);
const after = await call('get_terminal_live_errors', { monitor_id: started.monitor_id });
check('4. status 轉為 stopped 且有 exit_code', after.status === 'stopped' && after.exit_code !== undefined, JSON.stringify({ s: after.status, c: after.exit_code }));

console.log('\n=== ⑥ 驗收 3：PII 遮罩生效 ===');
const secret = `node -e "console.error(new Error('fail DATABASE_URL=postgres://u:pw123@h/db token sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 mail a@b.com').stack)"`;
const s2 = await call('start_terminal_monitor', { command: secret });
await sleep(1500);
const e2 = await call('get_terminal_live_errors', { monitor_id: s2.monitor_id });
const dump = JSON.stringify(e2);
console.log('   ', dump.slice(0, 300));
check('3. DB 密碼未外洩', !dump.includes('pw123'), dump.slice(0, 200));
check('3. OpenAI 形式 token 未外洩', !dump.includes('sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), dump.slice(0, 200));
check('3. email 未外洩', !dump.includes('a@b.com'), dump.slice(0, 200));
check('3. 但錯誤本身仍看得到（不是整段吞掉）', /fail/.test(dump));

console.log('\n=== ⑦ 上限與 stop ===');
const ids = [];
for (let i = 0; i < 5; i++) ids.push(await call('start_terminal_monitor', { command: 'node -e "setTimeout(()=>{},8000)"' }));
const over = await call('start_terminal_monitor', { command: 'node -e "0"' });
check('超過 5 個同時監控 → 明確報錯', !!over.error && /上限/.test(over.error), JSON.stringify(over).slice(0, 200));
const stopped = await call('stop_terminal_monitor', { monitor_id: ids[0].monitor_id });
check('stop_terminal_monitor 可停指定 monitor', stopped.status === 'stopped', JSON.stringify(stopped));

console.log('\n=== ⑧ 驗收 5：bridge 關閉時無孤兒 ===');
const livePids = ids.slice(1).map((x) => x.pid).filter(Boolean);
try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 可能已自行結束 */ }
await sleep(1500);
const stillAlive = livePids.filter((pid) => {
  try { return execFileSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8' }).includes(String(pid)); }
  catch { return false; }
});
check('5. bridge 被殺後子程序未殘留', stillAlive.length === 0, `殘留 pid: ${stillAlive.join(',')}`);
for (const pid of stillAlive) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
