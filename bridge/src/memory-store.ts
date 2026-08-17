// PM-355：§14 八層記憶矩陣的檔案系統基礎。
//
// 設計重點：
// ① **L3 不在本機**（決策 4）—— 客服知識庫是 BugEzy 自己的產品手冊，每個使用者拿到的
//    內容都一樣，沒有存進專案目錄的理由。本機是 L1、L2、L4~L8 共 7 個檔。
// ② **`.bugezy/.gitignore` 必須是自我忽略樣式**（`*` + `!.gitignore`）。放空檔或只寫
//    `.bugezy/` 都沒有效果——目錄內的 .gitignore 只能管同層與子層，且要自己排除自己，
//    否則規則檔會連同被忽略、下一個 clone 的人就沒有這道防線。
// ③ **淘汰看 `last_hit_at` 不看 `created_at`**（§14.12.4）—— 三年前寫但每月命中的經驗，
//    價值遠高於上週寫完再也沒用過的那條。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LAYERS = ['L1', 'L2', 'L4', 'L5', 'L6', 'L7', 'L8'] as const;
export type Layer = (typeof LAYERS)[number];

/** L3 沒有本機檔案，被指名時要回這句而不是「不合法的層」——後者會讓人以為 L3 不存在。 */
export const L3_MESSAGE =
  'L3（客服知識庫）存放在雲端，不在本機 .bugezy/ 裡（決策 4：它是 BugEzy 的產品手冊，每個使用者內容相同）。本機可用的層：L1, L2, L4, L5, L6, L7, L8。';

export const LAYER_FILES: Record<Layer, string> = {
  L1: 'L1-debug.json',
  L2: 'L2-project.json',
  L4: 'L4-business.json',
  L5: 'L5-dependencies.json',
  L6: 'L6-security.json',
  L7: 'L7-performance.json',
  L8: 'L8-team.json',
};

export const LAYER_NAMES: Record<Layer, string> = {
  L1: 'Debug 經驗庫',
  L2: '專案知識庫',
  L4: '商業邏輯庫',
  L5: '外部依賴庫',
  L6: '資安合規庫',
  L7: '效能帳本庫',
  L8: '團隊協作庫',
};

export interface MemoryContent {
  topic: string;
  content: string;
  tags?: string[];
}

export interface MemoryEntry {
  id: string;
  created_at: string;
  updated_at: string;
  /** §14.12.4：淘汰依據。寫入當下先等於 created_at。 */
  last_hit_at: string;
  hit_count: number;
  content: MemoryContent;
}

export interface MemoryConfig {
  L1_max_entries: number;
  L7_retention_days: number;
  auto_merge: boolean;
  auto_evict: boolean;
}

export const DEFAULT_CONFIG: MemoryConfig = {
  L1_max_entries: 2000,
  L7_retention_days: 90,
  auto_merge: true,
  auto_evict: true,
};

/** `auto_merge` 目前是保留欄位（§14.12.4 的合併機制尚未實作）。寫進檔案裡說明，免得使用者設了 false 卻沒有任何效果。 */
const CONFIG_NOTE =
  '_note: auto_merge 為保留欄位，§14.12.4 的「同一 bug 多次修法自動合併」尚未實作，目前設 true/false 都沒有作用。auto_evict 與兩個上限則已生效。';

export const GITIGNORE_CONTENT = '*\n!.gitignore\n';

// ── 位置解析 ────────────────────────────────────────────────────────────────
let searchFrom: string = process.cwd();
let cachedRoot: string | null | undefined; // undefined = 還沒找過

/** 從 startDir 一路往上找 `.bugezy/`（跟 git 找 `.git/` 一樣）。 */
export function findBugezyDir(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.bugezy');
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* 不存在，繼續往上 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // 到根目錄了
    dir = parent;
  }
}

/**
 * bridge 啟動時呼叫。**找不到 `.bugezy/` 不是錯誤**——回空白記憶，等到第一次
 * `memory_save` 才自動建立（§14.12.3 步驟 3）。
 */
export function initMemoryStore(startDir?: string): { found: boolean; root: string | null } {
  searchFrom = startDir ? path.resolve(startDir) : process.cwd();
  cachedRoot = findBugezyDir(searchFrom);
  return { found: cachedRoot !== null, root: cachedRoot };
}

/** 目前的 `.bugezy/` 路徑；還沒建立時回 null（不會自動建立）。 */
export function storeRoot(): string | null {
  if (cachedRoot === undefined) cachedRoot = findBugezyDir(searchFrom);
  return cachedRoot;
}

