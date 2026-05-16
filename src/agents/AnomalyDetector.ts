import type {
  AnomalyDetectorState,
  AnomalyStatsBucket,
  AnomalyStatus,
  AnomalyTopOfBookBucket,
  AnomalyTopOfBookSnapshot,
  AnomalyVolumeBucket,
  DomAnalysisSnapshot,
  InternalOrderBook,
  MarketAnomalyEvent,
  MarketAnomalyType,
  MarketTick,
  WelfordStats
} from "../types";

export const ANOMALY_DETECTOR_STORAGE_KEY = "agent:anomaly-detector:state";

const DEFAULT_PRICE_Z_THRESHOLD = 6;
const DEFAULT_VOLUME_Z_THRESHOLD = 5;
const DEFAULT_CANCEL_EXEC_RATIO_THRESHOLD = 8;
const DEFAULT_PRICE_WINDOW_MS = 60_000;
const DEFAULT_VOLUME_WINDOW_MS = 600_000;
const DEFAULT_TOP_OF_BOOK_WINDOW_MS = 600_000;
const BUCKET_INTERVAL_MS = 1_000;
const MIN_PRICE_SAMPLES = 10;
const MIN_VOLUME_BUCKETS = 10;
const MIN_CANCELLATIONS_FOR_RATIO = 5;
const SIZE_EPSILON = 0.00000001;

export interface AnomalyDetectorConfig {
  priceZThreshold?: number;
  volumeZThreshold?: number;
  cancelExecutionRatioThreshold?: number;
  priceWindowMs?: number;
  volumeWindowMs?: number;
  topOfBookWindowMs?: number;
}

export interface AnomalyDetectorInput {
  tick: MarketTick;
  book: InternalOrderBook;
  dom: DomAnalysisSnapshot;
  observedAt: string;
}

export interface AnomalyDetectionResult {
  state: AnomalyDetectorState;
  status: AnomalyStatus;
  anomalies: MarketAnomalyEvent[];
  emergencyPause: boolean;
}

export class AnomalyDetector {
  private readonly priceZThreshold: number;
  private readonly volumeZThreshold: number;
  private readonly cancelExecutionRatioThreshold: number;
  private readonly priceWindowMs: number;
  private readonly volumeWindowMs: number;
  private readonly topOfBookWindowMs: number;
  private state: AnomalyDetectorState;

  constructor(config: AnomalyDetectorConfig = {}) {
    this.priceZThreshold = positiveNumber(
      config.priceZThreshold,
      DEFAULT_PRICE_Z_THRESHOLD
    );
    this.volumeZThreshold = positiveNumber(
      config.volumeZThreshold,
      DEFAULT_VOLUME_Z_THRESHOLD
    );
    this.cancelExecutionRatioThreshold = positiveNumber(
      config.cancelExecutionRatioThreshold,
      DEFAULT_CANCEL_EXEC_RATIO_THRESHOLD
    );
    this.priceWindowMs = positiveInteger(
      config.priceWindowMs,
      DEFAULT_PRICE_WINDOW_MS
    );
    this.volumeWindowMs = positiveInteger(
      config.volumeWindowMs,
      DEFAULT_VOLUME_WINDOW_MS
    );
    this.topOfBookWindowMs = positiveInteger(
      config.topOfBookWindowMs,
      DEFAULT_TOP_OF_BOOK_WINDOW_MS
    );
    this.state = defaultAnomalyDetectorState(
      this.priceWindowMs,
      this.volumeWindowMs,
      this.topOfBookWindowMs
    );
  }

  hydrate(persisted: AnomalyDetectorState | null | undefined): void {
    if (!isAnomalyDetectorState(persisted)) {
      this.state = defaultAnomalyDetectorState(
        this.priceWindowMs,
        this.volumeWindowMs,
        this.topOfBookWindowMs
      );
      return;
    }

    this.state = {
      ...persisted,
      priceWindowMs: this.priceWindowMs,
      volumeWindowMs: this.volumeWindowMs,
      topOfBookWindowMs: this.topOfBookWindowMs,
      priceBuckets: sanitizeStatsBuckets(persisted.priceBuckets),
      volumeBuckets: sanitizeVolumeBuckets(persisted.volumeBuckets),
      topOfBookBuckets: sanitizeTopOfBookBuckets(persisted.topOfBookBuckets),
      lastTopOfBook: sanitizeTopOfBookSnapshot(persisted.lastTopOfBook),
      status: sanitizeAnomalyStatus(persisted.status),
      updatedAt:
        typeof persisted.updatedAt === "string"
          ? persisted.updatedAt
          : new Date().toISOString()
    };
  }

