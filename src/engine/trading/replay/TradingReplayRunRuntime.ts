import { DEFAULT_PAPER_BANKROLL_USD } from "../../../TradingEngineConstants";
import type {
  EngineState,
  JsonRecord,
  MarketTick,
  ReplayResult,
  SentimentState,
  TradeIntent
} from "../../../types";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { ReplayOptions, ReplayStatus } from "../routes/ReplayAdminRoutes";
import {
  loadReplayShadowTradesFromJournal,
  loadScenarioReplayTicksFromJournal
} from "./ReplayDataRuntime";
import type { ReplayJournal } from "./ReplayJournal";
import { runShadowReplayLoop, type ShadowReplayLoopResult } from "./ReplayLoopRuntime";
import {
  recordCompletedReplaySideEffects,
  writeReplayRunningStatusSideEffect
} from "./ReplayResultRuntime";
import { runHistoricalReplayRuntime, runShadowReplayWithRestoreRuntime } from "./ReplayRunRuntime";
import type { EngineReplaySnapshot } from "./ReplaySnapshotRuntime";
import {
  captureTradingReplaySnapshotFromSource,
  prepareTradingShadowReplayStateForTarget,
  restoreTradingReplaySnapshotForTarget,
  type TradingReplayRestoreTarget,
  type TradingReplaySnapshotSource,
  type TradingShadowReplayStateTarget
} from "./TradingReplayStateRuntime";

export interface TradingHistoricalReplayInput {
  readonly limit: number;
  readonly shadowBankroll: number;
  readonly speedMultiplier: number;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly replayOptions: ReplayOptions;
}

export interface TradingReplayHandlers {
  readonly replayJournal: Pick<
    ReplayJournal,
    "loadTicks" | "loadTrades" | "recordBacktestRun" | "writeStatus"
  >;
  readonly nowIso: () => string;
  readonly createReplayId: () => string;
  readonly captureReplaySnapshot: () => EngineReplaySnapshot;
  readonly currentLiveBankroll: () => Pick<EngineState["bankroll"], "equity" | "cash">;
  readonly prepareShadowReplayState: (
    initialShadowBankroll: number,
    startedAt: string,
    replayId: string
  ) => void;
  readonly enqueueShadowReplayTick: (tick: MarketTick) => Promise<TickIngestResult>;
  readonly lastTradeIntent: () => TradeIntent | null;
  readonly oracleRegime: () => ReplayResult["shadowTrades"][number]["regime"];
  readonly currentSentiment: () => SentimentState;
  readonly restoreReplaySnapshot: (snapshot: EngineReplaySnapshot) => Promise<void>;
  readonly writeCompletionLog: (metadata: JsonRecord) => void;
}

export interface TradingHistoricalReplayEngineTarget {
  readonly replayJournal: TradingReplayHandlers["replayJournal"];
  readonly engineState: Pick<EngineState, "bankroll" | "lastTradeIntent" | "oracle" | "sentiment">;
  readonly logger: {
    warn(eventType: string, message: string, telemetry?: JsonRecord): void;
  };
  captureReplaySnapshot(): EngineReplaySnapshot;
  prepareShadowReplayState(
    initialShadowBankroll: number,
    startedAt: string,
    replayId: string
  ): void;
  enqueueTick(
    tick: MarketTick,
    colo: string | null,
    options: { readonly shadowReplay: boolean }
  ): Promise<TickIngestResult>;
  restoreReplaySnapshot(snapshot: EngineReplaySnapshot): Promise<void>;
}

export type TradingHistoricalReplayStatefulTarget = Omit<
  TradingHistoricalReplayEngineTarget,
  "captureReplaySnapshot" | "prepareShadowReplayState" | "restoreReplaySnapshot"
>;

export async function runTradingShadowReplayWithRestore(
  input: Parameters<typeof runShadowReplayWithRestoreRuntime>[0],
  handlers: Pick<
    TradingReplayHandlers,
    | "enqueueShadowReplayTick"
    | "lastTradeIntent"
    | "oracleRegime"
    | "replayJournal"
    | "restoreReplaySnapshot"
  >
): Promise<ShadowReplayLoopResult> {
  return runShadowReplayWithRestoreRuntime(input, {
    runShadowReplay: (replayInput) =>
      runShadowReplayLoop({
        replayId: replayInput.replayId,
        ticks: replayInput.ticks,
        replayOptions: replayInput.replayOptions,
        speedMultiplier: replayInput.speedMultiplier,
        initialShadowBankroll: replayInput.initialShadowBankroll,
        dateFrom: replayInput.dateFrom,
        dateTo: replayInput.dateTo,
        startedAt: replayInput.startedAt,
        enqueueShadowReplayTick: handlers.enqueueShadowReplayTick,
        lastTradeIntent: handlers.lastTradeIntent,
        oracleRegime: handlers.oracleRegime,
        writeStatus: (status) => handlers.replayJournal.writeStatus(status)
      }),
    restoreReplaySnapshot: handlers.restoreReplaySnapshot
  });
}

