import { PERFORMANCE_HISTORY_LIMIT } from "../../../TradingEngineConstants";
import type { EngineState, LatencyMetrics, MarketTick } from "../../../types";
import {
  hydrateLatencyMetricsFromState,
  prepareTickLatencyFlow,
  type TickLatencyPreparationResult
} from "./LatencyTickRuntime";
import {
  resetTradingLatencyBaselineForTarget,
  updateTradingLatencyAverageForTarget,
  type TradingLatencyStateTarget
} from "./TradingLatencyStateRuntime";

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

export interface TradingTickLatencyTarget extends TradingLatencyStateTarget {
  readonly maxLatencyMs: number;
  readonly env: {
    readonly DWELLIR_MAX_LATENCY_MS?: string;
    readonly HL_STALE_AFTER_MS?: string;
  };
  applyLocationLatency(totalLatencyMs: number, observedAt: string): void;
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

export function prepareTradingTickLatencyForTarget(
  input: Pick<TradingTickLatencyInput, "tick" | "shadowReplay">,
  target: TradingTickLatencyTarget
): TradingTickLatencyResult {
  return prepareTradingTickLatency(
    {
      tick: input.tick,
      shadowReplay: input.shadowReplay,
      maxLatencyMs: target.maxLatencyMs,
      engineState: target.engineState,
      latencyHistory: target.latencyHistory,
      dwellirMaxLatencyMs: target.env.DWELLIR_MAX_LATENCY_MS,
      hlStaleAfterMs: target.env.HL_STALE_AFTER_MS
    },
    {
      resetLatencyBaseline: (observedAt, reason) => {
        resetTradingLatencyBaselineForTarget(observedAt, reason, target);
      },
      updateLatencyAverage: (totalLatencyMs) => {
        updateTradingLatencyAverageForTarget(totalLatencyMs, target);
      },
      applyLocationLatency: (totalLatencyMs, observedAt) => {
        target.applyLocationLatency(totalLatencyMs, observedAt);
      },
      setLatencyHistory: (history) => {
        target.latencyHistory = history;
      }
    }
  );
}
