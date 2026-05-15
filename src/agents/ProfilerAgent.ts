import type {
  AgentSignal,
  JsonRecord,
  LiquidityWall,
  MarketTick,
  ProfilerState,
  ProfilerVolumeBucket
} from "../types";

export const PROFILER_STATE_STORAGE_KEY = "agent:profiler:state";

const DEFAULT_BUCKET_SIZE = 10;
const DEFAULT_ROLLING_WINDOW = 50;
const DEFAULT_ALERT_THRESHOLD = 0.7;
const DEFAULT_WHALE_Z_THRESHOLD = 5;
const DEFAULT_QUOTE_HIBERNATE_MS = 3_000;
const VOLUME_EPSILON = 0.00000001;

export interface ProfilerAgentConfig {
  bucketSize?: number;
  rollingWindow?: number;
  alertThreshold?: number;
  whalePrintZThreshold?: number;
  quoteHibernateMs?: number;
}

export interface ProfilerContext {
  engineId: string;
  observedAt: string;
  midPrice: number | null;
  spreadBps: number | null;
  weightedImbalance: number | null;
  liquidityWalls?: LiquidityWall[];
  spoofingAlerts?: LiquidityWall[];
}

export interface ProfilerEvaluation {
  processed: boolean;
  skippedReason: string | null;
  closedBuckets: number;
  toxicityScore: number;
  state: ProfilerState;
  signal: AgentSignal | null;
}

export class ProfilerAgent {
  private readonly bucketSize: number;
  private readonly rollingWindow: number;
  private readonly alertThreshold: number;
  private readonly whalePrintZThreshold: number;
  private readonly quoteHibernateMs: number;
  private state: ProfilerState;

  constructor(config: ProfilerAgentConfig = {}) {
    this.bucketSize = positiveNumber(config.bucketSize, DEFAULT_BUCKET_SIZE);
    this.rollingWindow = positiveInteger(config.rollingWindow, DEFAULT_ROLLING_WINDOW);
    this.alertThreshold = clamp(
      positiveNumber(config.alertThreshold, DEFAULT_ALERT_THRESHOLD),
      0,
      1
    );
    this.whalePrintZThreshold = positiveNumber(
      config.whalePrintZThreshold,
      DEFAULT_WHALE_Z_THRESHOLD
    );
    this.quoteHibernateMs = positiveInteger(
      config.quoteHibernateMs,
      DEFAULT_QUOTE_HIBERNATE_MS
    );
    this.state = defaultProfilerState(
      this.bucketSize,
      this.rollingWindow,
      this.alertThreshold
    );
  }

  hydrate(persisted: ProfilerState | null | undefined): void {
    if (!isProfilerState(persisted)) {
      this.state = defaultProfilerState(
        this.bucketSize,
        this.rollingWindow,
        this.alertThreshold
      );
      return;
    }

    this.state = {
      ...persisted,
      bucketSize: this.bucketSize,
      rollingWindow: this.rollingWindow,
      alertThreshold: this.alertThreshold,
      toxicityScore: clamp(roundMetric(persisted.toxicityScore), 0, 1),
      activeBucket: persisted.activeBucket
        ? sanitizeBucket(persisted.activeBucket, persisted.updatedAt)
        : null,
      buckets: persisted.buckets
        .map((bucket) => sanitizeBucket(bucket, persisted.updatedAt))
        .slice(-this.rollingWindow),
      totalBucketsClosed: Math.max(0, Math.floor(persisted.totalBucketsClosed)),
      lastProcessedSequence:
        typeof persisted.lastProcessedSequence === "number"
          ? persisted.lastProcessedSequence
          : null,
      lastSignalId:
        typeof persisted.lastSignalId === "string" ? persisted.lastSignalId : null,
      lastAlertBucketCount: Math.max(0, Math.floor(persisted.lastAlertBucketCount)),
      lastSpoofingWallId:
        typeof persisted.lastSpoofingWallId === "string"
          ? persisted.lastSpoofingWallId
          : null,
      tradeSizeCount: Math.max(0, Math.floor(persisted.tradeSizeCount ?? 0)),
      tradeSizeMean: positiveNumber(persisted.tradeSizeMean, 0),
      tradeSizeM2: Math.max(0, Number(persisted.tradeSizeM2 ?? 0)),
      tradeSizeWindow: sanitizeTradeSizeWindow(persisted.tradeSizeWindow),
      quoteSuspendedUntil:
        typeof persisted.quoteSuspendedUntil === "string"
          ? persisted.quoteSuspendedUntil
          : null
    };
  }

