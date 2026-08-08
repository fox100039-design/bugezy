// PM-265：用 service_role key 對 promo_codes / user_tickets 做真實 REST CRUD 驗證。
// 跑法（DDL 在 Dashboard 執行完之後）：
//   cd server && SUPABASE_SERVICE_ROLE_KEY=<service_role> node verify-promo-tickets.mjs
// 全程只動自己建的測試票券，結束會刪掉，不留髒資料。

const URL = 'https://fpqlclltjreetlyhzlsd.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) {
  console.error('✗ 缺 SUPABASE_SERVICE_ROLE_KEY 環境變數');
  process.exit(1);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function req(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: { ...H, ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 就留 null */
  }
  return { status: res.status, json, text };
}

let pass = 0;
let fail = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ' | ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// ── READ：promo_codes 應有兩組預塞公開碼 ──────────────────────────────
const codes = await req('GET', 'promo_codes?select=code,duration_days,max_uses&order=code');
const codeList = (codes.json || []).map((c) => c.code);
check(codes.status === 200, 'service_role 讀 promo_codes', `HTTP ${codes.status}`);
check(
  codeList.includes('FIRSTMONTH') && codeList.includes('BUZZ100'),
  '預塞公開碼 FIRSTMONTH + BUZZ100',
  codeList.join(', '),
);

// ── 取測試用 user（user_tickets 有 FK 到 users）───────────────────────
// ⚠ 只挑「目前沒有這張票」的 user，全程不刪別人的真實票券（結束只刪自己建的那筆）
const TEST_CODE = 'FIRSTMONTH';
const users = await req('GET', 'users?select=user_id&limit=20');
const owned = await req('GET', `user_tickets?code=eq.${TEST_CODE}&select=user_id`);
const ownedSet = new Set((owned.json || []).map((r) => r.user_id));
const uid = (users.json || []).map((u) => u.user_id).find((u) => !ownedSet.has(u));
check(!!uid, 'service_role 讀 users 取得可用測試 user_id', uid ? `user_id 長度 ${uid.length}` : '無可用 user');
if (!uid) {
  console.log('\n⚠ 找不到可用的測試 user（users 空、或都已有 FIRSTMONTH 票）→ 跳過 user_tickets 測試');
  process.exit(fail ? 1 : 0);
}

// ── CREATE ────────────────────────────────────────────────────────────
const ins = await req(
  'POST',
  'user_tickets',
  { user_id: uid, code: TEST_CODE, duration_days: 30 },
  { Prefer: 'return=representation' },
);
const ticket = ins.json?.[0];
check(ins.status === 201 && !!ticket, 'CREATE 票券（status 預設 SAVED）', `HTTP ${ins.status}`);
check(ticket?.status === 'SAVED', 'DEFAULT status = SAVED', String(ticket?.status));
check(ticket?.activated_at === null, 'SAVED 時 activated_at 為 NULL', String(ticket?.activated_at));

// ── UPDATE：SAVED → ACTIVE（啟用並算到期日）──────────────────────────
const now = new Date();
const exp = new Date(now.getTime() + 30 * 86400_000);
const upd = await req(
  'PATCH',
  `user_tickets?id=eq.${ticket?.id}`,
  { status: 'ACTIVE', activated_at: now.toISOString(), expires_at: exp.toISOString() },
  { Prefer: 'return=representation' },
);
check(upd.status === 200 && upd.json?.[0]?.status === 'ACTIVE', 'UPDATE 票券 → ACTIVE', `HTTP ${upd.status}`);

// ── UNIQUE(user_id, code)：同 user 同 code 再插一次 → 應 409 ───────────
const dup = await req('POST', 'user_tickets', { user_id: uid, code: TEST_CODE, duration_days: 30 });
check(
  dup.status === 409 && dup.json?.code === '23505',
  'UNIQUE(user_id, code) 擋下重複兌換',
  `HTTP ${dup.status} ${dup.json?.code || ''}`,
);

// ── FK：不存在的 user_id → 應 409（foreign_key_violation 23503）───────
const badFk = await req('POST', 'user_tickets', {
  user_id: '__no_such_user__',
  code: TEST_CODE,
  duration_days: 30,
});
check(
  badFk.status === 409 && badFk.json?.code === '23503',
  'FK user_id → users(user_id) 生效',
  `HTTP ${badFk.status} ${badFk.json?.code || ''}`,
);

// ── 卡片 §5 的三支查詢能跑 ────────────────────────────────────────────
const active = await req(
  'GET',
  `user_tickets?user_id=eq.${encodeURIComponent(uid)}&status=eq.ACTIVE&expires_at=gt.${new Date().toISOString()}&select=*`,
);
check(active.status === 200 && (active.json || []).length === 1, '§5 查詢：使用中票券', `${active.json?.length} 筆`);

const saved = await req(
  'GET',
  `user_tickets?user_id=eq.${encodeURIComponent(uid)}&status=eq.SAVED&select=*`,
);
check(saved.status === 200, '§5 查詢：庫存票券', `HTTP ${saved.status}`);

// ── DELETE：清掉測試資料 ──────────────────────────────────────────────
const del = await req('DELETE', `user_tickets?id=eq.${ticket?.id}`);
check(del.status === 204, 'DELETE 清除測試票券', `HTTP ${del.status}`);

const left = await req(
  'GET',
  `user_tickets?user_id=eq.${encodeURIComponent(uid)}&code=eq.${TEST_CODE}&select=id`,
);
check((left.json || []).length === 0, '測試資料已清乾淨', `剩 ${left.json?.length} 筆`);

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILED'}  (${pass} pass / ${fail} fail)`);
process.exit(fail ? 1 : 0);
