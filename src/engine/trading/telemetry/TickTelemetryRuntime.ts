import type {
  AgentSignal,
  BayesianUpdateTrace,
  EngineState,
  JsonRecord,
  LatencyMetrics,
  MacroBias,
  MarketTick,
  TemporaryGovernanceOverride
} from "../../../types";

export interface TickTelemetryPayloadInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly status: LatencyMetrics["status"];
  readonly cpuTimeMs: number;
  readonly engineState: EngineState;
  readonly macroBias: MacroBias;
  readonly temporaryOverride: TemporaryGovernanceOverride | null;
  readonly connectedAdminStreams: number;
  readonly signals: readonly AgentSignal[];
}

export interface TickTelemetryPayloadResult {
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

export function shouldLogMarketTickAccepted(processedTicks: number): boolean {
  return processedTicks <= 5 || processedTicks % 1_000 === 0;
}

export function marketTickAcceptedLogMetadata(input: {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly processedTicks: number;
  readonly averageLatencyMs: number;
}): JsonRecord {
  return {
    instrumentCode: input.tick.instrumentCode,
    exchangeCode: input.tick.exchangeCode,
    sequence: input.tick.sequence,
    processedTicks: input.processedTicks,
    totalLatencyMs: input.metrics.totalLatencyMs,
    averageLatencyMs: input.averageLatencyMs
  };
}

export function shouldLogBayesianPosteriorUpdate(input: {
  readonly trace: BayesianUpdateTrace | null;
  readonly processedTicks: number;
  readonly interval: number;
}): boolean {
  return input.trace !== null && input.interval > 0 && input.processedTicks % input.interval === 0;
}

export function bayesianPosteriorUpdatedLogMetadata(input: {
  readonly instrumentCode: string;
  readonly trace: BayesianUpdateTrace;
}): JsonRecord {
  return {
    instrumentCode: input.instrumentCode,
    ...(input.trace as unknown as JsonRecord)
  };
}

export function buildTickTelemetryPayload(
  input: TickTelemetryPayloadInput
): TickTelemetryPayloadResult {
  const state = input.engineState;

  return {
    payload: {
      instrumentCode: input.tick.instrumentCode,
      exchangeCode: input.tick.exchangeCode,
      sequence: input.tick.sequence,
      status: input.status,
      cpuTimeMs: input.cpuTimeMs,
      websocketLatencyMs: input.metrics.networkLatencyMs,
      processingLatencyMs: input.metrics.processingLatencyMs,
      totalLatencyMs: input.metrics.totalLatencyMs,
      timeToBookMs: input.metrics.timeToBookMs ?? null,
      orderBookDepth: state.internalOrderBookDepth,
      averageLatencyMs: state.averageLatency,
      staleTickCount: state.staleTickCount,
      toxicityScore: state.toxicityScore,
      jitterMs: state.executionProfile.jitterMs,
      executionStatus: state.executionProfile.status,
      wakeUpTimeMs: state.executionProfile.wakeUpTimeMs,
      orderBookUpdateMs: state.executionProfile.orderBookUpdateMs,
      agentLogicMs: state.executionProfile.agentLogicMs,
      liquidityWallCount: state.dom?.walls.length ?? 0,
      pulledWallCount: state.dom?.pulledWalls.length ?? 0,
      filledWallCount: state.dom?.filledWalls.length ?? 0,
      heatmapCells: state.dom?.heatmap.cells.length ?? 0,
      anomalyStatus: state.anomaly.status,
      priceZScore: state.anomaly.priceZScore,
      volumeZScore: state.anomaly.volumeZScore,
      cancellationToExecutionRatio: state.anomaly.cancellationToExecutionRatio,
      colo: state.location.colo,
      placement: state.location.placement,
      isGoldenRegion: state.location.isGoldenRegion,
      latencyRiskMultiplier: state.location.latencyRiskMultiplier,
      positionSizeMultiplier: state.location.positionSizeMultiplier,
      netDelta: state.inventory.netDelta,
      maxInventoryUnits: state.inventory.maxInventoryUnits,
      inventoryPenalty: state.inventory.inventoryPenalty,
      stopBid: state.inventory.stopBid,
      stopAsk: state.inventory.stopAsk,
      weightedImbalance: state.microstructure.weightedImbalance,
      midPrice: state.microstructure.midPrice,
      macroBias: input.macroBias,
      temporaryOverride: input.temporaryOverride,
      connectedAdminStreams: input.connectedAdminStreams,
      RegimeCoefficient: state.oracle.skepticismMultiplier,
      AgentLogicTrace: input.signals.slice(-5).map((signal) => ({
        agent: signal.sourceAgent,
        action: signal.action,
        confidence: signal.confidence,
        rationale: signal.rationale,
        createdAt: signal.createdAt
      }))
    },
    correlationId: `${input.tick.instrumentCode}:${input.tick.sequence}`
  };
}
