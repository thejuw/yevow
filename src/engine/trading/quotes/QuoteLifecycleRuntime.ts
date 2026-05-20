import type { EngineState, GlobalRiskConfig, QuoteSignal } from "../../../types";
import { DEFAULT_QUOTE_HIBERNATE_MS } from "../../../TradingEngineConstants";
import { readPositiveInteger } from "../helpers/RuntimeParsing";

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

export function quoteStateTelemetry(state: EngineState["quoteState"]): Record<string, unknown> {
  return {
    status: state.status,
    reason: state.reason,
    suspendedUntil: state.suspendedUntil,
    updatedAt: state.updatedAt
  };
}

export function suspendedQuoteState(
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
