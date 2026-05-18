import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import { HeatManager } from "../../src/strategy/cascade/HeatManager";
import { PositionManager } from "../../src/strategy/cascade/PositionManager";
import { calculatePositionSize } from "../../src/strategy/cascade/PositionSizer";
import { RiskLimiter } from "../../src/strategy/cascade/RiskLimiter";
import type {
  CascadeOpenPosition,
  CascadeRecoverySignal,
  PositionSizeInput
} from "../../src/strategy/cascade/types";
import type { EngineState, Env } from "../../src/types";

describe("cascade position sizing", () => {
  it("selects the smallest bound across risk, notional, liquidity, and heat caps", () => {
    const base: PositionSizeInput = {
      equity: 10_000,
      riskPerTradePct: 0.01,
      entryPrice: 100,
      stopPrice: 95,
      maxPositionNotionalPct: 0.5,
      assetLiquidityCap: 10_000,
      currentHeat: 0,
      heatCapPct: 0.1
    };

    expect(calculatePositionSize(base).limitingFactor).toBe("RISK");
    expect(calculatePositionSize({ ...base, maxPositionNotionalPct: 0.05 }).limitingFactor).toBe(
      "NOTIONAL"
    );
    expect(calculatePositionSize({ ...base, assetLiquidityCap: 250 }).limitingFactor).toBe(
      "LIQUIDITY"
    );
    expect(calculatePositionSize({ ...base, currentHeat: 0.097 }).limitingFactor).toBe("HEAT");
  });
});

describe("cascade heat manager", () => {
  it("aggregates same-direction correlated heat", () => {
    const heat = new HeatManager().currentHeat([
      position({ instrumentCode: "btc-usd", direction: "LONG", initialRiskPct: 0.01 }),
      position({ instrumentCode: "eth-usd", direction: "LONG", initialRiskPct: 0.01 })
    ]);

    expect(heat).toBeCloseTo(Math.sqrt(0.0001 + 0.0001 + 2 * 0.85 * 0.0001), 8);
  });

  it("keeps opposite directional heat independent", () => {
    const heat = new HeatManager().currentHeat([
      position({ instrumentCode: "btc-usd", direction: "LONG", initialRiskPct: 0.01 }),
      position({ instrumentCode: "btc-usd", direction: "SHORT", initialRiskPct: 0.01 })
    ]);

    expect(heat).toBe(0.02);
  });

  it("ignores closed and fully exited positions", () => {
    const heat = new HeatManager().currentHeat([
      position({ status: "CLOSED", remainingSize: 1, initialRiskPct: 0.01 }),
      position({ status: "ENTERED", remainingSize: 0, initialRiskPct: 0.01 })
    ]);

    expect(heat).toBe(0);
  });

  it("pre-checks whether a candidate position would breach the heat cap", () => {
    const heat = new HeatManager(0.015);

    expect(
      heat.wouldExceedCap(
        [position({ instrumentCode: "btc-usd", direction: "LONG", initialRiskPct: 0.01 })],
        { instrumentCode: "eth-usd", direction: "LONG", initialRiskPct: 0.01 }
      )
    ).toBe(true);
    expect(
      heat.wouldExceedCap([], {
        instrumentCode: "btc-usd",
        direction: "LONG",
        initialRiskPct: 0.005
      })
    ).toBe(false);
  });
});

