import type {
  DomAnalysisSnapshot,
  EngineState,
  InternalOrderBook,
  MicrostructureMetrics,
  PriceDiscoveryMetrics
} from "../../../types";
import {
  aggregateQuoteState,
  defaultMicrostructure,
  defaultPriceDiscovery,
  suspendAssetQuoteStates
} from "../../../TradingEngineRuntimeHelpers";
import { microstructureFromBook } from "./BookReconstruction";

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
