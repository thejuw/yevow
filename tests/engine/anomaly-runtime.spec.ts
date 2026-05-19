import { describe, expect, it } from "vitest";
import { stateAfterAnomalyEmergencyPause } from "../../src/engine/trading/anomaly/AnomalyRuntime";
import { defaultEngineState } from "../../src/TradingEngineRuntimeHelpers";
import type { AnomalyStatus, DomAnalysisSnapshot, InternalOrderBook } from "../../src/types";

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
});

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