  processTick(tick: MarketTick, context: ProfilerContext): ProfilerEvaluation {
    const spoofingSignal = this.maybeCreateSpoofingSignal(tick, context);
    const whaleSignal = this.detectWhalePrint(tick, context);

    if (!isOrderFlowTick(tick)) {
      const signal = spoofingSignal ?? whaleSignal;

      if (signal) {
        this.state.lastSignalId = signal.signalId;
        this.state.lastSpoofingWallId = context.spoofingAlerts?.[0]?.wallId ?? null;
        this.state.lastProcessedSequence = tick.sequence;
        this.state.updatedAt = context.observedAt;

        return {
          processed: true,
          skippedReason: null,
          closedBuckets: 0,
          toxicityScore: this.state.toxicityScore,
          state: this.snapshot(),
          signal
        };
      }

      return this.skipped("NON_TRADE_TICK");
    }

    if (
      this.state.lastProcessedSequence !== null &&
      this.state.lastProcessedSequence === tick.sequence
    ) {
      return this.skipped("DUPLICATE_SEQUENCE");
    }

    if (!Number.isFinite(tick.size) || tick.size <= 0) {
      return this.skipped("NO_VOLUME");
    }

    let remainingVolume = tick.size;
    let closedBuckets = 0;
    let safetyCounter = 0;

    while (remainingVolume > VOLUME_EPSILON && safetyCounter < 10_000) {
      safetyCounter += 1;
      const active = this.ensureActiveBucket(tick.instrumentCode, context.observedAt);
      const capacity = Math.max(0, this.bucketSize - active.totalVolume);
      const allocation = Math.min(remainingVolume, capacity);

      this.applyVolume(active, allocation, tick.side);
      remainingVolume = roundMetric(remainingVolume - allocation);

      if (active.totalVolume + VOLUME_EPSILON >= this.bucketSize) {
        this.closeActiveBucket(context.observedAt);
        closedBuckets += 1;
      }
    }

    this.state.lastProcessedSequence = tick.sequence;
    this.state.updatedAt = context.observedAt;
    this.state.toxicityScore = this.calculateVpin();

    const signal =
      whaleSignal ??
      spoofingSignal ??
      (closedBuckets > 0 && this.shouldEmitAlert()
        ? this.createAlertSignal(tick, context)
        : null);

    if (signal) {
      this.state.lastSignalId = signal.signalId;
      if (spoofingSignal) {
        this.state.lastSpoofingWallId = context.spoofingAlerts?.[0]?.wallId ?? null;
      } else {
        this.state.lastAlertBucketCount = this.state.totalBucketsClosed;
      }
    }

    return {
      processed: true,
      skippedReason: null,
      closedBuckets,
      toxicityScore: this.state.toxicityScore,
      state: this.snapshot(),
      signal
    };
  }

  snapshot(): ProfilerState {
    return {
      ...this.state,
      activeBucket: this.state.activeBucket
        ? { ...this.state.activeBucket }
        : null,
      buckets: this.state.buckets.map((bucket) => ({ ...bucket })),
      tradeSizeWindow: this.state.tradeSizeWindow.map((item) => ({ ...item }))
    };
  }

  get toxicityScore(): number {
    return this.state.toxicityScore;
  }

