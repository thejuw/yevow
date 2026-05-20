import type { Logger } from "../../../Logger";
import { REPLAY_STATUS_KEY } from "../../../TradingEngineConstants";
import { safeParseJson } from "../helpers/RuntimeHelpers";
import type { Env, MarketTick, ReplayResult } from "../../../types";
import type { ReplayOptions, ReplayStatus } from "../routes/ReplayAdminRoutes";

export interface ReplayTickRow {
  tick_json: string;
  received_at: string;
}

export interface ReplayTradeRow {
  trade_id: string;
  asset: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  executed_at: string;
  status: string;
}

export interface ReplayJournalOptions {
  env: Env;
  logger: Logger;
  readStorage<T>(key: string): Promise<T | undefined>;
  writeStorage(key: string, value: unknown, reason: string): Promise<void>;
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
  onStorageReadFailure(reason: string, error: unknown): void;
}

export class ReplayJournal {
  constructor(private readonly options: ReplayJournalOptions) {}

  async currentStatus(): Promise<ReplayStatus> {
    let status: ReplayStatus | undefined;
    try {
      status = await this.options.readStorage<ReplayStatus>(REPLAY_STATUS_KEY);
    } catch (error) {
      this.options.onStorageReadFailure("REPLAY_STATUS_READ", error);
    }

    return status ?? defaultReplayStatus();
  }

  async writeStatus(status: ReplayStatus): Promise<void> {
    await this.options.writeStorage(REPLAY_STATUS_KEY, status, "REPLAY_STATUS");
    this.options.publish("REPLAY_PROGRESS", {
      replayId: status.replayId,
      status: status.status,
      ticksTotal: status.ticksTotal,
      ticksProcessed: status.ticksProcessed,
      progressPct: status.progressPct,
      speedMultiplier: status.speedMultiplier,
      dateFrom: status.dateFrom,
      dateTo: status.dateTo,
      scenario: status.scenario ?? "BASELINE",
      error: status.error,
      updatedAt: status.updatedAt,
      completedAt: status.completedAt
    });
  }

  async loadTicks(
    limit: number,
    dateFrom: string | null,
    dateTo: string | null
  ): Promise<MarketTick[]> {
    try {
      const where: string[] = [];
      const binds: (string | number)[] = [];

      if (dateFrom) {
        where.push("received_at >= ?");
        binds.push(dateFrom);
      }
      if (dateTo) {
        where.push("received_at <= ?");
        binds.push(dateTo);
      }

      binds.push(limit);
      const rows = await this.options.env.TRADING_DB.prepare(
        `SELECT tick_json, received_at
         FROM market_ticks
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY received_at ASC
         LIMIT ?`
      )
        .bind(...binds)
        .all<ReplayTickRow>();

      return (rows.results ?? [])
        .map((row) => safeParseJson<MarketTick>(row.tick_json))
        .filter((tick): tick is MarketTick => tick?.schemaVersion === "universal-tick.v1");
    } catch (error) {
      this.options.logger.warn(
        "REPLAY_TICK_JOURNAL_UNAVAILABLE",
        "Falling back to telemetry logs for replay",
        {
          error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
        }
      );
      return this.loadTelemetryTicks(limit, dateFrom, dateTo);
    }
  }

  async loadTrades(
    startedAt: string | null,
    completedAt: string | null
  ): Promise<ReplayTradeRow[]> {
    const where = ["status IN ('FILLED', 'PARTIAL')"];
    const binds: string[] = [];

    if (startedAt) {
      where.push("executed_at >= ?");
      binds.push(startedAt);
    }
    if (completedAt) {
      where.push("executed_at <= ?");
      binds.push(completedAt);
    }

    const rows = await this.options.env.TRADING_DB.prepare(
      `SELECT trade_id, asset, side, price, size, executed_at, status
       FROM trades
       WHERE ${where.join(" AND ")}
       ORDER BY executed_at ASC
       LIMIT 5000`
    )
      .bind(...binds)
      .all<ReplayTradeRow>();

    return (rows.results ?? []).filter((row) => row.side === "BUY" || row.side === "SELL");
  }

