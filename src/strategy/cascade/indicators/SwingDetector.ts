import type { Candle, SwingPoint } from "../types";

export function detectSwings(candles: Candle[], lookback: number): SwingPoint[] {
  const radius = Math.max(1, Math.floor(lookback));
  if (candles.length < radius * 2 + 1) {
    return [];
  }

  const swings: SwingPoint[] = [];
  for (let index = radius; index < candles.length - radius; index += 1) {
    const candle = candles[index];
    let isHigh = true;
    let isLow = true;

    for (let offset = index - radius; offset <= index + radius; offset += 1) {
      if (offset === index) {
        continue;
      }
      isHigh = isHigh && candle.high > candles[offset].high;
      isLow = isLow && candle.low < candles[offset].low;
    }

    if (isHigh) {
      swings.push(toSwing(candle, "HIGH", radius));
    }
    if (isLow) {
      swings.push(toSwing(candle, "LOW", radius));
    }
  }

  return swings;
}

function toSwing(candle: Candle, kind: SwingPoint["kind"], strength: number): SwingPoint {
  return {
    instrumentCode: candle.instrumentCode,
    timeframe: candle.timeframe,
    kind,
    price: kind === "HIGH" ? candle.high : candle.low,
    candleOpenedAt: candle.openedAt,
    detectedAt: candle.closedAt,
    strength
  };
}