  private skipped(reason: string): ProfilerEvaluation {
    return {
      processed: false,
      skippedReason: reason,
      closedBuckets: 0,
      toxicityScore: this.state.toxicityScore,
      state: this.snapshot(),
      signal: null
    };
  }

  private ensureActiveBucket(
    instrumentCode: string,
    observedAt: string
  ): ProfilerVolumeBucket {
    if (this.state.activeBucket) {
      return this.state.activeBucket;
    }

    this.state.activeBucket = {
      bucketId: `vpin:${instrumentCode}:${this.state.totalBucketsClosed + 1}`,
      instrumentCode,
      startedAt: observedAt,
      closedAt: null,
      buyVolume: 0,
      sellVolume: 0,
      totalVolume: 0,
      imbalance: 0
    };

    return this.state.activeBucket;
  }

  private applyVolume(
    bucket: ProfilerVolumeBucket,
    allocation: number,
    side: MarketTick["side"]
  ): void {
    if (allocation <= 0) {
      return;
    }

    if (side === "buy") {
      bucket.buyVolume = roundMetric(bucket.buyVolume + allocation);
    } else if (side === "sell") {
      bucket.sellVolume = roundMetric(bucket.sellVolume + allocation);
    } else {
      const neutralVolume = allocation / 2;
      bucket.buyVolume = roundMetric(bucket.buyVolume + neutralVolume);
      bucket.sellVolume = roundMetric(bucket.sellVolume + neutralVolume);
    }

    bucket.totalVolume = roundMetric(bucket.buyVolume + bucket.sellVolume);
    bucket.imbalance = roundMetric(bucket.buyVolume - bucket.sellVolume);
  }

  private closeActiveBucket(observedAt: string): void {
    if (!this.state.activeBucket) {
      return;
    }

    this.state.activeBucket.closedAt = observedAt;
    this.state.activeBucket.totalVolume = roundMetric(
      this.state.activeBucket.buyVolume + this.state.activeBucket.sellVolume
    );
    this.state.activeBucket.imbalance = roundMetric(
      this.state.activeBucket.buyVolume - this.state.activeBucket.sellVolume
    );
    this.state.buckets.push(this.state.activeBucket);
    this.state.totalBucketsClosed += 1;

    if (this.state.buckets.length > this.rollingWindow) {
      this.state.buckets.splice(0, this.state.buckets.length - this.rollingWindow);
    }

    this.state.activeBucket = null;
  }

  private calculateVpin(): number {
    const bucketCount = this.state.buckets.length;

    if (bucketCount === 0) {
      return 0;
    }

    const imbalance = this.state.buckets.reduce(
      (sum, bucket) => sum + Math.abs(bucket.imbalance),
      0
    );

    return clamp(roundMetric(imbalance / (bucketCount * this.bucketSize)), 0, 1);
  }

  private shouldEmitAlert(): boolean {
    return (
      this.state.toxicityScore > this.alertThreshold &&
      this.state.totalBucketsClosed > this.state.lastAlertBucketCount
    );
  }