  evaluate(input: AnomalyDetectorInput): AnomalyDetectionResult {
    const observedMs = Date.parse(input.observedAt);

    if (!Number.isFinite(observedMs)) {
      throw new Error("INVALID_ANOMALY_TIMESTAMP");
    }

    const priceStatsBefore = mergeStatsBuckets(
      this.state.priceBuckets,
      observedMs - this.priceWindowMs
    );
    const priceZScore =
      input.book.midPrice !== null && priceStatsBefore.count >= MIN_PRICE_SAMPLES
        ? zScore(input.book.midPrice, priceStatsBefore)
        : null;
    const topOfBookEvent = classifyTopOfBookEvent(
      this.state.lastTopOfBook,
      input.book,
      input.tick
    );

    this.recordMidPrice(input.book.midPrice, observedMs, input.observedAt);
    const volumeZScore = this.recordVolume(input.tick.size, observedMs, input.observedAt);
    this.recordTopOfBookEvents(topOfBookEvent, observedMs, input.observedAt);
    this.prune(observedMs);

    const topStats = aggregateTopOfBookEvents(this.state.topOfBookBuckets);
    const cancellationToExecutionRatio =
      topStats.cancellations / Math.max(1, topStats.executions);
    const anomalyTypes: MarketAnomalyType[] = [];

    if (priceZScore !== null && priceZScore <= -this.priceZThreshold) {
      anomalyTypes.push("FLASH_CRASH");
    } else if (
      priceZScore !== null &&
      Math.abs(priceZScore) >= this.priceZThreshold
    ) {
      anomalyTypes.push("FAT_FINGER_TRADE");
    }

    if (volumeZScore !== null && volumeZScore >= this.volumeZThreshold) {
      anomalyTypes.push("VOLUME_SPIKE");
    }

    if (
      topStats.cancellations >= MIN_CANCELLATIONS_FOR_RATIO &&
      cancellationToExecutionRatio >= this.cancelExecutionRatioThreshold
    ) {
      anomalyTypes.push(
        input.dom.pulledWalls.length > 0
          ? "AGGRESSIVE_SPOOFING"
          : "TOP_OF_BOOK_CANCELLATION_SPIKE"
      );
    }

    const anomaly =
      anomalyTypes.length > 0
        ? this.createAnomalyEvent(
            anomalyTypes,
            input,
            priceZScore,
            volumeZScore,
            cancellationToExecutionRatio
          )
        : null;
    const status: AnomalyStatus = {
      status: anomaly ? "ANOMALY" : "CLEAR",
      priceZScore: nullableRound(priceZScore),
      volumeZScore: nullableRound(volumeZScore),
      cancellationToExecutionRatio: roundMetric(cancellationToExecutionRatio, 4),
      cancellationCount: topStats.cancellations,
      executionCount: topStats.executions,
      lastAnomaly: anomaly ?? this.state.status.lastAnomaly,
      updatedAt: input.observedAt
    };

    this.state = {
      ...this.state,
      lastTopOfBook: topOfBookSnapshot(input.book, input.observedAt),
      status,
      updatedAt: input.observedAt
    };

    return {
      state: this.snapshot(),
      status,
      anomalies: anomaly ? [anomaly] : [],
      emergencyPause: Boolean(anomaly)
    };
  }

