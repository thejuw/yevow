import type { TradeIntent } from "../types";

export interface CamouflageResult {
  intent: TradeIntent;
  intendedSize: number;
  camouflagedSize: number;
  timingJitterMs: number;
  icebergChunks: TradeIntent[];
}

export function camouflageIntent(
  intent: TradeIntent,
  maxApprovedSize: number,
  options: { minJitterPct?: number; maxJitterPct?: number; minDelayMs?: number; maxDelayMs?: number } = {}
): CamouflageResult {
  const intendedSize = intent.approvedSize ?? intent.requestedSize;
  const minJitter = options.minJitterPct ?? 0.01;
  const maxJitter = options.maxJitterPct ?? 0.05;
  const signedJitter =
    (Math.random() < 0.5 ? -1 : 1) *
    (minJitter + Math.random() * Math.max(0, maxJitter - minJitter));
  const camouflagedSize = Math.min(
    intendedSize,
    maxApprovedSize,
    Math.max(0, intendedSize * (1 + signedJitter))
  );
  const timingJitterMs = randomInt(options.minDelayMs ?? 5, options.maxDelayMs ?? 20);
  const camouflagedIntent = {
    ...intent,
    approvedSize: camouflagedSize,
    rationale: `${intent.rationale}; mixed-strategy size jitter applied`
  };

  return {
    intent: camouflagedIntent,
    intendedSize,
    camouflagedSize,
    timingJitterMs,
    icebergChunks: iceberg(camouflagedIntent, camouflagedSize)
  };
}

function iceberg(intent: TradeIntent, maxCumulativeSize: number): TradeIntent[] {
  const size = intent.approvedSize ?? intent.requestedSize;

  if (size <= 3) {
    return [intent];
  }

  const chunks = Math.min(5, Math.max(2, Math.ceil(size / 3)));
  const base = size / chunks;

  let remaining = maxCumulativeSize;

  return Array.from({ length: chunks }, (_, index) => {
    const jittered = Math.max(0, base * (0.95 + Math.random() * 0.1));
    const childSize = index === chunks - 1 ? remaining : Math.min(remaining, jittered);
    remaining = Math.max(0, remaining - childSize);

    return {
      ...intent,
      intentId: `${intent.intentId}:iceberg:${index + 1}`,
      approvedSize: childSize
    };
  }).filter((child) => (child.approvedSize ?? 0) > 0);
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * Math.max(1, max - min + 1));
}
