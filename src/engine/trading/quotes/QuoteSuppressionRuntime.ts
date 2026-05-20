import type { EngineState, GlobalRiskConfig, QuoteSignal } from "../../../types";
import { quoteStateForInstrumentState } from "../state/AssetStateRuntime";
import {
  isCascadeShieldSignal,
  isProfilerQuoteHaltSignal,
  nextQuoteStateForInstrument,
  quoteStateTelemetry,
  resolveQuoteHibernateMs,
  strategyQuoteDisabledReason,
  suspendedQuoteState
} from "./QuoteLifecycleRuntime";

export interface QuoteSuppressionDecisionInput {
  readonly previous: EngineState["quoteState"];
  readonly profilerSignalType: unknown;
  readonly profilerSuspendedUntil?: string;
  readonly profilerQuoteHaltUntil?: string | null;
  readonly amVpinQuoteHaltMs: number;
  readonly quoteHibernateMs: number;
  readonly ensembleAnomalyCircuitBreaker: boolean;
  readonly ensembleRationale: string;
  readonly observedAt: string;
}

export interface QuoteSuppressionDecisionResult {
  readonly quoteState: EngineState["quoteState"];
  readonly executionPlansAllowed: boolean;
  readonly isCascadeShield: boolean;
  readonly isProfilerQuoteHalt: boolean;
  readonly cancelReason: string | null;
  readonly suspendTelemetry: Record<string, unknown> | null;
}

export interface QuoteSuppressionPolicyInput<TExecutionPlan> {
  readonly previousQuoteState: EngineState["quoteState"];
  readonly assetQuoteState: EngineState["quoteState"];
  readonly strategyQuoteDisableReason: string | null;
  readonly tradingEnabled: boolean;
  readonly shadowReplay: boolean;
  readonly executionPlans: readonly TExecutionPlan[];
  readonly profilerSignalType: unknown;
  readonly profilerSuspendedUntil?: string;
  readonly profilerQuoteHaltUntil?: string | null;
  readonly amVpinQuoteHaltMs: number;
  readonly quoteHibernateMs: number;
  readonly ensembleAnomalyCircuitBreaker: boolean;
  readonly ensembleRationale: string;
  readonly observedAt: string;
}

export interface QuoteSuppressionPolicyResult<TExecutionPlan> {
  readonly executionPlans: TExecutionPlan[];
  readonly assetQuoteState: EngineState["quoteState"];
  readonly strategyQuoteDisableReason: string | null;
  readonly strategyCancelReason: string | null;
  readonly suppressionCancelReason: string | null;
  readonly suspendTelemetry: Record<string, unknown> | null;
  readonly isCascadeShield: boolean;
  readonly isProfilerQuoteHalt: boolean;
}

export interface QuoteSuppressionRuntimeInput<TExecutionPlan> {
  readonly assetQuoteStates: EngineState["assetQuoteStates"];
  readonly quoteState: EngineState["quoteState"];
  readonly instrumentCode: string;
  readonly quote: QuoteSignal | null;
  readonly pullAllQuotes: boolean;
  readonly instrumentSelected: boolean;
  readonly config: GlobalRiskConfig;
  readonly envQuoteHibernateMs?: string;
  readonly tradingEnabled: boolean;
  readonly shadowReplay: boolean;
  readonly executionPlans: readonly TExecutionPlan[];
  readonly profilerSignalType: unknown;
  readonly profilerSuspendedUntil?: string;
  readonly profilerQuoteHaltUntil?: string | null;
  readonly ensembleAnomalyCircuitBreaker: boolean;
  readonly ensembleRationale: string;
  readonly observedAt: string;
}

export interface QuoteSuppressionRuntimeResult<
  TExecutionPlan
> extends QuoteSuppressionPolicyResult<TExecutionPlan> {
  readonly sideEffects: QuoteSuppressionSideEffect[];
}

export interface QuoteSuppressionPolicyProjection<TExecutionPlan> {
  readonly executionPlans: TExecutionPlan[];
  readonly assetQuoteState: EngineState["quoteState"];
  readonly strategyQuoteDisableReason: string | null;
  readonly isCascadeShield: boolean;
  readonly isProfilerQuoteHalt: boolean;
}

