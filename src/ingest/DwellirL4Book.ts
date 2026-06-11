import {
  HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT,
  type ResolvedExchangeStreamConfig
} from "./IngestConfigPrimitives";
import { coerceTimestamp, readField } from "./IngestRecordAccess";
import { isRecord, normalizeString, roundTo, stringifyOrNull } from "./IngestRuntimeUtils";

export interface HyperliquidBookLevelSet {
  bids: Set<string>;
  asks: Set<string>;
}

export interface DwellirL4OrderState {
  side: "buy" | "sell";
  price: string;
  size: number;
  updatedAt: string;
}

type DwellirAggregatedLevel = { px: string; sz: string; n: number; updatedAt: string };

export function normalizeDwellirL4BookForEngine(
  raw: Record<string, unknown>,
  config: ResolvedExchangeStreamConfig,
  orderCache: Map<string, DwellirL4OrderState>,
  receivedAt: string,
  maxCacheOrders: number
): Record<string, unknown> | null {
  const envelope = isRecord(raw.data) ? raw.data : raw;
  const data = isRecord(envelope.Snapshot)
    ? envelope.Snapshot
    : isRecord(envelope.Updates)
      ? envelope.Updates
      : envelope;
  const coin =
    readDwellirL4Coin(data) ?? config.instrumentCode?.replace(/-usd$/i, "").toUpperCase();

  if (!coin) {
    return null;
  }

  const exchangeTime =
    coerceDwellirExchangeTime(readField(data, ["time", "timestamp", "ts", "blockTime"])) ??
    receivedAt;
  const sequence =
    readField(data, ["sequence", "seq", "block", "height", "time"]) ?? Date.parse(exchangeTime);

  let mutated = applyDwellirL4Snapshot(data, orderCache, receivedAt, maxCacheOrders);
  mutated = applyDwellirL4Deltas(data, orderCache, receivedAt) || mutated;

  if (!mutated && orderCache.size === 0) {
    return null;
  }

  pruneDwellirL4Cache(orderCache, Math.max(100, maxCacheOrders));

  const depthLimit = resolveDwellirL4BookDepthLimit(config);
  const bidLevels = buildDwellirL4AggregatedLevels(orderCache, "buy", depthLimit);
  const askLevels = buildDwellirL4AggregatedLevels(orderCache, "sell", depthLimit);
  const sanitized = sanitizeCrossedAggregatedBook(bidLevels, askLevels);

  if (sanitized.bids.length === 0 && sanitized.asks.length === 0) {
    return null;
  }

  return {
    channel: "l2Book",
    data: {
      coin: coin.toUpperCase(),
      time: exchangeTime,
      sequence,
      levels: [sanitized.bids, sanitized.asks],
      sourceChannel: "l4Book",
      crossedLevelsPruned: sanitized.pruned
    }
  };
}

export function applyDwellirL4Snapshot(
  data: Record<string, unknown>,
  orderCache: Map<string, DwellirL4OrderState>,
  receivedAt: string,
  maxCacheOrders: number
): boolean {
  const levels = readField(data, ["levels", "book", "orderBook"]);
  const bids = isRecord(levels)
    ? readField(levels, ["bids", "bid", "buy"])
    : readField(data, ["bids", "bidOrders", "buy"]);
  const asks = isRecord(levels)
    ? readField(levels, ["asks", "ask", "sell"])
    : readField(data, ["asks", "askOrders", "sell"]);

  if (Array.isArray(levels) && (Array.isArray(levels[0]) || Array.isArray(levels[1]))) {
    orderCache.clear();
    const sideLimit = Math.max(1, Math.floor(maxCacheOrders / 2));
    applyDwellirL4OrderList(levels[0], "buy", orderCache, receivedAt, "snapshot:bid", sideLimit);
    applyDwellirL4OrderList(levels[1], "sell", orderCache, receivedAt, "snapshot:ask", sideLimit);
    return true;
  }

  if (Array.isArray(bids) || Array.isArray(asks)) {
    orderCache.clear();
    const sideLimit = Math.max(1, Math.floor(maxCacheOrders / 2));
    applyDwellirL4OrderList(bids, "buy", orderCache, receivedAt, "snapshot:bid", sideLimit);
    applyDwellirL4OrderList(asks, "sell", orderCache, receivedAt, "snapshot:ask", sideLimit);
    return true;
  }

  return false;
}

