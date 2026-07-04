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
  // PM-93：service_role key（繞過 RLS）。設定後 supaKey() 會優先用它，未設定則退回 anon key（安全部署，不破壞現況）。
  // 全 public table 開 RLS（deny all）前，必須先 `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`，否則 Worker 用 anon 會被鎖死。
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AI: Ai; // Cloudflare Workers AI binding（PM-25）
  // PM-72：綠界 ECPay（測試環境值放 wrangler.toml [vars]；正式上線改用 secret）
  ECPAY_MERCHANT_ID: string;
  ECPAY_HASH_KEY: string;
  ECPAY_HASH_IV: string;
  ECPAY_PAYMENT_URL: string;
  // PM-85：Groq Whisper 語音轉文字（用 `wrangler secret put GROQ_API_KEY` 設定，不寫明文）
  GROQ_API_KEY: string;
  // PM-133：Google OAuth client_id（公開資訊，非機密）。createSession 驗 token audience 用。
  GOOGLE_CLIENT_ID: string;
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

// ── CORS（PM-130：收緊，只允許自家域名 + chrome-extension）────────
const CORS_ALLOWED_ORIGINS = [
  'https://bugezy.dev',
  'https://bugezy-api.bugezy-api.workers.dev',
];

/** 依請求 Origin 動態決定 CORS 標頭：只放行自家域名 + 任意 chrome-extension://（擴充 ID 可能變）。
 *  不在白名單者回退 https://bugezy.dev（等同拒絕跨源讀取）。 */
function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const isAllowed =
    CORS_ALLOWED_ORIGINS.includes(origin) || origin.startsWith('chrome-extension://');
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'https://bugezy.dev',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** PM-130：對外統一的 500 錯誤訊息（原始錯誤只記 console.error，不外洩內部細節）。 */
const GENERIC_500 = '伺服器內部錯誤，請稍後再試';

// ── PM-131：POST body 大小上限（防灌爆 R2 / 濫用）───────────────
const MAX_POST_SIZE = 10 * 1024 * 1024; // 全域 POST 10MB（transcribe 除外，音訊較大另計 25MB）
const MAX_REPORT_SIZE = 5 * 1024 * 1024; // 單份報告 5MB

// CORS 由 fetch() 的統一出口注入（PM-130），故 json() 只需帶 Content-Type。
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** PM-132：私有（依 user 過濾）回應——加 `Cache-Control: no-store`，
 *  避免 Cloudflare 邊緣快取以 URL 為鍵把 A 使用者的資料跨服給 B（實測此端點會被快取）。 */
function jsonNoStore(data: unknown, status = 200): Response {
  const res = json(data, status);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/** PM-93：Supabase 連線 key — 優先 service_role（繞過 RLS），未設定則退回 anon（安全過渡）。
 *  全 table 開 RLS(deny all) 後，唯一能存取資料的途徑就是這把 service_role key。 */
function supaKey(env: Env): string {
  return env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
}

function supa(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, supaKey(env));
}

// ── PM-63：免費/付費用量限制 ────────────────────────────────
const FREE_LIMITS = {
  recording: 10, // 月 10 次錄製
  rewind: 5, // 月 5 次回溯
  mcp: 20, // 月 20 次 MCP
} as const;
type UsageType = keyof typeof FREE_LIMITS;

/** PM-128：驗證 session token（查 sessions 表，不可猜測）。過期自動刪除並回 null。 */
async function verifySession(request: Request, env: Env): Promise<string | null> {
  const auth = request.headers.get('Authorization');
  if (!auth) return null;
  const token = auth.replace('Bearer ', '').trim();
  if (!token || token.length < 10) return null;

  const { data } = await supa(env)
    .from('sessions')
    .select('user_id, expires_at')
    .eq('session_token', token)
    .maybeSingle();
  if (!data) return null;

  const row = data as { user_id: string; expires_at: string };
  if (new Date(row.expires_at) <= new Date()) {
    // 過期：刪除 session
    await supa(env).from('sessions').delete().eq('session_token', token);
    return null;
  }
  return row.user_id;
}

/** PM-133：統一取 user_id — 只認 DB session token（PM-128）。base64 fallback 已移除（P0-3）。 */
async function getAuthUserId(request: Request, env: Env): Promise<string | null> {
  return verifySession(request, env);
}

/** PM-133：驗證 Google access token — 確認 audience 是 BugEzy（防其他 App token 重放，P1-4），
 *  回 { sub, email }（sub = Google 唯一 ID，作為 user_id）或 null。 */
async function verifyGoogleToken(
  accessToken: string,
  env: Env,
): Promise<{ sub: string; email: string } | null> {
  try {
    // 1. tokeninfo 驗 audience（防其他 App 的 token 重放冒充）
    const tokenInfoRes = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
    );
    if (!tokenInfoRes.ok) return null;
    const tokenInfo = (await tokenInfoRes.json()) as { aud?: string; azp?: string };
    const aud = tokenInfo.aud || tokenInfo.azp || '';
    if (!env.GOOGLE_CLIENT_ID || aud !== env.GOOGLE_CLIENT_ID) {
      console.error('Google token audience mismatch');
      return null;
    }

    // 2. 取使用者資訊（id = Google sub = user_id）
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userInfoRes.ok) return null;
    const userInfo = (await userInfoRes.json()) as { id?: string; email?: string };
    if (!userInfo.id || !userInfo.email) return null;

    return { sub: userInfo.id, email: userInfo.email };
  } catch (e) {
    console.error('verifyGoogleToken failed:', e);
    return null;
  }
}

/** PM-133：POST /api/auth/session — 收 Google access token，server 驗 audience + 推導 user_id
 *  （絕不信任客戶端傳的 user_id，P0-2），發 DB session token。 */
async function createSession(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { google_token?: string; name?: string }
    | null;
  if (!body?.google_token) {
    return json({ error: 'missing google_token' }, 400);
  }

  // 關鍵：user_id 由 server 從已驗證的 Google token 推導，絕不信任客戶端
  const verified = await verifyGoogleToken(body.google_token, env);
  if (!verified) {
    return json({ error: 'Google token 驗證失敗' }, 401);
  }
  const userId = verified.sub;
  const email = verified.email;

  // user 不存在則建立
  const { data: user } = await supa(env)
    .from('users')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (!user) {
    await supa(env)
      .from('users')
      .insert({ user_id: userId, email, name: body.name || '', plan: 'free' });
  }

  // 產生不可猜測的 session token（雙 UUID）
  const sessionToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await supa(env)
    .from('sessions')
    .insert({
      session_token: sessionToken,
      user_id: userId,
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    });

  return json({ session_token: sessionToken, user_id: userId, email });
}

