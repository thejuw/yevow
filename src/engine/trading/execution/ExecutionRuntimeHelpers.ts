import { roundCrypto } from "../book/SortedBookSide";
import { pearson } from "../helpers/RuntimeMath";
import type { AgentName, EngineState, ExecutionReport, ManagedOrder, TradeExecution, TradeIntent } from "../../../types";

export function mapManagedStatusToTradeStatus(
  status: ManagedOrder["status"]
): TradeExecution["status"] {
  switch (status) {
    case "FILLED":
      return "FILLED";
    case "PARTIAL_FILL":
      return "PARTIAL";
    case "GHOST_FILL":
      return "GHOST_FILL";
    case "REJECTED":
      return "REJECTED";
    case "CANCELLED":
      return "CANCELLED";
    case "PENDING":
    case "OPEN":
    default:
      return "ACCEPTED";
  }
}

export function isPortfolioFillStatus(status: ManagedOrder["status"]): boolean {
  return status === "FILLED" || status === "PARTIAL_FILL" || status === "GHOST_FILL";
}

export function executionReportSize(
  report: ExecutionReport,
  order: ManagedOrder,
  status: TradeExecution["status"]
): number {
  if (status === "FILLED" || status === "PARTIAL" || status === "GHOST_FILL") {
    return report.fillIncrementSize ?? report.filledSize ?? order.filledSize ?? order.size;
  }

  return report.orderSize ?? order.size;
}

export function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (Number.isFinite(parsed) && parsed > 0) {
    return roundCrypto(parsed);
  }

  return Number.isFinite(fallback) && fallback > 0 ? roundCrypto(fallback) : 0.00000001;
}

export function executionTradeId(
  report: ExecutionReport,
  status: TradeExecution["status"],
  observedAt: string
): string {
  const exchangeId = report.exchangeOrderId ?? "local";
  return `execution:${report.clientId}:${exchangeId}:${status}:${Date.parse(observedAt) || observedAt}`;
}

export function inferExecutionPrimaryDriver(
  intent: TradeIntent | null,
  order: ManagedOrder
): AgentName {
  const rationale = intent?.rationale.toLowerCase() ?? "";

  if (rationale.includes("hedge") || order.clientId.includes(":hedge")) {
    return "RISK";
  }

  if (intent?.traceId.includes("profiler")) {
    return "PROFILER";
  }

  return intent ? "CROUPIER" : "EXECUTIONER";
}

export function appendSlippagePoint(
  current: EngineState["slippage"],
  point: EngineState["slippage"]["points"][number]
): EngineState["slippage"] {
  const points = [...current.points, point].slice(-500);
  const averageSlippageBps =
    points.reduce((sum, item) => sum + item.slippageBps, 0) / Math.max(1, points.length);
  const latencyCorrelation = pearson(
    points.map((item) => item.latencyMs),
    points.map((item) => Math.abs(item.slippageBps))
  );
  const executionCostBufferBps =
    averageSlippageBps > current.executionCostBufferBps
      ? averageSlippageBps
      : current.executionCostBufferBps;

  return {
    schemaVersion: "slippage.v1",
    points,
    averageSlippageBps,
    latencyCorrelation,
    executionCostBufferBps,
    updatedAt: point.observedAt
  };
}

export function quoteToTelemetry(
  quote: EngineState["quoteState"]["lastQuote"]
): Record<string, unknown> {
  return quote
    ? {
        schemaVersion: quote.schemaVersion,
        signalId: quote.signalId,
        instrumentCode: quote.instrumentCode,
        marketKey: quote.marketKey,
        reservationPrice: quote.reservationPrice,
        optimalSpread: quote.optimalSpread,
        orderCount: quote.orders.length,
        orders: quote.orders.map((order) => ({
          clientOrderId: order.clientOrderId,
          side: order.side,
          price: order.price,
          size: order.size,
          postOnly: order.postOnly,
          strategy: order.strategy ?? "AMM",
          clusterId: order.clusterId ?? null
        })),
        createdAt: quote.createdAt
      }
    : {};
}

export function quoteStateTelemetry(state: EngineState["quoteState"]): Record<string, unknown> {
  return {
    status: state.status,
    reason: state.reason,
    suspendedUntil: state.suspendedUntil,
    updatedAt: state.updatedAt
  };
}
