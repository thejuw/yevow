import { describe, expect, it } from "vitest";
import {
  applyAnomalyEmergencyPauseFlow,
  applyAnomalyEmergencyPauseSideEffects,
  anomalyEmergencyPauseArtifacts,
  anomalyEmergencyPauseStorageWrites,
  buildAnomalyEmergencyPauseTelemetry,
  emitAnomalyEmergencyPauseSideEffects,
  stateAfterAnomalyEmergencyPause,
  type AnomalyEmergencyPauseEmitHandlers,
  type AnomalyEmergencyPauseFlowHandlers,
  type AnomalyEmergencyPauseSideEffectHandlers
} from "../../src/engine/trading/anomaly/AnomalyRuntime";
import {
  handleTradingAnomalyEmergencyPause,
  handleTradingEngineAnomalyEmergencyPause,
  type TradingAnomalyEmergencyTarget
} from "../../src/engine/trading/anomaly/TradingAnomalyEmergencyRuntime";
import { SortedBookSide } from "../../src/engine/trading/book/SortedBookSide";
import type { AnomalyDetectionResult } from "../../src/agents/AnomalyDetector";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import type {
  AnomalyStatus,
  DomAnalysisSnapshot,
  InternalOrderBook,
  LatencyMetrics,
  MarketTick
} from "../../src/types";

const OBSERVED_AT = "2026-05-18T18:00:00.000Z";

