import { aggregateQuoteState } from "../state/AssetStateRuntime";
import { nextTickAgentHealth } from "../state/AgentHealthRuntime";
import type { AcceptedTickStateInput } from "../state/TickStateRuntime";
import { countBookLevels } from "../book/BookReconstruction";
import type { SortedBookSide } from "../book/SortedBookSide";
import {
  calculateTradingAssetMatrixForTarget,
  type TradingAssetMatrixTarget
} from "../state/TradingAssetMatrixRuntime";
import type { AcceptedTickStateCommitInput } from "./TickPipelineTypes";
import type { EngineState, GlobalRiskConfig } from "../../../types";

export interface AcceptedTickStateTransitionInput {
  readonly currentState: EngineState;
  readonly config: Pick<
    GlobalRiskConfig,
    | "TRADING_ENABLED"
    | "ORACLE_ENABLED"
    | "SENTIMENT_ENABLED"
    | "PROFILER_ENABLED"
    | "CROUPIER_ENABLED"
    | "PIT_BOSS_ENABLED"
    | "MARKET_MAKING_MODE"
  >;
  readonly commit: AcceptedTickStateCommitInput;
  readonly internalOrderBookDepth: number;
  readonly maxLatencyMs: number;
  readonly calculateAssetMatrix: (
    observedAt: string,
    latestInstrumentCode: string,
    latestOracle: EngineState["oracle"],
    profilerStates: EngineState["profilerStates"],
    assetQuoteStates: EngineState["assetQuoteStates"]
  ) => EngineState["assetMatrix"];
}

export interface AcceptedTickStateCommitTarget extends TradingAssetMatrixTarget {
  engineState: EngineState;
  readonly cachedConfig: GlobalRiskConfig;
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
  readonly maxLatencyMs: number;
}

export function buildAcceptedTickStateTransition(
  input: AcceptedTickStateTransitionInput
): AcceptedTickStateInput {
  const assetQuoteStates = {
    ...input.currentState.assetQuoteStates,
    [input.commit.tick.instrumentCode]: input.commit.assetQuoteState
  };
  const quoteState = aggregateQuoteState(
    assetQuoteStates,
    input.currentState.quoteState,
    input.commit.observedAt
  );
  const assetMatrix = input.calculateAssetMatrix(
    input.commit.observedAt,
    input.commit.tick.instrumentCode,
    input.commit.oracle,
    input.commit.profilerStates,
    assetQuoteStates
  );
  const agentHealth = nextTickAgentHealth({
    previous: input.currentState.agentHealth,
    config: input.config,
    observedAt: input.commit.observedAt,
    oracleLatencyMs: input.commit.oracleLatencyMs,
    sentimentLatencyMs: input.currentState.agentHealth.SENTIMENT.latencyMs,
    profilerToxicityScore: input.commit.profilerResult.toxicityScore,
    profilerAlertThreshold: input.commit.profilerResult.state.alertThreshold,
    profilerLatencyMs: input.commit.profilerLatencyMs,
    profilerSignalId: input.commit.profilerResult.signal?.signalId ?? undefined,
    croupierLatencyMs: input.commit.croupierLatencyMs,
    croupierHasOutput:
      input.commit.croupierDecision.intent !== null || input.commit.croupierDecision.quote !== null,
    croupierSignalId:
      input.commit.croupierDecision.quote?.signalId ??
      input.commit.croupierDecision.intent?.intentId,
    pitBossIntentId: input.commit.executionPlan?.intent.intentId
  });

  return {
    currentState: input.currentState,
    tradingEnabled: input.config.TRADING_ENABLED,
    shadowReplay: input.commit.shadowReplay,
    latencyStatus: input.commit.metrics.status,
    internalOrderBookDepth: input.internalOrderBookDepth,
    book: input.commit.book,
    oracle: input.commit.oracle,
    sentiment: input.commit.sentiment,
    ensemble: input.commit.ensemble,
    leadLag: input.commit.leadLag,
    inventory: input.commit.inventory,
    riskMetrics: input.commit.riskMetrics,
    quoteState,
    assetQuoteStates,
    shadowQueue: input.commit.shadowQueueState,
    lastTradeIntent: input.commit.executionPlan?.intent ?? input.commit.croupierDecision.intent,
    inventoryGuard: input.commit.inventoryGuard,
    ordersToTrack: input.commit.executionPlans.flatMap((plan) => plan.orders),
    shouldTrackOrders:
      input.commit.executionPlans.length > 0 &&
      (input.config.TRADING_ENABLED || input.commit.shadowReplay),
    dom: input.commit.domSnapshot,
    anomaly: input.commit.anomalyResult.status,
    assetMatrix,
    profilerStates: input.commit.profilerStates,
    toxicityScore: input.commit.profilerResult.toxicityScore,
    agentHealth,
    maxLatencyMs: input.maxLatencyMs,
    observedAt: input.commit.observedAt
  };
}

export function commitAcceptedTickStateForTarget(
  commit: AcceptedTickStateCommitInput,
  target: AcceptedTickStateCommitTarget,
  applyState: (input: AcceptedTickStateInput) => EngineState
): void {
  target.engineState = applyState(
    buildAcceptedTickStateTransition({
      currentState: target.engineState,
      config: target.cachedConfig,
      commit,
      internalOrderBookDepth: countBookLevels(target.bids, target.asks),
      maxLatencyMs: target.maxLatencyMs,
      calculateAssetMatrix: (
        observedAt,
        _latestInstrumentCode,
        latestOracle,
        profilerStates,
        assetQuoteStates
      ) =>
        calculateTradingAssetMatrixForTarget(
          {
            observedAt,
            latestOracle,
            profilerStates,
            assetQuoteStates
          },
          target
        )
    })
  );
}
