DROP TRIGGER IF EXISTS dotcast_points_ledger_no_update;
DROP TRIGGER IF EXISTS dotcast_points_ledger_no_delete;

ALTER TABLE dotcast_points_ledger RENAME TO dotcast_points_ledger_e9_old;

CREATE TABLE dotcast_points_ledger (
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
      'rewarded_stream',
      'adjustment'
    )
  ),
  pool_id TEXT,
  entry_id TEXT,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO dotcast_points_ledger (
  ledger_id, user_id, delta, reason, pool_id, entry_id, balance_after, event_json, created_at
)
SELECT ledger_id, user_id, delta, reason, pool_id, entry_id, balance_after, event_json, created_at
FROM dotcast_points_ledger_e9_old;

DROP TABLE dotcast_points_ledger_e9_old;

CREATE INDEX IF NOT EXISTS idx_dotcast_points_ledger_user_created
  ON dotcast_points_ledger (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_points_ledger_pool_created
  ON dotcast_points_ledger (pool_id, created_at DESC);

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

ALTER TABLE dotcast_free_entry_credits RENAME TO dotcast_free_entry_credits_e9_old;

CREATE TABLE dotcast_free_entry_credits (
  credit_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  grant_reason TEXT NOT NULL CHECK (
    grant_reason IN ('streak_bonus', 'manual_grant', 'rewarded_stream', 'adjustment')
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
  CASE WHEN grant_reason = 'rewarded_ad' THEN 'rewarded_stream' ELSE grant_reason END,
  pool_id,
  granted_at,
  expires_at,
  consumed_at,
  consumed_by_entry_id,
  event_json
FROM dotcast_free_entry_credits_e9_old;

DROP TABLE dotcast_free_entry_credits_e9_old;

CREATE INDEX IF NOT EXISTS idx_dotcast_free_entry_credits_user_granted
  ON dotcast_free_entry_credits (user_id, granted_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_free_entry_credits_user_available
  ON dotcast_free_entry_credits (user_id, consumed_at, granted_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_rewarded_stream_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'invalidated')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  watched_seconds INTEGER NOT NULL DEFAULT 0 CHECK (watched_seconds >= 0),
  required_watch_seconds INTEGER NOT NULL CHECK (required_watch_seconds >= 0),
  stream_started_at TEXT NOT NULL,
  stream_stopped_at TEXT,
  reward_id TEXT,
  event_json TEXT NOT NULL,
  UNIQUE (user_id, stream_id)
);

CREATE INDEX IF NOT EXISTS idx_dotcast_rewarded_stream_sessions_user_started
  ON dotcast_rewarded_stream_sessions (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_rewarded_stream_sessions_stream
  ON dotcast_rewarded_stream_sessions (stream_id, started_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_rewarded_stream_progress (
  user_id TEXT PRIMARY KEY,
  completed_streams INTEGER NOT NULL DEFAULT 0 CHECK (completed_streams >= 0),
  cycle_completed_streams INTEGER NOT NULL DEFAULT 0 CHECK (cycle_completed_streams >= 0),
  reward_cycles INTEGER NOT NULL DEFAULT 0 CHECK (reward_cycles >= 0),
  points_earned INTEGER NOT NULL DEFAULT 0 CHECK (points_earned >= 0),
  free_entries_earned INTEGER NOT NULL DEFAULT 0 CHECK (free_entries_earned >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_rewarded_stream_progress_cycles
  ON dotcast_rewarded_stream_progress (reward_cycles DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_rewarded_stream_rewards (
  reward_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
  completed_session_id TEXT NOT NULL UNIQUE,
  completed_streams INTEGER NOT NULL CHECK (completed_streams > 0),
  points_granted INTEGER NOT NULL CHECK (points_granted >= 0),
  free_entries_granted INTEGER NOT NULL CHECK (free_entries_granted >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_rewarded_stream_rewards_user_created
  ON dotcast_rewarded_stream_rewards (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_rewarded_stream_events (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('SESSION_STARTED', 'SESSION_COMPLETED', 'REWARD_GRANTED')
  ),
  reward_id TEXT,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_rewarded_stream_events_user_created
  ON dotcast_rewarded_stream_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_rewarded_stream_events_stream_created
  ON dotcast_rewarded_stream_events (stream_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS dotcast_rewarded_stream_events_no_update
BEFORE UPDATE ON dotcast_rewarded_stream_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_rewarded_stream_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_rewarded_stream_events_no_delete
BEFORE DELETE ON dotcast_rewarded_stream_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_rewarded_stream_events is append-only');
END;
