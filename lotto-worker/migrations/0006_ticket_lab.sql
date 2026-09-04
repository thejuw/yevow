PRAGMA foreign_keys = ON;

-- The ledger is append-only evidence. Mutable workflow state (delivery leases) lives
-- in separate tables, and purchase/settlement changes are new immutable events.
CREATE TABLE lotto_ticket_ledger (
  ledger_id TEXT PRIMARY KEY,
  run_id TEXT UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('system', 'random', 'user')),
  correction_of TEXT REFERENCES lotto_ticket_ledger(ledger_id),
  baseline_for TEXT REFERENCES lotto_ticket_ledger(ledger_id),
  game TEXT NOT NULL CHECK (game IN ('lotto', 'twostep', 'cash5', 'pb', 'mm', 'p3', 'd4', 'aon')),
  draw_date TEXT NOT NULL,
  target_session TEXT NOT NULL DEFAULT ''
    CHECK (target_session IN ('', 'morning', 'day', 'evening', 'night')),
  proposed_at TEXT NOT NULL,
  seed TEXT,
  coverage_distinct_pairs INTEGER NOT NULL DEFAULT 0 CHECK (coverage_distinct_pairs >= 0),
  coverage_possible_pairs INTEGER NOT NULL DEFAULT 0 CHECK (coverage_possible_pairs >= 0),
  coverage_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (coverage_basis_points BETWEEN 0 AND 10000),
  ev_net_cents INTEGER NOT NULL,
  ev_assumption TEXT NOT NULL,
  ticket_cost_cents INTEGER NOT NULL CHECK (ticket_cost_cents > 0),
  ticket_count INTEGER NOT NULL CHECK (ticket_count BETWEEN 1 AND 2000),
  split_risk_model_json TEXT NOT NULL CHECK (json_valid(split_risk_model_json)),
  observed_through TEXT,
  dataset_digest TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX lotto_ticket_ledger_query_idx
  ON lotto_ticket_ledger(draw_date DESC, game, origin, ledger_id);
CREATE INDEX lotto_ticket_ledger_result_idx
  ON lotto_ticket_ledger(game, draw_date, target_session, ledger_id);
CREATE UNIQUE INDEX lotto_ticket_ledger_baseline_idx
  ON lotto_ticket_ledger(baseline_for) WHERE baseline_for IS NOT NULL;

CREATE TABLE lotto_ledger_tickets (
  ledger_ticket_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES lotto_ticket_ledger(ledger_id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  main_numbers TEXT NOT NULL CHECK (json_valid(main_numbers)),
  bonus_numbers TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(bonus_numbers)),
  play_style TEXT NOT NULL,
  wager_cents INTEGER NOT NULL CHECK (wager_cents > 0),
  ticket_options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ticket_options_json)),
  split_risk_basis_points INTEGER NOT NULL CHECK (split_risk_basis_points BETWEEN 0 AND 10000),
  split_risk_level TEXT NOT NULL CHECK (split_risk_level IN ('low', 'moderate', 'high')),
  split_risk_notes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(split_risk_notes)),
  created_at TEXT NOT NULL,
  UNIQUE (ledger_id, ordinal)
);

CREATE INDEX lotto_ledger_tickets_ledger_idx
  ON lotto_ledger_tickets(ledger_id, ordinal);

CREATE TABLE lotto_purchase_confirmation_events (
  purchase_event_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES lotto_ticket_ledger(ledger_id),
  idempotency_key TEXT NOT NULL,
  purchased INTEGER NOT NULL CHECK (purchased IN (0, 1)),
  spend_cents INTEGER NOT NULL CHECK (spend_cents >= 0),
  source TEXT NOT NULL,
  note TEXT,
  options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_json)),
  recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (ledger_id, idempotency_key)
);

CREATE INDEX lotto_purchase_events_latest_idx
  ON lotto_purchase_confirmation_events(ledger_id, recorded_at DESC, purchase_event_id DESC);

