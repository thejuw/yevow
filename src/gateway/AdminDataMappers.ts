import type { PaperLedgerFillInput } from "../PaperLedger";
import type { JsonRecord } from "../types";
import { AGENT_NAMES, LOG_LEVELS, TRADE_STATUSES } from "./GatewayConstants";
import type { LogRow, PaperLedgerFillRow, TradeHistoryRow } from "./AdminModels";
import { normalizeAsset, normalizeEnum, parseDateRange, parseJsonRecord } from "./ValueCodecs";

export interface AdminSqlFilters {
  where: string[];
  bindings: string[];
  publicFilters: JsonRecord;
}

export function buildLogFilters(url: URL): AdminSqlFilters {
  const where: string[] = [];
  const bindings: string[] = [];
  const level = normalizeEnum(url.searchParams.get("level"), LOG_LEVELS);
  const agent = normalizeEnum(url.searchParams.get("agent"), AGENT_NAMES);
  const dateRange = parseDateRange(url);

  if (level) {
    where.push("level = ?");
    bindings.push(level);
  }

  if (agent) {
    where.push("(source = ? OR telemetry_json LIKE ? OR event_type LIKE ?)");
    bindings.push(agent, `%"${agent}"%`, `%${agent}%`);
  }

  if (dateRange.from) {
    where.push("created_at >= ?");
    bindings.push(dateRange.from);
  }

  if (dateRange.to) {
    where.push("created_at <= ?");
    bindings.push(dateRange.to);
  }

  return {
    where,
    bindings,
    publicFilters: {
      level,
      agent,
      dateRange: {
        from: dateRange.from,
        to: dateRange.to
      }
    }
  };
}

export function buildTradeFilters(url: URL): AdminSqlFilters {
  const where: string[] = [];
  const bindings: string[] = [];
  const agent = normalizeEnum(url.searchParams.get("agent"), AGENT_NAMES);
  const rawStatus = url.searchParams.get("status")?.trim().toUpperCase() ?? null;
  const status =
    rawStatus === "ALL" ? null : (normalizeEnum(rawStatus, TRADE_STATUSES) ?? "FILLED");
  const asset = normalizeAsset(url.searchParams.get("asset"));
  const dateRange = parseDateRange(url);

  if (status) {
    where.push("t.status = ?");
    bindings.push(status);
  }

  if (agent) {
    where.push("d.agent_name = ?");
    bindings.push(agent);
  }

  if (asset) {
    where.push("t.asset = ?");
    bindings.push(asset);
  }

  if (dateRange.from) {
    where.push("t.executed_at >= ?");
    bindings.push(dateRange.from);
  }

  if (dateRange.to) {
    where.push("t.executed_at <= ?");
    bindings.push(dateRange.to);
  }

  return {
    where,
    bindings,
    publicFilters: {
      status,
      statusMode: rawStatus === "ALL" ? "ALL" : status,
      agent,
      asset,
      dateRange: {
        from: dateRange.from,
        to: dateRange.to
      }
    }
  };
}

export function formatLogRow(row: LogRow): JsonRecord {
  return {
    id: row.id,
    level: row.level,
    eventType: row.event_type,
    source: row.source,
    message: row.message,
    correlationId: row.correlation_id,
    telemetry: parseJsonRecord(row.telemetry_json),
    timestamp: row.created_at
  };
}

export function formatPaperLedgerFill(row: PaperLedgerFillRow): PaperLedgerFillInput {
  return {
    tradeId: row.trade_id,
    orderId: row.order_id,
    asset: row.asset,
    side: row.side === "SELL" ? "SELL" : "BUY",
    price: row.price,
    size: row.size,
    notional: row.notional,
    fees: row.fees,
    status: "GHOST_FILL",
    primaryDriver: row.primary_driver ?? null,
    rawExecution: parseJsonRecord(row.raw_execution_json) ?? {},
    executedAt: row.executed_at,
    createdAt: row.created_at
  };
}

export function formatTradeRow(row: TradeHistoryRow): JsonRecord {
  return {
    tradeId: row.trade_id,
    orderId: row.order_id,
    signalId: row.signal_id,
    venue: row.venue,
    asset: row.asset,
    side: row.side,
    orderType: row.order_type,
    price: row.price,
    size: row.size,
    notional: row.notional,
    evAtExecution: row.ev_at_execution,
    slippageBps: row.slippage_bps,
    resultingPnl: row.resulting_pnl ?? 0,
    primaryDriver: row.primary_driver ?? null,
    fees: row.fees,
    status: row.status,
    exchangeTradeId: row.exchange_trade_id,
    rawExecution: parseJsonRecord(row.raw_execution_json) ?? {},
    agentName: row.agent_name,
    traceId: row.trace_id,
    executedAt: row.executed_at,
    createdAt: row.created_at
  };
}
