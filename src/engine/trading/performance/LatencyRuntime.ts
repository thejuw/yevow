import type { PerformanceSnapshot } from "../../../Logger";
import {
  aggregateQuoteState,
  defaultExecutionProfile,
  parseTimestampMs,
  processingLatencyStats,
  prometheusMetric,
  roundLatency,
  suspendAssetQuoteStates
} from "../../../TradingEngineRuntimeHelpers";
import type {
  EngineState,
  EngineStabilityStatus,
  ExecutionProfile,
  LatencyMetrics,
  MarketTick
} from "../../../types";

export interface ExecutionTraceInput {
  wakeUpTimeMs: number | null;
  orderBookUpdateMs: number | null;
  agentLogicMs: number | null;
  hotPathStartedAt: number;
  observedAt: string;
}

export interface TickLatencyInput {
  readonly tick: MarketTick;
  readonly brainTimestamp: string;
  readonly maxLatencyMs: number;
  readonly averageLatencyMs: number;
  readonly sampleCount: number;
  readonly location: EngineState["location"];
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
