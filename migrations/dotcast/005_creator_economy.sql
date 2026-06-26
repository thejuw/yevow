CREATE TABLE IF NOT EXISTS dotcast_creators (
  creator_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('casual', 'verified', 'partner')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'archived')),
  kyc_status TEXT NOT NULL CHECK (kyc_status IN ('unverified', 'verified', 'rejected')),
  payout_destination TEXT,
  accuracy_bps INTEGER NOT NULL CHECK (accuracy_bps >= 0 AND accuracy_bps <= 10000),
  retention_bps INTEGER NOT NULL CHECK (retention_bps >= 0 AND retention_bps <= 10000),
  volume_score INTEGER NOT NULL DEFAULT 0 CHECK (volume_score >= 0),
  manual_review_required INTEGER NOT NULL DEFAULT 1 CHECK (manual_review_required IN (0, 1)),
  sponsorship_eligible INTEGER NOT NULL DEFAULT 0 CHECK (sponsorship_eligible IN (0, 1)),
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_creators_tier_status
  ON dotcast_creators (tier, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_creators_sponsorship
  ON dotcast_creators (sponsorship_eligible, tier, updated_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_creator_earnings_balances (
  creator_id TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('points', 'usdc')),
  available INTEGER NOT NULL DEFAULT 0 CHECK (available >= 0),
  pending_payout INTEGER NOT NULL DEFAULT 0 CHECK (pending_payout >= 0),
  lifetime_accrued INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_accrued >= 0),
  lifetime_paid INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_paid >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (creator_id, unit)
);

CREATE TABLE IF NOT EXISTS dotcast_creator_rake_accruals (
  accrual_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL UNIQUE,
  settlement_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('points', 'usdc')),
  total_rake INTEGER NOT NULL CHECK (total_rake >= 0),
  creator_share INTEGER NOT NULL CHECK (creator_share >= 0),
  house_share INTEGER NOT NULL CHECK (house_share >= 0),
  tier TEXT NOT NULL CHECK (tier IN ('casual', 'verified', 'partner')),
  tier_share_bps INTEGER NOT NULL CHECK (tier_share_bps >= 0 AND tier_share_bps <= 10000),
  effective_share_bps INTEGER NOT NULL CHECK (effective_share_bps >= 0 AND effective_share_bps <= 10000),
  accuracy_bps INTEGER NOT NULL CHECK (accuracy_bps >= 0 AND accuracy_bps <= 10000),
  retention_bps INTEGER NOT NULL CHECK (retention_bps >= 0 AND retention_bps <= 10000),
  idempotency_key TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (creator_share + house_share = total_rake)
);

CREATE INDEX IF NOT EXISTS idx_dotcast_creator_rake_accruals_creator
  ON dotcast_creator_rake_accruals (creator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_creator_rake_accruals_pool
  ON dotcast_creator_rake_accruals (pool_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_creator_payouts (
  payout_id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit = 'usdc'),
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('requested', 'signed', 'confirmed', 'failed', 'rejected')),
  destination TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  rail_transfer_id TEXT,
  rail_tx_ref TEXT,
  mock_signature TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  event_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_creator_payouts_creator
  ON dotcast_creator_payouts (creator_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_creator_payouts_status
  ON dotcast_creator_payouts (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_creator_pool_seeds (
  seed_id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('points', 'usdc')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  mode TEXT NOT NULL CHECK (mode IN ('boost_winners', 'void_insurance', 'bonus_pool')),
  resolution_binding TEXT NOT NULL CHECK (
    resolution_binding IN ('oracle_bound', 'optimistic', 'jury', 'unknown')
  ),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected', 'applied', 'returned')),
  disclosure_label TEXT NOT NULL CHECK (disclosure_label = 'Creator seed'),
  creator_holds_position INTEGER NOT NULL DEFAULT 0 CHECK (creator_holds_position IN (0, 1)),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_creator_pool_seeds_creator
  ON dotcast_creator_pool_seeds (creator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_creator_pool_seeds_pool
  ON dotcast_creator_pool_seeds (pool_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_creator_events (
  event_id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  pool_id TEXT,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'CREATOR_ONBOARDED',
      'CREATOR_UPDATED',
      'CREATOR_RAKE_ACCRUED',
      'CREATOR_PAYOUT_REQUESTED',
      'CREATOR_PAYOUT_CONFIRMED',
      'CREATOR_PAYOUT_REJECTED',
      'CREATOR_SEED_RECORDED',
      'CREATOR_NUDGE_SUPPRESSED'
    )
  ),
  unit TEXT CHECK (unit IN ('points', 'usdc')),
  amount INTEGER CHECK (amount IS NULL OR amount >= 0),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_creator_events_creator
  ON dotcast_creator_events (creator_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_creator_events_pool
  ON dotcast_creator_events (pool_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS dotcast_creator_rake_accruals_no_update
BEFORE UPDATE ON dotcast_creator_rake_accruals
BEGIN
  SELECT RAISE(ABORT, 'dotcast_creator_rake_accruals is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_creator_rake_accruals_no_delete
BEFORE DELETE ON dotcast_creator_rake_accruals
BEGIN
  SELECT RAISE(ABORT, 'dotcast_creator_rake_accruals is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_creator_pool_seeds_no_update
BEFORE UPDATE ON dotcast_creator_pool_seeds
BEGIN
  SELECT RAISE(ABORT, 'dotcast_creator_pool_seeds is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_creator_pool_seeds_no_delete
BEFORE DELETE ON dotcast_creator_pool_seeds
BEGIN
  SELECT RAISE(ABORT, 'dotcast_creator_pool_seeds is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_creator_events_no_update
BEFORE UPDATE ON dotcast_creator_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_creator_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_creator_events_no_delete
BEFORE DELETE ON dotcast_creator_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_creator_events is append-only');
END;
