import type { ProfilerRegistry } from "../../../agents/ProfilerRegistry";
import type {
  DomAnalysisSnapshot,
  EngineState,
  GlobalRiskConfig,
  InternalOrderBook,
  LatencyMetrics,
  MarketTick
} from "../../../types";
import type { ExecutionTraceInput } from "../performance/LatencyRuntime";
import {
  evaluateProfilerRuntime,
  type ProfilerRuntimeEvaluationResult
} from "./AgentEvaluationRuntime";

export interface TradingProfilerEvaluationInput {
  readonly profilerRegistry: ProfilerRegistry;
  readonly config: Pick<GlobalRiskConfig, "PROFILER_ENABLED">;
  readonly engineState: Pick<EngineState, "engineId" | "liquidationHeatmap">;
  readonly tick: MarketTick;
  readonly book: InternalOrderBook;
  readonly domSnapshot: DomAnalysisSnapshot;
  readonly observedAt: string;
  readonly jumpDetected: boolean;
  readonly metrics: LatencyMetrics;
  readonly wakeUpTimeMs: number | null;
  readonly orderBookUpdateMs: number;
  readonly hotPathStartedAt: number;
}

export interface TradingProfilerEvaluationHandlers {
  readonly observeExecutionProfile: (metrics: LatencyMetrics, trace: ExecutionTraceInput) => void;
}

export function evaluateTradingProfiler(
  input: TradingProfilerEvaluationInput,
  handlers: TradingProfilerEvaluationHandlers
): ProfilerRuntimeEvaluationResult {
  const profilerAgent = input.profilerRegistry.forInstrument(input.tick.instrumentCode);
  const result = evaluateProfilerRuntime({
    profilerEnabled: input.config.PROFILER_ENABLED,
    agent: profilerAgent,
    tick: input.tick,
    context: {
      engineId: input.engineState.engineId,
      observedAt: input.observedAt,
      book: input.book,
      dom: input.domSnapshot,
      liquidationHeatmap: input.engineState.liquidationHeatmap,
      jumpDetected: input.jumpDetected
    }
  });

  handlers.observeExecutionProfile(input.metrics, {
    wakeUpTimeMs: input.wakeUpTimeMs,
    orderBookUpdateMs: input.orderBookUpdateMs,
    agentLogicMs: result.profilerLatencyMs,
    hotPathStartedAt: input.hotPathStartedAt,
    observedAt: input.observedAt
  });

  return result;
}
