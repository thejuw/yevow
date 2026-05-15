import { ConfigManager } from "./ConfigManager";
import { Logger } from "./Logger";
import { RateLimiter } from "./utils/RateLimiter";
import { SignatureEngine } from "./utils/SignatureEngine";
import type { Env, ExchangeOpenOrder, ExecutionReport, TradeIntent } from "./types";

const SINGLETON_ENGINE_NAME = "sovereign-sigma:singleton:trading-engine:v1";
const limiter = new RateLimiter();
limiter.configure("default", 10, 10);

type ExchangeAdapter = "generic-json";

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

  let payload: Record<string, unknown>;
  let endpoint: string;

  try {
    payload = exchangePayload(intent, resolveAdapter(env));
    endpoint = requireEndpoint(env.EXCHANGE_ORDER_ENDPOINT ?? env.EXCHANGE_BASE_URL, "EXCHANGE_ORDER_ENDPOINT");
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

  const bodyJson = JSON.stringify(payload);
  const signingStartedAt = performance.now();
  const signedHeaders = await signHeaders(env, bodyJson);
  const signingLatencyMs = roundLatency(performance.now() - signingStartedAt);

  if (signingLatencyMs > 1) {
    logger.warn("SIGNATURE_LATENCY_SPIKE", "Exchange signature exceeded 1ms target", {
      intentId: intent.intentId,
      signingLatencyMs,
      algorithm: env.SIGNATURE_ALGORITHM ?? "auto"
    });
  }

  const startedAt = Date.now();
  let response: Response;
  let body: Record<string, unknown> | null;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signedHeaders
      },
      body: bodyJson
    });
    body = await safeJson(response);
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
    signingLatencyMs,
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
  const payload = await request.json<{ orderId?: string; reason?: string }>();
  const orderId = requireString(payload.orderId, "orderId");
  const response = await sendCancel(env, { order_id: orderId, reason: payload.reason ?? "CANCEL" });

  logger.warn("EXCHANGE_CANCEL_SENT", "Cancel request sent to exchange adapter", {
    orderId,
    reason: payload.reason ?? "CANCEL",
    status: response.status
  });
  ctx.waitUntil(Promise.resolve());
  return json(
    { ok: response.ok, status: response.status, body: await safeJson(response) },
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

  logger.warn("EXCHANGE_CANCEL_ALL_SENT", "Cancel-all request sent to exchange adapter", {
    instrumentCode: payload.instrumentCode ?? "ALL",
    reason: payload.reason ?? "CANCEL_ALL",
    status: response.status
  });
  ctx.waitUntil(Promise.resolve());
  return json(
    { ok: response.ok, status: response.status, body: await safeJson(response) },
    response.status === 204 ? 200 : response.status
  );
}

async function listOpenOrders(env: Env, logger: Logger): Promise<Response> {
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
  const exchangeOrderId = stringField(body, ["order_id", "id", "exchange_order_id"]);
  const filledSize = Number(numberField(body, ["filled_size", "filledSize", "executed_size"]) ?? 0);
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
    achievedPrice: numberField(body, ["price", "avg_price", "average_price"]) ?? intent.expectedPrice,
    expectedPrice: intent.expectedPrice,
    fees: numberField(body, ["fees", "fee"]) ?? 0,
    latencyMs,
    reason: response.ok ? undefined : String(body?.message ?? body?.error ?? response.status),
    rawStatus: rawStatus ?? undefined,
    observedAt: new Date().toISOString()
  };
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

  if (adapter === "generic-json") {
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
    .map((order) => ({
      clientId: stringField(order, ["client_id", "clientId"]) ?? null,
      exchangeOrderId: requireString(stringField(order, ["order_id", "id", "exchange_order_id"]), "exchangeOrderId"),
      instrumentCode: requireString(stringField(order, ["symbol", "instrument", "instrument_code"]), "instrumentCode").toLowerCase(),
      side: normalizeSide(stringField(order, ["side"])),
      price: numberField(order, ["price"]) ?? 0,
      size: numberField(order, ["size", "quantity", "order_size"]) ?? 0,
      filledSize: numberField(order, ["filled_size", "filledSize", "executed_size"]) ?? 0,
      status: normalizeOrderStatus(stringField(order, ["status", "state"]), true, 0, 1),
      observedAt: new Date().toISOString()
    }));
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
  if (normalized?.includes("reject")) {
    return "REJECTED";
  }
  if (normalized?.includes("cancel")) {
    return "CANCELLED";
  }
  if (normalized?.includes("partial")) {
    return "PARTIAL_FILL";
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
