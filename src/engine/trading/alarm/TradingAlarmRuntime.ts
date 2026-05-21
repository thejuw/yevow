import type { EngineState } from "../../../types";
import {
  drainTradingExecutionQueueForTarget,
  type TradingExecutionQueueTarget
} from "../execution/ExecutionQueueRuntime";
import {
  runTradingEngineJanitorMaintenanceForTarget,
  type TradingEngineJanitorMaintenanceTarget
} from "../janitor/TradingJanitorRuntime";
import { resumeTradingQuotesIfExpired } from "../quotes/TradingQuoteStateRuntime";
import {
  refreshTradingEngineConfigForTarget,
  scheduleTradingConfigRefreshForTarget,
  type TradingConfigRefreshCadenceTarget,
  type TradingEngineConfigControlTarget
} from "../config/TradingConfigControlRuntime";
import { publishTradingTelemetryForTarget } from "../telemetry/TelemetryBus";

export interface TradingAlarmRuntimeTarget {
  readonly initialized: Promise<void>;
  engineState: EngineState;
  refreshConfig?(source: "ALARM"): Promise<void>;
  drainExecutionQueue?(): Promise<void>;
  runJanitor?(source: "ALARM"): Promise<void>;
  scheduleConfigRefresh?(): Promise<void>;
  publish?(type: "RESUME_QUOTES", payload: Record<string, unknown>): void;
}

export async function runTradingAlarmForTarget(target: TradingAlarmRuntimeTarget): Promise<void> {
  await target.initialized;
  await (target.refreshConfig
    ? target.refreshConfig("ALARM")
    : refreshTradingEngineConfigForTarget(
        { source: "ALARM" },
        target as unknown as TradingEngineConfigControlTarget
      ));
  await (target.drainExecutionQueue
    ? target.drainExecutionQueue()
    : drainTradingExecutionQueueForTarget(target as unknown as TradingExecutionQueueTarget));
  await (target.runJanitor
    ? target.runJanitor("ALARM")
    : runTradingEngineJanitorMaintenanceForTarget(
        "ALARM",
        target as unknown as TradingEngineJanitorMaintenanceTarget
      ));

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
        publishTradingTelemetryForTarget(target, "RESUME_QUOTES", payload);
      }
    }
  );

  await (target.scheduleConfigRefresh
    ? target.scheduleConfigRefresh()
    : scheduleTradingConfigRefreshForTarget(
        target as unknown as TradingConfigRefreshCadenceTarget
      ));
}
