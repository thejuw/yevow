import { ANOMALY_DETECTOR_STORAGE_KEY } from "../../../agents/AnomalyDetector";
import { PROFILER_STATE_STORAGE_KEY } from "../../../agents/ProfilerAgent";
import {
  DOM_WALL_HISTORY_KEY,
  ENGINE_STATE_KEY,
  DEFAULT_MARKET_TICK_JOURNAL_INTERVAL,
  ORDER_BOOK_PREFIX,
  PERFORMANCE_HISTORY_KEY,
  PROCESSING_LATENCY_SAMPLES_KEY
} from "../../../TradingEngineConstants";
import { profilerStorageKey } from "../book/BookRuntimeHelpers";
import type {
  AnomalyDetectorState,
  EngineState,
  InternalOrderBook,
  LatencyMetrics,
  LiquidityWall,
  MarketTick,
  ProfilerState
} from "../../../types";

export interface HotPathTickSnapshotWritesInput {
  readonly engineState: EngineState;
  readonly latencyHistory: LatencyMetrics[];
  readonly processingLatencySamples: number[];
  readonly domWallHistory: LiquidityWall[];
  readonly anomalyDetectorState: AnomalyDetectorState;
  readonly book: InternalOrderBook;
  readonly tick: MarketTick;
  readonly profilerProcessed: boolean;
  readonly profilerState: ProfilerState;
}

export function buildHotPathTickSnapshotWrites(
  input: HotPathTickSnapshotWritesInput
): Record<string, unknown> {
  const writes: Record<string, unknown> = {
    [ENGINE_STATE_KEY]: input.engineState,
    [PERFORMANCE_HISTORY_KEY]: input.latencyHistory,
    [PROCESSING_LATENCY_SAMPLES_KEY]: input.processingLatencySamples,
    [DOM_WALL_HISTORY_KEY]: input.domWallHistory,
    [ANOMALY_DETECTOR_STORAGE_KEY]: input.anomalyDetectorState,
    [`${ORDER_BOOK_PREFIX}${input.book.marketKey}`]: input.book,
    [`lastTick:${input.book.marketKey}`]: input.tick
  };

  if (input.profilerProcessed) {
    writes[profilerStorageKey(input.tick.instrumentCode)] = input.profilerState;
    if (input.tick.instrumentCode === "btc-usd") {
      writes[PROFILER_STATE_STORAGE_KEY] = input.profilerState;
    }
  }

  return writes;
}

export function shouldJournalMarketTick(
  processedTicks: number,
  configuredInterval: string | number | undefined
): boolean {
  const parsedInterval = Number(configuredInterval);
  const interval = Number.isFinite(parsedInterval)
    ? Math.max(0, Math.floor(parsedInterval))
    : DEFAULT_MARKET_TICK_JOURNAL_INTERVAL;

  if (interval === 0) {
    return false;
  }

  return processedTicks <= 5 || processedTicks % interval === 0;
}
