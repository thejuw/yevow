/* eslint-disable */
import { defaultConfig, type ConfigManager } from "../../ConfigManager";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { neutralMacroBias, type Governor } from "../../Governor";
import type { Logger } from "../../Logger";
import {
  ProfilerAgent,
  PROFILER_STATE_STORAGE_KEY,
  PROFILER_STATE_STORAGE_PREFIX
} from "../../agents/ProfilerAgent";
import { ProfilerRegistry } from "../../agents/ProfilerRegistry";
import { AnomalyDetector } from "../../agents/AnomalyDetector";
import { CroupierAgent } from "../../agents/CroupierAgent";
import { AdverseSelectionModel } from "../AdverseSelectionModel";
import { priceKey, SortedBookSide } from "./book/SortedBookSide";
import {
  resetTradingOrderBookForTarget,
  type TradingOrderBookResetTarget
} from "./book/OrderBookResetRuntime";
import { resolveMaxPositionPct } from "./risk/PortfolioRiskRuntime";
import {
  runTradingAlarmForTarget,
  type TradingAlarmRuntimeTarget
} from "./alarm/TradingAlarmRuntime";
import type { DispatchedQuoteSnapshot } from "./quotes/QuoteRefreshRuntime";
import {
  cancelAllTradingQuotesForTarget,
  type TradingQuoteCancelAllTarget
} from "./quotes/QuoteCancelRuntime";
import {
  dispatchTradingExecutionIntentForTarget,
  type TradingExecutionDispatchTarget
} from "./execution/TradingExecutionDispatchRuntime";
import { type ExecutionTraceInput } from "./performance/LatencyRuntime";
import {
  tradingLatencyStorageWritesForState,
  tradingLatencyStorageWritesForTarget,
  type TradingLatencyStateTarget
} from "./performance/TradingLatencyStateRuntime";
import { OrderBookReconstructor } from "./book/OrderBookReconstructor";
import {
  buildTradingOrderBookStoresForTarget,
  createTradingOrderBookReconstructor,
  type TradingOrderBookStoresTarget
} from "./book/OrderBookReconstructorFactory";
import type { BookSyncState } from "./book/BookTypes";
import {
  enqueueTradingIngestJob,
  type TradingIngestQueueTarget
} from "./ingest/IngestQueueRuntime";
import {
  handleTradingEngineFetchForTarget,
  type TradingEngineFetchTarget
} from "./routes/EngineFetchRuntime";
import type { TradingTelemetryBus } from "./telemetry/TelemetryBus";
import {
  logTradingPerformanceForTarget,
  observeTradingExecutionProfileForTarget,
  publishTradingTickTelemetryForTarget,
  type TradingHotPathTelemetryTarget
} from "./telemetry/TradingHotPathTelemetryRuntime";
import { type ReplayJournal } from "./replay/ReplayJournal";
import type { TickIngestResult } from "./TradingEngineRouteTypes";
import {
  createBootAbsorptionAnalyzer,
  createBootAnomalyDetector,
  createBootCascadeDetector,
  createBootCroupierAgent,
  createBootHeatmapAgent,
  createBootProfilerAgent,
  resolveEngineBootRuntimeSettings
} from "./state/EngineBootConfig";
import {
  hydrateTradingEngineBootForTarget,
  type TradingEngineBootHydrationTarget
} from "./state/EngineBootRuntime";
import {
  createTradingEngineBootServices,
  tradingEngineLoggerRuntimeContext
} from "./state/EngineBootServices";
import {
  recoverTradingEngineStateForTarget,
  type TradingAdminRecoveryTarget
} from "./state/RecoveryRuntime";
import {
  applyHotStorageSnapshotForTarget,
  deleteTradingStorageForTarget,
  putTradingStorageForTarget,
  recordTradingStorageWriteFailureForTarget,
  setTradingStorageAlarmForTarget,
  waitUntilTradingStoragePutForTarget,
  type TradingHotStorageSnapshotTarget,
  type TradingStorageGuardTarget,
  type StorageWriteGuard
} from "./state/StorageWriteGuard";
import { MultiScaleVolatilityModel } from "../MultiScaleVolatility";
import { QueuePositionModel } from "../QueuePositionModel";
import { HeatmapAgent } from "../../agents/HeatmapAgent";
import { JanitorAgent } from "../../agents/JanitorAgent";
import { OracleAgent } from "../../agents/OracleAgent";
import { PitBossAgent } from "../../agents/PitBossAgent";
import { SentimentAgent } from "../../agents/SentimentAgent";
import { RateLimiter, type RateLimitBucketSnapshot } from "../../utils/RateLimiter";
import type { Notifier } from "../../utils/Notifier";
import type { GhostBook } from "../../utils/GhostBook";
import { AbsorptionAnalyzer } from "../../strategy/cascade/AbsorptionAnalyzer";
import type { Backtester } from "../../strategy/cascade/Backtester";
import { CascadeCandleAggregator } from "../../strategy/cascade/CandleAggregator";
import { CascadeDetector } from "../../strategy/cascade/CascadeDetector";
import { HyperliquidLiquidationStream } from "../../strategy/cascade/LiquidationStream";
import { HeatManager } from "../../strategy/cascade/HeatManager";
import type { NewsCalendar } from "../../strategy/cascade/NewsCalendar";
import { PositionManager } from "../../strategy/cascade/PositionManager";
import type {
  EngineStabilityStatus,
  AgentName,
  AgentSignal,
  EngineState,
  Env,
  GlobalRiskConfig,
  InternalOrderBook,
  JsonRecord,
  LatencyMetrics,
  LiquidityWall,
  MacroBias,
  MarketTick,
  OrderBookResetRequest,
  TemporaryGovernanceOverride,
  TradeIntent
} from "../../types";
import type { AbsorptionConfirmed, CascadeEvent } from "../../strategy/cascade/types";

