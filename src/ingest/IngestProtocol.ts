import { isHyperliquidLiquidationMessage } from "../strategy/cascade/LiquidationStream";
import type {
  DwellirGrpcPayload,
  DwellirGrpcStreamKind
} from "../grpc/DwellirHyperliquidGrpcClient";
import type { HawkesFlowSide } from "./HawkesFlowTracker";
import type { ClockSyncTracker } from "./StreamRuntime";
import type {
  Env,
  ExchangeStreamConfig,
  JsonRecord,
  MarketDataSource,
  MarketDataSubscriptionProfile,
  MarketDataSubscriptionTier,
  MarketTick,
  OrderBookSnapshot,
  OrderBookSnapshotLevel
} from "../types";
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
  roundTo,
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

const DEFAULT_AUTH_HEADER = "X-Api-Key";
const DEFAULT_GRPC_AUTH_HEADER = "x-token";
const DWELLIR_GRPC_ENDPOINT = "https://api-hyperliquid-mainnet-grpc.n.dwellir.com";
const DWELLIR_ORDERBOOK_WS_ENDPOINT = "wss://api-hyperliquid-mainnet-orderbook.n.dwellir.com";
const DWELLIR_GRPC_SERVICE = "hyperliquid_l1_gateway.v2.HyperliquidL1Gateway";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_WATCHDOG_TIMEOUT_MS = 5_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_GRPC_BACKOFF_BASE_MS = 50;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_GRPC_FATAL_DROP_MS = 200;
const DEFAULT_DWELLIR_GRPC_FILLS_WATCHDOG_TIMEOUT_MS = 60_000;
const DEFAULT_DWELLIR_GRPC_START_LOOKBACK_MS = 1_000;
const DEFAULT_DWELLIR_GRPC_FORWARD_MAX_AGE_MS = 5_000;
const SNAPSHOT_SEQUENCE_FALLBACK_SEED = "snapshot";
const DEFAULT_SOURCE_WEIGHT = 1;
const HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT = 20;
const DWELLIR_MAX_L2_DEPTH_LIMIT = 100;
const DEFAULT_HYPERLIQUID_ASSET_MATRIX = ["BTC", "ETH", "HYPE", "SOL"] as const;

export type ResolvedExchangeStreamConfig = Required<
  Pick<
    ExchangeStreamConfig,
    "id" | "source" | "source_exchange" | "streamUrl" | "authHeader" | "weight"
  >
> &
  Pick<
    ExchangeStreamConfig,
    | "transport"
    | "clusterUrls"
    | "snapshotUrl"
    | "subscription"
    | "subscriptions"
    | "apiKeyEnv"
    | "instrumentCode"
    | "exchangeCode"
    | "grpcEndpoint"
    | "grpcService"
    | "grpcStreamMethod"
    | "grpcPingMethod"
    | "grpcSubscribeType"
    | "grpcUpdateType"
    | "grpcPingRequestType"
    | "grpcPingResponseType"
    | "grpcStreamTypes"
    | "subscriptionProfile"
  > & {
    transport: "websocket" | "grpc";
    heartbeatIntervalMs: number;
    watchdogTimeoutMs: number;
    maxBackoffMs: number;
    backoffBaseMs: number;
    grpcFatalDropMs: number;
  };

export interface BinanceSequenceWindow {
  firstUpdateId: number;
  finalUpdateId: number;
}

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

export function resolveDwellirGrpcUrl(
  env: Env,
  config?: Pick<ExchangeStreamConfig, "grpcEndpoint" | "streamUrl"> | null
): string {
  return (
    env.DWELLIR_GRPC_URL ??
    config?.grpcEndpoint ??
    config?.streamUrl ??
    env.DWELLIR_GRPC_ENDPOINT ??
    env.RPC_GRPC_ENDPOINT ??
    DWELLIR_GRPC_ENDPOINT
  );
}

