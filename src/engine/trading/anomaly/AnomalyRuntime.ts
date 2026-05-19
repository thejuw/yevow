import type { AnomalyDetectionResult } from "../../../agents/AnomalyDetector";
import type {
  AnomalyStatus,
  DomAnalysisSnapshot,
  EngineState,
  InternalOrderBook,
  JsonRecord,
  LatencyMetrics,
  MarketTick
} from "../../../types";
import { microstructureFromBook } from "../book/BookReconstruction";

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
