import type { JsonRecord } from "./types";

export type PaperLedgerSide = "LONG" | "SHORT";
export type PaperLedgerEventType = "ENTRY" | "INCREASE" | "REDUCE" | "EXIT" | "FLIP";

export interface PaperLedgerFillInput {
  tradeId: string;
  orderId: string;
  asset: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  notional: number;
  fees: number;
  status: "GHOST_FILL";
  primaryDriver: string | null;
  rawExecution: JsonRecord;
  executedAt: string;
  createdAt: string;
}

export interface PaperLedgerFill {
  tradeId: string;
  orderId: string;
  asset: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  notional: number;
  fees: number;
  executedAt: string;
}

export interface PaperLedgerEvent {
  eventId: string;
  type: PaperLedgerEventType;
  asset: string;
  side: PaperLedgerSide;
  fillTradeId: string;
  entryTradeId: string | null;
  quantity: number;
  entryPrice: number | null;
  exitPrice: number | null;
  grossPnl: number;
  fees: number;
  realizedPnl: number;
  positionQuantityAfter: number;
  averageEntryPriceAfter: number | null;
  openedAt: string | null;
  executedAt: string;
}

export interface PaperLedgerLot {
  lotId: string;
  asset: string;
  side: PaperLedgerSide;
  quantity: number;
  averageEntryPrice: number;
  entryFeesRemaining: number;
  openedAt: string;
  sourceTradeId: string;
}

export interface PaperLedgerPosition {
  asset: string;
  side: PaperLedgerSide;
  quantity: number;
  averageEntryPrice: number;
  openNotional: number;
  entryFeesRemaining: number;
  lotCount: number;
  openedAt: string;
  updatedAt: string;
  lots: PaperLedgerLot[];
}

export interface PaperLedgerAssetSummary {
  asset: string;
  fillCount: number;
  buyCount: number;
  sellCount: number;
  entryCount: number;
  exitCount: number;
  buySize: number;
  sellSize: number;
  realizedGrossPnl: number;
  realizedNetPnl: number;
  totalFees: number;
  openQuantity: number;
  openSide: PaperLedgerSide | null;
  averageEntryPrice: number | null;
  openedAt: string | null;
  updatedAt: string | null;
}

export interface PaperLedger {
  schemaVersion: "paper-ledger.v1";
  mode: "FIFO_AVERAGE_COST";
  generatedAt: string;
  fills: PaperLedgerFill[];
  events: PaperLedgerEvent[];
  positions: PaperLedgerPosition[];
  assets: PaperLedgerAssetSummary[];
  summary: {
    fillCount: number;
    entryCount: number;
    exitCount: number;
    openPositionCount: number;
    realizedGrossPnl: number;
    realizedNetPnl: number;
    totalFees: number;
    openFees: number;
    grossNotional: number;
  };
}

interface MutableLot {
  lotId: string;
  asset: string;
  side: PaperLedgerSide;
  remainingSize: number;
  entryPrice: number;
  entryFeesRemaining: number;
  openedAt: string;
  sourceTradeId: string;
}

interface MutableAssetSummary {
  asset: string;
  fillCount: number;
  buyCount: number;
  sellCount: number;
  entryCount: number;
  exitCount: number;
  buySize: number;
  sellSize: number;
  realizedGrossPnl: number;
  realizedNetPnl: number;
  totalFees: number;
  updatedAt: string | null;
}

const EPSILON = 1e-10;

