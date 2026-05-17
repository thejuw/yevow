export interface Env {
  TRADING_ENGINE: DurableObjectNamespace;
  INGEST_COORDINATOR?: DurableObjectNamespace;
  TRADING_DB: D1Database;
  CONFIG_STORE: KVNamespace;
  RISK_VAULT: KVNamespace;
  SECRET_VAULT?: KVNamespace;
  AI?: Ai;
  WORKERS_AI_SENTIMENT_COST_USD?: string;
  STRUCTURED_CONSOLE_LOGS?: string;
  LOG_SINK_PROVIDER?: string;
  LOG_SINK_URL?: string;
  LOG_SINK_TOKEN?: string;
  LOG_SINK_DATASET?: string;
  AXIOM_DATASET?: string;
  HONEYCOMB_DATASET?: string;
  COST_DAILY_BUDGET_USD?: string;
  WORKERS_AI_DAILY_BUDGET_USD?: string;
  DO_COMPUTE_DAILY_BUDGET_USD?: string;
  D1_DAILY_BUDGET_USD?: string;
  WORKERS_AI_COST_PER_CALL_USD?: string;
  DO_COMPUTE_COST_PER_MS_USD?: string;
  D1_READ_COST_PER_QUERY_USD?: string;
  D1_WRITE_COST_PER_ROW_USD?: string;
  COST_BUDGET_ENFORCEMENT?: string;
  EXECUTIONER?: Fetcher;
  ENGINE_OBJECT_NAME?: string;
  ENGINE_LOCATION_HINT?: string;
  PLACEMENT_TARGET_COLO?: string;
  INGEST_COORDINATOR_OBJECT_NAME?: string;
  INGEST_COORDINATOR_LOCATION_HINT?: string;
  MARKET_STREAMS?: string;
  INGEST_TRANSPORT?: string;
  EXCHANGE_WEIGHTS?: string;
  CLOCK_SYNC_ALPHA?: string;
  CLOCK_SYNC_MAX_OFFSET_MS?: string;
  HL_WS_URL?: string;
  DWELLIR_API_KEY?: string;
  DWELLIR_GRPC_URL?: string;
  DWELLIR_GRPC_ENDPOINT?: string;
  DWELLIR_ORDERBOOK_WS_URL?: string;
  DWELLIR_ORDERBOOK_WS_ENDPOINT?: string;
  DWELLIR_ORDERBOOK_TRANSPORT?: string;
  DWELLIR_SUBSCRIPTION_TIER?: string;
  DWELLIR_ORDERBOOK_DEPTH?: string;
  DWELLIR_ENABLE_L4_BOOK?: string;
  DWELLIR_GRPC_STREAMS?: string;
  DWELLIR_GRPC_START_TIMESTAMP_MS?: string;
  DWELLIR_GRPC_START_BLOCK_HEIGHT?: string;
  DWELLIR_GRPC_START_LOOKBACK_MS?: string;
  DWELLIR_GRPC_SNAPSHOT_POLL_MS?: string;
  DWELLIR_GRPC_FORWARD_MAX_AGE_MS?: string;
  DWELLIR_GRPC_FATAL_DROP_MS?: string;
  DWELLIR_GRPC_FILLS_WATCHDOG_TIMEOUT_MS?: string;
  DWELLIR_GRPC_FATAL_ON_FILLS_ONLY?: string;
  DWELLIR_MAX_PAYLOAD_BYTES?: string;
  DWELLIR_MAX_LATENCY_MS?: string;
  DWELLIR_L4_ORDER_CACHE_LIMIT?: string;
  INGEST_FORWARD_ENCODING?: string;
  HL_GRPC_BACKOFF_BASE_MS?: string;
  RPC_GRPC_ENDPOINT?: string;
  RPC_GRPC_SERVICE?: string;
  RPC_GRPC_STREAM_METHOD?: string;
  RPC_GRPC_PING_METHOD?: string;
  RPC_GRPC_SUBSCRIBE_TYPE?: string;
  RPC_GRPC_UPDATE_TYPE?: string;
  RPC_GRPC_PING_REQUEST_TYPE?: string;
  RPC_GRPC_PING_RESPONSE_TYPE?: string;
  RPC_GRPC_STREAM_TYPES?: string;
  RPC_AUTH_HEADER?: string;
  RPC_AUTH_TOKEN?: string;
  RPC_AUTH_TOKEN_KV_KEY?: string;
  HL_ASSETS?: string;
  HL_HEARTBEAT_INTERVAL_MS?: string;
  HL_WATCHDOG_TIMEOUT_MS?: string;
  HL_MAX_BACKOFF_MS?: string;
  HL_STALE_AFTER_MS?: string;
  HL_BOOK_TIMESTAMP_MAX_DRIFT_MS?: string;
  HL_SEQUENCE_GAP_MS?: string;
  HAWKES_BASELINE_MU?: string;
  HAWKES_JUMP_BETA?: string;
  HAWKES_DECAY_ALPHA?: string;
  HAWKES_THRESHOLD_QUANTILE?: string;
  HAWKES_SIGNAL_COOLDOWN_MS?: string;
  HL_INFO_URL?: string;
  HL_EXCHANGE_URL?: string;
  HL_ASSET?: string;
  HL_ASSET_INDEX?: string;
  HL_ACCOUNT_ADDRESS?: string;
  HL_AGENT_ADDRESS?: string;
  HL_AGENT_SECRET?: string;
  HL_VAULT_ADDRESS?: string;
  HL_IS_MAINNET?: string;
  HL_DEFAULT_TIF?: string;
  HL_ORDER_EXPIRES_MS?: string;
  HL_REST_RATE_LIMIT_PER_MINUTE?: string;
  HL_REST_REFILL_PER_SECOND?: string;
  HL_HEATMAP_PRICE_BIN_SIZE?: string;
  HL_HEATMAP_CLUSTER_NOTIONAL_USD?: string;
  HL_CASCADE_DISTANCE_PCT?: string;
  HL_PREDATORY_ORDER_OFFSET_BPS?: string;
  FUNDING_HORIZON_HOURS?: string;
  EXCHANGE_API_HOSTNAME?: string;
  GOLDEN_COLOS?: string;
  HIGH_LATENCY_COLO_RISK_MULTIPLIER?: string;
  ORDER_BOOK_TICK_SIZE_DEFAULT?: string;
  ORDER_BOOK_TICK_SIZES?: string;
  PROFILER_BUCKET_VOLUME?: string;
  PROFILER_ROLLING_WINDOW?: string;
  PROFILER_ALERT_THRESHOLD?: string;
  JITTER_THRESHOLD_MS?: string;
  JITTER_SAMPLE_WINDOW?: string;
  JITTER_COMPUTE_INTERVAL_TICKS?: string;
  DOM_PRICE_BIN_SIZE_DEFAULT?: string;
  DOM_PRICE_BIN_SIZES?: string;
  DOM_SCAN_RANGE_PCT?: string;
  DOM_WALL_HISTORY_LIMIT?: string;
  DOM_SPOOF_PROXIMITY_BPS?: string;
  ANOMALY_PRICE_Z_THRESHOLD?: string;
  ANOMALY_VOLUME_Z_THRESHOLD?: string;
  ANOMALY_CANCEL_EXEC_RATIO_THRESHOLD?: string;
  ANOMALY_PRICE_WINDOW_MS?: string;
  ANOMALY_VOLUME_WINDOW_MS?: string;
  ANOMALY_TOP_OF_BOOK_WINDOW_MS?: string;
  INGESTOR_CONTROL_TOKEN?: string;
  JWT_SECRET?: string;
  ADMIN_JWT_SECRET?: string;
  ADMIN_PASSWORD?: string;
  EXCHANGE_API_KEY?: string;
  EXCHANGE_API_SECRET?: string;
  EXECUTIONER_CONTROL_TOKEN?: string;
  EXCHANGE_BASE_URL?: string;
  EXCHANGE_ORDER_ENDPOINT?: string;
  EXCHANGE_CANCEL_ENDPOINT?: string;
  EXCHANGE_OPEN_ORDERS_ENDPOINT?: string;
  EXCHANGE_ACCOUNT_BALANCE_ENDPOINT?: string;
  EXCHANGE_REPORTS_WS_URL?: string;
  EXCHANGE_ADAPTER?: string;
  EXCHANGE_RECV_WINDOW_MS?: string;
  EXCHANGE_ORDER_TEST_MODE?: string;
  EXCHANGE_FEE_BPS?: string;
  MIN_EV_THRESHOLD?: string;
  KELLY_FRACTION?: string;
  MAX_POSITION_PCT?: string;
  MAX_INVENTORY_UNITS?: string;
  MAX_INVENTORY_DELTA?: string;
  DELTA_NORMALIZATION_WEIGHTS?: string;
  FUNDING_BIAS_THRESHOLD?: string;
  FUNDING_INVENTORY_BIAS?: string;
  RISK_AVERSION_FACTOR?: string;
  ORACLE_GOVERNANCE_MODE?: string;
  ORACLE_MANUAL_SKEPTICISM?: string;
  ORACLE_MAX_SKEPTICISM?: string;
  AMM_MIN_TICK_CHANGE?: string;
  WHALE_PRINT_Z_THRESHOLD?: string;
  QUOTE_HIBERNATE_MS?: string;
  VAR_CONFIDENCE_Z?: string;
  JANITOR_INTERVAL_MS?: string;
  ORDER_ACK_TIMEOUT_MS?: string;
  SIGNATURE_ALGORITHM?: string;
  EXCHANGE_HMAC_SECRET?: string;
  EXCHANGE_ED25519_PRIVATE_KEY?: string;
  SLIPPAGE_GUARD_TICKS?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  DISCORD_WEBHOOK_URL?: string;
  ALERT_WEBHOOK_URL?: string;
  NOTIFIER_DEBOUNCE_MS?: string;
  VAULT_ENCRYPTION_SECRET?: string;
  NEWS_FEEDS?: string;
  JANITOR_LOG_RETENTION_DAYS?: string;
  JANITOR_TELEMETRY_MAX_ROWS?: string;
  MARKET_TICK_JOURNAL_INTERVAL?: string;
  MARKET_TICK_MAX_ROWS?: string;
  MOLTWORKER_HEALTH_URL?: string;
  MOLTWORKER_HEARTBEAT_MAX_AGE_MS?: string;
  D1_DIAGNOSTIC_MAX_LATENCY_MS?: string;
  SHADOW_MODE?: string;
  PAPER_BANKROLL_USD?: string;
  PAPER_MAX_GHOST_FILLS_PER_MINUTE?: string;
  PAPER_FILL_PARTICIPATION_RATE?: string;
  PAPER_FILL_ADVERSE_BPS?: string;
  PAPER_MAKER_FEE_BPS?: string;
  QUOTE_REFRESH_MIN_INTERVAL_MS?: string;
  QUOTE_REFRESH_MIN_PRICE_TICKS?: string;
  LIVE_READINESS_MIN_PAPER_TRADES?: string;
  LIVE_READINESS_MIN_PAPER_PNL_USD?: string;
  LIVE_READINESS_REQUIRE_SINGLE_ASSET?: string;
  LIVE_READINESS_ALLOW_HYPE?: string;
  SHADOW_VLO_CAPACITY?: string;
  SHADOW_VLO_DRIFT_TRADES?: string;
  SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER?: string;
  SHADOW_VLO_BASE_SPREAD_BPS?: string;
  SHADOW_VLO_LATENCY_BUDGET_MS?: string;
  SHADOW_VLO_MIN_SIZE?: string;
}

