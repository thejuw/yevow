import type { JsonRecord, TradeIntent } from "../../../types";

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

export interface ExecutionDispatchBlockLogger {
  info(eventType: string, message: string, telemetry?: JsonRecord): void;
  warn(eventType: string, message: string, telemetry?: JsonRecord): void;
}

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
