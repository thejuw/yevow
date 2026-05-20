import { buildMarketKey } from "../book/BookRuntimeHelpers";
import {
  DEFAULT_HL_BOOK_TIMESTAMP_MAX_DRIFT_MS,
  DEFAULT_HL_SEQUENCE_GAP_MS
} from "../../../TradingEngineConstants";
import {
  createNativeHyperliquidBookTick,
  hyperliquidNativeInstrumentCode,
  nativeHyperliquidLatencyMetrics,
  nativeExchangeTimestamp,
  nativeIso,
  nativeObject,
  nativeSequence,
  normalizeSourceExchange,
  normalizeSourceWeight,
  parseHyperliquidNativeLevels,
  requireNativeString
} from "../helpers/NativeHyperliquidRuntime";
import { parseTimestampMs } from "../helpers/RuntimeClock";
import { readPositiveNumber } from "../helpers/RuntimeParsing";
import { resolveNativeHyperliquidMaxLatencyMs } from "../performance/LatencyRuntime";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { BookSyncState } from "../book/BookTypes";
import { isCrossedBook } from "../book/BookReconstruction";
import type { ExecutionTraceInput } from "../performance/LatencyRuntime";
import type { HyperliquidRawIngestPayload } from "./HyperliquidRawRouting";
import type {
  EngineLocation,
  InternalOrderBook,
  JsonRecord,
  LatencyMetrics,
  MarketTick,
  OrderBookSnapshot
} from "../../../types";

export interface HyperliquidL2BookDecisionHandlers {
  readonly handleDuplicateOrOutOfOrder: (
    decision: Extract<HyperliquidL2BookHotPathDecision, { kind: "DUPLICATE_OR_OUT_OF_ORDER" }>
  ) => Promise<TickIngestResult> | TickIngestResult;
  readonly handleDesync: (
    decision: Extract<HyperliquidL2BookHotPathDecision, { kind: "DESYNC" }>
  ) => Promise<TickIngestResult> | TickIngestResult;
  readonly handleStale: (
    decision: Extract<HyperliquidL2BookHotPathDecision, { kind: "STALE" }>
  ) => Promise<TickIngestResult>;
  readonly handleAccepted: (
    decision: Extract<HyperliquidL2BookHotPathDecision, { kind: "ACCEPTED" }>
  ) => Promise<TickIngestResult>;
}

export async function dispatchHyperliquidL2BookDecision(
  decision: HyperliquidL2BookHotPathDecision,
  handlers: HyperliquidL2BookDecisionHandlers
): Promise<TickIngestResult> {
  if (decision.kind === "DUPLICATE_OR_OUT_OF_ORDER") {
    return handlers.handleDuplicateOrOutOfOrder(decision);
  }

  if (decision.kind === "DESYNC") {
    return handlers.handleDesync(decision);
  }

  if (decision.kind === "STALE") {
    return handlers.handleStale(decision);
  }

  return handlers.handleAccepted(decision);
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

export interface StaleHyperliquidL2BookSideEffectsInput {
  readonly decision: Extract<HyperliquidL2BookHotPathDecision, { kind: "STALE" }>;
  readonly payload: HyperliquidRawIngestPayload;
  readonly wakeUpTimeMs: number | null;
  readonly hotPathStartedAt: number;
  readonly tradingEnabled: boolean;
}

export interface StaleHyperliquidL2BookSideEffectHandlers {
  readonly applySnapshot: (snapshot: OrderBookSnapshot) => Promise<InternalOrderBook | undefined>;
  readonly handleCrossedBookSnapshot: (
    book: InternalOrderBook,
    sequence: number,
    totalLatencyMs: number,
    observedAt: string
  ) => Promise<void>;
  readonly markLatencyDesyncedBook: (
    marketKey: string,
    book: InternalOrderBook,
    observedAt: string
  ) => void;
  readonly quoteStateStalePull: (
    instrumentCode: string,
    sequence: number,
    metrics: LatencyMetrics,
    observedAt: string
  ) => void;
  readonly observeExecutionProfile: (metrics: LatencyMetrics, trace: ExecutionTraceInput) => void;
  readonly schedule: (work: Promise<unknown>) => void;
  readonly cancelAllQuotes: (instrumentCode: string, reason: string) => Promise<unknown>;
  readonly publishTickTelemetry: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    status: LatencyMetrics["status"],
    hotPathStartedAt: number
  ) => void;
}

