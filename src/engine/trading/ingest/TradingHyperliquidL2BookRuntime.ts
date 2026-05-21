import type {
  EngineState,
  Env,
  InternalOrderBook,
  JsonRecord,
  LatencyMetrics,
  MarketTick,
  OrderBookSnapshot
} from "../../../types";
import type { ExecutionTraceInput } from "../performance/LatencyRuntime";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { BookSyncState } from "../book/BookTypes";
import { markBookSyncDesynced, stateAfterDesyncedBook } from "../book/BookRuntimeState";
import {
  applyAcceptedHyperliquidL2BookSideEffects,
  applyHyperliquidL2BookDesyncSideEffects,
  applyStaleHyperliquidL2BookSideEffects,
  dispatchHyperliquidL2BookDecision,
  evaluateHyperliquidL2BookRuntime
} from "./HyperliquidL2BookIngest";
import type { HyperliquidRawIngestPayload } from "./HyperliquidRawRouting";

export interface TradingHyperliquidL2BookInput {
  readonly raw: Record<string, unknown>;
  readonly payload: HyperliquidRawIngestPayload;
  readonly wakeUpTimeMs: number | null;
  readonly hotPathStartedAt: number;
  readonly env: Pick<
    Env,
    | "DWELLIR_MAX_LATENCY_MS"
    | "HL_STALE_AFTER_MS"
    | "HL_BOOK_TIMESTAMP_MAX_DRIFT_MS"
    | "HL_SEQUENCE_GAP_MS"
  >;
  readonly maxLatencyMs: number;
  readonly engineState: Pick<EngineState, "averageLatency" | "latencySampleCount" | "location">;
  readonly tradingEnabled: boolean;
}

export interface TradingHyperliquidL2BookHandlers {
  readonly readEngineState: () => EngineState;
  readonly applyEngineState: (state: EngineState) => void;
  readonly resolveBookSync: (marketKey: string) => BookSyncState | undefined;
  readonly applyBook: (marketKey: string, book: InternalOrderBook) => void;
  readonly applySnapshot: (
    snapshot: OrderBookSnapshot,
    options?: { readonly telemetry?: boolean; readonly persist?: boolean }
  ) => Promise<InternalOrderBook>;
  readonly handleCrossedBookSnapshot: (
    book: InternalOrderBook,
    sequence: number,
    totalLatencyMs: number,
    observedAt: string
  ) => Promise<void>;
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
  readonly warnDesync: (metadata: JsonRecord) => void;
  readonly handleTick: (tick: MarketTick, wakeUpTimeMs: number | null) => Promise<TickIngestResult>;
}

export async function handleTradingHyperliquidL2Book(
  input: TradingHyperliquidL2BookInput,
  handlers: TradingHyperliquidL2BookHandlers
): Promise<TickIngestResult> {
  const l2Decision = evaluateHyperliquidL2BookRuntime({
    raw: input.raw,
    payload: input.payload,
    resolveExistingSync: handlers.resolveBookSync,
    dwellirMaxLatencyMs: input.env.DWELLIR_MAX_LATENCY_MS,
    hlStaleAfterMs: input.env.HL_STALE_AFTER_MS,
    hlBookTimestampMaxDriftMs: input.env.HL_BOOK_TIMESTAMP_MAX_DRIFT_MS,
    hlSequenceGapMs: input.env.HL_SEQUENCE_GAP_MS,
    currentMaxLatencyMs: input.maxLatencyMs,
    averageLatencyMs: input.engineState.averageLatency,
    sampleCount: input.engineState.latencySampleCount,
    location: input.engineState.location
  });

  return dispatchHyperliquidL2BookDecision(l2Decision, {
    handleDuplicateOrOutOfOrder: (decision) => decision.result,
    handleDesync: (decision) =>
      applyHyperliquidL2BookDesyncSideEffects(decision, {
        markBookDesynced: (marketKey, reason, observedAt) => {
          markBookSyncDesynced({
            syncState: handlers.resolveBookSync(marketKey),
            reason,
            observedAt
          });
        },
        warnDesync: handlers.warnDesync
      }),
    handleStale: (decision) =>
      applyStaleHyperliquidL2BookSideEffects(
        {
          decision,
          payload: input.payload,
          wakeUpTimeMs: input.wakeUpTimeMs,
          hotPathStartedAt: input.hotPathStartedAt,
          tradingEnabled: input.tradingEnabled
        },
        {
          applySnapshot: (snapshot) =>
            handlers.applySnapshot(snapshot, { telemetry: false, persist: false }),
          handleCrossedBookSnapshot: handlers.handleCrossedBookSnapshot,
          markLatencyDesyncedBook: (marketKey, book, observedAt) => {
            markLatencyDesyncedBook(
              {
                marketKey,
                book,
                observedAt
              },
              handlers
            );
          },
          quoteStateStalePull: handlers.quoteStateStalePull,
          observeExecutionProfile: handlers.observeExecutionProfile,
          schedule: handlers.schedule,
          cancelAllQuotes: handlers.cancelAllQuotes,
          publishTickTelemetry: handlers.publishTickTelemetry
        }
      ),
    handleAccepted: (decision) =>
      applyAcceptedHyperliquidL2BookSideEffects(
        {
          decision,
          payload: input.payload,
          wakeUpTimeMs: input.wakeUpTimeMs
        },
        {
          applySnapshot: (snapshot) => handlers.applySnapshot(snapshot, { persist: false }),
          handleCrossedBookSnapshot: handlers.handleCrossedBookSnapshot,
          handleTick: handlers.handleTick
        }
      )
  });
}

function markLatencyDesyncedBook(
  input: {
    readonly marketKey: string;
    readonly book: InternalOrderBook;
    readonly observedAt: string;
  },
  handlers: Pick<
    TradingHyperliquidL2BookHandlers,
    "readEngineState" | "applyEngineState" | "resolveBookSync" | "applyBook"
  >
): void {
  markBookSyncDesynced({
    syncState: handlers.resolveBookSync(input.marketKey),
    reason: "NATIVE_HL_LATENCY",
    observedAt: input.observedAt
  });
  const staleBook = stateAfterDesyncedBook({
    currentState: handlers.readEngineState(),
    book: input.book,
    reason: "NATIVE_HL_LATENCY"
  });
  handlers.applyBook(input.marketKey, staleBook.book);
  handlers.applyEngineState(staleBook.state);
}
