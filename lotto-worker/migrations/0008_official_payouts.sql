PRAGMA foreign_keys = ON;

-- Mutable acquisition state only; financial settlements remain append-only.
CREATE TABLE lotto_payout_sources (
  game TEXT NOT NULL CHECK (game IN ('lotto', 'twostep')),
  draw_date TEXT NOT NULL,
  source_url TEXT,
  source_sha256 TEXT,
  object_key TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'retry', 'mismatch')),
  error TEXT,
  next_attempt_at TEXT,
  PRIMARY KEY (game, draw_date)
);

CREATE INDEX lotto_payout_sources_retry_idx ON lotto_payout_sources(status, next_attempt_at);

UPDATE schema_meta SET value = '8', updated_at = CURRENT_TIMESTAMP WHERE key = 'schema_version';
