import { isHyperliquidLiquidationMessage } from "../strategy/cascade/LiquidationStream";
import type { HawkesFlowSide } from "./HawkesFlowTracker";
import type { ClockSyncTracker } from "./StreamRuntime";
import type {
  Env,
  ExchangeStreamConfig,
  JsonRecord,
  MarketDataSource,
  MarketTick,
  OrderBookSnapshot,
  OrderBookSnapshotLevel
} from "../types";
import {
  dwellirGrpcStreams,
  dwellirGrpcWatchdogTimeoutMs,
  dwellirOrderbookTransport,
  dwellirRouteTokenFromUrl,
  hasEndpointPath,
  isL2BookSubscription,
  isLiquidationSubscription,
  isOrderbookStreamKind,
  mergeGrpcStreamTypes,
  normalizeDwellirSubscriptionTier,
  parseAssetList,
  redactEndpoint,
  resolveDwellirGrpcUrl,
  resolveDwellirOrderbookWsUrl,
  resolveDwellirStartTimestampMs,
  resolveDwellirSubscriptionProfile,
  shouldEmitDwellirGrpcFatalDrop
} from "./DwellirStreamSettings";
import {
  classifyDwellirMalformedPayload,
  dwellirPayloadToHyperliquidRawMessages
} from "./DwellirPayloadMessages";
import { normalizeDwellirL4BookForEngine } from "./DwellirL4Book";
export {
  classifyDwellirMalformedPayload,
  decodeDwellirJsonBytes,
  dwellirFillMessages,
  dwellirOrderbookSnapshotMessages,
  dwellirOrderbookSnapshotMessagesFromBytes,
  dwellirPayloadToHyperliquidRawMessages,
  extractDwellirMarketTupleJson,
  extractDwellirTopLevelField,
  extractJsonArrayAt,
  isDwellirPacketFresh
} from "./DwellirPayloadMessages";
export {
  aggregateDwellirOrders,
  applyDwellirL4Deltas,
  applyDwellirL4OrderList,
  applyDwellirL4OrderMutation,
  applyDwellirL4Snapshot,
  buildDwellirL4AggregatedLevels,
  isDwellirL4Delete,
  normalizeDwellirL4BookForEngine,
  normalizeDwellirL4OrderSource,
  pruneDwellirL4Cache,
  readDwellirL4Coin,
  readDwellirL4OrderId,
  readDwellirL4Price,
  readDwellirL4Side,
  readDwellirL4Size,
  sanitizeCrossedAggregatedBook,
  type DwellirL4OrderState,
  type HyperliquidBookLevelSet
} from "./DwellirL4Book";
export {
  dwellirGrpcStreams,
  dwellirGrpcWatchdogTimeoutMs,
  dwellirOrderbookTransport,
  dwellirRouteTokenFromUrl,
  hasEndpointPath,
  isL2BookSubscription,
  isLiquidationSubscription,
  isOrderbookStreamKind,
  mergeGrpcStreamTypes,
  normalizeDwellirSubscriptionTier,
  parseAssetList,
  redactEndpoint,
  resolveDwellirGrpcUrl,
  resolveDwellirOrderbookWsUrl,
  resolveDwellirStartTimestampMs,
  resolveDwellirSubscriptionProfile,
  shouldEmitDwellirGrpcFatalDrop
} from "./DwellirStreamSettings";
import {
  buildMarketKey,
  DEFAULT_AUTH_HEADER,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_DWELLIR_GRPC_FILLS_WATCHDOG_TIMEOUT_MS,
  DEFAULT_DWELLIR_GRPC_FORWARD_MAX_AGE_MS,
  DEFAULT_DWELLIR_GRPC_START_LOOKBACK_MS,
  DEFAULT_GRPC_BACKOFF_BASE_MS,
  DEFAULT_GRPC_FATAL_DROP_MS,
  DEFAULT_GRPC_AUTH_HEADER,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HYPERLIQUID_ASSET_MATRIX,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_SOURCE_WEIGHT,
  DEFAULT_WATCHDOG_TIMEOUT_MS,
  DWELLIR_GRPC_ENDPOINT,
  DWELLIR_GRPC_SERVICE,
  DWELLIR_MAX_L2_DEPTH_LIMIT,
  DWELLIR_ORDERBOOK_WS_ENDPOINT,
  HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT,
  normalizeInstrumentCode,
  normalizeSource,
  normalizeSourceExchange,
  normalizeTransport,
  normalizeWeight,
  parseCsvList,
  parseWeightMap,
  readEnvSecret,
  resetInstrumentForStream,
  streamCoins,
  type ResolvedExchangeStreamConfig
} from "./IngestConfigPrimitives";
export {
  buildMarketKey,
  DEFAULT_AUTH_HEADER,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_DWELLIR_GRPC_FILLS_WATCHDOG_TIMEOUT_MS,
  DEFAULT_DWELLIR_GRPC_FORWARD_MAX_AGE_MS,
  DEFAULT_DWELLIR_GRPC_START_LOOKBACK_MS,
  DEFAULT_GRPC_BACKOFF_BASE_MS,
  DEFAULT_GRPC_FATAL_DROP_MS,
  DEFAULT_GRPC_AUTH_HEADER,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HYPERLIQUID_ASSET_MATRIX,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_SOURCE_WEIGHT,
  DEFAULT_WATCHDOG_TIMEOUT_MS,
  DWELLIR_GRPC_ENDPOINT,
  DWELLIR_GRPC_SERVICE,
  DWELLIR_MAX_L2_DEPTH_LIMIT,
  DWELLIR_ORDERBOOK_WS_ENDPOINT,
  HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT,
  normalizeInstrumentCode,
  normalizeSource,
  normalizeSourceExchange,
  normalizeTransport,
  normalizeWeight,
  parseCsvList,
  parseWeightMap,
  readEnvSecret,
  resetInstrumentForStream,
  streamCoins,
  type ResolvedExchangeStreamConfig
} from "./IngestConfigPrimitives";
import {
  booleanEnv,
  finiteOrNull,
  finiteOrUndefined,
  isRecord,
  normalizeString,
  parseJson,
  readNumber,
  readOptionalNumber,
  readPositiveInteger,
  requireFiniteNumber,
  requireString,
  stringifyOrNull
} from "./IngestRuntimeUtils";
import {
  coerceSequence,
  coerceTimestamp,
  extractHeartbeatLatencyMs,
  hashSequenceId,
  inferSubscriptionField,
  isHyperliquidControlMessage,
  isPong,
  normalizeSide,
  readField,
  readStringField,
  splitInstrumentCode
} from "./IngestRecordAccess";
export {
  coerceSequence,
  coerceTimestamp,
  extractHeartbeatLatencyMs,
  hashSequenceId,
  inferSubscriptionField,
  isHyperliquidControlMessage,
  isPong,
  normalizeSide,
  readField,
  readStringField,
  splitInstrumentCode
} from "./IngestRecordAccess";
export {
  booleanEnv,
  calculateBackoffMs,
  closeSocket,
  delay,
  finiteOrNull,
  finiteOrUndefined,
  heartbeatPayload,
  hostnameOf,
  isAuthorizedControlRequest,
  isRecord,
  json,
  normalizeString,
  parseJson,
  readNumber,
  readOptionalNumber,
  readPositiveInteger,
  readResponseJson,
  requireFiniteNumber,
  requireString,
  roundTo,
  sleep,
  stringifyOrNull,
  websocketFetchUrl
} from "./IngestRuntimeUtils";

