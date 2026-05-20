import { logPruneReportToJson, type LogPruneReport } from "../../LogRetention";
import type { EngineState, ExchangeOpenOrder, JanitorState, JsonRecord } from "../../../types";

export type JanitorCancelReason = "JANITOR_ORPHAN_EXCHANGE_ORDER" | "JANITOR_ZOMBIE_LOCAL_ORDER";

export interface JanitorCancellationRequest {
  readonly orderId: string;
  readonly reason: JanitorCancelReason;
  readonly instrumentCode?: string;
}

export interface JanitorOrderReconciliationInput {
  readonly orderMap: EngineState["orderMap"];
  readonly exchangeOpenOrders: readonly ExchangeOpenOrder[];
  readonly zombieOrders: readonly string[];
  readonly observedAt: string;
}

export interface JanitorOrderReconciliation {
  readonly orderMap: EngineState["orderMap"];
  readonly reconciledOrders: string[];
  readonly orphanExchangeOrders: string[];
  readonly cancelledOrders: string[];
  readonly cancellationRequests: JanitorCancellationRequest[];
}

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

export interface JanitorExecutionerFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface JanitorExecutionLogger {
  error(eventType: string, message: string, telemetry?: JsonRecord): void;
  warn(eventType: string, message: string, telemetry?: JsonRecord): void;
}

export interface FetchJanitorExchangeOpenOrdersInput {
  readonly executioner: JanitorExecutionerFetcher | undefined;
  readonly logger: JanitorExecutionLogger;
}

export interface CancelJanitorOrderInput {
  readonly executioner: JanitorExecutionerFetcher | undefined;
  readonly logger: JanitorExecutionLogger;
  readonly orderId: string;
  readonly reason: string;
  readonly instrumentCode?: string;
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

export function reconcileJanitorOrders(
  input: JanitorOrderReconciliationInput
): JanitorOrderReconciliation {
  const exchangeByClientId = new Map(
    input.exchangeOpenOrders.filter(hasClientId).map((order) => [order.clientId, order])
  );
  const exchangeIds = new Set(input.exchangeOpenOrders.map((order) => order.exchangeOrderId));
  const reconciledOrders: string[] = [];
  const orphanExchangeOrders: string[] = [];
  const cancelledOrders: string[] = [];
  const cancellationRequests: JanitorCancellationRequest[] = [];
  const nextOrderMap = { ...input.orderMap };

  for (const [clientId, localOrder] of Object.entries(nextOrderMap)) {
    const remote = exchangeByClientId.get(clientId);

    if (remote) {
      nextOrderMap[clientId] = {
        ...localOrder,
        exchangeOrderId: remote.exchangeOrderId,
        filledSize: remote.filledSize,
        status: remote.status,
        updatedAt: input.observedAt
      };
      reconciledOrders.push(clientId);
      continue;
    }

    if (
      localOrder.exchangeOrderId &&
      !exchangeIds.has(localOrder.exchangeOrderId) &&
      (localOrder.status === "PENDING" || localOrder.status === "OPEN")
    ) {
      nextOrderMap[clientId] = {
        ...localOrder,
        status: "CANCELLED",
        updatedAt: input.observedAt
      };
      cancelledOrders.push(clientId);
    }
  }

  for (const remote of input.exchangeOpenOrders) {
    if (remote.clientId && nextOrderMap[remote.clientId]) {
      continue;
    }

    orphanExchangeOrders.push(remote.exchangeOrderId);
    cancellationRequests.push({
      orderId: remote.exchangeOrderId,
      reason: "JANITOR_ORPHAN_EXCHANGE_ORDER",
      instrumentCode: remote.instrumentCode
    });
    cancelledOrders.push(remote.exchangeOrderId);
  }

  for (const clientId of input.zombieOrders) {
    cancellationRequests.push({
      orderId: clientId,
      reason: "JANITOR_ZOMBIE_LOCAL_ORDER",
      instrumentCode: nextOrderMap[clientId]?.instrumentCode
    });
    cancelledOrders.push(clientId);

    if (nextOrderMap[clientId]) {
      nextOrderMap[clientId] = {
        ...nextOrderMap[clientId],
        status: "CANCELLED",
        updatedAt: input.observedAt
      };
    }
  }

  return {
    orderMap: nextOrderMap,
    reconciledOrders,
    orphanExchangeOrders,
    cancelledOrders,
    cancellationRequests
  };
}

export async function fetchJanitorExchangeOpenOrders(
  input: FetchJanitorExchangeOpenOrdersInput
): Promise<ExchangeOpenOrder[]> {
  if (!input.executioner) {
    return [];
  }

  try {
    const response = await input.executioner.fetch(
      new Request("https://executioner.internal/open-orders")
    );

    if (!response.ok) {
      return [];
    }

    const payload = await response.json<{ orders?: ExchangeOpenOrder[] }>();
    return Array.isArray(payload.orders) ? payload.orders : [];
  } catch (error) {
    input.logger.error("JANITOR_OPEN_ORDERS_FAILED", "Failed to fetch exchange open orders", {
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
    return [];
  }
}

export async function cancelJanitorOrder(input: CancelJanitorOrderInput): Promise<void> {
  if (!input.executioner) {
    return;
  }

  try {
    await input.executioner.fetch(
      new Request("https://executioner.internal/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId: input.orderId,
          instrumentCode: input.instrumentCode,
          reason: input.reason
        })
      })
    );
  } catch (error) {
    input.logger.error("JANITOR_CANCEL_FAILED", "Failed to cancel order during janitor run", {
      orderId: input.orderId,
      instrumentCode: input.instrumentCode ?? null,
      reason: input.reason,
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
  }
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

function hasClientId(order: ExchangeOpenOrder): order is ExchangeOpenOrder & { clientId: string } {
  return typeof order.clientId === "string" && order.clientId.length > 0;
}