  async recordBacktestRun(
    result: ReplayResult,
    options: ReplayOptions,
    dateFrom: string | null,
    dateTo: string | null
  ): Promise<void> {
    try {
      await this.options.env.TRADING_DB.prepare(
        `INSERT INTO backtest_runs (
           run_id, strategy_version_id, scenario, asset_filter, date_from, date_to,
           ticks_replayed, generated_intent_count, simulated_trade_count,
           theoretical_pnl, max_drawdown, sharpe, win_rate,
           latency_model_json, slippage_model_json, fee_model_json,
           attribution_json, stress_json, ablation_json, created_by, started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          result.replayId,
          options.strategyVersionId,
          options.scenario,
          null,
          dateFrom,
          dateTo,
          result.ticksReplayed,
          result.generatedIntentCount,
          result.simulatedTradeCount ?? 0,
          result.theoreticalPnl,
          result.maxDrawdown ?? 0,
          result.sharpe,
          result.winRate,
          JSON.stringify(result.latencyModel ?? {}),
          JSON.stringify(result.slippageModel ?? {}),
          JSON.stringify(result.feeModel ?? {}),
          JSON.stringify(result.attribution ?? {}),
          JSON.stringify(result.stressResults ?? []),
          JSON.stringify(result.ablation ?? {}),
          options.actor,
          result.startedAt,
          result.completedAt
        )
        .run();
    } catch (error) {
      this.options.logger.warn(
        "BACKTEST_RUN_JOURNAL_FAILED",
        "Replay completed but D1 backtest journal failed",
        {
          replayId: result.replayId,
          error: error instanceof Error ? error.message : "UNKNOWN_D1_ERROR"
        }
      );
    }
  }

  private async loadTelemetryTicks(
    limit: number,
    dateFrom: string | null,
    dateTo: string | null
  ): Promise<MarketTick[]> {
    const where = ["telemetry_json LIKE '%\"tick\"%'"];
    const binds: (string | number)[] = [];

    if (dateFrom) {
      where.push("created_at >= ?");
      binds.push(dateFrom);
    }
    if (dateTo) {
      where.push("created_at <= ?");
      binds.push(dateTo);
    }

    binds.push(limit);
    const rows = await this.options.env.TRADING_DB.prepare(
      `SELECT telemetry_json, created_at
         FROM logs
         WHERE ${where.join(" AND ")}
         ORDER BY created_at ASC
         LIMIT ?`
    )
      .bind(...binds)
      .all<{ telemetry_json: string; created_at: string }>();

    return (rows.results ?? [])
      .map((row) => safeParseJson<{ tick?: MarketTick }>(row.telemetry_json)?.tick ?? null)
      .filter((tick): tick is MarketTick => tick?.schemaVersion === "universal-tick.v1");
  }
}

export function markHistoricalReplayTrades(
  historicalTrades: ReplayTradeRow[],
  ticks: MarketTick[]
): ReplayResult["shadowTrades"] {
  return historicalTrades.map((trade) => {
    const exitTick = ticks.find(
      (tick) =>
        tick.instrumentCode === trade.asset.toLowerCase() &&
        Date.parse(tick.receivedAt) > Date.parse(trade.executed_at)
    );
    const exitPrice = exitTick?.price ?? null;
    const theoreticalPnl =
      exitPrice === null
        ? 0
        : (trade.side === "BUY" ? 1 : -1) * (exitPrice - trade.price) * trade.size;

    return {
      tradeId: `shadow:${trade.trade_id}`,
      instrumentCode: trade.asset.toLowerCase(),
      side: trade.side,
      entryPrice: trade.price,
      exitPrice,
      size: trade.size,
      theoreticalPnl,
      openedAt: trade.executed_at,
      closedAt: exitTick?.receivedAt ?? null
    };
  });
}

export function defaultReplayStatus(): ReplayStatus {
  return {
    replayId: null,
    status: "IDLE",
    ticksTotal: 0,
    ticksProcessed: 0,
    progressPct: 0,
    speedMultiplier: 1,
    shadowBankroll: 0,
    dateFrom: null,
    dateTo: null,
    scenario: "BASELINE",
    error: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    completedAt: null
  };
}