import { DEFAULT_MAX_LATENCY_MS } from "../../TradingEngineConstants";
import { defaultEngineState } from "./state/EngineStateDefaults";
import {
  handleTickForTarget,
  type TradingTickHandlingTarget
} from "./pipelines/TickHandlingRuntime";
import type { TickHandlingOptions } from "./pipelines/TickPipelineTypes";

export class TradingEngine {
  private readonly startedAt = Date.now();
  private readonly initialized: Promise<void>;
  private readonly configManager: ConfigManager;
  private readonly governor: Governor;
  private readonly logger: Logger;
  private readonly notifier: Notifier;
  private readonly ghostBook: GhostBook;
  private readonly profilerAgent: ProfilerAgent;
  private readonly profilerRegistry: ProfilerRegistry;
  private readonly heatmapAgent: HeatmapAgent;
  private readonly cascadeLiquidationStream = new HyperliquidLiquidationStream();
  private readonly cascadeDetector: CascadeDetector;
  private readonly absorptionAnalyzer: AbsorptionAnalyzer;
  private readonly candleAggregator = new CascadeCandleAggregator(["1m", "5m", "1h"]);
  private readonly cascadePositionManager = new PositionManager();
  private readonly cascadeNewsCalendar: NewsCalendar;
  private readonly cascadeBacktester: Backtester;
  private readonly cascadeHeatManager = new HeatManager();
  private readonly anomalyDetector: AnomalyDetector;
  private readonly sentimentAgent = new SentimentAgent();
  private readonly oracleAgent = new OracleAgent();
  private readonly croupierAgent: CroupierAgent;
  private readonly pitBossAgent = new PitBossAgent(0.5);
  private readonly janitorAgent = new JanitorAgent();
  private readonly adverseSelectionModel = new AdverseSelectionModel();
  private readonly multiScaleVolatility = new MultiScaleVolatilityModel();
  private readonly queuePositionModel = new QueuePositionModel();
  private readonly rateLimiter = new RateLimiter();
  private readonly jitterSampleWindow: number;
  private readonly jitterComputeIntervalTicks: number;
  private readonly jitterThresholdMs: number;
  private readonly domPriceBinSize: number;
  private readonly domScanRangePct: number;
  private readonly domWallHistoryLimit: number;
  private readonly domSpoofProximityBps: number;
  private readonly orderBookReconstructor: OrderBookReconstructor;
  private readonly storageGuard: StorageWriteGuard;
  private ingestQueue: Promise<void> = Promise.resolve();
  private orderBook = new Map<string, InternalOrderBook>();
  private bids = new Map<string, SortedBookSide>();
  private asks = new Map<string, SortedBookSide>();
  private bookSync = new Map<string, BookSyncState>();
  private activeIngestConnections = new Map<string, string>();
  private readonly adminSockets = new Set<WebSocket>();
  private readonly telemetryBus: TradingTelemetryBus;
  private readonly replayJournal: ReplayJournal;
  private signals: AgentSignal[] = [];
  private latestAgentSignals = new Map<AgentName, AgentSignal>();
  private paperExecutionWindowStartedAtMs = Date.now();
  private paperExecutionWindowCount = 0;
  private paperExecutionWindowDropped = 0;
  private paperExecutionThrottleLoggedAtMs = 0;
  private performanceSpikeLogAt = new Map<string, number>();
  private rateLimitDeferralLogAt = 0;
  private cancelAllLogAt = new Map<string, number>();
  private readonly lastDispatchedQuoteByInstrument = new Map<
    string,
    {
      bid: number | null;
      ask: number | null;
      updatedAtMs: number;
    }
  >();
  private quoteRefreshThrottleLogAt = new Map<string, number>();
  private crossAssetCancelLogAt = new Map<string, number>();
  private lastHedgeDispatchedAt = new Map<string, number>();
  private shadowQueueNoEdgeLogAt = new Map<string, number>();
  private latencyHistory: LatencyMetrics[] = [];
  private processingLatencySamples: number[] = [];
  private domWallHistory: LiquidityWall[] = [];
  private leadLagSamples = new Map<string, Array<{ price: number; observedAt: string }>>();
  private cascadeCvdByInstrument = new Map<string, number>();
  private cascadeAbsorptionsById = new Map<string, AbsorptionConfirmed>();
  private cascadeEventsById = new Map<string, CascadeEvent>();
  private maxLatencyMs = DEFAULT_MAX_LATENCY_MS;
  private latestWakeUpTimeMs: number | null = null;
  private lastPerformanceStatus: EngineStabilityStatus = "STABLE";
  private lastTickTimestamp: string | null = null;
  private cachedConfig: GlobalRiskConfig = { ...defaultConfig };
  private macroBias: MacroBias = neutralMacroBias();
  private activeTemporaryOverride: TemporaryGovernanceOverride | null = null;
  private killSwitchLogged = false;
  private lastConfigRefreshAttemptAt = 0;
  private warmedColo: string | null = null;
  private warmedAt = 0;
  private lastHotStorageSnapshotAt = 0;
  private lastHotStorageSnapshotTick = 0;
  private engineState: EngineState = defaultEngineState("booting");

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {
    const bootServices = createTradingEngineBootServices({
      env,
      storage: state.storage,
      adminSockets: this.adminSockets,
      waitUntil: (promise) => state.waitUntil(promise),
      runtimeContext: () =>
        tradingEngineLoggerRuntimeContext({
          lastTickTimestamp: this.lastTickTimestamp,
          engineState: this.engineState
        }),
      readStorage: (key) => state.storage.get(key),
      writeStorage: (key, value, reason) => this.safeStoragePut(key, value, reason),
      publish: (type, payload, correlationId) => this.publish(type, payload, correlationId),
      onStorageReadFailure: (reason, error) => this.handleStorageWriteFailure(reason, error)
    });
    this.configManager = bootServices.configManager;
    this.governor = bootServices.governor;
    this.cascadeNewsCalendar = bootServices.cascadeNewsCalendar;
    this.cascadeBacktester = bootServices.cascadeBacktester;
    this.ghostBook = bootServices.ghostBook;
    this.storageGuard = bootServices.storageGuard;
    this.telemetryBus = bootServices.telemetryBus;
    this.logger = bootServices.logger;
    this.notifier = bootServices.notifier;
    this.replayJournal = bootServices.replayJournal;

    const runtimeSettings = resolveEngineBootRuntimeSettings(env);
    this.jitterSampleWindow = runtimeSettings.jitterSampleWindow;
    this.jitterComputeIntervalTicks = runtimeSettings.jitterComputeIntervalTicks;
    this.jitterThresholdMs = runtimeSettings.jitterThresholdMs;
    this.domPriceBinSize = runtimeSettings.domPriceBinSize;
    this.domScanRangePct = runtimeSettings.domScanRangePct;
    this.domWallHistoryLimit = runtimeSettings.domWallHistoryLimit;
    this.domSpoofProximityBps = runtimeSettings.domSpoofProximityBps;
    this.profilerAgent = createBootProfilerAgent(env);
    this.profilerRegistry = new ProfilerRegistry(env, this.profilerAgent, () => this.cachedConfig);
    this.heatmapAgent = createBootHeatmapAgent(env);
    this.cascadeDetector = createBootCascadeDetector(env);
    this.absorptionAnalyzer = createBootAbsorptionAnalyzer(env);
    this.anomalyDetector = createBootAnomalyDetector(env);
    this.croupierAgent = createBootCroupierAgent(env);
    this.rateLimiter.configure("default", 10, 10);
    this.orderBookReconstructor = createTradingOrderBookReconstructor({
      env,
      stores: buildTradingOrderBookStoresForTarget(this as unknown as TradingOrderBookStoresTarget),
      logger: this.logger,
      publish: (type, payload) => this.publish(type, payload),
      resetOrderBook: (payload) => this.resetOrderBook(payload)
    });

    this.initialized = this.state.blockConcurrencyWhile(() =>
      hydrateTradingEngineBootForTarget(this as unknown as TradingEngineBootHydrationTarget)
    );
  }

