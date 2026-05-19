import { describe, expect, it } from "vitest";
import {
  updateLeadLagMetrics,
  type LeadLagSample
} from "../../src/engine/trading/leadlag/LeadLagRuntime";
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
