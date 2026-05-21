import type {
  InternalOrderBook,
  JsonRecord,
  OrderBookDelta,
  OrderBookResetRequest
} from "../../../types";
import type { BookSyncState } from "./BookTypes";
import { markBookDesynced } from "./BookSyncRuntime";

export interface OrderBookDesyncHandlers {
  readonly error: (eventType: string, message: string, metadata: JsonRecord) => void;
  readonly publish: (type: string, payload: JsonRecord) => void;
  readonly resetOrderBook: (payload: Partial<OrderBookResetRequest>) => Promise<void>;
}

export interface OrderBookSequenceGapSideEffectInput {
  readonly delta: OrderBookDelta;
  readonly expectedSequence: number;
  readonly syncState: BookSyncState;
  readonly instrumentCode: string;
  readonly exchangeCode: string;
  readonly sourceExchange: string;
  readonly timeToBookMs: number | null;
  readonly observedAt: string;
}

export interface CrossedBookSideEffectInput {
  readonly book: InternalOrderBook;
  readonly sequence: number;
  readonly timeToBookMs: number | null;
  readonly observedAt: string;
  readonly syncState: BookSyncState;
  readonly message: string;
}

export function orderBookSequenceGapPayload(
  input: OrderBookSequenceGapSideEffectInput
): JsonRecord {
  return {
    instrumentCode: input.instrumentCode,
    exchangeCode: input.exchangeCode,
    expectedSequence: input.expectedSequence,
    actualSequence: input.delta.sequence,
    lastSequence: input.syncState.lastSequence,
    timeToBookMs: input.timeToBookMs
  };
}

export function crossedBookLogPayload(input: {
  readonly book: InternalOrderBook;
  readonly sequence: number;
  readonly timeToBookMs: number | null;
}): JsonRecord {
  return {
    instrumentCode: input.book.instrumentCode,
    exchangeCode: input.book.exchangeCode,
    source_exchange: input.book.source_exchange,
    sequence: input.sequence,
    bestBid: input.book.bestBid,
    bestAsk: input.book.bestAsk,
    spread: input.book.spread,
    timeToBookMs: input.timeToBookMs
  };
}

export async function applyOrderBookSequenceGapSideEffects(
  input: OrderBookSequenceGapSideEffectInput,
  handlers: OrderBookDesyncHandlers
): Promise<void> {
  markBookDesynced(input.syncState, "SEQUENCE_GAP", input.observedAt, input.timeToBookMs);

  const payload = orderBookSequenceGapPayload(input);
  handlers.error("ORDER_BOOK_DESYNC", "Sequence gap detected; purging local book", payload);
  handlers.publish("ORDER_BOOK_DESYNC", payload);

  await handlers.resetOrderBook({
    source: "SYSTEM",
    reason: "SEQUENCE_GAP",
    instrumentCode: input.instrumentCode,
    source_exchange: input.sourceExchange,
    connectionId: null,
    blackoutDurationMs: null,
    recoveredAt: input.observedAt
  });
}

export async function applyCrossedBookSideEffects(
  input: CrossedBookSideEffectInput,
  handlers: OrderBookDesyncHandlers
): Promise<void> {
  markBookDesynced(input.syncState, "CROSSED_BOOK", input.observedAt, input.timeToBookMs);

  const payload = crossedBookLogPayload(input);
  handlers.error("ORDER_BOOK_CROSSED", input.message, payload);
  handlers.publish("ORDER_BOOK_CROSSED", payload);

  await handlers.resetOrderBook({
    source: "SYSTEM",
    reason: "CROSSED_BOOK",
    instrumentCode: input.book.instrumentCode,
    source_exchange: input.book.source_exchange,
    connectionId: null,
    blackoutDurationMs: null,
    recoveredAt: input.observedAt
  });
}
