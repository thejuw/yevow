import type { TradeIntent } from "../types";
import { positiveOrNull } from "./ExecutionFormatters";

export interface TwapSliceConfig {
  sliceNotionalPerChunk: number;
  sliceIntervalMs: number;
  sliceJitterMs: number;
}

export interface TwapSlice {
  intent: TradeIntent;
  delayMs: number;
}

export function buildTwapSlices(intent: TradeIntent, config: TwapSliceConfig): TwapSlice[] {
  const size = positiveOrNull(intent.approvedSize ?? intent.requestedSize) ?? 0;
  const price = positiveOrNull(intent.expectedPrice) ?? 0;
  const perChunkNotional =
    positiveOrNull(config.sliceNotionalPerChunk) ?? Math.max(size * price, 1);
  const notional = size * price;
  const count = Math.max(1, Math.ceil(notional / perChunkNotional));
  const chunkSize = size / count;
  const slices: TwapSlice[] = [];

  for (let index = 0; index < count; index += 1) {
    const sliceSize = index === count - 1 ? size - chunkSize * index : chunkSize;
    if (sliceSize <= 0) {
      continue;
    }

    slices.push({
      intent: {
        ...intent,
        intentId: `${intent.intentId}-slice-${index + 1}`,
        executionStyle: "TAKER_IOC",
        orderType: "IOC",
        postOnly: false,
        timeInForce: "IOC",
        requestedSize: roundOrderSize(sliceSize),
        approvedSize: roundOrderSize(sliceSize),
        rationale: `${intent.rationale} sliced_twap_child=${index + 1}/${count}`
      },
      delayMs: index === 0 ? 0 : twapDelay(config.sliceIntervalMs, config.sliceJitterMs, index)
    });
  }

  return slices;
}

export function twapDelay(intervalMs: number, jitterMs: number, index: number): number {
  const base = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 0;
  const jitter = Number.isFinite(jitterMs) && jitterMs > 0 ? jitterMs : 0;
  const deterministicJitter = jitter === 0 ? 0 : ((index * 9973) % (jitter * 2 + 1)) - jitter;
  return Math.max(0, Math.round(base + deterministicJitter));
}

export function fillRatio(filledSize: number, requestedSize: number): number {
  return requestedSize > 0 ? filledSize / requestedSize : 0;
}

function roundOrderSize(value: number): number {
  return Number(value.toFixed(8));
}
