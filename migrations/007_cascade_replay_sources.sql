CREATE TABLE IF NOT EXISTS cascade_liquidations (
  event_id TEXT PRIMARY KEY,
  instrument_code TEXT NOT NULL,
  source_exchange TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT', 'UNKNOWN')),
  forced_flow_side TEXT NOT NULL CHECK (forced_flow_side IN ('BUY', 'SELL', 'UNKNOWN')),
  price REAL NOT NULL CHECK (price > 0),
  notional_usd REAL NOT NULL CHECK (notional_usd > 0),
  base_size REAL NOT NULL CHECK (base_size >= 0),
  exchange_timestamp TEXT,
  observed_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_cascade_liquidations_observed_at
  ON cascade_liquidations (observed_at);

CREATE INDEX IF NOT EXISTS idx_cascade_liquidations_instrument_observed_at
  ON cascade_liquidations (instrument_code, observed_at);

CREATE INDEX IF NOT EXISTS idx_cascade_liquidations_side_observed_at
  ON cascade_liquidations (side, observed_at);
