import type { ConfigManager } from "../../../ConfigManager";
import type { Governor } from "../../../Governor";
import { ENGINE_STATE_KEY, PERFORMANCE_HISTORY_LIMIT } from "../../../TradingEngineConstants";
import type { RateLimitBucketSnapshot } from "../../../utils/RateLimiter";
import type { GhostBook } from "../../../utils/GhostBook";
import type { Logger } from "../../../Logger";
import type { NewsCalendar } from "../../../strategy/cascade/NewsCalendar";
import type { CascadeOpenPosition } from "../../../strategy/cascade/types";
import type { AnomalyDetector } from "../../../agents/AnomalyDetector";
import type { HeatmapAgent } from "../../../agents/HeatmapAgent";
import type { ProfilerRegistry } from "../../../agents/ProfilerRegistry";
import type { OracleAgent } from "../../../agents/OracleAgent";
import type { SentimentAgent } from "../../../agents/SentimentAgent";
import type {
  EngineState,
  Env,
  GlobalRiskConfig,
  InternalOrderBook,
  LatencyMetrics,
  LiquidityWall,
  MacroBias,
  AnomalyStatus,
  TemporaryGovernanceOverride
} from "../../../types";
import type { BookSyncState } from "../book/BookTypes";
import type { SortedBookSide } from "../book/SortedBookSide";
import {
  rebindTradingOrderBookReconstructorForTarget,
  type TradingOrderBookRebindTarget
} from "../book/OrderBookReconstructorFactory";
import {
  ensureCascadePaperModeArmedForTarget,
  type CascadePaperModeArmingTarget
} from "../cascade/CascadePaperModeRuntime";
import { scheduleTradingConfigRefreshForTarget } from "../config/TradingConfigControlRuntime";
import { filterTargetOrderBooks } from "./AssetSelectionRuntime";
import { defaultEngineState, resolveMaxLatencyMs } from "./EngineStateDefaults";
import { buildHydratedEngineState, hydrateEngineBootCollections } from "./EngineBootState";
import { readEngineBootStorageSnapshot } from "./EngineBootStorage";
import { recordTradingStorageWriteFailureForTargetOrHandler } from "./StorageWriteGuard";

export interface TradingEngineBootHydrationTarget {
  readonly state: DurableObjectState;
  readonly env: Env;
  orderBook: Map<string, InternalOrderBook>;
  bids: Map<string, SortedBookSide>;
  asks: Map<string, SortedBookSide>;
  bookSync: Map<string, BookSyncState>;
  cachedConfig: GlobalRiskConfig;
  macroBias: MacroBias;
  activeTemporaryOverride: TemporaryGovernanceOverride | null;
  maxLatencyMs: number;
  lastTickTimestamp: string | null;
  latencyHistory: LatencyMetrics[];
  processingLatencySamples: number[];
  domWallHistory: LiquidityWall[];
  engineState: EngineState;
  lastPerformanceStatus: EngineState["executionProfile"]["status"];
  readonly jitterSampleWindow: number;
  readonly jitterComputeIntervalTicks: number;
  readonly jitterThresholdMs: number;
  readonly domWallHistoryLimit: number;
  readonly ghostBook: Pick<GhostBook, "hydrate" | "snapshot">;
  readonly cascadePositionManager: {
    hydrate(positions: readonly CascadeOpenPosition[]): void;
  };
  readonly profilerRegistry: Pick<ProfilerRegistry, "hydrate" | "configure" | "snapshot">;
  readonly heatmapAgent: Pick<HeatmapAgent, "hydrate" | "snapshot">;
  readonly anomalyDetector: Pick<AnomalyDetector, "hydrate"> & {
    readonly status: AnomalyStatus;
  };
  readonly rateLimiter: {
    hydrate(snapshot: Record<string, RateLimitBucketSnapshot> | undefined): void;
  };
  readonly oracleAgent: Pick<OracleAgent, "hydrate">;
  readonly sentimentAgent: Pick<SentimentAgent, "hydrate">;
  readonly governor: Pick<Governor, "readEffectiveConfig">;
  readonly configManager: Pick<ConfigManager, "fetchConfig">;
  readonly cascadeNewsCalendar: Pick<NewsCalendar, "refresh">;
  readonly logger: Pick<Logger, "info">;
  handleStorageWriteFailure?(reason: string, error: unknown): void;
  ensureCascadePaperModeArmed?(observedAt: string): Promise<void>;
  safeStoragePut(key: string, value: unknown, reason: string): Promise<void>;
  scheduleConfigRefresh?(): Promise<void>;
}

