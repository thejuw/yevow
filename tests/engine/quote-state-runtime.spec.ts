import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import {
  nextQuoteStateForInstrument,
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
