import type {
  DomAnalysisSnapshot,
  InternalOrderBook,
  LiquidityWall,
  MarketTick,
  MicrostructureMetrics
} from "../../../types";
import {
  aggregateDomBins,
  classifyMissingWalls,
  domHeatmapCell,
  emptyDomSnapshot,
  isLiquidityWall,
  latestActiveWalls,
  normalizeMarketKey,
  toLiquidityWall,
  volumeStats,
  wallIdForBin
} from "../helpers/RuntimeHelpers";
import { roundCrypto, type SortedBookSide } from "./SortedBookSide";
import { getInstrumentBook } from "./BookReconstruction";
import { selectOrderBookMarketKey, type BookSelection } from "./BookViews";

export interface DomAnalyzerContext {
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
  readonly microstructure: MicrostructureMetrics;
  readonly domWallHistory: LiquidityWall[];
  readonly domWallHistoryLimit: number;
  readonly domScanRangePct: number;
  readonly domSpoofProximityBps: number;
  readonly domMaxLevelsPerSide: number;
  readonly resolveBinSize: (instrumentCode: string) => number;
}

export function currentDomHeatmapSnapshot(
  context: DomAnalyzerContext,
  cachedDom: DomAnalysisSnapshot | null,
  instrumentCode: string | undefined,
  observedAt: string
): DomAnalysisSnapshot {
  const selected = selectDomMarketKey(context, instrumentCode);
  const normalizedInstrument =
    selected?.instrumentCode ??
    instrumentCode?.toLowerCase() ??
    context.microstructure.instrumentCode ??
    "unknown";

  if (cachedDom?.instrumentCode === normalizedInstrument) {
    return cachedDom;
  }

  return buildDomAnalysisSnapshot(context, normalizedInstrument, observedAt, undefined, false);
}

export function buildDomAnalysisSnapshot(
  context: DomAnalyzerContext,
  instrumentCode: string | undefined,
  observedAt: string,
  tick: MarketTick | undefined,
  persistHistory: boolean
): DomAnalysisSnapshot {
  const selected = tick
    ? selectDomMarketKey(context, tick)
    : selectDomMarketKey(context, instrumentCode);
  const normalizedInstrument =
    selected?.instrumentCode ??
    instrumentCode?.toLowerCase() ??
    context.microstructure.instrumentCode ??
    "unknown";
  const marketKey = selected?.marketKey ?? normalizeMarketKey(normalizedInstrument);
  const book = context.orderBook.get(marketKey);
  const binSize = context.resolveBinSize(normalizedInstrument);
  const midPrice = book?.midPrice ?? null;

  if (book === undefined || midPrice === null || midPrice <= 0) {
    return emptyDomSnapshot(
      normalizedInstrument,
      book?.exchangeCode ?? null,
      book?.sequence ?? null,
      midPrice,
      context.domScanRangePct,
      binSize,
      context.domWallHistory.slice(-context.domWallHistoryLimit),
      observedAt
    );
  }

  const lowerBound = roundCrypto(midPrice * (1 - context.domScanRangePct));
  const upperBound = roundCrypto(midPrice * (1 + context.domScanRangePct));
  const bidLevels = getInstrumentBook(context.bids, marketKey, "bid").range(
    lowerBound,
    upperBound,
    context.domMaxLevelsPerSide
  );
  const askLevels = getInstrumentBook(context.asks, marketKey, "ask").range(
    lowerBound,
    upperBound,
    context.domMaxLevelsPerSide
  );
  const bins = aggregateDomBins(bidLevels, askLevels, binSize);
  const stats = volumeStats(bins.map((bin) => bin.volume));
  const previousActiveWalls = latestActiveWalls(context.domWallHistory, normalizedInstrument);
  const walls = bins
    .filter((bin) => isLiquidityWall(bin.volume, stats.mean, stats.sigma))
    .map((bin) =>
      toLiquidityWall(
        bin,
        normalizedInstrument,
        book.exchangeCode,
        book.sequence,
        midPrice,
        stats.mean,
        stats.sigma,
        previousActiveWalls.get(wallIdForBin(normalizedInstrument, bin)),
        observedAt
      )
    );
  const currentWallIds = new Set(walls.map((wall) => wall.wallId));
  const transitions = classifyMissingWalls(
    previousActiveWalls,
    currentWallIds,
    tick,
    observedAt,
    binSize,
    context.domSpoofProximityBps,
    midPrice
  );
  const pulledWalls = transitions.filter(
    (wall) => wall.status === "PULLED" && wall.spoofingSuspected
  );
  const filledWalls = transitions.filter((wall) => wall.status === "FILLED");
  const history = persistHistory
    ? appendDomHistory(context.domWallHistory, context.domWallHistoryLimit, [
        ...walls,
        ...transitions
      ])
    : context.domWallHistory.slice(-context.domWallHistoryLimit);

  return {
    schemaVersion: "dom.analysis.v1",
    instrumentCode: normalizedInstrument,
    exchangeCode: book.exchangeCode,
    sequence: book.sequence,
    midPrice,
    scanRangePct: context.domScanRangePct,
    lowerBound,
    upperBound,
    binSize,
    meanVolume: stats.mean,
    sigmaVolume: stats.sigma,
    walls,
    pulledWalls,
    filledWalls,
    heatmap: {
      schemaVersion: "dom.heatmap.v1",
      columns: ["side", "priceStart", "priceEnd", "volume", "levelCount", "zScore"],
      sideEncoding: { bid: 0, ask: 1 },
      cells: bins.map((bin) => domHeatmapCell(bin, stats.mean, stats.sigma))
    },
    history,
    updatedAt: observedAt
  };
}

export function appendDomHistory(
  history: LiquidityWall[],
  historyLimit: number,
  events: LiquidityWall[]
): LiquidityWall[] {
  if (events.length > 0) {
    history.push(...events);
  }

  if (history.length > historyLimit) {
    history.splice(0, history.length - historyLimit);
  }

  return history.slice(-historyLimit);
}

function selectDomMarketKey(
  context: DomAnalyzerContext,
  target?: string | MarketTick
): BookSelection | null {
  return selectOrderBookMarketKey(
    {
      orderBook: context.orderBook,
      microstructure: context.microstructure
    },
    target
  );
}
