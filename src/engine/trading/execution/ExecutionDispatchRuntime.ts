import { evaluateIntentDispatchGate } from "../../IntentGeneration";
import type { EngineState, JsonRecord, TradeIntent } from "../../../types";
import type { RateLimitPriority } from "../../../utils/RateLimiter";

export type ExecutionDispatchBlockReason =
  | "NO_EXECUTIONER"
  | "TRADING_DISABLED"
  | "MOLTWORKER_NOT_SELECTED"
  | "TAKER_SUPPRESSED";

export interface ExecutionDispatchGateInput {
  readonly intent: TradeIntent;
  readonly hasExecutioner: boolean;
  readonly tradingEnabled: boolean;
  readonly hedgeEnabled: boolean;
  readonly inventoryHedge: boolean;
  readonly instrumentSelected: boolean;
}

export interface ExecutionDispatchGateDecision {
  readonly allowed: boolean;
  readonly reason: ExecutionDispatchBlockReason | null;
}

export interface ExecutionDispatchBlockLogInput {
  readonly decision: ExecutionDispatchGateDecision;
  readonly intent: TradeIntent;
  readonly selectedInstruments: readonly string[];
}

export interface ExecutionDispatchBlockLogEvent {
  readonly level: "INFO" | "WARN";
  readonly eventType: string;
  readonly message: string;
  readonly metadata: JsonRecord;
}

export interface ExecutionDispatchRuntimeInput extends ExecutionDispatchGateInput {
  readonly selectedInstruments: readonly string[];
}

export interface ExecutionDispatchRuntimeDecision {
  readonly gate: ExecutionDispatchGateDecision;
  readonly blockLog: ExecutionDispatchBlockLogEvent | null;
}

export interface ExecutionDispatchFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface ExecutionDispatchLogger {
  error(eventType: string, message: string, telemetry?: JsonRecord): void;
}

export interface ExecutionDispatchBlockLogger {
  info(eventType: string, message: string, telemetry?: JsonRecord): void;
  warn(eventType: string, message: string, telemetry?: JsonRecord): void;
}

export interface DispatchTradeIntentInput {
  readonly executioner: ExecutionDispatchFetcher;
  readonly logger: ExecutionDispatchLogger;
  readonly intent: TradeIntent;
}

export interface TradeIntentDispatchReservation {
  readonly allowed: boolean;
  readonly waitMs: number;
}

export interface TradeIntentDispatchSideEffectHandlers {
  readonly logger: ExecutionDispatchBlockLogger;
  readonly reservePaperExecutionBudget: (intent: TradeIntent) => boolean;
  readonly wait: (ms: number) => Promise<void>;
  readonly reserveExecutionCapacity: (
    exchangeKey: string,
    priority: RateLimitPriority
  ) => TradeIntentDispatchReservation;
  readonly persistRateLimitState: () => void;
  readonly enqueueExecutionIntent: (
    intent: TradeIntent,
    priority: RateLimitPriority,
    waitMs: number
  ) => Promise<void>;
  readonly dispatchTradeIntent: (intent: TradeIntent) => Promise<void>;
}

export interface TradeIntentDispatchSideEffectsInput extends ExecutionDispatchRuntimeInput {
  readonly initialDelayMs: number;
}

export interface ExecutionPlanDispatchLogInput {
  readonly intent: TradeIntent;
  readonly sorSavings: number;
  readonly intendedSize: number;
  readonly camouflagedSize: number;
  readonly icebergChildCount: number;
  readonly timingJitterMs: number;
}

export interface ExecutionPlanDispatchBlockedLogInput {
  readonly intent: TradeIntent;
  readonly reason: string | null;
}

export interface ExecutionPlanDispatchRuntimePlan {
  readonly intent: TradeIntent;
  readonly sorPlan: {
    readonly sorSavings: number;
  };
  readonly camouflage: {
    readonly intendedSize: number;
    readonly camouflagedSize: number;
    readonly icebergChunks: readonly TradeIntent[];
    readonly timingJitterMs: number;
  };
}

export interface ExecutionPlanDispatchActionInput {
  readonly plan: ExecutionPlanDispatchRuntimePlan;
  readonly dispatchGate: {
    readonly allowed: boolean;
    readonly reason: string | null;
  };
  readonly shadowReplay: boolean;
  readonly tradingEnabled: boolean;
}

export interface ExecutionPlanDispatchLogger {
  info(eventType: string, message: string, telemetry?: JsonRecord): void;
  warn(eventType: string, message: string, telemetry?: JsonRecord): void;
}

export interface ExecutionPlanDispatchSideEffectHandlers {
  readonly logger: ExecutionPlanDispatchLogger;
  readonly schedule: (work: Promise<void>) => void;
  readonly dispatchExecution: (intent: TradeIntent, timingJitterMs: number) => Promise<void>;
}

