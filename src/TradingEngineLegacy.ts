import { ConfigManager, configDefaultsFromEnv, defaultConfig } from "./ConfigManager";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { Governor, neutralMacroBias } from "./Governor";
import { Logger, createLogSink, structuredConsoleLogsEnabled } from "./Logger";
import {
  ProfilerAgent,
  PROFILER_STATE_STORAGE_KEY,
  PROFILER_STATE_STORAGE_PREFIX,
  type ProfilerEvaluation
} from "./agents/ProfilerAgent";
import { ProfilerRegistry, createProfilerAgentFromEnv } from "./agents/ProfilerRegistry";
import {
  AnomalyDetector,
  ANOMALY_DETECTOR_STORAGE_KEY,
  type AnomalyDetectionResult
} from "./agents/AnomalyDetector";
import { CroupierAgent, type CroupierDecision } from "./agents/CroupierAgent";
import { applyExecutionAccounting } from "./engine/ExecutionAccounting";
import { evaluateIntentDispatchGate } from "./engine/IntentGeneration";
import { AdverseSelectionModel, adversePenaltyForQuoteSide } from "./engine/AdverseSelectionModel";
import {
  applyLocationRisk,
  defaultEngineLocation,
  locationChanged,
  locationTelemetry,
  readTopologyHeaders,
  resolveEngineLocation
} from "./engine/trading/helpers/PlacementResolver";
import {
  DEFAULT_ORDER_BOOK_TICK_SIZE,
  normalizePriceToTick,
  priceKey,
  roundCrypto,
  roundMetric,
  SortedBookSide
} from "./engine/trading/book/SortedBookSide";
import {
  buildMicrostructureSnapshot,
  countBookLevels,
  getInstrumentBook,
  isCrossedBook,
  microstructureFromBook
} from "./engine/trading/book/BookReconstruction";
import {
  calculateOrderBookPriceDiscovery,
  currentOrderBookSnapshot,
  findBestAssetBook as findBestOrderBookForAsset,
  selectOrderBookMarketKey
} from "./engine/trading/book/BookViews";
import {
  OrderBookReconstructor,
  type OrderBookStores
} from "./engine/trading/book/OrderBookReconstructor";
import type {
  AppliedBookUpdate,
  BookDeltaWithTicker,
  BookSyncState
} from "./engine/trading/book/BookTypes";
import {
  handleHyperliquidRawBatch,
  hyperliquidIngestConnectionKey,
  resolveHyperliquidBookTimestamp,
  type HyperliquidRawIngestPayload
} from "./engine/trading/ingest/HyperliquidRawIngest";
import { handleTradingEngineHttpRoute } from "./engine/trading/routes/EngineHttpRoutes";
import {
  acceptMarketStream as acceptTradingMarketStream,
  acceptTelemetryStream as acceptTradingTelemetryStream
} from "./engine/trading/routes/EngineWebSocketStreams";
import { TradingTelemetryBus } from "./engine/trading/telemetry/TelemetryBus";
import {
  type ReplayOptions,
  type ReplayScenario,
  type ReplayStatus
} from "./engine/trading/routes/ReplayAdminRoutes";
import { markHistoricalReplayTrades, ReplayJournal } from "./engine/trading/replay/ReplayJournal";
import type {
  GrpcFatalDropPayload,
  TickIngestResult
} from "./engine/trading/TradingEngineRouteTypes";
import {
  engineDiagnostics as buildEngineDiagnostics,
  syncStateMicrostructureFromBook as syncEngineStateMicrostructure
} from "./engine/trading/state/EngineDiagnostics";
import { StorageWriteGuard } from "./engine/trading/state/StorageWriteGuard";
import {
  LOW_VALUE_OPERATIONAL_EVENT_TYPES,
  operationalEventPlaceholders,
  resolveLogRetentionPolicy,
  type LogPruneReport
} from "./engine/LogRetention";
import {
  MultiScaleVolatilityModel,
  type MultiScaleVolatilitySnapshot
} from "./engine/MultiScaleVolatility";
import { bootstrapPaperAdverseSelection } from "./engine/PaperReplayModel";
import { QueuePositionModel } from "./engine/QueuePositionModel";
import { createShadowQueue } from "./engine/ShadowQueue";
import { isInventoryHedgeIntent } from "./execution/RiskGuards";
import {
  HeatmapAgent,
  LIQUIDATION_HEATMAP_STORAGE_KEY,
  defaultLiquidationHeatmapState
} from "./agents/HeatmapAgent";
import { JanitorAgent } from "./agents/JanitorAgent";
import { OracleAgent, defaultOracleState } from "./agents/OracleAgent";
import { PitBossAgent } from "./agents/PitBossAgent";
import { SentimentAgent, defaultSentimentState } from "./agents/SentimentAgent";
import { camouflageIntent } from "./utils/Camouflage";
import { RateLimiter, type RateLimitBucketSnapshot } from "./utils/RateLimiter";
import { planSmartOrderRoute } from "./utils/SOR";
import { Notifier } from "./utils/Notifier";
import { evaluateGrpcDrop, isShadowMode } from "./utils/CitadelProtocol";
import { GhostBook, type GhostBookConfig, type GhostBookObservation } from "./utils/GhostBook";
import { AbsorptionAnalyzer } from "./strategy/cascade/AbsorptionAnalyzer";
import {
  resolveCascadeAssetProfile,
  type CascadeAssetProfile
} from "./strategy/cascade/AssetProfiles";
import { Backtester } from "./strategy/cascade/Backtester";
import { CascadeCandleAggregator } from "./strategy/cascade/CandleAggregator";
import { CascadeDetector } from "./strategy/cascade/CascadeDetector";
import {
  CascadeRecoverySignalEngine,
  defaultCascadeRecoverySignalConfig
} from "./strategy/cascade/CascadeRecoverySignal";
import { calculateAtr } from "./strategy/cascade/indicators/ATR";
import { cumulativeVolumeDelta } from "./strategy/cascade/indicators/CumulativeVolumeDelta";
import { HyperliquidLiquidationStream } from "./strategy/cascade/LiquidationStream";
import { HeatManager } from "./strategy/cascade/HeatManager";
import { NewsCalendar } from "./strategy/cascade/NewsCalendar";
import {
  cascadeAlertPolicy,
  type CascadeAlertEventType
} from "./strategy/cascade/OperationalSafeguards";
import { PositionManager } from "./strategy/cascade/PositionManager";
import { calculatePositionSize } from "./strategy/cascade/PositionSizer";
import { calculateVwap } from "./strategy/cascade/indicators/VWAP";
import type { PerformanceSnapshot } from "./Logger";
import type {
  AdminConfigUpdate,
  AnomalyDetectorState,
  DomAnalysisSnapshot,
  DomHeatmapCell,
  EdgeTopology,
  EngineLocation,
  EngineStabilityStatus,
  ExecutionProfile,
  AgentHealth,
  AgentName,
  AgentSignal,
  AssetRuntimeState,
  BookSnapshotResponse,
  ExchangeOpenOrder,
  ExecutionReport,
  EngineState,
  Env,
  GlobalRiskConfig,
  GlobalRiskConfigUpdate,
  HealthReport,
  InternalOrderBook,
  InventoryState,
  JsonRecord,
  JsonValue,
  LatencyMetrics,
  LiquidationHeatmapState,
  LiquidityWall,
  MacroBias,
  MarketDataSource,
  MarketTransport,
  MarketTick,
  ManagedOrder,
  MicrostructureMetrics,
  OrderBookDelta,
  OrderBookResetRequest,
  OrderBookSide,
  OrderBookSnapshot,
  OrderBookSnapshotLevel,
  PriceLevel,
  PriceDiscoveryMetrics,
  Position,
  ProfilerState,
  ReplayResult,
  RiskLimits,
  SentimentState,
  ShadowQueueDecision,
  ShadowQueueFill,
  ShadowQueueState,
  TemporaryGovernanceOverride,
  TradeExecution,
  TradeIntent
} from "./types";
import type {
  AbsorptionAnalyzerConfig,
  AbsorptionObservation,
  AbsorptionConfirmed,
  CascadeDetectorConfig,
  CascadeEvent,
  CascadeOpenPosition,
  CascadePositionIntent,
  CascadeRecoverySignal,
  CascadeRecoverySignalConfig,
  LiquidationEvent
} from "./strategy/cascade/types";

import {
  ENGINE_STATE_KEY,
  ORDER_BOOK_PREFIX,
  PERFORMANCE_HISTORY_KEY,
  CASCADE_POSITIONS_KEY,
  CASCADE_PAPER_ARMED_AT_KEY,
  CASCADE_LAST_BACKTEST_REPORT_KEY,
  RISK_LIMITS_KEY,
  CONFIG_KEY,
  DEFAULT_MAX_LATENCY_MS,
  DEFAULT_NATIVE_HL_MAX_LATENCY_MS,
  DEFAULT_DWELLIR_NATIVE_HL_MAX_LATENCY_MS,
  DEFAULT_HARD_STALE_DROP_MS,
  DEFAULT_HL_BOOK_TIMESTAMP_MAX_DRIFT_MS,
  DEFAULT_HL_SEQUENCE_GAP_MS,
  PERFORMANCE_HISTORY_LIMIT,
  CONFIG_ALARM_INTERVAL_MS,
  WARM_UP_INTERVAL_MS,
  SIGNAL_BUFFER_LIMIT,
  ADMIN_STREAM_PULSE_INTERVAL_MS,
  AGENT_SNAPSHOT_TICK_INTERVAL,
  DEFAULT_HOT_STORAGE_SNAPSHOT_INTERVAL_MS,
  DEFAULT_HOT_STORAGE_SNAPSHOT_TICK_INTERVAL,
  STORAGE_WRITE_BACKOFF_MS,
  BOOK_SNAPSHOT_TOP_LEVELS,
  TOP_OF_BOOK_CROSS_CHECK_INTERVAL_MS,
  DEFAULT_SOURCE_WEIGHT,
  PROCESSING_LATENCY_SAMPLES_KEY,
  DOM_WALL_HISTORY_KEY,
  RATE_LIMIT_STATE_KEY,
  EXECUTION_QUEUE_KEY,
  PAPER_SESSION_STARTED_AT_KEY,
  HOT_PATH_LOG_THROTTLE_MS,
  DEFAULT_JITTER_SAMPLE_WINDOW,
  DEFAULT_JITTER_COMPUTE_INTERVAL_TICKS,
  DEFAULT_JITTER_THRESHOLD_MS,
  COLD_START_WAKEUP_THRESHOLD_MS,
  DEFAULT_DOM_PRICE_BIN_SIZE,
  DEFAULT_DOM_SCAN_RANGE_PCT,
  DEFAULT_DOM_WALL_HISTORY_LIMIT,
  DEFAULT_DOM_SPOOF_PROXIMITY_BPS,
  DOM_MAX_LEVELS_PER_SIDE,
  DEFAULT_ANOMALY_PRICE_Z_THRESHOLD,
  DEFAULT_ANOMALY_VOLUME_Z_THRESHOLD,
  DEFAULT_ANOMALY_CANCEL_EXEC_RATIO_THRESHOLD,
  DEFAULT_ANOMALY_PRICE_WINDOW_MS,
  DEFAULT_ANOMALY_VOLUME_WINDOW_MS,
  DEFAULT_ANOMALY_TOP_OF_BOOK_WINDOW_MS,
  DEFAULT_EXCHANGE_FEE_BPS,
  DEFAULT_MIN_EV_THRESHOLD,
  DEFAULT_MAX_POSITION_PCT,
  DEFAULT_MAX_INVENTORY_UNITS,
  DEFAULT_MAX_INVENTORY_DELTA,
  DEFAULT_RISK_AVERSION_FACTOR,
  DEFAULT_FUNDING_BIAS_THRESHOLD,
  DEFAULT_FUNDING_INVENTORY_BIAS,
  DEFAULT_AMM_MIN_TICK_CHANGE,
  DEFAULT_HEATMAP_PRICE_BIN_SIZE,
  DEFAULT_HEATMAP_CLUSTER_NOTIONAL_USD,
  DEFAULT_CASCADE_DISTANCE_PCT,
  DEFAULT_PREDATORY_ORDER_OFFSET_BPS,
  DEFAULT_QUOTE_HIBERNATE_MS,
  DEFAULT_PAPER_BANKROLL_USD,
  DEFAULT_PAPER_MAX_GHOST_FILLS_PER_MINUTE,
  DEFAULT_PAPER_FILL_PARTICIPATION_RATE,
  DEFAULT_PAPER_FILL_ADVERSE_BPS,
  DEFAULT_PAPER_MAKER_FEE_BPS,
  DEFAULT_QUOTE_REFRESH_MIN_INTERVAL_MS,
  DEFAULT_QUOTE_REFRESH_MIN_PRICE_TICKS,
  DEFAULT_CROSS_ASSET_CANCEL_LEAD_BPS,
  DEFAULT_CROSS_ASSET_CANCEL_COOLDOWN_MS,
  DEFAULT_MARKET_TICK_JOURNAL_INTERVAL,
  DEFAULT_MARKET_TICK_MAX_ROWS,
  DEFAULT_SHADOW_VLO_CAPACITY,
  DEFAULT_SHADOW_VLO_DRIFT_TRADES,
  DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
  DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS,
  DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS,
  DEFAULT_SHADOW_VLO_MIN_SIZE,
  DEFAULT_SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS,
  DEFAULT_VAR_CONFIDENCE_Z,
  TARGET_ASSET_MATRIX,
  TARGET_INSTRUMENTS,
  DEFAULT_JANITOR_INTERVAL_MS,
  DEFAULT_ORDER_ACK_TIMEOUT_MS,
  AGGREGATED_BUS_TELEMETRY_TYPES
} from "./TradingEngineConstants";
import {
  isNativeRecord,
  nativeObject,
  nativeString,
  requireNativeString,
  nativeIso,
  nativeExchangeTimestamp,
  epochMillis,
  nativeSequence,
  nativeHashSequence,
  hyperliquidNativeInstrumentCode,
  normalizeNativeCoin,
  normalizeNativeInstrumentCode,
  normalizeInstrumentSelector,
  splitNativeInstrument,
  baseAssetFromInstrument,
  cascadeInstrumentSet,
  latestAbsorptionForInstrument,
  latestCascadeAtForInstrument,
  isOpenCascadePosition,
  recentSwingLow,
  recentSwingHigh,
  parseHyperliquidNativeLevels,
  nativeBookSideLevels,
  nativeNumber,
  nativeSide,
  createNativeHyperliquidBookTick,
  createNativeHyperliquidTradeTick,
  createNativeHyperliquidFundingTick,
  nativeHyperliquidLatencyMetrics,
  hasRuntimeConfigUpdate,
  defaultEngineState,
  defaultEnsembleState,
  normalizePaperBankroll,
  parseDeltaNormalizationWeights,
  inferSignalBias,
  hawkesEvacuationSignal,
  touchAgentHealth,
  disabledProfilerEvaluation,
  disabledCroupierDecision,
  defaultExecutionProfile,
  defaultAnomalyStatus,
  normalizeExecutionProfile,
  defaultMicrostructure,
  defaultPriceDiscovery,
  defaultLeadLagMetrics,
  defaultInventoryState,
  normalizeInventoryState,
  defaultRiskMetrics,
  defaultQuoteState,
  defaultAssetQuoteStates,
  defaultShadowQueueState,
  defaultCitadelState,
  maintenanceRecoveryInstruments,
  defaultInventoryGuardState,
  passiveInventoryGuardStateFromInventory,
  defaultJanitorState,
  logPruneReportToJson,
  logRetentionPolicyToJson,
  defaultSlippageAnalytics,
  defaultRiskLimits,
  mergeRiskLimits,
  resolveMaxLatencyMs,
  processingLatencyStats,
  prometheusMetric,
  prometheusLabels,
  escapePrometheusLabel,
  finiteMetric,
  nullableFiniteMetric,
  highResolutionNow,
  parseTimestampMs,
  roundLatency,
  resolveBookSide,
  resolveCurrentInstrument,
  buildMarketKey,
  profilerStorageKey,
  selectedMoltworkerInstruments,
  isTargetInstrument,
  isInstrumentSelectedByMoltworker,
  normalizeAssetMatrix,
  filterTargetOrderBooks,
  defaultAssetMatrix,
  normalizeAssetQuoteStates,
  reconcileAssetQuoteStatesForConfig,
  quoteStateForInstrumentState,
  isQuoteSuspendedAt,
  suspendAssetQuoteStates,
  resumeExpiredAssetQuoteStates,
  aggregateQuoteState,
  quotePriceMovedTicks,
  adverseAdjustedPaperFillPrice,
  normalizeMarketKey,
  normalizeSourceExchange,
  normalizeSourceWeight,
  aggregateDomBins,
  volumeStats,
  isLiquidityWall,
  toLiquidityWall,
  wallIdForBin,
  latestActiveWalls,
  classifyMissingWalls,
  wasWallFilled,
  domHeatmapCell,
  emptyDomSnapshot,
  distanceBps,
  sanitizeWallHistory,
  isLiquidityWallRecord,
  toJsonValue,
  deepClone,
  hydrateOrderBooks,
  hydrateLegacyLevel,
  levelsToBookSide,
  tickToDelta,
  calculateTimeToBookMs,
  mapManagedStatusToTradeStatus,
  isPortfolioFillStatus,
  executionReportSize,
  positiveNumber,
  executionTradeId,
  inferExecutionPrimaryDriver,
  resolveTickSize,
  resolveDomBinSize,
  parseTickSizeMap,
  parsePositiveNumberMap,
  appendSlippagePoint,
  quoteToTelemetry,
  quoteStateTelemetry,
  compareQueuedExecutionIntent,
  returns,
  pearson,
  wait,
  readNumber,
  readPositiveNumber,
  applyReplayScenarioToTick,
  modelReplayIntentTrade,
  findReplayExitTick,
  inferIntentDriver,
  buildReplayAttribution,
  bucketReplayTrades,
  buildReplayEquityCurve,
  calculateMaxDrawdown,
  calculateReplaySharpe,
  calculateWinRate,
  buildStressSummary,
  buildReplayWalkForward,
  buildReplayAblation,
  readPositiveInteger,
  readBoundedNumber,
  resolveGhostBookConfig,
  clampInteger,
  assertAgentSignal,
  finiteNumber,
  isInformationalTick,
  isTradeTick,
  extractTickStreamId,
  isPlainObject,
  readHyperliquidRawIngestPayload,
  readJsonOrNull,
  json
} from "./TradingEngineRuntimeHelpers";
interface PerformanceMemory {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
}

interface ExecutionTraceInput {
  wakeUpTimeMs: number | null;
  orderBookUpdateMs: number | null;
  agentLogicMs: number | null;
  hotPathStartedAt: number;
  observedAt: string;
}

interface TickHandlingOptions {
  shadowReplay?: boolean;
}

interface EngineReplaySnapshot {
  engineState: EngineState;
  orderBooks: InternalOrderBook[];
  latencyHistory: LatencyMetrics[];
  processingLatencySamples: number[];
  domWallHistory: LiquidityWall[];
  leadLagSamples: Array<[string, Array<{ price: number; observedAt: string }>]>;
  cachedConfig: GlobalRiskConfig;
  maxLatencyMs: number;
  lastTickTimestamp: string | null;
  profilerState: ProfilerState;
  profilerStates: Array<[string, ProfilerState]>;
  anomalyState: AnomalyDetectorState;
  oracleState: EngineState["oracle"];
  sentimentState: EngineState["sentiment"];
  rateLimits: Record<string, RateLimitBucketSnapshot>;
  signals: AgentSignal[];
  latestAgentSignals: Array<[AgentName, AgentSignal]>;
}

interface QueuedExecutionIntent {
  intent: TradeIntent;
  priority: "CANCEL" | "NEW";
  runAfterMs: number;
  enqueuedAt: string;
}

interface DomBinAccumulator {
  side: OrderBookSide;
  priceStart: number;
  priceEnd: number;
  centerPrice: number;
  volume: number;
  levelCount: number;
}

