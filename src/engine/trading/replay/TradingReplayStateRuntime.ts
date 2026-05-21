import {
  DEFAULT_MAX_INVENTORY_UNITS,
  DEFAULT_MAX_POSITION_PCT
} from "../../../TradingEngineConstants";
import type { EngineState, GlobalRiskConfig } from "../../../types";
import {
  applyShadowReplayPreparation,
  type PreparedShadowReplayState
} from "./ReplayPreparationRuntime";
import {
  captureEngineReplaySnapshot,
  restoreReplaySnapshotSideEffects,
  type CaptureEngineReplaySnapshotInput,
  type EngineReplaySnapshot,
  type ReplaySnapshotRestoreHandlers
} from "./ReplaySnapshotRuntime";

export type { EngineReplaySnapshot } from "./ReplaySnapshotRuntime";

export interface TradingShadowReplayStateInput {
  readonly currentConfig: GlobalRiskConfig;
  readonly liveState: EngineState;
  readonly initialShadowBankroll: number;
  readonly startedAt: string;
  readonly replayId: string;
}

export interface TradingShadowReplayStateHandlers {
  readonly clearMarketState: () => void;
  readonly resetRuntimeSamples: () => void;
  readonly applyPreparedState: (preparedState: PreparedShadowReplayState) => void;
  readonly resetAgents: () => void;
}

export function prepareTradingShadowReplayState(
  input: TradingShadowReplayStateInput,
  handlers: TradingShadowReplayStateHandlers
): void {
  applyShadowReplayPreparation(
    {
      currentConfig: input.currentConfig,
      liveState: input.liveState,
      initialShadowBankroll: input.initialShadowBankroll,
      defaultMaxPositionPct: DEFAULT_MAX_POSITION_PCT,
      defaultMaxInventoryUnits: DEFAULT_MAX_INVENTORY_UNITS,
      startedAt: input.startedAt,
      replayId: input.replayId
    },
    handlers
  );
}

export function captureTradingReplaySnapshot(
  input: CaptureEngineReplaySnapshotInput
): EngineReplaySnapshot {
  return captureEngineReplaySnapshot(input);
}

export function restoreTradingReplaySnapshot(
  snapshot: EngineReplaySnapshot,
  handlers: ReplaySnapshotRestoreHandlers
): Promise<void> {
  return restoreReplaySnapshotSideEffects(snapshot, handlers);
}
