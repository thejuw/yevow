export type { Env } from "./types/Env";

export type {
  AgentAction,
  AgentName,
  CitadelOperationalStatus,
  EngineMode,
  EngineStabilityStatus,
  ExchangeStreamConfig,
  ExchangeStreamHealth,
  GovernanceMode,
  HealthStatus,
  ISO8601,
  IngestHealth,
  JsonRecord,
  JsonValue,
  MarketDataSource,
  MarketDataSubscriptionProfile,
  MarketDataSubscriptionTier,
  MarketMakingMode,
  MarketTick,
  MarketTransport,
  NotificationPriority,
  OrderBookResetRequest,
  SentimentAlphaMode,
  StrategyMode,
  TradeAlertMode,
  UniversalTick
} from "./types/Core";
import type {
  AgentAction,
  AgentName,
  CitadelOperationalStatus,
  EngineMode,
  EngineStabilityStatus,
  ExchangeStreamConfig,
  ExchangeStreamHealth,
  GovernanceMode,
  HealthStatus,
  ISO8601,
  IngestHealth,
  JsonRecord,
  JsonValue,
  MarketDataSource,
  MarketDataSubscriptionProfile,
  MarketDataSubscriptionTier,
  MarketMakingMode,
  MarketTick,
  MarketTransport,
  NotificationPriority,
  OrderBookResetRequest,
  SentimentAlphaMode,
  StrategyMode,
  TradeAlertMode,
  UniversalTick
} from "./types/Core";
export type {
  BookSnapshotResponse,
  EdgeTopology,
  EngineLocation,
  ExecutionProfile,
  FundingRateSnapshot,
  LatencyMetrics,
  LatencyStatus,
  MicrostructureMetrics,
  OrderBookDelta,
  OrderBookSide,
  OrderBookSnapshot,
  OrderBookSnapshotLevel,
  PerformanceConfig,
  PriceDiscoveryMetrics,
  PriceDiscoverySource,
  PriceLevel
} from "./types/MarketStructure";
import type {
  BookSnapshotResponse,
  EdgeTopology,
  EngineLocation,
  ExecutionProfile,
  FundingRateSnapshot,
  LatencyMetrics,
  LatencyStatus,
  MicrostructureMetrics,
  OrderBookDelta,
  OrderBookSide,
  OrderBookSnapshot,
  OrderBookSnapshotLevel,
  PerformanceConfig,
  PriceDiscoveryMetrics,
  PriceDiscoverySource,
  PriceLevel
} from "./types/MarketStructure";
export type {
  GlobalRiskConfig,
  GlobalRiskConfigUpdate,
  MacroBias,
  MacroBiasDirection,
  MacroBiasUpdate,
  NotificationSettings,
  NotificationSettingsUpdate,
  SupervisorSource,
  TemporaryGovernanceOverride,
  TemporaryGovernanceOverrideUpdate
} from "./types/Config";
import type {
  GlobalRiskConfig,
  GlobalRiskConfigUpdate,
  MacroBias,
  MacroBiasDirection,
  MacroBiasUpdate,
  NotificationSettings,
  NotificationSettingsUpdate,
  SupervisorSource,
  TemporaryGovernanceOverride,
  TemporaryGovernanceOverrideUpdate
} from "./types/Config";
export type {
  AgentDecisionTrace,
  AgentSignal,
  AmVpinRingSnapshot,
  AnomalyDetectorState,
  AnomalyStatsBucket,
  AnomalyStatus,
  AnomalyTopOfBookBucket,
  AnomalyTopOfBookSnapshot,
  AnomalyVolumeBucket,
  AuditContext,
  DomAnalysisSnapshot,
  DomHeatmapCell,
  DomHeatmapPayload,
  LiquidationCascadeCluster,
  LiquidationEventRecord,
  LiquidationHeatmapLevel,
  LiquidationHeatmapState,
  LiquidationSide,
  LiquidityWall,
  LiquidityWallStatus,
  MarketAnomalyEvent,
  MarketAnomalySeverity,
  MarketAnomalyType,
  ProfilerState,
  ProfilerVolumeBucket,
  ToxicityPressureSide,
  ToxicityState,
  TradeExecution,
  WelfordStats
} from "./types/Telemetry";
import type {
  AgentDecisionTrace,
  AgentSignal,
  AmVpinRingSnapshot,
  AnomalyDetectorState,
  AnomalyStatsBucket,
  AnomalyStatus,
  AnomalyTopOfBookBucket,
  AnomalyTopOfBookSnapshot,
  AnomalyVolumeBucket,
  AuditContext,
  DomAnalysisSnapshot,
  DomHeatmapCell,
  DomHeatmapPayload,
  LiquidationCascadeCluster,
  LiquidationEventRecord,
  LiquidationHeatmapLevel,
  LiquidationHeatmapState,
  LiquidationSide,
  LiquidityWall,
  LiquidityWallStatus,
  MarketAnomalyEvent,
  MarketAnomalySeverity,
  MarketAnomalyType,
  ProfilerState,
  ProfilerVolumeBucket,
  ToxicityPressureSide,
  ToxicityState,
  TradeExecution,
  WelfordStats
} from "./types/Telemetry";
export type {
  BayesianUpdateTrace,
  EnsembleAgentVote,
  EnsembleState,
  ExchangeOpenOrder,
  ExecutionReport,
  ExecutionStyle,
  ExecutionTimeInForce,
  InternalOrderBook,
  InventoryGuardState,
  InventoryState,
  JanitorState,
  LeadLagMetrics,
  LeadLagSample,
  ManagedOrder,
  ManagedOrderStatus,
  MarketRegime,
  OracleInstrumentState,
  OracleMemoryState,
  OraclePdf,
  OracleState,
  ProbabilityPoint,
  QuoteOrder,
  QuoteSide,
  QuoteSignal,
  QuoteState,
  ReplayAblationResult,
  ReplayAttributionBucket,
  ReplayResult,
  ReplayStressResult,
  ReplayWalkForwardResult,
  RiskMetrics,
  SentimentState,
  ShadowTrade,
  SlippageAnalytics,
  SlippagePoint,
  TradeDirection,
  TradeIntent
} from "./types/Trading";
import type {
  BayesianUpdateTrace,
  EnsembleAgentVote,
  EnsembleState,
  ExchangeOpenOrder,
  ExecutionReport,
  ExecutionStyle,
  ExecutionTimeInForce,
  InternalOrderBook,
  InventoryGuardState,
  InventoryState,
  JanitorState,
  LeadLagMetrics,
  LeadLagSample,
  ManagedOrder,
  ManagedOrderStatus,
  MarketRegime,
  OracleInstrumentState,
  OracleMemoryState,
  OraclePdf,
  OracleState,
  ProbabilityPoint,
  QuoteOrder,
  QuoteSide,
  QuoteSignal,
  QuoteState,
  ReplayAblationResult,
  ReplayAttributionBucket,
  ReplayResult,
  ReplayStressResult,
  ReplayWalkForwardResult,
  RiskMetrics,
  SentimentState,
  ShadowTrade,
  SlippageAnalytics,
  SlippagePoint,
  TradeDirection,
  TradeIntent
} from "./types/Trading";