describe("AnomalyRuntime", () => {
  it("halts the engine and enables the risk kill switch on anomaly emergency pause", () => {
    const currentState = defaultEngineState("anomaly-test");
    currentState.processedTicks = 9;
    currentState.mode = "PAPER";

    const next = stateAfterAnomalyEmergencyPause({
      currentState,
      book: book(),
      dom: dom(),
      anomaly: anomaly(),
      internalOrderBookDepth: 12,
      observedAt: OBSERVED_AT
    });

    expect(next).toMatchObject({
      mode: "HALTED",
      processedTicks: 10,
      internalOrderBookDepth: 12,
      microstructure: {
        marketKey: "hyperliquid:btc-usd",
        midPrice: 100,
        weightedImbalance: 0
      },
      anomaly: { status: "ANOMALY", priceZScore: -8 },
      risk: { killSwitch: true, updatedAt: OBSERVED_AT },
      heartbeatAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT
    });
    expect(next.dom?.instrumentCode).toBe("btc-usd");
  });

  it("builds emergency pause audit, bus, and notification payloads", () => {
    const engineState = defaultEngineState("anomaly-test");
    engineState.mode = "PAPER";
    engineState.processedTicks = 4;
    engineState.risk.killSwitch = true;

    const event = buildAnomalyEmergencyPauseTelemetry({
      tick: tick(),
      book: book(),
      domSnapshot: dom(),
      anomalyResult: anomalyResult(),
      metrics: latency(),
      engineState
    });

    expect(event).toMatchObject({
      correlationId: "anomaly-1",
      logMetadata: {
        eventType: "MARKET_ANOMALY_EMERGENCY_PAUSE",
        correlationId: "anomaly-1",
        anomalyTypes: ["FLASH_CRASH"],
        severity: "CRITICAL",
        reason: "flash crash"
      },
      payload: {
        instrumentCode: "btc-usd",
        exchangeCode: "hyperliquid",
        sequence: 42,
        priceZScore: -8,
        volumeZScore: 6,
        cancellationToExecutionRatio: 10,
        mode: "PAPER",
        killSwitch: true
      },
      notification: {
        priority: "CRITICAL",
        title: "Sovereign-Sigma emergency pause",
        message: "btc-usd halted by anomaly detector: flash crash",
        dedupeKey: "emergency:btc-usd:CRITICAL",
        metadata: {
          instrumentCode: "btc-usd",
          sequence: 42,
          anomalyTypes: ["FLASH_CRASH"],
          mode: "PAPER"
        }
      }
    });
    expect(event.logMetadata.marketSnapshot).toMatchObject({
      tick: { instrumentCode: "btc-usd" },
      engineState: { engineId: "anomaly-test", processedTicks: 4 }
    });
  });

  it("builds emergency pause storage writes", () => {
    const state = defaultEngineState("anomaly-test");
    const latencyHistory = [latency()];
    const processingLatencySamples = [1, 2];
    const wallHistory = dom().walls;
    const anomalyDetection = anomalyResult();
    const currentBook = book();
    const currentTick = tick();

    expect(
      anomalyEmergencyPauseStorageWrites({
        engineStateKey: "engine:state",
        state,
        performanceHistoryKey: "latency:history",
        latencyHistory,
        processingLatencySamplesKey: "latency:samples",
        processingLatencySamples,
        domWallHistoryKey: "dom:walls",
        domWallHistory: wallHistory,
        anomalyDetectorStorageKey: "anomaly:state",
        anomalyResult: anomalyDetection,
        orderBookPrefix: "book:",
        book: currentBook,
        tick: currentTick
      })
    ).toEqual({
      "engine:state": state,
      "latency:history": latencyHistory,
      "latency:samples": processingLatencySamples,
      "dom:walls": wallHistory,
      "anomaly:state": anomalyDetection.state,
      "book:hyperliquid:btc-usd": currentBook,
      "lastTick:hyperliquid:btc-usd": currentTick,
      "anomaly:hyperliquid:btc-usd:42": anomalyDetection.anomalies
    });
  });

  it("assembles emergency pause state, storage, telemetry, and ingest result", () => {
    const currentState = defaultEngineState("anomaly-artifacts");
    const artifacts = anomalyEmergencyPauseArtifacts({
      currentState,
      engineStateKey: "engine:state",
      performanceHistoryKey: "latency:history",
      latencyHistory: [latency()],
      processingLatencySamplesKey: "latency:samples",
      processingLatencySamples: [1],
      domWallHistoryKey: "dom:walls",
      domWallHistory: dom().walls,
      anomalyDetectorStorageKey: "anomaly:state",
      anomalyResult: anomalyResult(),
      orderBookPrefix: "book:",
      book: book(),
      tick: tick(),
      domSnapshot: dom(),
      metrics: latency(),
      internalOrderBookDepth: 4,
      observedAt: OBSERVED_AT
    });

    expect(artifacts.state).toMatchObject({
      mode: "HALTED",
      processedTicks: 1,
      internalOrderBookDepth: 4,
      risk: { killSwitch: true }
    });
    expect(artifacts.storageWrites["engine:state"]).toBe(artifacts.state);
    expect(artifacts.event).toMatchObject({
      correlationId: "anomaly-1",
      payload: {
        mode: "HALTED",
        killSwitch: true
      }
    });
    expect(artifacts.result).toMatchObject({
      accepted: false,
      status: "ANOMALY_PAUSE",
      reason: "FLASH_CRASH",
      metrics: latency(),
      book: book()
    });
  });

  it("applies emergency pause side effects in durable-object order", async () => {
    const artifacts = anomalyEmergencyPauseArtifacts({
      currentState: defaultEngineState("anomaly-side-effects"),
      engineStateKey: "engine:state",
      performanceHistoryKey: "latency:history",
      latencyHistory: [latency()],
      processingLatencySamplesKey: "latency:samples",
      processingLatencySamples: [1],
      domWallHistoryKey: "dom:walls",
      domWallHistory: dom().walls,
      anomalyDetectorStorageKey: "anomaly:state",
      anomalyResult: anomalyResult(),
      orderBookPrefix: "book:",
      book: book(),
      tick: tick(),
      domSnapshot: dom(),
      metrics: latency(),
      internalOrderBookDepth: 4,
      observedAt: OBSERVED_AT
    });
    const sideEffects = anomalySideEffectSpy();

    await applyAnomalyEmergencyPauseSideEffects(artifacts, sideEffects.handlers);

    expect(sideEffects.events).toEqual(["state:HALTED", "persist:8", "emit:anomaly-1"]);
  });

  it("orchestrates emergency pause flow through profiling, persistence, and telemetry", async () => {
    const sideEffects = anomalyFlowSideEffectSpy();

    const result = await applyAnomalyEmergencyPauseFlow(
      {
        currentState: defaultEngineState("anomaly-flow"),
        engineStateKey: "engine:state",
        performanceHistoryKey: "latency:history",
        latencyHistory: [latency()],
        processingLatencySamplesKey: "latency:samples",
        processingLatencySamples: [1],
        domWallHistoryKey: "dom:walls",
        domWallHistory: dom().walls,
        anomalyDetectorStorageKey: "anomaly:state",
        anomalyResult: anomalyResult(),
        orderBookPrefix: "book:",
        book: book(),
        tick: tick(),
        domSnapshot: dom(),
        metrics: latency(),
        internalOrderBookDepth: 4,
        observedAt: OBSERVED_AT,
        executionTrace: {
          wakeUpTimeMs: 2,
          orderBookUpdateMs: 1,
          agentLogicMs: 3,
          hotPathStartedAt: 123,
          observedAt: OBSERVED_AT
        }
      },
      sideEffects.handlers
    );

    expect(result).toMatchObject({
      accepted: false,
      status: "ANOMALY_PAUSE",
      reason: "FLASH_CRASH"
    });
    expect(sideEffects.events).toEqual([
      "profile:3",
      "state:HALTED",
      "persist:8",
      "emit:anomaly-1",
      "telemetry:FRESH:123"
    ]);
  });

  it("handles trading anomaly emergency pause with book depth and notification side effects", async () => {
    const sideEffects = tradingAnomalySideEffectSpy();
    const bidSide = new SortedBookSide("bid");
    const askSide = new SortedBookSide("ask");
    bidSide.upsert(99, 1, OBSERVED_AT, 1);
    askSide.upsert(101, 1, OBSERVED_AT, 1);

    const result = await handleTradingAnomalyEmergencyPause(
      {
        currentState: defaultEngineState("trading-anomaly-flow"),
        latencyHistory: [latency()],
        processingLatencySamples: [1],
        domWallHistory: dom().walls,
        anomalyResult: anomalyResult(),
        book: book(),
        tick: tick(),
        domSnapshot: dom(),
        metrics: latency(),
        bids: new Map([["hyperliquid:btc-usd", bidSide]]),
        asks: new Map([["hyperliquid:btc-usd", askSide]]),
        anomalyLogicStartedAt: 0,
        wakeUpTimeMs: 2,
        orderBookUpdateMs: 1,
        hotPathStartedAt: 123
      },
      sideEffects.handlers
    );

    expect(result).toMatchObject({
      accepted: false,
      status: "ANOMALY_PAUSE",
      reason: "FLASH_CRASH"
    });
    expect(sideEffects.events[0]).toMatch(/^profile:/);
    expect(sideEffects.events.slice(1)).toEqual([
      "state:HALTED:2",
      "persist:8",
      "log:CRITICAL:TradingEngine:MARKET_ANOMALY_EMERGENCY_PAUSE",
      "publish:EMERGENCY_PAUSE:anomaly-1",
      "notify:CRITICAL",
      "telemetry:FRESH:123"
    ]);
  });

  it("handles anomaly emergency pause through the trading engine target adapter", async () => {
    const events: string[] = [];
    const bidSide = new SortedBookSide("bid");
    const askSide = new SortedBookSide("ask");
    bidSide.upsert(99, 1, OBSERVED_AT, 1);
    askSide.upsert(101, 1, OBSERVED_AT, 1);
    const target: TradingAnomalyEmergencyTarget = {
      engineState: defaultEngineState("trading-anomaly-target"),
      latencyHistory: [latency()],
      processingLatencySamples: [1],
      domWallHistory: dom().walls,
      bids: new Map([["hyperliquid:btc-usd", bidSide]]),
      asks: new Map([["hyperliquid:btc-usd", askSide]]),
      logger: {
        writeLog(level, source, _message, metadata) {
          events.push(`log:${level}:${source}:${metadata.eventType}`);
        }
      },
      notifier: {
        notify(notification) {
          events.push(`notify:${notification.priority}`);
        }
      },
      observeExecutionProfile(_metrics, trace) {
        events.push(`profile:${String(trace.orderBookUpdateMs)}:${String(trace.agentLogicMs)}`);
      },
      async safeStoragePut(writes) {
        events.push(`persist:${Object.keys(writes).length}`);
      },
      publish(type, _payload, correlationId) {
        events.push(`publish:${type}:${correlationId}`);
      },
      publishTickTelemetry(_tick, _metrics, status, hotPathStartedAt) {
        events.push(`telemetry:${status}:${hotPathStartedAt}`);
      }
    };

    const result = await handleTradingEngineAnomalyEmergencyPause(
      tick(),
      book(),
      dom(),
      anomalyResult(),
      0,
      latency(),
      2,
      1,
      123,
      target
    );

    expect(result).toMatchObject({ accepted: false, status: "ANOMALY_PAUSE" });
    expect(target.engineState.mode).toBe("HALTED");
    expect(events[0]).toMatch(/^profile:1:/);
    expect(events.slice(1)).toEqual([
      "persist:8",
      "log:CRITICAL:TradingEngine:MARKET_ANOMALY_EMERGENCY_PAUSE",
      "publish:EMERGENCY_PAUSE:anomaly-1",
      "notify:CRITICAL",
      "telemetry:FRESH:123"
    ]);
  });

  it("emits emergency pause audit, bus, and notification side effects in order", () => {
    const event = buildAnomalyEmergencyPauseTelemetry({
      tick: tick(),
      book: book(),
      domSnapshot: dom(),
      anomalyResult: anomalyResult(),
      metrics: latency(),
      engineState: defaultEngineState("anomaly-emit")
    });
    const sideEffects = anomalyEmitSideEffectSpy();

    emitAnomalyEmergencyPauseSideEffects(event, sideEffects.handlers);

    expect(sideEffects.events).toEqual([
      "log:CRITICAL:TradingEngine:MARKET_ANOMALY_EMERGENCY_PAUSE",
      "publish:EMERGENCY_PAUSE:anomaly-1",
      "notify:CRITICAL"
    ]);
  });
});

