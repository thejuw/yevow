CREATE TABLE IF NOT EXISTS congress_scrape_runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'all',
  scheduled_for TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  stats_json TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_congress_scrape_runs_created_at
  ON congress_scrape_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_congress_scrape_runs_status_created_at
  ON congress_scrape_runs (status, created_at DESC);

CREATE TABLE IF NOT EXISTS congress_filings (
  filing_id TEXT PRIMARY KEY,
  chamber TEXT NOT NULL,
  source TEXT NOT NULL,
  source_filing_id TEXT,
  report_type TEXT NOT NULL,
  filer_name TEXT,
  filing_date TEXT,
  source_url TEXT,
  raw_r2_key TEXT,
  raw_sha256 TEXT,
  parser_status TEXT NOT NULL DEFAULT 'PENDING',
  parser_confidence REAL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_congress_filings_filing_date
  ON congress_filings (filing_date DESC);

CREATE INDEX IF NOT EXISTS idx_congress_filings_chamber_date
  ON congress_filings (chamber, filing_date DESC);

CREATE INDEX IF NOT EXISTS idx_congress_filings_filer_date
  ON congress_filings (filer_name, filing_date DESC);

CREATE TABLE IF NOT EXISTS congress_transactions (
  transaction_id TEXT PRIMARY KEY,
  filing_id TEXT,
  chamber TEXT NOT NULL,
  member_name TEXT,
  owner TEXT,
  symbol TEXT,
  asset_name TEXT,
  transaction_type TEXT NOT NULL,
  transaction_date TEXT,
  notification_date TEXT,
  amount_min REAL,
  amount_max REAL,
  amount_mid REAL,
  transaction_price REAL,
  transaction_price_as_of TEXT,
  current_price REAL,
  current_price_as_of TEXT,
  pnl_estimate REAL,
  return_pct REAL,
  price_provider TEXT,
  confidence REAL,
  raw_text TEXT,
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (filing_id) REFERENCES congress_filings(filing_id)
);

CREATE INDEX IF NOT EXISTS idx_congress_transactions_symbol_date
  ON congress_transactions (symbol, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_congress_transactions_member_date
  ON congress_transactions (member_name, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_congress_transactions_type_date
  ON congress_transactions (transaction_type, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_congress_transactions_updated_at
  ON congress_transactions (updated_at);

CREATE TABLE IF NOT EXISTS congress_cleaning_issues (
  issue_id TEXT PRIMARY KEY,
  filing_id TEXT,
  transaction_id TEXT,
  severity TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  message TEXT NOT NULL,
  raw_context_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (filing_id) REFERENCES congress_filings(filing_id),
  FOREIGN KEY (transaction_id) REFERENCES congress_transactions(transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_congress_cleaning_issues_created_at
  ON congress_cleaning_issues (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_congress_cleaning_issues_severity
  ON congress_cleaning_issues (severity, created_at DESC);

CREATE TABLE IF NOT EXISTS congress_price_cache (
  symbol TEXT NOT NULL,
  provider TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  price REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  raw_json TEXT,
  PRIMARY KEY (symbol, provider, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_congress_price_cache_fetched_at
  ON congress_price_cache (fetched_at DESC);
