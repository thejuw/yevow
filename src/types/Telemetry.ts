import type { AgentAction, AgentName, ISO8601, JsonRecord } from "./Core";
import type { OrderBookSide, PriceLevel } from "./MarketStructure";

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
