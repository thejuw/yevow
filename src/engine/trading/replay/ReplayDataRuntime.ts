import type { MarketTick, ReplayResult } from "../../../types";
import type { ReplayScenario } from "../routes/ReplayAdminRoutes";
import {
  markHistoricalReplayTrades,
  type ReplayJournal,
  type ReplayTradeRow
} from "./ReplayJournal";
import { applyReplayScenarioToTick } from "./ReplayModelRuntime";

export interface LoadedScenarioReplayTicks {
  readonly sourceTicks: MarketTick[];
  readonly ticks: MarketTick[];
}

export interface LoadedReplayShadowTrades {
  readonly historicalTrades: ReplayTradeRow[];
  readonly shadowTrades: ReplayResult["shadowTrades"];
}

export interface LoadScenarioReplayTicksInput {
  readonly replayJournal: Pick<ReplayJournal, "loadTicks">;
  readonly limit: number;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly scenario: ReplayScenario;
}

export interface LoadReplayShadowTradesInput {
  readonly replayJournal: Pick<ReplayJournal, "loadTrades">;
  readonly ticks: MarketTick[];
}

export async function loadScenarioReplayTicksFromJournal(
  input: LoadScenarioReplayTicksInput
): Promise<LoadedScenarioReplayTicks> {
  const sourceTicks = await input.replayJournal.loadTicks(
    input.limit,
    input.dateFrom,
    input.dateTo
  );
  const ticks = sourceTicks.map((tick, index) =>
    applyReplayScenarioToTick(tick, input.scenario, index, sourceTicks.length)
  );

  return { sourceTicks, ticks };
}

export async function loadReplayShadowTradesFromJournal(
  input: LoadReplayShadowTradesInput
): Promise<LoadedReplayShadowTrades> {
  const firstTick = input.ticks[0];
  const lastTick = input.ticks[input.ticks.length - 1];
  const historicalTrades =
    firstTick && lastTick
      ? await input.replayJournal.loadTrades(firstTick.receivedAt, lastTick.receivedAt)
      : [];
  const shadowTrades = markHistoricalReplayTrades(historicalTrades, input.ticks);

  return { historicalTrades, shadowTrades };
}
