import {
  DEFAULT_MAX_POSITION_PCT,
  DEFAULT_SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS
} from "../../../TradingEngineConstants";
import type {
  AgentDecisionTrace,
  EngineState,
  Env,
  GlobalRiskConfig,
  InternalOrderBook,
  JsonRecord,
  MarketTick,
  ShadowQueueDecision,
  ShadowQueueFill,
  ShadowQueueState,
  TradeExecution,
  TradeIntent
} from "../../../types";
import type { GhostBook } from "../../../utils/GhostBook";
import { readPositiveNumber } from "../helpers/RuntimeParsing";
import type { TickHandlingOptions } from "../pipelines/TickPipelineTypes";
import {
  cancelAllTradingQuotesForTarget,
  type TradingQuoteCancelAllTarget
} from "../quotes/QuoteCancelRuntime";
import {
  applyShadowQueueDecisionFlow,
  buildShadowQueueGhostFillRuntimeRecord,
  emitShadowQueueGhostFillSideEffects,
  processShadowQueueTickRuntime,
  resolveShadowQueueGhostFillConfig,
  resolveShadowQueueNoEdgeLogInterval,
  resolveShadowQueueSizingConfig
} from "./ShadowQueueRuntime";

export interface TradingShadowQueueInput {
  readonly tick: MarketTick;
  readonly book: InternalOrderBook;
  readonly observedAt: string;
  readonly options: TickHandlingOptions;
  readonly ghostBook: GhostBook;
  readonly env: Env;
  readonly engineState: EngineState;
  readonly cachedConfig: GlobalRiskConfig;
  readonly noEdgeLogAt: Map<string, number>;
}

export interface TradingShadowQueueHandlers {
  readonly recordExecution: (trade: TradeExecution) => void;
  readonly logInfo: (eventType: string, message: string, metadata: JsonRecord) => void;
  readonly warn: (eventType: string, message: string, metadata: JsonRecord) => void;
  readonly publish: (
    type: string,
    payload: Record<string, unknown>,
    correlationId?: string
  ) => void;
  readonly schedule: (work: Promise<unknown>) => void;
  readonly cancelAllQuotes: (
    instrumentCode: string,
    reason: "SHADOW_QUEUE_RED_LIGHT"
  ) => Promise<unknown>;
  readonly dispatchExecution: (intent: TradeIntent) => Promise<unknown>;
  readonly traceDecision: (trace: AgentDecisionTrace) => void;
}

export interface TradingShadowQueueTarget {
  readonly ghostBook: GhostBook;
  readonly env: Env;
  readonly engineState: EngineState;
  readonly cachedConfig: GlobalRiskConfig;
  readonly shadowQueueNoEdgeLogAt: Map<string, number>;
  readonly logger: {
    recordExecution(trade: TradeExecution): void;
    info(eventType: string, message: string, metadata: JsonRecord): void;
    warn(eventType: string, message: string, metadata: JsonRecord): void;
    traceDecision(trace: AgentDecisionTrace): void;
  };
  readonly state: {
    waitUntil(work: Promise<unknown>): void;
  };
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
  cancelAllQuotes?(instrumentCode: string, reason: "SHADOW_QUEUE_RED_LIGHT"): Promise<unknown>;
  dispatchExecution(intent: TradeIntent): Promise<unknown>;
}

export function recordTradingShadowQueueGhostFill(
  input: Omit<TradingShadowQueueInput, "options" | "ghostBook" | "noEdgeLogAt"> & {
    readonly fill: ShadowQueueFill;
  },
  handlers: Pick<TradingShadowQueueHandlers, "recordExecution" | "publish">
): void {
  const fillConfig = resolveShadowQueueGhostFillConfig({
    paperFillParticipationRate: input.env.PAPER_FILL_PARTICIPATION_RATE,
    paperFillAdverseBps: input.env.PAPER_FILL_ADVERSE_BPS,
    paperMakerFeeBps: input.env.PAPER_MAKER_FEE_BPS,
    exchangeFeeBps: input.env.EXCHANGE_FEE_BPS,
    maxPositionPct: input.env.MAX_POSITION_PCT,
    kellyFraction: input.env.KELLY_FRACTION
  });
  const ghostFillRecord = buildShadowQueueGhostFillRuntimeRecord({
    fill: input.fill,
    tick: input.tick,
    book: input.book,
    observedAt: input.observedAt,
    slippage: input.engineState.slippage,
    fallbackAdverseBps: fillConfig.fallbackAdverseBps,
    participationRate: fillConfig.participationRate,
    makerFeeBps: fillConfig.makerFeeBps,
    cachedConfig: input.cachedConfig,
    envMaxPositionPct: fillConfig.envMaxPositionPct,
    envKellyFraction: fillConfig.envKellyFraction,
    equity: input.engineState.bankroll.equity,
    inventory: input.engineState.inventory,
    positionSizeMultiplier: input.engineState.location.positionSizeMultiplier
  });

  emitShadowQueueGhostFillSideEffects(input.fill.fillId, ghostFillRecord, {
    recordExecution: handlers.recordExecution,
    publish: handlers.publish
  });
}

