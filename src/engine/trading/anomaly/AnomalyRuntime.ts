import type { AnomalyDetectionResult } from "../../../agents/AnomalyDetector";
import type {
  AnomalyStatus,
  DomAnalysisSnapshot,
  EngineState,
  InternalOrderBook,
  JsonRecord,
  LatencyMetrics,
  LiquidityWall,
  MarketTick
} from "../../../types";
import { microstructureFromBook } from "../book/BookReconstruction";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { ExecutionTraceInput } from "../performance/LatencyRuntime";

export interface AnomalyEmergencyPauseStateInput {
  readonly currentState: EngineState;
  readonly book: InternalOrderBook;
  readonly dom: DomAnalysisSnapshot;
  readonly anomaly: AnomalyStatus;
  readonly internalOrderBookDepth: number;
  readonly observedAt: string;
}

export interface AnomalyEmergencyPauseTelemetryInput {
  readonly tick: MarketTick;
  readonly book: InternalOrderBook;
  readonly domSnapshot: DomAnalysisSnapshot;
  readonly anomalyResult: AnomalyDetectionResult;
  readonly metrics: LatencyMetrics;
  readonly engineState: EngineState;
}

export interface AnomalyEmergencyPauseStorageInput {
  readonly engineStateKey: string;
  readonly state: EngineState;
  readonly performanceHistoryKey: string;
  readonly latencyHistory: readonly LatencyMetrics[];
  readonly processingLatencySamplesKey: string;
  readonly processingLatencySamples: readonly number[];
  readonly domWallHistoryKey: string;
  readonly domWallHistory: readonly LiquidityWall[];
  readonly anomalyDetectorStorageKey: string;
  readonly anomalyResult: AnomalyDetectionResult;
  readonly orderBookPrefix: string;
  readonly book: InternalOrderBook;
  readonly tick: MarketTick;
}

export interface AnomalyEmergencyPauseTelemetry {
  readonly correlationId: string;
  readonly logMetadata: JsonRecord;
  readonly payload: JsonRecord;
  readonly notification: {
    readonly priority: "CRITICAL";
    readonly title: string;
    readonly message: string;
    readonly dedupeKey: string;
    readonly metadata: JsonRecord;
  };
}

export interface AnomalyEmergencyPauseArtifactsInput extends Omit<
  AnomalyEmergencyPauseStorageInput,
  "state"
> {
  readonly currentState: EngineState;
  readonly domSnapshot: DomAnalysisSnapshot;
  readonly metrics: LatencyMetrics;
  readonly internalOrderBookDepth: number;
  readonly observedAt: string;
}

export interface AnomalyEmergencyPauseArtifacts {
  readonly state: EngineState;
  readonly storageWrites: Record<string, unknown>;
  readonly event: AnomalyEmergencyPauseTelemetry;
  readonly result: TickIngestResult;
}

export interface AnomalyEmergencyPauseSideEffectHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly persistStorageWrites: (writes: Record<string, unknown>) => Promise<void>;
  readonly emitEmergencyPause: (event: AnomalyEmergencyPauseTelemetry) => void;
}

export interface AnomalyEmergencyPauseFlowInput extends AnomalyEmergencyPauseArtifactsInput {
  readonly executionTrace: ExecutionTraceInput;
}

export interface AnomalyEmergencyPauseFlowHandlers extends AnomalyEmergencyPauseSideEffectHandlers {
  readonly observeExecutionProfile: (metrics: LatencyMetrics, trace: ExecutionTraceInput) => void;
  readonly publishTickTelemetry: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    status: "FRESH",
    hotPathStartedAt: number
  ) => void;
}

export interface AnomalyEmergencyPauseEmitHandlers {
  readonly writeCriticalLog: (source: string, message: string, metadata: JsonRecord) => void;
  readonly publish: (type: "EMERGENCY_PAUSE", payload: JsonRecord, correlationId: string) => void;
  readonly notify: (notification: AnomalyEmergencyPauseTelemetry["notification"]) => void;
}

export function stateAfterAnomalyEmergencyPause(
  input: AnomalyEmergencyPauseStateInput
): EngineState {
  return {
    ...input.currentState,
    mode: "HALTED",
    processedTicks: input.currentState.processedTicks + 1,
    internalOrderBookDepth: input.internalOrderBookDepth,
    microstructure: microstructureFromBook(input.book),
    dom: input.dom,
    anomaly: input.anomaly,
    risk: {
      ...input.currentState.risk,
      killSwitch: true,
      updatedAt: input.observedAt
    },
    heartbeatAt: input.observedAt,
    updatedAt: input.observedAt
  };
}

