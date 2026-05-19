import { describe, expect, it } from "vitest";
import {
  calculateOrderBookPriceDiscovery,
  currentBookForMarketTick,
  currentOrderBookSnapshot,
  findBestAssetBook,
  selectOrderBookMarketKey
} from "../../src/engine/trading/book/BookViews";
import { SortedBookSide } from "../../src/engine/trading/book/SortedBookSide";
import type { BookSyncState } from "../../src/engine/trading/book/BookTypes";
import type { InternalOrderBook, MarketTick, MicrostructureMetrics } from "../../src/types";

const OBSERVED_AT = "2026-05-18T06:00:00.000Z";

describe("BookViews", () => {
  it("selects market keys from ticks, current microstructure, and instrument candidates", () => {
    const orderBook = new Map<string, InternalOrderBook>([
      [
        "binance:btc-usd",
        book({
          marketKey: "binance:btc-usd",
          source: "BINANCE",
          source_exchange: "binance",
          sourceWeight: 0.5,
          updatedAt: "2026-05-18T05:59:59.000Z"
        })
      ],
      [
        "hyperliquid:btc-usd",
        book({
          marketKey: "hyperliquid:btc-usd",
          sourceWeight: 1.25,
          updatedAt: OBSERVED_AT
        })
      ]
    ]);
    const microstructure = micro({ marketKey: "binance:btc-usd", instrumentCode: "btc-usd" });

    expect(selectOrderBookMarketKey({ orderBook, microstructure })).toEqual({
      marketKey: "binance:btc-usd",
      instrumentCode: "btc-usd"
    });
    expect(selectOrderBookMarketKey({ orderBook, microstructure }, "BTC")).toEqual({
      marketKey: "hyperliquid:btc-usd",
      instrumentCode: "btc-usd"
    });
    expect(selectOrderBookMarketKey({ orderBook, microstructure }, "hyperliquid:btc-usd")).toEqual({
      marketKey: "hyperliquid:btc-usd",
      instrumentCode: "btc-usd"
    });
    expect(
      selectOrderBookMarketKey({ orderBook, microstructure }, {
        source_exchange: "HyperLiquid",
        instrumentCode: "ETH-USD"
      } as MarketTick)
    ).toEqual({ marketKey: "hyperliquid:eth-usd", instrumentCode: "eth-usd" });
    expect(selectOrderBookMarketKey({ orderBook, microstructure }, "SOL")).toBeNull();
  });

  it("finds the healthiest asset book when the current market key is unavailable", () => {
    const stale = book({
      marketKey: "binance:eth-usd",
      source_exchange: "binance",
      source: "BINANCE",
      instrumentCode: "eth-usd",
      isSynced: false,
      midPrice: 2000,
      updatedAt: "2026-05-18T05:59:59.000Z"
    });
    const healthy = book({
      marketKey: "hyperliquid:eth-usd",
      instrumentCode: "eth-usd",
      isSynced: true,
      midPrice: 2001,
      updatedAt: "2026-05-18T05:59:58.000Z"
    });
    const orderBook = new Map([
      [stale.marketKey, stale],
      [healthy.marketKey, healthy]
    ]);

    expect(findBestAssetBook(orderBook, "ETH-USD")).toBe(healthy);
    expect(findBestAssetBook(orderBook, "BTC-USD")).toBeUndefined();
    expect(
      selectOrderBookMarketKey(
        {
          orderBook,
          microstructure: micro({ marketKey: "missing:eth-usd", instrumentCode: "eth-usd" })
        },
        undefined
      )
    ).toEqual({ marketKey: "hyperliquid:eth-usd", instrumentCode: "eth-usd" });
  });

  it("selects the direct market book for incoming ticks before falling back by source quality", () => {
    const binanceBook = book({
      marketKey: "binance:btc-usd",
      source: "BINANCE",
      source_exchange: "binance",
      sourceWeight: 2,
      updatedAt: "2026-05-18T06:00:02.000Z"
    });
    const hyperliquidBook = book({
      marketKey: "hyperliquid:btc-usd",
      sourceWeight: 1,
      updatedAt: OBSERVED_AT
    });
    const orderBook = new Map<string, InternalOrderBook>([
      [hyperliquidBook.marketKey, hyperliquidBook],
      [binanceBook.marketKey, binanceBook]
    ]);

    expect(
      currentBookForMarketTick(orderBook, {
        source_exchange: "hyperliquid",
        instrumentCode: "BTC-USD"
      } as MarketTick)
    ).toBe(hyperliquidBook);
  });

  it("falls back to the highest weighted current book for the tick instrument", () => {
    const older = book({
      marketKey: "binance:btc-usd",
      source: "BINANCE",
      source_exchange: "binance",
      sourceWeight: 2,
      updatedAt: "2026-05-18T06:00:01.000Z"
    });
    const newest = book({
      marketKey: "okx:btc-usd",
      source: "OKX",
      source_exchange: "okx",
      sourceWeight: 2,
      updatedAt: "2026-05-18T06:00:02.000Z"
    });
    const lowerWeight = book({
      marketKey: "kraken:btc-usd",
      source: "KRAKEN",
      source_exchange: "kraken",
      sourceWeight: 1,
      updatedAt: "2026-05-18T06:00:03.000Z"
    });
    const orderBook = new Map<string, InternalOrderBook>([
      [older.marketKey, older],
      [lowerWeight.marketKey, lowerWeight],
      [newest.marketKey, newest]
    ]);

    expect(
      currentBookForMarketTick(orderBook, {
        source_exchange: "coinbase",
        instrumentCode: "BTC-USD"
      } as MarketTick)
    ).toBe(newest);
  });

  it("calculates weighted price discovery without allocating sorted source clones", () => {
    const orderBook = new Map<string, InternalOrderBook>([
      [
        "hyperliquid:btc-usd",
        book({ marketKey: "hyperliquid:btc-usd", sourceWeight: 3, midPrice: 100 })
      ],
      [
        "binance:btc-usd",
        book({
          marketKey: "binance:btc-usd",
          source: "BINANCE",
          source_exchange: "binance",
          sourceWeight: 1,
          midPrice: 104
        })
      ],
      ["okx:eth-usd", book({ marketKey: "okx:eth-usd", instrumentCode: "eth-usd", midPrice: 9 })],
      ["kraken:btc-usd", book({ marketKey: "kraken:btc-usd", source: "KRAKEN", midPrice: null })]
    ]);

    expect(calculateOrderBookPriceDiscovery(orderBook, "btc-usd", OBSERVED_AT)).toMatchObject({
      instrumentCode: "btc-usd",
      weightedMidPrice: 101,
      primaryExchange: "hyperliquid",
      primaryWeight: 3,
      sourceCount: 2,
      updatedAt: OBSERVED_AT
    });
    expect(calculateOrderBookPriceDiscovery(orderBook, "sol-usd", OBSERVED_AT)).toMatchObject({
      instrumentCode: "sol-usd",
      weightedMidPrice: null,
      primaryExchange: null,
      primaryWeight: 0,
      sourceCount: 0,
      updatedAt: null
    });
    expect(calculateOrderBookPriceDiscovery(orderBook, undefined, OBSERVED_AT)).toMatchObject({
      instrumentCode: null,
      weightedMidPrice: 82.6,
      primaryExchange: "hyperliquid",
      sourceCount: 3,
      updatedAt: OBSERVED_AT
    });
  });

  it("builds current snapshots from side stores and sync fallback state", () => {
    const orderBook = new Map<string, InternalOrderBook>();
    const bids = new Map<string, SortedBookSide>();
    const asks = new Map<string, SortedBookSide>();
    const bid = new SortedBookSide("bid");
    const ask = new SortedBookSide("ask");
    bid.upsert(99.5, 2, OBSERVED_AT, 0.5);
    bid.upsert(99, 1, OBSERVED_AT, 0.5);
    ask.upsert(100.5, 3, OBSERVED_AT, 0.5);
    bids.set("hyperliquid:btc-usd", bid);
    asks.set("hyperliquid:btc-usd", ask);
    orderBook.set(
      "hyperliquid:btc-usd",
      book({
        marketKey: "hyperliquid:btc-usd",
        bestBid: 99.5,
        bestAsk: 100.5,
        midPrice: 100,
        spread: 1,
        sequence: 42,
        lastSequence: 42
      })
    );

    const snapshot = currentOrderBookSnapshot(
      {
        orderBook,
        bids,
        asks,
        microstructure: micro({ marketKey: "hyperliquid:btc-usd", instrumentCode: "btc-usd" }),
        defaultSourceWeight: 1,
        resolveTickSize: () => 0.5,
        getBookSync: (_marketKey, instrumentCode) => syncState({ instrumentCode })
      },
      undefined,
      1
    );

    expect(snapshot).toMatchObject({
      marketKey: "hyperliquid:btc-usd",
      instrumentCode: "btc-usd",
      sequence: 7,
      tickSize: 0.5,
      bestBid: 99.5,
      bestAsk: 100.5,
      midPrice: 100,
      bids: [{ price: 99.5, size: 2, updatedAt: OBSERVED_AT }],
      asks: [{ price: 100.5, size: 3, updatedAt: OBSERVED_AT }]
    });
  });

  it("builds snapshots from sync fallback when no local book has been reconstructed", () => {
    const bids = new Map<string, SortedBookSide>();
    const asks = new Map<string, SortedBookSide>();
    const syncCalls: {
      marketKey: string;
      instrumentCode: string;
      sourceExchange: string;
      sourceWeight: number;
    }[] = [];

    const snapshot = currentOrderBookSnapshot(
      {
        orderBook: new Map(),
        bids,
        asks,
        microstructure: micro({
          instrumentCode: "hype-usd",
          exchangeCode: "hyperliquid",
          source_exchange: "hyperliquid",
          sourceWeight: 0.75
        }),
        defaultSourceWeight: 1,
        resolveTickSize: (instrumentCode) => (instrumentCode === "hype-usd" ? 0.001 : 0.5),
        getBookSync: (
          marketKey,
          instrumentCode,
          _exchangeCode,
          sourceExchange,
          _tickSize,
          _source,
          sourceWeight
        ) => {
          syncCalls.push({ marketKey, instrumentCode, sourceExchange, sourceWeight });
          return syncState({
            marketKey,
            instrumentCode,
            source_exchange: sourceExchange,
            sourceWeight,
            exchangeCode: null,
            lastSequence: null,
            isSynced: false,
            tickSize: 0.001,
            ttbLatencyMs: null
          });
        }
      },
      undefined,
      5
    );

    expect(syncCalls).toEqual([
      {
        marketKey: "hype-usd",
        instrumentCode: "hype-usd",
        sourceExchange: "hyperliquid",
        sourceWeight: 1
      }
    ]);
    expect(snapshot).toMatchObject({
      marketKey: "hype-usd",
      instrumentCode: "hype-usd",
      exchangeCode: null,
      source_exchange: "hyperliquid",
      sourceWeight: 1,
      sequence: null,
      isSynced: false,
      tickSize: 0.001,
      bestBid: null,
      bestAsk: null,
      bids: [],
      asks: [],
      updatedAt: null
    });
  });
});

