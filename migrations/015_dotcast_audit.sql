CREATE TABLE IF NOT EXISTS dotcast_audit_events (
  event_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  market_id TEXT,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'POOL_CREATED',
      'ENTRY_PLACED',
      'POOL_LOCKED',
      'POOL_VOIDED',
      'POOL_SETTLED',
      'RESOLUTION_APPLIED',
      'ROUTER_POLL',
      'RAKE_RECORDED'
    )
  ),
  user_id TEXT,
  entry_id TEXT,
  unit TEXT CHECK (unit IS NULL OR unit IN ('points', 'usdc')),
  amount INTEGER CHECK (amount IS NULL OR amount >= 0),
  side TEXT CHECK (side IS NULL OR side IN ('yes', 'no')),
  status TEXT,
  reason TEXT,
  correlation_id TEXT,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dotcast_balance_ledger (
  ledger_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  entry_id TEXT,
  user_id TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('points', 'usdc')),
  delta_available INTEGER NOT NULL DEFAULT 0,
  delta_locked INTEGER NOT NULL DEFAULT 0,
  available_after INTEGER NOT NULL CHECK (available_after >= 0),
  locked_after INTEGER NOT NULL CHECK (locked_after >= 0),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'ENTRY_LOCK',
      'SETTLEMENT_PAYOUT',
      'VOID_REFUND',
      'HOUSE_ENTRY_PAYOUT',
      'ADJUSTMENT'
    )
  ),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dotcast_house_ledger (
  ledger_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('points', 'usdc')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  reason TEXT NOT NULL CHECK (reason IN ('RAKE', 'HOUSE_REFUND', 'HOUSE_STAKE')),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_audit_events_pool_created
  ON dotcast_audit_events (pool_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_audit_events_market_created
  ON dotcast_audit_events (market_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_audit_events_type_created
  ON dotcast_audit_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_audit_events_user_created
  ON dotcast_audit_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_balance_ledger_user_created
  ON dotcast_balance_ledger (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_balance_ledger_pool_created
  ON dotcast_balance_ledger (pool_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_house_ledger_pool_created
  ON dotcast_house_ledger (pool_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS dotcast_audit_events_no_update
BEFORE UPDATE ON dotcast_audit_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_audit_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_audit_events_no_delete
BEFORE DELETE ON dotcast_audit_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_audit_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_balance_ledger_no_update
BEFORE UPDATE ON dotcast_balance_ledger
BEGIN
  SELECT RAISE(ABORT, 'dotcast_balance_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_balance_ledger_no_delete
BEFORE DELETE ON dotcast_balance_ledger
BEGIN
  SELECT RAISE(ABORT, 'dotcast_balance_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_house_ledger_no_update
BEFORE UPDATE ON dotcast_house_ledger
BEGIN
  SELECT RAISE(ABORT, 'dotcast_house_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_house_ledger_no_delete
BEFORE DELETE ON dotcast_house_ledger
BEGIN
  SELECT RAISE(ABORT, 'dotcast_house_ledger is append-only');
END;
