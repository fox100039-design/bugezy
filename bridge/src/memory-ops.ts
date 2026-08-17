// PM-356~360：§14 記憶矩陣的 13 支工具背後的邏輯。
//
// 全部只讀寫 `.bugezy/`，**專案原始碼一個位元組都不會動**（決策 6）。
// 三支守衛（audit / perf_check / biz_validate）連 `.bugezy/` 都不寫。

import fs from 'node:fs';
import path from 'node:path';
import {
  LAYERS, LAYER_NAMES, type Layer, type MemoryEntry, type MemoryContent,
  readLayer, writeLayer, applyEviction, readConfig, storeRoot, ensureStore, newEntry,
} from './memory-store.js';

const nowIso = () => new Date().toISOString();

// ── PM-356：寫入 ────────────────────────────────────────────────────────────
export function memorySave(layer: Layer, entry: MemoryContent): Record<string, unknown> {
  const entries = readLayer(layer);
  const e = newEntry(entry);
  entries.push(e);
  const ev = applyEviction(layer, entries);
  writeLayer(layer, entries);
  return {
    id: e.id,
    layer,
    topic: e.content.topic,
    created_at: e.created_at,
    total_in_layer: entries.length,
    ...(ev.evicted ? { evicted: ev.evicted, evicted_reason: ev.reason } : {}),
    stored_at: path.join(storeRoot() ?? '(未建立)', 'memory'),
  };
}

/** 從症狀與修法裡挑關鍵字當 tags。刻意保守——寧可少給幾個，也不要塞一堆雜訊詞進去讓搜尋失準。 */
export function extractTags(...texts: string[]): string[] {
  const blob = texts.join(' ');
  const out = new Set<string>();
  // ① 經典錯誤型別
  for (const m of blob.matchAll(/\b([A-Z][a-zA-Z]*(?:Error|Exception))\b/g)) out.add(m[1]);
  // ② 識別字（camelCase / snake_case / dotted），長度 >= 4
  for (const m of blob.matchAll(/\b([a-zA-Z_$][\w$]*(?:[.\-][\w$]+)+|[a-z]+[A-Z]\w+|\w*_\w+)\b/g)) {
    if (m[1].length >= 4) out.add(m[1]);
  }
  // ③ 檔名
  for (const m of blob.matchAll(/\b([\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|sql|json))\b/g)) out.add(m[1]);
  return [...out].slice(0, 12);
}

