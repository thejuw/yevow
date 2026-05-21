import { ENGINE_STATE_KEY, ORDER_BOOK_PREFIX } from "../../../TradingEngineConstants";
import { normalizeSourceExchange } from "../helpers/NativeMarketIdentityRuntime";
import { buildMarketKey } from "./BookRuntimeHelpers";
import type {
  EngineState,
  InternalOrderBook,
  JsonRecord,
  OrderBookResetRequest,
  PriceDiscoveryMetrics
} from "../../../types";
import { calculateOrderBookPriceDiscovery } from "./BookViews";
import { countBookLevels } from "./BookReconstruction";
import type { BookSyncState } from "./BookTypes";
import type { SortedBookSide } from "./SortedBookSide";
import { stateAfterOrderBookReset } from "./BookRuntimeState";
import {
  resetTradingLatencyBaselineForTarget,
  type TradingLatencyStateTarget
} from "../performance/TradingLatencyStateRuntime";

export interface ResolvedOrderBookReset {
  readonly now: string;
  readonly reason: string;
  readonly source: OrderBookResetRequest["source"];
  readonly blackoutDurationMs: number | null;
  readonly resetInstrument: string | null;
  readonly resetSourceExchange: string | null;
  readonly resetStreamId: string | null;
  readonly resetMarketKey: string | null;
  readonly recoveredAt: string;
  readonly connectionId: string | null;
}

export interface OrderBookResetStores {
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
  readonly sync: Map<string, BookSyncState>;
}

export interface OrderBookResetRuntimeInput {
  readonly reset: ResolvedOrderBookReset;
  readonly currentState: EngineState;
  readonly persistedBooks: Map<string, InternalOrderBook>;
  readonly orderBookPrefix: string;
  readonly engineStateKey: string;
  readonly stores: OrderBookResetStores;
  readonly orderBookSize: number;
  readonly internalOrderBookDepth: number;
  readonly priceDiscovery: PriceDiscoveryMetrics | null;
}

export interface OrderBookResetRuntimeArtifacts {
  readonly state: EngineState;
  readonly deleteKeys: string[];
  readonly connectionKeys: string[];
  readonly writes: Record<string, unknown>;
  readonly telemetry: JsonRecord;
  readonly latencyResetReason: string | null;
}

export interface OrderBookResetSideEffectHandlers {
  readonly resetLatencyBaseline: (observedAt: string, reason: string) => void;
  readonly applyConnectionIds: (
    connectionId: string | null,
    connectionKeys: readonly string[]
  ) => void;
  readonly persistWrites: (writes: Record<string, unknown>) => Promise<void>;
  readonly deleteStorageKeys: (keys: readonly string[]) => Promise<void>;
  readonly logReset: (telemetry: JsonRecord) => void;
  readonly publishReset: (telemetry: JsonRecord) => void;
}

export interface OrderBookResetFlowInput {
  readonly payload: Partial<OrderBookResetRequest>;
  readonly currentState: EngineState;
  readonly orderBookPrefix: string;
  readonly engineStateKey: string;
  readonly stores: OrderBookResetStores;
  readonly orderBookSize: number;
  readonly internalOrderBookDepth: number;
}

export interface OrderBookResetFlowHandlers extends OrderBookResetSideEffectHandlers {
  readonly listPersistedBooks: (prefix: string) => Promise<Map<string, InternalOrderBook>>;
  readonly handleListFailure: (error: unknown) => void;
  readonly calculatePriceDiscovery: (
    instrumentCode: string,
    observedAt: string
  ) => PriceDiscoveryMetrics;
  readonly applyState: (state: EngineState) => void;
}

export interface TradingOrderBookResetInput {
  readonly payload: Partial<OrderBookResetRequest>;
  readonly currentState: EngineState;
  readonly stores: OrderBookResetStores;
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly activeIngestConnections: Map<string, string>;
}

export interface TradingOrderBookResetHandlers {
  readonly listPersistedBooks: (prefix: string) => Promise<Map<string, InternalOrderBook>>;
  readonly handleListFailure: (error: unknown) => void;
  readonly resetLatencyBaseline: (observedAt: string, reason: string) => void;
  readonly applyState: (state: EngineState) => void;
  readonly persistWrites: (writes: Record<string, unknown>) => Promise<void>;
  readonly deleteStorageKeys: (keys: readonly string[]) => Promise<void>;
  readonly logReset: (telemetry: JsonRecord) => void;
  readonly publishReset: (telemetry: JsonRecord) => void;
}

export interface TradingOrderBookResetTarget {
  engineState: EngineState;
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly activeIngestConnections: Map<string, string>;
  orderBookStores(): OrderBookResetStores;
  readonly state: {
    readonly storage: {
      list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
    };
  };
  handleStorageWriteFailure(reason: string, error: unknown): void;
  resetLatencyBaseline?(observedAt: string, reason: string): void;
  safeStoragePut(entries: Record<string, unknown>, reason: string): Promise<void>;
  safeStorageDelete(keys: string[], reason: string): Promise<void>;
  readonly logger: {
    warn(eventType: string, message: string, telemetry?: JsonRecord): void;
  };
  publish(type: string, payload: Record<string, unknown>): void;
}

