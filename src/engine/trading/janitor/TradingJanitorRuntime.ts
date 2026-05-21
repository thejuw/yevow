import { DEFAULT_ORDER_ACK_TIMEOUT_MS } from "../../../TradingEngineConstants";
import type { LogPruneReport } from "../../LogRetention";
import type { EngineState, ExchangeOpenOrder, JanitorState, JsonRecord } from "../../../types";
import { readPositiveInteger } from "../helpers/RuntimeParsing";
import {
  fetchJanitorExchangeOpenOrders,
  recordPostOnlyDustCloseSkips,
  runJanitorMaintenance
} from "./JanitorRuntime";
import type { JanitorCancelReason, JanitorExecutionerFetcher } from "./JanitorRuntime";

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
