import { roundLatency } from "../helpers/RuntimeClock";
import { readTelemetryNumber } from "../helpers/RuntimeParsing";

export interface TelemetryLogEntry {
  telemetryType: string;
  message: string;
  correlationId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface TickTelemetryAggregate {
  count: number;
  freshCount: number;
  staleCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  latestInstrumentCode: string | null;
  latestExchangeCode: string | null;
  latestSequence: number | null;
  latestStatus: string | null;
  latestColo: string | null;
  latestPlacement: string | null;
  latestIsGoldenRegion: boolean | null;
  latestLatencyRiskMultiplier: number | null;
  sumCpuTimeMs: number;
  sumTotalLatencyMs: number;
  sumWebsocketLatencyMs: number;
  sumProcessingLatencyMs: number;
  sumTimeToBookMs: number;
  timeToBookSamples: number;
  maxTotalLatencyMs: number;
  maxWebsocketLatencyMs: number;
  maxProcessingLatencyMs: number;
  maxTimeToBookMs: number | null;
  latestAverageLatencyMs: number | null;
  latestOrderBookDepth: number | null;
  latestToxicityScore: number | null;
  latestJitterMs: number | null;
  latestExecutionStatus: string | null;
  latestWeightedImbalance: number | null;
  latestMidPrice: number | null;
}

export interface EventTelemetryAggregate {
  telemetryType: string;
  count: number;
  firstObservedAt: string;
  lastObservedAt: string;
  latestPayload: Record<string, unknown>;
  latestCorrelationId: string | null;
}

export function accumulateEventTelemetryAggregate(
  aggregates: Map<string, EventTelemetryAggregate>,
  type: string,
  payload: Record<string, unknown>,
  emittedAt: string,
  correlationId: string | null
): void {
  const current = aggregates.get(type);

  if (!current) {
    aggregates.set(type, {
      telemetryType: type,
      count: 1,
      firstObservedAt: emittedAt,
      lastObservedAt: emittedAt,
      latestPayload: payload,
      latestCorrelationId: correlationId
    });
    return;
  }

  current.count += 1;
  current.lastObservedAt = emittedAt;
  current.latestPayload = payload;
  current.latestCorrelationId = correlationId;
}

export function consumeEventTelemetryAggregateEntries(
  aggregates: Map<string, EventTelemetryAggregate>,
  flushIntervalMs: number
): TelemetryLogEntry[] {
  const entries: TelemetryLogEntry[] = [];

  for (const aggregate of aggregates.values()) {
    entries.push({
      telemetryType: `${aggregate.telemetryType}_AGGREGATE`,
      message: `Aggregated ${aggregate.telemetryType} telemetry`,
      correlationId:
        aggregate.latestCorrelationId ??
        `${aggregate.telemetryType.toLowerCase()}:${aggregate.firstObservedAt}`,
      createdAt: aggregate.lastObservedAt,
      payload: {
        telemetryType: aggregate.telemetryType,
        count: aggregate.count,
        firstObservedAt: aggregate.firstObservedAt,
        lastObservedAt: aggregate.lastObservedAt,
        latestPayload: aggregate.latestPayload,
        flushIntervalMs
      }
    });
  }

  aggregates.clear();
  return entries;
}

export function accumulateTickTelemetryAggregate(
  aggregate: TickTelemetryAggregate | null,
  payload: Record<string, unknown>,
  emittedAt: string
): TickTelemetryAggregate {
  const cpuTimeMs = readTelemetryNumber(payload.cpuTimeMs);
  const totalLatencyMs = readTelemetryNumber(payload.totalLatencyMs);
  const websocketLatencyMs = readTelemetryNumber(payload.websocketLatencyMs);
  const processingLatencyMs = readTelemetryNumber(payload.processingLatencyMs);
  const timeToBookMs = readTelemetryNumber(payload.timeToBookMs);
  const status =
    typeof payload.status === "string" && payload.status.length > 0 ? payload.status : null;

  const current = aggregate ?? {
    count: 0,
    freshCount: 0,
    staleCount: 0,
    firstObservedAt: emittedAt,
    lastObservedAt: emittedAt,
    latestInstrumentCode: null,
    latestExchangeCode: null,
    latestSequence: null,
    latestStatus: null,
    latestColo: null,
    latestPlacement: null,
    latestIsGoldenRegion: null,
    latestLatencyRiskMultiplier: null,
    sumCpuTimeMs: 0,
    sumTotalLatencyMs: 0,
    sumWebsocketLatencyMs: 0,
    sumProcessingLatencyMs: 0,
    sumTimeToBookMs: 0,
    timeToBookSamples: 0,
    maxTotalLatencyMs: 0,
    maxWebsocketLatencyMs: 0,
    maxProcessingLatencyMs: 0,
    maxTimeToBookMs: null,
    latestAverageLatencyMs: null,
    latestOrderBookDepth: null,
    latestToxicityScore: null,
    latestJitterMs: null,
    latestExecutionStatus: null,
    latestWeightedImbalance: null,
    latestMidPrice: null
  };

  current.count += 1;
  current.freshCount += status === "FRESH" ? 1 : 0;
  current.staleCount += status === "STALE" ? 1 : 0;
  current.lastObservedAt = emittedAt;
  current.latestInstrumentCode =
    typeof payload.instrumentCode === "string"
      ? payload.instrumentCode
      : current.latestInstrumentCode;
  current.latestExchangeCode =
    typeof payload.exchangeCode === "string" ? payload.exchangeCode : current.latestExchangeCode;
  current.latestSequence =
    typeof payload.sequence === "number" && Number.isFinite(payload.sequence)
      ? payload.sequence
      : current.latestSequence;
  current.latestStatus = status ?? current.latestStatus;
  current.latestColo = typeof payload.colo === "string" ? payload.colo : current.latestColo;
  current.latestPlacement =
    typeof payload.placement === "string" ? payload.placement : current.latestPlacement;
  current.latestIsGoldenRegion =
    typeof payload.isGoldenRegion === "boolean"
      ? payload.isGoldenRegion
      : current.latestIsGoldenRegion;
  current.latestLatencyRiskMultiplier =
    readTelemetryNumber(payload.latencyRiskMultiplier) ?? current.latestLatencyRiskMultiplier;

  if (cpuTimeMs !== null) {
    current.sumCpuTimeMs += cpuTimeMs;
  }
  if (totalLatencyMs !== null) {
    current.sumTotalLatencyMs += totalLatencyMs;
    current.maxTotalLatencyMs = Math.max(current.maxTotalLatencyMs, totalLatencyMs);
  }
  if (websocketLatencyMs !== null) {
    current.sumWebsocketLatencyMs += websocketLatencyMs;
    current.maxWebsocketLatencyMs = Math.max(current.maxWebsocketLatencyMs, websocketLatencyMs);
  }
  if (processingLatencyMs !== null) {
    current.sumProcessingLatencyMs += processingLatencyMs;
    current.maxProcessingLatencyMs = Math.max(current.maxProcessingLatencyMs, processingLatencyMs);
  }
  if (timeToBookMs !== null) {
    current.sumTimeToBookMs += timeToBookMs;
    current.timeToBookSamples += 1;
    current.maxTimeToBookMs =
      current.maxTimeToBookMs === null
        ? timeToBookMs
        : Math.max(current.maxTimeToBookMs, timeToBookMs);
  }

  current.latestAverageLatencyMs = readTelemetryNumber(payload.averageLatencyMs);
  current.latestOrderBookDepth = readTelemetryNumber(payload.orderBookDepth);
  current.latestToxicityScore = readTelemetryNumber(payload.toxicityScore);
  current.latestJitterMs = readTelemetryNumber(payload.jitterMs);
  current.latestExecutionStatus =
    typeof payload.executionStatus === "string"
      ? payload.executionStatus
      : current.latestExecutionStatus;
  current.latestWeightedImbalance = readTelemetryNumber(payload.weightedImbalance);
  current.latestMidPrice = readTelemetryNumber(payload.midPrice);

  return current;
}

export function consumeTickTelemetryAggregateEntry(
  aggregate: TickTelemetryAggregate | null,
  flushIntervalMs: number
): TelemetryLogEntry | null {
  if (!aggregate || aggregate.count === 0) {
    return null;
  }

  const average = (sum: number): number => roundLatency(sum / aggregate.count);

  return {
    telemetryType: "TICK_TELEMETRY_AGGREGATE",
    message: "Aggregated tick telemetry",
    correlationId: `tick-telemetry:${aggregate.firstObservedAt}`,
    createdAt: aggregate.lastObservedAt,
    payload: {
      ...aggregate,
      averageCpuTimeMs: average(aggregate.sumCpuTimeMs),
      averageTotalLatencyMs: average(aggregate.sumTotalLatencyMs),
      averageWebsocketLatencyMs: average(aggregate.sumWebsocketLatencyMs),
      averageProcessingLatencyMs: average(aggregate.sumProcessingLatencyMs),
      averageTimeToBookMs:
        aggregate.timeToBookSamples > 0
          ? roundLatency(aggregate.sumTimeToBookMs / aggregate.timeToBookSamples)
          : null,
      flushIntervalMs
    }
  };
}
