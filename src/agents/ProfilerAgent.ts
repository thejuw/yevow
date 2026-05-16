import type {
  AgentSignal,
  GlobalRiskConfig,
  JsonRecord,
  LiquidationCascadeCluster,
  LiquidationHeatmapState,
  LiquidityWall,
  MarketTick,
  PriceLevel,
  ProfilerState,
  ProfilerVolumeBucket,
  ToxicityPressureSide,
  ToxicityState
} from "../types";

export const PROFILER_STATE_STORAGE_KEY = "agent:profiler:state";

const DEFAULT_BUCKET_SIZE = 10;
const DEFAULT_ROLLING_WINDOW = 50;
const DEFAULT_ALERT_THRESHOLD = 0.7;
const DEFAULT_WHALE_Z_THRESHOLD = 5;
const DEFAULT_QUOTE_HIBERNATE_MS = 3_000;
const DEFAULT_DIRECTIONAL_DECAY = 0.3;
const DEFAULT_OBI_DEPTH = 5;
const DEFAULT_NORMAL_THRESHOLD = 0.65;
const DEFAULT_TOXIC_THRESHOLD = 0.75;
const DEFAULT_CRITICAL_THRESHOLD = 0.85;
const DEFAULT_CRITICAL_OBI = 0.8;
const DEFAULT_CONTESTED_SPREAD_MULTIPLIER = 1.5;
const DEFAULT_TOXIC_SPREAD_MULTIPLIER = 3;
const DEFAULT_CRITICAL_HALT_MS = 60_000;
const VOLUME_EPSILON = 0.00000001;

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
  contestedSpreadMultiplier?: number;
  toxicSpreadMultiplier?: number;
  criticalHaltMs?: number;
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
}

export interface ProfilerEvaluation {
  processed: boolean;
  skippedReason: string | null;
  closedBuckets: number;
  toxicityScore: number;
  state: ProfilerState;
  signal: AgentSignal | null;
}

interface AmVpinConsensus {
  state: ToxicityState;
  pressureSide: ToxicityPressureSide;
  spreadMultiplier: number;
  reservationShiftBps: number;
  haltMs: number | null;
  structuralConsensus: boolean;
}

export class ProfilerAgent {
  private bucketSize: number;
  private rollingWindow: number;
  private alertThreshold: number;
  private directionalDecay: number;
  private obiDepth: number;
  private normalThreshold: number;
  private toxicThreshold: number;
  private criticalThreshold: number;
  private criticalObi: number;
  private contestedSpreadMultiplier: number;
  private toxicSpreadMultiplier: number;
  private criticalHaltMs: number;
  private readonly whalePrintZThreshold: number;
  private readonly quoteHibernateMs: number;
  private buyVolumes: Float32Array;
  private sellVolumes: Float32Array;
  private signedImbalances: Float32Array;
  private directionalImbalances: Float32Array;
  private obiValues: Float32Array;
  private ringIndex = 0;
  private ringCount = 0;
  private activeBuyVolume = 0;
  private activeSellVolume = 0;
  private activeTotalVolume = 0;
  private previousDirectionalImbalance = 0;
  private state: ProfilerState;

