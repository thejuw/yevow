PRAGMA foreign_keys = ON;

CREATE TABLE lotto_game_config (
  game TEXT PRIMARY KEY CHECK (game IN ('lotto', 'twostep', 'cash5', 'pb', 'mm', 'p3', 'd4', 'aon')),
  selected INTEGER NOT NULL DEFAULT 1 CHECK (selected IN (0, 1)),
  ticket_count INTEGER NOT NULL DEFAULT 4 CHECK (ticket_count BETWEEN 1 AND 50),
  generation_weekdays TEXT NOT NULL CHECK (json_valid(generation_weekdays)),
  generation_local_time TEXT NOT NULL DEFAULT '06:00',
  draw_slot TEXT NOT NULL DEFAULT 'daily' CHECK (draw_slot IN ('daily', 'morning')),
  play_style TEXT NOT NULL DEFAULT 'straight',
  jackpot_cents INTEGER NOT NULL DEFAULT 0 CHECK (jackpot_cents >= 0),
  estimated_sales INTEGER NOT NULL DEFAULT 0 CHECK (estimated_sales >= 0),
  popularity_ppm INTEGER NOT NULL DEFAULT 1000000 CHECK (popularity_ppm >= 0),
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO lotto_game_config
  (game, generation_weekdays, draw_slot)
VALUES
  ('lotto', '["Mon","Wed"]', 'daily'),
  ('twostep', '["Mon","Thu"]', 'daily'),
  ('cash5', '["Mon","Tue","Wed","Thu","Fri","Sat"]', 'daily'),
  ('pb', '["Wed","Sat"]', 'daily'),
  ('mm', '["Tue","Fri"]', 'daily'),
  ('p3', '["Mon","Tue","Wed","Thu","Fri","Sat"]', 'daily'),
  ('d4', '["Mon","Tue","Wed","Thu","Fri","Sat"]', 'daily'),
  ('aon', '["Mon","Tue","Wed","Thu","Fri","Sat"]', 'morning');

CREATE TABLE lotto_generation_leases (
  game TEXT NOT NULL CHECK (game IN ('lotto', 'twostep', 'cash5', 'pb', 'mm', 'p3', 'd4', 'aon')),
  draw_date TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (game, draw_date)
);

CREATE TABLE lotto_generation_runs (
  run_id TEXT PRIMARY KEY,
  game TEXT NOT NULL CHECK (game IN ('lotto', 'twostep', 'cash5', 'pb', 'mm', 'p3', 'd4', 'aon')),
  draw_date TEXT NOT NULL,
  draw_slot TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  seed TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'failed', 'generated')),
  pipeline_attempts INTEGER NOT NULL DEFAULT 0 CHECK (pipeline_attempts >= 0),
  next_retry_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  started_at TEXT NOT NULL,
  generated_at TEXT,
  observed_through TEXT,
  dataset_digest TEXT,
  source_state_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_state_json)),
  ticket_count INTEGER NOT NULL DEFAULT 0 CHECK (ticket_count >= 0),
  distinct_pairs INTEGER NOT NULL DEFAULT 0 CHECK (distinct_pairs >= 0),
  possible_pairs INTEGER NOT NULL DEFAULT 0 CHECK (possible_pairs >= 0),
  coverage_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (coverage_basis_points BETWEEN 0 AND 10000),
  ev_net_cents INTEGER,
  ev_assumption TEXT,
  message_body TEXT,
  disclaimer TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (game, draw_date)
);

CREATE INDEX lotto_generation_runs_day_idx
  ON lotto_generation_runs(draw_date DESC, status, game);
CREATE INDEX lotto_generation_runs_status_idx
  ON lotto_generation_runs(status, next_retry_at, updated_at);

CREATE TABLE lotto_generated_tickets (
  run_id TEXT NOT NULL REFERENCES lotto_generation_runs(run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  main_numbers TEXT NOT NULL CHECK (json_valid(main_numbers)),
  bonus_numbers TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(bonus_numbers)),
  play_style TEXT NOT NULL,
  split_risk_basis_points INTEGER NOT NULL CHECK (split_risk_basis_points BETWEEN 0 AND 10000),
  split_risk_level TEXT NOT NULL CHECK (split_risk_level IN ('low', 'moderate', 'high')),
  split_risk_notes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(split_risk_notes)),
  PRIMARY KEY (run_id, ordinal)
);

CREATE TABLE lotto_delivery_outbox (
  delivery_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES lotto_generation_runs(run_id) ON DELETE CASCADE,
  delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('picks', 'alert')),
  target_role TEXT NOT NULL CHECK (target_role IN ('primary', 'fallback')),
  message_body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'retry', 'sent', 'ambiguous', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  external_id TEXT,
  last_error TEXT,
  alert_status TEXT,
  alert_external_id TEXT,
  alert_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, delivery_kind)
);

CREATE INDEX lotto_delivery_outbox_claim_idx
  ON lotto_delivery_outbox(status, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX lotto_delivery_outbox_run_idx
  ON lotto_delivery_outbox(run_id, delivery_kind);

CREATE TABLE lotto_delivery_attempts (
  attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES lotto_delivery_outbox(delivery_id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  local_attempts INTEGER NOT NULL CHECK (local_attempts BETWEEN 0 AND 4),
  result TEXT NOT NULL CHECK (result IN ('sent', 'failed', 'ambiguous')),
  external_id TEXT,
  error TEXT,
  alert_status TEXT,
  alert_external_id TEXT,
  alert_error TEXT
);

CREATE INDEX lotto_delivery_attempts_delivery_idx
  ON lotto_delivery_attempts(delivery_id, started_at DESC);
CREATE UNIQUE INDEX lotto_delivery_attempts_lease_idx
  ON lotto_delivery_attempts(delivery_id, lease_token);

CREATE TABLE lotto_daily_summaries (
  service_date TEXT PRIMARY KEY,
  due_games INTEGER NOT NULL DEFAULT 0 CHECK (due_games >= 0),
  generated_games INTEGER NOT NULL DEFAULT 0 CHECK (generated_games >= 0),
  failed_games INTEGER NOT NULL DEFAULT 0 CHECK (failed_games >= 0),
  pending_deliveries INTEGER NOT NULL DEFAULT 0 CHECK (pending_deliveries >= 0),
  sent_deliveries INTEGER NOT NULL DEFAULT 0 CHECK (sent_deliveries >= 0),
  quarantined_records INTEGER NOT NULL DEFAULT 0 CHECK (quarantined_records >= 0),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

UPDATE schema_meta
SET value = '5', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
