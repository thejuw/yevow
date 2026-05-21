import type { JsonRecord, ShadowQueueDecision } from "../../../types";
import { DEFAULT_SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS } from "../../../TradingEngineConstants";
import { readPositiveInteger } from "../helpers/RuntimeParsing";

export interface ShadowQueueNoEdgeThrottleInput {
  readonly lastLoggedAtByInstrument: Map<string, number>;
  readonly instrumentCode: string;
  readonly nowMs: number;
  readonly intervalMs: number;
}

export interface ShadowQueueNoEdgeSideEffectInput {
  readonly decision: ShadowQueueDecision;
  readonly lastLoggedAtByInstrument: Map<string, number>;
  readonly nowMs: number;
  readonly intervalMs: number;
}

export interface ShadowQueueNoEdgeSideEffectHandlers {
  readonly logInfo: (eventType: string, message: string, metadata: JsonRecord) => void;
  readonly publish: (type: string, payload: Record<string, unknown>, correlationId: string) => void;
}

export interface ShadowQueueLatencyBudgetResult {
  readonly breached: boolean;
  readonly decision: ShadowQueueDecision;
}

export interface ShadowQueueLatencyBreachSideEffectInput {
  readonly decision: ShadowQueueDecision;
  readonly latencyBudgetMs: number;
}

export interface ShadowQueueLatencyBreachSideEffectHandlers {
  readonly warn: (eventType: string, message: string, metadata: JsonRecord) => void;
  readonly publish: (type: string, payload: Record<string, unknown>, correlationId: string) => void;
}

export interface ShadowQueueNoEdgeTelemetry {
  readonly eventType: "SHADOW_QUEUE_NO_EDGE";
  readonly message: string;
  readonly metadata: JsonRecord;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

export interface ShadowQueueLatencyBreachTelemetry {
  readonly eventType: "SHADOW_QUEUE_LATENCY_BREACH";
  readonly message: string;
  readonly metadata: JsonRecord;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

export function resolveShadowQueueNoEdgeLogInterval(envValue?: string): number {
  return readPositiveInteger(
    envValue,
    DEFAULT_SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS,
    1_000,
    300_000
  );
}

export function shouldLogShadowQueueNoEdge(input: ShadowQueueNoEdgeThrottleInput): boolean {
  const previous = input.lastLoggedAtByInstrument.get(input.instrumentCode) ?? 0;

  if (input.nowMs - previous < input.intervalMs) {
    return false;
  }

  input.lastLoggedAtByInstrument.set(input.instrumentCode, input.nowMs);
  return true;
}

export function enforceShadowQueueDecisionLatency(
  decision: ShadowQueueDecision,
  latencyBudgetMs: number
): ShadowQueueLatencyBudgetResult {
  if (decision.decisionLatencyMs <= latencyBudgetMs) {
    return { breached: false, decision };
  }

  return {
    breached: true,
    decision: {
      ...decision,
      tradeIntentId: null,
      reason: `${decision.reason} Suppressed because drift decision latency exceeded ${latencyBudgetMs}ms.`
    }
  };
}

export function buildShadowQueueNoEdgeTelemetry(
  decision: ShadowQueueDecision
): ShadowQueueNoEdgeTelemetry {
  return {
    eventType: "SHADOW_QUEUE_NO_EDGE",
    message: "Virtual fill drift stayed inside one tick",
    metadata: {
      decisionId: decision.decisionId,
      fillId: decision.fillId,
      instrumentCode: decision.instrumentCode,
      microDrift: decision.microDrift,
      tickThreshold: decision.tickThreshold,
      driftTrades: decision.driftTrades,
      sampled: true
    },
    payload: decision as unknown as Record<string, unknown>,
    correlationId: decision.decisionId
  };
}

export function emitShadowQueueNoEdgeDecisionSideEffects(
  input: ShadowQueueNoEdgeSideEffectInput,
  handlers: ShadowQueueNoEdgeSideEffectHandlers
): ShadowQueueDecision {
  const telemetry = buildShadowQueueNoEdgeTelemetry(input.decision);

  if (
    shouldLogShadowQueueNoEdge({
      lastLoggedAtByInstrument: input.lastLoggedAtByInstrument,
      instrumentCode: input.decision.instrumentCode,
      nowMs: input.nowMs,
      intervalMs: input.intervalMs
    })
  ) {
    handlers.logInfo(telemetry.eventType, telemetry.message, telemetry.metadata);
  }

  handlers.publish(telemetry.eventType, telemetry.payload, telemetry.correlationId);
  return input.decision;
}

export function buildShadowQueueLatencyBreachTelemetry(input: {
  readonly originalDecision: ShadowQueueDecision;
  readonly suppressedDecision: ShadowQueueDecision;
  readonly latencyBudgetMs: number;
}): ShadowQueueLatencyBreachTelemetry {
  return {
    eventType: "SHADOW_QUEUE_LATENCY_BREACH",
    message: "VLO matrix decision exceeded 5ms envelope",
    metadata: {
      decisionId: input.originalDecision.decisionId,
      instrumentCode: input.originalDecision.instrumentCode,
      decisionLatencyMs: input.originalDecision.decisionLatencyMs,
      latencyBudgetMs: input.latencyBudgetMs
    },
    payload: input.suppressedDecision as unknown as Record<string, unknown>,
    correlationId: input.originalDecision.decisionId
  };
}

export function applyShadowQueueLatencyBreachSideEffects(
  input: ShadowQueueLatencyBreachSideEffectInput,
  handlers: ShadowQueueLatencyBreachSideEffectHandlers
): ShadowQueueDecision | null {
  const latencyDecision = enforceShadowQueueDecisionLatency(input.decision, input.latencyBudgetMs);

  if (!latencyDecision.breached) {
    return null;
  }

  const suppressed = latencyDecision.decision;
  const telemetry = buildShadowQueueLatencyBreachTelemetry({
    originalDecision: input.decision,
    suppressedDecision: suppressed,
    latencyBudgetMs: input.latencyBudgetMs
  });

  handlers.warn(telemetry.eventType, telemetry.message, telemetry.metadata);
  handlers.publish(telemetry.eventType, telemetry.payload, telemetry.correlationId);

  return suppressed;
}
