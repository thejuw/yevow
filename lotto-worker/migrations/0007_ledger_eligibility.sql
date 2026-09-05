PRAGMA foreign_keys = ON;

-- Eligibility is an append-only attestation stream. It never rewrites the
-- immutable ticket ledger or its grades. The monotonically increasing sequence
-- is the authoritative ordering; caller-controlled timestamps are not.
CREATE TABLE lotto_ledger_eligibility_events (
  event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  eligibility_event_id TEXT NOT NULL UNIQUE,
  ledger_id TEXT NOT NULL REFERENCES lotto_ticket_ledger(ledger_id),
  idempotency_key TEXT NOT NULL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'schema-v7-attestation',
    'pre-draw-capture',
    'deterministic-random-baseline',
    'official-result-not-after-proposal',
    'proposal-not-before-sales-cutoff',
    'manual-integrity-exclusion',
    'manual-integrity-reinstatement'
  )),
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (ledger_id, idempotency_key)
);

CREATE INDEX lotto_ledger_eligibility_latest_idx
  ON lotto_ledger_eligibility_events(ledger_id, event_sequence DESC);
CREATE INDEX lotto_ledger_eligibility_state_idx
  ON lotto_ledger_eligibility_events(eligible, event_sequence DESC);

-- Every pre-v7 ledger receives an explicit starting attestation. Invalid
-- no-lookahead rows receive the exclusion event immediately afterwards, so the
-- later sequence is authoritative while all evidence remains preserved.
INSERT OR IGNORE INTO lotto_ledger_eligibility_events (
  eligibility_event_id, ledger_id, idempotency_key, eligible, reason_code,
  reason, evidence_json, recorded_at, created_at
)
SELECT
  'eligibility-attest-' || substr(l.ledger_id, 8),
  l.ledger_id,
  'schema-v7-initial-attestation',
  1,
  'schema-v7-attestation',
  'Ledger existed before schema v7; this initial state is superseded by any later invariant exclusion event.',
  json_object(
    'attestationVersion', 1,
    'migration', '0007_ledger_eligibility.sql',
    'ledgerProposedAt', l.proposed_at
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM lotto_ticket_ledger l;

INSERT OR IGNORE INTO lotto_ledger_eligibility_events (
  eligibility_event_id, ledger_id, idempotency_key, eligible, reason_code,
  reason, evidence_json, recorded_at, created_at
)
SELECT
  'eligibility-exclude-' || substr(l.ledger_id, 8),
  l.ledger_id,
  'official-result-not-after-proposal-v1',
  0,
  'official-result-not-after-proposal',
  'Official result was already present when this ticket set was proposed.',
  json_object(
    'attestationVersion', 1,
    'invariant', 'officialResultFirstSeenAt > ledgerProposedAt',
    'game', l.game,
    'drawDate', l.draw_date,
    'targetSession', l.target_session,
    'ledgerProposedAt', l.proposed_at,
    'officialResultFirstSeenAt', d.first_seen_at,
    'resultFingerprint', d.content_fingerprint,
    'resultSourceId', d.source_id,
    'resultSourceSha256', d.source_sha256
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM lotto_ticket_ledger l
JOIN lotto_draws d
  ON d.game = l.game
 AND d.draw_date = l.draw_date
 AND d.session = l.target_session
WHERE d.first_seen_at <= l.proposed_at;

CREATE TRIGGER lotto_ledger_eligibility_no_update
BEFORE UPDATE ON lotto_ledger_eligibility_events BEGIN
  SELECT RAISE(ABORT, 'ledger eligibility events are append-only');
END;

CREATE TRIGGER lotto_ledger_eligibility_no_delete
BEFORE DELETE ON lotto_ledger_eligibility_events BEGIN
  SELECT RAISE(ABORT, 'ledger eligibility events are append-only');
END;

UPDATE schema_meta
SET value = '7', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