function anomalyEmitSideEffectSpy(): {
  events: string[];
  handlers: AnomalyEmergencyPauseEmitHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      writeCriticalLog(source, _message, metadata) {
        events.push(`log:CRITICAL:${source}:${metadata.eventType}`);
      },
      publish(type, _payload, correlationId) {
        events.push(`publish:${type}:${correlationId}`);
      },
      notify(notification) {
        events.push(`notify:${notification.priority}`);
      }
    }
  };
}

function anomalySideEffectSpy(): {
  events: string[];
  handlers: AnomalyEmergencyPauseSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      applyState(state) {
        events.push(`state:${state.mode}`);
      },
      persistStorageWrites(writes) {
        events.push(`persist:${Object.keys(writes).length}`);
        return Promise.resolve();
      },
      emitEmergencyPause(event) {
        events.push(`emit:${event.correlationId}`);
      }
    }
  };
}

function anomalyFlowSideEffectSpy(): {
  events: string[];
  handlers: AnomalyEmergencyPauseFlowHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      observeExecutionProfile(_metrics, trace) {
        events.push(`profile:${String(trace.agentLogicMs)}`);
      },
      applyState(state) {
        events.push(`state:${state.mode}`);
      },
      persistStorageWrites(writes) {
        events.push(`persist:${Object.keys(writes).length}`);
        return Promise.resolve();
      },
      emitEmergencyPause(event) {
        events.push(`emit:${event.correlationId}`);
      },
      publishTickTelemetry(_tick, _metrics, status, hotPathStartedAt) {
        events.push(`telemetry:${status}:${hotPathStartedAt}`);
      }
    }
  };
}

