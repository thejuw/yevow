import type { LatencyMetrics } from "../../../types";

export interface PerformanceSpikeLogGateInput {
  readonly logAt: Map<string, number>;
  readonly latencyMetrics: LatencyMetrics;
  readonly throttleMs: number;
  readonly nowMs?: number;
}

export interface PerformanceSpikeLogSideEffectHandlers {
  readonly logPerformance: (latencyMetrics: LatencyMetrics) => void;
}

export function shouldLogPerformanceSpikeEvent(input: PerformanceSpikeLogGateInput): boolean {
  const key = `${input.latencyMetrics.instrumentCode}:${input.latencyMetrics.status}`;
  const now = input.nowMs ?? Date.now();
  const previous = input.logAt.get(key);

  if (previous !== undefined && now - previous < input.throttleMs) {
    return false;
  }

  input.logAt.set(key, now);
  return true;
}

export function applyPerformanceSpikeLogSideEffect(
  input: PerformanceSpikeLogGateInput,
  handlers: PerformanceSpikeLogSideEffectHandlers
): boolean {
  if (!shouldLogPerformanceSpikeEvent(input)) {
    return false;
  }

  handlers.logPerformance(input.latencyMetrics);
  return true;
}
