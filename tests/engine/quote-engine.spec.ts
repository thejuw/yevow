import { describe, expect, it } from "vitest";
import { CroupierAgent } from "../../src/agents/CroupierAgent";
import { ProfilerAgent } from "../../src/agents/ProfilerAgent";
import type { CroupierInput } from "../../src/agents/CroupierAgent";
import type { MarketTick, PriceLevel } from "../../src/types";

const observedAt = "2026-05-17T00:00:00.000Z";

describe("quote engine toxicity gating", () => {
  it("requires fresh structural consensus before AM-VPIN evacuates quotes", () => {
    const profiler = new ProfilerAgent({
      bucketSize: 1,
      rollingWindow: 5,
      normalThreshold: 0.65,
      toxicThreshold: 0.75,
      criticalThreshold: 0.85,
      criticalObi: 0.8,
      criticalHaltMs: 60_000
    });

    const contested = profiler.processTick(tradeTick(1, "buy"), profilerContext(-0.9));
    expect(contested.state.toxicityState).toBe("CONTESTED");
    expect(contested.state.quoteHaltUntil).toBeNull();
    expect(contested.signal?.featureVector.signalType).toBe("AM_VPIN_CONTESTED");

    const toxic = profiler.processTick(tradeTick(2, "buy"), profilerContext(0.7));
    expect(toxic.state.toxicityState).toBe("CRITICAL");
    expect(toxic.state.quoteHaltUntil).not.toBeNull();
    expect(toxic.signal?.featureVector.signalType).toBe("AM_VPIN_CRITICAL");

    const critical = profiler.processTick(tradeTick(3, "buy"), profilerContext(0.9));
    expect(critical.state.toxicityState).toBe("CRITICAL");
    expect(critical.state.quoteHaltUntil).not.toBeNull();
    expect(critical.signal?.featureVector.signalType).toBe("AM_VPIN_CRITICAL");

    const expired = profiler.processTick(
      orderBookTick(4, "2026-05-17T00:02:01.000Z"),
      profilerContext(0.9, "2026-05-17T00:02:01.000Z")
    );
    expect(expired.state.toxicityState).toBe("TOXIC");
    expect(expired.state.quoteHaltUntil).toBeNull();
  });

  it("treats AM-VPIN toxicity as a binary quote kill-switch", () => {
    const critical = new CroupierAgent().evaluate({
      ...croupierInput(),
      minEvThreshold: -1_000_000_000,
      profilerToxicityState: "CRITICAL",
      profilerPressureSide: "BUY"
    });
    expect(critical.pullAllQuotes).toBe(true);
    expect(critical.quote).toBeNull();
    expect(critical.intent).toBeNull();

    const contested = new CroupierAgent().evaluate({
      ...croupierInput(),
      minEvThreshold: -1_000_000_000,
      profilerToxicityState: "CONTESTED",
      profilerPressureSide: "BUY"
    });
    expect(contested.pullAllQuotes).toBe(false);
    expect(contested.quote?.orders.length).toBeGreaterThan(0);
    expect(contested.intent?.timeInForce).toBe("ALO");
  });

  it("builds layered post-only quotes around Guéant-discretized prices", () => {
    const decision = new CroupierAgent().evaluate({
      ...croupierInput(),
      minEvThreshold: -1_000_000_000,
      layeredQuoteLevels: 3,
      layeredQuoteSizeDecay: 0.5,
      layeredQuoteSpreadStepBps: 100
    });
    const bidOrders = decision.quote?.orders.filter((order) => order.side === "BID") ?? [];
    const askOrders = decision.quote?.orders.filter((order) => order.side === "ASK") ?? [];

    expect(bidOrders).toHaveLength(3);
    expect(askOrders).toHaveLength(3);
    expect(bidOrders.every((order) => order.postOnly)).toBe(true);
    expect(askOrders.every((order) => order.postOnly)).toBe(true);
    expect(bidOrders[1].price).toBeLessThan(bidOrders[0].price);
    expect(askOrders[1].price).toBeGreaterThan(askOrders[0].price);
  });
});

