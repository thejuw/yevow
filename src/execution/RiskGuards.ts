import type { GlobalRiskConfig, TradeIntent } from "../types";

export interface ExecutionRiskDecision {
  ok: boolean;
  reason: string | null;
  status: number;
  notional: number;
}

export function evaluateExecutionRisk(
  intent: TradeIntent,
  config: Pick<
    GlobalRiskConfig,
    | "TRADING_ENABLED"
    | "MAX_POSITION_SIZE"
    | "MAX_POSITION_PCT"
    | "MAX_INVENTORY_UNITS"
    | "MAX_INVENTORY_DELTA"
    | "MAX_SINGLE_ORDER_NOTIONAL_USD"
    | "HEDGE_ENABLED"
  >,
  bankrollEquity = 0
): ExecutionRiskDecision {
  const size = intent.approvedSize ?? intent.requestedSize;
  const notional = safePositive(intent.expectedPrice) * safePositive(size);
  const inventoryHedge = isInventoryHedgeIntent(intent);

  if (!config.TRADING_ENABLED && !(inventoryHedge && config.HEDGE_ENABLED)) {
    return reject("TRADING_DISABLED", 423, notional);
  }

  if (inventoryHedge && !config.HEDGE_ENABLED) {
    return reject("HEDGE_DISABLED", 423, notional);
  }

  if (!Number.isFinite(notional) || notional <= 0) {
    return reject("INVALID_ORDER_NOTIONAL", 400, notional);
  }

  if (config.MAX_POSITION_SIZE > 0 && size > config.MAX_POSITION_SIZE) {
    return reject("MAX_POSITION_SIZE_EXCEEDED", 409, notional);
  }

  if (config.MAX_INVENTORY_UNITS > 0 && size > config.MAX_INVENTORY_UNITS) {
    return reject("MAX_INVENTORY_UNITS_EXCEEDED", 409, notional);
  }

  if (config.MAX_INVENTORY_DELTA > 0 && size > config.MAX_INVENTORY_DELTA) {
    return reject("MAX_INVENTORY_DELTA_EXCEEDED", 409, notional);
  }

  if (
    bankrollEquity > 0 &&
    config.MAX_POSITION_PCT > 0 &&
    notional > bankrollEquity * config.MAX_POSITION_PCT
  ) {
    return reject("MAX_POSITION_PCT_EXCEEDED", 409, notional);
  }

  if (
    intent.executionStyle !== "SLICED_TWAP" &&
    config.MAX_SINGLE_ORDER_NOTIONAL_USD > 0 &&
    notional > config.MAX_SINGLE_ORDER_NOTIONAL_USD
  ) {
    return reject("MAX_SINGLE_ORDER_NOTIONAL_EXCEEDED", 409, notional);
  }

  return {
    ok: true,
    reason: null,
    status: 200,
    notional
  };
}

export function isInventoryHedgeIntent(intent: TradeIntent): boolean {
  const rationale = intent.rationale.toLowerCase();
  return (
    rationale.includes("inventory_hedge") &&
    rationale.includes("reduce-only") &&
    intent.orderType === "IOC" &&
    intent.timeInForce === "IOC" &&
    !intent.postOnly
  );
}

function reject(reason: string, status: number, notional: number): ExecutionRiskDecision {
  return {
    ok: false,
    reason,
    status,
    notional
  };
}

function safePositive(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.NaN;
}
