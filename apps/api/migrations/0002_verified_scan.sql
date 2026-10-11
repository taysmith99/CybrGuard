PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE monitored_emails (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  encrypted_email TEXT NOT NULL,
  email_index TEXT NOT NULL UNIQUE,
  verified_at INTEGER NOT NULL,
  consent_at INTEGER NOT NULL,
  known_breach_count INTEGER,
  checked_at TEXT,
  scan_lease_until INTEGER NOT NULL DEFAULT 0,
  last_scan_attempt INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE email_verifications (
  id TEXT PRIMARY KEY,
  email_index TEXT NOT NULL,
  encrypted_email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  consent_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER
);
CREATE INDEX verification_email_time ON email_verifications(email_index, created_at);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE,
  device_hash TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX session_family ON sessions(family_id);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
INSERT INTO rate_limits (key, window_start, count) VALUES ('xon-global', 0, 0);
UPDATE schema_metadata SET version = 2 WHERE id = 1;
