import type {
  AgentDecisionTrace,
  AgentSignal,
  AuditContext,
  EngineStabilityStatus,
  Env,
  JsonRecord,
  JsonValue,
  LatencyMetrics,
  LogEvent,
  MarketTick,
  TradeExecution
} from "./types";

type WaitUntil = (promise: Promise<unknown>) => void;
type AuditContextProvider = () => AuditContext;
type LogLevel = LogEvent["level"];

interface StructuredLogEnvelope {
  schemaVersion: "sovereign-log.v1";
  service: string;
  source: string;
  level: LogLevel;
  eventType: string;
  message: string;
  correlationId: string | null;
  telemetry: JsonRecord;
  auditContext: AuditContext;
  timestamp: string;
}

interface LogSink {
  export(event: StructuredLogEnvelope): Promise<void>;
}

export interface PerformanceSnapshot {
  engineId: string;
  status: EngineStabilityStatus;
  jitterMs: number;
  jitterThresholdMs: number;
  sampleCount: number;
  sampleWindow: number;
  computeIntervalTicks: number;
  averageProcessingLatencyMs: number | null;
  maxProcessingLatencyMs: number | null;
  lastProcessingLatencyMs: number | null;
  wakeUpTimeMs: number | null;
  coldStartSuspected: boolean;
  orderBookUpdateMs: number | null;
  agentLogicMs: number | null;
  totalHotPathMs: number | null;
  processedTicks: number;
  observedAt: string;
}

export class Logger {
  private pending: D1PreparedStatement[] = [];
  private flushScheduled = false;

  constructor(
    private readonly db: D1Database,
    private readonly waitUntil: WaitUntil,
    private readonly source: string,
    private readonly getAuditContext: AuditContextProvider = () => ({
      lastTickTimestamp: null,
      orderBookImbalance: null
    }),
    private readonly logSink: LogSink | null = null,
    private readonly structuredConsoleLogs = false
  ) {}