export function resolveDwellirOrderbookWsUrl(env: Env): string {
  const explicit = env.DWELLIR_ORDERBOOK_WS_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const token =
    env.DWELLIR_API_KEY?.trim() ??
    env.RPC_AUTH_TOKEN?.trim() ??
    dwellirRouteTokenFromUrl(env.DWELLIR_GRPC_URL) ??
    dwellirRouteTokenFromUrl(env.RPC_GRPC_ENDPOINT) ??
    dwellirRouteTokenFromUrl(env.DWELLIR_GRPC_ENDPOINT);

  if (!token) {
    return requireString(env.HL_WS_URL, "DWELLIR_ORDERBOOK_WS_URL");
  }

  const endpoint = (env.DWELLIR_ORDERBOOK_WS_ENDPOINT ?? DWELLIR_ORDERBOOK_WS_ENDPOINT).replace(
    /\/+$/,
    ""
  );
  return `${endpoint}/${token}/ws`;
}

export function resolveDwellirSubscriptionProfile(
  env: Env,
  assetCount: number
): MarketDataSubscriptionProfile {
  const tier = normalizeDwellirSubscriptionTier(env.DWELLIR_SUBSCRIPTION_TIER);
  const orderbookTransport = dwellirOrderbookTransport(env);
  const l4Requested = booleanEnv(env.DWELLIR_ENABLE_L4_BOOK);
  const maxBookDepth =
    tier === "PUBLIC" || (orderbookTransport === "websocket" && !l4Requested)
      ? HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT
      : DWELLIR_MAX_L2_DEPTH_LIMIT;
  const bookDepth = readPositiveInteger(env.DWELLIR_ORDERBOOK_DEPTH, maxBookDepth, 1, maxBookDepth);
  const l4BookEnabled = l4Requested && tier !== "PUBLIC";
  const optimization =
    bookDepth >= maxBookDepth && !l4Requested
      ? "MAXIMIZED"
      : bookDepth >= maxBookDepth
        ? "CUSTOM"
        : "CONSERVATIVE";

  return {
    provider: "DWELLIR",
    tier,
    readMode:
      orderbookTransport === "grpc"
        ? l4BookEnabled
          ? "DWELLIR_GRPC_FILLS_L4_BOOK_GRPC"
          : "DWELLIR_GRPC_FILLS_L2_BOOK_GRPC"
        : l4BookEnabled
          ? "DWELLIR_GRPC_FILLS_L4_BOOK_WS"
          : "DWELLIR_GRPC_FILLS_L2_BOOK_WS",
    bookDepth,
    maxBookDepth,
    l4BookEnabled,
    assetCount,
    optimization,
    normalMode: true,
    reason: l4BookEnabled
      ? orderbookTransport === "grpc"
        ? `Dwellir ${tier} detected; L4 depth is enabled and carried through gRPC order-book snapshots before aggregation into the engine book.`
        : `Dwellir ${tier} detected; L4 depth is enabled on the Dwellir order-book WebSocket.`
      : l4Requested
        ? `Dwellir ${tier} detected; L4 was requested but is unavailable on the public tier, so the engine is using ${bookDepth}/${maxBookDepth} L2 levels.`
        : orderbookTransport === "grpc"
          ? `Dwellir ${tier} detected; normal mode is maximized at ${bookDepth}/${maxBookDepth} L2 levels with gRPC fills plus gRPC order-book snapshots.`
          : `Dwellir ${tier} detected; normal mode is maximized at ${bookDepth}/${maxBookDepth} L2 levels with gRPC fills plus order-book WebSocket.`
  };
}

export function dwellirOrderbookTransport(env: Env): "grpc" | "websocket" {
  const normalized = normalizeString(env.DWELLIR_ORDERBOOK_TRANSPORT);
  const tier = normalizeDwellirSubscriptionTier(env.DWELLIR_SUBSCRIPTION_TIER);
  return normalized === "GRPC" && tier !== "PUBLIC" ? "grpc" : "websocket";
}

export function mergeGrpcStreamTypes(current: string[] | undefined, required: string[]): string[] {
  const merged: string[] = [];

  for (const entry of [...(current ?? []), ...required]) {
    const normalized = entry.trim().toUpperCase();
    if (normalized && !merged.includes(normalized)) {
      merged.push(normalized);
    }
  }

  return merged;
}

