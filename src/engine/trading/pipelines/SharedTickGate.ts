export interface TickGateInput {
  tradingEnabled: boolean;
  platformHealthHalted?: boolean;
  totalLatencyMs: number;
  maxLatencyMs: number;
  stale: boolean;
}

export interface TickGateDecision {
  ok: boolean;
  reason: "OK" | "TRADING_DISABLED" | "PLATFORM_HEALTH_HALTED" | "STALE_TICK" | "LATENCY_LIMIT";
}

export function evaluateSharedTickGate(input: TickGateInput): TickGateDecision {
  if (!input.tradingEnabled) {
    return { ok: false, reason: "TRADING_DISABLED" };
  }

  if (input.platformHealthHalted) {
    return { ok: false, reason: "PLATFORM_HEALTH_HALTED" };
  }

  if (input.stale) {
    return { ok: false, reason: "STALE_TICK" };
  }

  if (input.maxLatencyMs > 0 && input.totalLatencyMs > input.maxLatencyMs) {
    return { ok: false, reason: "LATENCY_LIMIT" };
  }

  return { ok: true, reason: "OK" };
}