export function applyDwellirL4Deltas(
  data: Record<string, unknown>,
  orderCache: Map<string, DwellirL4OrderState>,
  receivedAt: string
): boolean {
  let mutated = false;
  const deltaContainers = [
    readField(data, ["book_diffs", "bookDiffs"]),
    readField(data, ["diffs", "deltas", "updates", "changes", "orders", "orderUpdates"])
  ];

  for (const container of deltaContainers) {
    if (!Array.isArray(container)) {
      continue;
    }

    for (let index = 0; index < container.length; index += 1) {
      if (
        applyDwellirL4OrderMutation(
          container[index],
          null,
          orderCache,
          receivedAt,
          `delta:${index}`
        )
      ) {
        mutated = true;
      }
    }
  }

  const statusContainers = [
    readField(data, ["order_statuses", "orderStatuses", "statuses", "events"])
  ];

  for (const container of statusContainers) {
    if (!Array.isArray(container)) {
      continue;
    }

    for (let index = 0; index < container.length; index += 1) {
      const source = normalizeDwellirL4OrderSource(container[index], null);

      if (!source || !isDwellirL4Delete(source, readDwellirL4Size(source))) {
        continue;
      }

      if (
        applyDwellirL4OrderMutation(
          container[index],
          null,
          orderCache,
          receivedAt,
          `status:${index}`
        )
      ) {
        mutated = true;
      }
    }
  }

  return mutated;
}

export function applyDwellirL4OrderList(
  value: unknown,
  side: "buy" | "sell",
  orderCache: Map<string, DwellirL4OrderState>,
  receivedAt: string,
  fallbackPrefix: string,
  limit = Number.POSITIVE_INFINITY
): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (let index = 0; index < value.length && index < limit; index += 1) {
    applyDwellirL4OrderMutation(
      value[index],
      side,
      orderCache,
      receivedAt,
      `${fallbackPrefix}:${index}`
    );
  }
}

export function applyDwellirL4OrderMutation(
  value: unknown,
  sideHint: "buy" | "sell" | null,
  orderCache: Map<string, DwellirL4OrderState>,
  receivedAt: string,
  fallbackId: string
): boolean {
  const source = normalizeDwellirL4OrderSource(value, sideHint);

  if (!source) {
    return false;
  }

  const orderId = readDwellirL4OrderId(source, fallbackId);
  const existing = orderCache.get(orderId);
  const side = readDwellirL4Side(source, sideHint ?? existing?.side ?? null);
  const price = readDwellirL4Price(source) ?? existing?.price ?? null;
  const size = readDwellirL4Size(source);

  if (isDwellirL4Delete(source, size)) {
    return orderCache.delete(orderId);
  }

  if (!side || !price || size === null || size < 0) {
    return false;
  }

  orderCache.set(orderId, {
    side,
    price,
    size,
    updatedAt: receivedAt
  });
  return true;
}

