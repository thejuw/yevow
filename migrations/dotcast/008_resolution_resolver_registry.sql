CREATE TABLE IF NOT EXISTS dotcast_resolver_profiles (
  resolver_id TEXT PRIMARY KEY,
  identity_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'archived')),
  display_name TEXT,
  reputation_bps INTEGER NOT NULL CHECK (reputation_bps BETWEEN 0 AND 10000),
  bond_available_minor_units INTEGER NOT NULL CHECK (bond_available_minor_units >= 0),
  stake_held_pool_ids_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolver_profiles_status_reputation
  ON dotcast_resolver_profiles (status, reputation_bps DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_resolver_bond_ledger (
  entry_id TEXT PRIMARY KEY,
  resolver_id TEXT NOT NULL,
  assignment_id TEXT,
  panel_id TEXT,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'resolver_onboarded',
      'bond_deposited',
      'assignment_locked',
      'bond_released',
      'bond_slashed',
      'fee_credited',
      'manual_adjustment'
    )
  ),
  delta_minor_units INTEGER NOT NULL,
  balance_after_minor_units INTEGER NOT NULL CHECK (balance_after_minor_units >= 0),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolver_bond_ledger_resolver
  ON dotcast_resolver_bond_ledger (resolver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolver_bond_ledger_assignment
  ON dotcast_resolver_bond_ledger (assignment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_resolver_reputation_events (
  event_id TEXT PRIMARY KEY,
  resolver_id TEXT NOT NULL,
  assignment_id TEXT,
  panel_id TEXT,
  previous_reputation_bps INTEGER NOT NULL CHECK (previous_reputation_bps BETWEEN 0 AND 10000),
  new_reputation_bps INTEGER NOT NULL CHECK (new_reputation_bps BETWEEN 0 AND 10000),
  delta_bps INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN ('settlement_consensus_match', 'settlement_consensus_miss', 'manual_adjustment')
  ),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolver_reputation_events_resolver
  ON dotcast_resolver_reputation_events (resolver_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS dotcast_resolver_bond_ledger_no_update
BEFORE UPDATE ON dotcast_resolver_bond_ledger
BEGIN
  SELECT RAISE(ABORT, 'dotcast_resolver_bond_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_resolver_bond_ledger_no_delete
BEFORE DELETE ON dotcast_resolver_bond_ledger
BEGIN
  SELECT RAISE(ABORT, 'dotcast_resolver_bond_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_resolver_reputation_events_no_update
BEFORE UPDATE ON dotcast_resolver_reputation_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_resolver_reputation_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_resolver_reputation_events_no_delete
BEFORE DELETE ON dotcast_resolver_reputation_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_resolver_reputation_events is append-only');
END;
