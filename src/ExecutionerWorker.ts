import { ConfigManager } from "./ConfigManager";
import { Logger } from "./Logger";
import { RateLimiter } from "./utils/RateLimiter";
import { SignatureEngine } from "./utils/SignatureEngine";
import type { Env, ExchangeOpenOrder, ExecutionReport, TradeIntent } from "./types";

const SINGLETON_ENGINE_NAME = "sovereign-sigma:singleton:trading-engine:v1";
const BINANCE_US_BASE_URL = "https://api.binance.us";
const DEFAULT_RECV_WINDOW_MS = 5_000;
const MAX_RECV_WINDOW_MS = 60_000;
const limiter = new RateLimiter();
limiter.configure("default", 10, 10);

type ExchangeAdapter = "generic-json" | "binance-us";

interface PreparedExchangeRequest {
  endpoint: string;
  init: RequestInit;
  signingLatencyMs: number;
  redactedPayload: Record<string, unknown>;
}

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

const binanceFilterCache = new Map<string, BinanceSymbolFilters>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const logger = new Logger(
      env.TRADING_DB,
      (promise) => ctx.waitUntil(promise),
      "ExecutionerWorker"
    );
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "sovereign-sigma-executioner" });
    }

    if (request.method === "POST" && url.pathname === "/execute") {
      return executeIntent(request, env, ctx, logger);
    }

    if (request.method === "POST" && url.pathname === "/cancel") {
      return cancelOrder(request, env, ctx, logger);
    }

    if (request.method === "POST" && url.pathname === "/cancel-all") {
      return cancelAllOrders(request, env, ctx, logger);
    }

    if (request.method === "GET" && url.pathname === "/open-orders") {
      return listOpenOrders(env, logger);
    }

    if (request.method === "GET" && url.pathname === "/account/balance") {
      return getAccountBalance(env, logger);
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
} satisfies ExportedHandler<Env>;

