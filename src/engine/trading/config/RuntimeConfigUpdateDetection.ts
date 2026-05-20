import type { AdminConfigUpdate } from "../../../types";

export function hasRuntimeConfigUpdate(update: AdminConfigUpdate): boolean {
  return (
    update.mode !== undefined ||
    update.bankroll !== undefined ||
    update.risk !== undefined ||
    update.maxLatencyMs !== undefined ||
    update.MAX_LATENCY !== undefined ||
    update.performance !== undefined
  );
}
