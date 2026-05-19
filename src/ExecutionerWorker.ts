import { ConfigManager, configDefaultsFromEnv } from "./ConfigManager";
import {
  ceilToIncrement,
  decimalPlaces,
  floorToIncrement,
  formatDecimal,
  maskAddress,
  positive,
  positiveIntegerOrDefault,
  positiveNumberOrDefault,
  positiveOrNull,
  roundLatency,
  shortHash,
  snapPrice
} from "./execution/ExecutionFormatters";
import {
  averageExecutionPrice,
  extractFees,
  normalizeOrderStatus,
  normalizeSide,
  rejectedReport,
  toExecutionReport
} from "./execution/ExecutionReports";
import {
  cappedExecutionPrice,
  evaluateCascadeTakerGate,
  isTakerExecutionStyle,
  resolveExecutionStyle,
  takerExpectedSlippageBps,
  takerSpreadDecision
} from "./execution/ExecutionPricing";
import {
  hyperliquidCloid,
  hyperliquidOrderWire,
  hyperliquidPriceDecimals,
  isReduceOnlyIntent,
  normalizeHyperliquidCloid,
  normalizeOptionalAddress,
  type HyperliquidAssetMeta
} from "./execution/HyperliquidWire";
import { IntentIdempotencyLedger } from "./execution/IntentIdempotency";
import {
  finiteNumber,
  isRecord,
  numberField,
  requireEndpoint,
  requireString,
  safeJson,
  stringField
} from "./execution/ResponseParsing";
import { evaluateExecutionRisk, isInventoryHedgeIntent } from "./execution/RiskGuards";
import { exchangeSecret, exchangeSecretWithSource } from "./execution/SecretResolver";
import {
  buildShadowRestingQuoteReport,
  estimateShadowFees
} from "./execution/ShadowExecutionReports";
import { buildTwapSlices, fillRatio, type TwapSlice } from "./execution/TwapSlicing";
import { Logger, createLogSink, structuredConsoleLogsEnabled } from "./Logger";
import { RiskLimiter } from "./strategy/cascade/RiskLimiter";
import { RateLimiter } from "./utils/RateLimiter";
import { SignatureEngine } from "./utils/SignatureEngine";
import { getTradingEngineStub } from "./utils/TradingEngineStub";
import {
  buildGhostExecutionReport,
  buildGhostTradeExecution,
  buildSignedTradeIntentAudit,
  isShadowMode
} from "./utils/CitadelProtocol";
import type {
  Env,
  EngineState,
  ExchangeOpenOrder,
  ExecutionReport,
  ExecutionStyle,
  GlobalRiskConfig,
  JsonRecord,
  TradeIntent
} from "./types";

const BINANCE_US_BASE_URL = "https://api.binance.us";
const HYPERLIQUID_BASE_URL = "https://api.hyperliquid.xyz";
const DEFAULT_RECV_WINDOW_MS = 5_000;
const MAX_RECV_WINDOW_MS = 60_000;
const limiter = new RateLimiter();
limiter.configure("default", 10, 10);
limiter.configure("hyperliquid", 1_000, 18);
let hyperliquidRateLimitConfigKey = "1000:18";
const intentLedger = new IntentIdempotencyLedger();
const hedgeCooldownByInstrument = new Map<string, number>();

type ExchangeAdapter = "generic-json" | "binance-us" | "hyperliquid";

interface PreparedExchangeRequest {
  endpoint: string;
  init: RequestInit;
  signingLatencyMs: number;
  redactedPayload: Record<string, unknown>;
}

type IntentResponder = (body: unknown, status?: number, remember?: boolean) => Response;

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

