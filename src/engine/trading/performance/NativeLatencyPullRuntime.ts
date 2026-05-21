import { aggregateQuoteState, suspendAssetQuoteStates } from "../state/AssetStateRuntime";
import type { EngineState, LatencyMetrics } from "../../../types";
import {
  ENGINE_STATE_KEY,
  PERFORMANCE_HISTORY_KEY,
  PERFORMANCE_HISTORY_LIMIT,
  PROCESSING_LATENCY_SAMPLES_KEY
} from "../../../TradingEngineConstants";
import {
  applyTradingLocationLatencyForTarget,
  type TradingTopologyTarget
} from "../helpers/TradingTopologyRuntime";
import {
  updateTradingLatencyAverageForTarget,
  type TradingLatencyStateTarget
} from "./TradingLatencyStateRuntime";
import {
  logTradingPerformanceForTarget,
  type TradingHotPathTelemetryTarget
} from "../telemetry/TradingHotPathTelemetryRuntime";
import { applyHotStorageSnapshotForTargetOrHandler } from "../state/StorageWriteGuard";

export interface NativeHyperliquidLatencyPullInput {
  readonly currentState: EngineState;
  readonly metrics: LatencyMetrics;
  readonly instrumentCode: string;
  readonly sequence: number;
  readonly observedAt: string;
}

export interface NativeHyperliquidLatencyPullResult {
  readonly state: EngineState;
  readonly metrics: LatencyMetrics;
  readonly telemetryType: "STALE_DATA_KILL_SWITCH";
  readonly telemetryPayload: Record<string, unknown>;
}

export interface NativeHyperliquidLatencyPullStorageInput {
  readonly engineStateKey: string;
  readonly state: EngineState;
  readonly performanceHistoryKey: string;
  readonly latencyHistory: readonly LatencyMetrics[];
  readonly processingLatencySamplesKey: string;
  readonly processingLatencySamples: readonly number[];
}

export interface NativeHyperliquidLatencyPullArtifactsInput extends NativeHyperliquidLatencyPullInput {
  readonly existingLatencyHistory: readonly LatencyMetrics[];
  readonly latencyHistoryLimit: number;
  readonly engineStateKey: string;
  readonly performanceHistoryKey: string;
  readonly processingLatencySamplesKey: string;
  readonly processingLatencySamples: readonly number[];
}

export interface NativeHyperliquidLatencyPullArtifacts extends NativeHyperliquidLatencyPullResult {
  readonly latencyHistory: readonly LatencyMetrics[];
  readonly storageWrites: Record<string, unknown>;
}

export interface NativeHyperliquidLatencyPullSideEffectHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly persistStorage: (
    writes: Record<string, unknown>,
    reason: "NATIVE_HL_LATENCY_PULL"
  ) => Promise<unknown>;
  readonly schedule: (work: Promise<unknown>) => void;
  readonly logPerformance: (metrics: LatencyMetrics) => void;
  readonly publish: (type: "STALE_DATA_KILL_SWITCH", payload: Record<string, unknown>) => void;
}

export type TradingNativeHyperliquidLatencyPullInput = NativeHyperliquidLatencyPullArtifactsInput;

export interface TradingNativeHyperliquidLatencyPullHandlers extends NativeHyperliquidLatencyPullSideEffectHandlers {
  readonly updateLatencyAverage: (totalLatencyMs: number) => void;
  readonly applyLocationLatency: (totalLatencyMs: number, observedAt: string) => void;
  readonly applyLatencyHistory: (latencyHistory: LatencyMetrics[]) => void;
}

export interface TradingNativeHyperliquidLatencyPullTarget {
  engineState: EngineState;
  readonly cachedConfig: TradingTopologyTarget["cachedConfig"];
  latencyHistory: LatencyMetrics[];
  readonly processingLatencySamples: readonly number[];
  readonly state: {
    waitUntil(work: Promise<unknown>): void;
  };
  persistHotStorageSnapshot?(
    writes: Record<string, unknown>,
    reason: "NATIVE_HL_LATENCY_PULL"
  ): Promise<unknown>;
  logPerformance?(metrics: LatencyMetrics): void;
  publish(type: "STALE_DATA_KILL_SWITCH", payload: Record<string, unknown>): void;
}

export interface LatencySnapshotStorageInput {
  readonly engineStateKey: string;
  readonly state: EngineState;
  readonly performanceHistoryKey: string;
  readonly latencyHistory: readonly LatencyMetrics[];
  readonly processingLatencySamplesKey: string;
  readonly processingLatencySamples: readonly number[];
  readonly extra?: Record<string, unknown>;
}

export function stateAfterNativeHyperliquidLatencyPull(
  input: NativeHyperliquidLatencyPullInput
): NativeHyperliquidLatencyPullResult {
  const metrics: LatencyMetrics = {
    ...input.metrics,
    averageLatencyMs: input.currentState.averageLatency,
    sampleCount: input.currentState.latencySampleCount,
    latencyRiskMultiplier: input.currentState.location.latencyRiskMultiplier,
    positionSizeMultiplier: input.currentState.location.positionSizeMultiplier
  };
  const assetQuoteStates = suspendAssetQuoteStates(
    input.currentState.assetQuoteStates,
    "NATIVE_HL_LATENCY",
    input.observedAt,
    { instrumentCode: input.instrumentCode, lastQuote: input.currentState.quoteState.lastQuote }
  );

  return {
    metrics,
    telemetryType: "STALE_DATA_KILL_SWITCH",
    telemetryPayload: {
      instrumentCode: input.instrumentCode,
      exchangeCode: "hyperliquid",
      source_exchange: "hyperliquid",
      sequence: input.sequence,
      totalLatencyMs: metrics.totalLatencyMs,
      maxLatencyMs: metrics.maxLatencyMs,
      action: "PULL_CURRENT_QUOTES",
      source: "NATIVE_HYPERLIQUID"
    },
    state: {
      ...input.currentState,
      processedTicks: input.currentState.processedTicks + 1,
      staleTickCount: input.currentState.staleTickCount + 1,
      quoteState: aggregateQuoteState(
        assetQuoteStates,
        input.currentState.quoteState,
        input.observedAt
      ),
      assetQuoteStates,
      heartbeatAt: input.observedAt,
      updatedAt: input.observedAt
    }
  };
}

