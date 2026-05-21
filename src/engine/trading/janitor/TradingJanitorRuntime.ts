import {
  DEFAULT_ORDER_ACK_TIMEOUT_MS,
  ENGINE_STATE_KEY,
  RATE_LIMIT_STATE_KEY
} from "../../../TradingEngineConstants";
import type { RateLimitPriority } from "../../../utils/RateLimiter";
import type { EngineState, ExchangeOpenOrder, JanitorState, JsonRecord } from "../../../types";
import {
  emptyLogPruneReport,
  logRetentionPolicyToJson,
  pruneOperationalLogsFromD1,
  resolveLogRetentionPolicy,
  type LogPruneReport,
  type LogRetentionD1,
  type LogRetentionEnv
} from "../../LogRetention";
import { wait } from "../helpers/RuntimeMath";
import { readPositiveInteger } from "../helpers/RuntimeParsing";
import {
  applyCancelJanitorOrderSideEffects,
  cancelJanitorOrder,
  fetchJanitorExchangeOpenOrders,
  recordPostOnlyDustCloseSkips,
  runJanitorMaintenance
} from "./JanitorRuntime";
import type {
  JanitorCancelReason,
  JanitorCancelReservation,
  JanitorExecutionerFetcher
} from "./JanitorRuntime";
import { scheduleTradingStoragePutForTarget } from "../state/StorageWriteGuard";

export interface TradingJanitorLogger {
  warn(eventType: string, message: string, telemetry?: JsonRecord): void;
  error(eventType: string, message: string, telemetry?: JsonRecord): void;
}

export interface TradingJanitorMaintenanceInput {
  readonly source: "ALARM" | "ADMIN";
  readonly state: EngineState;
  readonly observedAt: string;
  readonly orderAckTimeoutMs: string | undefined;
  readonly executioner: JanitorExecutionerFetcher | undefined;
  readonly logger: TradingJanitorLogger;
}

export type TradingEngineJanitorMaintenanceInput = Omit<
  TradingJanitorMaintenanceInput,
  "observedAt"
>;

export interface TradingJanitorMaintenanceHandlers {
  readonly runBaseReport: (input: {
    readonly orderMap: EngineState["orderMap"];
    readonly positions: EngineState["openPositions"];
    readonly observedAt: string;
    readonly ackTimeoutMs: number;
    readonly dustThreshold: number;
  }) => JanitorState;
  readonly cancelOrder: (
    orderId: string,
    reason: JanitorCancelReason,
    instrumentCode?: string
  ) => Promise<void>;
  readonly pruneOperationalLogs: () => Promise<LogPruneReport>;
  readonly applyState: (state: EngineState) => Promise<void>;
}

export interface TradingEngineJanitorMaintenanceHandlers extends Omit<
  TradingJanitorMaintenanceHandlers,
  "applyState"
> {
  readonly nowIso: () => string;
  readonly applyState: (state: EngineState) => void;
  readonly persistState: (state: EngineState) => Promise<void>;
}

export interface TradingEngineJanitorMaintenanceTarget {
  engineState: EngineState;
  readonly env: {
    readonly ORDER_ACK_TIMEOUT_MS?: string;
    readonly EXECUTIONER?: JanitorExecutionerFetcher;
  };
  readonly logger: TradingJanitorLogger;
  readonly janitorAgent: {
    run(input: {
      readonly orderMap: EngineState["orderMap"];
      readonly positions: EngineState["openPositions"];
      readonly observedAt: string;
      readonly ackTimeoutMs: number;
      readonly dustThreshold: number;
    }): JanitorState;
  };
  cancelOrder?(
    orderId: string,
    reason: JanitorCancelReason,
    instrumentCode?: string
  ): Promise<void>;
  pruneOperationalLogs(): Promise<LogPruneReport>;
  safeStoragePut(key: string, value: unknown, reason: string): Promise<void>;
}

export interface TradingJanitorCancelInput {
  readonly executioner: JanitorExecutionerFetcher | undefined;
  readonly logger: TradingJanitorLogger;
  readonly orderId: string;
  readonly reason: string;
  readonly instrumentCode?: string;
}

export interface TradingJanitorCancelHandlers {
  readonly reserveCancelCapacity: (priority: RateLimitPriority) => JanitorCancelReservation;
  readonly persistRateLimitState: () => void;
  readonly wait?: (ms: number) => Promise<void>;
}

export interface TradingJanitorCancelTarget {
  readonly env: {
    readonly EXECUTIONER?: JanitorExecutionerFetcher;
  };
  readonly logger: TradingJanitorLogger;
  readonly rateLimiter: {
    reserve(bucket: string, priority: RateLimitPriority): JanitorCancelReservation;
    exportState(): unknown;
  };
  waitUntilStoragePut?(key: string, value: unknown, reason: string): void;
}

export interface TradingOperationalLogPruneInput {
  readonly db: LogRetentionD1;
  readonly env: LogRetentionEnv;
  readonly logger: Pick<TradingJanitorLogger, "error">;
}

