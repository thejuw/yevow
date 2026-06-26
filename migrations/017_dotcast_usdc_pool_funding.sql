ALTER TABLE dotcast_settlement_balances
  ADD COLUMN locked_pool_usdc INTEGER NOT NULL DEFAULT 0 CHECK (locked_pool_usdc >= 0);

CREATE TABLE IF NOT EXISTS dotcast_usdc_pool_locks (
  lock_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('locked', 'released', 'settled', 'refunded')),
  payout INTEGER CHECK (payout IS NULL OR payout >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  event_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dotcast_usdc_pool_locks_entry
  ON dotcast_usdc_pool_locks (pool_id, entry_id);

CREATE INDEX IF NOT EXISTS idx_dotcast_usdc_pool_locks_user_updated
  ON dotcast_usdc_pool_locks (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_usdc_pool_events (
  event_id TEXT PRIMARY KEY,
  lock_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'POOL_ENTRY_RESERVED',
      'POOL_ENTRY_RELEASED',
      'POOL_ENTRY_SETTLED',
      'POOL_ENTRY_REFUNDED'
    )
  ),
  amount INTEGER NOT NULL CHECK (amount > 0),
  payout INTEGER CHECK (payout IS NULL OR payout >= 0),
  status TEXT NOT NULL CHECK (status IN ('locked', 'released', 'settled', 'refunded')),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_usdc_pool_events_pool_created
  ON dotcast_usdc_pool_events (pool_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_usdc_pool_events_user_created
  ON dotcast_usdc_pool_events (user_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS dotcast_usdc_pool_events_no_update
BEFORE UPDATE ON dotcast_usdc_pool_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_usdc_pool_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_usdc_pool_events_no_delete
BEFORE DELETE ON dotcast_usdc_pool_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_usdc_pool_events is append-only');
END;
