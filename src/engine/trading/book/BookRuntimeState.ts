import type {
  DomAnalysisSnapshot,
  EngineState,
  InternalOrderBook,
  JsonRecord,
  LatencyMetrics,
  MarketTick,
  MicrostructureMetrics,
  PriceDiscoveryMetrics
} from "../../../types";
import { aggregateQuoteState, suspendAssetQuoteStates } from "../state/AssetStateRuntime";
import { defaultMicrostructure, defaultPriceDiscovery } from "../state/EngineStateDefaults";
import type { AppliedBookUpdate, BookSyncState } from "./BookTypes";
import { microstructureFromBook } from "./BookReconstruction";
import type { AppliedBookSnapshot } from "./OrderBookReconstructor";
import type { TickIngestResult } from "../TradingEngineRouteTypes";

export interface BookResetStateInput {
  readonly currentState: EngineState;
  readonly resetMarketKey: string | null;
  readonly resetInstrument: string | null;
  readonly orderBookSize: number;
  readonly internalOrderBookDepth: number;
  readonly now: string;
  readonly priceDiscovery: PriceDiscoveryMetrics | null;
}

export interface BookSnapshotStateInput {
  readonly currentState: EngineState;
  readonly book: InternalOrderBook;
  readonly internalOrderBookDepth: number;
  readonly priceDiscovery: PriceDiscoveryMetrics;
  readonly dom: DomAnalysisSnapshot;
  readonly updatedAt: string;
}

export interface BookSnapshotStorageInput {
  readonly engineStateKey: string;
  readonly state: EngineState;
  readonly domWallHistoryKey: string;
  readonly domWallHistory: unknown;
  readonly orderBookPrefix: string;
  readonly marketKey: string;
  readonly book: InternalOrderBook;
}

export interface BookSnapshotRuntimeArtifactsInput extends BookSnapshotStateInput {
  readonly engineStateKey: string;
  readonly domWallHistoryKey: string;
  readonly domWallHistory: unknown;
  readonly orderBookPrefix: string;
  readonly marketKey: string;
  readonly telemetryEnabled: boolean;
  readonly snapshotSource: string;
  readonly processedTicks: number;
  readonly earlyTickLimit: number;
  readonly telemetryInterval: number;
  readonly applied: Pick<
    AppliedBookSnapshot,
    | "instrumentCode"
    | "exchangeCode"
    | "sequence"
    | "bidLevels"
    | "askLevels"
    | "tickSize"
    | "timeToBookMs"
  >;
}

export interface BookSnapshotRuntimeArtifacts {
  readonly state: EngineState;
  readonly storageWrites: Record<string, unknown>;
  readonly shouldEmitTelemetry: boolean;
  readonly telemetry: JsonRecord;
}

export interface BookSnapshotSideEffectOptions {
  readonly persist: boolean;
}

export interface BookSnapshotSideEffectHandlers {
  readonly persistStorage: (
    writes: Record<string, unknown>,
    reason: "ORDER_BOOK_SNAPSHOT_APPLIED"
  ) => Promise<unknown>;
  readonly logSnapshotApplied: (metadata: JsonRecord) => void;
  readonly publishSnapshotApplied: (payload: JsonRecord) => void;
}

export interface BookDeltaStateInput {
  readonly currentState: EngineState;
  readonly book: InternalOrderBook;
  readonly priceDiscovery: PriceDiscoveryMetrics;
}

export interface RebuiltBookStateInput {
  readonly currentState: EngineState;
  readonly microstructure: MicrostructureMetrics;
  readonly priceDiscovery: PriceDiscoveryMetrics;
}

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

export function stateAfterOrderBookReset(input: BookResetStateInput): EngineState {
  const nextMicrostructure =
    input.resetMarketKey &&
    input.currentState.microstructure.marketKey !== input.resetMarketKey &&
    input.orderBookSize > 0
      ? input.currentState.microstructure
      : defaultMicrostructure();

  return {
    ...input.currentState,
    internalOrderBookDepth: input.internalOrderBookDepth,
    microstructure: nextMicrostructure,
    priceDiscovery:
      input.resetInstrument && input.priceDiscovery
        ? input.priceDiscovery
        : defaultPriceDiscovery(),
    dom: null,
    heartbeatAt: input.now,
    updatedAt: input.now
  };
}

