PRAGMA foreign_keys = ON;

CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO schema_meta (key, value) VALUES
  ('schema_version', '1'),
  ('parser_version', '1'),
  ('rules_verified_on', '2026-09-03');

CREATE TABLE lotto_sources (
  source_id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  session TEXT NOT NULL DEFAULT '',
  expected_widths TEXT NOT NULL,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_digest TEXT,
  last_object_key TEXT,
  last_error TEXT,
  last_status TEXT NOT NULL DEFAULT 'never',
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  active_count INTEGER NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  latest_draw_date TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX lotto_sources_rotation_idx
  ON lotto_sources(last_attempt_at, source_id);
CREATE INDEX lotto_sources_game_idx
  ON lotto_sources(game, source_id);

CREATE TABLE lotto_ingestions (
  ingestion_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES lotto_sources(source_id),
  game TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('scheduled', 'bootstrap', 'test')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'unchanged')),
  digest TEXT,
  object_key TEXT,
  byte_count INTEGER NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  parsed INTEGER NOT NULL DEFAULT 0 CHECK (parsed >= 0),
  inserted INTEGER NOT NULL DEFAULT 0 CHECK (inserted >= 0),
  updated INTEGER NOT NULL DEFAULT 0 CHECK (updated >= 0),
  unchanged INTEGER NOT NULL DEFAULT 0 CHECK (unchanged >= 0),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired >= 0),
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined >= 0),
  cache_fallback INTEGER NOT NULL DEFAULT 0 CHECK (cache_fallback IN (0, 1)),
  error TEXT
);

CREATE INDEX lotto_ingestions_source_idx
  ON lotto_ingestions(source_id, started_at DESC);
CREATE INDEX lotto_ingestions_status_idx
  ON lotto_ingestions(status, started_at DESC);

CREATE TABLE lotto_draws (
  game TEXT NOT NULL,
  draw_date TEXT NOT NULL,
  session TEXT NOT NULL DEFAULT '',
  ordered_numbers TEXT NOT NULL,
  canonical_numbers TEXT NOT NULL,
  bonus_numbers TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  content_fingerprint TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES lotto_sources(source_id),
  source_url TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_line INTEGER NOT NULL CHECK (source_line > 0),
  raw_record TEXT NOT NULL,
  seen_ingestion_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (game, draw_date, session)
);

CREATE INDEX lotto_draws_game_active_date_idx
  ON lotto_draws(game, active, draw_date DESC, session DESC);
CREATE INDEX lotto_draws_source_active_date_idx
  ON lotto_draws(source_id, active, draw_date DESC);

CREATE TABLE lotto_quarantine (
  quarantine_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingestion_id TEXT NOT NULL REFERENCES lotto_ingestions(ingestion_id),
  source_id TEXT NOT NULL REFERENCES lotto_sources(source_id),
  game TEXT NOT NULL,
  source_line INTEGER NOT NULL,
  raw_record TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX lotto_quarantine_ingestion_idx
  ON lotto_quarantine(ingestion_id, source_line);

CREATE TABLE lotto_audit_snapshots (
  game TEXT NOT NULL,
  dataset_digest TEXT NOT NULL,
  observed_through TEXT NOT NULL,
  draw_count INTEGER NOT NULL CHECK (draw_count > 0),
  report_json TEXT NOT NULL,
  report_markdown_key TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (game, dataset_digest)
);
