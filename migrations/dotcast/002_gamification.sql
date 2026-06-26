CREATE TABLE IF NOT EXISTS dotcast_gamification_profiles (
  user_id TEXT PRIMARY KEY,
  points_balance INTEGER NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  current_streak INTEGER NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
  longest_streak INTEGER NOT NULL DEFAULT 0 CHECK (longest_streak >= 0),
  settled_predictions INTEGER NOT NULL DEFAULT 0 CHECK (settled_predictions >= 0),
  correct_predictions INTEGER NOT NULL DEFAULT 0 CHECK (correct_predictions >= 0),
  incorrect_predictions INTEGER NOT NULL DEFAULT 0 CHECK (incorrect_predictions >= 0),
  free_entries_granted INTEGER NOT NULL DEFAULT 0 CHECK (free_entries_granted >= 0),
  free_entries_consumed INTEGER NOT NULL DEFAULT 0 CHECK (free_entries_consumed >= 0),
  last_settled_pool_id TEXT,
  last_settled_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_gamification_profiles_points
  ON dotcast_gamification_profiles (points_balance DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_gamification_profiles_streak
  ON dotcast_gamification_profiles (current_streak DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_points_ledger (
  ledger_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN (
      'predict_correct',
      'predict_incorrect',
      'streak_bonus',
      'free_entry_grant',
      'free_entry_redeem',
      'adjustment'
    )
  ),
  pool_id TEXT,
  entry_id TEXT,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_points_ledger_user_created
  ON dotcast_points_ledger (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_points_ledger_pool_created
  ON dotcast_points_ledger (pool_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_free_entry_credits (
  credit_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  grant_reason TEXT NOT NULL CHECK (
    grant_reason IN ('streak_bonus', 'manual_grant', 'rewarded_ad', 'adjustment')
  ),
  pool_id TEXT,
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  consumed_at TEXT,
  consumed_by_entry_id TEXT,
  event_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_free_entry_credits_user_granted
  ON dotcast_free_entry_credits (user_id, granted_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_free_entry_credits_user_available
  ON dotcast_free_entry_credits (user_id, consumed_at, granted_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_gamification_settlements (
  pool_id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('yes', 'no')),
  unit TEXT NOT NULL CHECK (unit = 'points'),
  status TEXT NOT NULL CHECK (status = 'settled'),
  applied_entries INTEGER NOT NULL CHECK (applied_entries >= 0),
  correct_entries INTEGER NOT NULL CHECK (correct_entries >= 0),
  incorrect_entries INTEGER NOT NULL CHECK (incorrect_entries >= 0),
  points_awarded INTEGER NOT NULL CHECK (points_awarded >= 0),
  free_entries_granted INTEGER NOT NULL CHECK (free_entries_granted >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_gamification_settlements_created
  ON dotcast_gamification_settlements (created_at DESC);

CREATE TRIGGER IF NOT EXISTS dotcast_points_ledger_no_update
BEFORE UPDATE ON dotcast_points_ledger
BEGIN
  SELECT RAISE(ABORT, 'dotcast_points_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_points_ledger_no_delete
BEFORE DELETE ON dotcast_points_ledger
BEGIN
  SELECT RAISE(ABORT, 'dotcast_points_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_gamification_settlements_no_update
BEFORE UPDATE ON dotcast_gamification_settlements
BEGIN
  SELECT RAISE(ABORT, 'dotcast_gamification_settlements is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_gamification_settlements_no_delete
BEFORE DELETE ON dotcast_gamification_settlements
BEGIN
  SELECT RAISE(ABORT, 'dotcast_gamification_settlements is append-only');
END;
