import { AnomalyDetector, type AnomalyDetectionResult } from "../../src/agents/AnomalyDetector";
import {
  handleTickRuntime,
  type PreparedTickLatencyDecision,
  type TickHandlingRuntimeHandlers,
  type TickHandlingRuntimeInput
} from "../../src/engine/trading/pipelines/TickHandlingRuntime";
import type {
  AcceptedDecisionPipelineInput,
  PostBookTickContext,
  TickBookResolution
} from "../../src/engine/trading/pipelines/TickPipelineTypes";
import type { TickIngestResult } from "../../src/engine/trading/TradingEngineRouteTypes";
import type { InternalOrderBook, LatencyMetrics, MarketTick } from "../../src/types";
import { describe, expect, it } from "vitest";

describe("TickHandlingRuntime", () => {
  it("rejects non-target assets before touching hot-path handlers", async () => {
    const events: string[] = [];

    const result = await handleTickRuntime(
      input({ tick: marketTick({ instrumentCode: "doge-usd", baseAsset: "DOGE" }) }),
      handlers(events)
    );

    expect(result).toEqual({
      accepted: false,
      status: "IGNORED",
      reason: "NON_TARGET_ASSET",
      processedCount: 0
    });
    expect(events).toEqual([]);
  });

  it("honors trading availability gates before latency and book work", async () => {
    const events: string[] = [];
    const disabled: TickIngestResult = {
      accepted: false,
      status: "DISABLED",
      reason: "kill-switch"
    };

    const result = await handleTickRuntime(
      input(),
      handlers(events, { tradingAvailability: disabled })
    );

    expect(result).toBe(disabled);
    expect(events).toEqual(["auto:false", "availability:false"]);
  });

  it("routes hard-stale ticks to the hard drop handler", async () => {
    const events: string[] = [];

    const result = await handleTickRuntime(
      input({ tradingEnabled: true }),
      handlers(events, {
        latency: preparedLatency({
          metrics: latencyMetrics({ status: "STALE" }),
          streamId: "grpc:btc",
          hardStaleDropMs: 150,
          isHardStale: true
        })
      })
    );

    expect(result).toMatchObject({
      accepted: false,
      status: "STALE_DROPPED",
      reason: "hard-stale"
    });
    expect(events).toEqual([
      "auto:false",
      "availability:false",
      "remember:2026-05-18T12:00:00.010Z",
      "absorb:btc-usd",
      "latency:false",
      "hard:grpc:btc:150"
    ]);
  });

  it("routes soft-stale live ticks to the soft stale handler", async () => {
    const events: string[] = [];

    const result = await handleTickRuntime(
      input({ tradingEnabled: true, wakeUpTimeMs: 9, hotPathStartedAt: 123 }),
      handlers(events, {
        latency: preparedLatency({
          metrics: latencyMetrics({ status: "STALE" }),
          isHardStale: false
        })
      })
    );

    expect(result).toMatchObject({
      accepted: false,
      status: "STALE",
      reason: "soft-stale"
    });
    expect(events).toEqual([
      "auto:false",
      "availability:false",
      "remember:2026-05-18T12:00:00.010Z",
      "absorb:btc-usd",
      "latency:false",
      "soft:9:123"
    ]);
  });

  it("applies funding, book resolution, anomaly evaluation, and accepted pipeline work", async () => {
    const events: string[] = [];
    let capturedPipeline: AcceptedDecisionPipelineInput | null = null;
    const book = orderBook();
    const metrics = latencyMetrics();

    const result = await handleTickRuntime(
      input({ wakeUpTimeMs: 11, hotPathStartedAt: 222, options: { shadowReplay: true } }),
      handlers(events, {
        latency: preparedLatency({ metrics }),
        bookResolution: { kind: "BOOK", book, orderBookUpdateMs: 4 },
        capturePipeline: (pipeline) => {
          capturedPipeline = pipeline;
        }
      })
    );

    expect(result).toEqual({
      accepted: true,
      status: "FRESH",
      metrics,
      book
    });
    expect(capturedPipeline).toMatchObject({
      tick: { instrumentCode: "btc-usd" },
      metrics,
      book,
      wakeUpTimeMs: 11,
      orderBookUpdateMs: 4,
      hotPathStartedAt: 222,
      shadowReplay: true
    });
    expect(events).toEqual([
      "auto:true",
      "availability:true",
      "remember:2026-05-18T12:00:00.010Z",
      "absorb:btc-usd",
      "latency:true",
      "funding:2026-05-18T12:00:00.050Z",
      "book:FRESH:11:222",
      "post:2026-05-18T12:00:00.050Z:true",
      "now",
      "anomaly:2026-05-18T12:00:00.050Z",
      "pipeline:btc-usd:true:4"
    ]);
  });

  it("pauses immediately on anomaly emergencies before accepted pipeline side effects", async () => {
    const events: string[] = [];

    const result = await handleTickRuntime(
      input({ tradingEnabled: true, hotPathStartedAt: 333 }),
      handlers(events, {
        anomalyResult: anomalyResult({ emergencyPause: true }),
        nowMs: 88
      })
    );

    expect(result).toMatchObject({
      accepted: false,
      status: "ANOMALY_PAUSE",
      reason: "emergency"
    });
    expect(events).toEqual([
      "auto:false",
      "availability:false",
      "remember:2026-05-18T12:00:00.010Z",
      "absorb:btc-usd",
      "latency:false",
      "funding:2026-05-18T12:00:00.050Z",
      "book:FRESH:null:333",
      "post:2026-05-18T12:00:00.050Z:false",
      "now",
      "anomaly:2026-05-18T12:00:00.050Z",
      "emergency:88:2:333"
    ]);
  });
});

