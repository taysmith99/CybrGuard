ALTER TABLE monitored_emails ADD COLUMN details_checked_at TEXT;
UPDATE schema_metadata SET version = 4 WHERE id = 1;
