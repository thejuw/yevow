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
import {
  AnomalyDetector,
  ANOMALY_DETECTOR_STORAGE_KEY,
  type AnomalyDetectionResult
} from "./agents/AnomalyDetector";
import { CroupierAgent, type CroupierDecision } from "./agents/CroupierAgent";
import { applyExecutionAccounting } from "./engine/ExecutionAccounting";
import { evaluateIntentDispatchGate } from "./engine/IntentGeneration";
import { countOrderBookLevels } from "./engine/OrderBookState";
import { AdverseSelectionModel, adversePenaltyForQuoteSide } from "./engine/AdverseSelectionModel";
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
import { Backtester, type BacktestInput } from "./strategy/cascade/Backtester";
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

const ENGINE_STATE_KEY = "engine:state";
const ORDER_BOOK_PREFIX = "book:";
const PERFORMANCE_HISTORY_KEY = "performance:latency-history";
const CASCADE_POSITIONS_KEY = "cascade:positions";
const CASCADE_PAPER_ARMED_AT_KEY = "cascade:paper_armed_at";
const REPLAY_STATUS_KEY = "replay:status";
const RISK_LIMITS_KEY = "risk:limits";
const CONFIG_KEY = "engine:config";
const DEFAULT_MAX_LATENCY_MS = 250;
const DEFAULT_NATIVE_HL_MAX_LATENCY_MS = 150;
const DEFAULT_DWELLIR_NATIVE_HL_MAX_LATENCY_MS = 2_500;
const DEFAULT_HARD_STALE_DROP_MS = 1_000;
const DEFAULT_HL_BOOK_TIMESTAMP_MAX_DRIFT_MS = 100;
const DEFAULT_HL_SEQUENCE_GAP_MS = 5_000;
const PERFORMANCE_HISTORY_LIMIT = 100;
const CONFIG_ALARM_INTERVAL_MS = 5_000;
const CRYPTO_DECIMAL_PLACES = 8;
const PRICE_SCALE = 100_000_000;
const TOPOLOGY_HEADER_PREFIX = "x-sovereign-topology-";
const WARM_UP_INTERVAL_MS = 60_000;
const DEFAULT_HIGH_LATENCY_COLO_RISK_MULTIPLIER = 0.5;
const SIGNAL_BUFFER_LIMIT = 500;
const DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS = 30_000;
const TELEMETRY_BUFFER_LIMIT = 1_000;
const ADMIN_STREAM_PULSE_INTERVAL_MS = 500;
const AGENT_SNAPSHOT_TICK_INTERVAL = 1_000;
const DEFAULT_HOT_STORAGE_SNAPSHOT_INTERVAL_MS = 60_000;
const DEFAULT_HOT_STORAGE_SNAPSHOT_TICK_INTERVAL = 5_000;
const STORAGE_WRITE_BACKOFF_MS = 60_000;
const BOOK_SNAPSHOT_TOP_LEVELS = 100;
const TOP_OF_BOOK_CROSS_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_ORDER_BOOK_TICK_SIZE = 0.00000001;
const DEFAULT_SOURCE_WEIGHT = 1;
const DEFAULT_PROFILER_BUCKET_VOLUME = 10;
const DEFAULT_PROFILER_ROLLING_WINDOW = 50;
const DEFAULT_PROFILER_ALERT_THRESHOLD = 0.7;
const PROCESSING_LATENCY_SAMPLES_KEY = "performance:processing-latency-samples";
const DOM_WALL_HISTORY_KEY = "dom:wall-history";
const RATE_LIMIT_STATE_KEY = "execution:rate-limits";
const EXECUTION_QUEUE_KEY = "execution:deferred-queue";
const PAPER_SESSION_STARTED_AT_KEY = "paper:session_started_at";
const HOT_PATH_LOG_THROTTLE_MS = 60_000;
const DEFAULT_JITTER_SAMPLE_WINDOW = 1_000;
const DEFAULT_JITTER_COMPUTE_INTERVAL_TICKS = 50;
const DEFAULT_JITTER_THRESHOLD_MS = 10;
const COLD_START_WAKEUP_THRESHOLD_MS = 25;
const DEFAULT_DOM_PRICE_BIN_SIZE = 10;
const DEFAULT_DOM_SCAN_RANGE_PCT = 0.02;
const DEFAULT_DOM_WALL_HISTORY_LIMIT = 500;
const DEFAULT_DOM_SPOOF_PROXIMITY_BPS = 15;
const DOM_MAX_LEVELS_PER_SIDE = 2_000;
const DEFAULT_ANOMALY_PRICE_Z_THRESHOLD = 6;
const DEFAULT_ANOMALY_VOLUME_Z_THRESHOLD = 5;
const DEFAULT_ANOMALY_CANCEL_EXEC_RATIO_THRESHOLD = 8;
const DEFAULT_ANOMALY_PRICE_WINDOW_MS = 60_000;
const DEFAULT_ANOMALY_VOLUME_WINDOW_MS = 600_000;
const DEFAULT_ANOMALY_TOP_OF_BOOK_WINDOW_MS = 600_000;
const DEFAULT_EXCHANGE_FEE_BPS = 5;
const DEFAULT_MIN_EV_THRESHOLD = 0;
const DEFAULT_MAX_POSITION_PCT = 0.05;
const DEFAULT_MAX_INVENTORY_UNITS = 5;
const DEFAULT_MAX_INVENTORY_DELTA = 1;
const DEFAULT_RISK_AVERSION_FACTOR = 0.01;
const DEFAULT_FUNDING_BIAS_THRESHOLD = 0.00001;
const DEFAULT_FUNDING_INVENTORY_BIAS = 0;
const DEFAULT_AMM_MIN_TICK_CHANGE = 0.00000001;
const DEFAULT_HEATMAP_PRICE_BIN_SIZE = 100;
const DEFAULT_HEATMAP_CLUSTER_NOTIONAL_USD = 10_000_000;
const DEFAULT_CASCADE_DISTANCE_PCT = 0.005;
const DEFAULT_PREDATORY_ORDER_OFFSET_BPS = 2;
const DEFAULT_WHALE_PRINT_Z_THRESHOLD = 5;
const DEFAULT_QUOTE_HIBERNATE_MS = 3_000;
const DEFAULT_PAPER_BANKROLL_USD = 5_000;
const DEFAULT_PAPER_MAX_GHOST_FILLS_PER_MINUTE = 90;
const DEFAULT_PAPER_FILL_PARTICIPATION_RATE = 0.35;
const DEFAULT_PAPER_FILL_ADVERSE_BPS = 1.5;
const DEFAULT_PAPER_MAKER_FEE_BPS = 2;
const DEFAULT_QUOTE_REFRESH_MIN_INTERVAL_MS = 750;
const DEFAULT_QUOTE_REFRESH_MIN_PRICE_TICKS = 1;
const DEFAULT_CROSS_ASSET_CANCEL_LEAD_BPS = 8;
const DEFAULT_CROSS_ASSET_CANCEL_COOLDOWN_MS = 5_000;
const DEFAULT_MARKET_TICK_JOURNAL_INTERVAL = 100;
const DEFAULT_MARKET_TICK_MAX_ROWS = 100_000;
const DEFAULT_SHADOW_VLO_CAPACITY = 512;
const DEFAULT_SHADOW_VLO_DRIFT_TRADES = 3;
const DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER = 1;
const DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS = 1;
const DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS = 5;
const DEFAULT_SHADOW_VLO_MIN_SIZE = 0.00000001;
const DEFAULT_SHADOW_QUEUE_NO_EDGE_LOG_INTERVAL_MS = 60_000;
const DEFAULT_VAR_CONFIDENCE_Z = 2.326;
const TARGET_ASSET_MATRIX = [
  { coin: "BTC", instrumentCode: "btc-usd" },
  { coin: "HYPE", instrumentCode: "hype-usd" }
] as const;
const TARGET_INSTRUMENTS = new Set<string>(
  TARGET_ASSET_MATRIX.map((asset) => asset.instrumentCode)
);
const DEFAULT_JANITOR_INTERVAL_MS = 60_000;
const DEFAULT_ORDER_ACK_TIMEOUT_MS = 2_000;
const DEFAULT_REPLAY_LIMIT = 250;
const AGGREGATED_BUS_TELEMETRY_TYPES = new Set([
  "POST_QUOTE",
  "PULL_ALL_QUOTES",
  "STALE_DATA_KILL_SWITCH",
  "SUSPEND_QUOTES",
  "RESUME_QUOTES",
  "SHADOW_QUEUE_NO_EDGE",
  "SHADOW_QUEUE_GHOST_FILL",
  "SHADOW_QUEUE_GREEN_LIGHT",
  "SHADOW_QUEUE_RED_LIGHT",
  "SHADOW_QUEUE_SIGNAL_SUPPRESSED",
  "SHADOW_QUEUE_LATENCY_BREACH"
]);

interface TickIngestResult {
  accepted: boolean;
  status:
    | LatencyMetrics["status"]
    | "DISABLED"
    | "ANOMALY_PAUSE"
    | "DESYNC"
    | "DUPLICATE_OR_OUT_OF_ORDER"
    | "IGNORED"
    | "STALE_DROPPED"
    | "BOOK_NOT_READY";
  reason?: string;
  processedCount?: number;
  metrics?: LatencyMetrics;
  book?: InternalOrderBook;
}

interface PerformanceMemory {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
}

interface BusMessage {
  type: string;
  sequence: number;
  emittedAt: string;
  payload: Record<string, unknown>;
}

interface TelemetryLogEntry {
  telemetryType: string;
  message: string;
  correlationId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface TickTelemetryAggregate {
  count: number;
  freshCount: number;
  staleCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  latestInstrumentCode: string | null;
  latestExchangeCode: string | null;
  latestSequence: number | null;
  latestStatus: string | null;
  latestColo: string | null;
  latestPlacement: string | null;
  latestIsGoldenRegion: boolean | null;
  latestLatencyRiskMultiplier: number | null;
  sumCpuTimeMs: number;
  sumTotalLatencyMs: number;
  sumWebsocketLatencyMs: number;
  sumProcessingLatencyMs: number;
  sumTimeToBookMs: number;
  timeToBookSamples: number;
  maxTotalLatencyMs: number;
  maxWebsocketLatencyMs: number;
  maxProcessingLatencyMs: number;
  maxTimeToBookMs: number | null;
  latestAverageLatencyMs: number | null;
  latestOrderBookDepth: number | null;
  latestToxicityScore: number | null;
  latestJitterMs: number | null;
  latestExecutionStatus: string | null;
  latestWeightedImbalance: number | null;
  latestMidPrice: number | null;
}

interface EventTelemetryAggregate {
  telemetryType: string;
  count: number;
  firstObservedAt: string;
  lastObservedAt: string;
  latestPayload: Record<string, unknown>;
  latestCorrelationId: string | null;
}

interface BookSyncState {
  marketKey: string;
  source: MarketDataSource;
  source_exchange: string;
  sourceWeight: number;
  instrumentCode: string;
  exchangeCode: string | null;
  lastSequence: number | null;
  lastSnapshotAt: string | null;
  lastDeltaAt: string | null;
  lastDesyncAt: string | null;
  desyncReason: string | null;
  isSynced: boolean;
  tickSize: number;
  ttbLatencyMs: number | null;
  lastCrossCheckAt: number;
}

interface AppliedBookUpdate {
  accepted: boolean;
  reason?: "SEQUENCE_GAP" | "DUPLICATE_OR_OUT_OF_ORDER" | "UNKNOWN_SIDE" | "CROSSED_BOOK";
  book?: InternalOrderBook;
  timeToBookMs: number | null;
  expectedSequence?: number;
  actualSequence: number;
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

interface HyperliquidRawIngestPayload {
  streamId?: string;
  source?: "HYPERLIQUID";
  source_exchange?: string;
  transport?: "websocket" | "grpc";
  exchangeCode?: string;
  instrumentCode?: string;
  sourceWeight?: number;
  connectionId?: string | null;
  receivedAt?: string;
  raw?: unknown;
  messages?: unknown[];
}

interface GrpcFatalDropPayload {
  streamId?: string;
  source?: string;
  source_exchange?: string;
  connectionId?: string | null;
  reason?: string;
  disconnectedForMs?: number;
  thresholdMs?: number;
  observedAt?: string;
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

interface ReplayTickRow {
  tick_json: string;
  received_at: string;
}

interface ReplayStatus {
  replayId: string | null;
  status: "IDLE" | "RUNNING" | "COMPLETED" | "FAILED";
  ticksTotal: number;
  ticksProcessed: number;
  progressPct: number;
  speedMultiplier: number;
  shadowBankroll: number;
  dateFrom: string | null;
  dateTo: string | null;
  scenario?: ReplayScenario;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
}

type ReplayScenario = "BASELINE" | "FLASH_CRASH" | "DELEVERAGING_2022" | "LATENCY_SHOCK";

interface ReplayOptions {
  scenario: ReplayScenario;
  latencyMs: number;
  slippageBps: number;
  feeBps: number;
  exitAfterTicks: number;
  walkForward: boolean;
  sentimentAblation: boolean;
  strategyVersionId: string | null;
  actor: string;
}

interface ReplayTradeRow {
  trade_id: string;
  asset: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  executed_at: string;
  status: string;
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

type BookDeltaWithTicker = OrderBookDelta & {
  bestBid?: number;
  bestAsk?: number;
};

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
  private readonly profilerAgents = new Map<string, ProfilerAgent>();
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
  private ingestQueue: Promise<void> = Promise.resolve();
  private orderBook = new Map<string, InternalOrderBook>();
  private bids = new Map<string, SortedBookSide>();
  private asks = new Map<string, SortedBookSide>();
  private bookSync = new Map<string, BookSyncState>();
  private activeIngestConnections = new Map<string, string>();
  private readonly adminSockets = new Set<WebSocket>();
  private signals: AgentSignal[] = [];
  private latestAgentSignals = new Map<AgentName, AgentSignal>();
  private telemetryBuffer: TelemetryLogEntry[] = [];
  private tickTelemetryAggregate: TickTelemetryAggregate | null = null;
  private eventTelemetryAggregates = new Map<string, EventTelemetryAggregate>();
  private telemetryFlushScheduled = false;
  private busSequence = 0;
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
  private storageWriteDisabledUntil = 0;
  private storageWriteFailures = 0;
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
    this.profilerAgent = new ProfilerAgent({
      bucketSize: readPositiveNumber(env.PROFILER_BUCKET_VOLUME, DEFAULT_PROFILER_BUCKET_VOLUME),
      rollingWindow: readPositiveInteger(
        env.PROFILER_ROLLING_WINDOW,
        DEFAULT_PROFILER_ROLLING_WINDOW,
        1,
        500
      ),
      alertThreshold: readBoundedNumber(
        env.PROFILER_ALERT_THRESHOLD,
        DEFAULT_PROFILER_ALERT_THRESHOLD,
        0,
        1
      ),
      whalePrintZThreshold: readPositiveNumber(
        env.WHALE_PRINT_Z_THRESHOLD,
        DEFAULT_WHALE_PRINT_Z_THRESHOLD
      ),
      quoteHibernateMs: readPositiveInteger(
        env.QUOTE_HIBERNATE_MS,
        DEFAULT_QUOTE_HIBERNATE_MS,
        100,
        60_000
      )
    });
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
      if (request.method === "GET" && url.pathname === "/health") {
        this.state.waitUntil(
          this.refreshConfigIfDue("ALARM").catch((error) => {
            this.logger.error("CONFIG_REFRESH_FAILED", "Health-triggered config refresh failed", {
              source: "HEALTH",
              message: error instanceof Error ? error.message : "UNKNOWN_ERROR"
            });
          })
        );
        return json(this.healthCheck());
      }

      if (request.method === "GET" && url.pathname === "/diagnostics") {
        return json(this.engineDiagnostics());
      }

      if (request.method === "GET" && url.pathname === "/state") {
        this.syncStateMicrostructureFromBook();
        return json({
          state: this.engineState,
          orderBook: Object.fromEntries(this.orderBook)
        });
      }

      if (request.method === "GET" && url.pathname === "/performance") {
        return json(this.latencyHistory.slice(-PERFORMANCE_HISTORY_LIMIT));
      }

      if (request.method === "GET" && url.pathname === "/slippage") {
        return json(this.engineState.slippage);
      }

      if (request.method === "GET" && url.pathname === "/metrics/performance") {
        return this.performanceMetricsResponse();
      }

      if (request.method === "POST" && url.pathname === "/maintenance/reset-latency") {
        const observedAt = new Date().toISOString();
        const shouldClearQuoteSuspension =
          this.engineState.quoteState.status === "SUSPENDED" &&
          (this.engineState.quoteState.reason === "HARD_STALE_DROP" ||
            this.engineState.quoteState.reason === "NATIVE_HL_LATENCY" ||
            this.engineState.quoteState.reason === "GRPC_FATAL_DROP" ||
            this.engineState.quoteState.reason === "STALE_DATA_KILL_SWITCH");
        this.resetLatencyBaseline(observedAt, "ADMIN_MAINTENANCE");
        const recoveredAssetQuoteStates = shouldClearQuoteSuspension
          ? resumeExpiredAssetQuoteStates(
              suspendAssetQuoteStates(
                this.engineState.assetQuoteStates,
                "ADMIN_RESET_LATENCY",
                observedAt,
                { suspendedUntil: observedAt }
              ),
              observedAt
            )
          : this.engineState.assetQuoteStates;
        const recoveredQuoteState = shouldClearQuoteSuspension
          ? aggregateQuoteState(recoveredAssetQuoteStates, this.engineState.quoteState, observedAt)
          : this.engineState.quoteState;
        this.engineState = {
          ...this.engineState,
          staleTickCount: 0,
          quoteState: recoveredQuoteState,
          assetQuoteStates: recoveredAssetQuoteStates,
          updatedAt: observedAt
        };
        if (shouldClearQuoteSuspension) {
          this.publish("RESUME_QUOTES", {
            reason: "ADMIN_RESET_LATENCY",
            observedAt
          });
        }
        await this.safeStoragePut(
          {
            [ENGINE_STATE_KEY]: this.engineState,
            [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
            [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples
          },
          "ADMIN_RESET_LATENCY"
        );
        return json({ ok: true, state: this.engineState });
      }

      if (request.method === "POST" && url.pathname === "/maintenance/recover") {
        const payload =
          (await readJsonOrNull<{
            reason?: string;
            resetInstruments?: string[] | string;
            instrumentCode?: string;
            source_exchange?: string;
            clearCitadel?: boolean;
            clearQuoteState?: boolean;
            clearLatency?: boolean;
            resetPaperPortfolio?: boolean;
            clearShadowQueue?: boolean;
          }>(request)) ?? {};
        const recovery = await this.recoverEngineState(payload);

        return json(recovery);
      }

      if (request.method === "GET" && url.pathname === "/book/snapshot") {
        const instrumentCode =
          url.searchParams.get("instrumentCode") ?? url.searchParams.get("instrument") ?? undefined;
        const depth = clampInteger(
          url.searchParams.get("depth"),
          BOOK_SNAPSHOT_TOP_LEVELS,
          1,
          BOOK_SNAPSHOT_TOP_LEVELS
        );

        return json(this.currentBookSnapshot(instrumentCode, depth));
      }

      if (request.method === "GET" && url.pathname === "/dom/heatmap") {
        const instrumentCode =
          url.searchParams.get("instrumentCode") ?? url.searchParams.get("instrument") ?? undefined;

        return json(this.currentDomHeatmap(instrumentCode));
      }

      if (request.method === "GET" && url.pathname === "/liquidations/heatmap") {
        return json({
          ok: true,
          heatmap: this.engineState.liquidationHeatmap
        });
      }

      if (request.method === "POST" && url.pathname === "/book/snapshot") {
        const snapshot = assertOrderBookSnapshot(await request.json<OrderBookSnapshot>());
        await this.applySnapshot(snapshot);
        return json({
          ok: true,
          snapshot: this.currentBookSnapshot(snapshot.instrumentCode, BOOK_SNAPSHOT_TOP_LEVELS)
        });
      }

      if (request.method === "POST" && url.pathname === "/book/delta") {
        const delta = assertOrderBookDelta(await request.json<OrderBookDelta>());
        const applied = await this.applyDelta(delta, new Date().toISOString());

        return json(
          {
            ok: applied.accepted,
            accepted: applied.accepted,
            reason: applied.reason,
            timeToBookMs: applied.timeToBookMs,
            book: applied.book ?? null
          },
          applied.accepted ? 200 : 409
        );
      }

      if (request.method === "POST" && url.pathname === "/reset-book") {
        const payload = (await readJsonOrNull<Partial<OrderBookResetRequest>>(request)) ?? {};
        await this.enqueueOrderBookReset(payload);
        return json({ ok: true, state: this.engineState });
      }

      if (request.method === "POST" && url.pathname === "/ingest/connection") {
        const payload = (await readJsonOrNull<Partial<OrderBookResetRequest>>(request)) ?? {};
        const registration = this.registerIngestConnection(payload);
        return json({ ok: true, registration, state: this.engineState });
      }

      if (request.method === "POST" && url.pathname === "/admin/replay") {
        const payload = await readJsonOrNull<{
          limit?: number;
          shadowBankroll?: number;
          speedMultiplier?: number;
          dateFrom?: string;
          dateTo?: string;
          from?: string;
          to?: string;
          scenario?: string;
          latencyMs?: number;
          slippageBps?: number;
          feeBps?: number;
          exitAfterTicks?: number;
          walkForward?: boolean;
          sentimentAblation?: boolean;
          strategyVersionId?: string | null;
          actor?: string;
        }>(request);
        const result = await this.runHistoricalReplay(
          clampInteger(
            payload?.limit === undefined ? null : String(payload.limit),
            DEFAULT_REPLAY_LIMIT,
            1,
            5_000
          ),
          typeof payload?.shadowBankroll === "number" ? payload.shadowBankroll : 0,
          readPositiveNumber(
            payload?.speedMultiplier === undefined ? undefined : String(payload.speedMultiplier),
            1
          ),
          sanitizeReplayDate(payload?.dateFrom ?? payload?.from),
          sanitizeReplayDate(payload?.dateTo ?? payload?.to),
          {
            scenario: sanitizeReplayScenario(payload?.scenario),
            latencyMs: nonNegativeFiniteNumber(payload?.latencyMs, 10),
            slippageBps: nonNegativeFiniteNumber(payload?.slippageBps, 1),
            feeBps: nonNegativeFiniteNumber(payload?.feeBps, this.cachedConfig.EXCHANGE_FEE_BPS),
            exitAfterTicks: clampInteger(
              payload?.exitAfterTicks === undefined ? null : String(payload.exitAfterTicks),
              10,
              1,
              500
            ),
            walkForward: payload?.walkForward === true,
            sentimentAblation: payload?.sentimentAblation !== false,
            strategyVersionId:
              typeof payload?.strategyVersionId === "string" && payload.strategyVersionId.trim()
                ? payload.strategyVersionId.trim()
                : null,
            actor:
              typeof payload?.actor === "string" && payload.actor.trim()
                ? payload.actor.trim().slice(0, 100)
                : "admin"
          }
        );
        return json({ ok: true, replay: result, state: this.engineState });
      }

      if (request.method === "POST" && url.pathname === "/admin/backtest/cascade") {
        const payload = await readJsonOrNull<BacktestInput>(request);
        if (!payload) {
          return json({ ok: false, error: "INVALID_BACKTEST_REQUEST" }, 400);
        }
        const report = await this.cascadeBacktester.run({
          fromDate: payload.fromDate,
          toDate: payload.toDate,
          instruments: payload.instruments,
          startingEquity: payload.startingEquity,
          candles: payload.candles,
          liquidations: payload.liquidations,
          openInterest: payload.openInterest,
          config: {
            strategyMode: this.cachedConfig.STRATEGY_MODE,
            feeBps: this.cachedConfig.EXCHANGE_FEE_BPS,
            riskPerTradePct: this.cachedConfig.RISK_PER_TRADE_PCT,
            cascadeWindowMs: this.cachedConfig.CASCADE_WINDOW_MS,
            cascadeNotionalThresholdUsd: this.cachedConfig.CASCADE_NOTIONAL_THRESHOLD_USD,
            cascadeZScoreThreshold: this.cachedConfig.CASCADE_ZSCORE_THRESHOLD,
            cascadeLookbackHours: this.cachedConfig.CASCADE_LOOKBACK_HOURS,
            cascadeDirectionalPct: this.cachedConfig.CASCADE_DIRECTIONAL_PCT,
            cascadeMinPriceMoveAtr: this.cachedConfig.CASCADE_MIN_PRICE_MOVE_ATR,
            cascadeMinBaselineWindows: readPositiveInteger(
              this.env.CASCADE_MIN_BASELINE_WINDOWS,
              12,
              0,
              10_000
            ),
            cascadeMinSeparationMs: readPositiveInteger(
              this.env.CASCADE_MIN_SEPARATION_MS,
              this.cachedConfig.CASCADE_WINDOW_MS,
              0,
              6 * 3_600_000
            ),
            absorptionWindowMs: this.cachedConfig.ABSORPTION_WINDOW_MS,
            absorptionPriceBandBps: this.cachedConfig.ABSORPTION_PRICE_BAND_BPS,
            absorptionMinHoldSeconds: this.cachedConfig.ABSORPTION_MIN_HOLD_SECONDS,
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
            runnerTrailingParam: this.cachedConfig.TRAILING_STOP_PARAM,
            maxPositionNotionalPct: this.cachedConfig.MAX_POSITION_NOTIONAL_PCT,
            assetLiquidityCapUsd: this.cachedConfig.ASSET_LIQUIDITY_CAP_USD,
            heatCapPct: this.cachedConfig.HEAT_CAP_PCT,
            ...payload.config
          }
        });
        return json({ ok: true, report });
      }

      if (request.method === "GET" && url.pathname === "/admin/cascade/active") {
        return json({ ok: true, cascades: this.currentCascadeActiveSnapshot() });
      }

      if (request.method === "GET" && url.pathname === "/admin/cascade/signals") {
        const limit = clampInteger(url.searchParams.get("limit"), 50, 1, SIGNAL_BUFFER_LIMIT);
        return json({ ok: true, signals: this.currentCascadeSignalSnapshot(limit) });
      }

      if (request.method === "GET" && url.pathname === "/admin/cascade/positions") {
        return json({ ok: true, positions: this.currentCascadePositionSnapshot() });
      }

      if (
        request.method === "POST" &&
        /^\/admin\/cascade\/positions\/[^/]+\/close$/.test(url.pathname)
      ) {
        const [, , , , positionId] = url.pathname.split("/");
        const payload =
          (await readJsonOrNull<{
            reason?: string;
            actor?: string;
          }>(request)) ?? {};
        const result = await this.closeCascadePosition(
          decodeURIComponent(positionId),
          typeof payload.actor === "string" && payload.actor.trim()
            ? payload.actor.trim()
            : "admin",
          typeof payload.reason === "string" && payload.reason.trim()
            ? payload.reason.trim()
            : "operator-request"
        );
        return json(result, result.ok ? 200 : 404);
      }

      if (request.method === "GET" && url.pathname === "/admin/cascade/heat") {
        return json({ ok: true, heat: this.currentCascadeHeatSnapshot() });
      }

      if (request.method === "POST" && url.pathname === "/admin/cascade/blackout") {
        const payload = await request.json<{
          title?: string;
          startsAt?: string;
          endsAt?: string;
          assets?: string[];
          createdBy?: string;
        }>();
        if (!payload.title || !payload.startsAt || !payload.endsAt) {
          return json({ ok: false, error: "INVALID_NEWS_BLACKOUT" }, 400);
        }
        const calendar = await this.cascadeNewsCalendar.addAdHocBlackout({
          title: payload.title,
          startsAt: payload.startsAt,
          endsAt: payload.endsAt,
          assets: payload.assets ?? ["*"],
          createdBy: payload.createdBy ?? "admin"
        });
        return json({ ok: true, calendar });
      }

      if (request.method === "GET" && url.pathname === "/admin/replay/status") {
        return json({
          ok: true,
          replay: await this.currentReplayStatus()
        });
      }

      if (request.method === "POST" && url.pathname === "/news/blackout") {
        const payload = await request.json<{
          title?: string;
          startsAt?: string;
          endsAt?: string;
          assets?: string[];
          createdBy?: string;
        }>();
        if (!payload.title || !payload.startsAt || !payload.endsAt) {
          return json({ ok: false, error: "INVALID_NEWS_BLACKOUT" }, 400);
        }
        const calendar = await this.cascadeNewsCalendar.addAdHocBlackout({
          title: payload.title,
          startsAt: payload.startsAt,
          endsAt: payload.endsAt,
          assets: payload.assets ?? ["*"],
          createdBy: payload.createdBy ?? "admin"
        });
        return json({ ok: true, calendar });
      }

      if (request.method === "POST" && url.pathname === "/news/sentiment") {
        const payload = await request.json<{
          headline?: string;
          source?: string;
          url?: string | null;
          publishedAt?: string | null;
          id?: string;
        }>();
        if (!this.cachedConfig.SENTIMENT_ENABLED) {
          const observedAt = new Date().toISOString();
          const sentiment = {
            ...defaultSentimentState(),
            updatedAt: observedAt
          };
          this.engineState = {
            ...this.engineState,
            sentiment,
            agentHealth: touchAgentHealth(
              this.engineState.agentHealth,
              "SENTIMENT",
              "DISABLED",
              observedAt,
              0
            ),
            heartbeatAt: observedAt,
            updatedAt: observedAt
          };
          await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "SENTIMENT_DISABLED");
          return json({ ok: true, skipped: true, reason: "SENTIMENT_AGENT_DISABLED", sentiment });
        }
        const sentiment = await this.sentimentAgent.analyzeHeadline(
          payload.headline ?? "",
          this.env
        );
        this.engineState = {
          ...this.engineState,
          sentiment,
          agentHealth: touchAgentHealth(
            this.engineState.agentHealth,
            "SENTIMENT",
            "GREEN",
            sentiment.updatedAt ?? new Date().toISOString(),
            sentiment.latencyMs ?? 0
          ),
          heartbeatAt: sentiment.updatedAt ?? new Date().toISOString(),
          updatedAt: sentiment.updatedAt ?? new Date().toISOString()
        };
        await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "SENTIMENT_UPDATED");
        this.logger.info("SENTIMENT_ANALYZED", "Sentiment agent updated headline bias", {
          score: sentiment.score,
          bias: sentiment.bias,
          model: sentiment.model,
          provider: sentiment.provider ?? null,
          fallbackUsed: sentiment.fallbackUsed ?? null,
          latencyMs: sentiment.latencyMs ?? null,
          estimatedCostUsd: sentiment.estimatedCostUsd ?? 0,
          ablation: sentiment.ablation ?? null,
          source: payload.source ?? "manual",
          url: payload.url ?? null,
          publishedAt: payload.publishedAt ?? null,
          newsId: payload.id ?? null
        });
        return json({ ok: true, sentiment });
      }

