import type { PerformanceSnapshot } from "../../../Logger";
import { highResolutionNow, roundLatency } from "../helpers/RuntimeClock";
import { processingLatencyStats, prometheusMetric } from "../helpers/RuntimeMetrics";
import { aggregateQuoteState, suspendAssetQuoteStates } from "../state/AssetStateRuntime";
import { defaultExecutionProfile } from "../state/EngineStateDefaults";
import type {
  EngineState,
  EngineStabilityStatus,
  ExecutionProfile,
  JsonRecord,
  LatencyMetrics,
  MarketTick
} from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";
import type { TickIngestResult } from "../TradingEngineRouteTypes";

export interface ExecutionTraceInput {
  wakeUpTimeMs: number | null;
  orderBookUpdateMs: number | null;
  agentLogicMs: number | null;
  hotPathStartedAt: number;
  observedAt: string;
}

export interface ExecutionPerformanceTransition {
  readonly telemetryType: "ENGINE_PERFORMANCE_UNSTABLE" | "ENGINE_PERFORMANCE_STABLE";
  readonly telemetryPayload: Record<string, unknown>;
  readonly correlationId: string;
  readonly notification: NotifierEvent;
}

export function stateAfterLatencyBaselineReset(
  currentState: EngineState,
  observedAt: string
): EngineState {
  return {
    ...currentState,
    averageLatency: 0,
    latencySampleCount: 0,
    executionProfile: {
      ...currentState.executionProfile,
      status: "STABLE",
      jitterMs: 0,
      sampleCount: 0,
      averageProcessingLatencyMs: 0,
      maxProcessingLatencyMs: 0,
      lastProcessingLatencyMs: 0,
      updatedAt: observedAt
    },
    updatedAt: observedAt
  };
}

export interface LatencyBaselineResetArtifactsInput {
  readonly currentState: EngineState;
  readonly observedAt: string;
  readonly reason: string;
}

export interface LatencyBaselineResetArtifacts {
  readonly state: EngineState;
  readonly latencyHistory: readonly LatencyMetrics[];
  readonly processingLatencySamples: readonly number[];
  readonly logMetadata: JsonRecord;
}

export interface LatencyBaselineResetSideEffectHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly replaceLatencyHistory: (history: readonly LatencyMetrics[]) => void;
  readonly replaceProcessingLatencySamples: (samples: readonly number[]) => void;
  readonly logReset: (metadata: JsonRecord) => void;
}

export function latencyBaselineResetArtifacts(
  input: LatencyBaselineResetArtifactsInput
): LatencyBaselineResetArtifacts {
  return {
    state: stateAfterLatencyBaselineReset(input.currentState, input.observedAt),
    latencyHistory: [],
    processingLatencySamples: [],
    logMetadata: {
      reason: input.reason,
      observedAt: input.observedAt
    }
  };
}

export function applyLatencyBaselineResetSideEffects(
  artifacts: LatencyBaselineResetArtifacts,
  handlers: LatencyBaselineResetSideEffectHandlers
): void {
  handlers.replaceLatencyHistory(artifacts.latencyHistory);
  handlers.replaceProcessingLatencySamples(artifacts.processingLatencySamples);
  handlers.applyState(artifacts.state);
  handlers.logReset(artifacts.logMetadata);
}

export interface PerformanceSpikeLogGateInput {
  readonly logAt: Map<string, number>;
  readonly latencyMetrics: LatencyMetrics;
  readonly throttleMs: number;
  readonly nowMs?: number;
}

export interface PerformanceSpikeLogSideEffectHandlers {
  readonly logPerformance: (latencyMetrics: LatencyMetrics) => void;
}

export function shouldLogPerformanceSpikeEvent(input: PerformanceSpikeLogGateInput): boolean {
  const key = `${input.latencyMetrics.instrumentCode}:${input.latencyMetrics.status}`;
  const now = input.nowMs ?? Date.now();
  const previous = input.logAt.get(key);

  if (previous !== undefined && now - previous < input.throttleMs) {
    return false;
  }

  input.logAt.set(key, now);
  return true;
}

