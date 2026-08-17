// PM-352／353：自動偵測（orchestration）與前後端關聯診斷。
//
// ⚠ 這兩支**不新增任何偵測能力** —— 全部呼叫既有工具的邏輯。
//   價值在於「一個呼叫做完所有事」，省掉 AI 的多輪往返。

import type { ExtensionLink } from './extension-link.js';
import { classifySeverity, decorate, severitySummary, type Severity } from './severity.js';
import { getTerminalLiveErrors } from './terminal-monitor.js';
import { maskConsoleEntry, maskNetworkEntry, maskUrl } from './pii-browser.js';

interface DetectReport {
  detect_id: string;
  status: 'running' | 'completed' | 'failed';
  depth: 'quick' | 'full';
  started_at: number;
  duration_ms: number;
  summary: string;
  zones: unknown[];
  critical_errors: unknown[];
  vitals: unknown;
  pin_suggestions: Array<{ selector: string; reason: string }>;
  score: number | null;
  unassigned?: unknown;
  notes: string[];
}

const reports = new Map<string, DetectReport>();
let detectSeq = 0;

async function send<T = Record<string, unknown>>(
  link: ExtensionLink,
  cmd: string,
  params: Record<string, unknown>,
): Promise<T | null> {
  const r = await link.send(cmd, params);
  return r.ok ? (r.data as T) : null;
}

