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
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 按建立時間查詢的索引
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports (created_at DESC);

-- ── PM-16：截圖欄位（既有資料表用 ALTER 升級）──
ALTER TABLE reports ADD COLUMN IF NOT EXISTS screenshot_count INTEGER DEFAULT 0;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS screenshots_r2_key TEXT;

-- ── PM-20：開發者文字描述 ──
ALTER TABLE reports ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
