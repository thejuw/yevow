import { describe, expect, it } from "vitest";
import {
  applyCrossAssetHypeCancelSideEffects,
  applyCrossAssetHypeQuoteCancelFlow,
  buildCrossAssetHypeCancelArtifacts,
  crossAssetHypeCancelLogMetadata,
  crossAssetHypeCancelTelemetry,
  evaluateCrossAssetHypeQuoteCancel,
  resolveCrossAssetHypeQuoteCancelConfig,
  updateLeadLagMetrics,
  updateTradingLeadLagMetricsForTarget,
  type CrossAssetHypeCancelSideEffectHandlers,
  type LeadLagSample
} from "../../src/engine/trading/leadlag/LeadLagRuntime";
import type { MultiScaleVolatilitySnapshot } from "../../src/engine/MultiScaleVolatility";
import type { EngineState, InternalOrderBook, MarketTick } from "../../src/types";

const OBSERVED_AT = "2026-05-18T10:00:00.000Z";

describe("LeadLagRuntime", () => {
  it("returns current metrics without mutating samples when mid-price is unavailable", () => {
    const samples = new Map<string, LeadLagSample[]>();
    const current = leadLag({ sampleCount: 4 });

    expect(
      updateLeadLagMetrics({
        samples,
        currentLeadLag: current,
        instrumentCode: "btc-usd",
        midPrice: null,
        observedAt: OBSERVED_AT,
        averageLatencyMs: 5,
        microstructureSpread: 1,
        microstructureMidPrice: 100,
        executionCostBufferBps: 1,
        sampleLimit: 100
      })
    ).toBe(current);
    expect(samples.size).toBe(0);
  });

  it("tracks single-instrument samples and trims to the sample limit", () => {
    const samples = new Map<string, LeadLagSample[]>([
      [
        "btc-usd",
        [
          { price: 98, observedAt: "old-1" },
          { price: 99, observedAt: "old-2" }
        ]
      ]
    ]);

    const next = updateLeadLagMetrics({
      samples,
      currentLeadLag: leadLag(),
      instrumentCode: "btc-usd",
      midPrice: 100,
      observedAt: OBSERVED_AT,
      averageLatencyMs: 5,
      microstructureSpread: 1,
      microstructureMidPrice: 100,
      executionCostBufferBps: 1,
      sampleLimit: 2
    });

    expect(next).toMatchObject({ sampleCount: 3, updatedAt: OBSERVED_AT });
    expect(samples.get("btc-usd")).toEqual([
      { price: 99, observedAt: "old-2" },
      { price: 100, observedAt: OBSERVED_AT }
    ]);
  });

  it("finds the strongest cross-asset relationship and marks executable edge", () => {
    const samples = new Map<string, LeadLagSample[]>([
      ["btc-usd", samplesFrom([100, 101, 103, 106, 110, 115, 121, 128, 136, 145, 155, 170])],
      ["hype-usd", samplesFrom([50, 50.4, 51.2, 52.4, 54, 56, 58.4, 61.2, 64.4, 68, 72, 77])]
    ]);

    const next = updateLeadLagMetrics({
      samples,
      currentLeadLag: leadLag(),
      instrumentCode: "btc-usd",
      midPrice: 121,
      observedAt: OBSERVED_AT,
      averageLatencyMs: 4,
      microstructureSpread: 0,
      microstructureMidPrice: 100,
      executionCostBufferBps: 0,
      sampleLimit: 100
    });

    expect(next.schemaVersion).toBe("lead-lag.v1");
    expect(next.sampleCount).toBeGreaterThanOrEqual(10);
    expect(next.expectedValue).toBeGreaterThan(0);
    expect(next.executable).toBe(true);
    expect(next.lagMs).toBeGreaterThanOrEqual(4);
    expect([next.leadInstrument, next.lagInstrument].sort()).toEqual(["btc-usd", "hype-usd"]);
  });

  it("updates lead-lag metrics through the trading target adapter", () => {
    const leadLagSamples = new Map<string, LeadLagSample[]>();
    const target = {
      leadLagSamples,
      engineState: {
        leadLag: leadLag(),
        averageLatency: 5,
        microstructure: {
          spread: 0,
          midPrice: 100
        } as EngineState["microstructure"],
        slippage: {
          executionCostBufferBps: 0
        } as EngineState["slippage"]
      }
    };

    const next = updateTradingLeadLagMetricsForTarget(
      marketTick(),
      orderBook(),
      OBSERVED_AT,
      target
    );

    expect(next).toMatchObject({ sampleCount: 1, updatedAt: OBSERVED_AT });
    expect(leadLagSamples.get("btc-usd")).toEqual([{ price: 100, observedAt: OBSERVED_AT }]);
  });

  it("evaluates BTC lead-move quote cancellation for HYPE with threshold and cooldown guards", () => {
    const base = {
      shadowReplay: false,
      tradingEnabled: true,
      tickInstrumentCode: "btc-usd",
      volatility: volatility({ ret: 0.001 }),
      observedAt: OBSERVED_AT,
      leadThresholdBps: 5,
      cooldownMs: 1_000,
      lastCancelAtMs: 0,
      fallbackNowMs: 1
    };

    expect(evaluateCrossAssetHypeQuoteCancel(base)).toMatchObject({
      shouldCancel: true,
      moveBps: 10,
      reason: "BTC_LEAD_MOVE"
    });
    expect(
      evaluateCrossAssetHypeQuoteCancel({
        ...base,
        volatility: volatility({ ret: 0.0001, jumpDetected: false })
      })
    ).toMatchObject({ shouldCancel: false, reason: "BELOW_THRESHOLD" });
    expect(
      evaluateCrossAssetHypeQuoteCancel({
        ...base,
        volatility: volatility({ ret: 0.0001, jumpDetected: true })
      })
    ).toMatchObject({ shouldCancel: true, reason: "BTC_LEAD_MOVE" });
    expect(
      evaluateCrossAssetHypeQuoteCancel({
        ...base,
        lastCancelAtMs: Date.parse(OBSERVED_AT) - 250
      })
    ).toMatchObject({ shouldCancel: false, reason: "COOLDOWN" });
    expect(
      evaluateCrossAssetHypeQuoteCancel({
        ...base,
        tickInstrumentCode: "eth-usd"
      })
    ).toMatchObject({ shouldCancel: false, reason: "INELIGIBLE" });
  });

  it("builds cross-asset HYPE cancellation log and telemetry artifacts", () => {
    const decision = {
      shouldCancel: true,
      nowMs: Date.parse(OBSERVED_AT),
      moveBps: 12.34567,
      reason: "BTC_LEAD_MOVE"
    };
    const artifacts = {
      decision,
      volatility: volatility({ jumpDetected: true, jumpZScore: 6.78912 }),
      leadThresholdBps: 5,
      observedAt: OBSERVED_AT
    };

    expect(crossAssetHypeCancelLogMetadata(artifacts)).toEqual({
      leadInstrument: "btc-usd",
      lagInstrument: "hype-usd",
      moveBps: 12.3457,
      thresholdBps: 5,
      jumpDetected: true,
      jumpZScore: 6.7891
    });
    expect(crossAssetHypeCancelTelemetry(artifacts)).toEqual({
      instrumentCode: "hype-usd",
      reason: "BTC_LEAD_MOVE",
      moveBps: 12.34567,
      jumpDetected: true,
      observedAt: OBSERVED_AT
    });
    expect(buildCrossAssetHypeCancelArtifacts(artifacts)).toEqual({
      decision,
      logMetadata: crossAssetHypeCancelLogMetadata(artifacts),
      telemetry: crossAssetHypeCancelTelemetry(artifacts)
    });
  });

  it("applies cross-asset HYPE cancellation side effects only when eligible", async () => {
    const skipped = applyCrossAssetHypeCancelSideEffects(
      {
        decision: {
          shouldCancel: false,
          nowMs: Date.parse(OBSERVED_AT),
          moveBps: 2,
          reason: "BELOW_THRESHOLD"
        },
        volatility: volatility(),
        leadThresholdBps: 5,
        observedAt: OBSERVED_AT
      },
      crossAssetHypeCancelSideEffectSpy().handlers
    );
    const sideEffects = crossAssetHypeCancelSideEffectSpy();
    const applied = applyCrossAssetHypeCancelSideEffects(
      {
        decision: {
          shouldCancel: true,
          nowMs: Date.parse(OBSERVED_AT),
          moveBps: 12,
          reason: "BTC_LEAD_MOVE"
        },
        volatility: volatility({ jumpDetected: true }),
        leadThresholdBps: 5,
        observedAt: OBSERVED_AT
      },
      sideEffects.handlers
    );

    expect(skipped).toBe(false);
    expect(applied).toBe(true);
    expect(sideEffects.events).toEqual([
      `mark:hype-usd:${Date.parse(OBSERVED_AT)}`,
      "warn:CROSS_ASSET_HYPE_CANCEL:BTC lead move invalidated HYPE resting quotes",
      "publish:hype-usd:BTC_LEAD_MOVE",
      "cancel:hype-usd:BTC_LEAD_MOVE",
      "schedule"
    ]);

    await Promise.all(sideEffects.scheduled);
  });

  it("orchestrates cross-asset HYPE cancellation with env config and cooldown state", async () => {
    const sideEffects = crossAssetHypeCancelSideEffectSpy();

    const decision = applyCrossAssetHypeQuoteCancelFlow(
      {
        shadowReplay: false,
        tradingEnabled: true,
        tickInstrumentCode: "btc-usd",
        volatility: volatility({ ret: 0.001 }),
        observedAt: OBSERVED_AT,
        leadThresholdBpsValue: "5",
        cooldownMsValue: "1000",
        lastCancelAtMs: 0,
        fallbackNowMs: 1
      },
      sideEffects.handlers
    );

    expect(decision).toMatchObject({
      shouldCancel: true,
      reason: "BTC_LEAD_MOVE"
    });
    expect(sideEffects.events).toEqual([
      `mark:hype-usd:${Date.parse(OBSERVED_AT)}`,
      "warn:CROSS_ASSET_HYPE_CANCEL:BTC lead move invalidated HYPE resting quotes",
      "publish:hype-usd:BTC_LEAD_MOVE",
      "cancel:hype-usd:BTC_LEAD_MOVE",
      "schedule"
    ]);
    await Promise.all(sideEffects.scheduled);
  });

  it("resolves cross-asset quote cancellation config from bounded env values", () => {
    expect(
      resolveCrossAssetHypeQuoteCancelConfig({
        leadThresholdBps: "11.5",
        cooldownMs: "750"
      })
    ).toEqual({
      leadThresholdBps: 11.5,
      cooldownMs: 750
    });
    expect(
      resolveCrossAssetHypeQuoteCancelConfig({
        leadThresholdBps: "0",
        cooldownMs: "10"
      })
    ).toEqual({
      leadThresholdBps: 8,
      cooldownMs: 100
    });
  });
});

