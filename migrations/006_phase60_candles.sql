CREATE TABLE IF NOT EXISTS candles (
  instrument_code TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  notional_volume REAL NOT NULL,
  buy_volume REAL NOT NULL,
  sell_volume REAL NOT NULL,
  trades INTEGER NOT NULL,
  is_closed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (instrument_code, timeframe, opened_at)
);

CREATE INDEX IF NOT EXISTS idx_candles_instrument_timeframe_closed_at
  ON candles (instrument_code, timeframe, closed_at DESC);