export function stateAfterBookSnapshot(input: BookSnapshotStateInput): EngineState {
  return {
    ...input.currentState,
    internalOrderBookDepth: input.internalOrderBookDepth,
    microstructure: microstructureFromBook(input.book),
    priceDiscovery: input.priceDiscovery,
    dom: input.dom,
    heartbeatAt: input.updatedAt,
    updatedAt: input.updatedAt
  };
}

export function bookSnapshotStorageWrites(
  input: BookSnapshotStorageInput
): Record<string, unknown> {
  return {
    [input.engineStateKey]: input.state,
    [input.domWallHistoryKey]: input.domWallHistory,
    [`${input.orderBookPrefix}${input.marketKey}`]: input.book
  };
}

export function bookSnapshotRuntimeArtifacts(
  input: BookSnapshotRuntimeArtifactsInput
): BookSnapshotRuntimeArtifacts {
  const state = stateAfterBookSnapshot(input);
  const shouldEmitTelemetry = shouldEmitBookSnapshotTelemetry({
    telemetryEnabled: input.telemetryEnabled,
    snapshotSource: input.snapshotSource,
    processedTicks: input.processedTicks,
    earlyTickLimit: input.earlyTickLimit,
    interval: input.telemetryInterval
  });

  return {
    state,
    storageWrites: bookSnapshotStorageWrites({
      engineStateKey: input.engineStateKey,
      state,
      domWallHistoryKey: input.domWallHistoryKey,
      domWallHistory: input.domWallHistory,
      orderBookPrefix: input.orderBookPrefix,
      marketKey: input.marketKey,
      book: input.book
    }),
    shouldEmitTelemetry,
    telemetry: bookSnapshotTelemetry(input.applied)
  };
}

export async function applyBookSnapshotSideEffects(
  artifacts: BookSnapshotRuntimeArtifacts,
  options: BookSnapshotSideEffectOptions,
  handlers: BookSnapshotSideEffectHandlers
): Promise<void> {
  if (options.persist) {
    await handlers.persistStorage(artifacts.storageWrites, "ORDER_BOOK_SNAPSHOT_APPLIED");
  }

  if (artifacts.shouldEmitTelemetry) {
    handlers.logSnapshotApplied(artifacts.telemetry);
    handlers.publishSnapshotApplied(artifacts.telemetry);
  }
}

export function stateAfterAcceptedBookDelta(input: BookDeltaStateInput): EngineState {
  return {
    ...input.currentState,
    microstructure: microstructureFromBook(input.book),
    priceDiscovery: input.priceDiscovery
  };
}

export function stateAfterRebuiltBookSnapshot(input: RebuiltBookStateInput): EngineState {
  return {
    ...input.currentState,
    microstructure: input.microstructure,
    priceDiscovery: input.priceDiscovery
  };
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

export function shouldEmitBookSnapshotTelemetry(input: {
  readonly telemetryEnabled: boolean;
  readonly snapshotSource: string;
  readonly processedTicks: number;
  readonly earlyTickLimit: number;
  readonly interval: number;
}): boolean {
  if (!input.telemetryEnabled) {
    return false;
  }

  return (
    input.snapshotSource === "ADMIN" ||
    input.processedTicks <= input.earlyTickLimit ||
    input.processedTicks % input.interval === 0
  );
}

export function bookSnapshotTelemetry(
  applied: Pick<
    AppliedBookSnapshot,
    | "instrumentCode"
    | "exchangeCode"
    | "sequence"
    | "bidLevels"
    | "askLevels"
    | "tickSize"
    | "timeToBookMs"
  >
): JsonRecord {
  return {
    instrumentCode: applied.instrumentCode,
    exchangeCode: applied.exchangeCode,
    sequence: applied.sequence,
    bidLevels: applied.bidLevels,
    askLevels: applied.askLevels,
    tickSize: applied.tickSize,
    timeToBookMs: applied.timeToBookMs
  };
}
