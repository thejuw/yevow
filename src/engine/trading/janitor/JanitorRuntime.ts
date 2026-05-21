import { logPruneReportToJson, type LogPruneReport } from "../../LogRetention";
import type { EngineState, ExchangeOpenOrder, JanitorState, JsonRecord } from "../../../types";
import { dispatchJanitorCancellationRequests } from "./JanitorExecutionRuntime";
import type { JanitorExecutionLogger } from "./JanitorExecutionRuntime";
import { reconcileJanitorOrders } from "./JanitorOrderReconciliationRuntime";
import type {
  JanitorCancelReason,
  JanitorOrderReconciliation
} from "./JanitorOrderReconciliationRuntime";
export {
  applyCancelJanitorOrderSideEffects,
  cancelJanitorOrder,
  dispatchJanitorCancellationRequests,
  fetchJanitorExchangeOpenOrders,
  type CancelJanitorOrderInput,
  type CancelJanitorOrderSideEffectHandlers,
  type CancelJanitorOrderSideEffectsInput,
  type DispatchJanitorCancellationRequestsInput,
  type FetchJanitorExchangeOpenOrdersInput,
  type JanitorCancelReservation,
  type JanitorExecutionerFetcher,
  type JanitorExecutionLogger
} from "./JanitorExecutionRuntime";
export {
  reconcileJanitorOrders,
  type JanitorCancellationRequest,
  type JanitorCancelReason,
  type JanitorOrderReconciliation,
  type JanitorOrderReconciliationInput
} from "./JanitorOrderReconciliationRuntime";

export interface JanitorReportInput {
  readonly baseReport: JanitorState;
  readonly reconciliation: JanitorOrderReconciliation;
  readonly dustCloseIntents: readonly string[];
  readonly pruneReport: LogPruneReport;
}

export interface JanitorReportResult {
  readonly report: JanitorState;
  readonly shouldWarn: boolean;
}

export interface JanitorStateUpdateInput {
  readonly state: EngineState;
  readonly orderMap: EngineState["orderMap"];
  readonly report: JanitorState;
  readonly observedAt: string;
}

export interface JanitorCleanupWarningInput {
  readonly source: "ALARM" | "ADMIN";
  readonly report: JanitorState;
  readonly pruneReport: LogPruneReport;
}

export interface JanitorRunArtifactsInput {
  readonly source: "ALARM" | "ADMIN";
  readonly state: EngineState;
  readonly baseReport: JanitorState;
  readonly reconciliation: JanitorOrderReconciliation;
  readonly dustCloseIntents: readonly string[];
  readonly pruneReport: LogPruneReport;
  readonly observedAt: string;
}

export interface JanitorRunArtifacts {
  readonly report: JanitorState;
  readonly orderMap: EngineState["orderMap"];
  readonly state: EngineState;
  readonly warningMetadata: JsonRecord | null;
}

export interface JanitorRunSideEffectsInput {
  readonly source: "ALARM" | "ADMIN";
  readonly state: EngineState;
  readonly baseReport: JanitorState;
  readonly observedAt: string;
}

export interface JanitorBaseReportInput {
  readonly orderMap: EngineState["orderMap"];
  readonly positions: EngineState["openPositions"];
  readonly observedAt: string;
  readonly ackTimeoutMs: number;
  readonly dustThreshold: number;
}

export interface JanitorMaintenanceInput {
  readonly source: "ALARM" | "ADMIN";
  readonly state: EngineState;
  readonly observedAt: string;
  readonly ackTimeoutMs: number;
  readonly dustThreshold: number;
}

export interface JanitorRunSideEffectHandlers {
  readonly fetchExchangeOpenOrders: () => Promise<ExchangeOpenOrder[]>;
  readonly cancelOrder: (
    orderId: string,
    reason: JanitorCancelReason,
    instrumentCode?: string
  ) => Promise<void>;
  readonly recordDustCloseSkips: (
    instrumentCodes: readonly string[],
    observedAt: string
  ) => readonly string[];
  readonly pruneOperationalLogs: () => Promise<LogPruneReport>;
  readonly warnCleanupRequired: (metadata: JsonRecord) => void;
  readonly applyState: (state: EngineState) => Promise<void>;
}

export interface JanitorMaintenanceSideEffectHandlers extends JanitorRunSideEffectHandlers {
  readonly runBaseReport: (input: JanitorBaseReportInput) => JanitorState;
}

export interface RecordPostOnlyDustCloseSkipInput {
  readonly openPositions: EngineState["openPositions"];
  readonly logger: JanitorExecutionLogger;
  readonly instrumentCode: string;
  readonly observedAt: string;
}

export interface RecordPostOnlyDustCloseSkipsInput {
  readonly openPositions: EngineState["openPositions"];
  readonly logger: JanitorExecutionLogger;
  readonly instrumentCodes: readonly string[];
  readonly observedAt: string;
}