  snapshot(): AnomalyDetectorState {
    return {
      ...this.state,
      priceBuckets: this.state.priceBuckets.map((bucket) => ({
        ...bucket,
        stats: { ...bucket.stats }
      })),
      volumeBuckets: this.state.volumeBuckets.map((bucket) => ({ ...bucket })),
      topOfBookBuckets: this.state.topOfBookBuckets.map((bucket) => ({ ...bucket })),
      lastTopOfBook: this.state.lastTopOfBook
        ? { ...this.state.lastTopOfBook }
        : null,
      status: {
        ...this.state.status,
        lastAnomaly: this.state.status.lastAnomaly
          ? { ...this.state.status.lastAnomaly, types: [...this.state.status.lastAnomaly.types] }
          : null
      }
    };
  }

  get status(): AnomalyStatus {
    return this.state.status;
  }

  private recordMidPrice(
    midPrice: number | null,
    observedMs: number,
    observedAt: string
  ): void {
    if (midPrice === null || !Number.isFinite(midPrice)) {
      return;
    }

    const bucket = getStatsBucket(this.state.priceBuckets, observedMs, observedAt);
    bucket.stats = welfordPush(bucket.stats, midPrice);
    bucket.updatedAt = observedAt;
  }

  private recordVolume(
    tickSize: number,
    observedMs: number,
    observedAt: string
  ): number | null {
    if (!Number.isFinite(tickSize) || tickSize <= 0) {
      return null;
    }

    const bucketStartMs = bucketStart(observedMs);
    const historyStats = volumeStats(
      this.state.volumeBuckets.filter((bucket) => bucket.bucketStartMs !== bucketStartMs)
    );
    const bucket = getVolumeBucket(this.state.volumeBuckets, observedMs, observedAt);

    bucket.volume = roundMetric(bucket.volume + tickSize, 8);
    bucket.updatedAt = observedAt;

    return historyStats.count >= MIN_VOLUME_BUCKETS
      ? zScore(bucket.volume, historyStats)
      : null;
  }

  private recordTopOfBookEvents(
    event: { cancellations: number; executions: number },
    observedMs: number,
    observedAt: string
  ): void {
    if (event.cancellations === 0 && event.executions === 0) {
      return;
    }

    const bucket = getTopOfBookBucket(this.state.topOfBookBuckets, observedMs, observedAt);
    bucket.cancellations += event.cancellations;
    bucket.executions += event.executions;
    bucket.updatedAt = observedAt;
  }

  private prune(observedMs: number): void {
    this.state.priceBuckets = this.state.priceBuckets.filter(
      (bucket) => bucket.bucketStartMs >= observedMs - this.priceWindowMs
    );
    this.state.volumeBuckets = this.state.volumeBuckets.filter(
      (bucket) => bucket.bucketStartMs >= observedMs - this.volumeWindowMs
    );
    this.state.topOfBookBuckets = this.state.topOfBookBuckets.filter(
      (bucket) => bucket.bucketStartMs >= observedMs - this.topOfBookWindowMs
    );
  }

  private createAnomalyEvent(
    types: MarketAnomalyType[],
    input: AnomalyDetectorInput,
    priceZScore: number | null,
    volumeZScore: number | null,
    cancellationToExecutionRatio: number
  ): MarketAnomalyEvent {
    const severity = types.includes("FLASH_CRASH") || types.includes("AGGRESSIVE_SPOOFING")
      ? "CRITICAL"
      : "WARN";

    return {
      anomalyId: crypto.randomUUID(),
      types,
      severity,
      instrumentCode: input.tick.instrumentCode,
      exchangeCode: input.tick.exchangeCode,
      sequence: input.tick.sequence,
      priceZScore: nullableRound(priceZScore),
      volumeZScore: nullableRound(volumeZScore),
      cancellationToExecutionRatio: roundMetric(cancellationToExecutionRatio, 4),
      reason: anomalyReason(types),
      triggeredPause: true,
      observedAt: input.observedAt
    };
  }
}

function defaultAnomalyDetectorState(
  priceWindowMs: number,
  volumeWindowMs: number,
  topOfBookWindowMs: number
): AnomalyDetectorState {
  return {
    schemaVersion: "anomaly-detector.v1",
    priceWindowMs,
    volumeWindowMs,
    topOfBookWindowMs,
    priceBuckets: [],
    volumeBuckets: [],
    topOfBookBuckets: [],
    lastTopOfBook: null,
    status: defaultAnomalyStatus(),
    updatedAt: new Date().toISOString()
  };
}

