CREATE TABLE IF NOT EXISTS dotcast_resolution_challenges (
  challenge_id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  pool_id TEXT,
  market_id TEXT NOT NULL,
  challenger_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'rejected', 'expired', 'withdrawn')),
  reason TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  bond_minor_units INTEGER NOT NULL CHECK (bond_minor_units >= 0),
  opened_at TEXT NOT NULL,
  challenge_window_closes_at TEXT NOT NULL,
  decided_at TEXT,
  decision_by TEXT,
  decision_json TEXT NOT NULL,
  event_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolution_challenges_route
  ON dotcast_resolution_challenges (route_id, status, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolution_challenges_pool
  ON dotcast_resolution_challenges (pool_id, status, opened_at DESC);

CREATE TRIGGER IF NOT EXISTS dotcast_resolution_challenges_no_identity_update
BEFORE UPDATE OF challenge_id, route_id, pool_id, market_id, challenger_id, reason,
  evidence_refs_json, bond_minor_units, opened_at, challenge_window_closes_at
ON dotcast_resolution_challenges
BEGIN
  SELECT RAISE(ABORT, 'dotcast_resolution_challenges immutable fields cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_resolution_challenges_no_delete
BEFORE DELETE ON dotcast_resolution_challenges
BEGIN
  SELECT RAISE(ABORT, 'dotcast_resolution_challenges cannot be deleted');
END;