describe("cascade position manager", () => {
  it("fires the time stop exactly at the deadline when the position has not reached 1R", () => {
    const manager = new PositionManager();
    const open = manager.registerFromSignal(signal(), sizeDecision());

    const update = manager.updatePosition(open, {
      instrumentCode: "btc-usd",
      price: 101,
      observedAt: "2026-05-18T18:00:00.000Z"
    });

    expect(update.position.status).toBe("TIME_STOPPED");
    expect(update.intents).toHaveLength(1);
    expect(update.intents[0]).toMatchObject({ closeReason: "TIME_STOP", action: "SELL" });
  });

  it("never moves a trailing stop against the position", () => {
    const manager = new PositionManager();
    const open = manager.registerFromSignal(signal(), sizeDecision());
    open.status = "FIRST_TARGET_HIT";
    open.firstTargetTaken = true;
    open.currentStopPrice = 100;

    const update = manager.updatePosition(open, {
      instrumentCode: "btc-usd",
      price: 104,
      observedAt: "2026-05-18T13:00:00.000Z",
      atr: 4
    });

    expect(update.position.currentStopPrice).toBe(100);
    expect(update.intents.some((intent) => intent.kind === "MOVE_STOP")).toBe(false);
  });

  it("takes the first target and moves the stop to breakeven", () => {
    const manager = new PositionManager();
    const open = manager.registerFromSignal(signal(), sizeDecision());

    const update = manager.updatePosition(open, {
      instrumentCode: "btc-usd",
      price: 110,
      observedAt: "2026-05-18T13:00:00.000Z"
    });

    expect(update.position.status).toBe("FIRST_TARGET_HIT");
    expect(update.position.remainingSize).toBeCloseTo(open.totalSize * 0.7, 8);
    expect(update.position.currentStopPrice).toBe(100);
    expect(update.intents.map((intent) => intent.kind)).toEqual(["CLOSE", "MOVE_STOP"]);
  });

  it("takes the second target and moves the stop to the first target", () => {
    const manager = new PositionManager();
    const open = manager.registerFromSignal(signal(), sizeDecision());
    open.status = "FIRST_TARGET_HIT";
    open.firstTargetTaken = true;
    open.currentStopPrice = 100;
    open.remainingSize = open.totalSize * 0.7;

    const update = manager.updatePosition(open, {
      instrumentCode: "btc-usd",
      price: 115,
      observedAt: "2026-05-18T14:00:00.000Z"
    });

    expect(update.position.status).toBe("SECOND_TARGET_HIT");
    expect(update.position.currentStopPrice).toBe(110);
    expect(update.intents.map((intent) => intent.kind)).toEqual(["CLOSE", "MOVE_STOP"]);
  });

  it("closes remaining size when the stop is hit", () => {
    const manager = new PositionManager();
    const open = manager.registerFromSignal(signal(), sizeDecision());

    const update = manager.updatePosition(open, {
      instrumentCode: "btc-usd",
      price: 94,
      observedAt: "2026-05-18T13:00:00.000Z"
    });

    expect(update.position.status).toBe("STOPPED_OUT");
    expect(update.intents).toHaveLength(1);
    expect(update.intents[0]).toMatchObject({ closeReason: "STOP_LOSS", action: "SELL" });
  });

  it("supports explicit operator manual closes", () => {
    const manager = new PositionManager();
    const open = manager.registerFromSignal(signal(), sizeDecision());

    const update = manager.requestManualClose(open.positionId, "2026-05-18T13:00:00.000Z", 103);

    expect(update?.position.status).toBe("CLOSED");
    expect(update?.intents[0]).toMatchObject({
      closeReason: "MANUAL",
      executionStyle: "TAKER_IOC",
      referencePrice: 103
    });
  });
});

describe("cascade risk limiter", () => {
  it("blocks daily losses and clears at midnight UTC", async () => {
    const limiter = new RiskLimiter();
    const env = envWithTrades([{ pnl: -250, executedAt: "2026-05-18T12:00:00.000Z" }]);
    const state = engineState({ DAILY_LOSS_LIMIT_PCT: 0.02 });

    await expect(
      limiter.shouldBlockNewEntries(env, state, "2026-05-18T13:00:00.000Z")
    ).resolves.toMatchObject({
      blocked: true,
      reason: "DAILY_LOSS_LIMIT",
      resumesAt: "2026-05-19T00:00:00.000Z"
    });
    await expect(
      limiter.shouldBlockNewEntries(env, state, "2026-05-19T00:00:00.000Z")
    ).resolves.toEqual({
      blocked: false
    });
  });

  it("blocks weekly losses and clears on Monday UTC", async () => {
    const limiter = new RiskLimiter();
    const env = envWithTrades([{ pnl: -600, executedAt: "2026-05-20T12:00:00.000Z" }]);
    const state = engineState({ WEEKLY_LOSS_LIMIT_PCT: 0.05 });

    await expect(
      limiter.shouldBlockNewEntries(env, state, "2026-05-20T13:00:00.000Z")
    ).resolves.toMatchObject({
      blocked: true,
      reason: "WEEKLY_LOSS_LIMIT",
      resumesAt: "2026-05-25T00:00:00.000Z"
    });
    await expect(
      limiter.shouldBlockNewEntries(env, state, "2026-05-25T00:00:00.000Z")
    ).resolves.toEqual({
      blocked: false
    });
  });

  it("blocks consecutive losses and clears after a winning trade", async () => {
    const limiter = new RiskLimiter();
    const blockedEnv = envWithTrades([
      { pnl: -10, executedAt: "2026-05-18T12:00:00.000Z" },
      { pnl: -10, executedAt: "2026-05-18T12:01:00.000Z" },
      { pnl: -10, executedAt: "2026-05-18T12:02:00.000Z" }
    ]);
    const clearEnv = envWithTrades([
      { pnl: -10, executedAt: "2026-05-18T12:00:00.000Z" },
      { pnl: -10, executedAt: "2026-05-18T12:01:00.000Z" },
      { pnl: 5, executedAt: "2026-05-18T12:02:00.000Z" }
    ]);
    const state = engineState({ MAX_CONSECUTIVE_LOSSES: 3 });

    await expect(
      limiter.shouldBlockNewEntries(blockedEnv, state, "2026-05-18T13:00:00.000Z")
    ).resolves.toMatchObject({ blocked: true, reason: "CONSECUTIVE_LOSSES" });
    await expect(
      limiter.shouldBlockNewEntries(clearEnv, state, "2026-05-18T13:00:00.000Z")
    ).resolves.toEqual({
      blocked: false
    });
  });

  it("blocks entries when portfolio drawdown breaches the cascade cap", async () => {
    const limiter = new RiskLimiter();
    const state = engineState({ MAX_DRAWDOWN_PCT: 0.15 });
    state.riskMetrics.rollingDrawdownPct = 0.2;

    await expect(
      limiter.shouldBlockNewEntries(envWithTrades([]), state, "2026-05-18T13:00:00.000Z")
    ).resolves.toMatchObject({
      blocked: true,
      reason: "DRAWDOWN_LIMIT"
    });
  });
});

