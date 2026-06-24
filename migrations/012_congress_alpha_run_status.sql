CREATE TABLE IF NOT EXISTS congress_alpha_runs_v2 (
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

INSERT OR IGNORE INTO congress_alpha_runs_v2
  (
    run_id,
    status,
    mode,
    bankroll,
    max_positions,
    min_score,
    generated_signals,
    target_count,
    order_count,
    created_by,
    error_message,
    created_at,
    completed_at
  )
SELECT
  run_id,
  CASE
    WHEN status IN ('RUNNING', 'COMPLETED', 'FAILED') THEN status
    ELSE 'FAILED'
  END,
  mode,
  bankroll,
  max_positions,
  min_score,
  generated_signals,
  target_count,
  order_count,
  created_by,
  error_message,
  created_at,
  completed_at
FROM congress_alpha_runs;

DROP TABLE congress_alpha_runs;

ALTER TABLE congress_alpha_runs_v2 RENAME TO congress_alpha_runs;

CREATE INDEX IF NOT EXISTS idx_congress_alpha_runs_created
  ON congress_alpha_runs(created_at DESC);
