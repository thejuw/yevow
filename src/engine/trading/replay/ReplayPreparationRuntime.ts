import type { EngineState, GlobalRiskConfig } from "../../../types";
import { buildShadowReplayConfig, buildShadowReplayEngineState } from "./ReplayResultRuntime";

export interface PrepareShadowReplayStateInput {
  readonly currentConfig: GlobalRiskConfig;
  readonly liveState: EngineState;
  readonly initialShadowBankroll: number;
  readonly defaultMaxPositionPct: number;
  readonly defaultMaxInventoryUnits: number;
  readonly startedAt: string;
  readonly replayId: string;
}

export interface PreparedShadowReplayState {
  readonly cachedConfig: GlobalRiskConfig;
  readonly engineState: EngineState;
}

export interface ShadowReplayPreparationHandlers {
  readonly clearMarketState: () => void;
  readonly resetRuntimeSamples: () => void;
  readonly applyPreparedState: (preparedState: PreparedShadowReplayState) => void;
  readonly resetAgents: () => void;
}

export function buildPreparedShadowReplayState(
  input: PrepareShadowReplayStateInput
): PreparedShadowReplayState {
  const cachedConfig = buildShadowReplayConfig({
    currentConfig: input.currentConfig,
    initialShadowBankroll: input.initialShadowBankroll,
    defaultMaxPositionPct: input.defaultMaxPositionPct,
    defaultMaxInventoryUnits: input.defaultMaxInventoryUnits,
    startedAt: input.startedAt,
    replayId: input.replayId
  });

  return {
    cachedConfig,
    engineState: buildShadowReplayEngineState({
      liveState: input.liveState,
      cachedConfig,
      initialShadowBankroll: input.initialShadowBankroll,
      startedAt: input.startedAt,
      replayId: input.replayId
    })
  };
}

export function applyShadowReplayPreparation(
  input: PrepareShadowReplayStateInput,
  handlers: ShadowReplayPreparationHandlers
): PreparedShadowReplayState {
  const preparedState = buildPreparedShadowReplayState(input);

  handlers.clearMarketState();
  handlers.resetRuntimeSamples();
  handlers.applyPreparedState(preparedState);
  handlers.resetAgents();

  return preparedState;
}
