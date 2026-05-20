import type {
  InternalOrderBook,
  JsonRecord,
  MarketDataSource,
  OrderBookDelta,
  OrderBookResetRequest,
  OrderBookSnapshot
} from "../../../types";
import {
  getInstrumentBook,
  isCrossedBook,
  rebuildBookSnapshotFromSides,
  type RebuiltBookSnapshot
} from "./BookReconstruction";
import type { AppliedBookUpdate, BookDeltaWithTicker, BookSyncState } from "./BookTypes";
import {
  applyDeltaBookSyncState,
  applySnapshotBookSyncState,
  getOrCreateBookSyncState,
  markBookDesynced
} from "./BookSyncRuntime";
import { SortedBookSide } from "./SortedBookSide";

export interface AppliedBookSnapshot {
  book: InternalOrderBook;
  marketKey: string;
  instrumentCode: string;
  exchangeCode: string;
  sourceExchange: string;
  source: MarketDataSource;
  sequence: number;
  bidLevels: number;
  askLevels: number;
  tickSize: number;
  timeToBookMs: number | null;
}

export interface OrderBookStores {
  orderBook: Map<string, InternalOrderBook>;
  bids: Map<string, SortedBookSide>;
  asks: Map<string, SortedBookSide>;
  sync: Map<string, BookSyncState>;
}

export interface OrderBookReconstructorConfig {
  topLevels: number;
  topOfBookCrossCheckIntervalMs: number;
  resolveTickSize(instrumentCode: string, override?: number): number;
  normalizeSourceExchange(value: string | null | undefined): string;
  normalizeMarketKey(value: string): string;
  buildMarketKey(sourceExchange: string, instrumentCode: string): string;
  normalizeSourceWeight(value: unknown): number;
  calculateTimeToBookMs(exchangeTimestamp: string, bookTimestamp: string): number;
  warn(eventType: string, message: string, metadata: JsonRecord): void;
  error(eventType: string, message: string, metadata: JsonRecord): void;
  publish(type: string, payload: JsonRecord): void;
  resetOrderBook(payload: Partial<OrderBookResetRequest>): Promise<void>;
}

export class OrderBookReconstructor {
  constructor(
    private stores: OrderBookStores,
    private readonly config: OrderBookReconstructorConfig
  ) {}

  replaceStores(stores: OrderBookStores): void {
    this.stores = stores;
  }

  applySnapshot(snapshot: OrderBookSnapshot, updatedAt: string): AppliedBookSnapshot {
    const instrumentCode = snapshot.instrumentCode.toLowerCase();
    const exchangeCode = snapshot.exchangeCode.toLowerCase();
    const sourceExchange = this.config.normalizeSourceExchange(
      snapshot.source_exchange ?? snapshot.exchangeCode
    );
    const marketKey = this.config.normalizeMarketKey(
      snapshot.marketKey ?? this.config.buildMarketKey(sourceExchange, instrumentCode)
    );
    const sourceWeight = this.config.normalizeSourceWeight(snapshot.sourceWeight);
    const tickSize = this.config.resolveTickSize(instrumentCode, snapshot.tickSize);
    const bidBook = new SortedBookSide("bid");
    const askBook = new SortedBookSide("ask");

    for (const level of snapshot.bids) {
      bidBook.upsert(level.price, level.size, level.updatedAt ?? updatedAt, tickSize);
    }

    for (const level of snapshot.asks) {
      askBook.upsert(level.price, level.size, level.updatedAt ?? updatedAt, tickSize);
    }

    this.stores.bids.set(marketKey, bidBook);
    this.stores.asks.set(marketKey, askBook);

    const timeToBookMs = this.config.calculateTimeToBookMs(snapshot.exchangeTimestamp, updatedAt);
    const source = snapshot.source === "ADMIN" ? "SYSTEM" : snapshot.source;
    const syncState = this.getBookSync(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      tickSize,
      source,
      sourceWeight
    );
    applySnapshotBookSyncState(syncState, {
      exchangeCode,
      sourceExchange,
      sourceWeight,
      sequence: snapshot.sequence,
      observedAt: updatedAt,
      tickSize,
      timeToBookMs
    });

    const { book } = this.rebuildBookSnapshot(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      source,
      sourceWeight,
      snapshot.sequence,
      updatedAt,
      timeToBookMs
    );

    return {
      book,
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      source,
      sequence: snapshot.sequence,
      bidLevels: bidBook.size,
      askLevels: askBook.size,
      tickSize,
      timeToBookMs
    };
  }