export interface ExecutionPlanSideEffectsInput {
  readonly executionPlans: readonly ExecutionPlanDispatchRuntimePlan[];
  readonly riskState: Pick<EngineState, "mode" | "cachedConfig" | "citadel" | "quoteState">;
  readonly shadowReplay: boolean;
  readonly tradingEnabled: boolean;
  readonly handlers: ExecutionPlanDispatchSideEffectHandlers;
}

export type ExecutionPlanDispatchAction =
  | {
      readonly kind: "AUTHORIZED";
      readonly metadata: JsonRecord;
      readonly childIntents: readonly TradeIntent[];
      readonly timingJitterMs: number;
    }
  | {
      readonly kind: "BLOCKED";
      readonly metadata: JsonRecord;
    }
  | {
      readonly kind: "SHADOW";
      readonly metadata: JsonRecord;
    }
  | {
      readonly kind: "NONE";
    };

export function evaluateExecutionDispatchGate(
  input: ExecutionDispatchGateInput
): ExecutionDispatchGateDecision {
  if (!input.hasExecutioner) {
    return { allowed: false, reason: "NO_EXECUTIONER" };
  }

  if (!input.tradingEnabled && !(input.inventoryHedge && input.hedgeEnabled)) {
    return { allowed: false, reason: "TRADING_DISABLED" };
  }

  if (!input.inventoryHedge && !input.instrumentSelected) {
    return { allowed: false, reason: "MOLTWORKER_NOT_SELECTED" };
  }

  if ((input.intent.orderType !== "LIMIT" || !input.intent.postOnly) && !input.inventoryHedge) {
    return { allowed: false, reason: "TAKER_SUPPRESSED" };
  }

  return { allowed: true, reason: null };
}

export function buildExecutionDispatchBlockLog(
  input: ExecutionDispatchBlockLogInput
): ExecutionDispatchBlockLogEvent | null {
  if (input.decision.reason === "MOLTWORKER_NOT_SELECTED") {
    return {
      level: "INFO",
      eventType: "EXECUTION_DISPATCH_BLOCKED",
      message: "Skipped execution intent for inactive Moltworker asset",
      metadata: {
        intentId: input.intent.intentId,
        instrumentCode: input.intent.instrumentCode,
        action: input.intent.action,
        orderType: input.intent.orderType,
        selectedInstruments: [...input.selectedInstruments]
      }
    };
  }

  if (input.decision.reason === "TAKER_SUPPRESSED") {
    return {
      level: "WARN",
      eventType: "TAKER_EXECUTION_SUPPRESSED",
      message: "Non-post-only execution suppressed by passive inventory protocol",
      metadata: {
        intentId: input.intent.intentId,
        instrumentCode: input.intent.instrumentCode,
        orderType: input.intent.orderType,
        postOnly: input.intent.postOnly,
        timeInForce: input.intent.timeInForce,
        rationale: input.intent.rationale
      }
    };
  }

  return null;
}

export function buildExecutionDispatchRuntimeDecision(
  input: ExecutionDispatchRuntimeInput
): ExecutionDispatchRuntimeDecision {
  const gate = evaluateExecutionDispatchGate(input);
  return {
    gate,
    blockLog: buildExecutionDispatchBlockLog({
      decision: gate,
      intent: input.intent,
      selectedInstruments: input.selectedInstruments
    })
  };
}

export function emitExecutionDispatchBlockLog(
  logger: ExecutionDispatchBlockLogger,
  event: ExecutionDispatchBlockLogEvent
): void {
  if (event.level === "INFO") {
    logger.info(event.eventType, event.message, event.metadata);
    return;
  }

  logger.warn(event.eventType, event.message, event.metadata);
}

export async function dispatchTradeIntentSideEffects(
  input: TradeIntentDispatchSideEffectsInput,
  handlers: TradeIntentDispatchSideEffectHandlers
): Promise<ExecutionDispatchRuntimeDecision> {
  const dispatch = buildExecutionDispatchRuntimeDecision(input);

  if (dispatch.blockLog) {
    emitExecutionDispatchBlockLog(handlers.logger, dispatch.blockLog);
    return dispatch;
  }

  if (!dispatch.gate.allowed) {
    return dispatch;
  }

  if (!handlers.reservePaperExecutionBudget(input.intent)) {
    return dispatch;
  }

  if (input.initialDelayMs > 0) {
    await handlers.wait(input.initialDelayMs);
  }

  const priority: RateLimitPriority = "NEW";
  const reservation = handlers.reserveExecutionCapacity(
    input.intent.source_exchange ?? "default",
    priority
  );
  handlers.persistRateLimitState();

  if (!reservation.allowed) {
    await handlers.enqueueExecutionIntent(input.intent, priority, reservation.waitMs);
    return dispatch;
  }

  await handlers.dispatchTradeIntent(input.intent);
  return dispatch;
}

