import type { ReplayOptions } from "../routes/ReplayAdminRoutes";
import type { JsonRecord, ReplayResult, SentimentState } from "../../../types";
import {
  buildReplayAblation,
  buildReplayAttribution,
  buildReplayEquityCurve,
  buildReplayWalkForward,
  buildStressSummary,
  calculateMaxDrawdown,
  calculateReplaySharpe,
  calculateWinRate
} from "../../../TradingEngineRuntimeHelpers";

export interface BuildReplayResultInput {
  readonly replayId: string;
  readonly replayOptions: ReplayOptions;
  readonly ticksReplayed: number;
  readonly initialShadowBankroll: number;
  readonly historicalTradeCount: number;
  readonly generatedIntentCount: number;
  readonly speedMultiplier: number;
  readonly modeledTrades: ReplayResult["shadowTrades"];
  readonly shadowTrades: ReplayResult["shadowTrades"];
  readonly sentiment: SentimentState;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface BuildReplayResultOutput {
  readonly result: ReplayResult;
  readonly logMetadata: JsonRecord;
}

export function buildHistoricalReplayResult(
  input: BuildReplayResultInput
): BuildReplayResultOutput {
  const theoreticalPnl = input.modeledTrades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0);
  const baselinePnl = input.shadowTrades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0);
  const attribution = buildReplayAttribution(input.modeledTrades);
  const equityCurve = buildReplayEquityCurve(input.initialShadowBankroll, input.modeledTrades);
  const maxDrawdown = calculateMaxDrawdown(equityCurve);
  const sharpe = calculateReplaySharpe(input.modeledTrades.map((trade) => trade.theoreticalPnl));
  const winRate = calculateWinRate(input.modeledTrades);
  const stressResults =
    input.replayOptions.scenario === "BASELINE"
      ? buildStressSummary(input.modeledTrades, input.generatedIntentCount)
      : [
          {
            scenario: input.replayOptions.scenario,
            pnl: roundReplayMetric(theoreticalPnl, 8),
            maxDrawdown,
            generatedIntentCount: input.generatedIntentCount,
            simulatedTradeCount: input.modeledTrades.length
          }
        ];
  const walkForward = input.replayOptions.walkForward
    ? buildReplayWalkForward(input.modeledTrades, 4)
    : [];
  const ablation = input.replayOptions.sentimentAblation
    ? buildReplayAblation(input.modeledTrades, input.sentiment)
    : null;
  const result: ReplayResult = {
    replayId: input.replayId,
    strategyVersionId: input.replayOptions.strategyVersionId,
    scenario: input.replayOptions.scenario,
    ticksReplayed: input.ticksReplayed,
    shadowBankroll: input.initialShadowBankroll + theoreticalPnl,
    theoreticalPnl,
    baselinePnl,
    actualTradeCount: input.historicalTradeCount,
    generatedIntentCount: input.generatedIntentCount,
    simulatedTradeCount: input.modeledTrades.length,
    speedMultiplier: input.speedMultiplier,
    maxDrawdown,
    sharpe,
    winRate,
    latencyModel: {
      type: input.replayOptions.scenario === "LATENCY_SHOCK" ? "fixed-plus-shock" : "fixed",
      latencyMs: input.replayOptions.latencyMs
    },
    slippageModel: {
      type: "side-aware-bps",
      slippageBps: input.replayOptions.slippageBps
    },
    feeModel: {
      type: "round-trip-bps",
      feeBps: input.replayOptions.feeBps
    },
    attribution,
    stressResults,
    walkForward,
    ablation,
    shadowTrades: input.modeledTrades,
    startedAt: input.startedAt,
    completedAt: input.completedAt
  };

  return {
    result,
    logMetadata: {
      replayId: result.replayId,
      ticksReplayed: input.ticksReplayed,
      actualTradeCount: input.historicalTradeCount,
      generatedIntentCount: input.generatedIntentCount,
      theoreticalPnl,
      baselinePnl,
      simulatedTradeCount: input.modeledTrades.length,
      maxDrawdown,
      sharpe,
      winRate,
      scenario: input.replayOptions.scenario,
      speedMultiplier: input.speedMultiplier,
      liveStateRestored: true
    }
  };
}

function roundReplayMetric(value: number, decimals: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}