const SNAPSHOT_SEQUENCE_FALLBACK_SEED = "snapshot";

export interface BinanceSequenceWindow {
  firstUpdateId: number;
  finalUpdateId: number;
}

export function normalizeMarketData(
  raw: unknown,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  switch (config.source) {
    case "BINANCE":
      return normalizeBinanceData(raw, config, clockSync);
    case "HYPERLIQUID":
      return normalizeHyperliquidData(raw, config, clockSync);
    case "COINBASE":
      return normalizeCoinbaseData(raw, config, clockSync);
    default:
      return [normalizeGenericExchangeData(raw, config, clockSync)];
  }
}

export function normalizeRestOrderBookSnapshot(
  raw: unknown,
  receivedAt: string,
  config: ResolvedExchangeStreamConfig
): OrderBookSnapshot {
  if (!isRecord(raw)) {
    throw new Error("INVALID_REST_SNAPSHOT");
  }

  const instrumentCode = (
    readStringField(raw, ["instrumentCode", "instrument_code", "instrument", "symbol"]) ??
    config.instrumentCode
  )?.toLowerCase();
  const exchangeCode = (
    readStringField(raw, ["exchange", "exchangeCode", "exchange_code"]) ??
    config.exchangeCode ??
    config.source_exchange
  )?.toLowerCase();

  if (!instrumentCode) {
    throw new Error("MISSING_SNAPSHOT_INSTRUMENT");
  }

  if (!exchangeCode) {
    throw new Error("MISSING_SNAPSHOT_EXCHANGE");
  }

  const exchangeTimestamp =
    coerceTimestamp(readField(raw, ["timestamp", "time", "ts", "tsExchange"])) ?? receivedAt;

  return {
    schemaVersion: "order-book.snapshot.v1",
    source: config.source,
    source_exchange: normalizeSourceExchange(config.source_exchange, exchangeCode),
    exchangeCode,
    instrumentCode,
    marketKey: buildMarketKey(config.source_exchange, instrumentCode),
    sourceWeight: normalizeWeight(config.weight),
    sequence: coerceSnapshotSequence(raw),
    exchangeTimestamp,
    receivedAt,
    bids: normalizeSnapshotLevels(readSnapshotLevels(raw, "bid"), receivedAt),
    asks: normalizeSnapshotLevels(readSnapshotLevels(raw, "ask"), receivedAt)
  };
}

export function normalizeHyperliquidData(
  raw: unknown,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  if (!isRecord(raw)) {
    throw new Error("INVALID_HYPERLIQUID_PAYLOAD");
  }

  const channel = normalizeString(readField(raw, ["channel"]));

  if (channel === "SUBSCRIPTIONRESPONSE" || channel === "POST" || channel === "PONG") {
    return [];
  }

  if (channel === "L2BOOK") {
    return normalizeHyperliquidL2Book(raw, config, clockSync);
  }

  if (channel === "TRADES") {
    return normalizeHyperliquidTrades(raw, config, clockSync);
  }

  if (channel === "ACTIVEASSETCTX" || channel === "ALLDEXSASSETCTXS") {
    return normalizeHyperliquidAssetContext(raw, config, clockSync);
  }

  return [];
}

export function normalizeHyperliquidL2Book(
  raw: Record<string, unknown>,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  const data = readHyperliquidObject(raw);
  const receivedAt = new Date().toISOString();
  const coin = requireString(readField(data, ["coin"]) ?? config.instrumentCode, "coin");
  const instrumentCode = hyperliquidInstrumentCode(coin, config.instrumentCode);
  const exchangeTimestamp =
    coerceExchangeTime(readField(data, ["time", "timestamp"])) ?? receivedAt;
  const synchronized = clockSync.observe(exchangeTimestamp, receivedAt);
  const sequenceSeed = coerceGenericSequence(readField(data, ["time", "sequence", "seq"]));
  const [bidLevels, askLevels] = normalizeHyperliquidBookSides(
    readField(data, ["levels"]),
    resolveBookDepthLimit(config)
  );
  const ticks: MarketTick[] = [];

  for (const [price, size, orderCount] of bidLevels) {
    ticks.push(
      createUniversalTick({
        config,
        instrumentCode,
        price,
        size,
        side: "buy",
        sequence: sequenceSeed + ticks.length,
        exchangeTimestamp,
        synchronized,
        receivedAt,
        rawMetadata: {
          eventType: "l2Book",
          commodity: "ORDER_BOOK",
          depthSide: "bid",
          orderCount,
          coin
        }
      })
    );
  }

  for (const [price, size, orderCount] of askLevels) {
    ticks.push(
      createUniversalTick({
        config,
        instrumentCode,
        price,
        size,
        side: "sell",
        sequence: sequenceSeed + ticks.length,
        exchangeTimestamp,
        synchronized,
        receivedAt,
        rawMetadata: {
          eventType: "l2Book",
          commodity: "ORDER_BOOK",
          depthSide: "ask",
          orderCount,
          coin
        }
      })
    );
  }

  if (ticks.length === 0) {
    throw new Error("EMPTY_HYPERLIQUID_L2BOOK");
  }

  return ticks;
}

