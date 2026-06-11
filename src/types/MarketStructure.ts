import type { EngineStabilityStatus, ISO8601, MarketDataSource } from "./Core";

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
  reason:
    | "GOLDEN_REGION"
    | "NON_GOLDEN_REGION"
    | "UNKNOWN_COLO"
    | "TARGET_COLO_UNOBSERVED"
    | "TARGET_COLO_ASSUMED";
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
