// PM-355~360 驗收：§14 記憶矩陣（純檔案系統邏輯，直接載入編譯後的模組）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LAYERS, LAYER_FILES, GITIGNORE_CONTENT, DEFAULT_CONFIG, L3_MESSAGE,
  findBugezyDir, initMemoryStore, storeRoot, ensureStore, readConfig,
  readLayer, writeLayer, _resetStore,
} from './dist/memory-store.js';
import {
  memorySave, memoryLearn, memorySearch, memoryGet,
  memoryAudit, memoryPerfCheck, memoryBizValidate,
  memoryUpdate, memoryDelete, memoryList, memoryClear,
  memoryExport, memoryImport, memoryStats, extractTags,
} from './dist/memory-ops.js';

let pass = 0, fail = 0;
const check = (l, ok, extra = '') => { ok ? pass++ : fail++; console.log(ok ? '  PASS ' : '  FAIL ', l, ok ? '' : '→ ' + extra); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bugezy-mem-'));
const proj = path.join(tmp, 'my-project');
const nested = path.join(proj, 'src', 'deep');
fs.mkdirSync(nested, { recursive: true });

console.log('\n=== ① PM-355 目錄基礎建設 ===');
_resetStore(nested);
check('355-2 沒有 .bugezy/ → 空白記憶不報錯', storeRoot() === null && readLayer('L1').length === 0);
check('    memory_stats 誠實回報「尚未建立」', (() => {
  const s = memoryStats();
  return s.initialized === false && typeof s.note === 'string';
})(), JSON.stringify(memoryStats()).slice(0, 120));

const root = ensureStore();
check('    ensureStore 建立在搜尋起點', root === path.join(nested, '.bugezy'), root);

// 改從專案根建立，模擬真實情況（.bugezy 與 .git 同層）
fs.rmSync(root, { recursive: true, force: true });
_resetStore(proj);
const projRoot = ensureStore();
_resetStore(nested);
check('355-1 從子目錄往上找得到 .bugezy/', findBugezyDir(nested) === projRoot, String(findBugezyDir(nested)));
check('    載入成功（storeRoot 指向專案根）', storeRoot() === projRoot);

const gi = fs.readFileSync(path.join(projRoot, '.gitignore'), 'utf8');
check('355-3 .gitignore 是自我忽略樣式', gi === GITIGNORE_CONTENT && /^\*\n!\.gitignore\n$/.test(gi), JSON.stringify(gi));

const cfg = JSON.parse(fs.readFileSync(path.join(projRoot, 'config.json'), 'utf8'));
check('355-4 config.json 四個預設值正確',
  cfg.L1_max_entries === 2000 && cfg.L7_retention_days === 90 && cfg.auto_merge === true && cfg.auto_evict === true,
  JSON.stringify(cfg));
check('    auto_merge 尚未實作一事寫在檔案裡（不假裝有效）', typeof cfg._note === 'string' && /auto_merge/.test(cfg._note));
check('    readConfig 讀得到', readConfig().L1_max_entries === 2000);

for (const l of LAYERS) memorySave(l, { topic: `seed-${l}`, content: `${l} 的種子資料` });
const files = fs.readdirSync(path.join(projRoot, 'memory')).sort();
check('355-5 本機只有 7 個 JSON', files.length === 7, files.join(','));
check('355-5 沒有 L3 檔案', !files.some((f) => f.startsWith('L3')) && !LAYERS.includes('L3'), files.join(','));
check('    七個檔名與規格書一致', files.join(',') === LAYERS.map((l) => LAYER_FILES[l]).sort().join(','), files.join(','));
check('    L3 有專屬說明而不是「不合法的層」', /雲端/.test(L3_MESSAGE));

console.log('\n=== ② PM-356 寫入 ===');
const s1 = memorySave('L1', { topic: 'TypeError map of undefined', content: 'API 回傳 null，加 ?? [] 防護', tags: ['api'] });
check('356-1 memory_save 回傳 id', typeof s1.id === 'string' && s1.id.length > 10 && s1.layer === 'L1', JSON.stringify(s1).slice(0, 150));
check('    寫入後立刻讀得到', readLayer('L1').some((e) => e.id === s1.id));

const l1 = memoryLearn({ symptom: 'ReferenceError: cartTotal is not defined', fix: '在 useCart.ts 補上初始值', root_cause: '解構時漏了預設值', related_files: ['src/useCart.ts'] });
check('356-2 memory_learn 自動存入 L1', l1.layer === 'L1' && readLayer('L1').some((e) => e.id === l1.id));
const learned = readLayer('L1').find((e) => e.id === l1.id);
check('    自動萃取 tags', learned.content.tags.includes('ReferenceError') && learned.content.tags.includes('src/useCart.ts'), JSON.stringify(learned.content.tags));
check('    症狀／根因／修法都進了 content', /症狀：/.test(learned.content.content) && /根因：/.test(learned.content.content) && /修法：/.test(learned.content.content));
check('    extractTags 不亂塞短雜訊詞', !extractTags('the a bug is here').includes('the'));

// 356-3 淘汰：看 last_hit_at 而非 created_at
fs.writeFileSync(path.join(projRoot, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG, L1_max_entries: 3 }, null, 2));
const mk = (topic, created, hit) => ({
  id: `fix-${topic}`, created_at: created, updated_at: created, last_hit_at: hit, hit_count: 1,
  content: { topic, content: topic, tags: [] },
});
writeLayer('L1', [
  mk('old-but-hot', '2020-01-01T00:00:00.000Z', '2026-08-17T00:00:00.000Z'), // 三年前寫、最近才命中
  mk('new-but-cold', '2026-08-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z'), // 上週寫、很久沒命中
  mk('mid', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
]);
const ev = memorySave('L1', { topic: 'brand-new', content: 'x' });
const afterEvict = readLayer('L1').map((e) => e.content.topic);
check('356-3 超過 max_entries → 淘汰最久沒 hit 的', ev.evicted === 1 && !afterEvict.includes('new-but-cold'), afterEvict.join(','));
check('    🔴 三年前寫但最近命中的沒被砍（看 last_hit_at 不看 created_at）', afterEvict.includes('old-but-hot'), afterEvict.join(','));
fs.writeFileSync(path.join(projRoot, 'config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2));

// L7 retention
writeLayer('L7', [
  mk('ancient-baseline', '2020-01-01T00:00:00.000Z', '2026-08-17T00:00:00.000Z'),
  mk('recent-baseline', new Date().toISOString(), new Date().toISOString()),
]);
memorySave('L7', { topic: 'API response time', content: '200 ms' });
const l7topics = readLayer('L7').map((e) => e.content.topic);
check('    L7 額外套 retention_days（90 天前的基準被清）', !l7topics.includes('ancient-baseline') && l7topics.includes('recent-baseline'), l7topics.join(','));

// 356-5 持久化：模擬 bridge 重啟
_resetStore(nested);
check('356-5 重啟後記憶仍在（重新從 CWD 往上找）', readLayer('L1').some((e) => e.content.topic === 'brand-new'));

console.log('\n=== ③ PM-357 讀取 ===');
writeLayer('L1', []); writeLayer('L2', []); writeLayer('L5', []);
const a1 = memorySave('L1', { topic: 'stripe webhook 簽章驗證失敗', content: '要用 raw body，不能用 parsed json' });
const a2 = memorySave('L2', { topic: '資料庫欄位慣例', content: '時間一律用 timestamptz，不要用 timestamp' });
const a3 = memorySave('L5', { topic: 'stripe API', content: '每天 8:30 例行維護會回 503，屬正常' });
const found = memorySearch('stripe', undefined, 10);
check('357-1 跨層搜到（L1 + L5）', found.total_found === 2 && new Set(found.results.map((r) => r.layer)).size === 2, JSON.stringify(found.results.map((r) => r.layer)));
const ranked = memorySearch('stripe webhook', undefined, 10);
check('357-2 按 score 排序（topic 命中權重 ×3）', ranked.results[0].id === a1.id && ranked.results[0].score > ranked.results[1].score, JSON.stringify(ranked.results.map((r) => [r.topic, r.score])));
check('    tags 命中權重 ×2 > 內文 ×1', (() => {
  writeLayer('L8', []);
  const t = memorySave('L8', { topic: 'zzz', content: 'zzz', tags: ['owner-max'] });
  const c = memorySave('L8', { topic: 'yyy', content: '負責人 owner-max 要 review' });
  const r = memorySearch('owner-max', ['L8'], 5);
  return r.results[0].id === t.id;
})());

const g = memoryGet('L2', '資料庫欄位慣例');
check('357-3 memory_get 精準回傳', g.count === 1 && /timestamptz/.test(g.entries[0].content), JSON.stringify(g).slice(0, 150));
check('    memory_get 是完全匹配，不是模糊', memoryGet('L2', '資料庫').count === 0);

const beforeHit = readLayer('L1').find((e) => e.id === a1.id);
memorySearch('stripe', ['L1'], 10);
const afterHit = readLayer('L1').find((e) => e.id === a1.id);
check('357-4 搜尋後 hit_count + last_hit_at 更新',
  afterHit.hit_count > beforeHit.hit_count && Date.parse(afterHit.last_hit_at) >= Date.parse(beforeHit.last_hit_at),
  `${beforeHit.hit_count}→${afterHit.hit_count}`);
const h1 = readLayer('L2').find((e) => e.id === a2.id).hit_count;
memoryGet('L2', '資料庫欄位慣例');
check('    🔴 memory_get 不更新 hit_count（精準提取不算使用頻率）',
  readLayer('L2').find((e) => e.id === a2.id).hit_count === h1);

const none = memorySearch('這個詞絕對不存在xyz', undefined, 10);
check('357-5 沒有結果 → 空陣列', Array.isArray(none.results) && none.results.length === 0 && none.total_found === 0);
check('    空結果附說明（「還沒學過」而不是「搜尋失敗」）', /還沒學過/.test(none.note), String(none.note));
check('    指定層搜尋只搜該層', memorySearch('stripe', ['L5'], 10).total_found === 1);

console.log('\n=== ④ PM-358 三支守衛（唯讀）===');
writeLayer('L6', []); writeLayer('L7', []); writeLayer('L4', []);

const emptyAudit = memoryAudit('+const x = 1;');
check('358-4 L6 沒有規則 → passed + 提示存入', emptyAudit.passed === true && /memory_save/.test(emptyAudit.summary), emptyAudit.summary);

memorySave('L6', { topic: '嚴禁把金鑰寫死在程式碼', content: 'API_KEY / JWT_SECRET / DB 密碼必須走 process.env' });
memorySave('L6', { topic: '禁止 console.log 印出使用者資料', content: '日誌不得含個資', tags: ['regex:console\\.log\\(.*user'] });

const diff = [
  'diff --git a/src/pay.ts b/src/pay.ts',
  '--- a/src/pay.ts',
  '+++ b/src/pay.ts',
  '@@ -10,3 +10,5 @@',
  '+const API_KEY = "sk-live-supersecret-123456";',
  '+console.log("user", user.email);',
  ' const ok = true;',
].join('\n');
const aud = memoryAudit(diff);
check('358-1 L6 有規則 + diff 違反 → violations 非空', aud.passed === false && aud.violations.length >= 2, JSON.stringify(aud.violations).slice(0, 240));
check('    內建機密樣式引用到對應的 L6 鐵律', aud.violations.some((v) => /金鑰/.test(v.rule)), JSON.stringify(aud.violations.map((v) => v.rule)));
check('    L6 自訂 regex 規則也被逐條檢查', aud.violations.some((v) => v.matched_pattern === 'L6 自訂 regex'));
check('    🔴 違規訊息不回傳原始行（不把機密再複製一份進 context）',
  !JSON.stringify(aud).includes('sk-live-supersecret-123456'), JSON.stringify(aud).slice(0, 200));
check('    只掃新增行：被刪掉的機密不報', memoryAudit('--- a/x\n+++ b/x\n@@ -1,2 +1,1 @@\n-const API_KEY = "sk-live-abcdefgh";\n const y = 1;').violations.length === 0);
const cleanAudit = memoryAudit('+++ b/x\n@@ -1 +1,2 @@\n+const a = 1;');
check('    🔴 passed:true 時明講「還有幾條只能人工判讀」',
  cleanAudit.passed === true && cleanAudit.rules_needing_ai_review.length >= 1 && /不代表全部合規/.test(cleanAudit.summary),
  cleanAudit.summary);

const emptyPerf = memoryPerfCheck({ name: 'API response time', value: 180, unit: 'ms' });
check('358-4 L7 沒有基準 → 不亂判 + 提示存入', emptyPerf.baseline === null && /memory_save/.test(emptyPerf.suggestion));
memorySave('L7', { topic: 'API response time', content: '200 ms' });
const deg = memoryPerfCheck({ name: 'API response time', value: 2000, unit: 'ms' });
check('358-2 L7 有基準 + 衰退 → degraded', deg.status === 'degraded' && deg.change_percent === 900, JSON.stringify(deg).slice(0, 200));
check('    改善 → improved', memoryPerfCheck({ name: 'API response time', value: 100, unit: 'ms' }).status === 'improved');
check('    ±10% 內 → stable', memoryPerfCheck({ name: 'API response time', value: 205, unit: 'ms' }).status === 'stable');
memorySave('L7', { topic: 'throughput', content: '{"value":1000,"unit":"ops/s"}' });
const ops = memoryPerfCheck({ name: 'throughput', value: 3000, unit: 'ops/s' });
check('    🔴 ops/s 變大是進步，不是衰退（方向判斷）', ops.status === 'improved' && ops.direction === 'higher_is_better', JSON.stringify(ops).slice(0, 160));
check('    🔴 ops/s 變小才是衰退', memoryPerfCheck({ name: 'throughput', value: 100, unit: 'ops/s' }).status === 'degraded');
const mismatch = memoryPerfCheck({ name: 'API response time', value: 128, unit: 'MB' });
check('    🔴 單位不同 → 拒絕比較（不硬湊出一個結論）', mismatch.status === 'unknown' && mismatch.change_percent === null, JSON.stringify(mismatch).slice(0, 160));

const emptyBiz = memoryBizValidate({ context: 'prize calculation', result: { sum: 1.2 } });
check('358-4 L4 沒有規則 → 不亂判 + 提示存入', emptyBiz.valid === true && /memory_save/.test(emptyBiz.summary));
memorySave('L4', { topic: '勝率加總必須等於 1', content: '冷熱門號碼權重加總必須剛好 100%', tags: ['regex:"total"\\s*:\\s*1(\\.0+)?[,}]'] });
const bad = memoryBizValidate({ context: 'prize calculation', result: { total: 1.2 } });
check('358-3 L4 有規則 + 輸出衝突 → conflicts 非空', bad.valid === false && bad.conflicts.length === 1, JSON.stringify(bad.conflicts).slice(0, 200));
check('    符合規則 → valid', memoryBizValidate({ context: 'prize calculation', result: { total: 1 } }).valid === true);
memorySave('L4', { topic: '分母不得為 0', content: '權重計算任何時候分母都不能為 0' });
const partial = memoryBizValidate({ context: 'prize calculation', result: { total: 1 } });
check('    🔴 valid:true 時明講「還有幾條要自己判讀」',
  partial.rules_needing_ai_review.length >= 1 && /不代表商業邏輯/.test(partial.summary), partial.summary);
check('    related_rules 可縮小比對範圍', memoryBizValidate({ context: 'x', result: {}, related_rules: ['分母'] }).rules_considered === 1);

// 358-5：三支守衛不修改任何檔案
const snapshot = () => LAYERS.map((l) => fs.readFileSync(path.join(projRoot, 'memory', LAYER_FILES[l]), 'utf8')).join('|');
const before = snapshot();
memoryAudit(diff); memoryPerfCheck({ name: 'API response time', value: 999, unit: 'ms' }); memoryBizValidate({ context: 'x', result: { total: 9 } });
check('358-5 三支守衛不修改任何檔案（決策 6）', snapshot() === before);

console.log('\n=== ⑤ PM-359 CRUD 管理 ===');
writeLayer('L1', []);
const u = memorySave('L1', { topic: '原主題', content: '最初的修法：加 ?? []', tags: ['old'] });
const before2 = readLayer('L1').find((e) => e.id === u.id).updated_at;
await new Promise((r) => setTimeout(r, 5));
const up = memoryUpdate('L1', u.id, { content: '更好的修法：改用 Zod schema' });
const after2 = readLayer('L1').find((e) => e.id === u.id);
check('359-1 部分更新成功 + updated_at 前進', up.id === u.id && after2.content.content === '更好的修法：改用 Zod schema' && after2.updated_at !== before2);
check('    沒帶的欄位保持原樣', after2.content.topic === '原主題' && after2.content.tags.join() === 'old');

const long = memorySave('L1', { topic: '長內容', content: 'x'.repeat(500) });
const listed = memoryList('L1', 50, 'updated_at');
const longRow = listed.entries.find((e) => e.id === long.id);
check('359-3 memory_list 回 content_preview 且截斷到 200', longRow.content_preview.length === 201 && longRow.truncated === true, String(longRow.content_preview.length));
check('    短內容不截斷', listed.entries.find((e) => e.id === u.id).truncated === false);
check('    sort_by 有效', memoryList('L1', 50, 'hit_count').sorted_by === 'hit_count');

check('359-2 memory_delete 刪除成功', memoryDelete('L1', long.id).deleted === true && !readLayer('L1').some((e) => e.id === long.id));
check('359-6 delete id 不存在 → error', !!memoryDelete('L1', 'no-such-id').error && memoryDelete('L1', 'no-such-id').deleted === false);
check('359-6 update id 不存在 → error', !!memoryUpdate('L1', 'no-such-id', { topic: 'x' }).error);

const refuse = memoryClear('L1', false);
check('359-5 memory_clear 沒帶 confirm → 拒絕', refuse.cleared === 0 && !!refuse.error && readLayer('L1').length > 0);
check('    拒絕時告訴你會損失幾條', refuse.would_clear === readLayer('L1').length && /無法復原/.test(refuse.error), JSON.stringify(refuse).slice(0, 160));
const n = readLayer('L1').length;
check('359-4 memory_clear({confirm:true}) → 清空', memoryClear('L1', true).cleared === n && readLayer('L1').length === 0);

console.log('\n=== ⑥ PM-360 匯出匯入 ===');
writeLayer('L1', []); writeLayer('L2', []);
const e1 = memorySave('L1', { topic: '匯出測試 A', content: 'AAA' });
const e2 = memorySave('L2', { topic: '匯出測試 B', content: 'BBB' });
const exp = memoryExport(undefined, undefined);
check('360-1 memory_export 產出 JSON 檔案', fs.existsSync(exp.path) && exp.total_entries >= 2, JSON.stringify({ p: exp.path, t: exp.total_entries }));
check('    預設檔名是 .bugezy-backup-YYYYMMDD.json 且在專案根', /[\\/]\.bugezy-backup-\d{8}\.json$/.test(exp.path), exp.path);
const payload = JSON.parse(fs.readFileSync(exp.path, 'utf8'));
check('    格式含 version / exported_at / project / layers', payload.version === '1.0' && !!payload.exported_at && !!payload.project && !!payload.layers);
check('    匯出檔不含 L3', !('L3' in payload.layers));
check('    🔴 匯出附敏感警告且點出它不受 .bugezy/.gitignore 保護',
  /憑證/.test(exp.warning) && /gitignore/.test(exp.warning), String(exp.warning).slice(0, 120));

memoryUpdate('L1', e1.id, { content: '本機已改成 AAA-modified' });
const merged = memoryImport(exp.path, 'merge');
check('360-2 merge：同 id 跳過不覆蓋',
  merged.conflicts >= 1 && readLayer('L1').find((x) => x.id === e1.id).content.content === '本機已改成 AAA-modified',
  JSON.stringify(merged));
const over = memoryImport(exp.path, 'overwrite');
check('360-3 overwrite：同 id 覆蓋', over.imported >= 1 && readLayer('L1').find((x) => x.id === e1.id).content.content === 'AAA');

check('360-4 匯入檔不存在 → error', !!memoryImport(path.join(tmp, 'nope.json'), 'merge').error);
const badFile = path.join(tmp, 'bad.json');
fs.writeFileSync(badFile, '{"version":"1.0"}');
check('360-4 格式錯誤（缺 layers）→ error', !!memoryImport(badFile, 'merge').error);
fs.writeFileSync(badFile, 'not json at all');
check('360-4 不是 JSON → error 而不是拋例外', !!memoryImport(badFile, 'merge').error);

const l3File = path.join(tmp, 'with-l3.json');
fs.writeFileSync(l3File, JSON.stringify({ version: '1.0', layers: { L3: [{ id: 'x', content: { topic: 't', content: 'c' } }], L2: [] } }));
const l3imp = memoryImport(l3File, 'merge');
check('    🔴 匯入檔含 L3 → 列為 ignored 而非寫入本機', l3imp.ignored_layers?.includes('L3') && !fs.existsSync(path.join(projRoot, 'memory', 'L3-support.json')), JSON.stringify(l3imp));

// 360-5 匯出後匯入 → 資料一致
writeLayer('L1', []); writeLayer('L2', []);
const roundtrip = memoryImport(exp.path, 'overwrite');
const rt1 = readLayer('L1').find((x) => x.id === e1.id);
const rt2 = readLayer('L2').find((x) => x.id === e2.id);
check('360-5 匯出後匯入 → 資料一致',
  rt1?.content.content === 'AAA' && rt2?.content.content === 'BBB' && roundtrip.imported >= 2,
  JSON.stringify({ rt1: rt1?.content.content, rt2: rt2?.content.content }));
check('    匯入只寫 .bugezy/，沒有在專案裡多生檔案',
  fs.readdirSync(proj).sort().join(',') === ['.bugezy', `.bugezy-backup-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`, 'src'].sort().join(','),
  fs.readdirSync(proj).join(','));

console.log('\n=== ⑦ 完整流程 save → search → update → export → clear → import ===');
writeLayer('L1', []);
const f1 = memorySave('L1', { topic: '流程測試', content: '原始內容' });
check('flow 1 save', memorySearch('流程測試', ['L1'], 5).total_found === 1);
memoryUpdate('L1', f1.id, { content: '更新後內容' });
const flowExp = memoryExport(['L1'], path.join(tmp, 'flow.json'));
check('flow 2 export', fs.existsSync(flowExp.path) && flowExp.total_entries === 1);
memoryClear('L1', true);
check('flow 3 clear', readLayer('L1').length === 0 && memorySearch('流程測試', ['L1'], 5).total_found === 0);
memoryImport(flowExp.path, 'merge');
const restored = memorySearch('流程測試', ['L1'], 5);
check('flow 4 import 後搜得回來，且是更新後的版本',
  restored.total_found === 1 && restored.results[0].content === '更新後內容', JSON.stringify(restored.results).slice(0, 160));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
