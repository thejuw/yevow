import {
  DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS,
  TELEMETRY_BUFFER_LIMIT
} from "../../../TradingEngineConstants";
import {
  accumulateEventTelemetryAggregate,
  accumulateTickTelemetryAggregate,
  consumeEventTelemetryAggregateEntries,
  consumeTickTelemetryAggregateEntry,
  type EventTelemetryAggregate,
  type TelemetryLogEntry,
  type TickTelemetryAggregate
} from "./TelemetryAggregateRuntime";
import { readPositiveInteger, shouldAggregateBusTelemetry } from "../helpers/RuntimeParsing";
import { toJsonValue } from "../helpers/RuntimeSerialization";
import type { Env } from "../../../types";

export interface BusMessage {
  type: string;
  sequence: number;
  emittedAt: string;
  payload: Record<string, unknown>;
}
export type { TelemetryLogEntry } from "./TelemetryAggregateRuntime";

export interface TradingTelemetryPublisherTarget {
  readonly telemetryBus?: {
    publish(type: string, payload: Record<string, unknown>, correlationId?: string): unknown;
  };
  publish?(type: string, payload: Record<string, unknown>, correlationId?: string): void;
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
    accumulateEventTelemetryAggregate(
      this.eventTelemetryAggregates,
      type,
      payload,
      emittedAt,
      correlationId
    );
  }

  private consumeEventTelemetryAggregates(): TelemetryLogEntry[] {
    return consumeEventTelemetryAggregateEntries(
      this.eventTelemetryAggregates,
      this.telemetryFlushIntervalMs()
    );
  }

  private accumulateTickTelemetry(payload: Record<string, unknown>, emittedAt: string): void {
    this.tickTelemetryAggregate = accumulateTickTelemetryAggregate(
      this.tickTelemetryAggregate,
      payload,
      emittedAt
    );
  }

  private consumeTickTelemetryAggregate(): TelemetryLogEntry | null {
    const aggregate = this.tickTelemetryAggregate;
    this.tickTelemetryAggregate = null;
    return consumeTickTelemetryAggregateEntry(aggregate, this.telemetryFlushIntervalMs());
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

export function publishTradingTelemetryForTarget(
  target: TradingTelemetryPublisherTarget,
  type: string,
  payload: Record<string, unknown>,
  correlationId?: string
): void {
  if (target.publish) {
    target.publish(type, payload, correlationId);
    return;
  }

  if (!target.telemetryBus) {
    throw new Error("Telemetry publish requires telemetryBus binding");
  }

  target.telemetryBus.publish(type, payload, correlationId);
}
