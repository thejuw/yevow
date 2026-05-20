import type { InternalOrderBook, JsonRecord, QuoteSignal } from "../../../types";
import type { QueueRefreshAdvice } from "../../QueuePositionModel";
import {
  DEFAULT_QUOTE_REFRESH_MIN_INTERVAL_MS,
  DEFAULT_QUOTE_REFRESH_MIN_PRICE_TICKS
} from "../../../TradingEngineConstants";
import { DEFAULT_ORDER_BOOK_TICK_SIZE, roundMetric } from "../book/SortedBookSide";
import { readPositiveInteger } from "../helpers/RuntimeParsing";

export interface DispatchedQuoteSnapshot {
  readonly bid: number | null;
  readonly ask: number | null;
  readonly updatedAtMs: number;
}

export interface QuoteRefreshThrottleInput {
  readonly previousQuote: DispatchedQuoteSnapshot | undefined;
  readonly quote: QuoteSignal;
  readonly advice: QueueRefreshAdvice;
  readonly minIntervalMs: number;
  readonly minPriceTicks: number;
  readonly nowMs: number;
  readonly lastLogAtMs: number;
  readonly logThrottleMs: number;
}

export interface QuoteRefreshThrottleDecision {
  readonly shouldThrottle: boolean;
  readonly shouldLog: boolean;
  readonly nextLogAtMs: number;
  readonly elapsedMs: number;
  readonly queuePressure: number;
  readonly queueReason: QueueRefreshAdvice["reason"];
}

export interface QuoteRefreshThrottleLogInput {
  readonly quote: QuoteSignal;
  readonly throttle: QuoteRefreshThrottleDecision;
  readonly minIntervalMs: number;
  readonly minPriceTicks: number;
}

export interface QuoteRefreshRuntimeInput {
  readonly previousQuote: DispatchedQuoteSnapshot | undefined;
  readonly quote: QuoteSignal;
  readonly book: InternalOrderBook | null;
  readonly nowMs: number;
  readonly lastLogAtMs: number;
  readonly logThrottleMs: number;
  readonly minIntervalMsValue?: string;
  readonly minPriceTicksValue?: string;
  readonly adviseRefresh: (input: {
    readonly previousQuote: DispatchedQuoteSnapshot | null;
    readonly quote: QuoteSignal;
    readonly book: InternalOrderBook | null;
    readonly minPriceTicks: number;
    readonly elapsedMs: number;
    readonly tickSize: number;
  }) => QueueRefreshAdvice;
}

export interface QuoteRefreshRuntimeResult {
  readonly throttle: QuoteRefreshThrottleDecision;
  readonly minIntervalMs: number;
  readonly minPriceTicks: number;
}

export interface QuoteRefreshThrottleSideEffectInput {
  readonly quote: QuoteSignal;
  readonly logKey: string;
  readonly refresh: QuoteRefreshRuntimeResult;
}

export interface QuoteRefreshThrottleSideEffectHandlers {
  readonly markLogAt: (logKey: string, loggedAtMs: number) => void;
  readonly logInfo: (event: string, message: string, metadata: JsonRecord) => void;
}

export function evaluateQuoteRefreshThrottle(
  input: QuoteRefreshThrottleInput
): QuoteRefreshThrottleDecision {
  if (!input.previousQuote || input.advice.shouldRefresh) {
    return {
      shouldThrottle: false,
      shouldLog: false,
      nextLogAtMs: input.lastLogAtMs,
      elapsedMs: 0,
      queuePressure: input.advice.queuePressure,
      queueReason: input.advice.reason
    };
  }

  const quoteObservedAtMs = Date.parse(input.quote.createdAt);
  const elapsedMs = Number.isFinite(quoteObservedAtMs)
    ? quoteObservedAtMs - input.previousQuote.updatedAtMs
    : input.nowMs - input.previousQuote.updatedAtMs;
  const shouldLog = input.nowMs - input.lastLogAtMs >= input.logThrottleMs;

  return {
    shouldThrottle: true,
    shouldLog,
    nextLogAtMs: shouldLog ? input.nowMs : input.lastLogAtMs,
    elapsedMs,
    queuePressure: input.advice.queuePressure,
    queueReason: input.advice.reason
  };
}

export function buildQuoteRefreshRuntimeDecision(
  input: QuoteRefreshRuntimeInput
): QuoteRefreshRuntimeResult {
  const minIntervalMs = readPositiveInteger(
    input.minIntervalMsValue,
    DEFAULT_QUOTE_REFRESH_MIN_INTERVAL_MS,
    0,
    60_000
  );
  const minPriceTicks = readPositiveInteger(
    input.minPriceTicksValue,
    DEFAULT_QUOTE_REFRESH_MIN_PRICE_TICKS,
    0,
    100
  );
  const tickSize = input.book?.tickSize ?? DEFAULT_ORDER_BOOK_TICK_SIZE;
  const quoteObservedAtMs = Date.parse(input.quote.createdAt);
  const elapsedMs =
    input.previousQuote && Number.isFinite(quoteObservedAtMs)
      ? quoteObservedAtMs - input.previousQuote.updatedAtMs
      : input.previousQuote
        ? input.nowMs - input.previousQuote.updatedAtMs
        : 0;
  const advice = input.adviseRefresh({
    previousQuote: input.previousQuote ?? null,
    quote: input.quote,
    book: input.book,
    minPriceTicks,
    elapsedMs,
    tickSize
  });

  return {
    throttle: evaluateQuoteRefreshThrottle({
      previousQuote: input.previousQuote,
      quote: input.quote,
      advice,
      minIntervalMs,
      minPriceTicks,
      nowMs: input.nowMs,
      lastLogAtMs: input.lastLogAtMs,
      logThrottleMs: input.logThrottleMs
    }),
    minIntervalMs,
    minPriceTicks
  };
}

export function quoteRefreshThrottleLogMetadata(input: QuoteRefreshThrottleLogInput): JsonRecord {
  return {
    instrumentCode: input.quote.instrumentCode,
    elapsedMs: input.throttle.elapsedMs,
    minIntervalMs: input.minIntervalMs,
    minPriceTicks: input.minPriceTicks,
    signalId: input.quote.signalId,
    queuePressure: roundMetric(input.throttle.queuePressure, 4),
    queueReason: input.throttle.queueReason
  };
}

export function applyQuoteRefreshThrottleSideEffects(
  input: QuoteRefreshThrottleSideEffectInput,
  handlers: QuoteRefreshThrottleSideEffectHandlers
): void {
  const throttle = input.refresh.throttle;
  if (!throttle.shouldLog) {
    return;
  }

  handlers.markLogAt(input.logKey, throttle.nextLogAtMs);
  handlers.logInfo(
    "QUOTE_REFRESH_THROTTLED",
    "Skipped quote refresh inside minimum cadence window",
    quoteRefreshThrottleLogMetadata({
      quote: input.quote,
      throttle,
      minIntervalMs: input.refresh.minIntervalMs,
      minPriceTicks: input.refresh.minPriceTicks
    })
  );
}

export function dispatchedQuoteSnapshot(
  quote: QuoteSignal,
  fallbackNowMs: number
): DispatchedQuoteSnapshot {
  const observedAtMs = Date.parse(quote.createdAt);
  return {
    bid: quote.orders.find((order) => order.side === "BID")?.price ?? null,
    ask: quote.orders.find((order) => order.side === "ASK")?.price ?? null,
    updatedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : fallbackNowMs
  };
}
