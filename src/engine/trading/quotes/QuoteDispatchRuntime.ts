import type {
  EngineState,
  InternalOrderBook,
  JsonRecord,
  QuoteOrder,
  QuoteSignal,
  TradeIntent
} from "../../../types";
import type { QueueRefreshAdvice } from "../../QueuePositionModel";
import { DEFAULT_ORDER_BOOK_TICK_SIZE, roundCrypto, roundMetric } from "../book/SortedBookSide";
import { quoteToTelemetry } from "../execution/ExecutionRuntimeHelpers";
import {
  DEFAULT_QUOTE_REFRESH_MIN_INTERVAL_MS,
  DEFAULT_QUOTE_REFRESH_MIN_PRICE_TICKS
} from "../../../TradingEngineConstants";
import { readPositiveInteger } from "../helpers/RuntimeParsing";

export interface QuoteDispatchIntentInput {
  readonly quote: QuoteSignal;
  readonly engineId: string;
  readonly bankrollEquity: number;
  readonly bankrollCash: number;
  readonly maxPositionPct: number;
  readonly maxPositionSize: number;
  readonly assetAllocationPct: number;
  readonly positionSizeMultiplier: number;
  readonly fallbackSourceExchange: string | null;
  readonly spreadBps: number | null;
  readonly toxicityScore: number;
}

export interface SkippedQuoteOrder {
  readonly quoteSignalId: string;
  readonly instrumentCode: string;
  readonly side: TradeIntent["action"];
  readonly requestedSize: number;
  readonly price: number;
  readonly maxOrderNotional: number;
}

export interface QuoteDispatchIntentResult {
  readonly intents: TradeIntent[];
  readonly skippedOrders: SkippedQuoteOrder[];
  readonly maxOrderNotional: number;
}

export interface QuoteDispatchBlockedLogInput {
  readonly quote: QuoteSignal;
  readonly assetRuntimeState: EngineState["assetMatrix"][string] | undefined;
}

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

export interface CroupierQuoteActionInput {
  readonly instrumentCode: string;
  readonly pullAllQuotes: boolean;
  readonly quote: QuoteSignal | null;
  readonly strategyQuoteDisableReason: string | null;
  readonly adverseSelectionCost: number;
  readonly minEvThreshold: number;
  readonly shadowReplay: boolean;
  readonly tradingEnabled: boolean;
  readonly profilerQuoteHalt: boolean;
  readonly cascadeShield: boolean;
}

export type CroupierQuoteAction =
  | {
      readonly kind: "PULL_ALL_QUOTES";
      readonly publish: {
        readonly type: "PULL_ALL_QUOTES";
        readonly payload: Record<string, unknown>;
      };
      readonly cancelReason: "ADVERSE_SELECTION_CRITICAL" | null;
    }
  | {
      readonly kind: "POST_QUOTE";
      readonly quote: QuoteSignal;
      readonly publish: {
        readonly type: "POST_QUOTE";
        readonly payload: Record<string, unknown>;
        readonly correlationId: string;
      };
      readonly shouldDispatch: boolean;
      readonly cascadeShieldCancelReason: "CASCADE_SHIELD" | null;
    }
  | {
      readonly kind: "NONE";
    };

export interface CroupierQuoteActionSideEffectHandlers {
  readonly publish: (
    type: string,
    payload: Record<string, unknown>,
    correlationId?: string
  ) => void;
  readonly schedule: (work: Promise<void>) => void;
  readonly cancelAllQuotes: (instrumentCode: string, reason: string) => Promise<void>;
  readonly dispatchQuote: (quote: QuoteSignal) => Promise<void>;
}