function defaultAnomalyStatus(): AnomalyStatus {
  return {
    status: "CLEAR",
    priceZScore: null,
    volumeZScore: null,
    cancellationToExecutionRatio: 0,
    cancellationCount: 0,
    executionCount: 0,
    lastAnomaly: null,
    updatedAt: null
  };
}

function isAnomalyDetectorState(value: unknown): value is AnomalyDetectorState {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as AnomalyDetectorState).schemaVersion === "anomaly-detector.v1" &&
    Array.isArray((value as AnomalyDetectorState).priceBuckets) &&
    Array.isArray((value as AnomalyDetectorState).volumeBuckets) &&
    Array.isArray((value as AnomalyDetectorState).topOfBookBuckets)
  );
}

function sanitizeAnomalyStatus(status: AnomalyStatus | undefined): AnomalyStatus {
  if (!status) {
    return defaultAnomalyStatus();
  }

  return {
    status: status.status === "ANOMALY" ? "ANOMALY" : "CLEAR",
    priceZScore: nullableFinite(status.priceZScore),
    volumeZScore: nullableFinite(status.volumeZScore),
    cancellationToExecutionRatio: finiteNumber(status.cancellationToExecutionRatio, 0),
    cancellationCount: Math.max(0, Math.floor(finiteNumber(status.cancellationCount, 0))),
    executionCount: Math.max(0, Math.floor(finiteNumber(status.executionCount, 0))),
    lastAnomaly: sanitizeAnomalyEvent(status.lastAnomaly),
    updatedAt: typeof status.updatedAt === "string" ? status.updatedAt : null
  };
}

function sanitizeAnomalyEvent(
  event: MarketAnomalyEvent | null | undefined
): MarketAnomalyEvent | null {
  if (!event || typeof event.anomalyId !== "string" || !Array.isArray(event.types)) {
    return null;
  }

  return {
    anomalyId: event.anomalyId,
    types: event.types.filter(isAnomalyType),
    severity: event.severity === "CRITICAL" ? "CRITICAL" : "WARN",
    instrumentCode: typeof event.instrumentCode === "string" ? event.instrumentCode : "unknown",
    exchangeCode: typeof event.exchangeCode === "string" ? event.exchangeCode : "unknown",
    sequence: Math.max(0, Math.floor(finiteNumber(event.sequence, 0))),
    priceZScore: nullableFinite(event.priceZScore),
    volumeZScore: nullableFinite(event.volumeZScore),
    cancellationToExecutionRatio: finiteNumber(event.cancellationToExecutionRatio, 0),
    reason: typeof event.reason === "string" ? event.reason : "ANOMALY_DETECTED",
    triggeredPause: Boolean(event.triggeredPause),
    observedAt: typeof event.observedAt === "string" ? event.observedAt : new Date().toISOString()
  };
}

function sanitizeStatsBuckets(buckets: AnomalyStatsBucket[]): AnomalyStatsBucket[] {
  return buckets
    .filter((bucket) => Number.isFinite(bucket.bucketStartMs))
    .map((bucket) => ({
      bucketStartMs: bucket.bucketStartMs,
      updatedAt: typeof bucket.updatedAt === "string" ? bucket.updatedAt : new Date().toISOString(),
      stats: sanitizeWelfordStats(bucket.stats)
    }));
}

function sanitizeVolumeBuckets(buckets: AnomalyVolumeBucket[]): AnomalyVolumeBucket[] {
  return buckets
    .filter((bucket) => Number.isFinite(bucket.bucketStartMs))
    .map((bucket) => ({
      bucketStartMs: bucket.bucketStartMs,
      updatedAt: typeof bucket.updatedAt === "string" ? bucket.updatedAt : new Date().toISOString(),
      volume: finiteNumber(bucket.volume, 0)
    }));
}

