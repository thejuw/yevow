import { ANOMALY_DETECTOR_STORAGE_KEY } from "../../../agents/AnomalyDetector";
import {
  PROFILER_STATE_STORAGE_KEY,
  PROFILER_STATE_STORAGE_PREFIX
} from "../../../agents/ProfilerAgent";
import { LIQUIDATION_HEATMAP_STORAGE_KEY } from "../../../agents/HeatmapAgent";
import {
  CASCADE_POSITIONS_KEY,
  CONFIG_KEY,
  DOM_WALL_HISTORY_KEY,
  ENGINE_STATE_KEY,
  ORDER_BOOK_PREFIX,
  PERFORMANCE_HISTORY_KEY,
  PROCESSING_LATENCY_SAMPLES_KEY,
  RATE_LIMIT_STATE_KEY,
  RISK_LIMITS_KEY
} from "../../../TradingEngineConstants";
import type { RateLimitBucketSnapshot } from "../../../utils/RateLimiter";
import type {
  AdminConfigUpdate,
  AnomalyDetectorState,
  EngineState,
  Env,
  InternalOrderBook,
  LatencyMetrics,
  LiquidationHeatmapState,
  LiquidityWall,
  ProfilerState,
  RiskLimits
} from "../../../types";
import type { CascadeOpenPosition } from "../../../strategy/cascade/types";

export interface EngineBootStorageSnapshot {
  readonly persistedState: EngineState | undefined;
  readonly persistedBooks: Map<string, InternalOrderBook>;
  readonly persistedLatencyHistory: LatencyMetrics[] | undefined;
  readonly persistedProcessingLatencySamples: number[] | undefined;
  readonly persistedDomWallHistory: LiquidityWall[] | undefined;
  readonly persistedProfilerState: ProfilerState | undefined;
  readonly persistedProfilerStates: Map<string, ProfilerState>;
  readonly persistedHeatmapState: LiquidationHeatmapState | undefined;
  readonly persistedAnomalyState: AnomalyDetectorState | undefined;
  readonly persistedRateLimits: Record<string, RateLimitBucketSnapshot> | undefined;
  readonly persistedCascadePositions: CascadeOpenPosition[] | undefined;
  readonly kvRiskLimits: Partial<RiskLimits> | null;
  readonly kvConfig: AdminConfigUpdate | null;
}

export async function readEngineBootStorageSnapshot(input: {
  readonly storage: DurableObjectStorage;
  readonly env: Env;
  readonly onReadFailure: (reason: string, error: unknown) => void;
}): Promise<EngineBootStorageSnapshot> {
  let kvRiskLimits: Partial<RiskLimits> | null = null;
  let kvConfig: AdminConfigUpdate | null = null;

  try {
    const [
      persistedState,
      persistedBooks,
      persistedLatencyHistory,
      persistedProcessingLatencySamples,
      persistedDomWallHistory,
      persistedProfilerState,
      persistedProfilerStates,
      persistedHeatmapState,
      persistedAnomalyState,
      persistedRateLimits,
      persistedCascadePositions,
      nextRiskLimits,
      nextConfig
    ] = await Promise.all([
      input.storage.get<EngineState>(ENGINE_STATE_KEY),
      input.storage.list<InternalOrderBook>({ prefix: ORDER_BOOK_PREFIX }),
      input.storage.get<LatencyMetrics[]>(PERFORMANCE_HISTORY_KEY),
      input.storage.get<number[]>(PROCESSING_LATENCY_SAMPLES_KEY),
      input.storage.get<LiquidityWall[]>(DOM_WALL_HISTORY_KEY),
      input.storage.get<ProfilerState>(PROFILER_STATE_STORAGE_KEY),
      input.storage.list<ProfilerState>({ prefix: PROFILER_STATE_STORAGE_PREFIX }),
      input.storage.get<LiquidationHeatmapState>(LIQUIDATION_HEATMAP_STORAGE_KEY),
      input.storage.get<AnomalyDetectorState>(ANOMALY_DETECTOR_STORAGE_KEY),
      input.storage.get<Record<string, RateLimitBucketSnapshot>>(RATE_LIMIT_STATE_KEY),
      input.storage.get<CascadeOpenPosition[]>(CASCADE_POSITIONS_KEY),
      input.env.RISK_VAULT.get<Partial<RiskLimits>>(RISK_LIMITS_KEY, "json"),
      input.env.CONFIG_STORE.get<AdminConfigUpdate>(CONFIG_KEY, "json")
    ]);

    return {
      persistedState,
      persistedBooks,
      persistedLatencyHistory,
      persistedProcessingLatencySamples,
      persistedDomWallHistory,
      persistedProfilerState,
      persistedProfilerStates,
      persistedHeatmapState,
      persistedAnomalyState,
      persistedRateLimits,
      persistedCascadePositions,
      kvRiskLimits: nextRiskLimits,
      kvConfig: nextConfig
    };
  } catch (error) {
    input.onReadFailure("SYSTEM_INIT_STORAGE_READ", error);
    try {
      [kvRiskLimits, kvConfig] = await Promise.all([
        input.env.RISK_VAULT.get<Partial<RiskLimits>>(RISK_LIMITS_KEY, "json"),
        input.env.CONFIG_STORE.get<AdminConfigUpdate>(CONFIG_KEY, "json")
      ]);
    } catch (kvError) {
      input.onReadFailure("SYSTEM_INIT_KV_FALLBACK_READ", kvError);
    }
  }

  return {
    persistedState: undefined,
    persistedBooks: new Map<string, InternalOrderBook>(),
    persistedLatencyHistory: undefined,
    persistedProcessingLatencySamples: undefined,
    persistedDomWallHistory: undefined,
    persistedProfilerState: undefined,
    persistedProfilerStates: new Map<string, ProfilerState>(),
    persistedHeatmapState: undefined,
    persistedAnomalyState: undefined,
    persistedRateLimits: undefined,
    persistedCascadePositions: undefined,
    kvRiskLimits,
    kvConfig
  };
}
