import type { CroupierDecision } from "../../../agents/CroupierAgent";
import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import type { EngineState } from "../../../types";
import type {
  AcceptedDecisionPipelineInput,
  AcceptedExecutionContext,
  TickDecisionContext
} from "./TickPipelineTypes";

export interface AcceptedExecutionContextFlowInput {
  readonly pipeline: AcceptedDecisionPipelineInput;
  readonly profilerResult: ProfilerEvaluation;
  readonly oracleState: EngineState["oracle"];
  readonly croupierDecision: CroupierDecision;
  readonly decisionContext: TickDecisionContext;
  readonly currentState: EngineState;
  readonly pitBossEnabled: boolean;
  readonly kellyFraction: number;
}

export interface AcceptedExecutionContextFlowHandlers {
  readonly calculateEnsembleState: (
    intent: CroupierDecision["intent"],
    profilerState: ProfilerEvaluation["state"],
    oracleState: EngineState["oracle"],
    sentimentState: EngineState["sentiment"],
    anomalyStatus: EngineState["anomaly"],
    observedAt: string
  ) => EngineState["ensemble"];
  readonly prepareExecutionPlan: (
    intent: CroupierDecision["intent"],
    observedAt: string,
    options: {
      readonly stateOverride: EngineState;
      readonly kellyFractionOverride: number;
    }
  ) => AcceptedExecutionContext["executionPlan"];
  readonly applyQuoteSuppression: (
    instrumentCode: string,
    croupierDecision: CroupierDecision,
    profilerResult: ProfilerEvaluation,
    executionPlans: AcceptedExecutionContext["executionPlans"],
    observedAt: string,
    shadowReplay: boolean,
    ensembleAnomalyCircuitBreaker: boolean,
    ensembleRationale: string
  ) => AcceptedExecutionContext["quotePolicy"];
}

export function prepareAcceptedExecutionContextFlow(
  input: AcceptedExecutionContextFlowInput,
  handlers: AcceptedExecutionContextFlowHandlers
): AcceptedExecutionContext {
  const ensemble = handlers.calculateEnsembleState(
    input.croupierDecision.intent,
    input.profilerResult.state,
    input.oracleState,
    input.decisionContext.sentimentForDecision,
    input.pipeline.anomalyResult.status,
    input.pipeline.metrics.brainTimestamp
  );
  const executionPlan = input.pitBossEnabled
    ? handlers.prepareExecutionPlan(
        input.croupierDecision.intent,
        input.pipeline.metrics.brainTimestamp,
        {
          stateOverride: {
            ...input.currentState,
            assetMatrix: input.decisionContext.assetMatrix,
            ensemble
          },
          kellyFractionOverride: input.kellyFraction * ensemble.kellyMultiplier
        }
      )
    : null;
  const executionPlans = [executionPlan].filter(
    (plan): plan is NonNullable<typeof executionPlan> => plan !== null
  );
  const quotePolicy = handlers.applyQuoteSuppression(
    input.pipeline.tick.instrumentCode,
    input.croupierDecision,
    input.profilerResult,
    executionPlans,
    input.pipeline.metrics.brainTimestamp,
    input.pipeline.shadowReplay,
    ensemble.anomalyCircuitBreaker,
    ensemble.rationale
  );

  return {
    ensemble,
    executionPlan,
    executionPlans: quotePolicy.executionPlans,
    quotePolicy
  };
}
