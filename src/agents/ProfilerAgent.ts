import type {
  AgentSignal,
  GlobalRiskConfig,
  JsonRecord,
  LiquidationCascadeCluster,
  MarketTick,
  ProfilerState,
  ProfilerVolumeBucket
} from "../types";
import { classifyLearnedToxicity } from "../engine/ToxicityClassifier";
import {
  DEFAULT_ALERT_THRESHOLD,
  DEFAULT_BUCKET_SIZE,
  DEFAULT_CONTESTED_SPREAD_MULTIPLIER,
  DEFAULT_CRITICAL_HALT_MS,
  DEFAULT_CRITICAL_OBI,
  DEFAULT_CRITICAL_THRESHOLD,
  DEFAULT_DIRECTIONAL_DECAY,
  DEFAULT_NORMAL_THRESHOLD,
  DEFAULT_OBI_DEPTH,
  DEFAULT_QUOTE_HIBERNATE_MS,
  DEFAULT_ROLLING_WINDOW,
  DEFAULT_TOXIC_SPREAD_MULTIPLIER,
  DEFAULT_TOXIC_THRESHOLD,
  DEFAULT_WHALE_Z_THRESHOLD,
  VOLUME_EPSILON,
  type ProfilerAgentConfig,
  type ProfilerContext,
  type ProfilerEvaluation
} from "./ProfilerAgentTypes";
import {
  aggressorSign,
  boundedInteger,
  calculateObi,
  classifyToxicity,
  clamp,
  compactJsonRecord,
  defaultProfilerState,
  finiteNumber,
  formatPct,
  formatUsd,
  isOrderFlowTick,
  isProfilerState,
  nearestCascadeCluster,
  nonNegativeNumber,
  normalizePressureSide,
  normalizeToxicityState,
  positiveInteger,
  positiveNumber,
  pruneTradeSizeWindow,
  rollingTradeSizeStats,
  roundMetric,
  sanitizeBucket,
  sanitizeTradeSizeWindow,
  signOf,
  typedArrayToArray,
  type AmVpinConsensus
} from "./ProfilerAgentUtils";

export const PROFILER_STATE_STORAGE_KEY = "agent:profiler:state";
export const PROFILER_STATE_STORAGE_PREFIX = `${PROFILER_STATE_STORAGE_KEY}:`;

