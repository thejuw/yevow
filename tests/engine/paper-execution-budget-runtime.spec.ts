import { describe, expect, it } from "vitest";
import {
  applyIntentPaperExecutionBudget,
  applyPaperExecutionBudget,
  resolvePaperMaxGhostFillsPerMinute
} from "../../src/engine/trading/execution/PaperExecutionBudgetRuntime";

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
});
