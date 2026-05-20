import { PROFILER_STATE_STORAGE_PREFIX } from "../../../agents/ProfilerAgent";
import { BOOK_SNAPSHOT_TOP_LEVELS } from "../../../TradingEngineConstants";
import { buildMicrostructureSnapshot } from "./BookReconstruction";
import { DEFAULT_ORDER_BOOK_TICK_SIZE, roundCrypto, SortedBookSide } from "./SortedBookSide";
import type { BookDeltaWithTicker, BookSyncState } from "./BookTypes";
import { normalizeMarketKey } from "../state/AssetStateRuntime";
import {
  normalizeNativeInstrumentCode,
  normalizeSourceExchange,
  normalizeSourceWeight
} from "../helpers/NativeMarketIdentityRuntime";
import { parseTimestampMs } from "../helpers/RuntimeClock";
import { readPositiveNumber } from "../helpers/RuntimeParsing";
import type { Env, InternalOrderBook, MarketTick, OrderBookSide, PriceLevel } from "../../../types";

export function resolveBookSide(tick: MarketTick): OrderBookSide | null {
  if (tick.bestBid !== undefined || tick.side === "buy") {
    return "bid";
  }

  if (tick.bestAsk !== undefined || tick.side === "sell") {
    return "ask";
  }

  return null;
}

export function resolveCurrentInstrument(
  requestedInstrument: string | undefined,
  stateInstrument: string | null,
  orderBook: Map<string, InternalOrderBook>
): string {
  return (
    requestedInstrument?.toLowerCase() ??
    stateInstrument ??
    orderBook.keys().next().value ??
    "unknown"
  );
}

export function buildMarketKey(sourceExchange: string, instrumentCode: string): string {
  return `${normalizeSourceExchange(sourceExchange)}:${instrumentCode.toLowerCase()}`;
}

export function profilerStorageKey(instrumentCode: string): string {
  return `${PROFILER_STATE_STORAGE_PREFIX}${normalizeNativeInstrumentCode(instrumentCode)}`;
}

export function profilerInstrumentFromStorageKey(storageKey: string): string {
  return normalizeNativeInstrumentCode(
    storageKey.startsWith(PROFILER_STATE_STORAGE_PREFIX)
      ? storageKey.slice(PROFILER_STATE_STORAGE_PREFIX.length)
      : storageKey
  );
}

export function hydrateOrderBooks(records: Map<string, InternalOrderBook>): {
  snapshots: Map<string, InternalOrderBook>;
  bids: Map<string, SortedBookSide>;
  asks: Map<string, SortedBookSide>;
  sync: Map<string, BookSyncState>;
} {
  const snapshots = new Map<string, InternalOrderBook>();
  const bids = new Map<string, SortedBookSide>();
  const asks = new Map<string, SortedBookSide>();
  const sync = new Map<string, BookSyncState>();

  for (const [, value] of records) {
    const bidLevels = Array.isArray(value.bids) ? value.bids : hydrateLegacyLevel(value, "bid");
    const askLevels = Array.isArray(value.asks) ? value.asks : hydrateLegacyLevel(value, "ask");
    const tickSize = value.tickSize ?? DEFAULT_ORDER_BOOK_TICK_SIZE;
    const bidBook = levelsToBookSide(bidLevels, "bid", tickSize);
    const askBook = levelsToBookSide(askLevels, "ask", tickSize);
    const normalizedBids = bidBook.top(BOOK_SNAPSHOT_TOP_LEVELS);
    const normalizedAsks = askBook.top(BOOK_SNAPSHOT_TOP_LEVELS);
    const sourceExchange = normalizeSourceExchange(value.source_exchange ?? value.exchangeCode);
    const marketKey = normalizeMarketKey(
      value.marketKey ?? buildMarketKey(sourceExchange, value.instrumentCode)
    );
    const source = value.source ?? "SYSTEM";
    const sourceWeight = normalizeSourceWeight(value.sourceWeight);
    const microstructure = buildMicrostructureSnapshot(
      marketKey,
      value.instrumentCode,
      value.exchangeCode,
      sourceExchange,
      sourceWeight,
      normalizedBids,
      normalizedAsks,
      value.updatedAt,
      value.lastSequence ?? value.sequence,
      value.ttbLatencyMs ?? null,
      value.isSynced ?? true
    );

    bids.set(marketKey, bidBook);
    asks.set(marketKey, askBook);
    sync.set(marketKey, {
      marketKey,
      source,
      source_exchange: sourceExchange,
      sourceWeight,
      instrumentCode: value.instrumentCode,
      exchangeCode: value.exchangeCode,
      lastSequence: value.lastSequence ?? value.sequence,
      lastSnapshotAt: value.updatedAt,
      lastDeltaAt: value.updatedAt,
      lastDesyncAt: value.isSynced ? null : value.isSynced === undefined ? null : value.updatedAt,
      desyncReason: value.desyncReason ?? null,
      isSynced: value.isSynced ?? true,
      tickSize,
      ttbLatencyMs: value.ttbLatencyMs ?? null,
      lastCrossCheckAt: 0
    });
    snapshots.set(marketKey, {
      marketKey,
      source,
      source_exchange: sourceExchange,
      sourceWeight,
      instrumentCode: value.instrumentCode,
      exchangeCode: value.exchangeCode,
      bids: normalizedBids,
      asks: normalizedAsks,
      bestBid: microstructure.bestBid,
      bestAsk: microstructure.bestAsk,
      midPrice: microstructure.midPrice,
      spread: microstructure.spread,
      spreadBps: microstructure.spreadBps,
      weightedImbalance: microstructure.weightedImbalance,
      lastSequence: microstructure.lastSequence,
      tickSize: value.tickSize ?? DEFAULT_ORDER_BOOK_TICK_SIZE,
      ttbLatencyMs: microstructure.timeToBookMs,
      isSynced: microstructure.isSynced,
      desyncReason: value.desyncReason ?? null,
      sequence: value.sequence,
      updatedAt: value.updatedAt
    });
  }

  return { snapshots, bids, asks, sync };
}

