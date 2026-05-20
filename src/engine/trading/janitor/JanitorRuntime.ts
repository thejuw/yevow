import { logPruneReportToJson, type LogPruneReport } from "../../LogRetention";
import type { EngineState, ExchangeOpenOrder, JanitorState, JsonRecord } from "../../../types";
import type { RateLimitPriority } from "../../../utils/RateLimiter";

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

export interface DispatchJanitorCancellationRequestsInput {
  readonly requests: readonly JanitorCancellationRequest[];
  readonly cancelOrder: (
    orderId: string,
    reason: JanitorCancelReason,
    instrumentCode?: string
  ) => Promise<void>;
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

export interface CancelJanitorOrderSideEffectsInput {
  readonly hasExecutioner: boolean;
  readonly orderId: string;
  readonly reason: string;
  readonly instrumentCode?: string;
}

export interface JanitorCancelReservation {
  readonly allowed: boolean;
  readonly waitMs: number;
}

export interface CancelJanitorOrderSideEffectHandlers {
  readonly reserveCancelCapacity: (priority: RateLimitPriority) => JanitorCancelReservation;
  readonly persistRateLimitState: () => void;
  readonly wait: (ms: number) => Promise<void>;
  readonly cancelOrder: (orderId: string, reason: string, instrumentCode?: string) => Promise<void>;
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

export async function applyCancelJanitorOrderSideEffects(
  input: CancelJanitorOrderSideEffectsInput,
  handlers: CancelJanitorOrderSideEffectHandlers
): Promise<void> {
  if (!input.hasExecutioner) {
    return;
  }

  const priority: RateLimitPriority = "CANCEL";
  const reservation = handlers.reserveCancelCapacity(priority);
  handlers.persistRateLimitState();

  if (!reservation.allowed) {
    await handlers.wait(reservation.waitMs);
  }

  await handlers.cancelOrder(input.orderId, input.reason, input.instrumentCode);
}

export async function dispatchJanitorCancellationRequests(
  input: DispatchJanitorCancellationRequestsInput
): Promise<void> {
  for (const request of input.requests) {
    await input.cancelOrder(request.orderId, request.reason, request.instrumentCode);
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

function hasClientId(order: ExchangeOpenOrder): order is ExchangeOpenOrder & { clientId: string } {
  return typeof order.clientId === "string" && order.clientId.length > 0;
}
