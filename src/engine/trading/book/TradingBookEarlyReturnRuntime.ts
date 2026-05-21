import type { EngineState, LatencyMetrics, MarketTick } from "../../../types";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { ExecutionTraceInput } from "../performance/LatencyRuntime";
import { countBookLevels } from "./BookReconstruction";
import type { AppliedBookUpdate } from "./BookTypes";
import {
  applyInformationalBookNotReadyFlow,
  applyRejectedBookDeltaFlow,
  bookDesyncStorageExtra
} from "./BookEarlyReturnRuntime";
import type { SortedBookSide } from "./SortedBookSide";

export interface TradingBookEarlyReturnHandlers {
  readonly observeExecutionProfile: (metrics: LatencyMetrics, trace: ExecutionTraceInput) => void;
  readonly storageWritesForState: (
    state: EngineState,
    extra?: Record<string, unknown>
  ) => Record<string, unknown>;
  readonly applyState: (state: EngineState) => void;
  readonly persistStorage: (writes: Record<string, unknown>, reason: string) => Promise<unknown>;
  readonly publishTickTelemetry: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    status: "FRESH",
    hotPathStartedAt: number
  ) => void;
}

export interface TradingInformationalBookNotReadyInput {
  readonly currentState: EngineState;
  readonly tradingEnabled: boolean;
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly maxLatencyMs: number;
  readonly wakeUpTimeMs: number | null;
  readonly orderBookUpdateMs: number;
  readonly hotPathStartedAt: number;
}

export interface TradingRejectedBookDeltaInput {
  readonly currentState: EngineState;
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly applied: AppliedBookUpdate;
  readonly maxLatencyMs: number;
  readonly wakeUpTimeMs: number | null;
  readonly orderBookUpdateMs: number;
  readonly hotPathStartedAt: number;
}

export function handleTradingInformationalBookNotReady(
  input: TradingInformationalBookNotReadyInput,
  handlers: TradingBookEarlyReturnHandlers
): Promise<TickIngestResult> {
  return applyInformationalBookNotReadyFlow(input, {
    observeExecutionProfile: handlers.observeExecutionProfile,
    storageWritesForState: (state) => handlers.storageWritesForState(state),
    applyState: handlers.applyState,
    persistStorage: (writes, reason) => handlers.persistStorage(writes, reason),
    publishTickTelemetry: handlers.publishTickTelemetry
  });
}

export function handleTradingRejectedBookDelta(
  input: TradingRejectedBookDeltaInput,
  handlers: TradingBookEarlyReturnHandlers
): Promise<TickIngestResult> {
  return applyRejectedBookDeltaFlow(
    {
      currentState: input.currentState,
      internalOrderBookDepth: countBookLevels(input.bids, input.asks),
      tick: input.tick,
      metrics: input.metrics,
      applied: input.applied,
      maxLatencyMs: input.maxLatencyMs,
      wakeUpTimeMs: input.wakeUpTimeMs,
      orderBookUpdateMs: input.orderBookUpdateMs,
      hotPathStartedAt: input.hotPathStartedAt
    },
    {
      observeExecutionProfile: handlers.observeExecutionProfile,
      storageWritesForState: handlers.storageWritesForState,
      bookDesyncStorageExtra,
      applyState: handlers.applyState,
      persistStorage: (writes, reason) => handlers.persistStorage(writes, reason),
      publishTickTelemetry: handlers.publishTickTelemetry
    }
  );
}