function tradeTick(sequence: number, side: "buy" | "sell"): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    baseAsset: "BTC",
    quoteAsset: "USD",
    price: 100,
    size: 1,
    side,
    sequence,
    exchangeTimestamp: observedAt,
    synchronizedExchangeTimestamp: observedAt,
    clockOffsetMs: 0,
    receivedAt: observedAt,
    sourceWeight: 1,
    raw: {
      commodity: "TRADE",
      isBuy: side === "buy"
    }
  };
}

function orderBookTick(sequence: number, timestamp: string): MarketTick {
  return {
    ...tradeTick(sequence, "buy"),
    size: 0,
    exchangeTimestamp: timestamp,
    synchronizedExchangeTimestamp: timestamp,
    receivedAt: timestamp,
    raw: {
      commodity: "ORDER_BOOK"
    }
  };
}

function profilerContext(obi: number, timestamp = observedAt) {
  const bidSize = obi >= 0 ? 1 + obi : 1 + obi;
  const askSize = obi >= 0 ? 1 - obi : 1 - obi;

  return {
    engineId: "engine-test",
    observedAt: timestamp,
    midPrice: 100,
    spreadBps: 1,
    weightedImbalance: obi,
    orderBookBids: priceLevels(99.5, bidSize),
    orderBookAsks: priceLevels(100.5, askSize)
  };
}

function priceLevels(price: number, size: number): PriceLevel[] {
  return [{ price, size, updatedAt: observedAt }];
}

function croupierInput(): CroupierInput {
  return {
    engineId: "engine-test",
    book: {
      marketKey: "hyperliquid:btc-usd",
      source: "HYPERLIQUID",
      source_exchange: "hyperliquid",
      sourceWeight: 1,
      instrumentCode: "btc-usd",
      exchangeCode: "hyperliquid",
      bids: priceLevels(99.5, 10),
      asks: priceLevels(100.5, 10),
      bestBid: 99.5,
      bestAsk: 100.5,
      midPrice: 100,
      spread: 1,
      spreadBps: 100,
      weightedImbalance: 0,
      lastSequence: 1,
      tickSize: 0.5,
      ttbLatencyMs: 1,
      isSynced: true,
      sequence: 1,
      updatedAt: observedAt
    },
    oracle: {
      schemaVersion: "oracle.v1",
      instrumentCode: "btc-usd",
      regime: "REGIME_RANGE",
      volatility: 0.01,
      atr: 1,
      adx: 10,
      atrToVolumeEfficiency: 1,
      skepticismMultiplier: 1,
      governanceMode: "AUTONOMOUS",
      manualSkepticism: 1,
      maxSkepticism: 4,
      profitTargetBps: 5,
      pdf: null,
      posteriorPdf: {
        schemaVersion: "oracle.pdf.v1",
        instrumentCode: "btc-usd",
        horizonSeconds: 60,
        currentPrice: 100,
        volatility: 0.01,
        degreesOfFreedom: 5,
        points: [
          { price: 99, probability: 0.4 },
          { price: 101, probability: 0.6 }
        ],
        generatedAt: observedAt
      },
      lastBayesianUpdate: null,
      updatedAt: observedAt
    },
    sentiment: {
      schemaVersion: "sentiment.v1",
      score: 0,
      bias: "NEUTRAL",
      confidence: 0,
      headline: null,
      model: "test",
      updatedAt: observedAt
    },
    toxicityScore: 0.8,
    inventory: {
      netDelta: 0,
      current_inventory_delta: 0,
      baseAsset: "BTC",
      normalization: {},
      maxInventoryUnits: 1,
      maxInventoryDelta: 1,
      inventoryPenalty: 0,
      stopBid: false,
      stopAsk: false,
      updatedAt: observedAt
    },
    leadLag: {
      schemaVersion: "lead-lag.v1",
      leadInstrument: null,
      lagInstrument: null,
      correlation: null,
      lagMs: null,
      leadLagDelta: null,
      expectedValue: null,
      executable: false,
      sampleCount: 0,
      updatedAt: observedAt
    },
    observedAt
  };
}