const hyperliquidAssetCache = new Map<string, HyperliquidAssetMeta>();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const logger = new Logger(
      env.TRADING_DB,
      (promise) => ctx.waitUntil(promise),
      "ExecutionerWorker",
      undefined,
      createLogSink(env),
      structuredConsoleLogsEnabled(env)
    );
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "sovereign-sigma-executioner",
        shadowMode: isShadowMode(env)
      });
    }

    if (url.pathname === "/diagnostics") {
      return executionerDiagnostics(env);
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
  const config = await new ConfigManager(
    env.CONFIG_STORE,
    configDefaultsFromEnv(env)
  ).fetchConfig();
  const intent = await request.json<TradeIntent>();
  validateIntent(intent);
  const idempotency = intentLedger.evaluate(intent);

  if (idempotency.kind === "REPLAY") {
    return json(
      {
        ...(isRecord(idempotency.response.body) ? idempotency.response.body : {}),
        idempotentReplay: true
      },
      idempotency.response.status
    );
  }

  if (idempotency.kind === "CONFLICT") {
    return json({ ok: false, error: idempotency.reason }, 409);
  }

  const respond = (body: unknown, status = 200, remember = true): Response => {
    if (remember) {
      intentLedger.remember(intent, idempotency.fingerprint, { body, status });
    }
    return json(body, status);
  };

  const riskDecision = evaluateExecutionRisk(intent, config, Number(env.PAPER_BANKROLL_USD ?? 0));

  if (!riskDecision.ok) {
    const report = rejectedReport(
      intent,
      riskDecision.reason ?? "EXECUTION_RISK_REJECTED",
      riskDecision.status
    );
    ctx.waitUntil(forwardReport(env, report));
    logger.warn("EXECUTION_RISK_REJECTED", "Pre-trade risk guard rejected intent", {
      intentId: intent.intentId,
      reason: riskDecision.reason,
      notional: riskDecision.notional,
      status: riskDecision.status
    });
    return respond({ ok: false, report, error: riskDecision.reason }, riskDecision.status);
  }

  const inventoryHedge = isInventoryHedgeIntent(intent);
  const executionStyle = resolveExecutionStyle(intent);

  if (executionStyle === "SLICED_TWAP") {
    const gate = evaluateCascadeTakerGate(intent, config, inventoryHedge);
    if (!gate.ok) {
      const report = rejectedReport(intent, gate.reason, gate.status);
      ctx.waitUntil(forwardReport(env, report));
      logger.warn("CASCADE_TAKER_GATE_REJECTED", "Sliced TWAP intent failed taker gates", {
        intentId: intent.intentId,
        reason: gate.reason,
        status: gate.status
      });
      return respond({ ok: false, report, error: gate.reason }, gate.status);
    }

    const cascadeRisk = await evaluateCascadeRiskLimiter(env, config, intent);
    if (!cascadeRisk.ok) {
      const report = rejectedReport(intent, cascadeRisk.reason, cascadeRisk.status);
      ctx.waitUntil(forwardReport(env, report));
      logger.warn("CASCADE_TAKER_RISK_REJECTED", "Sliced TWAP intent failed cascade risk gates", {
        intentId: intent.intentId,
        reason: cascadeRisk.reason
      });
      return respond({ ok: false, report, error: cascadeRisk.reason }, cascadeRisk.status);
    }

    return scheduleSlicedTwap(intent, env, ctx, logger, respond);
  }

  if (isTakerExecutionStyle(executionStyle) && !inventoryHedge) {
    const gate = evaluateCascadeTakerGate(intent, config, inventoryHedge);
    if (!gate.ok) {
      const report = rejectedReport(intent, gate.reason, gate.status);
      ctx.waitUntil(forwardReport(env, report));
      logger.warn("CASCADE_TAKER_GATE_REJECTED", "Cascade taker intent failed pre-send gates", {
        intentId: intent.intentId,
        reason: gate.reason,
        executionStyle,
        status: gate.status
      });
      return respond({ ok: false, report, error: gate.reason }, gate.status);
    }

    const cascadeRisk = await evaluateCascadeRiskLimiter(env, config, intent);
    if (!cascadeRisk.ok) {
      const report = rejectedReport(intent, cascadeRisk.reason, cascadeRisk.status);
      ctx.waitUntil(forwardReport(env, report));
      logger.warn("CASCADE_TAKER_RISK_REJECTED", "Cascade taker intent failed risk limiter", {
        intentId: intent.intentId,
        reason: cascadeRisk.reason
      });
      return respond({ ok: false, report, error: cascadeRisk.reason }, cascadeRisk.status);
    }
  }

  if (executionStyle === "TAKER_MARKET" && !isStopCloseIntent(intent)) {
    const report = rejectedReport(intent, "TAKER_MARKET_ONLY_ALLOWED_FOR_STOPS", 403);
    ctx.waitUntil(forwardReport(env, report));
    logger.warn(
      "TAKER_MARKET_ONLY_ALLOWED_FOR_STOPS",
      "Rejected market-style taker intent outside stop-close lifecycle",
      {
        intentId: intent.intentId,
        instrumentCode: intent.instrumentCode,
        orderType: intent.orderType,
        timeInForce: intent.timeInForce,
        executionStyle
      }
    );
    return respond({ ok: false, report, error: "TAKER_MARKET_ONLY_ALLOWED_FOR_STOPS" }, 403);
  }

  if ((intent.orderType !== "LIMIT" || intent.postOnly !== true) && !inventoryHedge) {
    if (!isTakerExecutionStyle(executionStyle)) {
      const report = rejectedReport(intent, "TAKER_EXECUTION_DISABLED", 423);
      ctx.waitUntil(forwardReport(env, report));
      logger.warn(
        "TAKER_EXECUTION_DISABLED",
        "Rejected non-post-only intent without an explicit cascade taker execution style",
        {
          intentId: intent.intentId,
          instrumentCode: intent.instrumentCode,
          orderType: intent.orderType,
          postOnly: intent.postOnly,
          timeInForce: intent.timeInForce
        }
      );
      return respond({ ok: false, report, error: "TAKER_EXECUTION_DISABLED" }, 423);
    }
  }

  if (inventoryHedge) {
    const now = Date.now();
    const cooldownMs = Math.max(1_000, config.HEDGE_COOLDOWN_MS);
    const last = hedgeCooldownByInstrument.get(intent.instrumentCode) ?? 0;

    if (now - last < cooldownMs) {
      const report = rejectedReport(intent, "HEDGE_COOLDOWN_ACTIVE", 429);
      ctx.waitUntil(forwardReport(env, report));
      logger.warn("HEDGE_COOLDOWN_ACTIVE", "Inventory hedge intent was rate-limited", {
        intentId: intent.intentId,
        instrumentCode: intent.instrumentCode,
        cooldownMs,
        retryAfterMs: cooldownMs - (now - last)
      });
      return respond({ ok: false, report, error: "HEDGE_COOLDOWN_ACTIVE" }, 429);
    }

    hedgeCooldownByInstrument.set(intent.instrumentCode, now);
  }

  const priority = "NEW";
  configureRuntimeRateLimits(env);
  const reservation = limiter.reserve(intent.source_exchange ?? "default", priority);

  if (!reservation.allowed) {
    ctx.waitUntil(delay(reservation.waitMs));
    return respond(
      { ok: false, error: "Rate limited", retryAfterMs: reservation.waitMs },
      429,
      false
    );
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
    return respond({ ok: false, report, error: reason }, 503);
  }

  if (exchangeRequest.signingLatencyMs > 1) {
    logger.warn("SIGNATURE_LATENCY_SPIKE", "Exchange signature exceeded 1ms target", {
      intentId: intent.intentId,
      signingLatencyMs: exchangeRequest.signingLatencyMs,
      algorithm: env.SIGNATURE_ALGORITHM ?? "auto"
    });
  }

  if (isShadowMode(env)) {
    const observedAt = new Date().toISOString();
    const audit = buildSignedTradeIntentAudit(intent, exchangeRequest, observedAt);

    if (intent.postOnly && intent.orderType === "LIMIT") {
      const report = buildShadowRestingQuoteReport(intent, audit.exactTimestamp);
      ctx.waitUntil(forwardReport(env, report));

      return respond({
        ok: true,
        shadowMode: true,
        status: "OPEN",
        report,
        signedTradeIntent: audit
      });
    }

    const estimatedFees = estimateShadowFees(env, intent);
    const report = buildGhostExecutionReport(intent, audit, estimatedFees);
    const trade = buildGhostTradeExecution(
      intent,
      audit,
      intent.source_exchange ?? resolveAdapter(env),
      estimatedFees
    );

    logger.recordExecution(trade);
    logger.warn("SHADOW_TRADE_INTENT_GHOST_FILL", "Shadow Mode skipped live exchange POST", {
      intentId: intent.intentId,
      instrumentCode: intent.instrumentCode,
      source_exchange: intent.source_exchange ?? null,
      orderType: intent.orderType,
      expectedSlippageBps: intent.maxSlippageBps,
      exactTimestamp: observedAt,
      estimatedFees,
      signingLatencyMs: exchangeRequest.signingLatencyMs
    });
    ctx.waitUntil(forwardReport(env, report));

    return respond({
      ok: true,
      shadowMode: true,
      status: "GHOST_FILL",
      report,
      signedTradeIntent: audit
    });
  }

  const preTrade = await validatePreTrade(env, intent, config);
  if (!preTrade.ok) {
    const report = rejectedReport(intent, preTrade.reason, preTrade.status);
    ctx.waitUntil(forwardReport(env, report));
    logger.warn("EXECUTION_PRE_TRADE_REJECTED", "Pre-trade execution guard rejected intent", {
      intentId: intent.intentId,
      reason: preTrade.reason,
      status: preTrade.status
    });
    return respond({ ok: false, report, error: preTrade.reason }, preTrade.status);
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
    return respond({ ok: false, report, error: reason }, 503);
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
    return respond({ ok: false, report, body }, response.status || 502);
  }

  let retryReport: ExecutionReport | null = null;
  if (executionStyle === "TAKER_MARKET" && report.status === "PARTIAL_FILL") {
    retryReport = await retryPartialStopClose(env, intent, report, ctx, logger);
  }

  logger.info("EXCHANGE_ORDER_SUBMITTED", "Execution request submitted", {
    intentId: intent.intentId,
    status: response.status,
    exchangeOrderId: report.exchangeOrderId ?? null,
    signingLatencyMs: exchangeRequest.signingLatencyMs,
    payloadJson: JSON.stringify(exchangeRequest.redactedPayload),
    reportJson: JSON.stringify(report)
  });

  return respond({ ok: true, report, retryReport, body });
}