export function normalizeHyperliquidTrades(
  raw: Record<string, unknown>,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  const payload = readHyperliquidData(raw);
  const trades = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.trades)
      ? payload.trades
      : [payload];
  const receivedAt = new Date().toISOString();
  const ticks: MarketTick[] = [];

  for (const trade of trades) {
    if (!isRecord(trade)) {
      continue;
    }

    const coin = requireString(readField(trade, ["coin"]) ?? config.instrumentCode, "coin");
    const instrumentCode = hyperliquidInstrumentCode(coin, config.instrumentCode);
    const price = requireFiniteNumber(readField(trade, ["px", "price", "p"]), "price");
    const size = requireFiniteNumber(readField(trade, ["sz", "size", "q"]), "size");
    const exchangeTimestamp =
      coerceExchangeTime(readField(trade, ["time", "timestamp", "ts"])) ?? receivedAt;
    const synchronized = clockSync.observe(exchangeTimestamp, receivedAt);
    const side = hyperliquidTradeSide(readField(trade, ["side"]));

    ticks.push(
      createUniversalTick({
        config,
        instrumentCode,
        price,
        size,
        side,
        sequence:
          coerceGenericSequence(readField(trade, ["tid", "id", "hash", "time"])) + ticks.length,
        exchangeTimestamp,
        synchronized,
        receivedAt,
        rawMetadata: {
          eventType: "trade",
          commodity: "TRADE",
          coin,
          tradeId: stringifyOrNull(readField(trade, ["tid", "id"])),
          tradeHash: stringifyOrNull(readField(trade, ["hash"])),
          aggressorSide: stringifyOrNull(readField(trade, ["side"]))
        }
      })
    );
  }

  return ticks;
}

export function normalizeHyperliquidAssetContext(
  raw: Record<string, unknown>,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  const payload = readHyperliquidData(raw);
  const items = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.ctxs)
      ? payload.ctxs
      : [payload];
  const receivedAt = new Date().toISOString();
  const ticks: MarketTick[] = [];

  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }

    const ctx = isRecord(item.ctx) ? item.ctx : item;
    const coin = requireString(readField(item, ["coin"]) ?? config.instrumentCode, "coin");
    const instrumentCode = hyperliquidInstrumentCode(coin, config.instrumentCode);
    const markPrice = finiteOrNull(readField(ctx, ["markPx", "markPrice"]));
    const oraclePrice = finiteOrNull(readField(ctx, ["oraclePx", "oraclePrice"]));
    const midPrice = finiteOrNull(readField(ctx, ["midPx", "midPrice"]));
    const price = midPrice ?? markPrice ?? oraclePrice ?? 0;
    const fundingRateHourly = finiteOrNull(readField(ctx, ["funding", "fundingRate"])) ?? 0;
    const exchangeTimestamp =
      coerceExchangeTime(readField(item, ["time", "timestamp"])) ?? receivedAt;
    const synchronized = clockSync.observe(exchangeTimestamp, receivedAt);

    ticks.push(
      createUniversalTick({
        config,
        instrumentCode,
        price,
        size: 0,
        side: "unknown",
        sequence: coerceGenericSequence(`${coin}:${exchangeTimestamp}:funding`),
        exchangeTimestamp,
        synchronized,
        receivedAt,
        rawMetadata: {
          eventType: "funding",
          commodity: "FUNDING",
          coin,
          fundingRateHourly,
          markPrice,
          oraclePrice,
          openInterest: finiteOrNull(readField(ctx, ["openInterest"])),
          dayNtlVlm: finiteOrNull(readField(ctx, ["dayNtlVlm"]))
        }
      })
    );
  }

  return ticks;
}

export function normalizeBinanceData(
  raw: unknown,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  if (!isRecord(raw)) {
    throw new Error("INVALID_BINANCE_PAYLOAD");
  }

  const receivedAt = new Date().toISOString();
  const eventType = normalizeString(readField(raw, ["e", "eventType", "type"]));
  const symbol = String(
    readField(raw, ["s", "symbol", "instrument", "instrumentCode"]) ?? config.instrumentCode ?? ""
  ).toLowerCase();
  const instrumentCode = normalizeInstrumentCode(symbol);
  const eventTime = readField(raw, ["E", "eventTime", "time", "timestamp"]);
  const exchangeTimestamp = coerceExchangeTime(eventTime) ?? receivedAt;
  const synchronized = clockSync.observe(exchangeTimestamp, receivedAt);
  const sequence = coerceGenericSequence(readField(raw, ["u", "U", "t", "sequence", "seq"]));

  const bidUpdates = readField(raw, ["b", "bids"]);
  const askUpdates = readField(raw, ["a", "asks"]);

  if (eventType === "DEPTHUPDATE" || Array.isArray(bidUpdates) || Array.isArray(askUpdates)) {
    const ticks: MarketTick[] = [];

    for (const [price, size] of normalizeDepthLevels(bidUpdates)) {
      ticks.push(
        createUniversalTick({
          config,
          instrumentCode,
          price,
          size,
          side: "buy",
          sequence: sequence + ticks.length,
          exchangeTimestamp,
          synchronized,
          receivedAt,
          rawMetadata: {
            eventType: eventType ?? "DEPTHUPDATE",
            depthSide: "bid",
            ...(readBinanceSequenceWindow(raw) ?? {})
          }
        })
      );
    }

    for (const [price, size] of normalizeDepthLevels(askUpdates)) {
      ticks.push(
        createUniversalTick({
          config,
          instrumentCode,
          price,
          size,
          side: "sell",
          sequence: sequence + ticks.length,
          exchangeTimestamp,
          synchronized,
          receivedAt,
          rawMetadata: {
            eventType: eventType ?? "DEPTHUPDATE",
            depthSide: "ask",
            ...(readBinanceSequenceWindow(raw) ?? {})
          }
        })
      );
    }

    if (ticks.length === 0) {
      throw new Error("EMPTY_BINANCE_DEPTH_UPDATE");
    }

    return ticks;
  }

  const price = requireFiniteNumber(readField(raw, ["p", "price"]), "price");
  const size = requireFiniteNumber(readField(raw, ["q", "quantity", "size"]), "size");
  const isBuyerMaker = Boolean(readField(raw, ["m", "buyerMaker"]));

  return [
    createUniversalTick({
      config,
      instrumentCode,
      price,
      size,
      side: isBuyerMaker ? "sell" : "buy",
      sequence,
      exchangeTimestamp,
      synchronized,
      receivedAt,
      rawMetadata: { eventType: eventType ?? "TRADE" }
    })
  ];
}

