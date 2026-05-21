import type { InternalOrderBook, JsonRecord } from "../../../types";
import type { BookDeltaWithTicker, BookSyncState } from "./BookTypes";
import {
  applyTopOfBookCrossCheckSync,
  evaluateTopOfBookCrossCheck
} from "./TopOfBookCrossCheckRuntime";

export interface OrderBookCrossCheckInput {
  readonly syncState: BookSyncState;
  readonly delta: BookDeltaWithTicker;
  readonly book: InternalOrderBook;
  readonly checkedAtMs: number;
  readonly intervalMs: number;
  readonly desyncedAt: string;
}

export interface OrderBookCrossCheckHandlers {
  readonly error: (eventType: string, message: string, metadata: JsonRecord) => void;
  readonly publish: (type: string, payload: JsonRecord) => void;
}

export function applyOrderBookCrossCheckSideEffects(
  input: OrderBookCrossCheckInput,
  handlers: OrderBookCrossCheckHandlers
): void {
  const result = evaluateTopOfBookCrossCheck({
    syncState: input.syncState,
    delta: input.delta,
    book: input.book,
    checkedAtMs: input.checkedAtMs,
    intervalMs: input.intervalMs,
    desyncedAt: input.desyncedAt
  });

  applyTopOfBookCrossCheckSync(input.syncState, result);

  if (result.status === "SKIP") {
    return;
  }

  if (result.status === "MATCH") {
    handlers.publish("ORDER_BOOK_CROSS_CHECK", result.payload);
    return;
  }

  handlers.error("ORDER_BOOK_CROSS_CHECK_FAILED", "Top-of-book mismatch detected", {
    ...result.payload
  });
  handlers.publish("ORDER_BOOK_CROSS_CHECK_FAILED", result.payload);
}
