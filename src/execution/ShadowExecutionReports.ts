import type { Env, ExecutionReport, TradeIntent } from "../types";

export function estimateShadowFees(env: Env, intent: TradeIntent): number {
  const size = intent.approvedSize ?? intent.requestedSize;
  const feeBps = Number(env.EXCHANGE_FEE_BPS ?? 0);

  if (
    !Number.isFinite(intent.expectedPrice) ||
    !Number.isFinite(size) ||
    intent.expectedPrice <= 0 ||
    size <= 0 ||
    !Number.isFinite(feeBps) ||
    feeBps <= 0
  ) {
    return 0;
  }

  return Number(((intent.expectedPrice * size * feeBps) / 10_000).toFixed(8));
}

export function buildShadowRestingQuoteReport(
  intent: TradeIntent,
  observedAt: string
): ExecutionReport {
  const size = intent.approvedSize ?? intent.requestedSize;

  return {
    clientId: intent.intentId,
    exchangeOrderId: `shadow-open-${intent.intentId}`,
    instrumentCode: intent.instrumentCode,
    side: intent.action,
    orderSize: size,
    status: "OPEN",
    filledSize: 0,
    fillIncrementSize: 0,
    achievedPrice: intent.expectedPrice,
    expectedPrice: intent.expectedPrice,
    fees: 0,
    latencyMs: 0,
    reason: "SHADOW_MODE_POST_ONLY_RESTING_QUOTE",
    rawStatus: "OPEN",
    observedAt
  };
}