export function readBinanceSequenceWindow(raw: unknown): BinanceSequenceWindow | null {
  if (!isRecord(raw)) {
    return null;
  }

  const firstUpdateId = Number(readField(raw, ["U", "firstUpdateId"]));
  const finalUpdateId = Number(readField(raw, ["u", "lastUpdateId", "finalUpdateId"]));

  if (
    Number.isSafeInteger(firstUpdateId) &&
    firstUpdateId >= 0 &&
    Number.isSafeInteger(finalUpdateId) &&
    finalUpdateId >= firstUpdateId
  ) {
    return { firstUpdateId, finalUpdateId };
  }

  return null;
}

export function normalizeCoinbaseData(
  raw: unknown,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick[] {
  if (!isRecord(raw)) {
    throw new Error("INVALID_COINBASE_PAYLOAD");
  }

  const receivedAt = new Date().toISOString();
  const instrumentCode = normalizeInstrumentCode(
    String(
      readField(raw, ["product_id", "productId", "instrument", "instrumentCode"]) ??
        config.instrumentCode ??
        ""
    )
  );
  const exchangeTimestamp = coerceTimestamp(readField(raw, ["time", "timestamp"])) ?? receivedAt;
  const synchronized = clockSync.observe(exchangeTimestamp, receivedAt);
  const changes = readField(raw, ["changes", "updates"]);

  if (Array.isArray(changes)) {
    const ticks: MarketTick[] = [];

    for (const change of changes) {
      const normalized = normalizeCoinbaseChange(change);

      if (!normalized) {
        continue;
      }

      ticks.push(
        createUniversalTick({
          config,
          instrumentCode,
          price: normalized.price,
          size: normalized.size,
          side: normalized.side,
          sequence:
            coerceGenericSequence(readField(raw, ["sequence", "sequence_num"])) + ticks.length,
          exchangeTimestamp,
          synchronized,
          receivedAt,
          rawMetadata: { eventType: stringifyOrNull(readField(raw, ["type"])) ?? "l2update" }
        })
      );
    }

    if (ticks.length > 0) {
      return ticks;
    }
  }

  return [normalizeGenericExchangeData(raw, config, clockSync)];
}

export function normalizeGenericExchangeData(
  raw: unknown,
  config: ResolvedExchangeStreamConfig,
  clockSync: ClockSyncTracker
): MarketTick {
  if (!isRecord(raw)) {
    throw new Error("INVALID_MARKET_PAYLOAD");
  }

  const receivedAt = new Date().toISOString();
  const instrumentCode = normalizeInstrumentCode(
    String(
      readField(raw, ["instrumentCode", "instrument", "symbol", "product_id", "code"]) ??
        config.instrumentCode ??
        ""
    )
  );
  const price = requireFiniteNumber(readField(raw, ["price", "p", "px"]), "price");
  const size = requireFiniteNumber(
    readField(raw, ["size", "amount", "quantity", "qty", "q"]),
    "size"
  );
  const exchangeTimestamp =
    coerceTimestamp(readField(raw, ["exchangeTimestamp", "timestamp", "time", "ts"])) ?? receivedAt;
  const synchronized = clockSync.observe(exchangeTimestamp, receivedAt);
  const side = normalizeUniversalSide(
    readField(raw, ["side", "orderSide", "liquiditySide", "updateType"])
  );

  return createUniversalTick({
    config,
    instrumentCode,
    price,
    size,
    side,
    sequence: coerceGenericSequence(readField(raw, ["sequence", "seq", "sequenceId", "id"])),
    exchangeTimestamp,
    synchronized,
    receivedAt,
    rawMetadata: sanitizeGenericMetadata(raw)
  });
}

export function extractMarketEvents(raw: unknown, source: MarketDataSource): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }

  if (!isRecord(raw)) {
    return [raw];
  }

  if (source === "HYPERLIQUID") {
    return [raw];
  }

  if (Array.isArray(raw.data)) {
    return raw.data;
  }

  if (Array.isArray(raw.events)) {
    return raw.events;
  }

  if (Array.isArray(raw.result)) {
    return raw.result;
  }

  if (isRecord(raw.data)) {
    return [raw.data];
  }

  if (isRecord(raw.result)) {
    return [raw.result];
  }

  return [raw];
}

export function readSnapshotLevels(
  snapshot: Record<string, unknown>,
  side: "bid" | "ask"
): unknown {
  const plural = side === "bid" ? "bids" : "asks";
  const singular = side;
  const direct = readField(snapshot, [
    plural,
    `${singular}Levels`,
    `${plural}Levels`,
    `${singular}_levels`,
    `${plural}_levels`
  ]);

  if (direct !== undefined) {
    return unwrapLevelsContainer(direct);
  }

  const levels = unwrapLevelsContainer(readField(snapshot, ["levels", "book", "orderBook"]));

  if (isRecord(levels)) {
    return unwrapLevelsContainer(levels[plural] ?? levels[singular]);
  }

  return [];
}

export function unwrapLevelsContainer(value: unknown): unknown {
  if (isRecord(value) && Array.isArray(value.levels)) {
    return value.levels;
  }

  return value;
}