export function recordPostOnlyDustCloseSkip(
  input: RecordPostOnlyDustCloseSkipInput
): string | null {
  const position = input.openPositions[input.instrumentCode];

  if (!position) {
    return null;
  }

  input.logger.warn(
    "JANITOR_DUST_CLOSE_SKIPPED",
    "Dust closeout skipped because taker execution is disabled",
    {
      instrumentCode: input.instrumentCode,
      side: position.side,
      quantity: position.quantity,
      observedAt: input.observedAt,
      inventoryProtocol: "POST_ONLY_SKEW"
    }
  );
  return null;
}

export function recordPostOnlyDustCloseSkips(input: RecordPostOnlyDustCloseSkipsInput): string[] {
  const dustCloseIntents: string[] = [];

  for (const instrumentCode of input.instrumentCodes) {
    const intentId = recordPostOnlyDustCloseSkip({
      openPositions: input.openPositions,
      logger: input.logger,
      instrumentCode,
      observedAt: input.observedAt
    });

    if (intentId) {
      dustCloseIntents.push(intentId);
    }
  }

  return dustCloseIntents;
}

export function buildJanitorReport(input: JanitorReportInput): JanitorReportResult {
  const report: JanitorState = {
    ...input.baseReport,
    orphanExchangeOrders: input.reconciliation.orphanExchangeOrders,
    reconciledOrders: input.reconciliation.reconciledOrders,
    cancelledOrders: [...new Set(input.reconciliation.cancelledOrders)],
    dustCloseIntents: [...input.dustCloseIntents],
    prunedTelemetryCount: input.pruneReport.totalRows
  };

  return {
    report,
    shouldWarn:
      report.zombieOrders.length > 0 ||
      report.orphanExchangeOrders.length > 0 ||
      report.dustPositions.length > 0 ||
      report.prunedTelemetryCount > 0
  };
}

export function stateAfterJanitorRun(input: JanitorStateUpdateInput): EngineState {
  return {
    ...input.state,
    orderMap: input.orderMap,
    janitor: input.report,
    updatedAt: input.observedAt,
    heartbeatAt: input.observedAt
  };
}

export function janitorCleanupRequiredLogMetadata(input: JanitorCleanupWarningInput): JsonRecord {
  return {
    source: input.source,
    zombieOrders: input.report.zombieOrders,
    orphanExchangeOrders: input.report.orphanExchangeOrders,
    cancelledOrders: input.report.cancelledOrders,
    dustPositions: input.report.dustPositions,
    dustCloseIntents: input.report.dustCloseIntents,
    prunedTelemetryCount: input.report.prunedTelemetryCount,
    pruneReport: logPruneReportToJson(input.pruneReport)
  };
}

export function buildJanitorRunArtifacts(input: JanitorRunArtifactsInput): JanitorRunArtifacts {
  const janitorResult = buildJanitorReport({
    baseReport: input.baseReport,
    reconciliation: input.reconciliation,
    dustCloseIntents: input.dustCloseIntents,
    pruneReport: input.pruneReport
  });

  return {
    report: janitorResult.report,
    orderMap: input.reconciliation.orderMap,
    state: stateAfterJanitorRun({
      state: input.state,
      orderMap: input.reconciliation.orderMap,
      report: janitorResult.report,
      observedAt: input.observedAt
    }),
    warningMetadata: janitorResult.shouldWarn
      ? janitorCleanupRequiredLogMetadata({
          source: input.source,
          report: janitorResult.report,
          pruneReport: input.pruneReport
        })
      : null
  };
}

export async function applyJanitorRunSideEffects(
  input: JanitorRunSideEffectsInput,
  handlers: JanitorRunSideEffectHandlers
): Promise<JanitorRunArtifacts> {
  const exchangeOpenOrders = await handlers.fetchExchangeOpenOrders();
  const reconciliation = reconcileJanitorOrders({
    orderMap: input.state.orderMap,
    exchangeOpenOrders,
    zombieOrders: input.baseReport.zombieOrders,
    observedAt: input.observedAt
  });

  await dispatchJanitorCancellationRequests({
    requests: reconciliation.cancellationRequests,
    cancelOrder: handlers.cancelOrder
  });

  const dustCloseIntents = handlers.recordDustCloseSkips(
    input.baseReport.dustPositions,
    input.observedAt
  );
  const pruneReport = await handlers.pruneOperationalLogs();
  const artifacts = buildJanitorRunArtifacts({
    source: input.source,
    state: input.state,
    baseReport: input.baseReport,
    reconciliation,
    dustCloseIntents,
    pruneReport,
    observedAt: input.observedAt
  });

  if (artifacts.warningMetadata) {
    handlers.warnCleanupRequired(artifacts.warningMetadata);
  }

  await handlers.applyState(artifacts.state);
  return artifacts;
}

export async function runJanitorMaintenance(
  input: JanitorMaintenanceInput,
  handlers: JanitorMaintenanceSideEffectHandlers
): Promise<JanitorRunArtifacts> {
  const baseReport = handlers.runBaseReport({
    orderMap: input.state.orderMap,
    positions: input.state.openPositions,
    observedAt: input.observedAt,
    ackTimeoutMs: input.ackTimeoutMs,
    dustThreshold: input.dustThreshold
  });

  return applyJanitorRunSideEffects(
    {
      source: input.source,
      state: input.state,
      baseReport,
      observedAt: input.observedAt
    },
    handlers
  );
}
