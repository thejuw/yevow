import { describe, expect, it } from "vitest";
import {
  buildReplayRestoreWrites,
  captureEngineReplaySnapshot,
  hydrateReplayOrderBooks,
  restoreReplaySnapshotSideEffects,
  type EngineReplaySnapshot
} from "../../src/engine/trading/replay/ReplaySnapshotRuntime";
import {
  applyTradingReplaySnapshotToTarget,
  captureTradingReplaySnapshotFromSource,
  type TradingReplaySnapshotSource,
  type TradingReplaySnapshotTarget
} from "../../src/engine/trading/replay/TradingReplayStateRuntime";
import {
  DOM_WALL_HISTORY_KEY,
  ENGINE_STATE_KEY,
  ORDER_BOOK_PREFIX,
  PERFORMANCE_HISTORY_KEY,
  PROCESSING_LATENCY_SAMPLES_KEY,
  RATE_LIMIT_STATE_KEY
} from "../../src/TradingEngineConstants";
import { PROFILER_STATE_STORAGE_KEY } from "../../src/agents/ProfilerAgent";
import { ANOMALY_DETECTOR_STORAGE_KEY } from "../../src/agents/AnomalyDetector";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import type { InternalOrderBook, LatencyMetrics } from "../../src/types";

const OBSERVED_AT = "2026-05-18T20:00:00.000Z";

