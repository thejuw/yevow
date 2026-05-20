import type { EngineState, InternalOrderBook, LatencyMetrics, MarketTick } from "../../../types";
import { aggregateQuoteState, suspendAssetQuoteStates } from "../state/AssetStateRuntime";
import type { AppliedBookUpdate, BookSyncState } from "./BookTypes";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { ExecutionTraceInput } from "../performance/LatencyRuntime";

export interface InformationalBookNotReadyStateInput {
  readonly currentState: EngineState;
  readonly tradingEnabled: boolean;
  readonly instrumentCode: string;
  readonly maxLatencyMs: number;
  readonly observedAt: string;
}

export interface RejectedBookDeltaStateInput {
  readonly currentState: EngineState;
  readonly internalOrderBookDepth: number;
  readonly maxLatencyMs: number;
  readonly observedAt: string;
}

export interface BookEarlyReturnSideEffectInput {
  readonly state: EngineState;
  readonly storageWrites: Record<string, unknown>;
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly hotPathStartedAt: number;
}

export interface BookEarlyReturnSideEffectHandlers {
  readonly applyState: (state: EngineState) => void;
  readonly persistStorage: (
    writes: Record<string, unknown>,
    reason: "INFORMATIONAL_TICK_BOOK_NOT_READY" | "BOOK_DESYNC"
  ) => Promise<unknown>;
  readonly publishTickTelemetry: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    status: "FRESH",
    hotPathStartedAt: number
  ) => void;
}

export interface InformationalBookNotReadyFlowInput {
  readonly currentState: EngineState;
  readonly tradingEnabled: boolean;
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly maxLatencyMs: number;
  readonly wakeUpTimeMs: number | null;
  readonly orderBookUpdateMs: number;
  readonly hotPathStartedAt: number;
}

export interface InformationalBookNotReadyFlowHandlers extends BookEarlyReturnSideEffectHandlers {
  readonly observeExecutionProfile: (metrics: LatencyMetrics, trace: ExecutionTraceInput) => void;
  readonly storageWritesForState: (state: EngineState) => Record<string, unknown>;
}

export interface RejectedBookDeltaFlowInput {
  readonly currentState: EngineState;
  readonly internalOrderBookDepth: number;
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly applied: AppliedBookUpdate;
  readonly maxLatencyMs: number;
  readonly wakeUpTimeMs: number | null;
  readonly orderBookUpdateMs: number;
  readonly hotPathStartedAt: number;
}

export interface RejectedBookDeltaFlowHandlers extends BookEarlyReturnSideEffectHandlers {
  readonly observeExecutionProfile: (metrics: LatencyMetrics, trace: ExecutionTraceInput) => void;
  readonly storageWritesForState: (
    state: EngineState,
    extra?: Record<string, unknown>
  ) => Record<string, unknown>;
  readonly bookDesyncStorageExtra: (input: BookDesyncStorageInput) => Record<string, unknown>;
}

export interface BookSyncDesyncInput {
  readonly syncState: BookSyncState | undefined;
  readonly reason: string;
  readonly observedAt: string;
}

export interface DesyncedBookStateInput {
  readonly currentState: EngineState;
  readonly book: InternalOrderBook;
  readonly reason: string;
}

export interface DesyncedBookStateResult {
  readonly state: EngineState;
  readonly book: InternalOrderBook;
}

export interface BookDesyncStorageInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly reason: string;
  readonly expectedSequence?: number;
  readonly actualSequence?: number;
}

export function stateAfterInformationalBookNotReady(
  input: InformationalBookNotReadyStateInput
): EngineState {
  const assetQuoteStates = input.tradingEnabled
    ? suspendAssetQuoteStates(
        input.currentState.assetQuoteStates,
        "ORDER_BOOK_NOT_READY",
        input.observedAt,
        {
          instrumentCode: input.instrumentCode,
          lastQuote: input.currentState.quoteState.lastQuote
        }
      )
    : input.currentState.assetQuoteStates;

  return {
    ...input.currentState,
    processedTicks: input.currentState.processedTicks + 1,
    quoteState: input.tradingEnabled
      ? aggregateQuoteState(assetQuoteStates, input.currentState.quoteState, input.observedAt)
      : input.currentState.quoteState,
    assetQuoteStates,
    maxLatencyMs: input.maxLatencyMs,
    heartbeatAt: input.observedAt,
    updatedAt: input.observedAt
  };
}

export function stateAfterRejectedBookDelta(input: RejectedBookDeltaStateInput): EngineState {
  return {
    ...input.currentState,
    processedTicks: input.currentState.processedTicks + 1,
    internalOrderBookDepth: input.internalOrderBookDepth,
    maxLatencyMs: input.maxLatencyMs,
    heartbeatAt: input.observedAt,
    updatedAt: input.observedAt
  };
}

export async function applyInformationalBookNotReadySideEffects(
  input: BookEarlyReturnSideEffectInput,
  handlers: BookEarlyReturnSideEffectHandlers
): Promise<void> {
  handlers.applyState(input.state);
  await handlers.persistStorage(input.storageWrites, "INFORMATIONAL_TICK_BOOK_NOT_READY");
  handlers.publishTickTelemetry(input.tick, input.metrics, "FRESH", input.hotPathStartedAt);
}

