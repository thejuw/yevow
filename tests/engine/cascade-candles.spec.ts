import { describe, expect, it } from "vitest";
import { CascadeCandleAggregator } from "../../src/strategy/cascade/CandleAggregator";
import { D1CandleStore } from "../../src/strategy/cascade/CandleStore";
import { calculateAtr } from "../../src/strategy/cascade/indicators/ATR";
import { cumulativeVolumeDelta } from "../../src/strategy/cascade/indicators/CumulativeVolumeDelta";
import { calculateEma } from "../../src/strategy/cascade/indicators/EMA";
import { calculateVwap } from "../../src/strategy/cascade/indicators/VWAP";
import type { Candle, Timeframe } from "../../src/strategy/cascade/types";
import type { MarketTick } from "../../src/types";

describe("cascade candle aggregation", () => {
  it("aggregates OHLCV and volume splits from trade ticks", () => {
    const aggregator = new CascadeCandleAggregator(["1m"]);

    aggregator.ingestTick(tick("2026-05-18T12:00:01.000Z", 100, 2, "buy"));
    aggregator.ingestTick(tick("2026-05-18T12:00:30.000Z", 105, 1, "sell"));
    aggregator.ingestTick(tick("2026-05-18T12:00:45.000Z", 99, 0.5, "buy"));
    const closed = aggregator.ingestTick(tick("2026-05-18T12:01:00.000Z", 101, 0.25, "sell"));

    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      openedAt: "2026-05-18T12:00:00.000Z",
      closedAt: "2026-05-18T12:01:00.000Z",
      open: 100,
      high: 105,
      low: 99,
      close: 99,
      volume: 3.5,
      buyVolume: 2.5,
      sellVolume: 1,
      trades: 3,
      isClosed: true
    });
    expect(closed[0].notionalVolume).toBe(100 * 2 + 105 * 1 + 99 * 0.5);
  });

  it("aligns candle close timing to wall-clock timeframe boundaries", () => {
    const aggregator = new CascadeCandleAggregator(["1h"]);

    aggregator.ingestTick(tick("2026-05-18T12:59:59.999Z", 100, 1, "buy"));
    const closed = aggregator.ingestTick(tick("2026-05-18T13:00:00.000Z", 101, 1, "buy"));

    expect(closed).toHaveLength(1);
    expect(closed[0].openedAt).toBe("2026-05-18T12:00:00.000Z");
    expect(closed[0].closedAt).toBe("2026-05-18T13:00:00.000Z");
  });

  it("merges in-progress candles with newly arrived ticks", () => {
    const aggregator = new CascadeCandleAggregator(["5m"]);

    aggregator.ingestTick(tick("2026-05-18T12:01:00.000Z", 100, 1, "buy"));
    aggregator.ingestTick(tick("2026-05-18T12:04:59.999Z", 110, 3, "sell"));
    const snapshot = aggregator.snapshot("btc-usd", "5m", 1);

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      openedAt: "2026-05-18T12:00:00.000Z",
      closedAt: "2026-05-18T12:05:00.000Z",
      open: 100,
      high: 110,
      low: 100,
      close: 110,
      volume: 4,
      isClosed: false
    });
  });

  it("hydrates and serializes active and closed candle state", () => {
    const first = new CascadeCandleAggregator(["1m"]);
    first.ingestTick(tick("2026-05-18T12:00:01.000Z", 100, 1, "buy"));
    first.ingestTick(tick("2026-05-18T12:01:01.000Z", 102, 2, "sell"));

    const state = first.serialize();
    const second = new CascadeCandleAggregator(["1m"]);
    second.hydrate(state);

    expect(second.serialize()).toEqual(state);
    expect(second.snapshot("btc-usd", "1m", 2).map((candle) => candle.close)).toEqual([100, 102]);
  });
});

describe("cascade indicators", () => {
  it("calculates EMA, ATR, CVD, and VWAP without mutating candles", () => {
    const candles = [
      candle("1m", "2026-05-18T12:00:00.000Z", 100, 105, 99, 104, 2, 1.5, 0.5),
      candle("1m", "2026-05-18T12:01:00.000Z", 104, 108, 103, 107, 3, 2, 1),
      candle("1m", "2026-05-18T12:02:00.000Z", 107, 109, 101, 102, 4, 1, 3)
    ];

    expect(
      calculateEma(
        candles.map((item) => item.close),
        2
      )
    ).toBeGreaterThan(0);
    expect(calculateAtr(candles, 2)).toBeGreaterThan(0);
    expect(cumulativeVolumeDelta(candles)).toBe(0);
    expect(calculateVwap(candles)).toBeCloseTo(
      candles.reduce((sum, item) => sum + item.notionalVolume, 0) /
        candles.reduce((sum, item) => sum + item.volume, 0)
    );
  });
});

describe("D1 candle store", () => {
  it("uses bound statements for candle persistence", async () => {
    const statements: unknown[] = [];
    const store = new D1CandleStore({
      prepare: () =>
        ({
          bind: (...values: unknown[]) => {
            statements.push(values);
            return {} as D1PreparedStatement;
          }
        }) as D1PreparedStatement,
      batch: async (batch: D1PreparedStatement[]) => batch.map(() => ({ success: true }))
    } as D1Database);

    await store.persistClosed([
      {
        ...candle("1m", "2026-05-18T12:00:00.000Z", 100, 101, 99, 100, 1, 1, 0),
        isClosed: true
      }
    ]);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("btc-usd");
    expect(statements[0]).toContain("1m");
  });
});

function tick(
  timestamp: string,
  price: number,
  size: number,
  side: MarketTick["side"]
): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    baseAsset: "BTC",
    quoteAsset: "USD",
    price,
    size,
    side,
    sequence: Date.parse(timestamp),
    exchangeTimestamp: timestamp,
    synchronizedExchangeTimestamp: timestamp,
    clockOffsetMs: 0,
    receivedAt: timestamp,
    sourceWeight: 1,
    raw: {}
  };
}

function candle(
  timeframe: Timeframe,
  openedAt: string,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  buyVolume: number,
  sellVolume: number
): Candle {
  return {
    instrumentCode: "btc-usd",
    timeframe,
    openedAt,
    closedAt: new Date(Date.parse(openedAt) + 60_000).toISOString(),
    open,
    high,
    low,
    close,
    volume,
    notionalVolume: close * volume,
    buyVolume,
    sellVolume,
    trades: 1,
    isClosed: true
  };
}
