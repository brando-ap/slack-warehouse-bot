-- Fulfillment Assistant database schema
-- Apply with: npx wrangler d1 execute fulfillment-db --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  details TEXT,
  company TEXT,                              -- customer / company the request is for
  status TEXT NOT NULL DEFAULT 'open',       -- open | in_progress | done | cancelled
  priority TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high | urgent
  due_date TEXT,                             -- YYYY-MM-DD, nullable
  created_by TEXT NOT NULL,                  -- Slack user ID
  assigned_to TEXT,                          -- Slack user ID, nullable
  channel_id TEXT,                           -- channel the request was posted to
  message_ts TEXT,                           -- timestamp of the posted Slack message
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);
CREATE INDEX IF NOT EXISTS idx_requests_due ON requests (due_date);

CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_date TEXT NOT NULL,                   -- YYYY-MM-DD
  description TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | cancelled
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shipments_date ON shipments (ship_date);

-- Slack user id -> display name, learned as people use commands and buttons.
-- Lets the wallboard show names without extra Slack permissions.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