  async alarm(): Promise<void> {
    await runTradingAlarmForTarget(this as unknown as TradingAlarmRuntimeTarget);
  }

  async fetch(request: Request): Promise<Response> {
    return handleTradingEngineFetchForTarget(request, this as unknown as TradingEngineFetchTarget);
  }

  private async safeStoragePut(key: string, value: unknown, reason: string): Promise<void>;
  private async safeStoragePut(entries: Record<string, unknown>, reason: string): Promise<void>;
  private async safeStoragePut(
    keyOrEntries: string | Record<string, unknown>,
    valueOrReason: unknown,
    maybeReason?: string
  ): Promise<void> {
    await putTradingStorageForTarget(
      this as unknown as TradingStorageGuardTarget,
      keyOrEntries,
      valueOrReason,
      maybeReason
    );
  }

  private waitUntilStoragePut(key: string, value: unknown, reason: string): void {
    waitUntilTradingStoragePutForTarget(
      this as unknown as TradingStorageGuardTarget,
      key,
      value,
      reason
    );
  }

  private async safeStorageDelete(keys: string[], reason: string): Promise<void> {
    await deleteTradingStorageForTarget(this as unknown as TradingStorageGuardTarget, keys, reason);
  }

  private async safeSetAlarm(timestamp: number, reason: string): Promise<void> {
    await setTradingStorageAlarmForTarget(
      this as unknown as TradingStorageGuardTarget,
      timestamp,
      reason
    );
  }

