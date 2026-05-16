export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;

export type GovernanceMode = "MANUAL" | "AUTONOMOUS" | "HYBRID";
export type MacroBiasDirection = "BULLISH" | "BEARISH" | "RISK_ON" | "RISK_OFF" | "NEUTRAL";
export type AlertPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AlertChannel = "DISCORD" | "TELEGRAM" | "GENERIC_WEBHOOK";
export type TradeAlertMode = "ALL" | "FILLED_ONLY" | "NONE";

export interface GlobalRiskConfig {
  TRADING_ENABLED: boolean;
  MAX_POSITION_SIZE: number;
  MAX_POSITION_PCT: number;
  MAX_INVENTORY_UNITS: number;
  MAX_DRAWDOWN_PCT: number;
  LATENCY_THRESHOLD_MS: number;
  GOLDEN_COLOS: string;
  MIN_EV_THRESHOLD: number;
  EXCHANGE_FEE_BPS: number;
  KELLY_FRACTION: number;
  RISK_AVERSION_FACTOR: number;
  QUOTE_HIBERNATE_MS: number;
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
  totalBucketsClosed: number;
  activeBucket: JsonRecord | null;
  buckets: JsonRecord[];
  updatedAt: string;
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
  cachedConfig: GlobalRiskConfig;
  macroBias: MacroBias;
  temporaryOverride: TemporaryGovernanceOverride | null;
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
    maxInventoryUnits: number;
    inventoryPenalty: number;
    stopBid: boolean;
    stopAsk: boolean;
  };
  quoteState: {
    status: "ACTIVE" | "SUSPENDED";
    reason: string | null;
    suspendedUntil: string | null;
  };
  executionProfile: {
    status: "STABLE" | "UNSTABLE";
    jitterMs: number;
    jitterThresholdMs: number;
    averageProcessingLatencyMs: number | null;
    orderBookUpdateMs: number | null;
    agentLogicMs: number | null;
    wakeUpTimeMs: number | null;
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
  status: "ACCEPTED" | "FILLED" | "PARTIAL" | "REJECTED" | "CANCELLED";
  exchangeTradeId: string | null;
  rawExecution: JsonRecord;
  agentName: string | null;
  traceId: string | null;
  executedAt: string;
  createdAt: string;
}

export interface TradeHistoryResponse {
  ok: boolean;
  data: TradeHistoryEntry[];
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

export interface DashboardPulse {
  total_equity: number;
  unrealized_pnl: number;
  active_drawdown: number;
  current_imbalance: number | null;
  latency_ms: number;
  jitter_ms: number;
  toxicity_score: number;
  regime: string;
  regimeCoefficient: number;
  macroBias: MacroBias;
  temporaryOverride: TemporaryGovernanceOverride | null;
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