export function buildPaperLedger(rawFills: readonly PaperLedgerFillInput[]): PaperLedger {
  const fills = [...rawFills]
    .filter(isValidFill)
    .sort((left, right) => compareFillTime(left, right))
    .map(normalizeFill);
  const openLots = new Map<string, MutableLot[]>();
  const summaries = new Map<string, MutableAssetSummary>();
  const events: PaperLedgerEvent[] = [];
  let grossNotional = 0;
  let totalFees = 0;

  for (const fill of fills) {
    const asset = normalizeAsset(fill.asset);
    const summary = summaryFor(summaries, asset);
    const fillSide = fill.side === "BUY" ? "LONG" : "SHORT";
    const closeSide = fill.side === "BUY" ? "SHORT" : "LONG";
    const lots = openLots.get(asset) ?? [];
    const hadOppositeLots = lots.some((lot) => lot.side === closeSide);
    const hadSameSideLots = lots.some((lot) => lot.side === fillSide);
    const fillFee = nonNegative(fill.fees);
    const originalSize = positive(fill.size);
    let remainingSize = originalSize;
    let closeIndex = 0;

    summary.fillCount += 1;
    summary.buyCount += fill.side === "BUY" ? 1 : 0;
    summary.sellCount += fill.side === "SELL" ? 1 : 0;
    summary.buySize += fill.side === "BUY" ? fill.size : 0;
    summary.sellSize += fill.side === "SELL" ? fill.size : 0;
    summary.totalFees += fillFee;
    summary.updatedAt = fill.executedAt;
    grossNotional += fill.notional;
    totalFees += fillFee;

    while (remainingSize > EPSILON) {
      const lotIndex = lots.findIndex((lot) => lot.side === closeSide && lot.remainingSize > EPSILON);

      if (lotIndex === -1) {
        break;
      }

      const lot = lots[lotIndex];
      const lotSizeBeforeClose = lot.remainingSize;
      const closeSize = Math.min(remainingSize, lot.remainingSize);
      const entryFeeAllocated = (lot.entryFeesRemaining * closeSize) / lotSizeBeforeClose;
      const exitFeeAllocated = (fillFee * closeSize) / originalSize;
      const grossPnl =
        lot.side === "LONG"
          ? (fill.price - lot.entryPrice) * closeSize
          : (lot.entryPrice - fill.price) * closeSize;
      const realizedPnl = grossPnl - entryFeeAllocated - exitFeeAllocated;

      lot.remainingSize = roundCrypto(lot.remainingSize - closeSize);
      lot.entryFeesRemaining = roundCrypto(lot.entryFeesRemaining - entryFeeAllocated);
      remainingSize = roundCrypto(remainingSize - closeSize);

      if (lot.remainingSize <= EPSILON) {
        lots.splice(lotIndex, 1);
      }

      summary.exitCount += 1;
      summary.realizedGrossPnl += grossPnl;
      summary.realizedNetPnl += realizedPnl;

      events.push({
        eventId: `${fill.tradeId}:close:${closeIndex}`,
        type: lot.remainingSize <= EPSILON ? "EXIT" : "REDUCE",
        asset,
        side: lot.side,
        fillTradeId: fill.tradeId,
        entryTradeId: lot.sourceTradeId,
        quantity: roundCrypto(closeSize),
        entryPrice: roundCrypto(lot.entryPrice),
        exitPrice: roundCrypto(fill.price),
        grossPnl: roundCrypto(grossPnl),
        fees: roundCrypto(entryFeeAllocated + exitFeeAllocated),
        realizedPnl: roundCrypto(realizedPnl),
        positionQuantityAfter: roundCrypto(positionQuantity(lots, lot.side)),
        averageEntryPriceAfter: averageEntryPrice(lots, lot.side),
        openedAt: lot.openedAt,
        executedAt: fill.executedAt
      });
      closeIndex += 1;
    }

    if (remainingSize > EPSILON) {
      const openingFee = (fillFee * remainingSize) / originalSize;
      const type: PaperLedgerEventType = hadOppositeLots
        ? "FLIP"
        : hadSameSideLots
          ? "INCREASE"
          : "ENTRY";
      const lot: MutableLot = {
        lotId: `${fill.tradeId}:lot:${events.length}`,
        asset,
        side: fillSide,
        remainingSize: roundCrypto(remainingSize),
        entryPrice: roundCrypto(fill.price),
        entryFeesRemaining: roundCrypto(openingFee),
        openedAt: fill.executedAt,
        sourceTradeId: fill.tradeId
      };

      lots.push(lot);
      summary.entryCount += 1;

      events.push({
        eventId: `${fill.tradeId}:open`,
        type,
        asset,
        side: fillSide,
        fillTradeId: fill.tradeId,
        entryTradeId: fill.tradeId,
        quantity: lot.remainingSize,
        entryPrice: lot.entryPrice,
        exitPrice: null,
        grossPnl: 0,
        fees: lot.entryFeesRemaining,
        realizedPnl: 0,
        positionQuantityAfter: roundCrypto(positionQuantity(lots, fillSide)),
        averageEntryPriceAfter: averageEntryPrice(lots, fillSide),
        openedAt: fill.executedAt,
        executedAt: fill.executedAt
      });
    }

    openLots.set(asset, lots);
  }

  const positions = [...openLots.entries()]
    .flatMap(([asset, lots]) => positionFromLots(asset, lots))
    .sort((left, right) => left.asset.localeCompare(right.asset));
  const assets = [...summaries.values()]
    .map((summary) => assetSummary(summary, positions.find((position) => position.asset === summary.asset)))
    .sort((left, right) => left.asset.localeCompare(right.asset));
  const realizedGrossPnl = assets.reduce((sum, asset) => sum + asset.realizedGrossPnl, 0);
  const realizedNetPnl = assets.reduce((sum, asset) => sum + asset.realizedNetPnl, 0);
  const openFees = positions.reduce((sum, position) => sum + position.entryFeesRemaining, 0);

  return {
    schemaVersion: "paper-ledger.v1",
    mode: "FIFO_AVERAGE_COST",
    generatedAt: new Date().toISOString(),
    fills,
    events,
    positions,
    assets,
    summary: {
      fillCount: fills.length,
      entryCount: events.filter((event) => isEntryEvent(event.type)).length,
      exitCount: events.filter((event) => event.type === "REDUCE" || event.type === "EXIT").length,
      openPositionCount: positions.length,
      realizedGrossPnl: roundCrypto(realizedGrossPnl),
      realizedNetPnl: roundCrypto(realizedNetPnl),
      totalFees: roundCrypto(totalFees),
      openFees: roundCrypto(openFees),
      grossNotional: roundCrypto(grossNotional)
    }
  };
}

