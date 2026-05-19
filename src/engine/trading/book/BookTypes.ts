import type {
  InternalOrderBook,
  MarketDataSource,
  OrderBookDelta,
  OrderBookSide
} from "../../../types";

export interface BookSyncState {
  marketKey: string;
  source: MarketDataSource;
  source_exchange: string;
  sourceWeight: number;
  instrumentCode: string;
  exchangeCode: string | null;
  lastSequence: number | null;
  lastSnapshotAt: string | null;
  lastDeltaAt: string | null;
  lastDesyncAt: string | null;
  desyncReason: string | null;
  isSynced: boolean;
  tickSize: number;
  ttbLatencyMs: number | null;
  lastCrossCheckAt: number;
}

export interface AppliedBookUpdate {
  accepted: boolean;
  reason?: "SEQUENCE_GAP" | "DUPLICATE_OR_OUT_OF_ORDER" | "UNKNOWN_SIDE" | "CROSSED_BOOK";
  book?: InternalOrderBook;
  timeToBookMs: number | null;
  expectedSequence?: number;
  actualSequence: number;
}

export type BookDeltaWithTicker = OrderBookDelta & {
  bestBid?: number | null;
  bestAsk?: number | null;
};

export interface BookSideStore {
  readonly size: number;
  clear(): void;
  upsert(price: number, size: number, updatedAt: string, tickSize: number): void;
  top(limit: number): { price: number; size: number; updatedAt: string }[];
  range(
    minimum: number,
    maximum: number,
    limit: number
  ): {
    price: number;
    size: number;
    updatedAt: string;
  }[];
}

export type BookSideFactory = (side: OrderBookSide) => BookSideStore;
