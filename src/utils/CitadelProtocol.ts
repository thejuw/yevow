import type {
  Env,
  ExecutionReport,
  JsonRecord,
  TradeExecution,
  TradeIntent
} from "../types";

export type CitadelOperationalStatus = "NOMINAL" | "WATCH" | "CRITICAL";

export interface CitadelDropInput {
  disconnectedForMs: number;
  thresholdMs: number;
  reason: string;
  observedAt: string;
}

export interface CitadelDropDecision {
  status: CitadelOperationalStatus;
  shouldEvacuate: boolean;
  evacuationSignal: {
    action: "CANCEL_ALL_QUOTES" | "MONITOR";
    reason: string;
    observedAt: string;
    disconnectedForMs: number;
    thresholdMs: number;
  };
}

export interface PreparedSignedRequestAudit {
  endpoint: string;
  init: RequestInit;
  signingLatencyMs: number;
  redactedPayload: Record<string, unknown>;
}

export interface SignedTradeIntentAudit {
  schemaVersion: "signed-trade-intent.audit.v1";
  intentId: string;
  instrumentCode: string;
  source_exchange: string | null;
  action: "BUY" | "SELL";
  orderType: TradeIntent["orderType"];
  timeInForce: TradeIntent["timeInForce"];
  postOnly: boolean;
  expectedPrice: number;
  requestedSize: number;
  approvedSize: number | null;
  expectedSlippageBps: number;
  exactTimestamp: string;
  signingLatencyMs: number;
  endpoint: string;
  signedPayload: JsonRecord;
  redactedPayload: JsonRecord;
}

export function isShadowMode(env: Pick<Env, "SHADOW_MODE"> | Record<string, unknown>): boolean {
  const value = "SHADOW_MODE" in env ? env.SHADOW_MODE : undefined;
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function evaluateGrpcDrop(input: CitadelDropInput): CitadelDropDecision {
  const disconnectedForMs = finiteNonNegative(input.disconnectedForMs);
  const thresholdMs = Math.max(1, finiteNonNegative(input.thresholdMs));
  const critical = disconnectedForMs >= thresholdMs;

  return {
    status: critical ? "CRITICAL" : "WATCH",
    shouldEvacuate: critical,
    evacuationSignal: {
      action: critical ? "CANCEL_ALL_QUOTES" : "MONITOR",
      reason: input.reason,
      observedAt: input.observedAt,
      disconnectedForMs,
      thresholdMs
    }
  };
}

export function buildSignedTradeIntentAudit(
  intent: TradeIntent,
  prepared: PreparedSignedRequestAudit,
  observedAt: string
): SignedTradeIntentAudit {
  return {
    schemaVersion: "signed-trade-intent.audit.v1",
    intentId: intent.intentId,
    instrumentCode: intent.instrumentCode,
    source_exchange: intent.source_exchange ?? null,
    action: intent.action,
    orderType: intent.orderType,
    timeInForce: intent.timeInForce,
    postOnly: intent.postOnly,
    expectedPrice: intent.expectedPrice,
    requestedSize: intent.requestedSize,
    approvedSize: intent.approvedSize ?? null,
    expectedSlippageBps: intent.maxSlippageBps,
    exactTimestamp: observedAt,
    signingLatencyMs: prepared.signingLatencyMs,
    endpoint: prepared.endpoint,
    signedPayload: sanitizeJsonRecord(parseRequestBody(prepared.init.body)),
    redactedPayload: sanitizeJsonRecord(prepared.redactedPayload)
  };
}

export function buildGhostExecutionReport(
  intent: TradeIntent,
  audit: SignedTradeIntentAudit,
  fees = 0
): ExecutionReport {
  const size = intent.approvedSize ?? intent.requestedSize;

  return {
    clientId: intent.intentId,
    exchangeOrderId: `ghost-${intent.intentId}`,
    instrumentCode: intent.instrumentCode,
    side: intent.action,
    orderSize: size,
    status: "GHOST_FILL",
    filledSize: size,
    fillIncrementSize: size,
    achievedPrice: intent.expectedPrice,
    expectedPrice: intent.expectedPrice,
    fees,
    latencyMs: 0,
    reason: "SHADOW_MODE_NO_EXCHANGE_POST",
    rawStatus: "GHOST_FILL",
    observedAt: audit.exactTimestamp
  };
}

export function buildGhostTradeExecution(
  intent: TradeIntent,
  audit: SignedTradeIntentAudit,
  venue: string,
  fees = 0
): TradeExecution {
  const size = intent.approvedSize ?? intent.requestedSize;

  return {
    tradeId: `ghost:${intent.intentId}:${Date.parse(audit.exactTimestamp) || audit.exactTimestamp}`,
    orderId: intent.intentId,
    signalId: intent.traceId,
    venue,
    asset: intent.instrumentCode,
    side: intent.action,
    orderType: intent.orderType,
    price: intent.expectedPrice,
    size,
    evAtExecution: intent.expectedValue,
    slippageBps: intent.maxSlippageBps,
    resultingPnl: 0,
    primaryDriver: "EXECUTIONER",
    fees,
    status: "GHOST_FILL",
    exchangeTradeId: `ghost-${intent.intentId}`,
    metadata: {
      shadowMode: true,
      expectedSlippageBps: intent.maxSlippageBps,
      exactTimestamp: audit.exactTimestamp,
      orderType: intent.orderType,
      signedTradeIntent: audit as unknown as JsonRecord
    },
    executedAt: audit.exactTimestamp
  };
}

function parseRequestBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    return {};
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return { rawBody: body };
  }
}

function sanitizeJsonRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) {
    return {};
  }

  const output: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = sanitizeJsonValue(item);
  }
  return output;
}

function sanitizeJsonValue(value: unknown): JsonRecord[string] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonValue);
  }
  if (isRecord(value)) {
    return sanitizeJsonRecord(value);
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
