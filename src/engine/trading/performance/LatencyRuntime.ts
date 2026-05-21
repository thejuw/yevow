import type { PerformanceSnapshot } from "../../../Logger";
import { highResolutionNow, roundLatency } from "../helpers/RuntimeClock";
import { processingLatencyStats } from "../helpers/RuntimeMetrics";
import { defaultExecutionProfile } from "../state/EngineStateDefaults";
import type { EngineStabilityStatus, ExecutionProfile, LatencyMetrics } from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";
import {
  buildExecutionPerformanceTransition,
  buildPerformanceSnapshot
} from "./ExecutionPerformanceTelemetryRuntime";
import type { ExecutionPerformanceTransition } from "./ExecutionPerformanceTelemetryRuntime";
export {
  buildExecutionPerformanceTransition,
  buildPerformanceSnapshot,
  type ExecutionPerformanceTransition
} from "./ExecutionPerformanceTelemetryRuntime";
export {
  buildPerformanceMetricsText,
  type PerformanceMetricsTextInput
} from "./PerformanceMetricsTextRuntime";

export interface ExecutionTraceInput {
  wakeUpTimeMs: number | null;
  orderBookUpdateMs: number | null;
  agentLogicMs: number | null;
  hotPathStartedAt: number;
  observedAt: string;
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
