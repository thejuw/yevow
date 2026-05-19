import { describe, expect, it } from "vitest";
import {
  OrderBookReconstructor,
  type OrderBookStores
} from "../../src/engine/trading/book/OrderBookReconstructor";
import type { SortedBookSide } from "../../src/engine/trading/book/SortedBookSide";
import type { BookDeltaWithTicker } from "../../src/engine/trading/book/BookTypes";
import type { JsonRecord, OrderBookResetRequest, OrderBookSnapshot } from "../../src/types";

const EXCHANGE_AT = "2026-05-18T05:00:00.000Z";
const OBSERVED_AT = "2026-05-18T05:00:00.002Z";

interface CapturedEvent {
  kind: "warn" | "error" | "publish";
  eventType: string;
  message?: string;
  payload: JsonRecord;
}

function createHarness() {
  const stores: OrderBookStores = {
    orderBook: new Map(),
    bids: new Map(),
    asks: new Map(),
    sync: new Map()
  };
  const events: CapturedEvent[] = [];
  const resets: Partial<OrderBookResetRequest>[] = [];
  const reconstructor = new OrderBookReconstructor(stores, {
    topLevels: 50,
    topOfBookCrossCheckIntervalMs: 0,
    resolveTickSize: (_instrumentCode, override) => override ?? 0.5,
    normalizeSourceExchange: (value) => (value ?? "hyperliquid").toLowerCase(),
    normalizeMarketKey: (value) => value.toLowerCase(),
    buildMarketKey: (sourceExchange, instrumentCode) => `${sourceExchange}:${instrumentCode}`,
    normalizeSourceWeight: (value) => (typeof value === "number" ? value : 1),
    calculateTimeToBookMs: (exchangeTimestamp, bookTimestamp) =>
      Date.parse(bookTimestamp) - Date.parse(exchangeTimestamp),
    warn: (eventType, message, payload) =>
      events.push({ kind: "warn", eventType, message, payload }),
    error: (eventType, message, payload) =>
      events.push({ kind: "error", eventType, message, payload }),
    publish: (eventType, payload) => events.push({ kind: "publish", eventType, payload }),
    resetOrderBook: async (payload) => {
      resets.push(payload);
    }
  });

  return { events, reconstructor, resets, stores };
}

function snapshot(overrides: Partial<OrderBookSnapshot> = {}): OrderBookSnapshot {
  return {
    schemaVersion: "order-book.snapshot.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    sourceWeight: 1,
    sequence: 10,
    exchangeTimestamp: EXCHANGE_AT,
    receivedAt: OBSERVED_AT,
    tickSize: 0.5,
    bids: [{ price: 100, size: 2, updatedAt: OBSERVED_AT }],
    asks: [{ price: 101, size: 1, updatedAt: OBSERVED_AT }],
    ...overrides
  };
}

function delta(overrides: Partial<BookDeltaWithTicker> = {}): BookDeltaWithTicker {
  return {
    schemaVersion: "order-book.delta.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    sourceWeight: 1,
    sequence: 11,
    exchangeTimestamp: EXCHANGE_AT,
    receivedAt: OBSERVED_AT,
    tickSize: 0.5,
    side: "bid",
    price: 100.5,
    size: 3,
    bestBid: 100.5,
    bestAsk: 101,
    ...overrides
  };
}