export function handleTradingShadowQueueDecision(
  input: Omit<TradingShadowQueueInput, "tick" | "options" | "ghostBook"> & {
    readonly decision: ShadowQueueDecision;
  },
  handlers: Omit<TradingShadowQueueHandlers, "recordExecution">
): ShadowQueueDecision {
  const sizing = resolveShadowQueueSizingConfig({
    cachedConfig: input.cachedConfig,
    envMaxPositionPct: readPositiveNumber(input.env.MAX_POSITION_PCT, DEFAULT_MAX_POSITION_PCT),
    envKellyFraction: readPositiveNumber(input.env.KELLY_FRACTION, 0.5)
  });

  return applyShadowQueueDecisionFlow(
    {
      decision: input.decision,
      book: input.book,
      observedAt: input.observedAt,
      engineId: input.engineState.engineId,
      baseSpreadBps: input.engineState.shadowQueue.baseSpreadBps,
      exchangeFeeBps: input.cachedConfig.EXCHANGE_FEE_BPS,
      toxicityScore: input.engineState.toxicityScore,
      equity: input.engineState.bankroll.equity,
      maxPositionPct: sizing.maxPositionPct,
      kellyFraction: sizing.kellyFraction,
      inventory: input.engineState.inventory,
      positionSizeMultiplier: input.engineState.location.positionSizeMultiplier,
      quoteStateStatus: input.engineState.quoteState.status,
      cachedConfigVersion: input.cachedConfig.version,
      tradingEnabled: input.cachedConfig.TRADING_ENABLED,
      latencyBudgetMs: input.engineState.shadowQueue.latencyBudgetMs,
      lastLoggedAtByInstrument: input.noEdgeLogAt,
      noEdgeNowMs: Date.now(),
      noEdgeLogIntervalMs: resolveShadowQueueNoEdgeLogInterval(
        input.env.SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS ??
          String(DEFAULT_SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS)
      )
    },
    handlers
  );
}

export function processTradingShadowQueueTick(
  input: TradingShadowQueueInput,
  handlers: TradingShadowQueueHandlers
): ShadowQueueState {
  return processShadowQueueTickRuntime(
    {
      tick: input.tick,
      book: input.book,
      observedAt: input.observedAt,
      shadowReplay: input.options.shadowReplay
    },
    {
      snapshot: (observedAt) => input.ghostBook.snapshot(observedAt),
      observeTrade: (tick, book, observedAt) =>
        input.ghostBook.observeTrade(tick, book, observedAt),
      recordGhostFill: (fill) => {
        recordTradingShadowQueueGhostFill(
          {
            ...input,
            fill
          },
          handlers
        );
      },
      handleDecision: (decision) =>
        handleTradingShadowQueueDecision(
          {
            ...input,
            decision
          },
          handlers
        ),
      recordDecision: (decision) => {
        input.ghostBook.recordDecision(decision);
      },
      injectBbo: (book, observedAt) => {
        input.ghostBook.injectBbo(book, observedAt);
      }
    }
  );
}

export function processTradingShadowQueueTickForTarget(
  tick: MarketTick,
  book: InternalOrderBook,
  observedAt: string,
  options: TickHandlingOptions,
  target: TradingShadowQueueTarget
): ShadowQueueState {
  return processTradingShadowQueueTick(
    {
      tick,
      book,
      observedAt,
      options,
      ghostBook: target.ghostBook,
      env: target.env,
      engineState: target.engineState,
      cachedConfig: target.cachedConfig,
      noEdgeLogAt: target.shadowQueueNoEdgeLogAt
    },
    {
      recordExecution: (trade) => {
        target.logger.recordExecution(trade);
      },
      logInfo: (eventType, message, metadata) => {
        target.logger.info(eventType, message, metadata);
      },
      warn: (eventType, message, metadata) => {
        target.logger.warn(eventType, message, metadata);
      },
      publish: (type, payload, correlationId) => {
        target.publish(type, payload, correlationId);
      },
      schedule: (work) => {
        target.state.waitUntil(work);
      },
      cancelAllQuotes: (instrumentCode, reason) =>
        target.cancelAllQuotes
          ? target.cancelAllQuotes(instrumentCode, reason)
          : cancelAllTradingQuotesForTarget(
              instrumentCode,
              reason,
              target as unknown as TradingQuoteCancelAllTarget
            ),
      dispatchExecution: (intent) => target.dispatchExecution(intent),
      traceDecision: (trace) => {
        target.logger.traceDecision(trace);
      }
    }
  );
}
