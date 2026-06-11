import type { Env, ExchangeStreamConfig } from "../types";
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
  coerceExchangeTime,
  coerceGenericSequence,
  coerceSnapshotSequence,
  createDeleteTick,
  createUniversalTick,
  extractMarketEvents,
  formatPriceKey,
  hawkesTradeSide,
  hyperliquidInstrumentCode,
  hyperliquidTradeSide,
  normalizeBinanceData,
  normalizeCoinbaseChange,
  normalizeCoinbaseData,
  normalizeDepthLevels,
  normalizeGenericExchangeData,
  normalizeHyperliquidAssetContext,
  normalizeHyperliquidBookLevels,
  normalizeHyperliquidBookSides,
  normalizeHyperliquidData,
  normalizeHyperliquidL2Book,
  normalizeHyperliquidTrades,
  normalizeMarketData,
  normalizeRestOrderBookSnapshot,
  normalizeSnapshotLevel,
  normalizeSnapshotLevels,
  normalizeUniversalSide,
  readBinanceSequenceWindow,
  readHyperliquidData,
  readHyperliquidObject,
  readSnapshotLevels,
  resolveBookDepthLimit,
  sanitizeGenericMetadata,
  unwrapLevelsContainer,
  type BinanceSequenceWindow
} from "./ExchangeTickNormalizers";
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
  normalizeSource,
  normalizeSourceExchange,
  normalizeTransport,
  parseCsvList,
  parseWeightMap,
  readEnvSecret,
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
import { parseJson, readNumber, requireString } from "./IngestRuntimeUtils";
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

export const __test__ = {
  classifyDwellirMalformedPayload,
  dwellirPayloadToHyperliquidRawMessages,
  loadStreamConfigs,
  normalizeDwellirL4BookForEngine,
  resolveDwellirOrderbookWsUrl
};
