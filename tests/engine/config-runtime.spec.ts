import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import { neutralMacroBias } from "../../src/Governor";
import {
  buildConfigRefreshLog,
  buildRuntimeConfigAppliedLog,
  shouldLogConfigRefresh,
  stateAfterConfigRefresh,
  stateAfterRuntimeConfigUpdate
} from "../../src/engine/trading/config/ConfigRuntime";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import type { AdminConfigUpdate } from "../../src/types";

describe("ConfigRuntime", () => {
  it("applies runtime admin updates while preserving config and governance context", () => {
    const currentState = defaultEngineState("config-runtime");
    currentState.mode = "PAPER";
    currentState.bankroll = {
      currency: "USD",
      cash: 300,
      equity: 300,
      realizedPnl: 0,
      updatedAt: "2026-05-18T14:00:00.000Z"
    };
    currentState.location = {
      ...currentState.location,
      positionSizeMultiplier: 0.5
    };
    currentState.risk = {
      ...currentState.risk,
      perAssetMaxPosition: {
        "btc-usd": 50
      }
    };

    const cachedConfig = {
      ...defaultConfig,
      TRADING_ENABLED: false,
      MAX_POSITION_SIZE: 200,
      MAX_DRAWDOWN_PCT: 0.04,
      version: "config-v2"
    };
    const update: AdminConfigUpdate = {
      mode: "HALTED",
      maxLatencyMs: 175,
      bankroll: {
        equity: 325
      },
      risk: {
        perAssetMaxPosition: {
          "eth-usd": 25
        }
      }
    };

    const result = stateAfterRuntimeConfigUpdate({
      currentState,
      update,
      cachedConfig,
      macroBias: neutralMacroBias(),
      temporaryOverride: null,
      currentMaxLatencyMs: 250,
      observedAt: "2026-05-18T15:00:00.000Z"
    });

    expect(result.maxLatencyMs).toBe(175);
    expect(result.state).toMatchObject({
      mode: "HALTED",
      bankroll: {
        currency: "USD",
        cash: 300,
        equity: 325,
        realizedPnl: 0,
        updatedAt: "2026-05-18T15:00:00.000Z"
      },
      maxLatencyMs: 175,
      cachedConfig,
      temporaryOverride: null,
      heartbeatAt: "2026-05-18T15:00:00.000Z",
      updatedAt: "2026-05-18T15:00:00.000Z",
      risk: {
        configVersion: "config-v2",
        killSwitch: true,
        maxOrderNotional: 100,
        maxDrawdownPct: 0.04,
        updatedAt: "2026-05-18T15:00:00.000Z",
        perAssetMaxPosition: {
          "btc-usd": 50,
          "eth-usd": 25
        }
      }
    });
  });

  it("assembles refreshed config state with location-adjusted risk", () => {
    const currentState = defaultEngineState("config-refresh");
    const cachedConfig = {
      ...defaultConfig,
      TRADING_ENABLED: true,
      MAX_POSITION_SIZE: 250,
      MAX_DRAWDOWN_PCT: 0.03,
      LATENCY_THRESHOLD_MS: 150,
      version: "config-refresh-v1"
    };
    const refreshedLocation = {
      ...currentState.location,
      colo: "NRT",
      positionSizeMultiplier: 0.7,
      latencyRiskMultiplier: 1.2
    };
    const nextQuoteState = {
      ...currentState.quoteState,
      status: "ACTIVE" as const,
      updatedAt: "2026-05-18T15:00:00.000Z"
    };
    const nextAssetQuoteStates = {
      "btc-usd": nextQuoteState
    };
    const assetMatrix = {
      "btc-usd": {
        ...currentState.assetMatrix["btc-usd"],
        selected: true
      }
    };
    const profilerStates = {
      "btc-usd": {
        ...currentState.profilerStates["btc-usd"],
        toxicityScore: 0.25
      }
    };

    const result = stateAfterConfigRefresh({
      currentState,
      nextConfig: cachedConfig,
      macroBias: neutralMacroBias(),
      temporaryOverride: null,
      nextAssetQuoteStates,
      nextQuoteState,
      assetMatrix,
      profilerStates,
      refreshedLocation,
      observedAt: "2026-05-18T15:00:00.000Z"
    });

    expect(result).toMatchObject({
      cachedConfig,
      assetQuoteStates: nextAssetQuoteStates,
      quoteState: nextQuoteState,
      assetMatrix,
      profilerStates,
      maxLatencyMs: 150,
      location: refreshedLocation,
      updatedAt: "2026-05-18T15:00:00.000Z",
      risk: {
        configVersion: "config-refresh-v1",
        killSwitch: false,
        maxDrawdownPct: 0.03,
        updatedAt: "2026-05-18T15:00:00.000Z"
      }
    });
    expect(result.risk.maxOrderNotional).toBe(175);
  });

  it("builds config refresh audit metadata only when meaningful", () => {
    const nextConfig = {
      ...defaultConfig,
      TRADING_ENABLED: true,
      MAX_POSITION_SIZE: 250,
      MAX_DRAWDOWN_PCT: 0.03,
      LATENCY_THRESHOLD_MS: 150,
      GOLDEN_COLOS: ["NRT", "HND"],
      version: "config-v2"
    };
    const input = {
      source: "ALARM" as const,
      previousVersion: "config-v1",
      nextConfig,
      macroBias: neutralMacroBias(),
      temporaryOverride: null
    };

    expect(shouldLogConfigRefresh(input)).toBe(true);
    expect(
      shouldLogConfigRefresh({
        ...input,
        previousVersion: "config-v2"
      })
    ).toBe(false);
    expect(
      shouldLogConfigRefresh({
        ...input,
        source: "ADMIN_SIGNAL",
        previousVersion: "config-v2"
      })
    ).toBe(true);
    expect(buildConfigRefreshLog(input)).toMatchObject({
      source: "ALARM",
      tradingEnabled: true,
      maxPositionSize: 250,
      maxDrawdownPct: 0.03,
      latencyThresholdMs: 150,
      goldenColos: ["NRT", "HND"],
      configVersion: "config-v2",
      macroBias: {
        schemaVersion: "macro-bias.v1"
      },
      temporaryOverride: null
    });
  });

  it("builds runtime config applied audit metadata from state", () => {
    const state = defaultEngineState("config-audit");
    state.mode = "PAPER";
    state.risk = {
      ...state.risk,
      configVersion: "risk-v3",
      killSwitch: true
    };

    expect(buildRuntimeConfigAppliedLog({ state, maxLatencyMs: 175 })).toEqual({
      mode: "PAPER",
      riskConfigVersion: "risk-v3",
      maxLatencyMs: 175,
      killSwitch: true
    });
  });
});
