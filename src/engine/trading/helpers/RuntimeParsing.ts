import { decode as msgpackDecode } from "@msgpack/msgpack";
import { AGGREGATED_BUS_TELEMETRY_TYPES } from "../../../TradingEngineConstants";
import type { AgentName, AgentSignal, MarketTick } from "../../../types";

export interface HyperliquidRawIngestPayload {
  readonly streamId?: string;
  readonly source?: "HYPERLIQUID";
  readonly source_exchange?: string;
  readonly transport?: "websocket" | "grpc";
  readonly exchangeCode?: string;
  readonly instrumentCode?: string;
  readonly sourceWeight?: number;
  readonly connectionId?: string | null;
  readonly receivedAt?: string;
  readonly raw?: unknown;
  readonly messages?: unknown[];
}

export function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

export function readBoundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

export function clampInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

export function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readTelemetryNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertMarketTick(value: MarketTick): MarketTick {
  if (
    value?.schemaVersion !== "universal-tick.v1" ||
    typeof value.source !== "string" ||
    typeof value.source_exchange !== "string" ||
    typeof value.instrumentCode !== "string" ||
    typeof value.exchangeCode !== "string" ||
    typeof value.price !== "number" ||
    !Number.isFinite(value.price) ||
    value.price < 0 ||
    typeof value.size !== "number" ||
    !Number.isFinite(value.size) ||
    value.size < 0 ||
    typeof value.sequence !== "number" ||
    typeof value.exchangeTimestamp !== "string" ||
    typeof value.synchronizedExchangeTimestamp !== "string" ||
    typeof value.clockOffsetMs !== "number" ||
    typeof value.receivedAt !== "string"
  ) {
    throw new Error("INVALID_MARKET_TICK");
  }

  return value;
}

export function assertAgentSignal(value: AgentSignal): AgentSignal {
  const agentNames: AgentName[] = [
    "ORACLE",
    "SENTIMENT",
    "PROFILER",
    "CROUPIER",
    "PIT_BOSS",
    "JANITOR",
    "EXECUTIONER",
    "MOLTWORKER",
    "RISK",
    "SYSTEM"
  ];
  const actions = [
    "BUY",
    "SELL",
    "HOLD",
    "CANCEL",
    "REDUCE",
    "QUOTE",
    "EXECUTE",
    "PAUSE",
    "RESUME",
    "SUPERVISOR_ACTION"
  ];

  if (
    typeof value?.signalId !== "string" ||
    typeof value.traceId !== "string" ||
    !agentNames.includes(value.sourceAgent) ||
    !agentNames.includes(value.targetAgent) ||
    !actions.includes(value.action) ||
    typeof value.instrumentCode !== "string" ||
    typeof value.confidence !== "number" ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new Error("INVALID_AGENT_SIGNAL");
  }

  return value;
}

export async function readHyperliquidRawIngestPayload(
  request: Request
): Promise<HyperliquidRawIngestPayload> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/x-msgpack")) {
    const decoded = msgpackDecode(new Uint8Array(await request.arrayBuffer()));

    if (!isPlainObject(decoded)) {
      throw new Error("INVALID_HYPERLIQUID_MSGPACK_PAYLOAD");
    }

    return decoded;
  }

  return request.json<HyperliquidRawIngestPayload>();
}

export function shouldAggregateBusTelemetry(type: string): boolean {
  return AGGREGATED_BUS_TELEMETRY_TYPES.has(type);
}

export function decodeWebSocketMessage(data: string | ArrayBuffer): string | null {
  if (typeof data === "string") {
    return data;
  }

  return new TextDecoder().decode(data);
}

// JSON.parse cannot validate a caller's desired shape; callers narrow the typed result.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function readJsonOrNull<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8"
    }
  });
}
