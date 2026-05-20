import {
  BOOK_SNAPSHOT_TOP_LEVELS,
  TOP_OF_BOOK_CROSS_CHECK_INTERVAL_MS
} from "../../../TradingEngineConstants";
import type { Env, InternalOrderBook, JsonRecord, OrderBookResetRequest } from "../../../types";
import { buildMarketKey, calculateTimeToBookMs, resolveTickSize } from "./BookRuntimeHelpers";
import {
  normalizeSourceExchange,
  normalizeSourceWeight
} from "../helpers/NativeHyperliquidRuntime";
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
