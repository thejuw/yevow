import { describe, expect, it } from "vitest";
import {
  applyBookSnapshotSideEffects,
  bookDesyncStorageExtra,
  bookSnapshotRuntimeArtifacts,
  bookSnapshotTelemetry,
  bookSnapshotStorageWrites,
  markBookSyncDesynced,
  rejectedBookDeltaIngestResult,
  shouldEmitBookSnapshotTelemetry,
  stateAfterAcceptedBookDelta,
  stateAfterBookSnapshot,
  stateAfterDesyncedBook,
  stateAfterInformationalBookNotReady,
  stateAfterOrderBookReset,
  stateAfterRejectedBookDelta,
  stateAfterRebuiltBookSnapshot,
  type BookSnapshotSideEffectHandlers
} from "../../src/engine/trading/book/BookRuntimeState";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import type {
  DomAnalysisSnapshot,
  InternalOrderBook,
  LatencyMetrics,
  MarketTick,
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

  it("builds compact snapshot telemetry payloads", () => {
    expect(
      bookSnapshotTelemetry({
        instrumentCode: "btc-usd",
        exchangeCode: "hyperliquid",
        sequence: 42,
        bidLevels: 20,
        askLevels: 19,
        tickSize: 0.5,
        timeToBookMs: 3
      })
    ).toEqual({
      instrumentCode: "btc-usd",
      exchangeCode: "hyperliquid",
      sequence: 42,
      bidLevels: 20,
      askLevels: 19,
      tickSize: 0.5,
      timeToBookMs: 3
    });
  });

  it("builds snapshot storage writes with book and DOM history keys", () => {
    const state = defaultEngineState("book-storage");
    const snapshotBook = book({ marketKey: "hyperliquid:hype-usd", instrumentCode: "hype-usd" });
    const domWallHistory = [dom("hype-usd")];

    expect(
      bookSnapshotStorageWrites({
        engineStateKey: "engine:state",
        state,
        domWallHistoryKey: "dom:walls",
        domWallHistory,
        orderBookPrefix: "book:",
        marketKey: snapshotBook.marketKey,
        book: snapshotBook
      })
    ).toEqual({
      "engine:state": state,
      "dom:walls": domWallHistory,
      "book:hyperliquid:hype-usd": snapshotBook
    });
  });

  it("assembles snapshot runtime artifacts with storage and telemetry", () => {
    const currentState = defaultEngineState("book-snapshot-runtime");
    const snapshotBook = book({ marketKey: "hyperliquid:hype-usd", instrumentCode: "hype-usd" });
    const domSnapshot = dom("hype-usd");
    const artifacts = bookSnapshotRuntimeArtifacts({
      currentState,
      book: snapshotBook,
      internalOrderBookDepth: 8,
      priceDiscovery: priceDiscovery("hype-usd", 5),
      dom: domSnapshot,
      updatedAt: OBSERVED_AT,
      engineStateKey: "engine:state",
      domWallHistoryKey: "dom:walls",
      domWallHistory: [domSnapshot],
      orderBookPrefix: "book:",
      marketKey: snapshotBook.marketKey,
      telemetryEnabled: true,
      snapshotSource: "ADMIN",
      processedTicks: 999,
      earlyTickLimit: 5,
      telemetryInterval: 1_000,
      applied: {
        instrumentCode: "hype-usd",
        exchangeCode: "hyperliquid",
        sequence: 42,
        bidLevels: 3,
        askLevels: 4,
        tickSize: 0.001,
        timeToBookMs: 2
      }
    });

    expect(artifacts.state).toMatchObject({
      internalOrderBookDepth: 8,
      microstructure: { instrumentCode: "hype-usd" },
      priceDiscovery: { instrumentCode: "hype-usd", weightedMidPrice: 5 },
      dom: domSnapshot
    });
    expect(artifacts.storageWrites).toEqual({
      "engine:state": artifacts.state,
      "dom:walls": [domSnapshot],
      "book:hyperliquid:hype-usd": snapshotBook
    });
    expect(artifacts.shouldEmitTelemetry).toBe(true);
    expect(artifacts.telemetry).toEqual({
      instrumentCode: "hype-usd",
      exchangeCode: "hyperliquid",
      sequence: 42,
      bidLevels: 3,
      askLevels: 4,
      tickSize: 0.001,
      timeToBookMs: 2
    });
  });

  it("applies snapshot persistence and telemetry side effects in order", async () => {
    const currentState = defaultEngineState("book-snapshot-effects");
    const snapshotBook = book({ marketKey: "hyperliquid:hype-usd", instrumentCode: "hype-usd" });
    const artifacts = bookSnapshotRuntimeArtifacts({
      currentState,
      book: snapshotBook,
      internalOrderBookDepth: 8,
      priceDiscovery: priceDiscovery("hype-usd", 5),
      dom: dom("hype-usd"),
      updatedAt: OBSERVED_AT,
      engineStateKey: "engine:state",
      domWallHistoryKey: "dom:walls",
      domWallHistory: [],
      orderBookPrefix: "book:",
      marketKey: snapshotBook.marketKey,
      telemetryEnabled: true,
      snapshotSource: "ADMIN",
      processedTicks: 999,
      earlyTickLimit: 5,
      telemetryInterval: 1_000,
      applied: {
        instrumentCode: "hype-usd",
        exchangeCode: "hyperliquid",
        sequence: 42,
        bidLevels: 3,
        askLevels: 4,
        tickSize: 0.001,
        timeToBookMs: 2
      }
    });
    const sideEffects = bookSnapshotSideEffectSpy();

    await applyBookSnapshotSideEffects(artifacts, { persist: true }, sideEffects.handlers);

    expect(sideEffects.events).toEqual([
      "persist:ORDER_BOOK_SNAPSHOT_APPLIED:3",
      "log:42",
      "publish:42"
    ]);
  });

  it("skips snapshot persistence and telemetry when disabled", async () => {
    const currentState = defaultEngineState("book-snapshot-effects");
    const snapshotBook = book();
    const artifacts = bookSnapshotRuntimeArtifacts({
      currentState,
      book: snapshotBook,
      internalOrderBookDepth: 8,
      priceDiscovery: priceDiscovery("btc-usd", 100),
      dom: dom("btc-usd"),
      updatedAt: OBSERVED_AT,
      engineStateKey: "engine:state",
      domWallHistoryKey: "dom:walls",
      domWallHistory: [],
      orderBookPrefix: "book:",
      marketKey: snapshotBook.marketKey,
      telemetryEnabled: false,
      snapshotSource: "HYPERLIQUID",
      processedTicks: 999,
      earlyTickLimit: 5,
      telemetryInterval: 1_000,
      applied: {
        instrumentCode: "btc-usd",
        exchangeCode: "hyperliquid",
        sequence: 42,
        bidLevels: 3,
        askLevels: 4,
        tickSize: 0.001,
        timeToBookMs: 2
      }
    });
    const sideEffects = bookSnapshotSideEffectSpy();

    await applyBookSnapshotSideEffects(artifacts, { persist: false }, sideEffects.handlers);

    expect(sideEffects.events).toEqual([]);
  });

  it("marks informational ticks as book-not-ready without mutating quote state when disabled", () => {
    const currentState = defaultEngineState("engine-test");
    currentState.processedTicks = 4;
    const disabled = stateAfterInformationalBookNotReady({
      currentState,
      tradingEnabled: false,
      instrumentCode: "btc-usd",
      maxLatencyMs: 150,
      observedAt: OBSERVED_AT
    });

    expect(disabled.processedTicks).toBe(5);
    expect(disabled.quoteState).toBe(currentState.quoteState);
    expect(disabled.assetQuoteStates).toBe(currentState.assetQuoteStates);
    expect(disabled.maxLatencyMs).toBe(150);
    expect(disabled.updatedAt).toBe(OBSERVED_AT);
  });

  it("suspends the instrument quote state when trading is enabled but no book exists", () => {
    const currentState = defaultEngineState("engine-test");
    currentState.quoteState = {
      status: "ACTIVE",
      reason: null,
      suspendedUntil: null,
      lastQuote: null,
      updatedAt: OBSERVED_AT
    };
    currentState.assetQuoteStates = Object.fromEntries(
      Object.keys(currentState.assetQuoteStates).map((instrumentCode) => [
        instrumentCode,
        {
          status: "ACTIVE" as const,
          reason: null,
          suspendedUntil: null,
          lastQuote: null,
          updatedAt: OBSERVED_AT
        }
      ])
    );

    const next = stateAfterInformationalBookNotReady({
      currentState,
      tradingEnabled: true,
      instrumentCode: "btc-usd",
      maxLatencyMs: 150,
      observedAt: OBSERVED_AT
    });

    expect(next.processedTicks).toBe(1);
    expect(next.quoteState).toMatchObject({
      status: "ACTIVE",
      reason: "PARTIAL_ASSET_SUSPENSION"
    });
    expect(next.assetQuoteStates["btc-usd"]).toMatchObject({
      status: "SUSPENDED",
      reason: "ORDER_BOOK_NOT_READY"
    });
  });

  it("updates compact state after rejected book deltas", () => {
    const currentState = defaultEngineState("engine-test");
    currentState.processedTicks = 8;
    currentState.internalOrderBookDepth = 12;

    const next = stateAfterRejectedBookDelta({
      currentState,
      internalOrderBookDepth: 7,
      maxLatencyMs: 150,
      observedAt: OBSERVED_AT
    });

    expect(next).toMatchObject({
      processedTicks: 9,
      internalOrderBookDepth: 7,
      maxLatencyMs: 150,
      heartbeatAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT
    });
    expect(next.microstructure).toBe(currentState.microstructure);
  });

  it("maps rejected book deltas to ingest statuses", () => {
    const metrics = latencyMetrics({ sequence: 11 });

    expect(
      rejectedBookDeltaIngestResult({
        applied: {
          accepted: false,
          reason: "SEQUENCE_GAP",
          expectedSequence: 10,
          actualSequence: 11,
          timeToBookMs: null
        },
        metrics
      })
    ).toMatchObject({
      accepted: false,
      status: "DESYNC",
      reason: "SEQUENCE_GAP",
      metrics
    });
    expect(
      rejectedBookDeltaIngestResult({
        applied: {
          accepted: false,
          reason: "DUPLICATE_OR_OUT_OF_ORDER",
          actualSequence: 11,
          timeToBookMs: null
        },
        metrics
      })
    ).toMatchObject({
      accepted: false,
      status: "DUPLICATE_OR_OUT_OF_ORDER",
      reason: "DUPLICATE_OR_OUT_OF_ORDER"
    });
  });

  it("marks book sync and visible microstructure desynced without changing unrelated state", () => {
    const currentState = defaultEngineState("book-desync");
    currentState.processedTicks = 12;
    currentState.microstructure = micro({ isSynced: true, midPrice: 100 });
    const syncState = {
      marketKey: "hyperliquid:btc-usd",
      source: "HYPERLIQUID" as const,
      source_exchange: "hyperliquid",
      sourceWeight: 1,
      instrumentCode: "btc-usd",
      exchangeCode: "hyperliquid",
      lastSequence: 7,
      lastSnapshotAt: null,
      lastDeltaAt: null,
      lastDesyncAt: null,
      desyncReason: null,
      isSynced: true,
      tickSize: 0.5,
      ttbLatencyMs: null,
      lastCrossCheckAt: 0
    };

    markBookSyncDesynced({
      syncState,
      reason: "NATIVE_HL_LATENCY",
      observedAt: OBSERVED_AT
    });
    const result = stateAfterDesyncedBook({
      currentState,
      book: book(),
      reason: "NATIVE_HL_LATENCY"
    });

    expect(syncState).toMatchObject({
      isSynced: false,
      desyncReason: "NATIVE_HL_LATENCY",
      lastDesyncAt: OBSERVED_AT
    });
    expect(result.book).toMatchObject({
      isSynced: false,
      desyncReason: "NATIVE_HL_LATENCY"
    });
    expect(result.state.microstructure).toMatchObject({
      isSynced: false,
      midPrice: 100
    });
    expect(result.state.processedTicks).toBe(12);
  });

  it("builds persisted book desync snapshots with stable storage keys", () => {
    const tick = marketTick({ sequence: 11 });
    const metrics = latencyMetrics({ sequence: 11 });

    expect(
      bookDesyncStorageExtra({
        tick,
        metrics,
        reason: "SEQUENCE_GAP",
        expectedSequence: 10,
        actualSequence: 11
      })
    ).toEqual({
      "bookDesync:hyperliquid:btc-usd:11": {
        tick,
        metrics,
        reason: "SEQUENCE_GAP",
        expectedSequence: 10,
        actualSequence: 11
      }
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

function marketTick(overrides: Partial<MarketTick> = {}): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    baseAsset: "BTC",
    quoteAsset: "USD",
    price: 100,
    size: 1,
    side: "buy",
    sequence: 7,
    exchangeTimestamp: OBSERVED_AT,
    synchronizedExchangeTimestamp: OBSERVED_AT,
    clockOffsetMs: 0,
    receivedAt: OBSERVED_AT,
    sourceWeight: 1,
    ...overrides
  };
}

function latencyMetrics(overrides: Partial<LatencyMetrics> = {}): LatencyMetrics {
  return {
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    source: "HYPERLIQUID",
    sourceExchange: "hyperliquid",
    sourceWeight: 1,
    sequence: 7,
    providerTimestamp: OBSERVED_AT,
    sourceTimestamp: OBSERVED_AT,
    ingestTimestamp: OBSERVED_AT,
    brainTimestamp: OBSERVED_AT,
    clockOffsetMs: 0,
    networkLatencyMs: 1,
    processingLatencyMs: 2,
    totalLatencyMs: 3,
    maxLatencyMs: 150,
    averageLatencyMs: 3,
    sampleCount: 1,
    status: "FRESH",
    colo: "NRT",
    placement: "tokyo",
    latencyRiskMultiplier: 1,
    positionSizeMultiplier: 1,
    ...overrides
  };
}

function bookSnapshotSideEffectSpy(): {
  events: string[];
  handlers: BookSnapshotSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      persistStorage(writes, reason) {
        events.push(`persist:${reason}:${Object.keys(writes).length}`);
        return Promise.resolve();
      },
      logSnapshotApplied(metadata) {
        events.push(`log:${metadata.sequence}`);
      },
      publishSnapshotApplied(payload) {
        events.push(`publish:${payload.sequence}`);
      }
    }
  };
}
