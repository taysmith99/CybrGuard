-- Remember explicit choices so billing refreshes never undo an opt-out.
ALTER TABLE monitored_emails ADD COLUMN monitoring_preference_set INTEGER NOT NULL DEFAULT 0 CHECK (monitoring_preference_set IN (0, 1));
UPDATE monitored_emails SET monitoring_preference_set = 1 WHERE monitoring_enabled = 1 OR last_monitoring_outcome = 'disabled';
UPDATE schema_metadata SET version = 9 WHERE id = 1;
