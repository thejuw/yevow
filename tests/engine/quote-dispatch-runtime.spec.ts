import { describe, expect, it } from "vitest";
import {
  buildQuoteDispatchIntents,
  dispatchedQuoteSnapshot,
  evaluateQuoteRefreshThrottle
} from "../../src/engine/trading/quotes/QuoteDispatchRuntime";
import type { QuoteSignal } from "../../src/types";

describe("QuoteDispatchRuntime", () => {
  it("builds risk-capped post-only trade intents from quote orders", () => {
    const result = buildQuoteDispatchIntents({
      quote: quoteSignal(),
      engineId: "engine-1",
      bankrollEquity: 1_000,
      bankrollCash: 500,
      maxPositionPct: 0.1,
      maxPositionSize: 75,
      assetAllocationPct: 0.5,
      positionSizeMultiplier: 0.8,
      fallbackSourceExchange: "hyperliquid",
      spreadBps: 2.5,
      toxicityScore: 0.2
    });

    expect(result.maxOrderNotional).toBe(40);
    expect(result.skippedOrders).toEqual([]);
    expect(result.intents).toHaveLength(2);
    expect(result.intents[0]).toMatchObject({
      intentId: "bid-1",
      traceId: "engine-1:quote:quote-1:bid-1",
      instrumentCode: "btc-usd",
      source_exchange: "hyperliquid",
      direction: "LONG",
      action: "BUY",
      orderType: "LIMIT",
      postOnly: true,
      timeInForce: "ALO",
      intendedPrice: 100,
      requestedSize: 2,
      approvedSize: 0.4,
      maxSlippageBps: 2.5,
      confidence: 0.8
    });
    expect(result.intents[1]).toMatchObject({
      action: "SELL",
      direction: "SHORT",
      approvedSize: 0.3960396
    });
    expect(result.intents[0].rationale).toContain("risk-capped notional=40");
  });

  it("reports skipped orders when risk budget is zero", () => {
    const result = buildQuoteDispatchIntents({
      quote: quoteSignal(),
      engineId: "engine-1",
      bankrollEquity: 0,
      bankrollCash: 0,
      maxPositionPct: 0.1,
      maxPositionSize: 0,
      assetAllocationPct: 1,
      positionSizeMultiplier: 1,
      fallbackSourceExchange: null,
      spreadBps: null,
      toxicityScore: 2
    });

    expect(result.intents).toEqual([]);
    expect(result.skippedOrders).toEqual([
      {
        quoteSignalId: "quote-1",
        instrumentCode: "btc-usd",
        side: "BUY",
        requestedSize: 2,
        price: 100,
        maxOrderNotional: 0
      },
      {
        quoteSignalId: "quote-1",
        instrumentCode: "btc-usd",
        side: "SELL",
        requestedSize: 2,
        price: 101,
        maxOrderNotional: 0
      }
    ]);
  });

  it("preserves liquidation absorption rationale and fallback source exchange", () => {
    const quote = quoteSignal({
      marketKey: null,
      orders: [
        {
          clientOrderId: "liq-1",
          side: "BID",
          price: 98,
          size: 0.5,
          postOnly: true,
          strategy: "LIQUIDATION_ABSORPTION",
          clusterId: "cluster-7"
        }
      ]
    });

    const result = buildQuoteDispatchIntents({
      quote,
      engineId: "engine-1",
      bankrollEquity: 10_000,
      bankrollCash: 10_000,
      maxPositionPct: 0.1,
      maxPositionSize: 0,
      assetAllocationPct: 1,
      positionSizeMultiplier: 1,
      fallbackSourceExchange: "hyperliquid",
      spreadBps: null,
      toxicityScore: -1
    });

    expect(result.intents[0]).toMatchObject({
      source_exchange: "hyperliquid",
      maxSlippageBps: 1,
      confidence: 2
    });
    expect(result.intents[0].rationale).toContain("cluster cluster-7");
  });

  it("evaluates quote refresh throttles from queue advice and log cadence", () => {
    const previousQuote = { bid: 100, ask: 101, updatedAtMs: Date.parse(quoteSignal().createdAt) };
    const quote = quoteSignal({ createdAt: "2026-05-18T17:00:00.750Z" });

    expect(
      evaluateQuoteRefreshThrottle({
        previousQuote,
        quote,
        advice: { shouldRefresh: true, reason: "MID_MOVED", queuePressure: 2 },
        minIntervalMs: 750,
        minPriceTicks: 1,
        nowMs: Date.parse(quote.createdAt),
        lastLogAtMs: 0,
        logThrottleMs: 10_000
      })
    ).toMatchObject({ shouldThrottle: false, shouldLog: false });

    expect(
      evaluateQuoteRefreshThrottle({
        previousQuote,
        quote,
        advice: { shouldRefresh: false, reason: "HOLD_FRONT_OF_QUEUE", queuePressure: 0.2 },
        minIntervalMs: 750,
        minPriceTicks: 1,
        nowMs: Date.parse(quote.createdAt),
        lastLogAtMs: 0,
        logThrottleMs: 10_000
      })
    ).toEqual({
      shouldThrottle: true,
      shouldLog: true,
      nextLogAtMs: Date.parse(quote.createdAt),
      elapsedMs: 750,
      queuePressure: 0.2,
      queueReason: "HOLD_FRONT_OF_QUEUE"
    });

    expect(
      evaluateQuoteRefreshThrottle({
        previousQuote,
        quote,
        advice: { shouldRefresh: false, reason: "UNCHANGED", queuePressure: 0.5 },
        minIntervalMs: 750,
        minPriceTicks: 1,
        nowMs: Date.parse(quote.createdAt),
        lastLogAtMs: Date.parse(quote.createdAt) - 1_000,
        logThrottleMs: 10_000
      })
    ).toMatchObject({ shouldThrottle: true, shouldLog: false });
  });

  it("captures dispatched quote snapshots with parsed and fallback timestamps", () => {
    expect(dispatchedQuoteSnapshot(quoteSignal(), 1)).toEqual({
      bid: 100,
      ask: 101,
      updatedAtMs: Date.parse("2026-05-18T17:00:00.000Z")
    });
    expect(dispatchedQuoteSnapshot(quoteSignal({ createdAt: "not-a-date" }), 42)).toEqual({
      bid: 100,
      ask: 101,
      updatedAtMs: 42
    });
  });
});

function quoteSignal(overrides: Partial<QuoteSignal> = {}): QuoteSignal {
  return {
    schemaVersion: "quote-signal.v1",
    signalId: "quote-1",
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    reservationPrice: 100.5,
    optimalSpread: 1,
    orders: [
      {
        clientOrderId: "bid-1",
        side: "BID",
        price: 100,
        size: 2,
        postOnly: true,
        strategy: "AMM"
      },
      {
        clientOrderId: "ask-1",
        side: "ASK",
        price: 101,
        size: 2,
        postOnly: true,
        strategy: "AMM"
      }
    ],
    createdAt: "2026-05-18T17:00:00.000Z",
    ...overrides
  };
}
