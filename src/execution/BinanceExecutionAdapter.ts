import { decimalPlaces, positiveOrNull, roundLatency, shortHash } from "./ExecutionFormatters";
import { exchangeSecret } from "./SecretResolver";
import { isRecord, requireString, safeJson } from "./ResponseParsing";
import { SignatureEngine } from "../utils/SignatureEngine";
import type { Env } from "../types";

const BINANCE_US_BASE_URL = "https://api.binance.us";
const DEFAULT_RECV_WINDOW_MS = 5_000;
const MAX_RECV_WINDOW_MS = 60_000;

interface BinanceSymbolFilters {
  symbol: string;
  tickSize: number | null;
  tickPrecision: number;
  stepSize: number | null;
  stepPrecision: number;
  minQty: number | null;
  minNotional: number | null;
  loadedAt: number;
}

export interface PreparedBinanceRequest {
  endpoint: string;
  init: RequestInit;
  signingLatencyMs: number;
  redactedPayload: Record<string, unknown>;
}

const binanceFilterCache = new Map<string, BinanceSymbolFilters>();

export async function binanceSignedRequest(
  env: Env,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string>
): Promise<PreparedBinanceRequest> {
  const apiKey = requireString(await exchangeSecret(env, "EXCHANGE_API_KEY"), "EXCHANGE_API_KEY");
  const secret = requireString(
    (await exchangeSecret(env, "EXCHANGE_API_SECRET")) ??
      (await exchangeSecret(env, "EXCHANGE_HMAC_SECRET")),
    "EXCHANGE_API_SECRET"
  );
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== "") {
      query.set(key, value);
    }
  }

  query.set("recvWindow", String(recvWindowMs(env)));
  query.set("timestamp", String(Date.now()));

  const unsigned = query.toString();
  const signingStartedAt = performance.now();
  const signature = await SignatureEngine.sign({
    algorithm: "HMAC-SHA256",
    secret,
    payload: unsigned
  });
  const signingLatencyMs = roundLatency(performance.now() - signingStartedAt);
  query.set("signature", signature);

  const baseUrl = binanceBaseUrl(env);
  const body = query.toString();
  const headers = {
    "X-MBX-APIKEY": apiKey,
    accept: "application/json"
  };

  if (method === "GET") {
    return {
      endpoint: `${baseUrl}${path}?${body}`,
      init: { method, headers },
      signingLatencyMs,
      redactedPayload: redactBinanceParams(params)
    };
  }

  return {
    endpoint: `${baseUrl}${path}`,
    init: {
      method,
      headers: {
        ...headers,
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body
    },
    signingLatencyMs,
    redactedPayload: redactBinanceParams(params)
  };
}

export async function getBinanceSymbolFilters(
  env: Env,
  symbol: string
): Promise<BinanceSymbolFilters> {
  const cached = binanceFilterCache.get(symbol);
  if (cached && Date.now() - cached.loadedAt < 10 * 60 * 1000) {
    return cached;
  }

  const response = await fetch(
    `${binanceBaseUrl(env)}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`,
    { headers: { accept: "application/json" } }
  );
  const body = await safeJson(response);

  if (!response.ok) {
    throw new Error(`BINANCE_EXCHANGE_INFO_FAILED_${response.status}`);
  }

  const symbols = Array.isArray(body?.symbols) ? body.symbols.filter(isRecord) : [];
  const symbolInfo = symbols.find((entry) => entry.symbol === symbol);
  if (!symbolInfo) {
    throw new Error(`BINANCE_SYMBOL_NOT_FOUND_${symbol}`);
  }

  const filters = Array.isArray(symbolInfo.filters) ? symbolInfo.filters.filter(isRecord) : [];
  const priceFilter = filters.find((filter) => filter.filterType === "PRICE_FILTER");
  const lotFilter = filters.find((filter) => filter.filterType === "LOT_SIZE");
  const minNotionalFilter =
    filters.find((filter) => filter.filterType === "MIN_NOTIONAL") ??
    filters.find((filter) => filter.filterType === "NOTIONAL");
  const tickSizeText = typeof priceFilter?.tickSize === "string" ? priceFilter.tickSize : undefined;
  const stepSizeText = typeof lotFilter?.stepSize === "string" ? lotFilter.stepSize : undefined;
  const filtersForSymbol: BinanceSymbolFilters = {
    symbol,
    tickSize: positiveOrNull(priceFilter?.tickSize),
    tickPrecision: decimalPlaces(tickSizeText ?? priceFilter?.tickSize),
    stepSize: positiveOrNull(lotFilter?.stepSize),
    stepPrecision: decimalPlaces(stepSizeText ?? lotFilter?.stepSize),
    minQty: positiveOrNull(lotFilter?.minQty),
    minNotional: positiveOrNull(minNotionalFilter?.minNotional),
    loadedAt: Date.now()
  };

  binanceFilterCache.set(symbol, filtersForSymbol);
  return filtersForSymbol;
}

export function binanceSymbol(instrumentCode: string): string {
  const normalized = instrumentCode.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!normalized) {
    throw new Error("BINANCE_SYMBOL_EMPTY");
  }
  return normalized;
}

export function instrumentFromBinanceSymbol(symbol: string | undefined): string | undefined {
  if (!symbol) {
    return undefined;
  }

  if (symbol.endsWith("USDT")) {
    return `${symbol.slice(0, -4)}-USDT`.toLowerCase();
  }
  if (symbol.endsWith("USD")) {
    return `${symbol.slice(0, -3)}-USD`.toLowerCase();
  }
  if (symbol.endsWith("BTC")) {
    return `${symbol.slice(0, -3)}-BTC`.toLowerCase();
  }
  if (symbol.endsWith("ETH")) {
    return `${symbol.slice(0, -3)}-ETH`.toLowerCase();
  }

  return symbol.toLowerCase();
}

export function binanceClientOrderId(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]/g, "_");
  if (sanitized.length <= 36) {
    return sanitized;
  }

  const suffix = shortHash(value);
  return `${sanitized.slice(0, 27)}_${suffix}`.slice(0, 36);
}

export function isBinanceOrderTestMode(env: Env): boolean {
  return env.EXCHANGE_ORDER_TEST_MODE !== "false";
}

function recvWindowMs(env: Env): number {
  const parsed = Number(env.EXCHANGE_RECV_WINDOW_MS ?? DEFAULT_RECV_WINDOW_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RECV_WINDOW_MS;
  }
  return Math.min(Math.round(parsed), MAX_RECV_WINDOW_MS);
}

function binanceBaseUrl(env: Env): string {
  return (env.EXCHANGE_BASE_URL ?? BINANCE_US_BASE_URL).replace(/\/+$/, "");
}

function redactBinanceParams(params: Record<string, string>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key.toLowerCase().includes("signature")) {
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
}
