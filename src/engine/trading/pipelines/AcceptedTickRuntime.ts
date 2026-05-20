import type { CroupierDecision } from "../../../agents/CroupierAgent";
import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import type { OracleTickResult } from "../agents/AgentEvaluationRuntime";
import { buildCroupierQuoteAction, type CroupierQuoteAction } from "../quotes/QuoteDispatchRuntime";
import { aggregateQuoteState } from "../state/AssetStateRuntime";
import { nextTickAgentHealth } from "../state/AgentHealthRuntime";
import type { AcceptedTickStateInput } from "../state/TickStateRuntime";
import type {
  AcceptedDecisionPipelineInput,
  AcceptedExecutionContext,
  AcceptedTickSideEffectsInput,
  AcceptedTickStateCommitInput,
  TickDecisionContext
} from "./TickPipelineTypes";
import type { EngineState, GlobalRiskConfig } from "../../../types";

export interface BuildAcceptedTickLifecycleInput {
  readonly pipeline: AcceptedDecisionPipelineInput;
  readonly profilerResult: ProfilerEvaluation;
  readonly profilerLatencyMs: number;
  readonly oracleResult: OracleTickResult;
  readonly oracleLatencyMs: number;
  readonly croupierDecision: CroupierDecision;
  readonly croupierLatencyMs: number;
  readonly decisionContext: TickDecisionContext;
  readonly executionContext: AcceptedExecutionContext;
}

export interface AcceptedProfilerRuntimeResult {
  readonly profilerResult: ProfilerEvaluation;
  readonly profilerLatencyMs: number;
}

export interface AcceptedOracleRuntimeResult {
  readonly oracleResult: OracleTickResult;
  readonly oracleLatencyMs: number;
}

export interface AcceptedCroupierRuntimeResult {
  readonly croupierDecision: CroupierDecision;
  readonly croupierLatencyMs: number;
}

export interface AcceptedDecisionPipelineLifecycleDependencies {
  readonly evaluateProfiler: (
    input: AcceptedDecisionPipelineInput
  ) => AcceptedProfilerRuntimeResult;
  readonly evaluateOracle: (input: AcceptedDecisionPipelineInput) => AcceptedOracleRuntimeResult;
  readonly buildDecisionContext: (
    input: AcceptedDecisionPipelineInput,
    oracle: EngineState["oracle"],
    profilerResult: ProfilerEvaluation
  ) => TickDecisionContext;
  readonly evaluateCroupier: (
    input: AcceptedDecisionPipelineInput,
    oracle: EngineState["oracle"],
    profilerResult: ProfilerEvaluation,
    decisionContext: TickDecisionContext
  ) => AcceptedCroupierRuntimeResult;
  readonly prepareExecutionContext: (
    input: AcceptedDecisionPipelineInput,
    profilerResult: ProfilerEvaluation,
    oracle: EngineState["oracle"],
    croupierDecision: CroupierDecision,
    decisionContext: TickDecisionContext
  ) => AcceptedExecutionContext;
}

export interface AcceptedDecisionPipelineFlowHandlers {
  readonly commitAcceptedTickState: (input: AcceptedTickStateCommitInput) => void;
  readonly finalizeAcceptedTick: (input: AcceptedTickSideEffectsInput) => Promise<void>;
}

export interface AcceptedTickLifecycleArtifacts {
  readonly commitInput: AcceptedTickStateCommitInput;
  readonly sideEffectsInput: AcceptedTickSideEffectsInput;
}

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

export function buildAcceptedTickLifecycleArtifacts(
  input: BuildAcceptedTickLifecycleInput
): AcceptedTickLifecycleArtifacts {
  return {
    commitInput: buildAcceptedTickStateCommitInput(input),
    sideEffectsInput: buildAcceptedTickSideEffectsInput(input)
  };
}

