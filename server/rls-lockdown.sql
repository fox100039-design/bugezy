-- ═══════════════════════════════════════════════════════════════════════════
-- PM-93：Supabase 全 public table RLS 鎖死（deny all）— 修 rls_disabled_in_public
-- 在 Supabase Dashboard → SQL Editor 貼入執行。
--
-- ⚠⚠⚠ 執行順序極重要 ⚠⚠⚠
-- BugEzy 的 Worker 目前用「anon key」連 Supabase（不是 service_role）。
-- 若直接對所有 table 開 RLS(no policy)，Worker 也會被鎖死 → 全站 500。
-- 必須先完成【步驟 0】把 Worker 切到 service_role，才能跑本檔的【步驟 2】。
--
-- 【步驟 0】（在終端機，先做，PM-93 已改好程式碼支援）：
--   1. Supabase Dashboard → Project Settings → API → 複製「service_role」secret（不是 anon）
--   2. cd server && npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY   （貼上 service_role）
--      （程式的 supaKey() 會自動優先用它、繞過 RLS；未設定則退回 anon，故現況不受影響）
--   3. 確認 Worker 仍正常（MCP list_reports / 開一份 /report/:id）
-- 完成步驟 0 後，再跑下面的【步驟 1~2】。
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 步驟 1：查出所有 public table 的 RLS 狀態（rowsecurity=false 就是沒開）──
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- ── 步驟 2：對所有 public table 開啟 RLS（不加任何 policy = deny all）──
-- 已知的 BugEzy table（明列，方便閱讀）：
ALTER TABLE public.reports    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_usage  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users      ENABLE ROW LEVEL SECURITY;  -- 覆蓋 PM-61 的 DISABLE（改用 service_role 後不再需要開放）

-- 保險：動態對「所有」public base table 開 RLS（含未來新增/本檔未列到的），冪等可重複跑：
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.tablename);
  END LOOP;
END $$;

-- ── 步驟 3：再查一次確認全部 rowsecurity=true ──
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- ═══════════════════════════════════════════════════════════════════════════
-- 驗證：
--  • Worker（service_role）→ 照常讀寫（繞過 RLS）
--  • anon key → 所有 SELECT/INSERT/UPDATE/DELETE 全 deny：
--      curl "$SUPABASE_URL/rest/v1/reports?select=*&limit=1" \
--        -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
--      應回 [] 或 401/403，看不到任何資料。
--  • Supabase Advisors → Security → 不應再有 rls_disabled_in_public Critical。
-- ═══════════════════════════════════════════════════════════════════════════
