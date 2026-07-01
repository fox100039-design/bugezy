-- BugEzy reports 表（在 Supabase Dashboard → SQL Editor 貼入執行）

CREATE TABLE IF NOT EXISTS reports (
  report_id     TEXT PRIMARY KEY,
  url           TEXT,
  title         TEXT,
  browser       TEXT,
  screen_size   TEXT,
  console_count INTEGER DEFAULT 0,
  network_count INTEGER DEFAULT 0,
  voice_count   INTEGER DEFAULT 0,
  rrweb_count   INTEGER DEFAULT 0,
  screenshot_count INTEGER DEFAULT 0,
  rrweb_r2_key  TEXT,
  screenshots_r2_key TEXT,
  console_logs  JSONB DEFAULT '[]',
  network_errors JSONB DEFAULT '[]',
  voice_transcript JSONB DEFAULT '[]',
  description   TEXT DEFAULT '',
  markers       JSONB DEFAULT '[]',
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 按建立時間查詢的索引
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports (created_at DESC);

-- ── PM-16：截圖欄位（既有資料表用 ALTER 升級）──
ALTER TABLE reports ADD COLUMN IF NOT EXISTS screenshot_count INTEGER DEFAULT 0;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS screenshots_r2_key TEXT;

-- ── PM-20：開發者文字描述 ──
ALTER TABLE reports ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';

-- ── PM-28：時間軸標記（mini player 標記時間點 + 文字說明）──
ALTER TABLE reports ADD COLUMN IF NOT EXISTS markers JSONB DEFAULT '[]';

-- ── PM-82：報告頁勾選「允許 AI 讀取截圖圖片」（false=只回 metadata 省 token / true=自動回圖）──
ALTER TABLE reports ADD COLUMN IF NOT EXISTS allow_screenshot_images BOOLEAN DEFAULT false;

-- ── PM-56：MCP 月度使用量統計（每次 MCP 呼叫記一筆，供 /api/usage/monthly 彙總）──
CREATE TABLE IF NOT EXISTS mcp_usage (
  id SERIAL PRIMARY KEY,
  tool_name TEXT NOT NULL,
  tokens_estimated INT NOT NULL,
  chrome_tokens_estimated INT NOT NULL,
  report_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mcp_usage_created ON mcp_usage (created_at);

-- ── PM-61：Google 登入使用者 + 報告綁定 user ──
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar_url TEXT,
  plan TEXT DEFAULT 'free',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ DEFAULT NOW()
);
-- PM-93：users 改為 ENABLE RLS（原 PM-61 的 DISABLE 已不需要——Worker 改用 service_role 繞 RLS）
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS user_id TEXT;

-- ── PM-63：免費/付費用量限制（每月計數，跨月自動重置）──
ALTER TABLE users ADD COLUMN IF NOT EXISTS recording_count INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rewind_count INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mcp_count INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_reset_at TIMESTAMPTZ DEFAULT NOW();

-- ── PM-73：取消訂閱（綠界訂單編號 + 付費到期日；plan 多一個 'cancelled' 狀態）──
ALTER TABLE users ADD COLUMN IF NOT EXISTS ecpay_trade_no TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;

-- ── PM-93：全 public table 開 RLS(deny all)，anon key 完全鎖死；唯一存取途徑是 Worker 的 service_role。
--    ⚠ 執行前務必先 `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`，否則 Worker(anon) 會被鎖死。
--    完整腳本 + 步驟見 server/rls-lockdown.sql。
ALTER TABLE reports   ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE users     ENABLE ROW LEVEL SECURITY;