export function memoryLearn(session: {
  symptom: string;
  fix: string;
  root_cause?: string;
  related_files?: string[];
}): Record<string, unknown> {
  const tags = [...new Set([...extractTags(session.symptom, session.fix, session.root_cause ?? ''), ...(session.related_files ?? [])])];
  const body = [
    `症狀：${session.symptom}`,
    session.root_cause ? `根因：${session.root_cause}` : null,
    `修法：${session.fix}`,
    session.related_files?.length ? `關鍵檔案：${session.related_files.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  const r = memorySave('L1', { topic: session.symptom, content: body, tags });
  return { ...r, layer: 'L1', symptom: session.symptom, fix: session.fix };
}

// ── PM-357：讀取 ────────────────────────────────────────────────────────────
/** 拆詞：空白切開；CJK 沒有空白時整串當一個詞（子字串比對仍然有效）。 */
function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

export function memorySearch(query: string, layers: Layer[] | undefined, limit: number): Record<string, unknown> {
  const target = layers?.length ? layers : [...LAYERS];
  const ts = terms(query);
  const hits: Array<{ layer: Layer; entry: MemoryEntry; score: number }> = [];

  for (const layer of target) {
    for (const e of readLayer(layer)) {
      const topic = (e.content?.topic ?? '').toLowerCase();
      const body = (e.content?.content ?? '').toLowerCase();
      const tags = (e.content?.tags ?? []).join(' ').toLowerCase();
      let score = 0;
      for (const t of ts) {
        if (topic.includes(t)) score += 3; // topic 命中權重 ×3
        if (tags.includes(t)) score += 2;
        if (body.includes(t)) score += 1;
      }
      if (score > 0) hits.push({ layer, entry: e, score });
    }
  }

  hits.sort((a, b) => b.score - a.score || Date.parse(b.entry.updated_at) - Date.parse(a.entry.updated_at));
  const top = hits.slice(0, limit);

  // §14.12.4：**讀也算 hit** —— 淘汰看的是「最久沒被匹配」，不更新的話等於沒有這條規則。
  // 只有真的回傳給呼叫端的那幾筆才算命中。
  const bumped = new Set(top.map((h) => h.entry.id));
  const touched = new Set(top.map((h) => h.layer));
  for (const layer of touched) {
    const entries = readLayer(layer);
    let changed = false;
    for (const e of entries) {
      if (bumped.has(e.id)) {
        e.hit_count = (e.hit_count ?? 0) + 1;
        e.last_hit_at = nowIso();
        changed = true;
      }
    }
    if (changed) writeLayer(layer, entries);
  }

  return {
    results: top.map((h) => ({
      id: h.entry.id,
      layer: h.layer,
      layer_name: LAYER_NAMES[h.layer],
      topic: h.entry.content.topic,
      content: h.entry.content.content,
      tags: h.entry.content.tags ?? [],
      score: h.score,
      created_at: h.entry.created_at,
      hit_count: (h.entry.hit_count ?? 0) + 1,
    })),
    total_found: hits.length,
    layers_searched: target,
    ...(hits.length === 0
      ? { note: `這 ${target.length} 層裡沒有符合「${query}」的記憶。這代表還沒學過，不是搜尋失敗。` }
      : {}),
  };
}

export function memoryGet(layer: Layer, topic: string): Record<string, unknown> {
  // 精準版：**完全匹配 topic**（不模糊），且**不更新 hit_count**——精準提取不算使用頻率。
  const wanted = topic.trim().toLowerCase();
  const found = readLayer(layer).filter((e) => (e.content?.topic ?? '').trim().toLowerCase() === wanted);
  return {
    entries: found.map((e) => ({
      id: e.id, topic: e.content.topic, content: e.content.content, tags: e.content.tags ?? [],
      created_at: e.created_at, updated_at: e.updated_at, hit_count: e.hit_count ?? 0,
    })),
    count: found.length,
    layer,
    ...(found.length === 0
      ? { note: `${layer} 裡沒有 topic 完全等於「${topic}」的記憶。memory_get 是精準比對，要模糊找請用 memory_search。` }
      : {}),
  };
}

// ── PM-358：三支守衛（唯讀，一個檔案都不寫）────────────────────────────────
/** 規則若在 tags 裡宣告 `regex:<pattern>`，就能被機器逐條檢查；否則只能交給 AI 讀。 */
function ruleRegex(e: MemoryEntry): RegExp | null {
  for (const t of e.content?.tags ?? []) {
    if (t.startsWith('regex:')) {
      try {
        return new RegExp(t.slice(6), 'i');
      } catch {
        return null; // 打錯的 regex 當作沒宣告，不讓一條壞規則害整支工具掛掉
      }
    }
  }
  return null;
}

/** 內建的硬編碼機密樣式。L6 是自然語言，沒有這些樣式就等於什麼都檢查不了。 */
const BUILTIN_SECRET_PATTERNS: Array<{ id: string; re: RegExp; message: string }> = [
  { id: 'hardcoded-secret', re: /\b(api[_-]?key|secret|passwd|password|token|private[_-]?key|jwt[_-]?secret)\b\s*[:=]\s*['"][^'"]{6,}['"]/i,
    message: '疑似把金鑰／密碼寫死成字串常數，應改用 process.env' },
  { id: 'db-uri-with-credentials', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:'"@/]+:[^\s:'"@/]+@/i,
    message: '連線字串內含帳號密碼，應改用環境變數' },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/,
    message: 'AWS Access Key ID 出現在程式碼中' },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    message: '私鑰內容出現在程式碼中' },
];

/** 只看 diff 的新增行（`+` 開頭、但不是 `+++` 檔頭）——被刪掉的機密不需要再報一次。 */
function addedLines(diff: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let lineNo = 0;
  for (const raw of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) { lineNo = Number(hunk[1]); continue; }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) { out.push({ line: lineNo, text: raw.slice(1) }); lineNo++; continue; }
    if (raw.startsWith('-')) continue;
    lineNo++;
  }
  return out;
}

export function memoryAudit(codeDiff: string): Record<string, unknown> {
  const rules = readLayer('L6');
  const lines = addedLines(codeDiff);
  const violations: Array<Record<string, unknown>> = [];

  for (const { line, text } of lines) {
    for (const p of BUILTIN_SECRET_PATTERNS) {
      if (!p.re.test(text)) continue;
      // 有對應的 L6 鐵律就引用它，讓 AI 知道是違反了「這個專案的哪條規定」
      const cited = rules.find((r) => {
        const blob = `${r.content?.topic ?? ''} ${r.content?.content ?? ''}`.toLowerCase();
        return /api[_-]?key|secret|password|token|私鑰|金鑰|密碼|寫死|hardcod|env/i.test(blob);
      });
      violations.push({
        rule: cited ? cited.content.topic : `(內建) ${p.id}`,
        rule_id: cited?.id ?? null,
        severity: 'critical',
        line,
        message: p.message,
        // 只回樣式名稱與行號，**不回原始行內容**——回了等於把機密再複製一份進 AI 的 context
        matched_pattern: p.id,
      });
    }
    for (const r of rules) {
      const re = ruleRegex(r);
      if (re && re.test(text)) {
        violations.push({
          rule: r.content.topic, rule_id: r.id, severity: 'critical', line,
          message: r.content.content, matched_pattern: 'L6 自訂 regex',
        });
      }
    }
  }

  const machineCheckable = rules.filter((r) => ruleRegex(r) !== null).length;
  const unchecked = rules.filter((r) => ruleRegex(r) === null);

  return {
    passed: violations.length === 0,
    violations,
    lines_scanned: lines.length,
    rules_in_L6: rules.length,
    rules_machine_checked: machineCheckable + BUILTIN_SECRET_PATTERNS.length,
    // ⚠ passed:true 不等於「資安過關」。自然語言的鐵律機器評不了，必須明著交回去給 AI 讀，
    //   否則 AI 會把「我檢查不了」讀成「檢查過沒問題」。
    rules_needing_ai_review: unchecked.map((r) => ({ id: r.id, topic: r.content.topic, rule: r.content.content })),
    summary:
      rules.length === 0
        ? `L6 尚未建立任何資安鐵律，本次只跑了 ${BUILTIN_SECRET_PATTERNS.length} 條內建機密樣式（${violations.length} 個違規）。建議用 memory_save('L6', ...) 存入這個專案的資安規定。`
        : violations.length > 0
          ? `🔴 發現 ${violations.length} 個資安違規。另有 ${unchecked.length} 條自然語言鐵律機器無法自動比對，請自行逐條檢視。`
          : `內建樣式與 ${machineCheckable} 條可機檢規則皆通過。**但還有 ${unchecked.length} 條鐵律只能由你人工／AI 判讀**——passed:true 不代表全部合規。`,
    writes_nothing: true,
  };
}

/** 這些單位是「越大越好」；其餘（ms/s/MB/KB…）越小越好。搞錯方向會把改善報成衰退。 */
const HIGHER_IS_BETTER = /^(ops\/s|op\/s|req\/s|rps|qps|fps|tps|hz|%|score)$/i;
const DEGRADE_THRESHOLD = 0.1; // ±10% 以內視為持平

function parseBaseline(e: MemoryEntry): { value: number; unit: string } | null {
  const raw = e.content?.content ?? '';
  try {
    const j = JSON.parse(raw);
    if (typeof j?.value === 'number' && typeof j?.unit === 'string') return { value: j.value, unit: j.unit };
  } catch {
    /* 不是 JSON，往下用文字解析 */
  }
  const m = /(-?\d+(?:\.\d+)?)\s*([a-zA-Z%\/]+)/.exec(raw);
  return m ? { value: Number(m[1]), unit: m[2] } : null;
}

export function memoryPerfCheck(metrics: { name: string; value: number; unit: string }): Record<string, unknown> {
  const wanted = metrics.name.trim().toLowerCase();
  const candidates = readLayer('L7').filter((e) => (e.content?.topic ?? '').trim().toLowerCase() === wanted);
  const latest = candidates.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

  if (!latest) {
    return {
      status: 'stable', baseline: null, change_percent: null,
      suggestion: `L7 裡還沒有「${metrics.name}」的基準，無法判斷是進步還是衰退。建議先用 memory_save('L7', { topic: '${metrics.name}', content: '${metrics.value} ${metrics.unit}' }) 把這次的數字存成基準。`,
      writes_nothing: true,
    };
  }

  const base = parseBaseline(latest);
  if (!base) {
    return {
      status: 'unknown', baseline: null, change_percent: null,
      suggestion: `找到「${metrics.name}」的基準記憶，但內容「${latest.content.content}」解析不出數值＋單位，無法比較。建議把 content 存成 "200 ms" 或 {"value":200,"unit":"ms"} 的格式。`,
      writes_nothing: true,
    };
  }
  // 單位不同就**拒絕比較**。硬比 ms 和 MB 會得出一個看起來很像結論的數字，比不給答案更糟。
  if (base.unit.toLowerCase() !== metrics.unit.toLowerCase()) {
    return {
      status: 'unknown',
      baseline: { value: base.value, unit: base.unit, recorded_at: latest.created_at },
      change_percent: null,
      suggestion: `單位不一致（基準是 ${base.unit}，這次傳 ${metrics.unit}），不做比較以免給出錯誤結論。請確認量的是同一件事。`,
      writes_nothing: true,
    };
  }

  const changePercent = base.value === 0 ? null : ((metrics.value - base.value) / Math.abs(base.value)) * 100;
  const higherBetter = HIGHER_IS_BETTER.test(metrics.unit);
  let status: 'improved' | 'stable' | 'degraded' = 'stable';
  if (changePercent !== null && Math.abs(changePercent) > DEGRADE_THRESHOLD * 100) {
    const better = higherBetter ? changePercent > 0 : changePercent < 0;
    status = better ? 'improved' : 'degraded';
  }

  return {
    status,
    baseline: { value: base.value, unit: base.unit, recorded_at: latest.created_at },
    change_percent: changePercent === null ? null : Number(changePercent.toFixed(2)),
    direction: higherBetter ? 'higher_is_better' : 'lower_is_better',
    suggestion:
      status === 'degraded'
        ? `🔴 ${metrics.name} 從 ${base.value}${base.unit} 變成 ${metrics.value}${metrics.unit}（${changePercent!.toFixed(1)}%），已超出 ±10% 的容許範圍。建議先確認這次修改是不是原因，再決定要不要回退。`
        : status === 'improved'
          ? `✅ ${metrics.name} 比基準好（${changePercent!.toFixed(1)}%）。確認穩定後可用 memory_update 把基準更新成新數字。`
          : `${metrics.name} 與基準相差在 ±10% 內，視為持平。`,
    // 守衛不寫檔：要更新基準請自己呼叫 memory_update，免得一次跑壞的量測默默變成新標準
    writes_nothing: true,
  };
}

export function memoryBizValidate(output: {
  context: string;
  result: unknown;
  related_rules?: string[];
}): Record<string, unknown> {
  const all = readLayer('L4');
  const wanted = output.related_rules?.map((r) => r.toLowerCase());
  const rules = wanted?.length
    ? all.filter((e) => wanted.some((w) => (e.content?.topic ?? '').toLowerCase().includes(w)))
    : all;

  const blob = typeof output.result === 'string' ? output.result : JSON.stringify(output.result);
  const conflicts: Array<Record<string, unknown>> = [];
  let checked = 0;

  for (const r of rules) {
    const re = ruleRegex(r);
    if (!re) continue;
    checked++;
    // L4 的 regex 規則語意是「輸出**必須**符合這個樣式」——不符合就是衝突
    if (!re.test(blob)) {
      conflicts.push({
        rule: r.content.topic, rule_id: r.id,
        expected: `符合 ${re.source}`, actual: blob.slice(0, 200),
        message: r.content.content,
      });
    }
  }

  const unchecked = rules.filter((r) => ruleRegex(r) === null);
  return {
    valid: conflicts.length === 0,
    conflicts,
    context: output.context,
    rules_in_L4: all.length,
    rules_considered: rules.length,
    rules_machine_checked: checked,
    // 同 memory_audit：商業規則多半是「勝率加總必須等於 1」這種自然語言，機器評不了。
    // 這裡把規則原文交回去，讓 AI 拿著規則自己看輸出——而不是回一個空的 valid:true。
    rules_needing_ai_review: unchecked.map((r) => ({ id: r.id, topic: r.content.topic, rule: r.content.content })),
    summary:
      all.length === 0
        ? `L4 尚未建立任何商業規則，無法驗證「${output.context}」。建議用 memory_save('L4', ...) 存入這個專案的業務規則。`
        : conflicts.length > 0
          ? `🔴 「${output.context}」違反 ${conflicts.length} 條商業規則。`
          : `可機檢的 ${checked} 條規則皆通過。**另有 ${unchecked.length} 條規則需要你逐條對照輸出判讀**——valid:true 不代表商業邏輯一定正確。`,
    writes_nothing: true,
  };
}

// ── PM-359：CRUD 管理 ───────────────────────────────────────────────────────
export function memoryUpdate(layer: Layer, id: string, patch: Partial<MemoryContent>): Record<string, unknown> {
  const entries = readLayer(layer);
  const e = entries.find((x) => x.id === id);
  if (!e) return { error: `${layer} 裡找不到 id「${id}」。可先用 memory_list('${layer}') 看有哪些。`, layer, id };
  if (patch.topic !== undefined) e.content.topic = patch.topic;
  if (patch.content !== undefined) e.content.content = patch.content;
  if (patch.tags !== undefined) e.content.tags = patch.tags;
  e.updated_at = nowIso();
  writeLayer(layer, entries);
  return { id, layer, updated_at: e.updated_at, topic: e.content.topic, updated_fields: Object.keys(patch) };
}

export function memoryDelete(layer: Layer, id: string): Record<string, unknown> {
  const entries = readLayer(layer);
  const idx = entries.findIndex((x) => x.id === id);
  if (idx < 0) return { error: `${layer} 裡找不到 id「${id}」，沒有東西被刪除。`, layer, id, deleted: false };
  const [removed] = entries.splice(idx, 1);
  writeLayer(layer, entries);
  return { deleted: true, id, layer, topic: removed.content.topic, remaining: entries.length };
}

const PREVIEW_LEN = 200;

export function memoryList(
  layer: Layer, limit: number,
  sortBy: 'created_at' | 'updated_at' | 'last_hit_at' | 'hit_count',
): Record<string, unknown> {
  const entries = readLayer(layer);
  const sorted = [...entries].sort((a, b) =>
    sortBy === 'hit_count' ? (b.hit_count ?? 0) - (a.hit_count ?? 0) : Date.parse(b[sortBy]) - Date.parse(a[sortBy]),
  );
  return {
    entries: sorted.slice(0, limit).map((e) => ({
      id: e.id,
      topic: e.content.topic,
      // 省 token：不回完整 content
      content_preview: e.content.content.length > PREVIEW_LEN ? e.content.content.slice(0, PREVIEW_LEN) + '…' : e.content.content,
      truncated: e.content.content.length > PREVIEW_LEN,
      tags: e.content.tags ?? [],
      created_at: e.created_at,
      hit_count: e.hit_count ?? 0,
    })),
    total: entries.length,
    returned: Math.min(limit, entries.length),
    layer,
    layer_name: LAYER_NAMES[layer],
    sorted_by: sortBy,
  };
}

export function memoryClear(layer: Layer, confirm: boolean): Record<string, unknown> {
  const entries = readLayer(layer);
  if (confirm !== true) {
    // 不是預設拒絕，就是「AI 少帶一個參數就清掉整層記憶」。這裡順便告訴它會損失多少。
    return {
      error: `memory_clear 需要 confirm: true 才會執行。${layer}（${LAYER_NAMES[layer]}）目前有 ${entries.length} 條記憶，清空後無法復原。要保留備份請先呼叫 memory_export。`,
      cleared: 0, layer, would_clear: entries.length,
    };
  }
  writeLayer(layer, []);
  return { cleared: entries.length, layer, layer_name: LAYER_NAMES[layer] };
}

// ── PM-360：匯出／匯入 ──────────────────────────────────────────────────────
export const EXPORT_VERSION = '1.0';

export function memoryExport(layers: Layer[] | undefined, target: string | undefined): Record<string, unknown> {
  const chosen = layers?.length ? layers : [...LAYERS];
  const payload: Record<string, unknown> = {
    version: EXPORT_VERSION,
    exported_at: nowIso(),
    project: path.basename(path.dirname(ensureStore())),
    layers: {} as Record<string, MemoryEntry[]>,
  };
  let total = 0;
  for (const l of chosen) {
    const entries = readLayer(l);
    (payload.layers as Record<string, MemoryEntry[]>)[l] = entries;
    total += entries.length;
  }

  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const projectRoot = path.dirname(ensureStore());
  const outPath = target ? path.resolve(target) : path.join(projectRoot, `.bugezy-backup-${stamp}.json`);
  const json = JSON.stringify(payload, null, 2) + '\n';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json, 'utf8');

  return {
    path: outPath,
    layers_exported: chosen,
    total_entries: total,
    size_bytes: Buffer.byteLength(json, 'utf8'),
    // §14.12.5：匯出檔含 L1 的真實檔名修法與 L6 的資安鐵律——正是刻意不上雲的那些。
    // 而且它落在專案根目錄、**不受 .bugezy/.gitignore 保護**，很容易被 git add . 掃進去。
    warning:
      '⚠ 這個檔案含 L1 的真實檔名／修法與 L6 的資安鐵律，請比照憑證檔對待：不要寄到公開頻道、不要 commit 進 git。它位於專案根目錄，不受 .bugezy/.gitignore 保護，建議自行加入專案的 .gitignore。',
  };
}

export function memoryImport(target: string, strategy: 'merge' | 'overwrite'): Record<string, unknown> {
  const p = path.resolve(target);
  let parsed: { version?: string; layers?: Record<string, MemoryEntry[]> };
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { error: `讀不到或解析不了匯入檔：${p}（${(e as Error).message}）`, imported: 0 };
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.layers || typeof parsed.layers !== 'object') {
    return { error: `匯入檔格式不對：缺少 layers 欄位。期望 { version, exported_at, layers: { L1: [...] } }。`, imported: 0, path: p };
  }

  let imported = 0, skipped = 0, conflicts = 0;
  const affected: Layer[] = [];
  const ignoredLayers: string[] = [];

  for (const [key, incoming] of Object.entries(parsed.layers)) {
    if (!(LAYERS as readonly string[]).includes(key)) {
      ignoredLayers.push(key); // 含 L3：雲端層不該被寫進本機
      continue;
    }
    if (!Array.isArray(incoming)) { ignoredLayers.push(key); continue; }
    const layer = key as Layer;
    const entries = readLayer(layer);
    const byId = new Map(entries.map((e) => [e.id, e]));
    let changed = false;

    for (const inc of incoming) {
      if (!inc?.id || !inc?.content?.topic) { skipped++; continue; }
      if (byId.has(inc.id)) {
        conflicts++;
        if (strategy === 'overwrite') {
          const idx = entries.findIndex((e) => e.id === inc.id);
          entries[idx] = { ...inc, updated_at: nowIso() };
          imported++; changed = true;
        } else {
          skipped++; // merge：同 id 跳過，不動既有的
        }
      } else {
        entries.push(inc);
        byId.set(inc.id, inc);
        imported++; changed = true;
      }
    }
    if (changed) {
      applyEviction(layer, entries);
      writeLayer(layer, entries);
      affected.push(layer);
    }
  }

  return {
    imported, skipped, conflicts,
    layers_affected: affected,
    strategy,
    path: p,
    ...(ignoredLayers.length
      ? { ignored_layers: ignoredLayers, ignored_reason: '不是本機的 7 層之一（例如 L3 在雲端），已略過而非寫入。' }
      : {}),
  };
}

// ── 統計（供端到端與除錯用）─────────────────────────────────────────────────
export function memoryStats(): Record<string, unknown> {
  const root = storeRoot();
  const cfg = readConfig();
  const per: Record<string, number> = {};
  for (const l of LAYERS) per[l] = root ? readLayer(l).length : 0;
  return {
    store_root: root,
    initialized: root !== null,
    entries_per_layer: per,
    config: cfg,
    note: root ? undefined : '尚未建立 .bugezy/。第一次 memory_save 時會自動建立。',
  };
}
