import type {
  AbsorptionAnalyzerConfig,
  AbsorptionConfirmed,
  AbsorptionCriteria,
  AbsorptionObservation,
  CascadeDirection,
  CascadeEvent
} from "./types";

const MINUTE_MS = 60_000;

export const defaultAbsorptionAnalyzerConfig: AbsorptionAnalyzerConfig = {
  absorptionWindowMs: 3 * 60 * 1_000,
  priceBandBps: 30,
  minHoldSeconds: 60,
  oiStabilityBps: 5,
  maxActiveCascades: 24
};

interface ActiveAbsorption {
  cascade: CascadeEvent;
  startedAtMs: number;
  holdStartedAtMs: number | null;
  observations: number;
  firstCvd: number | null;
  latestCvd: number | null;
  minCvd: number;
  maxCvd: number;
  takerBuckets: Map<number, number>;
  openInterestValues: { observedAtMs: number; value: number }[];
  confirmed: boolean;
}

export class AbsorptionAnalyzer {
  private readonly active = new Map<string, ActiveAbsorption>();

  constructor(private config: AbsorptionAnalyzerConfig = defaultAbsorptionAnalyzerConfig) {}

  configure(config: AbsorptionAnalyzerConfig): void {
    this.config = config;
  }

  trackCascade(cascade: CascadeEvent): void {
    const startedAtMs = Date.parse(cascade.detectedAt);
    if (!Number.isFinite(startedAtMs)) {
      return;
    }

    this.active.set(cascade.cascadeId, {
      cascade,
      startedAtMs,
      holdStartedAtMs: null,
      observations: 0,
      firstCvd: null,
      latestCvd: null,
      minCvd: Number.POSITIVE_INFINITY,
      maxCvd: Number.NEGATIVE_INFINITY,
      takerBuckets: new Map(),
      openInterestValues: [],
      confirmed: false
    });

    this.prune(startedAtMs);
  }

  observe(observation: AbsorptionObservation): AbsorptionConfirmed | null {
    const observedAtMs = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedAtMs)) {
      return null;
    }

    let confirmed: AbsorptionConfirmed | null = null;

    for (const active of this.active.values()) {
      if (
        active.confirmed ||
        active.cascade.instrumentCode !== observation.instrumentCode.toLowerCase()
      ) {
        continue;
      }

      if (observedAtMs - active.startedAtMs > this.config.absorptionWindowMs) {
        continue;
      }

      this.updateActive(active, observation, observedAtMs);
      const criteria = this.criteria(active, observation, observedAtMs);
      if (criteria.priceHeld && this.hasAnyExhaustion(criteria)) {
        active.confirmed = true;
        confirmed = {
          schemaVersion: "cascade.absorption-confirmed.v1",
          cascadeId: active.cascade.cascadeId,
          instrumentCode: active.cascade.instrumentCode,
          direction: active.cascade.direction,
          confirmedAt: observation.observedAt,
          elapsedMs: Math.max(0, observedAtMs - active.startedAtMs),
          price: observation.price,
          criteria,
          observations: active.observations
        };
        break;
      }
    }

    this.prune(observedAtMs);
    return confirmed;
  }

  activeCascadeIds(): string[] {
    return [...this.active.values()]
      .filter((active) => !active.confirmed)
      .map((active) => active.cascade.cascadeId);
  }

  private updateActive(
    active: ActiveAbsorption,
    observation: AbsorptionObservation,
    observedAtMs: number
  ): void {
    active.observations += 1;
    active.firstCvd ??= observation.cumulativeVolumeDelta;
    active.latestCvd = observation.cumulativeVolumeDelta;
    active.minCvd = Math.min(active.minCvd, observation.cumulativeVolumeDelta);
    active.maxCvd = Math.max(active.maxCvd, observation.cumulativeVolumeDelta);

    const forcedTakerVolume = forcedSideVolume(active.cascade.direction, observation);
    const minute = Math.floor(observedAtMs / MINUTE_MS) * MINUTE_MS;
    active.takerBuckets.set(minute, (active.takerBuckets.get(minute) ?? 0) + forcedTakerVolume);

    if (observation.openInterest !== null && Number.isFinite(observation.openInterest)) {
      active.openInterestValues.push({
        observedAtMs,
        value: observation.openInterest
      });
      if (active.openInterestValues.length > 12) {
        active.openInterestValues.shift();
      }
    }

    if (isHoldingCascadeExtreme(active.cascade, observation.price, this.config.priceBandBps)) {
      active.holdStartedAtMs ??= observedAtMs;
    } else {
      active.holdStartedAtMs = null;
    }
  }

  private criteria(
    active: ActiveAbsorption,
    observation: AbsorptionObservation,
    observedAtMs: number
  ): AbsorptionCriteria {
    const holdMs =
      active.holdStartedAtMs === null ? 0 : Math.max(0, observedAtMs - active.holdStartedAtMs);

    return {
      priceHeld: holdMs >= this.config.minHoldSeconds * 1_000,
      takerExhaustion: takerVolumeTrendingDown(active),
      cvdReversal: cvdReversed(active.cascade.direction, active),
      openInterestStabilized: openInterestStable(active, this.config.oiStabilityBps)
    };
  }

  private hasAnyExhaustion(criteria: AbsorptionCriteria): boolean {
    return criteria.takerExhaustion || criteria.cvdReversal || criteria.openInterestStabilized;
  }

  private prune(nowMs: number): void {
    for (const [cascadeId, active] of this.active) {
      if (
        active.confirmed ||
        nowMs - active.startedAtMs > this.config.absorptionWindowMs ||
        this.active.size > this.config.maxActiveCascades
      ) {
        this.active.delete(cascadeId);
      }
    }
  }
}

function forcedSideVolume(direction: CascadeDirection, observation: AbsorptionObservation): number {
  return direction === "LONG_LIQUIDATION"
    ? Math.max(0, observation.takerSellVolume)
    : Math.max(0, observation.takerBuyVolume);
}

function takerVolumeTrendingDown(active: ActiveAbsorption): boolean {
  const buckets = [...active.takerBuckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1]);

  if (buckets.length < 3) {
    return false;
  }

  const third = buckets[buckets.length - 3];
  const second = buckets[buckets.length - 2];
  const first = buckets[buckets.length - 1];
  return third > second && second > first;
}

function cvdReversed(direction: CascadeDirection, active: ActiveAbsorption): boolean {
  if (active.firstCvd === null || active.latestCvd === null) {
    return false;
  }

  if (direction === "LONG_LIQUIDATION") {
    return active.firstCvd < 0 && active.latestCvd >= 0;
  }

  return active.firstCvd > 0 && active.latestCvd <= 0;
}

function openInterestStable(active: ActiveAbsorption, stabilityBps: number): boolean {
  if (active.openInterestValues.length < 3) {
    return false;
  }

  const recent = active.openInterestValues.slice(-3);
  const values = recent.map((item) => item.value).filter((value) => value > 0);
  if (values.length < 3) {
    return false;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const midpoint = (min + max) / 2;
  return midpoint > 0 && ((max - min) / midpoint) * 10_000 <= stabilityBps;
}

function isHoldingCascadeExtreme(
  cascade: CascadeEvent,
  price: number,
  priceBandBps: number
): boolean {
  if (!Number.isFinite(price) || price <= 0 || cascade.priceAtPeak <= 0) {
    return false;
  }

  const band = cascade.priceAtPeak * (priceBandBps / 10_000);
  return Math.abs(price - cascade.priceAtPeak) <= band;
}