export interface AcceptedHyperliquidL2BookSideEffectsInput {
  readonly decision: Extract<HyperliquidL2BookHotPathDecision, { kind: "ACCEPTED" }>;
  readonly payload: HyperliquidRawIngestPayload;
  readonly wakeUpTimeMs: number | null;
}

export interface AcceptedHyperliquidL2BookSideEffectHandlers {
  readonly applySnapshot: (snapshot: OrderBookSnapshot) => Promise<InternalOrderBook>;
  readonly handleCrossedBookSnapshot: (
    book: InternalOrderBook,
    sequence: number,
    totalLatencyMs: number,
    observedAt: string
  ) => Promise<void>;
  readonly handleTick: (tick: MarketTick, wakeUpTimeMs: number | null) => Promise<TickIngestResult>;
}

export interface HyperliquidL2BookDesyncSideEffectHandlers {
  readonly markBookDesynced: (marketKey: string, reason: string, observedAt: string) => void;
  readonly warnDesync: (metadata: JsonRecord) => void;
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

export async function applyStaleHyperliquidL2BookSideEffects(
  input: StaleHyperliquidL2BookSideEffectsInput,
  handlers: StaleHyperliquidL2BookSideEffectHandlers
): Promise<TickIngestResult> {
  const { instrumentCode, sequence, snapshot } = input.decision.bundle;
  const { brainTimestamp, totalLatencyMs, metrics } = input.decision;
  const book =
    snapshot.bids.length > 0 || snapshot.asks.length > 0
      ? await handlers.applySnapshot(snapshot)
      : undefined;

  if (book) {
    if (isCrossedBook(book)) {
      await handlers.handleCrossedBookSnapshot(book, sequence, totalLatencyMs, brainTimestamp);
    } else {
      handlers.markLatencyDesyncedBook(input.decision.bundle.marketKey, book, brainTimestamp);
    }
  }

  handlers.quoteStateStalePull(instrumentCode, sequence, metrics, brainTimestamp);
  handlers.observeExecutionProfile(metrics, {
    wakeUpTimeMs: input.wakeUpTimeMs,
    orderBookUpdateMs: null,
    agentLogicMs: null,
    hotPathStartedAt: input.hotPathStartedAt,
    observedAt: brainTimestamp
  });

  if (input.tradingEnabled) {
    handlers.schedule(handlers.cancelAllQuotes(instrumentCode, "NATIVE_HL_LATENCY"));
  }

  handlers.publishTickTelemetry(
    buildHyperliquidL2BookTick({
      payload: input.payload,
      bundle: input.decision.bundle,
      price: 0,
      bestBid: undefined,
      bestAsk: undefined,
      rawEventType: "native-l2Book"
    }),
    metrics,
    "STALE",
    input.hotPathStartedAt
  );

  return {
    accepted: false,
    status: "STALE",
    reason: "NATIVE_HL_LATENCY_EXCEEDED",
    metrics,
    book,
    processedCount: 0
  };
}

export async function applyAcceptedHyperliquidL2BookSideEffects(
  input: AcceptedHyperliquidL2BookSideEffectsInput,
  handlers: AcceptedHyperliquidL2BookSideEffectHandlers
): Promise<TickIngestResult> {
  const { sequence, snapshot } = input.decision.bundle;
  const { brainTimestamp, totalLatencyMs } = input.decision;
  const book = await handlers.applySnapshot(snapshot);

  if (isCrossedBook(book)) {
    await handlers.handleCrossedBookSnapshot(book, sequence, totalLatencyMs, brainTimestamp);
    return {
      accepted: false,
      status: "DESYNC",
      reason: "CROSSED_BOOK",
      book,
      processedCount: 0
    };
  }

  const representativeTick = buildHyperliquidL2BookTickFromBook({
    payload: input.payload,
    bundle: input.decision.bundle,
    book,
    rawEventType: "native-l2Book"
  });
  const result = await handlers.handleTick(representativeTick, input.wakeUpTimeMs);

  return {
    ...result,
    book,
    processedCount: 1
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

export function applyHyperliquidL2BookDesyncSideEffects(
  decision: Extract<HyperliquidL2BookHotPathDecision, { kind: "DESYNC" }>,
  handlers: HyperliquidL2BookDesyncSideEffectHandlers
): TickIngestResult {
  handlers.markBookDesynced(
    decision.bundle.marketKey,
    decision.sequenceDecision.reason,
    decision.sequenceDecision.lastDesyncAt
  );
  handlers.warnDesync(hyperliquidBookDesyncLogMetadata(decision.bundle, decision.sequenceDecision));

  return decision.result;
}