      if (request.method === "POST" && url.pathname === "/execution/report") {
        const report = await request.json<ExecutionReport>();
        await this.applyExecutionReport(report);
        return json({ ok: true, state: this.engineState });
      }

      if (
        request.method === "POST" &&
        (url.pathname === "/tick" ||
          url.pathname === "/market/tick" ||
          url.pathname === "/hyperliquid/tick")
      ) {
        const payload = await request.json<MarketTick>();
        const tick = assertMarketTick(payload);
        const result = await this.enqueueTick(tick, wakeUpTimeMs);
        return json(
          {
            ok: result.accepted,
            accepted: result.accepted,
            status: result.status,
            reason: result.reason,
            metrics: result.metrics ?? null,
            book: result.book,
            state: this.engineState
          },
          result.accepted ? 200 : 202
        );
      }

      if (request.method === "POST" && url.pathname === "/hyperliquid/raw") {
        const payload = await readHyperliquidRawIngestPayload(request);
        const result = await this.handleHyperliquidRaw(payload, wakeUpTimeMs);
        return json(
          {
            ok: result.accepted,
            accepted: result.accepted,
            processedCount: result.processedCount,
            status: result.status,
            reason: result.reason,
            metrics: result.metrics ?? null,
            book: result.book,
            state: this.engineState
          },
          result.status === "DESYNC" ? 409 : result.accepted ? 200 : 202
        );
      }

      if (request.method === "POST" && url.pathname === "/liquidation") {
        const payload = await readHyperliquidRawIngestPayload(request);
        const result = await this.handleHyperliquidRaw(payload, wakeUpTimeMs);
        return json(
          {
            ok: result.accepted,
            accepted: result.accepted,
            processedCount: result.processedCount,
            status: result.status,
            reason: result.reason,
            state: this.engineState
          },
          result.accepted ? 200 : 202
        );
      }

      if (request.method === "POST" && url.pathname === "/ingest/grpc-fatal-drop") {
        const payload = await request.json<GrpcFatalDropPayload>();
        const result = await this.handleGrpcFatalDrop(payload);
        return json({
          ok: true,
          accepted: true,
          status: result.status,
          state: this.engineState
        });
      }

      if (request.method === "POST" && url.pathname === "/ticks") {
        const payload = await request.json<MarketTick[] | { ticks?: MarketTick[] }>();
        const ticks = Array.isArray(payload)
          ? payload
          : Array.isArray(payload.ticks)
            ? payload.ticks
            : null;

        if (!ticks) {
          throw new Error("INVALID_MARKET_TICK_BATCH");
        }

        const results: TickIngestResult[] = [];
        const cappedTicks = ticks.slice(0, 250);

        for (const tickPayload of cappedTicks) {
          const result = await this.enqueueTick(assertMarketTick(tickPayload), wakeUpTimeMs);
          results.push(result);

          if (result.status === "DESYNC") {
            break;
          }
        }

        const acceptedCount = results.filter((result) => result.accepted).length;
        const terminalResult =
          results.find((result) => result.status === "DESYNC") ?? results.at(-1);

        return json(
          {
            ok: terminalResult?.status !== "DESYNC",
            accepted: acceptedCount > 0,
            acceptedCount,
            receivedCount: ticks.length,
            processedCount: results.length,
            droppedCount: Math.max(0, ticks.length - results.length),
            status: terminalResult?.status ?? "EMPTY_BATCH",
            reason: terminalResult?.reason,
            metrics: terminalResult?.metrics ?? null,
            book: terminalResult?.book,
            state: this.engineState
          },
          terminalResult?.status === "DESYNC" ? 409 : 200
        );
      }

      if (request.method === "POST" && url.pathname === "/agent/signal") {
        const started = Date.now();
        const signal = assertAgentSignal(await request.json<AgentSignal>());
        await this.acceptAgentSignal(signal, Date.now() - started);
        return json({ ok: true, signalId: signal.signalId, state: this.engineState });
      }

      if (request.method === "POST" && url.pathname === "/admin/config") {
        const update = await request.json<AdminConfigUpdate>();
        await this.applyConfigUpdate(update);
        return json({ ok: true, state: this.engineState });
      }

      return json({ ok: false, error: "Not found" }, 404);
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
    if (this.orderBook.size === 0) {
      return;
    }

    const currentKey = this.engineState.microstructure.marketKey;
    const currentBook = currentKey ? this.orderBook.get(currentKey) : undefined;
    const bestBook =
      currentBook ??
      [...this.orderBook.values()].sort((left, right) => {
        const leftScore =
          (left.isSynced ? 10 : 0) + (left.midPrice === null ? 0 : 1) + left.sourceWeight;
        const rightScore =
          (right.isSynced ? 10 : 0) + (right.midPrice === null ? 0 : 1) + right.sourceWeight;
        return rightScore - leftScore;
      })[0];

    if (!bestBook) {
      return;
    }

    const microstructure = microstructureFromBook(bestBook);
    const updatedAt = microstructure.updatedAt ?? new Date().toISOString();

    this.engineState = {
      ...this.engineState,
      internalOrderBookDepth: countBookLevels(this.bids, this.asks),
      microstructure,
      priceDiscovery: this.calculatePriceDiscovery(bestBook.instrumentCode, updatedAt),
      assetMatrix: this.calculateAssetMatrix(
        updatedAt,
        bestBook.instrumentCode,
        this.engineState.oracle,
        this.profilerStateSnapshot(),
        this.engineState.assetQuoteStates
      ),
      updatedAt
    };
  }

  private engineDiagnostics(): JsonRecord {
    const memory = (globalThis as RuntimeWithMemory).performance?.memory;
    const marketSync = [...this.bookSync.entries()].map(([marketKey, sync]) => ({
      marketKey,
      instrumentCode: sync.instrumentCode,
      isSynced: sync.isSynced,
      lastSequence: sync.lastSequence,
      expectedNextSequence: sync.lastSequence === null ? null : sync.lastSequence + 1,
      desyncReason: sync.desyncReason ?? null,
      lastDesyncAt: sync.lastDesyncAt ?? null
    }));
    const desynced = marketSync.filter((entry) => !entry.isSynced);
    const profilerBuffers = Object.fromEntries(
      [...this.profilerAgents.entries()].map(([instrumentCode, agent]) => [
        instrumentCode,
        agent.diagnostics()
      ])
    );
    const allBuffersFlat = Object.values(profilerBuffers).every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { flatMemory?: boolean }).flatMemory === true
    );
    const heapRatio =
      memory?.jsHeapSizeLimit && memory.usedJSHeapSize
        ? memory.usedJSHeapSize / memory.jsHeapSizeLimit
        : null;

    return {
      ok: desynced.length === 0 && allBuffersFlat && (heapRatio === null || heapRatio < 0.8),
      observedAt: new Date().toISOString(),
      l1Sync: {
        ok: desynced.length === 0,
        desyncCount: desynced.length,
        markets: marketSync,
        expectedAssets: TARGET_ASSET_MATRIX.map((asset) => asset.instrumentCode)
      },
      v8Memory: {
        ok: allBuffersFlat && (heapRatio === null || heapRatio < 0.8),
        profilerBuffers,
        heap: {
          available: Boolean(memory),
          usedJSHeapSize: memory?.usedJSHeapSize ?? null,
          totalJSHeapSize: memory?.totalJSHeapSize ?? null,
          jsHeapSizeLimit: memory?.jsHeapSizeLimit ?? null,
          heapRatio
        }
      },
      shadowQueue: this.engineState.shadowQueue as unknown as JsonValue,
      assetMatrix: this.engineState.assetMatrix as unknown as JsonValue
    };
  }

  private profilerFor(instrumentCode: string): ProfilerAgent {
    const normalized = normalizeNativeInstrumentCode(instrumentCode);
    const existing = this.profilerAgents.get(normalized);

    if (existing) {
      return existing;
    }

    const agent = normalized === "btc-usd" ? this.profilerAgent : this.createProfilerAgent();
    agent.configure(this.cachedConfig);
    this.profilerAgents.set(normalized, agent);
    return agent;
  }

  private createProfilerAgent(): ProfilerAgent {
    return new ProfilerAgent({
      bucketSize: readPositiveNumber(
        this.env.PROFILER_BUCKET_VOLUME,
        DEFAULT_PROFILER_BUCKET_VOLUME
      ),
      rollingWindow: readPositiveInteger(
        this.env.PROFILER_ROLLING_WINDOW,
        DEFAULT_PROFILER_ROLLING_WINDOW,
        1,
        500
      ),
      alertThreshold: readBoundedNumber(
        this.env.PROFILER_ALERT_THRESHOLD,
        DEFAULT_PROFILER_ALERT_THRESHOLD,
        0,
        1
      ),
      whalePrintZThreshold: readPositiveNumber(
        this.env.WHALE_PRINT_Z_THRESHOLD,
        DEFAULT_WHALE_PRINT_Z_THRESHOLD
      ),
      quoteHibernateMs: readPositiveInteger(
        this.env.QUOTE_HIBERNATE_MS,
        DEFAULT_QUOTE_HIBERNATE_MS,
        100,
        60_000
      )
    });
  }

  private hydrateProfilerAgents(
    legacyState: ProfilerState | undefined,
    persistedStates: Map<string, ProfilerState>
  ): void {
    this.profilerAgents.clear();
    this.profilerAgent.hydrate(legacyState);
    this.profilerAgents.set("btc-usd", this.profilerAgent);

    for (const [storageKey, state] of persistedStates) {
      const instrumentCode = profilerInstrumentFromStorageKey(storageKey);
      if (!isTargetInstrument(instrumentCode)) {
        continue;
      }
      const agent = instrumentCode === "btc-usd" ? this.profilerAgent : this.createProfilerAgent();
      agent.hydrate(state);
      this.profilerAgents.set(instrumentCode, agent);
    }

    for (const asset of TARGET_ASSET_MATRIX) {
      this.profilerFor(asset.instrumentCode);
    }
  }

  private resetProfilerAgents(): void {
    this.profilerAgents.clear();
    this.profilerAgent.hydrate(null);
    this.profilerAgent.configure(this.cachedConfig);
    this.profilerAgents.set("btc-usd", this.profilerAgent);

    for (const asset of TARGET_ASSET_MATRIX) {
      this.profilerFor(asset.instrumentCode).hydrate(null);
      this.profilerFor(asset.instrumentCode).configure(this.cachedConfig);
    }
  }

  private async deleteRetiredProfilerStorage(): Promise<string[]> {
    const retiredKeys: string[] = [];

    for (const instrumentCode of [...this.profilerAgents.keys()]) {
      if (!isTargetInstrument(instrumentCode)) {
        this.profilerAgents.delete(instrumentCode);
      }
    }

    try {
      const stored = await this.state.storage.list<ProfilerState>({
        prefix: PROFILER_STATE_STORAGE_PREFIX
      });
      for (const key of stored.keys()) {
        if (!isTargetInstrument(profilerInstrumentFromStorageKey(key))) {
          retiredKeys.push(key);
        }
      }
      if (retiredKeys.length > 0) {
        await this.state.storage.delete(retiredKeys);
      }
    } catch (error) {
      this.handleStorageWriteFailure("RETIRED_PROFILER_STORAGE_DELETE", error);
    }

    return retiredKeys;
  }

  private configureProfilerAgents(config: GlobalRiskConfig): void {
    this.profilerAgent.configure(config);
    for (const agent of this.profilerAgents.values()) {
      agent.configure(config);
    }
  }

  private profilerStateSnapshot(
    overrideInstrument?: string,
    overrideState?: ProfilerState
  ): Record<string, ProfilerState> {
    const entries: Array<[string, ProfilerState]> = [];

    for (const asset of TARGET_ASSET_MATRIX) {
      entries.push([asset.instrumentCode, this.profilerFor(asset.instrumentCode).snapshot()]);
    }

    if (overrideInstrument && overrideState) {
      const normalized = normalizeNativeInstrumentCode(overrideInstrument);
      if (!isTargetInstrument(normalized)) {
        return Object.fromEntries(entries);
      }
      const index = entries.findIndex(([instrumentCode]) => instrumentCode === normalized);
      if (index >= 0) {
        entries[index] = [normalized, overrideState];
      } else {
        entries.push([normalized, overrideState]);
      }
    }

    return Object.fromEntries(entries);
  }

  private maxProfilerToxicity(): number {
    let max = this.profilerAgent.toxicityScore;
    for (const agent of this.profilerAgents.values()) {
      max = Math.max(max, agent.toxicityScore);
    }
    return max;
  }

  private findBestAssetBook(instrumentCode: string): InternalOrderBook | undefined {
    const normalized = normalizeNativeInstrumentCode(instrumentCode);
    let best: InternalOrderBook | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestObservedAt = 0;

    for (const book of this.orderBook.values()) {
      if (book.instrumentCode !== normalized) {
        continue;
      }

      const observedAt = Date.parse(book.updatedAt);
      const score =
        (book.isSynced ? 100 : 0) +
        (book.midPrice !== null ? 10 : 0) +
        Math.min(Math.max(book.bids.length, book.asks.length), 50) / 100;

      if (
        !best ||
        score > bestScore ||
        (score === bestScore && Number.isFinite(observedAt) && observedAt > bestObservedAt)
      ) {
        best = book;
        bestScore = score;
        bestObservedAt = Number.isFinite(observedAt) ? observedAt : 0;
      }
    }

    return best;
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
    if (this.storageWriteDisabledUntil > Date.now()) {
      return;
    }

    const reason =
      typeof keyOrEntries === "string"
        ? (maybeReason ?? "STORAGE_WRITE")
        : typeof valueOrReason === "string"
          ? valueOrReason
          : "STORAGE_WRITE";

    try {
      if (typeof keyOrEntries === "string") {
        await this.state.storage.put(keyOrEntries, valueOrReason);
      } else {
        await this.state.storage.put(keyOrEntries);
      }
      this.storageWriteFailures = 0;
    } catch (error) {
      this.handleStorageWriteFailure(reason, error);
    }
  }

  private waitUntilStoragePut(key: string, value: unknown, reason: string): void {
    this.state.waitUntil(this.safeStoragePut(key, value, reason));
  }

  private waitUntilStoragePutEntries(entries: Record<string, unknown>, reason: string): void {
    this.state.waitUntil(this.safeStoragePut(entries, reason));
  }

  private async safeStorageDelete(keys: string[], reason: string): Promise<void> {
    if (keys.length === 0 || this.storageWriteDisabledUntil > Date.now()) {
      return;
    }

    try {
      await this.state.storage.delete(keys);
      this.storageWriteFailures = 0;
    } catch (error) {
      this.handleStorageWriteFailure(reason, error);
    }
  }

  private async safeSetAlarm(timestamp: number, reason: string): Promise<void> {
    if (this.storageWriteDisabledUntil > Date.now()) {
      return;
    }

    try {
      await this.state.storage.setAlarm(timestamp);
      this.storageWriteFailures = 0;
    } catch (error) {
      this.handleStorageWriteFailure(reason, error);
    }
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
    this.storageWriteFailures += 1;
    const message = error instanceof Error ? error.message : "UNKNOWN_STORAGE_ERROR";
    const lowered = message.toLowerCase();
    const isQuota =
      message.includes("Exceeded allowed rows written") ||
      lowered.includes("quota") ||
      lowered.includes("limit");
    const backoffMs = isQuota
      ? STORAGE_WRITE_BACKOFF_MS
      : Math.min(STORAGE_WRITE_BACKOFF_MS, this.storageWriteFailures * 5_000);

    this.storageWriteDisabledUntil = Date.now() + backoffMs;
    console.error(
      JSON.stringify({
        event: "DO_STORAGE_WRITE_FAILED",
        reason,
        message,
        backoffMs,
        failures: this.storageWriteFailures
      })
    );
  }

