import type { Candle } from "../types";

export function calculateVwap(candles: Candle[]): number | null {
  let notional = 0;
  let volume = 0;

  for (const candle of candles) {
    notional += candle.notionalVolume;
    volume += candle.volume;
  }

  return volume > 0 ? notional / volume : null;
}