  private createAlertSignal(tick: MarketTick, context: ProfilerContext): AgentSignal {
    const latestBucket = this.state.buckets.at(-1) ?? null;
    const signalId = crypto.randomUUID();
    const confidence = clamp(this.state.toxicityScore, 0, 1);
    const suggestedSpreadWidenBps = roundMetric(10 + confidence * 40, 4);

    return {
      signalId,
      traceId: `${context.engineId}:profiler:${tick.instrumentCode}:${tick.sequence}`,
      sourceAgent: "PROFILER",
      targetAgent: "CROUPIER",
      instrumentCode: tick.instrumentCode,
      action: "REDUCE",
      confidence,
      horizonMs: 5_000,
      expectedValue: roundMetric(-confidence),
      maxSlippageBps: suggestedSpreadWidenBps,
      rationale: `VPIN ${confidence.toFixed(4)} exceeded toxicity threshold ${this.alertThreshold.toFixed(4)}; widen bid-ask spreads.`,
      featureVector: compactJsonRecord({
        vpin: this.state.toxicityScore,
        bucketSize: this.bucketSize,
        rollingWindow: this.rollingWindow,
      completedBuckets: this.state.buckets.length,
      totalBucketsClosed: this.state.totalBucketsClosed,
      activeLiquidityWalls: context.liquidityWalls?.length ?? 0,
      spoofingAlerts: context.spoofingAlerts?.length ?? 0,
      latestBucketBuyVolume: latestBucket?.buyVolume ?? null,
        latestBucketSellVolume: latestBucket?.sellVolume ?? null,
        latestBucketImbalance: latestBucket?.imbalance ?? null,
        midPrice: context.midPrice,
        spreadBps: context.spreadBps,
        weightedImbalance: context.weightedImbalance
      }),
      riskContext: compactJsonRecord({
        alertThreshold: this.alertThreshold,
        toxicityScore: this.state.toxicityScore,
        suggestedSpreadWidenBps,
        spoofingAlerts: context.spoofingAlerts?.length ?? 0,
        recommendation: "WIDEN_BID_ASK_SPREADS"
      }),
      createdAt: context.observedAt
    };
  }

  private maybeCreateSpoofingSignal(
    tick: MarketTick,
    context: ProfilerContext
  ): AgentSignal | null {
    const wall = context.spoofingAlerts?.[0] ?? null;

    if (!wall || wall.wallId === this.state.lastSpoofingWallId) {
      return null;
    }

    const confidence = clamp(Math.max(0.75, this.state.toxicityScore), 0, 1);
    const suggestedSpreadWidenBps = roundMetric(15 + confidence * 50, 4);

    return {
      signalId: crypto.randomUUID(),
      traceId: `${context.engineId}:profiler:spoof:${wall.wallId}:${tick.sequence}`,
      sourceAgent: "PROFILER",
      targetAgent: "CROUPIER",
      instrumentCode: tick.instrumentCode,
      action: "REDUCE",
      confidence,
      horizonMs: 2_500,
      expectedValue: roundMetric(-confidence),
      maxSlippageBps: suggestedSpreadWidenBps,
      rationale: `Liquidity wall ${wall.wallId} was pulled near the touch; possible spoofing. Widen spreads and reduce quote aggression.`,
      featureVector: compactJsonRecord({
        vpin: this.state.toxicityScore,
        wallId: wall.wallId,
        wallSide: wall.side,
        wallCenterPrice: wall.centerPrice,
        wallVolume: wall.volume,
        wallZScore: wall.zScore,
        distanceFromMidBps: wall.distanceFromMidBps,
        activeLiquidityWalls: context.liquidityWalls?.length ?? 0,
        spoofingAlerts: context.spoofingAlerts?.length ?? 0,
        midPrice: context.midPrice,
        spreadBps: context.spreadBps,
        weightedImbalance: context.weightedImbalance
      }),
      riskContext: compactJsonRecord({
        alertType: "SPOOFING_SUSPECTED",
        toxicityScore: this.state.toxicityScore,
        suggestedSpreadWidenBps,
        recommendation: "WIDEN_SPREADS_AND_FADE_PULLED_WALL"
      }),
      createdAt: context.observedAt
    };
  }

