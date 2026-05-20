import type { CroupierDecision } from "../../../agents/CroupierAgent";
import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import type { OracleTickResult } from "../agents/AgentEvaluationRuntime";
import type {
  AcceptedDecisionPipelineInput,
  AcceptedExecutionContext,
  AcceptedTickSideEffectsInput,
  AcceptedTickStateCommitInput,
  TickDecisionContext
} from "./TickPipelineTypes";

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

export interface AcceptedTickLifecycleArtifacts {
  readonly commitInput: AcceptedTickStateCommitInput;
  readonly sideEffectsInput: AcceptedTickSideEffectsInput;
}

export function buildAcceptedTickLifecycleArtifacts(
  input: BuildAcceptedTickLifecycleInput
): AcceptedTickLifecycleArtifacts {
  return {
    commitInput: buildAcceptedTickStateCommitInput(input),
    sideEffectsInput: buildAcceptedTickSideEffectsInput(input)
  };
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
