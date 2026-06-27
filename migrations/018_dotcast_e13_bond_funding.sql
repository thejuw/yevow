ALTER TABLE dotcast_settlement_balances
  ADD COLUMN locked_bond_usdc INTEGER NOT NULL DEFAULT 0 CHECK (locked_bond_usdc >= 0);

CREATE TABLE IF NOT EXISTS dotcast_usdc_bond_locks (
  lock_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('resolution_challenge', 'resolver_assignment')),
  owner_id TEXT NOT NULL,
  route_id TEXT,
  pool_id TEXT,
  panel_id TEXT,
  assignment_id TEXT,
  challenge_id TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('locked', 'released', 'slashed')),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  event_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_usdc_bond_locks_owner_updated
  ON dotcast_usdc_bond_locks (owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_usdc_bond_locks_route_status
  ON dotcast_usdc_bond_locks (route_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_usdc_bond_locks_panel_status
  ON dotcast_usdc_bond_locks (panel_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_usdc_bond_events (
  event_id TEXT PRIMARY KEY,
  lock_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('resolution_challenge', 'resolver_assignment')),
  owner_id TEXT NOT NULL,
  route_id TEXT,
  pool_id TEXT,
  panel_id TEXT,
  assignment_id TEXT,
  challenge_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('BOND_LOCKED', 'BOND_RELEASED', 'BOND_SLASHED')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  credit INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
  status TEXT NOT NULL CHECK (status IN ('locked', 'released', 'slashed')),
  reason TEXT,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_usdc_bond_events_owner_created
  ON dotcast_usdc_bond_events (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_usdc_bond_events_lock_created
  ON dotcast_usdc_bond_events (lock_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS dotcast_usdc_bond_events_no_update
BEFORE UPDATE ON dotcast_usdc_bond_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_usdc_bond_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_usdc_bond_events_no_delete
BEFORE DELETE ON dotcast_usdc_bond_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_usdc_bond_events is append-only');
END;
