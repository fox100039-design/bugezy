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
  rrweb_r2_key  TEXT,
  console_logs  JSONB DEFAULT '[]',
  network_errors JSONB DEFAULT '[]',
  voice_transcript JSONB DEFAULT '[]',
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 按建立時間查詢的索引
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports (created_at DESC);
