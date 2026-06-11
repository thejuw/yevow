import type {
  JsonRecord,
  LiquidationCascadeCluster,
  LiquidationHeatmapState,
  MarketTick,
  PriceLevel,
  ProfilerState,
  ProfilerVolumeBucket,
  ToxicityPressureSide,
  ToxicityState
} from "../types";

const DEFAULT_DIRECTIONAL_DECAY = 0.3;
const DEFAULT_OBI_DEPTH = 5;
const DEFAULT_NORMAL_THRESHOLD = 0.65;
const DEFAULT_TOXIC_THRESHOLD = 0.75;
const DEFAULT_CRITICAL_THRESHOLD = 0.85;
const DEFAULT_CRITICAL_OBI = 0.8;

export interface AmVpinConsensus {
  state: ToxicityState;
  pressureSide: ToxicityPressureSide;
  spreadMultiplier: number;
  reservationShiftBps: number;
  haltMs: number | null;
  structuralConsensus: boolean;
  classifierProbability?: number;
  classifierTriggered?: boolean;
}

export function defaultProfilerState(
  bucketSize: number,
  rollingWindow: number,
  alertThreshold: number,
  directionalDecay = DEFAULT_DIRECTIONAL_DECAY,
  obiDepth = DEFAULT_OBI_DEPTH,
  normalThreshold = DEFAULT_NORMAL_THRESHOLD,
  toxicThreshold = DEFAULT_TOXIC_THRESHOLD,
  criticalThreshold = DEFAULT_CRITICAL_THRESHOLD,
  criticalObi = DEFAULT_CRITICAL_OBI
): ProfilerState {
  return {
    schemaVersion: "profiler.v1",
    bucketSize,
    rollingWindow,
    alertThreshold,
    toxicityScore: 0,
    amVpinScore: 0,
    obi: null,
    obiDepth,
    directionalDecay,
    latestSignedImbalance: 0,
    latestDirectionalImbalance: 0,
    toxicityState: "NORMAL",
    pressureSide: "NEUTRAL",
    spreadMultiplier: 1,
    reservationShiftBps: 0,
    quoteHaltUntil: null,
    amVpinBucketCompletions: 0,
    amVpinMean: 0,
    amVpinM2: 0,
    amVpinVariance: 0,
    amVpinRing: {
      buyVolumes: [],
      sellVolumes: [],
      signedImbalances: [],
      directionalImbalances: [],
      obiValues: []
    },
    distanceToCascadePct: null,
    cascadeShieldUntil: null,
    cascadeClusterId: null,
    cascadeSide: null,
    activeBucket: null,
    buckets: [],
    totalBucketsClosed: 0,
    lastProcessedSequence: null,
    lastSignalId: null,
    lastAlertBucketCount: 0,
    lastSpoofingWallId: null,
    tradeSizeCount: 0,
    tradeSizeMean: 0,
    tradeSizeM2: 0,
    tradeSizeWindow: [],
    quoteSuspendedUntil: null,
    updatedAt: new Date().toISOString()
  };
}

export function isProfilerState(value: unknown): value is ProfilerState {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ProfilerState).schemaVersion === "profiler.v1" &&
    Array.isArray((value as ProfilerState).buckets)
  );
}

export function sanitizeBucket(
  bucket: ProfilerVolumeBucket,
  fallbackTimestamp: string
): ProfilerVolumeBucket {
  const buyVolume = positiveNumber(bucket.buyVolume, 0);
  const sellVolume = positiveNumber(bucket.sellVolume, 0);

  return {
    bucketId:
      typeof bucket.bucketId === "string" && bucket.bucketId.length > 0
        ? bucket.bucketId
        : crypto.randomUUID(),
    instrumentCode:
      typeof bucket.instrumentCode === "string" && bucket.instrumentCode.length > 0
        ? bucket.instrumentCode
        : "unknown",
    startedAt: typeof bucket.startedAt === "string" ? bucket.startedAt : fallbackTimestamp,
    closedAt: typeof bucket.closedAt === "string" ? bucket.closedAt : null,
    buyVolume,
    sellVolume,
    totalVolume: roundMetric(buyVolume + sellVolume),
    imbalance: roundMetric(buyVolume - sellVolume)
  };
}

