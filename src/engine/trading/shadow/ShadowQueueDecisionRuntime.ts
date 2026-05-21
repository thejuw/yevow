import type {
  AgentDecisionTrace,
  InventoryState,
  JsonRecord,
  ShadowQueueDecision,
  TradeIntent
} from "../../../types";
import {
  applyShadowQueueLatencyBreachSideEffects,
  emitShadowQueueNoEdgeDecisionSideEffects
} from "./ShadowQueueDecisionTelemetryRuntime";
import type {
  ShadowQueueLatencyBreachSideEffectHandlers,
  ShadowQueueNoEdgeSideEffectHandlers
} from "./ShadowQueueDecisionTelemetryRuntime";
import {
  buildShadowQueueTradeIntentFromDecision,
  type ShadowQueueIntentFromDecisionInput
} from "./ShadowQueueSizingRuntime";
export {
  applyShadowQueueLatencyBreachSideEffects,
  buildShadowQueueLatencyBreachTelemetry,
  buildShadowQueueNoEdgeTelemetry,
  emitShadowQueueNoEdgeDecisionSideEffects,
  enforceShadowQueueDecisionLatency,
  resolveShadowQueueNoEdgeLogInterval,
  shouldLogShadowQueueNoEdge,
  type ShadowQueueLatencyBreachSideEffectHandlers,
  type ShadowQueueLatencyBreachSideEffectInput,
  type ShadowQueueLatencyBreachTelemetry,
  type ShadowQueueLatencyBudgetResult,
  type ShadowQueueNoEdgeSideEffectHandlers,
  type ShadowQueueNoEdgeSideEffectInput,
  type ShadowQueueNoEdgeTelemetry,
  type ShadowQueueNoEdgeThrottleInput
} from "./ShadowQueueDecisionTelemetryRuntime";

export interface ShadowQueueDecisionTraceInput {
  readonly decision: ShadowQueueDecision;
  readonly intent: TradeIntent | null;
  readonly engineId: string;
  readonly quoteStateStatus: string;
  readonly inventory: InventoryState;
  readonly cachedConfigVersion: string;
  readonly observedAt: string;
}

export interface ShadowQueueDecisionActionInput {
  readonly decision: ShadowQueueDecision;
  readonly intent: TradeIntent | null;
  readonly tradingEnabled: boolean;
}

export interface ShadowQueueDecisionRuntimeInput extends ShadowQueueIntentFromDecisionInput {
  readonly quoteStateStatus: string;
  readonly cachedConfigVersion: string;
  readonly tradingEnabled: boolean;
}

export interface ShadowQueueDecisionRuntimeArtifacts {
  readonly decision: ShadowQueueDecision;
  readonly intent: TradeIntent | null;
  readonly trace: AgentDecisionTrace;
  readonly action: ShadowQueueDecisionAction;
}

export interface ShadowQueueDecisionFlowInput extends ShadowQueueDecisionRuntimeInput {
  readonly latencyBudgetMs: number;
  readonly lastLoggedAtByInstrument: Map<string, number>;
  readonly noEdgeNowMs: number;
  readonly noEdgeLogIntervalMs: number;
}

export interface ShadowQueueDecisionFlowHandlers
  extends
    ShadowQueueNoEdgeSideEffectHandlers,
    ShadowQueueLatencyBreachSideEffectHandlers,
    ShadowQueueDecisionActionSideEffectHandlers {
  readonly traceDecision: (trace: AgentDecisionTrace) => void;
}

export interface ShadowQueueDecisionAction {
  readonly publish: {
    readonly type:
      | "SHADOW_QUEUE_SIGNAL_SUPPRESSED"
      | "SHADOW_QUEUE_RED_LIGHT"
      | "SHADOW_QUEUE_GREEN_LIGHT";
    readonly payload: Record<string, unknown>;
    readonly correlationId: string;
  };
  readonly cancelReason: "SHADOW_QUEUE_RED_LIGHT" | null;
  readonly dispatchIntent: TradeIntent | null;
}

export interface ShadowQueueDecisionActionSideEffectInput {
  readonly action: ShadowQueueDecisionAction;
  readonly instrumentCode: string;
}

export interface ShadowQueueDecisionActionSideEffectHandlers {
  readonly publish: (type: string, payload: Record<string, unknown>, correlationId: string) => void;
  readonly schedule: (work: Promise<unknown>) => void;
  readonly cancelAllQuotes: (
    instrumentCode: string,
    reason: NonNullable<ShadowQueueDecisionAction["cancelReason"]>
  ) => Promise<unknown>;
  readonly dispatchExecution: (intent: TradeIntent) => Promise<unknown>;
}