  async applyDelta(delta: BookDeltaWithTicker, updatedAt: string): Promise<AppliedBookUpdate> {
    const instrumentCode = delta.instrumentCode.toLowerCase();
    const exchangeCode = delta.exchangeCode.toLowerCase();
    const sourceExchange = this.config.normalizeSourceExchange(
      delta.source_exchange ?? delta.exchangeCode
    );
    const marketKey = this.config.normalizeMarketKey(
      delta.marketKey ?? this.config.buildMarketKey(sourceExchange, instrumentCode)
    );
    const sourceWeight = this.config.normalizeSourceWeight(delta.sourceWeight);
    const tickSize = this.config.resolveTickSize(instrumentCode, delta.tickSize);
    const syncState = this.getBookSync(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      tickSize,
      delta.source,
      sourceWeight
    );
    const wasSnapshotSeeded = syncState.isSynced || syncState.lastSnapshotAt !== null;
    const expectedSequence =
      syncState.lastSequence === null ? undefined : syncState.lastSequence + 1;
    const timeToBookMs = this.config.calculateTimeToBookMs(delta.exchangeTimestamp, updatedAt);
    const enforceExactSequence = delta.source === "HYPERLIQUID";

    if (
      enforceExactSequence &&
      expectedSequence !== undefined &&
      delta.sequence > expectedSequence
    ) {
      await this.handleSequenceGap(delta, expectedSequence, timeToBookMs, updatedAt);
      return {
        accepted: false,
        reason: "SEQUENCE_GAP",
        expectedSequence,
        actualSequence: delta.sequence,
        timeToBookMs
      };
    }

    if (syncState.lastSequence !== null && delta.sequence <= syncState.lastSequence) {
      if (delta.source === "HYPERLIQUID" || delta.sequence % 100 === 0) {
        this.config.warn("ORDER_BOOK_DELTA_IGNORED", "Ignored duplicate/out-of-order book delta", {
          instrumentCode,
          exchangeCode,
          currentSequence: syncState.lastSequence,
          deltaSequence: delta.sequence
        });
      }

      return {
        accepted: false,
        reason: "DUPLICATE_OR_OUT_OF_ORDER",
        expectedSequence,
        actualSequence: delta.sequence,
        timeToBookMs
      };
    }

    const bookSide =
      delta.side === "bid"
        ? getInstrumentBook(this.stores.bids, marketKey, "bid")
        : getInstrumentBook(this.stores.asks, marketKey, "ask");

    bookSide.upsert(delta.price, delta.size, updatedAt, tickSize);

    applyDeltaBookSyncState(syncState, {
      exchangeCode,
      sourceExchange,
      sourceWeight,
      sequence: delta.sequence,
      observedAt: updatedAt,
      wasSnapshotSeeded,
      tickSize,
      timeToBookMs
    });

    const { book } = this.rebuildBookSnapshot(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      delta.source,
      sourceWeight,
      delta.sequence,
      updatedAt,
      timeToBookMs
    );

    if (isCrossedBook(book)) {
      await this.handleCrossedBook(delta, book, timeToBookMs, updatedAt);
      return {
        accepted: false,
        reason: "CROSSED_BOOK",
        expectedSequence,
        actualSequence: delta.sequence,
        timeToBookMs
      };
    }

    this.maybeCrossCheckTopOfBook(delta, book);

    return {
      accepted: true,
      book,
      actualSequence: delta.sequence,
      timeToBookMs
    };
  }

