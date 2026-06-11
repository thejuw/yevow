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

export type MarketAnomalyType =
  | "FLASH_CRASH"
  | "FAT_FINGER_TRADE"
  | "VOLUME_SPIKE"
  | "AGGRESSIVE_SPOOFING"
  | "TOP_OF_BOOK_CANCELLATION_SPIKE";

export type MarketAnomalySeverity = "WARN" | "CRITICAL";

export interface WelfordStats {
  count: number;
  mean: number;
  m2: number;
}

export interface AnomalyStatsBucket {
  bucketStartMs: number;
  updatedAt: ISO8601;
  stats: WelfordStats;
}

export interface AnomalyVolumeBucket {
  bucketStartMs: number;
  updatedAt: ISO8601;
  volume: number;
}

export interface AnomalyTopOfBookBucket {
  bucketStartMs: number;
  updatedAt: ISO8601;
  cancellations: number;
  executions: number;
}

export interface AnomalyTopOfBookSnapshot {
  bestBid: number | null;
  bestAsk: number | null;
  bestBidSize: number | null;
  bestAskSize: number | null;
  sequence: number | null;
  updatedAt: ISO8601;
}

export interface MarketAnomalyEvent {
  anomalyId: string;
  types: MarketAnomalyType[];
  severity: MarketAnomalySeverity;
  instrumentCode: string;
  exchangeCode: string;
  sequence: number;
  priceZScore: number | null;
  volumeZScore: number | null;
  cancellationToExecutionRatio: number;
  reason: string;
  triggeredPause: boolean;
  observedAt: ISO8601;
}

export interface AnomalyStatus {
  status: "CLEAR" | "ANOMALY";
  priceZScore: number | null;
  volumeZScore: number | null;
  cancellationToExecutionRatio: number;
  cancellationCount: number;
  executionCount: number;
  lastAnomaly: MarketAnomalyEvent | null;
  updatedAt: ISO8601 | null;
}

export interface AnomalyDetectorState {
  schemaVersion: "anomaly-detector.v1";
  priceWindowMs: number;
  volumeWindowMs: number;
  topOfBookWindowMs: number;
  priceBuckets: AnomalyStatsBucket[];
  volumeBuckets: AnomalyVolumeBucket[];
  topOfBookBuckets: AnomalyTopOfBookBucket[];
  lastTopOfBook: AnomalyTopOfBookSnapshot | null;
  status: AnomalyStatus;
  updatedAt: ISO8601;
}

export interface AuditContext {
  lastTickTimestamp: ISO8601 | null;
  orderBookImbalance: number | null;
  colo?: string | null;
  placement?: string | null;
  latencyRiskMultiplier?: number;
  positionSizeMultiplier?: number;
}

export interface TradeExecution {
  tradeId: string;
  orderId: string;
  signalId?: string;
  venue: string;
  asset: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT" | "IOC" | "FOK";
  price: number;
  size: number;
  evAtExecution: number;
  slippageBps: number;
  resultingPnl: number;
  primaryDriver?: AgentName;
  fees?: number;
  status: "ACCEPTED" | "FILLED" | "PARTIAL" | "REJECTED" | "CANCELLED" | "GHOST_FILL";
  exchangeTradeId?: string;
  metadata?: JsonRecord;
  executedAt: ISO8601;
}

export interface AgentDecisionTrace {
  decisionId: string;
  signalId: string;
  traceId: string;
  agentName: AgentName;
  targetAgent?: AgentName;
  instrumentCode: string;
  action: AgentAction;
  confidence: number;
  expectedValue?: number;
  maxSlippageBps?: number;
  reasoning: string;
  featureVector?: JsonRecord;
  riskSnapshot?: JsonRecord;
  rawSignal?: JsonRecord;
  latencyMs?: number;
  createdAt: ISO8601;
}

export interface AgentSignal {
  signalId: string;
  traceId: string;
  sourceAgent: AgentName;
  targetAgent: AgentName;
  instrumentCode: string;
  action: AgentAction;
  confidence: number;
  horizonMs: number;
  expectedValue: number;
  maxSlippageBps: number;
  rationale: string;
  featureVector: JsonRecord;
  riskContext: JsonRecord;
  createdAt: ISO8601;
}

