import { ConfigManager } from "./ConfigManager";
import { Logger } from "./Logger";
import { RateLimiter } from "./utils/RateLimiter";
import { SignatureEngine } from "./utils/SignatureEngine";
import type { Env, ExchangeOpenOrder, ExecutionReport, JsonRecord, TradeIntent } from "./types";

const SINGLETON_ENGINE_NAME = "sovereign-sigma:singleton:trading-engine:v1";
const BINANCE_US_BASE_URL = "https://api.binance.us";
const HYPERLIQUID_BASE_URL = "https://api.hyperliquid.xyz";
const DEFAULT_RECV_WINDOW_MS = 5_000;
const MAX_RECV_WINDOW_MS = 60_000;
const limiter = new RateLimiter();
limiter.configure("default", 10, 10);
limiter.configure("hyperliquid", 1_000, 18);
let hyperliquidRateLimitConfigKey = "1000:18";
const secretCache = new Map<string, { value: string | null; expiresAt: number }>();

type ExchangeAdapter = "generic-json" | "binance-us" | "hyperliquid";

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

interface HyperliquidAssetMeta {
  coin: string;
  assetIndex: number;
  szDecimals: number;
  loadedAt: number;
}

const hyperliquidAssetCache = new Map<string, HyperliquidAssetMeta>();

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
  configureRuntimeRateLimits(env);
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
    if (resolveAdapter(env) === "hyperliquid" && isExchangeOrderTestMode(env)) {
      response = new Response(
        JSON.stringify({
          status: "TEST_ACCEPTED",
          response: {
            type: "order",
            data: {
              statuses: [{ resting: { oid: `test-${intent.intentId}` } }]
            }
          },
          message: "Hyperliquid signed order validated locally; no live order was placed."
        }),
        { status: 200, headers: { "content-type": "application/json;charset=UTF-8" } }
      );
    } else {
      response = await fetch(exchangeRequest.endpoint, exchangeRequest.init);
    }
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
  if (resolveAdapter(env) === "hyperliquid") {
    return listHyperliquidOpenOrders(env, logger);
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
  if (resolveAdapter(env) === "hyperliquid") {
    return getHyperliquidAccountBalance(env, logger);
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
  if (adapter === "hyperliquid") {
    return prepareHyperliquidOrderRequest(env, intent);
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

async function prepareHyperliquidOrderRequest(
  env: Env,
  intent: TradeIntent
): Promise<PreparedExchangeRequest> {
  const coin = hyperliquidCoin(env, intent.instrumentCode);
  const asset = await hyperliquidAssetMeta(env, coin);
  const expectedPrice = positive(intent.expectedPrice, "EXPECTED_PRICE");
  const requestedSize = positive(intent.approvedSize ?? intent.requestedSize, "ORDER_SIZE");
  const tif = hyperliquidTif(env, intent);
  const nonce = Date.now();
  const expiresAfter = hyperliquidExpiresAfter(env, nonce);
  const vaultAddress = normalizeOptionalAddress(env.HL_VAULT_ADDRESS);
  const agentSecret = requireString(
    await exchangeSecret(env, "HL_AGENT_SECRET"),
    "HL_AGENT_SECRET"
  );
  const agentAddress = await exchangeSecret(env, "HL_AGENT_ADDRESS");
  const derivedAgentAddress =
    SignatureEngine.preloadHyperliquidAgentSecret(agentSecret).address;

  if (agentAddress && agentAddress.toLowerCase() !== derivedAgentAddress) {
    throw new Error("HL_AGENT_ADDRESS_SECRET_MISMATCH");
  }

  const order: JsonRecord = {
    a: asset.assetIndex,
    b: intent.action === "BUY",
    p: hyperliquidWireNumber(expectedPrice),
    s: hyperliquidWireNumber(requestedSize),
    r: isReduceOnlyIntent(intent),
    t: { limit: { tif } },
    c: hyperliquidCloid(intent.intentId)
  };
  const action: JsonRecord = {
    type: "order",
    orders: [order],
    grouping: "na"
  };
  const signingStartedAt = performance.now();
  const signature = await SignatureEngine.signHyperliquidL1Action({
    secret: agentSecret,
    action,
    nonce,
    vaultAddress,
    expiresAfter,
    isMainnet: hyperliquidIsMainnet(env)
  });
  const payload: JsonRecord = {
    action,
    nonce,
    signature: signature as unknown as JsonRecord,
    vaultAddress: vaultAddress ?? null
  };

  if (expiresAfter !== null) {
    payload.expiresAfter = expiresAfter;
  }

  return {
    endpoint: hyperliquidExchangeUrl(env),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(payload)
    },
    signingLatencyMs: roundLatency(performance.now() - signingStartedAt),
    redactedPayload: {
      adapter: "hyperliquid",
      coin,
      assetIndex: asset.assetIndex,
      side: intent.action,
      price: order.p,
      size: order.s,
      tif,
      reduceOnly: order.r,
      cloid: order.c,
      testMode: isExchangeOrderTestMode(env),
      agentAddress: derivedAgentAddress
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

  if (resolveAdapter(env) === "hyperliquid") {
    return sendHyperliquidCancel(env, payload);
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

async function listHyperliquidOpenOrders(env: Env, logger: Logger): Promise<Response> {
  try {
    configureRuntimeRateLimits(env);
    const response = await hyperliquidInfo(env, {
      type: "openOrders",
      user: hyperliquidAccountAddress(env)
    });
    const body = await safeJson(response);
    const orders = normalizeOpenOrders(body);

    logger.info("HYPERLIQUID_OPEN_ORDERS_SYNCED", "Fetched Hyperliquid open orders", {
      status: response.status,
      count: orders.length
    });

    return json({ ok: response.ok, status: response.status, orders, body }, response.ok ? 200 : 502);
  } catch (error) {
    logger.error("HYPERLIQUID_OPEN_ORDERS_FAILED", "Failed to fetch Hyperliquid open orders", {
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
    return json({ ok: false, orders: [], error: "HYPERLIQUID_OPEN_ORDERS_FAILED" }, 503);
  }
}

async function getHyperliquidAccountBalance(env: Env, logger: Logger): Promise<Response> {
  try {
    configureRuntimeRateLimits(env);
    const response = await hyperliquidInfo(env, {
      type: "clearinghouseState",
      user: hyperliquidAccountAddress(env)
    });
    const body = await safeJson(response);

    logger.info("HYPERLIQUID_ACCOUNT_BALANCE_TESTED", "Hyperliquid account state endpoint tested", {
      status: response.status,
      ok: response.ok
    });

    return json({ ok: response.ok, status: response.status, body }, response.ok ? 200 : 502);
  } catch (error) {
    logger.error("HYPERLIQUID_ACCOUNT_BALANCE_FAILED", "Failed to test Hyperliquid account state", {
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
    return json({ ok: false, error: "HYPERLIQUID_ACCOUNT_BALANCE_FAILED" }, 503);
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

async function sendHyperliquidCancel(
  env: Env,
  payload: Record<string, unknown>
): Promise<Response> {
  configureRuntimeRateLimits(env);
  const instrument = stringField(payload, ["instrument", "instrumentCode"]);

  if (payload.cancel_all) {
    const openOrdersResponse = await hyperliquidInfo(env, {
      type: "openOrders",
      user: hyperliquidAccountAddress(env)
    });
    const openOrdersBody = await safeJson(openOrdersResponse);
    const orders = normalizeOpenOrders(openOrdersBody)
      .filter((order) => !instrument || instrument === "ALL" || order.instrumentCode === instrument.toLowerCase());

    if (!openOrdersResponse.ok) {
      return new Response(JSON.stringify({ ok: false, status: openOrdersResponse.status, body: openOrdersBody }), {
        status: 502,
        headers: { "content-type": "application/json;charset=UTF-8" }
      });
    }

    if (orders.length === 0) {
      return new Response(JSON.stringify({ ok: true, cancelled: 0, results: [] }), {
        status: 200,
        headers: { "content-type": "application/json;charset=UTF-8" }
      });
    }

    const cancelPayload = await prepareHyperliquidCancelRequest(env, orders.map((order) => ({
      instrumentCode: order.instrumentCode,
      orderId: order.exchangeOrderId
    })));
    if (isExchangeOrderTestMode(env)) {
      return hyperliquidTestCancelResponse(orders.length);
    }
    return fetch(cancelPayload.endpoint, cancelPayload.init);
  }

  const orderId = requireString(stringField(payload, ["order_id", "orderId"]), "orderId");
  const instrumentCode = requireString(instrument, "instrumentCode");
  const cancelPayload = await prepareHyperliquidCancelRequest(env, [{ instrumentCode, orderId }]);
  if (isExchangeOrderTestMode(env)) {
    return hyperliquidTestCancelResponse(1);
  }
  return fetch(cancelPayload.endpoint, cancelPayload.init);
}

async function prepareHyperliquidCancelRequest(
  env: Env,
  cancels: Array<{ instrumentCode: string; orderId: string }>
): Promise<PreparedExchangeRequest> {
  const nonce = Date.now();
  const expiresAfter = hyperliquidExpiresAfter(env, nonce);
  const vaultAddress = normalizeOptionalAddress(env.HL_VAULT_ADDRESS);
  const agentSecret = requireString(
    await exchangeSecret(env, "HL_AGENT_SECRET"),
    "HL_AGENT_SECRET"
  );
  SignatureEngine.preloadHyperliquidAgentSecret(agentSecret);
  const cancelWires = [];

  for (const cancel of cancels) {
    const coin = hyperliquidCoin(env, cancel.instrumentCode);
    const asset = await hyperliquidAssetMeta(env, coin);

    if (/^\d+$/.test(cancel.orderId)) {
      cancelWires.push({ a: asset.assetIndex, o: Number(cancel.orderId) });
    } else {
      cancelWires.push({ asset: asset.assetIndex, cloid: normalizeHyperliquidCloid(cancel.orderId) });
    }
  }

  const action: JsonRecord =
    "o" in cancelWires[0]
      ? { type: "cancel", cancels: cancelWires as unknown as JsonRecord[] }
      : { type: "cancelByCloid", cancels: cancelWires as unknown as JsonRecord[] };
  const signingStartedAt = performance.now();
  const signature = await SignatureEngine.signHyperliquidL1Action({
    secret: agentSecret,
    action,
    nonce,
    vaultAddress,
    expiresAfter,
    isMainnet: hyperliquidIsMainnet(env)
  });
  const body: JsonRecord = {
    action,
    nonce,
    signature: signature as unknown as JsonRecord,
    vaultAddress: vaultAddress ?? null
  };

  if (expiresAfter !== null) {
    body.expiresAfter = expiresAfter;
  }

  return {
    endpoint: hyperliquidExchangeUrl(env),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(body)
    },
    signingLatencyMs: roundLatency(performance.now() - signingStartedAt),
    redactedPayload: {
      adapter: "hyperliquid",
      actionType: action.type,
      cancelCount: cancels.length,
      testMode: isExchangeOrderTestMode(env)
    }
  };
}

function hyperliquidTestCancelResponse(cancelCount: number): Response {
  return new Response(
    JSON.stringify({
      status: "TEST_ACCEPTED",
      response: {
        type: "cancel",
        data: { statuses: Array.from({ length: cancelCount }, () => "success") }
      },
      message: "Hyperliquid signed cancel validated locally; no live cancel was sent."
    }),
    {
      status: 200,
      headers: { "content-type": "application/json;charset=UTF-8" }
    }
  );
}

async function binanceSignedRequest(
  env: Env,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string>
): Promise<PreparedExchangeRequest> {
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

function instrumentFromHyperliquidCoin(coin: string | undefined): string | undefined {
  if (!coin) {
    return undefined;
  }

  return `${coin.toLowerCase()}-usd`;
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

function isExchangeOrderTestMode(env: Env): boolean {
  return env.EXCHANGE_ORDER_TEST_MODE !== "false";
}

function configureRuntimeRateLimits(env: Env): void {
  const capacity = positiveIntegerOrDefault(env.HL_REST_RATE_LIMIT_PER_MINUTE, 1_000);
  const refill = positiveNumberOrDefault(env.HL_REST_REFILL_PER_SECOND, Math.min(18, capacity / 60));
  const boundedCapacity = Math.min(1_200, capacity);
  const boundedRefill = Math.min(20, refill);
  const configKey = `${boundedCapacity}:${boundedRefill}`;

  if (configKey === hyperliquidRateLimitConfigKey) {
    return;
  }

  limiter.configure("hyperliquid", boundedCapacity, boundedRefill);
  hyperliquidRateLimitConfigKey = configKey;
}

function hyperliquidBaseUrl(env: Env): string {
  return (env.EXCHANGE_BASE_URL ?? HYPERLIQUID_BASE_URL).replace(/\/+$/, "");
}

function hyperliquidInfoUrl(env: Env): string {
  return env.HL_INFO_URL ?? `${hyperliquidBaseUrl(env)}/info`;
}

function hyperliquidExchangeUrl(env: Env): string {
  return env.HL_EXCHANGE_URL ?? env.EXCHANGE_ORDER_ENDPOINT ?? `${hyperliquidBaseUrl(env)}/exchange`;
}

async function hyperliquidInfo(env: Env, payload: Record<string, unknown>): Promise<Response> {
  const reservation = limiter.reserve("hyperliquid", "NEW");
  if (!reservation.allowed) {
    await delay(reservation.waitMs);
  }

  return fetch(hyperliquidInfoUrl(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function hyperliquidAssetMeta(env: Env, coin: string): Promise<HyperliquidAssetMeta> {
  const configuredIndex = Number(env.HL_ASSET_INDEX);
  if (Number.isSafeInteger(configuredIndex) && configuredIndex >= 0) {
    return {
      coin,
      assetIndex: configuredIndex,
      szDecimals: 8,
      loadedAt: Date.now()
    };
  }

  const cacheKey = coin.toUpperCase();
  const cached = hyperliquidAssetCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < 10 * 60 * 1000) {
    return cached;
  }

  const response = await hyperliquidInfo(env, { type: "metaAndAssetCtxs" });
  const body = await safeJson(response);

  if (!response.ok) {
    throw new Error(`HYPERLIQUID_META_FAILED_${response.status}`);
  }

  const data = Array.isArray(body?.data) ? body.data : [];
  const meta = isRecord(data[0]) ? data[0] : body;
  const universe = Array.isArray(meta?.universe) ? meta.universe.filter(isRecord) : [];
  const assetIndex = universe.findIndex(
    (asset) => String(asset.name ?? "").toUpperCase() === cacheKey
  );

  if (assetIndex < 0) {
    throw new Error(`HYPERLIQUID_ASSET_NOT_FOUND_${cacheKey}`);
  }

  const entry = universe[assetIndex];
  const assetMeta: HyperliquidAssetMeta = {
    coin: cacheKey,
    assetIndex,
    szDecimals: Number.isFinite(Number(entry.szDecimals)) ? Number(entry.szDecimals) : 8,
    loadedAt: Date.now()
  };
  hyperliquidAssetCache.set(cacheKey, assetMeta);
  return assetMeta;
}

function hyperliquidAccountAddress(env: Env): string {
  return requireString(env.HL_ACCOUNT_ADDRESS ?? env.HL_AGENT_ADDRESS, "HL_ACCOUNT_ADDRESS").toLowerCase();
}

function hyperliquidCoin(env: Env, instrumentCode: string): string {
  if (env.HL_ASSET) {
    return env.HL_ASSET.trim().toUpperCase();
  }

  const [base] = instrumentCode.replace("-perp", "").split("-");
  return requireString(base, "HL_ASSET").toUpperCase();
}

function hyperliquidTif(env: Env, intent: TradeIntent): "Alo" | "Ioc" | "Gtc" {
  const configured = env.HL_DEFAULT_TIF?.trim().toLowerCase();
  if (configured === "ioc") {
    return "Ioc";
  }
  if (configured === "gtc") {
    return "Gtc";
  }
  if (intent.postOnly !== false) {
    return "Alo";
  }
  if (intent.timeInForce === "IOC" || intent.orderType === "MARKET") {
    return "Ioc";
  }
  return "Alo";
}

function hyperliquidIsMainnet(env: Env): boolean {
  return env.HL_IS_MAINNET !== "false" && !hyperliquidBaseUrl(env).includes("testnet");
}

function hyperliquidExpiresAfter(env: Env, nonce: number): number | null {
  const ttlMs = Number(env.HL_ORDER_EXPIRES_MS ?? 10_000);
  return Number.isFinite(ttlMs) && ttlMs > 0 ? nonce + Math.round(ttlMs) : null;
}

function hyperliquidWireNumber(value: number): string {
  const rounded = Number(value.toFixed(8));
  if (Math.abs(rounded - value) >= 1e-12) {
    throw new Error("HYPERLIQUID_WIRE_NUMBER_PRECISION_LOSS");
  }
  const fixed = rounded.toFixed(8).replace(/\.?0+$/, "");
  return fixed === "-0" || fixed.length === 0 ? "0" : fixed;
}

function hyperliquidCloid(value: string): string {
  const hex = value.replace(/[^0-9a-fA-F]/g, "").padEnd(32, "0").slice(0, 32);
  return `0x${hex}`;
}

function normalizeHyperliquidCloid(value: string): string {
  return value.startsWith("0x") ? value : hyperliquidCloid(value);
}

function normalizeOptionalAddress(value: string | undefined): string | null {
  if (!value || value.trim() === "") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("INVALID_HYPERLIQUID_VAULT_ADDRESS");
  }
  return normalized;
}

function isReduceOnlyIntent(intent: TradeIntent): boolean {
  const rationale = intent.rationale.toLowerCase();
  return rationale.includes("hedge") || rationale.includes("closeout") || rationale.includes("reduce-only");
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumberOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  const ed25519Secret = await exchangeSecret(env, "EXCHANGE_ED25519_PRIVATE_KEY");
  const hmacSecret = await exchangeSecret(env, "EXCHANGE_HMAC_SECRET");

  if (configuredAlgorithm === "ED25519") {
    if (!ed25519Secret) {
      throw new Error("MISSING_EXCHANGE_ED25519_PRIVATE_KEY");
    }

    return {
      "x-signature": await SignatureEngine.sign({
        algorithm: "ED25519",
        secret: ed25519Secret,
        payload
      })
    };
  }

  if (configuredAlgorithm === "HMAC-SHA256" || (!configuredAlgorithm && hmacSecret)) {
    if (!hmacSecret) {
      return {};
    }

    return {
      "x-signature": await SignatureEngine.sign({
        algorithm: "HMAC-SHA256",
        secret: hmacSecret,
        payload
      })
    };
  }

  if (!configuredAlgorithm && ed25519Secret) {
    return {
      "x-signature": await SignatureEngine.sign({
        algorithm: "ED25519",
        secret: ed25519Secret,
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
  const hyperliquid = extractHyperliquidExecution(body);
  const exchangeOrderId = stringField(body, [
    "order_id",
    "orderId",
    "id",
    "exchange_order_id",
    "clientOrderId"
  ]) ?? hyperliquid.exchangeOrderId;
  const filledSize = Number(
    numberField(body, ["filled_size", "filledSize", "executed_size", "executedQty"]) ??
      hyperliquid.filledSize ??
      0
  );
  const rawStatus = hyperliquid.rawStatus ?? stringField(body, ["status", "state", "order_status"]);
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
      hyperliquid.achievedPrice ??
      averageExecutionPrice(body) ??
      numberField(body, ["price", "avg_price", "average_price"]) ??
      intent.expectedPrice,
    expectedPrice: intent.expectedPrice,
    fees: extractFees(body),
    latencyMs,
    reason: response.ok ? hyperliquid.reason : String(body?.message ?? body?.error ?? response.status),
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

function extractHyperliquidExecution(body: Record<string, unknown> | null): {
  exchangeOrderId?: string;
  filledSize?: number;
  achievedPrice?: number;
  rawStatus?: string;
  reason?: string;
} {
  const response = isRecord(body?.response) ? body.response : null;
  const data = isRecord(response?.data) ? response.data : null;
  const statuses = Array.isArray(data?.statuses) ? data.statuses.filter(isRecord) : [];
  const first = statuses[0];

  if (!first) {
    return {};
  }

  if (isRecord(first.resting)) {
    return {
      exchangeOrderId: stringField(first.resting, ["oid"]),
      rawStatus: "NEW"
    };
  }

  if (isRecord(first.filled)) {
    const totalSz = numberField(first.filled, ["totalSz", "sz", "size"]);
    const avgPx = numberField(first.filled, ["avgPx", "px", "price"]);
    return {
      exchangeOrderId: stringField(first.filled, ["oid"]),
      filledSize: totalSz,
      achievedPrice: avgPx,
      rawStatus: "FILLED"
    };
  }

  const error = stringField(first, ["error"]);
  if (error) {
    return {
      rawStatus: "REJECTED",
      reason: error
    };
  }

  return {};
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

  if (adapter === "generic-json" || adapter === "binance-us" || adapter === "hyperliquid") {
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
          stringField(order, ["order_id", "orderId", "id", "exchange_order_id", "oid"]),
          "exchangeOrderId"
        ),
        instrumentCode: requireString(
          instrumentFromHyperliquidCoin(stringField(order, ["coin"])) ??
            instrumentFromBinanceSymbol(rawSymbol) ??
            rawSymbol?.toLowerCase(),
          "instrumentCode"
        ),
        side: normalizeSide(stringField(order, ["side"])),
        price: numberField(order, ["price", "limitPx", "stopPrice"]) ?? 0,
        size: numberField(order, ["origQty", "origSz", "sz", "size", "quantity", "order_size"]) ?? 0,
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

async function exchangeSecret(env: Env, keyName: string): Promise<string | undefined> {
  const direct = (env as unknown as Record<string, string | undefined>)[keyName];
  if (direct) {
    return direct;
  }

  const now = Date.now();
  const cached = secretCache.get(keyName);
  if (cached && cached.expiresAt > now) {
    return cached.value ?? undefined;
  }

  const value = await readVaultSecret(env, keyName);
  secretCache.set(keyName, {
    value: value ?? null,
    expiresAt: now + 60_000
  });

  return value ?? undefined;
}

async function readVaultSecret(env: Env, keyName: string): Promise<string | null> {
  try {
    const encryptionSecret = env.VAULT_ENCRYPTION_SECRET ?? env.JWT_SECRET ?? env.ADMIN_JWT_SECRET;
    if (!encryptionSecret) {
      return null;
    }

    const encrypted = await env.RISK_VAULT.get<JsonRecord>(`vault:secret:${keyName}`, "json");
    if (!encrypted) {
      return null;
    }

    return decryptSecret(encrypted, encryptionSecret);
  } catch (error) {
    console.error(
      "[Sovereign-Sigma] executioner vault secret lookup failed",
      keyName,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

async function decryptSecret(encrypted: JsonRecord, keyMaterial: string): Promise<string | null> {
  if (
    encrypted.alg !== "AES-GCM" ||
    typeof encrypted.iv !== "string" ||
    typeof encrypted.ciphertext !== "string"
  ) {
    return null;
  }

  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(encrypted.iv) },
    key,
    base64ToBytes(encrypted.ciphertext)
  );

  return new TextDecoder().decode(plaintext);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
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
