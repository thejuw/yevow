ALTER TABLE dotcast_free_entry_credits RENAME TO dotcast_free_entry_credits_e12_old;

CREATE TABLE dotcast_free_entry_credits (
  credit_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  grant_reason TEXT NOT NULL CHECK (
    grant_reason IN ('streak_bonus', 'manual_grant', 'rewarded_stream', 'referral', 'adjustment')
  ),
  pool_id TEXT,
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  consumed_at TEXT,
  consumed_by_entry_id TEXT,
  event_json TEXT NOT NULL
);

INSERT INTO dotcast_free_entry_credits (
  credit_id, user_id, grant_reason, pool_id, granted_at, expires_at, consumed_at,
  consumed_by_entry_id, event_json
)
SELECT
  credit_id,
  user_id,
  grant_reason,
  pool_id,
  granted_at,
  expires_at,
  consumed_at,
  consumed_by_entry_id,
  event_json
FROM dotcast_free_entry_credits_e12_old;

DROP TABLE dotcast_free_entry_credits_e12_old;

CREATE INDEX IF NOT EXISTS idx_dotcast_free_entry_credits_user_granted
  ON dotcast_free_entry_credits (user_id, granted_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_free_entry_credits_user_available
  ON dotcast_free_entry_credits (user_id, consumed_at, granted_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_referral_identity_bindings (
  user_id TEXT PRIMARY KEY,
  identity_hash TEXT NOT NULL,
  wallet_address TEXT,
  kyc_complete INTEGER NOT NULL DEFAULT 0 CHECK (kyc_complete IN (0, 1)),
  first_entry_earned INTEGER NOT NULL DEFAULT 0 CHECK (first_entry_earned IN (0, 1)),
  first_deposit_at TEXT,
  last_withdrawal_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_referral_identity_hash
  ON dotcast_referral_identity_bindings (identity_hash, updated_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_referral_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  identity_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_referral_codes_user
  ON dotcast_referral_codes (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_referrals (
  referral_id TEXT PRIMARY KEY,
  code TEXT,
  referrer_user_id TEXT NOT NULL,
  referred_user_id TEXT NOT NULL UNIQUE,
  referrer_identity_hash TEXT NOT NULL,
  referred_identity_hash TEXT NOT NULL,
  qualifier TEXT NOT NULL CHECK (qualifier IN ('first_deposit', 'kyc_plus_first_entry')),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'qualified', 'rewarded', 'rejected')),
  qualified_at TEXT,
  rejected_reason TEXT,
  reward_batch_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (referrer_user_id <> referred_user_id),
  CHECK (referrer_identity_hash <> referred_identity_hash)
);

CREATE INDEX IF NOT EXISTS idx_dotcast_referrals_referrer_updated
  ON dotcast_referrals (referrer_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_referrals_referrer_qualified
  ON dotcast_referrals (referrer_user_id, status, qualified_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_referrals_referrer_identity
  ON dotcast_referrals (referrer_user_id, referred_identity_hash);

CREATE TABLE IF NOT EXISTS dotcast_referral_rewards (
  reward_id TEXT PRIMARY KEY,
  referral_id TEXT NOT NULL,
  reward_batch_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('referrer', 'referred')),
  status TEXT NOT NULL CHECK (status IN ('granted', 'suppressed')),
  free_entries_granted INTEGER NOT NULL CHECK (free_entries_granted >= 0),
  suppressed_reason TEXT,
  credit_ids_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_referral_rewards_user_created
  ON dotcast_referral_rewards (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_referral_rewards_referral
  ON dotcast_referral_rewards (referral_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_referral_aml_flags (
  flag_id TEXT PRIMARY KEY,
  referrer_user_id TEXT NOT NULL,
  referred_user_id TEXT NOT NULL,
  cluster_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'deposit_refer_withdraw_ring'),
  severity TEXT NOT NULL CHECK (severity IN ('medium', 'high')),
  related_referral_ids_json TEXT NOT NULL,
  related_identity_hashes_json TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_referral_aml_flags_referrer
  ON dotcast_referral_aml_flags (referrer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_referral_aml_flags_referred
  ON dotcast_referral_aml_flags (referred_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_referral_aml_flags_cluster
  ON dotcast_referral_aml_flags (cluster_key, created_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_referral_events (
  event_id TEXT PRIMARY KEY,
  referral_id TEXT,
  referrer_user_id TEXT,
  referred_user_id TEXT,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'REFERRAL_CODE_CREATED',
      'REFERRAL_CLAIMED',
      'REFERRAL_QUALIFIED',
      'REFERRAL_REWARDED',
      'REFERRAL_REJECTED',
      'REFERRAL_AML_FLAGGED'
    )
  ),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_referral_events_referral
  ON dotcast_referral_events (referral_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_referral_events_referrer
  ON dotcast_referral_events (referrer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_referral_events_referred
  ON dotcast_referral_events (referred_user_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS dotcast_referral_rewards_no_update
BEFORE UPDATE ON dotcast_referral_rewards
BEGIN
  SELECT RAISE(ABORT, 'dotcast_referral_rewards is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_referral_rewards_no_delete
BEFORE DELETE ON dotcast_referral_rewards
BEGIN
  SELECT RAISE(ABORT, 'dotcast_referral_rewards is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_referral_aml_flags_no_update
BEFORE UPDATE ON dotcast_referral_aml_flags
BEGIN
  SELECT RAISE(ABORT, 'dotcast_referral_aml_flags is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_referral_aml_flags_no_delete
BEFORE DELETE ON dotcast_referral_aml_flags
BEGIN
  SELECT RAISE(ABORT, 'dotcast_referral_aml_flags is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_referral_events_no_update
BEFORE UPDATE ON dotcast_referral_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_referral_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_referral_events_no_delete
BEFORE DELETE ON dotcast_referral_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_referral_events is append-only');
END;