export async function hydrateTradingEngineBootForTarget(
  target: TradingEngineBootHydrationTarget
): Promise<void> {
  const snapshot = await readEngineBootStorageSnapshot({
    storage: target.state.storage,
    env: target.env,
    onReadFailure: (reason, error) => {
      recordTradingStorageWriteFailureForTargetOrHandler(target, reason, error);
    }
  });
  const baseState = snapshot.persistedState ?? defaultEngineState(target.state.id.toString());
  const now = new Date().toISOString();
  const bootCollections = hydrateEngineBootCollections({
    persistedBooks: snapshot.persistedBooks,
    persistedLatencyHistory: snapshot.persistedLatencyHistory,
    persistedProcessingLatencySamples: snapshot.persistedProcessingLatencySamples,
    persistedDomWallHistory: snapshot.persistedDomWallHistory,
    performanceHistoryLimit: PERFORMANCE_HISTORY_LIMIT,
    jitterSampleWindow: target.jitterSampleWindow,
    domWallHistoryLimit: target.domWallHistoryLimit,
    filterTargetOrderBooks
  });
  const hydratedBooks = bootCollections.hydratedBooks;

  target.orderBook = hydratedBooks.snapshots;
  target.bids = hydratedBooks.bids;
  target.asks = hydratedBooks.asks;
  target.bookSync = hydratedBooks.sync;
  rebindTradingOrderBookReconstructorForTarget(target as unknown as TradingOrderBookRebindTarget);
  target.ghostBook.hydrate(baseState.shadowQueue);
  target.cascadePositionManager.hydrate(snapshot.persistedCascadePositions ?? []);
  target.profilerRegistry.hydrate(
    snapshot.persistedProfilerState,
    snapshot.persistedProfilerStates
  );
  target.heatmapAgent.hydrate(snapshot.persistedHeatmapState ?? baseState.liquidationHeatmap);
  target.anomalyDetector.hydrate(snapshot.persistedAnomalyState);
  target.rateLimiter.hydrate(snapshot.persistedRateLimits);
  target.oracleAgent.hydrate(baseState.oracle);
  target.sentimentAgent.hydrate(baseState.sentiment);
  target.lastTickTimestamp = baseState.microstructure?.updatedAt ?? baseState.updatedAt ?? null;
  target.latencyHistory = bootCollections.latencyHistory;
  target.processingLatencySamples = bootCollections.processingLatencySamples;
  target.domWallHistory = bootCollections.domWallHistory;
  target.maxLatencyMs = resolveMaxLatencyMs(snapshot.kvConfig, baseState.maxLatencyMs);

  const effectiveGovernance = await target.governor.readEffectiveConfig(
    await target.configManager.fetchConfig()
  );
  await target.cascadeNewsCalendar.refresh(true);
  target.cachedConfig = effectiveGovernance.config;
  target.macroBias = effectiveGovernance.macroBias;
  target.activeTemporaryOverride = effectiveGovernance.temporaryOverride;

  if (target.cachedConfig.STRATEGY_MODE === "CASCADE_RECOVERY") {
    const armCascadePaperMode = target.ensureCascadePaperModeArmed
      ? target.ensureCascadePaperModeArmed(now)
      : ensureCascadePaperModeArmedForTarget(
          now,
          target as unknown as CascadePaperModeArmingTarget
        ).then(() => undefined);
    target.state.waitUntil(armCascadePaperMode);
  }

  target.profilerRegistry.configure(target.cachedConfig);
  target.maxLatencyMs = target.cachedConfig.LATENCY_THRESHOLD_MS;
  target.engineState = buildHydratedEngineState({
    baseState,
    env: target.env,
    now,
    kvConfig: snapshot.kvConfig,
    kvRiskLimits: snapshot.kvRiskLimits,
    cachedConfig: target.cachedConfig,
    macroBias: target.macroBias,
    temporaryOverride: target.activeTemporaryOverride,
    orderBook: target.orderBook,
    bids: target.bids,
    asks: target.asks,
    liquidationHeatmap: target.heatmapAgent.snapshot(),
    profilerStates: target.profilerRegistry.snapshot(),
    shadowQueue: target.ghostBook.snapshot(now),
    anomaly: target.anomalyDetector.status,
    maxLatencyMs: target.maxLatencyMs,
    jitterThresholdMs: target.jitterThresholdMs,
    jitterSampleWindow: target.jitterSampleWindow,
    jitterComputeIntervalTicks: target.jitterComputeIntervalTicks,
    processingLatencySampleCount: target.processingLatencySamples.length
  });
  target.lastPerformanceStatus = target.engineState.executionProfile.status;

  await target.safeStoragePut(ENGINE_STATE_KEY, target.engineState, "SYSTEM_INIT");
  await (target.scheduleConfigRefresh
    ? target.scheduleConfigRefresh()
    : scheduleTradingConfigRefreshForTarget(
        target as unknown as { safeSetAlarm(timestamp: number, reason: string): Promise<void> }
      ));
  target.logger.info("SYSTEM_INIT", "Trading engine singleton initialized", {
    engineId: target.engineState.engineId,
    mode: target.engineState.mode,
    riskConfigVersion: target.engineState.risk.configVersion,
    nativeFeed: "HYPERLIQUID",
    hasExchangeApiKey: Boolean(target.env.EXCHANGE_API_KEY)
  });
}
