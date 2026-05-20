import type { AgentSignal, ProfilerState } from "../../../types";

export interface ProfilerTelemetryEvent {
  readonly telemetryType: "PROFILER_ALERT" | "AM_VPIN_TELEMETRY";
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

export interface ProfilerQuoteCancelInput {
  readonly signal: AgentSignal;
  readonly profilerQuoteHalt: boolean;
  readonly shadowReplay: boolean;
  readonly tradingEnabled: boolean;
  readonly croupierHasQuote: boolean;
}

export interface ProfilerSignalSideEffectInput extends ProfilerQuoteCancelInput {
  readonly instrumentCode: string;
  readonly profilerState: ProfilerState;
  readonly latencyMs: number;
}

export interface ProfilerSignalSideEffectHandlers {
  readonly publishAlert: (signal: AgentSignal, profilerState: ProfilerState) => void;
  readonly acceptSignal: (signal: AgentSignal, latencyMs: number) => Promise<void>;
  readonly cancelQuotes: (instrumentCode: string, reason: "PROFILER_ALERT") => void;
}

export function shouldCancelQuotesForProfilerSignal(input: ProfilerQuoteCancelInput): boolean {
  const cascadeShield = input.signal.featureVector.signalType === "CASCADE_SHIELD";
  return (
    (input.profilerQuoteHalt || cascadeShield) &&
    !input.shadowReplay &&
    input.tradingEnabled &&
    (!input.croupierHasQuote || input.profilerQuoteHalt)
  );
}

export async function applyProfilerSignalSideEffects(
  input: ProfilerSignalSideEffectInput,
  handlers: ProfilerSignalSideEffectHandlers
): Promise<void> {
  handlers.publishAlert(input.signal, input.profilerState);
  await handlers.acceptSignal(input.signal, input.latencyMs);

  if (shouldCancelQuotesForProfilerSignal(input)) {
    handlers.cancelQuotes(input.instrumentCode, "PROFILER_ALERT");
  }
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
