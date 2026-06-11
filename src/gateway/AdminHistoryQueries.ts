import { buildPaperLedger, type PaperLedger } from "../PaperLedger";
import type { Env, JsonRecord } from "../types";
import {
  DEFAULT_ADMIN_PAGE_SIZE,
  MAX_ADMIN_PAGE_SIZE,
  PAPER_SESSION_STARTED_AT_KEY
} from "./GatewayConstants";
import type {
  DateRangeFilter,
  ExecutionQualityAggregateRow,
  ExecutionQualityAssetRow,
  LogRow,
  PaperLedgerFillRow,
  PaperPnlAggregateRow,
  TradeHistoryRow,
  TradeStatusBreakdownRow
} from "./AdminModels";
import {
  buildLogFilters,
  buildTradeFilters,
  formatLogRow,
  formatPaperLedgerFill,
  formatTradeRow
} from "./AdminDataMappers";
import { json } from "./ResponseHelpers";
import { clampInteger, nullableRound, pagination, parseDateRange, round } from "./ValueCodecs";

export async function readAdminLogs(env: Env, url: URL): Promise<Response> {
  const page = clampInteger(url.searchParams.get("page"), 1, 1, 10_000);
  const limit = clampInteger(
    url.searchParams.get("limit"),
    DEFAULT_ADMIN_PAGE_SIZE,
    1,
    MAX_ADMIN_PAGE_SIZE
  );
  const offset = (page - 1) * limit;
  const filters = buildLogFilters(url);
  const whereSql = filters.where.length > 0 ? `WHERE ${filters.where.join(" AND ")}` : "";
  const dataQuery = `
    SELECT
      id,
      level,
      event_type,
      source,
      message,
      correlation_id,
      telemetry_json,
      created_at
    FROM logs
    ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?`;
  const countQuery = `SELECT COUNT(*) AS total FROM logs ${whereSql}`;
  const [rows, count] = await Promise.all([
    env.TRADING_DB.prepare(dataQuery)
      .bind(...filters.bindings, limit, offset)
      .all<LogRow>(),
    env.TRADING_DB.prepare(countQuery)
      .bind(...filters.bindings)
      .first<{ total: number }>()
  ]);
  const total = Number(count?.total ?? 0);

  return json({
    ok: true,
    data: (rows.results ?? []).map(formatLogRow),
    pagination: pagination(page, limit, total),
    filters: filters.publicFilters
  });
}