  async handleCrossedBookSnapshot(
    book: InternalOrderBook,
    sequence: number,
    timeToBookMs: number | null,
    observedAt: string
  ): Promise<void> {
    const syncState = this.getBookSync(
      book.marketKey,
      book.instrumentCode,
      book.exchangeCode,
      book.source_exchange,
      book.tickSize,
      book.source,
      book.sourceWeight
    );

    markBookDesynced(syncState, "CROSSED_BOOK", observedAt, timeToBookMs);

    this.logCrossedBook(
      "Crossed snapshot detected; purging local book",
      book,
      sequence,
      timeToBookMs
    );

    await this.config.resetOrderBook({
      source: "SYSTEM",
      reason: "CROSSED_BOOK",
      instrumentCode: book.instrumentCode,
      source_exchange: book.source_exchange,
      connectionId: null,
      blackoutDurationMs: null,
      recoveredAt: observedAt
    });
  }

  rebuildBookSnapshot(
    marketKey: string,
    instrumentCode: string,
    exchangeCode: string,
    sourceExchange: string,
    source: MarketDataSource,
    sourceWeight: number,
    sequence: number,
    updatedAt: string,
    timeToBookMs: number | null
  ): RebuiltBookSnapshot {
    const existingSync = this.stores.sync.get(marketKey);
    const syncState = this.getBookSync(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      existingSync?.tickSize ?? this.config.resolveTickSize(instrumentCode),
      source,
      sourceWeight
    );
    const rebuilt = rebuildBookSnapshotFromSides({
      bids: this.stores.bids,
      asks: this.stores.asks,
      syncState,
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      source,
      sourceWeight,
      sequence,
      updatedAt,
      timeToBookMs,
      topLevels: this.config.topLevels
    });

    this.stores.orderBook.set(marketKey, rebuilt.book);
    return rebuilt;
  }

  getBookSync(
    marketKey: string,
    instrumentCode: string,
    exchangeCode: string | null,
    sourceExchange: string,
    tickSize: number,
    source: MarketDataSource,
    sourceWeight: number
  ): BookSyncState {
    return getOrCreateBookSyncState({
      sync: this.stores.sync,
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      tickSize,
      source,
      sourceWeight
    });
  }

  private async handleSequenceGap(
    delta: OrderBookDelta,
    expectedSequence: number,
    timeToBookMs: number | null,
    observedAt: string
  ): Promise<void> {
    const instrumentCode = delta.instrumentCode.toLowerCase();
    const exchangeCode = delta.exchangeCode.toLowerCase();
    const sourceExchange = this.config.normalizeSourceExchange(
      delta.source_exchange ?? delta.exchangeCode
    );
    const marketKey = this.config.normalizeMarketKey(
      delta.marketKey ?? this.config.buildMarketKey(sourceExchange, instrumentCode)
    );
    const syncState = this.getBookSync(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      this.config.resolveTickSize(instrumentCode, delta.tickSize),
      delta.source,
      this.config.normalizeSourceWeight(delta.sourceWeight)
    );

    markBookDesynced(syncState, "SEQUENCE_GAP", observedAt, timeToBookMs);

    this.config.error("ORDER_BOOK_DESYNC", "Sequence gap detected; purging local book", {
      instrumentCode,
      exchangeCode,
      expectedSequence,
      actualSequence: delta.sequence,
      lastSequence: syncState.lastSequence,
      timeToBookMs
    });
    this.config.publish("ORDER_BOOK_DESYNC", {
      instrumentCode,
      exchangeCode,
      expectedSequence,
      actualSequence: delta.sequence,
      lastSequence: syncState.lastSequence,
      timeToBookMs
    });

    await this.config.resetOrderBook({
      source: "SYSTEM",
      reason: "SEQUENCE_GAP",
      instrumentCode,
      source_exchange: sourceExchange,
      connectionId: null,
      blackoutDurationMs: null,
      recoveredAt: observedAt
    });
  }

