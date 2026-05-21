import { DEFAULT_ORDER_ACK_TIMEOUT_MS } from "../../../TradingEngineConstants";
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
