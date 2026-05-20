import { finiteMetric, nullableFiniteMetric } from "../helpers/RuntimeMetrics";
import type { ExecutionProfile } from "../../../types";

export function defaultExecutionProfile(
  jitterThresholdMs: number,
  sampleWindow: number,
  computeIntervalTicks: number,
  sampleCount: number
): ExecutionProfile {
  return {
    status: "STABLE",
    jitterMs: 0,
    jitterThresholdMs,
    sampleCount,
    sampleWindow,
    computeIntervalTicks,
    averageProcessingLatencyMs: null,
    maxProcessingLatencyMs: null,
    lastProcessingLatencyMs: null,
    wakeUpTimeMs: null,
    coldStartSuspected: false,
    orderBookUpdateMs: null,
    agentLogicMs: null,
    totalHotPathMs: null,
    lastComputedAt: null,
    updatedAt: null
  };
}

export function defaultAnomalyStatus() {
  return {
    status: "CLEAR" as const,
    priceZScore: null,
    volumeZScore: null,
    cancellationToExecutionRatio: 0,
    cancellationCount: 0,
    executionCount: 0,
    lastAnomaly: null,
    updatedAt: null
  };
}

export function normalizeExecutionProfile(
  profile: ExecutionProfile | undefined,
  jitterThresholdMs: number,
  sampleWindow: number,
  computeIntervalTicks: number,
  sampleCount: number,
  observedAt: string
): ExecutionProfile {
  const fallback = defaultExecutionProfile(
    jitterThresholdMs,
    sampleWindow,
    computeIntervalTicks,
    sampleCount
  );

  if (!profile) {
    return {
      ...fallback,
      updatedAt: observedAt
    };
  }

  return {
    ...fallback,
    ...profile,
    status: profile.status === "UNSTABLE" ? "UNSTABLE" : "STABLE",
    jitterMs: finiteMetric(profile.jitterMs, 0),
    jitterThresholdMs,
    sampleCount,
    sampleWindow,
    computeIntervalTicks,
    averageProcessingLatencyMs: nullableFiniteMetric(profile.averageProcessingLatencyMs),
    maxProcessingLatencyMs: nullableFiniteMetric(profile.maxProcessingLatencyMs),
    lastProcessingLatencyMs: nullableFiniteMetric(profile.lastProcessingLatencyMs),
    wakeUpTimeMs: nullableFiniteMetric(profile.wakeUpTimeMs),
    coldStartSuspected: profile.coldStartSuspected,
    orderBookUpdateMs: nullableFiniteMetric(profile.orderBookUpdateMs),
    agentLogicMs: nullableFiniteMetric(profile.agentLogicMs),
    totalHotPathMs: nullableFiniteMetric(profile.totalHotPathMs),
    lastComputedAt: typeof profile.lastComputedAt === "string" ? profile.lastComputedAt : null,
    updatedAt: observedAt
  };
}
