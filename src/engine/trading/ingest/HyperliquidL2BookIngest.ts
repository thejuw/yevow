import { buildMarketKey } from "../book/BookRuntimeHelpers";
import {
  DEFAULT_HL_BOOK_TIMESTAMP_MAX_DRIFT_MS,
  DEFAULT_HL_SEQUENCE_GAP_MS
} from "../../../TradingEngineConstants";
import {
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
import { resolveNativeHyperliquidMaxLatencyMs } from "../performance/LatencyTickRuntime";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { BookSyncState } from "../book/BookTypes";
import type { HyperliquidRawIngestPayload } from "./HyperliquidRawRouting";
import type { EngineLocation, LatencyMetrics, OrderBookSnapshot } from "../../../types";
export {
  applyAcceptedHyperliquidL2BookSideEffects,
  applyHyperliquidL2BookDesyncSideEffects,
  applyStaleHyperliquidL2BookSideEffects,
  buildHyperliquidL2BookTick,
  buildHyperliquidL2BookTickFromBook,
  dispatchHyperliquidL2BookDecision,
  hyperliquidBookDesyncLogMetadata,
  type AcceptedHyperliquidL2BookSideEffectHandlers,
  type AcceptedHyperliquidL2BookSideEffectsInput,
  type HyperliquidL2BookDecisionHandlers,
  type HyperliquidL2BookDesyncSideEffectHandlers,
  type HyperliquidL2BookTickInput,
  type StaleHyperliquidL2BookSideEffectHandlers,
  type StaleHyperliquidL2BookSideEffectsInput
} from "./HyperliquidL2BookSideEffects";

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
