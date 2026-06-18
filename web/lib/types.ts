export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;

export type GovernanceMode = "MANUAL" | "AUTONOMOUS" | "HYBRID";
export type MarketMakingMode =
  | "OFF"
  | "PASSIVE"
  | "BALANCED"
  | "AGGRESSIVE"
  | "INVENTORY_SKEW_ONLY";
export type MacroBiasDirection = "BULLISH" | "BEARISH" | "RISK_ON" | "RISK_OFF" | "NEUTRAL";
export type AlertPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AlertChannel = "DISCORD" | "TELEGRAM" | "GENERIC_WEBHOOK";
export type TradeAlertMode = "ALL" | "FILLED_ONLY" | "NONE";
export type ToxicityState = "NORMAL" | "CONTESTED" | "TOXIC" | "CRITICAL";
export type ToxicityPressureSide = "BUY" | "SELL" | "NEUTRAL";
export type CitadelOperationalStatus = "NOMINAL" | "WATCH" | "CRITICAL";
export type SentimentAlphaMode = "OFF" | "EVENT_RISK_ONLY" | "CONTINUOUS";
export type StrategyMode =
  | "OFF"
  | "MARKET_MAKING"
  | "CASCADE_RECOVERY"
  | "BOTH_SHADOW"
  | "BOTH_LIVE";

export interface GlobalRiskConfig {
  TRADING_ENABLED: boolean;
  STRATEGY_MODE: StrategyMode;
  ORACLE_ENABLED: boolean;
  SENTIMENT_ENABLED: boolean;
  PROFILER_ENABLED: boolean;
  CROUPIER_ENABLED: boolean;
  PIT_BOSS_ENABLED: boolean;
  MARKET_MAKING_MODE: MarketMakingMode;
  MAX_POSITION_SIZE: number;
  MAX_POSITION_PCT: number;
  MAX_INVENTORY_UNITS: number;
  MAX_INVENTORY_DELTA: number;
  MAX_DRAWDOWN_PCT: number;
  LATENCY_THRESHOLD_MS: number;
  GOLDEN_COLOS: string;
  MIN_EV_THRESHOLD: number;
  EXCHANGE_FEE_BPS: number;
  KELLY_FRACTION: number;
  RISK_AVERSION_FACTOR: number;
  FUNDING_BIAS_THRESHOLD: number;
  FUNDING_INVENTORY_BIAS: number;
  HEDGE_ENABLED: boolean;
  HEDGE_TRIGGER_INVENTORY_PCT: number;
  HEDGE_COOLDOWN_MS: number;
  HEDGE_MAX_SLIPPAGE_BPS: number;
  CASCADE_TAKER_ENABLED: boolean;
  CASCADE_INSTRUMENTS: string;
  CASCADE_ASSET_PROFILES: string;
  MAX_SPREAD_BPS_FOR_TAKER: number;
  MAX_SINGLE_ORDER_NOTIONAL_USD: number;
  SLICE_NOTIONAL_THRESHOLD_USD: number;
  SLICE_NOTIONAL_PER_CHUNK: number;
  SLICE_INTERVAL_MS: number;
  SLICE_JITTER_MS: number;
  MIN_FILL_RATIO: number;
  LAYERED_QUOTE_LEVELS: number;
  LAYERED_QUOTE_SIZE_DECAY: number;
  LAYERED_QUOTE_SPREAD_STEP_BPS: number;
  CVAR_CONFIDENCE: number;
  CVAR_MAX_TAIL_LOSS_BPS: number;
  CVAR_LOOKBACK_TRADES: number;
  SENTIMENT_ALPHA_MODE: SentimentAlphaMode;
  TOXICITY_CLASSIFIER_ENABLED: boolean;
  TOXICITY_CLASSIFIER_THRESHOLD: number;
  FUNDING_PRE_SETTLEMENT_WINDOW_MS: number;
  FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER: number;
  QUOTE_HIBERNATE_MS: number;
  AM_VPIN_BUCKET_VOLUME: number;
  AM_VPIN_ROLLING_WINDOW: number;
  AM_VPIN_DIRECTIONAL_DECAY: number;
  AM_VPIN_NORMAL_THRESHOLD: number;
  AM_VPIN_TOXIC_THRESHOLD: number;
  AM_VPIN_CRITICAL_THRESHOLD: number;
  AM_VPIN_OBI_DEPTH: number;
  AM_VPIN_CRITICAL_OBI: number;
  AM_VPIN_CONTESTED_SPREAD_MULTIPLIER: number;
  AM_VPIN_TOXIC_SPREAD_MULTIPLIER: number;
  AM_VPIN_QUOTE_HALT_MS: number;
  CASCADE_WINDOW_MS: number;
  CASCADE_NOTIONAL_THRESHOLD_USD: number;
  CASCADE_ZSCORE_THRESHOLD: number;
  CASCADE_LOOKBACK_HOURS: number;
  CASCADE_DIRECTIONAL_PCT: number;
  CASCADE_MIN_PRICE_MOVE_ATR: number;
  ABSORPTION_WINDOW_MS: number;
  ABSORPTION_PRICE_BAND_BPS: number;
  ABSORPTION_MIN_HOLD_SECONDS: number;
  ENTRY_WINDOW_SECONDS: number;
  IMPULSIVE_BAR_BODY_ATR: number;
  IMPULSIVE_BAR_VOLUME_MULT: number;
  STOP_BUFFER_ATR: number;
  MIN_STOP_DISTANCE_BPS: number;
  MAX_STOP_DISTANCE_BPS: number;
  MIN_TIME_SINCE_LAST_CASCADE_SECONDS: number;
  NEWS_BLACKOUT_MINUTES: number;
  MAX_REALIZED_VOL_PERCENTILE: number;
  CASCADE_TIME_STOP_HOURS: number;
  PARTIAL_1_R: number;
  PARTIAL_1_SIZE_PCT: number;
  PARTIAL_2_R: number;
  PARTIAL_2_SIZE_PCT: number;
  TRAILING_STOP_TYPE: "ATR" | "EMA";
  TRAILING_STOP_PARAM: number;
  RISK_PER_TRADE_PCT: number;
  HEAT_CAP_PCT: number;
  MAX_POSITION_NOTIONAL_PCT: number;
  ASSET_LIQUIDITY_CAP_USD: number;
  DAILY_LOSS_LIMIT_PCT: number;
  WEEKLY_LOSS_LIMIT_PCT: number;
  MAX_CONSECUTIVE_LOSSES: number;
  VAR_CONFIDENCE_Z: number;
  ORACLE_GOVERNANCE_MODE: GovernanceMode;
  ORACLE_MANUAL_SKEPTICISM: number;
  ORACLE_MAX_SKEPTICISM: number;
  updatedAt: string;
  updatedBy: string;
  version: string;
}

