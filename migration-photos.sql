-- One-time migration: photo attachments (references only — images live in Slack).
-- Run once against the live database:
--   npx wrangler d1 execute fulfillment-db --remote --file=migration-photos.sql

ALTER TABLE requests ADD COLUMN photos TEXT;
