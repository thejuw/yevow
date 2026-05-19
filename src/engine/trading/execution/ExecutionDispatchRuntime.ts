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
