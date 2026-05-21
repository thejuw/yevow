import { ANOMALY_DETECTOR_STORAGE_KEY } from "../../../agents/AnomalyDetector";
import type { AnomalyDetectionResult } from "../../../agents/AnomalyDetector";
import {
  DOM_WALL_HISTORY_KEY,
  ENGINE_STATE_KEY,
  ORDER_BOOK_PREFIX,
  PERFORMANCE_HISTORY_KEY,
  PROCESSING_LATENCY_SAMPLES_KEY
} from "../../../TradingEngineConstants";
import type {
  DomAnalysisSnapshot,
  EngineState,
  InternalOrderBook,
  JsonRecord,
  LatencyMetrics,
  LiquidityWall,
  MarketTick
} from "../../../types";
import { countBookLevels } from "../book/BookReconstruction";
import type { SortedBookSide } from "../book/SortedBookSide";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import { highResolutionNow, roundLatency } from "../helpers/RuntimeClock";
import type { ExecutionTraceInput } from "../performance/LatencyRuntime";
import {
  applyAnomalyEmergencyPauseFlow,
  emitAnomalyEmergencyPauseSideEffects,
  type AnomalyEmergencyPauseTelemetry
} from "./AnomalyRuntime";
import {
  observeTradingExecutionProfileForTarget,
  publishTradingTickTelemetryForTarget,
  type TradingHotPathTelemetryTarget
} from "../telemetry/TradingHotPathTelemetryRuntime";
import { publishTradingTelemetryForTarget } from "../telemetry/TelemetryBus";
import { putTradingStorageForTargetOrHandler } from "../state/StorageWriteGuard";

export type { AnomalyEmergencyPauseTelemetry };

export interface TradingAnomalyEmergencyHandlers {
  readonly writeCriticalLog: (source: string, message: string, metadata: JsonRecord) => void;
  readonly publish: (type: "EMERGENCY_PAUSE", payload: JsonRecord, correlationId: string) => void;
  readonly notify: (notification: AnomalyEmergencyPauseTelemetry["notification"]) => void;
}

export interface TradingAnomalyEmergencyPauseInput {
  readonly currentState: EngineState;
  readonly latencyHistory: readonly LatencyMetrics[];
  readonly processingLatencySamples: readonly number[];
  readonly domWallHistory: readonly LiquidityWall[];
  readonly anomalyResult: AnomalyDetectionResult;
  readonly book: InternalOrderBook;
  readonly tick: MarketTick;
  readonly domSnapshot: DomAnalysisSnapshot;
  readonly metrics: LatencyMetrics;
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
  readonly anomalyLogicStartedAt: number;
  readonly wakeUpTimeMs: number | null;
  readonly orderBookUpdateMs: number;
  readonly hotPathStartedAt: number;
}

export interface TradingAnomalyEmergencyPauseHandlers extends TradingAnomalyEmergencyHandlers {
  readonly observeExecutionProfile: (metrics: LatencyMetrics, trace: ExecutionTraceInput) => void;
  readonly applyState: (state: EngineState) => void;
  readonly persistStorageWrites: (writes: Record<string, unknown>) => Promise<void>;
  readonly publishTickTelemetry: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    status: "FRESH",
    hotPathStartedAt: number
  ) => void;
}

export interface TradingAnomalyEmergencyTarget {
  engineState: EngineState;
  readonly latencyHistory: readonly LatencyMetrics[];
  readonly processingLatencySamples: readonly number[];
  readonly domWallHistory: readonly LiquidityWall[];
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
  readonly logger: {
    writeLog(level: "CRITICAL", source: string, message: string, metadata: JsonRecord): void;
  };
  readonly notifier: {
    notify(notification: AnomalyEmergencyPauseTelemetry["notification"]): void;
  };
  observeExecutionProfile?(metrics: LatencyMetrics, trace: ExecutionTraceInput): void;
  safeStoragePut?(writes: Record<string, unknown>, reason: string): Promise<void>;
  publish?(type: "EMERGENCY_PAUSE", payload: JsonRecord, correlationId: string): void;
  publishTickTelemetry?(
    tick: MarketTick,
    metrics: LatencyMetrics,
    status: "FRESH",
    hotPathStartedAt: number
  ): void;
}

export function emitTradingAnomalyEmergencyPause(
  event: AnomalyEmergencyPauseTelemetry,
  handlers: TradingAnomalyEmergencyHandlers
): void {
  emitAnomalyEmergencyPauseSideEffects(event, handlers);
}