async function evaluateCascadeRiskLimiter(
  env: Env,
  config: GlobalRiskConfig,
  intent: TradeIntent
): Promise<{ ok: true } | { ok: false; reason: string; status: number }> {
  if (isInventoryHedgeIntent(intent) || isStopCloseIntent(intent)) {
    return { ok: true };
  }

  const equity =
    positiveOrNull(env.PAPER_BANKROLL_USD) ?? positiveOrNull(config.MAX_POSITION_SIZE) ?? 0;
  const state = {
    bankroll: { equity },
    cachedConfig: config,
    riskMetrics: { rollingDrawdownPct: 0 }
  } as unknown as EngineState;
  const decision = await new RiskLimiter().shouldBlockNewEntries(env, state);

  if (!decision.blocked) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `CASCADE_RISK_${decision.reason ?? "BLOCKED"}`,
    status: 409
  };
}

function isStopCloseIntent(intent: TradeIntent): boolean {
  const rationale = intent.rationale.toLowerCase();
  return (
    intent.orderType === "MARKET" &&
    !intent.postOnly &&
    (rationale.includes("stop") || rationale.includes("stop_loss"))
  );
}

async function scheduleSlicedTwap(
  intent: TradeIntent,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger,
  respond: IntentResponder
): Promise<Response> {
  const slices = buildTwapSlices(intent, {
    sliceNotionalPerChunk: Number(env.SLICE_NOTIONAL_PER_CHUNK ?? 0),
    sliceIntervalMs: Number(env.SLICE_INTERVAL_MS ?? 0),
    sliceJitterMs: Number(env.SLICE_JITTER_MS ?? 0)
  });

  if (slices.length === 0) {
    const report = rejectedReport(intent, "TWAP_NO_VALID_SLICES", 400);
    ctx.waitUntil(forwardReport(env, report));
    return respond({ ok: false, report, error: "TWAP_NO_VALID_SLICES" }, 400);
  }

  ctx.waitUntil(runTwapSlices(env, slices, logger));
  logger.info("SLICED_TWAP_SCHEDULED", "Scheduled cascade TWAP child IOC slices", {
    intentId: intent.intentId,
    sliceCount: slices.length,
    totalSize: intent.approvedSize ?? intent.requestedSize,
    totalNotional: (intent.approvedSize ?? intent.requestedSize) * intent.expectedPrice
  });

  return respond({
    ok: true,
    status: "TWAP_SCHEDULED",
    sliceCount: slices.length,
    slices: slices.map((slice) => ({
      intentId: slice.intent.intentId,
      approvedSize: slice.intent.approvedSize,
      requestedSize: slice.intent.requestedSize,
      delayMs: slice.delayMs
    }))
  });
}