export function tradeIntentAuthorizedLogMetadata(input: ExecutionPlanDispatchLogInput): JsonRecord {
  return {
    intentId: input.intent.intentId,
    instrumentCode: input.intent.instrumentCode,
    expectedValue: input.intent.expectedValue,
    approvedSize: input.intent.approvedSize,
    sorSavings: input.sorSavings,
    intendedSize: input.intendedSize,
    camouflagedSize: input.camouflagedSize,
    icebergChildCount: input.icebergChildCount,
    timingJitterMs: input.timingJitterMs
  };
}

export function tradeIntentDispatchBlockedLogMetadata(
  input: ExecutionPlanDispatchBlockedLogInput
): JsonRecord {
  return {
    intentId: input.intent.intentId,
    instrumentCode: input.intent.instrumentCode,
    reason: input.reason
  };
}

export function shadowTradeIntentAuthorizedLogMetadata(
  input: Pick<ExecutionPlanDispatchLogInput, "intent" | "icebergChildCount">
): JsonRecord {
  return {
    intentId: input.intent.intentId,
    instrumentCode: input.intent.instrumentCode,
    expectedValue: input.intent.expectedValue,
    approvedSize: input.intent.approvedSize,
    icebergChildCount: input.icebergChildCount
  };
}

export function buildExecutionPlanDispatchAction(
  input: ExecutionPlanDispatchActionInput
): ExecutionPlanDispatchAction {
  if (!input.shadowReplay && input.dispatchGate.allowed) {
    return {
      kind: "AUTHORIZED",
      metadata: tradeIntentAuthorizedLogMetadata({
        intent: input.plan.intent,
        sorSavings: input.plan.sorPlan.sorSavings,
        intendedSize: input.plan.camouflage.intendedSize,
        camouflagedSize: input.plan.camouflage.camouflagedSize,
        icebergChildCount: input.plan.camouflage.icebergChunks.length,
        timingJitterMs: input.plan.camouflage.timingJitterMs
      }),
      childIntents: input.plan.camouflage.icebergChunks,
      timingJitterMs: input.plan.camouflage.timingJitterMs
    };
  }

  if (!input.shadowReplay && input.tradingEnabled) {
    return {
      kind: "BLOCKED",
      metadata: tradeIntentDispatchBlockedLogMetadata({
        intent: input.plan.intent,
        reason: input.dispatchGate.reason
      })
    };
  }

  if (input.shadowReplay) {
    return {
      kind: "SHADOW",
      metadata: shadowTradeIntentAuthorizedLogMetadata({
        intent: input.plan.intent,
        icebergChildCount: input.plan.camouflage.icebergChunks.length
      })
    };
  }

  return { kind: "NONE" };
}

export function dispatchExecutionPlanSideEffects(input: ExecutionPlanSideEffectsInput): void {
  for (const plan of input.executionPlans) {
    const dispatchGate = evaluateIntentDispatchGate(input.riskState, plan.intent);
    const dispatchAction = buildExecutionPlanDispatchAction({
      plan,
      dispatchGate,
      shadowReplay: input.shadowReplay,
      tradingEnabled: input.tradingEnabled
    });

    if (dispatchAction.kind === "AUTHORIZED") {
      input.handlers.logger.info(
        "TRADE_INTENT_AUTHORIZED",
        "PitBoss authorized executable intent",
        dispatchAction.metadata
      );
      for (const childIntent of dispatchAction.childIntents) {
        input.handlers.schedule(
          input.handlers.dispatchExecution(childIntent, dispatchAction.timingJitterMs)
        );
      }
      continue;
    }

    if (dispatchAction.kind === "BLOCKED") {
      input.handlers.logger.warn(
        "TRADE_INTENT_DISPATCH_BLOCKED",
        "Intent dispatch gate blocked execution",
        dispatchAction.metadata
      );
      continue;
    }

    if (dispatchAction.kind === "SHADOW") {
      input.handlers.logger.info(
        "SHADOW_TRADE_INTENT_AUTHORIZED",
        "Replay generated shadow trade intent",
        dispatchAction.metadata
      );
    }
  }
}

export async function dispatchTradeIntentToExecutioner(
  input: DispatchTradeIntentInput
): Promise<void> {
  try {
    await input.executioner.fetch(
      new Request("https://executioner.internal/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.intent)
      })
    );
  } catch (error) {
    input.logger.error("EXECUTION_DISPATCH_FAILED", "Failed to dispatch trade intent", {
      intentId: input.intent.intentId,
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
  }
}
