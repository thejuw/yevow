import { describe, expect, it } from "vitest";
import {
  runHistoricalReplayRuntime,
  runShadowReplayWithRestoreRuntime
} from "../../src/engine/trading/replay/ReplayRunRuntime";
import {
  runTradingHistoricalReplayForTarget,
  type TradingHistoricalReplayEngineTarget
} from "../../src/engine/trading/replay/TradingReplayRunRuntime";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import type { ReplayOptions } from "../../src/engine/trading/routes/ReplayAdminRoutes";
import type { EngineReplaySnapshot } from "../../src/engine/trading/replay/ReplaySnapshotRuntime";
import type { ShadowReplayWithRestoreInput } from "../../src/engine/trading/pipelines/TickPipelineTypes";
import type { MarketTick, ReplayResult } from "../../src/types";

const STARTED_AT = "2026-05-18T10:00:00.000Z";
const UPDATED_AT = "2026-05-18T10:00:01.000Z";

describe("ReplayRunRuntime", () => {
  it("restores the live snapshot after successful and failed shadow replay loops", async () => {
    const liveSnapshot = { engineState: { engineId: "live" } } as unknown as EngineReplaySnapshot;
    const input = shadowReplayWithRestoreInput(liveSnapshot);
    const successCalls: string[] = [];

    const success = await runShadowReplayWithRestoreRuntime(input, {
      runShadowReplay: async (replayInput) => {
        successCalls.push(`loop:${replayInput.replayId}`);
        return {
          ticksReplayed: 1,
          generatedIntentCount: 1,
          modeledTrades: [trade({ tradeId: "modeled-success" })]
        };
      },
      restoreReplaySnapshot: async (snapshot) => {
        successCalls.push(`restore:${snapshot === liveSnapshot}`);
      }
    });

    expect(success.generatedIntentCount).toBe(1);
    expect(successCalls).toEqual(["loop:replay-runtime", "restore:true"]);

    const failureCalls: string[] = [];
    await expect(
      runShadowReplayWithRestoreRuntime(input, {
        runShadowReplay: async (replayInput) => {
          failureCalls.push(`loop:${replayInput.replayId}`);
          throw new Error("loop failed");
        },
        restoreReplaySnapshot: async (snapshot) => {
          failureCalls.push(`restore:${snapshot === liveSnapshot}`);
        }
      })
    ).rejects.toThrow("loop failed");
    expect(failureCalls).toEqual(["loop:replay-runtime", "restore:true"]);
  });

  it("orchestrates historical replay setup, shadow run, and completion recording", async () => {
    const calls: string[] = [];
    const ticks = [tick("2026-05-01T00:00:00.000Z", 100), tick("2026-05-01T00:00:01.000Z", 101)];
    const liveSnapshot = { engineState: { engineId: "live" } } as unknown as EngineReplaySnapshot;
    const modeledTrade = trade({ tradeId: "modeled-1", theoreticalPnl: 5 });
    const historicalShadowTrade = trade({ tradeId: "historical-1", theoreticalPnl: 1 });
    const options = replayOptions();

    const result = await runHistoricalReplayRuntime(
      {
        limit: 500,
        requestedShadowBankroll: 0,
        speedMultiplier: 4,
        dateFrom: "2026-05-01",
        dateTo: "2026-05-02",
        replayOptions: options,
        startedAt: STARTED_AT,
        replayId: "replay-runtime",
        fallbackBankroll: 300
      },
      {
        nowIso: () => UPDATED_AT,
        writeRunningStatus: async (status) => {
          calls.push(`status:${status.ticksTotal}:${status.shadowBankroll}:${status.updatedAt}`);
        },
        captureReplaySnapshot: () => {
          calls.push("snapshot");
          return liveSnapshot;
        },
        loadScenarioReplayTicks: async (limit, dateFrom, dateTo, scenario) => {
          calls.push(`ticks:${limit}:${dateFrom}:${dateTo}:${scenario}`);
          return { sourceTicks: ticks, ticks };
        },
        currentLiveBankroll: () => {
          calls.push("bankroll");
          return { equity: 250, cash: 350 };
        },
        loadReplayShadowTrades: async (loadedTicks) => {
          calls.push(`shadow-trades:${loadedTicks.length}`);
          return {
            historicalTrades: [
              {
                trade_id: "trade-1",
                asset: "BTC-USD",
                side: "BUY",
                price: 100,
                size: 1,
                executed_at: STARTED_AT,
                status: "FILLED"
              }
            ],
            shadowTrades: [historicalShadowTrade]
          };
        },
        prepareShadowReplayState: (initialShadowBankroll, startedAt, replayId) => {
          calls.push(`prepare:${initialShadowBankroll}:${startedAt}:${replayId}`);
        },
        runShadowReplayWithRestore: async (input) => {
          calls.push(
            `loop:${input.ticks.length}:${input.initialShadowBankroll}:${input.liveSnapshot === liveSnapshot}`
          );
          return {
            ticksReplayed: 2,
            generatedIntentCount: 1,
            modeledTrades: [modeledTrade]
          };
        },
        recordCompletedReplay: async (input) => {
          calls.push(
            `complete:${input.ticksLength}:${input.initialShadowBankroll}:${input.historicalTradeCount}:${input.replayLoop.generatedIntentCount}`
          );
          expect(input.shadowTrades).toEqual([historicalShadowTrade]);
          return replayResult({ shadowBankroll: input.initialShadowBankroll + 5 });
        }
      }
    );

    expect(result.shadowBankroll).toBe(355);
    expect(calls).toEqual([
      `status:0:0:${STARTED_AT}`,
      "snapshot",
      "ticks:500:2026-05-01:2026-05-02:BASELINE",
      "bankroll",
      `status:2:350:${UPDATED_AT}`,
      "shadow-trades:2",
      `prepare:350:${STARTED_AT}:replay-runtime`,
      "loop:2:350:true",
      "complete:2:350:1:1"
    ]);
  });

  it("runs historical replay through the trading engine target adapter", async () => {
    const calls: string[] = [];
    const engineState = defaultEngineState("trading-replay-target");
    engineState.bankroll.cash = 350;
    engineState.bankroll.equity = 250;
    const liveSnapshot = { engineState: { engineId: "live" } } as unknown as EngineReplaySnapshot;
    const replayTick = tick("2026-05-01T00:00:00.000Z", 100);
    const target: TradingHistoricalReplayEngineTarget = {
      replayJournal: {
        async loadTicks(limit, dateFrom, dateTo) {
          calls.push(`ticks:${limit}:${dateFrom}:${dateTo}`);
          return [replayTick];
        },
        async loadTrades(startedAt, completedAt) {
          calls.push(`trades:${startedAt}:${completedAt}`);
          return [];
        },
        async recordBacktestRun(result, _options, dateFrom, dateTo) {
          calls.push(`record:${result.ticksReplayed}:${dateFrom}:${dateTo}`);
        },
        async writeStatus(status) {
          calls.push(`status:${status.status}:${status.ticksProcessed}:${status.shadowBankroll}`);
        }
      },
      engineState,
      logger: {
        warn(eventType, _message, metadata) {
          calls.push(`warn:${eventType}:${metadata?.replayId as string}`);
        }
      },
      captureReplaySnapshot() {
        calls.push("snapshot");
        return liveSnapshot;
      },
      prepareShadowReplayState(initialShadowBankroll, startedAt, replayId) {
        calls.push(`prepare:${initialShadowBankroll}:${startedAt.length}:${replayId.length}`);
      },
      async enqueueTick(currentTick, colo, options) {
        calls.push(`enqueue:${currentTick.price}:${String(colo)}:${String(options.shadowReplay)}`);
        return { accepted: true, reason: "ACCEPTED" };
      },
      async restoreReplaySnapshot(snapshot) {
        calls.push(`restore:${snapshot === liveSnapshot}`);
      }
    };

    const result = await runTradingHistoricalReplayForTarget(
      {
        limit: 5,
        shadowBankroll: 0,
        speedMultiplier: 1_000_000,
        dateFrom: "2026-05-01",
        dateTo: "2026-05-02",
        replayOptions: replayOptions()
      },
      target
    );

    expect(result.ticksReplayed).toBe(1);
    expect(calls.slice(0, 9)).toEqual([
      "status:RUNNING:0:0",
      "snapshot",
      "ticks:5:2026-05-01:2026-05-02",
      "status:RUNNING:0:5000",
      "trades:2026-05-01T00:00:00.000Z:2026-05-01T00:00:00.000Z",
      "prepare:5000:24:36",
      "enqueue:100:null:true",
      "status:RUNNING:1:5000",
      "restore:true"
    ]);
    expect(calls[9]?.startsWith("warn:REPLAY_COMPLETED:")).toBe(true);
    expect(calls[10]).toBe("record:1:2026-05-01:2026-05-02");
    expect(calls[11]).toBe("status:COMPLETED:1:5000");
  });
});

