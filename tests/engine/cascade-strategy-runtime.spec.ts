import { describe, expect, it } from "vitest";
import {
  closedOneMinuteCandlesForTick,
  shouldEvaluateCascadeStrategy
} from "../../src/engine/trading/cascade/CascadeStrategyRuntime";
import type { Candle } from "../../src/strategy/cascade/types";

describe("CascadeStrategyRuntime", () => {
  it("gates cascade evaluation by strategy mode", () => {
    expect(shouldEvaluateCascadeStrategy("OFF")).toBe(false);
    expect(shouldEvaluateCascadeStrategy("MARKET_MAKING")).toBe(false);
    expect(shouldEvaluateCascadeStrategy("CASCADE_RECOVERY")).toBe(true);
  });

  it("selects only closed one-minute candles for the active tick instrument", () => {
    const btc = candle({ instrumentCode: "BTC-USD", timeframe: "1m" });
    const btcFiveMinute = candle({ instrumentCode: "btc-usd", timeframe: "5m" });
    const hype = candle({ instrumentCode: "hype-usd", timeframe: "1m" });

    expect(
      closedOneMinuteCandlesForTick([btcFiveMinute, hype, btc], { instrumentCode: "btc-usd" })
    ).toEqual([btc]);
  });
});

function candle(overrides: Partial<Candle> = {}): Candle {
  return {
    instrumentCode: "btc-usd",
    timeframe: "1m",
    openedAt: "2026-05-18T20:00:00.000Z",
    closedAt: "2026-05-18T20:01:00.000Z",
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
    notionalVolume: 1_000,
    buyVolume: 6,
    sellVolume: 4,
    trades: 12,
    isClosed: true,
    ...overrides
  };
}
