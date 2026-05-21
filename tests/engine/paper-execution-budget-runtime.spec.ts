import { describe, expect, it } from "vitest";
import {
  applyIntentPaperExecutionBudget,
  applyIntentPaperExecutionBudgetSideEffects,
  applyPaperExecutionBudget,
  reservePaperExecutionBudgetForTarget,
  type IntentPaperExecutionBudgetSideEffectHandlers,
  type TradingPaperExecutionBudgetTarget,
  resolvePaperMaxGhostFillsPerMinute
} from "../../src/engine/trading/execution/PaperExecutionBudgetRuntime";
import type { TradeIntent } from "../../src/types";

describe("PaperExecutionBudgetRuntime", () => {
  it("allows live mode without mutating shadow counters", () => {
    expect(
      applyPaperExecutionBudget({
        shadowMode: false,
        nowMs: 10_000,
        maxPerMinute: 1,
        windowStartedAtMs: 1_000,
        windowCount: 9,
        windowDropped: 2,
        throttleLoggedAtMs: 3_000
      })
    ).toEqual({
      allowed: true,
      shouldLogThrottle: false,
      state: {
        windowStartedAtMs: 1_000,
        windowCount: 9,
        windowDropped: 2,
        throttleLoggedAtMs: 3_000
      }
    });
  });

  it("resets expired windows and increments allowed dispatches", () => {
    expect(
      applyPaperExecutionBudget({
        shadowMode: true,
        nowMs: 61_000,
        maxPerMinute: 2,
        windowStartedAtMs: 0,
        windowCount: 2,
        windowDropped: 3,
        throttleLoggedAtMs: 0
      })
    ).toEqual({
      allowed: true,
      shouldLogThrottle: false,
      state: {
        windowStartedAtMs: 61_000,
        windowCount: 1,
        windowDropped: 0,
        throttleLoggedAtMs: 0
      }
    });
  });

  it("drops excess paper executions and throttles warning cadence", () => {
    expect(
      applyPaperExecutionBudget({
        shadowMode: true,
        nowMs: 5_000,
        maxPerMinute: 2,
        windowStartedAtMs: 0,
        windowCount: 2,
        windowDropped: 0,
        throttleLoggedAtMs: 0
      })
    ).toEqual({
      allowed: false,
      shouldLogThrottle: false,
      state: {
        windowStartedAtMs: 0,
        windowCount: 2,
        windowDropped: 1,
        throttleLoggedAtMs: 0
      }
    });

    expect(
      applyPaperExecutionBudget({
        shadowMode: true,
        nowMs: 10_000,
        maxPerMinute: 2,
        windowStartedAtMs: 0,
        windowCount: 2,
        windowDropped: 1,
        throttleLoggedAtMs: 0
      })
    ).toEqual({
      allowed: false,
      shouldLogThrottle: true,
      state: {
        windowStartedAtMs: 0,
        windowCount: 2,
        windowDropped: 2,
        throttleLoggedAtMs: 10_000
      }
    });
  });

  it("resolves paper execution cadence limits from env-compatible values", () => {
    expect(resolvePaperMaxGhostFillsPerMinute("4")).toBe(4);
    expect(resolvePaperMaxGhostFillsPerMinute("0")).toBe(1);
    expect(resolvePaperMaxGhostFillsPerMinute("50000")).toBe(10_000);
    expect(resolvePaperMaxGhostFillsPerMinute("bad")).toBe(90);
  });

  it("builds throttled intent metadata for engine logging and telemetry", () => {
    const result = applyIntentPaperExecutionBudget({
      intent: { intentId: "intent-1", instrumentCode: "btc-usd" },
      shadowMode: true,
      nowMs: 10_000,
      maxPerMinuteValue: "2",
      windowStartedAtMs: 0,
      windowCount: 2,
      windowDropped: 1,
      throttleLoggedAtMs: 0
    });

    expect(result).toMatchObject({
      allowed: false,
      shouldLogThrottle: true,
      maxPerMinute: 2,
      state: {
        windowStartedAtMs: 0,
        windowCount: 2,
        windowDropped: 2,
        throttleLoggedAtMs: 10_000
      },
      logMetadata: {
        intentId: "intent-1",
        instrumentCode: "btc-usd",
        maxGhostFillsPerMinute: 2,
        windowDispatched: 2,
        windowDropped: 2,
        windowStartedAt: "1970-01-01T00:00:00.000Z"
      },
      publishPayload: {
        instrumentCode: "btc-usd",
        maxGhostFillsPerMinute: 2,
        windowDispatched: 2,
        windowDropped: 2
      }
    });
  });

  it("applies budget state and emits throttle side effects", () => {
    const sideEffects = paperBudgetSideEffectSpy();

    const result = applyIntentPaperExecutionBudgetSideEffects(
      {
        intent: { intentId: "intent-1", instrumentCode: "btc-usd" },
        shadowMode: true,
        nowMs: 10_000,
        maxPerMinuteValue: "1",
        windowStartedAtMs: 0,
        windowCount: 1,
        windowDropped: 0,
        throttleLoggedAtMs: 0
      },
      sideEffects.handlers
    );

    expect(result.allowed).toBe(false);
    expect(sideEffects.events).toEqual(["state:1:1", "warn:intent-1", "publish:btc-usd"]);
  });

  it("reserves paper execution budget through the trading target adapter", () => {
    const calls: string[] = [];
    const now = Date.now();
    const target: TradingPaperExecutionBudgetTarget = {
      env: {
        SHADOW_MODE: "true",
        PAPER_MAX_GHOST_FILLS_PER_MINUTE: "1"
      },
      paperExecutionWindowStartedAtMs: now,
      paperExecutionWindowCount: 1,
      paperExecutionWindowDropped: 0,
      paperExecutionThrottleLoggedAtMs: 0,
      logger: {
        warn(eventType, _message, metadata) {
          calls.push(`warn:${eventType}:${metadata?.intentId as string}`);
        }
      },
      publish(type, payload) {
        calls.push(`publish:${type}:${payload.instrumentCode as string}`);
      }
    };

    const allowed = reservePaperExecutionBudgetForTarget(tradeIntent(), target);

    expect(allowed).toBe(false);
    expect(target.paperExecutionWindowCount).toBe(1);
    expect(target.paperExecutionWindowDropped).toBe(1);
    expect(calls).toEqual([
      "warn:SHADOW_PAPER_CADENCE_THROTTLED:intent-1",
      "publish:SHADOW_PAPER_CADENCE_THROTTLED:btc-usd"
    ]);
  });
});

