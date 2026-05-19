import type {
  GlobalRiskConfig,
  InternalOrderBook,
  InventoryState,
  ShadowQueueDecision,
  TradeIntent
} from "../../../types";
import {
  DEFAULT_ORDER_BOOK_TICK_SIZE,
  normalizePriceToTick,
  roundCrypto
} from "../book/SortedBookSide";
import { DEFAULT_SHADOW_VLO_MIN_SIZE } from "../../../TradingEngineConstants";

export interface ShadowQueueSizingInput {
  readonly action: "BUY" | "SELL";
  readonly price: number;
  readonly book: InternalOrderBook;
  readonly equity: number;
  readonly maxPositionPct: number;
  readonly kellyFraction: number;
  readonly inventory: InventoryState;
  readonly positionSizeMultiplier: number;
}

export interface ShadowQueueIntentInput {
  readonly decision: ShadowQueueDecision;
  readonly book: InternalOrderBook;
  readonly observedAt: string;
  readonly engineId: string;
  readonly baseSpreadBps: number;
  readonly exchangeFeeBps: number;
  readonly toxicityScore: number;
  readonly requestedSize: number;
  readonly price: number;
}

export function shadowQueuePostOnlyPrice(
  action: "BUY" | "SELL",
  book: InternalOrderBook,
  pnMidPrice: number,
  baseSpreadBps: number
): number {
  const tickSize = Math.max(book.tickSize, DEFAULT_ORDER_BOOK_TICK_SIZE);
  const baseSpread = Math.max(book.spread ?? 0, (pnMidPrice * baseSpreadBps) / 10_000, tickSize);

  if (action === "BUY") {
    const raw = Math.max(tickSize, pnMidPrice - baseSpread);
    const bounded =
      book.bestAsk !== null ? Math.min(raw, Math.max(tickSize, book.bestAsk - tickSize)) : raw;
    return normalizePriceToTick(bounded, tickSize, "FLOOR");
  }

  const raw = pnMidPrice + baseSpread;
  const bounded = book.bestBid !== null ? Math.max(raw, book.bestBid + tickSize) : raw;
  return normalizePriceToTick(bounded, tickSize, "CEIL");
}

export function shadowQueueKellySize(input: ShadowQueueSizingInput): number {
  if (!Number.isFinite(input.price) || input.price <= 0) {
    return 0;
  }

  const equity = Math.max(0, input.equity);
  const inventoryRoom =
    input.action === "BUY"
      ? Math.max(0, input.inventory.maxInventoryUnits - input.inventory.netDelta)
      : Math.max(0, input.inventory.maxInventoryUnits + input.inventory.netDelta);
  const levels = input.action === "BUY" ? input.book.bids : input.book.asks;
  const depthCap = Math.max(DEFAULT_SHADOW_VLO_MIN_SIZE, (levels[0]?.size ?? 0) * 0.02);
  const riskBudgetUsd =
    equity * input.maxPositionPct * input.kellyFraction * input.positionSizeMultiplier;
  const budgetSize = riskBudgetUsd > 0 ? riskBudgetUsd / input.price : 0;
  const bounded = Math.min(Math.max(0, budgetSize), Math.max(0, inventoryRoom), depthCap);

  return bounded > 0 ? roundCrypto(Math.max(DEFAULT_SHADOW_VLO_MIN_SIZE, bounded)) : 0;
}

export function buildShadowQueueTradeIntent(input: ShadowQueueIntentInput): TradeIntent | null {
  const action = input.decision.dispatchSide;

  if (!action || input.book.midPrice === null || input.book.midPrice <= 0) {
    return null;
  }

  if (input.requestedSize <= 0) {
    return null;
  }

  const expectedDriftValue = Math.abs(input.decision.microDrift) * input.requestedSize;
  const feeCost = (input.price * input.requestedSize * Math.max(0, input.exchangeFeeBps)) / 10_000;
  const expectedValue = roundCrypto(expectedDriftValue - feeCost);

  return {
    schemaVersion: "trade-intent.v1",
    intentId: `vlo-intent:${input.decision.decisionId}`,
    traceId: `${input.engineId}:shadow-queue:${input.decision.fillId}`,
    instrumentCode: input.book.instrumentCode,
    marketKey: input.book.marketKey,
    source_exchange: input.book.source_exchange,
    direction: action === "BUY" ? "LONG" : "SHORT",
    action,
    orderType: "LIMIT",
    postOnly: true,
    timeInForce: "ALO",
    intendedPrice: input.price,
    expectedPrice: input.price,
    requestedSize: input.requestedSize,
    approvedSize: input.requestedSize,
    probabilityWin: input.decision.action === "GREEN_LIGHT" ? 0.56 : 0.53,
    probabilityLoss: input.decision.action === "GREEN_LIGHT" ? 0.44 : 0.47,
    profit: expectedDriftValue,
    loss: Math.max(
      expectedDriftValue,
      (input.book.spread ?? input.book.tickSize) * input.requestedSize
    ),
    executionCosts: feeCost,
    adverseSelectionCost: input.decision.action === "RED_LIGHT" ? 0 : input.toxicityScore,
    expectedValue,
    minEvThreshold: Number.NEGATIVE_INFINITY,
    maxSlippageBps: Math.max(1, input.book.spreadBps ?? input.baseSpreadBps),
    confidence: Math.min(
      1,
      Math.max(0.01, Math.abs(input.decision.microDrift) / Math.max(input.book.tickSize, 1e-12))
    ),
    rationale:
      input.decision.action === "GREEN_LIGHT"
        ? `VLO Green Light: post-fill drift confirmed ${input.decision.originalSide}; fractional Kelly post-only deployment.`
        : `VLO Red Light: adverse post-fill drift inverted ${input.decision.originalSide}; AS skew bypassed for signal inversion.`,
    createdAt: input.observedAt
  };
}

export function resolveShadowQueueSizingConfig(input: {
  readonly cachedConfig: GlobalRiskConfig;
  readonly envMaxPositionPct: number;
  readonly envKellyFraction: number;
}): { maxPositionPct: number; kellyFraction: number } {
  const maxPositionPct =
    input.cachedConfig.MAX_POSITION_PCT > 0
      ? input.cachedConfig.MAX_POSITION_PCT
      : input.envMaxPositionPct;
  const kellyFraction = Math.min(
    1,
    Math.max(
      0,
      input.cachedConfig.KELLY_FRACTION > 0
        ? input.cachedConfig.KELLY_FRACTION
        : input.envKellyFraction
    )
  );

  return { maxPositionPct, kellyFraction };
}
