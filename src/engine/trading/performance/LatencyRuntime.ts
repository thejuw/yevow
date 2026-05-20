import type { PerformanceSnapshot } from "../../../Logger";
import { highResolutionNow, roundLatency } from "../helpers/RuntimeClock";
import { processingLatencyStats, prometheusMetric } from "../helpers/RuntimeMetrics";
import { defaultExecutionProfile } from "../state/EngineStateDefaults";
import type { EngineStabilityStatus, ExecutionProfile, LatencyMetrics } from "../../../types";
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
