import { buildMarketKey } from "../book/BookRuntimeHelpers";
import {
  DEFAULT_HL_BOOK_TIMESTAMP_MAX_DRIFT_MS,
  DEFAULT_HL_SEQUENCE_GAP_MS
} from "../../../TradingEngineConstants";
import {
  createNativeHyperliquidBookTick,
  hyperliquidNativeInstrumentCode,
  isNativeRecord,
  nativeHyperliquidLatencyMetrics,
  nativeExchangeTimestamp,
  nativeIso,
  nativeObject,
  nativeSequence,
  nativeString,
  normalizeSourceExchange,
  normalizeSourceWeight,
  parseHyperliquidNativeLevels,
  requireNativeString,
  createNativeHyperliquidFundingTick,
  createNativeHyperliquidTradeTick
} from "../helpers/NativeHyperliquidRuntime";
import { parseTimestampMs } from "../helpers/RuntimeClock";
import { readPositiveNumber } from "../helpers/RuntimeParsing";
import { resolveNativeHyperliquidMaxLatencyMs } from "../performance/LatencyRuntime";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { BookSyncState } from "../book/BookTypes";
import type {
  EngineLocation,
  InternalOrderBook,
  JsonRecord,
  LatencyMetrics,
  MarketTick,
  OrderBookSnapshot
} from "../../../types";

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