function signal(): CascadeRecoverySignal {
  return {
    schemaVersion: "cascade.recovery-signal.v1",
    signalId: "sig-1",
    cascadeId: "cascade-1",
    instrumentCode: "btc-usd",
    direction: "LONG",
    triggerType: "STRUCTURAL_RECLAIM",
    entryPrice: 100,
    stopPrice: 95,
    rDistance: 5,
    targets: {
      partial1: { price: 110, rMultiple: 2.0, sizePct: 30 },
      partial2: { price: 115, rMultiple: 3.0, sizePct: 30 },
      runner: { trailingType: "ATR", trailingParam: 2, sizePct: 40 }
    },
    timeStopAt: "2026-05-18T18:00:00.000Z",
    confidence: 0.75,
    context: {},
    emittedAt: "2026-05-18T12:00:00.000Z"
  };
}

function sizeDecision() {
  return calculatePositionSize({
    equity: 10_000,
    riskPerTradePct: 0.01,
    entryPrice: 100,
    stopPrice: 95,
    maxPositionNotionalPct: 0.1,
    assetLiquidityCap: 10_000,
    currentHeat: 0,
    heatCapPct: 0.1
  });
}

function position(overrides: Partial<CascadeOpenPosition> = {}): CascadeOpenPosition {
  return {
    positionId: "pos-1",
    signalId: "sig-1",
    cascadeId: "cascade-1",
    instrumentCode: "btc-usd",
    direction: "LONG",
    status: "ENTERED",
    entryPrice: 100,
    currentStopPrice: 95,
    initialStopPrice: 95,
    totalSize: 1,
    remainingSize: 1,
    initialRiskPct: 0.01,
    rDistance: 5,
    targets: {
      partial1: { price: 110, rMultiple: 2.0, sizePct: 30 },
      partial2: { price: 115, rMultiple: 3.0, sizePct: 30 },
      runner: { trailingType: "ATR", trailingParam: 2, sizePct: 40 }
    },
    timeStopAt: "2026-05-18T18:00:00.000Z",
    firstTargetTaken: false,
    secondTargetTaken: false,
    enteredAt: "2026-05-18T12:00:00.000Z",
    updatedAt: "2026-05-18T12:00:00.000Z",
    ...overrides
  };
}

function engineState(config: Partial<EngineState["cachedConfig"]> = {}): EngineState {
  return {
    bankroll: { equity: 10_000 },
    cachedConfig: {
      ...defaultConfig,
      DAILY_LOSS_LIMIT_PCT: 1,
      WEEKLY_LOSS_LIMIT_PCT: 1,
      MAX_CONSECUTIVE_LOSSES: 99,
      MAX_DRAWDOWN_PCT: 1,
      ...config
    },
    riskMetrics: { rollingDrawdownPct: 0 }
  } as unknown as EngineState;
}

interface TestTrade {
  pnl: number;
  executedAt: string;
}

function envWithTrades(trades: readonly TestTrade[]): Env {
  return {
    TRADING_DB: mockD1(trades)
  } as unknown as Env;
}

function mockD1(trades: readonly TestTrade[]): D1Database {
  return {
    prepare: (sql: string) =>
      ({
        bind: (...values: unknown[]) => {
          const firstValue = values[0];
          return {
            first: async () => {
              const since =
                typeof firstValue === "string" ? firstValue : "1970-01-01T00:00:00.000Z";
              return { pnl: tradesSince(trades, since).reduce((sum, trade) => sum + trade.pnl, 0) };
            },
            all: async () => {
              if (sql.includes("ORDER BY executed_at DESC")) {
                const limit = Number(firstValue ?? trades.length);
                return {
                  results: [...trades]
                    .sort(
                      (left, right) => Date.parse(right.executedAt) - Date.parse(left.executedAt)
                    )
                    .slice(0, limit)
                    .map((trade) => ({ resulting_pnl: trade.pnl }))
                };
              }
              return { results: [] };
            }
          };
        }
      }) as D1PreparedStatement
  } as unknown as D1Database;
}

function tradesSince(trades: readonly TestTrade[], since: string): TestTrade[] {
  const sinceMs = Date.parse(since);
  return trades.filter((trade) => Date.parse(trade.executedAt) >= sinceMs);
}