function sanitizeTopOfBookBuckets(
  buckets: AnomalyTopOfBookBucket[]
): AnomalyTopOfBookBucket[] {
  return buckets
    .filter((bucket) => Number.isFinite(bucket.bucketStartMs))
    .map((bucket) => ({
      bucketStartMs: bucket.bucketStartMs,
      updatedAt: typeof bucket.updatedAt === "string" ? bucket.updatedAt : new Date().toISOString(),
      cancellations: Math.max(0, Math.floor(finiteNumber(bucket.cancellations, 0))),
      executions: Math.max(0, Math.floor(finiteNumber(bucket.executions, 0)))
    }));
}

function sanitizeTopOfBookSnapshot(
  snapshot: AnomalyTopOfBookSnapshot | null | undefined
): AnomalyTopOfBookSnapshot | null {
  if (!snapshot) {
    return null;
  }

  return {
    bestBid: nullableFinite(snapshot.bestBid),
    bestAsk: nullableFinite(snapshot.bestAsk),
    bestBidSize: nullableFinite(snapshot.bestBidSize),
    bestAskSize: nullableFinite(snapshot.bestAskSize),
    sequence: typeof snapshot.sequence === "number" ? snapshot.sequence : null,
    updatedAt: typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : new Date().toISOString()
  };
}

function getStatsBucket(
  buckets: AnomalyStatsBucket[],
  observedMs: number,
  observedAt: string
): AnomalyStatsBucket {
  const start = bucketStart(observedMs);
  let bucket = buckets.find((candidate) => candidate.bucketStartMs === start);

  if (!bucket) {
    bucket = {
      bucketStartMs: start,
      updatedAt: observedAt,
      stats: emptyWelfordStats()
    };
    buckets.push(bucket);
  }

  return bucket;
}

function getVolumeBucket(
  buckets: AnomalyVolumeBucket[],
  observedMs: number,
  observedAt: string
): AnomalyVolumeBucket {
  const start = bucketStart(observedMs);
  let bucket = buckets.find((candidate) => candidate.bucketStartMs === start);

  if (!bucket) {
    bucket = {
      bucketStartMs: start,
      updatedAt: observedAt,
      volume: 0
    };
    buckets.push(bucket);
  }

  return bucket;
}

function getTopOfBookBucket(
  buckets: AnomalyTopOfBookBucket[],
  observedMs: number,
  observedAt: string
): AnomalyTopOfBookBucket {
  const start = bucketStart(observedMs);
  let bucket = buckets.find((candidate) => candidate.bucketStartMs === start);

  if (!bucket) {
    bucket = {
      bucketStartMs: start,
      updatedAt: observedAt,
      cancellations: 0,
      executions: 0
    };
    buckets.push(bucket);
  }

  return bucket;
}

function mergeStatsBuckets(
  buckets: AnomalyStatsBucket[],
  minimumBucketStartMs: number
): WelfordStats {
  return buckets
    .filter((bucket) => bucket.bucketStartMs >= minimumBucketStartMs)
    .reduce((merged, bucket) => mergeWelfordStats(merged, bucket.stats), emptyWelfordStats());
}

function volumeStats(buckets: AnomalyVolumeBucket[]): WelfordStats {
  return buckets.reduce(
    (stats, bucket) => welfordPush(stats, bucket.volume),
    emptyWelfordStats()
  );
}

function aggregateTopOfBookEvents(buckets: AnomalyTopOfBookBucket[]): {
  cancellations: number;
  executions: number;
} {
  return buckets.reduce(
    (totals, bucket) => ({
      cancellations: totals.cancellations + bucket.cancellations,
      executions: totals.executions + bucket.executions
    }),
    { cancellations: 0, executions: 0 }
  );
}

