import { describe, expect, it } from "vitest";
import {
  shouldEmitBookSnapshotTelemetry,
  stateAfterAcceptedBookDelta,
  stateAfterBookSnapshot,
  stateAfterOrderBookReset,
  stateAfterRebuiltBookSnapshot
} from "../../src/engine/trading/book/BookRuntimeState";
import { defaultEngineState } from "../../src/TradingEngineRuntimeHelpers";
import type {
  DomAnalysisSnapshot,
  InternalOrderBook,
  MicrostructureMetrics,
  PriceDiscoveryMetrics
} from "../../src/types";

const OBSERVED_AT = "2026-05-18T07:00:00.000Z";

describe("BookRuntimeState", () => {
  it("preserves unrelated microstructure on scoped resets and defaults full resets", () => {
    const currentState = defaultEngineState("engine-test");
    currentState.microstructure = micro({ marketKey: "hyperliquid:btc-usd" });

    const scoped = stateAfterOrderBookReset({
      currentState,
      resetMarketKey: "hyperliquid:eth-usd",
      resetInstrument: "eth-usd",
      orderBookSize: 1,
      internalOrderBookDepth: 4,
      now: OBSERVED_AT,
      priceDiscovery: priceDiscovery("eth-usd", 2500)
    });

    expect(scoped.microstructure.marketKey).toBe("hyperliquid:btc-usd");
    expect(scoped.internalOrderBookDepth).toBe(4);
    expect(scoped.priceDiscovery).toMatchObject({
      instrumentCode: "eth-usd",
      weightedMidPrice: 2500
    });
    expect(scoped.dom).toBeNull();
    expect(scoped.updatedAt).toBe(OBSERVED_AT);

    const full = stateAfterOrderBookReset({
      currentState: scoped,
      resetMarketKey: null,
      resetInstrument: null,
      orderBookSize: 0,
      internalOrderBookDepth: 0,
      now: OBSERVED_AT,
      priceDiscovery: null
    });

    expect(full.microstructure.marketKey).toBeNull();
    expect(full.priceDiscovery.weightedMidPrice).toBeNull();
  });

  it("updates engine state after snapshots, accepted deltas, and rebuilt books", () => {
    const currentState = defaultEngineState("engine-test");
    const snapshotBook = book({ bestBid: 99, bestAsk: 101, midPrice: 100 });
    const snapshotState = stateAfterBookSnapshot({
      currentState,
      book: snapshotBook,
      internalOrderBookDepth: 6,
      priceDiscovery: priceDiscovery("btc-usd", 100),
      dom: dom("btc-usd"),
      updatedAt: OBSERVED_AT
    });

    expect(snapshotState).toMatchObject({
      internalOrderBookDepth: 6,
      microstructure: { marketKey: "hyperliquid:btc-usd", midPrice: 100 },
      priceDiscovery: { weightedMidPrice: 100 },
      dom: { instrumentCode: "btc-usd" },
      heartbeatAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT
    });

    const deltaState = stateAfterAcceptedBookDelta({
      currentState: snapshotState,
      book: book({
        bids: [{ price: 100, size: 1, updatedAt: OBSERVED_AT }],
        asks: [{ price: 102, size: 1, updatedAt: OBSERVED_AT }],
        bestBid: 100,
        bestAsk: 102,
        midPrice: 101
      }),
      priceDiscovery: priceDiscovery("btc-usd", 101)
    });

    expect(deltaState.microstructure.midPrice).toBe(101);
    expect(deltaState.priceDiscovery.weightedMidPrice).toBe(101);
    expect(deltaState.heartbeatAt).toBe(OBSERVED_AT);

    const rebuiltState = stateAfterRebuiltBookSnapshot({
      currentState: deltaState,
      microstructure: micro({ marketKey: "hyperliquid:hype-usd", midPrice: 5 }),
      priceDiscovery: priceDiscovery("hype-usd", 5)
    });

    expect(rebuiltState.microstructure.marketKey).toBe("hyperliquid:hype-usd");
    expect(rebuiltState.priceDiscovery.instrumentCode).toBe("hype-usd");
  });

  it("gates snapshot telemetry by explicit disable, source, early ticks, and cadence", () => {
    expect(
      shouldEmitBookSnapshotTelemetry({
        telemetryEnabled: false,
        snapshotSource: "ADMIN",
        processedTicks: 1,
        earlyTickLimit: 5,
        interval: 1000
      })
    ).toBe(false);
    expect(
      shouldEmitBookSnapshotTelemetry({
        telemetryEnabled: true,
        snapshotSource: "ADMIN",
        processedTicks: 999,
        earlyTickLimit: 5,
        interval: 1000
      })
    ).toBe(true);
    expect(
      shouldEmitBookSnapshotTelemetry({
        telemetryEnabled: true,
        snapshotSource: "HYPERLIQUID",
        processedTicks: 5,
        earlyTickLimit: 5,
        interval: 1000
      })
    ).toBe(true);
    expect(
      shouldEmitBookSnapshotTelemetry({
        telemetryEnabled: true,
        snapshotSource: "HYPERLIQUID",
        processedTicks: 2000,
        earlyTickLimit: 5,
        interval: 1000
      })
    ).toBe(true);
    expect(
      shouldEmitBookSnapshotTelemetry({
        telemetryEnabled: true,
        snapshotSource: "HYPERLIQUID",
        processedTicks: 999,
        earlyTickLimit: 5,
        interval: 1000
      })
    ).toBe(false);
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

function priceDiscovery(instrumentCode: string, weightedMidPrice: number): PriceDiscoveryMetrics {
  return {
    instrumentCode,
    weightedMidPrice,
    primaryExchange: "hyperliquid",
    primaryWeight: 1,
    sourceCount: 1,
    sources: [],
    updatedAt: OBSERVED_AT
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

function dom(instrumentCode: string): DomAnalysisSnapshot {
  return {
    schemaVersion: "dom.analysis.v1",
    instrumentCode,
    exchangeCode: "hyperliquid",
    sequence: 7,
    midPrice: 100,
    scanRangePct: 0.02,
    lowerBound: 98,
    upperBound: 102,
    binSize: 10,
    meanVolume: 1,
    sigmaVolume: 0.1,
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
