ALTER TABLE congress_transactions ADD COLUMN instrument_type TEXT NOT NULL DEFAULT 'EQUITY';
ALTER TABLE congress_transactions ADD COLUMN option_underlying TEXT;
ALTER TABLE congress_transactions ADD COLUMN option_type TEXT;
ALTER TABLE congress_transactions ADD COLUMN option_strike REAL;
ALTER TABLE congress_transactions ADD COLUMN option_expiration_date TEXT;
ALTER TABLE congress_transactions ADD COLUMN option_exposure TEXT;
ALTER TABLE congress_transactions ADD COLUMN option_intensity TEXT;
ALTER TABLE congress_transactions ADD COLUMN option_is_leap INTEGER NOT NULL DEFAULT 0;
ALTER TABLE congress_transactions ADD COLUMN option_decoder_json TEXT;

CREATE INDEX IF NOT EXISTS idx_congress_transactions_instrument_date
  ON congress_transactions (instrument_type, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_congress_transactions_option_underlying_date
  ON congress_transactions (option_underlying, transaction_date DESC);