export function buildShadowQueueDecisionTrace(
  input: ShadowQueueDecisionTraceInput
): AgentDecisionTrace {
  return {
    decisionId: input.decision.decisionId,
    signalId: input.decision.fillId,
    traceId: `${input.engineId}:shadow-queue:${input.decision.fillId}`,
    agentName: "PROFILER",
    targetAgent: "EXECUTIONER",
    instrumentCode: input.decision.instrumentCode,
    action: input.decision.action === "GREEN_LIGHT" ? "EXECUTE" : "SUPERVISOR_ACTION",
    confidence: Math.min(
      1,
      Math.max(
        0,
        Math.abs(input.decision.microDrift) / Math.max(input.decision.tickThreshold, 1e-12)
      )
    ),
    expectedValue: input.intent?.expectedValue ?? 0,
    maxSlippageBps: input.intent?.maxSlippageBps ?? 0,
    reasoning: input.decision.reason,
    featureVector: {
      schemaVersion: "shadow-queue.decision.v1",
      light: input.decision.action,
      originalSide: input.decision.originalSide,
      dispatchSide: input.decision.dispatchSide,
      p0MidPrice: input.decision.p0MidPrice,
      pnMidPrice: input.decision.pnMidPrice,
      microDrift: input.decision.microDrift,
      driftTrades: input.decision.driftTrades,
      tradeIntentId: input.decision.tradeIntentId
    },
    riskSnapshot: {
      quoteState: input.quoteStateStatus,
      inventory: input.inventory,
      cachedConfigVersion: input.cachedConfigVersion
    } as unknown as JsonRecord,
    rawSignal: input.decision as unknown as JsonRecord,
    latencyMs: input.decision.decisionLatencyMs,
    createdAt: input.observedAt
  };
}

export function buildShadowQueueDecisionAction(
  input: ShadowQueueDecisionActionInput
): ShadowQueueDecisionAction {
  if (!input.intent) {
    return {
      publish: {
        type: "SHADOW_QUEUE_SIGNAL_SUPPRESSED",
        payload: input.decision as unknown as Record<string, unknown>,
        correlationId: input.decision.decisionId
      },
      cancelReason: null,
      dispatchIntent: null
    };
  }

  const isRedLight = input.decision.action === "RED_LIGHT";

  return {
    publish: {
      type: isRedLight ? "SHADOW_QUEUE_RED_LIGHT" : "SHADOW_QUEUE_GREEN_LIGHT",
      payload: input.decision as unknown as Record<string, unknown>,
      correlationId: input.decision.decisionId
    },
    cancelReason: isRedLight && input.tradingEnabled ? "SHADOW_QUEUE_RED_LIGHT" : null,
    dispatchIntent: input.tradingEnabled ? input.intent : null
  };
}

export function applyShadowQueueDecisionActionSideEffects(
  input: ShadowQueueDecisionActionSideEffectInput,
  handlers: ShadowQueueDecisionActionSideEffectHandlers
): void {
  handlers.publish(
    input.action.publish.type,
    input.action.publish.payload,
    input.action.publish.correlationId
  );

  if (input.action.cancelReason) {
    handlers.schedule(handlers.cancelAllQuotes(input.instrumentCode, input.action.cancelReason));
  }

  if (input.action.dispatchIntent) {
    handlers.schedule(handlers.dispatchExecution(input.action.dispatchIntent));
  }
}

export function buildShadowQueueDecisionRuntimeArtifacts(
  input: ShadowQueueDecisionRuntimeInput
): ShadowQueueDecisionRuntimeArtifacts {
  const intent = buildShadowQueueTradeIntentFromDecision(input);
  const decision = {
    ...input.decision,
    tradeIntentId: intent?.intentId ?? null
  };

  return {
    decision,
    intent,
    trace: buildShadowQueueDecisionTrace({
      decision,
      intent,
      engineId: input.engineId,
      quoteStateStatus: input.quoteStateStatus,
      inventory: input.inventory,
      cachedConfigVersion: input.cachedConfigVersion,
      observedAt: input.observedAt
    }),
    action: buildShadowQueueDecisionAction({
      decision,
      intent,
      tradingEnabled: input.tradingEnabled
    })
  };
}

export function applyShadowQueueDecisionFlow(
  input: ShadowQueueDecisionFlowInput,
  handlers: ShadowQueueDecisionFlowHandlers
): ShadowQueueDecision {
  if (input.decision.action === "NO_EDGE" || input.decision.dispatchSide === null) {
    return emitShadowQueueNoEdgeDecisionSideEffects(
      {
        decision: input.decision,
        lastLoggedAtByInstrument: input.lastLoggedAtByInstrument,
        nowMs: input.noEdgeNowMs,
        intervalMs: input.noEdgeLogIntervalMs
      },
      handlers
    );
  }

  const suppressed = applyShadowQueueLatencyBreachSideEffects(
    {
      decision: input.decision,
      latencyBudgetMs: input.latencyBudgetMs
    },
    handlers
  );

  if (suppressed) {
    return suppressed;
  }

  const artifacts = buildShadowQueueDecisionRuntimeArtifacts(input);
  handlers.traceDecision(artifacts.trace);
  applyShadowQueueDecisionActionSideEffects(
    { action: artifacts.action, instrumentCode: input.book.instrumentCode },
    handlers
  );

  return artifacts.decision;
}
