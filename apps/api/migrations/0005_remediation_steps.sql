CREATE TABLE finding_actions (
  finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(finding_id, action_id)
);
UPDATE schema_metadata SET version = 5 WHERE id = 1;
