import { describe, expect, it } from "vitest";
import {
  buildCompletedReplayArtifacts,
  buildHistoricalReplayResult,
  buildReplayStatus,
  buildShadowReplayConfig,
  buildShadowReplayEngineState,
  calculateReplayShadowBankroll,
  recordCompletedReplaySideEffects,
  resolveInitialShadowBankroll
} from "../../src/engine/trading/replay/ReplayResultRuntime";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import type { ReplayOptions } from "../../src/engine/trading/routes/ReplayAdminRoutes";
import type { ReplayResult } from "../../src/types";

const STARTED_AT = "2026-05-18T10:00:00.000Z";
const COMPLETED_AT = "2026-05-18T10:05:00.000Z";

describe("ReplayResultRuntime", () => {
  it("assembles replay result metrics and completion log metadata", () => {
    const output = buildHistoricalReplayResult({
      replayId: "replay-1",
      replayOptions: options({ walkForward: true }),
      ticksReplayed: 42,
      initialShadowBankroll: 300,
      historicalTradeCount: 1,
      generatedIntentCount: 2,
      speedMultiplier: 5,
      modeledTrades: [
        trade({ tradeId: "sim-1", theoreticalPnl: 3, driver: "CROUPIER" }),
        trade({ tradeId: "sim-2", theoreticalPnl: -1, instrumentCode: "hype-usd" })
      ],
      shadowTrades: [trade({ tradeId: "hist-1", theoreticalPnl: 0.5 })],
      sentiment: defaultEngineState("replay-result").sentiment,
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT
    });

    expect(output.result).toMatchObject({
      replayId: "replay-1",
      strategyVersionId: "strategy-v1",
      scenario: "BASELINE",
      ticksReplayed: 42,
      shadowBankroll: 302,
      theoreticalPnl: 2,
      baselinePnl: 0.5,
      actualTradeCount: 1,
      generatedIntentCount: 2,
      simulatedTradeCount: 2,
      speedMultiplier: 5,
      latencyModel: { type: "fixed", latencyMs: 10 },
      slippageModel: { type: "side-aware-bps", slippageBps: 1 },
      feeModel: { type: "round-trip-bps", feeBps: 0 },
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT
    });
    expect(output.result.attribution?.byAgent[0]).toMatchObject({
      key: "CROUPIER",
      tradeCount: 1,
      pnl: 3
    });
    expect(output.result.walkForward).toHaveLength(2);
    expect(output.logMetadata).toMatchObject({
      replayId: "replay-1",
      ticksReplayed: 42,
      actualTradeCount: 1,
      generatedIntentCount: 2,
      theoreticalPnl: 2,
      baselinePnl: 0.5,
      simulatedTradeCount: 2,
      scenario: "BASELINE",
      speedMultiplier: 5,
      liveStateRestored: true
    });
  });

  it("uses scenario-specific stress summaries outside baseline", () => {
    const output = buildHistoricalReplayResult({
      replayId: "replay-2",
      replayOptions: options({ scenario: "LATENCY_SHOCK", sentimentAblation: false }),
      ticksReplayed: 10,
      initialShadowBankroll: 300,
      historicalTradeCount: 0,
      generatedIntentCount: 1,
      speedMultiplier: 1,
      modeledTrades: [trade({ theoreticalPnl: 1.25 })],
      shadowTrades: [],
      sentiment: defaultEngineState("replay-result").sentiment,
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT
    });

    expect(output.result.stressResults).toEqual([
      {
        scenario: "LATENCY_SHOCK",
        pnl: 1.25,
        maxDrawdown: 0,
        generatedIntentCount: 1,
        simulatedTradeCount: 1
      }
    ]);
    expect(output.result.latencyModel).toMatchObject({ type: "fixed-plus-shock" });
    expect(output.result.ablation).toBeNull();
  });

  it("builds completed replay artifacts with final status", () => {
    const artifacts = buildCompletedReplayArtifacts({
      replayId: "replay-complete",
      replayOptions: options({ scenario: "FLASH_CRASH" }),
      ticksLength: 80,
      ticksReplayed: 75,
      initialShadowBankroll: 300,
      historicalTradeCount: 2,
      generatedIntentCount: 3,
      speedMultiplier: 4,
      modeledTrades: [trade({ theoreticalPnl: 2 })],
      shadowTrades: [trade({ theoreticalPnl: -1 })],
      sentiment: defaultEngineState("replay-result").sentiment,
      dateFrom: "2026-05-01T00:00:00.000Z",
      dateTo: "2026-05-02T00:00:00.000Z",
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT
    });

    expect(artifacts.result).toMatchObject({
      replayId: "replay-complete",
      scenario: "FLASH_CRASH",
      ticksReplayed: 75,
      shadowBankroll: 302,
      theoreticalPnl: 2,
      baselinePnl: -1
    });
    expect(artifacts.status).toMatchObject({
      replayId: "replay-complete",
      status: "COMPLETED",
      ticksTotal: 80,
      ticksProcessed: 80,
      progressPct: 100,
      shadowBankroll: 302,
      dateFrom: "2026-05-01T00:00:00.000Z",
      dateTo: "2026-05-02T00:00:00.000Z",
      scenario: "FLASH_CRASH",
      startedAt: STARTED_AT,
      updatedAt: COMPLETED_AT,
      completedAt: COMPLETED_AT
    });
    expect(artifacts.logMetadata).toMatchObject({
      replayId: "replay-complete",
      liveStateRestored: true
    });
  });

  it("records completed replay side effects through injected journal handlers", async () => {
    const calls: string[] = [];
    const statuses: unknown[] = [];
    const recordedRuns: unknown[] = [];

    const result = await recordCompletedReplaySideEffects(
      {
        replayId: "replay-side-effects",
        replayOptions: options({ scenario: "DELEVERAGING_2022" }),
        ticksLength: 120,
        ticksReplayed: 110,
        initialShadowBankroll: 300,
        historicalTradeCount: 4,
        generatedIntentCount: 5,
        speedMultiplier: 8,
        modeledTrades: [trade({ tradeId: "sim-side-effect", theoreticalPnl: 7 })],
        shadowTrades: [trade({ tradeId: "hist-side-effect", theoreticalPnl: 2 })],
        sentiment: defaultEngineState("replay-result").sentiment,
        dateFrom: "2026-05-01T00:00:00.000Z",
        dateTo: "2026-05-03T00:00:00.000Z",
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT
      },
      {
        writeCompletionLog: (metadata) => {
          calls.push(`log:${String(metadata.replayId)}`);
        },
        recordBacktestRun: async (run, replayOptions, dateFrom, dateTo) => {
          calls.push(`record:${run.replayId}`);
          recordedRuns.push({ run, replayOptions, dateFrom, dateTo });
        },
        writeStatus: async (status) => {
          calls.push(`status:${status.status}`);
          statuses.push(status);
        }
      }
    );

    expect(result).toMatchObject({
      replayId: "replay-side-effects",
      scenario: "DELEVERAGING_2022",
      shadowBankroll: 307,
      theoreticalPnl: 7,
      baselinePnl: 2
    });
    expect(calls).toEqual([
      "log:replay-side-effects",
      "record:replay-side-effects",
      "status:COMPLETED"
    ]);
    expect(recordedRuns[0]).toMatchObject({
      replayOptions: { scenario: "DELEVERAGING_2022" },
      dateFrom: "2026-05-01T00:00:00.000Z",
      dateTo: "2026-05-03T00:00:00.000Z"
    });
    expect(statuses[0]).toMatchObject({
      replayId: "replay-side-effects",
      status: "COMPLETED",
      progressPct: 100
    });
  });

  it("resolves and bootstraps isolated paper replay state", () => {
    const liveState = defaultEngineState("engine-live");
    const initialShadowBankroll = resolveInitialShadowBankroll({
      requestedShadowBankroll: 0,
      liveEquity: 250,
      liveCash: 310,
      fallbackBankroll: 300
    });
    const cachedConfig = buildShadowReplayConfig({
      currentConfig: liveState.cachedConfig,
      initialShadowBankroll,
      defaultMaxPositionPct: 0.05,
      defaultMaxInventoryUnits: 1,
      startedAt: STARTED_AT,
      replayId: "replay-1"
    });

    const shadowState = buildShadowReplayEngineState({
      liveState,
      cachedConfig,
      initialShadowBankroll,
      startedAt: STARTED_AT,
      replayId: "replay-1"
    });

    expect(initialShadowBankroll).toBe(310);
    expect(cachedConfig).toMatchObject({
      TRADING_ENABLED: true,
      MAX_POSITION_SIZE: 310,
      MAX_POSITION_PCT: 0.05,
      MAX_INVENTORY_UNITS: 1,
      updatedBy: "shadow-replay",
      updatedAt: STARTED_AT
    });
    expect(cachedConfig.version).toContain(":shadow-replay:replay-1");
    expect(shadowState).toMatchObject({
      engineId: "engine-live:shadow:replay-1",
      mode: "PAPER",
      cachedConfig,
      heartbeatAt: STARTED_AT,
      updatedAt: STARTED_AT,
      bankroll: {
        cash: 310,
        equity: 310,
        realizedPnl: 0,
        updatedAt: STARTED_AT
      }
    });
  });

  it("builds replay progress statuses and shadow bankroll marks", () => {
    const modeledTrades: ReplayResult["shadowTrades"] = [
      trade({ theoreticalPnl: 4 }),
      trade({ theoreticalPnl: -1.5 })
    ];

    expect(calculateReplayShadowBankroll(300, modeledTrades)).toBe(302.5);
    expect(
      buildReplayStatus({
        replayId: "replay-2",
        status: "RUNNING",
        ticksTotal: 80,
        ticksProcessed: 20,
        speedMultiplier: 4,
        shadowBankroll: 302.5,
        dateFrom: null,
        dateTo: null,
        scenario: "BASELINE",
        startedAt: STARTED_AT,
        updatedAt: COMPLETED_AT
      })
    ).toMatchObject({
      replayId: "replay-2",
      status: "RUNNING",
      progressPct: 25,
      shadowBankroll: 302.5,
      error: null,
      completedAt: null
    });
  });
});

function options(overrides: Partial<ReplayOptions> = {}): ReplayOptions {
  return {
    scenario: "BASELINE",
    latencyMs: 10,
    slippageBps: 1,
    feeBps: 0,
    exitAfterTicks: 10,
    walkForward: false,
    sentimentAblation: true,
    strategyVersionId: "strategy-v1",
    actor: "admin",
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
    driver: "PROFILER",
    regime: "RANGE",
    openedAt: STARTED_AT,
    closedAt: COMPLETED_AT,
    ...overrides
  };
}
