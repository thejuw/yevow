import type { CroupierDecision } from "../../../agents/CroupierAgent";
import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import type { EngineState, GlobalRiskConfig, MacroBias } from "../../../types";
import type { ApprovedExecutionPlan } from "../execution/ExecutionPlanRuntime";
import { isInstrumentSelectedByMoltworker } from "../state/AssetStateRuntime";
import type { QuotePolicyResult } from "../pipelines/TickPipelineTypes";
import {
  applyQuoteSuppressionRuntime,
  applyQuoteSuppressionSideEffects,
  quoteSuppressionPolicyProjection
} from "./QuoteSuppressionRuntime";

export interface TradingQuoteSuppressionInput {
  readonly engineState: Pick<EngineState, "assetQuoteStates" | "quoteState">;
  readonly instrumentCode: string;
  readonly croupierDecision: CroupierDecision;
  readonly profilerResult: ProfilerEvaluation;
  readonly executionPlans: readonly ApprovedExecutionPlan[];
  readonly observedAt: string;
  readonly shadowReplay: boolean;
  readonly ensembleAnomalyCircuitBreaker: boolean;
  readonly ensembleRationale: string;
  readonly macroBias: MacroBias;
  readonly config: GlobalRiskConfig;
  readonly envQuoteHibernateMs?: string;
}

export interface TradingQuoteSuppressionHandlers {
  readonly publishSuspend: (payload: Record<string, unknown>) => void;
  readonly cancelQuotes: (reason: string) => void;
}

export function applyTradingQuoteSuppression(
  input: TradingQuoteSuppressionInput,
  handlers: TradingQuoteSuppressionHandlers
): QuotePolicyResult {
  const profilerSignalType = input.profilerResult.signal?.featureVector.signalType;
  const quotePolicy = applyQuoteSuppressionRuntime({
    assetQuoteStates: input.engineState.assetQuoteStates,
    quoteState: input.engineState.quoteState,
    instrumentCode: input.instrumentCode,
    quote: input.croupierDecision.quote,
    pullAllQuotes: input.croupierDecision.pullAllQuotes,
    instrumentSelected: isInstrumentSelectedByMoltworker(input.instrumentCode, input.macroBias),
    config: input.config,
    envQuoteHibernateMs: input.envQuoteHibernateMs,
    tradingEnabled: input.config.TRADING_ENABLED,
    shadowReplay: input.shadowReplay,
    executionPlans: input.executionPlans,
    profilerSignalType,
    profilerSuspendedUntil:
      typeof input.profilerResult.signal?.featureVector.suspendedUntil === "string"
        ? input.profilerResult.signal.featureVector.suspendedUntil
        : undefined,
    profilerQuoteHaltUntil: input.profilerResult.state.quoteHaltUntil,
    ensembleAnomalyCircuitBreaker: input.ensembleAnomalyCircuitBreaker,
    ensembleRationale: input.ensembleRationale,
    observedAt: input.observedAt
  });

  applyQuoteSuppressionSideEffects(quotePolicy.sideEffects, handlers);
  return quoteSuppressionPolicyProjection(quotePolicy);
}