export type ISO8601 = string;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;

export type AgentName =
  | "ORACLE"
  | "SENTIMENT"
  | "PROFILER"
  | "CROUPIER"
  | "PIT_BOSS"
  | "JANITOR"
  | "EXECUTIONER"
  | "MOLTWORKER"
  | "RISK"
  | "SYSTEM";
export type AgentAction =
  | "BUY"
  | "SELL"
  | "HOLD"
  | "CANCEL"
  | "REDUCE"
  | "QUOTE"
  | "EXECUTE"
  | "PAUSE"
  | "RESUME"
  | "SUPERVISOR_ACTION";
export type EngineMode = "PAPER" | "LIVE" | "HALTED";
export type EngineStabilityStatus = "STABLE" | "UNSTABLE";
export type CitadelOperationalStatus = "NOMINAL" | "WATCH" | "CRITICAL";
export type HealthStatus = "GREEN" | "YELLOW" | "RED";
export type GovernanceMode = "MANUAL" | "AUTONOMOUS" | "HYBRID";
export type NotificationPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type TradeAlertMode = "ALL" | "FILLED_ONLY" | "NONE";
export type MarketTransport = "grpc" | "websocket";
export type MarketDataSource =
  | "BINANCE"
  | "HYPERLIQUID"
  | "COINBASE"
  | "KRAKEN"
  | "OKX"
  | "BYBIT"
  | "SYSTEM";

