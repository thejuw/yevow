import { DEFAULT_SOURCE_WEIGHT } from "../../../TradingEngineConstants";
import type {
  BookSnapshotResponse,
  DomAnalysisSnapshot,
  EngineState,
  Env,
  InternalOrderBook,
  LiquidityWall,
  MarketDataSource,
  MarketTick
} from "../../../types";
import {
  buildDomAnalysisSnapshot,
  createDomAnalyzerContext,
  currentDomHeatmapSnapshot
} from "./DomAnalyzer";
import { currentOrderBookSnapshot } from "./BookViews";
import { resolveTickSize } from "./BookRuntimeHelpers";
import type { BookSyncState } from "./BookTypes";
import type { SortedBookSide } from "./SortedBookSide";

export interface TradingBookViewTarget {
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
  readonly engineState: EngineState;
  readonly domWallHistory: LiquidityWall[];
  readonly domWallHistoryLimit: number;
  readonly domScanRangePct: number;
  readonly domSpoofProximityBps: number;
  readonly domMaxLevelsPerSide?: number;
  readonly env: Env;
  readonly domPriceBinSize: number;
  readonly orderBookReconstructor: {
    getBookSync(
      marketKey: string,
      instrumentCode: string,
      exchangeCode: string | null,
      sourceExchange: string,
      tickSize: number,
      source: MarketDataSource,
      sourceWeight: number
    ): BookSyncState;
  };
}

export function currentTradingBookSnapshotForTarget(
  target: TradingBookViewTarget,
  instrumentCode: string | undefined,
  depth: number
): BookSnapshotResponse {
  return currentOrderBookSnapshot(
    {
      orderBook: target.orderBook,
      bids: target.bids,
      asks: target.asks,
      microstructure: target.engineState.microstructure,
      defaultSourceWeight: DEFAULT_SOURCE_WEIGHT,
      getBookSync: (...args) => target.orderBookReconstructor.getBookSync(...args),
      resolveTickSize: (code) => resolveTickSize(target.env, code)
    },
    instrumentCode,
    depth
  );
}

export function currentTradingDomHeatmapForTarget(
  target: TradingBookViewTarget,
  instrumentCode: string | undefined,
  observedAt = new Date().toISOString()
): DomAnalysisSnapshot {
  return currentDomHeatmapSnapshot(
    createTradingDomAnalyzerContext(target),
    target.engineState.dom,
    instrumentCode,
    observedAt
  );
}

export function buildTradingDomAnalysisForTarget(
  target: TradingBookViewTarget,
  instrumentCode: string | undefined,
  observedAt: string,
  tick: MarketTick | undefined,
  persistHistory: boolean
): DomAnalysisSnapshot {
  return buildDomAnalysisSnapshot(
    createTradingDomAnalyzerContext(target),
    instrumentCode,
    observedAt,
    tick,
    persistHistory
  );
}

function createTradingDomAnalyzerContext(target: TradingBookViewTarget) {
  return createDomAnalyzerContext({
    orderBook: target.orderBook,
    bids: target.bids,
    asks: target.asks,
    engineState: target.engineState,
    domWallHistory: target.domWallHistory,
    domWallHistoryLimit: target.domWallHistoryLimit,
    domScanRangePct: target.domScanRangePct,
    domSpoofProximityBps: target.domSpoofProximityBps,
    domMaxLevelsPerSide: target.domMaxLevelsPerSide,
    env: target.env,
    domPriceBinSize: target.domPriceBinSize
  });
}
