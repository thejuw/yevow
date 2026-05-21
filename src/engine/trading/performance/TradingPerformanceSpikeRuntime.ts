import { HOT_PATH_LOG_THROTTLE_MS } from "../../../TradingEngineConstants";
import type { LatencyMetrics } from "../../../types";
import { applyPerformanceSpikeLogSideEffect } from "./PerformanceSpikeRuntime";

export interface TradingPerformanceSpikeInput {
  readonly logAt: Map<string, number>;
  readonly latencyMetrics: LatencyMetrics;
}

export interface TradingPerformanceSpikeHandlers {
  readonly logPerformance: (latencyMetrics: LatencyMetrics) => void;
}

export function logTradingPerformanceSpike(
  input: TradingPerformanceSpikeInput,
  handlers: TradingPerformanceSpikeHandlers
): void {
  applyPerformanceSpikeLogSideEffect(
    {
      logAt: input.logAt,
      latencyMetrics: input.latencyMetrics,
      throttleMs: HOT_PATH_LOG_THROTTLE_MS
    },
    handlers
  );
}