async function runTwapSlices(
  env: Env,
  slices: readonly TwapSlice[],
  logger: Logger
): Promise<void> {
  for (const slice of slices) {
    if (slice.delayMs > 0) {
      await delay(slice.delayMs);
    }

    try {
      const request = await prepareOrderRequest(env, slice.intent, resolveAdapter(env));
      if (isShadowMode(env)) {
        const observedAt = new Date().toISOString();
        const audit = buildSignedTradeIntentAudit(slice.intent, request, observedAt);
        const trade = buildGhostTradeExecution(
          slice.intent,
          audit,
          slice.intent.source_exchange ?? resolveAdapter(env),
          estimateShadowFees(env, slice.intent)
        );
        logger.recordExecution(trade);
        continue;
      }

      const startedAt = Date.now();
      const response = isExchangeOrderTestMode(env)
        ? new Response(JSON.stringify({ status: "TEST_ACCEPTED" }), { status: 200 })
        : await fetch(request.endpoint, request.init);
      const body = await safeJson(response);
      const report = toExecutionReport(slice.intent, response, body, Date.now() - startedAt);

      if (
        report.status === "PARTIAL_FILL" &&
        fillRatio(report.filledSize ?? 0, slice.intent.approvedSize ?? slice.intent.requestedSize) <
          Number(env.MIN_FILL_RATIO ?? 0.8)
      ) {
        logger.warn("SLICED_TWAP_MIN_FILL_RATIO_BREACHED", "Paused remaining TWAP slices", {
          intentId: slice.intent.intentId,
          filledSize: report.filledSize ?? 0,
          requestedSize: slice.intent.approvedSize ?? slice.intent.requestedSize,
          minFillRatio: env.MIN_FILL_RATIO ?? "0.8"
        });
        return;
      }
    } catch (error) {
      logger.error("SLICED_TWAP_CHILD_FAILED", "TWAP child IOC execution failed", {
        intentId: slice.intent.intentId,
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      });
      return;
    }
  }
}