export interface Position {
  instrumentCode: string;
  side: "LONG" | "SHORT";
  quantity: number;
  averageEntryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  updatedAt: ISO8601;
}

export interface AgentHealth {
  status: HealthStatus;
  heartbeatAt: ISO8601;
  latencyMs: number;
  lastSignalId?: string;
  failures24h: number;
}

export interface RiskLimits {
  configVersion: string;
  killSwitch: boolean;
  maxGrossExposure: number;
  maxNetExposure: number;
  maxOrderNotional: number;
  maxDrawdownPct: number;
  perAssetMaxPosition: Record<string, number>;
  updatedAt: ISO8601;
}

export interface AssetRuntimeState {
  instrumentCode: string;
  coin: string;
  selectedByMoltworker: boolean;
  active: boolean;
  isSynced: boolean;
  lastSequence: number | null;
  midPrice: number | null;
  volatility: number;
  capitalAllocationPct: number;
  maxNotional: number;
  toxicityState: ToxicityState;
  amVpin: number;
  obi: number | null;
  quoteStatus: "ACTIVE" | "SUSPENDED";
  quoteReason: string | null;
  quoteSuspendedUntil: ISO8601 | null;
  quoteEligible: boolean;
  lastQuoteAt: ISO8601 | null;
  updatedAt: ISO8601 | null;
}

export type ShadowQueueLight = "IDLE" | "GREEN_LIGHT" | "RED_LIGHT" | "NO_EDGE";

export interface ShadowQueueFill {
  fillId: string;
  instrumentCode: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  queueAhead: number;
  p0MidPrice: number;
  fillTradeSequence: number;
  filledAt: ISO8601;
}

export interface ShadowQueueDecision {
  decisionId: string;
  fillId: string;
  instrumentCode: string;
  originalSide: "BUY" | "SELL";
  action: ShadowQueueLight;
  dispatchSide: "BUY" | "SELL" | null;
  p0MidPrice: number;
  pnMidPrice: number;
  microDrift: number;
  driftTrades: number;
  tickThreshold: number;
  decisionLatencyMs: number;
  tradeIntentId: string | null;
  reason: string;
  decidedAt: ISO8601;
}

