import type { CascadeAlertEventType } from "../../../strategy/cascade/OperationalSafeguards";
import type {
  AgentName,
  AgentSignal,
  EngineState,
  GlobalRiskConfig,
  JsonRecord
} from "../../../types";
import type { NotifierEvent } from "../../../utils/Notifier";
import { acceptTradingAgentSignal } from "./AgentSignalRuntime";
import {
  buildCascadeOperationalAlertTelemetry,
  emitCascadeOperationalAlertSideEffects,
  recordTradingCascadeUiSignalSideEffects,
  type CascadeSignalOutcome
} from "./CascadeSignalTelemetryRuntime";
import {
  cancelAllTradingQuotesForTarget,
  type TradingQuoteCancelAllTarget
} from "../quotes/QuoteCancelRuntime";
import { putTradingStorageForTargetOrHandler } from "../state/StorageWriteGuard";

export interface TradingSignalBusTarget {
  signals: AgentSignal[];
  latestAgentSignals: Map<AgentName, AgentSignal>;
  engineState: EngineState;
  readonly cachedConfig: Pick<GlobalRiskConfig, "TRADING_ENABLED">;
  readonly state: {
    waitUntil(work: Promise<unknown>): void;
  };
  readonly logger: {
    agentDecision(signal: AgentSignal, latencyMs: number): void;
  };
  readonly notifier: {
    notify(notification: NotifierEvent): void;
  };
  safeStoragePut?(entries: Record<string, unknown>, reason: string): Promise<void>;
  safeStoragePut?(key: string, value: unknown, reason: string): Promise<void>;
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
  cancelAllQuotes?(instrumentCode: string, reason: "HAWKES_FLOW_CLUSTER"): Promise<void>;
}

export function acceptTradingAgentSignalForTarget(
  signal: AgentSignal,
  latencyMs: number,
  target: TradingSignalBusTarget
): Promise<void> {
  return acceptTradingAgentSignal(
    {
      signals: target.signals,
      latestAgentSignals: target.latestAgentSignals,
      engineState: target.engineState,
      signal,
      latencyMs,
      tradingEnabled: target.cachedConfig.TRADING_ENABLED
    },
    {
      applyState: (state) => {
        target.engineState = state;
      },
      persistStorageEntries: (entries) =>
        putTradingStorageForTargetOrHandler(target, entries, "AGENT_SIGNAL"),
      logAgentDecision: (agentSignal, signalLatencyMs) => {
        target.logger.agentDecision(agentSignal, signalLatencyMs);
      },
      publish: (telemetryType, payload, correlationId) => {
        target.publish(telemetryType, payload, correlationId);
      },
      schedule: (work) => {
        target.state.waitUntil(work);
      },
      cancelAllQuotes: (instrumentCode, reason) =>
        target.cancelAllQuotes
          ? target.cancelAllQuotes(instrumentCode, reason)
          : cancelAllTradingQuotesForTarget(
              instrumentCode,
              reason,
              target as unknown as TradingQuoteCancelAllTarget
            ).then(() => undefined)
    }
  ).then(() => undefined);
}

export function emitTradingCascadeOperationalAlertForTarget(
  eventType: CascadeAlertEventType,
  title: string,
  message: string,
  metadata: JsonRecord,
  dedupeKey: string,
  target: TradingSignalBusTarget
): void {
  const event = buildCascadeOperationalAlertTelemetry(
    eventType,
    title,
    message,
    metadata,
    dedupeKey
  );

  emitCascadeOperationalAlertSideEffects(event, {
    publish: (telemetryType, payload, correlationId) => {
      target.publish(telemetryType, payload, correlationId);
    },
    notify: (notification) => {
      target.notifier.notify(notification);
    }
  });
}

export function recordTradingCascadeUiSignalForTarget(
  signal: AgentSignal,
  outcome: CascadeSignalOutcome,
  target: TradingSignalBusTarget
): void {
  recordTradingCascadeUiSignalSideEffects(
    {
      signals: target.signals,
      latestAgentSignals: target.latestAgentSignals,
      signal,
      outcome
    },
    {
      schedule: (work) => {
        target.state.waitUntil(work);
      },
      persistStorageSignal: (key, signalToPersist, reason) =>
        putTradingStorageForTargetOrHandler(target, key, signalToPersist, reason),
      publish: (telemetryType, payload, correlationId) => {
        target.publish(telemetryType, payload, correlationId);
      }
    }
  );
}
