import { describe, expect, it } from "vitest";
import {
  applyBookDeltaFlow,
  applyBookSnapshotFlow,
  applyBookSnapshotSideEffects,
  applyInformationalBookNotReadyFlow,
  applyInformationalBookNotReadySideEffects,
  applyRejectedBookDeltaFlow,
  applyRejectedBookDeltaSideEffects,
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
  type BookDeltaFlowHandlers,
  type BookEarlyReturnSideEffectHandlers,
  type InformationalBookNotReadyFlowHandlers,
  type RejectedBookDeltaFlowHandlers,
  type BookSnapshotFlowHandlers,
  type BookSnapshotSideEffectHandlers
} from "../../src/engine/trading/book/BookRuntimeState";
import {
  applyTradingBookDelta,
  applyTradingBookDeltaForTarget,
  applyTradingBookSnapshot,
  applyTradingBookSnapshotForTarget,
  type TradingBookApplicationTarget
} from "../../src/engine/trading/book/TradingBookApplicationRuntime";
import {
  handleTradingEngineInformationalBookNotReady,
  handleTradingEngineRejectedBookDelta,
  handleTradingInformationalBookNotReady,
  handleTradingRejectedBookDelta,
  type TradingBookEarlyReturnTarget,
  type TradingBookEarlyReturnHandlers
} from "../../src/engine/trading/book/TradingBookEarlyReturnRuntime";
import type {
  AppliedBookUpdate,
  BookDeltaWithTicker
} from "../../src/engine/trading/book/BookTypes";
import type {
  AppliedBookSnapshot,
  OrderBookReconstructor
} from "../../src/engine/trading/book/OrderBookReconstructor";
import { SortedBookSide } from "../../src/engine/trading/book/SortedBookSide";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import type {
  DomAnalysisSnapshot,
  EngineState,
  InternalOrderBook,
  LatencyMetrics,
  MarketTick,
  MicrostructureMetrics,
  OrderBookSnapshot,
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

  it("orchestrates full book snapshot flow through state, storage, and telemetry", async () => {
    const currentState = defaultEngineState("book-snapshot-flow");
    const sideEffects = bookSnapshotFlowSideEffectSpy(book({ instrumentCode: "hype-usd" }));

    const result = await applyBookSnapshotFlow(
      {
        snapshot: snapshot({ instrumentCode: "hype-usd", source: "ADMIN" }),
        currentState,
        updatedAt: OBSERVED_AT,
        engineStateKey: "engine:state",
        domWallHistoryKey: "dom:walls",
        domWallHistory: [],
        orderBookPrefix: "book:",
        telemetryEnabled: true,
        persist: true,
        earlyTickLimit: 5,
        telemetryInterval: 1_000
      },
      sideEffects.handlers
    );

    expect(result.instrumentCode).toBe("hype-usd");
    expect(sideEffects.events).toEqual([
      "applySnapshot:hype-usd:2026-05-18T07:00:00.000Z",
      "dom:hype-usd",
      "depth",
      "discovery:hype-usd",
      "state:hype-usd",
      "persist:ORDER_BOOK_SNAPSHOT_APPLIED:3",
      "log:42",
      "publish:42"
    ]);
  });

  it("orchestrates accepted book deltas and leaves rejected deltas as-is", async () => {
    const currentState = defaultEngineState("book-delta-flow");
    const accepted = bookDeltaFlowSideEffectSpy({
      accepted: true,
      book: book({ midPrice: 101, bestBid: 100, bestAsk: 102 }),
      timeToBookMs: 2,
      actualSequence: 42
    });
    const rejected = bookDeltaFlowSideEffectSpy({
      accepted: false,
      reason: "SEQUENCE_GAP",
      expectedSequence: 41,
      actualSequence: 42,
      timeToBookMs: null
    });

    const acceptedResult = await applyBookDeltaFlow(
      {
        delta: delta(),
        currentState,
        updatedAt: OBSERVED_AT
      },
      accepted.handlers
    );
    const rejectedResult = await applyBookDeltaFlow(
      {
        delta: delta({ sequence: 43 }),
        currentState,
        updatedAt: OBSERVED_AT
      },
      rejected.handlers
    );

    expect(acceptedResult.accepted).toBe(true);
    expect(accepted.events).toEqual(["applyDelta:42", "discovery:btc-usd", "state:100"]);
    expect(rejectedResult.accepted).toBe(false);
    expect(rejected.events).toEqual(["applyDelta:43"]);
  });

  it("applies trading book snapshots through the reconstructor adapter", async () => {
    const currentState = defaultEngineState("trading-book-snapshot");
    const appliedBook = book({ instrumentCode: "hype-usd" });
    const events: string[] = [];
    const states: EngineState[] = [];

    const result = await applyTradingBookSnapshot(
      {
        snapshot: snapshot({ instrumentCode: "hype-usd", source: "ADMIN" }),
        options: { telemetry: true, persist: true },
        currentState,
        domWallHistory: [],
        reconstructor: {
          applySnapshot(nextSnapshot: OrderBookSnapshot, updatedAt: string) {
            events.push(`applySnapshot:${nextSnapshot.instrumentCode}:${Boolean(updatedAt)}`);
            return appliedSnapshot(appliedBook);
          }
        } as unknown as OrderBookReconstructor,
        orderBook: new Map([[appliedBook.marketKey, appliedBook]]),
        bids: new Map(),
        asks: new Map()
      },
      {
        getDomSnapshot(instrumentCode) {
          events.push(`dom:${instrumentCode}`);
          return dom(instrumentCode);
        },
        applyState(state) {
          states.push(state);
          events.push(`state:${state.microstructure.instrumentCode}`);
        },
        persistStorage(writes, reason) {
          events.push(`persist:${reason}:${Object.keys(writes).length}`);
          return Promise.resolve();
        },
        logSnapshotApplied(metadata) {
          events.push(`log:${String(metadata.sequence)}`);
        },
        publishSnapshotApplied(payload) {
          events.push(`publish:${String(payload.sequence)}`);
        }
      }
    );

    expect(result.instrumentCode).toBe("hype-usd");
    expect(states[0]).toMatchObject({
      engineId: "trading-book-snapshot",
      microstructure: { instrumentCode: "hype-usd" }
    });
    expect(events).toEqual([
      "applySnapshot:hype-usd:true",
      "dom:hype-usd",
      "state:hype-usd",
      "persist:ORDER_BOOK_SNAPSHOT_APPLIED:3",
      "log:42",
      "publish:42"
    ]);
  });

  it("applies trading book deltas through the reconstructor adapter", async () => {
    const appliedBook = book({
      bids: [{ price: 100, size: 1, updatedAt: OBSERVED_AT }],
      asks: [{ price: 102, size: 1, updatedAt: OBSERVED_AT }],
      midPrice: 101,
      bestBid: 100,
      bestAsk: 102
    });
    const states: EngineState[] = [];
    const result = await applyTradingBookDelta(
      {
        delta: delta(),
        currentState: defaultEngineState("trading-book-delta"),
        updatedAt: OBSERVED_AT,
        reconstructor: {
          applyDelta(nextDelta: BookDeltaWithTicker, updatedAt: string) {
            expect(nextDelta.sequence).toBe(42);
            expect(updatedAt).toBe(OBSERVED_AT);
            return Promise.resolve({
              accepted: true,
              book: appliedBook,
              timeToBookMs: 2,
              actualSequence: 42
            });
          }
        } as unknown as OrderBookReconstructor,
        orderBook: new Map([[appliedBook.marketKey, appliedBook]])
      },
      {
        applyState(state) {
          states.push(state);
        }
      }
    );

    expect(result.accepted).toBe(true);
    expect(states[0]).toMatchObject({
      engineId: "trading-book-delta",
      microstructure: { midPrice: 101 },
      priceDiscovery: { instrumentCode: "btc-usd" }
    });
  });

  it("applies trading book updates through a target adapter", async () => {
    const firstBook = book({
      instrumentCode: "hype-usd",
      marketKey: "hyperliquid:hype-usd",
      bids: [{ price: 100, size: 1, updatedAt: OBSERVED_AT }],
      asks: [{ price: 102, size: 1, updatedAt: OBSERVED_AT }],
      midPrice: 101,
      bestBid: 100,
      bestAsk: 102
    });
    const nextBook = {
      ...firstBook,
      bids: [{ price: 101, size: 1, updatedAt: OBSERVED_AT }],
      asks: [{ price: 103, size: 1, updatedAt: OBSERVED_AT }],
      midPrice: 102,
      bestBid: 101,
      bestAsk: 103
    };
    const events: string[] = [];
    const target = {
      engineState: defaultEngineState("trading-book-target"),
      domWallHistory: [],
      orderBookReconstructor: {
        applySnapshot(nextSnapshot: OrderBookSnapshot, updatedAt: string) {
          events.push(`snapshot:${nextSnapshot.instrumentCode}:${Boolean(updatedAt)}`);
          return appliedSnapshot(firstBook);
        },
        applyDelta(nextDelta: BookDeltaWithTicker, updatedAt: string) {
          events.push(`delta:${nextDelta.sequence}:${updatedAt}`);
          return Promise.resolve({
            accepted: true,
            book: nextBook,
            timeToBookMs: 3,
            actualSequence: nextDelta.sequence
          });
        }
      } as unknown as OrderBookReconstructor,
      orderBook: new Map([[firstBook.marketKey, firstBook]]),
      bids: new Map(),
      asks: new Map(),
      env: {},
      domWallHistoryLimit: 50,
      domScanRangePct: 0.02,
      domSpoofProximityBps: 5,
      domPriceBinSize: 1,
      logger: {
        info(eventType: string, _message: string, metadata: Record<string, unknown>) {
          events.push(`log:${eventType}:${String(metadata.sequence)}`);
        }
      },
      safeStoragePut(writes: Record<string, unknown>, reason: string) {
        events.push(`persist:${reason}:${Object.keys(writes).length}`);
        return Promise.resolve();
      },
      publish(type: string, payload: Record<string, unknown>) {
        events.push(`publish:${type}:${String(payload.sequence)}`);
      }
    } as unknown as TradingBookApplicationTarget;

    const snapshotResult = await applyTradingBookSnapshotForTarget(
      snapshot({ instrumentCode: "hype-usd", source: "ADMIN" }),
      { telemetry: true, persist: true },
      target
    );
    const deltaResult = await applyTradingBookDeltaForTarget(
      delta({
        instrumentCode: "hype-usd",
        marketKey: "hyperliquid:hype-usd"
      }),
      OBSERVED_AT,
      target
    );

    expect(snapshotResult.instrumentCode).toBe("hype-usd");
    expect(deltaResult).toMatchObject({ accepted: true, timeToBookMs: 3 });
    expect(target.engineState).toMatchObject({
      engineId: "trading-book-target",
      microstructure: { instrumentCode: "hype-usd", midPrice: 102 },
      priceDiscovery: { instrumentCode: "hype-usd" }
    });
    expect(events).toEqual([
      "snapshot:hype-usd:true",
      "persist:ORDER_BOOK_SNAPSHOT_APPLIED:3",
      "log:ORDER_BOOK_SNAPSHOT_APPLIED:42",
      "publish:ORDER_BOOK_SNAPSHOT_APPLIED:42",
      `delta:42:${OBSERVED_AT}`
    ]);
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

  it("applies book-not-ready early-return side effects", async () => {
    const state = stateAfterInformationalBookNotReady({
      currentState: defaultEngineState("book-not-ready-effects"),
      tradingEnabled: true,
      instrumentCode: "btc-usd",
      maxLatencyMs: 150,
      observedAt: OBSERVED_AT
    });
    const sideEffects = bookEarlyReturnSideEffectSpy();

    await applyInformationalBookNotReadySideEffects(
      {
        state,
        storageWrites: { "engine:state": state },
        tick: marketTick(),
        metrics: latencyMetrics(),
        hotPathStartedAt: 12
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual([
      "state:1",
      "persist:INFORMATIONAL_TICK_BOOK_NOT_READY:1",
      "telemetry:FRESH:12"
    ]);
  });

  it("orchestrates book-not-ready early return with profile and telemetry", async () => {
    const flow = bookNotReadyFlowSpy();
    const result = await applyInformationalBookNotReadyFlow(
      {
        currentState: defaultEngineState("book-not-ready-flow"),
        tradingEnabled: true,
        tick: marketTick(),
        metrics: latencyMetrics(),
        maxLatencyMs: 150,
        wakeUpTimeMs: 3,
        orderBookUpdateMs: 4,
        hotPathStartedAt: 12
      },
      flow.handlers
    );

    expect(result).toMatchObject({
      accepted: false,
      status: "BOOK_NOT_READY",
      reason: "INFORMATIONAL_TICK_WITHOUT_BOOK"
    });
    expect(flow.events).toEqual([
      "profile:3:4",
      "storage:1",
      "state:1",
      "persist:INFORMATIONAL_TICK_BOOK_NOT_READY:1",
      "telemetry:FRESH:12"
    ]);
  });

  it("routes trading informational ticks through the book early-return adapter", async () => {
    const flow = tradingBookEarlyReturnSpy();
    const result = await handleTradingInformationalBookNotReady(
      {
        currentState: defaultEngineState("trading-book-not-ready-flow"),
        tradingEnabled: true,
        tick: marketTick(),
        metrics: latencyMetrics(),
        maxLatencyMs: 150,
        wakeUpTimeMs: 3,
        orderBookUpdateMs: 4,
        hotPathStartedAt: 12
      },
      flow.handlers
    );

    expect(result).toMatchObject({
      accepted: false,
      status: "BOOK_NOT_READY",
      reason: "INFORMATIONAL_TICK_WITHOUT_BOOK"
    });
    expect(flow.events).toEqual([
      "profile:3:4",
      "storage:1",
      "state:1:0",
      "persist:INFORMATIONAL_TICK_BOOK_NOT_READY:1",
      "telemetry:FRESH:12"
    ]);
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

  it("applies rejected-delta early-return side effects", async () => {
    const state = stateAfterRejectedBookDelta({
      currentState: defaultEngineState("book-rejected-effects"),
      internalOrderBookDepth: 7,
      maxLatencyMs: 150,
      observedAt: OBSERVED_AT
    });
    const sideEffects = bookEarlyReturnSideEffectSpy();

    await applyRejectedBookDeltaSideEffects(
      {
        state,
        storageWrites: { "engine:state": state, "bookDesync:test": {} },
        tick: marketTick(),
        metrics: latencyMetrics(),
        hotPathStartedAt: 14
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual(["state:1", "persist:BOOK_DESYNC:2", "telemetry:FRESH:14"]);
  });

  it("orchestrates rejected book delta flow while skipping duplicate persistence", async () => {
    const duplicate = rejectedBookDeltaFlowSpy();
    const duplicateResult = await applyRejectedBookDeltaFlow(
      {
        currentState: defaultEngineState("book-duplicate-flow"),
        internalOrderBookDepth: 7,
        tick: marketTick(),
        metrics: latencyMetrics(),
        applied: {
          accepted: false,
          reason: "DUPLICATE_OR_OUT_OF_ORDER",
          actualSequence: 11,
          timeToBookMs: null
        },
        maxLatencyMs: 150,
        wakeUpTimeMs: 3,
        orderBookUpdateMs: 4,
        hotPathStartedAt: 14
      },
      duplicate.handlers
    );

    expect(duplicateResult.status).toBe("DUPLICATE_OR_OUT_OF_ORDER");
    expect(duplicate.events).toEqual(["profile:3:4"]);

    const desync = rejectedBookDeltaFlowSpy();
    const desyncResult = await applyRejectedBookDeltaFlow(
      {
        currentState: defaultEngineState("book-desync-flow"),
        internalOrderBookDepth: 7,
        tick: marketTick(),
        metrics: latencyMetrics(),
        applied: {
          accepted: false,
          reason: "SEQUENCE_GAP",
          expectedSequence: 10,
          actualSequence: 11,
          timeToBookMs: null
        },
        maxLatencyMs: 150,
        wakeUpTimeMs: 3,
        orderBookUpdateMs: 4,
        hotPathStartedAt: 14
      },
      desync.handlers
    );

    expect(desyncResult.status).toBe("DESYNC");
    expect(desync.events).toEqual([
      "profile:3:4",
      "desync-extra:SEQUENCE_GAP",
      "storage:2",
      "state:1",
      "persist:BOOK_DESYNC:2",
      "telemetry:FRESH:14"
    ]);
  });

  it("routes trading rejected deltas through the book early-return adapter", async () => {
    const bids = new Map([["hyperliquid:btc-usd", new SortedBookSide("bid")]]);
    const asks = new Map([["hyperliquid:btc-usd", new SortedBookSide("ask")]]);
    bids.get("hyperliquid:btc-usd")?.upsert(100, 1, OBSERVED_AT, 0.5);
    asks.get("hyperliquid:btc-usd")?.upsert(101, 2, OBSERVED_AT, 0.5);
    const flow = tradingBookEarlyReturnSpy();

    const result = await handleTradingRejectedBookDelta(
      {
        currentState: defaultEngineState("trading-book-desync-flow"),
        bids,
        asks,
        tick: marketTick(),
        metrics: latencyMetrics(),
        applied: {
          accepted: false,
          reason: "SEQUENCE_GAP",
          expectedSequence: 10,
          actualSequence: 11,
          timeToBookMs: null
        },
        maxLatencyMs: 150,
        wakeUpTimeMs: 3,
        orderBookUpdateMs: 4,
        hotPathStartedAt: 14
      },
      flow.handlers
    );

    expect(result.status).toBe("DESYNC");
    expect(flow.events).toEqual([
      "profile:3:4",
      "storage:2",
      "state:1:2",
      "persist:BOOK_DESYNC:2",
      "telemetry:FRESH:14"
    ]);
  });

  it("routes book early returns through the trading engine target adapter", async () => {
    const bids = new Map([["hyperliquid:btc-usd", new SortedBookSide("bid")]]);
    const asks = new Map([["hyperliquid:btc-usd", new SortedBookSide("ask")]]);
    bids.get("hyperliquid:btc-usd")?.upsert(100, 1, OBSERVED_AT, 0.5);
    asks.get("hyperliquid:btc-usd")?.upsert(101, 2, OBSERVED_AT, 0.5);
    const events: string[] = [];
    const target: TradingBookEarlyReturnTarget = {
      engineState: defaultEngineState("trading-book-target-flow"),
      cachedConfig: { TRADING_ENABLED: true },
      maxLatencyMs: 150,
      bids,
      asks,
      observeExecutionProfile(_metrics, trace) {
        events.push(`profile:${trace.wakeUpTimeMs}:${trace.orderBookUpdateMs}`);
      },
      latencyStorageWritesForState(state, extra) {
        const writes = { "engine:state": state, ...extra };
        events.push(`storage:${Object.keys(writes).length}`);
        return writes;
      },
      async persistHotStorageSnapshot(writes, reason) {
        events.push(`persist:${reason}:${Object.keys(writes).length}`);
      },
      publishTickTelemetry(_tick, _metrics, status, hotPathStartedAt) {
        events.push(`telemetry:${status}:${hotPathStartedAt}`);
      }
    };

    const informational = await handleTradingEngineInformationalBookNotReady(
      marketTick(),
      latencyMetrics(),
      3,
      4,
      12,
      target
    );
    const rejected = await handleTradingEngineRejectedBookDelta(
      marketTick(),
      latencyMetrics(),
      {
        accepted: false,
        reason: "SEQUENCE_GAP",
        expectedSequence: 10,
        actualSequence: 11,
        timeToBookMs: null
      },
      5,
      6,
      14,
      target
    );

    expect(informational.status).toBe("BOOK_NOT_READY");
    expect(rejected.status).toBe("DESYNC");
    expect(target.engineState.internalOrderBookDepth).toBe(2);
    expect(events).toEqual([
      "profile:3:4",
      "storage:1",
      "persist:INFORMATIONAL_TICK_BOOK_NOT_READY:1",
      "telemetry:FRESH:12",
      "profile:5:6",
      "storage:2",
      "persist:BOOK_DESYNC:2",
      "telemetry:FRESH:14"
    ]);
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

function snapshot(overrides: Partial<OrderBookSnapshot> = {}): OrderBookSnapshot {
  return {
    schemaVersion: "order-book.snapshot.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    sequence: 42,
    bids: [{ price: 99, size: 1 }],
    asks: [{ price: 101, size: 1 }],
    exchangeTimestamp: OBSERVED_AT,
    receivedAt: OBSERVED_AT,
    tickSize: 0.5,
    ...overrides
  };
}

function appliedSnapshot(appliedBook: InternalOrderBook): AppliedBookSnapshot {
  return {
    book: appliedBook,
    marketKey: appliedBook.marketKey,
    instrumentCode: appliedBook.instrumentCode,
    exchangeCode: appliedBook.exchangeCode,
    sourceExchange: appliedBook.source_exchange,
    source: appliedBook.source,
    sequence: 42,
    bidLevels: appliedBook.bids.length,
    askLevels: appliedBook.asks.length,
    tickSize: appliedBook.tickSize,
    timeToBookMs: 2
  };
}

function delta(overrides: Partial<BookDeltaWithTicker> = {}): BookDeltaWithTicker {
  return {
    schemaVersion: "order-book.delta.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    marketKey: "hyperliquid:btc-usd",
    sourceWeight: 1,
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    sequence: 42,
    exchangeTimestamp: OBSERVED_AT,
    receivedAt: OBSERVED_AT,
    side: "bid",
    price: 100,
    size: 1,
    bestBid: 100,
    bestAsk: 102,
    tickSize: 0.5,
    ...overrides
  };
}

function bookSnapshotFlowSideEffectSpy(appliedBook: InternalOrderBook): {
  events: string[];
  handlers: BookSnapshotFlowHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      applySnapshotToBook(nextSnapshot, updatedAt) {
        events.push(`applySnapshot:${nextSnapshot.instrumentCode}:${updatedAt}`);
        return appliedSnapshot(appliedBook);
      },
      getDomSnapshot(instrumentCode) {
        events.push(`dom:${instrumentCode}`);
        return dom(instrumentCode);
      },
      countBookLevels() {
        events.push("depth");
        return 8;
      },
      calculatePriceDiscovery(instrumentCode) {
        events.push(`discovery:${instrumentCode}`);
        return priceDiscovery(instrumentCode, appliedBook.midPrice ?? 0);
      },
      applyState(state) {
        events.push(`state:${state.microstructure.instrumentCode}`);
      },
      persistStorage(writes, reason) {
        events.push(`persist:${reason}:${Object.keys(writes).length}`);
        return Promise.resolve();
      },
      logSnapshotApplied(metadata) {
        events.push(`log:${String(metadata.sequence)}`);
      },
      publishSnapshotApplied(payload) {
        events.push(`publish:${String(payload.sequence)}`);
      }
    }
  };
}

function bookDeltaFlowSideEffectSpy(applied: AppliedBookUpdate): {
  events: string[];
  handlers: BookDeltaFlowHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      applyDeltaToBook(nextDelta) {
        events.push(`applyDelta:${nextDelta.sequence}`);
        return Promise.resolve(applied);
      },
      calculatePriceDiscovery(instrumentCode) {
        events.push(`discovery:${instrumentCode}`);
        return priceDiscovery(instrumentCode, applied.book?.midPrice ?? 0);
      },
      applyState(state) {
        events.push(`state:${String(state.microstructure.midPrice)}`);
      }
    }
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

function bookEarlyReturnSideEffectSpy(): {
  events: string[];
  handlers: BookEarlyReturnSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      applyState(state) {
        events.push(`state:${state.processedTicks}`);
      },
      persistStorage(writes, reason) {
        events.push(`persist:${reason}:${Object.keys(writes).length}`);
        return Promise.resolve();
      },
      publishTickTelemetry(_tick, _metrics, status, hotPathStartedAt) {
        events.push(`telemetry:${status}:${hotPathStartedAt}`);
      }
    }
  };
}

function bookNotReadyFlowSpy(): {
  events: string[];
  handlers: InformationalBookNotReadyFlowHandlers;
} {
  const sideEffects = bookEarlyReturnSideEffectSpy();
  const events = sideEffects.events;

  return {
    events,
    handlers: {
      ...sideEffects.handlers,
      observeExecutionProfile(_metrics, trace) {
        events.push(`profile:${trace.wakeUpTimeMs}:${trace.orderBookUpdateMs}`);
      },
      storageWritesForState(state) {
        events.push(`storage:${state.processedTicks}`);
        return { "engine:state": state };
      }
    }
  };
}

function rejectedBookDeltaFlowSpy(): {
  events: string[];
  handlers: RejectedBookDeltaFlowHandlers;
} {
  const sideEffects = bookEarlyReturnSideEffectSpy();
  const events = sideEffects.events;

  return {
    events,
    handlers: {
      ...sideEffects.handlers,
      observeExecutionProfile(_metrics, trace) {
        events.push(`profile:${trace.wakeUpTimeMs}:${trace.orderBookUpdateMs}`);
      },
      storageWritesForState(state, extra) {
        const writes = { "engine:state": state, ...extra };
        events.push(`storage:${Object.keys(writes).length}`);
        return writes;
      },
      bookDesyncStorageExtra(input) {
        events.push(`desync-extra:${input.reason}`);
        return bookDesyncStorageExtra(input);
      }
    }
  };
}

function tradingBookEarlyReturnSpy(): {
  events: string[];
  handlers: TradingBookEarlyReturnHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      observeExecutionProfile(_metrics, trace) {
        events.push(`profile:${trace.wakeUpTimeMs}:${trace.orderBookUpdateMs}`);
      },
      storageWritesForState(state, extra) {
        const writes = { "engine:state": state, ...extra };
        events.push(`storage:${Object.keys(writes).length}`);
        return writes;
      },
      applyState(state) {
        events.push(`state:${state.processedTicks}:${state.internalOrderBookDepth}`);
      },
      persistStorage(writes, reason) {
        events.push(`persist:${reason}:${Object.keys(writes).length}`);
        return Promise.resolve();
      },
      publishTickTelemetry(_tick, _metrics, status, hotPathStartedAt) {
        events.push(`telemetry:${status}:${hotPathStartedAt}`);
      }
    }
  };
}