export function nativeHyperliquidLatencyPullStorageWrites(
  input: NativeHyperliquidLatencyPullStorageInput
): Record<string, unknown> {
  return latencySnapshotStorageWrites(input);
}

export function nativeHyperliquidLatencyPullArtifacts(
  input: NativeHyperliquidLatencyPullArtifactsInput
): NativeHyperliquidLatencyPullArtifacts {
  const pull = stateAfterNativeHyperliquidLatencyPull(input);
  const latencyHistory = [...input.existingLatencyHistory, pull.metrics].slice(
    -input.latencyHistoryLimit
  );

  return {
    ...pull,
    latencyHistory,
    storageWrites: nativeHyperliquidLatencyPullStorageWrites({
      engineStateKey: input.engineStateKey,
      state: pull.state,
      performanceHistoryKey: input.performanceHistoryKey,
      latencyHistory,
      processingLatencySamplesKey: input.processingLatencySamplesKey,
      processingLatencySamples: input.processingLatencySamples
    })
  };
}

export function applyNativeHyperliquidLatencyPullSideEffects(
  artifacts: NativeHyperliquidLatencyPullArtifacts,
  handlers: NativeHyperliquidLatencyPullSideEffectHandlers
): void {
  handlers.applyState(artifacts.state);
  handlers.schedule(handlers.persistStorage(artifacts.storageWrites, "NATIVE_HL_LATENCY_PULL"));
  handlers.logPerformance(artifacts.metrics);
  handlers.publish(artifacts.telemetryType, artifacts.telemetryPayload);
}

export function applyTradingNativeHyperliquidLatencyPull(
  input: TradingNativeHyperliquidLatencyPullInput,
  handlers: TradingNativeHyperliquidLatencyPullHandlers
): NativeHyperliquidLatencyPullArtifacts {
  handlers.updateLatencyAverage(input.metrics.totalLatencyMs);
  handlers.applyLocationLatency(input.metrics.totalLatencyMs, input.observedAt);

  const artifacts = nativeHyperliquidLatencyPullArtifacts(input);

  handlers.applyLatencyHistory([...artifacts.latencyHistory]);
  applyNativeHyperliquidLatencyPullSideEffects(artifacts, handlers);

  return artifacts;
}

export function applyTradingNativeHyperliquidLatencyPullForTarget(
  input: Pick<
    NativeHyperliquidLatencyPullArtifactsInput,
    "instrumentCode" | "sequence" | "metrics" | "observedAt"
  >,
  target: TradingNativeHyperliquidLatencyPullTarget
): NativeHyperliquidLatencyPullArtifacts {
  return applyTradingNativeHyperliquidLatencyPull(
    {
      ...input,
      currentState: target.engineState,
      existingLatencyHistory: target.latencyHistory,
      latencyHistoryLimit: PERFORMANCE_HISTORY_LIMIT,
      engineStateKey: ENGINE_STATE_KEY,
      performanceHistoryKey: PERFORMANCE_HISTORY_KEY,
      processingLatencySamplesKey: PROCESSING_LATENCY_SAMPLES_KEY,
      processingLatencySamples: target.processingLatencySamples
    },
    {
      updateLatencyAverage: (totalLatencyMs) => {
        updateTradingLatencyAverageForTarget(
          totalLatencyMs,
          target as unknown as TradingLatencyStateTarget
        );
      },
      applyLocationLatency: (totalLatencyMs, observedAt) => {
        applyTradingLocationLatencyForTarget(
          totalLatencyMs,
          observedAt,
          target as unknown as TradingTopologyTarget
        );
      },
      applyLatencyHistory: (latencyHistory) => {
        target.latencyHistory = latencyHistory;
      },
      applyState: (state) => {
        target.engineState = state;
      },
      persistStorage: (writes, reason) =>
        applyHotStorageSnapshotForTargetOrHandler(target, writes, reason),
      schedule: (work) => {
        target.state.waitUntil(work);
      },
      logPerformance: (metrics) => {
        if (target.logPerformance) {
          target.logPerformance(metrics);
          return;
        }
        logTradingPerformanceForTarget(metrics, target as unknown as TradingHotPathTelemetryTarget);
      },
      publish: (type, payload) => {
        target.publish(type, payload);
      }
    }
  );
}

export function latencySnapshotStorageWrites(
  input: LatencySnapshotStorageInput
): Record<string, unknown> {
  return {
    [input.engineStateKey]: input.state,
    [input.performanceHistoryKey]: input.latencyHistory,
    [input.processingLatencySamplesKey]: input.processingLatencySamples,
    ...(input.extra ?? {})
  };
}
