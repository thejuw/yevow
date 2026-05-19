import { describe, expect, it } from "vitest";
import {
  buildPerformanceMetricsText,
  buildPerformanceSnapshot,
  calculateTickLatency,
  nextExecutionProfile,
  nextLatencyAverage,
  recordProcessingLatencySample
} from "../../src/engine/trading/performance/LatencyRuntime";
import type { EngineState, ExecutionProfile, MarketTick } from "../../src/types";

describe("LatencyRuntime", () => {
  it("calculates tick-to-brain latency while clamping future ingest skew", () => {
    const metrics = calculateTickLatency({
      tick: tick({
        exchangeTimestamp: "2026-05-18T15:00:00.000Z",
        synchronizedExchangeTimestamp: "2026-05-18T15:00:00.010Z",
        providerTimestamp: "2026-05-18T15:00:00.020Z",
        receivedAt: "2026-05-18T15:00:00.140Z",
        clockOffsetMs: 2
      }),
      brainTimestamp: "2026-05-18T15:00:00.100Z",
      maxLatencyMs: 150,
      averageLatencyMs: 40,
      sampleCount: 12,
      location: location()
    });

    expect(metrics).toMatchObject({
      providerTimestamp: "2026-05-18T15:00:00.020Z",
      sourceTimestamp: "2026-05-18T15:00:00.010Z",
      ingestTimestamp: "2026-05-18T15:00:00.100Z",
      clockOffsetMs: 42,
      networkLatencyMs: 90,
      processingLatencyMs: 0,
      totalLatencyMs: 90,
      maxLatencyMs: 150,
      averageLatencyMs: 40,
      sampleCount: 12,
      colo: "NRT"
    });
  });

  it("updates rolling latency averages and trims jitter samples in place", () => {
    expect(nextLatencyAverage({ averageLatency: 10, latencySampleCount: 1 }, 30)).toEqual({
      averageLatency: 20,
      latencySampleCount: 2
    });

    const samples = [1, 2];
    expect(recordProcessingLatencySample(samples, 3.1234, 2)).toBe(3.123);
    expect(samples).toEqual([2, 3.123]);
  });

  it("computes execution profile jitter at the configured interval", () => {
    const result = nextExecutionProfile({
      previousProfile: profile({ lastComputedAt: "2026-05-18T14:59:00.000Z" }),
      processingLatencySamples: [1, 5, 9],
      processingLatencyMs: 9,
      nextProcessedTicks: 10,
      jitterThresholdMs: 2,
      jitterSampleWindow: 3,
      jitterComputeIntervalTicks: 5,
      coldStartWakeupThresholdMs: 25,
      totalHotPathMs: 12,
      trace: {
        wakeUpTimeMs: 30,
        orderBookUpdateMs: 2,
        agentLogicMs: 4,
        hotPathStartedAt: 0,
        observedAt: "2026-05-18T15:00:00.000Z"
      }
    });

    expect(result.shouldCompute).toBe(true);
    expect(result.profile).toMatchObject({
      status: "UNSTABLE",
      jitterMs: 3.266,
      averageProcessingLatencyMs: 5,
      maxProcessingLatencyMs: 9,
      lastProcessingLatencyMs: 9,
      coldStartSuspected: true,
      totalHotPathMs: 12,
      lastComputedAt: "2026-05-18T15:00:00.000Z"
    });
  });

  it("builds performance snapshots and Prometheus metrics text", () => {
    const snapshot = buildPerformanceSnapshot(
      "engine-1",
      profile({ status: "UNSTABLE", jitterMs: 12 }),
      42,
      "2026-05-18T15:00:00.000Z"
    );
    const metrics = buildPerformanceMetricsText({
      engineId: "engine-1",
      profile: profile({ status: "UNSTABLE", jitterMs: 12, coldStartSuspected: true }),
      processedTicks: 42,
      toxicityScore: 0.7
    });

    expect(snapshot).toMatchObject({
      engineId: "engine-1",
      status: "UNSTABLE",
      jitterMs: 12,
      processedTicks: 42
    });
    expect(metrics).toContain("sovereign_sigma_processing_latency_jitter_ms");
    expect(metrics).toContain('engine_id="engine-1"');
    expect(metrics).toContain("sovereign_sigma_execution_unstable");
    expect(metrics).toContain("sovereign_sigma_toxicity_score");
  });
});

function tick(overrides: Partial<MarketTick> = {}): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    exchangeCode: "HL",
    instrumentCode: "btc-usd",
    baseAsset: "BTC",
    quoteAsset: "USD",
    price: 100,
    size: 1,
    side: "buy",
    sequence: 10,
    exchangeTimestamp: "2026-05-18T15:00:00.000Z",
    synchronizedExchangeTimestamp: "2026-05-18T15:00:00.000Z",
    clockOffsetMs: 0,
    receivedAt: "2026-05-18T15:00:00.050Z",
    sourceWeight: 1,
    ...overrides
  };
}

function location(): EngineState["location"] {
  return {
    colo: "NRT",
    placement: "tokyo",
    isGoldenRegion: true,
    latencyRiskMultiplier: 1,
    positionSizeMultiplier: 1,
    updatedAt: "2026-05-18T15:00:00.000Z"
  } as EngineState["location"];
}

function profile(overrides: Partial<ExecutionProfile> = {}): ExecutionProfile {
  return {
    status: "STABLE",
    jitterMs: 0,
    jitterThresholdMs: 10,
    sampleCount: 3,
    sampleWindow: 1000,
    computeIntervalTicks: 5,
    averageProcessingLatencyMs: 1,
    maxProcessingLatencyMs: 2,
    lastProcessingLatencyMs: 1,
    wakeUpTimeMs: null,
    coldStartSuspected: false,
    orderBookUpdateMs: null,
    agentLogicMs: null,
    totalHotPathMs: null,
    lastComputedAt: null,
    updatedAt: "2026-05-18T15:00:00.000Z",
    ...overrides
  };
}