export async function readExecutionQuality(env: Env, url: URL): Promise<Response> {
  const dateRange = parseDateRange(url);
  const where: string[] = [];
  const bindings: string[] = [];
  if (dateRange.from) {
    where.push("observed_at >= ?");
    bindings.push(dateRange.from);
  }
  if (dateRange.to) {
    where.push("observed_at <= ?");
    bindings.push(dateRange.to);
  }
  if (where.length === 0) {
    where.push("observed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')");
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const [summary, byAsset, fillStats] = await Promise.all([
    env.TRADING_DB.prepare(
      `SELECT
         COUNT(*) AS sample_count,
         AVG(slippage_bps) AS average_slippage_bps,
         AVG(CASE WHEN slippage_bps > 0 THEN slippage_bps ELSE 0 END) AS adverse_selection_bps,
         AVG(implementation_shortfall) AS average_shortfall,
         AVG(latency_ms) AS average_latency_ms,
         SUM(fees) AS total_fees
       FROM execution_quality
       ${whereSql}`
    )
      .bind(...bindings)
      .first<ExecutionQualityAggregateRow>(),
    env.TRADING_DB.prepare(
      `SELECT
         instrument_code,
         COUNT(*) AS sample_count,
         AVG(slippage_bps) AS average_slippage_bps,
         AVG(CASE WHEN slippage_bps > 0 THEN slippage_bps ELSE 0 END) AS adverse_selection_bps,
         AVG(implementation_shortfall) AS average_shortfall,
         AVG(latency_ms) AS average_latency_ms,
         SUM(fees) AS total_fees
       FROM execution_quality
       ${whereSql}
       GROUP BY instrument_code
       ORDER BY sample_count DESC
       LIMIT 20`
    )
      .bind(...bindings)
      .all<ExecutionQualityAssetRow>(),
    readFillRateStats(env, dateRange)
  ]);

  return json({
    ok: true,
    window: {
      from: dateRange.from,
      to: dateRange.to,
      fallback: dateRange.from || dateRange.to ? null : "24h"
    },
    summary: formatExecutionQualitySummary(summary),
    byAsset: (byAsset.results ?? []).map(formatExecutionQualityAsset),
    fillRate: fillStats
  });
}

export async function readTradeHistory(env: Env, url: URL): Promise<Response> {
  const page = clampInteger(url.searchParams.get("page"), 1, 1, 10_000);
  const limit = clampInteger(
    url.searchParams.get("limit"),
    DEFAULT_ADMIN_PAGE_SIZE,
    1,
    MAX_ADMIN_PAGE_SIZE
  );
  const offset = (page - 1) * limit;
  const filters = buildTradeFilters(url);
  const whereSql = filters.where.length > 0 ? `WHERE ${filters.where.join(" AND ")}` : "";
  const fromSql = `
    FROM trades t
    LEFT JOIN agent_decisions d ON d.signal_id = t.signal_id`;
  const dataQuery = `
    SELECT
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
      d.trace_id
    ${fromSql}
    ${whereSql}
    ORDER BY t.executed_at DESC, t.created_at DESC
    LIMIT ? OFFSET ?`;
  const countQuery = `SELECT COUNT(*) AS total ${fromSql} ${whereSql}`;
  const paperLimit = clampInteger(
    url.searchParams.get("paperLimit") ?? url.searchParams.get("paper_limit"),
    75,
    1,
    250
  );
  const [rows, count, paperPnl, paperTrades, paperLedger, statusBreakdown] = await Promise.all([
    env.TRADING_DB.prepare(dataQuery)
      .bind(...filters.bindings, limit, offset)
      .all<TradeHistoryRow>(),
    env.TRADING_DB.prepare(countQuery)
      .bind(...filters.bindings)
      .first<{ total: number }>(),
    readPaperPnlSummary(env),
    readPaperTrades(env, paperLimit),
    readPaperLedger(env),
    readTradeStatusBreakdown(env)
  ]);
  const total = Number(count?.total ?? 0);

  return json({
    ok: true,
    data: (rows.results ?? []).map(formatTradeRow),
    paperTrades: (paperTrades.results ?? []).map(formatTradeRow),
    paperPnl,
    paperLedger,
    statusBreakdown: (statusBreakdown.results ?? []).map((row) => ({
      status: row.status,
      count: Number(row.count ?? 0),
      latestExecutedAt: row.latest_executed_at
    })),
    pagination: pagination(page, limit, total),
    filters: {
      ...filters.publicFilters,
      paperLimit
    }
  });
}

function formatExecutionQualityAsset(row: ExecutionQualityAssetRow): JsonRecord {
  return {
    instrumentCode: row.instrument_code,
    ...formatExecutionQualitySummary(row)
  };
}

function formatExecutionQualitySummary(row: ExecutionQualityAggregateRow | null): JsonRecord {
  return {
    sampleCount: Number(row?.sample_count ?? 0),
    averageSlippageBps: nullableRound(row?.average_slippage_bps, 6),
    adverseSelectionBps: nullableRound(row?.adverse_selection_bps, 6),
    averageShortfall: nullableRound(row?.average_shortfall, 8),
    averageLatencyMs: nullableRound(row?.average_latency_ms, 6),
    totalFees: nullableRound(row?.total_fees, 8)
  };
}

export function paperTradeWhereSql(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";

  return `(
    ${prefix}trade_id LIKE 'shadow-queue:%'
    OR ${prefix}order_id LIKE 'vlo:%'
    OR ${prefix}raw_execution_json LIKE '%"paperSizer":"shadowQueueKellySize"%'
  )`;
}

async function readFillRateStats(env: Env, dateRange: DateRangeFilter): Promise<JsonRecord> {
  const where: string[] = [];
  const bindings: string[] = [];
  if (dateRange.from) {
    where.push("executed_at >= ?");
    bindings.push(dateRange.from);
  }
  if (dateRange.to) {
    where.push("executed_at <= ?");
    bindings.push(dateRange.to);
  }
  if (where.length === 0) {
    where.push("executed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')");
  }
  const rows = await env.TRADING_DB.prepare(
    `SELECT status, COUNT(*) AS count
     FROM trades
     WHERE ${where.join(" AND ")}
     GROUP BY status`
  )
    .bind(...bindings)
    .all<{ status: string; count: number }>();
  const counts = Object.fromEntries(
    (rows.results ?? []).map((row) => [row.status, Number(row.count ?? 0)])
  );
  const filled =
    Number(counts.FILLED ?? 0) + Number(counts.PARTIAL ?? 0) + Number(counts.GHOST_FILL ?? 0);
  const attempted = Object.values(counts).reduce((sum, value) => sum + Number(value), 0);

  return {
    attempted,
    filled,
    rejected: Number(counts.REJECTED ?? 0),
    cancelled: Number(counts.CANCELLED ?? 0),
    acceptedOpen: Number(counts.ACCEPTED ?? 0),
    fillRate: attempted > 0 ? round(filled / attempted, 6) : null,
    counts
  };
}

async function readPaperLedger(env: Env): Promise<PaperLedger> {
  const sessionStartedAt = await env.CONFIG_STORE.get(PAPER_SESSION_STARTED_AT_KEY);
  const sessionCutoff =
    sessionStartedAt && Number.isFinite(Date.parse(sessionStartedAt)) ? sessionStartedAt : null;
  const timeFilterSql = sessionCutoff
    ? "AND t.executed_at >= ?"
    : "AND t.executed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')";
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
       d.trace_id
     FROM trades t
     LEFT JOIN agent_decisions d ON d.signal_id = t.signal_id
     WHERE t.status = 'GHOST_FILL'
       AND ${paperTradeWhereSql("t")}
       ${timeFilterSql}
     ORDER BY t.executed_at ASC, t.created_at ASC, t.trade_id ASC
     LIMIT 5000`
  )
    .bind(...(sessionCutoff ? [sessionCutoff] : []))
    .all<PaperLedgerFillRow>();

  return buildPaperLedger((rows.results ?? []).map(formatPaperLedgerFill));
}

export async function readPaperPnlSummary(env: Env): Promise<JsonRecord> {
  const windowHours = 24;
  const sessionStartedAt = await env.CONFIG_STORE.get(PAPER_SESSION_STARTED_AT_KEY);
  const sessionCutoff =
    sessionStartedAt && Number.isFinite(Date.parse(sessionStartedAt)) ? sessionStartedAt : null;
  const timeFilterSql = sessionCutoff
    ? "AND executed_at >= ?"
    : "AND executed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')";
  const rows = await env.TRADING_DB.prepare(
    `SELECT
       asset,
       COUNT(*) AS trade_count,
       SUM(CASE WHEN side = 'BUY' THEN 1 ELSE 0 END) AS buy_count,
       SUM(CASE WHEN side = 'SELL' THEN 1 ELSE 0 END) AS sell_count,
       SUM(CASE WHEN side = 'BUY' THEN size ELSE 0 END) AS buy_size,
       SUM(CASE WHEN side = 'SELL' THEN size ELSE 0 END) AS sell_size,
       SUM(CASE WHEN side = 'BUY' THEN notional ELSE 0 END) AS buy_notional,
       SUM(CASE WHEN side = 'SELL' THEN notional ELSE 0 END) AS sell_notional,
       SUM(ev_at_execution) AS total_ev,
       SUM(fees) AS total_fees,
       SUM(resulting_pnl) AS realized_pnl,
       MIN(executed_at) AS first_seen,
       MAX(executed_at) AS last_seen
     FROM trades
     WHERE status = 'GHOST_FILL'
       AND ${paperTradeWhereSql()}
       ${timeFilterSql}
     GROUP BY asset
     ORDER BY asset`
  )
    .bind(...(sessionCutoff ? [sessionCutoff] : []))
    .all<PaperPnlAggregateRow>();
  const assets = (rows.results ?? []).map((row) => {
    const buySize = row.buy_size ?? 0;
    const sellSize = row.sell_size ?? 0;
    const buyNotional = row.buy_notional ?? 0;
    const sellNotional = row.sell_notional ?? 0;
    const netQuantity = buySize - sellSize;
    const cashPnl = sellNotional - buyNotional;
    const grossNotional = buyNotional + sellNotional;

    return {
      asset: row.asset,
      tradeCount: row.trade_count,
      buyCount: row.buy_count,
      sellCount: row.sell_count,
      buySize: round(buySize, 8),
      sellSize: round(sellSize, 8),
      buyNotional: round(buyNotional, 8),
      sellNotional: round(sellNotional, 8),
      netQuantity: round(netQuantity, 8),
      cashPnl: round(cashPnl, 8),
      grossNotional: round(grossNotional, 8),
      realizedPnl: round(row.realized_pnl ?? 0, 8),
      totalEv: round(row.total_ev ?? 0, 8),
      totalFees: round(row.total_fees ?? 0, 8),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen
    };
  });
  const totals = assets.reduce(
    (summary, asset) => ({
      tradeCount: summary.tradeCount + Number(asset.tradeCount ?? 0),
      buyCount: summary.buyCount + Number(asset.buyCount ?? 0),
      sellCount: summary.sellCount + Number(asset.sellCount ?? 0),
      grossNotional: summary.grossNotional + Number(asset.grossNotional ?? 0),
      cashPnl: summary.cashPnl + Number(asset.cashPnl ?? 0),
      realizedPnl: summary.realizedPnl + Number(asset.realizedPnl ?? 0),
      totalEv: summary.totalEv + Number(asset.totalEv ?? 0),
      totalFees: summary.totalFees + Number(asset.totalFees ?? 0)
    }),
    {
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      grossNotional: 0,
      cashPnl: 0,
      realizedPnl: 0,
      totalEv: 0,
      totalFees: 0
    }
  );

  return {
    windowHours,
    mode: sessionCutoff ? "SHADOW_CURRENT_SESSION" : "SHADOW_RISK_CAPPED_MARK_TO_MARKET",
    sessionStartedAt: sessionCutoff,
    assets,
    totals: {
      tradeCount: totals.tradeCount,
      buyCount: totals.buyCount,
      sellCount: totals.sellCount,
      grossNotional: round(totals.grossNotional, 8),
      cashPnl: round(totals.cashPnl, 8),
      realizedPnl: round(totals.realizedPnl, 8),
      totalEv: round(totals.totalEv, 8),
      totalFees: round(totals.totalFees, 8)
    },
    generatedAt: new Date().toISOString()
  };
}

async function readPaperTrades(env: Env, limit: number): Promise<D1Result<TradeHistoryRow>> {
  return env.TRADING_DB.prepare(
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
       d.trace_id
     FROM trades t
     LEFT JOIN agent_decisions d ON d.signal_id = t.signal_id
     WHERE t.status = 'GHOST_FILL'
       AND ${paperTradeWhereSql("t")}
     ORDER BY t.executed_at DESC, t.created_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all<TradeHistoryRow>();
}

async function readTradeStatusBreakdown(env: Env): Promise<D1Result<TradeStatusBreakdownRow>> {
  return env.TRADING_DB.prepare(
    `SELECT
       status,
       COUNT(*) AS count,
       MAX(executed_at) AS latest_executed_at
     FROM trades
     GROUP BY status
     ORDER BY count DESC`
  ).all<TradeStatusBreakdownRow>();
}
