import {
  ConfigManager,
  configDefaultsFromEnv,
  configFromAdminSnapshot,
  defaultConfig
} from "./ConfigManager";
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
import {
  applyExecutionAccounting,
  executionQualityFromAccounting,
  stateAfterExecutionAccounting
} from "./engine/ExecutionAccounting";
import { evaluateIntentDispatchGate } from "./engine/IntentGeneration";
import { AdverseSelectionModel, adversePenaltyForQuoteSide } from "./engine/AdverseSelectionModel";
import {
  applyLocationRisk,
  buildTopologyObservationLogEvents,
  defaultEngineLocation,
  readTopologyHeaders,
  resolveEngineLocation,
  stateAfterLocationLatency,
  stateAfterTopologyObservation
} from "./engine/trading/helpers/PlacementResolver";
import {
  DEFAULT_ORDER_BOOK_TICK_SIZE,
  priceKey,
  SortedBookSide
} from "./engine/trading/book/SortedBookSide";
import {
  countBookLevels,
  isCrossedBook,
  microstructureFromBook
} from "./engine/trading/book/BookReconstruction";
import {
  calculateOrderBookPriceDiscovery,
  currentMarkPriceForInstrument,
  currentBookForMarketTick,
  currentOrderBookSnapshot,
  findBestAssetBook as findBestOrderBookForAsset,
  nullableMarkPriceForInstrument
} from "./engine/trading/book/BookViews";
import {
  bookDesyncStorageExtra,
  markBookSyncDesynced,
  shouldEmitBookSnapshotTelemetry,
  stateAfterAcceptedBookDelta,
  stateAfterBookSnapshot,
  stateAfterDesyncedBook,
  stateAfterInformationalBookNotReady,
  stateAfterOrderBookReset,
  stateAfterRejectedBookDelta,
  bookSnapshotTelemetry,
  bookSnapshotStorageWrites
} from "./engine/trading/book/BookRuntimeState";
import {
  applyOrderBookResetStores,
  orderBookResetConnectionKeys,
  orderBookResetDeleteKeys,
  orderBookResetTelemetry,
  resolveOrderBookReset
} from "./engine/trading/book/OrderBookResetRuntime";
import {
  buildDomAnalysisSnapshot,
  currentDomHeatmapSnapshot
} from "./engine/trading/book/DomAnalyzer";
import {
  buildShadowQueueDecisionAction,
  buildShadowQueueGhostFillRuntimeRecord,
  buildShadowQueueDecisionTrace,
  buildShadowQueueLatencyBreachTelemetry,
  buildShadowQueueNoEdgeTelemetry,
  buildShadowQueueTradeIntentFromDecision,
  enforceShadowQueueDecisionLatency,
  resolveShadowQueueNoEdgeLogInterval,
  resolveShadowQueueSizingConfig,
  shouldLogShadowQueueNoEdge as shouldLogShadowQueueNoEdgeEvent,
  shouldProcessShadowQueueTick
} from "./engine/trading/shadow/ShadowQueueRuntime";
import {
  anomalyEmergencyPauseStorageWrites,
  buildAnomalyEmergencyPauseTelemetry,
  stateAfterAnomalyEmergencyPause
} from "./engine/trading/anomaly/AnomalyRuntime";
import {
  crossAssetHypeCancelLogMetadata,
  crossAssetHypeCancelTelemetry,
  evaluateCrossAssetHypeQuoteCancel,
  updateLeadLagMetrics as updateLeadLagRuntimeMetrics
} from "./engine/trading/leadlag/LeadLagRuntime";
import {
  buildInventoryHedgeIntent,
  calculateInventoryState as calculateInventoryRuntimeState,
  inventoryHedgeAuthorizedLogMetadata,
  referencePriceForBaseAsset as resolveBaseAssetReferencePrice
} from "./engine/trading/inventory/InventoryRuntime";
import {
  buildDrawdownKillSwitchTransition,
  calculatePortfolioRisk as calculatePortfolioRuntimeRisk
} from "./engine/trading/risk/PortfolioRiskRuntime";
import { calculateEnsembleState as calculateRuntimeEnsembleState } from "./engine/trading/ensemble/EnsembleRuntime";
import {
  currentFundingRate as resolveCurrentFundingRate,
  stateAfterFundingTick
} from "./engine/trading/funding/FundingRuntime";
import {
  nextQuoteStateForInstrument as nextRuntimeQuoteStateForInstrument,
  quoteSuppressionDecision,
  resolveQuoteHibernateMs,
  resumeExpiredQuoteStates,
  strategyQuoteDisabledReason as runtimeStrategyQuoteDisabledReason
} from "./engine/trading/quotes/QuoteStateRuntime";
import {
  buildCroupierQuoteAction,
  buildQuoteDispatchIntents,
  dispatchedQuoteSnapshot,
  evaluateQuoteRefreshThrottle,
  quoteDispatchBlockedLogMetadata,
  quoteRefreshThrottleLogMetadata,
  type CroupierQuoteAction
} from "./engine/trading/quotes/QuoteDispatchRuntime";
import {
  dispatchQuoteCancelAll,
  evaluateQuoteCancelDispatch
} from "./engine/trading/quotes/QuoteCancelRuntime";
import {
  buildApprovedExecutionPlan,
  shouldSkipExecutionPlanForQuoteSuspension,
  type ApprovedExecutionPlan
} from "./engine/trading/execution/ExecutionPlanRuntime";
import {
  buildExecutionDispatchBlockLog,
  buildExecutionPlanDispatchAction,
  dispatchTradeIntentToExecutioner,
  evaluateExecutionDispatchGate
} from "./engine/trading/execution/ExecutionDispatchRuntime";
import {
  buildCroupierEvaluationInput,
  buildOracleTickInput,
  buildProfilerContext,
  disabledOracleTickResult
} from "./engine/trading/agents/AgentEvaluationRuntime";
import { applyIntentPaperExecutionBudget } from "./engine/trading/execution/PaperExecutionBudgetRuntime";
import {
  buildExecutionQueueEnqueuePlan,
  executionQueueDeferralLogMetadata,
  shouldLogExecutionQueueDeferral,
  splitExecutionQueueForDrain,
  type QueuedExecutionIntent
} from "./engine/trading/execution/ExecutionQueueRuntime";
import { calculateAssetMatrix as calculateRuntimeAssetMatrix } from "./engine/trading/state/AssetMatrixRuntime";
import {
  buildExecutionPerformanceTransition,
  buildPerformanceMetricsText,
  buildPerformanceSnapshot,
  calculateTickLatency,
  hardStalePullTelemetryPayload,
  hardStaleTickDropLogMetadata,
  latencySnapshotStorageWrites,
  nativeHyperliquidLatencyPullStorageWrites,
  nextExecutionProfile,
  nextLatencyAverage,
  recordProcessingLatencySample,
  resolveNativeHyperliquidMaxLatencyMs,
  shouldLogHardStaleTickDrop,
  shouldLogPerformanceSpikeEvent,
  stateAfterLatencyBaselineReset,
  stateAfterNativeHyperliquidLatencyPull,
  stateAfterHardStaleTickDrop,
  stateAfterStaleDataKillSwitch,
  staleDataKillSwitchNotification,
  staleDataKillSwitchStorageExtra,
  staleDataKillSwitchTelemetryPayload,
  type ExecutionTraceInput
} from "./engine/trading/performance/LatencyRuntime";
import {
  buildJanitorReport,
  cancelJanitorOrder,
  fetchJanitorExchangeOpenOrders,
  janitorCleanupRequiredLogMetadata,
  reconcileJanitorOrders,
  recordPostOnlyDustCloseSkip,
  stateAfterJanitorRun
} from "./engine/trading/janitor/JanitorRuntime";
import {
  currentCascadeActiveSnapshot as buildCurrentCascadeActiveSnapshot,
  currentCascadeHeatSnapshot as buildCurrentCascadeHeatSnapshot,
  currentCascadePositionSnapshot as buildCurrentCascadePositionSnapshot,
  currentCascadeSignalSnapshot as buildCurrentCascadeSignalSnapshot
} from "./engine/trading/cascade/CascadeSnapshots";
import {
  cascadeDetectedAlertMetadata,
  cascadeDetectedLogMetadata,
  cascadeDetectedTelemetryPayload,
  liquidationHeatmapStorageWrites,
  liquidationEventProcessedCount,
  liquidationEventTelemetry,
  persistCascadeLiquidationEvents,
  resolveLiquidationEventContext,
  stateAfterLiquidationHeatmap
} from "./engine/trading/cascade/CascadeLiquidationRuntime";
import {
  buildCascadeEntryTradeIntent,
  buildCascadeExitTradeIntent
} from "./engine/trading/cascade/CascadeTradeIntents";
import {
  absorptionConfirmedAlertMetadata,
  absorptionConfirmedLogMetadata,
  absorptionConfirmedTelemetryPayload,
  buildCascadeAbsorptionObservation,
  nextCascadeCvd
} from "./engine/trading/cascade/CascadeAbsorptionRuntime";
import {
  buildConfigRefreshLog,
  buildRuntimeConfigAppliedLog,
  shouldLogConfigRefresh,
  stateAfterConfigRefresh,
  stateAfterRuntimeConfigUpdate
} from "./engine/trading/config/ConfigRuntime";
import {
  absorptionAnalyzerConfig as buildAbsorptionAnalyzerConfig,
  cascadeAssetProfileFromConfig,
  cascadeDetectorConfig as buildCascadeDetectorConfig,
  cascadeRecoverySignalConfig as buildCascadeRecoverySignalConfig
} from "./engine/trading/cascade/CascadeConfigRuntime";
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
  buildHyperliquidL2BookTick,
  buildHyperliquidL2BookTickFromBook,
  evaluateHyperliquidL2BookHotPath,
  handleHyperliquidRawBatch,
  hyperliquidBookDesyncLogMetadata,
  processHyperliquidAssetContext,
  processHyperliquidTradeBatch,
  registerHyperliquidIngestConnection,
  routeHyperliquidRawMessage,
  type HyperliquidRawIngestPayload
} from "./engine/trading/ingest/HyperliquidRawIngest";
import {
  buildGrpcFatalDropEventArtifacts,
  resolveGrpcFatalDropPayload,
  stateAfterGrpcFatalDrop
} from "./engine/trading/ingest/GrpcDropRuntime";
import {
  handleTradingEngineHttpRoute,
  type EngineHttpRouteContext
} from "./engine/trading/routes/EngineHttpRoutes";
import {
  acceptMarketStream as acceptTradingMarketStream,
  acceptTelemetryStream as acceptTradingTelemetryStream
} from "./engine/trading/routes/EngineWebSocketStreams";
import { TradingTelemetryBus } from "./engine/trading/telemetry/TelemetryBus";
import {
  acceptedAgentSignalStorageEntries,
  agentSignalStorageKey,
  buildHawkesEvacuationDispatch,
  recordAgentSignalInBuffers,
  stateAfterAcceptedAgentSignal
} from "./engine/trading/telemetry/AgentSignalRuntime";
import { buildAgentStateSnapshot } from "./engine/trading/telemetry/AgentSnapshotRuntime";
import {
  buildCascadeOperationalAlertTelemetry,
  buildCascadeSignalTelemetry,
  cascadeCloseOperationalAlert,
  cascadeEntryAgentSignal,
  cascadeEntryDecisionTrace,
  cascadeHeatCapAlertMetadata,
  cascadeManualCloseLogMetadata,
  cascadeManualCloseTelemetryPayload,
  cascadePositionOpenedAlertMetadata,
  cascadeSignalRejectionAgentSignal,
  cascadeSignalRejectionLogMetadata,
  cascadeSignalEmittedAlertMetadata,
  cascadeSizeRejectedLogMetadata
} from "./engine/trading/telemetry/CascadeSignalTelemetryRuntime";
import {
  buildAmVpinTelemetry,
  buildProfilerAlertTelemetry,
  shouldCancelQuotesForProfilerSignal
} from "./engine/trading/telemetry/ProfilerTelemetryRuntime";
import {
  bayesianPosteriorUpdatedLogMetadata,
  buildTickTelemetryPayload,
  marketTickAcceptedLogMetadata,
  shouldLogBayesianPosteriorUpdate,
  shouldLogMarketTickAccepted
} from "./engine/trading/telemetry/TickTelemetryRuntime";
import { type ReplayOptions, type ReplayScenario } from "./engine/trading/routes/ReplayAdminRoutes";
import { markHistoricalReplayTrades, ReplayJournal } from "./engine/trading/replay/ReplayJournal";
import {
  runShadowReplayLoop,
  type ShadowReplayLoopResult
} from "./engine/trading/replay/ReplayLoopRuntime";
import {
  buildHistoricalReplayResult,
  buildReplayStatus,
  buildShadowReplayConfig,
  buildShadowReplayEngineState,
  resolveInitialShadowBankroll
} from "./engine/trading/replay/ReplayResultRuntime";
import {
  buildReplayRestoreWrites,
  hydrateReplayOrderBooks,
  type EngineReplaySnapshot
} from "./engine/trading/replay/ReplaySnapshotRuntime";
import type {
  GrpcFatalDropPayload,
  TickIngestResult
} from "./engine/trading/TradingEngineRouteTypes";
import {
  buildHealthReport,
  engineDiagnostics as buildEngineDiagnostics,
  stateAfterHealthHeartbeat,
  syncStateMicrostructureFromBook as syncEngineStateMicrostructure
} from "./engine/trading/state/EngineDiagnostics";
import { nextTickAgentHealth } from "./engine/trading/state/AgentHealthRuntime";
import {
  killSwitchActiveLogMetadata,
  shadowModeAutoResumeLogMetadata,
  shadowModeAutoResumeTelemetry,
  shouldAutoResumeShadowMode,
  shouldBlockHaltedTrading,
  shouldLogDisabledTrading,
  stateAfterAcceptedTick,
  stateAfterShadowModeAutoResume
} from "./engine/trading/state/TickStateRuntime";
import {
  buildHotPathTickSnapshotWrites,
  shouldJournalMarketTick as shouldPersistMarketTick
} from "./engine/trading/state/TickPersistenceRuntime";
import {
  adminRecoveryResponse,
  adminRecoveryStorageEntries,
  stateAfterAdminControlledRecovery
} from "./engine/trading/state/RecoveryRuntime";
import {
  evaluateHotStorageSnapshotDecision,
  resolveHotStorageSnapshotIntervalMs,
  resolveHotStorageSnapshotTickInterval,
  StorageWriteGuard
} from "./engine/trading/state/StorageWriteGuard";
import {
  emptyLogPruneReport,
  logRetentionPolicyToJson,
  pruneOperationalLogsFromD1,
  resolveLogRetentionPolicy,
  type LogPruneReport
} from "./engine/LogRetention";
import {
  MultiScaleVolatilityModel,
  type MultiScaleVolatilitySnapshot
} from "./engine/MultiScaleVolatility";
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
import { RateLimiter, type RateLimitBucketSnapshot } from "./utils/RateLimiter";
import { Notifier } from "./utils/Notifier";
import { isShadowMode } from "./utils/CitadelProtocol";
import { GhostBook, type GhostBookConfig, type GhostBookObservation } from "./utils/GhostBook";
import { AbsorptionAnalyzer } from "./strategy/cascade/AbsorptionAnalyzer";
import type { CascadeAssetProfile } from "./strategy/cascade/AssetProfiles";
import { Backtester } from "./strategy/cascade/Backtester";
import { CascadeCandleAggregator } from "./strategy/cascade/CandleAggregator";
import { CascadeDetector } from "./strategy/cascade/CascadeDetector";
import { CascadeRecoverySignalEngine } from "./strategy/cascade/CascadeRecoverySignal";
import { calculateAtr } from "./strategy/cascade/indicators/ATR";
import { cumulativeVolumeDelta } from "./strategy/cascade/indicators/CumulativeVolumeDelta";
import { HyperliquidLiquidationStream } from "./strategy/cascade/LiquidationStream";
import { HeatManager } from "./strategy/cascade/HeatManager";
import { NewsCalendar } from "./strategy/cascade/NewsCalendar";
import type { CascadeAlertEventType } from "./strategy/cascade/OperationalSafeguards";
import { PositionManager } from "./strategy/cascade/PositionManager";
import { calculatePositionSize } from "./strategy/cascade/PositionSizer";
import { calculateVwap } from "./strategy/cascade/indicators/VWAP";
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
  ShadowQueueDecision,
  ShadowQueueFill,
  ShadowQueueState,
  TemporaryGovernanceOverride,
  TradeIntent
} from "./types";
import type {
  AbsorptionAnalyzerConfig,
  AbsorptionConfirmed,
  CascadeDetectorConfig,
  CascadeEvent,
  CascadeOpenPosition,
  CascadePositionIntent,
  CascadeRecoverySignal,
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
  DEFAULT_HARD_STALE_DROP_MS,
  DEFAULT_HL_BOOK_TIMESTAMP_MAX_DRIFT_MS,
  DEFAULT_HL_SEQUENCE_GAP_MS,
  PERFORMANCE_HISTORY_LIMIT,
  CONFIG_ALARM_INTERVAL_MS,
  WARM_UP_INTERVAL_MS,
  SIGNAL_BUFFER_LIMIT,
  ADMIN_STREAM_PULSE_INTERVAL_MS,
  AGENT_SNAPSHOT_TICK_INTERVAL,
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
  DEFAULT_AMM_MIN_TICK_CHANGE,
  DEFAULT_HEATMAP_PRICE_BIN_SIZE,
  DEFAULT_HEATMAP_CLUSTER_NOTIONAL_USD,
  DEFAULT_CASCADE_DISTANCE_PCT,
  DEFAULT_PAPER_BANKROLL_USD,
  DEFAULT_PAPER_FILL_PARTICIPATION_RATE,
  DEFAULT_PAPER_FILL_ADVERSE_BPS,
  DEFAULT_PAPER_MAKER_FEE_BPS,
  DEFAULT_QUOTE_REFRESH_MIN_INTERVAL_MS,
  DEFAULT_QUOTE_REFRESH_MIN_PRICE_TICKS,
  DEFAULT_CROSS_ASSET_CANCEL_LEAD_BPS,
  DEFAULT_CROSS_ASSET_CANCEL_COOLDOWN_MS,
  DEFAULT_MARKET_TICK_MAX_ROWS,
  DEFAULT_SHADOW_VLO_CAPACITY,
  DEFAULT_SHADOW_VLO_DRIFT_TRADES,
  DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
  DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS,
  DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS,
  DEFAULT_VAR_CONFIDENCE_Z,
  TARGET_ASSET_MATRIX,
  TARGET_INSTRUMENTS,
  DEFAULT_JANITOR_INTERVAL_MS,
  DEFAULT_ORDER_ACK_TIMEOUT_MS,
  AGGREGATED_BUS_TELEMETRY_TYPES
} from "./TradingEngineConstants";
import {
  epochMillis,
  nativeHashSequence,
  normalizeNativeCoin,
  normalizeNativeInstrumentCode,
  splitNativeInstrument,
  baseAssetFromInstrument,
  cascadeInstrumentSet,
  latestAbsorptionForInstrument,
  latestCascadeAtForInstrument,
  isOpenCascadePosition,
  recentSwingLow,
  recentSwingHigh,
  nativeBookSideLevels,
  nativeNumber,
  nativeSide,
  hasRuntimeConfigUpdate,
  defaultEngineState,
  defaultEnsembleState,
  normalizePaperBankroll,
  parseDeltaNormalizationWeights,
  touchAgentHealth,
  disabledProfilerEvaluation,
  disabledCroupierDecision,
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
  defaultSlippageAnalytics,
  defaultRiskLimits,
  mergeRiskLimits,
  resolveMaxLatencyMs,
  prometheusLabels,
  escapePrometheusLabel,
  finiteMetric,
  nullableFiniteMetric,
  highResolutionNow,
  roundLatency,
  resolveBookSide,
  resolveCurrentInstrument,
  buildMarketKey,
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
  aggregateQuoteState,
  quotePriceMovedTicks,
  normalizeMarketKey,
  normalizeSourceExchange,
  normalizeSourceWeight,
  sanitizeWallHistory,
  deepClone,
  hydrateOrderBooks,
  hydrateLegacyLevel,
  levelsToBookSide,
  tickToDelta,
  calculateTimeToBookMs,
  resolveTickSize,
  resolveDomBinSize,
  parseTickSizeMap,
  parsePositiveNumberMap,
  wait,
  readNumber,
  readPositiveNumber,
  applyReplayScenarioToTick,
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

interface TickHandlingOptions {
  shadowReplay?: boolean;
}

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
      this.profilerRegistry.hydrate(persistedProfilerState, persistedProfilerStates);
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
      this.profilerRegistry.configure(this.cachedConfig);
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
        toxicityScore: baseState.toxicityScore ?? this.profilerRegistry.maxToxicity(),
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
        profilerStates: this.profilerRegistry.snapshot(),
        location,
        fundingRates: baseState.fundingRates ?? {},
        microstructure: baseState.microstructure ?? defaultMicrostructure(),
        priceDiscovery:
          baseState.priceDiscovery ??
          calculateOrderBookPriceDiscovery(
            this.orderBook,
            baseState.microstructure?.instrumentCode,
            now
          ),
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
      return acceptTradingTelemetryStream(this.streamContext());
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return acceptTradingMarketStream(this.streamContext());
    }

    try {
      return await handleTradingEngineHttpRoute(
        request,
        url,
        this.engineHttpRouteContext(wakeUpTimeMs)
      );
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

  private engineHttpRouteContext(wakeUpTimeMs: number | null): EngineHttpRouteContext {
    return {
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
        this.runHistoricalReplay(limit, shadowBankroll, speedMultiplier, dateFrom, dateTo, options),
      currentReplayStatus: () => this.replayJournal.currentStatus(),
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
    };
  }

  healthCheck(): HealthReport {
    const now = new Date().toISOString();
    this.syncStateMicrostructureFromBook();
    this.engineState = stateAfterHealthHeartbeat(this.engineState, now);
    this.waitUntilStoragePut(ENGINE_STATE_KEY, this.engineState, "HEALTH_HEARTBEAT");

    return buildHealthReport({
      engineState: this.engineState,
      uptimeMs: Date.now() - this.startedAt
    });
  }

  private syncStateMicrostructureFromBook(): void {
    const nextState = syncEngineStateMicrostructure({
      engineState: this.engineState,
      orderBook: this.orderBook,
      bids: this.bids,
      asks: this.asks,
      calculatePriceDiscovery: (instrumentCode, observedAt) =>
        calculateOrderBookPriceDiscovery(this.orderBook, instrumentCode, observedAt),
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
      profilerStateSnapshot: () => this.profilerRegistry.snapshot()
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

  private async deleteRetiredProfilerStorage(): Promise<string[]> {
    return this.profilerRegistry.deleteRetiredStorage(this.state.storage, (reason, error) =>
      this.handleStorageWriteFailure(reason, error)
    );
  }

  private calculateAssetMatrix(
    observedAt: string,
    latestInstrumentCode: string | undefined,
    latestOracle: EngineState["oracle"],
    profilerStates: Record<string, ProfilerState>,
    assetQuoteStates: EngineState["assetQuoteStates"] = this.engineState.assetQuoteStates
  ): Record<string, AssetRuntimeState> {
    const maxPositionPct =
      this.cachedConfig.MAX_POSITION_PCT > 0
        ? this.cachedConfig.MAX_POSITION_PCT
        : readPositiveNumber(this.env.MAX_POSITION_PCT, DEFAULT_MAX_POSITION_PCT);

    return calculateRuntimeAssetMatrix({
      observedAt,
      latestOracle,
      profilerStates,
      assetQuoteStates,
      fallbackQuoteState: this.engineState.quoteState,
      macroBias: this.macroBias,
      equity: this.engineState.bankroll.equity,
      maxPositionPct,
      findBestAssetBook: (instrumentCode) =>
        findBestOrderBookForAsset(this.orderBook, instrumentCode),
      profilerStateForInstrument: (instrumentCode) =>
        this.profilerRegistry.forInstrument(instrumentCode).snapshot()
    });
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
    const decision = evaluateHotStorageSnapshotDecision({
      lastSnapshotAtMs: this.lastHotStorageSnapshotAt,
      lastSnapshotTick: this.lastHotStorageSnapshotTick,
      nowMs: Date.now(),
      tickCount: this.engineState.processedTicks,
      intervalMs: resolveHotStorageSnapshotIntervalMs(this.env.HOT_STORAGE_SNAPSHOT_INTERVAL_MS),
      tickInterval: resolveHotStorageSnapshotTickInterval(
        this.env.HOT_STORAGE_SNAPSHOT_TICK_INTERVAL
      )
    });

    if (!decision.shouldPersist) {
      return;
    }

    this.lastHotStorageSnapshotAt = decision.nextSnapshotAtMs;
    this.lastHotStorageSnapshotTick = decision.nextSnapshotTick;
    await this.safeStoragePut(entries, reason);
  }

  private handleStorageWriteFailure(reason: string, error: unknown): void {
    this.storageGuard.recordFailure(reason, error);
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
      nextBusSequence: () => this.telemetryBus.nextSequence()
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
    const route = routeHyperliquidRawMessage(raw);

    if (route.kind === "CONTROL") {
      return { accepted: true, status: "FRESH", processedCount: 0 };
    }

    if (route.kind === "L2_BOOK") {
      return this.handleHyperliquidL2Book(route.raw, payload, wakeUpTimeMs);
    }

    if (route.kind === "TRADES") {
      return this.handleHyperliquidTrades(route.raw, payload, wakeUpTimeMs);
    }

    if (route.kind === "ASSET_CONTEXT") {
      return this.handleHyperliquidAssetContext(route.raw, payload, wakeUpTimeMs);
    }

    if (route.kind === "LIQUIDATION_EVENTS") {
      return this.handleHyperliquidLiquidationEvents(route.raw, payload);
    }

    return {
      accepted: false,
      status: "BOOK_NOT_READY",
      reason: route.reason,
      processedCount: 0
    };
  }

  private async handleHyperliquidL2Book(
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult> {
    const hotPathStartedAt = highResolutionNow();
    const nativeMaxLatencyMs = resolveNativeHyperliquidMaxLatencyMs({
      transport: payload.transport,
      streamId: payload.streamId,
      dwellirMaxLatencyMs: this.env.DWELLIR_MAX_LATENCY_MS,
      hlStaleAfterMs: this.env.HL_STALE_AFTER_MS,
      currentMaxLatencyMs: this.maxLatencyMs
    });
    const l2Decision = evaluateHyperliquidL2BookHotPath({
      raw,
      payload,
      resolveExistingSync: (marketKey) => this.bookSync.get(marketKey),
      maxTimestampDriftMs: readPositiveNumber(
        this.env.HL_BOOK_TIMESTAMP_MAX_DRIFT_MS,
        DEFAULT_HL_BOOK_TIMESTAMP_MAX_DRIFT_MS
      ),
      sequenceGapMs: readPositiveNumber(this.env.HL_SEQUENCE_GAP_MS, DEFAULT_HL_SEQUENCE_GAP_MS),
      nativeMaxLatencyMs,
      averageLatencyMs: this.engineState.averageLatency,
      sampleCount: this.engineState.latencySampleCount,
      location: this.engineState.location
    });
    const { instrumentCode, sequence, marketKey, snapshot } = l2Decision.bundle;

    if (l2Decision.kind === "DUPLICATE_OR_OUT_OF_ORDER") {
      return l2Decision.result;
    }

    if (l2Decision.kind === "DESYNC") {
      markBookSyncDesynced({
        syncState: this.bookSync.get(marketKey),
        reason: l2Decision.sequenceDecision.reason,
        observedAt: l2Decision.sequenceDecision.lastDesyncAt
      });
      this.logger.warn(
        "ORDER_BOOK_DESYNC",
        "Hyperliquid native book sequence gap detected",
        hyperliquidBookDesyncLogMetadata(l2Decision.bundle, l2Decision.sequenceDecision)
      );
      return l2Decision.result;
    }

    const { brainTimestamp, totalLatencyMs } = l2Decision;

    if (l2Decision.kind === "STALE") {
      const book =
        snapshot.bids.length > 0 || snapshot.asks.length > 0
          ? await this.applySnapshot(snapshot, { telemetry: false, persist: false })
          : undefined;
      if (book) {
        if (isCrossedBook(book)) {
          await this.orderBookReconstructor.handleCrossedBookSnapshot(
            book,
            sequence,
            totalLatencyMs,
            brainTimestamp
          );
        } else {
          const syncState = this.bookSync.get(marketKey);
          markBookSyncDesynced({
            syncState,
            reason: "NATIVE_HL_LATENCY",
            observedAt: brainTimestamp
          });
          const staleBook = stateAfterDesyncedBook({
            currentState: this.engineState,
            book,
            reason: "NATIVE_HL_LATENCY"
          });
          this.orderBook.set(marketKey, staleBook.book);
          this.engineState = staleBook.state;
        }
      }
      const metrics = l2Decision.metrics;
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
        buildHyperliquidL2BookTick({
          payload,
          bundle: l2Decision.bundle,
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
      await this.orderBookReconstructor.handleCrossedBookSnapshot(
        book,
        sequence,
        totalLatencyMs,
        brainTimestamp
      );
      return {
        accepted: false,
        status: "DESYNC",
        reason: "CROSSED_BOOK",
        book,
        processedCount: 0
      };
    }

    const representativeTick = buildHyperliquidL2BookTickFromBook({
      payload,
      bundle: l2Decision.bundle,
      book,
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
    return processHyperliquidTradeBatch(raw, payload, wakeUpTimeMs, {
      processTick: (tick, wakeUp) => this.handleTick(tick, wakeUp)
    });
  }

  private async handleHyperliquidAssetContext(
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult> {
    return processHyperliquidAssetContext(raw, payload, wakeUpTimeMs, {
      processTick: (tick, wakeUp) => this.handleTick(tick, wakeUp)
    });
  }

  private async handleHyperliquidLiquidationEvents(
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload
  ): Promise<TickIngestResult> {
    const liquidationContext = resolveLiquidationEventContext({
      payload,
      currentInstrumentCode: this.engineState.microstructure.instrumentCode,
      defaultAsset: this.env.HL_ASSET,
      midPrice: this.engineState.microstructure.midPrice
    });
    const previousEventCount = this.engineState.liquidationHeatmap.recentEvents.length;
    const heatmap = this.heatmapAgent.recordLiquidationEvent(raw, {
      instrumentCode: liquidationContext.instrumentCode,
      sourceExchange: liquidationContext.sourceExchange,
      midPrice: liquidationContext.midPrice,
      observedAt: liquidationContext.observedAt
    });
    const nextEventCount = heatmap.recentEvents.length;
    const cascadeLiquidations = this.cascadeLiquidationStream.ingest(raw, {
      instrumentCode: liquidationContext.instrumentCode,
      sourceExchange: liquidationContext.sourceExchange,
      observedAt: liquidationContext.observedAt,
      fallbackPrice: liquidationContext.midPrice
    });
    if (cascadeLiquidations.length > 0) {
      this.state.waitUntil(this.persistCascadeLiquidations(cascadeLiquidations));
    }
    const cascadeEvents = this.recordCascadeLiquidations(
      cascadeLiquidations,
      liquidationContext.observedAt
    );

    this.engineState = stateAfterLiquidationHeatmap({
      currentState: this.engineState,
      heatmap,
      observedAt: liquidationContext.observedAt
    });

    this.state.waitUntil(
      this.safeStoragePut(
        liquidationHeatmapStorageWrites({
          engineStateKey: ENGINE_STATE_KEY,
          state: this.engineState,
          liquidationHeatmapKey: LIQUIDATION_HEATMAP_STORAGE_KEY,
          heatmap
        }),
        "LIQUIDATION_EVENT"
      )
    );

    if (nextEventCount > previousEventCount) {
      this.publish(
        "LIQUIDATION_EVENT",
        liquidationEventTelemetry({
          instrumentCode: liquidationContext.instrumentCode,
          heatmap,
          cascadeEventCount: cascadeEvents.length,
          observedAt: liquidationContext.observedAt
        })
      );
    }

    return {
      accepted: true,
      status: "FRESH",
      processedCount: liquidationEventProcessedCount({
        previousEventCount,
        nextEventCount,
        cascadeLiquidationCount: cascadeLiquidations.length,
        cascadeEventCount: cascadeEvents.length
      })
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
      this.logger.warn(
        "CASCADE_DETECTED",
        "Liquidation cascade detected",
        cascadeDetectedLogMetadata(cascade)
      );
      this.publish(
        "CASCADE_DETECTED",
        cascadeDetectedTelemetryPayload(cascade, this.cascadeAssetProfile(cascade.instrumentCode))
      );
      this.emitCascadeOperationalAlert(
        "CASCADE_DETECTED",
        "Cascade detected",
        `${cascade.instrumentCode} ${cascade.direction} liquidation cascade detected.`,
        cascadeDetectedAlertMetadata(cascade),
        cascade.cascadeId
      );
    }

    return cascades;
  }

  private async persistCascadeLiquidations(events: LiquidationEvent[]): Promise<void> {
    try {
      await persistCascadeLiquidationEvents(this.env.TRADING_DB, events);
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
    const markPriceContext = {
      orderBook: this.orderBook,
      assetMatrix: this.engineState.assetMatrix,
      microstructure: this.engineState.microstructure
    };

    return buildCurrentCascadePositionSnapshot({
      positions: this.cascadePositionManager.snapshot(),
      nowMs: Date.now(),
      markPriceForInstrument: (instrumentCode) =>
        nullableMarkPriceForInstrument(markPriceContext, instrumentCode)
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
    const position = this.cascadePositionManager
      .snapshot()
      .find((candidate) => candidate.positionId === positionId);

    if (!position || !isOpenCascadePosition(position)) {
      return { ok: false, error: "CASCADE_POSITION_NOT_OPEN" };
    }

    const observedAt = new Date().toISOString();
    const markPrice =
      nullableMarkPriceForInstrument(
        {
          orderBook: this.orderBook,
          assetMatrix: this.engineState.assetMatrix,
          microstructure: this.engineState.microstructure
        },
        position.instrumentCode
      ) ?? position.entryPrice;
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

    this.logger.warn(
      "CASCADE_POSITION_MANUAL_CLOSE",
      "Operator requested cascade position close",
      cascadeManualCloseLogMetadata({
        position,
        actor,
        reason,
        markPrice,
        observedAt
      })
    );
    this.publish(
      "CASCADE_POSITION_MANUAL_CLOSE",
      cascadeManualCloseTelemetryPayload({
        position,
        actor,
        reason,
        markPrice,
        observedAt
      }),
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

  private currentCascadeDetectorConfig(instrumentCode: string): CascadeDetectorConfig {
    return buildCascadeDetectorConfig({
      config: this.cachedConfig,
      profile: this.cascadeAssetProfile(instrumentCode),
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
    });
  }

  private cascadeAssetProfile(instrumentCode: string): CascadeAssetProfile {
    return cascadeAssetProfileFromConfig(instrumentCode, this.cachedConfig);
  }

  private currentAbsorptionAnalyzerConfig(): AbsorptionAnalyzerConfig {
    return buildAbsorptionAnalyzerConfig({
      config: this.cachedConfig,
      oiStabilityBps: readPositiveNumber(this.env.ABSORPTION_OI_STABILITY_BPS, 5),
      maxActiveCascades: readPositiveInteger(this.env.ABSORPTION_MAX_ACTIVE_CASCADES, 24, 1, 100)
    });
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

    const cumulativeVolumeDelta = nextCascadeCvd(
      this.cascadeCvdByInstrument.get(instrumentCode) ?? 0,
      tick
    );
    this.cascadeCvdByInstrument.set(instrumentCode, cumulativeVolumeDelta);

    this.absorptionAnalyzer.configure(this.currentAbsorptionAnalyzerConfig());
    const confirmed = this.absorptionAnalyzer.observe(
      buildCascadeAbsorptionObservation({
        tick,
        instrumentCode,
        cumulativeVolumeDelta
      })
    );

    if (!confirmed) {
      return;
    }

    this.cascadeAbsorptionsById.set(confirmed.cascadeId, confirmed);
    this.logger.info(
      "ABSORPTION_CONFIRMED",
      "Liquidation cascade absorption confirmed",
      absorptionConfirmedLogMetadata(confirmed)
    );
    this.publish("ABSORPTION_CONFIRMED", absorptionConfirmedTelemetryPayload(confirmed));
    this.emitCascadeOperationalAlert(
      "CASCADE_ABSORPTION_CONFIRMED",
      "Cascade absorption confirmed",
      `${confirmed.instrumentCode} absorption confirmed after ${confirmed.elapsedMs}ms.`,
      absorptionConfirmedAlertMetadata(confirmed),
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
          cascadeSignalRejectionLogMetadata(signalResult.rejection)
        );
        this.recordCascadeUiSignal(
          cascadeSignalRejectionAgentSignal({
            rejection: signalResult.rejection,
            engineId: this.engineState.engineId,
            observedAt,
            entryWindowMs: this.cachedConfig.ENTRY_WINDOW_SECONDS * 1_000
          }),
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
        const closeAlert = cascadeCloseOperationalAlert(intent, observedAt);
        if (closeAlert) {
          this.emitCascadeOperationalAlert(
            closeAlert.eventType,
            closeAlert.title,
            closeAlert.message,
            closeAlert.metadata,
            closeAlert.dedupeKey
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
      cascadeSignalEmittedAlertMetadata(signal),
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
      this.logger.warn(
        "CASCADE_SIZE_REJECTED",
        "Cascade recovery position sizing rejected entry",
        cascadeSizeRejectedLogMetadata(signal, sizeDecision)
      );
      if (sizeDecision.limitingFactor === "HEAT") {
        this.emitCascadeOperationalAlert(
          "HEAT_CAP_EXCEEDED",
          "Cascade heat cap blocked entry",
          `${signal.instrumentCode} cascade entry was rejected by the heat cap.`,
          cascadeHeatCapAlertMetadata(
            signal,
            sizeDecision,
            currentHeat,
            this.cachedConfig.HEAT_CAP_PCT
          ),
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
    const cascadeEntryContext = {
      signal,
      intent,
      engineId: this.engineState.engineId,
      position,
      assetProfile,
      sizeDecision,
      observedAt
    };
    this.recordCascadeUiSignal(cascadeEntryAgentSignal(cascadeEntryContext), "TAKEN");
    this.logger.traceDecision(cascadeEntryDecisionTrace({ ...cascadeEntryContext, currentHeat }));
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
      cascadePositionOpenedAlertMetadata(cascadeEntryContext),
      position.positionId
    );
  }

  private cascadeSignalEngineWithConfig(): CascadeRecoverySignalEngine {
    return new CascadeRecoverySignalEngine(buildCascadeRecoverySignalConfig(this.cachedConfig));
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
    const { observedAt, disconnectedForMs, thresholdMs, reason } =
      resolveGrpcFatalDropPayload(payload);
    const grpcDrop = stateAfterGrpcFatalDrop({
      currentState: this.engineState,
      disconnectedForMs,
      thresholdMs,
      reason,
      observedAt,
      shadowMode: isShadowMode(this.env)
    });
    const { citadel } = grpcDrop;
    const events = buildGrpcFatalDropEventArtifacts({
      payload,
      resolved: {
        observedAt,
        disconnectedForMs,
        thresholdMs,
        reason
      },
      citadel
    });
    this.engineState = grpcDrop.state;
    this.state.waitUntil(
      this.persistHotStorageSnapshot(
        {
          [ENGINE_STATE_KEY]: this.engineState
        },
        "GRPC_FATAL_DROP"
      )
    );
    this.logger.error(
      events.telemetryType,
      "Dwellir gRPC blackout forced quote evacuation",
      events.logMetadata
    );
    this.publish(events.telemetryType, events.telemetryPayload);
    if (events.shouldCancelAllQuotes) {
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
    const stalePull = stateAfterNativeHyperliquidLatencyPull({
      currentState: this.engineState,
      metrics,
      instrumentCode,
      sequence,
      observedAt
    });
    this.latencyHistory = [...this.latencyHistory, stalePull.metrics].slice(
      -PERFORMANCE_HISTORY_LIMIT
    );
    this.engineState = stalePull.state;
    this.state.waitUntil(
      this.persistHotStorageSnapshot(
        nativeHyperliquidLatencyPullStorageWrites({
          engineStateKey: ENGINE_STATE_KEY,
          state: this.engineState,
          performanceHistoryKey: PERFORMANCE_HISTORY_KEY,
          latencyHistory: this.latencyHistory,
          processingLatencySamplesKey: PROCESSING_LATENCY_SAMPLES_KEY,
          processingLatencySamples: this.processingLatencySamples
        }),
        "NATIVE_HL_LATENCY_PULL"
      )
    );
    this.logPerformance(stalePull.metrics);
    this.publish(stalePull.telemetryType, stalePull.telemetryPayload);
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
    const registration = registerHyperliquidIngestConnection(this.activeIngestConnections, payload);

    if (!registration.registered) {
      return registration as unknown as Record<string, unknown>;
    }

    this.engineState = stateAfterHealthHeartbeat(this.engineState, registration.observedAt);
    this.waitUntilStoragePut(ENGINE_STATE_KEY, this.engineState, "INGEST_CONNECTION_REGISTERED");

    return registration as unknown as Record<string, unknown>;
  }

  private async resetOrderBook(payload: Partial<OrderBookResetRequest>): Promise<void> {
    const reset = resolveOrderBookReset(payload);
    let persistedBooks = new Map<string, InternalOrderBook>();
    try {
      persistedBooks = await this.state.storage.list<InternalOrderBook>({
        prefix: ORDER_BOOK_PREFIX
      });
    } catch (error) {
      this.handleStorageWriteFailure("ORDER_BOOK_RESET_LIST", error);
    }
    const deleteKeys = orderBookResetDeleteKeys(
      persistedBooks,
      ORDER_BOOK_PREFIX,
      reset.resetMarketKey
    );
    applyOrderBookResetStores(this.orderBookStores(), reset.resetMarketKey);

    this.engineState = stateAfterOrderBookReset({
      currentState: this.engineState,
      resetMarketKey: reset.resetMarketKey,
      resetInstrument: reset.resetInstrument,
      orderBookSize: this.orderBook.size,
      internalOrderBookDepth: countBookLevels(this.bids, this.asks),
      now: reset.now,
      priceDiscovery: reset.resetInstrument
        ? calculateOrderBookPriceDiscovery(this.orderBook, reset.resetInstrument, reset.now)
        : null
    });

    if (reset.source === "INGEST_WORKER") {
      this.resetLatencyBaseline(reset.now, `ORDER_BOOK_RESET:${reset.reason}`);
      if (reset.connectionId) {
        for (const connectionKey of orderBookResetConnectionKeys(reset)) {
          this.activeIngestConnections.set(connectionKey, reset.connectionId);
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

    const resetTelemetry = orderBookResetTelemetry(reset, deleteKeys.length);
    this.logger.warn(
      "ORDER_BOOK_RESET",
      "Internal order book purged after stream recovery",
      resetTelemetry
    );

    this.publish("ORDER_BOOK_RESET", resetTelemetry);
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
    const paperBankroll = readPositiveNumber(
      this.env.PAPER_BANKROLL_USD,
      DEFAULT_PAPER_BANKROLL_USD
    );
    const recovery = stateAfterAdminControlledRecovery({
      currentState: this.engineState,
      payload,
      cachedConfig: this.cachedConfig,
      macroBias: this.macroBias,
      observedAt,
      shadowMode: isShadowMode(this.env),
      paperBankroll,
      shadowQueue: this.ghostBook.snapshot(observedAt),
      reason,
      resetInstruments,
      sourceExchange,
      prunedProfilerStorageKeys
    });

    this.engineState = recovery.state;

    await this.safeStoragePut(
      adminRecoveryStorageEntries({
        engineStateKey: ENGINE_STATE_KEY,
        state: this.engineState,
        performanceHistoryKey: PERFORMANCE_HISTORY_KEY,
        latencyHistory: this.latencyHistory,
        processingLatencySamplesKey: PROCESSING_LATENCY_SAMPLES_KEY,
        processingLatencySamples: this.processingLatencySamples
      }),
      "ADMIN_CONTROLLED_RECOVERY"
    );

    if (payload.resetPaperPortfolio) {
      this.state.waitUntil(this.env.CONFIG_STORE.put(PAPER_SESSION_STARTED_AT_KEY, observedAt));
    }

    this.logger.warn("ADMIN_CONTROLLED_RECOVERY", "Admin controlled recovery applied", {
      ...recovery.logMetadata
    });
    this.publish("ADMIN_CONTROLLED_RECOVERY", recovery.publishPayload);

    return adminRecoveryResponse({
      reason,
      resetInstruments,
      sourceExchange,
      state: this.engineState
    });
  }

  private async applySnapshot(
    snapshot: OrderBookSnapshot,
    options: { telemetry?: boolean; persist?: boolean } = {}
  ): Promise<InternalOrderBook> {
    const updatedAt = new Date().toISOString();
    const applied = this.orderBookReconstructor.applySnapshot(snapshot, updatedAt);
    const book = applied.book;
    const domSnapshot = this.getLiquidityWalls(applied.instrumentCode, updatedAt);

    this.engineState = stateAfterBookSnapshot({
      currentState: this.engineState,
      book,
      internalOrderBookDepth: countBookLevels(this.bids, this.asks),
      priceDiscovery: calculateOrderBookPriceDiscovery(
        this.orderBook,
        applied.instrumentCode,
        updatedAt
      ),
      dom: domSnapshot,
      updatedAt
    });

    if (options.persist !== false) {
      await this.safeStoragePut(
        bookSnapshotStorageWrites({
          engineStateKey: ENGINE_STATE_KEY,
          state: this.engineState,
          domWallHistoryKey: DOM_WALL_HISTORY_KEY,
          domWallHistory: this.domWallHistory,
          orderBookPrefix: ORDER_BOOK_PREFIX,
          marketKey: applied.marketKey,
          book
        }),
        "ORDER_BOOK_SNAPSHOT_APPLIED"
      );
    }

    const shouldEmitTelemetry = shouldEmitBookSnapshotTelemetry({
      telemetryEnabled: options.telemetry !== false,
      snapshotSource: snapshot.source,
      processedTicks: this.engineState.processedTicks,
      earlyTickLimit: 5,
      interval: AGENT_SNAPSHOT_TICK_INTERVAL
    });

    if (shouldEmitTelemetry) {
      const telemetry = bookSnapshotTelemetry(applied);
      this.logger.info(
        "ORDER_BOOK_SNAPSHOT_APPLIED",
        "Full order book snapshot applied",
        telemetry
      );
      this.publish("ORDER_BOOK_SNAPSHOT_APPLIED", telemetry);
    }

    return book;
  }

  private async applyDelta(
    delta: BookDeltaWithTicker,
    updatedAt: string
  ): Promise<AppliedBookUpdate> {
    const applied = await this.orderBookReconstructor.applyDelta(delta, updatedAt);

    if (applied.accepted && applied.book) {
      this.engineState = stateAfterAcceptedBookDelta({
        currentState: this.engineState,
        book: applied.book,
        priceDiscovery: calculateOrderBookPriceDiscovery(
          this.orderBook,
          applied.book.instrumentCode,
          updatedAt
        )
      });
    }

    return applied;
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
    return {
      orderBook: this.orderBook,
      bids: this.bids,
      asks: this.asks,
      microstructure: this.engineState.microstructure,
      domWallHistory: this.domWallHistory,
      domWallHistoryLimit: this.domWallHistoryLimit,
      domScanRangePct: this.domScanRangePct,
      domSpoofProximityBps: this.domSpoofProximityBps,
      domMaxLevelsPerSide: DOM_MAX_LEVELS_PER_SIDE,
      resolveBinSize: (code: string) => resolveDomBinSize(this.env, code, this.domPriceBinSize)
    };
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
    const hardStale = stateAfterHardStaleTickDrop({
      currentState: this.engineState,
      metrics,
      hardStaleDropMs
    });
    this.engineState = hardStale.state;

    if (hardStale.shouldResetLatencyBaseline) {
      this.resetLatencyBaseline(hardStale.metrics.brainTimestamp, "HARD_STALE_DROP");
    }

    await this.persistHotStorageSnapshot(this.latencyStorageWrites(), "HARD_STALE_TICK_DROPPED");

    const staleTelemetry = {
      tick,
      metrics: hardStale.metrics,
      streamId,
      hardStaleDropMs
    };

    if (shouldLogHardStaleTickDrop(hardStale.nextStaleTickCount)) {
      this.logger.warn("HARD_STALE_TICK_DROPPED", "Dropped tick beyond hard stale threshold", {
        ...hardStaleTickDropLogMetadata(staleTelemetry)
      });
    }
    this.logPerformance(hardStale.metrics);
    this.publish("STALE_DATA_KILL_SWITCH", hardStalePullTelemetryPayload(staleTelemetry));
    if (this.cachedConfig.TRADING_ENABLED) {
      this.state.waitUntil(this.cancelAllQuotes(tick.instrumentCode, "HARD_STALE_DROP"));
    }

    return {
      accepted: false,
      status: "STALE_DROPPED",
      reason: "TICK_EXCEEDED_HARD_STALE_THRESHOLD",
      metrics: hardStale.metrics
    };
  }

  private async handleSoftStaleTick(
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    hotPathStartedAt: number
  ): Promise<TickIngestResult> {
    this.observeExecutionProfile(metrics, {
      wakeUpTimeMs,
      orderBookUpdateMs: null,
      agentLogicMs: null,
      hotPathStartedAt,
      observedAt: metrics.brainTimestamp
    });

    const staleState = stateAfterStaleDataKillSwitch({
      currentState: this.engineState,
      metrics,
      instrumentCode: tick.instrumentCode,
      maxLatencyMs: this.maxLatencyMs,
      quoteHibernateMs: resolveQuoteHibernateMs(this.cachedConfig, this.env.QUOTE_HIBERNATE_MS)
    });
    this.engineState = staleState.state;
    const staleKillSwitch = {
      tick,
      metrics,
      maxLatencyMs: this.maxLatencyMs
    };

    await this.persistHotStorageSnapshot(
      this.latencyStorageWrites(staleDataKillSwitchStorageExtra(staleKillSwitch)),
      "STALE_DATA_KILL_SWITCH"
    );

    this.logPerformance(metrics);
    this.publish("STALE_DATA_KILL_SWITCH", staleDataKillSwitchTelemetryPayload(staleKillSwitch));
    this.notifier.notify(staleDataKillSwitchNotification(staleKillSwitch));
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

  private async handleInformationalBookNotReady(
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    orderBookUpdateMs: number,
    hotPathStartedAt: number
  ): Promise<TickIngestResult> {
    this.observeExecutionProfile(metrics, {
      wakeUpTimeMs,
      orderBookUpdateMs,
      agentLogicMs: null,
      hotPathStartedAt,
      observedAt: metrics.brainTimestamp
    });

    this.engineState = stateAfterInformationalBookNotReady({
      currentState: this.engineState,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      instrumentCode: tick.instrumentCode,
      maxLatencyMs: this.maxLatencyMs,
      observedAt: metrics.brainTimestamp
    });

    await this.persistHotStorageSnapshot(
      this.latencyStorageWrites(),
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

  private async handleRejectedBookDelta(
    tick: MarketTick,
    metrics: LatencyMetrics,
    applied: AppliedBookUpdate,
    wakeUpTimeMs: number | null,
    orderBookUpdateMs: number,
    hotPathStartedAt: number
  ): Promise<TickIngestResult> {
    this.observeExecutionProfile(metrics, {
      wakeUpTimeMs,
      orderBookUpdateMs,
      agentLogicMs: null,
      hotPathStartedAt,
      observedAt: metrics.brainTimestamp
    });

    if (applied.reason === "DUPLICATE_OR_OUT_OF_ORDER") {
      return {
        accepted: false,
        status: "DUPLICATE_OR_OUT_OF_ORDER",
        reason: applied.reason,
        metrics
      };
    }

    this.engineState = stateAfterRejectedBookDelta({
      currentState: this.engineState,
      internalOrderBookDepth: countBookLevels(this.bids, this.asks),
      maxLatencyMs: this.maxLatencyMs,
      observedAt: metrics.brainTimestamp
    });

    await this.persistHotStorageSnapshot(
      this.latencyStorageWrites(
        bookDesyncStorageExtra({
          tick,
          metrics,
          reason: applied.reason ?? "BOOK_UPDATE_REJECTED",
          expectedSequence: applied.expectedSequence,
          actualSequence: applied.actualSequence
        })
      ),
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
    const anomalyLogicMs = roundLatency(highResolutionNow() - anomalyLogicStartedAt);

    this.observeExecutionProfile(metrics, {
      wakeUpTimeMs,
      orderBookUpdateMs,
      agentLogicMs: anomalyLogicMs,
      hotPathStartedAt,
      observedAt: metrics.brainTimestamp
    });

    this.engineState = stateAfterAnomalyEmergencyPause({
      currentState: this.engineState,
      book,
      dom: domSnapshot,
      anomaly: anomalyResult.status,
      internalOrderBookDepth: countBookLevels(this.bids, this.asks),
      observedAt: metrics.brainTimestamp
    });

    await this.safeStoragePut(
      anomalyEmergencyPauseStorageWrites({
        engineStateKey: ENGINE_STATE_KEY,
        state: this.engineState,
        performanceHistoryKey: PERFORMANCE_HISTORY_KEY,
        latencyHistory: this.latencyHistory,
        processingLatencySamplesKey: PROCESSING_LATENCY_SAMPLES_KEY,
        processingLatencySamples: this.processingLatencySamples,
        domWallHistoryKey: DOM_WALL_HISTORY_KEY,
        domWallHistory: this.domWallHistory,
        anomalyDetectorStorageKey: ANOMALY_DETECTOR_STORAGE_KEY,
        anomalyResult,
        orderBookPrefix: ORDER_BOOK_PREFIX,
        book,
        tick
      }),
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

  private handleCroupierQuoteAction(
    instrumentCode: string,
    croupierQuoteAction: CroupierQuoteAction
  ): void {
    if (croupierQuoteAction.kind === "PULL_ALL_QUOTES") {
      this.publish(croupierQuoteAction.publish.type, croupierQuoteAction.publish.payload);
      if (croupierQuoteAction.cancelReason) {
        this.state.waitUntil(
          this.cancelAllQuotes(instrumentCode, croupierQuoteAction.cancelReason)
        );
      }
      return;
    }

    if (croupierQuoteAction.kind !== "POST_QUOTE") {
      return;
    }

    this.publish(
      croupierQuoteAction.publish.type,
      croupierQuoteAction.publish.payload,
      croupierQuoteAction.publish.correlationId
    );

    if (!croupierQuoteAction.shouldDispatch) {
      return;
    }

    const quote = croupierQuoteAction.quote;
    this.state.waitUntil(
      croupierQuoteAction.cascadeShieldCancelReason
        ? this.cancelAllQuotes(instrumentCode, croupierQuoteAction.cascadeShieldCancelReason).then(
            () => this.dispatchQuote(quote)
          )
        : this.dispatchQuote(quote)
    );
  }

  private dispatchExecutionPlans(
    executionPlans: readonly ApprovedExecutionPlan[],
    shadowReplay: boolean
  ): void {
    for (const plan of executionPlans) {
      const dispatchGate = evaluateIntentDispatchGate(this.engineState, plan.intent);
      const dispatchAction = buildExecutionPlanDispatchAction({
        plan,
        dispatchGate,
        shadowReplay,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED
      });

      if (dispatchAction.kind === "AUTHORIZED") {
        this.logger.info(
          "TRADE_INTENT_AUTHORIZED",
          "PitBoss authorized executable intent",
          dispatchAction.metadata
        );
        for (const childIntent of dispatchAction.childIntents) {
          this.state.waitUntil(this.dispatchExecution(childIntent, dispatchAction.timingJitterMs));
        }
      } else if (dispatchAction.kind === "BLOCKED") {
        this.logger.warn(
          "TRADE_INTENT_DISPATCH_BLOCKED",
          "Intent dispatch gate blocked execution",
          dispatchAction.metadata
        );
      } else if (dispatchAction.kind === "SHADOW") {
        this.logger.info(
          "SHADOW_TRADE_INTENT_AUTHORIZED",
          "Replay generated shadow trade intent",
          dispatchAction.metadata
        );
      }
    }
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
      shouldAutoResumeShadowMode({
        shadowReplay: options.shadowReplay === true,
        shadowMode: isShadowMode(this.env),
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        mode: this.engineState.mode
      })
    ) {
      const resumedAt = new Date().toISOString();
      const assetQuoteStates = normalizeAssetQuoteStates(
        defaultAssetQuoteStates(this.cachedConfig, this.macroBias, resumedAt),
        this.cachedConfig,
        this.macroBias,
        resumedAt
      );
      this.engineState = stateAfterShadowModeAutoResume({
        currentState: this.engineState,
        normalizedBankroll: normalizePaperBankroll(this.engineState.bankroll, this.env, resumedAt),
        assetQuoteStates,
        quoteState: aggregateQuoteState(assetQuoteStates, this.engineState.quoteState, resumedAt),
        observedAt: resumedAt
      });
      this.killSwitchLogged = false;
      this.logger.warn(
        "SHADOW_MODE_AUTO_RESUME",
        "Shadow mode resumed paper trading after a stale halt",
        shadowModeAutoResumeLogMetadata({
          tick,
          configVersion: this.cachedConfig.version
        })
      );
      this.publish("RESUME_QUOTES", shadowModeAutoResumeTelemetry(resumedAt));
    }

    if (
      shouldBlockHaltedTrading({
        shadowReplay: options.shadowReplay === true,
        shadowMode: isShadowMode(this.env),
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        mode: this.engineState.mode
      })
    ) {
      if (!this.killSwitchLogged) {
        this.logger.warn(
          "KILL_SWITCH_ACTIVE",
          "Trading halted by cached config",
          killSwitchActiveLogMetadata({
            tick,
            configVersion: this.cachedConfig.version,
            tradingEnabled: this.cachedConfig.TRADING_ENABLED,
            mode: this.engineState.mode
          })
        );
        this.killSwitchLogged = true;
      }

      return {
        accepted: false,
        status: "DISABLED",
        reason: "TRADING_DISABLED"
      };
    }

    if (
      shouldLogDisabledTrading({
        shadowReplay: options.shadowReplay === true,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        killSwitchLogged: this.killSwitchLogged
      })
    ) {
      this.logger.warn(
        "KILL_SWITCH_ACTIVE",
        "Trading disabled; market data remains enabled",
        killSwitchActiveLogMetadata({
          tick,
          configVersion: this.cachedConfig.version,
          tradingEnabled: this.cachedConfig.TRADING_ENABLED,
          mode: this.engineState.mode
        })
      );
      this.killSwitchLogged = true;
    }

    this.lastTickTimestamp = tick.receivedAt;
    this.observeCascadeAbsorption(tick);

    const metrics = calculateTickLatency({
      tick,
      brainTimestamp: new Date().toISOString(),
      maxLatencyMs: this.maxLatencyMs,
      averageLatencyMs: this.engineState.averageLatency,
      sampleCount: this.engineState.latencySampleCount,
      location: this.engineState.location
    });
    const streamId = extractTickStreamId(tick);
    const hardStaleDropMs = resolveNativeHyperliquidMaxLatencyMs({
      transport: tick.transport,
      streamId,
      dwellirMaxLatencyMs: this.env.DWELLIR_MAX_LATENCY_MS,
      hlStaleAfterMs: this.env.HL_STALE_AFTER_MS,
      currentMaxLatencyMs: this.maxLatencyMs
    });
    const isHardStale = !options.shadowReplay && metrics.totalLatencyMs > hardStaleDropMs;

    if (isHardStale) {
      return this.handleHardStaleTickDrop(tick, metrics, streamId, hardStaleDropMs);
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
      return this.handleSoftStaleTick(tick, metrics, wakeUpTimeMs, hotPathStartedAt);
    }

    const fundingState = stateAfterFundingTick(this.engineState, tick, metrics.brainTimestamp);
    if (fundingState.changed) {
      this.engineState = fundingState.state;
    }

    let orderBookUpdateMs = 0;
    let book: InternalOrderBook | undefined;

    if (isInformationalTick(tick)) {
      metrics.timeToBookMs = null;
      book = currentBookForMarketTick(this.orderBook, tick);

      if (!book) {
        return this.handleInformationalBookNotReady(
          tick,
          metrics,
          wakeUpTimeMs,
          orderBookUpdateMs,
          hotPathStartedAt
        );
      }
    } else {
      const orderBookStartedAt = highResolutionNow();
      const applied = await this.applyDelta(tickToDelta(tick), metrics.brainTimestamp);
      orderBookUpdateMs = roundLatency(highResolutionNow() - orderBookStartedAt);
      metrics.timeToBookMs = applied.timeToBookMs;

      if (!applied.accepted) {
        return this.handleRejectedBookDelta(
          tick,
          metrics,
          applied,
          wakeUpTimeMs,
          orderBookUpdateMs,
          hotPathStartedAt
        );
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
      return this.handleAnomalyEmergencyPause(
        tick,
        book,
        domSnapshot,
        anomalyResult,
        anomalyLogicStartedAt,
        metrics,
        wakeUpTimeMs,
        orderBookUpdateMs,
        hotPathStartedAt
      );
    }

    const profilerAgent = this.profilerRegistry.forInstrument(tick.instrumentCode);
    const profilerStartedAt = highResolutionNow();
    const profilerResult: ProfilerEvaluation = this.cachedConfig.PROFILER_ENABLED
      ? profilerAgent.processTick(
          tick,
          buildProfilerContext({
            engineId: this.engineState.engineId,
            observedAt: metrics.brainTimestamp,
            book,
            dom: domSnapshot,
            liquidationHeatmap: this.engineState.liquidationHeatmap,
            jumpDetected: volatilitySnapshot?.jumpDetected ?? false
          })
        )
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
      ? this.oracleAgent.processTick(
          buildOracleTickInput({
            tick,
            book,
            observedAt: metrics.brainTimestamp,
            config: this.cachedConfig
          })
        )
      : disabledOracleTickResult(this.engineState.oracle, metrics.brainTimestamp);
    const oracleLatencyMs = this.cachedConfig.ORACLE_ENABLED
      ? roundLatency(highResolutionNow() - oracleStartedAt)
      : 0;
    const leadLag = this.engineState.leadLag;
    const inventory = this.calculateInventoryState(metrics.brainTimestamp);
    const riskMetrics = this.updatePortfolioRisk(oracleResult.state, metrics.brainTimestamp);
    const profilerStates = this.profilerRegistry.snapshot(
      tick.instrumentCode,
      profilerResult.state
    );
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
      ? this.croupierAgent.evaluate(
          buildCroupierEvaluationInput({
            engineId: this.engineState.engineId,
            book,
            oracle: oracleResult.state,
            sentiment: sentimentForDecision,
            toxicityScore: profilerResult.toxicityScore,
            inventory,
            leadLag,
            config: this.cachedConfig,
            env: this.env,
            executionCostBufferBps: this.engineState.slippage.executionCostBufferBps,
            bidAdversePenaltyBps: bidAdversePenalty.penaltyBps,
            askAdversePenaltyBps: askAdversePenalty.penaltyBps,
            multiScaleVolatility: volatilitySnapshot,
            fundingRateHourly: resolveCurrentFundingRate(this.engineState.fundingRates, book),
            liquidationHeatmap: this.engineState.liquidationHeatmap,
            profilerToxicityState: profilerResult.state.toxicityState,
            profilerPressureSide: profilerResult.state.pressureSide,
            profilerSpreadMultiplier: profilerResult.state.spreadMultiplier,
            profilerReservationShiftBps: profilerResult.state.reservationShiftBps,
            sentimentAlphaMode: this.cachedConfig.SENTIMENT_ALPHA_MODE,
            macroBias: this.macroBias,
            observedAt: metrics.brainTimestamp
          })
        )
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
    const strategyQuoteDisableReason = runtimeStrategyQuoteDisabledReason(this.cachedConfig);
    if (
      strategyQuoteDisableReason &&
      previousQuoteState.reason !== strategyQuoteDisableReason &&
      !options.shadowReplay &&
      this.cachedConfig.TRADING_ENABLED
    ) {
      this.state.waitUntil(this.cancelAllQuotes(tick.instrumentCode, strategyQuoteDisableReason));
    }
    const profilerSignalType = profilerResult.signal?.featureVector.signalType;
    const quoteSuppression = quoteSuppressionDecision({
      previous: assetQuoteState,
      profilerSignalType,
      profilerSuspendedUntil:
        typeof profilerResult.signal?.featureVector.suspendedUntil === "string"
          ? profilerResult.signal.featureVector.suspendedUntil
          : undefined,
      profilerQuoteHaltUntil: profilerResult.state.quoteHaltUntil,
      amVpinQuoteHaltMs: this.cachedConfig.AM_VPIN_QUOTE_HALT_MS,
      quoteHibernateMs: resolveQuoteHibernateMs(this.cachedConfig, this.env.QUOTE_HIBERNATE_MS),
      ensembleAnomalyCircuitBreaker: ensemble.anomalyCircuitBreaker,
      ensembleRationale: ensemble.rationale,
      observedAt: metrics.brainTimestamp
    });
    const isCascadeShield = quoteSuppression.isCascadeShield;
    const isProfilerQuoteHalt = quoteSuppression.isProfilerQuoteHalt;

    if (!quoteSuppression.executionPlansAllowed) {
      executionPlans = [];
      assetQuoteState = quoteSuppression.quoteState;
    }
    if (quoteSuppression.suspendTelemetry) {
      this.publish("SUSPEND_QUOTES", {
        instrumentCode: tick.instrumentCode,
        ...quoteSuppression.suspendTelemetry
      });
    }
    if (
      quoteSuppression.cancelReason &&
      !options.shadowReplay &&
      this.cachedConfig.TRADING_ENABLED
    ) {
      this.state.waitUntil(
        this.cancelAllQuotes(tick.instrumentCode, quoteSuppression.cancelReason)
      );
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
    const agentHealth = nextTickAgentHealth({
      previous: this.engineState.agentHealth,
      config: this.cachedConfig,
      observedAt: metrics.brainTimestamp,
      oracleLatencyMs,
      sentimentLatencyMs: this.engineState.agentHealth.SENTIMENT.latencyMs,
      profilerToxicityScore: profilerResult.toxicityScore,
      profilerAlertThreshold: profilerResult.state.alertThreshold,
      profilerLatencyMs,
      profilerSignalId: profilerResult.signal?.signalId ?? undefined,
      croupierLatencyMs,
      croupierHasOutput: Boolean(croupierDecision.intent || croupierDecision.quote),
      croupierSignalId: croupierDecision.quote?.signalId ?? croupierDecision.intent?.intentId,
      pitBossIntentId: executionPlan?.intent.intentId
    });

    this.engineState = stateAfterAcceptedTick({
      currentState: this.engineState,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      shadowReplay: options.shadowReplay === true,
      latencyStatus: metrics.status,
      internalOrderBookDepth: countBookLevels(this.bids, this.asks),
      book,
      oracle: oracleResult.state,
      sentiment: sentimentForDecision,
      ensemble,
      leadLag,
      inventory,
      riskMetrics,
      quoteState,
      assetQuoteStates,
      shadowQueue: shadowQueueState,
      lastTradeIntent: executionPlan?.intent ?? croupierDecision.intent,
      inventoryGuard,
      ordersToTrack: executionPlans.flatMap((plan) => plan.orders),
      shouldTrackOrders:
        executionPlans.length > 0 &&
        (this.cachedConfig.TRADING_ENABLED || options.shadowReplay === true),
      dom: domSnapshot,
      anomaly: anomalyResult.status,
      assetMatrix: finalAssetMatrix,
      profilerStates,
      toxicityScore: profilerResult.toxicityScore,
      agentHealth,
      maxLatencyMs: this.maxLatencyMs,
      observedAt: metrics.brainTimestamp
    });

    const writes = buildHotPathTickSnapshotWrites({
      engineState: this.engineState,
      latencyHistory: this.latencyHistory,
      processingLatencySamples: this.processingLatencySamples,
      domWallHistory: this.domWallHistory,
      anomalyDetectorState: anomalyResult.state,
      book,
      tick,
      profilerProcessed: profilerResult.processed,
      profilerState: profilerResult.state
    });

    this.state.waitUntil(this.persistHotStorageSnapshot(writes, "HOT_PATH_TICK_SNAPSHOT"));
    if (
      shouldPersistMarketTick(
        this.engineState.processedTicks,
        this.env.MARKET_TICK_JOURNAL_INTERVAL
      )
    ) {
      this.logger.recordMarketTick(tick);
    }

    const bayesianTrace = oracleResult.bayesianTrace;
    if (
      bayesianTrace &&
      shouldLogBayesianPosteriorUpdate({
        trace: bayesianTrace,
        processedTicks: this.engineState.processedTicks,
        interval: AGENT_SNAPSHOT_TICK_INTERVAL
      })
    ) {
      this.logger.info(
        "BAYESIAN_POSTERIOR_UPDATED",
        "Oracle posterior PDF updated",
        bayesianPosteriorUpdatedLogMetadata({
          instrumentCode: tick.instrumentCode,
          trace: bayesianTrace
        })
      );
    }

    const croupierQuoteAction = buildCroupierQuoteAction({
      instrumentCode: tick.instrumentCode,
      pullAllQuotes: croupierDecision.pullAllQuotes,
      quote: croupierDecision.quote,
      strategyQuoteDisableReason,
      adverseSelectionCost: croupierDecision.adverseSelectionCost,
      minEvThreshold: croupierDecision.minEvThreshold,
      shadowReplay: options.shadowReplay === true,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      profilerQuoteHalt: isProfilerQuoteHalt,
      cascadeShield: isCascadeShield
    });

    this.handleCroupierQuoteAction(tick.instrumentCode, croupierQuoteAction);
    this.dispatchExecutionPlans(executionPlans, options.shadowReplay === true);

    const hedge = buildInventoryHedgeIntent({
      book,
      inventory,
      observedAt: metrics.brainTimestamp,
      engineId: this.engineState.engineId,
      config: this.cachedConfig,
      lastHedgeAtMs: this.lastHedgeDispatchedAt.get(book.instrumentCode) ?? 0,
      fallbackNowMs: Date.now()
    });
    const hedgeIntent = hedge?.intent ?? null;
    if (hedge) {
      this.lastHedgeDispatchedAt.set(book.instrumentCode, hedge.dispatchedAtMs);
    }
    if (hedgeIntent && !options.shadowReplay) {
      this.logger.warn(
        "INVENTORY_HEDGE_AUTHORIZED",
        "Inventory hedge IOC path authorized",
        inventoryHedgeAuthorizedLogMetadata({
          intent: hedgeIntent,
          inventory,
          triggerPct: this.cachedConfig.HEDGE_TRIGGER_INVENTORY_PCT
        })
      );
      this.state.waitUntil(this.dispatchExecution(hedgeIntent));
    }

    if (profilerResult.signal) {
      this.publishProfilerAlert(profilerResult.signal, profilerResult.state);
      await this.acceptAgentSignal(profilerResult.signal, profilerLatencyMs);
      if (
        shouldCancelQuotesForProfilerSignal({
          signal: profilerResult.signal,
          profilerQuoteHalt: isProfilerQuoteHalt,
          shadowReplay: options.shadowReplay === true,
          tradingEnabled: this.cachedConfig.TRADING_ENABLED,
          croupierHasQuote: Boolean(croupierDecision.quote)
        })
      ) {
        this.state.waitUntil(this.cancelAllQuotes(tick.instrumentCode, "PROFILER_ALERT"));
      }
    }

    if (shouldLogMarketTickAccepted(this.engineState.processedTicks)) {
      this.logger.info(
        "MARKET_TICK_ACCEPTED",
        "Market tick processed",
        marketTickAcceptedLogMetadata({
          tick,
          metrics,
          processedTicks: this.engineState.processedTicks,
          averageLatencyMs: this.engineState.averageLatency
        })
      );
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

  private processShadowQueueTick(
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string,
    options: TickHandlingOptions
  ): ShadowQueueState {
    if (!shouldProcessShadowQueueTick({ book, shadowReplay: options.shadowReplay })) {
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
    const makerFeeBps = readBoundedNumber(
      this.env.PAPER_MAKER_FEE_BPS ?? this.env.EXCHANGE_FEE_BPS,
      DEFAULT_PAPER_MAKER_FEE_BPS,
      0,
      100
    );
    const ghostFillRecord = buildShadowQueueGhostFillRuntimeRecord({
      fill,
      tick,
      book,
      observedAt,
      slippage: this.engineState.slippage,
      fallbackAdverseBps,
      participationRate,
      makerFeeBps,
      cachedConfig: this.cachedConfig,
      envMaxPositionPct: readPositiveNumber(this.env.MAX_POSITION_PCT, DEFAULT_MAX_POSITION_PCT),
      envKellyFraction: readPositiveNumber(this.env.KELLY_FRACTION, 0.5),
      equity: this.engineState.bankroll.equity,
      inventory: this.engineState.inventory,
      positionSizeMultiplier: this.engineState.location.positionSizeMultiplier
    });

    if (!ghostFillRecord.trade) {
      this.publish("SHADOW_QUEUE_GHOST_FILL", ghostFillRecord.eventPayload, fill.fillId);
      return;
    }

    this.logger.recordExecution(ghostFillRecord.trade);
    this.publish("SHADOW_QUEUE_GHOST_FILL", ghostFillRecord.eventPayload, fill.fillId);
  }

  private handleShadowQueueDecision(
    decision: ShadowQueueDecision,
    book: InternalOrderBook,
    observedAt: string
  ): ShadowQueueDecision {
    if (decision.action === "NO_EDGE" || decision.dispatchSide === null) {
      const telemetry = buildShadowQueueNoEdgeTelemetry(decision);
      if (
        shouldLogShadowQueueNoEdgeEvent({
          lastLoggedAtByInstrument: this.shadowQueueNoEdgeLogAt,
          instrumentCode: decision.instrumentCode,
          nowMs: Date.now(),
          intervalMs: resolveShadowQueueNoEdgeLogInterval(
            this.env.SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS
          )
        })
      ) {
        this.logger.info(telemetry.eventType, telemetry.message, telemetry.metadata);
      }
      this.publish(telemetry.eventType, telemetry.payload, telemetry.correlationId);
      return decision;
    }

    const latencyBudget = this.engineState.shadowQueue.latencyBudgetMs;
    const latencyDecision = enforceShadowQueueDecisionLatency(decision, latencyBudget);

    if (latencyDecision.breached) {
      const suppressed = latencyDecision.decision;
      const telemetry = buildShadowQueueLatencyBreachTelemetry({
        originalDecision: decision,
        suppressedDecision: suppressed,
        latencyBudgetMs: latencyBudget
      });
      this.logger.warn(telemetry.eventType, telemetry.message, telemetry.metadata);
      this.publish(telemetry.eventType, telemetry.payload, telemetry.correlationId);
      return suppressed;
    }

    const sizing = resolveShadowQueueSizingConfig({
      cachedConfig: this.cachedConfig,
      envMaxPositionPct: readPositiveNumber(this.env.MAX_POSITION_PCT, DEFAULT_MAX_POSITION_PCT),
      envKellyFraction: readPositiveNumber(this.env.KELLY_FRACTION, 0.5)
    });
    const intent = buildShadowQueueTradeIntentFromDecision({
      decision,
      book,
      observedAt,
      engineId: this.engineState.engineId,
      baseSpreadBps: this.engineState.shadowQueue.baseSpreadBps,
      exchangeFeeBps: this.cachedConfig.EXCHANGE_FEE_BPS,
      toxicityScore: this.engineState.toxicityScore,
      equity: this.engineState.bankroll.equity,
      maxPositionPct: sizing.maxPositionPct,
      kellyFraction: sizing.kellyFraction,
      inventory: this.engineState.inventory,
      positionSizeMultiplier: this.engineState.location.positionSizeMultiplier
    });
    const updatedDecision = {
      ...decision,
      tradeIntentId: intent?.intentId ?? null
    };

    this.logger.traceDecision(
      buildShadowQueueDecisionTrace({
        decision: updatedDecision,
        intent,
        engineId: this.engineState.engineId,
        quoteStateStatus: this.engineState.quoteState.status,
        inventory: this.engineState.inventory,
        cachedConfigVersion: this.cachedConfig.version,
        observedAt
      })
    );

    const action = buildShadowQueueDecisionAction({
      decision: updatedDecision,
      intent,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED
    });
    this.publish(action.publish.type, action.publish.payload, action.publish.correlationId);

    if (action.cancelReason) {
      this.state.waitUntil(this.cancelAllQuotes(book.instrumentCode, action.cancelReason));
    }
    if (action.dispatchIntent) {
      this.state.waitUntil(this.dispatchExecution(action.dispatchIntent));
    }

    return updatedDecision;
  }

  private updateLeadLagMetrics(
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string
  ): EngineState["leadLag"] {
    return updateLeadLagRuntimeMetrics({
      samples: this.leadLagSamples,
      currentLeadLag: this.engineState.leadLag,
      instrumentCode: tick.instrumentCode,
      midPrice: book.midPrice,
      observedAt,
      averageLatencyMs: this.engineState.averageLatency,
      microstructureSpread: this.engineState.microstructure.spread,
      microstructureMidPrice: this.engineState.microstructure.midPrice,
      executionCostBufferBps: this.engineState.slippage.executionCostBufferBps,
      sampleLimit: 100
    });
  }

  private calculateInventoryState(
    observedAt: string,
    positions: Record<string, Position> = this.engineState.openPositions
  ): EngineState["inventory"] {
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
    const baseAsset = "BTC";

    return calculateInventoryRuntimeState({
      positions,
      observedAt,
      maxInventoryUnits,
      maxInventoryDelta,
      riskAversionFactor,
      baseAsset,
      baseReferencePrice: this.referencePriceForBaseAsset(baseAsset),
      configuredWeights: parseDeltaNormalizationWeights(this.env.DELTA_NORMALIZATION_WEIGHTS),
      markPrice: (instrumentCode, fallback) =>
        currentMarkPriceForInstrument(
          {
            orderBook: this.orderBook,
            microstructure: this.engineState.microstructure
          },
          instrumentCode,
          fallback
        )
    });
  }

  private referencePriceForBaseAsset(baseAsset: string): number {
    return resolveBaseAssetReferencePrice({
      baseAsset,
      orderBooks: this.orderBook.values(),
      positions: this.engineState.openPositions,
      microstructureMidPrice: this.engineState.microstructure.midPrice
    });
  }

  private updatePortfolioRisk(
    oracle: EngineState["oracle"],
    observedAt: string
  ): EngineState["riskMetrics"] {
    const { drawdownBreached, metrics } = calculatePortfolioRuntimeRisk({
      mode: this.engineState.mode,
      equity: this.engineState.bankroll.equity,
      priorHighWaterMark: this.engineState.riskMetrics.highWaterMark,
      positions: this.engineState.openPositions,
      oracleVolatility: oracle.volatility,
      varConfidenceZ:
        this.cachedConfig.VAR_CONFIDENCE_Z > 0
          ? this.cachedConfig.VAR_CONFIDENCE_Z
          : readPositiveNumber(this.env.VAR_CONFIDENCE_Z, DEFAULT_VAR_CONFIDENCE_Z),
      maxDrawdownPct: this.cachedConfig.MAX_DRAWDOWN_PCT,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      observedAt
    });

    if (drawdownBreached && this.cachedConfig.TRADING_ENABLED) {
      const killSwitch = buildDrawdownKillSwitchTransition({
        cachedConfig: this.cachedConfig,
        metrics,
        equity: this.engineState.bankroll.equity,
        observedAt
      });
      this.cachedConfig = killSwitch.config;
      this.state.waitUntil(this.configManager.writeConfig(this.cachedConfig));
      this.state.waitUntil(this.cancelAllQuotes("ALL", killSwitch.cancelReason));
      this.notifier.notify(killSwitch.notification);
    }

    return metrics;
  }

  private calculateEnsembleState(
    intent: TradeIntent | null,
    profilerState: ProfilerState,
    oracleState: EngineState["oracle"],
    sentimentState: EngineState["sentiment"],
    anomalyStatus: EngineState["anomaly"],
    observedAt: string
  ): EngineState["ensemble"] {
    return calculateRuntimeEnsembleState({
      intent,
      profilerState,
      oracleState,
      sentimentState,
      anomalyStatus,
      config: this.cachedConfig,
      observedAt
    });
  }

  private prepareExecutionPlan(
    intent: EngineState["lastTradeIntent"],
    observedAt: string,
    options: {
      bypassQuoteSuspension?: boolean;
      stateOverride?: EngineState;
      kellyFractionOverride?: number;
    } = {}
  ): ApprovedExecutionPlan | null {
    if (!intent) {
      return null;
    }

    const riskState = options.stateOverride ?? this.engineState;
    if (
      shouldSkipExecutionPlanForQuoteSuspension({
        intent,
        riskState,
        observedAt,
        bypassQuoteSuspension: options.bypassQuoteSuspension
      })
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

    const plan = buildApprovedExecutionPlan({
      pitBossDecision,
      orderBooks: this.orderBook.values(),
      observedAt,
      ackTimeoutMs: readPositiveInteger(
        this.env.ORDER_ACK_TIMEOUT_MS,
        DEFAULT_ORDER_ACK_TIMEOUT_MS,
        100,
        60_000
      )
    });

    if (!plan) {
      return null;
    }

    if (plan.residualLogMetadata) {
      this.logger.warn(
        "SOR_RESIDUAL_LIQUIDITY_SHORTFALL",
        "Smart router could not source full approved size",
        plan.residualLogMetadata
      );
    }

    return plan;
  }

  private nextQuoteStateForInstrument(
    instrumentCode: string,
    quote: EngineState["quoteState"]["lastQuote"],
    pullAllQuotes: boolean,
    observedAt: string
  ): EngineState["quoteState"] {
    return nextRuntimeQuoteStateForInstrument({
      previous: quoteStateForInstrumentState(
        this.engineState.assetQuoteStates,
        instrumentCode,
        this.engineState.quoteState
      ),
      quote,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      strategyDisabledReason: runtimeStrategyQuoteDisabledReason(this.cachedConfig),
      instrumentSelected: isInstrumentSelectedByMoltworker(instrumentCode, this.macroBias),
      pullAllQuotes,
      quoteHibernateMs: resolveQuoteHibernateMs(this.cachedConfig, this.env.QUOTE_HIBERNATE_MS),
      observedAt
    });
  }

  private maybeResumeQuotes(observedAt: string): void {
    const next = resumeExpiredQuoteStates({
      assetQuoteStates: this.engineState.assetQuoteStates,
      quoteState: this.engineState.quoteState,
      observedAt
    });

    if (next.changed) {
      this.engineState = {
        ...this.engineState,
        quoteState: next.quoteState,
        assetQuoteStates: next.assetQuoteStates
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
    const leadThresholdBps = readPositiveNumber(
      this.env.CROSS_ASSET_CANCEL_LEAD_BPS,
      DEFAULT_CROSS_ASSET_CANCEL_LEAD_BPS
    );
    const cooldownMs = readPositiveInteger(
      this.env.CROSS_ASSET_CANCEL_COOLDOWN_MS,
      DEFAULT_CROSS_ASSET_CANCEL_COOLDOWN_MS,
      100,
      60_000
    );
    const last = this.crossAssetCancelLogAt.get("hype-usd") ?? 0;
    const decision = evaluateCrossAssetHypeQuoteCancel({
      shadowReplay: options.shadowReplay,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      tickInstrumentCode: tick.instrumentCode,
      volatility,
      observedAt,
      leadThresholdBps,
      cooldownMs,
      lastCancelAtMs: last,
      fallbackNowMs: Date.now()
    });

    if (!decision.shouldCancel) {
      return;
    }

    this.crossAssetCancelLogAt.set("hype-usd", decision.nowMs);
    const artifacts = {
      decision,
      volatility,
      leadThresholdBps,
      observedAt
    };
    this.logger.warn(
      "CROSS_ASSET_HYPE_CANCEL",
      "BTC lead move invalidated HYPE resting quotes",
      crossAssetHypeCancelLogMetadata(artifacts)
    );
    this.publish("SUSPEND_QUOTES", crossAssetHypeCancelTelemetry(artifacts));
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
      this.logger.info(
        "QUOTE_DISPATCH_BLOCKED",
        "Skipped quote for inactive Moltworker asset",
        quoteDispatchBlockedLogMetadata({ quote, assetRuntimeState })
      );
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

    const maxPositionPct =
      this.cachedConfig.MAX_POSITION_PCT > 0
        ? this.cachedConfig.MAX_POSITION_PCT
        : readPositiveNumber(this.env.MAX_POSITION_PCT, DEFAULT_MAX_POSITION_PCT);
    const assetAllocation =
      this.engineState.assetMatrix?.[quote.instrumentCode]?.capitalAllocationPct ?? 1;
    const quoteDispatch = buildQuoteDispatchIntents({
      quote,
      engineId: this.engineState.engineId,
      bankrollEquity: this.engineState.bankroll.equity,
      bankrollCash: this.engineState.bankroll.cash,
      maxPositionPct,
      maxPositionSize: this.cachedConfig.MAX_POSITION_SIZE,
      assetAllocationPct: assetAllocation,
      positionSizeMultiplier: this.engineState.location.positionSizeMultiplier,
      fallbackSourceExchange: this.engineState.microstructure.source_exchange,
      spreadBps: this.engineState.microstructure.spreadBps,
      toxicityScore: this.engineState.toxicityScore
    });

    for (const skipped of quoteDispatch.skippedOrders) {
      this.logger.warn(
        "QUOTE_ORDER_RISK_CAP_ZERO",
        "Skipped quote order with no remaining risk budget",
        { ...skipped }
      );
    }

    for (const intent of quoteDispatch.intents) {
      await this.dispatchExecution(intent);
    }

    if (quoteDispatch.intents.length > 0) {
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
    const book = findBestOrderBookForAsset(this.orderBook, quote.instrumentCode);
    const tickSize = book?.tickSize ?? DEFAULT_ORDER_BOOK_TICK_SIZE;
    const advice = this.queuePositionModel.adviseRefresh({
      previousQuote: last,
      quote,
      book: book ?? null,
      minPriceTicks,
      elapsedMs,
      tickSize
    });

    const logKey = quote.instrumentCode;
    const logAt = this.quoteRefreshThrottleLogAt.get(logKey) ?? 0;
    const nowMs = Date.now();
    const throttle = evaluateQuoteRefreshThrottle({
      previousQuote: last,
      quote,
      advice,
      minIntervalMs,
      minPriceTicks,
      nowMs,
      lastLogAtMs: logAt,
      logThrottleMs: HOT_PATH_LOG_THROTTLE_MS
    });

    if (throttle.shouldLog) {
      this.quoteRefreshThrottleLogAt.set(logKey, throttle.nextLogAtMs);
      this.logger.info(
        "QUOTE_REFRESH_THROTTLED",
        "Skipped quote refresh inside minimum cadence window",
        quoteRefreshThrottleLogMetadata({ quote, throttle, minIntervalMs, minPriceTicks })
      );
    }

    return throttle.shouldThrottle;
  }

  private rememberDispatchedQuote(
    quote: NonNullable<EngineState["quoteState"]["lastQuote"]>
  ): void {
    this.lastDispatchedQuoteByInstrument.set(
      quote.instrumentCode,
      dispatchedQuoteSnapshot(quote, Date.now())
    );
  }

  private async dispatchExecution(
    intent: NonNullable<EngineState["lastTradeIntent"]>,
    initialDelayMs = 0
  ): Promise<void> {
    const inventoryHedge = isInventoryHedgeIntent(intent);
    const executioner = this.env.EXECUTIONER;
    const dispatchGate = evaluateExecutionDispatchGate({
      intent,
      hasExecutioner: Boolean(executioner),
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      hedgeEnabled: this.cachedConfig.HEDGE_ENABLED,
      inventoryHedge,
      instrumentSelected: isInstrumentSelectedByMoltworker(intent.instrumentCode, this.macroBias)
    });

    const blockLog = buildExecutionDispatchBlockLog({
      decision: dispatchGate,
      intent,
      selectedInstruments: [...selectedMoltworkerInstruments(this.macroBias)]
    });
    if (blockLog) {
      if (blockLog.level === "INFO") {
        this.logger.info(blockLog.eventType, blockLog.message, blockLog.metadata);
      } else {
        this.logger.warn(blockLog.eventType, blockLog.message, blockLog.metadata);
      }
      return;
    }

    if (!dispatchGate.allowed || !executioner) {
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

    await dispatchTradeIntentToExecutioner({ executioner, logger: this.logger, intent });
  }

  private reservePaperExecutionBudget(intent: TradeIntent): boolean {
    const budget = applyIntentPaperExecutionBudget({
      intent,
      shadowMode: isShadowMode(this.env),
      nowMs: Date.now(),
      maxPerMinuteValue: this.env.PAPER_MAX_GHOST_FILLS_PER_MINUTE,
      windowStartedAtMs: this.paperExecutionWindowStartedAtMs,
      windowCount: this.paperExecutionWindowCount,
      windowDropped: this.paperExecutionWindowDropped,
      throttleLoggedAtMs: this.paperExecutionThrottleLoggedAtMs
    });

    this.paperExecutionWindowStartedAtMs = budget.state.windowStartedAtMs;
    this.paperExecutionWindowCount = budget.state.windowCount;
    this.paperExecutionWindowDropped = budget.state.windowDropped;
    this.paperExecutionThrottleLoggedAtMs = budget.state.throttleLoggedAtMs;

    if (budget.shouldLogThrottle) {
      this.logger.warn(
        "SHADOW_PAPER_CADENCE_THROTTLED",
        "Paper execution cadence capped",
        budget.logMetadata ?? {}
      );
      this.publish("SHADOW_PAPER_CADENCE_THROTTLED", budget.publishPayload ?? {});
    }

    return budget.allowed;
  }

  private async enqueueExecutionIntent(
    intent: TradeIntent,
    priority: QueuedExecutionIntent["priority"],
    waitMs: number
  ): Promise<void> {
    const queue = await this.readExecutionQueue("EXECUTION_QUEUE_ENQUEUE_READ");
    const now = Date.now();
    const plan = buildExecutionQueueEnqueuePlan({
      queue,
      intent,
      priority,
      waitMs,
      nowMs: now,
      enqueuedAtIso: new Date(now).toISOString()
    });

    await this.safeStoragePut(EXECUTION_QUEUE_KEY, plan.queue, "EXECUTION_QUEUE_ENQUEUE");
    await this.safeSetAlarm(
      Math.min(plan.runAfterMs, now + CONFIG_ALARM_INTERVAL_MS),
      "EXECUTION_QUEUE_ALARM"
    );
    if (
      shouldLogExecutionQueueDeferral({
        nowMs: now,
        lastLoggedAtMs: this.rateLimitDeferralLogAt,
        throttleMs: HOT_PATH_LOG_THROTTLE_MS
      })
    ) {
      this.rateLimitDeferralLogAt = now;
      this.logger.warn(
        "EXECUTION_DEFERRED_BY_RATE_LIMIT",
        "Execution intent deferred by durable rate limiter",
        executionQueueDeferralLogMetadata({
          intent,
          priority,
          waitMs,
          queuedCount: plan.queuedCount
        })
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
    const plan = splitExecutionQueueForDrain({ queue, nowMs: now });

    await this.safeStoragePut(EXECUTION_QUEUE_KEY, plan.pending, "EXECUTION_QUEUE_DRAIN");

    for (const item of plan.due) {
      await this.dispatchExecution(item.intent);
    }

    if (plan.nextWakeMs) {
      await this.safeSetAlarm(
        Math.min(plan.nextWakeMs, Date.now() + CONFIG_ALARM_INTERVAL_MS),
        "EXECUTION_QUEUE_NEXT_WAKE"
      );
    }
  }

  private async cancelAllQuotes(instrumentCode: string, reason: string): Promise<void> {
    const executioner = this.env.EXECUTIONER;
    const now = Date.now();
    const dispatchDecision = evaluateQuoteCancelDispatch({
      instrumentCode,
      reason,
      hasExecutioner: Boolean(executioner),
      nowMs: now,
      lastDispatchAtMs: this.cancelAllLogAt.get(`${instrumentCode}:${reason}`),
      throttleMs: HOT_PATH_LOG_THROTTLE_MS
    });

    if (!dispatchDecision.shouldDispatch) {
      return;
    }
    if (!executioner) {
      return;
    }
    this.cancelAllLogAt.set(dispatchDecision.dispatchKey, now);

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

    await dispatchQuoteCancelAll({
      executioner,
      logger: this.logger,
      payload: dispatchDecision.payload
    });
  }

  private async applyExecutionReport(report: ExecutionReport): Promise<void> {
    const accounting = applyExecutionAccounting({
      state: this.engineState,
      report,
      markPrice: (instrumentCode, fallback) =>
        currentMarkPriceForInstrument(
          {
            orderBook: this.orderBook,
            microstructure: this.engineState.microstructure
          },
          instrumentCode,
          fallback
        )
    });
    const inventory = this.calculateInventoryState(accounting.observedAt, accounting.openPositions);
    this.adverseSelectionModel.observeExecutionReport(
      report,
      accounting.order,
      currentMarkPriceForInstrument(
        {
          orderBook: this.orderBook,
          microstructure: this.engineState.microstructure
        },
        accounting.order.instrumentCode,
        accounting.order.price
      ),
      this.engineState.oracle.regime
    );

    this.logger.recordExecutionQuality(executionQualityFromAccounting(report, accounting));

    this.engineState = stateAfterExecutionAccounting({
      state: this.engineState,
      accounting,
      inventory
    });

    await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "EXECUTION_REPORT");
    this.logger.recordExecution(accounting.tradeExecution);
    this.publish(
      "TRADE_EXECUTION_UPDATE",
      accounting.tradeExecution as unknown as Record<string, unknown>,
      accounting.tradeExecution.tradeId
    );
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
    const exchangeOpenOrders = await fetchJanitorExchangeOpenOrders({
      executioner: this.env.EXECUTIONER,
      logger: this.logger
    });
    const reconciliation = reconcileJanitorOrders({
      orderMap: this.engineState.orderMap,
      exchangeOpenOrders,
      zombieOrders: baseReport.zombieOrders,
      observedAt
    });
    const nextOrderMap = reconciliation.orderMap;

    for (const request of reconciliation.cancellationRequests) {
      await this.cancelOrder(request.orderId, request.reason, request.instrumentCode);
    }

    const dustCloseIntents: string[] = [];
    for (const instrumentCode of baseReport.dustPositions) {
      const intentId = recordPostOnlyDustCloseSkip({
        openPositions: this.engineState.openPositions,
        logger: this.logger,
        instrumentCode,
        observedAt
      });
      if (intentId) {
        dustCloseIntents.push(intentId);
      }
    }

    const pruneReport = await this.pruneOperationalLogs();
    const janitorResult = buildJanitorReport({
      baseReport,
      reconciliation,
      dustCloseIntents,
      pruneReport
    });

    if (janitorResult.shouldWarn) {
      this.logger.warn(
        "JANITOR_CLEANUP_REQUIRED",
        "Janitor found state hygiene work",
        janitorCleanupRequiredLogMetadata({
          source,
          report: janitorResult.report,
          pruneReport
        })
      );
    }

    this.engineState = stateAfterJanitorRun({
      state: this.engineState,
      orderMap: nextOrderMap,
      report: janitorResult.report,
      observedAt
    });
    await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "JANITOR_REPORT");
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

    await cancelJanitorOrder({
      executioner: this.env.EXECUTIONER,
      logger: this.logger,
      orderId,
      reason,
      instrumentCode
    });
  }

  private async pruneOperationalLogs(): Promise<LogPruneReport> {
    const policy = resolveLogRetentionPolicy(this.env);
    const emptyReport = emptyLogPruneReport(policy);

    try {
      return await pruneOperationalLogsFromD1(this.env.TRADING_DB, policy);
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
    await this.replayJournal.writeStatus(
      buildReplayStatus({
        replayId,
        status: "RUNNING",
        ticksTotal: 0,
        ticksProcessed: 0,
        speedMultiplier,
        shadowBankroll,
        dateFrom,
        dateTo,
        scenario: replayOptions.scenario,
        startedAt,
        updatedAt: startedAt
      })
    );
    const liveSnapshot = this.captureReplaySnapshot();
    const sourceTicks = await this.replayJournal.loadTicks(limit, dateFrom, dateTo);
    const ticks = sourceTicks.map((tick, index) =>
      applyReplayScenarioToTick(tick, replayOptions.scenario, index, sourceTicks.length)
    );
    const initialShadowBankroll = resolveInitialShadowBankroll({
      requestedShadowBankroll: shadowBankroll,
      liveEquity: this.engineState.bankroll.equity,
      liveCash: this.engineState.bankroll.cash,
      fallbackBankroll: DEFAULT_PAPER_BANKROLL_USD
    });
    await this.replayJournal.writeStatus(
      buildReplayStatus({
        replayId,
        status: "RUNNING",
        ticksTotal: ticks.length,
        ticksProcessed: 0,
        speedMultiplier,
        shadowBankroll: initialShadowBankroll,
        dateFrom,
        dateTo,
        scenario: replayOptions.scenario,
        startedAt,
        updatedAt: new Date().toISOString()
      })
    );
    const historicalTrades =
      ticks.length > 0
        ? await this.replayJournal.loadTrades(ticks[0].receivedAt, ticks.at(-1)!.receivedAt)
        : [];
    const shadowTrades = markHistoricalReplayTrades(historicalTrades, ticks);

    this.cachedConfig = buildShadowReplayConfig({
      currentConfig: this.cachedConfig,
      initialShadowBankroll,
      defaultMaxPositionPct: DEFAULT_MAX_POSITION_PCT,
      defaultMaxInventoryUnits: DEFAULT_MAX_INVENTORY_UNITS,
      startedAt,
      replayId
    });
    this.orderBook.clear();
    this.bids.clear();
    this.asks.clear();
    this.bookSync.clear();
    this.latencyHistory = [];
    this.processingLatencySamples = [];
    this.domWallHistory = [];
    this.leadLagSamples = new Map();
    this.engineState = buildShadowReplayEngineState({
      liveState: this.engineState,
      cachedConfig: this.cachedConfig,
      initialShadowBankroll,
      startedAt,
      replayId
    });
    this.profilerRegistry.reset();
    this.anomalyDetector.hydrate(null);
    this.oracleAgent.hydrate(null);
    this.sentimentAgent.hydrate(null);

    let replayLoop: ShadowReplayLoopResult | null = null;
    try {
      replayLoop = await runShadowReplayLoop({
        replayId,
        ticks,
        replayOptions,
        speedMultiplier,
        initialShadowBankroll,
        dateFrom,
        dateTo,
        startedAt,
        enqueueShadowReplayTick: (tick) => this.enqueueTick(tick, null, { shadowReplay: true }),
        lastTradeIntent: () => this.engineState.lastTradeIntent,
        oracleRegime: () => this.engineState.oracle.regime,
        writeStatus: (status) => this.replayJournal.writeStatus(status)
      });
    } finally {
      await this.restoreReplaySnapshot(liveSnapshot);
    }

    if (!replayLoop) {
      throw new Error("REPLAY_LOOP_DID_NOT_COMPLETE");
    }

    const completedAt = new Date().toISOString();
    const replayBuild = buildHistoricalReplayResult({
      replayId,
      ticksReplayed: replayLoop.ticksReplayed,
      initialShadowBankroll,
      historicalTradeCount: historicalTrades.length,
      generatedIntentCount: replayLoop.generatedIntentCount,
      speedMultiplier,
      replayOptions,
      modeledTrades: replayLoop.modeledTrades,
      shadowTrades,
      sentiment: this.engineState.sentiment,
      startedAt,
      completedAt
    });
    const result = replayBuild.result;

    this.logger.warn(
      "REPLAY_COMPLETED",
      "Historical shadow replay completed",
      replayBuild.logMetadata
    );
    await this.replayJournal.recordBacktestRun(result, replayOptions, dateFrom, dateTo);
    await this.replayJournal.writeStatus(
      buildReplayStatus({
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
        startedAt,
        updatedAt: completedAt,
        completedAt
      })
    );

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

  private async restoreReplaySnapshot(snapshot: EngineReplaySnapshot): Promise<void> {
    const hydratedBooks = hydrateReplayOrderBooks(snapshot);
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
    this.profilerRegistry.hydrate(snapshot.profilerState, new Map(snapshot.profilerStates));
    this.anomalyDetector.hydrate(snapshot.anomalyState);
    this.oracleAgent.hydrate(snapshot.oracleState);
    this.sentimentAgent.hydrate(snapshot.sentimentState);
    this.rateLimiter.hydrate(snapshot.rateLimits);

    await this.safeStorageDelete([...persistedBookKeys.keys()], "REPLAY_RESTORE_DELETE_BOOKS");

    await this.safeStoragePut(buildReplayRestoreWrites(snapshot), "REPLAY_RESTORE");
  }

  private updateLatencyAverage(totalLatencyMs: number): void {
    const next = nextLatencyAverage(
      {
        averageLatency: this.engineState.averageLatency,
        latencySampleCount: this.engineState.latencySampleCount
      },
      totalLatencyMs
    );

    this.engineState = {
      ...this.engineState,
      averageLatency: next.averageLatency,
      latencySampleCount: next.latencySampleCount
    };
  }

  private resetLatencyBaseline(observedAt: string, reason: string): void {
    this.latencyHistory = [];
    this.processingLatencySamples = [];
    this.engineState = stateAfterLatencyBaselineReset(this.engineState, observedAt);
    this.logger.info("LATENCY_BASELINE_RESET", "Reset stale latency baseline", {
      reason,
      observedAt
    });
  }

  private latencyStorageWrites(extra?: Record<string, unknown>): Record<string, unknown> {
    return latencySnapshotStorageWrites({
      engineStateKey: ENGINE_STATE_KEY,
      state: this.engineState,
      performanceHistoryKey: PERFORMANCE_HISTORY_KEY,
      latencyHistory: this.latencyHistory,
      processingLatencySamplesKey: PROCESSING_LATENCY_SAMPLES_KEY,
      processingLatencySamples: this.processingLatencySamples,
      extra
    });
  }

  private observeExecutionProfile(metrics: LatencyMetrics, trace: ExecutionTraceInput): void {
    const processingLatencyMs = recordProcessingLatencySample(
      this.processingLatencySamples,
      metrics.processingLatencyMs,
      this.jitterSampleWindow
    );
    const nextProcessedTicks = this.engineState.processedTicks + 1;
    const totalHotPathMs = roundLatency(Math.max(0, highResolutionNow() - trace.hotPathStartedAt));
    const { profile: nextProfile, shouldCompute } = nextExecutionProfile({
      previousProfile: this.engineState.executionProfile,
      processingLatencySamples: this.processingLatencySamples,
      processingLatencyMs,
      nextProcessedTicks,
      jitterThresholdMs: this.jitterThresholdMs,
      jitterSampleWindow: this.jitterSampleWindow,
      jitterComputeIntervalTicks: this.jitterComputeIntervalTicks,
      coldStartWakeupThresholdMs: COLD_START_WAKEUP_THRESHOLD_MS,
      totalHotPathMs,
      trace
    });

    this.engineState = {
      ...this.engineState,
      executionProfile: nextProfile
    };

    if (shouldCompute && nextProfile.status !== this.lastPerformanceStatus) {
      this.lastPerformanceStatus = nextProfile.status;
      const snapshot = buildPerformanceSnapshot(
        this.engineState.engineId,
        nextProfile,
        nextProcessedTicks,
        trace.observedAt
      );
      const transition = buildExecutionPerformanceTransition(snapshot);

      this.logger.logPerformanceSnapshot(snapshot);
      this.publish(transition.telemetryType, transition.telemetryPayload, transition.correlationId);
      this.notifier.notify(transition.notification);
    }
  }

  private performanceMetricsResponse(): Response {
    const body = buildPerformanceMetricsText({
      engineId: this.engineState.engineId,
      profile: this.engineState.executionProfile,
      processedTicks: this.engineState.processedTicks,
      toxicityScore: this.engineState.toxicityScore
    });

    return new Response(body, {
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
    const telemetry = buildTickTelemetryPayload({
      tick,
      metrics,
      status,
      cpuTimeMs,
      engineState: this.engineState,
      macroBias: this.macroBias,
      temporaryOverride: this.activeTemporaryOverride,
      connectedAdminStreams: this.adminSockets.size,
      signals: this.signals
    });

    this.publish("TICK_TELEMETRY", telemetry.payload, telemetry.correlationId);
  }

  private maybeRecordAgentSnapshot(observedAt: string): void {
    const snapshot = buildAgentStateSnapshot({
      engineState: this.engineState,
      latestAgentSignals: this.latestAgentSignals,
      observedAt,
      snapshotIntervalTicks: AGENT_SNAPSHOT_TICK_INTERVAL
    });

    if (!snapshot) {
      return;
    }

    this.publish("AGENT_STATE_SNAPSHOT", snapshot.payload, snapshot.correlationId);
  }

  private logPerformance(latencyMetrics: LatencyMetrics): void {
    if (
      !shouldLogPerformanceSpikeEvent({
        logAt: this.performanceSpikeLogAt,
        latencyMetrics,
        throttleMs: HOT_PATH_LOG_THROTTLE_MS
      })
    ) {
      return;
    }

    this.logger.logPerformance(latencyMetrics);
  }

  private triggerEmergencyPause(
    tick: MarketTick,
    book: InternalOrderBook,
    domSnapshot: DomAnalysisSnapshot,
    anomalyResult: AnomalyDetectionResult,
    metrics: LatencyMetrics
  ): void {
    const event = buildAnomalyEmergencyPauseTelemetry({
      tick,
      book,
      domSnapshot,
      anomalyResult,
      metrics,
      engineState: this.engineState
    });

    this.logger.writeLog(
      "CRITICAL",
      "TradingEngine",
      "Emergency pause triggered by market anomaly detector",
      event.logMetadata
    );
    this.publish("EMERGENCY_PAUSE", event.payload, event.correlationId);
    this.notifier.notify(event.notification);
  }

  private publishProfilerAlert(signal: AgentSignal, profilerState: ProfilerState): void {
    const event = buildProfilerAlertTelemetry(signal, profilerState);
    this.publish(event.telemetryType, event.payload, event.correlationId);
  }

  private publishAmVpinTelemetry(
    profilerState: ProfilerState,
    instrumentCode: string,
    observedAt: string
  ): void {
    const event = buildAmVpinTelemetry(profilerState, instrumentCode, observedAt);
    this.publish(event.telemetryType, event.payload, event.correlationId);
  }

  private publish(type: string, payload: Record<string, unknown>, correlationId?: string): void {
    this.telemetryBus.publish(type, payload, correlationId);
  }

  private observeTopology(topology: EdgeTopology): void {
    const observation = stateAfterTopologyObservation({
      state: this.engineState,
      topology,
      env: this.env,
      config: this.cachedConfig
    });
    this.engineState = observation.state;

    if (!observation.changed) {
      return;
    }

    this.waitUntilStoragePut(ENGINE_STATE_KEY, this.engineState, "COLO_TOPOLOGY_CHANGED");

    for (const event of buildTopologyObservationLogEvents({
      observation,
      maxOrderNotional: this.engineState.risk.maxOrderNotional,
      baseMaxPositionSize: this.cachedConfig.MAX_POSITION_SIZE
    })) {
      this.logger.warn(event.eventType, event.message, event.metadata);
    }
  }

  private applyLocationLatency(totalLatencyMs: number, observedAt: string): void {
    this.engineState = stateAfterLocationLatency({
      state: this.engineState,
      totalLatencyMs,
      observedAt,
      config: this.cachedConfig
    });
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
    this.profilerRegistry.configure(nextConfig);
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
    const profilerStates = this.profilerRegistry.snapshot();

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

    this.engineState = stateAfterConfigRefresh({
      currentState: this.engineState,
      nextConfig,
      macroBias: this.macroBias,
      temporaryOverride: this.activeTemporaryOverride,
      nextAssetQuoteStates,
      nextQuoteState,
      assetMatrix: this.calculateAssetMatrix(
        now,
        this.engineState.microstructure.instrumentCode ?? undefined,
        this.engineState.oracle,
        profilerStates,
        nextAssetQuoteStates
      ),
      profilerStates,
      refreshedLocation,
      observedAt: now
    });

    await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "CONFIG_REFRESH");

    const refreshLogInput = {
      source,
      previousVersion,
      nextConfig,
      macroBias: this.macroBias,
      temporaryOverride: this.activeTemporaryOverride
    };
    if (shouldLogConfigRefresh(refreshLogInput)) {
      this.logger.warn(
        "CONFIG_REFRESHED",
        "Trading engine config cache refreshed",
        buildConfigRefreshLog(refreshLogInput)
      );
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
    recordAgentSignalInBuffers({
      signals: this.signals,
      latestAgentSignals: this.latestAgentSignals,
      signal,
      signalBufferLimit: SIGNAL_BUFFER_LIMIT
    });
    const acceptedSignal = stateAfterAcceptedAgentSignal({
      engineState: this.engineState,
      signal,
      latencyMs
    });
    this.engineState = acceptedSignal.state;

    await this.safeStoragePut(
      acceptedAgentSignalStorageEntries({
        engineStateKey: ENGINE_STATE_KEY,
        state: this.engineState,
        signal
      }),
      "AGENT_SIGNAL"
    );

    this.logger.agentDecision(signal, latencyMs);
    this.publish(
      acceptedSignal.telemetry.telemetryType,
      acceptedSignal.telemetry.payload,
      acceptedSignal.telemetry.correlationId
    );

    if (acceptedSignal.hawkesEvacuation) {
      const evacuation = buildHawkesEvacuationDispatch(signal, this.engineState.quoteState);
      this.publish(evacuation.telemetryType, evacuation.payload, evacuation.correlationId);
      if (this.cachedConfig.TRADING_ENABLED) {
        this.state.waitUntil(
          this.cancelAllQuotes(evacuation.cancelInstrumentCode, evacuation.cancelReason)
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
    const event = buildCascadeOperationalAlertTelemetry(
      eventType,
      title,
      message,
      metadata,
      dedupeKey
    );

    this.publish(event.telemetryType, event.payload, event.correlationId);
    if (!event.notification) {
      return;
    }

    this.notifier.notify(event.notification);
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
    recordAgentSignalInBuffers({
      signals: this.signals,
      latestAgentSignals: this.latestAgentSignals,
      signal,
      signalBufferLimit: SIGNAL_BUFFER_LIMIT
    });
    this.state.waitUntil(
      this.safeStoragePut(agentSignalStorageKey(signal), signal, "CASCADE_SIGNAL")
    );
    const event = buildCascadeSignalTelemetry(signal, outcome);
    this.publish(event.telemetryType, event.payload, event.correlationId);
  }

  private async applyConfigUpdate(update: AdminConfigUpdate): Promise<void> {
    if (update.signal === "REFRESH_CONFIG" || update.config) {
      const directConfig = update.config
        ? configFromAdminSnapshot({
            currentConfig: this.cachedConfig,
            snapshot: update.config
          })
        : undefined;
      await this.refreshConfig("ADMIN_SIGNAL", directConfig);
      await this.scheduleConfigRefresh();
      if (!hasRuntimeConfigUpdate(update)) {
        return;
      }
    }

    const now = new Date().toISOString();
    const runtimeUpdate = stateAfterRuntimeConfigUpdate({
      currentState: this.engineState,
      update,
      cachedConfig: this.cachedConfig,
      macroBias: this.macroBias,
      temporaryOverride: this.activeTemporaryOverride,
      currentMaxLatencyMs: this.maxLatencyMs,
      observedAt: now
    });

    this.maxLatencyMs = runtimeUpdate.maxLatencyMs;
    this.engineState = runtimeUpdate.state;

    await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "ADMIN_CONFIG_APPLIED");

    this.logger.warn(
      "ADMIN_CONFIG_APPLIED",
      "Runtime configuration updated",
      buildRuntimeConfigAppliedLog({ state: this.engineState, maxLatencyMs: this.maxLatencyMs })
    );
  }
}
