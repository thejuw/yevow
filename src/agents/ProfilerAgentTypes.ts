import type {
  AgentSignal,
  LiquidityWall,
  LiquidationHeatmapState,
  PriceLevel,
  ProfilerState
} from "../types";

export const DEFAULT_BUCKET_SIZE = 10;
export const DEFAULT_ROLLING_WINDOW = 50;
export const DEFAULT_ALERT_THRESHOLD = 0.7;
export const DEFAULT_WHALE_Z_THRESHOLD = 5;
export const DEFAULT_QUOTE_HIBERNATE_MS = 3_000;
export const DEFAULT_DIRECTIONAL_DECAY = 0.3;
export const DEFAULT_OBI_DEPTH = 5;
export const DEFAULT_NORMAL_THRESHOLD = 0.65;
export const DEFAULT_TOXIC_THRESHOLD = 0.75;
export const DEFAULT_CRITICAL_THRESHOLD = 0.85;
export const DEFAULT_CRITICAL_OBI = 0.8;
export const DEFAULT_CRITICAL_HALT_MS = 60_000;
export const DEFAULT_CONTESTED_SPREAD_MULTIPLIER = 1.5;
export const DEFAULT_TOXIC_SPREAD_MULTIPLIER = 3;
export const VOLUME_EPSILON = 0.00000001;

export interface ProfilerAgentConfig {
  bucketSize?: number;
  rollingWindow?: number;
  alertThreshold?: number;
  whalePrintZThreshold?: number;
  quoteHibernateMs?: number;
  directionalDecay?: number;
  obiDepth?: number;
  normalThreshold?: number;
  toxicThreshold?: number;
  criticalThreshold?: number;
  criticalObi?: number;
  criticalHaltMs?: number;
  contestedSpreadMultiplier?: number;
  toxicSpreadMultiplier?: number;
  toxicityClassifierEnabled?: boolean;
  toxicityClassifierThreshold?: number;
}

export interface ProfilerContext {
  engineId: string;
  observedAt: string;
  midPrice: number | null;
  spreadBps: number | null;
  weightedImbalance: number | null;
  orderBookBids?: PriceLevel[];
  orderBookAsks?: PriceLevel[];
  liquidityWalls?: LiquidityWall[];
  spoofingAlerts?: LiquidityWall[];
  liquidationHeatmap?: LiquidationHeatmapState | null;
  jumpDetected?: boolean;
}

export interface ProfilerEvaluation {
  processed: boolean;
  skippedReason: string | null;
  closedBuckets: number;
  toxicityScore: number;
  state: ProfilerState;
  signal: AgentSignal | null;
}
