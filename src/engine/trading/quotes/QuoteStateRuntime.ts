import type { EngineState, GlobalRiskConfig, QuoteSignal } from "../../../types";
import { DEFAULT_QUOTE_HIBERNATE_MS } from "../../../TradingEngineConstants";
import { readPositiveInteger } from "../helpers/RuntimeParsing";
import {
  aggregateQuoteState,
  quoteStateForInstrumentState,
  resumeExpiredAssetQuoteStates
} from "../state/AssetStateRuntime";

export interface NextQuoteStateInput {
  readonly previous: EngineState["quoteState"];
  readonly quote: QuoteSignal | null;
  readonly tradingEnabled: boolean;
  readonly strategyDisabledReason: string | null;
  readonly instrumentSelected: boolean;
  readonly pullAllQuotes: boolean;
  readonly quoteHibernateMs: number;
  readonly observedAt: string;
}

export interface ResumeExpiredQuoteStatesInput {
  readonly assetQuoteStates: EngineState["assetQuoteStates"];
  readonly quoteState: EngineState["quoteState"];
  readonly observedAt: string;
}

export interface ResumeExpiredQuoteStatesResult {
  readonly assetQuoteStates: EngineState["assetQuoteStates"];
  readonly quoteState: EngineState["quoteState"];
  readonly changed: boolean;
}

export interface ResumeExpiredQuoteStatesSideEffectInput {
  readonly currentState: EngineState;
  readonly observedAt: string;
}

export interface ResumeExpiredQuoteStatesSideEffectHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly publishResume: (payload: Record<string, unknown>) => void;
}

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

export function nextQuoteStateForInstrument(input: NextQuoteStateInput): EngineState["quoteState"] {
  if (!input.tradingEnabled) {
    return suspendedQuoteState(input.previous, "TRADING_DISABLED", null, input.observedAt);
  }

  if (input.strategyDisabledReason) {
    return suspendedQuoteState(
      input.previous,
      input.strategyDisabledReason,
      null,
      input.observedAt
    );
  }

  if (!input.instrumentSelected) {
    return suspendedQuoteState(input.previous, "MOLTWORKER_NOT_SELECTED", null, input.observedAt);
  }

  if (input.pullAllQuotes) {
    return suspendedQuoteState(
      input.previous,
      "ADVERSE_SELECTION_CRITICAL",
      new Date(Date.parse(input.observedAt) + input.quoteHibernateMs).toISOString(),
      input.observedAt
    );
  }

  if (
    input.previous.suspendedUntil &&
    Date.parse(input.previous.suspendedUntil) > Date.parse(input.observedAt)
  ) {
    return input.previous;
  }

  return {
    status: "ACTIVE",
    reason: null,
    suspendedUntil: null,
    lastQuote: input.quote ?? input.previous.lastQuote,
    updatedAt: input.observedAt
  };
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

export function resumeExpiredQuoteStates(
  input: ResumeExpiredQuoteStatesInput
): ResumeExpiredQuoteStatesResult {
  const nextAssetQuoteStates = resumeExpiredAssetQuoteStates(
    input.assetQuoteStates,
    input.observedAt
  );
  const nextAggregate = aggregateQuoteState(
    nextAssetQuoteStates,
    input.quoteState,
    input.observedAt
  );
  const assetStatesChanged = quoteAssetStatesChanged(input.assetQuoteStates, nextAssetQuoteStates);
  const aggregateExpired =
    input.quoteState.status === "SUSPENDED" &&
    Boolean(input.quoteState.suspendedUntil) &&
    Date.parse(input.quoteState.suspendedUntil ?? "") <= Date.parse(input.observedAt);
  const changed =
    assetStatesChanged ||
    nextAggregate.status !== input.quoteState.status ||
    nextAggregate.reason !== input.quoteState.reason ||
    aggregateExpired;

  return {
    assetQuoteStates: nextAssetQuoteStates,
    quoteState: nextAggregate,
    changed
  };
}

export function applyResumeExpiredQuoteStatesSideEffects(
  input: ResumeExpiredQuoteStatesSideEffectInput,
  handlers: ResumeExpiredQuoteStatesSideEffectHandlers
): ResumeExpiredQuoteStatesResult {
  const next = resumeExpiredQuoteStates({
    assetQuoteStates: input.currentState.assetQuoteStates,
    quoteState: input.currentState.quoteState,
    observedAt: input.observedAt
  });

  if (next.changed) {
    handlers.applyState({
      ...input.currentState,
      quoteState: next.quoteState,
      assetQuoteStates: next.assetQuoteStates
    });
    handlers.publishResume({ observedAt: input.observedAt });
  }

  return next;
}

export function strategyQuoteDisabledReason(config: GlobalRiskConfig): string | null {
  if (!config.CROUPIER_ENABLED) {
    return "CROUPIER_DISABLED";
  }

  if (config.MARKET_MAKING_MODE === "OFF") {
    return "MARKET_MAKING_OFF";
  }

  if (!config.PIT_BOSS_ENABLED) {
    return "PIT_BOSS_DISABLED";
  }

  return null;
}

export function resolveQuoteHibernateMs(
  config: Pick<GlobalRiskConfig, "QUOTE_HIBERNATE_MS">,
  envQuoteHibernateMs?: string
): number {
  return config.QUOTE_HIBERNATE_MS > 0
    ? config.QUOTE_HIBERNATE_MS
    : readPositiveInteger(envQuoteHibernateMs, DEFAULT_QUOTE_HIBERNATE_MS, 100, 60_000);
}

export function isCascadeShieldSignal(signalType: unknown): boolean {
  return signalType === "CASCADE_SHIELD";
}

export function isProfilerQuoteHaltSignal(signalType: unknown): boolean {
  return signalType === "SUSPEND_QUOTES" || signalType === "AM_VPIN_CRITICAL";
}

function quoteAssetStatesChanged(
  previous: EngineState["assetQuoteStates"],
  next: EngineState["assetQuoteStates"]
): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);

  for (const key of keys) {
    if (
      previous[key]?.status !== next[key]?.status ||
      previous[key]?.reason !== next[key]?.reason ||
      previous[key]?.suspendedUntil !== next[key]?.suspendedUntil
    ) {
      return true;
    }
  }

  return false;
}

function suspendedQuoteState(
  previous: EngineState["quoteState"],
  reason: string,
  suspendedUntil: string | null,
  observedAt: string
): EngineState["quoteState"] {
  return {
    status: "SUSPENDED",
    reason,
    suspendedUntil,
    lastQuote: previous.lastQuote,
    updatedAt: observedAt
  };
}

function quoteStateTelemetry(state: EngineState["quoteState"]): Record<string, unknown> {
  return {
    status: state.status,
    reason: state.reason,
    suspendedUntil: state.suspendedUntil,
    updatedAt: state.updatedAt
  };
}
