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
  // PM-72：綠界 ECPay（測試環境值放 wrangler.toml [vars]；正式上線改用 secret）
  ECPAY_MERCHANT_ID: string;
  ECPAY_HASH_KEY: string;
  ECPAY_HASH_IV: string;
  ECPAY_PAYMENT_URL: string;
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
  user_id?: string; // PM-61：已登入時綁定的使用者
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

// ── PM-63：免費/付費用量限制 ────────────────────────────────
const FREE_LIMITS = {
  recording: 10, // 月 10 次錄製
  rewind: 5, // 月 5 次回溯
  mcp: 20, // 月 20 次 MCP
} as const;
type UsageType = keyof typeof FREE_LIMITS;

/** 從 Authorization: Bearer <session_token> 取 user_id（token = base64(user_id:ts)）。*/
function getUserIdFromHeader(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth) return null;
  try {
    const decoded = atob(auth.replace('Bearer ', ''));
    return decoded.split(':')[0] || null;
  } catch {
    return null;
  }
}

function html(body: string): Response {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── PM-72：綠界 ECPay CheckMacValue（依官方 AI Skill ECPay-API-Skill guides/13）──
// AIO 金流用 SHA256；TypeScript 的 encodeURIComponent 需額外把 %20→+、~→%7e、'→%27，
// 再轉小寫並還原 .NET 7 個特殊字元（-_.!*()）。順序與綠界 PHP SDK ecpayUrlEncode 一致。
function ecpayUrlEncode(source: string): string {
  let encoded = encodeURIComponent(source)
    .replace(/%20/g, '+')
    .replace(/~/g, '%7e')
    .replace(/'/g, '%27')
    .toLowerCase();
  const replacements: Record<string, string> = {
    '%2d': '-',
    '%5f': '_',
    '%2e': '.',
    '%21': '!',
    '%2a': '*',
    '%28': '(',
    '%29': ')',
  };
  for (const [enc, ch] of Object.entries(replacements)) encoded = encoded.split(enc).join(ch);
  return encoded;
}

/** 產生 CheckMacValue（AIO SHA256）。Workers 無同步 crypto，改用 crypto.subtle（async）。*/
async function generateCheckMacValue(
  params: Record<string, string>,
  hashKey: string,
  hashIV: string,
): Promise<string> {
  // 1. 排除 CheckMacValue 本身 2. Key 不分大小寫字典序排序
  const keys = Object.keys(params)
    .filter((k) => k !== 'CheckMacValue')
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  // 3. HashKey=...&k=v&...&HashIV=...
  const paramStr = keys.map((k) => `${k}=${params[k]}`).join('&');
  const raw = `HashKey=${hashKey}&${paramStr}&HashIV=${hashIV}`;
  // 4. ECPay URL encode 5. SHA256 6. 轉大寫
  const encoded = ecpayUrlEncode(raw);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** 常數時間字串比較（避免 timing attack；長度固定 64 hex）。 */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 綠界 MerchantTradeDate 格式：yyyy/MM/dd HH:mm:ss（Workers 為 UTC，測試環境可接受）。 */
function formatEcpayDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** HTML 屬性值轉義（表單 input value 用） */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** PM-73：訂閱到期日 = 自現在起算一個月後的 ISO 字串。 */
function oneMonthLaterISO(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

// ── PM-62：產品首頁（GET /）— 一頁式、深色主題、無 JS、RWD（綠界審核 + 客戶訪問用）──
const HOMEPAGE_HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BugEzy — 開發者 Bug 報告工具，AI 幫你修</title>
  <meta name="description" content="BugEzy：用中文語音描述 Bug，AI 自動分析。6 種錄製模式 + MCP 整合，省 95% Token 費用。">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#0f0f1a; color:#e0e0e0; font-family:system-ui,"Microsoft JhengHei",sans-serif; line-height:1.6; }
    a { color:#a78bfa; text-decoration:none; }
    .wrap { max-width:960px; margin:0 auto; padding:0 20px; }
    .hero { text-align:center; padding:64px 20px 48px; background:radial-gradient(ellipse at top,rgba(124,58,237,0.18),transparent 60%); }
    .logo { font-size:48px; }
    .hero h1 { font-size:34px; color:#fff; margin:6px 0; }
    .tagline { font-size:17px; color:#a78bfa; margin-bottom:26px; }
    .bullets { display:inline-flex; flex-direction:column; gap:8px; text-align:left; color:#ccc; font-size:15px; margin-bottom:28px; }
    .cta { display:inline-block; background:linear-gradient(135deg,#7c3aed,#6d28d9); color:#fff; font-weight:700; font-size:16px; padding:13px 28px; border-radius:10px; }
    .cta:hover { filter:brightness(1.1); }
    .cta-note { display:block; color:#666; font-size:12px; margin-top:10px; }
    section { padding:40px 0; }
    h2 { font-size:22px; color:#fff; text-align:center; margin-bottom:8px; }
    .sub { text-align:center; color:#888; font-size:14px; margin-bottom:28px; }
    .modes { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; }
    .mode { background:#1a1a2e; border:1px solid #2a2a3e; border-radius:12px; padding:18px; text-align:center; }
    .mode .ico { font-size:30px; }
    .mode .name { font-weight:700; color:#fff; margin:8px 0 4px; }
    .mode .desc { font-size:13px; color:#999; }
    .plans { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; }
    .plan { background:#1a1a2e; border:1px solid #2a2a3e; border-radius:14px; padding:24px; text-align:center; }
    .plan.featured { border-color:#7c3aed; box-shadow:0 0 0 1px #7c3aed; }
    .plan .pname { font-size:15px; color:#a78bfa; font-weight:700; }
    .plan .price { font-size:30px; color:#fff; font-weight:800; margin:10px 0; }
    .plan .price small { font-size:14px; color:#888; font-weight:400; }
    .plan ul { list-style:none; text-align:left; font-size:13px; color:#ccc; margin-top:14px; display:flex; flex-direction:column; gap:6px; }
    .plan li::before { content:"✓ "; color:#10b981; }
    .plan-cta { display:block; margin-top:18px; padding:10px; border-radius:10px; background:#7c3aed; color:#fff; font-weight:700; font-size:14px; text-decoration:none; }
    .plan-cta:hover { background:#6d28d9; }
    footer { border-top:1px solid #2a2a3e; padding:28px 0; text-align:center; color:#888; font-size:13px; margin-top:24px; }
    footer a { margin:0 6px; }
    /* PM-74：聯絡資訊（綠界審核要求，明顯可見） */
    .contact-info { max-width:440px; margin:0 auto 20px; padding:20px 22px; background:#1a1a2e; border:1px solid #7c3aed; border-radius:12px; }
    .contact-info h3 { font-size:17px; color:#a78bfa; margin:0 0 12px; }
    .contact-info p { margin:6px 0; font-size:15px; color:#e0e0e0; }
    .contact-info a { color:#a78bfa; margin:0; }
    /* PM-80：支援的開發框架 + MCP 工具標籤 */
    .framework-grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin:24px 0; }
    .fw-category { background:#1a1a2e; border:1px solid #2a2a3e; border-radius:12px; padding:20px; }
    .fw-category h3 { font-size:16px; margin-bottom:12px; color:#a78bfa; }
    .fw-tags { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; }
    .fw-category .fw-tags { justify-content:flex-start; }
    .fw-tags span { background:#2a2a3e; border:1px solid #7c3aed40; border-radius:20px; padding:4px 14px; font-size:13px; color:#ccc; }
    .fw-note { text-align:center; color:#888; font-size:13px; margin-top:16px; line-height:1.7; }
    .fw-note code { background:#2a2a3e; padding:2px 6px; border-radius:4px; color:#10b981; }
    .ai-tools { background:#1a1a2e; border:1px solid #2a2a3e; border-radius:12px; padding:20px; margin-top:24px; text-align:center; }
    .ai-tools h3 { font-size:16px; color:#a78bfa; margin-bottom:14px; }
    .ai-tools p { color:#888; font-size:13px; margin-top:12px; }
    @media (max-width:600px) { .framework-grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header class="hero">
    <div class="logo">🐛</div>
    <h1>BugEzy</h1>
    <p class="tagline">Web 開發者的 AI Bug 報告工具<br>前端後端一起抓，10 分鐘修好 Bug</p>
    <div class="bullets">
      <span>✅ 語音描述 Bug，AI 自動分析</span>
      <span>✅ 6 種錄製模式，完整重現問題</span>
      <span>✅ MCP 整合，AI 直接讀報告</span>
      <span>✅ 省 95% Token 費用</span>
    </div>
    <div>
      <a class="cta" href="#download">🧩 安裝 Chrome 擴充功能</a>
      <span class="cta-note">Chrome Web Store 即將上架</span>
    </div>
  </header>

  <section class="wrap" id="modes">
    <h2>六種錄製模式</h2>
    <p class="sub">依情境選最省力的方式回報 Bug</p>
    <div class="modes">
      <div class="mode"><div class="ico">🎬</div><div class="name">錄製</div><div class="desc">DOM 軌跡 + 語音 + Console/Network</div></div>
      <div class="mode"><div class="ico">⏪</div><div class="name">回溯</div><div class="desc">一鍵抓剛才發生的 30 秒</div></div>
      <div class="mode"><div class="ico">📸</div><div class="name">截圖</div><div class="desc">三種擷取 + 畫重點標注</div></div>
      <div class="mode"><div class="ico">🔇</div><div class="name">鍵盤</div><div class="desc">安靜環境，純文字模式</div></div>
      <div class="mode"><div class="ico">🔍</div><div class="name">監控</div><div class="desc">AI 隨時查當前頁 error</div></div>
      <div class="mode"><div class="ico">🖥</div><div class="name">終端機</div><div class="desc">npx bugezy-watch 攔 crash</div></div>
    </div>
  </section>

  <section class="wrap" id="frameworks">
    <h2>支援所有 Web 開發框架</h2>
    <p class="sub">只要你的產品跑在瀏覽器上，BugEzy 就能用</p>
    <div class="framework-grid">
      <div class="fw-category">
        <h3>🖥 前端框架（Chrome 擴充錄製）</h3>
        <div class="fw-tags">
          <span>React</span>
          <span>Vue</span>
          <span>Angular</span>
          <span>Next.js</span>
          <span>Nuxt</span>
          <span>Svelte</span>
          <span>HTML/CSS/JS</span>
        </div>
      </div>
      <div class="fw-category">
        <h3>⚙ 後端框架（終端機 CLI 攔截）</h3>
        <div class="fw-tags">
          <span>Django</span>
          <span>Flask</span>
          <span>FastAPI</span>
          <span>Laravel</span>
          <span>Rails</span>
          <span>Spring Boot</span>
          <span>Express</span>
          <span>Node.js</span>
        </div>
      </div>
    </div>
    <p class="fw-note">前端用 Chrome 擴充錄製 DOM + Console + Network<br>後端用 <code>npx bugezy-watch -- python manage.py runserver</code> 攔截 stderr</p>

    <div class="ai-tools">
      <h3>支援所有 MCP 工具</h3>
      <div class="fw-tags">
        <span>Claude Desktop</span>
        <span>Claude Code</span>
        <span>Cursor</span>
        <span>VS Code</span>
        <span>Zed</span>
        <span>Windsurf</span>
        <span>Codex</span>
        <span>Replit</span>
      </div>
      <p>一行 URL 連接，零安裝</p>
    </div>
  </section>

  <section class="wrap" id="pricing">
    <h2>方案與定價</h2>
    <p class="sub">免費開始，需要更多再升級</p>
    <div class="plans">
      <div class="plan">
        <div class="pname">免費版</div>
        <div class="price">NT$0</div>
        <ul>
          <li>截圖標注 無限</li>
          <li>即時監控</li>
          <li>鍵盤模式</li>
          <li>錄製 月 10 次</li>
          <li>回溯 月 5 次</li>
          <li>MCP 月 20 次</li>
          <li>報告保留 7 天</li>
        </ul>
      </div>
      <div class="plan featured">
        <div class="pname">付費版 ✨</div>
        <div class="price">NT$80<small> /月</small></div>
        <ul>
          <li>全功能無限</li>
          <li>錄製無限</li>
          <li>MCP AI 讀取無限</li>
          <li>終端機 CLI</li>
          <li>Whisper 精準語音</li>
          <li>報告保留 90 天</li>
          <li>團隊協作（即將推出）</li>
        </ul>
        <a class="plan-cta" href="#">立即升級</a>
      </div>
    </div>
  </section>

  <footer>
    <div class="contact-info">
      <h3>聯絡我們</h3>
      <p>📧 Email：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></p>
      <p>📱 電話：<a href="tel:+886983101085">0983-101-085</a></p>
      <p>服務時間：週一至週五 09:00-18:00</p>
    </div>
    <div style="margin-top:8px;"><a href="/guide">使用指南</a> | <a href="/faq">常見問題</a> | <a href="/privacy">隱私政策</a></div>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy · 亞洲平價 MCP 語音除錯工具</div>
  </footer>
</body>
</html>`;

// ── PM-64：隱私政策頁（Chrome Web Store 上架 + 綠界審核要求可訪問的隱私政策 URL）──
// 中英雙語，深色主題與首頁/報告頁統一（#0f0f1a / #7c3aed / #a78bfa），一頁式無 JS、RWD。
const PRIVACY_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>隱私政策 · BugEzy</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; background: #0f0f1a; color: #e8e8f0;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", sans-serif;
    line-height: 1.75; font-size: 15px;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 48px 24px 80px; }
  header { border-bottom: 1px solid #2a2a3e; padding-bottom: 20px; margin-bottom: 28px; }
  .brand { font-size: 24px; font-weight: 700; color: #a78bfa; text-decoration: none; }
  h1 { font-size: 26px; margin: 18px 0 6px; }
  .updated { color: #8b8fa3; font-size: 13px; }
  h2 { font-size: 18px; color: #c4b5fd; margin: 34px 0 8px; }
  h3 { font-size: 15px; color: #8b8fa3; font-weight: 600; letter-spacing: .04em;
       text-transform: uppercase; margin: 40px 0 4px; }
  ul { margin: 8px 0 0; padding-left: 22px; }
  li { margin: 4px 0; }
  a { color: #a78bfa; }
  .lang-divider {
    margin: 56px 0 0; padding-top: 8px; border-top: 1px dashed #2a2a3e; color: #8b8fa3;
  }
  footer {
    margin-top: 48px; padding-top: 20px; border-top: 1px solid #2a2a3e;
    color: #8b8fa3; font-size: 13px;
  }
  footer a { margin-right: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <a class="brand" href="/">🐛 BugEzy</a>
  </header>

  <!-- 中文版 -->
  <h1>隱私政策</h1>
  <div class="updated">最後更新：2026 年 6 月 25 日</div>

  <h2>1. 我們收集什麼資料</h2>
  <ul>
    <li>Google 帳號資訊（email、姓名、頭像）用於登入</li>
    <li>Bug 報告內容（Console logs、Network errors、DOM 快照、語音記錄、截圖）</li>
    <li>使用量統計（MCP 呼叫次數、Token 估算）</li>
  </ul>

  <h2>2. 我們如何使用資料</h2>
  <ul>
    <li>提供 Bug 報告服務</li>
    <li>AI 分析（Cloudflare Workers AI）用於語音精簡和校正</li>
    <li>使用量追蹤用於方案管理</li>
  </ul>

  <h2>3. 資料儲存</h2>
  <ul>
    <li>報告資料儲存在 Cloudflare R2（全球 CDN）</li>
    <li>使用者資料儲存在 Supabase（PostgreSQL）</li>
    <li>免費版報告保留 7 天，付費版保留 90 天</li>
  </ul>

  <h2>4. 資料分享</h2>
  <ul>
    <li>我們不會將您的資料出售給第三方</li>
    <li>報告資料僅在您主動分享連結時才對外可見</li>
    <li>AI 分析由 Cloudflare Workers AI 處理，不會將資料傳送給其他 AI 服務商</li>
  </ul>

  <h2>5. 您的權利</h2>
  <ul>
    <li>您可以隨時刪除您的報告</li>
    <li>您可以要求刪除您的帳號和所有相關資料</li>
    <li>聯絡 <a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a> 提出請求</li>
  </ul>

  <h2>6. Cookie 和追蹤</h2>
  <ul>
    <li>我們不使用第三方追蹤 Cookie</li>
    <li>Chrome 擴充使用 chrome.storage.local 儲存登入狀態</li>
  </ul>

  <h2>7. 變更通知</h2>
  <ul>
    <li>隱私政策變更時，我們會在首頁公告</li>
  </ul>

  <p>聯絡方式：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></p>

  <!-- English version -->
  <div class="lang-divider"></div>
  <h1>Privacy Policy</h1>
  <div class="updated">Last updated: June 25, 2026</div>

  <h2>1. What We Collect</h2>
  <ul>
    <li>Google account info (email, name, avatar) for sign-in</li>
    <li>Bug report contents (console logs, network errors, DOM snapshots, voice notes, screenshots)</li>
    <li>Usage statistics (MCP call counts, token estimates)</li>
  </ul>

  <h2>2. How We Use Data</h2>
  <ul>
    <li>To provide the bug-reporting service</li>
    <li>AI analysis (Cloudflare Workers AI) for voice cleanup and correction</li>
    <li>Usage tracking for plan management</li>
  </ul>

  <h2>3. Data Storage</h2>
  <ul>
    <li>Report data is stored on Cloudflare R2 (global CDN)</li>
    <li>User data is stored on Supabase (PostgreSQL)</li>
    <li>Free-plan reports are kept for 7 days; paid-plan reports for 90 days</li>
  </ul>

  <h2>4. Data Sharing</h2>
  <ul>
    <li>We do not sell your data to third parties</li>
    <li>Report data is only publicly visible when you actively share its link</li>
    <li>AI analysis is processed by Cloudflare Workers AI and is not sent to any other AI provider</li>
  </ul>

  <h2>5. Your Rights</h2>
  <ul>
    <li>You may delete your reports at any time</li>
    <li>You may request deletion of your account and all related data</li>
    <li>Contact <a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a> to make a request</li>
  </ul>

  <h2>6. Cookies & Tracking</h2>
  <ul>
    <li>We do not use third-party tracking cookies</li>
    <li>The Chrome extension uses chrome.storage.local to store sign-in state</li>
  </ul>

  <h2>7. Change Notice</h2>
  <ul>
    <li>When this policy changes, we will announce it on the homepage</li>
  </ul>

  <p>Contact: <a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></p>

  <footer>
    <a href="/">← 回首頁 / Home</a>
    <a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy</div>
  </footer>
</div>
</body>
</html>`;

// ── PM-66：操作說明頁（新手三步上手 + 六種模式 + MCP 設定 + 小技巧）──
// 深色主題與首頁/隱私頁統一（#0f0f1a / #7c3aed / #a78bfa），一頁式無 JS、RWD、繁中。
const GUIDE_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>使用指南 · BugEzy</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; background: #0f0f1a; color: #e8e8f0;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", sans-serif;
    line-height: 1.75; font-size: 15px;
  }
  .wrap { max-width: 820px; margin: 0 auto; padding: 48px 24px 80px; }
  header { border-bottom: 1px solid #2a2a3e; padding-bottom: 20px; margin-bottom: 28px; }
  .brand { font-size: 24px; font-weight: 700; color: #a78bfa; text-decoration: none; }
  h1 { font-size: 28px; margin: 18px 0 6px; }
  .lead { color: #8b8fa3; font-size: 15px; }
  .step {
    margin: 32px 0 0; padding: 22px 24px; background: #1a1a2e;
    border: 1px solid #2a2a3e; border-radius: 14px;
  }
  .step h2 { font-size: 19px; color: #c4b5fd; margin: 0 0 12px; }
  .step ol { margin: 0; padding-left: 22px; }
  .step ol li { margin: 6px 0; }
  .mode {
    margin: 16px 0 0; padding: 14px 16px; background: #15152a;
    border: 1px solid #2a2a3e; border-radius: 10px;
  }
  .mode .mname { font-size: 16px; font-weight: 700; color: #fff; }
  .mode .mrow { font-size: 14px; color: #ccc; margin-top: 4px; }
  .mode .mrow b { color: #a78bfa; font-weight: 600; }
  .mcp-box {
    margin-top: 14px; padding: 14px 16px; background: #15152a;
    border: 1px solid #7c3aed; border-radius: 10px; font-size: 14px;
  }
  .mcp-box code {
    display: inline-block; margin-top: 4px; padding: 4px 8px; border-radius: 6px;
    background: #0f0f1a; color: #7ee0c5; font-family: ui-monospace, monospace; word-break: break-all;
  }
  /* PM-77：MCP 設定（警示 + 各工具步驟 + JSON 範例） */
  .mcp-warn { margin-top: 10px; padding: 10px 12px; border-radius: 8px;
    background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.45); color: #fcd34d; font-size: 13px; }
  .mcp-tool { margin-top: 12px; }
  .mcp-tool .tname { font-weight: 700; color: #c4b5fd; font-size: 13px; }
  .mcp-tool .tstep { color: #ccc; font-size: 13px; margin-top: 2px; }
  .mcp-box pre { margin: 6px 0 0; padding: 10px 12px; background: #0f0f1a; border-radius: 6px;
    color: #7ee0c5; font-family: ui-monospace, monospace; font-size: 12px; overflow-x: auto; white-space: pre; }
  .tips { margin: 10px 0 0; padding-left: 22px; }
  .tips li { margin: 6px 0; color: #ccc; }
  a { color: #a78bfa; }
  footer {
    margin-top: 48px; padding-top: 20px; border-top: 1px solid #2a2a3e;
    color: #8b8fa3; font-size: 13px;
  }
  footer .links a { margin-right: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <header><a class="brand" href="/">🐛 BugEzy</a></header>

  <h1>🐛 BugEzy 使用指南</h1>
  <p class="lead">讓 AI 幫你修 Bug，只需三步。</p>

  <div class="step">
    <h2>🚀 第一步：安裝與登入</h2>
    <ol>
      <li>從 Chrome Web Store 安裝 BugEzy 擴充功能</li>
      <li>點擊右上角 BugEzy 圖示 🐛</li>
      <li>按「用 Google 登入」→ 完成</li>
    </ol>
  </div>

  <div class="step">
    <h2>🎯 第二步：錄下 Bug（六種模式任選）</h2>

    <div class="mode">
      <div class="mname">🎬 錄製</div>
      <div class="mrow"><b>適合：</b>完整重現 Bug 過程</div>
      <div class="mrow"><b>用法：</b>按「錄製」→ 操作網頁重現 Bug → 語音描述問題 → 按「停止」</div>
      <div class="mrow"><b>錄到：</b>DOM 變化 + Console + Network + 語音</div>
    </div>

    <div class="mode">
      <div class="mname">⏪ 30 秒回溯</div>
      <div class="mrow"><b>適合：</b>Bug 已經發生，來不及錄</div>
      <div class="mrow"><b>用法：</b>按「回溯 30s」→ 自動抓回最近 30 秒的操作</div>
      <div class="mrow">不用提前按錄製，BugEzy 在背景持續記錄</div>
    </div>

    <div class="mode">
      <div class="mname">📸 截圖標注</div>
      <div class="mrow"><b>適合：</b>快速指出畫面問題</div>
      <div class="mrow"><b>用法：</b>按「截圖標注」→ 畫筆/箭頭/框框標出問題 → 加文字說明</div>
      <div class="mrow"><b>三種模式：</b>整頁截圖 / 可見範圍 / 自選區域</div>
    </div>

    <div class="mode">
      <div class="mname">🔇 鍵盤模式</div>
      <div class="mrow"><b>適合：</b>吵雜環境（咖啡廳、辦公室）</div>
      <div class="mrow"><b>用法：</b>開啟鍵盤模式 → 關閉語音辨識 → 用文字描述 Bug</div>
    </div>

    <div class="mode">
      <div class="mname">🔍 即時監控</div>
      <div class="mrow"><b>適合：</b>掛著等 Bug 自己出現</div>
      <div class="mrow"><b>用法：</b>開啟即時監控 → 頁面右下角出現 🐛 badge → 有 error 自動變紅 + 顯示數字</div>
      <div class="mrow">點 badge 展開 error 清單</div>
    </div>

    <div class="mode">
      <div class="mname">🖥 終端機</div>
      <div class="mrow"><b>適合：</b>Server 端的錯誤（Node.js、Python 等）</div>
      <div class="mrow"><b>用法：</b>終端機輸入 <code style="color:#7ee0c5;">npx bugezy-watch -- npm run dev</code></div>
      <div class="mrow">自動攔截 stderr / throw / crash</div>
    </div>
  </div>

  <div class="step">
    <h2>📝 第三步：編輯與上傳</h2>
    <ol>
      <li>錄製停止後進入編輯頁</li>
      <li>可以編輯語音文字、加補充說明</li>
      <li>按「🔧 AI 校正」修正錯字（選用）</li>
      <li>按「🤖 AI 精簡」濃縮重點（選用）</li>
      <li>按「上傳」→ 報告自動儲存到雲端</li>
    </ol>
  </div>

  <div class="step">
    <h2>🤖 第四步：讓 AI 幫你修</h2>
    <p><b style="color:#c4b5fd;">方法一：在 Claude / Cursor / VS Code 直接問</b><br />
      「讀我最新的 BugEzy 報告，告訴我怎麼修」<br />
      AI 透過 MCP 自動讀取報告 → 分析 Console error + Network error → 給出修復建議</p>
    <p style="margin-top:12px;"><b style="color:#c4b5fd;">方法二：分享報告連結</b><br />
      上傳後會產生報告連結，傳給同事或貼到 Issue</p>
    <div class="mcp-box">
      <b>🔌 MCP 連接設定</b><br />
      BugEzy MCP 網址（所有工具通用）：<br />
      <code>https://bugezy-api.bugezy-api.workers.dev/mcp</code>
      <div class="mcp-warn">⚠ 注意：這個網址<b>不能用瀏覽器開</b>，它是專給 AI 工具連接的協議。用瀏覽器開只會看到一段錯誤訊息，屬正常現象——請依下方步驟在 AI 工具裡設定。</div>

      <div class="mcp-tool"><div class="tname">Claude.ai</div><div class="tstep">Settings → Connectors → Add → 貼上網址 → 連接</div></div>
      <div class="mcp-tool"><div class="tname">Claude Desktop</div><div class="tstep">編輯 claude_desktop_config.json，加入：</div><pre>{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy-api.bugezy-api.workers.dev/mcp"
    }
  }
}</pre></div>
      <div class="mcp-tool"><div class="tname">Cursor</div><div class="tstep">Settings → MCP → Add Server → 貼上網址</div></div>
      <div class="mcp-tool"><div class="tname">VS Code</div><div class="tstep">Settings → 搜尋 MCP → Add Server → 貼上網址</div></div>
      <div class="mcp-tool"><div class="tname">Claude Code（終端機）</div><div class="tstep">執行：<code>claude mcp add --transport http bugezy https://bugezy-api.bugezy-api.workers.dev/mcp</code></div></div>
      <div class="mcp-tool"><div class="tname">Zed</div><div class="tstep">設定檔加 context_servers</div></div>

      <div style="margin-top:14px;color:#ccc;font-size:13px;">連接成功後，直接問 AI：<br /><b style="color:#a78bfa;">「讀我最新的 BugEzy 報告，告訴我怎麼修」</b><br />AI 就會透過 MCP 自動讀取你的 Bug 報告。</div>
    </div>
  </div>

  <div class="step">
    <h2>💡 小技巧</h2>
    <ul class="tips">
      <li>錄製時對著麥克風說「這個按鈕按下去沒反應」比打字快 10 倍</li>
      <li>即時監控可以掛一整天，有 error 才通知你</li>
      <li>免費版每月可錄 10 次，截圖和即時監控無限用</li>
      <li>用 BugEzy MCP 讀報告比截圖貼給 AI 省 95% Token</li>
    </ul>
  </div>

  <footer>
    <div class="links">
      <a href="/">首頁</a>
      <a href="/faq">FAQ</a>
      <a href="/privacy">隱私政策</a>
    </div>
    <div style="margin-top:8px;">聯絡：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></div>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy</div>
  </footer>
</div>
</body>
</html>`;

// ── PM-66：FAQ 頁（四大類問答，手風琴點擊展開/收合，單一展開）──
const FAQ_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>常見問題 · BugEzy</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; background: #0f0f1a; color: #e8e8f0;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", sans-serif;
    line-height: 1.75; font-size: 15px;
  }
  .wrap { max-width: 760px; margin: 0 auto; padding: 48px 24px 80px; }
  header { border-bottom: 1px solid #2a2a3e; padding-bottom: 20px; margin-bottom: 28px; }
  .brand { font-size: 24px; font-weight: 700; color: #a78bfa; text-decoration: none; }
  h1 { font-size: 28px; margin: 18px 0 6px; }
  h2 { font-size: 17px; color: #c4b5fd; margin: 36px 0 10px; }
  .faq-q {
    cursor: pointer; padding: 16px; background: #1a1a2e; border-radius: 8px;
    margin-bottom: 4px; font-weight: 600; display: flex; justify-content: space-between;
    align-items: center; gap: 12px; border: 1px solid #2a2a3e;
  }
  .faq-q::after { content: '▼'; transition: transform 0.2s; color: #8b8fa3; font-size: 12px; }
  .faq-q.open::after { transform: rotate(180deg); }
  .faq-a {
    max-height: 0; overflow: hidden; transition: max-height 0.3s;
    padding: 0 16px; color: #aaa; line-height: 1.8;
  }
  .faq-a p { margin: 14px 0; }
  .faq-a code { color: #7ee0c5; font-family: ui-monospace, monospace; word-break: break-all; }
  a { color: #a78bfa; }
  footer {
    margin-top: 48px; padding-top: 20px; border-top: 1px solid #2a2a3e;
    color: #8b8fa3; font-size: 13px;
  }
  footer .links a { margin-right: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <header><a class="brand" href="/">🐛 BugEzy</a></header>

  <h1>🐛 BugEzy 常見問題</h1>

  <h2>📌 關於產品</h2>
  <div class="faq-q">BugEzy 是什麼？</div>
  <div class="faq-a"><p>BugEzy 是一款 Chrome 擴充功能，讓開發者用語音 + 錄製的方式記錄 Bug，AI 透過 MCP 自動讀取報告並提供修復建議。省下 95% 的 debug 溝通時間。</p></div>

  <div class="faq-q">跟 Jam 有什麼不同？</div>
  <div class="faq-a"><p>BugEzy 專為亞洲開發者設計，支援中文語音辨識。價格只有 Jam 的 1/5（NT$80 vs $14 USD）。獨家功能：即時監控、30 秒回溯、終端機 CLI、Token 透明度。</p></div>

  <div class="faq-q">支援哪些 AI 工具？</div>
  <div class="faq-a"><p>任何支援 MCP 的 AI 工具都能用，包括 Claude Desktop、Claude Code、Cursor、VS Code + Copilot、Zed、Windsurf、Codex、Replit 等。只需要一行 URL：<code>https://bugezy-api.bugezy-api.workers.dev/mcp</code></p></div>

  <h2>🔒 關於隱私與安全</h2>
  <div class="faq-q">BugEzy 會錄到我的密碼嗎？</div>
  <div class="faq-a"><p>BugEzy 錄製的是 DOM 結構變化，不是螢幕截圖。密碼輸入框（type="password"）的內容會被 rrweb 自動遮蔽，不會錄到實際密碼。</p></div>

  <div class="faq-q">我的報告誰能看到？</div>
  <div class="faq-a"><p>只有你自己。報告預設為私人，只有當你主動分享報告連結時，別人才能看到。</p></div>

  <div class="faq-q">資料存在哪裡？</div>
  <div class="faq-a"><p>報告存在 Cloudflare R2（全球 CDN），使用者資料存在 Supabase（PostgreSQL）。所有傳輸都經過 HTTPS 加密。</p></div>

  <h2>💰 關於方案與付費</h2>
  <div class="faq-q">免費版有什麼限制？</div>
  <div class="faq-a"><p>免費版每月可錄製 10 次、回溯 5 次、MCP 查詢 20 次。截圖標注和即時監控無限使用。報告保留 7 天。</p></div>

  <div class="faq-q">付費版多少錢？</div>
  <div class="faq-a"><p>NT$80/月（約 $3 USD），解鎖全功能無限次使用，報告保留 90 天，加上終端機 CLI、Whisper 精準語音等進階功能。</p></div>

  <div class="faq-q">如何升級付費版？</div>
  <div class="faq-a"><p>在 BugEzy popup 點「升級」按鈕，透過信用卡或 ATM 付款。</p></div>

  <div class="faq-q">可以取消訂閱嗎？</div>
  <div class="faq-a"><p>可以，隨時取消。取消後當月剩餘天數仍可使用付費功能，下個月恢復為免費版。</p></div>

  <h2>🛠 關於技術</h2>
  <div class="faq-q">哪些瀏覽器支援？</div>
  <div class="faq-a"><p>目前支援 Chrome 和所有 Chromium 瀏覽器（Edge、Brave、Arc 等）。</p></div>

  <div class="faq-q">會影響網頁效能嗎？</div>
  <div class="faq-a"><p>影響極小。BugEzy 只在你主動錄製時才記錄 DOM 變化，即時監控模式只攔截 Console error 和 Network error，不錄 DOM。</p></div>

  <div class="faq-q">MCP 是什麼？</div>
  <div class="faq-a"><p>Model Context Protocol（模型上下文協議），是 Anthropic 推出的開放標準，讓 AI 工具可以連接外部服務。BugEzy 的 MCP 讓 AI 直接讀取你的 Bug 報告，不需要複製貼上。</p></div>

  <div class="faq-q">Token 是什麼？為什麼 BugEzy 能省 Token？</div>
  <div class="faq-a"><p>Token 是 AI 處理文字的計量單位，等於你的 AI 使用費用。BugEzy 用結構化文字（而非截圖）傳送報告給 AI，同樣的 Bug 資訊只需要 1/20 的 Token。每次 MCP 查詢都會顯示 Token 估算，讓你看到省了多少。</p></div>

  <footer>
    <div class="links">
      <a href="/">首頁</a>
      <a href="/guide">使用指南</a>
      <a href="/privacy">隱私政策</a>
    </div>
    <div style="margin-top:8px;">聯絡：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></div>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy</div>
  </footer>
</div>
<script>
document.querySelectorAll('.faq-q').forEach(function (q) {
  q.addEventListener('click', function () {
    var a = q.nextElementSibling;
    var isOpen = a.style.maxHeight;
    document.querySelectorAll('.faq-a').forEach(function (el) { el.style.maxHeight = null; });
    document.querySelectorAll('.faq-q').forEach(function (el) { el.classList.remove('open'); });
    if (!isOpen) {
      a.style.maxHeight = a.scrollHeight + 'px';
      q.classList.add('open');
    }
  });
});
</script>
</body>
</html>`;

// ── PM-59：Server 直接 serve 報告頁 HTML（vanilla JS 讀 /api/reports/:id 渲染）──
// ⚠ 規格 HTML 讀 snake_case（console_logs / rrweb_count），但 GET /api/reports/:id 實際回
// camelCase（consoleLogs / networkErrors / voiceTranscript / rrwebEvents）——已實測確認。
// 直接照規格部署會整頁空白，故此處欄位名改為 camelCase 以正確渲染資料。
const REPORT_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BugEzy — Bug 報告</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#0f0f1a; color:#e0e0e0; font-family:system-ui,"Microsoft JhengHei",sans-serif; }
    .topbar { display:flex; align-items:center; gap:12px; padding:12px 24px; background:#1a1a2e; border-bottom:1px solid #2a2a3e; }
    .topbar-brand { font-size:18px; font-weight:700; color:#a78bfa; }
    .topbar-title { color:#888; font-size:14px; }
    .report { max-width:1100px; margin:0 auto; padding:24px; }
    .header { margin-bottom:20px; }
    .header h1 { font-size:20px; color:#fff; margin-bottom:8px; }
    .meta { font-size:13px; color:#888; line-height:1.8; }
    .meta a { color:#a78bfa; text-decoration:none; }
    .tab-bar { display:flex; gap:0; border-bottom:2px solid #2a2a3e; margin:20px 0 0; overflow-x:auto; }
    .tab-btn { padding:10px 20px; background:none; border:none; border-bottom:2px solid transparent; margin-bottom:-2px; color:#888; font-size:14px; font-weight:500; cursor:pointer; white-space:nowrap; display:flex; align-items:center; gap:6px; transition:all 0.15s; }
    .tab-btn:hover { color:#ccc; background:rgba(124,58,237,0.05); }
    .tab-btn.active { color:#a78bfa; border-bottom-color:#7c3aed; }
    .tab-badge { font-size:11px; padding:1px 7px; border-radius:10px; background:#2a2a3e; color:#aaa; }
    .tab-badge.error { background:rgba(239,68,68,0.2); color:#ef4444; }
    .tab-content { min-height:200px; padding:16px 0; }
    .tab-panel { display:none; }
    .tab-panel.active { display:block; }
    .info-section { margin-bottom:20px; }
    .info-section h3 { font-size:14px; color:#a78bfa; margin-bottom:8px; }
    .info-section p { color:#ccc; line-height:1.7; white-space:pre-wrap; }
    .info-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:8px; font-size:13px; color:#aaa; }
    .marker-item { display:flex; gap:8px; padding:6px 0; border-bottom:1px solid #1a1a2e; font-size:13px; color:#ccc; }
    .marker-time { background:#7c3aed; color:#fff; padding:2px 8px; border-radius:4px; font-family:monospace; font-size:12px; }
    .log-item { padding:8px 12px; border-bottom:1px solid #1a1a2e; font-family:monospace; font-size:13px; display:flex; gap:8px; }
    .log-item.error { color:#ef4444; }
    .log-item.warn { color:#f59e0b; }
    .log-icon { flex-shrink:0; }
    .log-msg { word-break:break-all; }
    .log-time { color:#555; font-size:11px; margin-left:auto; flex-shrink:0; }
    .net-item { padding:8px 12px; border-bottom:1px solid #1a1a2e; font-family:monospace; font-size:13px; display:flex; gap:12px; align-items:center; }
    .net-status { font-weight:700; min-width:36px; }
    .net-status.s4xx { color:#f59e0b; }
    .net-status.s5xx { color:#ef4444; }
    .net-method { color:#3b82f6; min-width:40px; }
    .net-url { color:#ccc; word-break:break-all; flex:1; }
    .net-duration { color:#555; font-size:11px; }
    .voice-item { padding:8px 12px; border-bottom:1px solid #1a1a2e; font-size:14px; color:#ccc; line-height:1.6; }
    .voice-time { color:#555; font-size:11px; margin-right:8px; }
    .ss-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
    .ss-img { width:100%; border-radius:8px; border:1px solid #2a2a3e; cursor:pointer; }
    .ss-img:hover { border-color:#7c3aed; }
    /* PM-82：允許 AI 讀取截圖圖片 勾選 */
    .screenshot-toggle { padding:16px; margin:0 0 16px; background:#161b22; border:1px solid #30363d; border-radius:10px; }
    .screenshot-toggle label { display:flex; align-items:center; gap:10px; cursor:pointer; font-size:15px; color:#f0f6fc; }
    .screenshot-toggle input[type="checkbox"] { width:18px; height:18px; accent-color:#7c3aed; flex-shrink:0; }
    .toggle-hint { margin-top:8px; font-size:13px; color:#8b949e; }
    .toggle-token { margin-top:4px; font-size:12px; color:#d29922; font-family:monospace; }
    .token-panel { margin-top:24px; padding:16px; background:#1a1a2e; border:1px solid rgba(124,58,237,0.3); border-radius:12px; }
    .token-row { display:flex; justify-content:space-between; padding:3px 0; font-size:13px; color:#aaa; }
    .token-row.total { border-top:1px solid #2a2a3e; margin-top:6px; padding-top:6px; font-weight:700; color:#fff; }
    .token-save { margin-top:10px; padding:10px; background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.3); border-radius:8px; font-size:13px; color:#10b981; text-align:center; }
    .loading { text-align:center; padding:60px; color:#888; }
    .error-msg { text-align:center; padding:60px; color:#ef4444; }
    .empty { text-align:center; padding:24px; color:#555; font-size:13px; }
  </style>
</head>
<body>
  <div class="topbar">
    <span class="topbar-brand">🐛 BugEzy</span>
    <span class="topbar-title">Bug 報告</span>
  </div>
  <div class="report" id="app">
    <div class="loading" id="loading">載入中…</div>
  </div>
  <script>
    const reportId = location.pathname.split('/report/')[1];
    const API = location.origin;

    fetch(API + '/api/reports/' + reportId)
      .then(r => { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then(render)
      .catch(() => {
        document.getElementById('app').innerHTML = '<div class="error-msg">找不到報告</div>';
      });

    function fmtTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const p = n => String(n).padStart(2,'0');
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
    function fmtDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      const p = n => String(n).padStart(2,'0');
      return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());
    }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    function render(r) {
      const consoleCount = r.consoleLogs?.length || 0;
      const networkCount = r.networkErrors?.length || 0;
      const voiceCount = r.voiceTranscript?.length || 0;
      const ssCount = r.screenshots?.length || 0;
      const markers = r.markers || [];

      let html = '<div class="header">';
      html += '<h1>' + esc(r.title || '（無標題）') + '</h1>';
      html += '<div class="meta">';
      html += '<div>URL：<a href="'+esc(r.url)+'" target="_blank">'+esc(r.url)+'</a></div>';
      html += '<div>'+esc(r.browser||'')+(r.screen_size ? ' ｜ '+r.screen_size : '')+'</div>';
      html += '<div>'+fmtDate(r.created_at)+'</div>';
      html += '</div></div>';

      const tabs = [
        { key:'info', label:'Info', count:null },
        { key:'console', label:'Console', count:consoleCount, isError:true },
        { key:'network', label:'Network', count:networkCount },
        { key:'voice', label:'Voice', count:voiceCount },
      ];
      if (ssCount > 0) tabs.push({ key:'screenshots', label:'📸', count:ssCount });

      let defaultTab = 'info';
      if (consoleCount > 0) defaultTab = 'console';
      else if (networkCount > 0) defaultTab = 'network';

      html += '<div class="tab-bar">';
      tabs.forEach(t => {
        const badge = t.count !== null && t.count > 0
          ? '<span class="tab-badge'+(t.isError?' error':'')+'">'+t.count+'</span>'
          : '';
        html += '<button class="tab-btn'+(t.key===defaultTab?' active':'')+'" data-tab="'+t.key+'">'+t.label+badge+'</button>';
      });
      html += '</div>';

      html += '<div class="tab-content">';

      html += '<div class="tab-panel'+(defaultTab==='info'?' active':'')+'" id="tab-info">';
      if (r.description) {
        html += '<div class="info-section"><h3>💬 描述</h3><p>'+esc(r.description)+'</p></div>';
      }
      if (markers.length > 0) {
        html += '<div class="info-section"><h3>📌 時間軸標記</h3>';
        markers.forEach(m => {
          const min = Math.floor(m.time_sec/60);
          const sec = String(m.time_sec%60).padStart(2,'0');
          html += '<div class="marker-item"><span class="marker-time">'+min+':'+sec+'</span><span>'+esc(m.note||'（無描述）')+'</span></div>';
        });
        html += '</div>';
      }
      html += '<div class="info-section"><h3>📊 摘要</h3><div class="info-grid">';
      html += '<div>DOM 事件：'+(r.rrwebEvents?.length||0)+'</div>';
      html += '<div>Console：'+consoleCount+'</div>';
      html += '<div>Network：'+networkCount+'</div>';
      html += '<div>語音：'+voiceCount+' 段</div>';
      html += '<div>截圖：'+ssCount+'</div>';
      html += '</div></div></div>';

      html += '<div class="tab-panel'+(defaultTab==='console'?' active':'')+'" id="tab-console">';
      if (consoleCount === 0) {
        html += '<div class="empty">沒有 Console 錯誤 ✓</div>';
      } else {
        (r.consoleLogs||[]).forEach(log => {
          const cls = log.level === 'error' ? 'error' : 'warn';
          const icon = log.level === 'error' ? '❌' : '⚠';
          html += '<div class="log-item '+cls+'"><span class="log-icon">'+icon+'</span><span class="log-msg">'+esc(log.message)+'</span><span class="log-time">'+fmtTime(log.timestamp)+'</span></div>';
        });
      }
      html += '</div>';

      html += '<div class="tab-panel'+(defaultTab==='network'?' active':'')+'" id="tab-network">';
      if (networkCount === 0) {
        html += '<div class="empty">沒有 Network 錯誤 ✓</div>';
      } else {
        (r.networkErrors||[]).forEach(err => {
          const cls = err.status >= 500 ? 's5xx' : 's4xx';
          html += '<div class="net-item"><span class="net-status '+cls+'">'+err.status+'</span><span class="net-method">'+esc(err.method)+'</span><span class="net-url">'+esc(err.url)+'</span><span class="net-duration">'+(err.duration||0)+'ms</span></div>';
        });
      }
      html += '</div>';

      html += '<div class="tab-panel'+(defaultTab==='voice'?' active':'')+'" id="tab-voice">';
      if (voiceCount === 0) {
        html += '<div class="empty">沒有語音記錄</div>';
      } else {
        (r.voiceTranscript||[]).forEach(v => {
          html += '<div class="voice-item"><span class="voice-time">'+fmtTime(v.timestamp)+'</span>'+esc(v.text)+'</div>';
        });
      }
      html += '</div>';

      if (ssCount > 0) {
        const allowImg = r.allowScreenshotImages === true; // PM-82
        const approxTok = (ssCount * 5000).toLocaleString();
        html += '<div class="tab-panel" id="tab-screenshots">';
        html += '<div class="screenshot-toggle">'
          + '<label><input type="checkbox" id="allow-images-toggle"'+(allowImg?' checked':'')+' />'
          + '<span class="toggle-label">📸 高畫質 AI 分析（高 Token）</span></label>'
          + '<p class="toggle-hint" id="toggle-hint">'+(allowImg
              ? '✅ 已開啟 — AI 可看到截圖畫面，視覺 Bug 更精準（顏色、排版、CSS）'
              : '🔒 未開啟 — AI 只讀文字，省 Token。遇到視覺 Bug 再開啟')+'</p>'
          + '<p class="toggle-token" id="toggle-token">'+(allowImg
              ? '⚠️ 每張截圖約 3,000~8,000 tokens（'+ssCount+' 張 ≈ '+approxTok+' tokens）'
              : '💰 目前 AI 讀取此報告約 200~1,500 tokens')+'</p>'
          + '</div>';
        html += '<div class="ss-grid">';
        (r.screenshots||[]).forEach(ss => {
          const src = typeof ss === 'string' ? ss : ss.dataUrl || ss.url || '';
          if (src) html += '<img class="ss-img" src="'+src+'" onclick="window.open(this.src)">';
        });
        html += '</div></div>';
      }

      html += '</div>';

      const voiceText = (r.voiceTranscript||[]).map(v=>v.text).join('');
      const consoleText = JSON.stringify(r.consoleLogs||[]);
      const networkText = JSON.stringify(r.networkErrors||[]);
      const descText = r.description || '';
      const items = [
        { label:'🎤 語音記錄', len:voiceText.length },
        { label:'🖥 Console', len:consoleText.length },
        { label:'🌐 Network', len:networkText.length },
        { label:'📝 描述', len:descText.length },
        { label:'📹 DOM 摘要', len:105 },
      ];
      let totalT = 0;
      let tokenHtml = '';
      items.forEach(it => {
        const t = Math.ceil(it.len / 3.5);
        if (t > 0) { totalT += t; tokenHtml += '<div class="token-row"><span>'+it.label+'</span><span>~'+t.toLocaleString()+' tokens</span></div>'; }
      });
      const chromeT = totalT * 15;
      const pct = chromeT > 0 ? Math.round((1-totalT/chromeT)*100) : 0;
      tokenHtml += '<div class="token-row total"><span>AI 讀取總計</span><span>~'+totalT.toLocaleString()+' tokens ≈ $'+((totalT*8/1e6).toFixed(4))+'</span></div>';
      html += '<div class="token-panel"><div style="font-weight:600;margin-bottom:8px;color:#a78bfa;">📊 Token 估算</div>' + tokenHtml;
      html += '<div class="token-save">💡 同場景 Claude in Chrome：~'+chromeT.toLocaleString()+' tokens ≈ $'+((chromeT*8/1e6).toFixed(4))+'<br>✅ BugEzy 為你省了 '+pct+'%</div></div>';

      document.getElementById('app').innerHTML = html;

      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
          btn.classList.add('active');
          document.getElementById('tab-' + btn.dataset.tab)?.classList.add('active');
        });
      });

      // PM-82：允許 AI 讀取截圖圖片 — 勾選即時更新提示 + PATCH 存回 Supabase
      const ssToggle = document.getElementById('allow-images-toggle');
      if (ssToggle) {
        ssToggle.addEventListener('change', async () => {
          const allow = ssToggle.checked;
          const cnt = (r.screenshots||[]).length;
          const ht = document.getElementById('toggle-hint');
          const tk = document.getElementById('toggle-token');
          if (ht) ht.textContent = allow
            ? '✅ 已開啟 — AI 可看到截圖畫面，視覺 Bug 更精準（顏色、排版、CSS）'
            : '🔒 未開啟 — AI 只讀文字，省 Token。遇到視覺 Bug 再開啟';
          if (tk) tk.textContent = allow
            ? '⚠️ 每張截圖約 3,000~8,000 tokens（'+cnt+' 張 ≈ '+(cnt*5000).toLocaleString()+' tokens）'
            : '💰 目前 AI 讀取此報告約 200~1,500 tokens';
          try {
            await fetch('/api/reports/' + reportId + '/settings', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ allow_screenshot_images: allow }),
            });
          } catch (err) { console.error('儲存失敗', err); }
        });
      }
    }
  </script>
</body>
</html>`;

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

    // PM-62：產品首頁（根目錄）— 放在所有路由之前
    if (request.method === 'GET' && path === '/') return html(HOMEPAGE_HTML);
    if (request.method === 'GET' && path === '/privacy') return html(PRIVACY_PAGE_HTML); // PM-64
    if (request.method === 'GET' && path === '/guide') return html(GUIDE_PAGE_HTML); // PM-66
    if (request.method === 'GET' && path === '/faq') return html(FAQ_PAGE_HTML); // PM-66

    // MCP 端點（Streamable HTTP）— 給 Claude.ai Connectors / IDE 直接連
    if (path === '/mcp' || path.startsWith('/mcp/')) {
      const handler = createMcpHandler(createMcpServer(env), { route: '/mcp' });
      return handler(request, env, ctx);
    }

    // PM-59：報告頁——Server 直接回完整 HTML（vanilla JS 讀 /api/reports/:id 渲染），
    // 放在 /api/reports/:id 之前匹配。
    if (request.method === 'GET' && path.startsWith('/report/')) {
      const reportId = path.split('/report/')[1];
      if (reportId && reportId.length > 10) return html(REPORT_PAGE_HTML);
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
      if (request.method === 'POST' && path === '/api/correct') {
        return await correctText(request, env);
      }
      if (request.method === 'POST' && path === '/api/auth/google') {
        return await googleAuth(request, env);
      }
      if (request.method === 'GET' && path === '/api/user/plan') {
        return await getUserPlan(request, env);
      }
      if (request.method === 'POST' && path === '/api/user/usage') {
        return await bumpUsage(request, env);
      }
      if (request.method === 'POST' && path === '/api/user/cancel') {
        return await ecpayCancel(request, env); // PM-73：取消訂閱
      }
      // PM-72：綠界 ECPay 付費
      if (request.method === 'GET' && path === '/checkout') {
        return await ecpayCheckout(url, env);
      }
      if (request.method === 'POST' && path === '/api/ecpay/callback') {
        return await ecpayCallback(request, env);
      }
      if (request.method === 'POST' && path === '/checkout/result') {
        return await ecpayResult(request);
      }
      if (request.method === 'POST' && path === '/api/ecpay/period-callback') {
        return await ecpayPeriodCallback(request, env);
      }
      if (request.method === 'POST' && path === '/api/reports') {
        return await createReport(request, env, url.origin);
      }
      if (request.method === 'GET' && path === '/api/reports') {
        return await listReports(url, env);
      }
      // PM-82：報告設定（允許 AI 讀截圖）— 有 share link 就能改，不需登入
      const settingsMatch = path.match(/^\/api\/reports\/([^/]+)\/settings$/);
      if (request.method === 'PATCH' && settingsMatch) {
        return await updateReportSettings(settingsMatch[1], request, env);
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

  // PM-79：Cron 保活 Supabase（免費版閒置 7 天會自動暫停 DB）。每天 ping 一次。
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const { count, error } = await supa(env)
        .from('users')
        .select('user_id', { count: 'exact', head: true });
      if (error) console.error('[Cron] Supabase keepalive failed:', error.message);
      else console.log(`[Cron] Supabase keepalive OK: ${count ?? 0} users`);
    } catch (err) {
      console.error('[Cron] Supabase keepalive failed:', err);
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

  // PM-61：只在有登入（payload.user_id）時才帶 user_id 欄，避免未跑 ALTER 時整批 insert 失敗
  const baseRow = payload.user_id ? { ...row, user_id: payload.user_id } : row;
  // PM-83：截圖上傳帶入 allow_screenshot_images（預設 false）。欄位若尚未建（PM-82 ALTER 未跑）
  // 會讓 insert 失敗 → 退回不含該欄位重試，確保上傳永不因此中斷。
  const allowImages = (payload as { allow_screenshot_images?: boolean }).allow_screenshot_images === true;
  const insertRow = allowImages ? { ...baseRow, allow_screenshot_images: true } : baseRow;
  let { error } = await supa(env).from('reports').insert(insertRow);
  if (error && allowImages && error.message.includes('allow_screenshot_images')) {
    ({ error } = await supa(env).from('reports').insert(baseRow));
  }
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
    allowScreenshotImages: data.allow_screenshot_images ?? false, // PM-82（select('*') → 欄位未建時為 undefined→false）
    rrwebEvents,
    screenshots,
    created_at: data.created_at,
  });
}

// PATCH /api/reports/:id/settings — 報告設定（PM-82：允許 AI 讀截圖）。不需登入（有 share link 即可改）。
async function updateReportSettings(
  reportId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { allow_screenshot_images?: boolean };
  if (typeof body.allow_screenshot_images !== 'boolean') {
    return json({ error: 'allow_screenshot_images (boolean) required' }, 400);
  }
  const { error } = await supa(env)
    .from('reports')
    .update({ allow_screenshot_images: body.allow_screenshot_images })
    .eq('report_id', reportId);
  if (error) return json({ error: `更新失敗: ${error.message}` }, 500);
  return json({ ok: true });
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

// POST /api/correct — 用 Workers AI 校正語音辨識的錯字/贅字/術語（PM-60，保留原意不摘要）
// PM-60c：依序實測 qwq-32b（輸出冗長推理、不可用）/ deepseek-r1-distill-qwen-32b（此帳號無此模型 5007）
//        / qwen3 / llama-3.3，以 UTF-8 驗證——qwen3 與 llama-3.3 都回乾淨正確中文（先前「亂碼」是
//        Windows Git-Bash 測試環境的編碼坑，非 server）。選 llama-3.3：非推理模型（無 <think> 額外開銷/
//        洩漏風險）、與 summarize 同款、4 樣本實測穩定。
async function correctText(request: Request, env: Env): Promise<Response> {
  const { text } = (await request.json().catch(() => ({}))) as { text?: string };
  if (!text?.trim()) {
    return json({ error: '沒有文字可校正' }, 400);
  }
  try {
    const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        {
          role: 'system',
          content: `你是繁體中文語音轉文字的校對專家。輸入一定是中文語音辨識的原始結果，可能有同音錯字與口語贅字。請只做「校正」，輸出校正後的中文文字。

規則：
1. 修正同音錯字（例：噴五白 → 噴 500、台破 → TypeError）
2. 移除口語贅字（呃、那個、就是說、然後然後、對對對）
3. 技術術語保持英文原文（console error、TypeError、404、undefined、null、fetch、API）
4. 數字和 HTTP 狀態碼用阿拉伯數字（五百 → 500、四零四 → 404）
5. 保留原始語意和描述順序，不改寫不摘要不增加內容
6. 適當加入標點符號，讓句子更好閱讀
7. 如果原文已經很正確，就原樣回傳
8. 不論輸入看起來多零亂，都一定要輸出校正後的中文文字；絕對不可回覆「無法辨識」「請提供正確文字」之類的話，也不可要求重新輸入。

範例：
輸入：我按下搜尋按鈕之後那個頁面就出現台破的錯誤然後狀態碼是四零四
輸出：我按下搜尋按鈕之後，頁面就出現 TypeError 的錯誤，狀態碼是 404。

只回傳校正後的文字，不加任何說明或前綴。`,
        },
        { role: 'user', content: `請校正以下語音辨識文字：\n${text}` },
      ],
      // Qwen3 是推理模型，會先輸出 <think> 推理再給答案，max_tokens 需給足以免答案被截斷
      max_tokens: 2048,
    });
    // 保險：若日後換回推理模型，<think>...</think> 一併移除（Llama 不會有，無害）
    let corrected = (result as { response?: string }).response ?? '';
    corrected = corrected.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || text;
    return json({ corrected });
  } catch (err) {
    return json({ error: `AI 校正失敗: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

// POST /api/auth/google — 驗 Google access token → 查/建 Supabase users → 回 session（PM-61）
// PM-61b：查 user 用 .maybeSingle()（找不到回 null 不拋）；最外層 try/catch 回實際錯誤方便除錯。
async function googleAuth(request: Request, env: Env): Promise<Response> {
  try {
    const { token } = (await request.json().catch(() => ({}))) as { token?: string };
    if (!token) return json({ error: 'missing token' }, 400);

    // 用 access token 取 Google userinfo（同時驗證 token 有效）
    const googleRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!googleRes.ok) return json({ error: 'invalid google token' }, 401);
    const gUser = (await googleRes.json()) as {
      id?: string;
      email?: string;
      name?: string;
      picture?: string;
    };
    if (!gUser.email) return json({ error: 'no email in google profile' }, 401);

    const supabase = supa(env);
    const { data: existing, error: selErr } = await supabase
      .from('users')
      .select('user_id, email, name, avatar_url')
      .eq('email', gUser.email)
      .maybeSingle(); // PM-61b：找不到回 null（不像 .single() 會拋 PGRST116）
    if (selErr) return json({ error: `查使用者失敗: ${selErr.message}` }, 500);

    let user = existing as
      | { user_id: string; email: string; name: string | null; avatar_url: string | null }
      | null;

    if (!user) {
      const { data: created, error } = await supabase
        .from('users')
        .insert({ email: gUser.email, name: gUser.name ?? '', avatar_url: gUser.picture ?? '' })
        .select('user_id, email, name, avatar_url')
        .single();
      if (error || !created) {
        return json({ error: `建立使用者失敗: ${error?.message ?? 'unknown'}` }, 500);
      }
      user = created;
    } else {
      await supabase
        .from('users')
        .update({
          last_login_at: new Date().toISOString(),
          name: gUser.name ?? user.name ?? '',
          avatar_url: gUser.picture ?? user.avatar_url ?? '',
        })
        .eq('user_id', user.user_id);
    }

    // MVP 簡易 session token（base64(user_id:ts)）；正式環境之後改 JWT（PM-61 §9）
    const session_token = btoa(`${user.user_id}:${Date.now()}`);
    return json({
      user_id: user.user_id,
      email: user.email,
      name: gUser.name ?? user.name ?? '',
      avatar_url: gUser.picture ?? user.avatar_url ?? '',
      session_token,
    });
  } catch (err) {
    return json({ error: `auth error: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

// GET /api/user/plan — 查方案 + 免費版剩餘用量（每月自動重置計數）（PM-63）
async function getUserPlan(request: Request, env: Env): Promise<Response> {
  const userId = getUserIdFromHeader(request);
  if (!userId) return json({ error: 'unauthorized' }, 401);
  try {
    const { data: user, error } = await supa(env)
      .from('users')
      .select('plan, recording_count, rewind_count, mcp_count, usage_reset_at, plan_expires_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return json({ error: `查方案失敗: ${error.message}` }, 500);
    if (!user) return json({ error: 'user not found' }, 404);

    const u = user as {
      plan: string | null;
      recording_count: number;
      rewind_count: number;
      mcp_count: number;
      usage_reset_at: string;
      plan_expires_at: string | null;
    };

    // 跨月自動重置計數
    const resetAt = new Date(u.usage_reset_at);
    const now = new Date();
    if (now.getMonth() !== resetAt.getMonth() || now.getFullYear() !== resetAt.getFullYear()) {
      await supa(env)
        .from('users')
        .update({ recording_count: 0, rewind_count: 0, mcp_count: 0, usage_reset_at: now.toISOString() })
        .eq('user_id', userId);
      u.recording_count = 0;
      u.rewind_count = 0;
      u.mcp_count = 0;
    }

    // PM-73：cancelled 用戶到期 → 自動降級 free
    if (u.plan === 'cancelled' && u.plan_expires_at && now > new Date(u.plan_expires_at)) {
      await supa(env).from('users').update({ plan: 'free' }).eq('user_id', userId);
      u.plan = 'free';
    }

    // PM-73：cancelled 在到期前仍視同付費（享無限功能）
    const isPaid = u.plan === 'paid' || u.plan === 'cancelled';
    return json({
      plan: u.plan ?? 'free',
      expires_at: u.plan_expires_at ?? null,
      limits: isPaid
        ? null
        : {
            recording: { used: u.recording_count, max: FREE_LIMITS.recording },
            rewind: { used: u.rewind_count, max: FREE_LIMITS.rewind },
            mcp: { used: u.mcp_count, max: FREE_LIMITS.mcp },
          },
    });
  } catch (err) {
    return json({ error: `plan error: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

// POST /api/user/usage — 遞增用量；免費版超限回 403 limit_reached（PM-63）
async function bumpUsage(request: Request, env: Env): Promise<Response> {
  const userId = getUserIdFromHeader(request);
  if (!userId) return json({ error: 'unauthorized' }, 401);
  try {
    const { type } = (await request.json().catch(() => ({}))) as { type?: UsageType };
    if (!type || !(type in FREE_LIMITS)) return json({ error: 'invalid type' }, 400);

    const { data: user, error } = await supa(env)
      .from('users')
      .select('plan, recording_count, rewind_count, mcp_count')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return json({ error: `查用量失敗: ${error.message}` }, 500);
    if (!user) return json({ error: 'user not found' }, 404);

    const u = user as {
      plan: string | null;
      recording_count: number;
      rewind_count: number;
      mcp_count: number;
    };
    // PM-73：cancelled 在到期前仍視同付費（無限）
    if (u.plan === 'paid' || u.plan === 'cancelled') return json({ ok: true, unlimited: true });

    const countField = `${type}_count` as 'recording_count' | 'rewind_count' | 'mcp_count';
    const currentCount = u[countField] || 0;
    const limit = FREE_LIMITS[type];
    if (currentCount >= limit) {
      const label = type === 'recording' ? '錄製' : type === 'rewind' ? '回溯' : 'MCP 查詢';
      return json(
        {
          error: 'limit_reached',
          message: `免費版每月限 ${limit} 次${label}，升級付費版解鎖無限次`,
          used: currentCount,
          max: limit,
        },
        403,
      );
    }

    await supa(env)
      .from('users')
      .update({ [countField]: currentCount + 1 })
      .eq('user_id', userId);
    return json({ ok: true, used: currentCount + 1, max: limit });
  } catch (err) {
    return json({ error: `usage error: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

// ── PM-72：綠界 ECPay 付費串接 ─────────────────────────────
// GET /checkout?user_id=xxx → 產生帶 CheckMacValue 的綠界表單並自動提交
async function ecpayCheckout(url: URL, env: Env): Promise<Response> {
  const userId = url.searchParams.get('user_id');
  if (!userId) return json({ error: 'missing user_id' }, 400);

  const now = new Date();
  const tradeNo = `BZ${now.getTime()}`.slice(0, 20); // 唯一訂單編號，最長 20 碼
  const params: Record<string, string> = {
    MerchantID: env.ECPAY_MERCHANT_ID,
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: formatEcpayDate(now),
    PaymentType: 'aio',
    TotalAmount: '80',
    TradeDesc: 'BugEzy Pro 月訂閱',
    ItemName: 'BugEzy Pro 付費版 NT$80/月',
    ReturnURL: `${url.origin}/api/ecpay/callback`, // server-to-server 通知
    OrderResultURL: `${url.origin}/checkout/result`, // 付款後瀏覽器導回
    ChoosePayment: 'Credit',
    EncryptType: '1',
    CustomField1: userId, // 用 CustomField 帶 user_id 回來
    // PM-72b：定期定額（月扣 NT$80 訂閱制）。PeriodAmount 必須等於 TotalAmount。
    PeriodAmount: '80', // 每期授權金額
    PeriodType: 'M', // 週期：M=月
    Frequency: '1', // 每 1 個月扣一次
    ExecTimes: '99', // 最多扣 99 次（最少 2，月 max 999）
    PeriodReturnURL: `${url.origin}/api/ecpay/period-callback`, // 第 2 次起的扣款結果通知
  };
  params.CheckMacValue = await generateCheckMacValue(
    params,
    env.ECPAY_HASH_KEY,
    env.ECPAY_HASH_IV,
  );

  const inputs = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeAttr(v)}">`)
    .join('');
  const formHtml =
    `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>前往綠界付款…</title>` +
    `<style>body{background:#0f0f1a;color:#e0e0e0;font-family:system-ui,"Microsoft JhengHei",sans-serif;` +
    `display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}</style></head>` +
    `<body><p>🔒 正在前往綠界安全付款頁面，請稍候…</p>` +
    `<form id="ecpay" method="POST" action="${env.ECPAY_PAYMENT_URL}">${inputs}</form>` +
    `<script>document.getElementById('ecpay').submit();</script></body></html>`;
  return html(formHtml);
}

// POST /api/ecpay/callback → 綠界 server-to-server 付款結果通知（驗 CheckMacValue → 更新 plan）
async function ecpayCallback(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const params: Record<string, string> = {};
  formData.forEach((val, key) => {
    params[key] = String(val);
  });

  const received = params.CheckMacValue ?? '';
  const expected = await generateCheckMacValue(params, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV);
  if (!timingSafeEqualStr(received, expected)) {
    return new Response('0|ErrorMessage=CheckMacValue Error', { status: 200 });
  }

  // 後台「付款結果通知(模擬)」：SimulatePaid=1，不更新狀態但仍要回 1|OK
  if (params.SimulatePaid === '1') {
    return new Response('1|OK', { status: 200 });
  }

  // 付款成功（RtnCode=1）→ 用 CustomField1 帶回的 user_id 升級為 paid
  // PM-73：同時記錄 ecpay_trade_no（取消訂閱要用）+ plan_expires_at（到期日）
  if (params.RtnCode === '1') {
    const userId = params.CustomField1;
    if (userId) {
      await supa(env)
        .from('users')
        .update({
          plan: 'paid',
          ecpay_trade_no: params.MerchantTradeNo,
          plan_expires_at: oneMonthLaterISO(),
        })
        .eq('user_id', userId);
    }
  }

  // 綠界要求成功時回傳 1|OK（否則會重送通知）
  return new Response('1|OK', { status: 200 });
}

// POST /checkout/result → 綠界付款後用 POST 導回，顯示結果頁
async function ecpayResult(request: Request): Promise<Response> {
  const formData = await request.formData();
  const rtnCode = String(formData.get('RtnCode') ?? '');
  const rtnMsg = String(formData.get('RtnMsg') ?? '');
  const success = rtnCode === '1';
  const body =
    `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>付款結果</title>` +
    `<style>body{background:#0f0f1a;color:#e0e0e0;font-family:system-ui,"Microsoft JhengHei",sans-serif;` +
    `display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}` +
    `.card{background:#1a1a2e;border:1px solid #2a2a3e;border-radius:16px;padding:40px;text-align:center;max-width:400px;}` +
    `.icon{font-size:48px;margin-bottom:16px;}h1{font-size:24px;margin:0 0 8px;}` +
    `p{color:#aaa;margin:0 0 24px;line-height:1.6;}a{color:#a78bfa;text-decoration:none;}</style></head>` +
    `<body><div class="card"><div class="icon">${success ? '🎉' : '❌'}</div>` +
    `<h1>${success ? '升級成功！' : '付款失敗'}</h1>` +
    `<p>${
      success
        ? '你已升級為 BugEzy Pro 付費版。重新開啟 BugEzy 即可享受無限功能！'
        : escapeAttr(rtnMsg || '請稍後再試')
    }</p>` +
    `<a href="/">← 回到首頁</a></div></body></html>`;
  return html(body);
}

// POST /api/ecpay/period-callback → 定期定額「第 2 期起」的每月扣款結果通知（PM-72b）
// 第 1 次授權走 /api/ecpay/callback；第 2 次起由綠界排程自動扣款，結果通知到這裡。
async function ecpayPeriodCallback(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const params: Record<string, string> = {};
  formData.forEach((val, key) => {
    params[key] = String(val);
  });

  const received = params.CheckMacValue ?? '';
  const expected = await generateCheckMacValue(params, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV);
  if (!timingSafeEqualStr(received, expected)) {
    return new Response('0|ErrorMessage=CheckMacValue Error', { status: 200 });
  }

  const userId = params.CustomField1;
  if (userId) {
    if (params.RtnCode === '1') {
      // 本期扣款成功 → 維持 paid + 展延到期日（PM-73），順手更新最近活躍時間
      await supa(env)
        .from('users')
        .update({
          plan: 'paid',
          plan_expires_at: oneMonthLaterISO(),
          last_login_at: new Date().toISOString(),
        })
        .eq('user_id', userId);
    } else {
      // 本期扣款失敗 → 降級為 free
      await supa(env).from('users').update({ plan: 'free' }).eq('user_id', userId);
    }
  }

  // 綠界要求每期通知後回 1|OK（否則視為未收到）
  return new Response('1|OK', { status: 200 });
}

// POST /api/user/cancel → 取消定期定額訂閱（PM-73）。標記 cancelled，到期前仍享付費功能。
async function ecpayCancel(request: Request, env: Env): Promise<Response> {
  const userId = getUserIdFromHeader(request);
  if (!userId) return json({ error: 'unauthorized' }, 401);
  try {
    const { data: user, error } = await supa(env)
      .from('users')
      .select('plan, ecpay_trade_no, plan_expires_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return json({ error: `查用戶失敗: ${error.message}` }, 500);
    const u = user as {
      plan?: string;
      ecpay_trade_no?: string | null;
      plan_expires_at?: string | null;
    } | null;
    if (!u || u.plan !== 'paid') return json({ error: '目前不是付費用戶' }, 400);

    // 呼叫綠界「定期定額作業」API 停止訂閱
    // ⚠ 官方端點是 /Cashier/CreditCardPeriodAction（非 /CreditDetail/DoAction，後者為一般信用卡交易作業），
    // 且需帶 TimeStamp。端點主機沿用 ECPAY_PAYMENT_URL 的 origin（stage/prod 自動一致）。
    if (u.ecpay_trade_no) {
      const actionParams: Record<string, string> = {
        MerchantID: env.ECPAY_MERCHANT_ID,
        MerchantTradeNo: u.ecpay_trade_no,
        Action: 'Cancel',
        TimeStamp: String(Math.floor(Date.now() / 1000)),
      };
      actionParams.CheckMacValue = await generateCheckMacValue(
        actionParams,
        env.ECPAY_HASH_KEY,
        env.ECPAY_HASH_IV,
      );
      const actionUrl = `${new URL(env.ECPAY_PAYMENT_URL).origin}/Cashier/CreditCardPeriodAction`;
      try {
        await fetch(actionUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(actionParams).toString(),
        });
      } catch (e) {
        // 綠界端取消失敗不阻擋本地標記（避免用戶卡住），記錄即可
        console.log('ECPay cancel action failed', e);
      }
    }

    // 標記 cancelled（已取消但未到期；用量檢查仍視同 paid，到期後由 /api/user/plan 自動降級 free）
    await supa(env).from('users').update({ plan: 'cancelled' }).eq('user_id', userId);

    const expires = u.plan_expires_at ?? null;
    const expiresText = expires ? expires.slice(0, 10).replace(/-/g, '/') : '本期結束';
    return json({
      ok: true,
      message: `已取消訂閱。付費功能可使用到 ${expiresText}`,
      expires_at: expires,
    });
  } catch (err) {
    return json({ error: `cancel error: ${err instanceof Error ? err.message : String(err)}` }, 500);
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

  // Tool 1: list_reports（PM-78：需 user_email 過濾，只回該使用者的報告）
  server.tool(
    'list_reports',
    '列出某使用者的 Bug 報告（需提供 user_email）。List a user\'s bug reports — requires user_email.',
    {
      user_email: z
        .string()
        .optional()
        .describe('使用者 email；只回傳該 email 的報告。未提供則不回任何報告（安全預設）。'),
      limit: z.number().min(1).max(50).optional(),
      url: z.string().optional(),
    },
    async (args) => {
      // PM-78：未提供 email → 不回報告（安全預設），回提示
      if (!args.user_email) {
        return txtWithTokens(
          {
            message:
              '請提供 user_email 參數以查詢你的報告。例如：list_reports(user_email: "you@example.com")',
          },
          'list_reports',
        );
      }
      // 以 email 查 user_id
      const { data: user, error: uErr } = await supabase()
        .from('users')
        .select('user_id')
        .eq('email', args.user_email)
        .maybeSingle();
      if (uErr) return txt(`查詢失敗: ${uErr.message}`);
      if (!user) return txtWithTokens([], 'list_reports'); // 查無此 email → 回空

      const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
      let query = supabase()
        .from('reports')
        .select(META_COLS)
        .eq('user_id', (user as { user_id: string }).user_id)
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

  // Tool 12（PM-57）: get_screenshots — 回傳報告截圖（base64），include_images 控制是否含圖片省 token
  server.tool(
    'get_screenshots',
    '取得報告的截圖圖片（視覺 Bug 用）。⚠ 圖片會消耗較多 token（每張 ~3,000-8,000），建議只在需要看畫面時使用。Report screenshots.',
    {
      report_id: z.string(),
      include_images: z
        .boolean()
        .optional()
        .describe('是否回傳圖片內容（預設 false，只回 metadata 省 token）'),
    },
    async ({ report_id, include_images }) => {
      // PM-82：讀報告設定 allow_screenshot_images；欄位若尚未建（ALTER 未跑）→ 退回不含新欄位的查詢
      let data:
        | { screenshots_r2_key?: string; screenshot_count?: number; allow_screenshot_images?: boolean }
        | null = null;
      const primary = await supabase()
        .from('reports')
        .select('screenshots_r2_key, screenshot_count, allow_screenshot_images')
        .eq('report_id', report_id)
        .single();
      if (primary.error) {
        const fb = await supabase()
          .from('reports')
          .select('screenshots_r2_key, screenshot_count')
          .eq('report_id', report_id)
          .single();
        data = fb.data;
      } else {
        data = primary.data;
      }

      if (!data || !data.screenshots_r2_key) {
        return txtWithTokens({ message: '此報告沒有截圖', screenshot_count: 0 }, 'get_screenshots', report_id);
      }

      // PM-82：兩層判斷——使用者在報告頁勾了 allow_screenshot_images，OR AI 明確帶 include_images:true
      const shouldIncludeImages = data.allow_screenshot_images === true || include_images === true;

      const obj = await env.R2.get(data.screenshots_r2_key as string);
      if (!obj) {
        return txtWithTokens(
          { message: '截圖資料已過期或不存在', screenshot_count: data.screenshot_count },
          'get_screenshots',
          report_id,
        );
      }

      const screenshots = JSON.parse(await obj.text()) as Array<{ dataUrl: string; annotation?: string }>;

      // 預設只回 metadata（省 token）；使用者在報告頁勾選 OR AI 帶 include_images:true 才回圖片
      if (!shouldIncludeImages) {
        return txtWithTokens(
          {
            screenshot_count: screenshots.length,
            message: `此報告有 ${screenshots.length} 張截圖。如需 AI 分析視覺問題，請加 include_images: true（每張約 3,000-8,000 tokens），或由使用者在報告頁勾選「允許 AI 讀取截圖圖片」。`,
          },
          'get_screenshots',
          report_id,
        );
      }

      // shouldIncludeImages = true：回傳圖片內容（text 標題 + image block）
      const content: Array<
        { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
      > = [];
      for (let i = 0; i < screenshots.length; i++) {
        const ss = screenshots[i];
        const base64 = ss.dataUrl.replace(/^data:image\/\w+;base64,/, '');
        const mimeMatch = ss.dataUrl.match(/^data:(image\/\w+);base64,/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
        content.push({
          type: 'text',
          text: `📸 截圖 ${i + 1}/${screenshots.length}${ss.annotation ? `\n📝 標注：${ss.annotation}` : ''}`,
        });
        content.push({ type: 'image', data: base64, mimeType });
      }

      // 圖片 token 用固定估算（每張 ~5000），對比 Chrome 看整頁 DOM 更貴（×8）
      const textPart = content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      const totalTokens = Math.ceil(textPart.length / 3.5) + screenshots.length * 5000;
      const chromeTokens = totalTokens * 8;
      const savedPercent = chromeTokens > 0 ? Math.round((1 - totalTokens / chromeTokens) * 100) : 0;
      const footer = `\n\n---\n📊 Token 估算：~${totalTokens.toLocaleString()} tokens ≈ $${((totalTokens * 8) / 1_000_000).toFixed(4)}（含 ${screenshots.length} 張圖片）\n💡 同場景 Claude in Chrome：~${chromeTokens.toLocaleString()} tokens ≈ $${((chromeTokens * 8) / 1_000_000).toFixed(4)}\n✅ BugEzy 為你省了 ${savedPercent}%`;
      content.push({ type: 'text', text: footer });

      await logMcpUsage(
        env,
        'get_screenshots',
        {
          bugezyTokens: totalTokens,
          chromeTokens,
          savedPercent,
          bugezyUSD: ((totalTokens * 8) / 1_000_000).toFixed(4),
          chromeUSD: ((chromeTokens * 8) / 1_000_000).toFixed(4),
        },
        report_id,
      );

      return { content };
    },
  );

  return server;
}