  constructor(config: ProfilerAgentConfig = {}) {
    this.bucketSize = positiveNumber(config.bucketSize, DEFAULT_BUCKET_SIZE);
    this.rollingWindow = positiveInteger(config.rollingWindow, DEFAULT_ROLLING_WINDOW);
    this.alertThreshold = clamp(
      positiveNumber(config.alertThreshold, DEFAULT_ALERT_THRESHOLD),
      0,
      1
    );
    this.directionalDecay = clamp(
      positiveNumber(config.directionalDecay, DEFAULT_DIRECTIONAL_DECAY),
      0,
      0.999
    );
    this.obiDepth = boundedInteger(config.obiDepth, DEFAULT_OBI_DEPTH, 1, 50);
    this.normalThreshold = clamp(
      positiveNumber(config.normalThreshold, DEFAULT_NORMAL_THRESHOLD),
      0,
      1
    );
    this.toxicThreshold = clamp(
      positiveNumber(config.toxicThreshold, DEFAULT_TOXIC_THRESHOLD),
      0,
      1
    );
    this.criticalThreshold = clamp(
      positiveNumber(config.criticalThreshold, DEFAULT_CRITICAL_THRESHOLD),
      0,
      1
    );
    this.criticalObi = clamp(
      positiveNumber(config.criticalObi, DEFAULT_CRITICAL_OBI),
      0,
      1
    );
    this.contestedSpreadMultiplier = positiveNumber(
      config.contestedSpreadMultiplier,
      DEFAULT_CONTESTED_SPREAD_MULTIPLIER
    );
    this.toxicSpreadMultiplier = positiveNumber(
      config.toxicSpreadMultiplier,
      DEFAULT_TOXIC_SPREAD_MULTIPLIER
    );
    this.criticalHaltMs = positiveInteger(
      config.criticalHaltMs,
      DEFAULT_CRITICAL_HALT_MS
    );
    this.whalePrintZThreshold = positiveNumber(
      config.whalePrintZThreshold,
      DEFAULT_WHALE_Z_THRESHOLD
    );
    this.quoteHibernateMs = positiveInteger(
      config.quoteHibernateMs,
      DEFAULT_QUOTE_HIBERNATE_MS
    );
    this.buyVolumes = new Float32Array(this.rollingWindow);
    this.sellVolumes = new Float32Array(this.rollingWindow);
    this.signedImbalances = new Float32Array(this.rollingWindow);
    this.directionalImbalances = new Float32Array(this.rollingWindow);
    this.obiValues = new Float32Array(this.rollingWindow);
    this.state = defaultProfilerState(
      this.bucketSize,
      this.rollingWindow,
      this.alertThreshold,
      this.directionalDecay,
      this.obiDepth,
      this.normalThreshold,
      this.toxicThreshold,
      this.criticalThreshold,
      this.criticalObi
    );
  }

  configure(config: GlobalRiskConfig): void {
    const nextBucketSize = positiveNumber(
      config.AM_VPIN_BUCKET_VOLUME,
      this.bucketSize
    );
    const nextRollingWindow = boundedInteger(
      config.AM_VPIN_ROLLING_WINDOW,
      this.rollingWindow,
      5,
      500
    );

    this.alertThreshold = clamp(config.AM_VPIN_NORMAL_THRESHOLD, 0, 1);
    this.directionalDecay = clamp(config.AM_VPIN_DIRECTIONAL_DECAY, 0, 0.999);
    this.obiDepth = boundedInteger(config.AM_VPIN_OBI_DEPTH, this.obiDepth, 1, 50);
    this.normalThreshold = clamp(config.AM_VPIN_NORMAL_THRESHOLD, 0, 1);
    this.toxicThreshold = clamp(config.AM_VPIN_TOXIC_THRESHOLD, 0, 1);
    this.criticalThreshold = clamp(config.AM_VPIN_CRITICAL_THRESHOLD, 0, 1);
    this.criticalObi = clamp(config.AM_VPIN_CRITICAL_OBI, 0, 1);
    this.contestedSpreadMultiplier = positiveNumber(
      config.AM_VPIN_CONTESTED_SPREAD_MULTIPLIER,
      this.contestedSpreadMultiplier
    );
    this.toxicSpreadMultiplier = positiveNumber(
      config.AM_VPIN_TOXIC_SPREAD_MULTIPLIER,
      this.toxicSpreadMultiplier
    );
    this.criticalHaltMs = positiveInteger(
      config.AM_VPIN_QUOTE_HALT_MS,
      this.criticalHaltMs
    );

    if (nextBucketSize !== this.bucketSize || nextRollingWindow !== this.rollingWindow) {
      this.bucketSize = nextBucketSize;
      this.rollingWindow = nextRollingWindow;
      this.allocateRingBuffers();
      this.resetActiveBucket();
    }

    this.syncStateSnapshot(this.state.updatedAt, false);
  }