export type QuoteSuppressionSideEffect =
  | {
      readonly kind: "CANCEL_QUOTES";
      readonly reason: string;
    }
  | {
      readonly kind: "PUBLISH_SUSPEND";
      readonly payload: Record<string, unknown>;
    };

export interface QuoteSuppressionSideEffectsInput {
  readonly instrumentCode: string;
  readonly strategyCancelReason: string | null;
  readonly suppressionCancelReason: string | null;
  readonly suspendTelemetry: Record<string, unknown> | null;
}

export interface QuoteSuppressionSideEffectHandlers {
  readonly publishSuspend: (payload: Record<string, unknown>) => void;
  readonly cancelQuotes: (reason: string) => void;
}

export function quoteSuppressionDecision(
  input: QuoteSuppressionDecisionInput
): QuoteSuppressionDecisionResult {
  const isCascadeShield = isCascadeShieldSignal(input.profilerSignalType);
  const isProfilerQuoteHalt = isProfilerQuoteHaltSignal(input.profilerSignalType);

  if (input.ensembleAnomalyCircuitBreaker) {
    const quoteState = suspendedQuoteState(
      input.previous,
      "ENSEMBLE_ANOMALY_CIRCUIT_BREAKER",
      new Date(Date.parse(input.observedAt) + 60_000).toISOString(),
      input.observedAt
    );

    return {
      quoteState,
      executionPlansAllowed: false,
      isCascadeShield,
      isProfilerQuoteHalt,
      cancelReason: "ENSEMBLE_CIRCUIT_BREAKER",
      suspendTelemetry: {
        reason: input.ensembleRationale,
        ...quoteStateTelemetry(quoteState)
      }
    };
  }

  if (isProfilerQuoteHalt) {
    const suspendedUntil =
      input.profilerSuspendedUntil ??
      input.profilerQuoteHaltUntil ??
      new Date(
        Date.parse(input.observedAt) +
          (input.profilerSignalType === "AM_VPIN_CRITICAL"
            ? input.amVpinQuoteHaltMs
            : input.quoteHibernateMs)
      ).toISOString();
    const quoteState = suspendedQuoteState(
      input.previous,
      input.profilerSignalType === "AM_VPIN_CRITICAL" ? "AM_VPIN_CRITICAL" : "WHALE_PRINT",
      suspendedUntil,
      input.observedAt
    );

    return {
      quoteState,
      executionPlansAllowed: false,
      isCascadeShield,
      isProfilerQuoteHalt,
      cancelReason: null,
      suspendTelemetry: quoteStateTelemetry(quoteState)
    };
  }

  return {
    quoteState: input.previous,
    executionPlansAllowed: true,
    isCascadeShield,
    isProfilerQuoteHalt,
    cancelReason: null,
    suspendTelemetry: null
  };
}

export function applyQuoteSuppressionPolicy<TExecutionPlan>(
  input: QuoteSuppressionPolicyInput<TExecutionPlan>
): QuoteSuppressionPolicyResult<TExecutionPlan> {
  const strategyCancelReason =
    input.strategyQuoteDisableReason &&
    input.previousQuoteState.reason !== input.strategyQuoteDisableReason &&
    !input.shadowReplay &&
    input.tradingEnabled
      ? input.strategyQuoteDisableReason
      : null;
  const suppression = quoteSuppressionDecision({
    previous: input.assetQuoteState,
    profilerSignalType: input.profilerSignalType,
    profilerSuspendedUntil: input.profilerSuspendedUntil,
    profilerQuoteHaltUntil: input.profilerQuoteHaltUntil,
    amVpinQuoteHaltMs: input.amVpinQuoteHaltMs,
    quoteHibernateMs: input.quoteHibernateMs,
    ensembleAnomalyCircuitBreaker: input.ensembleAnomalyCircuitBreaker,
    ensembleRationale: input.ensembleRationale,
    observedAt: input.observedAt
  });

  return {
    executionPlans: suppression.executionPlansAllowed ? [...input.executionPlans] : [],
    assetQuoteState: suppression.executionPlansAllowed
      ? input.assetQuoteState
      : suppression.quoteState,
    strategyQuoteDisableReason: input.strategyQuoteDisableReason,
    strategyCancelReason,
    suppressionCancelReason:
      suppression.cancelReason && !input.shadowReplay && input.tradingEnabled
        ? suppression.cancelReason
        : null,
    suspendTelemetry: suppression.suspendTelemetry,
    isCascadeShield: suppression.isCascadeShield,
    isProfilerQuoteHalt: suppression.isProfilerQuoteHalt
  };
}