export function normalizeSnapshotLevels(
  value: unknown,
  observedAt: string
): OrderBookSnapshotLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const levels: OrderBookSnapshotLevel[] = [];

  for (const level of value) {
    const normalized = normalizeSnapshotLevel(level, observedAt);

    if (normalized) {
      levels.push(normalized);
    }
  }

  return levels;
}

export function normalizeSnapshotLevel(
  level: unknown,
  observedAt: string
): OrderBookSnapshotLevel | null {
  let price: unknown;
  let size: unknown;
  let updatedAt: string | null = null;

  if (Array.isArray(level)) {
    [price, size] = level;
    updatedAt = coerceTimestamp(level[2]);
  } else if (isRecord(level)) {
    price = readField(level, ["price", "px", "p"]);
    size = readField(level, ["size", "amount", "quantity", "qty", "volume"]);
    updatedAt = coerceTimestamp(readField(level, ["updatedAt", "updated_at", "ts"]));
  } else {
    return null;
  }

  const parsedPrice = Number(price);
  const parsedSize = Number(size);

  if (
    !Number.isFinite(parsedPrice) ||
    !Number.isFinite(parsedSize) ||
    parsedPrice < 0 ||
    parsedSize < 0
  ) {
    return null;
  }

  return {
    price: parsedPrice,
    size: parsedSize,
    updatedAt: updatedAt ?? observedAt
  };
}

export function coerceSnapshotSequence(snapshot: Record<string, unknown>): number {
  const sequence = readField(snapshot, [
    "sequence",
    "sequenceId",
    "sequence_id",
    "seq",
    "lastUpdateId",
    "lastSequence",
    "last_sequence"
  ]);
  const parsed = Number(sequence);

  if (Number.isSafeInteger(parsed) && parsed >= 0) {
    return parsed;
  }

  return hashSequenceId(
    `${SNAPSHOT_SEQUENCE_FALLBACK_SEED}:${JSON.stringify({
      bids: readSnapshotLevels(snapshot, "bid"),
      asks: readSnapshotLevels(snapshot, "ask")
    })}`
  );
}

export function loadStreamConfigs(env: Env): ResolvedExchangeStreamConfig[] {
  const configured = env.MARKET_STREAMS
    ? parseJson<ExchangeStreamConfig[]>(env.MARKET_STREAMS)
    : null;
  const weights = parseWeightMap(env.EXCHANGE_WEIGHTS);
  const rawConfigs =
    configured && Array.isArray(configured) && configured.length > 0
      ? configured
      : defaultHyperliquidStreamConfig(env);

  return augmentDwellirHyperliquidReadStreams(rawConfigs, env)
    .filter((config) => config.enabled !== false)
    .map((config, index) => resolveStreamConfig(env, config, weights, index));
}

export function augmentDwellirHyperliquidReadStreams(
  configs: ExchangeStreamConfig[],
  env: Env
): ExchangeStreamConfig[] {
  const hasDwellirGrpc = configs.some((config) => isDwellirGrpcRawConfig(config, env));
  const hasHyperliquidBookSocket = configs.some(
    (config) =>
      normalizeSource(config.source) === "HYPERLIQUID" &&
      normalizeTransport(config.transport) === "websocket" &&
      (config.subscriptions ?? [config.subscription])
        .filter(Boolean)
        .some((subscription) => isL2BookSubscription(subscription))
  );
  const hasHyperliquidLiquidationSocket = configs.some(
    (config) =>
      normalizeSource(config.source) === "HYPERLIQUID" &&
      normalizeTransport(config.transport) === "websocket" &&
      (config.subscriptions ?? [config.subscription])
        .filter(Boolean)
        .some((subscription) => isLiquidationSubscription(subscription))
  );

  if (!hasDwellirGrpc || (hasHyperliquidBookSocket && hasHyperliquidLiquidationSocket)) {
    return configs;
  }

  const coins = parseAssetList(env.HL_ASSETS ?? env.HL_ASSET);
  const activeCoins = coins.length > 0 ? coins : [...DEFAULT_HYPERLIQUID_ASSET_MATRIX];
  const subscriptionProfile = resolveDwellirSubscriptionProfile(env, activeCoins.length);
  const orderbookTransport = dwellirOrderbookTransport(env);
  const liquidationUrl = resolveDwellirOrderbookWsUrl(env);
  const liquidationStreams: ExchangeStreamConfig[] = hasHyperliquidLiquidationSocket
    ? []
    : activeCoins.map((coin) => ({
        id: `hyperliquid-liquidations-${coin.toLowerCase()}`,
        source: "HYPERLIQUID" as const,
        source_exchange: "hyperliquid",
        transport: "websocket" as const,
        streamUrl: liquidationUrl,
        weight: 1,
        exchangeCode: "hyperliquid",
        instrumentCode: `${coin.toLowerCase()}-usd`,
        subscriptionProfile,
        subscriptions: [
          {
            method: "subscribe",
            subscription: { type: "liquidations", coin }
          }
        ]
      }));

  if (orderbookTransport === "grpc") {
    return [...configs, ...liquidationStreams].map((config) =>
      isDwellirGrpcRawConfig(config, env)
        ? {
            ...config,
            subscriptionProfile,
            grpcStreamTypes: mergeGrpcStreamTypes(config.grpcStreamTypes, [
              "ORDERBOOK_SNAPSHOT",
              "FILLS"
            ])
          }
        : config
    );
  }

  const orderbookUrl = resolveDwellirOrderbookWsUrl(env);
  const normalized = configs.map((config) =>
    isDwellirGrpcRawConfig(config, env)
      ? (() => {
          const grpcStreamTypes = (config.grpcStreamTypes ?? ["FILLS"]).filter(
            (entry) => !isOrderbookStreamKind(entry)
          );
          return {
            ...config,
            subscriptionProfile,
            // Dwellir's gRPC gateway is excellent for fills/blocks. The order-book
            // server is the authoritative low-latency L2 feed, so keep gRPC off
            // the book hot path to avoid snapshot-file churn resetting the engine.
            grpcStreamTypes: grpcStreamTypes.length > 0 ? grpcStreamTypes : ["FILLS"]
          };
        })()
      : config
  );

  const orderbookStreams: ExchangeStreamConfig[] = hasHyperliquidBookSocket
    ? []
    : activeCoins.map((coin) => ({
        id: `dwellir-hyperliquid-orderbook-${coin.toLowerCase()}`,
        source: "HYPERLIQUID" as const,
        source_exchange: "hyperliquid",
        transport: "websocket" as const,
        streamUrl: orderbookUrl,
        weight: 1,
        exchangeCode: "hyperliquid",
        instrumentCode: `${coin.toLowerCase()}-usd`,
        subscriptionProfile,
        subscriptions: [
          {
            method: "subscribe",
            subscription: {
              type: subscriptionProfile.l4BookEnabled ? "l4Book" : "l2Book",
              coin,
              ...(subscriptionProfile.l4BookEnabled
                ? {}
                : {
                    nSigFigs: 5,
                    strict: true
                  })
            }
          }
        ]
      }));

  return [...normalized, ...orderbookStreams, ...liquidationStreams];
}