async function retryPartialStopClose(
  env: Env,
  intent: TradeIntent,
  report: ExecutionReport,
  ctx: ExecutionContext,
  logger: Logger
): Promise<ExecutionReport | null> {
  const requestedSize = intent.approvedSize ?? intent.requestedSize;
  const remainingSize = Math.max(0, requestedSize - (report.filledSize ?? 0));
  if (remainingSize <= 0) {
    return null;
  }

  const retryIntent: TradeIntent = {
    ...intent,
    intentId: `${intent.intentId}-stop-retry`,
    requestedSize: remainingSize,
    approvedSize: remainingSize,
    maxSlippageBps: intent.maxSlippageBps * 3,
    rationale: `${intent.rationale} retry stop close`
  };

  try {
    const retryRequest = await prepareOrderRequest(env, retryIntent, resolveAdapter(env));
    const startedAt = Date.now();
    const response = isExchangeOrderTestMode(env)
      ? new Response(JSON.stringify({ status: "TEST_ACCEPTED" }), { status: 200 })
      : await fetch(retryRequest.endpoint, retryRequest.init);
    const body = await safeJson(response);
    const retryReport = toExecutionReport(retryIntent, response, body, Date.now() - startedAt);
    ctx.waitUntil(forwardReport(env, retryReport));

    if (
      !response.ok ||
      retryReport.status === "REJECTED" ||
      retryReport.status === "PARTIAL_FILL"
    ) {
      logger.error(
        "TAKER_MARKET_STOP_RETRY_ESCALATE_OPERATOR",
        "Stop close remained unfilled after retry",
        {
          intentId: intent.intentId,
          retryIntentId: retryIntent.intentId,
          retryStatus: retryReport.status,
          remainingSize
        }
      );
    }

    return retryReport;
  } catch (error) {
    logger.error("TAKER_MARKET_STOP_RETRY_ESCALATE_OPERATOR", "Stop close retry failed", {
      intentId: intent.intentId,
      remainingSize,
      error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
    });
    return null;
  }
}