export function quoteSuppressionSideEffects(
  input: QuoteSuppressionSideEffectsInput
): QuoteSuppressionSideEffect[] {
  const effects: QuoteSuppressionSideEffect[] = [];

  if (input.strategyCancelReason) {
    effects.push({
      kind: "CANCEL_QUOTES",
      reason: input.strategyCancelReason
    });
  }

  if (input.suspendTelemetry) {
    effects.push({
      kind: "PUBLISH_SUSPEND",
      payload: {
        instrumentCode: input.instrumentCode,
        ...input.suspendTelemetry
      }
    });
  }

  if (input.suppressionCancelReason) {
    effects.push({
      kind: "CANCEL_QUOTES",
      reason: input.suppressionCancelReason
    });
  }

  return effects;
}

export function applyQuoteSuppressionRuntime<TExecutionPlan>(
  input: QuoteSuppressionRuntimeInput<TExecutionPlan>
): QuoteSuppressionRuntimeResult<TExecutionPlan> {
  const previousQuoteState = quoteStateForInstrumentState(
    input.assetQuoteStates,
    input.instrumentCode,
    input.quoteState
  );
  const strategyQuoteDisableReason = strategyQuoteDisabledReason(input.config);
  const assetQuoteState = nextQuoteStateForInstrument({
    previous: previousQuoteState,
    quote: input.quote,
    tradingEnabled: input.config.TRADING_ENABLED,
    strategyDisabledReason: strategyQuoteDisableReason,
    instrumentSelected: input.instrumentSelected,
    pullAllQuotes: input.pullAllQuotes,
    quoteHibernateMs: resolveQuoteHibernateMs(input.config, input.envQuoteHibernateMs),
    observedAt: input.observedAt
  });
  const policy = applyQuoteSuppressionPolicy({
    previousQuoteState,
    assetQuoteState,
    strategyQuoteDisableReason,
    tradingEnabled: input.tradingEnabled,
    shadowReplay: input.shadowReplay,
    executionPlans: input.executionPlans,
    profilerSignalType: input.profilerSignalType,
    profilerSuspendedUntil: input.profilerSuspendedUntil,
    profilerQuoteHaltUntil: input.profilerQuoteHaltUntil,
    amVpinQuoteHaltMs: input.config.AM_VPIN_QUOTE_HALT_MS,
    quoteHibernateMs: resolveQuoteHibernateMs(input.config, input.envQuoteHibernateMs),
    ensembleAnomalyCircuitBreaker: input.ensembleAnomalyCircuitBreaker,
    ensembleRationale: input.ensembleRationale,
    observedAt: input.observedAt
  });

  return {
    ...policy,
    sideEffects: quoteSuppressionSideEffects({
      instrumentCode: input.instrumentCode,
      strategyCancelReason: policy.strategyCancelReason,
      suppressionCancelReason: policy.suppressionCancelReason,
      suspendTelemetry: policy.suspendTelemetry
    })
  };
}

export function applyQuoteSuppressionSideEffects(
  effects: readonly QuoteSuppressionSideEffect[],
  handlers: QuoteSuppressionSideEffectHandlers
): void {
  for (const effect of effects) {
    if (effect.kind === "PUBLISH_SUSPEND") {
      handlers.publishSuspend(effect.payload);
    } else {
      handlers.cancelQuotes(effect.reason);
    }
  }
}

export function quoteSuppressionPolicyProjection<TExecutionPlan>(
  result: QuoteSuppressionRuntimeResult<TExecutionPlan>
): QuoteSuppressionPolicyProjection<TExecutionPlan> {
  return {
    executionPlans: result.executionPlans,
    assetQuoteState: result.assetQuoteState,
    strategyQuoteDisableReason: result.strategyQuoteDisableReason,
    isCascadeShield: result.isCascadeShield,
    isProfilerQuoteHalt: result.isProfilerQuoteHalt
  };
}
