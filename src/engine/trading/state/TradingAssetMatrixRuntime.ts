import { DEFAULT_MAX_POSITION_PCT } from "../../../TradingEngineConstants";
import type {
  AssetRuntimeState,
  Env,
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
  readonly profilerRegistry: ProfilerStateSource;
}

export interface ProfilerStateSource {
  forInstrument(instrumentCode: string): {
    snapshot(): ProfilerState;
  };
}

export interface TradingAssetMatrixTarget {
  readonly engineState: Pick<
    EngineState,
    "oracle" | "assetQuoteStates" | "quoteState" | "bankroll"
  >;
  readonly macroBias: MacroBias;
  readonly cachedConfig: GlobalRiskConfig;
  readonly env: Pick<Env, "MAX_POSITION_PCT">;
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly profilerRegistry: ProfilerStateSource;
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

export function calculateTradingAssetMatrixForTarget(
  input: {
    readonly observedAt: string;
    readonly latestOracle: EngineState["oracle"];
    readonly profilerStates: Record<string, ProfilerState>;
    readonly assetQuoteStates?: EngineState["assetQuoteStates"];
  },
  target: TradingAssetMatrixTarget
): Record<string, AssetRuntimeState> {
  return calculateTradingAssetMatrix({
    observedAt: input.observedAt,
    latestOracle: input.latestOracle,
    profilerStates: input.profilerStates,
    assetQuoteStates: input.assetQuoteStates ?? target.engineState.assetQuoteStates,
    fallbackQuoteState: target.engineState.quoteState,
    macroBias: target.macroBias,
    equity: target.engineState.bankroll.equity,
    config: target.cachedConfig,
    envMaxPositionPct: target.env.MAX_POSITION_PCT,
    orderBook: target.orderBook,
    profilerRegistry: target.profilerRegistry
  });
}