export function buildQuoteDispatchIntents(
  input: QuoteDispatchIntentInput
): QuoteDispatchIntentResult {
  const bankroll = Math.max(0, input.bankrollEquity, input.bankrollCash);
  const maxBudgetFromPct =
    bankroll *
    Math.max(0, input.maxPositionPct) *
    Math.min(1, Math.max(0, input.assetAllocationPct)) *
    Math.max(0, input.positionSizeMultiplier);
  const maxBudgetFromConfig =
    input.maxPositionSize > 0
      ? input.maxPositionSize * Math.max(0, input.positionSizeMultiplier)
      : Number.POSITIVE_INFINITY;
  const maxOrderNotional = Math.min(maxBudgetFromConfig, maxBudgetFromPct);
  const intents: TradeIntent[] = [];
  const skippedOrders: SkippedQuoteOrder[] = [];

  for (const order of input.quote.orders) {
    const action = quoteOrderAction(order);
    const maxSize =
      Number.isFinite(maxOrderNotional) && order.price > 0
        ? maxOrderNotional / order.price
        : order.size;
    const approvedSize = roundCrypto(Math.min(order.size, Math.max(0, maxSize)));

    if (approvedSize <= 0) {
      skippedOrders.push({
        quoteSignalId: input.quote.signalId,
        instrumentCode: input.quote.instrumentCode,
        side: action,
        requestedSize: order.size,
        price: order.price,
        maxOrderNotional
      });
      continue;
    }

    intents.push({
      schemaVersion: "trade-intent.v1",
      intentId: order.clientOrderId,
      traceId: `${input.engineId}:quote:${input.quote.signalId}:${order.clientOrderId}`,
      instrumentCode: input.quote.instrumentCode,
      marketKey: input.quote.marketKey,
      source_exchange: input.quote.marketKey?.split(":")[0] ?? input.fallbackSourceExchange,
      direction: action === "BUY" ? "LONG" : "SHORT",
      action,
      orderType: "LIMIT",
      postOnly: order.postOnly,
      timeInForce: "ALO",
      intendedPrice: order.price,
      expectedPrice: order.price,
      requestedSize: order.size,
      approvedSize,
      probabilityWin: 0.5,
      probabilityLoss: 0.5,
      profit: 0,
      loss: 0,
      executionCosts: 0,
      adverseSelectionCost: 0,
      expectedValue: 0,
      minEvThreshold: Number.NEGATIVE_INFINITY,
      maxSlippageBps: Math.max(1, input.spreadBps ?? 1),
      confidence: Math.max(0, 1 - input.toxicityScore),
      rationale: quoteOrderRationale(order, input.quote.signalId, approvedSize),
      createdAt: input.quote.createdAt
    });
  }

  return { intents, skippedOrders, maxOrderNotional };
}

export function quoteDispatchBlockedLogMetadata(input: QuoteDispatchBlockedLogInput): JsonRecord {
  return {
    quoteSignalId: input.quote.signalId,
    instrumentCode: input.quote.instrumentCode,
    selectedByMoltworker: input.assetRuntimeState?.selectedByMoltworker ?? null,
    quoteEligible: input.assetRuntimeState?.quoteEligible ?? null,
    reason: input.assetRuntimeState?.quoteReason ?? "MOLTWORKER_NOT_SELECTED"
  };
}

export function buildCroupierQuoteAction(input: CroupierQuoteActionInput): CroupierQuoteAction {
  if (input.pullAllQuotes) {
    return {
      kind: "PULL_ALL_QUOTES",
      publish: {
        type: "PULL_ALL_QUOTES",
        payload: {
          instrumentCode: input.instrumentCode,
          adverseSelectionCost: input.adverseSelectionCost,
          minEvThreshold: input.minEvThreshold
        }
      },
      cancelReason:
        !input.shadowReplay && input.tradingEnabled ? "ADVERSE_SELECTION_CRITICAL" : null
    };
  }

  if (!input.quote || input.strategyQuoteDisableReason) {
    return { kind: "NONE" };
  }

  return {
    kind: "POST_QUOTE",
    quote: input.quote,
    publish: {
      type: "POST_QUOTE",
      payload: quoteToTelemetry(input.quote),
      correlationId: input.quote.signalId
    },
    shouldDispatch: !input.shadowReplay && input.tradingEnabled && !input.profilerQuoteHalt,
    cascadeShieldCancelReason: input.cascadeShield ? "CASCADE_SHIELD" : null
  };
}

export function dispatchCroupierQuoteActionSideEffects(
  instrumentCode: string,
  action: CroupierQuoteAction,
  handlers: CroupierQuoteActionSideEffectHandlers
): void {
  if (action.kind === "PULL_ALL_QUOTES") {
    handlers.publish(action.publish.type, action.publish.payload);
    if (action.cancelReason) {
      handlers.schedule(handlers.cancelAllQuotes(instrumentCode, action.cancelReason));
    }
    return;
  }

  if (action.kind !== "POST_QUOTE") {
    return;
  }

  handlers.publish(action.publish.type, action.publish.payload, action.publish.correlationId);

  if (!action.shouldDispatch) {
    return;
  }

  handlers.schedule(
    action.cascadeShieldCancelReason
      ? handlers
          .cancelAllQuotes(instrumentCode, action.cascadeShieldCancelReason)
          .then(() => handlers.dispatchQuote(action.quote))
      : handlers.dispatchQuote(action.quote)
  );
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

function quoteOrderAction(order: QuoteOrder): TradeIntent["action"] {
  return order.side === "BID" ? "BUY" : "SELL";
}

function quoteOrderRationale(order: QuoteOrder, signalId: string, approvedSize: number): string {
  return order.strategy === "LIQUIDATION_ABSORPTION"
    ? `Post-only liquidation absorption quote from signal ${signalId}; cluster ${order.clusterId ?? "unknown"}`
    : `AMM quote child order from signal ${signalId}; risk-capped notional=${roundMetric(
        approvedSize * order.price,
        8
      )}`;
}
