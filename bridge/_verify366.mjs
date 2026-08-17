// PM-366 驗收：安全修復。真的起 bridge、真的用網頁 Origin 去連。
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { WebSocket } from 'ws';
import { memoryExport, memoryImport, memorySave, MAX_CONTENT_LEN, MAX_IMPORT_BYTES } from './dist/memory-ops.js';
import { _resetStore, ensureStore } from './dist/memory-store.js';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };
const isWin = process.platform === 'win32';
const killTree = (pid) => { try { if (isWin) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(pid, 'SIGKILL'); } catch { /* 已死 */ } };

console.log('\n=== ① P0：Bridge WebSocket Origin 驗證 ===');
const PORT = 19891;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bugezy-sec-'));
const proc = spawn(process.execPath, [path.resolve('dist/index.js')], {
  cwd, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, BUGEZY_BRIDGE_PORT: String(PORT) },
});
proc.stdout.on('data', () => {});
proc.stderr.on('data', () => {});
await new Promise((r) => setTimeout(r, 1200));

/** 用指定的 Origin 連線，回傳 'open' | 'rejected'。 */
function tryConnect(origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, origin === null ? {} : { headers: { Origin: origin } });
    const done = (v) => { try { ws.close(); } catch { /* ignore */ } resolve(v); };
    ws.on('open', () => done('open'));
    ws.on('error', () => done('rejected'));
    ws.on('unexpected-response', () => done('rejected'));
    setTimeout(() => done('timeout'), 5000);
  });
}

for (const origin of ['https://evil.example.com', 'http://localhost:3000', 'https://bugezy.dev', 'null']) {
  const r = await tryConnect(origin);
  check(`    🔴 網頁 Origin ${origin} → 被拒`, r === 'rejected', r);
}
check('    擴充功能 Origin → 放行',
  (await tryConnect('chrome-extension://abcdefghijklmnopabcdefghijklmnop')) === 'open');
check('    沒有 Origin 的本機工具 → 放行（本機程式本來就能偽造 header，擋它沒有意義）',
  (await tryConnect(null)) === 'open');
// 惡意頁面連不上，就無法把真正的 Extension 踢掉
check('    🔴 被拒的連線無法取代既有的 Extension 連線', await (async () => {
  const ext = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { Origin: 'chrome-extension://realextensionidxxxxxxxxxxxxxxxx' } });
  await new Promise((r) => ext.on('open', r));
  await tryConnect('https://evil.example.com');
  await new Promise((r) => setTimeout(r, 400));
  const alive = ext.readyState === WebSocket.OPEN;
  ext.close();
  return alive;
})());
killTree(proc.pid);
fs.rmSync(cwd, { recursive: true, force: true });

console.log('\n=== ② P1：memory_export 不能寫到專案外 ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bugezy-sec2-'));
const proj = path.join(tmp, 'proj');
fs.mkdirSync(proj, { recursive: true });
_resetStore(proj);
ensureStore();
memorySave('L1', { topic: 'sec', content: 'x' });

const outsideTargets = [
  path.join(tmp, 'escaped.json'),
  path.join(proj, '..', 'escaped2.json'),
  path.join(proj, 'a', '..', '..', 'escaped3.json'),
];
for (const t of outsideTargets) {
  const r = memoryExport(['L1'], t);
  check(`    🔴 寫到專案外被拒：${path.basename(t)}`, !!r.error && !fs.existsSync(path.resolve(t)), JSON.stringify(r).slice(0, 140));
}
const inside = memoryExport(['L1'], path.join(proj, 'sub', 'my-backup.json'));
check('    專案內的路徑仍然可用（沒有把功能擋死）', !inside.error && fs.existsSync(inside.path), JSON.stringify(inside).slice(0, 140));
const dflt = memoryExport(['L1'], undefined);
check('    預設路徑仍然可用', !dflt.error && fs.existsSync(dflt.path));

// 不覆蓋非備份檔
const src = path.join(proj, 'important.ts');
fs.writeFileSync(src, 'export const secret = 1;');
const clobber = memoryExport(['L1'], src);
check('    🔴 拒絕覆蓋既有的非備份檔', !!clobber.error && fs.readFileSync(src, 'utf8') === 'export const secret = 1;', JSON.stringify(clobber).slice(0, 140));
const reExport = memoryExport(['L1'], dflt.path);
check('    覆蓋自己產生的備份檔則允許（換電腦要重複匯出）', !reExport.error);

console.log('\n=== ③ P2：大小上限 ===');
check(`    單筆 content 上限 ${MAX_CONTENT_LEN / 1000}KB 已定義`, MAX_CONTENT_LEN === 100_000);
const big = path.join(tmp, 'huge.json');
fs.writeFileSync(big, '{"version":"1.0","layers":{}}');
// 假裝它很大：直接驗證上限值與錯誤路徑
check(`    匯入上限 ${MAX_IMPORT_BYTES / 1048576}MB 已定義`, MAX_IMPORT_BYTES === 50 * 1024 * 1024);
check('    匯入不存在的檔 → error 而非例外', !!memoryImport(path.join(tmp, 'nope.json'), 'merge').error);
check('    正常大小的檔仍可匯入', !memoryImport(dflt.path, 'merge').error);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
