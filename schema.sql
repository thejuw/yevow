PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK (level IN ('DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL')),
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  correlation_id TEXT,
  telemetry_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at
  ON logs (created_at);

CREATE INDEX IF NOT EXISTS idx_logs_level_created_at
  ON logs (level, created_at);

CREATE INDEX IF NOT EXISTS idx_logs_event_type
  ON logs (event_type);

CREATE INDEX IF NOT EXISTS idx_logs_event_type_created_at
  ON logs (event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_logs_correlation_id
  ON logs (correlation_id);

CREATE TABLE IF NOT EXISTS agent_decisions (
  decision_id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL UNIQUE,
  trace_id TEXT NOT NULL,
  agent_name TEXT NOT NULL CHECK (agent_name IN ('ORACLE', 'SENTIMENT', 'PROFILER', 'CROUPIER', 'PIT_BOSS', 'JANITOR', 'EXECUTIONER', 'MOLTWORKER', 'RISK', 'SYSTEM')),
  target_agent TEXT CHECK (target_agent IN ('ORACLE', 'SENTIMENT', 'PROFILER', 'CROUPIER', 'PIT_BOSS', 'JANITOR', 'EXECUTIONER', 'MOLTWORKER', 'RISK', 'SYSTEM')),
  instrument_code TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('BUY', 'SELL', 'HOLD', 'CANCEL', 'REDUCE', 'QUOTE', 'EXECUTE', 'PAUSE', 'RESUME', 'SUPERVISOR_ACTION')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  expected_value REAL,
  max_slippage_bps REAL,
  rationale TEXT NOT NULL,
  feature_vector_json TEXT,
  risk_snapshot_json TEXT,
  raw_signal_json TEXT NOT NULL,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_created_at
  ON agent_decisions (created_at);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_agent_name
  ON agent_decisions (agent_name);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_agent_created_at
  ON agent_decisions (agent_name, created_at);

CREATE INDEX IF NOT EXISTS idx_agent_decisions_instrument
  ON agent_decisions (instrument_code);

CREATE TABLE IF NOT EXISTS trades (
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
  primary_driver TEXT CHECK (primary_driver IN ('ORACLE', 'SENTIMENT', 'PROFILER', 'CROUPIER', 'PIT_BOSS', 'JANITOR', 'EXECUTIONER', 'MOLTWORKER', 'RISK', 'SYSTEM')),
  fees REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ACCEPTED', 'FILLED', 'PARTIAL', 'REJECTED', 'CANCELLED', 'GHOST_FILL')),
  exchange_trade_id TEXT,
  raw_execution_json TEXT,
  executed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (signal_id) REFERENCES agent_decisions(signal_id)
);

CREATE INDEX IF NOT EXISTS idx_trades_executed_at
  ON trades (executed_at);

CREATE INDEX IF NOT EXISTS idx_trades_status_executed_at
  ON trades (status, executed_at);

CREATE INDEX IF NOT EXISTS idx_trades_created_at
  ON trades (created_at);

CREATE INDEX IF NOT EXISTS idx_trades_asset_created_at
  ON trades (asset, created_at);

CREATE INDEX IF NOT EXISTS idx_trades_asset
  ON trades (asset);

CREATE INDEX IF NOT EXISTS idx_trades_signal_id
  ON trades (signal_id);

CREATE INDEX IF NOT EXISTS idx_trades_primary_driver_executed_at
  ON trades (primary_driver, executed_at);

CREATE TABLE IF NOT EXISTS market_ticks (
  tick_id TEXT PRIMARY KEY,
  source_exchange TEXT NOT NULL,
  instrument_code TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  tick_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_market_ticks_received_at
  ON market_ticks (received_at);

CREATE INDEX IF NOT EXISTS idx_market_ticks_instrument_received_at
  ON market_ticks (instrument_code, received_at);

CREATE TABLE IF NOT EXISTS execution_quality (
  quality_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  instrument_code TEXT NOT NULL,
  expected_price REAL NOT NULL,
  achieved_price REAL NOT NULL,
  slippage_bps REAL NOT NULL,
  implementation_shortfall REAL NOT NULL,
  latency_ms REAL NOT NULL,
  fees REAL NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_execution_quality_observed_at
  ON execution_quality (observed_at);

CREATE INDEX IF NOT EXISTS idx_execution_quality_instrument_observed_at
  ON execution_quality (instrument_code, observed_at);
