-- M0 bootstrap only. Account, verification and finding schemas belong to M1.
-- Keep this migration free of personal data and fictional breach records.
CREATE TABLE schema_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO schema_metadata (id, version) VALUES (1, 1);