function book(overrides: Partial<InternalOrderBook> = {}): InternalOrderBook {
  return {
    marketKey: "hyperliquid:btc-usd",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceWeight: 1,
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    bids: [{ price: 99, size: 1, updatedAt: OBSERVED_AT }],
    asks: [{ price: 101, size: 1, updatedAt: OBSERVED_AT }],
    bestBid: 99,
    bestAsk: 101,
    midPrice: 100,
    spread: 2,
    spreadBps: 200,
    weightedImbalance: 0,
    lastSequence: 7,
    tickSize: 0.5,
    ttbLatencyMs: 2,
    isSynced: true,
    desyncReason: null,
    sequence: 7,
    updatedAt: OBSERVED_AT,
    ...overrides
  };
}

function micro(overrides: Partial<MicrostructureMetrics> = {}): MicrostructureMetrics {
  return {
    marketKey: null,
    instrumentCode: null,
    exchangeCode: null,
    source_exchange: null,
    sourceWeight: 0,
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    spread: null,
    spreadBps: null,
    bidVolume: 0,
    askVolume: 0,
    weightedImbalance: null,
    depthLevels: 0,
    lastSequence: null,
    timeToBookMs: null,
    isSynced: false,
    updatedAt: null,
    ...overrides
  };
}

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
