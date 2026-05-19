import {
  buildMarketKey,
  hyperliquidNativeInstrumentCode,
  nativeExchangeTimestamp,
  nativeIso,
  nativeObject,
  nativeSequence,
  normalizeSourceExchange,
  normalizeSourceWeight,
  parseHyperliquidNativeLevels,
  requireNativeString
} from "../../../TradingEngineRuntimeHelpers";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { BookSyncState } from "../book/BookTypes";
import type { OrderBookSnapshot } from "../../../types";

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

export type HyperliquidIngestConnectionRegistration =
  | {
      readonly registered: false;
      readonly reason: "MISSING_CONNECTION_ID";
      readonly source_exchange: string;
      readonly streamId: string | null;
      readonly observedAt: string;
    }
  | {
      readonly registered: true;
      readonly source_exchange: string;
      readonly streamId: string | null;
      readonly connectionId: string;
      readonly reason: unknown;
      readonly observedAt: string;
    };

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

export function registerHyperliquidIngestConnection(
  activeIngestConnections: Map<string, string>,
  payload: {
    source_exchange?: string | null;
    streamId?: string | null;
    connectionId?: string | null;
    reason?: unknown;
  },
  observedAt = new Date().toISOString()
): HyperliquidIngestConnectionRegistration {
  const sourceExchange = normalizeSourceExchange(payload.source_exchange ?? "hyperliquid");
  const streamId =
    typeof payload.streamId === "string" && payload.streamId.length > 0 ? payload.streamId : null;
  const connectionId =
    typeof payload.connectionId === "string" && payload.connectionId.length > 0
      ? payload.connectionId
      : null;

  if (!connectionId) {
    return {
      registered: false,
      reason: "MISSING_CONNECTION_ID",
      source_exchange: sourceExchange,
      streamId,
      observedAt
    };
  }

  activeIngestConnections.set(
    hyperliquidIngestConnectionKey(sourceExchange, streamId),
    connectionId
  );

  if (!streamId) {
    activeIngestConnections.set(hyperliquidIngestConnectionKey(sourceExchange, null), connectionId);
  }

  return {
    registered: true,
    source_exchange: sourceExchange,
    streamId,
    connectionId,
    reason: payload.reason ?? "INGEST_CONNECTION_REGISTERED",
    observedAt
  };
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

export interface HyperliquidL2BookSnapshotBundle {
  readonly data: Record<string, unknown>;
  readonly receivedAt: string;
  readonly coin: string;
  readonly instrumentCode: string;
  readonly exchangeCode: string;
  readonly sourceExchange: string;
  readonly sourceWeight: number;
  readonly exchangeTimestamp: string;
  readonly explicitSequenceValue: unknown;
  readonly hasExplicitSequence: boolean;
  readonly sequence: number;
  readonly marketKey: string;
  readonly snapshot: OrderBookSnapshot;
}

export function buildHyperliquidL2BookSnapshotBundle(
  raw: Record<string, unknown>,
  payload: HyperliquidRawIngestPayload,
  maxTimestampDriftMs: number,
  fallbackReceivedAt = new Date().toISOString()
): HyperliquidL2BookSnapshotBundle {
  const data = nativeObject(raw.data);

  if (!data) {
    throw new Error("INVALID_HYPERLIQUID_L2BOOK");
  }

  const receivedAt = nativeIso(payload.receivedAt) ?? fallbackReceivedAt;
  const coin = requireNativeString(data.coin ?? payload.instrumentCode, "coin");
  const instrumentCode = hyperliquidNativeInstrumentCode(coin, payload.instrumentCode);
  const exchangeCode = (payload.exchangeCode ?? "hyperliquid").toLowerCase();
  const sourceExchange = normalizeSourceExchange(payload.source_exchange ?? "hyperliquid");
  const sourceWeight = normalizeSourceWeight(payload.sourceWeight);
  const rawExchangeTimestamp = nativeExchangeTimestamp(data.time ?? data.timestamp);
  const exchangeTimestamp = resolveHyperliquidBookTimestamp(
    rawExchangeTimestamp,
    receivedAt,
    maxTimestampDriftMs
  );
  const explicitSequenceValue = data.sequence ?? data.seq;
  const explicitSequence = Number(explicitSequenceValue);
  const hasExplicitSequence =
    explicitSequenceValue !== undefined &&
    Number.isSafeInteger(explicitSequence) &&
    explicitSequence >= 0;
  const sequence = nativeSequence(
    hasExplicitSequence ? explicitSequenceValue : (data.time ?? data.timestamp)
  );
  const marketKey = buildMarketKey(sourceExchange, instrumentCode);
  const [bids, asks] = parseHyperliquidNativeLevels(data.levels, receivedAt);
  const snapshot: OrderBookSnapshot = {
    schemaVersion: "order-book.snapshot.v1",
    source: "HYPERLIQUID",
    source_exchange: sourceExchange,
    exchangeCode,
    instrumentCode,
    marketKey,
    sourceWeight,
    sequence,
    exchangeTimestamp,
    receivedAt,
    bids,
    asks
  };

  return {
    data,
    receivedAt,
    coin,
    instrumentCode,
    exchangeCode,
    sourceExchange,
    sourceWeight,
    exchangeTimestamp,
    explicitSequenceValue,
    hasExplicitSequence,
    sequence,
    marketKey,
    snapshot
  };
}

export type HyperliquidBookSequenceDecision =
  | { readonly status: "ACCEPTED" }
  | { readonly status: "DUPLICATE_OR_OUT_OF_ORDER" }
  | {
      readonly status: "DESYNC";
      readonly reason: "HYPERLIQUID_SEQUENCE_GAP";
      readonly previousSequence: number;
      readonly sequence: number;
      readonly gapMs: number;
      readonly maxGapMs: number;
      readonly lastDesyncAt: string;
    };

export function evaluateHyperliquidBookSequence(
  existingSync: BookSyncState | undefined,
  sequence: number,
  hasExplicitSequence: boolean,
  gapMs: number,
  observedAt: string
): HyperliquidBookSequenceDecision {
  if (existingSync?.lastSequence === null || existingSync?.lastSequence === undefined) {
    return { status: "ACCEPTED" };
  }

  if (sequence <= existingSync.lastSequence) {
    return { status: "DUPLICATE_OR_OUT_OF_ORDER" };
  }

  const sequenceGap = sequence - existingSync.lastSequence;
  if (hasExplicitSequence && sequenceGap > gapMs) {
    return {
      status: "DESYNC",
      reason: "HYPERLIQUID_SEQUENCE_GAP",
      previousSequence: existingSync.lastSequence,
      sequence,
      gapMs: sequenceGap,
      maxGapMs: gapMs,
      lastDesyncAt: observedAt
    };
  }

  return { status: "ACCEPTED" };
}