CREATE TABLE lotto_ledger_grades (
  grade_id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES lotto_ticket_ledger(ledger_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  supersedes_grade_id TEXT REFERENCES lotto_ledger_grades(grade_id),
  draw_fingerprint TEXT NOT NULL,
  result_main_numbers TEXT NOT NULL CHECK (json_valid(result_main_numbers)),
  result_bonus_numbers TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(result_bonus_numbers)),
  result_session TEXT NOT NULL,
  result_source_id TEXT NOT NULL,
  result_source_sha256 TEXT NOT NULL,
  hit_count INTEGER NOT NULL CHECK (hit_count >= 0),
  pending_prize_count INTEGER NOT NULL CHECK (pending_prize_count >= 0),
  known_prize_cents INTEGER NOT NULL CHECK (known_prize_cents >= 0),
  rule_version INTEGER NOT NULL CHECK (rule_version > 0),
  graded_at TEXT NOT NULL,
  UNIQUE (ledger_id, revision),
  UNIQUE (ledger_id, draw_fingerprint)
);

CREATE INDEX lotto_ledger_grades_latest_idx
  ON lotto_ledger_grades(ledger_id, revision DESC);

CREATE TABLE lotto_ticket_grades (
  ticket_grade_id TEXT PRIMARY KEY,
  grade_id TEXT NOT NULL REFERENCES lotto_ledger_grades(grade_id),
  ledger_ticket_id TEXT NOT NULL REFERENCES lotto_ledger_tickets(ledger_ticket_id),
  main_matches INTEGER NOT NULL CHECK (main_matches >= 0),
  bonus_matches INTEGER NOT NULL CHECK (bonus_matches >= 0),
  prize_tier TEXT NOT NULL,
  hit INTEGER NOT NULL CHECK (hit IN (0, 1)),
  payout_status TEXT NOT NULL CHECK (payout_status IN ('none', 'fixed', 'pending')),
  prize_cents INTEGER CHECK (prize_cents IS NULL OR prize_cents >= 0),
  pending_reason TEXT,
  grading_detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(grading_detail_json)),
  created_at TEXT NOT NULL,
  UNIQUE (grade_id, ledger_ticket_id)
);

CREATE INDEX lotto_ticket_grades_grade_idx
  ON lotto_ticket_grades(grade_id, ledger_ticket_id);

CREATE TABLE lotto_grade_settlement_events (
  settlement_id TEXT PRIMARY KEY,
  ticket_grade_id TEXT NOT NULL REFERENCES lotto_ticket_grades(ticket_grade_id),
  idempotency_key TEXT NOT NULL,
  final_prize_cents INTEGER NOT NULL CHECK (final_prize_cents >= 0),
  source TEXT NOT NULL,
  note TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  settled_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (ticket_grade_id, idempotency_key)
);

CREATE INDEX lotto_grade_settlements_latest_idx
  ON lotto_grade_settlement_events(ticket_grade_id, settled_at DESC, settlement_id DESC);

CREATE TABLE lotto_lab_delivery_outbox (
  delivery_id TEXT PRIMARY KEY,
  grade_id TEXT REFERENCES lotto_ledger_grades(grade_id),
  run_id TEXT NOT NULL,
  game TEXT NOT NULL CHECK (game IN ('lotto', 'twostep', 'cash5', 'pb', 'mm', 'p3', 'd4', 'aon')),
  draw_date TEXT NOT NULL,
  delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('result', 'alert')),
  target_role TEXT NOT NULL CHECK (target_role IN ('primary', 'fallback')),
  priority INTEGER NOT NULL DEFAULT 10 CHECK (priority BETWEEN 0 AND 100),
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
  UNIQUE (grade_id)
);

CREATE INDEX lotto_lab_delivery_claim_idx
  ON lotto_lab_delivery_outbox(status, priority DESC, next_attempt_at, lease_expires_at, created_at);