async function executeIntent(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger
): Promise<Response> {
  const config = await new ConfigManager(env.CONFIG_STORE).fetchConfig();

  if (!config.TRADING_ENABLED) {
    return json({ ok: false, error: "Trading disabled" }, 423);
  }

  const intent = await request.json<TradeIntent>();
  validateIntent(intent);

  const preTrade = await validatePreTrade(env, intent);
  if (!preTrade.ok) {
    const report = rejectedReport(intent, preTrade.reason, preTrade.status);
    ctx.waitUntil(forwardReport(env, report));
    logger.warn("EXECUTION_PRE_TRADE_REJECTED", "Pre-trade execution guard rejected intent", {
      intentId: intent.intentId,
      reason: preTrade.reason,
      status: preTrade.status
    });
    return json({ ok: false, report, error: preTrade.reason }, preTrade.status);
  }

  const priority = intent.action === "SELL" && intent.orderType === "MARKET" ? "HEDGE" : "NEW";
  const reservation = limiter.reserve(intent.source_exchange ?? "default", priority);

  if (!reservation.allowed) {
    ctx.waitUntil(delay(reservation.waitMs));
    return json({ ok: false, error: "Rate limited", retryAfterMs: reservation.waitMs }, 429);
  }

  let exchangeRequest: PreparedExchangeRequest;

  try {
    exchangeRequest = await prepareOrderRequest(env, intent, resolveAdapter(env));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "EXECUTION_ADAPTER_ERROR";
    const report = rejectedReport(intent, reason, 503);
    ctx.waitUntil(forwardReport(env, report));
    logger.error("EXECUTION_ADAPTER_REJECTED", "Execution adapter failed closed", {
      intentId: intent.intentId,
      reason
    });
    return json({ ok: false, report, error: reason }, 503);
  }

  if (exchangeRequest.signingLatencyMs > 1) {
    logger.warn("SIGNATURE_LATENCY_SPIKE", "Exchange signature exceeded 1ms target", {
      intentId: intent.intentId,
      signingLatencyMs: exchangeRequest.signingLatencyMs,
      algorithm: env.SIGNATURE_ALGORITHM ?? "auto"
    });
  }

  const startedAt = Date.now();
  let response: Response;
  let body: Record<string, unknown> | null;

  try {
    response = await fetch(exchangeRequest.endpoint, exchangeRequest.init);
    body = await safeJson(response);
    if (resolveAdapter(env) === "binance-us" && isBinanceOrderTestMode(env) && response.ok) {
      body = {
        ...(body ?? {}),
        status: "TEST_ACCEPTED",
        message: "Binance.US test order validated; no live order was placed."
      };
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const reason = error instanceof Error ? error.message : "TRANSPORT_ERROR";
    const report = rejectedReport(intent, reason, 503, latencyMs);
    ctx.waitUntil(forwardReport(env, report));
    logger.error("EXCHANGE_TRANSPORT_FAILED", "Exchange transport failed", {
      intentId: intent.intentId,
      reason,
      latencyMs
    });
    return json({ ok: false, report, error: reason }, 503);
  }

  const report = toExecutionReport(intent, response, body, Date.now() - startedAt);
  ctx.waitUntil(forwardReport(env, report));

  if (!response.ok || report.status === "REJECTED") {
    logger.error("EXCHANGE_ORDER_REJECTED", "Exchange rejected execution request", {
      intentId: intent.intentId,
      status: response.status,
      rawStatus: report.rawStatus ?? null,
      reason: report.reason ?? null,
      bodyJson: JSON.stringify(body)
    });
    return json({ ok: false, report, body }, response.status || 502);
  }

  logger.info("EXCHANGE_ORDER_SUBMITTED", "Execution request submitted", {
    intentId: intent.intentId,
    status: response.status,
    exchangeOrderId: report.exchangeOrderId ?? null,
    signingLatencyMs: exchangeRequest.signingLatencyMs,
    payloadJson: JSON.stringify(exchangeRequest.redactedPayload),
    reportJson: JSON.stringify(report)
  });

  return json({ ok: true, report, body });
}

async function cancelOrder(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger
): Promise<Response> {
  const payload = await request.json<{ orderId?: string; instrumentCode?: string; reason?: string }>();
  const orderId = requireString(payload.orderId, "orderId");
  const response = await sendCancel(env, {
    order_id: orderId,
    instrument: payload.instrumentCode,
    reason: payload.reason ?? "CANCEL"
  });
  const body = await safeJson(response);
  const report = cancelExecutionReport(orderId, payload.instrumentCode, response, body);
  ctx.waitUntil(forwardReport(env, report));

  logger.warn("EXCHANGE_CANCEL_SENT", "Cancel request sent to exchange adapter", {
    orderId,
    instrumentCode: payload.instrumentCode ?? null,
    reason: payload.reason ?? "CANCEL",
    status: response.status
  });
  return json(
    { ok: response.ok, status: response.status, report, body },
    response.status === 204 ? 200 : response.status
  );
}

async function cancelAllOrders(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger
): Promise<Response> {
  const payload = await request.json<{ instrumentCode?: string; reason?: string }>();
  const response = await sendCancel(env, {
    instrument: payload.instrumentCode ?? "ALL",
    cancel_all: true,
    reason: payload.reason ?? "CANCEL_ALL"
  });
  const body = await safeJson(response);

  logger.warn("EXCHANGE_CANCEL_ALL_SENT", "Cancel-all request sent to exchange adapter", {
    instrumentCode: payload.instrumentCode ?? "ALL",
    reason: payload.reason ?? "CANCEL_ALL",
    status: response.status
  });
  ctx.waitUntil(Promise.resolve());
  return json(
    { ok: response.ok, status: response.status, body },
    response.status === 204 ? 200 : response.status
  );
}

async function listOpenOrders(env: Env, logger: Logger): Promise<Response> {
  if (resolveAdapter(env) === "binance-us") {
    return listBinanceOpenOrders(env, logger);
  }

  const endpoint = env.EXCHANGE_OPEN_ORDERS_ENDPOINT;

  if (!endpoint) {
    return json({ ok: true, orders: [] });
  }

  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: "application/json",
        ...(await signHeaders(env, ""))
      }
    });
    const body = await safeJson(response);
    const orders = normalizeOpenOrders(body);

    return json({ ok: response.ok, orders }, response.status);
  } catch (error) {
    logger.error("OPEN_ORDERS_FETCH_FAILED", "Failed to fetch exchange open orders", {
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
    return json({ ok: false, orders: [], error: "OPEN_ORDERS_FETCH_FAILED" }, 503);
  }
}

async function getAccountBalance(env: Env, logger: Logger): Promise<Response> {
  if (resolveAdapter(env) === "binance-us") {
    return getBinanceAccountBalance(env, logger);
  }

  const endpoint = env.EXCHANGE_ACCOUNT_BALANCE_ENDPOINT;

  if (!endpoint) {
    return json({
      ok: false,
      error: "EXCHANGE_ACCOUNT_BALANCE_ENDPOINT_NOT_CONFIGURED"
    }, 503);
  }

  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: "application/json",
        ...(await signHeaders(env, ""))
      }
    });
    const body = await safeJson(response);

    logger.info("EXCHANGE_BALANCE_TESTED", "Exchange account balance endpoint tested", {
      status: response.status,
      ok: response.ok
    });

    return json({ ok: response.ok, status: response.status, body }, response.ok ? 200 : 502);
  } catch (error) {
    logger.error("EXCHANGE_BALANCE_TEST_FAILED", "Failed to test exchange account balance endpoint", {
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
    return json({ ok: false, error: "EXCHANGE_BALANCE_TEST_FAILED" }, 503);
  }
}

function exchangePayload(
  intent: TradeIntent,
  adapter: ExchangeAdapter
): Record<string, unknown> {
  if (adapter !== "generic-json") {
    throw new Error("UNSUPPORTED_EXCHANGE_ADAPTER");
  }

  return {
    client_id: intent.intentId,
    symbol: intent.instrumentCode,
    market: intent.marketKey,
    side: intent.action,
    type: intent.orderType,
    price: intent.expectedPrice,
    size: intent.approvedSize ?? intent.requestedSize,
    post_only: intent.postOnly,
    time_in_force: intent.timeInForce,
    reduce_only: intent.rationale.includes("hedge") || intent.rationale.includes("closeout"),
    slippage_bps: intent.maxSlippageBps
  };
}

async function prepareOrderRequest(
  env: Env,
  intent: TradeIntent,
  adapter: ExchangeAdapter
): Promise<PreparedExchangeRequest> {
  if (adapter === "binance-us") {
    return prepareBinanceOrderRequest(env, intent);
  }

  const payload = exchangePayload(intent, adapter);
  const endpoint = requireEndpoint(
    env.EXCHANGE_ORDER_ENDPOINT ?? env.EXCHANGE_BASE_URL,
    "EXCHANGE_ORDER_ENDPOINT"
  );
  const body = JSON.stringify(payload);
  const signingStartedAt = performance.now();
  const headers = await signHeaders(env, body);

  return {
    endpoint,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers
      },
      body
    },
    signingLatencyMs: roundLatency(performance.now() - signingStartedAt),
    redactedPayload: payload
  };
}

