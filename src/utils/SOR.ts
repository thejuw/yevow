import type { InternalOrderBook, TradeIntent } from "../types";

export interface SorRoute {
  marketKey: string;
  source_exchange: string;
  size: number;
  expectedPrice: number;
}

export interface SorPlan {
  routes: SorRoute[];
  bestSingleExchangePrice: number | null;
  aggregatePrice: number | null;
  sorSavings: number;
  unfilledSize: number;
}

export function planSmartOrderRoute(
  intent: TradeIntent,
  books: InternalOrderBook[]
): SorPlan {
  const targetSize = intent.approvedSize ?? intent.requestedSize;
  const sideLevels = intent.action === "BUY" ? "asks" : "bids";
  const candidates = books
    .filter((book) => book.instrumentCode === intent.instrumentCode)
    .flatMap((book) =>
      book[sideLevels].slice(0, 20).map((level) => ({
        marketKey: book.marketKey,
        source_exchange: book.source_exchange,
        price: level.price,
        size: level.size
      }))
    )
    .sort((left, right) =>
      intent.action === "BUY" ? left.price - right.price : right.price - left.price
    );
  const routes: SorRoute[] = [];
  let remaining = targetSize;
  let notional = 0;

  for (const level of candidates) {
    if (remaining <= 0) {
      break;
    }

    const size = Math.min(remaining, level.size);
    routes.push({
      marketKey: level.marketKey,
      source_exchange: level.source_exchange,
      size,
      expectedPrice: level.price
    });
    notional += size * level.price;
    remaining -= size;
  }

  const aggregatePrice = routes.length > 0 ? notional / Math.max(0.00000001, targetSize - remaining) : null;
  const bestSingleExchangePrice = candidates[0]?.price ?? null;
  const sorSavings =
    aggregatePrice !== null && bestSingleExchangePrice !== null
      ? intent.action === "BUY"
        ? bestSingleExchangePrice - aggregatePrice
        : aggregatePrice - bestSingleExchangePrice
      : 0;

  return {
    routes,
    bestSingleExchangePrice,
    aggregatePrice,
    sorSavings,
    unfilledSize: remaining
  };
}
