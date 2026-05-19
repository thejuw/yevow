import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import { neutralMacroBias } from "../../src/Governor";
import { stateAfterRuntimeConfigUpdate } from "../../src/engine/trading/config/ConfigRuntime";
import { defaultEngineState } from "../../src/TradingEngineRuntimeHelpers";
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
});
