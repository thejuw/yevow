ALTER TABLE lotto_sources
ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1
CHECK (enabled IN (0, 1));

CREATE INDEX lotto_sources_enabled_rotation_idx
  ON lotto_sources(enabled, lease_expires_at, last_attempt_at, source_id);

UPDATE schema_meta
SET value = '4', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