export function defaultHyperliquidStreamConfig(env: Env): ExchangeStreamConfig[] {
  const coins = parseAssetList(env.HL_ASSETS ?? env.HL_ASSET).slice(0, 12);
  const activeCoins = coins.length > 0 ? coins : [...DEFAULT_HYPERLIQUID_ASSET_MATRIX];
  const transport = normalizeTransport(env.INGEST_TRANSPORT ?? "grpc");
  const grpcEndpoint = resolveDwellirGrpcUrl(env);

  return [
    {
      id:
        activeCoins.length === 1
          ? `hyperliquid-${activeCoins[0].toLowerCase()}-perp`
          : "dwellir-hyperliquid-grpc",
      source: "HYPERLIQUID",
      source_exchange: "hyperliquid",
      transport,
      streamUrl:
        transport === "grpc"
          ? requireString(grpcEndpoint, "RPC_GRPC_ENDPOINT")
          : requireString(env.HL_WS_URL, "HL_WS_URL"),
      grpcEndpoint,
      grpcService: env.RPC_GRPC_SERVICE ?? DWELLIR_GRPC_SERVICE,
      grpcStreamMethod: env.RPC_GRPC_STREAM_METHOD ?? "StreamOrderbookSnapshots",
      grpcPingMethod: env.RPC_GRPC_PING_METHOD,
      grpcSubscribeType: env.RPC_GRPC_SUBSCRIBE_TYPE ?? "hyperliquid_l1_gateway.v2.Position",
      grpcUpdateType: env.RPC_GRPC_UPDATE_TYPE ?? "hyperliquid_l1_gateway.v2.OrderBookSnapshot",
      grpcPingRequestType: env.RPC_GRPC_PING_REQUEST_TYPE,
      grpcPingResponseType: env.RPC_GRPC_PING_RESPONSE_TYPE,
      grpcStreamTypes: parseCsvList(env.RPC_GRPC_STREAM_TYPES ?? env.DWELLIR_GRPC_STREAMS, [
        "ORDERBOOK_SNAPSHOT",
        "FILLS"
      ]),
      subscriptions: activeCoins.flatMap((coin) => [
        { method: "subscribe", subscription: { type: "l2Book", coin } },
        { method: "subscribe", subscription: { type: "trades", coin } },
        { method: "subscribe", subscription: { type: "activeAssetCtx", coin } },
        { method: "subscribe", subscription: { type: "liquidations", coin } }
      ]),
      instrumentCode: activeCoins.length === 1 ? `${activeCoins[0].toLowerCase()}-usd` : undefined,
      exchangeCode: "hyperliquid"
    }
  ];
}

export function isDwellirGrpcConfig(config: ResolvedExchangeStreamConfig): boolean {
  return (
    config.transport === "grpc" &&
    ((config.grpcEndpoint ?? config.streamUrl).includes("dwellir.com") ||
      (config.grpcService ?? "").startsWith("hyperliquid_l1_gateway."))
  );
}

export function isDwellirGrpcRawConfig(config: ExchangeStreamConfig, env: Env): boolean {
  const transport = normalizeTransport(config.transport ?? env.INGEST_TRANSPORT);
  if (transport !== "grpc" || normalizeSource(config.source) !== "HYPERLIQUID") {
    return false;
  }

  const endpoint =
    config.grpcEndpoint ?? config.streamUrl ?? env.DWELLIR_GRPC_URL ?? env.RPC_GRPC_ENDPOINT;
  return (
    (typeof endpoint === "string" && endpoint.includes("dwellir.com")) ||
    (config.grpcService ?? env.RPC_GRPC_SERVICE ?? "").startsWith("hyperliquid_l1_gateway.")
  );
}

export function shouldSendApplicationHeartbeat(config: ResolvedExchangeStreamConfig): boolean {
  if (config.source === "BINANCE") {
    return false;
  }

  const profile = config.subscriptionProfile;
  const streamUrl = config.streamUrl.toLowerCase();
  if (
    config.transport === "websocket" &&
    profile?.provider === "DWELLIR" &&
    streamUrl.includes("orderbook.n.dwellir.com")
  ) {
    return false;
  }

  return true;
}

