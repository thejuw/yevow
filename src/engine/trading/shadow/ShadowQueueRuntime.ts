import type {
  InternalOrderBook,
  MarketTick,
  ShadowQueueState,
  ShadowQueueDecision
} from "../../../types";
import { isTradeTick } from "../state/TickClassification";
import type { GhostBookObservation } from "../../../utils/GhostBook";

export {
  buildShadowQueueTradeIntent,
  buildShadowQueueTradeIntentFromDecision,
  resolveShadowQueueSizingConfig,
  shadowQueueKellySize,
  shadowQueuePostOnlyPrice,
  type ShadowQueueIntentFromDecisionInput,
  type ShadowQueueIntentInput,
  type ShadowQueueSizingInput
} from "./ShadowQueueSizingRuntime";
export {
  buildShadowQueueGhostFillRecord,
  buildShadowQueueGhostFillRuntimeRecord,
  emitShadowQueueGhostFillSideEffects,
  resolveShadowQueueGhostFillConfig,
  type ShadowQueueGhostFillConfig,
  type ShadowQueueGhostFillConfigInput,
  type ShadowQueueGhostFillRecord,
  type ShadowQueueGhostFillRecordInput,
  type ShadowQueueGhostFillRuntimeInput,
  type ShadowQueueGhostFillSideEffectHandlers
} from "./ShadowQueueGhostFillRuntime";
export {
  applyShadowQueueDecisionActionSideEffects,
  applyShadowQueueDecisionFlow,
  applyShadowQueueLatencyBreachSideEffects,
  buildShadowQueueDecisionAction,
  buildShadowQueueDecisionRuntimeArtifacts,
  buildShadowQueueDecisionTrace,
  buildShadowQueueLatencyBreachTelemetry,
  buildShadowQueueNoEdgeTelemetry,
  emitShadowQueueNoEdgeDecisionSideEffects,
  enforceShadowQueueDecisionLatency,
  resolveShadowQueueNoEdgeLogInterval,
  shouldLogShadowQueueNoEdge,
  type ShadowQueueDecisionAction,
  type ShadowQueueDecisionActionInput,
  type ShadowQueueDecisionActionSideEffectHandlers,
  type ShadowQueueDecisionActionSideEffectInput,
  type ShadowQueueDecisionFlowHandlers,
  type ShadowQueueDecisionFlowInput,
  type ShadowQueueDecisionRuntimeArtifacts,
  type ShadowQueueDecisionRuntimeInput,
  type ShadowQueueDecisionTraceInput,
  type ShadowQueueLatencyBreachSideEffectHandlers,
  type ShadowQueueLatencyBreachSideEffectInput,
  type ShadowQueueLatencyBreachTelemetry,
  type ShadowQueueLatencyBudgetResult,
  type ShadowQueueNoEdgeSideEffectHandlers,
  type ShadowQueueNoEdgeSideEffectInput,
  type ShadowQueueNoEdgeTelemetry,
  type ShadowQueueNoEdgeThrottleInput
} from "./ShadowQueueDecisionRuntime";

export interface ShadowQueueTickGateInput {
  readonly book: InternalOrderBook;
  readonly shadowReplay?: boolean;
}

export interface ShadowQueueTickRuntimeInput {
  readonly tick: MarketTick;
  readonly book: InternalOrderBook;
  readonly observedAt: string;
  readonly shadowReplay?: boolean;
}

export interface ShadowQueueTickRuntimeHandlers {
  readonly snapshot: (observedAt: string) => ShadowQueueState;
  readonly observeTrade: (
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string
  ) => GhostBookObservation;
  readonly recordGhostFill: (
    fill: GhostBookObservation["fills"][number],
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string
  ) => void;
  readonly handleDecision: (
    decision: ShadowQueueDecision,
    book: InternalOrderBook,
    observedAt: string
  ) => ShadowQueueDecision;
  readonly recordDecision: (decision: ShadowQueueDecision) => void;
  readonly injectBbo: (book: InternalOrderBook, observedAt: string) => void;
}

export function shouldProcessShadowQueueTick(input: ShadowQueueTickGateInput): boolean {
  return (
    !input.shadowReplay &&
    input.book.isSynced &&
    input.book.midPrice !== null &&
    input.book.midPrice > 0
  );
}

export function processShadowQueueTickRuntime(
  input: ShadowQueueTickRuntimeInput,
  handlers: ShadowQueueTickRuntimeHandlers
): ShadowQueueState {
  if (!shouldProcessShadowQueueTick(input)) {
    return handlers.snapshot(input.observedAt);
  }

  let observation: GhostBookObservation | null = null;

  if (isTradeTick(input.tick)) {
    observation = handlers.observeTrade(input.tick, input.book, input.observedAt);

    for (const fill of observation.fills) {
      handlers.recordGhostFill(fill, input.tick, input.book, input.observedAt);
    }

    for (const decision of observation.decisions) {
      const updatedDecision = handlers.handleDecision(decision, input.book, input.observedAt);
      handlers.recordDecision(updatedDecision);
    }
  }

  handlers.injectBbo(input.book, input.observedAt);
  const snapshot = handlers.snapshot(input.observedAt);

  return observation?.decisions.length
    ? {
        ...snapshot,
        lastDecision: handlers.snapshot(input.observedAt).lastDecision
      }
    : snapshot;
}