export interface ShadowQueueState {
  schemaVersion: "shadow-queue.v1";
  capacity: number;
  activeOrders: number;
  pendingDrifts: number;
  ghostFills: number;
  greenLights: number;
  redLights: number;
  noEdgeSignals: number;
  invertedSignals: number;
  confirmedSignals: number;
  driftTradeDelay: number;
  latencyBudgetMs: number;
  baseSpreadBps: number;
  queueDepthMultiplier: number;
  lastFill: ShadowQueueFill | null;
  lastDecision: ShadowQueueDecision | null;
  updatedAt: ISO8601 | null;
}

export interface EngineState {
  engineId: string;
  mode: EngineMode;
  bankroll: {
    currency: string;
    cash: number;
    equity: number;
    realizedPnl: number;
    updatedAt: ISO8601;
  };
  openPositions: Record<string, Position>;
  agentHealth: Record<AgentName, AgentHealth>;
  risk: RiskLimits;
  processedTicks: number;
  acceptedSignals: number;
  internalOrderBookDepth: number;
  averageLatency: number;
  latencySampleCount: number;
  staleTickCount: number;
  toxicityScore: number;
  current_inventory_delta: number;
  liquidationHeatmap: LiquidationHeatmapState;
  maxLatencyMs: number;
  cachedConfig: GlobalRiskConfig;
  macroBias: MacroBias;
  temporaryOverride: TemporaryGovernanceOverride | null;
  assetMatrix: Record<string, AssetRuntimeState>;
  profilerStates: Record<string, ProfilerState>;
  location: EngineLocation;
  fundingRates: Record<string, FundingRateSnapshot>;
  microstructure: MicrostructureMetrics;
  priceDiscovery: PriceDiscoveryMetrics;
  oracle: OracleState;
  sentiment: SentimentState;
  ensemble: EnsembleState;
  leadLag: LeadLagMetrics;
  inventory: InventoryState;
  riskMetrics: RiskMetrics;
  quoteState: QuoteState;
  assetQuoteStates: Record<string, QuoteState>;
  shadowQueue: ShadowQueueState;
  lastTradeIntent: TradeIntent | null;
  inventoryGuard: InventoryGuardState;
  janitor: JanitorState;
  slippage: SlippageAnalytics;
  orderMap: Record<string, ManagedOrder>;
  executionProfile: ExecutionProfile;
  citadel: CitadelState;
  dom: DomAnalysisSnapshot | null;
  anomaly: AnomalyStatus;
  heartbeatAt: ISO8601;
  updatedAt: ISO8601;
}

export interface CitadelState {
  status: CitadelOperationalStatus;
  reason: string | null;
  shadowMode: boolean;
  lastEvacuationAt: ISO8601 | null;
  updatedAt: ISO8601 | null;
}

