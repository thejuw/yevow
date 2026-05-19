import type { EngineState, GlobalRiskConfig, QuoteSignal } from "../../../types";
import {
  aggregateQuoteState,
  resumeExpiredAssetQuoteStates
} from "../../../TradingEngineRuntimeHelpers";

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
