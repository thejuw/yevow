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
import {
  AnomalyDetector,
  ANOMALY_DETECTOR_STORAGE_KEY,
  type AnomalyDetectionResult
} from "../../agents/AnomalyDetector";
import { CroupierAgent, type CroupierDecision } from "../../agents/CroupierAgent";
import { AdverseSelectionModel } from "../AdverseSelectionModel";
import {
  applyTopologyObservationSideEffects,
  defaultEngineLocation,
  stateAfterLocationLatency,
  stateAfterTopologyObservation
} from "./helpers/PlacementResolver";
import { applyTopologyWarmUpRuntime } from "./helpers/TopologyWarmUpRuntime";
import { priceKey, SortedBookSide } from "./book/SortedBookSide";
import { countBookLevels, microstructureFromBook } from "./book/BookReconstruction";
import {
  calculateOrderBookPriceDiscovery,
  currentMarkPriceForInstrument,
  currentBookForMarketTick,
  currentOrderBookSnapshot,
  findBestAssetBook as findBestOrderBookForAsset,
  nullableMarkPriceForInstrument
} from "./book/BookViews";
import {
  applyBookDeltaFlow,
  applyBookSnapshotFlow,
  applyInformationalBookNotReadyFlow,
  applyRejectedBookDeltaFlow,
  bookDesyncStorageExtra,
  markBookSyncDesynced,
  stateAfterDesyncedBook
} from "./book/BookRuntimeState";
import {
  applyOrderBookResetConnectionIds,
  applyOrderBookResetFlow
} from "./book/OrderBookResetRuntime";
import { resolveTickBookFlow } from "./book/TickBookResolutionRuntime";
import { buildDomAnalysisSnapshot, currentDomHeatmapSnapshot } from "./book/DomAnalyzer";
import {
  applyShadowQueueDecisionFlow,
  buildShadowQueueGhostFillRuntimeRecord,
  emitShadowQueueGhostFillSideEffects,
  processShadowQueueTickRuntime,
  resolveShadowQueueGhostFillConfig,
  resolveShadowQueueNoEdgeLogInterval,
  resolveShadowQueueSizingConfig
} from "./shadow/ShadowQueueRuntime";
import { applyAnomalyEmergencyPauseFlow } from "./anomaly/AnomalyRuntime";
import { emitTradingAnomalyEmergencyPause } from "./anomaly/TradingAnomalyEmergencyRuntime";
import {
  applyCrossAssetHypeQuoteCancelFlow,
  updateLeadLagMetrics as updateLeadLagRuntimeMetrics
} from "./leadlag/LeadLagRuntime";
import {
  applyInventoryHedgeSideEffects,
  buildInventoryHedgeIntent,
  calculateInventoryState as calculateInventoryRuntimeState,
  referencePriceForBaseAsset as resolveBaseAssetReferencePrice,
  resolveInventoryStateConfig
} from "./inventory/InventoryRuntime";
import {
  applyPortfolioRiskFlow,
  resolveMaxPositionPct,
  resolveVarConfidenceZ
} from "./risk/PortfolioRiskRuntime";
import { calculateEnsembleState as calculateRuntimeEnsembleState } from "./ensemble/EnsembleRuntime";
import {
  currentFundingRate as resolveCurrentFundingRate,
  stateAfterFundingTick
} from "./funding/FundingRuntime";
import {
  nextQuoteStateForInstrument as nextRuntimeQuoteStateForInstrument,
  resolveQuoteHibernateMs,
  strategyQuoteDisabledReason as runtimeStrategyQuoteDisabledReason
} from "./quotes/QuoteLifecycleRuntime";
import { applyResumeExpiredQuoteStatesSideEffects } from "./quotes/QuoteResumeRuntime";
import {
  applyQuoteSuppressionRuntime,
  applyQuoteSuppressionSideEffects,
  quoteSuppressionPolicyProjection
} from "./quotes/QuoteSuppressionRuntime";
import { dispatchTradingQuote } from "./quotes/TradingQuoteDispatchRuntime";
import {
  applyQuoteRefreshThrottleSideEffects,
  buildQuoteRefreshRuntimeDecision,
  dispatchedQuoteSnapshot
} from "./quotes/QuoteRefreshRuntime";
import {
  dispatchCroupierQuoteActionSideEffects,
  type CroupierQuoteAction
} from "./quotes/QuoteActionRuntime";
import {
  applyQuoteCancelAllSideEffects,
  dispatchQuoteCancelAll
} from "./quotes/QuoteCancelRuntime";
import {
  prepareApprovedExecutionPlan,
  type ApprovedExecutionPlan
} from "./execution/ExecutionPlanRuntime";
import { dispatchExecutionPlanSideEffects } from "./execution/ExecutionPlanDispatchRuntime";
import { dispatchTradingExecutionIntent } from "./execution/TradingExecutionDispatchRuntime";
import { applyExecutionReportFlow } from "./execution/ExecutionReportRuntime";
import {
  evaluateCroupierRuntime,
  evaluateOracleRuntime,
  evaluateProfilerRuntime,
  type OracleTickResult
} from "./agents/AgentEvaluationRuntime";
import { applyIntentPaperExecutionBudgetSideEffects } from "./execution/PaperExecutionBudgetRuntime";
import {
  applyExecutionQueueDrainSideEffects,
  applyExecutionQueueEnqueueSideEffects,
  type QueuedExecutionIntent
} from "./execution/ExecutionQueueRuntime";
import { calculateAssetMatrix as calculateRuntimeAssetMatrix } from "./state/AssetMatrixRuntime";
import {
  buildPerformanceMetricsText,
  type ExecutionTraceInput
} from "./performance/LatencyRuntime";
import { observeTradingExecutionProfile } from "./performance/TradingExecutionProfileRuntime";
import {
  applyHardStaleTickDropFlow,
  applyNativeHyperliquidLatencyPullSideEffects,
  applySoftStaleTickFlow,
  latencySnapshotStorageWrites,
  nativeHyperliquidLatencyPullArtifacts
} from "./performance/StaleLatencyGuardRuntime";
import {
  applyLatencyBaselineResetSideEffects,
  latencyBaselineResetArtifacts
} from "./performance/LatencyBaselineRuntime";
import { logTradingPerformanceSpike } from "./performance/TradingPerformanceSpikeRuntime";
import { nextLatencyAverage } from "./performance/LatencyTickRuntime";
import { prepareTradingTickLatency } from "./performance/TradingTickLatencyRuntime";
import { applyCancelJanitorOrderSideEffects, cancelJanitorOrder } from "./janitor/JanitorRuntime";
import { runTradingJanitorMaintenance } from "./janitor/TradingJanitorRuntime";
import {
  currentCascadeActiveSnapshot as buildCurrentCascadeActiveSnapshot,
  currentCascadeHeatSnapshot as buildCurrentCascadeHeatSnapshot,
  currentCascadePositionSnapshot as buildCurrentCascadePositionSnapshot,
  currentCascadeSignalSnapshot as buildCurrentCascadeSignalSnapshot
} from "./cascade/CascadeSnapshots";
import {
  buildCascadeDetectedArtifacts,
  liquidationEventProcessingResult,
  persistCascadeLiquidationEventsSafely,
  processLiquidationIngestRuntime,
  recordCascadeLiquidationDetections,
  resolveLiquidationEventContext
} from "./cascade/CascadeLiquidationRuntime";
import {
  buildCascadeEntryTradeIntent,
  buildCascadeExitTradeIntent
} from "./cascade/CascadeTradeIntents";
import {
  applyCascadeAbsorptionConfirmedSideEffects,
  buildCascadeAbsorptionObservation,
  nextCascadeCvd
} from "./cascade/CascadeAbsorptionRuntime";
import {
  applyAdminConfigUpdateFlow,
  applyConfigRefreshFlow,
  applyConfigRefreshSideEffects,
  applyRuntimeConfigUpdateSideEffects
} from "./config/ConfigRuntime";
import {
  absorptionAnalyzerConfigFromRuntime,
  cascadeAssetProfileFromConfig,
  cascadeDetectorConfigFromRuntime,
  cascadeRecoverySignalConfig as buildCascadeRecoverySignalConfig,
  resolveCascadeAtr1h as resolveCascadeAtr1hFromConfig
} from "./cascade/CascadeConfigRuntime";
import { ensureCascadePaperModeArmedRuntime } from "./cascade/CascadePaperModeRuntime";
import {
  applyCascadePositionUpdateSideEffects,
  applyCascadeSignalRejectionSideEffects,
  evaluateCascadeStrategyFlow,
  processCascadeClosedCandleSignals,
  processAcceptedCascadeSignalFlow
} from "./cascade/CascadeStrategyRuntime";
import { OrderBookReconstructor, type OrderBookStores } from "./book/OrderBookReconstructor";
import {
  buildOrderBookStores,
  createTradingOrderBookReconstructor
} from "./book/OrderBookReconstructorFactory";
import type { AppliedBookUpdate, BookDeltaWithTicker, BookSyncState } from "./book/BookTypes";
import {
  applyAcceptedHyperliquidL2BookSideEffects,
  applyHyperliquidL2BookDesyncSideEffects,
  applyStaleHyperliquidL2BookSideEffects,
  dispatchHyperliquidL2BookDecision,
  evaluateHyperliquidL2BookRuntime,
  type HyperliquidL2BookHotPathDecision
} from "./ingest/HyperliquidL2BookIngest";
import {
  applyHyperliquidIngestConnectionSideEffects,
  dispatchHyperliquidRawMessageRoute,
  handleHyperliquidRawBatch,
  processHyperliquidAssetContext,
  processHyperliquidTradeBatch,
  registerHyperliquidIngestConnection,
  type HyperliquidRawIngestPayload
} from "./ingest/HyperliquidRawRouting";
import { applyGrpcFatalDropSideEffects, grpcFatalDropArtifacts } from "./ingest/GrpcDropRuntime";
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
  agentSignalStorageKey,
  applyAcceptedAgentSignalSideEffects
} from "./telemetry/AgentSignalRuntime";
import { maybePublishTradingAgentSnapshot } from "./telemetry/TradingAgentSnapshotRuntime";
import {
  buildCascadeOperationalAlertTelemetry,
  emitCascadeOperationalAlertSideEffects,
  recordCascadeUiSignalSideEffects
} from "./telemetry/CascadeSignalTelemetryRuntime";
import { applyProfilerSignalSideEffects } from "./telemetry/ProfilerTelemetryRuntime";
import {
  publishTradingAmVpinTelemetry,
  publishTradingProfilerAlert
} from "./telemetry/TradingProfilerTelemetryRuntime";
import { publishTradingTickTelemetry } from "./telemetry/TradingTickTelemetryRuntime";
import { type ReplayOptions, type ReplayScenario } from "./routes/ReplayAdminRoutes";
import {
  loadReplayShadowTradesFromJournal,
  loadScenarioReplayTicksFromJournal
} from "./replay/ReplayDataRuntime";
import { type ReplayJournal } from "./replay/ReplayJournal";
import { runShadowReplayLoop, type ShadowReplayLoopResult } from "./replay/ReplayLoopRuntime";
import { applyShadowReplayPreparation } from "./replay/ReplayPreparationRuntime";
import {
  recordCompletedReplaySideEffects,
  writeReplayRunningStatusSideEffect
} from "./replay/ReplayResultRuntime";
import {
  runHistoricalReplayRuntime,
  runShadowReplayWithRestoreRuntime
} from "./replay/ReplayRunRuntime";
import {
  captureEngineReplaySnapshot,
  restoreReplaySnapshotSideEffects,
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
import { buildHydratedEngineState, hydrateEngineBootCollections } from "./state/EngineBootState";
import {
  createTradingEngineBootServices,
  tradingEngineLoggerRuntimeContext
} from "./state/EngineBootServices";
import { stateAfterAcceptedTick } from "./state/TickStateRuntime";
import { maybeResumeTradingShadowMode } from "./state/TradingShadowModeAutoResumeRuntime";
import { resolveTradingTickAvailability } from "./state/TradingAvailabilityRuntime";
import {
  recordTradingAcceptedTickJournal,
  scheduleTradingAcceptedTickSnapshot
} from "./state/TradingTickPersistenceRuntime";
import { applyAdminRecoveryFlow, resolveAdminRecoveryPaperBankroll } from "./state/RecoveryRuntime";
import {
  applyHotStorageSnapshotSideEffects,
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
import {
  HeatmapAgent,
  LIQUIDATION_HEATMAP_STORAGE_KEY,
  defaultLiquidationHeatmapState
} from "../../agents/HeatmapAgent";
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
import { CascadeRecoverySignalEngine } from "../../strategy/cascade/CascadeRecoverySignal";
import { calculateAtr } from "../../strategy/cascade/indicators/ATR";
import { cumulativeVolumeDelta } from "../../strategy/cascade/indicators/CumulativeVolumeDelta";
import { HyperliquidLiquidationStream } from "../../strategy/cascade/LiquidationStream";
import { HeatManager } from "../../strategy/cascade/HeatManager";
import type { NewsCalendar } from "../../strategy/cascade/NewsCalendar";
import type { CascadeAlertEventType } from "../../strategy/cascade/OperationalSafeguards";
import { PositionManager } from "../../strategy/cascade/PositionManager";
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
  CascadePositionIntent,
  CascadeRecoverySignal,
  CascadeRecoverySignalRejection,
  CascadeRecoverySignalResult,
  LiquidationEvent
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
  hydrateLegacyLevel,
  levelsToBookSide,
  resolveTickSize,
  resolveDomBinSize,
  parseTickSizeMap,
  parsePositiveNumberMap
} from "./book/BookRuntimeHelpers";
import {
  isCascadeInstrumentEnabledForConfig,
  latestAbsorptionForInstrument,
  latestCascadeAtForInstrument,
  recentSwingLow,
  recentSwingHigh
} from "./cascade/CascadeSelectionRuntime";
import {
  applyCascadeManualCloseSideEffects,
  buildCascadeManualCloseRuntimeResult
} from "./cascade/CascadeManualCloseRuntime";
import {
  normalizeNativeCoin,
  normalizeNativeInstrumentCode,
  splitNativeInstrument,
  baseAssetFromInstrument
} from "./helpers/NativeMarketIdentityRuntime";
import { nativeBookSideLevels } from "./helpers/NativeHyperliquidRuntime";
import {
  epochMillis,
  nativeHashSequence,
  nativeNumber,
  nativeSide
} from "./helpers/NativeValueRuntime";
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
  clampInteger,
  assertAgentSignal,
  finiteNumber,
  isPlainObject,
  readHyperliquidRawIngestPayload,
  readJsonOrNull,
  json
} from "./helpers/RuntimeParsing";
import { resolveGhostBookConfig } from "./shadow/GhostBookConfigRuntime";
import {
  defaultQuoteState,
  selectedMoltworkerInstruments,
  isInstrumentSelectedByMoltworker,
  normalizeAssetMatrix,
  filterTargetOrderBooks,
  defaultAssetMatrix,
  quoteStateForInstrumentState,
  suspendAssetQuoteStates,
  quotePriceMovedTicks
} from "./state/AssetStateRuntime";
import {
  defaultEnsembleState,
  disabledCroupierDecision,
  touchAgentHealth
} from "./state/AgentStateDefaults";
import {
  defaultLeadLagMetrics,
  defaultMicrostructure,
  defaultPriceDiscovery
} from "./state/MarketStateDefaults";
import {
  defaultEngineState,
  parseDeltaNormalizationWeights,
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
import { isTradeTick } from "./state/TickClassification";
import { applyAcceptedDecisionPipelineFlow } from "./pipelines/AcceptedTickLifecycleRuntime";
import { buildTickDecisionContextFlow } from "./pipelines/TickDecisionContextRuntime";
import { buildAcceptedTickStateTransition } from "./pipelines/AcceptedTickStateTransitionRuntime";
import { finalizeAcceptedTickFlow } from "./pipelines/AcceptedTickFinalizationRuntime";
import { prepareAcceptedExecutionContextFlow } from "./pipelines/AcceptedExecutionContextRuntime";
import { preparePostBookTickRuntime } from "./pipelines/PostBookTickRuntime";
import { handleTickRuntime } from "./pipelines/TickHandlingRuntime";
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
    const maxPositionPct = resolveMaxPositionPct(
      this.cachedConfig,
      this.env.MAX_POSITION_PCT,
      DEFAULT_MAX_POSITION_PCT
    );

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
    return dispatchHyperliquidRawMessageRoute(raw, payload, wakeUpTimeMs, {
      handleL2Book: (routeRaw, routePayload, wakeUp) =>
        this.handleHyperliquidL2Book(routeRaw, routePayload, wakeUp),
      handleTrades: (routeRaw, routePayload, wakeUp) =>
        this.handleHyperliquidTrades(routeRaw, routePayload, wakeUp),
      handleAssetContext: (routeRaw, routePayload, wakeUp) =>
        this.handleHyperliquidAssetContext(routeRaw, routePayload, wakeUp),
      handleLiquidationEvents: (routeRaw, routePayload) =>
        this.handleHyperliquidLiquidationEvents(routeRaw, routePayload)
    });
  }

  private async handleStaleHyperliquidL2Book(
    l2Decision: Extract<HyperliquidL2BookHotPathDecision, { kind: "STALE" }>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null,
    hotPathStartedAt: number
  ): Promise<TickIngestResult> {
    return applyStaleHyperliquidL2BookSideEffects(
      {
        decision: l2Decision,
        payload,
        wakeUpTimeMs,
        hotPathStartedAt,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED
      },
      {
        applySnapshot: (snapshot) =>
          this.applySnapshot(snapshot, { telemetry: false, persist: false }),
        handleCrossedBookSnapshot: (book, sequence, totalLatencyMs, observedAt) =>
          this.orderBookReconstructor.handleCrossedBookSnapshot(
            book,
            sequence,
            totalLatencyMs,
            observedAt
          ),
        markLatencyDesyncedBook: (marketKey, book, observedAt) => {
          const syncState = this.bookSync.get(marketKey);
          markBookSyncDesynced({
            syncState,
            reason: "NATIVE_HL_LATENCY",
            observedAt
          });
          const staleBook = stateAfterDesyncedBook({
            currentState: this.engineState,
            book,
            reason: "NATIVE_HL_LATENCY"
          });
          this.orderBook.set(marketKey, staleBook.book);
          this.engineState = staleBook.state;
        },
        quoteStateStalePull: (instrumentCode, sequence, metrics, observedAt) =>
          this.quoteStateStalePull(instrumentCode, sequence, metrics, observedAt),
        observeExecutionProfile: (metrics, trace) => this.observeExecutionProfile(metrics, trace),
        schedule: (work) => this.state.waitUntil(work),
        cancelAllQuotes: (instrumentCode, reason) => this.cancelAllQuotes(instrumentCode, reason),
        publishTickTelemetry: (tick, metrics, status, telemetryStartedAt) =>
          this.publishTickTelemetry(tick, metrics, status, telemetryStartedAt)
      }
    );
  }

  private async handleAcceptedHyperliquidL2Book(
    l2Decision: Extract<HyperliquidL2BookHotPathDecision, { kind: "ACCEPTED" }>,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult> {
    return applyAcceptedHyperliquidL2BookSideEffects(
      {
        decision: l2Decision,
        payload,
        wakeUpTimeMs
      },
      {
        applySnapshot: (snapshot) => this.applySnapshot(snapshot, { persist: false }),
        handleCrossedBookSnapshot: (book, sequence, totalLatencyMs, observedAt) =>
          this.orderBookReconstructor.handleCrossedBookSnapshot(
            book,
            sequence,
            totalLatencyMs,
            observedAt
          ),
        handleTick: (tick, wakeUp) => this.handleTick(tick, wakeUp)
      }
    );
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
    return dispatchHyperliquidL2BookDecision(l2Decision, {
      handleDuplicateOrOutOfOrder: (decision) => decision.result,
      handleDesync: (decision) =>
        applyHyperliquidL2BookDesyncSideEffects(decision, {
          markBookDesynced: (marketKey, reason, observedAt) =>
            markBookSyncDesynced({
              syncState: this.bookSync.get(marketKey),
              reason,
              observedAt
            }),
          warnDesync: (metadata) =>
            this.logger.warn(
              "ORDER_BOOK_DESYNC",
              "Hyperliquid native book sequence gap detected",
              metadata
            )
        }),
      handleStale: (decision) =>
        this.handleStaleHyperliquidL2Book(decision, payload, wakeUpTimeMs, hotPathStartedAt),
      handleAccepted: (decision) =>
        this.handleAcceptedHyperliquidL2Book(decision, payload, wakeUpTimeMs)
    });
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
    const liquidationResult = processLiquidationIngestRuntime({
      raw,
      payload,
      currentState: this.engineState,
      currentInstrumentCode: this.engineState.microstructure.instrumentCode,
      defaultAsset: this.env.HL_ASSET,
      midPrice: this.engineState.microstructure.midPrice,
      engineStateKey: ENGINE_STATE_KEY,
      liquidationHeatmapKey: LIQUIDATION_HEATMAP_STORAGE_KEY,
      handlers: {
        recordHeatmap: (eventRaw, context) =>
          this.heatmapAgent.recordLiquidationEvent(eventRaw, {
            instrumentCode: context.instrumentCode,
            sourceExchange: context.sourceExchange,
            midPrice: context.midPrice,
            observedAt: context.observedAt
          }),
        ingestCascadeLiquidations: (eventRaw, context) =>
          this.cascadeLiquidationStream.ingest(eventRaw, {
            instrumentCode: context.instrumentCode,
            sourceExchange: context.sourceExchange,
            observedAt: context.observedAt,
            fallbackPrice: context.midPrice
          }),
        recordCascadeLiquidations: (events, observedAt) =>
          this.recordCascadeLiquidations(events, observedAt),
        scheduleCascadeLiquidationJournal: (events) =>
          this.state.waitUntil(
            persistCascadeLiquidationEventsSafely(this.env.TRADING_DB, events, {
              handleFailure: (reason, error) => this.handleStorageWriteFailure(reason, error)
            })
          ),
        scheduleStorageWrites: (storageWrites) =>
          this.state.waitUntil(this.safeStoragePut(storageWrites, "LIQUIDATION_EVENT")),
        publish: (type, publishPayload) => this.publish(type, publishPayload)
      }
    });
    this.engineState = liquidationResult.state;

    return liquidationResult.ingestResult;
  }

  private recordCascadeLiquidations(
    events: LiquidationEvent[],
    observedAt: string
  ): CascadeEvent[] {
    return recordCascadeLiquidationDetections(events, observedAt, {
      configureAbsorptionAnalyzer: () =>
        this.absorptionAnalyzer.configure(this.currentAbsorptionAnalyzerConfig()),
      isInstrumentEnabled: (instrumentCode) =>
        isCascadeInstrumentEnabledForConfig(this.cachedConfig.CASCADE_INSTRUMENTS, instrumentCode),
      configureDetector: (instrumentCode) =>
        this.cascadeDetector.configure(this.currentCascadeDetectorConfig(instrumentCode)),
      observeCascade: (event, detectedAt) =>
        this.cascadeDetector.observe(event, {
          observedAt: detectedAt,
          atr1h: resolveCascadeAtr1hFromConfig({
            event,
            midPrice: this.engineState.microstructure.midPrice,
            fallbackUsdValue: this.env.CASCADE_ATR_FALLBACK_USD,
            fallbackPctValue: this.env.CASCADE_ATR_FALLBACK_PCT
          })
        }),
      rememberCascade: (cascade) => this.cascadeEventsById.set(cascade.cascadeId, cascade),
      trackCascadeAbsorption: (cascade) => this.absorptionAnalyzer.trackCascade(cascade),
      assetProfile: (instrumentCode) => this.cascadeAssetProfile(instrumentCode),
      logDetected: (metadata) =>
        this.logger.warn("CASCADE_DETECTED", "Liquidation cascade detected", metadata),
      publishDetected: (payload) => this.publish("CASCADE_DETECTED", payload),
      alertDetected: (cascade, metadata) =>
        this.emitCascadeOperationalAlert(
          "CASCADE_DETECTED",
          "Cascade detected",
          `${cascade.instrumentCode} ${cascade.direction} liquidation cascade detected.`,
          metadata,
          cascade.cascadeId
        )
    });
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
    const observedAt = new Date().toISOString();
    const markPriceContext = {
      orderBook: this.orderBook,
      assetMatrix: this.engineState.assetMatrix,
      microstructure: this.engineState.microstructure
    };
    const closeResult = buildCascadeManualCloseRuntimeResult({
      positions: this.cascadePositionManager.snapshot(),
      positionId,
      actor,
      reason,
      observedAt,
      markPriceForInstrument: (instrumentCode) =>
        nullableMarkPriceForInstrument(markPriceContext, instrumentCode),
      requestManualClose: (id, closeObservedAt, markPrice) =>
        this.cascadePositionManager.requestManualClose(id, closeObservedAt, markPrice)
    });

    return applyCascadeManualCloseSideEffects(closeResult, {
      dispatchIntent: (intent) =>
        this.state.waitUntil(
          this.dispatchExecution(this.tradeIntentFromCascadePositionIntent(intent, observedAt))
        ),
      logManualClose: (metadata) =>
        this.logger.warn(
          "CASCADE_POSITION_MANUAL_CLOSE",
          "Operator requested cascade position close",
          metadata
        ),
      publishManualClose: (payload, correlationId) =>
        this.publish("CASCADE_POSITION_MANUAL_CLOSE", payload, correlationId),
      persistPositions: () =>
        this.state.waitUntil(
          this.safeStoragePut(
            CASCADE_POSITIONS_KEY,
            this.cascadePositionManager.snapshot(),
            "CASCADE_POSITION_MANUAL_CLOSE"
          )
        )
    });
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
    if (!isTradeTick(tick) || !Number.isFinite(tick.price) || tick.price <= 0) {
      return;
    }

    const instrumentCode = normalizeNativeInstrumentCode(tick.instrumentCode);
    if (
      !isCascadeInstrumentEnabledForConfig(this.cachedConfig.CASCADE_INSTRUMENTS, instrumentCode)
    ) {
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

    applyCascadeAbsorptionConfirmedSideEffects(confirmed, {
      recordAbsorption: (confirmedAbsorption) =>
        this.cascadeAbsorptionsById.set(confirmedAbsorption.cascadeId, confirmedAbsorption),
      logInfo: (event, message, metadata) => this.logger.info(event, message, metadata),
      publish: (telemetryType, payload) => this.publish(telemetryType, payload),
      emitOperationalAlert: (eventType, title, message, metadata, dedupeKey) =>
        this.emitCascadeOperationalAlert(eventType, title, message, metadata, dedupeKey)
    });
  }

  private recordRejectedCascadeSignal(
    rejection: CascadeRecoverySignalRejection,
    observedAt: string
  ): void {
    applyCascadeSignalRejectionSideEffects(
      {
        rejection,
        engineId: this.engineState.engineId,
        observedAt,
        entryWindowMs: this.cachedConfig.ENTRY_WINDOW_SECONDS * 1_000
      },
      {
        logInfo: (event, message, metadata) => this.logger.info(event, message, metadata),
        recordUiSignal: (signal, outcome) => this.recordCascadeUiSignal(signal, outcome)
      }
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
      atr1h: latestRawEvent
        ? resolveCascadeAtr1hFromConfig({
            event: latestRawEvent,
            midPrice: this.engineState.microstructure.midPrice,
            fallbackUsdValue: this.env.CASCADE_ATR_FALLBACK_USD,
            fallbackPctValue: this.env.CASCADE_ATR_FALLBACK_PCT
          })
        : null,
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
    await evaluateCascadeStrategyFlow(
      {
        strategyMode: this.cachedConfig.STRATEGY_MODE,
        tick,
        observedAt
      },
      {
        ingestTick: (currentTick) => this.candleAggregator.ingestTick(currentTick),
        dispatchPositionUpdates: (currentTick, updateObservedAt) =>
          this.dispatchCascadePositionUpdates(currentTick, updateObservedAt),
        isInstrumentEnabled: (instrumentCode) =>
          isCascadeInstrumentEnabledForConfig(
            this.cachedConfig.CASCADE_INSTRUMENTS,
            instrumentCode
          ),
        refreshNewsCalendar: async () => {
          await this.cascadeNewsCalendar.refresh();
        },
        latestAbsorptionForInstrument: (instrumentCode) =>
          latestAbsorptionForInstrument(this.cascadeAbsorptionsById, instrumentCode),
        cascadeForAbsorption: (absorption) =>
          this.cascadeEventsById.get(absorption.cascadeId) ?? null,
        evaluateSignal: (cascade, absorption, reclaimCandle, signalObservedAt) =>
          this.evaluateCascadeRecoverySignal(cascade, absorption, reclaimCandle, signalObservedAt),
        recordRejectedSignal: (rejection, rejectedAt) =>
          this.recordRejectedCascadeSignal(rejection, rejectedAt),
        processAcceptedSignal: (signal, acceptedAt) => this.processCascadeSignal(signal, acceptedAt)
      }
    );
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

    applyCascadePositionUpdateSideEffects(updates, observedAt, {
      dispatchCloseIntent: (intent) =>
        this.state.waitUntil(
          this.dispatchExecution(this.tradeIntentFromCascadePositionIntent(intent, observedAt))
        ),
      emitOperationalAlert: (alert) =>
        this.emitCascadeOperationalAlert(
          alert.eventType,
          alert.title,
          alert.message,
          alert.metadata,
          alert.dedupeKey
        ),
      persistPositions: () =>
        this.state.waitUntil(
          this.safeStoragePut(
            CASCADE_POSITIONS_KEY,
            this.cascadePositionManager.snapshot(),
            "CASCADE_POSITION_UPDATE"
          )
        )
    });
  }

  private async processCascadeSignal(
    signal: CascadeRecoverySignal,
    observedAt: string
  ): Promise<void> {
    const assetProfile = this.cascadeAssetProfile(signal.instrumentCode);
    const currentHeat = this.cascadeHeatManager.currentHeat(this.cascadePositionManager.snapshot());
    processAcceptedCascadeSignalFlow(
      {
        signal,
        observedAt,
        engineId: this.engineState.engineId,
        equity: this.engineState.bankroll.equity,
        riskPerTradePct: this.cachedConfig.RISK_PER_TRADE_PCT,
        assetProfile,
        currentHeat,
        heatCapPct: this.cachedConfig.HEAT_CAP_PCT
      },
      {
        emitOperationalAlert: (eventType, title, message, metadata, dedupeKey) =>
          this.emitCascadeOperationalAlert(eventType, title, message, metadata, dedupeKey),
        registerPosition: (acceptedSignal, sizeDecision, acceptedAt) =>
          this.cascadePositionManager.registerFromSignal(acceptedSignal, sizeDecision, acceptedAt),
        buildEntryIntent: (acceptedSignal, size, acceptedAt) =>
          this.tradeIntentFromCascadeSignal(acceptedSignal, size, acceptedAt),
        recordUiSignal: (agentSignal, outcome) => this.recordCascadeUiSignal(agentSignal, outcome),
        traceDecision: (decision) => this.logger.traceDecision(decision),
        schedule: (work) => this.state.waitUntil(work),
        dispatchExecution: (tradeIntent) => this.dispatchExecution(tradeIntent),
        persistPositions: () =>
          this.safeStoragePut(
            CASCADE_POSITIONS_KEY,
            this.cascadePositionManager.snapshot(),
            "CASCADE_POSITION_OPENED"
          ),
        logWarn: (event, message, metadata) => this.logger.warn(event, message, metadata)
      }
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
    const artifacts = grpcFatalDropArtifacts({
      payload,
      currentState: this.engineState,
      shadowMode: isShadowMode(this.env),
      engineStateKey: ENGINE_STATE_KEY
    });
    applyGrpcFatalDropSideEffects(artifacts, {
      applyState: (state) => {
        this.engineState = state;
      },
      persistStorage: (writes, reason) => this.persistHotStorageSnapshot(writes, reason),
      schedule: (work) => this.state.waitUntil(work),
      logError: (eventType, message, metadata) => this.logger.error(eventType, message, metadata),
      publish: (type, publishPayload) => this.publish(type, publishPayload),
      cancelAllQuotes: (instrumentCode, reason) => this.cancelAllQuotes(instrumentCode, reason)
    });

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
    const artifacts = nativeHyperliquidLatencyPullArtifacts({
      currentState: this.engineState,
      metrics,
      instrumentCode,
      sequence,
      observedAt,
      existingLatencyHistory: this.latencyHistory,
      latencyHistoryLimit: PERFORMANCE_HISTORY_LIMIT,
      engineStateKey: ENGINE_STATE_KEY,
      performanceHistoryKey: PERFORMANCE_HISTORY_KEY,
      processingLatencySamplesKey: PROCESSING_LATENCY_SAMPLES_KEY,
      processingLatencySamples: this.processingLatencySamples
    });
    this.latencyHistory = [...artifacts.latencyHistory];
    applyNativeHyperliquidLatencyPullSideEffects(artifacts, {
      applyState: (state) => {
        this.engineState = state;
      },
      persistStorage: (writes, reason) => this.persistHotStorageSnapshot(writes, reason),
      schedule: (work) => this.state.waitUntil(work),
      logPerformance: (pullMetrics) => this.logPerformance(pullMetrics),
      publish: (type, payload) => this.publish(type, payload)
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
    const registration = registerHyperliquidIngestConnection(this.activeIngestConnections, payload);

    if (!registration.registered) {
      return registration as unknown as Record<string, unknown>;
    }

    return applyHyperliquidIngestConnectionSideEffects(
      {
        registration,
        currentState: this.engineState,
        engineStateKey: ENGINE_STATE_KEY
      },
      {
        applyState: (state) => {
          this.engineState = state;
        },
        persistState: (key, state, reason) => this.waitUntilStoragePut(key, state, reason)
      }
    );
  }

  private async resetOrderBook(payload: Partial<OrderBookResetRequest>): Promise<void> {
    await applyOrderBookResetFlow(
      {
        payload,
        currentState: this.engineState,
        orderBookPrefix: ORDER_BOOK_PREFIX,
        engineStateKey: ENGINE_STATE_KEY,
        stores: this.orderBookStores(),
        orderBookSize: this.orderBook.size,
        internalOrderBookDepth: countBookLevels(this.bids, this.asks)
      },
      {
        listPersistedBooks: (prefix) => this.state.storage.list<InternalOrderBook>({ prefix }),
        handleListFailure: (error) =>
          this.handleStorageWriteFailure("ORDER_BOOK_RESET_LIST", error),
        calculatePriceDiscovery: (instrumentCode, observedAt) =>
          calculateOrderBookPriceDiscovery(this.orderBook, instrumentCode, observedAt),
        applyState: (state) => {
          this.engineState = state;
        },
        resetLatencyBaseline: (observedAt, reason) => this.resetLatencyBaseline(observedAt, reason),
        applyConnectionIds: (connectionId, connectionKeys) =>
          applyOrderBookResetConnectionIds(
            this.activeIngestConnections,
            connectionId,
            connectionKeys
          ),
        persistWrites: (writes) => this.safeStoragePut(writes, "ORDER_BOOK_RESET"),
        deleteStorageKeys: (keys) => this.safeStorageDelete([...keys], "ORDER_BOOK_RESET_DELETE"),
        logReset: (telemetry) =>
          this.logger.warn(
            "ORDER_BOOK_RESET",
            "Internal order book purged after stream recovery",
            telemetry
          ),
        publishReset: (telemetry) => this.publish("ORDER_BOOK_RESET", telemetry)
      }
    );
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
    return applyAdminRecoveryFlow(
      {
        currentState: this.engineState,
        payload,
        cachedConfig: this.cachedConfig,
        macroBias: this.macroBias,
        shadowMode: isShadowMode(this.env),
        paperBankroll: resolveAdminRecoveryPaperBankroll(this.env.PAPER_BANKROLL_USD),
        engineStateKey: ENGINE_STATE_KEY,
        performanceHistoryKey: PERFORMANCE_HISTORY_KEY,
        latencyHistory: this.latencyHistory,
        processingLatencySamplesKey: PROCESSING_LATENCY_SAMPLES_KEY,
        processingLatencySamples: this.processingLatencySamples
      },
      {
        resetOrderBook: (resetPayload) => this.resetOrderBook(resetPayload),
        resetLatencyBaseline: (observedAt, reason) => this.resetLatencyBaseline(observedAt, reason),
        clearShadowQueue: () => this.clearRecoveryShadowQueue(),
        deleteRetiredProfilerStorage: () => this.deleteRetiredProfilerStorage(),
        shadowQueueSnapshot: (observedAt) => this.ghostBook.snapshot(observedAt),
        applyState: (state) => {
          this.engineState = state;
        },
        persistStorageEntries: (entries) =>
          this.safeStoragePut(entries, "ADMIN_CONTROLLED_RECOVERY"),
        putPaperSessionStartedAt: (observedAt) =>
          this.state.waitUntil(this.env.CONFIG_STORE.put(PAPER_SESSION_STARTED_AT_KEY, observedAt)),
        logRecovery: (metadata) =>
          this.logger.warn("ADMIN_CONTROLLED_RECOVERY", "Admin controlled recovery applied", {
            ...metadata
          }),
        publishRecovery: (publishPayload) =>
          this.publish("ADMIN_CONTROLLED_RECOVERY", publishPayload)
      }
    );
  }

  private async applySnapshot(
    snapshot: OrderBookSnapshot,
    options: { telemetry?: boolean; persist?: boolean } = {}
  ): Promise<InternalOrderBook> {
    const updatedAt = new Date().toISOString();
    return applyBookSnapshotFlow(
      {
        snapshot,
        currentState: this.engineState,
        updatedAt,
        engineStateKey: ENGINE_STATE_KEY,
        domWallHistoryKey: DOM_WALL_HISTORY_KEY,
        domWallHistory: this.domWallHistory,
        orderBookPrefix: ORDER_BOOK_PREFIX,
        telemetryEnabled: options.telemetry !== false,
        persist: options.persist !== false,
        earlyTickLimit: 5,
        telemetryInterval: AGENT_SNAPSHOT_TICK_INTERVAL
      },
      {
        applySnapshotToBook: (nextSnapshot, snapshotUpdatedAt) =>
          this.orderBookReconstructor.applySnapshot(nextSnapshot, snapshotUpdatedAt),
        getDomSnapshot: (instrumentCode, snapshotUpdatedAt) =>
          this.getLiquidityWalls(instrumentCode, snapshotUpdatedAt),
        countBookLevels: () => countBookLevels(this.bids, this.asks),
        calculatePriceDiscovery: (instrumentCode, snapshotUpdatedAt) =>
          calculateOrderBookPriceDiscovery(this.orderBook, instrumentCode, snapshotUpdatedAt),
        applyState: (state) => {
          this.engineState = state;
        },
        persistStorage: (writes, reason) => this.safeStoragePut(writes, reason),
        logSnapshotApplied: (metadata) =>
          this.logger.info(
            "ORDER_BOOK_SNAPSHOT_APPLIED",
            "Full order book snapshot applied",
            metadata
          ),
        publishSnapshotApplied: (payload) => this.publish("ORDER_BOOK_SNAPSHOT_APPLIED", payload)
      }
    );
  }

  private async applyDelta(
    delta: BookDeltaWithTicker,
    updatedAt: string
  ): Promise<AppliedBookUpdate> {
    return applyBookDeltaFlow(
      {
        delta,
        currentState: this.engineState,
        updatedAt
      },
      {
        applyDeltaToBook: (nextDelta, deltaUpdatedAt) =>
          this.orderBookReconstructor.applyDelta(nextDelta, deltaUpdatedAt),
        calculatePriceDiscovery: (instrumentCode, deltaUpdatedAt) =>
          calculateOrderBookPriceDiscovery(this.orderBook, instrumentCode, deltaUpdatedAt),
        applyState: (state) => {
          this.engineState = state;
        }
      }
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
    return applyHardStaleTickDropFlow(
      {
        currentState: this.engineState,
        tick,
        metrics,
        streamId,
        hardStaleDropMs,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED
      },
      {
        applyState: (state) => {
          this.engineState = state;
        },
        resetLatencyBaseline: (observedAt, reason) => this.resetLatencyBaseline(observedAt, reason),
        persistLatencySnapshot: (reason) =>
          this.persistHotStorageSnapshot(this.latencyStorageWrites(), reason),
        warnHardStale: (metadata) =>
          this.logger.warn("HARD_STALE_TICK_DROPPED", "Dropped tick beyond hard stale threshold", {
            ...metadata
          }),
        logPerformance: (staleMetrics) => this.logPerformance(staleMetrics),
        publishPull: (payload) => this.publish("STALE_DATA_KILL_SWITCH", payload),
        schedule: (work) => this.state.waitUntil(work),
        cancelAllQuotes: (instrumentCode, reason) => this.cancelAllQuotes(instrumentCode, reason)
      }
    );
  }

  private async handleSoftStaleTick(
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    hotPathStartedAt: number
  ): Promise<TickIngestResult> {
    return applySoftStaleTickFlow(
      {
        tick,
        metrics,
        maxLatencyMs: this.maxLatencyMs,
        quoteHibernateMs: resolveQuoteHibernateMs(this.cachedConfig, this.env.QUOTE_HIBERNATE_MS),
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        trace: {
          wakeUpTimeMs,
          orderBookUpdateMs: null,
          agentLogicMs: null,
          hotPathStartedAt,
          observedAt: metrics.brainTimestamp
        }
      },
      {
        readCurrentState: () => this.engineState,
        observeExecutionProfile: (profileMetrics, trace) =>
          this.observeExecutionProfile(profileMetrics, trace),
        applyState: (state) => {
          this.engineState = state;
        },
        persistLatencySnapshot: (extra, reason) =>
          this.persistHotStorageSnapshot(this.latencyStorageWrites(extra), reason),
        logPerformance: (staleMetrics) => this.logPerformance(staleMetrics),
        publishKillSwitch: (payload) => this.publish("STALE_DATA_KILL_SWITCH", payload),
        notify: (notification) => this.notifier.notify(notification),
        schedule: (work) => this.state.waitUntil(work),
        cancelAllQuotes: (instrumentCode, reason) => this.cancelAllQuotes(instrumentCode, reason),
        publishTickTelemetry: (telemetryTick, telemetryMetrics, status, telemetryStartedAt) =>
          this.publishTickTelemetry(telemetryTick, telemetryMetrics, status, telemetryStartedAt),
        recordAgentSnapshot: (observedAt) => this.maybeRecordAgentSnapshot(observedAt)
      }
    );
  }

  private async handleInformationalBookNotReady(
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    orderBookUpdateMs: number,
    hotPathStartedAt: number
  ): Promise<TickIngestResult> {
    return applyInformationalBookNotReadyFlow(
      {
        currentState: this.engineState,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        tick,
        metrics,
        maxLatencyMs: this.maxLatencyMs,
        wakeUpTimeMs,
        orderBookUpdateMs,
        hotPathStartedAt
      },
      {
        observeExecutionProfile: (profileMetrics, trace) =>
          this.observeExecutionProfile(profileMetrics, trace),
        storageWritesForState: (state) => this.latencyStorageWritesForState(state),
        applyState: (state) => {
          this.engineState = state;
        },
        persistStorage: (writes, reason) => this.persistHotStorageSnapshot(writes, reason),
        publishTickTelemetry: (telemetryTick, telemetryMetrics, status, telemetryStartedAt) =>
          this.publishTickTelemetry(telemetryTick, telemetryMetrics, status, telemetryStartedAt)
      }
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
    return applyRejectedBookDeltaFlow(
      {
        currentState: this.engineState,
        internalOrderBookDepth: countBookLevels(this.bids, this.asks),
        tick,
        metrics,
        applied,
        maxLatencyMs: this.maxLatencyMs,
        wakeUpTimeMs,
        orderBookUpdateMs,
        hotPathStartedAt
      },
      {
        observeExecutionProfile: (profileMetrics, trace) =>
          this.observeExecutionProfile(profileMetrics, trace),
        storageWritesForState: (state, extra) => this.latencyStorageWritesForState(state, extra),
        bookDesyncStorageExtra,
        applyState: (state) => {
          this.engineState = state;
        },
        persistStorage: (writes, reason) => this.persistHotStorageSnapshot(writes, reason),
        publishTickTelemetry: (telemetryTick, telemetryMetrics, status, telemetryStartedAt) =>
          this.publishTickTelemetry(telemetryTick, telemetryMetrics, status, telemetryStartedAt)
      }
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
    const anomalyLogicMs = roundLatency(highResolutionNow() - anomalyLogicStartedAt);

    return applyAnomalyEmergencyPauseFlow(
      {
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
        observedAt: metrics.brainTimestamp,
        executionTrace: {
          wakeUpTimeMs,
          orderBookUpdateMs,
          agentLogicMs: anomalyLogicMs,
          hotPathStartedAt,
          observedAt: metrics.brainTimestamp
        }
      },
      {
        observeExecutionProfile: (profileMetrics, trace) =>
          this.observeExecutionProfile(profileMetrics, trace),
        applyState: (state) => {
          this.engineState = state;
        },
        persistStorageWrites: (writes) => this.safeStoragePut(writes, "ANOMALY_EMERGENCY_PAUSE"),
        emitEmergencyPause: (event) =>
          emitTradingAnomalyEmergencyPause(event, {
            writeCriticalLog: (source, message, metadata) =>
              this.logger.writeLog("CRITICAL", source, message, metadata),
            publish: (type, payload, correlationId) => this.publish(type, payload, correlationId),
            notify: (notification) => this.notifier.notify(notification)
          }),
        publishTickTelemetry: (telemetryTick, telemetryMetrics, status, telemetryStartedAt) =>
          this.publishTickTelemetry(telemetryTick, telemetryMetrics, status, telemetryStartedAt)
      }
    );
  }

  private handleCroupierQuoteAction(
    instrumentCode: string,
    croupierQuoteAction: CroupierQuoteAction
  ): void {
    dispatchCroupierQuoteActionSideEffects(instrumentCode, croupierQuoteAction, {
      publish: (type, payload, correlationId) => this.publish(type, payload, correlationId),
      schedule: (work) => this.state.waitUntil(work),
      cancelAllQuotes: (code, reason) => this.cancelAllQuotes(code, reason),
      dispatchQuote: (quote) => this.dispatchQuote(quote)
    });
  }

  private dispatchExecutionPlans(
    executionPlans: readonly ApprovedExecutionPlan[],
    shadowReplay: boolean
  ): void {
    dispatchExecutionPlanSideEffects({
      executionPlans,
      riskState: this.engineState,
      shadowReplay,
      tradingEnabled: this.cachedConfig.TRADING_ENABLED,
      handlers: {
        logger: this.logger,
        schedule: (work) => this.state.waitUntil(work),
        dispatchExecution: (intent, timingJitterMs) =>
          this.dispatchExecution(intent, timingJitterMs)
      }
    });
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
    applyInventoryHedgeSideEffects(
      {
        hedge,
        inventory,
        triggerPct: this.cachedConfig.HEDGE_TRIGGER_INVENTORY_PCT,
        suppressExecution: shadowReplay
      },
      {
        rememberDispatchedAt: (instrumentCode, dispatchedAtMs) =>
          this.lastHedgeDispatchedAt.set(instrumentCode, dispatchedAtMs),
        logAuthorized: (metadata) =>
          this.logger.warn(
            "INVENTORY_HEDGE_AUTHORIZED",
            "Inventory hedge IOC path authorized",
            metadata
          ),
        scheduleExecution: (intent) => this.state.waitUntil(this.dispatchExecution(intent))
      }
    );
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

    await applyProfilerSignalSideEffects(
      {
        signal: profilerResult.signal,
        profilerState: profilerResult.state,
        latencyMs: profilerLatencyMs,
        instrumentCode,
        profilerQuoteHalt: isProfilerQuoteHalt,
        shadowReplay,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        croupierHasQuote
      },
      {
        publishAlert: (signal, profilerState) =>
          publishTradingProfilerAlert(signal, profilerState, {
            publish: (type, payload, correlationId) => this.publish(type, payload, correlationId)
          }),
        acceptSignal: (signal, latencyMs) => this.acceptAgentSignal(signal, latencyMs),
        cancelQuotes: (code, reason) => this.state.waitUntil(this.cancelAllQuotes(code, reason))
      }
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

  private scheduleAcceptedTickSnapshot(
    tick: MarketTick,
    book: InternalOrderBook,
    anomalyResult: AnomalyDetectionResult,
    profilerResult: ProfilerEvaluation
  ): void {
    scheduleTradingAcceptedTickSnapshot(
      {
        engineState: this.engineState,
        latencyHistory: this.latencyHistory,
        processingLatencySamples: this.processingLatencySamples,
        domWallHistory: this.domWallHistory,
        anomalyResult,
        book,
        tick,
        profilerResult
      },
      {
        persistSnapshot: (writes, reason) => this.persistHotStorageSnapshot(writes, reason),
        schedule: (work) => this.state.waitUntil(work)
      }
    );
  }

  private journalAcceptedTick(
    tick: MarketTick,
    metrics: LatencyMetrics,
    bayesianTrace: BayesianUpdateTrace | null
  ): void {
    recordTradingAcceptedTickJournal(
      {
        tick,
        metrics,
        bayesianTrace,
        engineState: this.engineState,
        marketTickJournalInterval: this.env.MARKET_TICK_JOURNAL_INTERVAL
      },
      {
        recordMarketTick: (marketTick) => this.logger.recordMarketTick(marketTick),
        logInfo: (eventType, message, metadata) => this.logger.info(eventType, message, metadata)
      }
    );
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
    return prepareTradingTickLatency(
      {
        tick,
        shadowReplay,
        maxLatencyMs: this.maxLatencyMs,
        engineState: this.engineState,
        latencyHistory: this.latencyHistory,
        dwellirMaxLatencyMs: this.env.DWELLIR_MAX_LATENCY_MS,
        hlStaleAfterMs: this.env.HL_STALE_AFTER_MS
      },
      {
        resetLatencyBaseline: (observedAt, reason) => this.resetLatencyBaseline(observedAt, reason),
        updateLatencyAverage: (totalLatencyMs) => this.updateLatencyAverage(totalLatencyMs),
        applyLocationLatency: (totalLatencyMs, observedAt) =>
          this.applyLocationLatency(totalLatencyMs, observedAt),
        setLatencyHistory: (history) => {
          this.latencyHistory = history;
        }
      }
    );
  }

  private async resolveTickBook(
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    hotPathStartedAt: number
  ): Promise<TickBookResolution> {
    return resolveTickBookFlow(
      {
        tick,
        metrics,
        wakeUpTimeMs,
        hotPathStartedAt
      },
      {
        currentBookForMarketTick: (marketTick) =>
          currentBookForMarketTick(this.orderBook, marketTick),
        applyDelta: (delta, observedAt) => this.applyDelta(delta, observedAt),
        handleInformationalBookNotReady: (
          telemetryTick,
          telemetryMetrics,
          wakeUp,
          orderBookUpdateMs,
          telemetryStartedAt
        ) =>
          this.handleInformationalBookNotReady(
            telemetryTick,
            telemetryMetrics,
            wakeUp,
            orderBookUpdateMs,
            telemetryStartedAt
          ),
        handleRejectedBookDelta: (
          rejectedTick,
          rejectedMetrics,
          applied,
          wakeUp,
          orderBookUpdateMs,
          telemetryStartedAt
        ) =>
          this.handleRejectedBookDelta(
            rejectedTick,
            rejectedMetrics,
            applied,
            wakeUp,
            orderBookUpdateMs,
            telemetryStartedAt
          )
      }
    );
  }

  private async preparePostBookTickContext(
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string,
    options: TickHandlingOptions
  ): Promise<PostBookTickContext> {
    return preparePostBookTickRuntime(
      {
        tick,
        book,
        observedAt,
        options
      },
      {
        evaluateCascadeStrategy: (currentTick, currentObservedAt) =>
          this.evaluateCascadeStrategy(currentTick, currentObservedAt),
        updateVolatility: (instrumentCode, midPrice, currentObservedAt) =>
          this.multiScaleVolatility.update(instrumentCode, midPrice, currentObservedAt),
        maybeCancelLaggingHypeQuotes: (
          currentTick,
          volatilitySnapshot,
          currentObservedAt,
          tickOptions
        ) =>
          this.maybeCancelLaggingHypeQuotes(
            currentTick,
            volatilitySnapshot,
            currentObservedAt,
            tickOptions
          ),
        processShadowQueueTick: (currentTick, currentBook, currentObservedAt, tickOptions) =>
          this.processShadowQueueTick(currentTick, currentBook, currentObservedAt, tickOptions),
        getLiquidityWalls: (instrumentCode, currentObservedAt, currentTick) =>
          this.getLiquidityWalls(instrumentCode, currentObservedAt, currentTick)
      }
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
    const profilerAgent = this.profilerRegistry.forInstrument(tick.instrumentCode);
    const { profilerResult, profilerLatencyMs } = evaluateProfilerRuntime({
      profilerEnabled: this.cachedConfig.PROFILER_ENABLED,
      agent: profilerAgent,
      tick,
      context: {
        engineId: this.engineState.engineId,
        observedAt,
        book,
        dom: domSnapshot,
        liquidationHeatmap: this.engineState.liquidationHeatmap,
        jumpDetected
      }
    });

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
    return evaluateOracleRuntime({
      oracleEnabled: this.cachedConfig.ORACLE_ENABLED,
      agent: this.oracleAgent,
      oracle: this.engineState.oracle,
      tick,
      book,
      observedAt,
      config: this.cachedConfig
    });
  }

  private buildTickDecisionContext(
    tick: MarketTick,
    oracle: EngineState["oracle"],
    profilerResult: ProfilerEvaluation,
    observedAt: string
  ): TickDecisionContext {
    return buildTickDecisionContextFlow(
      {
        tick,
        oracle,
        profilerResult,
        observedAt,
        currentState: this.engineState,
        sentimentEnabled: this.cachedConfig.SENTIMENT_ENABLED
      },
      {
        calculateInventoryState: (decisionObservedAt) =>
          this.calculateInventoryState(decisionObservedAt),
        updatePortfolioRisk: (currentOracle, decisionObservedAt) =>
          this.updatePortfolioRisk(currentOracle, decisionObservedAt),
        profilerSnapshot: (instrumentCode, profilerState) =>
          this.profilerRegistry.snapshot(instrumentCode, profilerState),
        calculateAssetMatrix: (matrixObservedAt, instrumentCode, currentOracle, profilerStates) =>
          this.calculateAssetMatrix(matrixObservedAt, instrumentCode, currentOracle, profilerStates)
      }
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
    return prepareAcceptedExecutionContextFlow(
      {
        pipeline: input,
        profilerResult,
        oracleState,
        croupierDecision,
        decisionContext,
        currentState: this.engineState,
        pitBossEnabled: this.cachedConfig.PIT_BOSS_ENABLED,
        kellyFraction: this.cachedConfig.KELLY_FRACTION
      },
      {
        calculateEnsembleState: (
          intent,
          profilerState,
          currentOracleState,
          sentimentState,
          anomalyStatus,
          observedAt
        ) =>
          this.calculateEnsembleState(
            intent,
            profilerState,
            currentOracleState,
            sentimentState,
            anomalyStatus,
            observedAt
          ),
        prepareExecutionPlan: (intent, observedAt, options) =>
          this.prepareExecutionPlan(intent, observedAt, options),
        applyQuoteSuppression: (
          instrumentCode,
          currentCroupierDecision,
          currentProfilerResult,
          executionPlans,
          observedAt,
          shadowReplay,
          ensembleAnomalyCircuitBreaker,
          ensembleRationale
        ) =>
          this.applyQuoteSuppression(
            instrumentCode,
            currentCroupierDecision,
            currentProfilerResult,
            executionPlans,
            observedAt,
            shadowReplay,
            ensembleAnomalyCircuitBreaker,
            ensembleRationale
          )
      }
    );
  }

  private async finalizeAcceptedTick(input: AcceptedTickSideEffectsInput): Promise<void> {
    await finalizeAcceptedTickFlow(
      {
        sideEffects: input,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED
      },
      {
        scheduleAcceptedTickSnapshot: (sideEffects) =>
          this.scheduleAcceptedTickSnapshot(
            sideEffects.tick,
            sideEffects.book,
            sideEffects.anomalyResult,
            sideEffects.profilerResult
          ),
        journalAcceptedTick: (sideEffects) =>
          this.journalAcceptedTick(
            sideEffects.tick,
            sideEffects.metrics,
            sideEffects.oracleBayesianTrace
          ),
        handleCroupierQuoteAction: (instrumentCode, action) =>
          this.handleCroupierQuoteAction(instrumentCode, action),
        dispatchExecutionPlans: (executionPlans, shadowReplay) =>
          this.dispatchExecutionPlans(executionPlans, shadowReplay),
        dispatchInventoryHedgeIfNeeded: (book, inventory, observedAt, shadowReplay) =>
          this.dispatchInventoryHedgeIfNeeded(book, inventory, observedAt, shadowReplay),
        handleProfilerSignal: (
          instrumentCode,
          profilerResult,
          profilerLatencyMs,
          isProfilerQuoteHalt,
          shadowReplay,
          hasQuote
        ) =>
          this.handleProfilerSignal(
            instrumentCode,
            profilerResult,
            profilerLatencyMs,
            isProfilerQuoteHalt,
            shadowReplay,
            hasQuote
          ),
        publishTickTelemetry: (tick, metrics, status, hotPathStartedAt) =>
          this.publishTickTelemetry(tick, metrics, status, hotPathStartedAt),
        publishAmVpinTelemetry: (profilerState, instrumentCode, observedAt) =>
          publishTradingAmVpinTelemetry(profilerState, instrumentCode, observedAt, {
            publish: (type, payload, correlationId) => this.publish(type, payload, correlationId)
          }),
        maybeRecordAgentSnapshot: (observedAt) => this.maybeRecordAgentSnapshot(observedAt)
      }
    );
  }

  private async processAcceptedDecisionPipeline(
    input: AcceptedDecisionPipelineInput
  ): Promise<void> {
    await applyAcceptedDecisionPipelineFlow(
      input,
      {
        evaluateProfiler: (pipeline) =>
          this.evaluateProfilerForTick(
            pipeline.tick,
            pipeline.book,
            pipeline.domSnapshot,
            pipeline.metrics.brainTimestamp,
            pipeline.volatilitySnapshot?.jumpDetected ?? false,
            pipeline.metrics,
            pipeline.wakeUpTimeMs,
            pipeline.orderBookUpdateMs,
            pipeline.hotPathStartedAt
          ),
        evaluateOracle: (pipeline) =>
          this.evaluateOracleForTick(pipeline.tick, pipeline.book, pipeline.metrics.brainTimestamp),
        buildDecisionContext: (pipeline, oracle, profilerResult) =>
          this.buildTickDecisionContext(
            pipeline.tick,
            oracle,
            profilerResult,
            pipeline.metrics.brainTimestamp
          ),
        evaluateCroupier: (pipeline, oracle, profilerResult, decisionContext) =>
          this.evaluateCroupierForTick(
            pipeline.book,
            oracle,
            decisionContext.sentimentForDecision,
            profilerResult,
            decisionContext.inventory,
            decisionContext.leadLag,
            pipeline.volatilitySnapshot,
            pipeline.metrics.brainTimestamp
          ),
        prepareExecutionContext: (
          pipeline,
          profilerResult,
          oracle,
          croupierDecision,
          decisionContext
        ) =>
          this.prepareAcceptedExecutionContext(
            pipeline,
            profilerResult,
            oracle,
            croupierDecision,
            decisionContext
          )
      },
      {
        commitAcceptedTickState: (commitInput) => this.commitAcceptedTickState(commitInput),
        finalizeAcceptedTick: (sideEffectsInput) => this.finalizeAcceptedTick(sideEffectsInput)
      }
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
    return processShadowQueueTickRuntime(
      { tick, book, observedAt, shadowReplay: options.shadowReplay },
      {
        snapshot: (snapshotObservedAt) => this.ghostBook.snapshot(snapshotObservedAt),
        observeTrade: (tradeTick, currentBook, tradeObservedAt) =>
          this.ghostBook.observeTrade(tradeTick, currentBook, tradeObservedAt),
        recordGhostFill: (fill, fillTick, currentBook, fillObservedAt) =>
          this.recordShadowQueueGhostFill(fill, fillTick, currentBook, fillObservedAt),
        handleDecision: (decision, currentBook, decisionObservedAt) =>
          this.handleShadowQueueDecision(decision, currentBook, decisionObservedAt),
        recordDecision: (decision) => this.ghostBook.recordDecision(decision),
        injectBbo: (currentBook, injectionObservedAt) =>
          this.ghostBook.injectBbo(currentBook, injectionObservedAt)
      }
    );
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

    emitShadowQueueGhostFillSideEffects(fill.fillId, ghostFillRecord, {
      recordExecution: (trade) => this.logger.recordExecution(trade),
      publish: (type, payload, correlationId) => this.publish(type, payload, correlationId)
    });
  }

  private handleShadowQueueDecision(
    decision: ShadowQueueDecision,
    book: InternalOrderBook,
    observedAt: string
  ): ShadowQueueDecision {
    const sizing = resolveShadowQueueSizingConfig({
      cachedConfig: this.cachedConfig,
      envMaxPositionPct: readPositiveNumber(this.env.MAX_POSITION_PCT, DEFAULT_MAX_POSITION_PCT),
      envKellyFraction: readPositiveNumber(this.env.KELLY_FRACTION, 0.5)
    });
    return applyShadowQueueDecisionFlow(
      {
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
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        latencyBudgetMs: this.engineState.shadowQueue.latencyBudgetMs,
        lastLoggedAtByInstrument: this.shadowQueueNoEdgeLogAt,
        noEdgeNowMs: Date.now(),
        noEdgeLogIntervalMs: resolveShadowQueueNoEdgeLogInterval(
          this.env.SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS
        )
      },
      {
        logInfo: (eventType, message, metadata) => this.logger.info(eventType, message, metadata),
        warn: (eventType, message, metadata) => this.logger.warn(eventType, message, metadata),
        publish: (type, payload, correlationId) => this.publish(type, payload, correlationId),
        schedule: (work) => this.state.waitUntil(work),
        cancelAllQuotes: (instrumentCode, reason) => this.cancelAllQuotes(instrumentCode, reason),
        dispatchExecution: (intent) => this.dispatchExecution(intent),
        traceDecision: (trace) => this.logger.traceDecision(trace)
      }
    );
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
    const inventoryConfig = resolveInventoryStateConfig({
      config: this.cachedConfig,
      maxInventoryUnitsValue: this.env.MAX_INVENTORY_UNITS,
      maxInventoryDeltaValue: this.env.MAX_INVENTORY_DELTA,
      riskAversionFactorValue: this.env.RISK_AVERSION_FACTOR
    });
    const baseAsset = "BTC";

    return calculateInventoryRuntimeState({
      positions,
      observedAt,
      maxInventoryUnits: inventoryConfig.maxInventoryUnits,
      maxInventoryDelta: inventoryConfig.maxInventoryDelta,
      riskAversionFactor: inventoryConfig.riskAversionFactor,
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
    return applyPortfolioRiskFlow(
      {
        cachedConfig: this.cachedConfig,
        mode: this.engineState.mode,
        equity: this.engineState.bankroll.equity,
        priorHighWaterMark: this.engineState.riskMetrics.highWaterMark,
        positions: this.engineState.openPositions,
        oracleVolatility: oracle.volatility,
        varConfidenceZ: resolveVarConfidenceZ(
          this.cachedConfig,
          this.env.VAR_CONFIDENCE_Z,
          DEFAULT_VAR_CONFIDENCE_Z
        ),
        maxDrawdownPct: this.cachedConfig.MAX_DRAWDOWN_PCT,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        observedAt
      },
      {
        applyConfig: (config) => {
          this.cachedConfig = config;
        },
        writeConfig: (config) => this.configManager.writeConfig(config),
        cancelAllQuotes: (instrumentCode, reason) => this.cancelAllQuotes(instrumentCode, reason),
        schedule: (work) => this.state.waitUntil(work),
        notify: (notification) => this.notifier.notify(notification)
      }
    );
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
    const riskState = options.stateOverride ?? this.engineState;

    return prepareApprovedExecutionPlan(
      {
        intent,
        riskState,
        config: this.cachedConfig,
        observedAt,
        bypassQuoteSuspension: options.bypassQuoteSuspension,
        maxPositionPct: resolveMaxPositionPct(
          this.cachedConfig,
          this.env.MAX_POSITION_PCT,
          DEFAULT_MAX_POSITION_PCT
        ),
        kellyFraction: options.kellyFractionOverride ?? this.cachedConfig.KELLY_FRACTION,
        orderBooks: this.orderBook.values(),
        ackTimeoutMs: readPositiveInteger(
          this.env.ORDER_ACK_TIMEOUT_MS,
          DEFAULT_ORDER_ACK_TIMEOUT_MS,
          100,
          60_000
        )
      },
      {
        approveIntent: (candidateIntent, candidateRiskState, config, maxPositionPct, kelly) =>
          this.pitBossAgent.approve(
            candidateIntent,
            candidateRiskState,
            config,
            maxPositionPct,
            kelly
          ),
        logResidualLiquidityShortfall: (metadata) =>
          this.logger.warn(
            "SOR_RESIDUAL_LIQUIDITY_SHORTFALL",
            "Smart router could not source full approved size",
            metadata
          )
      }
    );
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
    applyResumeExpiredQuoteStatesSideEffects(
      {
        currentState: this.engineState,
        observedAt
      },
      {
        applyState: (state) => {
          this.engineState = state;
        },
        publishResume: (payload) => this.publish("RESUME_QUOTES", payload)
      }
    );
  }

  private maybeCancelLaggingHypeQuotes(
    tick: MarketTick,
    volatility: MultiScaleVolatilitySnapshot | null,
    observedAt: string,
    options: TickHandlingOptions
  ): void {
    applyCrossAssetHypeQuoteCancelFlow(
      {
        shadowReplay: options.shadowReplay,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED,
        tickInstrumentCode: tick.instrumentCode,
        volatility,
        observedAt,
        leadThresholdBpsValue: this.env.CROSS_ASSET_CANCEL_LEAD_BPS,
        cooldownMsValue: this.env.CROSS_ASSET_CANCEL_COOLDOWN_MS,
        lastCancelAtMs: this.crossAssetCancelLogAt.get("hype-usd") ?? 0,
        fallbackNowMs: Date.now()
      },
      {
        markCooldown: (instrumentCode, nowMs) =>
          this.crossAssetCancelLogAt.set(instrumentCode, nowMs),
        warn: (eventType, message, metadata) => this.logger.warn(eventType, message, metadata),
        publishSuspend: (payload) => this.publish("SUSPEND_QUOTES", payload),
        schedule: (work) => this.state.waitUntil(work),
        cancelAllQuotes: (instrumentCode, reason) => this.cancelAllQuotes(instrumentCode, reason)
      }
    );
  }

  private async dispatchQuote(
    quote: NonNullable<EngineState["quoteState"]["lastQuote"]>
  ): Promise<void> {
    await dispatchTradingQuote(
      {
        quote,
        engineState: this.engineState,
        cachedConfig: this.cachedConfig,
        macroBias: this.macroBias,
        hasExecutioner: Boolean(this.env.EXECUTIONER),
        maxPositionPctValue: this.env.MAX_POSITION_PCT
      },
      {
        logInfo: (event, message, metadata) => this.logger.info(event, message, metadata),
        logSkippedOrder: (skipped) =>
          this.logger.warn(
            "QUOTE_ORDER_RISK_CAP_ZERO",
            "Skipped quote order with no remaining risk budget",
            { ...skipped }
          ),
        dispatchExecution: (intent) => this.dispatchExecution(intent),
        rememberDispatchedQuote: (dispatchedQuote) => this.rememberDispatchedQuote(dispatchedQuote),
        shouldThrottleQuoteDispatch: (candidateQuote) =>
          this.shouldThrottleQuoteDispatch(candidateQuote)
      }
    );
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
    applyQuoteRefreshThrottleSideEffects(
      { quote, logKey, refresh },
      {
        markLogAt: (key, loggedAtMs) => this.quoteRefreshThrottleLogAt.set(key, loggedAtMs),
        logInfo: (event, message, metadata) => this.logger.info(event, message, metadata)
      }
    );

    return refresh.throttle.shouldThrottle;
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
    await dispatchTradingExecutionIntent(
      {
        intent,
        initialDelayMs,
        executioner: this.env.EXECUTIONER,
        cachedConfig: this.cachedConfig,
        macroBias: this.macroBias,
        logger: this.logger
      },
      {
        reservePaperExecutionBudget: (tradeIntent) => this.reservePaperExecutionBudget(tradeIntent),
        wait,
        reserveExecutionCapacity: (exchangeKey, priority) =>
          this.rateLimiter.reserve(exchangeKey, priority),
        persistRateLimitState: () =>
          this.waitUntilStoragePut(
            RATE_LIMIT_STATE_KEY,
            this.rateLimiter.exportState(),
            "EXECUTION_RATE_LIMIT"
          ),
        enqueueExecutionIntent: (tradeIntent, priority, waitMs) =>
          this.enqueueExecutionIntent(tradeIntent, priority, waitMs)
      }
    );
  }

  private reservePaperExecutionBudget(intent: TradeIntent): boolean {
    const budget = applyIntentPaperExecutionBudgetSideEffects(
      {
        intent,
        shadowMode: isShadowMode(this.env),
        nowMs: Date.now(),
        maxPerMinuteValue: this.env.PAPER_MAX_GHOST_FILLS_PER_MINUTE,
        windowStartedAtMs: this.paperExecutionWindowStartedAtMs,
        windowCount: this.paperExecutionWindowCount,
        windowDropped: this.paperExecutionWindowDropped,
        throttleLoggedAtMs: this.paperExecutionThrottleLoggedAtMs
      },
      {
        applyState: (state) => {
          this.paperExecutionWindowStartedAtMs = state.windowStartedAtMs;
          this.paperExecutionWindowCount = state.windowCount;
          this.paperExecutionWindowDropped = state.windowDropped;
          this.paperExecutionThrottleLoggedAtMs = state.throttleLoggedAtMs;
        },
        warnThrottle: (metadata) =>
          this.logger.warn(
            "SHADOW_PAPER_CADENCE_THROTTLED",
            "Paper execution cadence capped",
            metadata
          ),
        publishThrottle: (payload) => this.publish("SHADOW_PAPER_CADENCE_THROTTLED", payload)
      }
    );

    return budget.allowed;
  }

  private async enqueueExecutionIntent(
    intent: TradeIntent,
    priority: QueuedExecutionIntent["priority"],
    waitMs: number
  ): Promise<void> {
    const now = Date.now();
    await applyExecutionQueueEnqueueSideEffects(
      {
        intent,
        priority,
        waitMs,
        nowMs: now,
        enqueuedAtIso: new Date(now).toISOString(),
        alarmCapMs: CONFIG_ALARM_INTERVAL_MS,
        lastDeferralLoggedAtMs: this.rateLimitDeferralLogAt,
        throttleMs: HOT_PATH_LOG_THROTTLE_MS
      },
      {
        readQueue: () => this.readExecutionQueue("EXECUTION_QUEUE_ENQUEUE_READ"),
        persistQueue: (queue) =>
          this.safeStoragePut(EXECUTION_QUEUE_KEY, queue, "EXECUTION_QUEUE_ENQUEUE"),
        setAlarm: (timestampMs) => this.safeSetAlarm(timestampMs, "EXECUTION_QUEUE_ALARM"),
        markDeferralLogged: (loggedAtMs) => {
          this.rateLimitDeferralLogAt = loggedAtMs;
        },
        warnDeferral: (metadata) =>
          this.logger.warn(
            "EXECUTION_DEFERRED_BY_RATE_LIMIT",
            "Execution intent deferred by durable rate limiter",
            metadata
          )
      }
    );
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
    const now = Date.now();
    await applyExecutionQueueDrainSideEffects(
      {
        nowMs: now,
        alarmCapMs: CONFIG_ALARM_INTERVAL_MS
      },
      {
        readQueue: () => this.readExecutionQueue("EXECUTION_QUEUE_DRAIN_READ"),
        persistQueue: (queue) =>
          this.safeStoragePut(EXECUTION_QUEUE_KEY, queue, "EXECUTION_QUEUE_DRAIN"),
        dispatchExecution: (intent) => this.dispatchExecution(intent),
        setAlarm: (timestampMs) => this.safeSetAlarm(timestampMs, "EXECUTION_QUEUE_NEXT_WAKE")
      }
    );
  }

  private async cancelAllQuotes(instrumentCode: string, reason: string): Promise<void> {
    const executioner = this.env.EXECUTIONER;
    const now = Date.now();
    await applyQuoteCancelAllSideEffects(
      {
        instrumentCode,
        reason,
        hasExecutioner: Boolean(executioner),
        nowMs: now,
        lastDispatchAtMs: this.cancelAllLogAt.get(`${instrumentCode}:${reason}`),
        throttleMs: HOT_PATH_LOG_THROTTLE_MS
      },
      {
        markDispatch: (dispatchKey, dispatchedAtMs) =>
          this.cancelAllLogAt.set(dispatchKey, dispatchedAtMs),
        reserveCancelCapacity: () => this.rateLimiter.reserve("default", "CANCEL"),
        persistRateLimitState: () =>
          this.state.waitUntil(
            this.safeStoragePut(
              RATE_LIMIT_STATE_KEY,
              this.rateLimiter.exportState(),
              "EXECUTION_RATE_LIMIT_DRAIN"
            )
          ),
        wait,
        dispatch: (payload) => {
          if (!executioner) {
            return Promise.resolve();
          }
          return dispatchQuoteCancelAll({
            executioner,
            logger: this.logger,
            payload
          });
        }
      }
    );
  }

  private async applyExecutionReport(report: ExecutionReport): Promise<void> {
    await applyExecutionReportFlow(
      {
        state: this.engineState,
        report,
        oracleRegime: this.engineState.oracle.regime
      },
      {
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
          this.calculateInventoryState(observedAt, openPositions),
        observeAdverseSelection: (executionReport, order, markPrice, oracleRegime) =>
          this.adverseSelectionModel.observeExecutionReport(
            executionReport,
            order,
            markPrice,
            oracleRegime
          ),
        recordExecutionQuality: (record) => this.logger.recordExecutionQuality(record),
        applyState: async (state) => {
          this.engineState = state;
          await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "EXECUTION_REPORT");
        },
        recordExecution: (tradeExecution) => this.logger.recordExecution(tradeExecution),
        publishTradeExecution: (tradeExecution) =>
          this.publish(
            "TRADE_EXECUTION_UPDATE",
            tradeExecution as unknown as Record<string, unknown>,
            tradeExecution.tradeId
          )
      }
    );
  }

  private async runJanitor(source: "ALARM" | "ADMIN" = "ALARM"): Promise<void> {
    const observedAt = new Date().toISOString();
    await runTradingJanitorMaintenance(
      {
        source,
        state: this.engineState,
        observedAt,
        orderAckTimeoutMs: this.env.ORDER_ACK_TIMEOUT_MS,
        executioner: this.env.EXECUTIONER,
        logger: this.logger
      },
      {
        runBaseReport: (input) => this.janitorAgent.run(input),
        cancelOrder: (orderId, reason, instrumentCode) =>
          this.cancelOrder(orderId, reason, instrumentCode),
        pruneOperationalLogs: () => this.pruneOperationalLogs(),
        applyState: async (state) => {
          this.engineState = state;
          await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "JANITOR_REPORT");
        }
      }
    );
  }

  private async cancelOrder(
    orderId: string,
    reason: string,
    instrumentCode?: string
  ): Promise<void> {
    const executioner = this.env.EXECUTIONER;
    await applyCancelJanitorOrderSideEffects(
      {
        hasExecutioner: Boolean(executioner),
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
          ),
        wait,
        cancelOrder: (cancelOrderId, cancelReason, cancelInstrumentCode) => {
          if (!executioner) {
            return Promise.resolve();
          }
          return cancelJanitorOrder({
            executioner,
            logger: this.logger,
            orderId: cancelOrderId,
            reason: cancelReason,
            instrumentCode: cancelInstrumentCode
          });
        }
      }
    );
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
    applyShadowReplayPreparation(
      {
        currentConfig: this.cachedConfig,
        liveState: this.engineState,
        initialShadowBankroll,
        defaultMaxPositionPct: DEFAULT_MAX_POSITION_PCT,
        defaultMaxInventoryUnits: DEFAULT_MAX_INVENTORY_UNITS,
        startedAt,
        replayId
      },
      {
        clearMarketState: () => {
          this.orderBook.clear();
          this.bids.clear();
          this.asks.clear();
          this.bookSync.clear();
        },
        resetRuntimeSamples: () => {
          this.latencyHistory = [];
          this.processingLatencySamples = [];
          this.domWallHistory = [];
          this.leadLagSamples = new Map();
        },
        applyPreparedState: (preparedState) => {
          this.cachedConfig = preparedState.cachedConfig;
          this.engineState = preparedState.engineState;
        },
        resetAgents: () => {
          this.profilerRegistry.reset();
          this.anomalyDetector.hydrate(null);
          this.oracleAgent.hydrate(null);
          this.sentimentAgent.hydrate(null);
        }
      }
    );
  }

  private async recordCompletedHistoricalReplay(
    input: HistoricalReplayCompletionInput
  ): Promise<ReplayResult> {
    const completedAt = new Date().toISOString();
    return recordCompletedReplaySideEffects(
      {
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
      },
      {
        writeCompletionLog: (metadata) =>
          this.logger.warn("REPLAY_COMPLETED", "Historical shadow replay completed", metadata),
        recordBacktestRun: (result, replayOptions, dateFrom, dateTo) =>
          this.replayJournal.recordBacktestRun(result, replayOptions, dateFrom, dateTo),
        writeStatus: (status) => this.replayJournal.writeStatus(status)
      }
    );
  }

  private async writeHistoricalReplayRunningStatus(
    input: HistoricalReplayStatusInput
  ): Promise<void> {
    await writeReplayRunningStatusSideEffect(
      {
        replayId: input.replayId,
        ticksTotal: input.ticksTotal,
        speedMultiplier: input.speedMultiplier,
        shadowBankroll: input.shadowBankroll,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        scenario: input.scenario,
        startedAt: input.startedAt,
        updatedAt: input.updatedAt
      },
      {
        writeStatus: (status) => this.replayJournal.writeStatus(status)
      }
    );
  }

  private async loadScenarioReplayTicks(
    limit: number,
    dateFrom: string | null,
    dateTo: string | null,
    scenario: ReplayScenario
  ): Promise<LoadedReplayTicks> {
    return loadScenarioReplayTicksFromJournal({
      replayJournal: this.replayJournal,
      limit,
      dateFrom,
      dateTo,
      scenario
    });
  }

  private async loadReplayShadowTrades(ticks: MarketTick[]): Promise<LoadedReplayShadowTrades> {
    return loadReplayShadowTradesFromJournal({
      replayJournal: this.replayJournal,
      ticks
    });
  }

  private async runShadowReplayWithRestore(
    input: ShadowReplayWithRestoreInput
  ): Promise<ShadowReplayLoopResult> {
    return runShadowReplayWithRestoreRuntime(input, {
      runShadowReplay: (replayInput) =>
        runShadowReplayLoop({
          replayId: replayInput.replayId,
          ticks: replayInput.ticks,
          replayOptions: replayInput.replayOptions,
          speedMultiplier: replayInput.speedMultiplier,
          initialShadowBankroll: replayInput.initialShadowBankroll,
          dateFrom: replayInput.dateFrom,
          dateTo: replayInput.dateTo,
          startedAt: replayInput.startedAt,
          enqueueShadowReplayTick: (tick) => this.enqueueTick(tick, null, { shadowReplay: true }),
          lastTradeIntent: () => this.engineState.lastTradeIntent,
          oracleRegime: () => this.engineState.oracle.regime,
          writeStatus: (status) => this.replayJournal.writeStatus(status)
        }),
      restoreReplaySnapshot: (snapshot) => this.restoreReplaySnapshot(snapshot)
    });
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

    return runHistoricalReplayRuntime(
      {
        limit,
        requestedShadowBankroll: shadowBankroll,
        speedMultiplier,
        dateFrom,
        dateTo,
        replayOptions,
        startedAt,
        replayId,
        fallbackBankroll: DEFAULT_PAPER_BANKROLL_USD
      },
      {
        nowIso: () => new Date().toISOString(),
        writeRunningStatus: (statusInput) => this.writeHistoricalReplayRunningStatus(statusInput),
        captureReplaySnapshot: () => this.captureReplaySnapshot(),
        loadScenarioReplayTicks: (replayLimit, replayDateFrom, replayDateTo, scenario) =>
          this.loadScenarioReplayTicks(replayLimit, replayDateFrom, replayDateTo, scenario),
        currentLiveBankroll: () => ({
          equity: this.engineState.bankroll.equity,
          cash: this.engineState.bankroll.cash
        }),
        loadReplayShadowTrades: (ticks) => this.loadReplayShadowTrades(ticks),
        prepareShadowReplayState: (initialShadowBankroll, replayStartedAt, runtimeReplayId) =>
          this.prepareShadowReplayState(initialShadowBankroll, replayStartedAt, runtimeReplayId),
        runShadowReplayWithRestore: (replayInput) => this.runShadowReplayWithRestore(replayInput),
        recordCompletedReplay: (completionInput) =>
          this.recordCompletedHistoricalReplay(completionInput)
      }
    );
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
    await restoreReplaySnapshotSideEffects(snapshot, {
      listPersistedBookKeys: async () =>
        (
          await this.state.storage.list<InternalOrderBook>({
            prefix: ORDER_BOOK_PREFIX
          })
        ).keys(),
      onListPersistedBookKeysFailure: (error) =>
        this.handleStorageWriteFailure("REPLAY_RESTORE_LIST_BOOKS", error),
      applyRuntimeSnapshot: (replaySnapshot, hydratedBooks) => {
        this.engineState = replaySnapshot.engineState;
        this.orderBook = hydratedBooks.snapshots;
        this.bids = hydratedBooks.bids;
        this.asks = hydratedBooks.asks;
        this.bookSync = hydratedBooks.sync;
        this.rebindOrderBookReconstructor();
        this.latencyHistory = replaySnapshot.latencyHistory;
        this.processingLatencySamples = replaySnapshot.processingLatencySamples;
        this.domWallHistory = replaySnapshot.domWallHistory;
        this.leadLagSamples = new Map(replaySnapshot.leadLagSamples);
        this.cachedConfig = replaySnapshot.cachedConfig;
        this.maxLatencyMs = replaySnapshot.maxLatencyMs;
        this.lastTickTimestamp = replaySnapshot.lastTickTimestamp;
        this.signals = replaySnapshot.signals;
        this.latestAgentSignals = new Map(replaySnapshot.latestAgentSignals);
        this.profilerRegistry.hydrate(
          replaySnapshot.profilerState,
          new Map(replaySnapshot.profilerStates)
        );
        this.anomalyDetector.hydrate(replaySnapshot.anomalyState);
        this.oracleAgent.hydrate(replaySnapshot.oracleState);
        this.sentimentAgent.hydrate(replaySnapshot.sentimentState);
        this.rateLimiter.hydrate(replaySnapshot.rateLimits);
      },
      deletePersistedBookKeys: (keys) =>
        this.safeStorageDelete([...keys], "REPLAY_RESTORE_DELETE_BOOKS"),
      writeRestoreState: (writes) => this.safeStoragePut(writes, "REPLAY_RESTORE")
    });
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
    const artifacts = latencyBaselineResetArtifacts({
      currentState: this.engineState,
      observedAt,
      reason
    });
    applyLatencyBaselineResetSideEffects(artifacts, {
      replaceLatencyHistory: (history) => {
        this.latencyHistory = [...history];
      },
      replaceProcessingLatencySamples: (samples) => {
        this.processingLatencySamples = [...samples];
      },
      applyState: (state) => {
        this.engineState = state;
      },
      logReset: (metadata) =>
        this.logger.info("LATENCY_BASELINE_RESET", "Reset stale latency baseline", metadata)
    });
  }

  private latencyStorageWrites(extra?: Record<string, unknown>): Record<string, unknown> {
    return this.latencyStorageWritesForState(this.engineState, extra);
  }

  private latencyStorageWritesForState(
    state: EngineState,
    extra?: Record<string, unknown>
  ): Record<string, unknown> {
    return latencySnapshotStorageWrites({
      engineStateKey: ENGINE_STATE_KEY,
      state,
      performanceHistoryKey: PERFORMANCE_HISTORY_KEY,
      latencyHistory: this.latencyHistory,
      processingLatencySamplesKey: PROCESSING_LATENCY_SAMPLES_KEY,
      processingLatencySamples: this.processingLatencySamples,
      extra
    });
  }

  private observeExecutionProfile(metrics: LatencyMetrics, trace: ExecutionTraceInput): void {
    observeTradingExecutionProfile(
      {
        engineState: this.engineState,
        processingLatencySamples: this.processingLatencySamples,
        metrics,
        trace,
        jitterThresholdMs: this.jitterThresholdMs,
        jitterSampleWindow: this.jitterSampleWindow,
        jitterComputeIntervalTicks: this.jitterComputeIntervalTicks,
        lastPerformanceStatus: this.lastPerformanceStatus
      },
      {
        applyProfile: (profile) => {
          this.engineState = {
            ...this.engineState,
            executionProfile: profile
          };
        },
        markPerformanceStatus: (status) => {
          this.lastPerformanceStatus = status;
        },
        logPerformanceSnapshot: (snapshot) => this.logger.logPerformanceSnapshot(snapshot),
        publishTransition: (transition) =>
          this.publish(
            transition.telemetryType,
            transition.telemetryPayload,
            transition.correlationId
          ),
        notify: (notification) => this.notifier.notify(notification)
      }
    );
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
    publishTradingTickTelemetry(
      {
        tick,
        metrics,
        status,
        hotPathStartedAt,
        engineState: this.engineState,
        macroBias: this.macroBias,
        temporaryOverride: this.activeTemporaryOverride,
        connectedAdminStreams: this.adminSockets.size,
        signals: this.signals
      },
      {
        publish: (type, payload, correlationId) => this.publish(type, payload, correlationId)
      }
    );
  }

  private maybeRecordAgentSnapshot(observedAt: string): void {
    maybePublishTradingAgentSnapshot(
      {
        engineState: this.engineState,
        latestAgentSignals: this.latestAgentSignals,
        observedAt
      },
      {
        publish: (type, payload, correlationId) => this.publish(type, payload, correlationId)
      }
    );
  }

  private logPerformance(latencyMetrics: LatencyMetrics): void {
    logTradingPerformanceSpike(
      {
        logAt: this.performanceSpikeLogAt,
        latencyMetrics
      },
      {
        logPerformance: (metrics) => this.logger.logPerformance(metrics)
      }
    );
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
    applyTopologyObservationSideEffects(
      {
        observation,
        maxOrderNotional: observation.state.risk.maxOrderNotional,
        baseMaxPositionSize: this.cachedConfig.MAX_POSITION_SIZE
      },
      {
        applyState: (state) => {
          this.engineState = state;
        },
        persistState: () =>
          this.waitUntilStoragePut(ENGINE_STATE_KEY, this.engineState, "COLO_TOPOLOGY_CHANGED"),
        warn: (event) => this.logger.warn(event.eventType, event.message, event.metadata)
      }
    );
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
    applyTopologyWarmUpRuntime(
      {
        topology,
        warmedColo: this.warmedColo,
        warmedAt: this.warmedAt,
        intervalMs: WARM_UP_INTERVAL_MS,
        nowMs: Date.now()
      },
      {
        markWarmUp: (colo, warmedAtMs) => {
          this.warmedColo = colo;
          this.warmedAt = warmedAtMs;
        },
        readEngineState: () => this.state.storage.get(ENGINE_STATE_KEY),
        fetchConfig: () => this.configManager.fetchConfig(),
        info: (eventType, message, metadata) => this.logger.info(eventType, message, metadata),
        error: (eventType, message, metadata) => this.logger.error(eventType, message, metadata),
        schedule: (work) => this.state.waitUntil(work)
      }
    );
  }

  private async refreshConfig(
    source: "ALARM" | "ADMIN_SIGNAL",
    configSnapshot?: GlobalRiskConfig
  ): Promise<void> {
    const now = new Date().toISOString();

    await applyConfigRefreshFlow(
      {
        source,
        previousVersion: this.cachedConfig.version,
        configSnapshot,
        currentState: this.engineState,
        observedAt: now,
        requestId: crypto.randomUUID(),
        env: this.env
      },
      {
        fetchConfig: () => this.configManager.fetchConfig(),
        readEffectiveConfig: (config) => this.governor.readEffectiveConfig(config),
        snapshotProfilers: () => this.profilerRegistry.snapshot(),
        calculateAssetMatrix: (
          matrixObservedAt,
          latestInstrumentCode,
          latestOracle,
          profilerStates,
          assetQuoteStates
        ) =>
          this.calculateAssetMatrix(
            matrixObservedAt,
            latestInstrumentCode,
            latestOracle,
            profilerStates,
            assetQuoteStates
          ),
        applyRefreshSideEffects: (refresh) =>
          applyConfigRefreshSideEffects(refresh, {
            applyConfigCache: (config, macroBias, temporaryOverride) => {
              this.cachedConfig = config;
              this.macroBias = macroBias;
              this.activeTemporaryOverride = temporaryOverride;
            },
            configureProfilers: (config) => this.profilerRegistry.configure(config),
            setMaxLatencyMs: (maxLatencyMs) => {
              this.maxLatencyMs = maxLatencyMs;
            },
            clearKillSwitchLog: () => {
              this.killSwitchLogged = false;
            },
            applyState: (state) => {
              this.engineState = state;
            },
            persistState: () =>
              this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "CONFIG_REFRESH"),
            warnRefresh: (metadata) =>
              this.logger.warn(
                "CONFIG_REFRESHED",
                "Trading engine config cache refreshed",
                metadata
              )
          })
      }
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
    await applyAcceptedAgentSignalSideEffects(
      {
        signals: this.signals,
        latestAgentSignals: this.latestAgentSignals,
        engineState: this.engineState,
        signal,
        latencyMs,
        signalBufferLimit: SIGNAL_BUFFER_LIMIT,
        engineStateKey: ENGINE_STATE_KEY,
        tradingEnabled: this.cachedConfig.TRADING_ENABLED
      },
      {
        applyState: (state) => {
          this.engineState = state;
        },
        persistStorageEntries: (entries) => this.safeStoragePut(entries, "AGENT_SIGNAL"),
        logAgentDecision: (agentSignal, signalLatencyMs) =>
          this.logger.agentDecision(agentSignal, signalLatencyMs),
        publish: (telemetryType, payload, correlationId) =>
          this.publish(telemetryType, payload, correlationId),
        schedule: (work) => this.state.waitUntil(work),
        cancelAllQuotes: (instrumentCode, reason) => this.cancelAllQuotes(instrumentCode, reason)
      }
    );
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

    emitCascadeOperationalAlertSideEffects(event, {
      publish: (telemetryType, payload, correlationId) =>
        this.publish(telemetryType, payload, correlationId),
      notify: (notification) => this.notifier.notify(notification)
    });
  }

  private async ensureCascadePaperModeArmed(observedAt: string): Promise<void> {
    await ensureCascadePaperModeArmedRuntime(
      {
        observedAt,
        cachedConfig: this.cachedConfig,
        shadowMode: isShadowMode(this.env)
      },
      {
        getArmedAt: () => this.env.CONFIG_STORE.get(CASCADE_PAPER_ARMED_AT_KEY),
        putArmedAt: (armedAt) => this.env.CONFIG_STORE.put(CASCADE_PAPER_ARMED_AT_KEY, armedAt),
        warnArmed: (metadata) =>
          this.logger.warn(
            "CASCADE_PAPER_MODE_ARMED",
            "Cascade recovery paper-mode clock started",
            metadata
          ),
        handleError: (error) => this.handleStorageWriteFailure("CASCADE_PAPER_MODE_ARMING", error)
      }
    );
  }

  private recordCascadeUiSignal(
    signal: AgentSignal,
    outcome: "TAKEN" | "SKIPPED" | "CLOSED"
  ): void {
    recordCascadeUiSignalSideEffects(
      {
        signals: this.signals,
        latestAgentSignals: this.latestAgentSignals,
        signal,
        outcome,
        signalBufferLimit: SIGNAL_BUFFER_LIMIT
      },
      {
        schedule: (work) => this.state.waitUntil(work),
        persistSignal: (signalToPersist) =>
          this.safeStoragePut(
            agentSignalStorageKey(signalToPersist),
            signalToPersist,
            "CASCADE_SIGNAL"
          ),
        publish: (telemetryType, payload, correlationId) =>
          this.publish(telemetryType, payload, correlationId)
      }
    );
  }

  private async applyConfigUpdate(update: AdminConfigUpdate): Promise<void> {
    await applyAdminConfigUpdateFlow(
      {
        update,
        currentState: this.engineState,
        cachedConfig: this.cachedConfig,
        macroBias: this.macroBias,
        temporaryOverride: this.activeTemporaryOverride,
        currentMaxLatencyMs: this.maxLatencyMs,
        observedAt: new Date().toISOString()
      },
      {
        refreshConfig: (directConfig) => this.refreshConfig("ADMIN_SIGNAL", directConfig),
        scheduleConfigRefresh: () => this.scheduleConfigRefresh(),
        applyRuntimeUpdate: (runtimeUpdate) =>
          applyRuntimeConfigUpdateSideEffects(runtimeUpdate, {
            setMaxLatencyMs: (maxLatencyMs) => {
              this.maxLatencyMs = maxLatencyMs;
            },
            applyState: (state) => {
              this.engineState = state;
            },
            persistState: () =>
              this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "ADMIN_CONFIG_APPLIED"),
            warnApplied: (metadata) =>
              this.logger.warn("ADMIN_CONFIG_APPLIED", "Runtime configuration updated", metadata)
          })
      }
    );
  }
}
