import type { QueueRefreshAdvice } from "../../QueuePositionModel";
import type { EngineState, Env, InternalOrderBook, JsonRecord } from "../../../types";
import {
  applyQuoteRefreshThrottleSideEffects,
  buildQuoteRefreshRuntimeDecision,
  dispatchedQuoteSnapshot,
  type DispatchedQuoteSnapshot
} from "./QuoteRefreshRuntime";

export interface TradingQuoteRefreshInput {
  readonly quote: NonNullable<EngineState["quoteState"]["lastQuote"]>;
  readonly previousQuote: DispatchedQuoteSnapshot | undefined;
  readonly book: InternalOrderBook | null;
  readonly nowMs: number;
  readonly lastLogAtMs: number;
  readonly logThrottleMs: number;
  readonly env: Pick<Env, "QUOTE_REFRESH_MIN_INTERVAL_MS" | "QUOTE_REFRESH_MIN_PRICE_TICKS">;
}

export interface TradingQuoteRefreshHandlers {
  readonly markLogAt: (logKey: string, loggedAtMs: number) => void;
  readonly logInfo: (event: string, message: string, metadata: JsonRecord) => void;
  readonly adviseRefresh: (input: {
    readonly previousQuote: DispatchedQuoteSnapshot | null;
    readonly quote: NonNullable<EngineState["quoteState"]["lastQuote"]>;
    readonly book: InternalOrderBook | null;
    readonly minPriceTicks: number;
    readonly elapsedMs: number;
    readonly tickSize: number;
  }) => QueueRefreshAdvice;
}

export function shouldThrottleTradingQuoteRefresh(
  input: TradingQuoteRefreshInput,
  handlers: TradingQuoteRefreshHandlers
): boolean {
  if (!input.previousQuote) {
    return false;
  }

  const logKey = input.quote.instrumentCode;
  const refresh = buildQuoteRefreshRuntimeDecision({
    previousQuote: input.previousQuote,
    quote: input.quote,
    book: input.book,
    nowMs: input.nowMs,
    lastLogAtMs: input.lastLogAtMs,
    logThrottleMs: input.logThrottleMs,
    minIntervalMsValue: input.env.QUOTE_REFRESH_MIN_INTERVAL_MS,
    minPriceTicksValue: input.env.QUOTE_REFRESH_MIN_PRICE_TICKS,
    adviseRefresh: handlers.adviseRefresh
  });

  applyQuoteRefreshThrottleSideEffects(
    { quote: input.quote, logKey, refresh },
    {
      markLogAt: handlers.markLogAt,
      logInfo: handlers.logInfo
    }
  );

  return refresh.throttle.shouldThrottle;
}

export function rememberTradingDispatchedQuote(
  quote: NonNullable<EngineState["quoteState"]["lastQuote"]>,
  fallbackNowMs: number
): DispatchedQuoteSnapshot {
  return dispatchedQuoteSnapshot(quote, fallbackNowMs);
}