function paperBudgetSideEffectSpy(): {
  events: string[];
  handlers: IntentPaperExecutionBudgetSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      applyState(state) {
        events.push(`state:${state.windowCount}:${state.windowDropped}`);
      },
      warnThrottle(metadata) {
        events.push(`warn:${String(metadata.intentId)}`);
      },
      publishThrottle(payload) {
        events.push(`publish:${String(payload.instrumentCode)}`);
      }
    }
  };
}

function tradeIntent(): TradeIntent {
  return {
    schemaVersion: "trade-intent.v1",
    intentId: "intent-1",
    traceId: "trace-intent-1",
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    source_exchange: "hyperliquid",
    direction: "LONG",
    executionStyle: "TAKER_IOC",
    action: "BUY",
    orderType: "IOC",
    postOnly: false,
    timeInForce: "IOC",
    intendedPrice: 100,
    expectedPrice: 100,
    requestedSize: 1,
    approvedSize: 1,
    probabilityWin: 1,
    probabilityLoss: 0,
    profit: 0,
    loss: 0,
    executionCosts: 0,
    adverseSelectionCost: 0,
    expectedValue: 0,
    minEvThreshold: 0,
    maxSlippageBps: 10,
    confidence: 1,
    rationale: "test",
    createdAt: "2026-05-19T12:00:00.000Z"
  };
}
