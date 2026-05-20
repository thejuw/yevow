import type {
  GlobalRiskConfig,
  InternalOrderBook,
  InventoryState,
  JsonRecord,
  Position,
  TradeIntent
} from "../../../types";
import {
  DEFAULT_MAX_INVENTORY_DELTA,
  DEFAULT_MAX_INVENTORY_UNITS,
  DEFAULT_RISK_AVERSION_FACTOR
} from "../../../TradingEngineConstants";
import {
  DEFAULT_ORDER_BOOK_TICK_SIZE,
  normalizePriceToTick,
  roundCrypto,
  roundMetric
} from "../book/SortedBookSide";
import { readPositiveNumber } from "../helpers/RuntimeParsing";

export interface InventoryStateInput {
  readonly positions: Record<string, Position>;
  readonly observedAt: string;
  readonly maxInventoryUnits: number;
  readonly maxInventoryDelta: number;
  readonly riskAversionFactor: number;
  readonly baseAsset: string;
  readonly baseReferencePrice: number;
  readonly configuredWeights: Record<string, number>;
  readonly markPrice: (instrumentCode: string, fallback: number) => number;
}

export interface InventoryStateConfigInput {
  readonly config: Pick<
    GlobalRiskConfig,
    "MAX_INVENTORY_UNITS" | "MAX_INVENTORY_DELTA" | "RISK_AVERSION_FACTOR"
  >;
  readonly maxInventoryUnitsValue?: string;
  readonly maxInventoryDeltaValue?: string;
  readonly riskAversionFactorValue?: string;
}

export interface InventoryStateConfig {
  readonly maxInventoryUnits: number;
  readonly maxInventoryDelta: number;
  readonly riskAversionFactor: number;
}

export interface BaseAssetReferencePriceInput {
  readonly baseAsset: string;
  readonly orderBooks: Iterable<InternalOrderBook>;
  readonly positions: Record<string, Position>;
  readonly microstructureMidPrice: number | null;
}

export interface InventoryHedgeIntentInput {
  readonly book: InternalOrderBook;
  readonly inventory: InventoryState;
  readonly observedAt: string;
  readonly engineId: string;
  readonly config: Pick<
    GlobalRiskConfig,
    | "HEDGE_ENABLED"
    | "MAX_INVENTORY_DELTA"
    | "HEDGE_TRIGGER_INVENTORY_PCT"
    | "HEDGE_COOLDOWN_MS"
    | "HEDGE_MAX_SLIPPAGE_BPS"
    | "EXCHANGE_FEE_BPS"
  >;
  readonly lastHedgeAtMs: number;
  readonly fallbackNowMs: number;
}

export interface InventoryHedgeIntentResult {
  readonly intent: TradeIntent;
  readonly dispatchedAtMs: number;
}

export interface InventoryHedgeAuthorizedLogInput {
  readonly intent: TradeIntent;
  readonly inventory: Pick<InventoryState, "current_inventory_delta">;
  readonly triggerPct: number;
}

export function calculateInventoryState(input: InventoryStateInput): InventoryState {
  const normalized = normalizeInventoryDelta(input);
  const netDelta = Object.values(input.positions).reduce(
    (sum, position) => sum + (position.side === "LONG" ? position.quantity : -position.quantity),
    0
  );
  const inventoryPenalty = Math.abs(normalized.current_inventory_delta) * input.riskAversionFactor;
  const stopBid =
    netDelta >= input.maxInventoryUnits ||
    (input.maxInventoryDelta > 0 && normalized.current_inventory_delta >= input.maxInventoryDelta);
  const stopAsk =
    netDelta <= -input.maxInventoryUnits ||
    (input.maxInventoryDelta > 0 && normalized.current_inventory_delta <= -input.maxInventoryDelta);

  return {
    netDelta,
    current_inventory_delta: normalized.current_inventory_delta,
    baseAsset: normalized.baseAsset,
    normalization: normalized.normalization,
    maxInventoryUnits: input.maxInventoryUnits,
    maxInventoryDelta: input.maxInventoryDelta,
    inventoryPenalty,
    stopBid,
    stopAsk,
    updatedAt: input.observedAt
  };
}

export function resolveInventoryStateConfig(
  input: InventoryStateConfigInput
): InventoryStateConfig {
  return {
    maxInventoryUnits:
      input.config.MAX_INVENTORY_UNITS > 0
        ? input.config.MAX_INVENTORY_UNITS
        : readPositiveNumber(input.maxInventoryUnitsValue, DEFAULT_MAX_INVENTORY_UNITS),
    maxInventoryDelta:
      input.config.MAX_INVENTORY_DELTA > 0
        ? input.config.MAX_INVENTORY_DELTA
        : readPositiveNumber(input.maxInventoryDeltaValue, DEFAULT_MAX_INVENTORY_DELTA),
    riskAversionFactor:
      input.config.RISK_AVERSION_FACTOR > 0
        ? input.config.RISK_AVERSION_FACTOR
        : readPositiveNumber(input.riskAversionFactorValue, DEFAULT_RISK_AVERSION_FACTOR)
  };
}

export function referencePriceForBaseAsset(input: BaseAssetReferencePriceInput): number {
  const normalizedBase = input.baseAsset.toLowerCase();

  for (const book of input.orderBooks) {
    if (book.instrumentCode.split("-")[0] === normalizedBase && book.midPrice !== null) {
      return book.midPrice;
    }
  }

  const directPosition = input.positions[`${normalizedBase}-usd`];
  if (directPosition?.markPrice) {
    return directPosition.markPrice;
  }

  const microMid = input.microstructureMidPrice;
  return typeof microMid === "number" && Number.isFinite(microMid) && microMid > 0 ? microMid : 1;
}

