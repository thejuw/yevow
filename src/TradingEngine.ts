import { ConfigManager, defaultConfig } from "./ConfigManager";
import { Governor, neutralMacroBias } from "./Governor";
import { Logger } from "./Logger";
import {
  ProfilerAgent,
  PROFILER_STATE_STORAGE_KEY
} from "./agents/ProfilerAgent";
import {
  AnomalyDetector,
  ANOMALY_DETECTOR_STORAGE_KEY,
  type AnomalyDetectionResult
} from "./agents/AnomalyDetector";
import { CroupierAgent } from "./agents/CroupierAgent";
import { HedgeAgent } from "./agents/HedgeAgent";
import { JanitorAgent } from "./agents/JanitorAgent";
import { OracleAgent, defaultOracleState } from "./agents/OracleAgent";
import { PitBossAgent } from "./agents/PitBossAgent";
import {
  SentimentAgent,
  defaultSentimentState
} from "./agents/SentimentAgent";
import { camouflageIntent } from "./utils/Camouflage";
import {
  RateLimiter,
  type RateLimitBucketSnapshot
} from "./utils/RateLimiter";
import { planSmartOrderRoute } from "./utils/SOR";
import { Notifier } from "./utils/Notifier";
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
  BookSnapshotResponse,
  ExchangeOpenOrder,
  ExecutionReport,
  EngineState,
  Env,
  GlobalRiskConfig,
  HealthReport,
  InternalOrderBook,
  JsonRecord,
  JsonValue,
  LatencyMetrics,
  LiquidityWall,
  MacroBias,
  MarketDataSource,
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
  TemporaryGovernanceOverride,
  TradeExecution,
  TradeIntent
} from "./types";

const ENGINE_STATE_KEY = "engine:state";
const ORDER_BOOK_PREFIX = "book:";
const PERFORMANCE_HISTORY_KEY = "performance:latency-history";
const REPLAY_STATUS_KEY = "replay:status";
const RISK_LIMITS_KEY = "risk:limits";
const CONFIG_KEY = "engine:config";
const DEFAULT_MAX_LATENCY_MS = 250;
const DEFAULT_HARD_STALE_DROP_MS = 1_000;
const PERFORMANCE_HISTORY_LIMIT = 100;
const CONFIG_ALARM_INTERVAL_MS = 5_000;
const CRYPTO_DECIMAL_PLACES = 8;
const PRICE_SCALE = 100_000_000;
const TOPOLOGY_HEADER_PREFIX = "x-sovereign-topology-";
const WARM_UP_INTERVAL_MS = 60_000;
const DEFAULT_HIGH_LATENCY_COLO_RISK_MULTIPLIER = 0.5;
const SIGNAL_BUFFER_LIMIT = 500;
const TELEMETRY_FLUSH_INTERVAL_MS = 5_000;
const TELEMETRY_BUFFER_LIMIT = 1_000;
const ADMIN_STREAM_PULSE_INTERVAL_MS = 500;
const AGENT_SNAPSHOT_TICK_INTERVAL = 1_000;
const HOT_STORAGE_SNAPSHOT_INTERVAL_MS = 15_000;
const HOT_STORAGE_SNAPSHOT_TICK_INTERVAL = 1_000;
const STORAGE_WRITE_BACKOFF_MS = 60_000;
const BOOK_SNAPSHOT_TOP_LEVELS = 50;
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
const DEFAULT_RISK_AVERSION_FACTOR = 0.01;
const DEFAULT_AMM_MIN_TICK_CHANGE = 0.00000001;
const DEFAULT_WHALE_PRINT_Z_THRESHOLD = 5;
const DEFAULT_QUOTE_HIBERNATE_MS = 3_000;
const DEFAULT_VAR_CONFIDENCE_Z = 2.326;
const DEFAULT_JANITOR_INTERVAL_MS = 60_000;
const DEFAULT_ORDER_ACK_TIMEOUT_MS = 2_000;
const DEFAULT_REPLAY_LIMIT = 250;

