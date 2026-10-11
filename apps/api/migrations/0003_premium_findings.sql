CREATE TABLE premium_entitlements (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
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
UPDATE schema_metadata SET version = 3 WHERE id = 1;
