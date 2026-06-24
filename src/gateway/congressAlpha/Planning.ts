import { MIN_REBALANCE_NOTIONAL_USD, round } from "./Common";
import type { CongressAlphaTarget } from "./Scoring";

type PaperSide = "BUY" | "SELL";

export interface CongressAlphaPaperOrder {
  orderId: string;
  runId: string;
  signalId: string | null;
  symbol: string;
  side: PaperSide;
  quantity: number;
  limitPrice: number;
  notional: number;
  status: "PAPER_FILLED";
  reason: string;
}

export interface CongressAlphaPositionRow {
  symbol: string;
  quantity: number;
  avg_price: number;
  market_price: number;
  market_value: number;
  unrealized_pnl: number;
  target_weight_pct: number;
  updated_at: string;
}

export interface CongressAlphaPositionPlan {
  symbol: string;
  quantity: number;
  avgPrice: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  targetWeightPct: number;
}

export interface CongressAlphaPaperPlan {
  orders: CongressAlphaPaperOrder[];
  upserts: CongressAlphaPositionPlan[];
  deletes: string[];
}

export function planCongressAlphaPaperOrders(
  existingRows: CongressAlphaPositionRow[],
  runId: string,
  targets: CongressAlphaTarget[]
): CongressAlphaPaperPlan {
  const existing = new Map(existingRows.map((row) => [row.symbol, row]));
  const targetBySymbol = new Map(targets.map((target) => [target.symbol, target]));
  const orders: CongressAlphaPaperOrder[] = [];
  const upserts: CongressAlphaPositionPlan[] = [];
  const deletes: string[] = [];

  for (const target of targets) {
    const current = existing.get(target.symbol);
    const price = target.referencePrice > 0 ? target.referencePrice : null;

    if (!price) {
      continue;
    }

    const targetQuantity = round(target.targetNotional / price, 8);
    const currentQuantity = current?.quantity ?? 0;
    const deltaQuantity = round(targetQuantity - currentQuantity, 8);
    const deltaNotional = Math.abs(deltaQuantity * price);
    const avgPrice =
      deltaQuantity > 0 && current
        ? weightedAverage(current.quantity, current.avg_price, deltaQuantity, price)
        : (current?.avg_price ?? price);

    if (deltaNotional >= MIN_REBALANCE_NOTIONAL_USD) {
      orders.push({
        orderId: crypto.randomUUID(),
        runId,
        signalId: target.signalId,
        symbol: target.symbol,
        side: deltaQuantity >= 0 ? "BUY" : "SELL",
        quantity: Math.abs(deltaQuantity),
        limitPrice: price,
        notional: round(deltaNotional, 2),
        status: "PAPER_FILLED",
        reason: target.reason
      });
    }

    upserts.push(
      positionPlan({
        symbol: target.symbol,
        quantity: targetQuantity,
        avgPrice,
        marketPrice: price,
        targetWeightPct: target.targetWeightPct
      })
    );
  }

  for (const [symbol, row] of existing.entries()) {
    if (targetBySymbol.has(symbol) || row.quantity <= 0) {
      continue;
    }

    orders.push({
      orderId: crypto.randomUUID(),
      runId,
      signalId: null,
      symbol,
      side: "SELL",
      quantity: row.quantity,
      limitPrice: row.market_price,
      notional: round(row.quantity * row.market_price, 2),
      status: "PAPER_FILLED",
      reason: "Removed from current top Congress Alpha targets."
    });
    deletes.push(symbol);
  }

  return { orders, upserts, deletes };
}

function positionPlan(position: {
  symbol: string;
  quantity: number;
  avgPrice: number;
  marketPrice: number;
  targetWeightPct: number;
}): CongressAlphaPositionPlan {
  const marketValue = round(position.quantity * position.marketPrice, 2);
  const unrealizedPnl = round((position.marketPrice - position.avgPrice) * position.quantity, 2);

  return {
    symbol: position.symbol,
    quantity: position.quantity,
    avgPrice: position.avgPrice,
    marketPrice: position.marketPrice,
    marketValue,
    unrealizedPnl,
    targetWeightPct: position.targetWeightPct
  };
}

function weightedAverage(
  currentQuantity: number,
  currentAverage: number,
  deltaQuantity: number,
  deltaPrice: number
): number {
  const totalQuantity = currentQuantity + deltaQuantity;

  if (totalQuantity <= 0) {
    return deltaPrice;
  }

  return round((currentQuantity * currentAverage + deltaQuantity * deltaPrice) / totalQuantity, 8);
}