function handlers(
  events: string[],
  options: {
    readonly tradingAvailability?: TickIngestResult;
    readonly latency?: PreparedTickLatencyDecision;
    readonly bookResolution?: TickBookResolution;
    readonly anomalyResult?: AnomalyDetectionResult;
    readonly nowMs?: number;
    readonly capturePipeline?: (pipeline: AcceptedDecisionPipelineInput) => void;
  } = {}
): TickHandlingRuntimeHandlers {
  return {
    maybeAutoResumeShadowMode(_tick, shadowReplay) {
      events.push(`auto:${shadowReplay}`);
    },
    resolveTradingAvailability(_tick, shadowReplay) {
      events.push(`availability:${shadowReplay}`);
      return options.tradingAvailability ?? null;
    },
    rememberLastTickTimestamp(receivedAt) {
      events.push(`remember:${receivedAt}`);
    },
    observeCascadeAbsorption(tick) {
      events.push(`absorb:${tick.instrumentCode}`);
    },
    prepareTickLatency(_tick, shadowReplay) {
      events.push(`latency:${shadowReplay}`);
      return options.latency ?? preparedLatency();
    },
    handleHardStaleTickDrop(_tick, _metrics, streamId, hardStaleDropMs) {
      events.push(`hard:${streamId}:${hardStaleDropMs}`);
      return Promise.resolve({
        accepted: false,
        status: "STALE_DROPPED",
        reason: "hard-stale"
      });
    },
    handleSoftStaleTick(_tick, _metrics, wakeUpTimeMs, hotPathStartedAt) {
      events.push(`soft:${wakeUpTimeMs}:${hotPathStartedAt}`);
      return Promise.resolve({
        accepted: false,
        status: "STALE",
        reason: "soft-stale"
      });
    },
    applyFundingTick(_tick, observedAt) {
      events.push(`funding:${observedAt}`);
    },
    resolveTickBook(_tick, metrics, wakeUpTimeMs, hotPathStartedAt) {
      events.push(`book:${metrics.status}:${wakeUpTimeMs}:${hotPathStartedAt}`);
      return Promise.resolve(
        options.bookResolution ?? {
          kind: "BOOK",
          book: orderBook(),
          orderBookUpdateMs: 2
        }
      );
    },
    preparePostBookTickContext(_tick, _book, observedAt, tickOptions) {
      events.push(`post:${observedAt}:${tickOptions.shadowReplay === true}`);
      return Promise.resolve(postBookContext());
    },
    evaluateAnomaly(_tick, _book, _domSnapshot, observedAt) {
      events.push(`anomaly:${observedAt}`);
      return options.anomalyResult ?? anomalyResult();
    },
    nowMs() {
      events.push("now");
      return options.nowMs ?? 77;
    },
    handleAnomalyEmergencyPause(
      _tick,
      _book,
      _domSnapshot,
      _anomalyResult,
      anomalyLogicStartedAt,
      _metrics,
      _wakeUpTimeMs,
      orderBookUpdateMs,
      hotPathStartedAt
    ) {
      events.push(`emergency:${anomalyLogicStartedAt}:${orderBookUpdateMs}:${hotPathStartedAt}`);
      return Promise.resolve({
        accepted: false,
        status: "ANOMALY_PAUSE",
        reason: "emergency"
      });
    },
    processAcceptedDecisionPipeline(pipeline) {
      events.push(
        `pipeline:${pipeline.tick.instrumentCode}:${pipeline.shadowReplay}:${pipeline.orderBookUpdateMs}`
      );
      options.capturePipeline?.(pipeline);
      return Promise.resolve();
    }
  };
}