export function hydrateLegacyLevel(value: InternalOrderBook, side: OrderBookSide): PriceLevel[] {
  const legacy = value as unknown as {
    bid?: number | null;
    ask?: number | null;
    lastSize?: number;
    updatedAt: string;
  };
  const price = side === "bid" ? legacy.bid : legacy.ask;

  if (typeof price !== "number") {
    return [];
  }

  return [
    {
      price: roundCrypto(price),
      size: roundCrypto(legacy.lastSize ?? 0),
      updatedAt: legacy.updatedAt
    }
  ];
}

export function levelsToBookSide(
  levels: PriceLevel[],
  side: OrderBookSide,
  tickSize: number
): SortedBookSide {
  const book = new SortedBookSide(side);

  for (const level of levels) {
    book.upsert(level.price, level.size, level.updatedAt, tickSize);
  }

  return book;
}

export function tickToDelta(tick: MarketTick): BookDeltaWithTicker {
  const side = resolveBookSide(tick);

  if (!side) {
    throw new Error("UNKNOWN_ORDER_BOOK_SIDE");
  }

  return {
    schemaVersion: "order-book.delta.v1",
    source: tick.source,
    source_exchange: tick.source_exchange,
    exchangeCode: tick.exchangeCode,
    instrumentCode: tick.instrumentCode,
    marketKey: buildMarketKey(tick.source_exchange, tick.instrumentCode),
    sourceWeight: tick.sourceWeight,
    sequence: tick.sequence,
    exchangeTimestamp: tick.exchangeTimestamp,
    receivedAt: tick.receivedAt,
    tickSize: tick.tickSize,
    side,
    price: tick.price,
    size: tick.size,
    bestBid: tick.bestBid,
    bestAsk: tick.bestAsk
  };
}

export function calculateTimeToBookMs(exchangeTimestamp: string, bookTimestamp: string): number {
  return Math.max(
    0,
    parseTimestampMs(bookTimestamp, "book_timestamp") -
      parseTimestampMs(exchangeTimestamp, "exchange_timestamp")
  );
}

export function resolveTickSize(env: Env, instrumentCode: string, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override;
  }

  const configured = parseTickSizeMap(env.ORDER_BOOK_TICK_SIZES)[instrumentCode];

  if (configured !== undefined) {
    return configured;
  }

  return readPositiveNumber(env.ORDER_BOOK_TICK_SIZE_DEFAULT, DEFAULT_ORDER_BOOK_TICK_SIZE);
}

export function resolveDomBinSize(env: Env, instrumentCode: string, fallback: number): number {
  const configured = parsePositiveNumberMap(env.DOM_PRICE_BIN_SIZES)[instrumentCode];

  if (configured !== undefined) {
    return configured;
  }

  return readPositiveNumber(env.DOM_PRICE_BIN_SIZE_DEFAULT, fallback);
}

export function parseTickSizeMap(value: string | undefined): Record<string, number> {
  return parsePositiveNumberMap(value);
}

export function parsePositiveNumberMap(value: string | undefined): Record<string, number> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const entries = Object.entries(parsed)
      .map(
        ([instrumentCode, rawValue]) => [instrumentCode.toLowerCase(), Number(rawValue)] as const
      )
      .filter(([, numericValue]) => Number.isFinite(numericValue) && numericValue > 0);

    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}
