CREATE TABLE IF NOT EXISTS dotcast_settlement_rail_events (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'DEPOSIT_OBSERVED',
      'DEPOSIT_CREDITED',
      'DEPOSIT_REORGED',
      'WITHDRAWAL_REQUESTED',
      'WITHDRAWAL_SIGNED',
      'WITHDRAWAL_CONFIRMED',
      'WITHDRAWAL_FAILED',
      'RECONCILIATION'
    )
  ),
  network TEXT NOT NULL CHECK (network IN ('solana-devnet', 'solana-mainnet-beta')),
  cluster TEXT NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  mint TEXT NOT NULL,
  amount INTEGER CHECK (amount IS NULL OR amount >= 0),
  tx_ref TEXT,
  withdrawal_id TEXT,
  status TEXT,
  reason TEXT,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dotcast_settlement_balances (
  user_id TEXT PRIMARY KEY,
  available_usdc INTEGER NOT NULL DEFAULT 0 CHECK (available_usdc >= 0),
  pending_deposit_usdc INTEGER NOT NULL DEFAULT 0 CHECK (pending_deposit_usdc >= 0),
  pending_withdrawal_usdc INTEGER NOT NULL DEFAULT 0 CHECK (pending_withdrawal_usdc >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dotcast_settlement_transfers (
  transfer_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  status TEXT NOT NULL CHECK (
    status IN ('observed', 'credited', 'reorged', 'requested', 'signed', 'confirmed', 'failed')
  ),
  network TEXT NOT NULL CHECK (network IN ('solana-devnet', 'solana-mainnet-beta')),
  cluster TEXT NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  mint TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  tx_ref TEXT,
  destination TEXT,
  signer_mode TEXT NOT NULL CHECK (signer_mode IN ('mock', 'external', 'unknown')),
  mock_signature TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  event_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_settlement_events_user_created
  ON dotcast_settlement_rail_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_settlement_events_type_created
  ON dotcast_settlement_rail_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_settlement_transfers_user_updated
  ON dotcast_settlement_transfers (user_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dotcast_settlement_deposit_tx_ref
  ON dotcast_settlement_transfers (tx_ref)
  WHERE kind = 'deposit' AND tx_ref IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS dotcast_settlement_rail_events_no_update
BEFORE UPDATE ON dotcast_settlement_rail_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_settlement_rail_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_settlement_rail_events_no_delete
BEFORE DELETE ON dotcast_settlement_rail_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_settlement_rail_events is append-only');
END;
