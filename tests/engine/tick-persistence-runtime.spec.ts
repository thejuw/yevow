import { describe, expect, it } from "vitest";
import { ANOMALY_DETECTOR_STORAGE_KEY } from "../../src/agents/AnomalyDetector";
import { PROFILER_STATE_STORAGE_KEY } from "../../src/agents/ProfilerAgent";
import {
  DOM_WALL_HISTORY_KEY,
  ENGINE_STATE_KEY,
  ORDER_BOOK_PREFIX,
  PERFORMANCE_HISTORY_KEY,
  PROCESSING_LATENCY_SAMPLES_KEY
} from "../../src/TradingEngineConstants";
import { buildHotPathTickSnapshotWrites } from "../../src/engine/trading/state/TickPersistenceRuntime";
import { defaultEngineState, profilerStorageKey } from "../../src/TradingEngineRuntimeHelpers";
import type {
  AnomalyDetectorState,
  InternalOrderBook,
  MarketTick,
  ProfilerState
} from "../../src/types";

const OBSERVED_AT = "2026-05-18T20:00:00.000Z";

describe("TickPersistenceRuntime", () => {
  it("builds hot-path writes with profiler legacy compatibility keys", () => {
    const book = orderBook();
    const tick = marketTick("btc-usd");
    const profilerState = { schemaVersion: "profiler.v1" } as ProfilerState;
    const writes = buildHotPathTickSnapshotWrites({
      engineState: defaultEngineState("persist-test"),
      latencyHistory: [],
      processingLatencySamples: [1, 2],
      domWallHistory: [],
      anomalyDetectorState: {} as AnomalyDetectorState,
      book,
      tick,
      profilerProcessed: true,
      profilerState
    });

    expect(writes[ENGINE_STATE_KEY]).toBeTruthy();
    expect(writes[PERFORMANCE_HISTORY_KEY]).toEqual([]);
    expect(writes[PROCESSING_LATENCY_SAMPLES_KEY]).toEqual([1, 2]);
    expect(writes[DOM_WALL_HISTORY_KEY]).toEqual([]);
    expect(writes[ANOMALY_DETECTOR_STORAGE_KEY]).toEqual({});
    expect(writes[`${ORDER_BOOK_PREFIX}${book.marketKey}`]).toBe(book);
    expect(writes[`lastTick:${book.marketKey}`]).toBe(tick);
    expect(writes[profilerStorageKey("btc-usd")]).toBe(profilerState);
    expect(writes[PROFILER_STATE_STORAGE_KEY]).toBe(profilerState);
  });

  it("omits profiler writes when the profiler did not process the tick", () => {
    const writes = buildHotPathTickSnapshotWrites({
      engineState: defaultEngineState("persist-test"),
      latencyHistory: [],
      processingLatencySamples: [],
      domWallHistory: [],
      anomalyDetectorState: {} as AnomalyDetectorState,
      book: orderBook(),
      tick: marketTick("eth-usd"),
      profilerProcessed: false,
      profilerState: {} as ProfilerState
    });

    expect(writes[profilerStorageKey("eth-usd")]).toBeUndefined();
    expect(writes[PROFILER_STATE_STORAGE_KEY]).toBeUndefined();
  });
});

function marketTick(instrumentCode: string): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    exchangeCode: "hyperliquid",
    instrumentCode,
    baseAsset: instrumentCode.split("-")[0]?.toUpperCase() ?? "BTC",
    quoteAsset: "USD",
    price: 100,
    size: 1,
    side: "buy",
    sequence: 42,
    exchangeTimestamp: OBSERVED_AT,
    synchronizedExchangeTimestamp: OBSERVED_AT,
    clockOffsetMs: 0,
    receivedAt: OBSERVED_AT,
    sourceWeight: 1
  };
}

function orderBook(): InternalOrderBook {
  return {
    marketKey: "hyperliquid:btc-usd",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceWeight: 1,
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    bids: [],
    asks: [],
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    spread: null,
    spreadBps: null,
    weightedImbalance: null,
    lastSequence: 42,
    tickSize: 1,
    ttbLatencyMs: null,
    isSynced: true,
    desyncReason: null,
    sequence: 42,
    updatedAt: OBSERVED_AT
  };
}
