import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import { neutralMacroBias } from "../../src/Governor";
import {
  adminRecoveryResponse,
  adminRecoveryStorageEntries,
  stateAfterAdminControlledRecovery
} from "../../src/engine/trading/state/RecoveryRuntime";
import {
  defaultEngineState,
  defaultInventoryState
} from "../../src/engine/trading/state/EngineStateDefaults";
import type { EngineState } from "../../src/types";

const OBSERVED_AT = "2026-05-18T19:00:00.000Z";

describe("RecoveryRuntime", () => {
  it("resets paper portfolio, quote state, citadel, and risk gates for admin recovery", () => {
    const currentState = defaultEngineState("recovery-runtime");
    currentState.bankroll = {
      currency: "USD",
      cash: 200,
      equity: 175,
      realizedPnl: -25,
      updatedAt: "2026-05-18T18:00:00.000Z"
    };
    currentState.openPositions = {
      "btc-usd": position("btc-usd")
    };
    currentState.inventory = {
      ...defaultInventoryState(10, 5),
      current_inventory_delta: 2,
      updatedAt: "2026-05-18T18:00:00.000Z"
    };
    currentState.riskMetrics = {
      ...currentState.riskMetrics,
      rollingDrawdownPct: 0.25
    };

    const result = stateAfterAdminControlledRecovery({
      currentState,
      payload: { resetPaperPortfolio: true },
      cachedConfig: {
        ...defaultConfig,
        TRADING_ENABLED: true,
        MAX_DRAWDOWN_PCT: 0.05,
        MAX_INVENTORY_UNITS: 12,
        MAX_INVENTORY_DELTA: 6
      },
      macroBias: neutralMacroBias(),
      observedAt: OBSERVED_AT,
      shadowMode: true,
      paperBankroll: 300,
      shadowQueue: currentState.shadowQueue,
      reason: "manual-reset",
      resetInstruments: ["btc-usd"],
      sourceExchange: "hyperliquid",
      prunedProfilerStorageKeys: ["agent:profiler:old"]
    });

    expect(result.shouldClearShadowQueue).toBe(true);
    expect(result.state).toMatchObject({
      bankroll: {
        cash: 300,
        equity: 300,
        realizedPnl: 0,
        updatedAt: OBSERVED_AT
      },
      openPositions: {},
      inventory: {
        maxInventoryUnits: 12,
        maxInventoryDelta: 6,
        current_inventory_delta: 0,
        updatedAt: OBSERVED_AT
      },
      current_inventory_delta: 0,
      staleTickCount: 0,
      citadel: {
        shadowMode: true,
        updatedAt: OBSERVED_AT
      },
      riskMetrics: {
        isTradingEnabled: true,
        highWaterMark: 300,
        updatedAt: OBSERVED_AT
      },
      risk: {
        killSwitch: false,
        maxDrawdownPct: 0.05,
        updatedAt: OBSERVED_AT
      },
      executionProfile: {
        status: "STABLE",
        updatedAt: OBSERVED_AT
      },
      heartbeatAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT
    });
    expect(result.logMetadata).toMatchObject({
      reason: "manual-reset",
      resetInstruments: ["btc-usd"],
      clearShadowQueue: true,
      resetPaperPortfolio: true,
      prunedProfilerStorageKeys: ["agent:profiler:old"]
    });
    expect(result.publishPayload).toMatchObject({
      prunedProfilerStorageKeyCount: 1,
      tradingEnabled: true
    });
  });

  it("preserves optional state when recovery clear flags are disabled", () => {
    const currentState = defaultEngineState("recovery-runtime");
    currentState.riskMetrics = {
      ...currentState.riskMetrics,
      rollingDrawdownPct: 0.5
    };
    const previousQuoteState = currentState.quoteState;
    const previousAssetQuoteStates = currentState.assetQuoteStates;
    const previousCitadel = currentState.citadel;

    const result = stateAfterAdminControlledRecovery({
      currentState,
      payload: {
        clearQuoteState: false,
        clearCitadel: false,
        clearLatency: false,
        clearShadowQueue: false
      },
      cachedConfig: {
        ...defaultConfig,
        TRADING_ENABLED: true,
        MAX_DRAWDOWN_PCT: 0.05
      },
      macroBias: neutralMacroBias(),
      observedAt: OBSERVED_AT,
      shadowMode: false,
      paperBankroll: 300,
      shadowQueue: currentState.shadowQueue,
      reason: "recover-with-preserve",
      resetInstruments: [],
      sourceExchange: "hyperliquid",
      prunedProfilerStorageKeys: []
    });

    expect(result.shouldClearShadowQueue).toBe(false);
    expect(result.state.quoteState).toBe(previousQuoteState);
    expect(result.state.assetQuoteStates).toBe(previousAssetQuoteStates);
    expect(result.state.citadel).toBe(previousCitadel);
    expect(result.state.risk.killSwitch).toBe(true);
    expect(result.state.riskMetrics.isTradingEnabled).toBe(false);
    expect(result.publishPayload).toMatchObject({
      clearQuoteState: false,
      clearCitadel: false,
      clearLatency: false,
      clearShadowQueue: false
    });
  });

  it("builds recovery storage writes and response payloads", () => {
    const state = defaultEngineState("recovery-storage");
    const latencyHistory = [{ totalLatencyMs: 4 }];
    const processingLatencySamples = [1, 2, 3];

    expect(
      adminRecoveryStorageEntries({
        engineStateKey: "engine:state",
        state,
        performanceHistoryKey: "latency:history",
        latencyHistory,
        processingLatencySamplesKey: "latency:samples",
        processingLatencySamples
      })
    ).toEqual({
      "engine:state": state,
      "latency:history": latencyHistory,
      "latency:samples": processingLatencySamples
    });
    expect(
      adminRecoveryResponse({
        reason: "manual",
        resetInstruments: ["btc-usd"],
        sourceExchange: "hyperliquid",
        state
      })
    ).toMatchObject({
      ok: true,
      reason: "manual",
      resetInstruments: ["btc-usd"],
      source_exchange: "hyperliquid",
      state
    });
  });
});

function position(instrumentCode: string): EngineState["openPositions"][string] {
  return {
    instrumentCode,
    side: "LONG",
    quantity: 1,
    averageEntryPrice: 100,
    markPrice: 100,
    unrealizedPnl: 0,
    realizedPnl: 0,
    updatedAt: OBSERVED_AT
  };
}
