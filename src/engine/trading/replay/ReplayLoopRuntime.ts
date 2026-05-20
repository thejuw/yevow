import { wait } from "../helpers/RuntimeMath";
import { modelReplayIntentTrade } from "./ReplayModelRuntime";
import type { ReplayOptions, ReplayStatus } from "../routes/ReplayAdminRoutes";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { MarketTick, ReplayResult, TradeIntent } from "../../../types";
import { buildReplayStatus, calculateReplayShadowBankroll } from "./ReplayResultRuntime";

export interface ShadowReplayLoopInput {
  readonly replayId: string;
  readonly ticks: MarketTick[];
  readonly replayOptions: ReplayOptions;
  readonly speedMultiplier: number;
  readonly initialShadowBankroll: number;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly startedAt: string;
  readonly enqueueShadowReplayTick: (tick: MarketTick) => Promise<TickIngestResult>;
  readonly lastTradeIntent: () => TradeIntent | null;
  readonly oracleRegime: () => ReplayResult["shadowTrades"][number]["regime"];
  readonly writeStatus: (status: ReplayStatus) => Promise<void>;
  readonly now?: () => string;
}

export interface ShadowReplayLoopResult {
  readonly ticksReplayed: number;
  readonly generatedIntentCount: number;
  readonly modeledTrades: ReplayResult["shadowTrades"];
}

export async function runShadowReplayLoop(
  input: ShadowReplayLoopInput
): Promise<ShadowReplayLoopResult> {
  const modeledTrades: ReplayResult["shadowTrades"] = [];
  let ticksReplayed = 0;
  let generatedIntentCount = 0;
  let previousTick: MarketTick | null = null;

  try {
    for (const [index, tick] of input.ticks.entries()) {
      if (previousTick) {
        const intervalMs = Math.max(
          0,
          Date.parse(tick.receivedAt) - Date.parse(previousTick.receivedAt)
        );

        if (intervalMs > 0) {
          await wait(Math.round(intervalMs / Math.max(0.000001, input.speedMultiplier)));
        }
      }

      const previousIntentId = input.lastTradeIntent()?.intentId ?? null;
      const result = await input.enqueueShadowReplayTick(tick);
      ticksReplayed += result.accepted ? 1 : 0;

      const nextIntent = input.lastTradeIntent();
      const nextIntentId = nextIntent?.intentId ?? null;
      if (nextIntentId && nextIntentId !== previousIntentId) {
        generatedIntentCount += 1;
        const modeled = modelReplayIntentTrade(
          nextIntent,
          tick,
          input.ticks,
          index,
          input.replayOptions,
          input.oracleRegime()
        );
        if (modeled) {
          modeledTrades.push(modeled);
        }
      }

      if (index === input.ticks.length - 1 || index % 25 === 0) {
        await input.writeStatus(
          buildReplayStatus({
            replayId: input.replayId,
            status: "RUNNING",
            ticksTotal: input.ticks.length,
            ticksProcessed: index + 1,
            progressPct: input.ticks.length > 0 ? undefined : 100,
            speedMultiplier: input.speedMultiplier,
            shadowBankroll: calculateReplayShadowBankroll(
              input.initialShadowBankroll,
              modeledTrades
            ),
            dateFrom: input.dateFrom,
            dateTo: input.dateTo,
            scenario: input.replayOptions.scenario,
            startedAt: input.startedAt,
            updatedAt: replayLoopNow(input)
          })
        );
      }

      previousTick = tick;
    }
  } catch (error) {
    const failedAt = replayLoopNow(input);
    await input.writeStatus(
      buildReplayStatus({
        replayId: input.replayId,
        status: "FAILED",
        ticksTotal: input.ticks.length,
        ticksProcessed: ticksReplayed,
        speedMultiplier: input.speedMultiplier,
        shadowBankroll: input.initialShadowBankroll,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        scenario: input.replayOptions.scenario,
        error: error instanceof Error ? error.message : "UNKNOWN_REPLAY_ERROR",
        startedAt: input.startedAt,
        updatedAt: failedAt,
        completedAt: failedAt
      })
    );
    throw error;
  }

  return {
    ticksReplayed,
    generatedIntentCount,
    modeledTrades
  };
}

function replayLoopNow(input: Pick<ShadowReplayLoopInput, "now">): string {
  return input.now?.() ?? new Date().toISOString();
}