describe("OrderBookReconstructor", () => {
  it("applies snapshots into side stores, sync state, and top-level books", () => {
    const { reconstructor, stores } = createHarness();
    const applied = reconstructor.applySnapshot(snapshot(), OBSERVED_AT);

    expect(applied).toMatchObject({
      marketKey: "hyperliquid:btc-usd",
      instrumentCode: "btc-usd",
      exchangeCode: "hyperliquid",
      sequence: 10,
      bidLevels: 1,
      askLevels: 1,
      timeToBookMs: 2
    });
    expect(stores.orderBook.get("hyperliquid:btc-usd")).toMatchObject({
      bestBid: 100,
      bestAsk: 101,
      midPrice: 100.5,
      isSynced: true
    });
    expect(stores.sync.get("hyperliquid:btc-usd")).toMatchObject({
      lastSequence: 10,
      lastSnapshotAt: OBSERVED_AT,
      desyncReason: null,
      isSynced: true
    });
  });

  it("applies in-sequence deltas and mutates the existing book", async () => {
    const { reconstructor, stores } = createHarness();
    reconstructor.applySnapshot(snapshot(), OBSERVED_AT);

    const applied = await reconstructor.applyDelta(delta(), OBSERVED_AT);

    expect(applied.accepted).toBe(true);
    expect(applied.book).toMatchObject({
      bestBid: 100.5,
      bestAsk: 101,
      sequence: 11,
      weightedImbalance: 0.66666667
    });
    expect(stores.sync.get("hyperliquid:btc-usd")).toMatchObject({
      lastSequence: 11,
      lastDeltaAt: OBSERVED_AT,
      desyncReason: null
    });
  });

  it("rejects duplicate or out-of-order deltas without resetting the book", async () => {
    const { events, reconstructor, resets } = createHarness();
    reconstructor.applySnapshot(snapshot(), OBSERVED_AT);

    const applied = await reconstructor.applyDelta(delta({ sequence: 10 }), OBSERVED_AT);

    expect(applied).toMatchObject({
      accepted: false,
      reason: "DUPLICATE_OR_OUT_OF_ORDER",
      actualSequence: 10
    });
    expect(resets).toHaveLength(0);
    expect(events.some((event) => event.eventType === "ORDER_BOOK_DELTA_IGNORED")).toBe(true);
  });

  it("detects Hyperliquid sequence gaps and requests a reset", async () => {
    const { events, reconstructor, resets, stores } = createHarness();
    reconstructor.applySnapshot(snapshot(), OBSERVED_AT);

    const applied = await reconstructor.applyDelta(delta({ sequence: 12 }), OBSERVED_AT);

    expect(applied).toMatchObject({
      accepted: false,
      reason: "SEQUENCE_GAP",
      expectedSequence: 11,
      actualSequence: 12
    });
    expect(stores.sync.get("hyperliquid:btc-usd")).toMatchObject({
      isSynced: false,
      desyncReason: "SEQUENCE_GAP"
    });
    expect(resets[0]).toMatchObject({
      reason: "SEQUENCE_GAP",
      instrumentCode: "btc-usd",
      source_exchange: "hyperliquid"
    });
    expect(events.some((event) => event.eventType === "ORDER_BOOK_DESYNC")).toBe(true);
  });

  it("detects crossed books from deltas and snapshot recovery", async () => {
    const { events, reconstructor, resets, stores } = createHarness();
    reconstructor.applySnapshot(snapshot(), OBSERVED_AT);

    const applied = await reconstructor.applyDelta(
      delta({ bestBid: 102, bestAsk: 101, price: 102 }),
      OBSERVED_AT
    );

    expect(applied).toMatchObject({
      accepted: false,
      reason: "CROSSED_BOOK",
      actualSequence: 11
    });
    expect(stores.sync.get("hyperliquid:btc-usd")).toMatchObject({
      isSynced: false,
      desyncReason: "CROSSED_BOOK"
    });
    expect(resets[0]).toMatchObject({ reason: "CROSSED_BOOK" });
    expect(events.some((event) => event.eventType === "ORDER_BOOK_CROSSED")).toBe(true);
  });

  it("flags top-of-book mismatches without rejecting the accepted delta", async () => {
    const { events, reconstructor, stores } = createHarness();
    reconstructor.applySnapshot(snapshot(), OBSERVED_AT);

    const applied = await reconstructor.applyDelta(delta({ bestBid: 200 }), OBSERVED_AT);

    expect(applied.accepted).toBe(true);
    expect(stores.sync.get("hyperliquid:btc-usd")).toMatchObject({
      isSynced: false,
      desyncReason: "TOP_OF_BOOK_MISMATCH"
    });
    expect(events.some((event) => event.eventType === "ORDER_BOOK_CROSS_CHECK_FAILED")).toBe(true);
  });

  it("can rebind to newly hydrated stores after replay or Durable Object startup", () => {
    const { reconstructor } = createHarness();
    const nextStores: OrderBookStores = {
      orderBook: new Map(),
      bids: new Map<string, SortedBookSide>(),
      asks: new Map<string, SortedBookSide>(),
      sync: new Map()
    };

    reconstructor.replaceStores(nextStores);
    reconstructor.applySnapshot(snapshot({ sequence: 21 }), OBSERVED_AT);

    expect(nextStores.orderBook.get("hyperliquid:btc-usd")).toMatchObject({ sequence: 21 });
  });
});