async function cancelOrder(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger
): Promise<Response> {
  const payload = await request.json<{
    orderId?: string;
    instrumentCode?: string;
    reason?: string;
  }>();
  const orderId = requireString(payload.orderId, "orderId");

  if (isShadowMode(env)) {
    const observedAt = new Date().toISOString();
    const report = cancelExecutionReport(
      orderId,
      payload.instrumentCode,
      new Response(JSON.stringify({ status: "SHADOW_CANCEL_SKIPPED" }), { status: 200 }),
      { status: "SHADOW_CANCEL_SKIPPED" }
    );
    ctx.waitUntil(forwardReport(env, { ...report, observedAt }));
    logger.warn("SHADOW_CANCEL_SKIPPED", "Shadow Mode skipped exchange cancel POST", {
      orderId,
      instrumentCode: payload.instrumentCode ?? null,
      reason: payload.reason ?? "CANCEL",
      observedAt
    });
    return json({ ok: true, shadowMode: true, status: "SHADOW_CANCEL_SKIPPED", report });
  }

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

  if (isShadowMode(env)) {
    const observedAt = new Date().toISOString();
    logger.warn("SHADOW_CANCEL_ALL_SKIPPED", "Shadow Mode skipped exchange cancel-all POST", {
      instrumentCode: payload.instrumentCode ?? "ALL",
      reason: payload.reason ?? "CANCEL_ALL",
      observedAt
    });
    ctx.waitUntil(Promise.resolve());
    return json({
      ok: true,
      shadowMode: true,
      status: "SHADOW_CANCEL_ALL_SKIPPED",
      observedAt
    });
  }

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

async function executionerDiagnostics(env: Env): Promise<Response> {
  const startedAt = performance.now();
  const adapter = resolveAdapter(env);
  const diagnostics: JsonRecord = {
    ok: true,
    service: "sovereign-sigma-executioner",
    observedAt: new Date().toISOString(),
    adapter,
    shadowMode: isShadowMode(env),
    orderTestMode: isExchangeOrderTestMode(env)
  };

  if (adapter !== "hyperliquid") {
    diagnostics.hyperliquidSecrets = {
      ok: true,
      detail:
        "Executioner is not configured for Hyperliquid; Hyperliquid signing secrets are not required.",
      metadata: { adapter }
    };
    diagnostics.latencyMs = roundLatency(performance.now() - startedAt);
    return json(diagnostics);
  }

  const [secret, address, accountAddress] = await Promise.all([
    exchangeSecretWithSource(env, "HL_AGENT_SECRET"),
    exchangeSecretWithSource(env, "HL_AGENT_ADDRESS"),
    exchangeSecretWithSource(env, "HL_ACCOUNT_ADDRESS")
  ]);

  if (!secret.value || !address.value) {
    diagnostics.ok = false;
    diagnostics.hyperliquidSecrets = {
      ok: false,
      detail: "Hyperliquid execution secrets are missing on the executioner Worker.",
      metadata: {
        secretSource: secret.source,
        addressSource: address.source,
        accountAddressSource: accountAddress.source,
        hasSecret: Boolean(secret.value),
        hasAddress: Boolean(address.value),
        hasAccountAddress: Boolean(accountAddress.value)
      }
    };
    diagnostics.latencyMs = roundLatency(performance.now() - startedAt);
    return json(diagnostics, 503);
  }

  try {
    const derivedAddress = SignatureEngine.preloadHyperliquidAgentSecret(secret.value).address;
    const configuredAddress = address.value.trim().toLowerCase();
    const ok = derivedAddress === configuredAddress;

    diagnostics.ok = ok;
    diagnostics.hyperliquidSecrets = {
      ok,
      detail: ok
        ? "Hyperliquid API agent private key derives the configured executioner agent address."
        : "HL_AGENT_ADDRESS does not match the address derived from HL_AGENT_SECRET.",
      metadata: {
        secretSource: secret.source,
        addressSource: address.source,
        accountAddressSource: accountAddress.source,
        hasAccountAddress: Boolean(accountAddress.value),
        configuredAddress: maskAddress(configuredAddress),
        derivedAddress: maskAddress(derivedAddress)
      }
    };
    diagnostics.latencyMs = roundLatency(performance.now() - startedAt);
    return json(diagnostics, ok ? 200 : 503);
  } catch (error) {
    diagnostics.ok = false;
    diagnostics.hyperliquidSecrets = {
      ok: false,
      detail: error instanceof Error ? error.message : "HL_AGENT_SECRET_VALIDATION_FAILED",
      metadata: {
        secretSource: secret.source,
        addressSource: address.source,
        accountAddressSource: accountAddress.source
      }
    };
    diagnostics.latencyMs = roundLatency(performance.now() - startedAt);
    return json(diagnostics, 503);
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
    return json(
      {
        ok: false,
        error: "EXCHANGE_ACCOUNT_BALANCE_ENDPOINT_NOT_CONFIGURED"
      },
      503
    );
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
    logger.error(
      "EXCHANGE_BALANCE_TEST_FAILED",
      "Failed to test exchange account balance endpoint",
      {
        error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
      }
    );
    return json({ ok: false, error: "EXCHANGE_BALANCE_TEST_FAILED" }, 503);
  }
}

function exchangePayload(intent: TradeIntent, adapter: ExchangeAdapter): Record<string, unknown> {
  if (adapter !== "generic-json") {
    throw new Error("UNSUPPORTED_EXCHANGE_ADAPTER");
  }

  const rationale = intent.rationale.toLowerCase();

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
    target_subaccount: intent.targetSubaccount ?? intent.target_subaccount ?? null,
    reduce_only: rationale.includes("closeout") || rationale.includes("reduce-only"),
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

  const expectedPrice = cappedExecutionPrice(
    intent,
    positive(intent.expectedPrice, "EXPECTED_PRICE")
  );
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
  const expectedPrice = cappedExecutionPrice(
    intent,
    positive(intent.expectedPrice, "EXPECTED_PRICE")
  );
  const requestedSize = positive(intent.approvedSize ?? intent.requestedSize, "ORDER_SIZE");
  const tif = hyperliquidTif(env, intent);
  const nonce = Date.now();
  const expiresAfter = hyperliquidExpiresAfter(env, nonce);
  const vaultAddress = normalizeOptionalAddress(
    intent.targetSubaccount ?? intent.target_subaccount ?? env.HL_VAULT_ADDRESS
  );
  const agentSecret = requireString(
    await exchangeSecret(env, "HL_AGENT_SECRET"),
    "HL_AGENT_SECRET"
  );
  const agentAddress = await exchangeSecret(env, "HL_AGENT_ADDRESS");
  const derivedAgentAddress = SignatureEngine.preloadHyperliquidAgentSecret(agentSecret).address;

  if (agentAddress && agentAddress.toLowerCase() !== derivedAgentAddress) {
    throw new Error("HL_AGENT_ADDRESS_SECRET_MISMATCH");
  }

  const wire = hyperliquidOrderWire(expectedPrice, requestedSize, intent.action, asset);
  const order: JsonRecord = {
    a: asset.assetIndex,
    b: intent.action === "BUY",
    p: wire.price,
    s: wire.size,
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
      originalPrice: expectedPrice,
      originalSize: requestedSize,
      priceRounded: wire.priceRounded,
      sizeRounded: wire.sizeRounded,
      tif,
      reduceOnly: order.r,
      cloid: order.c,
      testMode: isExchangeOrderTestMode(env),
      agentAddress: derivedAgentAddress,
      targetSubaccount: vaultAddress
    }
  };
}

