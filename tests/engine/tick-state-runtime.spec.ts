import { describe, expect, it } from "vitest";
import {
  killSwitchActiveLogMetadata,
  shadowModeAutoResumeLogMetadata,
  shadowModeAutoResumeTelemetry,
  shouldAutoResumeShadowMode,
  shouldBlockHaltedTrading,
  shouldLogDisabledTrading,
  stateAfterAcceptedTick,
  stateAfterShadowModeAutoResume
} from "../../src/engine/trading/state/TickStateRuntime";
import { defaultEngineState } from "../../src/engine/trading/helpers/RuntimeHelpers";
import type { DomAnalysisSnapshot, InternalOrderBook, ManagedOrder } from "../../src/types";

const OBSERVED_AT = "2026-05-18T19:00:00.000Z";

describe("TickStateRuntime", () => {
  it("evaluates tick preflight mode gates", () => {
    expect(
      shouldAutoResumeShadowMode({
        shadowReplay: false,
        shadowMode: true,
        tradingEnabled: true,
        mode: "HALTED"
      })
    ).toBe(true);
    expect(
      shouldAutoResumeShadowMode({
        shadowReplay: true,
        shadowMode: true,
        tradingEnabled: true,
        mode: "HALTED"
      })
    ).toBe(false);
    expect(
      shouldBlockHaltedTrading({
        shadowReplay: false,
        shadowMode: false,
        tradingEnabled: true,
        mode: "HALTED"
      })
    ).toBe(true);
    expect(
      shouldLogDisabledTrading({
        shadowReplay: false,
        tradingEnabled: false,
        killSwitchLogged: false
      })
    ).toBe(true);
    expect(
      shadowModeAutoResumeLogMetadata({
        tick: { instrumentCode: "btc-usd" },
        configVersion: "config-1"
      })
    ).toEqual({
      instrumentCode: "btc-usd",
      previousMode: "HALTED",
      nextMode: "PAPER",
      configVersion: "config-1"
    });
    expect(shadowModeAutoResumeTelemetry(OBSERVED_AT)).toEqual({
      reason: "SHADOW_MODE_AUTO_RESUME",
      observedAt: OBSERVED_AT
    });
    expect(
      killSwitchActiveLogMetadata({
        tick: { instrumentCode: "btc-usd" },
        configVersion: "config-1",
        tradingEnabled: false,
        mode: "HALTED"
      })
    ).toEqual({
      instrumentCode: "btc-usd",
      configVersion: "config-1",
      tradingEnabled: false,
      mode: "HALTED"
    });
  });

  it("resumes shadow-mode paper trading from a halted state", () => {
    const currentState = defaultEngineState("shadow-resume");
    currentState.mode = "HALTED";
    currentState.risk = {
      ...currentState.risk,
      killSwitch: true
    };
    const assetQuoteStates = currentState.assetQuoteStates;
    const quoteState = {
      ...currentState.quoteState,
      status: "ACTIVE" as const,
      reason: null,
      updatedAt: OBSERVED_AT
    };
    const bankroll = {
      ...currentState.bankroll,
      equity: 300,
      cash: 300,
      updatedAt: OBSERVED_AT
    };

    const next = stateAfterShadowModeAutoResume({
      currentState,
      normalizedBankroll: bankroll,
      assetQuoteStates,
      quoteState,
      observedAt: OBSERVED_AT
    });

    expect(next).toMatchObject({
      mode: "PAPER",
      bankroll,
      risk: {
        killSwitch: false,
        updatedAt: OBSERVED_AT
      },
      quoteState,
      assetQuoteStates,
      heartbeatAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT
    });
  });

  it("assembles accepted tick engine state and tracks newly managed orders", () => {
    const currentState = defaultEngineState("tick-state-test");
    currentState.mode = "HALTED";
    currentState.processedTicks = 2;
    currentState.staleTickCount = 1;

    const inventory = {
      ...currentState.inventory,
      current_inventory_delta: 0.25,
      netDelta: 0.25,
      updatedAt: OBSERVED_AT
    };
    const riskMetrics = {
      ...currentState.riskMetrics,
      isTradingEnabled: false,
      updatedAt: OBSERVED_AT
    };
    const trackedOrder = managedOrder("quote-order-1");

    const next = stateAfterAcceptedTick({
      currentState,
      tradingEnabled: false,
      shadowReplay: false,
      latencyStatus: "STALE",
      internalOrderBookDepth: 8,
      book: book(),
      oracle: currentState.oracle,
      sentiment: currentState.sentiment,
      ensemble: currentState.ensemble,
      leadLag: currentState.leadLag,
      inventory,
      riskMetrics,
      quoteState: currentState.quoteState,
      assetQuoteStates: currentState.assetQuoteStates,
      shadowQueue: currentState.shadowQueue,
      lastTradeIntent: null,
      inventoryGuard: currentState.inventoryGuard,
      ordersToTrack: [trackedOrder],
      shouldTrackOrders: true,
      dom: dom(),
      anomaly: currentState.anomaly,
      assetMatrix: currentState.assetMatrix,
      profilerStates: currentState.profilerStates,
      toxicityScore: 0.42,
      agentHealth: currentState.agentHealth,
      maxLatencyMs: 150,
      observedAt: OBSERVED_AT
    });

    expect(next).toMatchObject({
      mode: "PAPER",
      processedTicks: 3,
      staleTickCount: 2,
      internalOrderBookDepth: 8,
      current_inventory_delta: 0.25,
      risk: { killSwitch: true, updatedAt: OBSERVED_AT },
      toxicityScore: 0.42,
      maxLatencyMs: 150,
      heartbeatAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT
    });
    expect(next.microstructure).toMatchObject({
      marketKey: "hyperliquid:btc-usd",
      midPrice: 100
    });
    expect(next.orderMap["quote-order-1"]).toBe(trackedOrder);
    expect(next.dom?.instrumentCode).toBe("btc-usd");
  });
});

function managedOrder(clientId: string): ManagedOrder {
  return {
    clientId,
    exchangeOrderId: null,
    intentId: "intent-1",
    instrumentCode: "btc-usd",
    side: "BUY",
    price: 100,
    size: 1,
    filledSize: 0,
    status: "PENDING",
    createdAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT,
    ackDeadlineAt: OBSERVED_AT
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