export function normalizeDwellirL4OrderSource(
  value: unknown,
  sideHint: "buy" | "sell" | null
): Record<string, unknown> | null {
  if (isRecord(value)) {
    const nested = readField(value, ["order", "restingOrder", "bookOrder", "data"]);

    if (isRecord(nested)) {
      return {
        ...value,
        ...nested,
        status:
          readField(value, ["status", "type", "event", "state"]) ?? readField(nested, ["status"])
      };
    }

    return value;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  if (isRecord(value[1])) {
    return {
      oid: value[0],
      ...value[1]
    };
  }

  if (sideHint) {
    return {
      side: sideHint,
      px: value[0],
      sz: value[1],
      oid: value[2]
    };
  }

  return {
    side: value[0],
    px: value[1],
    sz: value[2],
    oid: value[3]
  };
}

export function readDwellirL4OrderId(source: Record<string, unknown>, fallbackId: string): string {
  const id = readField(source, [
    "oid",
    "orderId",
    "order_id",
    "id",
    "hash",
    "tid",
    "cloid",
    "clientOrderId"
  ]);

  return stringifyOrNull(id) ?? `${fallbackId}:${readDwellirL4Price(source) ?? "unknown"}`;
}

export function readDwellirL4Coin(source: Record<string, unknown>): string | null {
  const direct = stringifyOrNull(readField(source, ["coin", "asset", "symbol"]));

  if (direct) {
    return direct.toUpperCase();
  }

  const bookDiffs = readField(source, ["book_diffs", "bookDiffs", "diffs", "updates"]);
  if (Array.isArray(bookDiffs)) {
    for (const item of bookDiffs) {
      const record = normalizeDwellirL4OrderSource(item, null);
      const coin = record ? stringifyOrNull(readField(record, ["coin", "asset", "symbol"])) : null;

      if (coin) {
        return coin.toUpperCase();
      }
    }
  }

  const statuses = readField(source, ["order_statuses", "orderStatuses", "statuses"]);
  if (Array.isArray(statuses)) {
    for (const item of statuses) {
      const record = normalizeDwellirL4OrderSource(item, null);
      const coin = record ? stringifyOrNull(readField(record, ["coin", "asset", "symbol"])) : null;

      if (coin) {
        return coin.toUpperCase();
      }
    }
  }

  return null;
}

export function readDwellirL4Price(source: Record<string, unknown>): string | null {
  const rawPrice = readField(source, ["limitPx", "px", "price", "p"]);
  const price = Number(rawPrice);

  if (!Number.isFinite(price) || price < 0) {
    return null;
  }

  return formatDwellirPriceKey(price);
}

export function readDwellirL4Size(source: Record<string, unknown>): number | null {
  const rawBookDiff = readField(source, ["raw_book_diff", "rawBookDiff", "bookDiff"]);
  const newDiff = isRecord(rawBookDiff) && isRecord(rawBookDiff.new) ? rawBookDiff.new : null;
  const rawSize =
    readField(source, ["sz", "size", "qty", "quantity", "q", "remainingSize"]) ??
    (newDiff ? readField(newDiff, ["sz", "size", "qty", "quantity", "q"]) : undefined);
  const size = Number(rawSize);
  return Number.isFinite(size) ? size : null;
}

export function readDwellirL4Side(
  source: Record<string, unknown>,
  fallback: "buy" | "sell" | null
): "buy" | "sell" | null {
  if (typeof source.isBuy === "boolean") {
    return source.isBuy ? "buy" : "sell";
  }

  if (typeof source.isBid === "boolean") {
    return source.isBid ? "buy" : "sell";
  }

  if (typeof source.isAsk === "boolean") {
    return source.isAsk ? "sell" : "buy";
  }

  const side = normalizeString(readField(source, ["side", "s", "bookSide", "dir", "direction"]));

  if (side === "B" || side === "BUY" || side === "BID" || side === "LONG") {
    return "buy";
  }

  if (side === "A" || side === "ASK" || side === "SELL" || side === "S" || side === "SHORT") {
    return "sell";
  }

  return fallback;
}

export function isDwellirL4Delete(source: Record<string, unknown>, size: number | null): boolean {
  const status = normalizeString(readField(source, ["status", "type", "event", "state", "action"]));
  const rawBookDiff = readField(source, ["raw_book_diff", "rawBookDiff", "bookDiff"]);
  const rawBookDiffStatus = normalizeString(rawBookDiff);
  const rawBookDiffNew = isRecord(rawBookDiff) ? rawBookDiff.new : undefined;

  return (
    size === 0 ||
    rawBookDiffNew === null ||
    rawBookDiffStatus === "DELETE" ||
    rawBookDiffStatus === "DELETED" ||
    rawBookDiffStatus === "REMOVE" ||
    rawBookDiffStatus === "REMOVED" ||
    status === "CANCEL" ||
    status === "CANCELED" ||
    status === "CANCELLED" ||
    status === "DELETE" ||
    status === "DELETED" ||
    status === "REMOVE" ||
    status === "REMOVED" ||
    status === "FILL" ||
    status === "FILLED" ||
    status === "EXPIRE" ||
    status === "EXPIRED"
  );
}

export function buildDwellirL4AggregatedLevels(
  orderCache: Map<string, DwellirL4OrderState>,
  side: "buy" | "sell",
  depthLimit: number
): DwellirAggregatedLevel[] {
  const byPrice = new Map<
    string,
    { price: number; size: number; count: number; updatedAt: string }
  >();

  for (const order of orderCache.values()) {
    if (order.side !== side || order.size <= 0) {
      continue;
    }

    const price = Number(order.price);
    if (!Number.isFinite(price)) {
      continue;
    }

    const aggregate = byPrice.get(order.price) ?? {
      price,
      size: 0,
      count: 0,
      updatedAt: order.updatedAt
    };
    aggregate.size += order.size;
    aggregate.count += 1;
    aggregate.updatedAt =
      order.updatedAt > aggregate.updatedAt ? order.updatedAt : aggregate.updatedAt;
    byPrice.set(order.price, aggregate);
  }

  const sorted = Array.from(byPrice.entries());
  sorted.sort((left, right) =>
    side === "buy" ? right[1].price - left[1].price : left[1].price - right[1].price
  );

  const levels: DwellirAggregatedLevel[] = [];
  const cappedDepth = Math.max(1, depthLimit);

  for (let index = 0; index < sorted.length && levels.length < cappedDepth; index += 1) {
    const [price, aggregate] = sorted[index];
    levels.push({
      px: price,
      sz: String(roundTo(aggregate.size, 8)),
      n: aggregate.count,
      updatedAt: aggregate.updatedAt
    });
  }

  return levels;
}

export function sanitizeCrossedAggregatedBook(
  bids: DwellirAggregatedLevel[],
  asks: DwellirAggregatedLevel[]
): {
  bids: DwellirAggregatedLevel[];
  asks: DwellirAggregatedLevel[];
  pruned: number;
} {
  let bidOffset = 0;
  let askOffset = 0;
  let pruned = 0;

  while (bidOffset < bids.length && askOffset < asks.length) {
    const bestBid = Number(bids[bidOffset]?.px);
    const bestAsk = Number(asks[askOffset]?.px);

    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid < bestAsk) {
      break;
    }

    bidOffset += 1;
    askOffset += 1;
    pruned += 2;
  }

  return {
    bids: bidOffset > 0 ? bids.slice(bidOffset) : bids,
    asks: askOffset > 0 ? asks.slice(askOffset) : asks,
    pruned
  };
}