function tradingAnomalySideEffectSpy(): {
  events: string[];
  handlers: Parameters<typeof handleTradingAnomalyEmergencyPause>[1];
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      observeExecutionProfile(_metrics, trace) {
        events.push(`profile:${String(trace.orderBookUpdateMs)}:${String(trace.agentLogicMs)}`);
      },
      applyState(state) {
        events.push(`state:${state.mode}:${String(state.internalOrderBookDepth)}`);
      },
      persistStorageWrites(writes) {
        events.push(`persist:${Object.keys(writes).length}`);
        return Promise.resolve();
      },
      writeCriticalLog(source, _message, metadata) {
        events.push(`log:CRITICAL:${source}:${metadata.eventType}`);
      },
      publish(type, _payload, correlationId) {
        events.push(`publish:${type}:${correlationId}`);
      },
      notify(notification) {
        events.push(`notify:${notification.priority}`);
      },
      publishTickTelemetry(_tick, _metrics, status, hotPathStartedAt) {
        events.push(`telemetry:${status}:${hotPathStartedAt}`);
      }
    }
  };
}

function anomaly(): AnomalyStatus {
  return {
    status: "ANOMALY",
    priceZScore: -8,
    volumeZScore: 6,
    cancellationToExecutionRatio: 10,
    cancellationCount: 12,
    executionCount: 1,
    lastAnomaly: null,
    updatedAt: OBSERVED_AT
  };
}