function crossAssetHypeCancelSideEffectSpy(): {
  events: string[];
  scheduled: Promise<unknown>[];
  handlers: CrossAssetHypeCancelSideEffectHandlers;
} {
  const events: string[] = [];
  const scheduled: Promise<unknown>[] = [];

  return {
    events,
    scheduled,
    handlers: {
      markCooldown(instrumentCode, nowMs) {
        events.push(`mark:${instrumentCode}:${nowMs}`);
      },
      warn(eventType, message) {
        events.push(`warn:${eventType}:${message}`);
      },
      publishSuspend(payload) {
        events.push(`publish:${payload.instrumentCode}:${payload.reason}`);
      },
      schedule(work) {
        events.push("schedule");
        scheduled.push(work);
      },
      cancelAllQuotes(instrumentCode, reason) {
        events.push(`cancel:${instrumentCode}:${reason}`);
        return Promise.resolve();
      }
    }
  };
}

function samplesFrom(prices: number[]): LeadLagSample[] {
  return prices.map((price, index) => ({
    price,
    observedAt: `2026-05-18T09:${String(index).padStart(2, "0")}:00.000Z`
  }));
}

function leadLag(overrides: Partial<EngineState["leadLag"]> = {}): EngineState["leadLag"] {
  return {
    schemaVersion: "lead-lag.v1",
    leadInstrument: null,
    lagInstrument: null,
    correlation: null,
    lagMs: null,
    leadLagDelta: 0,
    expectedValue: 0,
    executable: false,
    sampleCount: 0,
    updatedAt: null,
    ...overrides
  };
}

