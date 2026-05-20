import type { EngineState, JsonRecord, LatencyMetrics } from "../../../types";

export interface LatencyBaselineResetArtifactsInput {
  readonly currentState: EngineState;
  readonly observedAt: string;
  readonly reason: string;
}

export interface LatencyBaselineResetArtifacts {
  readonly state: EngineState;
  readonly latencyHistory: readonly LatencyMetrics[];
  readonly processingLatencySamples: readonly number[];
  readonly logMetadata: JsonRecord;
}

export interface LatencyBaselineResetSideEffectHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly replaceLatencyHistory: (history: readonly LatencyMetrics[]) => void;
  readonly replaceProcessingLatencySamples: (samples: readonly number[]) => void;
  readonly logReset: (metadata: JsonRecord) => void;
}

export function stateAfterLatencyBaselineReset(
  currentState: EngineState,
  observedAt: string
): EngineState {
  return {
    ...currentState,
    averageLatency: 0,
    latencySampleCount: 0,
    executionProfile: {
      ...currentState.executionProfile,
      status: "STABLE",
      jitterMs: 0,
      sampleCount: 0,
      averageProcessingLatencyMs: 0,
      maxProcessingLatencyMs: 0,
      lastProcessingLatencyMs: 0,
      updatedAt: observedAt
    },
    updatedAt: observedAt
  };
}

export function latencyBaselineResetArtifacts(
  input: LatencyBaselineResetArtifactsInput
): LatencyBaselineResetArtifacts {
  return {
    state: stateAfterLatencyBaselineReset(input.currentState, input.observedAt),
    latencyHistory: [],
    processingLatencySamples: [],
    logMetadata: {
      reason: input.reason,
      observedAt: input.observedAt
    }
  };
}

export function applyLatencyBaselineResetSideEffects(
  artifacts: LatencyBaselineResetArtifacts,
  handlers: LatencyBaselineResetSideEffectHandlers
): void {
  handlers.replaceLatencyHistory(artifacts.latencyHistory);
  handlers.replaceProcessingLatencySamples(artifacts.processingLatencySamples);
  handlers.applyState(artifacts.state);
  handlers.logReset(artifacts.logMetadata);
}
