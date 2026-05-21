import { PERFORMANCE_HISTORY_LIMIT } from "../../../TradingEngineConstants";
import type { EngineState, LatencyMetrics, MarketTick } from "../../../types";
import {
  hydrateLatencyMetricsFromState,
  prepareTickLatencyFlow,
  type TickLatencyPreparationResult
} from "./LatencyTickRuntime";

export interface TradingTickLatencyInput {
  readonly tick: MarketTick;
  readonly shadowReplay: boolean;
  readonly maxLatencyMs: number;
  readonly engineState: Pick<EngineState, "averageLatency" | "latencySampleCount" | "location">;
  readonly latencyHistory: readonly LatencyMetrics[];
  readonly dwellirMaxLatencyMs?: string;
  readonly hlStaleAfterMs?: string;
}

export interface TradingTickLatencyHandlers {
  readonly resetLatencyBaseline: (observedAt: string, reason: string) => void;
  readonly updateLatencyAverage: (totalLatencyMs: number) => void;
  readonly applyLocationLatency: (totalLatencyMs: number, observedAt: string) => void;
  readonly setLatencyHistory: (history: LatencyMetrics[]) => void;
}

export type TradingTickLatencyResult = Pick<
  TickLatencyPreparationResult,
  "metrics" | "streamId" | "hardStaleDropMs" | "isHardStale"
>;

export function prepareTradingTickLatency(
  input: TradingTickLatencyInput,
  handlers: TradingTickLatencyHandlers
): TradingTickLatencyResult {
  return prepareTickLatencyFlow(
    {
      tick: input.tick,
      brainTimestamp: new Date().toISOString(),
      maxLatencyMs: input.maxLatencyMs,
      averageLatencyMs: input.engineState.averageLatency,
      sampleCount: input.engineState.latencySampleCount,
      location: input.engineState.location,
      shadowReplay: input.shadowReplay,
      dwellirMaxLatencyMs: input.dwellirMaxLatencyMs,
      hlStaleAfterMs: input.hlStaleAfterMs,
      currentMaxLatencyMs: input.maxLatencyMs,
      history: input.latencyHistory,
      historyLimit: PERFORMANCE_HISTORY_LIMIT
    },
    {
      resetLatencyBaseline: handlers.resetLatencyBaseline,
      updateLatencyAverage: handlers.updateLatencyAverage,
      hydrateMetrics: (metrics) => hydrateLatencyMetricsFromState(metrics, input.engineState),
      applyLocationLatency: handlers.applyLocationLatency,
      setLatencyHistory: handlers.setLatencyHistory
    }
  );
}