function volatility(
  overrides: Partial<MultiScaleVolatilitySnapshot> = {}
): MultiScaleVolatilitySnapshot {
  return {
    instrumentCode: "btc-usd",
    midPrice: 100_000,
    ret: 0,
    oneMinuteVol: 0,
    fiveMinuteVol: 0,
    thirtyMinuteVol: 0,
    maxVol: 0,
    jumpDetected: false,
    jumpZScore: 0,
    observedAt: OBSERVED_AT,
    ...overrides
  };
}

function marketTick(overrides: Partial<MarketTick> = {}): MarketTick {
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
    side: "buy",
    sequence: 1,
    exchangeTimestamp: OBSERVED_AT,
    synchronizedExchangeTimestamp: OBSERVED_AT,
    clockOffsetMs: 0,
    receivedAt: OBSERVED_AT,
    sourceWeight: 1,
    raw: {},
    ...overrides
  };
}

function orderBook(overrides: Partial<InternalOrderBook> = {}): InternalOrderBook {
  return {
    marketKey: "hyperliquid:btc-usd",
    instrumentCode: "btc-usd",
    source_exchange: "hyperliquid",
    exchangeCode: "hyperliquid",
    bestBid: 99,
    bestAsk: 101,
    midPrice: 100,
    spread: 2,
    weightedImbalance: 0,
    bids: [],
    asks: [],
    updatedAt: OBSERVED_AT,
    ...overrides
  } as unknown as InternalOrderBook;
}
