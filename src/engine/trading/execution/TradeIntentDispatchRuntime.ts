import type { JsonRecord, TradeIntent } from "../../../types";
import type { RateLimitPriority } from "../../../utils/RateLimiter";
import {
  buildExecutionDispatchRuntimeDecision,
  emitExecutionDispatchBlockLog,
  type ExecutionDispatchBlockLogger,
  type ExecutionDispatchRuntimeDecision,
  type ExecutionDispatchRuntimeInput
} from "./ExecutionDispatchGateRuntime";

export interface ExecutionDispatchFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface ExecutionDispatchLogger {
  error(eventType: string, message: string, telemetry?: JsonRecord): void;
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
