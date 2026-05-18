import type { Candle } from "../types";

export function cumulativeVolumeDelta(candles: Candle[]): number {
  let cvd = 0;

  for (const candle of candles) {
    cvd += candle.buyVolume - candle.sellVolume;
  }

  return cvd;
}

export function cvdSeries(candles: Candle[]): { observedAt: string; value: number }[] {
  const series: { observedAt: string; value: number }[] = [];
  let cvd = 0;

  for (const candle of candles) {
    cvd += candle.buyVolume - candle.sellVolume;
    series.push({ observedAt: candle.closedAt, value: cvd });
  }

  return series;
}
