export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;

export type GovernanceMode = "MANUAL" | "AUTONOMOUS" | "HYBRID";
export type MacroBiasDirection = "BULLISH" | "BEARISH" | "RISK_ON" | "RISK_OFF" | "NEUTRAL";
export type AlertPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AlertChannel = "DISCORD" | "TELEGRAM" | "GENERIC_WEBHOOK";
export type TradeAlertMode = "ALL" | "FILLED_ONLY" | "NONE";
export type ToxicityState = "NORMAL" | "CONTESTED" | "TOXIC" | "CRITICAL";
export type ToxicityPressureSide = "BUY" | "SELL" | "NEUTRAL";
export type CitadelOperationalStatus = "NOMINAL" | "WATCH" | "CRITICAL";

export interface GlobalRiskConfig {
  TRADING_ENABLED: boolean;
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
  QUOTE_HIBERNATE_MS: number;
  AM_VPIN_BUCKET_VOLUME: number;
  AM_VPIN_ROLLING_WINDOW: number;
  AM_VPIN_DIRECTIONAL_DECAY: number;
  AM_VPIN_NORMAL_THRESHOLD: number;
  AM_VPIN_TOXIC_THRESHOLD: number;
  AM_VPIN_CRITICAL_THRESHOLD: number;
  AM_VPIN_OBI_DEPTH: number;
  AM_VPIN_CRITICAL_OBI: number;
  AM_VPIN_QUOTE_HALT_MS: number;
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
  openPositions: Record<string, {
    instrumentCode: string;
    quantity: number;
    markPrice: number;
    unrealizedPnl: number;
    realizedPnl: number;
  }>;
  riskMetrics: {
    highWaterMark: number;
    rollingDrawdownPct: number;
    var99OneHour: number;
    isTradingEnabled: boolean;
    updatedAt: string | null;
  };
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
    averageConfidence: number;
  }>;
  timeline: JsonRecord[];
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

export interface TradeHistoryResponse {
  ok: boolean;
  data: TradeHistoryEntry[];
  paperTrades?: TradeHistoryEntry[];
  paperPnl?: PaperPnlSummary;
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
  | "ALERT_WEBHOOK_URL";

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
}

export interface VaultStatusResponse {
  ok: boolean;
  vault: VaultStatus;
}
