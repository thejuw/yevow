import type { AgentSignal } from "../../../types";

export type CascadeSignalOutcome = "TAKEN" | "SKIPPED" | "CLOSED";

export interface CascadeSignalTelemetry {
  readonly telemetryType: "CASCADE_SIGNAL";
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

export function buildCascadeSignalTelemetry(
  signal: AgentSignal,
  outcome: CascadeSignalOutcome
): CascadeSignalTelemetry {
  return {
    telemetryType: "CASCADE_SIGNAL",
    payload: {
      signalId: signal.signalId,
      traceId: signal.traceId,
      sourceAgent: signal.sourceAgent,
      targetAgent: signal.targetAgent,
      instrumentCode: signal.instrumentCode,
      action: signal.action,
      confidence: signal.confidence,
      expectedValue: signal.expectedValue,
      outcome,
      cascadeId: signal.featureVector.cascadeId ?? signal.riskContext.cascadeId ?? null,
      createdAt: signal.createdAt
    },
    correlationId: signal.signalId
  };
}
