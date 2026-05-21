import type { PerformanceSnapshot } from "../../../Logger";
import type {
  AgentName,
  AgentSignal,
  EngineStabilityStatus,
  EngineState,
  LatencyMetrics,
  MacroBias,
  MarketTick,
  TemporaryGovernanceOverride
} from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";
import type { ExecutionTraceInput } from "../performance/LatencyRuntime";
import { buildTradingPerformanceMetricsResponse } from "../performance/TradingPerformanceMetricsResponseRuntime";
import { observeTradingExecutionProfile } from "../performance/TradingExecutionProfileRuntime";
import { logTradingPerformanceSpike } from "../performance/TradingPerformanceSpikeRuntime";
import { maybePublishTradingAgentSnapshot } from "./TradingAgentSnapshotRuntime";
import { publishTradingTickTelemetry } from "./TradingTickTelemetryRuntime";
import { publishTradingTelemetryForTarget } from "./TelemetryBus";

export interface TradingHotPathTelemetryTarget {
  engineState: EngineState;
  processingLatencySamples: number[];
  lastPerformanceStatus: EngineStabilityStatus;
  readonly jitterThresholdMs: number;
  readonly jitterSampleWindow: number;
  readonly jitterComputeIntervalTicks: number;
  readonly macroBias: MacroBias;
  readonly activeTemporaryOverride: TemporaryGovernanceOverride | null;
  readonly adminSockets: {
    readonly size: number;
  };
  readonly signals: readonly AgentSignal[];
  readonly latestAgentSignals: ReadonlyMap<AgentName, AgentSignal>;
  readonly performanceSpikeLogAt: Map<string, number>;
  readonly logger: {
    logPerformanceSnapshot(snapshot: PerformanceSnapshot): void;
    logPerformance(latencyMetrics: LatencyMetrics): void;
  };
  readonly notifier: {
    notify(notification: NotifierEvent): void;
  };
  publish?(type: string, payload: Record<string, unknown>, correlationId?: string): void;
}

export function observeTradingExecutionProfileForTarget(
  metrics: LatencyMetrics,
  trace: ExecutionTraceInput,
  target: TradingHotPathTelemetryTarget
): void {
  observeTradingExecutionProfile(
    {
      engineState: target.engineState,
      processingLatencySamples: target.processingLatencySamples,
      metrics,
      trace,
      jitterThresholdMs: target.jitterThresholdMs,
      jitterSampleWindow: target.jitterSampleWindow,
      jitterComputeIntervalTicks: target.jitterComputeIntervalTicks,
      lastPerformanceStatus: target.lastPerformanceStatus
    },
    {
      applyProfile: (profile) => {
        target.engineState = {
          ...target.engineState,
          executionProfile: profile
        };
      },
      markPerformanceStatus: (status) => {
        target.lastPerformanceStatus = status;
      },
      logPerformanceSnapshot: (snapshot) => {
        target.logger.logPerformanceSnapshot(snapshot);
      },
      publishTransition: (transition) => {
        publishTradingTelemetryForTarget(
          target,
          transition.telemetryType,
          transition.telemetryPayload,
          transition.correlationId
        );
      },
      notify: (notification) => {
        target.notifier.notify(notification);
      }
    }
  );
}

export function buildTradingPerformanceMetricsResponseForTarget(
  target: Pick<TradingHotPathTelemetryTarget, "engineState">
): Response {
  return buildTradingPerformanceMetricsResponse(target.engineState);
}

export function publishTradingTickTelemetryForTarget(
  tick: MarketTick,
  metrics: LatencyMetrics,
  status: LatencyMetrics["status"],
  hotPathStartedAt: number,
  target: TradingHotPathTelemetryTarget
): void {
  publishTradingTickTelemetry(
    {
      tick,
      metrics,
      status,
      hotPathStartedAt,
      engineState: target.engineState,
      macroBias: target.macroBias,
      temporaryOverride: target.activeTemporaryOverride,
      connectedAdminStreams: target.adminSockets.size,
      signals: target.signals
    },
    {
      publish: (type, payload, correlationId) => {
        publishTradingTelemetryForTarget(target, type, payload, correlationId);
      }
    }
  );
}

export function maybeRecordTradingAgentSnapshotForTarget(
  observedAt: string,
  target: TradingHotPathTelemetryTarget
): void {
  maybePublishTradingAgentSnapshot(
    {
      engineState: target.engineState,
      latestAgentSignals: target.latestAgentSignals,
      observedAt
    },
    {
      publish: (type, payload, correlationId) => {
        publishTradingTelemetryForTarget(target, type, payload, correlationId);
      }
    }
  );
}

export function logTradingPerformanceForTarget(
  latencyMetrics: LatencyMetrics,
  target: Pick<TradingHotPathTelemetryTarget, "performanceSpikeLogAt" | "logger">
): void {
  logTradingPerformanceSpike(
    {
      logAt: target.performanceSpikeLogAt,
      latencyMetrics
    },
    {
      logPerformance: (metrics) => {
        target.logger.logPerformance(metrics);
      }
    }
  );
}
