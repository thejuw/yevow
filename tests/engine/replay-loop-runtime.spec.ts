import { describe, expect, it } from "vitest";
import { runShadowReplayLoop } from "../../src/engine/trading/replay/ReplayLoopRuntime";
import type {
  ReplayOptions,
  ReplayStatus
} from "../../src/engine/trading/routes/ReplayAdminRoutes";
import type { MarketTick, TradeIntent } from "../../src/types";

describe("ReplayLoopRuntime", () => {
  it("replays ticks, records modeled trades, and writes running status", async () => {
    const statuses: ReplayStatus[] = [];
    let latestIntent: TradeIntent | null = null;
    const ticks = [tick("2026-01-01T00:00:00.000Z", 100), tick("2026-01-01T00:00:00.000Z", 101)];

    const result = await runShadowReplayLoop({
      replayId: "replay-1",
      ticks,
      replayOptions: replayOptions(),
      speedMultiplier: 1,
      initialShadowBankroll: 300,
      dateFrom: null,
      dateTo: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      enqueueShadowReplayTick: async () => {
        latestIntent ??= tradeIntent("intent-1", "BUY", 100, 0.5);
        return { accepted: true, status: "FRESH", processedCount: 1 };
      },
      lastTradeIntent: () => latestIntent,
      oracleRegime: () => "RISK_ON",
      writeStatus: async (status) => {
        statuses.push(status);
      },
      now: () => "2026-01-01T00:00:01.000Z"
    });

    expect(result).toMatchObject({
      ticksReplayed: 2,
      generatedIntentCount: 1
    });
    expect(result.modeledTrades).toHaveLength(1);
    expect(result.modeledTrades[0]).toMatchObject({
      tradeId: "replay:intent-1",
      side: "BUY",
      entryPrice: 100.0505,
      exitPrice: 101,
      size: 0.5,
      regime: "RISK_ON"
    });
    expect(statuses.map((status) => status.status)).toEqual(["RUNNING", "RUNNING"]);
    expect(statuses.at(-1)).toMatchObject({
      replayId: "replay-1",
      ticksTotal: 2,
      ticksProcessed: 2,
      progressPct: 100,
      shadowBankroll: result.modeledTrades[0].theoreticalPnl + 300
    });
  });

  it("writes failed status with processed tick count before rethrowing", async () => {
    const statuses: ReplayStatus[] = [];
    await expect(
      runShadowReplayLoop({
        replayId: "replay-fail",
        ticks: [tick("2026-01-01T00:00:00.000Z", 100), tick("2026-01-01T00:00:00.000Z", 101)],
        replayOptions: replayOptions(),
        speedMultiplier: 1,
        initialShadowBankroll: 300,
        dateFrom: "2026-01-01T00:00:00.000Z",
        dateTo: "2026-01-02T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        enqueueShadowReplayTick: async (currentTick) => {
          if (currentTick.price === 101) {
            throw new Error("tick_failed");
          }
          return { accepted: true, status: "FRESH", processedCount: 1 };
        },
        lastTradeIntent: () => null,
        oracleRegime: () => "UNKNOWN",
        writeStatus: async (status) => {
          statuses.push(status);
        },
        now: () => "2026-01-01T00:00:02.000Z"
      })
    ).rejects.toThrow("tick_failed");

    expect(statuses.at(-1)).toMatchObject({
      replayId: "replay-fail",
      status: "FAILED",
      ticksTotal: 2,
      ticksProcessed: 1,
      shadowBankroll: 300,
      dateFrom: "2026-01-01T00:00:00.000Z",
      dateTo: "2026-01-02T00:00:00.000Z",
      error: "tick_failed",
      completedAt: "2026-01-01T00:00:02.000Z"
    });
  });
});

function replayOptions(overrides: Partial<ReplayOptions> = {}): ReplayOptions {
  return {
    scenario: "BASELINE",
    latencyMs: 10,
    slippageBps: 5,
    feeBps: 1,
    exitAfterTicks: 1,
    walkForward: false,
    sentimentAblation: false,
    strategyVersionId: null,
    actor: "test",
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

function tradeIntent(
  intentId: string,
  action: TradeIntent["action"],
  expectedPrice: number,
  requestedSize: number
): TradeIntent {
  return {
    intentId,
    strategyId: "replay-test",
    instrumentCode: "btc-usd",
    action,
    requestedSize,
    approvedSize: requestedSize,
    expectedPrice,
    limitPrice: expectedPrice,
    confidence: 0.8,
    expectedValue: 1,
    reason: "replay test",
    rationale: "Croupier replay test",
    sourceAgent: "Croupier",
    timestamp: "2026-01-01T00:00:00.000Z",
    risk: {
      maxLoss: 1,
      positionAfterTrade: requestedSize,
      drawdownAfterTrade: 0
    }
  } as TradeIntent;
}
