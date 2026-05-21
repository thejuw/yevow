import {
  BOOK_SNAPSHOT_TOP_LEVELS,
  TOP_OF_BOOK_CROSS_CHECK_INTERVAL_MS
} from "../../../TradingEngineConstants";
import type { Env, InternalOrderBook, JsonRecord, OrderBookResetRequest } from "../../../types";
import { buildMarketKey, calculateTimeToBookMs, resolveTickSize } from "./BookRuntimeHelpers";
import {
  normalizeSourceExchange,
  normalizeSourceWeight
} from "../helpers/NativeMarketIdentityRuntime";
import { normalizeMarketKey } from "../state/AssetStateRuntime";
import type { BookSyncState } from "./BookTypes";
import { OrderBookReconstructor, type OrderBookStores } from "./OrderBookReconstructor";
import type { SortedBookSide } from "./SortedBookSide";

export interface OrderBookStoreMaps {
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
  readonly sync: Map<string, BookSyncState>;
}

export interface TradingOrderBookStoresTarget {
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly bids: Map<string, SortedBookSide>;
  readonly asks: Map<string, SortedBookSide>;
  readonly bookSync: Map<string, BookSyncState>;
}

export interface TradingOrderBookRebindTarget extends TradingOrderBookStoresTarget {
  readonly orderBookReconstructor: Pick<OrderBookReconstructor, "replaceStores">;
}

export interface TradingOrderBookReconstructorLogger {
  warn(eventType: string, message: string, metadata: JsonRecord): void;
  error(eventType: string, message: string, metadata: JsonRecord): void;
}

export interface TradingOrderBookReconstructorInput {
  readonly env: Env;
  readonly stores: OrderBookStores;
  readonly logger: TradingOrderBookReconstructorLogger;
  readonly publish: (type: string, payload: JsonRecord) => void;
  readonly resetOrderBook: (payload: Partial<OrderBookResetRequest>) => Promise<void>;
}

export function buildOrderBookStores(input: OrderBookStoreMaps): OrderBookStores {
  return {
    orderBook: input.orderBook,
    bids: input.bids,
    asks: input.asks,
    sync: input.sync
  };
}

export function buildTradingOrderBookStoresForTarget(
  target: TradingOrderBookStoresTarget
): OrderBookStores {
  return buildOrderBookStores({
    orderBook: target.orderBook,
    bids: target.bids,
    asks: target.asks,
    sync: target.bookSync
  });
}

export function rebindTradingOrderBookReconstructorForTarget(
  target: TradingOrderBookRebindTarget
): void {
  target.orderBookReconstructor.replaceStores(buildTradingOrderBookStoresForTarget(target));
}

export function createTradingOrderBookReconstructor(
  input: TradingOrderBookReconstructorInput
): OrderBookReconstructor {
  return new OrderBookReconstructor(input.stores, {
    topLevels: BOOK_SNAPSHOT_TOP_LEVELS,
    topOfBookCrossCheckIntervalMs: TOP_OF_BOOK_CROSS_CHECK_INTERVAL_MS,
    resolveTickSize: (instrumentCode, override) =>
      resolveTickSize(input.env, instrumentCode, override),
    normalizeSourceExchange,
    normalizeMarketKey,
    buildMarketKey,
    normalizeSourceWeight,
    calculateTimeToBookMs,
    warn: (eventType, message, metadata) => {
      input.logger.warn(eventType, message, metadata);
    },
    error: (eventType, message, metadata) => {
      input.logger.error(eventType, message, metadata);
    },
    publish: (type, payload) => {
      input.publish(type, payload);
    },
    resetOrderBook: (payload) => input.resetOrderBook(payload)
  });
}
