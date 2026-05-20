import type {
  DomAnalysisSnapshot,
  EngineState,
  InternalOrderBook,
  JsonRecord,
  OrderBookSnapshot,
  PriceDiscoveryMetrics
} from "../../../types";
import { microstructureFromBook } from "./BookReconstruction";
import type { AppliedBookSnapshot } from "./OrderBookReconstructor";

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

export interface BookSnapshotFlowInput {
  readonly snapshot: OrderBookSnapshot;
  readonly currentState: EngineState;
  readonly updatedAt: string;
  readonly engineStateKey: string;
  readonly domWallHistoryKey: string;
  readonly domWallHistory: unknown;
  readonly orderBookPrefix: string;
  readonly telemetryEnabled: boolean;
  readonly persist: boolean;
  readonly earlyTickLimit: number;
  readonly telemetryInterval: number;
}

export interface BookSnapshotFlowHandlers extends BookSnapshotSideEffectHandlers {
  readonly applySnapshotToBook: (
    snapshot: OrderBookSnapshot,
    updatedAt: string
  ) => AppliedBookSnapshot;
  readonly getDomSnapshot: (instrumentCode: string, updatedAt: string) => DomAnalysisSnapshot;
  readonly countBookLevels: () => number;
  readonly calculatePriceDiscovery: (
    instrumentCode: string,
    updatedAt: string
  ) => PriceDiscoveryMetrics;
  readonly applyState: (state: EngineState) => void;
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

export async function applyBookSnapshotFlow(
  input: BookSnapshotFlowInput,
  handlers: BookSnapshotFlowHandlers
): Promise<InternalOrderBook> {
  const applied = handlers.applySnapshotToBook(input.snapshot, input.updatedAt);
  const domSnapshot = handlers.getDomSnapshot(applied.instrumentCode, input.updatedAt);
  const artifacts = bookSnapshotRuntimeArtifacts({
    currentState: input.currentState,
    book: applied.book,
    internalOrderBookDepth: handlers.countBookLevels(),
    priceDiscovery: handlers.calculatePriceDiscovery(applied.instrumentCode, input.updatedAt),
    dom: domSnapshot,
    updatedAt: input.updatedAt,
    engineStateKey: input.engineStateKey,
    domWallHistoryKey: input.domWallHistoryKey,
    domWallHistory: input.domWallHistory,
    orderBookPrefix: input.orderBookPrefix,
    marketKey: applied.marketKey,
    telemetryEnabled: input.telemetryEnabled,
    snapshotSource: input.snapshot.source,
    processedTicks: input.currentState.processedTicks,
    earlyTickLimit: input.earlyTickLimit,
    telemetryInterval: input.telemetryInterval,
    applied
  });

  handlers.applyState(artifacts.state);
  await applyBookSnapshotSideEffects(artifacts, { persist: input.persist }, handlers);

  return applied.book;
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
