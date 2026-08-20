-- PM-398：MCP30 票券（MCP 對接成功專屬 30 天體驗券）
--
-- 🔴 **兩段都要跑，而且順序不重要但缺一不可。**
--    卡片只寫了步驟 1 的 INSERT，但兌換邏輯要查 `mcp_usage.user_id`，
--    而那個欄位**原本不存在**（PM-380 的授權稽核已經標紅過這件事：
--    `logMcpUsage` 只寫 tool_name / tokens / report_id，完全沒有使用者維度）。
--    沒有步驟 2 的話，MCP30 會對所有人都回「目前無法驗證 MCP 使用紀錄」。
--
-- 在 Supabase SQL Editor 執行。

-- ── 步驟 1：建立 MCP30 代碼 ──────────────────────────────────────────────
-- max_uses = NULL（不限量）、code_expires_at = NULL（不設到期）
INSERT INTO promo_codes (code, description, duration_days, code_type, max_uses, current_uses, is_active, code_expires_at)
VALUES ('MCP30', 'MCP 對接成功專屬 30 天體驗券', 30, 'promo', NULL, 0, true, NULL)
ON CONFLICT (code) DO NOTHING;   -- 重複執行不會壞

-- ── 步驟 2：mcp_usage 加上使用者維度 ────────────────────────────────────
ALTER TABLE mcp_usage ADD COLUMN IF NOT EXISTS user_id text;

-- 兌換時是 `WHERE user_id = ? LIMIT 1`，加索引避免資料量長大後每次兌換都全表掃描
CREATE INDEX IF NOT EXISTS idx_mcp_usage_user_id ON mcp_usage (user_id);

-- ── 驗證（跑完貼結果就知道有沒有成功）────────────────────────────────────
-- 1) MCP30 已建立？
SELECT code, duration_days, is_active, max_uses, current_uses FROM promo_codes WHERE code = 'MCP30';

-- 2) user_id 欄位已存在？
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'mcp_usage' ORDER BY ordinal_position;

-- 3) 目前有幾筆帶 user_id 的紀錄？
--    ⚠ **舊資料一定是 0** —— 這個欄位是現在才加的，先前的呼叫沒有留下歸屬。
--    所以包含 FOX 自己在內，**都必須在部署後「再呼叫一次任何 MCP 工具」**，
--    才會產生第一筆可用來驗證資格的紀錄。這不是 bug，是資料本來就不存在。
SELECT count(*) AS total, count(user_id) AS with_user_id FROM mcp_usage;
