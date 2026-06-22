// BugEzy API — Cloudflare Workers
// POST /api/reports      接收 RecordingPayload → rrweb 存 R2、metadata 存 Supabase
// GET  /api/reports/:id  讀回完整報告（含從 R2 取回的 rrwebEvents）
// GET  /api/reports      列出最近報告（metadata only）
// /mcp                   MCP 端點（Streamable HTTP，給 Claude.ai 等直接連）
//
// 機密（SUPABASE_ANON_KEY）走 wrangler secret，不寫進程式碼。

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface Env {
  R2: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  AI: Ai; // Cloudflare Workers AI binding（PM-25）
}

// ── 與擴充端一致的 payload 型別 ──────────────────────────
interface PageInfo {
  url: string;
  title: string;
  browser: string;
  screenSize: string;
  timestamp: string;
}
interface ConsoleLog {
  level: string;
  message: string;
  timestamp: number;
}
interface NetworkError {
  method: string;
  url: string;
  status: number;
  requestBody?: string;
  responseBody?: string;
  timestamp: number;
  duration: number;
}
interface VoiceSegment {
  text: string;
  timestamp: number;
  isFinal: boolean;
}
interface Screenshot {
  dataUrl: string;
  timestamp: number;
}
interface TimeMarker {
  time_sec: number;
  note: string;
}
interface RecordingPayload {
  rrwebEvents: unknown[];
  consoleLogs: ConsoleLog[];
  networkErrors: NetworkError[];
  voiceTranscript: VoiceSegment[];
  pageInfo: PageInfo;
  screenshots: Screenshot[];
  description?: string;
  markers?: TimeMarker[]; // PM-28：時間軸標記
}

// ── CORS（MVP 先全開，第 5 代再收緊）────────────────────
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function supa(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
}

