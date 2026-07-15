-- One-time migration: ticket #categories (replaces the shipping module).
-- Run once against the live database:
--   npx wrangler d1 execute fulfillment-db --remote --file=migration-categories.sql
-- The old shipments table is left in place (unused) so no data is destroyed.

ALTER TABLE requests ADD COLUMN category TEXT;

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO categories (name, created_at) VALUES
  ('receiving', datetime('now')),
  ('ship', datetime('now')),
  ('fulfillment', datetime('now'));
