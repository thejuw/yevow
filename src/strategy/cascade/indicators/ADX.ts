import type { Candle } from "../types";
import { trueRange } from "./ATR";

export interface AdxSnapshot {
  adx: number;
  plusDi: number;
  minusDi: number;
}

export function calculateAdx(candles: Candle[], period: number): AdxSnapshot | null {
  if (period <= 0 || candles.length < period + 1) {
    return null;
  }

  const dxValues: number[] = [];
  let smoothedTr = 0;
  let smoothedPlusDm = 0;
  let smoothedMinusDm = 0;

  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = trueRange(current, previous.close);

    if (index <= period) {
      smoothedTr += tr;
      smoothedPlusDm += plusDm;
      smoothedMinusDm += minusDm;
      if (index < period) {
        continue;
      }
    } else {
      smoothedTr = smoothedTr - smoothedTr / period + tr;
      smoothedPlusDm = smoothedPlusDm - smoothedPlusDm / period + plusDm;
      smoothedMinusDm = smoothedMinusDm - smoothedMinusDm / period + minusDm;
    }

    const plusDi = smoothedTr > 0 ? (100 * smoothedPlusDm) / smoothedTr : 0;
    const minusDi = smoothedTr > 0 ? (100 * smoothedMinusDm) / smoothedTr : 0;
    const dx = plusDi + minusDi > 0 ? (100 * Math.abs(plusDi - minusDi)) / (plusDi + minusDi) : 0;
    dxValues.push(dx);
  }

  if (dxValues.length === 0) {
    return null;
  }

  const recentDx = dxValues.slice(-period);
  const adx = recentDx.reduce((sum, value) => sum + value, 0) / recentDx.length;
  const plusDi = smoothedTr > 0 ? (100 * smoothedPlusDm) / smoothedTr : 0;
  const minusDi = smoothedTr > 0 ? (100 * smoothedMinusDm) / smoothedTr : 0;

  return { adx, plusDi, minusDi };
}
