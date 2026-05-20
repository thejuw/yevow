import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import {
  buildCroupierEvaluationInput,
  buildOracleTickInput,
  buildProfilerContext,
  disabledOracleTickResult
} from "../../src/engine/trading/agents/AgentEvaluationRuntime";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import type { DomAnalysisSnapshot, InternalOrderBook, MarketTick } from "../../src/types";

const OBSERVED_AT = "2026-05-19T12:00:00.000Z";

describe("AgentEvaluationRuntime", () => {
  it("builds profiler context from book and DOM snapshots", () => {
    const context = buildProfilerContext({
      engineId: "engine-1",
      observedAt: OBSERVED_AT,
      book: book(),
      dom: dom(),
      liquidationHeatmap: null,
      jumpDetected: true
    });

    expect(context).toMatchObject({
      engineId: "engine-1",
      observedAt: OBSERVED_AT,
      midPrice: 100,
      spreadBps: 200,
      weightedImbalance: 0.25,
      liquidityWalls: [{ wallId: "wall-1" }],
      spoofingAlerts: [],
      liquidationHeatmap: null,
      jumpDetected: true
    });
    expect(context.orderBookBids?.[0]?.price).toBe(99);
    expect(context.orderBookAsks?.[0]?.price).toBe(101);
  });

  it("builds oracle inputs and disabled oracle results", () => {
    const state = defaultEngineState("engine-1");
    const oracleInput = buildOracleTickInput({
      tick: tick(),
      book: book(),
      observedAt: OBSERVED_AT,
      config: {
        ...defaultConfig,
        ORACLE_MANUAL_SKEPTICISM: 0.4,
        ORACLE_MAX_SKEPTICISM: 0.9
      }
    });

    expect(oracleInput).toMatchObject({
      observedAt: OBSERVED_AT,
      config: {
        ORACLE_GOVERNANCE_MODE: defaultConfig.ORACLE_GOVERNANCE_MODE,
        ORACLE_MANUAL_SKEPTICISM: 0.4,
        ORACLE_MAX_SKEPTICISM: 0.9
      }
    });

    const disabled = disabledOracleTickResult(state.oracle, OBSERVED_AT);
    expect(disabled).toMatchObject({
      bayesianTrace: null,
      regimeChanged: false,
      state: {
        updatedAt: OBSERVED_AT
      }
    });
  });

  it("builds croupier evaluation input with env-backed funding and offset fallbacks", () => {
    const state = defaultEngineState("engine-1");
    const input = buildCroupierEvaluationInput({
      engineId: state.engineId,
      book: book(),
      oracle: state.oracle,
      sentiment: state.sentiment,
      toxicityScore: 0.6,
      inventory: state.inventory,
      leadLag: state.leadLag,
      config: {
        ...defaultConfig,
        FUNDING_BIAS_THRESHOLD: 0,
        FUNDING_INVENTORY_BIAS: 0,
        MIN_EV_THRESHOLD: 0.01,
        EXCHANGE_FEE_BPS: 2
      },
      env: {
        FUNDING_HORIZON_HOURS: "2",
        FUNDING_BIAS_THRESHOLD: "0.0002",
        FUNDING_INVENTORY_BIAS: "0.15",
        HL_PREDATORY_ORDER_OFFSET_BPS: "4"
      },
      executionCostBufferBps: 1.2,
      bidAdversePenaltyBps: 3,
      askAdversePenaltyBps: 5,
      multiScaleVolatility: null,
      fundingRateHourly: 0.0001,
      liquidationHeatmap: state.liquidationHeatmap,
      profilerToxicityState: "CONTESTED",
      profilerPressureSide: "BUY",
      profilerSpreadMultiplier: 1.5,
      profilerReservationShiftBps: 2,
      sentimentAlphaMode: "EVENT_RISK_ONLY",
      macroBias: state.macroBias,
      observedAt: OBSERVED_AT
    });

    expect(input).toMatchObject({
      engineId: "engine-1",
      toxicityScore: 0.6,
      minEvThreshold: 0.01,
      exchangeFeeBps: 2,
      executionCostBufferBps: 1.2,
      adverseSelectionPenaltyBps: 5,
      fundingRateHourly: 0.0001,
      fundingHorizonHours: 2,
      fundingBiasThreshold: 0.0002,
      fundingInventoryBias: 0.15,
      predatoryOrderOffsetBps: 4,
      profilerToxicityState: "CONTESTED",
      profilerPressureSide: "BUY",
      sentimentAlphaMode: "EVENT_RISK_ONLY",
      observedAt: OBSERVED_AT
    });
  });
});

function tick(): MarketTick {
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
    sequence: 1,
    exchangeTimestamp: OBSERVED_AT,
    synchronizedExchangeTimestamp: OBSERVED_AT,
    clockOffsetMs: 0,
    receivedAt: OBSERVED_AT,
    sourceWeight: 1
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
    weightedImbalance: 0.25,
    lastSequence: 1,
    tickSize: 1,
    ttbLatencyMs: 1,
    isSynced: true,
    desyncReason: null,
    sequence: 1,
    updatedAt: OBSERVED_AT
  };
}

function dom(): DomAnalysisSnapshot {
  return {
    schemaVersion: "dom.analysis.v1",
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    sequence: 1,
    midPrice: 100,
    scanRangePct: 0.02,
    lowerBound: 98,
    upperBound: 102,
    binSize: 1,
    meanVolume: 1,
    sigmaVolume: 0.1,
    walls: [
      {
        wallId: "wall-1",
        instrumentCode: "btc-usd",
        side: "BID",
        priceStart: 99,
        priceEnd: 100,
        volume: 10,
        meanVolume: 1,
        sigmaVolume: 0.1,
        zScore: 90,
        levelCount: 1,
        firstSeenAt: OBSERVED_AT,
        lastSeenAt: OBSERVED_AT,
        status: "ACTIVE"
      }
    ],
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
