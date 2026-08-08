-- ═══════════════════════════════════════════════════════════════════════════
-- PM-265：活動代碼 + 票券錢包（Supabase）
-- 在 Supabase Dashboard → SQL Editor 貼入整份執行（冪等，可重複跑）。
--
-- 用途：
--   promo_codes  = 代碼定義（FOX 管理）。公開碼衝量（FIRSTMONTH/BUZZ100）、個人碼任務換票（BZ-VID-xxxx）。
--   user_tickets = 用戶票券錢包。SAVED（儲存不計時）→ ACTIVE（啟用倒數）→ USED（到期），可疊加。
--
-- ⚠ 本檔已修正 job 卡片 SQL 的兩處 schema 錯誤（照抄卡片會直接執行失敗）：
--   ① 卡片寫 `REFERENCES users(id)` — users 表沒有 id 欄位，主鍵是 `user_id`（見 schema.sql:58）
--   ② 卡片寫 `user_id UUID` — users.user_id 是 **TEXT**（PM-133 起 = Google sub），
--      FK 型別必須與被參照欄位一致，用 UUID 會報 foreign key type mismatch
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. promo_codes：代碼定義 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_codes (
  code            VARCHAR(30) PRIMARY KEY,                  -- 'FIRSTMONTH' / 'BZ-VID-K8M3X2'
  description     TEXT NOT NULL,                            -- '安裝體驗 1 個月'
  duration_days   INTEGER NOT NULL,                         -- 30 / 60 / 90
  code_type       VARCHAR(10) NOT NULL DEFAULT 'public',    -- 'public' / 'personal'
  max_uses        INTEGER,                                  -- NULL = 無限（公開碼）/ 1（個人碼）
  current_uses    INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,            -- FOX 可隨時停用
  code_expires_at TIMESTAMPTZ,                              -- NULL = 永不過期
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. user_tickets：用戶票券錢包 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_tickets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL REFERENCES users(user_id),  -- ⚠ 修正：TEXT + users(user_id)
  code            VARCHAR(30) NOT NULL REFERENCES promo_codes(code),
  duration_days   INTEGER NOT NULL,                         -- 從代碼帶入（發券當下快照）
  status          VARCHAR(10) NOT NULL DEFAULT 'SAVED',     -- SAVED / ACTIVE / USED
  activated_at    TIMESTAMPTZ,                              -- 啟用時間（SAVED 時 NULL）
  expires_at      TIMESTAMPTZ,                              -- 啟用後算出 = activated_at + duration_days
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, code)                                    -- 同帳號同碼只能兌換一次
);

-- 供卡片 §5 三支查詢用（皆為 WHERE user_id = $1 AND status = ...）
CREATE INDEX IF NOT EXISTS idx_user_tickets_user_status ON user_tickets (user_id, status);

-- ── 3. RLS：§4-6 鐵律，開 RLS 且「不加任何 policy」= deny all ─────────────
--    唯一存取途徑 = Worker 的 service_role key（supaKey() 會繞過 RLS）
ALTER TABLE promo_codes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tickets ENABLE ROW LEVEL SECURITY;

-- ── 4. 預塞公開碼 ─────────────────────────────────────────────────────────
INSERT INTO promo_codes (code, description, duration_days, code_type, max_uses) VALUES
  ('FIRSTMONTH', '安裝體驗 — 免費 1 個月', 30, 'public', NULL),
  ('BUZZ100', '社群衝人氣 — 貼文破百則送 1 個月', 30, 'public', 100)
ON CONFLICT (code) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- 驗收查詢（跑完上面後，把下面一起貼進去執行，逐項對照 job 卡片的 5 條驗收）
-- ═══════════════════════════════════════════════════════════════════════════

-- 驗收 1+2：兩張表存在且 RLS 已啟用（應各回一列，rowsecurity = true）
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename IN ('promo_codes', 'user_tickets')
ORDER BY tablename;

-- 驗收 1+2 補充：確認「沒有任何 policy」（deny all 的關鍵，應回 0 列）
SELECT tablename, policyname
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('promo_codes', 'user_tickets');

-- 驗收 3：兩組公開碼已預塞（應回 2 列）
SELECT code, description, duration_days, code_type, max_uses, current_uses, is_active
FROM promo_codes ORDER BY code;

-- 驗收 5：UNIQUE(user_id, code) 生效 —— 用真實 user 跑「插兩次」測試，最後自動清掉。
--   預期：第 2 次 INSERT 被 ON CONFLICT 擋掉 → inserted_second 回 0 列 → dup_blocked = true
DO $$
DECLARE
  uid TEXT;
  cnt INTEGER;
BEGIN
  -- 只挑「目前沒有 FIRSTMONTH 票券」的 user，避免動到真實用戶已兌換的票（測完只刪自己插的那筆）
  SELECT u.user_id INTO uid
  FROM users u
  WHERE NOT EXISTS (
    SELECT 1 FROM user_tickets t WHERE t.user_id = u.user_id AND t.code = 'FIRSTMONTH'
  )
  LIMIT 1;
  IF uid IS NULL THEN
    RAISE NOTICE '⚠ 找不到可用的測試 user（users 空、或都已有 FIRSTMONTH 票）→ 跳過 UNIQUE 測試';
    RETURN;
  END IF;

  -- 第 1 次：應成功
  INSERT INTO user_tickets (user_id, code, duration_days)
  VALUES (uid, 'FIRSTMONTH', 30);

  -- 第 2 次：同 user + 同 code → 應被 UNIQUE 擋下
  BEGIN
    INSERT INTO user_tickets (user_id, code, duration_days)
    VALUES (uid, 'FIRSTMONTH', 30);
    RAISE EXCEPTION '❌ UNIQUE(user_id, code) 沒生效 — 第二次插入竟然成功';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '✅ UNIQUE(user_id, code) 生效：第二次插入被擋（unique_violation）';
  END;

  SELECT COUNT(*) INTO cnt FROM user_tickets WHERE user_id = uid AND code = 'FIRSTMONTH';
  RAISE NOTICE '✅ 測試後該 user 的 FIRSTMONTH 票券數 = % （應為 1）', cnt;

  -- 清掉測試資料，不留髒資料
  DELETE FROM user_tickets WHERE user_id = uid AND code = 'FIRSTMONTH';
  RAISE NOTICE '✅ 測試資料已清除';
END $$;

-- 驗收 4（service_role CRUD）：DDL 跑完後，在終端機跑
--   cd server && SUPABASE_SERVICE_ROLE_KEY=<你的 service_role> node verify-promo-tickets.mjs
-- 會用 service_role 對兩張表做真實的 REST 讀/寫/刪，並驗 UNIQUE 與 FK。