function anomalyResult(): AnomalyDetectionResult {
  const status = anomaly();

  return {
    state: {
      schemaVersion: "anomaly-detector.v1",
      priceWindowMs: 60_000,
      volumeWindowMs: 600_000,
      topOfBookWindowMs: 600_000,
      priceBuckets: [],
      volumeBuckets: [],
      topOfBookBuckets: [],
      lastTopOfBook: null,
      status,
      updatedAt: OBSERVED_AT
    },
    status,
    anomalies: [
      {
        anomalyId: "anomaly-1",
        types: ["FLASH_CRASH"],
        severity: "CRITICAL",
        instrumentCode: "btc-usd",
        exchangeCode: "hyperliquid",
        sequence: 42,
        priceZScore: -8,
        volumeZScore: 6,
        cancellationToExecutionRatio: 10,
        reason: "flash crash",
        triggeredPause: true,
        observedAt: OBSERVED_AT
      }
    ],
    emergencyPause: true
  };
}

function tick(): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    streamId: "stream-1",
    connectionId: "conn-1",
    sourceChannel: "trades",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    baseAsset: "BTC",
    quoteAsset: "USD",
    price: 100,
    size: 1,
    side: "sell",
    sequence: 42,
    providerTimestamp: OBSERVED_AT,
    exchangeTimestamp: OBSERVED_AT,
    synchronizedExchangeTimestamp: OBSERVED_AT,
    clockOffsetMs: 0,
    receivedAt: OBSERVED_AT,
    sourceWeight: 1
  };
}

function latency(): LatencyMetrics {
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
    networkLatencyMs: 1,
    processingLatencyMs: 1,
    totalLatencyMs: 2,
    maxLatencyMs: 150,
    averageLatencyMs: 2,
    sampleCount: 1,
    status: "FRESH",
    colo: "NRT",
    placement: "golden",
    latencyRiskMultiplier: 1,
    positionSizeMultiplier: 1,
    timeToBookMs: 1
  };
}

function dom(): DomAnalysisSnapshot {
  return {
    schemaVersion: "dom.analysis.v1",
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    sequence: 42,
    midPrice: 100,
    scanRangePct: 0.02,
    lowerBound: 98,
    upperBound: 102,
    binSize: 1,
    meanVolume: 1,
    sigmaVolume: 0.1,
    walls: [],
    pulledWalls: [],
    filledWalls: [],
    heatmap: {
      schemaVersion: "dom.heatmap.v1",
      columns: ["side", "priceStart", "priceEnd", "volume", "levelCount", "zScore"],
      rows: []
    },
    history: [],
    updatedAt: OBSERVED_AT
  };
}

function book(): InternalOrderBook {
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
    lastSequence: 42,
    tickSize: 1,
    ttbLatencyMs: 2,
    isSynced: true,
    desyncReason: null,
    sequence: 42,
    updatedAt: OBSERVED_AT
  };
}
