import type { CascadeAlertEventType } from "../../../strategy/cascade/OperationalSafeguards";
import { cascadeAlertPolicy } from "../../../strategy/cascade/OperationalSafeguards";
import type {
  AgentDecisionTrace,
  AgentName,
  AgentSignal,
  JsonRecord,
  TradeIntent
} from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";
import { recordAgentSignalInBuffers } from "./AgentSignalRuntime";
import type { CascadeAssetProfile } from "../../../strategy/cascade/AssetProfiles";
import type {
  CascadeOpenPosition,
  CascadePositionIntent,
  CascadeRecoverySignalRejection,
  CascadeRecoverySignal,
  PositionSizeDecision
} from "../../../strategy/cascade/types";

export type CascadeSignalOutcome = "TAKEN" | "SKIPPED" | "CLOSED";

export interface CascadeSignalTelemetry {
  readonly telemetryType: "CASCADE_SIGNAL";
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

export interface CascadeUiSignalSideEffectInput {
  readonly signals: AgentSignal[];
  readonly latestAgentSignals: Map<AgentName, AgentSignal>;
  readonly signal: AgentSignal;
  readonly outcome: CascadeSignalOutcome;
  readonly signalBufferLimit: number;
}

export interface CascadeUiSignalSideEffectHandlers {
  readonly schedule: (work: Promise<void>) => void;
  readonly persistSignal: (signal: AgentSignal) => Promise<void>;
  readonly publish: (
    telemetryType: CascadeSignalTelemetry["telemetryType"],
    payload: CascadeSignalTelemetry["payload"],
    correlationId: string
  ) => void;
}

export interface CascadeOperationalAlertTelemetry {
  readonly telemetryType: "CASCADE_ALERT";
  readonly payload: JsonRecord;
  readonly correlationId: string;
  readonly notification: NotifierEvent | null;
}

export interface CascadeEntrySignalInput {
  readonly signal: CascadeRecoverySignal;
  readonly intent: TradeIntent;
  readonly engineId: string;
  readonly position: CascadeOpenPosition;
  readonly assetProfile: CascadeAssetProfile;
  readonly sizeDecision: PositionSizeDecision;
  readonly observedAt: string;
}

export interface CascadeEntryDecisionTraceInput extends CascadeEntrySignalInput {
  readonly currentHeat: number;
}

export interface CascadeSignalRejectionInput {
  readonly rejection: CascadeRecoverySignalRejection;
  readonly engineId: string;
  readonly observedAt: string;
  readonly entryWindowMs: number;
}

export interface CascadeManualCloseMetadataInput {
  readonly position: CascadeOpenPosition;
  readonly actor: string;
  readonly reason: string;
  readonly markPrice: number;
  readonly observedAt: string;
}

export interface CascadeCloseOperationalAlert {
  readonly eventType: Extract<CascadeAlertEventType, "STOP_HIT" | "TIME_STOP_HIT">;
  readonly title: string;
  readonly message: string;
  readonly metadata: JsonRecord;
  readonly dedupeKey: string;
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

export function recordCascadeUiSignalSideEffects(
  input: CascadeUiSignalSideEffectInput,
  handlers: CascadeUiSignalSideEffectHandlers
): void {
  recordAgentSignalInBuffers({
    signals: input.signals,
    latestAgentSignals: input.latestAgentSignals,
    signal: input.signal,
    signalBufferLimit: input.signalBufferLimit
  });

  handlers.schedule(handlers.persistSignal(input.signal));
  const event = buildCascadeSignalTelemetry(input.signal, input.outcome);
  handlers.publish(event.telemetryType, event.payload, event.correlationId);
}

export function cascadeSignalRejectionLogMetadata(
  rejection: CascadeRecoverySignalRejection
): JsonRecord {
  return {
    cascadeId: rejection.cascadeId,
    instrumentCode: rejection.instrumentCode,
    reasons: rejection.reasons.join(",")
  };
}

export function cascadeSignalRejectionAgentSignal(input: CascadeSignalRejectionInput): AgentSignal {
  return {
    signalId: `cascade-reject-${input.rejection.cascadeId}-${Date.parse(input.observedAt)}`,
    traceId: `${input.engineId}:cascade-reject:${input.rejection.cascadeId}`,
    sourceAgent: "PIT_BOSS",
    targetAgent: "SYSTEM",
    instrumentCode: input.rejection.instrumentCode,
    action: "HOLD",
    confidence: 0,
    horizonMs: input.entryWindowMs,
    expectedValue: 0,
    maxSlippageBps: 0,
    rationale: `Cascade recovery skipped: ${input.rejection.reasons.join(", ")}`,
    featureVector: input.rejection.context,
    riskContext: {
      outcome: "SKIPPED",
      cascadeId: input.rejection.cascadeId,
      reasons: input.rejection.reasons
    },
    createdAt: input.observedAt
  };
}

export function cascadeSignalEmittedAlertMetadata(signal: CascadeRecoverySignal): JsonRecord {
  return {
    signalId: signal.signalId,
    cascadeId: signal.cascadeId,
    instrumentCode: signal.instrumentCode,
    direction: signal.direction,
    triggerType: signal.triggerType,
    confidence: signal.confidence,
    emittedAt: signal.emittedAt
  };
}

export function cascadeSizeRejectedLogMetadata(
  signal: CascadeRecoverySignal,
  sizeDecision: PositionSizeDecision
): JsonRecord {
  return {
    signalId: signal.signalId,
    instrumentCode: signal.instrumentCode,
    limitingFactor: sizeDecision.limitingFactor,
    reason: sizeDecision.reason
  };
}

export function cascadeHeatCapAlertMetadata(
  signal: CascadeRecoverySignal,
  sizeDecision: PositionSizeDecision,
  currentHeat: number,
  heatCapPct: number
): JsonRecord {
  return {
    signalId: signal.signalId,
    cascadeId: signal.cascadeId,
    instrumentCode: signal.instrumentCode,
    currentHeat,
    heatAfterPct: sizeDecision.heatAfterPct,
    heatCapPct,
    reason: sizeDecision.reason
  };
}

export function cascadeEntryAgentSignal(input: CascadeEntrySignalInput): AgentSignal {
  return {
    signalId: input.signal.signalId,
    traceId: `${input.engineId}:cascade:${input.signal.signalId}`,
    sourceAgent: "PIT_BOSS",
    targetAgent: "EXECUTIONER",
    instrumentCode: input.signal.instrumentCode,
    action: input.intent.action,
    confidence: input.signal.confidence,
    horizonMs: Math.max(0, Date.parse(input.signal.timeStopAt) - Date.parse(input.observedAt)),
    expectedValue: input.intent.expectedValue,
    maxSlippageBps: input.intent.maxSlippageBps,
    rationale: `Cascade recovery entry approved via ${input.signal.triggerType}`,
    featureVector: input.signal.context,
    riskContext: {
      outcome: "TAKEN",
      cascadeId: input.signal.cascadeId,
      positionId: input.position.positionId,
      assetProfile: input.assetProfile as unknown as JsonRecord,
      sizeDecision: input.sizeDecision as unknown as JsonRecord
    },
    createdAt: input.observedAt
  };
}

export function cascadeEntryDecisionTrace(
  input: CascadeEntryDecisionTraceInput
): AgentDecisionTrace {
  return {
    decisionId: `cascade-entry-${input.signal.signalId}`,
    signalId: input.signal.signalId,
    traceId: `${input.engineId}:cascade:${input.signal.signalId}`,
    agentName: "PIT_BOSS",
    targetAgent: "EXECUTIONER",
    instrumentCode: input.signal.instrumentCode,
    action: input.intent.action,
    confidence: input.signal.confidence,
    expectedValue: input.intent.expectedValue,
    maxSlippageBps: input.intent.maxSlippageBps,
    reasoning: `Cascade recovery entry approved. Heat ${input.currentHeat} -> ${input.sizeDecision.heatAfterPct}.`,
    featureVector: input.signal.context,
    riskSnapshot: {
      positionId: input.position.positionId,
      assetProfile: input.assetProfile as unknown as JsonRecord,
      sizeDecision: input.sizeDecision as unknown as JsonRecord
    },
    rawSignal: input.signal as unknown as JsonRecord,
    latencyMs: 0,
    createdAt: input.observedAt
  };
}

export function cascadePositionOpenedAlertMetadata(input: CascadeEntrySignalInput): JsonRecord {
  return {
    signalId: input.signal.signalId,
    cascadeId: input.signal.cascadeId,
    positionId: input.position.positionId,
    instrumentCode: input.position.instrumentCode,
    direction: input.position.direction,
    entryPrice: input.position.entryPrice,
    stopPrice: input.position.currentStopPrice,
    notionalUsd: input.sizeDecision.notionalUsd,
    riskPct: input.sizeDecision.riskPct,
    heatAfterPct: input.sizeDecision.heatAfterPct,
    observedAt: input.observedAt
  };
}

export function cascadeManualCloseLogMetadata(input: CascadeManualCloseMetadataInput): JsonRecord {
  return {
    positionId: input.position.positionId,
    actor: input.actor,
    reason: input.reason,
    instrumentCode: input.position.instrumentCode,
    markPrice: input.markPrice,
    remainingSize: input.position.remainingSize
  };
}

export function cascadeManualCloseTelemetryPayload(
  input: CascadeManualCloseMetadataInput
): JsonRecord {
  return {
    ...cascadeManualCloseLogMetadata(input),
    observedAt: input.observedAt
  };
}

export function cascadeCloseOperationalAlert(
  intent: CascadePositionIntent,
  observedAt: string
): CascadeCloseOperationalAlert | null {
  if (intent.closeReason !== "STOP_LOSS" && intent.closeReason !== "TIME_STOP") {
    return null;
  }

  const isStopLoss = intent.closeReason === "STOP_LOSS";
  return {
    eventType: isStopLoss ? "STOP_HIT" : "TIME_STOP_HIT",
    title: isStopLoss ? "Cascade stop hit" : "Cascade time stop hit",
    message: `${intent.instrumentCode} cascade position ${intent.positionId} triggered ${intent.closeReason}.`,
    metadata: {
      positionId: intent.positionId,
      signalId: intent.signalId,
      instrumentCode: intent.instrumentCode,
      closeReason: intent.closeReason,
      size: intent.size,
      referencePrice: intent.referencePrice,
      observedAt
    },
    dedupeKey: intent.positionId
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