export interface ProfilerVolumeBucket {
  bucketId: string;
  instrumentCode: string;
  startedAt: ISO8601;
  closedAt: ISO8601 | null;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  imbalance: number;
  directionalImbalance?: number;
  obi?: number | null;
  amVpin?: number;
  toxicityState?: ToxicityState;
}

export type ToxicityState = "NORMAL" | "CONTESTED" | "TOXIC" | "CRITICAL";
export type ToxicityPressureSide = "BUY" | "SELL" | "NEUTRAL";

export interface AmVpinRingSnapshot {
  buyVolumes: number[];
  sellVolumes: number[];
  signedImbalances: number[];
  directionalImbalances: number[];
  obiValues: number[];
}

export interface ProfilerState {
  schemaVersion: "profiler.v1";
  bucketSize: number;
  rollingWindow: number;
  alertThreshold: number;
  toxicityScore: number;
  amVpinScore: number;
  obi: number | null;
  obiDepth: number;
  directionalDecay: number;
  latestSignedImbalance: number;
  latestDirectionalImbalance: number;
  toxicityState: ToxicityState;
  pressureSide: ToxicityPressureSide;
  spreadMultiplier: number;
  reservationShiftBps: number;
  quoteHaltUntil: ISO8601 | null;
  amVpinBucketCompletions: number;
  amVpinMean: number;
  amVpinM2: number;
  amVpinVariance: number;
  amVpinRing: AmVpinRingSnapshot;
  distanceToCascadePct: number | null;
  cascadeShieldUntil: ISO8601 | null;
  cascadeClusterId: string | null;
  cascadeSide: LiquidationSide | null;
  activeBucket: ProfilerVolumeBucket | null;
  buckets: ProfilerVolumeBucket[];
  totalBucketsClosed: number;
  lastProcessedSequence: number | null;
  lastSignalId: string | null;
  lastAlertBucketCount: number;
  lastSpoofingWallId: string | null;
  tradeSizeCount: number;
  tradeSizeMean: number;
  tradeSizeM2: number;
  tradeSizeWindow: Array<{ size: number; observedAt: ISO8601 }>;
  quoteSuspendedUntil: ISO8601 | null;
  updatedAt: ISO8601;
}

export type LiquidationSide = "LONG" | "SHORT" | "UNKNOWN";

export interface LiquidationHeatmapLevel {
  levelId: string;
  instrumentCode: string;
  source_exchange: string;
  side: LiquidationSide;
  priceStart: number;
  priceEnd: number;
  centerPrice: number;
  estimatedNotionalUsd: number;
  estimatedBaseSize: number;
  walletCount: number;
  eventCount: number;
  confidence: number;
  source: "CLEARINGHOUSE_STATE" | "USER_EVENT" | "SYNTHETIC";
  updatedAt: ISO8601;
}

export interface LiquidationCascadeCluster extends LiquidationHeatmapLevel {
  clusterId: string;
  distanceFromMidPct: number | null;
  distanceFromMidBps: number | null;
  forcedFlowSide: "BUY" | "SELL" | "UNKNOWN";
  isCascadeRisk: boolean;
}

export interface LiquidationEventRecord {
  eventId: string;
  instrumentCode: string | null;
  side: LiquidationSide;
  notionalUsd: number | null;
  price: number | null;
  liquidatedUser: string | null;
  source: "USER_EVENT" | "LEDGER_EVENT" | "UNKNOWN";
  observedAt: ISO8601;
}

export interface LiquidationHeatmapState {
  schemaVersion: "liquidation-heatmap.v1";
  instrumentCode: string | null;
  source_exchange: string;
  binSize: number;
  clusterThresholdUsd: number;
  cascadeDistancePct: number;
  levels: LiquidationHeatmapLevel[];
  clusters: LiquidationCascadeCluster[];
  nearestCascade: LiquidationCascadeCluster | null;
  recentEvents: LiquidationEventRecord[];
  totalEstimatedNotionalUsd: number;
  sampledWalletCount: number;
  lastSampleAt: ISO8601 | null;
  updatedAt: ISO8601;
}

export type LiquidityWallStatus = "ACTIVE" | "PULLED" | "FILLED";

