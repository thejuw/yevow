import { describe, expect, it } from "vitest";
import {
  defaultReplayStatus,
  markHistoricalReplayTrades,
  ReplayJournal
} from "../../src/engine/trading/replay/ReplayJournal";
import type { Logger } from "../../src/Logger";
import type { Env, MarketTick, ReplayResult } from "../../src/types";
import type {
  ReplayOptions,
  ReplayStatus
} from "../../src/engine/trading/routes/ReplayAdminRoutes";

describe("replay journal", () => {
  it("returns default status and publishes status writes", async () => {
    const storage = new Map<string, unknown>();
    const published: string[] = [];
    const journal = new ReplayJournal({
      env: replayEnv(new FakeReplayDb()),
      logger: fakeLogger(),
      readStorage: async <T>(key: string) => storage.get(key) as T | undefined,
      writeStorage: async (key, value) => {
        storage.set(key, value);
      },
      publish: (type) => published.push(type),
      onStorageReadFailure: () => undefined
    });

    expect(await journal.currentStatus()).toMatchObject(defaultReplayStatus());

    const status: ReplayStatus = {
      replayId: "replay-1",
      status: "RUNNING",
      ticksTotal: 10,
      ticksProcessed: 5,
      progressPct: 50,
      speedMultiplier: 2,
      shadowBankroll: 100,
      dateFrom: null,
      dateTo: null,
      scenario: "BASELINE",
      error: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      completedAt: null
    };

    await journal.writeStatus(status);
    expect(await journal.currentStatus()).toEqual(status);
    expect(published).toEqual(["REPLAY_PROGRESS"]);
  });

  it("reports storage read failures and defaults missing status scenarios", async () => {
    const failures: string[] = [];
    const published: Record<string, unknown>[] = [];
    const journal = new ReplayJournal({
      env: replayEnv(new FakeReplayDb()),
      logger: fakeLogger(),
      readStorage: async () => {
        throw new Error("storage_read_failed");
      },
      writeStorage: async () => undefined,
      publish: (_type, payload) => published.push(payload),
      onStorageReadFailure: (reason) => failures.push(reason)
    });

    expect(await journal.currentStatus()).toMatchObject({ status: "IDLE" });
    await journal.writeStatus({
      ...defaultReplayStatus(),
      replayId: "replay-2",
      scenario: undefined,
      status: "COMPLETED"
    });

    expect(failures).toEqual(["REPLAY_STATUS_READ"]);
    expect(published[0]).toMatchObject({ replayId: "replay-2", scenario: "BASELINE" });
  });

  it("loads replay ticks from market tick journal and falls back to telemetry logs", async () => {
    const primaryDb = new FakeReplayDb();
    primaryDb.marketTickRows = [
      { tick_json: JSON.stringify(marketTick("btc-usd", 100, "2026-01-01T00:00:00.000Z")) },
      { tick_json: JSON.stringify({ schemaVersion: "wrong" }) }
    ];
    const primaryJournal = replayJournal(primaryDb);

    expect(await primaryJournal.loadTicks(10, "2026-01-01", "2026-01-02")).toHaveLength(1);
    expect(primaryDb.statements[0].values).toEqual(["2026-01-01", "2026-01-02", 10]);
    expect(await primaryJournal.loadTicks(3, null, null)).toHaveLength(1);

    const fallbackDb = new FakeReplayDb();
    fallbackDb.failMarketTicks = true;
    fallbackDb.telemetryRows = [
      {
        telemetry_json: JSON.stringify({
          tick: marketTick("hype-usd", 5, "2026-01-01T00:00:01.000Z")
        })
      }
    ];
    const warnings: string[] = [];
    const fallbackJournal = replayJournal(fallbackDb, warnings);

    expect(await fallbackJournal.loadTicks(5, null, null)).toMatchObject([
      { instrumentCode: "hype-usd" }
    ]);
    expect(warnings).toEqual(["REPLAY_TICK_JOURNAL_UNAVAILABLE"]);

    await fallbackJournal.loadTicks(2, "2026-01-01", "2026-01-02");
    expect(fallbackDb.statements.at(-1)?.values).toEqual(["2026-01-01", "2026-01-02", 2]);
  });

  it("loads filled replay trades and marks historical trade exits", async () => {
    const db = new FakeReplayDb();
    db.tradeRows = [
      {
        trade_id: "t1",
        asset: "BTC-USD",
        side: "BUY",
        price: 100,
        size: 2,
        executed_at: "2026-01-01T00:00:00.000Z",
        status: "FILLED"
      },
      {
        trade_id: "t2",
        asset: "BTC-USD",
        side: "IGNORED",
        price: 100,
        size: 1,
        executed_at: "2026-01-01T00:00:00.000Z",
        status: "FILLED"
      }
    ];
    const trades = await replayJournal(db).loadTrades(
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:01:00.000Z"
    );
    const marked = markHistoricalReplayTrades(trades, [
      marketTick("btc-usd", 105, "2026-01-01T00:00:02.000Z")
    ]);

    expect(trades).toHaveLength(1);
    expect(await replayJournal(db).loadTrades(null, null)).toHaveLength(1);
    expect(marked).toEqual([
      expect.objectContaining({
        tradeId: "shadow:t1",
        side: "BUY",
        exitPrice: 105,
        theoreticalPnl: 10
      })
    ]);
    expect(
      markHistoricalReplayTrades(
        [
          {
            trade_id: "t3",
            asset: "BTC-USD",
            side: "SELL",
            price: 100,
            size: 1,
            executed_at: "2026-01-01T00:00:10.000Z",
            status: "FILLED"
          }
        ],
        [marketTick("btc-usd", 95, "2026-01-01T00:00:01.000Z")]
      )
    ).toEqual([
      expect.objectContaining({
        exitPrice: null,
        theoreticalPnl: 0,
        closedAt: null
      })
    ]);
  });

  it("records backtest runs and swallows journal write failures", async () => {
    const db = new FakeReplayDb();
    const warnings: string[] = [];
    const journal = replayJournal(db, warnings);

    await journal.recordBacktestRun(replayResult(), replayOptions(), "2026-01-01", "2026-01-02");
    expect(db.runStatements).toHaveLength(1);
    expect(db.runStatements[0].values[0]).toBe("replay-1");
    await journal.recordBacktestRun(
      { ...replayResult(), simulatedTradeCount: undefined, maxDrawdown: undefined },
      replayOptions(),
      null,
      null
    );
    expect(db.runStatements.at(-1)?.values[8]).toBe(0);
    expect(db.runStatements.at(-1)?.values[10]).toBe(0);

    db.failRun = true;
    await journal.recordBacktestRun(replayResult(), replayOptions(), null, null);
    expect(warnings).toContain("BACKTEST_RUN_JOURNAL_FAILED");
  });
});

