ALTER TABLE lotto_sources
ADD COLUMN last_parser_version INTEGER NOT NULL DEFAULT 0
CHECK (last_parser_version >= 0);

UPDATE schema_meta
SET value = '2', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
