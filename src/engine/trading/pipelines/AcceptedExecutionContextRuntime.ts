import type { CroupierDecision } from "../../../agents/CroupierAgent";
import type { PitBossAgent } from "../../../agents/PitBossAgent";
import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import type {
  EngineState,
  Env,
  GlobalRiskConfig,
  InternalOrderBook,
  JsonRecord,
  MacroBias
} from "../../../types";
import { calculateTradingEnsembleState } from "../ensemble/TradingEnsembleRuntime";
import { prepareTradingExecutionPlan } from "../execution/TradingExecutionPlanPreparationRuntime";
import { applyTradingQuoteSuppression } from "../quotes/TradingQuoteSuppressionRuntime";
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

export interface AcceptedExecutionContextTargetInput {
  readonly pipeline: AcceptedDecisionPipelineInput;
  readonly profilerResult: ProfilerEvaluation;
  readonly oracleState: EngineState["oracle"];
  readonly croupierDecision: CroupierDecision;
  readonly decisionContext: TickDecisionContext;
}

export interface AcceptedExecutionContextTarget {
  readonly engineState: EngineState;
  readonly cachedConfig: GlobalRiskConfig;
  readonly env: Env;
  readonly orderBook: ReadonlyMap<string, InternalOrderBook>;
  readonly pitBossAgent: PitBossAgent;
  readonly macroBias: MacroBias;
  readonly state: {
    waitUntil(promise: Promise<unknown>): void;
  };
  readonly logger: {
    warn(eventType: string, message: string, metadata: JsonRecord): void;
  };
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
  cancelAllQuotes(instrumentCode: string, reason: string): Promise<void>;
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

export function prepareAcceptedExecutionContextForTarget(
  input: AcceptedExecutionContextTargetInput,
  target: AcceptedExecutionContextTarget
): AcceptedExecutionContext {
  return prepareAcceptedExecutionContextFlow(
    {
      pipeline: input.pipeline,
      profilerResult: input.profilerResult,
      oracleState: input.oracleState,
      croupierDecision: input.croupierDecision,
      decisionContext: input.decisionContext,
      currentState: target.engineState,
      pitBossEnabled: target.cachedConfig.PIT_BOSS_ENABLED,
      kellyFraction: target.cachedConfig.KELLY_FRACTION
    },
    {
      calculateEnsembleState: (
        intent,
        profilerState,
        oracleState,
        sentimentState,
        anomalyStatus,
        observedAt
      ) =>
        calculateTradingEnsembleState({
          intent,
          profilerState,
          oracleState,
          sentimentState,
          anomalyStatus,
          config: target.cachedConfig,
          observedAt
        }),
      prepareExecutionPlan: (intent, observedAt, options) =>
        prepareTradingExecutionPlan(
          {
            intent,
            observedAt,
            options,
            engineState: target.engineState,
            config: target.cachedConfig,
            env: target.env,
            orderBooks: target.orderBook.values(),
            pitBossAgent: target.pitBossAgent
          },
          {
            logResidualLiquidityShortfall: (metadata) => {
              target.logger.warn(
                "SOR_RESIDUAL_LIQUIDITY_SHORTFALL",
                "Smart router could not source full approved size",
                metadata
              );
            }
          }
        ),
      applyQuoteSuppression: (
        instrumentCode,
        currentCroupierDecision,
        currentProfilerResult,
        executionPlans,
        observedAt,
        shadowReplay,
        ensembleAnomalyCircuitBreaker,
        ensembleRationale
      ) =>
        applyTradingQuoteSuppression(
          {
            engineState: target.engineState,
            instrumentCode,
            croupierDecision: currentCroupierDecision,
            profilerResult: currentProfilerResult,
            executionPlans,
            observedAt,
            shadowReplay,
            ensembleAnomalyCircuitBreaker,
            ensembleRationale,
            macroBias: target.macroBias,
            config: target.cachedConfig,
            envQuoteHibernateMs: target.env.QUOTE_HIBERNATE_MS
          },
          {
            publishSuspend: (payload) => {
              target.publish("SUSPEND_QUOTES", payload);
            },
            cancelQuotes: (reason) => {
              target.state.waitUntil(target.cancelAllQuotes(instrumentCode, reason));
            }
          }
        )
    }
  );
}
