import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import {
  applyQuoteSuppressionRuntime,
  applyQuoteSuppressionPolicy,
  applyQuoteSuppressionSideEffects,
  isCascadeShieldSignal,
  isProfilerQuoteHaltSignal,
  nextQuoteStateForInstrument,
  quoteSuppressionPolicyProjection,
  quoteSuppressionDecision,
  quoteSuppressionSideEffects,
  resumeExpiredQuoteStates,
  resolveQuoteHibernateMs,
  strategyQuoteDisabledReason
} from "../../src/engine/trading/quotes/QuoteStateRuntime";
import type { EngineState, QuoteSignal } from "../../src/types";

const OBSERVED_AT = "2026-05-18T13:00:00.000Z";

describe("QuoteStateRuntime", () => {
  it("suspends quoting for disabled trading, strategy gates, and Moltworker selection", () => {
    const previous = quoteState({ lastQuote: quote("old") });

    expect(
      nextQuoteStateForInstrument({
        previous,
        quote: quote("new"),
        tradingEnabled: false,
        strategyDisabledReason: null,
        instrumentSelected: true,
        pullAllQuotes: false,
        quoteHibernateMs: 60_000,
        observedAt: OBSERVED_AT
      })
    ).toEqual({
      status: "SUSPENDED",
      reason: "TRADING_DISABLED",
      suspendedUntil: null,
      lastQuote: previous.lastQuote,
      updatedAt: OBSERVED_AT
    });
    expect(
      nextQuoteStateForInstrument({
        previous,
        quote: null,
        tradingEnabled: true,
        strategyDisabledReason: "MARKET_MAKING_OFF",
        instrumentSelected: true,
        pullAllQuotes: false,
        quoteHibernateMs: 60_000,
        observedAt: OBSERVED_AT
      }).reason
    ).toBe("MARKET_MAKING_OFF");
    expect(
      nextQuoteStateForInstrument({
        previous,
        quote: null,
        tradingEnabled: true,
        strategyDisabledReason: null,
        instrumentSelected: false,
        pullAllQuotes: false,
        quoteHibernateMs: 60_000,
        observedAt: OBSERVED_AT
      }).reason
    ).toBe("MOLTWORKER_NOT_SELECTED");
  });

  it("hibernates on adverse selection and preserves unexpired suspensions", () => {
    const suspendedUntil = "2026-05-18T13:00:30.000Z";
    const previous = quoteState({
      status: "SUSPENDED",
      reason: "ADVERSE_SELECTION_CRITICAL",
      suspendedUntil
    });

    expect(
      nextQuoteStateForInstrument({
        previous: quoteState({ lastQuote: quote("old") }),
        quote: quote("new"),
        tradingEnabled: true,
        strategyDisabledReason: null,
        instrumentSelected: true,
        pullAllQuotes: true,
        quoteHibernateMs: 30_000,
        observedAt: OBSERVED_AT
      })
    ).toMatchObject({
      status: "SUSPENDED",
      reason: "ADVERSE_SELECTION_CRITICAL",
      suspendedUntil
    });
    expect(
      nextQuoteStateForInstrument({
        previous,
        quote: quote("new"),
        tradingEnabled: true,
        strategyDisabledReason: null,
        instrumentSelected: true,
        pullAllQuotes: false,
        quoteHibernateMs: 30_000,
        observedAt: OBSERVED_AT
      })
    ).toBe(previous);
  });

  it("activates with the new quote and derives strategy disabled reasons", () => {
    expect(
      nextQuoteStateForInstrument({
        previous: quoteState({ lastQuote: quote("old") }),
        quote: quote("new"),
        tradingEnabled: true,
        strategyDisabledReason: null,
        instrumentSelected: true,
        pullAllQuotes: false,
        quoteHibernateMs: 30_000,
        observedAt: OBSERVED_AT
      })
    ).toMatchObject({
      status: "ACTIVE",
      reason: null,
      suspendedUntil: null,
      lastQuote: { signalId: "new" },
      updatedAt: OBSERVED_AT
    });

    expect(strategyQuoteDisabledReason({ ...defaultConfig, CROUPIER_ENABLED: false })).toBe(
      "CROUPIER_DISABLED"
    );
    expect(strategyQuoteDisabledReason({ ...defaultConfig, MARKET_MAKING_MODE: "OFF" })).toBe(
      "MARKET_MAKING_OFF"
    );
    expect(strategyQuoteDisabledReason({ ...defaultConfig, PIT_BOSS_ENABLED: false })).toBe(
      "PIT_BOSS_DISABLED"
    );
    expect(strategyQuoteDisabledReason(defaultConfig)).toBeNull();
  });

  it("resolves quote hibernation from config first and bounded env fallback", () => {
    expect(resolveQuoteHibernateMs({ ...defaultConfig, QUOTE_HIBERNATE_MS: 9_000 }, "100")).toBe(
      9_000
    );
    expect(resolveQuoteHibernateMs({ ...defaultConfig, QUOTE_HIBERNATE_MS: 0 }, "5000")).toBe(
      5_000
    );
    expect(resolveQuoteHibernateMs({ ...defaultConfig, QUOTE_HIBERNATE_MS: 0 }, "10")).toBe(100);
  });

  it("resumes expired asset quote suspensions and reports whether state changed", () => {
    const result = resumeExpiredQuoteStates({
      assetQuoteStates: {
        "btc-usd": quoteState({
          status: "SUSPENDED",
          reason: "BTC_LEAD_MOVE",
          suspendedUntil: "2026-05-18T12:59:59.000Z"
        }),
        "hype-usd": quoteState({ status: "ACTIVE" })
      },
      quoteState: quoteState({
        status: "SUSPENDED",
        reason: "BTC_LEAD_MOVE",
        suspendedUntil: "2026-05-18T12:59:59.000Z"
      }),
      observedAt: OBSERVED_AT
    });

    expect(result.changed).toBe(true);
    expect(result.assetQuoteStates["btc-usd"]).toMatchObject({
      status: "ACTIVE",
      reason: null,
      suspendedUntil: null,
      updatedAt: OBSERVED_AT
    });
    expect(result.quoteState.status).toBe("ACTIVE");

    const unchanged = resumeExpiredQuoteStates({
      assetQuoteStates: result.assetQuoteStates,
      quoteState: result.quoteState,
      observedAt: OBSERVED_AT
    });
    expect(unchanged.changed).toBe(false);
  });

  it("builds ensemble circuit-breaker quote suspension decisions", () => {
    const previous = quoteState({ lastQuote: quote("old") });

    const result = quoteSuppressionDecision({
      previous,
      profilerSignalType: undefined,
      amVpinQuoteHaltMs: 60_000,
      quoteHibernateMs: 30_000,
      ensembleAnomalyCircuitBreaker: true,
      ensembleRationale: "jump-risk",
      observedAt: OBSERVED_AT
    });

    expect(result.executionPlansAllowed).toBe(false);
    expect(result.cancelReason).toBe("ENSEMBLE_CIRCUIT_BREAKER");
    expect(result.quoteState).toMatchObject({
      status: "SUSPENDED",
      reason: "ENSEMBLE_ANOMALY_CIRCUIT_BREAKER",
      suspendedUntil: "2026-05-18T13:01:00.000Z",
      lastQuote: previous.lastQuote,
      updatedAt: OBSERVED_AT
    });
    expect(result.suspendTelemetry).toEqual({
      reason: "ENSEMBLE_ANOMALY_CIRCUIT_BREAKER",
      status: "SUSPENDED",
      suspendedUntil: "2026-05-18T13:01:00.000Z",
      updatedAt: OBSERVED_AT
    });
  });

  it("builds profiler quote halt decisions with explicit or fallback hibernation windows", () => {
    expect(
      quoteSuppressionDecision({
        previous: quoteState(),
        profilerSignalType: "SUSPEND_QUOTES",
        profilerSuspendedUntil: "2026-05-18T13:02:00.000Z",
        amVpinQuoteHaltMs: 60_000,
        quoteHibernateMs: 30_000,
        ensembleAnomalyCircuitBreaker: false,
        ensembleRationale: "",
        observedAt: OBSERVED_AT
      }).quoteState
    ).toMatchObject({
      status: "SUSPENDED",
      reason: "WHALE_PRINT",
      suspendedUntil: "2026-05-18T13:02:00.000Z"
    });

    expect(
      quoteSuppressionDecision({
        previous: quoteState(),
        profilerSignalType: "AM_VPIN_CRITICAL",
        amVpinQuoteHaltMs: 45_000,
        quoteHibernateMs: 30_000,
        ensembleAnomalyCircuitBreaker: false,
        ensembleRationale: "",
        observedAt: OBSERVED_AT
      }).quoteState
    ).toMatchObject({
      status: "SUSPENDED",
      reason: "AM_VPIN_CRITICAL",
      suspendedUntil: "2026-05-18T13:00:45.000Z"
    });
  });

  it("identifies cascade shield and profiler halt signal types without suspending neutral signals", () => {
    expect(isCascadeShieldSignal("CASCADE_SHIELD")).toBe(true);
    expect(isCascadeShieldSignal("SUSPEND_QUOTES")).toBe(false);
    expect(isProfilerQuoteHaltSignal("SUSPEND_QUOTES")).toBe(true);
    expect(isProfilerQuoteHaltSignal("AM_VPIN_CRITICAL")).toBe(true);
    expect(isProfilerQuoteHaltSignal("CASCADE_SHIELD")).toBe(false);

    const previous = quoteState();
    expect(
      quoteSuppressionDecision({
        previous,
        profilerSignalType: "CASCADE_SHIELD",
        amVpinQuoteHaltMs: 60_000,
        quoteHibernateMs: 30_000,
        ensembleAnomalyCircuitBreaker: false,
        ensembleRationale: "",
        observedAt: OBSERVED_AT
      })
    ).toMatchObject({
      quoteState: previous,
      executionPlansAllowed: true,
      isCascadeShield: true,
      isProfilerQuoteHalt: false,
      cancelReason: null,
      suspendTelemetry: null
    });
  });

  it("applies quote suppression policy and reports side-effect reasons", () => {
    const plan = { id: "plan-1" };
    const result = applyQuoteSuppressionPolicy({
      previousQuoteState: quoteState({ reason: "OLD_REASON" }),
      assetQuoteState: quoteState(),
      strategyQuoteDisableReason: "MARKET_MAKING_OFF",
      tradingEnabled: true,
      shadowReplay: false,
      executionPlans: [plan],
      profilerSignalType: "AM_VPIN_CRITICAL",
      amVpinQuoteHaltMs: 45_000,
      quoteHibernateMs: 30_000,
      ensembleAnomalyCircuitBreaker: false,
      ensembleRationale: "",
      observedAt: OBSERVED_AT
    });

    expect(result).toMatchObject({
      executionPlans: [],
      strategyQuoteDisableReason: "MARKET_MAKING_OFF",
      strategyCancelReason: "MARKET_MAKING_OFF",
      suppressionCancelReason: null,
      isCascadeShield: false,
      isProfilerQuoteHalt: true,
      assetQuoteState: {
        status: "SUSPENDED",
        reason: "AM_VPIN_CRITICAL",
        suspendedUntil: "2026-05-18T13:00:45.000Z"
      }
    });
  });

  it("suppresses execution plans and cancel side effects for shadow replay", () => {
    const plan = { id: "plan-1" };
    const result = applyQuoteSuppressionPolicy({
      previousQuoteState: quoteState({ reason: "OLD_REASON" }),
      assetQuoteState: quoteState(),
      strategyQuoteDisableReason: "MARKET_MAKING_OFF",
      tradingEnabled: true,
      shadowReplay: true,
      executionPlans: [plan],
      profilerSignalType: undefined,
      amVpinQuoteHaltMs: 45_000,
      quoteHibernateMs: 30_000,
      ensembleAnomalyCircuitBreaker: true,
      ensembleRationale: "jump-risk",
      observedAt: OBSERVED_AT
    });

    expect(result.executionPlans).toEqual([]);
    expect(result.strategyCancelReason).toBeNull();
    expect(result.suppressionCancelReason).toBeNull();
    expect(result.suspendTelemetry).toMatchObject({
      reason: "ENSEMBLE_ANOMALY_CIRCUIT_BREAKER"
    });
  });

  it("materializes quote suppression side effects in execution order", () => {
    const effects = quoteSuppressionSideEffects({
      instrumentCode: "btc-usd",
      strategyCancelReason: "MARKET_MAKING_OFF",
      suppressionCancelReason: "ENSEMBLE_CIRCUIT_BREAKER",
      suspendTelemetry: {
        reason: "ENSEMBLE_ANOMALY_CIRCUIT_BREAKER",
        suspendedUntil: "2026-05-18T13:01:00.000Z"
      }
    });

    expect(effects).toEqual([
      {
        kind: "CANCEL_QUOTES",
        reason: "MARKET_MAKING_OFF"
      },
      {
        kind: "PUBLISH_SUSPEND",
        payload: {
          instrumentCode: "btc-usd",
          reason: "ENSEMBLE_ANOMALY_CIRCUIT_BREAKER",
          suspendedUntil: "2026-05-18T13:01:00.000Z"
        }
      },
      {
        kind: "CANCEL_QUOTES",
        reason: "ENSEMBLE_CIRCUIT_BREAKER"
      }
    ]);

    const emitted: string[] = [];
    applyQuoteSuppressionSideEffects(effects, {
      publishSuspend: (payload) => emitted.push(`publish:${payload.reason}`),
      cancelQuotes: (reason) => emitted.push(`cancel:${reason}`)
    });
    expect(emitted).toEqual([
      "cancel:MARKET_MAKING_OFF",
      "publish:ENSEMBLE_ANOMALY_CIRCUIT_BREAKER",
      "cancel:ENSEMBLE_CIRCUIT_BREAKER"
    ]);
  });

  it("applies full quote suppression runtime from state, config, profiler, and selection inputs", () => {
    const plan = { id: "plan-1" };
    const state = {
      quoteState: quoteState(),
      assetQuoteStates: {}
    };
    const result = applyQuoteSuppressionRuntime({
      ...state,
      instrumentCode: "btc-usd",
      quote: quote("new"),
      pullAllQuotes: false,
      instrumentSelected: true,
      config: {
        ...defaultConfig,
        TRADING_ENABLED: true,
        MARKET_MAKING_MODE: "OFF",
        QUOTE_HIBERNATE_MS: 30_000
      },
      tradingEnabled: true,
      shadowReplay: false,
      executionPlans: [plan],
      profilerSignalType: "AM_VPIN_CRITICAL",
      profilerQuoteHaltUntil: null,
      ensembleAnomalyCircuitBreaker: false,
      ensembleRationale: "",
      observedAt: OBSERVED_AT
    });

    expect(result.executionPlans).toEqual([]);
    expect(result.strategyQuoteDisableReason).toBe("MARKET_MAKING_OFF");
    expect(result.assetQuoteState).toMatchObject({
      status: "SUSPENDED",
      reason: "AM_VPIN_CRITICAL"
    });
    expect(result.sideEffects).toEqual([
      {
        kind: "CANCEL_QUOTES",
        reason: "MARKET_MAKING_OFF"
      },
      {
        kind: "PUBLISH_SUSPEND",
        payload: {
          instrumentCode: "btc-usd",
          reason: "AM_VPIN_CRITICAL",
          status: "SUSPENDED",
          suspendedUntil: "2026-05-18T13:01:00.000Z",
          updatedAt: OBSERVED_AT
        }
      }
    ]);
    expect(quoteSuppressionPolicyProjection(result)).toEqual({
      executionPlans: [],
      assetQuoteState: result.assetQuoteState,
      strategyQuoteDisableReason: "MARKET_MAKING_OFF",
      isCascadeShield: false,
      isProfilerQuoteHalt: true
    });
  });
});

function quoteState(overrides: Partial<EngineState["quoteState"]> = {}): EngineState["quoteState"] {
  return {
    status: "ACTIVE",
    reason: null,
    suspendedUntil: null,
    lastQuote: null,
    updatedAt: "2026-05-18T12:59:00.000Z",
    ...overrides
  };
}

function quote(signalId: string): QuoteSignal {
  return {
    schemaVersion: "quote-signal.v1",
    signalId,
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    reservationPrice: 100,
    optimalSpread: 1,
    orders: [],
    createdAt: OBSERVED_AT
  };
}