  private acceptMarketStream(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    server.accept();
    server.send(
      JSON.stringify({
        type: "SYSTEM_INIT",
        engineId: this.engineState.engineId,
        heartbeatAt: this.engineState.heartbeatAt
      })
    );

    server.addEventListener("message", (event) => {
      const payload = decodeWebSocketMessage(event.data);
      const tick = payload ? parseJson<MarketTick>(payload) : null;

      if (!tick) {
        server.send(JSON.stringify({ type: "ERROR", reason: "INVALID_JSON" }));
        return;
      }

      let marketTick: MarketTick;

      try {
        marketTick = assertMarketTick(tick);
      } catch (error) {
        server.send(
          JSON.stringify({
            type: "ERROR",
            reason: error instanceof Error ? error.message : "INVALID_MARKET_TICK"
          })
        );
        return;
      }

      const queued = this.enqueueTick(marketTick)
        .then((result) => {
          server.send(
            JSON.stringify({
              type: "ACK",
              accepted: result.accepted,
              status: result.status,
              reason: result.reason,
              instrumentCode: result.metrics?.instrumentCode ?? null,
              sequence: result.metrics?.sequence ?? null,
              totalLatencyMs: result.metrics?.totalLatencyMs ?? null
            })
          );
        })
        .catch((error) => {
          server.send(
            JSON.stringify({
              type: "ERROR",
              reason: error instanceof Error ? error.message : "UNKNOWN"
            })
          );
        });

      this.state.waitUntil(queued);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptTelemetryStream(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    server.accept();
    this.adminSockets.add(server);
    this.sendSocketMessage(server, {
      type: "TELEMETRY_SNAPSHOT",
      sequence: this.nextBusSequence(),
      emittedAt: new Date().toISOString(),
      payload: {
        state: this.engineState,
        recentSignals: this.signals.slice(-SIGNAL_BUFFER_LIMIT),
        recentLatency: this.latencyHistory.slice(-PERFORMANCE_HISTORY_LIMIT),
        connectedAdminStreams: this.adminSockets.size
      }
    });
    const pulseInterval = setInterval(() => {
      this.sendSocketMessage(server, {
        type: "DASHBOARD_PULSE",
        sequence: this.nextBusSequence(),
        emittedAt: new Date().toISOString(),
        payload: this.dashboardPulsePayload()
      });
    }, ADMIN_STREAM_PULSE_INTERVAL_MS);

    server.addEventListener("message", (event) => {
      const payload = decodeWebSocketMessage(event.data);
      const message = payload ? parseJson<{ type?: string; sentAt?: string }>(payload) : null;

      if (message?.type?.toUpperCase() === "PING") {
        this.sendSocketMessage(server, {
          type: "PONG",
          sequence: this.nextBusSequence(),
          emittedAt: new Date().toISOString(),
          payload: {
            sentAt: message.sentAt ?? null
          }
        });
      }
    });

    const cleanup = () => {
      clearInterval(pulseInterval);
      this.adminSockets.delete(server);
    };

    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    this.publish("ADMIN_STREAM_CONNECTED", {
      connectedAdminStreams: this.adminSockets.size,
      engineId: this.engineState.engineId
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private dashboardPulsePayload(): Record<string, unknown> {
    const equity = this.engineState.bankroll.equity;
    const unrealizedPnl = Object.values(this.engineState.openPositions).reduce(
      (sum, position) => sum + position.unrealizedPnl,
      0
    );
    const latestSignals = this.signals.slice(-10).map((signal) => ({
      signalId: signal.signalId,
      traceId: signal.traceId,
      agent: signal.sourceAgent,
      target: signal.targetAgent,
      action: signal.action,
      confidence: signal.confidence,
      expectedValue: signal.expectedValue,
      rationale: signal.rationale,
      createdAt: signal.createdAt
    }));
    const latestLatency = this.latencyHistory.at(-1) ?? null;

    return {
      schemaVersion: "admin.dashboard-pulse.v1",
      total_equity: equity,
      unrealized_pnl: unrealizedPnl,
      active_drawdown: this.engineState.riskMetrics.rollingDrawdownPct,
      current_imbalance: this.engineState.microstructure.weightedImbalance,
      processed_ticks: this.engineState.processedTicks,
      mode: this.engineState.mode,
      quote_state: this.engineState.quoteState.status,
      shadow_queue: this.engineState.shadowQueue,
      toxicity_score: this.engineState.toxicityScore,
      latency_ms: this.engineState.averageLatency,
      exchange_to_receipt_ms: latestLatency?.networkLatencyMs ?? this.engineState.averageLatency,
      jitter_ms: this.engineState.executionProfile.jitterMs,
      regime: this.engineState.oracle.regime,
      regimeCoefficient: this.engineState.oracle.skepticismMultiplier,
      macroBias: this.macroBias,
      temporaryOverride: this.activeTemporaryOverride,
      liquidationHeatmap: {
        totalEstimatedNotionalUsd: this.engineState.liquidationHeatmap.totalEstimatedNotionalUsd,
        clusterCount: this.engineState.liquidationHeatmap.clusters.length,
        nearestCascade: this.engineState.liquidationHeatmap.nearestCascade,
        providerEventCount: this.engineState.liquidationHeatmap.recentEvents.length,
        updatedAt: this.engineState.liquidationHeatmap.updatedAt
      },
      AgentLogicTrace: latestSignals,
      sparkline: this.latencyHistory.slice(-60).map((metric) => ({
        t: metric.brainTimestamp,
        latency: metric.totalLatencyMs,
        imbalance:
          metric.status === "FRESH" ? this.engineState.microstructure.weightedImbalance : null
      })),
      location: this.engineState.location.colo,
      connectedAdminStreams: this.adminSockets.size,
      heartbeatAt: this.engineState.heartbeatAt
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
    if (!this.isActiveIngestConnection(payload)) {
      return {
        accepted: false,
        status: "IGNORED",
        reason: "STALE_INGEST_CONNECTION",
        processedCount: 0
      };
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : [payload.raw ?? payload];
    let processedCount = 0;
    let terminalResult: TickIngestResult | null = null;

    for (const raw of messages.slice(0, 250)) {
      const result = await this.enqueueHyperliquidRawMessage(raw, payload, wakeUpTimeMs);
      processedCount += result.processedCount ?? (result.accepted ? 1 : 0);
      terminalResult = result;

      if (result.status === "DESYNC" || result.status === "STALE") {
        break;
      }
    }

    return {
      ...(terminalResult ?? { accepted: true, status: "FRESH" as const }),
      processedCount
    };
  }

  private ingestConnectionKey(
    sourceExchange: string | null | undefined,
    streamId?: string | null
  ): string {
    return `${normalizeSourceExchange(sourceExchange ?? "hyperliquid")}:${streamId ?? "default"}`;
  }

  private isActiveIngestConnection(payload: HyperliquidRawIngestPayload): boolean {
    if (!payload.connectionId) {
      return true;
    }

    const key = this.ingestConnectionKey(payload.source_exchange, payload.streamId);
    const fallbackKey = this.ingestConnectionKey(payload.source_exchange, null);
    const activeConnection = payload.streamId
      ? this.activeIngestConnections.get(key)
      : this.activeIngestConnections.get(fallbackKey);

    return !activeConnection || activeConnection === payload.connectionId;
  }

  private resolveHyperliquidBookTimestamp(
    rawExchangeTimestamp: string | null,
    receivedAt: string
  ): string {
    if (!rawExchangeTimestamp) {
      return receivedAt;
    }

    const rawMs = Date.parse(rawExchangeTimestamp);
    const receivedMs = Date.parse(receivedAt);

    if (!Number.isFinite(rawMs) || !Number.isFinite(receivedMs)) {
      return receivedAt;
    }

    const maxDriftMs = readPositiveNumber(
      this.env.HL_BOOK_TIMESTAMP_MAX_DRIFT_MS,
      DEFAULT_HL_BOOK_TIMESTAMP_MAX_DRIFT_MS
    );

    return receivedMs - rawMs > maxDriftMs ? receivedAt : rawExchangeTimestamp;
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
    const exchangeTimestamp = this.resolveHyperliquidBookTimestamp(
      rawExchangeTimestamp,
      receivedAt
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
    this.cascadeDetector.configure(this.currentCascadeDetectorConfig());
    this.absorptionAnalyzer.configure(this.currentAbsorptionAnalyzerConfig());

    for (const event of events) {
      if (!this.isCascadeInstrumentEnabled(event.instrumentCode)) {
        continue;
      }

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

  private currentCascadeDetectorConfig(): CascadeDetectorConfig {
    return {
      windowMs: this.cachedConfig.CASCADE_WINDOW_MS,
      notionalThresholdUsd: this.cachedConfig.CASCADE_NOTIONAL_THRESHOLD_USD,
      zScoreThreshold: this.cachedConfig.CASCADE_ZSCORE_THRESHOLD,
      lookbackHours: this.cachedConfig.CASCADE_LOOKBACK_HOURS,
      directionalPct: this.cachedConfig.CASCADE_DIRECTIONAL_PCT,
      minPriceMoveAtr: this.cachedConfig.CASCADE_MIN_PRICE_MOVE_ATR,
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
      maxPositionNotionalPct: this.cachedConfig.MAX_POSITION_NOTIONAL_PCT,
      assetLiquidityCap: this.cachedConfig.ASSET_LIQUIDITY_CAP_USD,
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
      maxSlippageBps: this.cachedConfig.HEDGE_MAX_SLIPPAGE_BPS,
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
      maxSlippageBps: this.cachedConfig.HEDGE_MAX_SLIPPAGE_BPS,
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
      this.ingestConnectionKey(sourceExchange, streamId),
      connectionId
    );

    if (!streamId) {
      this.activeIngestConnections.set(
        this.ingestConnectionKey(sourceExchange, null),
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
          this.ingestConnectionKey(resetSourceExchange, resetStreamId),
          payload.connectionId
        );
        if (!resetStreamId) {
          this.activeIngestConnections.set(
            this.ingestConnectionKey(resetSourceExchange, null),
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
    const instrumentCode = snapshot.instrumentCode.toLowerCase();
    const exchangeCode = snapshot.exchangeCode.toLowerCase();
    const sourceExchange = normalizeSourceExchange(
      snapshot.source_exchange ?? snapshot.exchangeCode
    );
    const marketKey = normalizeMarketKey(
      snapshot.marketKey ?? buildMarketKey(sourceExchange, instrumentCode)
    );
    const sourceWeight = normalizeSourceWeight(snapshot.sourceWeight);
    const tickSize = resolveTickSize(this.env, instrumentCode, snapshot.tickSize);
    const bidBook = new SortedBookSide("bid");
    const askBook = new SortedBookSide("ask");

    for (const level of snapshot.bids) {
      bidBook.upsert(level.price, level.size, level.updatedAt ?? updatedAt, tickSize);
    }

    for (const level of snapshot.asks) {
      askBook.upsert(level.price, level.size, level.updatedAt ?? updatedAt, tickSize);
    }

    this.bids.set(marketKey, bidBook);
    this.asks.set(marketKey, askBook);

    const timeToBookMs = calculateTimeToBookMs(snapshot.exchangeTimestamp, updatedAt);
    const syncState = this.getBookSync(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      tickSize,
      snapshot.source === "ADMIN" ? "SYSTEM" : snapshot.source,
      sourceWeight
    );
    syncState.exchangeCode = exchangeCode;
    syncState.source_exchange = sourceExchange;
    syncState.sourceWeight = sourceWeight;
    syncState.lastSequence = snapshot.sequence;
    syncState.lastSnapshotAt = updatedAt;
    syncState.lastDeltaAt = null;
    syncState.lastDesyncAt = null;
    syncState.desyncReason = null;
    syncState.isSynced = true;
    syncState.tickSize = tickSize;
    syncState.ttbLatencyMs = timeToBookMs;

    const book = this.rebuildBookSnapshot(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      snapshot.source === "ADMIN" ? "SYSTEM" : snapshot.source,
      sourceWeight,
      snapshot.sequence,
      updatedAt,
      timeToBookMs
    );
    const domSnapshot = this.getLiquidityWalls(instrumentCode, updatedAt);

    this.engineState = {
      ...this.engineState,
      internalOrderBookDepth: countBookLevels(this.bids, this.asks),
      microstructure: this.engineState.microstructure,
      priceDiscovery: this.calculatePriceDiscovery(instrumentCode, updatedAt),
      dom: domSnapshot,
      heartbeatAt: updatedAt,
      updatedAt
    };

    if (options.persist !== false) {
      await this.safeStoragePut(
        {
          [ENGINE_STATE_KEY]: this.engineState,
          [DOM_WALL_HISTORY_KEY]: this.domWallHistory,
          [`${ORDER_BOOK_PREFIX}${marketKey}`]: book
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
        instrumentCode,
        exchangeCode,
        sequence: snapshot.sequence,
        bidLevels: bidBook.size,
        askLevels: askBook.size,
        tickSize,
        timeToBookMs
      });
      this.publish("ORDER_BOOK_SNAPSHOT_APPLIED", {
        instrumentCode,
        exchangeCode,
        sequence: snapshot.sequence,
        bidLevels: bidBook.size,
        askLevels: askBook.size,
        tickSize,
        timeToBookMs
      });
    }

    return book;
  }

  private async applyDelta(
    delta: BookDeltaWithTicker,
    updatedAt: string
  ): Promise<AppliedBookUpdate> {
    const instrumentCode = delta.instrumentCode.toLowerCase();
    const exchangeCode = delta.exchangeCode.toLowerCase();
    const sourceExchange = normalizeSourceExchange(delta.source_exchange ?? delta.exchangeCode);
    const marketKey = normalizeMarketKey(
      delta.marketKey ?? buildMarketKey(sourceExchange, instrumentCode)
    );
    const sourceWeight = normalizeSourceWeight(delta.sourceWeight);
    const tickSize = resolveTickSize(this.env, instrumentCode, delta.tickSize);
    const syncState = this.getBookSync(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      tickSize,
      delta.source,
      sourceWeight
    );
    const wasSnapshotSeeded = syncState.isSynced || syncState.lastSnapshotAt !== null;
    const expectedSequence =
      syncState.lastSequence === null ? undefined : syncState.lastSequence + 1;
    const timeToBookMs = calculateTimeToBookMs(delta.exchangeTimestamp, updatedAt);
    const enforceExactSequence = delta.source === "HYPERLIQUID";

    if (
      enforceExactSequence &&
      expectedSequence !== undefined &&
      delta.sequence > expectedSequence
    ) {
      await this.handleSequenceGap(delta, expectedSequence, timeToBookMs, updatedAt);
      return {
        accepted: false,
        reason: "SEQUENCE_GAP",
        expectedSequence,
        actualSequence: delta.sequence,
        timeToBookMs
      };
    }

    if (syncState.lastSequence !== null && delta.sequence <= syncState.lastSequence) {
      if (delta.source === "HYPERLIQUID" || delta.sequence % 100 === 0) {
        this.logger.warn("ORDER_BOOK_DELTA_IGNORED", "Ignored duplicate/out-of-order book delta", {
          instrumentCode,
          exchangeCode,
          currentSequence: syncState.lastSequence,
          deltaSequence: delta.sequence
        });
      }

      return {
        accepted: false,
        reason: "DUPLICATE_OR_OUT_OF_ORDER",
        expectedSequence,
        actualSequence: delta.sequence,
        timeToBookMs
      };
    }

    const bookSide =
      delta.side === "bid"
        ? getInstrumentBook(this.bids, marketKey, "bid")
        : getInstrumentBook(this.asks, marketKey, "ask");

    bookSide.upsert(delta.price, delta.size, updatedAt, tickSize);

    syncState.exchangeCode = exchangeCode;
    syncState.source_exchange = sourceExchange;
    syncState.sourceWeight = sourceWeight;
    syncState.lastSequence = delta.sequence;
    syncState.lastDeltaAt = updatedAt;
    syncState.desyncReason = wasSnapshotSeeded ? null : "AWAITING_SNAPSHOT";
    syncState.isSynced = wasSnapshotSeeded;
    syncState.tickSize = tickSize;
    syncState.ttbLatencyMs = timeToBookMs;

    const book = this.rebuildBookSnapshot(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      delta.source,
      sourceWeight,
      delta.sequence,
      updatedAt,
      timeToBookMs
    );

    if (isCrossedBook(book)) {
      await this.handleCrossedBook(delta, book, timeToBookMs, updatedAt);
      return {
        accepted: false,
        reason: "CROSSED_BOOK",
        expectedSequence,
        actualSequence: delta.sequence,
        timeToBookMs
      };
    }

    this.maybeCrossCheckTopOfBook(delta, book);

    return {
      accepted: true,
      book,
      actualSequence: delta.sequence,
      timeToBookMs
    };
  }

  private async handleSequenceGap(
    delta: OrderBookDelta,
    expectedSequence: number,
    timeToBookMs: number | null,
    observedAt: string
  ): Promise<void> {
    const instrumentCode = delta.instrumentCode.toLowerCase();
    const exchangeCode = delta.exchangeCode.toLowerCase();
    const sourceExchange = normalizeSourceExchange(delta.source_exchange ?? delta.exchangeCode);
    const marketKey = normalizeMarketKey(
      delta.marketKey ?? buildMarketKey(sourceExchange, instrumentCode)
    );
    const syncState = this.getBookSync(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      resolveTickSize(this.env, instrumentCode, delta.tickSize),
      delta.source,
      normalizeSourceWeight(delta.sourceWeight)
    );

    syncState.isSynced = false;
    syncState.desyncReason = "SEQUENCE_GAP";
    syncState.lastDesyncAt = observedAt;
    syncState.ttbLatencyMs = timeToBookMs;

    this.logger.error("ORDER_BOOK_DESYNC", "Sequence gap detected; purging local book", {
      instrumentCode,
      exchangeCode,
      expectedSequence,
      actualSequence: delta.sequence,
      lastSequence: syncState.lastSequence,
      timeToBookMs
    });
    this.publish("ORDER_BOOK_DESYNC", {
      instrumentCode,
      exchangeCode,
      expectedSequence,
      actualSequence: delta.sequence,
      lastSequence: syncState.lastSequence,
      timeToBookMs
    });

    await this.resetOrderBook({
      source: "SYSTEM",
      reason: "SEQUENCE_GAP",
      instrumentCode,
      source_exchange: sourceExchange,
      connectionId: null,
      blackoutDurationMs: null,
      recoveredAt: observedAt
    });
  }

  private async handleCrossedBook(
    delta: OrderBookDelta,
    book: InternalOrderBook,
    timeToBookMs: number | null,
    observedAt: string
  ): Promise<void> {
    const syncState = this.getBookSync(
      book.marketKey,
      book.instrumentCode,
      book.exchangeCode,
      book.source_exchange,
      book.tickSize,
      book.source,
      book.sourceWeight
    );

    syncState.isSynced = false;
    syncState.desyncReason = "CROSSED_BOOK";
    syncState.lastDesyncAt = observedAt;
    syncState.ttbLatencyMs = timeToBookMs;

    this.logger.error("ORDER_BOOK_CROSSED", "Crossed book detected; purging local book", {
      instrumentCode: book.instrumentCode,
      exchangeCode: book.exchangeCode,
      source_exchange: book.source_exchange,
      sequence: delta.sequence,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      spread: book.spread,
      timeToBookMs
    });
    this.publish("ORDER_BOOK_CROSSED", {
      instrumentCode: book.instrumentCode,
      exchangeCode: book.exchangeCode,
      source_exchange: book.source_exchange,
      sequence: delta.sequence,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      spread: book.spread,
      timeToBookMs
    });

    await this.resetOrderBook({
      source: "SYSTEM",
      reason: "CROSSED_BOOK",
      instrumentCode: book.instrumentCode,
      source_exchange: book.source_exchange,
      connectionId: null,
      blackoutDurationMs: null,
      recoveredAt: observedAt
    });
  }

  private async handleCrossedBookSnapshot(
    book: InternalOrderBook,
    sequence: number,
    timeToBookMs: number | null,
    observedAt: string
  ): Promise<void> {
    const syncState = this.getBookSync(
      book.marketKey,
      book.instrumentCode,
      book.exchangeCode,
      book.source_exchange,
      book.tickSize,
      book.source,
      book.sourceWeight
    );

    syncState.isSynced = false;
    syncState.desyncReason = "CROSSED_BOOK";
    syncState.lastDesyncAt = observedAt;
    syncState.ttbLatencyMs = timeToBookMs;

    this.logger.error("ORDER_BOOK_CROSSED", "Crossed snapshot detected; purging local book", {
      instrumentCode: book.instrumentCode,
      exchangeCode: book.exchangeCode,
      source_exchange: book.source_exchange,
      sequence,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      spread: book.spread,
      timeToBookMs
    });
    this.publish("ORDER_BOOK_CROSSED", {
      instrumentCode: book.instrumentCode,
      exchangeCode: book.exchangeCode,
      source_exchange: book.source_exchange,
      sequence,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      spread: book.spread,
      timeToBookMs
    });

    await this.resetOrderBook({
      source: "SYSTEM",
      reason: "CROSSED_BOOK",
      instrumentCode: book.instrumentCode,
      source_exchange: book.source_exchange,
      connectionId: null,
      blackoutDurationMs: null,
      recoveredAt: observedAt
    });
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
    const bidBook = getInstrumentBook(this.bids, marketKey, "bid");
    const askBook = getInstrumentBook(this.asks, marketKey, "ask");
    const existingSync = this.bookSync.get(marketKey);
    const syncState = this.getBookSync(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      existingSync?.tickSize ?? resolveTickSize(this.env, instrumentCode),
      source,
      sourceWeight
    );
    const bids = bidBook.top(BOOK_SNAPSHOT_TOP_LEVELS);
    const asks = askBook.top(BOOK_SNAPSHOT_TOP_LEVELS);
    const microstructure = this.calculateMicrostructure(
      marketKey,
      instrumentCode,
      exchangeCode,
      sourceExchange,
      sourceWeight,
      bids,
      asks,
      updatedAt,
      sequence,
      timeToBookMs,
      syncState.isSynced
    );
    const book: InternalOrderBook = {
      marketKey,
      source,
      source_exchange: sourceExchange,
      sourceWeight,
      instrumentCode,
      exchangeCode,
      bids,
      asks,
      bestBid: microstructure.bestBid,
      bestAsk: microstructure.bestAsk,
      midPrice: microstructure.midPrice,
      spread: microstructure.spread,
      spreadBps: microstructure.spreadBps,
      weightedImbalance: microstructure.weightedImbalance,
      lastSequence: sequence,
      tickSize: syncState.tickSize,
      ttbLatencyMs: timeToBookMs,
      isSynced: syncState.isSynced,
      desyncReason: syncState.desyncReason,
      sequence,
      updatedAt
    };

    this.orderBook.set(marketKey, book);
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
    if (target && typeof target !== "string") {
      const marketKey = buildMarketKey(target.source_exchange, target.instrumentCode);
      return { marketKey, instrumentCode: target.instrumentCode.toLowerCase() };
    }

    const requested = target?.trim().toLowerCase();

    if (!requested) {
      const currentKey = this.engineState.microstructure.marketKey;
      const currentBook = currentKey ? this.orderBook.get(currentKey) : undefined;

      if (currentBook) {
        return {
          marketKey: currentBook.marketKey,
          instrumentCode: currentBook.instrumentCode
        };
      }

      const currentInstrument = this.engineState.microstructure.instrumentCode;
      const currentAssetBook = currentInstrument
        ? this.findBestAssetBook(currentInstrument)
        : undefined;

      if (currentAssetBook) {
        return {
          marketKey: currentAssetBook.marketKey,
          instrumentCode: currentAssetBook.instrumentCode
        };
      }
    }

    if (requested && this.orderBook.has(requested)) {
      const book = this.orderBook.get(requested);
      return {
        marketKey: requested,
        instrumentCode: book?.instrumentCode ?? requested.split(":").slice(1).join(":")
      };
    }

    const instrumentCode = requested ? normalizeInstrumentSelector(requested) : undefined;
    const candidates = [...this.orderBook.values()]
      .filter((book) => !instrumentCode || book.instrumentCode === instrumentCode)
      .sort((left, right) => {
        const weightDelta = right.sourceWeight - left.sourceWeight;

        if (weightDelta !== 0) {
          return weightDelta;
        }

        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      });
    const selected = candidates[0];

    return selected
      ? { marketKey: selected.marketKey, instrumentCode: selected.instrumentCode }
      : null;
  }

  private calculatePriceDiscovery(
    instrumentCode: string | null | undefined,
    observedAt: string
  ): PriceDiscoveryMetrics {
    const normalizedInstrument = instrumentCode?.toLowerCase() ?? null;
    const sources = [...this.orderBook.values()]
      .filter(
        (book) =>
          (!normalizedInstrument || book.instrumentCode === normalizedInstrument) &&
          book.midPrice !== null
      )
      .map((book) => ({
        marketKey: book.marketKey,
        source: book.source,
        source_exchange: book.source_exchange,
        exchangeCode: book.exchangeCode,
        instrumentCode: book.instrumentCode,
        weight: book.sourceWeight,
        midPrice: book.midPrice,
        spreadBps: book.spreadBps,
        weightedImbalance: book.weightedImbalance,
        updatedAt: book.updatedAt
      }));
    const totalWeight = sources.reduce((sum, source) => sum + source.weight, 0);
    const weightedMidPrice =
      totalWeight > 0
        ? roundCrypto(
            sources.reduce((sum, source) => sum + (source.midPrice ?? 0) * source.weight, 0) /
              totalWeight
          )
        : null;
    const primary = [...sources].sort((left, right) => right.weight - left.weight)[0];

    return {
      instrumentCode: normalizedInstrument,
      weightedMidPrice,
      primaryExchange: primary?.source_exchange ?? null,
      primaryWeight: primary?.weight ?? 0,
      sourceCount: sources.length,
      sources,
      updatedAt: sources.length > 0 ? observedAt : null
    };
  }

  private currentBookSnapshot(
    instrumentCode: string | undefined,
    depth: number
  ): BookSnapshotResponse {
    const selected = this.selectMarketKey(instrumentCode);
    const normalizedInstrument =
      selected?.instrumentCode ??
      (instrumentCode ? normalizeInstrumentSelector(instrumentCode) : null) ??
      this.engineState.microstructure.instrumentCode ??
      selected?.marketKey ??
      "unknown";
    const marketKey = selected?.marketKey ?? normalizeMarketKey(normalizedInstrument);
    const book = this.orderBook.get(marketKey);
    const bidBook = getInstrumentBook(this.bids, marketKey, "bid");
    const askBook = getInstrumentBook(this.asks, marketKey, "ask");
    const syncState = this.getBookSync(
      marketKey,
      normalizedInstrument,
      book?.exchangeCode ?? this.engineState.microstructure.exchangeCode ?? null,
      book?.source_exchange ?? this.engineState.microstructure.source_exchange ?? "unknown",
      book?.tickSize ?? resolveTickSize(this.env, normalizedInstrument),
      book?.source ?? "SYSTEM",
      book?.sourceWeight ?? DEFAULT_SOURCE_WEIGHT
    );

    return {
      marketKey,
      instrumentCode: normalizedInstrument,
      exchangeCode: book?.exchangeCode ?? syncState.exchangeCode,
      source_exchange: book?.source_exchange ?? syncState.source_exchange,
      sourceWeight: book?.sourceWeight ?? syncState.sourceWeight,
      sequence: syncState.lastSequence,
      isSynced: syncState.isSynced,
      desyncReason: syncState.desyncReason,
      tickSize: syncState.tickSize,
      ttbLatencyMs: syncState.ttbLatencyMs,
      topLevelCount: depth,
      bestBid: book?.bestBid ?? null,
      bestAsk: book?.bestAsk ?? null,
      midPrice: book?.midPrice ?? null,
      spread: book?.spread ?? null,
      weightedImbalance: book?.weightedImbalance ?? null,
      bids: bidBook.top(depth),
      asks: askBook.top(depth),
      updatedAt: book?.updatedAt ?? null
    };
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
    const existing = this.bookSync.get(marketKey);

    if (existing) {
      existing.exchangeCode = exchangeCode ?? existing.exchangeCode;
      existing.source_exchange = sourceExchange || existing.source_exchange;
      existing.tickSize = tickSize;
      existing.sourceWeight = sourceWeight;
      return existing;
    }

    const created: BookSyncState = {
      marketKey,
      source,
      source_exchange: sourceExchange,
      sourceWeight,
      instrumentCode,
      exchangeCode,
      lastSequence: null,
      lastSnapshotAt: null,
      lastDeltaAt: null,
      lastDesyncAt: null,
      desyncReason: null,
      isSynced: false,
      tickSize,
      ttbLatencyMs: null,
      lastCrossCheckAt: 0
    };

    this.bookSync.set(marketKey, created);
    return created;
  }

  private maybeCrossCheckTopOfBook(delta: BookDeltaWithTicker, book: InternalOrderBook): void {
    const syncState = this.getBookSync(
      book.marketKey,
      delta.instrumentCode.toLowerCase(),
      delta.exchangeCode.toLowerCase(),
      book.source_exchange,
      book.tickSize,
      book.source,
      book.sourceWeight
    );
    const now = Date.now();

    if (now - syncState.lastCrossCheckAt < TOP_OF_BOOK_CROSS_CHECK_INTERVAL_MS) {
      return;
    }

    syncState.lastCrossCheckAt = now;

    const rawBestBid = typeof delta.bestBid === "number" ? delta.bestBid : null;
    const rawBestAsk = typeof delta.bestAsk === "number" ? delta.bestAsk : null;
    const bidMismatch =
      rawBestBid !== null &&
      book.bestBid !== null &&
      Math.abs(rawBestBid - book.bestBid) > book.tickSize;
    const askMismatch =
      rawBestAsk !== null &&
      book.bestAsk !== null &&
      Math.abs(rawBestAsk - book.bestAsk) > book.tickSize;

    if (!bidMismatch && !askMismatch) {
      this.publish("ORDER_BOOK_CROSS_CHECK", {
        instrumentCode: book.instrumentCode,
        exchangeCode: book.exchangeCode,
        sequence: book.sequence,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        rawBestBid,
        rawBestAsk,
        status: "MATCH"
      });
      return;
    }

    syncState.isSynced = false;
    syncState.desyncReason = "TOP_OF_BOOK_MISMATCH";
    syncState.lastDesyncAt = new Date().toISOString();

    this.logger.error("ORDER_BOOK_CROSS_CHECK_FAILED", "Top-of-book mismatch detected", {
      instrumentCode: book.instrumentCode,
      exchangeCode: book.exchangeCode,
      sequence: book.sequence,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      rawBestBid,
      rawBestAsk,
      tickSize: book.tickSize
    });
    this.publish("ORDER_BOOK_CROSS_CHECK_FAILED", {
      instrumentCode: book.instrumentCode,
      exchangeCode: book.exchangeCode,
      sequence: book.sequence,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      rawBestBid,
      rawBestAsk,
      tickSize: book.tickSize
    });
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

    const prunedTelemetryCount = await this.pruneTelemetryLogs();
    const report = {
      ...baseReport,
      orphanExchangeOrders,
      reconciledOrders,
      cancelledOrders: [...new Set(cancelledOrders)],
      dustCloseIntents,
      prunedTelemetryCount
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
        prunedTelemetryCount: report.prunedTelemetryCount
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

  private async pruneTelemetryLogs(): Promise<number> {
    const retentionDays = readPositiveInteger(this.env.JANITOR_LOG_RETENTION_DAYS, 7, 1, 3650);
    const maxTelemetryRows = readPositiveInteger(
      this.env.JANITOR_TELEMETRY_MAX_ROWS,
      50_000,
      1_000,
      1_000_000
    );
    const maxMarketTickRows = readPositiveInteger(
      this.env.MARKET_TICK_MAX_ROWS,
      DEFAULT_MARKET_TICK_MAX_ROWS,
      1_000,
      1_000_000
    );
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

    try {
      const retentionResult = await this.env.TRADING_DB.prepare(
        `DELETE FROM logs
         WHERE event_type = 'TELEMETRY'
           AND created_at < ?`
      )
        .bind(cutoff)
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
        .bind(maxTelemetryRows)
        .run();
      const tickRetentionResult = await this.env.TRADING_DB.prepare(
        `DELETE FROM market_ticks
         WHERE received_at < ?`
      )
        .bind(cutoff)
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
        .bind(maxMarketTickRows)
        .run();
      return (
        Number(retentionResult.meta?.changes ?? 0) +
        Number(capResult.meta?.changes ?? 0) +
        Number(tickRetentionResult.meta?.changes ?? 0) +
        Number(tickCapResult.meta?.changes ?? 0)
      );
    } catch (error) {
      this.logger.error("JANITOR_LOG_PRUNE_FAILED", "Failed to prune old telemetry logs", {
        cutoff,
        maxTelemetryRows,
        maxMarketTickRows,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
      return 0;
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
    const sourceTicks = await this.loadReplayTicks(limit, dateFrom, dateTo);
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
        ? await this.loadReplayTrades(ticks[0].receivedAt, ticks.at(-1)!.receivedAt)
        : [];
    const shadowTrades = this.markHistoricalTrades(historicalTrades, ticks);
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
    await this.recordBacktestRun(result, replayOptions, dateFrom, dateTo);
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
        [...this.profilerAgents.entries()].map(
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
    let status: ReplayStatus | undefined;
    try {
      status = await this.state.storage.get<ReplayStatus>(REPLAY_STATUS_KEY);
    } catch (error) {
      this.handleStorageWriteFailure("REPLAY_STATUS_READ", error);
    }

    return (
      status ?? {
        replayId: null,
        status: "IDLE",
        ticksTotal: 0,
        ticksProcessed: 0,
        progressPct: 0,
        speedMultiplier: 1,
        shadowBankroll: 0,
        dateFrom: null,
        dateTo: null,
        scenario: "BASELINE",
        error: null,
        startedAt: null,
        updatedAt: new Date().toISOString(),
        completedAt: null
      }
    );
  }

  private async writeReplayStatus(status: ReplayStatus): Promise<void> {
    await this.safeStoragePut(REPLAY_STATUS_KEY, status, "REPLAY_STATUS");
    this.publish("REPLAY_PROGRESS", {
      replayId: status.replayId,
      status: status.status,
      ticksTotal: status.ticksTotal,
      ticksProcessed: status.ticksProcessed,
      progressPct: status.progressPct,
      speedMultiplier: status.speedMultiplier,
      dateFrom: status.dateFrom,
      dateTo: status.dateTo,
      scenario: status.scenario ?? "BASELINE",
      error: status.error,
      updatedAt: status.updatedAt,
      completedAt: status.completedAt
    });
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

  private async loadReplayTicks(
    limit: number,
    dateFrom: string | null,
    dateTo: string | null
  ): Promise<MarketTick[]> {
    try {
      const where: string[] = [];
      const binds: Array<string | number> = [];

      if (dateFrom) {
        where.push("received_at >= ?");
        binds.push(dateFrom);
      }
      if (dateTo) {
        where.push("received_at <= ?");
        binds.push(dateTo);
      }

      binds.push(limit);
      const rows = await this.env.TRADING_DB.prepare(
        `SELECT tick_json, received_at
         FROM market_ticks
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY received_at ASC
         LIMIT ?`
      )
        .bind(...binds)
        .all<ReplayTickRow>();

      return (rows.results ?? [])
        .map((row) => safeParseJson<MarketTick>(row.tick_json))
        .filter((tick): tick is MarketTick => tick?.schemaVersion === "universal-tick.v1");
    } catch (error) {
      this.logger.warn(
        "REPLAY_TICK_JOURNAL_UNAVAILABLE",
        "Falling back to telemetry logs for replay",
        {
          error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
        }
      );
      const where = ["telemetry_json LIKE '%\"tick\"%'"];
      const binds: Array<string | number> = [];

      if (dateFrom) {
        where.push("created_at >= ?");
        binds.push(dateFrom);
      }
      if (dateTo) {
        where.push("created_at <= ?");
        binds.push(dateTo);
      }

      binds.push(limit);
      const rows = await this.env.TRADING_DB.prepare(
        `SELECT telemetry_json, created_at
         FROM logs
         WHERE ${where.join(" AND ")}
         ORDER BY created_at ASC
         LIMIT ?`
      )
        .bind(...binds)
        .all<{ telemetry_json: string; created_at: string }>();

      return (rows.results ?? [])
        .map((row) => safeParseJson<{ tick?: MarketTick }>(row.telemetry_json)?.tick ?? null)
        .filter((tick): tick is MarketTick => tick?.schemaVersion === "universal-tick.v1");
    }
  }

  private async loadReplayTrades(
    startedAt: string | null,
    completedAt: string | null
  ): Promise<ReplayTradeRow[]> {
    const where = ["status IN ('FILLED', 'PARTIAL')"];
    const binds: string[] = [];

    if (startedAt) {
      where.push("executed_at >= ?");
      binds.push(startedAt);
    }
    if (completedAt) {
      where.push("executed_at <= ?");
      binds.push(completedAt);
    }

    const rows = await this.env.TRADING_DB.prepare(
      `SELECT trade_id, asset, side, price, size, executed_at, status
       FROM trades
       WHERE ${where.join(" AND ")}
       ORDER BY executed_at ASC
       LIMIT 5000`
    )
      .bind(...binds)
      .all<ReplayTradeRow>();

    return (rows.results ?? []).filter((row) => row.side === "BUY" || row.side === "SELL");
  }

  private markHistoricalTrades(
    historicalTrades: ReplayTradeRow[],
    ticks: MarketTick[]
  ): ReplayResult["shadowTrades"] {
    return historicalTrades.map((trade) => {
      const exitTick = ticks.find(
        (tick) =>
          tick.instrumentCode === trade.asset.toLowerCase() &&
          Date.parse(tick.receivedAt) > Date.parse(trade.executed_at)
      );
      const exitPrice = exitTick?.price ?? null;
      const theoreticalPnl =
        exitPrice === null
          ? 0
          : (trade.side === "BUY" ? 1 : -1) * (exitPrice - trade.price) * trade.size;

      return {
        tradeId: `shadow:${trade.trade_id}`,
        instrumentCode: trade.asset.toLowerCase(),
        side: trade.side,
        entryPrice: trade.price,
        exitPrice,
        size: trade.size,
        theoreticalPnl,
        openedAt: trade.executed_at,
        closedAt: exitTick?.receivedAt ?? null
      };
    });
  }

  private async recordBacktestRun(
    result: ReplayResult,
    options: ReplayOptions,
    dateFrom: string | null,
    dateTo: string | null
  ): Promise<void> {
    try {
      await this.env.TRADING_DB.prepare(
        `INSERT INTO backtest_runs (
           run_id, strategy_version_id, scenario, asset_filter, date_from, date_to,
           ticks_replayed, generated_intent_count, simulated_trade_count,
           theoretical_pnl, max_drawdown, sharpe, win_rate,
           latency_model_json, slippage_model_json, fee_model_json,
           attribution_json, stress_json, ablation_json, created_by, started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          result.replayId,
          options.strategyVersionId,
          options.scenario,
          null,
          dateFrom,
          dateTo,
          result.ticksReplayed,
          result.generatedIntentCount,
          result.simulatedTradeCount ?? 0,
          result.theoreticalPnl,
          result.maxDrawdown ?? 0,
          result.sharpe,
          result.winRate,
          JSON.stringify(result.latencyModel ?? {}),
          JSON.stringify(result.slippageModel ?? {}),
          JSON.stringify(result.feeModel ?? {}),
          JSON.stringify(result.attribution ?? {}),
          JSON.stringify(result.stressResults ?? []),
          JSON.stringify(result.ablation ?? {}),
          options.actor,
          result.startedAt,
          result.completedAt
        )
        .run();
    } catch (error) {
      this.logger.warn(
        "BACKTEST_RUN_JOURNAL_FAILED",
        "Replay completed but D1 backtest journal failed",
        {
          replayId: result.replayId,
          error: error instanceof Error ? error.message : "UNKNOWN_D1_ERROR"
        }
      );
    }
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
    const message: BusMessage = {
      type,
      sequence: this.nextBusSequence(),
      emittedAt: new Date().toISOString(),
      payload
    };

    this.broadcast(message);
    if (type === "TICK_TELEMETRY") {
      this.accumulateTickTelemetry(payload, message.emittedAt);
      this.scheduleTelemetryFlush();
      return;
    }

    if (shouldAggregateBusTelemetry(type)) {
      this.accumulateEventTelemetry(type, payload, message.emittedAt, correlationId ?? null);
      this.scheduleTelemetryFlush();
      return;
    }

    this.queueTelemetry({
      telemetryType: type,
      message: `Telemetry event: ${type}`,
      correlationId: correlationId ?? null,
      payload: {
        ...payload,
        busSequence: message.sequence,
        emittedAt: message.emittedAt
      },
      createdAt: message.emittedAt
    });
  }

  private accumulateEventTelemetry(
    type: string,
    payload: Record<string, unknown>,
    emittedAt: string,
    correlationId: string | null
  ): void {
    const current = this.eventTelemetryAggregates.get(type);

    if (!current) {
      this.eventTelemetryAggregates.set(type, {
        telemetryType: type,
        count: 1,
        firstObservedAt: emittedAt,
        lastObservedAt: emittedAt,
        latestPayload: payload,
        latestCorrelationId: correlationId
      });
      return;
    }

    current.count += 1;
    current.lastObservedAt = emittedAt;
    current.latestPayload = payload;
    current.latestCorrelationId = correlationId;
  }

  private consumeEventTelemetryAggregates(): TelemetryLogEntry[] {
    const entries: TelemetryLogEntry[] = [];

    for (const aggregate of this.eventTelemetryAggregates.values()) {
      entries.push({
        telemetryType: `${aggregate.telemetryType}_AGGREGATE`,
        message: `Aggregated ${aggregate.telemetryType} telemetry`,
        correlationId:
          aggregate.latestCorrelationId ??
          `${aggregate.telemetryType.toLowerCase()}:${aggregate.firstObservedAt}`,
        createdAt: aggregate.lastObservedAt,
        payload: {
          telemetryType: aggregate.telemetryType,
          count: aggregate.count,
          firstObservedAt: aggregate.firstObservedAt,
          lastObservedAt: aggregate.lastObservedAt,
          latestPayload: aggregate.latestPayload,
          flushIntervalMs: this.telemetryFlushIntervalMs()
        }
      });
    }

    this.eventTelemetryAggregates.clear();
    return entries;
  }

  private accumulateTickTelemetry(payload: Record<string, unknown>, emittedAt: string): void {
    const cpuTimeMs = readTelemetryNumber(payload.cpuTimeMs);
    const totalLatencyMs = readTelemetryNumber(payload.totalLatencyMs);
    const websocketLatencyMs = readTelemetryNumber(payload.websocketLatencyMs);
    const processingLatencyMs = readTelemetryNumber(payload.processingLatencyMs);
    const timeToBookMs = readTelemetryNumber(payload.timeToBookMs);
    const status =
      typeof payload.status === "string" && payload.status.length > 0 ? payload.status : null;

    const current = this.tickTelemetryAggregate ?? {
      count: 0,
      freshCount: 0,
      staleCount: 0,
      firstObservedAt: emittedAt,
      lastObservedAt: emittedAt,
      latestInstrumentCode: null,
      latestExchangeCode: null,
      latestSequence: null,
      latestStatus: null,
      latestColo: null,
      latestPlacement: null,
      latestIsGoldenRegion: null,
      latestLatencyRiskMultiplier: null,
      sumCpuTimeMs: 0,
      sumTotalLatencyMs: 0,
      sumWebsocketLatencyMs: 0,
      sumProcessingLatencyMs: 0,
      sumTimeToBookMs: 0,
      timeToBookSamples: 0,
      maxTotalLatencyMs: 0,
      maxWebsocketLatencyMs: 0,
      maxProcessingLatencyMs: 0,
      maxTimeToBookMs: null,
      latestAverageLatencyMs: null,
      latestOrderBookDepth: null,
      latestToxicityScore: null,
      latestJitterMs: null,
      latestExecutionStatus: null,
      latestWeightedImbalance: null,
      latestMidPrice: null
    };

    current.count += 1;
    current.freshCount += status === "FRESH" ? 1 : 0;
    current.staleCount += status === "STALE" ? 1 : 0;
    current.lastObservedAt = emittedAt;
    current.latestInstrumentCode =
      typeof payload.instrumentCode === "string"
        ? payload.instrumentCode
        : current.latestInstrumentCode;
    current.latestExchangeCode =
      typeof payload.exchangeCode === "string" ? payload.exchangeCode : current.latestExchangeCode;
    current.latestSequence =
      typeof payload.sequence === "number" && Number.isFinite(payload.sequence)
        ? payload.sequence
        : current.latestSequence;
    current.latestStatus = status ?? current.latestStatus;
    current.latestColo = typeof payload.colo === "string" ? payload.colo : current.latestColo;
    current.latestPlacement =
      typeof payload.placement === "string" ? payload.placement : current.latestPlacement;
    current.latestIsGoldenRegion =
      typeof payload.isGoldenRegion === "boolean"
        ? payload.isGoldenRegion
        : current.latestIsGoldenRegion;
    current.latestLatencyRiskMultiplier =
      readTelemetryNumber(payload.latencyRiskMultiplier) ?? current.latestLatencyRiskMultiplier;

    if (cpuTimeMs !== null) {
      current.sumCpuTimeMs += cpuTimeMs;
    }
    if (totalLatencyMs !== null) {
      current.sumTotalLatencyMs += totalLatencyMs;
      current.maxTotalLatencyMs = Math.max(current.maxTotalLatencyMs, totalLatencyMs);
    }
    if (websocketLatencyMs !== null) {
      current.sumWebsocketLatencyMs += websocketLatencyMs;
      current.maxWebsocketLatencyMs = Math.max(current.maxWebsocketLatencyMs, websocketLatencyMs);
    }
    if (processingLatencyMs !== null) {
      current.sumProcessingLatencyMs += processingLatencyMs;
      current.maxProcessingLatencyMs = Math.max(
        current.maxProcessingLatencyMs,
        processingLatencyMs
      );
    }
    if (timeToBookMs !== null) {
      current.sumTimeToBookMs += timeToBookMs;
      current.timeToBookSamples += 1;
      current.maxTimeToBookMs =
        current.maxTimeToBookMs === null
          ? timeToBookMs
          : Math.max(current.maxTimeToBookMs, timeToBookMs);
    }

    current.latestAverageLatencyMs = readTelemetryNumber(payload.averageLatencyMs);
    current.latestOrderBookDepth = readTelemetryNumber(payload.orderBookDepth);
    current.latestToxicityScore = readTelemetryNumber(payload.toxicityScore);
    current.latestJitterMs = readTelemetryNumber(payload.jitterMs);
    current.latestExecutionStatus =
      typeof payload.executionStatus === "string"
        ? payload.executionStatus
        : current.latestExecutionStatus;
    current.latestWeightedImbalance = readTelemetryNumber(payload.weightedImbalance);
    current.latestMidPrice = readTelemetryNumber(payload.midPrice);

    this.tickTelemetryAggregate = current;
  }

  private consumeTickTelemetryAggregate(): TelemetryLogEntry | null {
    const aggregate = this.tickTelemetryAggregate;
    this.tickTelemetryAggregate = null;

    if (!aggregate || aggregate.count === 0) {
      return null;
    }

    const average = (sum: number): number => roundLatency(sum / aggregate.count);

    return {
      telemetryType: "TICK_TELEMETRY_AGGREGATE",
      message: "Aggregated tick telemetry",
      correlationId: `tick-telemetry:${aggregate.firstObservedAt}`,
      createdAt: aggregate.lastObservedAt,
      payload: {
        ...aggregate,
        averageCpuTimeMs: average(aggregate.sumCpuTimeMs),
        averageTotalLatencyMs: average(aggregate.sumTotalLatencyMs),
        averageWebsocketLatencyMs: average(aggregate.sumWebsocketLatencyMs),
        averageProcessingLatencyMs: average(aggregate.sumProcessingLatencyMs),
        averageTimeToBookMs:
          aggregate.timeToBookSamples > 0
            ? roundLatency(aggregate.sumTimeToBookMs / aggregate.timeToBookSamples)
            : null,
        flushIntervalMs: this.telemetryFlushIntervalMs()
      }
    };
  }

  private broadcast(message: unknown): void {
    for (const socket of this.adminSockets) {
      this.sendSocketMessage(socket, message);
    }
  }

  private sendSocketMessage(socket: WebSocket, message: unknown): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      this.adminSockets.delete(socket);
      try {
        socket.close(1011, "TELEMETRY_SEND_FAILED");
      } catch {
        // Closing is best-effort; the runtime will collect dead sockets.
      }
    }
  }

  private queueTelemetry(entry: TelemetryLogEntry): void {
    this.telemetryBuffer.push(entry);

    if (this.telemetryBuffer.length > TELEMETRY_BUFFER_LIMIT) {
      this.telemetryBuffer.splice(0, this.telemetryBuffer.length - TELEMETRY_BUFFER_LIMIT);
    }

    this.scheduleTelemetryFlush();
  }

  private telemetryFlushIntervalMs(): number {
    return readPositiveInteger(
      this.env.TELEMETRY_FLUSH_INTERVAL_MS,
      DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS,
      1_000,
      300_000
    );
  }

  private scheduleTelemetryFlush(): void {
    if (this.telemetryFlushScheduled) {
      return;
    }

    this.telemetryFlushScheduled = true;
    const flush = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.flushTelemetryBatch()
          .then(resolve)
          .catch((error) => {
            console.error(
              "[Sovereign-Sigma] telemetry flush failed",
              error instanceof Error ? error.message : error
            );
            resolve();
          });
      }, this.telemetryFlushIntervalMs());
    });

    this.state.waitUntil(flush);
  }

  private async flushTelemetryBatch(): Promise<void> {
    const tickAggregate = this.consumeTickTelemetryAggregate();
    const eventAggregates = this.consumeEventTelemetryAggregates();
    const batch = [
      ...(tickAggregate ? [tickAggregate] : []),
      ...eventAggregates,
      ...this.telemetryBuffer.splice(0)
    ];
    this.telemetryFlushScheduled = false;

    if (batch.length === 0) {
      return;
    }

    const statements = batch.map((entry) =>
      this.env.TRADING_DB.prepare(
        `INSERT INTO logs
          (level, event_type, source, message, correlation_id, telemetry_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        "INFO",
        "TELEMETRY",
        "TradingEngine",
        entry.message,
        entry.correlationId,
        JSON.stringify(
          toJsonValue({
            telemetryType: entry.telemetryType,
            ...entry.payload
          })
        ),
        entry.createdAt
      )
    );

    try {
      await this.env.TRADING_DB.batch(statements);
    } catch (error) {
      console.error(
        "[Sovereign-Sigma] failed to write telemetry batch",
        error instanceof Error ? error.message : error
      );
    }

    if (
      this.telemetryBuffer.length > 0 ||
      this.tickTelemetryAggregate !== null ||
      this.eventTelemetryAggregates.size > 0
    ) {
      this.scheduleTelemetryFlush();
    }
  }

  private nextBusSequence(): number {
    this.busSequence += 1;
    return this.busSequence;
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

function isNativeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeObject(value: unknown): Record<string, unknown> | null {
  return isNativeRecord(value) ? value : null;
}

function nativeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function requireNativeString(value: unknown, field: string): string {
  const parsed = nativeString(value);

  if (!parsed) {
    throw new Error(`MISSING_HYPERLIQUID_${field.toUpperCase()}`);
  }

  return parsed;
}

function nativeIso(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function nativeExchangeTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(epochMillis(value)).toISOString();
  }

  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    const numeric = Number(trimmed);

    if (Number.isFinite(numeric)) {
      return new Date(epochMillis(numeric)).toISOString();
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  return null;
}

function epochMillis(value: number): number {
  return value > 1_000_000_000_000 ? value : value * 1_000;
}

function nativeSequence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (Number.isSafeInteger(parsed) && parsed >= 0) {
    return parsed;
  }

  return nativeHashSequence(String(value ?? Date.now()));
}

function nativeHashSequence(value: string): number {
  let hash = 2_166_136_261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

function hyperliquidNativeInstrumentCode(coin: string, fallback?: string | null): string {
  const fallbackCode =
    typeof fallback === "string" && fallback.trim() !== ""
      ? normalizeNativeInstrumentCode(fallback)
      : null;
  const normalizedCoin = normalizeNativeCoin(coin);

  if (fallbackCode) {
    const [fallbackBase] = splitNativeInstrument(fallbackCode).baseAsset.split("-");
    const coinBase = normalizedCoin.toLowerCase();

    if (fallbackCode.includes(coinBase) || fallbackBase === coinBase) {
      return fallbackCode;
    }
  }

  return `${normalizedCoin.toLowerCase()}-usd`;
}

function normalizeNativeCoin(value: string): string {
  return value
    .trim()
    .replace(/-perp$/i, "")
    .replace(/-usd$/i, "")
    .replace(/-usdc$/i, "")
    .replace(/-usdt$/i, "")
    .toUpperCase();
}

function normalizeNativeInstrumentCode(value: string): string {
  return value
    .trim()
    .replace(/_/g, "-")
    .replace(/\//g, "-")
    .replace(/-perp$/i, "")
    .toLowerCase();
}

function normalizeInstrumentSelector(value: string): string {
  const rawInstrument = value.includes(":") ? value.split(":").slice(1).join(":") : value;
  const normalized = normalizeNativeInstrumentCode(rawInstrument);

  if (!normalized.includes("-")) {
    return `${normalizeNativeCoin(normalized).toLowerCase()}-usd`;
  }

  return normalized;
}

function splitNativeInstrument(instrumentCode: string): {
  baseAsset: string;
  quoteAsset: string;
} {
  const normalized = normalizeNativeInstrumentCode(instrumentCode);
  const [baseAsset, ...quoteParts] = normalized.split("-");

  return {
    baseAsset: baseAsset || "unknown",
    quoteAsset: quoteParts.join("-") || "usd"
  };
}

function baseAssetFromInstrument(instrumentCode: string): string {
  return splitNativeInstrument(instrumentCode).baseAsset.toUpperCase();
}

function cascadeInstrumentSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((asset) => asset.trim().toUpperCase())
      .filter((asset) => /^[A-Z0-9]{2,12}$/.test(asset))
  );
}

function latestAbsorptionForInstrument(
  absorptions: ReadonlyMap<string, AbsorptionConfirmed>,
  instrumentCode: string
): AbsorptionConfirmed | null {
  let selected: AbsorptionConfirmed | null = null;
  for (const absorption of absorptions.values()) {
    if (absorption.instrumentCode !== instrumentCode.toLowerCase()) {
      continue;
    }
    if (!selected || Date.parse(absorption.confirmedAt) > Date.parse(selected.confirmedAt)) {
      selected = absorption;
    }
  }
  return selected;
}

function latestCascadeAtForInstrument(
  cascades: ReadonlyMap<string, CascadeEvent>,
  currentCascade: CascadeEvent
): string | null {
  let selected: string | null = null;
  for (const cascade of cascades.values()) {
    if (
      cascade.cascadeId === currentCascade.cascadeId ||
      cascade.instrumentCode !== currentCascade.instrumentCode
    ) {
      continue;
    }
    if (!selected || Date.parse(cascade.detectedAt) > Date.parse(selected)) {
      selected = cascade.detectedAt;
    }
  }
  return selected;
}

function isOpenCascadePosition(position: CascadeOpenPosition): boolean {
  return (
    position.remainingSize > 0 &&
    position.status !== "CLOSED" &&
    position.status !== "STOPPED_OUT" &&
    position.status !== "TIME_STOPPED"
  );
}

function recentSwingLow(candles: readonly { low: number }[]): number | null {
  if (candles.length === 0) {
    return null;
  }
  let low = Number.POSITIVE_INFINITY;
  for (const candle of candles.slice(-20)) {
    low = Math.min(low, candle.low);
  }
  return Number.isFinite(low) ? low : null;
}

function recentSwingHigh(candles: readonly { high: number }[]): number | null {
  if (candles.length === 0) {
    return null;
  }
  let high = Number.NEGATIVE_INFINITY;
  for (const candle of candles.slice(-20)) {
    high = Math.max(high, candle.high);
  }
  return Number.isFinite(high) ? high : null;
}

function parseHyperliquidNativeLevels(
  levels: unknown,
  receivedAt: string
): [OrderBookSnapshotLevel[], OrderBookSnapshotLevel[]] {
  if (Array.isArray(levels)) {
    return [
      nativeBookSideLevels(levels[0], receivedAt),
      nativeBookSideLevels(levels[1], receivedAt)
    ];
  }

  if (isNativeRecord(levels)) {
    return [
      nativeBookSideLevels(levels.bids ?? levels.bid, receivedAt),
      nativeBookSideLevels(levels.asks ?? levels.ask, receivedAt)
    ];
  }

  return [[], []];
}

function nativeBookSideLevels(value: unknown, receivedAt: string): OrderBookSnapshotLevel[] {
  const rawLevels = Array.isArray(value)
    ? value
    : isNativeRecord(value) && Array.isArray(value.levels)
      ? value.levels
      : [];
  const levels: OrderBookSnapshotLevel[] = [];

  for (const rawLevel of rawLevels) {
    let price: number | null = null;
    let size: number | null = null;

    if (Array.isArray(rawLevel)) {
      price = nativeNumber(rawLevel[0]);
      size = nativeNumber(rawLevel[1]);
    } else if (isNativeRecord(rawLevel)) {
      price = nativeNumber(rawLevel.px ?? rawLevel.price ?? rawLevel.p);
      size = nativeNumber(rawLevel.sz ?? rawLevel.size ?? rawLevel.s);
    }

    if (
      price !== null &&
      size !== null &&
      Number.isFinite(price) &&
      Number.isFinite(size) &&
      price >= 0 &&
      size >= 0
    ) {
      levels.push({ price, size, updatedAt: receivedAt });
    }
  }

  return levels;
}

function nativeNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nativeSide(value: unknown): MarketTick["side"] {
  const side = nativeString(value)?.toUpperCase();

  if (side === "B" || side === "BUY" || side === "BID") {
    return "buy";
  }

  if (side === "A" || side === "ASK" || side === "SELL") {
    return "sell";
  }

  return "unknown";
}

function createNativeHyperliquidBookTick(input: {
  payload: HyperliquidRawIngestPayload;
  coin: string;
  instrumentCode: string;
  exchangeCode: string;
  sourceExchange: string;
  sourceWeight: number;
  sequence: number;
  exchangeTimestamp: string;
  receivedAt: string;
  price: number;
  bestBid?: number;
  bestAsk?: number;
  rawEventType: string;
}): MarketTick {
  const instrument = splitNativeInstrument(input.instrumentCode);

  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: input.sourceExchange,
    transport: input.payload.transport ?? "websocket",
    streamId: input.payload.streamId ?? null,
    connectionId: input.payload.connectionId ?? null,
    sourceChannel: input.rawEventType,
    exchangeCode: input.exchangeCode,
    instrumentCode: input.instrumentCode,
    baseAsset: instrument.baseAsset,
    quoteAsset: instrument.quoteAsset,
    price: input.price,
    size: 0,
    side: "unknown",
    sequence: input.sequence,
    providerTimestamp: input.exchangeTimestamp,
    exchangeTimestamp: input.exchangeTimestamp,
    synchronizedExchangeTimestamp: input.exchangeTimestamp,
    clockOffsetMs: 0,
    receivedAt: input.receivedAt,
    sourceWeight: input.sourceWeight,
    bestBid: input.bestBid,
    bestAsk: input.bestAsk,
    raw: toJsonValue({
      eventType: "book-snapshot",
      nativeEventType: input.rawEventType,
      commodity: "ORDER_BOOK",
      coin: input.coin,
      streamId: input.payload.streamId ?? null,
      connectionId: input.payload.connectionId ?? null
    }) as JsonRecord
  };
}

function createNativeHyperliquidTradeTick(
  item: Record<string, unknown>,
  payload: HyperliquidRawIngestPayload
): MarketTick {
  const receivedAt = nativeIso(payload.receivedAt) ?? new Date().toISOString();
  const coin = requireNativeString(item.coin ?? payload.instrumentCode, "coin");
  const instrumentCode = hyperliquidNativeInstrumentCode(coin, payload.instrumentCode);
  const exchangeCode = (payload.exchangeCode ?? "hyperliquid").toLowerCase();
  const sourceExchange = normalizeSourceExchange(payload.source_exchange ?? "hyperliquid");
  const sourceWeight = normalizeSourceWeight(payload.sourceWeight);
  const price = nativeNumber(item.px ?? item.price ?? item.p);
  const size = nativeNumber(item.sz ?? item.size ?? item.s);
  const isBuy = typeof item.isBuy === "boolean" ? item.isBuy : null;
  const side = isBuy === null ? nativeSide(item.side) : isBuy ? "buy" : "sell";

  if (price === null || price < 0) {
    throw new Error("INVALID_HYPERLIQUID_TRADE_PRICE");
  }

  if (size === null || size < 0) {
    throw new Error("INVALID_HYPERLIQUID_TRADE_SIZE");
  }

  const exchangeTimestamp =
    nativeExchangeTimestamp(item.time ?? item.timestamp ?? item.T) ?? receivedAt;
  const sequence = nativeSequence(
    item.tid ??
      item.id ??
      item.hash ??
      `${coin}:${exchangeTimestamp}:${price}:${size}:${item.side ?? ""}`
  );
  const instrument = splitNativeInstrument(instrumentCode);

  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: sourceExchange,
    transport: payload.transport ?? "websocket",
    streamId: payload.streamId ?? null,
    connectionId: payload.connectionId ?? null,
    sourceChannel: "trades",
    exchangeCode,
    instrumentCode,
    baseAsset: instrument.baseAsset,
    quoteAsset: instrument.quoteAsset,
    price,
    size,
    side,
    sequence,
    providerTimestamp: exchangeTimestamp,
    exchangeTimestamp,
    synchronizedExchangeTimestamp: exchangeTimestamp,
    clockOffsetMs: 0,
    receivedAt,
    sourceWeight,
    raw: toJsonValue({
      eventType: "trade",
      commodity: "TRADE",
      coin,
      tradeId: item.tid ?? item.id ?? null,
      tradeHash: item.hash ?? null,
      aggressorSide: item.side ?? null,
      isBuy: isBuy ?? (side === "unknown" ? null : side === "buy"),
      streamId: payload.streamId ?? null,
      connectionId: payload.connectionId ?? null
    }) as JsonRecord
  };
}

function createNativeHyperliquidFundingTick(
  data: Record<string, unknown>,
  payload: HyperliquidRawIngestPayload
): MarketTick {
  const ctx = nativeObject(data.ctx) ?? data;
  const receivedAt = nativeIso(payload.receivedAt) ?? new Date().toISOString();
  const coin = requireNativeString(data.coin ?? payload.instrumentCode, "coin");
  const instrumentCode = hyperliquidNativeInstrumentCode(coin, payload.instrumentCode);
  const exchangeCode = (payload.exchangeCode ?? "hyperliquid").toLowerCase();
  const sourceExchange = normalizeSourceExchange(payload.source_exchange ?? "hyperliquid");
  const sourceWeight = normalizeSourceWeight(payload.sourceWeight);
  const markPrice = nativeNumber(ctx.markPx ?? ctx.markPrice);
  const oraclePrice = nativeNumber(ctx.oraclePx ?? ctx.oraclePrice);
  const midPrice = nativeNumber(ctx.midPx ?? ctx.midPrice);
  const price = midPrice ?? markPrice ?? oraclePrice ?? 0;
  const exchangeTimestamp =
    nativeExchangeTimestamp(data.time ?? data.timestamp ?? ctx.time) ?? receivedAt;
  const fundingRateHourly = nativeNumber(ctx.funding ?? ctx.fundingRate) ?? 0;
  const openInterest = nativeNumber(ctx.openInterest);
  const sequence = nativeSequence(`${coin}:${exchangeTimestamp}:funding`);
  const instrument = splitNativeInstrument(instrumentCode);

  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: sourceExchange,
    transport: payload.transport ?? "websocket",
    streamId: payload.streamId ?? null,
    connectionId: payload.connectionId ?? null,
    sourceChannel: "activeAssetCtx",
    exchangeCode,
    instrumentCode,
    baseAsset: instrument.baseAsset,
    quoteAsset: instrument.quoteAsset,
    price,
    size: 0,
    side: "unknown",
    sequence,
    providerTimestamp: exchangeTimestamp,
    exchangeTimestamp,
    synchronizedExchangeTimestamp: exchangeTimestamp,
    clockOffsetMs: 0,
    receivedAt,
    sourceWeight,
    fundingRateHourly,
    markPrice: markPrice ?? undefined,
    oraclePrice: oraclePrice ?? undefined,
    openInterest: openInterest ?? undefined,
    raw: toJsonValue({
      eventType: "funding",
      commodity: "FUNDING",
      coin,
      fundingRateHourly,
      markPrice,
      oraclePrice,
      openInterest,
      premium: ctx.premium ?? null,
      dayNtlVlm: ctx.dayNtlVlm ?? null,
      streamId: payload.streamId ?? null,
      connectionId: payload.connectionId ?? null
    }) as JsonRecord
  };
}

function nativeHyperliquidLatencyMetrics(input: {
  instrumentCode: string;
  exchangeCode: string;
  sourceExchange: string;
  sourceWeight: number;
  sequence: number;
  exchangeTimestamp: string;
  receivedAt: string;
  brainTimestamp: string;
  totalLatencyMs: number;
  maxLatencyMs: number;
  averageLatencyMs: number;
  sampleCount: number;
  location: EngineLocation;
}): LatencyMetrics {
  const rawIngestMs = parseTimestampMs(input.receivedAt, "ingest_timestamp");
  const sourceMs = parseTimestampMs(input.exchangeTimestamp, "provider_timestamp");
  const brainMs = parseTimestampMs(input.brainTimestamp, "brain_timestamp");
  const ingestClockSkewMs = Math.max(0, rawIngestMs - brainMs);
  const ingestMs = ingestClockSkewMs > 0 ? brainMs : rawIngestMs;
  const ingestTimestamp = ingestClockSkewMs > 0 ? input.brainTimestamp : input.receivedAt;
  const totalLatencyMs = roundLatency(Math.max(0, input.totalLatencyMs));

  return {
    instrumentCode: input.instrumentCode,
    exchangeCode: input.exchangeCode,
    source: "HYPERLIQUID",
    sourceExchange: input.sourceExchange,
    sourceWeight: input.sourceWeight,
    sequence: input.sequence,
    providerTimestamp: input.exchangeTimestamp,
    sourceTimestamp: input.exchangeTimestamp,
    ingestTimestamp,
    brainTimestamp: input.brainTimestamp,
    clockOffsetMs: ingestClockSkewMs,
    networkLatencyMs: roundLatency(Math.max(0, ingestMs - sourceMs)),
    processingLatencyMs: roundLatency(Math.max(0, brainMs - ingestMs)),
    totalLatencyMs,
    maxLatencyMs: input.maxLatencyMs,
    averageLatencyMs: input.averageLatencyMs,
    sampleCount: input.sampleCount,
    status: totalLatencyMs > input.maxLatencyMs ? "STALE" : "FRESH",
    colo: input.location.colo,
    placement: input.location.placement,
    latencyRiskMultiplier: input.location.latencyRiskMultiplier,
    positionSizeMultiplier: input.location.positionSizeMultiplier,
    timeToBookMs: null
  };
}

function hasRuntimeConfigUpdate(update: AdminConfigUpdate): boolean {
  return Boolean(
    update.mode ||
    update.bankroll ||
    update.risk ||
    update.maxLatencyMs !== undefined ||
    update.MAX_LATENCY !== undefined ||
    update.performance
  );
}

function defaultEngineState(engineId: string): EngineState {
  const now = new Date().toISOString();
  const agentHealth = Object.fromEntries(
    (
      [
        "ORACLE",
        "SENTIMENT",
        "PROFILER",
        "CROUPIER",
        "PIT_BOSS",
        "JANITOR",
        "EXECUTIONER",
        "MOLTWORKER",
        "RISK",
        "SYSTEM"
      ] as AgentName[]
    ).map((agent) => [
      agent,
      {
        status: "YELLOW",
        heartbeatAt: now,
        latencyMs: 0,
        failures24h: 0
      } satisfies AgentHealth
    ])
  ) as Record<AgentName, AgentHealth>;

  return {
    engineId,
    mode: "PAPER",
    bankroll: {
      currency: "USD",
      cash: 0,
      equity: 0,
      realizedPnl: 0,
      updatedAt: now
    },
    openPositions: {},
    agentHealth,
    risk: defaultRiskLimits(),
    processedTicks: 0,
    acceptedSignals: 0,
    internalOrderBookDepth: 0,
    averageLatency: 0,
    latencySampleCount: 0,
    staleTickCount: 0,
    toxicityScore: 0,
    current_inventory_delta: 0,
    liquidationHeatmap: defaultLiquidationHeatmapState(),
    maxLatencyMs: DEFAULT_MAX_LATENCY_MS,
    cachedConfig: { ...defaultConfig },
    macroBias: neutralMacroBias(),
    temporaryOverride: null,
    assetMatrix: defaultAssetMatrix(defaultConfig, neutralMacroBias(), now),
    profilerStates: {},
    location: defaultEngineLocation(),
    fundingRates: {},
    microstructure: defaultMicrostructure(),
    priceDiscovery: defaultPriceDiscovery(),
    oracle: defaultOracleState(),
    sentiment: defaultSentimentState(),
    ensemble: defaultEnsembleState(now),
    leadLag: defaultLeadLagMetrics(),
    inventory: defaultInventoryState(DEFAULT_MAX_INVENTORY_UNITS),
    riskMetrics: defaultRiskMetrics(0, now),
    quoteState: defaultQuoteState(),
    assetQuoteStates: defaultAssetQuoteStates(defaultConfig, neutralMacroBias(), now),
    shadowQueue: defaultShadowQueueState(null),
    lastTradeIntent: null,
    inventoryGuard: defaultInventoryGuardState(),
    janitor: defaultJanitorState(),
    slippage: defaultSlippageAnalytics(),
    orderMap: {},
    executionProfile: defaultExecutionProfile(
      DEFAULT_JITTER_THRESHOLD_MS,
      DEFAULT_JITTER_SAMPLE_WINDOW,
      DEFAULT_JITTER_COMPUTE_INTERVAL_TICKS,
      0
    ),
    citadel: defaultCitadelState(now),
    dom: null,
    anomaly: defaultAnomalyStatus(),
    heartbeatAt: now,
    updatedAt: now
  };
}

function defaultEnsembleState(observedAt: string): EngineState["ensemble"] {
  return {
    schemaVersion: "ensemble.v1",
    confidence: 0,
    kellyMultiplier: 0,
    regimeMultiplier: 1,
    anomalyCircuitBreaker: false,
    votes: [],
    rationale: "ENSEMBLE_NOT_EVALUATED",
    updatedAt: observedAt
  };
}

function normalizePaperBankroll(
  bankroll: EngineState["bankroll"],
  env: Env,
  observedAt: string
): EngineState["bankroll"] {
  const cash = Number(bankroll.cash);
  const equity = Number(bankroll.equity);

  if (
    !isShadowMode(env) ||
    (Number.isFinite(cash) && cash > 0) ||
    (Number.isFinite(equity) && equity > 0)
  ) {
    return bankroll;
  }

  const paperBankroll = readPositiveNumber(env.PAPER_BANKROLL_USD, DEFAULT_PAPER_BANKROLL_USD);

  return {
    ...bankroll,
    cash: paperBankroll,
    equity: paperBankroll,
    realizedPnl: bankroll.realizedPnl ?? 0,
    updatedAt: observedAt
  };
}

function defaultEngineLocation(): EngineLocation {
  return {
    colo: null,
    placement: null,
    country: null,
    city: null,
    region: null,
    timezone: null,
    latitude: null,
    longitude: null,
    lastSeenAt: null,
    isGoldenRegion: true,
    latencyRiskMultiplier: 1,
    positionSizeMultiplier: 1,
    observedLatencyMs: null,
    reason: "UNKNOWN_COLO"
  };
}

function readTopologyHeaders(request: Request): EdgeTopology {
  const headers = request.headers;

  return {
    colo: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}colo`)),
    placement: normalizeTopologyHeader(
      headers.get(`${TOPOLOGY_HEADER_PREFIX}placement`) ?? headers.get("cf-placement")
    ),
    country: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}country`)),
    city: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}city`)),
    region: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}region`)),
    timezone: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}timezone`)),
    latitude: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}latitude`)),
    longitude: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}longitude`)),
    requestId:
      normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}request-id`)) ??
      headers.get("cf-ray") ??
      crypto.randomUUID(),
    observedAt:
      normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}observed-at`)) ??
      new Date().toISOString()
  };
}

function resolveEngineLocation(
  topology: EdgeTopology,
  previous: EngineLocation,
  env: Env,
  config: GlobalRiskConfig,
  observedLatencyMs: number | null
): EngineLocation {
  const targetColo = configuredPlacementColo(env.PLACEMENT_TARGET_COLO);
  const observedColo =
    (placementColo(topology.placement) ?? topology.colo ?? targetColo)?.toUpperCase() ?? null;
  const colo = observedColo;
  const goldenColos = parseColoSet(config.GOLDEN_COLOS || env.GOLDEN_COLOS);
  const hasGoldenRegionPolicy = goldenColos.size > 0;
  const isGoldenRegion = !hasGoldenRegionPolicy || (colo !== null && goldenColos.has(colo));
  const latencyRiskMultiplier = isGoldenRegion
    ? 1
    : resolveRiskMultiplier(env.HIGH_LATENCY_COLO_RISK_MULTIPLIER);

  return {
    colo,
    placement: topology.placement ?? previous.placement,
    country: null,
    city: null,
    region: null,
    timezone: null,
    latitude: null,
    longitude: null,
    lastSeenAt: topology.observedAt,
    isGoldenRegion,
    latencyRiskMultiplier,
    positionSizeMultiplier: latencyRiskMultiplier,
    observedLatencyMs,
    reason:
      colo === null
        ? "UNKNOWN_COLO"
        : !placementColo(topology.placement) && !topology.colo && targetColo === colo
          ? "TARGET_COLO_ASSUMED"
          : isGoldenRegion
            ? "GOLDEN_REGION"
            : "NON_GOLDEN_REGION"
  };
}

function placementColo(placement: string | null): string | null {
  const match = /^(?:remote|local)-([a-z0-9]{3,4})$/i.exec(placement ?? "");
  return match?.[1]?.toUpperCase() ?? null;
}

function configuredPlacementColo(value: string | undefined): string | null {
  const configured = value?.trim().toUpperCase();
  return configured && /^[A-Z0-9]{3,4}$/.test(configured) ? configured : null;
}

function applyLocationRisk(
  risk: RiskLimits,
  config: GlobalRiskConfig,
  location: EngineLocation,
  updatedAt: string
): RiskLimits {
  return {
    ...risk,
    configVersion: config.version,
    killSwitch: !config.TRADING_ENABLED,
    maxOrderNotional: roundMetric(config.MAX_POSITION_SIZE * location.positionSizeMultiplier, 8),
    maxDrawdownPct: config.MAX_DRAWDOWN_PCT,
    updatedAt
  };
}

function locationChanged(previous: EngineLocation, next: EngineLocation): boolean {
  return (
    previous.colo !== next.colo ||
    previous.placement !== next.placement ||
    previous.isGoldenRegion !== next.isGoldenRegion ||
    previous.latencyRiskMultiplier !== next.latencyRiskMultiplier ||
    previous.positionSizeMultiplier !== next.positionSizeMultiplier
  );
}

function locationTelemetry(
  location: EngineLocation
): Record<string, string | number | boolean | null> {
  return {
    colo: location.colo,
    placement: location.placement,
    country: location.country,
    city: location.city,
    region: location.region,
    timezone: location.timezone,
    latitude: location.latitude,
    longitude: location.longitude,
    isGoldenRegion: location.isGoldenRegion,
    latencyRiskMultiplier: location.latencyRiskMultiplier,
    positionSizeMultiplier: location.positionSizeMultiplier,
    observedLatencyMs: location.observedLatencyMs,
    reason: location.reason,
    lastSeenAt: location.lastSeenAt
  };
}

function parseColoSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((colo) => colo.trim().toUpperCase())
      .filter(Boolean)
  );
}

function parseDeltaNormalizationWeights(value: string | undefined): Record<string, number> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, weight]) => [key.toLowerCase(), Number(weight)] as const)
        .filter(([, weight]) => Number.isFinite(weight) && weight >= 0)
    );
  } catch {
    return {};
  }
}

function resolveRiskMultiplier(value: string | undefined): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return DEFAULT_HIGH_LATENCY_COLO_RISK_MULTIPLIER;
  }

  return roundMetric(parsed, 4);
}

function normalizeTopologyHeader(value: string | null): string | null {
  return value && value.length > 0 ? value : null;
}

function inferSignalBias(signal: AgentSignal): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (signal.action === "BUY" || signal.expectedValue > 0) {
    return "BULLISH";
  }

  if (signal.action === "SELL" || signal.action === "REDUCE" || signal.expectedValue < 0) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

function hawkesEvacuationSignal(signal: AgentSignal): boolean {
  return signal.action === "PAUSE" && signal.featureVector?.signalType === "HAWKES_FLOW_CLUSTER";
}

function touchAgentHealth(
  current: Record<AgentName, AgentHealth>,
  agentName: AgentName,
  status: AgentHealth["status"],
  heartbeatAt: string,
  latencyMs: number,
  lastSignalId?: string
): Record<AgentName, AgentHealth> {
  return {
    ...current,
    [agentName]: {
      status,
      heartbeatAt,
      latencyMs,
      lastSignalId: lastSignalId ?? current[agentName].lastSignalId,
      failures24h: current[agentName].failures24h
    }
  };
}

function disabledProfilerEvaluation(state: ProfilerState, observedAt: string): ProfilerEvaluation {
  return {
    processed: false,
    skippedReason: "PROFILER_AGENT_DISABLED",
    closedBuckets: 0,
    toxicityScore: 0,
    state: {
      ...state,
      toxicityScore: 0,
      amVpinScore: 0,
      toxicityState: "NORMAL",
      pressureSide: "NEUTRAL",
      spreadMultiplier: 1,
      reservationShiftBps: 0,
      quoteHaltUntil: null,
      updatedAt: observedAt
    },
    signal: null
  };
}

function disabledCroupierDecision(minEvThreshold: number): CroupierDecision {
  return {
    intent: null,
    quote: null,
    pullAllQuotes: false,
    adverseSelectionCost: 0,
    minEvThreshold: Number.isFinite(minEvThreshold) ? minEvThreshold : 0
  };
}

function defaultExecutionProfile(
  jitterThresholdMs: number,
  sampleWindow: number,
  computeIntervalTicks: number,
  sampleCount: number
): ExecutionProfile {
  return {
    status: "STABLE",
    jitterMs: 0,
    jitterThresholdMs,
    sampleCount,
    sampleWindow,
    computeIntervalTicks,
    averageProcessingLatencyMs: null,
    maxProcessingLatencyMs: null,
    lastProcessingLatencyMs: null,
    wakeUpTimeMs: null,
    coldStartSuspected: false,
    orderBookUpdateMs: null,
    agentLogicMs: null,
    totalHotPathMs: null,
    lastComputedAt: null,
    updatedAt: null
  };
}

function defaultAnomalyStatus() {
  return {
    status: "CLEAR" as const,
    priceZScore: null,
    volumeZScore: null,
    cancellationToExecutionRatio: 0,
    cancellationCount: 0,
    executionCount: 0,
    lastAnomaly: null,
    updatedAt: null
  };
}

function normalizeExecutionProfile(
  profile: ExecutionProfile | undefined,
  jitterThresholdMs: number,
  sampleWindow: number,
  computeIntervalTicks: number,
  sampleCount: number,
  observedAt: string
): ExecutionProfile {
  const fallback = defaultExecutionProfile(
    jitterThresholdMs,
    sampleWindow,
    computeIntervalTicks,
    sampleCount
  );

  if (!profile) {
    return {
      ...fallback,
      updatedAt: observedAt
    };
  }

  return {
    ...fallback,
    ...profile,
    status: profile.status === "UNSTABLE" ? "UNSTABLE" : "STABLE",
    jitterMs: finiteMetric(profile.jitterMs, 0),
    jitterThresholdMs,
    sampleCount,
    sampleWindow,
    computeIntervalTicks,
    averageProcessingLatencyMs: nullableFiniteMetric(profile.averageProcessingLatencyMs),
    maxProcessingLatencyMs: nullableFiniteMetric(profile.maxProcessingLatencyMs),
    lastProcessingLatencyMs: nullableFiniteMetric(profile.lastProcessingLatencyMs),
    wakeUpTimeMs: nullableFiniteMetric(profile.wakeUpTimeMs),
    coldStartSuspected: Boolean(profile.coldStartSuspected),
    orderBookUpdateMs: nullableFiniteMetric(profile.orderBookUpdateMs),
    agentLogicMs: nullableFiniteMetric(profile.agentLogicMs),
    totalHotPathMs: nullableFiniteMetric(profile.totalHotPathMs),
    lastComputedAt: typeof profile.lastComputedAt === "string" ? profile.lastComputedAt : null,
    updatedAt: observedAt
  };
}

function defaultMicrostructure(): MicrostructureMetrics {
  return {
    marketKey: null,
    instrumentCode: null,
    exchangeCode: null,
    source_exchange: null,
    sourceWeight: DEFAULT_SOURCE_WEIGHT,
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    spread: null,
    spreadBps: null,
    bidVolume: 0,
    askVolume: 0,
    weightedImbalance: null,
    depthLevels: 0,
    lastSequence: null,
    timeToBookMs: null,
    isSynced: false,
    updatedAt: null
  };
}

function defaultPriceDiscovery(): PriceDiscoveryMetrics {
  return {
    instrumentCode: null,
    weightedMidPrice: null,
    primaryExchange: null,
    primaryWeight: 0,
    sourceCount: 0,
    sources: [],
    updatedAt: null
  };
}

function defaultLeadLagMetrics(): EngineState["leadLag"] {
  return {
    schemaVersion: "lead-lag.v1",
    leadInstrument: null,
    lagInstrument: null,
    correlation: null,
    lagMs: null,
    leadLagDelta: null,
    expectedValue: null,
    executable: false,
    sampleCount: 0,
    updatedAt: null
  };
}

function defaultInventoryState(
  maxInventoryUnits: number,
  maxInventoryDelta = DEFAULT_MAX_INVENTORY_DELTA
): EngineState["inventory"] {
  return {
    netDelta: 0,
    current_inventory_delta: 0,
    baseAsset: "BTC",
    normalization: {},
    maxInventoryUnits,
    maxInventoryDelta,
    inventoryPenalty: 0,
    stopBid: false,
    stopAsk: false,
    updatedAt: null
  };
}

function normalizeInventoryState(
  value: EngineState["inventory"] | undefined,
  maxInventoryUnits: number,
  maxInventoryDelta: number
): EngineState["inventory"] {
  const base = defaultInventoryState(maxInventoryUnits, maxInventoryDelta);

  if (!value) {
    return base;
  }

  return {
    ...base,
    ...value,
    current_inventory_delta:
      finiteNumber(value.current_inventory_delta) ?? finiteNumber(value.netDelta) ?? 0,
    baseAsset:
      typeof value.baseAsset === "string" && value.baseAsset.trim() !== ""
        ? value.baseAsset
        : "BTC",
    normalization:
      value.normalization && typeof value.normalization === "object" ? value.normalization : {},
    maxInventoryUnits,
    maxInventoryDelta
  };
}

function defaultRiskMetrics(equity: number, observedAt: string): EngineState["riskMetrics"] {
  return {
    highWaterMark: Math.max(0, equity),
    rollingDrawdownPct: 0,
    var99OneHour: 0,
    isTradingEnabled: false,
    updatedAt: observedAt
  };
}

function defaultQuoteState(): EngineState["quoteState"] {
  return {
    status: "ACTIVE",
    reason: null,
    suspendedUntil: null,
    lastQuote: null,
    updatedAt: null
  };
}

function defaultAssetQuoteStates(
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): EngineState["assetQuoteStates"] {
  const selected = selectedMoltworkerInstruments(macroBias);

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const selectedByMoltworker =
        selected.size === 0 ||
        selected.has(asset.instrumentCode) ||
        selected.has(asset.coin.toLowerCase()) ||
        selected.has(`${asset.coin.toLowerCase()}-perp`);
      const active = config.TRADING_ENABLED && selectedByMoltworker;

      return [
        asset.instrumentCode,
        {
          ...defaultQuoteState(),
          status: active ? "ACTIVE" : "SUSPENDED",
          reason: active
            ? null
            : selectedByMoltworker
              ? "TRADING_DISABLED"
              : "MOLTWORKER_NOT_SELECTED",
          updatedAt: observedAt
        } satisfies EngineState["quoteState"]
      ];
    })
  );
}

function defaultShadowQueueState(observedAt: string | null): ShadowQueueState {
  return {
    schemaVersion: "shadow-queue.v1",
    capacity: DEFAULT_SHADOW_VLO_CAPACITY,
    activeOrders: 0,
    pendingDrifts: 0,
    ghostFills: 0,
    greenLights: 0,
    redLights: 0,
    noEdgeSignals: 0,
    invertedSignals: 0,
    confirmedSignals: 0,
    driftTradeDelay: DEFAULT_SHADOW_VLO_DRIFT_TRADES,
    latencyBudgetMs: DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS,
    baseSpreadBps: DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS,
    queueDepthMultiplier: DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
    lastFill: null,
    lastDecision: null,
    updatedAt: observedAt
  };
}

function defaultCitadelState(observedAt: string): EngineState["citadel"] {
  return {
    status: "NOMINAL",
    reason: null,
    shadowMode: false,
    lastEvacuationAt: null,
    updatedAt: observedAt
  };
}

function maintenanceRecoveryInstruments(payload: {
  resetInstruments?: string[] | string;
  instrumentCode?: string;
}): string[] {
  const values = [
    ...(Array.isArray(payload.resetInstruments)
      ? payload.resetInstruments
      : typeof payload.resetInstruments === "string"
        ? payload.resetInstruments.split(",")
        : []),
    ...(typeof payload.instrumentCode === "string" ? [payload.instrumentCode] : [])
  ];
  const normalized = values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => (value.includes("-") ? value : `${value}-usd`));

  return [...new Set(normalized)];
}

function defaultInventoryGuardState(): EngineState["inventoryGuard"] {
  return {
    netDelta: 0,
    current_inventory_delta: 0,
    maxInventoryDelta: DEFAULT_MAX_INVENTORY_DELTA,
    hardCapReached: false,
    quoteHaltRequired: false,
    skewRatio: 0,
    preferredVenue: null,
    lastIntent: null,
    updatedAt: null
  };
}

function passiveInventoryGuardStateFromInventory(
  inventory: InventoryState,
  observedAt: string
): EngineState["inventoryGuard"] {
  const hardCapBreached =
    inventory.maxInventoryDelta > 0 &&
    Math.abs(inventory.current_inventory_delta) >= inventory.maxInventoryDelta;

  return {
    netDelta: inventory.netDelta,
    current_inventory_delta: inventory.current_inventory_delta,
    maxInventoryDelta: inventory.maxInventoryDelta,
    hardCapReached: hardCapBreached,
    quoteHaltRequired: hardCapBreached,
    skewRatio:
      inventory.maxInventoryDelta > 0
        ? roundMetric(inventory.current_inventory_delta / inventory.maxInventoryDelta, 8)
        : 0,
    preferredVenue: null,
    lastIntent: null,
    updatedAt: observedAt
  };
}

function defaultJanitorState(): EngineState["janitor"] {
  return {
    lastRunAt: null,
    zombieOrders: [],
    orphanExchangeOrders: [],
    reconciledOrders: [],
    cancelledOrders: [],
    dustPositions: [],
    dustCloseIntents: [],
    prunedTelemetryCount: 0,
    updatedAt: null
  };
}

function defaultSlippageAnalytics(): EngineState["slippage"] {
  return {
    schemaVersion: "slippage.v1",
    points: [],
    averageSlippageBps: 0,
    latencyCorrelation: null,
    executionCostBufferBps: 0,
    updatedAt: null
  };
}

function defaultRiskLimits(): RiskLimits {
  return {
    configVersion: "bootstrap",
    killSwitch: true,
    maxGrossExposure: 0,
    maxNetExposure: 0,
    maxOrderNotional: 0,
    maxDrawdownPct: 0,
    perAssetMaxPosition: {},
    updatedAt: new Date().toISOString()
  };
}

function mergeRiskLimits(current?: RiskLimits, update?: Partial<RiskLimits> | null): RiskLimits {
  return {
    ...(current ?? defaultRiskLimits()),
    ...(update ?? {}),
    perAssetMaxPosition: {
      ...(current?.perAssetMaxPosition ?? {}),
      ...(update?.perAssetMaxPosition ?? {})
    }
  };
}

function resolveMaxLatencyMs(
  config: AdminConfigUpdate | null | undefined,
  fallback: number | undefined
): number {
  const candidate =
    config?.performance?.maxLatencyMs ??
    config?.maxLatencyMs ??
    config?.MAX_LATENCY ??
    fallback ??
    DEFAULT_MAX_LATENCY_MS;

  return Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_MAX_LATENCY_MS;
}

function processingLatencyStats(samples: number[]): {
  jitterMs: number;
  averageMs: number | null;
  maxMs: number | null;
} {
  if (samples.length === 0) {
    return {
      jitterMs: 0,
      averageMs: null,
      maxMs: null
    };
  }

  const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const variance =
    samples.reduce((sum, sample) => sum + (sample - average) ** 2, 0) / samples.length;
  const max = samples.reduce(
    (currentMax, sample) => Math.max(currentMax, sample),
    Number.NEGATIVE_INFINITY
  );

  return {
    jitterMs: roundLatency(Math.sqrt(variance)),
    averageMs: roundLatency(average),
    maxMs: roundLatency(max)
  };
}

function prometheusMetric(
  name: string,
  help: string,
  type: "counter" | "gauge",
  value: number | null,
  labels: Record<string, string | number | boolean | null>
): string {
  const safeValue = typeof value === "number" && Number.isFinite(value) ? value : 0;

  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
    `${name}${prometheusLabels(labels)} ${safeValue}`
  ].join("\n");
}

function prometheusLabels(labels: Record<string, string | number | boolean | null>): string {
  const entries = Object.entries(labels).filter(([, value]) => value !== null);

  if (entries.length === 0) {
    return "";
  }

  return `{${entries
    .map(([key, value]) => `${key}="${escapePrometheusLabel(String(value))}"`)
    .join(",")}}`;
}

function escapePrometheusLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function finiteMetric(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function nullableFiniteMetric(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function highResolutionNow(): number {
  return performance.now();
}

function parseTimestampMs(value: string, field: string): number {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`INVALID_${field.toUpperCase()}`);
  }

  return parsed;
}

function roundLatency(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function getInstrumentBook(
  books: Map<string, SortedBookSide>,
  instrumentCode: string,
  side: OrderBookSide
): SortedBookSide {
  const existing = books.get(instrumentCode);

  if (existing) {
    return existing;
  }

  const created = new SortedBookSide(side);
  books.set(instrumentCode, created);
  return created;
}

function resolveBookSide(tick: MarketTick): OrderBookSide | null {
  if (tick.bestBid !== undefined || tick.side === "buy") {
    return "bid";
  }

  if (tick.bestAsk !== undefined || tick.side === "sell") {
    return "ask";
  }

  return null;
}

function countBookLevels(
  bids: Map<string, SortedBookSide>,
  asks: Map<string, SortedBookSide>
): number {
  return countOrderBookLevels(bids.values(), asks.values());
}

function buildMicrostructureSnapshot(
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
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread = bestBid !== null && bestAsk !== null ? roundCrypto(bestAsk - bestBid) : null;
  const midPrice =
    bestBid !== null && bestAsk !== null ? roundCrypto((bestBid + bestAsk) / 2) : null;
  const spreadBps =
    spread !== null && midPrice !== null && midPrice !== 0
      ? roundMetric((spread / midPrice) * 10_000, 4)
      : null;
  const bidVolume = roundCrypto(sumVolume(bids));
  const askVolume = roundCrypto(sumVolume(asks));
  const totalVolume = bidVolume + askVolume;
  const weightedImbalance =
    totalVolume > 0 ? roundMetric((bidVolume - askVolume) / totalVolume, 8) : null;

  return {
    marketKey,
    instrumentCode,
    exchangeCode,
    source_exchange: sourceExchange,
    sourceWeight,
    bestBid,
    bestAsk,
    midPrice,
    spread,
    spreadBps,
    bidVolume,
    askVolume,
    weightedImbalance,
    depthLevels: bids.length + asks.length,
    lastSequence,
    timeToBookMs,
    isSynced,
    updatedAt
  };
}

function microstructureFromBook(book: InternalOrderBook): MicrostructureMetrics {
  return buildMicrostructureSnapshot(
    book.marketKey,
    book.instrumentCode,
    book.exchangeCode,
    book.source_exchange,
    book.sourceWeight,
    book.bids,
    book.asks,
    book.updatedAt,
    book.lastSequence,
    book.ttbLatencyMs,
    book.isSynced
  );
}

function sumVolume(levels: PriceLevel[]): number {
  return levels.reduce((sum, level) => sum + level.size, 0);
}

function resolveCurrentInstrument(
  requestedInstrument: string | undefined,
  stateInstrument: string | null,
  orderBook: Map<string, InternalOrderBook>
): string {
  return (
    requestedInstrument?.toLowerCase() ??
    stateInstrument ??
    orderBook.keys().next().value ??
    "unknown"
  );
}

function buildMarketKey(sourceExchange: string, instrumentCode: string): string {
  return `${normalizeSourceExchange(sourceExchange)}:${instrumentCode.toLowerCase()}`;
}

function profilerStorageKey(instrumentCode: string): string {
  return `${PROFILER_STATE_STORAGE_PREFIX}${normalizeNativeInstrumentCode(instrumentCode)}`;
}

function profilerInstrumentFromStorageKey(storageKey: string): string {
  return normalizeNativeInstrumentCode(
    storageKey.startsWith(PROFILER_STATE_STORAGE_PREFIX)
      ? storageKey.slice(PROFILER_STATE_STORAGE_PREFIX.length)
      : storageKey
  );
}

function selectedMoltworkerInstruments(macroBias: MacroBias): Set<string> {
  return new Set(
    (macroBias.instruments ?? [])
      .filter((instrument) => typeof instrument === "string" && instrument.trim().length > 0)
      .map((instrument) => normalizeNativeInstrumentCode(instrument))
  );
}

function isTargetInstrument(instrumentCode: string): boolean {
  return TARGET_INSTRUMENTS.has(normalizeNativeInstrumentCode(instrumentCode));
}

function isInstrumentSelectedByMoltworker(instrumentCode: string, macroBias: MacroBias): boolean {
  const selected = selectedMoltworkerInstruments(macroBias);
  const normalized = normalizeNativeInstrumentCode(instrumentCode);
  const coin = normalized.split("-")[0];

  return (
    selected.size === 0 ||
    selected.has(normalized) ||
    selected.has(coin) ||
    selected.has(`${coin}-perp`)
  );
}

function normalizeAssetMatrix(
  stored: Record<string, AssetRuntimeState> | undefined,
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): Record<string, AssetRuntimeState> {
  const defaults = defaultAssetMatrix(config, macroBias, observedAt);

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const existing = stored?.[asset.instrumentCode];
      return [
        asset.instrumentCode,
        existing
          ? {
              ...defaults[asset.instrumentCode],
              ...existing,
              instrumentCode: asset.instrumentCode,
              coin: asset.coin,
              updatedAt: existing.updatedAt ?? observedAt
            }
          : defaults[asset.instrumentCode]
      ];
    })
  );
}

function filterTargetOrderBooks(
  books: Map<string, InternalOrderBook>
): Map<string, InternalOrderBook> {
  return new Map(
    [...books.entries()].filter(([, book]) => isTargetInstrument(book.instrumentCode))
  );
}

function defaultAssetMatrix(
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): Record<string, AssetRuntimeState> {
  const selected = selectedMoltworkerInstruments(macroBias);
  const selectedCount =
    selected.size > 0
      ? TARGET_ASSET_MATRIX.filter(
          (asset) =>
            selected.has(asset.instrumentCode) ||
            selected.has(asset.coin.toLowerCase()) ||
            selected.has(`${asset.coin.toLowerCase()}-perp`)
        ).length
      : TARGET_ASSET_MATRIX.length;
  const allocation = selectedCount > 0 ? 1 / selectedCount : 0;

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const selectedByMoltworker =
        selected.size === 0 ||
        selected.has(asset.instrumentCode) ||
        selected.has(asset.coin.toLowerCase()) ||
        selected.has(`${asset.coin.toLowerCase()}-perp`);

      return [
        asset.instrumentCode,
        {
          instrumentCode: asset.instrumentCode,
          coin: asset.coin,
          selectedByMoltworker,
          active: false,
          isSynced: false,
          lastSequence: null,
          midPrice: null,
          volatility: 0.01,
          capitalAllocationPct: selectedByMoltworker ? roundMetric(allocation, 8) : 0,
          maxNotional: 0,
          toxicityState: "NORMAL",
          amVpin: 0,
          obi: null,
          quoteStatus: config.TRADING_ENABLED ? "ACTIVE" : "SUSPENDED",
          quoteReason: config.TRADING_ENABLED ? null : "TRADING_DISABLED",
          quoteSuspendedUntil: null,
          quoteEligible: config.TRADING_ENABLED && selectedByMoltworker,
          lastQuoteAt: null,
          updatedAt: observedAt
        } satisfies AssetRuntimeState
      ];
    })
  );
}

function normalizeAssetQuoteStates(
  stored: EngineState["assetQuoteStates"] | undefined,
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): EngineState["assetQuoteStates"] {
  const defaults = defaultAssetQuoteStates(config, macroBias, observedAt);

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const existing = stored?.[asset.instrumentCode];
      return [
        asset.instrumentCode,
        existing
          ? {
              ...defaults[asset.instrumentCode],
              ...existing,
              lastQuote: existing.lastQuote ?? defaults[asset.instrumentCode].lastQuote,
              updatedAt: existing.updatedAt ?? observedAt
            }
          : defaults[asset.instrumentCode]
      ];
    })
  );
}

function reconcileAssetQuoteStatesForConfig(
  current: EngineState["assetQuoteStates"],
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): EngineState["assetQuoteStates"] {
  const defaults = defaultAssetQuoteStates(config, macroBias, observedAt);
  const selected = selectedMoltworkerInstruments(macroBias);

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const existing = current[asset.instrumentCode] ?? defaults[asset.instrumentCode];
      const selectedByMoltworker =
        selected.size === 0 ||
        selected.has(asset.instrumentCode) ||
        selected.has(asset.coin.toLowerCase()) ||
        selected.has(`${asset.coin.toLowerCase()}-perp`);

      if (!config.TRADING_ENABLED || !selectedByMoltworker) {
        return [asset.instrumentCode, defaults[asset.instrumentCode]];
      }

      if (existing.reason === "TRADING_DISABLED" || existing.reason === "MOLTWORKER_NOT_SELECTED") {
        return [
          asset.instrumentCode,
          {
            ...existing,
            status: "ACTIVE" as const,
            reason: null,
            suspendedUntil: null,
            updatedAt: observedAt
          }
        ];
      }

      return [asset.instrumentCode, existing];
    })
  );
}

function quoteStateForInstrumentState(
  states: EngineState["assetQuoteStates"] | undefined,
  instrumentCode: string,
  fallback: EngineState["quoteState"]
): EngineState["quoteState"] {
  const normalized = normalizeNativeInstrumentCode(instrumentCode);
  return states?.[normalized] ?? fallback;
}

function isQuoteSuspendedAt(quoteState: EngineState["quoteState"], observedAt: string): boolean {
  if (quoteState.status !== "SUSPENDED") {
    return false;
  }

  return (
    !quoteState.suspendedUntil || Date.parse(quoteState.suspendedUntil) > Date.parse(observedAt)
  );
}

function suspendAssetQuoteStates(
  states: EngineState["assetQuoteStates"],
  reason: string,
  observedAt: string,
  options: {
    instrumentCode?: string;
    suspendedUntil?: string | null;
    lastQuote?: EngineState["quoteState"]["lastQuote"];
  } = {}
): EngineState["assetQuoteStates"] {
  const targets = options.instrumentCode
    ? new Set([normalizeNativeInstrumentCode(options.instrumentCode)])
    : new Set(TARGET_ASSET_MATRIX.map((asset) => asset.instrumentCode));

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const current = states[asset.instrumentCode] ?? defaultQuoteState();
      if (!targets.has(asset.instrumentCode)) {
        return [asset.instrumentCode, current];
      }

      return [
        asset.instrumentCode,
        {
          status: "SUSPENDED" as const,
          reason,
          suspendedUntil: options.suspendedUntil ?? null,
          lastQuote: options.lastQuote ?? current.lastQuote,
          updatedAt: observedAt
        }
      ];
    })
  );
}

function resumeExpiredAssetQuoteStates(
  states: EngineState["assetQuoteStates"],
  observedAt: string
): EngineState["assetQuoteStates"] {
  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const current = states[asset.instrumentCode] ?? defaultQuoteState();
      if (!isQuoteSuspendedAt(current, observedAt)) {
        return [
          asset.instrumentCode,
          current.status === "SUSPENDED"
            ? {
                ...current,
                status: "ACTIVE" as const,
                reason: null,
                suspendedUntil: null,
                updatedAt: observedAt
              }
            : current
        ];
      }

      return [asset.instrumentCode, current];
    })
  );
}

function aggregateQuoteState(
  states: EngineState["assetQuoteStates"],
  previous: EngineState["quoteState"],
  observedAt: string
): EngineState["quoteState"] {
  const values = Object.values(states);
  const suspended = values.filter((state) => isQuoteSuspendedAt(state, observedAt));
  const active = values.filter((state) => !isQuoteSuspendedAt(state, observedAt));
  const previousLastQuote =
    previous.lastQuote && isTargetInstrument(previous.lastQuote.instrumentCode)
      ? previous.lastQuote
      : null;
  const lastQuote =
    values
      .map((state) => state.lastQuote)
      .filter((quote) => !quote || isTargetInstrument(quote.instrumentCode))
      .filter((quote): quote is NonNullable<EngineState["quoteState"]["lastQuote"]> =>
        Boolean(quote)
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ??
    previousLastQuote;

  if (values.length > 0 && active.length === 0 && suspended.length > 0) {
    const indefinite = suspended.find((state) => !state.suspendedUntil);
    const longest = [...suspended].sort(
      (left, right) =>
        Date.parse(right.suspendedUntil ?? "9999-12-31T23:59:59.999Z") -
        Date.parse(left.suspendedUntil ?? "9999-12-31T23:59:59.999Z")
    )[0];

    return {
      status: "SUSPENDED",
      reason: indefinite?.reason ?? longest?.reason ?? "ALL_ASSET_QUOTES_SUSPENDED",
      suspendedUntil: indefinite ? null : (longest?.suspendedUntil ?? null),
      lastQuote,
      updatedAt: observedAt
    };
  }

  return {
    status: "ACTIVE",
    reason: suspended.length > 0 ? "PARTIAL_ASSET_SUSPENSION" : null,
    suspendedUntil: null,
    lastQuote,
    updatedAt: observedAt
  };
}

function quotePriceMovedTicks(
  previous: number | null,
  next: number | null,
  tickSize: number
): number {
  if (previous === null || next === null) {
    return previous === next ? 0 : Number.POSITIVE_INFINITY;
  }

  const safeTick = Math.max(tickSize, DEFAULT_ORDER_BOOK_TICK_SIZE);
  return Math.abs(next - previous) / safeTick;
}

function adverseAdjustedPaperFillPrice(
  side: "BUY" | "SELL",
  price: number,
  adverseBps: number,
  tickSize: number
): number {
  const adjusted =
    side === "BUY" ? price * (1 + adverseBps / 10_000) : price * (1 - adverseBps / 10_000);

  return normalizePriceToTick(
    Math.max(tickSize, adjusted),
    Math.max(tickSize, DEFAULT_ORDER_BOOK_TICK_SIZE),
    side === "BUY" ? "CEIL" : "FLOOR"
  );
}

function normalizeMarketKey(value: string): string {
  return value.toLowerCase();
}

function normalizeSourceExchange(value: string | null | undefined): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : "unknown";
}

function normalizeSourceWeight(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SOURCE_WEIGHT;
}

function aggregateDomBins(
  bidLevels: PriceLevel[],
  askLevels: PriceLevel[],
  binSize: number
): DomBinAccumulator[] {
  const bins = new Map<string, DomBinAccumulator>();

  const appendLevel = (level: PriceLevel, side: OrderBookSide) => {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.size) || level.size <= 0) {
      return;
    }

    const priceStart = roundCrypto(Math.floor(level.price / binSize) * binSize);
    const priceEnd = roundCrypto(priceStart + binSize);
    const key = `${side}:${priceKey(priceStart)}`;
    const existing = bins.get(key);

    if (existing) {
      existing.volume = roundCrypto(existing.volume + level.size);
      existing.levelCount += 1;
      return;
    }

    bins.set(key, {
      side,
      priceStart,
      priceEnd,
      centerPrice: roundCrypto(priceStart + binSize / 2),
      volume: roundCrypto(level.size),
      levelCount: 1
    });
  };

  for (const level of bidLevels) {
    appendLevel(level, "bid");
  }

  for (const level of askLevels) {
    appendLevel(level, "ask");
  }

  return [...bins.values()].sort((left, right) => {
    if (left.side !== right.side) {
      return left.side === "bid" ? -1 : 1;
    }

    return left.side === "bid"
      ? right.priceStart - left.priceStart
      : left.priceStart - right.priceStart;
  });
}

function volumeStats(volumes: number[]): { mean: number; sigma: number } {
  if (volumes.length === 0) {
    return { mean: 0, sigma: 0 };
  }

  const mean = volumes.reduce((sum, volume) => sum + volume, 0) / volumes.length;
  const variance = volumes.reduce((sum, volume) => sum + (volume - mean) ** 2, 0) / volumes.length;

  return {
    mean: roundCrypto(mean),
    sigma: roundCrypto(Math.sqrt(variance))
  };
}

function isLiquidityWall(volume: number, mean: number, sigma: number): boolean {
  return sigma > 0 && volume > mean + 3 * sigma;
}

function toLiquidityWall(
  bin: DomBinAccumulator,
  instrumentCode: string,
  exchangeCode: string,
  sequence: number,
  midPrice: number,
  meanVolume: number,
  sigmaVolume: number,
  previous: LiquidityWall | undefined,
  observedAt: string
): LiquidityWall {
  const zScore = sigmaVolume > 0 ? (bin.volume - meanVolume) / sigmaVolume : 0;

  return {
    wallId: wallIdForBin(instrumentCode, bin),
    instrumentCode,
    exchangeCode,
    side: bin.side,
    priceStart: bin.priceStart,
    priceEnd: bin.priceEnd,
    centerPrice: bin.centerPrice,
    volume: bin.volume,
    meanVolume,
    sigmaVolume,
    zScore: roundMetric(zScore, 4),
    levelCount: bin.levelCount,
    status: "ACTIVE",
    firstSeenAt: previous?.firstSeenAt ?? observedAt,
    lastSeenAt: observedAt,
    lastSequence: sequence,
    distanceFromMidBps: distanceBps(bin.centerPrice, midPrice),
    spoofingSuspected: false
  };
}

function wallIdForBin(instrumentCode: string, bin: DomBinAccumulator): string {
  return `dom:${instrumentCode}:${bin.side}:${priceKey(bin.priceStart)}`;
}

function latestActiveWalls(
  history: LiquidityWall[],
  instrumentCode: string
): Map<string, LiquidityWall> {
  const latest = new Map<string, LiquidityWall>();

  for (const wall of history) {
    if (wall.instrumentCode === instrumentCode) {
      latest.set(wall.wallId, wall);
    }
  }

  return new Map([...latest.entries()].filter(([, wall]) => wall.status === "ACTIVE"));
}

function classifyMissingWalls(
  previousActiveWalls: Map<string, LiquidityWall>,
  currentWallIds: Set<string>,
  tick: MarketTick | undefined,
  observedAt: string,
  binSize: number,
  spoofProximityBps: number,
  midPrice: number
): LiquidityWall[] {
  const transitions: LiquidityWall[] = [];

  for (const wall of previousActiveWalls.values()) {
    if (currentWallIds.has(wall.wallId)) {
      continue;
    }

    const filled = tick ? wasWallFilled(wall, tick) : false;
    const closeToTouch = tick
      ? Math.abs(tick.price - wall.centerPrice) <=
        Math.max(binSize * 2, tick.price * (spoofProximityBps / 10_000))
      : false;

    transitions.push({
      ...wall,
      status: filled ? "FILLED" : "PULLED",
      lastSeenAt: observedAt,
      lastSequence: tick?.sequence ?? wall.lastSequence,
      distanceFromMidBps: distanceBps(wall.centerPrice, midPrice),
      spoofingSuspected: !filled && closeToTouch
    });
  }

  return transitions;
}

function wasWallFilled(wall: LiquidityWall, tick: MarketTick): boolean {
  return (
    (wall.side === "ask" && tick.side === "buy" && tick.price >= wall.priceStart) ||
    (wall.side === "bid" && tick.side === "sell" && tick.price <= wall.priceEnd)
  );
}

function domHeatmapCell(
  bin: DomBinAccumulator,
  meanVolume: number,
  sigmaVolume: number
): DomHeatmapCell {
  const zScore = sigmaVolume > 0 ? (bin.volume - meanVolume) / sigmaVolume : 0;

  return [
    bin.side === "bid" ? 0 : 1,
    bin.priceStart,
    bin.priceEnd,
    bin.volume,
    bin.levelCount,
    roundMetric(zScore, 4)
  ];
}

function emptyDomSnapshot(
  instrumentCode: string,
  exchangeCode: string | null,
  sequence: number | null,
  midPrice: number | null,
  scanRangePct: number,
  binSize: number,
  history: LiquidityWall[],
  observedAt: string
): DomAnalysisSnapshot {
  return {
    schemaVersion: "dom.analysis.v1",
    instrumentCode,
    exchangeCode,
    sequence,
    midPrice,
    scanRangePct,
    lowerBound: null,
    upperBound: null,
    binSize,
    meanVolume: 0,
    sigmaVolume: 0,
    walls: [],
    pulledWalls: [],
    filledWalls: [],
    heatmap: {
      schemaVersion: "dom.heatmap.v1",
      columns: ["side", "priceStart", "priceEnd", "volume", "levelCount", "zScore"],
      sideEncoding: { bid: 0, ask: 1 },
      cells: []
    },
    history,
    updatedAt: observedAt
  };
}

function distanceBps(price: number, referencePrice: number): number | null {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return null;
  }

  return roundMetric(Math.abs((price - referencePrice) / referencePrice) * 10_000, 4);
}

function sanitizeWallHistory(value: LiquidityWall[] | undefined): LiquidityWall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isLiquidityWallRecord);
}

function isLiquidityWallRecord(value: LiquidityWall): boolean {
  return (
    typeof value?.wallId === "string" &&
    typeof value.instrumentCode === "string" &&
    typeof value.exchangeCode === "string" &&
    (value.side === "bid" || value.side === "ask") &&
    (value.status === "ACTIVE" || value.status === "PULLED" || value.status === "FILLED") &&
    Number.isFinite(value.priceStart) &&
    Number.isFinite(value.priceEnd) &&
    Number.isFinite(value.centerPrice) &&
    Number.isFinite(value.volume)
  );
}

function priceKey(price: number): number {
  if (!Number.isFinite(price) || price < 0) {
    throw new Error("INVALID_ORDER_BOOK_PRICE");
  }

  return Math.round(price * PRICE_SCALE);
}

function priceFromKey(key: number): number {
  return roundCrypto(key / PRICE_SCALE);
}

function roundCrypto(value: number): number {
  return roundMetric(value, CRYPTO_DECIMAL_PLACES);
}

function normalizePriceToTick(value: number, tickSize: number, mode: "FLOOR" | "CEIL"): number {
  const normalizedTick =
    Number.isFinite(tickSize) && tickSize > 0 ? tickSize : DEFAULT_ORDER_BOOK_TICK_SIZE;
  const scaled =
    mode === "FLOOR" ? Math.floor(value / normalizedTick) : Math.ceil(value / normalizedTick);

  return roundCrypto(Math.max(normalizedTick, scaled * normalizedTick));
}

function roundMetric(value: number, decimalPlaces: number): number {
  const scale = 10 ** decimalPlaces;
  return Math.round(value * scale) / scale;
}

class SortedBookSide {
  private root: BookNode | null = null;
  private readonly nodes = new Map<number, BookNode>();

  constructor(private readonly side: OrderBookSide) {}

  get size(): number {
    return this.nodes.size;
  }

  clear(): void {
    this.root = null;
    this.nodes.clear();
  }

  upsert(price: number, size: number, updatedAt: string, tickSize: number): void {
    if (size < 0) {
      throw new Error("INVALID_ORDER_BOOK_SIZE");
    }

    const key = priceKey(bucketPrice(price, tickSize, this.side));
    const rawKey = priceKey(price);
    const roundedSize = roundCrypto(size);

    if (size === 0) {
      this.deleteRawLevel(key, rawKey);
      return;
    }

    const existing = this.nodes.get(key);

    if (existing) {
      existing.rawSizes.set(rawKey, roundedSize);
      existing.level.size = sumRawSizes(existing.rawSizes);
      existing.level.updatedAt = updatedAt;
      return;
    }

    const node: BookNode = {
      key,
      priority: priorityForKey(key),
      level: {
        price: priceFromKey(key),
        size: roundedSize,
        updatedAt
      },
      rawSizes: new Map([[rawKey, roundedSize]]),
      left: null,
      right: null
    };

    this.nodes.set(key, node);
    this.root = insertBookNode(this.root, node);
  }

  top(limit: number): PriceLevel[] {
    const levels: PriceLevel[] = [];
    collectTopLevels(this.root, this.side, limit, levels);
    return levels;
  }

  range(minimum: number, maximum: number, limit: number): PriceLevel[] {
    const levels: PriceLevel[] = [];
    collectRangeLevels(this.root, this.side, priceKey(minimum), priceKey(maximum), limit, levels);
    return levels;
  }

  private deleteRawLevel(key: number, rawKey: number): void {
    const existing = this.nodes.get(key);

    if (!existing) {
      return;
    }

    existing.rawSizes.delete(rawKey);

    if (existing.rawSizes.size > 0) {
      existing.level.size = sumRawSizes(existing.rawSizes);
      return;
    }

    this.nodes.delete(key);
    this.root = deleteBookNode(this.root, key);
  }
}

interface BookNode {
  key: number;
  priority: number;
  level: PriceLevel;
  rawSizes: Map<number, number>;
  left: BookNode | null;
  right: BookNode | null;
}

function sumRawSizes(rawSizes: Map<number, number>): number {
  let total = 0;

  for (const size of rawSizes.values()) {
    total += size;
  }

  return roundCrypto(total);
}

function insertBookNode(root: BookNode | null, node: BookNode): BookNode {
  if (!root) {
    return node;
  }

  if (node.key < root.key) {
    root.left = insertBookNode(root.left, node);
    if (root.left.priority < root.priority) {
      return rotateRight(root);
    }
  } else if (node.key > root.key) {
    root.right = insertBookNode(root.right, node);
    if (root.right.priority < root.priority) {
      return rotateLeft(root);
    }
  }

  return root;
}

function deleteBookNode(root: BookNode | null, key: number): BookNode | null {
  if (!root) {
    return null;
  }

  if (key < root.key) {
    root.left = deleteBookNode(root.left, key);
    return root;
  }

  if (key > root.key) {
    root.right = deleteBookNode(root.right, key);
    return root;
  }

  return mergeBookNodes(root.left, root.right);
}

function mergeBookNodes(left: BookNode | null, right: BookNode | null): BookNode | null {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  if (left.priority < right.priority) {
    left.right = mergeBookNodes(left.right, right);
    return left;
  }

  right.left = mergeBookNodes(left, right.left);
  return right;
}

function rotateLeft(root: BookNode): BookNode {
  const pivot = root.right;

  if (!pivot) {
    return root;
  }

  root.right = pivot.left;
  pivot.left = root;
  return pivot;
}

function rotateRight(root: BookNode): BookNode {
  const pivot = root.left;

  if (!pivot) {
    return root;
  }

  root.left = pivot.right;
  pivot.right = root;
  return pivot;
}

function collectTopLevels(
  node: BookNode | null,
  side: OrderBookSide,
  limit: number,
  output: PriceLevel[]
): void {
  if (!node || output.length >= limit) {
    return;
  }

  if (side === "bid") {
    collectTopLevels(node.right, side, limit, output);
    if (output.length < limit) {
      output.push(node.level);
    }
    collectTopLevels(node.left, side, limit, output);
    return;
  }

  collectTopLevels(node.left, side, limit, output);
  if (output.length < limit) {
    output.push(node.level);
  }
  collectTopLevels(node.right, side, limit, output);
}

function collectRangeLevels(
  node: BookNode | null,
  side: OrderBookSide,
  minimumKey: number,
  maximumKey: number,
  limit: number,
  output: PriceLevel[]
): void {
  if (!node || output.length >= limit) {
    return;
  }

  if (side === "bid") {
    if (node.key < maximumKey) {
      collectRangeLevels(node.right, side, minimumKey, maximumKey, limit, output);
    }

    if (output.length < limit && node.key >= minimumKey && node.key <= maximumKey) {
      output.push(node.level);
    }

    if (node.key > minimumKey) {
      collectRangeLevels(node.left, side, minimumKey, maximumKey, limit, output);
    }
    return;
  }

  if (node.key > minimumKey) {
    collectRangeLevels(node.left, side, minimumKey, maximumKey, limit, output);
  }

  if (output.length < limit && node.key >= minimumKey && node.key <= maximumKey) {
    output.push(node.level);
  }

  if (node.key < maximumKey) {
    collectRangeLevels(node.right, side, minimumKey, maximumKey, limit, output);
  }
}

function priorityForKey(key: number): number {
  const text = String(key);
  let hash = 2_166_136_261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

function bucketPrice(price: number, tickSize: number, side: OrderBookSide): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    return roundCrypto(price);
  }

  const scaled = price / tickSize;
  const bucketed = side === "bid" ? Math.floor(scaled) * tickSize : Math.ceil(scaled) * tickSize;

  return roundCrypto(bucketed);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toJsonValue(item)
      ])
    );
  }

  return String(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hydrateOrderBooks(records: Map<string, InternalOrderBook>): {
  snapshots: Map<string, InternalOrderBook>;
  bids: Map<string, SortedBookSide>;
  asks: Map<string, SortedBookSide>;
  sync: Map<string, BookSyncState>;
} {
  const snapshots = new Map<string, InternalOrderBook>();
  const bids = new Map<string, SortedBookSide>();
  const asks = new Map<string, SortedBookSide>();
  const sync = new Map<string, BookSyncState>();

  for (const [, value] of records) {
    const bidLevels = Array.isArray(value.bids) ? value.bids : hydrateLegacyLevel(value, "bid");
    const askLevels = Array.isArray(value.asks) ? value.asks : hydrateLegacyLevel(value, "ask");
    const tickSize = value.tickSize ?? DEFAULT_ORDER_BOOK_TICK_SIZE;
    const bidBook = levelsToBookSide(bidLevels, "bid", tickSize);
    const askBook = levelsToBookSide(askLevels, "ask", tickSize);
    const normalizedBids = bidBook.top(BOOK_SNAPSHOT_TOP_LEVELS);
    const normalizedAsks = askBook.top(BOOK_SNAPSHOT_TOP_LEVELS);
    const sourceExchange = normalizeSourceExchange(value.source_exchange ?? value.exchangeCode);
    const marketKey = normalizeMarketKey(
      value.marketKey ?? buildMarketKey(sourceExchange, value.instrumentCode)
    );
    const source = value.source ?? "SYSTEM";
    const sourceWeight = normalizeSourceWeight(value.sourceWeight);
    const microstructure = buildMicrostructureSnapshot(
      marketKey,
      value.instrumentCode,
      value.exchangeCode,
      sourceExchange,
      sourceWeight,
      normalizedBids,
      normalizedAsks,
      value.updatedAt,
      value.lastSequence ?? value.sequence,
      value.ttbLatencyMs ?? null,
      value.isSynced ?? true
    );

    bids.set(marketKey, bidBook);
    asks.set(marketKey, askBook);
    sync.set(marketKey, {
      marketKey,
      source,
      source_exchange: sourceExchange,
      sourceWeight,
      instrumentCode: value.instrumentCode,
      exchangeCode: value.exchangeCode,
      lastSequence: value.lastSequence ?? value.sequence,
      lastSnapshotAt: value.updatedAt,
      lastDeltaAt: value.updatedAt,
      lastDesyncAt: value.isSynced === false ? value.updatedAt : null,
      desyncReason: value.desyncReason ?? null,
      isSynced: value.isSynced ?? true,
      tickSize,
      ttbLatencyMs: value.ttbLatencyMs ?? null,
      lastCrossCheckAt: 0
    });
    snapshots.set(marketKey, {
      marketKey,
      source,
      source_exchange: sourceExchange,
      sourceWeight,
      instrumentCode: value.instrumentCode,
      exchangeCode: value.exchangeCode,
      bids: normalizedBids,
      asks: normalizedAsks,
      bestBid: microstructure.bestBid,
      bestAsk: microstructure.bestAsk,
      midPrice: microstructure.midPrice,
      spread: microstructure.spread,
      spreadBps: microstructure.spreadBps,
      weightedImbalance: microstructure.weightedImbalance,
      lastSequence: microstructure.lastSequence,
      tickSize: value.tickSize ?? DEFAULT_ORDER_BOOK_TICK_SIZE,
      ttbLatencyMs: microstructure.timeToBookMs,
      isSynced: microstructure.isSynced,
      desyncReason: value.desyncReason ?? null,
      sequence: value.sequence,
      updatedAt: value.updatedAt
    });
  }

  return { snapshots, bids, asks, sync };
}

function hydrateLegacyLevel(value: InternalOrderBook, side: OrderBookSide): PriceLevel[] {
  const legacy = value as unknown as {
    bid?: number | null;
    ask?: number | null;
    lastSize?: number;
    updatedAt: string;
  };
  const price = side === "bid" ? legacy.bid : legacy.ask;

  if (typeof price !== "number") {
    return [];
  }

  return [
    {
      price: roundCrypto(price),
      size: roundCrypto(legacy.lastSize ?? 0),
      updatedAt: legacy.updatedAt
    }
  ];
}

function levelsToBookSide(
  levels: PriceLevel[],
  side: OrderBookSide,
  tickSize: number
): SortedBookSide {
  const book = new SortedBookSide(side);

  for (const level of levels) {
    book.upsert(level.price, level.size, level.updatedAt, tickSize);
  }

  return book;
}

function tickToDelta(tick: MarketTick): BookDeltaWithTicker {
  const side = resolveBookSide(tick);

  if (!side) {
    throw new Error("UNKNOWN_ORDER_BOOK_SIDE");
  }

  return {
    schemaVersion: "order-book.delta.v1",
    source: tick.source,
    source_exchange: tick.source_exchange,
    exchangeCode: tick.exchangeCode,
    instrumentCode: tick.instrumentCode,
    marketKey: buildMarketKey(tick.source_exchange, tick.instrumentCode),
    sourceWeight: tick.sourceWeight,
    sequence: tick.sequence,
    exchangeTimestamp: tick.exchangeTimestamp,
    receivedAt: tick.receivedAt,
    tickSize: tick.tickSize,
    side,
    price: tick.price,
    size: tick.size,
    bestBid: tick.bestBid,
    bestAsk: tick.bestAsk
  };
}

function calculateTimeToBookMs(exchangeTimestamp: string, bookTimestamp: string): number {
  return Math.max(
    0,
    parseTimestampMs(bookTimestamp, "book_timestamp") -
      parseTimestampMs(exchangeTimestamp, "exchange_timestamp")
  );
}

function isCrossedBook(book: InternalOrderBook): boolean {
  return (
    book.bestBid !== null &&
    book.bestAsk !== null &&
    Number.isFinite(book.bestBid) &&
    Number.isFinite(book.bestAsk) &&
    book.bestBid >= book.bestAsk
  );
}

function mapManagedStatusToTradeStatus(status: ManagedOrder["status"]): TradeExecution["status"] {
  switch (status) {
    case "FILLED":
      return "FILLED";
    case "PARTIAL_FILL":
      return "PARTIAL";
    case "GHOST_FILL":
      return "GHOST_FILL";
    case "REJECTED":
      return "REJECTED";
    case "CANCELLED":
      return "CANCELLED";
    case "PENDING":
    case "OPEN":
    default:
      return "ACCEPTED";
  }
}

function isPortfolioFillStatus(status: ManagedOrder["status"]): boolean {
  return status === "FILLED" || status === "PARTIAL_FILL" || status === "GHOST_FILL";
}

function executionReportSize(
  report: ExecutionReport,
  order: ManagedOrder,
  status: TradeExecution["status"]
): number {
  if (status === "FILLED" || status === "PARTIAL" || status === "GHOST_FILL") {
    return report.fillIncrementSize ?? report.filledSize ?? order.filledSize ?? order.size;
  }

  return report.orderSize ?? order.size;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (Number.isFinite(parsed) && parsed > 0) {
    return roundCrypto(parsed);
  }

  return Number.isFinite(fallback) && fallback > 0 ? roundCrypto(fallback) : 0.00000001;
}

function executionTradeId(
  report: ExecutionReport,
  status: TradeExecution["status"],
  observedAt: string
): string {
  const exchangeId = report.exchangeOrderId ?? "local";
  return `execution:${report.clientId}:${exchangeId}:${status}:${Date.parse(observedAt) || observedAt}`;
}

function inferExecutionPrimaryDriver(intent: TradeIntent | null, order: ManagedOrder): AgentName {
  const rationale = intent?.rationale.toLowerCase() ?? "";

  if (rationale.includes("hedge") || order.clientId.includes(":hedge")) {
    return "RISK";
  }

  if (intent?.traceId.includes("profiler")) {
    return "PROFILER";
  }

  return intent ? "CROUPIER" : "EXECUTIONER";
}

function resolveTickSize(env: Env, instrumentCode: string, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override;
  }

  const configured = parseTickSizeMap(env.ORDER_BOOK_TICK_SIZES)[instrumentCode];

  if (configured !== undefined) {
    return configured;
  }

  return readPositiveNumber(env.ORDER_BOOK_TICK_SIZE_DEFAULT, DEFAULT_ORDER_BOOK_TICK_SIZE);
}

function resolveDomBinSize(env: Env, instrumentCode: string, fallback: number): number {
  const configured = parsePositiveNumberMap(env.DOM_PRICE_BIN_SIZES)[instrumentCode];

  if (configured !== undefined) {
    return configured;
  }

  return readPositiveNumber(env.DOM_PRICE_BIN_SIZE_DEFAULT, fallback);
}

function parseTickSizeMap(value: string | undefined): Record<string, number> {
  return parsePositiveNumberMap(value);
}

function parsePositiveNumberMap(value: string | undefined): Record<string, number> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const entries = Object.entries(parsed)
      .map(
        ([instrumentCode, rawValue]) => [instrumentCode.toLowerCase(), Number(rawValue)] as const
      )
      .filter(([, numericValue]) => Number.isFinite(numericValue) && numericValue > 0);

    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function appendSlippagePoint(
  current: EngineState["slippage"],
  point: EngineState["slippage"]["points"][number]
): EngineState["slippage"] {
  const points = [...current.points, point].slice(-500);
  const averageSlippageBps =
    points.reduce((sum, item) => sum + item.slippageBps, 0) / Math.max(1, points.length);
  const latencyCorrelation = pearson(
    points.map((item) => item.latencyMs),
    points.map((item) => Math.abs(item.slippageBps))
  );
  const executionCostBufferBps =
    averageSlippageBps > current.executionCostBufferBps
      ? averageSlippageBps
      : current.executionCostBufferBps;

  return {
    schemaVersion: "slippage.v1",
    points,
    averageSlippageBps,
    latencyCorrelation,
    executionCostBufferBps,
    updatedAt: point.observedAt
  };
}

function quoteToTelemetry(quote: EngineState["quoteState"]["lastQuote"]): Record<string, unknown> {
  return quote
    ? {
        schemaVersion: quote.schemaVersion,
        signalId: quote.signalId,
        instrumentCode: quote.instrumentCode,
        marketKey: quote.marketKey,
        reservationPrice: quote.reservationPrice,
        optimalSpread: quote.optimalSpread,
        orderCount: quote.orders.length,
        orders: quote.orders.map((order) => ({
          clientOrderId: order.clientOrderId,
          side: order.side,
          price: order.price,
          size: order.size,
          postOnly: order.postOnly,
          strategy: order.strategy ?? "AMM",
          clusterId: order.clusterId ?? null
        })),
        createdAt: quote.createdAt
      }
    : {};
}

function quoteStateTelemetry(state: EngineState["quoteState"]): Record<string, unknown> {
  return {
    status: state.status,
    reason: state.reason,
    suspendedUntil: state.suspendedUntil,
    updatedAt: state.updatedAt
  };
}

function compareQueuedExecutionIntent(
  left: QueuedExecutionIntent,
  right: QueuedExecutionIntent
): number {
  const priorityWeight = { CANCEL: 0, NEW: 1 } as const;
  const priorityDelta = priorityWeight[left.priority] - priorityWeight[right.priority];

  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return left.runAfterMs - right.runAfterMs;
}

function returns(values: number[]): number[] {
  const output: number[] = [];

  for (let index = 1; index < values.length; index += 1) {
    output.push(values[index] - values[index - 1]);
  }

  return output;
}

function pearson(left: number[], right: number[]): number | null {
  const count = Math.min(left.length, right.length);

  if (count < 2) {
    return null;
  }

  const x = left.slice(-count);
  const y = right.slice(-count);
  const meanX = x.reduce((sum, value) => sum + value, 0) / count;
  const meanY = y.reduce((sum, value) => sum + value, 0) / count;
  let numerator = 0;
  let varianceX = 0;
  let varianceY = 0;

  for (let index = 0; index < count; index += 1) {
    const dx = x[index] - meanX;
    const dy = y[index] - meanY;
    numerator += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator > 0 ? roundMetric(numerator / denominator, 8) : null;
}

function safeParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeReplayDate(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sanitizeReplayScenario(value: string | undefined): ReplayScenario {
  return value === "FLASH_CRASH" ||
    value === "DELEVERAGING_2022" ||
    value === "LATENCY_SHOCK" ||
    value === "BASELINE"
    ? value
    : "BASELINE";
}

function nonNegativeFiniteNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function applyReplayScenarioToTick(
  tick: MarketTick,
  scenario: ReplayScenario,
  index: number,
  total: number
): MarketTick {
  if (scenario === "BASELINE" || tick.price <= 0 || total <= 0) {
    return tick;
  }

  const progress = index / Math.max(1, total - 1);
  let priceMultiplier = 1;
  let sizeMultiplier = 1;

  if (scenario === "FLASH_CRASH" && progress > 0.35 && progress < 0.55) {
    const crashProgress = (progress - 0.35) / 0.2;
    priceMultiplier = 1 - 0.08 * Math.sin(Math.PI * crashProgress);
    sizeMultiplier = 3;
  } else if (scenario === "DELEVERAGING_2022") {
    priceMultiplier = 1 - 0.18 * progress;
    sizeMultiplier = 1.4 + progress;
  } else if (scenario === "LATENCY_SHOCK") {
    priceMultiplier = 1 + Math.sin(progress * Math.PI * 12) * 0.0025;
    sizeMultiplier = 1.15;
  }

  return {
    ...tick,
    price: roundCrypto(tick.price * priceMultiplier),
    size: roundCrypto(tick.size * sizeMultiplier),
    raw: {
      ...(tick.raw ?? {}),
      replayScenario: scenario
    }
  };
}

function modelReplayIntentTrade(
  intent: TradeIntent | null,
  tick: MarketTick,
  ticks: MarketTick[],
  index: number,
  options: ReplayOptions,
  regime: ReplayResult["shadowTrades"][number]["regime"]
): ReplayResult["shadowTrades"][number] | null {
  if (!intent) {
    return null;
  }

  const size = intent.approvedSize ?? intent.requestedSize;
  const referencePrice = intent.expectedPrice > 0 ? intent.expectedPrice : tick.price;
  if (size <= 0 || referencePrice <= 0) {
    return null;
  }

  const exitTick = findReplayExitTick(ticks, intent.instrumentCode, index, options.exitAfterTicks);
  if (!exitTick || exitTick.price <= 0) {
    return null;
  }

  const latencyPenaltyBps =
    options.scenario === "LATENCY_SHOCK"
      ? Math.max(options.latencyMs * 0.02, 2)
      : options.latencyMs * 0.005;
  const effectiveSlippageBps = options.slippageBps + latencyPenaltyBps;
  const entrySlippage = effectiveSlippageBps / 10_000;
  const entryPrice =
    intent.action === "BUY"
      ? referencePrice * (1 + entrySlippage)
      : referencePrice * (1 - entrySlippage);
  const exitPrice = exitTick.price;
  const grossPnl =
    intent.action === "BUY" ? (exitPrice - entryPrice) * size : (entryPrice - exitPrice) * size;
  const fees = ((entryPrice + exitPrice) * size * options.feeBps) / 10_000;

  return {
    tradeId: `replay:${intent.intentId}`,
    instrumentCode: intent.instrumentCode,
    side: intent.action,
    entryPrice: roundCrypto(entryPrice),
    exitPrice: roundCrypto(exitPrice),
    size: roundCrypto(size),
    theoreticalPnl: roundMetric(grossPnl - fees, 8),
    fees: roundMetric(fees, 8),
    slippageBps: roundMetric(effectiveSlippageBps, 4),
    driver: inferIntentDriver(intent),
    regime: regime ?? "UNKNOWN",
    openedAt: tick.receivedAt,
    closedAt: exitTick.receivedAt
  };
}

function findReplayExitTick(
  ticks: MarketTick[],
  instrumentCode: string,
  index: number,
  exitAfterTicks: number
): MarketTick | null {
  let seen = 0;
  for (let cursor = index + 1; cursor < ticks.length; cursor += 1) {
    const candidate = ticks[cursor];
    if (candidate.instrumentCode !== instrumentCode) {
      continue;
    }
    seen += 1;
    if (seen >= exitAfterTicks) {
      return candidate;
    }
  }

  for (let cursor = ticks.length - 1; cursor > index; cursor -= 1) {
    if (ticks[cursor].instrumentCode === instrumentCode) {
      return ticks[cursor];
    }
  }

  return null;
}

function inferIntentDriver(intent: TradeIntent): AgentName | "UNATTRIBUTED" {
  const text = intent.rationale.toUpperCase();
  if (text.includes("PROFILER") || text.includes("VPIN")) {
    return "PROFILER";
  }
  if (text.includes("ORACLE") || text.includes("REGIME")) {
    return "ORACLE";
  }
  if (text.includes("SENTIMENT")) {
    return "SENTIMENT";
  }
  if (text.includes("MOLTWORKER")) {
    return "MOLTWORKER";
  }
  return "CROUPIER";
}

function buildReplayAttribution(
  trades: ReplayResult["shadowTrades"]
): NonNullable<ReplayResult["attribution"]> {
  return {
    byAgent: bucketReplayTrades(trades, (trade) => trade.driver ?? "UNATTRIBUTED"),
    byAsset: bucketReplayTrades(trades, (trade) => trade.instrumentCode),
    byRegime: bucketReplayTrades(trades, (trade) => trade.regime ?? "UNKNOWN")
  };
}

function bucketReplayTrades(
  trades: ReplayResult["shadowTrades"],
  keyFn: (trade: ReplayResult["shadowTrades"][number]) => string
): NonNullable<ReplayResult["attribution"]>["byAgent"] {
  const buckets = new Map<string, ReplayResult["shadowTrades"]>();
  for (const trade of trades) {
    const key = keyFn(trade);
    const bucket = buckets.get(key) ?? [];
    bucket.push(trade);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()].map(([key, bucket]) => {
    const pnl = bucket.map((trade) => trade.theoreticalPnl);
    const grossProfit = pnl.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
    const grossLoss = Math.abs(
      pnl.filter((value) => value < 0).reduce((sum, value) => sum + value, 0)
    );
    return {
      key,
      tradeCount: bucket.length,
      pnl: roundMetric(
        pnl.reduce((sum, value) => sum + value, 0),
        8
      ),
      grossProfit: roundMetric(grossProfit, 8),
      grossLoss: roundMetric(grossLoss, 8),
      winRate: calculateWinRate(bucket),
      sharpe: calculateReplaySharpe(pnl)
    };
  });
}

function buildReplayEquityCurve(
  initialBankroll: number,
  trades: ReplayResult["shadowTrades"]
): number[] {
  const curve = [initialBankroll];
  let equity = initialBankroll;
  for (const trade of trades) {
    equity += trade.theoreticalPnl;
    curve.push(equity);
  }
  return curve;
}

function calculateMaxDrawdown(equityCurve: number[]): number {
  let peak = equityCurve[0] ?? 0;
  let maxDrawdown = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    }
  }
  return roundMetric(maxDrawdown, 8);
}

function calculateReplaySharpe(pnls: number[]): number | null {
  if (pnls.length < 2) {
    return null;
  }
  const mean = pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length;
  const variance = pnls.reduce((sum, pnl) => sum + (pnl - mean) ** 2, 0) / (pnls.length - 1);
  const sigma = Math.sqrt(variance);
  return sigma > 0 ? roundMetric((mean / sigma) * Math.sqrt(pnls.length), 6) : null;
}

function calculateWinRate(trades: ReplayResult["shadowTrades"]): number | null {
  return trades.length > 0
    ? roundMetric(trades.filter((trade) => trade.theoreticalPnl > 0).length / trades.length, 6)
    : null;
}

function buildStressSummary(
  trades: ReplayResult["shadowTrades"],
  generatedIntentCount: number
): ReplayResult["stressResults"] {
  const equity = buildReplayEquityCurve(0, trades);
  return [
    {
      scenario: "BASELINE",
      pnl: roundMetric(
        trades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0),
        8
      ),
      maxDrawdown: calculateMaxDrawdown(equity),
      generatedIntentCount,
      simulatedTradeCount: trades.length
    }
  ];
}

function buildReplayWalkForward(
  trades: ReplayResult["shadowTrades"],
  segments: number
): NonNullable<ReplayResult["walkForward"]> {
  if (trades.length === 0) {
    return [];
  }

  const safeSegments = Math.min(segments, trades.length);
  const chunkSize = Math.ceil(trades.length / safeSegments);
  const rows: NonNullable<ReplayResult["walkForward"]> = [];
  for (let segment = 0; segment < safeSegments; segment += 1) {
    const bucket = trades.slice(segment * chunkSize, (segment + 1) * chunkSize);
    if (bucket.length === 0) {
      continue;
    }
    const pnl = bucket.reduce((sum, trade) => sum + trade.theoreticalPnl, 0);
    rows.push({
      segment: segment + 1,
      dateFrom: bucket[0].openedAt,
      dateTo: bucket.at(-1)?.closedAt ?? bucket.at(-1)?.openedAt ?? null,
      pnl: roundMetric(pnl, 8),
      sharpe: calculateReplaySharpe(bucket.map((trade) => trade.theoreticalPnl)),
      maxDrawdown: calculateMaxDrawdown(buildReplayEquityCurve(0, bucket)),
      tradeCount: bucket.length
    });
  }
  return rows;
}

function buildReplayAblation(
  trades: ReplayResult["shadowTrades"],
  sentiment: SentimentState
): ReplayResult["ablation"] {
  const sentimentTrades = trades.filter((trade) => trade.driver === "SENTIMENT");
  const sentimentEnabledPnl = trades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0);
  const sentimentContribution = sentimentTrades.reduce(
    (sum, trade) => sum + trade.theoreticalPnl,
    0
  );
  const estimatedAiCostUsd = Number(sentiment.estimatedCostUsd ?? 0);
  const sentimentDisabledPnl = sentimentEnabledPnl - sentimentContribution;
  return {
    sentimentEnabledPnl: roundMetric(sentimentEnabledPnl, 8),
    sentimentDisabledPnl: roundMetric(sentimentDisabledPnl, 8),
    deltaPnl: roundMetric(sentimentContribution, 8),
    estimatedAiCostUsd,
    netEdgeAfterCosts: roundMetric(sentimentContribution - estimatedAiCostUsd, 8)
  };
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

function readBoundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

function resolveGhostBookConfig(env: Env): GhostBookConfig {
  return {
    capacity: readPositiveInteger(
      env.SHADOW_VLO_CAPACITY,
      DEFAULT_SHADOW_VLO_CAPACITY,
      128,
      16_384
    ),
    driftTradeDelay: readPositiveInteger(
      env.SHADOW_VLO_DRIFT_TRADES,
      DEFAULT_SHADOW_VLO_DRIFT_TRADES,
      1,
      100
    ),
    queueDepthMultiplier: readBoundedNumber(
      env.SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
      DEFAULT_SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER,
      0,
      10
    ),
    baseSpreadBps: readPositiveNumber(
      env.SHADOW_VLO_BASE_SPREAD_BPS,
      DEFAULT_SHADOW_VLO_BASE_SPREAD_BPS
    ),
    latencyBudgetMs: readPositiveNumber(
      env.SHADOW_VLO_LATENCY_BUDGET_MS,
      DEFAULT_SHADOW_VLO_LATENCY_BUDGET_MS
    ),
    minSize: readPositiveNumber(env.SHADOW_VLO_MIN_SIZE, DEFAULT_SHADOW_VLO_MIN_SIZE)
  };
}

function clampInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function assertOrderBookSnapshot(value: OrderBookSnapshot): OrderBookSnapshot {
  if (
    value?.schemaVersion !== "order-book.snapshot.v1" ||
    typeof value.instrumentCode !== "string" ||
    typeof value.exchangeCode !== "string" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    typeof value.exchangeTimestamp !== "string" ||
    !Array.isArray(value.bids) ||
    !Array.isArray(value.asks) ||
    !value.bids.every(isValidSnapshotLevel) ||
    !value.asks.every(isValidSnapshotLevel)
  ) {
    throw new Error("INVALID_ORDER_BOOK_SNAPSHOT");
  }

  return value;
}

function assertOrderBookDelta(value: OrderBookDelta): OrderBookDelta {
  if (
    value?.schemaVersion !== "order-book.delta.v1" ||
    typeof value.instrumentCode !== "string" ||
    typeof value.exchangeCode !== "string" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    typeof value.exchangeTimestamp !== "string" ||
    typeof value.receivedAt !== "string" ||
    (value.side !== "bid" && value.side !== "ask") ||
    typeof value.price !== "number" ||
    !Number.isFinite(value.price) ||
    value.price < 0 ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    value.size < 0
  ) {
    throw new Error("INVALID_ORDER_BOOK_DELTA");
  }

  return value;
}

function isValidSnapshotLevel(level: OrderBookSnapshotLevel): boolean {
  return (
    typeof level?.price === "number" &&
    Number.isFinite(level.price) &&
    level.price >= 0 &&
    typeof level.size === "number" &&
    Number.isFinite(level.size) &&
    level.size >= 0
  );
}

function assertMarketTick(value: MarketTick): MarketTick {
  if (
    value?.schemaVersion !== "universal-tick.v1" ||
    typeof value.source !== "string" ||
    typeof value.source_exchange !== "string" ||
    typeof value.instrumentCode !== "string" ||
    typeof value.exchangeCode !== "string" ||
    typeof value.price !== "number" ||
    !Number.isFinite(value.price) ||
    value.price < 0 ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    typeof value.sequence !== "number" ||
    typeof value.exchangeTimestamp !== "string" ||
    typeof value.synchronizedExchangeTimestamp !== "string" ||
    typeof value.clockOffsetMs !== "number" ||
    typeof value.receivedAt !== "string"
  ) {
    throw new Error("INVALID_MARKET_TICK");
  }

  return value;
}

function assertAgentSignal(value: AgentSignal): AgentSignal {
  const agentNames: AgentName[] = [
    "ORACLE",
    "SENTIMENT",
    "PROFILER",
    "CROUPIER",
    "PIT_BOSS",
    "JANITOR",
    "EXECUTIONER",
    "MOLTWORKER",
    "RISK",
    "SYSTEM"
  ];
  const actions = [
    "BUY",
    "SELL",
    "HOLD",
    "CANCEL",
    "REDUCE",
    "QUOTE",
    "EXECUTE",
    "PAUSE",
    "RESUME",
    "SUPERVISOR_ACTION"
  ];

  if (
    typeof value?.signalId !== "string" ||
    typeof value.traceId !== "string" ||
    !agentNames.includes(value.sourceAgent) ||
    !agentNames.includes(value.targetAgent) ||
    !actions.includes(value.action) ||
    typeof value.instrumentCode !== "string" ||
    typeof value.confidence !== "number" ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new Error("INVALID_AGENT_SIGNAL");
  }

  return value;
}

function readTelemetryNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isInformationalTick(tick: MarketTick): boolean {
  const eventType = typeof tick.raw?.eventType === "string" ? tick.raw.eventType.toLowerCase() : "";
  const commodity = typeof tick.raw?.commodity === "string" ? tick.raw.commodity.toUpperCase() : "";

  return (
    eventType === "trade" ||
    eventType === "funding" ||
    eventType === "book-snapshot" ||
    commodity === "TRADE" ||
    commodity === "FUNDING"
  );
}

function isTradeTick(tick: MarketTick): boolean {
  const eventType = typeof tick.raw?.eventType === "string" ? tick.raw.eventType.toLowerCase() : "";
  const commodity = typeof tick.raw?.commodity === "string" ? tick.raw.commodity.toUpperCase() : "";

  return eventType === "trade" || commodity === "TRADE";
}

function extractTickStreamId(tick: MarketTick): string | null {
  const direct = tick.streamId?.trim();
  if (direct) {
    return direct;
  }

  const rawStreamId = tick.raw?.streamId;
  return typeof rawStreamId === "string" && rawStreamId.trim() ? rawStreamId.trim() : null;
}

async function readHyperliquidRawIngestPayload(
  request: Request
): Promise<HyperliquidRawIngestPayload> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/x-msgpack")) {
    const decoded = msgpackDecode(new Uint8Array(await request.arrayBuffer()));

    if (!isPlainObject(decoded)) {
      throw new Error("INVALID_HYPERLIQUID_MSGPACK_PAYLOAD");
    }

    return decoded as unknown as HyperliquidRawIngestPayload;
  }

  return request.json<HyperliquidRawIngestPayload>();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldAggregateBusTelemetry(type: string): boolean {
  return AGGREGATED_BUS_TELEMETRY_TYPES.has(type);
}

function decodeWebSocketMessage(data: string | ArrayBuffer): string | null {
  if (typeof data === "string") {
    return data;
  }

  return new TextDecoder().decode(data);
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function readJsonOrNull<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8"
    }
  });
}