export interface UniversalTick {
  schemaVersion: "universal-tick.v1";
  source: MarketDataSource;
  source_exchange: string;
  transport: MarketTransport;
  streamId?: string | null;
  connectionId?: string | null;
  sourceChannel?: string | null;
  exchangeCode: string;
  instrumentCode: string;
  baseAsset: string;
  quoteAsset: string;
  price: number;
  size: number;
  side: "buy" | "sell" | "unknown";
  sequence: number;
  providerTimestamp?: ISO8601;
  exchangeTimestamp: ISO8601;
  synchronizedExchangeTimestamp: ISO8601;
  clockOffsetMs: number;
  receivedAt: ISO8601;
  sourceWeight: number;
  bestBid?: number;
  bestAsk?: number;
  fundingRateHourly?: number;
  markPrice?: number;
  oraclePrice?: number;
  openInterest?: number;
  tickSize?: number;
  raw?: JsonRecord;
}

export type MarketTick = UniversalTick;

export type MarketDataSubscriptionTier =
  | "PUBLIC"
  | "STANDARD"
  | "ENTERPRISE"
  | "DEDICATED"
  | "UNKNOWN";

export interface MarketDataSubscriptionProfile {
  provider: "DWELLIR" | "HYPERLIQUID_PUBLIC" | "CUSTOM";
  tier: MarketDataSubscriptionTier;
  readMode:
    | "DWELLIR_GRPC_FILLS_L2_BOOK_WS"
    | "DWELLIR_GRPC_FILLS_L2_BOOK_GRPC"
    | "DWELLIR_GRPC_FILLS_L4_BOOK_WS"
    | "DWELLIR_GRPC_FILLS_L4_BOOK_GRPC"
    | "DWELLIR_ORDERBOOK_WS"
    | "PUBLIC_WS"
    | "CUSTOM";
  bookDepth: number;
  maxBookDepth: number;
  l4BookEnabled: boolean;
  assetCount: number;
  optimization: "MAXIMIZED" | "CUSTOM" | "CONSERVATIVE";
  normalMode: boolean;
  reason: string;
}

