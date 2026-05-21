/* eslint-disable */
import { defaultConfig, type ConfigManager } from "../../ConfigManager";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { neutralMacroBias, type Governor } from "../../Governor";
import type { Logger } from "../../Logger";
import {
  ProfilerAgent,
  PROFILER_STATE_STORAGE_KEY,
  PROFILER_STATE_STORAGE_PREFIX,
  type ProfilerEvaluation
} from "../../agents/ProfilerAgent";
import { ProfilerRegistry } from "../../agents/ProfilerRegistry";
import { AnomalyDetector, type AnomalyDetectionResult } from "../../agents/AnomalyDetector";
import { CroupierAgent, type CroupierDecision } from "../../agents/CroupierAgent";
import { AdverseSelectionModel } from "../AdverseSelectionModel";
import {
  applyTradingLocationLatencyForTarget,
  observeTradingTopologyForTarget,
  warmUpTradingTopologyForTarget,
  type TradingTopologyTarget
} from "./helpers/TradingTopologyRuntime";
import { priceKey, SortedBookSide } from "./book/SortedBookSide";
import { currentOrderBookSnapshot } from "./book/BookViews";
import {
  handleTradingEngineInformationalBookNotReady,
  handleTradingEngineRejectedBookDelta,
  type TradingBookEarlyReturnTarget
} from "./book/TradingBookEarlyReturnRuntime";
import {
  applyTradingBookDeltaForTarget,
  applyTradingBookSnapshotForTarget,
  type TradingBookApplicationTarget
} from "./book/TradingBookApplicationRuntime";
import {
  resetTradingOrderBookForTarget,
  type TradingOrderBookResetTarget
} from "./book/OrderBookResetRuntime";
import {
  resolveTradingTickBookForTarget,
  type TradingTickBookTarget
} from "./book/TradingTickBookRuntime";
import {
  buildDomAnalysisSnapshot,
  createDomAnalyzerContext,
  currentDomHeatmapSnapshot,
  type DomAnalyzerContextTarget
} from "./book/DomAnalyzer";
import {
  processTradingShadowQueueTickForTarget,
  type TradingShadowQueueTarget
} from "./shadow/TradingShadowQueueRuntime";
import {
  handleTradingEngineAnomalyEmergencyPause,
  type TradingAnomalyEmergencyTarget
} from "./anomaly/TradingAnomalyEmergencyRuntime";
import {
  updateTradingLeadLagMetricsForTarget,
  type TradingLeadLagMetricsTarget
} from "./leadlag/LeadLagRuntime";
import {
  calculateTradingInventoryStateForTarget,
  type TradingInventoryStateTarget
} from "./inventory/TradingInventoryStateRuntime";
import { resolveMaxPositionPct } from "./risk/PortfolioRiskRuntime";
import {
  updateTradingPortfolioRiskForTarget,
  type TradingPortfolioRiskTarget
} from "./risk/TradingPortfolioRiskRuntime";
import { stateAfterFundingTick } from "./funding/FundingRuntime";
import {
  runTradingAlarmForTarget,
  type TradingAlarmRuntimeTarget
} from "./alarm/TradingAlarmRuntime";
import {
  dispatchTradingQuoteForTarget,
  rememberTradingDispatchedQuoteForTarget,
  shouldThrottleTradingQuoteDispatchForTarget,
  type TradingQuoteDispatchTarget
} from "./quotes/TradingQuoteDispatchRuntime";
import type { DispatchedQuoteSnapshot } from "./quotes/QuoteRefreshRuntime";
import {
  cancelAllTradingQuotesForTarget,
  type TradingQuoteCancelAllTarget
} from "./quotes/QuoteCancelRuntime";
import {
  dispatchTradingExecutionIntentForTarget,
  type TradingExecutionDispatchTarget
} from "./execution/TradingExecutionDispatchRuntime";
import {
  applyTradingExecutionReportForTarget,
  type TradingExecutionReportTarget
} from "./execution/TradingExecutionReportRuntime";
import { type OracleTickResult } from "./agents/AgentEvaluationRuntime";
import {
  evaluateTradingCroupierForTarget,
  type TradingCroupierEvaluationTarget
} from "./agents/TradingCroupierEvaluationRuntime";
import {
  evaluateTradingOracleForTarget,
  type TradingOracleEvaluationTarget
} from "./agents/TradingOracleEvaluationRuntime";
import {
  evaluateTradingProfilerForTarget,
  type TradingProfilerEvaluationTarget
} from "./agents/TradingProfilerEvaluationRuntime";
import {
  reservePaperExecutionBudgetForTarget,
  type TradingPaperExecutionBudgetTarget
} from "./execution/PaperExecutionBudgetRuntime";
import {
  drainTradingExecutionQueueForTarget,
  enqueueTradingExecutionIntentForTarget,
  type QueuedExecutionIntent,
  type TradingExecutionQueueTarget
} from "./execution/ExecutionQueueRuntime";
import {
  calculateTradingAssetMatrixForTarget,
  type TradingAssetMatrixTarget
} from "./state/TradingAssetMatrixRuntime";
import { type ExecutionTraceInput } from "./performance/LatencyRuntime";
import {
  applyTradingNativeHyperliquidLatencyPullForTarget,
  type TradingNativeHyperliquidLatencyPullTarget
} from "./performance/StaleLatencyGuardRuntime";
import {
  handleTradingHardStaleTickDrop,
  handleTradingSoftStaleTick,
  type TradingStaleLatencyTarget
} from "./performance/TradingStaleLatencyRuntime";
import {
  prepareTradingTickLatencyForTarget,
  type TradingTickLatencyTarget
} from "./performance/TradingTickLatencyRuntime";
import {
  resetTradingLatencyBaselineForTarget,
  tradingLatencyStorageWritesForState,
  tradingLatencyStorageWritesForTarget,
  updateTradingLatencyAverageForTarget,
  type TradingLatencyStateTarget
} from "./performance/TradingLatencyStateRuntime";
import {
  cancelTradingJanitorOrder,
  pruneTradingOperationalLogs,
  runTradingEngineJanitorMaintenanceForTarget,
  type TradingEngineJanitorMaintenanceTarget
} from "./janitor/TradingJanitorRuntime";
import {
  currentCascadeActiveSnapshot as buildCurrentCascadeActiveSnapshot,
  currentCascadeHeatSnapshot as buildCurrentCascadeHeatSnapshot,
  currentCascadeSignalSnapshot as buildCurrentCascadeSignalSnapshot,
  currentTradingCascadePositionSnapshot as buildCurrentCascadePositionSnapshot
} from "./cascade/CascadeSnapshots";
import {
  recordTradingEngineCascadeLiquidations,
  type TradingCascadeLiquidationDetectionTarget
} from "./cascade/CascadeLiquidationRuntime";
import {
  buildCascadeEntryTradeIntent,
  buildCascadeExitTradeIntent
} from "./cascade/CascadeTradeIntents";
import {
  observeTradingEngineCascadeAbsorption,
  type TradingCascadeAbsorptionTarget
} from "./cascade/CascadeAbsorptionRuntime";
import {
  applyTradingEngineConfigUpdateForTarget,
  refreshTradingEngineConfigForTarget,
  type TradingEngineConfigControlTarget
} from "./config/TradingConfigControlRuntime";
import {
  absorptionAnalyzerConfigFromRuntime,
  cascadeAssetProfileFromConfig,
  cascadeDetectorConfigFromRuntime
} from "./cascade/CascadeConfigRuntime";
import {
  ensureCascadePaperModeArmedForTarget,
  type CascadePaperModeArmingTarget
} from "./cascade/CascadePaperModeRuntime";
import { OrderBookReconstructor, type OrderBookStores } from "./book/OrderBookReconstructor";
import {
  buildOrderBookStores,
  createTradingOrderBookReconstructor
} from "./book/OrderBookReconstructorFactory";
import type { AppliedBookUpdate, BookDeltaWithTicker, BookSyncState } from "./book/BookTypes";
import {
  registerHyperliquidIngestConnectionForTarget,
  type HyperliquidIngestConnectionTarget,
  type HyperliquidRawIngestPayload
} from "./ingest/HyperliquidRawRouting";
import {
  handleTradingHyperliquidRawForTarget,
  type TradingHyperliquidRawEngineTarget
} from "./ingest/TradingHyperliquidRawRuntime";
import { handleGrpcFatalDropForTarget, type GrpcFatalDropTarget } from "./ingest/GrpcDropRuntime";
import {
  createTradingEngineHttpRouteContext,
  handleTradingEngineHttpRoute,
  type EngineHttpRouteContext,
  type EngineHttpRouteContextTarget
} from "./routes/EngineHttpRoutes";
import { handleTradingEngineFetchRuntime } from "./routes/EngineFetchRuntime";
import {
  acceptMarketStream as acceptTradingMarketStream,
  acceptTelemetryStream as acceptTradingTelemetryStream,
  createTradingEngineStreamContext,
  type EngineStreamContextTarget
} from "./routes/EngineWebSocketStreams";
import type { TradingTelemetryBus } from "./telemetry/TelemetryBus";
import {
  acceptTradingAgentSignalForTarget,
  emitTradingCascadeOperationalAlertForTarget,
  recordTradingCascadeUiSignalForTarget,
  type TradingSignalBusTarget
} from "./telemetry/TradingSignalBusRuntime";
import {
  buildTradingPerformanceMetricsResponseForTarget,
  logTradingPerformanceForTarget,
  observeTradingExecutionProfileForTarget,
  publishTradingTickTelemetryForTarget,
  type TradingHotPathTelemetryTarget
} from "./telemetry/TradingHotPathTelemetryRuntime";
import { type ReplayOptions } from "./routes/ReplayAdminRoutes";
import { type ReplayJournal } from "./replay/ReplayJournal";
import {
  runTradingHistoricalReplayForTarget,
  type TradingHistoricalReplayEngineTarget
} from "./replay/TradingReplayRunRuntime";
import {
  captureTradingReplaySnapshotFromSource,
  prepareTradingShadowReplayStateForTarget,
  restoreTradingReplaySnapshotForTarget,
  type EngineReplaySnapshot,
  type TradingReplayRestoreTarget,
  type TradingReplaySnapshotSource,
  type TradingShadowReplayStateTarget
} from "./replay/TradingReplayStateRuntime";
import type { GrpcFatalDropPayload, TickIngestResult } from "./TradingEngineRouteTypes";
import {
  buildTradingEngineDiagnosticsForTarget,
  buildTradingHealthReportForTarget,
  syncTradingStateMicrostructureForTarget,
  type TradingEngineDiagnosticsTarget
} from "./state/EngineDiagnostics";
import { readEngineBootStorageSnapshot } from "./state/EngineBootStorage";
import {
  createBootAbsorptionAnalyzer,
  createBootAnomalyDetector,
  createBootCascadeDetector,
  createBootCroupierAgent,
  createBootHeatmapAgent,
  createBootProfilerAgent,
  resolveEngineBootRuntimeSettings
} from "./state/EngineBootConfig";
import { buildHydratedEngineState, hydrateEngineBootCollections } from "./state/EngineBootState";
import {
  createTradingEngineBootServices,
  tradingEngineLoggerRuntimeContext
} from "./state/EngineBootServices";
import { maybeResumeTradingShadowMode } from "./state/TradingShadowModeAutoResumeRuntime";
import { resolveTradingTickAvailability } from "./state/TradingAvailabilityRuntime";
import { stateAfterAcceptedTick } from "./state/TickStateRuntime";
import {
  recoverTradingEngineStateForTarget,
  type TradingAdminRecoveryTarget
} from "./state/RecoveryRuntime";
import {
  applyHotStorageSnapshotSideEffects,
  resolveHotStorageSnapshotIntervalMs,
  resolveHotStorageSnapshotTickInterval,
  type StorageWriteGuard
} from "./state/StorageWriteGuard";
import { type LogPruneReport } from "../LogRetention";
import {
  MultiScaleVolatilityModel,
  type MultiScaleVolatilitySnapshot
} from "../MultiScaleVolatility";
import { QueuePositionModel } from "../QueuePositionModel";
import { HeatmapAgent, defaultLiquidationHeatmapState } from "../../agents/HeatmapAgent";
import { JanitorAgent } from "../../agents/JanitorAgent";
import { OracleAgent, defaultOracleState } from "../../agents/OracleAgent";
import { PitBossAgent } from "../../agents/PitBossAgent";
import { SentimentAgent } from "../../agents/SentimentAgent";
import { RateLimiter, type RateLimitBucketSnapshot } from "../../utils/RateLimiter";
import type { Notifier } from "../../utils/Notifier";
import { isShadowMode } from "../../utils/CitadelProtocol";
import type { GhostBook, GhostBookConfig } from "../../utils/GhostBook";
import { AbsorptionAnalyzer } from "../../strategy/cascade/AbsorptionAnalyzer";
import type { CascadeAssetProfile } from "../../strategy/cascade/AssetProfiles";
import type { Backtester } from "../../strategy/cascade/Backtester";
import { CascadeCandleAggregator } from "../../strategy/cascade/CandleAggregator";
import { CascadeDetector } from "../../strategy/cascade/CascadeDetector";
import { HyperliquidLiquidationStream } from "../../strategy/cascade/LiquidationStream";
import { HeatManager } from "../../strategy/cascade/HeatManager";
import type { NewsCalendar } from "../../strategy/cascade/NewsCalendar";
import type { CascadeAlertEventType } from "../../strategy/cascade/OperationalSafeguards";
import { PositionManager } from "../../strategy/cascade/PositionManager";
import type {
  AdminConfigUpdate,
  AnomalyDetectorState,
  DomAnalysisSnapshot,
  EdgeTopology,
  EngineLocation,
  EngineStabilityStatus,
  AgentName,
  AgentSignal,
  AssetRuntimeState,
  BookSnapshotResponse,
  ExecutionReport,
  EngineState,
  Env,
  GlobalRiskConfig,
  HealthReport,
  InternalOrderBook,
  InventoryState,
  JsonRecord,
  LatencyMetrics,
  LiquidationHeatmapState,
  LiquidityWall,
  MacroBias,
  MarketDataSource,
  MarketTick,
  OrderBookDelta,
  OrderBookResetRequest,
  OrderBookSide,
  OrderBookSnapshot,
  OrderBookSnapshotLevel,
  Position,
  ProfilerState,
  ReplayResult,
  RiskLimits,
  SentimentState,
  ShadowQueueState,
  TemporaryGovernanceOverride,
  TradeIntent
} from "../../types";
import type {
  AbsorptionAnalyzerConfig,
  AbsorptionConfirmed,
  CascadeDetectorConfig,
  CascadeEvent,
  CascadePositionIntent,
  CascadeRecoverySignal,
  LiquidationEvent
} from "../../strategy/cascade/types";