function replayOptions(overrides: Partial<ReplayOptions> = {}): ReplayOptions {
  return {
    scenario: "BASELINE",
    latencyMs: 10,
    slippageBps: 1,
    feeBps: 0,
    exitAfterTicks: 10,
    walkForward: false,
    sentimentAblation: true,
    strategyVersionId: "strategy-v1",
    actor: "test",
    ...overrides
  };
}

function shadowReplayWithRestoreInput(
  liveSnapshot: EngineReplaySnapshot
): ShadowReplayWithRestoreInput {
  return {
    replayId: "replay-runtime",
    ticks: [tick("2026-05-01T00:00:00.000Z", 100)],
    replayOptions: replayOptions(),
    speedMultiplier: 4,
    initialShadowBankroll: 300,
    dateFrom: "2026-05-01",
    dateTo: "2026-05-02",
    startedAt: STARTED_AT,
    liveSnapshot
  };
}

function replayResult(overrides: Partial<ReplayResult> = {}): ReplayResult {
  return {
    replayId: "replay-runtime",
    strategyVersionId: "strategy-v1",
    scenario: "BASELINE",
    ticksReplayed: 2,
    shadowBankroll: 300,
    theoreticalPnl: 0,
    baselinePnl: 0,
    actualTradeCount: 0,
    generatedIntentCount: 0,
    simulatedTradeCount: 0,
    speedMultiplier: 4,
    maxDrawdown: 0,
    sharpe: 0,
    winRate: 0,
    latencyModel: { type: "fixed", latencyMs: 10 },
    slippageModel: { type: "side-aware-bps", slippageBps: 1 },
    feeModel: { type: "round-trip-bps", feeBps: 0 },
    attribution: null,
    stressResults: [],
    walkForward: [],
    ablation: null,
    shadowTrades: [],
    startedAt: STARTED_AT,
    completedAt: UPDATED_AT,
    ...overrides
  };
}

function trade(
  overrides: Partial<ReplayResult["shadowTrades"][number]> = {}
): ReplayResult["shadowTrades"][number] {
  return {
    tradeId: "trade-1",
    instrumentCode: "btc-usd",
    side: "BUY",
    entryPrice: 100,
    exitPrice: 101,
    size: 1,
    theoreticalPnl: 1,
    fees: 0,
    slippageBps: 1,
    driver: "CROUPIER",
    regime: "RANGE",
    openedAt: STARTED_AT,
    closedAt: UPDATED_AT,
    ...overrides
  };
}

function tick(receivedAt: string, price: number): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceChannel: "trades",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    baseAsset: "BTC",
    quoteAsset: "USD",
    price,
    size: 0.5,
    side: "buy",
    sequence: price,
    providerTimestamp: receivedAt,
    exchangeTimestamp: receivedAt,
    synchronizedExchangeTimestamp: receivedAt,
    clockOffsetMs: 0,
    receivedAt,
    sourceWeight: 1,
    raw: {}
  };
}
