import type { ExecutionStyle, GlobalRiskConfig, TradeIntent } from "../types";

export function resolveExecutionStyle(intent: TradeIntent): ExecutionStyle {
  if (intent.executionStyle) {
    return intent.executionStyle;
  }
  if (intent.postOnly && intent.orderType === "LIMIT") {
    return "POST_ONLY_QUOTE";
  }
  if (intent.orderType === "MARKET") {
    return "TAKER_MARKET";
  }
  if (!intent.postOnly && (intent.orderType === "IOC" || intent.timeInForce === "IOC")) {
    return "TAKER_IOC";
  }
  return "POST_ONLY_QUOTE";
}

export function isTakerExecutionStyle(executionStyle: ExecutionStyle): boolean {
  return executionStyle === "TAKER_IOC" || executionStyle === "TAKER_MARKET";
}

export function evaluateCascadeTakerGate(
  intent: TradeIntent,
  config: GlobalRiskConfig,
  inventoryHedge: boolean
): { ok: true } | { ok: false; reason: string; status: number } {
  if (inventoryHedge) {
    return { ok: true };
  }
  if (config.STRATEGY_MODE !== "CASCADE_RECOVERY" && config.STRATEGY_MODE !== "BOTH_LIVE") {
    return { ok: false, reason: "CASCADE_STRATEGY_MODE_DISABLED", status: 423 };
  }
  if (!config.TRADING_ENABLED) {
    return { ok: false, reason: "TRADING_DISABLED", status: 423 };
  }
  if (!config.CASCADE_TAKER_ENABLED) {
    return { ok: false, reason: "CASCADE_TAKER_DISABLED", status: 423 };
  }

  const notional = (intent.approvedSize ?? intent.requestedSize) * intent.expectedPrice;
  if (
    intent.executionStyle !== "SLICED_TWAP" &&
    config.MAX_SINGLE_ORDER_NOTIONAL_USD > 0 &&
    notional > config.MAX_SINGLE_ORDER_NOTIONAL_USD
  ) {
    return { ok: false, reason: "MAX_SINGLE_ORDER_NOTIONAL_EXCEEDED", status: 409 };
  }

  return { ok: true };
}

export function takerSpreadDecision(
  bestBid: number | null,
  bestAsk: number | null,
  maxSpreadBps: number
): { ok: true } | { ok: false; reason: string; status: number } {
  if (bestBid === null || bestAsk === null || bestBid <= 0 || bestAsk <= 0 || bestAsk <= bestBid) {
    return { ok: false, reason: "TAKER_BBO_INVALID", status: 503 };
  }

  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;
  if (spreadBps > maxSpreadBps) {
    return { ok: false, reason: "TAKER_SPREAD_TOO_WIDE", status: 409 };
  }

  return { ok: true };
}

export function takerExpectedSlippageBps(intent: TradeIntent, touch: number): number {
  if (touch <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  if (intent.action === "BUY") {
    return Math.max(0, ((intent.expectedPrice - touch) / touch) * 10_000);
  }

  return Math.max(0, ((touch - intent.expectedPrice) / touch) * 10_000);
}

export function cappedExecutionPrice(intent: TradeIntent, referencePrice: number): number {
  const executionStyle = resolveExecutionStyle(intent);
  if (executionStyle !== "TAKER_MARKET") {
    return referencePrice;
  }

  const slippageMultiplier = Math.max(0, intent.maxSlippageBps * 3) / 10_000;
  if (intent.action === "BUY") {
    return referencePrice * (1 + slippageMultiplier);
  }

  return Math.max(referencePrice * (1 - slippageMultiplier), Number.EPSILON);
}
