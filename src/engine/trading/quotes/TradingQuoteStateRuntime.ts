import type { EngineState, Env, GlobalRiskConfig, MacroBias } from "../../../types";
import { quoteStateForInstrumentState } from "../state/AssetQuoteStateRuntime";
import { isInstrumentSelectedByMoltworker } from "../state/AssetSelectionRuntime";
import {
  nextQuoteStateForInstrument,
  resolveQuoteHibernateMs,
  strategyQuoteDisabledReason
} from "./QuoteLifecycleRuntime";
import { applyResumeExpiredQuoteStatesSideEffects } from "./QuoteResumeRuntime";

export interface TradingQuoteStateInput {
  readonly instrumentCode: string;
  readonly quote: EngineState["quoteState"]["lastQuote"];
  readonly pullAllQuotes: boolean;
  readonly observedAt: string;
  readonly engineState: EngineState;
  readonly config: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly env: Pick<Env, "QUOTE_HIBERNATE_MS">;
}

export interface TradingQuoteResumeInput {
  readonly engineState: EngineState;
  readonly observedAt: string;
}

export interface TradingQuoteResumeHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly publishResume: (payload: Record<string, unknown>) => void;
}

export function nextTradingQuoteStateForInstrument(
  input: TradingQuoteStateInput
): EngineState["quoteState"] {
  return nextQuoteStateForInstrument({
    previous: quoteStateForInstrumentState(
      input.engineState.assetQuoteStates,
      input.instrumentCode,
      input.engineState.quoteState
    ),
    quote: input.quote,
    tradingEnabled: input.config.TRADING_ENABLED,
    strategyDisabledReason: strategyQuoteDisabledReason(input.config),
    instrumentSelected: isInstrumentSelectedByMoltworker(input.instrumentCode, input.macroBias),
    pullAllQuotes: input.pullAllQuotes,
    quoteHibernateMs: resolveQuoteHibernateMs(input.config, input.env.QUOTE_HIBERNATE_MS),
    observedAt: input.observedAt
  });
}

export function resumeTradingQuotesIfExpired(
  input: TradingQuoteResumeInput,
  handlers: TradingQuoteResumeHandlers
): void {
  applyResumeExpiredQuoteStatesSideEffects(
    {
      currentState: input.engineState,
      observedAt: input.observedAt
    },
    handlers
  );
}
