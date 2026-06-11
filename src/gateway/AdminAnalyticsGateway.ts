import type { Env, JsonRecord } from "../types";
import type { AgentTraceRow, AttributionRow, TraceTelemetryRow } from "./AdminModels";
import { AGENT_NAMES } from "./GatewayConstants";
import { json } from "./ResponseHelpers";
import {
  clampInteger,
  finiteNumber,
  normalizeEnum,
  parseDateRange,
  parseJsonRecord,
  readNumberField,
  readString,
  round
} from "./ValueCodecs";

export async function readAgentTrace(env: Env, url: URL): Promise<Response> {
  const limit = clampInteger(url.searchParams.get("limit"), 50, 1, 200);
  const agent = normalizeEnum(url.searchParams.get("agent"), AGENT_NAMES);
  const queryLimit = agent ? limit : limit * AGENT_NAMES.length;
  const dateRange = parseDateRange(url);
  const where: string[] = [];
  const bindings: string[] = [];

  if (agent) {
    where.push("agent_name = ?");
    bindings.push(agent);
  }
  if (dateRange.from) {
    where.push("created_at >= ?");
    bindings.push(dateRange.from);
  }
  if (dateRange.to) {
    where.push("created_at <= ?");
    bindings.push(dateRange.to);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const decisions = await env.TRADING_DB.prepare(
    `SELECT
       decision_id,
       signal_id,
       trace_id,
       agent_name,
       target_agent,
       instrument_code,
       action,
       confidence,
       expected_value,
       rationale,
       feature_vector_json,
       risk_snapshot_json,
       raw_signal_json,
       latency_ms,
       created_at
     FROM agent_decisions
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(...bindings, queryLimit)
    .all<AgentTraceRow>();
  const telemetry = await env.TRADING_DB.prepare(
    `SELECT id, event_type, source, message, telemetry_json, created_at
     FROM logs
     WHERE event_type IN ('AGENT_SIGNAL', 'AGENT_STATE_SNAPSHOT', 'PROFILER_ALERT', 'BAYESIAN_POSTERIOR_UPDATED')
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(Math.min(limit, 50))
    .all<TraceTelemetryRow>();
  const rows = decisions.results ?? [];
  const byAgent: Record<string, JsonRecord[]> = {};
  const scopedRows: AgentTraceRow[] = [];

  for (const row of rows) {
    const agentRows = byAgent[row.agent_name] ?? [];
    if (agentRows.length >= limit) {
      continue;
    }

    const formatted = formatAgentTraceRow(row);
    const key = row.agent_name;
    byAgent[key] = [...agentRows, formatted];
    scopedRows.push(row);
  }

  return json({
    ok: true,
    data: scopedRows.map(formatAgentTraceRow),
    byAgent,
    terminalFeed: scopedRows.map(traceTerminalLine),
    liveTelemetry: (telemetry.results ?? []).map((row) => ({
      id: row.id,
      eventType: row.event_type,
      source: row.source,
      message: row.message,
      telemetry: parseJsonRecord(row.telemetry_json),
      timestamp: row.created_at
    })),
    filters: {
      agent,
      dateRange,
      limit
    }
  });
}

export async function readAttribution(env: Env, url: URL): Promise<Response> {
  const limit = clampInteger(url.searchParams.get("limit"), 1_000, 1, 10_000);
  const dateRange = parseDateRange(url);
  const where: string[] = ["t.status IN ('FILLED', 'PARTIAL', 'GHOST_FILL')"];
  const bindings: string[] = [];

  if (dateRange.from) {
    where.push("t.executed_at >= ?");
    bindings.push(dateRange.from);
  }
  if (dateRange.to) {
    where.push("t.executed_at <= ?");
    bindings.push(dateRange.to);
  }

  const rows = await env.TRADING_DB.prepare(
    `SELECT
       t.trade_id,
       t.order_id,
       t.signal_id,
       t.venue,
       t.asset,
       t.side,
       t.order_type,
       t.price,
       t.size,
       t.notional,
       t.ev_at_execution,
       t.slippage_bps,
       t.resulting_pnl,
       t.primary_driver,
       t.fees,
       t.status,
       t.exchange_trade_id,
       t.raw_execution_json,
       t.executed_at,
       t.created_at,
       d.agent_name,
       d.trace_id,
       d.rationale,
       d.confidence
     FROM trades t
     LEFT JOIN agent_decisions d ON d.signal_id = t.signal_id
     WHERE ${where.join(" AND ")}
     ORDER BY t.executed_at DESC, t.created_at DESC
     LIMIT ?`
  )
    .bind(...bindings, limit)
    .all<AttributionRow>();
  const trades = (rows.results ?? []).map(formatAttributionTrade).reverse();
  const byDriver = calculateAttributionByDriver(trades);
  const byAsset = calculateAttributionByAsset(trades);
  const byRegime = calculateAttributionByRegime(trades);
  const byAgentAsset = calculateAttributionByAgentAsset(trades);
  const timeline = calculateAttributionTimeline(trades);

  return json({
    ok: true,
    trades,
    byDriver,
    byAsset,
    byRegime,
    byAgentAsset,
    timeline,
    filters: {
      dateRange,
      limit
    }
  });
}

function formatAgentTraceRow(row: AgentTraceRow): JsonRecord {
  return {
    decisionId: row.decision_id,
    signalId: row.signal_id,
    traceId: row.trace_id,
    agentName: row.agent_name,
    targetAgent: row.target_agent,
    instrumentCode: row.instrument_code,
    action: row.action,
    confidence: row.confidence,
    expectedValue: row.expected_value,
    rationale: row.rationale,
    featureVector: parseJsonRecord(row.feature_vector_json),
    riskSnapshot: parseJsonRecord(row.risk_snapshot_json),
    rawSignal: parseJsonRecord(row.raw_signal_json),
    latencyMs: row.latency_ms,
    timestamp: row.created_at
  };
}

function traceTerminalLine(row: AgentTraceRow): string {
  const ev =
    row.expected_value === null || row.expected_value === undefined
      ? "EV=n/a"
      : `EV=${round(row.expected_value, 6)}`;

  return `${row.created_at} [${row.agent_name}] ${row.instrument_code} ${row.action} conf=${round(row.confidence, 4)} ${ev} trace=${row.trace_id} :: ${row.rationale}`;
}

interface AttributionTrade {
  tradeId: string;
  driver: string;
  asset: string;
  regime: string;
  side: string;
  pnl: number;
  evAtExecution: number;
  confidence: number | null;
  rationale: string | null;
  executedAt: string;
}

function formatAttributionTrade(row: AttributionRow): AttributionTrade {
  const rawExecution = parseJsonRecord(row.raw_execution_json);
  const primaryDriver =
    row.primary_driver ??
    readString(rawExecution, "primaryDriver") ??
    readString(rawExecution, "primary_driver") ??
    row.agent_name ??
    "UNATTRIBUTED";
  const pnl =
    finiteNumber(row.resulting_pnl) ??
    finiteNumber(readNumberField(rawExecution, "resultingPnl")) ??
    finiteNumber(readNumberField(rawExecution, "resulting_pnl")) ??
    finiteNumber(readNumberField(rawExecution, "pnl")) ??
    0;

  return {
    tradeId: row.trade_id,
    driver: primaryDriver,
    asset: row.asset,
    regime:
      readString(rawExecution, "regime") ??
      readString(rawExecution, "oracleRegime") ??
      readString(rawExecution, "marketRegime") ??
      "UNKNOWN",
    side: row.side,
    pnl,
    evAtExecution: row.ev_at_execution,
    confidence: row.confidence ?? null,
    rationale: row.rationale,
    executedAt: row.executed_at
  };
}

function calculateAttributionByDriver(trades: AttributionTrade[]): JsonRecord[] {
  return calculateAttributionBuckets(trades, (trade) => trade.driver, "driver");
}

function calculateAttributionByAsset(trades: AttributionTrade[]): JsonRecord[] {
  return calculateAttributionBuckets(trades, (trade) => trade.asset, "asset");
}

function calculateAttributionByRegime(trades: AttributionTrade[]): JsonRecord[] {
  return calculateAttributionBuckets(trades, (trade) => trade.regime, "regime");
}

function calculateAttributionByAgentAsset(trades: AttributionTrade[]): JsonRecord[] {
  return calculateAttributionBuckets(trades, (trade) => `${trade.driver}:${trade.asset}`, "bucket");
}

function calculateAttributionBuckets(
  trades: AttributionTrade[],
  keyFn: (trade: AttributionTrade) => string,
  keyName: string
): JsonRecord[] {
  const buckets = new Map<string, AttributionTrade[]>();

  for (const trade of trades) {
    const key = keyFn(trade);
    buckets.set(key, [...(buckets.get(key) ?? []), trade]);
  }

  return [...buckets.entries()].map(([key, bucket]) => {
    const pnls = bucket.map((trade) => trade.pnl);
    const grossProfit = pnls.filter((pnl) => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
    const grossLoss = Math.abs(pnls.filter((pnl) => pnl < 0).reduce((sum, pnl) => sum + pnl, 0));
    const mean = pnls.reduce((sum, pnl) => sum + pnl, 0) / Math.max(1, pnls.length);
    const variance =
      pnls.length > 1
        ? pnls.reduce((sum, pnl) => sum + (pnl - mean) ** 2, 0) / (pnls.length - 1)
        : 0;
    const sigma = Math.sqrt(variance);

    const row: JsonRecord = {
      [keyName]: key,
      tradeCount: bucket.length,
      cumulativePnl: round(
        pnls.reduce((sum, pnl) => sum + pnl, 0),
        8
      ),
      averagePnl: round(mean, 8),
      sharpe: sigma > 0 ? round((mean / sigma) * Math.sqrt(bucket.length), 6) : null,
      profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 6) : null,
      winRate:
        bucket.length > 0
          ? round(bucket.filter((trade) => trade.pnl > 0).length / bucket.length, 6)
          : null,
      grossProfit: round(grossProfit, 8),
      grossLoss: round(grossLoss, 8),
      averageConfidence: round(
        bucket.reduce((sum, trade) => sum + (trade.confidence ?? 0), 0) /
          Math.max(1, bucket.length),
        6
      )
    };
    if (keyName === "driver") {
      row.driver = key;
    }
    return row;
  });
}

function calculateAttributionTimeline(trades: AttributionTrade[]): JsonRecord[] {
  const cumulative = new Map<string, number>();

  return trades.map((trade) => {
    cumulative.set(trade.driver, (cumulative.get(trade.driver) ?? 0) + trade.pnl);

    return {
      timestamp: trade.executedAt,
      tradeId: trade.tradeId,
      driver: trade.driver,
      pnl: round(trade.pnl, 8),
      cumulativeByDriver: Object.fromEntries(
        [...cumulative.entries()].map(([driver, pnl]) => [driver, round(pnl, 8)])
      )
    };
  });
}