  writeLog(
    level: LogLevel,
    source: string,
    message: string,
    metadata: Record<string, unknown> = {}
  ): void {
    const observedAt = new Date().toISOString();
    const auditContext = this.getAuditContext();
    const telemetry = sanitizeJsonRecord({
      ...metadata,
      auditContext
    });
    const eventType = safeString(telemetry.eventType, "SYSTEM_EVENT");
    const correlationId = nullableString(telemetry.correlationId);
    const envelope: StructuredLogEnvelope = {
      schemaVersion: "sovereign-log.v1",
      service: "sovereign-sigma",
      source: source || this.source,
      level,
      eventType,
      message,
      correlationId,
      telemetry,
      auditContext,
      timestamp: observedAt
    };
    const statement = this.db
      .prepare(
        `INSERT INTO logs
          (level, event_type, source, message, correlation_id, telemetry_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        level,
        eventType,
        envelope.source,
        message,
        correlationId,
        stringifyJson(telemetry),
        observedAt
      );

    this.enqueue(statement, "logs");
    this.exportStructuredLog(envelope);
  }

  emit(event: LogEvent): void {
    this.writeLog(event.level, event.source || this.source, event.message, {
      ...event.telemetry,
      eventType: event.eventType,
      correlationId: event.correlationId ?? null
    });
  }

  info(
    eventType: string,
    message: string,
    telemetry?: JsonRecord,
    correlationId?: string
  ): void {
    this.writeLog("INFO", this.source, message, {
      ...telemetry,
      eventType,
      correlationId: correlationId ?? null
    });
  }

  warn(
    eventType: string,
    message: string,
    telemetry?: JsonRecord,
    correlationId?: string
  ): void {
    this.writeLog("WARN", this.source, message, {
      ...telemetry,
      eventType,
      correlationId: correlationId ?? null
    });
  }

  error(
    eventType: string,
    message: string,
    telemetry?: JsonRecord,
    correlationId?: string
  ): void {
    this.writeLog("ERROR", this.source, message, {
      ...telemetry,
      eventType,
      correlationId: correlationId ?? null
    });
  }

  recordExecution(tradeData: TradeExecution): void {
    const auditContext = this.getAuditContext();
    const rawExecution = sanitizeJsonRecord({
      resultingPnl: tradeData.resultingPnl,
      metadata: tradeData.metadata ?? null,
      auditContext
    });
    const statement = this.db
      .prepare(
        `INSERT INTO trades
          (
            trade_id,
            order_id,
            signal_id,
            venue,
            asset,
            side,
            order_type,
            price,
            size,
            notional,
            ev_at_execution,
            slippage_bps,
            resulting_pnl,
            primary_driver,
            fees,
            status,
            exchange_trade_id,
            raw_execution_json,
            executed_at,
            created_at
          )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trade_id) DO UPDATE SET
           status = excluded.status,
           price = excluded.price,
           size = excluded.size,
           notional = excluded.notional,
           ev_at_execution = excluded.ev_at_execution,
           slippage_bps = excluded.slippage_bps,
           resulting_pnl = excluded.resulting_pnl,
           primary_driver = excluded.primary_driver,
           fees = excluded.fees,
           raw_execution_json = excluded.raw_execution_json`
      )
      .bind(
        tradeData.tradeId,
        tradeData.orderId,
        tradeData.signalId ?? null,
        tradeData.venue,
        tradeData.asset,
        tradeData.side,
        tradeData.orderType,
        tradeData.price,
        tradeData.size,
        roundNumber(tradeData.price * tradeData.size, 8),
        tradeData.evAtExecution,
        tradeData.slippageBps,
        tradeData.resultingPnl,
        tradeData.primaryDriver ?? null,
        tradeData.fees ?? 0,
        tradeData.status,
        tradeData.exchangeTradeId ?? null,
        stringifyJson(rawExecution),
        tradeData.executedAt,
        new Date().toISOString()
      );

    this.enqueue(statement, "trades");
  }

  traceDecision(decisionData: AgentDecisionTrace): void {
    const auditContext = this.getAuditContext();
    const riskSnapshot = sanitizeJsonRecord({
      ...(decisionData.riskSnapshot ?? {}),
      auditContext
    });
    const rawSignal = sanitizeJsonRecord({
      ...(decisionData.rawSignal ?? {}),
      reasoning: decisionData.reasoning,
      confidence: decisionData.confidence,
      auditContext
    });
    const statement = this.db
      .prepare(
        `INSERT INTO agent_decisions
          (
            decision_id,
            signal_id,
            trace_id,
            agent_name,
            target_agent,
            instrument_code,
            action,
            confidence,
            expected_value,
            max_slippage_bps,
            rationale,
            feature_vector_json,
            risk_snapshot_json,
            raw_signal_json,
            latency_ms,
            created_at
          )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(signal_id) DO UPDATE SET
           confidence = excluded.confidence,
           expected_value = excluded.expected_value,
           max_slippage_bps = excluded.max_slippage_bps,
           rationale = excluded.rationale,
           feature_vector_json = excluded.feature_vector_json,
           risk_snapshot_json = excluded.risk_snapshot_json,
           raw_signal_json = excluded.raw_signal_json,
           latency_ms = excluded.latency_ms`
      )
      .bind(
        decisionData.decisionId,
        decisionData.signalId,
        decisionData.traceId,
        decisionData.agentName,
        decisionData.targetAgent ?? null,
        decisionData.instrumentCode,
        decisionData.action,
        decisionData.confidence,
        decisionData.expectedValue ?? null,
        decisionData.maxSlippageBps ?? null,
        decisionData.reasoning,
        stringifyJson(decisionData.featureVector ?? {}),
        stringifyJson(riskSnapshot),
        stringifyJson(rawSignal),
        decisionData.latencyMs ?? null,
        decisionData.createdAt
      );

    this.enqueue(statement, "agent_decisions");
  }

  agentDecision(signal: AgentSignal, latencyMs: number): void {
    this.traceDecision({
      decisionId: `decision_${signal.signalId}`,
      signalId: signal.signalId,
      traceId: signal.traceId,
      agentName: signal.sourceAgent,
      targetAgent: signal.targetAgent,
      instrumentCode: signal.instrumentCode,
      action: signal.action,
      confidence: signal.confidence,
      expectedValue: signal.expectedValue,
      maxSlippageBps: signal.maxSlippageBps,
      reasoning: signal.rationale,
      featureVector: signal.featureVector,
      riskSnapshot: signal.riskContext,
      rawSignal: sanitizeJsonRecord(signal),
      latencyMs,
      createdAt: signal.createdAt
    });
  }

  logPerformance(latencyMetrics: LatencyMetrics): void {
    this.writeLog(
      "WARN",
      this.source,
      "Tick-to-brain latency exceeded freshness threshold",
      {
        eventType: "LATENCY_SPIKE",
        correlationId: `${latencyMetrics.instrumentCode}:${latencyMetrics.sequence}`,
        instrumentCode: latencyMetrics.instrumentCode,
        exchangeCode: latencyMetrics.exchangeCode,
        sequence: latencyMetrics.sequence,
        providerTimestamp: latencyMetrics.providerTimestamp,
        ingestTimestamp: latencyMetrics.ingestTimestamp,
        brainTimestamp: latencyMetrics.brainTimestamp,
        networkLatencyMs: latencyMetrics.networkLatencyMs,
        processingLatencyMs: latencyMetrics.processingLatencyMs,
        totalLatencyMs: latencyMetrics.totalLatencyMs,
        maxLatencyMs: latencyMetrics.maxLatencyMs,
        averageLatencyMs: latencyMetrics.averageLatencyMs,
        sampleCount: latencyMetrics.sampleCount,
        status: latencyMetrics.status
      }
    );
  }

  logPerformanceSnapshot(snapshot: PerformanceSnapshot): void {
    this.writeLog(
      snapshot.status === "UNSTABLE" ? "WARN" : "INFO",
      this.source,
      snapshot.status === "UNSTABLE"
        ? "Execution jitter exceeded stability threshold"
        : "Execution jitter returned within stability threshold",
      {
        eventType:
          snapshot.status === "UNSTABLE"
            ? "EXECUTION_JITTER_UNSTABLE"
            : "EXECUTION_JITTER_STABLE",
        correlationId: `${snapshot.engineId}:${snapshot.processedTicks}`,
        ...snapshot
      }
    );
  }

  recordMarketTick(tick: MarketTick): void {
    const statement = this.db
      .prepare(
        `INSERT OR REPLACE INTO market_ticks
          (tick_id, source_exchange, instrument_code, sequence, tick_json, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        `${tick.source_exchange}:${tick.instrumentCode}:${tick.sequence}`,
        tick.source_exchange,
        tick.instrumentCode,
        tick.sequence,
        stringifyJson(tick),
        tick.receivedAt,
        new Date().toISOString()
      );

    this.enqueue(statement, "market_ticks");
  }