async function prepareBinanceOrderRequest(
  env: Env,
  intent: TradeIntent
): Promise<PreparedExchangeRequest> {
  const symbol = binanceSymbol(intent.instrumentCode);
  const filters = await getBinanceSymbolFilters(env, symbol);
  const requestedQuantity = positive(intent.approvedSize ?? intent.requestedSize, "ORDER_SIZE");
  const quantity = filters.stepSize
    ? floorToIncrement(requestedQuantity, filters.stepSize)
    : requestedQuantity;

  if (quantity <= 0) {
    throw new Error("BINANCE_QUANTITY_ROUNDED_TO_ZERO");
  }

  if (filters.minQty !== null && quantity + 1e-12 < filters.minQty) {
    throw new Error("BINANCE_QUANTITY_BELOW_MIN_QTY");
  }

  const expectedPrice = positive(intent.expectedPrice, "EXPECTED_PRICE");
  const params: Record<string, string> = {
    symbol,
    side: intent.action,
    quantity: formatDecimal(quantity, filters.stepPrecision),
    newClientOrderId: binanceClientOrderId(intent.intentId),
    newOrderRespType: "FULL"
  };

  if (intent.orderType === "MARKET") {
    params.type = "MARKET";
  } else {
    const snappedPrice = filters.tickSize
      ? snapPrice(expectedPrice, filters.tickSize, intent.action)
      : expectedPrice;

    if (snappedPrice <= 0) {
      throw new Error("BINANCE_PRICE_ROUNDED_TO_ZERO");
    }

    params.price = formatDecimal(snappedPrice, filters.tickPrecision);
    params.type = intent.postOnly ? "LIMIT_MAKER" : "LIMIT";

    if (!intent.postOnly) {
      params.timeInForce =
        intent.orderType === "IOC" || intent.orderType === "FOK"
          ? intent.orderType
          : intent.timeInForce;
    }
  }

  const notionalPrice = Number(params.price ?? expectedPrice);
  if (
    filters.minNotional !== null &&
    Number.isFinite(notionalPrice) &&
    quantity * notionalPrice + 1e-8 < filters.minNotional
  ) {
    throw new Error("BINANCE_MIN_NOTIONAL_NOT_MET");
  }

  const path = isBinanceOrderTestMode(env) ? "/api/v3/order/test" : "/api/v3/order";
  const signed = await binanceSignedRequest(env, "POST", path, params);

  return {
    ...signed,
    redactedPayload: {
      adapter: "binance-us",
      path,
      symbol,
      side: params.side,
      type: params.type,
      timeInForce: params.timeInForce ?? null,
      price: params.price ?? null,
      quantity: params.quantity,
      postOnly: intent.postOnly,
      testMode: isBinanceOrderTestMode(env)
    }
  };
}