export function buildInventoryHedgeIntent(
  input: InventoryHedgeIntentInput
): InventoryHedgeIntentResult | null {
  const { book, config, inventory } = input;

  if (!config.HEDGE_ENABLED || !book.midPrice || book.midPrice <= 0) {
    return null;
  }

  const maxDelta = Math.max(inventory.maxInventoryDelta, config.MAX_INVENTORY_DELTA, 0);
  if (maxDelta <= 0) {
    return null;
  }

  const currentDelta = inventory.current_inventory_delta;
  const triggerDelta = maxDelta * config.HEDGE_TRIGGER_INVENTORY_PCT;
  if (Math.abs(currentDelta) < triggerDelta) {
    return null;
  }

  const observedAtMs = Date.parse(input.observedAt);
  const safeNowMs = Number.isFinite(observedAtMs) ? observedAtMs : input.fallbackNowMs;
  if (safeNowMs - input.lastHedgeAtMs < config.HEDGE_COOLDOWN_MS) {
    return null;
  }

  const action: TradeIntent["action"] = currentDelta > 0 ? "SELL" : "BUY";
  const touch = action === "SELL" ? book.bestBid : book.bestAsk;
  if (!touch || touch <= 0) {
    return null;
  }

  const targetResidual = maxDelta * 0.4 * Math.sign(currentDelta);
  const hedgeSize = roundCrypto(
    Math.min(Math.abs(currentDelta - targetResidual), Math.abs(currentDelta))
  );
  if (hedgeSize <= 0) {
    return null;
  }

  const hedgeMaxSlippageBps = Math.max(0, config.HEDGE_MAX_SLIPPAGE_BPS);
  const slippage = hedgeMaxSlippageBps / 10_000;
  const rawPrice = action === "BUY" ? touch * (1 + slippage) : touch * (1 - slippage);
  const expectedPrice = normalizePriceToTick(
    Math.max(book.tickSize, rawPrice),
    Math.max(book.tickSize, DEFAULT_ORDER_BOOK_TICK_SIZE),
    action === "BUY" ? "CEIL" : "FLOOR"
  );

  return {
    dispatchedAtMs: safeNowMs,
    intent: {
      schemaVersion: "trade-intent.v1",
      intentId: `inventory-hedge:${book.instrumentCode}:${safeNowMs}`,
      traceId: `${input.engineId}:inventory-hedge:${book.instrumentCode}:${safeNowMs}`,
      instrumentCode: book.instrumentCode,
      marketKey: book.marketKey,
      source_exchange: book.source_exchange,
      direction: action === "BUY" ? "LONG" : "SHORT",
      action,
      orderType: "IOC",
      postOnly: false,
      timeInForce: "IOC",
      intendedPrice: expectedPrice,
      expectedPrice,
      requestedSize: hedgeSize,
      approvedSize: hedgeSize,
      probabilityWin: 0.5,
      probabilityLoss: 0.5,
      profit: 0,
      loss: (book.midPrice * hedgeSize * hedgeMaxSlippageBps) / 10_000,
      executionCosts:
        (book.midPrice * hedgeSize * (config.EXCHANGE_FEE_BPS + hedgeMaxSlippageBps)) / 10_000,
      adverseSelectionCost: 0,
      expectedValue: 0,
      minEvThreshold: Number.NEGATIVE_INFINITY,
      maxSlippageBps: config.HEDGE_MAX_SLIPPAGE_BPS,
      confidence: Math.min(1, Math.abs(currentDelta) / maxDelta),
      rationale:
        `INVENTORY_HEDGE reduce-only IOC limit; currentDelta=${roundMetric(currentDelta, 8)} ` +
        `maxDelta=${roundMetric(maxDelta, 8)} triggerPct=${roundMetric(config.HEDGE_TRIGGER_INVENTORY_PCT, 4)}`,
      createdAt: input.observedAt
    }
  };
}

export function inventoryHedgeAuthorizedLogMetadata(
  input: InventoryHedgeAuthorizedLogInput
): JsonRecord {
  return {
    intentId: input.intent.intentId,
    instrumentCode: input.intent.instrumentCode,
    action: input.intent.action,
    approvedSize: input.intent.approvedSize,
    expectedPrice: input.intent.expectedPrice,
    currentInventoryDelta: input.inventory.current_inventory_delta,
    triggerPct: input.triggerPct
  };
}

export function normalizeInventoryDelta(
  input: Pick<
    InventoryStateInput,
    "positions" | "baseAsset" | "baseReferencePrice" | "configuredWeights" | "markPrice"
  >
): Pick<InventoryState, "current_inventory_delta" | "baseAsset" | "normalization"> {
  const normalization: Record<string, number> = {};
  let currentInventoryDelta = 0;

  for (const position of Object.values(input.positions)) {
    const signedQuantity = position.side === "LONG" ? position.quantity : -position.quantity;
    const instrumentCode = position.instrumentCode.toLowerCase();
    const markPrice = input.markPrice(instrumentCode, position.markPrice);
    const configuredWeight = input.configuredWeights[instrumentCode];
    const inferredWeight =
      input.baseReferencePrice > 0 && markPrice > 0 ? markPrice / input.baseReferencePrice : 1;
    const weight =
      typeof configuredWeight === "number" && Number.isFinite(configuredWeight)
        ? configuredWeight
        : inferredWeight;

    normalization[instrumentCode] = roundMetric(weight, 8);
    currentInventoryDelta += signedQuantity * weight;
  }

  return {
    current_inventory_delta: roundCrypto(currentInventoryDelta),
    baseAsset: input.baseAsset,
    normalization
  };
}
