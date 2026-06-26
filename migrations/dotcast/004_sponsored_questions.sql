CREATE TABLE IF NOT EXISTS dotcast_sponsored_questions (
  sponsorship_id TEXT PRIMARY KEY,
  sponsor_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  venue TEXT NOT NULL CHECK (venue IN ('kalshi', 'polymarket')),
  question TEXT NOT NULL,
  market_status TEXT NOT NULL,
  close_time TEXT NOT NULL,
  expected_resolve_at TEXT,
  reference_url TEXT,
  pricing_model TEXT NOT NULL CHECK (
    pricing_model IN ('flat_fee', 'cpm', 'completed_prediction', 'auction')
  ),
  budget_minor_units INTEGER NOT NULL DEFAULT 0 CHECK (budget_minor_units >= 0),
  placement_priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (
    status IN ('pending_review', 'active', 'paused', 'archived', 'rejected')
  ),
  disclosure_label TEXT NOT NULL CHECK (disclosure_label = 'Sponsored'),
  sponsor_name TEXT NOT NULL,
  brand_color TEXT,
  logo_url TEXT,
  context_text TEXT,
  conflict_status TEXT NOT NULL CHECK (conflict_status IN ('clear', 'blocked', 'pending')),
  conflict_reasons_json TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  metadata_json TEXT NOT NULL,
  integrity_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (sponsor_id, campaign_id, market_id)
);

CREATE INDEX IF NOT EXISTS idx_dotcast_sponsored_questions_feed
  ON dotcast_sponsored_questions (status, placement_priority DESC, starts_at, ends_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_sponsored_questions_market
  ON dotcast_sponsored_questions (venue, market_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_sponsored_questions_sponsor
  ON dotcast_sponsored_questions (sponsor_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_sponsored_question_events (
  event_id TEXT PRIMARY KEY,
  sponsorship_id TEXT NOT NULL,
  sponsor_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'SPONSORSHIP_CREATED',
      'CONFLICT_REJECTED',
      'SPONSORSHIP_STATUS_CHANGED',
      'BILLING_EVENT_RECORDED'
    )
  ),
  status TEXT,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_sponsored_question_events_sponsorship
  ON dotcast_sponsored_question_events (sponsorship_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_sponsored_question_events_sponsor
  ON dotcast_sponsored_question_events (sponsor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dotcast_sponsored_question_billing_events (
  billing_event_id TEXT PRIMARY KEY,
  sponsorship_id TEXT NOT NULL,
  sponsor_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'flat_fee_reserved',
      'impression',
      'completed_prediction',
      'auction_charge',
      'adjustment'
    )
  ),
  pricing_model TEXT NOT NULL CHECK (
    pricing_model IN ('flat_fee', 'cpm', 'completed_prediction', 'auction')
  ),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  amount_minor_units INTEGER NOT NULL CHECK (amount_minor_units >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dotcast_sponsored_question_billing_sponsorship
  ON dotcast_sponsored_question_billing_events (sponsorship_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dotcast_sponsored_question_billing_sponsor
  ON dotcast_sponsored_question_billing_events (sponsor_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS dotcast_sponsored_question_events_no_update
BEFORE UPDATE ON dotcast_sponsored_question_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_sponsored_question_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_sponsored_question_events_no_delete
BEFORE DELETE ON dotcast_sponsored_question_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_sponsored_question_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_sponsored_question_billing_events_no_update
BEFORE UPDATE ON dotcast_sponsored_question_billing_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_sponsored_question_billing_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS dotcast_sponsored_question_billing_events_no_delete
BEFORE DELETE ON dotcast_sponsored_question_billing_events
BEGIN
  SELECT RAISE(ABORT, 'dotcast_sponsored_question_billing_events is append-only');
END;
