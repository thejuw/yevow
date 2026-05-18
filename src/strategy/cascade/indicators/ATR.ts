import type { Candle } from "../types";

export function trueRange(candle: Candle, previousClose: number | null): number {
  if (previousClose === null) {
    return candle.high - candle.low;
  }

  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose)
  );
}

export function calculateAtr(candles: Candle[], period: number): number | null {
  if (period <= 0 || candles.length < period) {
    return null;
  }

  const ranges: number[] = [];
  for (let index = 0; index < candles.length; index += 1) {
    const previousClose = index > 0 ? candles[index - 1].close : null;
    ranges.push(trueRange(candles[index], previousClose));
  }

  const seed = ranges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  let atr = seed;

  for (let index = period; index < ranges.length; index += 1) {
    atr = (atr * (period - 1) + ranges[index]) / period;
  }

  return atr;
}
