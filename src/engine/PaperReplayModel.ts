import type { SlippageAnalytics } from "../types";

export interface PaperFillModelInput {
  slippage: SlippageAnalytics;
  fallbackAdverseBps: number;
  side: "BUY" | "SELL";
  random?: number;
}

export interface PaperFillModelResult {
  adverseBps: number;
  source: "EMPIRICAL_BOOTSTRAP" | "PARAMETRIC_FALLBACK";
}

export function bootstrapPaperAdverseSelection(input: PaperFillModelInput): PaperFillModelResult {
  const losses = input.slippage.points
    .map((point) => Math.max(0, point.slippageBps))
    .filter((value) => Number.isFinite(value));

  if (losses.length < 20) {
    return {
      adverseBps: Math.max(0, input.fallbackAdverseBps),
      source: "PARAMETRIC_FALLBACK"
    };
  }

  const cursor = Math.min(
    losses.length - 1,
    Math.max(0, Math.floor((input.random ?? Math.random()) * losses.length))
  );

  return {
    adverseBps: losses[cursor],
    source: "EMPIRICAL_BOOTSTRAP"
  };
}