export function isOrderFlowTick(tick: MarketTick): boolean {
  const commodity =
    typeof tick.raw?.commodity === "string" ? tick.raw.commodity.toUpperCase() : null;
  const eventType =
    typeof tick.raw?.eventType === "string" ? tick.raw.eventType.toLowerCase() : null;

  if (commodity?.includes("ORDER_BOOK") || eventType === "l2book" || eventType === "depthupdate") {
    return false;
  }

  return commodity === null || commodity.includes("TRADE") || eventType === "trade";
}

export function aggressorSign(tick: MarketTick): -1 | 0 | 1 {
  if (typeof tick.raw?.isBuy === "boolean") {
    return tick.raw.isBuy ? 1 : -1;
  }

  const rawSide =
    typeof tick.raw?.aggressorSide === "string" ? tick.raw.aggressorSide.toUpperCase() : null;

  if (rawSide === "B" || rawSide === "BUY" || rawSide === "BID") {
    return 1;
  }

  if (rawSide === "A" || rawSide === "ASK" || rawSide === "SELL" || rawSide === "SHORT") {
    return -1;
  }

  if (tick.side === "buy") {
    return 1;
  }

  if (tick.side === "sell") {
    return -1;
  }

  return 0;
}

export function calculateObi(
  bids: PriceLevel[] | undefined,
  asks: PriceLevel[] | undefined,
  depth: number
): number | null {
  if (!bids || !asks || depth <= 0) {
    return null;
  }

  let bidVolume = 0;
  let askVolume = 0;
  const bidLimit = Math.min(depth, bids.length);
  const askLimit = Math.min(depth, asks.length);

  for (let index = 0; index < bidLimit; index += 1) {
    bidVolume += bids[index]?.size ?? 0;
  }

  for (let index = 0; index < askLimit; index += 1) {
    askVolume += asks[index]?.size ?? 0;
  }

  const total = bidVolume + askVolume;
  return total > 0 ? roundMetric((bidVolume - askVolume) / total, 8) : null;
}

export function classifyToxicity(input: {
  amVpin: number;
  obi: number | null;
  directionalImbalance: number;
  normalThreshold: number;
  toxicThreshold: number;
  criticalThreshold: number;
  criticalObi: number;
  criticalHaltMs: number;
  contestedSpreadMultiplier: number;
  toxicSpreadMultiplier: number;
}): AmVpinConsensus {
  const pressureSign = signOf(input.directionalImbalance);
  const obiSign = signOf(input.obi ?? 0);
  const absoluteObi = Math.abs(input.obi ?? 0);
  const pressureSide: ToxicityPressureSide =
    pressureSign > 0 ? "BUY" : pressureSign < 0 ? "SELL" : "NEUTRAL";
  const structuralConsensus = pressureSign !== 0 && obiSign !== 0 && pressureSign === obiSign;

  if (input.amVpin < input.normalThreshold) {
    return {
      state: "NORMAL",
      pressureSide,
      spreadMultiplier: 1,
      reservationShiftBps: 0,
      haltMs: null,
      structuralConsensus
    };
  }

  if (!structuralConsensus) {
    return {
      state: "CONTESTED",
      pressureSide,
      spreadMultiplier: 1,
      reservationShiftBps: 0,
      haltMs: null,
      structuralConsensus
    };
  }

  if (input.amVpin >= input.criticalThreshold && absoluteObi >= input.criticalObi) {
    return {
      state: "CRITICAL",
      pressureSide,
      spreadMultiplier: 1,
      reservationShiftBps: 0,
      haltMs: input.criticalHaltMs,
      structuralConsensus
    };
  }

  if (input.amVpin >= input.toxicThreshold) {
    return {
      state: "CRITICAL",
      pressureSide,
      spreadMultiplier: 1,
      reservationShiftBps: 0,
      haltMs: input.criticalHaltMs,
      structuralConsensus
    };
  }

  return {
    state: "CONTESTED",
    pressureSide,
    spreadMultiplier: 1,
    reservationShiftBps: 0,
    haltMs: null,
    structuralConsensus
  };
}