CREATE TABLE lotto_lab_delivery_attempts (
  attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES lotto_lab_delivery_outbox(delivery_id),
  lease_token TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  local_attempts INTEGER NOT NULL CHECK (local_attempts BETWEEN 0 AND 4),
  result TEXT NOT NULL CHECK (result IN ('sent', 'failed', 'ambiguous')),
  external_id TEXT,
  error TEXT,
  alert_status TEXT,
  alert_external_id TEXT,
  alert_error TEXT,
  UNIQUE (delivery_id, lease_token)
);

-- Materialize every live Phase 3 generated set before immutability is enforced.
INSERT OR IGNORE INTO lotto_ticket_ledger (
  ledger_id, run_id, origin, correction_of, baseline_for, game, draw_date, target_session,
  proposed_at, seed, coverage_distinct_pairs, coverage_possible_pairs,
  coverage_basis_points, ev_net_cents, ev_assumption, ticket_cost_cents,
  ticket_count, split_risk_model_json, observed_through, dataset_digest, created_at
)
SELECT
  'ledger-' || substr(run_id, 5), run_id, 'system', NULL, NULL, game, draw_date,
  CASE WHEN game IN ('p3', 'd4', 'aon') THEN 'morning' ELSE '' END,
  COALESCE(generated_at, created_at), seed, distinct_pairs, possible_pairs,
  coverage_basis_points, COALESCE(ev_net_cents, 0),
  COALESCE(ev_assumption, 'Legacy Phase 3 generated run'),
  CASE game
    WHEN 'lotto' THEN 100 WHEN 'twostep' THEN 100 WHEN 'cash5' THEN 100
    WHEN 'pb' THEN 200 WHEN 'mm' THEN 500 WHEN 'p3' THEN 50
    WHEN 'd4' THEN 50 WHEN 'aon' THEN 200
  END,
  ticket_count,
  json_object('model', 'RabbitHoleTX split-risk heuristic', 'version', 1,
              'backfilled', json('true')),
  observed_through, dataset_digest, COALESCE(generated_at, created_at)
FROM lotto_generation_runs
WHERE status = 'generated' AND ticket_count > 0;

INSERT OR IGNORE INTO lotto_ledger_tickets (
  ledger_ticket_id, ledger_id, ordinal, main_numbers, bonus_numbers, play_style,
  wager_cents, ticket_options_json, split_risk_basis_points, split_risk_level,
  split_risk_notes, created_at
)
SELECT
  'lt-' || substr(t.run_id, 5) || '-' || t.ordinal,
  'ledger-' || substr(t.run_id, 5), t.ordinal, t.main_numbers, t.bonus_numbers,
  t.play_style,
  CASE r.game
    WHEN 'lotto' THEN 100 WHEN 'twostep' THEN 100 WHEN 'cash5' THEN 100
    WHEN 'pb' THEN 200 WHEN 'mm' THEN 500 WHEN 'p3' THEN 50
    WHEN 'd4' THEN 50 WHEN 'aon' THEN 200
  END,
  CASE r.game
    WHEN 'lotto' THEN json_object('extra', json('false'))
    WHEN 'pb' THEN json_object('powerPlay', json('false'))
    WHEN 'mm' THEN json_object(
      'megaMultiplier',
      CASE
        WHEN (abs(COALESCE(unicode(substr(r.seed,
                    ((t.ordinal - 1) % max(COALESCE(length(r.seed), 0), 1)) + 1, 1)), 0)
                  + t.ordinal * 17) % 32) < 15 THEN 2
        WHEN (abs(COALESCE(unicode(substr(r.seed,
                    ((t.ordinal - 1) % max(COALESCE(length(r.seed), 0), 1)) + 1, 1)), 0)
                  + t.ordinal * 17) % 32) < 25 THEN 3
        WHEN (abs(COALESCE(unicode(substr(r.seed,
                    ((t.ordinal - 1) % max(COALESCE(length(r.seed), 0), 1)) + 1, 1)), 0)
                  + t.ordinal * 17) % 32) < 29 THEN 4
        WHEN (abs(COALESCE(unicode(substr(r.seed,
                    ((t.ordinal - 1) % max(COALESCE(length(r.seed), 0), 1)) + 1, 1)), 0)
                  + t.ordinal * 17) % 32) < 31 THEN 5
        ELSE 10
      END,
      'multiplierProvenance', 'modeled-backfill')
    WHEN 'p3' THEN json_object('stakeCents', 50, 'fireball', json('false'))
    WHEN 'd4' THEN json_object('stakeCents', 50, 'fireball', json('false'),
                               'pairPosition', NULL)
    ELSE json_object('basePlay', json('true'))
  END,
  t.split_risk_basis_points, t.split_risk_level, t.split_risk_notes,
  COALESCE(r.generated_at, r.created_at)