async function validatePreTrade(
  env: Env,
  intent: TradeIntent,
  config: GlobalRiskConfig
): Promise<{ ok: true } | { ok: false; reason: string; status: number }> {
  const snapshot = await fetchBookSnapshot(env, intent.instrumentCode);
  const executionStyle = resolveExecutionStyle(intent);

  if (!snapshot) {
    if (isTakerExecutionStyle(executionStyle)) {
      return { ok: false, reason: "TAKER_BBO_UNAVAILABLE", status: 503 };
    }
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

  if (guard > 0 && executionStyle === "POST_ONLY_QUOTE") {
    const touch = intent.action === "BUY" ? bestAsk : bestBid;
    if (touch !== null && Math.abs(touch - intent.expectedPrice) > guard) {
      return { ok: false, reason: "BBO_DRIFT_EXCEEDED", status: 409 };
    }
  }

  if (isTakerExecutionStyle(executionStyle)) {
    const spreadDecision = takerSpreadDecision(bestBid, bestAsk, config.MAX_SPREAD_BPS_FOR_TAKER);
    if (!spreadDecision.ok) {
      return spreadDecision;
    }

    if (executionStyle === "TAKER_IOC") {
      const touch = intent.action === "BUY" ? bestAsk : bestBid;
      if (touch === null) {
        return { ok: false, reason: "TAKER_TOUCH_UNAVAILABLE", status: 503 };
      }

      const expectedSlippageBps = takerExpectedSlippageBps(intent, touch);
      if (expectedSlippageBps > intent.maxSlippageBps) {
        return { ok: false, reason: "TAKER_SLIPPAGE_CAP_EXCEEDED", status: 409 };
      }
    }
  }

  if (intent.timeInForce === "FOK") {
    const levels = intent.action === "BUY" ? (snapshot.asks ?? []) : (snapshot.bids ?? []);
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
    const engine = getTradingEngineStub(env);
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

async function sendCancel(env: Env, payload: Record<string, unknown>): Promise<Response> {
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

    return json(
      { ok: response.ok, status: response.status, orders, body },
      response.ok ? 200 : 502
    );
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

    return json(
      { ok: response.ok, status: response.status, orders, body },
      response.ok ? 200 : 502
    );
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
    return new Response(
      JSON.stringify({ ok: false, status: openOrdersResponse.status, body: openOrdersBody }),
      {
        status: 502,
        headers: { "content-type": "application/json;charset=UTF-8" }
      }
    );
  }

  const results: Array<{ orderId: string; instrumentCode: string; status: number; ok: boolean }> =
    [];
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
    const orders = normalizeOpenOrders(openOrdersBody).filter(
      (order) =>
        !instrument || instrument === "ALL" || order.instrumentCode === instrument.toLowerCase()
    );

    if (!openOrdersResponse.ok) {
      return new Response(
        JSON.stringify({ ok: false, status: openOrdersResponse.status, body: openOrdersBody }),
        {
          status: 502,
          headers: { "content-type": "application/json;charset=UTF-8" }
        }
      );
    }

    if (orders.length === 0) {
      return new Response(JSON.stringify({ ok: true, cancelled: 0, results: [] }), {
        status: 200,
        headers: { "content-type": "application/json;charset=UTF-8" }
      });
    }

    const cancelPayload = await prepareHyperliquidCancelRequest(
      env,
      orders.map((order) => ({
        instrumentCode: order.instrumentCode,
        orderId: order.exchangeOrderId
      }))
    );
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
      cancelWires.push({
        asset: asset.assetIndex,
        cloid: normalizeHyperliquidCloid(cancel.orderId)
      });
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
  const refill = positiveNumberOrDefault(
    env.HL_REST_REFILL_PER_SECOND,
    Math.min(18, capacity / 60)
  );
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
  return (
    env.HL_EXCHANGE_URL ?? env.EXCHANGE_ORDER_ENDPOINT ?? `${hyperliquidBaseUrl(env)}/exchange`
  );
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
  const cacheKey = coin.toUpperCase();
  const configuredIndex = Number(env.HL_ASSET_INDEX);
  const configuredAsset = env.HL_ASSET?.trim().toUpperCase();
  if (
    Number.isSafeInteger(configuredIndex) &&
    configuredIndex >= 0 &&
    (!configuredAsset || configuredAsset === cacheKey)
  ) {
    return {
      coin: cacheKey,
      assetIndex: configuredIndex,
      szDecimals: 8,
      loadedAt: Date.now()
    };
  }

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
  return requireString(
    env.HL_ACCOUNT_ADDRESS ?? env.HL_AGENT_ADDRESS,
    "HL_ACCOUNT_ADDRESS"
  ).toLowerCase();
}

function hyperliquidCoin(env: Env, instrumentCode: string): string {
  const [base] = instrumentCode.replace("-perp", "").split("-");
  if (base && base.trim().length > 0) {
    return base.trim().toUpperCase();
  }

  return requireString(env.HL_ASSET, "HL_ASSET").toUpperCase();
}

function hyperliquidTif(env: Env, intent: TradeIntent): "Alo" | "Ioc" | "Gtc" {
  const executionStyle = resolveExecutionStyle(intent);
  if (executionStyle === "TAKER_IOC" || executionStyle === "TAKER_MARKET") {
    return "Ioc";
  }
  if (intent.timeInForce === "ALO") {
    return "Alo";
  }
  if (intent.postOnly !== false) {
    return "Alo";
  }
  if (intent.timeInForce === "IOC" || intent.orderType === "MARKET") {
    return "Ioc";
  }
  const configured = env.HL_DEFAULT_TIF?.trim().toLowerCase();
  if (configured === "alo") {
    return "Alo";
  }
  if (configured === "gtc") {
    return "Gtc";
  }
  if (configured === "ioc") {
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

function cancelExecutionReport(
  orderId: string,
  instrumentCode: string | undefined,
  response: Response,
  body: Record<string, unknown> | null
): ExecutionReport {
  const rawStatus = stringField(body, ["status", "state", "order_status"]);
  const clientId =
    stringField(body, ["clientOrderId", "origClientOrderId", "client_id", "clientId"]) ?? orderId;
  const exchangeOrderId =
    stringField(body, ["orderId", "order_id", "id", "exchange_order_id"]) ?? orderId;
  const resolvedInstrument =
    instrumentCode ??
    instrumentFromBinanceSymbol(stringField(body, ["symbol"])) ??
    stringField(body, ["instrument", "instrument_code"]);
  const filledSize =
    numberField(body, ["executedQty", "filled_size", "filledSize", "executed_size"]) ?? 0;
  const orderSize = numberField(body, ["origQty", "size", "quantity", "order_size"]);

  return {
    clientId,
    exchangeOrderId,
    instrumentCode: resolvedInstrument,
    side: normalizeSide(stringField(body, ["side"])),
    orderSize,
    status: normalizeOrderStatus(rawStatus ?? "CANCELED", response.ok, filledSize, orderSize ?? 0),
    filledSize,
    achievedPrice:
      averageExecutionPrice(body) ?? numberField(body, ["price", "avg_price", "average_price"]),
    fees: extractFees(body),
    latencyMs: 0,
    reason: response.ok
      ? "CANCEL_ACKNOWLEDGED"
      : String(body?.message ?? body?.error ?? response.status),
    rawStatus: rawStatus ?? undefined,
    observedAt: new Date().toISOString()
  };
}

async function forwardReport(env: Env, report: ExecutionReport): Promise<void> {
  const engine = getTradingEngineStub(env);
  await engine.fetch(
    new Request("https://trading-engine.internal/execution/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report)
    })
  );
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

  return rawOrders.filter(isRecord).map((order) => {
    const rawSymbol = stringField(order, ["symbol", "instrument", "instrument_code"]);
    return {
      clientId:
        stringField(order, ["client_id", "clientId", "clientOrderId", "origClientOrderId"]) ?? null,
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
      filledSize:
        numberField(order, ["executedQty", "filled_size", "filledSize", "executed_size"]) ?? 0,
      status: normalizeOrderStatus(stringField(order, ["status", "state"]), true, 0, 1),
      observedAt: new Date().toISOString()
    };
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8" }
  });
}

export const __test__ = {
  buildTwapSlices,
  cappedExecutionPrice,
  evaluateCascadeTakerGate,
  hyperliquidOrderWire,
  hyperliquidPriceDecimals,
  hyperliquidTif,
  normalizeOrderStatus,
  prepareOrderRequest,
  resolveExecutionStyle,
  validatePreTrade,
  toExecutionReport,
  clearIntentLedger: () => {
    intentLedger.clear();
    hedgeCooldownByInstrument.clear();
  }
};