function input(overrides: Partial<TickHandlingRuntimeInput> = {}): TickHandlingRuntimeInput {
  return {
    tick: marketTick(),
    wakeUpTimeMs: null,
    options: {},
    hotPathStartedAt: 1,
    tradingEnabled: false,
    shadowModeActive: false,
    ...overrides
  };
}

function preparedLatency(
  overrides: Partial<PreparedTickLatencyDecision> = {}
): PreparedTickLatencyDecision {
  return {
    metrics: latencyMetrics(),
    streamId: null,
    hardStaleDropMs: 150,
    isHardStale: false,
    ...overrides
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
    sequence: 42,
    exchangeTimestamp: "2026-05-18T12:00:00.000Z",
    synchronizedExchangeTimestamp: "2026-05-18T12:00:00.000Z",
    clockOffsetMs: 0,
    receivedAt: "2026-05-18T12:00:00.010Z",
    sourceWeight: 1,
    raw: {},
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
    sequence: 42,
    providerTimestamp: "2026-05-18T12:00:00.000Z",
    sourceTimestamp: "2026-05-18T12:00:00.000Z",
    ingestTimestamp: "2026-05-18T12:00:00.010Z",
    brainTimestamp: "2026-05-18T12:00:00.050Z",
    clockOffsetMs: 0,
    networkLatencyMs: 10,
    processingLatencyMs: 40,
    totalLatencyMs: 50,
    maxLatencyMs: 150,
    averageLatencyMs: 20,
    sampleCount: 3,
    status: "FRESH",
    colo: "NRT",
    placement: "remote-nrt",
    latencyRiskMultiplier: 1,
    positionSizeMultiplier: 1,
    ...overrides
  };
}

function orderBook(): InternalOrderBook {
  return {
    marketKey: "hyperliquid:btc-usd",
    instrumentCode: "btc-usd",
    source_exchange: "hyperliquid",
    exchangeCode: "hyperliquid",
    bestBid: 99,
    bestAsk: 101,
    midPrice: 100,
    spread: 2,
    weightedImbalance: 0,
    bids: [],
    asks: [],
    updatedAt: "2026-05-18T12:00:00.050Z"
  } as unknown as InternalOrderBook;
}

function postBookContext(): PostBookTickContext {
  return {
    volatilitySnapshot: null,
    shadowQueueState: {},
    domSnapshot: { instrumentCode: "btc-usd", pulledWalls: [] }
  } as unknown as PostBookTickContext;
}

function anomalyResult(overrides: Partial<AnomalyDetectionResult> = {}): AnomalyDetectionResult {
  const result = new AnomalyDetector().evaluate({
    tick: marketTick(),
    book: orderBook(),
    dom: { instrumentCode: "btc-usd", pulledWalls: [] } as unknown as Parameters<
      AnomalyDetector["evaluate"]
    >[0]["dom"],
    observedAt: "2026-05-18T12:00:00.050Z"
  });

  return {
    ...result,
    ...overrides
  };
}
