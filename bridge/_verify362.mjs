// PM-362 / PM-374 驗收：方案分層閘門。真的 spawn bridge，方案真的向（mock）Workers 查。
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { TOOL_TIER_MAP, tierRank } from './dist/tier-gate.js';
import { startMockWorkers } from './_mock-workers.mjs';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };
const isWin = process.platform === 'win32';
const killTree = (pid) => { try { if (isWin) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(pid, 'SIGKILL'); } catch { /* 已死 */ } };

/** 起一個 bridge。`tier` 為 null 代表「不給 token」（模擬使用者沒設定）。 */
async function withBridge({ tier = null, extraEnv = {}, port }, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bugezy-tier-'));
  const mock = tier ? await startMockWorkers(tier) : null;
  const env = { ...process.env, BUGEZY_BRIDGE_PORT: String(port), ...extraEnv };
  delete env.BUGEZY_SESSION_TOKEN;
  delete env.BUGEZY_WORKERS_URL;
  delete env.BUGEZY_USER_EMAIL;
  if (mock) {
    env.BUGEZY_WORKERS_URL = mock.url;
    env.BUGEZY_SESSION_TOKEN = 'verify-token-0123456789';
    env.BUGEZY_USER_EMAIL = 'verify@example.com';
  }
  Object.assign(env, extraEnv);
  const proc = spawn(process.execPath, [path.resolve('dist/index.js')], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
  let buf = '', stderr = ''; const w = new Map(); let id = 1;
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
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
    await new Promise((r) => setTimeout(r, 1500));
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'v', version: '1' } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await fn({ call, rpc, stderr: () => stderr });
  } finally {
    killTree(proc.pid);
    mock?.srv.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

console.log('\n=== ① 對照表涵蓋率（雙向比對，新增工具漏列會失敗）===');
let registered = [];
await withBridge({ tier: 'agent', port: 19871 }, async ({ rpc }) => {
  registered = (await rpc('tools/list', {})).result.tools.map((t) => t.name).sort();
});
const mapped = Object.keys(TOOL_TIER_MAP).sort();
check(`362-1 對照表涵蓋全部 ${registered.length} 支工具`, registered.length === 51 && mapped.length === 51, `註冊 ${registered.length} / 對照表 ${mapped.length}`);
check('    沒有工具漏列在對照表裡', registered.filter((t) => !(t in TOOL_TIER_MAP)).length === 0, registered.filter((t) => !(t in TOOL_TIER_MAP)).join(','));
check('    對照表裡沒有已不存在的工具', mapped.filter((t) => !registered.includes(t)).length === 0, mapped.filter((t) => !registered.includes(t)).join(','));
check('    ping / get_page_url 是 free', TOOL_TIER_MAP.ping === 'free' && TOOL_TIER_MAP.get_page_url === 'free');
check('    tier 高低順序 free < ticket < pro < max < agent',
  tierRank('free') < tierRank('ticket') && tierRank('ticket') < tierRank('pro')
  && tierRank('pro') < tierRank('max') && tierRank('max') < tierRank('agent'));

console.log('\n=== ② PM-374 驗收 1：不帶 token 啟動 → free，v2 被擋 ===');
await withBridge({ tier: null, port: 19872 }, async ({ call, stderr }) => {
  const r = await call('memory_stats');
  check('374-1 沒有 token → v2 工具被擋', r.tier_gate === true && !!r.error, JSON.stringify(r).slice(0, 200));
  check('374   🔴 閘門「預設開啟」（沒設任何 ENFORCE_TIER_GATE 也擋）', r.tier_gate === true);
  check('374   錯誤訊息說明是「沒設 token」而不是只說沒訂閱',
    /BUGEZY_SESSION_TOKEN/.test(r.error || ''), String(r.error).slice(0, 200));
  check('    ping / get_page_url 仍可用（否則無法排查 bridge 為何不能用）',
    !(await call('ping')).tier_gate && !(await call('get_page_url')).tier_gate);
  check('    啟動訊息印出方案判定，使用者看得到原因', /方案閘門/.test(stderr()), stderr().slice(0, 200));
});

console.log('\n=== ③ PM-374 驗收 4：不能再用環境變數宣稱方案 ===');
await withBridge({ tier: null, port: 19873, extraEnv: { BUGEZY_USER_TIER: 'agent' } }, async ({ call }) => {
  check('374-4 🔴 設 BUGEZY_USER_TIER=agent 無效（舊的繞過方式已移除）',
    (await call('memory_stats')).tier_gate === true);
});

console.log('\n=== ④ PM-374 驗收 2：帶有效 token → 正確 tier ===');
await withBridge({ tier: 'pro', port: 19874 }, async ({ call }) => {
  const ok = await call('memory_save', { layer: 'L1', entry: { topic: 'pro-ok', content: 'c' } });
  check('374-2 pro token → v2 工具通過', !ok.tier_gate && !!ok.id, JSON.stringify(ok).slice(0, 150));
  const full = await call('start_auto_detect', { depth: 'full' });
  check('362-4 pro + full 模式 → 被擋（需 Max）', full.tier_gate === true && /Max NT\$200/.test(full.error), JSON.stringify(full).slice(0, 200));
  check('    訊息點名是 full 模式，不是整支工具不能用', /full 模式/.test(full.error), String(full.error).slice(0, 120));
  check('    🔴 pro + quick 模式不被擋（擋的是 full，不是整支）',
    (await call('start_auto_detect', { depth: 'quick' })).tier_gate !== true);
});

for (const [tier, port] of [['max', 19875], ['agent', 19876]]) {
  await withBridge({ tier, port }, async ({ call }) => {
    check(`    ${tier} + full → 通過閘門`, (await call('start_auto_detect', { depth: 'full' })).tier_gate !== true);
  });
}
for (const [tier, port] of [['ticket', 19877], ['day_pass', 19878]]) {
  await withBridge({ tier, port }, async ({ call }) => {
    const r = await call('navigate_to', { url: 'https://example.com/' });
    check(`    ${tier} → v2 被擋且明講「僅含 v1 錄製」`, r.tier_gate === true && /僅包含 v1/.test(r.error), String(r.error).slice(0, 140));
  });
}
await withBridge({ tier: 'free', port: 19879 }, async ({ call }) => {
  check('    Workers 回 free → v2 被擋', (await call('memory_stats')).tier_gate === true);
});

console.log('\n=== ⑤ PM-374 驗收 3：Workers 不可達 → free + 警告 ===');
await withBridge({
  tier: null, port: 19880,
  extraEnv: { BUGEZY_SESSION_TOKEN: 'looks-valid-but-nowhere-to-ask', BUGEZY_WORKERS_URL: 'http://127.0.0.1:1' },
}, async ({ call, stderr }) => {
  const r = await call('memory_stats');
  check('374-3 🔴 Workers 不可達 → 降級 free 並擋下（不是失敗即放行）', r.tier_gate === true, JSON.stringify(r).slice(0, 200));
  check('374-3 訊息說明是「查不到方案」而非「你沒訂閱」',
    /無法向|降級為 Free/.test(r.error || '') || /無法向/.test(stderr()), String(r.error).slice(0, 220));
});

console.log('\n=== ⑥ 逃生門：明確關閉閘門 ===');
await withBridge({ tier: null, port: 19881, extraEnv: { ENFORCE_TIER_GATE: 'false' } }, async ({ call }) => {
  check('    ENFORCE_TIER_GATE=false → 全放行（保留給排查用）',
    !(await call('memory_stats')).tier_gate);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
