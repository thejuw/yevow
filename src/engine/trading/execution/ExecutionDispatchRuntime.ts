import type { TradeIntent } from "../../../types";

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
