import { DEFAULT_MAX_POSITION_PCT } from "../../../TradingEngineConstants";
import type {
  EngineState,
  GlobalRiskConfig,
  JsonRecord,
  MacroBias,
  TradeIntent
} from "../../../types";
import { resolveMaxPositionPct } from "../risk/PortfolioRiskRuntime";
import { isInstrumentSelectedByMoltworker } from "../state/AssetSelectionRuntime";
import { quoteStateForInstrumentState } from "../state/AssetQuoteStateRuntime";
import { applyQuoteDispatchFlow, type SkippedQuoteOrder } from "./QuoteIntentRuntime";

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
