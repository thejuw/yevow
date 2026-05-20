import type {
  EngineState,
  InternalOrderBook,
  MicrostructureMetrics,
  PriceDiscoveryMetrics
} from "../../../types";
import { defaultMicrostructure, defaultPriceDiscovery } from "../state/MarketStateDefaults";
import type { AppliedBookUpdate, BookDeltaWithTicker } from "./BookTypes";
import { microstructureFromBook } from "./BookReconstruction";
export {
  applyBookSnapshotFlow,
  applyBookSnapshotSideEffects,
  bookSnapshotRuntimeArtifacts,
  bookSnapshotStorageWrites,
  bookSnapshotTelemetry,
  shouldEmitBookSnapshotTelemetry,
  stateAfterBookSnapshot,
  type BookSnapshotFlowHandlers,
  type BookSnapshotFlowInput,
  type BookSnapshotRuntimeArtifacts,
  type BookSnapshotRuntimeArtifactsInput,
  type BookSnapshotSideEffectHandlers,
  type BookSnapshotSideEffectOptions,
  type BookSnapshotStateInput,
  type BookSnapshotStorageInput
} from "./BookSnapshotRuntime";
export {
  applyInformationalBookNotReadyFlow,
  applyInformationalBookNotReadySideEffects,
  applyRejectedBookDeltaFlow,
  applyRejectedBookDeltaSideEffects,
  bookDesyncStorageExtra,
  markBookSyncDesynced,
  rejectedBookDeltaIngestResult,
  stateAfterDesyncedBook,
  stateAfterInformationalBookNotReady,
  stateAfterRejectedBookDelta,
  type BookDesyncStorageInput,
  type BookEarlyReturnSideEffectHandlers,
  type BookEarlyReturnSideEffectInput,
  type BookSyncDesyncInput,
  type DesyncedBookStateInput,
  type DesyncedBookStateResult,
  type InformationalBookNotReadyFlowHandlers,
  type InformationalBookNotReadyFlowInput,
  type InformationalBookNotReadyStateInput,
  type RejectedBookDeltaFlowHandlers,
  type RejectedBookDeltaFlowInput,
  type RejectedBookDeltaStateInput
} from "./BookEarlyReturnRuntime";

export interface BookResetStateInput {
  readonly currentState: EngineState;
  readonly resetMarketKey: string | null;
  readonly resetInstrument: string | null;
  readonly orderBookSize: number;
  readonly internalOrderBookDepth: number;
  readonly now: string;
  readonly priceDiscovery: PriceDiscoveryMetrics | null;
}

export interface BookDeltaStateInput {
  readonly currentState: EngineState;
  readonly book: InternalOrderBook;
  readonly priceDiscovery: PriceDiscoveryMetrics;
}

export interface BookDeltaFlowInput {
  readonly delta: BookDeltaWithTicker;
  readonly currentState: EngineState;
  readonly updatedAt: string;
}

export interface BookDeltaFlowHandlers {
  readonly applyDeltaToBook: (
    delta: BookDeltaWithTicker,
    updatedAt: string
  ) => Promise<AppliedBookUpdate>;
  readonly calculatePriceDiscovery: (
    instrumentCode: string,
    updatedAt: string
  ) => PriceDiscoveryMetrics;
  readonly applyState: (state: EngineState) => void;
}

export interface RebuiltBookStateInput {
  readonly currentState: EngineState;
  readonly microstructure: MicrostructureMetrics;
  readonly priceDiscovery: PriceDiscoveryMetrics;
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

export function stateAfterAcceptedBookDelta(input: BookDeltaStateInput): EngineState {
  return {
    ...input.currentState,
    microstructure: microstructureFromBook(input.book),
    priceDiscovery: input.priceDiscovery
  };
}

export async function applyBookDeltaFlow(
  input: BookDeltaFlowInput,
  handlers: BookDeltaFlowHandlers
): Promise<AppliedBookUpdate> {
  const applied = await handlers.applyDeltaToBook(input.delta, input.updatedAt);

  if (applied.accepted && applied.book) {
    handlers.applyState(
      stateAfterAcceptedBookDelta({
        currentState: input.currentState,
        book: applied.book,
        priceDiscovery: handlers.calculatePriceDiscovery(
          applied.book.instrumentCode,
          input.updatedAt
        )
      })
    );
  }

  return applied;
}

export function stateAfterRebuiltBookSnapshot(input: RebuiltBookStateInput): EngineState {
  return {
    ...input.currentState,
    microstructure: input.microstructure,
    priceDiscovery: input.priceDiscovery
  };
}
