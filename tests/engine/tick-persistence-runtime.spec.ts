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
import {
  applyAcceptedTickJournalSideEffects,
  buildAcceptedTickJournalArtifacts,
  buildHotPathTickSnapshotWrites,
  recordAcceptedTickJournalSideEffects,
  scheduleHotPathTickSnapshotSideEffects,
  shouldJournalMarketTick
} from "../../src/engine/trading/state/TickPersistenceRuntime";
import { profilerStorageKey } from "../../src/engine/trading/book/BookRuntimeHelpers";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import type {
  AnomalyDetectorState,
  BayesianUpdateTrace,
  InternalOrderBook,
  LatencyMetrics,
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

  it("schedules hot-path snapshot persistence through durable-object handlers", async () => {
    const scheduled: Promise<void>[] = [];
    const calls: string[] = [];
    const book = orderBook();
    const tick = marketTick("btc-usd");
    const profilerState = { schemaVersion: "profiler.v1" } as ProfilerState;

    const writes = scheduleHotPathTickSnapshotSideEffects(
      {
        engineState: defaultEngineState("persist-schedule"),
        latencyHistory: [],
        processingLatencySamples: [1],
        domWallHistory: [],
        anomalyDetectorState: {} as AnomalyDetectorState,
        book,
        tick,
        profilerProcessed: true,
        profilerState
      },
      {
        persistSnapshot(snapshotWrites, reason) {
          calls.push(`persist:${reason}:${Object.keys(snapshotWrites).length}`);
          return Promise.resolve();
        },
        schedule(work) {
          calls.push("schedule");
          scheduled.push(work);
        }
      }
    );

    expect(writes[`${ORDER_BOOK_PREFIX}${book.marketKey}`]).toBe(book);
    expect(calls).toEqual(["persist:HOT_PATH_TICK_SNAPSHOT:9", "schedule"]);

    await Promise.all(scheduled);
  });

  it("resolves market tick journal cadence from config with safe defaults", () => {
    expect(shouldJournalMarketTick(1, undefined)).toBe(true);
    expect(shouldJournalMarketTick(5, "100")).toBe(true);
    expect(shouldJournalMarketTick(6, "100")).toBe(false);
    expect(shouldJournalMarketTick(100, "100")).toBe(true);
    expect(shouldJournalMarketTick(101, "100")).toBe(false);
    expect(shouldJournalMarketTick(101, "0")).toBe(false);
    expect(shouldJournalMarketTick(10, "3.8")).toBe(false);
    expect(shouldJournalMarketTick(9, "3.8")).toBe(true);
  });

  it("builds accepted tick journal artifacts without touching logger state", () => {
    const tick = marketTick("btc-usd");
    const metrics = latencyMetrics();
    const trace: BayesianUpdateTrace = {
      priorBullishProbability: 0.5,
      posteriorBullishProbability: 0.6,
      delta: 0.1,
      evidence: { source: "unit-test" },
      updatedAt: OBSERVED_AT
    };

    const artifacts = buildAcceptedTickJournalArtifacts({
      tick,
      metrics,
      bayesianTrace: trace,
      processedTicks: 1_000,
      averageLatencyMs: 12,
      marketTickJournalInterval: "500",
      bayesianSnapshotInterval: 1_000
    });

    expect(artifacts.shouldRecordMarketTick).toBe(true);
    expect(artifacts.bayesianPosteriorLog).toMatchObject({
      eventType: "BAYESIAN_POSTERIOR_UPDATED",
      message: "Oracle posterior PDF updated",
      metadata: {
        instrumentCode: "btc-usd",
        posteriorBullishProbability: 0.6
      }
    });
    expect(artifacts.acceptedTickLog).toMatchObject({
      eventType: "MARKET_TICK_ACCEPTED",
      metadata: {
        instrumentCode: "btc-usd",
        processedTicks: 1_000,
        totalLatencyMs: 7,
        averageLatencyMs: 12
      }
    });
  });

  it("applies accepted tick journal side effects through logger handlers", () => {
    const tick = marketTick("btc-usd");
    const calls: string[] = [];

    applyAcceptedTickJournalSideEffects(
      tick,
      {
        shouldRecordMarketTick: true,
        bayesianPosteriorLog: {
          eventType: "BAYESIAN_POSTERIOR_UPDATED",
          message: "Oracle posterior PDF updated",
          metadata: { instrumentCode: "btc-usd" }
        },
        acceptedTickLog: {
          eventType: "MARKET_TICK_ACCEPTED",
          message: "Market tick processed",
          metadata: { processedTicks: 1 }
        }
      },
      {
        recordMarketTick(recordedTick) {
          calls.push(`record:${recordedTick.instrumentCode}`);
        },
        logInfo(eventType, message, metadata) {
          calls.push(`log:${eventType}:${message}:${Object.keys(metadata).join(",")}`);
        }
      }
    );

    expect(calls).toEqual([
      "record:btc-usd",
      "log:BAYESIAN_POSTERIOR_UPDATED:Oracle posterior PDF updated:instrumentCode",
      "log:MARKET_TICK_ACCEPTED:Market tick processed:processedTicks"
    ]);
  });

  it("builds and applies accepted tick journal artifacts in one runtime call", () => {
    const calls: string[] = [];
    const artifacts = recordAcceptedTickJournalSideEffects(
      {
        tick: marketTick("btc-usd"),
        metrics: latencyMetrics(),
        bayesianTrace: {
          priorBullishProbability: 0.5,
          posteriorBullishProbability: 0.55,
          delta: 0.05,
          evidence: { source: "unit-test" },
          updatedAt: OBSERVED_AT
        },
        processedTicks: 1_000,
        averageLatencyMs: 12,
        marketTickJournalInterval: "1_000",
        bayesianSnapshotInterval: 1_000
      },
      {
        recordMarketTick(recordedTick) {
          calls.push(`record:${recordedTick.instrumentCode}`);
        },
        logInfo(eventType, message) {
          calls.push(`log:${eventType}:${message}`);
        }
      }
    );

    expect(artifacts.shouldRecordMarketTick).toBe(true);
    expect(artifacts.bayesianPosteriorLog?.eventType).toBe("BAYESIAN_POSTERIOR_UPDATED");
    expect(calls).toEqual([
      "record:btc-usd",
      "log:BAYESIAN_POSTERIOR_UPDATED:Oracle posterior PDF updated",
      "log:MARKET_TICK_ACCEPTED:Market tick processed"
    ]);
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

function latencyMetrics(): LatencyMetrics {
  return {
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    source: "HYPERLIQUID",
    sourceExchange: "hyperliquid",
    sourceWeight: 1,
    sequence: 42,
    providerTimestamp: OBSERVED_AT,
    sourceTimestamp: OBSERVED_AT,
    ingestTimestamp: OBSERVED_AT,
    brainTimestamp: OBSERVED_AT,
    clockOffsetMs: 0,
    networkLatencyMs: 4,
    processingLatencyMs: 3,
    totalLatencyMs: 7,
    maxLatencyMs: 150,
    averageLatencyMs: 12,
    sampleCount: 4,
    status: "FRESH",
    colo: "NRT",
    placement: "smart",
    latencyRiskMultiplier: 1,
    positionSizeMultiplier: 1
  };
}
