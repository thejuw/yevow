import type {
  BookSnapshotResponse,
  InternalOrderBook,
  MarketDataSource,
  MarketTick,
  MicrostructureMetrics,
  PriceDiscoveryMetrics
} from "../../../types";
import {
  buildMarketKey,
  normalizeInstrumentSelector,
  normalizeMarketKey,
  normalizeNativeInstrumentCode
} from "../../../TradingEngineRuntimeHelpers";
import { roundCrypto, type SortedBookSide } from "./SortedBookSide";
import { getInstrumentBook } from "./BookReconstruction";
import type { BookSyncState } from "./BookTypes";

export interface BookSelection {
  marketKey: string;
  instrumentCode: string;
}

export interface BookSelectionContext {
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly microstructure: MicrostructureMetrics;
}

export interface BookSnapshotContext extends BookSelectionContext {
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
  readonly defaultSourceWeight: number;
  readonly getBookSync: (
    marketKey: string,
    instrumentCode: string,
    exchangeCode: string | null,
    sourceExchange: string,
    tickSize: number,
    source: MarketDataSource,
    sourceWeight: number
  ) => BookSyncState;
  readonly resolveTickSize: (instrumentCode: string) => number;
}

export function selectOrderBookMarketKey(
  context: BookSelectionContext,
  target?: string | MarketTick
): BookSelection | null {
  if (target && typeof target !== "string") {
    const marketKey = buildMarketKey(target.source_exchange, target.instrumentCode);
    return { marketKey, instrumentCode: target.instrumentCode.toLowerCase() };
  }

  const requested = target?.trim().toLowerCase();

  if (!requested) {
    const currentKey = context.microstructure.marketKey;
    const currentBook = currentKey ? context.orderBook.get(currentKey) : undefined;

    if (currentBook) {
      return {
        marketKey: currentBook.marketKey,
        instrumentCode: currentBook.instrumentCode
      };
    }

    const currentInstrument = context.microstructure.instrumentCode;
    const currentAssetBook = currentInstrument
      ? findBestAssetBook(context.orderBook, currentInstrument)
      : undefined;

    if (currentAssetBook) {
      return {
        marketKey: currentAssetBook.marketKey,
        instrumentCode: currentAssetBook.instrumentCode
      };
    }
  }

  if (requested && context.orderBook.has(requested)) {
    const book = context.orderBook.get(requested);
    return {
      marketKey: requested,
      instrumentCode: book?.instrumentCode ?? requested.split(":").slice(1).join(":")
    };
  }

  const instrumentCode = requested ? normalizeInstrumentSelector(requested) : undefined;
  let selected: InternalOrderBook | undefined;
  let selectedWeight = Number.NEGATIVE_INFINITY;
  let selectedObservedAt = Number.NEGATIVE_INFINITY;

  for (const book of context.orderBook.values()) {
    if (instrumentCode && book.instrumentCode !== instrumentCode) {
      continue;
    }

    const observedAt = Date.parse(book.updatedAt);
    const comparableObservedAt = Number.isFinite(observedAt)
      ? observedAt
      : Number.NEGATIVE_INFINITY;

    if (
      !selected ||
      book.sourceWeight > selectedWeight ||
      (book.sourceWeight === selectedWeight && comparableObservedAt > selectedObservedAt)
    ) {
      selected = book;
      selectedWeight = book.sourceWeight;
      selectedObservedAt = comparableObservedAt;
    }
  }

  return selected
    ? { marketKey: selected.marketKey, instrumentCode: selected.instrumentCode }
    : null;
}

export function calculateOrderBookPriceDiscovery(
  orderBook: Map<string, InternalOrderBook>,
  instrumentCode: string | null | undefined,
  observedAt: string
): PriceDiscoveryMetrics {
  const normalizedInstrument = instrumentCode?.toLowerCase() ?? null;
  const sources: PriceDiscoveryMetrics["sources"] = [];
  let totalWeight = 0;
  let weightedMid = 0;
  let primaryWeight = Number.NEGATIVE_INFINITY;
  let primaryExchange: string | null = null;

  for (const book of orderBook.values()) {
    if (
      (normalizedInstrument && book.instrumentCode !== normalizedInstrument) ||
      book.midPrice === null
    ) {
      continue;
    }

    const source = {
      marketKey: book.marketKey,
      source: book.source,
      source_exchange: book.source_exchange,
      exchangeCode: book.exchangeCode,
      instrumentCode: book.instrumentCode,
      weight: book.sourceWeight,
      midPrice: book.midPrice,
      spreadBps: book.spreadBps,
      weightedImbalance: book.weightedImbalance,
      updatedAt: book.updatedAt
    };

    sources.push(source);
    totalWeight += source.weight;
    weightedMid += source.midPrice * source.weight;

    if (source.weight > primaryWeight) {
      primaryWeight = source.weight;
      primaryExchange = source.source_exchange;
    }
  }

  return {
    instrumentCode: normalizedInstrument,
    weightedMidPrice: totalWeight > 0 ? roundCrypto(weightedMid / totalWeight) : null,
    primaryExchange,
    primaryWeight: Number.isFinite(primaryWeight) ? primaryWeight : 0,
    sourceCount: sources.length,
    sources,
    updatedAt: sources.length > 0 ? observedAt : null
  };
}