export interface IngestHealth {
  ok: boolean;
  status: "IDLE" | "CONNECTING" | "CONNECTED" | "BACKING_OFF" | "STOPPED" | "ERROR";
  connectionId: string | null;
  attempts: number;
  backoffCounter: number;
  messagesReceived: number;
  ticksForwarded: number;
  ticksDropped: number;
  lastMessageAt: ISO8601 | null;
  lastForwardAt: ISO8601 | null;
  lastDisconnectAt: ISO8601 | null;
  blackoutStartedAt: ISO8601 | null;
  lastRecoveredAt: ISO8601 | null;
  lastRecoveryDurationMs: number | null;
  lastError: string | null;
  subscriptionProfile?: MarketDataSubscriptionProfile;
  streams?: ExchangeStreamHealth[];
}

export interface ExchangeStreamHealth extends Omit<IngestHealth, "streams"> {
  streamId: string;
  source: MarketDataSource;
  source_exchange: string;
  transport?: "websocket" | "grpc";
  streamHost: string;
  activeClusterUrl?: string;
  heartbeatLatencyMs?: number | null;
  packetLossPct?: number;
  sourceWeight: number;
  clockOffsetMs: number | null;
  lastFatalDropAt?: ISO8601 | null;
}

export interface ExchangeStreamConfig {
  id: string;
  source: MarketDataSource;
  source_exchange: string;
  transport?: "websocket" | "grpc";
  streamUrl: string;
  grpcEndpoint?: string;
  grpcService?: string;
  grpcStreamMethod?: string;
  grpcPingMethod?: string;
  grpcSubscribeType?: string;
  grpcUpdateType?: string;
  grpcPingRequestType?: string;
  grpcPingResponseType?: string;
  grpcStreamTypes?: string[];
  clusterUrls?: string[];
  snapshotUrl?: string;
  subscription?: string | JsonRecord;
  subscriptions?: Array<string | JsonRecord>;
  authHeader?: string;
  apiKeyEnv?: string;
  weight?: number;
  instrumentCode?: string;
  exchangeCode?: string;
  subscriptionProfile?: MarketDataSubscriptionProfile;
  enabled?: boolean;
}

