import type { ReplayResult, SentimentState } from "../types";

export function calculateReplaySharpe(pnls: number[]): number | null {
  if (pnls.length < 2) {
    return null;
  }

  const mean = pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length;
  const variance =
    pnls.reduce((sum, pnl) => sum + (pnl - mean) ** 2, 0) / Math.max(1, pnls.length - 1);
  const stdev = Math.sqrt(variance);

  return stdev > 0 ? roundMetric((mean / stdev) * Math.sqrt(pnls.length), 4) : null;
}

export function buildReplayAblationSummary(
  trades: ReplayResult["shadowTrades"],
  sentiment: SentimentState
): ReplayResult["ablation"] {
  const sentimentTrades = trades.filter((trade) => trade.driver === "SENTIMENT");
  const sentimentPnl = sentimentTrades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0);
  const totalPnl = trades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0);
  const estimatedAiCostUsd = sentiment.estimatedCostUsd ?? 0;

  return {
    sentimentEnabledPnl: roundMetric(sentimentPnl, 6),
    sentimentDisabledPnl: roundMetric(totalPnl - sentimentPnl, 6),
    deltaPnl: roundMetric(sentimentPnl, 6),
    estimatedAiCostUsd,
    netEdgeAfterCosts: roundMetric(sentimentPnl - estimatedAiCostUsd, 6)
  };
}

function roundMetric(value: number, precision: number): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}