export interface HyperliquidTickProcessorContext {
  processTick(tick: MarketTick, wakeUpTimeMs: number | null): Promise<TickIngestResult>;
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

export type HyperliquidRawMessageRoute =
  | {
      readonly kind: "CONTROL";
      readonly raw: Record<string, unknown>;
      readonly channel: string | null;
    }
  | { readonly kind: "L2_BOOK"; readonly raw: Record<string, unknown> }
  | { readonly kind: "TRADES"; readonly raw: Record<string, unknown> }
  | { readonly kind: "ASSET_CONTEXT"; readonly raw: Record<string, unknown> }
  | { readonly kind: "LIQUIDATION_EVENTS"; readonly raw: Record<string, unknown> }
  | { readonly kind: "IGNORED"; readonly raw: Record<string, unknown>; readonly reason: string };

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

export function routeHyperliquidRawMessage(raw: unknown): HyperliquidRawMessageRoute {
  if (!isNativeRecord(raw)) {
    throw new Error("INVALID_HYPERLIQUID_RAW_MESSAGE");
  }

  const channel = nativeString(raw.channel)?.toLowerCase() ?? null;

  if (channel === "subscriptionresponse" || channel === "pong") {
    return { kind: "CONTROL", raw, channel };
  }

  if (channel === "l2book") {
    return { kind: "L2_BOOK", raw };
  }

  if (channel === "trades") {
    return { kind: "TRADES", raw };
  }

  if (channel === "activeassetctx" || channel === "alldexsassetctxs") {
    return { kind: "ASSET_CONTEXT", raw };
  }

  if (
    channel === "userevents" ||
    channel === "usernonfundingledgerupdates" ||
    channel === "events" ||
    channel === "liquidation"
  ) {
    return { kind: "LIQUIDATION_EVENTS", raw };
  }

  return {
    kind: "IGNORED",
    raw,
    reason: `IGNORED_HYPERLIQUID_CHANNEL_${channel ?? "UNKNOWN"}`
  };
}

export async function processHyperliquidTradeBatch(
  raw: Record<string, unknown>,
  payload: HyperliquidRawIngestPayload,
  wakeUpTimeMs: number | null,
  context: HyperliquidTickProcessorContext
): Promise<TickIngestResult> {
  const rawData: unknown = raw.data;
  const data: readonly unknown[] = Array.isArray(rawData) ? rawData : [];
  const maxTrades = Math.min(data.length, 100);
  let processedCount = 0;
  let terminalResult: TickIngestResult = {
    accepted: true,
    status: "FRESH",
    processedCount: 0
  };

  for (let index = 0; index < maxTrades; index += 1) {
    const item = data[index];

    if (!isNativeRecord(item)) {
      continue;
    }

    terminalResult = await context.processTick(
      createNativeHyperliquidTradeTick(item, payload),
      wakeUpTimeMs
    );
    processedCount += 1;

    if (terminalResult.status === "STALE" || terminalResult.status === "DESYNC") {
      break;
    }
  }

  return { ...terminalResult, processedCount };
}

export async function processHyperliquidAssetContext(
  raw: Record<string, unknown>,
  payload: HyperliquidRawIngestPayload,
  wakeUpTimeMs: number | null,
  context: HyperliquidTickProcessorContext
): Promise<TickIngestResult> {
  const data = nativeObject(raw.data) ?? raw;
  const result = await context.processTick(
    createNativeHyperliquidFundingTick(data, payload),
    wakeUpTimeMs
  );

  return {
    ...result,
    processedCount: 1
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

export interface HyperliquidL2BookLatencyMetricsInput {
  readonly bundle: HyperliquidL2BookSnapshotBundle;
  readonly brainTimestamp: string;
  readonly totalLatencyMs: number;
  readonly maxLatencyMs: number;
  readonly averageLatencyMs: number;
  readonly sampleCount: number;
  readonly location: EngineLocation;
}

export interface HyperliquidL2BookTickInput {
  readonly payload: HyperliquidRawIngestPayload;
  readonly bundle: HyperliquidL2BookSnapshotBundle;
  readonly price: number;
  readonly bestBid?: number;
  readonly bestAsk?: number;
  readonly rawEventType?: string;
}

export interface HyperliquidL2BookHotPathInput {
  readonly raw: Record<string, unknown>;
  readonly payload: HyperliquidRawIngestPayload;
  resolveExistingSync(marketKey: string): BookSyncState | undefined;
  readonly maxTimestampDriftMs: number;
  readonly sequenceGapMs: number;
  readonly nativeMaxLatencyMs: number;
  readonly averageLatencyMs: number;
  readonly sampleCount: number;
  readonly location: EngineLocation;
  readonly fallbackReceivedAt?: string;
  readonly brainTimestamp?: string;
}

export interface HyperliquidL2BookRuntimeInput extends Omit<
  HyperliquidL2BookHotPathInput,
  "maxTimestampDriftMs" | "sequenceGapMs" | "nativeMaxLatencyMs"
> {
  readonly dwellirMaxLatencyMs?: string;
  readonly hlStaleAfterMs?: string;
  readonly hlBookTimestampMaxDriftMs?: string;
  readonly hlSequenceGapMs?: string;
  readonly currentMaxLatencyMs: number;
}

export type HyperliquidL2BookHotPathDecision =
  | {
      readonly kind: "DUPLICATE_OR_OUT_OF_ORDER";
      readonly bundle: HyperliquidL2BookSnapshotBundle;
      readonly result: TickIngestResult;
    }
  | {
      readonly kind: "DESYNC";
      readonly bundle: HyperliquidL2BookSnapshotBundle;
      readonly sequenceDecision: Extract<HyperliquidBookSequenceDecision, { status: "DESYNC" }>;
      readonly result: TickIngestResult;
    }
  | {
      readonly kind: "STALE";
      readonly bundle: HyperliquidL2BookSnapshotBundle;
      readonly brainTimestamp: string;
      readonly totalLatencyMs: number;
      readonly nativeMaxLatencyMs: number;
      readonly metrics: LatencyMetrics;
    }
  | {
      readonly kind: "ACCEPTED";
      readonly bundle: HyperliquidL2BookSnapshotBundle;
      readonly brainTimestamp: string;
      readonly totalLatencyMs: number;
      readonly nativeMaxLatencyMs: number;
    };

export function calculateHyperliquidBookTotalLatencyMs(
  exchangeTimestamp: string,
  brainTimestamp: string
): number {
  return Math.max(
    0,
    parseTimestampMs(brainTimestamp, "brain_timestamp") -
      parseTimestampMs(exchangeTimestamp, "exchange_timestamp")
  );
}

export function buildHyperliquidL2BookLatencyMetrics(
  input: HyperliquidL2BookLatencyMetricsInput
): LatencyMetrics {
  return nativeHyperliquidLatencyMetrics({
    instrumentCode: input.bundle.instrumentCode,
    exchangeCode: input.bundle.exchangeCode,
    sourceExchange: input.bundle.sourceExchange,
    sourceWeight: input.bundle.sourceWeight,
    sequence: input.bundle.sequence,
    exchangeTimestamp: input.bundle.exchangeTimestamp,
    receivedAt: input.bundle.receivedAt,
    brainTimestamp: input.brainTimestamp,
    totalLatencyMs: input.totalLatencyMs,
    maxLatencyMs: input.maxLatencyMs,
    averageLatencyMs: input.averageLatencyMs,
    sampleCount: input.sampleCount,
    location: input.location
  });
}

export function buildHyperliquidL2BookTick(input: HyperliquidL2BookTickInput): MarketTick {
  return createNativeHyperliquidBookTick({
    payload: input.payload,
    coin: input.bundle.coin,
    instrumentCode: input.bundle.instrumentCode,
    exchangeCode: input.bundle.exchangeCode,
    sourceExchange: input.bundle.sourceExchange,
    sourceWeight: input.bundle.sourceWeight,
    sequence: input.bundle.sequence,
    exchangeTimestamp: input.bundle.exchangeTimestamp,
    receivedAt: input.bundle.receivedAt,
    price: input.price,
    bestBid: input.bestBid,
    bestAsk: input.bestAsk,
    rawEventType: input.rawEventType ?? "native-l2Book"
  });
}

export function buildHyperliquidL2BookTickFromBook(input: {
  readonly payload: HyperliquidRawIngestPayload;
  readonly bundle: HyperliquidL2BookSnapshotBundle;
  readonly book: Pick<InternalOrderBook, "midPrice" | "bestBid" | "bestAsk">;
  readonly rawEventType?: string;
}): MarketTick {
  return buildHyperliquidL2BookTick({
    payload: input.payload,
    bundle: input.bundle,
    price: input.book.midPrice ?? input.book.bestBid ?? input.book.bestAsk ?? 0,
    bestBid: input.book.bestBid ?? undefined,
    bestAsk: input.book.bestAsk ?? undefined,
    rawEventType: input.rawEventType
  });
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

export function evaluateHyperliquidL2BookHotPath(
  input: HyperliquidL2BookHotPathInput
): HyperliquidL2BookHotPathDecision {
  const bundle = buildHyperliquidL2BookSnapshotBundle(
    input.raw,
    input.payload,
    input.maxTimestampDriftMs,
    input.fallbackReceivedAt
  );
  const sequenceDecision = evaluateHyperliquidBookSequence(
    input.resolveExistingSync(bundle.marketKey),
    bundle.sequence,
    bundle.hasExplicitSequence,
    input.sequenceGapMs,
    bundle.receivedAt
  );

  if (sequenceDecision.status === "DUPLICATE_OR_OUT_OF_ORDER") {
    return {
      kind: "DUPLICATE_OR_OUT_OF_ORDER",
      bundle,
      result: {
        accepted: false,
        status: "DUPLICATE_OR_OUT_OF_ORDER",
        reason: "DUPLICATE_OR_OUT_OF_ORDER",
        processedCount: 0
      }
    };
  }

  if (sequenceDecision.status === "DESYNC") {
    return {
      kind: "DESYNC",
      bundle,
      sequenceDecision,
      result: {
        accepted: false,
        status: "DESYNC",
        reason: sequenceDecision.reason,
        processedCount: 0
      }
    };
  }

  const brainTimestamp = input.brainTimestamp ?? new Date().toISOString();
  const totalLatencyMs = calculateHyperliquidBookTotalLatencyMs(
    bundle.exchangeTimestamp,
    brainTimestamp
  );

  if (totalLatencyMs > input.nativeMaxLatencyMs) {
    return {
      kind: "STALE",
      bundle,
      brainTimestamp,
      totalLatencyMs,
      nativeMaxLatencyMs: input.nativeMaxLatencyMs,
      metrics: buildHyperliquidL2BookLatencyMetrics({
        bundle,
        brainTimestamp,
        totalLatencyMs,
        maxLatencyMs: input.nativeMaxLatencyMs,
        averageLatencyMs: input.averageLatencyMs,
        sampleCount: input.sampleCount,
        location: input.location
      })
    };
  }

  return {
    kind: "ACCEPTED",
    bundle,
    brainTimestamp,
    totalLatencyMs,
    nativeMaxLatencyMs: input.nativeMaxLatencyMs
  };
}

export function evaluateHyperliquidL2BookRuntime(
  input: HyperliquidL2BookRuntimeInput
): HyperliquidL2BookHotPathDecision {
  return evaluateHyperliquidL2BookHotPath({
    raw: input.raw,
    payload: input.payload,
    resolveExistingSync: input.resolveExistingSync,
    maxTimestampDriftMs: readPositiveNumber(
      input.hlBookTimestampMaxDriftMs,
      DEFAULT_HL_BOOK_TIMESTAMP_MAX_DRIFT_MS
    ),
    sequenceGapMs: readPositiveNumber(input.hlSequenceGapMs, DEFAULT_HL_SEQUENCE_GAP_MS),
    nativeMaxLatencyMs: resolveNativeHyperliquidMaxLatencyMs({
      transport: input.payload.transport,
      streamId: input.payload.streamId,
      dwellirMaxLatencyMs: input.dwellirMaxLatencyMs,
      hlStaleAfterMs: input.hlStaleAfterMs,
      currentMaxLatencyMs: input.currentMaxLatencyMs
    }),
    averageLatencyMs: input.averageLatencyMs,
    sampleCount: input.sampleCount,
    location: input.location,
    fallbackReceivedAt: input.fallbackReceivedAt,
    brainTimestamp: input.brainTimestamp
  });
}

export function hyperliquidBookDesyncLogMetadata(
  bundle: HyperliquidL2BookSnapshotBundle,
  decision: Extract<HyperliquidBookSequenceDecision, { status: "DESYNC" }>
): JsonRecord {
  return {
    instrumentCode: bundle.instrumentCode,
    exchangeCode: bundle.exchangeCode,
    source_exchange: bundle.sourceExchange,
    previousSequence: decision.previousSequence,
    sequence: decision.sequence,
    gapMs: decision.gapMs,
    maxGapMs: decision.maxGapMs
  };
}
