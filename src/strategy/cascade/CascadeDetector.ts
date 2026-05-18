import type {
  CascadeDetectorConfig,
  CascadeDetectorContext,
  CascadeDetectorState,
  CascadeDirection,
  CascadeEvent,
  LiquidationEvent
} from "./types";

const ONE_HOUR_MS = 60 * 60 * 1_000;
const LARGE_Z_SCORE = 1_000_000;

export const defaultCascadeDetectorConfig: CascadeDetectorConfig = {
  windowMs: 5 * 60 * 1_000,
  notionalThresholdUsd: 50_000_000,
  zScoreThreshold: 3,
  lookbackHours: 168,
  directionalPct: 0.7,
  minPriceMoveAtr: 1.5,
  minBaselineWindows: 12,
  minCascadeSeparationMs: 30 * 60 * 1_000,
  maxEventsPerInstrument: 10_000
};

export class CascadeDetector {
  private readonly eventsByInstrument = new Map<string, LiquidationEvent[]>();
  private readonly lastCascadeAtByInstrument = new Map<string, string>();

  constructor(private config: CascadeDetectorConfig = defaultCascadeDetectorConfig) {}

  configure(config: CascadeDetectorConfig): void {
    this.config = config;
  }

  observe(event: LiquidationEvent, context: CascadeDetectorContext): CascadeEvent | null {
    const observedAt = context.observedAt ?? event.observedAt;
    const nowMs = Date.parse(observedAt);
    if (!Number.isFinite(nowMs)) {
      return null;
    }

    const instrumentCode = event.instrumentCode.toLowerCase();
    const events = this.appendEvent(instrumentCode, event, nowMs);
    const lastCascadeAt = this.lastCascadeAtByInstrument.get(instrumentCode);
    if (lastCascadeAt && nowMs - Date.parse(lastCascadeAt) < this.config.minCascadeSeparationMs) {
      return null;
    }

    const windowStartMs = nowMs - this.config.windowMs;
    const currentEvents = events
      .filter((item) => {
        const itemMs = Date.parse(item.observedAt);
        return itemMs >= windowStartMs && itemMs <= nowMs;
      })
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));

    if (currentEvents.length === 0) {
      return null;
    }

    const aggregate = aggregateWindow(currentEvents);
    if (aggregate.totalNotional < this.config.notionalThresholdUsd) {
      return null;
    }

    if (aggregate.directionalPct < this.config.directionalPct) {
      return null;
    }

    const zScore = this.zScore(events, windowStartMs, nowMs, aggregate.totalNotional);
    if (zScore < this.config.zScoreThreshold) {
      return null;
    }

    const priceImpact = calculatePriceImpact(
      currentEvents,
      aggregate.direction,
      context.priceAtStart,
      context.atr1h
    );
    if (!priceImpact || priceImpact.priceMoveAtr < this.config.minPriceMoveAtr) {
      return null;
    }

    const cascade: CascadeEvent = {
      schemaVersion: "cascade.event.v1",
      cascadeId: cascadeId(instrumentCode, aggregate.direction, nowMs, aggregate.totalNotional),
      instrumentCode,
      direction: aggregate.direction,
      detectedAt: new Date(nowMs).toISOString(),
      windowStartAt: new Date(windowStartMs).toISOString(),
      windowEndAt: new Date(nowMs).toISOString(),
      liquidationNotional: round(aggregate.totalNotional, 2),
      liquidationCount: currentEvents.length,
      zScore: round(zScore, 4),
      priceAtStart: priceImpact.priceAtStart,
      priceAtPeak: priceImpact.priceAtPeak,
      priceMoveAtr: round(priceImpact.priceMoveAtr, 4),
      directionalPct: round(aggregate.directionalPct, 4),
      rawEvents: currentEvents.map(cloneEvent)
    };

    this.lastCascadeAtByInstrument.set(instrumentCode, cascade.detectedAt);
    return cascade;
  }

  hydrate(state: CascadeDetectorState): void {
    if (state.schemaVersion !== "cascade.detector.v1") {
      return;
    }

    this.eventsByInstrument.clear();
    this.lastCascadeAtByInstrument.clear();

    for (const event of state.events) {
      const key = event.instrumentCode.toLowerCase();
      const events = this.eventsByInstrument.get(key) ?? [];
      events.push(cloneEvent(event));
      this.eventsByInstrument.set(key, events);
    }

    for (const [instrumentCode, detectedAt] of Object.entries(state.lastCascadeAtByInstrument)) {
      this.lastCascadeAtByInstrument.set(instrumentCode.toLowerCase(), detectedAt);
    }
  }

  serialize(): CascadeDetectorState {
    return {
      schemaVersion: "cascade.detector.v1",
      events: [...this.eventsByInstrument.values()].flat().map(cloneEvent),
      lastCascadeAtByInstrument: Object.fromEntries(this.lastCascadeAtByInstrument)
    };
  }

  private appendEvent(
    instrumentCode: string,
    event: LiquidationEvent,
    nowMs: number
  ): LiquidationEvent[] {
    const lookbackMs = this.config.lookbackHours * ONE_HOUR_MS + this.config.windowMs;
    const cutoffMs = nowMs - lookbackMs;
    const current = this.eventsByInstrument.get(instrumentCode) ?? [];
    current.push(cloneEvent(event));

    const pruned = current
      .filter((item) => Date.parse(item.observedAt) >= cutoffMs)
      .slice(-this.config.maxEventsPerInstrument);
    this.eventsByInstrument.set(instrumentCode, pruned);
    return pruned;
  }

  private zScore(
    events: LiquidationEvent[],
    windowStartMs: number,
    nowMs: number,
    currentNotional: number
  ): number {
    const lookbackStartMs = windowStartMs - this.config.lookbackHours * ONE_HOUR_MS;
    const historicalWindowCount = Math.floor(
      (windowStartMs - lookbackStartMs) / this.config.windowMs
    );

    if (historicalWindowCount < this.config.minBaselineWindows) {
      return 0;
    }

    const buckets = new Float64Array(historicalWindowCount);
    for (const event of events) {
      const eventMs = Date.parse(event.observedAt);
      if (eventMs < lookbackStartMs || eventMs >= windowStartMs || eventMs > nowMs) {
        continue;
      }
      const index = Math.floor((eventMs - lookbackStartMs) / this.config.windowMs);
      if (index >= 0 && index < buckets.length) {
        buckets[index] += event.notionalUsd;
      }
    }

    let mean = 0;
    let m2 = 0;
    for (let index = 0; index < buckets.length; index += 1) {
      const count = index + 1;
      const delta = buckets[index] - mean;
      mean += delta / count;
      m2 += delta * (buckets[index] - mean);
    }

    const variance = buckets.length > 1 ? m2 / (buckets.length - 1) : 0;
    const stdDev = Math.sqrt(Math.max(0, variance));
    if (stdDev === 0) {
      return currentNotional > mean ? LARGE_Z_SCORE : 0;
    }

    return (currentNotional - mean) / stdDev;
  }
}