export function applyPerformanceSpikeLogSideEffect(
  input: PerformanceSpikeLogGateInput,
  handlers: PerformanceSpikeLogSideEffectHandlers
): boolean {
  if (!shouldLogPerformanceSpikeEvent(input)) {
    return false;
  }

  handlers.logPerformance(input.latencyMetrics);
  return true;
}

export interface HardStaleTickDropInput {
  readonly currentState: EngineState;
  readonly metrics: LatencyMetrics;
  readonly hardStaleDropMs: number;
}

export interface HardStaleTickDropResult {
  readonly state: EngineState;
  readonly metrics: LatencyMetrics;
  readonly nextStaleTickCount: number;
  readonly shouldResetLatencyBaseline: boolean;
}

export interface HardStaleTickDropTelemetryInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly streamId: string | null;
  readonly hardStaleDropMs: number;
}

export interface HardStaleTickDropArtifactsInput extends HardStaleTickDropTelemetryInput {
  readonly nextStaleTickCount: number;
}

export interface HardStaleTickDropArtifacts {
  readonly shouldLog: boolean;
  readonly logMetadata: JsonRecord;
  readonly telemetryPayload: JsonRecord;
  readonly ingestResult: TickIngestResult;
}

export interface HardStaleTickDropSideEffectInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly artifacts: HardStaleTickDropArtifacts;
  readonly tradingEnabled: boolean;
}

export interface HardStaleTickDropSideEffectHandlers {
  readonly warnHardStale: (metadata: JsonRecord) => void;
  readonly logPerformance: (metrics: LatencyMetrics) => void;
  readonly publishPull: (payload: JsonRecord) => void;
  readonly schedule: (work: Promise<unknown>) => void;
  readonly cancelAllQuotes: (instrumentCode: string, reason: "HARD_STALE_DROP") => Promise<unknown>;
}

export interface HardStaleTickDropFlowInput {
  readonly currentState: EngineState;
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly streamId: string | null;
  readonly hardStaleDropMs: number;
  readonly tradingEnabled: boolean;
}

export interface HardStaleTickDropFlowHandlers extends HardStaleTickDropSideEffectHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly resetLatencyBaseline: (observedAt: string, reason: "HARD_STALE_DROP") => void;
  readonly persistLatencySnapshot: (reason: "HARD_STALE_TICK_DROPPED") => Promise<void>;
}

export function stateAfterHardStaleTickDrop(
  input: HardStaleTickDropInput
): HardStaleTickDropResult {
  const nextStaleTickCount = input.currentState.staleTickCount + 1;
  const metrics: LatencyMetrics = {
    ...input.metrics,
    status: "STALE",
    maxLatencyMs: input.hardStaleDropMs,
    averageLatencyMs: input.currentState.averageLatency,
    sampleCount: input.currentState.latencySampleCount
  };
  const assetQuoteStates = suspendAssetQuoteStates(
    input.currentState.assetQuoteStates,
    "HARD_STALE_DROP",
    metrics.brainTimestamp,
    { lastQuote: input.currentState.quoteState.lastQuote }
  );

  return {
    metrics,
    nextStaleTickCount,
    shouldResetLatencyBaseline: input.currentState.averageLatency > input.hardStaleDropMs,
    state: {
      ...input.currentState,
      processedTicks: input.currentState.processedTicks + 1,
      staleTickCount: nextStaleTickCount,
      quoteState: aggregateQuoteState(
        assetQuoteStates,
        input.currentState.quoteState,
        metrics.brainTimestamp
      ),
      assetQuoteStates,
      heartbeatAt: metrics.brainTimestamp,
      updatedAt: metrics.brainTimestamp
    }
  };
}

export function shouldLogHardStaleTickDrop(nextStaleTickCount: number): boolean {
  return nextStaleTickCount <= 5 || nextStaleTickCount % 500 === 0;
}

export function buildHardStaleTickDropArtifacts(
  input: HardStaleTickDropArtifactsInput
): HardStaleTickDropArtifacts {
  return {
    shouldLog: shouldLogHardStaleTickDrop(input.nextStaleTickCount),
    logMetadata: hardStaleTickDropLogMetadata(input),
    telemetryPayload: hardStalePullTelemetryPayload(input),
    ingestResult: {
      accepted: false,
      status: "STALE_DROPPED",
      reason: "TICK_EXCEEDED_HARD_STALE_THRESHOLD",
      metrics: input.metrics
    }
  };
}