export interface LiquidityWall {
  wallId: string;
  instrumentCode: string;
  exchangeCode: string;
  side: OrderBookSide;
  priceStart: number;
  priceEnd: number;
  centerPrice: number;
  volume: number;
  meanVolume: number;
  sigmaVolume: number;
  zScore: number;
  levelCount: number;
  status: LiquidityWallStatus;
  firstSeenAt: ISO8601;
  lastSeenAt: ISO8601;
  lastSequence: number | null;
  distanceFromMidBps: number | null;
  spoofingSuspected: boolean;
}

export type DomHeatmapCell = [
  side: 0 | 1,
  priceStart: number,
  priceEnd: number,
  volume: number,
  levelCount: number,
  zScore: number
];

export interface DomHeatmapPayload {
  schemaVersion: "dom.heatmap.v1";
  columns: ["side", "priceStart", "priceEnd", "volume", "levelCount", "zScore"];
  sideEncoding: { bid: 0; ask: 1 };
  cells: DomHeatmapCell[];
}

export interface DomAnalysisSnapshot {
  schemaVersion: "dom.analysis.v1";
  instrumentCode: string;
  exchangeCode: string | null;
  sequence: number | null;
  midPrice: number | null;
  scanRangePct: number;
  lowerBound: number | null;
  upperBound: number | null;
  binSize: number;
  meanVolume: number;
  sigmaVolume: number;
  walls: LiquidityWall[];
  pulledWalls: LiquidityWall[];
  filledWalls: LiquidityWall[];
  heatmap: DomHeatmapPayload;
  history: LiquidityWall[];
  updatedAt: ISO8601;
}

export interface InternalOrderBook {
  marketKey: string;
  source: MarketDataSource;
  source_exchange: string;
  sourceWeight: number;
  instrumentCode: string;
  exchangeCode: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  spreadBps: number | null;
  weightedImbalance: number | null;
  lastSequence: number | null;
  tickSize: number;
  ttbLatencyMs: number | null;
  isSynced: boolean;
  desyncReason?: string | null;
  sequence: number;
  updatedAt: ISO8601;
}

export type MarketRegime = "REGIME_TREND" | "REGIME_RANGE" | "REGIME_CRISIS";
export type TradeDirection = "LONG" | "SHORT";
export type QuoteSide = "BID" | "ASK";
export type ExecutionTimeInForce = "ALO" | "GTC" | "IOC" | "FOK";
export type ExecutionStyle = "POST_ONLY_QUOTE" | "TAKER_IOC" | "TAKER_MARKET" | "SLICED_TWAP";
export type ManagedOrderStatus =
  | "PENDING"
  | "OPEN"
  | "PARTIAL_FILL"
  | "FILLED"
  | "GHOST_FILL"
  | "CANCELLED"
  | "REJECTED";

export interface ProbabilityPoint {
  price: number;
  probability: number;
}

export interface OraclePdf {
  schemaVersion: "oracle.pdf.v1";
  instrumentCode: string;
  horizonSeconds: number;
  currentPrice: number;
  volatility: number;
  degreesOfFreedom: number;
  points: ProbabilityPoint[];
  generatedAt: ISO8601;
}

export interface BayesianUpdateTrace {
  priorBullishProbability: number;
  posteriorBullishProbability: number;
  delta: number;
  evidence: JsonRecord;
  updatedAt: ISO8601;
}

export interface OracleMemoryState {
  lastPrice: number | null;
  lastUpdateMs: number;
  variance: number;
  atr: number;
  trendEma: number;
  imbalanceMean: number;
  imbalanceM2: number;
  imbalanceCount: number;
  lastImbalance: number | null;
  volumeMean: number;
  volumeM2: number;
  volumeCount: number;
}

export type OracleInstrumentState = Omit<OracleState, "instrumentStates" | "memoryByInstrument">;

export interface OracleState {
  schemaVersion: "oracle.v1";
  instrumentCode: string | null;
  regime: MarketRegime;
  volatility: number;
  atr: number;
  adx: number;
  atrToVolumeEfficiency: number;
  skepticismMultiplier: number;
  governanceMode: GovernanceMode;
  manualSkepticism: number;
  maxSkepticism: number;
  profitTargetBps: number;
  pdf: OraclePdf | null;
  posteriorPdf: OraclePdf | null;
  lastBayesianUpdate: BayesianUpdateTrace | null;
  instrumentStates?: Record<string, OracleInstrumentState>;
  memoryByInstrument?: Record<string, OracleMemoryState>;
  updatedAt: ISO8601 | null;
}

