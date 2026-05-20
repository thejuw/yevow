import type {
  GlobalRiskConfig,
  InternalOrderBook,
  InventoryState,
  MarketTick,
  ShadowQueueFill,
  SlippageAnalytics,
  TradeExecution
} from "../../../types";
import { roundCrypto } from "../book/SortedBookSide";
import {
  DEFAULT_PAPER_FILL_ADVERSE_BPS,
  DEFAULT_PAPER_FILL_PARTICIPATION_RATE,
  DEFAULT_PAPER_MAKER_FEE_BPS
} from "../../../TradingEngineConstants";
import { readBoundedNumber } from "../helpers/RuntimeParsing";
import { adverseAdjustedPaperFillPrice } from "../state/AssetStateRuntime";
import { bootstrapPaperAdverseSelection } from "../../PaperReplayModel";
import {
  resolveShadowQueueEnvSizingConfig,
  resolveShadowQueueSizingConfig,
  shadowQueueKellySize
} from "./ShadowQueueSizingRuntime";

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

export interface ShadowQueueGhostFillRuntimeInput {
  readonly fill: ShadowQueueFill;
  readonly tick: MarketTick;
  readonly book: InternalOrderBook;
  readonly observedAt: string;
  readonly slippage: SlippageAnalytics;
  readonly fallbackAdverseBps: number;
  readonly participationRate: number;
  readonly makerFeeBps: number;
  readonly cachedConfig: GlobalRiskConfig;
  readonly envMaxPositionPct: number;
  readonly envKellyFraction: number;
  readonly equity: number;
  readonly inventory: InventoryState;
  readonly positionSizeMultiplier: number;
}

export interface ShadowQueueGhostFillConfigInput {
  readonly paperFillParticipationRate?: string;
  readonly paperFillAdverseBps?: string;
  readonly paperMakerFeeBps?: string;
  readonly exchangeFeeBps?: string;
  readonly maxPositionPct?: string;
  readonly kellyFraction?: string;
}

export interface ShadowQueueGhostFillConfig {
  readonly participationRate: number;
  readonly fallbackAdverseBps: number;
  readonly makerFeeBps: number;
  readonly envMaxPositionPct: number;
  readonly envKellyFraction: number;
}

export interface ShadowQueueGhostFillRecord {
  readonly eventPayload: Record<string, unknown>;
  readonly trade: TradeExecution | null;
}

export interface ShadowQueueGhostFillSideEffectHandlers {
  readonly recordExecution: (trade: TradeExecution) => void;
  readonly publish: (
    type: "SHADOW_QUEUE_GHOST_FILL",
    payload: Record<string, unknown>,
    correlationId: string
  ) => void;
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

export function buildShadowQueueGhostFillRuntimeRecord(
  input: ShadowQueueGhostFillRuntimeInput
): ShadowQueueGhostFillRecord {
  const paperFillModel = bootstrapPaperAdverseSelection({
    slippage: input.slippage,
    fallbackAdverseBps: input.fallbackAdverseBps,
    side: input.fill.side
  });
  const adverseBps = paperFillModel.adverseBps;
  const paperFillPrice = adverseAdjustedPaperFillPrice(
    input.fill.side,
    input.fill.price,
    adverseBps,
    input.book.tickSize
  );
  const sizing = resolveShadowQueueSizingConfig({
    cachedConfig: input.cachedConfig,
    envMaxPositionPct: input.envMaxPositionPct,
    envKellyFraction: input.envKellyFraction
  });
  const paperSizeCap = shadowQueueKellySize({
    action: input.fill.side,
    price: paperFillPrice,
    book: input.book,
    equity: input.equity,
    maxPositionPct: sizing.maxPositionPct,
    kellyFraction: sizing.kellyFraction,
    inventory: input.inventory,
    positionSizeMultiplier: input.positionSizeMultiplier
  });
  const executablePaperSize = roundCrypto(
    Math.min(input.fill.size * input.participationRate, paperSizeCap)
  );

  return buildShadowQueueGhostFillRecord({
    fill: input.fill,
    tick: input.tick,
    book: input.book,
    observedAt: input.observedAt,
    participationRate: input.participationRate,
    adverseBps,
    makerFeeBps: input.makerFeeBps,
    fillModelSource: paperFillModel.source,
    paperFillPrice,
    paperSizeCap,
    executablePaperSize
  });
}

export function emitShadowQueueGhostFillSideEffects(
  fillId: string,
  record: ShadowQueueGhostFillRecord,
  handlers: ShadowQueueGhostFillSideEffectHandlers
): void {
  if (record.trade) {
    handlers.recordExecution(record.trade);
  }

  handlers.publish("SHADOW_QUEUE_GHOST_FILL", record.eventPayload, fillId);
}

export function resolveShadowQueueGhostFillConfig(
  input: ShadowQueueGhostFillConfigInput
): ShadowQueueGhostFillConfig {
  const sizing = resolveShadowQueueEnvSizingConfig(input);

  return {
    participationRate: readBoundedNumber(
      input.paperFillParticipationRate,
      DEFAULT_PAPER_FILL_PARTICIPATION_RATE,
      0,
      1
    ),
    fallbackAdverseBps: readBoundedNumber(
      input.paperFillAdverseBps,
      DEFAULT_PAPER_FILL_ADVERSE_BPS,
      0,
      100
    ),
    makerFeeBps: readBoundedNumber(
      input.paperMakerFeeBps ?? input.exchangeFeeBps,
      DEFAULT_PAPER_MAKER_FEE_BPS,
      0,
      100
    ),
    envMaxPositionPct: sizing.envMaxPositionPct,
    envKellyFraction: sizing.envKellyFraction
  };
}