  detectWhalePrint(tick: MarketTick, context: ProfilerContext): AgentSignal | null {
    if (!isOrderFlowTick(tick) || tick.size <= 0) {
      return null;
    }

    const stats = rollingTradeSizeStats(this.state.tradeSizeWindow, context.observedAt);
    this.observeTradeSize(tick.size, context.observedAt);

    if (
      stats.count < 30 ||
      stats.std <= 0 ||
      tick.size <= stats.mean + this.whalePrintZThreshold * stats.std
    ) {
      return null;
    }

    const suspendedUntil = new Date(
      Date.parse(context.observedAt) + this.quoteHibernateMs
    ).toISOString();
    this.state.quoteSuspendedUntil = suspendedUntil;

    return {
      signalId: crypto.randomUUID(),
      traceId: `${context.engineId}:profiler:whale:${tick.instrumentCode}:${tick.sequence}`,
      sourceAgent: "PROFILER",
      targetAgent: "CROUPIER",
      instrumentCode: tick.instrumentCode,
      action: "PAUSE",
      confidence: 0.95,
      horizonMs: this.quoteHibernateMs,
      expectedValue: -1,
      maxSlippageBps: 100,
      rationale: "Whale print exceeded one-hour trade-size baseline; suspend quotes until price discovery stabilizes.",
      featureVector: compactJsonRecord({
        signalType: "SUSPEND_QUOTES",
        tradeSize: tick.size,
        tradeSizeMean: stats.mean,
        tradeSizeStd: stats.std,
        tradeSizeWindowMs: 3_600_000,
        thresholdZ: this.whalePrintZThreshold,
        suspendedUntil
      }),
      riskContext: compactJsonRecord({
        recommendation: "CANCEL_OPEN_LIMIT_ORDERS_AND_HIBERNATE",
        quoteHibernateMs: this.quoteHibernateMs
      }),
      createdAt: context.observedAt
    };
  }

  private observeTradeSize(size: number, observedAt: string): void {
    this.state.tradeSizeWindow.push({ size, observedAt });
    this.state.tradeSizeWindow = pruneTradeSizeWindow(this.state.tradeSizeWindow, observedAt);
    this.state.tradeSizeCount += 1;
    const delta = size - this.state.tradeSizeMean;
    this.state.tradeSizeMean += delta / this.state.tradeSizeCount;
    this.state.tradeSizeM2 += delta * (size - this.state.tradeSizeMean);
  }
}

function defaultProfilerState(
  bucketSize: number,
  rollingWindow: number,
  alertThreshold: number
): ProfilerState {
  return {
    schemaVersion: "profiler.v1",
    bucketSize,
    rollingWindow,
    alertThreshold,
    toxicityScore: 0,
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

function isProfilerState(value: unknown): value is ProfilerState {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ProfilerState).schemaVersion === "profiler.v1" &&
    Array.isArray((value as ProfilerState).buckets)
  );
}

function sanitizeBucket(
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
    startedAt:
      typeof bucket.startedAt === "string" ? bucket.startedAt : fallbackTimestamp,
    closedAt: typeof bucket.closedAt === "string" ? bucket.closedAt : null,
    buyVolume,
    sellVolume,
    totalVolume: roundMetric(buyVolume + sellVolume),
    imbalance: roundMetric(buyVolume - sellVolume)
  };
}

function isOrderFlowTick(tick: MarketTick): boolean {
  const commodity =
    typeof tick.raw?.commodity === "string" ? tick.raw.commodity.toUpperCase() : null;
  const eventType =
    typeof tick.raw?.eventType === "string" ? tick.raw.eventType.toLowerCase() : null;

  if (commodity?.includes("ORDER_BOOK") || eventType === "l2book" || eventType === "depthupdate") {
    return false;
  }

  return commodity === null || commodity.includes("TRADE") || eventType === "trade";
}

function rollingTradeSizeStats(
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
    count > 1
      ? pruned.reduce((sum, item) => sum + (item.size - mean) ** 2, 0) / (count - 1)
      : 0;

  return { count, mean, std: Math.sqrt(variance) };
}

function pruneTradeSizeWindow(
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

function sanitizeTradeSizeWindow(
  value: Array<{ size: number; observedAt: string }> | undefined
): Array<{ size: number; observedAt: string }> {
  return Array.isArray(value)
    ? value
        .filter((item) => Number.isFinite(item.size) && typeof item.observedAt === "string")
        .slice(-10_000)
    : [];
}

function compactJsonRecord(value: Record<string, unknown>): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, toJsonValue(item)])
  ) as JsonRecord;
}

function toJsonValue(value: unknown): JsonRecord[string] {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
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

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function roundMetric(value: number, decimals = 8): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