export function buildAcceptedDecisionPipelineLifecycle(
  input: AcceptedDecisionPipelineInput,
  dependencies: AcceptedDecisionPipelineLifecycleDependencies
): AcceptedTickLifecycleArtifacts {
  const { profilerResult, profilerLatencyMs } = dependencies.evaluateProfiler(input);
  const { oracleResult, oracleLatencyMs } = dependencies.evaluateOracle(input);
  const decisionContext = dependencies.buildDecisionContext(
    input,
    oracleResult.state,
    profilerResult
  );
  const { croupierDecision, croupierLatencyMs } = dependencies.evaluateCroupier(
    input,
    oracleResult.state,
    profilerResult,
    decisionContext
  );
  const executionContext = dependencies.prepareExecutionContext(
    input,
    profilerResult,
    oracleResult.state,
    croupierDecision,
    decisionContext
  );

  return buildAcceptedTickLifecycleArtifacts({
    pipeline: input,
    profilerResult,
    profilerLatencyMs,
    oracleResult,
    oracleLatencyMs,
    croupierDecision,
    croupierLatencyMs,
    decisionContext,
    executionContext
  });
}

export async function applyAcceptedDecisionPipelineFlow(
  input: AcceptedDecisionPipelineInput,
  dependencies: AcceptedDecisionPipelineLifecycleDependencies,
  handlers: AcceptedDecisionPipelineFlowHandlers
): Promise<AcceptedTickLifecycleArtifacts> {
  const lifecycle = buildAcceptedDecisionPipelineLifecycle(input, dependencies);

  handlers.commitAcceptedTickState(lifecycle.commitInput);
  await handlers.finalizeAcceptedTick(lifecycle.sideEffectsInput);

  return lifecycle;
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

function buildAcceptedTickStateCommitInput(
  input: BuildAcceptedTickLifecycleInput
): AcceptedTickStateCommitInput {
  return {
    tick: input.pipeline.tick,
    metrics: input.pipeline.metrics,
    book: input.pipeline.book,
    oracle: input.oracleResult.state,
    sentiment: input.decisionContext.sentimentForDecision,
    ensemble: input.executionContext.ensemble,
    leadLag: input.decisionContext.leadLag,
    inventory: input.decisionContext.inventory,
    riskMetrics: input.decisionContext.riskMetrics,
    assetQuoteState: input.executionContext.quotePolicy.assetQuoteState,
    shadowQueueState: input.pipeline.shadowQueueState,
    executionPlan: input.executionContext.executionPlan,
    croupierDecision: input.croupierDecision,
    executionPlans: input.executionContext.executionPlans,
    inventoryGuard: input.decisionContext.inventoryGuard,
    domSnapshot: input.pipeline.domSnapshot,
    anomalyResult: input.pipeline.anomalyResult,
    profilerStates: input.decisionContext.profilerStates,
    profilerResult: input.profilerResult,
    oracleLatencyMs: input.oracleLatencyMs,
    profilerLatencyMs: input.profilerLatencyMs,
    croupierLatencyMs: input.croupierLatencyMs,
    shadowReplay: input.pipeline.shadowReplay,
    observedAt: input.pipeline.metrics.brainTimestamp
  };
}

function buildAcceptedTickSideEffectsInput(
  input: BuildAcceptedTickLifecycleInput
): AcceptedTickSideEffectsInput {
  return {
    tick: input.pipeline.tick,
    metrics: input.pipeline.metrics,
    book: input.pipeline.book,
    anomalyResult: input.pipeline.anomalyResult,
    profilerResult: input.profilerResult,
    profilerLatencyMs: input.profilerLatencyMs,
    croupierDecision: input.croupierDecision,
    executionPlans: input.executionContext.executionPlans,
    inventory: input.decisionContext.inventory,
    strategyQuoteDisableReason: input.executionContext.quotePolicy.strategyQuoteDisableReason,
    isCascadeShield: input.executionContext.quotePolicy.isCascadeShield,
    isProfilerQuoteHalt: input.executionContext.quotePolicy.isProfilerQuoteHalt,
    oracleBayesianTrace: input.oracleResult.bayesianTrace,
    hotPathStartedAt: input.pipeline.hotPathStartedAt,
    shadowReplay: input.pipeline.shadowReplay
  };
}
