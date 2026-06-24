ALTER TABLE congress_alpha_runs ADD COLUMN max_weight_pct REAL;
ALTER TABLE congress_alpha_runs ADD COLUMN lookback_days INTEGER;
ALTER TABLE congress_alpha_runs ADD COLUMN config_json TEXT;
ALTER TABLE congress_alpha_runs ADD COLUMN enrichment_json TEXT;
ALTER TABLE congress_alpha_runs ADD COLUMN backtest_json TEXT;

CREATE TABLE IF NOT EXISTS congress_alpha_settings (
  key TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS congress_alpha_company_enrichment (
  symbol TEXT PRIMARY KEY,
  company_name TEXT,
  cik TEXT,
  sic TEXT,
  sic_description TEXT,
  sector TEXT,
  latest_news_json TEXT,
  fundamentals_json TEXT,
  source_json TEXT NOT NULL,
  enriched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS congress_alpha_backtests (
  backtest_id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS congress_alpha_signal_attribution (
  attribution_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  disclosure_alpha REAL NOT NULL DEFAULT 0,
  conflict_alpha REAL NOT NULL DEFAULT 0,
  bipartisan_alpha REAL NOT NULL DEFAULT 0,
  recency_alpha REAL NOT NULL DEFAULT 0,
  realized_return_pct REAL,
  attribution_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (run_id) REFERENCES congress_alpha_runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_congress_alpha_attribution_run
  ON congress_alpha_signal_attribution(run_id, symbol);

CREATE INDEX IF NOT EXISTS idx_congress_alpha_backtests_created
  ON congress_alpha_backtests(created_at DESC);
