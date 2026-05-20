import { aggregateQuoteState, suspendAssetQuoteStates } from "../state/AssetStateRuntime";
import type { EngineState, JsonRecord, LatencyMetrics, MarketTick } from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { ExecutionTraceInput } from "./LatencyRuntime";
export {
  applyHardStaleTickDropFlow,
  applyHardStaleTickDropSideEffects,
  buildHardStaleTickDropArtifacts,
  hardStalePullTelemetryPayload,
  hardStaleTickDropLogMetadata,
  shouldLogHardStaleTickDrop,
  stateAfterHardStaleTickDrop,
  type HardStaleTickDropArtifacts,
  type HardStaleTickDropArtifactsInput,
  type HardStaleTickDropFlowHandlers,
  type HardStaleTickDropFlowInput,
  type HardStaleTickDropInput,
  type HardStaleTickDropResult,
  type HardStaleTickDropSideEffectHandlers,
  type HardStaleTickDropSideEffectInput,
  type HardStaleTickDropTelemetryInput
} from "./HardStaleLatencyRuntime";

export interface StaleDataKillSwitchInput {
  readonly currentState: EngineState;
  readonly metrics: LatencyMetrics;
  readonly instrumentCode: string;
  readonly maxLatencyMs: number;
  readonly quoteHibernateMs: number;
}

export interface StaleDataKillSwitchResult {
  readonly state: EngineState;
  readonly suspendedUntil: string;
}

export interface StaleDataKillSwitchTelemetryInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly maxLatencyMs: number;
}

export interface StaleDataKillSwitchArtifacts {
  readonly storageExtra: Record<string, unknown>;
  readonly telemetryPayload: JsonRecord;
  readonly notification: NotifierEvent;
  readonly ingestResult: TickIngestResult;
}

export interface StaleDataKillSwitchSideEffectInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly artifacts: StaleDataKillSwitchArtifacts;
  readonly tradingEnabled: boolean;
}

export interface StaleDataKillSwitchSideEffectHandlers {
  readonly logPerformance: (metrics: LatencyMetrics) => void;
  readonly publishKillSwitch: (payload: JsonRecord) => void;
  readonly notify: (notification: NotifierEvent) => void;
  readonly schedule: (work: Promise<unknown>) => void;
  readonly cancelAllQuotes: (
    instrumentCode: string,
    reason: "STALE_DATA_KILL_SWITCH"
  ) => Promise<unknown>;
}

export interface SoftStaleTickFlowInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly maxLatencyMs: number;
  readonly quoteHibernateMs: number;
  readonly tradingEnabled: boolean;
  readonly trace: ExecutionTraceInput;
}

export interface SoftStaleTickFlowHandlers extends StaleDataKillSwitchSideEffectHandlers {
  readonly readCurrentState: () => EngineState;
  readonly observeExecutionProfile: (metrics: LatencyMetrics, trace: ExecutionTraceInput) => void;
  readonly applyState: (state: EngineState) => void;
  readonly persistLatencySnapshot: (
    extra: Record<string, unknown>,
    reason: "STALE_DATA_KILL_SWITCH"
  ) => Promise<void>;
  readonly publishTickTelemetry: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    status: "STALE",
    hotPathStartedAt: number
  ) => void;
  readonly recordAgentSnapshot: (observedAt: string) => void;
}

export function stateAfterStaleDataKillSwitch(
  input: StaleDataKillSwitchInput
): StaleDataKillSwitchResult {
  const suspendedUntil = new Date(
    Date.parse(input.metrics.brainTimestamp) + input.quoteHibernateMs
  ).toISOString();
  const assetQuoteStates = suspendAssetQuoteStates(
    input.currentState.assetQuoteStates,
    "STALE_DATA_KILL_SWITCH",
    input.metrics.brainTimestamp,
    {
      instrumentCode: input.instrumentCode,
      suspendedUntil,
      lastQuote: input.currentState.quoteState.lastQuote
    }
  );

  return {
    suspendedUntil,
    state: {
      ...input.currentState,
      processedTicks: input.currentState.processedTicks + 1,
      staleTickCount: input.currentState.staleTickCount + 1,
      quoteState: aggregateQuoteState(
        assetQuoteStates,
        input.currentState.quoteState,
        input.metrics.brainTimestamp
      ),
      assetQuoteStates,
      maxLatencyMs: input.maxLatencyMs,
      heartbeatAt: input.metrics.brainTimestamp,
      updatedAt: input.metrics.brainTimestamp
    }
  };
}

