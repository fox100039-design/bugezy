// PM-266：活動代碼 / 票券錢包 API 端到端驗證（打線上真實 HTTP，走完卡片 8 條驗收）。
// 跑法：
//   cd server && SUPABASE_SERVICE_ROLE_KEY=<service_role> node verify-promo-api.mjs
//
// 做法：用 service_role 在 sessions 表建一個「臨時 session」→ 拿它當 Bearer 打線上 API →
//       全部測完把票券 / session / promo 計數還原，不留任何痕跡。
// 安全：只挑「目前沒有這兩張票」的 user，不動任何真實票券。

const API = 'https://bugezy.dev';
const SB = 'https://fpqlclltjreetlyhzlsd.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) {
  console.error('✗ 缺 SUPABASE_SERVICE_ROLE_KEY 環境變數');
  process.exit(1);
}
const SH = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const sb = async (method, path, body, extra = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: { ...SH, ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let json = null;
  try {
    json = txt ? JSON.parse(txt) : null;
  } catch {
    /* ignore */
  }
  return { status: r.status, json };
};

let TOKEN = null;
const api = async (method, path, body) => {
  // 帶 cache-buster，避開 Cloudflare 邊緣快取；失敗時稍等重試（部署傳播 / 1015 限流）
  for (let i = 0; i < 6; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`${API}${path}${sep}cb=${Date.now()}${Math.random()}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    let json = null;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {
      /* ignore */
    }
    // 429=限流、404 且訊息為 not found=打到尚未更新的邊緣節點 → 退避重試
    if (r.status === 429 || (r.status === 404 && json?.error === 'not found')) {
      await new Promise((s) => setTimeout(s, 2500));
      continue;
    }
    return { status: r.status, json };
  }
  return { status: 0, json: null };
};

let pass = 0;
let fail = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' | ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const days = (iso) => (new Date(iso).getTime() - Date.now()) / 86_400_000;

// ── 準備：挑一個沒有這兩張票的 user，建臨時 session ─────────────────────
const CODES = ['FIRSTMONTH', 'BUZZ100'];
const users = await sb('GET', 'users?select=user_id&limit=50');
const held = await sb('GET', `user_tickets?code=in.(${CODES.join(',')})&select=user_id`);
const heldSet = new Set((held.json || []).map((r) => r.user_id));
const uid = (users.json || []).map((u) => u.user_id).find((u) => !heldSet.has(u));
if (!uid) {
  console.error('✗ 找不到可用的測試 user（users 空、或都已持有測試碼票券）');
  process.exit(1);
}
TOKEN = 'pm266test_' + crypto.randomUUID().replace(/-/g, '');
const mk = await sb('POST', 'sessions', {
  session_token: TOKEN,
  user_id: uid,
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
});
if (mk.status !== 201) {
  console.error('✗ 建立臨時 session 失敗:', mk.status, mk.json);
  process.exit(1);
}
console.log(`測試 user: ${uid.slice(0, 6)}…  臨時 session 已建立\n`);

// 記錄原始計數，最後還原
const before = await sb('GET', `promo_codes?code=in.(${CODES.join(',')})&select=code,current_uses`);
const origUses = Object.fromEntries((before.json || []).map((r) => [r.code, r.current_uses]));

const cleanup = async () => {
  await sb('DELETE', `user_tickets?user_id=eq.${encodeURIComponent(uid)}&code=in.(${CODES.join(',')})`);
  for (const [code, n] of Object.entries(origUses)) {
    await sb('PATCH', `promo_codes?code=eq.${code}`, { current_uses: n });
  }
  await sb('DELETE', `sessions?session_token=eq.${TOKEN}`);
};

try {
  // ── 驗收 1：兌換 FIRSTMONTH → 201 + SAVED ───────────────────────────
  const r1 = await api('POST', '/api/promo/redeem', { code: 'FIRSTMONTH' });
  check(r1.status === 201 && r1.json?.status === 'SAVED', '① redeem FIRSTMONTH → 201 SAVED',
    `HTTP ${r1.status} ${r1.json?.status || r1.json?.error || ''}`);
  const ticketId = r1.json?.ticket_id;
  check(r1.json?.duration_days === 30, '① duration_days 由代碼帶入 = 30', String(r1.json?.duration_days));

  // 小寫也應可兌換（後端會 toUpperCase）→ 這裡順便驗重複兌換
  // ── 驗收 2：同帳號再兌換 → 409 ───────────────────────────────────────
  const r2 = await api('POST', '/api/promo/redeem', { code: 'firstmonth' });
  check(r2.status === 409, '② 同帳號重複兌換（小寫輸入）→ 409',
    `HTTP ${r2.status} ${r2.json?.error || ''}`);

  // 無效代碼
  const rBad = await api('POST', '/api/promo/redeem', { code: 'NO_SUCH_CODE' });
  check(rBad.status === 400 && rBad.json?.error === '無效的活動代碼', '   無效代碼 → 400',
    `HTTP ${rBad.status} ${rBad.json?.error || ''}`);

  // 啟用前：wallet 應有 1 張庫存、無使用中
  const w0 = await api('GET', '/api/promo/wallet');
  check(w0.json?.saved_count === 1 && w0.json?.active_ticket === null,
    '   啟用前 wallet：庫存 1 / 使用中 0',
    `saved=${w0.json?.saved_count} active=${w0.json?.active_ticket ? 'yes' : 'null'}`);

  // ── 驗收 3：啟用 → ACTIVE + expires_at ≈ now+30d ─────────────────────
  const r3 = await api('POST', '/api/promo/activate', { ticket_id: ticketId });
  const d3 = r3.json?.expires_at ? days(r3.json.expires_at) : -1;
  check(r3.status === 200 && r3.json?.status === 'ACTIVE', '③ activate → ACTIVE',
    `HTTP ${r3.status} ${r3.json?.status || r3.json?.error || ''}`);
  check(d3 > 29.9 && d3 < 30.1, '③ expires_at ≈ now + 30 天', `${d3.toFixed(2)} 天`);

  // 重複啟用應被擋
  const r3b = await api('POST', '/api/promo/activate', { ticket_id: ticketId });
  check(r3b.status === 400, '   重複啟用同一張 → 400', `HTTP ${r3b.status} ${r3b.json?.error || ''}`);

  // ── 驗收 4：wallet 回傳 active_ticket + saved_tickets ────────────────
  const w1 = await api('GET', '/api/promo/wallet');
  check(w1.status === 200 && w1.json?.active_ticket?.ticket_id === ticketId,
    '④ wallet 回傳 active_ticket', `code=${w1.json?.active_ticket?.code}`);
  check(w1.json?.active_ticket?.days_left === 30, '④ days_left = 30',
    String(w1.json?.active_ticket?.days_left));
  check(!!w1.json?.free_until, '④ free_until 有值', String(w1.json?.free_until).slice(0, 10));

  // ── 驗收 5：/api/user/plan → isPaid=true + limits=null ───────────────
  const p1 = await api('GET', '/api/user/plan');
  check(p1.json?.isPaid === true, '⑤ /api/user/plan isPaid = true', String(p1.json?.isPaid));
  check(p1.json?.limits === null, '⑤ 票券生效時 limits = null（無限）', String(p1.json?.limits));
  check(p1.json?.tickets?.active?.ticket_id === ticketId, '⑤ plan.tickets.active 正確',
    p1.json?.tickets?.active?.code || '');

  // ── 疊加：再兌換 BUZZ100 並啟用 → 應接在 30 天之後（≈60 天）─────────
  const r4 = await api('POST', '/api/promo/redeem', { code: 'BUZZ100' });
  const t2 = r4.json?.ticket_id;
  check(r4.status === 201, '⑥ redeem BUZZ100 → 201', `HTTP ${r4.status} ${r4.json?.error || ''}`);
  const r5 = await api('POST', '/api/promo/activate', { ticket_id: t2 });
  const d5 = r5.json?.expires_at ? days(r5.json.expires_at) : -1;
  check(d5 > 59.9 && d5 < 60.1, '⑥ 疊加生效：第二張接在第一張之後 ≈ 60 天', `${d5.toFixed(2)} 天`);

  // BUZZ100 有 max_uses=100，計數應 +1
  const after = await sb('GET', 'promo_codes?code=eq.BUZZ100&select=current_uses');
  check(after.json?.[0]?.current_uses === (origUses.BUZZ100 ?? 0) + 1,
    '⑥ 限量碼 current_uses +1', `${origUses.BUZZ100} → ${after.json?.[0]?.current_uses}`);

  // ── 驗收 6：票券到期 → isPaid 回 false + 自動標 USED ─────────────────
  const past = new Date(Date.now() - 86_400_000).toISOString();
  await sb('PATCH', `user_tickets?user_id=eq.${encodeURIComponent(uid)}&status=eq.ACTIVE`,
    { expires_at: past });
  const p2 = await api('GET', '/api/user/plan');
  check(p2.json?.isPaid === false, '⑦ 票券到期後 isPaid = false', String(p2.json?.isPaid));
  check(p2.json?.limits !== null, '⑦ limits 恢復（回免費版額度）', p2.json?.limits ? 'has limits' : 'null');
  const used = await sb('GET',
    `user_tickets?user_id=eq.${encodeURIComponent(uid)}&code=in.(${CODES.join(',')})&select=code,status`);
  const allUsed = (used.json || []).every((t) => t.status === 'USED');
  check(allUsed, '⑦ 到期票券自動標記 USED',
    (used.json || []).map((t) => `${t.code}=${t.status}`).join(', '));
} finally {
  await cleanup();
  console.log('\n🧹 測試資料已清除（票券 / 臨時 session / promo 計數已還原）');
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILED'}  (${pass} pass / ${fail} fail)`);
process.exit(fail ? 1 : 0);
