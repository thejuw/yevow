import type { ReplayOptions } from "../routes/ReplayAdminRoutes";
import type { ReplayStatus } from "../routes/ReplayAdminRoutes";
import type {
  EngineState,
  GlobalRiskConfig,
  JsonRecord,
  ReplayResult,
  SentimentState
} from "../../../types";
import {
  buildReplayAblation,
  buildReplayAttribution,
  buildReplayEquityCurve,
  buildReplayWalkForward,
  buildStressSummary,
  calculateMaxDrawdown,
  calculateReplaySharpe,
  calculateWinRate,
  defaultEngineState
} from "../helpers/RuntimeHelpers";

export interface ResolveInitialShadowBankrollInput {
  readonly requestedShadowBankroll: number;
  readonly liveEquity: number;
  readonly liveCash: number;
  readonly fallbackBankroll: number;
}

export interface BuildShadowReplayConfigInput {
  readonly currentConfig: GlobalRiskConfig;
  readonly initialShadowBankroll: number;
  readonly defaultMaxPositionPct: number;
  readonly defaultMaxInventoryUnits: number;
  readonly startedAt: string;
  readonly replayId: string;
}

export interface BuildShadowReplayEngineStateInput {
  readonly liveState: EngineState;
  readonly cachedConfig: GlobalRiskConfig;
  readonly initialShadowBankroll: number;
  readonly startedAt: string;
  readonly replayId: string;
}

export interface BuildReplayStatusInput {
  readonly replayId: string;
  readonly status: ReplayStatus["status"];
  readonly ticksTotal: number;
  readonly ticksProcessed: number;
  readonly speedMultiplier: number;
  readonly shadowBankroll: number;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly scenario: ReplayOptions["scenario"];
  readonly error?: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | null;
  readonly progressPct?: number;
}

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

export function resolveInitialShadowBankroll(input: ResolveInitialShadowBankrollInput): number {
  if (input.requestedShadowBankroll > 0) {
    return input.requestedShadowBankroll;
  }

  return Math.max(input.liveEquity, input.liveCash, input.fallbackBankroll);
}

export function buildShadowReplayConfig(input: BuildShadowReplayConfigInput): GlobalRiskConfig {
  return {
    ...input.currentConfig,
    TRADING_ENABLED: true,
    MAX_POSITION_SIZE: input.currentConfig.MAX_POSITION_SIZE || input.initialShadowBankroll,
    MAX_POSITION_PCT: input.currentConfig.MAX_POSITION_PCT || input.defaultMaxPositionPct,
    MAX_INVENTORY_UNITS: input.currentConfig.MAX_INVENTORY_UNITS || input.defaultMaxInventoryUnits,
    updatedAt: input.startedAt,
    updatedBy: "shadow-replay",
    version: `${input.currentConfig.version}:shadow-replay:${input.replayId}`
  };
}

export function buildShadowReplayEngineState(
  input: BuildShadowReplayEngineStateInput
): EngineState {
  return {
    ...defaultEngineState(`${input.liveState.engineId}:shadow:${input.replayId}`),
    bankroll: {
      ...input.liveState.bankroll,
      cash: input.initialShadowBankroll,
      equity: input.initialShadowBankroll,
      realizedPnl: 0,
      updatedAt: input.startedAt
    },
    mode: "PAPER",
    cachedConfig: input.cachedConfig,
    heartbeatAt: input.startedAt,
    updatedAt: input.startedAt
  };
}

export function calculateReplayShadowBankroll(
  initialShadowBankroll: number,
  modeledTrades: ReplayResult["shadowTrades"]
): number {
  return (
    initialShadowBankroll + modeledTrades.reduce((sum, trade) => sum + trade.theoreticalPnl, 0)
  );
}

export function buildReplayStatus(input: BuildReplayStatusInput): ReplayStatus {
  return {
    replayId: input.replayId,
    status: input.status,
    ticksTotal: input.ticksTotal,
    ticksProcessed: input.ticksProcessed,
    progressPct:
      input.progressPct ??
      (input.ticksTotal > 0
        ? roundReplayMetric((input.ticksProcessed / input.ticksTotal) * 100, 2)
        : 0),
    speedMultiplier: input.speedMultiplier,
    shadowBankroll: input.shadowBankroll,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    scenario: input.scenario,
    error: input.error ?? null,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    completedAt: input.completedAt ?? null
  };
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