  private async persistHotStorageSnapshot(
    entries: Record<string, unknown>,
    reason: string
  ): Promise<void> {
    await applyHotStorageSnapshotForTarget(
      entries,
      reason,
      this as unknown as TradingHotStorageSnapshotTarget
    );
  }

  private handleStorageWriteFailure(reason: string, error: unknown): void {
    recordTradingStorageWriteFailureForTarget(
      this as unknown as TradingStorageGuardTarget,
      reason,
      error
    );
  }

  private enqueueTick(
    tick: MarketTick,
    wakeUpTimeMs: number | null = this.latestWakeUpTimeMs,
    options: TickHandlingOptions = {}
  ): Promise<TickIngestResult> {
    return enqueueTradingIngestJob(this as unknown as TradingIngestQueueTarget, () =>
      this.handleTick(tick, wakeUpTimeMs, options)
    );
  }

  private async resetOrderBook(payload: Partial<OrderBookResetRequest>): Promise<void> {
    await resetTradingOrderBookForTarget(payload, this as unknown as TradingOrderBookResetTarget);
  }

  private async recoverEngineState(payload: {
    reason?: string;
    resetInstruments?: string[] | string;
    instrumentCode?: string;
    source_exchange?: string;
    clearCitadel?: boolean;
    clearQuoteState?: boolean;
    clearLatency?: boolean;
    resetPaperPortfolio?: boolean;
    clearShadowQueue?: boolean;
  }): Promise<JsonRecord> {
    return recoverTradingEngineStateForTarget(
      payload,
      this as unknown as TradingAdminRecoveryTarget
    );
  }

