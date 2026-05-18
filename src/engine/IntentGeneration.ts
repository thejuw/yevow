import type { EngineState, TradeIntent } from "../types";

export interface IntentDispatchGate {
  allowed: boolean;
  reason: string;
}

export function evaluateIntentDispatchGate(
  state: Pick<EngineState, "mode" | "cachedConfig" | "citadel" | "quoteState">,
  intent: TradeIntent
): IntentDispatchGate {
  if (state.mode === "HALTED") {
    return { allowed: false, reason: "ENGINE_HALTED" };
  }

  if (!state.cachedConfig.TRADING_ENABLED) {
    return { allowed: false, reason: "TRADING_DISABLED" };
  }

  if (state.citadel.status === "CRITICAL") {
    return { allowed: false, reason: "CITADEL_CRITICAL" };
  }

  if (state.quoteState.status === "SUSPENDED") {
    return { allowed: false, reason: state.quoteState.reason ?? "QUOTE_SUSPENDED" };
  }

  if (intent.orderType !== "LIMIT" || !intent.postOnly) {
    return { allowed: false, reason: "PASSIVE_ONLY_PROTOCOL" };
  }

  return { allowed: true, reason: "DISPATCH_ALLOWED" };
}
