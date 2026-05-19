import { describe, expect, it } from "vitest";
import {
  currentFundingRate,
  nextFundingRatesAfterTick
} from "../../src/engine/trading/funding/FundingRuntime";
import type { EngineState, InternalOrderBook, MarketTick } from "../../src/types";

describe("FundingRuntime", () => {
  it("updates funding snapshots from native funding ticks", () => {
    const current: EngineState["fundingRates"] = {};
    const observedAt = "2026-05-18T16:00:00.000Z";
    const tick = marketTick({
      fundingRateHourly: 0.0001,
      markPrice: 100_000,
      oraclePrice: 100_010,
      openInterest: 50_000_000
    });

    const next = nextFundingRatesAfterTick(current, tick, observedAt);

    expect(next).not.toBe(current);
    expect(next["hyperliquid:btc-usd"]).toEqual({
      instrumentCode: "btc-usd",
      source_exchange: "hyperliquid",
      marketKey: "hyperliquid:btc-usd",
      hourlyRate: 0.0001,
      markPrice: 100_000,
      oraclePrice: 100_010,
      openInterest: 50_000_000,
      receivedAt: tick.receivedAt,
      updatedAt: observedAt
    });
  });

  it("keeps existing funding rates when tick has no funding data", () => {
    const current: EngineState["fundingRates"] = {};
    expect(nextFundingRatesAfterTick(current, marketTick({}), "now")).toBe(current);
  });

  it("resolves direct, instrument fallback, and absent funding rates", () => {
    const fundingRates: EngineState["fundingRates"] = {
      "hyperliquid:btc-usd": {
        instrumentCode: "btc-usd",
        source_exchange: "hyperliquid",
        marketKey: "hyperliquid:btc-usd",
        hourlyRate: 0.0001,
        markPrice: null,
        oraclePrice: null,
        openInterest: null,
        receivedAt: "2026-05-18T16:00:00.000Z",
        updatedAt: "2026-05-18T16:00:00.000Z"
      },
      "binance:eth-usd": {
        instrumentCode: "eth-usd",
        source_exchange: "binance",
        marketKey: "binance:eth-usd",
        hourlyRate: -0.0002,
        markPrice: null,
        oraclePrice: null,
        openInterest: null,
        receivedAt: "2026-05-18T16:00:00.000Z",
        updatedAt: "2026-05-18T16:00:00.000Z"
      }
    };

    expect(currentFundingRate(fundingRates, book("hyperliquid:btc-usd", "btc-usd"))).toBe(0.0001);
    expect(currentFundingRate(fundingRates, book("hyperliquid:eth-usd", "eth-usd"))).toBe(-0.0002);
    expect(currentFundingRate(fundingRates, book("hyperliquid:hype-usd", "hype-usd"))).toBe(0);
  });
});

function marketTick(overrides: Partial<MarketTick>): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    baseAsset: "BTC",
    quoteAsset: "USD",
    price: 100_000,
    size: 0,
    side: "unknown",
    sequence: 1,
    exchangeTimestamp: "2026-05-18T16:00:00.000Z",
    synchronizedExchangeTimestamp: "2026-05-18T16:00:00.000Z",
    clockOffsetMs: 0,
    receivedAt: "2026-05-18T16:00:00.001Z",
    sourceWeight: 1,
    ...overrides
  };
}

function book(marketKey: string, instrumentCode: string): InternalOrderBook {
  return {
    marketKey,
    source: "HYPERLIQUID",
    source_exchange: marketKey.split(":")[0] ?? "hyperliquid",
    sourceWeight: 1,
    instrumentCode,
    exchangeCode: "hyperliquid",
    bids: [],
    asks: [],
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    spread: null,
    spreadBps: null,
    weightedImbalance: null,
    lastSequence: null,
    tickSize: 0.01,
    ttbLatencyMs: null,
    isSynced: true,
    desyncReason: null,
    sequence: 0,
    updatedAt: "2026-05-18T16:00:00.000Z"
  };
}
