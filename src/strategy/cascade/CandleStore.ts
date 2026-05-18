import type { Candle, Timeframe } from "./types";

const INSERT_CANDLE_SQL = `
INSERT OR REPLACE INTO candles (
  instrument_code,
  timeframe,
  opened_at,
  closed_at,
  open,
  high,
  low,
  close,
  volume,
  notional_volume,
  buy_volume,
  sell_volume,
  trades,
  is_closed
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SELECT_CANDLES_SQL = `
SELECT
  instrument_code,
  timeframe,
  opened_at,
  closed_at,
  open,
  high,
  low,
  close,
  volume,
  notional_volume,
  buy_volume,
  sell_volume,
  trades,
  is_closed
FROM candles
WHERE instrument_code = ? AND timeframe = ?
ORDER BY closed_at DESC
LIMIT ?
`;

interface CandleRow {
  instrument_code: string;
  timeframe: Timeframe;
  opened_at: string;
  closed_at: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  notional_volume: number;
  buy_volume: number;
  sell_volume: number;
  trades: number;
  is_closed: number;
}

export class D1CandleStore {
  constructor(private readonly db: D1Database) {}

  async persistClosed(candles: Candle[]): Promise<void> {
    const closed = candles.filter((candle) => candle.isClosed);
    if (closed.length === 0) {
      return;
    }

    const statements = closed.map((candle) =>
      this.db
        .prepare(INSERT_CANDLE_SQL)
        .bind(
          candle.instrumentCode,
          candle.timeframe,
          candle.openedAt,
          candle.closedAt,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
          candle.notionalVolume,
          candle.buyVolume,
          candle.sellVolume,
          candle.trades,
          candle.isClosed ? 1 : 0
        )
    );

    await this.db.batch(statements);
  }

  async fetchRecent(
    instrumentCode: string,
    timeframe: Timeframe,
    limit: number
  ): Promise<Candle[]> {
    const safeLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    const result = await this.db
      .prepare(SELECT_CANDLES_SQL)
      .bind(instrumentCode, timeframe, safeLimit)
      .all<CandleRow>();

    return (result.results ?? []).map(rowToCandle).reverse();
  }
}

function rowToCandle(row: CandleRow): Candle {
  return {
    instrumentCode: row.instrument_code,
    timeframe: row.timeframe,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    notionalVolume: row.notional_volume,
    buyVolume: row.buy_volume,
    sellVolume: row.sell_volume,
    trades: row.trades,
    isClosed: row.is_closed === 1
  };
}
