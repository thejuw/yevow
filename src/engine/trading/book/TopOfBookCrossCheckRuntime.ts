import type { InternalOrderBook, JsonRecord } from "../../../types";
import type { BookDeltaWithTicker, BookSyncState } from "./BookTypes";
import { markBookDesynced } from "./BookSyncRuntime";

export type TopOfBookCrossCheckResult =
  | { readonly status: "SKIP" }
  | {
      readonly status: "MATCH";
      readonly checkedAtMs: number;
      readonly payload: JsonRecord;
    }
  | {
      readonly status: "MISMATCH";
      readonly checkedAtMs: number;
      readonly desyncedAt: string;
      readonly payload: JsonRecord;
    };

export interface TopOfBookCrossCheckInput {
  readonly syncState: BookSyncState;
  readonly delta: BookDeltaWithTicker;
  readonly book: InternalOrderBook;
  readonly checkedAtMs: number;
  readonly intervalMs: number;
  readonly desyncedAt: string;
}

export function evaluateTopOfBookCrossCheck(
  input: TopOfBookCrossCheckInput
): TopOfBookCrossCheckResult {
  if (input.checkedAtMs - input.syncState.lastCrossCheckAt < input.intervalMs) {
    return { status: "SKIP" };
  }

  const rawBestBid = typeof input.delta.bestBid === "number" ? input.delta.bestBid : null;
  const rawBestAsk = typeof input.delta.bestAsk === "number" ? input.delta.bestAsk : null;
  const bidMismatch =
    rawBestBid !== null &&
    input.book.bestBid !== null &&
    Math.abs(rawBestBid - input.book.bestBid) > input.book.tickSize;
  const askMismatch =
    rawBestAsk !== null &&
    input.book.bestAsk !== null &&
    Math.abs(rawBestAsk - input.book.bestAsk) > input.book.tickSize;

  const payload: JsonRecord = {
    instrumentCode: input.book.instrumentCode,
    exchangeCode: input.book.exchangeCode,
    sequence: input.book.sequence,
    bestBid: input.book.bestBid,
    bestAsk: input.book.bestAsk,
    rawBestBid,
    rawBestAsk,
    tickSize: input.book.tickSize
  };

  if (!bidMismatch && !askMismatch) {
    return {
      status: "MATCH",
      checkedAtMs: input.checkedAtMs,
      payload: { ...payload, status: "MATCH" }
    };
  }

  return {
    status: "MISMATCH",
    checkedAtMs: input.checkedAtMs,
    desyncedAt: input.desyncedAt,
    payload
  };
}

export function applyTopOfBookCrossCheckSync(
  syncState: BookSyncState,
  result: TopOfBookCrossCheckResult
): void {
  if (result.status === "SKIP") {
    return;
  }

  syncState.lastCrossCheckAt = result.checkedAtMs;

  if (result.status === "MISMATCH") {
    markBookDesynced(syncState, "TOP_OF_BOOK_MISMATCH", result.desyncedAt, syncState.ttbLatencyMs);
  }
}
