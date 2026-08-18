// PM-389：偵測到 🔴 critical 時往 stderr 寫一行警告。
//
// ⚠ **請先看清楚這條通道能做到什麼、不能做到什麼。**
//
// MCP **沒有 server → 模型的推播通道**（PM-345 為了 `watch_zones` 已經確認過這件事，
// 所以那組工具才做成 PULL 模式）。**stderr 不是這條規則的例外**：
// stdio 模式下 MCP client 會收走 server 的 stderr，但它通常寫進 client 自己的
// log／debug 輸出，**不會自動出現在模型的對話脈絡裡**。
//
// 所以這支的實際用途是：
//   ✅ 使用者自己在終端機看 bridge 輸出時，一眼看到「剛剛出事了」
//   ✅ `claude --debug` 之類會顯示 MCP server log 的模式下看得到
//   ✅ 可以 grep（格式固定為一行）
//   ❌ **不能保證 AI 會主動看到並反應** —— 要讓 AI 知道，它仍然得自己呼叫工具
//
// 這個限制寫在 `docs/BUGEZY.md` 裡，免得使用者以為設定完就會自動有人來救。

import { maskBrowserError } from './pii-browser.js';

/** 同一則警告在這段時間內不重複輸出（避免刷屏）。 */
export const SIGNAL_DEDUP_MS = 30_000;

export type SignalSource = 'Browser' | 'Terminal' | 'Zone' | 'Pin';

/** key = 來源 + 摘要的指紋；value = 上次輸出時間。 */
const lastSignalAt = new Map<string, number>();

/** 摘要可能很長（堆疊、URL），指紋只取前 160 字就夠分辨，也避免 Map 的 key 無限長。 */
function fingerprint(source: string, summary: string): string {
  return `${source}:${summary.slice(0, 160)}`;
}

function prune(now: number): void {
  if (lastSignalAt.size < 200) return;
  for (const [k, t] of lastSignalAt) if (now - t > SIGNAL_DEDUP_MS) lastSignalAt.delete(k);
}

/**
 * 輸出一行 critical 警告。**回傳是否真的輸出了**（去重時回 false），供測試驗證。
 *
 * 格式固定為一行，方便 grep：
 *   `⚠ [BugEzy] 🔴 {來源} | {摘要} | 建議：{下一步}`
 */
export function signalCritical(source: SignalSource, summary: string, suggestion: string): boolean {
  // PII 遮罩在**輸出之前**——stderr 會被 MCP client 寫進 log 檔，
  // 那份 log 通常沒人在管權限，比 AI 的 context 還容易外流。
  const safeSummary = maskBrowserError(String(summary ?? '')).replace(/\s+/g, ' ').trim();
  const safeSuggestion = maskBrowserError(String(suggestion ?? '')).replace(/\s+/g, ' ').trim();
  if (!safeSummary) return false;

  const now = Date.now();
  const key = fingerprint(source, safeSummary);
  const prev = lastSignalAt.get(key);
  if (prev !== undefined && now - prev < SIGNAL_DEDUP_MS) return false;
  lastSignalAt.set(key, now);
  prune(now);

  process.stderr.write(
    `⚠ [BugEzy] 🔴 ${source} | ${safeSummary}${safeSuggestion ? ` | 建議：${safeSuggestion}` : ''}\n`,
  );
  return true;
}

/** 測試用：清掉去重狀態。 */
export function _resetSignals(): void {
  lastSignalAt.clear();
}

// ── 各來源的取用點 ─────────────────────────────────────────────────────────
// 這些函式**只讀取工具已經算好的結果**，不重新計算、也不改動回傳值
// （卡片明訂 stderr 是額外通道）。

interface GradedError {
  severity?: string;
  message?: string;
  level?: string;
  url?: string;
  status?: number;
  method?: string;
  elementSelector?: string;
  type?: string;
}

/** `get_browser_errors` / `get_error_summary`：console 與 network 的 critical。 */
export function signalBrowserErrors(consoleErrors: GradedError[], networkErrors: GradedError[]): number {
  let n = 0;
  for (const e of consoleErrors) {
    if (e.severity !== 'critical') continue;
    const where = e.elementSelector ? `（${e.elementSelector}）` : '';
    const suggestion = e.elementSelector
      ? `呼叫 pin_analyze("${e.elementSelector}")`
      : '呼叫 get_error_summary() 看完整分組，或 map_page_zones() 定位';
    if (signalCritical('Browser', `${e.message ?? ''}${where}`, suggestion)) n++;
  }
  for (const e of networkErrors) {
    if (e.severity !== 'critical') continue;
    if (
      signalCritical(
        'Browser',
        `${e.method ?? ''} ${e.url ?? ''} → ${e.status ?? ''}`.trim(),
        '呼叫 correlate_errors() 看後端是否同時噴錯',
      )
    ) {
      n++;
    }
  }
  return n;
}

/** `get_terminal_live_errors`：後端 traceback 的 critical。 */
export function signalTerminalErrors(errors: GradedError[]): number {
  let n = 0;
  for (const e of errors) {
    if (e.severity !== 'critical') continue;
    if (
      signalCritical(
        'Terminal',
        `${e.type ?? ''}${e.type && e.message ? ': ' : ''}${e.message ?? ''}`,
        '呼叫 correlate_errors() 看前端是否有對應的失敗請求',
      )
    ) {
      n++;
    }
  }
  return n;
}

interface ZoneChangeLike {
  name?: string;
  zone_id?: string;
  previous_status?: string;
  current_status?: string;
  new_errors?: number;
  suggested_action?: string;
}

/** `get_zone_changes`：**只有轉成 error 才算 critical**，好轉與轉 warning 不吵。 */
export function signalZoneChanges(changes: ZoneChangeLike[]): number {
  let n = 0;
  for (const c of changes) {
    if (c.current_status !== 'error') continue;
    const added = Number(c.new_errors ?? 0);
    if (
      signalCritical(
        'Zone',
        `${c.name ?? c.zone_id ?? '未命名區域'} 從 ${c.previous_status ?? '?'} → error${added > 0 ? `（新增 ${added} 筆錯誤）` : ''}`,
        c.suggested_action || `呼叫 get_zone_errors("${c.zone_id ?? c.name ?? ''}")`,
      )
    ) {
      n++;
    }
  }
  return n;
}

interface PatrolResultLike {
  selector?: string;
  status?: string;
  previous_status?: string;
  changed?: boolean;
}

/**
 * `patrol_pins`：**只有「惡化」才算 critical**。
 *
 * 一個一直是 error 的圖釘不該每次巡檢都叫（PM-334 的 `alert_count` 也是同樣的取捨：
 * 數的是「狀態有變」而不是「有問題」）。所以條件是 changed 且新狀態比舊狀態糟。
 */
const PIN_SEVERITY_RANK: Record<string, number> = { active: 0, warning: 1, error: 2, stale: 3 };

export function signalPinPatrol(results: PatrolResultLike[]): number {
  let n = 0;
  for (const r of results) {
    if (!r.changed) continue;
    const before = PIN_SEVERITY_RANK[r.previous_status ?? ''] ?? 0;
    const after = PIN_SEVERITY_RANK[r.status ?? ''] ?? 0;
    if (after <= before) continue; // 沒有變糟（含好轉）→ 不吵
    const suggestion =
      r.status === 'stale'
        ? '呼叫 read_page() 確認頁面結構是不是換了'
        : `呼叫 pin_analyze("${r.selector ?? ''}") 看細節`;
    if (signalCritical('Pin', `${r.selector ?? ''} 狀態 ${r.previous_status} → ${r.status}`, suggestion)) n++;
  }
  return n;
}
