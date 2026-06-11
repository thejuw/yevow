import type { Env, ExchangeStreamConfig, MarketDataSource } from "../types";
import { isRecord, normalizeString, parseJson } from "./IngestRuntimeUtils";

export const DEFAULT_AUTH_HEADER = "X-Api-Key";
export const DEFAULT_GRPC_AUTH_HEADER = "x-token";
export const DWELLIR_GRPC_ENDPOINT = "https://api-hyperliquid-mainnet-grpc.n.dwellir.com";
export const DWELLIR_ORDERBOOK_WS_ENDPOINT =
  "wss://api-hyperliquid-mainnet-orderbook.n.dwellir.com";
export const DWELLIR_GRPC_SERVICE = "hyperliquid_l1_gateway.v2.HyperliquidL1Gateway";
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_WATCHDOG_TIMEOUT_MS = 5_000;
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_GRPC_BACKOFF_BASE_MS = 50;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
export const DEFAULT_GRPC_FATAL_DROP_MS = 200;
export const DEFAULT_DWELLIR_GRPC_FILLS_WATCHDOG_TIMEOUT_MS = 60_000;
export const DEFAULT_DWELLIR_GRPC_START_LOOKBACK_MS = 1_000;
export const DEFAULT_DWELLIR_GRPC_FORWARD_MAX_AGE_MS = 5_000;
export const DEFAULT_SOURCE_WEIGHT = 1;
export const HYPERLIQUID_PUBLIC_L2_DEPTH_LIMIT = 20;
export const DWELLIR_MAX_L2_DEPTH_LIMIT = 100;
export const DEFAULT_HYPERLIQUID_ASSET_MATRIX = ["BTC", "ETH", "HYPE", "SOL"] as const;

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
