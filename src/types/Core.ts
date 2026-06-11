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
export type HealthStatus = "GREEN" | "YELLOW" | "RED" | "DISABLED";
export type GovernanceMode = "MANUAL" | "AUTONOMOUS" | "HYBRID";
export type MarketMakingMode =
  | "OFF"
  | "PASSIVE"
  | "BALANCED"
  | "AGGRESSIVE"
  | "INVENTORY_SKEW_ONLY";
export type SentimentAlphaMode = "OFF" | "EVENT_RISK_ONLY" | "CONTINUOUS";
export type StrategyMode =
  | "OFF"
  | "MARKET_MAKING"
  | "CASCADE_RECOVERY"
  | "BOTH_SHADOW"
  | "BOTH_LIVE";
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
