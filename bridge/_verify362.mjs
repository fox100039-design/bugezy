// PM-362 驗收：方案分層閘門。真的 spawn bridge，用環境變數切換方案。
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { TOOL_TIER_MAP, tierRank } from './dist/tier-gate.js';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };
const isWin = process.platform === 'win32';
const killTree = (pid) => { try { if (isWin) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(pid, 'SIGKILL'); } catch { /* 已死 */ } };

/** 起一個 bridge，指定方案與 port（避開 19850，不去碰正在用的那個）。 */
async function withBridge(env, port, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bugezy-tier-'));
  const proc = spawn(process.execPath, [path.resolve('dist/index.js')], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BUGEZY_BRIDGE_PORT: String(port), ...env },
  });
  let buf = ''; const w = new Map(); let id = 1;
  proc.stderr.on('data', () => {});
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
    if (r.result?.isError) return { _toolError: r.result.content?.[0]?.text };
    try { return JSON.parse(r.result.content[0].text); } catch { return { _raw: r.result.content[0] }; }
  };
  try {
    await new Promise((r) => setTimeout(r, 900));
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'v', version: '1' } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await fn({ call, rpc });
  } finally {
    killTree(proc.pid);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

console.log('\n=== ① 對照表涵蓋率（雙向比對，新增工具漏列會失敗）===');
let registered = [];
await withBridge({}, 19871, async ({ rpc }) => {
  registered = (await rpc('tools/list', {})).result.tools.map((t) => t.name).sort();
});
const mapped = Object.keys(TOOL_TIER_MAP).sort();
check(`362-1 對照表涵蓋全部 ${registered.length} 支工具`, registered.length === 51 && mapped.length === 51, `註冊 ${registered.length} / 對照表 ${mapped.length}`);
const missing = registered.filter((t) => !(t in TOOL_TIER_MAP));
const extra = mapped.filter((t) => !registered.includes(t));
check('    沒有工具漏列在對照表裡', missing.length === 0, missing.join(','));
check('    對照表裡沒有已不存在的工具', extra.length === 0, extra.join(','));
check('    ping / get_page_url 是 free（否則使用者無法排查 bridge 為何不能用）',
  TOOL_TIER_MAP.ping === 'free' && TOOL_TIER_MAP.get_page_url === 'free');
check('    ticket／day_pass 排在 pro 之下（只含 v1）', tierRank('ticket') < tierRank('pro') && tierRank('day_pass') < tierRank('pro'));
check('    tier 高低順序 free < ticket < pro < max < agent',
  tierRank('free') < tierRank('ticket') && tierRank('pro') < tierRank('max') && tierRank('max') < tierRank('agent'));

console.log('\n=== ② 閘門關閉（預設）→ 全部放行 ===');
await withBridge({}, 19872, async ({ call }) => {
  const r = await call('memory_stats');
  check('362-5 ENFORCE_TIER_GATE 未設 → 不擋（沒有 tier_gate 旗標）', !r.tier_gate && !r.error, JSON.stringify(r).slice(0, 140));
  const r2 = await call('memory_save', { layer: 'L1', entry: { topic: 't', content: 'c' } });
  check('    連 pro 級工具也放行', !r2.tier_gate && !!r2.id);
});
// 只設方案、沒設 ENFORCE → 仍然不擋（兩個變數缺一不可）
await withBridge({ BUGEZY_USER_TIER: 'free' }, 19873, async ({ call }) => {
  check('    只設 BUGEZY_USER_TIER 而沒設 ENFORCE_TIER_GATE → 仍不擋',
    !(await call('memory_stats')).tier_gate);
});

console.log('\n=== ③ ENFORCE_TIER_GATE=true + free → v2 被擋 ===');
await withBridge({ ENFORCE_TIER_GATE: 'true', BUGEZY_USER_TIER: 'free' }, 19874, async ({ call }) => {
  const blocked = await call('memory_save', { layer: 'L1', entry: { topic: 't', content: 'c' } });
  check('362-2 free → v2 工具被擋', blocked.tier_gate === true && !!blocked.error, JSON.stringify(blocked).slice(0, 200));
  check('362-6 錯誤訊息含工具名 + 需要的方案 + 目前的方案',
    /memory_save/.test(blocked.error) && /Pro NT\$80/.test(blocked.error) && /Free/.test(blocked.error),
    blocked.error);
  check('    訊息含升級連結', /bugezy\.dev\/checkout/.test(blocked.error));
  const ping = await call('ping');
  check('    ping 永遠不擋', !ping.tier_gate, JSON.stringify(ping).slice(0, 120));
  const url = await call('get_page_url');
  check('    get_page_url 永遠不擋', !url.tier_gate, JSON.stringify(url).slice(0, 120));
  // 被擋時**不能真的執行**——這是閘門唯一的意義
  check('    🔴 被擋的呼叫沒有真的執行（沒有寫出記憶）',
    (await call('memory_list', { layer: 'L1' })).tier_gate === true);
});

console.log('\n=== ④ 票券／日票 → 擋，且說明只含 v1 ===');
for (const [tier, port] of [['ticket', 19875], ['day_pass', 19876]]) {
  await withBridge({ ENFORCE_TIER_GATE: 'true', BUGEZY_USER_TIER: tier }, port, async ({ call }) => {
    const r = await call('navigate_to', { url: 'https://example.com/' });
    check(`    ${tier} → v2 被擋且明講「僅含 v1 錄製」`, r.tier_gate === true && /僅包含 v1/.test(r.error), String(r.error).slice(0, 140));
  });
}

console.log('\n=== ⑤ pro → v2 通過，但 start_auto_detect full 要 Max ===');
await withBridge({ ENFORCE_TIER_GATE: 'true', BUGEZY_USER_TIER: 'pro' }, 19877, async ({ call }) => {
  const ok = await call('memory_save', { layer: 'L1', entry: { topic: 'pro-ok', content: 'c' } });
  check('362-3 pro → v2 工具通過', !ok.tier_gate && !!ok.id, JSON.stringify(ok).slice(0, 140));
  check('    記憶矩陣也通過', !(await call('memory_stats')).tier_gate);
  const full = await call('start_auto_detect', { depth: 'full' });
  check('362-4 pro + full 模式 → 被擋（需 Max）', full.tier_gate === true && /Max NT\$200/.test(full.error), JSON.stringify(full).slice(0, 200));
  check('    訊息點名是 full 模式，不是整支工具不能用', /full 模式/.test(full.error), String(full.error).slice(0, 120));
  const quick = await call('start_auto_detect', { depth: 'quick' });
  check('    🔴 pro + quick 模式 → 不被閘門擋（擋的是 full，不是整支）',
    quick.tier_gate !== true, JSON.stringify(quick).slice(0, 160));
  const dflt = await call('start_auto_detect', {});
  check('    省略 depth 視同 quick → 不被擋', dflt.tier_gate !== true, JSON.stringify(dflt).slice(0, 140));
});

console.log('\n=== ⑥ max / agent → full 模式通過 ===');
for (const [tier, port] of [['max', 19878], ['agent', 19879]]) {
  await withBridge({ ENFORCE_TIER_GATE: 'true', BUGEZY_USER_TIER: tier }, port, async ({ call }) => {
    const full = await call('start_auto_detect', { depth: 'full' });
    check(`    ${tier} + full → 通過閘門`, full.tier_gate !== true, JSON.stringify(full).slice(0, 140));
  });
}

console.log('\n=== ⑦ 不認得的方案值 → 降到 free（fail closed）===');
await withBridge({ ENFORCE_TIER_GATE: 'true', BUGEZY_USER_TIER: 'superuser' }, 19880, async ({ call }) => {
  const r = await call('memory_stats');
  check('    打錯的 tier 當作 free 擋下來，不是當作最高權限', r.tier_gate === true, JSON.stringify(r).slice(0, 140));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
