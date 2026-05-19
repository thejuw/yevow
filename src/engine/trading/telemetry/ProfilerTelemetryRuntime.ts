import type { AgentSignal, ProfilerState } from "../../../types";

export interface ProfilerTelemetryEvent {
  readonly telemetryType: "PROFILER_ALERT" | "AM_VPIN_TELEMETRY";
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

export function buildProfilerAlertTelemetry(
  signal: AgentSignal,
  profilerState: ProfilerState
): ProfilerTelemetryEvent {
  return {
    telemetryType: "PROFILER_ALERT",
    payload: {
      signalId: signal.signalId,
      traceId: signal.traceId,
      instrumentCode: signal.instrumentCode,
      toxicityScore: profilerState.toxicityScore,
      amVpin: profilerState.amVpinScore,
      obi: profilerState.obi,
      obiDepth: profilerState.obiDepth,
      toxicityState: profilerState.toxicityState,
      pressureSide: profilerState.pressureSide,
      spreadMultiplier: profilerState.spreadMultiplier,
      reservationShiftBps: profilerState.reservationShiftBps,
      quoteHaltUntil: profilerState.quoteHaltUntil,
      alertThreshold: profilerState.alertThreshold,
      bucketSize: profilerState.bucketSize,
      rollingWindow: profilerState.rollingWindow,
      completedBuckets: profilerState.buckets.length,
      totalBucketsClosed: profilerState.totalBucketsClosed,
      action: signal.action,
      targetAgent: signal.targetAgent,
      suggestedSpreadWidenBps: signal.maxSlippageBps,
      rationale: signal.rationale,
      featureVector: signal.featureVector,
      riskContext: signal.riskContext
    },
    correlationId: signal.signalId
  };
}

export function buildAmVpinTelemetry(
  profilerState: ProfilerState,
  instrumentCode: string,
  observedAt: string
): ProfilerTelemetryEvent {
  return {
    telemetryType: "AM_VPIN_TELEMETRY",
    payload: {
      instrumentCode,
      observedAt,
      am_vpin: profilerState.amVpinScore,
      obi: profilerState.obi,
      obiDepth: profilerState.obiDepth,
      toxicity_state: profilerState.toxicityState,
      pressureSide: profilerState.pressureSide,
      spreadMultiplier: profilerState.spreadMultiplier,
      reservationShiftBps: profilerState.reservationShiftBps,
      quoteHaltUntil: profilerState.quoteHaltUntil,
      latestSignedImbalance: profilerState.latestSignedImbalance,
      latestDirectionalImbalance: profilerState.latestDirectionalImbalance,
      directionalDecay: profilerState.directionalDecay,
      bucketSize: profilerState.bucketSize,
      rollingWindow: profilerState.rollingWindow,
      completedBuckets: profilerState.amVpinBucketCompletions,
      amVpinMean: profilerState.amVpinMean,
      amVpinVariance: profilerState.amVpinVariance
    },
    correlationId: `am-vpin:${instrumentCode}:${profilerState.amVpinBucketCompletions}`
  };
}
