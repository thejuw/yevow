import type { InternalOrderBook, QuoteSignal } from "../types";

export interface QueueRefreshAdvice {
  shouldRefresh: boolean;
  reason: "NO_PRIOR" | "MID_MOVED" | "QUEUE_FAR_STALE" | "HOLD_FRONT_OF_QUEUE" | "UNCHANGED";
  queuePressure: number;
}

export class QueuePositionModel {
  adviseRefresh(input: {
    previousQuote: { bid: number | null; ask: number | null; updatedAtMs: number } | null;
    quote: QuoteSignal;
    book: InternalOrderBook | null;
    minPriceTicks: number;
    elapsedMs: number;
    tickSize: number;
  }): QueueRefreshAdvice {
    if (!input.previousQuote) {
      return { shouldRefresh: true, reason: "NO_PRIOR", queuePressure: 0 };
    }

    const nextBid = input.quote.orders.find((order) => order.side === "BID")?.price ?? null;
    const nextAsk = input.quote.orders.find((order) => order.side === "ASK")?.price ?? null;
    const bidMoved = quotePriceMovedTicks(input.previousQuote.bid, nextBid, input.tickSize);
    const askMoved = quotePriceMovedTicks(input.previousQuote.ask, nextAsk, input.tickSize);
    const movedEnough = bidMoved >= input.minPriceTicks || askMoved >= input.minPriceTicks;

    if (movedEnough) {
      return {
        shouldRefresh: true,
        reason: "MID_MOVED",
        queuePressure: Math.max(bidMoved, askMoved)
      };
    }

    const queuePressure = estimateQueuePressure(input.quote, input.book);
    if (queuePressure >= 0.75 && input.elapsedMs >= 250) {
      return { shouldRefresh: true, reason: "QUEUE_FAR_STALE", queuePressure };
    }

    if (queuePressure <= 0.25) {
      return { shouldRefresh: false, reason: "HOLD_FRONT_OF_QUEUE", queuePressure };
    }

    return { shouldRefresh: false, reason: "UNCHANGED", queuePressure };
  }
}

function estimateQueuePressure(quote: QuoteSignal, book: InternalOrderBook | null): number {
  if (!book) {
    return 0.5;
  }

  let pressure = 0;
  let count = 0;

  for (const order of quote.orders) {
    const levels = order.side === "BID" ? book.bids : book.asks;
    const level = levels.find((item) => Math.abs(item.price - order.price) <= book.tickSize / 2);
    if (!level || level.size <= 0) {
      pressure += 1;
    } else {
      pressure += Math.min(1, order.size / Math.max(order.size, level.size));
    }
    count += 1;
  }

  return count > 0 ? pressure / count : 0.5;
}

function quotePriceMovedTicks(
  previous: number | null,
  next: number | null,
  tickSize: number
): number {
  if (previous === null || next === null || tickSize <= 0) {
    return 0;
  }
  return Math.abs(previous - next) / tickSize;
}
