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
import { HORNET_REAL_B64 } from './hornet-png';

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
  // PM-270：Discord Webhook URL（`wrangler secret put DISCORD_WEBHOOK_URL`）。未設定 → 靜默跳過。
  // 取代 PM-268 的 ntfy：ntfy.sh 按來源 IP 計配額，Workers 共用 IP 額度已滿 → 永遠 429（PM-269）。
  DISCORD_WEBHOOK_URL?: string;
  // PM-276：管理端安裝碼反查用（`wrangler secret put ADMIN_TOKEN`）。
  // **未設定時 /api/admin/verify-install 一律 404**——否則會變成任何人都能用安裝碼查到 email。
  ADMIN_TOKEN?: string;
  // PM-292：報告自動清理的開關（`wrangler secret put REPORT_CLEANUP`，值為 'on' 才會真的刪）。
  // **未設定 = dry-run**：只統計並回報，不刪任何東西。刪除不可逆，絕不能因為一次 deploy 就默默開始清資料。
  REPORT_CLEANUP?: string;
  // PM-268：per-request ExecutionContext，供 notifyFox 用 waitUntil 送出非阻塞推播（見 notifyFox 註解）。
  __ctx?: ExecutionContext;
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
// ── PM-268/270：即時推播（重要用戶事件 → FOX 的 Discord）──────────────────
/** PM-268：以 user_id 取 email 供推播文案用；查不到就退回 user_id（推播不該因此失敗）。 */
async function getUserEmail(userId: string, env: Env): Promise<string> {
  const { data } = await supa(env)
    .from('users')
    .select('email')
    .eq('user_id', userId)
    .maybeSingle();
  return (data as { email?: string } | null)?.email ?? userId;
}

/**
 * PM-270：推播到 Discord Webhook（未設 DISCORD_WEBHOOK_URL → 靜默跳過；失敗不影響主流程）。
 *
 * 為什麼從 ntfy 換過來（PM-269 查出的根因）：ntfy.sh 按「來源 IP」計每日配額，
 * 而 Workers 出網走共用 Cloudflare IP，該 IP 額度早被用光 → 每則都被回 429（code 42908）。
 * Discord webhook 的額度綁在 webhook 本身、與來源 IP 無關，且免費、原生支援 emoji + 中文。
 *
 * priority 沿用原本語意（>=4 視為重要）→ 只用來決定 embed 顏色，不再送任何 header。
 */
async function sendDiscord(env: Env, title: string, body: string, priority: number): Promise<void> {
  const url = env.DISCORD_WEBHOOK_URL?.trim();
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [
          {
            // Discord 上限：title 256 / description 4096 字元，超過整包會被回 400
            title: title.slice(0, 256),
            description: body.slice(0, 4096),
            color: priority >= 4 ? 0xff6b35 : 0x5865f2, // 重要=橘，一般=Discord 藍
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    if (!res.ok) {
      // PM-269 的教訓：失敗一定要留痕跡，否則「兌換成功卻沒收到通知」根本查不出來。
      // 有這行就能直接 `wrangler tail` 看到狀態碼與原因。
      console.error('Discord 推播失敗:', res.status, (await res.text().catch(() => '')).slice(0, 200));
    }
  } catch (e) {
    console.error('Discord 推播例外:', String(e));
  }
}

/**
 * PM-268：推播給 FOX。呼叫端介面不變（7 個觸發點不需動）。
 *
 * ⚠ 為什麼用 `ctx.waitUntil` 而不是 `void notifyFox(...)`：
 *   Cloudflare Workers 在回應送出後會終止 isolate，**沒被 await 也沒交給 waitUntil 的 fetch 會被中斷**
 *   （本專案既有的 mcp_usage 側寫就是為此改成 await）。但驗收要求「不阻塞主流程」，
 *   純 await 又會把推播延遲加到使用者請求上。`waitUntil` 是唯一同時滿足兩者的做法：
 *   回應照常立刻送出，isolate 會等推播送完才回收。
 *   取不到 ctx（或 ctx 已結束）時退回 fire-and-forget，最壞情況只是這則推播沒送到。
 *
 * 回傳 void（非 async）→ 呼叫端寫 `notifyFox(...)` 即可，不會產生 floating promise。
 */
function notifyFox(env: Env, title: string, body: string, priority = 3): void {
  if (!env.DISCORD_WEBHOOK_URL) return; // 未設定 → 靜默跳過（正式環境可不設）
  const p = sendDiscord(env, title, body, priority);
  try {
    env.__ctx?.waitUntil(p);
  } catch {
    /* ctx 已結束 → 保持 fire-and-forget，不再處理 */
  }
}

/**
 * PM-268：需要 email 的推播。**先確認有設 webhook 才查 DB**——否則未啟用推播時，
 * 每次兌換/付款/上傳報告都會白白多一次 Supabase 查詢；且 email 查詢一併放進 waitUntil，
 * 完全不佔用回應路徑（若寫成 `notifyFox(env, t, \`${await getUserEmail(...)}\`)` 就會卡住回應）。
 */
function notifyFoxForUser(
  env: Env,
  userId: string,
  title: string,
  makeBody: (email: string) => string,
  priority = 3,
): void {
  if (!env.DISCORD_WEBHOOK_URL) return;
  // 直接串 sendDiscord（而非 notifyFox）——這樣整條「查 email → 送推播」是**單一** promise，
  // waitUntil 會等到推播真的送完；若改呼叫 notifyFox 則它會另外註冊一個巢狀 waitUntil，
  // 外層 promise 在推播還沒送出前就 resolve，時序上較脆弱。
  const p = getUserEmail(userId, env)
    .then((email) => sendDiscord(env, title, makeBody(email), priority))
    .catch(() => {
      /* 查 email 失敗就放棄這則推播，不影響主流程 */
    });
  try {
    env.__ctx?.waitUntil(p);
  } catch {
    /* ctx 已結束 → 保持 fire-and-forget */
  }
}

// ── PM-276：安裝碼（BZ-XXXX）——綁 user_id、永不變，供 FOX 在推廣活動驗證身份 ──────
// 刻意排除易混淆字元（0/O、1/I/L）：這組碼會被口頭唸、手打、在 FB 私訊裡貼來貼去，
// 少一個「這是 0 還是 O」的往返比多幾萬組合更有價值。剩 31 字元 → 31^4 ≈ 92 萬組。
const INSTALL_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function randomInstallCode(): string {
  // 用 crypto.getRandomValues 而非 Math.random——這組碼等同用戶識別碼，不該可預測
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += INSTALL_CODE_ALPHABET[b % INSTALL_CODE_ALPHABET.length];
  return `BZ-${s}`;
}

/**
 * PM-276：取得（必要時產生）用戶的安裝碼。同一個 user_id 永遠拿到同一組——只有欄位為空時才寫入。
 * 任何失敗（欄位未建、連續碰撞）都回 null 而非拋錯：安裝碼只是輔助資訊，不該讓登入失敗。
 */
async function ensureInstallCode(userId: string, env: Env): Promise<string | null> {
  const { data, error: selErr } = await supa(env)
    .from('users')
    .select('install_code')
    .eq('user_id', userId)
    .maybeSingle();
  if (selErr) {
    console.error('install_code 查詢失敗（欄位可能尚未建立）:', selErr.message);
    return null;
  }
  const current = (data as { install_code?: string | null } | null)?.install_code ?? null;
  if (current) return current;

  // 碰撞極少見，但 UNIQUE 約束是最終防線 → 撞到就換一組重試
  for (let i = 0; i < 5; i++) {
    const code = randomInstallCode();
    const { error } = await supa(env)
      .from('users')
      .update({ install_code: code })
      .eq('user_id', userId)
      .is('install_code', null); // 併發時只有第一個請求會寫成功
    if (!error) {
      // 條件式 update 可能 0 列（另一個請求剛寫入）→ 回讀確認實際存的值
      const { data } = await supa(env)
        .from('users')
        .select('install_code')
        .eq('user_id', userId)
        .maybeSingle();
      return (data as { install_code?: string | null } | null)?.install_code ?? code;
    }
    if (error.code !== '23505') {
      console.error('install_code 產生失敗:', error.message);
      return null; // 欄位還沒建（FOX 未跑 ALTER）等情況 → 不要讓登入失敗
    }
  }
  console.error('install_code 連續碰撞 5 次');
  return null;
}

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
  // PM-276：這支查詢刻意**不**一起 select install_code。若 FOX 尚未跑 ALTER（欄位不存在），
  //   PostgREST 會讓整筆查詢失敗 → data 為 null → 既有用戶被誤判成新用戶 → 重複 INSERT +
  //   每次登入都推一則假的「🆕 新用戶」。安裝碼交給 ensureInstallCode 自己查（失敗只回 null）。
  const { data: user } = await supa(env)
    .from('users')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  const isNewUser = !user;
  if (isNewUser) {
    await supa(env)
      .from('users')
      .insert({ user_id: userId, email, name: body.name || '', plan: 'free' });
  }
  // PM-276：舊用戶（本功能上線前就註冊的）第一次登入時補發，之後不再變動
  const installCode = await ensureInstallCode(userId, env);
  if (isNewUser) {
    // PM-276：通知帶上安裝碼，FOX 之後可用安裝碼在 Discord 反查是哪位用戶
    notifyFox(env, '🆕 新用戶', `${email} 剛註冊了 BugEzy\n安裝碼：${installCode ?? '（產生失敗）'}`, 4);
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
  // PM-272：放行 YouTube 隱私增強網域，供 /testimonials 嵌入用戶心得影片。
  //   ⚠ 沒有這行的話 frame-src 會回退到 default-src 'self'，iframe 直接被 CSP 擋掉（畫面只剩空白框）。
  //   只放行 youtube-nocookie（不放 youtube.com），且 frame-ancestors 'none' 不受影響——
  //   這是「我們可以嵌入誰」，與「誰可以嵌入我們」是兩回事。
  "frame-src https://www.youtube-nocookie.com; " +
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
type PageLang = 'zh' | 'en' | 'zh-CN' | 'ja' | 'ko' | 'vi';
function detectLang(request: Request): PageLang {
  const accept = (request.headers.get('Accept-Language') || '').toLowerCase();
  // PM-233/234/235：日語（ja）、韓語（ko）、越南語（vi）優先判定（其 header 不含 zh，安全）。
  if (/\bja\b/.test(accept)) return 'ja';
  if (/\bko\b/.test(accept)) return 'ko';
  if (/\bvi\b/.test(accept)) return 'vi';
  // PM-232：簡體（zh-cn / zh-hans）→ 簡中；PM-231：其餘含 zh（zh-tw/zh-hant/zh-hk/zh…不限第一順位）→ 繁中；否則英文。
  if (/zh-cn|zh-hans/.test(accept)) return 'zh-CN';
  if (/zh/.test(accept)) return 'zh';
  return 'en';
}
function getLang(request: Request): PageLang {
  const param = new URL(request.url).searchParams.get('lang');
  if (param === 'en' || param === 'zh' || param === 'zh-CN' || param === 'ja' || param === 'ko' || param === 'vi') return param; // 手動覆蓋優先
  return detectLang(request);
}
/** PM-289：只取 query 上明示的 `?lang=`（沒帶回 null）。canonical 用，**不做 Accept-Language 偵測**。 */
function explicitLang(request: Request): PageLang | null {
  const p = new URL(request.url).searchParams.get('lang');
  return p === 'en' || p === 'zh' || p === 'zh-CN' || p === 'ja' || p === 'ko' || p === 'vi'
    ? p
    : null;
}
// PM-232~235：<html lang> 屬性——zh→zh-Hant、zh-CN→zh-Hans、ja→ja、ko→ko、vi→vi、en→en（BCP-47，利 SEO/螢幕閱讀器）。
function htmlLang(lang: PageLang): string {
  if (lang === 'zh') return 'zh-Hant';
  if (lang === 'zh-CN') return 'zh-Hans';
  if (lang === 'ja') return 'ja';
  if (lang === 'ko') return 'ko';
  if (lang === 'vi') return 'vi';
  return 'en';
}
// PM-232：頁面 t() 工廠——zh-CN 由繁體即時轉簡體（makeT）；ja/ko/vi 由 JA_MAP/KO_MAP/VI_MAP 以繁體字串查表（缺則 fallback 英文）；其餘 zh/en 直接取值。
function makeT(lang: PageLang): (zh: string, en: string) => string {
  if (lang === 'zh-CN') return (zh: string) => toSimplified(zh);
  if (lang === 'zh') return (zh: string) => zh;
  if (lang === 'ja') return (zh: string, en: string) => JA_MAP[zh] ?? en; // PM-233
  if (lang === 'ko') return (zh: string, en: string) => KO_MAP[zh] ?? en; // PM-234
  if (lang === 'vi') return (zh: string, en: string) => VI_MAP[zh] ?? en; // PM-235
  return (_zh: string, en: string) => en;
}


// ── PM-434：官網共用外殼（大黃蜂視覺系統）─────────────────────────────────
//   11 個 *Page() 共用同一組色票 / nav / footer，改一次全部套用。
//   §3 字型直接外連 Google Fonts —— server 端頁面沒有擴充那套 CWS 隱私限制。
const SITE_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;800&family=Noto+Sans+TC:wght@400;500;600;700;900&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">`;

//   ⚠ nav / footer 的選擇器一律用「元素 + class」（0,1,1），才壓得過各頁既有的
//     `header {}` `footer {}` `footer a {}` 元素選擇器（0,0,1 / 0,0,2）。
const SITE_CHROME_CSS = `
  :root {
    --y:#F7BE00; --y-deep:#DFA800; --y-pale:#FFE9AE; --cream:#FFF4D6;
    --ink:#14110B; --ink-2:#0E0C08; --brown:#7A4E1D; --brown-d:#4A2F12; --err:#8A2A0F;
    --on-dark:#A08B62; --on-dark-2:#C9A15A; --on-y:#3A2409; --on-y-2:#5E3A14;
    --hex:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);
    --font-brand:Archivo,'Noto Sans TC','Microsoft JhengHei',system-ui,sans-serif;
    --font-ui:'Noto Sans TC',system-ui,-apple-system,'Segoe UI','Microsoft JhengHei',sans-serif;
    --font-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  nav.hz-nav { display:flex; align-items:center; gap:16px; padding:14px 40px; background:var(--ink); flex-wrap:wrap; }
  /* §5.B 六角斜紋標記。官網 nav 用兩層（黃殼 + 透明斜紋），不是報告頁那種三層。 */
  nav.hz-nav .hz-hex { width:26px; height:30px; flex-shrink:0; background:var(--y); clip-path:var(--hex); display:flex; align-items:center; justify-content:center; }
  nav.hz-nav .hz-hex > i { width:17px; height:20px; clip-path:var(--hex); background:repeating-linear-gradient(162deg,var(--ink) 0 3px,transparent 3px 6px); }
  nav.hz-nav .hz-brand { display:flex; align-items:center; gap:11px; font:800 19px/1 var(--font-brand); letter-spacing:.02em; color:var(--y); text-decoration:none; }
  nav.hz-nav .hz-links { display:flex; gap:22px; margin-left:6px; flex-wrap:wrap; }
  nav.hz-nav .hz-links a { font:600 13px/1 var(--font-ui); color:var(--on-dark-2); text-decoration:none; }
  nav.hz-nav .hz-links a:hover, nav.hz-nav .hz-links a.on { color:var(--y); }
  nav.hz-nav .hz-spacer { flex:1; }
  nav.hz-nav .hz-lang { display:flex; gap:1px; border:1px solid #3A3122; border-radius:8px; overflow:hidden; }
  nav.hz-nav .hz-lang a { padding:5px 10px; font:600 11px/1 var(--font-ui); color:var(--on-dark-2); text-decoration:none; }
  nav.hz-nav .hz-lang a.mono { font-family:var(--font-mono); }
  nav.hz-nav .hz-lang a.on { background:var(--y); color:var(--ink); font-weight:700; }
  nav.hz-nav .hz-cta { padding:9px 17px; border:none; border-radius:9px; background:var(--y); color:var(--ink); font:700 13px/1 var(--font-ui); text-decoration:none; white-space:nowrap; }
  nav.hz-nav .hz-cta:hover { background:var(--y-deep); }

  footer.hz-foot { margin:0; padding:34px 40px; background:var(--ink-2); border:none; display:flex; flex-direction:column; gap:16px; align-items:center; }
  footer.hz-foot .hz-foot-links { display:flex; gap:20px; flex-wrap:wrap; justify-content:center; }
  footer.hz-foot .hz-foot-links a { margin:0; font:600 12.5px/1 var(--font-ui); color:var(--on-dark); text-decoration:none; }
  footer.hz-foot .hz-foot-links a:hover { color:var(--y); }
  /* §2.4：深底上的次要文字只有兩階。設計稿這行寫 #6B5A3D（2.1:1），黑底上讀不到 → 用 --on-dark。 */
  footer.hz-foot .hz-foot-meta { font:500 11.5px/1.7 var(--font-ui); color:var(--on-dark); text-align:center; }
  footer.hz-foot .hz-foot-meta a { color:var(--on-dark-2); text-decoration:none; }
  @media (max-width:720px) {
    nav.hz-nav { padding:12px 18px; gap:12px; }
    nav.hz-nav .hz-spacer { display:none; }
    footer.hz-foot { padding:28px 18px; }
  }
`;

//   PM-435：內容頁（FAQ／更新日誌／隱私／功能／指南／AI 客服手冊）共用的內容區樣式。
//   §7.2 米白底 + 白卡 + 2px 黑框；§6 條列用六角，不用符號字元。
const SITE_CONTENT_CSS = `
  * { box-sizing:border-box; }
  body { margin:0; padding:0; background:var(--cream); color:var(--ink);
    font-family:var(--font-ui); line-height:1.75; font-size:15px; }
  .wrap { max-width:820px; margin:0 auto; padding:44px 24px 72px; }
  h1 { font:800 28px/1.35 var(--font-ui); color:var(--ink); margin:0 0 8px; }
  h2 { font:700 19px/1.45 var(--font-ui); color:var(--ink); margin:34px 0 10px; }
  h3 { font:700 17px/1.4 var(--font-ui); color:var(--ink); margin:22px 0 8px; }
  p { margin:8px 0; }
  a { color:var(--brown-d); text-decoration:none; font-weight:600; }
  a:hover { text-decoration:underline; }
  .lead { font:500 15px/1.8 var(--font-ui); color:var(--on-y); margin:0 0 4px; }
  .updated, .note, .help-note { font:600 13px/1.7 var(--font-ui); color:var(--on-y-2); }
  /* §7.2 白卡：內容頁唯一的容器樣式 */
  .hz-card { margin:22px 0 0; padding:18px 20px; background:#fff; border:2px solid var(--ink); border-radius:12px; }
  /* §6 條列用六角，不用 disc／✓／emoji */
  ul { list-style:none; margin:8px 0 0; padding:0; }
  li { position:relative; margin:6px 0; padding-left:18px; font:500 13.5px/1.8 var(--font-ui); color:var(--on-y); }
  li::before { content:''; position:absolute; left:0; top:.62em; width:8px; height:9px;
    background:var(--y); clip-path:var(--hex); }
  ol { margin:8px 0 0; padding-left:22px; }
  ol li { padding-left:0; }
  ol li::before { content:none; }
  /* 黃色螢光筆：整頁只有真正的重點才用 */
  .hz-mark { font-weight:700; background:var(--y); padding:1px 5px; border-radius:3px; }
  /* §2.3 咖啡＝系統補充說明 */
  .hz-note { display:flex; align-items:flex-start; gap:10px; margin:12px 0 0; padding:11px 13px;
    border-radius:10px; background:var(--brown); font:600 12px/1.7 var(--font-ui); color:var(--y-pale); }
  .hz-note::before { content:''; flex-shrink:0; margin-top:5px; width:8px; height:9px;
    background:var(--y); clip-path:var(--hex); }
  .hz-note a { color:var(--y); }
  /* §3.3 機器輸出一律等寬字 */
  .hz-label { font:700 10.5px/1 var(--font-mono); letter-spacing:.1em; color:var(--on-y-2); text-transform:uppercase; }
  code { padding:1px 6px; border-radius:5px; background:var(--y-pale); color:var(--brown-d);
    font-family:var(--font-mono); font-size:13px; word-break:break-word; }
  pre { margin:10px 0; padding:12px 14px; background:var(--ink); border-radius:10px; overflow-x:auto;
    font-family:var(--font-mono); font-size:13px; line-height:1.7; color:var(--y-pale); white-space:pre-wrap; word-break:break-word; }
  pre code { background:transparent; padding:0; color:inherit; }
  table { width:100%; border-collapse:separate; border-spacing:0; margin:12px 0 0;
    border:2px solid var(--ink); border-radius:12px; overflow:hidden; }
  th, td { padding:9px 11px; text-align:left; vertical-align:top; font:500 13px/1.7 var(--font-ui);
    border-bottom:1px solid rgba(20,17,11,.14); }
  th { background:var(--ink); color:var(--y); font:700 11px/1.6 var(--font-mono); letter-spacing:.06em; }
  tbody tr:last-child td { border-bottom:none; }
  td { background:#fff; color:var(--on-y); }
  /* §7.1 硬投影按鈕（內容頁只有主／次兩種） */
  .btn, .cta-btn { display:inline-block; margin:6px 8px 0 0; padding:11px 20px; border:2px solid var(--ink);
    border-radius:11px; background:var(--ink); color:var(--y); font:700 14px/1 var(--font-ui);
    text-decoration:none; cursor:pointer; box-shadow:3px 3px 0 var(--brown-d); }
  .btn:hover, .cta-btn:hover { transform:translate(1px,1px); box-shadow:2px 2px 0 var(--brown-d); text-decoration:none; }
  .btn.secondary, .cta-btn.ghost { background:transparent; color:var(--brown-d); border-color:rgba(20,17,11,.45); box-shadow:none; }
  .btn.secondary:hover, .cta-btn.ghost:hover { transform:none; border-color:var(--ink); color:var(--ink); }
  .btn.copied, .copy-btn.copied { background:var(--y); color:var(--ink); border-color:var(--ink); }
  .copy-btn { margin-left:8px; padding:4px 12px; border:1.5px solid var(--ink); border-radius:7px;
    background:var(--y); color:var(--ink); font:700 12px/1 var(--font-ui); cursor:pointer;
    white-space:nowrap; vertical-align:middle; }
  .copy-btn:hover { background:var(--y-deep); }
  @media (max-width:640px) { .wrap { padding:30px 16px 56px; } h1 { font-size:24px; } }
`;

/** PM-434：官網共用黑色 nav。langs 必須跟該頁 hreflangTags 宣告的語言一致（見 PM-289 canonical 鐵則）。 */
function siteNav(lang: PageLang, langs: PageLang[], active: string): string {
  const t = makeT(lang);
  const CWS = 'https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj';
  const nav: Array<[string, string, string]> = [
    ['/features', t('功能', 'Features'), 'features'],
    ['/guide', t('指南', 'Guide'), 'guide'],
    ['/#pricing', t('定價', 'Pricing'), 'pricing'],
    ['/blog', t('部落格', 'Blog'), 'blog'],
    ['/faq', 'FAQ', 'faq'],
  ];
  const labels: Record<string, [string, boolean]> = {
    zh: ['繁', false],
    'zh-CN': ['简', false],
    en: ['EN', true],
    ja: ['日', false],
    ko: ['한', false],
    vi: ['VI', true],
  };
  // 單語頁（LANGS_ZH）不掛切換器：沒有其他語言版本可切。
  const langBar =
    langs.length < 2
      ? ''
      : `<div class="hz-lang">${langs
          .map((l) => {
            const [label, mono] = labels[l];
            const cls = [mono ? 'mono' : '', l === lang ? 'on' : ''].filter(Boolean).join(' ');
            return `<a href="?lang=${l}"${cls ? ` class="${cls}"` : ''}>${label}</a>`;
          })
          .join('')}</div>`;
  return `<nav class="hz-nav">
  <a class="hz-brand" href="/"><span class="hz-hex"><i></i></span>BugEzy</a>
  <div class="hz-links">${nav
    .map(([href, label, key]) => `<a href="${href}"${key === active ? ' class="on"' : ''}>${label}</a>`)
    .join('')}</div>
  <div class="hz-spacer"></div>
  ${langBar}
  <a class="hz-cta" href="${CWS}" target="_blank" rel="noopener">${t('免費安裝', 'Install free')}</a>
</nav>`;
}

/** PM-434：官網共用深黑 footer。 */
function siteFooter(lang: PageLang): string {
  const t = makeT(lang);
  const links: Array<[string, string]> = [
    ['/', t('首頁', 'Home')],
    ['/features', t('功能說明', 'Features')],
    ['/guide', t('完整指南', 'Guide')],
    ['/faq', 'FAQ'],
    ['/blog', t('部落格', 'Blog')],
    ['/testimonials', t('用戶心得', 'Testimonials')],
    ['/changelog', t('更新日誌', 'Changelog')],
    ['/skill', t('AI 客服手冊', 'AI Manual')],
    ['/privacy', t('隱私政策', 'Privacy')],
    ['/feedback', t('問題回報', 'Feedback')],
    ['/reports', t('我的報告', 'My Reports')],
    ['https://github.com/fox100039-design/bugezy', 'GitHub'],
  ];
  return `<footer class="hz-foot">
  <div class="hz-foot-links">${links
    .map(([href, label]) =>
      href.startsWith('http')
        ? `<a href="${href}" target="_blank" rel="noopener">${label}</a>`
        : `<a href="${href}">${label}</a>`,
    )
    .join('')}</div>
  <div class="hz-foot-meta">${t('聯絡', 'Contact')}：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a><br>© 2026 BugEzy · v1.2.0 · ${t('亞洲平價 MCP 語音除錯工具', 'Affordable MCP voice debugging for Asia')}</div>
</footer>`;
}

// PM-232：繁體 → 簡體轉換（與 extension/src/t2s.ts 同表）。詞彙先於字元（Mainland 用語）。
const T2S_TERMS: Array<[string, string]> = [
  ['擴充功能', '扩展程序'],
  ['擴充', '扩展'],
  ['設定', '设置'],
  ['進階', '高级'],
  ['程式', '程序'],
  ['檔案', '文件'],
];
const T2S_CHARS: Record<string, string> = {"丟":"丢","並":"并","乾":"干","亂":"乱","亞":"亚","佈":"布","佔":"占","併":"并","來":"来","個":"个","們":"们","側":"侧","偵":"侦","偽":"伪","備":"备","傳":"传","僅":"仅","價":"价","優":"优","儲":"储","兌":"兑","兒":"儿","內":"内","兩":"两","冊":"册","冪":"幂","別":"别","刪":"删","則":"则","剛":"刚","劃":"划","動":"动","務":"务","勝":"胜","勢":"势","匯":"汇","區":"区","協":"协","卻":"却","參":"参","員":"员","問":"问","啟":"启","單":"单","嗎":"吗","嘗":"尝","噴":"喷","嚴":"严","國":"国","圍":"围","圓":"圆","圖":"图","團":"团","執":"执","報":"报","場":"场","塊":"块","塗":"涂","壇":"坛","壞":"坏","夠":"够","夾":"夹","學":"学","實":"实","審":"审","寫":"写","寬":"宽","將":"将","專":"专","尋":"寻","對":"对","導":"导","層":"层","屬":"属","師":"师","帳":"帐","帶":"带","幀":"帧","幫":"帮","幾":"几","庫":"库","廠":"厂","廣":"广","廳":"厅","張":"张","強":"强","彈":"弹","彙":"汇","後":"后","徑":"径","從":"从","復":"复","徹":"彻","恆":"恒","態":"态","慣":"惯","憑":"凭","應":"应","戶":"户","拋":"抛","捨":"舍","捲":"卷","掃":"扫","掛":"挂","採":"采","換":"换","損":"损","搶":"抢","撐":"撑","擁":"拥","擇":"择","擊":"击","擋":"挡","擔":"担","據":"据","擬":"拟","擴":"扩","擷":"撷","擾":"扰","攔":"拦","敗":"败","數":"数","斂":"敛","斷":"断","於":"于","時":"时","暫":"暂","書":"书","會":"会","條":"条","棄":"弃","業":"业","極":"极","構":"构","標":"标","樣":"样","橋":"桥","機":"机","橫":"横","檔":"档","檢":"检","檻":"槛","欄":"栏","權":"权","歡":"欢","歲":"岁","歷":"历","歸":"归","殘":"残","殺":"杀","汙":"污","決":"决","沒":"没","況":"况","洩":"泄","淨":"净","測":"测","準":"准","溝":"沟","滿":"满","漸":"渐","濃":"浓","濫":"滥","濾":"滤","瀏":"浏","灣":"湾","為":"为","無":"无","燈":"灯","營":"营","爭":"争","牆":"墙","狀":"状","獨":"独","現":"现","環":"环","產":"产","畫":"画","異":"异","當":"当","疊":"叠","癒":"愈","發":"发","盡":"尽","監":"监","盤":"盘","確":"确","碼":"码","禦":"御","種":"种","稱":"称","積":"积","穩":"稳","竄":"窜","競":"竞","筆":"笔","節":"节","範":"范","簡":"简","簽":"签","籤":"签","粵":"粤","紀":"纪","約":"约","紅":"红","納":"纳","純":"纯","級":"级","細":"细","紹":"绍","終":"终","練":"练","組":"组","結":"结","絕":"绝","絡":"络","給":"给","統":"统","綁":"绑","經":"经","綠":"绿","維":"维","網":"网","綴":"缀","緊":"紧","緒":"绪","線":"线","緣":"缘","編":"编","緩":"缓","縫":"缝","縮":"缩","縱":"纵","總":"总","繞":"绕","繪":"绘","繼":"继","續":"续","義":"义","聯":"联","聲":"声","職":"职","聽":"听","脈":"脉","脫":"脱","脹":"胀","腦":"脑","臨":"临","與":"与","舉":"举","舊":"旧","蓋":"盖","薦":"荐","藍":"蓝","處":"处","虛":"虚","號":"号","螢":"萤","術":"术","衝":"冲","補":"补","裝":"装","裡":"里","製":"制","複":"复","見":"见","規":"规","視":"视","覺":"觉","覽":"览","觸":"触","訂":"订","計":"计","訊":"讯","記":"记","訓":"训","訪":"访","設":"设","許":"许","訴":"诉","診":"诊","註":"注","評":"评","詞":"词","詢":"询","試":"试","話":"话","該":"该","詳":"详","誌":"志","認":"认","語":"语","誤":"误","說":"说","誰":"谁","調":"调","請":"请","論":"论","講":"讲","謝":"谢","謹":"谨","證":"证","識":"识","譯":"译","議":"议","護":"护","讀":"读","變":"变","讓":"让","負":"负","責":"责","貴":"贵","買":"买","費":"费","貼":"贴","資":"资","賣":"卖","賦":"赋","質":"质","賴":"赖","購":"购","賽":"赛","贅":"赘","跡":"迹","蹤":"踪","躍":"跃","軌":"轨","軸":"轴","較":"较","載":"载","輕":"轻","輪":"轮","輯":"辑","輸":"输","轉":"转","辦":"办","迴":"回","這":"这","連":"连","週":"周","進":"进","運":"运","過":"过","達":"达","遞":"递","遠":"远","適":"适","遲":"迟","選":"选","遺":"遗","還":"还","邊":"边","邏":"逻","釋":"释","釘":"钉","鈕":"钮","銷":"销","錄":"录","錢":"钱","錯":"错","鍵":"键","鎖":"锁","鏈":"链","鏡":"镜","鐘":"钟","鑰":"钥","長":"长","門":"门","閃":"闪","閉":"闭","開":"开","閒":"闲","間":"间","閱":"阅","關":"关","陣":"阵","隊":"队","階":"阶","際":"际","隨":"随","險":"险","隱":"隐","雖":"虽","雙":"双","雜":"杂","離":"离","雲":"云","電":"电","靜":"静","韓":"韩","響":"响","頁":"页","頂":"顶","項":"项","順":"顺","須":"须","預":"预","頓":"顿","頭":"头","頻":"频","題":"题","額":"额","顏":"颜","類":"类","顯":"显","風":"风","餘":"余","饋":"馈","馬":"马","駐":"驻","驅":"驱","驗":"验","驟":"骤","體":"体","鮮":"鲜","麥":"麦","麵":"面","麼":"么","點":"点","齊":"齐"};
function toSimplified(s: string): string {
  let out = s;
  for (const [tw, cn] of T2S_TERMS) {
    if (out.indexOf(tw) !== -1) out = out.split(tw).join(cn);
  }
  let res = '';
  for (const ch of out) res += T2S_CHARS[ch] ?? ch;
  return res;
}

// PM-233：日語頁面翻譯表（繁體 zh 原文 → 日文）。makeT('ja') 以 t() 的第一參數（繁體）查此表，
// 未收錄者 fallback 英文。涵蓋首頁（homePage）+ 完整功能頁（featuresPage）的所有可見字串。
// 敬體（です/ます）；技術術語保留英文（Bug/Console/Network/DOM/MCP/Token/Whisper/CLI/API/JWT/PII…）。
const JA_MAP: Record<string, string> = {
  // ── 共用 / SEO ──
  'BugEzy — 開發者 Bug 報告工具，AI 幫你修': 'BugEzy — 開発者向け Bug レポートツール、AI が修正',
  '亞洲最平價的 MCP 語音除錯工具。錄製 Bug、AI 自動分析、一鍵報告。支援 Claude、Cursor、Windsurf 等 7 大 AI 工具。月費 NT$80 起。':
    'アジア最安の MCP 音声デバッグツール。Bug を録画し、AI が自動分析、ワンクリックでレポート。Claude、Cursor、Windsurf など 7 大 AI ツールに対応。月額 NT$80 から。',
  '語音除錯': '音声デバッグ',
  // ── 首頁 Hero ──
  '遇到 Bug，說不清楚？': 'Bug をうまく説明できない？',
  '按一下錄製，用說的就好。BugEzy 自動收集畫面、操作、錯誤訊息，讓 AI 幫你修。':
    'ワンクリックで録画、あとは話すだけ。BugEzy が画面・操作・エラーメッセージを自動で収集し、AI が修正します。',
  '🔧 免費安裝 Chrome 擴充功能': 'Chrome 拡張機能を無料インストール',
  '免費版每月 10 次錄製 · 不需信用卡': '無料版は毎月 10 回の録画 · クレジットカード不要',
  // ── 三步驟 ──
  '簡單三步，不用教': '簡単 3 ステップ、説明不要',
  '按下錄製': '録画開始',
  '打開 BugEzy，按一下就開始。邊操作邊說出你遇到的問題。':
    'BugEzy を開いてワンクリックで開始。操作しながら問題を話してください。',
  '自動整理': '自動整理',
  'BugEzy 自動收集畫面錄影、錯誤訊息、操作軌跡，整理成一份報告。':
    'BugEzy が画面録画・エラーメッセージ・操作履歴を自動で収集し、1 つのレポートにまとめます。',
  'AI 幫你修': 'AI が修正',
  '把報告交給 AI，它直接告訴你哪裡壞了、怎麼修。':
    'レポートを AI に渡すだけで、どこが壊れているか、どう直すかを教えてくれます。',
  // ── 截圖展示 ──
  '眼見為憑': '実際に見てみる',
  '錄製中': '録画中',
  '錄製超簡單': '録画はとても簡単',
  '打開瀏覽器，按下錄製，邊操作邊用嘴巴講。你的聲音會即時變成文字。':
    'ブラウザを開いて録画を開始し、操作しながら話すだけ。あなたの声がリアルタイムで文字になります。',
  '報告': 'レポート',
  '報告自動整理': 'レポートを自動整理',
  '錄完後，BugEzy 自動產出完整報告 — 畫面回放、語音記錄、操作軌跡，全部幫你整理好。':
    '録画後、BugEzy が完全なレポートを自動生成 — 画面リプレイ、音声記録、操作履歴をすべて整理します。',
  'AI 校正與 Token': 'AI 校正とトークン',
  'AI 校正 + 省 93% 費用': 'AI 校正 + 費用 93% 節約',
  'AI 自動校正語音辨識的錯字，還幫你精簡重點。比起直接丟截圖給 AI，省下 93% 的費用。':
    'AI が音声認識の誤字を自動校正し、要点も要約します。スクリーンショットを直接 AI に送るより、費用を 93% 節約できます。',
  'AI 修復': 'AI 修正',
  'AI 直接幫你修 Bug': 'AI が Bug を直接修正',
  '把報告交給 AI，一句「幫我找出問題」，AI 就自動分析、找出根因、給你修復程式碼。不用再截圖、複製貼上、來回解釋。':
    'レポートを AI に渡して「問題を見つけて」と一言。AI が自動で分析し、根本原因を特定し、修正コードを提示します。もうスクリーンショットやコピペ、何度も説明する必要はありません。',
  // ── 賣點 ──
  '為什麼選 BugEzy': 'なぜ BugEzy なのか',
  '用說的就好 — 支援中文、粵語、英文': '話すだけ — 中国語・広東語・英語に対応',
  '一鍵錄製 — 畫面 + 聲音 + 操作同步捕捉': 'ワンクリック録画 — 画面 + 音声 + 操作を同時にキャプチャ',
  'AI 自動分析 — 13 種 MCP 工具': 'AI 自動分析 — 13 種類の MCP ツール',
  '省 93% 費用 — 比截圖丟 AI 便宜': '費用 93% 節約 — スクリーンショットを送るより安い',
  '隱私保護 — 敏感資料自動打碼': 'プライバシー保護 — 機密データを自動マスク',
  '免費開始 — 月費只要 NT$80': '無料で開始 — 月額わずか NT$80',
  '錄一次，所有 AI 讀 — 多工具同步連線': '一度録画すればすべての AI が読める — マルチツール同期',
  '查看完整功能 →': '全機能を見る →',
  // ── 語言區 ──
  '用你的母語說': '母国語で話そう',
  '支援七種語言語音輸入': '7 言語の音声入力に対応',
  '簡體中文': '簡体字中国語',
  '語言選擇': '言語選択',
  '繁體中文': '繁体字中国語',
  '粵語': '広東語',
  // ── CTA / Footer ──
  '還在用截圖跟 AI 解釋 Bug？試試用說的。': 'まだスクリーンショットで AI に Bug を説明していますか？話すだけを試してみてください。',
  '免費安裝': '無料インストール',
  '使用指南': '使い方ガイド',
  '隱私政策': 'プライバシーポリシー',
  '聯絡我們': 'お問い合わせ',
  '安裝指南': 'インストールガイド',
  '功能說明': '機能紹介',
  '常見問題': 'よくある質問',
  '更新日誌': '更新履歴',
  '🤖 AI 客服手冊': 'AI サポートマニュアル',
  '📬 問題回報': 'フィードバック',
  '我的報告': 'マイレポート',
  '亞洲平價 MCP 語音除錯工具': 'アジアの手頃な MCP 音声デバッグツール',
  // ── featuresPage ──
  'BugEzy 功能 — 六種錄製模式、Whisper 語音、即時監控': 'BugEzy 機能 — 6 種類の録画モード、Whisper 音声、リアルタイム監視',
  'BugEzy 六種除錯模式：錄製、回溯 30 秒、截圖標注、即時監控、終端機 CLI、MCP AI 讀取。Whisper 精準語音轉錄。':
    'BugEzy の 6 種類のデバッグモード：録画、30 秒巻き戻し、スクリーンショット注釈、リアルタイム監視、Terminal CLI、MCP AI 読み取り。Whisper による高精度な音声文字起こし。',
  'BugEzy 完整功能介紹': 'BugEzy 全機能のご紹介',
  '給進階開發者、AI 助手、技術評估者的完整產品規格': '上級開発者・AI アシスタント・技術評価者のための完全な製品仕様',
  '六種錄製模式': '6 種類の録画モード',
  '錄製': '録画',
  'DOM 軌跡 + Console + Network + 語音': 'DOM 履歴 + Console + Network + 音声',
  '回溯 30 秒': '30 秒巻き戻し',
  'Bug 已發生？一鍵抓回最近 30 秒': 'Bug が起きた後？ワンクリックで直近 30 秒を取得',
  '截圖標注': 'スクリーンショット注釈',
  '全頁/區域/自由 + 馬賽克筆刷': '全ページ/範囲/フリーフォーム + モザイクブラシ',
  '鍵盤模式': 'キーボードモード',
  '吵雜環境純文字，不錄語音': '騒がしい環境ではテキストのみ、音声なし',
  '即時監控': 'リアルタイム監視',
  '背景持續監控，有錯自動通知': 'バックグラウンドで常時監視し、エラーを自動通知',
  'Python/Node 後端錯誤攔截': 'Python/Node バックエンドのエラーを捕捉',
  'Bug 捕捉能力（10/10）': 'Bug 捕捉能力（10/10）',
  '資源載入失敗 — img / script / css / 字型 404': 'リソース読み込み失敗 — img / script / css / フォント 404',
  'Web Vitals — CLS / FID / LCP 超標警告': 'Web Vitals — CLS / FID / LCP しきい値超過の警告',
  'DOM 軌跡 — rrweb 錄製 + 回放': 'DOM 履歴 — rrweb 録画 + リプレイ',
  'Storage 快照 — localStorage / sessionStorage / Cookie（PII 自動遮罩）':
    'Storage スナップショット — localStorage / sessionStorage / Cookie（PII 自動マスク）',
  '語音記錄 — 即時字幕 + Whisper 精準轉錄': '音声記録 — リアルタイム字幕 + Whisper 高精度文字起こし',
  '截圖 — 敏感欄位自動馬賽克': 'スクリーンショット — 機密欄を自動モザイク',
  'MCP 整合（13 Tools）': 'MCP 統合（13 Tools）',
  '報告概覽 + AI Bug 導航摘要': 'レポート概要 + AI Bug ナビゲーター',
  '完整時間軸（Console/Network/語音/環境一次看完）': '完全なタイムライン（Console/Network/音声/環境を一度に確認）',
  'Console error/warn 記錄': 'Console error/warn の記録',
  'Network 4xx/5xx 失敗': 'Network 4xx/5xx の失敗',
  '語音轉錄文字': '音声文字起こしテキスト',
  '截圖（高 Token）': 'スクリーンショット（高 Token）',
  'DOM 摘要（輕量）': 'DOM サマリー（軽量）',
  'DOM 錄影事件（高 Token）': 'DOM リプレイイベント（高 Token）',
  '頁面資訊': 'ページ情報',
  '報告 metadata': 'レポート metadata',
  '列出報告（需 session_token）': 'レポート一覧（session_token が必要）',
  '即時監控錯誤（需 session_token）': 'リアルタイム監視のエラー（session_token が必要）',
  'Terminal CLI 錯誤（付費）': 'Terminal CLI のエラー（有料）',
  'MCP 連接：': 'MCP エンドポイント：',
  '語音引擎': '音声エンジン',
  '即時字幕：': 'リアルタイム字幕：',
  'Web Speech API（免費版）': 'Web Speech API（無料版）',
  '精準轉錄：': '高精度文字起こし：',
  'Groq Whisper（付費版）': 'Groq Whisper（有料版）',
  'AI 校正 + 精簡：': 'AI 校正 + 要約：',
  '自動修錯字、濃縮重點': '誤字を自動修正し、要点を凝縮',
  '支援語言：': '対応言語：',
  '安裝：': 'インストール：',
  '結構化解析：': '構造化解析：',
  'Python traceback + Node.js 錯誤 → type / message / file / line':
    'Python traceback + Node.js エラー → type / message / file / line',
  '環境快照：': '環境スナップショット：',
  '語言 / 版本 / OS / 套件': '言語 / バージョン / OS / パッケージ',
  'PII 遮罩：': 'PII マスク：',
  'DB URI / API Key / JWT / 密碼 自動遮罩': 'DB URI / API Key / JWT / パスワードを自動マスク',
  '安全與隱私': 'セキュリティとプライバシー',
  'Fable5 四輪稽核 9.5+/10': 'Fable5 による 4 ラウンド監査 9.5+/10',
  'Supabase RLS 全表啟用': 'Supabase RLS を全テーブルで有効化',
  'CSP + frame-ancestors 防點擊劫持': 'CSP + frame-ancestors（クリックジャッキング対策）',
  'PII 自動遮罩 — JWT / Bearer / 手機 / 身分證 / 信用卡': 'PII 自動マスク — JWT / Bearer / 携帯番号 / 身分証 / クレジットカード',
  'Session token 走 URL fragment，不經 query string': 'Session token は URL fragment 経由、query string は不使用',
  'MCP 工作流 — 錄一次，所有 AI 都能讀': 'MCP ワークフロー — 一度録画すればすべての AI が読める',
  '一個 AI 搞定': '単一エージェント',
  '用 Claude Desktop、Cursor 或 Windsurf，連上 BugEzy MCP，直接讀報告修 Bug。一個 AI 從頭做到尾。':
    'Claude Desktop、Cursor、Windsurf を BugEzy MCP に接続し、レポートを読んで Bug を修正。1 つの AI で最初から最後まで完結。',
  '兩個 AI 分工': '2 つの AI で分担',
  'Claude Chat 讀報告做分析和策略規劃，Claude Code 讀同一份報告寫修復程式碼。PM 和工程師各司其職，讀的是同一份 Bug 報告。':
    'Claude Chat がレポートを読んで分析と計画を担当し、Claude Code が同じレポートを読んで修正コードを書く。PM とエンジニアの役割分担で、読むのは同じ Bug レポート。',
  '多工具同步': 'マルチツール同期',
  'Zed、Cursor、Claude Desktop 同時連線 BugEzy MCP，都讀同一份報告。團隊成員用不同工具，看到的是同一份 Bug 資料。':
    'Zed、Cursor、Claude Desktop が同時に BugEzy MCP に接続し、同じレポートを読む。チームメンバーが異なるツールを使っても、見るのは同じ Bug データ。',
  '一行連線，任何 MCP 工具都能用': '1 行で接続、あらゆる MCP クライアントで利用可能',
  '支援 Claude Desktop · Claude Code · Cursor · Windsurf · Zed · 任何 MCP 相容工具':
    'Claude Desktop · Claude Code · Cursor · Windsurf · Zed · あらゆる MCP 対応クライアントに対応',
  '定價': '料金',
  '免費': '無料',
  '每月 10 錄製 / 5 回溯 / 20 MCP': '毎月 録画 10 / 巻き戻し 5 / MCP 20',
  '月費': '月額',
  ' /月': ' /月',
  '全功能無限': '全機能無制限',
  '日票': 'デイパス',
  '24 小時無限': '24 時間無制限',
  '準備好了？': '準備はいいですか？',
  '回首頁': 'ホームへ',
  '首頁': 'ホーム',
  '聯絡': 'お問い合わせ',
  '📝 部落格': 'ブログ',
  '常見問題 · BugEzy': 'よくある質問 · BugEzy',
  'BugEzy 常見問題：安裝、錄製、語音辨識、MCP 設定、付費方案等問答。': 'BugEzy のよくある質問：インストール、録画、音声認識、MCP 設定、料金プランなど。',
  'BugEzy 常見問題': 'BugEzy よくある質問',
  '關於產品': '製品について',
  '關於隱私與安全': 'プライバシーとセキュリティ',
  '關於方案與付費': 'プランと料金',
  '關於技術': '技術について',
  'BugEzy 是什麼？': 'BugEzy とは？',
  'BugEzy 是一款 Chrome 擴充功能，讓開發者用語音 + 錄製的方式記錄 Bug，AI 透過 MCP 自動讀取報告並提供修復建議。省下 95% 的 debug 溝通時間。': 'BugEzy は Chrome 拡張機能で、開発者が音声 + 録画で Bug を記録し、AI が MCP 経由でレポートを自動的に読み取り修正案を提示します。デバッグの伝達時間を 95% 削減します。',
  'BugEzy 最大的優勢是什麼？': 'BugEzy の最大の強みは？',
  '專為亞洲開發者設計：中文/粵語/日韓語音支援、NT$80 超平價月費、MCP 整合讓 AI 直接讀報告。獨家功能：即時監控、30 秒回溯、Whisper 精準語音、終端機 CLI、Token 透明度。': 'アジアの開発者向け設計：中国語/広東語/日韓の音声対応、月額 NT$80 の低価格、MCP 統合で AI が直接レポートを読み取り。独自機能：リアルタイム監視、30 秒巻き戻し、Whisper 高精度音声、Terminal CLI、トークン透明性。',
  '支援哪些 AI 工具？': 'どの AI ツールに対応？',
  '任何支援 MCP 的 AI 工具都能用，包括 Claude Desktop、Claude Code、Cursor、VS Code + Copilot、Zed、Windsurf、Codex、Replit 等。只需要一行 URL：https://bugezy.dev/mcp': 'MCP に対応するあらゆる AI ツールで利用可能。Claude Desktop、Claude Code、Cursor、VS Code + Copilot、Zed、Windsurf、Codex、Replit など。必要なのは 1 行の URL だけ：https://bugezy.dev/mcp',
  '任何支援 MCP 的 AI 工具都能用，包括 Claude Desktop、Claude Code、Cursor、VS Code + Copilot、Zed、Windsurf、Codex、Replit 等。只需要一行 URL：': 'MCP に対応するあらゆる AI ツールで利用可能。Claude Desktop、Claude Code、Cursor、VS Code + Copilot、Zed、Windsurf、Codex、Replit など。必要なのは 1 行の URL だけ：',
  'BugEzy 會錄到我的密碼嗎？': 'BugEzy はパスワードを記録しますか？',
  'BugEzy 錄製的是 DOM 結構變化，不是螢幕截圖。密碼輸入框（type="password"）的內容會被 rrweb 自動遮蔽，不會錄到實際密碼。': 'BugEzy が記録するのは DOM 構造の変化であり、スクリーンショットではありません。パスワード入力欄（type="password"）の内容は rrweb によって自動的にマスクされ、実際のパスワードは記録されません。',
  '我的報告誰能看到？': '私のレポートは誰が見られますか？',
  '報告連結採用隨機加密 ID（UUID），無法被猜測或搜尋，只有擁有連結的人才能查看報告內容。若你將連結分享給同事或 AI 工具，他們就能查看；未分享的報告連結不會出現在任何公開列表中。建議不要把報告連結貼在公開場合（如公開 issue、論壇），避免非預期的存取。': 'レポートのリンクはランダムな暗号 ID（UUID）を使用し、推測や検索はできません。リンクを持つ人だけがレポートを閲覧できます。同僚や AI ツールにリンクを共有すればその相手も閲覧可能ですが、共有していないリンクは公開リストに一切表示されません。意図しないアクセスを防ぐため、公開の場（公開 issue やフォーラムなど）にリンクを貼らないことをお勧めします。',
  '資料存在哪裡？': 'データはどこに保存されますか？',
  '報告存在 Cloudflare R2（全球 CDN），使用者資料存在 Supabase（PostgreSQL）。所有傳輸都經過 HTTPS 加密。': 'レポートは Cloudflare R2（グローバル CDN）に、ユーザーデータは Supabase（PostgreSQL）に保存されます。すべての通信は HTTPS で暗号化されています。',
  '免費版有什麼限制？': '無料版の制限は？',
  '免費版每月可錄製 10 次、回溯 5 次、MCP AI 讀取 20 次。截圖標注和即時監控無限使用。報告保留 7 天。': '無料版は毎月 録画 10 回、巻き戻し 5 回、MCP AI 読み取り 20 回まで。スクリーンショット注釈とリアルタイム監視は無制限。レポートは 7 日間保持。',
  '付費版多少錢？': '有料版はいくら？',
  'NT$80/月（約 $3 USD），解鎖全功能無限次使用，報告保留 90 天，加上終端機 CLI、Whisper 精準語音等進階功能。': '月額 NT$80（約 $3 USD）で全機能を無制限に利用でき、レポートは 90 日間保持。Terminal CLI や Whisper 高精度音声などの高度な機能も追加されます。',
  '如何升級付費版？': '有料版へのアップグレード方法は？',
  '在 BugEzy popup 點「升級」按鈕，透過信用卡或 ATM 付款。': 'BugEzy のポップアップで「アップグレード」ボタンを押し、クレジットカードまたは ATM で支払います。',
  '可以取消訂閱嗎？': '解約できますか？',
  '可以，隨時取消。取消後當月剩餘天數仍可使用付費功能，下個月恢復為免費版。': 'はい、いつでも解約できます。解約後もその月の残り日数は有料機能を利用でき、翌月から無料版に戻ります。',
  '哪些瀏覽器支援？': 'どのブラウザに対応？',
  '目前支援 Chrome 和所有 Chromium 瀏覽器（Edge、Brave、Arc 等）。': '現在 Chrome およびすべての Chromium ブラウザ（Edge、Brave、Arc など）に対応しています。',
  '會影響網頁效能嗎？': 'ページのパフォーマンスに影響しますか？',
  '影響極小。BugEzy 只在你主動錄製時才記錄 DOM 變化，即時監控模式只攔截 Console error 和 Network error，不錄 DOM。': '影響はごくわずかです。BugEzy は録画中のみ DOM の変化を記録し、リアルタイム監視モードでは Console error と Network error のみを捕捉し、DOM は記録しません。',
  'MCP 是什麼？': 'MCP とは？',
  'Model Context Protocol（模型上下文協議），是 Anthropic 推出的開放標準，讓 AI 工具可以連接外部服務。BugEzy 的 MCP 讓 AI 直接讀取你的 Bug 報告，不需要複製貼上。': 'Model Context Protocol（モデルコンテキストプロトコル）は Anthropic が公開したオープン標準で、AI ツールが外部サービスに接続できるようにします。BugEzy の MCP により、AI はコピー＆ペーストなしで直接あなたの Bug レポートを読み取れます。',
  'Token 是什麼？為什麼 BugEzy 能省 Token？': 'Token とは？なぜ BugEzy はトークンを節約できる？',
  'Token 是 AI 處理文字的計量單位，等於你的 AI 使用費用。BugEzy 用結構化文字（而非截圖）傳送報告給 AI，同樣的 Bug 資訊只需要 1/20 的 Token。每次 MCP AI 讀取都會顯示 Token 估算，讓你看到省了多少。': 'Token は AI がテキストを処理する計量単位で、AI の利用料金に相当します。BugEzy はスクリーンショットではなく構造化テキストでレポートを AI に送るため、同じ Bug 情報でも 1/20 のトークンで済みます。MCP AI 読み取りのたびにトークン見積もりが表示され、どれだけ節約できたか確認できます。',
  '安裝 BugEzy — 3 分鐘搞定 Chrome 擴充 + MCP 設定': 'BugEzy インストール — 3 分で Chrome 拡張機能 + MCP 設定',
  '安裝 BugEzy Chrome 擴充功能，設定 MCP 連線，讓 AI 直接讀取你的 Bug 報告。支援 Claude、Cursor、Windsurf、Google Antigravity、Gemini CLI。': 'BugEzy Chrome 拡張機能をインストールし、MCP 接続を設定して AI に直接 Bug レポートを読ませましょう。Claude、Cursor、Windsurf、Google Antigravity、Gemini CLI に対応。',
  '🚀 安裝 BugEzy — 三分鐘搞定': 'BugEzy インストール — 3 分で完了',
  '從零到能用，跟著五步走，馬上讓 AI 幫你修 Bug。': 'ゼロから使えるまで、5 ステップで今すぐ AI に Bug を修正してもらいましょう。',
  '🤖 最快的安裝方式：複製貼給 AI': '最速のインストール方法：コピーして AI に貼る',
  '不懂技術？把下面這段複製貼給你的 AI（Claude Desktop / Claude Code / Cursor / Windsurf / VS Code + Cline / Google Antigravity / Gemini CLI），它會幫你搞定。': '技術に詳しくない？以下をコピーして AI（Claude Desktop / Claude Code / Cursor / Windsurf / VS Code + Cline / Google Antigravity / Gemini CLI）に貼れば、AI が設定してくれます。',
  '已複製！': 'コピーしました！',
  '一鍵複製，貼給你的 AI': 'ワンクリックでコピーして AI に貼る',
  '或依下方手動五步安裝 ↓': 'または以下の手動 5 ステップでインストール',
  '安裝擴充功能': '拡張機能をインストール',
  '前往 Chrome Web Store 的 BugEzy 頁面': 'Chrome ウェブストアの BugEzy ページへ',
  '點「加到 Chrome」→ 在彈窗按「新增擴充功能」確認': '「Chrome に追加」→ ポップアップで「拡張機能を追加」を押して確認',
  '前往 Chrome Web Store →': 'Chrome ウェブストアへ →',
  '支援 Chrome 以及所有 Chromium 核心瀏覽器（Edge、Brave、Arc 等）。': 'Chrome およびすべての Chromium 系ブラウザ（Edge、Brave、Arc など）に対応。',
  '固定到工具列': 'ツールバーに固定',
  '點瀏覽器右上角的拼圖圖示 🧩（擴充功能選單）': 'ブラウザ右上のパズルアイコン（拡張機能メニュー）をクリック',
  '找到 BugEzy 🐛 → 按旁邊的釘選 📌': 'BugEzy を見つけ → 横のピン を押す',
  '釘選後圖示會常駐在工具列，隨時一鍵開錄，不用每次翻選單。': 'ピン留めするとアイコンがツールバーに常駐し、いつでもワンクリックで録画開始。毎回メニューを開く必要はありません。',
  '登入': 'ログイン',
  '點工具列上的 BugEzy 圖示': 'ツールバーの BugEzy アイコン をクリック',
  '按「用 Google 登入」→ 選擇帳號授權': '「Google でログイン」→ アカウントを選んで承認',
  'popup 顯示你的名字 = 登入成功': 'ポップアップに名前が表示されたらログイン成功',
  '第一次錄製': '初めての録画',
  '開任意網頁 → 點 BugEzy 圖示 → 按「錄製」': '任意のウェブページを開く → BugEzy アイコンをクリック → 「録画」を押す',
  '操作重現問題，同時用語音描述你看到的 Bug': '問題を再現しながら、見えている Bug を音声で説明',
  '按「停止」→ 自動打開報告編輯頁': '「停止」を押す → レポート編集ページが自動で開く',
  '🎉 恭喜，你的第一份 Bug 報告完成了！可以編輯文字、AI 校正精簡後上傳。': 'おめでとうございます、初めての Bug レポートが完成！テキストの編集、AI 校正・要約をしてアップロードできます。',
  '連接 AI（MCP 設定）': 'AI に接続（MCP 設定）',
  '讓 AI 直接讀你的 Bug 報告，不用複製貼上。': 'AI に直接 Bug レポートを読ませ、コピー＆ペースト不要。',
  '支援 Claude Desktop · Claude Code · Cursor · Windsurf · VS Code + Cline · Google Antigravity · Gemini CLI 等所有 MCP 工具。': 'Claude Desktop · Claude Code · Cursor · Windsurf · VS Code + Cline · Google Antigravity · Gemini CLI などすべての MCP ツールに対応。',
  '🔌 BugEzy MCP 網址（所有工具通用）': 'BugEzy MCP URL（すべてのツール共通）',
  '登入 BugEzy 後，本頁的網址與設定會自動幫你補上 ?token=（AI 就不用每次手動帶 token）。': 'BugEzy にログインすると、このページの URL と設定に自動で ?token= が付与されます（AI が毎回手動でトークンを渡す必要がなくなります）。',
  '⚠ 這個網址<b>不能用瀏覽器開</b>，它是給 AI 工具連接的協議。用瀏覽器開只會看到錯誤訊息，屬正常現象——請依下方步驟在 AI 工具裡設定。': 'この URL は<b>ブラウザでは開けません</b>。AI ツールが接続するためのプロトコルです。ブラウザで開くとエラーが表示されますが正常です——以下の手順で AI ツール内に設定してください。',
  'Settings → Connectors → Add → 貼上網址 → 連接': 'Settings → Connectors → Add → URL を貼る → 接続',
  '編輯設定檔（claude_desktop_config.json / mcp.json），加入：': '設定ファイル（claude_desktop_config.json / mcp.json）を編集して追加：',
  'Cline → MCP Servers → Add → 貼上網址': 'Cline → MCP Servers → Add → URL を貼る',
  'Claude Code（終端機）': 'Claude Code（ターミナル）',
  '在 MCP 設定加入（協定通用，格式同上）：': 'MCP 設定に追加（プロトコル共通、形式は上と同じ）：',
  '連接成功後直接問：': '接続後、そのまま質問：',
  '「讀我最新的 BugEzy 報告，告訴我怎麼修」': '「最新の BugEzy レポートを読んで、修正方法を教えて」',
  '13 個 MCP 工具（AI 按需查詢，省 Token）：': '13 個の MCP ツール（AI が必要に応じて照会、トークン節約）：',
  '最近報告清單': '最近のレポート一覧',
  '報告摘要': 'レポート概要',
  '完整時序麵包屑': '完全なタイムライン',
  'Console 錯誤': 'Console エラー',
  '網路錯誤': 'ネットワークエラー',
  '語音全文': '音声全文',
  '截圖': 'スクリーンショット',
  'DOM 軌跡摘要': 'DOM 履歴の概要',
  'DOM 事件細節': 'DOM イベントの詳細',
  '即時監控錯誤': 'リアルタイム監視のエラー',
  'CLI 終端機日誌': 'CLI ターミナルログ',
  'Token 用量統計': 'トークン使用量の統計',
  '🐍 後端開發者？試試 Terminal CLI': 'バックエンド開発者？Terminal CLI を試そう',
  '捕捉 Python / Node.js / Go 的終端機錯誤（stderr / traceback / crash），AI 直接讀取分析——不需開瀏覽器。付費功能。': 'Python / Node.js / Go のターミナルエラー（stderr / traceback / crash）を捕捉し、AI が直接読み取って分析——ブラウザ不要。有料機能。',
  '你的 token': 'あなたのトークン',
  'AI 之後用 <code style="background:#2a2a3e;padding:1px 5px;border-radius:4px;color:#7ee0c5;">get_terminal_logs</code> MCP 工具讀取這些錯誤。': 'AI は後で <code style="background:#2a2a3e;padding:1px 5px;border-radius:4px;color:#7ee0c5;">get_terminal_logs</code> MCP ツールでこれらのエラーを読み取ります。',
  '來看看有哪些功能 →': '機能を見る →',
};

// PM-234：韓語頁面翻譯表（繁體 zh 原文 → 韓文）。makeT('ko') 以 t() 第一參數查表，未收錄 fallback 英文。
// 涵蓋 homePage + featuresPage 全部可見字串。합니다체；技術術語保留英文。
const KO_MAP: Record<string, string> = {
  // ── 共用 / SEO ──
  'BugEzy — 開發者 Bug 報告工具，AI 幫你修': 'BugEzy — 개발자용 Bug 리포트 도구, AI가 수정',
  '亞洲最平價的 MCP 語音除錯工具。錄製 Bug、AI 自動分析、一鍵報告。支援 Claude、Cursor、Windsurf 等 7 大 AI 工具。月費 NT$80 起。':
    '아시아 최저가 MCP 음성 디버깅 도구. Bug를 녹화하고 AI가 자동 분석, 원클릭 리포트. Claude, Cursor, Windsurf 등 7대 AI 도구 지원. 월 NT$80부터.',
  '語音除錯': '음성 디버깅',
  // ── 首頁 Hero ──
  '遇到 Bug，說不清楚？': 'Bug를 제대로 설명하기 어렵나요?',
  '按一下錄製，用說的就好。BugEzy 自動收集畫面、操作、錯誤訊息，讓 AI 幫你修。':
    '원클릭으로 녹화하고 말하기만 하면 됩니다. BugEzy가 화면·조작·오류 메시지를 자동으로 수집하여 AI가 수정합니다.',
  '🔧 免費安裝 Chrome 擴充功能': 'Chrome 확장 프로그램 무료 설치',
  '免費版每月 10 次錄製 · 不需信用卡': '무료 버전은 매월 녹화 10회 · 신용카드 불필요',
  // ── 三步驟 ──
  '簡單三步，不用教': '간단한 3단계, 설명 불필요',
  '按下錄製': '녹화 시작',
  '打開 BugEzy，按一下就開始。邊操作邊說出你遇到的問題。':
    'BugEzy를 열고 원클릭으로 시작. 조작하면서 겪은 문제를 말하세요.',
  '自動整理': '자동 정리',
  'BugEzy 自動收集畫面錄影、錯誤訊息、操作軌跡，整理成一份報告。':
    'BugEzy가 화면 녹화·오류 메시지·조작 기록을 자동으로 수집하여 하나의 리포트로 정리합니다.',
  'AI 幫你修': 'AI가 수정',
  '把報告交給 AI，它直接告訴你哪裡壞了、怎麼修。':
    '리포트를 AI에 넘기면 어디가 잘못됐는지, 어떻게 고치는지 바로 알려줍니다.',
  // ── 截圖展示 ──
  '眼見為憑': '직접 확인해 보세요',
  '錄製中': '녹화 중',
  '錄製超簡單': '녹화는 아주 간단',
  '打開瀏覽器，按下錄製，邊操作邊用嘴巴講。你的聲音會即時變成文字。':
    '브라우저를 열고 녹화를 시작한 뒤 조작하면서 말하기만 하세요. 목소리가 실시간으로 텍스트가 됩니다.',
  '報告': '리포트',
  '報告自動整理': '리포트 자동 정리',
  '錄完後，BugEzy 自動產出完整報告 — 畫面回放、語音記錄、操作軌跡，全部幫你整理好。':
    '녹화 후 BugEzy가 완전한 리포트를 자동 생성 — 화면 리플레이, 음성 기록, 조작 기록을 모두 정리합니다.',
  'AI 校正與 Token': 'AI 교정과 토큰',
  'AI 校正 + 省 93% 費用': 'AI 교정 + 비용 93% 절감',
  'AI 自動校正語音辨識的錯字，還幫你精簡重點。比起直接丟截圖給 AI，省下 93% 的費用。':
    'AI가 음성 인식의 오타를 자동 교정하고 요점도 요약합니다. 스크린샷을 직접 AI에 보내는 것보다 비용을 93% 절감합니다.',
  'AI 修復': 'AI 수정',
  'AI 直接幫你修 Bug': 'AI가 Bug를 직접 수정',
  '把報告交給 AI，一句「幫我找出問題」，AI 就自動分析、找出根因、給你修復程式碼。不用再截圖、複製貼上、來回解釋。':
    '리포트를 AI에 넘기고 "문제를 찾아줘" 한마디면 AI가 자동으로 분석하고 근본 원인을 찾아 수정 코드를 제시합니다. 더 이상 스크린샷·복붙·반복 설명이 필요 없습니다.',
  // ── 賣點 ──
  '為什麼選 BugEzy': '왜 BugEzy인가',
  '用說的就好 — 支援中文、粵語、英文': '말하기만 하면 됩니다 — 중국어·광둥어·영어 지원',
  '一鍵錄製 — 畫面 + 聲音 + 操作同步捕捉': '원클릭 녹화 — 화면 + 음성 + 조작 동시 캡처',
  'AI 自動分析 — 13 種 MCP 工具': 'AI 자동 분석 — 13종 MCP 도구',
  '省 93% 費用 — 比截圖丟 AI 便宜': '비용 93% 절감 — 스크린샷을 보내는 것보다 저렴',
  '隱私保護 — 敏感資料自動打碼': '개인정보 보호 — 민감 데이터 자동 마스킹',
  '免費開始 — 月費只要 NT$80': '무료로 시작 — 월 NT$80',
  '錄一次，所有 AI 讀 — 多工具同步連線': '한 번 녹화하면 모든 AI가 읽음 — 멀티 도구 동기화',
  '查看完整功能 →': '전체 기능 보기 →',
  // ── 語言區 ──
  '用你的母語說': '모국어로 말하세요',
  '支援七種語言語音輸入': '7개 언어 음성 입력 지원',
  '簡體中文': '중국어 간체',
  '語言選擇': '언어 선택',
  '繁體中文': '번체 중국어',
  '粵語': '광둥어',
  // ── CTA / Footer ──
  '還在用截圖跟 AI 解釋 Bug？試試用說的。': '아직도 스크린샷으로 AI에 Bug를 설명하나요? 말하기만 해보세요.',
  '免費安裝': '무료 설치',
  '使用指南': '사용 가이드',
  '隱私政策': '개인정보 처리방침',
  '聯絡我們': '문의하기',
  '安裝指南': '설치 가이드',
  '功能說明': '기능 소개',
  '常見問題': '자주 묻는 질문',
  '更新日誌': '업데이트 로그',
  '🤖 AI 客服手冊': 'AI 지원 매뉴얼',
  '📬 問題回報': '피드백',
  '我的報告': '내 리포트',
  '亞洲平價 MCP 語音除錯工具': '아시아의 합리적인 MCP 음성 디버깅 도구',
  // ── featuresPage ──
  'BugEzy 功能 — 六種錄製模式、Whisper 語音、即時監控': 'BugEzy 기능 — 6종 녹화 모드, Whisper 음성, 실시간 모니터링',
  'BugEzy 六種除錯模式：錄製、回溯 30 秒、截圖標注、即時監控、終端機 CLI、MCP AI 讀取。Whisper 精準語音轉錄。':
    'BugEzy의 6종 디버깅 모드: 녹화, 30초 되감기, 스크린샷 주석, 실시간 모니터링, Terminal CLI, MCP AI 읽기. Whisper 고정밀 음성 변환.',
  'BugEzy 完整功能介紹': 'BugEzy 전체 기능 소개',
  '給進階開發者、AI 助手、技術評估者的完整產品規格': '고급 개발자·AI 어시스턴트·기술 평가자를 위한 완전한 제품 사양',
  '六種錄製模式': '6종 녹화 모드',
  '錄製': '녹화',
  'DOM 軌跡 + Console + Network + 語音': 'DOM 기록 + Console + Network + 음성',
  '回溯 30 秒': '30초 되감기',
  'Bug 已發生？一鍵抓回最近 30 秒': 'Bug가 발생한 후? 원클릭으로 최근 30초 캡처',
  '截圖標注': '스크린샷 주석',
  '全頁/區域/自由 + 馬賽克筆刷': '전체 페이지/영역/자유형 + 모자이크 브러시',
  '鍵盤模式': '키보드 모드',
  '吵雜環境純文字，不錄語音': '시끄러운 환경에서 텍스트만, 음성 없음',
  '即時監控': '실시간 모니터링',
  '背景持續監控，有錯自動通知': '백그라운드에서 상시 모니터링, 오류 시 자동 알림',
  'Python/Node 後端錯誤攔截': 'Python/Node 백엔드 오류 캡처',
  'Bug 捕捉能力（10/10）': 'Bug 캡처 능력 (10/10)',
  '資源載入失敗 — img / script / css / 字型 404': '리소스 로드 실패 — img / script / css / 폰트 404',
  'Web Vitals — CLS / FID / LCP 超標警告': 'Web Vitals — CLS / FID / LCP 임계값 초과 경고',
  'DOM 軌跡 — rrweb 錄製 + 回放': 'DOM 기록 — rrweb 녹화 + 리플레이',
  'Storage 快照 — localStorage / sessionStorage / Cookie（PII 自動遮罩）':
    'Storage 스냅샷 — localStorage / sessionStorage / Cookie (PII 자동 마스킹)',
  '語音記錄 — 即時字幕 + Whisper 精準轉錄': '음성 기록 — 실시간 자막 + Whisper 고정밀 변환',
  '截圖 — 敏感欄位自動馬賽克': '스크린샷 — 민감 필드 자동 모자이크',
  'MCP 整合（13 Tools）': 'MCP 통합 (13 Tools)',
  '報告概覽 + AI Bug 導航摘要': '리포트 개요 + AI Bug 내비게이터',
  '完整時間軸（Console/Network/語音/環境一次看完）': '완전한 타임라인 (Console/Network/음성/환경을 한 번에 확인)',
  'Console error/warn 記錄': 'Console error/warn 기록',
  'Network 4xx/5xx 失敗': 'Network 4xx/5xx 실패',
  '語音轉錄文字': '음성 변환 텍스트',
  '截圖（高 Token）': '스크린샷 (높은 Token)',
  'DOM 摘要（輕量）': 'DOM 요약 (경량)',
  'DOM 錄影事件（高 Token）': 'DOM 리플레이 이벤트 (높은 Token)',
  '頁面資訊': '페이지 정보',
  '報告 metadata': '리포트 metadata',
  '列出報告（需 session_token）': '리포트 목록 (session_token 필요)',
  '即時監控錯誤（需 session_token）': '실시간 모니터링 오류 (session_token 필요)',
  'Terminal CLI 錯誤（付費）': 'Terminal CLI 오류 (유료)',
  'MCP 連接：': 'MCP 엔드포인트: ',
  '語音引擎': '음성 엔진',
  '即時字幕：': '실시간 자막: ',
  'Web Speech API（免費版）': 'Web Speech API (무료 버전)',
  '精準轉錄：': '고정밀 변환: ',
  'Groq Whisper（付費版）': 'Groq Whisper (유료 버전)',
  'AI 校正 + 精簡：': 'AI 교정 + 요약: ',
  '自動修錯字、濃縮重點': '오타를 자동 수정하고 요점을 압축',
  '支援語言：': '지원 언어: ',
  '安裝：': '설치: ',
  '結構化解析：': '구조화 파싱: ',
  'Python traceback + Node.js 錯誤 → type / message / file / line':
    'Python traceback + Node.js 오류 → type / message / file / line',
  '環境快照：': '환경 스냅샷: ',
  '語言 / 版本 / OS / 套件': '언어 / 버전 / OS / 패키지',
  'PII 遮罩：': 'PII 마스킹: ',
  'DB URI / API Key / JWT / 密碼 自動遮罩': 'DB URI / API Key / JWT / 비밀번호 자동 마스킹',
  '安全與隱私': '보안과 개인정보',
  'Fable5 四輪稽核 9.5+/10': 'Fable5 4라운드 감사 9.5+/10',
  'Supabase RLS 全表啟用': 'Supabase RLS 전체 테이블 활성화',
  'CSP + frame-ancestors 防點擊劫持': 'CSP + frame-ancestors (클릭재킹 방지)',
  'PII 自動遮罩 — JWT / Bearer / 手機 / 身分證 / 信用卡': 'PII 자동 마스킹 — JWT / Bearer / 휴대폰 / 신분증 / 신용카드',
  'Session token 走 URL fragment，不經 query string': 'Session token은 URL fragment 경유, query string 미사용',
  'MCP 工作流 — 錄一次，所有 AI 都能讀': 'MCP 워크플로 — 한 번 녹화하면 모든 AI가 읽음',
  '一個 AI 搞定': '단일 에이전트',
  '用 Claude Desktop、Cursor 或 Windsurf，連上 BugEzy MCP，直接讀報告修 Bug。一個 AI 從頭做到尾。':
    'Claude Desktop, Cursor 또는 Windsurf를 BugEzy MCP에 연결하여 리포트를 읽고 Bug를 수정. 하나의 AI로 처음부터 끝까지 완결.',
  '兩個 AI 分工': '두 AI 분담',
  'Claude Chat 讀報告做分析和策略規劃，Claude Code 讀同一份報告寫修復程式碼。PM 和工程師各司其職，讀的是同一份 Bug 報告。':
    'Claude Chat가 리포트를 읽고 분석과 계획을 담당하고, Claude Code가 같은 리포트를 읽고 수정 코드를 작성. PM과 엔지니어의 역할 분담, 읽는 것은 동일한 Bug 리포트.',
  '多工具同步': '멀티 도구 동기화',
  'Zed、Cursor、Claude Desktop 同時連線 BugEzy MCP，都讀同一份報告。團隊成員用不同工具，看到的是同一份 Bug 資料。':
    'Zed, Cursor, Claude Desktop이 동시에 BugEzy MCP에 연결하여 같은 리포트를 읽음. 팀원이 다른 도구를 써도 보는 것은 동일한 Bug 데이터.',
  '一行連線，任何 MCP 工具都能用': '한 줄로 연결, 모든 MCP 클라이언트에서 사용 가능',
  '支援 Claude Desktop · Claude Code · Cursor · Windsurf · Zed · 任何 MCP 相容工具':
    'Claude Desktop · Claude Code · Cursor · Windsurf · Zed · 모든 MCP 호환 클라이언트 지원',
  '定價': '요금',
  '免費': '무료',
  '每月 10 錄製 / 5 回溯 / 20 MCP': '매월 녹화 10 / 되감기 5 / MCP 20',
  '月費': '월정액',
  ' /月': ' /월',
  '全功能無限': '전체 기능 무제한',
  '日票': '데이 패스',
  '24 小時無限': '24시간 무제한',
  '準備好了？': '준비되셨나요?',
  '回首頁': '홈으로',
  '首頁': '홈',
  '聯絡': '문의하기',
  '📝 部落格': '블로그',
  '常見問題 · BugEzy': '자주 묻는 질문 · BugEzy',
  'BugEzy 常見問題：安裝、錄製、語音辨識、MCP 設定、付費方案等問答。': 'BugEzy 자주 묻는 질문: 설치, 녹화, 음성 인식, MCP 설정, 요금제 등.',
  'BugEzy 常見問題': 'BugEzy 자주 묻는 질문',
  '關於產品': '제품 관련',
  '關於隱私與安全': '개인정보와 보안',
  '關於方案與付費': '요금제와 결제',
  '關於技術': '기술 관련',
  'BugEzy 是什麼？': 'BugEzy란?',
  'BugEzy 是一款 Chrome 擴充功能，讓開發者用語音 + 錄製的方式記錄 Bug，AI 透過 MCP 自動讀取報告並提供修復建議。省下 95% 的 debug 溝通時間。': 'BugEzy는 Chrome 확장 프로그램으로, 개발자가 음성 + 녹화로 Bug를 기록하면 AI가 MCP를 통해 리포트를 자동으로 읽고 수정 방안을 제시합니다. 디버깅 소통 시간을 95% 절약합니다.',
  'BugEzy 最大的優勢是什麼？': 'BugEzy의 가장 큰 장점은?',
  '專為亞洲開發者設計：中文/粵語/日韓語音支援、NT$80 超平價月費、MCP 整合讓 AI 直接讀報告。獨家功能：即時監控、30 秒回溯、Whisper 精準語音、終端機 CLI、Token 透明度。': '아시아 개발자를 위한 설계: 중국어/광둥어/일본어·한국어 음성 지원, 월 NT$80 초저가, MCP 통합으로 AI가 직접 리포트를 읽음. 독점 기능: 실시간 모니터링, 30초 되감기, Whisper 고정밀 음성, Terminal CLI, 토큰 투명성.',
  '支援哪些 AI 工具？': '어떤 AI 도구를 지원하나요?',
  '任何支援 MCP 的 AI 工具都能用，包括 Claude Desktop、Claude Code、Cursor、VS Code + Copilot、Zed、Windsurf、Codex、Replit 等。只需要一行 URL：https://bugezy.dev/mcp': 'MCP를 지원하는 모든 AI 도구에서 사용 가능. Claude Desktop, Claude Code, Cursor, VS Code + Copilot, Zed, Windsurf, Codex, Replit 등. 단 한 줄의 URL만 필요: https://bugezy.dev/mcp',
  '任何支援 MCP 的 AI 工具都能用，包括 Claude Desktop、Claude Code、Cursor、VS Code + Copilot、Zed、Windsurf、Codex、Replit 等。只需要一行 URL：': 'MCP를 지원하는 모든 AI 도구에서 사용 가능. Claude Desktop, Claude Code, Cursor, VS Code + Copilot, Zed, Windsurf, Codex, Replit 등. 단 한 줄의 URL만 필요:',
  'BugEzy 會錄到我的密碼嗎？': 'BugEzy가 내 비밀번호를 녹화하나요?',
  'BugEzy 錄製的是 DOM 結構變化，不是螢幕截圖。密碼輸入框（type="password"）的內容會被 rrweb 自動遮蔽，不會錄到實際密碼。': 'BugEzy가 녹화하는 것은 DOM 구조 변화이며 화면 캡처가 아닙니다. 비밀번호 입력란(type="password")의 내용은 rrweb가 자동으로 가리며, 실제 비밀번호는 녹화되지 않습니다.',
  '我的報告誰能看到？': '내 리포트는 누가 볼 수 있나요?',
  '報告連結採用隨機加密 ID（UUID），無法被猜測或搜尋，只有擁有連結的人才能查看報告內容。若你將連結分享給同事或 AI 工具，他們就能查看；未分享的報告連結不會出現在任何公開列表中。建議不要把報告連結貼在公開場合（如公開 issue、論壇），避免非預期的存取。': '리포트 링크는 무작위 암호 ID(UUID)를 사용해 추측하거나 검색할 수 없으며, 링크를 가진 사람만 리포트를 볼 수 있습니다. 동료나 AI 도구에 링크를 공유하면 그들도 볼 수 있지만, 공유하지 않은 링크는 어떤 공개 목록에도 나타나지 않습니다. 의도치 않은 접근을 막기 위해 공개된 곳(공개 issue, 포럼 등)에 링크를 붙이지 않기를 권장합니다.',
  '資料存在哪裡？': '데이터는 어디에 저장되나요?',
  '報告存在 Cloudflare R2（全球 CDN），使用者資料存在 Supabase（PostgreSQL）。所有傳輸都經過 HTTPS 加密。': '리포트는 Cloudflare R2(글로벌 CDN)에, 사용자 데이터는 Supabase(PostgreSQL)에 저장됩니다. 모든 전송은 HTTPS로 암호화됩니다.',
  '免費版有什麼限制？': '무료 버전의 제한은?',
  '免費版每月可錄製 10 次、回溯 5 次、MCP AI 讀取 20 次。截圖標注和即時監控無限使用。報告保留 7 天。': '무료 버전은 매월 녹화 10회, 되감기 5회, MCP AI 읽기 20회까지. 스크린샷 주석과 실시간 모니터링은 무제한. 리포트는 7일간 보관.',
  '付費版多少錢？': '유료 버전은 얼마인가요?',
  'NT$80/月（約 $3 USD），解鎖全功能無限次使用，報告保留 90 天，加上終端機 CLI、Whisper 精準語音等進階功能。': '월 NT$80(약 $3 USD)로 모든 기능을 무제한 사용, 리포트 90일 보관, Terminal CLI·Whisper 고정밀 음성 등 고급 기능 추가.',
  '如何升級付費版？': '유료 버전으로 어떻게 업그레이드하나요?',
  '在 BugEzy popup 點「升級」按鈕，透過信用卡或 ATM 付款。': 'BugEzy 팝업에서 "업그레이드" 버튼을 눌러 신용카드 또는 ATM으로 결제합니다.',
  '可以取消訂閱嗎？': '구독을 취소할 수 있나요?',
  '可以，隨時取消。取消後當月剩餘天數仍可使用付費功能，下個月恢復為免費版。': '네, 언제든 취소할 수 있습니다. 취소 후에도 당월 남은 기간은 유료 기능을 사용할 수 있고, 다음 달부터 무료 버전으로 돌아갑니다.',
  '哪些瀏覽器支援？': '어떤 브라우저를 지원하나요?',
  '目前支援 Chrome 和所有 Chromium 瀏覽器（Edge、Brave、Arc 等）。': '현재 Chrome 및 모든 Chromium 브라우저(Edge, Brave, Arc 등)를 지원합니다.',
  '會影響網頁效能嗎？': '웹 페이지 성능에 영향을 주나요?',
  '影響極小。BugEzy 只在你主動錄製時才記錄 DOM 變化，即時監控模式只攔截 Console error 和 Network error，不錄 DOM。': '영향은 매우 적습니다. BugEzy는 사용자가 직접 녹화할 때만 DOM 변화를 기록하며, 실시간 모니터링 모드에서는 Console error와 Network error만 잡고 DOM은 녹화하지 않습니다.',
  'MCP 是什麼？': 'MCP란?',
  'Model Context Protocol（模型上下文協議），是 Anthropic 推出的開放標準，讓 AI 工具可以連接外部服務。BugEzy 的 MCP 讓 AI 直接讀取你的 Bug 報告，不需要複製貼上。': 'Model Context Protocol(모델 컨텍스트 프로토콜)은 Anthropic이 공개한 개방형 표준으로, AI 도구가 외부 서비스에 연결할 수 있게 합니다. BugEzy의 MCP는 AI가 복사·붙여넣기 없이 직접 당신의 Bug 리포트를 읽게 합니다.',
  'Token 是什麼？為什麼 BugEzy 能省 Token？': 'Token이란? BugEzy는 왜 Token을 절약하나요?',
  'Token 是 AI 處理文字的計量單位，等於你的 AI 使用費用。BugEzy 用結構化文字（而非截圖）傳送報告給 AI，同樣的 Bug 資訊只需要 1/20 的 Token。每次 MCP AI 讀取都會顯示 Token 估算，讓你看到省了多少。': 'Token은 AI가 텍스트를 처리하는 단위로, AI 사용 비용에 해당합니다. BugEzy는 스크린샷이 아닌 구조화된 텍스트로 리포트를 AI에 보내므로 같은 Bug 정보라도 1/20의 Token만 필요합니다. MCP AI 읽기마다 Token 추정치가 표시되어 얼마나 절약했는지 볼 수 있습니다.',
  '安裝 BugEzy — 3 分鐘搞定 Chrome 擴充 + MCP 設定': 'BugEzy 설치 — 3분이면 Chrome 확장 + MCP 설정 완료',
  '安裝 BugEzy Chrome 擴充功能，設定 MCP 連線，讓 AI 直接讀取你的 Bug 報告。支援 Claude、Cursor、Windsurf、Google Antigravity、Gemini CLI。': 'BugEzy Chrome 확장 프로그램을 설치하고 MCP 연결을 설정해 AI가 직접 Bug 리포트를 읽게 하세요. Claude, Cursor, Windsurf, Google Antigravity, Gemini CLI 지원.',
  '🚀 安裝 BugEzy — 三分鐘搞定': 'BugEzy 설치 — 3분 완료',
  '從零到能用，跟著五步走，馬上讓 AI 幫你修 Bug。': '처음부터 사용까지, 5단계만 따라 하면 바로 AI가 Bug를 고쳐줍니다.',
  '🤖 最快的安裝方式：複製貼給 AI': '가장 빠른 설치 방법: 복사해서 AI에 붙여넣기',
  '不懂技術？把下面這段複製貼給你的 AI（Claude Desktop / Claude Code / Cursor / Windsurf / VS Code + Cline / Google Antigravity / Gemini CLI），它會幫你搞定。': '기술을 모르시나요? 아래 내용을 복사해 AI(Claude Desktop / Claude Code / Cursor / Windsurf / VS Code + Cline / Google Antigravity / Gemini CLI)에 붙여넣으면 알아서 처리해 줍니다.',
  '已複製！': '복사됨!',
  '一鍵複製，貼給你的 AI': '한 번에 복사해 AI에 붙여넣기',
  '或依下方手動五步安裝 ↓': '또는 아래 수동 5단계로 설치',
  '安裝擴充功能': '확장 프로그램 설치',
  '前往 Chrome Web Store 的 BugEzy 頁面': 'Chrome 웹 스토어의 BugEzy 페이지로 이동',
  '點「加到 Chrome」→ 在彈窗按「新增擴充功能」確認': '"Chrome에 추가" → 팝업에서 "확장 프로그램 추가" 눌러 확인',
  '前往 Chrome Web Store →': 'Chrome 웹 스토어로 →',
  '支援 Chrome 以及所有 Chromium 核心瀏覽器（Edge、Brave、Arc 等）。': 'Chrome 및 모든 Chromium 기반 브라우저(Edge, Brave, Arc 등) 지원.',
  '固定到工具列': '툴바에 고정',
  '點瀏覽器右上角的拼圖圖示 🧩（擴充功能選單）': '브라우저 오른쪽 위 퍼즐 아이콘(확장 프로그램 메뉴) 클릭',
  '找到 BugEzy 🐛 → 按旁邊的釘選 📌': 'BugEzy 를 찾아 → 옆의 고정 누르기',
  '釘選後圖示會常駐在工具列，隨時一鍵開錄，不用每次翻選單。': '고정하면 아이콘이 툴바에 상주해 언제든 한 번에 녹화 시작, 매번 메뉴를 열 필요가 없습니다.',
  '登入': '로그인',
  '點工具列上的 BugEzy 圖示': '툴바의 BugEzy 아이콘 클릭',
  '按「用 Google 登入」→ 選擇帳號授權': '"Google로 로그인" → 계정 선택 후 승인',
  'popup 顯示你的名字 = 登入成功': '팝업에 이름이 표시되면 로그인 성공',
  '第一次錄製': '첫 녹화',
  '開任意網頁 → 點 BugEzy 圖示 → 按「錄製」': '아무 웹페이지 열기 → BugEzy 아이콘 클릭 → "녹화" 누르기',
  '操作重現問題，同時用語音描述你看到的 Bug': '문제를 재현하면서 보이는 Bug를 음성으로 설명',
  '按「停止」→ 自動打開報告編輯頁': '"중지" 누르기 → 리포트 편집 페이지가 자동으로 열림',
  '🎉 恭喜，你的第一份 Bug 報告完成了！可以編輯文字、AI 校正精簡後上傳。': '축하합니다, 첫 Bug 리포트가 완성되었습니다! 텍스트 편집, AI 교정·요약 후 업로드할 수 있습니다.',
  '連接 AI（MCP 設定）': 'AI 연결(MCP 설정)',
  '讓 AI 直接讀你的 Bug 報告，不用複製貼上。': 'AI가 직접 Bug 리포트를 읽게 해 복사·붙여넣기가 필요 없습니다.',
  '支援 Claude Desktop · Claude Code · Cursor · Windsurf · VS Code + Cline · Google Antigravity · Gemini CLI 等所有 MCP 工具。': 'Claude Desktop · Claude Code · Cursor · Windsurf · VS Code + Cline · Google Antigravity · Gemini CLI 등 모든 MCP 도구 지원.',
  '🔌 BugEzy MCP 網址（所有工具通用）': 'BugEzy MCP 주소(모든 도구 공용)',
  '登入 BugEzy 後，本頁的網址與設定會自動幫你補上 ?token=（AI 就不用每次手動帶 token）。': 'BugEzy에 로그인하면 이 페이지의 주소와 설정에 ?token=이 자동으로 붙습니다(AI가 매번 수동으로 token을 넣을 필요가 없습니다).',
  '⚠ 這個網址<b>不能用瀏覽器開</b>，它是給 AI 工具連接的協議。用瀏覽器開只會看到錯誤訊息，屬正常現象——請依下方步驟在 AI 工具裡設定。': '이 주소는 <b>브라우저로 열 수 없습니다</b>. AI 도구가 연결하는 프로토콜입니다. 브라우저로 열면 오류 메시지만 보이는 것이 정상이며——아래 단계에 따라 AI 도구에서 설정하세요.',
  'Settings → Connectors → Add → 貼上網址 → 連接': 'Settings → Connectors → Add → 주소 붙여넣기 → 연결',
  '編輯設定檔（claude_desktop_config.json / mcp.json），加入：': '설정 파일(claude_desktop_config.json / mcp.json)을 편집해 추가:',
  'Cline → MCP Servers → Add → 貼上網址': 'Cline → MCP Servers → Add → 주소 붙여넣기',
  'Claude Code（終端機）': 'Claude Code(터미널)',
  '在 MCP 設定加入（協定通用，格式同上）：': 'MCP 설정에 추가(프로토콜 공용, 형식은 위와 동일):',
  '連接成功後直接問：': '연결 후 바로 질문:',
  '「讀我最新的 BugEzy 報告，告訴我怎麼修」': '"최신 BugEzy 리포트를 읽고 어떻게 고칠지 알려줘"',
  '13 個 MCP 工具（AI 按需查詢，省 Token）：': '13개 MCP 도구(AI가 필요할 때 조회, Token 절약):',
  '最近報告清單': '최근 리포트 목록',
  '報告摘要': '리포트 요약',
  '完整時序麵包屑': '전체 타임라인',
  'Console 錯誤': 'Console 오류',
  '網路錯誤': '네트워크 오류',
  '語音全文': '음성 전문',
  '截圖': '스크린샷',
  'DOM 軌跡摘要': 'DOM 기록 요약',
  'DOM 事件細節': 'DOM 이벤트 상세',
  '即時監控錯誤': '실시간 모니터링 오류',
  'CLI 終端機日誌': 'CLI 터미널 로그',
  'Token 用量統計': 'Token 사용량 통계',
  '🐍 後端開發者？試試 Terminal CLI': '백엔드 개발자? Terminal CLI를 써보세요',
  '捕捉 Python / Node.js / Go 的終端機錯誤（stderr / traceback / crash），AI 直接讀取分析——不需開瀏覽器。付費功能。': 'Python / Node.js / Go의 터미널 오류(stderr / traceback / crash)를 잡아 AI가 직접 읽고 분석——브라우저 필요 없음. 유료 기능.',
  '你的 token': '당신의 token',
  'AI 之後用 <code style="background:#2a2a3e;padding:1px 5px;border-radius:4px;color:#7ee0c5;">get_terminal_logs</code> MCP 工具讀取這些錯誤。': 'AI는 이후 <code style="background:#2a2a3e;padding:1px 5px;border-radius:4px;color:#7ee0c5;">get_terminal_logs</code> MCP 도구로 이 오류들을 읽습니다.',
  '來看看有哪些功能 →': '어떤 기능이 있는지 보기 →',
};

// PM-235：越南語頁面翻譯表（繁體 zh 原文 → 越南文）。makeT('vi') 以 t() 第一參數查表，未收錄 fallback 英文。
// 涵蓋 homePage + featuresPage 全部可見字串。技術術語保留英文；越南語含聲調符號，UTF-8。
const VI_MAP: Record<string, string> = {
  // ── 共用 / SEO ──
  'BugEzy — 開發者 Bug 報告工具，AI 幫你修': 'BugEzy — Công cụ báo lỗi Bug cho lập trình viên, AI sửa giúp bạn',
  '亞洲最平價的 MCP 語音除錯工具。錄製 Bug、AI 自動分析、一鍵報告。支援 Claude、Cursor、Windsurf 等 7 大 AI 工具。月費 NT$80 起。':
    'Công cụ gỡ lỗi bằng giọng nói MCP rẻ nhất châu Á. Ghi lại Bug, AI tự động phân tích, báo cáo một chạm. Hỗ trợ Claude, Cursor, Windsurf và 7 công cụ AI lớn. Từ NT$80/tháng.',
  '語音除錯': 'gỡ lỗi bằng giọng nói',
  // ── 首頁 Hero ──
  '遇到 Bug，說不清楚？': 'Gặp Bug mà khó diễn tả?',
  '按一下錄製，用說的就好。BugEzy 自動收集畫面、操作、錯誤訊息，讓 AI 幫你修。':
    'Chỉ cần nhấp ghi hình và nói. BugEzy tự động thu thập màn hình, thao tác, thông báo lỗi để AI sửa giúp bạn.',
  '🔧 免費安裝 Chrome 擴充功能': 'Cài đặt tiện ích Chrome miễn phí',
  '免費版每月 10 次錄製 · 不需信用卡': 'Bản miễn phí 10 lần ghi hình mỗi tháng · Không cần thẻ tín dụng',
  // ── 三步驟 ──
  '簡單三步，不用教': 'Ba bước đơn giản, không cần hướng dẫn',
  '按下錄製': 'Nhấn ghi hình',
  '打開 BugEzy，按一下就開始。邊操作邊說出你遇到的問題。':
    'Mở BugEzy, nhấp một cái là bắt đầu. Vừa thao tác vừa nói ra vấn đề bạn gặp.',
  '自動整理': 'Tự động sắp xếp',
  'BugEzy 自動收集畫面錄影、錯誤訊息、操作軌跡，整理成一份報告。':
    'BugEzy tự động thu thập video màn hình, thông báo lỗi, dấu vết thao tác và tổng hợp thành một báo cáo.',
  'AI 幫你修': 'AI sửa giúp bạn',
  '把報告交給 AI，它直接告訴你哪裡壞了、怎麼修。':
    'Đưa báo cáo cho AI, nó sẽ nói ngay chỗ nào hỏng và cách sửa.',
  // ── 截圖展示 ──
  '眼見為憑': 'Trăm nghe không bằng một thấy',
  '錄製中': 'Đang ghi hình',
  '錄製超簡單': 'Ghi hình cực kỳ đơn giản',
  '打開瀏覽器，按下錄製，邊操作邊用嘴巴講。你的聲音會即時變成文字。':
    'Mở trình duyệt, nhấn ghi hình, vừa thao tác vừa nói. Giọng nói của bạn được chuyển thành văn bản ngay lập tức.',
  '報告': 'Báo cáo',
  '報告自動整理': 'Báo cáo tự động sắp xếp',
  '錄完後，BugEzy 自動產出完整報告 — 畫面回放、語音記錄、操作軌跡，全部幫你整理好。':
    'Sau khi ghi xong, BugEzy tự động tạo báo cáo đầy đủ — phát lại màn hình, ghi âm giọng nói, dấu vết thao tác, tất cả được sắp xếp cho bạn.',
  'AI 校正與 Token': 'AI hiệu chỉnh và Token',
  'AI 校正 + 省 93% 費用': 'AI hiệu chỉnh + tiết kiệm 93% chi phí',
  'AI 自動校正語音辨識的錯字，還幫你精簡重點。比起直接丟截圖給 AI，省下 93% 的費用。':
    'AI tự động sửa lỗi chính tả của nhận dạng giọng nói và tóm tắt các điểm chính. So với gửi ảnh chụp trực tiếp cho AI, tiết kiệm 93% chi phí.',
  'AI 修復': 'AI sửa lỗi',
  'AI 直接幫你修 Bug': 'AI sửa Bug trực tiếp cho bạn',
  '把報告交給 AI，一句「幫我找出問題」，AI 就自動分析、找出根因、給你修復程式碼。不用再截圖、複製貼上、來回解釋。':
    'Đưa báo cáo cho AI, chỉ một câu "tìm vấn đề giúp tôi", AI sẽ tự động phân tích, tìm nguyên nhân gốc và đưa mã sửa lỗi. Không còn phải chụp màn hình, sao chép dán hay giải thích qua lại.',
  // ── 賣點 ──
  '為什麼選 BugEzy': 'Tại sao chọn BugEzy',
  '用說的就好 — 支援中文、粵語、英文': 'Chỉ cần nói — hỗ trợ tiếng Trung, tiếng Quảng Đông, tiếng Anh',
  '一鍵錄製 — 畫面 + 聲音 + 操作同步捕捉': 'Ghi hình một chạm — chụp đồng thời màn hình + âm thanh + thao tác',
  'AI 自動分析 — 13 種 MCP 工具': 'AI tự động phân tích — 13 công cụ MCP',
  '省 93% 費用 — 比截圖丟 AI 便宜': 'Tiết kiệm 93% chi phí — rẻ hơn gửi ảnh chụp cho AI',
  '隱私保護 — 敏感資料自動打碼': 'Bảo vệ riêng tư — dữ liệu nhạy cảm tự động che',
  '免費開始 — 月費只要 NT$80': 'Bắt đầu miễn phí — chỉ NT$80/tháng',
  '錄一次，所有 AI 讀 — 多工具同步連線': 'Ghi một lần, mọi AI đều đọc — đồng bộ nhiều công cụ',
  '查看完整功能 →': 'Xem đầy đủ tính năng →',
  // ── 語言區 ──
  '用你的母語說': 'Nói bằng tiếng mẹ đẻ của bạn',
  '支援七種語言語音輸入': 'Hỗ trợ nhập giọng nói bằng 7 ngôn ngữ',
  '簡體中文': 'Tiếng Trung giản thể',
  '語言選擇': 'Chọn ngôn ngữ',
  '繁體中文': 'Tiếng Trung phồn thể',
  '粵語': 'Tiếng Quảng Đông',
  // ── CTA / Footer ──
  '還在用截圖跟 AI 解釋 Bug？試試用說的。': 'Vẫn dùng ảnh chụp để giải thích Bug cho AI? Hãy thử chỉ nói thôi.',
  '免費安裝': 'Cài đặt miễn phí',
  '使用指南': 'Hướng dẫn sử dụng',
  '隱私政策': 'Chính sách riêng tư',
  '聯絡我們': 'Liên hệ chúng tôi',
  '安裝指南': 'Hướng dẫn cài đặt',
  '功能說明': 'Giới thiệu tính năng',
  '常見問題': 'Câu hỏi thường gặp',
  '更新日誌': 'Nhật ký cập nhật',
  '🤖 AI 客服手冊': 'Sổ tay hỗ trợ AI',
  '📬 問題回報': 'Phản hồi',
  '我的報告': 'Báo cáo của tôi',
  '亞洲平價 MCP 語音除錯工具': 'Công cụ gỡ lỗi bằng giọng nói MCP giá hợp lý cho châu Á',
  // ── featuresPage ──
  'BugEzy 功能 — 六種錄製模式、Whisper 語音、即時監控': 'Tính năng BugEzy — 6 chế độ ghi hình, giọng nói Whisper, giám sát trực tiếp',
  'BugEzy 六種除錯模式：錄製、回溯 30 秒、截圖標注、即時監控、終端機 CLI、MCP AI 讀取。Whisper 精準語音轉錄。':
    '6 chế độ gỡ lỗi của BugEzy: Ghi hình, tua lại 30 giây, chú thích ảnh chụp, giám sát trực tiếp, Terminal CLI, MCP AI đọc. Chuyển đổi giọng nói chính xác bằng Whisper.',
  'BugEzy 完整功能介紹': 'Giới thiệu đầy đủ tính năng BugEzy',
  '給進階開發者、AI 助手、技術評估者的完整產品規格': 'Thông số sản phẩm đầy đủ cho lập trình viên nâng cao, trợ lý AI và người đánh giá kỹ thuật',
  '六種錄製模式': '6 chế độ ghi hình',
  '錄製': 'Ghi hình',
  'DOM 軌跡 + Console + Network + 語音': 'Dấu vết DOM + Console + Network + giọng nói',
  '回溯 30 秒': 'Tua lại 30 giây',
  'Bug 已發生？一鍵抓回最近 30 秒': 'Bug đã xảy ra? Một chạm bắt lại 30 giây gần nhất',
  '截圖標注': 'Chú thích ảnh chụp',
  '全頁/區域/自由 + 馬賽克筆刷': 'Toàn trang/vùng/tự do + cọ mosaic',
  '鍵盤模式': 'Chế độ bàn phím',
  '吵雜環境純文字，不錄語音': 'Chỉ văn bản trong môi trường ồn ào, không ghi giọng nói',
  '即時監控': 'Giám sát trực tiếp',
  '背景持續監控，有錯自動通知': 'Giám sát liên tục ở nền, tự động thông báo khi có lỗi',
  'Python/Node 後端錯誤攔截': 'Bắt lỗi backend Python/Node',
  'Bug 捕捉能力（10/10）': 'Khả năng bắt Bug (10/10)',
  '資源載入失敗 — img / script / css / 字型 404': 'Lỗi tải tài nguyên — img / script / css / font 404',
  'Web Vitals — CLS / FID / LCP 超標警告': 'Web Vitals — cảnh báo vượt ngưỡng CLS / FID / LCP',
  'DOM 軌跡 — rrweb 錄製 + 回放': 'Dấu vết DOM — rrweb ghi + phát lại',
  'Storage 快照 — localStorage / sessionStorage / Cookie（PII 自動遮罩）':
    'Ảnh chụp Storage — localStorage / sessionStorage / Cookie (PII tự động che)',
  '語音記錄 — 即時字幕 + Whisper 精準轉錄': 'Ghi âm — phụ đề trực tiếp + Whisper chuyển đổi chính xác',
  '截圖 — 敏感欄位自動馬賽克': 'Ảnh chụp — trường nhạy cảm tự động mosaic',
  'MCP 整合（13 Tools）': 'Tích hợp MCP (13 Tools)',
  '報告概覽 + AI Bug 導航摘要': 'Tổng quan báo cáo + điều hướng Bug bằng AI',
  '完整時間軸（Console/Network/語音/環境一次看完）': 'Dòng thời gian đầy đủ (Console/Network/giọng nói/môi trường xem một lần)',
  'Console error/warn 記錄': 'Bản ghi Console error/warn',
  'Network 4xx/5xx 失敗': 'Lỗi Network 4xx/5xx',
  '語音轉錄文字': 'Văn bản chuyển đổi giọng nói',
  '截圖（高 Token）': 'Ảnh chụp (Token cao)',
  'DOM 摘要（輕量）': 'Tóm tắt DOM (nhẹ)',
  'DOM 錄影事件（高 Token）': 'Sự kiện phát lại DOM (Token cao)',
  '頁面資訊': 'Thông tin trang',
  '報告 metadata': 'metadata báo cáo',
  '列出報告（需 session_token）': 'Liệt kê báo cáo (cần session_token)',
  '即時監控錯誤（需 session_token）': 'Lỗi giám sát trực tiếp (cần session_token)',
  'Terminal CLI 錯誤（付費）': 'Lỗi Terminal CLI (trả phí)',
  'MCP 連接：': 'Điểm cuối MCP: ',
  '語音引擎': 'Công cụ giọng nói',
  '即時字幕：': 'Phụ đề trực tiếp: ',
  'Web Speech API（免費版）': 'Web Speech API (bản miễn phí)',
  '精準轉錄：': 'Chuyển đổi chính xác: ',
  'Groq Whisper（付費版）': 'Groq Whisper (bản trả phí)',
  'AI 校正 + 精簡：': 'AI hiệu chỉnh + tóm tắt: ',
  '自動修錯字、濃縮重點': 'Tự động sửa lỗi chính tả, cô đọng điểm chính',
  '支援語言：': 'Ngôn ngữ hỗ trợ: ',
  '安裝：': 'Cài đặt: ',
  '結構化解析：': 'Phân tích có cấu trúc: ',
  'Python traceback + Node.js 錯誤 → type / message / file / line':
    'Python traceback + lỗi Node.js → type / message / file / line',
  '環境快照：': 'Ảnh chụp môi trường: ',
  '語言 / 版本 / OS / 套件': 'Ngôn ngữ / phiên bản / OS / gói',
  'PII 遮罩：': 'Che PII: ',
  'DB URI / API Key / JWT / 密碼 自動遮罩': 'DB URI / API Key / JWT / mật khẩu tự động che',
  '安全與隱私': 'Bảo mật và riêng tư',
  'Fable5 四輪稽核 9.5+/10': 'Kiểm toán 4 vòng Fable5 9.5+/10',
  'Supabase RLS 全表啟用': 'Bật Supabase RLS trên toàn bộ bảng',
  'CSP + frame-ancestors 防點擊劫持': 'CSP + frame-ancestors (chống clickjacking)',
  'PII 自動遮罩 — JWT / Bearer / 手機 / 身分證 / 信用卡': 'Tự động che PII — JWT / Bearer / số điện thoại / CMND / thẻ tín dụng',
  'Session token 走 URL fragment，不經 query string': 'Session token qua URL fragment, không dùng query string',
  'MCP 工作流 — 錄一次，所有 AI 都能讀': 'Quy trình MCP — ghi một lần, mọi AI đều đọc được',
  '一個 AI 搞定': 'Một AI duy nhất',
  '用 Claude Desktop、Cursor 或 Windsurf，連上 BugEzy MCP，直接讀報告修 Bug。一個 AI 從頭做到尾。':
    'Kết nối Claude Desktop, Cursor hoặc Windsurf với BugEzy MCP, đọc báo cáo và sửa Bug ngay. Một AI làm từ đầu đến cuối.',
  '兩個 AI 分工': 'Hai AI phân công',
  'Claude Chat 讀報告做分析和策略規劃，Claude Code 讀同一份報告寫修復程式碼。PM 和工程師各司其職，讀的是同一份 Bug 報告。':
    'Claude Chat đọc báo cáo để phân tích và lập kế hoạch, Claude Code đọc cùng báo cáo để viết mã sửa lỗi. Vai trò PM và kỹ sư, cùng đọc một báo cáo Bug.',
  '多工具同步': 'Đồng bộ nhiều công cụ',
  'Zed、Cursor、Claude Desktop 同時連線 BugEzy MCP，都讀同一份報告。團隊成員用不同工具，看到的是同一份 Bug 資料。':
    'Zed, Cursor, Claude Desktop cùng kết nối BugEzy MCP, đều đọc cùng một báo cáo. Thành viên nhóm dùng công cụ khác nhau nhưng xem cùng dữ liệu Bug.',
  '一行連線，任何 MCP 工具都能用': 'Một dòng để kết nối, dùng được với mọi client MCP',
  '支援 Claude Desktop · Claude Code · Cursor · Windsurf · Zed · 任何 MCP 相容工具':
    'Hỗ trợ Claude Desktop · Claude Code · Cursor · Windsurf · Zed · mọi client tương thích MCP',
  '定價': 'Bảng giá',
  '免費': 'Miễn phí',
  '每月 10 錄製 / 5 回溯 / 20 MCP': 'Mỗi tháng 10 ghi hình / 5 tua lại / 20 MCP',
  '月費': 'Hàng tháng',
  ' /月': ' /tháng',
  '全功能無限': 'Toàn bộ tính năng không giới hạn',
  '日票': 'Vé ngày',
  '24 小時無限': '24 giờ không giới hạn',
  '準備好了？': 'Sẵn sàng chưa?',
  '回首頁': 'Về trang chủ',
  '首頁': 'Trang chủ',
  '聯絡': 'Liên hệ',
  '📝 部落格': 'Blog',
  '常見問題 · BugEzy': 'Câu hỏi thường gặp · BugEzy',
  'BugEzy 常見問題：安裝、錄製、語音辨識、MCP 設定、付費方案等問答。': 'Câu hỏi thường gặp về BugEzy: cài đặt, ghi hình, nhận dạng giọng nói, cấu hình MCP, gói trả phí.',
  'BugEzy 常見問題': 'BugEzy Câu hỏi thường gặp',
  '關於產品': 'Về sản phẩm',
  '關於隱私與安全': 'Về quyền riêng tư và bảo mật',
  '關於方案與付費': 'Về gói và thanh toán',
  '關於技術': 'Về kỹ thuật',
  'BugEzy 是什麼？': 'BugEzy là gì?',
  'BugEzy 是一款 Chrome 擴充功能，讓開發者用語音 + 錄製的方式記錄 Bug，AI 透過 MCP 自動讀取報告並提供修復建議。省下 95% 的 debug 溝通時間。': 'BugEzy là tiện ích Chrome cho phép lập trình viên ghi lại Bug bằng giọng nói + ghi hình, AI đọc báo cáo tự động qua MCP và đưa ra gợi ý sửa lỗi. Tiết kiệm 95% thời gian trao đổi khi gỡ lỗi.',
  'BugEzy 最大的優勢是什麼？': 'Ưu điểm lớn nhất của BugEzy là gì?',
  '專為亞洲開發者設計：中文/粵語/日韓語音支援、NT$80 超平價月費、MCP 整合讓 AI 直接讀報告。獨家功能：即時監控、30 秒回溯、Whisper 精準語音、終端機 CLI、Token 透明度。': 'Thiết kế riêng cho lập trình viên châu Á: hỗ trợ giọng nói tiếng Trung/Quảng Đông/Nhật-Hàn, phí tháng siêu rẻ NT$80, tích hợp MCP để AI đọc báo cáo trực tiếp. Tính năng độc quyền: giám sát trực tiếp, tua lại 30 giây, giọng nói chính xác Whisper, Terminal CLI, minh bạch Token.',
  '支援哪些 AI 工具？': 'Hỗ trợ những công cụ AI nào?',
  '任何支援 MCP 的 AI 工具都能用，包括 Claude Desktop、Claude Code、Cursor、VS Code + Copilot、Zed、Windsurf、Codex、Replit 等。只需要一行 URL：https://bugezy.dev/mcp': 'Dùng được với mọi công cụ AI hỗ trợ MCP: Claude Desktop, Claude Code, Cursor, VS Code + Copilot, Zed, Windsurf, Codex, Replit, v.v. Chỉ cần một dòng URL: https://bugezy.dev/mcp',
  '任何支援 MCP 的 AI 工具都能用，包括 Claude Desktop、Claude Code、Cursor、VS Code + Copilot、Zed、Windsurf、Codex、Replit 等。只需要一行 URL：': 'Dùng được với mọi công cụ AI hỗ trợ MCP: Claude Desktop, Claude Code, Cursor, VS Code + Copilot, Zed, Windsurf, Codex, Replit, v.v. Chỉ cần một dòng URL:',
  'BugEzy 會錄到我的密碼嗎？': 'BugEzy có ghi lại mật khẩu của tôi không?',
  'BugEzy 錄製的是 DOM 結構變化，不是螢幕截圖。密碼輸入框（type="password"）的內容會被 rrweb 自動遮蔽，不會錄到實際密碼。': 'BugEzy ghi lại thay đổi cấu trúc DOM, không phải ảnh chụp màn hình. Nội dung ô nhập mật khẩu (type="password") được rrweb tự động che, không ghi lại mật khẩu thật.',
  '我的報告誰能看到？': 'Ai có thể xem báo cáo của tôi?',
  '報告連結採用隨機加密 ID（UUID），無法被猜測或搜尋，只有擁有連結的人才能查看報告內容。若你將連結分享給同事或 AI 工具，他們就能查看；未分享的報告連結不會出現在任何公開列表中。建議不要把報告連結貼在公開場合（如公開 issue、論壇），避免非預期的存取。': 'Liên kết báo cáo dùng ID mã hóa ngẫu nhiên (UUID), không thể đoán hay tìm kiếm, chỉ người có liên kết mới xem được nội dung. Nếu bạn chia sẻ liên kết cho đồng nghiệp hoặc công cụ AI, họ sẽ xem được; liên kết chưa chia sẻ không xuất hiện trong bất kỳ danh sách công khai nào. Khuyến nghị không dán liên kết ở nơi công khai (issue công khai, diễn đàn) để tránh truy cập ngoài ý muốn.',
  '資料存在哪裡？': 'Dữ liệu được lưu ở đâu?',
  '報告存在 Cloudflare R2（全球 CDN），使用者資料存在 Supabase（PostgreSQL）。所有傳輸都經過 HTTPS 加密。': 'Báo cáo lưu trên Cloudflare R2 (CDN toàn cầu), dữ liệu người dùng lưu trên Supabase (PostgreSQL). Mọi truyền tải đều được mã hóa HTTPS.',
  '免費版有什麼限制？': 'Bản miễn phí có giới hạn gì?',
  '免費版每月可錄製 10 次、回溯 5 次、MCP AI 讀取 20 次。截圖標注和即時監控無限使用。報告保留 7 天。': 'Bản miễn phí mỗi tháng: 10 lần ghi hình, 5 lần tua lại, 20 lần MCP AI đọc. Chú thích ảnh chụp và giám sát trực tiếp không giới hạn. Báo cáo lưu 7 ngày.',
  '付費版多少錢？': 'Bản trả phí giá bao nhiêu?',
  'NT$80/月（約 $3 USD），解鎖全功能無限次使用，報告保留 90 天，加上終端機 CLI、Whisper 精準語音等進階功能。': 'NT$80/tháng (khoảng $3 USD), mở khóa toàn bộ tính năng không giới hạn, báo cáo lưu 90 ngày, thêm Terminal CLI, giọng nói chính xác Whisper và các tính năng nâng cao.',
  '如何升級付費版？': 'Làm sao nâng cấp bản trả phí?',
  '在 BugEzy popup 點「升級」按鈕，透過信用卡或 ATM 付款。': 'Nhấn nút "Nâng cấp" trong popup BugEzy, thanh toán bằng thẻ tín dụng hoặc ATM.',
  '可以取消訂閱嗎？': 'Có thể hủy đăng ký không?',
  '可以，隨時取消。取消後當月剩餘天數仍可使用付費功能，下個月恢復為免費版。': 'Được, hủy bất cứ lúc nào. Sau khi hủy vẫn dùng được tính năng trả phí đến hết những ngày còn lại của tháng, tháng sau trở về bản miễn phí.',
  '哪些瀏覽器支援？': 'Hỗ trợ trình duyệt nào?',
  '目前支援 Chrome 和所有 Chromium 瀏覽器（Edge、Brave、Arc 等）。': 'Hiện hỗ trợ Chrome và tất cả trình duyệt nhân Chromium (Edge, Brave, Arc, v.v.).',
  '會影響網頁效能嗎？': 'Có ảnh hưởng đến hiệu năng trang web không?',
  '影響極小。BugEzy 只在你主動錄製時才記錄 DOM 變化，即時監控模式只攔截 Console error 和 Network error，不錄 DOM。': 'Ảnh hưởng cực nhỏ. BugEzy chỉ ghi thay đổi DOM khi bạn chủ động ghi hình; chế độ giám sát trực tiếp chỉ bắt Console error và Network error, không ghi DOM.',
  'MCP 是什麼？': 'MCP là gì?',
  'Model Context Protocol（模型上下文協議），是 Anthropic 推出的開放標準，讓 AI 工具可以連接外部服務。BugEzy 的 MCP 讓 AI 直接讀取你的 Bug 報告，不需要複製貼上。': 'Model Context Protocol (giao thức ngữ cảnh mô hình) là tiêu chuẩn mở do Anthropic giới thiệu, cho phép công cụ AI kết nối dịch vụ bên ngoài. MCP của BugEzy giúp AI đọc trực tiếp báo cáo Bug của bạn, không cần sao chép dán.',
  'Token 是什麼？為什麼 BugEzy 能省 Token？': 'Token là gì? Tại sao BugEzy tiết kiệm Token?',
  'Token 是 AI 處理文字的計量單位，等於你的 AI 使用費用。BugEzy 用結構化文字（而非截圖）傳送報告給 AI，同樣的 Bug 資訊只需要 1/20 的 Token。每次 MCP AI 讀取都會顯示 Token 估算，讓你看到省了多少。': 'Token là đơn vị đo AI xử lý văn bản, tương đương chi phí dùng AI của bạn. BugEzy gửi báo cáo cho AI bằng văn bản có cấu trúc (không phải ảnh chụp), cùng thông tin Bug chỉ cần 1/20 Token. Mỗi lần MCP AI đọc đều hiển thị ước tính Token để bạn thấy tiết kiệm bao nhiêu.',
  '安裝 BugEzy — 3 分鐘搞定 Chrome 擴充 + MCP 設定': 'Cài đặt BugEzy — 3 phút xong tiện ích Chrome + cấu hình MCP',
  '安裝 BugEzy Chrome 擴充功能，設定 MCP 連線，讓 AI 直接讀取你的 Bug 報告。支援 Claude、Cursor、Windsurf、Google Antigravity、Gemini CLI。': 'Cài tiện ích Chrome BugEzy, cấu hình kết nối MCP để AI đọc trực tiếp báo cáo Bug của bạn. Hỗ trợ Claude, Cursor, Windsurf, Google Antigravity, Gemini CLI.',
  '🚀 安裝 BugEzy — 三分鐘搞定': 'Cài đặt BugEzy — xong trong 3 phút',
  '從零到能用，跟著五步走，馬上讓 AI 幫你修 Bug。': 'Từ số 0 đến dùng được, làm theo 5 bước để AI sửa Bug ngay.',
  '🤖 最快的安裝方式：複製貼給 AI': 'Cách cài nhanh nhất: sao chép dán cho AI',
  '不懂技術？把下面這段複製貼給你的 AI（Claude Desktop / Claude Code / Cursor / Windsurf / VS Code + Cline / Google Antigravity / Gemini CLI），它會幫你搞定。': 'Không rành kỹ thuật? Sao chép đoạn dưới dán cho AI (Claude Desktop / Claude Code / Cursor / Windsurf / VS Code + Cline / Google Antigravity / Gemini CLI), nó sẽ lo giúp bạn.',
  '已複製！': 'Đã sao chép!',
  '一鍵複製，貼給你的 AI': 'Sao chép một chạm, dán cho AI',
  '或依下方手動五步安裝 ↓': 'Hoặc cài thủ công theo 5 bước dưới',
  '安裝擴充功能': 'Cài tiện ích',
  '前往 Chrome Web Store 的 BugEzy 頁面': 'Truy cập trang BugEzy trên Chrome Web Store',
  '點「加到 Chrome」→ 在彈窗按「新增擴充功能」確認': 'Nhấn "Thêm vào Chrome" → trong cửa sổ bật lên nhấn "Thêm tiện ích" để xác nhận',
  '前往 Chrome Web Store →': 'Đến Chrome Web Store →',
  '支援 Chrome 以及所有 Chromium 核心瀏覽器（Edge、Brave、Arc 等）。': 'Hỗ trợ Chrome và mọi trình duyệt nhân Chromium (Edge, Brave, Arc, v.v.).',
  '固定到工具列': 'Ghim lên thanh công cụ',
  '點瀏覽器右上角的拼圖圖示 🧩（擴充功能選單）': 'Nhấn biểu tượng mảnh ghép ở góc phải trên (menu tiện ích)',
  '找到 BugEzy 🐛 → 按旁邊的釘選 📌': 'Tìm BugEzy → nhấn ghim bên cạnh',
  '釘選後圖示會常駐在工具列，隨時一鍵開錄，不用每次翻選單。': 'Sau khi ghim, biểu tượng nằm cố định trên thanh công cụ, một chạm là ghi được, không cần mở menu mỗi lần.',
  '登入': 'Đăng nhập',
  '點工具列上的 BugEzy 圖示': 'Nhấn biểu tượng BugEzy trên thanh công cụ',
  '按「用 Google 登入」→ 選擇帳號授權': 'Nhấn "Đăng nhập bằng Google" → chọn tài khoản và cấp quyền',
  'popup 顯示你的名字 = 登入成功': 'Popup hiển thị tên bạn = đăng nhập thành công',
  '第一次錄製': 'Ghi hình lần đầu',
  '開任意網頁 → 點 BugEzy 圖示 → 按「錄製」': 'Mở trang web bất kỳ → nhấn biểu tượng BugEzy → nhấn "Ghi hình"',
  '操作重現問題，同時用語音描述你看到的 Bug': 'Thao tác tái hiện vấn đề, đồng thời mô tả Bug bằng giọng nói',
  '按「停止」→ 自動打開報告編輯頁': 'Nhấn "Dừng" → tự động mở trang chỉnh sửa báo cáo',
  '🎉 恭喜，你的第一份 Bug 報告完成了！可以編輯文字、AI 校正精簡後上傳。': 'Chúc mừng, báo cáo Bug đầu tiên của bạn đã xong! Có thể chỉnh sửa văn bản, AI hiệu chỉnh/tóm tắt rồi tải lên.',
  '連接 AI（MCP 設定）': 'Kết nối AI (cấu hình MCP)',
  '讓 AI 直接讀你的 Bug 報告，不用複製貼上。': 'Để AI đọc trực tiếp báo cáo Bug, không cần sao chép dán.',
  '支援 Claude Desktop · Claude Code · Cursor · Windsurf · VS Code + Cline · Google Antigravity · Gemini CLI 等所有 MCP 工具。': 'Hỗ trợ mọi công cụ MCP: Claude Desktop · Claude Code · Cursor · Windsurf · VS Code + Cline · Google Antigravity · Gemini CLI.',
  '🔌 BugEzy MCP 網址（所有工具通用）': 'URL MCP BugEzy (dùng chung mọi công cụ)',
  '登入 BugEzy 後，本頁的網址與設定會自動幫你補上 ?token=（AI 就不用每次手動帶 token）。': 'Sau khi đăng nhập BugEzy, URL và cấu hình trên trang này sẽ tự động thêm ?token= (AI không phải nhập token thủ công mỗi lần).',
  '⚠ 這個網址<b>不能用瀏覽器開</b>，它是給 AI 工具連接的協議。用瀏覽器開只會看到錯誤訊息，屬正常現象——請依下方步驟在 AI 工具裡設定。': 'URL này <b>không mở được bằng trình duyệt</b>, đây là giao thức để công cụ AI kết nối. Mở bằng trình duyệt chỉ thấy thông báo lỗi là bình thường — hãy làm theo các bước dưới để cấu hình trong công cụ AI.',
  'Settings → Connectors → Add → 貼上網址 → 連接': 'Settings → Connectors → Add → dán URL → kết nối',
  '編輯設定檔（claude_desktop_config.json / mcp.json），加入：': 'Chỉnh file cấu hình (claude_desktop_config.json / mcp.json), thêm:',
  'Cline → MCP Servers → Add → 貼上網址': 'Cline → MCP Servers → Add → dán URL',
  'Claude Code（終端機）': 'Claude Code (terminal)',
  '在 MCP 設定加入（協定通用，格式同上）：': 'Thêm vào cấu hình MCP (giao thức chung, định dạng như trên):',
  '連接成功後直接問：': 'Sau khi kết nối, hỏi trực tiếp:',
  '「讀我最新的 BugEzy 報告，告訴我怎麼修」': '"Đọc báo cáo BugEzy mới nhất của tôi và cho biết cách sửa"',
  '13 個 MCP 工具（AI 按需查詢，省 Token）：': '13 công cụ MCP (AI truy vấn khi cần, tiết kiệm Token):',
  '最近報告清單': 'Danh sách báo cáo gần đây',
  '報告摘要': 'Tóm tắt báo cáo',
  '完整時序麵包屑': 'Dòng thời gian đầy đủ',
  'Console 錯誤': 'Lỗi Console',
  '網路錯誤': 'Lỗi mạng',
  '語音全文': 'Toàn văn giọng nói',
  '截圖': 'Ảnh chụp màn hình',
  'DOM 軌跡摘要': 'Tóm tắt dấu vết DOM',
  'DOM 事件細節': 'Chi tiết sự kiện DOM',
  '即時監控錯誤': 'Lỗi giám sát trực tiếp',
  'CLI 終端機日誌': 'Nhật ký terminal CLI',
  'Token 用量統計': 'Thống kê sử dụng Token',
  '🐍 後端開發者？試試 Terminal CLI': 'Lập trình viên backend? Thử Terminal CLI',
  '捕捉 Python / Node.js / Go 的終端機錯誤（stderr / traceback / crash），AI 直接讀取分析——不需開瀏覽器。付費功能。': 'Bắt lỗi terminal của Python / Node.js / Go (stderr / traceback / crash), AI đọc và phân tích trực tiếp — không cần mở trình duyệt. Tính năng trả phí.',
  '你的 token': 'Token của bạn',
  'AI 之後用 <code style="background:#2a2a3e;padding:1px 5px;border-radius:4px;color:#7ee0c5;">get_terminal_logs</code> MCP 工具讀取這些錯誤。': 'AI sau đó dùng công cụ MCP <code style="background:#2a2a3e;padding:1px 5px;border-radius:4px;color:#7ee0c5;">get_terminal_logs</code> để đọc các lỗi này.',
  '來看看有哪些功能 →': 'Xem có những tính năng nào →',
};

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
// PM-264：改由「頁面 + 語言集合」驅動，語言集合直接沿用 PM-263 的 LANGS_6/LANGS_3/LANGS_ZH，
//   確保 sitemap 列的 URL 與 HTML 的 canonical/hreflang 完全一致（單一事實來源，避免各說各話）。
//   每頁輸出：裸 URL（x-default 入口）+ 每個語言版本的 canonical URL（?lang=X），
//   並附 Google 支援的 xhtml:link hreflang 擴展（每筆 <url> 都帶完整語言集合 + x-default，含自我指涉）。
interface SitemapPage {
  path: string;
  langs: PageLang[];
  freq: string;
  pri: string; // 裸 URL 權重
  langPri?: string; // 語言版本權重（省略則同 pri）
}
function sitemapXml(): Response {
  const pages: SitemapPage[] = [
    { path: '/', langs: LANGS_6, freq: 'weekly', pri: '1.0', langPri: '0.8' },
    { path: '/features', langs: LANGS_6, freq: 'monthly', pri: '0.8', langPri: '0.7' },
    { path: '/faq', langs: LANGS_6, freq: 'monthly', pri: '0.5' },
    { path: '/changelog', langs: LANGS_3, freq: 'weekly', pri: '0.7' },
    { path: '/guide', langs: LANGS_3, freq: 'monthly', pri: '0.9' }, // PM-280：併入 /install
    { path: '/skill', langs: LANGS_3, freq: 'monthly', pri: '0.5' }, // PM-201：AI 客服手冊
    { path: '/blog', langs: LANGS_ZH, freq: 'weekly', pri: '0.6' }, // PM-256：部落格列表
    { path: '/testimonials', langs: LANGS_3, freq: 'monthly', pri: '0.6' }, // PM-272：用戶心得
    { path: '/feedback', langs: LANGS_3, freq: 'monthly', pri: '0.4' }, // PM-174
    { path: '/privacy', langs: LANGS_3, freq: 'yearly', pri: '0.3' },
    // PM-256：部落格文章（SEO）
    ...BLOG_POSTS.map(
      (p): SitemapPage => ({
        path: `/blog/${p.slug}`,
        langs: LANGS_ZH,
        freq: 'monthly',
        pri: '0.5',
      }),
    ),
  ];
  const entries: string[] = [];
  for (const pg of pages) {
    const base = `https://bugezy.dev${pg.path}`;
    // 該頁的 hreflang 擴展（所有語言 + x-default），每筆 <url> 都要完整重複一次（Google 要求）
    const alts =
      pg.langs
        .map(
          (l) =>
            `    <xhtml:link rel="alternate" hreflang="${HREFLANG_CODE[l]}" href="${base}?lang=${l}"/>`,
        )
        .join('\n') +
      `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${base}"/>`;
    const url = (loc: string, pri: string) =>
      `  <url>\n    <loc>${loc}</loc>\n    <changefreq>${pg.freq}</changefreq>\n    <priority>${pri}</priority>\n${alts}\n  </url>`;
    entries.push(url(base, pg.pri)); // 裸 URL = x-default 入口
    for (const l of pg.langs) entries.push(url(`${base}?lang=${l}`, pg.langPri ?? pg.pri));
  }
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    entries.join('\n') +
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

// ── PM-263：hreflang 多語索引（修 GSC「替代頁面（有適當的標準標記）」不索引問題）──────────
// 原因：各語言版本的 canonical 都指向主 URL → Google 視 ?lang=ja 等為主頁的替代版本而不單獨索引。
// 修法：①每個語言版本 canonical 指向「自己」②同頁所有語言版本輸出「同一組」hreflang（雙向互指）
//       ③x-default 指向不帶 lang 的主 URL。hreflang 的 URL 必須等於該版本的 canonical，故一律帶 ?lang=。
const HREFLANG_CODE: Record<PageLang, string> = {
  zh: 'zh-TW',
  'zh-CN': 'zh-CN',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  vi: 'vi',
};
/** 六語頁：首頁 / features / install / faq（JA/KO/VI_MAP 已全譯）。 */
const LANGS_6: PageLang[] = ['zh', 'zh-CN', 'en', 'ja', 'ko', 'vi'];
/** 三語頁：其餘 makeT 頁（zh 原文 / zh-CN 由 toSimplified / en）；ja/ko/vi 會 fallback 英文故不宣告。 */
const LANGS_3: PageLang[] = ['zh', 'zh-CN', 'en'];
/** 純中文頁：/blog 與文章頁（正文不過 t()，各語言內容相同）。 */
const LANGS_ZH: PageLang[] = ['zh'];

/** PM-263：該頁的 hreflang 標籤組（含 x-default）。同頁所有語言版本輸出相同內容。 */
function hreflangTags(path: string, langs: PageLang[]): string {
  const base = `https://bugezy.dev${path}`;
  const alts = langs.map(
    (l) => `<link rel="alternate" hreflang="${HREFLANG_CODE[l]}" href="${base}?lang=${l}" />`,
  );
  alts.push(`<link rel="alternate" hreflang="x-default" href="${base}" />`);
  return alts.join('\n');
}
/** PM-263：canonical 指向「自己這個語言版本」；該頁沒有此語言版本時收斂到主版本（langs[0]）。 */
/**
 * PM-289：canonical **必須等於當前 URL**——有 `?lang=` 就回顯它，沒有就是裸網址。
 *
 * 修正前是依「偵測到的語言」產生 canonical，造成兩個問題：
 *  1. 裸網址永遠 canonical 到 `?lang=xx`，但 sitemap 的 <loc> 與 hreflang 的 x-default
 *     指的都是裸網址 → x-default 的目標自己說「我不是正規版」→ **x-default 失效**（GSC 報錯）。
 *  2. canonical 會隨 `Accept-Language` 變動——同一個 URL 對不同 crawler 吐出不同 canonical，
 *     Googlebot 以多種語言設定爬取時會拿到互相矛盾的訊號。
 *
 * @param explicit 請求 query 中的 `?lang=`（`explicitLang()` 取得）；沒有帶就是 null。
 *                 **刻意不吃偵測結果**——canonical 是 URL 的屬性，不該受請求標頭影響。
 */
function canonicalTag(path: string, explicit: PageLang | null, langs: PageLang[]): string {
  // 該頁不支援的語言（例如 /blog?lang=ja，blog 只有繁中）→ 併回裸網址，避免產生孤兒 canonical
  const q = explicit && langs.includes(explicit) ? `?lang=${explicit}` : '';
  return `<link rel="canonical" href="https://bugezy.dev${path}${q}" />`;
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

// PM-434：官網 hero 的實拍長腳大黃蜂。Worker 沒有靜態資源目錄，沿用上面 icon-128.png 那套。
function hornetPng(): Response {
  const bin = atob(HORNET_REAL_B64);
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

// PM-266：活動票券 —— 查此用戶是否有「ACTIVE 且未到期」的票券（視同付費）。
async function hasActiveTicket(userId: string, env: Env): Promise<boolean> {
  const { data } = await supa(env)
    .from('user_tickets')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'ACTIVE')
    .gt('expires_at', new Date().toISOString())
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/** PM-267：**只看 ECPay**（月費/取消未到期/日票）的付費狀態，不看活動票券。
 *  ECPay callback 的孤兒自癒守門必須用這支——若用含票券的版本，
 *  「持有免費票券的人付費」會被誤判為已 active 而**跳過升級 → 收了錢卻沒開通**。 */
async function isEcpayActiveUserId(userId: string, env: Env): Promise<boolean> {
  const { data } = await supa(env)
    .from('users')
    .select('plan, day_pass_expires_at')
    .eq('user_id', userId)
    .maybeSingle();
  return data
    ? isActiveUser(data as { plan?: string | null; day_pass_expires_at?: string | null })
    : false;
}

/** PM-321（決策 3 / §12 A-5）：方案等級。v1 功能看 `active`，v2 功能要看 `tier`。 */
export type UserTier = 'free' | 'ticket' | 'day_pass' | 'pro' | 'max' | 'agent';

/** PM-321：v2（bridge）功能只開放給這些等級——票券／日票只含 v1。 */
const V2_ALLOWED_TIERS: readonly UserTier[] = ['pro', 'max', 'agent'];
export function tierAllowsV2(tier: UserTier): boolean {
  return V2_ALLOWED_TIERS.includes(tier);
}

// PM-144：以 user_id 查 users 表判斷是否為有效付費用戶（terminal-logs 付費限定用）。
// PM-266：ECPay 不通過時再查活動票券（ACTIVE 未到期 → 視同付費）。
// PM-321：改回傳 { active, tier }——v2 工具需要分辨「票券/日票」與「Pro 訂閱」。
//
// 🔴 **回傳型別從 boolean 改成物件，所有呼叫端都必須改用 `.active`。**
//    物件**恆為 truthy**，漏改的 `if (await isActiveUserId(...))` 會變成「永遠通過」，
//    等於把付費功能免費開放給所有人，而且完全不會報錯。已逐一改完 4 處呼叫端。
//
// ⚠ 這支代表「是否享有付費功能」，**不可**用於 ECPay 開通判斷（見 isEcpayActiveUserId）。
async function isActiveUserId(userId: string, env: Env): Promise<{ active: boolean; tier: UserTier }> {
  const { data } = await supa(env)
    .from('users')
    .select('plan, day_pass_expires_at')
    .eq('user_id', userId)
    .maybeSingle();
  const u = (data ?? {}) as { plan?: string | null; day_pass_expires_at?: string | null };

  // ECPay 側：月費 paid / 取消未到期 cancelled → pro；日票未到期 → day_pass
  if (u.plan === 'paid' || u.plan === 'cancelled') return { active: true, tier: 'pro' };
  if (u.plan === 'day_pass' && u.day_pass_expires_at && new Date(u.day_pass_expires_at) > new Date()) {
    return { active: true, tier: 'day_pass' };
  }
  // 活動票券（PM-266）：享有 v1 無限錄製，但**不含 v2**
  if (await hasActiveTicket(userId, env)) return { active: true, tier: 'ticket' };
  return { active: false, tier: 'free' };
}

// ── PM-328：測試用故意出錯頁（GET /test-errors）────────────────────────────
// 目的：`get_browser_errors` 的 network_errors 端到端驗證需要一個「會自己發出失敗請求」的頁面，
//   而 bugezy.dev 上原本沒有這種頁（PM-314 的 313-3 因此一直是 LIMIT）。
//
// 三個刻意的設計：
//   ① **noindex + nofollow + 不進 sitemap** —— 一個滿是錯誤的頁被 Google 收錄只會誤導人。
//   ② **請求全部同源** —— CSP 的 `connect-src` 只允許 'self'，打第三方（例如 httpstat.us）
//      會變成 CSP 違規的 TypeError，而不是我們要測的 4xx/5xx 網路錯誤。
//   ③ **頁面上明白寫出「這些錯誤是故意的」** —— 免得有人誤以為站壞了來回報。
function testErrorsPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>BugEzy 測試頁（故意出錯）· Intentional Test Errors</title>
  <style>
    body { background:#0f0f1a; color:#e0e0e0; font-family:system-ui,-apple-system,"Microsoft JhengHei",sans-serif;
           line-height:1.7; max-width:760px; margin:0 auto; padding:40px 20px; }
    h1 { font-size:22px; margin-bottom:8px; }
    .warn { background:rgba(255,180,0,.12); border:1px solid rgba(255,180,0,.4); border-radius:10px;
            padding:16px 20px; margin:20px 0; }
    code { background:rgba(255,255,255,.08); padding:2px 6px; border-radius:4px; font-size:13px; }
    ul { margin:10px 0 0 20px; } li { margin-bottom:6px; font-size:14px; }
    .dim { color:rgba(255,255,255,.5); font-size:13px; }
  </style>
</head>
<body>
  <h1>🧪 BugEzy 測試頁 — 這裡的錯誤都是故意的</h1>
  <div class="warn">
    <strong>⚠ 這不是 bug，請不要回報。</strong><br>
    This page <strong>intentionally</strong> triggers errors so that BugEzy's
    <code>get_browser_errors</code> tool can be verified end-to-end. Nothing here is broken.
  </div>
  <p>本頁載入時會故意觸發以下四種錯誤：</p>
  <ul>
    <li><code>fetch('/api/this-does-not-exist')</code> → <strong>404</strong>（network error）</li>
    <li><code>fetch('/api/test-error-500')</code> → <strong>500</strong>（network error）</li>
    <li><code>console.error(...)</code> → console error</li>
    <li><code>throw new Error(...)</code>（未捕獲）→ uncaught error</li>
  </ul>
  <p class="dim" style="margin-top:20px">
    全部為同源請求（CSP <code>connect-src 'self'</code>）。本頁標記 <code>noindex, nofollow</code> 且不列入 sitemap。<br>
    Added by PM-328.
  </p>
  <script>
    // 故意的失敗請求——catch 掉是為了不讓 unhandledrejection 蓋過真正要測的 network error
    fetch('/api/this-does-not-exist').catch(function () {});
    fetch('/api/test-error-500').catch(function () {});
    console.error('BugEzy test error: this is intentional (PM-328)');
    setTimeout(function () { throw new Error('BugEzy test: uncaught error (PM-328, intentional)'); }, 100);
  </script>
</body>
</html>`;
}

// ── PM-62：產品首頁（GET /）— 一頁式、深色主題、無 JS、RWD（綠界審核 + 客戶訪問用）──
// PM-150：首頁改為函式（依 lang 中英切換）。CSS/script 不變，只切換文字 + <html lang> + meta。
// PM-222：小白友善重構——漸進式揭露（Hero 講人話 → 三步驟 → 截圖展示 → 賣點 → 語言 → CTA）。
//   技術細節（六模式/MCP/rrweb/框架）移到 /features。截圖存 R2，經 GET /screenshots/*.png serve。
function homePage(lang: PageLang, _request: Request, canonLang: PageLang | null): string {
  const t = makeT(lang); // PM-232：zh/en/zh-CN 三語（zh-CN 由繁體轉簡體）
  const CWS = 'https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj';
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${t('BugEzy — 開發者 Bug 報告工具，AI 幫你修', 'BugEzy — Bug Reporter for Developers, AI fixes your bugs')}</title>
  <meta name="description" content="${t('亞洲最平價的 MCP 語音除錯工具。錄製 Bug、AI 自動分析、一鍵報告。支援 Claude、Cursor、Windsurf 等 7 大 AI 工具。月費 NT$80 起。', 'The most affordable MCP voice debugging tool in Asia. Record bugs, AI auto-analysis, one-click reports. Works with Claude, Cursor, Windsurf and 7 major AI tools. From NT$80/mo.')}">
  <meta name="keywords" content="BugEzy, bug reporter, MCP, AI debugging, Chrome extension, ${t('語音除錯', 'voice debugging')}, bug tracking">
  ${ogMeta('', 'BugEzy — Voice-Powered Bug Reporting for Developers', 'Capture bugs with voice, console logs, network errors, and DOM traces. Affordable MCP debugging tool. Chrome Extension + Python CLI. NT$80/mo.')}
  ${jsonLd(SOFTWARE_APP_LD)}
  ${jsonLd(ORGANIZATION_LD)}
  <meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
  ${canonicalTag('/', canonLang, LANGS_6)}
  ${hreflangTags('/', LANGS_6)}
  ${SITE_FONTS}
  <style>${SITE_CHROME_CSS}
    /* ── PM-434：首頁（設計稿畫面 28）。長頁面不整頁黃，改黃／米白／黑交替分節；
         黃色只留給 hero、定價、結尾 CTA 三個決策點。 ── */
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:var(--cream); color:var(--ink); font-family:var(--font-ui); line-height:1.6; }
    a { color:var(--brown-d); text-decoration:none; }
    img { display:block; max-width:100%; }
    .sec { padding:64px 40px; }
    .inner { max-width:1200px; margin:0 auto; }
    .sec-head { display:flex; flex-direction:column; gap:9px; align-items:center; text-align:center; margin-bottom:34px; }
    .sec-head h2 { font:800 33px/1.3 var(--font-ui); color:var(--ink); }
    .sec-head .rule { width:52px; height:4px; border-radius:2px; background:var(--y); }
    .sec-head p { font:600 14px/1.6 var(--font-ui); color:var(--on-y); }

    /* §2 hero（決策點 1）。⚠ 蜂巢紋 data URI 內不可有未編碼的分號。hero 用 56×98 的大格。 */
    .hero { padding:70px 40px 76px; background:var(--y);
      background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='98' viewBox='0 0 56 98'%3E%3Cg fill='none' stroke='rgba(20,17,11,0.09)' stroke-width='1.6'%3E%3Cpath d='M27.98 18.5l26 15v30l-26 15-26-15v-30z'/%3E%3Cpath d='M27.98 -30.5l26 15v30l-26 15-26-15v-30z'/%3E%3Cpath d='M27.98 66.5l26 15v30l-26 15-26-15v-30z'/%3E%3C/g%3E%3C/svg%3E");
      display:flex; align-items:center; justify-content:center; gap:56px; flex-wrap:wrap; }
    .hero-copy { max-width:620px; display:flex; flex-direction:column; gap:18px; }
    .hero-copy h1 { font:900 52px/1.2 var(--font-ui); letter-spacing:-.01em; color:var(--ink); }
    .hero-copy .lead { font:600 18px/1.7 var(--font-ui); color:var(--on-y); }
    .hero-cta { display:flex; gap:12px; flex-wrap:wrap; }
    .hero-note { display:flex; align-items:center; gap:9px; font:600 13px/1.6 var(--font-ui); color:var(--on-y); }
    .hero-note i { width:9px; height:10px; flex-shrink:0; background:var(--ink); clip-path:var(--hex); }
    .hero-art { width:398px; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
    .hero-art img { width:340px; height:340px; object-fit:contain; filter:drop-shadow(0 20px 34px rgba(74,47,18,.4)); }

    /* §7.1 硬投影按鈕 */
    .btn { display:inline-block; padding:17px 30px; border:2px solid var(--ink); border-radius:13px; background:var(--ink); color:var(--y); font:700 16px/1 var(--font-ui); box-shadow:4px 4px 0 var(--brown); white-space:nowrap; cursor:pointer; }
    .btn:hover { transform:translate(2px,2px); box-shadow:2px 2px 0 var(--brown); }
    .btn.ghost { background:transparent; color:var(--ink); border-color:rgba(20,17,11,.45); box-shadow:none; }
    .btn.ghost:hover { transform:none; border-color:var(--ink); background:rgba(20,17,11,.07); }
    .btn.on-dark { background:var(--y); color:var(--ink); border-color:var(--y); box-shadow:none; padding:17px 34px; }
    .btn.on-dark:hover { transform:none; background:var(--y-deep); border-color:var(--y-deep); }

    /* §3 米白三步驟 */
    .sec-steps { background:var(--cream); }
    .steps { display:grid; grid-template-columns:repeat(3,1fr); gap:20px; }
    .step { background:#fff; border:2px solid var(--ink); border-radius:16px; box-shadow:4px 4px 0 var(--y); padding:26px 24px; display:flex; flex-direction:column; gap:12px; }
    .step .n { width:44px; height:51px; flex-shrink:0; background:var(--ink); clip-path:var(--hex); display:flex; align-items:center; justify-content:center; font:800 20px/1 var(--font-brand); color:var(--y); }
    .step h3 { font:700 19px/1.4 var(--font-ui); color:var(--ink); }
    .step p { font:500 14px/1.7 var(--font-ui); color:var(--on-y-2); }
    .steps-more { text-align:center; margin-top:26px; }

    /* §4 黑底展示區 */
    .sec-show { background:var(--ink); }
    .sec-show .sec-head h2 { color:var(--y); }
    .showcase { display:flex; flex-direction:column; gap:44px; }
    .show-row { display:flex; align-items:center; gap:40px; }
    .show-row.reverse { flex-direction:row-reverse; }
    .show-row .shot { flex:1 1 55%; min-width:0; }
    .show-row .shot img { width:100%; border:2px solid var(--brown); border-radius:14px; background:#211C13; }
    .show-row .txt { flex:1 1 45%; display:flex; flex-direction:column; gap:11px; }
    .show-row .txt h3 { font:700 22px/1.4 var(--font-ui); color:var(--y); }
    .show-row .txt p { font:500 14.5px/1.75 var(--font-ui); color:var(--on-dark-2); }

    /* §5 米白賣點 */
    .sec-points { background:var(--cream); }
    .points { display:grid; grid-template-columns:repeat(2,1fr); gap:14px; }
    .point { display:flex; align-items:flex-start; gap:12px; padding:18px 20px; background:#fff; border:2px solid var(--ink); border-radius:12px; }
    .point i { width:11px; height:13px; flex-shrink:0; margin-top:4px; background:var(--y); clip-path:var(--hex); }
    .point span { font:600 14.5px/1.6 var(--font-ui); color:var(--ink); }
    .points-more { display:flex; gap:22px; justify-content:center; flex-wrap:wrap; margin-top:26px; font:700 14px/1 var(--font-ui); }

    /* §6 咖啡語言帶（§2.3 咖啡＝系統說明的語氣） */
    .sec-langs { background:var(--brown); display:flex; flex-direction:column; align-items:center; gap:26px; }
    .sec-langs h2 { font:800 33px/1.3 var(--font-ui); color:var(--y-pale); text-align:center; }
    .sec-langs .sub { font:600 14px/1.6 var(--font-ui); color:#F0D9A8; text-align:center; }
    .sec-langs img { max-width:340px; width:100%; border:2px solid var(--y-pale); border-radius:14px; }
    .lang-pills { display:flex; flex-wrap:wrap; gap:10px; justify-content:center; }
    .lang-pills span { padding:9px 18px; border-radius:999px; background:var(--y); color:var(--ink); font:700 13.5px/1 var(--font-ui); }

    /* §7 黃底定價（決策點 2） */
    .sec-price { background:var(--y); background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='98' viewBox='0 0 56 98'%3E%3Cg fill='none' stroke='rgba(20,17,11,0.09)' stroke-width='1.6'%3E%3Cpath d='M27.98 18.5l26 15v30l-26 15-26-15v-30z'/%3E%3Cpath d='M27.98 -30.5l26 15v30l-26 15-26-15v-30z'/%3E%3Cpath d='M27.98 66.5l26 15v30l-26 15-26-15v-30z'/%3E%3C/g%3E%3C/svg%3E"); }
    .plans { display:grid; grid-template-columns:repeat(3,1fr); gap:18px; align-items:stretch; }
    .plan { padding:26px 24px; background:var(--cream); border:2px solid var(--ink); border-radius:16px; display:flex; flex-direction:column; gap:14px; }
    .plan .tier { font:700 15px/1 var(--font-ui); color:var(--on-y-2); }
    .plan .price { display:flex; align-items:baseline; gap:5px; }
    .plan .price b { font:800 40px/1 var(--font-brand); color:var(--ink); }
    .plan .price em { font:600 13px/1 var(--font-mono); font-style:normal; color:var(--on-y-2); }
    .plan ul { list-style:none; display:flex; flex-direction:column; gap:7px; padding-top:10px; border-top:1px solid rgba(20,17,11,.18); }
    .plan li { font:600 13px/1.6 var(--font-ui); color:var(--on-y-2); }
    .plan .pick { width:100%; margin-top:auto; padding:13px; border:2px solid var(--ink); border-radius:11px; background:transparent; color:var(--ink); font:700 13.5px/1 var(--font-ui); text-align:center; }
    .plan .pick:hover { background:rgba(20,17,11,.09); }
    .plan.free .pick { border-color:rgba(20,17,11,.45); color:var(--on-y); }
    .plan.free .pick:hover { border-color:var(--ink); color:var(--ink); }
    /* §2.2 比例反轉：主推方案反黑 */
    .plan.best { position:relative; background:var(--ink); box-shadow:5px 5px 0 var(--brown); }
    .plan.best .tier { color:var(--on-dark-2); }
    .plan.best .price b { color:var(--y); }
    /* §2.4 深底次要文字只有兩階：設計稿這裡寫 #8A7550（3.8:1），黑底上不夠 → 用 --on-dark。 */
    .plan.best .price em { color:var(--on-dark); }
    .plan.best ul { border-top-color:#3A3122; }
    .plan.best li { color:var(--y-pale); }
    .plan.best .pick { background:var(--y); border-color:var(--y); color:var(--ink); }
    .plan.best .pick:hover { background:var(--y-deep); border-color:var(--y-deep); }
    .plan .flag { position:absolute; top:-13px; left:24px; padding:4px 12px; border-radius:999px; background:var(--cream); border:2px solid var(--ink); font:700 11px/1 var(--font-ui); color:var(--ink); }
    .plans-note { margin-top:20px; text-align:center; font:600 13px/1.6 var(--font-ui); color:var(--on-y); }

    /* §8 黑底結尾 CTA（決策點 3） */
    .sec-end { background:var(--ink); padding:72px 40px; display:flex; flex-direction:column; align-items:center; gap:24px; text-align:center; }
    .sec-end h2 { font:800 31px/1.45 var(--font-ui); color:var(--y); max-width:760px; }
    .sec-end .store-shot { max-width:420px; width:100%; border:2px solid var(--brown); border-radius:14px; background:#211C13; }
    .sec-end .end-links { display:flex; gap:14px; align-items:center; flex-wrap:wrap; justify-content:center; font:600 13px/1 var(--font-ui); }
    .sec-end .end-links a { color:var(--on-dark-2); }
    .sec-end .end-links a:hover { color:var(--y); }
    .sec-end .end-links s { color:var(--on-dark); text-decoration:none; }

    @media (max-width:900px) {
      .sec { padding:48px 20px; }
      .hero { padding:52px 20px 56px; gap:32px; }
      .hero-copy h1 { font-size:34px; }
      .hero-copy .lead { font-size:16px; }
      .hero-art { width:100%; }
      .hero-art img { width:240px; height:240px; }
      .steps, .points, .plans { grid-template-columns:1fr; }
      .show-row, .show-row.reverse { flex-direction:column; gap:20px; }
      .sec-end { padding:56px 20px; }
      .sec-end h2 { font-size:24px; }
    }
  </style>
</head>
<body>
${siteNav(lang, LANGS_6, '')}

  <!-- §1 Hero（決策點 1）-->
  <header class="hero">
    <div class="hero-copy">
      <h1>${t('遇到 Bug，說不清楚？', "Can't explain the bug?")}</h1>
      <p class="lead">${t('按一下錄製，用說的就好。BugEzy 自動收集畫面、操作、錯誤訊息，讓 AI 幫你修。', 'Just hit record and talk. BugEzy captures your screen, actions, and errors automatically — so AI can fix it for you.')}</p>
      <div class="hero-cta">
        <a class="btn" href="${CWS}" target="_blank" rel="noopener">${t('免費安裝 Chrome 擴充功能', 'Install Free Chrome Extension')}</a>
        <a class="btn ghost" href="/guide">${t('完整安裝與使用指南', 'Complete Install & Usage Guide')}</a>
      </div>
      <p class="hero-note"><i></i>${t('免費版每月 10 次錄製 · 不需信用卡', '10 free recordings per month · No credit card required')}</p>
    </div>
    <div class="hero-art">
      <img src="/hornet-real.png" alt="${t('長腳大黃蜂', 'Hornet')}" width="340" height="340">
    </div>
  </header>

  <!-- §2 三步驟（米白）-->
  <section class="sec sec-steps">
    <div class="inner">
      <div class="sec-head"><h2>${t('簡單三步，不用教', 'Three simple steps')}</h2><div class="rule"></div></div>
      <div class="steps">
        <div class="step"><span class="n">1</span><h3>${t('按下錄製', 'Hit Record')}</h3><p>${t('打開 BugEzy，按一下就開始。邊操作邊說出你遇到的問題。', 'Open BugEzy, hit record. Operate and describe the issue in your own words.')}</p></div>
        <div class="step"><span class="n">2</span><h3>${t('自動整理', 'Auto-organized')}</h3><p>${t('BugEzy 自動收集畫面錄影、錯誤訊息、操作軌跡，整理成一份報告。', 'BugEzy captures screen replay, error logs, and actions into a structured report.')}</p></div>
        <div class="step"><span class="n">3</span><h3>${t('AI 幫你修', 'AI Fixes It')}</h3><p>${t('把報告交給 AI，它直接告訴你哪裡壞了、怎麼修。', 'Hand the report to AI — it tells you what broke and how to fix it.')}</p></div>
      </div>
      <div class="steps-more"><a class="btn ghost" href="/guide">${t('完整安裝與使用指南', 'Complete Install & Usage Guide')}</a></div>
    </div>
  </section>

  <!-- §3 截圖展示（黑底）-->
  <section class="sec sec-show">
    <div class="inner">
      <div class="sec-head"><h2>${t('眼見為憑', 'See it in action')}</h2><div class="rule"></div></div>
      <div class="showcase">
        <div class="show-row">
          <div class="shot"><img src="/screenshots/ss-recording.png" alt="${t('錄製中', 'Recording')}" loading="lazy"></div>
          <div class="txt"><h3>${t('錄製超簡單', 'Recording is effortless')}</h3><p>${t('打開瀏覽器，按下錄製，邊操作邊用嘴巴講。你的聲音會即時變成文字。', 'Open your browser, hit record, and just talk. Your voice becomes text in real-time.')}</p></div>
        </div>
        <div class="show-row reverse">
          <div class="shot"><img src="/screenshots/ss-report-top.png" alt="${t('報告', 'Report')}" loading="lazy"></div>
          <div class="txt"><h3>${t('報告自動整理', 'Reports, auto-organized')}</h3><p>${t('錄完後，BugEzy 自動產出完整報告 — 畫面回放、語音記錄、操作軌跡，全部幫你整理好。', 'After recording, BugEzy generates a complete report — screen replay, voice transcript, and action timeline, all organized for you.')}</p></div>
        </div>
        <div class="show-row">
          <div class="shot"><img src="/screenshots/ss-report-bottom.png" alt="${t('AI 校正與 Token', 'AI correction & tokens')}" loading="lazy"></div>
          <div class="txt"><h3>${t('AI 校正 + 省 93% 費用', 'AI correction + save 93%')}</h3><p>${t('AI 自動校正語音辨識的錯字，還幫你精簡重點。比起直接丟截圖給 AI，省下 93% 的費用。', 'AI auto-corrects speech recognition errors and summarizes key points. Save 93% on token costs compared to sending screenshots to AI.')}</p></div>
        </div>
        <div class="show-row reverse">
          <div class="shot"><img src="/screenshots/ss-ai-fix.png" alt="${t('AI 修復', 'AI fix')}" loading="lazy"></div>
          <div class="txt"><h3>${t('AI 直接幫你修 Bug', 'AI fixes the bug directly')}</h3><p>${t('把報告交給 AI，一句「幫我找出問題」，AI 就自動分析、找出根因、給你修復程式碼。不用再截圖、複製貼上、來回解釋。', 'Hand the report to AI. One command: "find and fix the issues." AI analyzes, identifies root causes, and gives you the fix. No more screenshots, copy-paste, or back-and-forth.')}</p></div>
        </div>
      </div>
    </div>
  </section>

  <!-- §4 賣點（米白）-->
  <section class="sec sec-points">
    <div class="inner">
      <div class="sec-head"><h2>${t('為什麼選 BugEzy', 'Why BugEzy')}</h2><div class="rule"></div></div>
      <div class="points">
        <div class="point"><i></i><span>${t('用說的就好 — 支援中文、粵語、英文', 'Just talk — Chinese, Cantonese, English')}</span></div>
        <div class="point"><i></i><span>${t('一鍵錄製 — 畫面 + 聲音 + 操作同步捕捉', 'One-click record — screen, voice, actions')}</span></div>
        <div class="point"><i></i><span>${t('AI 自動分析 — 13 種 MCP 工具', 'AI auto-analysis — 13 MCP tools')}</span></div>
        <div class="point"><i></i><span>${t('省 93% 費用 — 比截圖丟 AI 便宜', 'Save 93% — cheaper than sending screenshots')}</span></div>
        <div class="point"><i></i><span>${t('隱私保護 — 敏感資料自動打碼', 'Privacy first — sensitive data auto-masked')}</span></div>
        <div class="point"><i></i><span>${t('免費開始 — 月費只要 NT$80', 'Start free — paid plan just NT$80/mo')}</span></div>
        <div class="point"><i></i><span>${t('錄一次，所有 AI 讀 — 多工具同步連線', 'Record once, every AI reads — multi-tool sync')}</span></div>
      </div>
      <div class="points-more">
        <a href="/features">${t('查看完整功能 →', 'See full features →')}</a>
        <a href="/testimonials">${t('看看其他開發者怎麼說 →', 'See what other developers say →')}</a>
      </div>
    </div>
  </section>

  <!-- §5 語言（咖啡）-->
  <section class="sec sec-langs">
    <h2>${t('用你的母語說', 'Speak your language')}</h2>
    <p class="sub">${t('支援七種語言語音輸入', 'Voice input in 7 languages')}</p>
    <img src="/screenshots/ss-languages.png" alt="${t('語言選擇', 'Language selection')}" loading="lazy">
    <div class="lang-pills">
      <span>${t('繁體中文', 'Chinese')}</span>
      <span>${t('簡體中文', 'Simplified Chinese')}</span>
      <span>${t('粵語', 'Cantonese')}</span>
      <span>English</span>
      <span>日本語</span>
      <span>한국어</span>
      <span>Tiếng Việt</span>
    </div>
  </section>

  <!-- §6 定價（決策點 2）-->
  <section class="sec sec-price" id="pricing">
    <div class="inner">
      <div class="sec-head"><h2>${t('定價', 'Pricing')}</h2><div class="rule"></div><p>${t('免費開始，需要時再升級', 'Start free, upgrade when you need it')}</p></div>
      <div class="plans">
        <div class="plan free">
          <div class="tier">${t('免費', 'Free')}</div>
          <div class="price"><b>NT$0</b></div>
          <ul>
            <li>${t('每月 10 次錄製', '10 recordings per month')}</li>
            <li>${t('5 次回溯 · 20 次 MCP', '5 rewinds · 20 MCP reads')}</li>
            <li>${t('報告保留 7 天', '7-day report retention')}</li>
          </ul>
          <a class="pick" href="${CWS}" target="_blank" rel="noopener">${t('免費安裝', 'Install free')}</a>
        </div>
        <div class="plan best">
          <span class="flag">${t('最划算', 'Best value')}</span>
          <div class="tier">${t('月費', 'Monthly')}</div>
          <div class="price"><b>NT$80</b><em>${t('/月', '/mo')}</em></div>
          <ul>
            <li>${t('全功能無限次', 'Unlimited everything')}</li>
            <li>${t('Whisper 精準轉錄', 'Whisper precise transcription')}</li>
            <li>${t('終端機 CLI · 報告保留 90 天', 'Terminal CLI · 90-day retention')}</li>
          </ul>
          <a class="pick" href="${CWS}" target="_blank" rel="noopener">${t('升級月費', 'Go monthly')}</a>
        </div>
        <div class="plan">
          <div class="tier">${t('日票', 'Day pass')}</div>
          <div class="price"><b>NT$20</b><em>/24h</em></div>
          <ul>
            <li>${t('24 小時無限次', 'Unlimited for 24 hours')}</li>
            <li>${t('今天先解決這件事', 'Just fix it today')}</li>
            <li>${t('不自動續約', 'No auto-renewal')}</li>
          </ul>
          <a class="pick" href="${CWS}" target="_blank" rel="noopener">${t('買日票', 'Buy day pass')}</a>
        </div>
      </div>
      <p class="plans-note">${t('升級與日票都在擴充功能裡完成付款，先安裝再選方案。', 'Upgrades and day passes are purchased inside the extension — install it first, then pick a plan.')}</p>
    </div>
  </section>

  <!-- §7 結尾 CTA（決策點 3）-->
  <section class="sec-end">
    <h2>${t('還在用截圖跟 AI 解釋 Bug？試試用說的。', 'Still sending screenshots to explain bugs? Try just talking.')}</h2>
    <a class="btn on-dark" href="${CWS}" target="_blank" rel="noopener">${t('免費安裝', 'Install free')}</a>
    <img class="store-shot" src="/screenshots/ss-store.png" alt="Chrome Web Store" loading="lazy">
    <div class="end-links">
      <a href="${CWS}" target="_blank" rel="noopener">Chrome Web Store</a><s>·</s>
      <a href="https://github.com/fox100039-design/bugezy" target="_blank" rel="noopener">GitHub</a><s>·</s>
      <a href="/guide">${t('完整指南', 'Guide')}</a>
    </div>
  </section>

${siteFooter(lang)}
</body>
</html>`;
}

// ── PM-64：隱私政策頁（Chrome Web Store 上架 + 綠界審核要求可訪問的隱私政策 URL）──
// 中英雙語，PM-435 起改大黃蜂視覺（米白底 + 白卡），一頁式無 JS、RWD。
// PM-152：/privacy 改為函式（依 lang 只顯示對應語言區塊；原本中英雙語堆疊 → 改語言切換）。
function privacyPage(lang: PageLang, canonLang: PageLang | null): string {
  const t = makeT(lang); // PM-232：zh/en/zh-CN 三語（zh-CN 由繁體轉簡體）
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('隱私政策 · BugEzy', 'Privacy Policy · BugEzy')}</title>
<meta name="description" content="${t('BugEzy 隱私政策：我們收集什麼資料、如何使用與保護。', 'BugEzy privacy policy — what data we collect, how we use it, and how we protect your information.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
${canonicalTag('/privacy', canonLang, LANGS_3)}
${hreflangTags('/privacy', LANGS_3)}
${ogMeta('/privacy', 'Privacy Policy — BugEzy', 'How BugEzy handles your data.')}
${SITE_FONTS}
  <style>${SITE_CHROME_CSS}${SITE_CONTENT_CSS}
  /* PM-435：隱私長文＝白卡條列（設計稿畫面 29 區塊庫 A） */
  .wrap { max-width:760px; }
  h2 { font:700 17px/1.4 var(--font-ui); margin:0 0 12px; }
  .privacy-sec { margin:14px 0 0; padding:18px 20px; background:#fff; border:2px solid var(--ink); border-radius:12px; }
  .privacy-sec > ul { margin:0; }
  .privacy-sec > p { font:500 13.5px/1.9 var(--font-ui); color:var(--on-y); margin:0 0 6px; }
  .lang-divider { margin:44px 0 0; padding-top:14px; border-top:2px dashed rgba(20,17,11,.35); font:600 13px/1.7 var(--font-ui); color:var(--on-y-2); }
  /* PM-291：權限對照表（審核員會逐項比對 manifest / Dashboard / 本頁三方是否一致） */
  table.perm code { background:var(--y-pale); }
 /* Google Limited Use 聲明——屬系統告知 → §2.3 咖啡底 */
  .limited-use { margin:12px 0 0; padding:13px 15px; background:var(--brown); border:none; border-radius:10px;
    font:600 12.5px/1.8 var(--font-ui); color:var(--y-pale); }
  .limited-use a { color:var(--y); }
</style>
</head>
<body>
${siteNav(lang, LANGS_3, '')}
<div class="wrap">
${t(
    `
  <h1>隱私政策</h1>
  <div class="updated">最後更新：2026 年 8 月 14 日　·　開發者：FOX Chang</div>

  <section class="privacy-sec">
  <h2>1. 聯絡資訊</h2>
  <ul>
    <li>開發者：FOX Chang</li>
    <li>Email：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></li>
    <li>電話：0983-101-085</li>
    <li>本政策適用於 BugEzy Chrome 擴充功能與 bugezy.dev 網站。</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>2. 我們收集哪些資料</h2>
  <p>下表逐一對照本擴充功能在 <code>manifest.json</code> 中宣告的權限，說明各項權限實際存取的資料與用途。</p>
  <table class="perm">
    <tr><th>權限</th><th>存取的資料</th><th>為什麼需要</th></tr>
    <tr><td><code>identity</code></td><td>Google 帳號的 email、姓名、頭像（OAuth 範圍：<code>openid</code>、<code>email</code>、<code>profile</code>）</td><td>登入驗證與識別您的帳號</td></tr>
    <tr><td><code>activeTab</code></td><td>當前分頁的網址與可見畫面截圖</td><td>錄製 Bug 報告與截圖標注</td></tr>
    <tr><td><code>storage</code></td><td>裝置本機設定（登入憑證、語言、麥克風與模式偏好、票券錢包展開狀態）</td><td>保持登入、記住偏好設定</td></tr>
    <tr><td><code>downloads</code></td><td>不額外收集資料</td><td>將報告匯出成 JSON 檔到您的電腦</td></tr>
    <tr><td><code>offscreen</code></td><td>麥克風音訊串流（僅在您開啟麥克風並錄製時）</td><td>背景錄音以進行語音轉文字</td></tr>
    <tr><td>內容指令碼<br><code>&lt;all_urls&gt;</code></td><td>您<b>啟動錄製的分頁</b>之 DOM 變化、Console 訊息、網路請求的失敗狀態（4xx/5xx）</td><td>擴充功能需在任意網站上運作，因此宣告全網域比對。<b>未按下錄製時不會收集或上傳任何頁面內容</b>；僅擷取 Console 錯誤與 4xx/5xx，不記錄成功的請求內容。</td></tr>
  </table>

  <p>除上述權限外，使用本服務時我們另會處理：</p>
  <ul>
    <li><b>Bug 報告內容</b>：Console 訊息、網路錯誤、DOM 操作軌跡（rrweb）、頁面網址與標題、瀏覽器與螢幕資訊、語音錄音與其轉出的文字、截圖、您輸入的補充說明。</li>
    <li><b>終端機記錄</b>（選用，僅在您使用 CLI 工具時）：程式錯誤輸出與執行環境資訊。上傳前會在您的裝置先行遮蔽常見的機密字串（資料庫連線字串、API 金鑰、token、email、手機號碼、身分證字號、信用卡號等）。</li>
    <li><b>使用量統計</b>：錄製次數、回溯次數、MCP AI 讀取次數與 Token 估算，用於免費額度計算。</li>
    <li><b>付款與方案紀錄</b>：綠界訂單編號、付款金額與時間、方案到期日。<b>我們不會接觸或儲存您的信用卡號碼</b>。</li>
    <li><b>活動代碼與票券紀錄</b>：您兌換的代碼、票券狀態與到期日。</li>
    <li><b>問題回報內容</b>（選用）：您在回報表單填寫的內容，以及由 IP 推得的國家代碼。</li>
    <li><b>國家代碼</b>：由 Cloudflare 依連線 IP 推得（例如 <code>TW</code>），用於判斷可否使用金流。<b>我們不儲存您的 IP 位址</b>。</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>3. 我們如何使用這些資料</h2>
  <ul>
    <li>提供 Bug 報告的錄製、儲存、檢視與分享服務。</li>
    <li>語音轉文字（Groq Whisper）與 AI 文字校正／精簡（Cloudflare Workers AI）。</li>
    <li>計算免費額度與管理付費方案。</li>
    <li>透過綠界（ECPay）處理付款。</li>
    <li>將重要事件（新用戶註冊、新報告、代碼兌換、付款成功）以 Discord Webhook 通知開發者，內容包含您的帳號 email。</li>
    <li>我們<b>不會</b>將您的資料用於廣告、不出售資料、也不用於訓練任何 AI 模型。</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>4. 第三方服務</h2>
  <p>我們將資料交由下列服務商處理。點擊可查看其隱私政策。</p>
  <ul>
    <li><b>Cloudflare</b>（Workers／R2／Workers AI）—— API 運算、報告與截圖儲存、AI 文字校正與精簡：<a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener">隱私政策</a></li>
    <li><b>Groq</b>（美國）—— <b>語音轉文字</b>；您的音訊會傳送至 Groq 的 Whisper 服務進行辨識：<a href="https://groq.com/privacy-policy/" target="_blank" rel="noopener">隱私政策</a></li>
    <li><b>Supabase</b> —— 帳號、方案、票券與報告中繼資料的資料庫：<a href="https://supabase.com/privacy" target="_blank" rel="noopener">隱私政策</a></li>
    <li><b>綠界科技 ECPay</b> —— 付款處理（信用卡資料由綠界直接收取，不經過本服務）：<a href="https://www.ecpay.com.tw/Content/files/ecpay_privacy.pdf" target="_blank" rel="noopener">隱私政策</a></li>
    <li><b>Google</b> —— OAuth 登入驗證與帳號基本資料：<a href="https://policies.google.com/privacy" target="_blank" rel="noopener">隱私政策</a></li>
    <li><b>Discord</b> —— 開發者營運通知（含您的帳號 email）：<a href="https://discord.com/privacy" target="_blank" rel="noopener">隱私政策</a></li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>5. 資料儲存、保留與安全</h2>
  <ul>
    <li>所有資料傳輸一律使用 HTTPS 加密。</li>
    <li>報告的大型檔案（DOM 軌跡、截圖）儲存於 Cloudflare R2；帳號與中繼資料儲存於 Supabase（PostgreSQL）。兩者皆於靜態時加密。</li>
    <li>資料庫啟用資料列層級安全性（RLS）並全面拒絕匿名存取，僅由本服務的伺服器以受管金鑰讀寫。</li>
    <li>設定與登入憑證存放於您裝置上的 <code>chrome.storage.local</code>，不會離開您的電腦。</li>
    <li><b>保留期間</b>：免費版報告保留 <span class="hz-mark">7 天</span>，付費版（含使用中活動票券者）保留 <span class="hz-mark">90 天</span>；逾期報告及其附件（DOM 軌跡、語音、截圖）由系統每日自動刪除，刪除後無法復原。您也可以隨時在擴充功能中自行刪除單筆或批次刪除報告。</li>
    <li>保留期間依<b>刪除當下</b>的方案判定。若您從付費降回免費，先前於付費期間產生的報告將改以 7 天標準計算——如需保留，請在降級前自行匯出。</li>
    <li>登入工作階段有效期為 90 天，過期後由系統自動清除。</li>
    <li>移除擴充功能會一併清除所有存放於您裝置上的本機資料。</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>6. 您的權利</h2>
  <ul>
    <li><b>存取與匯出</b>：可在擴充功能中將報告匯出為 JSON 檔。</li>
    <li><b>更正</b>：可在上傳前於編輯頁修改語音文字與補充說明。</li>
    <li><b>刪除</b>：可隨時刪除個別報告；亦可來信要求刪除帳號及所有相關資料。</li>
    <li><b>撤回同意</b>：可在擴充功能中登出，或至 Google 帳戶設定移除本應用程式的授權。</li>
    <li>行使上述權利請聯絡 <a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a> 或 0983-101-085，我們將於 30 天內回應。</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>7. 資料分享</h2>
  <ul>
    <li>我們<b>不會</b>出售您的資料。</li>
    <li>報告清單僅限您本人登入後檢視。</li>
    <li><b>單份報告採「持有連結即可檢視」模式</b>（類似 Google 文件的「知道連結的人」）—— 取得連結者即可開啟，請謹慎分享、避免公開張貼。</li>
    <li>僅在法律要求時，我們才會依法配合揭露資料。</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>8. Cookie 與追蹤</h2>
  <ul>
    <li>我們<b>不使用</b>第三方追蹤 Cookie、廣告像素、Google Analytics 或任何跨站追蹤技術。</li>
    <li>擴充功能使用 <code>chrome.storage.local</code> 保存登入狀態與偏好設定。</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>9. Google API 使用者資料政策（Limited Use）</h2>
  <div class="limited-use">
    BugEzy 對於透過 Google API 取得之資訊的使用與轉移，遵守 <a href="https://developer.chrome.com/docs/webstore/program-policies/limited-use/" target="_blank" rel="noopener">Chrome Web Store 使用者資料政策</a>，包含其中的「有限用途」（Limited Use）要求。
  </div>
  </section>

  <section class="privacy-sec">
  <h2>10. 兒童隱私</h2>
  <ul>
    <li>BugEzy 並非為 13 歲以下兒童設計，我們不會刻意收集兒童的個人資料。</li>
    <li>若您認為兒童向我們提供了個人資料，請來信告知，我們會予以刪除。</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>11. 政策變更</h2>
  <ul>
    <li>本政策若有變更，我們會更新本頁上方的「最後更新」日期。</li>
    <li>重大變更將於官網首頁公告。</li>
  </ul>

  <p>聯絡方式：<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a>　·　0983-101-085</p>
  </section>

`,
    `
  <h1>Privacy Policy</h1>
  <div class="updated">Last updated: August 14, 2026　·　Developer: FOX Chang</div>

  <section class="privacy-sec">
  <h2>1. Contact</h2>
  <ul>
    <li>Developer: FOX Chang</li>
    <li>Email: <a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a></li>
    <li>Phone: +886 983-101-085</li>
    <li>This policy covers the BugEzy Chrome extension and the bugezy.dev website.</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>2. What We Collect</h2>
  <p>The table below maps every permission declared in the extension's <code>manifest.json</code> to the data it accesses and why.</p>
  <table class="perm">
    <tr><th>Permission</th><th>Data accessed</th><th>Why it is needed</th></tr>
    <tr><td><code>identity</code></td><td>Google account email, name and avatar (OAuth scopes: <code>openid</code>, <code>email</code>, <code>profile</code>)</td><td>Sign-in and account identification</td></tr>
    <tr><td><code>activeTab</code></td><td>URL of the active tab and a screenshot of its visible area</td><td>Recording bug reports and screenshot annotation</td></tr>
    <tr><td><code>storage</code></td><td>Local settings on your device (session token, language, microphone and mode preferences, ticket wallet state)</td><td>Keeping you signed in and remembering preferences</td></tr>
    <tr><td><code>downloads</code></td><td>No additional data collected</td><td>Exporting a report as a JSON file to your computer</td></tr>
    <tr><td><code>offscreen</code></td><td>Microphone audio stream (only while you have the microphone enabled and are recording)</td><td>Background audio capture for speech-to-text</td></tr>
    <tr><td>Content scripts<br><code>&lt;all_urls&gt;</code></td><td>DOM changes, console messages and failed network requests (4xx/5xx) on <b>the tab you start recording on</b></td><td>The extension must work on any website, so it declares an all-URLs match. <b>Nothing is collected or uploaded until you press record</b>; only console errors and 4xx/5xx are captured — successful request bodies are not.</td></tr>
  </table>

  <p>In addition to the permissions above, using the service involves:</p>
  <ul>
    <li><b>Bug report contents</b>: console messages, network errors, DOM interaction traces (rrweb), page URL and title, browser and screen information, voice recordings and their transcripts, screenshots, and any notes you type.</li>
    <li><b>Terminal logs</b> (optional, only if you use the CLI tool): program error output and runtime environment details. Common secrets (database URLs, API keys, tokens, emails, phone numbers, national ID numbers, card numbers) are masked <b>on your machine before upload</b>.</li>
    <li><b>Usage counters</b>: recordings, rewinds, MCP AI reads and token estimates, used to enforce free-plan limits.</li>
    <li><b>Payment and plan records</b>: ECPay order number, amount, timestamp and plan expiry. <b>We never see or store your card number.</b></li>
    <li><b>Promo code and ticket records</b>: codes you redeem, ticket status and expiry.</li>
    <li><b>Feedback submissions</b> (optional): what you write in the feedback form, plus a country code derived from your IP.</li>
    <li><b>Country code</b>: derived by Cloudflare from your connection (e.g. <code>TW</code>) to determine payment availability. <b>We do not store your IP address.</b></li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>3. How We Use It</h2>
  <ul>
    <li>To record, store, display and share your bug reports.</li>
    <li>Speech-to-text (Groq Whisper) and AI text correction/summarisation (Cloudflare Workers AI).</li>
    <li>To enforce free-plan limits and manage paid subscriptions.</li>
    <li>To process payments through ECPay.</li>
    <li>To notify the developer of key events (new sign-up, new report, code redemption, successful payment) via a Discord webhook; these notifications include your account email.</li>
    <li>We do <b>not</b> use your data for advertising, do not sell it, and do not use it to train any AI model.</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>4. Third-Party Services</h2>
  <p>We rely on the following processors. Each links to its own privacy policy.</p>
  <ul>
    <li><b>Cloudflare</b> (Workers / R2 / Workers AI) — API compute, report and screenshot storage, AI text correction and summarisation: <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener">privacy policy</a></li>
    <li><b>Groq</b> (United States) — <b>speech-to-text</b>; your audio is sent to Groq's Whisper service for transcription: <a href="https://groq.com/privacy-policy/" target="_blank" rel="noopener">privacy policy</a></li>
    <li><b>Supabase</b> — database for accounts, plans, tickets and report metadata: <a href="https://supabase.com/privacy" target="_blank" rel="noopener">privacy policy</a></li>
    <li><b>ECPay</b> — payment processing (card details are collected by ECPay directly and never pass through our servers): <a href="https://www.ecpay.com.tw/Content/files/ecpay_privacy.pdf" target="_blank" rel="noopener">privacy policy</a></li>
    <li><b>Google</b> — OAuth sign-in and basic account details: <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">privacy policy</a></li>
    <li><b>Discord</b> — operational notifications to the developer (including your account email): <a href="https://discord.com/privacy" target="_blank" rel="noopener">privacy policy</a></li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>5. Storage, Retention and Security</h2>
  <ul>
    <li>All data is transmitted over HTTPS.</li>
    <li>Large report assets (DOM traces, screenshots) are stored in Cloudflare R2; accounts and metadata in Supabase (PostgreSQL). Both are encrypted at rest.</li>
    <li>The database has Row Level Security enabled and denies all anonymous access; only our server can read or write, using a managed key.</li>
    <li>Settings and your session token live in <code>chrome.storage.local</code> on your own device and never leave it.</li>
    <li><b>Retention</b>: reports are kept for <span class="hz-mark">7 days</span> on the free plan and <span class="hz-mark">90 days</span> on paid plans (including users with an active promo ticket). Expired reports and their attachments (DOM traces, voice, screenshots) are deleted automatically by a daily job and cannot be recovered. You can also delete reports individually or in bulk from the extension at any time.</li>
    <li>Retention is evaluated against your plan <b>at the time of deletion</b>. If you downgrade from paid to free, reports created while you were paying will then fall under the 7-day rule — export anything you want to keep before downgrading.</li>
    <li>Sign-in sessions expire after 90 days and are then purged automatically.</li>
    <li>Uninstalling the extension removes all locally stored data from your device.</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>6. Your Rights</h2>
  <ul>
    <li><b>Access &amp; export</b>: export any report as JSON from the extension.</li>
    <li><b>Correction</b>: edit the transcript and notes in the editor before uploading.</li>
    <li><b>Deletion</b>: delete individual reports at any time, or email us to delete your account and all associated data.</li>
    <li><b>Withdraw consent</b>: sign out in the extension, or revoke the app from your Google Account settings.</li>
    <li>To exercise these rights contact <a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a> or +886 983-101-085. We respond within 30 days.</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>7. Data Sharing</h2>
  <ul>
    <li>We do <b>not</b> sell your data.</li>
    <li>Your report list is visible only to you after signing in.</li>
    <li><b>An individual report link is "anyone with the link can view"</b> (similar to Google Docs link sharing) — share it carefully and avoid posting it publicly.</li>
    <li>We disclose data only where required by law.</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>8. Cookies and Tracking</h2>
  <ul>
    <li>We use <b>no</b> third-party tracking cookies, advertising pixels, Google Analytics, or any cross-site tracking.</li>
    <li>The extension uses <code>chrome.storage.local</code> to keep your sign-in state and preferences.</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>9. Google API Services User Data Policy (Limited Use)</h2>
  <div class="limited-use">
    BugEzy's use and transfer of information received from Google APIs adheres to the <a href="https://developer.chrome.com/docs/webstore/program-policies/limited-use/" target="_blank" rel="noopener">Chrome Web Store User Data Policy</a>, including the Limited Use requirements.
  </div>
  </section>

  <section class="privacy-sec">
  <h2>10. Children's Privacy</h2>
  <ul>
    <li>BugEzy is not directed at children under 13, and we do not knowingly collect personal information from them.</li>
    <li>If you believe a child has provided us with personal data, please contact us and we will delete it.</li>
  </ul>
  </section>

  <section class="privacy-sec">
  <h2>11. Changes to This Policy</h2>
  <ul>
    <li>If this policy changes we will update the "Last updated" date at the top of this page.</li>
    <li>Material changes will be announced on the site's home page.</li>
  </ul>

  <p>Contact: <a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a>　·　+886 983-101-085</p>
  </section>

`,
  )}

</div>
${siteFooter(lang)}
</body>
</html>`;
}

// ── PM-66：操作說明頁（新手三步上手 + 六種模式 + MCP 設定 + 小技巧）──
// PM-435：改大黃蜂視覺（米白底 + 白卡），一頁式無 JS、RWD、繁中。
// PM-152：/guide 改為函式（依 lang 中英切換）。
// ── PM-201：AI 客服手冊（SKILL.md）── 給 AI 讀的使用手冊，/skill 檢視 + /skill/download 下載。
// 內容須與專案根目錄 SKILL.md 保持一致（Worker 無檔案系統，故內嵌為字串）。
const SKILL_MD = `# BugEzy — AI 除錯工具使用指南

> 這份文件是給 AI 讀的。當使用者問你關於 BugEzy 的任何問題，請根據以下內容回答。

## 什麼是 BugEzy

BugEzy 是一個 Chrome 擴充工具 + MCP server，讓開發者用語音 + 一鍵錄製 Bug，AI 透過 MCP 直接讀取報告並修復。

**最新版本：v1.1.5（2026-08-09）**

- 官網：https://bugezy.dev
- Chrome Web Store：https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj
- 完整指南（安裝 + 使用 + MCP）：https://bugezy.dev/guide
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
| \`get_timeline\` | 最推薦 — 完整時間軸（Console + Network + 語音 + 環境，一次看完） |
| \`get_console_logs\` | Console error/warn 記錄 |
| \`get_network_errors\` | Network 4xx/5xx 失敗 |
| \`get_screenshots\` | 截圖（高 Token，謹慎使用） |
| \`get_rrweb_events\` | DOM 錄影事件（高 Token，謹慎使用） |
| \`get_rrweb_summary\` | DOM 摘要（輕量） |
| \`get_voice_transcript\` | 語音轉錄文字 |
| \`get_page_info\` | 頁面資訊（URL / 標題 / 瀏覽器 / 解析度） |
| \`get_live_errors\` | 即時監控錯誤（需 session_token） |
| \`get_terminal_logs\` | Terminal CLI 錯誤（需 session_token，付費功能） |
| \`get_usage_stats\` | Token 用量統計（需登入） |
| \`get_usage_quota\` | 方案與本月剩餘用量（需登入；查詢不消耗額度） |

### 建議的讀取順序
1. 先呼叫 \`get_timeline\` — 一次拿到 AI 導航摘要 + 完整時間軸（最省 Token）
2. 如果需要更多細節，再呼叫 \`get_console_logs\` 或 \`get_network_errors\`
3. 截圖和 DOM 錄影 Token 消耗高，最後再用

## 如何教使用者錄製 Bug

當使用者說「程式壞了」但沒有報告時，教他：

1. 點 Chrome 右上角 BugEzy 圖示（紫色 B）
2. 按「錄製」按鈕
3. 操作壞掉的步驟（BugEzy 會自動捕捉 Console 錯誤、Network 失敗、DOM 變化）
4. 邊操作邊用語音描述問題（可選）
5. 按「停止」
6. 在編輯頁補充說明（可選）→ 按「上傳」
7. 跟你說「讀我最新報告」

### 六種錄製模式
| 模式 | 適合場景 |
|---|---|
| 錄製 | 操作流程中的 Bug |
| 回溯 30s | Bug 已經發生了，回溯最近 30 秒 |
| 截圖標注 | 畫面問題（UI 破版、樣式錯誤） |
| 即時監控 | 背景持續監控，有錯誤時通知 |
| Terminal CLI | Python/Node.js 後端錯誤 |
| MCP AI 讀取 | AI 直接透過 MCP 讀取報告 |

## 語音功能與語言

### 支援語言（v1.1.4 起七語全支援）
- 繁體中文（zh-TW）、簡體中文（zh-CN）、粵語（yue-Hant-HK）、English（en-US）、日本語（ja）、한국어（ko）、Tiếng Việt（vi）
- popup 語言下拉可切換；UI、即時字幕、Whisper 辨識、AI 校正/精簡、官網頁面皆隨語言切換

### v1.1.5 新功能

- **免費體驗票券**：輸入活動代碼解鎖付費功能；票券可先儲存、需要時再啟用（啟用前有二次確認，啟用即開始倒數）。
- **安裝碼**：登入後自動取得專屬安裝碼（BZ-XXXX），popup 可一鍵複製，供社群活動驗證身份。
- **官網完整指南**：\`/install\` 已併入 \`/guide\`，安裝 + 使用 + MCP 設定一頁完成，每個設定都有複製按鈕。
- **用戶心得頁**：\`/testimonials\`（影片與文字分享）。

### v1.1.4 語音體驗更新
- **即時字幕 interim**：說話當下底部字幕就即時顯示辨識中的文字（像 YouTube 字幕），說完才轉為確認文字
- **語音面板可拖曳**：右上「語音記錄」面板可用滑鼠拖曳移動，位置會記住
- **粵語 / 越南語自動升級**：這兩語 Chrome 很少送最終結果，改為暫時文字穩定 3 秒即自動收錄，不再漏收語音
- **簡體中文自動繁轉簡**：popup 選簡體中文時，語音辨識結果自動由繁體轉簡體（字幕 / 面板 / 補充說明）
- **截圖語音全面對齊**：截圖標注頁的語音也跟隨 popup 語言、七語提示文字皆已在地化

### 兩種語音引擎
- **即時字幕（Web Speech API）**：免費版，頁面內即時轉字幕，零成本
- **精準轉錄（Groq Whisper）**：付費版，高準確度
  - 中文 / 粵語一律**強制輸出繁體中文**（server 端加 prompt 引導，v1.1.3 修）；簡體中文輸出簡體
  - 粵語即時字幕使用 \`yue-Hant-HK\` BCP-47 語言代碼（v1.1.3 修）

### AI 校正 / AI 精簡（編輯報告頁）
- 停止錄製後的編輯報告頁有「AI 校正」和「AI 精簡」兩個按鈕
- AI 校正：修正語音辨識的錯字、去除口語贅詞，保留原意
- AI 精簡：把語音記錄濃縮成 2-5 個重點
- 英文用戶（popup 切英文）→ AI 用英文 prompt 處理、輸出英文（v1.1.3 修）
- 中文 / 粵語用戶 → 用繁體中文 prompt

### 編輯報告頁多語（v1.1.3 修）
- popup 切英文 → 編輯報告頁 UI 顯示英文、補充說明的語音輸入辨識英文
- popup 切粵語 → UI 顯示中文、語音辨識使用粵語

## 故障排除

### AI 無法讀取報告（MCP 連線問題）
**症狀**：呼叫 \`list_reports\` 回傳「請提供 session_token」

**解法**：
1. 告訴使用者：「請打開 BugEzy popup → 進階設定 → 複製 MCP 設定 → 貼給我」
2. 使用者會貼一段 JSON，裡面有帶 token 的 MCP URL
3. 用這個 URL 重新設定 MCP 連線

### 麥克風無法開啟
**症狀**：錄製時音量條不跳動

**解法**：
1. 確認瀏覽器有授權麥克風（網址列左邊的 圖示 → 麥克風 → 允許）
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
- 在 popup 按「日票」或「月費」升級
- 目前只支援台灣付款（信用卡/ATM/超商），國際付款即將開放

### 截圖有敏感資料
**症狀**：截圖可能拍到密碼、API Key

**說明**：
- BugEzy 會自動偵測頁面上的密碼欄位，截圖後自動馬賽克
- 使用者也可以用 馬賽克筆刷手動塗掉敏感區域
- localStorage/sessionStorage 的敏感值（token、password、API key）會在使用者端自動遮罩，server 永遠不碰原值

### Terminal CLI 使用
**適用**：Python / Node.js / Go 後端錯誤

\`\`\`bash
BUGEZY_TOKEN=<token> npx bugezy-watch -- python manage.py runserver
BUGEZY_TOKEN=<token> npx bugezy-watch -- node server.js
\`\`\`

- Token 從 popup 進階設定的「複製 MCP 設定」取得
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

## 安全與隱私
- Fable5 四輪安全稽核：9.5+/10
- Session token 走 URL fragment，不經 query string（不留在瀏覽器歷史 / Referrer）
- 報告分享閱讀權限：非擁有者需付費會員才能讀他人分享的報告（owner 本人不限）
- CSP + \`frame-ancestors 'none'\`（防點擊劫持）
- Supabase RLS 全 6 表啟用
- PII 自動遮罩：JWT / Bearer / API Key / 手機 / 身分證 / 信用卡

## 定價
| 方案 | 價格 | 內容 |
|---|---|---|
| 免費版 | NT$0 | 錄製 10 次/月 · 回溯 5 次/月 · AI 讀取 20 次/月 · 截圖無限 · 報告保留 7 天 |
| 日票 | NT$20 | 24 小時無限 · Whisper 精準轉錄 · 報告保留 90 天 |
| 月費 | NT$80/月 | 全部無限 · Whisper · Terminal CLI · 報告保留 90 天 |

目前只支援台灣付款。國際付款即將開放。`;

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
function skillPage(lang: PageLang, canonLang: PageLang | null): string {
  const t = makeT(lang); // PM-232：zh/en/zh-CN 三語（zh-CN 由繁體轉簡體）
  const bodyHtml = renderMarkdown(SKILL_MD);
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('AI 客服手冊 · BugEzy', 'AI Support Manual · BugEzy')}</title>
<meta name="description" content="${t('把 BugEzy AI 客服手冊放進你的專案，AI 就會教你怎麼用 BugEzy、幫你讀報告、排除故障。', 'Add the BugEzy AI support manual to your project and your AI will teach you how to use BugEzy, read reports, and troubleshoot.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
${canonicalTag('/skill', canonLang, LANGS_3)}
${hreflangTags('/skill', LANGS_3)}
${ogMeta('/skill', 'AI Customer Service Guide — BugEzy SKILL.md', 'BugEzy MCP tool documentation for AI assistants. 13 tools including get_timeline.')}
${SITE_FONTS}
  <style>${SITE_CHROME_CSS}${SITE_CONTENT_CSS}
  /* PM-435：AI 客服手冊＝白卡 + markdown */
  .wrap { max-width:860px; }
  .actions { display:flex; gap:10px; flex-wrap:wrap; margin:20px 0 8px; }
  .install-box { margin:22px 0 8px; padding:16px 18px; background:#fff; border:2px solid var(--ink); border-radius:12px; font:500 13.5px/1.8 var(--font-ui); }
  .install-box h3 { margin:0 0 8px; font:700 15px/1.4 var(--font-ui); }
  .install-box li { font-size:13.5px; }
  .md { margin-top:28px; padding:24px 26px; background:#fff; border:2px solid var(--ink); border-radius:14px; }
  .md h1 { font:800 24px/1.35 var(--font-ui); margin:22px 0 8px; }
  .md h2 { font:700 20px/1.4 var(--font-ui); margin:26px 0 8px; border-top:2px solid rgba(20,17,11,.14); padding-top:18px; }
  .md h3 { font:700 16px/1.4 var(--font-ui); margin:18px 0 6px; }
  .md p { margin:8px 0; font:500 14px/1.8 var(--font-ui); color:var(--on-y); }
  .md blockquote { margin:10px 0; padding:10px 14px; border:none; border-left:4px solid var(--y);
    background:var(--y-pale); color:var(--on-y); border-radius:0 8px 8px 0; font:500 13.5px/1.8 var(--font-ui); }
  .md hr { border:none; border-top:2px dashed rgba(20,17,11,.24); margin:20px 0; }
  .md-code { margin:10px 0; padding:12px 14px; background:var(--ink); border:none; border-radius:10px; overflow-x:auto; }
  .md-code code { background:transparent; padding:0; color:var(--y-pale); }
  .md-table { width:100%; }
</style>
</head>
<body>
${siteNav(lang, LANGS_3, '')}
<div class="wrap">

 <h1>${t('BugEzy AI 客服手冊', 'BugEzy AI Support Manual')}</h1>
  <p class="lead">${t('把這份文件放到你的專案裡，AI 就會教你怎麼用 BugEzy——讀報告、排除故障、通通自己搞定。', 'Drop this file into your project and your AI will teach you how to use BugEzy — reading reports, troubleshooting, all on its own.')}</p>
  <p class="lead">${t('等於讓你的 AI 當 24 小時 BugEzy 客服。', 'It turns your AI into a 24/7 BugEzy support agent.')}</p>

  <div class="actions">
  <button id="copySkill" class="btn" type="button" data-copy-text="${encodeURIComponent(SKILL_MD)}">${t('複製全文', 'Copy all')}</button>
  <a class="btn secondary" href="/skill/download">${t('下載 SKILL.md', 'Download SKILL.md')}</a>
  </div>

  <div class="install-box">
  <h3>${t('怎麼裝到你的 AI', 'How to install into your AI')}</h3>
    <ol>
      <li>${t('<b>Claude Desktop</b>：Settings（設定）→ Skills → Add（新增）→ 貼上或上傳 SKILL.md', '<b>Claude Desktop</b>: Settings → Skills → Add → paste or upload SKILL.md')}</li>
      <li>${t('<b>Claude Code</b>：把檔案放到 <code>/mnt/skills/user/bugezy/SKILL.md</code>', '<b>Claude Code</b>: place the file at <code>/mnt/skills/user/bugezy/SKILL.md</code>')}</li>
      <li>${t('<b>Cursor / VS Code / 其他 AI</b>：把 SKILL.md 放到專案根目錄，或直接複製全文貼給 AI', '<b>Cursor / VS Code / other AIs</b>: put SKILL.md in your project root, or just paste the full text to your AI')}</li>
    </ol>
    <p class="note" style="margin:10px 0 0;">${t('裝好之後，直接問 AI：「怎麼用 BugEzy？」或「幫我讀最新的 BugEzy 報告」。', 'Once installed, just ask your AI: "How do I use BugEzy?" or "Read my latest BugEzy report."')}</p>
  </div>

  <div class="md">${bodyHtml}</div>

</div>
${siteFooter(lang)}
<script>
(function () {
  var btn = document.getElementById('copySkill');
  if (!btn) return;
 var DONE = ${JSON.stringify(t('已複製！', 'Copied!'))};
 var LABEL = ${JSON.stringify(t('複製全文', 'Copy all'))};
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

// ── PM-279：/guide 一鍵複製按鈕 ────────────────────────────────────────────
// 複製內容存在 data-copy-text（encodeURIComponent），**不從 DOM 讀 textContent**——
// PM-192/199/200 踩過：讀 <pre>/<code> 的 textContent 會受排版縮排與換行影響，複製出來
// 帶一堆空白甚至整段空白。存 attribute 才能讓「顯示」與「複製內容」各自獨立。
const MCP_URL = 'https://bugezy.dev/mcp';
const CWS_URL = 'https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj';
// PM-279：設定不起來時丟給 AI 的萬用提示詞（複製與顯示共用同一份）
const AI_HELP_PROMPT_ZH = `請幫我設定 BugEzy MCP。
BugEzy 是 Chrome 擴充功能的 Bug 報告工具。
MCP 網址：${MCP_URL}
請根據我使用的 AI 工具，告訴我怎麼設定。`;
const AI_HELP_PROMPT_EN = `Help me set up the BugEzy MCP server.
BugEzy is a Chrome extension for reporting bugs.
MCP URL: ${MCP_URL}
Tell me how to configure it for the AI tool I am using.`;
const CLAUDE_CODE_CMD = `claude mcp add --transport http bugezy ${MCP_URL}`;
// 顯示用的 <pre> 與複製內容共用這一份，兩者永遠一致
const CLAUDE_DESKTOP_JSON = `{
  "mcpServers": {
    "bugezy": {
      "url": "${MCP_URL}"
    }
  }
}`;

function copyBtn(text: string, label: string, done: string, isStatic = false): string {
  const a = (v: string) => v.replace(/"/g, '&quot;');
  // PM-280：static = 不讓 token 自動補齊改寫（AI 安裝提示詞維持 server render 的乾淨版本）
  const st = isStatic ? ' data-copy-static="1"' : '';
  return `<button type="button" class="copy-btn"${st} data-copy-text="${encodeURIComponent(text)}" data-copy-label="${a(label)}" data-copy-done="${a(done)}">${label}</button>`;
}

function guidePage(lang: PageLang, canonLang: PageLang | null): string {
  const t = makeT(lang); // PM-232：zh/en/zh-CN 三語（zh-CN 由繁體轉簡體）
  // PM-280：從 /install 併過來的「複製貼給 AI」提示詞（/install 已 301 到本頁）
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

詳細教學：https://bugezy.dev/guide`,
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

Full guide: https://bugezy.dev/guide`,
  );
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('使用指南 · BugEzy', 'User Guide · BugEzy')}</title>
<meta name="description" content="${t('BugEzy 使用指南：安裝登入、六種錄製模式、編輯上傳、讓 AI 透過 MCP 讀報告修 Bug。', 'Learn how to use BugEzy to record bugs, annotate screenshots, and connect with AI via MCP.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
${canonicalTag('/guide', canonLang, LANGS_3)}
${hreflangTags('/guide', LANGS_3)}
${ogMeta('/guide', 'User Guide — BugEzy', 'Step-by-step guide to using BugEzy for bug reporting.')}
${SITE_FONTS}
  <style>${SITE_CHROME_CSS}${SITE_CONTENT_CSS}
  /* PM-435：指南＝白卡步驟 + 黃／咖啡兩種強調框 */
  .step { margin:22px 0 0; padding:20px 22px; background:#fff; border:2px solid var(--ink); border-radius:14px; }
  .step h2 { margin:0 0 10px; }
  .section-title { margin:40px 0 0; padding-bottom:10px; font:800 22px/1.35 var(--font-ui); color:var(--ink); border-bottom:2px solid var(--ink); }
  .ai-prompt-box { margin:0 0 10px; padding:14px 16px; background:var(--ink); border:none; border-radius:10px;
    font:500 13px/1.8 var(--font-mono); color:var(--y-pale); white-space:pre-wrap; word-break:break-word; max-height:320px; overflow:auto; }
  /* §7.2 需要被看見的兩個框：黃底＝快速開始，咖啡底＝求助（§2.3 系統說話） */
  .quick-start { margin:28px 0 0; padding:22px 24px; background:var(--y); border:2px solid var(--ink); border-radius:14px; box-shadow:4px 4px 0 var(--brown-d); }
  .quick-start h2 { margin:0 0 12px; font:800 20px/1.35 var(--font-ui); color:var(--ink); }
  .qs-step { margin:8px 0; font:600 14.5px/1.8 var(--font-ui); color:var(--ink); }
  .qs-step code { background:var(--ink); color:var(--y); }
  .qs-done { margin-top:14px; padding-top:12px; border-top:2px dashed rgba(20,17,11,.4); font:700 14.5px/1.7 var(--font-ui); color:var(--on-y); }
  .ai-help-box { margin:20px 0 0; padding:20px 22px; background:var(--brown); border:none; border-radius:14px; }
  .ai-help-box h3 { margin:0 0 10px; font:700 17px/1.4 var(--font-ui); color:var(--y-pale); }
  .ai-help-box pre { margin:0 0 10px; background:var(--ink); border:none; }
  .ai-help-box .help-note { color:#F0D9A8; }
  .ai-help-box .copy-btn { border-color:var(--y); }
  /* PM-435：指南專屬區塊（六模式／MCP 設定／警告／技巧） */
  .mode { margin:14px 0 0; padding:14px 16px; background:var(--cream); border:2px solid var(--ink); border-radius:12px; }
  .mode .mname { font:700 16px/1.4 var(--font-ui); color:var(--ink); }
  .mode .mrow { margin-top:4px; font:500 14px/1.7 var(--font-ui); color:var(--on-y); }
  .mode .mrow b { color:var(--brown-d); font-weight:700; }
  /* §2.3 提醒／警告是系統在說話 → 咖啡底 */
  .warn-box { margin:18px 0 0; padding:14px 16px; background:var(--brown); border:none; border-radius:12px;
    font:600 13.5px/1.8 var(--font-ui); color:var(--y-pale); }
  .warn-box code { background:var(--ink); color:var(--y); }
  .warn-box a { color:var(--y); text-decoration:underline; }
  .mcp-box { margin:16px 0 0; padding:16px 18px; background:var(--cream); border:2px solid var(--ink); border-radius:12px;
    font:500 13.5px/1.8 var(--font-ui); color:var(--on-y); }
  .mcp-box ol.qs { margin:8px 0 0; padding-left:20px; line-height:1.9; }
  .mcp-box code { background:var(--y-pale); color:var(--brown-d); }
  .mcp-box pre { margin:6px 0 0; }
  .mcp-warn { margin-top:10px; padding:10px 12px; border-radius:9px; background:var(--brown);
    font:600 12.5px/1.7 var(--font-ui); color:var(--y-pale); }
  .mcp-tool { margin-top:12px; }
  .mcp-tool .tname { font:700 13px/1.6 var(--font-mono); color:var(--brown-d); }
  .mcp-tool .tstep { margin-top:2px; font:500 13px/1.7 var(--font-ui); color:var(--on-y); }
  .tips { margin:10px 0 0; }
</style>
</head>
<body>
${siteNav(lang, LANGS_3, 'guide')}
<div class="wrap">

 <h1>${t('BugEzy 完整指南', 'BugEzy Complete Guide')}</h1>
  <p class="lead">${t('從安裝到讓 AI 幫你修 Bug，一頁搞定。', 'From install to letting AI fix your bugs — all on one page.')}</p>
 <div class="mcp-box">${t('完整功能說明 → <a href="/features">功能說明</a>　·　常見問題 → <a href="/faq">FAQ</a>', 'All features → <a href="/features">Features</a>　·　Questions → <a href="/faq">FAQ</a>')}</div>

  <!-- PM-280：最頂部＝最省事的路徑（原 /install 的「複製貼給 AI」）。不懂技術的人到這裡就結束了。 -->
  <div class="step" style="box-shadow:4px 4px 0 var(--y);">
  <h2>${t('最快的方式：複製貼給你的 AI', 'Fastest way: copy & paste to your AI')}</h2>
    <p class="note" style="margin:0 0 10px;">${t('不懂技術？把下面這段複製貼給你的 AI（Claude Desktop / Claude Code / Cursor / Windsurf / VS Code + Cline / Google Antigravity / Gemini CLI），它會幫你搞定。', 'Not technical? Copy the text below to your AI (Claude Desktop / Claude Code / Cursor / Windsurf / VS Code + Cline / Google Antigravity / Gemini CLI) and it will handle it.')}</p>
    <pre class="ai-prompt-box" data-copy-static="1">${escHtml(aiPrompt)}</pre>
  ${copyBtn(aiPrompt, t('一鍵複製，貼給你的 AI', 'Copy & paste to your AI'), t('已複製！', 'Copied!'), true)}
  <p class="help-note">${t('或依下方步驟自己來', 'Or follow the steps below yourself')}</p>
  </div>

 <!-- PM-279：30 秒快速開始（放在第一步之前，讓趕時間的人不用讀完整頁）-->
  <div class="quick-start">
  <h2>${t('30 秒快速開始', 'Quick start in 30 seconds')}</h2>
  <div class="qs-step">1<a href="https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj" target="_blank" rel="noopener">${t('安裝 BugEzy', 'Install BugEzy')}</a></div>
  <div class="qs-step">2${t('點 圖示 → Google 登入', 'Click the icon → sign in with Google')}</div>
  <div class="qs-step">3${t('在你的 AI 工具 MCP 設定貼上：', 'Paste this into your AI tool MCP settings:')} <code>${MCP_URL}</code>${copyBtn(MCP_URL, t('複製', 'Copy'), t('已複製', 'Copied'))}</div>
  <div class="qs-done">${t('然後問 AI：「讀我最新的 BugEzy 報告」', 'Then ask your AI: "Read my latest BugEzy report"')}</div>
  </div>

 <h2 class="section-title">${t('詳細步驟（給新手，一步一步操作）', 'Step-by-step (for first-timers)')}</h2>

  <div class="step">
    <h2>${t('第一步：安裝 Chrome 擴充功能', 'Step 1: Install the Chrome extension')}</h2>
    <ol>
      <li>${t('前往 Chrome Web Store 的 BugEzy 頁面', 'Open the BugEzy page on the Chrome Web Store')}</li>
      <li>${t('點「加到 Chrome」→ 在彈窗按「新增擴充功能」確認', 'Click "Add to Chrome" → confirm "Add extension" in the popup')}</li>
   <li>${t('點瀏覽器右上角拼圖圖示 → 找到 BugEzy → 按釘選', 'Click the puzzle icon at the top right → find BugEzy → click the pin')}</li>
    </ol>
    <a class="cta-btn" href="${CWS_URL}" target="_blank" rel="noopener">${t('前往 Chrome Web Store →', 'Go to Chrome Web Store →')}</a>
    <div class="note">${t('支援 Chrome 以及所有 Chromium 核心瀏覽器（Edge、Brave、Arc 等）。釘選後圖示會常駐工具列，隨時一鍵開錄。', 'Works on Chrome and all Chromium-based browsers (Edge, Brave, Arc, etc.). Pinning keeps the icon on your toolbar for one-click recording.')}</div>
  </div>

  <div class="step">
    <h2>${t('第二步：登入', 'Step 2: Sign in')}</h2>
    <ol>
   <li>${t('點工具列上的 BugEzy 圖示', 'Click the BugEzy icon on the toolbar')}</li>
      <li>${t('按「用 Google 登入」→ 選擇帳號授權', 'Click "Sign in with Google" → choose your account to authorize')}</li>
      <li>${t('popup 顯示你的名字 = 登入成功', 'Your name shown in the popup = signed in')}</li>
    </ol>
  </div>

  <div class="step">
    <h2>${t('第三步：錄下你的第一個 Bug（六種模式任選）', 'Step 3: Capture your first bug (six modes)')}</h2>

    <div class="mode">
   <div class="mname">${t('錄製', 'Record')}</div>
      <div class="mrow"><b>${t('適合：', 'Best for: ')}</b>${t('完整重現 Bug 過程', 'Fully reproducing the bug')}</div>
      <div class="mrow"><b>${t('用法：', 'How: ')}</b>${t('按「錄製」→ 操作網頁重現 Bug → 語音描述問題 → 按「停止」', 'Click "Record" → reproduce on the page → describe by voice → click "Stop"')}</div>
      <div class="mrow"><b>${t('錄到：', 'Captures: ')}</b>${t('DOM 變化 + Console + Network + 語音', 'DOM changes + Console + Network + voice')}</div>
    </div>

    <div class="mode">
   <div class="mname">${t('30 秒回溯', 'Rewind 30s')}</div>
      <div class="mrow"><b>${t('適合：', 'Best for: ')}</b>${t('Bug 已經發生，來不及錄', 'The bug already happened, too late to record')}</div>
      <div class="mrow"><b>${t('用法：', 'How: ')}</b>${t('按「回溯 30s」→ 自動抓回最近 30 秒的操作', 'Click "Rewind 30s" → auto-grabs the last 30 seconds')}</div>
      <div class="mrow">${t('不用提前按錄製，BugEzy 在背景持續記錄', 'No need to start early — BugEzy records in the background')}</div>
    </div>

    <div class="mode">
   <div class="mname">${t('截圖標注', 'Screenshot Annotate')}</div>
      <div class="mrow"><b>${t('適合：', 'Best for: ')}</b>${t('快速指出畫面問題', 'Quickly pointing out an on-screen issue')}</div>
      <div class="mrow"><b>${t('用法：', 'How: ')}</b>${t('按「截圖標注」→ 畫筆/箭頭/框框標出問題 → 加文字說明', 'Click "Screenshot" → pen/arrow/box to mark → add a note')}</div>
      <div class="mrow"><b>${t('三種模式：', 'Three modes: ')}</b>${t('整頁截圖 / 可見範圍 / 自選區域', 'Full page / visible area / custom region')}</div>
    </div>

    <div class="mode">
   <div class="mname">${t('鍵盤模式', 'Keyboard Mode')}</div>
      <div class="mrow"><b>${t('適合：', 'Best for: ')}</b>${t('吵雜環境（咖啡廳、辦公室）', 'Noisy environments (cafés, offices)')}</div>
      <div class="mrow"><b>${t('用法：', 'How: ')}</b>${t('開啟鍵盤模式 → 關閉語音辨識 → 用文字描述 Bug', 'Enable keyboard mode → voice off → type the description')}</div>
    </div>

    <div class="mode">
   <div class="mname">${t('即時監控', 'Live Monitor')}</div>
      <div class="mrow"><b>${t('適合：', 'Best for: ')}</b>${t('掛著等 Bug 自己出現', 'Leaving it on to catch bugs as they appear')}</div>
   <div class="mrow"><b>${t('用法：', 'How: ')}</b>${t('開啟即時監控 → 頁面右下角出現 badge → 有 error 自動變紅 + 顯示數字', 'Enable live monitor → a badge appears bottom-right → turns red with a count on errors')}</div>
      <div class="mrow">${t('點 badge 展開 error 清單', 'Click the badge to expand the error list')}</div>
    </div>

    <div class="mode">
   <div class="mname">${t('終端機', 'Terminal')}</div>
      <div class="mrow"><b>${t('適合：', 'Best for: ')}</b>${t('Server 端的錯誤（Node.js、Python 等）', 'Server-side errors (Node.js, Python, etc.)')}</div>
      <div class="mrow"><b>${t('用法：', 'How: ')}</b>${t('終端機輸入', 'Run in the terminal')} <code>npx bugezy-watch -- npm run dev</code></div>
      <div class="mrow">${t('自動攔截 stderr / throw / crash', 'Auto-captures stderr / throw / crash')}</div>
    </div>
  </div>

  <div class="step">
    <h2>${t('第四步：編輯與上傳', 'Step 4: Edit & upload')}</h2>
    <ol>
      <li>${t('錄製停止後進入編輯頁', 'The editor opens after you stop recording')}</li>
      <li>${t('可以編輯語音文字、加補充說明', 'Edit the voice text and add extra notes')}</li>
   <li>${t('按「AI 校正」修正錯字（選用）', 'Click "AI Correct" to fix typos (optional)')}</li>
   <li>${t('按「AI 精簡」濃縮重點（選用）', 'Click "AI Summarize" to condense (optional)')}</li>
      <li>${t('按「上傳」→ 報告自動儲存到雲端', 'Click "Upload" → the report is saved to the cloud')}</li>
    </ol>
  </div>

  <div class="step">
    <h2>${t('第五步：讓 AI 幫你修', 'Step 5: Let AI fix it')}</h2>
    <p><b style="color:var(--brown-d);">${t('方法一：在 Claude / Cursor / VS Code 直接問', 'Option 1: Ask directly in Claude / Cursor / VS Code')}</b><br />
      ${t('「讀我最新的 BugEzy 報告，告訴我怎麼修」', '"Read my latest BugEzy report and tell me how to fix it"')}<br />
      ${t('AI 透過 MCP 自動讀取報告 → 分析 Console error + Network error → 給出修復建議', 'AI reads the report via MCP → analyzes Console + Network errors → suggests a fix')}</p>
    <p style="margin-top:12px;"><b style="color:var(--brown-d);">${t('方法二：分享報告連結', 'Option 2: Share the report link')}</b><br />
      ${t('上傳後會產生報告連結，傳給同事或貼到 Issue', 'Uploading generates a link — send it to teammates or paste into an issue')}</p>
    <div class="mcp-box">
   <b>${t('MCP 連接設定', 'MCP connection setup')}</b><br />
      ${t('BugEzy MCP 網址（所有工具通用）：', 'BugEzy MCP URL (same for all tools):')}<br />
   <code class="mcp-cfg">${MCP_URL}</code>${copyBtn(MCP_URL, t('複製', 'Copy'), t('已複製', 'Copied'))}
   <div class="mcp-warn">${t('注意：這個網址<b>不能用瀏覽器開</b>，它是專給 AI 工具連接的協議。用瀏覽器開只會看到一段錯誤訊息，屬正常現象——請依下方步驟在 AI 工具裡設定。', 'Note: <b>do not open this URL in a browser</b> — it is a protocol endpoint for AI tools. Opening it in a browser just shows an error, which is normal. Set it up in your AI tool per the steps below.')}</div>

   <div class="mcp-tool"><div class="tname">Claude.ai</div><div class="tstep">${t('Settings → Connectors → Add → 貼上網址 → 連接', 'Settings → Connectors → Add → paste the URL → Connect')}${copyBtn(MCP_URL, t('複製', 'Copy'), t('已複製', 'Copied'))}</div></div>
      <div class="mcp-tool"><div class="tname">Claude Desktop</div><div class="tstep">${t('編輯 claude_desktop_config.json，加入：', 'Edit claude_desktop_config.json, add:')}</div><pre class="mcp-cfg">{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}</pre>${copyBtn(CLAUDE_DESKTOP_JSON, t('複製 JSON', 'Copy JSON'), t('已複製', 'Copied'))}</div>
   <div class="mcp-tool"><div class="tname">Cursor</div><div class="tstep">${t('Settings → MCP → Add Server → 貼上網址', 'Settings → MCP → Add Server → paste the URL')}${copyBtn(MCP_URL, t('複製', 'Copy'), t('已複製', 'Copied'))}</div></div>
   <div class="mcp-tool"><div class="tname">VS Code</div><div class="tstep">${t('Settings → 搜尋 MCP → Add Server → 貼上網址', 'Settings → search MCP → Add Server → paste the URL')}${copyBtn(MCP_URL, t('複製', 'Copy'), t('已複製', 'Copied'))}</div></div>
   <div class="mcp-tool"><div class="tname">${t('Claude Code（終端機）', 'Claude Code (terminal)')}</div><div class="tstep">${t('執行：', 'Run:')} <code class="mcp-cfg">${CLAUDE_CODE_CMD}</code>${copyBtn(CLAUDE_CODE_CMD, t('複製指令', 'Copy command'), t('已複製', 'Copied'))}</div></div>
   <div class="mcp-tool"><div class="tname">Zed</div><div class="tstep">${t('設定檔加 context_servers', 'Add context_servers to the config file')}${copyBtn(MCP_URL, t('複製', 'Copy'), t('已複製', 'Copied'))}</div></div>

      <!-- PM-279：🆘 設定不起來就把提示詞丟給 AI，讓 AI 依使用者實際的工具引導 -->
      <div class="ai-help-box">
        <h3>${t('🆘 搞不定？把這段話丟給你的 AI', '🆘 Stuck? Paste this to your AI')}</h3>
        <pre>${escHtml(t(AI_HELP_PROMPT_ZH, AI_HELP_PROMPT_EN))}</pre>
    ${copyBtn(t(AI_HELP_PROMPT_ZH, AI_HELP_PROMPT_EN), t('複製這段話', 'Copy this prompt'), t('已複製', 'Copied'))}
        <p class="help-note">${t('不管你用 Claude、ChatGPT、Cursor 還是 VS Code，AI 都能根據這段話引導你完成設定。', 'Whether you use Claude, ChatGPT, Cursor or VS Code, your AI can walk you through the setup from this prompt.')}</p>
      </div>

      <div style="margin-top:14px;font-size:13px;color:var(--on-y);">${t('連接成功後，直接問 AI：', 'Once connected, just ask your AI:')}<br /><b style="color:var(--brown-d);">${t('「讀我最新的 BugEzy 報告，告訴我怎麼修」', '"Read my latest BugEzy report and tell me how to fix it"')}</b><br />${t('AI 就會透過 MCP 自動讀取你的 Bug 報告。', 'The AI will read your bug report automatically via MCP.')}</div>
    </div>
  </div>

  <div class="step">
  <h2>${t('領 MCP30：30 天免費體驗', 'Claim MCP30: 30 days free')}</h2>
    <div class="mcp-box">
      <p>${t('MCP 接好之後，輸入代碼 <b>MCP30</b> 就能領 30 天完整功能體驗（可與 BUG10 疊加，共 40 天）。', 'Once MCP is connected, enter the code <b>MCP30</b> for 30 days of full access (stacks with BUG10 for 40 days total).')}</p>
      <ol class="qs">
        <li>${t('照上面的步驟把 MCP 網址加進你的 AI 工具', 'Add the MCP URL to your AI tool as described above')}</li>
        <li>${t('跟 AI 說「讀我最新的 BugEzy 報告」——<b>要真的成功呼叫一次</b>', 'Ask your AI to "read my latest BugEzy report" — it must actually succeed once')}</li>
        <li>${t('打開 BugEzy 擴充功能 → 活動代碼欄位輸入 <b>MCP30</b>', 'Open the BugEzy extension → enter <b>MCP30</b> in the promo code field')}</li>
      </ol>

      <div class="warn-box">
    <b>${t('最常見的卡關：MCP 網址少了 ?token=', 'The most common blocker: the MCP URL is missing ?token=')}</b><br />
        ${t('BugEzy 要能認出「這次呼叫是誰打的」，才算你完成對接。認人的依據就是網址結尾的 <code>?token=…</code>。', 'BugEzy has to know <em>who</em> made the call to count it as connected — and that comes from the <code>?token=…</code> at the end of the URL.')}<br />
        ${t('如果你複製到的網址是 <code>https://bugezy.dev/mcp</code>（後面沒有東西），那 AI 讀得到報告、但這次呼叫<b>不會算在你頭上</b>，MCP30 就會一直說「請先完成 MCP 對接」。', 'If the URL you copied is just <code>https://bugezy.dev/mcp</code> with nothing after it, your AI can still read reports — but the call <b>will not be attributed to you</b>, and MCP30 will keep saying "please connect MCP first".')}<br /><br />
    <b>${t('怎麼確認：', 'How to check:')}</b>${t('本頁上方那幾個網址，在你登入後會自動補上 token。如果沒有補上，請先點一次 ', 'The URLs above are auto-filled with your token once you are signed in. If they are not, first open ')}<a href="/reports">${t('我的報告', 'My Reports')}</a>${t('（那一步會把登入狀態帶到本站），再回到這頁複製一次。', ' (that step carries your sign-in over to this site), then come back here and copy again.')}<br />
        ${t('或者直接從擴充功能 → 進階設定 → MCP 網址複製，那份一定帶 token。', 'Or copy it straight from the extension → Advanced settings → MCP URL, which always includes the token.')}
      </div>
    </div>

  <h2>${t('常見問題', 'FAQ')}</h2>
    <div class="mcp-box">
      <p><b>${t('Q：輸入 MCP30 顯示「請先完成 MCP 對接」？', 'Q: MCP30 says "please complete MCP setup first"?')}</b><br />
      ${t('A：代表 BugEzy 沒有看到任何屬於你的 MCP 呼叫紀錄。九成是網址少了 <code>?token=</code>（見上方警告）。補上之後，請 AI 再讀一次報告，然後重新輸入代碼。', 'A: BugEzy sees no MCP calls attributed to your account. Nine times out of ten the URL is missing <code>?token=</code> (see the warning above). Fix it, ask your AI to read a report again, then re-enter the code.')}</p>
      <p><b>${t('Q：顯示「目前無法驗證 MCP 使用紀錄」？', 'Q: It says "cannot verify MCP usage right now"?')}</b><br />
      ${t('A：這是我們這邊的問題，不是你的設定。請稍後再試或來信告訴我們。', 'A: That one is on our side, not your setup. Please try again later or email us.')}</p>
      <p><b>${t('Q：設定後 AI 說找不到 BugEzy？', 'Q: My AI says it cannot find BugEzy after setup?')}</b><br />
      ${t('A：確認網址完整（含 https://）、重新連線一次。Claude 需要在 Settings → Connectors 看到 BugEzy 呈現已連接狀態。', 'A: Check the URL is complete (including https://) and reconnect. In Claude, BugEzy should show as connected under Settings → Connectors.')}</p>
      <p><b>${t('Q：Gemini 支援嗎？', 'Q: Is Gemini supported?')}</b><br />
      ${t('A：Gemini 目前還沒有開放通用的 MCP 連接器，等官方支援後我們會第一時間更新這頁。', 'A: Gemini does not yet expose a general MCP connector. We will update this page as soon as it does.')}</p>
    </div>

  <h2>${t('小技巧', 'Tips')}</h2>
    <ul class="tips">
      <li>${t('錄製時對著麥克風說「這個按鈕按下去沒反應」比打字快 10 倍', 'Saying "this button does nothing when clicked" by voice is 10× faster than typing')}</li>
      <li>${t('即時監控可以掛一整天，有 error 才通知你', 'Live monitor can run all day and only alerts you on errors')}</li>
      <li>${t('免費版每月可錄 10 次，截圖和即時監控無限用', 'Free plan: 10 recordings/mo; screenshots and live monitor are unlimited')}</li>
      <li>${t('用 BugEzy MCP 讀報告比截圖貼給 AI 省 95% Token', 'Reading reports via BugEzy MCP saves 95% tokens vs pasting screenshots to AI')}</li>
    </ul>
  </div>

</div>
${siteFooter(lang)}
<script>
// PM-280（承接 PM-190/191，原本在 /install）：已登入 → 把本頁所有 MCP 設定/網址（.mcp-cfg）
//   的 bugezy.dev/mcp 自動補上 ?token=<session token>，AI 端就零操作能讀報告。
//  token 來自同源 localStorage（PM-187 存於 bugezy.dev；開「我的報告」即 seed）。
//  連同複製按鈕的 data-copy-text 一起改寫——否則畫面顯示帶 token、複製到的卻沒有，
//     使用者會以為設定好了卻仍需手動帶 token。
(function () {
  try {
    var token = localStorage.getItem('bugezy_session_token');
    if (!token) return;
    var enc = encodeURIComponent(token);
    var RE = /(bugezy\\.dev\\/mcp)(?!\\?|[\\w])/g;
    document.querySelectorAll('.mcp-cfg').forEach(function (el) {
      if (el.getAttribute('data-copy-static')) return; // AI 提示詞維持乾淨版（同 PM-192 的決定）
      el.textContent = el.textContent.replace(RE, '$1?token=' + enc);
    });
    document.querySelectorAll('[data-copy-text]').forEach(function (btn) {
      if (btn.getAttribute('data-copy-static')) return;
      try {
        var txt = decodeURIComponent(btn.getAttribute('data-copy-text') || '');
        btn.setAttribute('data-copy-text', encodeURIComponent(txt.replace(RE, '$1?token=' + enc)));
      } catch (e) {}
    });
  } catch (e) {}
})();
// PM-279：一鍵複製（事件委派，內容一律從 data-copy-text 讀，不碰 DOM 排版文字）
(function () {
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;background:transparent;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { ta.setSelectionRange(0, text.length); } catch (e) {}
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-copy-text]') : null;
    if (!btn) return;
    var text = decodeURIComponent(btn.getAttribute('data-copy-text') || '');
    if (!text) return;
    function flash() {
      btn.textContent = btn.getAttribute('data-copy-done') || 'OK';
      btn.classList.add('copied');
      setTimeout(function () {
        btn.textContent = btn.getAttribute('data-copy-label') || '';
        btn.classList.remove('copied');
      }, 1500);
    }
    // clipboard API 在部分情境（非安全來源、權限拒絕）會失敗 → 退回 execCommand
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash, function () { fallbackCopy(text); flash(); });
    } else { fallbackCopy(text); flash(); }
  });
})();
</script>
</body>
</html>`;
}

// ── PM-66：FAQ 頁（四大類問答，手風琴點擊展開/收合，單一展開）──
// PM-152：/faq 改為函式（依 lang 中英切換）。英文版禁止提及任何競品名稱（延續 PM-130 去競品）。
function faqPage(lang: PageLang, canonLang: PageLang | null): string {
  const t = makeT(lang); // PM-232：zh/en/zh-CN 三語（zh-CN 由繁體轉簡體）
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
<html lang="${htmlLang(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('常見問題 · BugEzy', 'FAQ · BugEzy')}</title>
<meta name="description" content="${t('BugEzy 常見問題：安裝、錄製、語音辨識、MCP 設定、付費方案等問答。', 'Frequently asked questions about BugEzy — pricing, AI tool support, data security, and more.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
${canonicalTag('/faq', canonLang, LANGS_6)}
${hreflangTags('/faq', LANGS_6)}
${ogMeta('/faq', 'FAQ — BugEzy', 'Frequently asked questions about BugEzy.')}
${jsonLd(faqLd)}
${SITE_FONTS}
  <style>${SITE_CHROME_CSS}${SITE_CONTENT_CSS}
  /* PM-435：FAQ 手風琴（設計稿畫面 29）。收合＝白卡 + 向右三角；展開＝黃底 header + 向下三角。
   標題與內容是兄弟節點（不是包在一起），所以展開態靠 .faq-q.open + .faq-a 接。 */
  .wrap { max-width:760px; }
  h2 { margin:34px 0 12px; }
  .faq-q { display:flex; align-items:center; gap:12px; margin-bottom:8px; padding:14px 16px;
    background:#fff; border:2px solid rgba(20,17,11,.35); border-radius:12px;
    font:700 15px/1.4 var(--font-ui); color:var(--ink); cursor:pointer; }
  .faq-q:hover { border-color:var(--ink); }
  .faq-q.open { margin-bottom:0; background:var(--y); border-color:var(--ink); border-bottom:none; border-radius:12px 12px 0 0; }
 /* §6 三角形是 CSS 邊框做的，不是 字元 */
  .faq-q::after { content:''; flex-shrink:0; width:0; height:0;
    border-left:6px solid var(--ink); border-top:5px solid transparent; border-bottom:5px solid transparent; }
  .faq-q.open::after { border-left:5px solid transparent; border-right:5px solid transparent;
    border-top:6px solid var(--ink); border-bottom:none; }
  .faq-a { max-height:0; overflow:hidden; transition:max-height .3s; padding:0 16px;
    font:500 13.5px/1.85 var(--font-ui); color:var(--on-y); }
  .faq-q.open + .faq-a { margin-bottom:8px; background:#fff; border:2px solid var(--ink);
    border-top:none; border-radius:0 0 12px 12px; }
  .faq-a p { margin:14px 0; }
</style>
</head>
<body>
${siteNav(lang, LANGS_6, 'faq')}
<div class="wrap">

 <h1>${t('BugEzy 常見問題', 'BugEzy FAQ')}</h1>

 <h2>${t('關於產品', 'About the product')}</h2>
  <div class="faq-q">${t('BugEzy 是什麼？', 'What is BugEzy?')}</div>
  <div class="faq-a"><p>${t('BugEzy 是一款 Chrome 擴充功能，讓開發者用語音 + 錄製的方式記錄 Bug，AI 透過 MCP 自動讀取報告並提供修復建議。省下 95% 的 debug 溝通時間。', 'BugEzy is a Chrome extension that lets developers capture bugs by voice + recording. AI reads the report automatically via MCP and suggests fixes — saving 95% of debugging communication time.')}</p></div>

  <div class="faq-q">${t('BugEzy 最大的優勢是什麼？', 'What makes BugEzy special?')}</div>
  <div class="faq-a"><p>${t('專為亞洲開發者設計：中文/粵語/日韓語音支援、NT$80 超平價月費、MCP 整合讓 AI 直接讀報告。獨家功能：即時監控、30 秒回溯、Whisper 精準語音、終端機 CLI、Token 透明度。', 'Built for Asian developers: Chinese / Cantonese / Japanese / Korean voice support, an affordable NT$80/mo plan, and MCP integration so AI reads reports directly. Signature features: live monitor, 30-second rewind, Whisper precise voice, terminal CLI, and token transparency.')}</p></div>

  <div class="faq-q">${t('支援哪些 AI 工具？', 'Which AI tools are supported?')}</div>
  <div class="faq-a"><p>${t('任何支援 MCP 的 AI 工具都能用，包括 Claude Desktop、Claude Code、Cursor、VS Code + Copilot、Zed、Windsurf、Codex、Replit 等。只需要一行 URL：', 'Any MCP-capable AI tool works, including Claude Desktop, Claude Code, Cursor, VS Code, Zed, Windsurf, Google Antigravity, Gemini CLI, and more. Just one URL:')}<code>https://bugezy.dev/mcp</code></p></div>

 <h2>${t('關於隱私與安全', 'Privacy & security')}</h2>
  <div class="faq-q">${t('BugEzy 會錄到我的密碼嗎？', 'Will BugEzy record my passwords?')}</div>
  <div class="faq-a"><p>${t('BugEzy 錄製的是 DOM 結構變化，不是螢幕截圖。密碼輸入框（type="password"）的內容會被 rrweb 自動遮蔽，不會錄到實際密碼。', 'BugEzy records DOM structure changes, not screen video. Password fields (type="password") are automatically masked by rrweb, so actual passwords are never captured.')}</p></div>

  <div class="faq-q">${t('我的報告誰能看到？', 'Who can see my reports?')}</div>
  <div class="faq-a"><p>${t('報告連結採用隨機加密 ID（UUID），無法被猜測或搜尋，只有擁有連結的人才能查看報告內容。若你將連結分享給同事或 AI 工具，他們就能查看；未分享的報告連結不會出現在任何公開列表中。建議不要把報告連結貼在公開場合（如公開 issue、論壇），避免非預期的存取。', 'Each report has a random encrypted ID (UUID) that cannot be guessed or searched — only people with the report link can view its content. If you share the link with colleagues or AI tools, they can access the report; unshared report links never appear in any public listing. Tip: avoid posting report links in public places (issues, forums) to prevent unintended access.')}</p></div>

  <div class="faq-q">${t('資料存在哪裡？', 'Where is my data stored?')}</div>
  <div class="faq-a"><p>${t('報告存在 Cloudflare R2（全球 CDN），使用者資料存在 Supabase（PostgreSQL）。所有傳輸都經過 HTTPS 加密。', 'Reports are stored on Cloudflare R2 (global CDN); user data on Supabase (PostgreSQL). All transfers are encrypted over HTTPS.')}</p></div>

 <h2>${t('關於方案與付費', 'Plans & billing')}</h2>
  <div class="faq-q">${t('免費版有什麼限制？', 'What are the free plan limits?')}</div>
  <div class="faq-a"><p>${t('免費版每月可錄製 10 次、回溯 5 次、MCP AI 讀取 20 次。截圖標注和即時監控無限使用。報告保留 7 天。', 'The free plan includes 10 recordings, 5 rewinds, and 20 MCP AI reads per month. Screenshot annotation and live monitor are unlimited. Reports are kept for 7 days.')}</p></div>

  <div class="faq-q">${t('付費版多少錢？', 'How much is Premium?')}</div>
  <div class="faq-a"><p>${t('NT$80/月（約 $3 USD），解鎖全功能無限次使用，報告保留 90 天，加上終端機 CLI、Whisper 精準語音等進階功能。', 'NT$80/mo (about US$3) unlocks unlimited use of all features, 90-day report retention, plus advanced features like terminal CLI and Whisper precise voice.')}</p></div>

  <div class="faq-q">${t('如何升級付費版？', 'How to upgrade to Premium?')}</div>
  <div class="faq-a"><p>${t('在 BugEzy popup 點「升級」按鈕，透過信用卡或 ATM 付款。', 'Click "Upgrade" in the BugEzy popup and pay by credit card or ATM.')}</p></div>

  <div class="faq-q">${t('可以取消訂閱嗎？', 'Can I cancel my subscription?')}</div>
  <div class="faq-a"><p>${t('可以，隨時取消。取消後當月剩餘天數仍可使用付費功能，下個月恢復為免費版。', 'Yes, anytime. After cancelling you keep premium features for the rest of the billing period, then revert to the free plan.')}</p></div>

 <h2>${t('關於技術', 'Technical')}</h2>
  <div class="faq-q">${t('哪些瀏覽器支援？', 'Which browsers are supported?')}</div>
  <div class="faq-a"><p>${t('目前支援 Chrome 和所有 Chromium 瀏覽器（Edge、Brave、Arc 等）。', 'Chrome and all Chromium-based browsers (Edge, Brave, Arc, etc.).')}</p></div>

  <div class="faq-q">${t('會影響網頁效能嗎？', 'Does it affect page performance?')}</div>
  <div class="faq-a"><p>${t('影響極小。BugEzy 只在你主動錄製時才記錄 DOM 變化，即時監控模式只攔截 Console error 和 Network error，不錄 DOM。', 'Minimal. BugEzy only records DOM changes while you are actively recording; live monitor mode only captures Console and Network errors, not the DOM.')}</p></div>

  <div class="faq-q">${t('MCP 是什麼？', 'What is MCP?')}</div>
  <div class="faq-a"><p>${t('Model Context Protocol（模型上下文協議），是 Anthropic 推出的開放標準，讓 AI 工具可以連接外部服務。BugEzy 的 MCP 讓 AI 直接讀取你的 Bug 報告，不需要複製貼上。', 'Model Context Protocol — an open standard from Anthropic that lets AI tools connect to external services. BugEzy MCP lets AI read your bug reports directly, with no copy-paste.')}</p></div>

  <div class="faq-q">${t('Token 是什麼？為什麼 BugEzy 能省 Token？', 'What are tokens, and how does BugEzy save them?')}</div>
  <div class="faq-a"><p>${t('Token 是 AI 處理文字的計量單位，等於你的 AI 使用費用。BugEzy 用結構化文字（而非截圖）傳送報告給 AI，同樣的 Bug 資訊只需要 1/20 的 Token。每次 MCP AI 讀取都會顯示 Token 估算，讓你看到省了多少。', 'Tokens are the unit AI uses to process text — effectively your AI cost. BugEzy sends reports as structured text (not screenshots), so the same bug info takes 1/20 the tokens. Every MCP AI read shows a token estimate so you can see the savings.')}</p></div>

</div>
${siteFooter(lang)}
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
// PM-280：installPage 已移除——內容併入 guidePage，/install 改 301 導向 /guide。


// ── PM-96：功能說明頁（GET /features）— 六種模式 + 語音 + 高畫質 AI 的操作說明 ──
// PM-151：/features 改為函式（依 lang 中英切換，延續 PM-150 模式）。
function featuresPage(lang: PageLang, canonLang: PageLang | null): string {
  const t = makeT(lang); // PM-232：zh/en/zh-CN 三語（zh-CN 由繁體轉簡體）
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('BugEzy 功能 — 六種錄製模式、Whisper 語音、即時監控', 'BugEzy Features — Six Recording Modes, Whisper Voice, Live Monitor')}</title>
<meta name="description" content="${t('BugEzy 六種除錯模式：錄製、回溯 30 秒、截圖標注、即時監控、終端機 CLI、MCP AI 讀取。Whisper 精準語音轉錄。', 'BugEzy offers six debugging modes: Record, Rewind, Screenshot, Live Monitor, Terminal CLI, and MCP AI. Whisper voice transcription for premium users.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
${canonicalTag('/features', canonLang, LANGS_6)}
${hreflangTags('/features', LANGS_6)}
${ogMeta('/features', 'Features — BugEzy', 'Voice recording, DOM replay, console capture, network errors, MCP integration, and more.')}
${SITE_FONTS}
  <style>${SITE_CHROME_CSS}${SITE_CONTENT_CSS}
  /* PM-435：功能頁＝白卡 + 六角格 */
  .feat { margin:22px 0 0; padding:20px 22px; background:#fff; border:2px solid var(--ink); border-radius:14px; }
  .feat.paid { box-shadow:4px 4px 0 var(--y); }
  .feat h2 { margin:0 0 10px; font:700 19px/1.4 var(--font-ui); }
  .feat .row { margin:5px 0; font:500 14px/1.8 var(--font-ui); color:var(--on-y); }
  .feat .row b { color:var(--brown-d); font-weight:700; }
  /* §7.4 形狀分級：免費＝描邊、付費＝實心 */
  .tag { display:inline-block; margin-left:8px; padding:2px 9px; border-radius:999px;
    font:700 11px/1.6 var(--font-ui); vertical-align:middle; }
  .tag.free { background:transparent; border:1.5px solid var(--ink); color:var(--ink); }
  .tag.pro { background:var(--ink); border:1.5px solid var(--ink); color:var(--y); }
  .mode-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-top:6px; }
  .mode-card { padding:16px; background:var(--cream); border:2px solid var(--ink); border-radius:12px; }
  .mode-card .mi { display:block; width:11px; height:13px; background:var(--y); clip-path:var(--hex); }
  .mode-card .mn { margin:8px 0 4px; font:700 14.5px/1.4 var(--font-ui); color:var(--ink); }
  .mode-card .md { font:500 13px/1.7 var(--font-ui); color:var(--on-y-2); }
  .clist { margin:6px 0 0; }
  .badges2 { display:flex; flex-wrap:wrap; gap:9px; margin-top:8px; }
  .badge2 { padding:7px 15px; border-radius:999px; background:var(--y); color:var(--ink); font:700 13px/1 var(--font-ui); }
  .badge2.soon { background:transparent; border:1.5px solid rgba(20,17,11,.45); color:var(--on-y-2); }
  .plan3 { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-top:6px; }
  .wf-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-top:6px; }
  .wf-card { padding:18px; background:var(--cream); border:2px solid var(--ink); border-radius:12px; }
  .wf-card h3 { margin:0 0 8px; font:700 16px/1.4 var(--font-ui); }
  .wf-card p { margin:0; font:500 13px/1.7 var(--font-ui); color:var(--on-y-2); }
  .wf-config { margin-top:16px; padding:16px 18px; background:var(--brown); border:none; border-radius:12px; }
  .wf-config .wc-title { margin:0 0 8px; font:700 14px/1.4 var(--font-ui); color:var(--y-pale); }
  .wf-config pre { margin:0; background:var(--ink); }
  .wf-config .wc-note { margin:10px 0 0; font:600 12px/1.7 var(--font-ui); color:#F0D9A8; }
  .bottom-cta { margin-top:36px; text-align:center; }
  @media (max-width:640px) { .mode-grid, .plan3, .wf-grid { grid-template-columns:1fr; } }
  /* PM-435：功能頁專屬（工具列／定價三欄） */
  .tool { margin:7px 0; font:500 14px/1.8 var(--font-ui); color:var(--on-y); }
  .plan3 .pc { padding:18px; background:var(--cream); border:2px solid var(--ink); border-radius:12px; text-align:center; }
  /* §2.2 主推方案反黑 */
  .plan3 .pc.hl { background:var(--ink); box-shadow:4px 4px 0 var(--brown); }
  .plan3 .pn { font:700 14px/1.5 var(--font-ui); color:var(--on-y-2); }
  .plan3 .pp { margin:6px 0; font:800 24px/1 var(--font-brand); color:var(--ink); }
  .plan3 .pd { font:600 12px/1.6 var(--font-ui); color:var(--on-y-2); }
  .plan3 .pc.hl .pn { color:var(--on-dark-2); }
  .plan3 .pc.hl .pp { color:var(--y); }
  .plan3 .pc.hl .pd { color:var(--y-pale); }
</style>
</head>
<body>
${siteNav(lang, LANGS_6, 'features')}
<div class="wrap">

  <h1>${t('BugEzy 完整功能介紹', 'BugEzy — Full Feature Overview')}</h1>
  <p class="lead">${t('給進階開發者、AI 助手、技術評估者的完整產品規格', 'Complete product specs for developers, AI assistants, and technical evaluators')}</p>

  <div class="feat">
  <h2>${t('六種錄製模式', 'Six Recording Modes')}</h2>
    <div class="mode-grid">
      <div class="mode-card"><span class="mi"></span><div class="mn">${t('錄製', 'Record')}</div><div class="md">${t('DOM 軌跡 + Console + Network + 語音', 'DOM trace + Console + Network + voice')}</div></div>
      <div class="mode-card"><span class="mi"></span><div class="mn">${t('回溯 30 秒', 'Rewind 30s')}</div><div class="md">${t('Bug 已發生？一鍵抓回最近 30 秒', 'Already happened? Grab the last 30s')}</div></div>
      <div class="mode-card"><span class="mi"></span><div class="mn">${t('截圖標注', 'Screenshot')}</div><div class="md">${t('全頁/區域/自由 + 馬賽克筆刷', 'Full/region/freehand + mosaic brush')}</div></div>
      <div class="mode-card"><span class="mi"></span><div class="mn">${t('鍵盤模式', 'Keyboard')}</div><div class="md">${t('吵雜環境純文字，不錄語音', 'Text-only for noisy places')}</div></div>
      <div class="mode-card"><span class="mi"></span><div class="mn">${t('即時監控', 'Live Monitor')}</div><div class="md">${t('背景持續監控，有錯自動通知', 'Background monitor, alerts on errors')}</div></div>
      <div class="mode-card"><span class="mi"></span><div class="mn">${t('Terminal CLI', 'Terminal CLI')}</div><div class="md">${t('Python/Node 後端錯誤攔截', 'Python/Node backend error capture')}</div></div>
    </div>
  </div>

  <div class="feat">
  <h2>${t('Bug 捕捉能力（10/10）', 'Bug Capture (10/10)')}</h2>
    <ul class="clist">
      <li>${t('Console — error / warn / unhandledrejection', 'Console — error / warn / unhandledrejection')}</li>
      <li>${t('Network — 4xx / 5xx / timeout / CORS', 'Network — 4xx / 5xx / timeout / CORS')}</li>
      <li>${t('資源載入失敗 — img / script / css / 字型 404', 'Resource errors — img / script / css / font 404')}</li>
      <li>${t('Web Vitals — CLS / FID / LCP 超標警告', 'Web Vitals — CLS / FID / LCP threshold alerts')}</li>
      <li>${t('DOM 軌跡 — rrweb 錄製 + 回放', 'DOM trace — rrweb record + replay')}</li>
      <li>${t('Storage 快照 — localStorage / sessionStorage / Cookie（PII 自動遮罩）', 'Storage snapshot — localStorage / sessionStorage / Cookie (PII auto-masked)')}</li>
      <li>${t('語音記錄 — 即時字幕 + Whisper 精準轉錄', 'Voice — live captions + Whisper transcription')}</li>
      <li>${t('截圖 — 敏感欄位自動馬賽克', 'Screenshot — sensitive fields auto-mosaic')}</li>
    </ul>
  </div>

  <div class="feat">
  <h2>${t('MCP 整合（13 Tools）', 'MCP Integration (13 Tools)')}</h2>
    <div class="tool"><code>get_report_overview</code> — ${t('報告概覽 + AI Bug 導航摘要', 'Report overview + AI bug navigator')}</div>
  <div class="tool"><code>get_timeline</code> — ${t('完整時間軸（Console/Network/語音/環境一次看完）', 'Full timeline in one call')}</div>
    <div class="tool"><code>get_console_logs</code> — ${t('Console error/warn 記錄', 'Console error/warn records')}</div>
    <div class="tool"><code>get_network_errors</code> — ${t('Network 4xx/5xx 失敗', 'Network 4xx/5xx failures')}</div>
    <div class="tool"><code>get_voice_transcript</code> — ${t('語音轉錄文字', 'Voice transcript text')}</div>
    <div class="tool"><code>get_screenshots</code> — ${t('截圖（高 Token）', 'Screenshots (high token)')}</div>
    <div class="tool"><code>get_rrweb_summary</code> — ${t('DOM 摘要（輕量）', 'DOM summary (lightweight)')}</div>
    <div class="tool"><code>get_rrweb_events</code> — ${t('DOM 錄影事件（高 Token）', 'DOM replay events (high token)')}</div>
    <div class="tool"><code>get_page_info</code> — ${t('頁面資訊', 'Page info')}</div>
    <div class="tool"><code>get_metadata</code> — ${t('報告 metadata', 'Report metadata')}</div>
    <div class="tool"><code>list_reports</code> — ${t('列出報告（需 session_token）', 'List reports (needs session_token)')}</div>
    <div class="tool"><code>get_live_errors</code> — ${t('即時監控錯誤（需 session_token）', 'Live monitor errors (needs session_token)')}</div>
    <div class="tool"><code>get_terminal_logs</code> — ${t('Terminal CLI 錯誤（付費）', 'Terminal CLI errors (premium)')}</div>
    <div class="row" style="margin-top:12px;"><b>${t('MCP 連接：', 'MCP endpoint: ')}</b><code>https://bugezy.dev/mcp</code></div>
  </div>

  <div class="feat">
  <h2>${t('語音引擎', 'Voice Engine')}</h2>
    <div class="row"><b>${t('即時字幕：', 'Live captions: ')}</b>${t('Web Speech API（免費版）', 'Web Speech API (free)')}</div>
    <div class="row"><b>${t('精準轉錄：', 'Precise: ')}</b>${t('Groq Whisper（付費版）', 'Groq Whisper (premium)')}</div>
    <div class="row"><b>${t('AI 校正 + 精簡：', 'AI correct + summarize: ')}</b>${t('自動修錯字、濃縮重點', 'Auto-fix typos, condense key points')}</div>
    <div class="row" style="margin-top:10px;"><b>${t('支援語言：', 'Languages: ')}</b></div>
    <div>
      <span class="badge2 active">${t('繁體中文', 'Chinese')}</span>
      <span class="badge2 active">${t('簡體中文', 'Simplified Chinese')}</span>
      <span class="badge2 active">${t('粵語', 'Cantonese')}</span>
      <span class="badge2 active">English</span>
      <span class="badge2 active">日本語</span>
      <span class="badge2 active">한국어</span>
      <span class="badge2 active">Tiếng Việt</span>
    </div>
  </div>

  <div class="feat">
  <h2>${t('Python / Node CLI', 'Python / Node CLI')}</h2>
    <div class="row"><b>${t('安裝：', 'Install: ')}</b><code>npm install -g bugezy-watch</code></div>
    <div class="row"><b>${t('結構化解析：', 'Structured parse: ')}</b>${t('Python traceback + Node.js 錯誤 → type / message / file / line', 'Python traceback + Node.js errors → type / message / file / line')}</div>
    <div class="row"><b>${t('環境快照：', 'Env snapshot: ')}</b>${t('語言 / 版本 / OS / 套件', 'language / version / OS / packages')}</div>
    <div class="row"><b>${t('PII 遮罩：', 'PII masking: ')}</b>${t('DB URI / API Key / JWT / 密碼 自動遮罩', 'DB URI / API Key / JWT / passwords auto-masked')}</div>
  </div>

  <div class="feat">
  <h2>${t('安全與隱私', 'Security & Privacy')}</h2>
    <ul class="clist">
      <li>${t('Fable5 四輪稽核 9.5+/10', 'Fable5 four-round audit 9.5+/10')}</li>
      <li>${t('Supabase RLS 全表啟用', 'Supabase RLS enabled on all tables')}</li>
      <li>${t('CSP + frame-ancestors 防點擊劫持', 'CSP + frame-ancestors (clickjacking protection)')}</li>
      <li>${t('PII 自動遮罩 — JWT / Bearer / 手機 / 身分證 / 信用卡', 'PII auto-masking — JWT / Bearer / phone / national ID / credit card')}</li>
      <li>${t('Session token 走 URL fragment，不經 query string', 'Session token via URL fragment, never in query string')}</li>
    </ul>
  </div>

  <div class="feat">
  <h2>${t('MCP 工作流 — 錄一次，所有 AI 都能讀', 'MCP Workflows — Record Once, Every AI Can Read')}</h2>
    <div class="wf-grid">
      <div class="wf-card">
    <h3>${t('一個 AI 搞定', 'Single Agent')}</h3>
        <p>${t('用 Claude Desktop、Cursor 或 Windsurf，連上 BugEzy MCP，直接讀報告修 Bug。一個 AI 從頭做到尾。', 'Connect Claude Desktop, Cursor, or Windsurf to BugEzy MCP. One AI reads the report and fixes the bug end-to-end.')}</p>
      </div>
      <div class="wf-card">
    <h3>${t('兩個 AI 分工', 'Dual Agent')}</h3>
        <p>${t('Claude Chat 讀報告做分析和策略規劃，Claude Code 讀同一份報告寫修復程式碼。PM 和工程師各司其職，讀的是同一份 Bug 報告。', 'Claude Chat reads the report for analysis and planning. Claude Code reads the same report to write the fix. PM and engineer roles, same bug report.')}</p>
      </div>
      <div class="wf-card">
    <h3>${t('多工具同步', 'Multi-Tool Sync')}</h3>
        <p>${t('Zed、Cursor、Claude Desktop 同時連線 BugEzy MCP，都讀同一份報告。團隊成員用不同工具，看到的是同一份 Bug 資料。', 'Zed, Cursor, Claude Desktop — all connected to BugEzy MCP at the same time, all reading the same report. Different tools, same bug data.')}</p>
      </div>
    </div>
    <div class="wf-config">
      <p class="wc-title">${t('一行連線，任何 MCP 工具都能用', 'One line to connect, works with any MCP client')}</p>
      <pre>{
  "mcpServers": {
    "bugezy": {
      "url": "https://bugezy.dev/mcp"
    }
  }
}</pre>
      <p class="wc-note">${t('支援 Claude Desktop · Claude Code · Cursor · Windsurf · Zed · 任何 MCP 相容工具', 'Works with Claude Desktop · Claude Code · Cursor · Windsurf · Zed · Any MCP-compatible client')}</p>
    </div>
  </div>

  <div class="feat">
  <h2>${t('定價', 'Pricing')}</h2>
    <div class="plan3">
      <div class="pc"><div class="pn">${t('免費', 'Free')}</div><div class="pp">NT$0</div><div class="pd">${t('每月 10 錄製 / 5 回溯 / 20 MCP', '10 rec / 5 rewind / 20 MCP per mo')}</div></div>
      <div class="pc hl"><div class="pn">${t('月費', 'Monthly')}</div><div class="pp">NT$80<span style="font-size:13px;color:#888;">${t(' /月', ' /mo')}</span></div><div class="pd">${t('全功能無限', 'All unlimited')}</div></div>
      <div class="pc"><div class="pn">${t('日票', 'Day Pass')}</div><div class="pp">NT$20<span style="font-size:13px;color:#888;">/24h</span></div><div class="pd">${t('24 小時無限', '24h unlimited')}</div></div>
    </div>
  </div>

  <div class="bottom-cta">
    <p style="font-size:18px;color:#fff;margin-bottom:14px;">${t('準備好了？', 'Ready to try?')}</p>
  <a class="cta-btn" href="https://chromewebstore.google.com/detail/bugezy/hfnkjlbbpehkflgfbjenfmnmjkdjadcj" target="_blank" rel="noopener">${t('免費安裝', 'Install Free')}</a>
    <a class="cta-btn ghost" href="/">${t('回首頁', 'Home')}</a>
  </div>

</div>
${siteFooter(lang)}
</body>
</html>`;
}

// ── PM-256：/blog SEO 文章架構（列表頁 + 單篇頁 + Article JSON-LD）──────────────
// 文章資料集中在 BLOG_POSTS，新增一篇只要加一筆（slug/date/title/description/blocks）。
// PM-256 先建空架構——內容為佔位文字，實際內文由 PM-257 提供。
interface BlogPost {
  slug: string;
  date: string; // YYYY-MM-DD（發佈日，供排序 + JSON-LD datePublished）
  title: string;
  description: string;
  blocks: Array<{ h2: string } | { p: string }>; // 小標題 / 段落（段落支援 **粗體**）
}
const BLOG_POSTS: BlogPost[] = [
  {
    slug: 'vibe-coding-debug-trap',
    date: '2026-07-20',
    title: 'Vibe Coding 的隱藏成本：為什麼你的 Bug 越修越多？',
    description: '用 AI 寫程式很快，但 Bug 出現時截圖貼了好幾次，AI 越修越錯？問題不在你，在於你給 AI 的資訊不夠完整。',
    blocks: [
      { h2: '用 AI 寫程式，30 分鐘搞定一個網站' },
      { p: '你用 ChatGPT 或 Cursor 描述需求，AI 幫你生出整套程式碼。購物車、後台管理、會員系統——以前要花幾週的東西，現在一個下午就有雛形。這就是 Vibe Coding 的魅力，讓不會寫程式的人也能打造自己的產品。' },
      { h2: '然後 Bug 出現了' },
      { p: '畫面跑版、按鈕按了沒反應、資料存不進去。你看著螢幕上的紅字，完全不知道它在說什麼。沒關係，你把畫面截圖，貼給 AI，跟它說「這裡壞了，幫我修」。' },
      { p: 'AI 回你一段新的程式碼，你貼上去，重新整理頁面——另一個地方又壞了。' },
      { h2: '截圖 Debug 的惡性循環' },
      { p: '你再截一張圖，再解釋一次，AI 再給你一段 code。但這次它修的方向跟上次矛盾，你的程式開始出現連鎖錯誤。一個 Bug 變三個，三個變十個，整個專案越修越歪。' },
      { p: '這不是你的錯。**問題在於截圖只拍到表面**。AI 看到的是一張「畫面壞了」的圖片，但它真正需要的是——Console 裡的錯誤訊息、Network 請求的狀態碼、DOM 的實際結構。這些你在截圖裡都沒給它。' },
      { h2: 'AI 不是不會修，是你給的線索不夠' },
      { p: '想像你去看醫生，只說「我不舒服」，但不讓醫生量體溫、聽心跳、驗血。醫生只能猜，猜錯了開錯藥，你的狀況就越來越糟。Debug 也是一樣的道理。' },
      { p: '當你把**完整的錯誤資訊**（Console log、Network 失敗的 API、報錯的程式碼行數）一次丟給 AI，它的修復準確率會大幅提升。不是一張截圖，而是一份完整的診斷報告。' },
      { h2: '用對工具，一次給齊' },
      { p: 'BugEzy 做的就是這件事：你按一下錄製，用嘴巴講「這個按鈕按了沒反應」，它會自動在背景蒐集 Console 錯誤、Network 請求、DOM 變化，打包成一份完整的 Bug 報告。你不需要看懂那些技術細節，AI 看得懂就夠了。' },
      { p: '下次 Bug 出現時，不要再截圖貼來貼去了。一次給齊，讓 AI 一次修對。' },
    ],
  },
  {
    slug: 'ai-coding-debug-cost',
    date: '2026-07-20',
    title: 'AI 寫程式很快，Debug 卻花了 3 倍時間？問題出在這裡',
    description: '非工程背景用 AI 開發網站和應用，寫完很快但 Debug 花了大把時間和 AI 額度。這篇告訴你問題出在哪，怎麼解決。',
    blocks: [
      { h2: '寫 Code 一小時，Debug 三小時' },
      { p: '你用 AI 助手建了一個網路商店，前端畫面、商品列表、結帳流程——AI 幫你產生的程式碼又快又整齊。但上線測試的時候，結帳按鈕沒反應、商品圖片顯示不出來、手機版整個跑版。' },
      { p: '你開始 Debug。截圖、打字說明、貼給 AI、等回覆、複製新 code、貼上、測試、又壞了。重複這個循環十幾次，三小時過去了，問題還在。' },
      { h2: '你的 AI 額度就是這樣燒掉的' },
      { p: '每次你貼截圖加一大段說明文字給 AI，就是在消耗對話額度。免費版的 ChatGPT、Claude、Gemini 都有使用上限，**截圖張數越多、說明文字越長，額度燒得越快**。' },
      { p: '有些人一個下午就把額度用完了，然後要等好幾個小時才能回來繼續。等的時候你什麼都做不了，Bug 還在那邊等你。這個等待的時間成本，Vibe Coder 很少算進去。' },
      { h2: '為什麼截圖 Debug 效率這麼低？' },
      { p: '因為截圖只拍到「症狀」，沒有拍到「病因」。你貼了一張「按鈕按了沒反應」的截圖，但 AI 看不到 Console 裡噴了什麼錯誤、Network 是不是 API 回傳了 500、JavaScript 是不是根本沒載入成功。' },
      { p: '所以 AI 只能用猜的。它猜的修法如果剛好對了，你運氣好。猜錯了，就是越修越遠，額度也越燒越多。' },
      { h2: '一次給齊，省時間也省額度' },
      { p: '如果你能**把 Console 錯誤、Network 狀態、你的操作步驟一次打包丟給 AI**，它就不用猜了。一次看完所有線索，一次修對的機率大幅提升。' },
      { p: 'BugEzy 就是設計來做這件事的。你按錄製，用嘴巴描述問題，它在背景自動蒐集所有技術資訊。一份報告取代十張截圖，AI 一看就懂，修一次就對。額度只花一輪，不用來回十幾次。' },
      { p: '把省下來的額度拿去開發新功能，不是更好嗎？' },
    ],
  },
  {
    slug: 'stop-screenshot-debugging',
    date: '2026-07-20',
    title: '別再用截圖 Debug 了——你正在浪費你的 AI 額度',
    description: '每次截圖加說明就燒一輪 AI 對話額度，免費版幾次就沒了。用對工具一次給齊，省額度省時間。',
    blocks: [
      { h2: '截圖 Debug 的真實成本' },
      { p: '你大概算過蓋一個網站要花多少時間，但你有算過 Debug 燒掉多少 AI 額度嗎？' },
      { p: '假設一個 Bug 你平均要截 3 張圖、打 200 字說明、來回對話 5 次才修好。每次對話消耗的 token 大約是純文字的 3-5 倍（因為圖片很吃額度）。**一個 Bug 就可能吃掉你每日免費額度的三分之一。**' },
      { p: '一天遇到三個 Bug，額度就燒完了。然後你只能等，等好幾個小時額度恢復，再回來繼續修。' },
      { h2: '不是 AI 不夠聰明，是你餵的資料不夠' },
      { p: '你有沒有這種經驗——貼了截圖，AI 回你「請問可以提供 Console 的錯誤訊息嗎？」或是「你可以開 DevTools 的 Network 面板看一下嗎？」' },
      { p: 'AI 在跟你要的，就是那些截圖裡看不到的東西。**Console 錯誤、Network 請求的 response、你操作的步驟順序**——這些才是 Debug 的關鍵線索。' },
      { h2: '自動蒐集 vs 手動截圖' },
      { p: '手動的做法是：打開 DevTools → 找到 Console 面板 → 截圖 → 切到 Network 面板 → 截圖 → 把所有圖片加上文字說明 → 貼給 AI。光這個過程就要花 5-10 分鐘，而且你可能漏掉關鍵資訊。' },
      { p: '自動的做法是：按一個按鈕，所有資訊在背景自動蒐集好。你只需要用嘴巴講「這個按鈕按了沒反應」，其他的交給工具。' },
      { h2: '把額度花在刀口上' },
      { p: 'Debug 不應該是你花最多時間和額度的地方。用對工具，把完整資訊一次給 AI，讓它一次修對。省下來的額度和時間，拿去做更有價值的事。' },
      { p: 'BugEzy 自動蒐集 Console、Network、DOM 狀態，打包成一份報告。一次對話就能解決的事，不需要來回十幾次。免費開始，到 bugezy.dev 試試看。' },
    ],
  },
  {
    slug: 'beginner-debug-no-console',
    date: '2026-07-20',
    title: '程式新手除錯第一步：你不需要看懂 Console 錯誤',
    description: '看不懂 Console 的紅字沒關係，AI 看得懂。關鍵是怎麼把完整的錯誤資訊餵給 AI，讓它幫你修。',
    blocks: [
      { h2: 'Console 那堆紅字到底是什麼？' },
      { p: '你打開瀏覽器的開發者工具，看到 Console 面板一片紅——TypeError、ReferenceError、404、CORS⋯⋯這些字看起來像外星文，而且每一行後面都跟著一堆你完全看不懂的檔案路徑和行號。' },
      { p: '如果你是非工程背景的 Vibe Coder，這個畫面大概會讓你想直接關掉。但先別走，因為你其實**不需要看懂這些東西**。' },
      { h2: '你不需要當翻譯，AI 會讀' },
      { p: '那些紅字是寫給機器和工程師看的，但現在 AI 也看得懂。ChatGPT、Claude、Gemini 都能解讀 Console 錯誤訊息，告訴你「這行 code 有問題、應該改成這樣」。' },
      { p: '問題是：**你要怎麼把這些紅字完整地丟給 AI？** 截圖只能拍到畫面上看得見的部分。如果錯誤訊息很長、需要往下滾動，一張截圖根本截不完。而且圖片裡的文字 AI 不一定能精確讀取，尤其是程式碼和堆疊追蹤。' },
      { h2: '複製貼上？你可能漏掉關鍵資訊' },
      { p: '有人會手動複製 Console 的文字貼給 AI，這比截圖好一些。但問題是，Console 只是線索的一部分。很多 Bug 的根源在 Network（API 回傳錯誤）、DOM（元素沒有被正確渲染）、或是操作順序（你按了 A 才壞，按 B 就不會）。' },
      { p: '如果你只給 Console 錯誤，AI 可能修得了表面症狀，但根本原因還在。過幾分鐘，另一個 Bug 就冒出來了。' },
      { h2: '讓工具幫你蒐集，你只要描述問題' },
      { p: '最理想的 Debug 流程是這樣的：你描述問題（「結帳按鈕按了沒反應」），工具在背景自動蒐集 Console 錯誤、Network 請求、DOM 狀態、你的操作步驟，然後打包成一份 AI 看得懂的完整報告。' },
      { p: '你不需要看懂任何一行紅字。你只需要知道問題在哪裡，然後把報告丟給 AI。它會告訴你怎麼修。' },
      { p: 'BugEzy 就是做這件事的工具。按一下錄製，用嘴巴講就好，技術細節它會自動處理。不懂程式也能高效 Debug。到 bugezy.dev 免費試用。' },
    ],
  },
  {
    slug: 'why-ai-needs-more-info',
    date: '2026-07-20',
    title: '為什麼 AI 助手老是說「請提供更多資訊」？',
    description: '你貼了截圖問 AI 怎麼修 Bug，它卻一直要你提供更多資訊？因為截圖只有表面，AI 需要完整的錯誤脈絡才能幫你。',
    blocks: [
      { h2: '你問 AI，AI 反問你' },
      { p: '你遇到 Bug 了，趕快截圖貼給 ChatGPT：「這個頁面壞了，怎麼修？」AI 的回覆卻是：「請問你可以提供 Console 的錯誤訊息嗎？」「Network 面板有沒有失敗的請求？」「你是在什麼操作步驟之後出現這個問題的？」' },
      { p: '你心想，我就是不知道這些東西才來問你啊。' },
      { h2: 'AI 不是在刁難你' },
      { p: '其實 AI 跟醫生一樣，需要足夠的診斷資訊才能下判斷。你貼一張「畫面壞了」的截圖，就像走進診間說「我不舒服」——醫生看得出你不舒服，但不知道是頭痛、肚子痛、還是骨折。' },
      { p: '**一張截圖能提供的資訊量大概只有完整 Debug 報告的 10%。** 另外 90% 藏在你看不到的地方：Console 的錯誤堆疊、Network 面板裡失敗的 API 請求、DOM 裡沒有被正確渲染的元素。' },
      { h2: '為什麼完整資訊這麼重要？' },
      { p: "舉個真實例子。你的購物車「加入」按鈕按了沒反應。截圖看起來就是一個按鈕在那邊，沒有任何異狀。但如果你打開 Console，會看到一行紅字：「TypeError: Cannot read property 'push' of undefined」。打開 Network，會看到一個 POST 請求回傳了 401 Unauthorized。" },
      { p: '有了這兩條線索，AI 馬上知道：第一，購物車陣列沒有被正確初始化；第二，使用者的登入 token 過期了。**兩分鐘就能修好的問題，沒有這些線索的話 AI 可能要猜三四次才猜到。**' },
      { h2: '不想手動蒐集？讓工具代勞' },
      { p: '你不需要學會操作 DevTools，也不需要知道 Console 和 Network 在哪裡。有工具可以在你回報 Bug 的同時，自動蒐集這些 AI 需要的資訊。' },
      { p: 'BugEzy 就是這樣的工具。你按錄製，用嘴巴講「加入購物車按鈕沒反應」，它會自動抓取 Console 錯誤、Network 失敗請求、DOM 狀態、你的操作軌跡，打包成一份完整報告。你只要把報告丟給 AI，它一看就懂，不會再問你「請提供更多資訊」了。' },
      { p: '省掉來回問答的時間和額度，直接解決問題。到 bugezy.dev 免費開始。' },
    ],
  },
];

/** PM-256：文章文字 HTML 轉義（作者可控內容，仍防 < 破版）。 */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** PM-256：段落渲染——先 esc 再把 **粗體** 轉 <strong>。 */
function renderBlogPara(s: string): string {
  return escHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
// 共用深色主題（與 /changelog 等頁一致）。
const BLOG_CSS = `
  ${SITE_CONTENT_CSS}
  /* PM-436：部落格（設計稿畫面 30 區塊庫 B） */
  .wrap { max-width:720px; }
  h1 { font:800 30px/1.3 var(--font-ui); margin:16px 0 8px; }
  /* §7.2 列表卡：白卡 + 黃色硬投影，整張可點 */
  .post-list { list-style:none; margin:24px 0 0; padding:0; }
  .post-item { margin:0 0 16px; padding:20px 22px; background:#fff; border:2px solid var(--ink);
    border-radius:14px; box-shadow:4px 4px 0 var(--y); }
  .post-item::before { content:none; }
  .post-item h2 { margin:6px 0 0; font:800 20px/1.45 var(--font-ui); }
  .post-item h2 a { color:var(--ink); text-decoration:none; font-weight:800; }
  .post-item h2 a:hover { color:var(--brown-d); }
  .post-date { font:600 11.5px/1 var(--font-mono); color:var(--on-y-2); }
  .post-desc { margin:8px 0 0; font:500 13.5px/1.8 var(--font-ui); color:var(--on-y); }
  .post-more { margin:2px 0 0; font:700 13px/1 var(--font-ui); color:var(--on-y); }
  /* 內文：h2 靠黃色直線帶出層級，不用底線也不用色塊 */
  article h2 { margin:32px 0 10px; padding-left:13px; border-left:5px solid var(--y);
    font:800 18px/1.45 var(--font-ui); color:var(--ink); }
  article p { margin:14px 0; font:400 14.5px/2 var(--font-ui); color:var(--ink); }
  /* 內文的 **粗體** ＝ 黃色螢光筆（跟隱私頁同一套） */
  article strong { font-weight:700; background:var(--y); padding:1px 5px; border-radius:3px; }
  .post-meta { margin:4px 0 24px; font:600 12px/1.6 var(--font-mono); color:var(--on-y-2); }
  .cta-box { margin:40px 0 0; padding:24px; background:var(--ink); border:2px solid var(--ink);
    border-radius:14px; text-align:center; color:var(--y-pale); }
  .cta-box a { display:inline-block; margin-top:10px; padding:12px 26px; border:2px solid var(--y);
    border-radius:11px; background:var(--y); color:var(--ink); font:700 14px/1 var(--font-ui); text-decoration:none; }
  .cta-box a:hover { background:var(--y-deep); border-color:var(--y-deep); text-decoration:none; }
  .post-nav { display:flex; justify-content:space-between; gap:16px; margin:36px 0 0; font:600 13.5px/1.6 var(--font-ui); }
  .post-nav a { max-width:45%; }
`;

function blogListPage(lang: PageLang, canonLang: PageLang | null): string {
  const t = makeT(lang);
  const items = [...BLOG_POSTS]
    .sort((a, b) => b.date.localeCompare(a.date)) // 日期新→舊；同日期由 stable sort 保留陣列順序
    .map(
      // PM-436：日期在標題上方（設計稿順序）。設計稿標題旁邊還有一顆分類膠囊，
      //   但 BlogPost 沒有分類欄位，不編一個出來 —— 見 DONE-436。
      (p) => `      <li class="post-item">
        <div class="post-date">${p.date}</div>
        <h2><a href="/blog/${p.slug}">${escHtml(p.title)}</a></h2>
        <p class="post-desc">${escHtml(p.description)}</p>
        <p class="post-more">${t('閱讀全文 →', 'Read more →')}</p>
      </li>`,
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('BugEzy 部落格 — 除錯、Vibe Coding 與 AI 開發', 'BugEzy Blog — Debugging, Vibe Coding & AI Development')}</title>
<meta name="description" content="${t('關於除錯、Vibe Coding、AI 寫程式的實用文章。BugEzy 讓你用說的就能回報 Bug。', 'Practical articles on debugging, vibe coding, and AI development. BugEzy lets you report bugs by talking.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
${canonicalTag('/blog', canonLang, LANGS_ZH)}
${hreflangTags('/blog', LANGS_ZH)}
${ogMeta('/blog', 'BugEzy Blog — Debugging & AI Development', 'Practical articles on debugging, vibe coding, and AI development.')}
${SITE_FONTS}
  <style>${SITE_CHROME_CSS}${BLOG_CSS}</style>
</head>
<body>
${siteNav(lang, LANGS_ZH, 'blog')}
<div class="wrap">
  <h1>${t('部落格', 'Blog')}</h1>
  <p class="lead">${t('除錯、Vibe Coding、AI 開發的實用文章。', 'Practical takes on debugging, vibe coding, and AI development.')}</p>
  <ul class="post-list">
${items}
  </ul>
</div>
${siteFooter(lang)}
</body>
</html>`;
}

function blogPostPage(post: BlogPost, lang: PageLang, canonLang: PageLang | null): string {
  const t = makeT(lang);
  const idx = BLOG_POSTS.findIndex((p) => p.slug === post.slug);
  const prev = idx > 0 ? BLOG_POSTS[idx - 1] : null; // 陣列前一篇（較新）
  const next = idx < BLOG_POSTS.length - 1 ? BLOG_POSTS[idx + 1] : null; // 陣列後一篇（較舊）
  const bodyHtml = post.blocks
    .map((b) => ('h2' in b ? `  <h2>${escHtml(b.h2)}</h2>` : `  <p>${renderBlogPara(b.p)}</p>`))
    .join('\n');
  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    dateModified: post.date,
    author: { '@type': 'Organization', name: 'BugEzy', url: 'https://bugezy.dev' },
    publisher: {
      '@type': 'Organization',
      name: 'BugEzy',
      url: 'https://bugezy.dev',
      logo: { '@type': 'ImageObject', url: 'https://bugezy.dev/icon-128.png' },
    },
    mainEntityOfPage: `https://bugezy.dev/blog/${post.slug}`,
  };
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtml(post.title)} · BugEzy</title>
<meta name="description" content="${post.description.replace(/"/g, '&quot;')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
${canonicalTag(`/blog/${post.slug}`, canonLang, LANGS_ZH)}
${hreflangTags(`/blog/${post.slug}`, LANGS_ZH)}
${ogMeta(`/blog/${post.slug}`, post.title, post.description)}
${jsonLd(articleLd)}
${SITE_FONTS}
  <style>${SITE_CHROME_CSS}${BLOG_CSS}</style>
</head>
<body>
${siteNav(lang, LANGS_ZH, 'blog')}
<div class="wrap">
  <p><a href="/blog">${t('← 返回部落格', '← Back to blog')}</a></p>
  <article>
    <h1>${escHtml(post.title)}</h1>
    <div class="post-meta">${post.date}</div>
${bodyHtml}
  </article>
  <div class="cta-box">
    <div>${t('用說的就能回報 Bug，讓 AI 幫你修。', 'Report bugs by talking — let AI fix them.')}</div>
    <a href="/">${t('BugEzy — 免費開始 · bugezy.dev', 'BugEzy — Start free · bugezy.dev')}</a>
  </div>
  <nav class="post-nav">
    <span>${prev ? `<a href="/blog/${prev.slug}">← ${escHtml(prev.title)}</a>` : ''}</span>
    <span>${next ? `<a href="/blog/${next.slug}">${escHtml(next.title)} →</a>` : ''}</span>
  </nav>
</div>
${siteFooter(lang)}
</body>
</html>`;
}

// ── PM-272：用戶心得頁（GET /testimonials）——文字引言 + YouTube 影片，資料手動維護 ──
interface Testimonial {
  name: string;
  /** 引言。zh 為繁體原文；zh-CN 由 makeT 自動繁轉簡，ja/ko/vi 無對照表 → 回退英文。 */
  text: { zh: string; en: string };
  /** YouTube 連結（watch / youtu.be / shorts / embed 皆可）；純文字心得填 null。 */
  videoUrl: string | null;
}

// FOX 日後在此新增。有影片的範例：
//   { name: '王小明', text: { zh: '…', en: '…' }, videoUrl: 'https://youtu.be/dQw4w9WgXcQ' },
const TESTIMONIALS: Testimonial[] = [
  {
    name: 'BugEzy 團隊',
    text: {
      zh: '歡迎分享你的 debug 體驗！拍一段影片或寫幾句心得，讓其他開發者知道 BugEzy 幫你省下了多少時間。',
      en: 'Share your debug experience! Record a video or write a few lines, and let other developers know how much time BugEzy saved you.',
    },
    videoUrl: null,
  },
];

/**
 * PM-272：YouTube 連結 → 16:9 響應式嵌入（youtube-nocookie 保護隱私）。
 * 取不到 11 碼 video ID 就回空字串（該則心得只顯示文字，不會壞版）。
 */
function youtubeEmbed(url: string): string {
  // 涵蓋 watch?v= / youtu.be/ / shorts/ / embed/ 四種常見形式（FOX 可能直接貼手機分享的 shorts 連結）
  const id = url.match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([a-zA-Z0-9_-]{11})/)?.[1];
  if (!id) return '';
  return `      <div class="t-video">
        <iframe src="https://www.youtube-nocookie.com/embed/${id}" title="BugEzy testimonial"
          loading="lazy" allow="accelerometer;clipboard-write;encrypted-media;gyroscope;picture-in-picture"
          allowfullscreen></iframe>
      </div>`;
}

const TESTIMONIALS_CSS = `
  /* PM-436：用戶心得引言卡（設計稿畫面 30）。§2.2 反黑：整頁米白，只有引言卡是黑的。 */
  .t-item { margin:0 0 20px; padding:20px 22px; background:var(--ink); border:none; border-radius:14px; }
  .t-item::before { content:none; }
  .t-video { position:relative; padding-bottom:56.25%; height:0; overflow:hidden; border-radius:12px; margin-bottom:18px; background:#000; }
  .t-video iframe { position:absolute; top:0; left:0; width:100%; height:100%; border:0; }
  .t-quote { margin:0; padding:0; font:500 15px/1.9 var(--font-ui); color:var(--y-pale); }
  .t-foot { display:flex; align-items:center; gap:11px; margin:13px 0 0; padding-top:11px; border-top:1px solid #3A3122; }
  /* §5 六角頭像：取名字首字，不放頭像圖 */
  .t-ava { width:32px; height:37px; flex-shrink:0; background:var(--y); clip-path:var(--hex);
    display:flex; align-items:center; justify-content:center; font:800 14px/1 var(--font-brand); color:var(--ink); }
  .t-name { margin:0; font:700 13px/1.5 var(--font-ui); color:var(--y); }
  .cta-feedback { margin:40px 0 0; padding:24px; background:var(--y); border:2px solid var(--ink);
    border-radius:14px; box-shadow:4px 4px 0 var(--brown-d); }
  .cta-feedback h3 { margin:0 0 14px; font:800 20px/1.35 var(--font-ui); color:var(--ink); }
  .cta-feedback ul { margin:0 0 14px; }
  .cta-feedback li { color:var(--on-y); }
  .cta-feedback li::before { background:var(--ink); }
  .cta-feedback .reward { font-weight:700; background:var(--ink); color:var(--y); padding:1px 6px; border-radius:3px; }
  .cta-feedback .note { margin:0; font:600 13px/1.7 var(--font-ui); color:var(--on-y-2); }
`;

function testimonialsPage(lang: PageLang, canonLang: PageLang | null): string {
  const t = makeT(lang);
  const items = TESTIMONIALS.map((item) => {
    const video = item.videoUrl ? youtubeEmbed(item.videoUrl) + '\n' : '';
    // PM-436：六角頭像取名字首字。設計稿頭像下面還有一行職稱／使用時間，
    //   但 Testimonial 只有 name/text/videoUrl，沒有那個欄位 —— 見 DONE-436。
    const initial = escHtml([...item.name][0] || 'B');
    return `    <li class="t-item">
${video}      <p class="t-quote">${escHtml(t(item.text.zh, item.text.en))}</p>
      <div class="t-foot"><span class="t-ava">${initial}</span><p class="t-name">${escHtml(item.name)}</p></div>
    </li>`;
  }).join('\n');
  const title = t('用戶心得 — 開發者怎麼用 BugEzy', 'Testimonials — How Developers Use BugEzy');
  const desc = t(
    '真實開發者分享用 BugEzy 回報 Bug 的體驗，含影片與文字心得。',
    'Real developers share their experience reporting bugs with BugEzy — videos and written reviews.',
  );
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · BugEzy</title>
<meta name="description" content="${desc}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
${canonicalTag('/testimonials', canonLang, LANGS_3)}
${hreflangTags('/testimonials', LANGS_3)}
${ogMeta('/testimonials', 'BugEzy Testimonials', 'Real developers share how BugEzy speeds up their debugging.')}
${SITE_FONTS}
  <style>${SITE_CHROME_CSS}${BLOG_CSS}${TESTIMONIALS_CSS}</style>
</head>
<body>
${siteNav(lang, LANGS_3, '')}
<div class="wrap">
  <h1>${t('用戶心得', 'Testimonials')}</h1>
  <p class="lead">${t('看看其他開發者怎麼用 BugEzy 回報 Bug。', 'See how other developers report bugs with BugEzy.')}</p>
  <ul class="post-list">
${items}
  </ul>

  <section class="cta-feedback">
    <h3>${t('分享你的使用體驗', 'Share Your Experience')}</h3>
    <ul>
      <li>${t('拍一段 debug 影片分享 → ', 'Share a debugging video → ')}<span class="reward">${t('免費 30 天', '30 days free')}</span></li>
      <li>${t('寫 50 字使用心得 → ', 'Write a 50-word review → ')}<span class="reward">${t('免費 10 天', '10 days free')}</span></li>
    </ul>
    <p class="note">${t('寄到 ', 'Send to ')}<a href="mailto:fox100039@gmail.com">fox100039@gmail.com</a>${t('，附上你的 BugEzy 帳號 email。', ', and include the email of your BugEzy account.')}</p>
  </section>

</div>
${siteFooter(lang)}
</body>
</html>`;
}

// ── PM-126：更新日誌頁（GET /changelog）——深色主題與其他頁一致 ──
// PM-151：/changelog 改為函式（依 lang 中英切換）。版號/日期不翻，只翻功能描述。
function changelogPage(lang: PageLang, canonLang: PageLang | null): string {
  const t = makeT(lang); // PM-232：zh/en/zh-CN 三語（zh-CN 由繁體轉簡體）
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('更新日誌 · BugEzy', 'Changelog · BugEzy')}</title>
<meta name="description" content="${t('BugEzy 每次更新做了什麼，都記在這裡。', 'What changed in each BugEzy update, all in one place.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
${canonicalTag('/changelog', canonLang, LANGS_3)}
${hreflangTags('/changelog', LANGS_3)}
${ogMeta('/changelog', 'Changelog — BugEzy', 'Latest updates and release notes.')}
${SITE_FONTS}
  <style>${SITE_CHROME_CSS}${SITE_CONTENT_CSS}
  /* PM-435：版本條目（設計稿畫面 29）。§7.3 最新＝實線白卡，舊版＝虛線半透明。 */
  .wrap { max-width:720px; }
  .changelog-entry { margin:12px 0 0; padding:14px 18px; background:rgba(255,255,255,.6);
    border:2px dashed rgba(20,17,11,.35); border-radius:12px; }
  .changelog-entry.latest { padding:16px 18px; background:#fff; border:2px solid var(--ink); }
  .cl-head { display:flex; align-items:center; gap:11px; flex-wrap:wrap; margin:0 0 10px; font-weight:400; }
  .cl-ver { padding:4px 11px; border-radius:7px; background:var(--brown); color:var(--y-pale); font:700 13px/1 var(--font-mono); }
  .changelog-entry.latest .cl-ver { background:var(--ink); color:var(--y); }
  .cl-date { font:600 12px/1 var(--font-mono); color:var(--on-y-2); }
  .cl-latest { margin-left:auto; padding:3px 10px; border-radius:999px; background:var(--y); color:var(--ink); font:700 10.5px/1.4 var(--font-ui); }
  .cl-group { margin:14px 0 4px; font:700 13.5px/1.6 var(--font-ui); color:var(--brown-d); }
  .changelog-entry li { font:500 13px/1.7 var(--font-ui); }
</style>
</head>
<body>
${siteNav(lang, LANGS_3, '')}
<div class="wrap">

 <h1>${t('BugEzy 更新日誌', 'BugEzy Changelog')}</h1>
  <p class="lead">${t('每次更新做了什麼，都記在這裡。', 'What changed in each update, all here.')}</p>

  <section class="changelog-entry latest">
    <h3 class="cl-head"><span class="cl-ver">v1.1.5</span><span class="cl-date">2026-08-09</span><span class="cl-latest">${t('最新', 'Latest')}</span></h3>
  <p class="cl-group">${t('免費體驗票券', 'Free Trial Tickets')}</p>
    <ul>
      <li>${t('輸入活動代碼即可解鎖付費功能，體驗完整的 BugEzy', 'Enter a promo code to unlock paid features')}</li>
      <li>${t('票券可先儲存、需要時再啟用，不浪費任何一天', 'Save tickets and activate them only when you need them')}</li>
      <li>${t('啟用前會二次確認（啟用即開始倒數，不可取消）', 'Confirmation before activating (the countdown starts immediately)')}</li>
      <li>${t('票券錢包可折疊收合，popup 更精簡', 'Collapsible ticket wallet keeps the popup compact')}</li>
    </ul>
  <p class="cl-group">${t('安裝碼', 'Install Code')}</p>
    <ul>
      <li>${t('登入後自動獲得專屬安裝碼（BZ-XXXX），參加社群活動時一鍵複製', 'Get a unique install code (BZ-XXXX) after signing in — one-click copy for community events')}</li>
    </ul>
  <p class="cl-group">${t('官網改版', 'Website Updates')}</p>
    <ul>
      <li>${t('安裝指南與使用指南合併為一頁「完整指南」，每個 MCP 設定都有複製按鈕', 'Install and usage guides merged into one page, with copy buttons on every MCP config')}</li>
      <li>${t('新增「用戶心得」頁面（支援影片與文字分享）', 'New testimonials page (video and written reviews)')}</li>
      <li>${t('指南新增「搞不定？把這段話丟給你的 AI」萬用提示詞', 'Added a universal "stuck? paste this to your AI" prompt')}</li>
    </ul>
  <p class="cl-group">${t('修復', 'Fixes')}</p>
    <ul>
      <li>${t('修復免費版開啟 popup 時次數、升級按鈕偶爾不顯示', 'Fixed free-tier popup sometimes not showing usage counts and the upgrade button')}</li>
      <li>${t('票券到期提醒文案修正（到期只是回到免費版，不會自動扣款）', 'Clarified trial-expiry wording (it returns to the free plan; nothing is charged automatically)')}</li>
    </ul>
  </section>

  <section class="changelog-entry">
    <h3 class="cl-head"><span class="cl-ver">v1.1.4</span><span class="cl-date">2026-07-19</span></h3>
  <p class="cl-group">${t('即時字幕體驗優化', 'Live Caption Experience')}</p>
    <ul>
      <li>${t('說話時底部字幕即時顯示辨識中的文字（所有語言，像 YouTube 即時字幕）', 'Live caption shows recognized text as you speak (all languages, YouTube-style)')}</li>
      <li>${t('右上語音面板可拖曳移動，位置記憶', 'Draggable voice panel with position memory')}</li>
   <li>${t('修復 重啟按鈕無限循環（兩個辨識實例搶麥克風）', 'Fixed restart button infinite loop (two recognizers fighting for the mic)')}</li>
      <li>${t('修復右上面板第一段語音遺失（歷史合併不覆寫）', 'Fixed first voice segment lost in the panel (history merge, no overwrite)')}</li>
    </ul>
  <p class="cl-group">${t('多語語音強化', 'Multilingual Voice Improvements')}</p>
    <ul>
      <li>${t('韓語即時字幕效能優化（interim 節流 + 防無限重啟循環）', 'Korean live caption performance (interim throttle + restart-loop guard)')}</li>
      <li>${t('粵語 / 越南語 stale interim 自動升級——不再漏收語音', 'Cantonese / Vietnamese stale-interim auto-promotion — no more dropped speech')}</li>
      <li>${t('簡體中文語音轉錄自動繁轉簡（字幕 / 面板 / 補充說明）', 'Simplified Chinese voice transcription auto-converts Traditional→Simplified (caption / panel / notes)')}</li>
      <li>${t('截圖語音全面對齊——語言跟隨 popup + 七語提示文字 i18n', 'Screenshot voice fully aligned — follows popup language + 7-language prompt i18n')}</li>
    </ul>
  <p class="cl-group">${t('其他', 'Other')}</p>
    <ul>
      <li>${t('全新品牌 Icon', 'Brand-new icon')}</li>
    </ul>
  </section>

  <section class="changelog-entry">
    <h3 class="cl-head"><span class="cl-ver">v1.1.3</span><span class="cl-date">2026-07-09</span></h3>
  <p class="cl-group">${t('SEO 深度優化', 'SEO Deep Optimization')}</p>
    <ul>
      <li>${t('全站 10 頁加入 Open Graph + Twitter Card meta', 'Open Graph + Twitter Card meta on all 10 pages')}</li>
      <li>${t('首頁 JSON-LD 結構化資料（SoftwareApplication + Organization），通過 Google Rich Results 驗證', 'Homepage JSON-LD (SoftwareApplication + Organization), passes Google Rich Results')}</li>
      <li>${t('/faq 加入 FAQPage JSON-LD（14 題 Q&amp;A）+ /icon-128.png 靜態路由（OG 分享圖）', 'FAQPage JSON-LD on /faq (14 Q&amp;A) + /icon-128.png static route (OG image)')}</li>
    </ul>
  <p class="cl-group">${t('國際化修復（5 項）', 'Internationalization Fixes (5)')}</p>
    <ul>
      <li>${t('Whisper 轉錄強制輸出繁體中文（zh / yue 加 prompt 引導）', 'Whisper transcription forced to Traditional Chinese (zh / yue prompt)')}</li>
      <li>${t('編輯報告頁語音輸入語言 + UI 完整跟隨 popup 語言設定', 'Edit-report voice input language + full UI follow popup language')}</li>
      <li>${t('麥克風授權頁 + 即時字幕浮動條 i18n（Listening… / 聽取中…）', 'Mic permission page + live caption bar i18n (Listening… / 聽取中…)')}</li>
      <li>${t('AI 修正 / AI 精簡依語言切換 prompt（英文用戶輸出英文）', 'AI correct / summarize prompts switch by language (English output for EN users)')}</li>
      <li>${t('粵語即時字幕語言代碼修正（zh-HK → yue-Hant-HK）', 'Cantonese live-caption code fix (zh-HK → yue-Hant-HK)')}</li>
    </ul>
  <p class="cl-group">${t('安全修復（Fable5 第四輪稽核 6 項）', 'Security Fixes (Fable5 4th-round audit, 6)')}</p>
    <ul>
      <li>${t('createReport user_id 強制 server 端覆蓋（防冒名綁定）', 'createReport user_id forced server-side (anti-spoofing)')}</li>
      <li>${t('ECPay callback 孤兒態自癒（payments 成功 + users 失敗 → 重送修復）', 'ECPay callback orphan-state self-healing (payments ok + users fail → retry heals)')}</li>
      <li>${t('MCP 過期 token 改用 verifySessionByToken（檢查 expires_at）', 'MCP expired-token check via verifySessionByToken (checks expires_at)')}</li>
      <li>${t('/api/usage/monthly 加認證 gate', '/api/usage/monthly now requires authentication')}</li>
      <li>${t('report 頁 screen_size 補 esc 轉義 + CSP 補 frame-ancestors none（防點擊劫持）', 'report screen_size esc + CSP frame-ancestors none (clickjacking protection)')}</li>
    </ul>
  </section>

  <section class="changelog-entry">
    <h3 class="cl-head"><span class="cl-ver">v1.1.0</span><span class="cl-date">2026-07-02</span></h3>
    <ul>
   <li>${t('Whisper 精準語音轉錄（付費版）', 'Whisper voice transcription (Premium)')}</li>
   <li>${t('日票 NT$20/24hr 上線', 'Day Pass NT$20/24hr launched')}</li>
   <li>${t('AI 指令輪盤（一鍵複製慣用語）', 'AI prompt carousel (one-click copy)')}</li>
   <li>${t('高畫質 AI 分析勾選', 'HQ AI analysis toggle')}</li>
   <li>${t('即時監控狀態條 + 上傳報告', 'Live monitor status bar + upload report')}</li>
   <li>${t('進階設定折疊', 'Collapsible advanced settings')}</li>
   <li>${t('Supabase RLS 安全強化', 'Supabase RLS security hardening')}</li>
    </ul>
  </section>

  <section class="changelog-entry">
    <h3 class="cl-head"><span class="cl-ver">v1.0.0</span><span class="cl-date">2026-06-29</span></h3>
    <ul>
   <li>${t('首次上架 Chrome Web Store', 'First release on Chrome Web Store')}</li>
   <li>${t('六種錄製模式', 'Six recording modes')}</li>
   <li>${t('12 個 MCP 工具 + Token 透明度', '12 MCP tools + Token transparency')}</li>
   <li>${t('ECPay 付費整合', 'ECPay payment integration')}</li>
    </ul>
  </section>

</div>
${siteFooter(lang)}
</body>
</html>`;
}

// ── PM-174：問題回報頁（GET /feedback）+ POST /api/feedback（存 Supabase feedback 表，不需登入）──
function feedbackPage(lang: PageLang, canonLang: PageLang | null): string {
  const t = makeT(lang); // PM-232：zh/en/zh-CN 三語（zh-CN 由繁體轉簡體）
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t('問題回報 · BugEzy', 'Feedback · BugEzy')}</title>
<meta name="description" content="${t('回報 BugEzy 的問題或提出功能建議。', 'Report bugs or suggest features for BugEzy.')}">
<meta name="google-site-verification" content="ZTldzDIBqNhuszKWkQr3C1HByMCOTQP2HH3Kj2858gE" />
${canonicalTag('/feedback', canonLang, LANGS_3)}
${hreflangTags('/feedback', LANGS_3)}
${ogMeta('/feedback', 'Feedback — BugEzy', 'Share your feedback and help improve BugEzy.')}
${SITE_FONTS}
  <style>${SITE_CHROME_CSS}${SITE_CONTENT_CSS}
  /* PM-436：問題回報表單（設計稿畫面 30 區塊庫 B） */
  .wrap { max-width:600px; }
  h1 { font:800 26px/1.35 var(--font-ui); margin:16px 0 6px; }
  .lead { margin:0 0 24px; font:500 14px/1.8 var(--font-ui); color:var(--on-y); }
  form { display:flex; flex-direction:column; gap:11px; padding:18px 20px; background:#fff;
    border:2px solid var(--ink); border-radius:14px; }
  /* Email 與問題類型並排 */
  .form-row { display:flex; gap:9px; flex-wrap:wrap; }
  .form-row .f-email { flex:1 1 240px; }
  .form-row .f-cat { width:150px; flex-shrink:0; }
  label { margin-top:4px; font:700 12px/1.6 var(--font-mono); letter-spacing:.06em; color:var(--on-y-2); }
  input, select, textarea { width:100%; padding:11px 13px; border:2px solid var(--ink); border-radius:10px;
    background:#fff; color:var(--ink); font:500 13px/1.5 var(--font-ui); font-family:var(--font-ui); }
  input::placeholder, textarea::placeholder { color:var(--on-y-2); }
  input:focus, select:focus, textarea:focus { outline:2px solid var(--y); outline-offset:1px; }
  /* §7.3 待填的長描述用虛線框（空的欄位＝虛線） */
  textarea { min-height:96px; resize:vertical; border:2px dashed rgba(20,17,11,.4);
    background:rgba(255,244,214,.55); line-height:1.7; }
  button { margin-top:9px; padding:13px; width:100%; border:2px solid var(--ink); border-radius:11px;
    background:var(--ink); color:var(--y); font:700 14px/1 var(--font-ui); cursor:pointer;
    box-shadow:3px 3px 0 var(--brown); }
  button:hover { transform:translate(1px,1px); box-shadow:2px 2px 0 var(--brown); }
  button:disabled { transform:none; box-shadow:none; background:transparent; color:var(--on-y-2);
    border-color:rgba(20,17,11,.35); cursor:not-allowed; }
  .msg { display:none; margin-top:16px; padding:12px 14px; border-radius:10px; text-align:center;
    font:700 13.5px/1.6 var(--font-ui); }
  /* §7.7 成功／失敗不只靠顏色：成功是黃底黑字，失敗是磚紅底 */
  .msg.ok { background:var(--y); border:2px solid var(--ink); color:var(--ink); }
  .msg.err { background:var(--err); border:2px solid var(--err); color:var(--y-pale); }
  .char-hint { margin-top:2px; text-align:right; font:600 11px/1 var(--font-mono); color:var(--on-y-2); }
</style>
</head>
<body>
${siteNav(lang, LANGS_3, '')}
<div class="wrap">
  <h1>${t('問題回報', 'Feedback')}</h1>
  <p class="lead">${t('遇到問題或有建議？告訴我們！', 'Found a bug or have a suggestion? Let us know!')}</p>
  <form id="feedback-form">
    <div class="form-row">
      <div class="f-email">
        <label for="fb-email">${t('Email（選填，方便我們回覆）', 'Email (optional, so we can reply)')}</label>
        <input type="email" id="fb-email" name="email" placeholder="you@example.com" maxlength="200" />
      </div>
      <div class="f-cat">
        <label for="fb-category">${t('類型', 'Category')}</label>
        <select id="fb-category" name="category">
          <option value="bug">${t('Bug 回報', 'Bug Report')}</option>
          <option value="feature">${t('功能建議', 'Feature Request')}</option>
          <option value="question">${t('使用問題', 'Question')}</option>
          <option value="other">${t('其他', 'Other')}</option>
        </select>
      </div>
    </div>
    <label for="fb-message">${t('描述', 'Description')}</label>
    <textarea id="fb-message" name="message" rows="6" required maxlength="5000" placeholder="${t('請描述你遇到的問題或建議…', 'Describe the issue or suggestion…')}"></textarea>
    <div class="char-hint"><span id="fb-count">0</span>/5000</div>
    <button type="submit" id="fb-submit">${t('送出', 'Submit')}</button>
  </form>
  <div class="msg ok" id="fb-ok">${t('感謝回報！我們會盡快處理。', 'Thanks for your feedback! We will get on it soon.')}</div>
  <div class="msg err" id="fb-err"></div>
</div>
${siteFooter(lang)}
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
  const t = makeT(lang); // PM-232：zh/en/zh-CN 三語（zh-CN 由繁體轉簡體）
  const page = `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${t('我的報告 · BugEzy', 'My Reports · BugEzy')}</title>
${ogMeta('/reports', 'My Bug Reports — BugEzy', 'View and manage your captured bug reports.')}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;800&family=Noto+Sans+TC:wght@400;500;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<style>
  /* PM-432：我的報告列表。卡片只要求換色碼，版面結構不動。 */
  :root {
    --y:#F7BE00; --y-deep:#DFA800; --y-pale:#FFE9AE; --cream:#FFF4D6;
    --ink:#14110B; --brown:#7A4E1D; --brown-d:#4A2F12; --err:#8A2A0F;
    --on-dark:#A08B62; --on-y:#3A2409; --on-y-2:#5E3A14;
    --font-brand:Archivo,'Noto Sans TC','Microsoft JhengHei',system-ui,sans-serif;
    --font-ui:'Noto Sans TC',system-ui,-apple-system,'Segoe UI','Microsoft JhengHei',sans-serif;
    --font-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --hex:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);
  }
  * { box-sizing: border-box; }
  /* §4 蜂巢紋 10%。⚠ data URI 內不可出現未編碼的分號。 */
  body {
    margin:0; padding:0; background:var(--y);
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='49' viewBox='0 0 28 49'%3E%3Cg fill='none' stroke='rgba(20,17,11,0.10)' stroke-width='1'%3E%3Cpath d='M13.99 9.25l13 7.5v15l-13 7.5L1 31.75v-15z'/%3E%3Cpath d='M13.99 -15.25l13 7.5v15l-13 7.5L1 7.75v-15z'/%3E%3Cpath d='M13.99 33.25l13 7.5v15l-13 7.5L1 55.75v-15z'/%3E%3C/g%3E%3C/svg%3E");
    color:var(--ink); font-family:var(--font-ui); line-height:1.6; font-size:15px;
  }
  .wrap { max-width:920px; margin:0 auto; padding:40px 24px 80px; }
  .lang-switch { position:fixed; top:14px; right:16px; background:var(--ink); border:1.5px solid var(--brown); border-radius:8px; padding:5px 12px; font:700 12px/1.6 var(--font-mono); color:var(--y); text-decoration:none; }
  header { border-bottom:2px solid var(--ink); padding-bottom:16px; margin-bottom:20px; }
  .brand { display:inline-flex; align-items:center; gap:9px; font:800 22px/1 var(--font-brand); letter-spacing:.02em; color:var(--ink); text-decoration:none; }
  /* §5.B 六角斜紋標記（黃底版：外黑內斜紋）。⚠ clip-path 會裁掉 border，用嵌套六角。 */
  .brand-hex { width:24px; height:28px; flex-shrink:0; background:var(--ink); clip-path:var(--hex); display:inline-flex; align-items:center; justify-content:center; }
  .brand-hex > i { width:15px; height:18px; clip-path:var(--hex); background:repeating-linear-gradient(162deg,var(--y) 0 3px,var(--ink) 3px 6px); }
  h1 { font:800 24px/1.3 var(--font-ui); margin:14px 0 4px; color:var(--ink); }
  .count { font:600 14px/1.6 var(--font-ui); color:var(--on-y); margin:0; }
  .empty, .notice { text-align:center; font:600 14px/1.8 var(--font-ui); color:var(--on-y); padding:40px 20px; }
  .notice a { color:var(--brown-d); }
  /* §7.2 資料卡：米白 + 2px 黑框 */
  .reports-table { width:100%; border-collapse:separate; border-spacing:0; margin-top:16px; border:2px solid var(--ink); border-radius:12px; overflow:hidden; }
  .reports-table th { background:var(--ink); color:var(--y); padding:10px 12px; text-align:left; font:700 11px/1.6 var(--font-mono); letter-spacing:.08em; }
  .reports-table td { background:var(--cream); padding:10px 12px; border-bottom:1px solid rgba(20,17,11,.14); font:500 13px/1.6 var(--font-ui); color:var(--ink); vertical-align:top; }
  .reports-table tr:last-child td { border-bottom:none; }
  .reports-table tr:hover td { background:#fff; }
  .reports-table a { color:var(--brown-d); text-decoration:none; font-weight:700; }
  .reports-table a:hover { text-decoration:underline; }
  .badges { white-space:nowrap; font:600 12px/1.6 var(--font-mono); color:var(--on-y-2); }
  /* PM-196：勾選刪除 */
  .col-cb { width:34px; text-align:center; }
  .reports-table td.col-cb, .reports-table th.col-cb { text-align:center; padding-left:8px; padding-right:8px; }
  .report-cb, #selectAll { width:16px; height:16px; accent-color:var(--ink); cursor:pointer; }
  .delete-bar { display:flex; justify-content:flex-end; margin-top:16px; }
  /* 刪除是破壞性操作 → §2.1 磚紅 */
  .delete-btn { background:var(--err); color:var(--y-pale); border:2px solid var(--err); border-radius:11px; padding:10px 18px; font:700 13px/1 var(--font-ui); cursor:pointer; }
  .delete-btn:hover { background:#6E210C; border-color:#6E210C; }
  .delete-btn:disabled { background:transparent; border-color:rgba(20,17,11,.35); color:var(--on-y-2); cursor:not-allowed; }
  @media (max-width:640px) { .col-desc, .col-time { display:none; } }
</style>
</head>
<body>
<a class="lang-switch" href="${escapeAttr(langSwitchHref)}">${t('EN', '中文')}</a>
<div class="wrap">
  <header><a class="brand" href="/"><span class="brand-hex"><i></i></span>BugEzy</a></header>
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
  const t = makeT(lang); // PM-232：zh/en/zh-CN 三語（zh-CN 由繁體轉簡體）
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
  const t = makeT(lang); // PM-232：zh/en/zh-CN 三語（zh-CN 由繁體轉簡體）
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}" data-bugezy-lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${t('BugEzy — Bug 報告', 'BugEzy — Bug Report')}</title>
  <!-- PM-432：server 端頁面**可以**外連 Google Fonts（擴充功能不行是因為 CWS 隱私審查，
       這裡沒有那個限制）。preconnect 讓字型早一步開始下載。 -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;800&family=Noto+Sans+TC:wght@400;500;700;900&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    /* ─────────────────────────────────────────────────────────────
       PM-432：分享報告頁（設計稿畫面 14/15）· 1148px
       這是 PM 與工程師唯一會看到的公開介面。§9 版面：黃底 + 黑 header + 米白資料卡。
       ⚠ 報告頁的 CSP 是 script-src 'self'，所有 client 邏輯都在 /report-page.js。
       ───────────────────────────────────────────────────────────── */
    :root {
      --y:#F7BE00; --y-deep:#DFA800; --y-pale:#FFE9AE; --cream:#FFF4D6;
      --ink:#14110B; --ink-2:#211C13; --ink-3:#0E0C08;
      --brown:#7A4E1D; --brown-d:#4A2F12;
      --line-dark:#3A3122; --line-dark-2:#55492F;
      --err:#8A2A0F; --err-fg:#E08B72; --info:#1E6FD9;
      /* §2.4 深底上的次要文字只有這兩階 */
      --on-dark:#A08B62; --on-dark-2:#C9A15A;
      /* §3.2 黃底／米白底上的次要文字 */
      --on-y:#3A2409; --on-y-2:#5E3A14;
      /* 米白卡上的時間戳。⚠ §2.4 禁用 #6B5A3D 是**針對深底**（在黑底上沒有亮度差）；
         這裡底色是 #FFF4D6，對比約 6:1，設計稿畫面 14 用的就是這個值。 */
      --on-cream-dim:#6B5A3D;
      --font-brand:Archivo,'Noto Sans TC','Microsoft JhengHei',system-ui,sans-serif;
      --font-ui:'Noto Sans TC',system-ui,-apple-system,'Segoe UI','Microsoft JhengHei',sans-serif;
      --font-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
      --hex:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);
    }
    * { margin:0; padding:0; box-sizing:border-box; }
    /* §4 蜂巢紋 10%。⚠ data URI 內不可出現未編碼的 \`;\` —— 會提早結束 CSS 宣告。 */
    body {
      background:var(--y);
      background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='49' viewBox='0 0 28 49'%3E%3Cg fill='none' stroke='rgba(20,17,11,0.10)' stroke-width='1'%3E%3Cpath d='M13.99 9.25l13 7.5v15l-13 7.5L1 31.75v-15z'/%3E%3Cpath d='M13.99 -15.25l13 7.5v15l-13 7.5L1 7.75v-15z'/%3E%3Cpath d='M13.99 33.25l13 7.5v15l-13 7.5L1 55.75v-15z'/%3E%3C/g%3E%3C/svg%3E");
      color:var(--ink); font-family:var(--font-ui);
    }

    /* ── 黑 header（§5.B 三層六角：外黃 → 內黑 → 斜紋核心）── */
    .topbar { display:flex; align-items:center; gap:12px; padding:13px 24px; background:var(--ink); border-bottom:none; }
    /* ⚠ clip-path 會裁掉 box-shadow 與 border，外環一律用「外六角包內六角」的嵌套 */
    .topbar-hex { width:28px; height:32px; flex-shrink:0; background:var(--y); clip-path:var(--hex); display:flex; align-items:center; justify-content:center; }
    .topbar-hex > i { width:23px; height:27px; background:var(--ink); clip-path:var(--hex); display:flex; align-items:center; justify-content:center; }
    .topbar-hex > i > i { width:15px; height:17px; clip-path:var(--hex); background:repeating-linear-gradient(162deg,var(--y) 0 3px,var(--ink) 3px 6px); }
    .topbar-brand { font:800 18px/1 var(--font-brand); letter-spacing:.02em; color:var(--y); }
    .topbar-title { font:500 13px/1 var(--font-ui); color:var(--on-dark); }
    .lang-switch { margin-left:auto; padding:6px 14px; border:1.5px solid var(--brown); border-radius:8px; font:700 12px/1 var(--font-mono); color:var(--y); text-decoration:none; letter-spacing:.06em; }
    .lang-switch:hover { border-color:var(--y); }

    .report { max-width:1148px; margin:0 auto; padding:26px 24px 40px; display:flex; flex-direction:column; gap:22px; }

    /* ── 標題區 + 分享連結卡（設計稿把分享卡移到標題右側）── */
    .header { display:flex; align-items:flex-start; gap:24px; margin:0; }
    .header-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:10px; }
    .header h1 { font:800 25px/1.3 var(--font-ui); letter-spacing:.01em; color:var(--ink); text-wrap:pretty; }
    .meta { display:flex; flex-direction:column; gap:5px; font:600 13px/1.65 var(--font-ui); color:var(--on-y); }
    .meta a { font-family:var(--font-mono); color:var(--brown-d); word-break:break-all; }
    .meta .meta-tech { display:flex; gap:9px; flex-wrap:wrap; font-family:var(--font-mono); font-size:11.5px; }
    .meta .meta-sep { color:rgba(74,47,18,.5); }
    /* §2.3 分享連結卡屬系統訊息 → 咖啡底 */
    .share-box { display:flex; flex-direction:column; gap:7px; padding:14px 16px; background:var(--brown); border-radius:12px; width:330px; flex-shrink:0; }
    .share-box .share-label { font:700 11px/1 var(--font-ui); color:var(--y-pale); white-space:nowrap; }
    .share-row { display:flex; gap:7px; }
    .share-box input { flex:1; min-width:0; padding:9px 11px; border:none; border-radius:8px; background:var(--ink); color:var(--y-pale); font:400 11.5px/1.3 var(--font-mono); }
    .share-copy-btn { flex-shrink:0; padding:9px 14px; border:none; border-radius:8px; background:var(--y); color:var(--ink); font:700 12px/1 var(--font-ui); cursor:pointer; white-space:nowrap; }
    .share-copy-btn:hover { background:var(--y-deep); }

    /* ── 分頁列 ── */
    .tab-bar { display:flex; gap:2px; border-bottom:2px solid var(--ink); margin:0; overflow-x:auto; }
    .tab-btn { display:flex; align-items:center; gap:8px; padding:11px 20px; margin-bottom:-2px; border:2px solid var(--ink); border-bottom:none; border-radius:11px 11px 0 0; background:transparent; color:var(--brown-d); font:700 13px/1 var(--font-ui); cursor:pointer; white-space:nowrap; }
    .tab-btn:hover { background:rgba(20,17,11,.08); }
    .tab-btn.active { background:var(--ink); color:var(--y); }
    /* §7.6：Console 有錯 → 磚紅徽章；其餘低對比 */
    .tab-badge { padding:2px 8px; border-radius:999px; background:rgba(20,17,11,.16); color:var(--brown-d); font:700 11px/1.3 var(--font-mono); }
    .tab-badge.error { background:var(--err); color:var(--y-pale); }
    .tab-btn.active .tab-badge { background:rgba(247,190,0,.18); color:var(--y); }
    .tab-btn.active .tab-badge.error { background:var(--err); color:var(--y-pale); }
    /* §6 截圖分頁：圓角框 + 中心圓點（原本是 📸） */
    .ic-shot { width:15px; height:12px; box-sizing:border-box; border:2px solid currentColor; border-radius:3px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
    .ic-shot > i { width:5px; height:5px; border-radius:50%; background:currentColor; }

    .tab-content { min-height:200px; padding:0; }
    .tab-panel { display:none; }
    .tab-panel.active { display:flex; flex-direction:column; gap:20px; }

    /* ── section 標題統一 ── */
    .info-section { display:flex; flex-direction:column; gap:9px; }
    .info-section h3 { font:700 11px/1 var(--font-mono); letter-spacing:.1em; color:var(--brown-d); }
    .info-section p { font:400 14px/1.75 var(--font-ui); color:var(--ink); white-space:pre-wrap; padding:13px 15px; background:var(--cream); border:2px solid var(--ink); border-radius:12px; }
    /* Info 分頁兩欄：左內容、右 398px 側欄 */
    .info-cols { display:flex; gap:20px; align-items:flex-start; }
    .info-col-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:20px; }
    .info-col-side { width:398px; flex-shrink:0; display:flex; flex-direction:column; gap:20px; }
    @media (max-width:900px) { .info-cols { flex-direction:column; } .info-col-side { width:100%; } }
    /* 摘要 2×3（同 edit-report 那套米白格） */
    .info-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:2px; background:var(--ink); border:2px solid var(--ink); border-radius:12px; overflow:hidden; }
    .info-grid > div { background:var(--cream); padding:11px 13px; display:flex; flex-direction:column; gap:3px; min-width:0; font:700 11.5px/1 var(--font-ui); color:var(--on-y-2); }
    .info-grid b { font:700 18px/1.1 var(--font-mono); color:var(--ink); }

    /* ── 卡片框（log / network / voice / marker 共用）── */
    .card-list { border:2px solid var(--ink); border-radius:12px; overflow:hidden; }
    .card-list > * + * { border-top:1px solid rgba(20,17,11,.14); }

    /* ── 時間軸標記（§7.3 手動=實線、AUTO=虛線）── */
    .marker-item { display:flex; align-items:center; gap:11px; padding:10px 14px; background:var(--cream); font:600 13px/1.5 var(--font-ui); color:var(--ink); }
    .marker-item.auto { background:rgba(255,244,214,.55); }
    .marker-time { flex-shrink:0; padding:3px 9px; border-radius:6px; background:var(--ink); color:var(--y); font:700 11px/1.4 var(--font-mono); }
    .marker-item.auto .marker-time { background:var(--brown); color:var(--y-pale); }
    .marker-auto-tag { margin-left:auto; flex-shrink:0; font:700 10px/1 var(--font-mono); letter-spacing:.08em; color:var(--brown); }

    /* ── Console log ── */
    .log-item { display:flex; align-items:flex-start; gap:12px; padding:11px 15px; background:var(--cream); }
    .log-item .log-msg { flex:1; min-width:0; font:500 12.5px/1.6 var(--font-mono); word-break:break-all; }
    .log-item.error .log-msg { color:var(--err); }
    .log-item.warn .log-msg { color:var(--brown); }
    .log-time { flex-shrink:0; font:600 11.5px/1.6 var(--font-mono); color:var(--on-cream-dim); }
    /* §6 error = 圓形 + 中央橫槓；warn = 三角 */
    .log-icon { flex-shrink:0; }
    .log-item.error .log-icon { width:15px; height:15px; margin-top:1px; border-radius:50%; background:var(--err); display:flex; align-items:center; justify-content:center; }
    .log-item.error .log-icon > i { width:7px; height:2px; background:var(--cream); }
    .log-item.warn .log-icon { width:15px; height:14px; margin-top:2px; background:var(--brown); clip-path:polygon(50% 0,100% 100%,0 100%); }
    .log-more { display:flex; align-items:center; justify-content:center; padding:10px; background:rgba(255,244,214,.55); font:700 12px/1 var(--font-ui); color:var(--on-y-2); }

    /* ── Network ── */
    .net-item { display:flex; align-items:center; gap:14px; padding:10px 14px; background:var(--cream); }
    .net-status { width:34px; flex-shrink:0; font:700 12.5px/1 var(--font-mono); }
    /* 5xx 伺服器掛了 → 磚紅；4xx 找不到／權限 → 較淺的褐（米白底上對比約 6.9:1） */
    .net-status.s5xx { color:var(--err); }
    .net-status.s4xx { color:#8A5A24; }
    .net-method { width:40px; flex-shrink:0; font:700 12px/1 var(--font-mono); color:var(--info); }
    .net-url { flex:1; min-width:0; font:400 11.5px/1.4 var(--font-mono); color:var(--ink); word-break:break-all; }
    .net-duration { flex-shrink:0; font:600 11px/1 var(--font-mono); color:var(--on-cream-dim); }

    /* ── 語音記錄 ── */
    .voice-item { display:flex; gap:11px; padding:10px 14px; background:var(--cream); font:400 13.5px/1.7 var(--font-ui); color:var(--ink); }
    .voice-time { flex-shrink:0; font:600 11px/1.9 var(--font-mono); color:var(--on-cream-dim); }

    /* ── 截圖 ── */
    .ss-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
    .ss-img { width:100%; border-radius:8px; border:2px solid var(--ink); cursor:pointer; display:block; }
    .ss-img:hover { border-color:var(--brown); }

    /* ── 高畫質 AI 分析（§7.3 空/選填 → 虛線框）── */
    .screenshot-toggle { padding:14px 16px; background:rgba(255,244,214,.55); border:2px dashed rgba(20,17,11,.4); border-radius:12px; }
    .screenshot-toggle label { display:flex; align-items:center; gap:10px; cursor:pointer; font:700 13.5px/1 var(--font-ui); color:var(--ink); }
    .screenshot-toggle input[type="checkbox"] { width:18px; height:18px; accent-color:var(--ink); flex-shrink:0; }
    .toggle-hint { margin-top:8px; font:600 12.5px/1.6 var(--font-ui); color:var(--on-y); }
    .toggle-token { margin-top:4px; font:600 11.5px/1.5 var(--font-mono); color:var(--brown-d); }

    /* ── Token 估算（§2.3 咖啡卡）── */
    .token-panel { padding:15px 17px; background:var(--brown); border:none; border-radius:12px; }
    .token-title { font:700 11px/1 var(--font-mono); letter-spacing:.1em; color:var(--y-pale); margin-bottom:9px; }
    .token-row { display:flex; justify-content:space-between; gap:12px; padding:4px 0; font:600 12.5px/1.5 var(--font-ui); color:#F0D9A8; }
    .token-row span:last-child { font-family:var(--font-mono); color:var(--y-pale); white-space:nowrap; }
    .token-row.total { border-top:1px solid rgba(255,233,174,.28); margin-top:8px; padding-top:9px; font:700 13px/1.5 var(--font-ui); color:var(--y-pale); }
    .token-save { margin-top:12px; padding:10px 12px; background:var(--y); border:none; border-radius:9px; font:700 12px/1.6 var(--font-ui); color:var(--ink); text-align:center; }

    /* ── 網路環境 / 儲存狀態的小卡 ── */
    .fact-list { display:flex; flex-direction:column; gap:0; border:2px solid var(--ink); border-radius:12px; overflow:hidden; }
    .fact-row { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:9px 13px; background:var(--cream); font:600 12.5px/1.5 var(--font-ui); color:var(--on-y-2); }
    .fact-row + .fact-row { border-top:1px solid rgba(20,17,11,.14); }
    .fact-row b { font:700 12.5px/1.5 var(--font-mono); color:var(--ink); }
    .fact-hex { width:8px; height:9px; flex-shrink:0; background:var(--ink); clip-path:var(--hex); }
    /* §2.3 遮罩註記是系統主動告知 → 咖啡底 */
    .fact-note { display:flex; align-items:flex-start; gap:9px; margin-top:9px; padding:10px 12px; background:var(--brown); border-radius:11px; font:500 11.5px/1.6 var(--font-ui); color:var(--y-pale); }
    .fact-note .fact-hex { background:var(--y); margin-top:3px; }

    .loading { text-align:center; padding:60px; font:600 14px/1 var(--font-ui); color:var(--on-y); }
    .empty { text-align:center; padding:24px; font:600 13px/1 var(--font-ui); color:var(--on-y-2); background:var(--cream); border:2px solid var(--ink); border-radius:12px; }

    /* ── PM-433：整頁狀態畫面共用的硬投影按鈕（§7.1）── */
    .state-btn { display:inline-block; padding:13px 22px; border:2px solid var(--ink); border-radius:12px; font:700 14px/1 var(--font-ui); text-decoration:none; cursor:pointer; }
    .state-btn.primary { background:var(--ink); color:var(--y); box-shadow:3px 3px 0 var(--brown-d); }
    .state-btn.primary:hover { transform:translate(1px,1px); box-shadow:2px 2px 0 var(--brown-d); }
    .state-btn.secondary { background:transparent; color:var(--brown-d); border-color:rgba(20,17,11,.4); }
    .state-btn.secondary:hover { border-color:var(--ink); color:var(--ink); }

    /* PM-188／PM-433：非會員閱讀他人分享報告的付費牆（設計稿畫面 16）。
       內容直接站在黃底蜂巢紋上 —— 設計稿這頁沒有米白卡，黑 header 已經界定了頁面。 */
    .paywall { max-width:560px; margin:0 auto; padding:40px 36px 44px; display:flex; flex-direction:column; align-items:center; gap:18px; text-align:center; }
    /* §6 幾何鎖頭 66×76。⚠ clip-path 會裁掉 border，所以鎖扣／鎖身是六角殼「裡面」的子元素，不是外框。 */
    .paywall-icon { width:66px; height:76px; flex-shrink:0; background:var(--ink); clip-path:var(--hex); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; }
    .paywall-icon .lock-shackle { width:18px; height:11px; border:2.5px solid var(--y); border-bottom:none; border-radius:10px 10px 0 0; }
    .paywall-icon .lock-body { width:26px; height:20px; border-radius:4px; background:var(--y); display:flex; align-items:center; justify-content:center; }
    .paywall-icon .lock-body > i { width:4px; height:8px; border-radius:2px; background:var(--ink); }
    .paywall-copy { display:flex; flex-direction:column; gap:10px; max-width:420px; }
    .paywall h2 { font:800 21px/1.35 var(--font-brand); letter-spacing:.01em; color:var(--ink); }
    .paywall-desc { font:500 14px/1.7 var(--font-ui); color:var(--ink); }
    .paywall-sub { font:600 13px/1.65 var(--font-ui); color:var(--on-y); }
    .paywall-cta { display:flex; gap:11px; justify-content:center; flex-wrap:wrap; padding-top:4px; }
    .paywall-note { font:600 12px/1.6 var(--font-ui); color:var(--on-y); padding-top:2px; }

    /* PM-433：找不到報告／已過保留期限（設計稿畫面 17） */
    .notfound { max-width:520px; margin:0 auto; padding:36px 32px 38px; display:flex; flex-direction:column; align-items:center; gap:16px; text-align:center; }
    /* §4 三格蜂巢：滿／空／滿。空的那格自己就說明了「這裡沒有東西」，不必再靠顏色。 */
    .nf-hive { display:flex; gap:8px; }
    .nf-cell { width:26px; height:30px; background:rgba(20,17,11,.45); clip-path:var(--hex); display:flex; align-items:center; justify-content:center; }
    .nf-cell > i { width:19px; height:22px; clip-path:var(--hex); background:var(--y); }
    .nf-cell.empty > i { background:rgba(20,17,11,.28); }
    .nf-copy { display:flex; flex-direction:column; gap:9px; max-width:380px; }
    .notfound h2 { font:800 19px/1.35 var(--font-brand); letter-spacing:.01em; color:var(--ink); }
    .nf-desc { font:500 13.5px/1.75 var(--font-ui); color:var(--on-y); }
    .notfound .state-btn { padding:12px 22px; font-size:13px; }
  </style>
</head>
<body>
  <div class="topbar">
    <span class="topbar-hex"><i><i></i></i></span>
    <span class="topbar-brand">BugEzy</span>
    <span class="topbar-title">${t('Bug 報告', 'Bug Report')}</span>
    <a class="lang-switch" href="?lang=${lang === 'zh' ? 'en' : 'zh'}">${t('EN', '中文')}</a>
  </div>
  <div class="report" id="app">
    <div class="loading" id="loading">${t('載入中…', 'Loading…')}</div>
  </div>
  <!-- PM-196：分享報告連結 + 一鍵複製（select+execCommand，非 clipboard API；複製邏輯在 report-page.js，因報告頁 CSP script-src 'self' 不允許 inline onclick）。預設隱藏，render 成功才顯示。
       PM-432：設計稿把這張卡移到標題右側 —— 節點留在這裡（複製邏輯與 id 都不動），
       render 完成後由 report-page.js 搬進標題列的 #share-slot。 -->
  <div id="share-box" class="share-box" style="display:none;">
    <span class="share-label">${t('分享報告連結', 'Share report link')}</span>
    <div class="share-row">
      <input id="share-url" type="text" readonly />
      <button id="share-copy" class="share-copy-btn">${t('複製連結', 'Copy link')}</button>
    </div>
  </div>
  <!-- PM-99：截圖點擊頁內 lightbox（base64 data URL 無法 window.open，會開空白頁；改頁內放大）。PM-166：onclick 改由 report-page.js addEventListener -->
  <div id="bugezy-lightbox" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(14,12,8,0.86);cursor:zoom-out;align-items:center;justify-content:center;">
    <img id="bugezy-lightbox-img" style="max-width:95vw;max-height:95vh;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,0.5);" />
  </div>
  <!-- PM-166：全部 client 邏輯（render + lightbox）抽到外部檔，CSP script-src 'self' 才能拿掉 unsafe-inline。
       PM-168：加 ?v 版本號——report-page.js 快取 1 天，改版時 bump 版本強制邊緣快取失效（否則新 HTML 配舊 JS）。 -->
  <script src="/report-page.js?v=433"></script>
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
      // PM-433：§6 幾何鎖頭 66×76（黑六角殼 + 鎖扣 + 鎖身 + 鑰匙孔），形狀全部在 CSS。
      h += '<div class="paywall-icon"><i class="lock-shackle"></i><i class="lock-body"><i></i></i></div>';
      h += '<div class="paywall-copy">';
      h += '<h2>' + t('此報告需要會員權限才能閱讀', 'This report requires a membership to read') + '</h2>';
      h += '<p class="paywall-desc">' + t('BugEzy 會員可以閱讀他人分享的除錯報告', 'BugEzy members can read debug reports shared by others') + '</p>';
      h += '<p class="paywall-sub">' + sub + '</p>';
      h += '</div>';
      h += '<div class="paywall-cta">';
      h += '<a class="state-btn primary" href="' + API + '/install">' + t('免費安裝 BugEzy', 'Install BugEzy free') + '</a>';
      h += '<a class="state-btn secondary" href="' + API + '/#pricing">' + t('了解會員方案', 'View plans') + '</a>';
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
      .catch(function () { renderNotFound(); });

    // PM-433：找不到報告／已過保留期限（設計稿畫面 17）。保留天數對得上 RETENTION_FREE_DAYS / RETENTION_PAID_DAYS。
    function renderNotFound() {
      var h = '<div class="notfound">';
      h += '<div class="nf-hive"><span class="nf-cell"><i></i></span><span class="nf-cell empty"><i></i></span><span class="nf-cell"><i></i></span></div>';
      h += '<div class="nf-copy">';
      h += '<h2>' + t('找不到報告', 'Report not found') + '</h2>';
      h += '<p class="nf-desc">' + t('連結可能打錯了，或報告已超過保留期限被自動刪除 — 免費版保留 7 天，付費版 90 天。', 'The link may be wrong, or the report passed its retention period and was deleted automatically — 7 days on the free plan, 90 days on paid.') + '</p>';
      h += '</div>';
      h += '<a class="state-btn primary" href="' + API + '/">' + t('回 BugEzy 首頁', 'Back to BugEzy') + '</a>';
      h += '</div>';
      document.getElementById('app').innerHTML = h;
    }

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

      // PM-432：標題在左、分享連結卡在右（設計稿畫面 14）。#share-slot 是空的落點，
      //   實際的 #share-box 節點在 HTML 裡（複製邏輯與 id 都不動），render 完才搬進來。
      let html = '<div class="header"><div class="header-main">';
      html += '<h1>' + esc(r.title || t('（無標題）', '(untitled)')) + '</h1>';
      html += '<div class="meta">';
      html += '<div><strong>URL</strong> <a href="'+esc(r.url)+'" target="_blank">'+esc(r.url)+'</a></div>';
      html += '<div class="meta-tech">';
      html += '<span>'+esc(r.browser||'')+'</span>';
      if (r.screen_size) html += '<span class="meta-sep">|</span><span>'+esc(r.screen_size)+'</span>'; // PM-219 修復5：screen_size 補 esc
      html += '<span class="meta-sep">|</span><span>'+fmtDate(r.created_at)+'</span>';
      html += '</div>';
      html += '</div></div><div id="share-slot"></div></div>';

      const tabs = [
        { key:'info', label:'Info', count:null },
        { key:'console', label:'Console', count:consoleCount, isError:true },
        { key:'network', label:'Network', count:networkCount },
        { key:'voice', label:'Voice', count:voiceCount },
      ];
      // §6 截圖 → 圓角框 + 中心圓點（原本是 📸）。用 currentColor 才會跟著 active 換色。
      if (ssCount > 0) tabs.push({ key:'screenshots', label:'<span class="ic-shot"><i></i></span>' + t('截圖','Screenshots'), count:ssCount });

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

      // PM-432：Info 分頁改兩欄（設計稿畫面 15）——左邊是這次錄到的內容，右邊是環境與摘要。
      html += '<div class="tab-panel'+(defaultTab==='info'?' active':'')+'" id="tab-info">';
      html += '<div class="info-cols"><div class="info-col-main">';
      if (r.description) {
        html += '<div class="info-section"><h3>' + t('描述', 'DESCRIPTION') + '</h3><p>'+esc(r.description)+'</p></div>';
      }
      if (markers.length > 0) {
        html += '<div class="info-section"><h3>' + t('時間軸標記', 'TIMELINE MARKERS') + '</h3><div class="card-list">';
        markers.forEach(m => {
          const min = Math.floor(m.time_sec/60);
          const sec = String(m.time_sec%60).padStart(2,'0');
          html += '<div class="marker-item"><span class="marker-time">'+min+':'+sec+'</span><span>'+esc(m.note||t('（無描述）','(no note)'))+'</span></div>';
        });
        html += '</div></div>';
      }
      // 語音記錄也放左欄（Voice 分頁仍在，這裡是 Info 的概覽）
      if (voiceCount > 0) {
        html += '<div class="info-section"><h3>' + t('語音記錄', 'VOICE') + '</h3><div class="card-list">';
        (r.voiceTranscript||[]).slice(0, 6).forEach(v => {
          html += '<div class="voice-item"><span class="voice-time">'+fmtTime(v.timestamp)+'</span>'+esc(v.text)+'</div>';
        });
        if (voiceCount > 6) html += '<div class="log-more">' + t('另外 ','+') + (voiceCount-6) + t(' 段語音（見 Voice 分頁）',' more (see Voice tab)') + '</div>';
        html += '</div></div>';
      }
      html += '</div><div class="info-col-side">';
      if (r.networkSnapshot) {
        var ns = r.networkSnapshot;
        var nsStart = ns.atStart || ns; // 相容單一/雙時間點
        var nsEnd = ns.atEnd;
        // PM-432：拆成三個取值函式，事實列一列一項；🟢/🔴 換成文字（§7.7 不靠顏色傳達內容）
        var fmtOnline = function (x) { return x && x.online ? t('在線', 'Online') : t('離線', 'Offline'); };
        var fmtType = function (x) {
          if (!x) return '—';
          return (x.type && x.type !== 'unknown') ? x.type
            : (x.effectiveType && x.effectiveType !== 'unknown' ? String(x.effectiveType).toUpperCase() : t('未知','Unknown'));
        };
        var fmtSpeed = function (x) {
          if (!x) return '—';
          var rtt = (x.rtt != null) ? x.rtt + 'ms' : '—';
          var dl = (x.downlink != null) ? x.downlink + ' Mbps' : '—';
          return rtt + ' · ' + dl + (x.saveData ? t(' · 省流量模式', ' · Data Saver') : '');
        };
        var fmtNet = function (x) {
          if (!x) return '';
          return t('狀態：','Status: ') + fmtOnline(x) + t(' · 類型：',' · Type: ') + fmtType(x) + t(' · 延遲/頻寬：',' · Latency/Bandwidth: ') + fmtSpeed(x);
        };
        html += '<div class="info-section"><h3>' + t('網路環境', 'NETWORK') + '</h3><div class="fact-list">';
        html += '<div class="fact-row"><span><span class="fact-hex"></span> ' + t('狀態','Status') + '</span><b>' + esc(fmtOnline(nsStart)) + '</b></div>';
        html += '<div class="fact-row"><span>' + t('類型','Type') + '</span><b>' + esc(fmtType(nsStart)) + '</b></div>';
        html += '<div class="fact-row"><span>' + t('延遲 · 頻寬','Latency · Bandwidth') + '</span><b>' + esc(fmtSpeed(nsStart)) + '</b></div>';
        html += '</div>';
        if (nsEnd && (nsEnd.online !== nsStart.online || nsEnd.effectiveType !== nsStart.effectiveType)) {
          html += '<div class="fact-note"><span class="fact-hex"></span><span>' + t('結束時：','At end: ') + esc(fmtNet(nsEnd)) + '</span></div>';
        }
        html += '</div>';
      }
      // PM-157：儲存狀態（值已在 extension 端遮罩，server 只顯示遮罩後結果）
      if (r.storageSnapshot) {
        var ss = r.storageSnapshot;
        // PM-432：改成事實列（一行一種儲存），細項留給 MCP／JSON —— 報告頁只給概覽。
        var countItems = function (items) { return Array.isArray(items) ? items.length : 0; };
        var cookieNames = Array.isArray(ss.cookieNames) ? ss.cookieNames : [];
        html += '<div class="info-section"><h3>' + t('儲存狀態', 'STORAGE') + '</h3><div class="fact-list">';
        html += '<div class="fact-row"><span><span class="fact-hex"></span> localStorage</span><b>' + countItems(ss.localStorage) + t(' 項',' items') + '</b></div>';
        html += '<div class="fact-row"><span>sessionStorage</span><b>' + countItems(ss.sessionStorage) + t(' 項',' items') + '</b></div>';
        html += '<div class="fact-row"><span>Cookies</span><b>' + (ss.cookieCount != null ? ss.cookieCount : cookieNames.length) + t(' 項',' items') + '</b></div>';
        html += '</div>';
        // §2.3 遮罩註記是系統主動告知 → 咖啡底
        html += '<div class="fact-note"><span class="fact-hex"></span><span>' + t('敏感值（密碼/token/email/卡號）已於使用者端自動遮罩', 'Sensitive values (passwords/tokens/email/card numbers) auto-masked on the client') + '</span></div>';
        html += '</div>';
      }
      // 摘要改「數字在上、標籤在下」的米白格（同 edit-report 那套）
      html += '<div class="info-section"><h3>' + t('摘要', 'SUMMARY') + '</h3><div class="info-grid">';
      html += '<div><b>' + (r.rrwebEvents?.length||0) + '</b><span>' + t('DOM 事件','DOM events') + '</span></div>';
      html += '<div><b>' + consoleCount + '</b><span>Console</span></div>';
      html += '<div><b>' + networkCount + '</b><span>Network</span></div>';
      html += '<div><b>' + voiceCount + '</b><span>' + t('語音段','Voice segs') + '</span></div>';
      html += '<div><b>' + ssCount + '</b><span>' + t('截圖','Screenshots') + '</span></div>';
      html += '</div></div>';
      html += '</div></div>'; // /info-col-side /info-cols
      html += '</div>'; // /tab-info

      html += '<div class="tab-panel'+(defaultTab==='console'?' active':'')+'" id="tab-console">';
      if (consoleCount === 0) {
        html += '<div class="empty">' + t('沒有 Console 錯誤', 'No console errors') + '</div>';
      } else {
        // §6：error = 圓形 + 中央橫槓、warn = 三角（形狀由 .log-icon 的 CSS 決定，這裡只給空節點）
        html += '<div class="card-list">';
        (r.consoleLogs||[]).forEach(log => {
          const cls = log.level === 'error' ? 'error' : 'warn';
          html += '<div class="log-item '+cls+'"><span class="log-icon"><i></i></span><span class="log-msg">'+esc(log.message)+'</span><span class="log-time">'+fmtTime(log.timestamp)+'</span></div>';
        });
        html += '</div>';
      }
      html += '</div>';

      html += '<div class="tab-panel'+(defaultTab==='network'?' active':'')+'" id="tab-network">';
      if (networkCount === 0) {
        html += '<div class="empty">' + t('沒有 Network 錯誤', 'No network errors') + '</div>';
      } else {
        html += '<div class="card-list">';
        (r.networkErrors||[]).forEach(err => {
          const cls = err.status >= 500 ? 's5xx' : 's4xx';
          html += '<div class="net-item"><span class="net-status '+cls+'">'+err.status+'</span><span class="net-method">'+esc(err.method)+'</span><span class="net-url">'+esc(err.url)+'</span><span class="net-duration">'+(err.duration||0)+'ms</span></div>';
        });
        html += '</div>';
      }
      html += '</div>';

      html += '<div class="tab-panel'+(defaultTab==='voice'?' active':'')+'" id="tab-voice">';
      if (voiceCount === 0) {
        html += '<div class="empty">' + t('沒有語音記錄', 'No voice transcript') + '</div>';
      } else {
        html += '<div class="card-list">';
        (r.voiceTranscript||[]).forEach(v => {
          html += '<div class="voice-item"><span class="voice-time">'+fmtTime(v.timestamp)+'</span>'+esc(v.text)+'</div>';
        });
        html += '</div>';
      }
      html += '</div>';

      if (ssCount > 0) {
        const allowImg = r.allowScreenshotImages === true; // PM-82
        const approxTok = (ssCount * 5000).toLocaleString();
        html += '<div class="tab-panel" id="tab-screenshots">';
        html += '<div class="screenshot-toggle">'
          + '<label><input type="checkbox" id="allow-images-toggle"'+(allowImg?' checked':'')+' />'
          + '<span class="toggle-label">' + t('高畫質 AI 分析（高 Token）', 'HQ AI Analysis (high token)') + '</span></label>'
          + '<p class="toggle-hint" id="toggle-hint">'+(allowImg
              ? t('已開啟 — AI 可看到截圖畫面，視覺 Bug 更精準（顏色、排版、CSS）', 'On — AI can see the screenshots, better for visual bugs (colors, layout, CSS)')
              : t('未開啟 — AI 只讀文字，省 Token。遇到視覺 Bug 再開啟', 'Off — AI reads text only to save tokens. Enable for visual bugs'))+'</p>'
          + '<p class="toggle-token" id="toggle-token">'+(allowImg
              ? t('每張截圖約 3,000~8,000 tokens（'+ssCount+' 張 ≈ '+approxTok+' tokens）', '~3,000–8,000 tokens per screenshot ('+ssCount+' imgs ≈ '+approxTok+' tokens)')
              : t('目前 AI 讀取此報告約 200~1,500 tokens', 'AI currently reads this report at ~200–1,500 tokens'))+'</p>'
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
        // PM-432：拿掉每列前面的 emoji（§1）。這幾列本來就有文字標籤，圖示沒帶額外資訊。
        { label:t('語音記錄','Voice'), len:voiceText.length },
        { label:'Console', len:consoleText.length },
        { label:'Network', len:networkText.length },
        { label:t('描述','Description'), len:descText.length },
        { label:t('DOM 摘要','DOM Summary'), len:105 },
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
      // PM-432：標題色碼不再寫在 inline style（舊紫色 #a78bfa），改走 .token-title；行首 emoji 拿掉（§1）。
      html += '<div class="token-panel"><div class="token-title">' + t('TOKEN 估算','TOKEN ESTIMATE') + '</div>' + tokenHtml;
      html += '<div class="token-save">' + t('同場景 Claude in Chrome：','Same scenario, Claude in Chrome: ') + '~'+chromeT.toLocaleString()+' tokens ≈ USD $'+((chromeT*8/1e6).toFixed(4))+'<br>' + t('BugEzy 為你省了 ','BugEzy saved you ') + pct+'%</div></div>';

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
        // PM-432：設計稿把分享卡放在標題右側。節點本身不動（複製邏輯與 id 都保留），
        //   只是 render 完之後搬進 #share-slot —— 付費牆／錯誤頁沒有這個落點，會留在原位。
        var shareSlot = document.getElementById('share-slot');
        if (shareSlot && shareBox.parentElement !== shareSlot) shareSlot.appendChild(shareBox);
        var shareBtn = document.getElementById('share-copy');
        if (shareBtn && !shareBtn.__wired) {
          shareBtn.__wired = true;
          var shareOrig = shareBtn.textContent;
          shareBtn.addEventListener('click', function () {
            shareInput.focus();
            shareInput.select();
            try { shareInput.setSelectionRange(0, 99999); } catch (e) {}
            try { document.execCommand('copy'); } catch (e) {}
            shareBtn.textContent = t('已複製！', 'Copied!');
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
            ? t('已開啟 — AI 可看到截圖畫面，視覺 Bug 更精準（顏色、排版、CSS）', 'On — AI can see the screenshots, better for visual bugs (colors, layout, CSS)')
            : t('未開啟 — AI 只讀文字，省 Token。遇到視覺 Bug 再開啟', 'Off — AI reads text only to save tokens. Enable for visual bugs');
          if (tk) tk.textContent = allow
            ? t('每張截圖約 3,000~8,000 tokens（'+cnt+' 張 ≈ '+(cnt*5000).toLocaleString()+' tokens）', '~3,000–8,000 tokens per screenshot ('+cnt+' imgs ≈ '+(cnt*5000).toLocaleString()+' tokens)')
            : t('目前 AI 讀取此報告約 200~1,500 tokens', 'AI currently reads this report at ~200–1,500 tokens');
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
  const t = makeT(lang); // PM-232：zh/en/zh-CN 三語（zh-CN 由繁體轉簡體）
  return `<!DOCTYPE html>
<html lang="${htmlLang(lang)}">
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

/**
 * PM-284：每日掃描即將到期的票券（ACTIVE 且 10 天內到期）→ 推 Discord 給 FOX。
 * 每張票只推一次（`expiry_notified`）。
 *
 * ⚠ 兩個 cron 專屬的注意事項：
 * 1. **用 `await sendDiscord()` 而不是 `notifyFox()`**——後者靠 `env.__ctx.waitUntil` 送出，
 *    但 `__ctx` 只在 `fetch()` 入口設定。在 `scheduled()` 裡它要嘛不存在、要嘛是**同一個 isolate
 *    先前某次 fetch 留下的過期 ctx**，兩種情況推播都可能送不出去。cron 沒有延遲壓力，直接 await。
 * 2. **沒設 `DISCORD_WEBHOOK_URL` 就整段跳過**——否則 `sendDiscord` 會靜默 return，
 *    但下面仍會把票券標成「已通知」，等於**在還沒開通推播前就把所有提醒消耗掉**，
 *    之後就再也不會通知了。
 */
async function notifyExpiringTickets(env: Env): Promise<void> {
  if (!env.DISCORD_WEBHOOK_URL) return; // 見上方註解 2
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const tenDaysLater = new Date(now + 10 * 86_400_000).toISOString();

  const { data, error } = await supa(env)
    .from('user_tickets')
    .select('id, user_id, code, expires_at')
    .eq('status', 'ACTIVE')
    .eq('expiry_notified', false)
    .gt('expires_at', nowIso) // 還沒過期（已過期的由 expireDueTickets 處理）
    .lte('expires_at', tenDaysLater)
    .order('expires_at', { ascending: true });
  if (error) {
    // 欄位尚未建立（FOX 未跑 ALTER）等情況——留下痕跡，不要靜默
    console.error('[Cron] 票券到期查詢失敗:', error.message);
    return;
  }
  const rows = (data ?? []) as Array<{
    id: string;
    user_id: string;
    code: string;
    expires_at: string;
  }>;
  if (!rows.length) return; // 沒有即將到期的票 → 靜默跳過

  // email 與庫存數各用一次查詢取回（不要每張票各打兩次，那是 N+1）
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const { data: users } = await supa(env)
    .from('users')
    .select('user_id, email')
    .in('user_id', userIds);
  const emailOf = new Map(
    ((users ?? []) as Array<{ user_id: string; email: string }>).map((u) => [u.user_id, u.email]),
  );
  const { data: saved } = await supa(env)
    .from('user_tickets')
    .select('user_id')
    .eq('status', 'SAVED')
    .in('user_id', userIds);
  const savedCount = new Map<string, number>();
  for (const row of (saved ?? []) as Array<{ user_id: string }>) {
    savedCount.set(row.user_id, (savedCount.get(row.user_id) ?? 0) + 1);
  }

  let sent = 0;
  for (const t of rows) {
    const daysLeft = Math.ceil((new Date(t.expires_at).getTime() - now) / 86_400_000);
    const n = savedCount.get(t.user_id) ?? 0;
    const savedInfo = n > 0 ? `\n💾 庫存 ${n} 張票券可啟用` : '\n📭 無庫存票券';
    await sendDiscord(
      env,
      '⏰ 票券即將到期',
      `${emailOf.get(t.user_id) ?? t.user_id}\n${t.code} 剩 ${daysLeft} 天（到期 ${t.expires_at.slice(0, 10)}）${savedInfo}`,
      4,
    );
    // 推播之後才標記：先標記的話，推播失敗就永遠不會再提醒了
    const { error: upErr } = await supa(env)
      .from('user_tickets')
      .update({ expiry_notified: true })
      .eq('id', t.id);
    if (upErr) console.error('[Cron] 標記 expiry_notified 失敗:', t.id, upErr.message);
    else sent++;
  }
  console.log(`[Cron] 票券到期提醒：${sent}/${rows.length} 筆`);
}

// ── PM-292：報告自動清理（免費 7 天 / 付費 90 天）─────────────────────────
const RETENTION_FREE_DAYS = 7;
const RETENTION_PAID_DAYS = 90;
const CLEANUP_BATCH = 500; // 單次上限，避免一次 cron 做太久；未清完的下次繼續

/**
 * 每日掃過期報告 → 刪 R2 附件 → 刪 DB 記錄 → Discord 回報摘要。
 *
 * ⚠ **預設 dry-run**：`REPORT_CLEANUP` 不等於 'on' 時只統計不刪除。
 *   這是不可逆的資料刪除，不該因為一次部署就自動開始跑；先看幾天摘要確認數字合理再開。
 *
 * 判定用**當前身分**（卡片 §5 的建議做法）：付費/日票/有效票券 → 90 天，其餘 → 7 天。
 * 代價是「降級後，付費期間產生的舊報告會依 7 天標準被清掉」——這點已寫進隱私政策。
 */
async function cleanupExpiredReports(env: Env): Promise<void> {
  const live = env.REPORT_CLEANUP?.trim() === 'on';
  const now = Date.now();
  const freeCutoff = new Date(now - RETENTION_FREE_DAYS * 86_400_000).toISOString();

  // 只撈「連免費標準都超過」的，付費的再用 90 天二次過濾——一次查詢就夠
  const { data, error } = await supa(env)
    .from('reports')
    .select('report_id, user_id, created_at, rrweb_r2_key, screenshots_r2_key')
    .lt('created_at', freeCutoff)
    .order('created_at', { ascending: true })
    .limit(CLEANUP_BATCH);
  if (error) {
    console.error('[Cron] 報告清理查詢失敗:', error.message);
    return;
  }
  const rows = (data ?? []) as Array<{
    report_id: string;
    user_id: string | null;
    created_at: string;
    rrweb_r2_key: string | null;
    screenshots_r2_key: string | null;
  }>;
  if (!rows.length) return; // 沒有過期報告 → 靜默結束

  // 一次查完所有相關用戶的方案與有效票券（不要每筆報告各查一次）
  const userIds = [...new Set(rows.map((r) => r.user_id).filter((x): x is string => !!x))];
  const paid = new Set<string>();
  if (userIds.length) {
    const { data: users } = await supa(env)
      .from('users')
      .select('user_id, plan, day_pass_expires_at')
      .in('user_id', userIds);
    for (const u of (users ?? []) as Array<{
      user_id: string;
      plan?: string | null;
      day_pass_expires_at?: string | null;
    }>) {
      if (isActiveUser(u)) paid.add(u.user_id);
    }
    const { data: tickets } = await supa(env)
      .from('user_tickets')
      .select('user_id')
      .eq('status', 'ACTIVE')
      .gt('expires_at', new Date(now).toISOString())
      .in('user_id', userIds);
    for (const t of (tickets ?? []) as Array<{ user_id: string }>) paid.add(t.user_id);
  }

  const paidCutoff = now - RETENTION_PAID_DAYS * 86_400_000;
  const doomed: typeof rows = [];
  let freeCount = 0;
  let paidCount = 0;
  let orphan = 0;
  for (const r of rows) {
    if (!r.user_id) {
      // 沒有 user_id（PM-133 認證上線前的舊報告）→ 無法判定方案，**不刪**。
      // 寧可留著也不要無主刪除；數量會回報給 FOX 另行處理。
      orphan++;
      continue;
    }
    if (paid.has(r.user_id)) {
      if (new Date(r.created_at).getTime() < paidCutoff) {
        doomed.push(r);
        paidCount++;
      }
    } else {
      doomed.push(r);
      freeCount++;
    }
  }

  if (!doomed.length) {
    if (orphan) console.log(`[Cron] 報告清理：無可刪項目（略過 ${orphan} 筆無 user_id）`);
    return;
  }

  let r2Deleted = 0;
  if (live) {
    // 先刪 R2 再刪 DB：反過來的話 DB 一旦刪掉，R2 檔案就再也查不到 key，永遠成為孤兒。
    // R2 delete 是冪等的，這一步失敗下次 cron 會重試。
    for (const r of doomed) {
      for (const key of [r.rrweb_r2_key, r.screenshots_r2_key]) {
        if (!key) continue;
        try {
          await env.R2.delete(key);
          r2Deleted++;
        } catch (e) {
          console.error('[Cron] R2 刪除失敗:', key, String(e));
        }
      }
    }
    const { error: delErr } = await supa(env)
      .from('reports')
      .delete()
      .in('report_id', doomed.map((r) => r.report_id));
    if (delErr) {
      console.error('[Cron] 報告刪除失敗:', delErr.message);
      return;
    }
  }

  const mode = live ? '' : '（dry-run，未實際刪除）';
  const capped = rows.length >= CLEANUP_BATCH ? `\n⚠ 本次掃描達單次上限 ${CLEANUP_BATCH} 筆，剩餘明天繼續` : '';
  const orphanLine = orphan ? `\n⏭ 略過 ${orphan} 筆無 user_id 的舊報告（無法判定方案）` : '';
  console.log(
    `[Cron] 報告清理${mode}：免費 ${freeCount} 筆、付費 ${paidCount} 筆、R2 ${r2Deleted} 個檔案、略過 ${orphan} 筆`,
  );
  await sendDiscord(
    env,
    `🧹 報告清理${mode}`,
    `免費版：${freeCount} 筆（超過 ${RETENTION_FREE_DAYS} 天）\n付費版：${paidCount} 筆（超過 ${RETENTION_PAID_DAYS} 天）\nR2 附件：${r2Deleted} 個${orphanLine}${capped}`,
    3,
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    env.__ctx = ctx; // PM-268：供 notifyFox 用 waitUntil 送非阻塞推播（回應後 isolate 才回收）
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
      const res = html(homePage(getLang(request), request, explicitLang(request))); // PM-172：傳 request 供 IP 國家判斷
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    // PM-152：guide/faq/privacy 依語言變動——no-store 避免 CF 跨語言快取誤送
    if (request.method === 'GET' && path === '/privacy') {
      const res = html(privacyPage(getLang(request), explicitLang(request))); // PM-64/152
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    if (request.method === 'GET' && path === '/guide') {
      const res = html(guidePage(getLang(request), explicitLang(request))); // PM-66/152
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    if (request.method === 'GET' && path === '/faq') {
      const res = html(faqPage(getLang(request), explicitLang(request))); // PM-66/152
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }

    // ── PM-328：故意出錯的測試頁（解掉 313-3 LIMIT）────────────────────────
    //   用途：讓 bridge 的 get_browser_errors 能在真實頁面上驗到 network_errors。
    //   ⚠ 一律 noindex：這頁會噴一堆錯誤，被 Google 收錄只會誤導使用者，也不放進 sitemap。
    if (request.method === 'GET' && path === '/api/test-error-500') {
      // 同源的 500，供測試頁 fetch。**不放外部服務**——CSP 的 connect-src 只允許 'self'，
      // 打第三方會變成 CSP 違規（TypeError），而不是我們要測的 5xx 網路錯誤。
      return new Response(JSON.stringify({ error: 'intentional_test_error', by: 'PM-328' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
      });
    }
    if (request.method === 'GET' && path === '/test-errors') {
      const res = html(testErrorsPage());
      res.headers.set('Cache-Control', 'no-store');
      res.headers.set('X-Robots-Tag', 'noindex, nofollow');
      return res;
    }
    // PM-280：/install 已併入 /guide → 301 永久重導（舊連結、書籤、社群貼文、既有外部連結都不會斷，
    //   SEO 權重也會轉移到 /guide）。保留 ?lang= 讓多語連結不掉語言。
    if (request.method === 'GET' && path === '/install') {
      const to = new URL('/guide', request.url);
      const q = url.searchParams.get('lang');
      if (q) to.searchParams.set('lang', q);
      // ⚠ 不能用 Response.redirect()——它回傳的 headers 是 **immutable**，而本 Worker 在統一出口
      //   會對每個回應 headers.set() 注入 CORS，碰到不可變 headers 會拋錯 → 整支變 500。
      //   （檔案最上方 workers.dev→bugezy.dev 那個 redirect 沒事，是因為它在 CORS 包裝之外就 return 了。）
      return new Response(null, { status: 301, headers: { Location: to.href } });
    }
    if (request.method === 'GET' && path === '/features') {
      const res = html(featuresPage(getLang(request), explicitLang(request))); // PM-96/151
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    // PM-201：AI 客服手冊（SKILL.md）——檢視頁 + 下載檔案
    if (request.method === 'GET' && path === '/skill') {
      const res = html(skillPage(getLang(request), explicitLang(request)));
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
      return json({ latest: '1.1.5', changelog_url: 'https://bugezy.dev/changelog' }); // PM-282：v1.1.5 送審
    }
    // PM-272：用戶心得頁（文字 + YouTube 嵌入）
    if (request.method === 'GET' && path === '/testimonials') {
      const res = html(testimonialsPage(getLang(request), explicitLang(request)));
      res.headers.set('Cache-Control', 'no-store'); // 與其他多語頁一致，防邊緣快取跨語言誤送
      return res;
    }
    if (request.method === 'GET' && path === '/changelog') {
      const res = html(changelogPage(getLang(request), explicitLang(request))); // PM-126/151
      res.headers.set('Cache-Control', 'no-store');
      return res;
    }
    // PM-256：部落格列表 + 單篇文章（SEO）。/blog 列表；/blog/{slug} 單篇（找不到 → 404）。
    if (request.method === 'GET' && path === '/blog') {
      const res = html(blogListPage(getLang(request), explicitLang(request)));
      res.headers.set('Cache-Control', 'no-store'); // 依語言變動
      return res;
    }
    if (request.method === 'GET' && path.startsWith('/blog/')) {
      const slug = path.slice('/blog/'.length);
      const post = BLOG_POSTS.find((p) => p.slug === slug);
      if (post) {
        const res = html(blogPostPage(post, getLang(request), explicitLang(request)));
        res.headers.set('Cache-Control', 'no-store');
        return res;
      }
      return new Response('Not Found', { status: 404 });
    }
    // PM-174：問題回報頁 + 提交端點（不需登入）
    if (request.method === 'GET' && path === '/feedback') {
      const res = html(feedbackPage(getLang(request), explicitLang(request)));
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
    if (request.method === 'GET' && path === '/hornet-real.png') return hornetPng();
    // PM-228：Official MCP Registry 的 HTTP 域名驗證——證明 bugezy.dev 擁有權（namespace dev.bugezy/*）。
    //   內容為 Ed25519 公鑰（可公開），對應私鑰僅本機持有、不進 repo。
    if (request.method === 'GET' && path === '/.well-known/mcp-registry-auth') {
      return new Response(
        'v=MCPv1; k=ed25519; p=yhzcLU4h8ci9whJBdvf7ReUCYBDBrhnbE75yfhiaEtU=',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } },
      );
    }
    // PM-222：首頁截圖（存 R2，白名單檔名防路徑穿越）。FOX 放 server/public/screenshots/，以 wrangler r2 object put 上傳。
    if (request.method === 'GET' && path.startsWith('/screenshots/')) {
      const name = path.slice('/screenshots/'.length);
      if (/^[a-z0-9-]+\.png$/.test(name)) {
        const obj = await env.R2.get(`public/screenshots/${name}`);
        if (obj) {
          return new Response(obj.body, {
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
          });
        }
      }
      return new Response('Not found', { status: 404 });
    }

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
        if (!(await isActiveUserId(userId, env)).active) {
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
        if (!(await isActiveUserId(userId, env)).active) {
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
      // PM-266：活動代碼兌換 + 票券錢包（三支皆需登入，未帶 token → 401）
      if (request.method === 'POST' && path === '/api/promo/redeem') {
        return await redeemPromoCode(request, env);
      }
      if (request.method === 'POST' && path === '/api/promo/activate') {
        return await activateTicket(request, env);
      }
      if (request.method === 'GET' && path === '/api/promo/wallet') {
        return await getTicketWallet(request, env);
      }
      // PM-276：安裝碼——用戶查自己的（需登入）／FOX 反查歸屬（需 ADMIN_TOKEN）
      if (request.method === 'GET' && path === '/api/user/install-code') {
        return await getInstallCode(request, env);
      }
      if (request.method === 'GET' && path === '/api/admin/verify-install') {
        return await verifyInstallCode(request, env, url);
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
    // PM-289：HTML 內容會依 Accept-Language 變動（getLang → detectLang），必須宣告 Vary，
    //   否則中介快取／CDN 可能把某語言版本服給其他語言的使用者。放在 CORS 注入「之後」——
    //   上面那行會把 getCorsHeaders 的 `Vary: Origin` 覆寫回去，這裡要保留 Origin 再補上 Accept-Language。
    //   只加在 HTML：API 的 JSON 回應不隨語言變動，宣告了反而會不必要地切分快取。
    if ((response.headers.get('Content-Type') || '').startsWith('text/html')) {
      response.headers.set('Vary', 'Accept-Language, Origin');
    }
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
    // PM-284：票券到期前 10 天推 Discord 提醒（每張票只推一次）
    try {
      await notifyExpiringTickets(env);
    } catch (err) {
      console.error('[Cron] 票券到期提醒失敗:', err);
    }
    // PM-292：報告自動清理（免費 7 天 / 付費 90 天）——預設 dry-run，見函式註解
    try {
      await cleanupExpiredReports(env);
    } catch (err) {
      console.error('[Cron] 報告清理失敗:', err);
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
      // PM-267：活動票券生效視同付費，不受免費版錄製額度限制
      const uuPaid = isActiveUser(uu) || (await hasActiveTicket(authUserId, env));
      if (hasRrweb && !uuPaid) {
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

  // PM-268：新報告推播（低優先 2；訪客未登入時 authUserId 為 null → 標示為訪客）
  if (authUserId) {
    notifyFoxForUser(env, authUserId, '🐛 新報告', (email) => `${email} 提交了新報告`, 2);
  } else {
    notifyFox(env, '🐛 新報告', '訪客提交了新報告', 2);
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
    if (!(await isActiveUserId(userId, env)).active) {
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
  // PM-232：zh-CN → 簡體 prompt；PM-233~235：ja/ko/vi → 日/韓/越語 prompt
  const isEn = language === 'en';
  const isCn = language === 'zh-CN';
  const isJa = language === 'ja';
  const isKo = language === 'ko';
  const isVi = language === 'vi';
  const sysContent = isEn
    ? "You are a bug report summarizer. Condense the user's voice description into 2-5 key points. Keep critical info (what element, what problem, expected behavior). Remove repetition and filler. Output in English, bullet points."
    : isJa
      ? 'あなたはバグレポートの要約者です。ユーザーの音声説明を 2〜5 個の要点にまとめてください。重要な情報（どの要素か、どんな問題か、期待される挙動）を残し、繰り返しや冗長な口語表現を取り除いてください。日本語（敬体）で、箇条書きで出力してください。'
      : isKo
        ? '당신은 버그 리포트 요약 도우미입니다. 사용자의 음성 설명을 2~5개의 핵심으로 요약하세요. 핵심 정보(어떤 요소, 어떤 문제, 기대 동작)를 유지하고 반복과 군더더기 구어체를 제거하세요. 한국어(합니다체)로 불릿 형식으로 출력하세요.'
        : isVi
          ? 'Bạn là trợ lý tóm tắt báo cáo lỗi. Hãy tóm tắt phần mô tả bằng giọng nói của người dùng thành 2-5 điểm chính. Giữ lại thông tin quan trọng (phần tử nào, vấn đề gì, hành vi mong đợi), loại bỏ lặp lại và từ đệm khẩu ngữ. Xuất ra bằng tiếng Việt, dạng gạch đầu dòng.'
          : isCn
            ? toSimplified('你是 Bug 報告精簡助手。把使用者的語音描述精簡成 2-5 個重點。保留關鍵資訊（什麼元素、什麼問題、預期行為），去除重複和口語贅詞。用簡體中文，條列式輸出。')
            : '你是 Bug 報告精簡助手。把使用者的語音描述精簡成 2-5 個重點。保留關鍵資訊（什麼元素、什麼問題、預期行為），去除重複和口語贅詞。用繁體中文，條列式輸出。';
  const userContent = isEn
    ? `Please summarize the following voice log:\n\n${text}`
    : isJa
      ? `次の音声記録を要約してください：\n\n${text}`
      : isKo
        ? `다음 음성 기록을 요약해 주세요:\n\n${text}`
        : isVi
          ? `Vui lòng tóm tắt bản ghi giọng nói sau:\n\n${text}`
          : isCn
            ? `${toSimplified('請精簡以下語音記錄')}：\n\n${text}`
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
  // PM-232：zh-CN → 簡體 prompt（繁體 t2s 轉換）；PM-233~235：ja/ko/vi → 日/韓/越語 prompt
  const isEn = language === 'en';
  const isCn = language === 'zh-CN';
  const isJa = language === 'ja';
  const isKo = language === 'ko';
  const isVi = language === 'vi';
  const viSys = `Bạn là chuyên gia hiệu đính văn bản nhận dạng giọng nói tiếng Việt. Đầu vào chắc chắn là kết quả thô của nhận dạng giọng nói tiếng Việt, có thể có lỗi đồng âm và từ đệm khẩu ngữ. Chỉ thực hiện "hiệu đính", xuất ra văn bản tiếng Việt đã hiệu đính.

Quy tắc:
1. Sửa lỗi chính tả đồng âm
2. Loại bỏ từ đệm khẩu ngữ (ừm, à, thì, kiểu như, đại loại là)
3. Giữ nguyên thuật ngữ kỹ thuật bằng tiếng Anh (console error, TypeError, 404, undefined, null, fetch, API)
4. Số và mã trạng thái HTTP dùng chữ số (năm trăm → 500, bốn không bốn → 404)
5. Giữ nguyên ý nghĩa và thứ tự mô tả gốc, không viết lại, không tóm tắt, không thêm nội dung
6. Thêm dấu câu phù hợp để dễ đọc
7. Nếu văn bản gốc đã chính xác thì trả về nguyên vẹn
8. Dù đầu vào có lộn xộn đến đâu, luôn phải xuất ra văn bản tiếng Việt đã hiệu đính. Tuyệt đối không trả lời "không thể nhận dạng", "vui lòng cung cấp văn bản đúng" hoặc yêu cầu nhập lại.

Chỉ trả về văn bản đã hiệu đính, không thêm bất kỳ giải thích hay tiền tố nào.`;
  const koSys = `당신은 한국어 음성 인식 텍스트의 교정 전문가입니다. 입력은 반드시 한국어 음성 인식의 원본 결과이며, 동음 오타나 구어체 군더더기가 포함될 수 있습니다. "교정"만 수행하고, 교정된 한국어 텍스트를 출력하세요.

규칙:
1. 동음 오타를 수정한다
2. 구어체 군더더기(음, 어, 그, 그러니까, 뭐랄까)를 제거한다
3. 기술 용어는 영어 원문 그대로 유지한다(console error, TypeError, 404, undefined, null, fetch, API)
4. 숫자와 HTTP 상태 코드는 아라비아 숫자로(오백 → 500, 사공사 → 404)
5. 원래 의미와 설명 순서를 유지하고, 다시 쓰거나 요약하거나 내용을 추가하지 않는다
6. 적절히 문장 부호를 추가하여 읽기 쉽게 한다
7. 원문이 이미 정확하면 그대로 반환한다
8. 입력이 아무리 어수선해도 반드시 교정된 한국어 텍스트를 출력할 것. "인식할 수 없습니다", "올바른 텍스트를 제공해 주세요" 같은 답변이나 재입력 요청은 절대 하지 말 것.

교정된 텍스트만 반환하고, 설명이나 접두어는 일절 붙이지 마세요.`;
  const jaSys = `あなたは日本語の音声認識テキストの校正専門家です。入力は必ず日本語の音声認識の生の結果で、同音の誤字や口語的な冗長表現が含まれる可能性があります。「校正」のみを行い、校正後の日本語テキストを出力してください。

ルール：
1. 同音の誤字を修正する
2. 口語的な冗長表現（えー、あの、まあ、そのー、なんか）を取り除く
3. 技術用語は英語のまま保持する（console error、TypeError、404、undefined、null、fetch、API）
4. 数字と HTTP ステータスコードは半角数字で（五百 → 500、四〇四 → 404）
5. 元の意味と説明の順序を保持し、書き換え・要約・追加をしない
6. 適切に句読点を加えて読みやすくする
7. 元の文がすでに正しい場合はそのまま返す
8. 入力がどれほど乱れていても、必ず校正後の日本語テキストを出力すること。「認識できません」「正しいテキストを提供してください」などの返答や、再入力の要求は絶対にしないこと。

校正後のテキストのみを返し、説明や前置きは一切加えないでください。`;
  const zhSys = `你是繁體中文語音轉文字的校對專家。輸入一定是中文語音辨識的原始結果，可能有同音錯字與口語贅字。請只做「校正」，輸出校正後的中文文字。

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
    : isJa
      ? jaSys
      : isKo
        ? koSys
        : isVi
          ? viSys
          : isCn
            ? toSimplified(zhSys)
            : zhSys;
  const userContent = isEn
    ? `Please correct the following speech recognition text:\n${text}`
    : isJa
      ? `次の音声認識テキストを校正してください：\n${text}`
      : isKo
        ? `다음 음성 인식 텍스트를 교정해 주세요:\n${text}`
        : isVi
          ? `Vui lòng hiệu đính văn bản nhận dạng giọng nói sau:\n${text}`
          : isCn
            ? `${toSimplified('請校正以下語音辨識文字')}：\n${text}`
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
  // PM-267：活動票券生效視同付費（popup 會讓票券用戶選精準轉錄，這裡不放行就會 403 打臉）
  if (!isActiveUser(u) && !(await hasActiveTicket(userId, env))) {
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

  // PM-232：zh-CN（簡體）——Whisper 語言碼只有 'zh'，改用 zh 辨識，但用簡體 prompt 引導簡體輸出。
  const wantSimplified = language === 'zh-CN';
  // PM-137/140：語言白名單（防濫用；非白名單一律 fallback zh）。
  // PM-233/234/235：解鎖 ja（日）、ko（韓）、vi（越）——Whisper 原生支援品質佳。七語全開。
  const ALLOWED_LANGS = ['zh', 'yue', 'en', 'ja', 'ko', 'vi'];
  const finalLang = ALLOWED_LANGS.includes(language) ? language : 'zh';

  // 3. 呼叫 Groq Whisper API
  const groqForm = new FormData();
  groqForm.append('file', audioBlob, 'audio.webm');
  groqForm.append('model', 'whisper-large-v3-turbo');
  groqForm.append('language', finalLang); // PM-137：使用者選的語言（預設 zh）
  groqForm.append('response_format', 'verbose_json');
  // PM-214：Groq Whisper 的 language 只控制辨識語言、不控制簡/繁輸出。台灣市場統一繁體——
  //   對中文與粵語加 prompt 引導繁體中文輸出（不影響辨識準確度；en 與日韓越不需要）。
  if (wantSimplified) {
    groqForm.append('prompt', '以下是简体中文的语音转录内容。'); // PM-232：簡體引導
  } else if (finalLang === 'ja') {
    groqForm.append('prompt', '以下は日本語の音声文字起こしです。'); // PM-233：日語引導
  } else if (finalLang === 'ko') {
    groqForm.append('prompt', '다음은 한국어 음성 텍스트 변환입니다.'); // PM-234：韓語引導
  } else if (finalLang === 'vi') {
    groqForm.append('prompt', 'Sau đây là nội dung chuyển đổi giọng nói tiếng Việt.'); // PM-235：越南語引導
  } else if (finalLang === 'zh' || finalLang === 'yue') {
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
    // PM-232：prompt 引導後仍可能夾繁體字，保險用 t2s 轉全簡體
    const rawText = result.text ?? '';
    const rawSegs = result.segments ?? [];
    return json({
      ok: true,
      text: wantSimplified ? toSimplified(rawText) : rawText,
      segments: wantSimplified
        ? rawSegs.map((s) => ({ ...s, text: toSimplified(s.text) }))
        : rawSegs,
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
      // PM-277：一併回傳 install_code，讓 popup 少打一支 API（開 popup 時併發請求越少越好）
      .select(
        'plan, recording_count, rewind_count, mcp_count, usage_reset_at, plan_expires_at, day_pass_expires_at, install_code',
      )
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
      install_code: string | null; // PM-277
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

    // PM-266：ACTIVE 票券到期 → 自動標 USED（與上面 cancelled/day_pass 自動降級同一段）
    await expireDueTickets(userId, env);
    const nowIso = now.toISOString();
    const { data: activeTickets } = await supa(env)
      .from('user_tickets')
      .select('id, code, duration_days, expires_at')
      .eq('user_id', userId)
      .eq('status', 'ACTIVE')
      .gt('expires_at', nowIso)
      .order('expires_at', { ascending: false });
    const { data: savedTickets } = await supa(env)
      .from('user_tickets')
      .select('id, code, duration_days, created_at')
      .eq('user_id', userId)
      .eq('status', 'SAVED')
      .order('created_at', { ascending: true });
    const activeTicketRows = (activeTickets ?? []) as Array<{
      id: string;
      code: string;
      duration_days: number;
      expires_at: string;
    }>;
    const savedTicketRows = (savedTickets ?? []) as Array<{
      id: string;
      code: string;
      duration_days: number;
      created_at: string;
    }>;

    // PM-73/109：cancelled 未到期、day_pass 未到期皆視同付費（享無限功能）
    // PM-266：持有 ACTIVE 未到期票券同樣視同付費（limits 一併變 null = 無限）
    const isPaid = isActiveUser(u) || activeTicketRows.length > 0;
    return jsonNoStore({
      plan: u.plan ?? 'free',
      isPaid, // PM-266：popup 可直接讀（票券用戶 plan 仍是 free，但 isPaid=true）
      // PM-277：安裝碼併進本回應（原本 popup 另打 /api/user/install-code，開 popup 時
      //   併發請求越多越容易被 /api/ 的 rate limit 擋掉）。欄位已在上面一起 select，
      //   為 null 才補發（舊用戶）。
      install_code: u.install_code ?? (await ensureInstallCode(userId, env)),
      tickets: {
        active: activeTicketRows[0]
          ? {
              ticket_id: activeTicketRows[0].id,
              code: activeTicketRows[0].code,
              duration_days: activeTicketRows[0].duration_days,
              expires_at: activeTicketRows[0].expires_at,
              days_left: Math.max(
                0,
                Math.ceil((new Date(activeTicketRows[0].expires_at).getTime() - now.getTime()) / 86_400_000),
              ),
            }
          : null,
        saved: savedTicketRows.map((s) => ({
          ticket_id: s.id,
          code: s.code,
          duration_days: s.duration_days,
          created_at: s.created_at,
        })),
        savedCount: savedTicketRows.length,
        free_until: activeTicketRows[0]?.expires_at ?? null,
      },
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

// GET /api/user/install-code — 用戶查自己的安裝碼（popup 顯示用；沒有就當場產一組）
async function getInstallCode(request: Request, env: Env): Promise<Response> {
  const userId = await getAuthUserId(request, env);
  if (!userId) return jsonNoStore({ error: 'unauthorized' }, 401);
  const code = await ensureInstallCode(userId, env);
  return jsonNoStore({ install_code: code });
}

/**
 * GET /api/admin/verify-install?code=BZ-XXXX — FOX 用安裝碼反查用戶（推廣活動驗身份）。
 *
 * ⚠ 這支會吐出 email，等於「知道安裝碼就能拿到信箱」。安裝碼只有 ~92 萬組合，
 *   沒有保護的話是可以暴力枚舉的，所以：**未設 ADMIN_TOKEN 就整支當作不存在（404）**，
 *   而不是預設開放。回應也一律 404 而非 401/403，避免這支端點的存在本身被探測出來。
 */
async function verifyInstallCode(request: Request, env: Env, url: URL): Promise<Response> {
  const admin = env.ADMIN_TOKEN?.trim();
  const provided = (request.headers.get('x-admin-token') || extractBearer(request) || '').trim();
  if (!admin || provided !== admin) return jsonNoStore({ error: 'not found' }, 404);

  const code = (url.searchParams.get('code') || '').trim().toUpperCase();
  if (!code) return jsonNoStore({ error: 'missing code' }, 400);
  const { data, error } = await supa(env)
    .from('users')
    .select('email, install_code, created_at, plan')
    .eq('install_code', code)
    .maybeSingle();
  if (error) {
    console.error('verify-install 查詢失敗:', error.message);
    return jsonNoStore({ error: GENERIC_500 }, 500);
  }
  if (!data) return jsonNoStore({ found: false });
  const u = data as { email: string; install_code: string; created_at: string; plan: string | null };
  return jsonNoStore({
    found: true,
    email: u.email,
    install_code: u.install_code,
    created_at: u.created_at,
    plan: u.plan ?? 'free',
  });
}

// ── PM-266：活動代碼兌換 + 票券錢包 ─────────────────────────────────────────
// 票券生命週期：SAVED（已兌換、未啟用、不計時）→ ACTIVE（啟用倒數）→ USED（到期）。
// 啟用時會「疊加」——基準日 = MAX(現有到期日, NOW())，故不會浪費既有的付費/票券天數。

interface TicketRow {
  id: string;
  code: string;
  duration_days: number;
  status: string;
  activated_at: string | null;
  expires_at: string | null;
  created_at: string;
}

/** PM-266：把該用戶已過期的 ACTIVE 票券標成 USED（getUserPlan / wallet 進來時順手收斂）。 */
async function expireDueTickets(userId: string, env: Env): Promise<void> {
  const nowIso = new Date().toISOString();
  const { data: due } = await supa(env)
    .from('user_tickets')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'ACTIVE')
    .lt('expires_at', nowIso)
    .limit(1);
  if (!due?.length) return;
  await supa(env)
    .from('user_tickets')
    .update({ status: 'USED' })
    .eq('user_id', userId)
    .eq('status', 'ACTIVE')
    .lt('expires_at', nowIso);
}

/**
 * PM-398：需要「已完成 MCP 對接」才能兌換的代碼。
 * 用 Set 而不是寫死字串比對——之後要再發同類代碼只要加一行。
 */
const MCP_VERIFIED_CODES = new Set(['MCP30']);

/**
 * 這個帳號有沒有 MCP 呼叫紀錄。
 *
 * 回傳 `null` 代表**查不出來**（例如 `user_id` 欄位還沒建），與「確定沒有」要分開處理：
 * 前者是系統設定問題，不該讓使用者以為是自己沒接好。
 */
async function hasMcpUsage(userId: string, env: Env): Promise<boolean | null> {
  const { data, error } = await supa(env)
    .from('mcp_usage')
    .select('id')
    .eq('user_id', userId)
    .limit(1);
  if (error) {
    console.error('mcp_usage 查詢失敗（user_id 欄位可能尚未建立）:', error.message);
    return null;
  }
  return (data?.length ?? 0) > 0;
}

// POST /api/promo/redeem — 兌換活動代碼，成功後票券進錢包（SAVED，尚未開始計時）
async function redeemPromoCode(request: Request, env: Env): Promise<Response> {
  const userId = await getAuthUserId(request, env);
  if (!userId) return jsonNoStore({ error: 'unauthorized' }, 401);
  try {
    const body = (await request.json().catch(() => ({}))) as { code?: string };
    // 代碼一律轉大寫去空白比對（使用者常打小寫／貼上帶空白）
    const code = (body.code ?? '').trim().toUpperCase();
    if (!code) return jsonNoStore({ error: '請輸入活動代碼' }, 400);

    const { data: promo, error: promoErr } = await supa(env)
      .from('promo_codes')
      .select('code, description, duration_days, code_type, max_uses, current_uses, is_active, code_expires_at')
      .eq('code', code)
      .maybeSingle();
    if (promoErr) {
      console.error('promo 查詢失敗:', promoErr.message);
      return jsonNoStore({ error: GENERIC_500 }, 500);
    }
    // 不存在與已停用回同一句，避免被拿來窮舉探測哪些代碼存在
    if (!promo || !promo.is_active) return jsonNoStore({ error: '無效的活動代碼' }, 400);

    const p = promo as {
      code: string;
      duration_days: number;
      max_uses: number | null;
      current_uses: number;
      code_expires_at: string | null;
    };
    if (p.code_expires_at && new Date(p.code_expires_at) <= new Date()) {
      return jsonNoStore({ error: '此代碼已過期' }, 400);
    }
    if (p.max_uses !== null && p.current_uses >= p.max_uses) {
      return jsonNoStore({ error: '此代碼已達兌換上限' }, 400);
    }

    // 先擋重複兌換（DB 的 UNIQUE(user_id, code) 是最終防線，這裡提早回友善訊息）
    const { data: existing } = await supa(env)
      .from('user_tickets')
      .select('id')
      .eq('user_id', userId)
      .eq('code', code)
      .limit(1);
    if (existing?.length) return jsonNoStore({ error: '你已兌換過此代碼' }, 409);

    // PM-398：MCP 對接專屬代碼 —— 要有實際的 MCP 呼叫紀錄才發。
    //   **擺在重複兌換檢查之後、搶名額之前**：資格不符的人不該占掉限量代碼的名額。
    if (MCP_VERIFIED_CODES.has(code)) {
      const used = await hasMcpUsage(userId, env);
      if (used === null) {
        // 查不出來 → **不發**（fail closed）。反過來寫的話，資料庫一出問題就變成人人可領。
        //   但訊息要與「你還沒接 MCP」區分開，否則使用者會一直重試自己根本沒做錯的事。
        return jsonNoStore({ error: '目前無法驗證 MCP 使用紀錄，請稍後再試或聯絡我們。' }, 503);
      }
      if (!used) {
        return jsonNoStore(
          {
            error: '請先完成 MCP 對接並實際使用一次，再輸入此代碼。教學請見 https://bugezy.dev/guide',
            need_mcp: true,
          },
          403,
        );
      }
    }

    // 有名額上限的代碼：先「搶名額」再發票券。
    // PostgREST 不支援 `current_uses = current_uses + 1` 這種欄位運算，故用 compare-and-swap：
    // 只在 current_uses 仍等於剛讀到的值時才寫入 +1；併發時只有一個請求會更新到列，
    // 其餘讀到新值後重試 → 不會超發（BUZZ100 這種限量碼的關鍵）。
    let reserved = false;
    if (p.max_uses !== null) {
      let seen = p.current_uses;
      for (let i = 0; i < 5 && !reserved; i++) {
        if (seen >= p.max_uses) return jsonNoStore({ error: '此代碼已達兌換上限' }, 400);
        const { data: bumped } = await supa(env)
          .from('promo_codes')
          .update({ current_uses: seen + 1 })
          .eq('code', code)
          .eq('current_uses', seen) // ← CAS 條件
          .select('current_uses');
        if (bumped?.length) {
          reserved = true;
          break;
        }
        const { data: fresh } = await supa(env)
          .from('promo_codes')
          .select('current_uses')
          .eq('code', code)
          .maybeSingle();
        seen = (fresh as { current_uses: number } | null)?.current_uses ?? seen + 1;
      }
      if (!reserved) return jsonNoStore({ error: '此代碼已達兌換上限' }, 400);
    }

    const { data: ticket, error: insErr } = await supa(env)
      .from('user_tickets')
      .insert({ user_id: userId, code, duration_days: p.duration_days })
      .select('id, code, duration_days, status, created_at')
      .maybeSingle();

    if (insErr || !ticket) {
      // 發券失敗 → 把剛搶下的名額補回去（best-effort 補償，避免名額被白吃掉）
      if (reserved) {
        const { data: cur } = await supa(env)
          .from('promo_codes')
          .select('current_uses')
          .eq('code', code)
          .maybeSingle();
        const now = (cur as { current_uses: number } | null)?.current_uses;
        if (typeof now === 'number' && now > 0) {
          await supa(env)
            .from('promo_codes')
            .update({ current_uses: now - 1 })
            .eq('code', code)
            .eq('current_uses', now);
        }
      }
      // 23505 = UNIQUE(user_id, code) —— 兩個請求同時兌換同一碼時的最終防線
      if (insErr?.code === '23505') return jsonNoStore({ error: '你已兌換過此代碼' }, 409);
      console.error('發券失敗:', insErr?.message);
      return jsonNoStore({ error: GENERIC_500 }, 500);
    }

    // 無上限代碼（max_uses = NULL）：發券成功後才記次數，純統計用途，不影響資格
    if (p.max_uses === null) {
      await supa(env)
        .from('promo_codes')
        .update({ current_uses: p.current_uses + 1 })
        .eq('code', code)
        .eq('current_uses', p.current_uses);
    }

    const t = ticket as TicketRow;
    // PM-268：推播（waitUntil 非阻塞）
    notifyFoxForUser(
      env,
      userId,
      '🎫 代碼兌換',
      (email) => `${email} 兌換了 ${t.code}（${t.duration_days} 天）`,
    );
    return jsonNoStore(
      {
        ticket_id: t.id,
        code: t.code,
        duration_days: t.duration_days,
        status: t.status,
        message: '兌換成功',
      },
      201,
    );
  } catch (err) {
    console.error('redeem error:', err);
    return jsonNoStore({ error: GENERIC_500 }, 500);
  }
}

// POST /api/promo/activate — 啟用一張 SAVED 票券（到期日疊加在現有付費/票券之後）
async function activateTicket(request: Request, env: Env): Promise<Response> {
  const userId = await getAuthUserId(request, env);
  if (!userId) return jsonNoStore({ error: 'unauthorized' }, 401);
  try {
    const body = (await request.json().catch(() => ({}))) as { ticket_id?: string };
    const ticketId = (body.ticket_id ?? '').trim();
    if (!ticketId) return jsonNoStore({ error: '缺少 ticket_id' }, 400);

    // 一定要同時比對 user_id，避免拿別人的 ticket_id 來啟用
    const { data: ticket } = await supa(env)
      .from('user_tickets')
      .select('id, code, duration_days, status')
      .eq('id', ticketId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!ticket) return jsonNoStore({ error: '找不到票券' }, 404);
    const t = ticket as { id: string; code: string; duration_days: number; status: string };
    if (t.status !== 'SAVED') {
      return jsonNoStore(
        { error: t.status === 'ACTIVE' ? '此票券已在使用中' : '此票券已使用完畢' },
        400,
      );
    }

    // 疊加：基準日 = MAX(現有所有未到期的到期日, NOW())
    const now = new Date();
    const candidates: number[] = [now.getTime()];
    const { data: actives } = await supa(env)
      .from('user_tickets')
      .select('expires_at')
      .eq('user_id', userId)
      .eq('status', 'ACTIVE')
      .gt('expires_at', now.toISOString());
    for (const a of (actives ?? []) as Array<{ expires_at: string | null }>) {
      if (a.expires_at) candidates.push(new Date(a.expires_at).getTime());
    }
    const { data: user } = await supa(env)
      .from('users')
      .select('plan_expires_at, day_pass_expires_at')
      .eq('user_id', userId)
      .maybeSingle();
    const u = user as { plan_expires_at: string | null; day_pass_expires_at: string | null } | null;
    for (const d of [u?.plan_expires_at, u?.day_pass_expires_at]) {
      if (d && new Date(d) > now) candidates.push(new Date(d).getTime());
    }

    const base = Math.max(...candidates);
    const expiresAt = new Date(base + t.duration_days * 86_400_000);

    const { data: updated, error: updErr } = await supa(env)
      .from('user_tickets')
      .update({ status: 'ACTIVE', activated_at: now.toISOString(), expires_at: expiresAt.toISOString() })
      .eq('id', t.id)
      .eq('user_id', userId)
      .eq('status', 'SAVED') // ← 併發保護：只有第一個請求會啟用成功
      .select('id, code, duration_days, status, activated_at, expires_at')
      .maybeSingle();
    if (updErr || !updated) {
      console.error('啟用票券失敗:', updErr?.message);
      return jsonNoStore({ error: GENERIC_500 }, 500);
    }
    const r = updated as TicketRow;
    // PM-268：推播（waitUntil 非阻塞）
    notifyFoxForUser(
      env,
      userId,
      '🚀 票券啟用',
      (email) => `${email} 啟用了 ${r.code}，到期 ${(r.expires_at ?? '').slice(0, 10)}`,
    );
    return jsonNoStore({
      ticket_id: r.id,
      code: r.code,
      duration_days: r.duration_days,
      status: r.status,
      activated_at: r.activated_at,
      expires_at: r.expires_at,
      message: '票券已啟用',
    });
  } catch (err) {
    console.error('activate error:', err);
    return jsonNoStore({ error: GENERIC_500 }, 500);
  }
}

// GET /api/promo/wallet — 票券錢包（使用中 + 庫存 + 免費到期日）
async function getTicketWallet(request: Request, env: Env): Promise<Response> {
  const userId = await getAuthUserId(request, env);
  if (!userId) return jsonNoStore({ error: 'unauthorized' }, 401);
  try {
    await expireDueTickets(userId, env); // 先把過期的 ACTIVE 收斂成 USED，回傳才是真實狀態
    const nowIso = new Date().toISOString();
    const { data: actives } = await supa(env)
      .from('user_tickets')
      .select('id, code, duration_days, expires_at')
      .eq('user_id', userId)
      .eq('status', 'ACTIVE')
      .gt('expires_at', nowIso)
      .order('expires_at', { ascending: false });
    const { data: saved } = await supa(env)
      .from('user_tickets')
      .select('id, code, duration_days, created_at')
      .eq('user_id', userId)
      .eq('status', 'SAVED')
      .order('created_at', { ascending: true });

    const activeRows = (actives ?? []) as Array<{
      id: string;
      code: string;
      duration_days: number;
      expires_at: string;
    }>;
    // free_until = 所有 ACTIVE 票券中最晚的到期日（已用 expires_at desc 排序，取第一筆）
    const freeUntil = activeRows[0]?.expires_at ?? null;
    const active = activeRows[0]
      ? {
          ticket_id: activeRows[0].id,
          code: activeRows[0].code,
          duration_days: activeRows[0].duration_days,
          expires_at: activeRows[0].expires_at,
          days_left: Math.max(
            0,
            Math.ceil((new Date(activeRows[0].expires_at).getTime() - Date.now()) / 86_400_000),
          ),
        }
      : null;
    const savedRows = (saved ?? []) as Array<{
      id: string;
      code: string;
      duration_days: number;
      created_at: string;
    }>;
    return jsonNoStore({
      active_ticket: active,
      saved_tickets: savedRows.map((s) => ({
        ticket_id: s.id,
        code: s.code,
        duration_days: s.duration_days,
        created_at: s.created_at,
      })),
      saved_count: savedRows.length,
      free_until: freeUntil,
    });
  } catch (err) {
    console.error('wallet error:', err);
    return jsonNoStore({ error: GENERIC_500 }, 500);
  }
}

// PM-363：唯讀的額度查詢。**刻意不遞增、也不觸發重置** —— 查詢額度不該改變額度，
// 否則「看一下還剩幾次」就會把 usage_reset_at 往後推、或被誤計成一次使用。
// 重置仍然只在 bumpUsage（真的用掉一次時）發生，這裡只回報「下次重置時間」。
async function readUsageQuota(
  userId: string,
  env: Env,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supa(env)
    .from('users')
    .select('plan, recording_count, rewind_count, mcp_count, day_pass_expires_at, usage_reset_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;

  const u = data as {
    plan: string | null;
    recording_count: number;
    rewind_count: number;
    mcp_count: number;
    day_pass_expires_at: string | null;
    usage_reset_at: string | null;
  };

  // 與 bumpUsage 完全相同的無限判定（含活動票券）——兩邊說法不一致的話，
  // 使用者會看到「無限次」卻在第 11 次被擋（PM-267 就踩過這個坑）。
  const ticket = await hasActiveTicket(userId, env);
  const unlimited = isActiveUser(u) || ticket;
  const tier = unlimited
    ? u.plan === 'day_pass'
      ? 'day_pass'
      : ticket && u.plan !== 'paid' && u.plan !== 'cancelled'
        ? 'ticket'
        : 'pro'
    : 'free';

  // PM-170 的重置是**距上次重置滿 30 天**的滾動制，不是曆月 1 號。
  // 這裡照實回報，不要編一個「下個月 1 號」的日期讓使用者對不上。
  const resetBase = u.usage_reset_at ? new Date(u.usage_reset_at) : null;
  const resetsAt = resetBase ? new Date(resetBase.getTime() + 30 * 86_400_000).toISOString() : null;

  if (unlimited) {
    return {
      tier,
      unlimited: true,
      limits: null,
      note: '目前方案沒有用量限制。',
    };
  }
  const mk = (used: number, max: number) => ({
    used,
    limit: max,
    remaining: Math.max(0, max - used),
  });
  return {
    tier,
    unlimited: false,
    recording: mk(u.recording_count || 0, FREE_LIMITS.recording),
    rewind: mk(u.rewind_count || 0, FREE_LIMITS.rewind),
    mcp: mk(u.mcp_count || 0, FREE_LIMITS.mcp),
    resets_at: resetsAt,
    reset_rule: '免費版用量在距上次重置滿 30 天後歸零（滾動制，不是每月 1 號）。',
    upgrade_url: 'https://bugezy.dev/checkout',
  };
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
    // PM-267：活動票券生效同樣無限——否則 popup 顯示「✨ 無限次」但第 11 次錄製會被這裡擋掉（前後端說法不一）
    if (isActiveUser(u) || (await hasActiveTicket(userId, env))) {
      return json({ ok: true, unlimited: true });
    }

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
    if (params.RtnCode === '1' && uid && !(await isEcpayActiveUserId(uid, env))) {
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
      // PM-268：升級成功才推播（失敗已在上面 return 500 讓綠界重送）
      notifyFoxForUser(env, userId, '💰 月費付款', (email) => `${email} 月費 NT$${amount} 成功`, 4);
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
    if (params.RtnCode === '1' && uid && !(await isEcpayActiveUserId(uid, env))) {
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
      // PM-268：開通成功才推播
      notifyFoxForUser(env, userId, '💰 日票付款', (email) => `${email} 日票 NT$${amount} 成功`, 4);
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
  // PM-436：黃底卡 + 三顆黑六角（設計稿畫面 30）。這頁是綠界付款完的 ClientBackURL，
  //   GET 進來沒有使用者身分，查不到 day_pass_expires_at → 膠囊寫「24 小時無限使用」，
  //   不做假的倒數（重整就會從 24:00:00 重來，那是騙人的）。見 DONE-436。
  const body =
    `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>日票啟動成功</title>` +
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    `<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@800&family=Noto+Sans+TC:wght@500;600;700;800&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet">` +
    `<style>:root{--y:#F7BE00;--ink:#14110B;--cream:#FFF4D6;--on-y:#3A2409;` +
    `--hex:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);` +
    `--font-ui:'Noto Sans TC',system-ui,'Microsoft JhengHei',sans-serif;` +
    `--font-mono:'JetBrains Mono',ui-monospace,monospace;}` +
    `*{box-sizing:border-box;}` +
    `body{margin:0;min-height:100vh;display:flex;justify-content:center;align-items:center;` +
    `padding:24px;background:var(--cream);color:var(--ink);font-family:var(--font-ui);}` +
    `.card{max-width:420px;padding:28px 24px;background:var(--y);border:2px solid var(--ink);` +
    `border-radius:14px;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;}` +
    `.hexes{display:flex;gap:8px;}` +
    `.hexes i{width:20px;height:23px;background:var(--ink);clip-path:var(--hex);}` +
    `h1{margin:0;font:800 22px/1.35 var(--font-ui);}` +
    `p{margin:0;max-width:360px;font:600 13.5px/1.8 var(--font-ui);color:var(--on-y);}` +
    `.pill{display:flex;align-items:center;gap:9px;padding:9px 16px;border-radius:999px;background:var(--ink);}` +
    `.pill i{width:8px;height:9px;background:var(--y);clip-path:var(--hex);animation:hz-pulse 1.4s infinite;}` +
    `.pill span{font:700 12.5px/1 var(--font-mono);color:var(--y);}` +
    `@keyframes hz-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}` +
    `@media (prefers-reduced-motion:reduce){.pill i{animation:none;}}` +
    `a.back{margin-top:2px;font:700 13px/1 var(--font-ui);color:var(--on-y);text-decoration:none;}` +
    `a.back:hover{color:var(--ink);}</style></head>` +
    `<body><div class="card">` +
    `<div class="hexes"><i></i><i></i><i></i></div>` +
    `<h1>日票已啟用</h1>` +
    `<p>接下來 24 小時全功能無限次使用（無限錄製 / MCP AI 讀取 / Whisper 精準語音）。` +
    `回到 BugEzy 就可以開始錄製，這個視窗可以關閉了。</p>` +
    `<div class="pill"><i></i><span>24 小時無限使用</span></div>` +
    `<a class="back" href="/">← 回到首頁</a>` +
    `</div></body></html>`;
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
    if (params.RtnCode === '1' && uid && !(await isEcpayActiveUserId(uid, env))) {
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
      // PM-268：展延成功才推播
      notifyFoxForUser(env, userId, '💰 續扣成功', (email) => `${email} 續扣 NT$${amount || 80} 成功`);
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
  /**
   * PM-401：呼叫端**已經驗證過**的使用者 id。
   *
   * 為什麼需要這個參數：Claude Connector 的 MCP 網址不帶 `?token=`，使用者的 token 是
   * 從**工具參數** `session_token` 傳進來的——而 `logMcpUsage` 看不到工具參數，
   * 只看得到 `env.__mcp_session_token`。結果是「用參數帶 token」的使用者一切正常，
   * 但用量永遠記不到 user_id，因此永遠拿不到 MCP30（PM-400 實測確認）。
   *
   * ⚠ **刻意不用「把 token 回填進 env」那個做法**：`mcpEnv` 是每個請求一份的副本，
   *   跨 await 去改它，正是 PM-190 在 `/mcp` 路由註解裡特別提醒要避免的競態樣式
   *   （同 isolate 併發時互相覆寫）。傳一個明確的值沒有這個風險，也好讀得多。
   *
   * ⚠ **只有驗證過 token 屬於該使用者之後才可以傳**，否則等於讓人隨便宣稱身分。
   *   目前四個呼叫端（list_reports / get_live_errors / get_terminal_logs / get_usage_quota）
   *   都是在比對成功之後才走到 txtWithTokens。
   */
  knownUserId?: string,
): Promise<void> {
  try {
    const key = supaKey(env); // PM-93：service_role（繞 RLS）或退回 anon
    // PM-398：**記下是誰呼叫的**。
    //   在此之前 mcp_usage 完全沒有使用者維度（PM-380 的稽核已標紅），
    //   所以既無法做 per-user 統計，也無法回答「這個帳號到底有沒有接上 MCP」——
    //   而 MCP30 票券的資格判定正是靠後者。
    // PM-401：身分有兩條來源，**優先用呼叫端已經驗證過的那個**（省一次查詢），
    //   沒有才退回 MCP URL 的 ?token=（每個請求一份 env 副本，見 /mcp 路由）。
    const token = env.__mcp_session_token || '';
    const userId = knownUserId || (token ? await verifySessionByToken(token, env) : null);

    const post = (row: Record<string, unknown>) =>
      fetch(`${env.SUPABASE_URL}/rest/v1/mcp_usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(row),
      });

    const base = {
      tool_name: toolName,
      tokens_estimated: est.bugezyTokens,
      chrome_tokens_estimated: est.chromeTokens,
      report_id: reportId ?? null,
    };
    if (!userId) {
      await post(base);
      return;
    }
    // 🔴 `user_id` 欄位要等 FOX 跑完 ALTER 才存在。**這裡必須有退路**：
    //    PostgREST 對未知欄位是整筆拒絕，而這支的錯誤是被吞掉的——
    //    先部署程式碼再跑 SQL 的話，全站的 MCP 用量記錄會**靜靜地停止寫入**，
    //    而且沒有任何人會發現。（同 PM-82 對 allow_screenshot_images 的處理方式。）
    const res = await post({ ...base, user_id: userId });
    if (!res.ok) await post(base);
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
  const txtWithTokens = async (
    data: unknown,
    toolName: string,
    reportId?: string,
    /** PM-401：呼叫端已驗證過的使用者 id（見 logMcpUsage 的說明）。 */
    knownUserId?: string,
  ) => {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const est = estimateTokens(text, toolName);
    await logMcpUsage(env, toolName, est, reportId, knownUserId);
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
      // PM-401：token 已在上面比對過屬於這個 user，可以安全地記到用量上
      return txtWithTokens(data ?? [], 'list_reports', undefined, (user as { user_id: string }).user_id);
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
      return txtWithTokens(data, 'get_live_errors', undefined, userId); // PM-401：已過 sessionMatchesUser
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
      if (!(await isActiveUserId(userId, env)).active) {
        return txt('終端機 CLI 為付費功能，請至 bugezy.dev 升級後使用。');
      }
      const data = await readTerminalLogs(env, userId);
      if (data.stale) {
        return txt('終端機 Agent 未啟動或資料已過期（>30 秒）。請在終端機執行：npx bugezy-watch -- npm run dev');
      }
      // PM-179：最前面插入 AI 導航摘要（根因+白話+位置）；PM-178：後接結構化文字 + 原始 stderr
      const summary = generateTerminalSummary(data);
      return txtWithTokens(summary + '\n\n' + formatTerminalLogs(data), 'get_terminal_logs', undefined, userId); // PM-401
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

  // Tool（PM-363）: get_usage_quota — 免費版還剩幾次
  server.tool(
    'get_usage_quota',
    '查詢目前方案與本月剩餘用量（錄製 / 回溯 / MCP 讀取）。需 user_email + session_token 驗證身分。查詢不會消耗額度。Check your plan and remaining monthly quota — requires user_email and session_token. Checking does not consume quota.',
    {
      user_email: z.string().optional().describe('使用者 email。未提供則無法查詢（安全預設）。'),
      session_token: z.string().optional().describe('BugEzy session token（MCP URL 已帶 ?token= 則不需提供）。'),
    },
    async (args) => {
      if (!args.user_email) {
        return txt('請提供 user_email 參數以查詢用量。例如：get_usage_quota(user_email: "you@example.com")');
      }
      const token = env.__mcp_session_token || args.session_token || '';
      if (!token) {
        return txt('請在 MCP URL 加上 ?token=xxx，或提供 session_token 參數。可從 BugEzy 擴充進階設定複製。');
      }
      const { data: user, error: uErr } = await supabase()
        .from('users')
        .select('user_id')
        .eq('email', args.user_email)
        .maybeSingle();
      if (uErr) {
        console.error('MCP get_usage_quota user lookup failed:', uErr.message);
        return txt('查詢失敗，請稍後再試。');
      }
      // 查無此 email 與 token 不符一律回同一句 —— 分開講等於幫人確認「這個 email 有註冊」
      const tokenUserId = await verifySessionByToken(token, env);
      if (!user || !tokenUserId || tokenUserId !== (user as { user_id: string }).user_id) {
        return txt('session_token 驗證失敗，請確認 email 與 token 正確。');
      }

      const quota = await readUsageQuota((user as { user_id: string }).user_id, env);
      if (!quota) return txt('查詢失敗，請稍後再試。');
      return txtWithTokens(quota, 'get_usage_quota', undefined, (user as { user_id: string }).user_id); // PM-401
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