function classifyTopOfBookEvent(
  previous: AnomalyTopOfBookSnapshot | null,
  currentBook: InternalOrderBook,
  tick: MarketTick
): { cancellations: number; executions: number } {
  if (!previous || isBookSnapshotTick(tick)) {
    return { cancellations: 0, executions: 0 };
  }

  const current = topOfBookSnapshot(currentBook, tick.receivedAt);
  const askExecuted =
    previous.bestAsk !== null && tick.side === "buy" && tick.price >= previous.bestAsk;
  const bidExecuted =
    previous.bestBid !== null && tick.side === "sell" && tick.price <= previous.bestBid;
  const askCancelled =
    previous.bestAsk !== null &&
    !askExecuted &&
    (current.bestAsk === null ||
      current.bestAsk > previous.bestAsk ||
      (current.bestAsk === previous.bestAsk &&
        previous.bestAskSize !== null &&
        current.bestAskSize !== null &&
        current.bestAskSize + SIZE_EPSILON < previous.bestAskSize));
  const bidCancelled =
    previous.bestBid !== null &&
    !bidExecuted &&
    (current.bestBid === null ||
      current.bestBid < previous.bestBid ||
      (current.bestBid === previous.bestBid &&
        previous.bestBidSize !== null &&
        current.bestBidSize !== null &&
        current.bestBidSize + SIZE_EPSILON < previous.bestBidSize));

  return {
    cancellations: Number(askCancelled) + Number(bidCancelled),
    executions: Number(askExecuted) + Number(bidExecuted)
  };
}

function isBookSnapshotTick(tick: MarketTick): boolean {
  const eventType = typeof tick.raw?.eventType === "string"
    ? tick.raw.eventType.toLowerCase()
    : "";
  const nativeEventType = typeof tick.raw?.nativeEventType === "string"
    ? tick.raw.nativeEventType.toLowerCase()
    : "";

  return (
    eventType.includes("book-snapshot") ||
    nativeEventType.includes("l2book") ||
    tick.raw?.commodity === "ORDER_BOOK"
  );
}

function topOfBookSnapshot(
  book: InternalOrderBook,
  observedAt: string
): AnomalyTopOfBookSnapshot {
  return {
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    bestBidSize: book.bids[0]?.size ?? null,
    bestAskSize: book.asks[0]?.size ?? null,
    sequence: book.sequence,
    updatedAt: observedAt
  };
}

function emptyWelfordStats(): WelfordStats {
  return { count: 0, mean: 0, m2: 0 };
}

function sanitizeWelfordStats(stats: WelfordStats | undefined): WelfordStats {
  if (!stats) {
    return emptyWelfordStats();
  }

  return {
    count: Math.max(0, Math.floor(finiteNumber(stats.count, 0))),
    mean: finiteNumber(stats.mean, 0),
    m2: finiteNumber(stats.m2, 0)
  };
}

function welfordPush(stats: WelfordStats, value: number): WelfordStats {
  const nextCount = stats.count + 1;
  const delta = value - stats.mean;
  const nextMean = stats.mean + delta / nextCount;
  const delta2 = value - nextMean;

  return {
    count: nextCount,
    mean: nextMean,
    m2: stats.m2 + delta * delta2
  };
}

function mergeWelfordStats(left: WelfordStats, right: WelfordStats): WelfordStats {
  if (left.count === 0) {
    return { ...right };
  }

  if (right.count === 0) {
    return { ...left };
  }

  const count = left.count + right.count;
  const delta = right.mean - left.mean;

  return {
    count,
    mean: left.mean + (delta * right.count) / count,
    m2: left.m2 + right.m2 + (delta * delta * left.count * right.count) / count
  };
}

function zScore(value: number, stats: WelfordStats): number | null {
  if (stats.count < 2) {
    return null;
  }

  const variance = stats.m2 / Math.max(1, stats.count - 1);
  const sigma = Math.sqrt(Math.max(0, variance));

  if (sigma <= 0) {
    return null;
  }

  return (value - stats.mean) / sigma;
}

function anomalyReason(types: MarketAnomalyType[]): string {
  return `Detected ${types.join(", ")}; emergency pause activated.`;
}

function isAnomalyType(value: string): value is MarketAnomalyType {
  return [
    "FLASH_CRASH",
    "FAT_FINGER_TRADE",
    "VOLUME_SPIKE",
    "AGGRESSIVE_SPOOFING",
    "TOP_OF_BOOK_CANCELLATION_SPIKE"
  ].includes(value);
}

function bucketStart(observedMs: number): number {
  return Math.floor(observedMs / BUCKET_INTERVAL_MS) * BUCKET_INTERVAL_MS;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableRound(value: number | null): number | null {
  return value === null ? null : roundMetric(value, 6);
}

function roundMetric(value: number, decimals = 8): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
