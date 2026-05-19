import type { LogPruneReport } from "../../LogRetention";
import type { EngineState, ExchangeOpenOrder, JanitorState } from "../../../types";

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

function hasClientId(order: ExchangeOpenOrder): order is ExchangeOpenOrder & { clientId: string } {
  return typeof order.clientId === "string" && order.clientId.length > 0;
}