function normalizeFill(fill: PaperLedgerFillInput): PaperLedgerFill {
  return {
    tradeId: fill.tradeId,
    orderId: fill.orderId,
    asset: normalizeAsset(fill.asset),
    side: fill.side,
    price: roundCrypto(fill.price),
    size: roundCrypto(fill.size),
    notional: roundCrypto(fill.notional || fill.price * fill.size),
    fees: roundCrypto(nonNegative(fill.fees)),
    executedAt: fill.executedAt
  };
}

function isValidFill(fill: PaperLedgerFillInput): boolean {
  return (
    fill.status === "GHOST_FILL" &&
    typeof fill.tradeId === "string" &&
    fill.tradeId.length > 0 &&
    (fill.side === "BUY" || fill.side === "SELL") &&
    positive(fill.price) > 0 &&
    positive(fill.size) > 0
  );
}

function compareFillTime(left: PaperLedgerFillInput, right: PaperLedgerFillInput): number {
  const executedDelta = Date.parse(left.executedAt) - Date.parse(right.executedAt);

  if (executedDelta !== 0) {
    return executedDelta;
  }

  const createdDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);

  if (createdDelta !== 0) {
    return createdDelta;
  }

  return left.tradeId.localeCompare(right.tradeId);
}

function positionFromLots(asset: string, lots: readonly MutableLot[]): PaperLedgerPosition[] {
  const activeLots = lots.filter((lot) => lot.remainingSize > EPSILON);

  if (activeLots.length === 0) {
    return [];
  }

  const side = activeLots[0].side;
  const quantity = activeLots.reduce((sum, lot) => sum + lot.remainingSize, 0);
  const entryValue = activeLots.reduce((sum, lot) => sum + lot.remainingSize * lot.entryPrice, 0);
  const entryFeesRemaining = activeLots.reduce((sum, lot) => sum + lot.entryFeesRemaining, 0);
  const openedAt = activeLots.reduce((oldest, lot) => (lot.openedAt < oldest ? lot.openedAt : oldest), activeLots[0].openedAt);
  const updatedAt = activeLots.reduce((latest, lot) => (lot.openedAt > latest ? lot.openedAt : latest), activeLots[0].openedAt);

  return [
    {
      asset,
      side,
      quantity: roundCrypto(quantity),
      averageEntryPrice: roundCrypto(entryValue / Math.max(EPSILON, quantity)),
      openNotional: roundCrypto(entryValue),
      entryFeesRemaining: roundCrypto(entryFeesRemaining),
      lotCount: activeLots.length,
      openedAt,
      updatedAt,
      lots: activeLots.map((lot) => ({
        lotId: lot.lotId,
        asset: lot.asset,
        side: lot.side,
        quantity: roundCrypto(lot.remainingSize),
        averageEntryPrice: roundCrypto(lot.entryPrice),
        entryFeesRemaining: roundCrypto(lot.entryFeesRemaining),
        openedAt: lot.openedAt,
        sourceTradeId: lot.sourceTradeId
      }))
    }
  ];
}

