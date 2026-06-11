import type { DwellirGrpcStreamKind } from "../grpc/DwellirHyperliquidGrpcClient";
import type {
  Env,
  ExchangeStreamConfig,
  JsonRecord,
  MarketDataSubscriptionProfile,
  MarketDataSubscriptionTier
} from "../types";
import {
  DEFAULT_DWELLIR_GRPC_FILLS_WATCHDOG_TIMEOUT_MS,
  DEFAULT_DWELLIR_GRPC_START_LOOKBACK_MS,
  DWELLIR_GRPC_ENDPOINT,
  DWELLIR_MAX_L2_DEPTH_LIMIT,
  DWELLIR_ORDERBOOK_WS_ENDPOINT,
  HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT,
  parseCsvList,
  type ResolvedExchangeStreamConfig
} from "./IngestConfigPrimitives";
import {
  booleanEnv,
  isRecord,
  normalizeString,
  readNumber,
  readOptionalNumber,
  readPositiveInteger,
  requireString
} from "./IngestRuntimeUtils";

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
