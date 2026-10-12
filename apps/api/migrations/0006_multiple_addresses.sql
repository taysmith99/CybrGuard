-- Rebuild the unique-one-address table with dependent rows preserved. Migrations
-- are transactional; drop child tables first so no cascading data is lost.
CREATE TABLE migration_emails AS SELECT * FROM monitored_emails;
CREATE TABLE migration_findings AS SELECT * FROM findings;
CREATE TABLE migration_actions AS SELECT * FROM finding_actions;
DROP TABLE finding_actions;
DROP TABLE findings;
DROP TABLE monitored_emails;
CREATE TABLE monitored_emails (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encrypted_email TEXT NOT NULL,
  email_index TEXT NOT NULL UNIQUE,
  verified_at INTEGER NOT NULL,
  consent_at INTEGER NOT NULL,
  known_breach_count INTEGER,
  checked_at TEXT,
  scan_lease_until INTEGER NOT NULL DEFAULT 0,
  last_scan_attempt INTEGER NOT NULL DEFAULT 0,
  details_checked_at TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1))
);
CREATE UNIQUE INDEX primary_email_per_user ON monitored_emails(user_id) WHERE is_primary = 1;
CREATE INDEX address_user ON monitored_emails(user_id, verified_at, id);
INSERT INTO monitored_emails SELECT id, user_id, encrypted_email, email_index, verified_at, consent_at, known_breach_count, checked_at, scan_lease_until, last_scan_attempt, details_checked_at, 1 FROM migration_emails;
CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  address_id TEXT NOT NULL REFERENCES monitored_emails(id) ON DELETE CASCADE,
  breach_index TEXT NOT NULL,
  encrypted_details TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  remediated_at TEXT,
  UNIQUE(address_id, breach_index)
);
INSERT INTO findings SELECT * FROM migration_findings;
CREATE TABLE finding_actions (
  finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(finding_id, action_id)
);
INSERT INTO finding_actions SELECT * FROM migration_actions;
DROP TABLE migration_actions;
DROP TABLE migration_findings;
DROP TABLE migration_emails;
ALTER TABLE premium_entitlements ADD COLUMN max_addresses INTEGER NOT NULL DEFAULT 3 CHECK (max_addresses BETWEEN 1 AND 25);
ALTER TABLE email_verifications ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'address'));
ALTER TABLE email_verifications ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
UPDATE schema_metadata SET version = 6 WHERE id = 1;
