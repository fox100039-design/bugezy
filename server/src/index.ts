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
  // PM-190：MCP handler 入口從 URL query（?token=）讀出的 session_token，供 MCP tools 免參數自動取用（方案 B）。
  //   per-request 設定：Worker 每個 request 用同一 env 物件實例，MCP handler 同步呼叫 tools，不會跨 request 汙染。
  __mcp_session_token?: string;
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
  networkSnapshot?: unknown; // PM-156：網路環境快照（atStart/atEnd），存 JSONB
  storageSnapshot?: unknown; // PM-157：儲存空間快照（已在 extension 端遮罩），存 JSONB
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

/** PM-128：驗證原始 session token 字串（查 sessions 表，不可猜測）。過期自動刪除並回 null。
 *  PM-184：抽出供 /reports 頁面（token 在 query）與 verifySession（token 在 header）共用。 */
async function verifySessionByToken(token: string, env: Env): Promise<string | null> {
  if (!token || token.length < 10) return null;
  const { data } = await supa(env)
    .from('sessions')
    .select('user_id, expires_at')
    .eq('session_token', token)
    .maybeSingle();
  if (!data) return null;
  const row = data as { user_id: string; expires_at: string };
  if (new Date(row.expires_at) <= new Date()) {
    await supa(env).from('sessions').delete().eq('session_token', token); // 過期即刪
    return null;
  }
  return row.user_id;
}

/** PM-128：從 Authorization: Bearer 驗證 session token。 */
async function verifySession(request: Request, env: Env): Promise<string | null> {
  const auth = request.headers.get('Authorization');
  if (!auth) return null;
  return verifySessionByToken(auth.replace('Bearer ', '').trim(), env);
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

/** PM-166（Fable5）：從 Authorization: Bearer 取原始 token 字串（供 rotate 刪舊用；長度<10 視為無效回 null）。 */
function extractBearer(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth) return null;
  const token = auth.replace('Bearer ', '').trim();
  return token.length >= 10 ? token : null;
}

/** PM-166（Fable5）：敏感操作（取消訂閱等）後換發新 session token，限縮舊 token 生命週期（90 天不變的風險）。
 *  發新 token（雙 UUID，同 createSession）+ 刪舊 token。回新 token 供回傳給 extension 更新 storage。 */
async function rotateSession(userId: string, oldToken: string | null, env: Env): Promise<string> {
  const newToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  await supa(env)
    .from('sessions')
    .insert({
      session_token: newToken,
      user_id: userId,
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    });
  if (oldToken) {
    await supa(env).from('sessions').delete().eq('session_token', oldToken);
  }
  return newToken;
}

/** PM-146：POST /api/auth/logout — 從 sessions 表刪除 token（登出即撤銷，舊 token 立即失效）。
 *  無 token 也回 ok（登出本就冪等）。 */
async function handleLogout(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization');
  const token = auth ? auth.replace('Bearer ', '').trim() : '';
  if (token) {
    await supa(env).from('sessions').delete().eq('session_token', token);
  }
  return json({ ok: true });
}

// PM-160：合法截圖來源——data:image base64（png/jpeg/webp/gif）或 https URL（不含引號/角括號防屬性突破）
const VALID_SCREENSHOT_SRC =
  /^(data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+|https:\/\/[^\s"'<>]+)$/;

// PM-160：全站 HTML 回應統一注入 CSP（Stored XSS 縱深防禦）。
//   form-action 放行 ECPay 付款域名（checkout 頁自動 submit 到綠界，否則 default-src 'self' 會擋掉付款跳轉）。
const CSP_VALUE =
  "default-src 'self'; " +
  "img-src 'self' data: https:; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' https://bugezy.dev https://bugezy-api.bugezy-api.workers.dev; " +
  'form-action ' +
  "'self' https://payment.ecpay.com.tw https://payment-stage.ecpay.com.tw; " +
  "base-uri 'self'; " +
  "frame-ancestors 'none'; " + // PM-219 修復6：禁止被任意網站 iframe 嵌入（防點擊劫持）
  "object-src 'none';";

// PM-166（Fable5）：報告頁渲染使用者資料（XSS 主要標的），改嚴格 CSP——script-src 拿掉 'unsafe-inline' 改 'self'
// （client 邏輯已抽到 /report-page.js）。行銷頁為靜態文案（無注入點）故沿用 CSP_VALUE 保留其 inline script，不破壞。
const CSP_VALUE_STRICT_SCRIPT = CSP_VALUE.replace(
  "script-src 'self' 'unsafe-inline'; ",
  "script-src 'self'; ",
);

function html(body: string, strictScript = false): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': strictScript ? CSP_VALUE_STRICT_SCRIPT : CSP_VALUE, // PM-160/166
    },
  });
}

// PM-166：serve 外部 JS（report-page.js）。同源 'self' 允許，快取 1 天。
function javascript(body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'Content-Security-Policy': CSP_VALUE,
    },
  });
}

// ── PM-150：對外頁面語言（首頁 + /install）——Accept-Language 自動偵測 + ?lang= 手動覆蓋 ──
type PageLang = 'zh' | 'en';
function detectLang(request: Request): PageLang {
  const accept = request.headers.get('Accept-Language') || '';
  // 中文系（zh-TW/zh-HK/zh-CN/zh）→ 中文；其餘一律英文
  return /zh/i.test(accept.split(',')[0] || '') ? 'zh' : 'en';
}
function getLang(request: Request): PageLang {
  const param = new URL(request.url).searchParams.get('lang');
  if (param === 'en' || param === 'zh') return param; // 手動覆蓋優先
  return detectLang(request);
}

// ── PM-172：付費資格用 Cloudflare IP 國家碼判斷（零成本、準確、無法偽造），取代 PM-171 的語言判斷。──
// 綠界目前只收台灣卡 → 只有 TW 開放付費；其餘顯示 coming soon。未來特約通過改白名單即可（見 §5）。
function cfCountry(request: Request): string {
  return (request as Request & { cf?: { country?: string } }).cf?.country || 'UNKNOWN';
}
const PAY_COUNTRIES = ['TW']; // 目前只開放台灣；未來：['TW','HK','JP','KR','SG','VN']
function isPayCountry(request: Request): boolean {
  return PAY_COUNTRIES.includes(cfCountry(request));
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
    ['/skill', 'monthly', '0.5'], // PM-201：AI 客服手冊
    ['/feedback', 'monthly', '0.4'], // PM-174
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
    `Disallow: /report/\n` +
    `Disallow: /reports\n\n` + // PM-184：我的報告列表（含 token，私人頁）
    `Sitemap: https://bugezy.dev/sitemap.xml\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// PM-211：Open Graph + Twitter Card meta（社群分享 FB/LINE/Threads/X 預覽卡片）。
// 各頁 title/description 依規格帶入；og:image 暫用品牌 icon-128（由 GET /icon-128.png 提供，見下）。
function ogMeta(path: string, title: string, description: string): string {
  const tt = title.replace(/"/g, '&quot;');
  const dd = description.replace(/"/g, '&quot;');
  const url = `https://bugezy.dev${path}`;
  return `<meta property="og:type" content="website">
  <meta property="og:site_name" content="BugEzy">
  <meta property="og:title" content="${tt}">
  <meta property="og:description" content="${dd}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="https://bugezy.dev/icon-128.png">
  <meta property="og:image:width" content="128">
  <meta property="og:image:height" content="128">
  <meta property="og:locale" content="en_US">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${tt}">
  <meta name="twitter:description" content="${dd}">
  <meta name="twitter:image" content="https://bugezy.dev/icon-128.png">`;
}

// PM-211：og:image 用的品牌 icon（128×128 PNG，內嵌 base64 = extension/icons/icon-128.png），
// 由 GET /icon-128.png 提供，避免 OG image 指向 404。之後可換 1200×630 正式分享圖。
const ICON_128_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAIGElEQVR4nO2dS4gcRRjHv+6ZdSYx7xjJJqKriQEPRgN6EISYJQqeNeBFIUEP6l5EECSLa/SQk+SyIuYQCYKIEkFvBiUHg4QQohkF2Qhms8nOGhKTzcZ9ZXZnPYQea3u7e7q629tYT/1O86juevz/9VVVPz0wzKZN2xdM79PxP/V6zTO5v9w7c4LzktcQmTd2wssiqxG0N3LCy0bXCL5OYie+fHQ1SuUWJ7ydpIkGbSOAE99e0miXaAAnvv200zDWAE784pCkZaQBnPjFI07TMnVBTPLRW2dan98+9ETH5W+CJRHAlt6vNn7U96Lnn4Uobf12CSQS19hUInDnn4ewxloHghzFo2UAW3q/Iz+q1lZGgLgJF9VEjDt/k3gA9vZ+dcx9fftBWL73WGzafT0ntPd/ZHhX5O9Tn70AAACf1N5t/Waj+PV6zbPaACqBKMv3HsskdlqODO9alJfN1Os1z8ohIIlAHOz99x3oQ82HCqsjQLinDw4Mtj5jCJS0/7jhQjL1es3zbBQ/KcRjmSDtfm0zglUGSDu2mzZBlv3ZYgQrDJBlUheIFiWYKmiYcPq8ZpJuBPEGyDOjD5sgSfgw4W3yRBLJJhBtgLzLOR3BkzAxjEg1gchl4L6eE0bW8pKWaqbqZBpxBjDZSKYigKn9AJitnwlEGUCi+Bj7k2QCMVcEUTTKjefea31ee/yD3OnysK/nhIh5gYhJoGnxw71VFTSMKnCadKbnFdwmYI8AlOFw8+bHWp9HR8/lTmcC7kjAOgfAED+u96uiqt+D/9OmMz23AOCdE7AZQNJESAJc7cFiACd+NBztImoZiEEweQuP5cH34P+06YoG+SSQs/enndBhT/ySoJ4UkhqAS/yg97Zb36dNhw2lCcgMIGHcTyumhHBPZYJCzQEwlmic+VBAYgCK3k8tCkV+FO1WiAjA1SOLEAnQDaC6GKPBuEXArhN2FEA/GRRUINxQpi/W5AajPsE+MSeDqBEgTvy433SQJD4ATn2C3zCjAGoESLpxQ0W390gTX8VUXahuPCGdBMY1zuDAoGhRMUiqM+W1jGgRoF3Yylp5G4yStQ7ttsOIAmwGCNBpDBvED9ApP+fdRuxXBPUd6ENZIawuV2G495226RoLTZiavw03GtPw19R1qE38Dd9f/RNOjY/kLkMYrLrmASUCZJ21Dg4MJjaITgRIa4A4ztwchTd//xbOT17LtH27emQV3nQUEGWAJHTDf14DAACMN2Zg56nDMDI9nml7jN5t2gCFOBSMxZquKrz/8G7uYqDCPgdIg8nJ39R8Azb/eLD1veKX4ZEVG+DDbc/C0+t6lqR//t5tUPFLMNuc184rT6inouMjwGxzDn6dGIOXz30FjYXmkv+rfhk2VlYylIwG4waQcOFHFsYbMzA2MxH5n+8ZfVFXLky3L2kEkLyOX12uQnd11ZLfbzfn4fL0TdKyULYTmQGCSuke9sVujIpfgu0rN8LRx/dAV8RD074e+y1yaEiLbl3VdqKAZBIYd6aLY4K0vNSVeA+gyvnJazBw/gfkEt2Bq41IDBD3iBYTj1/B4vPRX6B/6DhMzM2i5sN9QsidDYxhT/ej0L+1Fyo+Th+RcjaQfBnYd6Av0QhSqPpleO3+J+HLHS9BxS8Z3XeS8NTRkO1AENewED4QVPZ86K6uhN71W2D/1l2w4a67F6V/Zv1D8MYDT8GhCydz5y2hx4dhPxAUVXnKBplbaMKl6Ztw9PJZeLX2TWSaV+7bYSQv7rpGwW4AgMWhj7NBfrp+AabmG0t+71m2FtZ0VY3kodaTW3wAIQYI4G4Qz/Ni36W7olQxlg93PVVEGYCbnesehGWlrsj//mlMEZeGBivOBmJS8jzorqyC3fdsgf1beyPTDP17FaYjhoYiYMUFIVmWhyYuCAnoHzoOH188lWlb6U8Vc0NAG05eH4ZPR05zFwMNdzYwhsZCEw6PnIYXz34BczlOBmWBsp3I5gDhs1ySZsKNhSZMzt2GK7O3YGjyGvx84yJ8d+UPGJu9RVoOVXiqk2UkcwATR8Bsih4BJuqHfYsY6Y0heYxQVAPotEkh7gzSeV2LzrbSyFOXuG0xDODOBjIg6Wwg6e3hUbh7A9MNFYW4PTwKnTNkklYOSeiUn7tO7BFAJe3SR3IkSFt+XeGtjAC6hebuDVRIER9AwBCQBalGkVquJNANgOVeaY2NVR7sx8VaGQECpJhASjmyQGIATBdzNz5m/u5h0SnhMgG3+UxAZgBsN1OLgZ0f1fsCyN8baPuTwymMRvnGEPIhgKJyWCIVTXyAAl8UqoqVJyIUYZxPgu3VsVxPEkljBi7ROd4gyvruYFsfJ4MB1+tjWZeB3C9OlkLHvjsYwJmAu/7sBgDgbwQuJNRbhAEAZDQGJVLqK8YAAHIaBRtJ9RRlAABZjYOBtPqxLgPbUaRlojThA8RFABWpjaaL5HqINgCA7MZLg/Tyix4Cwtg0JEgXPsAqAwRINoItwgdYaYAASUawTfgAqw2gwmEGW0VXKYwBVDDNUATRVQppgCiymKJoYkfRMQZwRCP+OIADF2eADsev12tyXonlIKVer0W8JcnRUTgDdDjOAB2OD3BnLOAuiIOWQHMXATqclgFcFOgcVK1dBOhwFhnARYHiE9Z4SQRwJiguUdq6IaDDiTSAiwLFI07T2AjgTFAckrRMHAKcCeynnYZt5wDOBPaSRjstcd3VQ3ag02m1VgEuGshHV6PMgrpoIIusnTN3j3ZG4CVvVDYe0p0hcDE9DP8H8w/FQny4ydAAAAAASUVORK5CYII=';
function iconPng(): Response {
  const bin = atob(ICON_128_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' },
  });
}

// PM-212：JSON-LD 結構化資料（Google rich snippets）。放在 <script type="application/ld+json">，
// 內容為靜態（無使用者資料）；仍把 `<` 轉義為 < 防 `</script>` 提前結束（穩健做法）。
function jsonLd(obj: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
}
// 首頁：SoftwareApplication（產品/價格）+ Organization（品牌/logo）
const SOFTWARE_APP_LD = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'BugEzy',
  description:
    'Voice-powered bug reporting Chrome extension with MCP integration. Captures console logs, network errors, DOM traces, and developer voice descriptions.',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Chrome, Windows, macOS, Linux',
  url: 'https://bugezy.dev',
  downloadUrl:
    'https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj',
  softwareVersion: '1.1.2',
  author: { '@type': 'Organization', name: 'BugEzy', url: 'https://bugezy.dev' },
  offers: [
    {
      '@type': 'Offer',
      name: 'Free Plan',
      price: '0',
      priceCurrency: 'TWD',
      description: '10 recordings, 5 rewinds, 20 MCP calls per month',
    },
    {
      '@type': 'Offer',
      name: 'Monthly Plan',
      price: '80',
      priceCurrency: 'TWD',
      description: 'Unlimited recordings, rewinds, and MCP calls',
    },
    {
      '@type': 'Offer',
      name: 'Day Pass',
      price: '20',
      priceCurrency: 'TWD',
      description: '24-hour full access',
    },
  ],
};
const ORGANIZATION_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'BugEzy',
  url: 'https://bugezy.dev',
  logo: 'https://bugezy.dev/icon-128.png',
  sameAs: ['https://github.com/fox100039-design/bugezy'],
};
// PM-213：/faq 頁的 FAQPage JSON-LD 改由 faqPage 依 lang 動態產生（與頁面可見 Q&A 逐字一致，
// Google 要求 FAQ markup 文字須為頁面可見內容）；原 /skill 的 SKILL_FAQ_LD 已移除（skill 非 FAQ 頁）。

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

/** 綠界 MerchantTradeDate 格式：yyyy/MM/dd HH:mm:ss。
 *  PM-149（P3-2）：綠界預期台灣時間（UTC+8）。Workers 跑在 UTC edge，故手動加 8 小時 + 用 getUTC*，
 *  確保不管 edge 節點在哪都輸出台灣時間（原本用本地 get* = UTC，跨日邊界會差一天，對帳出錯）。 */
