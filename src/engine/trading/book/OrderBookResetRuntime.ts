import { normalizeSourceExchange } from "../helpers/NativeHyperliquidRuntime";
import { buildMarketKey } from "./BookRuntimeHelpers";
import type {
  EngineState,
  InternalOrderBook,
  JsonRecord,
  OrderBookResetRequest,
  PriceDiscoveryMetrics
} from "../../../types";
import type { BookSyncState } from "./BookTypes";
import type { SortedBookSide } from "./SortedBookSide";
import { stateAfterOrderBookReset } from "./BookRuntimeState";

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