describe("ReplaySnapshotRuntime", () => {
  it("captures replay snapshots with cloned mutable collections", () => {
    const engineState = defaultEngineState("capture-snapshot");
    engineState.bankroll.cash = 123;
    const inputBook = book();
    const latencyHistory = [latencyMetrics()];
    const processingLatencySamples = [1, 2, 3];
    const domWallHistory = [
      {
        wallId: "wall-1",
        instrumentCode: "btc-usd",
        exchangeCode: "HL",
        side: "BID" as const,
        priceStart: 99,
        priceEnd: 100,
        centerPrice: 99.5,
        volume: 3,
        meanVolume: 1,
        sigmaVolume: 0.5,
        zScore: 4,
        levelCount: 1,
        status: "ACTIVE" as const,
        firstSeenAt: OBSERVED_AT,
        lastSeenAt: OBSERVED_AT,
        lastSequence: 42,
        distanceFromMidBps: 5,
        spoofingSuspected: false
      }
    ];
    const snapshot = captureEngineReplaySnapshot({
      engineState,
      orderBooks: [inputBook],
      latencyHistory,
      processingLatencySamples,
      domWallHistory,
      leadLagSamples: [["btc-usd", [{ price: 100, observedAt: OBSERVED_AT }]]],
      cachedConfig: engineState.cachedConfig,
      maxLatencyMs: 150,
      lastTickTimestamp: OBSERVED_AT,
      profilerState: engineState.profilerStates["btc-usd"],
      profilerStates: [["btc-usd", engineState.profilerStates["btc-usd"]]],
      anomalyState: replaySnapshot().anomalyState,
      oracleState: engineState.oracle,
      sentimentState: engineState.sentiment,
      rateLimits: {},
      signals: [],
      latestAgentSignals: []
    });

    engineState.bankroll.cash = 0;
    inputBook.midPrice = 1;
    latencyHistory[0] = { ...latencyHistory[0], totalLatencyMs: 999 };
    processingLatencySamples[0] = 999;
    domWallHistory[0] = { ...domWallHistory[0], volume: 999 };

    expect(snapshot.engineState.bankroll.cash).toBe(123);
    expect(snapshot.orderBooks[0].midPrice).toBe(100);
    expect(snapshot.latencyHistory[0].totalLatencyMs).toBe(2);
    expect(snapshot.processingLatencySamples[0]).toBe(1);
    expect(snapshot.domWallHistory[0].volume).toBe(3);
  });

  it("hydrates replay order books and assembles restore writes", () => {
    const snapshot = replaySnapshot();
    const hydrated = hydrateReplayOrderBooks(snapshot);
    const writes = buildReplayRestoreWrites(snapshot);

    expect(hydrated.snapshots.get("hyperliquid:btc-usd")?.midPrice).toBe(100);
    expect(hydrated.bids.get("hyperliquid:btc-usd")?.top(1)[0]?.price).toBe(99);
    expect(writes).toMatchObject({
      [ENGINE_STATE_KEY]: snapshot.engineState,
      [PERFORMANCE_HISTORY_KEY]: snapshot.latencyHistory,
      [PROCESSING_LATENCY_SAMPLES_KEY]: snapshot.processingLatencySamples,
      [DOM_WALL_HISTORY_KEY]: snapshot.domWallHistory,
      [PROFILER_STATE_STORAGE_KEY]: snapshot.profilerState,
      [ANOMALY_DETECTOR_STORAGE_KEY]: snapshot.anomalyState,
      [RATE_LIMIT_STATE_KEY]: snapshot.rateLimits,
      [`${ORDER_BOOK_PREFIX}hyperliquid:btc-usd`]: snapshot.orderBooks[0]
    });
    expect(writes["agent:profiler:state:btc-usd"]).toEqual(snapshot.profilerStates[0][1]);
  });

  it("restores replay snapshots through ordered side-effect handlers", async () => {
    const snapshot = replaySnapshot();
    const calls: string[] = [];
    let deletedKeys: readonly string[] = [];
    let restoreWrites: Record<string, unknown> | null = null;

    await restoreReplaySnapshotSideEffects(snapshot, {
      listPersistedBookKeys: async () => {
        calls.push("list-books");
        return ["book:old-a", "book:old-b"];
      },
      onListPersistedBookKeysFailure: () => calls.push("list-failed"),
      applyRuntimeSnapshot: (restoredSnapshot, hydratedBooks) => {
        calls.push("apply-runtime");
        expect(restoredSnapshot).toBe(snapshot);
        expect(hydratedBooks.snapshots.get("hyperliquid:btc-usd")?.midPrice).toBe(100);
      },
      deletePersistedBookKeys: async (keys) => {
        calls.push("delete-books");
        deletedKeys = keys;
      },
      writeRestoreState: async (writes) => {
        calls.push("write-state");
        restoreWrites = writes;
      }
    });

    expect(calls).toEqual(["list-books", "apply-runtime", "delete-books", "write-state"]);
    expect(deletedKeys).toEqual(["book:old-a", "book:old-b"]);
    expect(restoreWrites).toMatchObject({
      [ENGINE_STATE_KEY]: snapshot.engineState,
      [`${ORDER_BOOK_PREFIX}hyperliquid:btc-usd`]: snapshot.orderBooks[0]
    });
  });

  it("continues replay snapshot restore when persisted book listing fails", async () => {
    const calls: string[] = [];

    await restoreReplaySnapshotSideEffects(replaySnapshot(), {
      listPersistedBookKeys: async () => {
        calls.push("list-books");
        throw new Error("storage unavailable");
      },
      onListPersistedBookKeysFailure: (error) => {
        calls.push(error instanceof Error ? `list-failed:${error.message}` : "list-failed");
      },
      applyRuntimeSnapshot: () => calls.push("apply-runtime"),
      deletePersistedBookKeys: async (keys) => {
        calls.push(`delete:${keys.length}`);
      },
      writeRestoreState: async () => calls.push("write-state")
    });

    expect(calls).toEqual([
      "list-books",
      "list-failed:storage unavailable",
      "apply-runtime",
      "delete:0",
      "write-state"
    ]);
  });

  it("applies hydrated replay snapshots to mutable trading runtime targets", () => {
    const snapshot = replaySnapshot();
    const hydrated = hydrateReplayOrderBooks(snapshot);
    const calls: string[] = [];
    const target = replaySnapshotTarget(calls);

    applyTradingReplaySnapshotToTarget(target, snapshot, hydrated);

    expect(target.engineState).toBe(snapshot.engineState);
    expect(target.orderBook.get("hyperliquid:btc-usd")?.midPrice).toBe(100);
    expect(target.bids.get("hyperliquid:btc-usd")?.top(1)[0]?.price).toBe(99);
    expect(target.asks.get("hyperliquid:btc-usd")?.top(1)[0]?.price).toBe(101);
    expect(target.bookSync.get("hyperliquid:btc-usd")?.isSynced).toBe(true);
    expect(target.leadLagSamples.get("btc-usd")?.[0]?.price).toBe(100);
    expect(target.cachedConfig).toBe(snapshot.cachedConfig);
    expect(target.maxLatencyMs).toBe(150);
    expect(target.lastTickTimestamp).toBe(OBSERVED_AT);
    expect(target.signals).toBe(snapshot.signals);
    expect(calls).toEqual([
      "rebind",
      "profiler:1:none",
      "anomaly:anomaly-detector.v1",
      "oracle",
      "sentiment",
      "rate-limits:0"
    ]);
  });

  it("captures replay snapshots from a mutable trading runtime source", () => {
    const source = replaySnapshotSource();

    const snapshot = captureTradingReplaySnapshotFromSource(source);

    expect(snapshot.engineState.engineId).toBe("source-replay-target");
    expect(snapshot.orderBooks[0]?.marketKey).toBe("hyperliquid:btc-usd");
    expect(snapshot.latencyHistory[0]?.totalLatencyMs).toBe(2);
    expect(snapshot.leadLagSamples).toEqual([
      ["btc-usd", [{ price: 100, observedAt: OBSERVED_AT }]]
    ]);
    expect(snapshot.maxLatencyMs).toBe(175);
    expect(snapshot.lastTickTimestamp).toBe(OBSERVED_AT);
    expect(snapshot.profilerState).toEqual({ label: "legacy" });
    expect(snapshot.profilerStates).toEqual([["btc-usd", { label: "btc" }]]);
    expect(snapshot.anomalyState).toEqual({ label: "anomaly" });
    expect(snapshot.oracleState).toEqual({ label: "oracle" });
    expect(snapshot.sentimentState).toEqual({ label: "sentiment" });
    expect(snapshot.rateLimits).toEqual({ default: { available: 1 } });
  });
});