/** 確保 `.bugezy/` 存在（含 memory/、config.json、.gitignore），回傳其路徑。 */
export function ensureStore(): string {
  const existing = storeRoot();
  if (existing) {
    ensureSkeleton(existing);
    return existing;
  }
  const root = path.join(searchFrom, '.bugezy');
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  ensureSkeleton(root);
  cachedRoot = root;
  return root;
}

function ensureSkeleton(root: string): void {
  fs.mkdirSync(path.join(root, 'memory'), { recursive: true });
  const gi = path.join(root, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE_CONTENT, 'utf8');
  const cfg = path.join(root, 'config.json');
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, JSON.stringify({ ...DEFAULT_CONFIG, _note: CONFIG_NOTE }, null, 2) + '\n', 'utf8');
  }
}

// ── config ──────────────────────────────────────────────────────────────────
export function readConfig(): MemoryConfig {
  const root = storeRoot();
  if (!root) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')) as Partial<MemoryConfig>;
    // 壞掉或缺欄位的 config 用預設補齊，而不是整個放棄——記憶比設定重要。
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ── 讀寫 ────────────────────────────────────────────────────────────────────
function layerPath(root: string, layer: Layer): string {
  return path.join(root, 'memory', LAYER_FILES[layer]);
}

/** 讀取某層；`.bugezy/` 不存在或檔案壞掉都回空陣列（空白記憶不報錯）。 */
export function readLayer(layer: Layer): MemoryEntry[] {
  const root = storeRoot();
  if (!root) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(layerPath(root, layer), 'utf8'));
    return Array.isArray(parsed) ? (parsed as MemoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function writeLayer(layer: Layer, entries: MemoryEntry[]): void {
  const root = ensureStore();
  fs.writeFileSync(layerPath(root, layer), JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

export function newEntry(content: MemoryContent): MemoryEntry {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    last_hit_at: now,
    hit_count: 0,
    content: { ...content, tags: content.tags ?? [] },
  };
}

// ── 淘汰（§14.12.4）─────────────────────────────────────────────────────────
export interface EvictionResult {
  evicted: number;
  reason: string | null;
}

/**
 * 寫入後套用淘汰規則。**只有 L1 有筆數上限、只有 L7 有保存天數**——這是 §14.12.4
 * 表格明訂的兩條，config 也只提供這兩個鍵。其他層目前不限量（卡片寫「該層」是
 * 泛稱，但沒有對應的設定鍵，硬套會變成用 L1 的上限去砍 L2）。
 */
export function applyEviction(layer: Layer, entries: MemoryEntry[]): EvictionResult {
  const cfg = readConfig();
  if (!cfg.auto_evict) return { evicted: 0, reason: null };

  if (layer === 'L7' && cfg.L7_retention_days > 0) {
    const cutoff = Date.now() - cfg.L7_retention_days * 86400_000;
    const before = entries.length;
    // L7 是效能基準，看的是「這個基準什麼時候量的」→ created_at
    const kept = entries.filter((e) => Date.parse(e.created_at) >= cutoff);
    if (kept.length !== before) {
      entries.length = 0;
      entries.push(...kept);
      return { evicted: before - kept.length, reason: `超過 L7_retention_days（${cfg.L7_retention_days} 天）的舊基準已清除` };
    }
    return { evicted: 0, reason: null };
  }

  if (layer === 'L1' && cfg.L1_max_entries > 0 && entries.length > cfg.L1_max_entries) {
    const overflow = entries.length - cfg.L1_max_entries;
    // 依 last_hit_at 由舊到新排序，砍掉最久沒被匹配的
    const sorted = [...entries].sort((a, b) => Date.parse(a.last_hit_at) - Date.parse(b.last_hit_at));
    const doomed = new Set(sorted.slice(0, overflow).map((e) => e.id));
    const kept = entries.filter((e) => !doomed.has(e.id));
    entries.length = 0;
    entries.push(...kept);
    return { evicted: overflow, reason: `L1 超過 ${cfg.L1_max_entries} 條，已淘汰最久沒被匹配的 ${overflow} 條` };
  }

  return { evicted: 0, reason: null };
}

/** 測試用：重設模組狀態並指定搜尋起點。 */
export function _resetStore(startDir: string): void {
  searchFrom = path.resolve(startDir);
  cachedRoot = undefined;
}
