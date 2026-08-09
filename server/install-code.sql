-- PM-276：安裝碼（Install Code）— 在 Supabase Dashboard → SQL Editor 貼上整份執行
-- 一個用戶一組 BZ-XXXX，綁 user_id、永不改變，只用於推廣活動驗證身份（不可兌換任何東西）。
-- 可重複執行（IF NOT EXISTS / DO 區塊皆為冪等）。

-- 欄位本身：'BZ-' + 4 碼 = 7 字元，留 VARCHAR(8) 餘裕
ALTER TABLE users ADD COLUMN IF NOT EXISTS install_code VARCHAR(8);

-- UNIQUE 約束：Worker 產碼時靠它擋碰撞（撞到回 23505 → 換一組重試）。
-- 用 DO 區塊而非 ALTER ... ADD CONSTRAINT，因為後者重複執行會報 duplicate_object。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_install_code_key'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_install_code_key UNIQUE (install_code);
  END IF;
END $$;

-- ── 驗收查詢（跑完上面接著跑）──────────────────────────────────────────────

-- ① 欄位存在且型別正確（預期 1 列：install_code / character varying / 8）
SELECT column_name, data_type, character_maximum_length
FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'install_code';

-- ② UNIQUE 約束已建立（預期 1 列：users_install_code_key / u）
SELECT conname, contype FROM pg_constraint WHERE conname = 'users_install_code_key';

-- ③ 目前已發出的安裝碼（剛跑完應為 0 列；用戶下次登入時 Worker 才會補發）
SELECT install_code, email, created_at FROM users
WHERE install_code IS NOT NULL ORDER BY created_at DESC;