export type {
  ProfilerAgentConfig,
  ProfilerContext,
  ProfilerEvaluation
} from "./ProfilerAgentTypes";

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
  private criticalHaltMs: number;
  private contestedSpreadMultiplier: number;
  private toxicSpreadMultiplier: number;
  private toxicityClassifierEnabled: boolean;
  private toxicityClassifierThreshold: number;
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
    this.criticalObi = clamp(positiveNumber(config.criticalObi, DEFAULT_CRITICAL_OBI), 0, 1);
    this.criticalHaltMs = positiveInteger(config.criticalHaltMs, DEFAULT_CRITICAL_HALT_MS);
    this.contestedSpreadMultiplier = positiveNumber(
      config.contestedSpreadMultiplier,
      DEFAULT_CONTESTED_SPREAD_MULTIPLIER
    );
    this.toxicSpreadMultiplier = positiveNumber(
      config.toxicSpreadMultiplier,
      DEFAULT_TOXIC_SPREAD_MULTIPLIER
    );
    this.toxicityClassifierEnabled = config.toxicityClassifierEnabled !== false;
    this.toxicityClassifierThreshold = clamp(
      positiveNumber(config.toxicityClassifierThreshold, 0.72),
      0,
      1
    );
    this.whalePrintZThreshold = positiveNumber(
      config.whalePrintZThreshold,
      DEFAULT_WHALE_Z_THRESHOLD
    );
    this.quoteHibernateMs = positiveInteger(config.quoteHibernateMs, DEFAULT_QUOTE_HIBERNATE_MS);
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
    const nextBucketSize = positiveNumber(config.AM_VPIN_BUCKET_VOLUME, this.bucketSize);
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
    this.criticalHaltMs = positiveInteger(config.AM_VPIN_QUOTE_HALT_MS, this.criticalHaltMs);
    this.contestedSpreadMultiplier = clamp(
      positiveNumber(config.AM_VPIN_CONTESTED_SPREAD_MULTIPLIER, this.contestedSpreadMultiplier),
      1,
      10
    );
    this.toxicSpreadMultiplier = clamp(
      positiveNumber(config.AM_VPIN_TOXIC_SPREAD_MULTIPLIER, this.toxicSpreadMultiplier),
      1,
      10
    );
    this.toxicityClassifierEnabled = config.TOXICITY_CLASSIFIER_ENABLED;
    this.toxicityClassifierThreshold = clamp(config.TOXICITY_CLASSIFIER_THRESHOLD, 0, 1);

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
        typeof persisted.latestSignedImbalance === "number" ? persisted.latestSignedImbalance : 0,
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
      lastSignalId: typeof persisted.lastSignalId === "string" ? persisted.lastSignalId : null,
      lastAlertBucketCount: Math.max(0, Math.floor(persisted.lastAlertBucketCount)),
      lastSpoofingWallId:
        typeof persisted.lastSpoofingWallId === "string" ? persisted.lastSpoofingWallId : null,
      distanceToCascadePct:
        typeof persisted.distanceToCascadePct === "number" ? persisted.distanceToCascadePct : null,
      cascadeShieldUntil:
        typeof persisted.cascadeShieldUntil === "string" ? persisted.cascadeShieldUntil : null,
      cascadeClusterId:
        typeof persisted.cascadeClusterId === "string" ? persisted.cascadeClusterId : null,
      cascadeSide:
        persisted.cascadeSide === "LONG" || persisted.cascadeSide === "SHORT"
          ? persisted.cascadeSide
          : null,
      tradeSizeCount: Math.max(0, Math.floor(persisted.tradeSizeCount ?? 0)),
      tradeSizeMean: positiveNumber(persisted.tradeSizeMean, 0),
      tradeSizeM2: Math.max(0, Number(persisted.tradeSizeM2 ?? 0)),
      tradeSizeWindow: sanitizeTradeSizeWindow(persisted.tradeSizeWindow),
      quoteSuspendedUntil:
        typeof persisted.quoteSuspendedUntil === "string" ? persisted.quoteSuspendedUntil : null
    };
  }

  processTick(tick: MarketTick, context: ProfilerContext): ProfilerEvaluation {
    this.expireCriticalHaltIfNeeded(context.observedAt);
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
      amVpinSignal?.featureVector.signalType === "AM_VPIN_CRITICAL" ? amVpinSignal : null;
    const signal =
      cascadeSignal ?? criticalAmVpinSignal ?? whaleSignal ?? spoofingSignal ?? amVpinSignal;

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
      activeBucket: this.state.activeBucket ? { ...this.state.activeBucket } : null,
      buckets: this.state.buckets.map((bucket) => ({ ...bucket })),
      tradeSizeWindow: this.state.tradeSizeWindow.map((item) => ({ ...item }))
    };
  }

  get toxicityScore(): number {
    return this.state.toxicityScore;
  }

  diagnostics(): {
    bucketSize: number;
    rollingWindow: number;
    ringCount: number;
    ringIndex: number;
    activeTotalVolume: number;
    allocatedBuffers: number;
    allocatedFloat32Slots: number;
    allocatedBytes: number;
    flatMemory: boolean;
  } {
    const allocatedBuffers = 5;
    const allocatedFloat32Slots =
      this.buyVolumes.length +
      this.sellVolumes.length +
      this.signedImbalances.length +
      this.directionalImbalances.length +
      this.obiValues.length;

    return {
      bucketSize: this.bucketSize,
      rollingWindow: this.rollingWindow,
      ringCount: this.ringCount,
      ringIndex: this.ringIndex,
      activeTotalVolume: this.activeTotalVolume,
      allocatedBuffers,
      allocatedFloat32Slots,
      allocatedBytes: allocatedFloat32Slots * Float32Array.BYTES_PER_ELEMENT,
      flatMemory:
        this.buyVolumes.length === this.rollingWindow &&
        this.sellVolumes.length === this.rollingWindow &&
        this.signedImbalances.length === this.rollingWindow &&
        this.directionalImbalances.length === this.rollingWindow &&
        this.obiValues.length === this.rollingWindow
    };
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

  private expireCriticalHaltIfNeeded(observedAt: string): void {
    if (this.state.toxicityState !== "CRITICAL" || !this.state.quoteHaltUntil) {
      return;
    }

    if (Date.parse(this.state.quoteHaltUntil) > Date.parse(observedAt)) {
      return;
    }

    this.state.toxicityState =
      this.state.amVpinScore >= this.toxicThreshold ? "TOXIC" : "CONTESTED";
    this.state.quoteHaltUntil = null;
    this.state.spreadMultiplier = 1;
    this.state.reservationShiftBps = 0;
    this.state.updatedAt = observedAt;
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

    this.activeTotalVolume = roundMetric(this.activeBuyVolume + this.activeSellVolume);
  }

  private closeAmVpinBucket(tick: MarketTick, context: ProfilerContext): AgentSignal | null {
    const signedImbalance = roundMetric(this.activeBuyVolume - this.activeSellVolume);
    const directionalImbalance = roundMetric(
      signedImbalance + this.directionalDecay * this.previousDirectionalImbalance
    );
    const obi = calculateObi(context.orderBookBids, context.orderBookAsks, this.obiDepth);
    const amVpin = this.calculateAmVpinAfterWrite(directionalImbalance);
    const consensus = this.applyClassifierOverlay(
      classifyToxicity({
        amVpin,
        obi,
        directionalImbalance,
        normalThreshold: this.normalThreshold,
        toxicThreshold: this.toxicThreshold,
        criticalThreshold: this.criticalThreshold,
        criticalObi: this.criticalObi,
        criticalHaltMs: this.criticalHaltMs,
        contestedSpreadMultiplier: this.contestedSpreadMultiplier,
        toxicSpreadMultiplier: this.toxicSpreadMultiplier
      }),
      {
        amVpin,
        obi,
        directionalImbalance,
        spreadBps: context.spreadBps,
        jumpDetected: context.jumpDetected === true
      }
    );

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

    return consensus.state === "NORMAL" ? null : this.createAmVpinSignal(tick, context, consensus);
  }

  private applyClassifierOverlay(
    consensus: AmVpinConsensus,
    input: {
      amVpin: number;
      obi: number | null;
      directionalImbalance: number;
      spreadBps: number | null;
      jumpDetected: boolean;
    }
  ): AmVpinConsensus {
    if (!this.toxicityClassifierEnabled) {
      return consensus;
    }

    const classifier = classifyLearnedToxicity(
      {
        profiler: {
          ...this.state,
          amVpinScore: input.amVpin,
          toxicityScore: input.amVpin,
          obi: input.obi,
          latestDirectionalImbalance: input.directionalImbalance,
          amVpinBucketCompletions: this.state.amVpinBucketCompletions + 1
        },
        spreadBps: input.spreadBps,
        jumpDetected: input.jumpDetected
      },
      this.toxicityClassifierThreshold
    );

    if (!classifier.triggered || consensus.state === "CRITICAL") {
      return {
        ...consensus,
        classifierProbability: classifier.probability,
        classifierTriggered: classifier.triggered
      };
    }

    const structuralAgreement =
      input.obi !== null &&
      Math.sign(input.obi) === Math.sign(input.directionalImbalance) &&
      Math.abs(input.obi) >= this.criticalObi * 0.75;

    if (
      structuralAgreement &&
      classifier.probability >= Math.max(0.85, this.toxicityClassifierThreshold)
    ) {
      return {
        state: "CRITICAL",
        pressureSide: input.directionalImbalance >= 0 ? "BUY" : "SELL",
        spreadMultiplier: this.toxicSpreadMultiplier,
        reservationShiftBps: 15,
        haltMs: this.criticalHaltMs,
        structuralConsensus: true,
        classifierProbability: classifier.probability,
        classifierTriggered: true
      };
    }

    return {
      state: consensus.state === "NORMAL" ? "CONTESTED" : consensus.state,
      pressureSide: consensus.pressureSide,
      spreadMultiplier: Math.max(consensus.spreadMultiplier, this.contestedSpreadMultiplier),
      reservationShiftBps: consensus.reservationShiftBps,
      haltMs: consensus.haltMs,
      structuralConsensus: consensus.structuralConsensus,
      classifierProbability: classifier.probability,
      classifierTriggered: true
    };
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
    this.state.amVpinVariance = count > 1 ? this.state.amVpinM2 / (count - 1) : 0;
  }

  private createAmVpinSignal(
    tick: MarketTick,
    context: ProfilerContext,
    consensus: AmVpinConsensus
  ): AgentSignal {
    const isCritical = consensus.haltMs !== null;
    const suspendedUntil = isCritical
      ? (this.state.quoteHaltUntil ??
        new Date(Date.parse(context.observedAt) + this.criticalHaltMs).toISOString())
      : null;

    return {
      signalId: crypto.randomUUID(),
      traceId: `${context.engineId}:profiler:am-vpin:${tick.instrumentCode}:${this.state.totalBucketsClosed}`,
      sourceAgent: "PROFILER",
      targetAgent: "CROUPIER",
      instrumentCode: tick.instrumentCode,
      action: "PAUSE",
      confidence: clamp(this.state.amVpinScore, 0, 1),
      horizonMs: this.criticalHaltMs,
      expectedValue: -this.state.amVpinScore,
      maxSlippageBps: 100,
      rationale:
        `AM-VPIN ${this.state.amVpinScore.toFixed(4)} with OBI ` +
        `${this.state.obi === null ? "n/a" : this.state.obi.toFixed(4)} breached binary toxicity; evacuate resting quotes.`,
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
        classifierProbability: consensus.classifierProbability ?? null,
        classifierTriggered: consensus.classifierTriggered ?? false,
        toxicity_state: consensus.state,
        bucketSize: this.bucketSize,
        rollingWindow: this.rollingWindow,
        completedBuckets: this.state.totalBucketsClosed,
        suspendedUntil
      }),
      riskContext: compactJsonRecord({
        recommendation: "CANCEL_ALL_QUOTES_AND_HALT_60S",
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

  private ensureActiveBucket(instrumentCode: string, observedAt: string): ProfilerVolumeBucket {
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

    if (count < 30 || std <= 0 || tick.size <= mean + this.whalePrintZThreshold * std) {
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
      rationale:
        "Whale print exceeded one-hour trade-size baseline; suspend quotes until price discovery stabilizes.",
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