function aggregateWindow(events: LiquidationEvent[]): {
  totalNotional: number;
  direction: CascadeDirection;
  directionalPct: number;
} {
  let longNotional = 0;
  let shortNotional = 0;

  for (const event of events) {
    if (event.side === "LONG") {
      longNotional += event.notionalUsd;
    } else if (event.side === "SHORT") {
      shortNotional += event.notionalUsd;
    }
  }

  const totalNotional = longNotional + shortNotional;
  const direction: CascadeDirection =
    longNotional >= shortNotional ? "LONG_LIQUIDATION" : "SHORT_LIQUIDATION";
  const dominant = Math.max(longNotional, shortNotional);

  return {
    totalNotional,
    direction,
    directionalPct: totalNotional > 0 ? dominant / totalNotional : 0
  };
}

function calculatePriceImpact(
  events: LiquidationEvent[],
  direction: CascadeDirection,
  configuredPriceAtStart: number | null | undefined,
  atr1h: number | null
): { priceAtStart: number; priceAtPeak: number; priceMoveAtr: number } | null {
  if (atr1h === null || !Number.isFinite(atr1h) || atr1h <= 0) {
    return null;
  }

  const firstPrice = events.find((event) => Number.isFinite(event.price) && event.price > 0)?.price;
  const priceAtStart =
    configuredPriceAtStart !== null &&
    configuredPriceAtStart !== undefined &&
    Number.isFinite(configuredPriceAtStart) &&
    configuredPriceAtStart > 0
      ? configuredPriceAtStart
      : firstPrice;

  if (!priceAtStart) {
    return null;
  }

  let priceAtPeak = priceAtStart;
  for (const event of events) {
    if (!Number.isFinite(event.price) || event.price <= 0) {
      continue;
    }

    if (direction === "LONG_LIQUIDATION") {
      priceAtPeak = Math.min(priceAtPeak, event.price);
    } else {
      priceAtPeak = Math.max(priceAtPeak, event.price);
    }
  }

  const directionalMove =
    direction === "LONG_LIQUIDATION" ? priceAtStart - priceAtPeak : priceAtPeak - priceAtStart;
  return {
    priceAtStart: round(priceAtStart, 8),
    priceAtPeak: round(priceAtPeak, 8),
    priceMoveAtr: Math.max(0, directionalMove) / atr1h
  };
}

function cascadeId(
  instrumentCode: string,
  direction: CascadeDirection,
  nowMs: number,
  notionalUsd: number
): string {
  return `cascade:${instrumentCode}:${direction}:${Math.floor(nowMs / 1_000)}:${Math.round(
    notionalUsd
  )}`;
}

function cloneEvent(event: LiquidationEvent): LiquidationEvent {
  return {
    ...event,
    raw: { ...event.raw }
  };
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