export async function startAutoDetect(
  link: ExtensionLink,
  tabId: number | undefined,
  depth: 'quick' | 'full',
): Promise<Record<string, unknown>> {
  const id = `det${++detectSeq}-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  const notes: string[] = [];

  // 1. 分區
  const zonesRes = await send<{ zones?: unknown[]; unassigned_count?: number }>(link, 'map_page_zones', { tab_id: tabId });
  if (!zonesRes) {
    const failed: DetectReport = {
      detect_id: id, status: 'failed', depth, started_at: startedAt, duration_ms: Date.now() - startedAt,
      summary: '偵測失敗：無法與擴充功能通訊（分頁可能已關閉或沒有 content script）。',
      zones: [], critical_errors: [], vitals: null, pin_suggestions: [], score: null, notes,
    };
    reports.set(id, failed);
    return { detect_id: id, status: 'failed', error: failed.summary };
  }
  if ((zonesRes.zones ?? []).length === 0) {
    notes.push('這一頁沒有可辨識的語意區域，所有錯誤都會落在 unassigned。');
  }

  // 2. 錯誤
  const errs = await send<{ console_errors?: unknown[]; network_errors?: unknown[] }>(link, 'get_browser_errors', { tab_id: tabId });
  // 3. 效能
  const vitals = await send<{ vitals?: Record<string, unknown> }>(link, 'get_web_vitals', { tab_id: tabId });
  // 4. zone 健康
  const health = await send<{ zones?: Array<Record<string, unknown>>; unassigned?: unknown }>(link, 'get_zone_health', { tab_id: tabId });

  // 依 severity 分類（PM-350）
  const consoleErrs = decorate((errs?.console_errors ?? []) as Array<Record<string, unknown>>, (e) => ({
    level: e.level as string, message: e.message as string, source: e.source as string,
  }));
  const netErrs = decorate((errs?.network_errors ?? []) as Array<Record<string, unknown>>, (e) => ({
    status: e.status as number, url: e.url as string, message: `${e.method} ${e.url} → ${e.status}`,
  }));
  const all = [...consoleErrs, ...netErrs];
  const counts = { critical: 0, minor: 0, info: 0 };
  for (const e of all) counts[e.severity as 'critical' | 'minor' | 'info']++;

  const zoneRows = (health?.zones ?? []).map((z) => ({
    zone_id: z.zone_id, name: z.name, status: z.status,
    error_count: z.error_count, warning_count: z.warning_count,
  }));

  // 5. full 模式：對每個非 healthy 的 zone 再跑一次 analyze_element
  const pinSuggestions: Array<{ selector: string; reason: string }> = [];
  if (depth === 'full') {
    const troubled = (health?.zones ?? []).filter((z) => z.status !== 'healthy');
    for (const z of troubled) {
      const sel = z.selector as string | undefined;
      if (!sel) continue;
      await send(link, 'analyze_element', { selector: sel, tab_id: tabId });
      pinSuggestions.push({
        selector: sel,
        reason: `「${String(z.name)}」為 ${String(z.status)}（${String(z.error_count)} 錯誤 / ${String(z.warning_count)} 警告）`,
      });
    }
    if (troubled.length === 0) notes.push('full 模式：所有 zone 都健康，沒有需要深入分析的對象。');
  } else {
    // quick 模式不做深入分析，但仍給出「值得看哪裡」的建議
    for (const z of (health?.zones ?? []).filter((x) => x.status !== 'healthy')) {
      if (z.selector) {
        pinSuggestions.push({
          selector: String(z.selector),
          reason: `「${String(z.name)}」為 ${String(z.status)}；用 full 模式或 pin_analyze 可深入分析`,
        });
      }
    }
  }

  const zoneErrTotal = zoneRows.reduce((n, z) => n + Number(z.error_count ?? 0), 0);
  // 分數：以 §6 權重扣分（critical -10 / minor -3 / info 0），下限 0
  const score = Math.max(0, 100 - counts.critical * 10 - counts.minor * 3);

  const report: DetectReport = {
    detect_id: id,
    status: 'completed',
    depth,
    started_at: startedAt,
    duration_ms: Date.now() - startedAt,
    summary: `${severitySummary(counts)}；${zoneRows.length} 個區域（${zoneErrTotal} 筆已定位錯誤）`,
    zones: zoneRows,
    // PM-367：這裡放的就是 get_browser_errors 的同一批資料，不遮的話 PII 只是換一支工具流出去
    critical_errors: all
      .filter((e) => e.severity === 'critical')
      .map((e) => maskNetworkEntry(maskConsoleEntry(e as Record<string, unknown>))),
    vitals: vitals?.vitals ?? null,
    pin_suggestions: pinSuggestions,
    score,
    unassigned: health?.unassigned ?? null,
    notes,
  };
  reports.set(id, report);
  return { detect_id: id, status: 'completed', depth, duration_ms: report.duration_ms, tab_id: tabId };
}

export function getDetectReport(detectId?: string): Record<string, unknown> {
  const all = [...reports.values()];
  if (all.length === 0) {
    return { error: '還沒有執行過自動偵測。請先呼叫 start_auto_detect()。' };
  }
  const r = detectId ? reports.get(detectId) : all[all.length - 1];
  if (!r) return { error: `找不到偵測 ${detectId}`, available: all.map((x) => x.detect_id) };
  return { ...r } as unknown as Record<string, unknown>;
}

// ── PM-353：前後端關聯診斷 ─────────────────────────────────────────────────
/** 從網址取出 path，供前後端配對比對。 */
function pathOf(url: string): string {
  try {
    return new URL(url, 'http://x').pathname;
  } catch {
    return url;
  }
}

export async function correlateErrors(
  link: ExtensionLink,
  tabId: number | undefined,
  windowSeconds: number,
): Promise<Record<string, unknown>> {
  const front = await send<{ network_errors?: Array<Record<string, unknown>> }>(link, 'get_browser_errors', { tab_id: tabId });
  const netErrors = front?.network_errors ?? [];

  const term = getTerminalLiveErrors();
  const backendErrors = (term.errors as Array<Record<string, unknown>> | undefined) ?? [];
  const noBackend = typeof term.error === 'string';

  const windowMs = Math.max(0, windowSeconds) * 1000;
  const usedBackend = new Set<number>();
  const correlations: Array<Record<string, unknown>> = [];

  for (const f of netErrors) {
    const ft = Number(f.timestamp ?? 0);
    const fPath = pathOf(String(f.url ?? ''));
    let best: { idx: number; diff: number; confidence: 'high' | 'medium' | 'low' } | null = null;

    backendErrors.forEach((b, i) => {
      if (usedBackend.has(i)) return;
      const bt = Number(b.timestamp ?? 0);
      const diff = Math.abs(ft - bt);
      // URL path 出現在後端錯誤訊息／堆疊裡 → 高信心
      const blob = `${String(b.message ?? '')} ${JSON.stringify(b.frames ?? [])}`;
      const pathHit = fPath.length > 1 && blob.includes(fPath);
      let confidence: 'high' | 'medium' | 'low' | null = null;
      if (diff <= windowMs && pathHit) confidence = 'high';
      else if (diff <= windowMs) confidence = 'medium';
      else if (diff <= windowMs * 3) confidence = 'low';
      if (!confidence) return;
      const rank = { high: 0, medium: 1, low: 2 };
      if (!best || rank[confidence] < rank[best.confidence] || (rank[confidence] === rank[best.confidence] && diff < best.diff)) {
        best = { idx: i, diff, confidence };
      }
    });

    if (best) {
      const b = backendErrors[(best as { idx: number }).idx];
      usedBackend.add((best as { idx: number }).idx);
      const frame = (b.frames as Array<Record<string, unknown>> | undefined)?.[0];
      correlations.push({
        frontend: {
          // PM-367：只遮 query 的敏感值，**path 保持原樣** —— 上面的配對就是靠 path 做的
          url: maskUrl(String(f.url ?? '')), status: f.status, method: f.method, timestamp: f.timestamp,
          severity: classifySeverity({ status: Number(f.status), url: String(f.url ?? '') }) as Severity,
        },
        backend: {
          type: b.type, message: b.message,
          file: frame?.file ?? null, line: frame?.line ?? null, timestamp: b.timestamp,
        },
        time_diff_ms: (best as { diff: number }).diff,
        confidence: (best as { confidence: string }).confidence,
        summary: `${String(f.method)} ${fPath} → ${String(f.status)} ←→ ${String(b.type)}${frame?.file ? ` ${String(frame.file)}:${String(frame.line)}` : ''}`,
      });
    }
  }

  return {
    correlations,
    // 未配對的兩邊都要計數 —— 丟掉的話會讓人以為「沒關聯就是沒問題」
    unmatched_frontend: netErrors.length - correlations.length,
    unmatched_backend: backendErrors.length - usedBackend.size,
    time_window_seconds: windowSeconds,
    ...(noBackend
      ? {
          note: '目前沒有終端機監控在跑，因此沒有後端錯誤可配對。要診斷前後端關聯，請先用 start_terminal_monitor 監控你的後端指令（例如 npm run dev）。',
        }
      : correlations.length === 0
        ? { note: '前後端都有錯誤，但在時間窗口內找不到可信的配對。可試著放寬 time_window_seconds。' }
        : {}),
  };
}
