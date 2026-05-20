import {
  DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS,
  TELEMETRY_BUFFER_LIMIT
} from "../../../TradingEngineConstants";
import { roundLatency } from "../helpers/RuntimeClock";
import {
  readPositiveInteger,
  readTelemetryNumber,
  shouldAggregateBusTelemetry
} from "../helpers/RuntimeParsing";
import { toJsonValue } from "../helpers/RuntimeSerialization";
import type { Env } from "../../../types";

export interface BusMessage {
  type: string;
  sequence: number;
  emittedAt: string;
  payload: Record<string, unknown>;
}

export interface TelemetryLogEntry {
  telemetryType: string;
  message: string;
  correlationId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface TickTelemetryAggregate {
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

interface EventTelemetryAggregate {
  telemetryType: string;
  count: number;
  firstObservedAt: string;
  lastObservedAt: string;
  latestPayload: Record<string, unknown>;
  latestCorrelationId: string | null;
}

export interface TradingTelemetryBusOptions {
  env: Env;
  adminSockets: Set<WebSocket>;
  waitUntil(promise: Promise<unknown>): void;
}

export class TradingTelemetryBus {
  private readonly telemetryBuffer: TelemetryLogEntry[] = [];
  private readonly eventTelemetryAggregates = new Map<string, EventTelemetryAggregate>();
  private tickTelemetryAggregate: TickTelemetryAggregate | null = null;
  private telemetryFlushScheduled = false;
  private busSequence = 0;

  constructor(private readonly options: TradingTelemetryBusOptions) {}

  publish(type: string, payload: Record<string, unknown>, correlationId?: string): BusMessage {
    const message: BusMessage = {
      type,
      sequence: this.nextSequence(),
      emittedAt: new Date().toISOString(),
      payload
    };

    this.broadcast(message);
    if (type === "TICK_TELEMETRY") {
      this.accumulateTickTelemetry(payload, message.emittedAt);
      this.scheduleTelemetryFlush();
      return message;
    }

    if (shouldAggregateBusTelemetry(type)) {
      this.accumulateEventTelemetry(type, payload, message.emittedAt, correlationId ?? null);
      this.scheduleTelemetryFlush();
      return message;
    }

    this.queueTelemetry({
      telemetryType: type,
      message: `Telemetry event: ${type}`,
      correlationId: correlationId ?? null,
      payload: {
        ...payload,
        busSequence: message.sequence,
        emittedAt: message.emittedAt
      },
      createdAt: message.emittedAt
    });

    return message;
  }

  nextSequence(): number {
    this.busSequence += 1;
    return this.busSequence;
  }

  broadcast(message: unknown): void {
    for (const socket of this.options.adminSockets) {
      this.sendSocketMessage(socket, message);
    }
  }

  queueTelemetry(entry: TelemetryLogEntry): void {
    this.telemetryBuffer.push(entry);

    if (this.telemetryBuffer.length > TELEMETRY_BUFFER_LIMIT) {
      this.telemetryBuffer.splice(0, this.telemetryBuffer.length - TELEMETRY_BUFFER_LIMIT);
    }

    this.scheduleTelemetryFlush();
  }

  telemetryFlushIntervalMs(): number {
    return readPositiveInteger(
      this.options.env.TELEMETRY_FLUSH_INTERVAL_MS,
      DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS,
      1_000,
      300_000
    );
  }

  flushNow(): Promise<void> {
    return this.flushTelemetryBatch();
  }

  private sendSocketMessage(socket: WebSocket, message: unknown): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      this.options.adminSockets.delete(socket);
      try {
        socket.close(1011, "TELEMETRY_SEND_FAILED");
      } catch {
        // Closing is best-effort; the runtime will collect dead sockets.
      }
    }
  }

  private accumulateEventTelemetry(
    type: string,
    payload: Record<string, unknown>,
    emittedAt: string,
    correlationId: string | null
  ): void {
    const current = this.eventTelemetryAggregates.get(type);

    if (!current) {
      this.eventTelemetryAggregates.set(type, {
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

  private consumeEventTelemetryAggregates(): TelemetryLogEntry[] {
    const entries: TelemetryLogEntry[] = [];

    for (const aggregate of this.eventTelemetryAggregates.values()) {
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
          flushIntervalMs: this.telemetryFlushIntervalMs()
        }
      });
    }

    this.eventTelemetryAggregates.clear();
    return entries;
  }

  private accumulateTickTelemetry(payload: Record<string, unknown>, emittedAt: string): void {
    const cpuTimeMs = readTelemetryNumber(payload.cpuTimeMs);
    const totalLatencyMs = readTelemetryNumber(payload.totalLatencyMs);
    const websocketLatencyMs = readTelemetryNumber(payload.websocketLatencyMs);
    const processingLatencyMs = readTelemetryNumber(payload.processingLatencyMs);
    const timeToBookMs = readTelemetryNumber(payload.timeToBookMs);
    const status =
      typeof payload.status === "string" && payload.status.length > 0 ? payload.status : null;

    const current = this.tickTelemetryAggregate ?? {
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
      current.maxProcessingLatencyMs = Math.max(
        current.maxProcessingLatencyMs,
        processingLatencyMs
      );
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

    this.tickTelemetryAggregate = current;
  }

  private consumeTickTelemetryAggregate(): TelemetryLogEntry | null {
    const aggregate = this.tickTelemetryAggregate;
    this.tickTelemetryAggregate = null;

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
        flushIntervalMs: this.telemetryFlushIntervalMs()
      }
    };
  }

  private scheduleTelemetryFlush(): void {
    if (this.telemetryFlushScheduled) {
      return;
    }

    this.telemetryFlushScheduled = true;
    const flush = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.flushTelemetryBatch()
          .then(resolve)
          .catch((error: unknown) => {
            console.error(
              "[Sovereign-Sigma] telemetry flush failed",
              error instanceof Error ? error.message : error
            );
            resolve();
          });
      }, this.telemetryFlushIntervalMs());
    });

    this.options.waitUntil(flush);
  }

  private async flushTelemetryBatch(): Promise<void> {
    const tickAggregate = this.consumeTickTelemetryAggregate();
    const eventAggregates = this.consumeEventTelemetryAggregates();
    const batch = [
      ...(tickAggregate ? [tickAggregate] : []),
      ...eventAggregates,
      ...this.telemetryBuffer.splice(0)
    ];
    this.telemetryFlushScheduled = false;

    if (batch.length === 0) {
      return;
    }

    const statements = batch.map((entry) =>
      this.options.env.TRADING_DB.prepare(
        `INSERT INTO logs
          (level, event_type, source, message, correlation_id, telemetry_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        "INFO",
        "TELEMETRY",
        "TradingEngine",
        entry.message,
        entry.correlationId,
        JSON.stringify(
          toJsonValue({
            telemetryType: entry.telemetryType,
            ...entry.payload
          })
        ),
        entry.createdAt
      )
    );

    try {
      await this.options.env.TRADING_DB.batch(statements);
    } catch (error) {
      console.error(
        "[Sovereign-Sigma] failed to write telemetry batch",
        error instanceof Error ? error.message : error
      );
    }

    if (
      this.telemetryBuffer.length > 0 ||
      this.tickTelemetryAggregate !== null ||
      this.eventTelemetryAggregates.size > 0
    ) {
      this.scheduleTelemetryFlush();
    }
  }
}
