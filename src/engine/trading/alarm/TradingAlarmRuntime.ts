import type { EngineState } from "../../../types";
import { resumeTradingQuotesIfExpired } from "../quotes/TradingQuoteStateRuntime";

export interface TradingAlarmRuntimeTarget {
  readonly initialized: Promise<void>;
  engineState: EngineState;
  refreshConfig(source: "ALARM"): Promise<void>;
  drainExecutionQueue(): Promise<void>;
  runJanitor(source: "ALARM"): Promise<void>;
  scheduleConfigRefresh(): Promise<void>;
  publish(type: "RESUME_QUOTES", payload: Record<string, unknown>): void;
}

export async function runTradingAlarmForTarget(target: TradingAlarmRuntimeTarget): Promise<void> {
  await target.initialized;
  await target.refreshConfig("ALARM");
  await target.drainExecutionQueue();
  await target.runJanitor("ALARM");

  const observedAt = new Date().toISOString();
  resumeTradingQuotesIfExpired(
    {
      engineState: target.engineState,
      observedAt
    },
    {
      applyState: (state) => {
        target.engineState = state;
      },
      publishResume: (payload) => {
        target.publish("RESUME_QUOTES", payload);
      }
    }
  );

  await target.scheduleConfigRefresh();
}