export function normalizeDwellirSubscriptionTier(
  value: string | undefined
): MarketDataSubscriptionTier {
  const normalized = normalizeString(value);

  if (
    normalized === "PUBLIC" ||
    normalized === "STANDARD" ||
    normalized === "ENTERPRISE" ||
    normalized === "DEDICATED"
  ) {
    return normalized;
  }

  return "ENTERPRISE";
}

export function dwellirRouteTokenFromUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    const token = url.pathname.split("/").filter(Boolean)[0];
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function resolveDwellirStartTimestampMs(env: Env): number | null {
  const explicitTimestamp = readOptionalNumber(env.DWELLIR_GRPC_START_TIMESTAMP_MS);
  if (explicitTimestamp !== null) {
    return explicitTimestamp;
  }

  if (readOptionalNumber(env.DWELLIR_GRPC_START_BLOCK_HEIGHT) !== null) {
    return null;
  }

  const lookbackMs = Math.min(
    60_000,
    readNumber(env.DWELLIR_GRPC_START_LOOKBACK_MS, DEFAULT_DWELLIR_GRPC_START_LOOKBACK_MS)
  );

  return Math.max(1, Date.now() - lookbackMs);
}

export function hasEndpointPath(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.pathname.replace(/\//g, "").length > 0;
  } catch {
    return false;
  }
}

export function redactEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) {
    return undefined;
  }

  try {
    const url = new URL(endpoint);
    const hasSecretPath = url.pathname.replace(/\//g, "").length > 0;
    return hasSecretPath ? `${url.origin}/<dwellir-route>` : url.origin;
  } catch {
    return "<invalid-endpoint>";
  }
}

