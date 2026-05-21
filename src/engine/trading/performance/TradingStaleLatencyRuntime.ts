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
import {
  logTradingPerformanceForTarget,
  observeTradingExecutionProfileForTarget,
  publishTradingTickTelemetryForTarget,
  type TradingHotPathTelemetryTarget
} from "../telemetry/TradingHotPathTelemetryRuntime";
import {
  tradingLatencyStorageWritesForTarget,
  type TradingLatencyStateTarget
} from "./TradingLatencyStateRuntime";
import {
  cancelAllTradingQuotesForTarget,
  type TradingQuoteCancelAllTarget
} from "../quotes/QuoteCancelRuntime";
import { applyHotStorageSnapshotForTargetOrHandler } from "../state/StorageWriteGuard";

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
  latencyStorageWrites?(extra?: Record<string, unknown>): Record<string, unknown>;
  persistHotStorageSnapshot?(writes: Record<string, unknown>, reason: string): Promise<void>;
  logPerformance?(latencyMetrics: LatencyMetrics): void;
  publish(type: "STALE_DATA_KILL_SWITCH", payload: JsonRecord): void;
  cancelAllQuotes?(instrumentCode: string, reason: string): Promise<void>;
  observeExecutionProfile?(metrics: LatencyMetrics, trace: ExecutionTraceInput): void;
  publishTickTelemetry?(
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
        applyHotStorageSnapshotForTargetOrHandler(
          target,
          tradingStaleLatencyStorageWrites(target),
          reason
        ),
      warnHardStale: (metadata) => {
        target.logger.warn("HARD_STALE_TICK_DROPPED", "Dropped tick beyond hard stale threshold", {
          ...metadata
        });
      },
      logPerformance: (staleMetrics) => {
        logTradingStalePerformance(target, staleMetrics);
      },
      publishPull: (payload) => {
        target.publish("STALE_DATA_KILL_SWITCH", payload);
      },
      schedule: (work) => {
        target.state.waitUntil(work);
      },
      cancelAllQuotes: (instrumentCode, reason) =>
        cancelAllQuotesForStaleLatencyTarget(target, instrumentCode, reason)
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
        observeTradingStaleExecutionProfile(target, profileMetrics, trace);
      },
      applyState: (state) => {
        target.engineState = state;
      },
      persistLatencySnapshot: (extra, reason) =>
        applyHotStorageSnapshotForTargetOrHandler(
          target,
          tradingStaleLatencyStorageWrites(target, extra),
          reason
        ),
      logPerformance: (staleMetrics) => {
        logTradingStalePerformance(target, staleMetrics);
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
      cancelAllQuotes: (instrumentCode, reason) =>
        cancelAllQuotesForStaleLatencyTarget(target, instrumentCode, reason),
      publishTickTelemetry: (telemetryTick, telemetryMetrics, status, telemetryStartedAt) => {
        publishTradingStaleTickTelemetry(
          target,
          telemetryTick,
          telemetryMetrics,
          status,
          telemetryStartedAt
        );
      },
      recordAgentSnapshot: (observedAt) => {
        target.maybeRecordAgentSnapshot(observedAt);
      }
    }
  );
}

function cancelAllQuotesForStaleLatencyTarget(
  target: TradingStaleLatencyTarget,
  instrumentCode: string,
  reason: string
): Promise<void> {
  return target.cancelAllQuotes
    ? target.cancelAllQuotes(instrumentCode, reason)
    : cancelAllTradingQuotesForTarget(
        instrumentCode,
        reason,
        target as unknown as TradingQuoteCancelAllTarget
      ).then(() => undefined);
}

function tradingStaleLatencyStorageWrites(
  target: TradingStaleLatencyTarget,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return target.latencyStorageWrites
    ? target.latencyStorageWrites(extra)
    : tradingLatencyStorageWritesForTarget(target as unknown as TradingLatencyStateTarget, extra);
}

function logTradingStalePerformance(
  target: TradingStaleLatencyTarget,
  metrics: LatencyMetrics
): void {
  if (target.logPerformance) {
    target.logPerformance(metrics);
    return;
  }

  logTradingPerformanceForTarget(metrics, target as unknown as TradingHotPathTelemetryTarget);
}

function observeTradingStaleExecutionProfile(
  target: TradingStaleLatencyTarget,
  metrics: LatencyMetrics,
  trace: ExecutionTraceInput
): void {
  if (target.observeExecutionProfile) {
    target.observeExecutionProfile(metrics, trace);
    return;
  }

  observeTradingExecutionProfileForTarget(
    metrics,
    trace,
    target as unknown as TradingHotPathTelemetryTarget
  );
}

function publishTradingStaleTickTelemetry(
  target: TradingStaleLatencyTarget,
  tick: MarketTick,
  metrics: LatencyMetrics,
  status: LatencyMetrics["status"],
  hotPathStartedAt: number
): void {
  if (target.publishTickTelemetry) {
    target.publishTickTelemetry(tick, metrics, status, hotPathStartedAt);
    return;
  }

  publishTradingTickTelemetryForTarget(
    tick,
    metrics,
    status,
    hotPathStartedAt,
    target as unknown as TradingHotPathTelemetryTarget
  );
}
