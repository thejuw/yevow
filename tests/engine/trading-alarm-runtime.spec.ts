import { describe, expect, it, vi } from "vitest";
import {
  runTradingAlarmForTarget,
  type TradingAlarmRuntimeTarget
} from "../../src/engine/trading/alarm/TradingAlarmRuntime";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";

describe("TradingAlarmRuntime", () => {
  it("runs alarm maintenance through the trading target adapter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T16:00:00.000Z"));

    try {
      const events: string[] = [];
      const state = defaultEngineState("alarm-target");
      state.quoteState = {
        ...state.quoteState,
        status: "SUSPENDED",
        reason: "HARD_STALE_DROP",
        suspendedUntil: "2026-05-18T15:59:59.000Z"
      };
      state.assetQuoteStates = {
        "btc-usd": {
          ...state.quoteState
        }
      };
      const target: TradingAlarmRuntimeTarget = {
        initialized: Promise.resolve(),
        engineState: state,
        refreshConfig(source) {
          events.push(`config:${source}`);
          return Promise.resolve();
        },
        drainExecutionQueue() {
          events.push("queue");
          return Promise.resolve();
        },
        runJanitor(source) {
          events.push(`janitor:${source}`);
          return Promise.resolve();
        },
        scheduleConfigRefresh() {
          events.push("schedule");
          return Promise.resolve();
        },
        publish(type, payload) {
          events.push(`publish:${type}:${payload.observedAt as string}`);
        }
      };

      await runTradingAlarmForTarget(target);

      expect(target.engineState.quoteState.status).toBe("ACTIVE");
      expect(events).toEqual([
        "config:ALARM",
        "queue",
        "janitor:ALARM",
        "publish:RESUME_QUOTES:2026-05-18T16:00:00.000Z",
        "schedule"
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
