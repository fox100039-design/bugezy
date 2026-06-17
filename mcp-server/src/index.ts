#!/usr/bin/env node
// BugEzy MCP Server — Pull 模式 8 Tool
// AI 助手（Claude Code / Cursor / Copilot）透過 MCP 按需查詢 BugEzy 報告，
// 每個 tool 只回傳需要的欄位 → 省 token。資料源是 Workers API（PM-10/14）。

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

const API_BASE = process.env.BUGEZY_API_URL ?? 'http://127.0.0.1:8787';

// ── 報告資料型別（對應 GET /api/reports/:id）──────────────
interface ReportData {
  report_id: string;
  url: string;
  title: string;
  browser: string;
  screen_size: string;
  consoleLogs: unknown[];
  networkErrors: unknown[];
  voiceTranscript: unknown[];
  rrwebEvents: Array<{ type?: number; timestamp?: number }>;
  created_at: string;
}

// ── 工具定義（name / description 中英雙語 / inputSchema）──
const REPORT_ID_SCHEMA: Tool['inputSchema'] = {
  type: 'object',
  properties: {
    report_id: { type: 'string', description: '報告 ID（report_id）' },
  },
  required: ['report_id'],
};

const TOOLS: Tool[] = [
  {
    name: 'list_reports',
    description:
      '列出最近的 Bug 報告（metadata，不含完整資料）。List recent bug reports (metadata only).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '筆數 1-50，預設 10', minimum: 1, maximum: 50 },
        url: { type: 'string', description: '選填：URL 模糊搜尋關鍵字' },
      },
    },
  },
  {
    name: 'get_report_overview',
    description:
      '取得報告概覽（metadata + 各欄位筆數，不含原始資料）。Get report overview (metadata + counts).',
    inputSchema: REPORT_ID_SCHEMA,
  },
  {
    name: 'get_console_logs',
    description: '取得報告中的 Console 記錄（warn/error）。Get console logs (warn/error).',
    inputSchema: REPORT_ID_SCHEMA,
  },
  {
    name: 'get_network_errors',
    description: '取得報告中的 Network 錯誤（4xx/5xx）。Get network errors (4xx/5xx).',
    inputSchema: REPORT_ID_SCHEMA,
  },
  {
    name: 'get_voice_transcript',
    description:
      '取得開發者的語音描述（中文轉錄）— 通常是最有價值的除錯線索。Get developer voice transcript — often the most valuable debugging clue.',
    inputSchema: REPORT_ID_SCHEMA,
  },
  {
    name: 'get_page_info',
    description:
      '取得報告的頁面資訊（URL、標題、瀏覽器、解析度）。Get page info (url, title, browser, resolution).',
    inputSchema: REPORT_ID_SCHEMA,
  },
  {
    name: 'get_rrweb_summary',
    description:
      'DOM 軌跡摘要（事件數、時長、事件類型分布），不回完整 rrweb（太大）。rrweb summary (count, duration, type distribution).',
    inputSchema: REPORT_ID_SCHEMA,
  },
  {
    name: 'get_rrweb_events',
    description:
      '取得完整 rrweb DOM 事件（⚠ 資料量可能數 MB，僅在需要精確分析 DOM 變化時使用）。Get full rrweb events (⚠ may be several MB).',
    inputSchema: REPORT_ID_SCHEMA,
  },
];

// ── 輔助：呼叫 API ────────────────────────────────────────
async function fetchReport(reportId: string): Promise<ReportData | null> {
  const res = await fetch(`${API_BASE}/api/reports/${encodeURIComponent(reportId)}`);
  if (!res.ok) return null;
  return (await res.json()) as ReportData;
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// ── Server ────────────────────────────────────────────────
const server = new Server(
  { name: 'bugezy', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  // list_reports 不需要 report_id
  if (name === 'list_reports') {
    const limit = typeof args.limit === 'number' ? args.limit : 10;
    const params = new URLSearchParams({ limit: String(limit) });
    if (typeof args.url === 'string' && args.url) params.set('url', args.url);
    const res = await fetch(`${API_BASE}/api/reports?${params.toString()}`);
    if (!res.ok) return errorResult(`查詢失敗：HTTP ${res.status}`);
    return textResult(await res.json());
  }

  // 其餘 tool 都需要 report_id + 一次 GET /api/reports/:id
  const reportId = args.report_id;
  if (typeof reportId !== 'string' || !reportId) {
    return errorResult('缺少必填參數 report_id');
  }
  const report = await fetchReport(reportId);
  if (!report) return errorResult('找不到報告');

  switch (name) {
    case 'get_report_overview':
      return textResult({
        report_id: report.report_id,
        url: report.url,
        title: report.title,
        browser: report.browser,
        screen_size: report.screen_size,
        console_count: report.consoleLogs.length,
        network_count: report.networkErrors.length,
        voice_count: report.voiceTranscript.length,
        rrweb_count: report.rrwebEvents.length,
        created_at: report.created_at,
      });
    case 'get_console_logs':
      return textResult(report.consoleLogs);
    case 'get_network_errors':
      return textResult(report.networkErrors);
    case 'get_voice_transcript':
      return textResult(report.voiceTranscript);
    case 'get_page_info':
      return textResult({
        url: report.url,
        title: report.title,
        browser: report.browser,
        screen_size: report.screen_size,
        created_at: report.created_at,
      });
    case 'get_rrweb_summary':
      return textResult(rrwebSummary(report.rrwebEvents));
    case 'get_rrweb_events':
      return textResult(report.rrwebEvents);
    default:
      return errorResult(`未知的 tool：${name}`);
  }
});

// rrweb 事件摘要：type 2=FullSnapshot, 3=IncrementalSnapshot, 4=Meta
function rrwebSummary(events: Array<{ type?: number; timestamp?: number }>) {
  const event_count = events.length;
  const timestamps = events
    .map((e) => e.timestamp ?? 0)
    .filter((t) => t > 0);
  const duration_ms =
    timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  const event_types: Record<string, number> = {};
  for (const e of events) {
    const key = `type_${e.type ?? 'unknown'}`;
    event_types[key] = (event_types[key] ?? 0) + 1;
  }
  return { event_count, duration_ms, event_types };
}

// ── 啟動（stdio 模式，供 IDE 整合）────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio 模式：log 不可寫 stdout（會污染協定），寫 stderr
  console.error(`[BugEzy MCP] 已啟動，API_BASE=${API_BASE}`);
}

main().catch((err) => {
  console.error('[BugEzy MCP] 啟動失敗:', err);
  process.exit(1);
});
