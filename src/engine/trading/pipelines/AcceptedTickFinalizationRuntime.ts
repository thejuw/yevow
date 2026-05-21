import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import type {
  EngineState,
  Env,
  GlobalRiskConfig,
  JsonRecord,
  LatencyMetrics,
  LiquidityWall,
  MarketTick
} from "../../../types";
import {
  dispatchTradingEngineInventoryHedgeIfNeeded,
  type TradingInventoryHedgeTarget
} from "../inventory/TradingInventoryHedgeRuntime";
import {
  dispatchTradingExecutionPlans,
  type TradingExecutionPlanDispatchTarget
} from "../execution/ExecutionPlanDispatchRuntime";
import {
  dispatchTradingCroupierQuoteAction,
  buildCroupierQuoteAction,
  type CroupierQuoteAction,
  type TradingCroupierQuoteActionTarget
} from "../quotes/QuoteActionRuntime";
import {
  maybeRecordTradingAgentSnapshotForTarget,
  publishTradingTickTelemetryForTarget,
  type TradingHotPathTelemetryTarget
} from "../telemetry/TradingHotPathTelemetryRuntime";
import {
  handleTradingProfilerSignal,
  publishTradingAmVpinTelemetry,
  type TradingProfilerSignalTarget
} from "../telemetry/TradingProfilerTelemetryRuntime";
import {
  recordTradingAcceptedTickJournal,
  scheduleTradingAcceptedTickSnapshot
} from "../state/TradingTickPersistenceRuntime";
import type { AcceptedTickSideEffectsInput } from "./TickPipelineTypes";

export interface AcceptedTickFinalizationInput {
  readonly sideEffects: AcceptedTickSideEffectsInput;
  readonly tradingEnabled: boolean;
}

export interface AcceptedTickFinalizationArtifacts {
  readonly croupierQuoteAction: CroupierQuoteAction;
  readonly shouldPublishAmVpinTelemetry: boolean;
}

export interface AcceptedTickFinalizationFlowHandlers {
  readonly scheduleAcceptedTickSnapshot: (input: AcceptedTickSideEffectsInput) => void;
  readonly journalAcceptedTick: (input: AcceptedTickSideEffectsInput) => void;
  readonly handleCroupierQuoteAction: (instrumentCode: string, action: CroupierQuoteAction) => void;
  readonly dispatchExecutionPlans: (
    executionPlans: AcceptedTickSideEffectsInput["executionPlans"],
    shadowReplay: boolean
  ) => void;
  readonly dispatchInventoryHedgeIfNeeded: (
    book: AcceptedTickSideEffectsInput["book"],
    inventory: AcceptedTickSideEffectsInput["inventory"],
    observedAt: string,
    shadowReplay: boolean
  ) => void;
  readonly handleProfilerSignal: (
    instrumentCode: string,
    profilerResult: ProfilerEvaluation,
    profilerLatencyMs: number,
    isProfilerQuoteHalt: boolean,
    shadowReplay: boolean,
    hasQuote: boolean
  ) => Promise<void>;
  readonly publishTickTelemetry: (
    tick: AcceptedTickSideEffectsInput["tick"],
    metrics: AcceptedTickSideEffectsInput["metrics"],
    status: AcceptedTickSideEffectsInput["metrics"]["status"],
    hotPathStartedAt: number
  ) => void;
  readonly publishAmVpinTelemetry: (
    profilerState: ProfilerEvaluation["state"],
    instrumentCode: string,
    observedAt: string
  ) => void;
  readonly maybeRecordAgentSnapshot: (observedAt: string) => void;
}

export interface AcceptedTickFinalizationTarget {
  readonly cachedConfig: GlobalRiskConfig;
  readonly engineState: EngineState;
  readonly latencyHistory: LatencyMetrics[];
  readonly processingLatencySamples: number[];
  readonly domWallHistory: LiquidityWall[];
  readonly env: Pick<Env, "MARKET_TICK_JOURNAL_INTERVAL">;
  readonly logger: {
    recordMarketTick(tick: MarketTick): void;
    info(eventType: string, message: string, metadata?: JsonRecord): void;
  };
  readonly state: {
    waitUntil(work: Promise<void>): void;
  };
  persistHotStorageSnapshot(writes: Record<string, unknown>, reason: string): Promise<void>;
}

export function buildAcceptedTickFinalizationArtifacts(
  input: AcceptedTickFinalizationInput
): AcceptedTickFinalizationArtifacts {
  const sideEffects = input.sideEffects;

  return {
    croupierQuoteAction: buildCroupierQuoteAction({
      instrumentCode: sideEffects.tick.instrumentCode,
      pullAllQuotes: sideEffects.croupierDecision.pullAllQuotes,
      quote: sideEffects.croupierDecision.quote,
      strategyQuoteDisableReason: sideEffects.strategyQuoteDisableReason,
      adverseSelectionCost: sideEffects.croupierDecision.adverseSelectionCost,
      minEvThreshold: sideEffects.croupierDecision.minEvThreshold,
      shadowReplay: sideEffects.shadowReplay,
      tradingEnabled: input.tradingEnabled,
      profilerQuoteHalt: sideEffects.isProfilerQuoteHalt,
      cascadeShield: sideEffects.isCascadeShield
    }),
    shouldPublishAmVpinTelemetry: sideEffects.profilerResult.closedBuckets > 0
  };
}

