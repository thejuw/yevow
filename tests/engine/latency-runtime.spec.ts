import { describe, expect, it } from "vitest";
import {
  buildExecutionPerformanceTransition,
  buildPerformanceMetricsText,
  buildPerformanceSnapshot,
  calculateTickLatency,
  hardStalePullTelemetryPayload,
  hardStaleTickDropLogMetadata,
  latencySnapshotStorageWrites,
  nativeHyperliquidLatencyPullStorageWrites,
  nextExecutionProfile,
  nextLatencyAverage,
  recordProcessingLatencySample,
  resolveNativeHyperliquidMaxLatencyMs,
  shouldLogHardStaleTickDrop,
  shouldLogPerformanceSpikeEvent,
  stateAfterLatencyBaselineReset,
  stateAfterNativeHyperliquidLatencyPull,
  stateAfterStaleDataKillSwitch,
  stateAfterHardStaleTickDrop
} from "../../src/engine/trading/performance/LatencyRuntime";
import { defaultEngineState } from "../../src/TradingEngineRuntimeHelpers";
import type { EngineState, ExecutionProfile, LatencyMetrics, MarketTick } from "../../src/types";

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

  it("resolves native Hyperliquid stale thresholds by transport and stream", () => {
    expect(
      resolveNativeHyperliquidMaxLatencyMs({
        transport: "grpc",
        streamId: "stream-1",
        dwellirMaxLatencyMs: "75",
        hlStaleAfterMs: "150",
        currentMaxLatencyMs: 250
      })
    ).toBe(75);
    expect(
      resolveNativeHyperliquidMaxLatencyMs({
        transport: "websocket",
        streamId: "dwellir-public-fallback",
        hlStaleAfterMs: "125",
        currentMaxLatencyMs: 250
      })
    ).toBe(125);
    expect(
      resolveNativeHyperliquidMaxLatencyMs({
        transport: "websocket",
        streamId: "public-hl",
        currentMaxLatencyMs: 500
      })
    ).toBe(150);
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

  it("resets stale latency baselines without mutating unrelated state", () => {
    const currentState = defaultEngineState("latency-reset");
    currentState.averageLatency = 180;
    currentState.latencySampleCount = 99;
    currentState.processedTicks = 41;
    currentState.executionProfile = profile({
      status: "UNSTABLE",
      jitterMs: 22,
      sampleCount: 100,
      averageProcessingLatencyMs: 18,
      maxProcessingLatencyMs: 45,
      lastProcessingLatencyMs: 28
    });

    const nextState = stateAfterLatencyBaselineReset(currentState, "2026-05-18T15:00:01.000Z");

    expect(nextState).toMatchObject({
      averageLatency: 0,
      latencySampleCount: 0,
      processedTicks: 41,
      executionProfile: {
        status: "STABLE",
        jitterMs: 0,
        sampleCount: 0,
        averageProcessingLatencyMs: 0,
        maxProcessingLatencyMs: 0,
        lastProcessingLatencyMs: 0,
        updatedAt: "2026-05-18T15:00:01.000Z"
      },
      updatedAt: "2026-05-18T15:00:01.000Z"
    });
  });

  it("throttles performance spike logs by instrument and status", () => {
    const logAt = new Map<string, number>();
    const metrics = latencyMetrics({ status: "STALE" });

    expect(
      shouldLogPerformanceSpikeEvent({
        logAt,
        latencyMetrics: metrics,
        throttleMs: 1_000,
        nowMs: 0
      })
    ).toBe(true);
    expect(
      shouldLogPerformanceSpikeEvent({
        logAt,
        latencyMetrics: metrics,
        throttleMs: 1_000,
        nowMs: 10_000
      })
    ).toBe(true);
    expect(
      shouldLogPerformanceSpikeEvent({
        logAt,
        latencyMetrics: metrics,
        throttleMs: 1_000,
        nowMs: 10_500
      })
    ).toBe(false);
    expect(
      shouldLogPerformanceSpikeEvent({
        logAt,
        latencyMetrics: metrics,
        throttleMs: 1_000,
        nowMs: 11_001
      })
    ).toBe(true);
    expect(logAt.get("btc-usd:STALE")).toBe(11_001);
  });

  it("marks hard-stale drops and suspends quote state", () => {
    const currentState = defaultEngineState("latency-test");
    currentState.averageLatency = 180;
    currentState.latencySampleCount = 7;
    currentState.processedTicks = 3;
    currentState.staleTickCount = 4;

    const result = stateAfterHardStaleTickDrop({
      currentState,
      metrics: latencyMetrics(),
      hardStaleDropMs: 150
    });

    expect(result.metrics).toMatchObject({
      status: "STALE",
      maxLatencyMs: 150,
      averageLatencyMs: 180,
      sampleCount: 7
    });
    expect(result.nextStaleTickCount).toBe(5);
    expect(result.shouldResetLatencyBaseline).toBe(true);
    expect(result.state).toMatchObject({
      processedTicks: 4,
      staleTickCount: 5,
      quoteState: { status: "SUSPENDED", reason: "HARD_STALE_DROP" },
      heartbeatAt: "2026-05-18T15:00:00.250Z",
      updatedAt: "2026-05-18T15:00:00.250Z"
    });
  });

  it("builds hard-stale log and quote-pull telemetry", () => {
    const staleTick = tick({ transport: "grpc", sequence: 777 });
    const metrics = latencyMetrics({ totalLatencyMs: 275, networkLatencyMs: 125 });
    const input = {
      tick: staleTick,
      metrics,
      streamId: "dwellir-main",
      hardStaleDropMs: 150
    };

    expect(shouldLogHardStaleTickDrop(1)).toBe(true);
    expect(shouldLogHardStaleTickDrop(499)).toBe(false);
    expect(shouldLogHardStaleTickDrop(500)).toBe(true);
    expect(hardStaleTickDropLogMetadata(input)).toMatchObject({
      instrumentCode: "btc-usd",
      exchangeCode: "HL",
      source_exchange: "hyperliquid",
      transport: "grpc",
      streamId: "dwellir-main",
      sequence: 777,
      totalLatencyMs: 275,
      networkLatencyMs: 125,
      processingLatencyMs: 150,
      hardStaleDropMs: 150
    });
    expect(hardStalePullTelemetryPayload(input)).toMatchObject({
      instrumentCode: "btc-usd",
      action: "PULL_ALL_QUOTES",
      source: "NATIVE_HYPERLIQUID",
      maxLatencyMs: 150,
      totalLatencyMs: 275
    });
  });

  it("marks soft stale kill-switch state with a quote hibernation window", () => {
    const currentState = defaultEngineState("latency-test");
    currentState.processedTicks = 10;
    currentState.staleTickCount = 2;
    currentState.quoteState = {
      status: "ACTIVE",
      reason: null,
      suspendedUntil: null,
      lastQuote: null,
      updatedAt: "2026-05-18T15:00:00.000Z"
    };
    currentState.assetQuoteStates = Object.fromEntries(
      Object.keys(currentState.assetQuoteStates).map((instrumentCode) => [
        instrumentCode,
        {
          status: "ACTIVE" as const,
          reason: null,
          suspendedUntil: null,
          lastQuote: null,
          updatedAt: "2026-05-18T15:00:00.000Z"
        }
      ])
    );

    const result = stateAfterStaleDataKillSwitch({
      currentState,
      metrics: latencyMetrics(),
      instrumentCode: "btc-usd",
      maxLatencyMs: 150,
      quoteHibernateMs: 60_000
    });

    expect(result.suspendedUntil).toBe("2026-05-18T15:01:00.250Z");
    expect(result.state).toMatchObject({
      processedTicks: 11,
      staleTickCount: 3,
      maxLatencyMs: 150,
      quoteState: {
        status: "ACTIVE",
        reason: "PARTIAL_ASSET_SUSPENSION",
        suspendedUntil: null
      },
      heartbeatAt: "2026-05-18T15:00:00.250Z",
      updatedAt: "2026-05-18T15:00:00.250Z"
    });
    expect(result.state.assetQuoteStates["btc-usd"]).toMatchObject({
      status: "SUSPENDED",
      reason: "STALE_DATA_KILL_SWITCH",
      suspendedUntil: "2026-05-18T15:01:00.250Z"
    });
  });

  it("pulls native Hyperliquid quotes when latency exceeds the hot-path threshold", () => {
    const currentState = defaultEngineState("native-latency-test");
    currentState.averageLatency = 151;
    currentState.latencySampleCount = 22;
    currentState.processedTicks = 40;
    currentState.staleTickCount = 5;
    currentState.location = {
      ...currentState.location,
      latencyRiskMultiplier: 1.4,
      positionSizeMultiplier: 0.6
    };
    currentState.quoteState = {
      status: "ACTIVE",
      reason: null,
      suspendedUntil: null,
      lastQuote: null,
      updatedAt: "2026-05-18T15:00:00.000Z"
    };
    currentState.assetQuoteStates = Object.fromEntries(
      Object.keys(currentState.assetQuoteStates).map((instrumentCode) => [
        instrumentCode,
        {
          status: "ACTIVE" as const,
          reason: null,
          suspendedUntil: null,
          lastQuote: null,
          updatedAt: "2026-05-18T15:00:00.000Z"
        }
      ])
    );

    const result = stateAfterNativeHyperliquidLatencyPull({
      currentState,
      metrics: latencyMetrics({ totalLatencyMs: 180, maxLatencyMs: 150 }),
      instrumentCode: "btc-usd",
      sequence: 123,
      observedAt: "2026-05-18T15:00:01.000Z"
    });

    expect(result.metrics).toMatchObject({
      averageLatencyMs: 151,
      sampleCount: 22,
      latencyRiskMultiplier: 1.4,
      positionSizeMultiplier: 0.6
    });
    expect(result.state).toMatchObject({
      processedTicks: 41,
      staleTickCount: 6,
      quoteState: {
        status: "ACTIVE",
        reason: "PARTIAL_ASSET_SUSPENSION"
      },
      heartbeatAt: "2026-05-18T15:00:01.000Z",
      updatedAt: "2026-05-18T15:00:01.000Z"
    });
    expect(result.state.assetQuoteStates["btc-usd"]).toMatchObject({
      status: "SUSPENDED",
      reason: "NATIVE_HL_LATENCY"
    });
    expect(result).toMatchObject({
      telemetryType: "STALE_DATA_KILL_SWITCH",
      telemetryPayload: {
        instrumentCode: "btc-usd",
        exchangeCode: "hyperliquid",
        source_exchange: "hyperliquid",
        sequence: 123,
        totalLatencyMs: 180,
        maxLatencyMs: 150,
        action: "PULL_CURRENT_QUOTES",
        source: "NATIVE_HYPERLIQUID"
      }
    });
  });

  it("builds native Hyperliquid latency-pull storage writes", () => {
    const state = defaultEngineState("native-latency-storage");
    const latencyHistory = [latencyMetrics({ totalLatencyMs: 180 })];
    const processingLatencySamples = [2, 3, 5];

    expect(
      nativeHyperliquidLatencyPullStorageWrites({
        engineStateKey: "engine:state",
        state,
        performanceHistoryKey: "latency:history",
        latencyHistory,
        processingLatencySamplesKey: "latency:samples",
        processingLatencySamples
      })
    ).toEqual({
      "engine:state": state,
      "latency:history": latencyHistory,
      "latency:samples": processingLatencySamples
    });
  });

  it("builds generic latency snapshot storage writes with optional extra entries", () => {
    const state = defaultEngineState("latency-storage");
    const latencyHistory = [latencyMetrics({ totalLatencyMs: 90 })];
    const processingLatencySamples = [1, 2];

    expect(
      latencySnapshotStorageWrites({
        engineStateKey: "engine:state",
        state,
        performanceHistoryKey: "latency:history",
        latencyHistory,
        processingLatencySamplesKey: "latency:samples",
        processingLatencySamples,
        extra: {
          "staleTick:hyperliquid:btc-usd:1": { reason: "STALE" }
        }
      })
    ).toEqual({
      "engine:state": state,
      "latency:history": latencyHistory,
      "latency:samples": processingLatencySamples,
      "staleTick:hyperliquid:btc-usd:1": { reason: "STALE" }
    });
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

  it("builds performance transition telemetry and notification envelopes", () => {
    const unstableTransition = buildExecutionPerformanceTransition(
      buildPerformanceSnapshot(
        "engine-1",
        profile({ status: "UNSTABLE", jitterMs: 12, jitterThresholdMs: 10 }),
        42,
        "2026-05-18T15:00:00.000Z"
      )
    );

    expect(unstableTransition).toMatchObject({
      telemetryType: "ENGINE_PERFORMANCE_UNSTABLE",
      correlationId: "engine-1:42",
      telemetryPayload: {
        status: "UNSTABLE",
        jitterMs: 12,
        jitterThresholdMs: 10
      },
      notification: {
        priority: "HIGH",
        title: "Sovereign-Sigma execution jitter unstable",
        dedupeKey: "performance:UNSTABLE",
        metadata: {
          engineId: "engine-1",
          status: "UNSTABLE",
          processedTicks: 42
        }
      }
    });

    const stableTransition = buildExecutionPerformanceTransition(
      buildPerformanceSnapshot(
        "engine-1",
        profile({ status: "STABLE", jitterMs: 2, jitterThresholdMs: 10 }),
        43,
        "2026-05-18T15:01:00.000Z"
      )
    );

    expect(stableTransition).toMatchObject({
      telemetryType: "ENGINE_PERFORMANCE_STABLE",
      correlationId: "engine-1:43",
      notification: {
        priority: "LOW",
        title: "Sovereign-Sigma execution jitter recovered",
        dedupeKey: "performance:STABLE"
      }
    });
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

function latencyMetrics(overrides: Partial<LatencyMetrics> = {}): LatencyMetrics {
  return {
    instrumentCode: "btc-usd",
    exchangeCode: "HL",
    source: "HYPERLIQUID",
    sourceExchange: "hyperliquid",
    sourceWeight: 1,
    sequence: 10,
    providerTimestamp: "2026-05-18T15:00:00.000Z",
    sourceTimestamp: "2026-05-18T15:00:00.000Z",
    ingestTimestamp: "2026-05-18T15:00:00.100Z",
    brainTimestamp: "2026-05-18T15:00:00.250Z",
    clockOffsetMs: 0,
    networkLatencyMs: 100,
    processingLatencyMs: 150,
    totalLatencyMs: 250,
    maxLatencyMs: 500,
    averageLatencyMs: 0,
    sampleCount: 0,
    status: "FRESH",
    colo: "NRT",
    placement: "tokyo",
    latencyRiskMultiplier: 1,
    positionSizeMultiplier: 1,
    ...overrides
  };
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