export function currentOrderBookSnapshot(
  context: BookSnapshotContext,
  instrumentCode: string | undefined,
  depth: number
): BookSnapshotResponse {
  const selected = selectOrderBookMarketKey(context, instrumentCode);
  const normalizedInstrument =
    selected?.instrumentCode ??
    (instrumentCode ? normalizeInstrumentSelector(instrumentCode) : null) ??
    context.microstructure.instrumentCode ??
    selected?.marketKey ??
    "unknown";
  const marketKey = selected?.marketKey ?? normalizeMarketKey(normalizedInstrument);
  const book = context.orderBook.get(marketKey);
  const bidBook = getInstrumentBook(context.bids, marketKey, "bid");
  const askBook = getInstrumentBook(context.asks, marketKey, "ask");
  const syncState = context.getBookSync(
    marketKey,
    normalizedInstrument,
    book?.exchangeCode ?? context.microstructure.exchangeCode ?? null,
    book?.source_exchange ?? context.microstructure.source_exchange ?? "unknown",
    book?.tickSize ?? context.resolveTickSize(normalizedInstrument),
    book?.source ?? "SYSTEM",
    book?.sourceWeight ?? context.defaultSourceWeight
  );

  return {
    marketKey,
    instrumentCode: normalizedInstrument,
    exchangeCode: book?.exchangeCode ?? syncState.exchangeCode,
    source_exchange: book?.source_exchange ?? syncState.source_exchange,
    sourceWeight: book?.sourceWeight ?? syncState.sourceWeight,
    sequence: syncState.lastSequence,
    isSynced: syncState.isSynced,
    desyncReason: syncState.desyncReason,
    tickSize: syncState.tickSize,
    ttbLatencyMs: syncState.ttbLatencyMs,
    topLevelCount: depth,
    bestBid: book?.bestBid ?? null,
    bestAsk: book?.bestAsk ?? null,
    midPrice: book?.midPrice ?? null,
    spread: book?.spread ?? null,
    weightedImbalance: book?.weightedImbalance ?? null,
    bids: bidBook.top(depth),
    asks: askBook.top(depth),
    updatedAt: book?.updatedAt ?? null
  };
}

export function currentBookForMarketTick(
  orderBook: Map<string, InternalOrderBook>,
  tick: MarketTick
): InternalOrderBook | undefined {
  const directBook = orderBook.get(buildMarketKey(tick.source_exchange, tick.instrumentCode));
  if (directBook) {
    return directBook;
  }

  const normalized = normalizeNativeInstrumentCode(tick.instrumentCode);
  let selected: InternalOrderBook | undefined;
  let selectedWeight = Number.NEGATIVE_INFINITY;
  let selectedObservedAt = Number.NEGATIVE_INFINITY;

  for (const book of orderBook.values()) {
    if (book.instrumentCode !== normalized) {
      continue;
    }

    const observedAt = Date.parse(book.updatedAt);
    const comparableObservedAt = Number.isFinite(observedAt)
      ? observedAt
      : Number.NEGATIVE_INFINITY;

    if (
      !selected ||
      book.sourceWeight > selectedWeight ||
      (book.sourceWeight === selectedWeight && comparableObservedAt > selectedObservedAt)
    ) {
      selected = book;
      selectedWeight = book.sourceWeight;
      selectedObservedAt = comparableObservedAt;
    }
  }

  return selected;
}

export function findBestAssetBook(
  orderBook: Map<string, InternalOrderBook>,
  instrumentCode: string
): InternalOrderBook | undefined {
  const normalized = normalizeNativeInstrumentCode(instrumentCode);
  let best: InternalOrderBook | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestObservedAt = 0;

  for (const book of orderBook.values()) {
    if (book.instrumentCode !== normalized) {
      continue;
    }

    const observedAt = Date.parse(book.updatedAt);
    const score =
      (book.isSynced ? 100 : 0) +
      (book.midPrice !== null ? 10 : 0) +
      Math.min(Math.max(book.bids.length, book.asks.length), 50) / 100;

    if (
      !best ||
      score > bestScore ||
      (score === bestScore && Number.isFinite(observedAt) && observedAt > bestObservedAt)
    ) {
      best = book;
      bestScore = score;
      bestObservedAt = Number.isFinite(observedAt) ? observedAt : 0;
    }
  }

  return best;
}
