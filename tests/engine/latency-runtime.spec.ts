import { describe, expect, it, vi } from "vitest";
import {
  applyExecutionProfileFlow,
  applyExecutionProfileSideEffects,
  buildExecutionPerformanceTransition,
  buildPerformanceMetricsText,
  buildPerformanceSnapshot,
  nextExecutionProfile,
  recordProcessingLatencySample,
  type ExecutionProfileSideEffectHandlers
} from "../../src/engine/trading/performance/LatencyRuntime";
import {
  applyHardStaleTickDropFlow,
  applyHardStaleTickDropSideEffects,
  applyNativeHyperliquidLatencyPullSideEffects,
  applySoftStaleTickFlow,
  applyStaleDataKillSwitchSideEffects,
  applyTradingNativeHyperliquidLatencyPull,
  buildHardStaleTickDropArtifacts,
  buildStaleDataKillSwitchArtifacts,
  hardStalePullTelemetryPayload,
  hardStaleTickDropLogMetadata,
  latencySnapshotStorageWrites,
  nativeHyperliquidLatencyPullArtifacts,
  nativeHyperliquidLatencyPullStorageWrites,
  shouldLogHardStaleTickDrop,
  staleDataKillSwitchNotification,
  staleDataKillSwitchStorageExtra,
  staleDataKillSwitchTelemetryPayload,
  stateAfterHardStaleTickDrop,
  stateAfterNativeHyperliquidLatencyPull,
  stateAfterStaleDataKillSwitch,
  type HardStaleTickDropFlowHandlers,
  type HardStaleTickDropSideEffectHandlers,
  type NativeHyperliquidLatencyPullSideEffectHandlers,
  type SoftStaleTickFlowHandlers,
  type StaleDataKillSwitchSideEffectHandlers
} from "../../src/engine/trading/performance/StaleLatencyGuardRuntime";
import {
  handleTradingHardStaleTickDrop,
  handleTradingSoftStaleTick,
  type TradingStaleLatencyTarget
} from "../../src/engine/trading/performance/TradingStaleLatencyRuntime";
import {
  applyLatencyBaselineResetSideEffects,
  latencyBaselineResetArtifacts,
  stateAfterLatencyBaselineReset,
  type LatencyBaselineResetSideEffectHandlers
} from "../../src/engine/trading/performance/LatencyBaselineRuntime";
import {
  applyPerformanceSpikeLogSideEffect,
  shouldLogPerformanceSpikeEvent,
  type PerformanceSpikeLogSideEffectHandlers
} from "../../src/engine/trading/performance/PerformanceSpikeRuntime";
import {
  applyPreparedTickLatencySideEffects,
  appendLatencyHistory,
  calculateTickLatency,
  hydrateLatencyMetricsFromState,
  nextLatencyAverage,
  prepareTickLatencyFlow,
  prepareTickLatencyRuntime,
  resolveNativeHyperliquidMaxLatencyMs
} from "../../src/engine/trading/performance/LatencyTickRuntime";
import {
  resetTradingLatencyBaselineForTarget,
  tradingLatencyStorageWritesForState,
  tradingLatencyStorageWritesForTarget,
  updateTradingLatencyAverageForTarget,
  type TradingLatencyStateTarget
} from "../../src/engine/trading/performance/TradingLatencyStateRuntime";
import {
  prepareTradingTickLatencyForTarget,
  type TradingTickLatencyTarget
} from "../../src/engine/trading/performance/TradingTickLatencyRuntime";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
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

  it("prepares tick latency status and hard-stale decisions for the DO hot path", () => {
    const fresh = prepareTickLatencyRuntime({
      tick: tick({
        receivedAt: "2026-05-18T15:00:00.050Z"
      }),
      brainTimestamp: "2026-05-18T15:00:00.100Z",
      maxLatencyMs: 150,
      averageLatencyMs: 180,
      sampleCount: 9,
      location: location(),
      shadowReplay: false,
      dwellirMaxLatencyMs: "150",
      currentMaxLatencyMs: 250
    });

    expect(fresh).toMatchObject({
      streamId: null,
      hardStaleDropMs: 150,
      isHardStale: false,
      shouldResetLatencyBaseline: true,
      shouldUpdateLatencyAverage: true,
      metrics: {
        totalLatencyMs: 100,
        maxLatencyMs: 250,
        status: "FRESH"
      }
    });

    const softStale = prepareTickLatencyRuntime({
      tick: tick({
        receivedAt: "2026-05-18T15:00:00.200Z"
      }),
      brainTimestamp: "2026-05-18T15:00:00.260Z",
      maxLatencyMs: 150,
      averageLatencyMs: 20,
      sampleCount: 3,
      location: location(),
      shadowReplay: false,
      dwellirMaxLatencyMs: "500",
      currentMaxLatencyMs: 150
    });

    expect(softStale).toMatchObject({
      hardStaleDropMs: 500,
      isHardStale: false,
      shouldUpdateLatencyAverage: false,
      metrics: {
        totalLatencyMs: 260,
        maxLatencyMs: 150,
        status: "STALE"
      }
    });

    const hardStale = prepareTickLatencyRuntime({
      tick: tick({
        receivedAt: "2026-05-18T15:00:00.200Z"
      }),
      brainTimestamp: "2026-05-18T15:00:00.260Z",
      maxLatencyMs: 150,
      averageLatencyMs: 20,
      sampleCount: 3,
      location: location(),
      shadowReplay: false,
      dwellirMaxLatencyMs: "100",
      currentMaxLatencyMs: 150
    });

    expect(hardStale).toMatchObject({
      hardStaleDropMs: 100,
      isHardStale: true,
      shouldResetLatencyBaseline: false,
      shouldUpdateLatencyAverage: false,
      metrics: {
        totalLatencyMs: 260,
        status: "FRESH"
      }
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

  it("updates latency state and storage writes through the trading target adapter", () => {
    const events: string[] = [];
    const target: TradingLatencyStateTarget = {
      engineState: defaultEngineState("latency-target"),
      latencyHistory: [latencyMetrics({ totalLatencyMs: 20 })],
      processingLatencySamples: [1, 2],
      logger: {
        info(eventType, _message, telemetry) {
          events.push(`info:${eventType}:${String(telemetry?.reason ?? "none")}`);
        }
      }
    };

    updateTradingLatencyAverageForTarget(40, target);

    expect(target.engineState.averageLatency).toBe(40);
    expect(target.engineState.latencySampleCount).toBe(1);

    const beforeResetWrites = tradingLatencyStorageWritesForTarget(target, { extra: true });
    expect(beforeResetWrites["engine:state"]).toBe(target.engineState);
    expect(beforeResetWrites["performance:latency-history"]).toHaveLength(1);
    expect(beforeResetWrites["performance:processing-latency-samples"]).toEqual([1, 2]);
    expect(beforeResetWrites.extra).toBe(true);

    resetTradingLatencyBaselineForTarget("2026-05-18T15:01:00.000Z", "TEST_RESET", target);

    expect(target.engineState.averageLatency).toBe(0);
    expect(target.engineState.latencySampleCount).toBe(0);
    expect(target.latencyHistory).toEqual([]);
    expect(target.processingLatencySamples).toEqual([]);
    expect(events).toEqual(["info:LATENCY_BASELINE_RESET:TEST_RESET"]);

    const explicitState = {
      ...target.engineState,
      engineId: "latency-explicit"
    };
    const explicitWrites = tradingLatencyStorageWritesForState({
      state: explicitState,
      latencyHistory: target.latencyHistory,
      processingLatencySamples: target.processingLatencySamples
    });

    expect(explicitWrites["engine:state"]).toBe(explicitState);
  });

  it("prepares tick latency through the trading target adapter", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T15:00:00.100Z"));

    try {
      const events: string[] = [];
      const engineState = defaultEngineState("latency-prep-target");
      engineState.averageLatency = 20;
      engineState.latencySampleCount = 2;
      engineState.location = location();
      const target: TradingTickLatencyTarget = {
        engineState,
        latencyHistory: [],
        processingLatencySamples: [],
        maxLatencyMs: 150,
        env: {
          DWELLIR_MAX_LATENCY_MS: "150",
          HL_STALE_AFTER_MS: "300"
        },
        logger: {
          info(eventType, _message, telemetry) {
            events.push(`info:${eventType}:${String(telemetry?.reason ?? "none")}`);
          }
        },
        applyLocationLatency(totalLatencyMs, observedAt) {
          events.push(`location:${totalLatencyMs}:${observedAt}`);
        }
      };

      const result = prepareTradingTickLatencyForTarget(
        {
          tick: tick(),
          shadowReplay: false
        },
        target
      );

      expect(result).toMatchObject({
        streamId: null,
        hardStaleDropMs: 150,
        isHardStale: false,
        metrics: {
          brainTimestamp: "2026-05-18T15:00:00.100Z",
          totalLatencyMs: 100,
          status: "FRESH"
        }
      });
      expect(target.engineState.averageLatency).toBeCloseTo(46.667, 3);
      expect(target.engineState.latencySampleCount).toBe(3);
      expect(target.latencyHistory).toHaveLength(1);
      expect(events).toEqual(["location:100:2026-05-18T15:00:00.100Z"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hydrates latency metrics from engine state and appends bounded history", () => {
    const state = defaultEngineState("latency-hydration");
    state.averageLatency = 12;
    state.latencySampleCount = 4;
    state.location = {
      ...state.location,
      latencyRiskMultiplier: 1.25,
      positionSizeMultiplier: 0.75
    };
    const metrics = hydrateLatencyMetricsFromState(latencyMetrics(), state);

    expect(metrics).toMatchObject({
      averageLatencyMs: 12,
      sampleCount: 4,
      latencyRiskMultiplier: 1.25,
      positionSizeMultiplier: 0.75
    });
    expect(appendLatencyHistory([latencyMetrics({ sequence: 1 })], metrics, 1)).toEqual([metrics]);
  });

  it("applies prepared tick latency side effects in order for fresh samples", () => {
    const events: string[] = [];
    const latency = prepareTickLatencyRuntime({
      tick: tick({
        exchangeTimestamp: "2026-05-18T12:00:00.000Z",
        synchronizedExchangeTimestamp: "2026-05-18T12:00:00.000Z",
        receivedAt: "2026-05-18T12:00:00.000Z"
      }),
      brainTimestamp: "2026-05-18T12:00:00.020Z",
      maxLatencyMs: 50,
      averageLatencyMs: 500,
      sampleCount: 10,
      location: defaultEngineState("latency-side-effects").location,
      shadowReplay: false,
      currentMaxLatencyMs: 50,
      dwellirMaxLatencyMs: "250"
    });

    const result = applyPreparedTickLatencySideEffects(
      {
        latency,
        history: [latencyMetrics({ sequence: 1 })],
        historyLimit: 2
      },
      {
        resetLatencyBaseline(observedAt, reason) {
          events.push(`reset:${observedAt}:${reason}`);
        },
        updateLatencyAverage(totalLatencyMs) {
          events.push(`average:${totalLatencyMs}`);
        },
        hydrateMetrics(metrics) {
          events.push(`hydrate:${metrics.totalLatencyMs}`);
          return { ...metrics, averageLatencyMs: 20, sampleCount: 11 };
        },
        applyLocationLatency(totalLatencyMs, observedAt) {
          events.push(`location:${totalLatencyMs}:${observedAt}`);
        },
        setLatencyHistory(history) {
          events.push(`history:${history.length}:${history.at(-1)?.sampleCount}`);
        }
      }
    );

    expect(result.metrics.sampleCount).toBe(11);
    expect(events).toEqual([
      "reset:2026-05-18T12:00:00.020Z:FRESH_SAMPLE_AFTER_BACKLOG",
      "average:20",
      "hydrate:20",
      "location:20:2026-05-18T12:00:00.020Z",
      "hydrate:20",
      "history:2:11"
    ]);
  });

  it("orchestrates tick latency preparation through runtime and side effects", () => {
    const events: string[] = [];

    const result = prepareTickLatencyFlow(
      {
        tick: tick({
          exchangeTimestamp: "2026-05-18T12:00:00.000Z",
          synchronizedExchangeTimestamp: "2026-05-18T12:00:00.000Z",
          receivedAt: "2026-05-18T12:00:00.000Z"
        }),
        brainTimestamp: "2026-05-18T12:00:00.020Z",
        maxLatencyMs: 50,
        averageLatencyMs: 500,
        sampleCount: 10,
        location: defaultEngineState("latency-flow").location,
        shadowReplay: false,
        currentMaxLatencyMs: 50,
        dwellirMaxLatencyMs: "250",
        history: [latencyMetrics({ sequence: 1 })],
        historyLimit: 2
      },
      {
        resetLatencyBaseline(observedAt, reason) {
          events.push(`reset:${observedAt}:${reason}`);
        },
        updateLatencyAverage(totalLatencyMs) {
          events.push(`average:${totalLatencyMs}`);
        },
        hydrateMetrics(metrics) {
          events.push(`hydrate:${metrics.totalLatencyMs}`);
          return { ...metrics, averageLatencyMs: 20, sampleCount: 11 };
        },
        applyLocationLatency(totalLatencyMs, observedAt) {
          events.push(`location:${totalLatencyMs}:${observedAt}`);
        },
        setLatencyHistory(history) {
          events.push(`history:${history.length}:${history.at(-1)?.sampleCount}`);
        }
      }
    );

    expect(result.isHardStale).toBe(false);
    expect(result.metrics.sampleCount).toBe(11);
    expect(events).toEqual([
      "reset:2026-05-18T12:00:00.020Z:FRESH_SAMPLE_AFTER_BACKLOG",
      "average:20",
      "hydrate:20",
      "location:20:2026-05-18T12:00:00.020Z",
      "hydrate:20",
      "history:2:11"
    ]);
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

  it("assembles and applies latency baseline reset side effects", () => {
    const currentState = defaultEngineState("latency-reset-effects");
    currentState.averageLatency = 180;
    currentState.latencySampleCount = 99;
    const artifacts = latencyBaselineResetArtifacts({
      currentState,
      observedAt: "2026-05-18T15:00:01.000Z",
      reason: "FRESH_SAMPLE_AFTER_BACKLOG"
    });
    const sideEffects = latencyBaselineResetSideEffectSpy();

    applyLatencyBaselineResetSideEffects(artifacts, sideEffects.handlers);

    expect(artifacts.state).toMatchObject({
      averageLatency: 0,
      latencySampleCount: 0
    });
    expect(artifacts.latencyHistory).toEqual([]);
    expect(artifacts.processingLatencySamples).toEqual([]);
    expect(sideEffects.events).toEqual([
      "history:0",
      "samples:0",
      "state:0",
      "log:FRESH_SAMPLE_AFTER_BACKLOG"
    ]);
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

  it("logs performance spikes through the throttle gate", () => {
    const logAt = new Map<string, number>();
    const metrics = latencyMetrics({ status: "STALE", sequence: 99 });
    const sideEffects = performanceSpikeLogSideEffectSpy();

    expect(
      applyPerformanceSpikeLogSideEffect(
        { logAt, latencyMetrics: metrics, throttleMs: 1_000, nowMs: 1_000 },
        sideEffects.handlers
      )
    ).toBe(true);
    expect(
      applyPerformanceSpikeLogSideEffect(
        { logAt, latencyMetrics: metrics, throttleMs: 1_000, nowMs: 1_500 },
        sideEffects.handlers
      )
    ).toBe(false);

    expect(sideEffects.events).toEqual(["log:btc-usd:STALE:99"]);
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
    expect(buildHardStaleTickDropArtifacts({ ...input, nextStaleTickCount: 500 })).toMatchObject({
      shouldLog: true,
      logMetadata: hardStaleTickDropLogMetadata(input),
      telemetryPayload: hardStalePullTelemetryPayload(input),
      ingestResult: {
        accepted: false,
        status: "STALE_DROPPED",
        reason: "TICK_EXCEEDED_HARD_STALE_THRESHOLD",
        metrics
      }
    });
  });

  it("applies hard-stale side effects in warn, telemetry, and cancel order", async () => {
    const metrics = latencyMetrics({ status: "STALE", totalLatencyMs: 275 });
    const artifacts = buildHardStaleTickDropArtifacts({
      tick: tick({ sequence: 777 }),
      metrics,
      streamId: "dwellir-main",
      hardStaleDropMs: 150,
      nextStaleTickCount: 1
    });
    const sideEffects = hardStaleTickDropSideEffectSpy();

    applyHardStaleTickDropSideEffects(
      {
        tick: tick({ sequence: 777 }),
        metrics,
        artifacts,
        tradingEnabled: true
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual([
      "warn:btc-usd:777",
      "performance:btc-usd:STALE",
      "publish:PULL_ALL_QUOTES",
      "cancel:btc-usd:HARD_STALE_DROP",
      "schedule"
    ]);

    await Promise.all(sideEffects.scheduled);
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

  it("builds soft stale kill-switch storage, telemetry, and notification envelopes", () => {
    const staleTick = tick({ sequence: 321 });
    const metrics = latencyMetrics({ totalLatencyMs: 650 });
    const input = {
      tick: staleTick,
      metrics,
      maxLatencyMs: 250
    };

    expect(staleDataKillSwitchStorageExtra(input)).toEqual({
      "staleTick:hyperliquid:btc-usd:321": {
        tick: staleTick,
        metrics
      }
    });
    expect(staleDataKillSwitchTelemetryPayload(input)).toEqual({
      instrumentCode: "btc-usd",
      exchangeCode: "HL",
      source_exchange: "hyperliquid",
      sequence: 321,
      totalLatencyMs: 650,
      maxLatencyMs: 250,
      action: "PULL_CURRENT_QUOTES"
    });
    expect(staleDataKillSwitchNotification(input)).toMatchObject({
      priority: "HIGH",
      title: "Sovereign-Sigma stale-data kill switch",
      dedupeKey: "stale:hyperliquid:btc-usd",
      metadata: {
        instrumentCode: "btc-usd",
        sequence: 321,
        totalLatencyMs: 650,
        maxLatencyMs: 250
      }
    });
    expect(buildStaleDataKillSwitchArtifacts(input)).toEqual({
      storageExtra: staleDataKillSwitchStorageExtra(input),
      telemetryPayload: staleDataKillSwitchTelemetryPayload(input),
      notification: staleDataKillSwitchNotification(input),
      ingestResult: {
        accepted: false,
        status: "STALE",
        metrics
      }
    });
  });

  it("applies soft stale kill-switch side effects in telemetry and cancel order", async () => {
    const metrics = latencyMetrics({ status: "STALE", totalLatencyMs: 650 });
    const artifacts = buildStaleDataKillSwitchArtifacts({
      tick: tick({ sequence: 321 }),
      metrics,
      maxLatencyMs: 250
    });
    const sideEffects = staleDataKillSwitchSideEffectSpy();

    applyStaleDataKillSwitchSideEffects(
      {
        tick: tick({ sequence: 321 }),
        metrics,
        artifacts,
        tradingEnabled: true
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual([
      "performance:btc-usd:STALE",
      "publish:PULL_CURRENT_QUOTES",
      "notify:HIGH",
      "cancel:btc-usd:STALE_DATA_KILL_SWITCH",
      "schedule"
    ]);

    await Promise.all(sideEffects.scheduled);
  });

  it("orchestrates hard stale tick drops through state, persistence, and quote pulls", async () => {
    const currentState = defaultEngineState("hard-stale-flow");
    currentState.averageLatency = 300;
    currentState.latencySampleCount = 8;
    currentState.staleTickCount = 4;
    const flow = hardStaleTickDropFlowSpy();

    const result = await applyHardStaleTickDropFlow(
      {
        currentState,
        tick: tick({ sequence: 501 }),
        metrics: latencyMetrics({ totalLatencyMs: 900 }),
        streamId: "dwellir-btc",
        hardStaleDropMs: 150,
        tradingEnabled: true
      },
      flow.handlers
    );

    expect(result).toMatchObject({
      accepted: false,
      status: "STALE_DROPPED",
      reason: "TICK_EXCEEDED_HARD_STALE_THRESHOLD"
    });
    expect(flow.events).toEqual([
      "state:5",
      "reset:HARD_STALE_DROP",
      "persist:HARD_STALE_TICK_DROPPED",
      "warn:btc-usd:501",
      "performance:btc-usd:STALE",
      "publish:PULL_ALL_QUOTES",
      "cancel:btc-usd:HARD_STALE_DROP",
      "schedule"
    ]);
    await Promise.all(flow.scheduled);
  });

  it("orchestrates soft stale ticks after execution profiling has updated state", async () => {
    const currentState = defaultEngineState("soft-stale-flow");
    const flow = softStaleTickFlowSpy(currentState);

    const result = await applySoftStaleTickFlow(
      {
        tick: tick({ sequence: 777 }),
        metrics: latencyMetrics({ status: "STALE", totalLatencyMs: 650 }),
        maxLatencyMs: 250,
        quoteHibernateMs: 60_000,
        tradingEnabled: true,
        trace: {
          wakeUpTimeMs: 2,
          orderBookUpdateMs: null,
          agentLogicMs: null,
          hotPathStartedAt: 123,
          observedAt: "2026-05-18T15:00:00.250Z"
        }
      },
      flow.handlers
    );

    expect(result).toMatchObject({
      accepted: false,
      status: "STALE"
    });
    expect(flow.events).toEqual([
      "observe:650",
      "state:1:STALE_DATA_KILL_SWITCH:UNSTABLE",
      "persist:STALE_DATA_KILL_SWITCH:1",
      "performance:btc-usd:STALE",
      "publish:PULL_CURRENT_QUOTES",
      "notify:HIGH",
      "cancel:btc-usd:STALE_DATA_KILL_SWITCH",
      "schedule",
      "telemetry:STALE:123",
      "snapshot:2026-05-18T15:00:00.250Z"
    ]);
    await Promise.all(flow.scheduled);
  });

  it("routes stale latency decisions through the trading engine target adapter", async () => {
    const currentState = defaultEngineState("stale-target-flow");
    currentState.staleTickCount = 2;
    const events: string[] = [];
    const scheduled: Promise<unknown>[] = [];
    const target: TradingStaleLatencyTarget = {
      engineState: currentState,
      cachedConfig: {
        TRADING_ENABLED: true,
        QUOTE_HIBERNATE_MS: 60_000
      },
      env: {
        QUOTE_HIBERNATE_MS: undefined
      },
      maxLatencyMs: 250,
      state: {
        waitUntil(work) {
          events.push("schedule");
          scheduled.push(work);
        }
      },
      logger: {
        warn(eventType, _message, metadata) {
          events.push(`warn:${eventType}:${String(metadata.sequence)}`);
        }
      },
      notifier: {
        notify(notification) {
          events.push(`notify:${notification.priority}`);
        }
      },
      resetLatencyBaseline(_observedAt, reason) {
        events.push(`reset:${reason}`);
      },
      latencyStorageWrites(extra) {
        events.push(`writes:${extra ? Object.keys(extra).length : 0}`);
        return { latency: true, ...(extra ?? {}) };
      },
      async persistHotStorageSnapshot(writes, reason) {
        events.push(`persist:${reason}:${Object.keys(writes).length}`);
      },
      logPerformance(metrics) {
        events.push(`performance:${metrics.totalLatencyMs}`);
      },
      publish(type, payload) {
        events.push(`publish:${type}:${String(payload.action)}`);
      },
      async cancelAllQuotes(instrumentCode, reason) {
        events.push(`cancel:${instrumentCode}:${reason}`);
      },
      observeExecutionProfile(metrics) {
        events.push(`profile:${metrics.totalLatencyMs}`);
      },
      publishTickTelemetry(_tick, _metrics, status, hotPathStartedAt) {
        events.push(`telemetry:${status}:${hotPathStartedAt}`);
      },
      maybeRecordAgentSnapshot(observedAt) {
        events.push(`snapshot:${observedAt}`);
      }
    };

    const hard = await handleTradingHardStaleTickDrop(
      tick({ sequence: 900 }),
      latencyMetrics({ totalLatencyMs: 900 }),
      "dwellir-btc",
      150,
      target
    );
    const soft = await handleTradingSoftStaleTick(
      tick({ sequence: 901 }),
      latencyMetrics({ status: "STALE", totalLatencyMs: 650 }),
      2,
      123,
      target
    );

    expect(hard).toMatchObject({ status: "STALE_DROPPED" });
    expect(soft).toMatchObject({ status: "STALE" });
    expect(target.engineState.staleTickCount).toBeGreaterThan(2);
    expect(events).toContain("warn:HARD_STALE_TICK_DROPPED:900");
    expect(events).toContain("publish:STALE_DATA_KILL_SWITCH:PULL_ALL_QUOTES");
    expect(events).toContain("publish:STALE_DATA_KILL_SWITCH:PULL_CURRENT_QUOTES");
    expect(events).toContain("telemetry:STALE:123");
    await Promise.all(scheduled);
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

  it("assembles and applies native Hyperliquid latency-pull artifacts", async () => {
    const state = defaultEngineState("native-latency-artifacts");
    state.averageLatency = 151;
    state.latencySampleCount = 22;
    const existingLatencyHistory = [latencyMetrics({ sequence: 1, totalLatencyMs: 90 })];
    const artifacts = nativeHyperliquidLatencyPullArtifacts({
      currentState: state,
      metrics: latencyMetrics({ sequence: 2, totalLatencyMs: 180, maxLatencyMs: 150 }),
      instrumentCode: "btc-usd",
      sequence: 2,
      observedAt: "2026-05-18T15:00:01.000Z",
      existingLatencyHistory,
      latencyHistoryLimit: 2,
      engineStateKey: "engine:state",
      performanceHistoryKey: "latency:history",
      processingLatencySamplesKey: "latency:samples",
      processingLatencySamples: [2, 3]
    });
    const sideEffects = nativeLatencyPullSideEffectSpy();

    applyNativeHyperliquidLatencyPullSideEffects(artifacts, sideEffects.handlers);

    expect(artifacts.latencyHistory).toEqual([existingLatencyHistory[0], artifacts.metrics]);
    expect(artifacts.storageWrites).toEqual({
      "engine:state": artifacts.state,
      "latency:history": artifacts.latencyHistory,
      "latency:samples": [2, 3]
    });
    expect(sideEffects.events).toEqual([
      "state:1",
      "persist:NATIVE_HL_LATENCY_PULL:3",
      "schedule",
      "performance:180",
      "publish:STALE_DATA_KILL_SWITCH:PULL_CURRENT_QUOTES"
    ]);

    await Promise.all(sideEffects.scheduled);
  });

  it("runs trading native Hyperliquid latency-pull hooks before side effects", async () => {
    const state = defaultEngineState("native-latency-trading-flow");
    const events: string[] = [];
    const scheduled: Promise<unknown>[] = [];

    const artifacts = applyTradingNativeHyperliquidLatencyPull(
      {
        currentState: state,
        metrics: latencyMetrics({ sequence: 3, totalLatencyMs: 210, maxLatencyMs: 150 }),
        instrumentCode: "btc-usd",
        sequence: 3,
        observedAt: "2026-05-18T15:00:01.000Z",
        existingLatencyHistory: [latencyMetrics({ sequence: 2, totalLatencyMs: 90 })],
        latencyHistoryLimit: 4,
        engineStateKey: "engine:state",
        performanceHistoryKey: "latency:history",
        processingLatencySamplesKey: "latency:samples",
        processingLatencySamples: [2, 3]
      },
      {
        updateLatencyAverage: (totalLatencyMs) => events.push(`average:${totalLatencyMs}`),
        applyLocationLatency: (totalLatencyMs, observedAt) =>
          events.push(`location:${totalLatencyMs}:${observedAt}`),
        applyLatencyHistory: (history) => events.push(`history:${history.length}`),
        applyState: (nextState) => events.push(`state:${nextState.staleTickCount}`),
        persistStorage: (writes, reason) => {
          events.push(`persist:${reason}:${Object.keys(writes).length}`);
          return Promise.resolve();
        },
        schedule: (work) => {
          events.push("schedule");
          scheduled.push(work);
        },
        logPerformance: (metrics) => events.push(`performance:${metrics.totalLatencyMs}`),
        publish: (type, payload) => events.push(`publish:${type}:${payload.action}`)
      }
    );

    expect(artifacts.latencyHistory).toHaveLength(2);
    expect(events).toEqual([
      "average:210",
      "location:210:2026-05-18T15:00:01.000Z",
      "history:2",
      "state:1",
      "persist:NATIVE_HL_LATENCY_PULL:3",
      "schedule",
      "performance:210",
      "publish:STALE_DATA_KILL_SWITCH:PULL_CURRENT_QUOTES"
    ]);

    await Promise.all(scheduled);
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

  it("applies execution profile side effects when stability changes", () => {
    const sideEffects = executionProfileSideEffectSpy();

    const result = applyExecutionProfileSideEffects(
      {
        engineId: "engine-1",
        previousProfile: profile({
          status: "STABLE",
          lastComputedAt: "2026-05-18T14:59:00.000Z"
        }),
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
        },
        lastPerformanceStatus: "STABLE"
      },
      sideEffects.handlers
    );

    expect(result.profile.status).toBe("UNSTABLE");
    expect(sideEffects.events).toEqual([
      "profile:UNSTABLE",
      "mark:UNSTABLE",
      "snapshot:UNSTABLE",
      "publish:ENGINE_PERFORMANCE_UNSTABLE:engine-1:10",
      "notify:HIGH"
    ]);
  });

  it("orchestrates execution profile sampling and hot-path timing", () => {
    const sideEffects = executionProfileSideEffectSpy();
    const samples = [1, 5];

    const result = applyExecutionProfileFlow(
      {
        engineId: "engine-1",
        previousProfile: profile({
          status: "STABLE",
          lastComputedAt: "2026-05-18T14:59:00.000Z"
        }),
        processedTicks: 9,
        processingLatencySamples: samples,
        metrics: latencyMetrics({ processingLatencyMs: 9 }),
        trace: {
          wakeUpTimeMs: 30,
          orderBookUpdateMs: 2,
          agentLogicMs: 4,
          hotPathStartedAt: 100,
          observedAt: "2026-05-18T15:00:00.000Z"
        },
        jitterThresholdMs: 2,
        jitterSampleWindow: 3,
        jitterComputeIntervalTicks: 5,
        coldStartWakeupThresholdMs: 25,
        lastPerformanceStatus: "STABLE",
        nowMs: 112
      },
      sideEffects.handlers
    );

    expect(samples).toEqual([1, 5, 9]);
    expect(result.profile).toMatchObject({
      status: "UNSTABLE",
      totalHotPathMs: 12,
      lastProcessingLatencyMs: 9,
      coldStartSuspected: true
    });
    expect(sideEffects.events).toEqual([
      "profile:UNSTABLE",
      "mark:UNSTABLE",
      "snapshot:UNSTABLE",
      "publish:ENGINE_PERFORMANCE_UNSTABLE:engine-1:10",
      "notify:HIGH"
    ]);
  });
});

function executionProfileSideEffectSpy(): {
  events: string[];
  handlers: ExecutionProfileSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      applyProfile(nextProfile) {
        events.push(`profile:${nextProfile.status}`);
      },
      markPerformanceStatus(status) {
        events.push(`mark:${status}`);
      },
      logPerformanceSnapshot(snapshot) {
        events.push(`snapshot:${snapshot.status}`);
      },
      publishTransition(transition) {
        events.push(`publish:${transition.telemetryType}:${transition.correlationId}`);
      },
      notify(notification) {
        events.push(`notify:${notification.priority}`);
      }
    }
  };
}

function performanceSpikeLogSideEffectSpy(): {
  events: string[];
  handlers: PerformanceSpikeLogSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      logPerformance(metrics) {
        events.push(`log:${metrics.instrumentCode}:${metrics.status}:${metrics.sequence}`);
      }
    }
  };
}

function hardStaleTickDropSideEffectSpy(): {
  events: string[];
  scheduled: Promise<unknown>[];
  handlers: HardStaleTickDropSideEffectHandlers;
} {
  const events: string[] = [];
  const scheduled: Promise<unknown>[] = [];

  return {
    events,
    scheduled,
    handlers: {
      warnHardStale(metadata) {
        events.push(`warn:${metadata.instrumentCode}:${metadata.sequence}`);
      },
      logPerformance(metrics) {
        events.push(`performance:${metrics.instrumentCode}:${metrics.status}`);
      },
      publishPull(payload) {
        events.push(`publish:${payload.action}`);
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

function hardStaleTickDropFlowSpy(): {
  events: string[];
  scheduled: Promise<unknown>[];
  handlers: HardStaleTickDropFlowHandlers;
} {
  const events: string[] = [];
  const scheduled: Promise<unknown>[] = [];

  return {
    events,
    scheduled,
    handlers: {
      applyState(state) {
        events.push(`state:${state.staleTickCount}`);
      },
      resetLatencyBaseline(_observedAt, reason) {
        events.push(`reset:${reason}`);
      },
      persistLatencySnapshot(reason) {
        events.push(`persist:${reason}`);
        return Promise.resolve();
      },
      warnHardStale(metadata) {
        events.push(`warn:${metadata.instrumentCode}:${metadata.sequence}`);
      },
      logPerformance(metrics) {
        events.push(`performance:${metrics.instrumentCode}:${metrics.status}`);
      },
      publishPull(payload) {
        events.push(`publish:${payload.action}`);
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

function staleDataKillSwitchSideEffectSpy(): {
  events: string[];
  scheduled: Promise<unknown>[];
  handlers: StaleDataKillSwitchSideEffectHandlers;
} {
  const events: string[] = [];
  const scheduled: Promise<unknown>[] = [];

  return {
    events,
    scheduled,
    handlers: {
      logPerformance(metrics) {
        events.push(`performance:${metrics.instrumentCode}:${metrics.status}`);
      },
      publishKillSwitch(payload) {
        events.push(`publish:${payload.action}`);
      },
      notify(notification) {
        events.push(`notify:${notification.priority}`);
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

function softStaleTickFlowSpy(initialState: EngineState): {
  events: string[];
  scheduled: Promise<unknown>[];
  handlers: SoftStaleTickFlowHandlers;
} {
  const events: string[] = [];
  const scheduled: Promise<unknown>[] = [];
  let currentState = initialState;

  return {
    events,
    scheduled,
    handlers: {
      readCurrentState() {
        return currentState;
      },
      observeExecutionProfile(metrics) {
        events.push(`observe:${metrics.totalLatencyMs}`);
        currentState = {
          ...currentState,
          executionProfile: {
            ...currentState.executionProfile,
            status: "UNSTABLE"
          }
        };
      },
      applyState(state) {
        currentState = state;
        events.push(
          `state:${state.staleTickCount}:${state.assetQuoteStates["btc-usd"]?.reason}:${state.executionProfile.status}`
        );
      },
      persistLatencySnapshot(extra, reason) {
        events.push(`persist:${reason}:${Object.keys(extra).length}`);
        return Promise.resolve();
      },
      logPerformance(metrics) {
        events.push(`performance:${metrics.instrumentCode}:${metrics.status}`);
      },
      publishKillSwitch(payload) {
        events.push(`publish:${payload.action}`);
      },
      notify(notification) {
        events.push(`notify:${notification.priority}`);
      },
      schedule(work) {
        events.push("schedule");
        scheduled.push(work);
      },
      cancelAllQuotes(instrumentCode, reason) {
        events.push(`cancel:${instrumentCode}:${reason}`);
        return Promise.resolve();
      },
      publishTickTelemetry(_tick, _metrics, status, hotPathStartedAt) {
        events.push(`telemetry:${status}:${hotPathStartedAt}`);
      },
      recordAgentSnapshot(observedAt) {
        events.push(`snapshot:${observedAt}`);
      }
    }
  };
}

function latencyBaselineResetSideEffectSpy(): {
  events: string[];
  handlers: LatencyBaselineResetSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      replaceLatencyHistory(history) {
        events.push(`history:${history.length}`);
      },
      replaceProcessingLatencySamples(samples) {
        events.push(`samples:${samples.length}`);
      },
      applyState(state) {
        events.push(`state:${state.averageLatency}`);
      },
      logReset(metadata) {
        events.push(`log:${metadata.reason}`);
      }
    }
  };
}

function nativeLatencyPullSideEffectSpy(): {
  events: string[];
  scheduled: Promise<unknown>[];
  handlers: NativeHyperliquidLatencyPullSideEffectHandlers;
} {
  const events: string[] = [];
  const scheduled: Promise<unknown>[] = [];

  return {
    events,
    scheduled,
    handlers: {
      applyState(state) {
        events.push(`state:${state.staleTickCount}`);
      },
      persistStorage(writes, reason) {
        events.push(`persist:${reason}:${Object.keys(writes).length}`);
        return Promise.resolve();
      },
      schedule(work) {
        events.push("schedule");
        scheduled.push(work);
      },
      logPerformance(metrics) {
        events.push(`performance:${metrics.totalLatencyMs}`);
      },
      publish(type, payload) {
        events.push(`publish:${type}:${payload.action}`);
      }
    }
  };
}

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
