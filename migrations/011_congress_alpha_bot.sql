CREATE TABLE IF NOT EXISTS congress_alpha_runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  mode TEXT NOT NULL DEFAULT 'PAPER_ONLY',
  bankroll REAL NOT NULL,
  max_positions INTEGER NOT NULL,
  min_score REAL NOT NULL,
  generated_signals INTEGER NOT NULL DEFAULT 0,
  target_count INTEGER NOT NULL DEFAULT 0,
  order_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS congress_alpha_signals (
  signal_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  sector TEXT,
  as_of TEXT NOT NULL,
  score REAL NOT NULL,
  confidence REAL NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'FLAT', 'AVOID')),
  horizon_days INTEGER NOT NULL,
  latest_trade_at TEXT,
  current_price REAL,
  net_amount_mid REAL NOT NULL DEFAULT 0,
  purchase_amount_mid REAL NOT NULL DEFAULT 0,
  sale_amount_mid REAL NOT NULL DEFAULT 0,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  purchase_count INTEGER NOT NULL DEFAULT 0,
  sale_count INTEGER NOT NULL DEFAULT 0,
  member_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  bipartisan_score REAL NOT NULL DEFAULT 0,
  freshness_penalty REAL NOT NULL DEFAULT 0,
  rationale_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (run_id) REFERENCES congress_alpha_runs(run_id)
);

CREATE TABLE IF NOT EXISTS congress_alpha_targets (
  target_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  signal_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  sector TEXT,
  reference_price REAL,
  target_weight_pct REAL NOT NULL,
  target_notional REAL NOT NULL,
  score REAL NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (run_id) REFERENCES congress_alpha_runs(run_id),
  FOREIGN KEY (signal_id) REFERENCES congress_alpha_signals(signal_id)
);

CREATE TABLE IF NOT EXISTS congress_alpha_paper_orders (
  order_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  signal_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity REAL NOT NULL,
  limit_price REAL NOT NULL,
  notional REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'PAPER_FILLED',
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (run_id) REFERENCES congress_alpha_runs(run_id),
  FOREIGN KEY (signal_id) REFERENCES congress_alpha_signals(signal_id)
);

CREATE TABLE IF NOT EXISTS congress_alpha_paper_positions (
  symbol TEXT PRIMARY KEY,
  quantity REAL NOT NULL,
  avg_price REAL NOT NULL,
  market_price REAL NOT NULL,
  market_value REAL NOT NULL,
  unrealized_pnl REAL NOT NULL DEFAULT 0,
  target_weight_pct REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_congress_alpha_runs_created
  ON congress_alpha_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_congress_alpha_signals_run_score
  ON congress_alpha_signals(run_id, score DESC);

CREATE INDEX IF NOT EXISTS idx_congress_alpha_signals_symbol_created
  ON congress_alpha_signals(symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_congress_alpha_targets_run_weight
  ON congress_alpha_targets(run_id, target_weight_pct DESC);

CREATE INDEX IF NOT EXISTS idx_congress_alpha_orders_run_created
  ON congress_alpha_paper_orders(run_id, created_at DESC);
