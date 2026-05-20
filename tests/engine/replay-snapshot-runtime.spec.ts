import { describe, expect, it } from "vitest";
import {
  buildReplayRestoreWrites,
  hydrateReplayOrderBooks,
  type EngineReplaySnapshot
} from "../../src/engine/trading/replay/ReplaySnapshotRuntime";
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
import { defaultEngineState } from "../../src/engine/trading/helpers/RuntimeHelpers";
import type { InternalOrderBook, LatencyMetrics } from "../../src/types";

const OBSERVED_AT = "2026-05-18T20:00:00.000Z";

describe("ReplaySnapshotRuntime", () => {
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