export interface MacroBias {
  schemaVersion: "macro-bias.v1";
  direction: MacroBiasDirection;
  intensity: number;
  confidence: number;
  instruments: string[];
  reason: string;
  source: "MOLTWORKER" | "ADMIN" | "SYSTEM";
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface TemporaryGovernanceOverride {
  schemaVersion: "governor.override.v1";
  overrideId: string;
  source: "MOLTWORKER" | "ADMIN" | "SYSTEM";
  createdBy: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  durationMs: number;
  configPatch: Partial<GlobalRiskConfig>;
}

export interface NotificationSettings {
  schemaVersion: "notification-settings.v1";
  enabled: boolean;
  minPriority: AlertPriority;
  debounceMs: number;
  textFrequencyMs: number;
  heartbeatDigestMinutes: number;
  tradeAlertMode: TradeAlertMode;
  telegramEnabled: boolean;
  discordEnabled: boolean;
  genericWebhookEnabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStartUtc: string;
  quietHoursEndUtc: string;
  updatedAt: string;
  updatedBy: string;
  version: string;
}

export type NotificationSettingsUpdate = Partial<
  Pick<
    NotificationSettings,
    | "enabled"
    | "minPriority"
    | "debounceMs"
    | "textFrequencyMs"
    | "heartbeatDigestMinutes"
    | "tradeAlertMode"
    | "telegramEnabled"
    | "discordEnabled"
    | "genericWebhookEnabled"
    | "quietHoursEnabled"
    | "quietHoursStartUtc"
    | "quietHoursEndUtc"
  >
>;

export interface OracleState {
  regime: string;
  volatility: number;
  atr: number;
  adx: number;
  atrToVolumeEfficiency: number;
  skepticismMultiplier: number;
  governanceMode: GovernanceMode;
  manualSkepticism: number;
  maxSkepticism: number;
  profitTargetBps: number;
  posteriorPdf: { points: Array<{ price: number; probability: number }> } | null;
  updatedAt: string | null;
}

export interface ProfilerState {
  bucketSize: number;
  rollingWindow: number;
  alertThreshold: number;
  toxicityScore: number;
  amVpinScore?: number;
  obi?: number | null;
  obiDepth?: number;
  directionalDecay?: number;
  latestSignedImbalance?: number;
  latestDirectionalImbalance?: number;
  toxicityState?: ToxicityState;
  pressureSide?: ToxicityPressureSide;
  spreadMultiplier?: number;
  reservationShiftBps?: number;
  quoteHaltUntil?: string | null;
  amVpinBucketCompletions?: number;
  amVpinMean?: number;
  amVpinVariance?: number;
  distanceToCascadePct: number | null;
  cascadeShieldUntil: string | null;
  cascadeClusterId: string | null;
  cascadeSide: LiquidationSide | null;
  totalBucketsClosed: number;
  activeBucket: JsonRecord | null;
  buckets: JsonRecord[];
  updatedAt: string;
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
  quoteSuspendedUntil: string | null;
  quoteEligible: boolean;
  lastQuoteAt: string | null;
  updatedAt: string | null;
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
  filledAt: string;
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
  decidedAt: string;
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
  updatedAt: string | null;
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
  updatedAt: string;
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
  observedAt: string;
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
  lastSampleAt: string | null;
  updatedAt: string;
}

export interface OrderBookLevel {
  price: number;
  size: number;
  updatedAt?: string;
}

export interface OrderBookSnapshot {
  instrumentCode: string;
  marketKey: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  midPrice: number | null;
}

export interface EngineState {
  engineId: string;
  mode: "PAPER" | "LIVE" | "HALTED";
  bankroll: {
    currency: string;
    cash: number;
    equity: number;
    realizedPnl: number;
    updatedAt: string;
  };
  openPositions: Record<
    string,
    {
      instrumentCode: string;
      quantity: number;
      markPrice: number;
      unrealizedPnl: number;
      realizedPnl: number;
    }
  >;
  riskMetrics: {
    highWaterMark: number;
    rollingDrawdownPct: number;
    var99OneHour: number;
    isTradingEnabled: boolean;
    updatedAt: string | null;
  };
  agentHealth?: Record<
    string,
    {
      status: "GREEN" | "YELLOW" | "RED" | "DISABLED";
      heartbeatAt: string;
      latencyMs: number;
      lastSignalId?: string | null;
      failures24h: number;
    }
  >;
  processedTicks: number;
  acceptedSignals: number;
  averageLatency: number;
  staleTickCount: number;
  toxicityScore: number;
  current_inventory_delta: number;
  liquidationHeatmap: LiquidationHeatmapState;
  cachedConfig: GlobalRiskConfig;
  macroBias: MacroBias;
  temporaryOverride: TemporaryGovernanceOverride | null;
  assetMatrix: Record<string, AssetRuntimeState>;
  profilerStates: Record<string, ProfilerState>;
  microstructure: {
    bestBid: number | null;
    bestAsk: number | null;
    midPrice: number | null;
    spreadBps: number | null;
    weightedImbalance: number | null;
    depthLevels: number;
    timeToBookMs: number | null;
    updatedAt: string | null;
  };
  oracle: OracleState;
  ensemble?: {
    schemaVersion: "ensemble.v1";
    confidence: number;
    kellyMultiplier: number;
    regimeMultiplier: number;
    anomalyCircuitBreaker: boolean;
    votes: JsonRecord[];
    rationale: string;
    updatedAt: string | null;
  };
  inventory: {
    netDelta: number;
    current_inventory_delta: number;
    baseAsset: string;
    normalization: Record<string, number>;
    maxInventoryUnits: number;
    maxInventoryDelta: number;
    inventoryPenalty: number;
    stopBid: boolean;
    stopAsk: boolean;
  };
  quoteState: {
    status: "ACTIVE" | "SUSPENDED";
    reason: string | null;
    suspendedUntil: string | null;
  };
  assetQuoteStates?: Record<
    string,
    {
      status: "ACTIVE" | "SUSPENDED";
      reason: string | null;
      suspendedUntil: string | null;
      updatedAt: string | null;
    }
  >;
  shadowQueue?: ShadowQueueState;
  executionProfile: {
    status: "STABLE" | "UNSTABLE";
    jitterMs: number;
    jitterThresholdMs: number;
    averageProcessingLatencyMs: number | null;
    orderBookUpdateMs: number | null;
    agentLogicMs: number | null;
    wakeUpTimeMs: number | null;
  };
  citadel?: {
    status: CitadelOperationalStatus;
    reason: string | null;
    shadowMode: boolean;
    lastEvacuationAt: string | null;
    updatedAt: string | null;
  };
  location: {
    colo: string | null;
    isGoldenRegion: boolean;
    latencyRiskMultiplier: number;
    positionSizeMultiplier: number;
  };
  profiler?: ProfilerState;
  lastTradeIntent: JsonRecord | null;
  orderMap: Record<string, JsonRecord>;
  [key: string]: unknown;
}

export interface AdminStateResponse {
  state: EngineState;
  orderBook?: JsonRecord;
}

export interface LoginResponse {
  ok: boolean;
  token: string;
  tokenType: "Bearer";
  expiresIn: number;
  scopes: string[];
}

export interface TraceResponse {
  ok: boolean;
  terminalFeed: string[];
  data: JsonRecord[];
  liveTelemetry: JsonRecord[];
}

export interface AttributionResponse {
  ok: boolean;
  byDriver: Array<{
    driver: string;
    tradeCount: number;
    cumulativePnl: number;
    averagePnl: number;
    sharpe: number | null;
    profitFactor: number | null;
    winRate?: number | null;
    averageConfidence: number;
  }>;
  byAsset?: JsonRecord[];
  byRegime?: JsonRecord[];
  byAgentAsset?: JsonRecord[];
  timeline: JsonRecord[];
}

export interface ExecutionQualityResponse {
  ok: boolean;
  summary: JsonRecord;
  byAsset: JsonRecord[];
  fillRate: JsonRecord;
  window: JsonRecord;
}

export interface CostBudgetSettings {
  schemaVersion: "cost-budgets.v1";
  dailyBudgetUsd: number;
  workersAiDailyBudgetUsd: number;
  durableObjectDailyBudgetUsd: number;
  d1DailyBudgetUsd: number;
  workersAiCostPerCallUsd: number;
  durableObjectCostPerMsUsd: number;
  d1ReadCostPerQueryUsd: number;
  d1WriteCostPerRowUsd: number;
  enforcement: "WARN" | "BLOCK_LIVE" | "BLOCK_ALL";
  updatedAt: string;
  updatedBy: string;
}

export interface CostDashboardResponse {
  ok: boolean;
  cost: {
    ok: boolean;
    generatedAt: string;
    topology: JsonRecord;
    budgets: CostBudgetSettings;
    totals: JsonRecord;
    components: JsonRecord[];
    violations: JsonRecord[];
  };
}

export interface CascadeActiveResponse {
  ok: boolean;
  cascades: CascadeActiveItem[];
}

export interface CascadeActiveItem {
  cascadeId: string;
  instrumentCode: string;
  direction: string;
  phase: "DETECTED" | "ABSORPTION_CONFIRMED" | "POSITION_OPEN" | "POSITION_CLOSED";
  liquidationNotional: number;
  liquidationCount: number;
  zScore: number;
  directionalPct: number;
  priceMoveAtr: number;
  detectedAt: string;
  absorption?: JsonRecord | null;
  position?: JsonRecord | null;
}

export interface CascadeSignalsResponse {
  ok: boolean;
  signals: JsonRecord[];
}

export interface CascadePositionsResponse {
  ok: boolean;
  positions: CascadePositionItem[];
}

export interface CascadePositionItem {
  positionId: string;
  signalId: string;
  cascadeId: string;
  instrumentCode: string;
  direction: "LONG" | "SHORT";
  status: string;
  entryPrice: number;
  currentStopPrice: number;
  initialStopPrice: number;
  totalSize: number;
  remainingSize: number;
  initialRiskPct: number;
  rDistance: number;
  targets: JsonRecord;
  timeStopAt: string;
  firstTargetTaken: boolean;
  secondTargetTaken: boolean;
  enteredAt: string | null;
  updatedAt: string;
  markPrice: number | null;
  unrealizedPnl: number | null;
  unrealizedR: number | null;
  timeToTimeStopMs: number | null;
}

export interface CascadeHeatResponse {
  ok: boolean;
  heat: {
    currentHeatPct: number;
    heatCapPct: number;
    percentOfCap: number;
    openPositionCount: number;
    remainingRiskUsd: number;
    updatedAt: string;
  };
}

export interface CascadeBacktestResponse {
  ok: boolean;
  report: JsonRecord;
}

export interface ReplayStatus {
  replayId: string | null;
  status: "IDLE" | "RUNNING" | "COMPLETED" | "FAILED";
  ticksTotal: number;
  ticksProcessed: number;
  progressPct: number;
  speedMultiplier: number;
  shadowBankroll: number;
  dateFrom: string | null;
  dateTo: string | null;
  scenario?: string;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
}

export interface ReplayResponse {
  ok: boolean;
  replay: JsonRecord;
  state?: EngineState;
}

export interface ReplayStatusResponse {
  ok: boolean;
  replay: ReplayStatus;
}

export interface TradeHistoryEntry {
  tradeId: string;
  orderId: string;
  signalId: string | null;
  venue: string;
  asset: string;
  side: "BUY" | "SELL";
  orderType: string;
  price: number;
  size: number;
  notional: number;
  evAtExecution: number;
  slippageBps: number;
  resultingPnl: number;
  primaryDriver: string | null;
  fees: number;
  status: "ACCEPTED" | "FILLED" | "PARTIAL" | "REJECTED" | "CANCELLED" | "GHOST_FILL";
  exchangeTradeId: string | null;
  rawExecution: JsonRecord;
  agentName: string | null;
  traceId: string | null;
  executedAt: string;
  createdAt: string;
}

export interface PaperPnlAsset {
  asset: string;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  buySize: number;
  sellSize: number;
  buyNotional: number;
  sellNotional: number;
  netQuantity: number;
  cashPnl: number;
  grossNotional: number;
  realizedPnl: number;
  totalEv: number;
  totalFees: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface PaperPnlSummary {
  windowHours: number;
  mode: "SHADOW_MARK_TO_MARKET" | "SHADOW_RISK_CAPPED_MARK_TO_MARKET" | "SHADOW_CURRENT_SESSION";
  sessionStartedAt?: string | null;
  assets: PaperPnlAsset[];
  totals: {
    tradeCount: number;
    buyCount: number;
    sellCount: number;
    grossNotional: number;
    cashPnl: number;
    realizedPnl: number;
    totalEv: number;
    totalFees: number;
  };
  generatedAt: string;
}

export type PaperLedgerSide = "LONG" | "SHORT";
export type PaperLedgerEventType = "ENTRY" | "INCREASE" | "REDUCE" | "EXIT" | "FLIP";

export interface PaperLedgerEvent {
  eventId: string;
  type: PaperLedgerEventType;
  asset: string;
  side: PaperLedgerSide;
  fillTradeId: string;
  entryTradeId: string | null;
  quantity: number;
  entryPrice: number | null;
  exitPrice: number | null;
  grossPnl: number;
  fees: number;
  realizedPnl: number;
  positionQuantityAfter: number;
  averageEntryPriceAfter: number | null;
  openedAt: string | null;
  executedAt: string;
}

export interface PaperLedgerPosition {
  asset: string;
  side: PaperLedgerSide;
  quantity: number;
  averageEntryPrice: number;
  openNotional: number;
  entryFeesRemaining: number;
  lotCount: number;
  openedAt: string;
  updatedAt: string;
}

export interface PaperLedgerAssetSummary {
  asset: string;
  fillCount: number;
  buyCount: number;
  sellCount: number;
  entryCount: number;
  exitCount: number;
  buySize: number;
  sellSize: number;
  realizedGrossPnl: number;
  realizedNetPnl: number;
  totalFees: number;
  openQuantity: number;
  openSide: PaperLedgerSide | null;
  averageEntryPrice: number | null;
  openedAt: string | null;
  updatedAt: string | null;
}

export interface PaperLedger {
  schemaVersion: "paper-ledger.v1";
  mode: "FIFO_AVERAGE_COST";
  generatedAt: string;
  events: PaperLedgerEvent[];
  positions: PaperLedgerPosition[];
  assets: PaperLedgerAssetSummary[];
  summary: {
    fillCount: number;
    entryCount: number;
    exitCount: number;
    openPositionCount: number;
    realizedGrossPnl: number;
    realizedNetPnl: number;
    totalFees: number;
    openFees: number;
    grossNotional: number;
  };
}

export interface TradeHistoryResponse {
  ok: boolean;
  data: TradeHistoryEntry[];
  paperTrades?: TradeHistoryEntry[];
  paperPnl?: PaperPnlSummary;
  paperLedger?: PaperLedger;
  statusBreakdown?: Array<{
    status: TradeHistoryEntry["status"];
    count: number;
    latestExecutedAt: string | null;
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    pageCount: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  filters: JsonRecord;
}

export interface AlertChannelStatus {
  channel: AlertChannel;
  configured: boolean;
  enabled?: boolean;
  envConfigured?: boolean;
  vaultConfigured?: boolean;
  source?: "ENV" | "VAULT" | "MISSING";
}

export interface AlertDeliveryAttempt {
  channel: AlertChannel;
  ok: boolean;
  status: number | null;
  error?: string;
}

export interface AlertingResponse {
  ok: boolean;
  alerting: {
    configured: boolean;
    debounceMs: number;
    channels: AlertChannelStatus[];
    settings?: NotificationSettings;
  };
}

export interface AlertTestResponse extends AlertingResponse {
  delivery: {
    ok: boolean;
    debounced: boolean;
    configuredChannels: AlertChannelStatus[];
    attempted: number;
    delivered: number;
    attempts: AlertDeliveryAttempt[];
    observedAt: string;
  };
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: "OPTIMAL" | "WARN" | "ANOMALY";
  detail: string;
  metadata: JsonRecord;
}

export interface DiagnosticsResponse {
  ok: boolean;
  observedAt: string;
  topology: JsonRecord;
  checks: DiagnosticCheck[];
  engine: JsonRecord;
}

export interface DashboardPulse {
  total_equity: number;
  unrealized_pnl: number;
  active_drawdown: number;
  current_imbalance: number | null;
  latency_ms: number;
  exchange_to_receipt_ms?: number;
  jitter_ms: number;
  shadow_queue?: ShadowQueueState;
  toxicity_score: number;
  regime: string;
  regimeCoefficient: number;
  macroBias: MacroBias;
  temporaryOverride: TemporaryGovernanceOverride | null;
  liquidationHeatmap?: {
    totalEstimatedNotionalUsd: number;
    clusterCount: number;
    nearestCascade: LiquidationCascadeCluster | null;
    providerEventCount: number;
    updatedAt: string;
  };
  AgentLogicTrace: JsonRecord[];
  heartbeatAt: string;
}

export interface DraftTransportSettings {
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  watchdogMs: number;
  rateLimitCapacity: number;
  rateLimitRefillPerSecond: number;
}

export type VaultKeyName =
  | "EXCHANGE_API_KEY"
  | "EXCHANGE_API_SECRET"
  | "HL_AGENT_ADDRESS"
  | "HL_AGENT_SECRET"
  | "EXCHANGE_HMAC_SECRET"
  | "EXCHANGE_ED25519_PRIVATE_KEY"
  | "DISCORD_WEBHOOK_URL"
  | "TELEGRAM_BOT_TOKEN"
  | "TELEGRAM_CHAT_ID"
  | "ALERT_WEBHOOK_URL"
  | "CONGRESS_RUNNER_URL"
  | "CONGRESS_RUNNER_TOKEN";

export interface VaultEntry {
  envConfigured: boolean;
  vaultConfigured: boolean;
  masked: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface VaultStatus {
  entries: Record<string, VaultEntry>;
  rotationPolicy: string;
}

export interface AdminSettingsResponse {
  ok: boolean;
  config: GlobalRiskConfig;
  notifications: NotificationSettings;
  alerting: AlertingResponse["alerting"];
  vault: VaultStatus;
  backend: JsonRecord;
  strategyVault?: StrategyVaultResponse["strategyVault"];
  costBudgets?: CostBudgetSettings;
}

export interface StrategyVersion {
  versionId: string;
  name: string;
  description: string | null;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  config: GlobalRiskConfig;
  parameters: JsonRecord;
  performance: JsonRecord | null;
  createdBy: string;
  activatedBy: string | null;
  createdAt: string;
  activatedAt: string | null;
}

export interface StrategyVaultResponse {
  ok: boolean;
  strategyVault: {
    active: StrategyVersion | null;
    versions: StrategyVersion[];
  };
}

export interface LiveReadinessCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  metadata?: JsonRecord;
}

export interface LiveReadinessResponse {
  ok: boolean;
  readiness: {
    ok: boolean;
    generatedAt: string;
    checks: LiveReadinessCheck[];
  };
}

export interface CascadeLiveApprovalResponse {
  ok: boolean;
  approval: {
    subject: string;
    scopes: string[];
    observedAt: string;
    expiresInMs: number;
  };
}

export interface VaultStatusResponse {
  ok: boolean;
  vault: VaultStatus;
}

export interface CongressRun {
  run_id: string;
  status: string;
  trigger_source: string;
  source: string;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  stats_json: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CongressTransaction {
  transaction_id: string;
  filing_id: string | null;
  chamber: string;
  member_name: string | null;
  owner: string | null;
  symbol: string | null;
  asset_name: string | null;
  transaction_type: string;
  transaction_date: string | null;
  notification_date: string | null;
  amount_min: number | null;
  amount_max: number | null;
  amount_mid: number | null;
  transaction_price: number | null;
  transaction_price_as_of: string | null;
  current_price: number | null;
  current_price_as_of: string | null;
  pnl_estimate: number | null;
  return_pct: number | null;
  price_provider: string | null;
  confidence: number | null;
  raw_text: string | null;
  source_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface CongressStatusResponse {
  ok: boolean;
  tracker: {
    enabled: boolean;
    schedulerTimezone: string;
    runnerConfigured: boolean;
    runnerKind?: string;
    priceProvider: string;
    rawArchiveConfigured: boolean;
  };
  latestRun: CongressRun | null;
  counts: {
    runs: number;
    filings: number;
    transactions: number;
    openIssues: number;
    markedTransactions: number;
  };
  pnl: {
    totalEstimate: number;
    averageReturnPct: number | null;
  };
}

export interface CongressRunsResponse {
  ok: boolean;
  runs: CongressRun[];
  limit: number;
  offset: number;
}

export interface CongressRunTriggerResponse {
  ok: boolean;
  runId: string;
  status: string;
  runnerConfigured: boolean;
  message: string;
  error?: string;
}

export interface CongressTransactionsResponse {
  ok: boolean;
  transactions: CongressTransaction[];
  limit: number;
  offset: number;
  pnlMethod: string;
}

export type CongressPeriod = "24h" | "7d" | "30d" | "90d" | "ytd" | "all";

export interface CongressTickerAssetBreakdown {
  assetName: string;
  transactionCount: number;
  totalAmountMid: number;
  memberCount: number;
}

export interface CongressTickerHierarchyItem {
  rank: number;
  ticker: string;
  displayName: string;
  weightPct: number;
  transactionCount: number;
  purchaseCount: number;
  saleCount: number;
  exchangeCount: number;
  totalAmountMid: number;
  purchaseAmountMid: number;
  saleAmountMid: number;
  netDirectionalAmountMid: number;
  markedCount: number;
  pnlEstimate: number;
  lastSeenAt: string | null;
  topAssets: CongressTickerAssetBreakdown[];
  transactions: CongressTransaction[];
}

export interface CongressTickerHierarchyResponse {
  ok: boolean;
  period: CongressPeriod;
  basis: "created_at" | "transaction_date";
  windowStart: string | null;
  windowEnd: string;
  totalAmountMid: number;
  totalTransactions: number;
  tickers: CongressTickerHierarchyItem[];
  note: string;
}

export interface CongressPnlRefreshResponse {
  ok: boolean;
  refreshed: number;
  failed: number;
  marks: JsonRecord[];
  failures: JsonRecord[];
}
