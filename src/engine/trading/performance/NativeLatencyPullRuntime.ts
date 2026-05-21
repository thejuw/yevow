import { aggregateQuoteState, suspendAssetQuoteStates } from "../state/AssetStateRuntime";
import type { EngineState, LatencyMetrics } from "../../../types";

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
