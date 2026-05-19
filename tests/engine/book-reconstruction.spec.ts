import { describe, expect, it } from "vitest";
import {
  buildMicrostructureSnapshot,
  countBookLevels,
  getInstrumentBook,
  isCrossedBook,
  microstructureFromBook,
  rebuildBookSnapshotFromSides
} from "../../src/engine/trading/book/BookReconstruction";
import type { SortedBookSide } from "../../src/engine/trading/book/SortedBookSide";
import type { BookSyncState } from "../../src/engine/trading/book/BookTypes";
import type { InternalOrderBook } from "../../src/types";

const OBSERVED_AT = "2026-05-18T05:00:00.000Z";

function syncState(overrides: Partial<BookSyncState> = {}): BookSyncState {
  return {
    marketKey: "hyperliquid:btc-usd",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceWeight: 1,
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    lastSequence: 7,
    lastSnapshotAt: OBSERVED_AT,
    lastDeltaAt: OBSERVED_AT,
    lastDesyncAt: null,
    desyncReason: null,
    isSynced: true,
    tickSize: 0.5,
    ttbLatencyMs: 2,
    lastCrossCheckAt: 0,
    ...overrides
  };
}

describe("BookReconstruction", () => {
  it("creates book sides lazily and counts depth", () => {
    const bids = new Map<string, SortedBookSide>();
    const asks = new Map<string, SortedBookSide>();
    const bidBook = getInstrumentBook(bids, "hyperliquid:btc-usd", "bid");
    const sameBidBook = getInstrumentBook(bids, "hyperliquid:btc-usd", "bid");
    const askBook = getInstrumentBook(asks, "hyperliquid:btc-usd", "ask");

    bidBook.upsert(100, 1, OBSERVED_AT, 0.5);
    askBook.upsert(101, 1, OBSERVED_AT, 0.5);

    expect(sameBidBook).toBe(bidBook);
    expect(countBookLevels(bids, asks)).toBe(2);
  });

  it("builds microstructure and detects crossed books", () => {
    const microstructure = buildMicrostructureSnapshot(
      "hyperliquid:btc-usd",
      "btc-usd",
      "hyperliquid",
      "hyperliquid",
      1,
      [{ price: 100, size: 2, updatedAt: OBSERVED_AT }],
      [{ price: 101, size: 1, updatedAt: OBSERVED_AT }],
      OBSERVED_AT,
      7,
      2,
      true
    );

    expect(microstructure).toMatchObject({
      bestBid: 100,
      bestAsk: 101,
      midPrice: 100.5,
      spread: 1,
      bidVolume: 2,
      askVolume: 1,
      weightedImbalance: 0.33333333,
      depthLevels: 2
    });

    const book = {
      marketKey: "hyperliquid:btc-usd",
      source: "HYPERLIQUID",
      source_exchange: "hyperliquid",
      sourceWeight: 1,
      instrumentCode: "btc-usd",
      exchangeCode: "hyperliquid",
      bids: [{ price: 101, size: 1, updatedAt: OBSERVED_AT }],
      asks: [{ price: 100, size: 1, updatedAt: OBSERVED_AT }],
      bestBid: 101,
      bestAsk: 100,
      midPrice: 100.5,
      spread: -1,
      spreadBps: null,
      weightedImbalance: 0,
      lastSequence: 7,
      tickSize: 0.5,
      ttbLatencyMs: 2,
      isSynced: true,
      desyncReason: null,
      sequence: 7,
      updatedAt: OBSERVED_AT
    } satisfies InternalOrderBook;

    expect(isCrossedBook(book)).toBe(true);
    expect(microstructureFromBook({ ...book, bestBid: 100, bestAsk: 101 })).toMatchObject({
      bestBid: 101,
      bestAsk: 100
    });
  });

  it("rebuilds an internal book snapshot from side stores", () => {
    const bids = new Map<string, SortedBookSide>();
    const asks = new Map<string, SortedBookSide>();
    getInstrumentBook(bids, "hyperliquid:btc-usd", "bid").upsert(100, 1, OBSERVED_AT, 0.5);
    getInstrumentBook(asks, "hyperliquid:btc-usd", "ask").upsert(101, 2, OBSERVED_AT, 0.5);

    const rebuilt = rebuildBookSnapshotFromSides({
      bids,
      asks,
      syncState: syncState(),
      marketKey: "hyperliquid:btc-usd",
      instrumentCode: "btc-usd",
      exchangeCode: "hyperliquid",
      sourceExchange: "hyperliquid",
      source: "HYPERLIQUID",
      sourceWeight: 1,
      sequence: 8,
      updatedAt: OBSERVED_AT,
      timeToBookMs: 3,
      topLevels: 10
    });

    expect(rebuilt.book).toMatchObject({
      marketKey: "hyperliquid:btc-usd",
      bestBid: 100,
      bestAsk: 101,
      midPrice: 100.5,
      tickSize: 0.5,
      sequence: 8,
      ttbLatencyMs: 3,
      isSynced: true
    });
    expect(rebuilt.microstructure.weightedImbalance).toBe(-0.33333333);
  });
});
