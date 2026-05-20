import type {
  GlobalRiskConfig,
  AgentDecisionTrace,
  InternalOrderBook,
  InventoryState,
  JsonRecord,
  MarketTick,
  ShadowQueueFill,
  ShadowQueueDecision,
  SlippageAnalytics,
  TradeExecution,
  TradeIntent
} from "../../../types";
import {
  DEFAULT_ORDER_BOOK_TICK_SIZE,
  normalizePriceToTick,
  roundCrypto
} from "../book/SortedBookSide";
import {
  DEFAULT_MAX_POSITION_PCT,
  DEFAULT_PAPER_FILL_ADVERSE_BPS,
  DEFAULT_PAPER_FILL_PARTICIPATION_RATE,
  DEFAULT_PAPER_MAKER_FEE_BPS,
  DEFAULT_SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS,
  DEFAULT_SHADOW_VLO_MIN_SIZE
} from "../../../TradingEngineConstants";
import {
  readBoundedNumber,
  readPositiveInteger,
  readPositiveNumber
} from "../helpers/RuntimeParsing";
import { adverseAdjustedPaperFillPrice } from "../state/AssetStateRuntime";
import { bootstrapPaperAdverseSelection } from "../../PaperReplayModel";

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

export interface ShadowQueueIntentFromDecisionInput {
  readonly decision: ShadowQueueDecision;
  readonly book: InternalOrderBook;
  readonly observedAt: string;
  readonly engineId: string;
  readonly baseSpreadBps: number;
  readonly exchangeFeeBps: number;
  readonly toxicityScore: number;
  readonly equity: number;
  readonly maxPositionPct: number;
  readonly kellyFraction: number;
  readonly inventory: InventoryState;
  readonly positionSizeMultiplier: number;
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

export interface ShadowQueueNoEdgeThrottleInput {
  readonly lastLoggedAtByInstrument: Map<string, number>;
  readonly instrumentCode: string;
  readonly nowMs: number;
  readonly intervalMs: number;
}

export interface ShadowQueueNoEdgeSideEffectInput {
  readonly decision: ShadowQueueDecision;
  readonly lastLoggedAtByInstrument: Map<string, number>;
  readonly nowMs: number;
  readonly intervalMs: number;
}

export interface ShadowQueueNoEdgeSideEffectHandlers {
  readonly logInfo: (eventType: string, message: string, metadata: JsonRecord) => void;
  readonly publish: (type: string, payload: Record<string, unknown>, correlationId: string) => void;
}

export function resolveShadowQueueNoEdgeLogInterval(envValue?: string): number {
  return readPositiveInteger(
    envValue,
    DEFAULT_SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS,
    1_000,
    300_000
  );
}

export interface ShadowQueueLatencyBudgetResult {
  readonly breached: boolean;
  readonly decision: ShadowQueueDecision;
}

export interface ShadowQueueLatencyBreachSideEffectInput {
  readonly decision: ShadowQueueDecision;
  readonly latencyBudgetMs: number;
}

export interface ShadowQueueLatencyBreachSideEffectHandlers {
  readonly warn: (eventType: string, message: string, metadata: JsonRecord) => void;
  readonly publish: (type: string, payload: Record<string, unknown>, correlationId: string) => void;
}

export interface ShadowQueueNoEdgeTelemetry {
  readonly eventType: "SHADOW_QUEUE_NO_EDGE";
  readonly message: string;
  readonly metadata: JsonRecord;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

export interface ShadowQueueLatencyBreachTelemetry {
  readonly eventType: "SHADOW_QUEUE_LATENCY_BREACH";
  readonly message: string;
  readonly metadata: JsonRecord;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

export interface ShadowQueueDecisionTraceInput {
  readonly decision: ShadowQueueDecision;
  readonly intent: TradeIntent | null;
  readonly engineId: string;
  readonly quoteStateStatus: string;
  readonly inventory: InventoryState;
  readonly cachedConfigVersion: string;
  readonly observedAt: string;
}

export interface ShadowQueueDecisionActionInput {
  readonly decision: ShadowQueueDecision;
  readonly intent: TradeIntent | null;
  readonly tradingEnabled: boolean;
}

export interface ShadowQueueDecisionRuntimeInput extends ShadowQueueIntentFromDecisionInput {
  readonly quoteStateStatus: string;
  readonly cachedConfigVersion: string;
  readonly tradingEnabled: boolean;
}

export interface ShadowQueueDecisionRuntimeArtifacts {
  readonly decision: ShadowQueueDecision;
  readonly intent: TradeIntent | null;
  readonly trace: AgentDecisionTrace;
  readonly action: ShadowQueueDecisionAction;
}

export interface ShadowQueueDecisionAction {
  readonly publish: {
    readonly type:
      | "SHADOW_QUEUE_SIGNAL_SUPPRESSED"
      | "SHADOW_QUEUE_RED_LIGHT"
      | "SHADOW_QUEUE_GREEN_LIGHT";
    readonly payload: Record<string, unknown>;
    readonly correlationId: string;
  };
  readonly cancelReason: "SHADOW_QUEUE_RED_LIGHT" | null;
  readonly dispatchIntent: TradeIntent | null;
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
    envMaxPositionPct: readPositiveNumber(input.maxPositionPct, DEFAULT_MAX_POSITION_PCT),
    envKellyFraction: readPositiveNumber(input.kellyFraction, 0.5)
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

export function enforceShadowQueueDecisionLatency(
  decision: ShadowQueueDecision,
  latencyBudgetMs: number
): ShadowQueueLatencyBudgetResult {
  if (decision.decisionLatencyMs <= latencyBudgetMs) {
    return { breached: false, decision };
  }

  return {
    breached: true,
    decision: {
      ...decision,
      tradeIntentId: null,
      reason: `${decision.reason} Suppressed because drift decision latency exceeded ${latencyBudgetMs}ms.`
    }
  };
}

export function buildShadowQueueNoEdgeTelemetry(
  decision: ShadowQueueDecision
): ShadowQueueNoEdgeTelemetry {
  return {
    eventType: "SHADOW_QUEUE_NO_EDGE",
    message: "Virtual fill drift stayed inside one tick",
    metadata: {
      decisionId: decision.decisionId,
      fillId: decision.fillId,
      instrumentCode: decision.instrumentCode,
      microDrift: decision.microDrift,
      tickThreshold: decision.tickThreshold,
      driftTrades: decision.driftTrades,
      sampled: true
    },
    payload: decision as unknown as Record<string, unknown>,
    correlationId: decision.decisionId
  };
}

export function emitShadowQueueNoEdgeDecisionSideEffects(
  input: ShadowQueueNoEdgeSideEffectInput,
  handlers: ShadowQueueNoEdgeSideEffectHandlers
): ShadowQueueDecision {
  const telemetry = buildShadowQueueNoEdgeTelemetry(input.decision);

  if (
    shouldLogShadowQueueNoEdge({
      lastLoggedAtByInstrument: input.lastLoggedAtByInstrument,
      instrumentCode: input.decision.instrumentCode,
      nowMs: input.nowMs,
      intervalMs: input.intervalMs
    })
  ) {
    handlers.logInfo(telemetry.eventType, telemetry.message, telemetry.metadata);
  }

  handlers.publish(telemetry.eventType, telemetry.payload, telemetry.correlationId);
  return input.decision;
}

export function buildShadowQueueLatencyBreachTelemetry(input: {
  readonly originalDecision: ShadowQueueDecision;
  readonly suppressedDecision: ShadowQueueDecision;
  readonly latencyBudgetMs: number;
}): ShadowQueueLatencyBreachTelemetry {
  return {
    eventType: "SHADOW_QUEUE_LATENCY_BREACH",
    message: "VLO matrix decision exceeded 5ms envelope",
    metadata: {
      decisionId: input.originalDecision.decisionId,
      instrumentCode: input.originalDecision.instrumentCode,
      decisionLatencyMs: input.originalDecision.decisionLatencyMs,
      latencyBudgetMs: input.latencyBudgetMs
    },
    payload: input.suppressedDecision as unknown as Record<string, unknown>,
    correlationId: input.originalDecision.decisionId
  };
}

export function applyShadowQueueLatencyBreachSideEffects(
  input: ShadowQueueLatencyBreachSideEffectInput,
  handlers: ShadowQueueLatencyBreachSideEffectHandlers
): ShadowQueueDecision | null {
  const latencyDecision = enforceShadowQueueDecisionLatency(input.decision, input.latencyBudgetMs);

  if (!latencyDecision.breached) {
    return null;
  }

  const suppressed = latencyDecision.decision;
  const telemetry = buildShadowQueueLatencyBreachTelemetry({
    originalDecision: input.decision,
    suppressedDecision: suppressed,
    latencyBudgetMs: input.latencyBudgetMs
  });

  handlers.warn(telemetry.eventType, telemetry.message, telemetry.metadata);
  handlers.publish(telemetry.eventType, telemetry.payload, telemetry.correlationId);

  return suppressed;
}

export function buildShadowQueueDecisionTrace(
  input: ShadowQueueDecisionTraceInput
): AgentDecisionTrace {
  return {
    decisionId: input.decision.decisionId,
    signalId: input.decision.fillId,
    traceId: `${input.engineId}:shadow-queue:${input.decision.fillId}`,
    agentName: "PROFILER",
    targetAgent: "EXECUTIONER",
    instrumentCode: input.decision.instrumentCode,
    action: input.decision.action === "GREEN_LIGHT" ? "EXECUTE" : "SUPERVISOR_ACTION",
    confidence: Math.min(
      1,
      Math.max(
        0,
        Math.abs(input.decision.microDrift) / Math.max(input.decision.tickThreshold, 1e-12)
      )
    ),
    expectedValue: input.intent?.expectedValue ?? 0,
    maxSlippageBps: input.intent?.maxSlippageBps ?? 0,
    reasoning: input.decision.reason,
    featureVector: {
      schemaVersion: "shadow-queue.decision.v1",
      light: input.decision.action,
      originalSide: input.decision.originalSide,
      dispatchSide: input.decision.dispatchSide,
      p0MidPrice: input.decision.p0MidPrice,
      pnMidPrice: input.decision.pnMidPrice,
      microDrift: input.decision.microDrift,
      driftTrades: input.decision.driftTrades,
      tradeIntentId: input.decision.tradeIntentId
    },
    riskSnapshot: {
      quoteState: input.quoteStateStatus,
      inventory: input.inventory,
      cachedConfigVersion: input.cachedConfigVersion
    } as unknown as JsonRecord,
    rawSignal: input.decision as unknown as JsonRecord,
    latencyMs: input.decision.decisionLatencyMs,
    createdAt: input.observedAt
  };
}

export function buildShadowQueueDecisionAction(
  input: ShadowQueueDecisionActionInput
): ShadowQueueDecisionAction {
  if (!input.intent) {
    return {
      publish: {
        type: "SHADOW_QUEUE_SIGNAL_SUPPRESSED",
        payload: input.decision as unknown as Record<string, unknown>,
        correlationId: input.decision.decisionId
      },
      cancelReason: null,
      dispatchIntent: null
    };
  }

  const isRedLight = input.decision.action === "RED_LIGHT";

  return {
    publish: {
      type: isRedLight ? "SHADOW_QUEUE_RED_LIGHT" : "SHADOW_QUEUE_GREEN_LIGHT",
      payload: input.decision as unknown as Record<string, unknown>,
      correlationId: input.decision.decisionId
    },
    cancelReason: isRedLight && input.tradingEnabled ? "SHADOW_QUEUE_RED_LIGHT" : null,
    dispatchIntent: input.tradingEnabled ? input.intent : null
  };
}

export function buildShadowQueueDecisionRuntimeArtifacts(
  input: ShadowQueueDecisionRuntimeInput
): ShadowQueueDecisionRuntimeArtifacts {
  const intent = buildShadowQueueTradeIntentFromDecision(input);
  const decision = {
    ...input.decision,
    tradeIntentId: intent?.intentId ?? null
  };

  return {
    decision,
    intent,
    trace: buildShadowQueueDecisionTrace({
      decision,
      intent,
      engineId: input.engineId,
      quoteStateStatus: input.quoteStateStatus,
      inventory: input.inventory,
      cachedConfigVersion: input.cachedConfigVersion,
      observedAt: input.observedAt
    }),
    action: buildShadowQueueDecisionAction({
      decision,
      intent,
      tradingEnabled: input.tradingEnabled
    })
  };
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

export function buildShadowQueueTradeIntentFromDecision(
  input: ShadowQueueIntentFromDecisionInput
): TradeIntent | null {
  const action = input.decision.dispatchSide;

  if (!action || input.book.midPrice === null || input.book.midPrice <= 0) {
    return null;
  }

  const price = shadowQueuePostOnlyPrice(
    action,
    input.book,
    input.decision.pnMidPrice,
    input.baseSpreadBps
  );
  const requestedSize = shadowQueueKellySize({
    action,
    price,
    book: input.book,
    equity: input.equity,
    maxPositionPct: input.maxPositionPct,
    kellyFraction: input.kellyFraction,
    inventory: input.inventory,
    positionSizeMultiplier: input.positionSizeMultiplier
  });

  return buildShadowQueueTradeIntent({
    decision: input.decision,
    book: input.book,
    observedAt: input.observedAt,
    engineId: input.engineId,
    baseSpreadBps: input.baseSpreadBps,
    exchangeFeeBps: input.exchangeFeeBps,
    toxicityScore: input.toxicityScore,
    requestedSize,
    price
  });
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
