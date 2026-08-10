-- PM-284：票券到期前 Discord 提醒 — 在 Supabase Dashboard → SQL Editor 貼上整份執行
-- 每日 cron 掃 ACTIVE 且 10 天內到期的票券推 Discord；已通知過的標記起來，避免每天重複推同一張。
-- 可重複執行（IF NOT EXISTS）。

ALTER TABLE user_tickets ADD COLUMN IF NOT EXISTS expiry_notified BOOLEAN NOT NULL DEFAULT false;

-- cron 的查詢條件是 (status, expiry_notified, expires_at)，配一個索引避免每天全表掃。
-- 部分索引：只索引「還沒通知過的 ACTIVE 票」，也就是 cron 真正會撈的那一小撮。
CREATE INDEX IF NOT EXISTS idx_user_tickets_expiry_notify
  ON user_tickets (expires_at)
  WHERE status = 'ACTIVE' AND expiry_notified = false;

-- ── 驗收查詢（跑完上面接著跑）──────────────────────────────────────────────

-- ① 欄位存在且預設 false（預期 1 列：expiry_notified / boolean / false）
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'user_tickets' AND column_name = 'expiry_notified';

-- ② 索引已建立（預期 1 列）
SELECT indexname FROM pg_indexes
WHERE tablename = 'user_tickets' AND indexname = 'idx_user_tickets_expiry_notify';

-- ③ 目前 10 天內會到期、且尚未通知的票券（就是下次 cron 會推的那些）
SELECT code, user_id, expires_at,
       CEIL(EXTRACT(EPOCH FROM (expires_at - NOW())) / 86400) AS days_left
FROM user_tickets
WHERE status = 'ACTIVE' AND expiry_notified = false
  AND expires_at > NOW() AND expires_at <= NOW() + INTERVAL '10 days'
ORDER BY expires_at;
