import type { EngineState, JsonRecord, LatencyMetrics } from "../../../types";
import {
  ENGINE_STATE_KEY,
  PERFORMANCE_HISTORY_KEY,
  PROCESSING_LATENCY_SAMPLES_KEY
} from "../../../TradingEngineConstants";
import {
  applyLatencyBaselineResetSideEffects,
  latencyBaselineResetArtifacts
} from "./LatencyBaselineRuntime";
import { nextLatencyAverage } from "./LatencyTickRuntime";
import { latencySnapshotStorageWrites } from "./StaleLatencyGuardRuntime";

export interface TradingLatencyStateTarget {
  engineState: EngineState;
  latencyHistory: LatencyMetrics[];
  processingLatencySamples: number[];
  readonly logger: {
    info(eventType: string, message: string, telemetry?: JsonRecord): void;
  };
}

export interface TradingLatencyStorageSource {
  readonly latencyHistory: readonly LatencyMetrics[];
  readonly processingLatencySamples: readonly number[];
}

export function updateTradingLatencyAverageForTarget(
  totalLatencyMs: number,
  target: TradingLatencyStateTarget
): void {
  const next = nextLatencyAverage(
    {
      averageLatency: target.engineState.averageLatency,
      latencySampleCount: target.engineState.latencySampleCount
    },
    totalLatencyMs
  );

  target.engineState = {
    ...target.engineState,
    averageLatency: next.averageLatency,
    latencySampleCount: next.latencySampleCount
  };
}

export function resetTradingLatencyBaselineForTarget(
  observedAt: string,
  reason: string,
  target: TradingLatencyStateTarget
): void {
  const artifacts = latencyBaselineResetArtifacts({
    currentState: target.engineState,
    observedAt,
    reason
  });

  applyLatencyBaselineResetSideEffects(artifacts, {
    replaceLatencyHistory: (history) => {
      target.latencyHistory = [...history];
    },
    replaceProcessingLatencySamples: (samples) => {
      target.processingLatencySamples = [...samples];
    },
    applyState: (state) => {
      target.engineState = state;
    },
    logReset: (metadata) => {
      target.logger.info("LATENCY_BASELINE_RESET", "Reset stale latency baseline", metadata);
    }
  });
}

export function tradingLatencyStorageWritesForState(
  input: TradingLatencyStorageSource & {
    readonly state: EngineState;
    readonly extra?: Record<string, unknown>;
  }
): Record<string, unknown> {
  return latencySnapshotStorageWrites({
    engineStateKey: ENGINE_STATE_KEY,
    state: input.state,
    performanceHistoryKey: PERFORMANCE_HISTORY_KEY,
    latencyHistory: input.latencyHistory,
    processingLatencySamplesKey: PROCESSING_LATENCY_SAMPLES_KEY,
    processingLatencySamples: input.processingLatencySamples,
    extra: input.extra
  });
}

export function tradingLatencyStorageWritesForTarget(
  target: TradingLatencyStorageSource & { readonly engineState: EngineState },
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return tradingLatencyStorageWritesForState({
    state: target.engineState,
    latencyHistory: target.latencyHistory,
    processingLatencySamples: target.processingLatencySamples,
    extra
  });
}