export function hardStaleTickDropLogMetadata(input: HardStaleTickDropTelemetryInput): JsonRecord {
  return {
    instrumentCode: input.tick.instrumentCode,
    exchangeCode: input.tick.exchangeCode,
    source_exchange: input.tick.source_exchange,
    transport: input.tick.transport,
    streamId: input.streamId,
    sequence: input.tick.sequence,
    totalLatencyMs: input.metrics.totalLatencyMs,
    networkLatencyMs: input.metrics.networkLatencyMs,
    processingLatencyMs: input.metrics.processingLatencyMs,
    hardStaleDropMs: input.hardStaleDropMs
  };
}

export function hardStalePullTelemetryPayload(input: HardStaleTickDropTelemetryInput): JsonRecord {
  return {
    instrumentCode: input.tick.instrumentCode,
    exchangeCode: input.tick.exchangeCode,
    source_exchange: input.tick.source_exchange,
    transport: input.tick.transport,
    streamId: input.streamId,
    sequence: input.tick.sequence,
    totalLatencyMs: input.metrics.totalLatencyMs,
    maxLatencyMs: input.hardStaleDropMs,
    action: "PULL_ALL_QUOTES",
    source: "NATIVE_HYPERLIQUID"
  };
}

export function applyHardStaleTickDropSideEffects(
  input: HardStaleTickDropSideEffectInput,
  handlers: HardStaleTickDropSideEffectHandlers
): void {
  if (input.artifacts.shouldLog) {
    handlers.warnHardStale(input.artifacts.logMetadata);
  }

  handlers.logPerformance(input.metrics);
  handlers.publishPull(input.artifacts.telemetryPayload);

  if (input.tradingEnabled) {
    handlers.schedule(handlers.cancelAllQuotes(input.tick.instrumentCode, "HARD_STALE_DROP"));
  }
}

export async function applyHardStaleTickDropFlow(
  input: HardStaleTickDropFlowInput,
  handlers: HardStaleTickDropFlowHandlers
): Promise<TickIngestResult> {
  const hardStale = stateAfterHardStaleTickDrop({
    currentState: input.currentState,
    metrics: input.metrics,
    hardStaleDropMs: input.hardStaleDropMs
  });
  handlers.applyState(hardStale.state);

  if (hardStale.shouldResetLatencyBaseline) {
    handlers.resetLatencyBaseline(hardStale.metrics.brainTimestamp, "HARD_STALE_DROP");
  }

  await handlers.persistLatencySnapshot("HARD_STALE_TICK_DROPPED");

  const artifacts = buildHardStaleTickDropArtifacts({
    tick: input.tick,
    metrics: hardStale.metrics,
    streamId: input.streamId,
    hardStaleDropMs: input.hardStaleDropMs,
    nextStaleTickCount: hardStale.nextStaleTickCount
  });

  applyHardStaleTickDropSideEffects(
    {
      tick: input.tick,
      metrics: hardStale.metrics,
      artifacts,
      tradingEnabled: input.tradingEnabled
    },
    handlers
  );

  return artifacts.ingestResult;
}

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

export function recordProcessingLatencySample(
  samples: number[],
  processingLatencyMs: number,
  sampleWindow: number
): number {
  const rounded = roundLatency(processingLatencyMs);
  samples.push(rounded);

  if (samples.length > sampleWindow) {
    samples.splice(0, samples.length - sampleWindow);
  }

  return rounded;
}

export interface ExecutionProfileRuntimeInput {
  readonly previousProfile: ExecutionProfile | null | undefined;
  readonly processingLatencySamples: number[];
  readonly processingLatencyMs: number;
  readonly nextProcessedTicks: number;
  readonly jitterThresholdMs: number;
  readonly jitterSampleWindow: number;
  readonly jitterComputeIntervalTicks: number;
  readonly coldStartWakeupThresholdMs: number;
  readonly totalHotPathMs: number;
  readonly trace: ExecutionTraceInput;
}