export function signOf(value: number): -1 | 0 | 1 {
  if (value > 0.00000001) {
    return 1;
  }

  if (value < -0.00000001) {
    return -1;
  }

  return 0;
}

export function typedArrayToArray(
  values: Float32Array,
  count: number,
  nextIndex: number
): number[] {
  const limit = Math.min(count, values.length);
  const output = new Array<number>(limit);
  let outputIndex = 0;

  for (let offset = limit; offset > 0; offset -= 1) {
    const index = (nextIndex - offset + values.length) % values.length;
    output[outputIndex] = roundMetric(values[index]);
    outputIndex += 1;
  }

  return output;
}

export function normalizeToxicityState(value: unknown): ToxicityState {
  return value === "CONTESTED" || value === "TOXIC" || value === "CRITICAL" ? value : "NORMAL";
}

export function normalizePressureSide(value: unknown): ToxicityPressureSide {
  return value === "BUY" || value === "SELL" ? value : "NEUTRAL";
}

export function rollingTradeSizeStats(
  window: Array<{ size: number; observedAt: string }>,
  observedAt: string
): { count: number; mean: number; std: number } {
  const pruned = pruneTradeSizeWindow(window, observedAt);
  const count = pruned.length;

  if (count === 0) {
    return { count: 0, mean: 0, std: 0 };
  }

  const mean = pruned.reduce((sum, item) => sum + item.size, 0) / count;
  const variance =
    count > 1 ? pruned.reduce((sum, item) => sum + (item.size - mean) ** 2, 0) / (count - 1) : 0;

  return { count, mean, std: Math.sqrt(variance) };
}

export function pruneTradeSizeWindow(
  window: Array<{ size: number; observedAt: string }>,
  observedAt: string
): Array<{ size: number; observedAt: string }> {
  const cutoff = Date.parse(observedAt) - 3_600_000;

  return window
    .filter((item) => Number.isFinite(item.size) && item.size > 0)
    .filter((item) => {
      const timestamp = Date.parse(item.observedAt);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    })
    .slice(-10_000);
}

export function sanitizeTradeSizeWindow(
  value: Array<{ size: number; observedAt: string }> | undefined
): Array<{ size: number; observedAt: string }> {
  return Array.isArray(value)
    ? value
        .filter((item) => Number.isFinite(item.size) && typeof item.observedAt === "string")
        .slice(-10_000)
    : [];
}

export function nearestCascadeCluster(
  heatmap: LiquidationHeatmapState | null | undefined,
  instrumentCode: string,
  midPrice: number | null
): LiquidationCascadeCluster | null {
  const clusters = heatmap?.clusters ?? [];
  const candidates = clusters.filter(
    (cluster) =>
      cluster.instrumentCode === instrumentCode &&
      cluster.estimatedNotionalUsd >= (heatmap?.clusterThresholdUsd ?? 10_000_000)
  );

  if (candidates.length === 0) {
    return null;
  }

  if (midPrice === null || midPrice <= 0) {
    return candidates[0] ?? null;
  }

  return (
    [...candidates].sort(
      (left, right) =>
        Math.abs(left.centerPrice - midPrice) - Math.abs(right.centerPrice - midPrice)
    )[0] ?? null
  );
}

export function formatPct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(3)}%`;
}

export function formatUsd(value: number): string {
  if (value >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  return `$${value.toFixed(0)}`;
}

export function compactJsonRecord(value: Record<string, unknown>): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, toJsonValue(item)])
  ) as JsonRecord;
}

export function toJsonValue(value: unknown): JsonRecord[string] {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }

  if (typeof value === "object") {
    return compactJsonRecord(value as Record<string, unknown>);
  }

  return String(value);
}

export function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function nonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function roundMetric(value: number, decimals = 8): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
