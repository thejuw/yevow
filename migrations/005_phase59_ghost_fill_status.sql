CREATE TABLE IF NOT EXISTS trades_phase59 (
  trade_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  signal_id TEXT,
  venue TEXT NOT NULL,
  asset TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'IOC', 'FOK')),
  price REAL NOT NULL CHECK (price > 0),
  size REAL NOT NULL CHECK (size > 0),
  notional REAL NOT NULL CHECK (notional >= 0),
  ev_at_execution REAL NOT NULL,
  slippage_bps REAL NOT NULL,
  resulting_pnl REAL NOT NULL DEFAULT 0,
  primary_driver TEXT CHECK (primary_driver IN ('ORACLE', 'SENTIMENT', 'PROFILER', 'CROUPIER', 'PIT_BOSS', 'HEDGE', 'JANITOR', 'EXECUTIONER', 'MOLTWORKER', 'RISK', 'SYSTEM')),
  fees REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'FILLED', 'PARTIAL', 'REJECTED', 'CANCELLED', 'GHOST_FILL')),
  exchange_trade_id TEXT,
  raw_execution_json TEXT,
  executed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (signal_id) REFERENCES agent_decisions(signal_id)
);

INSERT OR REPLACE INTO trades_phase59
SELECT
  trade_id,
  order_id,
  signal_id,
  venue,
  asset,
  side,
  order_type,
  price,
  size,
  notional,
  ev_at_execution,
  slippage_bps,
  resulting_pnl,
  primary_driver,
  fees,
  status,
  exchange_trade_id,
  raw_execution_json,
  executed_at,
  created_at
FROM trades;

DROP TABLE trades;
ALTER TABLE trades_phase59 RENAME TO trades;

CREATE INDEX IF NOT EXISTS idx_trades_executed_at
  ON trades (executed_at);

CREATE INDEX IF NOT EXISTS idx_trades_status_executed_at
  ON trades (status, executed_at);

CREATE INDEX IF NOT EXISTS idx_trades_asset
  ON trades (asset);

CREATE INDEX IF NOT EXISTS idx_trades_signal_id
  ON trades (signal_id);

CREATE INDEX IF NOT EXISTS idx_trades_primary_driver_executed_at
  ON trades (primary_driver, executed_at);
