import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import { neutralMacroBias } from "../../src/Governor";
import {
  adminRecoveryCompletionArtifacts,
  adminRecoveryPlan,
  adminRecoveryRuntimeArtifacts,
  adminRecoveryResponse,
  adminRecoveryStorageEntries,
  applyAdminRecoveryCompletionSideEffects,
  applyAdminRecoveryFlow,
  applyAdminRecoveryPlanSideEffects,
  applyTradingAdminRecoveryFlow,
  dispatchAdminRecoveryOrderBookResets,
  resolveAdminRecoveryPaperBankroll,
  stateAfterAdminControlledRecovery
} from "../../src/engine/trading/state/RecoveryRuntime";
import {
  defaultEngineState,
  defaultInventoryState
} from "../../src/engine/trading/state/EngineStateDefaults";
import type { EngineState } from "../../src/types";

const OBSERVED_AT = "2026-05-18T19:00:00.000Z";

describe("RecoveryRuntime", () => {
  it("normalizes admin recovery requests into an executable plan", () => {
    expect(
      adminRecoveryPlan(
        {
          reason: "manual-check",
          instrumentCode: "BTC-PERP",
          source_exchange: "HYPERLIQUID",
          clearLatency: false,
          clearShadowQueue: false,
          resetPaperPortfolio: true
        },
        OBSERVED_AT
      )
    ).toEqual({
      observedAt: OBSERVED_AT,
      reason: "manual-check",
      sourceExchange: "hyperliquid",
      resetInstruments: ["btc-perp"],
      shouldClearLatency: false,
      shouldClearShadowQueue: false,
      shouldResetPaperPortfolio: true
    });
  });

  it("defaults blank admin recovery requests to safe broad recovery", () => {
    expect(adminRecoveryPlan({}, OBSERVED_AT)).toMatchObject({
      observedAt: OBSERVED_AT,
      reason: "ADMIN_CONTROLLED_RECOVERY",
      sourceExchange: "hyperliquid",
      shouldClearLatency: true,
      shouldClearShadowQueue: true,
      shouldResetPaperPortfolio: false
    });
  });

  it("resolves the admin recovery paper bankroll from environment input", () => {
    expect(resolveAdminRecoveryPaperBankroll("450")).toBe(450);
    expect(resolveAdminRecoveryPaperBankroll("0")).toBe(5_000);
  });

  it("dispatches admin recovery order-book resets for each requested instrument", async () => {
    const payloads: unknown[] = [];

    await dispatchAdminRecoveryOrderBookResets({
      resetInstruments: ["btc-usd", "hype-usd"],
      reason: "manual-reset",
      sourceExchange: "hyperliquid",
      observedAt: OBSERVED_AT,
      async resetOrderBook(payload) {
        payloads.push(payload);
      }
    });

    expect(payloads).toEqual([
      {
        source: "ADMIN",
        reason: "manual-reset",
        instrumentCode: "btc-usd",
        source_exchange: "hyperliquid",
        connectionId: null,
        blackoutDurationMs: null,
        recoveredAt: OBSERVED_AT
      },
      {
        source: "ADMIN",
        reason: "manual-reset",
        instrumentCode: "hype-usd",
        source_exchange: "hyperliquid",
        connectionId: null,
        blackoutDurationMs: null,
        recoveredAt: OBSERVED_AT
      }
    ]);
  });

  it("applies admin recovery plan side effects in plan order", async () => {
    const calls: string[] = [];

    await applyAdminRecoveryPlanSideEffects(
      {
        observedAt: OBSERVED_AT,
        reason: "manual-reset",
        sourceExchange: "hyperliquid",
        resetInstruments: ["btc-usd"],
        shouldClearLatency: true,
        shouldClearShadowQueue: true,
        shouldResetPaperPortfolio: false
      },
      {
        resetOrderBook: async (payload) => {
          expect(payload.instrumentCode).toBeDefined();
          calls.push(`reset:${payload.instrumentCode ?? "missing"}`);
        },
        resetLatencyBaseline: (observedAt, reason) => {
          calls.push(`latency:${reason}:${observedAt}`);
        },
        clearShadowQueue: () => calls.push("shadow-queue")
      }
    );

    expect(calls).toEqual(["reset:btc-usd", `latency:manual-reset:${OBSERVED_AT}`, "shadow-queue"]);
  });

  it("resets paper portfolio, quote state, citadel, and risk gates for admin recovery", () => {
    const currentState = defaultEngineState("recovery-runtime");
    currentState.bankroll = {
      currency: "USD",
      cash: 200,
      equity: 175,
      realizedPnl: -25,
      updatedAt: "2026-05-18T18:00:00.000Z"
    };
    currentState.openPositions = {
      "btc-usd": position("btc-usd")
    };
    currentState.inventory = {
      ...defaultInventoryState(10, 5),
      current_inventory_delta: 2,
      updatedAt: "2026-05-18T18:00:00.000Z"
    };
    currentState.riskMetrics = {
      ...currentState.riskMetrics,
      rollingDrawdownPct: 0.25
    };

    const result = stateAfterAdminControlledRecovery({
      currentState,
      payload: { resetPaperPortfolio: true },
      cachedConfig: {
        ...defaultConfig,
        TRADING_ENABLED: true,
        MAX_DRAWDOWN_PCT: 0.05,
        MAX_INVENTORY_UNITS: 12,
        MAX_INVENTORY_DELTA: 6
      },
      macroBias: neutralMacroBias(),
      observedAt: OBSERVED_AT,
      shadowMode: true,
      paperBankroll: 300,
      shadowQueue: currentState.shadowQueue,
      reason: "manual-reset",
      resetInstruments: ["btc-usd"],
      sourceExchange: "hyperliquid",
      prunedProfilerStorageKeys: ["agent:profiler:old"]
    });

    expect(result.shouldClearShadowQueue).toBe(true);
    expect(result.state).toMatchObject({
      bankroll: {
        cash: 300,
        equity: 300,
        realizedPnl: 0,
        updatedAt: OBSERVED_AT
      },
      openPositions: {},
      inventory: {
        maxInventoryUnits: 12,
        maxInventoryDelta: 6,
        current_inventory_delta: 0,
        updatedAt: OBSERVED_AT
      },
      current_inventory_delta: 0,
      staleTickCount: 0,
      citadel: {
        shadowMode: true,
        updatedAt: OBSERVED_AT
      },
      riskMetrics: {
        isTradingEnabled: true,
        highWaterMark: 300,
        updatedAt: OBSERVED_AT
      },
      risk: {
        killSwitch: false,
        maxDrawdownPct: 0.05,
        updatedAt: OBSERVED_AT
      },
      executionProfile: {
        status: "STABLE",
        updatedAt: OBSERVED_AT
      },
      heartbeatAt: OBSERVED_AT,
      updatedAt: OBSERVED_AT
    });
    expect(result.logMetadata).toMatchObject({
      reason: "manual-reset",
      resetInstruments: ["btc-usd"],
      clearShadowQueue: true,
      resetPaperPortfolio: true,
      prunedProfilerStorageKeys: ["agent:profiler:old"]
    });
    expect(result.publishPayload).toMatchObject({
      prunedProfilerStorageKeyCount: 1,
      tradingEnabled: true
    });
  });

  it("preserves optional state when recovery clear flags are disabled", () => {
    const currentState = defaultEngineState("recovery-runtime");
    currentState.riskMetrics = {
      ...currentState.riskMetrics,
      rollingDrawdownPct: 0.5
    };
    const previousQuoteState = currentState.quoteState;
    const previousAssetQuoteStates = currentState.assetQuoteStates;
    const previousCitadel = currentState.citadel;

    const result = stateAfterAdminControlledRecovery({
      currentState,
      payload: {
        clearQuoteState: false,
        clearCitadel: false,
        clearLatency: false,
        clearShadowQueue: false
      },
      cachedConfig: {
        ...defaultConfig,
        TRADING_ENABLED: true,
        MAX_DRAWDOWN_PCT: 0.05
      },
      macroBias: neutralMacroBias(),
      observedAt: OBSERVED_AT,
      shadowMode: false,
      paperBankroll: 300,
      shadowQueue: currentState.shadowQueue,
      reason: "recover-with-preserve",
      resetInstruments: [],
      sourceExchange: "hyperliquid",
      prunedProfilerStorageKeys: []
    });

    expect(result.shouldClearShadowQueue).toBe(false);
    expect(result.state.quoteState).toBe(previousQuoteState);
    expect(result.state.assetQuoteStates).toBe(previousAssetQuoteStates);
    expect(result.state.citadel).toBe(previousCitadel);
    expect(result.state.risk.killSwitch).toBe(true);
    expect(result.state.riskMetrics.isTradingEnabled).toBe(false);
    expect(result.publishPayload).toMatchObject({
      clearQuoteState: false,
      clearCitadel: false,
      clearLatency: false,
      clearShadowQueue: false
    });
  });

  it("builds recovery storage writes and response payloads", () => {
    const state = defaultEngineState("recovery-storage");
    const latencyHistory = [{ totalLatencyMs: 4 }];
    const processingLatencySamples = [1, 2, 3];

    expect(
      adminRecoveryStorageEntries({
        engineStateKey: "engine:state",
        state,
        performanceHistoryKey: "latency:history",
        latencyHistory,
        processingLatencySamplesKey: "latency:samples",
        processingLatencySamples
      })
    ).toEqual({
      "engine:state": state,
      "latency:history": latencyHistory,
      "latency:samples": processingLatencySamples
    });
    expect(
      adminRecoveryResponse({
        reason: "manual",
        resetInstruments: ["btc-usd"],
        sourceExchange: "hyperliquid",
        state
      })
    ).toMatchObject({
      ok: true,
      reason: "manual",
      resetInstruments: ["btc-usd"],
      source_exchange: "hyperliquid",
      state
    });
  });

  it("assembles recovery completion artifacts for the durable object", () => {
    const state = defaultEngineState("recovery-artifacts");
    const recovery = stateAfterAdminControlledRecovery({
      currentState: state,
      payload: { resetPaperPortfolio: true },
      cachedConfig: defaultConfig,
      macroBias: neutralMacroBias(),
      observedAt: OBSERVED_AT,
      shadowMode: true,
      paperBankroll: 300,
      shadowQueue: state.shadowQueue,
      reason: "manual-reset",
      resetInstruments: ["btc-usd"],
      sourceExchange: "hyperliquid",
      prunedProfilerStorageKeys: []
    });
    const artifacts = adminRecoveryCompletionArtifacts({
      plan: adminRecoveryPlan(
        { resetPaperPortfolio: true, instrumentCode: "btc-usd" },
        OBSERVED_AT
      ),
      recovery,
      engineStateKey: "engine:state",
      performanceHistoryKey: "latency:history",
      latencyHistory: [],
      processingLatencySamplesKey: "latency:samples",
      processingLatencySamples: [1, 2]
    });

    expect(artifacts.storageEntries).toMatchObject({
      "engine:state": recovery.state,
      "latency:history": [],
      "latency:samples": [1, 2]
    });
    expect(artifacts.paperSessionStartedAt).toBe(OBSERVED_AT);
    expect(artifacts.logMetadata).toBe(recovery.logMetadata);
    expect(artifacts.publishPayload).toBe(recovery.publishPayload);
    expect(artifacts.response).toMatchObject({
      ok: true,
      reason: "ADMIN_CONTROLLED_RECOVERY",
      resetInstruments: ["btc-usd"],
      source_exchange: "hyperliquid",
      state: recovery.state
    });
  });

  it("assembles full recovery runtime artifacts from state inputs and storage keys", () => {
    const state = defaultEngineState("recovery-runtime-artifacts");
    const plan = adminRecoveryPlan(
      { resetPaperPortfolio: true, instrumentCode: "btc-usd" },
      OBSERVED_AT
    );
    const artifacts = adminRecoveryRuntimeArtifacts({
      plan,
      currentState: state,
      payload: { resetPaperPortfolio: true, instrumentCode: "btc-usd" },
      cachedConfig: defaultConfig,
      macroBias: neutralMacroBias(),
      shadowMode: true,
      paperBankroll: 450,
      shadowQueue: state.shadowQueue,
      prunedProfilerStorageKeys: ["old-profiler"],
      engineStateKey: "engine:state",
      performanceHistoryKey: "latency:history",
      latencyHistory: [{ totalLatencyMs: 4 }],
      processingLatencySamplesKey: "latency:samples",
      processingLatencySamples: [1, 2]
    });

    expect(artifacts.recovery.state.bankroll.equity).toBe(450);
    expect(artifacts.completion.storageEntries).toMatchObject({
      "engine:state": artifacts.recovery.state,
      "latency:history": [{ totalLatencyMs: 4 }],
      "latency:samples": [1, 2]
    });
    expect(artifacts.completion.paperSessionStartedAt).toBe(OBSERVED_AT);
    expect(artifacts.completion.publishPayload).toMatchObject({
      prunedProfilerStorageKeyCount: 1,
      resetPaperPortfolio: true
    });
  });

  it("applies admin recovery completion side effects", async () => {
    const state = defaultEngineState("recovery-side-effects");
    const completion = adminRecoveryCompletionArtifacts({
      plan: adminRecoveryPlan(
        { resetPaperPortfolio: true, instrumentCode: "btc-usd" },
        OBSERVED_AT
      ),
      recovery: stateAfterAdminControlledRecovery({
        currentState: state,
        payload: { resetPaperPortfolio: true },
        cachedConfig: defaultConfig,
        macroBias: neutralMacroBias(),
        observedAt: OBSERVED_AT,
        shadowMode: true,
        paperBankroll: 300,
        shadowQueue: state.shadowQueue,
        reason: "manual-reset",
        resetInstruments: ["btc-usd"],
        sourceExchange: "hyperliquid",
        prunedProfilerStorageKeys: []
      }),
      engineStateKey: "engine:state",
      performanceHistoryKey: "latency:history",
      latencyHistory: [],
      processingLatencySamplesKey: "latency:samples",
      processingLatencySamples: [1]
    });
    const calls: string[] = [];

    await applyAdminRecoveryCompletionSideEffects(completion, {
      async persistStorageEntries(entries) {
        calls.push(`persist:${Object.keys(entries).join(",")}`);
      },
      putPaperSessionStartedAt(observedAt) {
        calls.push(`paper-session:${observedAt}`);
      },
      logRecovery(metadata) {
        calls.push(`log:${metadata.reason as string}`);
      },
      publishRecovery(payload) {
        calls.push(`publish:${payload.reason as string}`);
      }
    });

    expect(calls).toEqual([
      "persist:engine:state,latency:history,latency:samples",
      `paper-session:${OBSERVED_AT}`,
      "log:manual-reset",
      "publish:manual-reset"
    ]);
  });

  it("orchestrates the full admin recovery flow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(OBSERVED_AT));
    const state = defaultEngineState("recovery-flow");
    const calls: string[] = [];

    try {
      const response = await applyAdminRecoveryFlow(
        {
          currentState: state,
          payload: {
            instrumentCode: "btc-usd",
            resetPaperPortfolio: true
          },
          cachedConfig: defaultConfig,
          macroBias: neutralMacroBias(),
          shadowMode: true,
          paperBankroll: 500,
          engineStateKey: "engine:state",
          performanceHistoryKey: "latency:history",
          latencyHistory: [{ totalLatencyMs: 4 }],
          processingLatencySamplesKey: "latency:samples",
          processingLatencySamples: [1, 2]
        },
        {
          async resetOrderBook(payload) {
            calls.push(`reset-book:${payload.instrumentCode}:${payload.reason}`);
          },
          resetLatencyBaseline(observedAt, reason) {
            calls.push(`latency:${observedAt}:${reason}`);
          },
          clearShadowQueue() {
            calls.push("shadow-clear");
          },
          async deleteRetiredProfilerStorage() {
            calls.push("prune-profilers");
            return ["old-profiler"];
          },
          shadowQueueSnapshot(observedAt) {
            calls.push(`shadow-snapshot:${observedAt}`);
            return state.shadowQueue;
          },
          applyState(nextState) {
            calls.push(`state:${nextState.bankroll.equity}`);
          },
          async persistStorageEntries(entries) {
            calls.push(`persist:${Object.keys(entries).join(",")}`);
          },
          putPaperSessionStartedAt(observedAt) {
            calls.push(`paper-session:${observedAt}`);
          },
          logRecovery(metadata) {
            calls.push(`log:${metadata.prunedProfilerStorageKeys as string[]}`);
          },
          publishRecovery(payload) {
            calls.push(`publish:${String(payload.prunedProfilerStorageKeyCount)}`);
          }
        }
      );

      expect(response).toMatchObject({
        ok: true,
        resetInstruments: ["btc-usd"],
        source_exchange: "hyperliquid"
      });
      expect(calls).toEqual([
        "reset-book:btc-usd:ADMIN_CONTROLLED_RECOVERY",
        `latency:${OBSERVED_AT}:ADMIN_CONTROLLED_RECOVERY`,
        "shadow-clear",
        "prune-profilers",
        `shadow-snapshot:${OBSERVED_AT}`,
        "state:500",
        "persist:engine:state,latency:history,latency:samples",
        `paper-session:${OBSERVED_AT}`,
        "log:old-profiler",
        "publish:1"
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps admin recovery with trading storage keys and paper-bankroll defaults", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(OBSERVED_AT));
    const state = defaultEngineState("trading-recovery-flow");
    const calls: string[] = [];

    try {
      const response = await applyTradingAdminRecoveryFlow(
        {
          currentState: state,
          payload: {
            instrumentCode: "hype-usd",
            resetPaperPortfolio: true
          },
          cachedConfig: defaultConfig,
          macroBias: neutralMacroBias(),
          shadowMode: true,
          paperBankrollUsd: "750",
          latencyHistory: [{ totalLatencyMs: 12 }],
          processingLatencySamples: [3, 4]
        },
        {
          async resetOrderBook(payload) {
            calls.push(`reset-book:${payload.instrumentCode}:${payload.reason}`);
          },
          resetLatencyBaseline(observedAt, reason) {
            calls.push(`latency:${observedAt}:${reason}`);
          },
          clearShadowQueue() {
            calls.push("shadow-clear");
          },
          async deleteRetiredProfilerStorage() {
            return [];
          },
          shadowQueueSnapshot() {
            return state.shadowQueue;
          },
          applyState(nextState) {
            calls.push(`state:${nextState.bankroll.equity}`);
          },
          async persistStorageEntries(entries) {
            calls.push(`persist:${Object.keys(entries).join(",")}`);
          },
          putPaperSessionStartedAt(observedAt) {
            calls.push(`paper-session:${observedAt}`);
          },
          logRecovery(metadata) {
            calls.push(`log:${metadata.reason as string}`);
          },
          publishRecovery(payload) {
            calls.push(`publish:${payload.reason as string}`);
          }
        }
      );

      expect(response).toMatchObject({
        ok: true,
        resetInstruments: ["hype-usd"],
        source_exchange: "hyperliquid"
      });
      expect(calls).toEqual([
        "reset-book:hype-usd:ADMIN_CONTROLLED_RECOVERY",
        `latency:${OBSERVED_AT}:ADMIN_CONTROLLED_RECOVERY`,
        "shadow-clear",
        "state:750",
        "persist:engine:state,performance:latency-history,performance:processing-latency-samples",
        `paper-session:${OBSERVED_AT}`,
        "log:ADMIN_CONTROLLED_RECOVERY",
        "publish:ADMIN_CONTROLLED_RECOVERY"
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

function position(instrumentCode: string): EngineState["openPositions"][string] {
  return {
    instrumentCode,
    side: "LONG",
    quantity: 1,
    averageEntryPrice: 100,
    markPrice: 100,
    unrealizedPnl: 0,
    realizedPnl: 0,
    updatedAt: OBSERVED_AT
  };
}
