import type { EngineState, JsonRecord, QuoteOrder, QuoteSignal, TradeIntent } from "../../../types";
import { roundCrypto, roundMetric } from "../book/SortedBookSide";
import { isQuoteSuspendedAt } from "../state/AssetStateRuntime";

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

export interface QuoteDispatchSideEffectHandlers {
  readonly logSkippedOrder: (skipped: SkippedQuoteOrder) => void;
  readonly dispatchExecution: (intent: TradeIntent) => Promise<void>;
  readonly rememberDispatchedQuote: (quote: QuoteSignal) => void;
}

export interface QuoteDispatchFlowInput extends QuoteDispatchIntentInput {
  readonly hasExecutioner: boolean;
  readonly tradingEnabled: boolean;
  readonly instrumentSelected: boolean;
  readonly assetRuntimeState: EngineState["assetMatrix"][string] | undefined;
  readonly instrumentQuoteState: EngineState["quoteState"];
}

export interface QuoteDispatchFlowHandlers
  extends QuoteDispatchSideEffectHandlers, QuoteDispatchBlockedSideEffectHandlers {
  readonly shouldThrottleQuoteDispatch: (quote: QuoteSignal) => boolean;
}

export interface QuoteDispatchBlockedLogInput {
  readonly quote: QuoteSignal;
  readonly assetRuntimeState: EngineState["assetMatrix"][string] | undefined;
}

export type QuoteDispatchBlockedSideEffectInput = QuoteDispatchBlockedLogInput;

export interface QuoteDispatchBlockedSideEffectHandlers {
  readonly logInfo: (event: string, message: string, metadata: JsonRecord) => void;
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

export async function applyQuoteDispatchSideEffects(
  quote: QuoteSignal,
  dispatch: QuoteDispatchIntentResult,
  handlers: QuoteDispatchSideEffectHandlers
): Promise<void> {
  for (const skipped of dispatch.skippedOrders) {
    handlers.logSkippedOrder(skipped);
  }

  for (const intent of dispatch.intents) {
    await handlers.dispatchExecution(intent);
  }

  if (dispatch.intents.length > 0) {
    handlers.rememberDispatchedQuote(quote);
  }
}

export async function applyQuoteDispatchFlow(
  input: QuoteDispatchFlowInput,
  handlers: QuoteDispatchFlowHandlers
): Promise<boolean> {
  if (!input.hasExecutioner || !input.tradingEnabled) {
    return false;
  }

  if (!input.instrumentSelected || input.assetRuntimeState?.quoteEligible === false) {
    applyQuoteDispatchBlockedSideEffects(
      {
        quote: input.quote,
        assetRuntimeState: input.assetRuntimeState
      },
      handlers
    );
    return false;
  }

  if (
    isQuoteSuspendedAt(input.instrumentQuoteState, input.quote.createdAt) ||
    handlers.shouldThrottleQuoteDispatch(input.quote)
  ) {
    return false;
  }

  const dispatch = buildQuoteDispatchIntents(input);
  await applyQuoteDispatchSideEffects(input.quote, dispatch, handlers);

  return dispatch.intents.length > 0;
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

export function applyQuoteDispatchBlockedSideEffects(
  input: QuoteDispatchBlockedSideEffectInput,
  handlers: QuoteDispatchBlockedSideEffectHandlers
): void {
  handlers.logInfo(
    "QUOTE_DISPATCH_BLOCKED",
    "Skipped quote for inactive Moltworker asset",
    quoteDispatchBlockedLogMetadata(input)
  );
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
