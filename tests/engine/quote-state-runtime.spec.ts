import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import {
  nextQuoteStateForInstrument,
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
