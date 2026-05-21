import type { PerformanceSnapshot } from "../../../Logger";
import { COLD_START_WAKEUP_THRESHOLD_MS } from "../../../TradingEngineConstants";
import type { EngineStabilityStatus, ExecutionProfile, LatencyMetrics } from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";
import {
  applyExecutionProfileFlow,
  type ExecutionPerformanceTransition,
  type ExecutionTraceInput
} from "./LatencyRuntime";

export interface TradingExecutionProfileState {
  readonly engineId: string;
  readonly executionProfile: ExecutionProfile | null | undefined;
  readonly processedTicks: number;
}

export interface TradingExecutionProfileInput {
  readonly engineState: TradingExecutionProfileState;
  readonly processingLatencySamples: number[];
  readonly metrics: LatencyMetrics;
  readonly trace: ExecutionTraceInput;
  readonly jitterThresholdMs: number;
  readonly jitterSampleWindow: number;
  readonly jitterComputeIntervalTicks: number;
  readonly lastPerformanceStatus: EngineStabilityStatus;
}

export interface TradingExecutionProfileHandlers {
  readonly applyProfile: (profile: ExecutionProfile) => void;
  readonly markPerformanceStatus: (status: EngineStabilityStatus) => void;
  readonly logPerformanceSnapshot: (snapshot: PerformanceSnapshot) => void;
  readonly publishTransition: (transition: ExecutionPerformanceTransition) => void;
  readonly notify: (notification: NotifierEvent) => void;
}

export function observeTradingExecutionProfile(
  input: TradingExecutionProfileInput,
  handlers: TradingExecutionProfileHandlers
): void {
  applyExecutionProfileFlow(
    {
      engineId: input.engineState.engineId,
      previousProfile: input.engineState.executionProfile,
      processedTicks: input.engineState.processedTicks,
      processingLatencySamples: input.processingLatencySamples,
      metrics: input.metrics,
      trace: input.trace,
      jitterThresholdMs: input.jitterThresholdMs,
      jitterSampleWindow: input.jitterSampleWindow,
      jitterComputeIntervalTicks: input.jitterComputeIntervalTicks,
      coldStartWakeupThresholdMs: COLD_START_WAKEUP_THRESHOLD_MS,
      lastPerformanceStatus: input.lastPerformanceStatus
    },
    handlers
  );
}
