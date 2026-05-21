import type { ProfilerRegistry } from "../../../agents/ProfilerRegistry";
import { DEFAULT_MAX_POSITION_PCT } from "../../../TradingEngineConstants";
import type {
  AssetRuntimeState,
  EngineState,
  GlobalRiskConfig,
  InternalOrderBook,
  MacroBias,
  ProfilerState
} from "../../../types";
import { findBestAssetBook } from "../book/BookViews";
import { resolveMaxPositionPct } from "../risk/PortfolioRiskRuntime";
import { calculateAssetMatrix } from "./AssetMatrixRuntime";

export interface TradingAssetMatrixInput {
  readonly observedAt: string;
  readonly latestOracle: EngineState["oracle"];
  readonly profilerStates: Record<string, ProfilerState>;
  readonly assetQuoteStates: EngineState["assetQuoteStates"];
  readonly fallbackQuoteState: EngineState["quoteState"];
  readonly macroBias: MacroBias;
  readonly equity: number;
  readonly config: GlobalRiskConfig;
  readonly envMaxPositionPct?: string;
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly profilerRegistry: ProfilerRegistry;
}

export function calculateTradingAssetMatrix(
  input: TradingAssetMatrixInput
): Record<string, AssetRuntimeState> {
  return calculateAssetMatrix({
    observedAt: input.observedAt,
    latestOracle: input.latestOracle,
    profilerStates: input.profilerStates,
    assetQuoteStates: input.assetQuoteStates,
    fallbackQuoteState: input.fallbackQuoteState,
    macroBias: input.macroBias,
    equity: input.equity,
    maxPositionPct: resolveMaxPositionPct(
      input.config,
      input.envMaxPositionPct,
      DEFAULT_MAX_POSITION_PCT
    ),
    findBestAssetBook: (instrumentCode) => findBestAssetBook(input.orderBook, instrumentCode),
    profilerStateForInstrument: (instrumentCode) =>
      input.profilerRegistry.forInstrument(instrumentCode).snapshot()
  });
}