function html(body: string): Response {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ── PM-136：SEO — sitemap.xml + robots.txt（讓搜尋引擎收錄 bugezy.dev）──
function sitemapXml(): Response {
  const urls: Array<[string, string, string]> = [
    ['/', 'weekly', '1.0'],
    ['/install', 'monthly', '0.9'],
    ['/features', 'monthly', '0.8'],
    ['/changelog', 'weekly', '0.7'],
    ['/guide', 'monthly', '0.6'],
    ['/faq', 'monthly', '0.5'],
    ['/privacy', 'yearly', '0.3'],
  ];
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        ([loc, freq, pri]) =>
          `  <url><loc>https://bugezy.dev${loc}</loc><changefreq>${freq}</changefreq><priority>${pri}</priority></url>`,
      )
      .join('\n') +
    `\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}

function robotsTxt(): Response {
  const body =
    `User-agent: *\n` +
    `Allow: /\n` +
    `Disallow: /api/\n` +
    `Disallow: /mcp\n` +
    `Disallow: /report/\n\n` +
    `Sitemap: https://bugezy.dev/sitemap.xml\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
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

// PM-109：日票到期時間（付款成功起 24 小時）
function dayPassExpiryISO(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

// PM-109：是否為「有效付費用戶」——月費 paid、取消但未到期 cancelled（PM-73），或日票未到期 day_pass。
function isActiveUser(u: { plan?: string | null; day_pass_expires_at?: string | null }): boolean {
  if (u.plan === 'paid' || u.plan === 'cancelled') return true;
  if (u.plan === 'day_pass' && u.day_pass_expires_at) {
    return new Date(u.day_pass_expires_at) > new Date();
  }
  return false;
}

// ── PM-62：產品首頁（GET /）— 一頁式、深色主題、無 JS、RWD（綠界審核 + 客戶訪問用）──
const HOMEPAGE_HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BugEzy — 開發者 Bug 報告工具，AI 幫你修</title>
  <meta name="description" content="亞洲最平價的 MCP 語音除錯工具。錄製 Bug、AI 自動分析、一鍵報告。支援 Claude、Cursor、Windsurf 等 7 大 AI 工具。月費 NT$80 起。">
  <meta name="keywords" content="BugEzy, bug reporter, MCP, AI debugging, Chrome extension, 語音除錯, bug tracking">
  <meta property="og:title" content="BugEzy — AI 幫你修 Bug">
  <meta property="og:description" content="錄製 Bug、AI 自動分析、一鍵報告。亞洲最平價 MCP 語音除錯工具。">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://bugezy.dev">
  <meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
  <link rel="canonical" href="https://bugezy.dev">
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
    /* PM-108：定價卡按鈕引導安裝 */
    .pricing-hint { color:#9aa3b2; font-size:12px; margin-top:12px; margin-bottom:8px; }
    .free-btn { display:block; margin-top:18px; padding:10px; border-radius:10px; background:transparent; border:1px solid #2a2a3e; color:#c4b5fd; font-weight:600; font-size:14px; text-decoration:none; }
    .free-btn:hover { border-color:#7c3aed; }
    /* PM-110：日票第三欄（橘色，呼應工具列橘光脈衝）+ 方案 badge */
    .plan.day-pass { border-color:#f59e0b; }
    .plan .pname.day { color:#f59e0b; }
    .plan-badge { display:inline-block; background:#7c3aed; color:#fff; font-size:11px; padding:2px 10px; border-radius:10px; margin-bottom:8px; }
    .day-btn { display:block; margin-top:18px; padding:10px; border-radius:10px; background:#f59e0b; color:#000; font-weight:700; font-size:14px; text-decoration:none; }
    .day-btn:hover { background:#d97706; }
    /* PM-112：讓 AI 幫你安裝（一鍵複製提示詞） */
    .ai-install { max-width:720px; margin:48px auto; text-align:center; }
    .ai-install h2 { color:#fff; font-size:28px; margin-bottom:8px; }
    .ai-install-desc { color:#9aa3b2; font-size:15px; margin-bottom:24px; }
    .ai-install-box { background:#161b22; border:1px solid #7c3aed; border-radius:12px; padding:24px; text-align:left; position:relative; }
    .ai-install-box pre { color:#e6edf3; font-size:13px; font-family:'Consolas','Monaco',monospace; white-space:pre-wrap; word-break:break-word; line-height:1.6; margin:0 0 16px 0; }
    .copy-btn { background:#7c3aed; color:#fff; border:none; border-radius:10px; padding:12px 24px; font-size:16px; font-weight:600; cursor:pointer; width:100%; transition:background 0.2s; }
    .copy-btn:hover { background:#6d28d9; }
    .copy-feedback { color:#3fb950; font-size:14px; margin-top:8px; display:inline-block; }
    .ai-install-tools { color:#666; font-size:13px; margin-top:16px; }
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
        <span>Windsurf</span>
        <span>VS Code + Cline</span>
        <span>Google Antigravity</span>
        <span>Gemini CLI</span>
      </div>
      <p>一行 URL 連接，零安裝</p>
    </div>
  </section>

  <section class="wrap ai-install">
    <h2>🤖 讓 AI 幫你安裝 BugEzy</h2>
    <p class="ai-install-desc">不懂技術？沒關係。把下面這段複製貼給你的 AI，它會幫你搞定一切。</p>
    <div class="ai-install-box">
      <pre id="ai-install-prompt">請幫我安裝 BugEzy MCP 除錯工具，讓你可以直接讀取我的 Bug 報告來幫我修 Bug。

安裝步驟：
1. Chrome 擴充功能：https://chromewebstore.google.com/detail/bugezy/mpkakmmfllghcdaeicdlnpogneeanhmb
2. MCP 連線設定，在你的 MCP config 加入：
{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}

安裝完成後，我只要用 BugEzy 錄製 Bug，你就能透過 MCP 讀取我的報告（Console 錯誤、Network 問題、語音描述、截圖），直接幫我修。

詳細教學：https://bugezy.dev/install</pre>
      <button id="copy-ai-prompt" class="copy-btn">📋 一鍵複製，貼給你的 AI</button>
      <span id="copy-feedback" class="copy-feedback" style="display:none;">✅ 已複製！</span>
    </div>
    <p class="ai-install-tools">支援：Claude Desktop · Claude Code · Cursor · Windsurf · VS Code + Cline · Google Antigravity · Gemini CLI</p>
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
        <a class="free-btn" href="/install">免費安裝 →</a>
      </div>
      <div class="plan day-pass">
        <div class="plan-badge">⚡ 試試看</div>
        <div class="pname day">日票</div>
        <div class="price">NT$20<small> /24hr</small></div>
        <ul>
          <li>全功能無限</li>
          <li>錄製無限</li>
          <li>MCP AI 讀取無限</li>
          <li>Whisper 精準語音</li>
          <li>信用卡 / ATM / 超商</li>
        </ul>
        <p class="pricing-hint">24 小時內享所有付費功能</p>
        <a class="day-btn" href="/install">安裝後購買 →</a>
      </div>
      <div class="plan featured">
        <div class="plan-badge">✨ 最划算</div>
        <div class="pname">付費版</div>
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
        <p class="pricing-hint">安裝 Chrome 擴充後，在工具中一鍵升級付費</p>
        <a class="plan-cta" href="/install">安裝後即可升級 →</a>
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
    <div style="margin-top:8px;"><a href="/install">安裝指南</a> | <a href="/features">功能說明</a> | <a href="/guide">使用指南</a> | <a href="/faq">常見問題</a> | <a href="/privacy">隱私政策</a> | <a href="/changelog">更新日誌</a></div>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy · 亞洲平價 MCP 語音除錯工具</div>
  </footer>
  <script>
    document.getElementById('copy-ai-prompt')?.addEventListener('click', function () {
      var text = document.getElementById('ai-install-prompt')?.textContent || '';
      navigator.clipboard.writeText(text).then(function () {
        var fb = document.getElementById('copy-feedback');
        if (fb) { fb.style.display = 'inline-block'; setTimeout(function () { fb.style.display = 'none'; }, 2000); }
      });
    });
  </script>
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
<meta name="description" content="BugEzy 隱私政策：我們收集什麼資料、如何使用與保護。中英雙語說明。">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/privacy">
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
    <a href="/">首頁</a>
    <a href="/install">安裝指南</a>
    <a href="/features">功能說明</a>
    <a href="/guide">使用指南</a>
    <a href="/faq">FAQ</a>
    <a href="/changelog">更新日誌</a>
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
<meta name="description" content="BugEzy 使用指南：安裝登入、六種錄製模式、編輯上傳、讓 AI 透過 MCP 讀報告修 Bug。">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/guide">
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
  <div class="mcp-box" style="border-color:#2a2a3e;">詳細安裝流程 → <a href="/install">安裝指南</a>　·　完整功能說明 → <a href="/features">功能說明</a></div>

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
      <a href="/install">安裝指南</a>
      <a href="/features">功能說明</a>
      <a href="/faq">FAQ</a>
      <a href="/privacy">隱私政策</a>
      <a href="/changelog">更新日誌</a>
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
<meta name="description" content="BugEzy 常見問題：安裝、錄製、語音辨識、MCP 設定、付費方案等問答。">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/faq">
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

  <div class="faq-q">BugEzy 最大的優勢是什麼？</div>
  <div class="faq-a"><p>專為亞洲開發者設計：中文/粵語/日韓語音支援、NT$80 超平價月費、MCP 整合讓 AI 直接讀報告。獨家功能：即時監控、30 秒回溯、Whisper 精準語音、終端機 CLI、Token 透明度。</p></div>

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
      <a href="/install">安裝指南</a>
      <a href="/features">功能說明</a>
      <a href="/guide">使用指南</a>
      <a href="/privacy">隱私政策</a>
      <a href="/changelog">更新日誌</a>
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

// ── PM-96：安裝指南頁（GET /install）— 從零到能用的完整五步流程 + MCP 設定 ──
const INSTALL_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>安裝 BugEzy — 3 分鐘搞定 Chrome 擴充 + MCP 設定</title>
<meta name="description" content="安裝 BugEzy Chrome 擴充功能，設定 MCP 連線，讓 AI 直接讀取你的 Bug 報告。支援 Claude、Cursor、Windsurf、Google Antigravity、Gemini CLI。">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/install">
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
    margin: 28px 0 0; padding: 22px 24px; background: #1a1a2e;
    border: 1px solid #2a2a3e; border-radius: 14px;
  }
  .step h2 { font-size: 19px; color: #c4b5fd; margin: 0 0 12px; }
  .step ol, .step ul { margin: 0; padding-left: 22px; }
  .step li { margin: 6px 0; }
  .snum {
    display: inline-block; min-width: 26px; height: 26px; line-height: 26px; text-align: center;
    background: #7c3aed; color: #fff; border-radius: 50%; font-size: 14px; font-weight: 700; margin-right: 8px;
  }
  .cta-btn {
    display: inline-block; margin-top: 12px; padding: 10px 22px; border-radius: 10px;
    background: #7c3aed; color: #fff; text-decoration: none; font-weight: 600; font-size: 15px;
  }
  .note { margin-top: 10px; padding: 10px 12px; border-radius: 8px;
    background: rgba(124,58,237,0.12); border: 1px solid rgba(124,58,237,0.4); color: #c4b5fd; font-size: 13px; }
  .mcp-box {
    margin-top: 14px; padding: 14px 16px; background: #15152a;
    border: 1px solid #7c3aed; border-radius: 10px; font-size: 14px;
  }
  .mcp-box code {
    display: inline-block; margin-top: 4px; padding: 4px 8px; border-radius: 6px;
    background: #0f0f1a; color: #7ee0c5; font-family: ui-monospace, monospace; word-break: break-all;
  }
  .mcp-warn { margin-top: 10px; padding: 10px 12px; border-radius: 8px;
    background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.45); color: #fcd34d; font-size: 13px; }
  .mcp-tool { margin-top: 12px; }
  .mcp-tool .tname { font-weight: 700; color: #c4b5fd; font-size: 13px; }
  .mcp-tool .tstep { color: #ccc; font-size: 13px; margin-top: 2px; }
  .mcp-box pre { margin: 6px 0 0; padding: 10px 12px; background: #0f0f1a; border-radius: 6px;
    color: #7ee0c5; font-family: ui-monospace, monospace; font-size: 12px; overflow-x: auto; white-space: pre; }
  .toolgrid { margin-top: 10px; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px 16px; }
  .toolgrid div { font-size: 13px; color: #ccc; }
  .toolgrid b { color: #7ee0c5; font-family: ui-monospace, monospace; }
  a { color: #a78bfa; }
  .bottom-cta { margin-top: 36px; text-align: center; }
  footer {
    margin-top: 48px; padding-top: 20px; border-top: 1px solid #2a2a3e;
    color: #8b8fa3; font-size: 13px;
  }
  footer .links a { margin-right: 16px; }
  /* PM-112：最快安裝——複製貼給 AI */
  .ai-install-box { background:#161b22; border:1px solid #7c3aed; border-radius:12px; padding:20px; text-align:left; margin:16px 0 8px; }
  .ai-install-box pre { color:#e6edf3; font-size:13px; font-family:'Consolas','Monaco',monospace; white-space:pre-wrap; word-break:break-word; line-height:1.6; margin:0 0 14px 0; }
  .copy-btn { background:#7c3aed; color:#fff; border:none; border-radius:10px; padding:12px 24px; font-size:15px; font-weight:600; cursor:pointer; width:100%; }
  .copy-btn:hover { background:#6d28d9; }
  .copy-feedback { color:#3fb950; font-size:14px; margin-top:8px; display:inline-block; }
  .ai-install-tools { color:#8b8fa3; font-size:13px; margin-top:8px; }
  @media (max-width: 640px) { .wrap { padding: 32px 16px 60px; } h1 { font-size: 24px; } }
</style>
</head>
<body>
<div class="wrap">
  <header><a class="brand" href="/">🐛 BugEzy</a></header>

  <h1>🚀 安裝 BugEzy — 三分鐘搞定</h1>
  <p class="lead">從零到能用，跟著五步走，馬上讓 AI 幫你修 Bug。</p>

  <div class="step" style="border-color:#7c3aed;">
    <h2>🤖 最快的安裝方式：複製貼給 AI</h2>
    <p style="color:#8b8fa3;margin:0 0 4px;">不懂技術？把下面這段複製貼給你的 AI（Claude Desktop / Claude Code / Cursor / Windsurf / VS Code + Cline / Google Antigravity / Gemini CLI），它會幫你搞定。</p>
    <div class="ai-install-box">
      <pre id="ai-install-prompt">請幫我安裝 BugEzy MCP 除錯工具，讓你可以直接讀取我的 Bug 報告來幫我修 Bug。

安裝步驟：
1. Chrome 擴充功能：https://chromewebstore.google.com/detail/bugezy/mpkakmmfllghcdaeicdlnpogneeanhmb
2. MCP 連線設定，在你的 MCP config 加入：
{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}

安裝完成後，我只要用 BugEzy 錄製 Bug，你就能透過 MCP 讀取我的報告（Console 錯誤、Network 問題、語音描述、截圖），直接幫我修。

詳細教學：https://bugezy.dev/install</pre>
      <button id="copy-ai-prompt" class="copy-btn">📋 一鍵複製，貼給你的 AI</button>
      <span id="copy-feedback" class="copy-feedback" style="display:none;">✅ 已複製！</span>
    </div>
    <p class="ai-install-tools">或依下方手動五步安裝 ↓</p>
  </div>

  <div class="step">
    <h2><span class="snum">1</span>安裝擴充功能</h2>
    <ol>
      <li>前往 Chrome Web Store 的 BugEzy 頁面</li>
      <li>點「加到 Chrome」→ 在彈窗按「新增擴充功能」確認</li>
    </ol>
    <a class="cta-btn" href="https://chromewebstore.google.com/" target="_blank" rel="noopener">前往 Chrome Web Store →</a>
    <div class="note">支援 Chrome 以及所有 Chromium 核心瀏覽器（Edge、Brave、Arc 等）。</div>
  </div>

  <div class="step">
    <h2><span class="snum">2</span>固定到工具列</h2>
    <ol>
      <li>點瀏覽器右上角的拼圖圖示 🧩（擴充功能選單）</li>
      <li>找到 BugEzy 🐛 → 按旁邊的釘選 📌</li>
    </ol>
    <div class="note">釘選後圖示會常駐在工具列，隨時一鍵開錄，不用每次翻選單。</div>
  </div>

  <div class="step">
    <h2><span class="snum">3</span>登入</h2>
    <ol>
      <li>點工具列上的 BugEzy 圖示 🐛</li>
      <li>按「用 Google 登入」→ 選擇帳號授權</li>
      <li>popup 顯示你的名字 = 登入成功</li>
    </ol>
  </div>

  <div class="step">
    <h2><span class="snum">4</span>第一次錄製</h2>
    <ol>
      <li>開任意網頁 → 點 BugEzy 圖示 → 按「錄製」</li>
      <li>操作重現問題，同時用語音描述你看到的 Bug</li>
      <li>按「停止」→ 自動打開報告編輯頁</li>
    </ol>
    <div class="note">🎉 恭喜，你的第一份 Bug 報告完成了！可以編輯文字、AI 校正精簡後上傳。</div>
  </div>

  <div class="step">
    <h2><span class="snum">5</span>連接 AI（MCP 設定）</h2>
    <p style="margin:0 0 4px;color:#c4b5fd;font-weight:600;">讓 AI 直接讀你的 Bug 報告，不用複製貼上。</p>
    <p style="margin:0;">支援 Claude Desktop · Claude Code · Cursor · Windsurf · VS Code + Cline · Google Antigravity · Gemini CLI 等所有 MCP 工具。</p>
    <div class="mcp-box">
      <b>🔌 BugEzy MCP 網址（所有工具通用）</b><br />
      <code>https://bugezy.dev/mcp</code>
      <div class="mcp-warn">⚠ 這個網址<b>不能用瀏覽器開</b>，它是給 AI 工具連接的協議。用瀏覽器開只會看到錯誤訊息，屬正常現象——請依下方步驟在 AI 工具裡設定。</div>

      <div class="mcp-tool"><div class="tname">Claude.ai</div><div class="tstep">Settings → Connectors → Add → 貼上網址 → 連接</div></div>
      <div class="mcp-tool"><div class="tname">Claude Desktop / Cursor / Windsurf</div><div class="tstep">編輯設定檔（claude_desktop_config.json / mcp.json），加入：</div><pre>{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}</pre></div>
      <div class="mcp-tool"><div class="tname">VS Code + Cline</div><div class="tstep">Cline → MCP Servers → Add → 貼上網址</div></div>
      <div class="mcp-tool"><div class="tname">Claude Code（終端機）</div><div class="tstep"><code>claude mcp add --transport http bugezy https://bugezy.dev/mcp</code></div></div>
      <div class="mcp-tool"><div class="tname">Google Antigravity / Gemini CLI</div><div class="tstep">在 MCP 設定加入（協定通用，格式同上）：</div><pre>{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}</pre></div>

      <div style="margin-top:14px;color:#ccc;font-size:13px;">連接成功後直接問：<b style="color:#a78bfa;">「讀我最新的 BugEzy 報告，告訴我怎麼修」</b></div>

      <div style="margin-top:14px;"><b style="color:#c4b5fd;font-size:13px;">12 個 MCP 工具（AI 按需查詢，省 Token）：</b>
        <div class="toolgrid">
          <div><b>list_reports</b> 最近報告清單</div>
          <div><b>get_report_overview</b> 報告摘要</div>
          <div><b>get_console_logs</b> Console 錯誤</div>
          <div><b>get_network_errors</b> 網路錯誤</div>
          <div><b>get_voice_transcript</b> 語音全文</div>
          <div><b>get_screenshots</b> 截圖</div>
          <div><b>get_page_info</b> 頁面資訊</div>
          <div><b>get_rrweb_summary</b> DOM 軌跡摘要</div>
          <div><b>get_rrweb_events</b> DOM 事件細節</div>
          <div><b>get_live_errors</b> 即時監控錯誤</div>
          <div><b>get_terminal_logs</b> CLI 終端機日誌</div>
          <div><b>get_usage_stats</b> Token 用量統計</div>
        </div>
      </div>
    </div>
  </div>

  <div class="bottom-cta">
    <a class="cta-btn" href="/features">來看看有哪些功能 →</a>
  </div>

  <footer>
    <div class="links">
      <a href="/">首頁</a>
      <a href="/install">安裝指南</a>
      <a href="/features">功能說明</a>
      <a href="/guide">使用指南</a>
      <a href="/faq">FAQ</a>
      <a href="/privacy">隱私政策</a>
      <a href="/changelog">更新日誌</a>
    </div>
    <div style="margin-top:8px;">聯絡：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></div>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy</div>
  </footer>
</div>
<script>
  document.getElementById('copy-ai-prompt')?.addEventListener('click', function () {
    var text = document.getElementById('ai-install-prompt')?.textContent || '';
    navigator.clipboard.writeText(text).then(function () {
      var fb = document.getElementById('copy-feedback');
      if (fb) { fb.style.display = 'inline-block'; setTimeout(function () { fb.style.display = 'none'; }, 2000); }
    });
  });
</script>
</body>
</html>`;

// ── PM-96：功能說明頁（GET /features）— 六種模式 + 語音 + 高畫質 AI 的操作說明 ──
const FEATURES_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BugEzy 功能 — 六種錄製模式、Whisper 語音、即時監控</title>
<meta name="description" content="BugEzy 六種除錯模式：錄製、回溯 30 秒、截圖標注、即時監控、終端機 CLI、MCP AI 讀取。Whisper 精準語音轉錄。">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/features">
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
  .feat {
    margin: 24px 0 0; padding: 22px 24px; background: #1a1a2e;
    border: 1px solid #2a2a3e; border-radius: 14px;
  }
  .feat.paid { border-color: #7c3aed; }
  .feat h2 { font-size: 19px; color: #fff; margin: 0 0 10px; }
  .tag { display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 700; vertical-align: middle; }
  .tag.free { background: rgba(63,185,80,0.15); color: #3fb950; border: 1px solid rgba(63,185,80,0.4); }
  .tag.pro { background: rgba(124,58,237,0.18); color: #a78bfa; border: 1px solid rgba(124,58,237,0.5); }
  .feat .row { font-size: 14px; color: #ccc; margin: 5px 0; }
  .feat .row b { color: #a78bfa; font-weight: 600; }
  .feat code { padding: 2px 7px; border-radius: 6px; background: #0f0f1a; color: #7ee0c5;
    font-family: ui-monospace, monospace; font-size: 13px; }
  a { color: #a78bfa; }
  .cta-btn {
    display: inline-block; margin: 6px 8px 0 0; padding: 10px 22px; border-radius: 10px;
    background: #7c3aed; color: #fff; text-decoration: none; font-weight: 600; font-size: 15px;
  }
  .cta-btn.ghost { background: transparent; border: 1px solid #7c3aed; color: #a78bfa; }
  .bottom-cta { margin-top: 36px; text-align: center; }
  footer {
    margin-top: 48px; padding-top: 20px; border-top: 1px solid #2a2a3e;
    color: #8b8fa3; font-size: 13px;
  }
  footer .links a { margin-right: 16px; }
  @media (max-width: 640px) { .wrap { padding: 32px 16px 60px; } h1 { font-size: 24px; } }
</style>
</head>
<body>
<div class="wrap">
  <header><a class="brand" href="/">🐛 BugEzy</a></header>

  <h1>🎯 BugEzy 功能總覽</h1>
  <p class="lead">六種抓 Bug 模式 + 語音設定 + 高畫質 AI 分析，挑最順手的用。</p>

  <div class="feat">
    <h2>🎬 錄製</h2>
    <div class="row"><b>適合：</b>完整重現 Bug</div>
    <div class="row"><b>操作：</b>按「錄製」→ 操作重現 → 語音描述 → 按「停止」</div>
    <div class="row"><b>AI 收到：</b>DOM 軌跡 + Console + Network + 語音</div>
    <div class="row"><b>小提示：</b>底部字幕條會即時顯示，確認語音有在收音</div>
  </div>

  <div class="feat">
    <h2>⏪ 30 秒回溯</h2>
    <div class="row"><b>適合：</b>Bug 已經發生，來不及按錄製</div>
    <div class="row"><b>操作：</b>按「回溯 30s」→ 自動抓回最近 30 秒</div>
    <div class="row"><b>AI 收到：</b>最近 30 秒的 DOM + Console + Network</div>
    <div class="row"><b>小提示：</b>BugEzy 在背景持續記錄，不用提前按</div>
  </div>

  <div class="feat">
    <h2>📸 截圖標注</h2>
    <div class="row"><b>適合：</b>快速指出畫面上的問題</div>
    <div class="row"><b>操作：</b>截圖 → 選模式（整頁／可見範圍／自選區域）→ 畫筆箭頭標注 → 上傳</div>
    <div class="row"><b>AI 收到：</b>截圖 metadata（勾「高畫質 AI 分析」才讓 AI 直接看圖）</div>
    <div class="row"><b>小提示：</b>純視覺 Bug 建議開高畫質分析</div>
  </div>

  <div class="feat">
    <h2>⌨️ 鍵盤模式</h2>
    <div class="row"><b>適合：</b>吵雜環境（咖啡廳、辦公室）</div>
    <div class="row"><b>操作：</b>開啟鍵盤模式 → 關閉語音辨識 → 用打字描述 Bug</div>
    <div class="row"><b>小提示：</b>專注打字、不收音，適合不方便說話時</div>
  </div>

  <div class="feat">
    <h2>👁️ 即時監控</h2>
    <div class="row"><b>適合：</b>掛著等偶發 Bug 自己出現</div>
    <div class="row"><b>操作：</b>開啟即時監控 → 背景自動攔截 Console error / Network error</div>
    <div class="row"><b>小提示：</b>適合難重現、偶發性的問題，可以掛一整天</div>
  </div>

  <div class="feat">
    <h2>💻 終端機 CLI</h2>
    <div class="row"><b>適合：</b>後端開發（Node.js、Python 等）</div>
    <div class="row"><b>操作：</b><code>npx bugezy-watch -- node server.js</code></div>
    <div class="row"><b>小提示：</b>不需開瀏覽器，自動攔截 stderr / throw / crash</div>
  </div>

  <div class="feat paid">
    <h2>🎙️ 語音設定<span class="tag pro">付費</span></h2>
    <div class="row"><b>即時字幕（免費）：</b>Web Speech 頁面內即時轉字幕，零成本</div>
    <div class="row"><b>精準轉錄（付費）：</b>Groq Whisper 高準確度轉錄，適合專有名詞多的描述</div>
    <div class="row"><b>操作：</b>popup 開麥克風 toggle → 付費版可切「即時字幕／精準轉錄」</div>
    <div class="row"><b>小提示：</b>首次使用會請你授權麥克風，該網站只需授權一次</div>
  </div>

  <div class="feat paid">
    <h2>📸 高畫質 AI 分析<span class="tag pro">高 Token</span></h2>
    <div class="row"><b>適合：</b>版面跑版、樣式錯亂等純視覺 Bug</div>
    <div class="row"><b>操作：</b>在 popup 或報告頁勾選「高畫質 AI 分析」</div>
    <div class="row"><b>AI 收到：</b>勾選後 AI 會直接讀截圖圖片（否則只給 metadata 省 Token）</div>
    <div class="row"><b>小提示：</b>看圖較耗 Token，非視覺 Bug 建議關閉</div>
  </div>

  <div class="bottom-cta">
    <a class="cta-btn" href="/install">還沒安裝？前往安裝指南 →</a>
    <a class="cta-btn ghost" href="/">回首頁</a>
  </div>

  <footer>
    <div class="links">
      <a href="/">首頁</a>
      <a href="/install">安裝指南</a>
      <a href="/features">功能說明</a>
      <a href="/guide">使用指南</a>
      <a href="/faq">FAQ</a>
      <a href="/privacy">隱私政策</a>
      <a href="/changelog">更新日誌</a>
    </div>
    <div style="margin-top:8px;">聯絡：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></div>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy</div>
  </footer>
</div>
</body>
</html>`;

// ── PM-126：更新日誌頁（GET /changelog）——深色主題與其他頁一致 ──
const CHANGELOG_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>更新日誌 · BugEzy</title>
<meta name="description" content="BugEzy 每次更新做了什麼，都記在這裡。">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/changelog">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; background: #0f0f1a; color: #e8e8f0;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", sans-serif; line-height: 1.75; font-size: 15px; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; }
  header { border-bottom: 1px solid #2a2a3e; padding-bottom: 20px; margin-bottom: 28px; }
  .brand { font-size: 24px; font-weight: 700; color: #a78bfa; text-decoration: none; }
  h1 { font-size: 28px; margin: 18px 0 6px; }
  .lead { color: #8b8fa3; font-size: 15px; }
  .changelog-entry { margin: 28px 0 0; padding: 22px 24px; background: #1a1a2e; border: 1px solid #2a2a3e; border-radius: 14px; }
  .changelog-entry h3 { font-size: 19px; color: #c4b5fd; margin: 0 0 12px; }
  .changelog-entry ul { margin: 0; padding-left: 22px; }
  .changelog-entry li { margin: 6px 0; color: #ccc; }
  a { color: #a78bfa; }
  footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid #2a2a3e; color: #8b8fa3; font-size: 13px; }
  footer .links a { margin-right: 16px; }
  @media (max-width: 640px) { .wrap { padding: 32px 16px 60px; } h1 { font-size: 24px; } }
</style>
</head>
<body>
<div class="wrap">
  <header><a class="brand" href="/">🐛 BugEzy</a></header>

  <h1>📋 BugEzy 更新日誌</h1>
  <p class="lead">每次更新做了什麼，都記在這裡。</p>

  <section class="changelog-entry">
    <h3>v1.1.0 — 2026-07-02</h3>
    <ul>
      <li>🎙️ Whisper 精準語音轉錄（付費版）</li>
      <li>⚡ 日票 NT$20/24hr 上線</li>
      <li>💬 AI 指令輪盤（一鍵複製慣用語）</li>
      <li>📸 高畫質 AI 分析勾選</li>
      <li>🟢 即時監控狀態條 + 上傳報告</li>
      <li>⚙️ 進階設定折疊</li>
      <li>🔒 Supabase RLS 安全強化</li>
    </ul>
  </section>

  <section class="changelog-entry">
    <h3>v1.0.0 — 2026-06-29</h3>
    <ul>
      <li>🎉 首次上架 Chrome Web Store</li>
      <li>🎬 六種錄製模式</li>
      <li>🤖 12 個 MCP 工具 + Token 透明度</li>
      <li>💳 ECPay 付費整合</li>
    </ul>
  </section>

  <footer>
    <div class="links">
      <a href="/">首頁</a>
      <a href="/install">安裝指南</a>
      <a href="/features">功能說明</a>
      <a href="/guide">使用指南</a>
      <a href="/faq">FAQ</a>
      <a href="/privacy">隱私政策</a>
      <a href="/changelog">更新日誌</a>
    </div>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy</div>
  </footer>
</div>
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
    /* PM-82/84：高畫質 AI 分析（高 Token）勾選 */
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
          if (src) html += '<img class="ss-img" src="'+src+'" onclick="openLightbox(this.src)" style="cursor:zoom-in;">';
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
      tokenHtml += '<div class="token-row total"><span>AI 讀取總計</span><span>~'+totalT.toLocaleString()+' tokens ≈ USD $'+((totalT*8/1e6).toFixed(4))+'</span></div>';
      html += '<div class="token-panel"><div style="font-weight:600;margin-bottom:8px;color:#a78bfa;">📊 Token 估算</div>' + tokenHtml;
      html += '<div class="token-save">💡 同場景 Claude in Chrome：~'+chromeT.toLocaleString()+' tokens ≈ USD $'+((chromeT*8/1e6).toFixed(4))+'<br>✅ BugEzy 為你省了 '+pct+'%</div></div>';

      document.getElementById('app').innerHTML = html;

      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
          btn.classList.add('active');
          document.getElementById('tab-' + btn.dataset.tab)?.classList.add('active');
        });
      });

      // PM-82/84：高畫質 AI 分析（高 Token）— 勾選即時更新提示 + PATCH 存回 Supabase
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
  <!-- PM-99：截圖點擊頁內 lightbox（base64 data URL 無法 window.open，會開空白頁；改頁內放大）-->
  <div id="bugezy-lightbox" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.85);cursor:zoom-out;align-items:center;justify-content:center;" onclick="closeLightbox()">
    <img id="bugezy-lightbox-img" style="max-width:95vw;max-height:95vh;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,0.5);" />
  </div>
  <script>
    function openLightbox(src) {
      var lb = document.getElementById('bugezy-lightbox');
      document.getElementById('bugezy-lightbox-img').src = src;
      lb.style.display = 'flex';
    }
    function closeLightbox() {
      document.getElementById('bugezy-lightbox').style.display = 'none';
    }
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeLightbox();
    });
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
    const cors = getCorsHeaders(request); // PM-130：動態 CORS（只放行自家域名 + chrome-extension）
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // MCP 端點（Streamable HTTP）— 給 Claude.ai Connectors / IDE 直接連。
    // PM-130：不套自訂 CORS（交給 handler 自理，避免破壞 Claude.ai 連線）。
    if (path === '/mcp' || path.startsWith('/mcp/')) {
      const handler = createMcpHandler(createMcpServer(env), { route: '/mcp' });
      return handler(request, env, ctx);
    }

    // PM-130：所有一般回應統一在此出口套上動態 CORS（覆蓋預設）
    const response = await (async (): Promise<Response> => {
    // PM-131：全域 POST body 上限 10MB（transcribe 音訊另計 25MB，故排除）。
    // 依 Content-Length 先擋（省下讀 body 的成本）。
    if (request.method === 'POST' && path !== '/api/transcribe') {
      const cl = parseInt(request.headers.get('Content-Length') || '0', 10);
      if (cl > MAX_POST_SIZE) return json({ error: '請求過大' }, 413);
    }
    // PM-62：產品首頁（根目錄）— 放在所有路由之前
    if (request.method === 'GET' && path === '/') return html(HOMEPAGE_HTML);
    if (request.method === 'GET' && path === '/privacy') return html(PRIVACY_PAGE_HTML); // PM-64
    if (request.method === 'GET' && path === '/guide') return html(GUIDE_PAGE_HTML); // PM-66
    if (request.method === 'GET' && path === '/faq') return html(FAQ_PAGE_HTML); // PM-66
    if (request.method === 'GET' && path === '/install') return html(INSTALL_PAGE_HTML); // PM-96
    if (request.method === 'GET' && path === '/features') return html(FEATURES_PAGE_HTML); // PM-96
    // PM-126：版本檢查（popup 亮燈用）+ 更新日誌頁
    if (request.method === 'GET' && path === '/api/version') {
      // 每次上新版到 Chrome Web Store 時，同步改 latest + deploy
      return json({ latest: '1.1.0', changelog_url: 'https://bugezy.dev/changelog' });
    }
    if (request.method === 'GET' && path === '/changelog') return html(CHANGELOG_PAGE_HTML); // PM-126
    // PM-136：SEO — sitemap + robots（讓 Google/Bing 收錄 bugezy.dev）
    if (request.method === 'GET' && path === '/sitemap.xml') return sitemapXml();
    if (request.method === 'GET' && path === '/robots.txt') return robotsTxt();

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
        headers: { 'Content-Type': 'application/json' },
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
      if (request.method === 'POST' && path === '/api/transcribe') {
        return await handleTranscribe(request, env); // PM-85：Groq Whisper 語音轉文字
      }
      // PM-133：登入唯一入口——收 Google access token，server 驗 audience + 推導 user_id → 發 DB token。
      // 舊 /api/auth/google（發假 base64 token）已移除（P0-2/P0-3）。
      if (request.method === 'POST' && path === '/api/auth/session') {
        return await createSession(request, env);
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
      // PM-72：綠界 ECPay 付費 — 只走 POST + session token（PM-133：過渡 GET /checkout?user_id 已移除，P0-2）
      if (request.method === 'POST' && path === '/checkout') {
        const userId = await getAuthUserId(request, env);
        if (!userId) return json({ error: '請先登入' }, 401);
        return await ecpayCheckout(userId, url.origin, env);
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
      // PM-109：日票 NT$20（一次性付款）
      if (request.method === 'POST' && path === '/api/day-pass/create') {
        return await handleDayPassCreate(request, env);
      }
      if (request.method === 'POST' && path === '/api/day-pass/callback') {
        return await handleDayPassCallback(request, env);
      }
      if (request.method === 'GET' && path === '/day-pass-success') {
        return dayPassSuccessPage();
      }
      if (request.method === 'POST' && path === '/api/reports') {
        return await createReport(request, env, url.origin);
      }
      if (request.method === 'GET' && path === '/api/reports') {
        return await listReports(request, env);
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
        console.error('[fetch] unhandled error:', err); // PM-130：原始錯誤只記 log，不外洩
        return json({ error: GENERIC_500 }, 500);
      }
    })();

    // PM-130：統一出口注入動態 CORS（覆蓋 json()/html() 預設）
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
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
  // PM-131：報告單份上限 5MB（防灌爆 R2）。依 Content-Length 先擋，省下讀 body 成本。
  const cl = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (cl > MAX_REPORT_SIZE) {
    return json({ error: '報告大小超過 5MB 上限' }, 413);
  }

  const payload = (await request.json().catch(() => null)) as RecordingPayload | null;
  if (!payload || !payload.pageInfo) {
    return json({ error: 'invalid payload：缺少 pageInfo' }, 400);
  }

  // PM-98 防呆：報告 owner 綁定用 user_id。若上傳端（早期截圖流程）漏帶 payload.user_id，
  // 退而從 Authorization: Bearer <session_token> 補回，避免報告變孤兒（list_reports 依 user_id 過濾查不到）。
  if (!payload.user_id) {
    const headerUserId = await getAuthUserId(request, env);
    if (headerUserId) payload.user_id = headerUserId;
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
    console.error('supabase insert failed:', error.message);
    return json({ error: GENERIC_500 }, 500);
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
  if (error) {
    console.error('更新報告設定失敗:', error.message);
    return json({ error: GENERIC_500 }, 500);
  }
  return json({ ok: true });
}

// GET /api/reports — 列出「自己的」最近報告（metadata only，不含 rrweb / JSONB 大欄位）
// PM-132（P0-1）：加認證 + user 過濾。原本無認證無過濾，匿名者可列舉全站報告 ID → 隱私外洩。
async function listReports(request: Request, env: Env): Promise<Response> {
  const userId = await getAuthUserId(request, env);
  if (!userId) return jsonNoStore({ error: '請先登入' }, 401);

  const url = new URL(request.url);
  let limit = parseInt(url.searchParams.get('limit') ?? '10', 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  if (limit > 50) limit = 50;

  let query = supa(env)
    .from('reports')
    .select(
      'report_id, url, title, browser, screen_size, console_count, network_count, voice_count, rrweb_count, screenshot_count, created_at',
    )
    .eq('user_id', userId) // ← 關鍵：只回自己的報告
    .order('created_at', { ascending: false })
    .limit(limit);

  const keyword = url.searchParams.get('url');
  if (keyword) query = query.ilike('url', `%${keyword}%`);

  const { data, error } = await query;
  if (error) {
    console.error('supabase query failed:', error.message);
    return jsonNoStore({ error: GENERIC_500 }, 500);
  }
  return jsonNoStore({ reports: data ?? [] });
}

// POST /api/summarize — 用 Workers AI 把語音記錄精簡成重點（PM-25）
async function summarizeText(request: Request, env: Env): Promise<Response> {
  // PM-135：需登入（Workers AI 會產生費用，防匿名濫用）
  const userId = await getAuthUserId(request, env);
  if (!userId) return json({ error: '請先登入' }, 401);

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
    console.error('AI 精簡失敗:', err);
    return json({ error: GENERIC_500 }, 500);
  }
}

// POST /api/correct — 用 Workers AI 校正語音辨識的錯字/贅字/術語（PM-60，保留原意不摘要）
// PM-60c：依序實測 qwq-32b（輸出冗長推理、不可用）/ deepseek-r1-distill-qwen-32b（此帳號無此模型 5007）
//        / qwen3 / llama-3.3，以 UTF-8 驗證——qwen3 與 llama-3.3 都回乾淨正確中文（先前「亂碼」是
//        Windows Git-Bash 測試環境的編碼坑，非 server）。選 llama-3.3：非推理模型（無 <think> 額外開銷/
//        洩漏風險）、與 summarize 同款、4 樣本實測穩定。
async function correctText(request: Request, env: Env): Promise<Response> {
  // PM-135：需登入（Workers AI 會產生費用，防匿名濫用）
  const userId = await getAuthUserId(request, env);
  if (!userId) return json({ error: '請先登入' }, 401);

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
    console.error('AI 校正失敗:', err);
    return json({ error: GENERIC_500 }, 500);
  }
}

// POST /api/transcribe — Groq Whisper 語音轉文字（PM-85：麥克風架構升級 1/3）
// 接收音訊（multipart form-data 的 audio 欄位，或 raw binary）→ Groq Whisper → 回中文逐字稿。
async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  // PM-135：需登入（Groq Whisper 每次 25MB 音訊成本放大，防匿名荷包型 DoS）
  const userId = await getAuthUserId(request, env);
  if (!userId) return json({ error: '請先登入' }, 401);

  // PM-135：Whisper 是付費功能——僅有效付費用戶（paid/cancelled 未到期/day_pass）可用。
  // 免費版走前端 Web Speech API，本來就不該打 Groq。
  const { data: uData } = await supa(env)
    .from('users')
    .select('plan, day_pass_expires_at')
    .eq('user_id', userId)
    .maybeSingle();
  const u = (uData ?? {}) as { plan?: string | null; day_pass_expires_at?: string | null };
  if (!isActiveUser(u)) {
    return json({ error: 'Whisper 語音為付費功能，請升級' }, 403);
  }

  // 1. 讀取音訊（+ PM-137：可選 language 欄位）
  const contentType = request.headers.get('content-type') || '';
  let audioBlob: Blob;
  let language = 'zh';
  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const file = formData.get('audio');
    if (!file || typeof file === 'string') {
      return json({ error: '缺少 audio 欄位' }, 400);
    }
    audioBlob = file;
    language = formData.get('language')?.toString() || 'zh';
  } else {
    audioBlob = await request.blob();
  }

  // 2. 檢查大小（上限 25MB = Groq 免費版限制；過短視為無效）
  if (audioBlob.size > 25 * 1024 * 1024) {
    return json({ error: '音訊超過 25MB 上限' }, 400);
  }
  if (audioBlob.size < 100) {
    return json({ error: '音訊太短' }, 400);
  }

  // PM-137：語言白名單（防濫用；非白名單一律 fallback zh）
  const ALLOWED_LANGS = ['zh', 'yue', 'ja', 'ko', 'en', 'vi'];
  const finalLang = ALLOWED_LANGS.includes(language) ? language : 'zh';

  // 3. 呼叫 Groq Whisper API
  const groqForm = new FormData();
  groqForm.append('file', audioBlob, 'audio.webm');
  groqForm.append('model', 'whisper-large-v3-turbo');
  groqForm.append('language', finalLang); // PM-137：使用者選的語言（預設 zh）
  groqForm.append('response_format', 'verbose_json');

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: groqForm,
    });
    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq transcribe failed:', groqRes.status, errText); // PM-135：原始錯誤只記 log
      return json({ error: '語音轉錄失敗，請稍後再試' }, 502);
    }
    const result = (await groqRes.json()) as {
      text?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
      language?: string;
      duration?: number;
    };
    return json({
      ok: true,
      text: result.text ?? '',
      segments: result.segments ?? [],
      language: result.language ?? 'zh',
      duration: result.duration ?? 0,
    });
  } catch (err) {
    console.error('Groq fetch error:', err);
    return json({ error: '語音轉錄服務暫時不可用' }, 503);
  }
}

// PM-133：舊 googleAuth（POST /api/auth/google）已移除——它發假 base64 token 且以 email 查 user，
// 是帳號接管根因（P0-2/P0-3）。登入統一走 createSession（POST /api/auth/session，驗 Google token audience）。

// GET /api/user/plan — 查方案 + 免費版剩餘用量（每月自動重置計數）（PM-63）
// PM-134：私有 plan 狀態一律 jsonNoStore（避免邊緣快取把 A 的方案跨服給 B，也是 paid 用戶「看不到狀態」主因）。
async function getUserPlan(request: Request, env: Env): Promise<Response> {
  const userId = await getAuthUserId(request, env);
  if (!userId) return jsonNoStore({ error: 'unauthorized' }, 401);
  try {
    const { data: user, error } = await supa(env)
      .from('users')
      .select('plan, recording_count, rewind_count, mcp_count, usage_reset_at, plan_expires_at, day_pass_expires_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('查方案失敗:', error.message);
      return jsonNoStore({ error: GENERIC_500 }, 500);
    }
    if (!user) return jsonNoStore({ error: 'user not found' }, 404);

    const u = user as {
      plan: string | null;
      recording_count: number;
      rewind_count: number;
      mcp_count: number;
      usage_reset_at: string;
      plan_expires_at: string | null;
      day_pass_expires_at: string | null;
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

    // PM-109：day_pass 到期 → 自動降回 free（清 day_pass_expires_at；不重置用量欄位）
    if (u.plan === 'day_pass' && u.day_pass_expires_at && now > new Date(u.day_pass_expires_at)) {
      await supa(env)
        .from('users')
        .update({ plan: 'free', day_pass_expires_at: null })
        .eq('user_id', userId);
      u.plan = 'free';
      u.day_pass_expires_at = null;
    }

    // PM-73/109：cancelled 未到期、day_pass 未到期皆視同付費（享無限功能）
    const isPaid = isActiveUser(u);
    return jsonNoStore({
      plan: u.plan ?? 'free',
      expires_at: u.plan_expires_at ?? null, // 相容舊 popup（PM-75）
      plan_expires_at: u.plan_expires_at ?? null, // PM-134：cancelled 顯示到期日
      day_pass_expires_at: u.day_pass_expires_at ?? null, // PM-109
      limits: isPaid
        ? null
        : {
            recording: { used: u.recording_count, max: FREE_LIMITS.recording },
            rewind: { used: u.rewind_count, max: FREE_LIMITS.rewind },
            mcp: { used: u.mcp_count, max: FREE_LIMITS.mcp },
          },
    });
  } catch (err) {
    console.error('plan error:', err);
    return jsonNoStore({ error: GENERIC_500 }, 500);
  }
}

// POST /api/user/usage — 遞增用量；免費版超限回 403 limit_reached（PM-63）
async function bumpUsage(request: Request, env: Env): Promise<Response> {
  const userId = await getAuthUserId(request, env);
  if (!userId) return json({ error: 'unauthorized' }, 401);
  try {
    const { type } = (await request.json().catch(() => ({}))) as { type?: UsageType };
    if (!type || !(type in FREE_LIMITS)) return json({ error: 'invalid type' }, 400);

    const { data: user, error } = await supa(env)
      .from('users')
      .select('plan, recording_count, rewind_count, mcp_count, day_pass_expires_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('查用量失敗:', error.message);
      return json({ error: GENERIC_500 }, 500);
    }
    if (!user) return json({ error: 'user not found' }, 404);

    const u = user as {
      plan: string | null;
      recording_count: number;
      rewind_count: number;
      mcp_count: number;
      day_pass_expires_at: string | null;
    };
    // PM-73/109：cancelled 未到期、day_pass 未到期皆視同付費（無限）
    if (isActiveUser(u)) return json({ ok: true, unlimited: true });

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
    console.error('usage error:', err);
    return json({ error: GENERIC_500 }, 500);
  }
}

// ── PM-72：綠界 ECPay 付費串接 ─────────────────────────────
// 產生帶 CheckMacValue 的綠界月訂閱表單並自動提交（userId 已由呼叫端驗證，PM-128）
async function ecpayCheckout(userId: string, origin: string, env: Env): Promise<Response> {
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
    ReturnURL: `${origin}/api/ecpay/callback`, // server-to-server 通知
    OrderResultURL: `${origin}/checkout/result`, // 付款後瀏覽器導回
    ChoosePayment: 'Credit',
    EncryptType: '1',
    CustomField1: userId, // 用 CustomField 帶 user_id 回來
    // PM-72b：定期定額（月扣 NT$80 訂閱制）。PeriodAmount 必須等於 TotalAmount。
    PeriodAmount: '80', // 每期授權金額
    PeriodType: 'M', // 週期：M=月
    Frequency: '1', // 每 1 個月扣一次
    ExecTimes: '99', // 最多扣 99 次（最少 2，月 max 999）
    PeriodReturnURL: `${origin}/api/ecpay/period-callback`, // 第 2 次起的扣款結果通知
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

// ── PM-109：日票 NT$20（一次性付款，非定期定額；信用卡+ATM+超商 ChoosePayment=ALL）──
// POST /api/day-pass/create → 需登入；建綠界一次性訂單 → 回自動送出的付款表單 HTML
async function handleDayPassCreate(request: Request, env: Env): Promise<Response> {
  const userId = await getAuthUserId(request, env);
  if (!userId) return json({ error: '請先登入' }, 401);

  // 已是月費 / 已有有效日票 → 擋
  const { data } = await supa(env)
    .from('users')
    .select('plan, day_pass_expires_at')
    .eq('user_id', userId)
    .maybeSingle();
  const u = (data ?? {}) as { plan?: string | null; day_pass_expires_at?: string | null };
  if (u.plan === 'paid' || u.plan === 'cancelled') {
    return json({ error: '您已是月費用戶，不需購買日票' }, 400);
  }
  if (u.day_pass_expires_at && new Date(u.day_pass_expires_at) > new Date()) {
    return json({ error: '您已有有效日票，到期後才能再購買' }, 400);
  }

  const origin = new URL(request.url).origin;
  const now = new Date();
  const tradeNo = `DP${now.getTime()}`.slice(0, 20); // 唯一訂單編號，最長 20 碼
  const params: Record<string, string> = {
    MerchantID: env.ECPAY_MERCHANT_ID,
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: formatEcpayDate(now),
    PaymentType: 'aio',
    TotalAmount: '20',
    TradeDesc: 'BugEzy 日票（24小時無限使用）',
    ItemName: 'BugEzy 日票 NT$20',
    ReturnURL: `${origin}/api/day-pass/callback`, // server-to-server 通知
    ClientBackURL: `${origin}/day-pass-success`, // 付款後瀏覽器 GET 導回
    ChoosePayment: 'ALL', // 信用卡 + ATM + 超商（一次性）
    EncryptType: '1',
    CustomField1: userId, // callback 用來識別使用者
  };
  params.CheckMacValue = await generateCheckMacValue(params, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV);

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

// POST /api/day-pass/callback → 綠界付款結果通知（驗 CheckMacValue → 開通 24 小時日票）
async function handleDayPassCallback(request: Request, env: Env): Promise<Response> {
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

  // 後台「付款結果通知(模擬)」：SimulatePaid=1，不開通但仍回 1|OK
  if (params.SimulatePaid === '1') {
    return new Response('1|OK', { status: 200 });
  }

  // 付款成功（RtnCode=1）→ 用 CustomField1 帶回的 user_id 開通 24 小時日票
  if (params.RtnCode === '1') {
    const userId = params.CustomField1;
    if (userId) {
      await supa(env)
        .from('users')
        .update({ plan: 'day_pass', day_pass_expires_at: dayPassExpiryISO() })
        .eq('user_id', userId);
    }
  }

  return new Response('1|OK', { status: 200 });
}

// GET /day-pass-success → 日票啟動成功頁
function dayPassSuccessPage(): Response {
  const body =
    `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>日票啟動成功</title>` +
    `<style>body{background:#0f0f1a;color:#e0e0e0;font-family:system-ui,"Microsoft JhengHei",sans-serif;` +
    `display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}` +
    `.card{background:#1a1a2e;border:1px solid #7c3aed;border-radius:16px;padding:40px;text-align:center;max-width:400px;}` +
    `.icon{font-size:48px;margin-bottom:16px;}h1{font-size:24px;margin:0 0 8px;}` +
    `p{color:#aaa;margin:0 0 24px;line-height:1.6;}a{color:#a78bfa;text-decoration:none;}</style></head>` +
    `<body><div class="card"><div class="icon">🎉</div>` +
    `<h1>日票啟動成功！</h1>` +
    `<p>24 小時內享有所有付費功能（無限錄製 / MCP / Whisper 精準語音）。重新開啟 BugEzy 即可使用。</p>` +
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
  const userId = await getAuthUserId(request, env);
  if (!userId) return json({ error: 'unauthorized' }, 401);
  try {
    const { data: user, error } = await supa(env)
      .from('users')
      .select('plan, ecpay_trade_no, plan_expires_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('查用戶失敗:', error.message);
      return json({ error: GENERIC_500 }, 500);
    }
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
    console.error('cancel error:', err);
    return json({ error: GENERIC_500 }, 500);
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
  return `\n\n---\n📊 Token 估算：~${est.bugezyTokens.toLocaleString()} tokens ≈ USD $${est.bugezyUSD}\n💡 同場景 Claude in Chrome：~${est.chromeTokens.toLocaleString()} tokens ≈ USD $${est.chromeUSD}\n✅ BugEzy 為你省了 ${est.savedPercent}%`;
}

// ── PM-56：月度使用量統計（每次 MCP 呼叫記錄到 Supabase mcp_usage 表）──
async function logMcpUsage(
  env: Env,
  toolName: string,
  est: TokenEstimate,
  reportId?: string,
): Promise<void> {
  try {
    const key = supaKey(env); // PM-93：service_role（繞 RLS）或退回 anon
    await fetch(`${env.SUPABASE_URL}/rest/v1/mcp_usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
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
  const key = supaKey(env); // PM-93：service_role（繞 RLS）或退回 anon
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/mcp_usage?select=tool_name,tokens_estimated,chrome_tokens_estimated&created_at=gte.${monthStart}`,
    {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
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
        `BugEzy Token 消耗：~${data.totalTokens.toLocaleString()} tokens ≈ USD $${data.totalUSD}\n` +
        `同場景 Claude in Chrome：~${data.totalChromeTokens.toLocaleString()} tokens\n` +
        `省下的 Token：~${data.savedTokens.toLocaleString()} tokens ≈ USD $${data.savedUSD}\n` +
        `節省比例：${data.savedPercent}%`;
      const est = estimateTokens(text, 'get_usage_stats');
      await logMcpUsage(env, 'get_usage_stats', est); // PM-56b：await，否則 Workers 提前終止寫不進
      return { content: [{ type: 'text' as const, text: text + formatTokenFooter(est) }] };
    },
  );

  // Tool 12（PM-57）: get_screenshots — 回傳報告截圖（base64），include_images 控制是否含圖片省 token
  server.tool(
    'get_screenshots',
    '高畫質 AI 分析：取得報告截圖圖片（視覺 Bug 用）。⚠ 圖片消耗較高 Token（每張 ~3,000-8,000），建議只在需要看畫面時使用。Report screenshots.',
    {
      report_id: z.string(),
      include_images: z
        .boolean()
        .optional()
        .describe('開啟高畫質 AI 分析（預設 false，只回 metadata 省 Token）'),
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
            message: `此報告有 ${screenshots.length} 張截圖。如需高畫質 AI 分析（視覺 Bug），請加 include_images: true（每張約 3,000-8,000 Token）。`,
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
      const footer = `\n\n---\n📊 Token 估算：~${totalTokens.toLocaleString()} tokens ≈ USD $${((totalTokens * 8) / 1_000_000).toFixed(4)}（含 ${screenshots.length} 張圖片）\n💡 同場景 Claude in Chrome：~${chromeTokens.toLocaleString()} tokens ≈ USD $${((chromeTokens * 8) / 1_000_000).toFixed(4)}\n✅ BugEzy 為你省了 ${savedPercent}%`;
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
