import type { AgentName, GovernanceMode, ISO8601, JsonRecord, MarketDataSource } from "./Core";
import type { OrderBookSide, PriceLevel } from "./MarketStructure";
import type { AgentSignal } from "./Telemetry";

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
