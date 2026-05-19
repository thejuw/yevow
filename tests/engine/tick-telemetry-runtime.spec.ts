import { describe, expect, it } from "vitest";
import { neutralMacroBias } from "../../src/Governor";
import { buildTickTelemetryPayload } from "../../src/engine/trading/telemetry/TickTelemetryRuntime";
import { defaultEngineState } from "../../src/TradingEngineRuntimeHelpers";
import type { AgentSignal, LatencyMetrics, MarketTick } from "../../src/types";

describe("TickTelemetryRuntime", () => {
  it("builds the tick telemetry payload from current engine state", () => {
    const state = defaultEngineState("engine-telemetry");
    state.averageLatency = 12.5;
    state.staleTickCount = 2;
    state.internalOrderBookDepth = 40;
    state.toxicityScore = 0.42;
    state.executionProfile = {
      ...state.executionProfile,
      status: "UNSTABLE",
      jitterMs: 11,
      wakeUpTimeMs: 3,
      orderBookUpdateMs: 4,
      agentLogicMs: 5
    };
    state.location = {
      colo: "NRT",
      placement: "tokyo",
      isGoldenRegion: true,
      latencyRiskMultiplier: 1,
      positionSizeMultiplier: 1,
      updatedAt: "2026-05-19T12:00:00.000Z"
    };
    state.inventory = {
      ...state.inventory,
      netDelta: 0.1,
      maxInventoryUnits: 0.5,
      inventoryPenalty: 0.01,
      stopBid: false,
      stopAsk: true
    };
    state.microstructure = {
      ...state.microstructure,
      weightedImbalance: 0.25,
      midPrice: 100
    };

    const result = buildTickTelemetryPayload({
      tick: tick(),
      metrics: latencyMetrics({ timeToBookMs: 7 }),
      status: "FRESH",
      cpuTimeMs: 1.25,
      engineState: state,
      macroBias: neutralMacroBias(),
      temporaryOverride: null,
      connectedAdminStreams: 2,
      signals: Array.from({ length: 6 }, (_, index) => signal(`signal-${index}`))
    });

    expect(result.correlationId).toBe("btc-usd:10");
    expect(result.payload).toMatchObject({
      instrumentCode: "btc-usd",
      exchangeCode: "HL",
      sequence: 10,
      status: "FRESH",
      cpuTimeMs: 1.25,
      websocketLatencyMs: 100,
      processingLatencyMs: 150,
      totalLatencyMs: 250,
      timeToBookMs: 7,
      orderBookDepth: 40,
      averageLatencyMs: 12.5,
      staleTickCount: 2,
      toxicityScore: 0.42,
      jitterMs: 11,
      executionStatus: "UNSTABLE",
      wakeUpTimeMs: 3,
      orderBookUpdateMs: 4,
      agentLogicMs: 5,
      colo: "NRT",
      placement: "tokyo",
      isGoldenRegion: true,
      connectedAdminStreams: 2,
      weightedImbalance: 0.25,
      midPrice: 100
    });
    expect(result.payload.AgentLogicTrace).toEqual([
      {
        agent: "ORACLE",
        action: "HOLD",
        confidence: 0.5,
        rationale: "signal-1",
        createdAt: "2026-05-19T12:00:00.000Z"
      },
      {
        agent: "ORACLE",
        action: "HOLD",
        confidence: 0.5,
        rationale: "signal-2",
        createdAt: "2026-05-19T12:00:00.000Z"
      },
      {
        agent: "ORACLE",
        action: "HOLD",
        confidence: 0.5,
        rationale: "signal-3",
        createdAt: "2026-05-19T12:00:00.000Z"
      },
      {
        agent: "ORACLE",
        action: "HOLD",
        confidence: 0.5,
        rationale: "signal-4",
        createdAt: "2026-05-19T12:00:00.000Z"
      },
      {
        agent: "ORACLE",
        action: "HOLD",
        confidence: 0.5,
        rationale: "signal-5",
        createdAt: "2026-05-19T12:00:00.000Z"
      }
    ]);
  });
});

function tick(overrides: Partial<MarketTick> = {}): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    exchangeCode: "HL",
    instrumentCode: "btc-usd",
    baseAsset: "BTC",
    quoteAsset: "USD",
    price: 100,
    size: 1,
    side: "buy",
    sequence: 10,
    exchangeTimestamp: "2026-05-19T12:00:00.000Z",
    synchronizedExchangeTimestamp: "2026-05-19T12:00:00.000Z",
    clockOffsetMs: 0,
    receivedAt: "2026-05-19T12:00:00.050Z",
    sourceWeight: 1,
    ...overrides
  };
}

function latencyMetrics(overrides: Partial<LatencyMetrics> = {}): LatencyMetrics {
  return {
    instrumentCode: "btc-usd",
    exchangeCode: "HL",
    source: "HYPERLIQUID",
    sourceExchange: "hyperliquid",
    sourceWeight: 1,
    sequence: 10,
    providerTimestamp: "2026-05-19T12:00:00.000Z",
    sourceTimestamp: "2026-05-19T12:00:00.000Z",
    ingestTimestamp: "2026-05-19T12:00:00.100Z",
    brainTimestamp: "2026-05-19T12:00:00.250Z",
    clockOffsetMs: 0,
    networkLatencyMs: 100,
    processingLatencyMs: 150,
    totalLatencyMs: 250,
    maxLatencyMs: 500,
    averageLatencyMs: 0,
    sampleCount: 0,
    status: "FRESH",
    colo: "NRT",
    placement: "tokyo",
    latencyRiskMultiplier: 1,
    positionSizeMultiplier: 1,
    ...overrides
  };
}

function signal(rationale: string): AgentSignal {
  return {
    signalId: rationale,
    traceId: `trace-${rationale}`,
    sourceAgent: "ORACLE",
    targetAgent: "CROUPIER",
    instrumentCode: "btc-usd",
    action: "HOLD",
    confidence: 0.5,
    horizonMs: 1_000,
    expectedValue: 0,
    maxSlippageBps: 1,
    rationale,
    featureVector: {},
    riskContext: {},
    createdAt: "2026-05-19T12:00:00.000Z"
  };
}