export function buildAnomalyEmergencyPauseTelemetry(
  input: AnomalyEmergencyPauseTelemetryInput
): AnomalyEmergencyPauseTelemetry {
  const primaryAnomaly = input.anomalyResult.anomalies[0] ?? null;
  const correlationId =
    primaryAnomaly?.anomalyId ?? `${input.tick.instrumentCode}:${input.tick.sequence}:anomaly`;
  const anomalyTypes = input.anomalyResult.anomalies.flatMap((event) => event.types);
  const severity = primaryAnomaly?.severity ?? "CRITICAL";
  const reason = primaryAnomaly?.reason ?? "ANOMALY_DETECTED";
  const marketSnapshot = {
    tick: input.tick,
    book: input.book,
    dom: input.domSnapshot,
    latency: input.metrics,
    anomaly: input.anomalyResult.status,
    anomalies: input.anomalyResult.anomalies,
    engineState: {
      engineId: input.engineState.engineId,
      mode: input.engineState.mode,
      risk: input.engineState.risk,
      microstructure: input.engineState.microstructure,
      executionProfile: input.engineState.executionProfile,
      toxicityScore: input.engineState.toxicityScore,
      processedTicks: input.engineState.processedTicks,
      location: input.engineState.location
    }
  };

  return {
    correlationId,
    logMetadata: {
      eventType: "MARKET_ANOMALY_EMERGENCY_PAUSE",
      correlationId,
      anomalyTypes,
      severity,
      reason,
      marketSnapshot
    } as unknown as JsonRecord,
    payload: {
      anomalyTypes,
      severity,
      reason,
      instrumentCode: input.tick.instrumentCode,
      exchangeCode: input.tick.exchangeCode,
      sequence: input.tick.sequence,
      priceZScore: input.anomalyResult.status.priceZScore,
      volumeZScore: input.anomalyResult.status.volumeZScore,
      cancellationToExecutionRatio: input.anomalyResult.status.cancellationToExecutionRatio,
      mode: input.engineState.mode,
      killSwitch: input.engineState.risk.killSwitch
    },
    notification: {
      priority: "CRITICAL",
      title: "Sovereign-Sigma emergency pause",
      message: `${input.tick.instrumentCode} halted by anomaly detector: ${reason}`,
      dedupeKey: `emergency:${input.tick.instrumentCode}:${severity}`,
      metadata: {
        instrumentCode: input.tick.instrumentCode,
        sequence: input.tick.sequence,
        anomalyTypes,
        mode: input.engineState.mode
      }
    }
  };
}

export function anomalyEmergencyPauseStorageWrites(
  input: AnomalyEmergencyPauseStorageInput
): Record<string, unknown> {
  return {
    [input.engineStateKey]: input.state,
    [input.performanceHistoryKey]: input.latencyHistory,
    [input.processingLatencySamplesKey]: input.processingLatencySamples,
    [input.domWallHistoryKey]: input.domWallHistory,
    [input.anomalyDetectorStorageKey]: input.anomalyResult.state,
    [`${input.orderBookPrefix}${input.book.marketKey}`]: input.book,
    [`lastTick:${input.book.marketKey}`]: input.tick,
    [`anomaly:${input.book.marketKey}:${input.tick.sequence}`]: input.anomalyResult.anomalies
  };
}

export function anomalyEmergencyPauseArtifacts(
  input: AnomalyEmergencyPauseArtifactsInput
): AnomalyEmergencyPauseArtifacts {
  const state = stateAfterAnomalyEmergencyPause({
    currentState: input.currentState,
    book: input.book,
    dom: input.domSnapshot,
    anomaly: input.anomalyResult.status,
    internalOrderBookDepth: input.internalOrderBookDepth,
    observedAt: input.observedAt
  });

  return {
    state,
    storageWrites: anomalyEmergencyPauseStorageWrites({
      engineStateKey: input.engineStateKey,
      state,
      performanceHistoryKey: input.performanceHistoryKey,
      latencyHistory: input.latencyHistory,
      processingLatencySamplesKey: input.processingLatencySamplesKey,
      processingLatencySamples: input.processingLatencySamples,
      domWallHistoryKey: input.domWallHistoryKey,
      domWallHistory: input.domWallHistory,
      anomalyDetectorStorageKey: input.anomalyDetectorStorageKey,
      anomalyResult: input.anomalyResult,
      orderBookPrefix: input.orderBookPrefix,
      book: input.book,
      tick: input.tick
    }),
    event: buildAnomalyEmergencyPauseTelemetry({
      tick: input.tick,
      book: input.book,
      domSnapshot: input.domSnapshot,
      anomalyResult: input.anomalyResult,
      metrics: input.metrics,
      engineState: state
    }),
    result: {
      accepted: false,
      status: "ANOMALY_PAUSE",
      reason: input.anomalyResult.anomalies.map((event) => event.types.join("+")).join(","),
      metrics: input.metrics,
      book: input.book
    }
  };
}

export async function applyAnomalyEmergencyPauseSideEffects(
  artifacts: AnomalyEmergencyPauseArtifacts,
  handlers: AnomalyEmergencyPauseSideEffectHandlers
): Promise<void> {
  handlers.applyState(artifacts.state);
  await handlers.persistStorageWrites(artifacts.storageWrites);
  handlers.emitEmergencyPause(artifacts.event);
}

export async function applyAnomalyEmergencyPauseFlow(
  input: AnomalyEmergencyPauseFlowInput,
  handlers: AnomalyEmergencyPauseFlowHandlers
): Promise<TickIngestResult> {
  handlers.observeExecutionProfile(input.metrics, input.executionTrace);

  const artifacts = anomalyEmergencyPauseArtifacts(input);
  await applyAnomalyEmergencyPauseSideEffects(artifacts, handlers);
  handlers.publishTickTelemetry(
    input.tick,
    input.metrics,
    "FRESH",
    input.executionTrace.hotPathStartedAt
  );

  return artifacts.result;
}

export function emitAnomalyEmergencyPauseSideEffects(
  event: AnomalyEmergencyPauseTelemetry,
  handlers: AnomalyEmergencyPauseEmitHandlers
): void {
  handlers.writeCriticalLog(
    "TradingEngine",
    "Emergency pause triggered by market anomaly detector",
    event.logMetadata
  );
  handlers.publish("EMERGENCY_PAUSE", event.payload, event.correlationId);
  handlers.notify(event.notification);
}
