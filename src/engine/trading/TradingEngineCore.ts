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
import { OrderBookReconstructor } from "./book/OrderBookReconstructor";
import {
  buildTradingOrderBookStoresForTarget,
  createTradingOrderBookReconstructor,
  type TradingOrderBookStoresTarget
} from "./book/OrderBookReconstructorFactory";
import type { BookSyncState } from "./book/BookTypes";
import {
  handleTradingEngineFetchForTarget,
  type TradingEngineFetchTarget
} from "./routes/EngineFetchRuntime";
import type { TradingTelemetryBus } from "./telemetry/TelemetryBus";
import { type ReplayJournal } from "./replay/ReplayJournal";
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
  putTradingStorageForTarget,
  recordTradingStorageWriteFailureForTarget,
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
  LatencyMetrics,
  LiquidityWall,
  MacroBias,
  TemporaryGovernanceOverride,
  TradeIntent
} from "../../types";
import type { AbsorptionConfirmed, CascadeEvent } from "../../strategy/cascade/types";

import { DEFAULT_MAX_LATENCY_MS } from "../../TradingEngineConstants";
import { defaultEngineState } from "./state/EngineStateDefaults";

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
      writeStorage: (key, value, reason) =>
        putTradingStorageForTarget(
          this as unknown as TradingStorageGuardTarget,
          key,
          value,
          reason
        ),
      publish: (type, payload, correlationId) => this.publish(type, payload, correlationId),
      onStorageReadFailure: (reason, error) =>
        recordTradingStorageWriteFailureForTarget(
          this as unknown as TradingStorageGuardTarget,
          reason,
          error
        )
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
      resetOrderBook: (payload) =>
        resetTradingOrderBookForTarget(
          payload,
          this as unknown as TradingOrderBookResetTarget
        ).then(() => undefined)
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

  private publish(type: string, payload: Record<string, unknown>, correlationId?: string): void {
    this.telemetryBus.publish(type, payload, correlationId);
  }
}