async function validatePreTrade(
  env: Env,
  intent: TradeIntent
): Promise<{ ok: true } | { ok: false; reason: string; status: number }> {
  const snapshot = await fetchBookSnapshot(env, intent.instrumentCode);

  if (!snapshot) {
    return { ok: true };
  }

  const bestBid = finiteNumber(snapshot.bestBid);
  const bestAsk = finiteNumber(snapshot.bestAsk);
  const tickSize = finiteNumber(snapshot.tickSize) ?? 0;
  const guardTicks = Number(env.SLIPPAGE_GUARD_TICKS ?? 0);
  const guard = tickSize * (Number.isFinite(guardTicks) && guardTicks > 0 ? guardTicks : 0);
  const requestedSize = intent.approvedSize ?? intent.requestedSize;

  if (intent.postOnly) {
    if (intent.action === "BUY" && bestAsk !== null && intent.expectedPrice >= bestAsk) {
      return { ok: false, reason: "POST_ONLY_WOULD_CROSS", status: 409 };
    }
    if (intent.action === "SELL" && bestBid !== null && intent.expectedPrice <= bestBid) {
      return { ok: false, reason: "POST_ONLY_WOULD_CROSS", status: 409 };
    }
  }

  if (guard > 0) {
    const touch = intent.action === "BUY" ? bestAsk : bestBid;
    if (touch !== null && Math.abs(touch - intent.expectedPrice) > guard) {
      return { ok: false, reason: "BBO_DRIFT_EXCEEDED", status: 409 };
    }
  }

  if (intent.timeInForce === "FOK") {
    const levels = intent.action === "BUY" ? snapshot.asks ?? [] : snapshot.bids ?? [];
    const fillableSize = levels
      .filter((level) =>
        intent.action === "BUY"
          ? level.price <= intent.expectedPrice
          : level.price >= intent.expectedPrice
      )
      .reduce((sum, level) => sum + level.size, 0);

    if (fillableSize + 0.00000001 < requestedSize) {
      return { ok: false, reason: "FOK_NOT_FULLY_FILLABLE", status: 409 };
    }
  }

  return { ok: true };
}

