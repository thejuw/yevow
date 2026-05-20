import { aggregateQuoteState, suspendAssetQuoteStates } from "../state/AssetStateRuntime";
import type { EngineState, JsonRecord, LatencyMetrics, MarketTick } from "../../../types";
import type { TickIngestResult } from "../TradingEngineRouteTypes";

export interface HardStaleTickDropInput {
  readonly currentState: EngineState;
  readonly metrics: LatencyMetrics;
  readonly hardStaleDropMs: number;
}

export interface HardStaleTickDropResult {
  readonly state: EngineState;
  readonly metrics: LatencyMetrics;
  readonly nextStaleTickCount: number;
  readonly shouldResetLatencyBaseline: boolean;
}

export interface HardStaleTickDropTelemetryInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly streamId: string | null;
  readonly hardStaleDropMs: number;
}

export interface HardStaleTickDropArtifactsInput extends HardStaleTickDropTelemetryInput {
  readonly nextStaleTickCount: number;
}

export interface HardStaleTickDropArtifacts {
  readonly shouldLog: boolean;
  readonly logMetadata: JsonRecord;
  readonly telemetryPayload: JsonRecord;
  readonly ingestResult: TickIngestResult;
}

export interface HardStaleTickDropSideEffectInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly artifacts: HardStaleTickDropArtifacts;
  readonly tradingEnabled: boolean;
}

export interface HardStaleTickDropSideEffectHandlers {
  readonly warnHardStale: (metadata: JsonRecord) => void;
  readonly logPerformance: (metrics: LatencyMetrics) => void;
  readonly publishPull: (payload: JsonRecord) => void;
  readonly schedule: (work: Promise<unknown>) => void;
  readonly cancelAllQuotes: (instrumentCode: string, reason: "HARD_STALE_DROP") => Promise<unknown>;
}

export interface HardStaleTickDropFlowInput {
  readonly currentState: EngineState;
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly streamId: string | null;
  readonly hardStaleDropMs: number;
  readonly tradingEnabled: boolean;
}

export interface HardStaleTickDropFlowHandlers extends HardStaleTickDropSideEffectHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly resetLatencyBaseline: (observedAt: string, reason: "HARD_STALE_DROP") => void;
  readonly persistLatencySnapshot: (reason: "HARD_STALE_TICK_DROPPED") => Promise<void>;
}

export function stateAfterHardStaleTickDrop(
  input: HardStaleTickDropInput
): HardStaleTickDropResult {
  const nextStaleTickCount = input.currentState.staleTickCount + 1;
  const metrics: LatencyMetrics = {
    ...input.metrics,
    status: "STALE",
    maxLatencyMs: input.hardStaleDropMs,
    averageLatencyMs: input.currentState.averageLatency,
    sampleCount: input.currentState.latencySampleCount
  };
  const assetQuoteStates = suspendAssetQuoteStates(
    input.currentState.assetQuoteStates,
    "HARD_STALE_DROP",
    metrics.brainTimestamp,
    { lastQuote: input.currentState.quoteState.lastQuote }
  );

  return {
    metrics,
    nextStaleTickCount,
    shouldResetLatencyBaseline: input.currentState.averageLatency > input.hardStaleDropMs,
    state: {
      ...input.currentState,
      processedTicks: input.currentState.processedTicks + 1,
      staleTickCount: nextStaleTickCount,
      quoteState: aggregateQuoteState(
        assetQuoteStates,
        input.currentState.quoteState,
        metrics.brainTimestamp
      ),
      assetQuoteStates,
      heartbeatAt: metrics.brainTimestamp,
      updatedAt: metrics.brainTimestamp
    }
  };
}

export function shouldLogHardStaleTickDrop(nextStaleTickCount: number): boolean {
  return nextStaleTickCount <= 5 || nextStaleTickCount % 500 === 0;
}

export function buildHardStaleTickDropArtifacts(
  input: HardStaleTickDropArtifactsInput
): HardStaleTickDropArtifacts {
  return {
    shouldLog: shouldLogHardStaleTickDrop(input.nextStaleTickCount),
    logMetadata: hardStaleTickDropLogMetadata(input),
    telemetryPayload: hardStalePullTelemetryPayload(input),
    ingestResult: {
      accepted: false,
      status: "STALE_DROPPED",
      reason: "TICK_EXCEEDED_HARD_STALE_THRESHOLD",
      metrics: input.metrics
    }
  };
}

export function hardStaleTickDropLogMetadata(input: HardStaleTickDropTelemetryInput): JsonRecord {
  return {
    instrumentCode: input.tick.instrumentCode,
    exchangeCode: input.tick.exchangeCode,
    source_exchange: input.tick.source_exchange,
    transport: input.tick.transport,
    streamId: input.streamId,
    sequence: input.tick.sequence,
    totalLatencyMs: input.metrics.totalLatencyMs,
    networkLatencyMs: input.metrics.networkLatencyMs,
    processingLatencyMs: input.metrics.processingLatencyMs,
    hardStaleDropMs: input.hardStaleDropMs
  };
}

export function hardStalePullTelemetryPayload(input: HardStaleTickDropTelemetryInput): JsonRecord {
  return {
    instrumentCode: input.tick.instrumentCode,
    exchangeCode: input.tick.exchangeCode,
    source_exchange: input.tick.source_exchange,
    transport: input.tick.transport,
    streamId: input.streamId,
    sequence: input.tick.sequence,
    totalLatencyMs: input.metrics.totalLatencyMs,
    maxLatencyMs: input.hardStaleDropMs,
    action: "PULL_ALL_QUOTES",
    source: "NATIVE_HYPERLIQUID"
  };
}

export function applyHardStaleTickDropSideEffects(
  input: HardStaleTickDropSideEffectInput,
  handlers: HardStaleTickDropSideEffectHandlers
): void {
  if (input.artifacts.shouldLog) {
    handlers.warnHardStale(input.artifacts.logMetadata);
  }

  handlers.logPerformance(input.metrics);
  handlers.publishPull(input.artifacts.telemetryPayload);

  if (input.tradingEnabled) {
    handlers.schedule(handlers.cancelAllQuotes(input.tick.instrumentCode, "HARD_STALE_DROP"));
  }
}

export async function applyHardStaleTickDropFlow(
  input: HardStaleTickDropFlowInput,
  handlers: HardStaleTickDropFlowHandlers
): Promise<TickIngestResult> {
  const hardStale = stateAfterHardStaleTickDrop({
    currentState: input.currentState,
    metrics: input.metrics,
    hardStaleDropMs: input.hardStaleDropMs
  });
  handlers.applyState(hardStale.state);

  if (hardStale.shouldResetLatencyBaseline) {
    handlers.resetLatencyBaseline(hardStale.metrics.brainTimestamp, "HARD_STALE_DROP");
  }

  await handlers.persistLatencySnapshot("HARD_STALE_TICK_DROPPED");

  const artifacts = buildHardStaleTickDropArtifacts({
    tick: input.tick,
    metrics: hardStale.metrics,
    streamId: input.streamId,
    hardStaleDropMs: input.hardStaleDropMs,
    nextStaleTickCount: hardStale.nextStaleTickCount
  });

  applyHardStaleTickDropSideEffects(
    {
      tick: input.tick,
      metrics: hardStale.metrics,
      artifacts,
      tradingEnabled: input.tradingEnabled
    },
    handlers
  );

  return artifacts.ingestResult;
}
