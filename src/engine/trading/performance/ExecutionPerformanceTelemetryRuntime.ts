import type { PerformanceSnapshot } from "../../../Logger";
import type { ExecutionProfile } from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";

export interface ExecutionPerformanceTransition {
  readonly telemetryType: "ENGINE_PERFORMANCE_UNSTABLE" | "ENGINE_PERFORMANCE_STABLE";
  readonly telemetryPayload: Record<string, unknown>;
  readonly correlationId: string;
  readonly notification: NotifierEvent;
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