async function fetchBookSnapshot(
  env: Env,
  instrumentCode: string
): Promise<{
  bestBid?: number;
  bestAsk?: number;
  tickSize?: number;
  bids?: Array<{ price: number; size: number }>;
  asks?: Array<{ price: number; size: number }>;
} | null> {
  try {
    const id = env.TRADING_ENGINE.idFromName(SINGLETON_ENGINE_NAME);
    const engine = env.TRADING_ENGINE.get(id);
    const response = await engine.fetch(
      new Request(
        `https://trading-engine.internal/book/snapshot?instrumentCode=${encodeURIComponent(instrumentCode)}`
      )
    );

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

async function sendCancel(
  env: Env,
  payload: Record<string, unknown>
): Promise<Response> {
  if (resolveAdapter(env) === "binance-us") {
    if (payload.cancel_all) {
      return cancelBinanceOpenOrders(env, stringField(payload, ["instrument"]));
    }

    const symbol = stringField(payload, ["instrument"]);
    if (!symbol || symbol === "ALL") {
      throw new Error("BINANCE_CANCEL_REQUIRES_INSTRUMENT_CODE");
    }

    const orderId = requireString(stringField(payload, ["order_id", "orderId"]), "orderId");
    const params: Record<string, string> = { symbol: binanceSymbol(symbol) };

    if (/^\d+$/.test(orderId)) {
      params.orderId = orderId;
    } else {
      params.origClientOrderId = orderId;
    }

    const signed = await binanceSignedRequest(env, "DELETE", "/api/v3/order", params);
    return fetch(signed.endpoint, signed.init);
  }

  const endpoint = requireEndpoint(env.EXCHANGE_CANCEL_ENDPOINT, "EXCHANGE_CANCEL_ENDPOINT");
  const body = JSON.stringify(payload);

  return fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(await signHeaders(env, body))
    },
    body
  });
}

