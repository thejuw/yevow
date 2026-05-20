import { isCrossedBook } from "../book/BookReconstruction";
import { createNativeHyperliquidBookTick } from "../helpers/NativeHyperliquidRuntime";
import type { ExecutionTraceInput } from "../performance/LatencyRuntime";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { HyperliquidRawIngestPayload } from "./HyperliquidRawRouting";
import type {
  HyperliquidBookSequenceDecision,
  HyperliquidL2BookHotPathDecision,
  HyperliquidL2BookSnapshotBundle
} from "./HyperliquidL2BookIngest";
import type {
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
