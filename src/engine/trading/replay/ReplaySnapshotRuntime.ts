import { ANOMALY_DETECTOR_STORAGE_KEY } from "../../../agents/AnomalyDetector";
import { PROFILER_STATE_STORAGE_KEY } from "../../../agents/ProfilerAgent";
import {
  DOM_WALL_HISTORY_KEY,
  ENGINE_STATE_KEY,
  ORDER_BOOK_PREFIX,
  PERFORMANCE_HISTORY_KEY,
  PROCESSING_LATENCY_SAMPLES_KEY,
  RATE_LIMIT_STATE_KEY
} from "../../../TradingEngineConstants";
import { hydrateOrderBooks, profilerStorageKey } from "../helpers/RuntimeHelpers";
import type { RateLimitBucketSnapshot } from "../../../utils/RateLimiter";
import type {
  AgentName,
  AgentSignal,
  AnomalyDetectorState,
  EngineState,
  GlobalRiskConfig,
  InternalOrderBook,
  LatencyMetrics,
  LiquidityWall,
  ProfilerState
} from "../../../types";

export interface EngineReplaySnapshot {
  engineState: EngineState;
  orderBooks: InternalOrderBook[];
  latencyHistory: LatencyMetrics[];
  processingLatencySamples: number[];
  domWallHistory: LiquidityWall[];
  leadLagSamples: [string, { price: number; observedAt: string }[]][];
  cachedConfig: GlobalRiskConfig;
  maxLatencyMs: number;
  lastTickTimestamp: string | null;
  profilerState: ProfilerState;
  profilerStates: [string, ProfilerState][];
  anomalyState: AnomalyDetectorState;
  oracleState: EngineState["oracle"];
  sentimentState: EngineState["sentiment"];
  rateLimits: Record<string, RateLimitBucketSnapshot>;
  signals: AgentSignal[];
  latestAgentSignals: [AgentName, AgentSignal][];
}

export function hydrateReplayOrderBooks(
  snapshot: EngineReplaySnapshot
): ReturnType<typeof hydrateOrderBooks> {
  return hydrateOrderBooks(
    new Map(snapshot.orderBooks.map((book) => [`${ORDER_BOOK_PREFIX}${book.marketKey}`, book]))
  );
}

export function buildReplayRestoreWrites(snapshot: EngineReplaySnapshot): Record<string, unknown> {
  return {
    [ENGINE_STATE_KEY]: snapshot.engineState,
    [PERFORMANCE_HISTORY_KEY]: snapshot.latencyHistory,
    [PROCESSING_LATENCY_SAMPLES_KEY]: snapshot.processingLatencySamples,
    [DOM_WALL_HISTORY_KEY]: snapshot.domWallHistory,
    [PROFILER_STATE_STORAGE_KEY]: snapshot.profilerState,
    ...Object.fromEntries(
      snapshot.profilerStates.map(([instrumentCode, state]) => [
        profilerStorageKey(instrumentCode),
        state
      ])
    ),
    [ANOMALY_DETECTOR_STORAGE_KEY]: snapshot.anomalyState,
    [RATE_LIMIT_STATE_KEY]: snapshot.rateLimits,
    ...Object.fromEntries(
      snapshot.orderBooks.map((book) => [`${ORDER_BOOK_PREFIX}${book.marketKey}`, book])
    )
  };
}