FROM lotto_generated_tickets t
JOIN lotto_generation_runs r ON r.run_id = t.run_id
JOIN lotto_ticket_ledger l ON l.run_id = r.run_id;

CREATE TRIGGER lotto_ticket_ledger_no_update
BEFORE UPDATE ON lotto_ticket_ledger BEGIN
  SELECT RAISE(ABORT, 'ticket ledger entries are immutable; append a correction');
END;
CREATE TRIGGER lotto_ticket_ledger_no_delete
BEFORE DELETE ON lotto_ticket_ledger BEGIN
  SELECT RAISE(ABORT, 'ticket ledger entries are immutable');
END;
CREATE TRIGGER lotto_ledger_tickets_no_update
BEFORE UPDATE ON lotto_ledger_tickets BEGIN
  SELECT RAISE(ABORT, 'ledger tickets are immutable');
END;
CREATE TRIGGER lotto_ledger_tickets_no_delete
BEFORE DELETE ON lotto_ledger_tickets BEGIN
  SELECT RAISE(ABORT, 'ledger tickets are immutable');
END;
CREATE TRIGGER lotto_purchase_events_no_update
BEFORE UPDATE ON lotto_purchase_confirmation_events BEGIN
  SELECT RAISE(ABORT, 'purchase confirmations are append-only');
END;
CREATE TRIGGER lotto_purchase_events_no_delete
BEFORE DELETE ON lotto_purchase_confirmation_events BEGIN
  SELECT RAISE(ABORT, 'purchase confirmations are append-only');
END;
CREATE TRIGGER lotto_ledger_grades_no_update
BEFORE UPDATE ON lotto_ledger_grades BEGIN
  SELECT RAISE(ABORT, 'ledger grades are immutable; append a revision');
END;
CREATE TRIGGER lotto_ledger_grades_no_delete
BEFORE DELETE ON lotto_ledger_grades BEGIN
  SELECT RAISE(ABORT, 'ledger grades are immutable');
END;
CREATE TRIGGER lotto_ticket_grades_no_update
BEFORE UPDATE ON lotto_ticket_grades BEGIN
  SELECT RAISE(ABORT, 'ticket grades are immutable');
END;
CREATE TRIGGER lotto_ticket_grades_no_delete
BEFORE DELETE ON lotto_ticket_grades BEGIN
  SELECT RAISE(ABORT, 'ticket grades are immutable');
END;
CREATE TRIGGER lotto_grade_settlements_no_update
BEFORE UPDATE ON lotto_grade_settlement_events BEGIN
  SELECT RAISE(ABORT, 'grade settlements are append-only');
END;
CREATE TRIGGER lotto_grade_settlements_no_delete
BEFORE DELETE ON lotto_grade_settlement_events BEGIN
  SELECT RAISE(ABORT, 'grade settlements are append-only');
END;

UPDATE schema_meta
SET value = '6', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