  hydrate(persisted: ProfilerState | null | undefined): void {
    if (!isProfilerState(persisted)) {
      this.state = defaultProfilerState(
        this.bucketSize,
        this.rollingWindow,
        this.alertThreshold,
        this.directionalDecay,
        this.obiDepth,
        this.normalThreshold,
        this.toxicThreshold,
        this.criticalThreshold,
        this.criticalObi
      );
      this.allocateRingBuffers();
      this.resetActiveBucket();
      return;
    }

    this.loadRingFromSnapshot(persisted);
    this.state = {
      ...persisted,
      bucketSize: this.bucketSize,
      rollingWindow: this.rollingWindow,
      alertThreshold: this.alertThreshold,
      toxicityScore: clamp(roundMetric(persisted.toxicityScore), 0, 1),
      amVpinScore: clamp(roundMetric(persisted.amVpinScore ?? persisted.toxicityScore), 0, 1),
      obi: typeof persisted.obi === "number" ? persisted.obi : null,
      obiDepth: this.obiDepth,
      directionalDecay: this.directionalDecay,
      latestSignedImbalance:
        typeof persisted.latestSignedImbalance === "number"
          ? persisted.latestSignedImbalance
          : 0,
      latestDirectionalImbalance:
        typeof persisted.latestDirectionalImbalance === "number"
          ? persisted.latestDirectionalImbalance
          : this.previousDirectionalImbalance,
      toxicityState: normalizeToxicityState(persisted.toxicityState),
      pressureSide: normalizePressureSide(persisted.pressureSide),
      spreadMultiplier: positiveNumber(persisted.spreadMultiplier, 1),
      reservationShiftBps: nonNegativeNumber(persisted.reservationShiftBps),
      quoteHaltUntil:
        typeof persisted.quoteHaltUntil === "string" ? persisted.quoteHaltUntil : null,
      amVpinBucketCompletions: Math.max(
        0,
        Math.floor(persisted.amVpinBucketCompletions ?? persisted.totalBucketsClosed)
      ),
      amVpinMean: nonNegativeNumber(persisted.amVpinMean),
      amVpinM2: nonNegativeNumber(persisted.amVpinM2),
      amVpinVariance: nonNegativeNumber(persisted.amVpinVariance),
      amVpinRing: this.exportRingSnapshot(),
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
      distanceToCascadePct:
        typeof persisted.distanceToCascadePct === "number"
          ? persisted.distanceToCascadePct
          : null,
      cascadeShieldUntil:
        typeof persisted.cascadeShieldUntil === "string"
          ? persisted.cascadeShieldUntil
          : null,
      cascadeClusterId:
        typeof persisted.cascadeClusterId === "string"
          ? persisted.cascadeClusterId
          : null,
      cascadeSide:
        persisted.cascadeSide === "LONG" || persisted.cascadeSide === "SHORT"
          ? persisted.cascadeSide
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
    const cascadeSignal = this.maybeCreateCascadeShieldSignal(tick, context);
    const spoofingSignal = this.maybeCreateSpoofingSignal(tick, context);

    if (!isOrderFlowTick(tick)) {
      const signal = cascadeSignal ?? spoofingSignal;

      if (signal) {
        if (cascadeSignal) {
          this.state.toxicityScore = 1;
        }
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
    let amVpinSignal: AgentSignal | null = null;
    const tradeSign = aggressorSign(tick);
    const whaleSignal = this.detectWhalePrint(tick, context);

    while (remainingVolume > VOLUME_EPSILON && safetyCounter < 10_000) {
      safetyCounter += 1;
      const capacity = Math.max(0, this.bucketSize - this.activeTotalVolume);
      const allocation = Math.min(remainingVolume, capacity);

      this.applySignedVolume(allocation, tradeSign);
      remainingVolume = roundMetric(remainingVolume - allocation);

      if (this.activeTotalVolume + VOLUME_EPSILON >= this.bucketSize) {
        const signal = this.closeAmVpinBucket(tick, context);
        closedBuckets += 1;
        if (signal) {
          amVpinSignal = signal;
        }
      }
    }

    this.state.lastProcessedSequence = tick.sequence;
    this.state.updatedAt = context.observedAt;
    this.syncActiveBucketState(tick.instrumentCode, context.observedAt);

    if (cascadeSignal) {
      this.state.toxicityScore = 1;
    }

    const criticalAmVpinSignal =
      amVpinSignal?.featureVector.signalType === "AM_VPIN_CRITICAL"
        ? amVpinSignal
        : null;
    const signal =
      cascadeSignal ??
      criticalAmVpinSignal ??
      whaleSignal ??
      spoofingSignal ??
      amVpinSignal;

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

  private allocateRingBuffers(): void {
    this.buyVolumes = new Float32Array(this.rollingWindow);
    this.sellVolumes = new Float32Array(this.rollingWindow);
    this.signedImbalances = new Float32Array(this.rollingWindow);
    this.directionalImbalances = new Float32Array(this.rollingWindow);
    this.obiValues = new Float32Array(this.rollingWindow);
    this.ringIndex = 0;
    this.ringCount = 0;
    this.previousDirectionalImbalance = 0;
  }

  private resetActiveBucket(): void {
    this.activeBuyVolume = 0;
    this.activeSellVolume = 0;
    this.activeTotalVolume = 0;
  }

  private applySignedVolume(allocation: number, sign: -1 | 0 | 1): void {
    if (allocation <= 0) {
      return;
    }

    if (sign > 0) {
      this.activeBuyVolume = roundMetric(this.activeBuyVolume + allocation);
    } else if (sign < 0) {
      this.activeSellVolume = roundMetric(this.activeSellVolume + allocation);
    } else {
      const half = allocation / 2;
      this.activeBuyVolume = roundMetric(this.activeBuyVolume + half);
      this.activeSellVolume = roundMetric(this.activeSellVolume + half);
    }

    this.activeTotalVolume = roundMetric(
      this.activeBuyVolume + this.activeSellVolume
    );
  }

  private closeAmVpinBucket(
    tick: MarketTick,
    context: ProfilerContext
  ): AgentSignal | null {
    const signedImbalance = roundMetric(this.activeBuyVolume - this.activeSellVolume);
    const directionalImbalance = roundMetric(
      signedImbalance + this.directionalDecay * this.previousDirectionalImbalance
    );
    const obi = calculateObi(context.orderBookBids, context.orderBookAsks, this.obiDepth);
    const amVpin = this.calculateAmVpinAfterWrite(directionalImbalance);
    const consensus = classifyToxicity({
      amVpin,
      obi,
      directionalImbalance,
      normalThreshold: this.normalThreshold,
      toxicThreshold: this.toxicThreshold,
      criticalThreshold: this.criticalThreshold,
      criticalObi: this.criticalObi,
      contestedSpreadMultiplier: this.contestedSpreadMultiplier,
      toxicSpreadMultiplier: this.toxicSpreadMultiplier,
      criticalHaltMs: this.criticalHaltMs
    });

    this.buyVolumes[this.ringIndex] = this.activeBuyVolume;
    this.sellVolumes[this.ringIndex] = this.activeSellVolume;
    this.signedImbalances[this.ringIndex] = signedImbalance;
    this.directionalImbalances[this.ringIndex] = directionalImbalance;
    this.obiValues[this.ringIndex] = obi ?? 0;
    this.ringIndex = (this.ringIndex + 1) % this.rollingWindow;
    this.ringCount = Math.min(this.rollingWindow, this.ringCount + 1);
    this.previousDirectionalImbalance = directionalImbalance;
    this.state.totalBucketsClosed += 1;
    this.state.amVpinBucketCompletions += 1;
    this.updateAmVpinVariance(amVpin);
    this.resetActiveBucket();
    this.state.toxicityScore = amVpin;
    this.state.amVpinScore = amVpin;
    this.state.obi = obi;
    this.state.obiDepth = this.obiDepth;
    this.state.directionalDecay = this.directionalDecay;
    this.state.latestSignedImbalance = signedImbalance;
    this.state.latestDirectionalImbalance = directionalImbalance;
    this.state.toxicityState = consensus.state;
    this.state.pressureSide = consensus.pressureSide;
    this.state.spreadMultiplier = consensus.spreadMultiplier;
    this.state.reservationShiftBps = consensus.reservationShiftBps;
    this.state.quoteHaltUntil = consensus.haltMs
      ? new Date(Date.parse(context.observedAt) + consensus.haltMs).toISOString()
      : null;
    this.state.alertThreshold = this.normalThreshold;
    this.state.updatedAt = context.observedAt;
    this.syncStateSnapshot(context.observedAt, true, tick.instrumentCode);

    return consensus.state === "NORMAL"
      ? null
      : this.createAmVpinSignal(tick, context, consensus);
  }

  private calculateAmVpinAfterWrite(nextDirectionalImbalance: number): number {
    let sumAbs = Math.abs(nextDirectionalImbalance);
    let count = 1;
    const previousSampleCount =
      this.ringCount >= this.rollingWindow ? this.rollingWindow - 1 : this.ringCount;

    for (let offset = 1; offset <= previousSampleCount; offset += 1) {
      const index = (this.ringIndex - offset + this.rollingWindow) % this.rollingWindow;
      sumAbs += Math.abs(this.directionalImbalances[index]);
      count += 1;
    }

    return clamp(roundMetric(sumAbs / (count * this.bucketSize), 8), 0, 1);
  }

  private updateAmVpinVariance(amVpin: number): void {
    const count = this.state.amVpinBucketCompletions;
    const previousMean = this.state.amVpinMean;
    const delta = amVpin - previousMean;
    const mean = previousMean + delta / Math.max(1, count);
    const delta2 = amVpin - mean;

    this.state.amVpinMean = mean;
    this.state.amVpinM2 += delta * delta2;
    this.state.amVpinVariance =
      count > 1 ? this.state.amVpinM2 / (count - 1) : 0;
  }

  private createAmVpinSignal(
    tick: MarketTick,
    context: ProfilerContext,
    consensus: AmVpinConsensus
  ): AgentSignal {
    const isCritical = consensus.state === "CRITICAL";
    const suspendedUntil = isCritical
      ? this.state.quoteHaltUntil ??
        new Date(Date.parse(context.observedAt) + this.criticalHaltMs).toISOString()
      : null;

    return {
      signalId: crypto.randomUUID(),
      traceId: `${context.engineId}:profiler:am-vpin:${tick.instrumentCode}:${this.state.totalBucketsClosed}`,
      sourceAgent: "PROFILER",
      targetAgent: "CROUPIER",
      instrumentCode: tick.instrumentCode,
      action: isCritical ? "PAUSE" : "REDUCE",
      confidence: clamp(this.state.amVpinScore, 0, 1),
      horizonMs: isCritical ? this.criticalHaltMs : 5_000,
      expectedValue: -this.state.amVpinScore,
      maxSlippageBps: consensus.state === "CONTESTED" ? 15 : isCritical ? 100 : 50,
      rationale:
        `AM-VPIN ${this.state.amVpinScore.toFixed(4)} with OBI ` +
        `${this.state.obi === null ? "n/a" : this.state.obi.toFixed(4)} classified ${consensus.state}.`,
      featureVector: compactJsonRecord({
        signalType: `AM_VPIN_${consensus.state}`,
        am_vpin: this.state.amVpinScore,
        obi: this.state.obi,
        obiDepth: this.obiDepth,
        signedImbalance: this.state.latestSignedImbalance,
        directionalImbalance: this.state.latestDirectionalImbalance,
        directionalDecay: this.directionalDecay,
        pressureSide: consensus.pressureSide,
        spreadMultiplier: consensus.spreadMultiplier,
        reservationShiftBps: consensus.reservationShiftBps,
        toxicity_state: consensus.state,
        bucketSize: this.bucketSize,
        rollingWindow: this.rollingWindow,
        completedBuckets: this.state.totalBucketsClosed,
        suspendedUntil
      }),
      riskContext: compactJsonRecord({
        recommendation: isCritical
          ? "CANCEL_ALL_QUOTES_AND_HALT_60S"
          : consensus.state === "TOXIC"
            ? "WIDEN_3X_AND_SHIFT_RESERVATION_AWAY_FROM_PRESSURE"
            : "MAINTAIN_QUOTES_WITH_1_5X_SPREAD",
        structuralConsensus: consensus.structuralConsensus,
        normalThreshold: this.normalThreshold,
        toxicThreshold: this.toxicThreshold,
        criticalThreshold: this.criticalThreshold,
        criticalObi: this.criticalObi,
        quoteHaltUntil: suspendedUntil
      }),
      createdAt: context.observedAt
    };
  }

  private syncActiveBucketState(instrumentCode: string, observedAt: string): void {
    this.state.activeBucket =
      this.activeTotalVolume > 0
        ? {
            bucketId: `am-vpin:${instrumentCode}:${this.state.totalBucketsClosed + 1}`,
            instrumentCode,
            startedAt: this.state.activeBucket?.startedAt ?? observedAt,
            closedAt: null,
            buyVolume: this.activeBuyVolume,
            sellVolume: this.activeSellVolume,
            totalVolume: this.activeTotalVolume,
            imbalance: roundMetric(this.activeBuyVolume - this.activeSellVolume)
          }
        : null;
  }

  private syncStateSnapshot(
    observedAt: string,
    includeBuckets: boolean,
    instrumentCode = this.state.activeBucket?.instrumentCode ?? "unknown"
  ): void {
    this.state.bucketSize = this.bucketSize;
    this.state.rollingWindow = this.rollingWindow;
    this.state.alertThreshold = this.normalThreshold;
    this.state.directionalDecay = this.directionalDecay;
    this.state.obiDepth = this.obiDepth;
    this.state.amVpinRing = this.exportRingSnapshot();
    this.state.buckets = includeBuckets
      ? this.exportProfilerBuckets(observedAt, instrumentCode)
      : this.state.buckets;
  }

  private exportRingSnapshot(): ProfilerState["amVpinRing"] {
    return {
      buyVolumes: typedArrayToArray(this.buyVolumes, this.ringCount, this.ringIndex),
      sellVolumes: typedArrayToArray(this.sellVolumes, this.ringCount, this.ringIndex),
      signedImbalances: typedArrayToArray(this.signedImbalances, this.ringCount, this.ringIndex),
      directionalImbalances: typedArrayToArray(
        this.directionalImbalances,
        this.ringCount,
        this.ringIndex
      ),
      obiValues: typedArrayToArray(this.obiValues, this.ringCount, this.ringIndex)
    };
  }

  private exportProfilerBuckets(
    observedAt: string,
    instrumentCode: string
  ): ProfilerVolumeBucket[] {
    const buckets = new Array<ProfilerVolumeBucket>(this.ringCount);
    let outputIndex = 0;

    for (let offset = this.ringCount; offset > 0; offset -= 1) {
      const index = (this.ringIndex - offset + this.rollingWindow) % this.rollingWindow;
      buckets[outputIndex] = {
        bucketId: `am-vpin:${this.state.totalBucketsClosed - offset + 1}`,
        instrumentCode,
        startedAt: observedAt,
        closedAt: observedAt,
        buyVolume: roundMetric(this.buyVolumes[index]),
        sellVolume: roundMetric(this.sellVolumes[index]),
        totalVolume: roundMetric(this.buyVolumes[index] + this.sellVolumes[index]),
        imbalance: roundMetric(this.signedImbalances[index]),
        directionalImbalance: roundMetric(this.directionalImbalances[index]),
        obi: roundMetric(this.obiValues[index]),
        amVpin: this.state.amVpinScore,
        toxicityState: this.state.toxicityState
      };
      outputIndex += 1;
    }

    return buckets;
  }

  private loadRingFromSnapshot(persisted: ProfilerState): void {
    this.allocateRingBuffers();
    const ring = persisted.amVpinRing;
    const buy = Array.isArray(ring?.buyVolumes) ? ring.buyVolumes : [];
    const sell = Array.isArray(ring?.sellVolumes) ? ring.sellVolumes : [];
    const signed = Array.isArray(ring?.signedImbalances) ? ring.signedImbalances : [];
    const directional = Array.isArray(ring?.directionalImbalances)
      ? ring.directionalImbalances
      : [];
    const obi = Array.isArray(ring?.obiValues) ? ring.obiValues : [];
    const count = Math.min(this.rollingWindow, buy.length, sell.length);

    for (let index = 0; index < count; index += 1) {
      this.buyVolumes[index] = finiteNumber(buy[index], 0);
      this.sellVolumes[index] = finiteNumber(sell[index], 0);
      this.signedImbalances[index] = finiteNumber(
        signed[index],
        this.buyVolumes[index] - this.sellVolumes[index]
      );
      this.directionalImbalances[index] = finiteNumber(
        directional[index],
        this.signedImbalances[index]
      );
      this.obiValues[index] = finiteNumber(obi[index], 0);
    }

    this.ringCount = count;
    this.ringIndex = count % this.rollingWindow;
    this.previousDirectionalImbalance =
      count > 0 ? this.directionalImbalances[(count - 1) % this.rollingWindow] : 0;
    this.activeBuyVolume = persisted.activeBucket?.buyVolume ?? 0;
    this.activeSellVolume = persisted.activeBucket?.sellVolume ?? 0;
    this.activeTotalVolume = persisted.activeBucket?.totalVolume ?? 0;
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

  private maybeCreateCascadeShieldSignal(
    tick: MarketTick,
    context: ProfilerContext
  ): AgentSignal | null {
    const cluster = nearestCascadeCluster(
      context.liquidationHeatmap,
      tick.instrumentCode,
      context.midPrice
    );

    this.state.distanceToCascadePct = cluster?.distanceFromMidPct ?? null;
    this.state.cascadeClusterId = cluster?.clusterId ?? null;
    this.state.cascadeSide = cluster?.side ?? null;

    if (!cluster?.isCascadeRisk) {
      return null;
    }

    const suspendedUntil = new Date(
      Date.parse(context.observedAt) + this.quoteHibernateMs
    ).toISOString();
    this.state.cascadeShieldUntil = suspendedUntil;

    return {
      signalId: crypto.randomUUID(),
      traceId: `${context.engineId}:profiler:cascade:${cluster.clusterId}:${tick.sequence}`,
      sourceAgent: "PROFILER",
      targetAgent: "CROUPIER",
      instrumentCode: tick.instrumentCode,
      action: "REDUCE",
      confidence: 1,
      horizonMs: this.quoteHibernateMs,
      expectedValue: -1,
      maxSlippageBps: 100,
      rationale:
        `Distance_To_Cascade ${formatPct(cluster.distanceFromMidPct)} near ${cluster.side} liquidation cluster ` +
        `${formatUsd(cluster.estimatedNotionalUsd)}; force VPIN to maximum toxicity and pull vulnerable resting flow.`,
      featureVector: compactJsonRecord({
        signalType: "CASCADE_SHIELD",
        distanceToCascadePct: cluster.distanceFromMidPct,
        distanceToCascadeBps: cluster.distanceFromMidBps,
        clusterId: cluster.clusterId,
        liquidationSide: cluster.side,
        forcedFlowSide: cluster.forcedFlowSide,
        estimatedNotionalUsd: cluster.estimatedNotionalUsd,
        thresholdUsd: context.liquidationHeatmap?.clusterThresholdUsd ?? null,
        cascadeDistancePct: context.liquidationHeatmap?.cascadeDistancePct ?? null,
        midPrice: context.midPrice,
        suspendedUntil
      }),
      riskContext: compactJsonRecord({
        recommendation: "PULL_OPPOSING_QUOTES_AND_ONLY_REST_BOUNDARY_LIQUIDITY",
        toxicityScore: 1,
        opposingSide:
          cluster.forcedFlowSide === "BUY"
            ? "ASK"
            : cluster.forcedFlowSide === "SELL"
              ? "BID"
              : "UNKNOWN"
      }),
      createdAt: context.observedAt
    };
  }

  detectWhalePrint(tick: MarketTick, context: ProfilerContext): AgentSignal | null {
    if (!isOrderFlowTick(tick) || tick.size <= 0) {
      return null;
    }

    const count = this.state.tradeSizeCount;
    const mean = this.state.tradeSizeMean;
    const variance = count > 1 ? this.state.tradeSizeM2 / (count - 1) : 0;
    const std = Math.sqrt(Math.max(0, variance));
    this.observeTradeSize(tick.size, context.observedAt);

    if (
      count < 30 ||
      std <= 0 ||
      tick.size <= mean + this.whalePrintZThreshold * std
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
        tradeSizeMean: mean,
        tradeSizeStd: std,
        tradeSizeEstimator: "WELFORD_ONLINE",
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
    this.state.tradeSizeCount += 1;
    const delta = size - this.state.tradeSizeMean;
    this.state.tradeSizeMean += delta / this.state.tradeSizeCount;
    this.state.tradeSizeM2 += delta * (size - this.state.tradeSizeMean);
  }
}

function defaultProfilerState(
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

function aggressorSign(tick: MarketTick): -1 | 0 | 1 {
  if (typeof tick.raw?.isBuy === "boolean") {
    return tick.raw.isBuy ? 1 : -1;
  }

  const rawSide =
    typeof tick.raw?.aggressorSide === "string"
      ? tick.raw.aggressorSide.toUpperCase()
      : null;

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

function calculateObi(
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

function classifyToxicity(input: {
  amVpin: number;
  obi: number | null;
  directionalImbalance: number;
  normalThreshold: number;
  toxicThreshold: number;
  criticalThreshold: number;
  criticalObi: number;
  contestedSpreadMultiplier: number;
  toxicSpreadMultiplier: number;
  criticalHaltMs: number;
}): AmVpinConsensus {
  const pressureSign = signOf(input.directionalImbalance);
  const obiSign = signOf(input.obi ?? 0);
  const pressureSide: ToxicityPressureSide =
    pressureSign > 0 ? "BUY" : pressureSign < 0 ? "SELL" : "NEUTRAL";
  const structuralConsensus =
    pressureSign !== 0 && obiSign !== 0 && pressureSign === obiSign;

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

  if (input.amVpin >= input.criticalThreshold && Math.abs(input.obi ?? 0) >= input.criticalObi) {
    return {
      state: "CRITICAL",
      pressureSide,
      spreadMultiplier: input.toxicSpreadMultiplier,
      reservationShiftBps: pressureSign === 0 ? 0 : 12,
      haltMs: input.criticalHaltMs,
      structuralConsensus
    };
  }

  if (input.amVpin >= input.toxicThreshold && structuralConsensus) {
    return {
      state: "TOXIC",
      pressureSide,
      spreadMultiplier: input.toxicSpreadMultiplier,
      reservationShiftBps: 8,
      haltMs: null,
      structuralConsensus
    };
  }

  return {
    state: "CONTESTED",
    pressureSide,
    spreadMultiplier: input.contestedSpreadMultiplier,
    reservationShiftBps: 0,
    haltMs: null,
    structuralConsensus
  };
}

function signOf(value: number): -1 | 0 | 1 {
  if (value > 0.00000001) {
    return 1;
  }

  if (value < -0.00000001) {
    return -1;
  }

  return 0;
}

function typedArrayToArray(
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

function normalizeToxicityState(value: unknown): ToxicityState {
  return value === "CONTESTED" || value === "TOXIC" || value === "CRITICAL"
    ? value
    : "NORMAL";
}

function normalizePressureSide(value: unknown): ToxicityPressureSide {
  return value === "BUY" || value === "SELL" ? value : "NEUTRAL";
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

function nearestCascadeCluster(
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

  return [...candidates].sort(
    (left, right) =>
      Math.abs(left.centerPrice - midPrice) - Math.abs(right.centerPrice - midPrice)
  )[0] ?? null;
}

function formatPct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(3)}%`;
}

function formatUsd(value: number): string {
  if (value >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(2)}B`;
  }
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  return `$${value.toFixed(0)}`;
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

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function roundMetric(value: number, decimals = 8): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
