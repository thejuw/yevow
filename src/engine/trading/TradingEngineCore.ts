/* eslint-disable */
import { configFromAdminSnapshot, defaultConfig, type ConfigManager } from "../../ConfigManager";
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
import {
  AnomalyDetector,
  ANOMALY_DETECTOR_STORAGE_KEY,
  type AnomalyDetectionResult
} from "../../agents/AnomalyDetector";
import { CroupierAgent, type CroupierDecision } from "../../agents/CroupierAgent";
import { evaluateIntentDispatchGate } from "../IntentGeneration";
import { AdverseSelectionModel } from "../AdverseSelectionModel";
import {
  applyLocationRisk,
  buildTopologyObservationLogEvents,
  defaultEngineLocation,
  resolveEngineLocation,
  stateAfterLocationLatency,
  stateAfterTopologyObservation
} from "./helpers/PlacementResolver";
import { priceKey, SortedBookSide } from "./book/SortedBookSide";
import { countBookLevels, isCrossedBook, microstructureFromBook } from "./book/BookReconstruction";
import {
  calculateOrderBookPriceDiscovery,
  currentMarkPriceForInstrument,
  currentBookForMarketTick,
  currentOrderBookSnapshot,
  findBestAssetBook as findBestOrderBookForAsset,
  nullableMarkPriceForInstrument
} from "./book/BookViews";
import {
  bookDesyncStorageExtra,
  markBookSyncDesynced,
  shouldEmitBookSnapshotTelemetry,
  stateAfterAcceptedBookDelta,
  stateAfterBookSnapshot,
  stateAfterDesyncedBook,
  stateAfterInformationalBookNotReady,
  stateAfterRejectedBookDelta,
  rejectedBookDeltaIngestResult,
  bookSnapshotTelemetry,
  bookSnapshotStorageWrites
} from "./book/BookRuntimeState";
import {
  orderBookResetRuntimeArtifacts,
  resolveOrderBookReset
} from "./book/OrderBookResetRuntime";
import { buildDomAnalysisSnapshot, currentDomHeatmapSnapshot } from "./book/DomAnalyzer";
import {
  buildShadowQueueDecisionRuntimeArtifacts,
  buildShadowQueueGhostFillRuntimeRecord,
  buildShadowQueueLatencyBreachTelemetry,
  buildShadowQueueNoEdgeTelemetry,
  enforceShadowQueueDecisionLatency,
  resolveShadowQueueGhostFillConfig,
  resolveShadowQueueNoEdgeLogInterval,
  resolveShadowQueueSizingConfig,
  type ShadowQueueDecisionAction,
  shouldLogShadowQueueNoEdge as shouldLogShadowQueueNoEdgeEvent,
  shouldProcessShadowQueueTick
} from "./shadow/ShadowQueueRuntime";
import {
  anomalyEmergencyPauseArtifacts,
  type AnomalyEmergencyPauseTelemetry
} from "./anomaly/AnomalyRuntime";
import {
  buildCrossAssetHypeCancelArtifacts,
  evaluateCrossAssetHypeQuoteCancel,
  resolveCrossAssetHypeQuoteCancelConfig,
  updateLeadLagMetrics as updateLeadLagRuntimeMetrics
} from "./leadlag/LeadLagRuntime";
import {
  buildInventoryHedgeIntent,
  calculateInventoryState as calculateInventoryRuntimeState,
  inventoryHedgeAuthorizedLogMetadata,
  referencePriceForBaseAsset as resolveBaseAssetReferencePrice
} from "./inventory/InventoryRuntime";
import {
  buildDrawdownKillSwitchTransition,
  calculatePortfolioRisk as calculatePortfolioRuntimeRisk
} from "./risk/PortfolioRiskRuntime";
import { calculateEnsembleState as calculateRuntimeEnsembleState } from "./ensemble/EnsembleRuntime";
import {
  currentFundingRate as resolveCurrentFundingRate,
  stateAfterFundingTick
} from "./funding/FundingRuntime";
import {
  nextQuoteStateForInstrument as nextRuntimeQuoteStateForInstrument,
  applyQuoteSuppressionRuntime,
  applyQuoteSuppressionSideEffects,
  quoteSuppressionPolicyProjection,
  resolveQuoteHibernateMs,
  resumeExpiredQuoteStates,
  strategyQuoteDisabledReason as runtimeStrategyQuoteDisabledReason
} from "./quotes/QuoteStateRuntime";
import {
  buildQuoteDispatchIntents,
  buildQuoteRefreshRuntimeDecision,
  dispatchedQuoteSnapshot,
  quoteDispatchBlockedLogMetadata,
  quoteRefreshThrottleLogMetadata,
  type CroupierQuoteAction
} from "./quotes/QuoteDispatchRuntime";
import { dispatchQuoteCancelAll, evaluateQuoteCancelDispatch } from "./quotes/QuoteCancelRuntime";
import {
  buildApprovedExecutionPlan,
  shouldSkipExecutionPlanForQuoteSuspension,
  type ApprovedExecutionPlan
} from "./execution/ExecutionPlanRuntime";
import {
  buildExecutionDispatchRuntimeDecision,
  buildExecutionPlanDispatchAction,
  dispatchTradeIntentToExecutioner,
  emitExecutionDispatchBlockLog
} from "./execution/ExecutionDispatchRuntime";
import { buildExecutionReportRuntimeUpdate } from "./execution/ExecutionReportRuntime";
import {
  buildOracleTickInput,
  buildProfilerContext,
  disabledOracleTickResult,
  evaluateCroupierRuntime,
  type OracleTickResult
} from "./agents/AgentEvaluationRuntime";
import { applyIntentPaperExecutionBudget } from "./execution/PaperExecutionBudgetRuntime";
import {
  buildExecutionQueueEnqueuePlan,
  executionQueueDeferralLogMetadata,
  shouldLogExecutionQueueDeferral,
  splitExecutionQueueForDrain,
  type QueuedExecutionIntent
} from "./execution/ExecutionQueueRuntime";
import { calculateAssetMatrix as calculateRuntimeAssetMatrix } from "./state/AssetMatrixRuntime";
import {
  buildHardStaleTickDropArtifacts,
  buildExecutionPerformanceTransition,
  buildPerformanceMetricsText,
  buildPerformanceSnapshot,
  buildStaleDataKillSwitchArtifacts,
  latencySnapshotStorageWrites,
  nativeHyperliquidLatencyPullStorageWrites,
  nextExecutionProfile,
  nextLatencyAverage,
  prepareTickLatencyRuntime,
  recordProcessingLatencySample,
  shouldLogPerformanceSpikeEvent,
  stateAfterLatencyBaselineReset,
  stateAfterNativeHyperliquidLatencyPull,
  stateAfterHardStaleTickDrop,
  stateAfterStaleDataKillSwitch,
  type ExecutionTraceInput
} from "./performance/LatencyRuntime";
import {
  buildJanitorRunArtifacts,
  cancelJanitorOrder,
  fetchJanitorExchangeOpenOrders,
  reconcileJanitorOrders,
  recordPostOnlyDustCloseSkip
} from "./janitor/JanitorRuntime";
import {
  currentCascadeActiveSnapshot as buildCurrentCascadeActiveSnapshot,
  currentCascadeHeatSnapshot as buildCurrentCascadeHeatSnapshot,
  currentCascadePositionSnapshot as buildCurrentCascadePositionSnapshot,
  currentCascadeSignalSnapshot as buildCurrentCascadeSignalSnapshot
} from "./cascade/CascadeSnapshots";
import {
  cascadeDetectedAlertMetadata,
  cascadeDetectedLogMetadata,
  cascadeDetectedTelemetryPayload,
  liquidationEventProcessingResult,
  persistCascadeLiquidationEvents,
  resolveLiquidationEventContext
} from "./cascade/CascadeLiquidationRuntime";
import {
  buildCascadeEntryTradeIntent,
  buildCascadeExitTradeIntent
} from "./cascade/CascadeTradeIntents";
import {
  absorptionConfirmedAlertMetadata,
  absorptionConfirmedLogMetadata,
  absorptionConfirmedTelemetryPayload,
  buildCascadeAbsorptionObservation,
  nextCascadeCvd
} from "./cascade/CascadeAbsorptionRuntime";
import {
  buildConfigRefreshLog,
  buildRuntimeConfigAppliedLog,
  configRefreshQuoteState,
  configRefreshTopologyFromLocation,
  shouldLogConfigRefresh,
  stateAfterConfigRefresh,
  stateAfterRuntimeConfigUpdate
} from "./config/ConfigRuntime";
import {
  absorptionAnalyzerConfig as buildAbsorptionAnalyzerConfig,
  cascadeAssetProfileFromConfig,
  cascadeDetectorConfig as buildCascadeDetectorConfig,
  cascadeRecoverySignalConfig as buildCascadeRecoverySignalConfig
} from "./cascade/CascadeConfigRuntime";
import { OrderBookReconstructor, type OrderBookStores } from "./book/OrderBookReconstructor";
import type { AppliedBookUpdate, BookDeltaWithTicker, BookSyncState } from "./book/BookTypes";
import {
  buildHyperliquidL2BookTick,
  buildHyperliquidL2BookTickFromBook,
  evaluateHyperliquidL2BookRuntime,
  handleHyperliquidRawBatch,
  hyperliquidBookDesyncLogMetadata,
  processHyperliquidAssetContext,
  processHyperliquidTradeBatch,
  registerHyperliquidIngestConnection,
  routeHyperliquidRawMessage,
  type HyperliquidL2BookHotPathDecision,
  type HyperliquidRawIngestPayload
} from "./ingest/HyperliquidRawIngest";
import { grpcFatalDropArtifacts } from "./ingest/GrpcDropRuntime";
import {
  handleTradingEngineHttpRoute,
  type EngineHttpRouteContext
} from "./routes/EngineHttpRoutes";
import { buildTradingEngineFetchRequestContext } from "./routes/EngineFetchRuntime";
import {
  acceptMarketStream as acceptTradingMarketStream,
  acceptTelemetryStream as acceptTradingTelemetryStream
} from "./routes/EngineWebSocketStreams";
import type { TradingTelemetryBus } from "./telemetry/TelemetryBus";
import {
  acceptedAgentSignalStorageEntries,
  agentSignalStorageKey,
  buildHawkesEvacuationDispatch,
  recordAgentSignalInBuffers,
  stateAfterAcceptedAgentSignal
} from "./telemetry/AgentSignalRuntime";
import { buildAgentStateSnapshot } from "./telemetry/AgentSnapshotRuntime";
import {
  buildCascadeOperationalAlertTelemetry,
  buildCascadeSignalTelemetry,
  cascadeCloseOperationalAlert,
  cascadeEntryAgentSignal,
  cascadeEntryDecisionTrace,
  cascadeHeatCapAlertMetadata,
  cascadePositionOpenedAlertMetadata,
  cascadeSignalRejectionAgentSignal,
  cascadeSignalRejectionLogMetadata,
  cascadeSignalEmittedAlertMetadata,
  cascadeSizeRejectedLogMetadata
} from "./telemetry/CascadeSignalTelemetryRuntime";
import {
  buildAmVpinTelemetry,
  buildProfilerAlertTelemetry,
  shouldCancelQuotesForProfilerSignal
} from "./telemetry/ProfilerTelemetryRuntime";
import {
  bayesianPosteriorUpdatedLogMetadata,
  buildTickTelemetryPayload,
  marketTickAcceptedLogMetadata,
  shouldLogBayesianPosteriorUpdate,
  shouldLogMarketTickAccepted
} from "./telemetry/TickTelemetryRuntime";
import { type ReplayOptions, type ReplayScenario } from "./routes/ReplayAdminRoutes";
import {
  markHistoricalReplayTrades,
  type ReplayJournal,
  type ReplayTradeRow
} from "./replay/ReplayJournal";
import { runShadowReplayLoop, type ShadowReplayLoopResult } from "./replay/ReplayLoopRuntime";
import {
  buildCompletedReplayArtifacts,
  buildReplayStatus,
  buildShadowReplayConfig,
  buildShadowReplayEngineState,
  resolveInitialShadowBankroll
} from "./replay/ReplayResultRuntime";
import {
  buildReplayRestoreWrites,
  captureEngineReplaySnapshot,
  hydrateReplayOrderBooks,
  type EngineReplaySnapshot
} from "./replay/ReplaySnapshotRuntime";
import type { GrpcFatalDropPayload, TickIngestResult } from "./TradingEngineRouteTypes";
import {
  buildHealthReport,
  engineDiagnostics as buildEngineDiagnostics,
  stateAfterHealthHeartbeat,
  syncStateMicrostructureFromBook as syncEngineStateMicrostructure
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
import { buildHydratedEngineState } from "./state/EngineBootState";
import {
  createTradingEngineBootServices,
  tradingEngineLoggerRuntimeContext
} from "./state/EngineBootServices";
import {
  shadowModeAutoResumeLogMetadata,
  shadowModeAutoResumeTelemetry,
  shouldAutoResumeShadowMode,
  stateAfterAcceptedTick,
  stateAfterShadowModeAutoResume
} from "./state/TickStateRuntime";
import { evaluateTickAvailability } from "./state/TickAvailabilityRuntime";
import {
  buildHotPathTickSnapshotWrites,
  shouldJournalMarketTick as shouldPersistMarketTick
} from "./state/TickPersistenceRuntime";
import {
  adminRecoveryCompletionArtifacts,
  adminRecoveryPlan,
  stateAfterAdminControlledRecovery
} from "./state/RecoveryRuntime";
import {
  evaluateHotStorageSnapshotDecision,
  resolveHotStorageSnapshotIntervalMs,
  resolveHotStorageSnapshotTickInterval,
  type StorageWriteGuard
} from "./state/StorageWriteGuard";
import {
  emptyLogPruneReport,
  logRetentionPolicyToJson,
  pruneOperationalLogsFromD1,
  resolveLogRetentionPolicy,
  type LogPruneReport
} from "../LogRetention";
import {
  MultiScaleVolatilityModel,
  type MultiScaleVolatilitySnapshot
} from "../MultiScaleVolatility";
import { QueuePositionModel } from "../QueuePositionModel";
import { isInventoryHedgeIntent } from "../../execution/RiskGuards";
import {
  HeatmapAgent,
  LIQUIDATION_HEATMAP_STORAGE_KEY,
  defaultLiquidationHeatmapState
} from "../../agents/HeatmapAgent";
import { JanitorAgent } from "../../agents/JanitorAgent";
import { OracleAgent, defaultOracleState } from "../../agents/OracleAgent";
import { PitBossAgent } from "../../agents/PitBossAgent";
import { SentimentAgent, defaultSentimentState } from "../../agents/SentimentAgent";
import { RateLimiter, type RateLimitBucketSnapshot } from "../../utils/RateLimiter";
import type { Notifier } from "../../utils/Notifier";
import { isShadowMode } from "../../utils/CitadelProtocol";
import type { GhostBook, GhostBookConfig, GhostBookObservation } from "../../utils/GhostBook";
import { AbsorptionAnalyzer } from "../../strategy/cascade/AbsorptionAnalyzer";
import type { CascadeAssetProfile } from "../../strategy/cascade/AssetProfiles";
import type { Backtester } from "../../strategy/cascade/Backtester";
import { CascadeCandleAggregator } from "../../strategy/cascade/CandleAggregator";
import { CascadeDetector } from "../../strategy/cascade/CascadeDetector";
import { CascadeRecoverySignalEngine } from "../../strategy/cascade/CascadeRecoverySignal";
import { calculateAtr } from "../../strategy/cascade/indicators/ATR";
import { cumulativeVolumeDelta } from "../../strategy/cascade/indicators/CumulativeVolumeDelta";
import { HyperliquidLiquidationStream } from "../../strategy/cascade/LiquidationStream";
import { HeatManager } from "../../strategy/cascade/HeatManager";
import type { NewsCalendar } from "../../strategy/cascade/NewsCalendar";
import type { CascadeAlertEventType } from "../../strategy/cascade/OperationalSafeguards";
import { PositionManager } from "../../strategy/cascade/PositionManager";
import { calculatePositionSize } from "../../strategy/cascade/PositionSizer";
import { calculateVwap } from "../../strategy/cascade/indicators/VWAP";
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
  BayesianUpdateTrace,
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
} from "../../types";
import type {
  AbsorptionAnalyzerConfig,
  AbsorptionConfirmed,
  Candle,
  CascadeDetectorConfig,
  CascadeEvent,
  CascadeOpenPosition,
  CascadePositionIntent,
  CascadeRecoverySignal,
  CascadeRecoverySignalRejection,
  CascadeRecoverySignalResult,
  LiquidationEvent,
  PositionSizeDecision
} from "../../strategy/cascade/types";

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
} from "../../TradingEngineConstants";
import {
  resolveBookSide,
  resolveCurrentInstrument,
  buildMarketKey,
  hydrateOrderBooks,
  hydrateLegacyLevel,
  levelsToBookSide,
  tickToDelta,
  calculateTimeToBookMs,
  resolveTickSize,
  resolveDomBinSize,
  parseTickSizeMap,
  parsePositiveNumberMap
} from "./book/BookRuntimeHelpers";
import { sanitizeWallHistory } from "./book/DomRuntimeHelpers";
import {
  cascadeInstrumentSet,
  latestAbsorptionForInstrument,
  latestCascadeAtForInstrument,
  recentSwingLow,
  recentSwingHigh
} from "./cascade/CascadeSelectionRuntime";
import {
  cascadeManualCloseArtifacts,
  cascadePositionNotOpenResponse,
  openCascadePositionById
} from "./cascade/CascadeManualCloseRuntime";
import { hasRuntimeConfigUpdate } from "./config/RuntimeConfigUpdateDetection";
import {
  epochMillis,
  nativeHashSequence,
  normalizeNativeCoin,
  normalizeNativeInstrumentCode,
  splitNativeInstrument,
  baseAssetFromInstrument,
  nativeBookSideLevels,
  nativeNumber,
  nativeSide,
  normalizeSourceExchange,
  normalizeSourceWeight
} from "./helpers/NativeHyperliquidRuntime";
import { highResolutionNow, roundLatency } from "./helpers/RuntimeClock";
import { wait } from "./helpers/RuntimeMath";
import {
  prometheusLabels,
  escapePrometheusLabel,
  finiteMetric,
  nullableFiniteMetric
} from "./helpers/RuntimeMetrics";
import {
  readNumber,
  readPositiveNumber,
  readPositiveInteger,
  readBoundedNumber,
  clampInteger,
  assertAgentSignal,
  finiteNumber,
  isPlainObject,
  readHyperliquidRawIngestPayload,
  readJsonOrNull,
  json
} from "./helpers/RuntimeParsing";
import { applyReplayScenarioToTick } from "./replay/ReplayModelRuntime";
import { resolveGhostBookConfig } from "./shadow/GhostBookConfigRuntime";
import {
  defaultQuoteState,
  defaultAssetQuoteStates,
  selectedMoltworkerInstruments,
  isInstrumentSelectedByMoltworker,
  normalizeAssetMatrix,
  filterTargetOrderBooks,
  defaultAssetMatrix,
  normalizeAssetQuoteStates,
  quoteStateForInstrumentState,
  isQuoteSuspendedAt,
  suspendAssetQuoteStates,
  aggregateQuoteState,
  quotePriceMovedTicks,
  normalizeMarketKey
} from "./state/AssetStateRuntime";
import {
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
  defaultShadowQueueState,
  defaultCitadelState,
  maintenanceRecoveryInstruments,
  defaultInventoryGuardState,
  passiveInventoryGuardStateFromInventory,
  defaultJanitorState,
  defaultSlippageAnalytics,
  defaultRiskLimits,
  mergeRiskLimits,
  resolveMaxLatencyMs
} from "./state/EngineStateDefaults";
import { isInformationalTick, isTradeTick } from "./state/TickClassification";
import { evaluateTickTargetPreflight } from "./state/TickPreflightRuntime";
import {
  buildAcceptedTickFinalizationArtifacts,
  buildAcceptedTickLifecycleArtifacts,
  buildAcceptedTickStateTransition
} from "./pipelines/AcceptedTickRuntime";
import type {
  AcceptedDecisionPipelineInput,
  AcceptedExecutionContext,
  AcceptedTickSideEffectsInput,
  AcceptedTickStateCommitInput,
  HistoricalReplayCompletionInput,
  HistoricalReplayStatusInput,
  LoadedReplayShadowTrades,
  LoadedReplayTicks,
  PostBookTickContext,
  QuotePolicyResult,
  ShadowReplayWithRestoreInput,
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
    this.orderBookReconstructor = this.createOrderBookReconstructor();

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

    const routeContext = buildTradingEngineFetchRequestContext(request);
    if (routeContext.isMarketDataRequest) {
      this.observeTopology(routeContext.topology);
      this.warmUpForTopology(routeContext.topology);
    }

    if (routeContext.webSocketRoute === "TELEMETRY_STREAM") {
      return acceptTradingTelemetryStream(this.streamContext());
    }

    if (routeContext.webSocketRoute === "MARKET_STREAM") {
      return acceptTradingMarketStream(this.streamContext());
    }

    try {
      return await handleTradingEngineHttpRoute(
        request,
        routeContext.url,
        this.engineHttpRouteContext(wakeUpTimeMs)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
      const status = message.startsWith("INVALID_") ? 400 : 500;

      this.logger.error(
        "ENGINE_REQUEST_FAILED",
        "Trading engine request failed",
        { path: routeContext.url.pathname, message },
        routeContext.requestId
      );

      return json({ ok: false, error: message, requestId: routeContext.requestId }, status);
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

  private async handleStaleHyperliquidL2Book(
    l2Decision: Extract<HyperliquidL2BookHotPathDecision, { kind: "STALE" }>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null,
    hotPathStartedAt: number
  ): Promise<TickIngestResult> {
    const { instrumentCode, sequence, snapshot } = l2Decision.bundle;
    const { brainTimestamp, totalLatencyMs } = l2Decision;
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
        const syncState = this.bookSync.get(l2Decision.bundle.marketKey);
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
        this.orderBook.set(l2Decision.bundle.marketKey, staleBook.book);
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

  private async handleAcceptedHyperliquidL2Book(
    l2Decision: Extract<HyperliquidL2BookHotPathDecision, { kind: "ACCEPTED" }>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult> {
    const { sequence, snapshot } = l2Decision.bundle;
    const { brainTimestamp, totalLatencyMs } = l2Decision;
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

  private async handleHyperliquidL2Book(
    raw: Record<string, unknown>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult> {
    const hotPathStartedAt = highResolutionNow();
    const l2Decision = evaluateHyperliquidL2BookRuntime({
      raw,
      payload,
      resolveExistingSync: (marketKey) => this.bookSync.get(marketKey),
      dwellirMaxLatencyMs: this.env.DWELLIR_MAX_LATENCY_MS,
      hlStaleAfterMs: this.env.HL_STALE_AFTER_MS,
      hlBookTimestampMaxDriftMs: this.env.HL_BOOK_TIMESTAMP_MAX_DRIFT_MS,
      hlSequenceGapMs: this.env.HL_SEQUENCE_GAP_MS,
      currentMaxLatencyMs: this.maxLatencyMs,
      averageLatencyMs: this.engineState.averageLatency,
      sampleCount: this.engineState.latencySampleCount,
      location: this.engineState.location
    });
    const { marketKey } = l2Decision.bundle;

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

    if (l2Decision.kind === "STALE") {
      return this.handleStaleHyperliquidL2Book(l2Decision, payload, wakeUpTimeMs, hotPathStartedAt);
    }

    return this.handleAcceptedHyperliquidL2Book(l2Decision, payload, wakeUpTimeMs);
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

    const liquidationResult = liquidationEventProcessingResult({
      currentState: this.engineState,
      context: liquidationContext,
      heatmap,
      previousEventCount,
      cascadeLiquidationCount: cascadeLiquidations.length,
      cascadeEventCount: cascadeEvents.length,
      engineStateKey: ENGINE_STATE_KEY,
      liquidationHeatmapKey: LIQUIDATION_HEATMAP_STORAGE_KEY
    });
    this.engineState = liquidationResult.state;

    this.state.waitUntil(this.safeStoragePut(liquidationResult.storageWrites, "LIQUIDATION_EVENT"));

    if (liquidationResult.shouldPublishTelemetry) {
      this.publish("LIQUIDATION_EVENT", liquidationResult.telemetryPayload);
    }

    return {
      accepted: true,
      status: "FRESH",
      processedCount: liquidationResult.processedCount
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
    const position = openCascadePositionById(this.cascadePositionManager.snapshot(), positionId);

    if (!position) {
      return cascadePositionNotOpenResponse();
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
      return cascadePositionNotOpenResponse();
    }

    const artifacts = cascadeManualCloseArtifacts({
      position,
      intents: update.intents,
      actor,
      reason,
      markPrice,
      observedAt
    });

    for (const intent of artifacts.executableIntents) {
      this.state.waitUntil(
        this.dispatchExecution(this.tradeIntentFromCascadePositionIntent(intent, observedAt))
      );
    }

    this.logger.warn(
      "CASCADE_POSITION_MANUAL_CLOSE",
      "Operator requested cascade position close",
      artifacts.logMetadata
    );
    this.publish("CASCADE_POSITION_MANUAL_CLOSE", artifacts.telemetryPayload, positionId);
    this.state.waitUntil(
      this.safeStoragePut(
        CASCADE_POSITIONS_KEY,
        this.cascadePositionManager.snapshot(),
        "CASCADE_POSITION_MANUAL_CLOSE"
      )
    );

    return artifacts.response;
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

  private recordRejectedCascadeSignal(
    rejection: CascadeRecoverySignalRejection,
    observedAt: string
  ): void {
    this.logger.info(
      "CASCADE_SIGNAL_REJECTED",
      "Cascade recovery signal gates rejected entry",
      cascadeSignalRejectionLogMetadata(rejection)
    );
    this.recordCascadeUiSignal(
      cascadeSignalRejectionAgentSignal({
        rejection,
        engineId: this.engineState.engineId,
        observedAt,
        entryWindowMs: this.cachedConfig.ENTRY_WINDOW_SECONDS * 1_000
      }),
      "SKIPPED"
    );
  }

  private evaluateCascadeRecoverySignal(
    cascade: CascadeEvent,
    absorption: AbsorptionConfirmed,
    reclaimCandle: Candle,
    observedAt: string
  ): CascadeRecoverySignalResult {
    const recent1mCandles = this.candleAggregator.snapshot(reclaimCandle.instrumentCode, "1m", 64);
    const latestRawEvent = cascade.rawEvents.at(-1) ?? null;
    const blackout = this.cascadeNewsCalendar.isWithinBlackout(
      new Date(observedAt),
      baseAssetFromInstrument(reclaimCandle.instrumentCode)
    );

    return this.cascadeSignalEngineWithConfig().evaluate({
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

      const signalResult = this.evaluateCascadeRecoverySignal(
        cascade,
        absorption,
        reclaimCandle,
        observedAt
      );

      if (!signalResult.accepted) {
        this.recordRejectedCascadeSignal(signalResult.rejection, observedAt);
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

  private handleRejectedCascadeSize(
    signal: CascadeRecoverySignal,
    sizeDecision: PositionSizeDecision,
    currentHeat: number
  ): void {
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
  }

  private openCascadePosition(
    signal: CascadeRecoverySignal,
    sizeDecision: PositionSizeDecision,
    assetProfile: CascadeAssetProfile,
    currentHeat: number,
    observedAt: string
  ): void {
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
      this.handleRejectedCascadeSize(signal, sizeDecision, currentHeat);
      return;
    }

    this.openCascadePosition(signal, sizeDecision, assetProfile, currentHeat, observedAt);
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
    const artifacts = grpcFatalDropArtifacts({
      payload,
      currentState: this.engineState,
      shadowMode: isShadowMode(this.env),
      engineStateKey: ENGINE_STATE_KEY
    });
    this.engineState = artifacts.state;
    this.state.waitUntil(
      this.persistHotStorageSnapshot(artifacts.storageWrites, "GRPC_FATAL_DROP")
    );
    this.logger.error(
      artifacts.events.telemetryType,
      "Dwellir gRPC blackout forced quote evacuation",
      artifacts.events.logMetadata
    );
    this.publish(artifacts.events.telemetryType, artifacts.events.telemetryPayload);
    if (artifacts.events.shouldCancelAllQuotes) {
      this.state.waitUntil(this.cancelAllQuotes("ALL", "GRPC_FATAL_DROP"));
    }

    return artifacts.response;
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
    const artifacts = orderBookResetRuntimeArtifacts({
      reset,
      currentState: this.engineState,
      persistedBooks,
      orderBookPrefix: ORDER_BOOK_PREFIX,
      engineStateKey: ENGINE_STATE_KEY,
      stores: this.orderBookStores(),
      orderBookSize: this.orderBook.size,
      internalOrderBookDepth: countBookLevels(this.bids, this.asks),
      priceDiscovery: reset.resetInstrument
        ? calculateOrderBookPriceDiscovery(this.orderBook, reset.resetInstrument, reset.now)
        : null
    });
    this.engineState = artifacts.state;

    if (artifacts.latencyResetReason) {
      this.resetLatencyBaseline(reset.now, artifacts.latencyResetReason);
      if (reset.connectionId) {
        for (const connectionKey of artifacts.connectionKeys) {
          this.activeIngestConnections.set(connectionKey, reset.connectionId);
        }
      }
    }

    await Promise.all([
      this.safeStoragePut(artifacts.writes, "ORDER_BOOK_RESET"),
      this.safeStorageDelete(artifacts.deleteKeys, "ORDER_BOOK_RESET_DELETE")
    ]);

    this.logger.warn(
      "ORDER_BOOK_RESET",
      "Internal order book purged after stream recovery",
      artifacts.telemetry
    );

    this.publish("ORDER_BOOK_RESET", artifacts.telemetry);
  }

  private async resetRecoveryOrderBooks(
    resetInstruments: readonly string[],
    reason: string,
    sourceExchange: string,
    observedAt: string
  ): Promise<void> {
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
  }

  private clearRecoveryShadowQueue(): void {
    this.ghostBook.reset();
    this.shadowQueueNoEdgeLogAt.clear();
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
    const recoveryPlan = adminRecoveryPlan(payload);

    await this.resetRecoveryOrderBooks(
      recoveryPlan.resetInstruments,
      recoveryPlan.reason,
      recoveryPlan.sourceExchange,
      recoveryPlan.observedAt
    );

    if (recoveryPlan.shouldClearLatency) {
      this.resetLatencyBaseline(recoveryPlan.observedAt, recoveryPlan.reason);
    }

    if (recoveryPlan.shouldClearShadowQueue) {
      this.clearRecoveryShadowQueue();
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
      observedAt: recoveryPlan.observedAt,
      shadowMode: isShadowMode(this.env),
      paperBankroll,
      shadowQueue: this.ghostBook.snapshot(recoveryPlan.observedAt),
      reason: recoveryPlan.reason,
      resetInstruments: recoveryPlan.resetInstruments,
      sourceExchange: recoveryPlan.sourceExchange,
      prunedProfilerStorageKeys
    });

    this.engineState = recovery.state;
    const artifacts = adminRecoveryCompletionArtifacts({
      plan: recoveryPlan,
      recovery,
      engineStateKey: ENGINE_STATE_KEY,
      performanceHistoryKey: PERFORMANCE_HISTORY_KEY,
      latencyHistory: this.latencyHistory,
      processingLatencySamplesKey: PROCESSING_LATENCY_SAMPLES_KEY,
      processingLatencySamples: this.processingLatencySamples
    });

    await this.safeStoragePut(artifacts.storageEntries, "ADMIN_CONTROLLED_RECOVERY");

    if (artifacts.paperSessionStartedAt) {
      this.state.waitUntil(
        this.env.CONFIG_STORE.put(PAPER_SESSION_STARTED_AT_KEY, artifacts.paperSessionStartedAt)
      );
    }

    this.logger.warn("ADMIN_CONTROLLED_RECOVERY", "Admin controlled recovery applied", {
      ...artifacts.logMetadata
    });
    this.publish("ADMIN_CONTROLLED_RECOVERY", artifacts.publishPayload);

    return artifacts.response;
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

    const staleArtifacts = buildHardStaleTickDropArtifacts({
      tick,
      metrics: hardStale.metrics,
      streamId,
      hardStaleDropMs,
      nextStaleTickCount: hardStale.nextStaleTickCount
    });

    if (staleArtifacts.shouldLog) {
      this.logger.warn("HARD_STALE_TICK_DROPPED", "Dropped tick beyond hard stale threshold", {
        ...staleArtifacts.logMetadata
      });
    }
    this.logPerformance(hardStale.metrics);
    this.publish("STALE_DATA_KILL_SWITCH", staleArtifacts.telemetryPayload);
    if (this.cachedConfig.TRADING_ENABLED) {
      this.state.waitUntil(this.cancelAllQuotes(tick.instrumentCode, "HARD_STALE_DROP"));
    }

    return staleArtifacts.ingestResult;
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
    const staleKillSwitch = buildStaleDataKillSwitchArtifacts({
      tick,
      metrics,
      maxLatencyMs: this.maxLatencyMs
    });

    await this.persistHotStorageSnapshot(
      this.latencyStorageWrites(staleKillSwitch.storageExtra),
      "STALE_DATA_KILL_SWITCH"
    );

    this.logPerformance(metrics);
    this.publish("STALE_DATA_KILL_SWITCH", staleKillSwitch.telemetryPayload);
    this.notifier.notify(staleKillSwitch.notification);
    if (this.cachedConfig.TRADING_ENABLED) {
      this.state.waitUntil(this.cancelAllQuotes(tick.instrumentCode, "STALE_DATA_KILL_SWITCH"));
    }
    this.publishTickTelemetry(tick, metrics, "STALE", hotPathStartedAt);
    this.maybeRecordAgentSnapshot(metrics.brainTimestamp);

    return staleKillSwitch.ingestResult;
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
      return rejectedBookDeltaIngestResult({ applied, metrics });
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

    return rejectedBookDeltaIngestResult({ applied, metrics });
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

    const artifacts = anomalyEmergencyPauseArtifacts({
      currentState: this.engineState,
      engineStateKey: ENGINE_STATE_KEY,
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
      tick,
      domSnapshot,
      metrics,
      internalOrderBookDepth: countBookLevels(this.bids, this.asks),
      observedAt: metrics.brainTimestamp
    });

    this.engineState = artifacts.state;

    await this.safeStoragePut(artifacts.storageWrites, "ANOMALY_EMERGENCY_PAUSE");

    this.triggerEmergencyPause(artifacts.event);
    this.publishTickTelemetry(tick, metrics, "FRESH", hotPathStartedAt);

    return artifacts.result;
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

  private dispatchInventoryHedgeIfNeeded(
    book: InternalOrderBook,
    inventory: InventoryState,
    observedAt: string,
    shadowReplay: boolean
  ): void {
    const hedge = buildInventoryHedgeIntent({
      book,
      inventory,
      observedAt,
      engineId: this.engineState.engineId,
      config: this.cachedConfig,
      lastHedgeAtMs: this.lastHedgeDispatchedAt.get(book.instrumentCode) ?? 0,
      fallbackNowMs: Date.now()
    });
    const hedgeIntent = hedge?.intent ?? null;

    if (hedge) {
      this.lastHedgeDispatchedAt.set(book.instrumentCode, hedge.dispatchedAtMs);
    }

    if (!hedgeIntent || shadowReplay) {
      return;
    }

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

  private async handleProfilerSignal(
    instrumentCode: string,
    profilerResult: ProfilerEvaluation,
    profilerLatencyMs: number,
    isProfilerQuoteHalt: boolean,
    shadowReplay: boolean,
    croupierHasQuote: boolean
  ): Promise<void> {
    if (!profilerResult.signal) {
      return;
    }

    this.publishProfilerAlert(profilerResult.signal, profilerResult.state);
    await this.acceptAgentSignal(profilerResult.signal, profilerLatencyMs);

    if (
      shouldCancelQuotesForProfilerSignal({
        signal: profilerResult.signal,
        profilerQuoteHalt: isProfilerQuoteHalt,
        shadowReplay,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        croupierHasQuote
      })
    ) {
      this.state.waitUntil(this.cancelAllQuotes(instrumentCode, "PROFILER_ALERT"));
    }
  }

  private maybeAutoResumeShadowMode(tick: MarketTick, shadowReplay: boolean): void {
    if (
      !shouldAutoResumeShadowMode({
        shadowReplay,
        shadowMode: isShadowMode(this.env),
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        mode: this.engineState.mode
      })
    ) {
      return;
    }

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

  private resolveTradingAvailability(
    tick: MarketTick,
    shadowReplay: boolean
  ): TickIngestResult | null {
    const availability = evaluateTickAvailability({
      tick,
      shadowReplay,
      shadowMode: isShadowMode(this.env),
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      mode: this.engineState.mode,
      configVersion: this.cachedConfig.version,
      killSwitchLogged: this.killSwitchLogged
    });

    if (availability.log) {
      this.logger.warn(
        availability.log.eventType,
        availability.log.message,
        availability.log.metadata
      );
    }
    this.killSwitchLogged = availability.nextKillSwitchLogged;

    return availability.result;
  }

  private scheduleAcceptedTickSnapshot(
    tick: MarketTick,
    book: InternalOrderBook,
    anomalyResult: AnomalyDetectionResult,
    profilerResult: ProfilerEvaluation
  ): void {
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
  }

  private journalAcceptedTick(
    tick: MarketTick,
    metrics: LatencyMetrics,
    bayesianTrace: BayesianUpdateTrace | null
  ): void {
    if (
      shouldPersistMarketTick(
        this.engineState.processedTicks,
        this.env.MARKET_TICK_JOURNAL_INTERVAL
      )
    ) {
      this.logger.recordMarketTick(tick);
    }

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
  }

  private applyQuoteSuppression(
    instrumentCode: string,
    croupierDecision: CroupierDecision,
    profilerResult: ProfilerEvaluation,
    executionPlans: ApprovedExecutionPlan[],
    observedAt: string,
    shadowReplay: boolean,
    ensembleAnomalyCircuitBreaker: boolean,
    ensembleRationale: string
  ): QuotePolicyResult {
    const profilerSignalType = profilerResult.signal?.featureVector.signalType;
    const quotePolicy = applyQuoteSuppressionRuntime({
      assetQuoteStates: this.engineState.assetQuoteStates,
      quoteState: this.engineState.quoteState,
      instrumentCode,
      quote: croupierDecision.quote,
      pullAllQuotes: croupierDecision.pullAllQuotes,
      instrumentSelected: isInstrumentSelectedByMoltworker(instrumentCode, this.macroBias),
      config: this.cachedConfig,
      envQuoteHibernateMs: this.env.QUOTE_HIBERNATE_MS,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      shadowReplay,
      executionPlans,
      profilerSignalType,
      profilerSuspendedUntil:
        typeof profilerResult.signal?.featureVector.suspendedUntil === "string"
          ? profilerResult.signal.featureVector.suspendedUntil
          : undefined,
      profilerQuoteHaltUntil: profilerResult.state.quoteHaltUntil,
      ensembleAnomalyCircuitBreaker,
      ensembleRationale,
      observedAt
    });

    applyQuoteSuppressionSideEffects(quotePolicy.sideEffects, {
      publishSuspend: (payload) => this.publish("SUSPEND_QUOTES", payload),
      cancelQuotes: (reason) => this.state.waitUntil(this.cancelAllQuotes(instrumentCode, reason))
    });

    return quoteSuppressionPolicyProjection(quotePolicy);
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
    const latency = prepareTickLatencyRuntime({
      tick,
      brainTimestamp: new Date().toISOString(),
      maxLatencyMs: this.maxLatencyMs,
      averageLatencyMs: this.engineState.averageLatency,
      sampleCount: this.engineState.latencySampleCount,
      location: this.engineState.location,
      shadowReplay,
      dwellirMaxLatencyMs: this.env.DWELLIR_MAX_LATENCY_MS,
      hlStaleAfterMs: this.env.HL_STALE_AFTER_MS,
      currentMaxLatencyMs: this.maxLatencyMs
    });

    if (latency.isHardStale) {
      return latency;
    }

    if (latency.shouldResetLatencyBaseline) {
      this.resetLatencyBaseline(latency.metrics.brainTimestamp, "FRESH_SAMPLE_AFTER_BACKLOG");
    }

    if (latency.shouldUpdateLatencyAverage) {
      this.updateLatencyAverage(latency.metrics.totalLatencyMs);
    }

    const metrics = latency.metrics;
    this.applyLocationLatency(metrics.totalLatencyMs, metrics.brainTimestamp);

    metrics.averageLatencyMs = this.engineState.averageLatency;
    metrics.sampleCount = this.engineState.latencySampleCount;
    metrics.latencyRiskMultiplier = this.engineState.location.latencyRiskMultiplier;
    metrics.positionSizeMultiplier = this.engineState.location.positionSizeMultiplier;

    this.latencyHistory = [...this.latencyHistory, metrics].slice(-PERFORMANCE_HISTORY_LIMIT);

    return latency;
  }

  private async resolveTickBook(
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    hotPathStartedAt: number
  ): Promise<TickBookResolution> {
    let orderBookUpdateMs = 0;

    if (isInformationalTick(tick)) {
      metrics.timeToBookMs = null;
      const book = currentBookForMarketTick(this.orderBook, tick);

      if (!book) {
        return {
          kind: "EARLY_RETURN",
          result: await this.handleInformationalBookNotReady(
            tick,
            metrics,
            wakeUpTimeMs,
            orderBookUpdateMs,
            hotPathStartedAt
          )
        };
      }

      return { kind: "BOOK", book, orderBookUpdateMs };
    }

    const orderBookStartedAt = highResolutionNow();
    const applied = await this.applyDelta(tickToDelta(tick), metrics.brainTimestamp);
    orderBookUpdateMs = roundLatency(highResolutionNow() - orderBookStartedAt);
    metrics.timeToBookMs = applied.timeToBookMs;

    if (!applied.accepted) {
      return {
        kind: "EARLY_RETURN",
        result: await this.handleRejectedBookDelta(
          tick,
          metrics,
          applied,
          wakeUpTimeMs,
          orderBookUpdateMs,
          hotPathStartedAt
        )
      };
    }

    const book = applied.book;
    if (!book) {
      throw new Error("ORDER_BOOK_APPLY_FAILED");
    }

    return { kind: "BOOK", book, orderBookUpdateMs };
  }

  private async preparePostBookTickContext(
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string,
    options: TickHandlingOptions
  ): Promise<PostBookTickContext> {
    await this.evaluateCascadeStrategy(tick, observedAt);

    const volatilitySnapshot = this.multiScaleVolatility.update(
      tick.instrumentCode,
      book.midPrice,
      observedAt
    );
    this.maybeCancelLaggingHypeQuotes(tick, volatilitySnapshot, observedAt, options);

    const shadowQueueState = this.processShadowQueueTick(tick, book, observedAt, options);
    const domSnapshot = this.getLiquidityWalls(tick.instrumentCode, observedAt, tick);

    return {
      volatilitySnapshot,
      shadowQueueState,
      domSnapshot
    };
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
    const profilerAgent = this.profilerRegistry.forInstrument(tick.instrumentCode);
    const profilerStartedAt = highResolutionNow();
    const profilerResult: ProfilerEvaluation = this.cachedConfig.PROFILER_ENABLED
      ? profilerAgent.processTick(
          tick,
          buildProfilerContext({
            engineId: this.engineState.engineId,
            observedAt,
            book,
            dom: domSnapshot,
            liquidationHeatmap: this.engineState.liquidationHeatmap,
            jumpDetected
          })
        )
      : disabledProfilerEvaluation(profilerAgent.snapshot(), observedAt);
    const profilerLatencyMs = this.cachedConfig.PROFILER_ENABLED
      ? roundLatency(highResolutionNow() - profilerStartedAt)
      : 0;

    this.observeExecutionProfile(metrics, {
      wakeUpTimeMs,
      orderBookUpdateMs,
      agentLogicMs: profilerLatencyMs,
      hotPathStartedAt,
      observedAt
    });

    return { profilerResult, profilerLatencyMs };
  }

  private evaluateOracleForTick(
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string
  ): { oracleResult: OracleTickResult; oracleLatencyMs: number } {
    const oracleStartedAt = highResolutionNow();
    const oracleResult = this.cachedConfig.ORACLE_ENABLED
      ? this.oracleAgent.processTick(
          buildOracleTickInput({
            tick,
            book,
            observedAt,
            config: this.cachedConfig
          })
        )
      : disabledOracleTickResult(this.engineState.oracle, observedAt);
    const oracleLatencyMs = this.cachedConfig.ORACLE_ENABLED
      ? roundLatency(highResolutionNow() - oracleStartedAt)
      : 0;

    return { oracleResult, oracleLatencyMs };
  }

  private buildTickDecisionContext(
    tick: MarketTick,
    oracle: EngineState["oracle"],
    profilerResult: ProfilerEvaluation,
    observedAt: string
  ): TickDecisionContext {
    const leadLag = this.engineState.leadLag;
    const inventory = this.calculateInventoryState(observedAt);
    const riskMetrics = this.updatePortfolioRisk(oracle, observedAt);
    const profilerStates = this.profilerRegistry.snapshot(
      tick.instrumentCode,
      profilerResult.state
    );
    const assetMatrix = this.calculateAssetMatrix(
      observedAt,
      tick.instrumentCode,
      oracle,
      profilerStates
    );
    const inventoryGuard = passiveInventoryGuardStateFromInventory(inventory, observedAt);
    const sentimentForDecision = this.cachedConfig.SENTIMENT_ENABLED
      ? this.engineState.sentiment
      : {
          ...defaultSentimentState(),
          updatedAt: observedAt
        };

    return {
      leadLag,
      inventory,
      riskMetrics,
      profilerStates,
      assetMatrix,
      inventoryGuard,
      sentimentForDecision
    };
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
    return evaluateCroupierRuntime({
      croupierEnabled: this.cachedConfig.CROUPIER_ENABLED,
      evaluator: this.croupierAgent,
      disabledDecision: disabledCroupierDecision(this.cachedConfig.MIN_EV_THRESHOLD),
      adverseSelectionModel: this.adverseSelectionModel,
      engineId: this.engineState.engineId,
      book,
      oracle,
      sentiment,
      toxicityScore: profilerResult.toxicityScore,
      inventory,
      leadLag,
      config: this.cachedConfig,
      env: this.env,
      executionCostBufferBps: this.engineState.slippage.executionCostBufferBps,
      multiScaleVolatility: volatilitySnapshot,
      fundingRateHourly: resolveCurrentFundingRate(this.engineState.fundingRates, book),
      liquidationHeatmap: this.engineState.liquidationHeatmap,
      profilerToxicityState: profilerResult.state.toxicityState,
      profilerPressureSide: profilerResult.state.pressureSide,
      profilerSpreadMultiplier: profilerResult.state.spreadMultiplier,
      profilerReservationShiftBps: profilerResult.state.reservationShiftBps,
      sentimentAlphaMode: this.cachedConfig.SENTIMENT_ALPHA_MODE,
      macroBias: this.macroBias,
      observedAt
    });
  }

  private commitAcceptedTickState(input: AcceptedTickStateCommitInput): void {
    this.engineState = stateAfterAcceptedTick(
      buildAcceptedTickStateTransition({
        currentState: this.engineState,
        config: this.cachedConfig,
        commit: input,
        internalOrderBookDepth: countBookLevels(this.bids, this.asks),
        maxLatencyMs: this.maxLatencyMs,
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
          )
      })
    );
  }

  private prepareAcceptedExecutionContext(
    input: AcceptedDecisionPipelineInput,
    profilerResult: ProfilerEvaluation,
    oracleState: EngineState["oracle"],
    croupierDecision: CroupierDecision,
    decisionContext: TickDecisionContext
  ): AcceptedExecutionContext {
    const ensemble = this.calculateEnsembleState(
      croupierDecision.intent,
      profilerResult.state,
      oracleState,
      decisionContext.sentimentForDecision,
      input.anomalyResult.status,
      input.metrics.brainTimestamp
    );
    const executionPlan = this.cachedConfig.PIT_BOSS_ENABLED
      ? this.prepareExecutionPlan(croupierDecision.intent, input.metrics.brainTimestamp, {
          stateOverride: {
            ...this.engineState,
            assetMatrix: decisionContext.assetMatrix,
            ensemble
          },
          kellyFractionOverride: this.cachedConfig.KELLY_FRACTION * ensemble.kellyMultiplier
        })
      : null;
    const executionPlans = [executionPlan].filter(
      (plan): plan is NonNullable<typeof executionPlan> => plan !== null
    );
    const quotePolicy = this.applyQuoteSuppression(
      input.tick.instrumentCode,
      croupierDecision,
      profilerResult,
      executionPlans,
      input.metrics.brainTimestamp,
      input.shadowReplay,
      ensemble.anomalyCircuitBreaker,
      ensemble.rationale
    );

    return {
      ensemble,
      executionPlan,
      executionPlans: quotePolicy.executionPlans,
      quotePolicy
    };
  }

  private async finalizeAcceptedTick(input: AcceptedTickSideEffectsInput): Promise<void> {
    this.scheduleAcceptedTickSnapshot(
      input.tick,
      input.book,
      input.anomalyResult,
      input.profilerResult
    );
    this.journalAcceptedTick(input.tick, input.metrics, input.oracleBayesianTrace);

    const finalization = buildAcceptedTickFinalizationArtifacts({
      sideEffects: input,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED
    });

    this.handleCroupierQuoteAction(input.tick.instrumentCode, finalization.croupierQuoteAction);
    this.dispatchExecutionPlans(input.executionPlans, input.shadowReplay);
    this.dispatchInventoryHedgeIfNeeded(
      input.book,
      input.inventory,
      input.metrics.brainTimestamp,
      input.shadowReplay
    );

    await this.handleProfilerSignal(
      input.tick.instrumentCode,
      input.profilerResult,
      input.profilerLatencyMs,
      input.isProfilerQuoteHalt,
      input.shadowReplay,
      Boolean(input.croupierDecision.quote)
    );

    this.publishTickTelemetry(
      input.tick,
      input.metrics,
      input.metrics.status,
      input.hotPathStartedAt
    );
    if (finalization.shouldPublishAmVpinTelemetry) {
      this.publishAmVpinTelemetry(
        input.profilerResult.state,
        input.tick.instrumentCode,
        input.metrics.brainTimestamp
      );
    }
    this.maybeRecordAgentSnapshot(input.metrics.brainTimestamp);
  }

  private async processAcceptedDecisionPipeline(
    input: AcceptedDecisionPipelineInput
  ): Promise<void> {
    const { profilerResult, profilerLatencyMs } = this.evaluateProfilerForTick(
      input.tick,
      input.book,
      input.domSnapshot,
      input.metrics.brainTimestamp,
      input.volatilitySnapshot?.jumpDetected ?? false,
      input.metrics,
      input.wakeUpTimeMs,
      input.orderBookUpdateMs,
      input.hotPathStartedAt
    );

    const { oracleResult, oracleLatencyMs } = this.evaluateOracleForTick(
      input.tick,
      input.book,
      input.metrics.brainTimestamp
    );
    const decisionContext = this.buildTickDecisionContext(
      input.tick,
      oracleResult.state,
      profilerResult,
      input.metrics.brainTimestamp
    );
    const { croupierDecision, croupierLatencyMs } = this.evaluateCroupierForTick(
      input.book,
      oracleResult.state,
      decisionContext.sentimentForDecision,
      profilerResult,
      decisionContext.inventory,
      decisionContext.leadLag,
      input.volatilitySnapshot,
      input.metrics.brainTimestamp
    );
    const executionContext = this.prepareAcceptedExecutionContext(
      input,
      profilerResult,
      oracleResult.state,
      croupierDecision,
      decisionContext
    );
    const lifecycle = buildAcceptedTickLifecycleArtifacts({
      pipeline: input,
      profilerResult,
      profilerLatencyMs,
      oracleResult,
      oracleLatencyMs,
      croupierDecision,
      croupierLatencyMs,
      decisionContext,
      executionContext
    });

    this.commitAcceptedTickState(lifecycle.commitInput);
    await this.finalizeAcceptedTick(lifecycle.sideEffectsInput);
  }

  private async handleTick(
    tick: MarketTick,
    wakeUpTimeMs: number | null,
    options: TickHandlingOptions = {}
  ): Promise<TickIngestResult> {
    const hotPathStartedAt = highResolutionNow();
    const shadowReplay = options.shadowReplay === true;
    const targetPreflight = evaluateTickTargetPreflight({ tick, shadowReplay });

    if (targetPreflight.rejection) {
      return targetPreflight.rejection;
    }

    this.maybeAutoResumeShadowMode(tick, shadowReplay);
    const tradingAvailability = this.resolveTradingAvailability(tick, shadowReplay);
    if (tradingAvailability) {
      return tradingAvailability;
    }

    this.lastTickTimestamp = tick.receivedAt;
    this.observeCascadeAbsorption(tick);

    const { metrics, streamId, hardStaleDropMs, isHardStale } = this.prepareTickLatency(
      tick,
      shadowReplay
    );

    if (isHardStale) {
      return this.handleHardStaleTickDrop(tick, metrics, streamId, hardStaleDropMs);
    }

    if (metrics.status === "STALE" && !shadowReplay && this.cachedConfig.TRADING_ENABLED) {
      return this.handleSoftStaleTick(tick, metrics, wakeUpTimeMs, hotPathStartedAt);
    }

    const fundingState = stateAfterFundingTick(this.engineState, tick, metrics.brainTimestamp);
    if (fundingState.changed) {
      this.engineState = fundingState.state;
    }

    const bookResolution = await this.resolveTickBook(
      tick,
      metrics,
      wakeUpTimeMs,
      hotPathStartedAt
    );
    if (bookResolution.kind === "EARLY_RETURN") {
      return bookResolution.result;
    }
    const { book, orderBookUpdateMs } = bookResolution;

    const { volatilitySnapshot, shadowQueueState, domSnapshot } =
      await this.preparePostBookTickContext(tick, book, metrics.brainTimestamp, options);
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

    await this.processAcceptedDecisionPipeline({
      tick,
      metrics,
      book,
      domSnapshot,
      volatilitySnapshot,
      shadowQueueState,
      anomalyResult,
      wakeUpTimeMs,
      orderBookUpdateMs,
      hotPathStartedAt,
      shadowReplay
    });

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
    const fillConfig = resolveShadowQueueGhostFillConfig({
      paperFillParticipationRate: this.env.PAPER_FILL_PARTICIPATION_RATE,
      paperFillAdverseBps: this.env.PAPER_FILL_ADVERSE_BPS,
      paperMakerFeeBps: this.env.PAPER_MAKER_FEE_BPS,
      exchangeFeeBps: this.env.EXCHANGE_FEE_BPS,
      maxPositionPct: this.env.MAX_POSITION_PCT,
      kellyFraction: this.env.KELLY_FRACTION
    });
    const ghostFillRecord = buildShadowQueueGhostFillRuntimeRecord({
      fill,
      tick,
      book,
      observedAt,
      slippage: this.engineState.slippage,
      fallbackAdverseBps: fillConfig.fallbackAdverseBps,
      participationRate: fillConfig.participationRate,
      makerFeeBps: fillConfig.makerFeeBps,
      cachedConfig: this.cachedConfig,
      envMaxPositionPct: fillConfig.envMaxPositionPct,
      envKellyFraction: fillConfig.envKellyFraction,
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

  private handleShadowQueueNoEdgeDecision(decision: ShadowQueueDecision): ShadowQueueDecision {
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

  private handleShadowQueueLatencyBreach(
    decision: ShadowQueueDecision,
    latencyBudgetMs: number
  ): ShadowQueueDecision | null {
    const latencyDecision = enforceShadowQueueDecisionLatency(decision, latencyBudgetMs);

    if (!latencyDecision.breached) {
      return null;
    }

    const suppressed = latencyDecision.decision;
    const telemetry = buildShadowQueueLatencyBreachTelemetry({
      originalDecision: decision,
      suppressedDecision: suppressed,
      latencyBudgetMs
    });
    this.logger.warn(telemetry.eventType, telemetry.message, telemetry.metadata);
    this.publish(telemetry.eventType, telemetry.payload, telemetry.correlationId);
    return suppressed;
  }

  private dispatchShadowQueueDecisionAction(
    action: ShadowQueueDecisionAction,
    book: InternalOrderBook
  ): void {
    this.publish(action.publish.type, action.publish.payload, action.publish.correlationId);

    if (action.cancelReason) {
      this.state.waitUntil(this.cancelAllQuotes(book.instrumentCode, action.cancelReason));
    }
    if (action.dispatchIntent) {
      this.state.waitUntil(this.dispatchExecution(action.dispatchIntent));
    }
  }

  private handleShadowQueueDecision(
    decision: ShadowQueueDecision,
    book: InternalOrderBook,
    observedAt: string
  ): ShadowQueueDecision {
    if (decision.action === "NO_EDGE" || decision.dispatchSide === null) {
      return this.handleShadowQueueNoEdgeDecision(decision);
    }

    const latencyBudget = this.engineState.shadowQueue.latencyBudgetMs;
    const suppressed = this.handleShadowQueueLatencyBreach(decision, latencyBudget);
    if (suppressed) {
      return suppressed;
    }

    const sizing = resolveShadowQueueSizingConfig({
      cachedConfig: this.cachedConfig,
      envMaxPositionPct: readPositiveNumber(this.env.MAX_POSITION_PCT, DEFAULT_MAX_POSITION_PCT),
      envKellyFraction: readPositiveNumber(this.env.KELLY_FRACTION, 0.5)
    });
    const artifacts = buildShadowQueueDecisionRuntimeArtifacts({
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
      positionSizeMultiplier: this.engineState.location.positionSizeMultiplier,
      quoteStateStatus: this.engineState.quoteState.status,
      cachedConfigVersion: this.cachedConfig.version,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED
    });
    this.logger.traceDecision(artifacts.trace);

    this.dispatchShadowQueueDecisionAction(artifacts.action, book);

    return artifacts.decision;
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
    const config = resolveCrossAssetHypeQuoteCancelConfig({
      leadThresholdBps: this.env.CROSS_ASSET_CANCEL_LEAD_BPS,
      cooldownMs: this.env.CROSS_ASSET_CANCEL_COOLDOWN_MS
    });
    const last = this.crossAssetCancelLogAt.get("hype-usd") ?? 0;
    const decision = evaluateCrossAssetHypeQuoteCancel({
      shadowReplay: options.shadowReplay,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      tickInstrumentCode: tick.instrumentCode,
      volatility,
      observedAt,
      leadThresholdBps: config.leadThresholdBps,
      cooldownMs: config.cooldownMs,
      lastCancelAtMs: last,
      fallbackNowMs: Date.now()
    });

    if (!decision.shouldCancel) {
      return;
    }

    this.crossAssetCancelLogAt.set("hype-usd", decision.nowMs);
    const artifacts = buildCrossAssetHypeCancelArtifacts({
      decision,
      volatility,
      leadThresholdBps: config.leadThresholdBps,
      observedAt
    });
    this.logger.warn(
      "CROSS_ASSET_HYPE_CANCEL",
      "BTC lead move invalidated HYPE resting quotes",
      artifacts.logMetadata
    );
    this.publish("SUSPEND_QUOTES", artifacts.telemetry);
    this.state.waitUntil(this.cancelAllQuotes("hype-usd", "BTC_LEAD_MOVE"));
  }

  private shouldSkipQuoteDispatch(
    quote: NonNullable<EngineState["quoteState"]["lastQuote"]>
  ): boolean {
    if (!this.env.EXECUTIONER || !this.cachedConfig.TRADING_ENABLED) {
      return true;
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
      return true;
    }

    return (
      isQuoteSuspendedAt(
        quoteStateForInstrumentState(
          this.engineState.assetQuoteStates,
          quote.instrumentCode,
          this.engineState.quoteState
        ),
        quote.createdAt
      ) || this.shouldThrottleQuoteDispatch(quote)
    );
  }

  private async dispatchQuote(
    quote: NonNullable<EngineState["quoteState"]["lastQuote"]>
  ): Promise<void> {
    if (this.shouldSkipQuoteDispatch(quote)) {
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

    const book = findBestOrderBookForAsset(this.orderBook, quote.instrumentCode);
    const logKey = quote.instrumentCode;
    const logAt = this.quoteRefreshThrottleLogAt.get(logKey) ?? 0;
    const nowMs = Date.now();
    const refresh = buildQuoteRefreshRuntimeDecision({
      previousQuote: last,
      quote,
      book: book ?? null,
      nowMs,
      lastLogAtMs: logAt,
      logThrottleMs: HOT_PATH_LOG_THROTTLE_MS,
      minIntervalMsValue: this.env.QUOTE_REFRESH_MIN_INTERVAL_MS,
      minPriceTicksValue: this.env.QUOTE_REFRESH_MIN_PRICE_TICKS,
      adviseRefresh: (input) => this.queuePositionModel.adviseRefresh(input)
    });
    const throttle = refresh.throttle;

    if (throttle.shouldLog) {
      this.quoteRefreshThrottleLogAt.set(logKey, throttle.nextLogAtMs);
      this.logger.info(
        "QUOTE_REFRESH_THROTTLED",
        "Skipped quote refresh inside minimum cadence window",
        quoteRefreshThrottleLogMetadata({
          quote,
          throttle,
          minIntervalMs: refresh.minIntervalMs,
          minPriceTicks: refresh.minPriceTicks
        })
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
    const dispatch = buildExecutionDispatchRuntimeDecision({
      intent,
      hasExecutioner: Boolean(executioner),
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      hedgeEnabled: this.cachedConfig.HEDGE_ENABLED,
      inventoryHedge,
      instrumentSelected: isInstrumentSelectedByMoltworker(intent.instrumentCode, this.macroBias),
      selectedInstruments: [...selectedMoltworkerInstruments(this.macroBias)]
    });
    if (dispatch.blockLog) {
      emitExecutionDispatchBlockLog(this.logger, dispatch.blockLog);
      return;
    }

    if (!dispatch.gate.allowed || !executioner) {
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
    const executionUpdate = buildExecutionReportRuntimeUpdate({
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
        ),
      calculateInventory: (observedAt, openPositions) =>
        this.calculateInventoryState(observedAt, openPositions)
    });
    this.adverseSelectionModel.observeExecutionReport(
      report,
      executionUpdate.accounting.order,
      executionUpdate.adverseSelectionMarkPrice,
      this.engineState.oracle.regime
    );

    this.logger.recordExecutionQuality(executionUpdate.executionQuality);

    this.engineState = executionUpdate.nextState;

    await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "EXECUTION_REPORT");
    this.logger.recordExecution(executionUpdate.accounting.tradeExecution);
    this.publish(
      "TRADE_EXECUTION_UPDATE",
      executionUpdate.accounting.tradeExecution as unknown as Record<string, unknown>,
      executionUpdate.accounting.tradeExecution.tradeId
    );
  }

  private recordJanitorDustCloseSkips(
    instrumentCodes: readonly string[],
    observedAt: string
  ): string[] {
    const dustCloseIntents: string[] = [];
    for (const instrumentCode of instrumentCodes) {
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

    return dustCloseIntents;
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

    for (const request of reconciliation.cancellationRequests) {
      await this.cancelOrder(request.orderId, request.reason, request.instrumentCode);
    }

    const dustCloseIntents = this.recordJanitorDustCloseSkips(baseReport.dustPositions, observedAt);

    const pruneReport = await this.pruneOperationalLogs();
    const artifacts = buildJanitorRunArtifacts({
      source,
      state: this.engineState,
      baseReport,
      reconciliation,
      dustCloseIntents,
      pruneReport,
      observedAt
    });

    if (artifacts.warningMetadata) {
      this.logger.warn(
        "JANITOR_CLEANUP_REQUIRED",
        "Janitor found state hygiene work",
        artifacts.warningMetadata
      );
    }

    this.engineState = artifacts.state;
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

  private prepareShadowReplayState(
    initialShadowBankroll: number,
    startedAt: string,
    replayId: string
  ): void {
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
  }

  private async recordCompletedHistoricalReplay(
    input: HistoricalReplayCompletionInput
  ): Promise<ReplayResult> {
    const completedAt = new Date().toISOString();
    const replayBuild = buildCompletedReplayArtifacts({
      replayId: input.replayId,
      replayOptions: input.replayOptions,
      ticksLength: input.ticksLength,
      ticksReplayed: input.replayLoop.ticksReplayed,
      initialShadowBankroll: input.initialShadowBankroll,
      historicalTradeCount: input.historicalTradeCount,
      generatedIntentCount: input.replayLoop.generatedIntentCount,
      speedMultiplier: input.speedMultiplier,
      modeledTrades: input.replayLoop.modeledTrades,
      shadowTrades: input.shadowTrades,
      sentiment: this.engineState.sentiment,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      startedAt: input.startedAt,
      completedAt
    });
    const result = replayBuild.result;

    this.logger.warn(
      "REPLAY_COMPLETED",
      "Historical shadow replay completed",
      replayBuild.logMetadata
    );
    await this.replayJournal.recordBacktestRun(
      result,
      input.replayOptions,
      input.dateFrom,
      input.dateTo
    );
    await this.replayJournal.writeStatus(replayBuild.status);

    return result;
  }

  private async writeHistoricalReplayRunningStatus(
    input: HistoricalReplayStatusInput
  ): Promise<void> {
    await this.replayJournal.writeStatus(
      buildReplayStatus({
        replayId: input.replayId,
        status: "RUNNING",
        ticksTotal: input.ticksTotal,
        ticksProcessed: 0,
        speedMultiplier: input.speedMultiplier,
        shadowBankroll: input.shadowBankroll,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        scenario: input.scenario,
        startedAt: input.startedAt,
        updatedAt: input.updatedAt
      })
    );
  }

  private async loadScenarioReplayTicks(
    limit: number,
    dateFrom: string | null,
    dateTo: string | null,
    scenario: ReplayScenario
  ): Promise<LoadedReplayTicks> {
    const sourceTicks = await this.replayJournal.loadTicks(limit, dateFrom, dateTo);
    const ticks = sourceTicks.map((tick, index) =>
      applyReplayScenarioToTick(tick, scenario, index, sourceTicks.length)
    );

    return { sourceTicks, ticks };
  }

  private async loadReplayShadowTrades(ticks: MarketTick[]): Promise<LoadedReplayShadowTrades> {
    const historicalTrades =
      ticks.length > 0
        ? await this.replayJournal.loadTrades(ticks[0].receivedAt, ticks.at(-1)!.receivedAt)
        : [];
    const shadowTrades = markHistoricalReplayTrades(historicalTrades, ticks);

    return { historicalTrades, shadowTrades };
  }

  private async runShadowReplayWithRestore(
    input: ShadowReplayWithRestoreInput
  ): Promise<ShadowReplayLoopResult> {
    let replayLoop: ShadowReplayLoopResult | null = null;
    try {
      replayLoop = await runShadowReplayLoop({
        replayId: input.replayId,
        ticks: input.ticks,
        replayOptions: input.replayOptions,
        speedMultiplier: input.speedMultiplier,
        initialShadowBankroll: input.initialShadowBankroll,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        startedAt: input.startedAt,
        enqueueShadowReplayTick: (tick) => this.enqueueTick(tick, null, { shadowReplay: true }),
        lastTradeIntent: () => this.engineState.lastTradeIntent,
        oracleRegime: () => this.engineState.oracle.regime,
        writeStatus: (status) => this.replayJournal.writeStatus(status)
      });
    } finally {
      await this.restoreReplaySnapshot(input.liveSnapshot);
    }

    if (!replayLoop) {
      throw new Error("REPLAY_LOOP_DID_NOT_COMPLETE");
    }

    return replayLoop;
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
    await this.writeHistoricalReplayRunningStatus({
      replayId,
      ticksTotal: 0,
      shadowBankroll,
      speedMultiplier,
      dateFrom,
      dateTo,
      scenario: replayOptions.scenario,
      startedAt,
      updatedAt: startedAt
    });
    const liveSnapshot = this.captureReplaySnapshot();
    const { ticks } = await this.loadScenarioReplayTicks(
      limit,
      dateFrom,
      dateTo,
      replayOptions.scenario
    );
    const initialShadowBankroll = resolveInitialShadowBankroll({
      requestedShadowBankroll: shadowBankroll,
      liveEquity: this.engineState.bankroll.equity,
      liveCash: this.engineState.bankroll.cash,
      fallbackBankroll: DEFAULT_PAPER_BANKROLL_USD
    });
    await this.writeHistoricalReplayRunningStatus({
      replayId,
      ticksTotal: ticks.length,
      shadowBankroll: initialShadowBankroll,
      speedMultiplier,
      dateFrom,
      dateTo,
      scenario: replayOptions.scenario,
      startedAt,
      updatedAt: new Date().toISOString()
    });
    const { historicalTrades, shadowTrades } = await this.loadReplayShadowTrades(ticks);

    this.prepareShadowReplayState(initialShadowBankroll, startedAt, replayId);

    const replayLoop = await this.runShadowReplayWithRestore({
      replayId,
      ticks,
      replayOptions,
      speedMultiplier,
      initialShadowBankroll,
      dateFrom,
      dateTo,
      startedAt,
      liveSnapshot
    });

    return this.recordCompletedHistoricalReplay({
      replayId,
      replayLoop,
      initialShadowBankroll,
      historicalTradeCount: historicalTrades.length,
      shadowTrades,
      speedMultiplier,
      replayOptions,
      dateFrom,
      dateTo,
      startedAt,
      ticksLength: ticks.length
    });
  }

  private captureReplaySnapshot(): EngineReplaySnapshot {
    return captureEngineReplaySnapshot({
      engineState: this.engineState,
      orderBooks: this.orderBook.values(),
      latencyHistory: this.latencyHistory,
      processingLatencySamples: this.processingLatencySamples,
      domWallHistory: this.domWallHistory,
      leadLagSamples: this.leadLagSamples.entries(),
      cachedConfig: this.cachedConfig,
      maxLatencyMs: this.maxLatencyMs,
      lastTickTimestamp: this.lastTickTimestamp,
      profilerState: this.profilerAgent.snapshot(),
      profilerStates: [...this.profilerRegistry.entries()].map(([instrumentCode, agent]) => [
        instrumentCode,
        agent.snapshot()
      ]),
      anomalyState: this.anomalyDetector.snapshot(),
      oracleState: this.oracleAgent.snapshot(),
      sentimentState: this.sentimentAgent.snapshot(),
      rateLimits: this.rateLimiter.exportState(),
      signals: this.signals,
      latestAgentSignals: this.latestAgentSignals.entries()
    });
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

  private triggerEmergencyPause(event: AnomalyEmergencyPauseTelemetry): void {
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

  private applyRefreshedConfigState(nextConfig: GlobalRiskConfig, observedAt: string): void {
    const quoteRefresh = configRefreshQuoteState({
      assetQuoteStates: this.engineState.assetQuoteStates,
      quoteState: this.engineState.quoteState,
      nextConfig,
      macroBias: this.macroBias,
      observedAt
    });
    const profilerStates = this.profilerRegistry.snapshot();
    const refreshedLocation = resolveEngineLocation(
      configRefreshTopologyFromLocation(this.engineState.location, observedAt, crypto.randomUUID()),
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
      nextAssetQuoteStates: quoteRefresh.assetQuoteStates,
      nextQuoteState: quoteRefresh.quoteState,
      assetMatrix: this.calculateAssetMatrix(
        observedAt,
        this.engineState.microstructure.instrumentCode ?? undefined,
        this.engineState.oracle,
        profilerStates,
        quoteRefresh.assetQuoteStates
      ),
      profilerStates,
      refreshedLocation,
      observedAt
    });
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
    this.applyRefreshedConfigState(nextConfig, now);

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
