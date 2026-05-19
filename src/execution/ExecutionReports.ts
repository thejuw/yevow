import type { ExecutionReport, TradeIntent } from "../types";
import { isRecord, numberField, stringField } from "./ResponseParsing";

export function toExecutionReport(
  intent: TradeIntent,
  response: Response,
  body: Record<string, unknown> | null,
  latencyMs: number
): ExecutionReport {
  const hyperliquid = extractHyperliquidExecution(body);
  const exchangeOrderId =
    stringField(body, ["order_id", "orderId", "id", "exchange_order_id", "clientOrderId"]) ??
    hyperliquid.exchangeOrderId;
  const filledSize =
    numberField(body, ["filled_size", "filledSize", "executed_size", "executedQty"]) ??
    hyperliquid.filledSize ??
    0;
  const rawStatus = hyperliquid.rawStatus ?? stringField(body, ["status", "state", "order_status"]);
  const status = normalizeOrderStatus(
    rawStatus,
    response.ok,
    filledSize,
    intent.approvedSize ?? intent.requestedSize
  );

  return {
    clientId: intent.intentId,
    exchangeOrderId,
    instrumentCode: intent.instrumentCode,
    side: intent.action,
    orderSize: intent.approvedSize ?? intent.requestedSize,
    status,
    filledSize,
    achievedPrice:
      hyperliquid.achievedPrice ??
      averageExecutionPrice(body) ??
      numberField(body, ["price", "avg_price", "average_price"]) ??
      intent.expectedPrice,
    expectedPrice: intent.expectedPrice,
    fees: extractFees(body),
    latencyMs,
    reason: response.ok
      ? hyperliquid.reason
      : String(body?.message ?? body?.error ?? response.status),
    rawStatus: rawStatus ?? undefined,
    observedAt: new Date().toISOString()
  };
}

export function averageExecutionPrice(body: Record<string, unknown> | null): number | undefined {
  const executedQty = numberField(body, [
    "executedQty",
    "filled_size",
    "filledSize",
    "executed_size"
  ]);
  const cumulativeQuote = numberField(body, [
    "cummulativeQuoteQty",
    "cumulativeQuoteQty",
    "filled_quote"
  ]);

  if (executedQty && cumulativeQuote && executedQty > 0 && cumulativeQuote > 0) {
    return cumulativeQuote / executedQty;
  }

  return undefined;
}

export function extractFees(body: Record<string, unknown> | null): number {
  const directFee = numberField(body, ["fees", "fee", "commission"]);
  if (directFee !== undefined) {
    return directFee;
  }

  const fills = Array.isArray(body?.fills) ? body.fills.filter(isRecord) : [];
  return fills.reduce((sum, fill) => sum + (numberField(fill, ["commission"]) ?? 0), 0);
}

export function rejectedReport(
  intent: TradeIntent,
  reason: string,
  statusCode: number,
  latencyMs = 0
): ExecutionReport {
  return {
    clientId: intent.intentId,
    instrumentCode: intent.instrumentCode,
    side: intent.action,
    orderSize: intent.approvedSize ?? intent.requestedSize,
    status: "REJECTED",
    filledSize: 0,
    achievedPrice: intent.expectedPrice,
    expectedPrice: intent.expectedPrice,
    fees: 0,
    latencyMs,
    reason: `${reason}:${statusCode}`,
    observedAt: new Date().toISOString()
  };
}

export function normalizeOrderStatus(
  rawStatus: string | undefined,
  responseOk: boolean,
  filledSize: number,
  orderSize: number
): ExecutionReport["status"] {
  if (!responseOk) {
    return "REJECTED";
  }

  const normalized = rawStatus?.toLowerCase();
  if (!normalized && orderSize > 0 && filledSize >= orderSize) {
    return "FILLED";
  }
  if (normalized === "test_accepted") {
    return "CANCELLED";
  }
  if (normalized?.includes("reject")) {
    return "REJECTED";
  }
  if (normalized?.includes("expired")) {
    return "REJECTED";
  }
  if (normalized?.includes("cancel")) {
    return "CANCELLED";
  }
  if (normalized?.includes("partial")) {
    return "PARTIAL_FILL";
  }
  if (normalized === "new" || normalized === "pending_cancel") {
    return "OPEN";
  }
  if (normalized?.includes("fill") || (orderSize > 0 && filledSize >= orderSize)) {
    return "FILLED";
  }

  return "OPEN";
}

export function normalizeSide(value: string | undefined): "BUY" | "SELL" {
  return value?.toUpperCase() === "SELL" || value?.toLowerCase() === "ask" ? "SELL" : "BUY";
}

function extractHyperliquidExecution(body: Record<string, unknown> | null): {
  exchangeOrderId?: string;
  filledSize?: number;
  achievedPrice?: number;
  rawStatus?: string;
  reason?: string;
} {
  const response = isRecord(body?.response) ? body.response : null;
  const data = isRecord(response?.data) ? response.data : null;
  const statuses = Array.isArray(data?.statuses) ? data.statuses.filter(isRecord) : [];
  const first = statuses[0];

  if (!first) {
    return {};
  }

  if (isRecord(first.resting)) {
    return {
      exchangeOrderId: stringField(first.resting, ["oid"]),
      rawStatus: "NEW"
    };
  }

  if (isRecord(first.filled)) {
    const totalSz = numberField(first.filled, ["totalSz", "sz", "size"]);
    const avgPx = numberField(first.filled, ["avgPx", "px", "price"]);
    return {
      exchangeOrderId: stringField(first.filled, ["oid"]),
      filledSize: totalSz,
      achievedPrice: avgPx,
      rawStatus: "FILLED"
    };
  }

  const error = stringField(first, ["error"]);
  if (error) {
    return {
      rawStatus: "REJECTED",
      reason: error
    };
  }

  return {};
}