  recordExecutionQuality(input: {
    clientId: string;
    instrumentCode: string;
    expectedPrice: number;
    achievedPrice: number;
    slippageBps: number;
    implementationShortfall: number;
    latencyMs: number;
    fees: number;
    observedAt: string;
  }): void {
    const statement = this.db
      .prepare(
        `INSERT OR REPLACE INTO execution_quality
          (quality_id, client_id, instrument_code, expected_price, achieved_price,
           slippage_bps, implementation_shortfall, latency_ms, fees, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        `quality:${input.clientId}:${input.observedAt}`,
        input.clientId,
        input.instrumentCode,
        input.expectedPrice,
        input.achievedPrice,
        input.slippageBps,
        input.implementationShortfall,
        input.latencyMs,
        input.fees,
        input.observedAt
      );

    this.enqueue(statement, "execution_quality");
  }

  private enqueue(statement: D1PreparedStatement, table: string): void {
    this.pending.push(statement);

    if (this.flushScheduled) {
      return;
    }

    this.flushScheduled = true;
    const flush = Promise.resolve().then(() => this.flush(table));
    this.waitUntil(flush);
  }

  private async flush(table: string): Promise<void> {
    const batch = this.pending.splice(0);
    this.flushScheduled = false;

    if (batch.length === 0) {
      return;
    }

    try {
      await this.db.batch(batch);
    } catch (error) {
      this.reportFailure(table, error);
    }

    if (this.pending.length > 0) {
      this.flushScheduled = true;
      const nextFlush = Promise.resolve().then(() => this.flush("pending"));
      this.waitUntil(nextFlush);
    }
  }

  private reportFailure(table: string, error: unknown): void {
    console.error(
      `[Sovereign-Sigma] failed to write ${table}`,
      error instanceof Error ? error.message : error
    );
  }

  private exportStructuredLog(envelope: StructuredLogEnvelope): void {
    if (this.structuredConsoleLogs) {
      const method =
        envelope.level === "ERROR" || envelope.level === "CRITICAL"
          ? "error"
          : envelope.level === "WARN"
            ? "warn"
            : "log";
      console[method](JSON.stringify(envelope));
    }

    if (!this.logSink) {
      return;
    }

    this.waitUntil(
      this.logSink.export(envelope).catch((error) => {
        console.error(
          "[Sovereign-Sigma] structured log export failed",
          error instanceof Error ? error.message : error
        );
      })
    );
  }
}

export function createLogSink(env: Env): LogSink | null {
  const provider = (env.LOG_SINK_PROVIDER ?? "disabled").trim().toLowerCase();
  const token = env.LOG_SINK_TOKEN?.trim();
  const dataset =
    env.LOG_SINK_DATASET?.trim() ||
    env.AXIOM_DATASET?.trim() ||
    env.HONEYCOMB_DATASET?.trim();

  if (provider === "disabled" || provider === "none" || provider.length === 0) {
    return null;
  }

  if (provider === "axiom") {
    if (!token || !dataset) {
      return null;
    }
    return new HttpLogSink(
      `https://api.axiom.co/v1/datasets/${encodeURIComponent(dataset)}/ingest`,
      { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      (event) => JSON.stringify([event])
    );
  }

  if (provider === "honeycomb") {
    if (!token || !dataset) {
      return null;
    }
    return new HttpLogSink(
      `https://api.honeycomb.io/1/events/${encodeURIComponent(dataset)}`,
      { "X-Honeycomb-Team": token, "content-type": "application/json" },
      (event) => JSON.stringify(event)
    );
  }

  const url = env.LOG_SINK_URL?.trim();
  if (provider === "http" && url) {
    return new HttpLogSink(
      url,
      {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "content-type": "application/x-ndjson"
      },
      (event) => `${JSON.stringify(event)}\n`
    );
  }

  return null;
}

export function structuredConsoleLogsEnabled(env: Env): boolean {
  return String(env.STRUCTURED_CONSOLE_LOGS ?? "false").toLowerCase() === "true";
}

class HttpLogSink implements LogSink {
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly encode: (event: StructuredLogEnvelope) => string
  ) {}

  async export(event: StructuredLogEnvelope): Promise<void> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.headers,
      body: this.encode(event)
    });

    if (!response.ok) {
      throw new Error(`LOG_SINK_HTTP_${response.status}`);
    }
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(sanitizeJsonValue(value));
}

function sanitizeJsonRecord(value: unknown): JsonRecord {
  const sanitized = sanitizeJsonValue(value);
  return isPlainObject(sanitized) ? sanitized : {};
}

function sanitizeJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeJsonValue);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeJsonValue(item)])
    );
  }

  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function nullableString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function roundNumber(value: number, decimalPlaces: number): number {
  const scale = 10 ** decimalPlaces;
  return Math.round(value * scale) / scale;
}
