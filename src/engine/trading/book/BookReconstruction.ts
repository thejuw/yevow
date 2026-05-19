import type {
  InternalOrderBook,
  MarketDataSource,
  MicrostructureMetrics,
  OrderBookSide,
  PriceLevel
} from "../../../types";
import { countOrderBookLevels } from "../../OrderBookState";
import { roundCrypto, roundMetric, SortedBookSide } from "./SortedBookSide";
import type { BookSyncState } from "./BookTypes";

export interface RebuildBookSnapshotInput {
  bids: Map<string, SortedBookSide>;
  asks: Map<string, SortedBookSide>;
  syncState: BookSyncState;
  marketKey: string;
  instrumentCode: string;
  exchangeCode: string;
  sourceExchange: string;
  source: MarketDataSource;
  sourceWeight: number;
  sequence: number;
  updatedAt: string;
  timeToBookMs: number | null;
  topLevels: number;
}

export interface RebuiltBookSnapshot {
  book: InternalOrderBook;
  microstructure: MicrostructureMetrics;
}

export function getInstrumentBook(
  books: Map<string, SortedBookSide>,
  marketKey: string,
  side: OrderBookSide
): SortedBookSide {
  const existing = books.get(marketKey);

  if (existing) {
    return existing;
  }

  const created = new SortedBookSide(side);
  books.set(marketKey, created);
  return created;
}

export function countBookLevels(
  bids: Map<string, SortedBookSide>,
  asks: Map<string, SortedBookSide>
): number {
  return countOrderBookLevels(bids.values(), asks.values());
}

export function rebuildBookSnapshotFromSides(input: RebuildBookSnapshotInput): RebuiltBookSnapshot {
  const bidBook = getInstrumentBook(input.bids, input.marketKey, "bid");
  const askBook = getInstrumentBook(input.asks, input.marketKey, "ask");
  const bids = bidBook.top(input.topLevels);
  const asks = askBook.top(input.topLevels);
  const microstructure = buildMicrostructureSnapshot(
    input.marketKey,
    input.instrumentCode,
    input.exchangeCode,
    input.sourceExchange,
    input.sourceWeight,
    bids,
    asks,
    input.updatedAt,
    input.sequence,
    input.timeToBookMs,
    input.syncState.isSynced
  );
  const book: InternalOrderBook = {
    marketKey: input.marketKey,
    source: input.source,
    source_exchange: input.sourceExchange,
    sourceWeight: input.sourceWeight,
    instrumentCode: input.instrumentCode,
    exchangeCode: input.exchangeCode,
    bids,
    asks,
    bestBid: microstructure.bestBid,
    bestAsk: microstructure.bestAsk,
    midPrice: microstructure.midPrice,
    spread: microstructure.spread,
    spreadBps: microstructure.spreadBps,
    weightedImbalance: microstructure.weightedImbalance,
    lastSequence: input.sequence,
    tickSize: input.syncState.tickSize,
    ttbLatencyMs: input.timeToBookMs,
    isSynced: input.syncState.isSynced,
    desyncReason: input.syncState.desyncReason,
    sequence: input.sequence,
    updatedAt: input.updatedAt
  };

  return { book, microstructure };
}

export function buildMicrostructureSnapshot(
  marketKey: string,
  instrumentCode: string,
  exchangeCode: string,
  sourceExchange: string,
  sourceWeight: number,
  bids: PriceLevel[],
  asks: PriceLevel[],
  updatedAt: string,
  lastSequence: number | null,
  timeToBookMs: number | null,
  isSynced: boolean
): MicrostructureMetrics {
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread = bestBid !== null && bestAsk !== null ? roundCrypto(bestAsk - bestBid) : null;
  const midPrice =
    bestBid !== null && bestAsk !== null ? roundCrypto((bestBid + bestAsk) / 2) : null;
  const spreadBps =
    spread !== null && midPrice !== null && midPrice !== 0
      ? roundMetric((spread / midPrice) * 10_000, 4)
      : null;
  const bidVolume = roundCrypto(sumVolume(bids));
  const askVolume = roundCrypto(sumVolume(asks));
  const totalVolume = bidVolume + askVolume;
  const weightedImbalance =
    totalVolume > 0 ? roundMetric((bidVolume - askVolume) / totalVolume, 8) : null;

  return {
    marketKey,
    instrumentCode,
    exchangeCode,
    source_exchange: sourceExchange,
    sourceWeight,
    bestBid,
    bestAsk,
    midPrice,
    spread,
    spreadBps,
    bidVolume,
    askVolume,
    weightedImbalance,
    depthLevels: bids.length + asks.length,
    lastSequence,
    timeToBookMs,
    isSynced,
    updatedAt
  };
}

export function microstructureFromBook(book: InternalOrderBook): MicrostructureMetrics {
  return buildMicrostructureSnapshot(
    book.marketKey,
    book.instrumentCode,
    book.exchangeCode,
    book.source_exchange,
    book.sourceWeight,
    book.bids,
    book.asks,
    book.updatedAt,
    book.lastSequence,
    book.ttbLatencyMs,
    book.isSynced
  );
}

export function isCrossedBook(book: InternalOrderBook): boolean {
  return (
    book.bestBid !== null &&
    book.bestAsk !== null &&
    Number.isFinite(book.bestBid) &&
    Number.isFinite(book.bestAsk) &&
    book.bestBid >= book.bestAsk
  );
}

function sumVolume(levels: PriceLevel[]): number {
  let total = 0;

  for (const level of levels) {
    total += level.size;
  }

  return total;
}
