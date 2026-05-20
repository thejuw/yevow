import type { PerformanceSnapshot } from "../../../Logger";
import { parseTimestampMs, roundLatency } from "../helpers/RuntimeClock";
import { processingLatencyStats, prometheusMetric } from "../helpers/RuntimeMetrics";
import { readPositiveNumber } from "../helpers/RuntimeParsing";
import { aggregateQuoteState, suspendAssetQuoteStates } from "../state/AssetStateRuntime";
import { defaultExecutionProfile } from "../state/EngineStateDefaults";
import { extractTickStreamId } from "../state/TickClassification";
import {
  DEFAULT_DWELLIR_NATIVE_HL_MAX_LATENCY_MS,
  DEFAULT_NATIVE_HL_MAX_LATENCY_MS
} from "../../../TradingEngineConstants";
import type {
  EngineState,
  EngineStabilityStatus,
  ExecutionProfile,
  JsonRecord,
  LatencyMetrics,
  MarketTransport,
  MarketTick
} from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";

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

export interface TickLatencyInput {
  readonly tick: MarketTick;
  readonly brainTimestamp: string;
  readonly maxLatencyMs: number;
  readonly averageLatencyMs: number;
  readonly sampleCount: number;
  readonly location: EngineState["location"];
}

export interface TickLatencyPreparationInput extends TickLatencyInput {
  readonly tick: MarketTick;
  readonly shadowReplay: boolean;
  readonly dwellirMaxLatencyMs?: string;
  readonly hlStaleAfterMs?: string;
  readonly currentMaxLatencyMs: number;
}

export interface TickLatencyPreparationResult {
  readonly metrics: LatencyMetrics;
  readonly streamId: string | null;
  readonly hardStaleDropMs: number;
  readonly isHardStale: boolean;
  readonly shouldResetLatencyBaseline: boolean;
  readonly shouldUpdateLatencyAverage: boolean;
}

export interface NativeHyperliquidMaxLatencyInput {
  readonly transport?: MarketTransport;
  readonly streamId?: string | null;
  readonly dwellirMaxLatencyMs?: string;
  readonly hlStaleAfterMs?: string;
  readonly currentMaxLatencyMs: number;
}

export function resolveNativeHyperliquidMaxLatencyMs(
  input: NativeHyperliquidMaxLatencyInput
): number {
  const streamKey = input.streamId?.toLowerCase() ?? "";

  if (input.transport === "grpc" || streamKey.startsWith("dwellir-")) {
    return readPositiveNumber(
      input.dwellirMaxLatencyMs ?? input.hlStaleAfterMs,
      DEFAULT_DWELLIR_NATIVE_HL_MAX_LATENCY_MS
    );
  }

  return readPositiveNumber(
    input.hlStaleAfterMs,
    Math.min(input.currentMaxLatencyMs, DEFAULT_NATIVE_HL_MAX_LATENCY_MS)
  );
}

export function calculateTickLatency(input: TickLatencyInput): LatencyMetrics {
  const sourceTimestamp =
    input.tick.synchronizedExchangeTimestamp ??
    input.tick.providerTimestamp ??
    input.tick.exchangeTimestamp;
  const providerTimestamp = input.tick.providerTimestamp ?? sourceTimestamp;
  const sourceTime = parseTimestampMs(sourceTimestamp, "source_timestamp");
  const rawIngestTime = parseTimestampMs(input.tick.receivedAt, "ingest_timestamp");
  const brainTime = parseTimestampMs(input.brainTimestamp, "brain_timestamp");
  const ingestClockSkewMs = Math.max(0, rawIngestTime - brainTime);
  const ingestTime = ingestClockSkewMs > 0 ? brainTime : rawIngestTime;
  const ingestTimestamp = ingestClockSkewMs > 0 ? input.brainTimestamp : input.tick.receivedAt;
  const networkLatencyMs = Math.max(0, ingestTime - sourceTime);
  const processingLatencyMs = Math.max(0, brainTime - ingestTime);

  return {
    instrumentCode: input.tick.instrumentCode,
    exchangeCode: input.tick.exchangeCode,
    source: input.tick.source,
    sourceExchange: input.tick.source_exchange,
    sourceWeight: input.tick.sourceWeight,
    sequence: input.tick.sequence,
    providerTimestamp,
    sourceTimestamp,
    ingestTimestamp,
    brainTimestamp: input.brainTimestamp,
    clockOffsetMs: input.tick.clockOffsetMs + ingestClockSkewMs,
    networkLatencyMs,
    processingLatencyMs,
    totalLatencyMs: networkLatencyMs + processingLatencyMs,
    maxLatencyMs: input.maxLatencyMs,
    averageLatencyMs: input.averageLatencyMs,
    sampleCount: input.sampleCount,
    status: "FRESH",
    colo: input.location.colo,
    placement: input.location.placement,
    latencyRiskMultiplier: input.location.latencyRiskMultiplier,
    positionSizeMultiplier: input.location.positionSizeMultiplier
  };
}

export function prepareTickLatencyRuntime(
  input: TickLatencyPreparationInput
): TickLatencyPreparationResult {
  const metrics = calculateTickLatency(input);
  const streamId = extractTickStreamId(input.tick);
  const hardStaleDropMs = resolveNativeHyperliquidMaxLatencyMs({
    transport: input.tick.transport,
    streamId,
    dwellirMaxLatencyMs: input.dwellirMaxLatencyMs,
    hlStaleAfterMs: input.hlStaleAfterMs,
    currentMaxLatencyMs: input.currentMaxLatencyMs
  });
  const isHardStale = !input.shadowReplay && metrics.totalLatencyMs > hardStaleDropMs;

  if (isHardStale) {
    return {
      metrics,
      streamId,
      hardStaleDropMs,
      isHardStale,
      shouldResetLatencyBaseline: false,
      shouldUpdateLatencyAverage: false
    };
  }

  const nextMetrics: LatencyMetrics = {
    ...metrics,
    maxLatencyMs: input.currentMaxLatencyMs,
    status:
      !input.shadowReplay && metrics.totalLatencyMs > input.currentMaxLatencyMs ? "STALE" : "FRESH"
  };

  return {
    metrics: nextMetrics,
    streamId,
    hardStaleDropMs,
    isHardStale,
    shouldResetLatencyBaseline:
      !input.shadowReplay &&
      input.averageLatencyMs > hardStaleDropMs &&
      metrics.totalLatencyMs <= hardStaleDropMs,
    shouldUpdateLatencyAverage: nextMetrics.status === "FRESH"
  };
}

export interface LatencyAverageState {
  readonly averageLatency: number;
  readonly latencySampleCount: number;
}

export function nextLatencyAverage(
  previous: LatencyAverageState,
  totalLatencyMs: number
): LatencyAverageState {
  const latencySampleCount = previous.latencySampleCount + 1;
  const nextMean =
    previous.averageLatency + (totalLatencyMs - previous.averageLatency) / latencySampleCount;

  return {
    averageLatency: roundLatency(nextMean),
    latencySampleCount
  };
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

export interface PerformanceSpikeLogGateInput {
  readonly logAt: Map<string, number>;
  readonly latencyMetrics: LatencyMetrics;
  readonly throttleMs: number;
  readonly nowMs?: number;
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
