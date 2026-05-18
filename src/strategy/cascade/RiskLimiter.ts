import type { EngineState, Env, JsonRecord } from "../../types";
import type { RiskBlockDecision } from "./types";

const REALIZED_STATUSES_SQL = "'FILLED','PARTIAL','GHOST_FILL'";

interface PnlRow {
  pnl: number | string | null;
}

interface TradePnlRow {
  resulting_pnl: number | string | null;
}

export class RiskLimiter {
  async shouldBlockNewEntries(
    env: Env,
    engineState: EngineState,
    observedAt = new Date().toISOString()
  ): Promise<RiskBlockDecision> {
    try {
      const equity = Math.max(0, engineState.bankroll.equity);
      const config = engineState.cachedConfig;
      const observedDate = new Date(observedAt);

      if (equity <= 0) {
        return {
          blocked: true,
          reason: "DRAWDOWN_LIMIT",
          metadata: { gate: "equity", equity } satisfies JsonRecord
        };
      }

      const dailyPnl = await realizedPnlSince(env.TRADING_DB, startOfUtcDay(observedDate));
      const dailyLimitUsd = equity * config.DAILY_LOSS_LIMIT_PCT;
      if (dailyLimitUsd > 0 && dailyPnl <= -dailyLimitUsd) {
        return {
          blocked: true,
          reason: "DAILY_LOSS_LIMIT",
          resumesAt: nextUtcMidnight(observedDate).toISOString(),
          metadata: { dailyPnl, dailyLimitUsd } satisfies JsonRecord
        };
      }

      const weeklyPnl = await realizedPnlSince(env.TRADING_DB, startOfUtcWeek(observedDate));
      const weeklyLimitUsd = equity * config.WEEKLY_LOSS_LIMIT_PCT;
      if (weeklyLimitUsd > 0 && weeklyPnl <= -weeklyLimitUsd) {
        return {
          blocked: true,
          reason: "WEEKLY_LOSS_LIMIT",
          resumesAt: nextUtcMonday(observedDate).toISOString(),
          metadata: { weeklyPnl, weeklyLimitUsd } satisfies JsonRecord
        };
      }

      const consecutiveLosses = await latestConsecutiveLosses(
        env.TRADING_DB,
        config.MAX_CONSECUTIVE_LOSSES
      );
      if (consecutiveLosses >= config.MAX_CONSECUTIVE_LOSSES) {
        return {
          blocked: true,
          reason: "CONSECUTIVE_LOSSES",
          metadata: { consecutiveLosses } satisfies JsonRecord
        };
      }

      const rollingDrawdownPct = Math.max(
        engineState.riskMetrics.rollingDrawdownPct,
        await realizedDrawdownPctSince(env.TRADING_DB, thirtyDaysBefore(observedDate), equity)
      );
      if (config.MAX_DRAWDOWN_PCT > 0 && rollingDrawdownPct >= config.MAX_DRAWDOWN_PCT) {
        return {
          blocked: true,
          reason: "DRAWDOWN_LIMIT",
          metadata: {
            rollingDrawdownPct,
            maxDrawdownPct: config.MAX_DRAWDOWN_PCT
          } satisfies JsonRecord
        };
      }

      return { blocked: false };
    } catch (error) {
      console.error(
        "[Sovereign-Sigma] risk limiter failed closed",
        error instanceof Error ? error.message : error
      );
      return {
        blocked: true,
        reason: "DRAWDOWN_LIMIT",
        metadata: { gate: "risk_limiter_unavailable" } satisfies JsonRecord
      };
    }
  }
}

async function realizedPnlSince(db: D1Database, since: Date): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(resulting_pnl), 0) AS pnl
       FROM trades
       WHERE executed_at >= ?
         AND status IN (${REALIZED_STATUSES_SQL})`
    )
    .bind(since.toISOString())
    .first<PnlRow>();

  return numeric(row?.pnl);
}

async function latestConsecutiveLosses(
  db: D1Database,
  maxConsecutiveLosses: number
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT resulting_pnl
       FROM trades
       WHERE status IN (${REALIZED_STATUSES_SQL})
       ORDER BY executed_at DESC
       LIMIT ?`
    )
    .bind(maxConsecutiveLosses)
    .all<TradePnlRow>();

  let losses = 0;
  for (const row of rows.results ?? []) {
    if (numeric(row.resulting_pnl) < 0) {
      losses += 1;
      continue;
    }
    break;
  }

  return losses;
}

async function realizedDrawdownPctSince(
  db: D1Database,
  since: Date,
  equity: number
): Promise<number> {
  const pnl = await realizedPnlSince(db, since);
  return pnl < 0 ? Math.abs(pnl) / equity : 0;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcWeek(date: Date): Date {
  const dayStart = startOfUtcDay(date);
  const daysSinceMonday = (dayStart.getUTCDay() + 6) % 7;
  return new Date(dayStart.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
}

function nextUtcMidnight(date: Date): Date {
  const dayStart = startOfUtcDay(date);
  return new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
}

function nextUtcMonday(date: Date): Date {
  const weekStart = startOfUtcWeek(date);
  return new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
}

function thirtyDaysBefore(date: Date): Date {
  return new Date(date.getTime() - 30 * 24 * 60 * 60 * 1000);
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
