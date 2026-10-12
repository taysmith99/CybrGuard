CREATE TABLE billing_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'personal', 'family')),
  entitlement_expires_at INTEGER,
  verified_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE processed_billing_events (
  id TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL
);
UPDATE schema_metadata SET version = 8 WHERE id = 1;