export interface AdminConfigUpdate {
  mode?: EngineMode;
  bankroll?: Partial<EngineState["bankroll"]>;
  risk?: Partial<RiskLimits>;
  config?: GlobalRiskConfigUpdate;
  signal?: "REFRESH_CONFIG";
  TRADING_ENABLED?: boolean;
  STRATEGY_MODE?: StrategyMode;
  ORACLE_ENABLED?: boolean;
  SENTIMENT_ENABLED?: boolean;
  PROFILER_ENABLED?: boolean;
  CROUPIER_ENABLED?: boolean;
  PIT_BOSS_ENABLED?: boolean;
  MARKET_MAKING_MODE?: MarketMakingMode;
  MAX_POSITION_SIZE?: number;
  MAX_POSITION_PCT?: number;
  MAX_INVENTORY_UNITS?: number;
  MAX_INVENTORY_DELTA?: number;
  MAX_DRAWDOWN_PCT?: number;
  LATENCY_THRESHOLD_MS?: number;
  GOLDEN_COLOS?: string;
  MIN_EV_THRESHOLD?: number;
  EXCHANGE_FEE_BPS?: number;
  KELLY_FRACTION?: number;
  RISK_AVERSION_FACTOR?: number;
  FUNDING_BIAS_THRESHOLD?: number;
  FUNDING_INVENTORY_BIAS?: number;
  HEDGE_ENABLED?: boolean;
  HEDGE_TRIGGER_INVENTORY_PCT?: number;
  HEDGE_COOLDOWN_MS?: number;
  HEDGE_MAX_SLIPPAGE_BPS?: number;
  CASCADE_TAKER_ENABLED?: boolean;
  CASCADE_INSTRUMENTS?: string;
  CASCADE_ASSET_PROFILES?: string;
  LAYERED_QUOTE_LEVELS?: number;
  LAYERED_QUOTE_SIZE_DECAY?: number;
  LAYERED_QUOTE_SPREAD_STEP_BPS?: number;
  CVAR_CONFIDENCE?: number;
  CVAR_MAX_TAIL_LOSS_BPS?: number;
  CVAR_LOOKBACK_TRADES?: number;
  SENTIMENT_ALPHA_MODE?: SentimentAlphaMode;
  TOXICITY_CLASSIFIER_ENABLED?: boolean;
  TOXICITY_CLASSIFIER_THRESHOLD?: number;
  FUNDING_PRE_SETTLEMENT_WINDOW_MS?: number;
  FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER?: number;
  QUOTE_HIBERNATE_MS?: number;
  VAR_CONFIDENCE_Z?: number;
  ORACLE_GOVERNANCE_MODE?: GovernanceMode;
  ORACLE_MANUAL_SKEPTICISM?: number;
  ORACLE_MAX_SKEPTICISM?: number;
  AM_VPIN_BUCKET_VOLUME?: number;
  AM_VPIN_ROLLING_WINDOW?: number;
  AM_VPIN_DIRECTIONAL_DECAY?: number;
  AM_VPIN_NORMAL_THRESHOLD?: number;
  AM_VPIN_TOXIC_THRESHOLD?: number;
  AM_VPIN_CRITICAL_THRESHOLD?: number;
  AM_VPIN_OBI_DEPTH?: number;
  AM_VPIN_CRITICAL_OBI?: number;
  AM_VPIN_CONTESTED_SPREAD_MULTIPLIER?: number;
  AM_VPIN_TOXIC_SPREAD_MULTIPLIER?: number;
  AM_VPIN_QUOTE_HALT_MS?: number;
  CASCADE_WINDOW_MS?: number;
  CASCADE_NOTIONAL_THRESHOLD_USD?: number;
  CASCADE_ZSCORE_THRESHOLD?: number;
  CASCADE_LOOKBACK_HOURS?: number;
  CASCADE_DIRECTIONAL_PCT?: number;
  CASCADE_MIN_PRICE_MOVE_ATR?: number;
  ABSORPTION_WINDOW_MS?: number;
  ABSORPTION_PRICE_BAND_BPS?: number;
  ABSORPTION_MIN_HOLD_SECONDS?: number;
  ENTRY_WINDOW_SECONDS?: number;
  IMPULSIVE_BAR_BODY_ATR?: number;
  IMPULSIVE_BAR_VOLUME_MULT?: number;
  STOP_BUFFER_ATR?: number;
  MIN_STOP_DISTANCE_BPS?: number;
  MAX_STOP_DISTANCE_BPS?: number;
  MIN_TIME_SINCE_LAST_CASCADE_SECONDS?: number;
  NEWS_BLACKOUT_MINUTES?: number;
  MAX_REALIZED_VOL_PERCENTILE?: number;
  CASCADE_TIME_STOP_HOURS?: number;
  PARTIAL_1_R?: number;
  PARTIAL_1_SIZE_PCT?: number;
  PARTIAL_2_R?: number;
  PARTIAL_2_SIZE_PCT?: number;
  TRAILING_STOP_TYPE?: "ATR" | "EMA";
  TRAILING_STOP_PARAM?: number;
  RISK_PER_TRADE_PCT?: number;
  HEAT_CAP_PCT?: number;
  MAX_POSITION_NOTIONAL_PCT?: number;
  ASSET_LIQUIDITY_CAP_USD?: number;
  DAILY_LOSS_LIMIT_PCT?: number;
  WEEKLY_LOSS_LIMIT_PCT?: number;
  MAX_CONSECUTIVE_LOSSES?: number;
  maxLatencyMs?: number;
  MAX_LATENCY?: number;
  performance?: Partial<PerformanceConfig>;
  actor?: string;
  macroBias?: MacroBiasUpdate;
  temporaryOverride?: TemporaryGovernanceOverrideUpdate;
  clearMacroBias?: boolean;
  clearTemporaryOverride?: boolean;
  confirmHighImpact?: boolean;
  confirmLive?: boolean;
  confirmLiveReadinessOverride?: boolean;
  confirmCostBudgetOverride?: boolean;
}

export interface HealthReport {
  ok: boolean;
  engineId: string;
  mode: EngineMode;
  heartbeatAt: ISO8601;
  uptimeMs: number;
  processedTicks: number;
  acceptedSignals: number;
  internalOrderBookDepth: number;
  averageLatency: number;
  staleTickCount: number;
  toxicityScore: number;
  current_inventory_delta: number;
  location: EngineLocation;
  microstructure: MicrostructureMetrics;
  quoteState: QuoteState;
  executionProfile: ExecutionProfile;
  anomaly: AnomalyStatus;
  memoryUsage: {
    available: boolean;
    usedJSHeapSize: number | null;
    totalJSHeapSize: number | null;
    jsHeapSizeLimit: number | null;
    stateBytesEstimate: number;
  };
}

export interface LogEvent {
  level: "DEBUG" | "INFO" | "WARN" | "ERROR" | "CRITICAL";
  eventType: string;
  source: string;
  message: string;
  correlationId?: string;
  telemetry?: JsonRecord;
}