export function resolveOrderBookReset(
  payload: Partial<OrderBookResetRequest>,
  now = new Date().toISOString()
): ResolvedOrderBookReset {
  const reason =
    typeof payload.reason === "string" && payload.reason.length > 0
      ? payload.reason
      : "UNSPECIFIED_RESET";
  const source = payload.source ?? "SYSTEM";
  const blackoutDurationMs =
    typeof payload.blackoutDurationMs === "number" && Number.isFinite(payload.blackoutDurationMs)
      ? Math.max(0, Math.round(payload.blackoutDurationMs))
      : null;
  const resetInstrument = payload.instrumentCode?.toLowerCase() ?? null;
  const resetSourceExchange = payload.source_exchange
    ? normalizeSourceExchange(payload.source_exchange)
    : null;
  const resetStreamId =
    typeof payload.streamId === "string" && payload.streamId.length > 0 ? payload.streamId : null;
  const resetMarketKey =
    resetInstrument && resetSourceExchange
      ? buildMarketKey(resetSourceExchange, resetInstrument)
      : null;
  const connectionId =
    typeof payload.connectionId === "string" && payload.connectionId.length > 0
      ? payload.connectionId
      : null;

  return {
    now,
    reason,
    source,
    blackoutDurationMs,
    resetInstrument,
    resetSourceExchange,
    resetStreamId,
    resetMarketKey,
    recoveredAt: payload.recoveredAt ?? now,
    connectionId
  };
}

export function orderBookResetDeleteKeys(
  persistedBooks: Map<string, InternalOrderBook>,
  orderBookPrefix: string,
  resetMarketKey: string | null
): string[] {
  if (!resetMarketKey) {
    return [...persistedBooks.keys()];
  }

  const key = `${orderBookPrefix}${resetMarketKey}`;
  return persistedBooks.has(key) ? [key] : [];
}

export function applyOrderBookResetStores(
  stores: OrderBookResetStores,
  resetMarketKey: string | null
): void {
  if (resetMarketKey) {
    stores.orderBook.delete(resetMarketKey);
    stores.bids.delete(resetMarketKey);
    stores.asks.delete(resetMarketKey);
    stores.sync.delete(resetMarketKey);
    return;
  }

  stores.orderBook.clear();
  stores.bids.clear();
  stores.asks.clear();
  stores.sync.clear();
}

export function orderBookResetConnectionKeys(reset: ResolvedOrderBookReset): string[] {
  if (reset.source !== "INGEST_WORKER" || !reset.connectionId) {
    return [];
  }

  const sourceExchange = reset.resetSourceExchange ?? "hyperliquid";
  return [`${sourceExchange}:${reset.resetStreamId ?? "default"}`];
}

export function applyOrderBookResetConnectionIds(
  connections: Map<string, string>,
  connectionId: string | null,
  connectionKeys: readonly string[]
): void {
  if (!connectionId) {
    return;
  }

  for (const connectionKey of connectionKeys) {
    connections.set(connectionKey, connectionId);
  }
}

export function orderBookResetTelemetry(
  reset: ResolvedOrderBookReset,
  deletedBookSnapshots: number
): JsonRecord {
  return {
    reason: reset.reason,
    source: reset.source,
    streamId: reset.resetStreamId,
    instrumentCode: reset.resetInstrument,
    source_exchange: reset.resetSourceExchange,
    marketKey: reset.resetMarketKey,
    connectionId: reset.connectionId,
    blackoutDurationMs: reset.blackoutDurationMs,
    recoveredAt: reset.recoveredAt,
    deletedBookSnapshots
  };
}

export function orderBookResetRuntimeArtifacts(
  input: OrderBookResetRuntimeInput
): OrderBookResetRuntimeArtifacts {
  const deleteKeys = orderBookResetDeleteKeys(
    input.persistedBooks,
    input.orderBookPrefix,
    input.reset.resetMarketKey
  );

  applyOrderBookResetStores(input.stores, input.reset.resetMarketKey);

  const state = stateAfterOrderBookReset({
    currentState: input.currentState,
    resetMarketKey: input.reset.resetMarketKey,
    resetInstrument: input.reset.resetInstrument,
    orderBookSize: input.orderBookSize,
    internalOrderBookDepth: input.internalOrderBookDepth,
    now: input.reset.now,
    priceDiscovery: input.priceDiscovery
  });

  return {
    state,
    deleteKeys,
    connectionKeys: orderBookResetConnectionKeys(input.reset),
    writes: {
      [input.engineStateKey]: state
    },
    telemetry: orderBookResetTelemetry(input.reset, deleteKeys.length),
    latencyResetReason:
      input.reset.source === "INGEST_WORKER" ? `ORDER_BOOK_RESET:${input.reset.reason}` : null
  };
}

