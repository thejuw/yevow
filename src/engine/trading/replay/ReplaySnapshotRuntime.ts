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
import { hydrateOrderBooks, profilerStorageKey } from "../book/BookRuntimeHelpers";
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
import { deepClone } from "../helpers/RuntimeSerialization";

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

export interface CaptureEngineReplaySnapshotInput {
  readonly engineState: EngineState;
  readonly orderBooks: Iterable<InternalOrderBook>;
  readonly latencyHistory: readonly LatencyMetrics[];
  readonly processingLatencySamples: readonly number[];
  readonly domWallHistory: readonly LiquidityWall[];
  readonly leadLagSamples: Iterable<[string, { price: number; observedAt: string }[]]>;
  readonly cachedConfig: GlobalRiskConfig;
  readonly maxLatencyMs: number;
  readonly lastTickTimestamp: string | null;
  readonly profilerState: ProfilerState;
  readonly profilerStates: Iterable<[string, ProfilerState]>;
  readonly anomalyState: AnomalyDetectorState;
  readonly oracleState: EngineState["oracle"];
  readonly sentimentState: EngineState["sentiment"];
  readonly rateLimits: Record<string, RateLimitBucketSnapshot>;
  readonly signals: readonly AgentSignal[];
  readonly latestAgentSignals: Iterable<[AgentName, AgentSignal]>;
}

export function captureEngineReplaySnapshot(
  input: CaptureEngineReplaySnapshotInput
): EngineReplaySnapshot {
  return {
    engineState: deepClone(input.engineState),
    orderBooks: deepClone([...input.orderBooks]),
    latencyHistory: deepClone([...input.latencyHistory]),
    processingLatencySamples: [...input.processingLatencySamples],
    domWallHistory: deepClone([...input.domWallHistory]),
    leadLagSamples: deepClone([...input.leadLagSamples]),
    cachedConfig: deepClone(input.cachedConfig),
    maxLatencyMs: input.maxLatencyMs,
    lastTickTimestamp: input.lastTickTimestamp,
    profilerState: input.profilerState,
    profilerStates: deepClone([...input.profilerStates]),
    anomalyState: input.anomalyState,
    oracleState: input.oracleState,
    sentimentState: input.sentimentState,
    rateLimits: input.rateLimits,
    signals: deepClone([...input.signals]),
    latestAgentSignals: deepClone([...input.latestAgentSignals])
  };
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