export async function applyRejectedBookDeltaSideEffects(
  input: BookEarlyReturnSideEffectInput,
  handlers: BookEarlyReturnSideEffectHandlers
): Promise<void> {
  handlers.applyState(input.state);
  await handlers.persistStorage(input.storageWrites, "BOOK_DESYNC");
  handlers.publishTickTelemetry(input.tick, input.metrics, "FRESH", input.hotPathStartedAt);
}

export async function applyInformationalBookNotReadyFlow(
  input: InformationalBookNotReadyFlowInput,
  handlers: InformationalBookNotReadyFlowHandlers
): Promise<TickIngestResult> {
  handlers.observeExecutionProfile(input.metrics, {
    wakeUpTimeMs: input.wakeUpTimeMs,
    orderBookUpdateMs: input.orderBookUpdateMs,
    agentLogicMs: null,
    hotPathStartedAt: input.hotPathStartedAt,
    observedAt: input.metrics.brainTimestamp
  });

  const nextState = stateAfterInformationalBookNotReady({
    currentState: input.currentState,
    tradingEnabled: input.tradingEnabled,
    instrumentCode: input.tick.instrumentCode,
    maxLatencyMs: input.maxLatencyMs,
    observedAt: input.metrics.brainTimestamp
  });

  await applyInformationalBookNotReadySideEffects(
    {
      state: nextState,
      storageWrites: handlers.storageWritesForState(nextState),
      tick: input.tick,
      metrics: input.metrics,
      hotPathStartedAt: input.hotPathStartedAt
    },
    handlers
  );

  return {
    accepted: false,
    status: "BOOK_NOT_READY",
    reason: "INFORMATIONAL_TICK_WITHOUT_BOOK",
    metrics: input.metrics
  };
}

export async function applyRejectedBookDeltaFlow(
  input: RejectedBookDeltaFlowInput,
  handlers: RejectedBookDeltaFlowHandlers
): Promise<TickIngestResult> {
  handlers.observeExecutionProfile(input.metrics, {
    wakeUpTimeMs: input.wakeUpTimeMs,
    orderBookUpdateMs: input.orderBookUpdateMs,
    agentLogicMs: null,
    hotPathStartedAt: input.hotPathStartedAt,
    observedAt: input.metrics.brainTimestamp
  });

  if (input.applied.reason === "DUPLICATE_OR_OUT_OF_ORDER") {
    return rejectedBookDeltaIngestResult({ applied: input.applied, metrics: input.metrics });
  }

  const nextState = stateAfterRejectedBookDelta({
    currentState: input.currentState,
    internalOrderBookDepth: input.internalOrderBookDepth,
    maxLatencyMs: input.maxLatencyMs,
    observedAt: input.metrics.brainTimestamp
  });

  await applyRejectedBookDeltaSideEffects(
    {
      state: nextState,
      storageWrites: handlers.storageWritesForState(
        nextState,
        handlers.bookDesyncStorageExtra({
          tick: input.tick,
          metrics: input.metrics,
          reason: input.applied.reason ?? "BOOK_UPDATE_REJECTED",
          expectedSequence: input.applied.expectedSequence,
          actualSequence: input.applied.actualSequence
        })
      ),
      tick: input.tick,
      metrics: input.metrics,
      hotPathStartedAt: input.hotPathStartedAt
    },
    handlers
  );

  return rejectedBookDeltaIngestResult({ applied: input.applied, metrics: input.metrics });
}

export function rejectedBookDeltaIngestResult(input: {
  readonly applied: AppliedBookUpdate;
  readonly metrics: LatencyMetrics;
}): TickIngestResult {
  return {
    accepted: false,
    status:
      input.applied.reason === "SEQUENCE_GAP" || input.applied.reason === "CROSSED_BOOK"
        ? "DESYNC"
        : "DUPLICATE_OR_OUT_OF_ORDER",
    reason: input.applied.reason,
    metrics: input.metrics
  };
}

export function markBookSyncDesynced(input: BookSyncDesyncInput): void {
  if (!input.syncState) {
    return;
  }

  input.syncState.isSynced = false;
  input.syncState.desyncReason = input.reason;
  input.syncState.lastDesyncAt = input.observedAt;
}

export function stateAfterDesyncedBook(input: DesyncedBookStateInput): DesyncedBookStateResult {
  const book: InternalOrderBook = {
    ...input.book,
    isSynced: false,
    desyncReason: input.reason
  };

  return {
    book,
    state: {
      ...input.currentState,
      microstructure: {
        ...input.currentState.microstructure,
        isSynced: false
      }
    }
  };
}

export function bookDesyncStorageExtra(input: BookDesyncStorageInput): Record<string, unknown> {
  return {
    [`bookDesync:${input.tick.source_exchange}:${input.tick.instrumentCode}:${input.tick.sequence}`]:
      {
        tick: input.tick,
        metrics: input.metrics,
        reason: input.reason,
        expectedSequence: input.expectedSequence,
        actualSequence: input.actualSequence
      }
  };
}
