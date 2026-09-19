PRAGMA foreign_keys = ON;

-- Paper-only experiments cannot be purchases or enter the production ledger.
CREATE TABLE lotto_shadow_trials (
  trial_id TEXT PRIMARY KEY,
  parent_ledger_id TEXT NOT NULL REFERENCES lotto_ticket_ledger(ledger_id),
  baseline_ledger_id TEXT NOT NULL REFERENCES lotto_ticket_ledger(ledger_id),
  variant_id TEXT NOT NULL,
  optimizer_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  game TEXT NOT NULL CHECK (game IN ('lotto','twostep','cash5','pb','mm','p3','d4','aon')),
  draw_date TEXT NOT NULL,
  target_session TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  seed TEXT NOT NULL,
  objective TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  observed_through TEXT NOT NULL,
  dataset_digest TEXT NOT NULL,
  ticket_count INTEGER NOT NULL CHECK (ticket_count BETWEEN 1 AND 64),
  wager_cents INTEGER NOT NULL CHECK (wager_cents > 0),
  arms_json TEXT NOT NULL CHECK (json_valid(arms_json)),
  metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json)),
  UNIQUE (parent_ledger_id, variant_id, protocol_version)
);
CREATE INDEX lotto_shadow_trials_draw_idx ON lotto_shadow_trials(game, draw_date, target_session);
CREATE INDEX lotto_shadow_trials_query_idx ON lotto_shadow_trials(draw_date DESC, variant_id);

CREATE TABLE lotto_shadow_grades (
  event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  grade_id TEXT NOT NULL UNIQUE,
  trial_id TEXT NOT NULL REFERENCES lotto_shadow_trials(trial_id),
  previous_grade_id TEXT REFERENCES lotto_shadow_grades(grade_id),
  outcome_hash TEXT NOT NULL,
  draw_fingerprint TEXT,
  status TEXT NOT NULL CHECK (status IN ('graded','pending','excluded')),
  reason TEXT,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  arms_json TEXT NOT NULL CHECK (json_valid(arms_json)),
  graded_at TEXT NOT NULL
);
CREATE INDEX lotto_shadow_grades_latest_idx ON lotto_shadow_grades(trial_id, event_sequence DESC);

-- Mutable retry/lease state is deliberately separate from immutable evidence.
CREATE TABLE lotto_shadow_work (
  trial_id TEXT PRIMARY KEY REFERENCES lotto_shadow_trials(trial_id),
  last_attempt_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT
);
CREATE INDEX lotto_shadow_work_due_idx ON lotto_shadow_work(next_attempt_at, last_attempt_at);

CREATE TRIGGER lotto_shadow_trials_no_update BEFORE UPDATE ON lotto_shadow_trials BEGIN
  SELECT RAISE(ABORT, 'shadow trials are immutable; create a new versioned protocol');
END;
CREATE TRIGGER lotto_shadow_trials_no_delete BEFORE DELETE ON lotto_shadow_trials BEGIN
  SELECT RAISE(ABORT, 'shadow trials are immutable');
END;
CREATE TRIGGER lotto_shadow_grades_no_update BEFORE UPDATE ON lotto_shadow_grades BEGIN
  SELECT RAISE(ABORT, 'shadow grades are append-only');
END;
CREATE TRIGGER lotto_shadow_grades_no_delete BEFORE DELETE ON lotto_shadow_grades BEGIN
  SELECT RAISE(ABORT, 'shadow grades are append-only');
END;

UPDATE schema_meta SET value = '9', updated_at = CURRENT_TIMESTAMP WHERE key = 'schema_version';