export interface OrderBookResetRequest {
  source: "INGEST_WORKER" | "ADMIN" | "SYSTEM";
  reason: string;
  streamId?: string | null;
  instrumentCode?: string | null;
  source_exchange?: string | null;
  connectionId?: string | null;
  blackoutDurationMs?: number | null;
  recoveredAt?: ISO8601;
}

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
  VAR_CONFIDENCE_Z: number;
  ORACLE_GOVERNANCE_MODE: GovernanceMode;
  ORACLE_MANUAL_SKEPTICISM: number;
  ORACLE_MAX_SKEPTICISM: number;
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
  updatedAt: ISO8601;
  updatedBy: string;
  version: string;
}

export interface NotificationSettings {
  schemaVersion: "notification-settings.v1";
  enabled: boolean;
  minPriority: NotificationPriority;
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
  updatedAt: ISO8601;
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

export type MacroBiasDirection = "BULLISH" | "BEARISH" | "RISK_ON" | "RISK_OFF" | "NEUTRAL";
export type SupervisorSource = "MOLTWORKER" | "ADMIN" | "SYSTEM";

export interface MacroBias {
  schemaVersion: "macro-bias.v1";
  direction: MacroBiasDirection;
  intensity: number;
  confidence: number;
  instruments: string[];
  reason: string;
  source: SupervisorSource;
  createdBy: string;
  createdAt: ISO8601;
  expiresAt: ISO8601 | null;
}

export interface MacroBiasUpdate {
  direction?: MacroBiasDirection;
  intensity?: number;
  confidence?: number;
  instruments?: string[];
  reason?: string;
  source?: SupervisorSource;
  expiresAt?: ISO8601 | null;
  durationMs?: number;
  durationMinutes?: number;
}

export interface TemporaryGovernanceOverride {
  schemaVersion: "governor.override.v1";
  overrideId: string;
  source: SupervisorSource;
  createdBy: string;
  reason: string;
  createdAt: ISO8601;
  expiresAt: ISO8601;
  durationMs: number;
  configPatch: Partial<
    Pick<
      GlobalRiskConfig,
      | "TRADING_ENABLED"
      | "MIN_EV_THRESHOLD"
      | "LATENCY_THRESHOLD_MS"
      | "ORACLE_MANUAL_SKEPTICISM"
      | "ORACLE_MAX_SKEPTICISM"
      | "ORACLE_GOVERNANCE_MODE"
    >
  >;
}

export interface TemporaryGovernanceOverrideUpdate {
  source?: SupervisorSource;
  reason?: string;
  durationMs?: number;
  durationMinutes?: number;
  expiresAt?: ISO8601;
  configPatch?: TemporaryGovernanceOverride["configPatch"];
  TRADING_ENABLED?: boolean;
  MIN_EV_THRESHOLD?: number;
  LATENCY_THRESHOLD_MS?: number;
  ORACLE_MANUAL_SKEPTICISM?: number;
  ORACLE_MAX_SKEPTICISM?: number;
  ORACLE_GOVERNANCE_MODE?: GovernanceMode;
}

export type GlobalRiskConfigUpdate = Partial<
  Pick<
    GlobalRiskConfig,
    | "TRADING_ENABLED"
    | "MAX_POSITION_SIZE"
    | "MAX_POSITION_PCT"
    | "MAX_INVENTORY_UNITS"
    | "MAX_INVENTORY_DELTA"
    | "MAX_DRAWDOWN_PCT"
    | "LATENCY_THRESHOLD_MS"
    | "GOLDEN_COLOS"
    | "MIN_EV_THRESHOLD"
    | "EXCHANGE_FEE_BPS"
    | "KELLY_FRACTION"
    | "RISK_AVERSION_FACTOR"
    | "FUNDING_BIAS_THRESHOLD"
    | "FUNDING_INVENTORY_BIAS"
    | "QUOTE_HIBERNATE_MS"
    | "VAR_CONFIDENCE_Z"
    | "ORACLE_GOVERNANCE_MODE"
    | "ORACLE_MANUAL_SKEPTICISM"
    | "ORACLE_MAX_SKEPTICISM"
    | "AM_VPIN_BUCKET_VOLUME"
    | "AM_VPIN_ROLLING_WINDOW"
    | "AM_VPIN_DIRECTIONAL_DECAY"
    | "AM_VPIN_NORMAL_THRESHOLD"
    | "AM_VPIN_TOXIC_THRESHOLD"
    | "AM_VPIN_CRITICAL_THRESHOLD"
    | "AM_VPIN_OBI_DEPTH"
    | "AM_VPIN_CRITICAL_OBI"
    | "AM_VPIN_CONTESTED_SPREAD_MULTIPLIER"
    | "AM_VPIN_TOXIC_SPREAD_MULTIPLIER"
    | "AM_VPIN_QUOTE_HALT_MS"
  >
>;

export type OrderBookSide = "bid" | "ask";

export interface EdgeTopology {
  colo: string | null;
  placement: string | null;
  country: string | null;
  city: string | null;
  region: string | null;
  timezone: string | null;
  latitude: string | null;
  longitude: string | null;
  requestId: string;
  observedAt: ISO8601;
}

export interface EngineLocation {
  colo: string | null;
  placement: string | null;
  country: string | null;
  city: string | null;
  region: string | null;
  timezone: string | null;
  latitude: string | null;
  longitude: string | null;
  lastSeenAt: ISO8601 | null;
  isGoldenRegion: boolean;
  latencyRiskMultiplier: number;
  positionSizeMultiplier: number;
  observedLatencyMs: number | null;
  reason: "GOLDEN_REGION" | "NON_GOLDEN_REGION" | "UNKNOWN_COLO" | "TARGET_COLO_UNOBSERVED";
}

export interface FundingRateSnapshot {
  instrumentCode: string;
  source_exchange: string;
  marketKey: string;
  hourlyRate: number;
  markPrice: number | null;
  oraclePrice: number | null;
  openInterest: number | null;
  receivedAt: ISO8601;
  updatedAt: ISO8601;
}

export interface PriceLevel {
  price: number;
  size: number;
  updatedAt: ISO8601;
}

export interface OrderBookSnapshotLevel {
  price: number;
  size: number;
  updatedAt?: ISO8601;
}

export interface OrderBookSnapshot {
  schemaVersion: "order-book.snapshot.v1";
  source: MarketDataSource | "ADMIN";
  source_exchange?: string;
  exchangeCode: string;
  instrumentCode: string;
  marketKey?: string;
  sourceWeight?: number;
  sequence: number;
  exchangeTimestamp: ISO8601;
  receivedAt?: ISO8601;
  tickSize?: number;
  bids: OrderBookSnapshotLevel[];
  asks: OrderBookSnapshotLevel[];
}

export interface OrderBookDelta {
  schemaVersion: "order-book.delta.v1";
  source: MarketDataSource;
  source_exchange?: string;
  exchangeCode: string;
  instrumentCode: string;
  marketKey?: string;
  sourceWeight?: number;
  sequence: number;
  exchangeTimestamp: ISO8601;
  receivedAt: ISO8601;
  tickSize?: number;
  side: OrderBookSide;
  price: number;
  size: number;
}

export interface BookSnapshotResponse {
  marketKey: string;
  instrumentCode: string;
  exchangeCode: string | null;
  source_exchange: string | null;
  sourceWeight: number;
  sequence: number | null;
  isSynced: boolean;
  desyncReason: string | null;
  tickSize: number;
  ttbLatencyMs: number | null;
  topLevelCount: number;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  weightedImbalance: number | null;
  bids: PriceLevel[];
  asks: PriceLevel[];
  updatedAt: ISO8601 | null;
}

export interface MicrostructureMetrics {
  marketKey: string | null;
  instrumentCode: string | null;
  exchangeCode: string | null;
  source_exchange: string | null;
  sourceWeight: number;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  spreadBps: number | null;
  bidVolume: number;
  askVolume: number;
  weightedImbalance: number | null;
  depthLevels: number;
  lastSequence: number | null;
  timeToBookMs: number | null;
  isSynced: boolean;
  updatedAt: ISO8601 | null;
}

export interface PriceDiscoverySource {
  marketKey: string;
  source: MarketDataSource;
  source_exchange: string;
  exchangeCode: string;
  instrumentCode: string;
  weight: number;
  midPrice: number | null;
  spreadBps: number | null;
  weightedImbalance: number | null;
  updatedAt: ISO8601 | null;
}

export interface PriceDiscoveryMetrics {
  instrumentCode: string | null;
  weightedMidPrice: number | null;
  primaryExchange: string | null;
  primaryWeight: number;
  sourceCount: number;
  sources: PriceDiscoverySource[];
  updatedAt: ISO8601 | null;
}

export interface PerformanceConfig {
  maxLatencyMs: number;
}

export type LatencyStatus = "FRESH" | "STALE";

export interface LatencyMetrics {
  instrumentCode: string;
  exchangeCode: string;
  source: MarketDataSource;
  sourceExchange: string;
  sourceWeight: number;
  sequence: number;
  providerTimestamp: ISO8601;
  sourceTimestamp: ISO8601;
  ingestTimestamp: ISO8601;
  brainTimestamp: ISO8601;
  clockOffsetMs: number;
  networkLatencyMs: number;
  processingLatencyMs: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  averageLatencyMs: number;
  sampleCount: number;
  status: LatencyStatus;
  colo: string | null;
  placement: string | null;
  latencyRiskMultiplier: number;
  positionSizeMultiplier: number;
  timeToBookMs?: number | null;
}

export interface ExecutionProfile {
  status: EngineStabilityStatus;
  jitterMs: number;
  jitterThresholdMs: number;
  sampleCount: number;
  sampleWindow: number;
  computeIntervalTicks: number;
  averageProcessingLatencyMs: number | null;
  maxProcessingLatencyMs: number | null;
  lastProcessingLatencyMs: number | null;
  wakeUpTimeMs: number | null;
  coldStartSuspected: boolean;
  orderBookUpdateMs: number | null;
  agentLogicMs: number | null;
  totalHotPathMs: number | null;
  lastComputedAt: ISO8601 | null;
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

export type OracleInstrumentState = Omit<
  OracleState,
  "instrumentStates" | "memoryByInstrument"
>;

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
  liquidationHeatmap: LiquidationHeatmapState;
  assetMatrix: Record<string, AssetRuntimeState>;
  profilerStates: Record<string, ProfilerState>;
  cachedConfig: GlobalRiskConfig;
  location: EngineLocation;
  microstructure: MicrostructureMetrics;
  priceDiscovery: PriceDiscoveryMetrics;
  oracle: OracleState;
  sentiment: SentimentState;
  leadLag: LeadLagMetrics;
  inventory: InventoryState;
  inventoryGuard: InventoryGuardState;
  riskMetrics: RiskMetrics;
  quoteState: QuoteState;
  assetQuoteStates: Record<string, QuoteState>;
  shadowQueue: ShadowQueueState;
  slippage: SlippageAnalytics;
  executionProfile: ExecutionProfile;
  dom: DomAnalysisSnapshot | null;
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