export async function runTradingHistoricalReplay(
  input: TradingHistoricalReplayInput,
  handlers: TradingReplayHandlers
): Promise<ReplayResult> {
  const startedAt = handlers.nowIso();
  const replayId = handlers.createReplayId();

  return runHistoricalReplayRuntime(
    {
      limit: input.limit,
      requestedShadowBankroll: input.shadowBankroll,
      speedMultiplier: input.speedMultiplier,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      replayOptions: input.replayOptions,
      startedAt,
      replayId,
      fallbackBankroll: DEFAULT_PAPER_BANKROLL_USD
    },
    {
      nowIso: handlers.nowIso,
      writeRunningStatus: (statusInput) =>
        writeReplayRunningStatusSideEffect(statusInput, {
          writeStatus: (status) => handlers.replayJournal.writeStatus(status)
        }),
      captureReplaySnapshot: handlers.captureReplaySnapshot,
      loadScenarioReplayTicks: (limit, dateFrom, dateTo, scenario) =>
        loadScenarioReplayTicksFromJournal({
          replayJournal: handlers.replayJournal,
          limit,
          dateFrom,
          dateTo,
          scenario
        }),
      currentLiveBankroll: handlers.currentLiveBankroll,
      loadReplayShadowTrades: (ticks) =>
        loadReplayShadowTradesFromJournal({
          replayJournal: handlers.replayJournal,
          ticks
        }),
      prepareShadowReplayState: handlers.prepareShadowReplayState,
      runShadowReplayWithRestore: (replayInput) =>
        runTradingShadowReplayWithRestore(replayInput, handlers),
      recordCompletedReplay: (completionInput) =>
        recordCompletedReplaySideEffects(
          {
            replayId: completionInput.replayId,
            replayOptions: completionInput.replayOptions,
            ticksLength: completionInput.ticksLength,
            ticksReplayed: completionInput.replayLoop.ticksReplayed,
            initialShadowBankroll: completionInput.initialShadowBankroll,
            historicalTradeCount: completionInput.historicalTradeCount,
            generatedIntentCount: completionInput.replayLoop.generatedIntentCount,
            speedMultiplier: completionInput.speedMultiplier,
            modeledTrades: completionInput.replayLoop.modeledTrades,
            shadowTrades: completionInput.shadowTrades,
            sentiment: handlers.currentSentiment(),
            dateFrom: completionInput.dateFrom,
            dateTo: completionInput.dateTo,
            startedAt: completionInput.startedAt,
            completedAt: handlers.nowIso()
          },
          {
            writeCompletionLog: handlers.writeCompletionLog,
            recordBacktestRun: (result, replayOptions, dateFrom, dateTo) =>
              handlers.replayJournal.recordBacktestRun(result, replayOptions, dateFrom, dateTo),
            writeStatus: (status: ReplayStatus) => handlers.replayJournal.writeStatus(status)
          }
        )
    }
  );
}

export function runTradingHistoricalReplayForTarget(
  input: TradingHistoricalReplayInput,
  target: TradingHistoricalReplayEngineTarget
): Promise<ReplayResult> {
  return runTradingHistoricalReplay(input, {
    replayJournal: target.replayJournal,
    nowIso: () => new Date().toISOString(),
    createReplayId: () => crypto.randomUUID(),
    captureReplaySnapshot: () => target.captureReplaySnapshot(),
    currentLiveBankroll: () => ({
      equity: target.engineState.bankroll.equity,
      cash: target.engineState.bankroll.cash
    }),
    prepareShadowReplayState: (initialShadowBankroll, replayStartedAt, replayId) => {
      target.prepareShadowReplayState(initialShadowBankroll, replayStartedAt, replayId);
    },
    enqueueShadowReplayTick: (tick) => target.enqueueTick(tick, null, { shadowReplay: true }),
    lastTradeIntent: () => target.engineState.lastTradeIntent,
    oracleRegime: () => target.engineState.oracle.regime,
    currentSentiment: () => target.engineState.sentiment,
    restoreReplaySnapshot: (snapshot) => target.restoreReplaySnapshot(snapshot),
    writeCompletionLog: (metadata) => {
      target.logger.warn("REPLAY_COMPLETED", "Historical shadow replay completed", metadata);
    }
  });
}

export function runTradingHistoricalReplayForStatefulTarget(
  input: TradingHistoricalReplayInput,
  target: TradingHistoricalReplayStatefulTarget
): Promise<ReplayResult> {
  return runTradingHistoricalReplay(input, {
    replayJournal: target.replayJournal,
    nowIso: () => new Date().toISOString(),
    createReplayId: () => crypto.randomUUID(),
    captureReplaySnapshot: () =>
      captureTradingReplaySnapshotFromSource(target as unknown as TradingReplaySnapshotSource),
    currentLiveBankroll: () => ({
      equity: target.engineState.bankroll.equity,
      cash: target.engineState.bankroll.cash
    }),
    prepareShadowReplayState: (initialShadowBankroll, replayStartedAt, replayId) => {
      prepareTradingShadowReplayStateForTarget(
        { initialShadowBankroll, startedAt: replayStartedAt, replayId },
        target as unknown as TradingShadowReplayStateTarget
      );
    },
    enqueueShadowReplayTick: (tick) => target.enqueueTick(tick, null, { shadowReplay: true }),
    lastTradeIntent: () => target.engineState.lastTradeIntent,
    oracleRegime: () => target.engineState.oracle.regime,
    currentSentiment: () => target.engineState.sentiment,
    restoreReplaySnapshot: (snapshot) =>
      restoreTradingReplaySnapshotForTarget(
        snapshot,
        target as unknown as TradingReplayRestoreTarget
      ),
    writeCompletionLog: (metadata) => {
      target.logger.warn("REPLAY_COMPLETED", "Historical shadow replay completed", metadata);
    }
  });
}
