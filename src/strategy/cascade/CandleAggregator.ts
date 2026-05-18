import type { MarketTick } from "../../types";
import type { Candle, CandleAggregator, CandleAggregatorState, Timeframe } from "./types";

export const CASCADE_TIMEFRAMES: readonly Timeframe[] = ["1m", "5m", "15m", "1h", "4h"];

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000
};

const DEFAULT_RECENT_CLOSED_LIMIT = 1_000;

export class CascadeCandleAggregator implements CandleAggregator {
  private readonly activeCandles = new Map<string, Candle>();
  private readonly recentClosedCandles = new Map<string, Candle[]>();
  private updatedAt: string | null = null;

  constructor(
    private readonly timeframes: readonly Timeframe[] = CASCADE_TIMEFRAMES,
    private readonly recentClosedLimit = DEFAULT_RECENT_CLOSED_LIMIT
  ) {}

  ingestTick(tick: MarketTick): Candle[] {
    if (!Number.isFinite(tick.price) || tick.price <= 0) {
      return [];
    }

    const observedAtMs = Date.parse(tick.synchronizedExchangeTimestamp ?? tick.exchangeTimestamp);
    if (!Number.isFinite(observedAtMs)) {
      return [];
    }

    const closed: Candle[] = [];
    for (const timeframe of this.timeframes) {
      const nextClosed = this.ingestTimeframe(tick, timeframe, observedAtMs);
      if (nextClosed) {
        closed.push(nextClosed);
      }
    }

    this.updatedAt = new Date(observedAtMs).toISOString();
    return closed;
  }

  snapshot(instrumentCode: string, timeframe: Timeframe, count: number): Candle[] {
    const key = candleKey(instrumentCode, timeframe);
    const closed = this.recentClosedCandles.get(key) ?? [];
    const active = this.activeCandles.get(key);
    const combined = active ? [...closed, active] : closed;

    return combined.slice(-Math.max(0, Math.floor(count))).map(cloneCandle);
  }

  hydrate(state: CandleAggregatorState): void {
    this.activeCandles.clear();
    this.recentClosedCandles.clear();

    for (const candle of state.activeCandles) {
      if (!isValidCandle(candle) || candle.isClosed) {
        continue;
      }
      this.activeCandles.set(
        candleKey(candle.instrumentCode, candle.timeframe),
        cloneCandle(candle)
      );
    }

    for (const candle of state.recentClosedCandles) {
      if (!isValidCandle(candle) || !candle.isClosed) {
        continue;
      }
      this.appendClosedCandle(cloneCandle(candle));
    }

    this.updatedAt = state.updatedAt;
  }

  serialize(): CandleAggregatorState {
    const recentClosedCandles = [...this.recentClosedCandles.values()]
      .flat()
      .sort((left, right) => Date.parse(left.openedAt) - Date.parse(right.openedAt));

    return {
      schemaVersion: "cascade.candle-aggregator.v1",
      activeCandles: [...this.activeCandles.values()].map(cloneCandle),
      recentClosedCandles,
      updatedAt: this.updatedAt
    };
  }

  private ingestTimeframe(
    tick: MarketTick,
    timeframe: Timeframe,
    observedAtMs: number
  ): Candle | null {
    const durationMs = TIMEFRAME_MS[timeframe];
    const openedAtMs = Math.floor(observedAtMs / durationMs) * durationMs;
    const key = candleKey(tick.instrumentCode, timeframe);
    const active = this.activeCandles.get(key);

    if (!active) {
      this.activeCandles.set(key, createCandle(tick, timeframe, openedAtMs, durationMs));
      return null;
    }

    if (Date.parse(active.openedAt) === openedAtMs) {
      mergeTickIntoCandle(active, tick);
      return null;
    }

    const closed = { ...active, isClosed: true };
    this.appendClosedCandle(closed);
    this.activeCandles.set(key, createCandle(tick, timeframe, openedAtMs, durationMs));
    return cloneCandle(closed);
  }

  private appendClosedCandle(candle: Candle): void {
    const key = candleKey(candle.instrumentCode, candle.timeframe);
    const existing = this.recentClosedCandles.get(key) ?? [];
    const deduped = existing.filter((item) => item.openedAt !== candle.openedAt);
    deduped.push(cloneCandle(candle));
    deduped.sort((left, right) => Date.parse(left.openedAt) - Date.parse(right.openedAt));
    this.recentClosedCandles.set(key, deduped.slice(-this.recentClosedLimit));
  }
}

export function timeframeDurationMs(timeframe: Timeframe): number {
  return TIMEFRAME_MS[timeframe];
}

function createCandle(
  tick: MarketTick,
  timeframe: Timeframe,
  openedAtMs: number,
  durationMs: number
): Candle {
  const openedAt = new Date(openedAtMs).toISOString();
  const closedAt = new Date(openedAtMs + durationMs).toISOString();
  const volume = tradeVolume(tick);
  const buyVolume = tick.side === "buy" ? volume : 0;
  const sellVolume = tick.side === "sell" ? volume : 0;

  return {
    instrumentCode: tick.instrumentCode,
    timeframe,
    openedAt,
    closedAt,
    open: tick.price,
    high: tick.price,
    low: tick.price,
    close: tick.price,
    volume,
    notionalVolume: volume * tick.price,
    buyVolume,
    sellVolume,
    trades: volume > 0 ? 1 : 0,
    isClosed: false
  };
}

function mergeTickIntoCandle(candle: Candle, tick: MarketTick): void {
  const volume = tradeVolume(tick);
  candle.high = Math.max(candle.high, tick.price);
  candle.low = Math.min(candle.low, tick.price);
  candle.close = tick.price;
  candle.volume = roundMetric(candle.volume + volume, 12);
  candle.notionalVolume = roundMetric(candle.notionalVolume + volume * tick.price, 8);
  candle.buyVolume = roundMetric(candle.buyVolume + (tick.side === "buy" ? volume : 0), 12);
  candle.sellVolume = roundMetric(candle.sellVolume + (tick.side === "sell" ? volume : 0), 12);
  candle.trades += volume > 0 ? 1 : 0;
}

function tradeVolume(tick: MarketTick): number {
  return Number.isFinite(tick.size) && tick.size > 0 ? tick.size : 0;
}

function candleKey(instrumentCode: string, timeframe: Timeframe): string {
  return `${instrumentCode}:${timeframe}`;
}

function cloneCandle(candle: Candle): Candle {
  return { ...candle };
}

function isValidCandle(value: Candle): boolean {
  return (
    typeof value.instrumentCode === "string" &&
    typeof value.timeframe === "string" &&
    Number.isFinite(value.open) &&
    Number.isFinite(value.high) &&
    Number.isFinite(value.low) &&
    Number.isFinite(value.close)
  );
}

function roundMetric(value: number, precision: number): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}