export function buildStaleDataKillSwitchArtifacts(
  input: StaleDataKillSwitchTelemetryInput
): StaleDataKillSwitchArtifacts {
  return {
    storageExtra: staleDataKillSwitchStorageExtra(input),
    telemetryPayload: staleDataKillSwitchTelemetryPayload(input),
    notification: staleDataKillSwitchNotification(input),
    ingestResult: {
      accepted: false,
      status: "STALE",
      metrics: input.metrics
    }
  };
}

export function staleDataKillSwitchStorageExtra(
  input: StaleDataKillSwitchTelemetryInput
): Record<string, unknown> {
  return {
    [`staleTick:${input.tick.source_exchange}:${input.tick.instrumentCode}:${input.tick.sequence}`]:
      {
        tick: input.tick,
        metrics: input.metrics
      }
  };
}

export function staleDataKillSwitchTelemetryPayload(
  input: StaleDataKillSwitchTelemetryInput
): JsonRecord {
  return {
    instrumentCode: input.tick.instrumentCode,
    exchangeCode: input.tick.exchangeCode,
    source_exchange: input.tick.source_exchange,
    sequence: input.tick.sequence,
    totalLatencyMs: input.metrics.totalLatencyMs,
    maxLatencyMs: input.maxLatencyMs,
    action: "PULL_CURRENT_QUOTES"
  };
}

export function staleDataKillSwitchNotification(
  input: StaleDataKillSwitchTelemetryInput
): NotifierEvent {
  return {
    priority: "HIGH",
    title: "Sovereign-Sigma stale-data kill switch",
    message: `${input.tick.instrumentCode} seq ${input.tick.sequence} exceeded ${input.maxLatencyMs}ms freshness threshold (${input.metrics.totalLatencyMs}ms). Quotes are being pulled.`,
    dedupeKey: `stale:${input.tick.source_exchange}:${input.tick.instrumentCode}`,
    metadata: {
      instrumentCode: input.tick.instrumentCode,
      sequence: input.tick.sequence,
      totalLatencyMs: input.metrics.totalLatencyMs,
      maxLatencyMs: input.maxLatencyMs
    }
  };
}

export function applyStaleDataKillSwitchSideEffects(
  input: StaleDataKillSwitchSideEffectInput,
  handlers: StaleDataKillSwitchSideEffectHandlers
): void {
  handlers.logPerformance(input.metrics);
  handlers.publishKillSwitch(input.artifacts.telemetryPayload);
  handlers.notify(input.artifacts.notification);

  if (input.tradingEnabled) {
    handlers.schedule(
      handlers.cancelAllQuotes(input.tick.instrumentCode, "STALE_DATA_KILL_SWITCH")
    );
  }
}

export async function applySoftStaleTickFlow(
  input: SoftStaleTickFlowInput,
  handlers: SoftStaleTickFlowHandlers
): Promise<TickIngestResult> {
  handlers.observeExecutionProfile(input.metrics, input.trace);

  const staleState = stateAfterStaleDataKillSwitch({
    currentState: handlers.readCurrentState(),
    metrics: input.metrics,
    instrumentCode: input.tick.instrumentCode,
    maxLatencyMs: input.maxLatencyMs,
    quoteHibernateMs: input.quoteHibernateMs
  });
  handlers.applyState(staleState.state);

  const artifacts = buildStaleDataKillSwitchArtifacts({
    tick: input.tick,
    metrics: input.metrics,
    maxLatencyMs: input.maxLatencyMs
  });

  await handlers.persistLatencySnapshot(artifacts.storageExtra, "STALE_DATA_KILL_SWITCH");

  applyStaleDataKillSwitchSideEffects(
    {
      tick: input.tick,
      metrics: input.metrics,
      artifacts,
      tradingEnabled: input.tradingEnabled
    },
    handlers
  );
  handlers.publishTickTelemetry(input.tick, input.metrics, "STALE", input.trace.hotPathStartedAt);
  handlers.recordAgentSnapshot(input.metrics.brainTimestamp);

  return artifacts.ingestResult;
}

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
