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
    oracle: EngineOracleState,
    profilerResult: ProfilerEvaluation
  ) => TickDecisionContext;
  readonly evaluateCroupier: (
    input: AcceptedDecisionPipelineInput,
    oracle: EngineOracleState,
    profilerResult: ProfilerEvaluation,
    decisionContext: TickDecisionContext
  ) => AcceptedCroupierRuntimeResult;
  readonly prepareExecutionContext: (
    input: AcceptedDecisionPipelineInput,
    profilerResult: ProfilerEvaluation,
    oracle: EngineOracleState,
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

type EngineOracleState = OracleTickResult["state"];

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