export interface ExecutionProfileRuntimeResult {
  readonly profile: ExecutionProfile;
  readonly shouldCompute: boolean;
}

export interface ExecutionProfileSideEffectsInput {
  readonly engineId: string;
  readonly previousProfile: ExecutionProfile | null | undefined;
  readonly processingLatencySamples: number[];
  readonly processingLatencyMs: number;
  readonly nextProcessedTicks: number;
  readonly jitterThresholdMs: number;
  readonly jitterSampleWindow: number;
  readonly jitterComputeIntervalTicks: number;
  readonly coldStartWakeupThresholdMs: number;
  readonly totalHotPathMs: number;
  readonly trace: ExecutionTraceInput;
  readonly lastPerformanceStatus: EngineStabilityStatus | null;
}

export interface ExecutionProfileFlowInput {
  readonly engineId: string;
  readonly previousProfile: ExecutionProfile | null | undefined;
  readonly processedTicks: number;
  readonly processingLatencySamples: number[];
  readonly metrics: LatencyMetrics;
  readonly trace: ExecutionTraceInput;
  readonly jitterThresholdMs: number;
  readonly jitterSampleWindow: number;
  readonly jitterComputeIntervalTicks: number;
  readonly coldStartWakeupThresholdMs: number;
  readonly lastPerformanceStatus: EngineStabilityStatus | null;
  readonly nowMs?: number;
}

export interface ExecutionProfileSideEffectHandlers {
  readonly applyProfile: (profile: ExecutionProfile) => void;
  readonly markPerformanceStatus: (status: EngineStabilityStatus) => void;
  readonly logPerformanceSnapshot: (snapshot: PerformanceSnapshot) => void;
  readonly publishTransition: (transition: ExecutionPerformanceTransition) => void;
  readonly notify: (notification: NotifierEvent) => void;
}

export function nextExecutionProfile(
  input: ExecutionProfileRuntimeInput
): ExecutionProfileRuntimeResult {
  const previousProfile =
    input.previousProfile ??
    defaultExecutionProfile(
      input.jitterThresholdMs,
      input.jitterSampleWindow,
      input.jitterComputeIntervalTicks,
      input.processingLatencySamples.length
    );
  const shouldCompute =
    previousProfile.lastComputedAt === null ||
    input.nextProcessedTicks % input.jitterComputeIntervalTicks === 0;
  let profile: ExecutionProfile = {
    ...previousProfile,
    jitterThresholdMs: input.jitterThresholdMs,
    sampleWindow: input.jitterSampleWindow,
    computeIntervalTicks: input.jitterComputeIntervalTicks,
    sampleCount: input.processingLatencySamples.length,
    lastProcessingLatencyMs: input.processingLatencyMs,
    wakeUpTimeMs: input.trace.wakeUpTimeMs,
    coldStartSuspected:
      input.trace.wakeUpTimeMs !== null &&
      input.trace.wakeUpTimeMs > input.coldStartWakeupThresholdMs,
    orderBookUpdateMs: input.trace.orderBookUpdateMs,
    agentLogicMs: input.trace.agentLogicMs,
    totalHotPathMs: input.totalHotPathMs,
    updatedAt: input.trace.observedAt
  };

  if (shouldCompute) {
    const stats = processingLatencyStats(input.processingLatencySamples);
    const status: EngineStabilityStatus =
      stats.jitterMs > input.jitterThresholdMs ? "UNSTABLE" : "STABLE";

    profile = {
      ...profile,
      status,
      jitterMs: stats.jitterMs,
      averageProcessingLatencyMs: stats.averageMs,
      maxProcessingLatencyMs: stats.maxMs,
      lastComputedAt: input.trace.observedAt
    };
  }

  return { profile, shouldCompute };
}

