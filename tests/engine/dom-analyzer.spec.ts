import { describe, expect, it } from "vitest";
import {
  appendDomHistory,
  buildDomAnalysisSnapshot,
  currentDomHeatmapSnapshot,
  type DomAnalyzerContext
} from "../../src/engine/trading/book/DomAnalyzer";
import { SortedBookSide } from "../../src/engine/trading/book/SortedBookSide";
import type {
  DomAnalysisSnapshot,
  InternalOrderBook,
  LiquidityWall,
  MarketTick,
  MicrostructureMetrics
} from "../../src/types";

const OBSERVED_AT = "2026-05-18T08:00:00.000Z";

describe("DomAnalyzer", () => {
  it("returns cached heatmaps and empty snapshots for unavailable books", () => {
    const context = domContext({ microstructure: micro({ instrumentCode: "btc-usd" }) });
    const cached = emptyDom("btc-usd");

    expect(currentDomHeatmapSnapshot(context, cached, "btc-usd", OBSERVED_AT)).toBe(cached);

    const snapshot = buildDomAnalysisSnapshot(context, "eth-usd", OBSERVED_AT, undefined, false);
    expect(snapshot).toMatchObject({
      instrumentCode: "eth-usd",
      exchangeCode: null,
      sequence: null,
      midPrice: null,
      walls: [],
      heatmap: { cells: [] },
      updatedAt: OBSERVED_AT
    });
  });

  it("builds bounded DOM heatmap cells from side stores", () => {
    const bids = new Map<string, SortedBookSide>();
    const asks = new Map<string, SortedBookSide>();
    const bid = new SortedBookSide("bid");
    const ask = new SortedBookSide("ask");
    bid.upsert(99.5, 2, OBSERVED_AT, 0.5);
    bid.upsert(99, 1, OBSERVED_AT, 0.5);
    ask.upsert(100.5, 3, OBSERVED_AT, 0.5);
    bids.set("hyperliquid:btc-usd", bid);
    asks.set("hyperliquid:btc-usd", ask);

    const snapshot = buildDomAnalysisSnapshot(
      domContext({
        orderBook: new Map([["hyperliquid:btc-usd", book()]]),
        bids,
        asks,
        microstructure: micro({ marketKey: "hyperliquid:btc-usd", instrumentCode: "btc-usd" })
      }),
      undefined,
      OBSERVED_AT,
      undefined,
      false
    );

    expect(snapshot).toMatchObject({
      instrumentCode: "btc-usd",
      lowerBound: 98,
      upperBound: 102,
      binSize: 0.5,
      heatmap: {
        cells: [
          [0, 99.5, 100, 2, 1, expect.any(Number)],
          [0, 99, 99.5, 1, 1, expect.any(Number)],
          [1, 100.5, 101, 3, 1, expect.any(Number)]
        ]
      }
    });
    expect(snapshot.history).toEqual([]);
  });

  it("classifies missing active walls and persists bounded history", () => {
    const history = [wall("dom:btc-usd:ask:test")];
    const tick = marketTick({ side: "buy", price: 100.8 });

    const snapshot = buildDomAnalysisSnapshot(
      domContext({
        orderBook: new Map([["hyperliquid:btc-usd", book()]]),
        domWallHistory: history,
        domWallHistoryLimit: 2,
        microstructure: micro({ marketKey: "hyperliquid:btc-usd", instrumentCode: "btc-usd" })
      }),
      "btc-usd",
      OBSERVED_AT,
      tick,
      true
    );

    expect(snapshot.pulledWalls).toMatchObject([
      {
        wallId: "dom:btc-usd:ask:test",
        status: "PULLED",
        spoofingSuspected: true,
        lastSequence: 99
      }
    ]);
    expect(history).toHaveLength(2);
    expect(snapshot.history.at(-1)).toMatchObject({ status: "PULLED" });

    const pruned = appendDomHistory(history, 2, [
      wall("new-1", { lastSeenAt: "2026-05-18T08:00:01.000Z" })
    ]);

    expect(pruned).toHaveLength(2);
    expect(history[0]?.wallId).toBe("dom:btc-usd:ask:test");
    expect(history[1]?.wallId).toBe("new-1");
  });
});

function domContext(overrides: Partial<DomAnalyzerContext> = {}): DomAnalyzerContext {
  return {
    orderBook: new Map(),
    bids: new Map(),
    asks: new Map(),
    microstructure: micro(),
    domWallHistory: [],
    domWallHistoryLimit: 20,
    domScanRangePct: 0.02,
    domSpoofProximityBps: 25,
    domMaxLevelsPerSide: 100,
    resolveBinSize: () => 0.5,
    ...overrides
  };
}

function book(overrides: Partial<InternalOrderBook> = {}): InternalOrderBook {
  return {
    marketKey: "hyperliquid:btc-usd",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceWeight: 1,
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    bids: [],
    asks: [],
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

function emptyDom(instrumentCode: string): DomAnalysisSnapshot {
  return {
    schemaVersion: "dom.analysis.v1",
    instrumentCode,
    exchangeCode: null,
    sequence: null,
    midPrice: null,
    scanRangePct: 0.02,
    lowerBound: null,
    upperBound: null,
    binSize: 0.5,
    meanVolume: 0,
    sigmaVolume: 0,
    walls: [],
    pulledWalls: [],
    filledWalls: [],
    heatmap: {
      schemaVersion: "dom.heatmap.v1",
      columns: ["side", "priceStart", "priceEnd", "volume", "levelCount", "zScore"],
      sideEncoding: { bid: 0, ask: 1 },
      cells: []
    },
    history: [],
    updatedAt: OBSERVED_AT
  };
}

function wall(wallId: string, overrides: Partial<LiquidityWall> = {}): LiquidityWall {
  return {
    wallId,
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    side: "ask",
    priceStart: 101,
    priceEnd: 102,
    centerPrice: 101.5,
    volume: 10,
    meanVolume: 1,
    sigmaVolume: 1,
    zScore: 9,
    levelCount: 1,
    status: "ACTIVE",
    firstSeenAt: "2026-05-18T07:59:00.000Z",
    lastSeenAt: "2026-05-18T07:59:00.000Z",
    lastSequence: 7,
    distanceFromMidBps: 150,
    spoofingSuspected: false,
    ...overrides
  };
}

function marketTick(overrides: Partial<MarketTick> = {}): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    streamId: "trades",
    connectionId: "connection",
    sourceChannel: "trades",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    baseAsset: "btc",
    quoteAsset: "usd",
    price: 100,
    size: 1,
    side: "buy",
    sequence: 99,
    providerTimestamp: OBSERVED_AT,
    exchangeTimestamp: OBSERVED_AT,
    synchronizedExchangeTimestamp: OBSERVED_AT,
    clockOffsetMs: 0,
    receivedAt: OBSERVED_AT,
    sourceWeight: 1,
    raw: {},
    ...overrides
  };
}
