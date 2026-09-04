ALTER TABLE lotto_sources ADD COLUMN lease_token TEXT;
ALTER TABLE lotto_sources ADD COLUMN lease_expires_at TEXT;

CREATE INDEX lotto_sources_lease_rotation_idx
  ON lotto_sources(lease_expires_at, last_attempt_at, source_id);

UPDATE schema_meta
SET value = '3', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
