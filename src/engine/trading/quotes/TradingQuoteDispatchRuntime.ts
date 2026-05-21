import {
  DEFAULT_MAX_POSITION_PCT,
  HOT_PATH_LOG_THROTTLE_MS
} from "../../../TradingEngineConstants";
import type {
  EngineState,
  Env,
  GlobalRiskConfig,
  InternalOrderBook,
  JsonRecord,
  MacroBias,
  TradeIntent
} from "../../../types";
import type { QueuePositionModel } from "../../QueuePositionModel";
import { findBestAssetBook } from "../book/BookViews";
import { resolveMaxPositionPct } from "../risk/PortfolioRiskRuntime";
import { isInstrumentSelectedByMoltworker } from "../state/AssetSelectionRuntime";
import { quoteStateForInstrumentState } from "../state/AssetQuoteStateRuntime";
import { applyQuoteDispatchFlow, type SkippedQuoteOrder } from "./QuoteIntentRuntime";
import {
  rememberTradingDispatchedQuote,
  shouldThrottleTradingQuoteRefresh
} from "./TradingQuoteRefreshRuntime";
import type { DispatchedQuoteSnapshot } from "./QuoteRefreshRuntime";

export interface TradingQuoteDispatchInput {
  readonly quote: NonNullable<EngineState["quoteState"]["lastQuote"]>;
  readonly engineState: EngineState;
  readonly cachedConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly hasExecutioner: boolean;
  readonly maxPositionPctValue: string | undefined;
}

export interface TradingQuoteDispatchHandlers {
  readonly logInfo: (event: string, message: string, metadata: JsonRecord) => void;
  readonly logSkippedOrder: (metadata: SkippedQuoteOrder) => void;
  readonly dispatchExecution: (intent: TradeIntent) => Promise<void>;
  readonly rememberDispatchedQuote: (
    quote: NonNullable<EngineState["quoteState"]["lastQuote"]>
  ) => void;
  readonly shouldThrottleQuoteDispatch: (
    quote: NonNullable<EngineState["quoteState"]["lastQuote"]>
  ) => boolean;
}

export interface TradingQuoteDispatchTarget {
  readonly engineState: EngineState;
  readonly cachedConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly env: Pick<
    Env,
    | "EXECUTIONER"
    | "MAX_POSITION_PCT"
    | "QUOTE_REFRESH_MIN_INTERVAL_MS"
    | "QUOTE_REFRESH_MIN_PRICE_TICKS"
  >;
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly logger: {
    info(eventType: string, message: string, telemetry?: JsonRecord): void;
    warn(eventType: string, message: string, telemetry?: JsonRecord): void;
  };
  readonly queuePositionModel: Pick<QueuePositionModel, "adviseRefresh">;
  readonly lastDispatchedQuoteByInstrument: Map<string, DispatchedQuoteSnapshot>;
  readonly quoteRefreshThrottleLogAt: Map<string, number>;
  dispatchExecution(intent: TradeIntent): Promise<void>;
}

export async function dispatchTradingQuote(
  input: TradingQuoteDispatchInput,
  handlers: TradingQuoteDispatchHandlers
): Promise<void> {
  const maxPositionPct = resolveMaxPositionPct(
    input.cachedConfig,
    input.maxPositionPctValue,
    DEFAULT_MAX_POSITION_PCT
  );
  const assetRuntimeState = input.engineState.assetMatrix?.[input.quote.instrumentCode];
  const assetAllocation =
    input.engineState.assetMatrix?.[input.quote.instrumentCode]?.capitalAllocationPct ?? 1;

  await applyQuoteDispatchFlow(
    {
      quote: input.quote,
      hasExecutioner: input.hasExecutioner,
      tradingEnabled: input.cachedConfig.TRADING_ENABLED,
      instrumentSelected: isInstrumentSelectedByMoltworker(
        input.quote.instrumentCode,
        input.macroBias
      ),
      assetRuntimeState,
      instrumentQuoteState: quoteStateForInstrumentState(
        input.engineState.assetQuoteStates,
        input.quote.instrumentCode,
        input.engineState.quoteState
      ),
      engineId: input.engineState.engineId,
      bankrollEquity: input.engineState.bankroll.equity,
      bankrollCash: input.engineState.bankroll.cash,
      maxPositionPct,
      maxPositionSize: input.cachedConfig.MAX_POSITION_SIZE,
      assetAllocationPct: assetAllocation,
      positionSizeMultiplier: input.engineState.location.positionSizeMultiplier,
      fallbackSourceExchange: input.engineState.microstructure.source_exchange,
      spreadBps: input.engineState.microstructure.spreadBps,
      toxicityScore: input.engineState.toxicityScore
    },
    handlers
  );
}

export function shouldThrottleTradingQuoteDispatchForTarget(
  quote: NonNullable<EngineState["quoteState"]["lastQuote"]>,
  target: TradingQuoteDispatchTarget
): boolean {
  const last = target.lastDispatchedQuoteByInstrument.get(quote.instrumentCode);
  const book = findBestAssetBook(target.orderBook, quote.instrumentCode);

  return shouldThrottleTradingQuoteRefresh(
    {
      quote,
      previousQuote: last,
      book: book ?? null,
      nowMs: Date.now(),
      lastLogAtMs: target.quoteRefreshThrottleLogAt.get(quote.instrumentCode) ?? 0,
      logThrottleMs: HOT_PATH_LOG_THROTTLE_MS,
      env: target.env
    },
    {
      markLogAt: (key, loggedAtMs) => {
        target.quoteRefreshThrottleLogAt.set(key, loggedAtMs);
      },
      logInfo: (event, message, metadata) => {
        target.logger.info(event, message, metadata);
      },
      adviseRefresh: (input) => target.queuePositionModel.adviseRefresh(input)
    }
  );
}

export function rememberTradingDispatchedQuoteForTarget(
  quote: NonNullable<EngineState["quoteState"]["lastQuote"]>,
  target: TradingQuoteDispatchTarget
): void {
  target.lastDispatchedQuoteByInstrument.set(
    quote.instrumentCode,
    rememberTradingDispatchedQuote(quote, Date.now())
  );
}

export function dispatchTradingQuoteForTarget(
  quote: NonNullable<EngineState["quoteState"]["lastQuote"]>,
  target: TradingQuoteDispatchTarget
): Promise<void> {
  return dispatchTradingQuote(
    {
      quote,
      engineState: target.engineState,
      cachedConfig: target.cachedConfig,
      macroBias: target.macroBias,
      hasExecutioner: Boolean(target.env.EXECUTIONER),
      maxPositionPctValue: target.env.MAX_POSITION_PCT
    },
    {
      logInfo: (event, message, metadata) => {
        target.logger.info(event, message, metadata);
      },
      logSkippedOrder: (skipped) => {
        target.logger.warn(
          "QUOTE_ORDER_RISK_CAP_ZERO",
          "Skipped quote order with no remaining risk budget",
          { ...skipped }
        );
      },
      dispatchExecution: (intent) => target.dispatchExecution(intent),
      rememberDispatchedQuote: (dispatchedQuote) => {
        rememberTradingDispatchedQuoteForTarget(dispatchedQuote, target);
      },
      shouldThrottleQuoteDispatch: (candidateQuote) =>
        shouldThrottleTradingQuoteDispatchForTarget(candidateQuote, target)
    }
  );
}
