import type { EngineState, GlobalRiskConfig, LatencyMetrics, MarketTick } from "../../../types";
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

export interface TradingBookEarlyReturnTarget {
  engineState: EngineState;
  readonly cachedConfig: Pick<GlobalRiskConfig, "TRADING_ENABLED">;
  readonly maxLatencyMs: number;
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
  observeExecutionProfile(metrics: LatencyMetrics, trace: ExecutionTraceInput): void;
  latencyStorageWritesForState(
    state: EngineState,
    extra?: Record<string, unknown>
  ): Record<string, unknown>;
  persistHotStorageSnapshot(writes: Record<string, unknown>, reason: string): Promise<unknown>;
  publishTickTelemetry(
    tick: MarketTick,
    metrics: LatencyMetrics,
    status: "FRESH",
    hotPathStartedAt: number
  ): void;
}

export function createTradingBookEarlyReturnHandlers(
  target: TradingBookEarlyReturnTarget
): TradingBookEarlyReturnHandlers {
  return {
    observeExecutionProfile: (profileMetrics, trace) => {
      target.observeExecutionProfile(profileMetrics, trace);
    },
    storageWritesForState: (state, extra) => target.latencyStorageWritesForState(state, extra),
    applyState: (state) => {
      target.engineState = state;
    },
    persistStorage: (writes, reason) => target.persistHotStorageSnapshot(writes, reason),
    publishTickTelemetry: (telemetryTick, telemetryMetrics, status, telemetryStartedAt) => {
      target.publishTickTelemetry(telemetryTick, telemetryMetrics, status, telemetryStartedAt);
    }
  };
}

export function handleTradingEngineInformationalBookNotReady(
  tick: MarketTick,
  metrics: LatencyMetrics,
  wakeUpTimeMs: number | null,
  orderBookUpdateMs: number,
  hotPathStartedAt: number,
  target: TradingBookEarlyReturnTarget
): Promise<TickIngestResult> {
  return handleTradingInformationalBookNotReady(
    {
      currentState: target.engineState,
      tradingEnabled: target.cachedConfig.TRADING_ENABLED,
      tick,
      metrics,
      maxLatencyMs: target.maxLatencyMs,
      wakeUpTimeMs,
      orderBookUpdateMs,
      hotPathStartedAt
    },
    createTradingBookEarlyReturnHandlers(target)
  );
}

export function handleTradingEngineRejectedBookDelta(
  tick: MarketTick,
  metrics: LatencyMetrics,
  applied: AppliedBookUpdate,
  wakeUpTimeMs: number | null,
  orderBookUpdateMs: number,
  hotPathStartedAt: number,
  target: TradingBookEarlyReturnTarget
): Promise<TickIngestResult> {
  return handleTradingRejectedBookDelta(
    {
      currentState: target.engineState,
      bids: target.bids,
      asks: target.asks,
      tick,
      metrics,
      applied,
      maxLatencyMs: target.maxLatencyMs,
      wakeUpTimeMs,
      orderBookUpdateMs,
      hotPathStartedAt
    },
    createTradingBookEarlyReturnHandlers(target)
  );
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