export function resolveStreamConfig(
  env: Env,
  config: ExchangeStreamConfig,
  weights: Record<string, number>,
  index: number
): ResolvedExchangeStreamConfig {
  const source = normalizeSource(config.source);
  const sourceExchange = normalizeSourceExchange(config.source_exchange, config.exchangeCode);
  const transport = normalizeTransport(config.transport ?? env.INGEST_TRANSPORT);
  const dwellirGrpcUrl = resolveDwellirGrpcUrl(env, config);
  const configuredWeight = Number(config.weight);
  const weight =
    Number.isFinite(configuredWeight) && configuredWeight > 0
      ? configuredWeight
      : (weights[sourceExchange] ??
        weights[`${source.toLowerCase()}:${sourceExchange}`] ??
        DEFAULT_SOURCE_WEIGHT);

  return {
    id: config.id || `${source.toLowerCase()}-${sourceExchange}-${index}`,
    source,
    source_exchange: sourceExchange,
    transport,
    streamUrl: requireString(
      transport === "grpc"
        ? (config.grpcEndpoint ?? dwellirGrpcUrl ?? config.streamUrl)
        : config.streamUrl,
      transport === "grpc" ? "RPC_GRPC_ENDPOINT" : "STREAM_URL"
    ),
    snapshotUrl: config.snapshotUrl,
    clusterUrls: config.clusterUrls,
    subscription: config.subscription,
    subscriptions: config.subscriptions,
    authHeader: config.authHeader ?? DEFAULT_AUTH_HEADER,
    apiKeyEnv: config.apiKeyEnv,
    grpcEndpoint: config.grpcEndpoint ?? dwellirGrpcUrl ?? env.RPC_GRPC_ENDPOINT,
    grpcService: config.grpcService ?? env.RPC_GRPC_SERVICE,
    grpcStreamMethod: config.grpcStreamMethod ?? env.RPC_GRPC_STREAM_METHOD,
    grpcPingMethod: config.grpcPingMethod ?? env.RPC_GRPC_PING_METHOD,
    grpcSubscribeType: config.grpcSubscribeType ?? env.RPC_GRPC_SUBSCRIBE_TYPE,
    grpcUpdateType: config.grpcUpdateType ?? env.RPC_GRPC_UPDATE_TYPE,
    grpcPingRequestType: config.grpcPingRequestType ?? env.RPC_GRPC_PING_REQUEST_TYPE,
    grpcPingResponseType: config.grpcPingResponseType ?? env.RPC_GRPC_PING_RESPONSE_TYPE,
    grpcStreamTypes:
      config.grpcStreamTypes ??
      parseCsvList(env.RPC_GRPC_STREAM_TYPES ?? env.DWELLIR_GRPC_STREAMS, [
        "ORDERBOOK_SNAPSHOT",
        "FILLS"
      ]),
    weight,
    instrumentCode: config.instrumentCode?.toLowerCase(),
    exchangeCode: (config.exchangeCode ?? sourceExchange).toLowerCase(),
    subscriptionProfile: config.subscriptionProfile,
    heartbeatIntervalMs: readNumber(env.HL_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS),
    watchdogTimeoutMs: readNumber(
      env.HL_WATCHDOG_TIMEOUT_MS ?? env.HL_STALE_AFTER_MS,
      DEFAULT_WATCHDOG_TIMEOUT_MS
    ),
    maxBackoffMs: readNumber(env.HL_MAX_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS),
    backoffBaseMs: readNumber(
      env.HL_GRPC_BACKOFF_BASE_MS,
      transport === "grpc" ? DEFAULT_GRPC_BACKOFF_BASE_MS : DEFAULT_BACKOFF_BASE_MS
    ),
    grpcFatalDropMs: readNumber(env.DWELLIR_GRPC_FATAL_DROP_MS, DEFAULT_GRPC_FATAL_DROP_MS)
  };
}

export function assertIngestEnv(env: Env, config: ResolvedExchangeStreamConfig): void {
  requireString(config.streamUrl, "STREAM_URL");

  if (config.transport === "grpc") {
    requireString(config.grpcEndpoint ?? config.streamUrl, "RPC_GRPC_ENDPOINT");
    requireString(config.grpcService ?? env.RPC_GRPC_SERVICE, "RPC_GRPC_SERVICE");
    requireString(config.grpcStreamMethod ?? env.RPC_GRPC_STREAM_METHOD, "RPC_GRPC_STREAM_METHOD");
    requireString(
      config.grpcSubscribeType ?? env.RPC_GRPC_SUBSCRIBE_TYPE,
      "RPC_GRPC_SUBSCRIBE_TYPE"
    );
    requireString(config.grpcUpdateType ?? env.RPC_GRPC_UPDATE_TYPE, "RPC_GRPC_UPDATE_TYPE");
  }

  if (config.apiKeyEnv) {
    requireString(readEnvSecret(env, config.apiKeyEnv), config.apiKeyEnv);
  }
}

export function createUniversalTick(input: {
  config: ResolvedExchangeStreamConfig;
  instrumentCode: string;
  price: number;
  size: number;
  side: MarketTick["side"];
  sequence: number;
  exchangeTimestamp: string;
  synchronized: { timestamp: string; offsetMs: number };
  receivedAt: string;
  rawMetadata: JsonRecord;
}): MarketTick {
  const instrumentCode = normalizeInstrumentCode(input.instrumentCode);
  const { baseAsset, quoteAsset } = splitInstrumentCode(instrumentCode);

  return {
    schemaVersion: "universal-tick.v1",
    source: input.config.source,
    source_exchange: input.config.source_exchange,
    transport: input.config.transport,
    streamId: input.config.id,
    connectionId: null,
    sourceChannel:
      typeof input.rawMetadata.eventType === "string" ? input.rawMetadata.eventType : null,
    exchangeCode: (input.config.exchangeCode ?? input.config.source_exchange).toLowerCase(),
    instrumentCode,
    baseAsset,
    quoteAsset,
    price: input.price,
    size: input.size,
    side: input.side,
    sequence: input.sequence,
    providerTimestamp: input.exchangeTimestamp,
    exchangeTimestamp: input.exchangeTimestamp,
    synchronizedExchangeTimestamp: input.synchronized.timestamp,
    clockOffsetMs: input.synchronized.offsetMs,
    receivedAt: input.receivedAt,
    sourceWeight: input.config.weight,
    fundingRateHourly: finiteOrUndefined(input.rawMetadata.fundingRateHourly),
    markPrice: finiteOrUndefined(input.rawMetadata.markPrice),
    oraclePrice: finiteOrUndefined(input.rawMetadata.oraclePrice),
    openInterest: finiteOrUndefined(input.rawMetadata.openInterest),
    raw: input.rawMetadata
  };
}

export function coerceExchangeTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1_000;
    return new Date(millis).toISOString();
  }

  if (typeof value === "string") {
    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      return coerceExchangeTime(numeric);
    }
  }

  return coerceTimestamp(value);
}