export async function finalizeAcceptedTickFlow(
  input: AcceptedTickFinalizationInput,
  handlers: AcceptedTickFinalizationFlowHandlers
): Promise<AcceptedTickFinalizationArtifacts> {
  const sideEffects = input.sideEffects;

  handlers.scheduleAcceptedTickSnapshot(sideEffects);
  handlers.journalAcceptedTick(sideEffects);

  const finalization = buildAcceptedTickFinalizationArtifacts(input);

  handlers.handleCroupierQuoteAction(
    sideEffects.tick.instrumentCode,
    finalization.croupierQuoteAction
  );
  handlers.dispatchExecutionPlans(sideEffects.executionPlans, sideEffects.shadowReplay);
  handlers.dispatchInventoryHedgeIfNeeded(
    sideEffects.book,
    sideEffects.inventory,
    sideEffects.metrics.brainTimestamp,
    sideEffects.shadowReplay
  );

  await handlers.handleProfilerSignal(
    sideEffects.tick.instrumentCode,
    sideEffects.profilerResult,
    sideEffects.profilerLatencyMs,
    sideEffects.isProfilerQuoteHalt,
    sideEffects.shadowReplay,
    Boolean(sideEffects.croupierDecision.quote)
  );

  handlers.publishTickTelemetry(
    sideEffects.tick,
    sideEffects.metrics,
    sideEffects.metrics.status,
    sideEffects.hotPathStartedAt
  );
  if (finalization.shouldPublishAmVpinTelemetry) {
    handlers.publishAmVpinTelemetry(
      sideEffects.profilerResult.state,
      sideEffects.tick.instrumentCode,
      sideEffects.metrics.brainTimestamp
    );
  }
  handlers.maybeRecordAgentSnapshot(sideEffects.metrics.brainTimestamp);

  return finalization;
}

export async function finalizeAcceptedTickForTarget(
  sideEffects: AcceptedTickSideEffectsInput,
  target: AcceptedTickFinalizationTarget
): Promise<AcceptedTickFinalizationArtifacts> {
  return finalizeAcceptedTickFlow(
    {
      sideEffects,
      tradingEnabled: target.cachedConfig.TRADING_ENABLED
    },
    {
      scheduleAcceptedTickSnapshot: (currentSideEffects) => {
        scheduleTradingAcceptedTickSnapshot(
          {
            engineState: target.engineState,
            latencyHistory: target.latencyHistory,
            processingLatencySamples: target.processingLatencySamples,
            domWallHistory: target.domWallHistory,
            anomalyResult: currentSideEffects.anomalyResult,
            book: currentSideEffects.book,
            tick: currentSideEffects.tick,
            profilerResult: currentSideEffects.profilerResult
          },
          {
            persistSnapshot: (writes, reason) => target.persistHotStorageSnapshot(writes, reason),
            schedule: (work) => {
              target.state.waitUntil(work);
            }
          }
        );
      },
      journalAcceptedTick: (currentSideEffects) => {
        recordTradingAcceptedTickJournal(
          {
            tick: currentSideEffects.tick,
            metrics: currentSideEffects.metrics,
            bayesianTrace: currentSideEffects.oracleBayesianTrace,
            engineState: target.engineState,
            marketTickJournalInterval: target.env.MARKET_TICK_JOURNAL_INTERVAL
          },
          {
            recordMarketTick: (marketTick) => {
              target.logger.recordMarketTick(marketTick);
            },
            logInfo: (eventType, message, metadata) => {
              target.logger.info(eventType, message, metadata);
            }
          }
        );
      },
      handleCroupierQuoteAction: (instrumentCode, action) => {
        dispatchTradingCroupierQuoteAction(
          instrumentCode,
          action,
          target as unknown as TradingCroupierQuoteActionTarget
        );
      },
      dispatchExecutionPlans: (executionPlans, shadowReplay) => {
        dispatchTradingExecutionPlans(
          executionPlans,
          shadowReplay,
          target as unknown as TradingExecutionPlanDispatchTarget
        );
      },
      dispatchInventoryHedgeIfNeeded: (book, inventory, observedAt, shadowReplay) => {
        dispatchTradingEngineInventoryHedgeIfNeeded(
          book,
          inventory,
          observedAt,
          shadowReplay,
          target as unknown as TradingInventoryHedgeTarget
        );
      },
      handleProfilerSignal: (
        instrumentCode,
        profilerResult,
        profilerLatencyMs,
        isProfilerQuoteHalt,
        shadowReplay,
        hasQuote
      ) =>
        handleTradingProfilerSignal(
          instrumentCode,
          profilerResult,
          profilerLatencyMs,
          isProfilerQuoteHalt,
          shadowReplay,
          hasQuote,
          target as unknown as TradingProfilerSignalTarget
        ),
      publishTickTelemetry: (tick, metrics, status, hotPathStartedAt) => {
        publishTradingTickTelemetryForTarget(
          tick,
          metrics,
          status,
          hotPathStartedAt,
          target as unknown as TradingHotPathTelemetryTarget
        );
      },
      publishAmVpinTelemetry: (profilerState, instrumentCode, observedAt) => {
        publishTradingAmVpinTelemetry(profilerState, instrumentCode, observedAt, {
          publish: (type, payload, correlationId) => {
            (target as unknown as TradingHotPathTelemetryTarget).publish(
              type,
              payload,
              correlationId
            );
          }
        });
      },
      maybeRecordAgentSnapshot: (observedAt) => {
        maybeRecordTradingAgentSnapshotForTarget(
          observedAt,
          target as unknown as TradingHotPathTelemetryTarget
        );
      }
    }
  );
}