async function listBinanceOpenOrders(env: Env, logger: Logger): Promise<Response> {
  try {
    const signed = await binanceSignedRequest(env, "GET", "/api/v3/openOrders", {});
    const response = await fetch(signed.endpoint, signed.init);
    const body = await safeJson(response);
    const orders = normalizeOpenOrders(body);

    logger.info("BINANCE_OPEN_ORDERS_SYNCED", "Fetched Binance.US open orders", {
      status: response.status,
      count: orders.length,
      signingLatencyMs: signed.signingLatencyMs
    });

    return json({ ok: response.ok, status: response.status, orders, body }, response.ok ? 200 : 502);
  } catch (error) {
    logger.error("BINANCE_OPEN_ORDERS_FAILED", "Failed to fetch Binance.US open orders", {
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
    return json({ ok: false, orders: [], error: "BINANCE_OPEN_ORDERS_FAILED" }, 503);
  }
}

async function getBinanceAccountBalance(env: Env, logger: Logger): Promise<Response> {
  try {
    const signed = await binanceSignedRequest(env, "GET", "/api/v3/account", {});
    const response = await fetch(signed.endpoint, signed.init);
    const body = await safeJson(response);

    logger.info("BINANCE_ACCOUNT_BALANCE_TESTED", "Binance.US account endpoint tested", {
      status: response.status,
      ok: response.ok,
      signingLatencyMs: signed.signingLatencyMs
    });

    return json({ ok: response.ok, status: response.status, body }, response.ok ? 200 : 502);
  } catch (error) {
    logger.error("BINANCE_ACCOUNT_BALANCE_FAILED", "Failed to test Binance.US account endpoint", {
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
    return json({ ok: false, error: "BINANCE_ACCOUNT_BALANCE_FAILED" }, 503);
  }
}

async function cancelBinanceOpenOrders(env: Env, instrumentCode?: string): Promise<Response> {
  if (instrumentCode && instrumentCode !== "ALL") {
    const signed = await binanceSignedRequest(env, "DELETE", "/api/v3/openOrders", {
      symbol: binanceSymbol(instrumentCode)
    });
    return fetch(signed.endpoint, signed.init);
  }

  const openOrdersRequest = await binanceSignedRequest(env, "GET", "/api/v3/openOrders", {});
  const openOrdersResponse = await fetch(openOrdersRequest.endpoint, openOrdersRequest.init);
  const openOrdersBody = await safeJson(openOrdersResponse);
  const openOrders = normalizeOpenOrders(openOrdersBody);

  if (!openOrdersResponse.ok) {
    return new Response(JSON.stringify({ ok: false, status: openOrdersResponse.status, body: openOrdersBody }), {
      status: 502,
      headers: { "content-type": "application/json;charset=UTF-8" }
    });
  }

  const results: Array<{ orderId: string; instrumentCode: string; status: number; ok: boolean }> = [];
  for (const order of openOrders) {
    const signed = await binanceSignedRequest(env, "DELETE", "/api/v3/order", {
      symbol: binanceSymbol(order.instrumentCode),
      orderId: order.exchangeOrderId
    });
    const response = await fetch(signed.endpoint, signed.init);
    results.push({
      orderId: order.exchangeOrderId,
      instrumentCode: order.instrumentCode,
      status: response.status,
      ok: response.ok
    });
  }

  const ok = results.every((result) => result.ok);
  return new Response(JSON.stringify({ ok, cancelled: results.length, results }), {
    status: ok ? 200 : 502,
    headers: { "content-type": "application/json;charset=UTF-8" }
  });
}

async function binanceSignedRequest(
  env: Env,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string>
): Promise<PreparedExchangeRequest> {
  const apiKey = requireString(env.EXCHANGE_API_KEY, "EXCHANGE_API_KEY");
  const secret = requireString(env.EXCHANGE_API_SECRET ?? env.EXCHANGE_HMAC_SECRET, "EXCHANGE_API_SECRET");
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

async function getBinanceSymbolFilters(env: Env, symbol: string): Promise<BinanceSymbolFilters> {
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

function binanceSymbol(instrumentCode: string): string {
  const normalized = instrumentCode.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!normalized) {
    throw new Error("BINANCE_SYMBOL_EMPTY");
  }
  return normalized;
}

function instrumentFromBinanceSymbol(symbol: string | undefined): string | undefined {
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

function binanceClientOrderId(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]/g, "_");
  if (sanitized.length <= 36) {
    return sanitized;
  }

  const suffix = shortHash(value);
  return `${sanitized.slice(0, 27)}_${suffix}`.slice(0, 36);
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function snapPrice(value: number, tickSize: number, side: "BUY" | "SELL"): number {
  return side === "BUY" ? floorToIncrement(value, tickSize) : ceilToIncrement(value, tickSize);
}

function floorToIncrement(value: number, increment: number): number {
  const precision = decimalPlaces(increment);
  return Number((Math.floor((value + Number.EPSILON) / increment) * increment).toFixed(precision));
}

function ceilToIncrement(value: number, increment: number): number {
  const precision = decimalPlaces(increment);
  return Number((Math.ceil((value - Number.EPSILON) / increment) * increment).toFixed(precision));
}

function formatDecimal(value: number, precision: number): string {
  const fixed = value.toFixed(Math.max(0, Math.min(12, precision)));
  const compact = fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
  return compact.length > 0 ? compact : "0";
}

function decimalPlaces(value: unknown): number {
  const text = String(value ?? "");

  if (text.includes("e-")) {
    const exponent = Number(text.split("e-")[1]);
    return Number.isFinite(exponent) ? exponent : 8;
  }

  const [, decimals = ""] = text.split(".");
  return decimals.replace(/0+$/, "").length;
}

function positive(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`INVALID_${field}`);
  }
  return parsed;
}

function positiveOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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

function isBinanceOrderTestMode(env: Env): boolean {
  return env.EXCHANGE_ORDER_TEST_MODE !== "false";
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

async function signHeaders(env: Env, payload: string): Promise<Record<string, string>> {
  const configuredAlgorithm = env.SIGNATURE_ALGORITHM;

  if (configuredAlgorithm === "ED25519") {
    if (!env.EXCHANGE_ED25519_PRIVATE_KEY) {
      throw new Error("MISSING_EXCHANGE_ED25519_PRIVATE_KEY");
    }

    return {
      "x-signature": await SignatureEngine.sign({
        algorithm: "ED25519",
        secret: env.EXCHANGE_ED25519_PRIVATE_KEY,
        payload
      })
    };
  }

  if (configuredAlgorithm === "HMAC-SHA256" || (!configuredAlgorithm && env.EXCHANGE_HMAC_SECRET)) {
    if (!env.EXCHANGE_HMAC_SECRET) {
      return {};
    }

    return {
      "x-signature": await SignatureEngine.sign({
        algorithm: "HMAC-SHA256",
        secret: env.EXCHANGE_HMAC_SECRET,
        payload
      })
    };
  }

  if (!configuredAlgorithm && env.EXCHANGE_ED25519_PRIVATE_KEY) {
    return {
      "x-signature": await SignatureEngine.sign({
        algorithm: "ED25519",
        secret: env.EXCHANGE_ED25519_PRIVATE_KEY,
        payload
      })
    };
  }

  throw new Error("UNSUPPORTED_SIGNATURE_ALGORITHM");
}

function toExecutionReport(
  intent: TradeIntent,
  response: Response,
  body: Record<string, unknown> | null,
  latencyMs: number
): ExecutionReport {
  const exchangeOrderId = stringField(body, [
    "order_id",
    "orderId",
    "id",
    "exchange_order_id",
    "clientOrderId"
  ]);
  const filledSize = Number(
    numberField(body, ["filled_size", "filledSize", "executed_size", "executedQty"]) ?? 0
  );
  const rawStatus = stringField(body, ["status", "state", "order_status"]);
  const status = normalizeOrderStatus(rawStatus, response.ok, filledSize, intent.approvedSize ?? intent.requestedSize);

  return {
    clientId: intent.intentId,
    exchangeOrderId,
    instrumentCode: intent.instrumentCode,
    side: intent.action,
    orderSize: intent.approvedSize ?? intent.requestedSize,
    status,
    filledSize,
    achievedPrice:
      averageExecutionPrice(body) ??
      numberField(body, ["price", "avg_price", "average_price"]) ??
      intent.expectedPrice,
    expectedPrice: intent.expectedPrice,
    fees: extractFees(body),
    latencyMs,
    reason: response.ok ? undefined : String(body?.message ?? body?.error ?? response.status),
    rawStatus: rawStatus ?? undefined,
    observedAt: new Date().toISOString()
  };
}

function cancelExecutionReport(
  orderId: string,
  instrumentCode: string | undefined,
  response: Response,
  body: Record<string, unknown> | null
): ExecutionReport {
  const rawStatus = stringField(body, ["status", "state", "order_status"]);
  const clientId =
    stringField(body, ["clientOrderId", "origClientOrderId", "client_id", "clientId"]) ?? orderId;
  const exchangeOrderId = stringField(body, ["orderId", "order_id", "id", "exchange_order_id"]) ?? orderId;
  const resolvedInstrument =
    instrumentCode ??
    instrumentFromBinanceSymbol(stringField(body, ["symbol"])) ??
    stringField(body, ["instrument", "instrument_code"]);
  const filledSize = numberField(body, ["executedQty", "filled_size", "filledSize", "executed_size"]) ?? 0;
  const orderSize = numberField(body, ["origQty", "size", "quantity", "order_size"]);

  return {
    clientId,
    exchangeOrderId,
    instrumentCode: resolvedInstrument,
    side: normalizeSide(stringField(body, ["side"])),
    orderSize,
    status: normalizeOrderStatus(rawStatus ?? "CANCELED", response.ok, filledSize, orderSize ?? 0),
    filledSize,
    achievedPrice: averageExecutionPrice(body) ?? numberField(body, ["price", "avg_price", "average_price"]),
    fees: extractFees(body),
    latencyMs: 0,
    reason: response.ok ? "CANCEL_ACKNOWLEDGED" : String(body?.message ?? body?.error ?? response.status),
    rawStatus: rawStatus ?? undefined,
    observedAt: new Date().toISOString()
  };
}

function averageExecutionPrice(body: Record<string, unknown> | null): number | undefined {
  const executedQty = numberField(body, ["executedQty", "filled_size", "filledSize", "executed_size"]);
  const cumulativeQuote = numberField(body, ["cummulativeQuoteQty", "cumulativeQuoteQty", "filled_quote"]);

  if (executedQty && cumulativeQuote && executedQty > 0 && cumulativeQuote > 0) {
    return cumulativeQuote / executedQty;
  }

  return undefined;
}

function extractFees(body: Record<string, unknown> | null): number {
  const directFee = numberField(body, ["fees", "fee", "commission"]);
  if (directFee !== undefined) {
    return directFee;
  }

  const fills = Array.isArray(body?.fills) ? body.fills.filter(isRecord) : [];
  return fills.reduce((sum, fill) => sum + (numberField(fill, ["commission"]) ?? 0), 0);
}

async function forwardReport(env: Env, report: ExecutionReport): Promise<void> {
  const id = env.TRADING_ENGINE.idFromName(SINGLETON_ENGINE_NAME);
  const engine = env.TRADING_ENGINE.get(id);
  await engine.fetch(
    new Request("https://trading-engine.internal/execution/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report)
    })
  );
}

function rejectedReport(
  intent: TradeIntent,
  reason: string,
  statusCode: number,
  latencyMs = 0
): ExecutionReport {
  return {
    clientId: intent.intentId,
    instrumentCode: intent.instrumentCode,
    side: intent.action,
    orderSize: intent.approvedSize ?? intent.requestedSize,
    status: "REJECTED",
    filledSize: 0,
    achievedPrice: intent.expectedPrice,
    expectedPrice: intent.expectedPrice,
    fees: 0,
    latencyMs,
    reason: `${reason}:${statusCode}`,
    observedAt: new Date().toISOString()
  };
}

function validateIntent(intent: TradeIntent): void {
  if (intent?.schemaVersion !== "trade-intent.v1" || !intent.intentId) {
    throw new Error("INVALID_TRADE_INTENT");
  }
}

function resolveAdapter(env: Env): ExchangeAdapter {
  const adapter = env.EXCHANGE_ADAPTER ?? "generic-json";

  if (adapter === "generic-json" || adapter === "binance-us") {
    return adapter;
  }

  throw new Error(`UNSUPPORTED_EXCHANGE_ADAPTER_${adapter}`);
}

function normalizeOpenOrders(body: Record<string, unknown> | null): ExchangeOpenOrder[] {
  const rawOrders = Array.isArray(body?.orders)
    ? body.orders
    : Array.isArray(body?.data)
      ? body.data
      : [];

  return rawOrders
    .filter(isRecord)
    .map((order) => {
      const rawSymbol = stringField(order, ["symbol", "instrument", "instrument_code"]);
      return {
        clientId: stringField(order, ["client_id", "clientId", "clientOrderId", "origClientOrderId"]) ?? null,
        exchangeOrderId: requireString(
          stringField(order, ["order_id", "orderId", "id", "exchange_order_id"]),
          "exchangeOrderId"
        ),
        instrumentCode: requireString(
          instrumentFromBinanceSymbol(rawSymbol) ?? rawSymbol?.toLowerCase(),
          "instrumentCode"
        ),
        side: normalizeSide(stringField(order, ["side"])),
        price: numberField(order, ["price", "stopPrice"]) ?? 0,
        size: numberField(order, ["origQty", "size", "quantity", "order_size"]) ?? 0,
        filledSize: numberField(order, ["executedQty", "filled_size", "filledSize", "executed_size"]) ?? 0,
        status: normalizeOrderStatus(stringField(order, ["status", "state"]), true, 0, 1),
        observedAt: new Date().toISOString()
      };
    });
}

function normalizeOrderStatus(
  rawStatus: string | undefined,
  responseOk: boolean,
  filledSize: number,
  orderSize: number
): ExecutionReport["status"] {
  if (!responseOk) {
    return "REJECTED";
  }

  const normalized = rawStatus?.toLowerCase();
  if (!normalized && orderSize > 0 && filledSize >= orderSize) {
    return "FILLED";
  }
  if (normalized === "test_accepted") {
    return "CANCELLED";
  }
  if (normalized?.includes("reject")) {
    return "REJECTED";
  }
  if (normalized?.includes("expired")) {
    return "REJECTED";
  }
  if (normalized?.includes("cancel")) {
    return "CANCELLED";
  }
  if (normalized?.includes("partial")) {
    return "PARTIAL_FILL";
  }
  if (normalized === "new" || normalized === "pending_cancel") {
    return "OPEN";
  }
  if (normalized?.includes("fill") || (orderSize > 0 && filledSize >= orderSize)) {
    return "FILLED";
  }

  return "OPEN";
}

function normalizeSide(value: string | undefined): "BUY" | "SELL" {
  return value?.toUpperCase() === "SELL" || value?.toLowerCase() === "ask" ? "SELL" : "BUY";
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = await response.json<unknown>();
    if (Array.isArray(body)) {
      return { data: body };
    }
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function stringField(
  value: Record<string, unknown> | null,
  keys: string[]
): string | undefined {
  if (!value) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }

  return undefined;
}

function numberField(
  value: Record<string, unknown> | null,
  keys: string[]
): number | undefined {
  if (!value) {
    return undefined;
  }

  for (const key of keys) {
    const parsed = Number(value[key]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`MISSING_${field.toUpperCase()}`);
  }

  return value;
}

function requireEndpoint(value: string | undefined, field: string): string {
  if (!value) {
    throw new Error(`MISSING_${field}`);
  }

  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundLatency(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8" }
  });
}
