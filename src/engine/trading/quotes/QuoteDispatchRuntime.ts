import type { QuoteOrder, QuoteSignal, TradeIntent } from "../../../types";
import type { QueueRefreshAdvice } from "../../QueuePositionModel";
import { roundCrypto, roundMetric } from "../book/SortedBookSide";

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
