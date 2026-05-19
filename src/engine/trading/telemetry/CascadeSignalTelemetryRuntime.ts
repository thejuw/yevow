import type { CascadeAlertEventType } from "../../../strategy/cascade/OperationalSafeguards";
import { cascadeAlertPolicy } from "../../../strategy/cascade/OperationalSafeguards";
import type { AgentDecisionTrace, AgentSignal, JsonRecord, TradeIntent } from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";
import type { CascadeAssetProfile } from "../../../strategy/cascade/AssetProfiles";
import type {
  CascadeOpenPosition,
  CascadeRecoverySignal,
  PositionSizeDecision
} from "../../../strategy/cascade/types";

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
