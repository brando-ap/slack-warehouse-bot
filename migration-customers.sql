-- One-time migration for databases created before the customer directory.
-- Run once against the live database:
--   npx wrangler d1 execute fulfillment-db --remote --file=migration-customers.sql
-- (Fresh installs don't need this; schema.sql already includes everything.)

ALTER TABLE requests ADD COLUMN contact TEXT;

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_companies (
  contact_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL,
  PRIMARY KEY (contact_id, company_id)
);
