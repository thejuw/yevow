CREATE TABLE IF NOT EXISTS dotcast_resolution_routes (
  route_id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  pool_id TEXT,
  tier TEXT NOT NULL CHECK (
    tier IN ('hard_oracle', 'computed_oracle', 'ai_perception', 'optimistic_bonded', 'human_jury')
  ),
  status TEXT NOT NULL CHECK (status IN ('locked', 'review_required', 'points_only', 'blocked')),
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  resolution_statement TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  source_available INTEGER NOT NULL CHECK (source_available IN (0, 1)),
  auto_resolvable INTEGER NOT NULL CHECK (auto_resolvable IN (0, 1)),
  review_required INTEGER NOT NULL CHECK (review_required IN (0, 1)),
  points_only INTEGER NOT NULL CHECK (points_only IN (0, 1)),
  blocked_reason TEXT,
  steering_prompt TEXT,
  fee_bps INTEGER NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  bond_minor_units INTEGER NOT NULL CHECK (bond_minor_units >= 0),
  panel_size INTEGER NOT NULL CHECK (panel_size >= 0),
  locked_at TEXT,
  classifier_version TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (status <> 'locked' OR locked_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolution_routes_market_created
  ON dotcast_resolution_routes (market_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolution_routes_pool
  ON dotcast_resolution_routes (pool_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolution_routes_review
  ON dotcast_resolution_routes (status, tier, created_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_resolution_reviews (
  review_id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  pool_id TEXT,
  market_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'approved', 'denied', 'reshaped')),
  reviewer_id TEXT,
  decision_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolution_reviews_route
  ON dotcast_resolution_reviews (route_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_ai_resolution_logs (
  log_id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  pool_id TEXT,
  model_confidence_bps INTEGER NOT NULL CHECK (model_confidence_bps BETWEEN 0 AND 10000),
  predicted_outcome TEXT NOT NULL CHECK (predicted_outcome IN ('yes', 'no', 'invalid', 'pending')),
  action TEXT NOT NULL CHECK (action IN ('auto_resolved', 'escalated')),
  threshold_bps INTEGER NOT NULL CHECK (threshold_bps BETWEEN 0 AND 10000),
  evidence_refs_json TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_ai_resolution_logs_route
  ON dotcast_ai_resolution_logs (route_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_optimistic_resolution_proposals (
  proposal_id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  proposer_id TEXT NOT NULL,
  proposed_outcome TEXT NOT NULL CHECK (proposed_outcome IN ('yes', 'no', 'invalid')),
  bond_minor_units INTEGER NOT NULL CHECK (bond_minor_units >= 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'challenged', 'accepted', 'rejected')),
  challenge_deadline_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_optimistic_resolution_pool
  ON dotcast_optimistic_resolution_proposals (pool_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_resolver_panels (
  panel_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('hard_oracle', 'computed_oracle', 'ai_perception', 'optimistic_bonded', 'human_jury')),
  panel_size INTEGER NOT NULL CHECK (panel_size > 0),
  estimated_stake_minor_units INTEGER NOT NULL CHECK (estimated_stake_minor_units >= 0),
  resolver_fee_bps INTEGER NOT NULL CHECK (resolver_fee_bps BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolver_panels_pool
  ON dotcast_resolver_panels (pool_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_resolver_assignments (
  assignment_id TEXT PRIMARY KEY,
  panel_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  resolver_id TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  reputation_bps INTEGER NOT NULL CHECK (reputation_bps BETWEEN 0 AND 10000),
  bond_minor_units INTEGER NOT NULL CHECK (bond_minor_units >= 0),
  status TEXT NOT NULL CHECK (status IN ('assigned', 'committed', 'revealed', 'paid', 'slashed')),
  assigned_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolver_assignments_panel
  ON dotcast_resolver_assignments (panel_id, assigned_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dotcast_resolver_assignments_panel_identity
  ON dotcast_resolver_assignments (panel_id, identity_hash);

CREATE TABLE IF NOT EXISTS dotcast_resolver_commits (
  assignment_id TEXT PRIMARY KEY,
  panel_id TEXT NOT NULL,
  resolver_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  committed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolver_commits_panel
  ON dotcast_resolver_commits (panel_id, committed_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_resolver_reveals (
  assignment_id TEXT PRIMARY KEY,
  panel_id TEXT NOT NULL,
  resolver_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('yes', 'no', 'invalid')),
  salt TEXT NOT NULL,
  revealed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolver_reveals_panel
  ON dotcast_resolver_reveals (panel_id, revealed_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_resolver_payouts (
  payout_id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id TEXT NOT NULL,
  panel_id TEXT NOT NULL,
  resolver_id TEXT NOT NULL,
  matched_consensus INTEGER NOT NULL CHECK (matched_consensus IN (0, 1)),
  bond_returned_minor_units INTEGER NOT NULL CHECK (bond_returned_minor_units >= 0),
  fee_paid_minor_units INTEGER NOT NULL CHECK (fee_paid_minor_units >= 0),
  slashed_bond_minor_units INTEGER NOT NULL CHECK (slashed_bond_minor_units >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (assignment_id, panel_id)
);

CREATE INDEX IF NOT EXISTS idx_dotcast_resolver_payouts_panel
  ON dotcast_resolver_payouts (panel_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS dotcast_resolution_routes_no_update
BEFORE UPDATE ON dotcast_resolution_routes
BEGIN
  SELECT RAISE(ABORT, 'dotcast_resolution_routes is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_resolution_routes_no_delete
BEFORE DELETE ON dotcast_resolution_routes
BEGIN
  SELECT RAISE(ABORT, 'dotcast_resolution_routes is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_ai_resolution_logs_no_update
BEFORE UPDATE ON dotcast_ai_resolution_logs
BEGIN
  SELECT RAISE(ABORT, 'dotcast_ai_resolution_logs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_ai_resolution_logs_no_delete
BEFORE DELETE ON dotcast_ai_resolution_logs
BEGIN
  SELECT RAISE(ABORT, 'dotcast_ai_resolution_logs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_resolver_commits_no_update
BEFORE UPDATE ON dotcast_resolver_commits
BEGIN
  SELECT RAISE(ABORT, 'dotcast_resolver_commits is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_resolver_commits_no_delete
BEFORE DELETE ON dotcast_resolver_commits
BEGIN
  SELECT RAISE(ABORT, 'dotcast_resolver_commits is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_resolver_reveals_no_update
BEFORE UPDATE ON dotcast_resolver_reveals
BEGIN
  SELECT RAISE(ABORT, 'dotcast_resolver_reveals is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_resolver_reveals_no_delete
BEFORE DELETE ON dotcast_resolver_reveals
BEGIN
  SELECT RAISE(ABORT, 'dotcast_resolver_reveals is append-only');
END;