function assetSummary(
  summary: MutableAssetSummary,
  position: PaperLedgerPosition | undefined
): PaperLedgerAssetSummary {
  return {
    asset: summary.asset,
    fillCount: summary.fillCount,
    buyCount: summary.buyCount,
    sellCount: summary.sellCount,
    entryCount: summary.entryCount,
    exitCount: summary.exitCount,
    buySize: roundCrypto(summary.buySize),
    sellSize: roundCrypto(summary.sellSize),
    realizedGrossPnl: roundCrypto(summary.realizedGrossPnl),
    realizedNetPnl: roundCrypto(summary.realizedNetPnl),
    totalFees: roundCrypto(summary.totalFees),
    openQuantity: position
      ? roundCrypto(position.quantity * (position.side === "LONG" ? 1 : -1))
      : 0,
    openSide: position?.side ?? null,
    averageEntryPrice: position?.averageEntryPrice ?? null,
    openedAt: position?.openedAt ?? null,
    updatedAt: summary.updatedAt
  };
}

function summaryFor(summaries: Map<string, MutableAssetSummary>, asset: string): MutableAssetSummary {
  const existing = summaries.get(asset);

  if (existing) {
    return existing;
  }

  const created: MutableAssetSummary = {
    asset,
    fillCount: 0,
    buyCount: 0,
    sellCount: 0,
    entryCount: 0,
    exitCount: 0,
    buySize: 0,
    sellSize: 0,
    realizedGrossPnl: 0,
    realizedNetPnl: 0,
    totalFees: 0,
    updatedAt: null
  };

  summaries.set(asset, created);
  return created;
}

function positionQuantity(lots: readonly MutableLot[], side: PaperLedgerSide): number {
  return lots
    .filter((lot) => lot.side === side)
    .reduce((sum, lot) => sum + lot.remainingSize, 0);
}

function averageEntryPrice(lots: readonly MutableLot[], side: PaperLedgerSide): number | null {
  const activeLots = lots.filter((lot) => lot.side === side && lot.remainingSize > EPSILON);

  if (activeLots.length === 0) {
    return null;
  }

  const quantity = activeLots.reduce((sum, lot) => sum + lot.remainingSize, 0);
  const notional = activeLots.reduce((sum, lot) => sum + lot.remainingSize * lot.entryPrice, 0);

  return roundCrypto(notional / Math.max(EPSILON, quantity));
}

function isEntryEvent(type: PaperLedgerEventType): boolean {
  return type === "ENTRY" || type === "INCREASE" || type === "FLIP";
}

function normalizeAsset(asset: string): string {
  return asset.trim().toLowerCase();
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function roundCrypto(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