export interface SentimentState {
  schemaVersion: "sentiment.v1";
  score: number;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number;
  headline: string | null;
  model: string;
  provider?: "WORKERS_AI" | "LEXICAL";
  fallbackUsed?: boolean;
  latencyMs?: number | null;
  estimatedCostUsd?: number;
  ablation?: {
    enabled: boolean;
    lexicalScore: number;
    aiScore: number | null;
    edgeAfterCostsBps: number | null;
    evaluatedAt: ISO8601 | null;
  };
  updatedAt: ISO8601 | null;
}

export interface EnsembleAgentVote {
  agent: AgentName;
  confidence: number;
  weight: number;
  contribution: number;
  rationale: string;
}

export interface EnsembleState {
  schemaVersion: "ensemble.v1";
  confidence: number;
  kellyMultiplier: number;
  regimeMultiplier: number;
  anomalyCircuitBreaker: boolean;
  votes: EnsembleAgentVote[];
  rationale: string;
  updatedAt: ISO8601 | null;
}

export interface LeadLagSample {
  instrumentCode: string;
  price: number;
  observedAt: ISO8601;
}

export interface LeadLagMetrics {
  schemaVersion: "lead-lag.v1";
  leadInstrument: string | null;
  lagInstrument: string | null;
  correlation: number | null;
  lagMs: number | null;
  leadLagDelta: number | null;
  expectedValue: number | null;
  executable: boolean;
  sampleCount: number;
  updatedAt: ISO8601 | null;
}

export interface TradeIntent {
  schemaVersion: "trade-intent.v1";
  intentId: string;
  traceId: string;
  instrumentCode: string;
  marketKey: string | null;
  source_exchange: string | null;
  direction: TradeDirection;
  executionStyle?: ExecutionStyle;
  action: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT" | "IOC" | "FOK";
  postOnly: boolean;
  timeInForce: ExecutionTimeInForce;
  intendedPrice: number;
  expectedPrice: number;
  requestedSize: number;
  approvedSize: number | null;
  probabilityWin: number;
  probabilityLoss: number;
  profit: number;
  loss: number;
  executionCosts: number;
  adverseSelectionCost: number;
  expectedValue: number;
  minEvThreshold: number;
  maxSlippageBps: number;
  confidence: number;
  rationale: string;
  targetSubaccount?: string | null;
  target_subaccount?: string | null;
  createdAt: ISO8601;
}

export interface QuoteOrder {
  clientOrderId: string;
  side: QuoteSide;
  price: number;
  size: number;
  postOnly: boolean;
  strategy?: "AMM" | "LIQUIDATION_ABSORPTION";
  clusterId?: string;
}

export interface QuoteSignal {
  schemaVersion: "quote-signal.v1";
  signalId: string;
  instrumentCode: string;
  marketKey: string | null;
  reservationPrice: number;
  optimalSpread: number;
  orders: QuoteOrder[];
  createdAt: ISO8601;
}

export interface QuoteState {
  status: "ACTIVE" | "SUSPENDED";
  reason: string | null;
  suspendedUntil: ISO8601 | null;
  lastQuote: QuoteSignal | null;
  updatedAt: ISO8601 | null;
}

export interface InventoryState {
  netDelta: number;
  current_inventory_delta: number;
  baseAsset: string;
  normalization: Record<string, number>;
  maxInventoryUnits: number;
  maxInventoryDelta: number;
  inventoryPenalty: number;
  stopBid: boolean;
  stopAsk: boolean;
  updatedAt: ISO8601 | null;
}

export interface RiskMetrics {
  highWaterMark: number;
  rollingDrawdownPct: number;
  var99OneHour: number;
  isTradingEnabled: boolean;
  updatedAt: ISO8601 | null;
}

export interface ManagedOrder {
  clientId: string;
  exchangeOrderId: string | null;
  intentId: string | null;
  instrumentCode: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  filledSize: number;
  status: ManagedOrderStatus;
  createdAt: ISO8601;
  updatedAt: ISO8601;
  ackDeadlineAt: ISO8601;
}

