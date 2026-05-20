import { describe, expect, it } from "vitest";
import {
  applyOrderBookResetConnectionIds,
  applyOrderBookResetSideEffects,
  applyOrderBookResetStores,
  orderBookResetConnectionKeys,
  orderBookResetDeleteKeys,
  orderBookResetRuntimeArtifacts,
  orderBookResetTelemetry,
  resolveOrderBookReset
} from "../../src/engine/trading/book/OrderBookResetRuntime";
import { SortedBookSide } from "../../src/engine/trading/book/SortedBookSide";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
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

  it("applies reset connection ids to active ingest connection keys", () => {
    const connections = new Map<string, string>([["hyperliquid:old", "conn-old"]]);

    applyOrderBookResetConnectionIds(connections, "conn-1", ["hyperliquid:book"]);
    applyOrderBookResetConnectionIds(connections, null, ["hyperliquid:ignored"]);

    expect(connections).toEqual(
      new Map([
        ["hyperliquid:old", "conn-old"],
        ["hyperliquid:book", "conn-1"]
      ])
    );
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

  it("assembles reset runtime artifacts and mutates the scoped book state", () => {
    const stores = storeSet();
    const reset = resolveOrderBookReset(
      {
        source: "INGEST_WORKER",
        reason: "STREAM_RECOVERED",
        streamId: "book",
        instrumentCode: "BTC-USD",
        source_exchange: "hyperliquid",
        connectionId: "conn-1"
      },
      "2026-05-18T14:00:00.000Z"
    );

    const artifacts = orderBookResetRuntimeArtifacts({
      reset,
      currentState: defaultEngineState("order-book-reset"),
      persistedBooks: new Map<string, InternalOrderBook>([
        ["book:hyperliquid:btc-usd", {} as InternalOrderBook],
        ["book:hyperliquid:eth-usd", {} as InternalOrderBook]
      ]),
      orderBookPrefix: "book:",
      engineStateKey: "engine:state",
      stores,
      orderBookSize: stores.orderBook.size,
      internalOrderBookDepth: 7,
      priceDiscovery: null
    });

    expect(stores.orderBook.has("hyperliquid:btc-usd")).toBe(false);
    expect(stores.orderBook.has("hyperliquid:eth-usd")).toBe(true);
    expect(artifacts.deleteKeys).toEqual(["book:hyperliquid:btc-usd"]);
    expect(artifacts.connectionKeys).toEqual(["hyperliquid:book"]);
    expect(artifacts.writes["engine:state"]).toBe(artifacts.state);
    expect(artifacts.state.internalOrderBookDepth).toBe(7);
    expect(artifacts.state.heartbeatAt).toBe("2026-05-18T14:00:00.000Z");
    expect(artifacts.latencyResetReason).toBe("ORDER_BOOK_RESET:STREAM_RECOVERED");
    expect(artifacts.telemetry).toMatchObject({
      reason: "STREAM_RECOVERED",
      marketKey: "hyperliquid:btc-usd",
      deletedBookSnapshots: 1
    });
  });

  it("applies reset side effects in the expected operational order", async () => {
    const reset = resolveOrderBookReset(
      {
        source: "INGEST_WORKER",
        reason: "STREAM_RECOVERED",
        streamId: "book",
        instrumentCode: "BTC-USD",
        source_exchange: "hyperliquid",
        connectionId: "conn-1"
      },
      "2026-05-18T14:00:00.000Z"
    );
    const artifacts = orderBookResetRuntimeArtifacts({
      reset,
      currentState: defaultEngineState("order-book-reset-side-effects"),
      persistedBooks: new Map<string, InternalOrderBook>([
        ["book:hyperliquid:btc-usd", {} as InternalOrderBook]
      ]),
      orderBookPrefix: "book:",
      engineStateKey: "engine:state",
      stores: storeSet(),
      orderBookSize: 1,
      internalOrderBookDepth: 0,
      priceDiscovery: null
    });
    const calls: string[] = [];

    await applyOrderBookResetSideEffects(reset, artifacts, {
      resetLatencyBaseline(observedAt, reason) {
        calls.push(`latency:${observedAt}:${reason}`);
      },
      applyConnectionIds(connectionId, connectionKeys) {
        calls.push(`connections:${connectionId}:${connectionKeys.join(",")}`);
      },
      async persistWrites(writes) {
        calls.push(`persist:${Object.keys(writes).join(",")}`);
      },
      async deleteStorageKeys(keys) {
        calls.push(`delete:${keys.join(",")}`);
      },
      logReset(telemetry) {
        calls.push(`log:${telemetry.reason as string}`);
      },
      publishReset(telemetry) {
        calls.push(`publish:${telemetry.reason as string}`);
      }
    });

    expect(calls).toEqual([
      "latency:2026-05-18T14:00:00.000Z:ORDER_BOOK_RESET:STREAM_RECOVERED",
      "connections:conn-1:hyperliquid:book",
      "persist:engine:state",
      "delete:book:hyperliquid:btc-usd",
      "log:STREAM_RECOVERED",
      "publish:STREAM_RECOVERED"
    ]);
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
