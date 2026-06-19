CREATE TABLE IF NOT EXISTS congress_committee_assignments (
  member_key TEXT NOT NULL,
  member_name TEXT NOT NULL,
  chamber TEXT NOT NULL,
  committee_code TEXT NOT NULL,
  committee_name TEXT NOT NULL,
  committee_role TEXT,
  source TEXT NOT NULL,
  source_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (member_key, chamber, committee_code)
);

CREATE INDEX IF NOT EXISTS idx_congress_committee_assignments_member
  ON congress_committee_assignments (member_key, chamber);

CREATE INDEX IF NOT EXISTS idx_congress_committee_assignments_committee
  ON congress_committee_assignments (committee_code, committee_name);

CREATE TABLE IF NOT EXISTS congress_conflict_flags (
  flag_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  member_name TEXT,
  chamber TEXT NOT NULL,
  symbol TEXT,
  asset_name TEXT,
  transaction_type TEXT NOT NULL,
  sector TEXT NOT NULL,
  committee_code TEXT NOT NULL,
  committee_name TEXT NOT NULL,
  committee_role TEXT,
  severity TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (transaction_id) REFERENCES congress_transactions(transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_congress_conflict_flags_transaction
  ON congress_conflict_flags (transaction_id);

CREATE INDEX IF NOT EXISTS idx_congress_conflict_flags_member_created
  ON congress_conflict_flags (member_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_congress_conflict_flags_sector_created
  ON congress_conflict_flags (sector, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_congress_conflict_flags_severity_created
  ON congress_conflict_flags (severity, created_at DESC);