interface TickIngestResult {
  accepted: boolean;
  status:
    | LatencyMetrics["status"]
    | "DISABLED"
    | "ANOMALY_PAUSE"
    | "DESYNC"
    | "DUPLICATE_OR_OUT_OF_ORDER"
    | "STALE_DROPPED"
    | "BOOK_NOT_READY";
  reason?: string;
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
  reason?:
    | "SEQUENCE_GAP"
    | "DUPLICATE_OR_OUT_OF_ORDER"
    | "UNKNOWN_SIDE"
    | "CROSSED_BOOK";
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
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
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
  priority: "CANCEL" | "HEDGE" | "NEW";
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
  private readonly profilerAgent: ProfilerAgent;
  private readonly anomalyDetector: AnomalyDetector;
  private readonly sentimentAgent = new SentimentAgent();
  private readonly oracleAgent = new OracleAgent();
  private readonly croupierAgent: CroupierAgent;
  private readonly pitBossAgent = new PitBossAgent(0.5);
  private readonly hedgeAgent = new HedgeAgent();
  private readonly janitorAgent = new JanitorAgent();
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
  private readonly adminSockets = new Set<WebSocket>();
  private signals: AgentSignal[] = [];
  private latestAgentSignals = new Map<AgentName, AgentSignal>();
  private telemetryBuffer: TelemetryLogEntry[] = [];
  private tickTelemetryAggregate: TickTelemetryAggregate | null = null;
  private eventTelemetryAggregates = new Map<string, EventTelemetryAggregate>();
  private telemetryFlushScheduled = false;
  private busSequence = 0;
  private latencyHistory: LatencyMetrics[] = [];
  private processingLatencySamples: number[] = [];
  private domWallHistory: LiquidityWall[] = [];
  private leadLagSamples = new Map<string, Array<{ price: number; observedAt: string }>>();
  private maxLatencyMs = DEFAULT_MAX_LATENCY_MS;
  private latestWakeUpTimeMs: number | null = null;
  private lastPerformanceStatus: EngineStabilityStatus = "STABLE";
  private lastTickTimestamp: string | null = null;
  private cachedConfig: GlobalRiskConfig = { ...defaultConfig };
  private macroBias: MacroBias = neutralMacroBias();
  private activeTemporaryOverride: TemporaryGovernanceOverride | null = null;
  private killSwitchLogged = false;
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
    this.configManager = new ConfigManager(env.CONFIG_STORE);
    this.governor = new Governor(env.CONFIG_STORE);
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
      bucketSize: readPositiveNumber(
        env.PROFILER_BUCKET_VOLUME,
        DEFAULT_PROFILER_BUCKET_VOLUME
      ),
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
      minTickChange: readPositiveNumber(
        env.AMM_MIN_TICK_CHANGE,
        DEFAULT_AMM_MIN_TICK_CHANGE
      )
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
      })
    );
    this.notifier = new Notifier(env, (promise) => this.state.waitUntil(promise));

    this.initialized = this.state.blockConcurrencyWhile(async () => {
      let persistedState: EngineState | undefined;
      let persistedBooks = new Map<string, InternalOrderBook>();
      let persistedLatencyHistory: LatencyMetrics[] | undefined;
      let persistedProcessingLatencySamples: number[] | undefined;
      let persistedDomWallHistory: LiquidityWall[] | undefined;
      let persistedProfilerState: ProfilerState | undefined;
      let persistedAnomalyState: AnomalyDetectorState | undefined;
      let persistedRateLimits: Record<string, RateLimitBucketSnapshot> | undefined;
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
          persistedAnomalyState,
          persistedRateLimits,
          kvRiskLimits,
          kvConfig
        ] = await Promise.all([
          this.state.storage.get<EngineState>(ENGINE_STATE_KEY),
          this.state.storage.list<InternalOrderBook>({ prefix: ORDER_BOOK_PREFIX }),
          this.state.storage.get<LatencyMetrics[]>(PERFORMANCE_HISTORY_KEY),
          this.state.storage.get<number[]>(PROCESSING_LATENCY_SAMPLES_KEY),
          this.state.storage.get<LiquidityWall[]>(DOM_WALL_HISTORY_KEY),
          this.state.storage.get<ProfilerState>(PROFILER_STATE_STORAGE_KEY),
          this.state.storage.get<AnomalyDetectorState>(ANOMALY_DETECTOR_STORAGE_KEY),
          this.state.storage.get<Record<string, RateLimitBucketSnapshot>>(RATE_LIMIT_STATE_KEY),
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

      const hydratedBooks = hydrateOrderBooks(persistedBooks);

      this.orderBook = hydratedBooks.snapshots;
      this.bids = hydratedBooks.bids;
      this.asks = hydratedBooks.asks;
      this.bookSync = hydratedBooks.sync;
      this.profilerAgent.hydrate(persistedProfilerState);
      this.anomalyDetector.hydrate(persistedAnomalyState);
      this.rateLimiter.hydrate(persistedRateLimits);
      this.oracleAgent.hydrate(baseState.oracle);
      this.sentimentAgent.hydrate(baseState.sentiment);
      this.lastTickTimestamp =
        baseState.microstructure?.updatedAt ?? baseState.updatedAt ?? null;
      this.latencyHistory = (persistedLatencyHistory ?? []).slice(
        -PERFORMANCE_HISTORY_LIMIT
      );
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
      this.cachedConfig = effectiveGovernance.config;
      this.macroBias = effectiveGovernance.macroBias;
      this.activeTemporaryOverride = effectiveGovernance.temporaryOverride;
      this.maxLatencyMs = this.cachedConfig.LATENCY_THRESHOLD_MS;
      const location = baseState.location ?? defaultEngineLocation();
      const risk = applyLocationRisk(
        mergeRiskLimits(mergeRiskLimits(baseState.risk, kvRiskLimits), kvConfig?.risk),
        this.cachedConfig,
        location,
        now
      );
      this.engineState = {
        ...baseState,
        mode: kvConfig?.mode ?? baseState.mode,
        bankroll: {
          ...baseState.bankroll,
          ...kvConfig?.bankroll,
          updatedAt: now
        },
        agentHealth: {
          ...defaultEngineState(baseState.engineId).agentHealth,
          ...baseState.agentHealth
        },
        risk,
        internalOrderBookDepth: countBookLevels(this.bids, this.asks),
        averageLatency: baseState.averageLatency ?? 0,
        latencySampleCount: baseState.latencySampleCount ?? 0,
        staleTickCount: baseState.staleTickCount ?? 0,
        toxicityScore: baseState.toxicityScore ?? this.profilerAgent.toxicityScore,
        maxLatencyMs: this.maxLatencyMs,
        cachedConfig: this.cachedConfig,
        macroBias: this.macroBias,
        temporaryOverride: this.activeTemporaryOverride,
        location,
        fundingRates: baseState.fundingRates ?? {},
        microstructure: baseState.microstructure ?? defaultMicrostructure(),
        priceDiscovery:
          baseState.priceDiscovery ??
          this.calculatePriceDiscovery(baseState.microstructure?.instrumentCode, now),
        oracle: baseState.oracle ?? defaultOracleState(),
        sentiment: baseState.sentiment ?? defaultSentimentState(),
        leadLag: baseState.leadLag ?? defaultLeadLagMetrics(),
        inventory: baseState.inventory ?? defaultInventoryState(readPositiveNumber(
          this.env.MAX_INVENTORY_UNITS,
          DEFAULT_MAX_INVENTORY_UNITS
        )),
        riskMetrics: baseState.riskMetrics ?? defaultRiskMetrics(
          baseState.bankroll.equity,
          now
        ),
        quoteState: baseState.quoteState ?? defaultQuoteState(),
        lastTradeIntent: baseState.lastTradeIntent ?? null,
        hedge: baseState.hedge ?? defaultHedgeState(),
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
        hasKaikoApiKey: Boolean(this.env.KAIKO_API_KEY),
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

    this.observeTopology(topology);
    this.warmUpForTopology(topology);

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
        return json(this.healthCheck());
      }

      if (request.method === "GET" && url.pathname === "/state") {
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
        this.resetLatencyBaseline(observedAt, "ADMIN_MAINTENANCE");
        await this.safeStoragePut({
          [ENGINE_STATE_KEY]: this.engineState,
          [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
          [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples
        }, "ADMIN_RESET_LATENCY");
        return json({ ok: true, state: this.engineState });
      }

      if (request.method === "GET" && url.pathname === "/book/snapshot") {
        const instrumentCode =
          url.searchParams.get("instrumentCode") ??
          url.searchParams.get("instrument") ??
          undefined;
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
          url.searchParams.get("instrumentCode") ??
          url.searchParams.get("instrument") ??
          undefined;

        return json(this.currentDomHeatmap(instrumentCode));
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
        const payload =
          (await readJsonOrNull<Partial<OrderBookResetRequest>>(request)) ?? {};
        await this.enqueueOrderBookReset(payload);
        return json({ ok: true, state: this.engineState });
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
            payload?.speedMultiplier === undefined
              ? undefined
              : String(payload.speedMultiplier),
            1
          ),
          sanitizeReplayDate(payload?.dateFrom ?? payload?.from),
          sanitizeReplayDate(payload?.dateTo ?? payload?.to)
        );
        return json({ ok: true, replay: result, state: this.engineState });
      }

      if (request.method === "GET" && url.pathname === "/admin/replay/status") {
        return json({
          ok: true,
          replay: await this.currentReplayStatus()
        });
      }

      if (request.method === "POST" && url.pathname === "/news/sentiment") {
        const payload = await request.json<{
          headline?: string;
          source?: string;
          url?: string | null;
          publishedAt?: string | null;
          id?: string;
        }>();
        const sentiment = await this.sentimentAgent.analyzeHeadline(
          payload.headline ?? "",
          this.env
        );
        this.engineState = {
          ...this.engineState,
          sentiment,
          heartbeatAt: sentiment.updatedAt ?? new Date().toISOString(),
          updatedAt: sentiment.updatedAt ?? new Date().toISOString()
        };
        await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "SENTIMENT_UPDATED");
        this.logger.info("SENTIMENT_UPDATED", "Sentiment agent updated headline bias", {
          score: sentiment.score,
          bias: sentiment.bias,
          model: sentiment.model,
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
          url.pathname === "/ingest/kaiko")
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
        const terminalResult = results.find((result) => result.status === "DESYNC") ?? results.at(-1);

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
      cachedConfig: this.engineState.cachedConfig,
      location: this.engineState.location,
      microstructure: this.engineState.microstructure,
      priceDiscovery: this.engineState.priceDiscovery,
      oracle: this.engineState.oracle,
      sentiment: this.engineState.sentiment,
      leadLag: this.engineState.leadLag,
      inventory: this.engineState.inventory,
      riskMetrics: this.engineState.riskMetrics,
      quoteState: this.engineState.quoteState,
      slippage: this.engineState.slippage,
      executionProfile: this.engineState.executionProfile,
      dom: this.engineState.dom,
      anomaly: this.engineState.anomaly,
      memoryUsage: {
        available: Boolean(memory),
        usedJSHeapSize: memory?.usedJSHeapSize ?? null,
        totalJSHeapSize: memory?.totalJSHeapSize ?? null,
        jsHeapSizeLimit: memory?.jsHeapSizeLimit ?? null,
        stateBytesEstimate: JSON.stringify({
          state: this.engineState,
          orderBookDepth: this.engineState.internalOrderBookDepth
        }).length
      }
    };
  }

  private async safeStoragePut(
    key: string,
    value: unknown,
    reason: string
  ): Promise<void>;
  private async safeStoragePut(
    entries: Record<string, unknown>,
    reason: string
  ): Promise<void>;
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
        ? maybeReason ?? "STORAGE_WRITE"
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

  private waitUntilStoragePut(
    key: string,
    value: unknown,
    reason: string
  ): void {
    this.state.waitUntil(this.safeStoragePut(key, value, reason));
  }

  private waitUntilStoragePutEntries(
    entries: Record<string, unknown>,
    reason: string
  ): void {
    this.state.waitUntil(this.safeStoragePut(entries, reason));
  }

  private async safeStorageDelete(
    keys: string[],
    reason: string
  ): Promise<void> {
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
    const dueByTime = now - this.lastHotStorageSnapshotAt >= HOT_STORAGE_SNAPSHOT_INTERVAL_MS;
    const dueByTicks =
      tickCount - this.lastHotStorageSnapshotTick >= HOT_STORAGE_SNAPSHOT_TICK_INTERVAL;

    if (!dueByTime && !dueByTicks) {
      return;
    }

    this.lastHotStorageSnapshotAt = now;
    this.lastHotStorageSnapshotTick = tickCount;
    await this.safeStoragePut(entries, reason);
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

    return {
      schemaVersion: "admin.dashboard-pulse.v1",
      total_equity: equity,
      unrealized_pnl: unrealizedPnl,
      active_drawdown: this.engineState.riskMetrics.rollingDrawdownPct,
      current_imbalance: this.engineState.microstructure.weightedImbalance,
      processed_ticks: this.engineState.processedTicks,
      mode: this.engineState.mode,
      quote_state: this.engineState.quoteState.status,
      toxicity_score: this.engineState.toxicityScore,
      latency_ms: this.engineState.averageLatency,
      jitter_ms: this.engineState.executionProfile.jitterMs,
      regime: this.engineState.oracle.regime,
      regimeCoefficient: this.engineState.oracle.skepticismMultiplier,
      macroBias: this.macroBias,
      temporaryOverride: this.activeTemporaryOverride,
      AgentLogicTrace: latestSignals,
      sparkline: this.latencyHistory.slice(-60).map((metric) => ({
        t: metric.brainTimestamp,
        latency: metric.totalLatencyMs,
        imbalance: metric.status === "FRESH" ? this.engineState.microstructure.weightedImbalance : null
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

  private enqueueOrderBookReset(
    payload: Partial<OrderBookResetRequest>
  ): Promise<void> {
    const job = this.ingestQueue.then(() => this.resetOrderBook(payload));
    this.ingestQueue = job.then(
      () => undefined,
      () => undefined
    );
    return job;
  }

  private async resetOrderBook(
    payload: Partial<OrderBookResetRequest>
  ): Promise<void> {
    const now = new Date().toISOString();
    const reason =
      typeof payload.reason === "string" && payload.reason.length > 0
        ? payload.reason
        : "UNSPECIFIED_RESET";
    const source = payload.source ?? "SYSTEM";
    const blackoutDurationMs =
      typeof payload.blackoutDurationMs === "number" &&
      Number.isFinite(payload.blackoutDurationMs)
        ? Math.max(0, Math.round(payload.blackoutDurationMs))
        : null;
    const resetInstrument = payload.instrumentCode?.toLowerCase() ?? null;
    const resetSourceExchange = payload.source_exchange
      ? normalizeSourceExchange(payload.source_exchange)
      : null;
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
      instrumentCode: resetInstrument,
      source_exchange: resetSourceExchange,
      marketKey: resetMarketKey,
      connectionId: payload.connectionId ?? null,
      blackoutDurationMs,
      recoveredAt: payload.recoveredAt ?? now,
      deletedBookSnapshots: deleteKeys.length
    });
  }

  private async applySnapshot(snapshot: OrderBookSnapshot): Promise<InternalOrderBook> {
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

    await this.safeStoragePut({
      [ENGINE_STATE_KEY]: this.engineState,
      [DOM_WALL_HISTORY_KEY]: this.domWallHistory,
      [`${ORDER_BOOK_PREFIX}${marketKey}`]: book
    }, "ORDER_BOOK_SNAPSHOT_APPLIED");

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
    const enforceExactSequence = delta.source === "KAIKO";

    if (enforceExactSequence && expectedSequence !== undefined && delta.sequence > expectedSequence) {
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
      if (delta.source === "KAIKO" || delta.sequence % 100 === 0) {
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

    const requested = target?.toLowerCase();

    if (requested && this.orderBook.has(requested)) {
      const book = this.orderBook.get(requested);
      return {
        marketKey: requested,
        instrumentCode: book?.instrumentCode ?? requested.split(":").slice(1).join(":")
      };
    }

    const instrumentCode = requested?.includes(":")
      ? requested.split(":").slice(1).join(":")
      : requested;
    const candidates = [...this.orderBook.values()]
      .filter((book) => !instrumentCode || book.instrumentCode === instrumentCode)
      .sort((left, right) => {
        const weightDelta = right.sourceWeight - left.sourceWeight;

        if (weightDelta !== 0) {
          return weightDelta;
        }

        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      });
    const selected = candidates[0] ?? [...this.orderBook.values()][0];

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
            sources.reduce(
              (sum, source) => sum + (source.midPrice ?? 0) * source.weight,
              0
            ) / totalWeight
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
      instrumentCode?.toLowerCase() ??
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
      this.domWallHistory.splice(
        0,
        this.domWallHistory.length - this.domWallHistoryLimit
      );
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

  private maybeCrossCheckTopOfBook(
    delta: BookDeltaWithTicker,
    book: InternalOrderBook
  ): void {
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

    const metrics = this.calculateLatency(tick);
    const hardStaleDropMs = readPositiveNumber(
      this.env.KAIKO_STALE_AFTER_MS,
      DEFAULT_HARD_STALE_DROP_MS
    );
    const isHardStale =
      !options.shadowReplay && metrics.totalLatencyMs > hardStaleDropMs;

    if (isHardStale) {
      const nextStaleTickCount = this.engineState.staleTickCount + 1;
      metrics.status = "STALE";
      metrics.maxLatencyMs = this.maxLatencyMs;
      metrics.averageLatencyMs = this.engineState.averageLatency;
      metrics.sampleCount = this.engineState.latencySampleCount;

      this.engineState = {
        ...this.engineState,
        processedTicks: this.engineState.processedTicks + 1,
        staleTickCount: nextStaleTickCount,
        heartbeatAt: metrics.brainTimestamp,
        updatedAt: metrics.brainTimestamp
      };

      if (this.engineState.averageLatency > hardStaleDropMs) {
        this.resetLatencyBaseline(metrics.brainTimestamp, "HARD_STALE_DROP");
      }

      await this.persistHotStorageSnapshot({
        [ENGINE_STATE_KEY]: this.engineState,
        [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
        [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples
      }, "HARD_STALE_TICK_DROPPED");

      if (nextStaleTickCount <= 5 || nextStaleTickCount % 500 === 0) {
        this.logger.warn("HARD_STALE_TICK_DROPPED", "Dropped tick beyond hard stale threshold", {
          instrumentCode: tick.instrumentCode,
          exchangeCode: tick.exchangeCode,
          source_exchange: tick.source_exchange,
          sequence: tick.sequence,
          totalLatencyMs: metrics.totalLatencyMs,
          networkLatencyMs: metrics.networkLatencyMs,
          processingLatencyMs: metrics.processingLatencyMs,
          hardStaleDropMs
        });
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
      this.engineState.averageLatency > hardStaleDropMs * 5 &&
      metrics.totalLatencyMs <= hardStaleDropMs
    ) {
      this.resetLatencyBaseline(metrics.brainTimestamp, "FRESH_SAMPLE_AFTER_BACKLOG");
    }

    this.updateLatencyAverage(metrics.totalLatencyMs);
    this.applyLocationLatency(metrics.totalLatencyMs, metrics.brainTimestamp);

    metrics.averageLatencyMs = this.engineState.averageLatency;
    metrics.sampleCount = this.engineState.latencySampleCount;
    metrics.maxLatencyMs = this.maxLatencyMs;
    metrics.latencyRiskMultiplier = this.engineState.location.latencyRiskMultiplier;
    metrics.positionSizeMultiplier = this.engineState.location.positionSizeMultiplier;
    metrics.status =
      !options.shadowReplay && metrics.totalLatencyMs > this.maxLatencyMs ? "STALE" : "FRESH";

    this.latencyHistory = [...this.latencyHistory, metrics].slice(
      -PERFORMANCE_HISTORY_LIMIT
    );

    if (metrics.status === "STALE" && !options.shadowReplay && this.cachedConfig.TRADING_ENABLED) {
      this.observeExecutionProfile(metrics, {
        wakeUpTimeMs,
        orderBookUpdateMs: null,
        agentLogicMs: null,
        hotPathStartedAt,
        observedAt: metrics.brainTimestamp
      });

      this.engineState = {
        ...this.engineState,
        processedTicks: this.engineState.processedTicks + 1,
        staleTickCount: this.engineState.staleTickCount + 1,
        quoteState: {
          status: "SUSPENDED",
          reason: "STALE_DATA_KILL_SWITCH",
          suspendedUntil: null,
          lastQuote: this.engineState.quoteState.lastQuote,
          updatedAt: metrics.brainTimestamp
        },
        maxLatencyMs: this.maxLatencyMs,
        heartbeatAt: metrics.brainTimestamp,
        updatedAt: metrics.brainTimestamp
      };

      await this.persistHotStorageSnapshot({
        [ENGINE_STATE_KEY]: this.engineState,
        [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
        [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples,
        [`staleTick:${tick.source_exchange}:${tick.instrumentCode}:${tick.sequence}`]: {
          tick,
          metrics
        }
      }, "STALE_DATA_KILL_SWITCH");

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

        this.engineState = {
          ...this.engineState,
          processedTicks: this.engineState.processedTicks + 1,
          maxLatencyMs: this.maxLatencyMs,
          heartbeatAt: metrics.brainTimestamp,
          updatedAt: metrics.brainTimestamp
        };

        await this.persistHotStorageSnapshot({
          [ENGINE_STATE_KEY]: this.engineState,
          [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
          [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples
        }, "INFORMATIONAL_TICK_BOOK_NOT_READY");

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

        await this.persistHotStorageSnapshot({
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
        }, "BOOK_DESYNC");

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

    const domSnapshot = this.getLiquidityWalls(
      tick.instrumentCode,
      metrics.brainTimestamp,
      tick
    );
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
      !options.shadowReplay
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
        microstructure: this.engineState.microstructure,
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

      await this.safeStoragePut({
        [ENGINE_STATE_KEY]: this.engineState,
        [PERFORMANCE_HISTORY_KEY]: this.latencyHistory,
        [PROCESSING_LATENCY_SAMPLES_KEY]: this.processingLatencySamples,
        [DOM_WALL_HISTORY_KEY]: this.domWallHistory,
        [ANOMALY_DETECTOR_STORAGE_KEY]: anomalyResult.state,
        [`${ORDER_BOOK_PREFIX}${book.marketKey}`]: book,
        [`lastTick:${book.marketKey}`]: tick,
        [`anomaly:${book.marketKey}:${tick.sequence}`]: anomalyResult.anomalies
      }, "ANOMALY_EMERGENCY_PAUSE");

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

    const profilerStartedAt = highResolutionNow();
    const profilerResult = this.profilerAgent.processTick(tick, {
      engineId: this.engineState.engineId,
      observedAt: metrics.brainTimestamp,
      midPrice: book.midPrice,
      spreadBps: book.spreadBps,
      weightedImbalance: book.weightedImbalance,
      liquidityWalls: domSnapshot.walls,
      spoofingAlerts: domSnapshot.pulledWalls
    });
    const profilerLatencyMs = roundLatency(highResolutionNow() - profilerStartedAt);

    this.observeExecutionProfile(metrics, {
      wakeUpTimeMs,
      orderBookUpdateMs,
      agentLogicMs: profilerLatencyMs,
      hotPathStartedAt,
      observedAt: metrics.brainTimestamp
    });

    const oracleResult = this.oracleAgent.processTick({
      tick,
      book,
      observedAt: metrics.brainTimestamp,
      config: {
        ORACLE_GOVERNANCE_MODE: this.cachedConfig.ORACLE_GOVERNANCE_MODE,
        ORACLE_MANUAL_SKEPTICISM: this.cachedConfig.ORACLE_MANUAL_SKEPTICISM,
        ORACLE_MAX_SKEPTICISM: this.cachedConfig.ORACLE_MAX_SKEPTICISM
      }
    });
    const leadLag = this.updateLeadLagMetrics(tick, book, metrics.brainTimestamp);
    const inventory = this.calculateInventoryState(metrics.brainTimestamp);
    const riskMetrics = this.updatePortfolioRisk(oracleResult.state, metrics.brainTimestamp);
    const hedge = this.hedgeAgent.evaluate({
      positions: this.engineState.openPositions,
      books: [...this.orderBook.values()],
      leadLag,
      threshold: Math.max(1, inventory.maxInventoryUnits * 0.25),
      observedAt: metrics.brainTimestamp
    });
    const croupierDecision = this.croupierAgent.evaluate({
      engineId: this.engineState.engineId,
      book,
      oracle: oracleResult.state,
      sentiment: this.engineState.sentiment,
      toxicityScore: profilerResult.toxicityScore,
      inventory,
      leadLag,
      minEvThreshold: this.cachedConfig.MIN_EV_THRESHOLD,
      exchangeFeeBps: this.cachedConfig.EXCHANGE_FEE_BPS,
      executionCostBufferBps: this.engineState.slippage.executionCostBufferBps,
      fundingRateHourly: this.currentFundingRate(book),
      fundingHorizonHours: readPositiveNumber(this.env.FUNDING_HORIZON_HOURS, 1),
      macroBias: this.macroBias,
      observedAt: metrics.brainTimestamp
    });
    const executionPlan = this.prepareExecutionPlan(
      croupierDecision.intent,
      metrics.brainTimestamp
    );
    const hedgePlan = this.prepareExecutionPlan(
      hedge.lastIntent,
      metrics.brainTimestamp,
      { bypassQuoteSuspension: true }
    );
    const executionPlans = [executionPlan, hedgePlan].filter(
      (plan): plan is NonNullable<typeof executionPlan> => plan !== null
    );
    let quoteState = this.nextQuoteState(
      croupierDecision.quote,
      croupierDecision.pullAllQuotes,
      metrics.brainTimestamp
    );

    if (profilerResult.signal?.featureVector.signalType === "SUSPEND_QUOTES") {
      quoteState = {
        status: "SUSPENDED",
        reason: "WHALE_PRINT",
        suspendedUntil:
          typeof profilerResult.signal.featureVector.suspendedUntil === "string"
            ? profilerResult.signal.featureVector.suspendedUntil
            : new Date(
                Date.parse(metrics.brainTimestamp) + this.resolveQuoteHibernateMs()
              ).toISOString(),
        lastQuote: quoteState.lastQuote,
        updatedAt: metrics.brainTimestamp
      };
      this.publish("SUSPEND_QUOTES", quoteStateTelemetry(quoteState));
    }

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
      microstructure: this.engineState.microstructure,
      oracle: oracleResult.state,
      leadLag,
      inventory,
      riskMetrics,
      risk: {
        ...this.engineState.risk,
        killSwitch: !riskMetrics.isTradingEnabled,
        updatedAt: metrics.brainTimestamp
      },
      quoteState,
      lastTradeIntent:
        hedgePlan?.intent ?? executionPlan?.intent ?? croupierDecision.intent,
      hedge,
      orderMap: executionPlans.length > 0 && (this.cachedConfig.TRADING_ENABLED || options.shadowReplay)
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
      toxicityScore: profilerResult.toxicityScore,
      agentHealth: profilerResult.processed
        ? touchAgentHealth(
            this.engineState.agentHealth,
            "PROFILER",
            profilerResult.toxicityScore > profilerResult.state.alertThreshold
              ? "YELLOW"
              : "GREEN",
            metrics.brainTimestamp,
            profilerLatencyMs,
            profilerResult.signal?.signalId ?? undefined
          )
        : this.engineState.agentHealth,
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
      writes[PROFILER_STATE_STORAGE_KEY] = profilerResult.state;
    }

    await this.persistHotStorageSnapshot(writes, "HOT_PATH_TICK_SNAPSHOT");
    this.logger.recordMarketTick(tick);

    if (oracleResult.bayesianTrace) {
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
        this.state.waitUntil(this.cancelAllQuotes(tick.instrumentCode, "ADVERSE_SELECTION_CRITICAL"));
      }
    } else if (croupierDecision.quote) {
      this.publish(
        "POST_QUOTE",
        quoteToTelemetry(croupierDecision.quote),
        croupierDecision.quote.signalId
      );
      if (!options.shadowReplay && this.cachedConfig.TRADING_ENABLED) {
        this.state.waitUntil(this.dispatchQuote(croupierDecision.quote));
      }
    }

    for (const plan of executionPlans) {
      if (!options.shadowReplay && this.cachedConfig.TRADING_ENABLED) {
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
          this.state.waitUntil(
            this.dispatchExecution(childIntent, plan.camouflage.timingJitterMs)
          );
        }
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

    if (profilerResult.signal) {
      this.publishProfilerAlert(profilerResult.signal, profilerResult.state);
      await this.acceptAgentSignal(profilerResult.signal, profilerLatencyMs);
      if (
        profilerResult.signal.featureVector.signalType === "SUSPEND_QUOTES" &&
        !options.shadowReplay &&
        this.cachedConfig.TRADING_ENABLED
      ) {
        this.state.waitUntil(this.cancelAllQuotes(tick.instrumentCode, "PROFILER_ALERT"));
      }
    }

    if (
      this.engineState.processedTicks <= 5 ||
      this.engineState.processedTicks % 1_000 === 0
    ) {
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
      finiteNumber(tick.fundingRateHourly) ??
      finiteNumber(tick.raw?.fundingRateHourly);

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

    let best:
      | {
          leadInstrument: string;
          lagInstrument: string;
          correlation: number;
          lagSteps: number;
          sampleCount: number;
          leadLagDelta: number;
          expectedValue: number;
        }
      | null = null;

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
      (sum, position) =>
        sum + (position.side === "LONG" ? position.quantity : -position.quantity),
      0
    );
    const maxInventoryUnits =
      this.cachedConfig.MAX_INVENTORY_UNITS > 0
        ? this.cachedConfig.MAX_INVENTORY_UNITS
        : readPositiveNumber(this.env.MAX_INVENTORY_UNITS, DEFAULT_MAX_INVENTORY_UNITS);
    const riskAversionFactor =
      this.cachedConfig.RISK_AVERSION_FACTOR > 0
        ? this.cachedConfig.RISK_AVERSION_FACTOR
        : readPositiveNumber(this.env.RISK_AVERSION_FACTOR, DEFAULT_RISK_AVERSION_FACTOR);
    const inventoryPenalty = netDelta * riskAversionFactor;

    return {
      netDelta,
      maxInventoryUnits,
      inventoryPenalty,
      stopBid: netDelta >= maxInventoryUnits,
      stopAsk: netDelta <= -maxInventoryUnits,
      updatedAt: observedAt
    };
  }

  private updatePortfolioRisk(
    oracle: EngineState["oracle"],
    observedAt: string
  ): EngineState["riskMetrics"] {
    const equity = Math.max(this.engineState.bankroll.equity, this.engineState.bankroll.cash, 0);
    const highWaterMark = Math.max(this.engineState.riskMetrics.highWaterMark, equity);
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

    if (drawdownBreached) {
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

  private prepareExecutionPlan(
    intent: EngineState["lastTradeIntent"],
    observedAt: string,
    options: { bypassQuoteSuspension?: boolean } = {}
  ):
    | {
        intent: NonNullable<EngineState["lastTradeIntent"]>;
        camouflage: ReturnType<typeof camouflageIntent>;
        sorPlan: ReturnType<typeof planSmartOrderRoute>;
        orders: ManagedOrder[];
      }
    | null {
    if (
      !intent ||
      (!options.bypassQuoteSuspension && this.engineState.quoteState.status === "SUSPENDED")
    ) {
      return null;
    }

    const pitBossDecision = this.pitBossAgent.approve(
      intent,
      this.engineState,
      this.cachedConfig,
      this.cachedConfig.MAX_POSITION_PCT > 0
        ? this.cachedConfig.MAX_POSITION_PCT
        : readPositiveNumber(this.env.MAX_POSITION_PCT, DEFAULT_MAX_POSITION_PCT),
      this.cachedConfig.KELLY_FRACTION
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
      this.logger.warn("SOR_RESIDUAL_LIQUIDITY_SHORTFALL", "Smart router could not source full approved size", {
        intentId: camouflage.intent.intentId,
        instrumentCode: camouflage.intent.instrumentCode,
        approvedSize: camouflage.intent.approvedSize ?? camouflage.intent.requestedSize,
        unfilledSize: sorPlan.unfilledSize
      });
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

  private nextQuoteState(
    quote: EngineState["quoteState"]["lastQuote"],
    pullAllQuotes: boolean,
    observedAt: string
  ): EngineState["quoteState"] {
    const suspendedUntil = this.engineState.quoteState.suspendedUntil;

    if (pullAllQuotes) {
      return {
        status: "SUSPENDED",
        reason: "ADVERSE_SELECTION_CRITICAL",
        suspendedUntil: new Date(Date.parse(observedAt) + this.resolveQuoteHibernateMs()).toISOString(),
        lastQuote: this.engineState.quoteState.lastQuote,
        updatedAt: observedAt
      };
    }

    if (suspendedUntil && Date.parse(suspendedUntil) > Date.parse(observedAt)) {
      return this.engineState.quoteState;
    }

    return {
      status: "ACTIVE",
      reason: null,
      suspendedUntil: null,
      lastQuote: quote ?? this.engineState.quoteState.lastQuote,
      updatedAt: observedAt
    };
  }

  private resolveQuoteHibernateMs(): number {
    return this.cachedConfig.QUOTE_HIBERNATE_MS > 0
      ? this.cachedConfig.QUOTE_HIBERNATE_MS
      : readPositiveInteger(
          this.env.QUOTE_HIBERNATE_MS,
          DEFAULT_QUOTE_HIBERNATE_MS,
          100,
          60_000
        );
  }

  private maybeResumeQuotes(observedAt: string): void {
    const suspendedUntil = this.engineState.quoteState.suspendedUntil;

    if (
      this.engineState.quoteState.status === "SUSPENDED" &&
      suspendedUntil &&
      Date.parse(suspendedUntil) <= Date.parse(observedAt)
    ) {
      this.engineState = {
        ...this.engineState,
        quoteState: {
          ...this.engineState.quoteState,
          status: "ACTIVE",
          reason: null,
          suspendedUntil: null,
          updatedAt: observedAt
        }
      };
      this.publish("RESUME_QUOTES", { observedAt });
    }
  }

  private async dispatchQuote(quote: NonNullable<EngineState["quoteState"]["lastQuote"]>): Promise<void> {
    if (!this.env.EXECUTIONER || !this.cachedConfig.TRADING_ENABLED) {
      return;
    }

    const intents = quote.orders.map((order): TradeIntent => {
      const action = order.side === "BID" ? "BUY" : "SELL";

      return {
        schemaVersion: "trade-intent.v1",
        intentId: order.clientOrderId,
        traceId: `${this.engineState.engineId}:quote:${quote.signalId}:${order.clientOrderId}`,
        instrumentCode: quote.instrumentCode,
        marketKey: quote.marketKey,
        source_exchange: quote.marketKey?.split(":")[0] ?? this.engineState.microstructure.source_exchange,
        direction: action === "BUY" ? "LONG" : "SHORT",
        action,
        orderType: "LIMIT",
        postOnly: order.postOnly,
        timeInForce: "GTC",
        intendedPrice: order.price,
        expectedPrice: order.price,
        requestedSize: order.size,
        approvedSize: order.size,
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
        rationale: `AMM quote child order from signal ${quote.signalId}`,
        createdAt: quote.createdAt
      };
    });

    for (const intent of intents) {
      await this.dispatchExecution(intent);
    }
  }

  private async dispatchExecution(
    intent: NonNullable<EngineState["lastTradeIntent"]>,
    initialDelayMs = 0
  ): Promise<void> {
    if (!this.env.EXECUTIONER || !this.cachedConfig.TRADING_ENABLED) {
      return;
    }

    if (initialDelayMs > 0) {
      await wait(initialDelayMs);
    }

    const priority = intent.orderType === "MARKET" ? "HEDGE" : "NEW";
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

  private async enqueueExecutionIntent(
    intent: TradeIntent,
    priority: QueuedExecutionIntent["priority"],
    waitMs: number
  ): Promise<void> {
    const queue = await this.readExecutionQueue("EXECUTION_QUEUE_ENQUEUE_READ");
    const runAfterMs = Date.now() + Math.max(0, waitMs);
    const nextQueue = [...queue, {
      intent,
      priority,
      runAfterMs,
      enqueuedAt: new Date().toISOString()
    }]
      .sort(compareQueuedExecutionIntent)
      .slice(0, 1_000);

    await this.safeStoragePut(EXECUTION_QUEUE_KEY, nextQueue, "EXECUTION_QUEUE_ENQUEUE");
    await this.safeSetAlarm(
      Math.min(runAfterMs, Date.now() + CONFIG_ALARM_INTERVAL_MS),
      "EXECUTION_QUEUE_ALARM"
    );
    this.logger.warn("EXECUTION_DEFERRED_BY_RATE_LIMIT", "Execution intent deferred by durable rate limiter", {
      intentId: intent.intentId,
      priority,
      waitMs,
      queuedCount: nextQueue.length
    });
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
    const pending = queue.filter((item) => item.runAfterMs > now).sort(compareQueuedExecutionIntent);

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
    const existing =
      this.engineState.orderMap[report.clientId] ??
      Object.values(this.engineState.orderMap).find(
        (order) =>
          report.exchangeOrderId &&
          order.exchangeOrderId === report.exchangeOrderId
      );
    const observedAt = report.observedAt ?? new Date().toISOString();
    const previousFilledSize = existing?.filledSize ?? 0;
    const cumulativeFilledSize =
      typeof report.filledSize === "number" && Number.isFinite(report.filledSize)
        ? Math.max(0, report.filledSize)
        : previousFilledSize;
    const fillIncrementSize =
      typeof report.fillIncrementSize === "number" && Number.isFinite(report.fillIncrementSize)
        ? Math.max(0, report.fillIncrementSize)
        : Math.max(0, cumulativeFilledSize - previousFilledSize);
    const nextOrder: ManagedOrder = {
      ...(existing ?? {
        clientId: report.clientId,
        exchangeOrderId: report.exchangeOrderId ?? null,
        intentId: report.clientId,
        instrumentCode:
          report.instrumentCode ??
          this.engineState.lastTradeIntent?.instrumentCode ??
          "unknown",
        side:
          report.side ??
          this.engineState.lastTradeIntent?.action ??
          "BUY",
        price: report.expectedPrice ?? report.achievedPrice ?? 0,
        size: report.orderSize ?? report.filledSize ?? 0,
        filledSize: 0,
        status: "PENDING",
        createdAt: observedAt,
        updatedAt: observedAt,
        ackDeadlineAt: observedAt
      }),
      exchangeOrderId: report.exchangeOrderId ?? existing?.exchangeOrderId ?? null,
      status: report.status,
      filledSize: cumulativeFilledSize,
      updatedAt: observedAt
    };
    const slippagePoint = this.recordSlippage(report, nextOrder);
    const portfolio =
      (report.status === "FILLED" || report.status === "PARTIAL_FILL") &&
      fillIncrementSize > 0
        ? this.applyFillToPortfolio(
            nextOrder,
            fillIncrementSize,
            report.achievedPrice ?? report.expectedPrice ?? nextOrder.price,
            report.fees ?? 0,
            observedAt
          )
        : {
            bankroll: this.markBankrollToMarket(
              this.engineState.bankroll.cash,
              this.engineState.bankroll.realizedPnl,
              this.engineState.openPositions,
              observedAt
            ),
            openPositions: this.engineState.openPositions
          };
    const orderMap = { ...this.engineState.orderMap };
    delete orderMap[existing?.clientId ?? report.clientId];
    orderMap[nextOrder.clientId] = nextOrder;
    const realizedPnlDelta = roundCrypto(
      portfolio.bankroll.realizedPnl - this.engineState.bankroll.realizedPnl
    );
    const tradeExecution = this.executionReportToTrade(
      report,
      nextOrder,
      slippagePoint,
      realizedPnlDelta,
      observedAt
    );

    this.engineState = {
      ...this.engineState,
      bankroll: portfolio.bankroll,
      openPositions: portfolio.openPositions,
      inventory: this.calculateInventoryState(observedAt, portfolio.openPositions),
      orderMap,
      slippage: appendSlippagePoint(this.engineState.slippage, slippagePoint),
      updatedAt: observedAt,
      heartbeatAt: observedAt
    };

    await this.safeStoragePut(ENGINE_STATE_KEY, this.engineState, "EXECUTION_REPORT");
    this.logger.recordExecution(tradeExecution);
    this.publish(
      "TRADE_EXECUTION_UPDATE",
      tradeExecution as unknown as Record<string, unknown>,
      tradeExecution.tradeId
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
        status === "FILLED" || status === "PARTIAL" ? resultingPnl : 0,
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
    if (!Number.isFinite(fillSize) || fillSize <= 0 || !Number.isFinite(fillPrice) || fillPrice <= 0) {
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
      closingSize > 0
        ? (fillPrice - oldAverage) * closingSize * (existingSigned > 0 ? 1 : -1)
        : 0;
    const realizedPnl = roundCrypto(
      (existing?.realizedPnl ?? 0) + realizedFromClose - fees
    );
    const markPrice = this.currentMarkPrice(order.instrumentCode, fillPrice);

    if (Math.abs(nextSigned) <= 0.00000001) {
      delete positions[order.instrumentCode];
    } else {
      const sameDirection = existingSigned === 0 || Math.sign(existingSigned) === Math.sign(fillSigned);
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
      order.side === "BUY"
        ? -(fillPrice * fillSize + fees)
        : fillPrice * fillSize - fees;
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
      expectedPrice > 0 ? ((achievedPrice - expectedPrice) / expectedPrice) * 10_000 * sideMultiplier : 0;
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

    const price = this.currentMarkPrice(instrumentCode, position.markPrice);
    const intent: TradeIntent = {
      schemaVersion: "trade-intent.v1",
      intentId: crypto.randomUUID(),
      traceId: `${this.engineState.engineId}:janitor:dust:${instrumentCode}:${observedAt}`,
      instrumentCode,
      marketKey: this.selectMarketKey(instrumentCode)?.marketKey ?? null,
      source_exchange: this.engineState.microstructure.source_exchange,
      direction: position.side === "LONG" ? "SHORT" : "LONG",
      action: position.side === "LONG" ? "SELL" : "BUY",
      orderType: "MARKET",
      postOnly: false,
      timeInForce: "IOC",
      intendedPrice: price,
      expectedPrice: price,
      requestedSize: position.quantity,
      approvedSize: position.quantity,
      probabilityWin: 0.5,
      probabilityLoss: 0.5,
      profit: 0,
      loss: 0,
      executionCosts: 0,
      adverseSelectionCost: 0,
      expectedValue: 0,
      minEvThreshold: Number.NEGATIVE_INFINITY,
      maxSlippageBps: Math.max(5, this.engineState.microstructure.spreadBps ?? 5),
      confidence: 1,
      rationale: "Janitor dust-position closeout",
      createdAt: observedAt
    };

    await this.dispatchExecution(intent);
    return intent.intentId;
  }

  private async pruneTelemetryLogs(): Promise<number> {
    const retentionDays = readPositiveInteger(
      this.env.JANITOR_LOG_RETENTION_DAYS,
      30,
      1,
      3650
    );
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();

    try {
      const result = await this.env.TRADING_DB.prepare(
        `DELETE FROM logs
         WHERE event_type = 'TELEMETRY'
           AND created_at < ?`
      ).bind(cutoff).run();
      return Number(result.meta?.changes ?? 0);
    } catch (error) {
      this.logger.error("JANITOR_LOG_PRUNE_FAILED", "Failed to prune old telemetry logs", {
        cutoff,
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
    dateTo: string | null = null
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
      error: null,
      startedAt,
      updatedAt: startedAt,
      completedAt: null
    });
    const liveSnapshot = this.captureReplaySnapshot();
    const ticks = await this.loadReplayTicks(limit, dateFrom, dateTo);
    await this.writeReplayStatus({
      replayId,
      status: "RUNNING",
      ticksTotal: ticks.length,
      ticksProcessed: 0,
      progressPct: 0,
      speedMultiplier,
      shadowBankroll,
      dateFrom,
      dateTo,
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
    let ticksReplayed = 0;
    let generatedIntentCount = 0;

    this.cachedConfig = {
      ...this.cachedConfig,
      TRADING_ENABLED: true,
      MAX_POSITION_SIZE: this.cachedConfig.MAX_POSITION_SIZE || shadowBankroll,
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
        cash: shadowBankroll,
        equity: shadowBankroll,
        realizedPnl: 0,
        updatedAt: startedAt
      },
      mode: "PAPER",
      cachedConfig: this.cachedConfig,
      heartbeatAt: startedAt,
      updatedAt: startedAt
    };
    this.profilerAgent.hydrate(null);
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
        }

        if (index === ticks.length - 1 || index % 25 === 0) {
          await this.writeReplayStatus({
            replayId,
            status: "RUNNING",
            ticksTotal: ticks.length,
            ticksProcessed: index + 1,
            progressPct: ticks.length > 0 ? roundMetric(((index + 1) / ticks.length) * 100, 2) : 100,
            speedMultiplier,
            shadowBankroll,
            dateFrom,
            dateTo,
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
        shadowBankroll,
        dateFrom,
        dateTo,
        error: error instanceof Error ? error.message : "UNKNOWN_REPLAY_ERROR",
        startedAt,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      });
      throw error;
    } finally {
      await this.restoreReplaySnapshot(liveSnapshot);
    }

    const theoreticalPnl = shadowTrades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0);
    const completedAt = new Date().toISOString();
    const result: ReplayResult = {
      replayId,
      ticksReplayed,
      shadowBankroll: shadowBankroll + theoreticalPnl,
      theoreticalPnl,
      baselinePnl: 0,
      actualTradeCount: historicalTrades.length,
      generatedIntentCount,
      speedMultiplier,
      shadowTrades,
      startedAt,
      completedAt
    };

    this.logger.warn("REPLAY_COMPLETED", "Historical shadow replay completed", {
      replayId: result.replayId,
      ticksReplayed,
      actualTradeCount: historicalTrades.length,
      generatedIntentCount,
      theoreticalPnl,
      speedMultiplier,
      liveStateRestored: true
    });
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

    return status ?? {
      replayId: null,
      status: "IDLE",
      ticksTotal: 0,
      ticksProcessed: 0,
      progressPct: 0,
      speedMultiplier: 1,
      shadowBankroll: 0,
      dateFrom: null,
      dateTo: null,
      error: null,
      startedAt: null,
      updatedAt: new Date().toISOString(),
      completedAt: null
    };
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
    this.profilerAgent.hydrate(snapshot.profilerState);
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
      [ANOMALY_DETECTOR_STORAGE_KEY]: snapshot.anomalyState,
      [RATE_LIMIT_STATE_KEY]: snapshot.rateLimits,
      ...Object.fromEntries(
        snapshot.orderBooks.map((book) => [`${ORDER_BOOK_PREFIX}${book.marketKey}`, book])
      )
    };

    await this.safeStorageDelete(
      [...persistedBookKeys.keys()],
      "REPLAY_RESTORE_DELETE_BOOKS"
    );

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
      ).bind(...binds).all<ReplayTickRow>();

      return (rows.results ?? [])
        .map((row) => safeParseJson<MarketTick>(row.tick_json))
        .filter((tick): tick is MarketTick => tick?.schemaVersion === "universal-tick.v1");
    } catch (error) {
      this.logger.warn("REPLAY_TICK_JOURNAL_UNAVAILABLE", "Falling back to telemetry logs for replay", {
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
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
      ).bind(...binds).all<{ telemetry_json: string; created_at: string }>();

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
    ).bind(...binds).all<ReplayTradeRow>();

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
      tick.synchronizedExchangeTimestamp ??
      tick.providerTimestamp ??
      tick.kaikoTimestamp ??
      tick.exchangeTimestamp;
    const kaikoTimestamp = tick.kaikoTimestamp ?? sourceTimestamp;
    const sourceTime = parseTimestampMs(sourceTimestamp, "source_timestamp");
    const ingestTime = parseTimestampMs(tick.receivedAt, "ingest_timestamp");
    const brainTime = parseTimestampMs(brainTimestamp, "brain_timestamp");
    const networkLatencyMs = Math.max(0, ingestTime - sourceTime);
    const processingLatencyMs = Math.max(0, brainTime - ingestTime);

    return {
      instrumentCode: tick.instrumentCode,
      exchangeCode: tick.exchangeCode,
      source: tick.source,
      sourceExchange: tick.source_exchange,
      sourceWeight: tick.sourceWeight,
      sequence: tick.sequence,
      kaikoTimestamp,
      sourceTimestamp,
      ingestTimestamp: tick.receivedAt,
      brainTimestamp,
      clockOffsetMs: tick.clockOffsetMs,
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

  private observeExecutionProfile(
    metrics: LatencyMetrics,
    trace: ExecutionTraceInput
  ): void {
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
    const totalHotPathMs = roundLatency(
      Math.max(0, highResolutionNow() - trace.hotPathStartedAt)
    );
    let nextProfile: ExecutionProfile = {
      ...previousProfile,
      jitterThresholdMs: this.jitterThresholdMs,
      sampleWindow: this.jitterSampleWindow,
      computeIntervalTicks: this.jitterComputeIntervalTicks,
      sampleCount: this.processingLatencySamples.length,
      lastProcessingLatencyMs: processingLatencyMs,
      wakeUpTimeMs: trace.wakeUpTimeMs,
      coldStartSuspected:
        trace.wakeUpTimeMs !== null &&
        trace.wakeUpTimeMs > COLD_START_WAKEUP_THRESHOLD_MS,
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
        cancellationToExecutionRatio:
          this.engineState.anomaly.cancellationToExecutionRatio,
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

    const agents = (Object.keys(this.engineState.agentHealth) as AgentName[]).map(
      (agentName) => {
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
      }
    );

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
    this.logger.logPerformance(latencyMetrics);
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
        cancellationToExecutionRatio:
          anomalyResult.status.cancellationToExecutionRatio,
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

  private publish(
    type: string,
    payload: Record<string, unknown>,
    correlationId?: string
  ): void {
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
          flushIntervalMs: TELEMETRY_FLUSH_INTERVAL_MS
        }
      });
    }

    this.eventTelemetryAggregates.clear();
    return entries;
  }

  private accumulateTickTelemetry(
    payload: Record<string, unknown>,
    emittedAt: string
  ): void {
    const cpuTimeMs = readTelemetryNumber(payload.cpuTimeMs);
    const totalLatencyMs = readTelemetryNumber(payload.totalLatencyMs);
    const websocketLatencyMs = readTelemetryNumber(payload.websocketLatencyMs);
    const processingLatencyMs = readTelemetryNumber(payload.processingLatencyMs);
    const timeToBookMs = readTelemetryNumber(payload.timeToBookMs);
    const status =
      typeof payload.status === "string" && payload.status.length > 0
        ? payload.status
        : null;

    const current =
      this.tickTelemetryAggregate ??
      {
        count: 0,
        freshCount: 0,
        staleCount: 0,
        firstObservedAt: emittedAt,
        lastObservedAt: emittedAt,
        latestInstrumentCode: null,
        latestExchangeCode: null,
        latestSequence: null,
        latestStatus: null,
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
      typeof payload.instrumentCode === "string" ? payload.instrumentCode : current.latestInstrumentCode;
    current.latestExchangeCode =
      typeof payload.exchangeCode === "string" ? payload.exchangeCode : current.latestExchangeCode;
    current.latestSequence =
      typeof payload.sequence === "number" && Number.isFinite(payload.sequence)
        ? payload.sequence
        : current.latestSequence;
    current.latestStatus = status ?? current.latestStatus;

    if (cpuTimeMs !== null) {
      current.sumCpuTimeMs += cpuTimeMs;
    }
    if (totalLatencyMs !== null) {
      current.sumTotalLatencyMs += totalLatencyMs;
      current.maxTotalLatencyMs = Math.max(current.maxTotalLatencyMs, totalLatencyMs);
    }
    if (websocketLatencyMs !== null) {
      current.sumWebsocketLatencyMs += websocketLatencyMs;
      current.maxWebsocketLatencyMs = Math.max(
        current.maxWebsocketLatencyMs,
        websocketLatencyMs
      );
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
        flushIntervalMs: TELEMETRY_FLUSH_INTERVAL_MS
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
      this.telemetryBuffer.splice(
        0,
        this.telemetryBuffer.length - TELEMETRY_BUFFER_LIMIT
      );
    }

    this.scheduleTelemetryFlush();
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
      }, TELEMETRY_FLUSH_INTERVAL_MS);
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
        JSON.stringify(toJsonValue({
          telemetryType: entry.telemetryType,
          ...entry.payload
        })),
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

  private async refreshConfig(source: "ALARM" | "ADMIN_SIGNAL"): Promise<void> {
    const previousVersion = this.cachedConfig.version;
    const effectiveGovernance = await this.governor.readEffectiveConfig(
      await this.configManager.fetchConfig()
    );
    const nextConfig = effectiveGovernance.config;
    const now = new Date().toISOString();

    this.cachedConfig = nextConfig;
    this.macroBias = effectiveGovernance.macroBias;
    this.activeTemporaryOverride = effectiveGovernance.temporaryOverride;
    this.maxLatencyMs = nextConfig.LATENCY_THRESHOLD_MS;
    if (nextConfig.TRADING_ENABLED) {
      this.killSwitchLogged = false;
    }

    this.engineState = {
      ...this.engineState,
      cachedConfig: nextConfig,
      macroBias: this.macroBias,
      temporaryOverride: this.activeTemporaryOverride,
      maxLatencyMs: nextConfig.LATENCY_THRESHOLD_MS,
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
        this.engineState.location,
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
        configVersion: nextConfig.version,
        macroBias: toJsonValue(this.macroBias),
        temporaryOverride: toJsonValue(this.activeTemporaryOverride)
      });
    }
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
      heartbeatAt: signal.createdAt,
      updatedAt: signal.createdAt
    };

    await this.safeStoragePut({
      [ENGINE_STATE_KEY]: this.engineState,
      [`signal:${signal.signalId}`]: signal
    }, "AGENT_SIGNAL");

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
  }

  private async applyConfigUpdate(update: AdminConfigUpdate): Promise<void> {
    if (update.signal === "REFRESH_CONFIG" || update.config) {
      await this.refreshConfig("ADMIN_SIGNAL");
      await this.scheduleConfigRefresh();
      return;
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
        "HEDGE",
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
    maxLatencyMs: DEFAULT_MAX_LATENCY_MS,
    cachedConfig: { ...defaultConfig },
    macroBias: neutralMacroBias(),
    temporaryOverride: null,
    location: defaultEngineLocation(),
    fundingRates: {},
    microstructure: defaultMicrostructure(),
    priceDiscovery: defaultPriceDiscovery(),
    oracle: defaultOracleState(),
    sentiment: defaultSentimentState(),
    leadLag: defaultLeadLagMetrics(),
    inventory: defaultInventoryState(DEFAULT_MAX_INVENTORY_UNITS),
    riskMetrics: defaultRiskMetrics(0, now),
    quoteState: defaultQuoteState(),
    lastTradeIntent: null,
    hedge: defaultHedgeState(),
    janitor: defaultJanitorState(),
    slippage: defaultSlippageAnalytics(),
    orderMap: {},
    executionProfile: defaultExecutionProfile(
      DEFAULT_JITTER_THRESHOLD_MS,
      DEFAULT_JITTER_SAMPLE_WINDOW,
      DEFAULT_JITTER_COMPUTE_INTERVAL_TICKS,
      0
    ),
    dom: null,
    anomaly: defaultAnomalyStatus(),
    heartbeatAt: now,
    updatedAt: now
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
      headers.get(`${TOPOLOGY_HEADER_PREFIX}placement`) ??
        headers.get("cf-placement")
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
  observedLatencyMs: number | null
): EngineLocation {
  const colo = (topology.colo ?? previous.colo)?.toUpperCase() ?? null;
  const goldenColos = parseColoSet(env.GOLDEN_COLOS);
  const hasGoldenRegionPolicy = goldenColos.size > 0;
  const isGoldenRegion =
    !hasGoldenRegionPolicy || (colo !== null && goldenColos.has(colo));
  const latencyRiskMultiplier = isGoldenRegion
    ? 1
    : resolveRiskMultiplier(env.HIGH_LATENCY_COLO_RISK_MULTIPLIER);

  return {
    colo,
    placement: topology.placement ?? previous.placement,
    country: topology.country ?? previous.country,
    city: topology.city ?? previous.city,
    region: topology.region ?? previous.region,
    timezone: topology.timezone ?? previous.timezone,
    latitude: topology.latitude ?? previous.latitude,
    longitude: topology.longitude ?? previous.longitude,
    lastSeenAt: topology.observedAt,
    isGoldenRegion,
    latencyRiskMultiplier,
    positionSizeMultiplier: latencyRiskMultiplier,
    observedLatencyMs,
    reason:
      colo === null
        ? "UNKNOWN_COLO"
        : isGoldenRegion
          ? "GOLDEN_REGION"
          : "NON_GOLDEN_REGION"
  };
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
    maxOrderNotional: roundMetric(
      config.MAX_POSITION_SIZE * location.positionSizeMultiplier,
      8
    ),
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

function defaultInventoryState(maxInventoryUnits: number): EngineState["inventory"] {
  return {
    netDelta: 0,
    maxInventoryUnits,
    inventoryPenalty: 0,
    stopBid: false,
    stopAsk: false,
    updatedAt: null
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

function defaultHedgeState(): EngineState["hedge"] {
  return {
    netDelta: 0,
    hedgeRequired: false,
    hedgeRatio: 0,
    preferredVenue: null,
    lastIntent: null,
    updatedAt: null
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

function mergeRiskLimits(
  current?: RiskLimits,
  update?: Partial<RiskLimits> | null
): RiskLimits {
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

  return Number.isFinite(candidate) && candidate > 0
    ? candidate
    : DEFAULT_MAX_LATENCY_MS;
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
    samples.reduce((sum, sample) => sum + (sample - average) ** 2, 0) /
    samples.length;
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

function prometheusLabels(
  labels: Record<string, string | number | boolean | null>
): string {
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
  let count = 0;

  for (const book of bids.values()) {
    count += book.size;
  }

  for (const book of asks.values()) {
    count += book.size;
  }

  return count;
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
  const spread =
    bestBid !== null && bestAsk !== null
      ? roundCrypto(bestAsk - bestBid)
      : null;
  const midPrice =
    bestBid !== null && bestAsk !== null
      ? roundCrypto((bestBid + bestAsk) / 2)
      : null;
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

function normalizeMarketKey(value: string): string {
  return value.toLowerCase();
}

function normalizeSourceExchange(value: string | null | undefined): string {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim().toLowerCase()
    : "unknown";
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
  const variance =
    volumes.reduce((sum, volume) => sum + (volume - mean) ** 2, 0) / volumes.length;

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

  return new Map(
    [...latest.entries()].filter(([, wall]) => wall.status === "ACTIVE")
  );
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

function mergeBookNodes(
  left: BookNode | null,
  right: BookNode | null
): BookNode | null {
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
  const bucketed =
    side === "bid" ? Math.floor(scaled) * tickSize : Math.ceil(scaled) * tickSize;

  return roundCrypto(bucketed);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
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
    const bidLevels = Array.isArray(value.bids)
      ? value.bids
      : hydrateLegacyLevel(value, "bid");
    const askLevels = Array.isArray(value.asks)
      ? value.asks
      : hydrateLegacyLevel(value, "ask");
    const tickSize = value.tickSize ?? DEFAULT_ORDER_BOOK_TICK_SIZE;
    const bidBook = levelsToBookSide(bidLevels, "bid", tickSize);
    const askBook = levelsToBookSide(askLevels, "ask", tickSize);
    const normalizedBids = bidBook.top(BOOK_SNAPSHOT_TOP_LEVELS);
    const normalizedAsks = askBook.top(BOOK_SNAPSHOT_TOP_LEVELS);
    const sourceExchange = normalizeSourceExchange(
      value.source_exchange ?? value.exchangeCode
    );
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

function hydrateLegacyLevel(
  value: InternalOrderBook,
  side: OrderBookSide
): PriceLevel[] {
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

function mapManagedStatusToTradeStatus(
  status: ManagedOrder["status"]
): TradeExecution["status"] {
  switch (status) {
    case "FILLED":
      return "FILLED";
    case "PARTIAL_FILL":
      return "PARTIAL";
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

function executionReportSize(
  report: ExecutionReport,
  order: ManagedOrder,
  status: TradeExecution["status"]
): number {
  if (status === "FILLED" || status === "PARTIAL") {
    return (
      report.fillIncrementSize ??
      report.filledSize ??
      order.filledSize ??
      order.size
    );
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

function inferExecutionPrimaryDriver(
  intent: TradeIntent | null,
  order: ManagedOrder
): AgentName {
  const rationale = intent?.rationale.toLowerCase() ?? "";

  if (rationale.includes("hedge") || order.clientId.includes(":hedge")) {
    return "HEDGE";
  }

  if (intent?.traceId.includes("profiler")) {
    return "PROFILER";
  }

  return intent ? "CROUPIER" : "EXECUTIONER";
}

function resolveTickSize(
  env: Env,
  instrumentCode: string,
  override?: number
): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override;
  }

  const configured = parseTickSizeMap(env.ORDER_BOOK_TICK_SIZES)[instrumentCode];

  if (configured !== undefined) {
    return configured;
  }

  return readPositiveNumber(env.ORDER_BOOK_TICK_SIZE_DEFAULT, DEFAULT_ORDER_BOOK_TICK_SIZE);
}

function resolveDomBinSize(
  env: Env,
  instrumentCode: string,
  fallback: number
): number {
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
      .map(([instrumentCode, rawValue]) => [
        instrumentCode.toLowerCase(),
        Number(rawValue)
      ] as const)
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
          postOnly: order.postOnly
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
  const priorityWeight = { CANCEL: 0, HEDGE: 1, NEW: 2 } as const;
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
    "HEDGE",
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
  const eventType =
    typeof tick.raw?.eventType === "string" ? tick.raw.eventType.toLowerCase() : "";
  const commodity =
    typeof tick.raw?.commodity === "string" ? tick.raw.commodity.toUpperCase() : "";

  return (
    eventType === "trade" ||
    eventType === "funding" ||
    eventType === "book-snapshot" ||
    commodity === "TRADE" ||
    commodity === "FUNDING"
  );
}

function shouldAggregateBusTelemetry(type: string): boolean {
  return type === "POST_QUOTE";
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