import {
  ENGINE_STATE_KEY,
  ORDER_BOOK_PREFIX,
  PERFORMANCE_HISTORY_KEY,
  CASCADE_LAST_BACKTEST_REPORT_KEY,
  RISK_LIMITS_KEY,
  CONFIG_KEY,
  DEFAULT_MAX_LATENCY_MS,
  DEFAULT_HARD_STALE_DROP_MS,
  PERFORMANCE_HISTORY_LIMIT,
  CONFIG_ALARM_INTERVAL_MS,
  ADMIN_STREAM_PULSE_INTERVAL_MS,
  STORAGE_WRITE_BACKOFF_MS,
  DEFAULT_SOURCE_WEIGHT,
  PROCESSING_LATENCY_SAMPLES_KEY,
  RATE_LIMIT_STATE_KEY,
  HOT_PATH_LOG_THROTTLE_MS,
  DEFAULT_JITTER_SAMPLE_WINDOW,
  DEFAULT_JITTER_COMPUTE_INTERVAL_TICKS,
  DEFAULT_JITTER_THRESHOLD_MS,
  DEFAULT_DOM_PRICE_BIN_SIZE,
  DEFAULT_DOM_SCAN_RANGE_PCT,
  DEFAULT_DOM_WALL_HISTORY_LIMIT,
  DEFAULT_DOM_SPOOF_PROXIMITY_BPS,
  DEFAULT_ANOMALY_PRICE_Z_THRESHOLD,
  DEFAULT_ANOMALY_VOLUME_Z_THRESHOLD,
  DEFAULT_ANOMALY_CANCEL_EXEC_RATIO_THRESHOLD,
  DEFAULT_ANOMALY_PRICE_WINDOW_MS,
  DEFAULT_ANOMALY_VOLUME_WINDOW_MS,
  DEFAULT_ANOMALY_TOP_OF_BOOK_WINDOW_MS,
  DEFAULT_EXCHANGE_FEE_BPS,
  DEFAULT_MIN_EV_THRESHOLD,
  DEFAULT_AMM_MIN_TICK_CHANGE,
  DEFAULT_HEATMAP_PRICE_BIN_SIZE,
  DEFAULT_HEATMAP_CLUSTER_NOTIONAL_USD,
  DEFAULT_CASCADE_DISTANCE_PCT,
  DEFAULT_MARKET_TICK_MAX_ROWS,
  DEFAULT_SHADOW_VLO_CAPACITY,
  DEFAULT_SHADOW_VLO_DRIFT_TRADES,
  DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
  DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS,
  DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS,
  TARGET_ASSET_MATRIX,
  TARGET_INSTRUMENTS,
  DEFAULT_JANITOR_INTERVAL_MS,
  AGGREGATED_BUS_TELEMETRY_TYPES
} from "../../TradingEngineConstants";
import {
  resolveBookSide,
  resolveCurrentInstrument,
  hydrateLegacyLevel,
  levelsToBookSide,
  resolveTickSize,
  parseTickSizeMap,
  parsePositiveNumberMap
} from "./book/BookRuntimeHelpers";
import {
  closeTradingEngineCascadePosition,
  type TradingCascadeManualCloseTarget
} from "./cascade/TradingCascadeManualCloseRuntime";
import { normalizeNativeCoin, splitNativeInstrument } from "./helpers/NativeMarketIdentityRuntime";
import { nativeBookSideLevels } from "./helpers/NativeHyperliquidRuntime";
import {
  epochMillis,
  nativeHashSequence,
  nativeNumber,
  nativeSide
} from "./helpers/NativeValueRuntime";
import { highResolutionNow } from "./helpers/RuntimeClock";
import {
  prometheusLabels,
  escapePrometheusLabel,
  finiteMetric,
  nullableFiniteMetric
} from "./helpers/RuntimeMetrics";
import {
  readNumber,
  readPositiveNumber,
  clampInteger,
  assertAgentSignal,
  finiteNumber,
  isPlainObject,
  readHyperliquidRawIngestPayload,
  readJsonOrNull
} from "./helpers/RuntimeParsing";
import { resolveGhostBookConfig } from "./shadow/GhostBookConfigRuntime";
import {
  defaultQuoteState,
  selectedMoltworkerInstruments,
  normalizeAssetMatrix,
  filterTargetOrderBooks,
  defaultAssetMatrix,
  suspendAssetQuoteStates,
  quotePriceMovedTicks
} from "./state/AssetStateRuntime";
import { defaultEnsembleState, touchAgentHealth } from "./state/AgentStateDefaults";
import {
  defaultLeadLagMetrics,
  defaultMicrostructure,
  defaultPriceDiscovery
} from "./state/MarketStateDefaults";
import {
  defaultEngineState,
  defaultAnomalyStatus,
  normalizeExecutionProfile,
  defaultInventoryState,
  normalizeInventoryState,
  defaultRiskMetrics,
  defaultShadowQueueState,
  defaultCitadelState,
  maintenanceRecoveryInstruments,
  defaultInventoryGuardState,
  defaultJanitorState,
  defaultSlippageAnalytics,
  defaultRiskLimits,
  mergeRiskLimits,
  resolveMaxLatencyMs
} from "./state/EngineStateDefaults";
import {
  applyAcceptedDecisionPipelineForTarget,
  type AcceptedDecisionPipelineTarget
} from "./pipelines/AcceptedTickLifecycleRuntime";
import {
  buildTickDecisionContextForTarget,
  type TickDecisionContextTarget
} from "./pipelines/TickDecisionContextRuntime";
import {
  commitAcceptedTickStateForTarget,
  type AcceptedTickStateCommitTarget
} from "./pipelines/AcceptedTickStateTransitionRuntime";
import {
  finalizeAcceptedTickForTarget,
  type AcceptedTickFinalizationTarget
} from "./pipelines/AcceptedTickFinalizationRuntime";
import {
  prepareAcceptedExecutionContextForTarget,
  type AcceptedExecutionContextTarget
} from "./pipelines/AcceptedExecutionContextRuntime";
import {
  prepareTradingPostBookTickRuntimeForTarget,
  type TradingPostBookTickRuntimeTarget
} from "./pipelines/PostBookTickRuntime";
import { handleTickRuntime } from "./pipelines/TickHandlingRuntime";
import type {
  AcceptedDecisionPipelineInput,
  AcceptedExecutionContext,
  AcceptedTickSideEffectsInput,
  AcceptedTickStateCommitInput,
  PostBookTickContext,
  TickBookResolution,
  TickDecisionContext,
  TickHandlingOptions
} from "./pipelines/TickPipelineTypes";

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
      stores: this.orderBookStores(),
      logger: this.logger,
      publish: (type, payload) => this.publish(type, payload),
      resetOrderBook: (payload) => this.resetOrderBook(payload)
    });

    this.initialized = this.state.blockConcurrencyWhile(async () => {
      const {
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
        kvRiskLimits,
        kvConfig
      } = await readEngineBootStorageSnapshot({
        storage: this.state.storage,
        env: this.env,
        onReadFailure: (reason, error) => this.handleStorageWriteFailure(reason, error)
      });

      const baseState = persistedState ?? defaultEngineState(this.state.id.toString());
      const now = new Date().toISOString();

      const bootCollections = hydrateEngineBootCollections({
        persistedBooks,
        persistedLatencyHistory,
        persistedProcessingLatencySamples,
        persistedDomWallHistory,
        performanceHistoryLimit: PERFORMANCE_HISTORY_LIMIT,
        jitterSampleWindow: this.jitterSampleWindow,
        domWallHistoryLimit: this.domWallHistoryLimit,
        filterTargetOrderBooks
      });
      const hydratedBooks = bootCollections.hydratedBooks;

      this.orderBook = hydratedBooks.snapshots;
      this.bids = hydratedBooks.bids;
      this.asks = hydratedBooks.asks;
      this.bookSync = hydratedBooks.sync;
      this.rebindOrderBookReconstructor();
      this.ghostBook.hydrate(baseState.shadowQueue);
      this.cascadePositionManager.hydrate(persistedCascadePositions ?? []);
      this.profilerRegistry.hydrate(persistedProfilerState, persistedProfilerStates);
      this.heatmapAgent.hydrate(persistedHeatmapState ?? baseState.liquidationHeatmap);
      this.anomalyDetector.hydrate(persistedAnomalyState);
      this.rateLimiter.hydrate(persistedRateLimits);
      this.oracleAgent.hydrate(baseState.oracle);
      this.sentimentAgent.hydrate(baseState.sentiment);
      this.lastTickTimestamp = baseState.microstructure?.updatedAt ?? baseState.updatedAt ?? null;
      this.latencyHistory = bootCollections.latencyHistory;
      this.processingLatencySamples = bootCollections.processingLatencySamples;
      this.domWallHistory = bootCollections.domWallHistory;
      this.maxLatencyMs = resolveMaxLatencyMs(kvConfig, baseState.maxLatencyMs);
      const effectiveGovernance = await this.governor.readEffectiveConfig(
        await this.configManager.fetchConfig()
      );
      await this.cascadeNewsCalendar.refresh(true);
      this.cachedConfig = effectiveGovernance.config;
      this.macroBias = effectiveGovernance.macroBias;
      this.activeTemporaryOverride = effectiveGovernance.temporaryOverride;
      if (this.cachedConfig.STRATEGY_MODE === "CASCADE_RECOVERY") {
        this.state.waitUntil(this.ensureCascadePaperModeArmed(now));
      }
      this.profilerRegistry.configure(this.cachedConfig);
      this.maxLatencyMs = this.cachedConfig.LATENCY_THRESHOLD_MS;
      this.engineState = buildHydratedEngineState({
        baseState,
        env: this.env,
        now,
        kvConfig,
        kvRiskLimits,
        cachedConfig: this.cachedConfig,
        macroBias: this.macroBias,
        temporaryOverride: this.activeTemporaryOverride,
        orderBook: this.orderBook,
        bids: this.bids,
        asks: this.asks,
        liquidationHeatmap: this.heatmapAgent.snapshot(),
        profilerStates: this.profilerRegistry.snapshot(),
        shadowQueue: this.ghostBook.snapshot(now),
        anomaly: this.anomalyDetector.status,
        maxLatencyMs: this.maxLatencyMs,
        jitterThresholdMs: this.jitterThresholdMs,
        jitterSampleWindow: this.jitterSampleWindow,
        jitterComputeIntervalTicks: this.jitterComputeIntervalTicks,
        processingLatencySampleCount: this.processingLatencySamples.length
      });
      this.lastPerformanceStatus = this.engineState.executionProfile.status;

      await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "SYSTEM_INIT");
      await this.scheduleConfigRefresh();

      this.logger.info("SYSTEM_INIT", "Trading engine singleton initialized", {
        engineId: this.engineState.engineId,
        mode: this.engineState.mode,
        riskConfigVersion: this.engineState.risk.configVersion,
        nativeFeed: "HYPERLIQUID",
        hasExchangeApiKey: Boolean(this.env.EXCHANGE_API_KEY)
      });
    });
  }

  private orderBookStores(): OrderBookStores {
    return buildOrderBookStores({
      orderBook: this.orderBook,
      bids: this.bids,
      asks: this.asks,
      sync: this.bookSync
    });
  }

  private rebindOrderBookReconstructor(): void {
    this.orderBookReconstructor.replaceStores(this.orderBookStores());
  }

  async alarm(): Promise<void> {
    await runTradingAlarmForTarget(this as unknown as TradingAlarmRuntimeTarget);
  }

  async fetch(request: Request): Promise<Response> {
    return handleTradingEngineFetchRuntime(
      {
        request,
        initialized: this.initialized
      },
      {
        rememberWakeUpTime: (wakeUpTimeMs) => {
          this.latestWakeUpTimeMs = wakeUpTimeMs;
        },
        observeTopology: (topology) => this.observeTopology(topology),
        warmUpForTopology: (topology) => this.warmUpForTopology(topology),
        acceptTelemetryStream: () => acceptTradingTelemetryStream(this.streamContext()),
        acceptMarketStream: () => acceptTradingMarketStream(this.streamContext()),
        handleHttpRoute: (currentRequest, url, wakeUpTimeMs) =>
          handleTradingEngineHttpRoute(
            currentRequest,
            url,
            this.engineHttpRouteContext(wakeUpTimeMs)
          ),
        logRequestFailure: (failure) =>
          this.logger.error(
            "ENGINE_REQUEST_FAILED",
            "Trading engine request failed",
            { path: failure.pathname, message: failure.message },
            failure.requestId
          )
      }
    );
  }

  private engineHttpRouteContext(wakeUpTimeMs: number | null): EngineHttpRouteContext {
    return createTradingEngineHttpRouteContext(
      this as unknown as EngineHttpRouteContextTarget,
      wakeUpTimeMs
    );
  }

  healthCheck(): HealthReport {
    return buildTradingHealthReportForTarget(this as unknown as TradingEngineDiagnosticsTarget);
  }

  private syncStateMicrostructureFromBook(): void {
    syncTradingStateMicrostructureForTarget(this as unknown as TradingEngineDiagnosticsTarget);
  }

  private engineDiagnostics(): JsonRecord {
    return buildTradingEngineDiagnosticsForTarget(
      this as unknown as TradingEngineDiagnosticsTarget
    );
  }

  private async deleteRetiredProfilerStorage(): Promise<string[]> {
    return this.profilerRegistry.deleteRetiredStorage(this.state.storage, (reason, error) =>
      this.handleStorageWriteFailure(reason, error)
    );
  }

  private calculateAssetMatrix(
    observedAt: string,
    _latestInstrumentCode: string | undefined,
    latestOracle: EngineState["oracle"],
    profilerStates: Record<string, ProfilerState>,
    assetQuoteStates: EngineState["assetQuoteStates"] = this.engineState.assetQuoteStates
  ): Record<string, AssetRuntimeState> {
    return calculateTradingAssetMatrixForTarget(
      {
        observedAt,
        latestOracle,
        profilerStates,
        assetQuoteStates
      },
      this as unknown as TradingAssetMatrixTarget
    );
  }

  private async safeStoragePut(key: string, value: unknown, reason: string): Promise<void>;
  private async safeStoragePut(entries: Record<string, unknown>, reason: string): Promise<void>;
  private async safeStoragePut(
    keyOrEntries: string | Record<string, unknown>,
    valueOrReason: unknown,
    maybeReason?: string
  ): Promise<void> {
    if (typeof keyOrEntries === "string") {
      await this.storageGuard.put(keyOrEntries, valueOrReason, maybeReason ?? "STORAGE_WRITE");
    } else {
      await this.storageGuard.put(
        keyOrEntries,
        typeof valueOrReason === "string" ? valueOrReason : "STORAGE_WRITE"
      );
    }
  }

  private waitUntilStoragePut(key: string, value: unknown, reason: string): void {
    this.state.waitUntil(this.safeStoragePut(key, value, reason));
  }

  private async safeStorageDelete(keys: string[], reason: string): Promise<void> {
    await this.storageGuard.delete(keys, reason);
  }

  private async safeSetAlarm(timestamp: number, reason: string): Promise<void> {
    await this.storageGuard.setAlarm(timestamp, reason);
  }

  private async persistHotStorageSnapshot(
    entries: Record<string, unknown>,
    reason: string
  ): Promise<void> {
    await applyHotStorageSnapshotSideEffects(
      {
        entries,
        reason,
        lastSnapshotAtMs: this.lastHotStorageSnapshotAt,
        lastSnapshotTick: this.lastHotStorageSnapshotTick,
        nowMs: Date.now(),
        tickCount: this.engineState.processedTicks,
        intervalMs: resolveHotStorageSnapshotIntervalMs(this.env.HOT_STORAGE_SNAPSHOT_INTERVAL_MS),
        tickInterval: resolveHotStorageSnapshotTickInterval(
          this.env.HOT_STORAGE_SNAPSHOT_TICK_INTERVAL
        )
      },
      {
        markSnapshot: (snapshotAtMs, snapshotTick) => {
          this.lastHotStorageSnapshotAt = snapshotAtMs;
          this.lastHotStorageSnapshotTick = snapshotTick;
        },
        persistSnapshot: (snapshotEntries, snapshotReason) =>
          this.safeStoragePut(snapshotEntries, snapshotReason)
      }
    );
  }

  private handleStorageWriteFailure(reason: string, error: unknown): void {
    this.storageGuard.recordFailure(reason, error);
  }

  private streamContext() {
    return createTradingEngineStreamContext(this as unknown as EngineStreamContextTarget);
  }

  private enqueueTick(
    tick: MarketTick,
    wakeUpTimeMs: number | null = this.latestWakeUpTimeMs,
    options: TickHandlingOptions = {}
  ): Promise<TickIngestResult> {
    const job = this.ingestQueue.then(() => this.handleTick(tick, wakeUpTimeMs, options));
    this.ingestQueue = job.then(
      () => undefined,
      () => undefined
    );
    return job;
  }

  private async handleHyperliquidRaw(
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult> {
    return handleTradingHyperliquidRawForTarget(
      payload,
      wakeUpTimeMs,
      this as unknown as TradingHyperliquidRawEngineTarget
    );
  }

  private recordCascadeLiquidations(
    events: LiquidationEvent[],
    observedAt: string
  ): CascadeEvent[] {
    return recordTradingEngineCascadeLiquidations(
      events,
      observedAt,
      this as unknown as TradingCascadeLiquidationDetectionTarget
    );
  }

  private currentCascadeActiveSnapshot(): JsonRecord[] {
    return buildCurrentCascadeActiveSnapshot({
      events: this.cascadeEventsById.values(),
      absorptionsById: this.cascadeAbsorptionsById,
      positions: this.cascadePositionManager.snapshot(),
      maxAgeMs: Math.max(this.cachedConfig.ABSORPTION_WINDOW_MS * 2, 60_000),
      nowMs: Date.now()
    });
  }

  private currentCascadeSignalSnapshot(limit: number): JsonRecord[] {
    return buildCurrentCascadeSignalSnapshot(this.signals, limit);
  }

  private currentCascadePositionSnapshot(): JsonRecord[] {
    return buildCurrentCascadePositionSnapshot({
      positions: this.cascadePositionManager.snapshot(),
      nowMs: Date.now(),
      markPriceContext: {
        orderBook: this.orderBook,
        assetMatrix: this.engineState.assetMatrix,
        microstructure: this.engineState.microstructure
      }
    });
  }

  private currentCascadeHeatSnapshot(): JsonRecord {
    const positions = this.cascadePositionManager.snapshot();
    return buildCurrentCascadeHeatSnapshot({
      positions,
      currentHeatPct: this.cascadeHeatManager.currentHeat(positions),
      heatCapPct: this.cachedConfig.HEAT_CAP_PCT,
      updatedAt: new Date().toISOString()
    });
  }

  private async closeCascadePosition(
    positionId: string,
    actor: string,
    reason: string
  ): Promise<{ ok: boolean; error?: string; position?: JsonRecord; intents?: JsonRecord[] }> {
    return closeTradingEngineCascadePosition(
      { positionId, actor, reason },
      this as unknown as TradingCascadeManualCloseTarget
    );
  }

  private currentCascadeDetectorConfig(instrumentCode: string): CascadeDetectorConfig {
    return cascadeDetectorConfigFromRuntime({
      config: this.cachedConfig,
      instrumentCode,
      minBaselineWindowsValue: this.env.CASCADE_MIN_BASELINE_WINDOWS,
      minCascadeSeparationMsValue: this.env.CASCADE_MIN_SEPARATION_MS,
      maxEventsPerInstrumentValue: this.env.CASCADE_MAX_EVENTS_PER_INSTRUMENT
    });
  }

  private cascadeAssetProfile(instrumentCode: string): CascadeAssetProfile {
    return cascadeAssetProfileFromConfig(instrumentCode, this.cachedConfig);
  }

  private currentAbsorptionAnalyzerConfig(): AbsorptionAnalyzerConfig {
    return absorptionAnalyzerConfigFromRuntime({
      config: this.cachedConfig,
      oiStabilityBpsValue: this.env.ABSORPTION_OI_STABILITY_BPS,
      maxActiveCascadesValue: this.env.ABSORPTION_MAX_ACTIVE_CASCADES
    });
  }

  private observeCascadeAbsorption(tick: MarketTick): void {
    observeTradingEngineCascadeAbsorption(tick, this as unknown as TradingCascadeAbsorptionTarget);
  }

  private tradeIntentFromCascadeSignal(
    signal: CascadeRecoverySignal,
    size: number,
    observedAt: string
  ): TradeIntent {
    return buildCascadeEntryTradeIntent({
      signal,
      size,
      observedAt,
      engineId: this.engineState.engineId,
      exchangeFeeBps: this.cachedConfig.EXCHANGE_FEE_BPS,
      sliceNotionalThresholdUsd: this.cachedConfig.SLICE_NOTIONAL_THRESHOLD_USD,
      maxSlippageBps: this.cascadeAssetProfile(signal.instrumentCode).maxSlippageBps
    });
  }

  private tradeIntentFromCascadePositionIntent(
    intent: CascadePositionIntent,
    observedAt: string
  ): TradeIntent {
    return buildCascadeExitTradeIntent({
      intent,
      observedAt,
      engineId: this.engineState.engineId,
      exchangeFeeBps: this.cachedConfig.EXCHANGE_FEE_BPS,
      maxSlippageBps: this.cascadeAssetProfile(intent.instrumentCode).maxSlippageBps
    });
  }

  private async handleGrpcFatalDrop(
    payload: GrpcFatalDropPayload
  ): Promise<{ status: "GRPC_FATAL_DROP" }> {
    return handleGrpcFatalDropForTarget(payload, this as unknown as GrpcFatalDropTarget);
  }

  private quoteStateStalePull(
    instrumentCode: string,
    sequence: number,
    metrics: LatencyMetrics,
    observedAt: string
  ): void {
    applyTradingNativeHyperliquidLatencyPullForTarget(
      {
        instrumentCode,
        sequence,
        metrics,
        observedAt
      },
      this as unknown as TradingNativeHyperliquidLatencyPullTarget
    );
  }

  private enqueueOrderBookReset(payload: Partial<OrderBookResetRequest>): Promise<void> {
    const job = this.ingestQueue.then(() => this.resetOrderBook(payload));
    this.ingestQueue = job.then(
      () => undefined,
      () => undefined
    );
    return job;
  }

  private registerIngestConnection(
    payload: Partial<OrderBookResetRequest>
  ): Record<string, unknown> {
    return registerHyperliquidIngestConnectionForTarget(
      payload,
      this as unknown as HyperliquidIngestConnectionTarget
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

  private async applySnapshot(
    snapshot: OrderBookSnapshot,
    options: { telemetry?: boolean; persist?: boolean } = {}
  ): Promise<InternalOrderBook> {
    return applyTradingBookSnapshotForTarget(
      snapshot,
      options,
      this as unknown as TradingBookApplicationTarget
    );
  }

  private async applyDelta(
    delta: BookDeltaWithTicker,
    updatedAt: string
  ): Promise<AppliedBookUpdate> {
    return applyTradingBookDeltaForTarget(
      delta,
      updatedAt,
      this as unknown as TradingBookApplicationTarget
    );
  }

  private currentBookSnapshot(
    instrumentCode: string | undefined,
    depth: number
  ): BookSnapshotResponse {
    return currentOrderBookSnapshot(
      {
        orderBook: this.orderBook,
        bids: this.bids,
        asks: this.asks,
        microstructure: this.engineState.microstructure,
        defaultSourceWeight: DEFAULT_SOURCE_WEIGHT,
        getBookSync: (...args) => this.getBookSync(...args),
        resolveTickSize: (code) => resolveTickSize(this.env, code)
      },
      instrumentCode,
      depth
    );
  }

  getLiquidityWalls(
    instrumentCode?: string,
    observedAt: string = new Date().toISOString(),
    tick?: MarketTick
  ): DomAnalysisSnapshot {
    return this.buildDomAnalysis(instrumentCode, observedAt, tick, true);
  }

  private currentDomHeatmap(instrumentCode: string | undefined): DomAnalysisSnapshot {
    return currentDomHeatmapSnapshot(
      this.domAnalyzerContext(),
      this.engineState.dom,
      instrumentCode,
      new Date().toISOString()
    );
  }

  private buildDomAnalysis(
    instrumentCode: string | undefined,
    observedAt: string,
    tick: MarketTick | undefined,
    persistHistory: boolean
  ): DomAnalysisSnapshot {
    return buildDomAnalysisSnapshot(
      this.domAnalyzerContext(),
      instrumentCode,
      observedAt,
      tick,
      persistHistory
    );
  }

  private domAnalyzerContext() {
    return createDomAnalyzerContext(this as unknown as DomAnalyzerContextTarget);
  }

  private getBookSync(
    marketKey: string,
    instrumentCode: string,
    exchangeCode: string | null,
    sourceExchange: string,
    tickSize: number,
    source: MarketDataSource,
    sourceWeight: number
  ): BookSyncState {
    return this.orderBookReconstructor.getBookSync(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      tickSize,
      source,
      sourceWeight
    );
  }

  private async handleHardStaleTickDrop(
    tick: MarketTick,
    metrics: LatencyMetrics,
    streamId: string | null,
    hardStaleDropMs: number
  ): Promise<TickIngestResult> {
    return handleTradingHardStaleTickDrop(
      tick,
      metrics,
      streamId,
      hardStaleDropMs,
      this as unknown as TradingStaleLatencyTarget
    );
  }

  private async handleSoftStaleTick(
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    hotPathStartedAt: number
  ): Promise<TickIngestResult> {
    return handleTradingSoftStaleTick(
      tick,
      metrics,
      wakeUpTimeMs,
      hotPathStartedAt,
      this as unknown as TradingStaleLatencyTarget
    );
  }

  private async handleInformationalBookNotReady(
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    orderBookUpdateMs: number,
    hotPathStartedAt: number
  ): Promise<TickIngestResult> {
    return handleTradingEngineInformationalBookNotReady(
      tick,
      metrics,
      wakeUpTimeMs,
      orderBookUpdateMs,
      hotPathStartedAt,
      this as unknown as TradingBookEarlyReturnTarget
    );
  }

  private async handleRejectedBookDelta(
    tick: MarketTick,
    metrics: LatencyMetrics,
    applied: AppliedBookUpdate,
    wakeUpTimeMs: number | null,
    orderBookUpdateMs: number,
    hotPathStartedAt: number
  ): Promise<TickIngestResult> {
    return handleTradingEngineRejectedBookDelta(
      tick,
      metrics,
      applied,
      wakeUpTimeMs,
      orderBookUpdateMs,
      hotPathStartedAt,
      this as unknown as TradingBookEarlyReturnTarget
    );
  }

  private async handleAnomalyEmergencyPause(
    tick: MarketTick,
    book: InternalOrderBook,
    domSnapshot: DomAnalysisSnapshot,
    anomalyResult: AnomalyDetectionResult,
    anomalyLogicStartedAt: number,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    orderBookUpdateMs: number,
    hotPathStartedAt: number
  ): Promise<TickIngestResult> {
    return handleTradingEngineAnomalyEmergencyPause(
      tick,
      book,
      domSnapshot,
      anomalyResult,
      anomalyLogicStartedAt,
      metrics,
      wakeUpTimeMs,
      orderBookUpdateMs,
      hotPathStartedAt,
      this as unknown as TradingAnomalyEmergencyTarget
    );
  }

  private maybeAutoResumeShadowMode(tick: MarketTick, shadowReplay: boolean): void {
    maybeResumeTradingShadowMode(
      {
        tick,
        shadowReplay,
        env: this.env,
        config: this.cachedConfig,
        macroBias: this.macroBias,
        currentState: this.engineState
      },
      {
        applyState: (state) => {
          this.engineState = state;
        },
        clearKillSwitchLogged: () => {
          this.killSwitchLogged = false;
        },
        warnResume: (metadata) =>
          this.logger.warn(
            "SHADOW_MODE_AUTO_RESUME",
            "Shadow mode resumed paper trading after a stale halt",
            metadata
          ),
        publishResume: (payload) => this.publish("RESUME_QUOTES", payload)
      }
    );
  }

  private resolveTradingAvailability(
    tick: MarketTick,
    shadowReplay: boolean
  ): TickIngestResult | null {
    return resolveTradingTickAvailability(
      {
        tick,
        shadowReplay,
        env: this.env,
        config: this.cachedConfig,
        mode: this.engineState.mode,
        killSwitchLogged: this.killSwitchLogged
      },
      {
        warn: (event) => this.logger.warn(event.eventType, event.message, event.metadata),
        setKillSwitchLogged: (logged) => {
          this.killSwitchLogged = logged;
        }
      }
    );
  }

  private prepareTickLatency(
    tick: MarketTick,
    shadowReplay: boolean
  ): {
    metrics: LatencyMetrics;
    streamId: string | null;
    hardStaleDropMs: number;
    isHardStale: boolean;
  } {
    return prepareTradingTickLatencyForTarget(
      {
        tick,
        shadowReplay
      },
      this as unknown as TradingTickLatencyTarget
    );
  }

  private async resolveTickBook(
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    hotPathStartedAt: number
  ): Promise<TickBookResolution> {
    return resolveTradingTickBookForTarget(
      {
        tick,
        metrics,
        wakeUpTimeMs,
        hotPathStartedAt
      },
      this as unknown as TradingTickBookTarget
    );
  }

  private async preparePostBookTickContext(
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string,
    options: TickHandlingOptions
  ): Promise<PostBookTickContext> {
    return prepareTradingPostBookTickRuntimeForTarget(
      {
        tick,
        book,
        observedAt,
        options
      },
      this as unknown as TradingPostBookTickRuntimeTarget
    );
  }

  private evaluateProfilerForTick(
    tick: MarketTick,
    book: InternalOrderBook,
    domSnapshot: DomAnalysisSnapshot,
    observedAt: string,
    jumpDetected: boolean,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    orderBookUpdateMs: number,
    hotPathStartedAt: number
  ): { profilerResult: ProfilerEvaluation; profilerLatencyMs: number } {
    return evaluateTradingProfilerForTarget(
      {
        tick,
        book,
        domSnapshot,
        observedAt,
        jumpDetected,
        metrics,
        wakeUpTimeMs,
        orderBookUpdateMs,
        hotPathStartedAt
      },
      this as unknown as TradingProfilerEvaluationTarget
    );
  }

  private evaluateOracleForTick(
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string
  ): { oracleResult: OracleTickResult; oracleLatencyMs: number } {
    return evaluateTradingOracleForTarget(
      {
        tick,
        book,
        observedAt
      },
      this as unknown as TradingOracleEvaluationTarget
    );
  }

  private buildTickDecisionContext(
    tick: MarketTick,
    oracle: EngineState["oracle"],
    profilerResult: ProfilerEvaluation,
    observedAt: string
  ): TickDecisionContext {
    return buildTickDecisionContextForTarget(
      tick,
      oracle,
      profilerResult,
      observedAt,
      this as unknown as TickDecisionContextTarget
    );
  }

  private evaluateCroupierForTick(
    book: InternalOrderBook,
    oracle: EngineState["oracle"],
    sentiment: SentimentState,
    profilerResult: ProfilerEvaluation,
    inventory: InventoryState,
    leadLag: EngineState["leadLag"],
    volatilitySnapshot: MultiScaleVolatilitySnapshot | null,
    observedAt: string
  ): { croupierDecision: CroupierDecision; croupierLatencyMs: number } {
    return evaluateTradingCroupierForTarget(
      {
        book,
        oracle,
        sentiment,
        profilerResult,
        inventory,
        leadLag,
        volatilitySnapshot,
        observedAt
      },
      this as unknown as TradingCroupierEvaluationTarget
    );
  }

  private commitAcceptedTickState(input: AcceptedTickStateCommitInput): void {
    commitAcceptedTickStateForTarget(
      input,
      this as unknown as AcceptedTickStateCommitTarget,
      stateAfterAcceptedTick
    );
  }

  private prepareAcceptedExecutionContext(
    input: AcceptedDecisionPipelineInput,
    profilerResult: ProfilerEvaluation,
    oracleState: EngineState["oracle"],
    croupierDecision: CroupierDecision,
    decisionContext: TickDecisionContext
  ): AcceptedExecutionContext {
    return prepareAcceptedExecutionContextForTarget(
      {
        pipeline: input,
        profilerResult,
        oracleState,
        croupierDecision,
        decisionContext
      },
      this as unknown as AcceptedExecutionContextTarget
    );
  }

  private async finalizeAcceptedTick(input: AcceptedTickSideEffectsInput): Promise<void> {
    await finalizeAcceptedTickForTarget(input, this as unknown as AcceptedTickFinalizationTarget);
  }

  private async processAcceptedDecisionPipeline(
    input: AcceptedDecisionPipelineInput
  ): Promise<void> {
    await applyAcceptedDecisionPipelineForTarget(
      input,
      this as unknown as AcceptedDecisionPipelineTarget
    );
  }

  private async handleTick(
    tick: MarketTick,
    wakeUpTimeMs: number | null,
    options: TickHandlingOptions = {}
  ): Promise<TickIngestResult> {
    const hotPathStartedAt = highResolutionNow();
    return handleTickRuntime(
      {
        tick,
        wakeUpTimeMs,
        options,
        hotPathStartedAt,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        shadowModeActive: isShadowMode(this.env)
      },
      {
        maybeAutoResumeShadowMode: (currentTick, shadowReplay) =>
          this.maybeAutoResumeShadowMode(currentTick, shadowReplay),
        resolveTradingAvailability: (currentTick, shadowReplay) =>
          this.resolveTradingAvailability(currentTick, shadowReplay),
        rememberLastTickTimestamp: (receivedAt) => {
          this.lastTickTimestamp = receivedAt;
        },
        observeCascadeAbsorption: (currentTick) => this.observeCascadeAbsorption(currentTick),
        prepareTickLatency: (currentTick, shadowReplay) =>
          this.prepareTickLatency(currentTick, shadowReplay),
        handleHardStaleTickDrop: (currentTick, metrics, streamId, hardStaleDropMs) =>
          this.handleHardStaleTickDrop(currentTick, metrics, streamId, hardStaleDropMs),
        handleSoftStaleTick: (currentTick, metrics, wakeUp, startedAt) =>
          this.handleSoftStaleTick(currentTick, metrics, wakeUp, startedAt),
        applyFundingTick: (currentTick, observedAt) => {
          const fundingState = stateAfterFundingTick(this.engineState, currentTick, observedAt);
          if (fundingState.changed) {
            this.engineState = fundingState.state;
          }
        },
        resolveTickBook: (currentTick, metrics, wakeUp, startedAt) =>
          this.resolveTickBook(currentTick, metrics, wakeUp, startedAt),
        preparePostBookTickContext: (currentTick, book, observedAt, tickOptions) =>
          this.preparePostBookTickContext(currentTick, book, observedAt, tickOptions),
        evaluateAnomaly: (currentTick, book, domSnapshot, observedAt) =>
          this.anomalyDetector.evaluate({
            tick: currentTick,
            book,
            dom: domSnapshot,
            observedAt
          }),
        nowMs: () => highResolutionNow(),
        handleAnomalyEmergencyPause: (
          currentTick,
          book,
          domSnapshot,
          anomalyResult,
          anomalyStartedAt,
          metrics,
          wakeUp,
          orderBookUpdateMs,
          startedAt
        ) =>
          this.handleAnomalyEmergencyPause(
            currentTick,
            book,
            domSnapshot,
            anomalyResult,
            anomalyStartedAt,
            metrics,
            wakeUp,
            orderBookUpdateMs,
            startedAt
          ),
        processAcceptedDecisionPipeline: (pipeline) =>
          this.processAcceptedDecisionPipeline(pipeline)
      }
    );
  }

  private processShadowQueueTick(
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string,
    options: TickHandlingOptions
  ): ShadowQueueState {
    return processTradingShadowQueueTickForTarget(
      tick,
      book,
      observedAt,
      options,
      this as unknown as TradingShadowQueueTarget
    );
  }

  private updateLeadLagMetrics(
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string
  ): EngineState["leadLag"] {
    return updateTradingLeadLagMetricsForTarget(
      tick,
      book,
      observedAt,
      this as unknown as TradingLeadLagMetricsTarget
    );
  }

  private calculateInventoryState(
    observedAt: string,
    positions: Record<string, Position> = this.engineState.openPositions
  ): EngineState["inventory"] {
    return calculateTradingInventoryStateForTarget(
      { observedAt, positions },
      this as unknown as TradingInventoryStateTarget
    );
  }

  private updatePortfolioRisk(
    oracle: EngineState["oracle"],
    observedAt: string
  ): EngineState["riskMetrics"] {
    return updateTradingPortfolioRiskForTarget(
      { oracle, observedAt },
      this as unknown as TradingPortfolioRiskTarget
    );
  }

  private async dispatchQuote(
    quote: NonNullable<EngineState["quoteState"]["lastQuote"]>
  ): Promise<void> {
    await dispatchTradingQuoteForTarget(quote, this as unknown as TradingQuoteDispatchTarget);
  }

  private shouldThrottleQuoteDispatch(
    quote: NonNullable<EngineState["quoteState"]["lastQuote"]>
  ): boolean {
    return shouldThrottleTradingQuoteDispatchForTarget(
      quote,
      this as unknown as TradingQuoteDispatchTarget
    );
  }

  private rememberDispatchedQuote(
    quote: NonNullable<EngineState["quoteState"]["lastQuote"]>
  ): void {
    rememberTradingDispatchedQuoteForTarget(quote, this as unknown as TradingQuoteDispatchTarget);
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

  private reservePaperExecutionBudget(intent: TradeIntent): boolean {
    return reservePaperExecutionBudgetForTarget(
      intent,
      this as unknown as TradingPaperExecutionBudgetTarget
    );
  }

  private async enqueueExecutionIntent(
    intent: TradeIntent,
    priority: QueuedExecutionIntent["priority"],
    waitMs: number
  ): Promise<void> {
    await enqueueTradingExecutionIntentForTarget(
      intent,
      priority,
      waitMs,
      this as unknown as TradingExecutionQueueTarget
    );
  }

  private async drainExecutionQueue(): Promise<void> {
    await drainTradingExecutionQueueForTarget(this as unknown as TradingExecutionQueueTarget);
  }

  private async cancelAllQuotes(instrumentCode: string, reason: string): Promise<void> {
    await cancelAllTradingQuotesForTarget(
      instrumentCode,
      reason,
      this as unknown as TradingQuoteCancelAllTarget
    );
  }

  private async applyExecutionReport(report: ExecutionReport): Promise<void> {
    await applyTradingExecutionReportForTarget(
      report,
      this as unknown as TradingExecutionReportTarget
    );
  }

  private async runJanitor(source: "ALARM" | "ADMIN" = "ALARM"): Promise<void> {
    await runTradingEngineJanitorMaintenanceForTarget(
      source,
      this as unknown as TradingEngineJanitorMaintenanceTarget
    );
  }

  private async cancelOrder(
    orderId: string,
    reason: string,
    instrumentCode?: string
  ): Promise<void> {
    await cancelTradingJanitorOrder(
      {
        executioner: this.env.EXECUTIONER,
        logger: this.logger,
        orderId,
        reason,
        instrumentCode
      },
      {
        reserveCancelCapacity: (priority) => this.rateLimiter.reserve("default", priority),
        persistRateLimitState: () =>
          this.waitUntilStoragePut(
            RATE_LIMIT_STATE_KEY,
            this.rateLimiter.exportState(),
            "JANITOR_CANCEL_RATE_LIMIT"
          )
      }
    );
  }

  private async pruneOperationalLogs(): Promise<LogPruneReport> {
    return pruneTradingOperationalLogs({
      db: this.env.TRADING_DB,
      env: this.env,
      logger: this.logger
    });
  }

  private prepareShadowReplayState(
    initialShadowBankroll: number,
    startedAt: string,
    replayId: string
  ): void {
    prepareTradingShadowReplayStateForTarget(
      { initialShadowBankroll, startedAt, replayId },
      this as unknown as TradingShadowReplayStateTarget
    );
  }

  private async runHistoricalReplay(
    limit: number,
    shadowBankroll: number,
    speedMultiplier: number,
    dateFrom: string | null = null,
    dateTo: string | null = null,
    replayOptions: ReplayOptions = {
      scenario: "BASELINE",
      latencyMs: 10,
      slippageBps: 1,
      feeBps: 0,
      exitAfterTicks: 10,
      walkForward: false,
      sentimentAblation: true,
      strategyVersionId: null,
      actor: "admin"
    }
  ): Promise<ReplayResult> {
    return runTradingHistoricalReplayForTarget(
      {
        limit,
        shadowBankroll,
        speedMultiplier,
        dateFrom,
        dateTo,
        replayOptions
      },
      this as unknown as TradingHistoricalReplayEngineTarget
    );
  }

  private captureReplaySnapshot(): EngineReplaySnapshot {
    return captureTradingReplaySnapshotFromSource(this as unknown as TradingReplaySnapshotSource);
  }

  private async restoreReplaySnapshot(snapshot: EngineReplaySnapshot): Promise<void> {
    await restoreTradingReplaySnapshotForTarget(
      snapshot,
      this as unknown as TradingReplayRestoreTarget
    );
  }

  private updateLatencyAverage(totalLatencyMs: number): void {
    updateTradingLatencyAverageForTarget(
      totalLatencyMs,
      this as unknown as TradingLatencyStateTarget
    );
  }

  private resetLatencyBaseline(observedAt: string, reason: string): void {
    resetTradingLatencyBaselineForTarget(
      observedAt,
      reason,
      this as unknown as TradingLatencyStateTarget
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

  private performanceMetricsResponse(): Response {
    return buildTradingPerformanceMetricsResponseForTarget(
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

  private observeTopology(topology: EdgeTopology): void {
    observeTradingTopologyForTarget(topology, this as unknown as TradingTopologyTarget);
  }

  private applyLocationLatency(totalLatencyMs: number, observedAt: string): void {
    applyTradingLocationLatencyForTarget(
      totalLatencyMs,
      observedAt,
      this as unknown as TradingTopologyTarget
    );
  }

  private warmUpForTopology(topology: EdgeTopology): void {
    warmUpTradingTopologyForTarget(topology, this as unknown as TradingTopologyTarget);
  }

  private async refreshConfig(
    source: "ALARM" | "ADMIN_SIGNAL",
    configSnapshot?: GlobalRiskConfig
  ): Promise<void> {
    await refreshTradingEngineConfigForTarget(
      { source, configSnapshot },
      this as unknown as TradingEngineConfigControlTarget
    );
  }

  private async refreshConfigIfDue(source: "ALARM" | "ADMIN_SIGNAL"): Promise<void> {
    const now = Date.now();

    if (now - this.lastConfigRefreshAttemptAt < CONFIG_ALARM_INTERVAL_MS) {
      return;
    }

    this.lastConfigRefreshAttemptAt = now;
    await this.refreshConfig(source);
  }

  private async scheduleConfigRefresh(): Promise<void> {
    await this.safeSetAlarm(Date.now() + CONFIG_ALARM_INTERVAL_MS, "CONFIG_REFRESH_ALARM");
  }

  private async acceptAgentSignal(signal: AgentSignal, latencyMs: number): Promise<void> {
    await acceptTradingAgentSignalForTarget(
      signal,
      latencyMs,
      this as unknown as TradingSignalBusTarget
    );
  }

  private emitCascadeOperationalAlert(
    eventType: CascadeAlertEventType,
    title: string,
    message: string,
    metadata: JsonRecord,
    dedupeKey: string
  ): void {
    emitTradingCascadeOperationalAlertForTarget(
      eventType,
      title,
      message,
      metadata,
      dedupeKey,
      this as unknown as TradingSignalBusTarget
    );
  }

  private async ensureCascadePaperModeArmed(observedAt: string): Promise<void> {
    await ensureCascadePaperModeArmedForTarget(
      observedAt,
      this as unknown as CascadePaperModeArmingTarget
    );
  }

  private recordCascadeUiSignal(
    signal: AgentSignal,
    outcome: "TAKEN" | "SKIPPED" | "CLOSED"
  ): void {
    recordTradingCascadeUiSignalForTarget(
      signal,
      outcome,
      this as unknown as TradingSignalBusTarget
    );
  }

  private async applyConfigUpdate(update: AdminConfigUpdate): Promise<void> {
    await applyTradingEngineConfigUpdateForTarget(
      update,
      this as unknown as TradingEngineConfigControlTarget
    );
  }
}
