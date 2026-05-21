import type { OrderBookResetRequest } from "../../../types";
import { normalizeSourceExchange } from "../helpers/NativeMarketIdentityRuntime";
import { maintenanceRecoveryInstruments } from "./EngineStateDefaults";

export interface AdminRecoveryRuntimePayload {
  readonly reason?: string;
  readonly resetInstruments?: string[] | string;
  readonly instrumentCode?: string;
  readonly source_exchange?: string;
  readonly clearCitadel?: boolean;
  readonly clearQuoteState?: boolean;
  readonly clearLatency?: boolean;
  readonly resetPaperPortfolio?: boolean;
  readonly clearShadowQueue?: boolean;
}

export interface AdminRecoveryPlan {
  readonly observedAt: string;
  readonly reason: string;
  readonly sourceExchange: string;
  readonly resetInstruments: readonly string[];
  readonly shouldClearLatency: boolean;
  readonly shouldClearShadowQueue: boolean;
  readonly shouldResetPaperPortfolio: boolean;
}

export interface AdminRecoveryOrderBookResetDispatcherInput {
  readonly resetInstruments: readonly string[];
  readonly reason: string;
  readonly sourceExchange: string;
  readonly observedAt: string;
  readonly resetOrderBook: (payload: Partial<OrderBookResetRequest>) => Promise<void>;
}

export interface AdminRecoveryPlanSideEffectHandlers {
  readonly resetOrderBook: (payload: Partial<OrderBookResetRequest>) => Promise<void>;
  readonly resetLatencyBaseline: (observedAt: string, reason: string) => void;
  readonly clearShadowQueue: () => void;
}

export async function dispatchAdminRecoveryOrderBookResets(
  input: AdminRecoveryOrderBookResetDispatcherInput
): Promise<void> {
  for (const instrumentCode of input.resetInstruments) {
    await input.resetOrderBook({
      source: "ADMIN",
      reason: input.reason,
      instrumentCode,
      source_exchange: input.sourceExchange,
      connectionId: null,
      blackoutDurationMs: null,
      recoveredAt: input.observedAt
    });
  }
}

export async function applyAdminRecoveryPlanSideEffects(
  plan: AdminRecoveryPlan,
  handlers: AdminRecoveryPlanSideEffectHandlers
): Promise<void> {
  await dispatchAdminRecoveryOrderBookResets({
    resetInstruments: plan.resetInstruments,
    reason: plan.reason,
    sourceExchange: plan.sourceExchange,
    observedAt: plan.observedAt,
    resetOrderBook: handlers.resetOrderBook
  });

  if (plan.shouldClearLatency) {
    handlers.resetLatencyBaseline(plan.observedAt, plan.reason);
  }

  if (plan.shouldClearShadowQueue) {
    handlers.clearShadowQueue();
  }
}

export function adminRecoveryPlan(
  payload: AdminRecoveryRuntimePayload,
  observedAt = new Date().toISOString()
): AdminRecoveryPlan {
  const reason =
    typeof payload.reason === "string" && payload.reason.length > 0
      ? payload.reason
      : "ADMIN_CONTROLLED_RECOVERY";
  const sourceExchange = payload.source_exchange
    ? normalizeSourceExchange(payload.source_exchange)
    : "hyperliquid";

  return {
    observedAt,
    reason,
    sourceExchange,
    resetInstruments: maintenanceRecoveryInstruments(payload),
    shouldClearLatency: payload.clearLatency !== false,
    shouldClearShadowQueue: payload.clearShadowQueue !== false,
    shouldResetPaperPortfolio: payload.resetPaperPortfolio === true
  };
}