type RuntimeWithMemory = typeof globalThis & {
  performance?: Performance & { memory?: PerformanceMemory };
};

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
    this.configManager = new ConfigManager(env.CONFIG_STORE, configDefaultsFromEnv(env));
    this.governor = new Governor(env.CONFIG_STORE);
    this.cascadeNewsCalendar = new NewsCalendar(env.CONFIG_STORE);
    this.cascadeBacktester = new Backtester(env.TRADING_DB);
    this.ghostBook = createShadowQueue(env);
    this.storageGuard = new StorageWriteGuard(state.storage, STORAGE_WRITE_BACKOFF_MS);
    this.telemetryBus = new TradingTelemetryBus({
      env,
      adminSockets: this.adminSockets,
      waitUntil: (promise) => state.waitUntil(promise)
    });
    this.jitterSampleWindow = readPositiveInteger(
      env.JITTER_SAMPLE_WINDOW,
      DEFAULT_JITTER_SAMPLE_WINDOW,
      10,
      10_000
    );
    this.jitterComputeIntervalTicks = readPositiveInteger(
      env.JITTER_COMPUTE_INTERVAL_TICKS,
      DEFAULT_JITTER_COMPUTE_INTERVAL_TICKS,
      1,
      10_000
    );
    this.jitterThresholdMs = readPositiveNumber(
      env.JITTER_THRESHOLD_MS,
      DEFAULT_JITTER_THRESHOLD_MS
    );
    this.domPriceBinSize = readPositiveNumber(
      env.DOM_PRICE_BIN_SIZE_DEFAULT,
      DEFAULT_DOM_PRICE_BIN_SIZE
    );
    this.domScanRangePct = readBoundedNumber(
      env.DOM_SCAN_RANGE_PCT,
      DEFAULT_DOM_SCAN_RANGE_PCT,
      0.001,
      0.1
    );
    this.domWallHistoryLimit = readPositiveInteger(
      env.DOM_WALL_HISTORY_LIMIT,
      DEFAULT_DOM_WALL_HISTORY_LIMIT,
      50,
      5_000
    );
    this.domSpoofProximityBps = readPositiveNumber(
      env.DOM_SPOOF_PROXIMITY_BPS,
      DEFAULT_DOM_SPOOF_PROXIMITY_BPS
    );
    this.profilerAgent = createProfilerAgentFromEnv(env);
    this.profilerRegistry = new ProfilerRegistry(env, this.profilerAgent, () => this.cachedConfig);
    this.heatmapAgent = new HeatmapAgent({
      coin: env.HL_ASSET ?? "BTC",
      instrumentCode: `${(env.HL_ASSET ?? "BTC").toLowerCase()}-usd`,
      sourceExchange: "hyperliquid",
      binSize: readPositiveNumber(env.HL_HEATMAP_PRICE_BIN_SIZE, DEFAULT_HEATMAP_PRICE_BIN_SIZE),
      clusterThresholdUsd: readPositiveNumber(
        env.HL_HEATMAP_CLUSTER_NOTIONAL_USD,
        DEFAULT_HEATMAP_CLUSTER_NOTIONAL_USD
      ),
      cascadeDistancePct: readPositiveNumber(
        env.HL_CASCADE_DISTANCE_PCT,
        DEFAULT_CASCADE_DISTANCE_PCT
      )
    });
    this.cascadeDetector = new CascadeDetector({
      windowMs: readPositiveInteger(
        env.CASCADE_WINDOW_MS,
        defaultConfig.CASCADE_WINDOW_MS,
        60_000,
        3_600_000
      ),
      notionalThresholdUsd: readPositiveNumber(
        env.CASCADE_NOTIONAL_THRESHOLD_USD,
        defaultConfig.CASCADE_NOTIONAL_THRESHOLD_USD
      ),
      zScoreThreshold: readPositiveNumber(
        env.CASCADE_ZSCORE_THRESHOLD,
        defaultConfig.CASCADE_ZSCORE_THRESHOLD
      ),
      lookbackHours: readPositiveInteger(
        env.CASCADE_LOOKBACK_HOURS,
        defaultConfig.CASCADE_LOOKBACK_HOURS,
        1,
        168
      ),
      directionalPct: readBoundedNumber(
        env.CASCADE_DIRECTIONAL_PCT,
        defaultConfig.CASCADE_DIRECTIONAL_PCT,
        0.5,
        1
      ),
      minPriceMoveAtr: readBoundedNumber(
        env.CASCADE_MIN_PRICE_MOVE_ATR,
        defaultConfig.CASCADE_MIN_PRICE_MOVE_ATR,
        0,
        10
      ),
      minBaselineWindows: readPositiveInteger(env.CASCADE_MIN_BASELINE_WINDOWS, 12, 0, 10_000),
      minCascadeSeparationMs: readPositiveInteger(
        env.CASCADE_MIN_SEPARATION_MS,
        defaultConfig.CASCADE_WINDOW_MS,
        0,
        6 * 3_600_000
      ),
      maxEventsPerInstrument: readPositiveInteger(
        env.CASCADE_MAX_EVENTS_PER_INSTRUMENT,
        10_000,
        100,
        100_000
      )
    });
    this.absorptionAnalyzer = new AbsorptionAnalyzer({
      absorptionWindowMs: readPositiveInteger(
        env.ABSORPTION_WINDOW_MS,
        defaultConfig.ABSORPTION_WINDOW_MS,
        60_000,
        6 * 3_600_000
      ),
      priceBandBps: readPositiveNumber(
        env.ABSORPTION_PRICE_BAND_BPS,
        defaultConfig.ABSORPTION_PRICE_BAND_BPS
      ),
      minHoldSeconds: readPositiveInteger(
        env.ABSORPTION_MIN_HOLD_SECONDS,
        defaultConfig.ABSORPTION_MIN_HOLD_SECONDS,
        5,
        3_600
      ),
      oiStabilityBps: readPositiveNumber(env.ABSORPTION_OI_STABILITY_BPS, 5),
      maxActiveCascades: readPositiveInteger(env.ABSORPTION_MAX_ACTIVE_CASCADES, 24, 1, 100)
    });
    this.anomalyDetector = new AnomalyDetector({
      priceZThreshold: readPositiveNumber(
        env.ANOMALY_PRICE_Z_THRESHOLD,
        DEFAULT_ANOMALY_PRICE_Z_THRESHOLD
      ),
      volumeZThreshold: readPositiveNumber(
        env.ANOMALY_VOLUME_Z_THRESHOLD,
        DEFAULT_ANOMALY_VOLUME_Z_THRESHOLD
      ),
      cancelExecutionRatioThreshold: readPositiveNumber(
        env.ANOMALY_CANCEL_EXEC_RATIO_THRESHOLD,
        DEFAULT_ANOMALY_CANCEL_EXEC_RATIO_THRESHOLD
      ),
      priceWindowMs: readPositiveInteger(
        env.ANOMALY_PRICE_WINDOW_MS,
        DEFAULT_ANOMALY_PRICE_WINDOW_MS,
        5_000,
        600_000
      ),
      volumeWindowMs: readPositiveInteger(
        env.ANOMALY_VOLUME_WINDOW_MS,
        DEFAULT_ANOMALY_VOLUME_WINDOW_MS,
        60_000,
        3_600_000
      ),
      topOfBookWindowMs: readPositiveInteger(
        env.ANOMALY_TOP_OF_BOOK_WINDOW_MS,
        DEFAULT_ANOMALY_TOP_OF_BOOK_WINDOW_MS,
        60_000,
        3_600_000
      )
    });
    this.croupierAgent = new CroupierAgent({
      minEvThreshold: readNumber(env.MIN_EV_THRESHOLD, DEFAULT_MIN_EV_THRESHOLD),
      exchangeFeeBps: readPositiveNumber(env.EXCHANGE_FEE_BPS, DEFAULT_EXCHANGE_FEE_BPS),
      riskAversionFactor: readPositiveNumber(
        env.RISK_AVERSION_FACTOR,
        DEFAULT_RISK_AVERSION_FACTOR
      ),
      minTickChange: readPositiveNumber(env.AMM_MIN_TICK_CHANGE, DEFAULT_AMM_MIN_TICK_CHANGE)
    });
    this.rateLimiter.configure("default", 10, 10);
    this.logger = new Logger(
      env.TRADING_DB,
      (promise) => this.state.waitUntil(promise),
      "TradingEngine",
      () => ({
        lastTickTimestamp: this.lastTickTimestamp,
        orderBookImbalance: this.engineState.microstructure.weightedImbalance,
        colo: this.engineState.location.colo,
        placement: this.engineState.location.placement,
        latencyRiskMultiplier: this.engineState.location.latencyRiskMultiplier,
        positionSizeMultiplier: this.engineState.location.positionSizeMultiplier
      }),
      createLogSink(env),
      structuredConsoleLogsEnabled(env)
    );
    this.notifier = new Notifier(env, (promise) => this.state.waitUntil(promise));
    this.replayJournal = new ReplayJournal({
      env,
      logger: this.logger,
      readStorage: (key) => this.state.storage.get(key),
      writeStorage: (key, value, reason) => this.safeStoragePut(key, value, reason),
      publish: (type, payload, correlationId) => this.publish(type, payload, correlationId),
      onStorageReadFailure: (reason, error) => this.handleStorageWriteFailure(reason, error)
    });
    this.orderBookReconstructor = this.createOrderBookReconstructor();

    this.initialized = this.state.blockConcurrencyWhile(async () => {
      let persistedState: EngineState | undefined;
      let persistedBooks = new Map<string, InternalOrderBook>();
      let persistedLatencyHistory: LatencyMetrics[] | undefined;
      let persistedProcessingLatencySamples: number[] | undefined;
      let persistedDomWallHistory: LiquidityWall[] | undefined;
      let persistedProfilerState: ProfilerState | undefined;
      let persistedProfilerStates = new Map<string, ProfilerState>();
      let persistedHeatmapState: LiquidationHeatmapState | undefined;
      let persistedAnomalyState: AnomalyDetectorState | undefined;
      let persistedRateLimits: Record<string, RateLimitBucketSnapshot> | undefined;
      let persistedCascadePositions: CascadeOpenPosition[] | undefined;
      let kvRiskLimits: Partial<RiskLimits> | null = null;
      let kvConfig: AdminConfigUpdate | null = null;

      try {
        [
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
        ] = await Promise.all([
          this.state.storage.get<EngineState>(ENGINE_STATE_KEY),
          this.state.storage.list<InternalOrderBook>({ prefix: ORDER_BOOK_PREFIX }),
          this.state.storage.get<LatencyMetrics[]>(PERFORMANCE_HISTORY_KEY),
          this.state.storage.get<number[]>(PROCESSING_LATENCY_SAMPLES_KEY),
          this.state.storage.get<LiquidityWall[]>(DOM_WALL_HISTORY_KEY),
          this.state.storage.get<ProfilerState>(PROFILER_STATE_STORAGE_KEY),
          this.state.storage.list<ProfilerState>({ prefix: PROFILER_STATE_STORAGE_PREFIX }),
          this.state.storage.get<LiquidationHeatmapState>(LIQUIDATION_HEATMAP_STORAGE_KEY),
          this.state.storage.get<AnomalyDetectorState>(ANOMALY_DETECTOR_STORAGE_KEY),
          this.state.storage.get<Record<string, RateLimitBucketSnapshot>>(RATE_LIMIT_STATE_KEY),
          this.state.storage.get<CascadeOpenPosition[]>(CASCADE_POSITIONS_KEY),
          this.env.RISK_VAULT.get<Partial<RiskLimits>>(RISK_LIMITS_KEY, "json"),
          this.env.CONFIG_STORE.get<AdminConfigUpdate>(CONFIG_KEY, "json")
        ]);
      } catch (error) {
        this.handleStorageWriteFailure("SYSTEM_INIT_STORAGE_READ", error);
        try {
          [kvRiskLimits, kvConfig] = await Promise.all([
            this.env.RISK_VAULT.get<Partial<RiskLimits>>(RISK_LIMITS_KEY, "json"),
            this.env.CONFIG_STORE.get<AdminConfigUpdate>(CONFIG_KEY, "json")
          ]);
        } catch (kvError) {
          this.handleStorageWriteFailure("SYSTEM_INIT_KV_FALLBACK_READ", kvError);
        }
      }

      const baseState = persistedState ?? defaultEngineState(this.state.id.toString());
      const now = new Date().toISOString();

      const hydratedBooks = hydrateOrderBooks(filterTargetOrderBooks(persistedBooks));

      this.orderBook = hydratedBooks.snapshots;
      this.bids = hydratedBooks.bids;
      this.asks = hydratedBooks.asks;
      this.bookSync = hydratedBooks.sync;
      this.rebindOrderBookReconstructor();
      this.ghostBook.hydrate(baseState.shadowQueue);
      this.cascadePositionManager.hydrate(persistedCascadePositions ?? []);
      this.hydrateProfilerAgents(persistedProfilerState, persistedProfilerStates);
      this.heatmapAgent.hydrate(persistedHeatmapState ?? baseState.liquidationHeatmap);
      this.anomalyDetector.hydrate(persistedAnomalyState);
      this.rateLimiter.hydrate(persistedRateLimits);
      this.oracleAgent.hydrate(baseState.oracle);
      this.sentimentAgent.hydrate(baseState.sentiment);
      this.lastTickTimestamp = baseState.microstructure?.updatedAt ?? baseState.updatedAt ?? null;
      this.latencyHistory = (persistedLatencyHistory ?? []).slice(-PERFORMANCE_HISTORY_LIMIT);
      this.processingLatencySamples = (persistedProcessingLatencySamples ?? [])
        .filter((sample) => Number.isFinite(sample) && sample >= 0)
        .slice(-this.jitterSampleWindow);
      this.domWallHistory = sanitizeWallHistory(persistedDomWallHistory).slice(
        -this.domWallHistoryLimit
      );
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
      this.configureProfilerAgents(this.cachedConfig);
      this.maxLatencyMs = this.cachedConfig.LATENCY_THRESHOLD_MS;
      const location = baseState.location ?? defaultEngineLocation();
      const risk = applyLocationRisk(
        mergeRiskLimits(mergeRiskLimits(baseState.risk, kvRiskLimits), kvConfig?.risk),
        this.cachedConfig,
        location,
        now
      );
      const bankroll = normalizePaperBankroll(
        {
          ...baseState.bankroll,
          ...kvConfig?.bankroll,
          updatedAt: now
        },
        this.env,
        now
      );

      this.engineState = {
        ...baseState,
        mode: kvConfig?.mode ?? baseState.mode,
        bankroll,
        agentHealth: {
          ...defaultEngineState(baseState.engineId).agentHealth,
          ...baseState.agentHealth
        },
        risk,
        internalOrderBookDepth: countBookLevels(this.bids, this.asks),
        averageLatency: baseState.averageLatency ?? 0,
        latencySampleCount: baseState.latencySampleCount ?? 0,
        staleTickCount: baseState.staleTickCount ?? 0,
        toxicityScore: baseState.toxicityScore ?? this.maxProfilerToxicity(),
        current_inventory_delta:
          baseState.current_inventory_delta ??
          baseState.inventory?.current_inventory_delta ??
          baseState.inventory?.netDelta ??
          0,
        liquidationHeatmap: this.heatmapAgent.snapshot(),
        maxLatencyMs: this.maxLatencyMs,
        cachedConfig: this.cachedConfig,
        macroBias: this.macroBias,
        temporaryOverride: this.activeTemporaryOverride,
        assetMatrix: normalizeAssetMatrix(
          baseState.assetMatrix,
          this.cachedConfig,
          this.macroBias,
          now
        ),
        assetQuoteStates: normalizeAssetQuoteStates(
          baseState.assetQuoteStates,
          this.cachedConfig,
          this.macroBias,
          now
        ),
        profilerStates: this.profilerStateSnapshot(),
        location,
        fundingRates: baseState.fundingRates ?? {},
        microstructure: baseState.microstructure ?? defaultMicrostructure(),
        priceDiscovery:
          baseState.priceDiscovery ??
          this.calculatePriceDiscovery(baseState.microstructure?.instrumentCode, now),
        oracle: baseState.oracle ?? defaultOracleState(),
        sentiment: baseState.sentiment ?? defaultSentimentState(),
        ensemble: baseState.ensemble ?? defaultEnsembleState(now),
        leadLag: baseState.leadLag ?? defaultLeadLagMetrics(),
        inventory: normalizeInventoryState(
          baseState.inventory,
          readPositiveNumber(this.env.MAX_INVENTORY_UNITS, DEFAULT_MAX_INVENTORY_UNITS),
          readPositiveNumber(this.env.MAX_INVENTORY_DELTA, DEFAULT_MAX_INVENTORY_DELTA)
        ),
        riskMetrics: baseState.riskMetrics ?? defaultRiskMetrics(bankroll.equity, now),
        quoteState: baseState.quoteState ?? defaultQuoteState(),
        shadowQueue: this.ghostBook.snapshot(now),
        lastTradeIntent: baseState.lastTradeIntent ?? null,
        inventoryGuard:
          baseState.inventoryGuard ??
          (baseState as EngineState & { hedge?: EngineState["inventoryGuard"] }).hedge ??
          defaultInventoryGuardState(),
        janitor: baseState.janitor ?? defaultJanitorState(),
        slippage: baseState.slippage ?? defaultSlippageAnalytics(),
        orderMap: baseState.orderMap ?? {},
        executionProfile: normalizeExecutionProfile(
          baseState.executionProfile,
          this.jitterThresholdMs,
          this.jitterSampleWindow,
          this.jitterComputeIntervalTicks,
          this.processingLatencySamples.length,
          now
        ),
        citadel: {
          ...(baseState.citadel ?? defaultCitadelState(now)),
          shadowMode: isShadowMode(this.env),
          updatedAt: now
        },
        dom: baseState.dom ?? null,
        anomaly: baseState.anomaly ?? this.anomalyDetector.status,
        heartbeatAt: now,
        updatedAt: now
      };
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
    return {
      orderBook: this.orderBook,
      bids: this.bids,
      asks: this.asks,
      sync: this.bookSync
    };
  }

  private createOrderBookReconstructor(): OrderBookReconstructor {
    return new OrderBookReconstructor(this.orderBookStores(), {
      topLevels: BOOK_SNAPSHOT_TOP_LEVELS,
      topOfBookCrossCheckIntervalMs: TOP_OF_BOOK_CROSS_CHECK_INTERVAL_MS,
      resolveTickSize: (instrumentCode, override) =>
        resolveTickSize(this.env, instrumentCode, override),
      normalizeSourceExchange,
      normalizeMarketKey,
      buildMarketKey,
      normalizeSourceWeight,
      calculateTimeToBookMs,
      warn: (eventType, message, metadata) => this.logger.warn(eventType, message, metadata),
      error: (eventType, message, metadata) => this.logger.error(eventType, message, metadata),
      publish: (type, payload) => this.publish(type, payload),
      resetOrderBook: (payload) => this.resetOrderBook(payload)
    });
  }

  private rebindOrderBookReconstructor(): void {
    this.orderBookReconstructor.replaceStores(this.orderBookStores());
  }

  async alarm(): Promise<void> {
    await this.initialized;
    await this.refreshConfig("ALARM");
    await this.drainExecutionQueue();
    await this.runJanitor("ALARM");
    this.maybeResumeQuotes(new Date().toISOString());
    await this.scheduleConfigRefresh();
  }

  async fetch(request: Request): Promise<Response> {
    const fetchStartedAt = highResolutionNow();
    await this.initialized;
    const wakeUpTimeMs = roundLatency(highResolutionNow() - fetchStartedAt);
    this.latestWakeUpTimeMs = wakeUpTimeMs;

    const url = new URL(request.url);
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    const topology = readTopologyHeaders(request);
    const sourceHeader = request.headers.get("x-source")?.toLowerCase() ?? "";
    const isMarketDataRequest =
      sourceHeader.includes("ingest") ||
      url.pathname === "/tick" ||
      url.pathname === "/ticks" ||
      url.pathname === "/market/tick" ||
      url.pathname === "/hyperliquid/tick" ||
      url.pathname === "/hyperliquid/raw";

    if (isMarketDataRequest) {
      this.observeTopology(topology);
      this.warmUpForTopology(topology);
    }

    if (
      request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
      url.pathname === "/stream"
    ) {
      return this.acceptTelemetryStream();
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.acceptMarketStream();
    }

    try {
      return await handleTradingEngineHttpRoute(request, url, {
        env: this.env,
        state: this.state,
        logger: this.logger,
        wakeUpTimeMs,
        getEngineState: () => this.engineState,
        setEngineState: (state) => {
          this.engineState = state;
        },
        getOrderBook: () => this.orderBook,
        getLatencyHistory: () => this.latencyHistory,
        getProcessingLatencySamples: () => this.processingLatencySamples,
        getCachedConfig: () => this.cachedConfig,
        getCascadeBacktester: () => this.cascadeBacktester,
        getCascadeNewsCalendar: () => this.cascadeNewsCalendar,
        refreshConfigIfDue: (source) => this.refreshConfigIfDue(source),
        healthCheck: () => this.healthCheck(),
        engineDiagnostics: () => this.engineDiagnostics(),
        syncStateMicrostructureFromBook: () => this.syncStateMicrostructureFromBook(),
        performanceMetricsResponse: () => this.performanceMetricsResponse(),
        resetLatencyBaseline: (observedAt, reason) => this.resetLatencyBaseline(observedAt, reason),
        publish: (type, payload, correlationId) => this.publish(type, payload, correlationId),
        safeStoragePutEntries: (entries, reason) => this.safeStoragePut(entries, reason),
        safeStoragePutKey: (key, value, reason) => this.safeStoragePut(key, value, reason),
        recoverEngineState: (payload) => this.recoverEngineState(payload),
        pruneOperationalLogs: () => this.pruneOperationalLogs(),
        currentBookSnapshot: (instrumentCode, depth) =>
          this.currentBookSnapshot(instrumentCode, depth),
        currentDomHeatmap: (instrumentCode) => this.currentDomHeatmap(instrumentCode),
        applySnapshot: (snapshot) => this.applySnapshot(snapshot),
        applyDelta: (delta, observedAt) => this.applyDelta(delta, observedAt),
        enqueueOrderBookReset: (payload) => this.enqueueOrderBookReset(payload),
        registerIngestConnection: (payload) => this.registerIngestConnection(payload),
        runHistoricalReplay: (limit, shadowBankroll, speedMultiplier, dateFrom, dateTo, options) =>
          this.runHistoricalReplay(
            limit,
            shadowBankroll,
            speedMultiplier,
            dateFrom,
            dateTo,
            options
          ),
        currentReplayStatus: () => this.currentReplayStatus(),
        currentCascadeActiveSnapshot: () => this.currentCascadeActiveSnapshot(),
        currentCascadeSignalSnapshot: (limit) => this.currentCascadeSignalSnapshot(limit),
        currentCascadePositionSnapshot: () => this.currentCascadePositionSnapshot(),
        closeCascadePosition: (positionId, actor, reason) =>
          this.closeCascadePosition(positionId, actor, reason),
        currentCascadeHeatSnapshot: () => this.currentCascadeHeatSnapshot(),
        analyzeSentimentHeadline: (headline) =>
          this.sentimentAgent.analyzeHeadline(headline, this.env),
        applyExecutionReport: (report) => this.applyExecutionReport(report),
        enqueueTick: (tick, wakeUp) => this.enqueueTick(tick, wakeUp),
        handleHyperliquidRaw: (payload, wakeUp) =>
          this.handleHyperliquidRaw(payload as HyperliquidRawIngestPayload, wakeUp),
        handleGrpcFatalDrop: (payload) => this.handleGrpcFatalDrop(payload),
        acceptAgentSignal: (signal, latencyMs) => this.acceptAgentSignal(signal, latencyMs),
        applyConfigUpdate: (update) => this.applyConfigUpdate(update)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
      const status = message.startsWith("INVALID_") ? 400 : 500;

      this.logger.error(
        "ENGINE_REQUEST_FAILED",
        "Trading engine request failed",
        { path: url.pathname, message },
        requestId
      );

      return json({ ok: false, error: message, requestId }, status);
    }
  }

  healthCheck(): HealthReport {
    const now = new Date().toISOString();
    this.syncStateMicrostructureFromBook();
    this.engineState = {
      ...this.engineState,
      heartbeatAt: now,
      updatedAt: now
    };
    this.waitUntilStoragePut(ENGINE_STATE_KEY, this.engineState, "HEALTH_HEARTBEAT");

    const memory = (globalThis as RuntimeWithMemory).performance?.memory;

    return {
      ok: this.engineState.mode !== "HALTED",
      engineId: this.engineState.engineId,
      mode: this.engineState.mode,
      heartbeatAt: this.engineState.heartbeatAt,
      uptimeMs: Date.now() - this.startedAt,
      processedTicks: this.engineState.processedTicks,
      acceptedSignals: this.engineState.acceptedSignals,
      internalOrderBookDepth: this.engineState.internalOrderBookDepth,
      averageLatency: this.engineState.averageLatency,
      staleTickCount: this.engineState.staleTickCount,
      toxicityScore: this.engineState.toxicityScore,
      current_inventory_delta: this.engineState.current_inventory_delta,
      location: this.engineState.location,
      microstructure: this.engineState.microstructure,
      quoteState: this.engineState.quoteState,
      executionProfile: this.engineState.executionProfile,
      anomaly: this.engineState.anomaly,
      memoryUsage: {
        available: Boolean(memory),
        usedJSHeapSize: memory?.usedJSHeapSize ?? null,
        totalJSHeapSize: memory?.totalJSHeapSize ?? null,
        jsHeapSizeLimit: memory?.jsHeapSizeLimit ?? null,
        stateBytesEstimate: JSON.stringify({
          mode: this.engineState.mode,
          processedTicks: this.engineState.processedTicks,
          orderMapSize: Object.keys(this.engineState.orderMap).length,
          orderBookDepth: this.engineState.internalOrderBookDepth
        }).length
      }
    };
  }

  private syncStateMicrostructureFromBook(): void {
    const nextState = syncEngineStateMicrostructure({
      engineState: this.engineState,
      orderBook: this.orderBook,
      bids: this.bids,
      asks: this.asks,
      calculatePriceDiscovery: (instrumentCode, observedAt) =>
        this.calculatePriceDiscovery(instrumentCode, observedAt),
      calculateAssetMatrix: (
        observedAt,
        latestInstrumentCode,
        latestOracle,
        profilerStates,
        assetQuoteStates
      ) =>
        this.calculateAssetMatrix(
          observedAt,
          latestInstrumentCode,
          latestOracle,
          profilerStates,
          assetQuoteStates
        ),
      profilerStateSnapshot: () => this.profilerStateSnapshot()
    });

    if (nextState) {
      this.engineState = nextState;
    }
  }

  private engineDiagnostics(): JsonRecord {
    return buildEngineDiagnostics({
      engineState: this.engineState,
      bookSync: this.bookSync,
      profilerAgents: this.profilerRegistry.agents
    });
  }

  private profilerFor(instrumentCode: string): ProfilerAgent {
    return this.profilerRegistry.forInstrument(instrumentCode);
  }

  private hydrateProfilerAgents(
    legacyState: ProfilerState | undefined,
    persistedStates: Map<string, ProfilerState>
  ): void {
    this.profilerRegistry.hydrate(legacyState, persistedStates);
  }

  private resetProfilerAgents(): void {
    this.profilerRegistry.reset();
  }

  private async deleteRetiredProfilerStorage(): Promise<string[]> {
    return this.profilerRegistry.deleteRetiredStorage(this.state.storage, (reason, error) =>
      this.handleStorageWriteFailure(reason, error)
    );
  }

  private configureProfilerAgents(config: GlobalRiskConfig): void {
    this.profilerRegistry.configure(config);
  }

  private profilerStateSnapshot(
    overrideInstrument?: string,
    overrideState?: ProfilerState
  ): Record<string, ProfilerState> {
    return this.profilerRegistry.snapshot(overrideInstrument, overrideState);
  }

  private maxProfilerToxicity(): number {
    return this.profilerRegistry.maxToxicity();
  }

  private findBestAssetBook(instrumentCode: string): InternalOrderBook | undefined {
    return findBestOrderBookForAsset(this.orderBook, instrumentCode);
  }

  private calculateAssetMatrix(
    observedAt: string,
    latestInstrumentCode: string | undefined,
    latestOracle: EngineState["oracle"],
    profilerStates: Record<string, ProfilerState>,
    assetQuoteStates: EngineState["assetQuoteStates"] = this.engineState.assetQuoteStates
  ): Record<string, AssetRuntimeState> {
    const selected = selectedMoltworkerInstruments(this.macroBias);
    const activeWeights: Record<string, number> = {};
    let totalWeight = 0;

    for (const asset of TARGET_ASSET_MATRIX) {
      const oracleState =
        latestOracle.instrumentCode === asset.instrumentCode
          ? latestOracle
          : latestOracle.instrumentStates?.[asset.instrumentCode];
      const volatility = Math.max(0.000001, finiteMetric(oracleState?.volatility ?? 0.01, 0.01));
      const selectedByMoltworker =
        selected.size === 0 ||
        selected.has(asset.instrumentCode) ||
        selected.has(asset.coin.toLowerCase()) ||
        selected.has(`${asset.coin.toLowerCase()}-perp`);
      const book = this.findBestAssetBook(asset.instrumentCode);
      const quoteState = quoteStateForInstrumentState(
        assetQuoteStates,
        asset.instrumentCode,
        this.engineState.quoteState
      );
      const active =
        selectedByMoltworker &&
        Boolean(book?.isSynced) &&
        !isQuoteSuspendedAt(quoteState, observedAt);
      const weight = active ? 1 / volatility : 0;
      activeWeights[asset.instrumentCode] = weight;
      totalWeight += weight;
    }

    const equity = Math.max(this.engineState.bankroll.equity, 0);
    const maxPositionPct =
      this.cachedConfig.MAX_POSITION_PCT > 0
        ? this.cachedConfig.MAX_POSITION_PCT
        : readPositiveNumber(this.env.MAX_POSITION_PCT, DEFAULT_MAX_POSITION_PCT);

    return Object.fromEntries(
      TARGET_ASSET_MATRIX.map((asset) => {
        const book = this.findBestAssetBook(asset.instrumentCode);
        const oracleState =
          latestOracle.instrumentCode === asset.instrumentCode
            ? latestOracle
            : latestOracle.instrumentStates?.[asset.instrumentCode];
        const profilerState =
          profilerStates[asset.instrumentCode] ?? this.profilerFor(asset.instrumentCode).snapshot();
        const allocation = totalWeight > 0 ? activeWeights[asset.instrumentCode] / totalWeight : 0;
        const selectedByMoltworker =
          selected.size === 0 ||
          selected.has(asset.instrumentCode) ||
          selected.has(asset.coin.toLowerCase()) ||
          selected.has(`${asset.coin.toLowerCase()}-perp`);
        const quoteState = quoteStateForInstrumentState(
          assetQuoteStates,
          asset.instrumentCode,
          this.engineState.quoteState
        );
        const quoteSuspended = isQuoteSuspendedAt(quoteState, observedAt);
        const quoteEligible =
          selectedByMoltworker &&
          Boolean(book?.isSynced) &&
          !quoteSuspended &&
          profilerState.toxicityState !== "CRITICAL";

        return [
          asset.instrumentCode,
          {
            instrumentCode: asset.instrumentCode,
            coin: asset.coin,
            selectedByMoltworker,
            active: quoteEligible,
            isSynced: Boolean(book?.isSynced),
            lastSequence: book?.lastSequence ?? null,
            midPrice: book?.midPrice ?? null,
            volatility: finiteMetric(oracleState?.volatility ?? 0.01, 0.01),
            capitalAllocationPct: roundMetric(allocation, 8),
            maxNotional: roundMetric(equity * maxPositionPct * allocation, 8),
            toxicityState: profilerState.toxicityState,
            amVpin: profilerState.amVpinScore,
            obi: profilerState.obi,
            quoteStatus: quoteSuspended ? "SUSPENDED" : "ACTIVE",
            quoteReason: quoteState.reason,
            quoteSuspendedUntil: quoteState.suspendedUntil,
            quoteEligible,
            lastQuoteAt: quoteState.lastQuote?.createdAt ?? quoteState.updatedAt,
            updatedAt: book?.updatedAt ?? observedAt
          } satisfies AssetRuntimeState
        ];
      })
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

  private waitUntilStoragePutEntries(entries: Record<string, unknown>, reason: string): void {
    this.state.waitUntil(this.safeStoragePut(entries, reason));
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
    const now = Date.now();
    const tickCount = this.engineState.processedTicks;
    const dueByTime = now - this.lastHotStorageSnapshotAt >= this.hotStorageSnapshotIntervalMs();
    const dueByTicks =
      tickCount - this.lastHotStorageSnapshotTick >= this.hotStorageSnapshotTickInterval();

    if (!dueByTime && !dueByTicks) {
      return;
    }

    this.lastHotStorageSnapshotAt = now;
    this.lastHotStorageSnapshotTick = tickCount;
    await this.safeStoragePut(entries, reason);
  }

  private hotStorageSnapshotIntervalMs(): number {
    return readPositiveInteger(
      this.env.HOT_STORAGE_SNAPSHOT_INTERVAL_MS,
      DEFAULT_HOT_STORAGE_SNAPSHOT_INTERVAL_MS,
      1_000,
      300_000
    );
  }

  private hotStorageSnapshotTickInterval(): number {
    return readPositiveInteger(
      this.env.HOT_STORAGE_SNAPSHOT_TICK_INTERVAL,
      DEFAULT_HOT_STORAGE_SNAPSHOT_TICK_INTERVAL,
      1,
      100_000
    );
  }

  private handleStorageWriteFailure(reason: string, error: unknown): void {
    this.storageGuard.recordFailure(reason, error);
  }

  private acceptMarketStream(): Response {
    return acceptTradingMarketStream(this.streamContext());
  }

  private acceptTelemetryStream(): Response {
    return acceptTradingTelemetryStream(this.streamContext());
  }

  private streamContext() {
    return {
      adminSockets: this.adminSockets,
      getEngineState: () => this.engineState,
      getSignals: () => this.signals,
      getLatencyHistory: () => this.latencyHistory,
      getMacroBias: () => this.macroBias,
      getTemporaryOverride: () => this.activeTemporaryOverride,
      enqueueTick: (tick: MarketTick) => this.enqueueTick(tick),
      waitUntil: (promise: Promise<unknown>) => this.state.waitUntil(promise),
      publish: (type: string, payload: Record<string, unknown>, correlationId?: string) =>
        this.publish(type, payload, correlationId),
      nextBusSequence: () => this.nextBusSequence()
    };
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
    return handleHyperliquidRawBatch(payload, wakeUpTimeMs, {
      activeIngestConnections: this.activeIngestConnections,
      enqueueRawMessage: (raw, rawPayload, wakeUp) =>
        this.enqueueHyperliquidRawMessage(raw, rawPayload, wakeUp)
    });
  }

  private enqueueHyperliquidRawMessage(
    raw: unknown,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult> {
    const job = this.ingestQueue.then(() =>
      this.handleHyperliquidRawMessage(raw, payload, wakeUpTimeMs)
    );
    this.ingestQueue = job.then(
      () => undefined,
      () => undefined
    );

    return job;
  }

  private async handleHyperliquidRawMessage(
    raw: unknown,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult> {
    if (!isNativeRecord(raw)) {
      throw new Error("INVALID_HYPERLIQUID_RAW_MESSAGE");
    }

    const channel = nativeString(raw.channel)?.toLowerCase();

    if (channel === "subscriptionresponse" || channel === "pong") {
      return { accepted: true, status: "FRESH", processedCount: 0 };
    }

    if (channel === "l2book") {
      return this.handleHyperliquidL2Book(raw, payload, wakeUpTimeMs);
    }

    if (channel === "trades") {
      return this.handleHyperliquidTrades(raw, payload, wakeUpTimeMs);
    }

    if (channel === "activeassetctx" || channel === "alldexsassetctxs") {
      return this.handleHyperliquidAssetContext(raw, payload, wakeUpTimeMs);
    }

    if (
      channel === "userevents" ||
      channel === "usernonfundingledgerupdates" ||
      channel === "events" ||
      channel === "liquidation"
    ) {
      return this.handleHyperliquidLiquidationEvents(raw, payload);
    }

    return {
      accepted: false,
      status: "BOOK_NOT_READY",
      reason: `IGNORED_HYPERLIQUID_CHANNEL_${channel ?? "UNKNOWN"}`,
      processedCount: 0
    };
  }

  private async handleHyperliquidL2Book(
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult> {
    const hotPathStartedAt = highResolutionNow();
    const data = nativeObject(raw.data);

    if (!data) {
      throw new Error("INVALID_HYPERLIQUID_L2BOOK");
    }

    const receivedAt = nativeIso(payload.receivedAt) ?? new Date().toISOString();
    const coin = requireNativeString(data.coin ?? payload.instrumentCode, "coin");
    const instrumentCode = hyperliquidNativeInstrumentCode(coin, payload.instrumentCode);
    const exchangeCode = (payload.exchangeCode ?? "hyperliquid").toLowerCase();
    const sourceExchange = normalizeSourceExchange(payload.source_exchange ?? "hyperliquid");
    const sourceWeight = normalizeSourceWeight(payload.sourceWeight);
    const rawExchangeTimestamp = nativeExchangeTimestamp(data.time ?? data.timestamp);
    const exchangeTimestamp = resolveHyperliquidBookTimestamp(
      rawExchangeTimestamp,
      receivedAt,
      readPositiveNumber(
        this.env.HL_BOOK_TIMESTAMP_MAX_DRIFT_MS,
        DEFAULT_HL_BOOK_TIMESTAMP_MAX_DRIFT_MS
      )
    );
    const explicitSequenceValue = data.sequence ?? data.seq;
    const explicitSequence = Number(explicitSequenceValue);
    const hasExplicitSequence =
      explicitSequenceValue !== undefined &&
      Number.isSafeInteger(explicitSequence) &&
      explicitSequence >= 0;
    const sequence = nativeSequence(
      hasExplicitSequence ? explicitSequenceValue : (data.time ?? data.timestamp)
    );
    const marketKey = buildMarketKey(sourceExchange, instrumentCode);
    const existingSync = this.bookSync.get(marketKey);
    const gapMs = readPositiveNumber(this.env.HL_SEQUENCE_GAP_MS, DEFAULT_HL_SEQUENCE_GAP_MS);
    const [bids, asks] = parseHyperliquidNativeLevels(data.levels, receivedAt);
    const snapshot: OrderBookSnapshot = {
      schemaVersion: "order-book.snapshot.v1",
      source: "HYPERLIQUID",
      source_exchange: sourceExchange,
      exchangeCode,
      instrumentCode,
      marketKey,
      sourceWeight,
      sequence,
      exchangeTimestamp,
      receivedAt,
      bids,
      asks
    };

    if (existingSync?.lastSequence !== null && existingSync?.lastSequence !== undefined) {
      if (sequence <= existingSync.lastSequence) {
        return {
          accepted: false,
          status: "DUPLICATE_OR_OUT_OF_ORDER",
          reason: "DUPLICATE_OR_OUT_OF_ORDER",
          processedCount: 0
        };
      }

      if (hasExplicitSequence && sequence - existingSync.lastSequence > gapMs) {
        existingSync.lastDesyncAt = receivedAt;
        existingSync.desyncReason = "HYPERLIQUID_SEQUENCE_GAP";
        existingSync.isSynced = false;
        this.logger.warn("ORDER_BOOK_DESYNC", "Hyperliquid native book sequence gap detected", {
          instrumentCode,
          exchangeCode,
          source_exchange: sourceExchange,
          previousSequence: existingSync.lastSequence,
          sequence,
          gapMs: sequence - existingSync.lastSequence,
          maxGapMs: gapMs
        });
        return {
          accepted: false,
          status: "DESYNC",
          reason: "HYPERLIQUID_SEQUENCE_GAP",
          processedCount: 0
        };
      }
    }

    const brainTimestamp = new Date().toISOString();
    const totalLatencyMs = Math.max(
      0,
      parseTimestampMs(brainTimestamp, "brain_timestamp") -
        parseTimestampMs(exchangeTimestamp, "exchange_timestamp")
    );
    const nativeMaxLatencyMs = this.resolveNativeHyperliquidMaxLatencyMs(
      payload.transport,
      payload.streamId
    );

    if (totalLatencyMs > nativeMaxLatencyMs) {
      const book =
        bids.length > 0 || asks.length > 0
          ? await this.applySnapshot(snapshot, { telemetry: false, persist: false })
          : undefined;
      if (book) {
        if (isCrossedBook(book)) {
          await this.handleCrossedBookSnapshot(book, sequence, totalLatencyMs, brainTimestamp);
        } else {
          const syncState = this.bookSync.get(marketKey);
          if (syncState) {
            syncState.isSynced = false;
            syncState.desyncReason = "NATIVE_HL_LATENCY";
            syncState.lastDesyncAt = brainTimestamp;
          }
          const staleBook = {
            ...book,
            isSynced: false,
            desyncReason: "NATIVE_HL_LATENCY"
          };
          this.orderBook.set(marketKey, staleBook);
          this.engineState = {
            ...this.engineState,
            microstructure: {
              ...this.engineState.microstructure,
              isSynced: false
            }
          };
        }
      }
      const metrics = nativeHyperliquidLatencyMetrics({
        instrumentCode,
        exchangeCode,
        sourceExchange,
        sourceWeight,
        sequence,
        exchangeTimestamp,
        receivedAt,
        brainTimestamp,
        totalLatencyMs,
        maxLatencyMs: nativeMaxLatencyMs,
        averageLatencyMs: this.engineState.averageLatency,
        sampleCount: this.engineState.latencySampleCount,
        location: this.engineState.location
      });
      this.quoteStateStalePull(instrumentCode, sequence, metrics, brainTimestamp);
      this.observeExecutionProfile(metrics, {
        wakeUpTimeMs,
        orderBookUpdateMs: null,
        agentLogicMs: null,
        hotPathStartedAt,
        observedAt: brainTimestamp
      });
      if (this.cachedConfig.TRADING_ENABLED) {
        this.state.waitUntil(this.cancelAllQuotes(instrumentCode, "NATIVE_HL_LATENCY"));
      }
      this.publishTickTelemetry(
        createNativeHyperliquidBookTick({
          payload,
          coin,
          instrumentCode,
          exchangeCode,
          sourceExchange,
          sourceWeight,
          sequence,
          exchangeTimestamp,
          receivedAt,
          price: 0,
          bestBid: undefined,
          bestAsk: undefined,
          rawEventType: "native-l2Book"
        }),
        metrics,
        "STALE",
        hotPathStartedAt
      );

      return {
        accepted: false,
        status: "STALE",
        reason: "NATIVE_HL_LATENCY_EXCEEDED",
        metrics,
        book,
        processedCount: 0
      };
    }

    const book = await this.applySnapshot(snapshot, { persist: false });

    if (isCrossedBook(book)) {
      await this.handleCrossedBookSnapshot(book, sequence, totalLatencyMs, brainTimestamp);
      return {
        accepted: false,
        status: "DESYNC",
        reason: "CROSSED_BOOK",
        book,
        processedCount: 0
      };
    }

    const representativeTick = createNativeHyperliquidBookTick({
      payload,
      coin,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      sourceWeight,
      sequence,
      exchangeTimestamp,
      receivedAt,
      price: book.midPrice ?? book.bestBid ?? book.bestAsk ?? 0,
      bestBid: book.bestBid ?? undefined,
      bestAsk: book.bestAsk ?? undefined,
      rawEventType: "native-l2Book"
    });
    const result = await this.handleTick(representativeTick, wakeUpTimeMs);

    return {
      ...result,
      book,
      processedCount: 1
    };
  }

  private async handleHyperliquidTrades(
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult> {
    const data = Array.isArray(raw.data) ? raw.data : [];
    let processedCount = 0;
    let terminalResult: TickIngestResult = {
      accepted: true,
      status: "FRESH",
      processedCount: 0
    };

    for (const item of data.slice(0, 100)) {
      if (!isNativeRecord(item)) {
        continue;
      }

      const tick = createNativeHyperliquidTradeTick(item, payload);
      terminalResult = await this.handleTick(tick, wakeUpTimeMs);
      processedCount += 1;

      if (terminalResult.status === "STALE" || terminalResult.status === "DESYNC") {
        break;
      }
    }

    return { ...terminalResult, processedCount };
  }

  private async handleHyperliquidAssetContext(
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult> {
    const data = nativeObject(raw.data) ?? raw;
    const tick = createNativeHyperliquidFundingTick(data, payload);
    const result = await this.handleTick(tick, wakeUpTimeMs);

    return {
      ...result,
      processedCount: 1
    };
  }

  private async handleHyperliquidLiquidationEvents(
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload
  ): Promise<TickIngestResult> {
    const observedAt = nativeIso(payload.receivedAt) ?? new Date().toISOString();
    const instrumentCode =
      payload.instrumentCode?.toLowerCase() ??
      this.engineState.microstructure.instrumentCode ??
      `${(this.env.HL_ASSET ?? "BTC").toLowerCase()}-usd`;
    const previousEventCount = this.engineState.liquidationHeatmap.recentEvents.length;
    const heatmap = this.heatmapAgent.recordLiquidationEvent(raw, {
      instrumentCode,
      sourceExchange: payload.source_exchange ?? "hyperliquid",
      midPrice: this.engineState.microstructure.midPrice,
      observedAt
    });
    const nextEventCount = heatmap.recentEvents.length;
    const cascadeLiquidations = this.cascadeLiquidationStream.ingest(raw, {
      instrumentCode,
      sourceExchange: payload.source_exchange ?? "hyperliquid",
      observedAt,
      fallbackPrice: this.engineState.microstructure.midPrice
    });
    if (cascadeLiquidations.length > 0) {
      this.state.waitUntil(this.persistCascadeLiquidations(cascadeLiquidations));
    }
    const cascadeEvents = this.recordCascadeLiquidations(cascadeLiquidations, observedAt);

    this.engineState = {
      ...this.engineState,
      liquidationHeatmap: heatmap,
      heartbeatAt: observedAt,
      updatedAt: observedAt
    };

    this.state.waitUntil(
      this.safeStoragePut(
        {
          [ENGINE_STATE_KEY]: this.engineState,
          [LIQUIDATION_HEATMAP_STORAGE_KEY]: heatmap
        },
        "LIQUIDATION_EVENT"
      )
    );

    if (nextEventCount > previousEventCount) {
      this.publish("LIQUIDATION_EVENT", {
        instrumentCode,
        clusterCount: heatmap.clusters.length,
        nearestCascade: heatmap.nearestCascade,
        totalEstimatedNotionalUsd: heatmap.totalEstimatedNotionalUsd,
        cascadeEventCount: cascadeEvents.length,
        observedAt
      });
    }

    return {
      accepted: true,
      status: "FRESH",
      processedCount: Math.max(
        nextEventCount > previousEventCount ? 1 : 0,
        cascadeLiquidations.length,
        cascadeEvents.length
      )
    };
  }

  private recordCascadeLiquidations(
    events: LiquidationEvent[],
    observedAt: string
  ): CascadeEvent[] {
    const cascades: CascadeEvent[] = [];
    this.absorptionAnalyzer.configure(this.currentAbsorptionAnalyzerConfig());

    for (const event of events) {
      if (!this.isCascadeInstrumentEnabled(event.instrumentCode)) {
        continue;
      }

      this.cascadeDetector.configure(this.currentCascadeDetectorConfig(event.instrumentCode));
      const cascade = this.cascadeDetector.observe(event, {
        observedAt,
        atr1h: this.resolveCascadeAtr1h(event)
      });

      if (!cascade) {
        continue;
      }

      cascades.push(cascade);
      this.cascadeEventsById.set(cascade.cascadeId, cascade);
      this.absorptionAnalyzer.trackCascade(cascade);
      this.logger.warn("CASCADE_DETECTED", "Liquidation cascade detected", {
        eventType: "CASCADE_DETECTED",
        cascadeId: cascade.cascadeId,
        instrumentCode: cascade.instrumentCode,
        direction: cascade.direction,
        liquidationNotional: cascade.liquidationNotional,
        liquidationCount: cascade.liquidationCount,
        zScore: cascade.zScore,
        directionalPct: cascade.directionalPct,
        priceMoveAtr: cascade.priceMoveAtr
      });
      this.publish("CASCADE_DETECTED", {
        cascadeId: cascade.cascadeId,
        instrumentCode: cascade.instrumentCode,
        direction: cascade.direction,
        liquidationNotional: cascade.liquidationNotional,
        liquidationCount: cascade.liquidationCount,
        zScore: cascade.zScore,
        directionalPct: cascade.directionalPct,
        priceMoveAtr: cascade.priceMoveAtr,
        assetProfile: this.cascadeAssetProfile(cascade.instrumentCode) as unknown as JsonRecord,
        detectedAt: cascade.detectedAt
      });
      this.emitCascadeOperationalAlert(
        "CASCADE_DETECTED",
        "Cascade detected",
        `${cascade.instrumentCode} ${cascade.direction} liquidation cascade detected.`,
        {
          cascadeId: cascade.cascadeId,
          instrumentCode: cascade.instrumentCode,
          direction: cascade.direction,
          liquidationNotional: cascade.liquidationNotional,
          liquidationCount: cascade.liquidationCount,
          zScore: cascade.zScore,
          priceMoveAtr: cascade.priceMoveAtr,
          detectedAt: cascade.detectedAt
        },
        cascade.cascadeId
      );
    }

    return cascades;
  }

  private async persistCascadeLiquidations(events: LiquidationEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    try {
      await this.env.TRADING_DB.batch(
        events.map((event) =>
          this.env.TRADING_DB.prepare(
            `INSERT OR REPLACE INTO cascade_liquidations (
               event_id, instrument_code, source_exchange, side, forced_flow_side, price,
               notional_usd, base_size, exchange_timestamp, observed_at, raw_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            event.eventId,
            event.instrumentCode,
            event.sourceExchange,
            event.side,
            event.forcedFlowSide,
            event.price,
            event.notionalUsd,
            event.baseSize,
            event.exchangeTimestamp,
            event.observedAt,
            JSON.stringify(event.raw)
          )
        )
      );
    } catch (error) {
      this.handleStorageWriteFailure("CASCADE_LIQUIDATION_JOURNAL", error);
    }
  }

  private isCascadeInstrumentEnabled(instrumentCode: string): boolean {
    const enabled = cascadeInstrumentSet(this.cachedConfig.CASCADE_INSTRUMENTS);
    if (enabled.size === 0) {
      return false;
    }

    return enabled.has(baseAssetFromInstrument(instrumentCode));
  }

  private currentCascadeActiveSnapshot(): JsonRecord[] {
    const positionsByCascade = new Map(
      this.cascadePositionManager.snapshot().map((position) => [position.cascadeId, position])
    );
    const maxAgeMs = Math.max(this.cachedConfig.ABSORPTION_WINDOW_MS * 2, 60_000);
    const nowMs = Date.now();

    return [...this.cascadeEventsById.values()]
      .map((cascade) => {
        const absorption = this.cascadeAbsorptionsById.get(cascade.cascadeId) ?? null;
        const position = positionsByCascade.get(cascade.cascadeId) ?? null;
        const phase = position
          ? isOpenCascadePosition(position)
            ? "POSITION_OPEN"
            : "POSITION_CLOSED"
          : absorption
            ? "ABSORPTION_CONFIRMED"
            : "DETECTED";

        return {
          cascadeId: cascade.cascadeId,
          instrumentCode: cascade.instrumentCode,
          direction: cascade.direction,
          phase,
          liquidationNotional: roundMetric(cascade.liquidationNotional, 2),
          liquidationCount: cascade.liquidationCount,
          zScore: roundMetric(cascade.zScore, 4),
          directionalPct: roundMetric(cascade.directionalPct, 4),
          priceMoveAtr: roundMetric(cascade.priceMoveAtr, 4),
          detectedAt: cascade.detectedAt,
          absorption: absorption ? (absorption as unknown as JsonRecord) : null,
          position: position ? (position as unknown as JsonRecord) : null
        };
      })
      .filter((cascade) => {
        if (cascade.phase === "POSITION_OPEN") {
          return true;
        }

        return (
          cascade.phase !== "POSITION_CLOSED" &&
          nowMs - Date.parse(String(cascade.detectedAt)) <= maxAgeMs
        );
      })
      .sort(
        (left, right) => Date.parse(String(right.detectedAt)) - Date.parse(String(left.detectedAt))
      )
      .slice(0, 50);
  }

  private currentCascadeSignalSnapshot(limit: number): JsonRecord[] {
    return this.signals
      .filter((signal) => {
        const context = signal.featureVector as JsonRecord;
        const risk = signal.riskContext as JsonRecord;
        return (
          typeof context.cascadeId === "string" ||
          typeof risk.cascadeId === "string" ||
          signal.rationale.toLowerCase().includes("cascade")
        );
      })
      .slice(-limit)
      .reverse()
      .map((signal) => ({
        signalId: signal.signalId,
        traceId: signal.traceId,
        sourceAgent: signal.sourceAgent,
        targetAgent: signal.targetAgent,
        instrumentCode: signal.instrumentCode,
        action: signal.action,
        confidence: signal.confidence,
        expectedValue: signal.expectedValue,
        maxSlippageBps: signal.maxSlippageBps,
        rationale: signal.rationale,
        outcome: (signal.riskContext as JsonRecord).outcome ?? "EMITTED",
        closeReason: (signal.riskContext as JsonRecord).closeReason ?? null,
        cascadeId:
          (signal.featureVector as JsonRecord).cascadeId ??
          (signal.riskContext as JsonRecord).cascadeId ??
          null,
        createdAt: signal.createdAt,
        featureVector: signal.featureVector,
        riskContext: signal.riskContext
      }));
  }

  private currentCascadePositionSnapshot(): JsonRecord[] {
    const nowMs = Date.now();

    return this.cascadePositionManager
      .snapshot()
      .map((position) => {
        const markPrice = this.markPriceForInstrument(position.instrumentCode);
        const unrealizedPnl =
          markPrice === null
            ? null
            : roundMetric(
                (position.direction === "LONG"
                  ? markPrice - position.entryPrice
                  : position.entryPrice - markPrice) * position.remainingSize,
                8
              );
        const unrealizedR =
          unrealizedPnl === null || position.rDistance <= 0 || position.remainingSize <= 0
            ? null
            : roundMetric(unrealizedPnl / (position.rDistance * position.remainingSize), 6);
        const timeStopMs = Date.parse(position.timeStopAt);

        return {
          ...position,
          targets: position.targets as unknown as JsonRecord,
          markPrice,
          unrealizedPnl,
          unrealizedR,
          timeToTimeStopMs: Number.isFinite(timeStopMs) ? Math.max(0, timeStopMs - nowMs) : null
        };
      })
      .sort(
        (left, right) => Date.parse(String(right.updatedAt)) - Date.parse(String(left.updatedAt))
      );
  }

  private currentCascadeHeatSnapshot(): JsonRecord {
    const positions = this.cascadePositionManager.snapshot();
    const currentHeatPct = this.cascadeHeatManager.currentHeat(positions);
    const heatCapPct = this.cachedConfig.HEAT_CAP_PCT;
    const remainingRiskUsd = positions
      .filter(isOpenCascadePosition)
      .reduce((sum, position) => sum + position.rDistance * position.remainingSize, 0);

    return {
      currentHeatPct: roundMetric(currentHeatPct, 8),
      heatCapPct: roundMetric(heatCapPct, 8),
      percentOfCap: heatCapPct > 0 ? roundMetric(currentHeatPct / heatCapPct, 8) : 0,
      openPositionCount: positions.filter(isOpenCascadePosition).length,
      remainingRiskUsd: roundMetric(remainingRiskUsd, 2),
      updatedAt: new Date().toISOString()
    };
  }

  private async closeCascadePosition(
    positionId: string,
    actor: string,
    reason: string
  ): Promise<{ ok: boolean; error?: string; position?: JsonRecord; intents?: JsonRecord[] }> {
    const position = this.cascadePositionManager
      .snapshot()
      .find((candidate) => candidate.positionId === positionId);

    if (!position || !isOpenCascadePosition(position)) {
      return { ok: false, error: "CASCADE_POSITION_NOT_OPEN" };
    }

    const observedAt = new Date().toISOString();
    const markPrice = this.markPriceForInstrument(position.instrumentCode) ?? position.entryPrice;
    const update = this.cascadePositionManager.requestManualClose(
      positionId,
      observedAt,
      markPrice
    );

    if (!update) {
      return { ok: false, error: "CASCADE_POSITION_NOT_OPEN" };
    }

    for (const intent of update.intents) {
      if (intent.kind === "CLOSE" && intent.size > 0) {
        this.state.waitUntil(
          this.dispatchExecution(this.tradeIntentFromCascadePositionIntent(intent, observedAt))
        );
      }
    }

    this.logger.warn("CASCADE_POSITION_MANUAL_CLOSE", "Operator requested cascade position close", {
      positionId,
      actor,
      reason,
      instrumentCode: position.instrumentCode,
      markPrice,
      remainingSize: position.remainingSize
    });
    this.publish(
      "CASCADE_POSITION_MANUAL_CLOSE",
      {
        positionId,
        actor,
        reason,
        instrumentCode: position.instrumentCode,
        markPrice,
        remainingSize: position.remainingSize,
        observedAt
      },
      positionId
    );
    this.state.waitUntil(
      this.safeStoragePut(
        CASCADE_POSITIONS_KEY,
        this.cascadePositionManager.snapshot(),
        "CASCADE_POSITION_MANUAL_CLOSE"
      )
    );

    return {
      ok: true,
      position: update.position as unknown as JsonRecord,
      intents: update.intents as unknown as JsonRecord[]
    };
  }

  private markPriceForInstrument(instrumentCode: string): number | null {
    const selected = this.selectMarketKey(instrumentCode);
    const book = selected ? this.orderBook.get(selected.marketKey) : undefined;
    const normalized = normalizeInstrumentSelector(instrumentCode);

    return (
      book?.midPrice ??
      this.engineState.assetMatrix[normalized]?.midPrice ??
      (this.engineState.microstructure.instrumentCode === normalized
        ? this.engineState.microstructure.midPrice
        : null)
    );
  }

  private currentCascadeDetectorConfig(instrumentCode: string): CascadeDetectorConfig {
    const profile = this.cascadeAssetProfile(instrumentCode);
    return {
      windowMs: this.cachedConfig.CASCADE_WINDOW_MS,
      notionalThresholdUsd: profile.notionalThresholdUsd,
      zScoreThreshold: profile.zScoreThreshold,
      lookbackHours: this.cachedConfig.CASCADE_LOOKBACK_HOURS,
      directionalPct: this.cachedConfig.CASCADE_DIRECTIONAL_PCT,
      minPriceMoveAtr: profile.minPriceMoveAtr,
      minBaselineWindows: readPositiveInteger(this.env.CASCADE_MIN_BASELINE_WINDOWS, 12, 0, 10_000),
      minCascadeSeparationMs: readPositiveInteger(
        this.env.CASCADE_MIN_SEPARATION_MS,
        this.cachedConfig.CASCADE_WINDOW_MS,
        0,
        6 * 3_600_000
      ),
      maxEventsPerInstrument: readPositiveInteger(
        this.env.CASCADE_MAX_EVENTS_PER_INSTRUMENT,
        10_000,
        100,
        100_000
      )
    };
  }

  private cascadeAssetProfile(instrumentCode: string): CascadeAssetProfile {
    return resolveCascadeAssetProfile(instrumentCode, this.cachedConfig.CASCADE_ASSET_PROFILES, {
      notionalThresholdUsd: this.cachedConfig.CASCADE_NOTIONAL_THRESHOLD_USD,
      zScoreThreshold: this.cachedConfig.CASCADE_ZSCORE_THRESHOLD,
      minPriceMoveAtr: this.cachedConfig.CASCADE_MIN_PRICE_MOVE_ATR,
      maxPositionNotionalPct: this.cachedConfig.MAX_POSITION_NOTIONAL_PCT,
      assetLiquidityCapUsd: this.cachedConfig.ASSET_LIQUIDITY_CAP_USD,
      maxSlippageBps: this.cachedConfig.HEDGE_MAX_SLIPPAGE_BPS
    });
  }

  private currentAbsorptionAnalyzerConfig(): AbsorptionAnalyzerConfig {
    return {
      absorptionWindowMs: this.cachedConfig.ABSORPTION_WINDOW_MS,
      priceBandBps: this.cachedConfig.ABSORPTION_PRICE_BAND_BPS,
      minHoldSeconds: this.cachedConfig.ABSORPTION_MIN_HOLD_SECONDS,
      oiStabilityBps: readPositiveNumber(this.env.ABSORPTION_OI_STABILITY_BPS, 5),
      maxActiveCascades: readPositiveInteger(this.env.ABSORPTION_MAX_ACTIVE_CASCADES, 24, 1, 100)
    };
  }

  private resolveCascadeAtr1h(event: LiquidationEvent): number | null {
    const fallback = readPositiveNumber(this.env.CASCADE_ATR_FALLBACK_USD, 0);
    if (fallback > 0) {
      return fallback;
    }

    const price = event.price > 0 ? event.price : this.engineState.microstructure.midPrice;
    const fallbackPct = readBoundedNumber(this.env.CASCADE_ATR_FALLBACK_PCT, 0, 0, 0.2);
    return price && price > 0 && fallbackPct > 0 ? price * fallbackPct : null;
  }

  private observeCascadeAbsorption(tick: MarketTick): void {
    if (!isTradeTick(tick) || !Number.isFinite(tick.price) || tick.price <= 0) {
      return;
    }

    const instrumentCode = normalizeNativeInstrumentCode(tick.instrumentCode);
    if (!this.isCascadeInstrumentEnabled(instrumentCode)) {
      return;
    }

    const signedNotional =
      tick.side === "buy"
        ? tick.price * tick.size
        : tick.side === "sell"
          ? -tick.price * tick.size
          : 0;
    const cumulativeVolumeDelta =
      (this.cascadeCvdByInstrument.get(instrumentCode) ?? 0) + signedNotional;
    this.cascadeCvdByInstrument.set(instrumentCode, cumulativeVolumeDelta);

    const observation: AbsorptionObservation = {
      instrumentCode,
      observedAt: tick.receivedAt,
      price: tick.price,
      takerBuyVolume: tick.side === "buy" ? Math.max(0, tick.size) : 0,
      takerSellVolume: tick.side === "sell" ? Math.max(0, tick.size) : 0,
      cumulativeVolumeDelta,
      openInterest: typeof tick.openInterest === "number" ? tick.openInterest : null
    };
    this.absorptionAnalyzer.configure(this.currentAbsorptionAnalyzerConfig());
    const confirmed = this.absorptionAnalyzer.observe(observation);

    if (!confirmed) {
      return;
    }

    this.cascadeAbsorptionsById.set(confirmed.cascadeId, confirmed);
    this.logger.info("ABSORPTION_CONFIRMED", "Liquidation cascade absorption confirmed", {
      eventType: "ABSORPTION_CONFIRMED",
      cascadeId: confirmed.cascadeId,
      instrumentCode: confirmed.instrumentCode,
      direction: confirmed.direction,
      elapsedMs: confirmed.elapsedMs,
      price: confirmed.price,
      priceHeld: confirmed.criteria.priceHeld,
      takerExhaustion: confirmed.criteria.takerExhaustion,
      cvdReversal: confirmed.criteria.cvdReversal,
      openInterestStabilized: confirmed.criteria.openInterestStabilized,
      observations: confirmed.observations
    });
    this.publish("ABSORPTION_CONFIRMED", {
      schemaVersion: confirmed.schemaVersion,
      cascadeId: confirmed.cascadeId,
      instrumentCode: confirmed.instrumentCode,
      direction: confirmed.direction,
      confirmedAt: confirmed.confirmedAt,
      elapsedMs: confirmed.elapsedMs,
      price: confirmed.price,
      priceHeld: confirmed.criteria.priceHeld,
      takerExhaustion: confirmed.criteria.takerExhaustion,
      cvdReversal: confirmed.criteria.cvdReversal,
      openInterestStabilized: confirmed.criteria.openInterestStabilized,
      observations: confirmed.observations
    });
    this.emitCascadeOperationalAlert(
      "CASCADE_ABSORPTION_CONFIRMED",
      "Cascade absorption confirmed",
      `${confirmed.instrumentCode} absorption confirmed after ${confirmed.elapsedMs}ms.`,
      {
        cascadeId: confirmed.cascadeId,
        instrumentCode: confirmed.instrumentCode,
        direction: confirmed.direction,
        elapsedMs: confirmed.elapsedMs,
        price: confirmed.price,
        confirmedAt: confirmed.confirmedAt
      },
      confirmed.cascadeId
    );
  }

  private async evaluateCascadeStrategy(tick: MarketTick, observedAt: string): Promise<void> {
    if (
      this.cachedConfig.STRATEGY_MODE === "OFF" ||
      this.cachedConfig.STRATEGY_MODE === "MARKET_MAKING"
    ) {
      return;
    }

    const closedCandles = this.candleAggregator.ingestTick(tick);
    await this.dispatchCascadePositionUpdates(tick, observedAt);

    if (!this.isCascadeInstrumentEnabled(tick.instrumentCode)) {
      return;
    }

    const closed1m = closedCandles.filter(
      (candle) =>
        candle.timeframe === "1m" &&
        candle.instrumentCode.toLowerCase() === tick.instrumentCode.toLowerCase()
    );
    if (closed1m.length === 0) {
      return;
    }

    await this.cascadeNewsCalendar.refresh();
    for (const reclaimCandle of closed1m) {
      const absorption = latestAbsorptionForInstrument(
        this.cascadeAbsorptionsById,
        reclaimCandle.instrumentCode
      );
      if (!absorption) {
        continue;
      }

      const cascade = this.cascadeEventsById.get(absorption.cascadeId);
      if (!cascade) {
        continue;
      }

      const recent1mCandles = this.candleAggregator.snapshot(
        reclaimCandle.instrumentCode,
        "1m",
        64
      );
      const latestRawEvent = cascade.rawEvents.at(-1) ?? null;
      const blackout = this.cascadeNewsCalendar.isWithinBlackout(
        new Date(observedAt),
        baseAssetFromInstrument(reclaimCandle.instrumentCode)
      );
      const signalResult = this.cascadeSignalEngineWithConfig().evaluate({
        cascade,
        absorption,
        reclaimCandle,
        recent1mCandles,
        atr1m: calculateAtr(recent1mCandles, 14),
        atr1h: latestRawEvent ? this.resolveCascadeAtr1h(latestRawEvent) : null,
        preCascadeSwingLow: recentSwingLow(recent1mCandles),
        preCascadeSwingHigh: recentSwingHigh(recent1mCandles),
        cascadeVwap: calculateVwap(recent1mCandles),
        cvd1m: cumulativeVolumeDelta(recent1mCandles),
        openInterestDelta: 0,
        oracleRegime: this.engineState.oracle.regime ?? "UNKNOWN",
        recentSecondCascadeAt: latestCascadeAtForInstrument(this.cascadeEventsById, cascade),
        majorNewsWithinBlackout: blackout.blocked,
        realizedVolPercentile1h: 0.5,
        dailyLossLimitBreached: !this.engineState.riskMetrics.isTradingEnabled,
        weeklyLossLimitBreached: false,
        observedAt
      });

      if (!signalResult.accepted) {
        this.logger.info(
          "CASCADE_SIGNAL_REJECTED",
          "Cascade recovery signal gates rejected entry",
          {
            cascadeId: signalResult.rejection.cascadeId,
            instrumentCode: signalResult.rejection.instrumentCode,
            reasons: signalResult.rejection.reasons.join(",")
          }
        );
        this.recordCascadeUiSignal(
          {
            signalId: `cascade-reject-${signalResult.rejection.cascadeId}-${Date.parse(observedAt)}`,
            traceId: `${this.engineState.engineId}:cascade-reject:${signalResult.rejection.cascadeId}`,
            sourceAgent: "PIT_BOSS",
            targetAgent: "SYSTEM",
            instrumentCode: signalResult.rejection.instrumentCode,
            action: "HOLD",
            confidence: 0,
            horizonMs: this.cachedConfig.ENTRY_WINDOW_SECONDS * 1_000,
            expectedValue: 0,
            maxSlippageBps: 0,
            rationale: `Cascade recovery skipped: ${signalResult.rejection.reasons.join(", ")}`,
            featureVector: signalResult.rejection.context,
            riskContext: {
              outcome: "SKIPPED",
              cascadeId: signalResult.rejection.cascadeId,
              reasons: signalResult.rejection.reasons
            },
            createdAt: observedAt
          },
          "SKIPPED"
        );
        continue;
      }

      await this.processCascadeSignal(signalResult.signal, observedAt);
    }
  }

  private async dispatchCascadePositionUpdates(
    tick: MarketTick,
    observedAt: string
  ): Promise<void> {
    const updates = this.cascadePositionManager.onTick({
      instrumentCode: tick.instrumentCode,
      price: tick.price,
      observedAt,
      atr: calculateAtr(this.candleAggregator.snapshot(tick.instrumentCode, "1m", 32), 14)
    });

    for (const update of updates) {
      for (const intent of update.intents) {
        if (intent.kind !== "CLOSE" || intent.size <= 0) {
          continue;
        }
        const tradeIntent = this.tradeIntentFromCascadePositionIntent(intent, observedAt);
        this.state.waitUntil(this.dispatchExecution(tradeIntent));
        if (intent.closeReason === "STOP_LOSS" || intent.closeReason === "TIME_STOP") {
          this.emitCascadeOperationalAlert(
            intent.closeReason === "STOP_LOSS" ? "STOP_HIT" : "TIME_STOP_HIT",
            intent.closeReason === "STOP_LOSS" ? "Cascade stop hit" : "Cascade time stop hit",
            `${intent.instrumentCode} cascade position ${intent.positionId} triggered ${intent.closeReason}.`,
            {
              positionId: intent.positionId,
              signalId: intent.signalId,
              instrumentCode: intent.instrumentCode,
              closeReason: intent.closeReason,
              size: intent.size,
              referencePrice: intent.referencePrice,
              observedAt
            },
            intent.positionId
          );
        }
      }
    }

    if (updates.length > 0) {
      this.state.waitUntil(
        this.safeStoragePut(
          CASCADE_POSITIONS_KEY,
          this.cascadePositionManager.snapshot(),
          "CASCADE_POSITION_UPDATE"
        )
      );
    }
  }

  private async processCascadeSignal(
    signal: CascadeRecoverySignal,
    observedAt: string
  ): Promise<void> {
    const assetProfile = this.cascadeAssetProfile(signal.instrumentCode);
    const currentHeat = this.cascadeHeatManager.currentHeat(this.cascadePositionManager.snapshot());
    this.emitCascadeOperationalAlert(
      "SIGNAL_EMITTED",
      "Cascade signal emitted",
      `${signal.instrumentCode} ${signal.direction} cascade recovery signal emitted.`,
      {
        signalId: signal.signalId,
        cascadeId: signal.cascadeId,
        instrumentCode: signal.instrumentCode,
        direction: signal.direction,
        triggerType: signal.triggerType,
        confidence: signal.confidence,
        emittedAt: signal.emittedAt
      },
      signal.signalId
    );
    const sizeDecision = calculatePositionSize({
      equity: this.engineState.bankroll.equity,
      riskPerTradePct: this.cachedConfig.RISK_PER_TRADE_PCT,
      entryPrice: signal.entryPrice,
      stopPrice: signal.stopPrice,
      maxPositionNotionalPct: assetProfile.maxPositionNotionalPct,
      assetLiquidityCap: assetProfile.assetLiquidityCapUsd,
      currentHeat,
      heatCapPct: this.cachedConfig.HEAT_CAP_PCT
    });

    if (!sizeDecision.approved) {
      this.logger.warn("CASCADE_SIZE_REJECTED", "Cascade recovery position sizing rejected entry", {
        signalId: signal.signalId,
        instrumentCode: signal.instrumentCode,
        limitingFactor: sizeDecision.limitingFactor,
        reason: sizeDecision.reason
      });
      if (sizeDecision.limitingFactor === "HEAT") {
        this.emitCascadeOperationalAlert(
          "HEAT_CAP_EXCEEDED",
          "Cascade heat cap blocked entry",
          `${signal.instrumentCode} cascade entry was rejected by the heat cap.`,
          {
            signalId: signal.signalId,
            cascadeId: signal.cascadeId,
            instrumentCode: signal.instrumentCode,
            currentHeat,
            heatAfterPct: sizeDecision.heatAfterPct,
            heatCapPct: this.cachedConfig.HEAT_CAP_PCT,
            reason: sizeDecision.reason
          },
          signal.signalId
        );
      }
      return;
    }

    const position = this.cascadePositionManager.registerFromSignal(
      signal,
      sizeDecision,
      observedAt
    );
    const intent = this.tradeIntentFromCascadeSignal(signal, sizeDecision.units, observedAt);
    this.recordCascadeUiSignal(
      {
        signalId: signal.signalId,
        traceId: `${this.engineState.engineId}:cascade:${signal.signalId}`,
        sourceAgent: "PIT_BOSS",
        targetAgent: "EXECUTIONER",
        instrumentCode: signal.instrumentCode,
        action: intent.action,
        confidence: signal.confidence,
        horizonMs: Math.max(0, Date.parse(signal.timeStopAt) - Date.parse(observedAt)),
        expectedValue: intent.expectedValue,
        maxSlippageBps: intent.maxSlippageBps,
        rationale: `Cascade recovery entry approved via ${signal.triggerType}`,
        featureVector: signal.context,
        riskContext: {
          outcome: "TAKEN",
          cascadeId: signal.cascadeId,
          positionId: position.positionId,
          assetProfile: assetProfile as unknown as JsonRecord,
          sizeDecision: sizeDecision as unknown as JsonRecord
        },
        createdAt: observedAt
      },
      "TAKEN"
    );
    this.logger.traceDecision({
      decisionId: `cascade-entry-${signal.signalId}`,
      signalId: signal.signalId,
      traceId: `${this.engineState.engineId}:cascade:${signal.signalId}`,
      agentName: "PIT_BOSS",
      targetAgent: "EXECUTIONER",
      instrumentCode: signal.instrumentCode,
      action: intent.action,
      confidence: signal.confidence,
      expectedValue: intent.expectedValue,
      maxSlippageBps: intent.maxSlippageBps,
      reasoning: `Cascade recovery entry approved. Heat ${currentHeat} -> ${sizeDecision.heatAfterPct}.`,
      featureVector: signal.context,
      riskSnapshot: {
        positionId: position.positionId,
        assetProfile: assetProfile as unknown as JsonRecord,
        sizeDecision: sizeDecision as unknown as JsonRecord
      },
      rawSignal: signal as unknown as JsonRecord,
      latencyMs: 0,
      createdAt: observedAt
    });
    this.state.waitUntil(this.dispatchExecution(intent));
    this.state.waitUntil(
      this.safeStoragePut(
        CASCADE_POSITIONS_KEY,
        this.cascadePositionManager.snapshot(),
        "CASCADE_POSITION_OPENED"
      )
    );
    this.emitCascadeOperationalAlert(
      "POSITION_OPENED",
      "Cascade position opened",
      `${position.instrumentCode} ${position.direction} cascade position opened.`,
      {
        signalId: signal.signalId,
        cascadeId: signal.cascadeId,
        positionId: position.positionId,
        instrumentCode: position.instrumentCode,
        direction: position.direction,
        entryPrice: position.entryPrice,
        stopPrice: position.currentStopPrice,
        notionalUsd: sizeDecision.notionalUsd,
        riskPct: sizeDecision.riskPct,
        heatAfterPct: sizeDecision.heatAfterPct,
        observedAt
      },
      position.positionId
    );
  }

  private cascadeSignalEngineWithConfig(): CascadeRecoverySignalEngine {
    const config: CascadeRecoverySignalConfig = {
      ...defaultCascadeRecoverySignalConfig,
      entryWindowSeconds: this.cachedConfig.ENTRY_WINDOW_SECONDS,
      impulsiveBarBodyAtr: this.cachedConfig.IMPULSIVE_BAR_BODY_ATR,
      impulsiveBarVolumeMult: this.cachedConfig.IMPULSIVE_BAR_VOLUME_MULT,
      stopBufferAtr: this.cachedConfig.STOP_BUFFER_ATR,
      minStopDistanceBps: this.cachedConfig.MIN_STOP_DISTANCE_BPS,
      maxStopDistanceBps: this.cachedConfig.MAX_STOP_DISTANCE_BPS,
      minTimeSinceLastCascadeSeconds: this.cachedConfig.MIN_TIME_SINCE_LAST_CASCADE_SECONDS,
      newsBlackoutMinutes: this.cachedConfig.NEWS_BLACKOUT_MINUTES,
      maxRealizedVolPercentile: this.cachedConfig.MAX_REALIZED_VOL_PERCENTILE,
      timeStopHours: this.cachedConfig.CASCADE_TIME_STOP_HOURS,
      partial1R: this.cachedConfig.PARTIAL_1_R,
      partial1SizePct: this.cachedConfig.PARTIAL_1_SIZE_PCT,
      partial2R: this.cachedConfig.PARTIAL_2_R,
      partial2SizePct: this.cachedConfig.PARTIAL_2_SIZE_PCT,
      runnerTrailingType: this.cachedConfig.TRAILING_STOP_TYPE,
      runnerTrailingParam: this.cachedConfig.TRAILING_STOP_PARAM
    };
    return new CascadeRecoverySignalEngine(config);
  }

  private tradeIntentFromCascadeSignal(
    signal: CascadeRecoverySignal,
    size: number,
    observedAt: string
  ): TradeIntent {
    const action = signal.direction === "LONG" ? "BUY" : "SELL";
    const notional = size * signal.entryPrice;
    const executionStyle =
      notional > this.cachedConfig.SLICE_NOTIONAL_THRESHOLD_USD ? "SLICED_TWAP" : "TAKER_IOC";

    return {
      schemaVersion: "trade-intent.v1",
      intentId: `cascade-entry-${signal.signalId}`,
      traceId: `${this.engineState.engineId}:cascade-entry:${signal.signalId}`,
      instrumentCode: signal.instrumentCode,
      marketKey: `hyperliquid:${signal.instrumentCode}`,
      source_exchange: "hyperliquid",
      direction: signal.direction,
      executionStyle,
      action,
      orderType: "IOC",
      postOnly: false,
      timeInForce: "IOC",
      intendedPrice: signal.entryPrice,
      expectedPrice: signal.entryPrice,
      requestedSize: size,
      approvedSize: size,
      probabilityWin: signal.confidence,
      probabilityLoss: Math.max(0, 1 - signal.confidence),
      profit: signal.rDistance * 2,
      loss: signal.rDistance,
      executionCosts: this.cachedConfig.EXCHANGE_FEE_BPS / 10_000,
      adverseSelectionCost: 0,
      expectedValue:
        signal.confidence * signal.rDistance * 2 - (1 - signal.confidence) * signal.rDistance,
      minEvThreshold: 0,
      maxSlippageBps: this.cascadeAssetProfile(signal.instrumentCode).maxSlippageBps,
      confidence: signal.confidence,
      rationale: `cascade recovery ${signal.triggerType} ${signal.cascadeId}`,
      createdAt: observedAt
    };
  }

  private tradeIntentFromCascadePositionIntent(
    intent: CascadePositionIntent,
    observedAt: string
  ): TradeIntent {
    const isStop = intent.executionStyle === "TAKER_MARKET";
    return {
      schemaVersion: "trade-intent.v1",
      intentId: `cascade-exit-${intent.intentId}`,
      traceId: `${this.engineState.engineId}:cascade-exit:${intent.positionId}`,
      instrumentCode: intent.instrumentCode,
      marketKey: `hyperliquid:${intent.instrumentCode}`,
      source_exchange: "hyperliquid",
      direction: intent.action === "BUY" ? "LONG" : "SHORT",
      executionStyle: intent.executionStyle,
      action: intent.action,
      orderType: isStop ? "MARKET" : "IOC",
      postOnly: false,
      timeInForce: "IOC",
      intendedPrice: intent.referencePrice,
      expectedPrice: intent.referencePrice,
      requestedSize: intent.size,
      approvedSize: intent.size,
      probabilityWin: 1,
      probabilityLoss: 0,
      profit: 0,
      loss: 0,
      executionCosts: this.cachedConfig.EXCHANGE_FEE_BPS / 10_000,
      adverseSelectionCost: 0,
      expectedValue: 0,
      minEvThreshold: 0,
      maxSlippageBps: this.cascadeAssetProfile(intent.instrumentCode).maxSlippageBps,
      confidence: 1,
      rationale: `cascade ${intent.closeReason ?? "close"} ${isStop ? "stop_loss" : "partial"} reduce-only`,
      createdAt: observedAt
    };
  }

  private async handleGrpcFatalDrop(
    payload: GrpcFatalDropPayload
  ): Promise<{ status: "GRPC_FATAL_DROP" }> {
    const observedAt = nativeIso(payload.observedAt) ?? new Date().toISOString();
    const disconnectedForMs = nativeNumber(payload.disconnectedForMs) ?? 0;
    const thresholdMs = nativeNumber(payload.thresholdMs) ?? 200;
    const reason = nativeString(payload.reason) ?? "GRPC_FATAL_DROP";
    const citadel = evaluateGrpcDrop({
      disconnectedForMs,
      thresholdMs,
      reason,
      observedAt
    });
    const assetQuoteStates = suspendAssetQuoteStates(
      this.engineState.assetQuoteStates,
      "GRPC_FATAL_DROP",
      observedAt,
      { lastQuote: this.engineState.quoteState.lastQuote }
    );

    this.engineState = {
      ...this.engineState,
      agentHealth: touchAgentHealth(
        this.engineState.agentHealth,
        "EXECUTIONER",
        citadel.status === "CRITICAL" ? "RED" : "YELLOW",
        observedAt,
        0,
        reason
      ),
      quoteState: aggregateQuoteState(assetQuoteStates, this.engineState.quoteState, observedAt),
      assetQuoteStates,
      executionProfile: {
        ...this.engineState.executionProfile,
        status: "UNSTABLE",
        updatedAt: observedAt
      },
      citadel: {
        status: citadel.status,
        reason,
        shadowMode: isShadowMode(this.env),
        lastEvacuationAt: citadel.shouldEvacuate
          ? observedAt
          : this.engineState.citadel.lastEvacuationAt,
        updatedAt: observedAt
      },
      heartbeatAt: observedAt,
      updatedAt: observedAt
    };
    this.state.waitUntil(
      this.persistHotStorageSnapshot(
        {
          [ENGINE_STATE_KEY]: this.engineState
        },
        "GRPC_FATAL_DROP"
      )
    );
    this.logger.error("GRPC_FATAL_DROP", "Dwellir gRPC blackout forced quote evacuation", {
      streamId: payload.streamId ?? null,
      source: payload.source ?? "DWELLIR_GRPC",
      source_exchange: payload.source_exchange ?? "hyperliquid",
      connectionId: payload.connectionId ?? null,
      reason,
      disconnectedForMs,
      thresholdMs,
      observedAt,
      citadelStatus: citadel.status,
      evacuationAction: citadel.evacuationSignal.action
    });
    this.publish("GRPC_FATAL_DROP", {
      streamId: payload.streamId ?? null,
      source_exchange: payload.source_exchange ?? "hyperliquid",
      reason,
      disconnectedForMs,
      thresholdMs,
      action: citadel.evacuationSignal.action,
      citadelStatus: citadel.status,
      observedAt
    });
    if (citadel.shouldEvacuate) {
      this.state.waitUntil(this.cancelAllQuotes("ALL", "GRPC_FATAL_DROP"));
    }

    return { status: "GRPC_FATAL_DROP" };
  }

  private quoteStateStalePull(
    instrumentCode: string,
    sequence: number,
    metrics: LatencyMetrics,
    observedAt: string
  ): void {
    this.updateLatencyAverage(metrics.totalLatencyMs);
    this.applyLocationLatency(metrics.totalLatencyMs, observedAt);
    metrics.averageLatencyMs = this.engineState.averageLatency;
    metrics.sampleCount = this.engineState.latencySampleCount;
    metrics.latencyRiskMultiplier = this.engineState.location.latencyRiskMultiplier;
    metrics.positionSizeMultiplier = this.engineState.location.positionSizeMultiplier;
    this.latencyHistory = [...this.latencyHistory, metrics].slice(-PERFORMANCE_HISTORY_LIMIT);
    const assetQuoteStates = suspendAssetQuoteStates(
      this.engineState.assetQuoteStates,
      "NATIVE_HL_LATENCY",
      observedAt,
      { instrumentCode, lastQuote: this.engineState.quoteState.lastQuote }
    );
    this.engineState = {
      ...this.engineState,
      processedTicks: this.engineState.processedTicks + 1,
      staleTickCount: this.engineState.staleTickCount + 1,
      quoteState: aggregateQuoteState(assetQuoteStates, this.engineState.quoteState, observedAt),
      assetQuoteStates,
      heartbeatAt: observedAt,
      updatedAt: observedAt
    };
    this.state.waitUntil(
      this.persistHotStorageSnapshot(
        {
          [ENGINE_STATE_KEY]: this.engineState,
          [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
          [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples
        },
        "NATIVE_HL_LATENCY_PULL"
      )
    );
    this.logPerformance(metrics);
    this.publish("STALE_DATA_KILL_SWITCH", {
      instrumentCode,
      exchangeCode: "hyperliquid",
      source_exchange: "hyperliquid",
      sequence,
      totalLatencyMs: metrics.totalLatencyMs,
      maxLatencyMs: metrics.maxLatencyMs,
      action: "PULL_CURRENT_QUOTES",
      source: "NATIVE_HYPERLIQUID"
    });
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
    const observedAt = new Date().toISOString();
    const sourceExchange = normalizeSourceExchange(payload.source_exchange ?? "hyperliquid");
    const streamId =
      typeof payload.streamId === "string" && payload.streamId.length > 0 ? payload.streamId : null;
    const connectionId =
      typeof payload.connectionId === "string" && payload.connectionId.length > 0
        ? payload.connectionId
        : null;

    if (!connectionId) {
      return {
        registered: false,
        reason: "MISSING_CONNECTION_ID",
        source_exchange: sourceExchange,
        streamId,
        observedAt
      };
    }

    this.activeIngestConnections.set(
      hyperliquidIngestConnectionKey(sourceExchange, streamId),
      connectionId
    );

    if (!streamId) {
      this.activeIngestConnections.set(
        hyperliquidIngestConnectionKey(sourceExchange, null),
        connectionId
      );
    }

    this.engineState = {
      ...this.engineState,
      heartbeatAt: observedAt,
      updatedAt: observedAt
    };
    this.waitUntilStoragePut(ENGINE_STATE_KEY, this.engineState, "INGEST_CONNECTION_REGISTERED");

    return {
      registered: true,
      source_exchange: sourceExchange,
      streamId,
      connectionId,
      reason: payload.reason ?? "INGEST_CONNECTION_REGISTERED",
      observedAt
    };
  }

  private async resetOrderBook(payload: Partial<OrderBookResetRequest>): Promise<void> {
    const now = new Date().toISOString();
    const reason =
      typeof payload.reason === "string" && payload.reason.length > 0
        ? payload.reason
        : "UNSPECIFIED_RESET";
    const source = payload.source ?? "SYSTEM";
    const blackoutDurationMs =
      typeof payload.blackoutDurationMs === "number" && Number.isFinite(payload.blackoutDurationMs)
        ? Math.max(0, Math.round(payload.blackoutDurationMs))
        : null;
    const resetInstrument = payload.instrumentCode?.toLowerCase() ?? null;
    const resetSourceExchange = payload.source_exchange
      ? normalizeSourceExchange(payload.source_exchange)
      : null;
    const resetStreamId =
      typeof payload.streamId === "string" && payload.streamId.length > 0 ? payload.streamId : null;
    const resetMarketKey =
      resetInstrument && resetSourceExchange
        ? buildMarketKey(resetSourceExchange, resetInstrument)
        : null;
    let persistedBooks = new Map<string, InternalOrderBook>();
    try {
      persistedBooks = await this.state.storage.list<InternalOrderBook>({
        prefix: ORDER_BOOK_PREFIX
      });
    } catch (error) {
      this.handleStorageWriteFailure("ORDER_BOOK_RESET_LIST", error);
    }
    const deleteKeys = resetMarketKey
      ? [`${ORDER_BOOK_PREFIX}${resetMarketKey}`].filter((key) => persistedBooks.has(key))
      : [...persistedBooks.keys()];

    if (resetMarketKey) {
      this.orderBook.delete(resetMarketKey);
      this.bids.delete(resetMarketKey);
      this.asks.delete(resetMarketKey);
      this.bookSync.delete(resetMarketKey);
    } else {
      this.orderBook.clear();
      this.bids.clear();
      this.asks.clear();
      this.bookSync.clear();
    }

    const nextMicrostructure =
      resetMarketKey &&
      this.engineState.microstructure.marketKey !== resetMarketKey &&
      this.orderBook.size > 0
        ? this.engineState.microstructure
        : defaultMicrostructure();
    this.engineState = {
      ...this.engineState,
      internalOrderBookDepth: countBookLevels(this.bids, this.asks),
      microstructure: nextMicrostructure,
      priceDiscovery: resetInstrument
        ? this.calculatePriceDiscovery(resetInstrument, now)
        : defaultPriceDiscovery(),
      dom: null,
      heartbeatAt: now,
      updatedAt: now
    };

    if (source === "INGEST_WORKER") {
      this.resetLatencyBaseline(now, `ORDER_BOOK_RESET:${reason}`);
      if (payload.connectionId) {
        this.activeIngestConnections.set(
          hyperliquidIngestConnectionKey(resetSourceExchange, resetStreamId),
          payload.connectionId
        );
        if (!resetStreamId) {
          this.activeIngestConnections.set(
            hyperliquidIngestConnectionKey(resetSourceExchange, null),
            payload.connectionId
          );
        }
      }
    }

    const writes: Record<string, unknown> = {
      [ENGINE_STATE_KEY]: this.engineState
    };

    await Promise.all([
      this.safeStoragePut(writes, "ORDER_BOOK_RESET"),
      this.safeStorageDelete(deleteKeys, "ORDER_BOOK_RESET_DELETE")
    ]);

    this.logger.warn("ORDER_BOOK_RESET", "Internal order book purged after stream recovery", {
      reason,
      source,
      streamId: resetStreamId,
      instrumentCode: resetInstrument,
      source_exchange: resetSourceExchange,
      marketKey: resetMarketKey,
      connectionId: payload.connectionId ?? null,
      blackoutDurationMs,
      recoveredAt: payload.recoveredAt ?? now,
      deletedBookSnapshots: deleteKeys.length
    });

    this.publish("ORDER_BOOK_RESET", {
      reason,
      source,
      streamId: resetStreamId,
      instrumentCode: resetInstrument,
      source_exchange: resetSourceExchange,
      marketKey: resetMarketKey,
      connectionId: payload.connectionId ?? null,
      blackoutDurationMs,
      recoveredAt: payload.recoveredAt ?? now,
      deletedBookSnapshots: deleteKeys.length
    });
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
    const observedAt = new Date().toISOString();
    const reason =
      typeof payload.reason === "string" && payload.reason.length > 0
        ? payload.reason
        : "ADMIN_CONTROLLED_RECOVERY";
    const sourceExchange = payload.source_exchange
      ? normalizeSourceExchange(payload.source_exchange)
      : "hyperliquid";
    const resetInstruments = maintenanceRecoveryInstruments(payload);

    for (const instrumentCode of resetInstruments) {
      await this.resetOrderBook({
        source: "ADMIN",
        reason,
        instrumentCode,
        source_exchange: sourceExchange,
        connectionId: null,
        blackoutDurationMs: null,
        recoveredAt: observedAt
      });
    }

    if (payload.clearLatency !== false) {
      this.resetLatencyBaseline(observedAt, reason);
    }

    const shouldClearShadowQueue = payload.clearShadowQueue !== false;
    if (shouldClearShadowQueue) {
      this.ghostBook.reset();
      this.shadowQueueNoEdgeLogAt.clear();
    }

    const prunedProfilerStorageKeys = await this.deleteRetiredProfilerStorage();
    const nextAssetQuoteStates =
      payload.clearQuoteState === false
        ? this.engineState.assetQuoteStates
        : defaultAssetQuoteStates(this.cachedConfig, this.macroBias, observedAt);
    const nextQuoteState =
      payload.clearQuoteState === false
        ? this.engineState.quoteState
        : aggregateQuoteState(nextAssetQuoteStates, this.engineState.quoteState, observedAt);
    const nextCitadel =
      payload.clearCitadel === false
        ? this.engineState.citadel
        : {
            ...defaultCitadelState(observedAt),
            shadowMode: isShadowMode(this.env)
          };
    const riskTradingEnabled =
      this.cachedConfig.TRADING_ENABLED &&
      (payload.resetPaperPortfolio ||
        this.engineState.riskMetrics.rollingDrawdownPct <= this.cachedConfig.MAX_DRAWDOWN_PCT);
    const paperBankroll = readPositiveNumber(
      this.env.PAPER_BANKROLL_USD,
      DEFAULT_PAPER_BANKROLL_USD
    );
    const nextBankroll = payload.resetPaperPortfolio
      ? {
          ...this.engineState.bankroll,
          cash: paperBankroll,
          equity: paperBankroll,
          realizedPnl: 0,
          updatedAt: observedAt
        }
      : this.engineState.bankroll;
    const nextOpenPositions = payload.resetPaperPortfolio ? {} : this.engineState.openPositions;
    const nextInventory = payload.resetPaperPortfolio
      ? {
          ...defaultInventoryState(
            this.cachedConfig.MAX_INVENTORY_UNITS,
            this.cachedConfig.MAX_INVENTORY_DELTA
          ),
          updatedAt: observedAt
        }
      : this.engineState.inventory;
    const nextRiskMetrics = {
      ...(payload.resetPaperPortfolio
        ? defaultRiskMetrics(nextBankroll.equity, observedAt)
        : this.engineState.riskMetrics),
      isTradingEnabled: riskTradingEnabled,
      updatedAt: observedAt
    };
    const nextRisk = {
      ...this.engineState.risk,
      killSwitch: !riskTradingEnabled,
      maxDrawdownPct: this.cachedConfig.MAX_DRAWDOWN_PCT,
      updatedAt: observedAt
    };

    this.engineState = {
      ...this.engineState,
      bankroll: nextBankroll,
      openPositions: nextOpenPositions,
      inventory: nextInventory,
      current_inventory_delta: nextInventory.current_inventory_delta,
      staleTickCount: 0,
      quoteState: nextQuoteState,
      assetQuoteStates: nextAssetQuoteStates,
      shadowQueue: this.ghostBook.snapshot(observedAt),
      citadel: nextCitadel,
      riskMetrics: nextRiskMetrics,
      risk: nextRisk,
      executionProfile: {
        ...this.engineState.executionProfile,
        status: "STABLE",
        updatedAt: observedAt
      },
      heartbeatAt: observedAt,
      updatedAt: observedAt
    };

    await this.safeStoragePut(
      {
        [ENGINE_STATE_KEY]: this.engineState,
        [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
        [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples
      },
      "ADMIN_CONTROLLED_RECOVERY"
    );

    if (payload.resetPaperPortfolio) {
      this.state.waitUntil(this.env.CONFIG_STORE.put(PAPER_SESSION_STARTED_AT_KEY, observedAt));
    }

    this.logger.warn("ADMIN_CONTROLLED_RECOVERY", "Admin controlled recovery applied", {
      reason,
      resetInstruments,
      source_exchange: sourceExchange,
      clearCitadel: payload.clearCitadel !== false,
      clearQuoteState: payload.clearQuoteState !== false,
      clearLatency: payload.clearLatency !== false,
      resetPaperPortfolio: payload.resetPaperPortfolio === true,
      clearShadowQueue: shouldClearShadowQueue,
      prunedProfilerStorageKeys,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      observedAt
    });
    this.publish("ADMIN_CONTROLLED_RECOVERY", {
      reason,
      resetInstruments,
      source_exchange: sourceExchange,
      clearCitadel: payload.clearCitadel !== false,
      clearQuoteState: payload.clearQuoteState !== false,
      clearLatency: payload.clearLatency !== false,
      resetPaperPortfolio: payload.resetPaperPortfolio === true,
      clearShadowQueue: shouldClearShadowQueue,
      prunedProfilerStorageKeyCount: prunedProfilerStorageKeys.length,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      observedAt
    });

    return {
      ok: true,
      reason,
      resetInstruments,
      source_exchange: sourceExchange,
      state: this.engineState as unknown as JsonValue
    };
  }

  private async applySnapshot(
    snapshot: OrderBookSnapshot,
    options: { telemetry?: boolean; persist?: boolean } = {}
  ): Promise<InternalOrderBook> {
    const updatedAt = new Date().toISOString();
    const applied = this.orderBookReconstructor.applySnapshot(snapshot, updatedAt);
    const book = applied.book;
    const domSnapshot = this.getLiquidityWalls(applied.instrumentCode, updatedAt);

    this.engineState = {
      ...this.engineState,
      internalOrderBookDepth: countBookLevels(this.bids, this.asks),
      microstructure: microstructureFromBook(book),
      priceDiscovery: this.calculatePriceDiscovery(applied.instrumentCode, updatedAt),
      dom: domSnapshot,
      heartbeatAt: updatedAt,
      updatedAt
    };

    if (options.persist !== false) {
      await this.safeStoragePut(
        {
          [ENGINE_STATE_KEY]: this.engineState,
          [DOM_WALL_HISTORY_KEY]: this.domWallHistory,
          [`${ORDER_BOOK_PREFIX}${applied.marketKey}`]: book
        },
        "ORDER_BOOK_SNAPSHOT_APPLIED"
      );
    }

    const shouldEmitTelemetry =
      options.telemetry !== false &&
      (snapshot.source === "ADMIN" ||
        this.engineState.processedTicks <= 5 ||
        this.engineState.processedTicks % AGENT_SNAPSHOT_TICK_INTERVAL === 0);

    if (shouldEmitTelemetry) {
      this.logger.info("ORDER_BOOK_SNAPSHOT_APPLIED", "Full order book snapshot applied", {
        instrumentCode: applied.instrumentCode,
        exchangeCode: applied.exchangeCode,
        sequence: applied.sequence,
        bidLevels: applied.bidLevels,
        askLevels: applied.askLevels,
        tickSize: applied.tickSize,
        timeToBookMs: applied.timeToBookMs
      });
      this.publish("ORDER_BOOK_SNAPSHOT_APPLIED", {
        instrumentCode: applied.instrumentCode,
        exchangeCode: applied.exchangeCode,
        sequence: applied.sequence,
        bidLevels: applied.bidLevels,
        askLevels: applied.askLevels,
        tickSize: applied.tickSize,
        timeToBookMs: applied.timeToBookMs
      });
    }

    return book;
  }

  private async applyDelta(
    delta: BookDeltaWithTicker,
    updatedAt: string
  ): Promise<AppliedBookUpdate> {
    const applied = await this.orderBookReconstructor.applyDelta(delta, updatedAt);

    if (applied.accepted && applied.book) {
      this.engineState = {
        ...this.engineState,
        microstructure: microstructureFromBook(applied.book),
        priceDiscovery: this.calculatePriceDiscovery(applied.book.instrumentCode, updatedAt)
      };
    }

    return applied;
  }

  private async handleCrossedBookSnapshot(
    book: InternalOrderBook,
    sequence: number,
    timeToBookMs: number | null,
    observedAt: string
  ): Promise<void> {
    await this.orderBookReconstructor.handleCrossedBookSnapshot(
      book,
      sequence,
      timeToBookMs,
      observedAt
    );
  }

  private rebuildBookSnapshot(
    marketKey: string,
    instrumentCode: string,
    exchangeCode: string,
    sourceExchange: string,
    source: MarketDataSource,
    sourceWeight: number,
    sequence: number,
    updatedAt: string,
    timeToBookMs: number | null
  ): InternalOrderBook {
    const { book, microstructure } = this.orderBookReconstructor.rebuildBookSnapshot(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      source,
      sourceWeight,
      sequence,
      updatedAt,
      timeToBookMs
    );
    this.engineState = {
      ...this.engineState,
      microstructure,
      priceDiscovery: this.calculatePriceDiscovery(instrumentCode, updatedAt)
    };

    return book;
  }

  private selectMarketKey(
    target?: string | MarketTick
  ): { marketKey: string; instrumentCode: string } | null {
    return selectOrderBookMarketKey(
      {
        orderBook: this.orderBook,
        microstructure: this.engineState.microstructure
      },
      target
    );
  }

  private calculatePriceDiscovery(
    instrumentCode: string | null | undefined,
    observedAt: string
  ): PriceDiscoveryMetrics {
    return calculateOrderBookPriceDiscovery(this.orderBook, instrumentCode, observedAt);
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
    const selected = this.selectMarketKey(instrumentCode);
    const normalizedInstrument =
      selected?.instrumentCode ??
      instrumentCode?.toLowerCase() ??
      this.engineState.microstructure.instrumentCode ??
      "unknown";

    if (this.engineState.dom?.instrumentCode === normalizedInstrument) {
      return this.engineState.dom;
    }

    return this.buildDomAnalysis(normalizedInstrument, new Date().toISOString(), undefined, false);
  }

  private buildDomAnalysis(
    instrumentCode: string | undefined,
    observedAt: string,
    tick: MarketTick | undefined,
    persistHistory: boolean
  ): DomAnalysisSnapshot {
    const selected = tick ? this.selectMarketKey(tick) : this.selectMarketKey(instrumentCode);
    const normalizedInstrument =
      selected?.instrumentCode ??
      instrumentCode?.toLowerCase() ??
      this.engineState.microstructure.instrumentCode ??
      "unknown";
    const marketKey = selected?.marketKey ?? normalizeMarketKey(normalizedInstrument);
    const book = this.orderBook.get(marketKey);
    const binSize = resolveDomBinSize(this.env, normalizedInstrument, this.domPriceBinSize);

    if (!book || book.midPrice === null || book.midPrice <= 0) {
      return emptyDomSnapshot(
        normalizedInstrument,
        book?.exchangeCode ?? null,
        book?.sequence ?? null,
        book?.midPrice ?? null,
        this.domScanRangePct,
        binSize,
        this.domWallHistory.slice(-this.domWallHistoryLimit),
        observedAt
      );
    }

    const midPrice = book.midPrice;
    const lowerBound = roundCrypto(midPrice * (1 - this.domScanRangePct));
    const upperBound = roundCrypto(midPrice * (1 + this.domScanRangePct));
    const bidLevels = getInstrumentBook(this.bids, marketKey, "bid").range(
      lowerBound,
      upperBound,
      DOM_MAX_LEVELS_PER_SIDE
    );
    const askLevels = getInstrumentBook(this.asks, marketKey, "ask").range(
      lowerBound,
      upperBound,
      DOM_MAX_LEVELS_PER_SIDE
    );
    const bins = aggregateDomBins(bidLevels, askLevels, binSize);
    const stats = volumeStats(bins.map((bin) => bin.volume));
    const previousActiveWalls = latestActiveWalls(this.domWallHistory, normalizedInstrument);
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
      this.domSpoofProximityBps,
      midPrice
    );
    const pulledWalls = transitions.filter(
      (wall) => wall.status === "PULLED" && wall.spoofingSuspected
    );
    const filledWalls = transitions.filter((wall) => wall.status === "FILLED");
    const history = persistHistory
      ? this.appendDomHistory([...walls, ...transitions])
      : this.domWallHistory.slice(-this.domWallHistoryLimit);

    return {
      schemaVersion: "dom.analysis.v1",
      instrumentCode: normalizedInstrument,
      exchangeCode: book.exchangeCode,
      sequence: book.sequence,
      midPrice,
      scanRangePct: this.domScanRangePct,
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

  private appendDomHistory(events: LiquidityWall[]): LiquidityWall[] {
    if (events.length > 0) {
      this.domWallHistory.push(...events);
    }

    if (this.domWallHistory.length > this.domWallHistoryLimit) {
      this.domWallHistory.splice(0, this.domWallHistory.length - this.domWallHistoryLimit);
    }

    return this.domWallHistory.slice(-this.domWallHistoryLimit);
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

  private async handleTick(
    tick: MarketTick,
    wakeUpTimeMs: number | null,
    options: TickHandlingOptions = {}
  ): Promise<TickIngestResult> {
    const hotPathStartedAt = highResolutionNow();
    const normalizedInstrument = normalizeNativeInstrumentCode(tick.instrumentCode);

    if (!options.shadowReplay && !isTargetInstrument(normalizedInstrument)) {
      return {
        accepted: false,
        status: "IGNORED",
        reason: "NON_TARGET_ASSET",
        processedCount: 0
      };
    }

    if (
      !options.shadowReplay &&
      isShadowMode(this.env) &&
      this.cachedConfig.TRADING_ENABLED &&
      this.engineState.mode === "HALTED"
    ) {
      const resumedAt = new Date().toISOString();
      const assetQuoteStates = normalizeAssetQuoteStates(
        defaultAssetQuoteStates(this.cachedConfig, this.macroBias, resumedAt),
        this.cachedConfig,
        this.macroBias,
        resumedAt
      );
      this.engineState = {
        ...this.engineState,
        mode: "PAPER",
        bankroll: normalizePaperBankroll(this.engineState.bankroll, this.env, resumedAt),
        risk: {
          ...this.engineState.risk,
          killSwitch: false,
          updatedAt: resumedAt
        },
        quoteState: aggregateQuoteState(assetQuoteStates, this.engineState.quoteState, resumedAt),
        assetQuoteStates,
        heartbeatAt: resumedAt,
        updatedAt: resumedAt
      };
      this.killSwitchLogged = false;
      this.logger.warn(
        "SHADOW_MODE_AUTO_RESUME",
        "Shadow mode resumed paper trading after a stale halt",
        {
          instrumentCode: tick.instrumentCode,
          previousMode: "HALTED",
          nextMode: "PAPER",
          configVersion: this.cachedConfig.version
        }
      );
      this.publish("RESUME_QUOTES", {
        reason: "SHADOW_MODE_AUTO_RESUME",
        observedAt: resumedAt
      });
    }

    if (
      !options.shadowReplay &&
      this.engineState.mode === "HALTED" &&
      this.cachedConfig.TRADING_ENABLED
    ) {
      if (!this.killSwitchLogged) {
        this.logger.warn("KILL_SWITCH_ACTIVE", "Trading halted by cached config", {
          instrumentCode: tick.instrumentCode,
          configVersion: this.cachedConfig.version,
          tradingEnabled: this.cachedConfig.TRADING_ENABLED,
          mode: this.engineState.mode
        });
        this.killSwitchLogged = true;
      }

      return {
        accepted: false,
        status: "DISABLED",
        reason: "TRADING_DISABLED"
      };
    }

    if (!options.shadowReplay && !this.cachedConfig.TRADING_ENABLED && !this.killSwitchLogged) {
      this.logger.warn("KILL_SWITCH_ACTIVE", "Trading disabled; market data remains enabled", {
        instrumentCode: tick.instrumentCode,
        configVersion: this.cachedConfig.version,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        mode: this.engineState.mode
      });
      this.killSwitchLogged = true;
    }

    this.lastTickTimestamp = tick.receivedAt;
    this.observeCascadeAbsorption(tick);

    const metrics = this.calculateLatency(tick);
    const streamId = extractTickStreamId(tick);
    const hardStaleDropMs = this.resolveNativeHyperliquidMaxLatencyMs(tick.transport, streamId);
    const isHardStale = !options.shadowReplay && metrics.totalLatencyMs > hardStaleDropMs;

    if (isHardStale) {
      const nextStaleTickCount = this.engineState.staleTickCount + 1;
      metrics.status = "STALE";
      metrics.maxLatencyMs = hardStaleDropMs;
      metrics.averageLatencyMs = this.engineState.averageLatency;
      metrics.sampleCount = this.engineState.latencySampleCount;
      const assetQuoteStates = suspendAssetQuoteStates(
        this.engineState.assetQuoteStates,
        "HARD_STALE_DROP",
        metrics.brainTimestamp,
        { lastQuote: this.engineState.quoteState.lastQuote }
      );

      this.engineState = {
        ...this.engineState,
        processedTicks: this.engineState.processedTicks + 1,
        staleTickCount: nextStaleTickCount,
        quoteState: aggregateQuoteState(
          assetQuoteStates,
          this.engineState.quoteState,
          metrics.brainTimestamp
        ),
        assetQuoteStates,
        heartbeatAt: metrics.brainTimestamp,
        updatedAt: metrics.brainTimestamp
      };

      if (this.engineState.averageLatency > hardStaleDropMs) {
        this.resetLatencyBaseline(metrics.brainTimestamp, "HARD_STALE_DROP");
      }

      await this.persistHotStorageSnapshot(
        {
          [ENGINE_STATE_KEY]: this.engineState,
          [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
          [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples
        },
        "HARD_STALE_TICK_DROPPED"
      );

      if (nextStaleTickCount <= 5 || nextStaleTickCount % 500 === 0) {
        this.logger.warn("HARD_STALE_TICK_DROPPED", "Dropped tick beyond hard stale threshold", {
          instrumentCode: tick.instrumentCode,
          exchangeCode: tick.exchangeCode,
          source_exchange: tick.source_exchange,
          transport: tick.transport,
          streamId,
          sequence: tick.sequence,
          totalLatencyMs: metrics.totalLatencyMs,
          networkLatencyMs: metrics.networkLatencyMs,
          processingLatencyMs: metrics.processingLatencyMs,
          hardStaleDropMs
        });
      }
      this.logPerformance(metrics);
      this.publish("STALE_DATA_KILL_SWITCH", {
        instrumentCode: tick.instrumentCode,
        exchangeCode: tick.exchangeCode,
        source_exchange: tick.source_exchange,
        transport: tick.transport,
        streamId,
        sequence: tick.sequence,
        totalLatencyMs: metrics.totalLatencyMs,
        maxLatencyMs: hardStaleDropMs,
        action: "PULL_ALL_QUOTES",
        source: "NATIVE_HYPERLIQUID"
      });
      if (this.cachedConfig.TRADING_ENABLED) {
        this.state.waitUntil(this.cancelAllQuotes(tick.instrumentCode, "HARD_STALE_DROP"));
      }

      return {
        accepted: false,
        status: "STALE_DROPPED",
        reason: "TICK_EXCEEDED_HARD_STALE_THRESHOLD",
        metrics
      };
    }

    if (
      !options.shadowReplay &&
      this.engineState.averageLatency > hardStaleDropMs &&
      metrics.totalLatencyMs <= hardStaleDropMs
    ) {
      this.resetLatencyBaseline(metrics.brainTimestamp, "FRESH_SAMPLE_AFTER_BACKLOG");
    }

    metrics.maxLatencyMs = this.maxLatencyMs;
    metrics.status =
      !options.shadowReplay && metrics.totalLatencyMs > this.maxLatencyMs ? "STALE" : "FRESH";

    if (metrics.status === "FRESH") {
      this.updateLatencyAverage(metrics.totalLatencyMs);
    }

    this.applyLocationLatency(metrics.totalLatencyMs, metrics.brainTimestamp);

    metrics.averageLatencyMs = this.engineState.averageLatency;
    metrics.sampleCount = this.engineState.latencySampleCount;
    metrics.latencyRiskMultiplier = this.engineState.location.latencyRiskMultiplier;
    metrics.positionSizeMultiplier = this.engineState.location.positionSizeMultiplier;

    this.latencyHistory = [...this.latencyHistory, metrics].slice(-PERFORMANCE_HISTORY_LIMIT);

    if (metrics.status === "STALE" && !options.shadowReplay && this.cachedConfig.TRADING_ENABLED) {
      this.observeExecutionProfile(metrics, {
        wakeUpTimeMs,
        orderBookUpdateMs: null,
        agentLogicMs: null,
        hotPathStartedAt,
        observedAt: metrics.brainTimestamp
      });

      const suspendedUntil = new Date(
        Date.parse(metrics.brainTimestamp) + this.resolveQuoteHibernateMs()
      ).toISOString();
      const assetQuoteStates = suspendAssetQuoteStates(
        this.engineState.assetQuoteStates,
        "STALE_DATA_KILL_SWITCH",
        metrics.brainTimestamp,
        {
          instrumentCode: tick.instrumentCode,
          suspendedUntil,
          lastQuote: this.engineState.quoteState.lastQuote
        }
      );
      this.engineState = {
        ...this.engineState,
        processedTicks: this.engineState.processedTicks + 1,
        staleTickCount: this.engineState.staleTickCount + 1,
        quoteState: aggregateQuoteState(
          assetQuoteStates,
          this.engineState.quoteState,
          metrics.brainTimestamp
        ),
        assetQuoteStates,
        maxLatencyMs: this.maxLatencyMs,
        heartbeatAt: metrics.brainTimestamp,
        updatedAt: metrics.brainTimestamp
      };

      await this.persistHotStorageSnapshot(
        {
          [ENGINE_STATE_KEY]: this.engineState,
          [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
          [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples,
          [`staleTick:${tick.source_exchange}:${tick.instrumentCode}:${tick.sequence}`]: {
            tick,
            metrics
          }
        },
        "STALE_DATA_KILL_SWITCH"
      );

      this.logPerformance(metrics);
      this.publish("STALE_DATA_KILL_SWITCH", {
        instrumentCode: tick.instrumentCode,
        exchangeCode: tick.exchangeCode,
        source_exchange: tick.source_exchange,
        sequence: tick.sequence,
        totalLatencyMs: metrics.totalLatencyMs,
        maxLatencyMs: this.maxLatencyMs,
        action: "PULL_CURRENT_QUOTES"
      });
      this.notifier.notify({
        priority: "HIGH",
        title: "Sovereign-Sigma stale-data kill switch",
        message: `${tick.instrumentCode} seq ${tick.sequence} exceeded ${this.maxLatencyMs}ms freshness threshold (${metrics.totalLatencyMs}ms). Quotes are being pulled.`,
        dedupeKey: `stale:${tick.source_exchange}:${tick.instrumentCode}`,
        metadata: {
          instrumentCode: tick.instrumentCode,
          sequence: tick.sequence,
          totalLatencyMs: metrics.totalLatencyMs,
          maxLatencyMs: this.maxLatencyMs
        }
      });
      if (this.cachedConfig.TRADING_ENABLED) {
        this.state.waitUntil(this.cancelAllQuotes(tick.instrumentCode, "STALE_DATA_KILL_SWITCH"));
      }
      this.publishTickTelemetry(tick, metrics, "STALE", hotPathStartedAt);
      this.maybeRecordAgentSnapshot(metrics.brainTimestamp);

      return {
        accepted: false,
        status: "STALE",
        metrics
      };
    }

    this.applyFundingFromTick(tick, metrics.brainTimestamp);

    let orderBookUpdateMs = 0;
    let book: InternalOrderBook | undefined;

    if (isInformationalTick(tick)) {
      metrics.timeToBookMs = null;
      book = this.currentBookForTick(tick);

      if (!book) {
        this.observeExecutionProfile(metrics, {
          wakeUpTimeMs,
          orderBookUpdateMs,
          agentLogicMs: null,
          hotPathStartedAt,
          observedAt: metrics.brainTimestamp
        });

        const assetQuoteStates = this.cachedConfig.TRADING_ENABLED
          ? suspendAssetQuoteStates(
              this.engineState.assetQuoteStates,
              "ORDER_BOOK_NOT_READY",
              metrics.brainTimestamp,
              {
                instrumentCode: tick.instrumentCode,
                lastQuote: this.engineState.quoteState.lastQuote
              }
            )
          : this.engineState.assetQuoteStates;
        this.engineState = {
          ...this.engineState,
          processedTicks: this.engineState.processedTicks + 1,
          quoteState: this.cachedConfig.TRADING_ENABLED
            ? aggregateQuoteState(
                assetQuoteStates,
                this.engineState.quoteState,
                metrics.brainTimestamp
              )
            : this.engineState.quoteState,
          assetQuoteStates,
          maxLatencyMs: this.maxLatencyMs,
          heartbeatAt: metrics.brainTimestamp,
          updatedAt: metrics.brainTimestamp
        };

        await this.persistHotStorageSnapshot(
          {
            [ENGINE_STATE_KEY]: this.engineState,
            [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
            [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples
          },
          "INFORMATIONAL_TICK_BOOK_NOT_READY"
        );

        this.publishTickTelemetry(tick, metrics, "FRESH", hotPathStartedAt);

        return {
          accepted: false,
          status: "BOOK_NOT_READY",
          reason: "INFORMATIONAL_TICK_WITHOUT_BOOK",
          metrics
        };
      }
    } else {
      const orderBookStartedAt = highResolutionNow();
      const applied = await this.applyDelta(tickToDelta(tick), metrics.brainTimestamp);
      orderBookUpdateMs = roundLatency(highResolutionNow() - orderBookStartedAt);
      metrics.timeToBookMs = applied.timeToBookMs;

      if (!applied.accepted) {
        if (applied.reason === "DUPLICATE_OR_OUT_OF_ORDER") {
          this.observeExecutionProfile(metrics, {
            wakeUpTimeMs,
            orderBookUpdateMs,
            agentLogicMs: null,
            hotPathStartedAt,
            observedAt: metrics.brainTimestamp
          });

          return {
            accepted: false,
            status: "DUPLICATE_OR_OUT_OF_ORDER",
            reason: applied.reason,
            metrics
          };
        }

        this.observeExecutionProfile(metrics, {
          wakeUpTimeMs,
          orderBookUpdateMs,
          agentLogicMs: null,
          hotPathStartedAt,
          observedAt: metrics.brainTimestamp
        });

        this.engineState = {
          ...this.engineState,
          processedTicks: this.engineState.processedTicks + 1,
          internalOrderBookDepth: countBookLevels(this.bids, this.asks),
          maxLatencyMs: this.maxLatencyMs,
          heartbeatAt: metrics.brainTimestamp,
          updatedAt: metrics.brainTimestamp
        };

        await this.persistHotStorageSnapshot(
          {
            [ENGINE_STATE_KEY]: this.engineState,
            [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
            [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples,
            [`bookDesync:${tick.source_exchange}:${tick.instrumentCode}:${tick.sequence}`]: {
              tick,
              metrics,
              reason: applied.reason,
              expectedSequence: applied.expectedSequence,
              actualSequence: applied.actualSequence
            }
          },
          "BOOK_DESYNC"
        );

        this.publishTickTelemetry(tick, metrics, "FRESH", hotPathStartedAt);

        return {
          accepted: false,
          status:
            applied.reason === "SEQUENCE_GAP" || applied.reason === "CROSSED_BOOK"
              ? "DESYNC"
              : "DUPLICATE_OR_OUT_OF_ORDER",
          reason: applied.reason,
          metrics
        };
      }

      book = applied.book;

      if (!book) {
        throw new Error("ORDER_BOOK_APPLY_FAILED");
      }
    }

    await this.evaluateCascadeStrategy(tick, metrics.brainTimestamp);

    const volatilitySnapshot = this.multiScaleVolatility.update(
      tick.instrumentCode,
      book.midPrice,
      metrics.brainTimestamp
    );
    this.maybeCancelLaggingHypeQuotes(tick, volatilitySnapshot, metrics.brainTimestamp, options);

    const shadowQueueState = this.processShadowQueueTick(
      tick,
      book,
      metrics.brainTimestamp,
      options
    );
    const domSnapshot = this.getLiquidityWalls(tick.instrumentCode, metrics.brainTimestamp, tick);
    const anomalyLogicStartedAt = highResolutionNow();
    const anomalyResult = this.anomalyDetector.evaluate({
      tick,
      book,
      dom: domSnapshot,
      observedAt: metrics.brainTimestamp
    });

    if (
      anomalyResult.emergencyPause &&
      this.cachedConfig.TRADING_ENABLED &&
      !options.shadowReplay &&
      !isShadowMode(this.env)
    ) {
      const anomalyLogicMs = roundLatency(highResolutionNow() - anomalyLogicStartedAt);

      this.observeExecutionProfile(metrics, {
        wakeUpTimeMs,
        orderBookUpdateMs,
        agentLogicMs: anomalyLogicMs,
        hotPathStartedAt,
        observedAt: metrics.brainTimestamp
      });

      this.engineState = {
        ...this.engineState,
        mode: "HALTED",
        processedTicks: this.engineState.processedTicks + 1,
        internalOrderBookDepth: countBookLevels(this.bids, this.asks),
        microstructure: microstructureFromBook(book),
        dom: domSnapshot,
        anomaly: anomalyResult.status,
        risk: {
          ...this.engineState.risk,
          killSwitch: true,
          updatedAt: metrics.brainTimestamp
        },
        heartbeatAt: metrics.brainTimestamp,
        updatedAt: metrics.brainTimestamp
      };

      await this.safeStoragePut(
        {
          [ENGINE_STATE_KEY]: this.engineState,
          [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
          [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples,
          [DOM_WALL_HISTORY_KEY]: this.domWallHistory,
          [ANOMALY_DETECTOR_STORAGE_KEY]: anomalyResult.state,
          [`${ORDER_BOOK_PREFIX}${book.marketKey}`]: book,
          [`lastTick:${book.marketKey}`]: tick,
          [`anomaly:${book.marketKey}:${tick.sequence}`]: anomalyResult.anomalies
        },
        "ANOMALY_EMERGENCY_PAUSE"
      );

      this.triggerEmergencyPause(tick, book, domSnapshot, anomalyResult, metrics);
      this.publishTickTelemetry(tick, metrics, "FRESH", hotPathStartedAt);

      return {
        accepted: false,
        status: "ANOMALY_PAUSE",
        reason: anomalyResult.anomalies.map((event) => event.types.join("+")).join(","),
        metrics,
        book
      };
    }

    const profilerAgent = this.profilerFor(tick.instrumentCode);
    const profilerStartedAt = highResolutionNow();
    const profilerResult: ProfilerEvaluation = this.cachedConfig.PROFILER_ENABLED
      ? profilerAgent.processTick(tick, {
          engineId: this.engineState.engineId,
          observedAt: metrics.brainTimestamp,
          midPrice: book.midPrice,
          spreadBps: book.spreadBps,
          weightedImbalance: book.weightedImbalance,
          orderBookBids: book.bids,
          orderBookAsks: book.asks,
          liquidityWalls: domSnapshot.walls,
          spoofingAlerts: domSnapshot.pulledWalls,
          liquidationHeatmap: this.engineState.liquidationHeatmap,
          jumpDetected: volatilitySnapshot?.jumpDetected ?? false
        })
      : disabledProfilerEvaluation(profilerAgent.snapshot(), metrics.brainTimestamp);
    const profilerLatencyMs = this.cachedConfig.PROFILER_ENABLED
      ? roundLatency(highResolutionNow() - profilerStartedAt)
      : 0;

    this.observeExecutionProfile(metrics, {
      wakeUpTimeMs,
      orderBookUpdateMs,
      agentLogicMs: profilerLatencyMs,
      hotPathStartedAt,
      observedAt: metrics.brainTimestamp
    });

    const oracleStartedAt = highResolutionNow();
    const oracleResult = this.cachedConfig.ORACLE_ENABLED
      ? this.oracleAgent.processTick({
          tick,
          book,
          observedAt: metrics.brainTimestamp,
          config: {
            ORACLE_GOVERNANCE_MODE: this.cachedConfig.ORACLE_GOVERNANCE_MODE,
            ORACLE_MANUAL_SKEPTICISM: this.cachedConfig.ORACLE_MANUAL_SKEPTICISM,
            ORACLE_MAX_SKEPTICISM: this.cachedConfig.ORACLE_MAX_SKEPTICISM
          }
        })
      : {
          state: {
            ...this.engineState.oracle,
            updatedAt: metrics.brainTimestamp
          },
          bayesianTrace: null,
          regimeChanged: false
        };
    const oracleLatencyMs = this.cachedConfig.ORACLE_ENABLED
      ? roundLatency(highResolutionNow() - oracleStartedAt)
      : 0;
    const leadLag = this.engineState.leadLag;
    const inventory = this.calculateInventoryState(metrics.brainTimestamp);
    const riskMetrics = this.updatePortfolioRisk(oracleResult.state, metrics.brainTimestamp);
    const profilerStates = this.profilerStateSnapshot(tick.instrumentCode, profilerResult.state);
    const assetMatrix = this.calculateAssetMatrix(
      metrics.brainTimestamp,
      tick.instrumentCode,
      oracleResult.state,
      profilerStates
    );
    const inventoryGuard = passiveInventoryGuardStateFromInventory(
      inventory,
      metrics.brainTimestamp
    );
    const sentimentForDecision = this.cachedConfig.SENTIMENT_ENABLED
      ? this.engineState.sentiment
      : {
          ...defaultSentimentState(),
          updatedAt: metrics.brainTimestamp
        };
    const croupierStartedAt = highResolutionNow();
    const bidAdversePenalty = adversePenaltyForQuoteSide(
      this.adverseSelectionModel,
      book,
      "BID",
      oracleResult.state.regime,
      metrics.brainTimestamp
    );
    const askAdversePenalty = adversePenaltyForQuoteSide(
      this.adverseSelectionModel,
      book,
      "ASK",
      oracleResult.state.regime,
      metrics.brainTimestamp
    );
    const croupierDecision = this.cachedConfig.CROUPIER_ENABLED
      ? this.croupierAgent.evaluate({
          engineId: this.engineState.engineId,
          book,
          oracle: oracleResult.state,
          sentiment: sentimentForDecision,
          toxicityScore: profilerResult.toxicityScore,
          inventory,
          leadLag,
          minEvThreshold: this.cachedConfig.MIN_EV_THRESHOLD,
          exchangeFeeBps: this.cachedConfig.EXCHANGE_FEE_BPS,
          executionCostBufferBps: this.engineState.slippage.executionCostBufferBps,
          adverseSelectionPenaltyBps: Math.max(
            bidAdversePenalty.penaltyBps,
            askAdversePenalty.penaltyBps
          ),
          multiScaleVolatility: volatilitySnapshot,
          fundingRateHourly: this.currentFundingRate(book),
          fundingHorizonHours: readPositiveNumber(this.env.FUNDING_HORIZON_HOURS, 1),
          riskAversionFactor: this.cachedConfig.RISK_AVERSION_FACTOR,
          fundingBiasThreshold:
            this.cachedConfig.FUNDING_BIAS_THRESHOLD > 0
              ? this.cachedConfig.FUNDING_BIAS_THRESHOLD
              : readPositiveNumber(this.env.FUNDING_BIAS_THRESHOLD, DEFAULT_FUNDING_BIAS_THRESHOLD),
          fundingInventoryBias:
            this.cachedConfig.FUNDING_INVENTORY_BIAS > 0
              ? this.cachedConfig.FUNDING_INVENTORY_BIAS
              : readPositiveNumber(this.env.FUNDING_INVENTORY_BIAS, DEFAULT_FUNDING_INVENTORY_BIAS),
          fundingPreSettlementWindowMs: this.cachedConfig.FUNDING_PRE_SETTLEMENT_WINDOW_MS,
          fundingPreSettlementBiasMultiplier:
            this.cachedConfig.FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER,
          liquidationHeatmap: this.engineState.liquidationHeatmap,
          predatoryOrderOffsetBps: readPositiveNumber(
            this.env.HL_PREDATORY_ORDER_OFFSET_BPS,
            DEFAULT_PREDATORY_ORDER_OFFSET_BPS
          ),
          profilerToxicityState: profilerResult.state.toxicityState,
          profilerPressureSide: profilerResult.state.pressureSide,
          profilerSpreadMultiplier: profilerResult.state.spreadMultiplier,
          profilerReservationShiftBps: profilerResult.state.reservationShiftBps,
          layeredQuoteLevels: this.cachedConfig.LAYERED_QUOTE_LEVELS,
          layeredQuoteSizeDecay: this.cachedConfig.LAYERED_QUOTE_SIZE_DECAY,
          layeredQuoteSpreadStepBps: this.cachedConfig.LAYERED_QUOTE_SPREAD_STEP_BPS,
          sentimentAlphaMode: this.cachedConfig.SENTIMENT_ALPHA_MODE,
          macroBias: this.macroBias,
          marketMakingMode: this.cachedConfig.MARKET_MAKING_MODE,
          observedAt: metrics.brainTimestamp
        })
      : disabledCroupierDecision(this.cachedConfig.MIN_EV_THRESHOLD);
    const croupierLatencyMs = this.cachedConfig.CROUPIER_ENABLED
      ? roundLatency(highResolutionNow() - croupierStartedAt)
      : 0;
    const ensemble = this.calculateEnsembleState(
      croupierDecision.intent,
      profilerResult.state,
      oracleResult.state,
      sentimentForDecision,
      anomalyResult.status,
      metrics.brainTimestamp
    );
    const executionPlan = this.cachedConfig.PIT_BOSS_ENABLED
      ? this.prepareExecutionPlan(croupierDecision.intent, metrics.brainTimestamp, {
          stateOverride: { ...this.engineState, assetMatrix, ensemble },
          kellyFractionOverride: this.cachedConfig.KELLY_FRACTION * ensemble.kellyMultiplier
        })
      : null;
    let executionPlans = [executionPlan].filter(
      (plan): plan is NonNullable<typeof executionPlan> => plan !== null
    );
    const previousQuoteState = quoteStateForInstrumentState(
      this.engineState.assetQuoteStates,
      tick.instrumentCode,
      this.engineState.quoteState
    );
    let assetQuoteState = this.nextQuoteStateForInstrument(
      tick.instrumentCode,
      croupierDecision.quote,
      croupierDecision.pullAllQuotes,
      metrics.brainTimestamp
    );
    const strategyQuoteDisableReason = this.strategyQuoteDisabledReason();
    if (
      strategyQuoteDisableReason &&
      previousQuoteState.reason !== strategyQuoteDisableReason &&
      !options.shadowReplay &&
      this.cachedConfig.TRADING_ENABLED
    ) {
      this.state.waitUntil(this.cancelAllQuotes(tick.instrumentCode, strategyQuoteDisableReason));
    }
    const profilerSignalType = profilerResult.signal?.featureVector.signalType;
    const isCascadeShield = profilerSignalType === "CASCADE_SHIELD";
    const isProfilerQuoteHalt =
      profilerSignalType === "SUSPEND_QUOTES" || profilerSignalType === "AM_VPIN_CRITICAL";

    if (ensemble.anomalyCircuitBreaker) {
      executionPlans = [];
      assetQuoteState = {
        status: "SUSPENDED",
        reason: "ENSEMBLE_ANOMALY_CIRCUIT_BREAKER",
        suspendedUntil: new Date(Date.parse(metrics.brainTimestamp) + 60_000).toISOString(),
        lastQuote: assetQuoteState.lastQuote,
        updatedAt: metrics.brainTimestamp
      };
      this.publish("SUSPEND_QUOTES", {
        instrumentCode: tick.instrumentCode,
        reason: ensemble.rationale,
        ...quoteStateTelemetry(assetQuoteState)
      });
      if (!options.shadowReplay && this.cachedConfig.TRADING_ENABLED) {
        this.state.waitUntil(this.cancelAllQuotes(tick.instrumentCode, "ENSEMBLE_CIRCUIT_BREAKER"));
      }
    } else if (isProfilerQuoteHalt) {
      executionPlans = [];
      const suspendedUntil =
        typeof profilerResult.signal?.featureVector.suspendedUntil === "string"
          ? profilerResult.signal.featureVector.suspendedUntil
          : (profilerResult.state.quoteHaltUntil ??
            new Date(
              Date.parse(metrics.brainTimestamp) +
                (profilerSignalType === "AM_VPIN_CRITICAL"
                  ? this.cachedConfig.AM_VPIN_QUOTE_HALT_MS
                  : this.resolveQuoteHibernateMs())
            ).toISOString());
      assetQuoteState = {
        status: "SUSPENDED",
        reason: profilerSignalType === "AM_VPIN_CRITICAL" ? "AM_VPIN_CRITICAL" : "WHALE_PRINT",
        suspendedUntil,
        lastQuote: assetQuoteState.lastQuote,
        updatedAt: metrics.brainTimestamp
      };
      this.publish("SUSPEND_QUOTES", {
        instrumentCode: tick.instrumentCode,
        ...quoteStateTelemetry(assetQuoteState)
      });
    }

    const assetQuoteStates = {
      ...this.engineState.assetQuoteStates,
      [tick.instrumentCode]: assetQuoteState
    };
    const quoteState = aggregateQuoteState(
      assetQuoteStates,
      this.engineState.quoteState,
      metrics.brainTimestamp
    );
    const finalAssetMatrix = this.calculateAssetMatrix(
      metrics.brainTimestamp,
      tick.instrumentCode,
      oracleResult.state,
      profilerStates,
      assetQuoteStates
    );
    let agentHealth = this.engineState.agentHealth;
    agentHealth = touchAgentHealth(
      agentHealth,
      "ORACLE",
      this.cachedConfig.ORACLE_ENABLED ? "GREEN" : "DISABLED",
      metrics.brainTimestamp,
      oracleLatencyMs
    );
    agentHealth = touchAgentHealth(
      agentHealth,
      "SENTIMENT",
      this.cachedConfig.SENTIMENT_ENABLED ? "GREEN" : "DISABLED",
      metrics.brainTimestamp,
      this.cachedConfig.SENTIMENT_ENABLED ? agentHealth.SENTIMENT.latencyMs : 0
    );
    agentHealth = touchAgentHealth(
      agentHealth,
      "PROFILER",
      this.cachedConfig.PROFILER_ENABLED
        ? profilerResult.toxicityScore > profilerResult.state.alertThreshold
          ? "YELLOW"
          : "GREEN"
        : "DISABLED",
      metrics.brainTimestamp,
      profilerLatencyMs,
      profilerResult.signal?.signalId ?? undefined
    );
    agentHealth = touchAgentHealth(
      agentHealth,
      "CROUPIER",
      this.cachedConfig.CROUPIER_ENABLED && this.cachedConfig.MARKET_MAKING_MODE !== "OFF"
        ? croupierDecision.intent || croupierDecision.quote
          ? "GREEN"
          : "YELLOW"
        : "DISABLED",
      metrics.brainTimestamp,
      croupierLatencyMs,
      croupierDecision.quote?.signalId ?? croupierDecision.intent?.intentId
    );
    agentHealth = touchAgentHealth(
      agentHealth,
      "PIT_BOSS",
      this.cachedConfig.PIT_BOSS_ENABLED ? (executionPlan ? "GREEN" : "YELLOW") : "DISABLED",
      metrics.brainTimestamp,
      0,
      executionPlan?.intent.intentId
    );

    this.engineState = {
      ...this.engineState,
      mode:
        !this.cachedConfig.TRADING_ENABLED && this.engineState.mode === "HALTED"
          ? "PAPER"
          : this.engineState.mode,
      processedTicks: this.engineState.processedTicks + 1,
      staleTickCount:
        metrics.status === "STALE" && !options.shadowReplay
          ? this.engineState.staleTickCount + 1
          : this.engineState.staleTickCount,
      internalOrderBookDepth: countBookLevels(this.bids, this.asks),
      microstructure: microstructureFromBook(book),
      oracle: oracleResult.state,
      sentiment: sentimentForDecision,
      ensemble,
      leadLag,
      inventory,
      current_inventory_delta: inventory.current_inventory_delta,
      riskMetrics,
      risk: {
        ...this.engineState.risk,
        killSwitch: !riskMetrics.isTradingEnabled,
        updatedAt: metrics.brainTimestamp
      },
      quoteState,
      assetQuoteStates,
      shadowQueue: shadowQueueState,
      lastTradeIntent: executionPlan?.intent ?? croupierDecision.intent,
      inventoryGuard,
      orderMap:
        executionPlans.length > 0 && (this.cachedConfig.TRADING_ENABLED || options.shadowReplay)
          ? {
              ...this.engineState.orderMap,
              ...Object.fromEntries(
                executionPlans.flatMap((plan) =>
                  plan.orders.map((order) => [order.clientId, order])
                )
              )
            }
          : this.engineState.orderMap,
      dom: domSnapshot,
      anomaly: anomalyResult.status,
      liquidationHeatmap: this.engineState.liquidationHeatmap,
      assetMatrix: finalAssetMatrix,
      profilerStates,
      toxicityScore: profilerResult.toxicityScore,
      agentHealth,
      maxLatencyMs: this.maxLatencyMs,
      heartbeatAt: metrics.brainTimestamp,
      updatedAt: metrics.brainTimestamp
    };

    const writes: Record<string, unknown> = {
      [ENGINE_STATE_KEY]: this.engineState,
      [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
      [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples,
      [DOM_WALL_HISTORY_KEY]: this.domWallHistory,
      [ANOMALY_DETECTOR_STORAGE_KEY]: anomalyResult.state,
      [`${ORDER_BOOK_PREFIX}${book.marketKey}`]: book,
      [`lastTick:${book.marketKey}`]: tick
    };

    if (profilerResult.processed) {
      writes[profilerStorageKey(tick.instrumentCode)] = profilerResult.state;
      if (tick.instrumentCode === "btc-usd") {
        writes[PROFILER_STATE_STORAGE_KEY] = profilerResult.state;
      }
    }

    this.state.waitUntil(this.persistHotStorageSnapshot(writes, "HOT_PATH_TICK_SNAPSHOT"));
    if (this.shouldJournalMarketTick()) {
      this.logger.recordMarketTick(tick);
    }

    if (
      oracleResult.bayesianTrace &&
      this.engineState.processedTicks % AGENT_SNAPSHOT_TICK_INTERVAL === 0
    ) {
      this.logger.info("BAYESIAN_POSTERIOR_UPDATED", "Oracle posterior PDF updated", {
        instrumentCode: tick.instrumentCode,
        ...oracleResult.bayesianTrace
      });
    }

    if (croupierDecision.pullAllQuotes) {
      this.publish("PULL_ALL_QUOTES", {
        instrumentCode: tick.instrumentCode,
        adverseSelectionCost: croupierDecision.adverseSelectionCost,
        minEvThreshold: croupierDecision.minEvThreshold
      });
      if (!options.shadowReplay && this.cachedConfig.TRADING_ENABLED) {
        this.state.waitUntil(
          this.cancelAllQuotes(tick.instrumentCode, "ADVERSE_SELECTION_CRITICAL")
        );
      }
    } else if (croupierDecision.quote && !strategyQuoteDisableReason) {
      this.publish(
        "POST_QUOTE",
        quoteToTelemetry(croupierDecision.quote),
        croupierDecision.quote.signalId
      );
      if (
        !options.shadowReplay &&
        this.cachedConfig.TRADING_ENABLED &&
        !isProfilerQuoteHalt &&
        this.canDispatchStrategyOrders()
      ) {
        const quote = croupierDecision.quote;
        this.state.waitUntil(
          isCascadeShield
            ? this.cancelAllQuotes(tick.instrumentCode, "CASCADE_SHIELD").then(() =>
                this.dispatchQuote(quote)
              )
            : this.dispatchQuote(quote)
        );
      }
    }

    for (const plan of executionPlans) {
      const dispatchGate = evaluateIntentDispatchGate(this.engineState, plan.intent);
      if (!options.shadowReplay && dispatchGate.allowed) {
        this.logger.info("TRADE_INTENT_AUTHORIZED", "PitBoss authorized executable intent", {
          intentId: plan.intent.intentId,
          instrumentCode: plan.intent.instrumentCode,
          expectedValue: plan.intent.expectedValue,
          approvedSize: plan.intent.approvedSize,
          sorSavings: plan.sorPlan.sorSavings,
          intendedSize: plan.camouflage.intendedSize,
          camouflagedSize: plan.camouflage.camouflagedSize,
          icebergChildCount: plan.camouflage.icebergChunks.length,
          timingJitterMs: plan.camouflage.timingJitterMs
        });
        for (const childIntent of plan.camouflage.icebergChunks) {
          this.state.waitUntil(this.dispatchExecution(childIntent, plan.camouflage.timingJitterMs));
        }
      } else if (!options.shadowReplay && this.cachedConfig.TRADING_ENABLED) {
        this.logger.warn(
          "TRADE_INTENT_DISPATCH_BLOCKED",
          "Intent dispatch gate blocked execution",
          {
            intentId: plan.intent.intentId,
            instrumentCode: plan.intent.instrumentCode,
            reason: dispatchGate.reason
          }
        );
      } else if (options.shadowReplay) {
        this.logger.info("SHADOW_TRADE_INTENT_AUTHORIZED", "Replay generated shadow trade intent", {
          intentId: plan.intent.intentId,
          instrumentCode: plan.intent.instrumentCode,
          expectedValue: plan.intent.expectedValue,
          approvedSize: plan.intent.approvedSize,
          icebergChildCount: plan.camouflage.icebergChunks.length
        });
      }
    }

    const hedgeIntent = this.createInventoryHedgeIntent(book, inventory, metrics.brainTimestamp);
    if (hedgeIntent && !options.shadowReplay) {
      this.logger.warn("INVENTORY_HEDGE_AUTHORIZED", "Inventory hedge IOC path authorized", {
        intentId: hedgeIntent.intentId,
        instrumentCode: hedgeIntent.instrumentCode,
        action: hedgeIntent.action,
        approvedSize: hedgeIntent.approvedSize,
        expectedPrice: hedgeIntent.expectedPrice,
        currentInventoryDelta: inventory.current_inventory_delta,
        triggerPct: this.cachedConfig.HEDGE_TRIGGER_INVENTORY_PCT
      });
      this.state.waitUntil(this.dispatchExecution(hedgeIntent));
    }

    if (profilerResult.signal) {
      this.publishProfilerAlert(profilerResult.signal, profilerResult.state);
      await this.acceptAgentSignal(profilerResult.signal, profilerLatencyMs);
      if (
        (isProfilerQuoteHalt ||
          profilerResult.signal.featureVector.signalType === "CASCADE_SHIELD") &&
        !options.shadowReplay &&
        this.cachedConfig.TRADING_ENABLED &&
        (!croupierDecision.quote || isProfilerQuoteHalt)
      ) {
        this.state.waitUntil(this.cancelAllQuotes(tick.instrumentCode, "PROFILER_ALERT"));
      }
    }

    if (this.engineState.processedTicks <= 5 || this.engineState.processedTicks % 1_000 === 0) {
      this.logger.info("MARKET_TICK_ACCEPTED", "Market tick processed", {
        instrumentCode: tick.instrumentCode,
        exchangeCode: tick.exchangeCode,
        sequence: tick.sequence,
        processedTicks: this.engineState.processedTicks,
        totalLatencyMs: metrics.totalLatencyMs,
        averageLatencyMs: this.engineState.averageLatency
      });
    }

    this.publishTickTelemetry(tick, metrics, metrics.status, hotPathStartedAt);
    if (profilerResult.closedBuckets > 0) {
      this.publishAmVpinTelemetry(
        profilerResult.state,
        tick.instrumentCode,
        metrics.brainTimestamp
      );
    }
    this.maybeRecordAgentSnapshot(metrics.brainTimestamp);

    return {
      accepted: true,
      status: metrics.status,
      metrics,
      book
    };
  }

  private applyFundingFromTick(tick: MarketTick, observedAt: string): void {
    const fundingRateHourly =
      finiteNumber(tick.fundingRateHourly) ?? finiteNumber(tick.raw?.fundingRateHourly);

    if (fundingRateHourly === null) {
      return;
    }

    const marketKey = buildMarketKey(tick.source_exchange, tick.instrumentCode);
    this.engineState = {
      ...this.engineState,
      fundingRates: {
        ...this.engineState.fundingRates,
        [marketKey]: {
          instrumentCode: tick.instrumentCode,
          source_exchange: tick.source_exchange,
          marketKey,
          hourlyRate: fundingRateHourly,
          markPrice: finiteNumber(tick.markPrice) ?? finiteNumber(tick.raw?.markPrice),
          oraclePrice: finiteNumber(tick.oraclePrice) ?? finiteNumber(tick.raw?.oraclePrice),
          openInterest: finiteNumber(tick.openInterest) ?? finiteNumber(tick.raw?.openInterest),
          receivedAt: tick.receivedAt,
          updatedAt: observedAt
        }
      }
    };
  }

  private currentBookForTick(tick: MarketTick): InternalOrderBook | undefined {
    const marketKey = buildMarketKey(tick.source_exchange, tick.instrumentCode);
    return (
      this.orderBook.get(marketKey) ??
      [...this.orderBook.values()]
        .filter((book) => book.instrumentCode === tick.instrumentCode)
        .sort((left, right) => right.sourceWeight - left.sourceWeight)[0]
    );
  }

  private currentFundingRate(book: InternalOrderBook): number {
    const direct = this.engineState.fundingRates[book.marketKey]?.hourlyRate;
    if (typeof direct === "number" && Number.isFinite(direct)) {
      return direct;
    }

    const fallback = Object.values(this.engineState.fundingRates).find(
      (entry) => entry.instrumentCode === book.instrumentCode
    )?.hourlyRate;

    return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 0;
  }

  private processShadowQueueTick(
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string,
    options: TickHandlingOptions
  ): ShadowQueueState {
    if (options.shadowReplay || !book.isSynced || book.midPrice === null || book.midPrice <= 0) {
      return this.ghostBook.snapshot(observedAt);
    }

    let observation: GhostBookObservation | null = null;

    if (isTradeTick(tick)) {
      observation = this.ghostBook.observeTrade(tick, book, observedAt);

      for (const fill of observation.fills) {
        this.recordShadowQueueGhostFill(fill, tick, book, observedAt);
      }

      for (const decision of observation.decisions) {
        const updatedDecision = this.handleShadowQueueDecision(decision, book, observedAt);
        this.ghostBook.recordDecision(updatedDecision);
      }
    }

    this.ghostBook.injectBbo(book, observedAt);
    const snapshot = this.ghostBook.snapshot(observedAt);

    return observation?.decisions.length
      ? {
          ...snapshot,
          lastDecision: this.ghostBook.snapshot(observedAt).lastDecision
        }
      : snapshot;
  }

  private shouldJournalMarketTick(): boolean {
    const parsedInterval = Number(this.env.MARKET_TICK_JOURNAL_INTERVAL);
    const interval = Number.isFinite(parsedInterval)
      ? Math.max(0, Math.floor(parsedInterval))
      : DEFAULT_MARKET_TICK_JOURNAL_INTERVAL;

    if (interval === 0) {
      return false;
    }

    return this.engineState.processedTicks <= 5 || this.engineState.processedTicks % interval === 0;
  }

  private recordShadowQueueGhostFill(
    fill: ShadowQueueFill,
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string
  ): void {
    const participationRate = readBoundedNumber(
      this.env.PAPER_FILL_PARTICIPATION_RATE,
      DEFAULT_PAPER_FILL_PARTICIPATION_RATE,
      0,
      1
    );
    const fallbackAdverseBps = readBoundedNumber(
      this.env.PAPER_FILL_ADVERSE_BPS,
      DEFAULT_PAPER_FILL_ADVERSE_BPS,
      0,
      100
    );
    const paperFillModel = bootstrapPaperAdverseSelection({
      slippage: this.engineState.slippage,
      fallbackAdverseBps,
      side: fill.side
    });
    const adverseBps = paperFillModel.adverseBps;
    const makerFeeBps = readBoundedNumber(
      this.env.PAPER_MAKER_FEE_BPS ?? this.env.EXCHANGE_FEE_BPS,
      DEFAULT_PAPER_MAKER_FEE_BPS,
      0,
      100
    );
    const paperFillPrice = adverseAdjustedPaperFillPrice(
      fill.side,
      fill.price,
      adverseBps,
      book.tickSize
    );
    const paperSizeCap = this.shadowQueueKellySize(fill.side, paperFillPrice, book);
    const executablePaperSize = roundCrypto(Math.min(fill.size * participationRate, paperSizeCap));

    if (executablePaperSize <= 0) {
      this.publish(
        "SHADOW_QUEUE_GHOST_FILL",
        {
          fillId: fill.fillId,
          instrumentCode: fill.instrumentCode,
          side: fill.side,
          price: paperFillPrice,
          virtualQueueSize: fill.size,
          paperExecutionSize: 0,
          reason: "PAPER_RISK_CAP_ZERO",
          participationRate,
          adverseBps,
          observedAt
        },
        fill.fillId
      );
      return;
    }
    const fees = roundCrypto((paperFillPrice * executablePaperSize * makerFeeBps) / 10_000);

    const trade: TradeExecution = {
      tradeId: `shadow-queue:${fill.fillId}:${Date.parse(observedAt) || observedAt}`,
      orderId: fill.fillId,
      signalId: fill.fillId,
      venue: book.source_exchange,
      asset: fill.instrumentCode,
      side: fill.side,
      orderType: "LIMIT",
      price: paperFillPrice,
      size: executablePaperSize,
      evAtExecution: 0,
      slippageBps: adverseBps,
      resultingPnl: 0,
      primaryDriver: "PROFILER",
      fees,
      status: "GHOST_FILL",
      exchangeTradeId: fill.fillId,
      metadata: toJsonValue({
        schemaVersion: "shadow-queue.fill.v1",
        paperSizer: "shadowQueueKellySize",
        fillModel: "risk_capped_participation_with_bootstrapped_adverse_selection",
        fillModelSource: paperFillModel.source,
        virtualQueueSize: fill.size,
        paperExecutionSize: executablePaperSize,
        paperSizeCap,
        participationRate,
        adverseBps,
        makerFeeBps,
        originalVirtualPrice: fill.price,
        paperFillPrice,
        sizeCapped: executablePaperSize < fill.size,
        queueAhead: fill.queueAhead,
        p0MidPrice: fill.p0MidPrice,
        tapePrice: tick.price,
        tapeSize: tick.size,
        tapeSide: tick.side,
        fillTradeSequence: fill.fillTradeSequence,
        marketKey: book.marketKey,
        source_exchange: book.source_exchange,
        virtualOnly: true
      }) as JsonRecord,
      executedAt: observedAt
    };

    this.logger.recordExecution(trade);
    this.publish(
      "SHADOW_QUEUE_GHOST_FILL",
      trade as unknown as Record<string, unknown>,
      fill.fillId
    );
  }

  private handleShadowQueueDecision(
    decision: ShadowQueueDecision,
    book: InternalOrderBook,
    observedAt: string
  ): ShadowQueueDecision {
    if (decision.action === "NO_EDGE" || decision.dispatchSide === null) {
      if (this.shouldLogShadowQueueNoEdge(decision.instrumentCode)) {
        this.logger.info("SHADOW_QUEUE_NO_EDGE", "Virtual fill drift stayed inside one tick", {
          decisionId: decision.decisionId,
          fillId: decision.fillId,
          instrumentCode: decision.instrumentCode,
          microDrift: decision.microDrift,
          tickThreshold: decision.tickThreshold,
          driftTrades: decision.driftTrades,
          sampled: true
        });
      }
      this.publish(
        "SHADOW_QUEUE_NO_EDGE",
        decision as unknown as Record<string, unknown>,
        decision.decisionId
      );
      return decision;
    }

    if (decision.decisionLatencyMs > this.engineState.shadowQueue.latencyBudgetMs) {
      const suppressed = {
        ...decision,
        tradeIntentId: null,
        reason: `${decision.reason} Suppressed because drift decision latency exceeded ${this.engineState.shadowQueue.latencyBudgetMs}ms.`
      };
      this.logger.warn("SHADOW_QUEUE_LATENCY_BREACH", "VLO matrix decision exceeded 5ms envelope", {
        decisionId: decision.decisionId,
        instrumentCode: decision.instrumentCode,
        decisionLatencyMs: decision.decisionLatencyMs,
        latencyBudgetMs: this.engineState.shadowQueue.latencyBudgetMs
      });
      this.publish(
        "SHADOW_QUEUE_LATENCY_BREACH",
        suppressed as unknown as Record<string, unknown>,
        decision.decisionId
      );
      return suppressed;
    }

    const intent = this.createShadowQueueTradeIntent(decision, book, observedAt);
    const updatedDecision = {
      ...decision,
      tradeIntentId: intent?.intentId ?? null
    };

    this.logger.traceDecision({
      decisionId: updatedDecision.decisionId,
      signalId: updatedDecision.fillId,
      traceId: `${this.engineState.engineId}:shadow-queue:${updatedDecision.fillId}`,
      agentName: "PROFILER",
      targetAgent: "EXECUTIONER",
      instrumentCode: updatedDecision.instrumentCode,
      action: updatedDecision.action === "GREEN_LIGHT" ? "EXECUTE" : "SUPERVISOR_ACTION",
      confidence: Math.min(
        1,
        Math.max(
          0,
          Math.abs(updatedDecision.microDrift) / Math.max(updatedDecision.tickThreshold, 1e-12)
        )
      ),
      expectedValue: intent?.expectedValue ?? 0,
      maxSlippageBps: intent?.maxSlippageBps ?? 0,
      reasoning: updatedDecision.reason,
      featureVector: toJsonValue({
        schemaVersion: "shadow-queue.decision.v1",
        light: updatedDecision.action,
        originalSide: updatedDecision.originalSide,
        dispatchSide: updatedDecision.dispatchSide,
        p0MidPrice: updatedDecision.p0MidPrice,
        pnMidPrice: updatedDecision.pnMidPrice,
        microDrift: updatedDecision.microDrift,
        driftTrades: updatedDecision.driftTrades,
        tradeIntentId: updatedDecision.tradeIntentId
      }) as JsonRecord,
      riskSnapshot: toJsonValue({
        quoteState: this.engineState.quoteState.status,
        inventory: this.engineState.inventory,
        cachedConfigVersion: this.cachedConfig.version
      }) as JsonRecord,
      rawSignal: updatedDecision as unknown as JsonRecord,
      latencyMs: updatedDecision.decisionLatencyMs,
      createdAt: observedAt
    });

    if (!intent) {
      this.publish(
        "SHADOW_QUEUE_SIGNAL_SUPPRESSED",
        updatedDecision as unknown as Record<string, unknown>,
        updatedDecision.decisionId
      );
      return updatedDecision;
    }

    if (updatedDecision.action === "RED_LIGHT") {
      this.publish(
        "SHADOW_QUEUE_RED_LIGHT",
        updatedDecision as unknown as Record<string, unknown>,
        updatedDecision.decisionId
      );
      if (this.cachedConfig.TRADING_ENABLED) {
        this.state.waitUntil(this.cancelAllQuotes(book.instrumentCode, "SHADOW_QUEUE_RED_LIGHT"));
      }
    } else {
      this.publish(
        "SHADOW_QUEUE_GREEN_LIGHT",
        updatedDecision as unknown as Record<string, unknown>,
        updatedDecision.decisionId
      );
    }

    if (this.cachedConfig.TRADING_ENABLED) {
      this.state.waitUntil(this.dispatchExecution(intent));
    }

    return updatedDecision;
  }

  private shouldLogShadowQueueNoEdge(instrumentCode: string): boolean {
    const now = Date.now();
    const previous = this.shadowQueueNoEdgeLogAt.get(instrumentCode) ?? 0;
    const intervalMs = readPositiveInteger(
      this.env.SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS,
      DEFAULT_SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS,
      1_000,
      300_000
    );

    if (now - previous < intervalMs) {
      return false;
    }

    this.shadowQueueNoEdgeLogAt.set(instrumentCode, now);
    return true;
  }

  private createShadowQueueTradeIntent(
    decision: ShadowQueueDecision,
    book: InternalOrderBook,
    observedAt: string
  ): TradeIntent | null {
    const action = decision.dispatchSide;

    if (!action || book.midPrice === null || book.midPrice <= 0) {
      return null;
    }

    const price = this.shadowQueuePostOnlyPrice(action, book, decision.pnMidPrice);
    const requestedSize = this.shadowQueueKellySize(action, price, book);

    if (requestedSize <= 0) {
      return null;
    }

    const expectedDriftValue = Math.abs(decision.microDrift) * requestedSize;
    const feeCost =
      (price * requestedSize * Math.max(0, this.cachedConfig.EXCHANGE_FEE_BPS)) / 10_000;
    const expectedValue = roundCrypto(expectedDriftValue - feeCost);

    return {
      schemaVersion: "trade-intent.v1",
      intentId: `vlo-intent:${decision.decisionId}`,
      traceId: `${this.engineState.engineId}:shadow-queue:${decision.fillId}`,
      instrumentCode: book.instrumentCode,
      marketKey: book.marketKey,
      source_exchange: book.source_exchange,
      direction: action === "BUY" ? "LONG" : "SHORT",
      action,
      orderType: "LIMIT",
      postOnly: true,
      timeInForce: "ALO",
      intendedPrice: price,
      expectedPrice: price,
      requestedSize,
      approvedSize: requestedSize,
      probabilityWin: decision.action === "GREEN_LIGHT" ? 0.56 : 0.53,
      probabilityLoss: decision.action === "GREEN_LIGHT" ? 0.44 : 0.47,
      profit: expectedDriftValue,
      loss: Math.max(expectedDriftValue, (book.spread ?? book.tickSize) * requestedSize),
      executionCosts: feeCost,
      adverseSelectionCost: decision.action === "RED_LIGHT" ? 0 : this.engineState.toxicityScore,
      expectedValue,
      minEvThreshold: Number.NEGATIVE_INFINITY,
      maxSlippageBps: Math.max(1, book.spreadBps ?? this.engineState.shadowQueue.baseSpreadBps),
      confidence: Math.min(
        1,
        Math.max(0.01, Math.abs(decision.microDrift) / Math.max(book.tickSize, 1e-12))
      ),
      rationale:
        decision.action === "GREEN_LIGHT"
          ? `VLO Green Light: post-fill drift confirmed ${decision.originalSide}; fractional Kelly post-only deployment.`
          : `VLO Red Light: adverse post-fill drift inverted ${decision.originalSide}; AS skew bypassed for signal inversion.`,
      createdAt: observedAt
    };
  }

  private shadowQueuePostOnlyPrice(
    action: "BUY" | "SELL",
    book: InternalOrderBook,
    pnMidPrice: number
  ): number {
    const tickSize = Math.max(book.tickSize, DEFAULT_ORDER_BOOK_TICK_SIZE);
    const baseSpread = Math.max(
      book.spread ?? 0,
      (pnMidPrice * this.engineState.shadowQueue.baseSpreadBps) / 10_000,
      tickSize
    );

    if (action === "BUY") {
      const raw = Math.max(tickSize, pnMidPrice - baseSpread);
      const bounded =
        book.bestAsk !== null ? Math.min(raw, Math.max(tickSize, book.bestAsk - tickSize)) : raw;
      return normalizePriceToTick(bounded, tickSize, "FLOOR");
    }

    const raw = pnMidPrice + baseSpread;
    const bounded = book.bestBid !== null ? Math.max(raw, book.bestBid + tickSize) : raw;
    return normalizePriceToTick(bounded, tickSize, "CEIL");
  }

  private shadowQueueKellySize(
    action: "BUY" | "SELL",
    price: number,
    book: InternalOrderBook
  ): number {
    if (!Number.isFinite(price) || price <= 0) {
      return 0;
    }

    const equity = Math.max(0, this.engineState.bankroll.equity);
    const maxPositionPct =
      this.cachedConfig.MAX_POSITION_PCT > 0
        ? this.cachedConfig.MAX_POSITION_PCT
        : readPositiveNumber(this.env.MAX_POSITION_PCT, DEFAULT_MAX_POSITION_PCT);
    const kellyFraction = Math.min(
      1,
      Math.max(
        0,
        this.cachedConfig.KELLY_FRACTION > 0
          ? this.cachedConfig.KELLY_FRACTION
          : readPositiveNumber(this.env.KELLY_FRACTION, 0.5)
      )
    );
    const inventory = this.engineState.inventory;
    const inventoryRoom =
      action === "BUY"
        ? Math.max(0, inventory.maxInventoryUnits - inventory.netDelta)
        : Math.max(0, inventory.maxInventoryUnits + inventory.netDelta);
    const levels = action === "BUY" ? book.bids : book.asks;
    const depthCap = Math.max(DEFAULT_SHADOW_VLO_MIN_SIZE, (levels[0]?.size ?? 0) * 0.02);
    const riskBudgetUsd =
      equity * maxPositionPct * kellyFraction * this.engineState.location.positionSizeMultiplier;
    const budgetSize = riskBudgetUsd > 0 ? riskBudgetUsd / price : 0;
    const bounded = Math.min(Math.max(0, budgetSize), Math.max(0, inventoryRoom), depthCap);

    return bounded > 0 ? roundCrypto(Math.max(DEFAULT_SHADOW_VLO_MIN_SIZE, bounded)) : 0;
  }

  private updateLeadLagMetrics(
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string
  ): EngineState["leadLag"] {
    if (book.midPrice === null) {
      return this.engineState.leadLag;
    }

    const samples = this.leadLagSamples.get(tick.instrumentCode) ?? [];
    samples.push({ price: book.midPrice, observedAt });
    this.leadLagSamples.set(tick.instrumentCode, samples.slice(-100));
    const instruments = [...this.leadLagSamples.keys()].sort();

    if (instruments.length < 2) {
      return {
        ...this.engineState.leadLag,
        sampleCount: samples.length,
        updatedAt: observedAt
      };
    }

    let best: {
      leadInstrument: string;
      lagInstrument: string;
      correlation: number;
      lagSteps: number;
      sampleCount: number;
      leadLagDelta: number;
      expectedValue: number;
    } | null = null;

    for (const leadInstrument of instruments) {
      for (const lagInstrument of instruments) {
        if (leadInstrument === lagInstrument) {
          continue;
        }

        const lead = this.leadLagSamples.get(leadInstrument) ?? [];
        const lag = this.leadLagSamples.get(lagInstrument) ?? [];
        const sampleCount = Math.min(lead.length, lag.length, 100);

        if (sampleCount < 10) {
          continue;
        }

        const leadPrices = lead.slice(-sampleCount).map((sample) => sample.price);
        const lagPrices = lag.slice(-sampleCount).map((sample) => sample.price);

        for (let lagSteps = 1; lagSteps <= Math.min(10, sampleCount - 2); lagSteps += 1) {
          const leadReturns = returns(leadPrices.slice(0, -lagSteps));
          const lagReturns = returns(lagPrices.slice(lagSteps));
          const correlation = pearson(leadReturns, lagReturns);

          if (correlation === null) {
            continue;
          }

          const leadMove = leadPrices.at(-1)! - leadPrices.at(-2)!;
          const lagMove = lagPrices.at(-1)! - lagPrices.at(-2)!;
          const leadLagDelta = leadMove - lagMove;
          const expectedValue = Math.abs(leadLagDelta) * Math.abs(correlation);

          if (!best || expectedValue > best.expectedValue) {
            best = {
              leadInstrument,
              lagInstrument,
              correlation,
              lagSteps,
              sampleCount,
              leadLagDelta,
              expectedValue
            };
          }
        }
      }
    }

    if (!best) {
      return {
        ...this.engineState.leadLag,
        sampleCount: samples.length,
        updatedAt: observedAt
      };
    }
    const lagMs = best.lagSteps * Math.max(1, this.engineState.averageLatency || 1);
    const spreadCost =
      (this.engineState.microstructure.spread ?? 0) +
      (this.engineState.microstructure.midPrice ?? 0) *
        (this.engineState.slippage.executionCostBufferBps / 10_000);

    return {
      schemaVersion: "lead-lag.v1",
      leadInstrument: best.leadInstrument,
      lagInstrument: best.lagInstrument,
      correlation: best.correlation,
      lagMs,
      leadLagDelta: best.leadLagDelta,
      expectedValue: best.expectedValue,
      executable: best.expectedValue > spreadCost,
      sampleCount: best.sampleCount,
      updatedAt: observedAt
    };
  }

  private calculateInventoryState(
    observedAt: string,
    positions: Record<string, Position> = this.engineState.openPositions
  ): EngineState["inventory"] {
    const netDelta = Object.values(positions).reduce(
      (sum, position) => sum + (position.side === "LONG" ? position.quantity : -position.quantity),
      0
    );
    const maxInventoryUnits =
      this.cachedConfig.MAX_INVENTORY_UNITS > 0
        ? this.cachedConfig.MAX_INVENTORY_UNITS
        : readPositiveNumber(this.env.MAX_INVENTORY_UNITS, DEFAULT_MAX_INVENTORY_UNITS);
    const maxInventoryDelta =
      this.cachedConfig.MAX_INVENTORY_DELTA > 0
        ? this.cachedConfig.MAX_INVENTORY_DELTA
        : readPositiveNumber(this.env.MAX_INVENTORY_DELTA, DEFAULT_MAX_INVENTORY_DELTA);
    const riskAversionFactor =
      this.cachedConfig.RISK_AVERSION_FACTOR > 0
        ? this.cachedConfig.RISK_AVERSION_FACTOR
        : readPositiveNumber(this.env.RISK_AVERSION_FACTOR, DEFAULT_RISK_AVERSION_FACTOR);
    const normalized = this.normalizeInventoryDelta(positions);
    const inventoryPenalty = Math.abs(normalized.current_inventory_delta) * riskAversionFactor;
    const stopBid =
      netDelta >= maxInventoryUnits ||
      (maxInventoryDelta > 0 && normalized.current_inventory_delta >= maxInventoryDelta);
    const stopAsk =
      netDelta <= -maxInventoryUnits ||
      (maxInventoryDelta > 0 && normalized.current_inventory_delta <= -maxInventoryDelta);

    return {
      netDelta,
      current_inventory_delta: normalized.current_inventory_delta,
      baseAsset: normalized.baseAsset,
      normalization: normalized.normalization,
      maxInventoryUnits,
      maxInventoryDelta,
      inventoryPenalty,
      stopBid,
      stopAsk,
      updatedAt: observedAt
    };
  }

  private normalizeInventoryDelta(
    positions: Record<string, Position>
  ): Pick<InventoryState, "current_inventory_delta" | "baseAsset" | "normalization"> {
    const baseAsset = "BTC";
    const baseReferencePrice = this.referencePriceForBaseAsset(baseAsset);
    const configuredWeights = parseDeltaNormalizationWeights(this.env.DELTA_NORMALIZATION_WEIGHTS);
    const normalization: Record<string, number> = {};
    let currentInventoryDelta = 0;

    for (const position of Object.values(positions)) {
      const signedQuantity = position.side === "LONG" ? position.quantity : -position.quantity;
      const instrumentCode = position.instrumentCode.toLowerCase();
      const markPrice = this.currentMarkPrice(instrumentCode, position.markPrice);
      const configuredWeight = configuredWeights[instrumentCode];
      const inferredWeight =
        baseReferencePrice > 0 && markPrice > 0 ? markPrice / baseReferencePrice : 1;
      const weight =
        typeof configuredWeight === "number" && Number.isFinite(configuredWeight)
          ? configuredWeight
          : inferredWeight;

      normalization[instrumentCode] = roundMetric(weight, 8);
      currentInventoryDelta += signedQuantity * weight;
    }

    return {
      current_inventory_delta: roundCrypto(currentInventoryDelta),
      baseAsset,
      normalization
    };
  }

  private referencePriceForBaseAsset(baseAsset: string): number {
    const normalizedBase = baseAsset.toLowerCase();
    const directBook = [...this.orderBook.values()].find(
      (book) => book.instrumentCode.split("-")[0] === normalizedBase && book.midPrice !== null
    );

    if (directBook?.midPrice) {
      return directBook.midPrice;
    }

    const directPosition = this.engineState.openPositions[`${normalizedBase}-usd`];
    if (directPosition?.markPrice) {
      return directPosition.markPrice;
    }

    const microMid = this.engineState.microstructure.midPrice;
    return typeof microMid === "number" && Number.isFinite(microMid) && microMid > 0 ? microMid : 1;
  }

  private updatePortfolioRisk(
    oracle: EngineState["oracle"],
    observedAt: string
  ): EngineState["riskMetrics"] {
    const equity = Math.max(this.engineState.bankroll.equity, 0);
    const priorHighWaterMark = Math.max(this.engineState.riskMetrics.highWaterMark, equity);
    const highWaterMark =
      this.engineState.mode === "PAPER" &&
      priorHighWaterMark > Math.max(equity * 1.5, equity + 1_000)
        ? equity
        : Math.max(priorHighWaterMark, equity);
    const rollingDrawdownPct =
      highWaterMark > 0 ? Math.max(0, (highWaterMark - equity) / highWaterMark) : 0;
    const notional = Object.values(this.engineState.openPositions).reduce(
      (sum, position) => sum + Math.abs(position.quantity * position.markPrice),
      0
    );
    const oneHourVolatilityScale = Math.sqrt(60);
    const var99OneHour =
      notional *
      oracle.volatility *
      oneHourVolatilityScale *
      (this.cachedConfig.VAR_CONFIDENCE_Z > 0
        ? this.cachedConfig.VAR_CONFIDENCE_Z
        : readPositiveNumber(this.env.VAR_CONFIDENCE_Z, DEFAULT_VAR_CONFIDENCE_Z));
    const drawdownBreached = rollingDrawdownPct > this.cachedConfig.MAX_DRAWDOWN_PCT;

    if (drawdownBreached && this.cachedConfig.TRADING_ENABLED) {
      this.cachedConfig = {
        ...this.cachedConfig,
        TRADING_ENABLED: false,
        updatedAt: observedAt,
        updatedBy: "risk:drawdown",
        version: `${this.cachedConfig.version}:drawdown`
      };
      this.state.waitUntil(this.configManager.writeConfig(this.cachedConfig));
      this.state.waitUntil(this.cancelAllQuotes("ALL", "MAX_DRAWDOWN_BREACH"));
      this.notifier.notify({
        priority: "CRITICAL",
        title: "Sovereign-Sigma drawdown kill switch",
        message: `Drawdown ${(rollingDrawdownPct * 100).toFixed(2)}% breached configured limit ${(this.cachedConfig.MAX_DRAWDOWN_PCT * 100).toFixed(2)}%. Trading disabled.`,
        dedupeKey: "risk:max-drawdown",
        metadata: {
          rollingDrawdownPct,
          maxDrawdownPct: this.cachedConfig.MAX_DRAWDOWN_PCT,
          highWaterMark,
          equity
        }
      });
    }

    return {
      highWaterMark,
      rollingDrawdownPct,
      var99OneHour,
      isTradingEnabled: !drawdownBreached && this.cachedConfig.TRADING_ENABLED,
      updatedAt: observedAt
    };
  }

  private calculateEnsembleState(
    intent: TradeIntent | null,
    profilerState: ProfilerState,
    oracleState: EngineState["oracle"],
    sentimentState: EngineState["sentiment"],
    anomalyStatus: EngineState["anomaly"],
    observedAt: string
  ): EngineState["ensemble"] {
    const anomalyScore = Math.max(
      anomalyStatus.status === "ANOMALY" ? 1 : 0,
      Math.min(1, Math.abs(anomalyStatus.priceZScore ?? 0) / 8),
      Math.min(1, Math.abs(anomalyStatus.volumeZScore ?? 0) / 8),
      Math.min(1, anomalyStatus.cancellationToExecutionRatio / 12)
    );
    const anomalyCircuitBreaker =
      anomalyScore >= 0.85 || profilerState.toxicityState === "CRITICAL";
    const profilerConfidence = !this.cachedConfig.PROFILER_ENABLED
      ? 0
      : profilerState.toxicityState === "CRITICAL"
        ? 0
        : profilerState.toxicityState === "TOXIC"
          ? 0.15
          : profilerState.toxicityState === "CONTESTED"
            ? 0.55
            : 0.85;
    const oracleConfidence = !this.cachedConfig.ORACLE_ENABLED
      ? 0
      : oracleState.regime === "REGIME_CRISIS"
        ? 0.25
        : oracleState.regime === "REGIME_TREND"
          ? 0.7
          : 0.62;
    const sentimentDirectionMatches =
      !intent ||
      sentimentState.bias === "NEUTRAL" ||
      (intent.direction === "LONG" && sentimentState.bias === "BULLISH") ||
      (intent.direction === "SHORT" && sentimentState.bias === "BEARISH");
    const sentimentConfidence = !this.cachedConfig.SENTIMENT_ENABLED
      ? 0
      : sentimentDirectionMatches
        ? Math.max(0.35, sentimentState.confidence)
        : Math.max(0.1, 1 - sentimentState.confidence);
    const croupierConfidence =
      this.cachedConfig.CROUPIER_ENABLED && intent
        ? Math.min(
            1,
            Math.max(
              0,
              (intent.confidence +
                Math.min(
                  1,
                  Math.max(
                    0,
                    intent.expectedValue /
                      Math.max(1, intent.executionCosts + intent.adverseSelectionCost)
                  )
                )) /
                2
            )
          )
        : 0;
    const votes: EngineState["ensemble"]["votes"] = [
      {
        agent: "ORACLE",
        confidence: roundMetric(oracleConfidence, 6),
        weight: 0.3,
        contribution: roundMetric(oracleConfidence * 0.3, 6),
        rationale: this.cachedConfig.ORACLE_ENABLED ? oracleState.regime : "DISABLED"
      },
      {
        agent: "PROFILER",
        confidence: roundMetric(profilerConfidence, 6),
        weight: 0.3,
        contribution: roundMetric(profilerConfidence * 0.3, 6),
        rationale: this.cachedConfig.PROFILER_ENABLED
          ? (profilerState.toxicityState ?? "NORMAL")
          : "DISABLED"
      },
      {
        agent: "CROUPIER",
        confidence: roundMetric(croupierConfidence, 6),
        weight: 0.25,
        contribution: roundMetric(croupierConfidence * 0.25, 6),
        rationale: this.cachedConfig.CROUPIER_ENABLED
          ? intent
            ? `EV=${roundMetric(intent.expectedValue, 8)}`
            : "NO_INTENT"
          : "DISABLED"
      },
      {
        agent: "SENTIMENT",
        confidence: roundMetric(sentimentConfidence, 6),
        weight: 0.15,
        contribution: roundMetric(sentimentConfidence * 0.15, 6),
        rationale: this.cachedConfig.SENTIMENT_ENABLED
          ? `${sentimentState.provider ?? "LEXICAL"}:${sentimentState.bias}`
          : "DISABLED"
      }
    ];
    const weightedConfidence = votes.reduce((sum, vote) => sum + vote.contribution, 0);
    const regimeMultiplier =
      oracleState.regime === "REGIME_CRISIS"
        ? 0.25
        : oracleState.regime === "REGIME_TREND"
          ? 0.8
          : 1;
    const confidence = anomalyCircuitBreaker
      ? 0
      : Math.min(1, Math.max(0, weightedConfidence * (1 - anomalyScore * 0.75)));
    const kellyMultiplier = anomalyCircuitBreaker
      ? 0
      : Math.min(1, Math.max(0, confidence * regimeMultiplier));

    return {
      schemaVersion: "ensemble.v1",
      confidence: roundMetric(confidence, 6),
      kellyMultiplier: roundMetric(kellyMultiplier, 6),
      regimeMultiplier,
      anomalyCircuitBreaker,
      votes,
      rationale: anomalyCircuitBreaker
        ? "ANOMALY_CIRCUIT_BREAKER"
        : `ENSEMBLE_WEIGHTED_CONFIDENCE:${roundMetric(confidence, 6)}`,
      updatedAt: observedAt
    };
  }

  private prepareExecutionPlan(
    intent: EngineState["lastTradeIntent"],
    observedAt: string,
    options: {
      bypassQuoteSuspension?: boolean;
      stateOverride?: EngineState;
      kellyFractionOverride?: number;
    } = {}
  ): {
    intent: NonNullable<EngineState["lastTradeIntent"]>;
    camouflage: ReturnType<typeof camouflageIntent>;
    sorPlan: ReturnType<typeof planSmartOrderRoute>;
    orders: ManagedOrder[];
  } | null {
    if (!intent) {
      return null;
    }

    const riskState = options.stateOverride ?? this.engineState;
    if (
      !options.bypassQuoteSuspension &&
      isQuoteSuspendedAt(
        quoteStateForInstrumentState(
          riskState.assetQuoteStates,
          intent.instrumentCode,
          riskState.quoteState
        ),
        observedAt
      )
    ) {
      return null;
    }
    const pitBossDecision = this.pitBossAgent.approve(
      intent,
      riskState,
      this.cachedConfig,
      this.cachedConfig.MAX_POSITION_PCT > 0
        ? this.cachedConfig.MAX_POSITION_PCT
        : readPositiveNumber(this.env.MAX_POSITION_PCT, DEFAULT_MAX_POSITION_PCT),
      options.kellyFractionOverride ?? this.cachedConfig.KELLY_FRACTION
    );

    if (!pitBossDecision.approved) {
      return null;
    }

    const camouflage = camouflageIntent(
      pitBossDecision.intent,
      pitBossDecision.intent.approvedSize ?? pitBossDecision.intent.requestedSize
    );
    const sorPlan = planSmartOrderRoute(camouflage.intent, [...this.orderBook.values()]);
    if (sorPlan.unfilledSize > 0) {
      this.logger.warn(
        "SOR_RESIDUAL_LIQUIDITY_SHORTFALL",
        "Smart router could not source full approved size",
        {
          intentId: camouflage.intent.intentId,
          instrumentCode: camouflage.intent.instrumentCode,
          approvedSize: camouflage.intent.approvedSize ?? camouflage.intent.requestedSize,
          unfilledSize: sorPlan.unfilledSize
        }
      );
    }
    const executionChildren =
      sorPlan.routes.length > 0
        ? sorPlan.routes.map((route, index) => ({
            ...camouflage.intent,
            intentId: `${camouflage.intent.intentId}:sor:${index + 1}`,
            marketKey: route.marketKey,
            source_exchange: route.source_exchange,
            intendedPrice: route.expectedPrice,
            expectedPrice: route.expectedPrice,
            requestedSize: route.size,
            approvedSize: route.size,
            rationale: `${camouflage.intent.rationale}; SOR child ${index + 1}/${sorPlan.routes.length}`
          }))
        : camouflage.icebergChunks;
    const routedCamouflage = {
      ...camouflage,
      icebergChunks: executionChildren
    };
    const ackDeadlineAt = new Date(
      Date.parse(observedAt) +
        readPositiveInteger(
          this.env.ORDER_ACK_TIMEOUT_MS,
          DEFAULT_ORDER_ACK_TIMEOUT_MS,
          100,
          60_000
        )
    ).toISOString();
    const orders = routedCamouflage.icebergChunks.map((chunk) => ({
      clientId: chunk.intentId,
      exchangeOrderId: null,
      intentId: camouflage.intent.intentId,
      instrumentCode: chunk.instrumentCode,
      side: chunk.action,
      price: chunk.expectedPrice,
      size: chunk.approvedSize ?? chunk.requestedSize,
      filledSize: 0,
      status: "PENDING" as const,
      createdAt: observedAt,
      updatedAt: observedAt,
      ackDeadlineAt
    }));

    return { intent: camouflage.intent, camouflage: routedCamouflage, sorPlan, orders };
  }

  private nextQuoteStateForInstrument(
    instrumentCode: string,
    quote: EngineState["quoteState"]["lastQuote"],
    pullAllQuotes: boolean,
    observedAt: string
  ): EngineState["quoteState"] {
    const previous = quoteStateForInstrumentState(
      this.engineState.assetQuoteStates,
      instrumentCode,
      this.engineState.quoteState
    );
    const suspendedUntil = previous.suspendedUntil;

    if (!this.cachedConfig.TRADING_ENABLED) {
      return {
        status: "SUSPENDED",
        reason: "TRADING_DISABLED",
        suspendedUntil: null,
        lastQuote: previous.lastQuote,
        updatedAt: observedAt
      };
    }

    const strategyDisabledReason = this.strategyQuoteDisabledReason();
    if (strategyDisabledReason) {
      return {
        status: "SUSPENDED",
        reason: strategyDisabledReason,
        suspendedUntil: null,
        lastQuote: previous.lastQuote,
        updatedAt: observedAt
      };
    }

    if (!isInstrumentSelectedByMoltworker(instrumentCode, this.macroBias)) {
      return {
        status: "SUSPENDED",
        reason: "MOLTWORKER_NOT_SELECTED",
        suspendedUntil: null,
        lastQuote: previous.lastQuote,
        updatedAt: observedAt
      };
    }

    if (pullAllQuotes) {
      return {
        status: "SUSPENDED",
        reason: "ADVERSE_SELECTION_CRITICAL",
        suspendedUntil: new Date(
          Date.parse(observedAt) + this.resolveQuoteHibernateMs()
        ).toISOString(),
        lastQuote: previous.lastQuote,
        updatedAt: observedAt
      };
    }

    if (suspendedUntil && Date.parse(suspendedUntil) > Date.parse(observedAt)) {
      return previous;
    }

    return {
      status: "ACTIVE",
      reason: null,
      suspendedUntil: null,
      lastQuote: quote ?? previous.lastQuote,
      updatedAt: observedAt
    };
  }

  private strategyQuoteDisabledReason(): string | null {
    if (!this.cachedConfig.CROUPIER_ENABLED) {
      return "CROUPIER_DISABLED";
    }

    if (this.cachedConfig.MARKET_MAKING_MODE === "OFF") {
      return "MARKET_MAKING_OFF";
    }

    if (!this.cachedConfig.PIT_BOSS_ENABLED) {
      return "PIT_BOSS_DISABLED";
    }

    return null;
  }

  private canDispatchStrategyOrders(): boolean {
    return this.strategyQuoteDisabledReason() === null;
  }

  private resolveQuoteHibernateMs(): number {
    return this.cachedConfig.QUOTE_HIBERNATE_MS > 0
      ? this.cachedConfig.QUOTE_HIBERNATE_MS
      : readPositiveInteger(this.env.QUOTE_HIBERNATE_MS, DEFAULT_QUOTE_HIBERNATE_MS, 100, 60_000);
  }

  private maybeResumeQuotes(observedAt: string): void {
    const nextAssetQuoteStates = resumeExpiredAssetQuoteStates(
      this.engineState.assetQuoteStates,
      observedAt
    );
    const nextAggregate = aggregateQuoteState(
      nextAssetQuoteStates,
      this.engineState.quoteState,
      observedAt
    );
    const suspendedUntil = this.engineState.quoteState.suspendedUntil;
    const assetStatesChanged = TARGET_ASSET_MATRIX.some((asset) => {
      const previous = this.engineState.assetQuoteStates[asset.instrumentCode];
      const next = nextAssetQuoteStates[asset.instrumentCode];
      return (
        previous?.status !== next?.status ||
        previous?.reason !== next?.reason ||
        previous?.suspendedUntil !== next?.suspendedUntil
      );
    });

    if (
      assetStatesChanged ||
      nextAggregate.status !== this.engineState.quoteState.status ||
      nextAggregate.reason !== this.engineState.quoteState.reason ||
      (this.engineState.quoteState.status === "SUSPENDED" &&
        suspendedUntil &&
        Date.parse(suspendedUntil) <= Date.parse(observedAt))
    ) {
      this.engineState = {
        ...this.engineState,
        quoteState: nextAggregate,
        assetQuoteStates: nextAssetQuoteStates
      };
      this.publish("RESUME_QUOTES", { observedAt });
    }
  }

  private maybeCancelLaggingHypeQuotes(
    tick: MarketTick,
    volatility: MultiScaleVolatilitySnapshot | null,
    observedAt: string,
    options: TickHandlingOptions
  ): void {
    if (
      options.shadowReplay ||
      !this.cachedConfig.TRADING_ENABLED ||
      tick.instrumentCode !== "btc-usd" ||
      !volatility ||
      volatility.midPrice <= 0
    ) {
      return;
    }

    const moveBps = Math.abs(volatility.ret) * 10_000;
    const leadThresholdBps = readPositiveNumber(
      this.env.CROSS_ASSET_CANCEL_LEAD_BPS,
      DEFAULT_CROSS_ASSET_CANCEL_LEAD_BPS
    );

    if (moveBps < leadThresholdBps && !volatility.jumpDetected) {
      return;
    }

    const cooldownMs = readPositiveInteger(
      this.env.CROSS_ASSET_CANCEL_COOLDOWN_MS,
      DEFAULT_CROSS_ASSET_CANCEL_COOLDOWN_MS,
      100,
      60_000
    );
    const last = this.crossAssetCancelLogAt.get("hype-usd") ?? 0;
    const now = Date.parse(observedAt);
    const nowMs = Number.isFinite(now) ? now : Date.now();

    if (nowMs - last < cooldownMs) {
      return;
    }

    this.crossAssetCancelLogAt.set("hype-usd", nowMs);
    this.logger.warn("CROSS_ASSET_HYPE_CANCEL", "BTC lead move invalidated HYPE resting quotes", {
      leadInstrument: "btc-usd",
      lagInstrument: "hype-usd",
      moveBps: roundMetric(moveBps, 4),
      thresholdBps: leadThresholdBps,
      jumpDetected: volatility.jumpDetected,
      jumpZScore: roundMetric(volatility.jumpZScore, 4)
    });
    this.publish("SUSPEND_QUOTES", {
      instrumentCode: "hype-usd",
      reason: "BTC_LEAD_MOVE",
      moveBps,
      jumpDetected: volatility.jumpDetected,
      observedAt
    });
    this.state.waitUntil(this.cancelAllQuotes("hype-usd", "BTC_LEAD_MOVE"));
  }

  private async dispatchQuote(
    quote: NonNullable<EngineState["quoteState"]["lastQuote"]>
  ): Promise<void> {
    if (!this.env.EXECUTIONER || !this.cachedConfig.TRADING_ENABLED) {
      return;
    }

    const assetRuntimeState = this.engineState.assetMatrix?.[quote.instrumentCode];
    if (
      !isInstrumentSelectedByMoltworker(quote.instrumentCode, this.macroBias) ||
      assetRuntimeState?.quoteEligible === false
    ) {
      this.logger.info("QUOTE_DISPATCH_BLOCKED", "Skipped quote for inactive Moltworker asset", {
        quoteSignalId: quote.signalId,
        instrumentCode: quote.instrumentCode,
        selectedByMoltworker: assetRuntimeState?.selectedByMoltworker ?? null,
        quoteEligible: assetRuntimeState?.quoteEligible ?? null,
        reason: assetRuntimeState?.quoteReason ?? "MOLTWORKER_NOT_SELECTED"
      });
      return;
    }

    if (
      isQuoteSuspendedAt(
        quoteStateForInstrumentState(
          this.engineState.assetQuoteStates,
          quote.instrumentCode,
          this.engineState.quoteState
        ),
        quote.createdAt
      ) ||
      this.shouldThrottleQuoteDispatch(quote)
    ) {
      return;
    }

    const intents: TradeIntent[] = [];
    const bankroll = Math.max(0, this.engineState.bankroll.equity, this.engineState.bankroll.cash);
    const maxPositionPct =
      this.cachedConfig.MAX_POSITION_PCT > 0
        ? this.cachedConfig.MAX_POSITION_PCT
        : readPositiveNumber(this.env.MAX_POSITION_PCT, DEFAULT_MAX_POSITION_PCT);
    const assetAllocation =
      this.engineState.assetMatrix?.[quote.instrumentCode]?.capitalAllocationPct ?? 1;
    const maxBudgetFromPct =
      bankroll *
      Math.max(0, maxPositionPct) *
      Math.min(1, Math.max(0, assetAllocation)) *
      Math.max(0, this.engineState.location.positionSizeMultiplier);
    const maxBudgetFromConfig =
      this.cachedConfig.MAX_POSITION_SIZE > 0
        ? this.cachedConfig.MAX_POSITION_SIZE *
          Math.max(0, this.engineState.location.positionSizeMultiplier)
        : Number.POSITIVE_INFINITY;
    const maxOrderNotional = Math.min(maxBudgetFromConfig, maxBudgetFromPct);

    for (const order of quote.orders) {
      const action = order.side === "BID" ? "BUY" : "SELL";
      const maxSize =
        Number.isFinite(maxOrderNotional) && order.price > 0
          ? maxOrderNotional / order.price
          : order.size;
      const approvedSize = roundCrypto(Math.min(order.size, Math.max(0, maxSize)));

      if (approvedSize <= 0) {
        this.logger.warn(
          "QUOTE_ORDER_RISK_CAP_ZERO",
          "Skipped quote order with no remaining risk budget",
          {
            quoteSignalId: quote.signalId,
            instrumentCode: quote.instrumentCode,
            side: action,
            requestedSize: order.size,
            price: order.price,
            maxOrderNotional
          }
        );
        continue;
      }

      intents.push({
        schemaVersion: "trade-intent.v1",
        intentId: order.clientOrderId,
        traceId: `${this.engineState.engineId}:quote:${quote.signalId}:${order.clientOrderId}`,
        instrumentCode: quote.instrumentCode,
        marketKey: quote.marketKey,
        source_exchange:
          quote.marketKey?.split(":")[0] ?? this.engineState.microstructure.source_exchange,
        direction: action === "BUY" ? "LONG" : "SHORT",
        action,
        orderType: "LIMIT",
        postOnly: order.postOnly,
        timeInForce: "ALO",
        intendedPrice: order.price,
        expectedPrice: order.price,
        requestedSize: order.size,
        approvedSize,
        probabilityWin: 0.5,
        probabilityLoss: 0.5,
        profit: 0,
        loss: 0,
        executionCosts: 0,
        adverseSelectionCost: 0,
        expectedValue: 0,
        minEvThreshold: Number.NEGATIVE_INFINITY,
        maxSlippageBps: Math.max(1, this.engineState.microstructure.spreadBps ?? 1),
        confidence: Math.max(0, 1 - this.engineState.toxicityScore),
        rationale:
          order.strategy === "LIQUIDATION_ABSORPTION"
            ? `Post-only liquidation absorption quote from signal ${quote.signalId}; cluster ${order.clusterId ?? "unknown"}`
            : `AMM quote child order from signal ${quote.signalId}; risk-capped notional=${roundMetric(approvedSize * order.price, 8)}`,
        createdAt: quote.createdAt
      });
    }

    for (const intent of intents) {
      await this.dispatchExecution(intent);
    }

    if (intents.length > 0) {
      this.rememberDispatchedQuote(quote);
    }
  }

  private shouldThrottleQuoteDispatch(
    quote: NonNullable<EngineState["quoteState"]["lastQuote"]>
  ): boolean {
    const last = this.lastDispatchedQuoteByInstrument.get(quote.instrumentCode);

    if (!last) {
      return false;
    }

    const now = Date.parse(quote.createdAt);
    const elapsedMs = Number.isFinite(now) ? now - last.updatedAtMs : Date.now() - last.updatedAtMs;
    const minIntervalMs = readPositiveInteger(
      this.env.QUOTE_REFRESH_MIN_INTERVAL_MS,
      DEFAULT_QUOTE_REFRESH_MIN_INTERVAL_MS,
      0,
      60_000
    );

    const minPriceTicks = readPositiveInteger(
      this.env.QUOTE_REFRESH_MIN_PRICE_TICKS,
      DEFAULT_QUOTE_REFRESH_MIN_PRICE_TICKS,
      0,
      100
    );
    const book = this.findBestAssetBook(quote.instrumentCode);
    const tickSize = book?.tickSize ?? DEFAULT_ORDER_BOOK_TICK_SIZE;
    const advice = this.queuePositionModel.adviseRefresh({
      previousQuote: last,
      quote,
      book: book ?? null,
      minPriceTicks,
      elapsedMs,
      tickSize
    });

    if (advice.shouldRefresh) {
      return false;
    }

    const logKey = quote.instrumentCode;
    const logAt = this.quoteRefreshThrottleLogAt.get(logKey) ?? 0;
    const nowMs = Date.now();
    if (nowMs - logAt >= HOT_PATH_LOG_THROTTLE_MS) {
      this.quoteRefreshThrottleLogAt.set(logKey, nowMs);
      this.logger.info(
        "QUOTE_REFRESH_THROTTLED",
        "Skipped quote refresh inside minimum cadence window",
        {
          instrumentCode: quote.instrumentCode,
          elapsedMs,
          minIntervalMs,
          minPriceTicks,
          signalId: quote.signalId,
          queuePressure: roundMetric(advice.queuePressure, 4),
          queueReason: advice.reason
        }
      );
    }

    return true;
  }

  private rememberDispatchedQuote(
    quote: NonNullable<EngineState["quoteState"]["lastQuote"]>
  ): void {
    const observedAtMs = Date.parse(quote.createdAt);
    this.lastDispatchedQuoteByInstrument.set(quote.instrumentCode, {
      bid: quote.orders.find((order) => order.side === "BID")?.price ?? null,
      ask: quote.orders.find((order) => order.side === "ASK")?.price ?? null,
      updatedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : Date.now()
    });
  }

  private createInventoryHedgeIntent(
    book: InternalOrderBook,
    inventory: InventoryState,
    observedAt: string
  ): TradeIntent | null {
    if (!this.cachedConfig.HEDGE_ENABLED || !book.midPrice || book.midPrice <= 0) {
      return null;
    }

    const maxDelta = Math.max(
      inventory.maxInventoryDelta,
      this.cachedConfig.MAX_INVENTORY_DELTA,
      0
    );
    if (maxDelta <= 0) {
      return null;
    }

    const currentDelta = inventory.current_inventory_delta;
    const triggerDelta = maxDelta * this.cachedConfig.HEDGE_TRIGGER_INVENTORY_PCT;
    if (Math.abs(currentDelta) < triggerDelta) {
      return null;
    }

    const nowMs = Date.parse(observedAt);
    const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const lastHedgeAt = this.lastHedgeDispatchedAt.get(book.instrumentCode) ?? 0;
    if (safeNowMs - lastHedgeAt < this.cachedConfig.HEDGE_COOLDOWN_MS) {
      return null;
    }

    const action: TradeIntent["action"] = currentDelta > 0 ? "SELL" : "BUY";
    const touch = action === "SELL" ? book.bestBid : book.bestAsk;
    if (!touch || touch <= 0) {
      return null;
    }

    const targetResidual = maxDelta * 0.4 * Math.sign(currentDelta);
    const hedgeSize = roundCrypto(
      Math.min(Math.abs(currentDelta - targetResidual), Math.abs(currentDelta))
    );
    if (hedgeSize <= 0) {
      return null;
    }

    const slippage = Math.max(0, this.cachedConfig.HEDGE_MAX_SLIPPAGE_BPS) / 10_000;
    const rawPrice = action === "BUY" ? touch * (1 + slippage) : touch * (1 - slippage);
    const expectedPrice = normalizePriceToTick(
      Math.max(book.tickSize, rawPrice),
      Math.max(book.tickSize, DEFAULT_ORDER_BOOK_TICK_SIZE),
      action === "BUY" ? "CEIL" : "FLOOR"
    );
    this.lastHedgeDispatchedAt.set(book.instrumentCode, safeNowMs);

    return {
      schemaVersion: "trade-intent.v1",
      intentId: `inventory-hedge:${book.instrumentCode}:${safeNowMs}`,
      traceId: `${this.engineState.engineId}:inventory-hedge:${book.instrumentCode}:${safeNowMs}`,
      instrumentCode: book.instrumentCode,
      marketKey: book.marketKey,
      source_exchange: book.source_exchange,
      direction: action === "BUY" ? "LONG" : "SHORT",
      action,
      orderType: "IOC",
      postOnly: false,
      timeInForce: "IOC",
      intendedPrice: expectedPrice,
      expectedPrice,
      requestedSize: hedgeSize,
      approvedSize: hedgeSize,
      probabilityWin: 0.5,
      probabilityLoss: 0.5,
      profit: 0,
      loss: (book.midPrice * hedgeSize * this.cachedConfig.HEDGE_MAX_SLIPPAGE_BPS) / 10_000,
      executionCosts:
        (book.midPrice *
          hedgeSize *
          (this.cachedConfig.EXCHANGE_FEE_BPS + this.cachedConfig.HEDGE_MAX_SLIPPAGE_BPS)) /
        10_000,
      adverseSelectionCost: 0,
      expectedValue: 0,
      minEvThreshold: Number.NEGATIVE_INFINITY,
      maxSlippageBps: this.cachedConfig.HEDGE_MAX_SLIPPAGE_BPS,
      confidence: Math.min(1, Math.abs(currentDelta) / maxDelta),
      rationale:
        `INVENTORY_HEDGE reduce-only IOC limit; currentDelta=${roundMetric(currentDelta, 8)} ` +
        `maxDelta=${roundMetric(maxDelta, 8)} triggerPct=${roundMetric(this.cachedConfig.HEDGE_TRIGGER_INVENTORY_PCT, 4)}`,
      createdAt: observedAt
    };
  }

  private async dispatchExecution(
    intent: NonNullable<EngineState["lastTradeIntent"]>,
    initialDelayMs = 0
  ): Promise<void> {
    const inventoryHedge = isInventoryHedgeIntent(intent);

    if (
      !this.env.EXECUTIONER ||
      (!this.cachedConfig.TRADING_ENABLED && !(inventoryHedge && this.cachedConfig.HEDGE_ENABLED))
    ) {
      return;
    }

    if (
      !inventoryHedge &&
      !isInstrumentSelectedByMoltworker(intent.instrumentCode, this.macroBias)
    ) {
      this.logger.info(
        "EXECUTION_DISPATCH_BLOCKED",
        "Skipped execution intent for inactive Moltworker asset",
        {
          intentId: intent.intentId,
          instrumentCode: intent.instrumentCode,
          action: intent.action,
          orderType: intent.orderType,
          selectedInstruments: [...selectedMoltworkerInstruments(this.macroBias)]
        }
      );
      return;
    }

    if ((intent.orderType !== "LIMIT" || intent.postOnly !== true) && !inventoryHedge) {
      this.logger.warn(
        "TAKER_EXECUTION_SUPPRESSED",
        "Non-post-only execution suppressed by passive inventory protocol",
        {
          intentId: intent.intentId,
          instrumentCode: intent.instrumentCode,
          orderType: intent.orderType,
          postOnly: intent.postOnly,
          timeInForce: intent.timeInForce,
          rationale: intent.rationale
        }
      );
      return;
    }

    if (!this.reservePaperExecutionBudget(intent)) {
      return;
    }

    if (initialDelayMs > 0) {
      await wait(initialDelayMs);
    }

    const priority = "NEW";
    const reservation = this.rateLimiter.reserve(intent.source_exchange ?? "default", priority);
    this.waitUntilStoragePut(
      RATE_LIMIT_STATE_KEY,
      this.rateLimiter.exportState(),
      "EXECUTION_RATE_LIMIT"
    );

    if (!reservation.allowed) {
      await this.enqueueExecutionIntent(intent, priority, reservation.waitMs);
      return;
    }

    try {
      await this.env.EXECUTIONER.fetch(
        new Request("https://executioner.internal/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(intent)
        })
      );
    } catch (error) {
      this.logger.error("EXECUTION_DISPATCH_FAILED", "Failed to dispatch trade intent", {
        intentId: intent.intentId,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
    }
  }

  private reservePaperExecutionBudget(intent: TradeIntent): boolean {
    if (!isShadowMode(this.env)) {
      return true;
    }

    const now = Date.now();
    const maxPerMinute = readPositiveInteger(
      this.env.PAPER_MAX_GHOST_FILLS_PER_MINUTE,
      DEFAULT_PAPER_MAX_GHOST_FILLS_PER_MINUTE,
      1,
      10_000
    );

    if (now - this.paperExecutionWindowStartedAtMs >= 60_000) {
      this.paperExecutionWindowStartedAtMs = now;
      this.paperExecutionWindowCount = 0;
      this.paperExecutionWindowDropped = 0;
    }

    if (this.paperExecutionWindowCount < maxPerMinute) {
      this.paperExecutionWindowCount += 1;
      return true;
    }

    this.paperExecutionWindowDropped += 1;

    if (now - this.paperExecutionThrottleLoggedAtMs >= 10_000) {
      this.paperExecutionThrottleLoggedAtMs = now;
      this.logger.warn("SHADOW_PAPER_CADENCE_THROTTLED", "Paper execution cadence capped", {
        intentId: intent.intentId,
        instrumentCode: intent.instrumentCode,
        maxGhostFillsPerMinute: maxPerMinute,
        windowDispatched: this.paperExecutionWindowCount,
        windowDropped: this.paperExecutionWindowDropped,
        windowStartedAt: new Date(this.paperExecutionWindowStartedAtMs).toISOString()
      });
      this.publish("SHADOW_PAPER_CADENCE_THROTTLED", {
        instrumentCode: intent.instrumentCode,
        maxGhostFillsPerMinute: maxPerMinute,
        windowDispatched: this.paperExecutionWindowCount,
        windowDropped: this.paperExecutionWindowDropped
      });
    }

    return false;
  }

  private async enqueueExecutionIntent(
    intent: TradeIntent,
    priority: QueuedExecutionIntent["priority"],
    waitMs: number
  ): Promise<void> {
    const queue = await this.readExecutionQueue("EXECUTION_QUEUE_ENQUEUE_READ");
    const runAfterMs = Date.now() + Math.max(0, waitMs);
    const nextQueue = [
      ...queue,
      {
        intent,
        priority,
        runAfterMs,
        enqueuedAt: new Date().toISOString()
      }
    ]
      .sort(compareQueuedExecutionIntent)
      .slice(0, 1_000);

    await this.safeStoragePut(EXECUTION_QUEUE_KEY, nextQueue, "EXECUTION_QUEUE_ENQUEUE");
    await this.safeSetAlarm(
      Math.min(runAfterMs, Date.now() + CONFIG_ALARM_INTERVAL_MS),
      "EXECUTION_QUEUE_ALARM"
    );
    const now = Date.now();
    if (now - this.rateLimitDeferralLogAt >= HOT_PATH_LOG_THROTTLE_MS) {
      this.rateLimitDeferralLogAt = now;
      this.logger.warn(
        "EXECUTION_DEFERRED_BY_RATE_LIMIT",
        "Execution intent deferred by durable rate limiter",
        {
          intentId: intent.intentId,
          priority,
          waitMs,
          queuedCount: nextQueue.length
        }
      );
    }
  }

  private async readExecutionQueue(reason: string): Promise<QueuedExecutionIntent[]> {
    try {
      return (await this.state.storage.get<QueuedExecutionIntent[]>(EXECUTION_QUEUE_KEY)) ?? [];
    } catch (error) {
      this.handleStorageWriteFailure(reason, error);
      return [];
    }
  }

  private async drainExecutionQueue(): Promise<void> {
    const queue = await this.readExecutionQueue("EXECUTION_QUEUE_DRAIN_READ");

    if (queue.length === 0) {
      return;
    }

    const now = Date.now();
    const due = queue.filter((item) => item.runAfterMs <= now).sort(compareQueuedExecutionIntent);
    const pending = queue
      .filter((item) => item.runAfterMs > now)
      .sort(compareQueuedExecutionIntent);

    await this.safeStoragePut(EXECUTION_QUEUE_KEY, pending, "EXECUTION_QUEUE_DRAIN");

    for (const item of due) {
      await this.dispatchExecution(item.intent);
    }

    const nextWake = pending[0]?.runAfterMs;
    if (nextWake) {
      await this.safeSetAlarm(
        Math.min(nextWake, Date.now() + CONFIG_ALARM_INTERVAL_MS),
        "EXECUTION_QUEUE_NEXT_WAKE"
      );
    }
  }

  private async cancelAllQuotes(instrumentCode: string, reason: string): Promise<void> {
    if (!this.env.EXECUTIONER) {
      return;
    }

    const dispatchKey = `${instrumentCode}:${reason}`;
    const now = Date.now();
    const previousDispatchAt = this.cancelAllLogAt.get(dispatchKey) ?? 0;
    if (now - previousDispatchAt < HOT_PATH_LOG_THROTTLE_MS) {
      return;
    }
    this.cancelAllLogAt.set(dispatchKey, now);

    const reservation = this.rateLimiter.reserve("default", "CANCEL");
    this.state.waitUntil(
      this.safeStoragePut(
        RATE_LIMIT_STATE_KEY,
        this.rateLimiter.exportState(),
        "EXECUTION_RATE_LIMIT_DRAIN"
      )
    );

    if (!reservation.allowed) {
      await wait(reservation.waitMs);
    }

    try {
      await this.env.EXECUTIONER.fetch(
        new Request("https://executioner.internal/cancel-all", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ instrumentCode, reason })
        })
      );
      this.logger.warn("QUOTE_CANCEL_ALL_DISPATCHED", "Executioner cancel-all requested", {
        instrumentCode,
        reason
      });
    } catch (error) {
      this.logger.error("QUOTE_CANCEL_ALL_FAILED", "Failed to dispatch cancel-all", {
        instrumentCode,
        reason,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
    }
  }

  private async applyExecutionReport(report: ExecutionReport): Promise<void> {
    const accounting = applyExecutionAccounting({
      state: this.engineState,
      report,
      markPrice: (instrumentCode, fallback) => this.currentMarkPrice(instrumentCode, fallback)
    });
    const inventory = this.calculateInventoryState(accounting.observedAt, accounting.openPositions);
    this.adverseSelectionModel.observeExecutionReport(
      report,
      accounting.order,
      this.currentMarkPrice(accounting.order.instrumentCode, accounting.order.price),
      this.engineState.oracle.regime
    );

    this.logger.recordExecutionQuality({
      clientId: report.clientId,
      instrumentCode: accounting.order.instrumentCode,
      expectedPrice: accounting.slippagePoint.expectedPrice,
      achievedPrice: accounting.slippagePoint.achievedPrice,
      slippageBps: accounting.slippagePoint.slippageBps,
      implementationShortfall: accounting.slippagePoint.implementationShortfall,
      latencyMs: accounting.slippagePoint.latencyMs,
      fees: report.fees ?? 0,
      observedAt: report.observedAt
    });

    this.engineState = {
      ...this.engineState,
      bankroll: accounting.bankroll,
      openPositions: accounting.openPositions,
      inventory,
      current_inventory_delta: inventory.current_inventory_delta,
      orderMap: accounting.orderMap,
      slippage: accounting.slippage,
      updatedAt: accounting.observedAt,
      heartbeatAt: accounting.observedAt
    };

    await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "EXECUTION_REPORT");
    this.logger.recordExecution(accounting.tradeExecution);
    this.publish(
      "TRADE_EXECUTION_UPDATE",
      accounting.tradeExecution as unknown as Record<string, unknown>,
      accounting.tradeExecution.tradeId
    );
  }

  private executionReportToTrade(
    report: ExecutionReport,
    order: ManagedOrder,
    slippagePoint: ReturnType<TradingEngine["recordSlippage"]>,
    resultingPnl: number,
    observedAt: string
  ): TradeExecution {
    const matchedIntent =
      this.engineState.lastTradeIntent &&
      (this.engineState.lastTradeIntent.intentId === order.intentId ||
        report.clientId.startsWith(`${this.engineState.lastTradeIntent.intentId}:`))
        ? this.engineState.lastTradeIntent
        : null;
    const status = mapManagedStatusToTradeStatus(report.status);
    const price = positiveNumber(
      report.achievedPrice ?? report.expectedPrice ?? order.price,
      this.currentMarkPrice(order.instrumentCode, order.price)
    );
    const size = positiveNumber(
      executionReportSize(report, order, status),
      order.size > 0 ? order.size : 0.00000001
    );
    const primaryDriver = inferExecutionPrimaryDriver(matchedIntent, order);

    return {
      tradeId: executionTradeId(report, status, observedAt),
      orderId: report.clientId,
      venue:
        matchedIntent?.source_exchange ??
        this.engineState.microstructure.source_exchange ??
        "unknown",
      asset: order.instrumentCode,
      side: report.side ?? order.side,
      orderType: matchedIntent?.orderType ?? "LIMIT",
      price,
      size,
      evAtExecution: matchedIntent?.expectedValue ?? 0,
      slippageBps: slippagePoint.slippageBps,
      resultingPnl:
        status === "FILLED" || status === "PARTIAL" || status === "GHOST_FILL" ? resultingPnl : 0,
      primaryDriver,
      fees: report.fees ?? 0,
      status,
      exchangeTradeId: report.exchangeOrderId,
      metadata: toJsonValue({
        report,
        order,
        fillIncrementSize: report.fillIncrementSize ?? null,
        cumulativeFilledSize: report.filledSize ?? order.filledSize,
        reason: report.reason ?? null,
        rawStatus: report.rawStatus ?? null,
        implementationShortfall: slippagePoint.implementationShortfall,
        latencyMs: slippagePoint.latencyMs
      }) as JsonRecord,
      executedAt: observedAt
    };
  }

  private applyFillToPortfolio(
    order: ManagedOrder,
    fillSize: number,
    fillPrice: number,
    fees: number,
    observedAt: string
  ): Pick<EngineState, "bankroll" | "openPositions"> {
    if (
      !Number.isFinite(fillSize) ||
      fillSize <= 0 ||
      !Number.isFinite(fillPrice) ||
      fillPrice <= 0
    ) {
      return {
        bankroll: this.engineState.bankroll,
        openPositions: this.engineState.openPositions
      };
    }

    const positions = { ...this.engineState.openPositions };
    const existing = positions[order.instrumentCode];
    const existingSigned = existing
      ? existing.side === "LONG"
        ? existing.quantity
        : -existing.quantity
      : 0;
    const fillSigned = order.side === "BUY" ? fillSize : -fillSize;
    const nextSigned = roundCrypto(existingSigned + fillSigned);
    const oldAverage = existing?.averageEntryPrice ?? fillPrice;
    const closingSize =
      existingSigned !== 0 && Math.sign(existingSigned) !== Math.sign(fillSigned)
        ? Math.min(Math.abs(existingSigned), Math.abs(fillSigned))
        : 0;
    const realizedFromClose =
      closingSize > 0 ? (fillPrice - oldAverage) * closingSize * (existingSigned > 0 ? 1 : -1) : 0;
    const realizedPnl = roundCrypto((existing?.realizedPnl ?? 0) + realizedFromClose - fees);
    const markPrice = this.currentMarkPrice(order.instrumentCode, fillPrice);

    if (Math.abs(nextSigned) <= 0.00000001) {
      delete positions[order.instrumentCode];
    } else {
      const sameDirection =
        existingSigned === 0 || Math.sign(existingSigned) === Math.sign(fillSigned);
      const averageEntryPrice = sameDirection
        ? roundCrypto(
            (Math.abs(existingSigned) * oldAverage + Math.abs(fillSigned) * fillPrice) /
              Math.max(0.00000001, Math.abs(existingSigned) + Math.abs(fillSigned))
          )
        : Math.sign(nextSigned) === Math.sign(existingSigned)
          ? oldAverage
          : fillPrice;

      positions[order.instrumentCode] = {
        instrumentCode: order.instrumentCode,
        side: nextSigned > 0 ? "LONG" : "SHORT",
        quantity: Math.abs(nextSigned),
        averageEntryPrice,
        markPrice,
        unrealizedPnl: roundCrypto(
          (markPrice - averageEntryPrice) * Math.abs(nextSigned) * (nextSigned > 0 ? 1 : -1)
        ),
        realizedPnl,
        updatedAt: observedAt
      };
    }

    const cashDelta =
      order.side === "BUY" ? -(fillPrice * fillSize + fees) : fillPrice * fillSize - fees;
    const cash = roundCrypto(this.engineState.bankroll.cash + cashDelta);
    const bankroll = this.markBankrollToMarket(
      cash,
      roundCrypto(this.engineState.bankroll.realizedPnl + realizedFromClose - fees),
      positions,
      observedAt
    );

    return { bankroll, openPositions: positions };
  }

  private currentMarkPrice(instrumentCode: string, fallback: number): number {
    const selected = this.selectMarketKey(instrumentCode);
    const mark = selected ? this.orderBook.get(selected.marketKey)?.midPrice : null;
    return typeof mark === "number" && Number.isFinite(mark) && mark > 0 ? mark : fallback;
  }

  private markBankrollToMarket(
    cash: number,
    realizedPnl: number,
    positions: Record<string, Position>,
    observedAt: string
  ): EngineState["bankroll"] {
    const positionValue = Object.values(positions).reduce((sum, position) => {
      const markPrice = this.currentMarkPrice(position.instrumentCode, position.markPrice);
      return sum + (position.side === "LONG" ? 1 : -1) * position.quantity * markPrice;
    }, 0);

    return {
      ...this.engineState.bankroll,
      cash: roundCrypto(cash),
      equity: roundCrypto(cash + positionValue),
      realizedPnl: roundCrypto(realizedPnl),
      updatedAt: observedAt
    };
  }

  private recordSlippage(report: ExecutionReport, order: ManagedOrder) {
    const expectedPrice = report.expectedPrice ?? order.price;
    const achievedPrice = report.achievedPrice ?? expectedPrice;
    const sideMultiplier = order.side === "BUY" ? 1 : -1;
    const slippageBps =
      expectedPrice > 0
        ? ((achievedPrice - expectedPrice) / expectedPrice) * 10_000 * sideMultiplier
        : 0;
    const fees = report.fees ?? 0;
    const implementationShortfall =
      Math.abs(achievedPrice - expectedPrice) * Math.max(order.filledSize, order.size) + fees;
    const point = {
      expectedPrice,
      achievedPrice,
      slippageBps,
      implementationShortfall,
      latencyMs: report.latencyMs ?? 0,
      observedAt: report.observedAt
    };

    this.logger.recordExecutionQuality({
      clientId: report.clientId,
      instrumentCode: order.instrumentCode,
      expectedPrice,
      achievedPrice,
      slippageBps,
      implementationShortfall,
      latencyMs: point.latencyMs,
      fees,
      observedAt: report.observedAt
    });

    return point;
  }

  private async runJanitor(source: "ALARM" | "ADMIN" = "ALARM"): Promise<void> {
    const observedAt = new Date().toISOString();
    const baseReport = this.janitorAgent.run({
      orderMap: this.engineState.orderMap,
      positions: this.engineState.openPositions,
      observedAt,
      ackTimeoutMs: readPositiveInteger(
        this.env.ORDER_ACK_TIMEOUT_MS,
        DEFAULT_ORDER_ACK_TIMEOUT_MS,
        100,
        60_000
      ),
      dustThreshold: 0.000001
    });
    const exchangeOpenOrders = await this.fetchExchangeOpenOrders();
    const exchangeByClientId = new Map(
      exchangeOpenOrders
        .filter((order) => order.clientId)
        .map((order) => [order.clientId as string, order])
    );
    const exchangeIds = new Set(exchangeOpenOrders.map((order) => order.exchangeOrderId));
    const reconciledOrders: string[] = [];
    const orphanExchangeOrders: string[] = [];
    const cancelledOrders: string[] = [];
    const nextOrderMap = { ...this.engineState.orderMap };

    for (const [clientId, localOrder] of Object.entries(nextOrderMap)) {
      const remote = exchangeByClientId.get(clientId);

      if (remote) {
        nextOrderMap[clientId] = {
          ...localOrder,
          exchangeOrderId: remote.exchangeOrderId,
          filledSize: remote.filledSize,
          status: remote.status,
          updatedAt: observedAt
        };
        reconciledOrders.push(clientId);
        continue;
      }

      if (
        localOrder.exchangeOrderId &&
        !exchangeIds.has(localOrder.exchangeOrderId) &&
        (localOrder.status === "PENDING" || localOrder.status === "OPEN")
      ) {
        nextOrderMap[clientId] = {
          ...localOrder,
          status: "CANCELLED",
          updatedAt: observedAt
        };
        cancelledOrders.push(clientId);
      }
    }

    for (const remote of exchangeOpenOrders) {
      if (remote.clientId && nextOrderMap[remote.clientId]) {
        continue;
      }

      orphanExchangeOrders.push(remote.exchangeOrderId);
      await this.cancelOrder(
        remote.exchangeOrderId,
        "JANITOR_ORPHAN_EXCHANGE_ORDER",
        remote.instrumentCode
      );
      cancelledOrders.push(remote.exchangeOrderId);
    }

    for (const clientId of baseReport.zombieOrders) {
      await this.cancelOrder(
        clientId,
        "JANITOR_ZOMBIE_LOCAL_ORDER",
        nextOrderMap[clientId]?.instrumentCode
      );
      cancelledOrders.push(clientId);
      if (nextOrderMap[clientId]) {
        nextOrderMap[clientId] = {
          ...nextOrderMap[clientId],
          status: "CANCELLED",
          updatedAt: observedAt
        };
      }
    }

    const dustCloseIntents: string[] = [];
    for (const instrumentCode of baseReport.dustPositions) {
      const intentId = await this.closeDustPosition(instrumentCode, observedAt);
      if (intentId) {
        dustCloseIntents.push(intentId);
      }
    }

    const pruneReport = await this.pruneOperationalLogs();
    const report = {
      ...baseReport,
      orphanExchangeOrders,
      reconciledOrders,
      cancelledOrders: [...new Set(cancelledOrders)],
      dustCloseIntents,
      prunedTelemetryCount: pruneReport.totalRows
    };

    if (
      report.zombieOrders.length > 0 ||
      report.orphanExchangeOrders.length > 0 ||
      report.dustPositions.length > 0 ||
      report.prunedTelemetryCount > 0
    ) {
      this.logger.warn("JANITOR_CLEANUP_REQUIRED", "Janitor found state hygiene work", {
        source,
        zombieOrders: report.zombieOrders,
        orphanExchangeOrders: report.orphanExchangeOrders,
        cancelledOrders: report.cancelledOrders,
        dustPositions: report.dustPositions,
        dustCloseIntents: report.dustCloseIntents,
        prunedTelemetryCount: report.prunedTelemetryCount,
        pruneReport: logPruneReportToJson(pruneReport)
      });
    }

    this.engineState = {
      ...this.engineState,
      orderMap: nextOrderMap,
      janitor: report,
      updatedAt: observedAt,
      heartbeatAt: observedAt
    };
    await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "JANITOR_REPORT");
  }

  private async fetchExchangeOpenOrders(): Promise<ExchangeOpenOrder[]> {
    if (!this.env.EXECUTIONER) {
      return [];
    }

    try {
      const response = await this.env.EXECUTIONER.fetch(
        new Request("https://executioner.internal/open-orders")
      );

      if (!response.ok) {
        return [];
      }

      const payload = await response.json<{ orders?: ExchangeOpenOrder[] }>();
      return Array.isArray(payload.orders) ? payload.orders : [];
    } catch (error) {
      this.logger.error("JANITOR_OPEN_ORDERS_FAILED", "Failed to fetch exchange open orders", {
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
      return [];
    }
  }

  private async cancelOrder(
    orderId: string,
    reason: string,
    instrumentCode?: string
  ): Promise<void> {
    if (!this.env.EXECUTIONER) {
      return;
    }

    const reservation = this.rateLimiter.reserve("default", "CANCEL");
    this.waitUntilStoragePut(
      RATE_LIMIT_STATE_KEY,
      this.rateLimiter.exportState(),
      "JANITOR_CANCEL_RATE_LIMIT"
    );

    if (!reservation.allowed) {
      await wait(reservation.waitMs);
    }

    try {
      await this.env.EXECUTIONER.fetch(
        new Request("https://executioner.internal/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderId, instrumentCode, reason })
        })
      );
    } catch (error) {
      this.logger.error("JANITOR_CANCEL_FAILED", "Failed to cancel order during janitor run", {
        orderId,
        instrumentCode: instrumentCode ?? null,
        reason,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
    }
  }

  private async closeDustPosition(
    instrumentCode: string,
    observedAt: string
  ): Promise<string | null> {
    const position = this.engineState.openPositions[instrumentCode];

    if (!position) {
      return null;
    }

    this.logger.warn(
      "JANITOR_DUST_CLOSE_SKIPPED",
      "Dust closeout skipped because taker execution is disabled",
      {
        instrumentCode,
        side: position.side,
        quantity: position.quantity,
        observedAt,
        inventoryProtocol: "POST_ONLY_SKEW"
      }
    );
    return null;
  }

  private async pruneOperationalLogs(): Promise<LogPruneReport> {
    const policy = resolveLogRetentionPolicy(this.env);
    const placeholders = operationalEventPlaceholders();
    const emptyReport: LogPruneReport = {
      policy,
      telemetryRows: 0,
      lowValueOperationalRows: 0,
      cappedOperationalInfoRows: 0,
      marketTickRows: 0,
      totalRows: 0
    };

    try {
      const retentionResult = await this.env.TRADING_DB.prepare(
        `DELETE FROM logs
         WHERE event_type = 'TELEMETRY'
           AND created_at < ?`
      )
        .bind(policy.telemetryCutoff)
        .run();
      const capResult = await this.env.TRADING_DB.prepare(
        `DELETE FROM logs
         WHERE event_type = 'TELEMETRY'
           AND id NOT IN (
             SELECT id
             FROM logs
             WHERE event_type = 'TELEMETRY'
             ORDER BY created_at DESC, id DESC
             LIMIT ?
           )`
      )
        .bind(policy.maxTelemetryRows)
        .run();
      const lowValueResult = await this.env.TRADING_DB.prepare(
        `DELETE FROM logs
         WHERE created_at < ?
           AND level IN ('DEBUG', 'INFO')
           AND (
             event_type IN (${placeholders})
             OR event_type LIKE '%HEARTBEAT%'
             OR event_type LIKE '%TELEMETRY%'
             OR event_type LIKE 'STREAM_%'
             OR event_type LIKE 'INGEST_%'
           )`
      )
        .bind(policy.lowValueCutoff, ...LOW_VALUE_OPERATIONAL_EVENT_TYPES)
        .run();
      const infoCapResult = await this.env.TRADING_DB.prepare(
        `DELETE FROM logs
         WHERE level IN ('DEBUG', 'INFO')
           AND id NOT IN (
             SELECT id
             FROM logs
             WHERE level IN ('DEBUG', 'INFO')
             ORDER BY created_at DESC, id DESC
             LIMIT ?
           )`
      )
        .bind(policy.maxOperationalInfoRows)
        .run();
      const tickRetentionResult = await this.env.TRADING_DB.prepare(
        `DELETE FROM market_ticks
         WHERE received_at < ?`
      )
        .bind(policy.marketTickCutoff)
        .run();
      const tickCapResult = await this.env.TRADING_DB.prepare(
        `DELETE FROM market_ticks
         WHERE tick_id NOT IN (
           SELECT tick_id
           FROM market_ticks
           ORDER BY received_at DESC, tick_id DESC
           LIMIT ?
         )`
      )
        .bind(policy.maxMarketTickRows)
        .run();
      const telemetryRows =
        Number(retentionResult.meta?.changes ?? 0) + Number(capResult.meta?.changes ?? 0);
      const lowValueOperationalRows = Number(lowValueResult.meta?.changes ?? 0);
      const cappedOperationalInfoRows = Number(infoCapResult.meta?.changes ?? 0);
      const marketTickRows =
        Number(tickRetentionResult.meta?.changes ?? 0) + Number(tickCapResult.meta?.changes ?? 0);
      return {
        policy,
        telemetryRows,
        lowValueOperationalRows,
        cappedOperationalInfoRows,
        marketTickRows,
        totalRows:
          telemetryRows + lowValueOperationalRows + cappedOperationalInfoRows + marketTickRows
      };
    } catch (error) {
      this.logger.error("JANITOR_LOG_PRUNE_FAILED", "Failed to prune stale operational logs", {
        policy: logRetentionPolicyToJson(policy),
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
      return emptyReport;
    }
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
    const startedAt = new Date().toISOString();
    const replayId = crypto.randomUUID();
    await this.writeReplayStatus({
      replayId,
      status: "RUNNING",
      ticksTotal: 0,
      ticksProcessed: 0,
      progressPct: 0,
      speedMultiplier,
      shadowBankroll,
      dateFrom,
      dateTo,
      scenario: replayOptions.scenario,
      error: null,
      startedAt,
      updatedAt: startedAt,
      completedAt: null
    });
    const liveSnapshot = this.captureReplaySnapshot();
    const sourceTicks = await this.replayJournal.loadTicks(limit, dateFrom, dateTo);
    const ticks = sourceTicks.map((tick, index) =>
      applyReplayScenarioToTick(tick, replayOptions.scenario, index, sourceTicks.length)
    );
    const initialShadowBankroll =
      shadowBankroll > 0
        ? shadowBankroll
        : Math.max(
            this.engineState.bankroll.equity,
            this.engineState.bankroll.cash,
            DEFAULT_PAPER_BANKROLL_USD
          );
    await this.writeReplayStatus({
      replayId,
      status: "RUNNING",
      ticksTotal: ticks.length,
      ticksProcessed: 0,
      progressPct: 0,
      speedMultiplier,
      shadowBankroll: initialShadowBankroll,
      dateFrom,
      dateTo,
      scenario: replayOptions.scenario,
      error: null,
      startedAt,
      updatedAt: new Date().toISOString(),
      completedAt: null
    });
    const historicalTrades =
      ticks.length > 0
        ? await this.replayJournal.loadTrades(ticks[0].receivedAt, ticks.at(-1)!.receivedAt)
        : [];
    const shadowTrades = markHistoricalReplayTrades(historicalTrades, ticks);
    const modeledTrades: ReplayResult["shadowTrades"] = [];
    let ticksReplayed = 0;
    let generatedIntentCount = 0;

    this.cachedConfig = {
      ...this.cachedConfig,
      TRADING_ENABLED: true,
      MAX_POSITION_SIZE: this.cachedConfig.MAX_POSITION_SIZE || initialShadowBankroll,
      MAX_POSITION_PCT: this.cachedConfig.MAX_POSITION_PCT || DEFAULT_MAX_POSITION_PCT,
      MAX_INVENTORY_UNITS: this.cachedConfig.MAX_INVENTORY_UNITS || DEFAULT_MAX_INVENTORY_UNITS,
      updatedAt: startedAt,
      updatedBy: "shadow-replay",
      version: `${this.cachedConfig.version}:shadow-replay:${replayId}`
    };
    this.orderBook.clear();
    this.bids.clear();
    this.asks.clear();
    this.bookSync.clear();
    this.latencyHistory = [];
    this.processingLatencySamples = [];
    this.domWallHistory = [];
    this.leadLagSamples = new Map();
    this.engineState = {
      ...defaultEngineState(`${this.engineState.engineId}:shadow:${replayId}`),
      bankroll: {
        ...this.engineState.bankroll,
        cash: initialShadowBankroll,
        equity: initialShadowBankroll,
        realizedPnl: 0,
        updatedAt: startedAt
      },
      mode: "PAPER",
      cachedConfig: this.cachedConfig,
      heartbeatAt: startedAt,
      updatedAt: startedAt
    };
    this.resetProfilerAgents();
    this.anomalyDetector.hydrate(null);
    this.oracleAgent.hydrate(null);
    this.sentimentAgent.hydrate(null);

    try {
      let previousTick: MarketTick | null = null;

      for (const [index, tick] of ticks.entries()) {
        if (previousTick) {
          const intervalMs = Math.max(
            0,
            Date.parse(tick.receivedAt) - Date.parse(previousTick.receivedAt)
          );

          if (intervalMs > 0) {
            await wait(Math.round(intervalMs / Math.max(0.000001, speedMultiplier)));
          }
        }

        const previousIntentId = this.engineState.lastTradeIntent?.intentId ?? null;
        const result = await this.enqueueTick(tick, null, { shadowReplay: true });
        ticksReplayed += result.accepted ? 1 : 0;

        const nextIntentId = this.engineState.lastTradeIntent?.intentId ?? null;
        if (nextIntentId && nextIntentId !== previousIntentId) {
          generatedIntentCount += 1;
          const modeled = modelReplayIntentTrade(
            this.engineState.lastTradeIntent,
            tick,
            ticks,
            index,
            replayOptions,
            this.engineState.oracle.regime
          );
          if (modeled) {
            modeledTrades.push(modeled);
          }
        }

        if (index === ticks.length - 1 || index % 25 === 0) {
          await this.writeReplayStatus({
            replayId,
            status: "RUNNING",
            ticksTotal: ticks.length,
            ticksProcessed: index + 1,
            progressPct:
              ticks.length > 0 ? roundMetric(((index + 1) / ticks.length) * 100, 2) : 100,
            speedMultiplier,
            shadowBankroll:
              initialShadowBankroll +
              modeledTrades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0),
            dateFrom,
            dateTo,
            scenario: replayOptions.scenario,
            error: null,
            startedAt,
            updatedAt: new Date().toISOString(),
            completedAt: null
          });
        }

        previousTick = tick;
      }
    } catch (error) {
      await this.writeReplayStatus({
        replayId,
        status: "FAILED",
        ticksTotal: ticks.length,
        ticksProcessed: ticksReplayed,
        progressPct: ticks.length > 0 ? roundMetric((ticksReplayed / ticks.length) * 100, 2) : 0,
        speedMultiplier,
        shadowBankroll: initialShadowBankroll,
        dateFrom,
        dateTo,
        scenario: replayOptions.scenario,
        error: error instanceof Error ? error.message : "UNKNOWN_REPLAY_ERROR",
        startedAt,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      });
      throw error;
    } finally {
      await this.restoreReplaySnapshot(liveSnapshot);
    }

    const theoreticalPnl = modeledTrades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0);
    const baselinePnl = shadowTrades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0);
    const attribution = buildReplayAttribution(modeledTrades);
    const equityCurve = buildReplayEquityCurve(initialShadowBankroll, modeledTrades);
    const maxDrawdown = calculateMaxDrawdown(equityCurve);
    const sharpe = calculateReplaySharpe(modeledTrades.map((trade) => trade.theoreticalPnl));
    const winRate = calculateWinRate(modeledTrades);
    const stressResults =
      replayOptions.scenario === "BASELINE"
        ? buildStressSummary(modeledTrades, generatedIntentCount)
        : [
            {
              scenario: replayOptions.scenario,
              pnl: roundMetric(theoreticalPnl, 8),
              maxDrawdown,
              generatedIntentCount,
              simulatedTradeCount: modeledTrades.length
            }
          ];
    const walkForward = replayOptions.walkForward ? buildReplayWalkForward(modeledTrades, 4) : [];
    const ablation = replayOptions.sentimentAblation
      ? buildReplayAblation(modeledTrades, this.engineState.sentiment)
      : null;
    const completedAt = new Date().toISOString();
    const result: ReplayResult = {
      replayId,
      strategyVersionId: replayOptions.strategyVersionId,
      scenario: replayOptions.scenario,
      ticksReplayed,
      shadowBankroll: initialShadowBankroll + theoreticalPnl,
      theoreticalPnl,
      baselinePnl,
      actualTradeCount: historicalTrades.length,
      generatedIntentCount,
      simulatedTradeCount: modeledTrades.length,
      speedMultiplier,
      maxDrawdown,
      sharpe,
      winRate,
      latencyModel: {
        type: replayOptions.scenario === "LATENCY_SHOCK" ? "fixed-plus-shock" : "fixed",
        latencyMs: replayOptions.latencyMs
      },
      slippageModel: {
        type: "side-aware-bps",
        slippageBps: replayOptions.slippageBps
      },
      feeModel: {
        type: "round-trip-bps",
        feeBps: replayOptions.feeBps
      },
      attribution,
      stressResults,
      walkForward,
      ablation,
      shadowTrades: modeledTrades,
      startedAt,
      completedAt
    };

    this.logger.warn("REPLAY_COMPLETED", "Historical shadow replay completed", {
      replayId: result.replayId,
      ticksReplayed,
      actualTradeCount: historicalTrades.length,
      generatedIntentCount,
      theoreticalPnl,
      baselinePnl,
      simulatedTradeCount: modeledTrades.length,
      maxDrawdown,
      sharpe,
      winRate,
      scenario: replayOptions.scenario,
      speedMultiplier,
      liveStateRestored: true
    });
    await this.replayJournal.recordBacktestRun(result, replayOptions, dateFrom, dateTo);
    await this.writeReplayStatus({
      replayId,
      status: "COMPLETED",
      ticksTotal: ticks.length,
      ticksProcessed: ticks.length,
      progressPct: 100,
      speedMultiplier,
      shadowBankroll: result.shadowBankroll,
      dateFrom,
      dateTo,
      scenario: replayOptions.scenario,
      error: null,
      startedAt,
      updatedAt: completedAt,
      completedAt
    });

    return result;
  }

  private captureReplaySnapshot(): EngineReplaySnapshot {
    return {
      engineState: deepClone(this.engineState),
      orderBooks: deepClone([...this.orderBook.values()]),
      latencyHistory: deepClone(this.latencyHistory),
      processingLatencySamples: [...this.processingLatencySamples],
      domWallHistory: deepClone(this.domWallHistory),
      leadLagSamples: deepClone([...this.leadLagSamples.entries()]),
      cachedConfig: deepClone(this.cachedConfig),
      maxLatencyMs: this.maxLatencyMs,
      lastTickTimestamp: this.lastTickTimestamp,
      profilerState: this.profilerAgent.snapshot(),
      profilerStates: deepClone(
        [...this.profilerRegistry.entries()].map(
          ([instrumentCode, agent]) => [instrumentCode, agent.snapshot()] as [string, ProfilerState]
        )
      ),
      anomalyState: this.anomalyDetector.snapshot(),
      oracleState: this.oracleAgent.snapshot(),
      sentimentState: this.sentimentAgent.snapshot(),
      rateLimits: this.rateLimiter.exportState(),
      signals: deepClone(this.signals),
      latestAgentSignals: deepClone([...this.latestAgentSignals.entries()])
    };
  }

  private async currentReplayStatus(): Promise<ReplayStatus> {
    return this.replayJournal.currentStatus();
  }

  private async writeReplayStatus(status: ReplayStatus): Promise<void> {
    await this.replayJournal.writeStatus(status);
  }

  private async restoreReplaySnapshot(snapshot: EngineReplaySnapshot): Promise<void> {
    const hydratedBooks = hydrateOrderBooks(
      new Map(snapshot.orderBooks.map((book) => [`${ORDER_BOOK_PREFIX}${book.marketKey}`, book]))
    );
    let persistedBookKeys = new Map<string, InternalOrderBook>();
    try {
      persistedBookKeys = await this.state.storage.list<InternalOrderBook>({
        prefix: ORDER_BOOK_PREFIX
      });
    } catch (error) {
      this.handleStorageWriteFailure("REPLAY_RESTORE_LIST_BOOKS", error);
    }

    this.engineState = snapshot.engineState;
    this.orderBook = hydratedBooks.snapshots;
    this.bids = hydratedBooks.bids;
    this.asks = hydratedBooks.asks;
    this.bookSync = hydratedBooks.sync;
    this.rebindOrderBookReconstructor();
    this.latencyHistory = snapshot.latencyHistory;
    this.processingLatencySamples = snapshot.processingLatencySamples;
    this.domWallHistory = snapshot.domWallHistory;
    this.leadLagSamples = new Map(snapshot.leadLagSamples);
    this.cachedConfig = snapshot.cachedConfig;
    this.maxLatencyMs = snapshot.maxLatencyMs;
    this.lastTickTimestamp = snapshot.lastTickTimestamp;
    this.signals = snapshot.signals;
    this.latestAgentSignals = new Map(snapshot.latestAgentSignals);
    this.hydrateProfilerAgents(snapshot.profilerState, new Map(snapshot.profilerStates));
    this.anomalyDetector.hydrate(snapshot.anomalyState);
    this.oracleAgent.hydrate(snapshot.oracleState);
    this.sentimentAgent.hydrate(snapshot.sentimentState);
    this.rateLimiter.hydrate(snapshot.rateLimits);

    const writes: Record<string, unknown> = {
      [ENGINE_STATE_KEY]: this.engineState,
      [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
      [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples,
      [DOM_WALL_HISTORY_KEY]: this.domWallHistory,
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

    await this.safeStorageDelete([...persistedBookKeys.keys()], "REPLAY_RESTORE_DELETE_BOOKS");

    await this.safeStoragePut(writes, "REPLAY_RESTORE");
  }

  private calculateMicrostructure(
    marketKey: string,
    instrumentCode: string,
    exchangeCode: string,
    sourceExchange: string,
    sourceWeight: number,
    bids: PriceLevel[],
    asks: PriceLevel[],
    updatedAt: string,
    lastSequence: number | null,
    timeToBookMs: number | null,
    isSynced: boolean
  ): MicrostructureMetrics {
    return buildMicrostructureSnapshot(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      sourceWeight,
      bids,
      asks,
      updatedAt,
      lastSequence,
      timeToBookMs,
      isSynced
    );
  }

  private calculateLatency(tick: MarketTick): LatencyMetrics {
    const brainTimestamp = new Date().toISOString();
    const sourceTimestamp =
      tick.synchronizedExchangeTimestamp ?? tick.providerTimestamp ?? tick.exchangeTimestamp;
    const providerTimestamp = tick.providerTimestamp ?? sourceTimestamp;
    const sourceTime = parseTimestampMs(sourceTimestamp, "source_timestamp");
    const rawIngestTime = parseTimestampMs(tick.receivedAt, "ingest_timestamp");
    const brainTime = parseTimestampMs(brainTimestamp, "brain_timestamp");
    const ingestClockSkewMs = Math.max(0, rawIngestTime - brainTime);
    const ingestTime = ingestClockSkewMs > 0 ? brainTime : rawIngestTime;
    const ingestTimestamp = ingestClockSkewMs > 0 ? brainTimestamp : tick.receivedAt;
    const networkLatencyMs = Math.max(0, ingestTime - sourceTime);
    const processingLatencyMs = Math.max(0, brainTime - ingestTime);

    return {
      instrumentCode: tick.instrumentCode,
      exchangeCode: tick.exchangeCode,
      source: tick.source,
      sourceExchange: tick.source_exchange,
      sourceWeight: tick.sourceWeight,
      sequence: tick.sequence,
      providerTimestamp,
      sourceTimestamp,
      ingestTimestamp,
      brainTimestamp,
      clockOffsetMs: tick.clockOffsetMs + ingestClockSkewMs,
      networkLatencyMs,
      processingLatencyMs,
      totalLatencyMs: networkLatencyMs + processingLatencyMs,
      maxLatencyMs: this.maxLatencyMs,
      averageLatencyMs: this.engineState.averageLatency,
      sampleCount: this.engineState.latencySampleCount,
      status: "FRESH",
      colo: this.engineState.location.colo,
      placement: this.engineState.location.placement,
      latencyRiskMultiplier: this.engineState.location.latencyRiskMultiplier,
      positionSizeMultiplier: this.engineState.location.positionSizeMultiplier
    };
  }

  private updateLatencyAverage(totalLatencyMs: number): void {
    const sampleCount = this.engineState.latencySampleCount + 1;
    const previousMean = this.engineState.averageLatency;
    const nextMean = previousMean + (totalLatencyMs - previousMean) / sampleCount;

    this.engineState = {
      ...this.engineState,
      averageLatency: roundLatency(nextMean),
      latencySampleCount: sampleCount
    };
  }

  private resetLatencyBaseline(observedAt: string, reason: string): void {
    this.latencyHistory = [];
    this.processingLatencySamples = [];
    this.engineState = {
      ...this.engineState,
      averageLatency: 0,
      latencySampleCount: 0,
      executionProfile: {
        ...this.engineState.executionProfile,
        status: "STABLE",
        jitterMs: 0,
        sampleCount: 0,
        averageProcessingLatencyMs: 0,
        maxProcessingLatencyMs: 0,
        lastProcessingLatencyMs: 0,
        updatedAt: observedAt
      },
      updatedAt: observedAt
    };
    this.logger.info("LATENCY_BASELINE_RESET", "Reset stale latency baseline", {
      reason,
      observedAt
    });
  }

  private resolveNativeHyperliquidMaxLatencyMs(
    transport?: MarketTransport,
    streamId?: string | null
  ): number {
    const streamKey = streamId?.toLowerCase() ?? "";

    if (transport === "grpc" || streamKey.startsWith("dwellir-")) {
      return readPositiveNumber(
        this.env.DWELLIR_MAX_LATENCY_MS ?? this.env.HL_STALE_AFTER_MS,
        DEFAULT_DWELLIR_NATIVE_HL_MAX_LATENCY_MS
      );
    }

    return readPositiveNumber(
      this.env.HL_STALE_AFTER_MS,
      Math.min(this.maxLatencyMs, DEFAULT_NATIVE_HL_MAX_LATENCY_MS)
    );
  }

  private observeExecutionProfile(metrics: LatencyMetrics, trace: ExecutionTraceInput): void {
    const processingLatencyMs = roundLatency(metrics.processingLatencyMs);

    this.processingLatencySamples.push(processingLatencyMs);

    if (this.processingLatencySamples.length > this.jitterSampleWindow) {
      this.processingLatencySamples.splice(
        0,
        this.processingLatencySamples.length - this.jitterSampleWindow
      );
    }

    const previousProfile =
      this.engineState.executionProfile ??
      defaultExecutionProfile(
        this.jitterThresholdMs,
        this.jitterSampleWindow,
        this.jitterComputeIntervalTicks,
        this.processingLatencySamples.length
      );
    const nextProcessedTicks = this.engineState.processedTicks + 1;
    const shouldCompute =
      previousProfile.lastComputedAt === null ||
      nextProcessedTicks % this.jitterComputeIntervalTicks === 0;
    const totalHotPathMs = roundLatency(Math.max(0, highResolutionNow() - trace.hotPathStartedAt));
    let nextProfile: ExecutionProfile = {
      ...previousProfile,
      jitterThresholdMs: this.jitterThresholdMs,
      sampleWindow: this.jitterSampleWindow,
      computeIntervalTicks: this.jitterComputeIntervalTicks,
      sampleCount: this.processingLatencySamples.length,
      lastProcessingLatencyMs: processingLatencyMs,
      wakeUpTimeMs: trace.wakeUpTimeMs,
      coldStartSuspected:
        trace.wakeUpTimeMs !== null && trace.wakeUpTimeMs > COLD_START_WAKEUP_THRESHOLD_MS,
      orderBookUpdateMs: trace.orderBookUpdateMs,
      agentLogicMs: trace.agentLogicMs,
      totalHotPathMs,
      updatedAt: trace.observedAt
    };

    if (shouldCompute) {
      const stats = processingLatencyStats(this.processingLatencySamples);
      const status: EngineStabilityStatus =
        stats.jitterMs > this.jitterThresholdMs ? "UNSTABLE" : "STABLE";

      nextProfile = {
        ...nextProfile,
        status,
        jitterMs: stats.jitterMs,
        averageProcessingLatencyMs: stats.averageMs,
        maxProcessingLatencyMs: stats.maxMs,
        lastComputedAt: trace.observedAt
      };
    }

    this.engineState = {
      ...this.engineState,
      executionProfile: nextProfile
    };

    if (shouldCompute && nextProfile.status !== this.lastPerformanceStatus) {
      this.lastPerformanceStatus = nextProfile.status;
      const snapshot = this.performanceSnapshot(nextProfile, nextProcessedTicks, trace.observedAt);

      this.logger.logPerformanceSnapshot(snapshot);
      this.publish(
        nextProfile.status === "UNSTABLE"
          ? "ENGINE_PERFORMANCE_UNSTABLE"
          : "ENGINE_PERFORMANCE_STABLE",
        {
          status: snapshot.status,
          jitterMs: snapshot.jitterMs,
          jitterThresholdMs: snapshot.jitterThresholdMs,
          sampleCount: snapshot.sampleCount,
          sampleWindow: snapshot.sampleWindow,
          processingLatencyMs: snapshot.lastProcessingLatencyMs,
          averageProcessingLatencyMs: snapshot.averageProcessingLatencyMs,
          maxProcessingLatencyMs: snapshot.maxProcessingLatencyMs,
          wakeUpTimeMs: snapshot.wakeUpTimeMs,
          orderBookUpdateMs: snapshot.orderBookUpdateMs,
          agentLogicMs: snapshot.agentLogicMs,
          totalHotPathMs: snapshot.totalHotPathMs,
          coldStartSuspected: snapshot.coldStartSuspected
        },
        `${snapshot.engineId}:${snapshot.processedTicks}`
      );
      this.notifier.notify({
        priority: nextProfile.status === "UNSTABLE" ? "HIGH" : "LOW",
        title:
          nextProfile.status === "UNSTABLE"
            ? "Sovereign-Sigma execution jitter unstable"
            : "Sovereign-Sigma execution jitter recovered",
        message:
          nextProfile.status === "UNSTABLE"
            ? `Processing jitter ${snapshot.jitterMs}ms exceeded ${snapshot.jitterThresholdMs}ms threshold.`
            : `Processing jitter ${snapshot.jitterMs}ms returned below ${snapshot.jitterThresholdMs}ms threshold.`,
        dedupeKey: `performance:${nextProfile.status}`,
        metadata: {
          engineId: snapshot.engineId,
          status: snapshot.status,
          jitterMs: snapshot.jitterMs,
          jitterThresholdMs: snapshot.jitterThresholdMs,
          averageProcessingLatencyMs: snapshot.averageProcessingLatencyMs,
          maxProcessingLatencyMs: snapshot.maxProcessingLatencyMs,
          sampleCount: snapshot.sampleCount,
          processedTicks: snapshot.processedTicks
        }
      });
    }
  }

  private performanceSnapshot(
    profile: ExecutionProfile,
    processedTicks: number,
    observedAt: string
  ): PerformanceSnapshot {
    return {
      engineId: this.engineState.engineId,
      status: profile.status,
      jitterMs: profile.jitterMs,
      jitterThresholdMs: profile.jitterThresholdMs,
      sampleCount: profile.sampleCount,
      sampleWindow: profile.sampleWindow,
      computeIntervalTicks: profile.computeIntervalTicks,
      averageProcessingLatencyMs: profile.averageProcessingLatencyMs,
      maxProcessingLatencyMs: profile.maxProcessingLatencyMs,
      lastProcessingLatencyMs: profile.lastProcessingLatencyMs,
      wakeUpTimeMs: profile.wakeUpTimeMs,
      coldStartSuspected: profile.coldStartSuspected,
      orderBookUpdateMs: profile.orderBookUpdateMs,
      agentLogicMs: profile.agentLogicMs,
      totalHotPathMs: profile.totalHotPathMs,
      processedTicks,
      observedAt
    };
  }

  private performanceMetricsResponse(): Response {
    const profile = this.engineState.executionProfile;
    const labels = {
      engine_id: this.engineState.engineId,
      status: profile.status
    };
    const lines = [
      prometheusMetric(
        "sovereign_sigma_processing_latency_jitter_ms",
        "Standard deviation of processing latency over the configured rolling sample window.",
        "gauge",
        profile.jitterMs,
        labels
      ),
      prometheusMetric(
        "sovereign_sigma_processing_latency_average_ms",
        "Average processing latency over the configured rolling sample window.",
        "gauge",
        profile.averageProcessingLatencyMs,
        labels
      ),
      prometheusMetric(
        "sovereign_sigma_processing_latency_last_ms",
        "Most recent tick processing latency.",
        "gauge",
        profile.lastProcessingLatencyMs,
        labels
      ),
      prometheusMetric(
        "sovereign_sigma_processing_latency_max_ms",
        "Maximum processing latency in the configured rolling sample window.",
        "gauge",
        profile.maxProcessingLatencyMs,
        labels
      ),
      prometheusMetric(
        "sovereign_sigma_wakeup_time_ms",
        "Time spent awaiting Durable Object initialization before request logic.",
        "gauge",
        profile.wakeUpTimeMs,
        labels
      ),
      prometheusMetric(
        "sovereign_sigma_order_book_update_ms",
        "High-resolution duration of the latest order book update block.",
        "gauge",
        profile.orderBookUpdateMs,
        labels
      ),
      prometheusMetric(
        "sovereign_sigma_agent_logic_ms",
        "High-resolution duration of the latest agent logic block.",
        "gauge",
        profile.agentLogicMs,
        labels
      ),
      prometheusMetric(
        "sovereign_sigma_hot_path_ms",
        "High-resolution duration of the latest tick hot path.",
        "gauge",
        profile.totalHotPathMs,
        labels
      ),
      prometheusMetric(
        "sovereign_sigma_execution_unstable",
        "Execution stability flag; 1 when jitter exceeds threshold.",
        "gauge",
        profile.status === "UNSTABLE" ? 1 : 0,
        labels
      ),
      prometheusMetric(
        "sovereign_sigma_cold_start_suspected",
        "Cold-start or eviction suspicion flag based on Durable Object wake-up time.",
        "gauge",
        profile.coldStartSuspected ? 1 : 0,
        labels
      ),
      prometheusMetric(
        "sovereign_sigma_execution_profile_samples",
        "Number of processing latency samples currently retained.",
        "gauge",
        profile.sampleCount,
        labels
      ),
      prometheusMetric(
        "sovereign_sigma_processed_ticks_total",
        "Total market ticks processed by the engine.",
        "counter",
        this.engineState.processedTicks,
        labels
      ),
      prometheusMetric(
        "sovereign_sigma_toxicity_score",
        "Current VPIN toxicity score from the Profiler agent.",
        "gauge",
        this.engineState.toxicityScore,
        labels
      )
    ];

    return new Response(`${lines.join("\n")}\n`, {
      headers: {
        "content-type": "text/plain; version=0.0.4;charset=UTF-8",
        "cache-control": "no-store"
      }
    });
  }

  private publishTickTelemetry(
    tick: MarketTick,
    metrics: LatencyMetrics,
    status: LatencyMetrics["status"],
    hotPathStartedAt: number
  ): void {
    const cpuTimeMs = roundLatency(Math.max(0, highResolutionNow() - hotPathStartedAt));

    this.publish(
      "TICK_TELEMETRY",
      {
        instrumentCode: tick.instrumentCode,
        exchangeCode: tick.exchangeCode,
        sequence: tick.sequence,
        status,
        cpuTimeMs,
        websocketLatencyMs: metrics.networkLatencyMs,
        processingLatencyMs: metrics.processingLatencyMs,
        totalLatencyMs: metrics.totalLatencyMs,
        timeToBookMs: metrics.timeToBookMs ?? null,
        orderBookDepth: this.engineState.internalOrderBookDepth,
        averageLatencyMs: this.engineState.averageLatency,
        staleTickCount: this.engineState.staleTickCount,
        toxicityScore: this.engineState.toxicityScore,
        jitterMs: this.engineState.executionProfile.jitterMs,
        executionStatus: this.engineState.executionProfile.status,
        wakeUpTimeMs: this.engineState.executionProfile.wakeUpTimeMs,
        orderBookUpdateMs: this.engineState.executionProfile.orderBookUpdateMs,
        agentLogicMs: this.engineState.executionProfile.agentLogicMs,
        liquidityWallCount: this.engineState.dom?.walls.length ?? 0,
        pulledWallCount: this.engineState.dom?.pulledWalls.length ?? 0,
        filledWallCount: this.engineState.dom?.filledWalls.length ?? 0,
        heatmapCells: this.engineState.dom?.heatmap.cells.length ?? 0,
        anomalyStatus: this.engineState.anomaly.status,
        priceZScore: this.engineState.anomaly.priceZScore,
        volumeZScore: this.engineState.anomaly.volumeZScore,
        cancellationToExecutionRatio: this.engineState.anomaly.cancellationToExecutionRatio,
        colo: this.engineState.location.colo,
        placement: this.engineState.location.placement,
        isGoldenRegion: this.engineState.location.isGoldenRegion,
        latencyRiskMultiplier: this.engineState.location.latencyRiskMultiplier,
        positionSizeMultiplier: this.engineState.location.positionSizeMultiplier,
        netDelta: this.engineState.inventory.netDelta,
        maxInventoryUnits: this.engineState.inventory.maxInventoryUnits,
        inventoryPenalty: this.engineState.inventory.inventoryPenalty,
        stopBid: this.engineState.inventory.stopBid,
        stopAsk: this.engineState.inventory.stopAsk,
        weightedImbalance: this.engineState.microstructure.weightedImbalance,
        midPrice: this.engineState.microstructure.midPrice,
        macroBias: this.macroBias,
        temporaryOverride: this.activeTemporaryOverride,
        connectedAdminStreams: this.adminSockets.size,
        RegimeCoefficient: this.engineState.oracle.skepticismMultiplier,
        AgentLogicTrace: this.signals.slice(-5).map((signal) => ({
          agent: signal.sourceAgent,
          action: signal.action,
          confidence: signal.confidence,
          rationale: signal.rationale,
          createdAt: signal.createdAt
        }))
      },
      `${tick.instrumentCode}:${tick.sequence}`
    );
  }

  private maybeRecordAgentSnapshot(observedAt: string): void {
    if (
      this.engineState.processedTicks === 0 ||
      this.engineState.processedTicks % AGENT_SNAPSHOT_TICK_INTERVAL !== 0
    ) {
      return;
    }

    const agents = (Object.keys(this.engineState.agentHealth) as AgentName[]).map((agentName) => {
      const latestSignal = this.latestAgentSignals.get(agentName);

      return {
        agentName,
        health: this.engineState.agentHealth[agentName].status,
        confidence: latestSignal?.confidence ?? null,
        bias: latestSignal ? inferSignalBias(latestSignal) : "NEUTRAL",
        action: latestSignal?.action ?? null,
        expectedValue: latestSignal?.expectedValue ?? null,
        lastSignalId: latestSignal?.signalId ?? null,
        heartbeatAt: this.engineState.agentHealth[agentName].heartbeatAt
      };
    });

    this.publish(
      "AGENT_STATE_SNAPSHOT",
      {
        observedAt,
        processedTicks: this.engineState.processedTicks,
        agents
      },
      `agent-snapshot:${this.engineState.processedTicks}`
    );
  }

  private logPerformance(latencyMetrics: LatencyMetrics): void {
    if (!this.shouldLogPerformanceSpike(latencyMetrics)) {
      return;
    }

    this.logger.logPerformance(latencyMetrics);
  }

  private shouldLogPerformanceSpike(latencyMetrics: LatencyMetrics): boolean {
    const key = `${latencyMetrics.instrumentCode}:${latencyMetrics.status}`;
    const now = Date.now();
    const previous = this.performanceSpikeLogAt.get(key) ?? 0;

    if (now - previous < HOT_PATH_LOG_THROTTLE_MS) {
      return false;
    }

    this.performanceSpikeLogAt.set(key, now);
    return true;
  }

  private triggerEmergencyPause(
    tick: MarketTick,
    book: InternalOrderBook,
    domSnapshot: DomAnalysisSnapshot,
    anomalyResult: AnomalyDetectionResult,
    metrics: LatencyMetrics
  ): void {
    const primaryAnomaly = anomalyResult.anomalies[0] ?? null;
    const correlationId =
      primaryAnomaly?.anomalyId ?? `${tick.instrumentCode}:${tick.sequence}:anomaly`;
    const snapshot = {
      tick,
      book,
      dom: domSnapshot,
      latency: metrics,
      anomaly: anomalyResult.status,
      anomalies: anomalyResult.anomalies,
      engineState: {
        engineId: this.engineState.engineId,
        mode: this.engineState.mode,
        risk: this.engineState.risk,
        microstructure: this.engineState.microstructure,
        executionProfile: this.engineState.executionProfile,
        toxicityScore: this.engineState.toxicityScore,
        processedTicks: this.engineState.processedTicks,
        location: this.engineState.location
      }
    };

    this.logger.writeLog(
      "CRITICAL",
      "TradingEngine",
      "Emergency pause triggered by market anomaly detector",
      {
        eventType: "MARKET_ANOMALY_EMERGENCY_PAUSE",
        correlationId,
        anomalyTypes: anomalyResult.anomalies.flatMap((event) => event.types),
        severity: primaryAnomaly?.severity ?? "CRITICAL",
        reason: primaryAnomaly?.reason ?? "ANOMALY_DETECTED",
        marketSnapshot: snapshot
      }
    );

    this.publish(
      "EMERGENCY_PAUSE",
      {
        anomalyTypes: anomalyResult.anomalies.flatMap((event) => event.types),
        severity: primaryAnomaly?.severity ?? "CRITICAL",
        reason: primaryAnomaly?.reason ?? "ANOMALY_DETECTED",
        instrumentCode: tick.instrumentCode,
        exchangeCode: tick.exchangeCode,
        sequence: tick.sequence,
        priceZScore: anomalyResult.status.priceZScore,
        volumeZScore: anomalyResult.status.volumeZScore,
        cancellationToExecutionRatio: anomalyResult.status.cancellationToExecutionRatio,
        mode: this.engineState.mode,
        killSwitch: this.engineState.risk.killSwitch
      },
      correlationId
    );
    this.notifier.notify({
      priority: "CRITICAL",
      title: "Sovereign-Sigma emergency pause",
      message: `${tick.instrumentCode} halted by anomaly detector: ${primaryAnomaly?.reason ?? "ANOMALY_DETECTED"}`,
      dedupeKey: `emergency:${tick.instrumentCode}:${primaryAnomaly?.severity ?? "CRITICAL"}`,
      metadata: {
        instrumentCode: tick.instrumentCode,
        sequence: tick.sequence,
        anomalyTypes: anomalyResult.anomalies.flatMap((event) => event.types),
        mode: this.engineState.mode
      }
    });
  }

  private publishProfilerAlert(signal: AgentSignal, profilerState: ProfilerState): void {
    this.publish(
      "PROFILER_ALERT",
      {
        signalId: signal.signalId,
        traceId: signal.traceId,
        instrumentCode: signal.instrumentCode,
        toxicityScore: profilerState.toxicityScore,
        amVpin: profilerState.amVpinScore,
        obi: profilerState.obi,
        obiDepth: profilerState.obiDepth,
        toxicityState: profilerState.toxicityState,
        pressureSide: profilerState.pressureSide,
        spreadMultiplier: profilerState.spreadMultiplier,
        reservationShiftBps: profilerState.reservationShiftBps,
        quoteHaltUntil: profilerState.quoteHaltUntil,
        alertThreshold: profilerState.alertThreshold,
        bucketSize: profilerState.bucketSize,
        rollingWindow: profilerState.rollingWindow,
        completedBuckets: profilerState.buckets.length,
        totalBucketsClosed: profilerState.totalBucketsClosed,
        action: signal.action,
        targetAgent: signal.targetAgent,
        suggestedSpreadWidenBps: signal.maxSlippageBps,
        rationale: signal.rationale,
        featureVector: signal.featureVector,
        riskContext: signal.riskContext
      },
      signal.signalId
    );
  }

  private publishAmVpinTelemetry(
    profilerState: ProfilerState,
    instrumentCode: string,
    observedAt: string
  ): void {
    this.publish(
      "AM_VPIN_TELEMETRY",
      {
        instrumentCode,
        observedAt,
        am_vpin: profilerState.amVpinScore,
        obi: profilerState.obi,
        obiDepth: profilerState.obiDepth,
        toxicity_state: profilerState.toxicityState,
        pressureSide: profilerState.pressureSide,
        spreadMultiplier: profilerState.spreadMultiplier,
        reservationShiftBps: profilerState.reservationShiftBps,
        quoteHaltUntil: profilerState.quoteHaltUntil,
        latestSignedImbalance: profilerState.latestSignedImbalance,
        latestDirectionalImbalance: profilerState.latestDirectionalImbalance,
        directionalDecay: profilerState.directionalDecay,
        bucketSize: profilerState.bucketSize,
        rollingWindow: profilerState.rollingWindow,
        completedBuckets: profilerState.amVpinBucketCompletions,
        amVpinMean: profilerState.amVpinMean,
        amVpinVariance: profilerState.amVpinVariance
      },
      `am-vpin:${instrumentCode}:${profilerState.amVpinBucketCompletions}`
    );
  }

  private publish(type: string, payload: Record<string, unknown>, correlationId?: string): void {
    this.telemetryBus.publish(type, payload, correlationId);
  }

  private nextBusSequence(): number {
    return this.telemetryBus.nextSequence();
  }

  private observeTopology(topology: EdgeTopology): void {
    const previous = this.engineState.location;
    const next = resolveEngineLocation(
      topology,
      previous,
      this.env,
      this.cachedConfig,
      previous.observedLatencyMs
    );

    if (!locationChanged(previous, next)) {
      this.engineState = {
        ...this.engineState,
        location: next
      };
      return;
    }

    const now = topology.observedAt;
    this.engineState = {
      ...this.engineState,
      location: next,
      risk: applyLocationRisk(this.engineState.risk, this.cachedConfig, next, now),
      updatedAt: now
    };

    this.waitUntilStoragePut(ENGINE_STATE_KEY, this.engineState, "COLO_TOPOLOGY_CHANGED");

    if (previous.colo !== next.colo || previous.placement !== next.placement) {
      this.logger.warn(
        "COLO_TOPOLOGY_CHANGED",
        "Trading engine observed a Cloudflare placement change",
        locationTelemetry(next)
      );
    }

    if (!next.isGoldenRegion) {
      this.logger.warn(
        "PIT_BOSS_RISK_ADJUSTED",
        "Pit Boss reduced max order notional for execution-location risk",
        {
          ...locationTelemetry(next),
          maxOrderNotional: this.engineState.risk.maxOrderNotional,
          baseMaxPositionSize: this.cachedConfig.MAX_POSITION_SIZE
        }
      );
    }
  }

  private applyLocationLatency(totalLatencyMs: number, observedAt: string): void {
    const location = {
      ...this.engineState.location,
      observedLatencyMs: roundLatency(totalLatencyMs),
      lastSeenAt: observedAt
    };

    this.engineState = {
      ...this.engineState,
      location,
      risk: applyLocationRisk(this.engineState.risk, this.cachedConfig, location, observedAt)
    };
  }

  private warmUpForTopology(topology: EdgeTopology): void {
    const colo = topology.colo ?? "UNKNOWN";
    const now = Date.now();

    if (this.warmedColo === colo && now - this.warmedAt < WARM_UP_INTERVAL_MS) {
      return;
    }

    this.warmedColo = colo;
    this.warmedAt = now;

    const warmUp = Promise.all([
      this.state.storage.get(ENGINE_STATE_KEY),
      this.configManager.fetchConfig()
    ])
      .then(() => {
        this.logger.info("ENGINE_WARMUP", "Trading engine warm-up completed", {
          colo: topology.colo,
          placement: topology.placement,
          observedAt: topology.observedAt
        });
      })
      .catch((error) => {
        this.logger.error("ENGINE_WARMUP_FAILED", "Trading engine warm-up failed", {
          colo: topology.colo,
          placement: topology.placement,
          message: error instanceof Error ? error.message : "UNKNOWN_ERROR"
        });
      });

    this.state.waitUntil(warmUp);
  }

  private async refreshConfig(
    source: "ALARM" | "ADMIN_SIGNAL",
    configSnapshot?: GlobalRiskConfig
  ): Promise<void> {
    const previousVersion = this.cachedConfig.version;
    const effectiveGovernance = await this.governor.readEffectiveConfig(
      configSnapshot ?? (await this.configManager.fetchConfig())
    );
    const nextConfig = effectiveGovernance.config;
    const now = new Date().toISOString();

    this.cachedConfig = nextConfig;
    this.macroBias = effectiveGovernance.macroBias;
    this.activeTemporaryOverride = effectiveGovernance.temporaryOverride;
    this.configureProfilerAgents(nextConfig);
    this.maxLatencyMs = nextConfig.LATENCY_THRESHOLD_MS;
    if (nextConfig.TRADING_ENABLED) {
      this.killSwitchLogged = false;
    }
    const nextAssetQuoteStates = reconcileAssetQuoteStatesForConfig(
      this.engineState.assetQuoteStates,
      nextConfig,
      this.macroBias,
      now
    );
    const nextQuoteState = aggregateQuoteState(
      nextAssetQuoteStates,
      this.engineState.quoteState,
      now
    );

    const refreshedLocation = resolveEngineLocation(
      {
        colo: this.engineState.location.colo,
        placement: this.engineState.location.placement,
        country: this.engineState.location.country,
        city: this.engineState.location.city,
        region: this.engineState.location.region,
        timezone: this.engineState.location.timezone,
        latitude: this.engineState.location.latitude,
        longitude: this.engineState.location.longitude,
        requestId: crypto.randomUUID(),
        observedAt: now
      },
      this.engineState.location,
      this.env,
      nextConfig,
      this.engineState.location.observedLatencyMs
    );

    this.engineState = {
      ...this.engineState,
      cachedConfig: nextConfig,
      macroBias: this.macroBias,
      temporaryOverride: this.activeTemporaryOverride,
      assetQuoteStates: nextAssetQuoteStates,
      quoteState: nextQuoteState,
      assetMatrix: this.calculateAssetMatrix(
        now,
        this.engineState.microstructure.instrumentCode ?? undefined,
        this.engineState.oracle,
        this.profilerStateSnapshot(),
        nextAssetQuoteStates
      ),
      profilerStates: this.profilerStateSnapshot(),
      maxLatencyMs: nextConfig.LATENCY_THRESHOLD_MS,
      location: refreshedLocation,
      risk: applyLocationRisk(
        {
          ...this.engineState.risk,
          configVersion: nextConfig.version,
          killSwitch: !nextConfig.TRADING_ENABLED,
          maxOrderNotional: nextConfig.MAX_POSITION_SIZE,
          maxDrawdownPct: nextConfig.MAX_DRAWDOWN_PCT,
          updatedAt: now
        },
        nextConfig,
        refreshedLocation,
        now
      ),
      updatedAt: now
    };

    await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "CONFIG_REFRESH");

    if (source === "ADMIN_SIGNAL" || previousVersion !== nextConfig.version) {
      this.logger.warn("CONFIG_REFRESHED", "Trading engine config cache refreshed", {
        source,
        tradingEnabled: nextConfig.TRADING_ENABLED,
        maxPositionSize: nextConfig.MAX_POSITION_SIZE,
        maxDrawdownPct: nextConfig.MAX_DRAWDOWN_PCT,
        latencyThresholdMs: nextConfig.LATENCY_THRESHOLD_MS,
        goldenColos: nextConfig.GOLDEN_COLOS,
        configVersion: nextConfig.version,
        macroBias: toJsonValue(this.macroBias),
        temporaryOverride: toJsonValue(this.activeTemporaryOverride)
      });
    }
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
    this.signals.push(signal);

    if (this.signals.length > SIGNAL_BUFFER_LIMIT) {
      this.signals.splice(0, this.signals.length - SIGNAL_BUFFER_LIMIT);
    }

    this.latestAgentSignals.set(signal.sourceAgent, signal);
    const hawkesEvacuation = hawkesEvacuationSignal(signal);
    const assetQuoteStates = hawkesEvacuation
      ? suspendAssetQuoteStates(
          this.engineState.assetQuoteStates,
          "HAWKES_FLOW_CLUSTER",
          signal.createdAt,
          {
            instrumentCode: signal.instrumentCode,
            suspendedUntil: new Date(
              Date.parse(signal.createdAt) + Math.max(1_000, signal.horizonMs)
            ).toISOString(),
            lastQuote: this.engineState.quoteState.lastQuote
          }
        )
      : this.engineState.assetQuoteStates;
    const quoteState = hawkesEvacuation
      ? aggregateQuoteState(assetQuoteStates, this.engineState.quoteState, signal.createdAt)
      : this.engineState.quoteState;

    const agentHealth = {
      ...this.engineState.agentHealth,
      [signal.sourceAgent]: {
        status: "GREEN",
        heartbeatAt: signal.createdAt,
        latencyMs,
        lastSignalId: signal.signalId,
        failures24h: this.engineState.agentHealth[signal.sourceAgent].failures24h
      }
    } satisfies Record<AgentName, AgentHealth>;

    this.engineState = {
      ...this.engineState,
      acceptedSignals: this.engineState.acceptedSignals + 1,
      agentHealth,
      quoteState,
      assetQuoteStates,
      heartbeatAt: signal.createdAt,
      updatedAt: signal.createdAt
    };

    await this.safeStoragePut(
      {
        [ENGINE_STATE_KEY]: this.engineState,
        [`signal:${signal.signalId}`]: signal
      },
      "AGENT_SIGNAL"
    );

    this.logger.agentDecision(signal, latencyMs);
    this.publish(
      "AGENT_SIGNAL",
      {
        signalId: signal.signalId,
        traceId: signal.traceId,
        sourceAgent: signal.sourceAgent,
        targetAgent: signal.targetAgent,
        instrumentCode: signal.instrumentCode,
        action: signal.action,
        confidence: signal.confidence,
        bias: inferSignalBias(signal),
        expectedValue: signal.expectedValue,
        latencyMs,
        createdAt: signal.createdAt
      },
      signal.signalId
    );

    if (hawkesEvacuation) {
      this.publish("SUSPEND_QUOTES", quoteStateTelemetry(quoteState), signal.signalId);
      if (this.cachedConfig.TRADING_ENABLED) {
        this.state.waitUntil(
          this.cancelAllQuotes(signal.instrumentCode || "ALL", "HAWKES_FLOW_CLUSTER")
        );
      }
    }
  }

  private emitCascadeOperationalAlert(
    eventType: CascadeAlertEventType,
    title: string,
    message: string,
    metadata: JsonRecord,
    dedupeKey: string
  ): void {
    const policy = cascadeAlertPolicy(eventType);
    const payload: JsonRecord = {
      eventType,
      priority: policy.priority,
      routes: policy.routes,
      externalDelivery: policy.externalDelivery,
      ...metadata
    };

    this.publish("CASCADE_ALERT", payload, dedupeKey);
    if (!policy.externalDelivery) {
      return;
    }

    this.notifier.notify({
      priority: policy.priority,
      title,
      message,
      dedupeKey: `cascade:${eventType}:${dedupeKey}`,
      metadata: payload
    });
  }

  private async ensureCascadePaperModeArmed(observedAt: string): Promise<void> {
    try {
      const existing = await this.env.CONFIG_STORE.get(CASCADE_PAPER_ARMED_AT_KEY);
      if (existing) {
        return;
      }

      await this.env.CONFIG_STORE.put(CASCADE_PAPER_ARMED_AT_KEY, observedAt);
      this.logger.warn("CASCADE_PAPER_MODE_ARMED", "Cascade recovery paper-mode clock started", {
        strategyMode: this.cachedConfig.STRATEGY_MODE,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        shadowMode: isShadowMode(this.env),
        observedAt
      });
    } catch (error) {
      this.handleStorageWriteFailure("CASCADE_PAPER_MODE_ARMING", error);
    }
  }

  private recordCascadeUiSignal(
    signal: AgentSignal,
    outcome: "TAKEN" | "SKIPPED" | "CLOSED"
  ): void {
    this.signals.push(signal);

    if (this.signals.length > SIGNAL_BUFFER_LIMIT) {
      this.signals.splice(0, this.signals.length - SIGNAL_BUFFER_LIMIT);
    }

    this.latestAgentSignals.set(signal.sourceAgent, signal);
    this.state.waitUntil(
      this.safeStoragePut(`signal:${signal.signalId}`, signal, "CASCADE_SIGNAL")
    );
    this.publish(
      "CASCADE_SIGNAL",
      {
        signalId: signal.signalId,
        traceId: signal.traceId,
        sourceAgent: signal.sourceAgent,
        targetAgent: signal.targetAgent,
        instrumentCode: signal.instrumentCode,
        action: signal.action,
        confidence: signal.confidence,
        expectedValue: signal.expectedValue,
        outcome,
        cascadeId:
          (signal.featureVector as JsonRecord).cascadeId ??
          (signal.riskContext as JsonRecord).cascadeId ??
          null,
        createdAt: signal.createdAt
      },
      signal.signalId
    );
  }

  private async applyConfigUpdate(update: AdminConfigUpdate): Promise<void> {
    if (update.signal === "REFRESH_CONFIG" || update.config) {
      const directConfig = update.config ? this.configFromAdminSnapshot(update.config) : undefined;
      await this.refreshConfig("ADMIN_SIGNAL", directConfig);
      await this.scheduleConfigRefresh();
      if (!hasRuntimeConfigUpdate(update)) {
        return;
      }
    }

    const now = new Date().toISOString();
    const nextRisk = update.risk
      ? mergeRiskLimits(this.engineState.risk, { ...update.risk, updatedAt: now })
      : this.engineState.risk;
    this.maxLatencyMs = resolveMaxLatencyMs(update, this.maxLatencyMs);

    this.engineState = {
      ...this.engineState,
      mode: update.mode ?? this.engineState.mode,
      bankroll: {
        ...this.engineState.bankroll,
        ...update.bankroll,
        updatedAt: now
      },
      risk: applyLocationRisk(nextRisk, this.cachedConfig, this.engineState.location, now),
      maxLatencyMs: this.maxLatencyMs,
      cachedConfig: this.cachedConfig,
      macroBias: this.macroBias,
      temporaryOverride: this.activeTemporaryOverride,
      heartbeatAt: now,
      updatedAt: now
    };

    await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "ADMIN_CONFIG_APPLIED");

    this.logger.warn("ADMIN_CONFIG_APPLIED", "Runtime configuration updated", {
      mode: this.engineState.mode,
      riskConfigVersion: this.engineState.risk.configVersion,
      maxLatencyMs: this.maxLatencyMs,
      killSwitch: this.engineState.risk.killSwitch
    });
  }

  private configFromAdminSnapshot(snapshot: GlobalRiskConfigUpdate): GlobalRiskConfig {
    const observedAt = new Date().toISOString();
    const metadata = snapshot as Partial<GlobalRiskConfig>;

    return {
      ...defaultConfig,
      ...this.cachedConfig,
      ...snapshot,
      updatedAt:
        typeof metadata.updatedAt === "string" && metadata.updatedAt.length > 0
          ? metadata.updatedAt
          : observedAt,
      updatedBy:
        typeof metadata.updatedBy === "string" && metadata.updatedBy.length > 0
          ? metadata.updatedBy
          : "admin",
      version:
        typeof metadata.version === "string" && metadata.version.length > 0
          ? metadata.version
          : crypto.randomUUID()
    };
  }
}