export async function runTradingJanitorMaintenance(
  input: TradingJanitorMaintenanceInput,
  handlers: TradingJanitorMaintenanceHandlers
): Promise<void> {
  await runJanitorMaintenance(
    {
      source: input.source,
      state: input.state,
      observedAt: input.observedAt,
      ackTimeoutMs: readPositiveInteger(
        input.orderAckTimeoutMs,
        DEFAULT_ORDER_ACK_TIMEOUT_MS,
        100,
        60_000
      ),
      dustThreshold: 0.000001
    },
    {
      runBaseReport: handlers.runBaseReport,
      fetchExchangeOpenOrders: (): Promise<ExchangeOpenOrder[]> =>
        fetchJanitorExchangeOpenOrders({
          executioner: input.executioner,
          logger: input.logger
        }),
      cancelOrder: handlers.cancelOrder,
      recordDustCloseSkips: (instrumentCodes, dustObservedAt) =>
        recordPostOnlyDustCloseSkips({
          openPositions: input.state.openPositions,
          logger: input.logger,
          instrumentCodes,
          observedAt: dustObservedAt
        }),
      pruneOperationalLogs: handlers.pruneOperationalLogs,
      warnCleanupRequired: (metadata) => {
        input.logger.warn("JANITOR_CLEANUP_REQUIRED", "Janitor found state hygiene work", metadata);
      },
      applyState: handlers.applyState
    }
  );
}

export function runTradingEngineJanitorMaintenance(
  input: TradingEngineJanitorMaintenanceInput,
  handlers: TradingEngineJanitorMaintenanceHandlers
): Promise<void> {
  return runTradingJanitorMaintenance(
    {
      ...input,
      observedAt: handlers.nowIso()
    },
    {
      runBaseReport: handlers.runBaseReport,
      cancelOrder: handlers.cancelOrder,
      pruneOperationalLogs: handlers.pruneOperationalLogs,
      applyState: async (state) => {
        handlers.applyState(state);
        await handlers.persistState(state);
      }
    }
  );
}

export function runTradingEngineJanitorMaintenanceForTarget(
  source: "ALARM" | "ADMIN",
  target: TradingEngineJanitorMaintenanceTarget
): Promise<void> {
  return runTradingEngineJanitorMaintenance(
    {
      source,
      state: target.engineState,
      orderAckTimeoutMs: target.env.ORDER_ACK_TIMEOUT_MS,
      executioner: target.env.EXECUTIONER,
      logger: target.logger
    },
    {
      nowIso: () => new Date().toISOString(),
      runBaseReport: (input) => target.janitorAgent.run(input),
      cancelOrder: (orderId, reason, instrumentCode) =>
        target.cancelOrder
          ? target.cancelOrder(orderId, reason, instrumentCode)
          : cancelTradingJanitorOrderForTarget(
              orderId,
              reason,
              instrumentCode,
              target as unknown as TradingJanitorCancelTarget
            ),
      pruneOperationalLogs: () => target.pruneOperationalLogs(),
      applyState: (state) => {
        target.engineState = state;
      },
      persistState: (state) => target.safeStoragePut(ENGINE_STATE_KEY, state, "JANITOR_REPORT")
    }
  );
}

export async function cancelTradingJanitorOrder(
  input: TradingJanitorCancelInput,
  handlers: TradingJanitorCancelHandlers
): Promise<void> {
  await applyCancelJanitorOrderSideEffects(
    {
      hasExecutioner: Boolean(input.executioner),
      orderId: input.orderId,
      reason: input.reason,
      instrumentCode: input.instrumentCode
    },
    {
      reserveCancelCapacity: handlers.reserveCancelCapacity,
      persistRateLimitState: handlers.persistRateLimitState,
      wait: handlers.wait ?? wait,
      cancelOrder: (orderId, reason, instrumentCode) =>
        cancelJanitorOrder({
          executioner: input.executioner,
          logger: input.logger,
          orderId,
          reason,
          instrumentCode
        })
    }
  );
}

export async function cancelTradingJanitorOrderForTarget(
  orderId: string,
  reason: string,
  instrumentCode: string | undefined,
  target: TradingJanitorCancelTarget
): Promise<void> {
  await cancelTradingJanitorOrder(
    {
      executioner: target.env.EXECUTIONER,
      logger: target.logger,
      orderId,
      reason,
      instrumentCode
    },
    {
      reserveCancelCapacity: (priority) => target.rateLimiter.reserve("default", priority),
      persistRateLimitState: () => {
        scheduleTradingStoragePutForTarget(
          target,
          RATE_LIMIT_STATE_KEY,
          target.rateLimiter.exportState(),
          "JANITOR_CANCEL_RATE_LIMIT"
        );
      }
    }
  );
}

export async function pruneTradingOperationalLogs(
  input: TradingOperationalLogPruneInput
): Promise<LogPruneReport> {
  const policy = resolveLogRetentionPolicy(input.env);
  const emptyReport = emptyLogPruneReport(policy);

  try {
    return await pruneOperationalLogsFromD1(input.db, policy);
  } catch (error) {
    input.logger.error("JANITOR_LOG_PRUNE_FAILED", "Failed to prune stale operational logs", {
      policy: logRetentionPolicyToJson(policy),
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
    return emptyReport;
  }
}