export function pruneDwellirL4Cache(
  orderCache: Map<string, DwellirL4OrderState>,
  maxCacheOrders: number
): void {
  if (orderCache.size <= maxCacheOrders) {
    return;
  }

  const bids: Array<[string, DwellirL4OrderState]> = [];
  const asks: Array<[string, DwellirL4OrderState]> = [];

  for (const entry of orderCache.entries()) {
    if (entry[1].side === "buy") {
      bids.push(entry);
    } else {
      asks.push(entry);
    }
  }

  bids.sort((left, right) => Number(right[1].price) - Number(left[1].price));
  asks.sort((left, right) => Number(left[1].price) - Number(right[1].price));

  orderCache.clear();
  const sideLimit = Math.max(1, Math.floor(maxCacheOrders / 2));

  for (let index = 0; index < bids.length && index < sideLimit; index += 1) {
    orderCache.set(bids[index][0], bids[index][1]);
  }

  for (let index = 0; index < asks.length && index < sideLimit; index += 1) {
    orderCache.set(asks[index][0], asks[index][1]);
  }
}

export function aggregateDwellirOrders(
  value: unknown,
  receivedAt: string
): DwellirAggregatedLevel[] {
  const orders = Array.isArray(value) ? value : [];
  const byPrice = new Map<string, { size: number; count: number }>();

  for (const order of orders) {
    if (!isRecord(order)) {
      continue;
    }

    const rawPrice = order.limitPx ?? order.px ?? order.price;
    const rawSize = order.sz ?? order.size;
    const price = typeof rawPrice === "string" ? rawPrice : String(rawPrice ?? "");
    const size = Number(rawSize);

    if (!price || !Number.isFinite(size) || size < 0) {
      continue;
    }

    const current = byPrice.get(price) ?? { size: 0, count: 0 };
    current.size += size;
    current.count += 1;
    byPrice.set(price, current);
  }

  return [...byPrice.entries()].map(([price, aggregate]) => ({
    px: price,
    sz: String(roundTo(aggregate.size, 8)),
    n: aggregate.count,
    updatedAt: receivedAt
  }));
}

function resolveDwellirL4BookDepthLimit(config: ResolvedExchangeStreamConfig): number {
  return Math.max(
    1,
    Math.min(
      config.subscriptionProfile?.maxBookDepth ?? HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT,
      config.subscriptionProfile?.bookDepth ?? HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT
    )
  );
}

function coerceDwellirExchangeTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1_000;
    return new Date(millis).toISOString();
  }

  if (typeof value === "string") {
    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      return coerceDwellirExchangeTime(numeric);
    }
  }

  return coerceTimestamp(value);
}

function formatDwellirPriceKey(value: number): string {
  return Number(value)
    .toFixed(8)
    .replace(/\.?0+$/, "");
}
