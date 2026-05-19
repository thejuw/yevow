import type { CascadeAlertEventType } from "../../../strategy/cascade/OperationalSafeguards";
import { cascadeAlertPolicy } from "../../../strategy/cascade/OperationalSafeguards";
import type { AgentSignal, JsonRecord } from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";

export type CascadeSignalOutcome = "TAKEN" | "SKIPPED" | "CLOSED";

export interface CascadeSignalTelemetry {
  readonly telemetryType: "CASCADE_SIGNAL";
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

export interface CascadeOperationalAlertTelemetry {
  readonly telemetryType: "CASCADE_ALERT";
  readonly payload: JsonRecord;
  readonly correlationId: string;
  readonly notification: NotifierEvent | null;
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

export function buildCascadeOperationalAlertTelemetry(
  eventType: CascadeAlertEventType,
  title: string,
  message: string,
  metadata: JsonRecord,
  dedupeKey: string
): CascadeOperationalAlertTelemetry {
  const policy = cascadeAlertPolicy(eventType);
  const payload: JsonRecord = {
    eventType,
    priority: policy.priority,
    routes: policy.routes,
    externalDelivery: policy.externalDelivery,
    ...metadata
  };

  return {
    telemetryType: "CASCADE_ALERT",
    payload,
    correlationId: dedupeKey,
    notification: policy.externalDelivery
      ? {
          priority: policy.priority,
          title,
          message,
          dedupeKey: `cascade:${eventType}:${dedupeKey}`,
          metadata: payload
        }
      : null
  };
}
