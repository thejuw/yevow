import { describe, expect, it } from "vitest";
import { applyCvarSizing } from "../../src/engine/CvarSizer";
import { MultiScaleVolatilityModel } from "../../src/engine/MultiScaleVolatility";
import { bootstrapPaperAdverseSelection } from "../../src/engine/PaperReplayModel";
import { classifyLearnedToxicity } from "../../src/engine/ToxicityClassifier";
import type { ProfilerState, SlippageAnalytics } from "../../src/types";

describe("strategy risk models", () => {
  it("caps Kelly fraction when empirical CVaR breaches the tail-loss budget", () => {
    const decision = applyCvarSizing({
      baseFraction: 0.05,
      slippage: slippageAnalytics([2, 3, 4, 50, 60]),
      confidence: 0.9,
      maxTailLossBps: 20,
      lookbackTrades: 100
    });

    expect(decision.reason).toBe("CVAR_TAIL_CAP_APPLIED");
    expect(decision.cappedFraction).toBeLessThan(0.05);
    expect(decision.cvarBps).toBeGreaterThan(20);
  });

  it("tracks multi-timescale volatility and flags jump risk online", () => {
    const model = new MultiScaleVolatilityModel();
    const baseTime = Date.parse("2026-05-17T00:00:00.000Z");

    for (let index = 0; index < 30; index += 1) {
      model.update("btc-usd", 100 + index * 0.01, new Date(baseTime + index * 1000).toISOString());
    }

    const jump = model.update("btc-usd", 110, "2026-05-17T00:00:31.000Z");
    expect(jump?.jumpDetected).toBe(true);
    expect(jump?.maxVol).toBeGreaterThan(0);
  });

  it("uses learned toxicity overlay features without dynamic dependencies", () => {
    const result = classifyLearnedToxicity(
      {
        profiler: profilerState({
          amVpinScore: 0.9,
          toxicityScore: 0.9,
          obi: 0.9,
          latestDirectionalImbalance: 10,
          amVpinBucketCompletions: 50
        }),
        spreadBps: 20,
        jumpDetected: true
      },
      0.7
    );

    expect(result.triggered).toBe(true);
    expect(result.probability).toBeGreaterThan(0.7);
  });

  it("bootstraps paper adverse selection from execution history when enough samples exist", () => {
    const values = Array.from({ length: 25 }, (_, index) => index + 1);
    const result = bootstrapPaperAdverseSelection({
      slippage: slippageAnalytics(values),
      fallbackAdverseBps: 1.5,
      side: "BUY",
      random: 0.5
    });

    expect(result.source).toBe("EMPIRICAL_BOOTSTRAP");
    expect(result.adverseBps).toBeGreaterThan(1.5);
  });
});

function slippageAnalytics(values: number[]): SlippageAnalytics {
  return {
    schemaVersion: "slippage.v1",
    points: values.map((slippageBps, index) => ({
      expectedPrice: 100,
      achievedPrice: 100 * (1 + slippageBps / 10_000),
      slippageBps,
      implementationShortfall: slippageBps,
      latencyMs: index,
      observedAt: "2026-05-17T00:00:00.000Z"
    })),
    averageSlippageBps: values.reduce((sum, value) => sum + value, 0) / values.length,
    latencyCorrelation: null,
    executionCostBufferBps: 0,
    updatedAt: "2026-05-17T00:00:00.000Z"
  };
}

function profilerState(overrides: Partial<ProfilerState>): ProfilerState {
  return {
    schemaVersion: "profiler.v1",
    bucketSize: 10,
    rollingWindow: 50,
    alertThreshold: 0.7,
    toxicityScore: 0,
    amVpinScore: 0,
    obi: null,
    obiDepth: 5,
    directionalDecay: 0.3,
    latestSignedImbalance: 0,
    latestDirectionalImbalance: 0,
    toxicityState: "NORMAL",
    pressureSide: "NEUTRAL",
    spreadMultiplier: 1,
    reservationShiftBps: 0,
    quoteHaltUntil: null,
    amVpinBucketCompletions: 0,
    amVpinMean: 0,
    amVpinM2: 0,
    amVpinVariance: 0,
    amVpinRing: {
      buyVolumes: [],
      sellVolumes: [],
      signedImbalances: [],
      directionalImbalances: [],
      obiValues: []
    },
    distanceToCascadePct: null,
    cascadeShieldUntil: null,
    cascadeClusterId: null,
    cascadeSide: null,
    activeBucket: null,
    buckets: [],
    totalBucketsClosed: 0,
    lastProcessedSequence: null,
    lastSignalId: null,
    lastAlertBucketCount: 0,
    lastSpoofingWallId: null,
    tradeSizeCount: 0,
    tradeSizeMean: 0,
    tradeSizeM2: 0,
    tradeSizeWindow: [],
    quoteSuspendedUntil: null,
    updatedAt: "2026-05-17T00:00:00.000Z",
    ...overrides
  };
}