export function applyExecutionProfileSideEffects(
  input: ExecutionProfileSideEffectsInput,
  handlers: ExecutionProfileSideEffectHandlers
): ExecutionProfileRuntimeResult {
  const result = nextExecutionProfile({
    previousProfile: input.previousProfile,
    processingLatencySamples: input.processingLatencySamples,
    processingLatencyMs: input.processingLatencyMs,
    nextProcessedTicks: input.nextProcessedTicks,
    jitterThresholdMs: input.jitterThresholdMs,
    jitterSampleWindow: input.jitterSampleWindow,
    jitterComputeIntervalTicks: input.jitterComputeIntervalTicks,
    coldStartWakeupThresholdMs: input.coldStartWakeupThresholdMs,
    totalHotPathMs: input.totalHotPathMs,
    trace: input.trace
  });

  handlers.applyProfile(result.profile);

  if (result.shouldCompute && result.profile.status !== input.lastPerformanceStatus) {
    handlers.markPerformanceStatus(result.profile.status);
    const snapshot = buildPerformanceSnapshot(
      input.engineId,
      result.profile,
      input.nextProcessedTicks,
      input.trace.observedAt
    );
    const transition = buildExecutionPerformanceTransition(snapshot);

    handlers.logPerformanceSnapshot(snapshot);
    handlers.publishTransition(transition);
    handlers.notify(transition.notification);
  }

  return result;
}

export function applyExecutionProfileFlow(
  input: ExecutionProfileFlowInput,
  handlers: ExecutionProfileSideEffectHandlers
): ExecutionProfileRuntimeResult {
  const processingLatencyMs = recordProcessingLatencySample(
    input.processingLatencySamples,
    input.metrics.processingLatencyMs,
    input.jitterSampleWindow
  );
  const nextProcessedTicks = input.processedTicks + 1;
  const currentHighResolutionMs = input.nowMs ?? highResolutionNow();
  const totalHotPathMs = roundLatency(
    Math.max(0, currentHighResolutionMs - input.trace.hotPathStartedAt)
  );

  return applyExecutionProfileSideEffects(
    {
      engineId: input.engineId,
      previousProfile: input.previousProfile,
      processingLatencySamples: input.processingLatencySamples,
      processingLatencyMs,
      nextProcessedTicks,
      jitterThresholdMs: input.jitterThresholdMs,
      jitterSampleWindow: input.jitterSampleWindow,
      jitterComputeIntervalTicks: input.jitterComputeIntervalTicks,
      coldStartWakeupThresholdMs: input.coldStartWakeupThresholdMs,
      totalHotPathMs,
      trace: input.trace,
      lastPerformanceStatus: input.lastPerformanceStatus
    },
    handlers
  );
}

export function buildPerformanceSnapshot(
  engineId: string,
  profile: ExecutionProfile,
  processedTicks: number,
  observedAt: string
): PerformanceSnapshot {
  return {
    engineId,
    status: profile.status,
    jitterMs: profile.jitterMs,
    jitterThresholdMs: profile.jitterThresholdMs,
    sampleCount: profile.sampleCount,
    sampleWindow: profile.sampleWindow,
    computeIntervalTicks: profile.computeIntervalTicks,
    averageProcessingLatencyMs: profile.averageProcessingLatencyMs,
    maxProcessingLatencyMs: profile.maxProcessingLatencyMs,
    lastProcessingLatencyMs: profile.lastProcessingLatencyMs,
    wakeUpTimeMs: profile.wakeUpTimeMs,
    coldStartSuspected: profile.coldStartSuspected,
    orderBookUpdateMs: profile.orderBookUpdateMs,
    agentLogicMs: profile.agentLogicMs,
    totalHotPathMs: profile.totalHotPathMs,
    processedTicks,
    observedAt
  };
}