function replayJournal(db: FakeReplayDb, warnings: string[] = []): ReplayJournal {
  return new ReplayJournal({
    env: replayEnv(db),
    logger: fakeLogger(warnings),
    readStorage: async () => undefined,
    writeStorage: async () => undefined,
    publish: () => undefined,
    onStorageReadFailure: () => undefined
  });
}

function replayEnv(db: FakeReplayDb): Env {
  return { TRADING_DB: db } as unknown as Env;
}

function fakeLogger(warnings: string[] = []): Logger {
  return {
    warn: (eventType: string) => warnings.push(eventType)
  } as unknown as Logger;
}

function marketTick(instrumentCode: string, price: number, receivedAt: string): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    streamId: "stream",
    connectionId: "connection",
    sourceChannel: "trades",
    exchangeCode: "hyperliquid",
    instrumentCode,
    baseAsset: instrumentCode.split("-")[0] ?? "btc",
    quoteAsset: "usd",
    price,
    size: 1,
    side: "buy",
    sequence: 1,
    providerTimestamp: receivedAt,
    exchangeTimestamp: receivedAt,
    synchronizedExchangeTimestamp: receivedAt,
    clockOffsetMs: 0,
    receivedAt,
    sourceWeight: 1,
    raw: {}
  };
}

function replayOptions(): ReplayOptions {
  return {
    scenario: "BASELINE",
    latencyMs: 10,
    slippageBps: 1,
    feeBps: 0,
    exitAfterTicks: 10,
    walkForward: false,
    sentimentAblation: true,
    strategyVersionId: "strategy-1",
    actor: "test"
  };
}

function replayResult(): ReplayResult {
  return {
    replayId: "replay-1",
    strategyVersionId: "strategy-1",
    scenario: "BASELINE",
    ticksReplayed: 10,
    shadowBankroll: 110,
    theoreticalPnl: 10,
    baselinePnl: 0,
    actualTradeCount: 1,
    generatedIntentCount: 2,
    simulatedTradeCount: 1,
    speedMultiplier: 1,
    maxDrawdown: 0,
    sharpe: 1,
    winRate: 1,
    latencyModel: {},
    slippageModel: {},
    feeModel: {},
    attribution: {},
    stressResults: [],
    walkForward: [],
    ablation: null,
    shadowTrades: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z"
  };
}

class FakeReplayDb {
  readonly statements: FakeReplayStatement[] = [];
  readonly runStatements: FakeReplayStatement[] = [];
  marketTickRows: Record<string, unknown>[] = [];
  telemetryRows: Record<string, unknown>[] = [];
  tradeRows: Record<string, unknown>[] = [];
  failMarketTicks = false;
  failRun = false;

  prepare(sql: string): FakeReplayStatement {
    const statement = new FakeReplayStatement(this, sql);
    this.statements.push(statement);
    return statement;
  }
}

class FakeReplayStatement {
  readonly values: unknown[] = [];

  constructor(
    private readonly db: FakeReplayDb,
    readonly sql: string
  ) {}

  bind(...values: unknown[]): this {
    this.values.push(...values);
    return this;
  }

  async all(): Promise<{ results: unknown[] }> {
    if (this.sql.includes("FROM market_ticks")) {
      if (this.db.failMarketTicks) {
        throw new Error("market_ticks_unavailable");
      }
      return { results: this.db.marketTickRows };
    }

    if (this.sql.includes("FROM logs")) {
      return { results: this.db.telemetryRows };
    }

    return { results: this.db.tradeRows };
  }

  async run(): Promise<void> {
    if (this.db.failRun) {
      throw new Error("run_failed");
    }

    this.db.runStatements.push(this);
  }
}