function html(body: string): Response {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── PM-51：即時監控 live errors 暫存 ────────────────────────
// 改用 R2 單一物件（非全域 Map）：擴充 POST 與雲端 MCP GET 通常落在不同 Worker isolate，
// per-isolate Map 不共享（實測 POST 後即時 GET 仍 stale）；R2 對單一 key 有強讀後寫一致性，
// 才能讓「擴充推送 → AI 查」真的拿到資料。POST 覆蓋最新一筆，>30 秒視為過期（stale）。
const LIVE_ERRORS_KEY = 'live-errors/latest.json';
interface LiveErrors {
  url?: string;
  title?: string;
  consoleLogs: unknown[];
  networkErrors: unknown[];
  timestamp?: number;
  updatedAt: number;
}

async function readLiveErrors(env: Env): Promise<Record<string, unknown>> {
  const obj = await env.R2.get(LIVE_ERRORS_KEY);
  const data = obj ? ((await obj.json()) as LiveErrors) : null;
  if (!data || Date.now() - data.updatedAt > 30_000) {
    return { consoleLogs: [], networkErrors: [], stale: true };
  }
  return { ...data, stale: false };
}

// ── PM-53：終端機 CLI agent 日誌暫存（R2 單一物件，同 live-errors 跨 isolate 一致）──
const TERMINAL_LOGS_KEY = 'terminal-logs/latest.json';

async function readTerminalLogs(env: Env): Promise<Record<string, unknown>> {
  const obj = await env.R2.get(TERMINAL_LOGS_KEY);
  const data = obj ? ((await obj.json()) as { updatedAt?: number }) : null;
  if (!data || !data.updatedAt || Date.now() - data.updatedAt > 30_000) {
    return { logs: [], stale: true };
  }
  return { ...data, stale: false };
}

// ── PM-48：測試專頁（Test Harness）──────────────────────────
// 共用 CSS（page1 與 page2/3 shell 共用，單一來源）
const TEST_STYLE = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, "Microsoft JhengHei", sans-serif;
      background: #f5f5f5; color: #333; padding: 20px;
      max-width: 960px; margin: 0 auto;
    }
    h1 { color: #7c3aed; margin-bottom: 8px; }
    .subtitle { color: #888; margin-bottom: 24px; }

    .section {
      background: #fff; border-radius: 12px; padding: 20px;
      margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }
    .section h2 { font-size: 16px; margin-bottom: 12px; color: #555; }

    .btn-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }

    button {
      padding: 10px 16px; border: none; border-radius: 8px;
      font-size: 14px; cursor: pointer; font-weight: 500;
      transition: all 0.15s;
    }
    button:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }

    .btn-error { background: #ef4444; color: #fff; }
    .btn-warn { background: #f59e0b; color: #fff; }
    .btn-network { background: #3b82f6; color: #fff; }
    .btn-dom { background: #10b981; color: #fff; }
    .btn-nav { background: #7c3aed; color: #fff; }

    .output {
      background: #1a1a2e; color: #0f0; padding: 12px;
      border-radius: 8px; font-family: monospace; font-size: 13px;
      min-height: 60px; margin-top: 12px; white-space: pre-wrap;
      max-height: 200px; overflow-y: auto;
    }

    .test-area {
      border: 2px dashed #ddd; border-radius: 12px;
      padding: 20px; text-align: center; margin-top: 12px;
    }
    .test-area img { max-width: 300px; border-radius: 8px; margin: 8px; }

    .nav-links { display: flex; gap: 12px; margin-top: 12px; }
    .nav-links a {
      display: inline-block; padding: 10px 20px;
      background: #7c3aed; color: #fff; text-decoration: none;
      border-radius: 8px; font-weight: 600;
    }
    .nav-links a:hover { background: #6d28d9; }

    #animBox {
      width: 80px; height: 80px; background: #7c3aed;
      border-radius: 12px; transition: all 0.5s;
      display: flex; align-items: center; justify-content: center;
      color: #fff; font-weight: bold; margin-top: 12px;
    }

    .page-id {
      position: fixed; top: 10px; right: 10px;
      background: #7c3aed; color: #fff; padding: 6px 14px;
      border-radius: 20px; font-size: 13px; font-weight: 600;
    }
`;

/** page2/page3 共用骨架（同 head/style，內容不同） */
function testShell(pageId: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8">
  <title>🧪 BugEzy 測試頁</title>
  <style>${TEST_STYLE}</style>
</head>
<body>
  <div class="page-id">${pageId}</div>
${inner}
</body>
</html>`;
}

const TEST_PAGE_1 = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8">
  <title>🧪 BugEzy 測試頁</title>
  <style>${TEST_STYLE}</style>
</head>
<body>
  <div class="page-id">📍 測試頁 1</div>

  <h1>🧪 BugEzy 測試頁</h1>
  <p class="subtitle">用這個頁面測試 BugEzy 的各項功能。每個按鈕觸發可預測的事件。</p>

  <!-- Console 測試 -->
  <div class="section">
    <h2>🖥 Console 測試</h2>
    <div class="btn-grid">
      <button class="btn-error" onclick="console.error('❌ [TEST] TypeError: Cannot read property of undefined')">觸發 console.error</button>
      <button class="btn-warn" onclick="console.warn('⚠ [TEST] Deprecated API usage detected')">觸發 console.warn</button>
      <button class="btn-error" onclick="console.error('❌ [TEST] Uncaught ReferenceError: foo is not defined')">觸發 ReferenceError</button>
      <button class="btn-error" onclick="try{null.toString()}catch(e){console.error('❌ [TEST]',e.message)}">觸發真實 TypeError</button>
    </div>
    <div class="output" id="consoleOutput">Console 輸出會顯示在這裡...</div>
  </div>

  <!-- Network 測試 -->
  <div class="section">
    <h2>🌐 Network 測試</h2>
    <div class="btn-grid">
      <button class="btn-network" onclick="testFetch(404)">觸發 fetch 404</button>
      <button class="btn-network" onclick="testFetch(500)">觸發 fetch 500</button>
      <button class="btn-network" onclick="testFetch(403)">觸發 fetch 403</button>
      <button class="btn-network" onclick="testXHR(404)">觸發 XHR 404</button>
    </div>
    <div class="output" id="networkOutput">Network 結果會顯示在這裡...</div>
  </div>

  <!-- DOM 變化測試 -->
  <div class="section">
    <h2>🎨 DOM 變化測試（rrweb 會錄到）</h2>
    <div class="btn-grid">
      <button class="btn-dom" onclick="addElement()">新增 DOM 元素</button>
      <button class="btn-dom" onclick="removeElement()">移除 DOM 元素</button>
      <button class="btn-dom" onclick="toggleAnimation()">切換動畫</button>
      <button class="btn-dom" onclick="changeColors()">隨機變色</button>
    </div>
    <div id="animBox">動畫</div>
    <div class="test-area" id="domArea">
      <p>DOM 測試區域 — 新增的元素會出現在這裡</p>
    </div>
  </div>

  <!-- 截圖測試 -->
  <div class="section">
    <h2>📸 截圖測試區域</h2>
    <p>用 BugEzy 截圖功能擷取這個區域，測試三種模式。</p>
    <div class="test-area">
      <p style="font-size: 24px; color: #7c3aed;">🎯 這段文字應該出現在截圖中</p>
      <p>小字測試 — 驗證截圖解析度是否足夠</p>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:12px;">
        <div style="width:60px;height:60px;background:#ef4444;border-radius:8px;"></div>
        <div style="width:60px;height:60px;background:#f59e0b;border-radius:8px;"></div>
        <div style="width:60px;height:60px;background:#10b981;border-radius:8px;"></div>
        <div style="width:60px;height:60px;background:#3b82f6;border-radius:8px;"></div>
        <div style="width:60px;height:60px;background:#7c3aed;border-radius:8px;"></div>
      </div>
    </div>
  </div>

  <!-- 跨頁跳轉測試 -->
  <div class="section">
    <h2>🔗 跨頁跳轉測試</h2>
    <p>點擊連結跳到其他測試頁，驗證跨頁錄製 + 語音保留。</p>
    <div class="nav-links">
      <a href="/test/page2">跳到測試頁 2 →</a>
      <a href="/test/page3">跳到測試頁 3 →</a>
    </div>
  </div>

  <!-- 輸入測試 -->
  <div class="section">
    <h2>⌨️ 輸入測試</h2>
    <input type="text" placeholder="測試文字輸入..." style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;margin-bottom:8px;">
    <textarea placeholder="測試多行輸入..." rows="3" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;"></textarea>
  </div>

  <script>
    // Console 輸出攔截（頁面顯示用）
    const consoleOutput = document.getElementById('consoleOutput');
    const origError = console.error;
    const origWarn = console.warn;
    console.error = (...args) => {
      consoleOutput.textContent += '❌ ' + args.join(' ') + '\\n';
      consoleOutput.scrollTop = consoleOutput.scrollHeight;
      origError(...args);
    };
    console.warn = (...args) => {
      consoleOutput.textContent += '⚠ ' + args.join(' ') + '\\n';
      consoleOutput.scrollTop = consoleOutput.scrollHeight;
      origWarn(...args);
    };

    // Network 測試
    const networkOutput = document.getElementById('networkOutput');
    async function testFetch(status) {
      try {
        const res = await fetch('/test/api/' + status);
        networkOutput.textContent += (res.ok ? '✅' : '❌') + ' fetch ' + status + ': ' + res.statusText + '\\n';
      } catch (e) {
        networkOutput.textContent += '❌ fetch error: ' + e.message + '\\n';
      }
      networkOutput.scrollTop = networkOutput.scrollHeight;
    }
    function testXHR(status) {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/test/api/' + status);
      xhr.onload = () => {
        networkOutput.textContent += (xhr.status < 400 ? '✅' : '❌') + ' XHR ' + xhr.status + '\\n';
        networkOutput.scrollTop = networkOutput.scrollHeight;
      };
      xhr.send();
    }

    // DOM 測試
    let domCount = 0;
    function addElement() {
      domCount++;
      const el = document.createElement('div');
      el.className = 'dom-item';
      el.style.cssText = 'display:inline-block;padding:8px 16px;margin:4px;background:#e0e7ff;border-radius:6px;font-size:13px;';
      el.textContent = '元素 #' + domCount;
      document.getElementById('domArea').appendChild(el);
    }
    function removeElement() {
      const items = document.querySelectorAll('.dom-item');
      if (items.length) items[items.length - 1].remove();
    }
    let animating = false;
    function toggleAnimation() {
      const box = document.getElementById('animBox');
      animating = !animating;
      if (animating) {
        box.style.transform = 'rotate(180deg) scale(1.5)';
        box.style.background = '#ef4444';
        box.textContent = '轉！';
      } else {
        box.style.transform = 'none';
        box.style.background = '#7c3aed';
        box.textContent = '動畫';
      }
    }
    function changeColors() {
      document.querySelectorAll('.section').forEach(s => {
        s.style.borderLeft = '4px solid ' + '#' + Math.floor(Math.random()*16777215).toString(16);
      });
    }
  </script>
</body>
</html>`;

const TEST_PAGE_2 = testShell(
  '📍 測試頁 2',
  `  <h1>🧪 測試頁 2</h1>
  <p class="subtitle">跨頁錄製測試 — 第二頁。從頁面 1 跳來，語音/資料應保留。</p>

  <div class="section">
    <h2>🖥 Console 測試</h2>
    <div class="btn-grid">
      <button class="btn-error" onclick="console.error('❌ [TEST page2] Error triggered on page 2')">觸發 console.error</button>
      <button class="btn-warn" onclick="console.warn('⚠ [TEST page2] Warning on page 2')">觸發 console.warn</button>
    </div>
  </div>

  <div class="section">
    <h2>🔗 跨頁跳轉</h2>
    <div class="nav-links">
      <a href="/test">← 回到頁面 1</a>
      <a href="/test/page3">前往頁面 3 →</a>
    </div>
  </div>`,
);

const TEST_PAGE_3 = testShell(
  '📍 測試頁 3',
  `  <h1>🧪 測試頁 3</h1>
  <p class="subtitle">跨頁錄製測試 — 第三頁。長內容區域，可測捲動截圖。</p>

  <div class="section">
    <h2>🔗 跨頁跳轉</h2>
    <div class="nav-links">
      <a href="/test">← 回到頁面 1</a>
    </div>
  </div>

  <div class="section">
    <h2>📜 長內容區域（測捲動截圖）</h2>
${Array.from(
  { length: 20 },
  (_, i) =>
    `    <p style="padding:10px 0;border-bottom:1px solid #eee;">第 ${i + 1} 段測試內容 — 這是一段可捲動的長文字，用來驗證 BugEzy 區域截圖跨 viewport 拼接是否正確。Lorem ipsum 測試 ${i + 1}。</p>`,
).join('\n')}
  </div>`,
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // MCP 端點（Streamable HTTP）— 給 Claude.ai Connectors / IDE 直接連
    if (path === '/mcp' || path.startsWith('/mcp/')) {
      const handler = createMcpHandler(createMcpServer(env), { route: '/mcp' });
      return handler(request, env, ctx);
    }

    // PM-48：測試專頁（Test Harness）— 可預測的 Bug 場景，供 BugEzy 測試用
    if (request.method === 'GET' && path === '/test') return html(TEST_PAGE_1);
    if (request.method === 'GET' && path === '/test/page2') return html(TEST_PAGE_2);
    if (request.method === 'GET' && path === '/test/page3') return html(TEST_PAGE_3);
    // /test/api/:status — 回傳指定 HTTP status（觸發 4xx/5xx 給 Network 攔截）
    if (path.startsWith('/test/api/')) {
      const parsed = parseInt(path.split('/').pop() || '200', 10);
      const status = Number.isFinite(parsed) && parsed >= 100 && parsed <= 599 ? parsed : 200;
      return new Response(JSON.stringify({ error: `Test ${status} response` }), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    try {
      // PM-51：即時監控暫存（POST 覆蓋最新；GET 讀最新，>30s 視為過期）
      if (request.method === 'POST' && path === '/api/live-errors') {
        const data = (await request.json().catch(() => ({}))) as Partial<LiveErrors>;
        const entry: LiveErrors = {
          url: data.url,
          title: data.title,
          consoleLogs: Array.isArray(data.consoleLogs) ? data.consoleLogs : [],
          networkErrors: Array.isArray(data.networkErrors) ? data.networkErrors : [],
          timestamp: data.timestamp,
          updatedAt: Date.now(),
        };
        await env.R2.put(LIVE_ERRORS_KEY, JSON.stringify(entry), {
          httpMetadata: { contentType: 'application/json' },
        });
        return json({ ok: true });
      }
      if (request.method === 'GET' && path === '/api/live-errors') {
        return json(await readLiveErrors(env));
      }
      // PM-53：終端機 CLI agent 日誌（POST 覆蓋最新；GET 讀最新，>30s 視為過期）
      if (request.method === 'POST' && path === '/api/terminal-logs') {
        const data = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        await env.R2.put(TERMINAL_LOGS_KEY, JSON.stringify({ ...data, updatedAt: Date.now() }), {
          httpMetadata: { contentType: 'application/json' },
        });
        return json({ ok: true });
      }
      if (request.method === 'GET' && path === '/api/terminal-logs') {
        return json(await readTerminalLogs(env));
      }
      // PM-56：當月 MCP 使用量統計
      if (request.method === 'GET' && path === '/api/usage/monthly') {
        return json(await getMonthlyUsage(env));
      }
      if (request.method === 'POST' && path === '/api/summarize') {
        return await summarizeText(request, env);
      }
      if (request.method === 'POST' && path === '/api/reports') {
        return await createReport(request, env, url.origin);
      }
      if (request.method === 'GET' && path === '/api/reports') {
        return await listReports(url, env);
      }
      const match = path.match(/^\/api\/reports\/([^/]+)$/);
      if (request.method === 'GET' && match) {
        return await getReport(match[1], env);
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
};

// POST /api/reports — 上傳報告
async function createReport(request: Request, env: Env, origin: string): Promise<Response> {
  const payload = (await request.json().catch(() => null)) as RecordingPayload | null;
  if (!payload || !payload.pageInfo) {
    return json({ error: 'invalid payload：缺少 pageInfo' }, 400);
  }

  const report_id = crypto.randomUUID();
  const rrweb_r2_key = `reports/${report_id}/rrweb.json`;
  const screenshots = payload.screenshots ?? [];
  const screenshots_r2_key = screenshots.length ? `reports/${report_id}/screenshots.json` : null;

  // 大檔 rrweb 軌跡存 R2（可能數 MB）
  await env.R2.put(rrweb_r2_key, JSON.stringify(payload.rrwebEvents ?? []), {
    httpMetadata: { contentType: 'application/json' },
  });
  // 截圖（base64 PNG，也偏大）存 R2
  if (screenshots_r2_key) {
    await env.R2.put(screenshots_r2_key, JSON.stringify(screenshots), {
      httpMetadata: { contentType: 'application/json' },
    });
  }

  // metadata + 較小的 console/network/voice 存 Supabase
  const { pageInfo } = payload;
  const row = {
    report_id,
    url: pageInfo.url,
    title: pageInfo.title,
    browser: pageInfo.browser,
    screen_size: pageInfo.screenSize,
    console_count: payload.consoleLogs?.length ?? 0,
    network_count: payload.networkErrors?.length ?? 0,
    voice_count: payload.voiceTranscript?.length ?? 0,
    rrweb_count: payload.rrwebEvents?.length ?? 0,
    screenshot_count: screenshots.length,
    rrweb_r2_key,
    screenshots_r2_key,
    console_logs: payload.consoleLogs ?? [],
    network_errors: payload.networkErrors ?? [],
    voice_transcript: payload.voiceTranscript ?? [],
    description: payload.description ?? '',
    markers: payload.markers ?? [], // PM-28：時間軸標記
  };

  const { error } = await supa(env).from('reports').insert(row);
  if (error) {
    return json({ error: `supabase insert failed: ${error.message}` }, 500);
  }

  return json({
    report_id,
    share_url: `${origin}/report/${report_id}`,
  });
}

// GET /api/reports/:id — 讀回報告
async function getReport(reportId: string, env: Env): Promise<Response> {
  const { data, error } = await supa(env)
    .from('reports')
    .select('*')
    .eq('report_id', reportId)
    .single();

  if (error || !data) {
    return json({ error: 'report not found' }, 404);
  }

  // 從 R2 取回 rrweb 軌跡
  let rrwebEvents: unknown[] = [];
  if (data.rrweb_r2_key) {
    const obj = await env.R2.get(data.rrweb_r2_key as string);
    if (obj) rrwebEvents = (await obj.json()) as unknown[];
  }

  // 從 R2 取回截圖
  let screenshots: unknown[] = [];
  if (data.screenshots_r2_key) {
    const obj = await env.R2.get(data.screenshots_r2_key as string);
    if (obj) screenshots = (await obj.json()) as unknown[];
  }

  return json({
    report_id: data.report_id,
    url: data.url,
    title: data.title,
    browser: data.browser,
    screen_size: data.screen_size,
    consoleLogs: data.console_logs,
    networkErrors: data.network_errors,
    voiceTranscript: data.voice_transcript,
    description: data.description ?? '',
    markers: data.markers ?? [], // PM-28：時間軸標記
    rrwebEvents,
    screenshots,
    created_at: data.created_at,
  });
}

// GET /api/reports — 列出最近報告（metadata only，不含 rrweb / JSONB 大欄位）
async function listReports(url: URL, env: Env): Promise<Response> {
  let limit = parseInt(url.searchParams.get('limit') ?? '10', 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  if (limit > 50) limit = 50;

  let query = supa(env)
    .from('reports')
    .select(
      'report_id, url, title, browser, screen_size, console_count, network_count, voice_count, rrweb_count, screenshot_count, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  const keyword = url.searchParams.get('url');
  if (keyword) query = query.ilike('url', `%${keyword}%`);

  const { data, error } = await query;
  if (error) {
    return json({ error: `supabase query failed: ${error.message}` }, 500);
  }
  return json({ reports: data ?? [] });
}

// POST /api/summarize — 用 Workers AI 把語音記錄精簡成重點（PM-25）
async function summarizeText(request: Request, env: Env): Promise<Response> {
  const { text } = (await request.json().catch(() => ({}))) as { text?: string };
  if (!text || text.length < 10) {
    return json({ summary: text ?? '' });
  }
  try {
    const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        {
          role: 'system',
          content:
            '你是 Bug 報告精簡助手。把使用者的語音描述精簡成 2-5 個重點。保留關鍵資訊（什麼元素、什麼問題、預期行為），去除重複和口語贅詞。用繁體中文，條列式輸出。',
        },
        { role: 'user', content: `請精簡以下語音記錄：\n\n${text}` },
      ],
      max_tokens: 300,
    });
    const summary = (result as { response?: string }).response ?? '';
    return json({ summary });
  } catch (err) {
    return json({ error: `AI 精簡失敗: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

// ── MCP Server（8 Tool，直接讀 Supabase/R2，不繞 HTTP）──────
const META_COLS =
  'report_id, url, title, browser, screen_size, console_count, network_count, voice_count, rrweb_count, screenshot_count, description, markers, created_at';

function txt(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

// ── PM-54：每次 MCP 回應附 token 估算 + 對比 Claude in Chrome 的省錢 ──
interface TokenEstimate {
  bugezyTokens: number;
  chromeTokens: number;
  savedPercent: number;
  bugezyUSD: string;
  chromeUSD: string;
}

function estimateTokens(responseText: string, toolName: string): TokenEstimate {
  // 估算：字串長度 / 3.5 ≈ token 數
  const bugezyTokens = Math.ceil(responseText.length / 3.5);

  // Claude in Chrome 對比基準（同場景的 token 倍率）
  const chromeMultiplier: Record<string, number> = {
    list_reports: 5, // Chrome 要讀整頁 DOM 找報告
    get_report_overview: 10, // Chrome 要讀整頁
    get_console_logs: 20, // Chrome 讀全量 console
    get_network_errors: 20, // Chrome 讀全量 network
    get_voice_transcript: 50, // Chrome 沒有語音功能，要人工描述
    get_page_info: 15,
    get_rrweb_summary: 10,
    get_rrweb_events: 2, // 都是大量資料
    get_live_errors: 30, // Chrome 要開 DevTools 掃全頁
    get_terminal_logs: 40, // Chrome 完全做不到
  };

  const multiplier = chromeMultiplier[toolName] || 10;
  const chromeTokens = bugezyTokens * multiplier;
  const savedPercent = chromeTokens > 0 ? Math.round((1 - bugezyTokens / chromeTokens) * 100) : 0;

  // 價格：Claude Sonnet ~$3/MTok input、~$15/MTok output，簡化用 $8/MTok 平均
  const pricePerToken = 8 / 1_000_000;
  const bugezyUSD = (bugezyTokens * pricePerToken).toFixed(4);
  const chromeUSD = (chromeTokens * pricePerToken).toFixed(4);

  return { bugezyTokens, chromeTokens, savedPercent, bugezyUSD, chromeUSD };
}

function formatTokenFooter(est: TokenEstimate): string {
  return `\n\n---\n📊 Token 估算：~${est.bugezyTokens.toLocaleString()} tokens ≈ $${est.bugezyUSD}\n💡 同場景 Claude in Chrome：~${est.chromeTokens.toLocaleString()} tokens ≈ $${est.chromeUSD}\n✅ BugEzy 為你省了 ${est.savedPercent}%`;
}

// ── PM-56：月度使用量統計（每次 MCP 呼叫記錄到 Supabase mcp_usage 表）──
async function logMcpUsage(
  env: Env,
  toolName: string,
  est: TokenEstimate,
  reportId?: string,
): Promise<void> {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/mcp_usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        tool_name: toolName,
        tokens_estimated: est.bugezyTokens,
        chrome_tokens_estimated: est.chromeTokens,
        report_id: reportId ?? null,
      }),
    });
  } catch {
    // 記錄失敗不影響 MCP 回應
  }
}

/** 當月 MCP 使用量彙總（GET /api/usage/monthly 與 MCP get_usage_stats 共用） */
async function getMonthlyUsage(env: Env): Promise<Record<string, unknown>> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/mcp_usage?select=tool_name,tokens_estimated,chrome_tokens_estimated&created_at=gte.${monthStart}`,
    {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
    },
  );
  const rows = (await res.json().catch(() => [])) as Array<{
    tool_name: string;
    tokens_estimated: number;
    chrome_tokens_estimated: number;
  }>;

  let totalCalls = 0;
  let totalTokens = 0;
  let totalChromeTokens = 0;
  const byTool: Record<string, { calls: number; tokens: number }> = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    totalCalls++;
    totalTokens += row.tokens_estimated;
    totalChromeTokens += row.chrome_tokens_estimated;
    const t = row.tool_name;
    if (!byTool[t]) byTool[t] = { calls: 0, tokens: 0 };
    byTool[t].calls++;
    byTool[t].tokens += row.tokens_estimated;
  }

  const savedTokens = totalChromeTokens - totalTokens;
  return {
    month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
    totalCalls,
    totalTokens,
    totalChromeTokens,
    totalUSD: ((totalTokens * 8) / 1_000_000).toFixed(4),
    savedTokens,
    savedUSD: ((savedTokens * 8) / 1_000_000).toFixed(4),
    savedPercent: totalChromeTokens > 0 ? Math.round((1 - totalTokens / totalChromeTokens) * 100) : 0,
    byTool,
  };
}

function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: 'BugEzy', version: '0.1.0' });
  const supabase = () => supa(env);

  /**
   * 同 txt() + token footer（PM-54）+ 記錄使用量到 Supabase（PM-56）。
   * PM-56b：改 async + `await logMcpUsage` —— Workers 在回應送出後立刻終止，
   * fire-and-forget 的背景 fetch 來不及完成，導致記錄沒寫入。多等幾十毫秒不影響體驗。
   */
  const txtWithTokens = async (data: unknown, toolName: string, reportId?: string) => {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const est = estimateTokens(text, toolName);
    await logMcpUsage(env, toolName, est, reportId);
    return { content: [{ type: 'text' as const, text: text + formatTokenFooter(est) }] };
  };

  // Tool 1: list_reports
  server.tool(
    'list_reports',
    '列出最近的 Bug 報告（metadata）。List recent bug reports.',
    { limit: z.number().min(1).max(50).optional(), url: z.string().optional() },
    async (args) => {
      const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
      let query = supabase()
        .from('reports')
        .select(META_COLS)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (args.url) query = query.ilike('url', `%${args.url}%`);
      const { data, error } = await query;
      if (error) return txt(`查詢失敗: ${error.message}`);
      return txtWithTokens(data ?? [], 'list_reports');
    },
  );

  // Tool 2: get_report_overview
  server.tool(
    'get_report_overview',
    '取得報告概覽（metadata + 各筆數，不含原始資料）。Report overview.',
    { report_id: z.string() },
    async (args) => {
      const { data, error } = await supabase()
        .from('reports')
        .select(META_COLS)
        .eq('report_id', args.report_id)
        .single();
      if (error || !data) return txt('找不到報告');
      return txtWithTokens(data, 'get_report_overview', args.report_id);
    },
  );

  // Tool 3: get_console_logs
  server.tool(
    'get_console_logs',
    '取得 Console 記錄（warn/error）。Console logs.',
    { report_id: z.string() },
    async (args) => {
      const { data, error } = await supabase()
        .from('reports')
        .select('console_logs')
        .eq('report_id', args.report_id)
        .single();
      if (error || !data) return txt('找不到報告');
      return txtWithTokens(data.console_logs, 'get_console_logs', args.report_id);
    },
  );

  // Tool 4: get_network_errors
  server.tool(
    'get_network_errors',
    '取得 Network 錯誤（4xx/5xx）。Network errors.',
    { report_id: z.string() },
    async (args) => {
      const { data, error } = await supabase()
        .from('reports')
        .select('network_errors')
        .eq('report_id', args.report_id)
        .single();
      if (error || !data) return txt('找不到報告');
      return txtWithTokens(data.network_errors, 'get_network_errors', args.report_id);
    },
  );

  // Tool 5: get_voice_transcript — 最有價值的除錯線索
  server.tool(
    'get_voice_transcript',
    '取得開發者語音描述（中文轉錄）。Developer voice transcript.',
    { report_id: z.string() },
    async (args) => {
      const { data, error } = await supabase()
        .from('reports')
        .select('voice_transcript')
        .eq('report_id', args.report_id)
        .single();
      if (error || !data) return txt('找不到報告');
      return txtWithTokens(data.voice_transcript, 'get_voice_transcript', args.report_id);
    },
  );

  // Tool 6: get_page_info
  server.tool(
    'get_page_info',
    '取得頁面資訊（URL/標題/瀏覽器/解析度）。Page info.',
    { report_id: z.string() },
    async (args) => {
      const { data, error } = await supabase()
        .from('reports')
        .select('url, title, browser, screen_size, description, created_at')
        .eq('report_id', args.report_id)
        .single();
      if (error || !data) return txt('找不到報告');
      return txtWithTokens(data, 'get_page_info', args.report_id);
    },
  );

  // Tool 7: get_rrweb_summary（從 R2 讀，只回摘要）
  server.tool(
    'get_rrweb_summary',
    'DOM 軌跡摘要（事件數/時長/類型分布，不回完整資料）。rrweb summary.',
    { report_id: z.string() },
    async (args) => {
      const { data: meta } = await supabase()
        .from('reports')
        .select('rrweb_r2_key')
        .eq('report_id', args.report_id)
        .single();
      if (!meta?.rrweb_r2_key) return txt('無 DOM 軌跡');
      const obj = await env.R2.get(meta.rrweb_r2_key as string);
      if (!obj) return txt('R2 檔案不存在');
      const events = JSON.parse(await obj.text()) as Array<{ type?: number; timestamp?: number }>;
      const event_types: Record<string, number> = {};
      for (const e of events) {
        const key = `type_${e.type ?? 'unknown'}`;
        event_types[key] = (event_types[key] ?? 0) + 1;
      }
      const ts = events.map((e) => e.timestamp ?? 0).filter((t) => t > 0);
      const duration_ms = ts.length >= 2 ? Math.max(...ts) - Math.min(...ts) : 0;
      return txtWithTokens(
        { event_count: events.length, duration_ms, event_types },
        'get_rrweb_summary',
        args.report_id,
      );
    },
  );

  // Tool 8: get_rrweb_events（完整資料，⚠ 大）
  server.tool(
    'get_rrweb_events',
    '取得完整 DOM 事件（⚠ 資料量大）。Full rrweb events.',
    { report_id: z.string() },
    async (args) => {
      const { data: meta } = await supabase()
        .from('reports')
        .select('rrweb_r2_key')
        .eq('report_id', args.report_id)
        .single();
      if (!meta?.rrweb_r2_key) return txt('無 DOM 軌跡');
      const obj = await env.R2.get(meta.rrweb_r2_key as string);
      if (!obj) return txt('R2 檔案不存在');
      return txtWithTokens(await obj.text(), 'get_rrweb_events', args.report_id);
    },
  );

  // Tool 9（PM-51）: get_live_errors — 不需錄製，讀當前頁面即時 console/network errors
  server.tool(
    'get_live_errors',
    '取得當前頁面的即時 Console/Network 錯誤（背景監控，不需錄製或上傳，token 極低）。Live console/network errors of the current page (no recording needed).',
    {},
    async () => {
      const data = await readLiveErrors(env);
      if (data.stale) {
        return txt('即時監控未啟用或資料已過期（>30 秒）。請在 BugEzy popup 開啟「🔍 即時監控」後再查。');
      }
      return txtWithTokens(data, 'get_live_errors');
    },
  );

  // Tool 10（PM-53）: get_terminal_logs — 終端機 stderr/throw/crash（需跑 npx bugezy-watch）
  server.tool(
    'get_terminal_logs',
    '取得終端機的即時錯誤日誌（stderr/throw/crash）。開發者需執行 npx bugezy-watch -- <command>。Terminal error logs.',
    {},
    async () => {
      const data = await readTerminalLogs(env);
      if (data.stale) {
        return txt('終端機 Agent 未啟動或資料已過期（>30 秒）。請在終端機執行：npx bugezy-watch -- npm run dev');
      }
      return txtWithTokens(data, 'get_terminal_logs');
    },
  );

  // Tool 11（PM-56）: get_usage_stats — 當月 MCP 使用量 + 省了多少
  server.tool(
    'get_usage_stats',
    '取得當月的 MCP 使用量統計（呼叫次數、token 消耗、省了多少）。Monthly MCP usage stats.',
    {},
    async () => {
      const data = (await getMonthlyUsage(env)) as {
        month: string;
        totalCalls: number;
        totalTokens: number;
        totalChromeTokens: number;
        totalUSD: string;
        savedTokens: number;
        savedUSD: string;
        savedPercent: number;
      };
      const text =
        `📊 ${data.month} 月度使用報告\n` +
        `MCP 呼叫次數：${data.totalCalls} 次\n` +
        `BugEzy Token 消耗：~${data.totalTokens.toLocaleString()} tokens ≈ $${data.totalUSD}\n` +
        `同場景 Claude in Chrome：~${data.totalChromeTokens.toLocaleString()} tokens\n` +
        `省下的 Token：~${data.savedTokens.toLocaleString()} tokens ≈ $${data.savedUSD}\n` +
        `節省比例：${data.savedPercent}%`;
      const est = estimateTokens(text, 'get_usage_stats');
      await logMcpUsage(env, 'get_usage_stats', est); // PM-56b：await，否則 Workers 提前終止寫不進
      return { content: [{ type: 'text' as const, text: text + formatTokenFooter(est) }] };
    },
  );

  return server;
}
