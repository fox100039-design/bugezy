-- ═══════════════════════════════════════════════════════════════════════════
-- PM-98：補回「孤兒」報告的 user_id（截圖流程早期漏帶 → MCP list_reports 查不到）
-- 在 Supabase Dashboard → SQL Editor 執行。
--
-- ⚠ 重點：reports 綁定 owner 用的是 `user_id`（不是 user_email）。
--    list_reports(user_email) 的流程是：先用 email 在 users 表查出 user_id，
--    再對 reports `.eq('user_id', ...)` 過濾。所以漏帶 user_id 的報告就查不到。
--
-- 前提：目前系統只有 FOX 一個使用者，故把所有 user_id 為空的報告一律補給 FOX。
--       若日後有多使用者，請勿無條件跑此腳本（會把別人的孤兒報告也綁到 FOX）。
-- ═══════════════════════════════════════════════════════════════════════════

-- 步驟 1（可選）：先看有幾筆孤兒報告
SELECT report_id, title, screenshot_count, user_id, created_at
FROM reports
WHERE user_id IS NULL OR user_id = ''
ORDER BY created_at DESC;

-- 步驟 2：把孤兒報告的 user_id 補成 FOX 的 user_id（動態從 users 表查，不寫死）
UPDATE reports
SET user_id = (SELECT user_id FROM users WHERE email = 'fox100039@gmail.com')
WHERE (user_id IS NULL OR user_id = '')
  AND EXISTS (SELECT 1 FROM users WHERE email = 'fox100039@gmail.com');

-- 步驟 3：確認補完後不再有孤兒（應回 0 筆）
SELECT count(*) AS still_orphan
FROM reports
WHERE user_id IS NULL OR user_id = '';
