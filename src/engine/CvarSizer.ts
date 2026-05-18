import type { SlippageAnalytics } from "../types";

export interface CvarSizingInput {
  baseFraction: number;
  slippage: SlippageAnalytics;
  confidence: number;
  maxTailLossBps: number;
  lookbackTrades: number;
}

export interface CvarSizingDecision {
  cappedFraction: number;
  cvarBps: number;
  tailSampleCount: number;
  reason: string;
}

export function applyCvarSizing(input: CvarSizingInput): CvarSizingDecision {
  const baseFraction = clamp(input.baseFraction, 0, 1);
  const maxTailLossBps = Math.max(0.000001, input.maxTailLossBps);
  const tail = estimateTailLossBps(input.slippage, input.confidence, input.lookbackTrades);

  if (tail.cvarBps <= maxTailLossBps) {
    return {
      cappedFraction: baseFraction,
      cvarBps: tail.cvarBps,
      tailSampleCount: tail.tailSampleCount,
      reason: "CVAR_WITHIN_LIMIT"
    };
  }

  const tailScale = clamp(maxTailLossBps / tail.cvarBps, 0, 1);

  return {
    cappedFraction: roundMetric(baseFraction * tailScale, 8),
    cvarBps: tail.cvarBps,
    tailSampleCount: tail.tailSampleCount,
    reason: "CVAR_TAIL_CAP_APPLIED"
  };
}

export function estimateTailLossBps(
  slippage: SlippageAnalytics,
  confidence: number,
  lookbackTrades: number
): { cvarBps: number; tailSampleCount: number } {
  const lookback = Math.max(1, Math.floor(lookbackTrades));
  const confidenceBound = clamp(confidence, 0.9, 0.999);
  const points = slippage.points.slice(-lookback);
  const losses = points
    .map((point) => Math.max(0, point.slippageBps))
    .filter((loss) => Number.isFinite(loss))
    .sort((left, right) => left - right);

  if (losses.length === 0) {
    return { cvarBps: 0, tailSampleCount: 0 };
  }

  const start = Math.min(
    losses.length - 1,
    Math.max(0, Math.floor(losses.length * confidenceBound))
  );
  let sum = 0;
  let count = 0;

  for (let index = start; index < losses.length; index += 1) {
    sum += losses[index];
    count += 1;
  }

  return {
    cvarBps: count > 0 ? roundMetric(sum / count, 4) : 0,
    tailSampleCount: count
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function roundMetric(value: number, precision: number): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}
