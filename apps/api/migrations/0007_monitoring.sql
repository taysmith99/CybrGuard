ALTER TABLE monitored_emails ADD COLUMN monitoring_enabled INTEGER NOT NULL DEFAULT 0 CHECK (monitoring_enabled IN (0, 1));
ALTER TABLE monitored_emails ADD COLUMN monitoring_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitored_emails ADD COLUMN next_check_at INTEGER;
ALTER TABLE monitored_emails ADD COLUMN last_monitoring_at TEXT;
ALTER TABLE monitored_emails ADD COLUMN last_monitoring_outcome TEXT;
ALTER TABLE findings ADD COLUMN is_new INTEGER NOT NULL DEFAULT 0 CHECK (is_new IN (0, 1));
CREATE TABLE monitoring_jobs (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL REFERENCES monitored_emails(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'failed', 'paused')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  dispatched_at INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  outcome TEXT,
  UNIQUE(address_id, generation, scheduled_at)
);
CREATE INDEX monitoring_due ON monitored_emails(monitoring_enabled, next_check_at);
CREATE INDEX monitoring_dispatch ON monitoring_jobs(status, dispatched_at);
UPDATE schema_metadata SET version = 7 WHERE id = 1;
