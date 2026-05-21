import {
  AGENT_SNAPSHOT_TICK_INTERVAL,
  DOM_WALL_HISTORY_KEY,
  ENGINE_STATE_KEY,
  ORDER_BOOK_PREFIX
} from "../../../TradingEngineConstants";
import type {
  DomAnalysisSnapshot,
  EngineState,
  InternalOrderBook,
  JsonRecord,
  LiquidityWall,
  OrderBookSnapshot,
  PriceDiscoveryMetrics
} from "../../../types";
import { calculateOrderBookPriceDiscovery } from "./BookViews";
import { countBookLevels } from "./BookReconstruction";
import { applyBookDeltaFlow, applyBookSnapshotFlow } from "./BookRuntimeState";
import type { AppliedBookUpdate, BookDeltaWithTicker } from "./BookTypes";
import type { OrderBookReconstructor } from "./OrderBookReconstructor";
import type { SortedBookSide } from "./SortedBookSide";
import {
  buildTradingDomAnalysisForTarget,
  type TradingBookViewTarget
} from "./TradingBookViewRuntime";

export interface TradingBookSnapshotOptions {
  readonly telemetry?: boolean;
  readonly persist?: boolean;
}

export interface TradingBookSnapshotInput {
  readonly snapshot: OrderBookSnapshot;
  readonly options: TradingBookSnapshotOptions;
  readonly currentState: EngineState;
  readonly domWallHistory: readonly LiquidityWall[];
  readonly reconstructor: OrderBookReconstructor;
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
}

export interface TradingBookSnapshotHandlers {
  readonly getDomSnapshot: (instrumentCode: string, observedAt: string) => DomAnalysisSnapshot;
  readonly applyState: (state: EngineState) => void;
  readonly persistStorage: (writes: Record<string, unknown>, reason: string) => Promise<void>;
  readonly logSnapshotApplied: (metadata: JsonRecord) => void;
  readonly publishSnapshotApplied: (payload: JsonRecord) => void;
}

export interface TradingBookDeltaInput {
  readonly delta: BookDeltaWithTicker;
  readonly currentState: EngineState;
  readonly updatedAt: string;
  readonly reconstructor: OrderBookReconstructor;
  readonly orderBook: Map<string, InternalOrderBook>;
}

export interface TradingBookDeltaHandlers {
  readonly applyState: (state: EngineState) => void;
}

export interface TradingBookApplicationTarget {
  engineState: EngineState;
  readonly domWallHistory: readonly LiquidityWall[];
  readonly orderBookReconstructor: OrderBookReconstructor;
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
  readonly logger: {
    info(eventType: string, message: string, metadata: JsonRecord): void;
  };
  safeStoragePut(writes: Record<string, unknown>, reason: string): Promise<void>;
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
}

export async function applyTradingBookSnapshot(
  input: TradingBookSnapshotInput,
  handlers: TradingBookSnapshotHandlers
): Promise<InternalOrderBook> {
  const updatedAt = new Date().toISOString();

  return applyBookSnapshotFlow(
    {
      snapshot: input.snapshot,
      currentState: input.currentState,
      updatedAt,
      engineStateKey: ENGINE_STATE_KEY,
      domWallHistoryKey: DOM_WALL_HISTORY_KEY,
      domWallHistory: input.domWallHistory,
      orderBookPrefix: ORDER_BOOK_PREFIX,
      telemetryEnabled: input.options.telemetry !== false,
      persist: input.options.persist !== false,
      earlyTickLimit: 5,
      telemetryInterval: AGENT_SNAPSHOT_TICK_INTERVAL
    },
    {
      applySnapshotToBook: (nextSnapshot, snapshotUpdatedAt) =>
        input.reconstructor.applySnapshot(nextSnapshot, snapshotUpdatedAt),
      getDomSnapshot: handlers.getDomSnapshot,
      countBookLevels: () => countBookLevels(input.bids, input.asks),
      calculatePriceDiscovery: (instrumentCode, snapshotUpdatedAt) =>
        calculateTradingBookPriceDiscovery(input.orderBook, instrumentCode, snapshotUpdatedAt),
      applyState: handlers.applyState,
      persistStorage: handlers.persistStorage,
      logSnapshotApplied: handlers.logSnapshotApplied,
      publishSnapshotApplied: handlers.publishSnapshotApplied
    }
  );
}

export async function applyTradingBookSnapshotForTarget(
  snapshot: OrderBookSnapshot,
  options: TradingBookSnapshotOptions,
  target: TradingBookApplicationTarget
): Promise<InternalOrderBook> {
  return applyTradingBookSnapshot(
    {
      snapshot,
      options,
      currentState: target.engineState,
      domWallHistory: target.domWallHistory,
      reconstructor: target.orderBookReconstructor,
      orderBook: target.orderBook,
      bids: target.bids,
      asks: target.asks
    },
    {
      getDomSnapshot: (instrumentCode, snapshotUpdatedAt) =>
        buildTradingDomAnalysisForTarget(
          target as unknown as TradingBookViewTarget,
          instrumentCode,
          snapshotUpdatedAt,
          undefined,
          true
        ),
      applyState: (state) => {
        target.engineState = state;
      },
      persistStorage: (writes, reason) => target.safeStoragePut(writes, reason),
      logSnapshotApplied: (metadata) => {
        target.logger.info(
          "ORDER_BOOK_SNAPSHOT_APPLIED",
          "Full order book snapshot applied",
          metadata
        );
      },
      publishSnapshotApplied: (payload) => {
        target.publish("ORDER_BOOK_SNAPSHOT_APPLIED", payload);
      }
    }
  );
}

export async function applyTradingBookDelta(
  input: TradingBookDeltaInput,
  handlers: TradingBookDeltaHandlers
): Promise<AppliedBookUpdate> {
  return applyBookDeltaFlow(
    {
      delta: input.delta,
      currentState: input.currentState,
      updatedAt: input.updatedAt
    },
    {
      applyDeltaToBook: (nextDelta, deltaUpdatedAt) =>
        input.reconstructor.applyDelta(nextDelta, deltaUpdatedAt),
      calculatePriceDiscovery: (instrumentCode, deltaUpdatedAt) =>
        calculateTradingBookPriceDiscovery(input.orderBook, instrumentCode, deltaUpdatedAt),
      applyState: handlers.applyState
    }
  );
}

export async function applyTradingBookDeltaForTarget(
  delta: BookDeltaWithTicker,
  updatedAt: string,
  target: TradingBookApplicationTarget
): Promise<AppliedBookUpdate> {
  return applyTradingBookDelta(
    {
      delta,
      currentState: target.engineState,
      updatedAt,
      reconstructor: target.orderBookReconstructor,
      orderBook: target.orderBook
    },
    {
      applyState: (state) => {
        target.engineState = state;
      }
    }
  );
}

function calculateTradingBookPriceDiscovery(
  orderBook: Map<string, InternalOrderBook>,
  instrumentCode: string,
  observedAt: string
): PriceDiscoveryMetrics {
  return calculateOrderBookPriceDiscovery(orderBook, instrumentCode, observedAt);
}
