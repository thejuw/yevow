import type { NotifierEvent } from "../../../utils/Notifier";
import type {
  EngineState,
  Env,
  GlobalRiskConfig,
  JsonRecord,
  LatencyMetrics,
  MarketTick
} from "../../../types";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { ExecutionTraceInput } from "./LatencyRuntime";
import { resolveQuoteHibernateMs } from "../quotes/QuoteLifecycleRuntime";
import { applyHardStaleTickDropFlow } from "./HardStaleLatencyRuntime";
import { applySoftStaleTickFlow } from "./SoftStaleLatencyRuntime";

export interface TradingStaleLatencyTarget {
  engineState: EngineState;
  readonly cachedConfig: Pick<GlobalRiskConfig, "TRADING_ENABLED" | "QUOTE_HIBERNATE_MS">;
  readonly env: Pick<Env, "QUOTE_HIBERNATE_MS">;
  readonly maxLatencyMs: number;
  readonly state: {
    waitUntil(work: Promise<unknown>): void;
  };
  readonly logger: {
    warn(eventType: string, message: string, metadata: JsonRecord): void;
  };
  readonly notifier: {
    notify(notification: NotifierEvent): void;
  };
  resetLatencyBaseline(observedAt: string, reason: string): void;
  latencyStorageWrites(extra?: Record<string, unknown>): Record<string, unknown>;
  persistHotStorageSnapshot(writes: Record<string, unknown>, reason: string): Promise<void>;
  logPerformance(latencyMetrics: LatencyMetrics): void;
  publish(type: "STALE_DATA_KILL_SWITCH", payload: JsonRecord): void;
  cancelAllQuotes(instrumentCode: string, reason: string): Promise<void>;
  observeExecutionProfile(metrics: LatencyMetrics, trace: ExecutionTraceInput): void;
  publishTickTelemetry(
    tick: MarketTick,
    metrics: LatencyMetrics,
    status: LatencyMetrics["status"],
    hotPathStartedAt: number
  ): void;
  maybeRecordAgentSnapshot(observedAt: string): void;
}

export function handleTradingHardStaleTickDrop(
  tick: MarketTick,
  metrics: LatencyMetrics,
  streamId: string | null,
  hardStaleDropMs: number,
  target: TradingStaleLatencyTarget
): Promise<TickIngestResult> {
  return applyHardStaleTickDropFlow(
    {
      currentState: target.engineState,
      tick,
      metrics,
      streamId,
      hardStaleDropMs,
      tradingEnabled: target.cachedConfig.TRADING_ENABLED
    },
    {
      applyState: (state) => {
        target.engineState = state;
      },
      resetLatencyBaseline: (observedAt, reason) => {
        target.resetLatencyBaseline(observedAt, reason);
      },
      persistLatencySnapshot: (reason) =>
        target.persistHotStorageSnapshot(target.latencyStorageWrites(), reason),
      warnHardStale: (metadata) => {
        target.logger.warn("HARD_STALE_TICK_DROPPED", "Dropped tick beyond hard stale threshold", {
          ...metadata
        });
      },
      logPerformance: (staleMetrics) => {
        target.logPerformance(staleMetrics);
      },
      publishPull: (payload) => {
        target.publish("STALE_DATA_KILL_SWITCH", payload);
      },
      schedule: (work) => {
        target.state.waitUntil(work);
      },
      cancelAllQuotes: (instrumentCode, reason) => target.cancelAllQuotes(instrumentCode, reason)
    }
  );
}

export function handleTradingSoftStaleTick(
  tick: MarketTick,
  metrics: LatencyMetrics,
  wakeUpTimeMs: number | null,
  hotPathStartedAt: number,
  target: TradingStaleLatencyTarget
): Promise<TickIngestResult> {
  return applySoftStaleTickFlow(
    {
      tick,
      metrics,
      maxLatencyMs: target.maxLatencyMs,
      quoteHibernateMs: resolveQuoteHibernateMs(target.cachedConfig, target.env.QUOTE_HIBERNATE_MS),
      tradingEnabled: target.cachedConfig.TRADING_ENABLED,
      trace: {
        wakeUpTimeMs,
        orderBookUpdateMs: null,
        agentLogicMs: null,
        hotPathStartedAt,
        observedAt: metrics.brainTimestamp
      }
    },
    {
      readCurrentState: () => target.engineState,
      observeExecutionProfile: (profileMetrics, trace) => {
        target.observeExecutionProfile(profileMetrics, trace);
      },
      applyState: (state) => {
        target.engineState = state;
      },
      persistLatencySnapshot: (extra, reason) =>
        target.persistHotStorageSnapshot(target.latencyStorageWrites(extra), reason),
      logPerformance: (staleMetrics) => {
        target.logPerformance(staleMetrics);
      },
      publishKillSwitch: (payload) => {
        target.publish("STALE_DATA_KILL_SWITCH", payload);
      },
      notify: (notification) => {
        target.notifier.notify(notification);
      },
      schedule: (work) => {
        target.state.waitUntil(work);
      },
      cancelAllQuotes: (instrumentCode, reason) => target.cancelAllQuotes(instrumentCode, reason),
      publishTickTelemetry: (telemetryTick, telemetryMetrics, status, telemetryStartedAt) => {
        target.publishTickTelemetry(telemetryTick, telemetryMetrics, status, telemetryStartedAt);
      },
      recordAgentSnapshot: (observedAt) => {
        target.maybeRecordAgentSnapshot(observedAt);
      }
    }
  );
}