  private async handleCrossedBook(
    delta: OrderBookDelta,
    book: InternalOrderBook,
    timeToBookMs: number | null,
    observedAt: string
  ): Promise<void> {
    const syncState = this.getBookSync(
      book.marketKey,
      book.instrumentCode,
      book.exchangeCode,
      book.source_exchange,
      book.tickSize,
      book.source,
      book.sourceWeight
    );

    markBookDesynced(syncState, "CROSSED_BOOK", observedAt, timeToBookMs);

    this.logCrossedBook(
      "Crossed book detected; purging local book",
      book,
      delta.sequence,
      timeToBookMs
    );

    await this.config.resetOrderBook({
      source: "SYSTEM",
      reason: "CROSSED_BOOK",
      instrumentCode: book.instrumentCode,
      source_exchange: book.source_exchange,
      connectionId: null,
      blackoutDurationMs: null,
      recoveredAt: observedAt
    });
  }

  private maybeCrossCheckTopOfBook(delta: BookDeltaWithTicker, book: InternalOrderBook): void {
    const syncState = this.getBookSync(
      book.marketKey,
      delta.instrumentCode.toLowerCase(),
      delta.exchangeCode.toLowerCase(),
      book.source_exchange,
      book.tickSize,
      book.source,
      book.sourceWeight
    );
    const now = Date.now();

    if (now - syncState.lastCrossCheckAt < this.config.topOfBookCrossCheckIntervalMs) {
      return;
    }

    syncState.lastCrossCheckAt = now;

    const rawBestBid = typeof delta.bestBid === "number" ? delta.bestBid : null;
    const rawBestAsk = typeof delta.bestAsk === "number" ? delta.bestAsk : null;
    const bidMismatch =
      rawBestBid !== null &&
      book.bestBid !== null &&
      Math.abs(rawBestBid - book.bestBid) > book.tickSize;
    const askMismatch =
      rawBestAsk !== null &&
      book.bestAsk !== null &&
      Math.abs(rawBestAsk - book.bestAsk) > book.tickSize;

    if (!bidMismatch && !askMismatch) {
      this.config.publish("ORDER_BOOK_CROSS_CHECK", {
        instrumentCode: book.instrumentCode,
        exchangeCode: book.exchangeCode,
        sequence: book.sequence,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        rawBestBid,
        rawBestAsk,
        status: "MATCH"
      });
      return;
    }

    markBookDesynced(
      syncState,
      "TOP_OF_BOOK_MISMATCH",
      new Date().toISOString(),
      syncState.ttbLatencyMs
    );

    this.config.error("ORDER_BOOK_CROSS_CHECK_FAILED", "Top-of-book mismatch detected", {
      instrumentCode: book.instrumentCode,
      exchangeCode: book.exchangeCode,
      sequence: book.sequence,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      rawBestBid,
      rawBestAsk,
      tickSize: book.tickSize
    });
    this.config.publish("ORDER_BOOK_CROSS_CHECK_FAILED", {
      instrumentCode: book.instrumentCode,
      exchangeCode: book.exchangeCode,
      sequence: book.sequence,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      rawBestBid,
      rawBestAsk,
      tickSize: book.tickSize
    });
  }

  private logCrossedBook(
    message: string,
    book: InternalOrderBook,
    sequence: number,
    timeToBookMs: number | null
  ): void {
    const payload = {
      instrumentCode: book.instrumentCode,
      exchangeCode: book.exchangeCode,
      source_exchange: book.source_exchange,
      sequence,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      spread: book.spread,
      timeToBookMs
    };

    this.config.error("ORDER_BOOK_CROSSED", message, payload);
    this.config.publish("ORDER_BOOK_CROSSED", payload);
  }
}