  private async handleTick(
    tick: MarketTick,
    wakeUpTimeMs: number | null,
    options: TickHandlingOptions = {}
  ): Promise<TickIngestResult> {
    return handleTickForTarget(
      tick,
      wakeUpTimeMs,
      options,
      this as unknown as TradingTickHandlingTarget
    );
  }

  private async dispatchExecution(
    intent: NonNullable<EngineState["lastTradeIntent"]>,
    initialDelayMs = 0
  ): Promise<void> {
    await dispatchTradingExecutionIntentForTarget(
      intent,
      initialDelayMs,
      this as unknown as TradingExecutionDispatchTarget
    );
  }

  private async cancelAllQuotes(instrumentCode: string, reason: string): Promise<void> {
    await cancelAllTradingQuotesForTarget(
      instrumentCode,
      reason,
      this as unknown as TradingQuoteCancelAllTarget
    );
  }

  private latencyStorageWrites(extra?: Record<string, unknown>): Record<string, unknown> {
    return tradingLatencyStorageWritesForTarget(
      this as unknown as TradingLatencyStateTarget,
      extra
    );
  }

  private latencyStorageWritesForState(
    state: EngineState,
    extra?: Record<string, unknown>
  ): Record<string, unknown> {
    return tradingLatencyStorageWritesForState({
      state,
      latencyHistory: this.latencyHistory,
      processingLatencySamples: this.processingLatencySamples,
      extra
    });
  }

  private observeExecutionProfile(metrics: LatencyMetrics, trace: ExecutionTraceInput): void {
    observeTradingExecutionProfileForTarget(
      metrics,
      trace,
      this as unknown as TradingHotPathTelemetryTarget
    );
  }

  private publishTickTelemetry(
    tick: MarketTick,
    metrics: LatencyMetrics,
    status: LatencyMetrics["status"],
    hotPathStartedAt: number
  ): void {
    publishTradingTickTelemetryForTarget(
      tick,
      metrics,
      status,
      hotPathStartedAt,
      this as unknown as TradingHotPathTelemetryTarget
    );
  }

  private logPerformance(latencyMetrics: LatencyMetrics): void {
    logTradingPerformanceForTarget(
      latencyMetrics,
      this as unknown as TradingHotPathTelemetryTarget
    );
  }

  private publish(type: string, payload: Record<string, unknown>, correlationId?: string): void {
    this.telemetryBus.publish(type, payload, correlationId);
  }
}