function formatEcpayDate(d: Date): string {
  const tw = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${tw.getUTCFullYear()}/${p(tw.getUTCMonth() + 1)}/${p(tw.getUTCDate())} ${p(tw.getUTCHours())}:${p(tw.getUTCMinutes())}:${p(tw.getUTCSeconds())}`;
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

// PM-219 修復2：ECPay callback 的 users.update 統一走此 helper——檢查 error，失敗回 false，
//   讓呼叫端回 500 使綠界重送（避免「已收款/已扣款但 users 未更新」的孤兒態被冪等短路永久卡住）。
async function updateUserPlan(env: Env, userId: string, patch: Record<string, unknown>): Promise<boolean> {
  const { error } = await supa(env).from('users').update(patch).eq('user_id', userId);
  if (error) {
    console.error('ECPay users.update failed:', error.message, userId); // 原始錯誤只記 log
    return false;
  }
  return true;
}

// PM-144：以 user_id 查 users 表判斷是否為有效付費用戶（terminal-logs 付費限定用）。
async function isActiveUserId(userId: string, env: Env): Promise<boolean> {
  const { data } = await supa(env)
    .from('users')
    .select('plan, day_pass_expires_at')
    .eq('user_id', userId)
    .maybeSingle();
  return data ? isActiveUser(data as { plan?: string | null; day_pass_expires_at?: string | null }) : false;
}

// ── PM-62：產品首頁（GET /）— 一頁式、深色主題、無 JS、RWD（綠界審核 + 客戶訪問用）──
// PM-150：首頁改為函式（依 lang 中英切換）。CSS/script 不變，只切換文字 + <html lang> + meta。
function homePage(lang: PageLang, request: Request): string {
  const isTaiwan = isPayCountry(request); // PM-172：定價區付費按鈕依 IP 國家（TW=付費，其餘 coming soon）
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  // PM-192（三修）：安裝指令抽成變數，供 <pre> 顯示與按鈕 data-copy-text 共用（複製從 attribute 讀，不受 DOM textContent 影響）。
  const aiPrompt = t(
    `請幫我安裝 BugEzy MCP 除錯工具，讓你可以直接讀取我的 Bug 報告來幫我修 Bug。

安裝步驟：
1. Chrome 擴充功能：https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj
2. MCP 連線設定，在你的 MCP config 加入：
{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}

安裝完成後，我只要用 BugEzy 錄製 Bug，你就能透過 MCP 讀取我的報告（Console 錯誤、Network 問題、語音描述、截圖），直接幫我修。

詳細教學：https://bugezy.dev/install`,
    `Please help me install the BugEzy MCP debugging tool so you can read my bug reports and fix bugs for me.

Steps:
1. Chrome extension: https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj
2. MCP connection — add this to your MCP config:
{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}

Once installed, whenever I record a bug with BugEzy, you can read my report via MCP (console errors, network issues, voice description, screenshots) and fix it directly.

Full guide: https://bugezy.dev/install`,
  );
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-TW' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${t('BugEzy — 開發者 Bug 報告工具，AI 幫你修', 'BugEzy — Bug Reporter for Developers, AI fixes your bugs')}</title>
  <meta name="description" content="${t('亞洲最平價的 MCP 語音除錯工具。錄製 Bug、AI 自動分析、一鍵報告。支援 Claude、Cursor、Windsurf 等 7 大 AI 工具。月費 NT$80 起。', 'The most affordable MCP voice debugging tool in Asia. Record bugs, AI auto-analysis, one-click reports. Works with Claude, Cursor, Windsurf and 7 major AI tools. From NT$80/mo.')}">
  <meta name="keywords" content="BugEzy, bug reporter, MCP, AI debugging, Chrome extension, 語音除錯, bug tracking">
  ${ogMeta('', 'BugEzy — Voice-Powered Bug Reporting for Developers', 'Capture bugs with voice, console logs, network errors, and DOM traces. Affordable MCP debugging tool. Chrome Extension + Python CLI. NT$80/mo.')}
  ${jsonLd(SOFTWARE_APP_LD)}
  ${jsonLd(ORGANIZATION_LD)}
  <meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
  <link rel="canonical" href="https://bugezy.dev">
  <style>
    .lang-switch { position:fixed; top:14px; right:16px; z-index:10; background:#1a1a2e; border:1px solid #7c3aed; border-radius:8px; padding:5px 12px; font-size:13px; color:#c4b5fd; }
    .lang-switch:hover { background:#2a2a3e; }
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
    .copy-btn { background:#7c3aed; color:#fff; border:none; border-radius:10px; padding:12px 24px; font-size:16px; font-weight:600; cursor:pointer; width:100%; transition:transform 0.08s ease, opacity 0.08s ease, background 0.2s; }
    .copy-btn:active { transform:scale(0.97); opacity:0.8; } /* PM-192：按下沉下去回饋 */
    .copy-btn.copied { background:#238636; }
    .copy-btn:hover { background:#6d28d9; }
    .copy-feedback { color:#3fb950; font-size:14px; margin-top:8px; display:inline-block; }
    .ai-install-tools { color:#666; font-size:13px; margin-top:16px; }
    /* PM-202：AI Skill 專區 */
    .skill-box { max-width:720px; margin:24px auto 0; background:linear-gradient(135deg,#1a1533,#161b22); border:1px solid #7c3aed; border-radius:16px; padding:30px 28px; text-align:center; }
    .skill-box h2 { color:#fff; font-size:24px; margin:0 0 8px; }
    .skill-box .skill-lead { color:#c4b5fd; font-size:15px; margin:0 0 18px; }
    .skill-list { list-style:none; margin:0 auto 18px; padding:0; max-width:440px; text-align:left; }
    .skill-list li { margin:8px 0; font-size:15px; color:#e0e0e8; padding-left:4px; }
    .skill-note { color:#9aa3b2; font-size:14px; margin:0 0 20px; }
    .skill-actions { display:flex; gap:12px; justify-content:center; flex-wrap:wrap; }
    .skill-btn { display:inline-block; background:linear-gradient(135deg,#7c3aed,#6d28d9); color:#fff; font-weight:700; font-size:15px; padding:11px 24px; border-radius:10px; text-decoration:none; }
    .skill-btn.secondary { background:transparent; border:1px solid #7c3aed; color:#c4b5fd; }
    .capture-skill-note { max-width:820px; margin:20px auto 0; padding:14px 18px; background:#15152a; border:1px solid #7c3aed; border-radius:12px; font-size:14px; color:#d0d0d8; text-align:center; line-height:1.6; }
    .capture-skill-note a { color:#a78bfa; font-weight:600; }
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
    /* PM-164：BugEzy 能捕捉什麼 */
    .capture-grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; margin:24px 0; text-align:left; }
    .capture-col { background:#1a1a2e; border:1px solid #2a2a3e; border-radius:12px; padding:20px 24px; }
    .capture-col h3 { font-size:15px; color:#a78bfa; margin:0 0 12px; }
    .capture-col ul { margin:0; padding-left:20px; }
    .capture-col li { margin:7px 0; font-size:14px; color:#d0d0d8; line-height:1.5; }
    @media (max-width:600px) { .framework-grid { grid-template-columns:1fr; } .capture-grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <a class="lang-switch" href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t('EN', '中文')}</a>
  <header class="hero">
    <div class="logo">🐛</div>
    <h1>BugEzy</h1>
    <p class="tagline">${t('Web 開發者的 AI Bug 報告工具<br>六種錄製模式 × 13 個 MCP AI 工具 × 語音辨識 × AI Skill — 捕捉 95% 以上的 Web Bug', 'AI Bug Reporter for Web Developers<br>6 Recording Modes × 13 MCP AI Tools × Voice Recognition × AI Skill — Catches 95%+ of Web Bugs')}</p>
    <div class="bullets">
      <span>${t('✅ 語音描述 Bug，AI 自動分析', '✅ Describe bugs by voice, AI auto-analyzes')}</span>
      <span>${t('✅ 6 種錄製模式，完整重現問題', '✅ 6 recording modes, fully reproduce the issue')}</span>
      <span>${t('✅ MCP 整合，AI 直接讀報告', '✅ MCP integration, AI reads reports directly')}</span>
      <span>${t('✅ 省 95% Token 費用', '✅ Save 95% on token costs')}</span>
    </div>
    <div>
      <a class="cta" href="/install">${t('🧩 安裝 Chrome 擴充功能', '🧩 Install Chrome Extension')}</a>
      <span class="cta-note">${t('Chrome Web Store 即將上架', 'Coming soon to Chrome Web Store')}</span>
    </div>
  </header>

  <section class="wrap" id="modes">
    <h2>${t('六種錄製模式', 'Six Recording Modes')}</h2>
    <p class="sub">${t('依情境選最省力的方式回報 Bug', 'Pick the easiest way to report a bug for each situation')}</p>
    <div class="modes">
      <div class="mode"><div class="ico">🎬</div><div class="name">${t('錄製', 'Record')}</div><div class="desc">${t('DOM 軌跡 + 語音 + Console/Network', 'DOM trace + voice + Console/Network')}</div></div>
      <div class="mode"><div class="ico">⏪</div><div class="name">${t('回溯', 'Rewind')}</div><div class="desc">${t('一鍵抓剛才發生的 30 秒', 'Capture the last 30 seconds in one click')}</div></div>
      <div class="mode"><div class="ico">📸</div><div class="name">${t('截圖', 'Screenshot')}</div><div class="desc">${t('三種擷取 + 畫重點標注', '3 capture modes + annotation')}</div></div>
      <div class="mode"><div class="ico">🔇</div><div class="name">${t('鍵盤', 'Keyboard')}</div><div class="desc">${t('安靜環境，純文字模式', 'Quiet environment, text-only mode')}</div></div>
      <div class="mode"><div class="ico">🔍</div><div class="name">${t('監控', 'Monitor')}</div><div class="desc">${t('AI 隨時查當前頁 error', 'AI checks current-page errors anytime')}</div></div>
      <div class="mode"><div class="ico">🖥</div><div class="name">${t('終端機', 'Terminal')}</div><div class="desc">${t('npx bugezy-watch 攔 crash', 'npx bugezy-watch catches crashes')}</div></div>
    </div>
  </section>

  <section class="wrap" id="capture">
    <h2>${t('🔍 BugEzy 能捕捉什麼？', '🔍 What Can BugEzy Capture?')}</h2>
    <p class="sub">${t('前端自動捕捉、後端終端機攔截、AI 一鍵分析——一份報告全都有', 'Auto-captured on the frontend, caught on the backend, analyzed by AI — all in one report')}</p>
    <div class="capture-grid">
      <div class="capture-col">
        <h3>${t('🖥 前端（Chrome 擴充自動捕捉）', '🖥 Frontend (auto-captured by the Chrome extension)')}</h3>
        <ul>
          <li>${t('JS 執行錯誤（TypeError / ReferenceError / SyntaxError）', 'JS runtime errors (TypeError / ReferenceError / SyntaxError)')}</li>
          <li>${t('Promise 靜默失敗（未捕捉的 async/await 錯誤）', 'Silent Promise failures (unhandled async/await errors)')}</li>
          <li>${t('Console 警告（CORS / Mixed Content / Deprecated API）', 'Console warnings (CORS / Mixed Content / Deprecated API)')}</li>
          <li>${t('Network 失敗（API 4xx/5xx / timeout / CORS blocked）', 'Network failures (API 4xx/5xx / timeout / CORS blocked)')}</li>
          <li>${t('資源載入失敗（圖片 / CSS / JS / 字型 404）', 'Resource load failures (image / CSS / JS / font 404)')}</li>
          <li>${t('Web Vitals 效能（LCP / CLS / FID 超標警告）', 'Web Vitals performance (LCP / CLS / FID threshold alerts)')}</li>
          <li>${t('網路環境快照（WiFi / 4G / 離線 / 延遲 / 頻寬）', 'Network snapshot (WiFi / 4G / offline / latency / bandwidth)')}</li>
          <li>${t('儲存空間快照（localStorage / sessionStorage / Cookie，敏感值自動遮罩）', 'Storage snapshot (localStorage / sessionStorage / Cookie, sensitive values auto-masked)')}</li>
          <li>${t('DOM 變化（rrweb 全紀錄）', 'DOM changes (full rrweb recording)')}</li>
          <li>${t('語音描述（Whisper 精準轉錄 / Web Speech 即時字幕）', 'Voice notes (Whisper transcription / Web Speech live captions)')}</li>
          <li>${t('截圖標注（全頁 / 區域 / 自由形狀）', 'Screenshot annotation (full page / region / freehand)')}</li>
        </ul>
      </div>
      <div class="capture-col">
        <h3>${t('⚙ 後端（Terminal CLI 捕捉）', '⚙ Backend (captured by the Terminal CLI)')}</h3>
        <ul>
          <li>${t('Python traceback / exception', 'Python traceback / exception')}</li>
          <li>${t('Node.js uncaughtException / unhandledRejection', 'Node.js uncaughtException / unhandledRejection')}</li>
          <li>${t('任何語言的 stderr / crash log', 'stderr / crash logs from any language')}</li>
        </ul>
        <h3 style="margin-top:20px;">${t('🤖 AI 一鍵分析', '🤖 One-click AI analysis')}</h3>
        <ul>
          <li>${t('時序麵包屑 — 所有事件按時間排序成一條故事線', 'Timeline breadcrumb — every event sorted into one story')}</li>
          <li>${t('AI Bug 導航 — 自動分析根因、環境線索、修復建議', 'AI bug navigator — auto root-cause, environment clues, fix suggestions')}</li>
          <li>${t('13 個 MCP 工具 — AI 直接讀取，不用複製貼上', '13 MCP tools — AI reads directly, no copy-paste')}</li>
        </ul>
      </div>
    </div>
    <p class="capture-skill-note">${t('📘 以上所有功能的使用說明、故障排除、Q&A，都在 AI Skill 手冊裡。安裝後你的 AI 就會教你怎麼用。 <a href="/skill/download">下載 SKILL.md →</a>', '📘 Usage guides, troubleshooting & Q&A for all features above are in the AI Skill manual. Install it and your AI will teach you. <a href="/skill/download">Download SKILL.md →</a>')}</p>
  </section>

  <section class="wrap" id="frameworks">
    <h2>${t('支援所有 Web 開發框架', 'Works with All Web Frameworks')}</h2>
    <p class="sub">${t('只要你的產品跑在瀏覽器上，BugEzy 就能用', 'If your product runs in a browser, BugEzy works')}</p>
    <div class="framework-grid">
      <div class="fw-category">
        <h3>${t('🖥 前端框架（Chrome 擴充錄製）', '🖥 Frontend (Chrome extension recording)')}</h3>
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
        <h3>${t('⚙ 後端框架（終端機 CLI 攔截）', '⚙ Backend (terminal CLI capture)')}</h3>
        <div class="fw-tags">
          <span>Django</span>
          <span>Flask</span>
          <span>FastAPI</span>
          <span>Express</span>
          <span>Nest.js</span>
          <span>Laravel</span>
          <span>Rails</span>
          <span>Spring Boot</span>
          <span>Go</span>
          <span>Rust</span>
          <span>Node.js</span>
        </div>
      </div>
    </div>
    <p class="fw-note">${t('前端用 Chrome 擴充錄製 DOM + Console + Network<br>後端用 <code>npx bugezy-watch -- python manage.py runserver</code> 攔截 stderr', 'Frontend: Chrome extension records DOM + Console + Network<br>Backend: <code>npx bugezy-watch -- python manage.py runserver</code> captures stderr')}</p>

    <div class="ai-tools">
      <h3>${t('支援所有 MCP 工具', 'Works with All MCP Tools')}</h3>
      <div class="fw-tags">
        <span>Claude Desktop</span>
        <span>Claude Code</span>
        <span>Cursor</span>
        <span>Windsurf</span>
        <span>VS Code + Cline</span>
        <span>Google Antigravity</span>
        <span>Gemini CLI</span>
      </div>
      <p>${t('一行 URL 連接，零安裝', 'One URL to connect, zero install')}</p>
    </div>
  </section>

  <section class="wrap" id="skill">
    <div class="skill-box">
      <h2>${t('🤖 專屬 AI Skill — 讓 AI 當你的 24 小時客服', '🤖 AI Skill — Let AI Be Your 24/7 Support')}</h2>
      <p class="skill-lead">${t('安裝 BugEzy 的 AI Skill 後，你的 AI 就會：', "Install BugEzy's AI Skill, and your AI will:")}</p>
      <ul class="skill-list">
        <li>${t('• 教你怎麼錄製 Bug', '• Teach you how to record bugs')}</li>
        <li>${t('• 自動讀取報告並分析根因', '• Auto-read reports and analyze root causes')}</li>
        <li>${t('• 遇到問題時引導你排除故障', '• Guide you through troubleshooting')}</li>
        <li>${t('• 告訴你每個功能怎麼用', '• Explain every feature')}</li>
      </ul>
      <p class="skill-note">${t('不需要讀文件、不需要看教學影片——問你的 AI 就好。', 'No docs, no tutorials — just ask your AI.')}</p>
      <div class="skill-actions">
        <a class="skill-btn" href="/skill/download">${t('下載 SKILL.md →', 'Download SKILL.md →')}</a>
        <a class="skill-btn secondary" href="/skill">${t('了解更多 →', 'Learn more →')}</a>
      </div>
    </div>
  </section>

  <section class="wrap ai-install">
    <h2>${t('🤖 讓 AI 幫你安裝 BugEzy', '🤖 Let AI Install BugEzy for You')}</h2>
    <p class="ai-install-desc">${t('不懂技術？沒關係。把下面這段複製貼給你的 AI，它會幫你搞定一切。', 'Not technical? No problem. Copy the text below and paste it to your AI — it will handle everything.')}</p>
    <div class="ai-install-box">
      <pre id="ai-install-prompt" class="mcp-cfg">${aiPrompt}</pre>
      <button id="copy-ai-prompt" class="copy-btn" data-copy-text="${encodeURIComponent(aiPrompt)}">${t('📋 一鍵複製，貼給你的 AI', '📋 Copy & paste to your AI')}</button>
      <span id="copy-feedback" class="copy-feedback" style="display:none;">${t('✅ 已複製！', '✅ Copied!')}</span>
    </div>
    <p class="ai-install-tools">${t('支援', 'Supports')}：Claude Desktop · Claude Code · Cursor · Windsurf · VS Code + Cline · Google Antigravity · Gemini CLI</p>
  </section>

  <section class="wrap" id="pricing">
    <h2>${t('方案與定價', 'Plans & Pricing')}</h2>
    <p class="sub">${t('免費開始，需要更多再升級', 'Start free, upgrade when you need more')}</p>
    <div class="plans">
      <div class="plan">
        <div class="pname">${t('免費版', 'Free')}</div>
        <div class="price">NT$0</div>
        <ul>
          <li>${t('截圖標注 無限', 'Unlimited screenshot annotation')}</li>
          <li>${t('即時監控', 'Live monitor')}</li>
          <li>${t('鍵盤模式', 'Keyboard mode')}</li>
          <li>${t('錄製 月 10 次', 'Recording 10/mo')}</li>
          <li>${t('回溯 月 5 次', 'Rewind 5/mo')}</li>
          <li>${t('MCP AI 讀取 月 20 次', 'MCP AI reads 20/mo')}</li>
          <li>${t('報告保留 7 天', 'Reports kept 7 days')}</li>
        </ul>
        <a class="free-btn" href="/install">${t('免費安裝 →', 'Install free →')}</a>
      </div>
      <div class="plan day-pass">
        <div class="plan-badge">${t('⚡ 試試看', '⚡ Try it')}</div>
        <div class="pname day">${t('日票', 'Day Pass')}</div>
        <div class="price">NT$20<small> /24hr</small></div>
        <ul>
          <li>${t('全功能無限', 'All features unlimited')}</li>
          <li>${t('錄製無限', 'Unlimited recording')}</li>
          <li>${t('MCP AI 讀取無限', 'Unlimited MCP AI reads')}</li>
          <li>${t('Whisper 精準語音', 'Whisper precise voice')}</li>
          <li>${t('信用卡 / ATM / 超商', 'Credit card / ATM / store')}</li>
        </ul>
        <p class="pricing-hint">${t('24 小時內享所有付費功能', 'All premium features for 24 hours')}</p>
        <a class="day-btn" href="/install">${isTaiwan ? t('安裝後購買 →', 'Buy after install →') : t('免費安裝 →', 'Install Free →')}</a>
      </div>
      <div class="plan featured">
        <div class="plan-badge">${t('✨ 最划算', '✨ Best value')}</div>
        <div class="pname">${t('付費版', 'Premium')}</div>
        <div class="price">NT$80<small>${t(' /月', ' /mo')}</small></div>
        <ul>
          <li>${t('全功能無限', 'All features unlimited')}</li>
          <li>${t('錄製無限', 'Unlimited recording')}</li>
          <li>${t('MCP AI 讀取無限', 'Unlimited MCP AI reads')}</li>
          <li>${t('終端機 CLI', 'Terminal CLI')}</li>
          <li>${t('Whisper 精準語音', 'Whisper precise voice')}</li>
          <li>${t('報告保留 90 天', 'Reports kept 90 days')}</li>
          <li>${t('團隊協作（即將推出）', 'Team collaboration (coming soon)')}</li>
        </ul>
        <p class="pricing-hint">${isTaiwan ? t('安裝 Chrome 擴充後，在工具中一鍵升級付費', 'Install the Chrome extension, then upgrade in one click') : t('🌏 國際付款即將開放，免費版現在就能用！', '🌏 International payments coming soon. Free plan available now!')}</p>
        <a class="plan-cta" href="/install">${isTaiwan ? t('安裝後即可升級 →', 'Upgrade after install →') : t('免費安裝 →', 'Install Free →')}</a>
      </div>
    </div>
  </section>

  <footer>
    <div class="contact-info">
      <h3>${t('聯絡我們', 'Contact Us')}</h3>
      <p>📧 Email：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></p>
      <p>📱 ${t('電話', 'Phone')}：<a href="tel:+886983101085">0983-101-085</a></p>
      <p>${t('服務時間：週一至週五 09:00-18:00', 'Hours: Mon–Fri 09:00–18:00 (UTC+8)')}</p>
    </div>
    <div style="margin-top:8px;"><a href="/install">${t('安裝指南', 'Install')}</a> | <a href="/features">${t('功能說明', 'Features')}</a> | <a href="/guide">${t('使用指南', 'Guide')}</a> | <a href="/faq">${t('常見問題', 'FAQ')}</a> | <a href="/privacy">${t('隱私政策', 'Privacy')}</a> | <a href="/changelog">${t('更新日誌', 'Changelog')}</a> | <a href="/skill">${t('🤖 AI 客服手冊', '🤖 AI Manual')}</a> | <a href="/feedback">${t('📬 問題回報', '📬 Feedback')}</a> | <a href="/reports">${t('📋 我的報告', '📋 My Reports')}</a></div>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy · ${t('亞洲平價 MCP 語音除錯工具', 'Affordable MCP voice debugging for Asia')}</div>
  </footer>
  <script>
    // PM-192（三修）：複製優先從 btn.dataset.copyText（decodeURIComponent）讀，不依賴 DOM textContent，
    //   徹底解「貼出空白」。clipboard 失敗 → 視窗內 1px textarea + execCommand fallback；按鈕變「✅ 已複製！」2s 恢復。
    (function () {
      var btn = document.getElementById('copy-ai-prompt');
      if (!btn) return;
      var originalLabel = btn.textContent;
      var DONE_LABEL = ${JSON.stringify(t('✅ 已複製！', '✅ Copied!'))};
      function getText() {
        var d = btn.dataset ? btn.dataset.copyText : null;
        if (d) { try { return decodeURIComponent(d); } catch (e) {} }
        var el = document.getElementById('ai-install-prompt');
        return el ? (el.textContent || '') : '';
      }
      function flashDone() {
        btn.textContent = DONE_LABEL;
        btn.classList.add('copied');
        setTimeout(function () { btn.textContent = originalLabel; btn.classList.remove('copied'); }, 2000);
      }
      function fallbackCopy(text) {
        try {
          var ta = document.createElement('textarea');
          ta.value = text; ta.setAttribute('readonly', '');
          ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.left = '0';
          ta.style.width = '1px'; ta.style.height = '1px'; ta.style.padding = '0';
          ta.style.border = 'none'; ta.style.outline = 'none'; ta.style.boxShadow = 'none'; ta.style.background = 'transparent';
          document.body.appendChild(ta); ta.focus(); ta.select();
          try { ta.setSelectionRange(0, text.length); } catch (e2) {}
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          console.log('[BugEzy] home fallback execCommand copy ok=' + ok);
          if (ok) flashDone();
          return ok;
        } catch (e) { console.warn('[BugEzy] home fallback copy failed', e); return false; }
      }
      btn.addEventListener('click', function () {
        var text = getText();
        console.log('[BugEzy] home copy length=' + text.length);
        if (!text) { console.warn('[BugEzy] home copy empty'); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            function () { console.log('[BugEzy] home clipboard.writeText OK'); flashDone(); },
            function (err) { console.warn('[BugEzy] home clipboard failed → fallback', err); fallbackCopy(text); },
          );
        } else { fallbackCopy(text); }
      });
    })();
  </script>
</body>
</html>`;
}

// ── PM-64：隱私政策頁（Chrome Web Store 上架 + 綠界審核要求可訪問的隱私政策 URL）──
// 中英雙語，深色主題與首頁/報告頁統一（#0f0f1a / #7c3aed / #a78bfa），一頁式無 JS、RWD。
// PM-152：/privacy 改為函式（依 lang 只顯示對應語言區塊；原本中英雙語堆疊 → 改語言切換）。
function privacyPage(lang: PageLang): string {
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-Hant' : 'en'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('隱私政策 · BugEzy', 'Privacy Policy · BugEzy')}</title>
<meta name="description" content="${t('BugEzy 隱私政策：我們收集什麼資料、如何使用與保護。', 'BugEzy privacy policy — what data we collect, how we use it, and how we protect your information.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/privacy">
${ogMeta('/privacy', 'Privacy Policy — BugEzy', 'How BugEzy handles your data.')}
<style>
  * { box-sizing: border-box; }
  .lang-switch { position:fixed; top:14px; right:16px; z-index:10; background:#1a1a2e; border:1px solid #7c3aed; border-radius:8px; padding:5px 12px; font-size:13px; color:#c4b5fd; text-decoration:none; }
  .lang-switch:hover { background:#2a2a3e; }
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
<a class="lang-switch" href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t('EN', '中文')}</a>
<div class="wrap">
  <header>
    <a class="brand" href="/">🐛 BugEzy</a>
  </header>
${t(
    `
  <h1>隱私政策</h1>
  <div class="updated">最後更新：2026 年 6 月 25 日</div>

  <h2>1. 我們收集什麼資料</h2>
  <ul>
    <li>Google 帳號資訊（email、姓名、頭像）用於登入</li>
    <li>Bug 報告內容（Console logs、Network errors、DOM 快照、語音記錄、截圖）</li>
    <li>使用量統計（MCP AI 讀取次數、Token 估算）</li>
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
    <li>報告列表僅限您本人查看（需登入驗證）；單份報告可透過報告連結查看——持有連結者即可存取，類似 Google Docs「知道連結的人皆可檢視」模式，故請謹慎分享、避免在公開場合張貼</li>
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

  <p>聯絡方式：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></p>`,
    `
  <h1>Privacy Policy</h1>
  <div class="updated">Last updated: June 25, 2026</div>

  <h2>1. What We Collect</h2>
  <ul>
    <li>Google account info (email, name, avatar) for sign-in</li>
    <li>Bug report contents (console logs, network errors, DOM snapshots, voice notes, screenshots)</li>
    <li>Usage statistics (MCP AI read counts, token estimates)</li>
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
    <li>Your report list is private (login required); individual report content can be accessed via the report link — anyone with the link can view it, similar to Google Docs' "anyone with the link can view" model, so share report links carefully and avoid posting them publicly</li>
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

  <p>Contact: <a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></p>`,
  )}

  <footer>
    <a href="/">${t('首頁', 'Home')}</a>
    <a href="/install">${t('安裝指南', 'Install')}</a>
    <a href="/features">${t('功能說明', 'Features')}</a>
    <a href="/guide">${t('使用指南', 'Guide')}</a>
    <a href="/faq">FAQ</a>
    <a href="/changelog">${t('更新日誌', 'Changelog')}</a>
    <a href="/skill">${t('🤖 AI 客服手冊', '🤖 AI Manual')}</a>
    <a href="/feedback">${t('📬 問題回報', '📬 Feedback')}</a>
    <a href="/reports">${t('📋 我的報告', '📋 My Reports')}</a>
    <a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy</div>
  </footer>
</div>
</body>
</html>`;
}

// ── PM-66：操作說明頁（新手三步上手 + 六種模式 + MCP 設定 + 小技巧）──
// 深色主題與首頁/隱私頁統一（#0f0f1a / #7c3aed / #a78bfa），一頁式無 JS、RWD、繁中。
// PM-152：/guide 改為函式（依 lang 中英切換）。
// ── PM-201：AI 客服手冊（SKILL.md）── 給 AI 讀的使用手冊，/skill 檢視 + /skill/download 下載。
// 內容須與專案根目錄 SKILL.md 保持一致（Worker 無檔案系統，故內嵌為字串）。
const SKILL_MD = `# BugEzy — AI 除錯工具使用指南

> 這份文件是給 AI 讀的。當使用者問你關於 BugEzy 的任何問題，請根據以下內容回答。

## 什麼是 BugEzy

BugEzy 是一個 Chrome 擴充工具 + MCP server，讓開發者用語音 + 一鍵錄製 Bug，AI 透過 MCP 直接讀取報告並修復。

- 官網：https://bugezy.dev
- Chrome Web Store：https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj
- 安裝教學：https://bugezy.dev/install
- 功能說明：https://bugezy.dev/features
- FAQ：https://bugezy.dev/faq
- 隱私政策：https://bugezy.dev/privacy
- 問題回報：https://bugezy.dev/feedback

## 如何讀取使用者的 Bug 報告

### 方法 1：使用者說「讀我最新報告」
1. 呼叫 MCP tool \`list_reports\`（需要 user_email + session_token）
2. 取得最新的 report_id
3. 呼叫 \`get_timeline\`（report_id）→ 取得完整時間軸 + AI 導航摘要
4. 根據摘要的根因分析，定位程式碼 → 提出修復方案

### 方法 2：使用者貼報告連結
使用者貼 \`https://bugezy.dev/report/xxx-xxx\` 給你時：
1. 從 URL 取得 report_id
2. 呼叫 \`get_timeline\`（report_id）→ 同上

### MCP 工具清單（13 個）
| Tool | 用途 |
|---|---|
| \`list_reports\` | 列出使用者的報告（需 session_token） |
| \`get_report_overview\` | 報告概覽 + AI Bug 導航摘要 |
| \`get_timeline\` | ⭐ 最推薦 — 完整時間軸（Console + Network + 語音 + 環境，一次看完） |
| \`get_console_logs\` | Console error/warn 記錄 |
| \`get_network_errors\` | Network 4xx/5xx 失敗 |
| \`get_screenshots\` | 截圖（高 Token，謹慎使用） |
| \`get_rrweb_events\` | DOM 錄影事件（高 Token，謹慎使用） |
| \`get_rrweb_summary\` | DOM 摘要（輕量） |
| \`get_voice_transcript\` | 語音轉錄文字 |
| \`get_metadata\` | 報告 metadata |
| \`get_live_errors\` | 即時監控錯誤（需 session_token） |
| \`get_terminal_logs\` | Terminal CLI 錯誤（需 session_token，付費功能） |
| \`get_usage_stats\` | Token 用量統計 |

### 建議的讀取順序
1. 先呼叫 \`get_timeline\` — 一次拿到 AI 導航摘要 + 完整時間軸（最省 Token）
2. 如果需要更多細節，再呼叫 \`get_console_logs\` 或 \`get_network_errors\`
3. 截圖和 DOM 錄影 Token 消耗高，最後再用

## 如何教使用者錄製 Bug

當使用者說「程式壞了」但沒有報告時，教他：

1. 點 Chrome 右上角 BugEzy 圖示（紫色 B）
2. 按「🎬 錄製」按鈕
3. 操作壞掉的步驟（BugEzy 會自動捕捉 Console 錯誤、Network 失敗、DOM 變化）
4. 邊操作邊用語音描述問題（可選）
5. 按「⏹ 停止」
6. 在編輯頁補充說明（可選）→ 按「上傳」
7. 跟你說「讀我最新報告」

### 六種錄製模式
| 模式 | 適合場景 |
|---|---|
| 🎬 錄製 | 操作流程中的 Bug |
| ⏪ 回溯 30s | Bug 已經發生了，回溯最近 30 秒 |
| 📸 截圖標注 | 畫面問題（UI 破版、樣式錯誤） |
| 🟢 即時監控 | 背景持續監控，有錯誤時通知 |
| 🐍 Terminal CLI | Python/Node.js 後端錯誤 |
| 🤖 MCP AI 讀取 | AI 直接透過 MCP 讀取報告 |

## 故障排除

### AI 無法讀取報告（MCP 連線問題）
**症狀**：呼叫 \`list_reports\` 回傳「請提供 session_token」

**解法**：
1. 告訴使用者：「請打開 BugEzy popup → 進階設定 → 📋 複製 MCP 設定 → 貼給我」
2. 使用者會貼一段 JSON，裡面有帶 token 的 MCP URL
3. 用這個 URL 重新設定 MCP 連線

### 麥克風無法開啟
**症狀**：錄製時音量條不跳動

**解法**：
1. 確認瀏覽器有授權麥克風（網址列左邊的 🔒 圖示 → 麥克風 → 允許）
2. 如果使用精準轉錄模式，需要選「**允許這個網站使用**」而不是「允許這次使用」
3. 如果還是不行，切換到「即時字幕」模式（popup 進階設定）

### 語音沒有文字
**症狀**：錄製時音量條有跳動，但停止後沒有文字

**解法**：
1. 確認網路連線正常（精準轉錄需要上傳音訊到 server）
2. 確認是付費用戶（精準轉錄 Whisper 是付費功能）
3. 免費用戶可用「即時字幕」模式（Web Speech API，不需上傳）

### 免費額度用完
**症狀**：按錄製彈出「本月額度已用完」

**解法**：
- 免費版每月限制：錄製 10 次 / 回溯 5 次 / AI 讀取 20 次 / 截圖無限
- 額度每月自動重置
- 升級方式：日票 NT$20（24 小時無限）或月費 NT$80/月
- 在 popup 按「⚡ 日票」或「✨ 月費」升級
- 目前只支援台灣付款（信用卡/ATM/超商），國際付款即將開放

### 截圖有敏感資料
**症狀**：截圖可能拍到密碼、API Key

**說明**：
- BugEzy 會自動偵測頁面上的密碼欄位，截圖後自動馬賽克
- 使用者也可以用 🔒 馬賽克筆刷手動塗掉敏感區域
- localStorage/sessionStorage 的敏感值（token、password、API key）會在使用者端自動遮罩，server 永遠不碰原值

### Terminal CLI 使用
**適用**：Python / Node.js / Go 後端錯誤

\`\`\`bash
BUGEZY_TOKEN=<token> npx bugezy-watch -- python manage.py runserver
BUGEZY_TOKEN=<token> npx bugezy-watch -- node server.js
\`\`\`

- Token 從 popup 進階設定的「📋 複製 MCP 設定」取得
- 終端機 CLI 是付費功能
- AI 用 \`get_terminal_logs\` 讀取，會拿到結構化的 Python traceback + 環境快照 + 白話錯誤解釋

## BugEzy 能捕捉什麼

### 前端（Chrome 擴充自動捕捉）
- JS 執行錯誤（TypeError / ReferenceError / SyntaxError）
- Promise 靜默失敗（未捕捉的 async/await 錯誤）
- Console 警告（CORS / Mixed Content / Deprecated API）
- Network 失敗（API 4xx/5xx / timeout / CORS blocked）
- 資源載入失敗（圖片/CSS/JS/字型 404）
- Web Vitals 效能（LCP / CLS / FID 超標警告）
- 網路環境快照（WiFi/4G/離線/延遲/頻寬）
- 儲存空間快照（localStorage / sessionStorage / Cookie，敏感值自動遮罩）
- DOM 變化（rrweb 全紀錄）
- 語音描述（Whisper 精準轉錄 / Web Speech 即時字幕）
- 截圖標注（全頁/區域/自由形狀 + 馬賽克筆刷）

### 後端（Terminal CLI）
- Python traceback / exception（結構化解析：type/message/file/line）
- Node.js uncaughtException / unhandledRejection
- 任何語言的 stderr / crash log
- 環境快照（Python 版本 + pip list / Node 版本 + npm list）
- 敏感資料自動遮罩（DB URI / API Key / JWT / 密碼）

### 支援框架
前端：React · Vue · Angular · Next.js · Nuxt · Svelte · 任何 Web 應用
後端：Django · Flask · FastAPI · Express · Nest.js · 任何語言

## 定價
| 方案 | 價格 | 內容 |
|---|---|---|
| 免費版 | NT$0 | 錄製 10 次/月 · 回溯 5 次/月 · AI 讀取 20 次/月 · 截圖無限 · 報告保留 7 天 |
| 日票 | NT$20 | 24 小時無限 · Whisper 精準轉錄 · 報告保留 90 天 |
| 月費 | NT$80/月 | 全部無限 · Whisper · Terminal CLI · 報告保留 90 天 |

目前只支援台灣付款。國際付款即將開放。
`;

// PM-201：極簡 Markdown → HTML（僅涵蓋 SKILL.md 用到的語法：標題/表格/清單/引言/程式碼區塊/粗體/行內碼/連結/分隔線）。
function skillEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function skillInline(s: string): string {
  let h = skillEsc(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return h;
}
function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  const N = lines.length;
  const special = /^(#{1,6})\s|^```|^\||^>\s?|^---+\s*$|^\s*[-*]\s+|^\s*\d+\.\s+/;
  while (i < N) {
    const line = lines[i];
    if (/^```/.test(line)) {
      i++;
      const code: string[] = [];
      while (i < N && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // 跳過結尾 fence
      out.push('<pre class="md-code"><code>' + skillEsc(code.join('\n')) + '</code></pre>');
      continue;
    }
    if (/^\|/.test(line) && i + 1 < N && /^\|[\s:\-|]+\|?\s*$/.test(lines[i + 1])) {
      const header = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < N && /^\|/.test(lines[i])) { rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim())); i++; }
      const th = '<tr>' + header.map((c) => '<th>' + skillInline(c) + '</th>').join('') + '</tr>';
      const tb = rows.map((r) => '<tr>' + r.map((c) => '<td>' + skillInline(c) + '</td>').join('') + '</tr>').join('');
      out.push('<table class="md-table"><thead>' + th + '</thead><tbody>' + tb + '</tbody></table>');
      continue;
    }
    const hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) { const lvl = hm[1].length; out.push('<h' + lvl + '>' + skillInline(hm[2]) + '</h' + lvl + '>'); i++; continue; }
    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) {
      const bq: string[] = [];
      while (i < N && /^>\s?/.test(lines[i])) { bq.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push('<blockquote>' + skillInline(bq.join(' ')) + '</blockquote>');
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < N && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
      out.push('<ul>' + items.map((it) => '<li>' + skillInline(it) + '</li>').join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < N && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
      out.push('<ol>' + items.map((it) => '<li>' + skillInline(it) + '</li>').join('') + '</ol>');
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    const para: string[] = [];
    while (i < N && !/^\s*$/.test(lines[i]) && !special.test(lines[i])) { para.push(lines[i]); i++; }
    out.push('<p>' + skillInline(para.join(' ')) + '</p>');
  }
  return out.join('\n');
}

// PM-201：/skill AI 客服手冊檢視頁（渲染 SKILL.md + 一鍵複製 + 下載 + Claude Desktop 安裝步驟）。
function skillPage(lang: PageLang): string {
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  const bodyHtml = renderMarkdown(SKILL_MD);
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-Hant' : 'en'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('🤖 AI 客服手冊 · BugEzy', '🤖 AI Support Manual · BugEzy')}</title>
<meta name="description" content="${t('把 BugEzy AI 客服手冊放進你的專案，AI 就會教你怎麼用 BugEzy、幫你讀報告、排除故障。', 'Add the BugEzy AI support manual to your project and your AI will teach you how to use BugEzy, read reports, and troubleshoot.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/skill">
${ogMeta('/skill', 'AI Customer Service Guide — BugEzy SKILL.md', 'BugEzy MCP tool documentation for AI assistants. 13 tools including get_timeline.')}
<style>
  * { box-sizing: border-box; }
  .lang-switch { position:fixed; top:14px; right:16px; z-index:10; background:#1a1a2e; border:1px solid #7c3aed; border-radius:8px; padding:5px 12px; font-size:13px; color:#c4b5fd; text-decoration:none; }
  .lang-switch:hover { background:#2a2a3e; }
  body { margin:0; padding:0; background:#0f0f1a; color:#e8e8f0; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", sans-serif; line-height:1.75; font-size:15px; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 48px 24px 80px; }
  header { border-bottom: 1px solid #2a2a3e; padding-bottom: 20px; margin-bottom: 24px; }
  .brand { font-size: 24px; font-weight: 700; color: #a78bfa; text-decoration: none; }
  h1 { font-size: 28px; margin: 16px 0 6px; }
  .lead { color: #8b8fa3; font-size: 15px; margin: 0 0 4px; }
  .actions { display:flex; gap:10px; flex-wrap:wrap; margin: 20px 0 8px; }
  .btn { display:inline-block; background:#7c3aed; color:#fff; border:none; border-radius:8px; padding:10px 18px; font-size:14px; font-weight:600; cursor:pointer; text-decoration:none; transition: transform .1s, opacity .1s, background .2s; }
  .btn:active { transform: scale(0.97); opacity:0.85; }
  .btn.copied { background:#238636; }
  .btn.secondary { background:transparent; border:1px solid #7c3aed; color:#c4b5fd; }
  .install-box { margin: 22px 0 8px; padding: 16px 18px; background:#15152a; border:1px solid #7c3aed; border-radius:12px; font-size:14px; }
  .install-box h3 { margin:0 0 8px; font-size:15px; color:#c4b5fd; }
  .install-box ol { margin:0; padding-left:20px; }
  .install-box li { margin:5px 0; }
  .install-box code { background:#0f0f1a; color:#7ee0c5; padding:2px 6px; border-radius:5px; font-family: ui-monospace, monospace; font-size:13px; }
  .md { margin-top: 28px; padding: 26px 28px; background:#1a1a2e; border:1px solid #2a2a3e; border-radius:14px; }
  .md h1 { font-size:24px; margin: 22px 0 8px; color:#fff; }
  .md h2 { font-size:20px; margin: 26px 0 8px; color:#c4b5fd; border-top:1px solid #2a2a3e; padding-top:18px; }
  .md h3 { font-size:16px; margin: 18px 0 6px; color:#a78bfa; }
  .md p { margin: 8px 0; }
  .md ul, .md ol { margin: 8px 0; padding-left: 22px; }
  .md li { margin: 4px 0; }
  .md blockquote { margin: 10px 0; padding: 8px 14px; border-left:3px solid #7c3aed; background:#15152a; color:#b9b9cf; border-radius:0 8px 8px 0; }
  .md hr { border:none; border-top:1px solid #2a2a3e; margin: 20px 0; }
  .md code { background:#0f0f1a; color:#7ee0c5; padding:1px 6px; border-radius:5px; font-family: ui-monospace, monospace; font-size:13px; word-break: break-word; }
  .md-code { margin: 10px 0; padding: 12px 14px; background:#0f0f1a; border:1px solid #2a2a3e; border-radius:8px; overflow-x:auto; }
  .md-code code { background:transparent; padding:0; color:#7ee0c5; }
  .md-table { width:100%; border-collapse: collapse; margin: 12px 0; font-size:14px; }
  .md-table th, .md-table td { border:1px solid #2a2a3e; padding:8px 10px; text-align:left; vertical-align: top; }
  .md-table th { background:#15152a; color:#c4b5fd; }
  a { color: #a78bfa; }
  footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid #2a2a3e; color: #8b8fa3; font-size: 13px; }
  footer .links a { margin-right: 16px; }
</style>
</head>
<body>
<a class="lang-switch" href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t('EN', '中文')}</a>
<div class="wrap">
  <header><a class="brand" href="/">🐛 BugEzy</a></header>

  <h1>${t('🤖 BugEzy AI 客服手冊', '🤖 BugEzy AI Support Manual')}</h1>
  <p class="lead">${t('把這份文件放到你的專案裡，AI 就會教你怎麼用 BugEzy——讀報告、排除故障、通通自己搞定。', 'Drop this file into your project and your AI will teach you how to use BugEzy — reading reports, troubleshooting, all on its own.')}</p>
  <p class="lead">${t('等於讓你的 AI 當 24 小時 BugEzy 客服。', 'It turns your AI into a 24/7 BugEzy support agent.')}</p>

  <div class="actions">
    <button id="copySkill" class="btn" type="button" data-copy-text="${encodeURIComponent(SKILL_MD)}">${t('📋 複製全文', '📋 Copy all')}</button>
    <a class="btn secondary" href="/skill/download">${t('⬇️ 下載 SKILL.md', '⬇️ Download SKILL.md')}</a>
  </div>

  <div class="install-box">
    <h3>${t('📥 怎麼裝到你的 AI', '📥 How to install into your AI')}</h3>
    <ol>
      <li>${t('<b>Claude Desktop</b>：Settings（設定）→ Skills → Add（新增）→ 貼上或上傳 SKILL.md', '<b>Claude Desktop</b>: Settings → Skills → Add → paste or upload SKILL.md')}</li>
      <li>${t('<b>Claude Code</b>：把檔案放到 <code>/mnt/skills/user/bugezy/SKILL.md</code>', '<b>Claude Code</b>: place the file at <code>/mnt/skills/user/bugezy/SKILL.md</code>')}</li>
      <li>${t('<b>Cursor / VS Code / 其他 AI</b>：把 SKILL.md 放到專案根目錄，或直接複製全文貼給 AI', '<b>Cursor / VS Code / other AIs</b>: put SKILL.md in your project root, or just paste the full text to your AI')}</li>
    </ol>
    <p style="margin:10px 0 0;color:#8b8fa3;">${t('裝好之後，直接問 AI：「怎麼用 BugEzy？」或「幫我讀最新的 BugEzy 報告」。', 'Once installed, just ask your AI: "How do I use BugEzy?" or "Read my latest BugEzy report."')}</p>
  </div>

  <div class="md">${bodyHtml}</div>

  <footer>
    <div class="links">
      <a href="/">${t('首頁', 'Home')}</a>
      <a href="/install">${t('安裝指南', 'Install')}</a>
      <a href="/features">${t('功能說明', 'Features')}</a>
      <a href="/guide">${t('使用指南', 'Guide')}</a>
      <a href="/faq">FAQ</a>
      <a href="/skill">${t('🤖 AI 客服手冊', '🤖 AI Manual')}</a>
      <a href="/skill">${t('🤖 AI 客服手冊', '🤖 AI Manual')}</a>
    <a href="/feedback">${t('📬 問題回報', '📬 Feedback')}</a>
    </div>
    <div style="margin-top:8px;">${t('聯絡', 'Contact')}：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></div>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy</div>
  </footer>
</div>
<script>
(function () {
  var btn = document.getElementById('copySkill');
  if (!btn) return;
  var DONE = ${JSON.stringify(t('✅ 已複製！', '✅ Copied!'))};
  var LABEL = ${JSON.stringify(t('📋 複製全文', '📋 Copy all'))};
  function getText() { try { return decodeURIComponent(btn.dataset.copyText || ''); } catch (e) { return btn.dataset.copyText || ''; } }
  function flash() { btn.textContent = DONE; btn.classList.add('copied'); setTimeout(function () { btn.textContent = LABEL; btn.classList.remove('copied'); }, 2000); }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;background:transparent;';
    document.body.appendChild(ta);
    ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }
  btn.addEventListener('click', function () {
    var text = getText();
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash, function () { fallbackCopy(text); flash(); });
    } else { fallbackCopy(text); flash(); }
  });
})();
</script>
</body>
</html>`;
}

function guidePage(lang: PageLang): string {
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-Hant' : 'en'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('使用指南 · BugEzy', 'User Guide · BugEzy')}</title>
<meta name="description" content="${t('BugEzy 使用指南：安裝登入、六種錄製模式、編輯上傳、讓 AI 透過 MCP 讀報告修 Bug。', 'Learn how to use BugEzy to record bugs, annotate screenshots, and connect with AI via MCP.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/guide">
${ogMeta('/guide', 'User Guide — BugEzy', 'Step-by-step guide to using BugEzy for bug reporting.')}
<style>
  * { box-sizing: border-box; }
  .lang-switch { position:fixed; top:14px; right:16px; z-index:10; background:#1a1a2e; border:1px solid #7c3aed; border-radius:8px; padding:5px 12px; font-size:13px; color:#c4b5fd; text-decoration:none; }
  .lang-switch:hover { background:#2a2a3e; }
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
<a class="lang-switch" href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t('EN', '中文')}</a>
<div class="wrap">
  <header><a class="brand" href="/">🐛 BugEzy</a></header>

  <h1>${t('🐛 BugEzy 使用指南', '🐛 BugEzy User Guide')}</h1>
  <p class="lead">${t('讓 AI 幫你修 Bug，只需三步。', 'Let AI fix your bugs in just three steps.')}</p>
  <div class="mcp-box" style="border-color:#2a2a3e;">${t('詳細安裝流程 → <a href="/install">安裝指南</a>　·　完整功能說明 → <a href="/features">功能說明</a>', 'Full install steps → <a href="/install">Install Guide</a>　·　All features → <a href="/features">Features</a>')}</div>

  <div class="step">
    <h2>${t('🚀 第一步：安裝與登入', '🚀 Step 1: Install & Sign in')}</h2>
    <ol>
      <li>${t('從 Chrome Web Store 安裝 BugEzy 擴充功能', 'Install the BugEzy extension from the Chrome Web Store')}</li>
      <li>${t('點擊右上角 BugEzy 圖示 🐛', 'Click the BugEzy icon 🐛 at the top right')}</li>
      <li>${t('按「用 Google 登入」→ 完成', 'Click "Sign in with Google" → done')}</li>
    </ol>
  </div>

  <div class="step">
    <h2>${t('🎯 第二步：錄下 Bug（六種模式任選）', '🎯 Step 2: Capture the bug (choose from six modes)')}</h2>

    <div class="mode">
      <div class="mname">${t('🎬 錄製', '🎬 Record')}</div>
      <div class="mrow"><b>${t('適合：', 'Best for: ')}</b>${t('完整重現 Bug 過程', 'Fully reproducing the bug')}</div>
      <div class="mrow"><b>${t('用法：', 'How: ')}</b>${t('按「錄製」→ 操作網頁重現 Bug → 語音描述問題 → 按「停止」', 'Click "Record" → reproduce on the page → describe by voice → click "Stop"')}</div>
      <div class="mrow"><b>${t('錄到：', 'Captures: ')}</b>${t('DOM 變化 + Console + Network + 語音', 'DOM changes + Console + Network + voice')}</div>
    </div>

    <div class="mode">
      <div class="mname">${t('⏪ 30 秒回溯', '⏪ Rewind 30s')}</div>
      <div class="mrow"><b>${t('適合：', 'Best for: ')}</b>${t('Bug 已經發生，來不及錄', 'The bug already happened, too late to record')}</div>
      <div class="mrow"><b>${t('用法：', 'How: ')}</b>${t('按「回溯 30s」→ 自動抓回最近 30 秒的操作', 'Click "Rewind 30s" → auto-grabs the last 30 seconds')}</div>
      <div class="mrow">${t('不用提前按錄製，BugEzy 在背景持續記錄', 'No need to start early — BugEzy records in the background')}</div>
    </div>

    <div class="mode">
      <div class="mname">${t('📸 截圖標注', '📸 Screenshot Annotate')}</div>
      <div class="mrow"><b>${t('適合：', 'Best for: ')}</b>${t('快速指出畫面問題', 'Quickly pointing out an on-screen issue')}</div>
      <div class="mrow"><b>${t('用法：', 'How: ')}</b>${t('按「截圖標注」→ 畫筆/箭頭/框框標出問題 → 加文字說明', 'Click "Screenshot" → pen/arrow/box to mark → add a note')}</div>
      <div class="mrow"><b>${t('三種模式：', 'Three modes: ')}</b>${t('整頁截圖 / 可見範圍 / 自選區域', 'Full page / visible area / custom region')}</div>
    </div>

    <div class="mode">
      <div class="mname">${t('🔇 鍵盤模式', '🔇 Keyboard Mode')}</div>
      <div class="mrow"><b>${t('適合：', 'Best for: ')}</b>${t('吵雜環境（咖啡廳、辦公室）', 'Noisy environments (cafés, offices)')}</div>
      <div class="mrow"><b>${t('用法：', 'How: ')}</b>${t('開啟鍵盤模式 → 關閉語音辨識 → 用文字描述 Bug', 'Enable keyboard mode → voice off → type the description')}</div>
    </div>

    <div class="mode">
      <div class="mname">${t('🔍 即時監控', '🔍 Live Monitor')}</div>
      <div class="mrow"><b>${t('適合：', 'Best for: ')}</b>${t('掛著等 Bug 自己出現', 'Leaving it on to catch bugs as they appear')}</div>
      <div class="mrow"><b>${t('用法：', 'How: ')}</b>${t('開啟即時監控 → 頁面右下角出現 🐛 badge → 有 error 自動變紅 + 顯示數字', 'Enable live monitor → a 🐛 badge appears bottom-right → turns red with a count on errors')}</div>
      <div class="mrow">${t('點 badge 展開 error 清單', 'Click the badge to expand the error list')}</div>
    </div>

    <div class="mode">
      <div class="mname">${t('🖥 終端機', '🖥 Terminal')}</div>
      <div class="mrow"><b>${t('適合：', 'Best for: ')}</b>${t('Server 端的錯誤（Node.js、Python 等）', 'Server-side errors (Node.js, Python, etc.)')}</div>
      <div class="mrow"><b>${t('用法：', 'How: ')}</b>${t('終端機輸入', 'Run in the terminal')} <code style="color:#7ee0c5;">npx bugezy-watch -- npm run dev</code></div>
      <div class="mrow">${t('自動攔截 stderr / throw / crash', 'Auto-captures stderr / throw / crash')}</div>
    </div>
  </div>

  <div class="step">
    <h2>${t('📝 第三步：編輯與上傳', '📝 Step 3: Edit & upload')}</h2>
    <ol>
      <li>${t('錄製停止後進入編輯頁', 'The editor opens after you stop recording')}</li>
      <li>${t('可以編輯語音文字、加補充說明', 'Edit the voice text and add extra notes')}</li>
      <li>${t('按「🔧 AI 校正」修正錯字（選用）', 'Click "🔧 AI Correct" to fix typos (optional)')}</li>
      <li>${t('按「🤖 AI 精簡」濃縮重點（選用）', 'Click "🤖 AI Summarize" to condense (optional)')}</li>
      <li>${t('按「上傳」→ 報告自動儲存到雲端', 'Click "Upload" → the report is saved to the cloud')}</li>
    </ol>
  </div>

  <div class="step">
    <h2>${t('🤖 第四步：讓 AI 幫你修', '🤖 Step 4: Let AI fix it')}</h2>
    <p><b style="color:#c4b5fd;">${t('方法一：在 Claude / Cursor / VS Code 直接問', 'Option 1: Ask directly in Claude / Cursor / VS Code')}</b><br />
      ${t('「讀我最新的 BugEzy 報告，告訴我怎麼修」', '"Read my latest BugEzy report and tell me how to fix it"')}<br />
      ${t('AI 透過 MCP 自動讀取報告 → 分析 Console error + Network error → 給出修復建議', 'AI reads the report via MCP → analyzes Console + Network errors → suggests a fix')}</p>
    <p style="margin-top:12px;"><b style="color:#c4b5fd;">${t('方法二：分享報告連結', 'Option 2: Share the report link')}</b><br />
      ${t('上傳後會產生報告連結，傳給同事或貼到 Issue', 'Uploading generates a link — send it to teammates or paste into an issue')}</p>
    <div class="mcp-box">
      <b>${t('🔌 MCP 連接設定', '🔌 MCP connection setup')}</b><br />
      ${t('BugEzy MCP 網址（所有工具通用）：', 'BugEzy MCP URL (same for all tools):')}<br />
      <code>https://bugezy.dev/mcp</code>
      <div class="mcp-warn">${t('⚠ 注意：這個網址<b>不能用瀏覽器開</b>，它是專給 AI 工具連接的協議。用瀏覽器開只會看到一段錯誤訊息，屬正常現象——請依下方步驟在 AI 工具裡設定。', '⚠ Note: <b>do not open this URL in a browser</b> — it is a protocol endpoint for AI tools. Opening it in a browser just shows an error, which is normal. Set it up in your AI tool per the steps below.')}</div>

      <div class="mcp-tool"><div class="tname">Claude.ai</div><div class="tstep">${t('Settings → Connectors → Add → 貼上網址 → 連接', 'Settings → Connectors → Add → paste the URL → Connect')}</div></div>
      <div class="mcp-tool"><div class="tname">Claude Desktop</div><div class="tstep">${t('編輯 claude_desktop_config.json，加入：', 'Edit claude_desktop_config.json, add:')}</div><pre>{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}</pre></div>
      <div class="mcp-tool"><div class="tname">Cursor</div><div class="tstep">${t('Settings → MCP → Add Server → 貼上網址', 'Settings → MCP → Add Server → paste the URL')}</div></div>
      <div class="mcp-tool"><div class="tname">VS Code</div><div class="tstep">${t('Settings → 搜尋 MCP → Add Server → 貼上網址', 'Settings → search MCP → Add Server → paste the URL')}</div></div>
      <div class="mcp-tool"><div class="tname">${t('Claude Code（終端機）', 'Claude Code (terminal)')}</div><div class="tstep">${t('執行：', 'Run:')} <code>claude mcp add --transport http bugezy https://bugezy.dev/mcp</code></div></div>
      <div class="mcp-tool"><div class="tname">Zed</div><div class="tstep">${t('設定檔加 context_servers', 'Add context_servers to the config file')}</div></div>

      <div style="margin-top:14px;color:#ccc;font-size:13px;">${t('連接成功後，直接問 AI：', 'Once connected, just ask your AI:')}<br /><b style="color:#a78bfa;">${t('「讀我最新的 BugEzy 報告，告訴我怎麼修」', '"Read my latest BugEzy report and tell me how to fix it"')}</b><br />${t('AI 就會透過 MCP 自動讀取你的 Bug 報告。', 'The AI will read your bug report automatically via MCP.')}</div>
    </div>
  </div>

  <div class="step">
    <h2>${t('💡 小技巧', '💡 Tips')}</h2>
    <ul class="tips">
      <li>${t('錄製時對著麥克風說「這個按鈕按下去沒反應」比打字快 10 倍', 'Saying "this button does nothing when clicked" by voice is 10× faster than typing')}</li>
      <li>${t('即時監控可以掛一整天，有 error 才通知你', 'Live monitor can run all day and only alerts you on errors')}</li>
      <li>${t('免費版每月可錄 10 次，截圖和即時監控無限用', 'Free plan: 10 recordings/mo; screenshots and live monitor are unlimited')}</li>
      <li>${t('用 BugEzy MCP 讀報告比截圖貼給 AI 省 95% Token', 'Reading reports via BugEzy MCP saves 95% tokens vs pasting screenshots to AI')}</li>
    </ul>
  </div>

  <footer>
    <div class="links">
      <a href="/">${t('首頁', 'Home')}</a>
      <a href="/install">${t('安裝指南', 'Install')}</a>
      <a href="/features">${t('功能說明', 'Features')}</a>
      <a href="/faq">FAQ</a>
      <a href="/privacy">${t('隱私政策', 'Privacy')}</a>
      <a href="/changelog">${t('更新日誌', 'Changelog')}</a>
    <a href="/skill">${t('🤖 AI 客服手冊', '🤖 AI Manual')}</a>
    <a href="/feedback">${t('📬 問題回報', '📬 Feedback')}</a>
    <a href="/reports">${t('📋 我的報告', '📋 My Reports')}</a>
    </div>
    <div style="margin-top:8px;">${t('聯絡', 'Contact')}：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></div>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy</div>
  </footer>
</div>
</body>
</html>`;
}

// ── PM-66：FAQ 頁（四大類問答，手風琴點擊展開/收合，單一展開）──
// PM-152：/faq 改為函式（依 lang 中英切換）。🔴 英文版禁止提及任何競品名稱（延續 PM-130 去競品）。
function faqPage(lang: PageLang): string {
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  // PM-213：FAQPage JSON-LD ——問題/答案文字與下方可見手風琴逐字一致（Google 要求 FAQ markup 為頁面可見內容）。
  //   依 lang 動態產生：zh 頁配 zh 文字、en 頁配 en 文字，兩者都 match 各自可見內容。
  const faqQA: Array<[string, string]> = [
    [t('BugEzy 是什麼？', 'What is BugEzy?'), t('BugEzy 是一款 Chrome 擴充功能，讓開發者用語音 + 錄製的方式記錄 Bug，AI 透過 MCP 自動讀取報告並提供修復建議。省下 95% 的 debug 溝通時間。', 'BugEzy is a Chrome extension that lets developers capture bugs by voice + recording. AI reads the report automatically via MCP and suggests fixes — saving 95% of debugging communication time.')],
    [t('BugEzy 最大的優勢是什麼？', 'What makes BugEzy special?'), t('專為亞洲開發者設計：中文/粵語/日韓語音支援、NT$80 超平價月費、MCP 整合讓 AI 直接讀報告。獨家功能：即時監控、30 秒回溯、Whisper 精準語音、終端機 CLI、Token 透明度。', 'Built for Asian developers: Chinese / Cantonese / Japanese / Korean voice support, an affordable NT$80/mo plan, and MCP integration so AI reads reports directly. Signature features: live monitor, 30-second rewind, Whisper precise voice, terminal CLI, and token transparency.')],
    [t('支援哪些 AI 工具？', 'Which AI tools are supported?'), t('任何支援 MCP 的 AI 工具都能用，包括 Claude Desktop、Claude Code、Cursor、VS Code + Copilot、Zed、Windsurf、Codex、Replit 等。只需要一行 URL：https://bugezy.dev/mcp', 'Any MCP-capable AI tool works, including Claude Desktop, Claude Code, Cursor, VS Code, Zed, Windsurf, Google Antigravity, Gemini CLI, and more. Just one URL: https://bugezy.dev/mcp')],
    [t('BugEzy 會錄到我的密碼嗎？', 'Will BugEzy record my passwords?'), t('BugEzy 錄製的是 DOM 結構變化，不是螢幕截圖。密碼輸入框（type="password"）的內容會被 rrweb 自動遮蔽，不會錄到實際密碼。', 'BugEzy records DOM structure changes, not screen video. Password fields (type="password") are automatically masked by rrweb, so actual passwords are never captured.')],
    [t('我的報告誰能看到？', 'Who can see my reports?'), t('報告連結採用隨機加密 ID（UUID），無法被猜測或搜尋，只有擁有連結的人才能查看報告內容。若你將連結分享給同事或 AI 工具，他們就能查看；未分享的報告連結不會出現在任何公開列表中。建議不要把報告連結貼在公開場合（如公開 issue、論壇），避免非預期的存取。', 'Each report has a random encrypted ID (UUID) that cannot be guessed or searched — only people with the report link can view its content. If you share the link with colleagues or AI tools, they can access the report; unshared report links never appear in any public listing. Tip: avoid posting report links in public places (issues, forums) to prevent unintended access.')],
    [t('資料存在哪裡？', 'Where is my data stored?'), t('報告存在 Cloudflare R2（全球 CDN），使用者資料存在 Supabase（PostgreSQL）。所有傳輸都經過 HTTPS 加密。', 'Reports are stored on Cloudflare R2 (global CDN); user data on Supabase (PostgreSQL). All transfers are encrypted over HTTPS.')],
    [t('免費版有什麼限制？', 'What are the free plan limits?'), t('免費版每月可錄製 10 次、回溯 5 次、MCP AI 讀取 20 次。截圖標注和即時監控無限使用。報告保留 7 天。', 'The free plan includes 10 recordings, 5 rewinds, and 20 MCP AI reads per month. Screenshot annotation and live monitor are unlimited. Reports are kept for 7 days.')],
    [t('付費版多少錢？', 'How much is Premium?'), t('NT$80/月（約 $3 USD），解鎖全功能無限次使用，報告保留 90 天，加上終端機 CLI、Whisper 精準語音等進階功能。', 'NT$80/mo (about US$3) unlocks unlimited use of all features, 90-day report retention, plus advanced features like terminal CLI and Whisper precise voice.')],
    [t('如何升級付費版？', 'How to upgrade to Premium?'), t('在 BugEzy popup 點「升級」按鈕，透過信用卡或 ATM 付款。', 'Click "Upgrade" in the BugEzy popup and pay by credit card or ATM.')],
    [t('可以取消訂閱嗎？', 'Can I cancel my subscription?'), t('可以，隨時取消。取消後當月剩餘天數仍可使用付費功能，下個月恢復為免費版。', 'Yes, anytime. After cancelling you keep premium features for the rest of the billing period, then revert to the free plan.')],
    [t('哪些瀏覽器支援？', 'Which browsers are supported?'), t('目前支援 Chrome 和所有 Chromium 瀏覽器（Edge、Brave、Arc 等）。', 'Chrome and all Chromium-based browsers (Edge, Brave, Arc, etc.).')],
    [t('會影響網頁效能嗎？', 'Does it affect page performance?'), t('影響極小。BugEzy 只在你主動錄製時才記錄 DOM 變化，即時監控模式只攔截 Console error 和 Network error，不錄 DOM。', 'Minimal. BugEzy only records DOM changes while you are actively recording; live monitor mode only captures Console and Network errors, not the DOM.')],
    [t('MCP 是什麼？', 'What is MCP?'), t('Model Context Protocol（模型上下文協議），是 Anthropic 推出的開放標準，讓 AI 工具可以連接外部服務。BugEzy 的 MCP 讓 AI 直接讀取你的 Bug 報告，不需要複製貼上。', 'Model Context Protocol — an open standard from Anthropic that lets AI tools connect to external services. BugEzy MCP lets AI read your bug reports directly, with no copy-paste.')],
    [t('Token 是什麼？為什麼 BugEzy 能省 Token？', 'What are tokens, and how does BugEzy save them?'), t('Token 是 AI 處理文字的計量單位，等於你的 AI 使用費用。BugEzy 用結構化文字（而非截圖）傳送報告給 AI，同樣的 Bug 資訊只需要 1/20 的 Token。每次 MCP AI 讀取都會顯示 Token 估算，讓你看到省了多少。', 'Tokens are the unit AI uses to process text — effectively your AI cost. BugEzy sends reports as structured text (not screenshots), so the same bug info takes 1/20 the tokens. Every MCP AI read shows a token estimate so you can see the savings.')],
  ];
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqQA.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-Hant' : 'en'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('常見問題 · BugEzy', 'FAQ · BugEzy')}</title>
<meta name="description" content="${t('BugEzy 常見問題：安裝、錄製、語音辨識、MCP 設定、付費方案等問答。', 'Frequently asked questions about BugEzy — pricing, AI tool support, data security, and more.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/faq">
${ogMeta('/faq', 'FAQ — BugEzy', 'Frequently asked questions about BugEzy.')}
${jsonLd(faqLd)}
<style>
  * { box-sizing: border-box; }
  .lang-switch { position:fixed; top:14px; right:16px; z-index:10; background:#1a1a2e; border:1px solid #7c3aed; border-radius:8px; padding:5px 12px; font-size:13px; color:#c4b5fd; text-decoration:none; }
  .lang-switch:hover { background:#2a2a3e; }
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
<a class="lang-switch" href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t('EN', '中文')}</a>
<div class="wrap">
  <header><a class="brand" href="/">🐛 BugEzy</a></header>

  <h1>${t('🐛 BugEzy 常見問題', '🐛 BugEzy FAQ')}</h1>

  <h2>${t('📌 關於產品', '📌 About the product')}</h2>
  <div class="faq-q">${t('BugEzy 是什麼？', 'What is BugEzy?')}</div>
  <div class="faq-a"><p>${t('BugEzy 是一款 Chrome 擴充功能，讓開發者用語音 + 錄製的方式記錄 Bug，AI 透過 MCP 自動讀取報告並提供修復建議。省下 95% 的 debug 溝通時間。', 'BugEzy is a Chrome extension that lets developers capture bugs by voice + recording. AI reads the report automatically via MCP and suggests fixes — saving 95% of debugging communication time.')}</p></div>

  <div class="faq-q">${t('BugEzy 最大的優勢是什麼？', 'What makes BugEzy special?')}</div>
  <div class="faq-a"><p>${t('專為亞洲開發者設計：中文/粵語/日韓語音支援、NT$80 超平價月費、MCP 整合讓 AI 直接讀報告。獨家功能：即時監控、30 秒回溯、Whisper 精準語音、終端機 CLI、Token 透明度。', 'Built for Asian developers: Chinese / Cantonese / Japanese / Korean voice support, an affordable NT$80/mo plan, and MCP integration so AI reads reports directly. Signature features: live monitor, 30-second rewind, Whisper precise voice, terminal CLI, and token transparency.')}</p></div>

  <div class="faq-q">${t('支援哪些 AI 工具？', 'Which AI tools are supported?')}</div>
  <div class="faq-a"><p>${t('任何支援 MCP 的 AI 工具都能用，包括 Claude Desktop、Claude Code、Cursor、VS Code + Copilot、Zed、Windsurf、Codex、Replit 等。只需要一行 URL：', 'Any MCP-capable AI tool works, including Claude Desktop, Claude Code, Cursor, VS Code, Zed, Windsurf, Google Antigravity, Gemini CLI, and more. Just one URL:')}<code>https://bugezy.dev/mcp</code></p></div>

  <h2>${t('🔒 關於隱私與安全', '🔒 Privacy & security')}</h2>
  <div class="faq-q">${t('BugEzy 會錄到我的密碼嗎？', 'Will BugEzy record my passwords?')}</div>
  <div class="faq-a"><p>${t('BugEzy 錄製的是 DOM 結構變化，不是螢幕截圖。密碼輸入框（type="password"）的內容會被 rrweb 自動遮蔽，不會錄到實際密碼。', 'BugEzy records DOM structure changes, not screen video. Password fields (type="password") are automatically masked by rrweb, so actual passwords are never captured.')}</p></div>

  <div class="faq-q">${t('我的報告誰能看到？', 'Who can see my reports?')}</div>
  <div class="faq-a"><p>${t('報告連結採用隨機加密 ID（UUID），無法被猜測或搜尋，只有擁有連結的人才能查看報告內容。若你將連結分享給同事或 AI 工具，他們就能查看；未分享的報告連結不會出現在任何公開列表中。建議不要把報告連結貼在公開場合（如公開 issue、論壇），避免非預期的存取。', 'Each report has a random encrypted ID (UUID) that cannot be guessed or searched — only people with the report link can view its content. If you share the link with colleagues or AI tools, they can access the report; unshared report links never appear in any public listing. Tip: avoid posting report links in public places (issues, forums) to prevent unintended access.')}</p></div>

  <div class="faq-q">${t('資料存在哪裡？', 'Where is my data stored?')}</div>
  <div class="faq-a"><p>${t('報告存在 Cloudflare R2（全球 CDN），使用者資料存在 Supabase（PostgreSQL）。所有傳輸都經過 HTTPS 加密。', 'Reports are stored on Cloudflare R2 (global CDN); user data on Supabase (PostgreSQL). All transfers are encrypted over HTTPS.')}</p></div>

  <h2>${t('💰 關於方案與付費', '💰 Plans & billing')}</h2>
  <div class="faq-q">${t('免費版有什麼限制？', 'What are the free plan limits?')}</div>
  <div class="faq-a"><p>${t('免費版每月可錄製 10 次、回溯 5 次、MCP AI 讀取 20 次。截圖標注和即時監控無限使用。報告保留 7 天。', 'The free plan includes 10 recordings, 5 rewinds, and 20 MCP AI reads per month. Screenshot annotation and live monitor are unlimited. Reports are kept for 7 days.')}</p></div>

  <div class="faq-q">${t('付費版多少錢？', 'How much is Premium?')}</div>
  <div class="faq-a"><p>${t('NT$80/月（約 $3 USD），解鎖全功能無限次使用，報告保留 90 天，加上終端機 CLI、Whisper 精準語音等進階功能。', 'NT$80/mo (about US$3) unlocks unlimited use of all features, 90-day report retention, plus advanced features like terminal CLI and Whisper precise voice.')}</p></div>

  <div class="faq-q">${t('如何升級付費版？', 'How to upgrade to Premium?')}</div>
  <div class="faq-a"><p>${t('在 BugEzy popup 點「升級」按鈕，透過信用卡或 ATM 付款。', 'Click "Upgrade" in the BugEzy popup and pay by credit card or ATM.')}</p></div>

  <div class="faq-q">${t('可以取消訂閱嗎？', 'Can I cancel my subscription?')}</div>
  <div class="faq-a"><p>${t('可以，隨時取消。取消後當月剩餘天數仍可使用付費功能，下個月恢復為免費版。', 'Yes, anytime. After cancelling you keep premium features for the rest of the billing period, then revert to the free plan.')}</p></div>

  <h2>${t('🛠 關於技術', '🛠 Technical')}</h2>
  <div class="faq-q">${t('哪些瀏覽器支援？', 'Which browsers are supported?')}</div>
  <div class="faq-a"><p>${t('目前支援 Chrome 和所有 Chromium 瀏覽器（Edge、Brave、Arc 等）。', 'Chrome and all Chromium-based browsers (Edge, Brave, Arc, etc.).')}</p></div>

  <div class="faq-q">${t('會影響網頁效能嗎？', 'Does it affect page performance?')}</div>
  <div class="faq-a"><p>${t('影響極小。BugEzy 只在你主動錄製時才記錄 DOM 變化，即時監控模式只攔截 Console error 和 Network error，不錄 DOM。', 'Minimal. BugEzy only records DOM changes while you are actively recording; live monitor mode only captures Console and Network errors, not the DOM.')}</p></div>

  <div class="faq-q">${t('MCP 是什麼？', 'What is MCP?')}</div>
  <div class="faq-a"><p>${t('Model Context Protocol（模型上下文協議），是 Anthropic 推出的開放標準，讓 AI 工具可以連接外部服務。BugEzy 的 MCP 讓 AI 直接讀取你的 Bug 報告，不需要複製貼上。', 'Model Context Protocol — an open standard from Anthropic that lets AI tools connect to external services. BugEzy MCP lets AI read your bug reports directly, with no copy-paste.')}</p></div>

  <div class="faq-q">${t('Token 是什麼？為什麼 BugEzy 能省 Token？', 'What are tokens, and how does BugEzy save them?')}</div>
  <div class="faq-a"><p>${t('Token 是 AI 處理文字的計量單位，等於你的 AI 使用費用。BugEzy 用結構化文字（而非截圖）傳送報告給 AI，同樣的 Bug 資訊只需要 1/20 的 Token。每次 MCP AI 讀取都會顯示 Token 估算，讓你看到省了多少。', 'Tokens are the unit AI uses to process text — effectively your AI cost. BugEzy sends reports as structured text (not screenshots), so the same bug info takes 1/20 the tokens. Every MCP AI read shows a token estimate so you can see the savings.')}</p></div>

  <footer>
    <div class="links">
      <a href="/">${t('首頁', 'Home')}</a>
      <a href="/install">${t('安裝指南', 'Install')}</a>
      <a href="/features">${t('功能說明', 'Features')}</a>
      <a href="/guide">${t('使用指南', 'Guide')}</a>
      <a href="/privacy">${t('隱私政策', 'Privacy')}</a>
      <a href="/changelog">${t('更新日誌', 'Changelog')}</a>
    <a href="/skill">${t('🤖 AI 客服手冊', '🤖 AI Manual')}</a>
    <a href="/feedback">${t('📬 問題回報', '📬 Feedback')}</a>
    <a href="/reports">${t('📋 我的報告', '📋 My Reports')}</a>
    </div>
    <div style="margin-top:8px;">${t('聯絡', 'Contact')}：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></div>
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
}

// ── PM-96：安裝指南頁（GET /install）— 從零到能用的完整五步流程 + MCP 設定 ──
// PM-150：/install 改為函式（依 lang 中英切換）。
function installPage(lang: PageLang): string {
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  // PM-192（三修）：安裝指令抽成變數，供 <pre> 顯示與按鈕 data-copy-text 共用——複製改從 attribute 讀，
  //   徹底不受 DOM textContent（PM-190 .mcp-cfg 改寫、空白、瀏覽器差異）影響。
  const aiPrompt = t(
    `請幫我安裝 BugEzy MCP 除錯工具，讓你可以直接讀取我的 Bug 報告來幫我修 Bug。

安裝步驟：
1. Chrome 擴充功能：https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj
2. MCP 連線設定，在你的 MCP config 加入：
{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}

安裝完成後，我只要用 BugEzy 錄製 Bug，你就能透過 MCP 讀取我的報告（Console 錯誤、Network 問題、語音描述、截圖），直接幫我修。

詳細教學：https://bugezy.dev/install`,
    `Please help me install the BugEzy MCP debugging tool so you can read my bug reports and fix bugs for me.

Steps:
1. Chrome extension: https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj
2. MCP connection — add this to your MCP config:
{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}

Once installed, whenever I record a bug with BugEzy, you can read my report via MCP (console errors, network issues, voice description, screenshots) and fix it directly.

Full guide: https://bugezy.dev/install`,
  );
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-Hant' : 'en'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('安裝 BugEzy — 3 分鐘搞定 Chrome 擴充 + MCP 設定', 'Install BugEzy — Chrome extension + MCP setup in 3 minutes')}</title>
<meta name="description" content="${t('安裝 BugEzy Chrome 擴充功能，設定 MCP 連線，讓 AI 直接讀取你的 Bug 報告。支援 Claude、Cursor、Windsurf、Google Antigravity、Gemini CLI。', 'Install the BugEzy Chrome extension and set up MCP so AI can read your bug reports directly. Works with Claude, Cursor, Windsurf, Google Antigravity, Gemini CLI.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/install">
${ogMeta('/install', 'Install BugEzy — Setup Guide', 'Install BugEzy Chrome Extension and connect MCP in 2 minutes.')}
<style>
  * { box-sizing: border-box; }
  .lang-switch { position:fixed; top:14px; right:16px; z-index:10; background:#1a1a2e; border:1px solid #7c3aed; border-radius:8px; padding:5px 12px; font-size:13px; color:#c4b5fd; text-decoration:none; }
  .lang-switch:hover { background:#2a2a3e; }
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
  .copy-btn { background:#7c3aed; color:#fff; border:none; border-radius:10px; padding:12px 24px; font-size:15px; font-weight:600; cursor:pointer; width:100%; transition:transform 0.08s ease, opacity 0.08s ease, background 0.2s; }
  .copy-btn:hover { background:#6d28d9; }
  /* PM-192：按下去沉下去的回饋 */
  .copy-btn:active { transform:scale(0.97); opacity:0.8; }
  .copy-btn.copied { background:#238636; }
  .copy-feedback { color:#3fb950; font-size:14px; margin-top:8px; display:inline-block; }
  .ai-install-tools { color:#8b8fa3; font-size:13px; margin-top:8px; }
  @media (max-width: 640px) { .wrap { padding: 32px 16px 60px; } h1 { font-size: 24px; } }
</style>
</head>
<body>
<a class="lang-switch" href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t('EN', '中文')}</a>
<div class="wrap">
  <header><a class="brand" href="/">🐛 BugEzy</a></header>

  <h1>${t('🚀 安裝 BugEzy — 三分鐘搞定', '🚀 Install BugEzy — done in 3 minutes')}</h1>
  <p class="lead">${t('從零到能用，跟著五步走，馬上讓 AI 幫你修 Bug。', 'From zero to ready in five steps — let AI fix your bugs right away.')}</p>

  <div class="step" style="border-color:#7c3aed;">
    <h2>${t('🤖 最快的安裝方式：複製貼給 AI', '🤖 Fastest way: copy & paste to AI')}</h2>
    <p style="color:#8b8fa3;margin:0 0 4px;">${t('不懂技術？把下面這段複製貼給你的 AI（Claude Desktop / Claude Code / Cursor / Windsurf / VS Code + Cline / Google Antigravity / Gemini CLI），它會幫你搞定。', 'Not technical? Copy the text below to your AI (Claude Desktop / Claude Code / Cursor / Windsurf / VS Code + Cline / Google Antigravity / Gemini CLI) and it will handle it.')}</p>
    <div class="ai-install-box">
      <pre id="ai-install-prompt" class="mcp-cfg">${aiPrompt}</pre>
      <textarea id="install-copy-source" readonly style="position:absolute;left:-9999px;opacity:0;">${aiPrompt.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')}</textarea>
      <button class="copy-btn" onclick="var s=document.getElementById('install-copy-source');s.style.position='fixed';s.style.left='0';s.style.top='0';s.style.opacity='0.01';s.select();try{s.setSelectionRange(0,99999)}catch(e){}document.execCommand('copy');s.style.position='absolute';s.style.left='-9999px';s.style.opacity='0';this.textContent='${t('✅ 已複製！', '✅ Copied!')}';this.classList.add('copied');var b=this;setTimeout(function(){b.textContent='${t('📋 一鍵複製，貼給你的 AI', '📋 Copy & paste to your AI')}';b.classList.remove('copied')},2000)">${t('📋 一鍵複製，貼給你的 AI', '📋 Copy & paste to your AI')}</button>
    </div>
    <p class="ai-install-tools">${t('或依下方手動五步安裝 ↓', 'Or install manually in five steps below ↓')}</p>
  </div>

  <div class="step">
    <h2><span class="snum">1</span>${t('安裝擴充功能', 'Install the extension')}</h2>
    <ol>
      <li>${t('前往 Chrome Web Store 的 BugEzy 頁面', 'Open the BugEzy page on the Chrome Web Store')}</li>
      <li>${t('點「加到 Chrome」→ 在彈窗按「新增擴充功能」確認', 'Click "Add to Chrome" → confirm "Add extension" in the popup')}</li>
    </ol>
    <a class="cta-btn" href="https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj" target="_blank" rel="noopener">${t('前往 Chrome Web Store →', 'Go to Chrome Web Store →')}</a>
    <div class="note">${t('支援 Chrome 以及所有 Chromium 核心瀏覽器（Edge、Brave、Arc 等）。', 'Works on Chrome and all Chromium-based browsers (Edge, Brave, Arc, etc.).')}</div>
  </div>

  <div class="step">
    <h2><span class="snum">2</span>${t('固定到工具列', 'Pin to the toolbar')}</h2>
    <ol>
      <li>${t('點瀏覽器右上角的拼圖圖示 🧩（擴充功能選單）', 'Click the puzzle icon 🧩 at the top right (extensions menu)')}</li>
      <li>${t('找到 BugEzy 🐛 → 按旁邊的釘選 📌', 'Find BugEzy 🐛 → click the pin 📌 next to it')}</li>
    </ol>
    <div class="note">${t('釘選後圖示會常駐在工具列，隨時一鍵開錄，不用每次翻選單。', 'Once pinned, the icon stays on the toolbar for one-click recording anytime.')}</div>
  </div>

  <div class="step">
    <h2><span class="snum">3</span>${t('登入', 'Sign in')}</h2>
    <ol>
      <li>${t('點工具列上的 BugEzy 圖示 🐛', 'Click the BugEzy icon 🐛 on the toolbar')}</li>
      <li>${t('按「用 Google 登入」→ 選擇帳號授權', 'Click "Sign in with Google" → choose your account to authorize')}</li>
      <li>${t('popup 顯示你的名字 = 登入成功', 'Your name shown in the popup = signed in')}</li>
    </ol>
  </div>

  <div class="step">
    <h2><span class="snum">4</span>${t('第一次錄製', 'Your first recording')}</h2>
    <ol>
      <li>${t('開任意網頁 → 點 BugEzy 圖示 → 按「錄製」', 'Open any webpage → click the BugEzy icon → click "Record"')}</li>
      <li>${t('操作重現問題，同時用語音描述你看到的 Bug', 'Reproduce the issue while describing the bug by voice')}</li>
      <li>${t('按「停止」→ 自動打開報告編輯頁', 'Click "Stop" → the report editor opens automatically')}</li>
    </ol>
    <div class="note">${t('🎉 恭喜，你的第一份 Bug 報告完成了！可以編輯文字、AI 校正精簡後上傳。', '🎉 Congrats — your first bug report is done! Edit text, let AI clean it up, then upload.')}</div>
  </div>

  <div class="step">
    <h2><span class="snum">5</span>${t('連接 AI（MCP 設定）', 'Connect AI (MCP setup)')}</h2>
    <p style="margin:0 0 4px;color:#c4b5fd;font-weight:600;">${t('讓 AI 直接讀你的 Bug 報告，不用複製貼上。', 'Let AI read your bug reports directly — no copy-paste.')}</p>
    <p style="margin:0;">${t('支援 Claude Desktop · Claude Code · Cursor · Windsurf · VS Code + Cline · Google Antigravity · Gemini CLI 等所有 MCP 工具。', 'Works with all MCP tools: Claude Desktop · Claude Code · Cursor · Windsurf · VS Code + Cline · Google Antigravity · Gemini CLI.')}</p>
    <div class="mcp-box">
      <b>${t('🔌 BugEzy MCP 網址（所有工具通用）', '🔌 BugEzy MCP URL (same for all tools)')}</b><br />
      <code class="mcp-cfg">https://bugezy.dev/mcp</code>
      <p class="mcp-token-hint" style="margin:6px 0 0;font-size:12px;color:#8b8fa3;">${t('登入 BugEzy 後，本頁的網址與設定會自動幫你補上 ?token=（AI 就不用每次手動帶 token）。', 'After signing in to BugEzy, this page auto-appends ?token= to the URL and configs (so your AI never needs to pass a token manually).')}</p>
      <div class="mcp-warn">${t('⚠ 這個網址<b>不能用瀏覽器開</b>，它是給 AI 工具連接的協議。用瀏覽器開只會看到錯誤訊息，屬正常現象——請依下方步驟在 AI 工具裡設定。', '⚠ <b>Do not open this URL in a browser</b> — it is a protocol endpoint for AI tools. Opening it in a browser just shows an error, which is normal. Set it up in your AI tool per the steps below.')}</div>

      <div class="mcp-tool"><div class="tname">Claude.ai</div><div class="tstep">${t('Settings → Connectors → Add → 貼上網址 → 連接', 'Settings → Connectors → Add → paste the URL → Connect')}</div></div>
      <div class="mcp-tool"><div class="tname">Claude Desktop / Cursor / Windsurf</div><div class="tstep">${t('編輯設定檔（claude_desktop_config.json / mcp.json），加入：', 'Edit the config file (claude_desktop_config.json / mcp.json), add:')}</div><pre class="mcp-cfg">{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}</pre></div>
      <div class="mcp-tool"><div class="tname">VS Code + Cline</div><div class="tstep">${t('Cline → MCP Servers → Add → 貼上網址', 'Cline → MCP Servers → Add → paste the URL')}</div></div>
      <div class="mcp-tool"><div class="tname">${t('Claude Code（終端機）', 'Claude Code (terminal)')}</div><div class="tstep"><code class="mcp-cfg">claude mcp add --transport http bugezy https://bugezy.dev/mcp</code></div></div>
      <div class="mcp-tool"><div class="tname">Google Antigravity / Gemini CLI</div><div class="tstep">${t('在 MCP 設定加入（協定通用，格式同上）：', 'Add to your MCP config (same protocol / format as above):')}</div><pre class="mcp-cfg">{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}</pre></div>

      <div style="margin-top:14px;color:#ccc;font-size:13px;">${t('連接成功後直接問：', 'Once connected, just ask:')}<b style="color:#a78bfa;">${t('「讀我最新的 BugEzy 報告，告訴我怎麼修」', '"Read my latest BugEzy report and tell me how to fix it"')}</b></div>

      <div style="margin-top:14px;"><b style="color:#c4b5fd;font-size:13px;">${t('13 個 MCP 工具（AI 按需查詢，省 Token）：', '13 MCP tools (AI queries on demand to save tokens):')}</b>
        <div class="toolgrid">
          <div><b>list_reports</b> ${t('最近報告清單', 'recent reports')}</div>
          <div><b>get_report_overview</b> ${t('報告摘要', 'report summary')}</div>
          <div><b>get_timeline</b> ${t('完整時序麵包屑', 'full timeline')}</div>
          <div><b>get_console_logs</b> ${t('Console 錯誤', 'console errors')}</div>
          <div><b>get_network_errors</b> ${t('網路錯誤', 'network errors')}</div>
          <div><b>get_voice_transcript</b> ${t('語音全文', 'voice transcript')}</div>
          <div><b>get_screenshots</b> ${t('截圖', 'screenshots')}</div>
          <div><b>get_page_info</b> ${t('頁面資訊', 'page info')}</div>
          <div><b>get_rrweb_summary</b> ${t('DOM 軌跡摘要', 'DOM trace summary')}</div>
          <div><b>get_rrweb_events</b> ${t('DOM 事件細節', 'DOM event details')}</div>
          <div><b>get_live_errors</b> ${t('即時監控錯誤', 'live monitor errors')}</div>
          <div><b>get_terminal_logs</b> ${t('CLI 終端機日誌', 'CLI terminal logs')}</div>
          <div><b>get_usage_stats</b> ${t('Token 用量統計', 'token usage stats')}</div>
        </div>
      </div>
    </div>
  </div>

  <div class="ai-install-box" style="margin-top:28px;">
    <h3 style="margin:0 0 8px;color:#a78bfa;font-size:18px;">${t('🐍 後端開發者？試試 Terminal CLI', '🐍 Backend developer? Try the Terminal CLI')}</h3>
    <p style="color:#9aa3b2;font-size:14px;margin:0 0 14px;">${t('捕捉 Python / Node.js / Go 的終端機錯誤（stderr / traceback / crash），AI 直接讀取分析——不需開瀏覽器。付費功能。', 'Capture terminal errors (stderr / traceback / crash) from Python / Node.js / Go — AI reads and analyzes them directly, no browser needed. Premium feature.')}</p>
    <pre style="margin:0;padding:14px 16px;background:#0f0f1a;border-radius:8px;color:#7ee0c5;font-family:ui-monospace,monospace;font-size:13px;overflow-x:auto;white-space:pre;line-height:1.7;">$ BUGEZY_TOKEN=&lt;${t('你的 token', 'your token')}&gt; npx bugezy-watch -- python manage.py runserver
$ BUGEZY_TOKEN=&lt;${t('你的 token', 'your token')}&gt; npx bugezy-watch -- node server.js
$ BUGEZY_TOKEN=&lt;${t('你的 token', 'your token')}&gt; npx bugezy-watch -- go run main.go</pre>
    <p style="color:#888;font-size:12px;margin:12px 0 0;">${t('AI 之後用 <code style="background:#2a2a3e;padding:1px 5px;border-radius:4px;color:#7ee0c5;">get_terminal_logs</code> MCP 工具讀取這些錯誤。', 'AI then reads these errors via the <code style="background:#2a2a3e;padding:1px 5px;border-radius:4px;color:#7ee0c5;">get_terminal_logs</code> MCP tool.')}</p>
  </div>

  <div class="bottom-cta">
    <a class="cta-btn" href="/features">${t('來看看有哪些功能 →', 'See all features →')}</a>
  </div>

  <footer>
    <div class="links">
      <a href="/">${t('首頁', 'Home')}</a>
      <a href="/install">${t('安裝指南', 'Install')}</a>
      <a href="/features">${t('功能說明', 'Features')}</a>
      <a href="/guide">${t('使用指南', 'Guide')}</a>
      <a href="/faq">FAQ</a>
      <a href="/privacy">${t('隱私政策', 'Privacy')}</a>
      <a href="/changelog">${t('更新日誌', 'Changelog')}</a>
    <a href="/skill">${t('🤖 AI 客服手冊', '🤖 AI Manual')}</a>
    <a href="/feedback">${t('📬 問題回報', '📬 Feedback')}</a>
    <a href="/reports">${t('📋 我的報告', '📋 My Reports')}</a>
    </div>
    <div style="margin-top:8px;">${t('聯絡', 'Contact')}：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></div>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy</div>
  </footer>
</div>
<script>
  // PM-190（方案 B）：已登入 → 把本頁所有 MCP 設定/網址（.mcp-cfg）的 bugezy.dev/mcp 自動補上 ?token=<session token>，
  //   AI 端就零操作讀報告。token 來自同源 localStorage（PM-187 存於 bugezy.dev；開「📋 我的報告」即 seed）。
  //   未登入 → 維持乾淨 /mcp（token 現為 optional，仍可手動帶 session_token 參數）。
  (function () {
    try {
      var token = localStorage.getItem('bugezy_session_token');
      if (!token) return;
      var enc = encodeURIComponent(token);
      document.querySelectorAll('.mcp-cfg').forEach(function (el) {
        // 只在還沒帶 token 的 /mcp 後面補（冪等，避免重複）
        // PM-192（四修）：跳過複製按鈕的來源 <pre id="ai-install-prompt">——它的複製走靜態 data-copy-text（跟首頁一樣），
        //   不讓 token 改寫它的 textContent（避免任何改動影響複製來源；一鍵複製 = server render 的乾淨安裝指令）。
        if (el.id === 'ai-install-prompt') return;
        el.textContent = el.textContent.replace(/(bugezy\\.dev\\/mcp)(?!\\?|[\\w])/g, '$1?token=' + enc);
      });
    } catch (e) {}
  })();

    // PM-192（三修）：複製優先從 btn.dataset.copyText（decodeURIComponent）讀，不依賴 DOM textContent，
    //   徹底解「貼出空白」。clipboard 失敗 → 視窗內 1px textarea + execCommand fallback；按鈕變「✅ 已複製！」2s 恢復。
    (function () {
      var btn = document.getElementById('copy-ai-prompt');
      if (!btn) return;
      var originalLabel = btn.textContent;
      var DONE_LABEL = ${JSON.stringify(t('✅ 已複製！', '✅ Copied!'))};
      function getText() {
        var d = btn.dataset ? btn.dataset.copyText : null;
        if (d) { try { return decodeURIComponent(d); } catch (e) {} }
        var el = document.getElementById('ai-install-prompt');
        return el ? (el.textContent || '') : '';
      }
      function flashDone() {
        btn.textContent = DONE_LABEL;
        btn.classList.add('copied');
        setTimeout(function () { btn.textContent = originalLabel; btn.classList.remove('copied'); }, 2000);
      }
      function fallbackCopy(text) {
        try {
          var ta = document.createElement('textarea');
          ta.value = text; ta.setAttribute('readonly', '');
          ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.left = '0';
          ta.style.width = '1px'; ta.style.height = '1px'; ta.style.padding = '0';
          ta.style.border = 'none'; ta.style.outline = 'none'; ta.style.boxShadow = 'none'; ta.style.background = 'transparent';
          document.body.appendChild(ta); ta.focus(); ta.select();
          try { ta.setSelectionRange(0, text.length); } catch (e2) {}
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          console.log('[BugEzy] home fallback execCommand copy ok=' + ok);
          if (ok) flashDone();
          return ok;
        } catch (e) { console.warn('[BugEzy] home fallback copy failed', e); return false; }
      }
      btn.addEventListener('click', function () {
        var text = getText();
        console.log('[BugEzy] home copy length=' + text.length);
        if (!text) { console.warn('[BugEzy] home copy empty'); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            function () { console.log('[BugEzy] home clipboard.writeText OK'); flashDone(); },
            function (err) { console.warn('[BugEzy] home clipboard failed → fallback', err); fallbackCopy(text); },
          );
        } else { fallbackCopy(text); }
      });
    })();
</script>
</body>
</html>`;
}

// ── PM-96：功能說明頁（GET /features）— 六種模式 + 語音 + 高畫質 AI 的操作說明 ──
// PM-151：/features 改為函式（依 lang 中英切換，延續 PM-150 模式）。
function featuresPage(lang: PageLang): string {
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-Hant' : 'en'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('BugEzy 功能 — 六種錄製模式、Whisper 語音、即時監控', 'BugEzy Features — Six Recording Modes, Whisper Voice, Live Monitor')}</title>
<meta name="description" content="${t('BugEzy 六種除錯模式：錄製、回溯 30 秒、截圖標注、即時監控、終端機 CLI、MCP AI 讀取。Whisper 精準語音轉錄。', 'BugEzy offers six debugging modes: Record, Rewind, Screenshot, Live Monitor, Terminal CLI, and MCP AI. Whisper voice transcription for premium users.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/features">
${ogMeta('/features', 'Features — BugEzy', 'Voice recording, DOM replay, console capture, network errors, MCP integration, and more.')}
<style>
  * { box-sizing: border-box; }
  .lang-switch { position:fixed; top:14px; right:16px; z-index:10; background:#1a1a2e; border:1px solid #7c3aed; border-radius:8px; padding:5px 12px; font-size:13px; color:#c4b5fd; text-decoration:none; }
  .lang-switch:hover { background:#2a2a3e; }
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
<a class="lang-switch" href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t('EN', '中文')}</a>
<div class="wrap">
  <header><a class="brand" href="/">🐛 BugEzy</a></header>

  <h1>${t('🎯 BugEzy 功能總覽', '🎯 BugEzy Features')}</h1>
  <p class="lead">${t('六種抓 Bug 模式 + 語音設定 + 高畫質 AI 分析，挑最順手的用。', 'Six bug-catching modes + voice options + HQ AI analysis — pick what works best.')}</p>

  <div class="feat">
    <h2>${t('🎬 錄製', '🎬 Record')}</h2>
    <div class="row"><b>${t('適合：', 'Best for: ')}</b>${t('完整重現 Bug', 'Fully reproducing a bug')}</div>
    <div class="row"><b>${t('操作：', 'How: ')}</b>${t('按「錄製」→ 操作重現 → 語音描述 → 按「停止」', 'Click "Record" → reproduce → describe by voice → click "Stop"')}</div>
    <div class="row"><b>${t('AI 收到：', 'AI gets: ')}</b>${t('DOM 軌跡 + Console + Network + 語音', 'DOM trace + Console + Network + voice')}</div>
    <div class="row"><b>${t('小提示：', 'Tip: ')}</b>${t('底部字幕條會即時顯示，確認語音有在收音', 'The caption bar shows live text so you know the mic is picking up')}</div>
  </div>

  <div class="feat">
    <h2>${t('⏪ 30 秒回溯', '⏪ Rewind 30s')}</h2>
    <div class="row"><b>${t('適合：', 'Best for: ')}</b>${t('Bug 已經發生，來不及按錄製', 'The bug already happened, too late to press record')}</div>
    <div class="row"><b>${t('操作：', 'How: ')}</b>${t('按「回溯 30s」→ 自動抓回最近 30 秒', 'Click "Rewind 30s" → grabs the last 30 seconds automatically')}</div>
    <div class="row"><b>${t('AI 收到：', 'AI gets: ')}</b>${t('最近 30 秒的 DOM + Console + Network', 'DOM + Console + Network from the last 30 seconds')}</div>
    <div class="row"><b>${t('小提示：', 'Tip: ')}</b>${t('BugEzy 在背景持續記錄，不用提前按', 'BugEzy records in the background — no need to start early')}</div>
  </div>

  <div class="feat">
    <h2>${t('📸 截圖標注', '📸 Screenshot Annotate')}</h2>
    <div class="row"><b>${t('適合：', 'Best for: ')}</b>${t('快速指出畫面上的問題', 'Quickly pointing out an on-screen issue')}</div>
    <div class="row"><b>${t('操作：', 'How: ')}</b>${t('截圖 → 選模式（整頁／可見範圍／自選區域）→ 畫筆箭頭標注 → 上傳', 'Capture → pick mode (full page / visible / region) → annotate → upload')}</div>
    <div class="row"><b>${t('AI 收到：', 'AI gets: ')}</b>${t('截圖 metadata（勾「高畫質 AI 分析」才讓 AI 直接看圖）', 'Screenshot metadata (enable "HQ AI analysis" to let AI view the image)')}</div>
    <div class="row"><b>${t('小提示：', 'Tip: ')}</b>${t('純視覺 Bug 建議開高畫質分析', 'For visual-only bugs, turn on HQ analysis')}</div>
  </div>

  <div class="feat">
    <h2>${t('⌨️ 鍵盤模式', '⌨️ Keyboard Mode')}</h2>
    <div class="row"><b>${t('適合：', 'Best for: ')}</b>${t('吵雜環境（咖啡廳、辦公室）', 'Noisy environments (cafés, offices)')}</div>
    <div class="row"><b>${t('操作：', 'How: ')}</b>${t('開啟鍵盤模式 → 關閉語音辨識 → 用打字描述 Bug', 'Enable keyboard mode → voice off → type the bug description')}</div>
    <div class="row"><b>${t('小提示：', 'Tip: ')}</b>${t('專注打字、不收音，適合不方便說話時', 'Type-only, no audio — good when you can not speak')}</div>
  </div>

  <div class="feat">
    <h2>${t('👁️ 即時監控', '👁️ Live Monitor')}</h2>
    <div class="row"><b>${t('適合：', 'Best for: ')}</b>${t('掛著等偶發 Bug 自己出現', 'Leaving it on to catch intermittent bugs')}</div>
    <div class="row"><b>${t('操作：', 'How: ')}</b>${t('開啟即時監控 → 背景自動攔截 Console error / Network error', 'Enable live monitor → auto-captures Console / Network errors in the background')}</div>
    <div class="row"><b>${t('小提示：', 'Tip: ')}</b>${t('適合難重現、偶發性的問題，可以掛一整天', 'Great for hard-to-reproduce issues — leave it running all day')}</div>
  </div>

  <div class="feat">
    <h2>${t('💻 終端機 CLI', '💻 Terminal CLI')}</h2>
    <div class="row"><b>${t('適合：', 'Best for: ')}</b>${t('後端開發（Node.js、Python 等）', 'Backend development (Node.js, Python, etc.)')}</div>
    <div class="row"><b>${t('操作：', 'How: ')}</b><code>npx bugezy-watch -- node server.js</code></div>
    <div class="row"><b>${t('小提示：', 'Tip: ')}</b>${t('不需開瀏覽器，自動攔截 stderr / throw / crash', 'No browser needed — auto-captures stderr / throw / crash')}</div>
  </div>

  <div class="feat">
    <h2>${t('🔍 全方位 Bug 捕捉', '🔍 Full-Spectrum Bug Capture')}<span class="tag free">${t('免費', 'Free')}</span></h2>
    <div class="row"><b>${t('漏網錯誤：', 'Missed errors: ')}</b>${t('console.warn 完整捕捉、未捕捉的 Promise Rejection、框架吞掉的 window.onerror、資源載入失敗（圖片/CSS/JS/字型 404）', 'Full console.warn capture, unhandled Promise Rejections, framework-swallowed window.onerror, resource load failures (image/CSS/JS/font 404)')}</div>
    <div class="row"><b>${t('效能：', 'Performance: ')}</b>${t('Web Vitals（LCP / CLS / FID）超標自動警告', 'Web Vitals (LCP / CLS / FID) auto-alerts when thresholds are exceeded')}</div>
    <div class="row"><b>${t('環境快照：', 'Environment: ')}</b>${t('網路環境（WiFi/4G/離線/延遲/頻寬）+ 儲存空間（localStorage/sessionStorage/Cookie，敏感值本機自動遮罩）', 'Network snapshot (WiFi/4G/offline/latency/bandwidth) + storage snapshot (localStorage/sessionStorage/Cookie, sensitive values masked locally)')}</div>
    <div class="row"><b>${t('AI 分析：', 'AI analysis: ')}</b>${t('時序麵包屑（get_timeline 把所有事件排成一條故事線）+ AI Bug 導航摘要（自動根因+修復建議）', 'Timeline breadcrumb (get_timeline sorts every event into one story) + AI bug navigator (auto root-cause & fix suggestions)')}</div>
    <div class="row"><b>${t('小提示：', 'Tip: ')}</b>${t('這些全自動，錄製或即時監控時默默收好，一份報告全都有', 'All automatic — quietly collected during recording or live monitor, all in one report')}</div>
  </div>

  <div class="feat paid">
    <h2>${t('🎙️ 語音設定', '🎙️ Voice Options')}<span class="tag pro">${t('付費', 'Premium')}</span></h2>
    <div class="row"><b>${t('即時字幕（免費）：', 'Live captions (free): ')}</b>${t('Web Speech 頁面內即時轉字幕，零成本', 'In-page Web Speech captions, zero cost')}</div>
    <div class="row"><b>${t('精準轉錄（付費）：', 'Precise transcription (premium): ')}</b>${t('Groq Whisper 高準確度轉錄，適合專有名詞多的描述', 'High-accuracy Groq Whisper, great for jargon-heavy descriptions')}</div>
    <div class="row"><b>${t('操作：', 'How: ')}</b>${t('popup 開麥克風 toggle → 付費版可切「即時字幕／精準轉錄」', 'Toggle the mic in the popup → premium can switch "Live captions / Precise"')}</div>
    <div class="row"><b>${t('小提示：', 'Tip: ')}</b>${t('首次使用會請你授權麥克風，該網站只需授權一次', 'First use asks for mic permission — only once per site')}</div>
  </div>

  <div class="feat paid">
    <h2>${t('📸 高畫質 AI 分析', '📸 HQ AI Analysis')}<span class="tag pro">${t('高 Token', 'High token')}</span></h2>
    <div class="row"><b>${t('適合：', 'Best for: ')}</b>${t('版面跑版、樣式錯亂等純視覺 Bug', 'Layout breaks, styling glitches, visual-only bugs')}</div>
    <div class="row"><b>${t('操作：', 'How: ')}</b>${t('在 popup 或報告頁勾選「高畫質 AI 分析」', 'Enable "HQ AI analysis" in the popup or report page')}</div>
    <div class="row"><b>${t('AI 收到：', 'AI gets: ')}</b>${t('勾選後 AI 會直接讀截圖圖片（否則只給 metadata 省 Token）', 'When enabled, AI reads the screenshot image (otherwise metadata only to save tokens)')}</div>
    <div class="row"><b>${t('小提示：', 'Tip: ')}</b>${t('看圖較耗 Token，非視覺 Bug 建議關閉', 'Viewing images costs more tokens — turn off for non-visual bugs')}</div>
  </div>

  <div class="bottom-cta">
    <a class="cta-btn" href="/install">${t('還沒安裝？前往安裝指南 →', 'Not installed yet? Go to install guide →')}</a>
    <a class="cta-btn ghost" href="/">${t('回首頁', 'Home')}</a>
  </div>

  <footer>
    <div class="links">
      <a href="/">${t('首頁', 'Home')}</a>
      <a href="/install">${t('安裝指南', 'Install')}</a>
      <a href="/features">${t('功能說明', 'Features')}</a>
      <a href="/guide">${t('使用指南', 'Guide')}</a>
      <a href="/faq">FAQ</a>
      <a href="/privacy">${t('隱私政策', 'Privacy')}</a>
      <a href="/changelog">${t('更新日誌', 'Changelog')}</a>
    <a href="/skill">${t('🤖 AI 客服手冊', '🤖 AI Manual')}</a>
    <a href="/feedback">${t('📬 問題回報', '📬 Feedback')}</a>
    <a href="/reports">${t('📋 我的報告', '📋 My Reports')}</a>
    </div>
    <div style="margin-top:8px;">${t('聯絡', 'Contact')}：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></div>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy</div>
  </footer>
</div>
</body>
</html>`;
}

// ── PM-126：更新日誌頁（GET /changelog）——深色主題與其他頁一致 ──
// PM-151：/changelog 改為函式（依 lang 中英切換）。版號/日期不翻，只翻功能描述。
function changelogPage(lang: PageLang): string {
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-Hant' : 'en'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('更新日誌 · BugEzy', 'Changelog · BugEzy')}</title>
<meta name="description" content="${t('BugEzy 每次更新做了什麼，都記在這裡。', 'What changed in each BugEzy update, all in one place.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/changelog">
${ogMeta('/changelog', 'Changelog — BugEzy', 'Latest updates and release notes.')}
<style>
  * { box-sizing: border-box; }
  .lang-switch { position:fixed; top:14px; right:16px; z-index:10; background:#1a1a2e; border:1px solid #7c3aed; border-radius:8px; padding:5px 12px; font-size:13px; color:#c4b5fd; text-decoration:none; }
  .lang-switch:hover { background:#2a2a3e; }
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
<a class="lang-switch" href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t('EN', '中文')}</a>
<div class="wrap">
  <header><a class="brand" href="/">🐛 BugEzy</a></header>

  <h1>${t('📋 BugEzy 更新日誌', '📋 BugEzy Changelog')}</h1>
  <p class="lead">${t('每次更新做了什麼，都記在這裡。', 'What changed in each update, all here.')}</p>

  <section class="changelog-entry">
    <h3>v1.1.0 — 2026-07-02</h3>
    <ul>
      <li>${t('🎙️ Whisper 精準語音轉錄（付費版）', '🎙️ Whisper voice transcription (Premium)')}</li>
      <li>${t('⚡ 日票 NT$20/24hr 上線', '⚡ Day Pass NT$20/24hr launched')}</li>
      <li>${t('💬 AI 指令輪盤（一鍵複製慣用語）', '💬 AI prompt carousel (one-click copy)')}</li>
      <li>${t('📸 高畫質 AI 分析勾選', '📸 HQ AI analysis toggle')}</li>
      <li>${t('🟢 即時監控狀態條 + 上傳報告', '🟢 Live monitor status bar + upload report')}</li>
      <li>${t('⚙️ 進階設定折疊', '⚙️ Collapsible advanced settings')}</li>
      <li>${t('🔒 Supabase RLS 安全強化', '🔒 Supabase RLS security hardening')}</li>
    </ul>
  </section>

  <section class="changelog-entry">
    <h3>v1.0.0 — 2026-06-29</h3>
    <ul>
      <li>${t('🎉 首次上架 Chrome Web Store', '🎉 First release on Chrome Web Store')}</li>
      <li>${t('🎬 六種錄製模式', '🎬 Six recording modes')}</li>
      <li>${t('🤖 12 個 MCP 工具 + Token 透明度', '🤖 12 MCP tools + Token transparency')}</li>
      <li>${t('💳 ECPay 付費整合', '💳 ECPay payment integration')}</li>
    </ul>
  </section>

  <footer>
    <div class="links">
      <a href="/">${t('首頁', 'Home')}</a>
      <a href="/install">${t('安裝指南', 'Install')}</a>
      <a href="/features">${t('功能說明', 'Features')}</a>
      <a href="/guide">${t('使用指南', 'Guide')}</a>
      <a href="/faq">FAQ</a>
      <a href="/privacy">${t('隱私政策', 'Privacy')}</a>
      <a href="/changelog">${t('更新日誌', 'Changelog')}</a>
    <a href="/skill">${t('🤖 AI 客服手冊', '🤖 AI Manual')}</a>
    <a href="/feedback">${t('📬 問題回報', '📬 Feedback')}</a>
    <a href="/reports">${t('📋 我的報告', '📋 My Reports')}</a>
    </div>
    <div style="margin-top:8px;color:#555;">© 2026 BugEzy</div>
  </footer>
</div>
</body>
</html>`;
}

// ── PM-174：問題回報頁（GET /feedback）+ POST /api/feedback（存 Supabase feedback 表，不需登入）──
function feedbackPage(lang: PageLang): string {
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-Hant' : 'en'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('問題回報 · BugEzy', 'Feedback · BugEzy')}</title>
<meta name="description" content="${t('回報 BugEzy 的問題或提出功能建議。', 'Report bugs or suggest features for BugEzy.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
<link rel="canonical" href="https://bugezy.dev/feedback">
${ogMeta('/feedback', 'Feedback — BugEzy', 'Share your feedback and help improve BugEzy.')}
<style>
  * { box-sizing: border-box; }
  .lang-switch { position:fixed; top:14px; right:16px; z-index:10; background:#1a1a2e; border:1px solid #7c3aed; border-radius:8px; padding:5px 12px; font-size:13px; color:#c4b5fd; text-decoration:none; }
  .lang-switch:hover { background:#2a2a3e; }
  body { margin:0; padding:0; background:#0f0f1a; color:#e8e8f0; font-family:system-ui,-apple-system,"Segoe UI","Microsoft JhengHei",sans-serif; line-height:1.7; font-size:15px; }
  .wrap { max-width:600px; margin:0 auto; padding:48px 24px 80px; }
  header { border-bottom:1px solid #2a2a3e; padding-bottom:20px; margin-bottom:24px; }
  .brand { font-size:24px; font-weight:700; color:#a78bfa; text-decoration:none; }
  h1 { font-size:26px; margin:16px 0 6px; }
  .lead { color:#8b8fa3; font-size:14px; margin:0 0 24px; }
  form { display:flex; flex-direction:column; gap:6px; }
  label { font-size:13px; color:#c4b5fd; font-weight:600; margin-top:12px; }
  input, select, textarea { background:#1a1a2e; border:1px solid #2a2a3e; border-radius:8px; padding:10px 12px; color:#e8e8f0; font-size:14px; font-family:inherit; width:100%; }
  input:focus, select:focus, textarea:focus { outline:none; border-color:#7c3aed; }
  textarea { resize:vertical; }
  button { margin-top:20px; background:#7c3aed; color:#fff; border:none; border-radius:10px; padding:12px; font-size:15px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:0.5; cursor:not-allowed; }
  .msg { margin-top:16px; padding:12px; border-radius:8px; text-align:center; font-size:14px; display:none; }
  .msg.ok { background:rgba(34,197,94,0.12); border:1px solid rgba(34,197,94,0.4); color:#22c55e; }
  .msg.err { background:rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.4); color:#ef4444; }
  .char-hint { font-size:11px; color:#666; text-align:right; margin-top:2px; }
  footer { margin-top:40px; padding-top:20px; border-top:1px solid #2a2a3e; color:#8b8fa3; font-size:13px; }
  footer a { color:#a78bfa; margin-right:14px; }
</style>
</head>
<body>
<a class="lang-switch" href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t('EN', '中文')}</a>
<div class="wrap">
  <header><a class="brand" href="/">🐛 BugEzy</a></header>
  <h1>${t('📬 問題回報', '📬 Feedback')}</h1>
  <p class="lead">${t('遇到問題或有建議？告訴我們！', 'Found a bug or have a suggestion? Let us know!')}</p>
  <form id="feedback-form">
    <label for="fb-email">${t('Email（選填，方便我們回覆）', 'Email (optional, so we can reply)')}</label>
    <input type="email" id="fb-email" name="email" placeholder="you@example.com" maxlength="200" />
    <label for="fb-category">${t('類型', 'Category')}</label>
    <select id="fb-category" name="category">
      <option value="bug">${t('🐛 Bug 回報', '🐛 Bug Report')}</option>
      <option value="feature">${t('💡 功能建議', '💡 Feature Request')}</option>
      <option value="question">${t('❓ 使用問題', '❓ Question')}</option>
      <option value="other">${t('📝 其他', '📝 Other')}</option>
    </select>
    <label for="fb-message">${t('描述', 'Description')}</label>
    <textarea id="fb-message" name="message" rows="6" required maxlength="5000" placeholder="${t('請描述你遇到的問題或建議…', 'Describe the issue or suggestion…')}"></textarea>
    <div class="char-hint"><span id="fb-count">0</span>/5000</div>
    <button type="submit" id="fb-submit">${t('📤 送出', '📤 Submit')}</button>
  </form>
  <div class="msg ok" id="fb-ok">${t('✅ 感謝回報！我們會盡快處理。', '✅ Thanks for your feedback! We will get on it soon.')}</div>
  <div class="msg err" id="fb-err"></div>
  <footer>
    <a href="/">${t('首頁', 'Home')}</a>
    <a href="/faq">FAQ</a>
    <a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a>
  </footer>
</div>
<script>
  var form = document.getElementById('feedback-form');
  var msgEl = document.getElementById('fb-message');
  var countEl = document.getElementById('fb-count');
  var okBox = document.getElementById('fb-ok');
  var errBox = document.getElementById('fb-err');
  var submitBtn = document.getElementById('fb-submit');
  msgEl.addEventListener('input', function () { countEl.textContent = String(msgEl.value.length); });
  var ERR_EMPTY = ${JSON.stringify(t('請填寫問題描述', 'Please enter a description'))};
  var ERR_LONG = ${JSON.stringify(t('描述過長，請控制在 5000 字內', 'Too long — please keep it under 5000 characters'))};
  var ERR_FAIL = ${JSON.stringify(t('送出失敗，請稍後再試', 'Submit failed, please try again later'))};
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errBox.style.display = 'none';
    var message = msgEl.value.trim();
    if (!message) { errBox.textContent = ERR_EMPTY; errBox.style.display = 'block'; return; }
    if (message.length > 5000) { errBox.textContent = ERR_LONG; errBox.style.display = 'block'; return; }
    submitBtn.disabled = true;
    fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('fb-email').value.trim(),
        category: document.getElementById('fb-category').value,
        message: message,
      }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d.ok) { form.style.display = 'none'; okBox.style.display = 'block'; }
        else { errBox.textContent = (res.d && res.d.error) || ERR_FAIL; errBox.style.display = 'block'; submitBtn.disabled = false; }
      })
      .catch(function () { errBox.textContent = ERR_FAIL; errBox.style.display = 'block'; submitBtn.disabled = false; });
  });
</script>
</body>
</html>`;
}

// POST /api/feedback → 存 Supabase feedback 表（不需登入，降低回報門檻；CF /api/ 有 rate limit）。
async function handleFeedback(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    email?: string;
    category?: string;
    message?: string;
  } | null;
  if (!body || !body.message || !body.message.trim() || !body.category) {
    return json({ error: '請填寫問題描述 / Please enter a description' }, 400);
  }
  if (body.message.length > 5000) {
    return json({ error: '描述過長，請控制在 5000 字內 / Too long (max 5000 chars)' }, 400);
  }
  const { error } = await supa(env)
    .from('feedback')
    .insert({
      email: body.email?.slice(0, 200) || null,
      category: String(body.category).slice(0, 50),
      message: body.message.slice(0, 5000),
      user_agent: request.headers.get('User-Agent')?.slice(0, 500) || '',
      country: cfCountry(request), // PM-172 helper
    });
  if (error) {
    console.error('feedback insert failed:', error.message); // 原始錯誤只記 log（PM-130 脫敏）
    return json({ error: GENERIC_500 }, 500);
  }
  return json({ ok: true });
}

// ── PM-184：「我的報告」列表頁（GET /reports?token=…）——需 session token 驗證，server 端渲染，私人頁（noindex + no-store）──
function reportsShell(lang: PageLang, bodyHtml: string, langSwitchHref: string): Response {
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  const page = `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-Hant' : 'en'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${t('我的報告 · BugEzy', 'My Reports · BugEzy')}</title>
${ogMeta('/reports', 'My Bug Reports — BugEzy', 'View and manage your captured bug reports.')}
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:0; background:#0f0f1a; color:#e8e8f0; font-family:system-ui,-apple-system,"Segoe UI","Microsoft JhengHei",sans-serif; line-height:1.6; font-size:15px; }
  .wrap { max-width:920px; margin:0 auto; padding:40px 24px 80px; }
  .lang-switch { position:fixed; top:14px; right:16px; background:#1a1a2e; border:1px solid #7c3aed; border-radius:8px; padding:5px 12px; font-size:13px; color:#c4b5fd; text-decoration:none; }
  header { border-bottom:1px solid #2a2a3e; padding-bottom:16px; margin-bottom:20px; }
  .brand { font-size:22px; font-weight:700; color:#a78bfa; text-decoration:none; }
  h1 { font-size:24px; margin:14px 0 4px; }
  .count { color:#8b8fa3; font-size:14px; margin:0; }
  .empty, .notice { text-align:center; color:#8b8fa3; padding:40px 20px; }
  .notice a { color:#a78bfa; }
  .reports-table { width:100%; border-collapse:collapse; margin-top:16px; }
  .reports-table th { background:#1a1a2e; color:#c4b5fd; padding:10px 12px; text-align:left; font-size:13px; }
  .reports-table td { padding:10px 12px; border-bottom:1px solid #21262d; font-size:13px; color:#e6edf3; vertical-align:top; }
  .reports-table tr:hover td { background:rgba(124,58,237,0.05); }
  .reports-table a { color:#7c3aed; text-decoration:none; }
  .reports-table a:hover { text-decoration:underline; }
  .badges { white-space:nowrap; font-size:13px; }
  /* PM-196：勾選刪除 */
  .col-cb { width:34px; text-align:center; }
  .reports-table td.col-cb, .reports-table th.col-cb { text-align:center; padding-left:8px; padding-right:8px; }
  .report-cb, #selectAll { width:16px; height:16px; accent-color:#7c3aed; cursor:pointer; }
  .delete-bar { display:flex; justify-content:flex-end; margin-top:16px; }
  .delete-btn { background:#da3633; color:#fff; border:none; border-radius:8px; padding:9px 16px; font-size:14px; font-weight:600; cursor:pointer; }
  .delete-btn:hover { background:#f85149; }
  .delete-btn:disabled { background:#3a2a2a; color:#8b8fa3; cursor:not-allowed; }
  @media (max-width:640px) { .col-desc, .col-time { display:none; } }
</style>
</head>
<body>
<a class="lang-switch" href="${escapeAttr(langSwitchHref)}">${t('EN', '中文')}</a>
<div class="wrap">
  <header><a class="brand" href="/">🐛 BugEzy</a></header>
  ${bodyHtml}
</div>
</body>
</html>`;
  const res = html(page); // html() 已含 CSP
  res.headers.set('Cache-Control', 'no-store'); // 私人頁不快取
  return res;
}

// PM-187（P0 資安）：token 不再放 URL query。頁面改為 client 端 bootstrap shell——
//   resolveSessionToken() 依序讀 ?token= / #token= / localStorage，讀到 URL 上的 token 立即存
//   localStorage 並 history.replaceState 清掉（不留歷史/Referrer/截圖洩漏），再以 Authorization
//   header 打 GET /api/my-reports 取資料、client 端渲染表格。無 token → 顯示登入提示。
async function reportsPage(request: Request, env: Env): Promise<Response> {
  const lang = getLang(request);
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  // 語言切換只帶 lang，絕不帶 token
  const switchHref = `?lang=${lang === 'zh' ? 'en' : 'zh'}`;

  // client 端字串（JSON.stringify 內嵌，安全）
  const T = {
    loading: t('載入中…', 'Loading…'),
    loginRequired: t('請先從 BugEzy 擴充登入', 'Please log in from the BugEzy extension first'),
    hint: t(
      '請從 BugEzy Chrome 擴充的「📋 我的報告」按鈕開啟此頁面。',
      'Please open this page from the "📋 My Reports" button in the BugEzy Chrome extension.',
    ),
    expired: t('登入已過期，請重新從擴充開啟。', 'Session expired — please reopen from the extension.'),
    loadError: t('載入失敗，請稍後再試。', 'Failed to load — please try again later.'),
    empty: t('還沒有報告，去錄製你的第一個 Bug 吧！', 'No reports yet. Record your first bug!'),
    countOne: t('共 1 份報告', '1 report'),
    countN: t('共 {n} 份報告', '{n} reports'),
    untitled: t('未命名', 'Untitled'),
    thTime: t('時間', 'Time'),
    thTitle: t('標題 / 頁面', 'Title / Page'),
    thDesc: t('描述', 'Description'),
    thContent: t('內容', 'Content'),
    thAction: t('操作', 'Action'),
    view: t('查看', 'View'),
    // PM-196：批次刪除
    selectAll: t('全選', 'Select all'),
    del: t('🗑️ 刪除選取', '🗑️ Delete selected'),
    delConfirm: t('確定要刪除 {n} 份報告嗎？此操作無法還原。', 'Delete {n} report(s)? This cannot be undone.'),
    deleting: t('刪除中…', 'Deleting…'),
    delFail: t('刪除失敗，請稍後再試。', 'Delete failed — please try again later.'),
  };

  // 注意：以下為內嵌 client script，全程用 textContent/DOM 建表（XSS 安全），fetch 帶 Bearer header。
  const script = `<script>
(function(){
  var LS_KEY = 'bugezy_session_token';
  var container = document.getElementById('reportsContainer');
  var countEl = document.getElementById('reportCount');
  var T = ${JSON.stringify(T)};

  // §2/§3 共用：解析 session token（優先讀 URL 上的新鮮注入，讀到即存 localStorage 並清 URL）
  function resolveSessionToken(){
    var url = new URL(location.href);
    var fromQuery = url.searchParams.get('token');
    var fromHash = null;
    if (location.hash && location.hash.indexOf('token=') !== -1) {
      try { fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('token'); } catch(e){}
    }
    var injected = fromQuery || fromHash;
    if (injected) {
      try { localStorage.setItem(LS_KEY, injected); } catch(e){}
      // 清掉 URL 上的 token（保留 lang 等其他參數），並清 hash
      url.searchParams.delete('token');
      var clean = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '');
      try { history.replaceState(null, '', clean); } catch(e){}
      return injected;
    }
    try { return localStorage.getItem(LS_KEY); } catch(e){ return null; }
  }

  function showNotice(msg, withHint){
    container.textContent = '';
    countEl.textContent = '';
    var d = document.createElement('div');
    d.className = 'notice';
    d.textContent = msg;
    container.appendChild(d);
    if (withHint) {
      var h = document.createElement('div');
      h.className = 'notice';
      h.style.fontSize = '13px';
      h.textContent = T.hint;
      container.appendChild(h);
    }
  }

  function pad(n){ return (n < 10 ? '0' : '') + n; }
  function fmtDate(iso){
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function badgesFor(r){
    var parts = [];
    if ((r.console_count||0) > 0) parts.push('❌' + r.console_count);
    if ((r.network_count||0) > 0) parts.push('🌐' + r.network_count);
    if ((r.voice_count||0) > 0) parts.push('🎙️');
    if ((r.screenshot_count||0) > 0) parts.push('📸');
    if ((r.rrweb_count||0) > 0) parts.push('🎬');
    return parts.join(' ');
  }

  function reportLink(id, text){
    var a = document.createElement('a');
    a.href = '/report/' + encodeURIComponent(id);
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    return a;
  }

  var token = null; // PM-196：供刪除 API 用（下方 resolveSessionToken 後賦值）

  // PM-196：依勾選狀態更新底部刪除列（≥1 勾才顯示）+ 全選 checkbox 同步
  function updateDeleteBar(){
    var boxes = document.querySelectorAll('.report-cb');
    var checked = 0;
    boxes.forEach(function(b){ if (b.checked) checked++; });
    var bar = document.getElementById('deleteBar');
    var btn = document.getElementById('deleteSelected');
    var cnt = document.getElementById('delCount');
    if (bar) bar.style.display = checked > 0 ? 'flex' : 'none';
    if (btn) btn.disabled = checked === 0;
    if (cnt) cnt.textContent = checked;
    var sa = document.getElementById('selectAll');
    if (sa) sa.checked = boxes.length > 0 && checked === boxes.length;
  }

  function renderTable(list){
    container.textContent = '';
    var n = list.length;
    countEl.textContent = n === 1 ? T.countOne : T.countN.replace('{n}', n);

    var table = document.createElement('table');
    table.className = 'reports-table';
    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    // PM-196：全選 checkbox 欄（表頭）
    var thCb = document.createElement('th'); thCb.className = 'col-cb';
    if (n > 0) {
      var selAll = document.createElement('input'); selAll.type = 'checkbox'; selAll.id = 'selectAll'; selAll.title = T.selectAll;
      selAll.addEventListener('change', function(){
        document.querySelectorAll('.report-cb').forEach(function(b){ b.checked = selAll.checked; });
        updateDeleteBar();
      });
      thCb.appendChild(selAll);
    }
    htr.appendChild(thCb);
    [['col-time', T.thTime], ['', T.thTitle], ['col-desc', T.thDesc], ['', T.thContent], ['', T.thAction]].forEach(function(h){
      var th = document.createElement('th');
      if (h[0]) th.className = h[0];
      th.textContent = h[1];
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    if (n === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 6; td.className = 'empty'; td.textContent = T.empty;
      tr.appendChild(td); tbody.appendChild(tr);
    } else {
      list.forEach(function(r){
        var tr = document.createElement('tr');
        var title = r.title || r.url || T.untitled;
        var desc = r.description ? String(r.description).slice(0, 60) : '';

        // PM-196：每行勾選框（帶 report_id）
        var tdCb = document.createElement('td'); tdCb.className = 'col-cb';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'report-cb';
        cb.setAttribute('data-id', r.report_id);
        cb.addEventListener('change', updateDeleteBar);
        tdCb.appendChild(cb);

        var tdTime = document.createElement('td'); tdTime.className = 'col-time'; tdTime.textContent = fmtDate(r.created_at);
        var tdTitle = document.createElement('td'); tdTitle.appendChild(reportLink(r.report_id, title));
        var tdDesc = document.createElement('td'); tdDesc.className = 'col-desc'; tdDesc.textContent = desc;
        var tdBadge = document.createElement('td'); tdBadge.className = 'badges'; tdBadge.textContent = badgesFor(r);
        var tdAct = document.createElement('td'); tdAct.appendChild(reportLink(r.report_id, T.view));

        tr.appendChild(tdCb); tr.appendChild(tdTime); tr.appendChild(tdTitle); tr.appendChild(tdDesc); tr.appendChild(tdBadge); tr.appendChild(tdAct);
        tbody.appendChild(tr);
      });
    }
    table.appendChild(tbody);
    container.appendChild(table);
    updateDeleteBar();
  }

  // PM-196：底部「🗑️ 刪除選取 (N)」→ 確認 → DELETE /api/reports（Bearer + report_ids）→ 重載列表
  var deleteBtn = document.getElementById('deleteSelected');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', function(){
      var ids = [];
      document.querySelectorAll('.report-cb').forEach(function(b){ if (b.checked) ids.push(b.getAttribute('data-id')); });
      if (ids.length === 0) return;
      if (!confirm(T.delConfirm.replace('{n}', ids.length))) return;
      deleteBtn.disabled = true;
      fetch('/api/reports', {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ report_ids: ids })
      }).then(function(res){
        if (!res.ok) throw new Error('http ' + res.status);
        location.reload(); // token 在 localStorage，reload 後 resolveSessionToken 正常
      }).catch(function(){
        deleteBtn.disabled = false;
        alert(T.delFail);
      });
    });
  }

  token = resolveSessionToken();
  if (!token) { showNotice(T.loginRequired, true); return; }

  fetch('/api/my-reports', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(res){
      if (res.status === 401) { try { localStorage.removeItem(LS_KEY); } catch(e){} showNotice(T.expired, true); return null; }
      if (!res.ok) throw new Error('http ' + res.status);
      return res.json();
    })
    .then(function(data){ if (data) renderTable(data.reports || []); })
    .catch(function(){ showNotice(T.loadError); });
})();
</script>`;

  const body = `<h1>${t('📋 我的報告', '📋 My Reports')}</h1>
    <p class="count" id="reportCount"></p>
    <div id="reportsContainer"><div class="notice">${T.loading}</div></div>
    <div id="deleteBar" class="delete-bar" style="display:none;">
      <button id="deleteSelected" class="delete-btn" disabled>${T.del} (<span id="delCount">0</span>)</button>
    </div>
    ${script}`;

  return reportsShell(lang, body, switchHref);
}

// PM-187：JSON 資料端點（Bearer 驗證）——供 /reports client shell 取自己的報告列表。私人資料 no-store。
async function myReportsApi(request: Request, env: Env): Promise<Response> {
  const userId = await verifySession(request, env);
  if (!userId) return jsonNoStore({ error: 'unauthorized' }, 401);

  const { data: reports } = await supa(env)
    .from('reports')
    .select(
      'report_id, url, title, description, created_at, console_count, network_count, voice_count, screenshot_count, rrweb_count',
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);

  return jsonNoStore({ reports: reports || [] });
}

// PM-196：批次刪除自己的報告（Bearer 驗證 + owner 過濾 + 最多 50 筆）。只刪 DB 列 → getReport 即 404（報告消失）。
async function deleteReportsApi(request: Request, env: Env): Promise<Response> {
  const userId = await verifySession(request, env);
  if (!userId) return jsonNoStore({ error: 'unauthorized' }, 401);
  let parsed: { report_ids?: unknown };
  try {
    parsed = (await request.json()) as { report_ids?: unknown };
  } catch {
    return jsonNoStore({ error: 'invalid_body' }, 400);
  }
  const ids = Array.isArray(parsed.report_ids)
    ? parsed.report_ids.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 50) // 最多 50 筆
    : [];
  if (ids.length === 0) return jsonNoStore({ error: 'no_ids' }, 400);
  // .eq(user_id) 確保只刪自己的報告（別人的 id 帶進來也刪不到）；.select 回傳實際刪除筆數
  const { data, error } = await supa(env)
    .from('reports')
    .delete()
    .eq('user_id', userId)
    .in('report_id', ids)
    .select('report_id');
  if (error) {
    console.error('deleteReportsApi failed:', error.message); // 原始錯誤只記 log
    return jsonNoStore({ error: 'delete_failed' }, 500);
  }
  return jsonNoStore({ deleted: (data as Array<{ report_id: string }> | null)?.length ?? 0 });
}

// ── PM-59：Server 直接 serve 報告頁 HTML（vanilla JS 讀 /api/reports/:id 渲染）──
// ⚠ 規格 HTML 讀 snake_case（console_logs / rrweb_count），但 GET /api/reports/:id 實際回
// camelCase（consoleLogs / networkErrors / voiceTranscript / rrwebEvents）——已實測確認。
// 直接照規格部署會整頁空白，故此處欄位名改為 camelCase 以正確渲染資料。
// PM-168：報告頁多語系（getLang 偵測 + data-bugezy-lang 傳給 report-page.js）。
// UI 標籤翻譯；報告內容（console/network/voice 等使用者原始資料）不翻。
function reportPageHtml(lang: PageLang): string {
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-Hant' : 'en'}" data-bugezy-lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${t('BugEzy — Bug 報告', 'BugEzy — Bug Report')}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#0f0f1a; color:#e0e0e0; font-family:system-ui,"Microsoft JhengHei",sans-serif; }
    /* PM-196：分享連結複製列 */
    .share-box { max-width:1100px; margin:0 auto 40px; padding:0 24px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .share-box .share-label { color:#8b949e; font-size:14px; white-space:nowrap; }
    .share-box input { flex:1; min-width:200px; background:#0d1117; border:1px solid #30363d; border-radius:8px; padding:9px 12px; color:#c9d1d9; font-size:13px; font-family:monospace; }
    .share-copy-btn { background:#238636; color:#fff; border:none; border-radius:8px; padding:9px 16px; font-size:14px; font-weight:600; cursor:pointer; white-space:nowrap; }
    .share-copy-btn:hover { background:#2ea043; }
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
    /* PM-188：非會員閱讀他人分享報告的付費牆 */
    .paywall { max-width:520px; margin:60px auto; padding:40px 32px; background:#161b22; border:1px solid #30363d; border-radius:16px; text-align:center; }
    .paywall-icon { font-size:48px; line-height:1; margin-bottom:16px; }
    .paywall h2 { font-size:20px; color:#f0f6fc; margin-bottom:12px; }
    .paywall-desc { font-size:15px; color:#c9d1d9; margin-bottom:6px; }
    .paywall-sub { font-size:14px; color:#8b949e; margin-bottom:24px; }
    .paywall-cta { display:flex; gap:12px; justify-content:center; flex-wrap:wrap; margin-bottom:20px; }
    .paywall-btn { display:inline-block; padding:11px 22px; border-radius:10px; font-size:15px; font-weight:600; text-decoration:none; transition:filter 0.15s; }
    .paywall-btn:hover { filter:brightness(1.1); }
    .paywall-btn.primary { background:#7c3aed; color:#fff; }
    .paywall-btn.secondary { background:#21262d; color:#c9d1d9; border:1px solid #30363d; }
    .paywall-note { font-size:13px; color:#6e7681; }
    .empty { text-align:center; padding:24px; color:#555; font-size:13px; }
    .lang-switch { margin-left:auto; background:#1a1a2e; border:1px solid #7c3aed; border-radius:8px; padding:4px 12px; font-size:13px; color:#c4b5fd; text-decoration:none; }
    .lang-switch:hover { background:#2a2a3e; }
  </style>
</head>
<body>
  <div class="topbar">
    <span class="topbar-brand">🐛 BugEzy</span>
    <span class="topbar-title">${t('Bug 報告', 'Bug Report')}</span>
    <a class="lang-switch" href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t('EN', '中文')}</a>
  </div>
  <div class="report" id="app">
    <div class="loading" id="loading">${t('載入中…', 'Loading…')}</div>
  </div>
  <!-- PM-196：分享報告連結 + 一鍵複製（select+execCommand，非 clipboard API；複製邏輯在 report-page.js，因報告頁 CSP script-src 'self' 不允許 inline onclick）。預設隱藏，render 成功才顯示。 -->
  <div id="share-box" class="share-box" style="display:none;">
    <span class="share-label">${t('📤 分享報告連結：', '📤 Share report link:')}</span>
    <input id="share-url" type="text" readonly />
    <button id="share-copy" class="share-copy-btn">${t('📋 複製連結', '📋 Copy link')}</button>
  </div>
  <!-- PM-99：截圖點擊頁內 lightbox（base64 data URL 無法 window.open，會開空白頁；改頁內放大）。PM-166：onclick 改由 report-page.js addEventListener -->
  <div id="bugezy-lightbox" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.85);cursor:zoom-out;align-items:center;justify-content:center;">
    <img id="bugezy-lightbox-img" style="max-width:95vw;max-height:95vh;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,0.5);" />
  </div>
  <!-- PM-166：全部 client 邏輯（render + lightbox）抽到外部檔，CSP script-src 'self' 才能拿掉 unsafe-inline。
       PM-168：加 ?v 版本號——report-page.js 快取 1 天，改版時 bump 版本強制邊緣快取失效（否則新 HTML 配舊 JS）。 -->
  <script src="/report-page.js?v=196"></script>
</body>
</html>`;
}

// ── PM-166（Fable5）：報告頁 client 邏輯抽成外部檔（/report-page.js），CSP script-src 改 'self'（拿掉 unsafe-inline）。
//    原 inline onclick（截圖 openLightbox / lightbox 背景 closeLightbox）改事件委派/addEventListener——
//    CSP script-src 'self' 不允許 inline event handler，故一併轉出。
const REPORT_PAGE_JS = `
    const reportId = location.pathname.split('/report/')[1];
    const API = location.origin;

    // PM-168：語言由 server 注入 <html data-bugezy-lang>（CSP script-src 'self' 不能 inline script 傳值）。
    // 只翻 UI 標籤；報告內容（console/network/voice/title/description）為使用者原始資料，不翻。
    const LANG = document.documentElement.getAttribute('data-bugezy-lang') === 'en' ? 'en' : 'zh';
    function t(zh, en) { return LANG === 'en' ? en : zh; }

    // PM-188：分享閱讀權限——帶 session token 證明 owner / 付費會員身分。
    //   token 來源同 PM-187：URL fragment（#token=，讀完清）優先，否則 bugezy.dev localStorage（同源，開自己列表時已存）。
    //   分享連結本身不帶 token（§7），非 owner 訪客會拿到 403 → 顯示付費牆。
    var LS_KEY = 'bugezy_session_token';
    function resolveSessionToken() {
      try {
        var url = new URL(location.href);
        var fromHash = null;
        if (location.hash && location.hash.indexOf('token=') !== -1) {
          try { fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('token'); } catch (e) {}
        }
        var injected = url.searchParams.get('token') || fromHash;
        if (injected) {
          try { localStorage.setItem(LS_KEY, injected); } catch (e) {}
          url.searchParams.delete('token');
          var clean = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '');
          try { history.replaceState(null, '', clean); } catch (e) {}
          return injected;
        }
        return localStorage.getItem(LS_KEY);
      } catch (e) { return null; }
    }

    function renderPaywall(code) {
      var isLogin = code === 'login_required';
      var sub = isLogin
        ? t('請登入 BugEzy 並升級會員才能閱讀', 'Please log in to BugEzy and upgrade to read this report')
        : t('升級會員即可閱讀他人分享的報告', 'Upgrade to read reports shared by others');
      var h = '<div class="paywall">';
      h += '<div class="paywall-icon">🔒</div>';
      h += '<h2>' + t('此報告需要會員權限才能閱讀', 'This report requires a membership to read') + '</h2>';
      h += '<p class="paywall-desc">' + t('BugEzy 會員可以閱讀他人分享的除錯報告', 'BugEzy members can read debug reports shared by others') + '</p>';
      h += '<p class="paywall-sub">' + sub + '</p>';
      h += '<div class="paywall-cta">';
      h += '<a class="paywall-btn primary" href="' + API + '/install">' + t('免費安裝 BugEzy', 'Install BugEzy free') + '</a>';
      h += '<a class="paywall-btn secondary" href="' + API + '/#pricing">' + t('了解會員方案', 'View plans') + '</a>';
      h += '</div>';
      h += '<p class="paywall-note">' + t('已經是會員？請從 BugEzy 擴充登入', 'Already a member? Please log in from the BugEzy extension') + '</p>';
      h += '</div>';
      document.getElementById('app').innerHTML = h;
    }

    var __token = resolveSessionToken();
    var __headers = __token ? { 'Authorization': 'Bearer ' + __token } : {};
    fetch(API + '/api/reports/' + reportId, { headers: __headers })
      .then(function (r) {
        if (r.status === 403) {
          return r.json().then(function (b) { renderPaywall(b && b.error); return null; }, function () { renderPaywall(null); return null; });
        }
        if (!r.ok) throw new Error('not found');
        return r.json();
      })
      .then(function (r) { if (r) render(r); })
      .catch(function () {
        document.getElementById('app').innerHTML = '<div class="error-msg">' + t('找不到報告', 'Report not found') + '</div>';
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
    // PM-160：加 " ' 轉義——esc 也用於屬性值（src/href），只轉 < > & 無法擋 x" onerror=（Stored XSS 縱深防禦）
    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

    function render(r) {
      const consoleCount = r.consoleLogs?.length || 0;
      const networkCount = r.networkErrors?.length || 0;
      const voiceCount = r.voiceTranscript?.length || 0;
      const ssCount = r.screenshots?.length || 0;
      const markers = r.markers || [];

      let html = '<div class="header">';
      html += '<h1>' + esc(r.title || t('（無標題）', '(untitled)')) + '</h1>';
      html += '<div class="meta">';
      html += '<div>' + t('URL：', 'URL: ') + '<a href="'+esc(r.url)+'" target="_blank">'+esc(r.url)+'</a></div>';
      html += '<div>'+esc(r.browser||'')+(r.screen_size ? ' ｜ '+esc(r.screen_size) : '')+'</div>'; // PM-219 修復5：screen_size 補 esc
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
        html += '<div class="info-section"><h3>' + t('💬 描述', '💬 Description') + '</h3><p>'+esc(r.description)+'</p></div>';
      }
      if (markers.length > 0) {
        html += '<div class="info-section"><h3>' + t('📌 時間軸標記', '📌 Timeline Markers') + '</h3>';
        markers.forEach(m => {
          const min = Math.floor(m.time_sec/60);
          const sec = String(m.time_sec%60).padStart(2,'0');
          html += '<div class="marker-item"><span class="marker-time">'+min+':'+sec+'</span><span>'+esc(m.note||t('（無描述）','(no note)'))+'</span></div>';
        });
        html += '</div>';
      }
      if (r.networkSnapshot) {
        var ns = r.networkSnapshot;
        var nsStart = ns.atStart || ns; // 相容單一/雙時間點
        var nsEnd = ns.atEnd;
        var fmtNet = function (x) {
          if (!x) return '';
          var online = x.online ? t('🟢 在線', '🟢 Online') : t('🔴 離線', '🔴 Offline');
          var typ = (x.type && x.type !== 'unknown') ? x.type
            : (x.effectiveType && x.effectiveType !== 'unknown' ? String(x.effectiveType).toUpperCase() : t('未知','Unknown'));
          var rtt = (x.rtt != null) ? x.rtt + 'ms' : '—';
          var dl = (x.downlink != null) ? x.downlink + ' Mbps' : '—';
          var save = x.saveData ? t(' · 省流量模式', ' · Data Saver') : '';
          return t('狀態：','Status: ') + online + t(' · 類型：',' · Type: ') + typ + t(' · 延遲：',' · Latency: ') + rtt + t(' · 頻寬：',' · Bandwidth: ') + dl + save;
        };
        html += '<div class="info-section"><h3>' + t('📡 網路環境', '📡 Network Environment') + '</h3><p>' + esc(fmtNet(nsStart));
        if (nsEnd && (nsEnd.online !== nsStart.online || nsEnd.effectiveType !== nsStart.effectiveType)) {
          html += '<br>' + t('結束時：','At end: ') + esc(fmtNet(nsEnd));
        }
        html += '</p></div>';
      }
      // PM-157：儲存狀態（值已在 extension 端遮罩，server 只顯示遮罩後結果）
      if (r.storageSnapshot) {
        var ss = r.storageSnapshot;
        var fmtItems = function (label, items) {
          var arr = Array.isArray(items) ? items : [];
          var h = '<div style="margin-bottom:8px"><strong>' + esc(label) + ' (' + arr.length + ' items)</strong>';
          if (arr.length) {
            h += '<ul style="margin:4px 0 0;padding-left:20px">';
            arr.forEach(function (it) {
              h += '<li><code>' + esc(String(it.key)) + '</code>: ' + esc(String(it.value)) +
                ' <span style="color:#8b949e">(' + (it.size != null ? it.size : 0) + ' chars)</span></li>';
            });
            h += '</ul>';
          }
          return h + '</div>';
        };
        html += '<div class="info-section"><h3>' + t('💾 儲存狀態', '💾 Storage State') + '</h3>';
        html += fmtItems('localStorage', ss.localStorage);
        html += fmtItems('sessionStorage', ss.sessionStorage);
        var cookieNames = Array.isArray(ss.cookieNames) ? ss.cookieNames : [];
        html += '<div><strong>Cookies: ' + (ss.cookieCount != null ? ss.cookieCount : cookieNames.length) + '</strong>' +
          (cookieNames.length ? ' <span style="color:#8b949e">(' + esc(cookieNames.join(', ')) + ')</span>' : '') + '</div>';
        html += '<p style="color:#8b949e;font-size:12px;margin-top:8px">' + t('🔒 敏感值（密碼/token/email/卡號）已於使用者端自動遮罩', '🔒 Sensitive values (passwords/tokens/email/card numbers) auto-masked on the client') + '</p>';
        html += '</div>';
      }
      html += '<div class="info-section"><h3>' + t('📊 摘要', '📊 Summary') + '</h3><div class="info-grid">';
      html += '<div>' + t('DOM 事件：','DOM events: ') + (r.rrwebEvents?.length||0)+'</div>';
      html += '<div>' + t('Console：','Console: ') + consoleCount+'</div>';
      html += '<div>' + t('Network：','Network: ') + networkCount+'</div>';
      html += '<div>' + t('語音：','Voice: ') + voiceCount + t(' 段',' segs') + '</div>';
      html += '<div>' + t('截圖：','Screenshots: ') + ssCount+'</div>';
      html += '</div></div></div>';

      html += '<div class="tab-panel'+(defaultTab==='console'?' active':'')+'" id="tab-console">';
      if (consoleCount === 0) {
        html += '<div class="empty">' + t('沒有 Console 錯誤 ✓', 'No console errors ✓') + '</div>';
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
        html += '<div class="empty">' + t('沒有 Network 錯誤 ✓', 'No network errors ✓') + '</div>';
      } else {
        (r.networkErrors||[]).forEach(err => {
          const cls = err.status >= 500 ? 's5xx' : 's4xx';
          html += '<div class="net-item"><span class="net-status '+cls+'">'+err.status+'</span><span class="net-method">'+esc(err.method)+'</span><span class="net-url">'+esc(err.url)+'</span><span class="net-duration">'+(err.duration||0)+'ms</span></div>';
        });
      }
      html += '</div>';

      html += '<div class="tab-panel'+(defaultTab==='voice'?' active':'')+'" id="tab-voice">';
      if (voiceCount === 0) {
        html += '<div class="empty">' + t('沒有語音記錄', 'No voice transcript') + '</div>';
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
          + '<span class="toggle-label">' + t('📸 高畫質 AI 分析（高 Token）', '📸 HQ AI Analysis (high token)') + '</span></label>'
          + '<p class="toggle-hint" id="toggle-hint">'+(allowImg
              ? t('✅ 已開啟 — AI 可看到截圖畫面，視覺 Bug 更精準（顏色、排版、CSS）', '✅ On — AI can see the screenshots, better for visual bugs (colors, layout, CSS)')
              : t('🔒 未開啟 — AI 只讀文字，省 Token。遇到視覺 Bug 再開啟', '🔒 Off — AI reads text only to save tokens. Enable for visual bugs'))+'</p>'
          + '<p class="toggle-token" id="toggle-token">'+(allowImg
              ? t('⚠️ 每張截圖約 3,000~8,000 tokens（'+ssCount+' 張 ≈ '+approxTok+' tokens）', '⚠️ ~3,000–8,000 tokens per screenshot ('+ssCount+' imgs ≈ '+approxTok+' tokens)')
              : t('💰 目前 AI 讀取此報告約 200~1,500 tokens', '💰 AI currently reads this report at ~200–1,500 tokens'))+'</p>'
          + '</div>';
        html += '<div class="ss-grid">';
        (r.screenshots||[]).forEach(ss => {
          const src = typeof ss === 'string' ? ss : ss.dataUrl || ss.url || '';
          if (src) html += '<img class="ss-img" title="'+t('點擊放大','Click to enlarge')+'" src="'+esc(src)+'" style="cursor:zoom-in;">'; // PM-160 esc 止血；PM-166 onclick 改事件委派；PM-168 title
        });
        html += '</div></div>';
      }

      html += '</div>';

      const voiceText = (r.voiceTranscript||[]).map(v=>v.text).join('');
      const consoleText = JSON.stringify(r.consoleLogs||[]);
      const networkText = JSON.stringify(r.networkErrors||[]);
      const descText = r.description || '';
      const items = [
        { label:t('🎤 語音記錄','🎤 Voice'), len:voiceText.length },
        { label:'🖥 Console', len:consoleText.length },
        { label:'🌐 Network', len:networkText.length },
        { label:t('📝 描述','📝 Description'), len:descText.length },
        { label:t('📹 DOM 摘要','📹 DOM Summary'), len:105 },
      ];
      let totalT = 0;
      let tokenHtml = '';
      items.forEach(it => {
        const tk = Math.ceil(it.len / 3.5);
        if (tk > 0) { totalT += tk; tokenHtml += '<div class="token-row"><span>'+it.label+'</span><span>~'+tk.toLocaleString()+' tokens</span></div>'; }
      });
      const chromeT = totalT * 15;
      const pct = chromeT > 0 ? Math.round((1-totalT/chromeT)*100) : 0;
      tokenHtml += '<div class="token-row total"><span>' + t('AI 讀取總計','AI Read Total') + '</span><span>~'+totalT.toLocaleString()+' tokens ≈ USD $'+((totalT*8/1e6).toFixed(4))+'</span></div>';
      html += '<div class="token-panel"><div style="font-weight:600;margin-bottom:8px;color:#a78bfa;">' + t('📊 Token 估算','📊 Token Estimate') + '</div>' + tokenHtml;
      html += '<div class="token-save">' + t('💡 同場景 Claude in Chrome：','💡 Same scenario, Claude in Chrome: ') + '~'+chromeT.toLocaleString()+' tokens ≈ USD $'+((chromeT*8/1e6).toFixed(4))+'<br>' + t('✅ BugEzy 為你省了 ','✅ BugEzy saved you ') + pct+'%</div></div>';

      document.getElementById('app').innerHTML = html;

      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
          btn.classList.add('active');
          document.getElementById('tab-' + btn.dataset.tab)?.classList.add('active');
        });
      });

      // PM-196：render 成功才顯示分享連結列；一鍵複製用 select+execCommand（非 clipboard API，避免 PM-192 的坑；無反斜線 regex）。
      var shareBox = document.getElementById('share-box');
      var shareInput = document.getElementById('share-url');
      if (shareBox && shareInput) {
        shareInput.value = location.origin + '/report/' + reportId;
        shareBox.style.display = 'flex';
        var shareBtn = document.getElementById('share-copy');
        if (shareBtn && !shareBtn.__wired) {
          shareBtn.__wired = true;
          var shareOrig = shareBtn.textContent;
          shareBtn.addEventListener('click', function () {
            shareInput.focus();
            shareInput.select();
            try { shareInput.setSelectionRange(0, 99999); } catch (e) {}
            try { document.execCommand('copy'); } catch (e) {}
            shareBtn.textContent = t('✅ 已複製！', '✅ Copied!');
            setTimeout(function () { shareBtn.textContent = shareOrig; }, 2000);
          });
        }
      }

      // PM-82/84：高畫質 AI 分析（高 Token）— 勾選即時更新提示 + PATCH 存回 Supabase
      const ssToggle = document.getElementById('allow-images-toggle');
      if (ssToggle) {
        ssToggle.addEventListener('change', async () => {
          const allow = ssToggle.checked;
          const cnt = (r.screenshots||[]).length;
          const ht = document.getElementById('toggle-hint');
          const tk = document.getElementById('toggle-token');
          if (ht) ht.textContent = allow
            ? t('✅ 已開啟 — AI 可看到截圖畫面，視覺 Bug 更精準（顏色、排版、CSS）', '✅ On — AI can see the screenshots, better for visual bugs (colors, layout, CSS)')
            : t('🔒 未開啟 — AI 只讀文字，省 Token。遇到視覺 Bug 再開啟', '🔒 Off — AI reads text only to save tokens. Enable for visual bugs');
          if (tk) tk.textContent = allow
            ? t('⚠️ 每張截圖約 3,000~8,000 tokens（'+cnt+' 張 ≈ '+(cnt*5000).toLocaleString()+' tokens）', '⚠️ ~3,000–8,000 tokens per screenshot ('+cnt+' imgs ≈ '+(cnt*5000).toLocaleString()+' tokens)')
            : t('💰 目前 AI 讀取此報告約 200~1,500 tokens', '💰 AI currently reads this report at ~200–1,500 tokens');
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

    // ── lightbox（PM-99）──
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
    // PM-166：原 inline onclick 改事件委派 / addEventListener（CSP script-src 'self' 不允許 inline handler）
    document.addEventListener('click', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('ss-img')) openLightbox(e.target.src);
    });
    (function () {
      var _lb = document.getElementById('bugezy-lightbox');
      if (_lb) _lb.addEventListener('click', closeLightbox);
    })();
`;

// ── PM-51：即時監控 live errors 暫存 ────────────────────────
// 改用 R2 單一物件（非全域 Map）：擴充 POST 與雲端 MCP GET 通常落在不同 Worker isolate，
// per-isolate Map 不共享（實測 POST 後即時 GET 仍 stale）；R2 對單一 key 有強讀後寫一致性，
// 才能讓「擴充推送 → AI 查」真的拿到資料。POST 覆蓋最新一筆，>30 秒視為過期（stale）。
// PM-143（P1-2）：改 per-user R2 key（原本全站共用單一 key → A 的 errors 被 B 讀到，含 stderr 密鑰）。
const liveErrorsKey = (userId: string) => `live-errors/${userId}/latest.json`;
interface LiveErrors {
  url?: string;
  title?: string;
  consoleLogs: unknown[];
  networkErrors: unknown[];
  timestamp?: number;
  updatedAt: number;
}

async function readLiveErrors(env: Env, userId: string): Promise<Record<string, unknown>> {
  const obj = await env.R2.get(liveErrorsKey(userId));
  const data = obj ? ((await obj.json()) as LiveErrors) : null;
  if (!data || Date.now() - data.updatedAt > 30_000) {
    return { consoleLogs: [], networkErrors: [], stale: true };
  }
  return { ...data, stale: false };
}

// ── PM-53：終端機 CLI agent 日誌暫存（R2；PM-143 改 per-user key）──
const terminalLogsKey = (userId: string) => `terminal-logs/${userId}/latest.json`;

// ── PM-167：server 端 stderr 遮罩（雙重防護，防舊版 CLI 未更新就上傳明文密碼/金鑰）──
//    規則與 CLI cli/src/pii-mask.ts 一致：DB URI 保 scheme+host、env 保 KEY 名、token/PII 整遮。
const SRV_DB_URI = /\b(mysql|postgres|postgresql|mongodb|redis|amqp|mssql):\/\/[^\s"']+/gi;
const SRV_ENV_KEYS =
  /\b(DATABASE_URL|DB_URL|DB_PASSWORD|DB_PASS|REDIS_URL|MONGO_URI|SQLALCHEMY_DATABASE_URI|SECRET_KEY|JWT_SECRET|API_KEY|API_SECRET|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|STRIPE_SECRET|OPENAI_API_KEY|GROQ_API_KEY|SUPABASE_SERVICE_ROLE_KEY|PRIVATE_KEY|CLIENT_SECRET)\s*[=:]\s*["']?[^\s"']+["']?/gi;
const SRV_TOKENS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\bghp_[A-Za-z0-9]{36,}\b/g,
  /\bgho_[A-Za-z0-9]{36,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]+/g,
  /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g,
];
const SRV_GENERAL_PII: RegExp[] = [
  /\b[\w.-]+@[\w.-]+\.\w{2,}\b/g,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  /\b09\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g,
  /\b[A-Z][12]\d{8}\b/g,
];
function serverMaskStderr(text: unknown): string {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  let m = text;
  m = m.replace(SRV_DB_URI, (match) => {
    try {
      const url = new URL(match);
      if (url.password) url.password = '***';
      if (url.username) url.username = '***';
      return url.toString();
    } catch {
      return match.replace(/:\/\/[^@]+@/, '://***:***@');
    }
  });
  m = m.replace(SRV_ENV_KEYS, (match) => {
    const eqIndex = match.search(/[=:]/);
    return eqIndex > 0 ? match.slice(0, eqIndex + 1) + ' ***MASKED***' : '***MASKED***';
  });
  for (const p of SRV_TOKENS) m = m.replace(p, '***MASKED***');
  for (const p of SRV_GENERAL_PII) m = m.replace(p, '***');
  return m;
}
/** PM-167：對整包 terminal-logs payload 做 server 端遮罩（logs[].message + command）。 */
function maskTerminalPayload(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  if (Array.isArray(out.logs)) {
    out.logs = (out.logs as Array<Record<string, unknown>>).map((log) =>
      log && typeof log === 'object' && typeof log.message === 'string'
        ? { ...log, message: serverMaskStderr(log.message) }
        : log,
    );
  }
  if (typeof out.command === 'string') out.command = serverMaskStderr(out.command);
  // PM-176：結構化錯誤（parsed_errors）雙重遮罩——CLI 已在遮罩後文字上解析，此為防舊/改版 CLI 的縱深。
  if (Array.isArray(out.parsed_errors)) {
    out.parsed_errors = (out.parsed_errors as Array<Record<string, unknown>>).map((e) => {
      if (!e || typeof e !== 'object') return e;
      const masked = { ...e };
      if (typeof masked.message === 'string') masked.message = serverMaskStderr(masked.message);
      if (typeof masked.raw === 'string') masked.raw = serverMaskStderr(masked.raw);
      if (Array.isArray(masked.frames)) {
        masked.frames = (masked.frames as Array<Record<string, unknown>>).map((f) =>
          f && typeof f === 'object' && typeof f.code === 'string'
            ? { ...f, code: serverMaskStderr(f.code) }
            : f,
        );
      }
      return masked;
    });
  }
  return out;
}

async function readTerminalLogs(env: Env, userId: string): Promise<Record<string, unknown>> {
  const obj = await env.R2.get(terminalLogsKey(userId));
  const data = obj ? ((await obj.json()) as { updatedAt?: number }) : null;
  if (!data || !data.updatedAt || Date.now() - data.updatedAt > 30_000) {
    return { logs: [], stale: true };
  }
  return { ...data, stale: false };
}

// PM-178：把 terminal-logs 資料組成結構化文字——先🖥環境（PM-177 runtime）、再🔍結構化錯誤（PM-176 parsed_errors，
// 含類型/訊息/堆疊 file:line in function + 程式碼），最後附原始 stderr（logs 為 TerminalLog[] 陣列 → 轉文字）。
function formatTerminalLogs(data: Record<string, unknown>): string {
  let result = '';

  const runtime = data.runtime as
    | { language?: string; version?: string; os?: string; packages?: string[] }
    | undefined;
  if (runtime && runtime.language) {
    result += `🖥 環境：${runtime.language} ${runtime.version || ''} / ${runtime.os || ''}\n`;
    if (Array.isArray(runtime.packages) && runtime.packages.length > 0) {
      result += `📦 套件：${runtime.packages.slice(0, 20).join(', ')}\n`;
    }
    result += '\n';
  }

  const parsed = data.parsed_errors as
    | Array<{
        type?: string;
        message?: string;
        frames?: Array<{ file?: string; line?: number; function?: string; code?: string }>;
      }>
    | undefined;
  if (Array.isArray(parsed) && parsed.length > 0) {
    result += `🔍 偵測到 ${parsed.length} 個錯誤：\n\n`;
    parsed.forEach((err, i) => {
      result += `--- 錯誤 ${i + 1} ---\n`;
      result += `類型：${err.type || '?'}\n`;
      result += `訊息：${err.message || ''}\n`;
      if (Array.isArray(err.frames) && err.frames.length > 0) {
        result += `堆疊：\n`;
        err.frames.forEach((f) => {
          result += `  → ${f.file}:${f.line} in ${f.function}()\n`;
          if (f.code) result += `    ${f.code}\n`;
        });
      }
      result += '\n';
    });
  }

  // 原始 stderr（logs 是 TerminalLog[] 陣列 → 取 message 串起；相容舊字串格式）
  const logs = data.logs;
  let rawText = '';
  if (Array.isArray(logs)) {
    rawText = (logs as Array<{ message?: string }>)
      .map((l) => (l && typeof l === 'object' ? l.message || '' : String(l)))
      .filter(Boolean)
      .join('\n');
  } else if (typeof logs === 'string') {
    rawText = logs;
  }
  if (rawText) result += `--- 原始 stderr ---\n${rawText}\n`;

  return result.trim() ? result : '目前沒有終端機錯誤記錄。';
}

// PM-179：Terminal 錯誤 AI 導航摘要（規則引擎，零成本，同 PM-159 精神）。
// 取 parsed_errors 最後一個為根因（最內層/最近拋出）→ 白話解釋 + 修復建議 + 位置（file 第 N 行）。
const PY_HINTS: Record<string, string> = {
  KeyError: '字典裡找不到這個 key → 檢查 key 是否拼錯，或先用 .get() 帶預設值',
  TypeError: '型別不對 → 檢查變數是否為 None、字串當數字用等',
  NameError: '變數或函式未定義 → 檢查拼寫、是否忘了 import',
  ImportError: '模組載入失敗 → 檢查是否 pip install 過、虛擬環境是否啟動',
  ModuleNotFoundError: '模組不存在 → pip install <模組名>',
  AttributeError: '物件沒有這個屬性 → 檢查物件型別是否正確',
  IndexError: '索引超出範圍 → 陣列長度不夠，檢查迴圈邊界',
  ValueError: '值不合法 → 檢查輸入資料格式',
  FileNotFoundError: '檔案不存在 → 檢查路徑是否正確',
  PermissionError: '權限不足 → 用管理員執行或檢查檔案權限',
  ConnectionError: '連線失敗 → 檢查網路、API URL、port 是否正確',
  TimeoutError: '逾時 → 伺服器回應太慢或網路問題',
  IntegrityError: '資料庫完整性錯誤 → 重複的 unique key 或缺少 NOT NULL 欄位',
  OperationalError: '資料庫操作失敗 → 連線池耗盡、查詢語法錯、資料庫鎖住',
  DoesNotExist: '查詢結果為空 → 資料庫沒這筆資料，檢查查詢條件',
  ValidationError: '驗證失敗 → 輸入資料不符合格式要求',
};
const NODE_HINTS: Record<string, string> = {
  TypeError: '型別錯誤 → 通常是 undefined/null 存取屬性，檢查 optional chaining',
  ReferenceError: '變數未定義 → 檢查 import/require 和拼寫',
  SyntaxError: '語法錯誤 → 檢查括號、逗號、引號',
  RangeError: '超出範圍 → stack overflow 或 array 超大',
  Error: '一般錯誤 → 看 message 內容判斷',
};
function generateTerminalSummary(data: Record<string, unknown>): string {
  const errors = (data.parsed_errors as Array<{
    type?: string;
    message?: string;
    frames?: Array<{ file?: string; line?: number; function?: string; code?: string }>;
  }>) || [];
  const runtime = (data.runtime as { language?: string; version?: string }) || {};
  const lines: string[] = ['🔍 Terminal Bug 導航摘要', ''];

  if (errors.length === 0) {
    lines.push('✅ 未偵測到結構化錯誤，請查看原始 stderr');
    return lines.join('\n');
  }

  // 最後一個錯誤通常是根因（Python：最近拋出；Node：最上層 Error）
  const rootError = errors[errors.length - 1];
  const hints = runtime.language === 'python' ? PY_HINTS : NODE_HINTS;
  const hint = rootError.type ? hints[rootError.type] || '' : '';

  lines.push(`⚡ 根因：${rootError.type || '?'}: ${rootError.message || ''}`);
  if (hint) lines.push(`💡 白話：${hint}`);

  // 指出哪個檔案第幾行（Python 最內層=frames 最後一個；Node 最上層=frames 第一個，取有 file 者）
  if (Array.isArray(rootError.frames) && rootError.frames.length > 0) {
    const innerFrame = rootError.frames[rootError.frames.length - 1];
    lines.push(`📍 位置：${innerFrame.file} 第 ${innerFrame.line} 行 → ${innerFrame.function}()`);
    if (innerFrame.code) lines.push(`   程式：${innerFrame.code}`);
  }

  if (runtime.language) lines.push(`🖥 環境：${runtime.language} ${runtime.version || ''}`.trim());

  if (errors.length > 1) {
    lines.push(`\n⚠ 共 ${errors.length} 個錯誤，以上為最可能的根因。完整錯誤見下方。`);
  }

  return lines.join('\n');
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

// PM-180：官方測試頁——涵蓋 PM-153~179 全部捕捉能力 + Python CLI 指引；中英雙語（getLang）。
function testPage1(lang: PageLang): string {
  const t = (zh: string, en: string) => (lang === 'zh' ? zh : en);
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-Hant' : 'en'}">
<head>
  <meta charset="utf-8">
  <title>${t('🧪 BugEzy 測試頁', '🧪 BugEzy Test Page')}</title>
  <style>${TEST_STYLE}
    .lang-switch { position:fixed; top:12px; right:12px; z-index:10; background:#1a1a2e; border:1px solid #7c3aed; border-radius:8px; padding:5px 12px; font-size:13px; color:#c4b5fd; text-decoration:none; }
    .section pre { background:#0f0f1a; color:#7ee0c5; padding:12px 14px; border-radius:8px; overflow-x:auto; font-size:12px; line-height:1.7; }
    .section h3 { font-size:14px; color:#555; margin:14px 0 6px; }</style>
</head>
<body>
  <a class="lang-switch" href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t('EN', '中文')}</a>
  <div class="page-id">${t('📍 測試頁 1', '📍 Test Page 1')}</div>

  <h1>${t('🧪 BugEzy 測試頁', '🧪 BugEzy Test Page')}</h1>
  <p class="subtitle">${t('完整測試 BugEzy 的所有捕捉能力 — 前端 + 後端 + AI 分析', "Test all of BugEzy's capture capabilities — frontend + backend + AI analysis")}</p>

  <!-- Console 測試 -->
  <div class="section">
    <h2>${t('🖥 Console 測試', '🖥 Console Test')}</h2>
    <div class="btn-grid">
      <button class="btn-error" onclick="console.error('❌ [TEST] TypeError: Cannot read property of undefined')">${t('觸發 console.error', 'Trigger console.error')}</button>
      <button class="btn-warn" onclick="console.warn('⚠ [TEST] Deprecated API usage detected')">${t('觸發 console.warn', 'Trigger console.warn')}</button>
      <button class="btn-error" onclick="console.error('❌ [TEST] Uncaught ReferenceError: foo is not defined')">${t('觸發 ReferenceError', 'Trigger ReferenceError')}</button>
      <button class="btn-error" onclick="try{null.toString()}catch(e){console.error('❌ [TEST]',e.message)}">${t('觸發真實 TypeError', 'Trigger real TypeError')}</button>
    </div>
    <div class="output" id="consoleOutput">${t('Console 輸出會顯示在這裡...', 'Console output appears here...')}</div>
  </div>

  <!-- Network 測試 -->
  <div class="section">
    <h2>${t('🌐 Network 測試', '🌐 Network Test')}</h2>
    <div class="btn-grid">
      <button class="btn-network" onclick="testFetch(404)">${t('觸發 fetch 404', 'Trigger fetch 404')}</button>
      <button class="btn-network" onclick="testFetch(500)">${t('觸發 fetch 500', 'Trigger fetch 500')}</button>
      <button class="btn-network" onclick="testFetch(403)">${t('觸發 fetch 403', 'Trigger fetch 403')}</button>
      <button class="btn-network" onclick="testXHR(404)">${t('觸發 XHR 404', 'Trigger XHR 404')}</button>
    </div>
    <div class="output" id="networkOutput">${t('Network 結果會顯示在這裡...', 'Network results appear here...')}</div>
  </div>

  <!-- DOM 變化測試 -->
  <div class="section">
    <h2>${t('🎨 DOM 變化測試（rrweb 會錄到）', '🎨 DOM Changes (recorded by rrweb)')}</h2>
    <div class="btn-grid">
      <button class="btn-dom" onclick="addElement()">${t('新增 DOM 元素', 'Add DOM element')}</button>
      <button class="btn-dom" onclick="removeElement()">${t('移除 DOM 元素', 'Remove DOM element')}</button>
      <button class="btn-dom" onclick="toggleAnimation()">${t('切換動畫', 'Toggle animation')}</button>
      <button class="btn-dom" onclick="changeColors()">${t('隨機變色', 'Randomize colors')}</button>
    </div>
    <div id="animBox">${t('動畫', 'Anim')}</div>
    <div class="test-area" id="domArea">
      <p>${t('DOM 測試區域 — 新增的元素會出現在這裡', 'DOM test area — new elements appear here')}</p>
    </div>
  </div>

  <!-- PM-154：Promise 靜默失敗 -->
  <div class="section">
    <h2>${t('⚡ Promise 靜默失敗測試', '⚡ Silent Promise Failure Test')}</h2>
    <p>${t('小白最常犯的 async/await 忘了 catch，BugEzy 也抓得到。', 'The classic async/await-without-catch mistake — BugEzy still catches it.')}</p>
    <div class="btn-grid">
      <button class="btn-error" onclick="Promise.reject('TEST: forgot to catch!')">${t('觸發 Unhandled Rejection（字串）', 'Trigger Unhandled Rejection (string)')}</button>
      <button class="btn-error" onclick="Promise.reject(new Error('TEST: async function failed'))">${t('觸發 Unhandled Rejection（Error）', 'Trigger Unhandled Rejection (Error)')}</button>
      <button class="btn-error" onclick="(async()=>{ throw new Error('TEST: async throw') })()">${t('觸發 async throw', 'Trigger async throw')}</button>
    </div>
  </div>

  <!-- PM-155：資源載入失敗 -->
  <div class="section">
    <h2>${t('🖼 資源載入失敗測試', '🖼 Resource Load Failure Test')}</h2>
    <p>${t('圖片/CSS/JS 404 時頁面破版，BugEzy 自動捕捉。', 'When images/CSS/JS 404 and break the page, BugEzy auto-captures it.')}</p>
    <div class="btn-grid">
      <button class="btn-warn" onclick="loadBroken('img')">${t('載入不存在的圖片', 'Load missing image')}</button>
      <button class="btn-warn" onclick="loadBroken('script')">${t('載入不存在的 JS', 'Load missing JS')}</button>
      <button class="btn-warn" onclick="loadBroken('css')">${t('載入不存在的 CSS', 'Load missing CSS')}</button>
    </div>
    <div id="resourceArea"></div>
  </div>

  <!-- PM-155：Web Vitals -->
  <div class="section">
    <h2>${t('📡 Web Vitals 效能', '📡 Web Vitals Performance')}</h2>
    <p>${t('BugEzy 自動捕捉 LCP / CLS / FID。頁面載入後即可在報告中看到。', 'BugEzy auto-captures LCP / CLS / FID — visible in the report after load.')}</p>
    <div class="btn-grid">
      <button class="btn-dom" onclick="causeLayoutShift()">${t('觸發版面位移 (CLS)', 'Trigger layout shift (CLS)')}</button>
      <button class="btn-dom" onclick="causeSlowRender()">${t('模擬慢渲染 (LCP)', 'Simulate slow render (LCP)')}</button>
    </div>
  </div>

  <!-- PM-156：網路環境快照 -->
  <div class="section">
    <h2>${t('🌐 網路環境快照', '🌐 Network Environment Snapshot')}</h2>
    <p>${t('BugEzy 自動捕捉你的網路狀態。以下是目前偵測到的：', "BugEzy auto-captures your network state. Currently detected:")}</p>
    <div class="output" id="networkEnvOutput">${t('偵測中...', 'Detecting...')}</div>
  </div>

  <!-- PM-157：儲存快照 + PII 遮罩 -->
  <div class="section">
    <h2>${t('💾 儲存空間快照 + PII 遮罩', '💾 Storage Snapshot + PII Masking')}</h2>
    <p>${t('BugEzy 捕捉 localStorage/sessionStorage，敏感值自動遮罩。點按鈕模擬：', 'BugEzy captures localStorage/sessionStorage with sensitive values auto-masked. Click to simulate:')}</p>
    <div class="btn-grid">
      <button class="btn-dom" onclick="setTestStorage()">${t('寫入測試資料（含敏感值）', 'Write test data (incl. sensitive)')}</button>
      <button class="btn-warn" onclick="clearTestStorage()">${t('清除測試資料', 'Clear test data')}</button>
    </div>
    <div class="output" id="storageOutput">${t('點上方按鈕後錄製，報告中會看到遮罩效果。', 'Click above then record — the report will show the masking.')}</div>
  </div>

  <!-- PM-176~179：Python / Terminal CLI 指引 -->
  <div class="section">
    <h2>${t('🐍 Python / Terminal CLI 測試', '🐍 Python / Terminal CLI Test')}</h2>
    <p>${t('BugEzy 也能捕捉後端錯誤！在終端機執行以下指令測試：', 'BugEzy captures backend errors too! Run these in your terminal:')}</p>
    <h3>${t('Python 測試（需要 Python 環境）', 'Python (requires Python)')}</h3>
    <pre><code># ${t('KeyError 測試', 'KeyError test')}
BUGEZY_TOKEN=&lt;token&gt; npx bugezy-watch -- python -c "d={'a':1}; print(d['b'])"

# ${t('ImportError 測試', 'ImportError test')}
BUGEZY_TOKEN=&lt;token&gt; npx bugezy-watch -- python -c "import nonexistent_module"

# ${t('TypeError 測試', 'TypeError test')}
BUGEZY_TOKEN=&lt;token&gt; npx bugezy-watch -- python -c "'hello' + 123"</code></pre>
    <h3>${t('Node.js 測試', 'Node.js')}</h3>
    <pre><code># ${t('TypeError 測試', 'TypeError test')}
BUGEZY_TOKEN=&lt;token&gt; npx bugezy-watch -- node -e "null.foo"

# ${t('ReferenceError 測試', 'ReferenceError test')}
BUGEZY_TOKEN=&lt;token&gt; npx bugezy-watch -- node -e "undefinedVar"</code></pre>
    <p>${t('💡 執行後用 MCP <code>get_terminal_logs</code> 讀取，AI 會看到結構化錯誤 + 環境快照 + 白話導航摘要。', '💡 Then read via MCP <code>get_terminal_logs</code> — AI sees structured errors + env snapshot + a plain-language navigation summary.')}</p>
  </div>

  <!-- 截圖測試 -->
  <div class="section">
    <h2>${t('📸 截圖測試區域', '📸 Screenshot Test Area')}</h2>
    <p>${t('用 BugEzy 截圖功能擷取這個區域，測試三種模式。', "Use BugEzy's screenshot feature to capture this area in all 3 modes.")}</p>
    <div class="test-area">
      <p style="font-size: 24px; color: #7c3aed;">${t('🎯 這段文字應該出現在截圖中', '🎯 This text should appear in the screenshot')}</p>
      <p>${t('小字測試 — 驗證截圖解析度是否足夠', 'Small text — verify screenshot resolution')}</p>
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
    <h2>${t('🔗 跨頁跳轉測試', '🔗 Cross-Page Navigation Test')}</h2>
    <p>${t('點擊連結跳到其他測試頁，驗證跨頁錄製 + 語音保留。', 'Click a link to another test page — verify cross-page recording + voice retention.')}</p>
    <div class="nav-links">
      <a href="/test/page2">${t('跳到測試頁 2 →', 'Go to Test Page 2 →')}</a>
      <a href="/test/page3">${t('跳到測試頁 3 →', 'Go to Test Page 3 →')}</a>
    </div>
  </div>

  <!-- 輸入測試 -->
  <div class="section">
    <h2>${t('⌨️ 輸入測試', '⌨️ Input Test')}</h2>
    <input type="text" placeholder="${t('測試文字輸入...', 'Test text input...')}" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;margin-bottom:8px;">
    <textarea placeholder="${t('測試多行輸入...', 'Test multi-line input...')}" rows="3" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;"></textarea>
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

    // PM-155：資源載入失敗（圖片/JS/CSS 404）
    function loadBroken(kind) {
      const area = document.getElementById('resourceArea');
      if (kind === 'img') {
        const img = document.createElement('img');
        img.src = 'https://bugezy.dev/test/fake-image-404.png';
        img.style.cssText = 'width:1px;height:1px;';
        area.appendChild(img);
      } else if (kind === 'script') {
        const s = document.createElement('script');
        s.src = 'https://bugezy.dev/test/fake-script-404.js';
        document.head.appendChild(s);
      } else if (kind === 'css') {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://bugezy.dev/test/fake-style-404.css';
        document.head.appendChild(link);
      }
    }

    // PM-155：Web Vitals（CLS / LCP）
    function causeLayoutShift() {
      const el = document.createElement('div');
      el.style.cssText = 'height:100px;background:#f59e0b;margin:10px 0;border-radius:8px;text-align:center;line-height:100px;color:#000;font-weight:bold;';
      el.textContent = '⚠ CLS';
      const first = document.querySelector('.section');
      if (first) first.before(el);
    }
    function causeSlowRender() {
      const start = Date.now();
      while (Date.now() - start < 200) {} // 阻塞 200ms 模擬慢渲染
      const el = document.createElement('div');
      el.style.cssText = 'padding:20px;background:#ef4444;color:#fff;border-radius:8px;text-align:center;margin:10px 0;';
      el.textContent = '🐢 200ms';
      const area = document.getElementById('resourceArea');
      if (area) area.after(el);
    }

    // PM-156：即時顯示網路環境
    (function showNetworkEnv() {
      const conn = navigator.connection || {};
      const info = [
        'status: ' + (navigator.onLine ? '🟢 online' : '🔴 offline'),
        'type: ' + (conn.effectiveType || 'unknown'),
        'rtt: ' + (conn.rtt != null ? conn.rtt + 'ms' : 'N/A'),
        'downlink: ' + (conn.downlink != null ? conn.downlink + ' Mbps' : 'N/A'),
        'saveData: ' + (conn.saveData ? 'on' : 'off'),
      ];
      const out = document.getElementById('networkEnvOutput');
      if (out) out.textContent = info.join('\\n');
    })();

    // PM-157：儲存快照 + PII 遮罩（寫入敏感值供錄製後看遮罩效果）
    function setTestStorage() {
      localStorage.setItem('bugezy_test_token', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.token');
      localStorage.setItem('bugezy_test_email', 'user@example.com');
      localStorage.setItem('bugezy_test_theme', 'dark');
      localStorage.setItem('bugezy_test_password', 'super_secret_123');
      localStorage.setItem('bugezy_test_api_key', 'sk-1234567890abcdefghijklmnop');
      sessionStorage.setItem('bugezy_test_temp', 'this is normal data');
      const out = document.getElementById('storageOutput');
      if (out) out.textContent = '✅ localStorage x5 + sessionStorage x1\\n→ token/password/api_key → ***MASKED***\\n→ email → 局部遮罩 / partial\\n→ theme/temp → 不遮罩 / not masked';
    }
    function clearTestStorage() {
      ['bugezy_test_token','bugezy_test_email','bugezy_test_theme','bugezy_test_password','bugezy_test_api_key'].forEach(k => localStorage.removeItem(k));
      sessionStorage.removeItem('bugezy_test_temp');
      const out = document.getElementById('storageOutput');
      if (out) out.textContent = '🗑 cleared';
    }
  </script>
</body>
</html>`;
}

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

    // 舊 URL redirect → bugezy.dev（MCP 和 API 除外，因為已連線的工具可能還用舊 URL）
    if (url.hostname === 'bugezy-api.bugezy-api.workers.dev' && !path.startsWith('/mcp') && !path.startsWith('/api/')) {
      return Response.redirect(`https://bugezy.dev${path}${url.search}`, 301);
    }

    // MCP 端點（Streamable HTTP）— 給 Claude.ai Connectors / IDE 直接連。
    // PM-130：不套自訂 CORS（交給 handler 自理，避免破壞 Claude.ai 連線）。
    if (path === '/mcp' || path.startsWith('/mcp/')) {
      // PM-183：MCP 基本防護——body 上限 1MB（Cloudflare Dashboard rate-limit 規則只覆蓋 /api/，
      // /mcp 不在其下；免費版只能建 1 條規則已用在 /api/，故在程式層擋大 payload）。
      const cl = parseInt(request.headers.get('Content-Length') || '0', 10);
      if (cl > 1024 * 1024) {
        return new Response('Request too large', { status: 413 });
      }
      // PM-190（方案 B）：從 MCP URL query 讀 session_token → 存進「per-request env 副本」供 tools 自動取用。
      //   用副本（非改共用 env）避免同 isolate 併發 request 互相覆寫 token（跨 tool await 期間的競態）。
      const urlToken = url.searchParams.get('token') || '';
      const mcpEnv: Env = { ...env, __mcp_session_token: urlToken };
      const handler = createMcpHandler(createMcpServer(mcpEnv), { route: '/mcp' });
      return handler(request, mcpEnv, ctx);
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
    // PM-150：首頁依語言變動——no-store 避免 CF 邊緣快取把某語言版本跨語言誤送（?lang 覆蓋另有獨立 URL）
    if (request.method === 'GET' && path === '/') {
      const res = html(homePage(getLang(request), request)); // PM-172：傳 request 供 IP 國家判斷
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    // PM-152：guide/faq/privacy 依語言變動——no-store 避免 CF 跨語言快取誤送
    if (request.method === 'GET' && path === '/privacy') {
      const res = html(privacyPage(getLang(request))); // PM-64/152
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    if (request.method === 'GET' && path === '/guide') {
      const res = html(guidePage(getLang(request))); // PM-66/152
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    if (request.method === 'GET' && path === '/faq') {
      const res = html(faqPage(getLang(request))); // PM-66/152
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    if (request.method === 'GET' && path === '/install') {
      const res = html(installPage(getLang(request))); // PM-96/150
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    if (request.method === 'GET' && path === '/features') {
      const res = html(featuresPage(getLang(request))); // PM-96/151
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    // PM-201：AI 客服手冊（SKILL.md）——檢視頁 + 下載檔案
    if (request.method === 'GET' && path === '/skill') {
      const res = html(skillPage(getLang(request)));
      res.headers.set('Cache-Control', 'no-store'); // 依語言變動
      return res;
    }
    if (request.method === 'GET' && path === '/skill/download') {
      return new Response(SKILL_MD, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': 'attachment; filename="SKILL.md"',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }
    // PM-126：版本檢查（popup 亮燈用）+ 更新日誌頁
    if (request.method === 'GET' && path === '/api/version') {
      // 每次上新版到 Chrome Web Store 時，同步改 latest + deploy
      return json({ latest: '1.1.3', changelog_url: 'https://bugezy.dev/changelog' });
    }
    if (request.method === 'GET' && path === '/changelog') {
      const res = html(changelogPage(getLang(request))); // PM-126/151
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    // PM-174：問題回報頁 + 提交端點（不需登入）
    if (request.method === 'GET' && path === '/feedback') {
      const res = html(feedbackPage(getLang(request)));
      res.headers.set('Cache-Control', 'no-store'); // 依語言變動
      return res;
    }
    if (request.method === 'POST' && path === '/api/feedback') {
      return await handleFeedback(request, env);
    }
    // PM-184：我的報告列表（需 session token，私人頁 noindex + no-store）
    // PM-187：token 改由 client 端（fragment/localStorage）解析，不再走 URL query（資安）
    if (request.method === 'GET' && path === '/reports') {
      return await reportsPage(request, env);
    }
    // PM-187：報告列表 JSON 資料端點（Bearer 驗證）
    if (request.method === 'GET' && path === '/api/my-reports') {
      return await myReportsApi(request, env);
    }
    // PM-196：批次刪除自己的報告（Bearer 驗證 + owner 過濾 + 最多 50 筆）
    if (request.method === 'DELETE' && path === '/api/reports') {
      return await deleteReportsApi(request, env);
    }
    // PM-136：SEO — sitemap + robots（讓 Google/Bing 收錄 bugezy.dev）
    if (request.method === 'GET' && path === '/sitemap.xml') return sitemapXml();
    if (request.method === 'GET' && path === '/robots.txt') return robotsTxt();
    // PM-211：OG/Twitter Card 分享圖（品牌 icon 128×128）
    if (request.method === 'GET' && path === '/icon-128.png') return iconPng();

    // PM-166：報告頁 client 邏輯外部檔（CSP script-src 'self' 才能載入）。快取 1 天。
    if (request.method === 'GET' && path === '/report-page.js') return javascript(REPORT_PAGE_JS);

    // PM-59：報告頁——Server 直接回完整 HTML（vanilla JS 讀 /api/reports/:id 渲染），
    // 放在 /api/reports/:id 之前匹配。PM-166：改嚴格 CSP（script-src 'self'）。PM-168：多語系 + no-store 防跨語言快取。
    if (request.method === 'GET' && path.startsWith('/report/')) {
      const reportId = path.split('/report/')[1];
      if (reportId && reportId.length > 10) {
        const res = html(reportPageHtml(getLang(request)), true);
        res.headers.set('Cache-Control', 'no-store');
        return res;
      }
    }

    // PM-48：測試專頁（Test Harness）— 可預測的 Bug 場景，供 BugEzy 測試用
    if (request.method === 'GET' && path === '/test') {
      const res = html(testPage1(getLang(request))); // PM-180：多語系
      res.headers.set('Cache-Control', 'no-store'); // 依語言變動
      return res;
    }
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
      // PM-143（P1-2）：加認證 + per-user R2 key（防跨用戶讀到彼此的 error/stderr）
      if (request.method === 'POST' && path === '/api/live-errors') {
        const userId = await getAuthUserId(request, env);
        if (!userId) return json({ error: '請先登入' }, 401);
        const data = (await request.json().catch(() => ({}))) as Partial<LiveErrors>;
        const entry: LiveErrors = {
          url: data.url,
          title: data.title,
          consoleLogs: Array.isArray(data.consoleLogs) ? data.consoleLogs : [],
          networkErrors: Array.isArray(data.networkErrors) ? data.networkErrors : [],
          timestamp: data.timestamp,
          updatedAt: Date.now(),
        };
        await env.R2.put(liveErrorsKey(userId), JSON.stringify(entry), {
          httpMetadata: { contentType: 'application/json' },
        });
        return json({ ok: true });
      }
      if (request.method === 'GET' && path === '/api/live-errors') {
        const userId = await getAuthUserId(request, env);
        if (!userId) return json({ error: '請先登入' }, 401);
        return jsonNoStore(await readLiveErrors(env, userId));
      }
      // PM-53：終端機 CLI agent 日誌（POST 覆蓋最新；GET 讀最新，>30s 視為過期）
      // PM-143：同 live-errors——加認證 + per-user key。PM-144：終端機 CLI 為付費功能（isActiveUser 403）。
      if (request.method === 'POST' && path === '/api/terminal-logs') {
        const userId = await getAuthUserId(request, env);
        if (!userId) return json({ error: '請先登入' }, 401);
        if (!(await isActiveUserId(userId, env))) {
          return json({ error: '終端機 CLI 為付費功能，請升級' }, 403);
        }
        const data = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        // PM-167：server 端雙重遮罩（防舊版 CLI 未更新就上傳明文密碼/金鑰）
        const masked = maskTerminalPayload(data);
        await env.R2.put(terminalLogsKey(userId), JSON.stringify({ ...masked, updatedAt: Date.now() }), {
          httpMetadata: { contentType: 'application/json' },
        });
        return json({ ok: true });
      }
      if (request.method === 'GET' && path === '/api/terminal-logs') {
        const userId = await getAuthUserId(request, env);
        if (!userId) return json({ error: '請先登入' }, 401);
        if (!(await isActiveUserId(userId, env))) {
          return json({ error: '終端機 CLI 為付費功能，請升級' }, 403);
        }
        return jsonNoStore(await readTerminalLogs(env, userId));
      }
      // PM-56：當月 MCP 使用量統計
      if (request.method === 'GET' && path === '/api/usage/monthly') {
        // PM-219 修復4：加認證 gate（原本無認證，任何人可白嫖全站用量彙總 DB 查詢）
        const usageUserId = await getAuthUserId(request, env);
        if (!usageUserId) return json({ error: 'unauthorized' }, 401);
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
      // PM-146（P2-3）：登出撤銷 server session（從 sessions 表刪 token，舊 token 立即失效）
      if (request.method === 'POST' && path === '/api/auth/logout') {
        return await handleLogout(request, env);
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
        // PM-172：非台灣 IP 直接擋（防繞過 UI 直呼 API → 綠界拒付）
        if (!isPayCountry(request)) {
          return json({ error: 'International payments coming soon. Currently available in Taiwan only.' }, 403);
        }
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
      // PM-146：報告設定（允許 AI 讀截圖）— 需登入 + 報告 owner 驗證（PM-82 原「有 share link 就能改」已於 PM-146 收緊）
      const settingsMatch = path.match(/^\/api\/reports\/([^/]+)\/settings$/);
      if (request.method === 'PATCH' && settingsMatch) {
        return await updateReportSettings(settingsMatch[1], request, env);
      }
      const match = path.match(/^\/api\/reports\/([^/]+)$/);
      if (request.method === 'GET' && match) {
        return await getReport(match[1], request, env);
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
    // PM-182：清理過期 sessions（verifySession 只在被查時刪，主動清理避免表無限膨脹）
    try {
      const { count, error } = await supa(env)
        .from('sessions')
        .delete({ count: 'exact' })
        .lt('expires_at', new Date().toISOString());
      if (error) console.error('[Cron] Session cleanup failed:', error.message);
      else console.log(`[Cron] Cleaned ${count ?? 0} expired sessions`);
    } catch (err) {
      console.error('[Cron] Session cleanup failed:', err);
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
  const authUserId = await getAuthUserId(request, env); // 認證身分（session token）
  // PM-219 修復1：user_id 一律以「認證身分」為準，絕不信任 client 傳的 payload.user_id
  //   （原本只在缺值時補；client 可傳他人 user_id 把報告冒名掛進他人列表）。匿名上傳 → undefined（不帶 user_id 欄）。
  payload.user_id = authUserId ?? undefined;

  // PM-165：server 端用量檢查（最後防線）——免費用戶可能改 extension JS 跳過 bumpUsage，
  // 這裡以「認證身分」再擋一次。無 rrweb（截圖/監控）不受限；未登入報告放行（匿名上傳場景）。
  // 註：payload 無「錄製 vs 回溯」型別旗標，server 無法分辨（兩者皆有 rrweb），故以「錄製+回溯額度皆用盡」
  //     為界（每月 10 錄製 + 5 回溯 = 15 份 rrweb 報告），避免誤擋「錄製額度滿但回溯還有」的合法回溯。
  if (authUserId) {
    const { data: usageUser } = await supa(env)
      .from('users')
      .select('plan, day_pass_expires_at, recording_count, rewind_count, usage_reset_at')
      .eq('user_id', authUserId)
      .maybeSingle();
    if (usageUser) {
      const uu = usageUser as {
        plan?: string | null;
        day_pass_expires_at?: string | null;
        recording_count?: number;
        rewind_count?: number;
        usage_reset_at?: string | null;
      };
      const hasRrweb = Array.isArray(payload.rrwebEvents) && payload.rrwebEvents.length > 0;
      if (hasRrweb && !isActiveUser(uu)) {
        // 跨月重置（唯讀比對，不寫 DB；實際重置由 getUserPlan 負責）：新月份不計舊額度
        const resetAt = new Date(uu.usage_reset_at ?? 0);
        const now = new Date();
        const sameMonth =
          now.getMonth() === resetAt.getMonth() && now.getFullYear() === resetAt.getFullYear();
        const recordingCount = sameMonth ? uu.recording_count || 0 : 0;
        const rewindCount = sameMonth ? uu.rewind_count || 0 : 0;
        if (recordingCount >= FREE_LIMITS.recording && rewindCount >= FREE_LIMITS.rewind) {
          return json(
            {
              error: 'limit_reached',
              message: `免費版每月錄製/回溯額度已用盡（${FREE_LIMITS.recording} 次錄製 + ${FREE_LIMITS.rewind} 次回溯），升級付費版解鎖無限次`,
              used: recordingCount + rewindCount,
              max: FREE_LIMITS.recording + FREE_LIMITS.rewind,
            },
            403,
          );
        }
      }
    }
  }

  const report_id = crypto.randomUUID();
  const rrweb_r2_key = `reports/${report_id}/rrweb.json`;
  // PM-160：驗證截圖 dataUrl 格式，丟棄注入值（Stored XSS 縱深防禦——只存合法 data:image base64 或 https URL，
  // 拒絕 `x" onerror=alert(1)` 之類；render 端 esc() 是第二層，此處是入庫第一層）
  const screenshots = (payload.screenshots ?? []).filter((ss) => {
    const src = ss?.dataUrl;
    if (!src || !VALID_SCREENSHOT_SRC.test(src)) {
      console.error('PM-160: rejected invalid screenshot dataUrl:', String(src).slice(0, 50));
      return false;
    }
    return true;
  });
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
  // PM-83/156/157：可選欄位（allow_screenshot_images / network_snapshot / storage_snapshot）若尚未建（ALTER 未跑）
  // 會讓 insert 失敗 → 退回不含這些欄位重試，確保上傳永不因此中斷。
  const allowImages = (payload as { allow_screenshot_images?: boolean }).allow_screenshot_images === true;
  const insertRow = {
    ...baseRow,
    ...(allowImages ? { allow_screenshot_images: true } : {}),
    ...(payload.networkSnapshot ? { network_snapshot: payload.networkSnapshot } : {}), // PM-156
    ...(payload.storageSnapshot ? { storage_snapshot: payload.storageSnapshot } : {}), // PM-157（已遮罩）
  };
  let { error } = await supa(env).from('reports').insert(insertRow);
  if (error && /allow_screenshot_images|network_snapshot|storage_snapshot/.test(error.message)) {
    ({ error } = await supa(env).from('reports').insert(baseRow)); // 退回僅必要欄位
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
async function getReport(reportId: string, request: Request, env: Env): Promise<Response> {
  const { data, error } = await supa(env)
    .from('reports')
    .select('*')
    .eq('report_id', reportId)
    .single();

  if (error || !data) {
    return json({ error: 'report not found' }, 404);
  }

  // PM-188（P0 資安 + 商業）：分享閱讀權限——非擁有者需付費會員才能讀。
  //   token 可選（訪客無 token）；owner 看自己不論付費狀態；非 owner 須為有效付費會員（isActiveUserId）。
  //   403 用 jsonNoStore 防邊緣快取跨使用者外洩。owner 身分靠 PM-187 存在 bugezy.dev localStorage 的 token（同源可讀）。
  const auth = request.headers.get('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const userId = token ? await verifySessionByToken(token, env) : null;
  const isOwner = !!userId && userId === (data.user_id as string | null);
  if (!isOwner) {
    if (!userId) {
      // 訪客（無 token / token 無效）
      return jsonNoStore(
        { error: 'login_required', message: '請登入 BugEzy 並升級會員才能閱讀' },
        403,
      );
    }
    // 已登入但非 owner → 須為有效付費會員
    if (!(await isActiveUserId(userId, env))) {
      return jsonNoStore(
        { error: 'upgrade_required', message: '升級會員即可閱讀他人分享的報告' },
        403,
      );
    }
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

  return jsonNoStore({
    // PM-161（Fable5 #3）：報告內容改 no-store，防 Cloudflare 邊緣快取跨使用者/分享後外洩
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
    networkSnapshot: data.network_snapshot ?? null, // PM-156：網路環境快照（欄位未建時 undefined→null）
    storageSnapshot: data.storage_snapshot ?? null, // PM-157：儲存空間快照（遮罩後；欄位未建時 undefined→null）
    rrwebEvents,
    screenshots,
    created_at: data.created_at,
  });
}

// PATCH /api/reports/:id/settings — 報告設定（PM-82：允許 AI 讀截圖）。
// PM-146（P2-5）：必須登入 + 必須是報告 owner（原本無認證，任何有 report_id 的人可翻轉截圖曝光設定）。
async function updateReportSettings(
  reportId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const userId = await getAuthUserId(request, env);
  if (!userId) return json({ error: '請先登入' }, 401);

  // 確認是報告 owner
  const { data: report } = await supa(env)
    .from('reports')
    .select('user_id')
    .eq('report_id', reportId)
    .maybeSingle();
  if (!report || (report as { user_id: string | null }).user_id !== userId) {
    return json({ error: '無權限修改此報告' }, 403);
  }

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

  // PM-217：帶 language（popup 語言）→ 英文用戶用英文 prompt，zh/yue/未帶維持繁中
  const { text, language } = (await request.json().catch(() => ({}))) as {
    text?: string;
    language?: string;
  };
  if (!text || text.length < 10) {
    return json({ summary: text ?? '' });
  }
  const isEn = language === 'en';
  const sysContent = isEn
    ? "You are a bug report summarizer. Condense the user's voice description into 2-5 key points. Keep critical info (what element, what problem, expected behavior). Remove repetition and filler. Output in English, bullet points."
    : '你是 Bug 報告精簡助手。把使用者的語音描述精簡成 2-5 個重點。保留關鍵資訊（什麼元素、什麼問題、預期行為），去除重複和口語贅詞。用繁體中文，條列式輸出。';
  const userContent = isEn
    ? `Please summarize the following voice log:\n\n${text}`
    : `請精簡以下語音記錄：\n\n${text}`;
  try {
    const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: sysContent },
        { role: 'user', content: userContent },
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

  // PM-217：帶 language（popup 語言）→ 英文用戶用英文 prompt，zh/yue/未帶維持繁中
  const { text, language } = (await request.json().catch(() => ({}))) as {
    text?: string;
    language?: string;
  };
  if (!text?.trim()) {
    return json({ error: '沒有文字可校正' }, 400);
  }
  const isEn = language === 'en';
  const sysContent = isEn
    ? `You are a speech-to-text proofreading expert. The input is raw speech recognition output in English. Please only correct it.

Rules:
1. Fix misheard words and homophones
2. Remove filler words (um, uh, like, you know, so basically)
3. Keep technical terms as-is (console error, TypeError, 404, undefined, null, fetch, API)
4. Add proper punctuation and capitalization
5. Preserve original meaning and order, do not rewrite or summarize
6. If the original is already correct, return as-is

Only return the corrected text, no explanation.`
    : `你是繁體中文語音轉文字的校對專家。輸入一定是中文語音辨識的原始結果，可能有同音錯字與口語贅字。請只做「校正」，輸出校正後的中文文字。

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

只回傳校正後的文字，不加任何說明或前綴。`;
  const userContent = isEn
    ? `Please correct the following speech recognition text:\n${text}`
    : `請校正以下語音辨識文字：\n${text}`;
  try {
    const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: sysContent },
        { role: 'user', content: userContent },
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

  // PM-137/140：語言白名單（防濫用；非白名單一律 fallback zh）。
  // PM-140：金流（綠界特約商店）未開通前只放行 zh/yue/en；日韓越（ja/ko/vi）暫鎖，開放時再加回。
  const ALLOWED_LANGS = ['zh', 'yue', 'en'];
  const finalLang = ALLOWED_LANGS.includes(language) ? language : 'zh';

  // 3. 呼叫 Groq Whisper API
  const groqForm = new FormData();
  groqForm.append('file', audioBlob, 'audio.webm');
  groqForm.append('model', 'whisper-large-v3-turbo');
  groqForm.append('language', finalLang); // PM-137：使用者選的語言（預設 zh）
  groqForm.append('response_format', 'verbose_json');
  // PM-214：Groq Whisper 的 language 只控制辨識語言、不控制簡/繁輸出。台灣市場統一繁體——
  //   對中文與粵語加 prompt 引導繁體中文輸出（不影響辨識準確度；en 與日韓越不需要）。
  if (finalLang === 'zh' || finalLang === 'yue') {
    groqForm.append('prompt', '以下是繁體中文的語音轉錄內容。');
  }

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
      usage_reset_at: u.usage_reset_at ?? null, // PM-170：供 popup 顯示「每月自動重置」
      country: cfCountry(request), // PM-172：popup 用 IP 國家碼判斷付費資格（TW=正常，其餘 coming soon）
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
      .select('plan, recording_count, rewind_count, mcp_count, day_pass_expires_at, usage_reset_at')
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
      usage_reset_at: string | null;
    };
    // PM-73/109：cancelled 未到期、day_pass 未到期皆視同付費（無限）
    if (isActiveUser(u)) return json({ ok: true, unlimited: true });

    // PM-170：免費版每月自動重置——距上次重置 ≥30 天就把三個 count 歸零（否則用完永久鎖住）。
    // 免費用戶才需要（付費上面已 early-return）。usage_reset_at 缺值視為很久以前 → 觸發重置。
    const resetAt = new Date(u.usage_reset_at ?? 0);
    const now = new Date();
    const daysSinceReset = (now.getTime() - resetAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceReset >= 30) {
      await supa(env)
        .from('users')
        .update({
          recording_count: 0,
          rewind_count: 0,
          mcp_count: 0,
          usage_reset_at: now.toISOString(),
        })
        .eq('user_id', userId);
      u.recording_count = 0;
      u.rewind_count = 0;
      u.mcp_count = 0;
    }

    const countField = `${type}_count` as 'recording_count' | 'rewind_count' | 'mcp_count';
    const currentCount = u[countField] || 0;
    const limit = FREE_LIMITS[type];
    if (currentCount >= limit) {
      const label = type === 'recording' ? '錄製' : type === 'rewind' ? '回溯' : 'MCP AI 讀取';
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
// ── PM-145（P2-1）：ECPay callback 冪等 + payments 表（防重放/重複授權 + 金額比對）──
/** 查某交易 key 是否已成功入帳。已 paid 的 callback 重送 → 直接略過（冪等）。 */
async function paymentAlreadyPaid(env: Env, key: string): Promise<boolean> {
  const { data } = await supa(env)
    .from('payments')
    .select('status')
    .eq('merchant_trade_no', key)
    .maybeSingle();
  return (data as { status?: string } | null)?.status === 'paid';
}

/** upsert 一筆 payments 記錄（PK=merchant_trade_no）。回 true=成功。
 *  PM-163（Fable5 #5）：改回傳成功與否——callback 需「先寫 payments 成功才升級 users」，
 *  寫入失敗時回 500 讓綠界重送，避免 users 已升級卻無冪等記錄→重送時重複展延。
 *  ⚠ 前置：production 必須已建 payments 表（PM-145 CREATE TABLE），否則 upsert 恆失敗→callback 恆 500→無人能升級。 */
async function recordPayment(
  env: Env,
  row: {
    merchant_trade_no: string;
    user_id: string;
    payment_type: string;
    amount: number;
    rtn_code?: string;
    status: 'paid' | 'failed';
    raw_callback: unknown;
    paid_at?: string;
  },
): Promise<boolean> {
  const { error } = await supa(env).from('payments').upsert(row);
  if (error) {
    console.error('recordPayment failed:', error.message);
    return false;
  }
  return true;
}

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

  const tradeNo = params.MerchantTradeNo ?? '';
  // PM-145：冪等——已成功入帳的重送不重複展延到期日。
  // PM-219 修復2b：但若前次 users.update 失敗成孤兒（已收款未升級）→ 冪等重送順手自癒（重放升級狀態）。
  //   用 isActiveUserId 當守門：已 active（健康）→ 不動不展延；仍非 active（孤兒）→ 重放。RtnCode=1 才升級。
  if (tradeNo && (await paymentAlreadyPaid(env, tradeNo))) {
    const uid = params.CustomField1 ?? '';
    if (params.RtnCode === '1' && uid && !(await isActiveUserId(uid, env))) {
      const healed = await updateUserPlan(env, uid, {
        plan: 'paid',
        ecpay_trade_no: tradeNo,
        plan_expires_at: oneMonthLaterISO(),
      });
      if (!healed) return new Response('0|ErrorMessage=User upgrade failed', { status: 500 });
    }
    return new Response('1|OK', { status: 200 });
  }
  // PM-145：金額比對（月費固定 80）——被竄改則不授權，仍回 1|OK 讓綠界停止重送
  const amount = parseInt(params.TradeAmt ?? '0', 10);
  if (amount !== 80) {
    console.error(`ECPay monthly amount mismatch: expected 80, got ${params.TradeAmt}`);
    return new Response('1|OK', { status: 200 });
  }

  // 付款成功（RtnCode=1）→ 用 CustomField1 帶回的 user_id 升級為 paid
  // PM-73：同時記錄 ecpay_trade_no（取消訂閱要用）+ plan_expires_at（到期日）
  const userId = params.CustomField1 ?? '';
  if (params.RtnCode === '1') {
    // PM-163（Fable5 #5）：先寫 payments（冪等記錄）成功，才升級 users。順序反了會在 payments 寫入失敗時
    // 留下「users 已升級但無冪等記錄」→ 下次重送重複展延到期日。payments 失敗→回 500（非 1|OK）讓綠界重送重試。
    const recorded = await recordPayment(env, {
      merchant_trade_no: tradeNo,
      user_id: userId,
      payment_type: 'monthly',
      amount,
      rtn_code: params.RtnCode,
      status: 'paid',
      raw_callback: params,
      paid_at: new Date().toISOString(),
    });
    if (!recorded) {
      return new Response('0|ErrorMessage=Payment record failed', { status: 500 });
    }
    if (userId) {
      // PM-219 修復2a：users.update 檢查 error，失敗回 500 讓綠界重送（原本吞掉→孤兒態）
      const upgraded = await updateUserPlan(env, userId, {
        plan: 'paid',
        ecpay_trade_no: tradeNo,
        plan_expires_at: oneMonthLaterISO(),
      });
      if (!upgraded) return new Response('0|ErrorMessage=User upgrade failed', { status: 500 });
    }
  } else {
    // 付款失敗：不升級，僅記錄（best-effort；失敗未升級無冪等風險，寫入失敗不阻斷）
    await recordPayment(env, {
      merchant_trade_no: tradeNo,
      user_id: userId,
      payment_type: 'monthly',
      amount,
      rtn_code: params.RtnCode,
      status: 'failed',
      raw_callback: params,
    });
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
  // PM-172：非台灣 IP 直接擋（防繞過 UI 直呼 API → 綠界拒付）
  if (!isPayCountry(request)) {
    return json({ error: 'International payments coming soon. Currently available in Taiwan only.' }, 403);
  }

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

  const tradeNo = params.MerchantTradeNo ?? '';
  // PM-145：冪等——已成功入帳的重送不重複 +24h。
  // PM-219 修復2b：孤兒自癒——前次 users.update 失敗（已收款未開通）→ 冪等重送重放（isActiveUserId 守門避免重複 +24h）。
  if (tradeNo && (await paymentAlreadyPaid(env, tradeNo))) {
    const uid = params.CustomField1 ?? '';
    if (params.RtnCode === '1' && uid && !(await isActiveUserId(uid, env))) {
      const healed = await updateUserPlan(env, uid, {
        plan: 'day_pass',
        day_pass_expires_at: dayPassExpiryISO(),
      });
      if (!healed) return new Response('0|ErrorMessage=User upgrade failed', { status: 500 });
    }
    return new Response('1|OK', { status: 200 });
  }
  // PM-145：金額比對（日票固定 20）
  const amount = parseInt(params.TradeAmt ?? '0', 10);
  if (amount !== 20) {
    console.error(`ECPay day-pass amount mismatch: expected 20, got ${params.TradeAmt}`);
    return new Response('1|OK', { status: 200 });
  }

  // 付款成功（RtnCode=1）→ 用 CustomField1 帶回的 user_id 開通 24 小時日票
  const userId = params.CustomField1 ?? '';
  if (params.RtnCode === '1') {
    // PM-163（Fable5 #5）：先寫 payments 成功才開通日票，payments 失敗→500 讓綠界重送
    const recorded = await recordPayment(env, {
      merchant_trade_no: tradeNo,
      user_id: userId,
      payment_type: 'day_pass',
      amount,
      rtn_code: params.RtnCode,
      status: 'paid',
      raw_callback: params,
      paid_at: new Date().toISOString(),
    });
    if (!recorded) {
      return new Response('0|ErrorMessage=Payment record failed', { status: 500 });
    }
    if (userId) {
      // PM-219 修復2a：users.update 檢查 error，失敗回 500 讓綠界重送
      const opened = await updateUserPlan(env, userId, {
        plan: 'day_pass',
        day_pass_expires_at: dayPassExpiryISO(),
      });
      if (!opened) return new Response('0|ErrorMessage=User upgrade failed', { status: 500 });
    }
  } else {
    await recordPayment(env, {
      merchant_trade_no: tradeNo,
      user_id: userId,
      payment_type: 'day_pass',
      amount,
      rtn_code: params.RtnCode,
      status: 'failed',
      raw_callback: params,
    });
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
    `<p>24 小時內享有所有付費功能（無限錄製 / MCP AI 讀取 / Whisper 精準語音）。重新開啟 BugEzy 即可使用。</p>` +
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

  // PM-145：定期定額每期重用同一 MerchantTradeNo，但每期有不同 Gwsr（交易單號）→
  // 冪等 key 用「MerchantTradeNo-Gwsr」組合，才不會把第 2、3… 期誤判為第 1 期的重送。
  const periodKey = `${params.MerchantTradeNo ?? ''}-${
    params.Gwsr || params.TotalSuccessTimes || params.ProcessDate || 'p'
  }`;
  if (await paymentAlreadyPaid(env, periodKey)) {
    // PM-219 修復2b：本期已記錄但前次 users.update 失敗成孤兒（已扣款未展延）→ 冪等重送重放升級
    //   （isActiveUserId 守門：已 active 不重複展延）。RtnCode=1 才升級。
    const uid = params.CustomField1 ?? '';
    if (params.RtnCode === '1' && uid && !(await isActiveUserId(uid, env))) {
      const healed = await updateUserPlan(env, uid, {
        plan: 'paid',
        plan_expires_at: oneMonthLaterISO(),
        last_login_at: new Date().toISOString(),
      });
      if (!healed) return new Response('0|ErrorMessage=User upgrade failed', { status: 500 });
    }
    return new Response('1|OK', { status: 200 });
  }
  // PM-145：金額比對（定期定額每期 80，欄位為 Amount）。缺欄位（=0）不擋，避免誤殺續扣；
  // 只在「有明確金額且 ≠ 80」時視為異常不授權。
  const amount = parseInt(params.Amount ?? params.TradeAmt ?? '0', 10);
  if (amount > 0 && amount !== 80) {
    console.error(`ECPay period amount mismatch: expected 80, got ${params.Amount ?? params.TradeAmt}`);
    return new Response('1|OK', { status: 200 });
  }

  const userId = params.CustomField1 ?? '';
  const isSuccess = params.RtnCode === '1';
  // PM-163（Fable5 #5）：先記錄本期扣款（冪等 key=periodKey）成功，才更新 users。
  // 順序反了會在 payments 寫入失敗時留下「已展延但無冪等記錄」→ 重送重複展延。payments 失敗→回 500 讓綠界重送。
  const recorded = await recordPayment(env, {
    merchant_trade_no: periodKey,
    user_id: userId,
    payment_type: 'monthly_renewal',
    amount: amount || 80,
    rtn_code: params.RtnCode,
    status: isSuccess ? 'paid' : 'failed',
    raw_callback: params,
    paid_at: isSuccess ? new Date().toISOString() : undefined,
  });
  if (!recorded) {
    return new Response('0|ErrorMessage=Payment record failed', { status: 500 });
  }
  if (userId) {
    if (isSuccess) {
      // 本期扣款成功 → 維持 paid + 展延到期日（PM-73），順手更新最近活躍時間
      // PM-219 修復2a：檢查 error，失敗回 500 讓綠界重送（原本吞掉→已扣款未展延孤兒）
      const renewed = await updateUserPlan(env, userId, {
        plan: 'paid',
        plan_expires_at: oneMonthLaterISO(),
        last_login_at: new Date().toISOString(),
      });
      if (!renewed) return new Response('0|ErrorMessage=User upgrade failed', { status: 500 });
    } else {
      // 本期扣款失敗 → 降級為 free（best-effort；失敗不阻斷回應）
      await updateUserPlan(env, userId, { plan: 'free' });
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

    // PM-166（Fable5）：取消訂閱屬敏感操作 → 換發新 session token（限縮舊 token 生命週期），回 new_session_token 供 extension 更新
    const newToken = await rotateSession(userId, extractBearer(request), env);

    const expires = u.plan_expires_at ?? null;
    const expiresText = expires ? expires.slice(0, 10).replace(/-/g, '/') : '本期結束';
    return json({
      ok: true,
      message: `已取消訂閱。付費功能可使用到 ${expiresText}`,
      expires_at: expires,
      new_session_token: newToken, // PM-166：extension 收到後存入 storage，舊 token 已失效
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

// ── PM-159：Bug 分析規則引擎（零成本，不呼叫 Workers AI）──────
// 分析 rejection / CORS / network fail / resource error / 離線 / token 丟失 / Web Vitals，
// 產生「AI Bug 導航摘要」貼在 get_timeline / get_report_overview 最前面，讓 AI 直接定位問題。
interface SummaryLog {
  level?: string;
  message?: string;
  source?: string;
}
interface SummaryNet {
  method?: string;
  url?: string;
  status?: number;
}
function generateBugSummary(report: {
  console_logs?: SummaryLog[] | null;
  network_errors?: SummaryNet[] | null;
  voice_transcript?: Array<{ text?: string }> | null;
  network_snapshot?: unknown;
  storage_snapshot?: unknown;
}): string {
  const consoleLogs: SummaryLog[] = report.console_logs || [];
  const networkErrors: SummaryNet[] = report.network_errors || [];
  const voiceTranscript: Array<{ text?: string }> = report.voice_transcript || [];
  const ns = (report.network_snapshot || {}) as {
    atStart?: Record<string, unknown>;
    online?: boolean;
    effectiveType?: string;
    rtt?: number | null;
  };
  const ss = (report.storage_snapshot || {}) as { localStorage?: Array<{ key?: string; value?: string }> };

  const errors = consoleLogs.filter((l) => l.level === 'error');
  const warnings = consoleLogs.filter((l) => l.level === 'warn');
  const rejections = consoleLogs.filter((l) => l.source === 'unhandledrejection');
  const resourceErrors = consoleLogs.filter((l) => l.source === 'resource-error');
  const webVitals = consoleLogs.filter((l) => l.source === 'web-vitals');
  const netFails = networkErrors.filter((n) => (n.status ?? 0) >= 400);
  const clip = (s: string | undefined, n = 150) => (s || '').slice(0, n);

  const lines: string[] = ['🔍 AI Bug 導航摘要', ''];

  // ── 根因判斷 ──
  if (rejections.length > 0) {
    lines.push(`⚡ 根因線索：發現 ${rejections.length} 個未捕捉的 Promise Rejection（async/await 可能缺少 catch）`);
    lines.push(`   → ${clip(rejections[0].message)}`);
  }

  if (netFails.length > 0) {
    const corsErrors = warnings.filter((w) => /CORS|Access-Control/i.test(w.message || ''));
    if (corsErrors.length > 0) {
      lines.push('⚡ 根因線索：CORS 跨域錯誤 — API 請求被瀏覽器擋掉');
      lines.push('   → 建議檢查 server 的 Access-Control-Allow-Origin header');
    } else {
      const first = netFails[0];
      lines.push(`⚡ 根因線索：API 呼叫失敗 ${first.method || '?'} ${first.url || ''} → ${first.status}`);
      if (first.status === 404) lines.push('   → 端點不存在，檢查 URL 拼寫或 server 路由');
      if (first.status === 500) lines.push('   → Server 內部錯誤，檢查 server logs');
      if (first.status === 401 || first.status === 403) lines.push('   → 認證/權限問題，檢查 token 或登入狀態');
    }
  }

  if (resourceErrors.length > 0) {
    lines.push(`⚡ 根因線索：${resourceErrors.length} 個資源載入失敗（頁面可能破版）`);
    lines.push(`   → ${clip(resourceErrors[0].message)}`);
  }

  if (errors.length > 0 && rejections.length === 0 && netFails.length === 0) {
    lines.push('⚡ 根因線索：JavaScript 執行錯誤');
    lines.push(`   → ${clip(errors[0].message)}`);
  }

  // ── 環境資訊 ──
  const atStart = (ns.atStart || ns) as { online?: boolean; effectiveType?: string; rtt?: number | null };
  if (atStart.online === false) {
    lines.push('🌐 注意：使用者處於離線狀態');
  } else if (atStart.effectiveType === 'slow-2g' || atStart.effectiveType === '2g') {
    lines.push(`🌐 注意：使用者網路極慢（${atStart.effectiveType}，RTT ${atStart.rtt ?? '?'}ms）`);
  }

  // ── 儲存線索（token 丟失）──
  const ls = ss.localStorage || [];
  const tokenItem = ls.find((i) => /token|auth|session/i.test(i.key || ''));
  if (tokenItem && (tokenItem.value === 'null' || tokenItem.value === '')) {
    lines.push('💾 注意：localStorage 的 token/auth 為空 — 可能是登入狀態丟失');
  }

  // ── 語音描述 ──
  const firstVoice = voiceTranscript[0]?.text || '';
  if (firstVoice) lines.push(`🎙️ 使用者描述：「${firstVoice.slice(0, 100)}」`);

  // ── Web Vitals 警告 ──
  const badVitals = webVitals.filter((v) => v.level === 'warn');
  if (badVitals.length > 0) {
    lines.push(`⚡ 效能問題：${badVitals.map((v) => (v.message || '').replace('Web Vital ', '')).join(' / ')}`);
  }

  // 無任何線索 → 明示（在統計之前判斷，否則 lines 永遠 >3；修正規格 §1 判斷位置）
  if (lines.length <= 2) {
    lines.push('✅ 未偵測到明顯異常，建議查看完整時間軸');
  }

  // ── 統計 ──
  lines.push('');
  lines.push(
    `📊 統計：${errors.length} error / ${warnings.length} warn / ${netFails.length} network fail / ${resourceErrors.length} resource fail`,
  );

  return lines.join('\n');
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
    get_timeline: 25, // PM-158：一次拿完整時序，Chrome 要讀整頁 DOM + DevTools + 人工對照時間軸
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
    '列出某使用者的 Bug 報告（需提供 user_email + session_token 驗證身分）。List a user\'s bug reports — requires user_email and session_token.',
    {
      user_email: z
        .string()
        .optional()
        .describe('使用者 email；只回傳該 email 的報告。未提供則不回任何報告（安全預設）。'),
      session_token: z
        .string()
        .optional()
        .describe('BugEzy session token（如果 MCP URL 已帶 ?token= 則不需提供）。'),
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
      // PM-190（方案 B）：token 優先序 = URL query token（?token=，自動帶入）→ 參數 session_token（手動，向下相容）
      const token = env.__mcp_session_token || args.session_token || '';
      if (!token) {
        return txt('請在 MCP URL 加上 ?token=xxx，或提供 session_token 參數。可從 BugEzy 擴充進階設定複製。');
      }
      // 以 email 查 user_id
      const { data: user, error: uErr } = await supabase()
        .from('users')
        .select('user_id')
        .eq('email', args.user_email)
        .maybeSingle();
      if (uErr) {
        console.error('MCP list_reports user lookup failed:', uErr.message); // PM-142：原始錯誤只記 log
        return txt('查詢失敗，請稍後再試。');
      }
      if (!user) return txtWithTokens([], 'list_reports'); // 查無此 email → 回空

      // PM-142（P1-1）/165/190：嚴格驗證 token 屬於此 user，防止「知道某人 email 就能列他報告」。
      // PM-219 修復3：改用 verifySessionByToken（含 expires_at 到期檢查 + 過期即刪），取代 inline 查表（原本不檢查到期）。
      {
        const tokenUserId = await verifySessionByToken(token, env);
        if (!tokenUserId || tokenUserId !== (user as { user_id: string }).user_id) {
          return txt('session_token 驗證失敗，請確認 token 正確。');
        }
      }

      const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
      let query = supabase()
        .from('reports')
        .select(META_COLS)
        .eq('user_id', (user as { user_id: string }).user_id)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (args.url) query = query.ilike('url', `%${args.url}%`);
      const { data, error } = await query;
      if (error) {
        console.error('MCP list_reports query failed:', error.message); // PM-142：原始錯誤只記 log
        return txt('查詢失敗，請稍後再試。');
      }
      return txtWithTokens(data ?? [], 'list_reports');
    },
  );

  // Tool 2: get_report_overview
  server.tool(
    'get_report_overview',
    '取得報告概覽（metadata + 各筆數 + AI Bug 導航摘要，不含原始資料）。Report overview with AI bug summary.',
    { report_id: z.string() },
    async (args) => {
      // PM-159：改 select('*') 以供 generateBugSummary 分析原始 logs；回傳仍只給 metadata + 摘要（不含原始陣列，省 token）
      const { data, error } = await supabase()
        .from('reports')
        .select('*')
        .eq('report_id', args.report_id)
        .single();
      if (error || !data) return txt('找不到報告');
      const overview = {
        report_id: data.report_id,
        url: data.url,
        title: data.title,
        browser: data.browser,
        screen_size: data.screen_size,
        console_count: data.console_count,
        network_count: data.network_count,
        voice_count: data.voice_count,
        rrweb_count: data.rrweb_count,
        screenshot_count: data.screenshot_count,
        description: data.description,
        markers: data.markers,
        created_at: data.created_at,
        ai_bug_summary: generateBugSummary(data), // PM-159：規則引擎導航摘要
      };
      return txtWithTokens(overview, 'get_report_overview', args.report_id);
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

  // PM-143：MCP 讀 per-user R2 key → 需 user_email 查 user_id（跟 list_reports 一致）。
  const lookupUserId = async (email?: string): Promise<string | null> => {
    if (!email) return null;
    const { data: user, error } = await supabase()
      .from('users')
      .select('user_id')
      .eq('email', email)
      .maybeSingle();
    if (error) {
      console.error('MCP user lookup failed:', error.message);
      return null;
    }
    return user ? (user as { user_id: string }).user_id : null;
  };

  // PM-162（Fable5 #2）：有帶 session_token 就嚴格驗證它屬於該 user（比對 sessions 表）。
  // 回 true = 通過驗證 或 未帶 token（optional，向下相容，比照 PM-142 list_reports）。
  // PM-219 修復3：改用 verifySessionByToken（含 expires_at 到期檢查 + 過期即刪），取代 inline 查表
  //   （原本不檢查到期 → 過期 token 最長殘留 24hr）。get_live_errors + get_terminal_logs 共用此 helper。
  const sessionMatchesUser = async (sessionToken: string | undefined, userId: string): Promise<boolean> => {
    if (!sessionToken) return true;
    const tokenUserId = await verifySessionByToken(sessionToken, env);
    return tokenUserId === userId;
  };

  // Tool 9（PM-51）: get_live_errors — 不需錄製，讀當前頁面即時 console/network errors
  server.tool(
    'get_live_errors',
    '取得某使用者當前頁面的即時 Console/Network 錯誤（需 user_email + session_token 驗證身分）。Live console/network errors — requires user_email and session_token.',
    {
      user_email: z.string().describe('你的 BugEzy email（只讀你自己的即時錯誤）'),
      session_token: z
        .string()
        .optional()
        .describe('BugEzy session token（如果 MCP URL 已帶 ?token= 則不需提供）。'),
    },
    async (args) => {
      if (!args.user_email) return txt('請提供 user_email 參數。');
      // PM-190（方案 B）：token 優先序 = URL query token → 參數 session_token（向下相容）
      const token = env.__mcp_session_token || args.session_token || '';
      if (!token) {
        return txt('請在 MCP URL 加上 ?token=xxx，或提供 session_token 參數。可從 BugEzy 擴充進階設定複製。');
      }
      const userId = await lookupUserId(args.user_email);
      if (!userId) return txt('查無此使用者。');
      // PM-162/165：驗證 token 屬於此 user，防「知道 email 就能讀他即時錯誤」
      if (!(await sessionMatchesUser(token, userId))) {
        return txt('session_token 驗證失敗，請確認 token 正確。');
      }
      const data = await readLiveErrors(env, userId);
      if (data.stale) {
        return txt('即時監控未啟用或資料已過期（>30 秒）。請在 BugEzy popup 開啟「🔍 即時監控」後再查。');
      }
      return txtWithTokens(data, 'get_live_errors');
    },
  );

  // Tool 10（PM-53）: get_terminal_logs — 終端機 stderr/throw/crash（需跑 npx bugezy-watch）
  server.tool(
    'get_terminal_logs',
    '取得某使用者終端機的即時錯誤日誌（stderr/throw/crash，需 user_email + session_token 驗證；付費功能）。開發者需執行 npx bugezy-watch -- <command>。Terminal error logs — requires user_email and session_token, paid feature.',
    {
      user_email: z.string().describe('你的 BugEzy email（只讀你自己的終端機日誌）'),
      session_token: z
        .string()
        .optional()
        .describe('BugEzy session token（如果 MCP URL 已帶 ?token= 則不需提供）。'),
    },
    async (args) => {
      if (!args.user_email) return txt('請提供 user_email 參數。');
      // PM-190（方案 B）：token 優先序 = URL query token → 參數 session_token（向下相容）
      const token = env.__mcp_session_token || args.session_token || '';
      if (!token) {
        return txt('請在 MCP URL 加上 ?token=xxx，或提供 session_token 參數。可從 BugEzy 擴充進階設定複製。');
      }
      const userId = await lookupUserId(args.user_email);
      if (!userId) return txt('查無此使用者。');
      // PM-162/165：驗證 token 屬於此 user，防「知道 email 就能讀他終端機 stderr（可能含密鑰）」
      if (!(await sessionMatchesUser(token, userId))) {
        return txt('session_token 驗證失敗，請確認 token 正確。');
      }
      // PM-162：終端機 CLI 為付費功能——比照 HTTP 端（PM-144）加付費檢查，MCP 端原本漏了
      if (!(await isActiveUserId(userId, env))) {
        return txt('終端機 CLI 為付費功能，請至 bugezy.dev 升級後使用。');
      }
      const data = await readTerminalLogs(env, userId);
      if (data.stale) {
        return txt('終端機 Agent 未啟動或資料已過期（>30 秒）。請在終端機執行：npx bugezy-watch -- npm run dev');
      }
      // PM-179：最前面插入 AI 導航摘要（根因+白話+位置）；PM-178：後接結構化文字 + 原始 stderr
      const summary = generateTerminalSummary(data);
      return txtWithTokens(summary + '\n\n' + formatTerminalLogs(data), 'get_terminal_logs');
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

  // Tool 13: get_timeline（PM-158）— 時序麵包屑：一份報告的所有資料合成一條故事線，AI 呼叫一次掌握全貌
  server.tool(
    'get_timeline',
    '取得一份報告的完整時間軸（時序麵包屑）。把 Console、Network、語音、標記、網路環境、儲存狀態全部按時間排序成一條故事線，AI 只需呼叫這一個 tool 就能掌握完整 Bug 脈絡（省去逐一呼叫 console/network/voice 各 tool）。Full report timeline.',
    { report_id: z.string().describe('報告 ID') },
    async (args) => {
      const { data: report, error } = await supabase()
        .from('reports')
        .select('*')
        .eq('report_id', args.report_id)
        .maybeSingle();
      if (error || !report) {
        if (error) console.error('get_timeline failed:', error.message); // 原始錯誤只記 log
        return txt('報告不存在或查詢失敗');
      }

      // 收集所有事件到統一陣列（console/network/voice 用絕對 Date.now() ms；marker 是相對秒數，稍後換算）
      const events: Array<{ time: number; icon: string; text: string }> = [];

      const consoleLogs: Array<{ level?: string; message?: string; timestamp?: number; source?: string }> =
        report.console_logs || [];
      consoleLogs.forEach((log) => {
        const icon = log.level === 'error' ? '❌' : log.level === 'warn' ? '⚠️' : 'ℹ️';
        const src = log.source && log.source !== 'console' ? ` <${log.source}>` : '';
        events.push({
          time: log.timestamp || 0,
          icon,
          text: `[Console ${log.level || 'log'}${src}] ${log.message ?? ''}`,
        });
      });

      const networkErrors: Array<{ method?: string; url?: string; status?: number; duration?: number; timestamp?: number }> =
        report.network_errors || [];
      networkErrors.forEach((net) => {
        events.push({
          time: net.timestamp || 0,
          icon: '🌐',
          text: `[Network] ${net.method || '?'} ${net.url || ''} → ${net.status ?? '?'} (${net.duration ?? '?'}ms)`,
        });
      });

      const voiceTranscript: Array<{ text?: string; timestamp?: number }> = report.voice_transcript || [];
      voiceTranscript.forEach((v) => {
        events.push({ time: v.timestamp || 0, icon: '🎙️', text: `[語音] ${v.text ?? ''}` });
      });

      // 絕對時間基準：取 console/network/voice 中最早的正時間戳（marker 相對此基準換算）
      const absTimes = events.map((e) => e.time).filter((t) => t > 0);
      const startTime = absTimes.length ? Math.min(...absTimes) : 0;

      // 標記（TimeMarker：time_sec 相對錄製起點的秒數、note 說明——非 timestamp/label）
      const markers: Array<{ time_sec?: number; note?: string }> = report.markers || [];
      markers.forEach((m) => {
        const relMs = (m.time_sec ?? 0) * 1000;
        events.push({ time: startTime + relMs, icon: '📌', text: `[標記] ${m.note || 'user marker'}` });
      });

      events.sort((a, b) => a.time - b.time);

      // PM-159：最前面加 AI Bug 導航摘要（規則引擎，AI 直接定位問題不用盲讀）
      let timeline = generateBugSummary(report) + '\n\n';
      // 組裝時間軸文字
      timeline += `📋 報告時間軸 — ${report.title || report.url || report.report_id}\n`;
      timeline += `頁面：${report.url || '（無）'}\n`;
      timeline += `瀏覽器：${report.browser || 'unknown'}\n`;
      timeline += `螢幕：${report.screen_size || 'unknown'}\n`;

      if (report.network_snapshot) {
        const ns = report.network_snapshot as {
          atStart?: Record<string, unknown>;
          atEnd?: Record<string, unknown>;
          online?: boolean;
        };
        const s = (ns.atStart || ns) as { online?: boolean; effectiveType?: string; rtt?: number | null; downlink?: number | null };
        timeline += `網路：${s.online ? '在線' : '離線'} / ${s.effectiveType || '?'} / RTT ${s.rtt ?? '?'}ms / ${s.downlink ?? '?'} Mbps\n`;
        const e = ns.atEnd as { online?: boolean; effectiveType?: string } | undefined;
        if (e && (e.online !== s.online || e.effectiveType !== s.effectiveType)) {
          timeline += `　（結束時：${e.online ? '在線' : '離線'} / ${e.effectiveType || '?'}）\n`;
        }
      }

      if (report.storage_snapshot) {
        const ss = report.storage_snapshot as {
          localStorage?: unknown[];
          sessionStorage?: unknown[];
          cookieCount?: number;
        };
        const lsCount = ss.localStorage?.length || 0;
        const ssCount = ss.sessionStorage?.length || 0;
        timeline += `儲存：localStorage ${lsCount} 項 / sessionStorage ${ssCount} 項 / Cookie ${ss.cookieCount || 0} 個（敏感值已遮罩）\n`;
      }

      timeline += `描述：${report.description || '（無）'}\n`;
      timeline += `─────────────────────────\n`;

      if (events.length === 0) {
        timeline += '（無事件記錄）\n';
      } else {
        events.forEach((e) => {
          const relSec = ((e.time - startTime) / 1000).toFixed(1);
          timeline += `[${relSec}s] ${e.icon} ${e.text}\n`;
        });
      }

      timeline += `─────────────────────────\n`;
      timeline += `共 ${events.length} 個事件（Console ${consoleLogs.length} / Network ${networkErrors.length} / 語音 ${voiceTranscript.length} / 標記 ${markers.length}）`;

      return txtWithTokens(timeline, 'get_timeline', args.report_id);
    },
  );

  return server;
}
