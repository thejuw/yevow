import { describe, expect, it } from "vitest";
import {
  applyShadowReplayPreparation,
  buildPreparedShadowReplayState
} from "../../src/engine/trading/replay/ReplayPreparationRuntime";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";

const STARTED_AT = "2026-05-18T10:00:00.000Z";

describe("ReplayPreparationRuntime", () => {
  it("builds isolated shadow replay config and engine state", () => {
    const liveState = defaultEngineState("engine-live");

    const prepared = buildPreparedShadowReplayState({
      currentConfig: liveState.cachedConfig,
      liveState,
      initialShadowBankroll: 420,
      defaultMaxPositionPct: 0.05,
      defaultMaxInventoryUnits: 1,
      startedAt: STARTED_AT,
      replayId: "replay-prepare"
    });

    expect(prepared.cachedConfig).toMatchObject({
      TRADING_ENABLED: true,
      MAX_POSITION_SIZE: 420,
      MAX_POSITION_PCT: 0.05,
      MAX_INVENTORY_UNITS: 1,
      updatedAt: STARTED_AT,
      updatedBy: "shadow-replay"
    });
    expect(prepared.cachedConfig.version).toContain(":shadow-replay:replay-prepare");
    expect(prepared.engineState).toMatchObject({
      engineId: "engine-live:shadow:replay-prepare",
      mode: "PAPER",
      cachedConfig: prepared.cachedConfig,
      bankroll: {
        cash: 420,
        equity: 420,
        realizedPnl: 0,
        updatedAt: STARTED_AT
      },
      heartbeatAt: STARTED_AT,
      updatedAt: STARTED_AT
    });
  });

  it("applies shadow replay preparation side effects in deterministic order", () => {
    const calls: string[] = [];
    let appliedStateVersion = "";

    const prepared = applyShadowReplayPreparation(
      {
        currentConfig: defaultEngineState("engine-live").cachedConfig,
        liveState: defaultEngineState("engine-live"),
        initialShadowBankroll: 300,
        defaultMaxPositionPct: 0.05,
        defaultMaxInventoryUnits: 1,
        startedAt: STARTED_AT,
        replayId: "replay-side-effects"
      },
      {
        clearMarketState: () => calls.push("clear-market"),
        resetRuntimeSamples: () => calls.push("reset-samples"),
        applyPreparedState: (preparedState) => {
          calls.push("apply-state");
          appliedStateVersion = preparedState.cachedConfig.version;
        },
        resetAgents: () => calls.push("reset-agents")
      }
    );

    expect(calls).toEqual(["clear-market", "reset-samples", "apply-state", "reset-agents"]);
    expect(appliedStateVersion).toBe(prepared.cachedConfig.version);
  });
});
