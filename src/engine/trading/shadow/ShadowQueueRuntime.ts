import type {
  GlobalRiskConfig,
  InternalOrderBook,
  InventoryState,
  MarketTick,
  ShadowQueueFill,
  ShadowQueueDecision,
  TradeExecution,
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

export interface ShadowQueueTickGateInput {
  readonly book: InternalOrderBook;
  readonly shadowReplay?: boolean;
}

export interface ShadowQueueGhostFillRecordInput {
  readonly fill: ShadowQueueFill;
  readonly tick: MarketTick;
  readonly book: InternalOrderBook;
  readonly observedAt: string;
  readonly participationRate: number;
  readonly adverseBps: number;
  readonly makerFeeBps: number;
  readonly fillModelSource: string;
  readonly paperFillPrice: number;
  readonly paperSizeCap: number;
  readonly executablePaperSize: number;
}

export interface ShadowQueueGhostFillRecord {
  readonly eventPayload: Record<string, unknown>;
  readonly trade: TradeExecution | null;
}

export interface ShadowQueueNoEdgeThrottleInput {
  readonly lastLoggedAtByInstrument: Map<string, number>;
  readonly instrumentCode: string;
  readonly nowMs: number;
  readonly intervalMs: number;
}

export function shouldProcessShadowQueueTick(input: ShadowQueueTickGateInput): boolean {
  return (
    !input.shadowReplay &&
    input.book.isSynced &&
    input.book.midPrice !== null &&
    input.book.midPrice > 0
  );
}

export function buildShadowQueueGhostFillRecord(
  input: ShadowQueueGhostFillRecordInput
): ShadowQueueGhostFillRecord {
  if (input.executablePaperSize <= 0) {
    return {
      trade: null,
      eventPayload: {
        fillId: input.fill.fillId,
        instrumentCode: input.fill.instrumentCode,
        side: input.fill.side,
        price: input.paperFillPrice,
        virtualQueueSize: input.fill.size,
        paperExecutionSize: 0,
        reason: "PAPER_RISK_CAP_ZERO",
        participationRate: input.participationRate,
        adverseBps: input.adverseBps,
        observedAt: input.observedAt
      }
    };
  }

  const fees = roundCrypto(
    (input.paperFillPrice * input.executablePaperSize * input.makerFeeBps) / 10_000
  );
  const trade: TradeExecution = {
    tradeId: `shadow-queue:${input.fill.fillId}:${Date.parse(input.observedAt) || input.observedAt}`,
    orderId: input.fill.fillId,
    signalId: input.fill.fillId,
    venue: input.book.source_exchange,
    asset: input.fill.instrumentCode,
    side: input.fill.side,
    orderType: "LIMIT",
    price: input.paperFillPrice,
    size: input.executablePaperSize,
    evAtExecution: 0,
    slippageBps: input.adverseBps,
    resultingPnl: 0,
    primaryDriver: "PROFILER",
    fees,
    status: "GHOST_FILL",
    exchangeTradeId: input.fill.fillId,
    metadata: {
      schemaVersion: "shadow-queue.fill.v1",
      paperSizer: "shadowQueueKellySize",
      fillModel: "risk_capped_participation_with_bootstrapped_adverse_selection",
      fillModelSource: input.fillModelSource,
      virtualQueueSize: input.fill.size,
      paperExecutionSize: input.executablePaperSize,
      paperSizeCap: input.paperSizeCap,
      participationRate: input.participationRate,
      adverseBps: input.adverseBps,
      makerFeeBps: input.makerFeeBps,
      originalVirtualPrice: input.fill.price,
      paperFillPrice: input.paperFillPrice,
      sizeCapped: input.executablePaperSize < input.fill.size,
      queueAhead: input.fill.queueAhead,
      p0MidPrice: input.fill.p0MidPrice,
      tapePrice: input.tick.price,
      tapeSize: input.tick.size,
      tapeSide: input.tick.side,
      fillTradeSequence: input.fill.fillTradeSequence,
      marketKey: input.book.marketKey,
      source_exchange: input.book.source_exchange,
      virtualOnly: true
    },
    executedAt: input.observedAt
  };

  return {
    trade,
    eventPayload: trade as unknown as Record<string, unknown>
  };
}

export function shouldLogShadowQueueNoEdge(input: ShadowQueueNoEdgeThrottleInput): boolean {
  const previous = input.lastLoggedAtByInstrument.get(input.instrumentCode) ?? 0;

  if (input.nowMs - previous < input.intervalMs) {
    return false;
  }

  input.lastLoggedAtByInstrument.set(input.instrumentCode, input.nowMs);
  return true;
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
