import type { MarketTick, ReplayResult } from "../../../types";
import type {
  HistoricalReplayCompletionInput,
  HistoricalReplayStatusInput,
  LoadedReplayShadowTrades,
  LoadedReplayTicks,
  ShadowReplayWithRestoreInput
} from "../pipelines/TickPipelineTypes";
import type { ReplayOptions } from "../routes/ReplayAdminRoutes";
import type { EngineReplaySnapshot } from "./ReplaySnapshotRuntime";
import type { ShadowReplayLoopResult } from "./ReplayLoopRuntime";
import { resolveInitialShadowBankroll } from "./ReplayResultRuntime";

export interface HistoricalReplayRuntimeInput {
  readonly limit: number;
  readonly requestedShadowBankroll: number;
  readonly speedMultiplier: number;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly replayOptions: ReplayOptions;
  readonly startedAt: string;
  readonly replayId: string;
  readonly fallbackBankroll: number;
}

export interface HistoricalReplayLiveBankroll {
  readonly equity: number;
  readonly cash: number;
}

export interface HistoricalReplayRuntimeHandlers {
  readonly nowIso: () => string;
  readonly writeRunningStatus: (input: HistoricalReplayStatusInput) => Promise<void>;
  readonly captureReplaySnapshot: () => EngineReplaySnapshot;
  readonly loadScenarioReplayTicks: (
    limit: number,
    dateFrom: string | null,
    dateTo: string | null,
    scenario: ReplayOptions["scenario"]
  ) => Promise<LoadedReplayTicks>;
  readonly currentLiveBankroll: () => HistoricalReplayLiveBankroll;
  readonly loadReplayShadowTrades: (ticks: MarketTick[]) => Promise<LoadedReplayShadowTrades>;
  readonly prepareShadowReplayState: (
    initialShadowBankroll: number,
    startedAt: string,
    replayId: string
  ) => void;
  readonly runShadowReplayWithRestore: (
    input: ShadowReplayWithRestoreInput
  ) => Promise<ShadowReplayLoopResult>;
  readonly recordCompletedReplay: (input: HistoricalReplayCompletionInput) => Promise<ReplayResult>;
}

export interface ShadowReplayRestoreRuntimeHandlers {
  readonly runShadowReplay: (
    input: ShadowReplayWithRestoreInput
  ) => Promise<ShadowReplayLoopResult>;
  readonly restoreReplaySnapshot: (snapshot: EngineReplaySnapshot) => Promise<void>;
}

export async function runShadowReplayWithRestoreRuntime(
  input: ShadowReplayWithRestoreInput,
  handlers: ShadowReplayRestoreRuntimeHandlers
): Promise<ShadowReplayLoopResult> {
  let replayLoop: ShadowReplayLoopResult | undefined;

  try {
    replayLoop = await handlers.runShadowReplay(input);
  } finally {
    await handlers.restoreReplaySnapshot(input.liveSnapshot);
  }

  if (!replayLoop) {
    throw new Error("REPLAY_LOOP_DID_NOT_COMPLETE");
  }

  return replayLoop;
}

export async function runHistoricalReplayRuntime(
  input: HistoricalReplayRuntimeInput,
  handlers: HistoricalReplayRuntimeHandlers
): Promise<ReplayResult> {
  await handlers.writeRunningStatus({
    replayId: input.replayId,
    ticksTotal: 0,
    shadowBankroll: input.requestedShadowBankroll,
    speedMultiplier: input.speedMultiplier,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    scenario: input.replayOptions.scenario,
    startedAt: input.startedAt,
    updatedAt: input.startedAt
  });
  const liveSnapshot = handlers.captureReplaySnapshot();
  const { ticks } = await handlers.loadScenarioReplayTicks(
    input.limit,
    input.dateFrom,
    input.dateTo,
    input.replayOptions.scenario
  );
  const liveBankroll = handlers.currentLiveBankroll();
  const initialShadowBankroll = resolveInitialShadowBankroll({
    requestedShadowBankroll: input.requestedShadowBankroll,
    liveEquity: liveBankroll.equity,
    liveCash: liveBankroll.cash,
    fallbackBankroll: input.fallbackBankroll
  });

  await handlers.writeRunningStatus({
    replayId: input.replayId,
    ticksTotal: ticks.length,
    shadowBankroll: initialShadowBankroll,
    speedMultiplier: input.speedMultiplier,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    scenario: input.replayOptions.scenario,
    startedAt: input.startedAt,
    updatedAt: handlers.nowIso()
  });
  const { historicalTrades, shadowTrades } = await handlers.loadReplayShadowTrades(ticks);

  handlers.prepareShadowReplayState(initialShadowBankroll, input.startedAt, input.replayId);

  const replayLoop = await handlers.runShadowReplayWithRestore({
    replayId: input.replayId,
    ticks,
    replayOptions: input.replayOptions,
    speedMultiplier: input.speedMultiplier,
    initialShadowBankroll,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    startedAt: input.startedAt,
    liveSnapshot
  });

  return handlers.recordCompletedReplay({
    replayId: input.replayId,
    replayLoop,
    initialShadowBankroll,
    historicalTradeCount: historicalTrades.length,
    shadowTrades,
    speedMultiplier: input.speedMultiplier,
    replayOptions: input.replayOptions,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    startedAt: input.startedAt,
    ticksLength: ticks.length
  });
}
