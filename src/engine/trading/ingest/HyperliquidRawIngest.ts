import { normalizeSourceExchange } from "../../../TradingEngineRuntimeHelpers";
import type { TickIngestResult } from "../TradingEngineRouteTypes";

export interface HyperliquidRawIngestPayload {
  streamId?: string;
  source?: "HYPERLIQUID";
  source_exchange?: string;
  transport?: "websocket" | "grpc";
  exchangeCode?: string;
  instrumentCode?: string;
  sourceWeight?: number;
  connectionId?: string | null;
  receivedAt?: string;
  raw?: unknown;
  messages?: unknown[];
}

export interface HyperliquidRawBatchContext {
  activeIngestConnections: Map<string, string>;
  enqueueRawMessage(
    raw: unknown,
    payload: HyperliquidRawIngestPayload,
    wakeUpTimeMs: number | null
  ): Promise<TickIngestResult>;
}

export async function handleHyperliquidRawBatch(
  payload: HyperliquidRawIngestPayload,
  wakeUpTimeMs: number | null,
  context: HyperliquidRawBatchContext
): Promise<TickIngestResult> {
  if (!isActiveHyperliquidIngestConnection(context.activeIngestConnections, payload)) {
    return {
      accepted: false,
      status: "IGNORED",
      reason: "STALE_INGEST_CONNECTION",
      processedCount: 0
    };
  }

  let processedCount = 0;
  let terminalResult: TickIngestResult | null = null;

  for (const raw of hyperliquidRawMessages(payload, 250)) {
    const result = await context.enqueueRawMessage(raw, payload, wakeUpTimeMs);
    processedCount += result.processedCount ?? (result.accepted ? 1 : 0);
    terminalResult = result;

    if (result.status === "DESYNC" || result.status === "STALE") {
      break;
    }
  }

  return {
    ...(terminalResult ?? { accepted: true, status: "FRESH" as const }),
    processedCount
  };
}

export function hyperliquidIngestConnectionKey(
  sourceExchange: string | null | undefined,
  streamId?: string | null
): string {
  return `${normalizeSourceExchange(sourceExchange ?? "hyperliquid")}:${streamId ?? "default"}`;
}

export function isActiveHyperliquidIngestConnection(
  activeIngestConnections: Map<string, string>,
  payload: HyperliquidRawIngestPayload
): boolean {
  if (!payload.connectionId) {
    return true;
  }

  const key = hyperliquidIngestConnectionKey(payload.source_exchange, payload.streamId);
  const fallbackKey = hyperliquidIngestConnectionKey(payload.source_exchange, null);
  const activeConnection = payload.streamId
    ? activeIngestConnections.get(key)
    : activeIngestConnections.get(fallbackKey);

  return !activeConnection || activeConnection === payload.connectionId;
}

export function hyperliquidRawMessages(
  payload: HyperliquidRawIngestPayload,
  limit: number
): unknown[] {
  const messages = Array.isArray(payload.messages) ? payload.messages : [payload.raw ?? payload];
  return messages.slice(0, Math.max(0, limit));
}

export function resolveHyperliquidBookTimestamp(
  rawExchangeTimestamp: string | null,
  receivedAt: string,
  maxDriftMs: number
): string {
  if (!rawExchangeTimestamp) {
    return receivedAt;
  }

  const rawMs = Date.parse(rawExchangeTimestamp);
  const receivedMs = Date.parse(receivedAt);

  if (!Number.isFinite(rawMs) || !Number.isFinite(receivedMs)) {
    return receivedAt;
  }

  return receivedMs - rawMs > maxDriftMs ? receivedAt : rawExchangeTimestamp;
}
