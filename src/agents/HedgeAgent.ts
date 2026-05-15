import type {
  HedgeState,
  InternalOrderBook,
  LeadLagMetrics,
  Position,
  TradeIntent
} from "../types";

export class HedgeAgent {
  evaluate(input: {
    positions: Record<string, Position>;
    books: InternalOrderBook[];
    leadLag: LeadLagMetrics;
    threshold: number;
    observedAt: string;
  }): HedgeState {
    const netDelta = Object.values(input.positions).reduce((sum, position) => {
      const signed = position.side === "LONG" ? position.quantity : -position.quantity;
      return sum + signed;
    }, 0);
    const hedgeRequired = Math.abs(netDelta) > input.threshold;
    const correlation = input.leadLag.correlation ?? 1;
    const hedgeRatio = Math.abs(correlation);
    const preferred = cheapestLiquidity(input.books, input.positions, netDelta);
    const lastIntent =
      hedgeRequired && preferred
        ? hedgeIntent(netDelta, correlation, hedgeRatio, preferred, input.observedAt)
        : null;

    return {
      netDelta,
      hedgeRequired,
      hedgeRatio,
      preferredVenue: preferred?.source_exchange ?? null,
      lastIntent,
      updatedAt: input.observedAt
    };
  }
}

function cheapestLiquidity(
  books: InternalOrderBook[],
  positions: Record<string, Position>,
  netDelta: number
): InternalOrderBook | null {
  const side = netDelta > 0 ? "bids" : "asks";
  const primaryInstrument = Object.values(positions).sort(
    (left, right) => right.quantity * right.markPrice - left.quantity * left.markPrice
  )[0]?.instrumentCode;

  return [...books]
    .filter((book) => book[side].length > 0 && book.instrumentCode !== primaryInstrument)
    .sort((left, right) => liquidityScore(right, side) - liquidityScore(left, side))[0] ??
    [...books]
      .filter((book) => book[side].length > 0)
      .sort((left, right) => liquidityScore(right, side) - liquidityScore(left, side))[0] ??
    null;
}

function hedgeIntent(
  netDelta: number,
  correlation: number,
  hedgeRatio: number,
  book: InternalOrderBook,
  observedAt: string
): TradeIntent {
  const action = netDelta * correlation > 0 ? "SELL" : "BUY";
  const price =
    action === "SELL"
      ? book.bestBid ?? book.midPrice ?? 0
      : book.bestAsk ?? book.midPrice ?? 0;

  return {
    schemaVersion: "trade-intent.v1",
    intentId: crypto.randomUUID(),
    traceId: `hedge:${book.marketKey}:${observedAt}`,
    instrumentCode: book.instrumentCode,
    marketKey: book.marketKey,
    source_exchange: book.source_exchange,
    direction: action === "BUY" ? "LONG" : "SHORT",
    action,
    orderType: "MARKET",
    postOnly: false,
    timeInForce: "IOC",
    intendedPrice: price,
    expectedPrice: price,
    requestedSize: Math.abs(netDelta) * hedgeRatio,
    approvedSize: Math.abs(netDelta) * hedgeRatio,
    probabilityWin: 0.5,
    probabilityLoss: 0.5,
    profit: 0,
    loss: 0,
    executionCosts: 0,
    adverseSelectionCost: 0,
    expectedValue: 0,
    minEvThreshold: 0,
    maxSlippageBps: Math.max(5, book.spreadBps ?? 5),
    confidence: Math.min(1, hedgeRatio),
    rationale: "Automated signed-correlation delta hedge using secondary liquidity where available",
    createdAt: observedAt
  };
}

function liquidityScore(book: InternalOrderBook, side: "bids" | "asks"): number {
  const depth = book[side].slice(0, 10).reduce((sum, level) => sum + level.price * level.size, 0);
  const spreadPenalty = Math.max(1, book.spreadBps ?? 10_000);
  return depth / spreadPenalty;
}