export function buildExecutionPerformanceTransition(
  snapshot: PerformanceSnapshot
): ExecutionPerformanceTransition {
  const unstable = snapshot.status === "UNSTABLE";
  const telemetryPayload = {
    status: snapshot.status,
    jitterMs: snapshot.jitterMs,
    jitterThresholdMs: snapshot.jitterThresholdMs,
    sampleCount: snapshot.sampleCount,
    sampleWindow: snapshot.sampleWindow,
    processingLatencyMs: snapshot.lastProcessingLatencyMs,
    averageProcessingLatencyMs: snapshot.averageProcessingLatencyMs,
    maxProcessingLatencyMs: snapshot.maxProcessingLatencyMs,
    wakeUpTimeMs: snapshot.wakeUpTimeMs,
    orderBookUpdateMs: snapshot.orderBookUpdateMs,
    agentLogicMs: snapshot.agentLogicMs,
    totalHotPathMs: snapshot.totalHotPathMs,
    coldStartSuspected: snapshot.coldStartSuspected
  };

  return {
    telemetryType: unstable ? "ENGINE_PERFORMANCE_UNSTABLE" : "ENGINE_PERFORMANCE_STABLE",
    telemetryPayload,
    correlationId: `${snapshot.engineId}:${snapshot.processedTicks}`,
    notification: {
      priority: unstable ? "HIGH" : "LOW",
      title: unstable
        ? "Sovereign-Sigma execution jitter unstable"
        : "Sovereign-Sigma execution jitter recovered",
      message: unstable
        ? `Processing jitter ${snapshot.jitterMs}ms exceeded ${snapshot.jitterThresholdMs}ms threshold.`
        : `Processing jitter ${snapshot.jitterMs}ms returned below ${snapshot.jitterThresholdMs}ms threshold.`,
      dedupeKey: `performance:${snapshot.status}`,
      metadata: {
        engineId: snapshot.engineId,
        status: snapshot.status,
        jitterMs: snapshot.jitterMs,
        jitterThresholdMs: snapshot.jitterThresholdMs,
        averageProcessingLatencyMs: snapshot.averageProcessingLatencyMs,
        maxProcessingLatencyMs: snapshot.maxProcessingLatencyMs,
        sampleCount: snapshot.sampleCount,
        processedTicks: snapshot.processedTicks
      }
    }
  };
}

export interface PerformanceMetricsTextInput {
  readonly engineId: string;
  readonly profile: ExecutionProfile;
  readonly processedTicks: number;
  readonly toxicityScore: number;
}

export function buildPerformanceMetricsText(input: PerformanceMetricsTextInput): string {
  const labels = {
    engine_id: input.engineId,
    status: input.profile.status
  };
  const lines = [
    prometheusMetric(
      "sovereign_sigma_processing_latency_jitter_ms",
      "Standard deviation of processing latency over the configured rolling sample window.",
      "gauge",
      input.profile.jitterMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_processing_latency_average_ms",
      "Average processing latency over the configured rolling sample window.",
      "gauge",
      input.profile.averageProcessingLatencyMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_processing_latency_last_ms",
      "Most recent tick processing latency.",
      "gauge",
      input.profile.lastProcessingLatencyMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_processing_latency_max_ms",
      "Maximum processing latency in the configured rolling sample window.",
      "gauge",
      input.profile.maxProcessingLatencyMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_wakeup_time_ms",
      "Time spent awaiting Durable Object initialization before request logic.",
      "gauge",
      input.profile.wakeUpTimeMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_order_book_update_ms",
      "High-resolution duration of the latest order book update block.",
      "gauge",
      input.profile.orderBookUpdateMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_agent_logic_ms",
      "High-resolution duration of the latest agent logic block.",
      "gauge",
      input.profile.agentLogicMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_hot_path_ms",
      "High-resolution duration of the latest tick hot path.",
      "gauge",
      input.profile.totalHotPathMs,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_execution_unstable",
      "Execution stability flag; 1 when jitter exceeds threshold.",
      "gauge",
      input.profile.status === "UNSTABLE" ? 1 : 0,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_cold_start_suspected",
      "Cold-start or eviction suspicion flag based on Durable Object wake-up time.",
      "gauge",
      input.profile.coldStartSuspected ? 1 : 0,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_execution_profile_samples",
      "Number of processing latency samples currently retained.",
      "gauge",
      input.profile.sampleCount,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_processed_ticks_total",
      "Total market ticks processed by the engine.",
      "counter",
      input.processedTicks,
      labels
    ),
    prometheusMetric(
      "sovereign_sigma_toxicity_score",
      "Current VPIN toxicity score from the Profiler agent.",
      "gauge",
      input.toxicityScore,
      labels
    )
  ];

  return `${lines.join("\n")}\n`;
}