function replaySnapshot(): EngineReplaySnapshot {
  const engineState = defaultEngineState("replay-snapshot");

  return {
    engineState,
    orderBooks: [book()],
    latencyHistory: [latencyMetrics()],
    processingLatencySamples: [1, 2, 3],
    domWallHistory: [],
    leadLagSamples: [["btc-usd", [{ price: 100, observedAt: OBSERVED_AT }]]],
    cachedConfig: engineState.cachedConfig,
    maxLatencyMs: 150,
    lastTickTimestamp: OBSERVED_AT,
    profilerState: engineState.profilerStates["btc-usd"],
    profilerStates: [["btc-usd", engineState.profilerStates["btc-usd"]]],
    anomalyState: {
      schemaVersion: "anomaly-detector.v1",
      priceWindowMs: 60_000,
      volumeWindowMs: 600_000,
      topOfBookWindowMs: 600_000,
      priceBuckets: [],
      volumeBuckets: [],
      topOfBookBuckets: [],
      lastTopOfBook: null,
      status: engineState.anomaly,
      updatedAt: OBSERVED_AT
    },
    oracleState: engineState.oracle,
    sentimentState: engineState.sentiment,
    rateLimits: {},
    signals: [],
    latestAgentSignals: []
  };
}

function book(): InternalOrderBook {
  return {
    marketKey: "hyperliquid:btc-usd",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceWeight: 1,
    instrumentCode: "btc-usd",
    exchangeCode: "HL",
    bids: [{ price: 99, size: 1, updatedAt: OBSERVED_AT }],
    asks: [{ price: 101, size: 1, updatedAt: OBSERVED_AT }],
    bestBid: 99,
    bestAsk: 101,
    midPrice: 100,
    spread: 2,
    spreadBps: 200,
    weightedImbalance: 0,
    lastSequence: 42,
    tickSize: 1,
    ttbLatencyMs: 2,
    isSynced: true,
    desyncReason: null,
    sequence: 42,
    updatedAt: OBSERVED_AT
  };
}

