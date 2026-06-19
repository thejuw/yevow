PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pe_deals (
  id TEXT PRIMARY KEY,
  published_date TEXT NOT NULL,
  buyer TEXT NOT NULL,
  target_company TEXT NOT NULL,
  deal_size REAL CHECK (deal_size IS NULL OR deal_size >= 0),
  sector TEXT,
  source_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pe_deals_source_target_date
  ON pe_deals (source_url, target_company, published_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pe_deals_source_url
  ON pe_deals (source_url);

CREATE INDEX IF NOT EXISTS idx_pe_deals_published_date
  ON pe_deals (published_date DESC);

CREATE INDEX IF NOT EXISTS idx_pe_deals_buyer_published_date
  ON pe_deals (buyer, published_date DESC);

CREATE INDEX IF NOT EXISTS idx_pe_deals_sector_published_date
  ON pe_deals (sector, published_date DESC);

CREATE INDEX IF NOT EXISTS idx_pe_deals_target_company
  ON pe_deals (target_company);
