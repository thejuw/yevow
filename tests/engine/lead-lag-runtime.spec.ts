import { describe, expect, it } from "vitest";
import {
  crossAssetHypeCancelLogMetadata,
  crossAssetHypeCancelTelemetry,
  evaluateCrossAssetHypeQuoteCancel,
  updateLeadLagMetrics,
  type LeadLagSample
} from "../../src/engine/trading/leadlag/LeadLagRuntime";
import type { MultiScaleVolatilitySnapshot } from "../../src/engine/MultiScaleVolatility";
import type { EngineState } from "../../src/types";

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
  });
});

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