export function parseAssetList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return [
    ...new Set(
      value
        .split(",")
        .map((entry) =>
          entry
            .trim()
            .replace(/-perp$/i, "")
            .toUpperCase()
        )
        .filter((entry) => /^[A-Z0-9]+$/.test(entry))
    )
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

export function isOrderbookStreamKind(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return (
    normalized === "ORDERBOOK" ||
    normalized === "ORDERBOOK_SNAPSHOT" ||
    normalized === "ORDERBOOK_UPDATE" ||
    normalized === "BOOK_UPDATES" ||
    normalized === "SNAPSHOTS"
  );
}

export function isL2BookSubscription(subscription: string | JsonRecord | undefined): boolean {
  if (!subscription) {
    return false;
  }

  if (typeof subscription === "string") {
    const normalized = subscription.toLowerCase();
    return normalized.includes("l2book") || normalized.includes("l4book");
  }

  const payload = subscription.subscription;
  const type = isRecord(payload) ? normalizeString(payload.type) : null;
  return type === "L2BOOK" || type === "L4BOOK";
}

export function isLiquidationSubscription(subscription: string | JsonRecord | undefined): boolean {
  if (!subscription) {
    return false;
  }

  if (typeof subscription === "string") {
    return subscription.toLowerCase().includes("liquidation");
  }

  const payload = subscription.subscription;
  const type = isRecord(payload) ? normalizeString(payload.type) : null;
  return type === "LIQUIDATION" || type === "LIQUIDATIONS";
}

export function dwellirGrpcStreams(
  env: Env,
  config?: Pick<ResolvedExchangeStreamConfig, "grpcStreamTypes">
): Set<DwellirGrpcStreamKind> {
  const configured = config?.grpcStreamTypes?.length
    ? config.grpcStreamTypes
    : parseCsvList(env.DWELLIR_GRPC_STREAMS, ["ORDERBOOK_SNAPSHOT", "FILLS"]);
  const streams = new Set<DwellirGrpcStreamKind>();

  for (const entry of configured) {
    const normalized = entry.trim().toUpperCase();
    if (
      normalized === "ORDERBOOK" ||
      normalized === "ORDERBOOK_SNAPSHOT" ||
      normalized === "ORDERBOOK_UPDATE" ||
      normalized === "BOOK_UPDATES" ||
      normalized === "SNAPSHOTS"
    ) {
      streams.add("ORDERBOOK_SNAPSHOT");
    } else if (
      normalized === "FILL" ||
      normalized === "FILLS" ||
      normalized === "TRADE" ||
      normalized === "TRADES"
    ) {
      streams.add("FILLS");
    } else if (normalized === "BLOCK" || normalized === "BLOCKS") {
      streams.add("BLOCK");
    }
  }

  return streams.size > 0 ? streams : new Set(["ORDERBOOK_SNAPSHOT", "FILLS"]);
}

export function dwellirGrpcWatchdogTimeoutMs(
  env: Env,
  config: Pick<ResolvedExchangeStreamConfig, "watchdogTimeoutMs">,
  streams: Set<DwellirGrpcStreamKind>
): number {
  if (streams.has("ORDERBOOK_SNAPSHOT") || streams.has("BLOCK")) {
    return config.watchdogTimeoutMs;
  }

  if (streams.has("FILLS")) {
    return Math.max(
      config.watchdogTimeoutMs,
      readNumber(
        env.DWELLIR_GRPC_FILLS_WATCHDOG_TIMEOUT_MS,
        DEFAULT_DWELLIR_GRPC_FILLS_WATCHDOG_TIMEOUT_MS
      )
    );
  }

  return config.watchdogTimeoutMs;
}

export function shouldEmitDwellirGrpcFatalDrop(
  streams: Set<DwellirGrpcStreamKind>,
  env: Env
): boolean {
  if (streams.has("ORDERBOOK_SNAPSHOT") || streams.has("BLOCK")) {
    return true;
  }

  return booleanEnv(env.DWELLIR_GRPC_FATAL_ON_FILLS_ONLY);
}

export function dwellirPayloadToHyperliquidRawMessages(
  update: DwellirGrpcPayload,
  config: ResolvedExchangeStreamConfig,
  coins: string[],
  maxAgeMs: number
): Record<string, unknown>[] {
  if (update.kind === "BLOCK") {
    return [];
  }

  if (update.kind === "ORDERBOOK_SNAPSHOT") {
    return dwellirOrderbookSnapshotMessagesFromBytes(
      update.data,
      coins,
      update.receivedAt,
      maxAgeMs
    );
  }

  const decoded = decodeDwellirJsonBytes(update.data);
  if (decoded === null) {
    return [];
  }

  if (update.kind === "FILLS") {
    return dwellirFillMessages(decoded, config, coins, update.receivedAt, maxAgeMs);
  }

  return [];
}

export function classifyDwellirMalformedPayload(update: DwellirGrpcPayload): string | null {
  if (update.kind === "BLOCK") {
    return null;
  }

  const text = new TextDecoder().decode(update.data);
  const decoded = parseJson<unknown>(text);

  if (decoded === null) {
    return "INVALID_DWELLIR_PROTO_JSON_PAYLOAD";
  }

  if (update.kind === "FILLS") {
    const hasFillContainer =
      Array.isArray(decoded) ||
      (isRecord(decoded) &&
        (Array.isArray(decoded.data) ||
          Array.isArray(decoded.fills) ||
          Array.isArray(decoded.events) ||
          typeof decoded.channel === "string"));
    return hasFillContainer ? null : "UNSUPPORTED_DWELLIR_FILLS_PAYLOAD";
  }

  if (update.kind === "ORDERBOOK_SNAPSHOT") {
    const hasBookContainer =
      isRecord(decoded) &&
      (Array.isArray(decoded.data) ||
        Array.isArray(decoded.levels) ||
        Array.isArray(decoded.bids) ||
        typeof decoded.channel === "string");
    return hasBookContainer ? null : "UNSUPPORTED_DWELLIR_ORDERBOOK_PAYLOAD";
  }

  return null;
}

export function dwellirOrderbookSnapshotMessagesFromBytes(
  bytes: Uint8Array,
  coins: string[],
  receivedAt: string,
  maxAgeMs: number
): Record<string, unknown>[] {
  const text = new TextDecoder().decode(bytes);
  const timestamp = extractDwellirTopLevelField(text, "timestamp") ?? receivedAt;
  const block = extractDwellirTopLevelField(text, "block");
  const messages: Record<string, unknown>[] = [];

  if (!isDwellirPacketFresh(timestamp, receivedAt, maxAgeMs)) {
    return [];
  }

  for (const coin of coins) {
    const tupleJson = extractDwellirMarketTupleJson(text, coin.toUpperCase());
    if (!tupleJson) {
      continue;
    }

    const market = parseJson<unknown[]>(tupleJson);
    if (!Array.isArray(market) || typeof market[0] !== "string" || !Array.isArray(market[1])) {
      continue;
    }

    messages.push({
      channel: "l2Book",
      data: {
        coin: market[0].toUpperCase(),
        time: timestamp,
        sequence: block,
        levels: [
          aggregateDwellirOrders(market[1][0], receivedAt),
          aggregateDwellirOrders(market[1][1], receivedAt)
        ]
      }
    });
  }

  if (messages.length > 0) {
    return messages;
  }

  const decoded = parseJson<unknown>(text);
  return decoded === null
    ? []
    : dwellirOrderbookSnapshotMessages(decoded, coins, receivedAt, maxAgeMs);
}

export function extractDwellirMarketTupleJson(text: string, coin: string): string | null {
  const compactNeedle = `["${coin}",`;
  let start = text.indexOf(compactNeedle);

  if (start < 0) {
    const looseNeedle = `"${coin}"`;
    const coinAt = text.indexOf(looseNeedle);
    if (coinAt < 0) {
      return null;
    }
    start = text.lastIndexOf("[", coinAt);
  }

  if (start < 0 || text[start] !== "[") {
    return null;
  }

  return extractJsonArrayAt(text, start);
}

export function extractJsonArrayAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

export function extractDwellirTopLevelField(text: string, field: string): string | number | null {
  const match = new RegExp(`"${field}"\\s*:\\s*("([^"]+)"|[0-9]+)`).exec(text.slice(0, 512));
  if (!match) {
    return null;
  }

  if (match[2] !== undefined) {
    return match[2];
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function dwellirOrderbookSnapshotMessages(
  decoded: unknown,
  coins: string[],
  receivedAt: string,
  maxAgeMs: number
): Record<string, unknown>[] {
  if (isRecord(decoded) && typeof decoded.channel === "string") {
    return [decoded];
  }

  if (isRecord(decoded) && Array.isArray(decoded.data)) {
    const targets = new Set(coins.map((coin) => coin.toUpperCase()));
    const messages: Record<string, unknown>[] = [];
    const timestamp = decoded.timestamp ?? receivedAt;
    const block = decoded.block;

    if (!isDwellirPacketFresh(timestamp, receivedAt, maxAgeMs)) {
      return [];
    }

    for (const market of decoded.data) {
      if (!Array.isArray(market) || typeof market[0] !== "string" || !Array.isArray(market[1])) {
        continue;
      }

      const coin = market[0].toUpperCase();
      if (!targets.has(coin)) {
        continue;
      }

      messages.push({
        channel: "l2Book",
        data: {
          coin,
          time: timestamp,
          sequence: block,
          levels: [
            aggregateDwellirOrders(market[1][0], receivedAt),
            aggregateDwellirOrders(market[1][1], receivedAt)
          ]
        }
      });
    }

    return messages;
  }

  if (isRecord(decoded) && (Array.isArray(decoded.levels) || Array.isArray(decoded.bids))) {
    return [
      {
        channel: "l2Book",
        data: decoded
      }
    ];
  }

  return [];
}

export function dwellirFillMessages(
  decoded: unknown,
  config: ResolvedExchangeStreamConfig,
  coins: string[],
  receivedAt: string,
  maxAgeMs: number
): Record<string, unknown>[] {
  if (isRecord(decoded) && typeof decoded.channel === "string") {
    return [decoded];
  }

  const targetCoins = new Set(coins.map((coin) => coin.toUpperCase()));
  const fills = Array.isArray(decoded)
    ? decoded
    : isRecord(decoded) && Array.isArray(decoded.data)
      ? decoded.data
      : isRecord(decoded) && Array.isArray(decoded.fills)
        ? decoded.fills
        : isRecord(decoded) && Array.isArray(decoded.events)
          ? decoded.events
          : [];
  const byTradeId = new Map<string, Record<string, unknown>>();

  for (const entry of fills) {
    const fill =
      Array.isArray(entry) && isRecord(entry[1]) ? entry[1] : isRecord(entry) ? entry : null;

    if (!fill) {
      continue;
    }

    const coin =
      stringifyOrNull(fill.coin) ?? config.instrumentCode?.replace(/-usd$/i, "").toUpperCase();
    const normalizedCoin = coin?.toUpperCase();
    if (!normalizedCoin || (targetCoins.size > 0 && !targetCoins.has(normalizedCoin))) {
      continue;
    }

    if (!isDwellirPacketFresh(fill.time ?? fill.timestamp, receivedAt, maxAgeMs)) {
      continue;
    }

    const tradeId =
      stringifyOrNull(fill.tid ?? fill.id ?? fill.hash ?? fill.oid) ??
      `${normalizedCoin}:${fill.time ?? fill.timestamp ?? ""}:${fill.px ?? fill.price ?? fill.limitPx ?? ""}:${fill.sz ?? fill.size ?? ""}`;
    const normalized: Record<string, unknown> = {
      coin: normalizedCoin,
      px: fill.px ?? fill.price ?? fill.limitPx,
      sz: fill.sz ?? fill.size,
      side: fill.side,
      isBuy:
        typeof fill.isBuy === "boolean"
          ? fill.isBuy
          : typeof fill.side === "string"
            ? fill.side.toUpperCase() === "B" || fill.side.toLowerCase() === "buy"
            : undefined,
      time: fill.time ?? fill.timestamp,
      tid: fill.tid ?? fill.id ?? fill.hash ?? fill.oid,
      hash: fill.hash,
      crossed: fill.crossed,
      liquidation: fill.liquidation ?? null
    };
    const existing = byTradeId.get(tradeId);

    if (!existing || fill.crossed === true) {
      byTradeId.set(tradeId, normalized);
    }
  }

  const normalized = [...byTradeId.values()].filter(
    (fill) => fill.coin && fill.px !== undefined && fill.sz !== undefined
  );

  return normalized.length > 0 ? [{ channel: "trades", data: normalized }] : [];
}

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
    coerceExchangeTime(readField(data, ["time", "timestamp", "ts", "blockTime"])) ?? receivedAt;
  const sequence =
    readField(data, ["sequence", "seq", "block", "height", "time"]) ?? Date.parse(exchangeTime);

  let mutated = applyDwellirL4Snapshot(data, orderCache, receivedAt, maxCacheOrders);
  mutated = applyDwellirL4Deltas(data, orderCache, receivedAt) || mutated;

  if (!mutated && orderCache.size === 0) {
    return null;
  }

  pruneDwellirL4Cache(orderCache, Math.max(100, maxCacheOrders));

  const depthLimit = resolveBookDepthLimit(config);
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

  return formatPriceKey(price);
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
): Array<{ px: string; sz: string; n: number; updatedAt: string }> {
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

  const levels: Array<{ px: string; sz: string; n: number; updatedAt: string }> = [];
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
  bids: Array<{ px: string; sz: string; n: number; updatedAt: string }>,
  asks: Array<{ px: string; sz: string; n: number; updatedAt: string }>
): {
  bids: Array<{ px: string; sz: string; n: number; updatedAt: string }>;
  asks: Array<{ px: string; sz: string; n: number; updatedAt: string }>;
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

export function isDwellirPacketFresh(
  timestampValue: unknown,
  receivedAt: string,
  maxAgeMs: number
): boolean {
  const exchangeTimestamp = coerceExchangeTime(timestampValue);
  if (!exchangeTimestamp) {
    return true;
  }

  const exchangeMs = Date.parse(exchangeTimestamp);
  const receivedMs = Date.parse(receivedAt);

  if (!Number.isFinite(exchangeMs) || !Number.isFinite(receivedMs)) {
    return true;
  }

  return Math.max(0, receivedMs - exchangeMs) <= maxAgeMs;
}

export function aggregateDwellirOrders(
  value: unknown,
  receivedAt: string
): Array<{ px: string; sz: string; n: number; updatedAt: string }> {
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

export function decodeDwellirJsonBytes(bytes: Uint8Array): unknown | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function parseCsvList(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return [...fallback];
  }

  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : [...fallback];
}

export function normalizeTransport(value: string | undefined): "websocket" | "grpc" {
  return value?.trim().toLowerCase() === "grpc" ? "grpc" : "websocket";
}

export function streamCoins(config: ResolvedExchangeStreamConfig): string[] {
  const coins = new Set<string>();

  for (const subscription of config.subscriptions ?? []) {
    if (typeof subscription === "string") {
      continue;
    }

    const payload = subscription.subscription;
    if (isRecord(payload) && typeof payload.coin === "string") {
      coins.add(payload.coin.trim().toUpperCase());
    }
  }

  if (config.instrumentCode) {
    coins.add(
      config.instrumentCode
        .replace(/-usd$/i, "")
        .replace(/-perp$/i, "")
        .toUpperCase()
    );
  }

  return coins.size > 0 ? [...coins] : [...DEFAULT_HYPERLIQUID_ASSET_MATRIX];
}

export function resetInstrumentForStream(config: ResolvedExchangeStreamConfig): string | null {
  const coins = new Set<string>();

  for (const subscription of config.subscriptions ?? []) {
    if (typeof subscription === "string") {
      continue;
    }
    const payload = subscription.subscription;
    if (isRecord(payload) && typeof payload.coin === "string") {
      coins.add(payload.coin.trim().toUpperCase());
    }
  }

  if (coins.size > 1) {
    return null;
  }

  return config.instrumentCode ?? null;
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

export function parseWeightMap(value: string | undefined): Record<string, number> {
  const parsed = value ? parseJson<Record<string, unknown>>(value) : null;

  if (!parsed) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed)
      .map(([key, weight]) => [key.toLowerCase(), Number(weight)] as const)
      .filter(([, weight]) => Number.isFinite(weight) && weight > 0)
  );
}

export function readEnvSecret(env: Env, key: string): string | undefined {
  return (env as unknown as Record<string, string | undefined>)[key];
}

export function normalizeSource(value: unknown): MarketDataSource {
  const source = normalizeString(value);

  switch (source) {
    case "BINANCE":
    case "HYPERLIQUID":
    case "COINBASE":
    case "KRAKEN":
    case "OKX":
    case "BYBIT":
    case "SYSTEM":
      return source;
    default:
      return "SYSTEM";
  }
}

export function normalizeSourceExchange(value: unknown, fallback: unknown): string {
  const sourceExchange =
    typeof value === "string" && value.trim() !== ""
      ? value
      : typeof fallback === "string" && fallback.trim() !== ""
        ? fallback
        : "unknown";

  return sourceExchange.toLowerCase();
}

export function normalizeWeight(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SOURCE_WEIGHT;
}

export function buildMarketKey(sourceExchange: string, instrumentCode: string): string {
  return `${sourceExchange.toLowerCase()}:${instrumentCode.toLowerCase()}`;
}

export function normalizeInstrumentCode(value: string): string {
  const trimmed = value.trim().toLowerCase();

  if (trimmed.includes("-")) {
    return trimmed;
  }

  const compact = trimmed.replace("/", "");
  const quote = ["usdt", "usdc", "usd", "btc", "eth"].find((candidate) =>
    compact.endsWith(candidate)
  );

  if (!quote || compact.length <= quote.length) {
    return compact || "unknown";
  }

  return `${compact.slice(0, -quote.length)}-${quote}`;
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