export function tradingAnomalyExecutionTrace(
  input: Pick<
    TradingAnomalyEmergencyPauseInput,
    "anomalyLogicStartedAt" | "wakeUpTimeMs" | "orderBookUpdateMs" | "hotPathStartedAt" | "metrics"
  >
): ExecutionTraceInput {
  return {
    wakeUpTimeMs: input.wakeUpTimeMs,
    orderBookUpdateMs: input.orderBookUpdateMs,
    agentLogicMs: roundLatency(highResolutionNow() - input.anomalyLogicStartedAt),
    hotPathStartedAt: input.hotPathStartedAt,
    observedAt: input.metrics.brainTimestamp
  };
}

export async function handleTradingAnomalyEmergencyPause(
  input: TradingAnomalyEmergencyPauseInput,
  handlers: TradingAnomalyEmergencyPauseHandlers
): Promise<TickIngestResult> {
  return applyAnomalyEmergencyPauseFlow(
    {
      currentState: input.currentState,
      engineStateKey: ENGINE_STATE_KEY,
      performanceHistoryKey: PERFORMANCE_HISTORY_KEY,
      latencyHistory: input.latencyHistory,
      processingLatencySamplesKey: PROCESSING_LATENCY_SAMPLES_KEY,
      processingLatencySamples: input.processingLatencySamples,
      domWallHistoryKey: DOM_WALL_HISTORY_KEY,
      domWallHistory: input.domWallHistory,
      anomalyDetectorStorageKey: ANOMALY_DETECTOR_STORAGE_KEY,
      anomalyResult: input.anomalyResult,
      orderBookPrefix: ORDER_BOOK_PREFIX,
      book: input.book,
      tick: input.tick,
      domSnapshot: input.domSnapshot,
      metrics: input.metrics,
      internalOrderBookDepth: countBookLevels(input.bids, input.asks),
      observedAt: input.metrics.brainTimestamp,
      executionTrace: tradingAnomalyExecutionTrace(input)
    },
    {
      observeExecutionProfile: handlers.observeExecutionProfile,
      applyState: handlers.applyState,
      persistStorageWrites: handlers.persistStorageWrites,
      emitEmergencyPause: (event) => {
        emitTradingAnomalyEmergencyPause(event, handlers);
      },
      publishTickTelemetry: handlers.publishTickTelemetry
    }
  );
}

export function handleTradingEngineAnomalyEmergencyPause(
  tick: MarketTick,
  book: InternalOrderBook,
  domSnapshot: DomAnalysisSnapshot,
  anomalyResult: AnomalyDetectionResult,
  anomalyLogicStartedAt: number,
  metrics: LatencyMetrics,
  wakeUpTimeMs: number | null,
  orderBookUpdateMs: number,
  hotPathStartedAt: number,
  target: TradingAnomalyEmergencyTarget
): Promise<TickIngestResult> {
  return handleTradingAnomalyEmergencyPause(
    {
      currentState: target.engineState,
      latencyHistory: target.latencyHistory,
      processingLatencySamples: target.processingLatencySamples,
      domWallHistory: target.domWallHistory,
      anomalyResult,
      book,
      tick,
      domSnapshot,
      metrics,
      bids: target.bids,
      asks: target.asks,
      anomalyLogicStartedAt,
      wakeUpTimeMs,
      orderBookUpdateMs,
      hotPathStartedAt
    },
    {
      observeExecutionProfile: (profileMetrics, trace) => {
        if (target.observeExecutionProfile) {
          target.observeExecutionProfile(profileMetrics, trace);
          return;
        }
        observeTradingExecutionProfileForTarget(
          profileMetrics,
          trace,
          target as unknown as TradingHotPathTelemetryTarget
        );
      },
      applyState: (state) => {
        target.engineState = state;
      },
      persistStorageWrites: (writes) =>
        putTradingStorageForTargetOrHandler(target, writes, "ANOMALY_EMERGENCY_PAUSE"),
      writeCriticalLog: (source, message, metadata) => {
        target.logger.writeLog("CRITICAL", source, message, metadata);
      },
      publish: (type, payload, correlationId) => {
        publishTradingTelemetryForTarget(target, type, payload, correlationId);
      },
      notify: (notification) => {
        target.notifier.notify(notification);
      },
      publishTickTelemetry: (telemetryTick, telemetryMetrics, status, telemetryStartedAt) => {
        if (target.publishTickTelemetry) {
          target.publishTickTelemetry(telemetryTick, telemetryMetrics, status, telemetryStartedAt);
          return;
        }
        publishTradingTickTelemetryForTarget(
          telemetryTick,
          telemetryMetrics,
          status,
          telemetryStartedAt,
          target as unknown as TradingHotPathTelemetryTarget
        );
      }
    }
  );
}