function latencyMetrics(): LatencyMetrics {
  return {
    instrumentCode: "btc-usd",
    exchangeCode: "HL",
    source: "HYPERLIQUID",
    sourceExchange: "hyperliquid",
    sourceWeight: 1,
    sequence: 42,
    providerTimestamp: OBSERVED_AT,
    sourceTimestamp: OBSERVED_AT,
    ingestTimestamp: OBSERVED_AT,
    brainTimestamp: OBSERVED_AT,
    clockOffsetMs: 0,
    networkLatencyMs: 1,
    processingLatencyMs: 1,
    totalLatencyMs: 2,
    maxLatencyMs: 150,
    averageLatencyMs: 2,
    sampleCount: 1,
    status: "FRESH",
    colo: "NRT",
    placement: "tokyo",
    latencyRiskMultiplier: 1,
    positionSizeMultiplier: 1
  };
}

function replaySnapshotTarget(calls: string[]): TradingReplaySnapshotTarget {
  const engineState = defaultEngineState("old-replay-target");

  return {
    engineState,
    orderBook: new Map(),
    bids: new Map(),
    asks: new Map(),
    bookSync: new Map(),
    latencyHistory: [],
    processingLatencySamples: [],
    domWallHistory: [],
    leadLagSamples: new Map(),
    cachedConfig: engineState.cachedConfig,
    maxLatencyMs: 0,
    lastTickTimestamp: null,
    signals: [],
    latestAgentSignals: new Map(),
    profilerRegistry: {
      hydrate(legacyState, states) {
        calls.push(`profiler:${states.size}:${legacyState?.toxicityScore ?? "none"}`);
      }
    },
    anomalyDetector: {
      hydrate(state) {
        calls.push(`anomaly:${state.schemaVersion}`);
      }
    },
    oracleAgent: {
      hydrate() {
        calls.push("oracle");
      }
    },
    sentimentAgent: {
      hydrate() {
        calls.push("sentiment");
      }
    },
    rateLimiter: {
      hydrate(snapshot) {
        calls.push(`rate-limits:${Object.keys(snapshot).length}`);
      }
    },
    rebindOrderBookReconstructor() {
      calls.push("rebind");
    }
  };
}

function replaySnapshotSource(): TradingReplaySnapshotSource {
  const engineState = defaultEngineState("source-replay-target");

  return {
    engineState,
    orderBook: new Map([["hyperliquid:btc-usd", book()]]),
    latencyHistory: [latencyMetrics()],
    processingLatencySamples: [1],
    domWallHistory: [],
    leadLagSamples: new Map([["btc-usd", [{ price: 100, observedAt: OBSERVED_AT }]]]),
    cachedConfig: engineState.cachedConfig,
    maxLatencyMs: 175,
    lastTickTimestamp: OBSERVED_AT,
    profilerAgent: {
      snapshot: () => ({ label: "legacy" }) as never
    },
    profilerRegistry: {
      entries: () =>
        new Map([
          [
            "btc-usd",
            {
              snapshot: () => ({ label: "btc" }) as never
            }
          ]
        ]).entries()
    },
    anomalyDetector: {
      snapshot: () => ({ label: "anomaly" }) as never
    },
    oracleAgent: {
      snapshot: () => ({ label: "oracle" }) as never
    },
    sentimentAgent: {
      snapshot: () => ({ label: "sentiment" }) as never
    },
    rateLimiter: {
      exportState: () => ({ default: { available: 1 } }) as never
    },
    signals: [],
    latestAgentSignals: new Map()
  };
}