export async function applyOrderBookResetSideEffects(
  reset: ResolvedOrderBookReset,
  artifacts: OrderBookResetRuntimeArtifacts,
  handlers: OrderBookResetSideEffectHandlers
): Promise<void> {
  if (artifacts.latencyResetReason) {
    handlers.resetLatencyBaseline(reset.now, artifacts.latencyResetReason);
    handlers.applyConnectionIds(reset.connectionId, artifacts.connectionKeys);
  }

  await Promise.all([
    handlers.persistWrites(artifacts.writes),
    handlers.deleteStorageKeys(artifacts.deleteKeys)
  ]);

  handlers.logReset(artifacts.telemetry);
  handlers.publishReset(artifacts.telemetry);
}

export async function applyOrderBookResetFlow(
  input: OrderBookResetFlowInput,
  handlers: OrderBookResetFlowHandlers
): Promise<OrderBookResetRuntimeArtifacts> {
  const reset = resolveOrderBookReset(input.payload);
  let persistedBooks = new Map<string, InternalOrderBook>();

  try {
    persistedBooks = await handlers.listPersistedBooks(input.orderBookPrefix);
  } catch (error) {
    handlers.handleListFailure(error);
  }

  const artifacts = orderBookResetRuntimeArtifacts({
    reset,
    currentState: input.currentState,
    persistedBooks,
    orderBookPrefix: input.orderBookPrefix,
    engineStateKey: input.engineStateKey,
    stores: input.stores,
    orderBookSize: input.orderBookSize,
    internalOrderBookDepth: input.internalOrderBookDepth,
    priceDiscovery: reset.resetInstrument
      ? handlers.calculatePriceDiscovery(reset.resetInstrument, reset.now)
      : null
  });

  handlers.applyState(artifacts.state);
  await applyOrderBookResetSideEffects(reset, artifacts, handlers);

  return artifacts;
}

export async function resetTradingOrderBook(
  input: TradingOrderBookResetInput,
  handlers: TradingOrderBookResetHandlers
): Promise<OrderBookResetRuntimeArtifacts> {
  return applyOrderBookResetFlow(
    {
      payload: input.payload,
      currentState: input.currentState,
      orderBookPrefix: ORDER_BOOK_PREFIX,
      engineStateKey: ENGINE_STATE_KEY,
      stores: input.stores,
      orderBookSize: input.stores.orderBook.size,
      internalOrderBookDepth: countBookLevels(input.stores.bids, input.stores.asks)
    },
    {
      listPersistedBooks: handlers.listPersistedBooks,
      handleListFailure: handlers.handleListFailure,
      calculatePriceDiscovery: (instrumentCode, observedAt) =>
        calculateOrderBookPriceDiscovery(input.orderBook, instrumentCode, observedAt),
      applyState: handlers.applyState,
      resetLatencyBaseline: handlers.resetLatencyBaseline,
      applyConnectionIds: (connectionId, connectionKeys) => {
        applyOrderBookResetConnectionIds(
          input.activeIngestConnections,
          connectionId,
          connectionKeys
        );
      },
      persistWrites: handlers.persistWrites,
      deleteStorageKeys: handlers.deleteStorageKeys,
      logReset: handlers.logReset,
      publishReset: handlers.publishReset
    }
  );
}

export async function resetTradingOrderBookForTarget(
  payload: Partial<OrderBookResetRequest>,
  target: TradingOrderBookResetTarget
): Promise<OrderBookResetRuntimeArtifacts> {
  return resetTradingOrderBook(
    {
      payload,
      currentState: target.engineState,
      stores: target.orderBookStores(),
      orderBook: target.orderBook,
      activeIngestConnections: target.activeIngestConnections
    },
    {
      listPersistedBooks: (prefix) => target.state.storage.list<InternalOrderBook>({ prefix }),
      handleListFailure: (error) => {
        target.handleStorageWriteFailure("ORDER_BOOK_RESET_LIST", error);
      },
      applyState: (state) => {
        target.engineState = state;
      },
      resetLatencyBaseline: (observedAt, reason) => {
        if (target.resetLatencyBaseline) {
          target.resetLatencyBaseline(observedAt, reason);
          return;
        }
        resetTradingLatencyBaselineForTarget(
          observedAt,
          reason,
          target as unknown as TradingLatencyStateTarget
        );
      },
      persistWrites: (writes) => target.safeStoragePut(writes, "ORDER_BOOK_RESET"),
      deleteStorageKeys: (keys) => target.safeStorageDelete([...keys], "ORDER_BOOK_RESET_DELETE"),
      logReset: (telemetry) => {
        target.logger.warn(
          "ORDER_BOOK_RESET",
          "Internal order book purged after stream recovery",
          telemetry
        );
      },
      publishReset: (telemetry) => {
        target.publish("ORDER_BOOK_RESET", telemetry);
      }
    }
  );
}
