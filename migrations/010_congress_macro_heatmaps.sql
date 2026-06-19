CREATE TABLE IF NOT EXISTS congress_member_profiles (
  member_key TEXT PRIMARY KEY,
  member_name TEXT NOT NULL,
  chamber TEXT NOT NULL,
  party TEXT,
  state TEXT,
  district TEXT,
  bioguide_id TEXT,
  source TEXT NOT NULL,
  source_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_congress_member_profiles_party
  ON congress_member_profiles (party, chamber);

CREATE INDEX IF NOT EXISTS idx_congress_member_profiles_bioguide
  ON congress_member_profiles (bioguide_id);

ALTER TABLE congress_transactions ADD COLUMN member_key TEXT;
ALTER TABLE congress_transactions ADD COLUMN member_party TEXT;
ALTER TABLE congress_transactions ADD COLUMN security_sector TEXT;

CREATE INDEX IF NOT EXISTS idx_congress_transactions_party_date
  ON congress_transactions (member_party, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_congress_transactions_sector_date
  ON congress_transactions (security_sector, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_congress_transactions_macro_symbol_date
  ON congress_transactions (symbol, security_sector, transaction_date DESC);