export interface ExecutionReport {
  clientId: string;
  exchangeOrderId?: string;
  instrumentCode?: string;
  side?: "BUY" | "SELL";
  orderSize?: number;
  status: ManagedOrderStatus;
  filledSize?: number;
  fillIncrementSize?: number;
  achievedPrice?: number;
  expectedPrice?: number;
  fees?: number;
  latencyMs?: number;
  reason?: string;
  rawStatus?: string;
  observedAt: ISO8601;
}

export interface ExchangeOpenOrder {
  clientId: string | null;
  exchangeOrderId: string;
  instrumentCode: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  filledSize: number;
  status: ManagedOrderStatus;
  observedAt: ISO8601;
}

export interface InventoryGuardState {
  netDelta: number;
  current_inventory_delta: number;
  maxInventoryDelta: number;
  hardCapReached: boolean;
  quoteHaltRequired: boolean;
  skewRatio: number;
  preferredVenue: string | null;
  lastIntent: TradeIntent | null;
  updatedAt: ISO8601 | null;
}

export interface JanitorState {
  lastRunAt: ISO8601 | null;
  zombieOrders: string[];
  orphanExchangeOrders: string[];
  reconciledOrders: string[];
  cancelledOrders: string[];
  dustPositions: string[];
  dustCloseIntents: string[];
  prunedTelemetryCount: number;
  updatedAt: ISO8601 | null;
}

export interface SlippagePoint {
  expectedPrice: number;
  achievedPrice: number;
  slippageBps: number;
  implementationShortfall: number;
  latencyMs: number;
  observedAt: ISO8601;
}

export interface SlippageAnalytics {
  schemaVersion: "slippage.v1";
  points: SlippagePoint[];
  averageSlippageBps: number;
  latencyCorrelation: number | null;
  executionCostBufferBps: number;
  updatedAt: ISO8601 | null;
}

export interface ShadowTrade {
  tradeId: string;
  instrumentCode: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number | null;
  size: number;
  theoreticalPnl: number;
  fees?: number;
  slippageBps?: number;
  driver?: AgentName | "UNATTRIBUTED";
  regime?: MarketRegime | "UNKNOWN";
  openedAt: ISO8601;
  closedAt: ISO8601 | null;
}

export interface ReplayAttributionBucket {
  key: string;
  tradeCount: number;
  pnl: number;
  grossProfit: number;
  grossLoss: number;
  winRate: number | null;
  sharpe: number | null;
}

export interface ReplayStressResult {
  scenario: "BASELINE" | "FLASH_CRASH" | "DELEVERAGING_2022" | "LATENCY_SHOCK";
  pnl: number;
  maxDrawdown: number;
  generatedIntentCount: number;
  simulatedTradeCount: number;
}

export interface ReplayWalkForwardResult {
  segment: number;
  dateFrom: ISO8601 | null;
  dateTo: ISO8601 | null;
  pnl: number;
  sharpe: number | null;
  maxDrawdown: number;
  tradeCount: number;
}

export interface ReplayAblationResult {
  sentimentEnabledPnl: number;
  sentimentDisabledPnl: number;
  deltaPnl: number;
  estimatedAiCostUsd: number;
  netEdgeAfterCosts: number;
}

export interface ReplayResult {
  replayId: string;
  strategyVersionId?: string | null;
  scenario?: "BASELINE" | "FLASH_CRASH" | "DELEVERAGING_2022" | "LATENCY_SHOCK";
  ticksReplayed: number;
  shadowBankroll: number;
  theoreticalPnl: number;
  baselinePnl: number;
  actualTradeCount: number;
  generatedIntentCount: number;
  simulatedTradeCount?: number;
  speedMultiplier: number;
  maxDrawdown?: number;
  sharpe?: number | null;
  winRate?: number | null;
  latencyModel?: JsonRecord;
  slippageModel?: JsonRecord;
  feeModel?: JsonRecord;
  attribution?: {
    byAgent: ReplayAttributionBucket[];
    byAsset: ReplayAttributionBucket[];
    byRegime: ReplayAttributionBucket[];
  };
  stressResults?: ReplayStressResult[];
  walkForward?: ReplayWalkForwardResult[];
  ablation?: ReplayAblationResult | null;
  shadowTrades: ShadowTrade[];
  startedAt: ISO8601;
  completedAt: ISO8601;
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