export function coerceGenericSequence(value: unknown): number {
  const parsed = Number(value);

  if (Number.isSafeInteger(parsed) && parsed >= 0) {
    return parsed;
  }

  return hashSequenceId(JSON.stringify(value ?? crypto.randomUUID()));
}

export function normalizeDepthLevels(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((level) => {
      if (!Array.isArray(level)) {
        return null;
      }

      const price = Number(level[0]);
      const size = Number(level[1]);
      return Number.isFinite(price) && Number.isFinite(size) && price >= 0 && size >= 0
        ? ([price, size] as [number, number])
        : null;
    })
    .filter((level): level is [number, number] => level !== null);
}

export function readHyperliquidData(raw: Record<string, unknown>): unknown {
  return raw.data ?? raw.result ?? raw;
}

export function readHyperliquidObject(raw: Record<string, unknown>): Record<string, unknown> {
  const data = readHyperliquidData(raw);
  if (!isRecord(data)) {
    throw new Error("INVALID_HYPERLIQUID_DATA");
  }
  return data;
}

export function normalizeHyperliquidBookSides(
  levels: unknown,
  depthLimit = HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT
): [Array<[number, number, number | null]>, Array<[number, number, number | null]>] {
  if (!Array.isArray(levels)) {
    return [[], []];
  }

  const bidLevels = Array.isArray(levels[0]) ? levels[0] : [];
  const askLevels = Array.isArray(levels[1]) ? levels[1] : [];
  return [
    normalizeHyperliquidBookLevels(bidLevels).slice(0, depthLimit),
    normalizeHyperliquidBookLevels(askLevels).slice(0, depthLimit)
  ];
}

export function resolveBookDepthLimit(config: ResolvedExchangeStreamConfig): number {
  return Math.max(
    1,
    Math.min(
      config.subscriptionProfile?.maxBookDepth ?? HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT,
      config.subscriptionProfile?.bookDepth ?? HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT
    )
  );
}

export function normalizeHyperliquidBookLevels(
  value: unknown
): Array<[number, number, number | null]> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((level) => {
      const record = Array.isArray(level) ? null : isRecord(level) ? level : null;
      const price = Number(
        record ? readField(record, ["px", "price", "p"]) : Array.isArray(level) ? level[0] : null
      );
      const size = Number(
        record ? readField(record, ["sz", "size", "q"]) : Array.isArray(level) ? level[1] : null
      );
      const orderCount = finiteOrNull(
        record
          ? readField(record, ["n", "count", "orders"])
          : Array.isArray(level)
            ? level[2]
            : null
      );

      return Number.isFinite(price) && Number.isFinite(size) && price >= 0 && size >= 0
        ? ([price, size, orderCount] as [number, number, number | null])
        : null;
    })
    .filter((level): level is [number, number, number | null] => level !== null);
}

export function hyperliquidTradeSide(value: unknown): MarketTick["side"] {
  const side = normalizeString(value);

  if (side === "B" || side === "BUY" || side === "BID") {
    return "buy";
  }

  if (side === "A" || side === "SELL" || side === "ASK") {
    return "sell";
  }

  return "unknown";
}

export function hawkesTradeSide(fill: Record<string, unknown>): HawkesFlowSide {
  if (typeof fill.isBuy === "boolean") {
    return fill.isBuy ? "BUY" : "SELL";
  }

  const side = normalizeString(fill.side);

  if (side === "B" || side === "BUY" || side === "BID") {
    return "BUY";
  }

  if (side === "A" || side === "SELL" || side === "ASK") {
    return "SELL";
  }

  return "UNKNOWN";
}

export function hyperliquidInstrumentCode(coin: string, fallback?: string): string {
  const normalizedCoin = coin.trim().toLowerCase();
  if (!normalizedCoin && fallback) {
    return normalizeInstrumentCode(fallback);
  }

  if (normalizedCoin.includes("-") || normalizedCoin.includes("/")) {
    return normalizeInstrumentCode(normalizedCoin.replace("/", "-"));
  }

  return `${normalizedCoin}-usd`;
}

export function createDeleteTick(
  template: MarketTick,
  side: MarketTick["side"],
  price: number
): MarketTick {
  return {
    ...template,
    price,
    size: 0,
    side,
    raw: {
      ...(template.raw ?? {}),
      eventType: "l2Book",
      commodity: "ORDER_BOOK",
      depthSide: side === "buy" ? "bid" : "ask",
      deleteReason: "missing-from-hyperliquid-snapshot"
    }
  };
}

export function formatPriceKey(value: number): string {
  return Number(value)
    .toFixed(8)
    .replace(/\.?0+$/, "");
}

export function normalizeCoinbaseChange(
  change: unknown
): { side: MarketTick["side"]; price: number; size: number } | null {
  if (!Array.isArray(change) || change.length < 3) {
    return null;
  }

  const side = normalizeUniversalSide(change[0]);
  const price = Number(change[1]);
  const size = Number(change[2]);

  if (!Number.isFinite(price) || !Number.isFinite(size) || price < 0 || size < 0) {
    return null;
  }

  return { side, price, size };
}

export function normalizeUniversalSide(value: unknown): MarketTick["side"] {
  const side = normalizeString(value);

  if (side === "BUY" || side === "BID" || side === "BEST_BID") {
    return "buy";
  }

  if (side === "SELL" || side === "ASK" || side === "BEST_ASK") {
    return "sell";
  }

  return "unknown";
}

export function sanitizeGenericMetadata(raw: Record<string, unknown>): JsonRecord {
  return {
    eventType: stringifyOrNull(readField(raw, ["e", "type", "event"])),
    rawSequence: stringifyOrNull(readField(raw, ["sequence", "seq", "u", "id"]))
  };
}

export const __test__ = {
  classifyDwellirMalformedPayload,
  dwellirPayloadToHyperliquidRawMessages,
  loadStreamConfigs,
  normalizeDwellirL4BookForEngine,
  resolveDwellirOrderbookWsUrl
};
