import { describe, expect, it } from "vitest";
import {
  applyOrderBookResetStores,
  orderBookResetConnectionKeys,
  orderBookResetDeleteKeys,
  orderBookResetTelemetry,
  resolveOrderBookReset
} from "../../src/engine/trading/book/OrderBookResetRuntime";
import { SortedBookSide } from "../../src/engine/trading/book/SortedBookSide";
import type { BookSyncState } from "../../src/engine/trading/book/BookTypes";
import type { InternalOrderBook } from "../../src/types";

describe("OrderBookResetRuntime", () => {
  it("resolves scoped reset parameters and storage delete keys", () => {
    const reset = resolveOrderBookReset(
      {
        source: "INGEST_WORKER",
        reason: "STREAM_RECOVERED",
        streamId: "book",
        instrumentCode: "BTC-USD",
        source_exchange: "HyperLiquid",
        connectionId: "conn-1",
        blackoutDurationMs: 12.6,
        recoveredAt: "2026-05-18T14:00:02.000Z"
      },
      "2026-05-18T14:00:00.000Z"
    );

    expect(reset).toEqual({
      now: "2026-05-18T14:00:00.000Z",
      reason: "STREAM_RECOVERED",
      source: "INGEST_WORKER",
      blackoutDurationMs: 13,
      resetInstrument: "btc-usd",
      resetSourceExchange: "hyperliquid",
      resetStreamId: "book",
      resetMarketKey: "hyperliquid:btc-usd",
      recoveredAt: "2026-05-18T14:00:02.000Z",
      connectionId: "conn-1"
    });

    const persistedBooks = new Map<string, InternalOrderBook>([
      ["order-book:hyperliquid:btc-usd", {} as InternalOrderBook],
      ["order-book:hyperliquid:eth-usd", {} as InternalOrderBook]
    ]);

    expect(orderBookResetDeleteKeys(persistedBooks, "order-book:", "hyperliquid:btc-usd")).toEqual([
      "order-book:hyperliquid:btc-usd"
    ]);
    expect(orderBookResetDeleteKeys(persistedBooks, "order-book:", null)).toEqual([
      "order-book:hyperliquid:btc-usd",
      "order-book:hyperliquid:eth-usd"
    ]);
    expect(orderBookResetConnectionKeys(reset)).toEqual(["hyperliquid:book"]);
    expect(orderBookResetTelemetry(reset, 1)).toEqual({
      reason: "STREAM_RECOVERED",
      source: "INGEST_WORKER",
      streamId: "book",
      instrumentCode: "btc-usd",
      source_exchange: "hyperliquid",
      marketKey: "hyperliquid:btc-usd",
      connectionId: "conn-1",
      blackoutDurationMs: 13,
      recoveredAt: "2026-05-18T14:00:02.000Z",
      deletedBookSnapshots: 1
    });
  });

  it("resolves ingest connection keys with hyperliquid defaults", () => {
    expect(
      orderBookResetConnectionKeys({
        ...resolveOrderBookReset({
          source: "INGEST_WORKER",
          connectionId: "conn-default"
        }),
        resetSourceExchange: null
      })
    ).toEqual(["hyperliquid:default"]);
    expect(orderBookResetConnectionKeys(resolveOrderBookReset({ source: "ADMIN" }))).toEqual([]);
  });

  it("mutates only scoped book stores unless reset is global", () => {
    const stores = storeSet();

    applyOrderBookResetStores(stores, "hyperliquid:btc-usd");

    expect(stores.orderBook.has("hyperliquid:btc-usd")).toBe(false);
    expect(stores.orderBook.has("hyperliquid:eth-usd")).toBe(true);
    expect(stores.bids.has("hyperliquid:btc-usd")).toBe(false);
    expect(stores.asks.has("hyperliquid:btc-usd")).toBe(false);
    expect(stores.sync.has("hyperliquid:btc-usd")).toBe(false);

    applyOrderBookResetStores(stores, null);

    expect(stores.orderBook.size).toBe(0);
    expect(stores.bids.size).toBe(0);
    expect(stores.asks.size).toBe(0);
    expect(stores.sync.size).toBe(0);
  });
});

function storeSet(): {
  orderBook: Map<string, InternalOrderBook>;
  bids: Map<string, SortedBookSide>;
  asks: Map<string, SortedBookSide>;
  sync: Map<string, BookSyncState>;
} {
  return {
    orderBook: new Map([
      ["hyperliquid:btc-usd", {} as InternalOrderBook],
      ["hyperliquid:eth-usd", {} as InternalOrderBook]
    ]),
    bids: new Map([
      ["hyperliquid:btc-usd", new SortedBookSide("bid")],
      ["hyperliquid:eth-usd", new SortedBookSide("bid")]
    ]),
    asks: new Map([
      ["hyperliquid:btc-usd", new SortedBookSide("ask")],
      ["hyperliquid:eth-usd", new SortedBookSide("ask")]
    ]),
    sync: new Map([
      ["hyperliquid:btc-usd", {} as BookSyncState],
      ["hyperliquid:eth-usd", {} as BookSyncState]
    ])
  };
}
