import { Hono, type Context } from "hono";
import { AuthManager } from "./AuthManager";
import { ActiveTokenStore } from "./auth/JwtRevocation";
import { calibrateGoldenColos, type ColoCalibrationOptions } from "./ColoCalibrator";
import { ConfigManager } from "./ConfigManager";
import { Governor } from "./Governor";
import { Logger } from "./Logger";
import { readNotificationSettings, writeNotificationSettings } from "./NotificationSettings";
import { buildPaperLedger, type PaperLedger } from "./PaperLedger";
import {
  evaluateCascadeLiveReadiness,
  type TwoPersonApproval
} from "./strategy/cascade/OperationalSafeguards";
import { StrategyVault } from "./StrategyVault";
import { TradingEngine } from "./TradingEngine";
import { Notifier } from "./utils/Notifier";
import { getTradingEngineStub } from "./utils/TradingEngineStub";
import { evaluateRateLimit, ipRateLimitKey } from "./gateway/middleware/RateLimitMiddleware";
import { adminUiResponse } from "./gateway/AdminUi";
import {
  ACTIVE_TOKEN_PREFIX,
  AGENT_NAMES,
  CASCADE_CONFIG_FREEZE_HOURS,
  CASCADE_LAST_BACKTEST_REPORT_KEY,
  CASCADE_LAST_CONFIG_CHANGE_AT_KEY,
  CASCADE_PAPER_ARMED_AT_KEY,
  CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS,
  CASCADE_TWO_PERSON_READ_APPROVAL_KEY,
  DEFAULT_ADMIN_PAGE_SIZE,
  ENGINE_HEALTH_TIMEOUT_MS,
  MAX_ADMIN_PAGE_SIZE,
  PAPER_SESSION_STARTED_AT_KEY
} from "./gateway/GatewayConstants";
import type {
  AgentTraceRow,
  AlertTestRequest,
  AttributionRow,
  AuthenticatedAdmin,
  DateRangeFilter,
  ExecutionQualityAggregateRow,
  ExecutionQualityAssetRow,
  LiveReadinessCheck,
  LiveReadinessReport,
  LoginRequest,
  LogRow,
  NotificationSettingsRequest,
  PaperLedgerFillRow,
  PaperPnlAggregateRow,
  TradeHistoryRow,
  TradeStatusBreakdownRow,
  TraceTelemetryRow,
  VaultUpdateRequest
} from "./gateway/AdminModels";
import { gatewayRuntime, type GatewayHono } from "./gateway/GatewayRuntime";
import { gatewayCatalogResponse } from "./gateway/RouteCatalog";
import {
  buildCostDashboard,
  readCostBudgetSettings,
  readCostDashboard,
  updateCostBudgets
} from "./gateway/CostDashboard";
import {
  authenticateAdmin,
  authenticateIngest,
  authKv,
  createAuthManager,
  currentLoginLockout,
  enforceAdminRateLimit,
  listRevokedAdminTokens,
  rateLimitResponse,
  requiredScopeForAdminRequest,
  revokeAdminToken,
  revokeAllTokensForSubject
} from "./gateway/GatewayAuth";
import { evaluateHyperliquidSecrets } from "./gateway/HyperliquidSecretDiagnostics";
import {
  evaluateMoltworkerHeartbeat,
  readMoltworkerHealth,
  updateMoltworkerHeartbeat
} from "./gateway/MoltworkerGateway";
import {
  buildLogFilters,
  buildTradeFilters,
  formatLogRow,
  formatPaperLedgerFill,
  formatTradeRow
} from "./gateway/AdminDataMappers";
import {
  configTelemetry,
  diffConfig,
  hasRiskConfigMutation,
  logSupervisorAction,
  recordCascadeConfigMetadata,
  requestsCascadeLivePromotion,
  requiresHighImpactConfirmation
} from "./gateway/AdminConfigGuards";
import {
  encryptSecret,
  normalizeAlertPriority,
  normalizeVaultKey,
  safeAlertText,
  safeResponseJson,
  sanitizeReason
} from "./gateway/AdminValidation";
import { corsPreflight, json, readJsonBody, withCors } from "./gateway/ResponseHelpers";
import { logSecurityEvent, maskTokenId, sourceIp } from "./gateway/SecurityAudit";
import { placementColo, topologyTelemetry, withTopologyHeaders } from "./gateway/Topology";
import {
  clampInteger,
  finiteNumber,
  isJsonRecord,
  normalizeEngineMode,
  normalizeEnum,
  nullableRound,
  numberOption,
  pagination,
  parseDateRange,
  parseJsonRecord,
  parseJsonValue,
  positiveNumber,
  readNumberField,
  readString,
  round,
  stringNumber
} from "./gateway/ValueCodecs";
import type {
  AdminConfigUpdate,
  EdgeTopology,
  Env,
  GlobalRiskConfig,
  JsonRecord,
  NotificationSettingsUpdate
} from "./types";

export { TradingEngine };

const gatewayRouter = new Hono<GatewayHono>();

gatewayRouter.options("*", () => corsPreflight());

gatewayRouter.get("/health", async (c) => {
  const runtime = gatewayRuntime(c);
  runtime.logger.info(
    "SYSTEM_HEARTBEAT",
    "Gateway heartbeat observed at Cloudflare edge",
    topologyTelemetry(runtime.topology),
    runtime.topology.requestId
  );

  return routeToEngine(c.req.raw, c.env, runtime.topology, {
    timeoutMs: ENGINE_HEALTH_TIMEOUT_MS,
    timeoutResponse: gatewayHealthFallback(runtime.topology)
  });
});

for (const route of [
  "/state",
  "/performance",
  "/metrics/performance",
  "/slippage",
  "/book/snapshot",
  "/dom/heatmap",
  "/liquidations/heatmap"
]) {
  gatewayRouter.get(route, async (c) => {
    const runtime = gatewayRuntime(c);
    const auth = await authenticateAdmin(
      c.req.raw,
      c.env,
      runtime.logger,
      runtime.topology,
      "TELEMETRY:READ"
    );
    return auth instanceof Response ? auth : routeToEngine(c.req.raw, c.env, runtime.topology);
  });
}

gatewayRouter.get("/stream", async (c) => {
  const runtime = gatewayRuntime(c);
  if (c.req.raw.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ ok: false, error: "WebSocket upgrade required" }, 426);
  }

  const auth = await authenticateAdmin(
    c.req.raw,
    c.env,
    runtime.logger,
    runtime.topology,
    "TELEMETRY:READ"
  );
  return auth instanceof Response ? auth : routeToEngine(c.req.raw, c.env, runtime.topology);
});

for (const route of [
  "/tick",
  "/market/tick",
  "/hyperliquid/tick",
  "/hyperliquid/raw",
  "/liquidation"
]) {
  gatewayRouter.post(route, async (c) => routeAuthenticatedIngest(c));
}

gatewayRouter.get("/market/ws", async (c) => {
  if (c.req.raw.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json({ ok: false, error: "WebSocket upgrade required" }, 426);
  }
  return routeAuthenticatedIngest(c);
});

gatewayRouter.post("/agent/signal", async (c) => routeAuthenticatedIngest(c));
gatewayRouter.get("/moltworker/health", (c) => readMoltworkerHealth(c.env));

gatewayRouter.post("/login", async (c) => {
  const runtime = gatewayRuntime(c);
  return handleLogin(c.req.raw, c.env, runtime.logger, runtime.topology);
});

gatewayRouter.all("/admin", async (c) => routeAdmin(c));
gatewayRouter.all("/admin/*", async (c) => routeAdmin(c));

gatewayRouter.get("/", (c) => {
  const runtime = gatewayRuntime(c);
  return gatewayCatalogResponse(c.env, runtime.topology);
});

gatewayRouter.notFound((c) => {
  const runtime = gatewayRuntime(c);
  return gatewayCatalogResponse(c.env, runtime.topology);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return gatewayRouter.fetch(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;

async function routeAuthenticatedIngest(c: Context<GatewayHono>): Promise<Response> {
  const runtime = gatewayRuntime(c);
  const ingestAuth = await authenticateIngest(c.req.raw, c.env, runtime.logger, runtime.topology);
  return ingestAuth instanceof Response
    ? ingestAuth
    : routeToEngine(c.req.raw, c.env, runtime.topology);
}

async function routeAdmin(c: Context<GatewayHono>): Promise<Response> {
  const runtime = gatewayRuntime(c);
  return handleAdminRequest(
    c.req.raw,
    c.env,
    runtime.logger,
    runtime.configManager,
    runtime.topology
  );
}

async function handleLogin(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const authManager = createAuthManager(env);

  if (!authManager || !env.ADMIN_PASSWORD) {
    logSecurityEvent(
      logger,
      "AUTH_CONFIG_MISSING",
      "Admin authentication secrets are not fully configured",
      request,
      url,
      topology
    );
    return json({ ok: false, error: "Authentication unavailable" }, 503);
  }

  const loginAttemptLimit = await evaluateRateLimit(
    authKv(env),
    ipRateLimitKey("login:attempt:minute", request),
    { windowMs: 60_000, maxRequests: 5 }
  );

  if (!loginAttemptLimit.allowed) {
    logger.warn("LOGIN_RATE_LIMITED", "Admin login attempt rate-limited", {
      sourceIp: sourceIp(request),
      endpoint: url.pathname,
      retryAfterSeconds: loginAttemptLimit.retryAfterSeconds,
      colo: topology.colo,
      placement: topology.placement
    });
    return rateLimitResponse(loginAttemptLimit);
  }

  const hourlyLoginLimit = await evaluateRateLimit(
    authKv(env),
    ipRateLimitKey("login:attempt:hour", request),
    { windowMs: 3_600_000, maxRequests: 20 }
  );

  if (!hourlyLoginLimit.allowed) {
    logger.warn("LOGIN_RATE_LIMITED", "Admin login hourly attempt rate-limited", {
      sourceIp: sourceIp(request),
      endpoint: url.pathname,
      retryAfterSeconds: hourlyLoginLimit.retryAfterSeconds,
      colo: topology.colo,
      placement: topology.placement
    });
    return rateLimitResponse(hourlyLoginLimit);
  }

  const existingLockout = await currentLoginLockout(request, env);

  if (existingLockout) {
    logger.warn("LOGIN_LOCKOUT", "Admin login rejected because IP is locked out", {
      sourceIp: sourceIp(request),
      endpoint: url.pathname,
      retryAfterSeconds: existingLockout.retryAfterSeconds,
      colo: topology.colo,
      placement: topology.placement
    });
    return rateLimitResponse(existingLockout);
  }

  const body = await readJsonBody<LoginRequest>(request);
  const password = typeof body?.password === "string" ? body.password : "";
  const passwordOk = await authManager.verifyPassword(password);

  if (!passwordOk) {
    const failedLimit = await evaluateRateLimit(
      authKv(env),
      ipRateLimitKey("login:failed", request),
      { windowMs: 60_000, maxRequests: 4, lockoutMs: 900_000 }
    );

    if (!failedLimit.allowed) {
      logger.warn("LOGIN_LOCKOUT", "Admin login IP locked out after failed attempts", {
        sourceIp: sourceIp(request),
        endpoint: url.pathname,
        retryAfterSeconds: failedLimit.retryAfterSeconds,
        colo: topology.colo,
        placement: topology.placement
      });
      return rateLimitResponse(failedLimit);
    }

    logSecurityEvent(logger, "LOGIN_FAILED", "Rejected login attempt", request, url, topology, {
      reason: "INVALID_PASSWORD"
    });
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  await authKv(env).delete(ipRateLimitKey("login:failed", request));

  const scopes = AuthManager.normalizeScopes(body?.scopes ?? ["READ", "WRITE"]);
  const subject =
    typeof body?.subject === "string" && body.subject.length > 0 ? body.subject : "admin";
  const token = await authManager.generateToken({
    sub: subject,
    scopes
  });
  const claims = await authManager.verifyClaims(token);

  if (claims) {
    await new ActiveTokenStore(authKv(env), ACTIVE_TOKEN_PREFIX).track({
      jti: claims.jti,
      subject: claims.sub,
      issuedAt: new Date(claims.iat * 1_000).toISOString(),
      expiresAt: new Date(claims.exp * 1_000).toISOString(),
      scopes: claims.scopes
    });
  }

  logger.info("LOGIN_SUCCEEDED", "Admin JWT issued", {
    subject,
    scopes,
    sourceIp: sourceIp(request),
    endpoint: url.pathname,
    expiresInSeconds: AuthManager.tokenTtlSeconds(),
    colo: topology.colo,
    placement: topology.placement
  });

  return json(
    {
      ok: true,
      token,
      tokenType: "Bearer",
      expiresIn: AuthManager.tokenTtlSeconds(),
      scopes
    },
    200,
    { "cache-control": "no-store" }
  );
}

async function handleAdminRequest(
  request: Request,
  env: Env,
  logger: Logger,
  configManager: ConfigManager,
  topology: EdgeTopology
): Promise<Response> {
  const url = new URL(request.url);
  const requiredScope = requiredScopeForAdminRequest(request);
  const auth = await authenticateAdmin(request, env, logger, topology, requiredScope);

  if (auth instanceof Response) {
    return auth;
  }

  const adminRateLimit = await enforceAdminRateLimit(request, env, auth, logger, topology);

  if (adminRateLimit) {
    return adminRateLimit;
  }

  if (url.pathname === "/admin") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return json({
      ok: true,
      subject: auth.subject,
      scopes: auth.claims.scopes,
      routes: [
        "GET /admin/ui",
        "GET /admin/config",
        "POST|PUT|PATCH /admin/config",
        "GET /admin/health",
        "GET /admin/state",
        "GET /admin/settings",
        "GET /admin/diagnostics",
        "GET /admin/live-readiness",
        "POST /admin/live-readiness/approve",
        "GET /admin/auth/revoked",
        "POST /admin/auth/revoke",
        "POST /admin/auth/revoke-all-for-subject",
        "POST /admin/moltworker/heartbeat",
        "POST /admin/settings/notifications",
        "GET|POST /admin/topology/calibrate",
        "GET /admin/performance",
        "GET /admin/metrics/performance",
        "POST /admin/maintenance/prune-logs",
        "POST /admin/maintenance/recover",
        "GET /admin/slippage",
        "GET /admin/history",
        "GET /admin/trace",
        "GET /admin/attribution",
        "GET /admin/alerts",
        "POST /admin/alerts/test",
        "POST /admin/replay",
        "GET /admin/replay/status",
        "GET|POST /admin/vault",
        "POST /admin/vault/test",
        "POST /admin/news/sentiment",
        "POST /admin/news/blackout",
        "GET /admin/cascade/active",
        "GET /admin/cascade/signals",
        "GET /admin/cascade/positions",
        "POST /admin/cascade/positions/:id/close",
        "POST /admin/cascade/blackout",
        "GET /admin/cascade/heat",
        "POST /admin/backtest/cascade",
        "GET /admin/book/snapshot",
        "GET /admin/dom/heatmap",
        "GET /admin/liquidations/heatmap",
        "GET /admin/stream",
        "GET /admin/logs"
      ]
    });
  }

  if (url.pathname === "/admin/ui") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return adminUiResponse();
  }

  if (url.pathname === "/admin/config") {
    return handleAdminConfig(request, env, logger, configManager, topology, auth);
  }

  if (url.pathname === "/admin/health") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return routeToEngine(remapRequestPath(request, "/health"), env, topology);
  }

  if (url.pathname === "/admin/state") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return routeToEngine(remapRequestPath(request, "/state"), env, topology);
  }

  if (url.pathname === "/admin/settings") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return readAdminSettings(env, configManager);
  }

  if (url.pathname === "/admin/settings/notifications") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return updateNotificationSettings(request, env, logger, topology, auth);
  }

  if (url.pathname === "/admin/strategy") {
    if (request.method === "GET") {
      return readStrategyVault(env);
    }
    if (request.method === "POST") {
      return createStrategyVersion(request, env, logger, topology, auth, configManager);
    }
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  if (url.pathname === "/admin/strategy/activate") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return activateStrategyVersion(request, env, logger, topology, auth);
  }

  if (url.pathname === "/admin/diagnostics") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return runDiagnostics(env, logger, topology);
  }

  if (url.pathname === "/admin/live-readiness") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return readLiveReadiness(env, topology);
  }

  if (url.pathname === "/admin/live-readiness/approve") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return approveCascadeLiveReadiness(env, logger, topology, auth);
  }

  if (url.pathname === "/admin/auth/revoke") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return revokeAdminToken(request, env, logger, topology, auth);
  }

  if (url.pathname === "/admin/auth/revoke-all-for-subject") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return revokeAllTokensForSubject(request, env, logger, topology, auth);
  }

  if (url.pathname === "/admin/auth/revoked") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return listRevokedAdminTokens(env, url);
  }

  if (url.pathname === "/admin/moltworker/heartbeat") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return updateMoltworkerHeartbeat(request, env, logger, topology, auth);
  }

  if (url.pathname === "/admin/topology/calibrate") {
    if (request.method !== "GET" && request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return handleTopologyCalibration(request, env, logger, configManager, topology, auth);
  }

  if (url.pathname === "/admin/performance") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return routeToEngine(remapRequestPath(request, "/performance"), env, topology);
  }

  if (url.pathname === "/admin/metrics/performance") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/metrics/performance"), env, topology);
  }

  if (url.pathname === "/admin/maintenance/reset-latency") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/maintenance/reset-latency"), env, topology);
  }

  if (url.pathname === "/admin/maintenance/recover") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    logger.warn("ADMIN_ENGINE_RECOVERY_REQUESTED", "Admin requested controlled engine recovery", {
      actor: auth.subject,
      sourceIp: sourceIp(request),
      colo: topology.colo,
      placement: topology.placement
    });

    return routeToEngine(remapRequestPath(request, "/maintenance/recover"), env, topology);
  }

  if (url.pathname === "/admin/maintenance/prune-logs") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    logger.warn("ADMIN_LOG_PRUNE_REQUESTED", "Admin requested stale operational log cleanup", {
      actor: auth.subject,
      sourceIp: sourceIp(request),
      colo: topology.colo,
      placement: topology.placement
    });

    return routeToEngine(remapRequestPath(request, "/maintenance/prune-logs"), env, topology);
  }

  if (url.pathname === "/admin/slippage") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/slippage"), env, topology);
  }

  if (url.pathname === "/admin/execution-quality") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return readExecutionQuality(env, url);
  }

  if (url.pathname === "/admin/history") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return readTradeHistory(env, url);
  }

  if (url.pathname === "/admin/trace") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return readAgentTrace(env, url);
  }

  if (url.pathname === "/admin/attribution") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return readAttribution(env, url);
  }

  if (url.pathname === "/admin/costs") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return readCostDashboard(env, topology, routeToEngine);
  }

  if (url.pathname === "/admin/costs/budgets") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return updateCostBudgets(request, env, logger, topology, auth);
  }

  if (url.pathname === "/admin/alerts") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return readAlertingStatus(env);
  }

  if (url.pathname === "/admin/alerts/test") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return sendTestAlert(request, env, logger, topology, auth);
  }

  if (url.pathname === "/admin/replay") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/admin/replay"), env, topology);
  }

  if (url.pathname === "/admin/replay/status") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/admin/replay/status"), env, topology);
  }

  if (url.pathname === "/admin/vault") {
    return handleVaultRequest(request, env, logger, topology, auth);
  }

  if (url.pathname === "/admin/vault/test") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return testVaultConnection(env, logger, topology, auth);
  }

  if (url.pathname === "/admin/news/sentiment") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/news/sentiment"), env, topology);
  }

  if (url.pathname === "/admin/news/blackout") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/news/blackout"), env, topology);
  }

  if (url.pathname === "/admin/cascade/active") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/admin/cascade/active"), env, topology);
  }

  if (url.pathname === "/admin/cascade/signals") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/admin/cascade/signals"), env, topology);
  }

  if (url.pathname === "/admin/cascade/positions") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/admin/cascade/positions"), env, topology);
  }

  if (/^\/admin\/cascade\/positions\/[^/]+\/close$/.test(url.pathname)) {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, url.pathname), env, topology);
  }

  if (url.pathname === "/admin/cascade/blackout") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/admin/cascade/blackout"), env, topology);
  }

  if (url.pathname === "/admin/cascade/heat") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/admin/cascade/heat"), env, topology);
  }

  if (url.pathname === "/admin/backtest/cascade") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/admin/backtest/cascade"), env, topology);
  }

  if (url.pathname === "/admin/book/snapshot") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/book/snapshot"), env, topology);
  }

  if (url.pathname === "/admin/dom/heatmap") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/dom/heatmap"), env, topology);
  }

  if (url.pathname === "/admin/liquidations/heatmap") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/liquidations/heatmap"), env, topology);
  }

  if (url.pathname === "/admin/stream") {
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ ok: false, error: "WebSocket upgrade required" }, 426);
    }

    return routeToEngine(remapRequestPath(request, "/stream"), env, topology);
  }

  if (url.pathname === "/admin/logs") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return readAdminLogs(env, url);
  }

  return json({ ok: false, error: "Not found" }, 404);
}

async function handleAdminConfig(
  request: Request,
  env: Env,
  logger: Logger,
  configManager: ConfigManager,
  topology: EdgeTopology,
  admin: AuthenticatedAdmin
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET") {
    const config = await configManager.fetchConfig();
    return json({ ok: true, config });
  }

  if (!["POST", "PUT", "PATCH"].includes(request.method)) {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const update = await request.json<AdminConfigUpdate>();
  const actor =
    typeof update.actor === "string" && update.actor.length > 0 ? update.actor : admin.subject;
  const requestedMode = normalizeEngineMode(update.mode);

  if (update.mode && !requestedMode) {
    return json({ ok: false, error: "INVALID_ENGINE_MODE" }, 400);
  }

  if (requestedMode === "LIVE" && env.EXCHANGE_ORDER_TEST_MODE !== "false") {
    return json(
      {
        ok: false,
        error: "LIVE_EXECUTION_LOCKED_BY_TEST_MODE",
        message: "EXCHANGE_ORDER_TEST_MODE must be false before the gateway can enter LIVE mode."
      },
      409
    );
  }

  if (requestedMode === "LIVE" && update.confirmLive !== true) {
    return json(
      {
        ok: false,
        error: "LIVE_MODE_CONFIRMATION_REQUIRED"
      },
      409
    );
  }

  const governor = new Governor(env.CONFIG_STORE);
  const currentConfig = await configManager.fetchConfig();
  let nextConfig = currentConfig;
  let changedParameters: ReturnType<typeof diffConfig> = {};

  if (hasRiskConfigMutation(update)) {
    nextConfig = ConfigManager.mergeUpdate(currentConfig, update, actor);
    changedParameters = diffConfig(currentConfig, nextConfig);
  }

  const cascadeLiveRequested = requestsCascadeLivePromotion(currentConfig, nextConfig);

  if (cascadeLiveRequested) {
    const readiness = await evaluateCascadeLiveReadinessFromState(env, topology, nextConfig, admin);
    if (!readiness.ok) {
      logger.warn("CASCADE_LIVE_READINESS_GATE_BLOCKED", "Cascade live/taker promotion blocked", {
        actor,
        changedParameters,
        failedChecks: readiness.checks.filter((check) => !check.ok).map((check) => check.id),
        colo: topology.colo,
        placement: topology.placement
      });
      return json(
        {
          ok: false,
          error: "CASCADE_LIVE_READINESS_CHECK_FAILED",
          readiness
        },
        409
      );
    }
  }

  const livePostureRequested =
    requestedMode === "LIVE" ||
    (currentConfig.TRADING_ENABLED !== true &&
      nextConfig.TRADING_ENABLED === true &&
      env.SHADOW_MODE !== "true");

  if (livePostureRequested && update.confirmLiveReadinessOverride !== true) {
    const readiness = await evaluateLiveReadiness(env, topology);
    if (!readiness.ok) {
      logger.warn("LIVE_READINESS_GATE_BLOCKED", "Live posture request blocked by readiness gate", {
        actor,
        requestedMode,
        changedParameters,
        failedChecks: readiness.checks.filter((check) => !check.ok).map((check) => check.id),
        colo: topology.colo,
        placement: topology.placement
      });
      return json(
        {
          ok: false,
          error: "LIVE_READINESS_CHECK_FAILED",
          readiness
        },
        409
      );
    }
  }

  if (livePostureRequested && update.confirmCostBudgetOverride !== true) {
    const costReport = await buildCostDashboard(env, topology, routeToEngine);
    const enforcement = costReport.budgets.enforcement;
    if (!costReport.ok && (enforcement === "BLOCK_LIVE" || enforcement === "BLOCK_ALL")) {
      logger.warn("COST_BUDGET_GATE_BLOCKED", "Live posture request blocked by hard cost budget", {
        actor,
        requestedMode,
        enforcement,
        totalEstimatedUsd: costReport.totals.estimatedUsd,
        budgetUsd: costReport.budgets.dailyBudgetUsd,
        violations: costReport.violations,
        colo: topology.colo,
        placement: topology.placement
      });
      return json(
        {
          ok: false,
          error: "COST_BUDGET_CHECK_FAILED",
          cost: costReport
        },
        409
      );
    }
  }

  if (requiresHighImpactConfirmation(changedParameters, update)) {
    return json(
      {
        ok: false,
        error: "HIGH_IMPACT_CONFIG_CONFIRMATION_REQUIRED",
        changedParameters
      },
      409
    );
  }

  if (Object.keys(changedParameters).length > 0) {
    await configManager.writeConfig(nextConfig);
    await recordCascadeConfigMetadata(env, currentConfig, nextConfig, changedParameters);

    logger.warn("ADMIN_CONFIG_UPDATED", "Admin configuration persisted", {
      actor,
      changedParameters,
      previousConfig: configTelemetry(currentConfig),
      nextConfig: configTelemetry(nextConfig),
      colo: topology.colo,
      placement: topology.placement
    });

    if (changedParameters.TRADING_ENABLED) {
      const delivery = await new Notifier(env, () => undefined).deliverNow(
        {
          priority: nextConfig.TRADING_ENABLED ? "CRITICAL" : "HIGH",
          title: nextConfig.TRADING_ENABLED
            ? "Sovereign-Sigma trading enabled"
            : "Sovereign-Sigma trading disabled",
          message: `${actor} changed TRADING_ENABLED from ${String(
            changedParameters.TRADING_ENABLED.before
          )} to ${String(changedParameters.TRADING_ENABLED.after)}.`,
          dedupeKey: `trading-enabled:${String(changedParameters.TRADING_ENABLED.after)}`,
          metadata: {
            actor,
            sourceIp: sourceIp(request),
            colo: topology.colo,
            placement: topology.placement,
            changedParameters
          }
        },
        { respectDebounce: false }
      );

      logger.warn("TRADING_ENABLED_ALERT_SENT", "Trading-enabled change alert dispatched", {
        actor,
        attempted: delivery.attempted,
        delivered: delivery.delivered,
        deliveryOk: delivery.ok,
        enabled: nextConfig.TRADING_ENABLED
      });
    }
  }

  if (cascadeLiveRequested && Object.keys(changedParameters).length > 0) {
    await env.CONFIG_STORE.delete(CASCADE_TWO_PERSON_READ_APPROVAL_KEY);
  }

  const macroBias = update.clearMacroBias
    ? await governor.clearMacroBias()
    : update.macroBias
      ? await governor.writeMacroBias(update.macroBias, actor)
      : await governor.readMacroBias();
  const clearedTemporaryOverride = update.clearTemporaryOverride
    ? await governor.clearTemporaryOverride()
    : null;
  const temporaryOverride = update.clearTemporaryOverride
    ? null
    : update.temporaryOverride
      ? await governor.writeTemporaryOverride(update.temporaryOverride, actor)
      : await governor.readTemporaryOverride();

  if (update.macroBias) {
    logSupervisorAction(logger, {
      actor,
      kind: "MACRO_BIAS",
      reason: macroBias.reason,
      confidence: macroBias.confidence,
      payload: macroBias,
      topology
    });
  }

  if (update.clearMacroBias) {
    logSupervisorAction(logger, {
      actor,
      kind: "MACRO_BIAS",
      reason: "External macro bias cleared",
      confidence: 1,
      payload: macroBias,
      topology
    });
  }

  if (update.temporaryOverride && temporaryOverride) {
    logSupervisorAction(logger, {
      actor,
      kind: "TEMPORARY_OVERRIDE",
      reason: temporaryOverride.reason,
      confidence: 1,
      payload: temporaryOverride,
      topology
    });
  }

  if (update.clearTemporaryOverride) {
    logSupervisorAction(logger, {
      actor,
      kind: "TEMPORARY_OVERRIDE",
      reason: "Temporary governance override cleared",
      confidence: 1,
      payload: {
        clearedOverrideId: clearedTemporaryOverride?.overrideId ?? null,
        clearedOverride: clearedTemporaryOverride
      },
      topology
    });
  }

  const refreshResponse = await routeToEngine(
    new Request(new URL("/admin/config", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signal: "REFRESH_CONFIG",
        config: nextConfig,
        ...(requestedMode ? { mode: requestedMode } : {})
      } satisfies AdminConfigUpdate)
    }),
    env,
    topology
  );

  return json({
    ok: refreshResponse.ok,
    config: nextConfig,
    macroBias,
    temporaryOverride,
    clearedTemporaryOverride,
    engineRefreshStatus: refreshResponse.status
  });
}

async function readAdminSettings(env: Env, configManager: ConfigManager): Promise<Response> {
  const notifier = new Notifier(env, () => undefined);
  const strategyVault = new StrategyVault(env.TRADING_DB, env.CONFIG_STORE);
  const [
    config,
    alerting,
    vault,
    notifications,
    hyperliquidSecrets,
    strategies,
    activeStrategy,
    costBudgets
  ] = await Promise.all([
    configManager.fetchConfig(),
    notifier.statusAsync(),
    vaultStatus(env),
    readNotificationSettings(env),
    evaluateHyperliquidSecrets(env),
    strategyVault.listVersions(20).catch(() => []),
    strategyVault.activeVersion().catch(() => null),
    readCostBudgetSettings(env)
  ]);

  return json({
    ok: true,
    config,
    notifications,
    alerting: {
      ...alerting,
      configured: alerting.channels.some((channel) => channel.configured)
    },
    vault: {
      ...vault,
      executionerHyperliquid: {
        ok: hyperliquidSecrets.ok,
        detail: hyperliquidSecrets.detail,
        metadata: hyperliquidSecrets.metadata
      }
    },
    backend: backendSettings(env),
    strategyVault: {
      active: activeStrategy,
      versions: strategies
    },
    costBudgets
  });
}

async function readStrategyVault(env: Env): Promise<Response> {
  const vault = new StrategyVault(env.TRADING_DB, env.CONFIG_STORE);
  const [versions, active] = await Promise.all([vault.listVersions(50), vault.activeVersion()]);

  return json({
    ok: true,
    strategyVault: {
      active,
      versions
    }
  });
}

async function createStrategyVersion(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  admin: AuthenticatedAdmin,
  configManager: ConfigManager
): Promise<Response> {
  const body =
    (await readJsonBody<{
      name?: string;
      description?: string;
      config?: GlobalRiskConfig;
      parameters?: JsonRecord;
      performance?: JsonRecord;
    }>(request)) ?? {};
  const currentConfig = await configManager.fetchConfig();
  const vault = new StrategyVault(env.TRADING_DB, env.CONFIG_STORE);
  const version = await vault.createVersion({
    name: typeof body.name === "string" ? body.name : `Strategy ${new Date().toISOString()}`,
    description: typeof body.description === "string" ? body.description : null,
    config: body.config ?? currentConfig,
    parameters: body.parameters ?? {
      source: "settings-console",
      configVersion: currentConfig.version,
      capturedAt: new Date().toISOString()
    },
    performance: body.performance ?? null,
    createdBy: admin.subject
  });

  logger.warn("STRATEGY_VERSION_CREATED", "Admin snapshotted a strategy version", {
    actor: admin.subject,
    versionId: version.versionId,
    name: version.name,
    colo: topology.colo,
    placement: topology.placement
  });

  return json({ ok: true, version });
}

async function activateStrategyVersion(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  admin: AuthenticatedAdmin
): Promise<Response> {
  const body = (await readJsonBody<{ versionId?: string }>(request)) ?? {};
  const versionId = typeof body.versionId === "string" ? body.versionId.trim() : "";
  if (!versionId) {
    return json({ ok: false, error: "STRATEGY_VERSION_REQUIRED" }, 400);
  }

  const vault = new StrategyVault(env.TRADING_DB, env.CONFIG_STORE);
  const version = await vault.activateVersion(versionId, admin.subject);
  const refreshResponse = await routeToEngine(
    new Request(new URL("/admin/config", request.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        signal: "REFRESH_CONFIG",
        config: version.config
      } satisfies AdminConfigUpdate)
    }),
    env,
    topology
  );

  logger.warn("STRATEGY_VERSION_ACTIVATED", "Admin hot-swapped active strategy version", {
    actor: admin.subject,
    versionId: version.versionId,
    name: version.name,
    refreshStatus: refreshResponse.status,
    colo: topology.colo,
    placement: topology.placement
  });

  return json(
    {
      ok: refreshResponse.ok,
      version,
      engineRefreshStatus: refreshResponse.status
    },
    refreshResponse.ok ? 200 : 502
  );
}

async function runDiagnostics(env: Env, logger: Logger, topology: EdgeTopology): Promise<Response> {
  const observedAt = new Date().toISOString();
  const engineResponse = await routeToEngine(
    new Request("https://trading-engine.internal/diagnostics"),
    env,
    topology
  );
  const engineDiagnostics = await safeResponseJson(engineResponse);
  const d1StartedAt = performance.now();
  let d1Ok = false;
  let d1Error: string | null = null;

  try {
    await env.TRADING_DB.prepare("SELECT 1 AS ok").first();
    d1Ok = true;
  } catch (error) {
    d1Error = error instanceof Error ? error.message : "D1_QUERY_FAILED";
  }

  const d1LatencyMs = Math.round((performance.now() - d1StartedAt) * 1000) / 1000;
  const d1DiagnosticMaxLatencyMs = positiveNumber(env.D1_DIAGNOSTIC_MAX_LATENCY_MS, 250);
  const secretDiagnostic = await evaluateHyperliquidSecrets(env);
  const moltworker = await evaluateMoltworkerHeartbeat(env);
  const l1Sync = isJsonRecord(engineDiagnostics?.l1Sync) ? engineDiagnostics.l1Sync : null;
  const v8Memory = isJsonRecord(engineDiagnostics?.v8Memory) ? engineDiagnostics.v8Memory : null;
  const checks = [
    diagnosticCheck(
      "l1_sync",
      "L1 Sync Check",
      Boolean(l1Sync?.ok),
      l1Sync?.ok
        ? "Hyperliquid book sequence state is synchronized."
        : `Desync detected across ${Number(l1Sync?.desyncCount ?? 0)} market(s).`,
      l1Sync
    ),
    diagnosticCheck(
      "secret_valuation",
      "Secret Valuations",
      secretDiagnostic.ok,
      secretDiagnostic.detail,
      secretDiagnostic.metadata
    ),
    diagnosticCheck(
      "v8_memory_layout",
      "V8 Memory Layout",
      Boolean(v8Memory?.ok),
      v8Memory?.ok
        ? "Profiler Float32Array buffers are flat and below heap pressure limits."
        : "Profiler memory layout or heap pressure requires review.",
      v8Memory
    ),
    diagnosticCheck(
      "d1_log_latency",
      "D1 Log Latency",
      d1Ok && d1LatencyMs < d1DiagnosticMaxLatencyMs,
      d1Ok
        ? `D1 round trip ${d1LatencyMs}ms.`
        : `D1 diagnostic query failed: ${d1Error ?? "UNKNOWN_ERROR"}.`,
      { latencyMs: d1LatencyMs, thresholdMs: d1DiagnosticMaxLatencyMs, error: d1Error }
    ),
    diagnosticCheck(
      "moltworker_heartbeat",
      "Moltworker Heartbeat",
      moltworker.ok,
      moltworker.detail,
      moltworker.metadata,
      moltworker.status
    )
  ];
  const ok = checks.every((check) => check.status === "OPTIMAL");

  logger.info("ADMIN_DIAGNOSTICS_RUN", "Admin integrity diagnostics executed", {
    ok,
    colo: topology.colo,
    placement: topology.placement,
    checkSummary: Object.fromEntries(checks.map((check) => [check.id, check.status]))
  });

  return json({
    ok,
    observedAt,
    topology,
    checks,
    engine: engineDiagnostics
  });
}

async function readLiveReadiness(env: Env, topology: EdgeTopology): Promise<Response> {
  const report = await evaluateLiveReadiness(env, topology);
  return json({ ok: report.ok, readiness: report }, report.ok ? 200 : 409);
}

async function approveCascadeLiveReadiness(
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  admin: AuthenticatedAdmin
): Promise<Response> {
  const approval: TwoPersonApproval = {
    jti: admin.claims.jti,
    subject: admin.subject,
    scopes: admin.claims.scopes,
    observedAt: new Date().toISOString()
  };

  await env.CONFIG_STORE.put(CASCADE_TWO_PERSON_READ_APPROVAL_KEY, JSON.stringify(approval), {
    expirationTtl: Math.ceil(CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS / 1_000)
  });
  logger.warn("CASCADE_LIVE_READ_APPROVAL_RECORDED", "Read-side cascade live approval recorded", {
    subject: admin.subject,
    jti: maskTokenId(admin.claims.jti),
    expiresInMs: CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS,
    colo: topology.colo,
    placement: topology.placement
  });

  return json({
    ok: true,
    approval: {
      subject: approval.subject,
      scopes: approval.scopes,
      observedAt: approval.observedAt,
      expiresInMs: CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS
    }
  });
}

async function evaluateLiveReadiness(
  env: Env,
  topology: EdgeTopology
): Promise<LiveReadinessReport> {
  const generatedAt = new Date().toISOString();
  const [stateResponse, paperPnl, secretDiagnostic, d1Check] = await Promise.all([
    routeToEngine(new Request("https://trading-engine.internal/state"), env, topology),
    readPaperPnlSummary(env),
    evaluateHyperliquidSecrets(env),
    measureD1Readiness(env)
  ]);
  const statePayload = await safeResponseJson(stateResponse);
  const state = isJsonRecord(statePayload?.state) ? statePayload.state : null;
  const quoteState = isJsonRecord(state?.quoteState) ? state.quoteState : null;
  const cachedConfig = isJsonRecord(state?.cachedConfig) ? state.cachedConfig : null;
  const assetMatrix = isJsonRecord(state?.assetMatrix)
    ? Object.values(state.assetMatrix).filter(isJsonRecord)
    : [];
  const selectedAssets = assetMatrix.filter((asset) => asset.selectedByMoltworker !== false);
  const quoteEligibleAssets = selectedAssets.filter(
    (asset) =>
      asset.quoteEligible === true || (asset.active === true && asset.quoteStatus !== "SUSPENDED")
  );
  const activeAssetSymbols = quoteEligibleAssets
    .map((asset) => String(asset.coin ?? asset.instrumentCode ?? "").toUpperCase())
    .filter(Boolean);
  const minPaperTrades = Math.max(
    1,
    Math.floor(positiveNumber(env.LIVE_READINESS_MIN_PAPER_TRADES, 500))
  );
  const minPaperPnlUsd = Number(env.LIVE_READINESS_MIN_PAPER_PNL_USD ?? 0);
  const paperTotals = isJsonRecord(paperPnl.totals) ? paperPnl.totals : {};
  const paperTradeCount = Number(paperTotals.tradeCount ?? 0);
  const paperNet = Number(paperTotals.cashPnl ?? 0) - Number(paperTotals.totalFees ?? 0);
  const requireSingleAsset = env.LIVE_READINESS_REQUIRE_SINGLE_ASSET !== "false";
  const allowHype = env.LIVE_READINESS_ALLOW_HYPE === "true";
  const averageLatency = Number(state?.averageLatency ?? 0);
  const latencyThreshold = Number(cachedConfig?.LATENCY_THRESHOLD_MS ?? 150);
  const checks = [
    readinessCheck(
      "shadow_mode_disabled",
      "Shadow Mode Disabled",
      env.SHADOW_MODE !== "true",
      env.SHADOW_MODE === "true"
        ? "Worker is still in SHADOW_MODE; live exchange POSTs remain disabled."
        : "Worker is allowed to submit real exchange POSTs when config permits.",
      { shadowMode: env.SHADOW_MODE ?? "false" }
    ),
    readinessCheck(
      "exchange_test_mode_disabled",
      "Exchange Test Mode Disabled",
      env.EXCHANGE_ORDER_TEST_MODE === "false",
      env.EXCHANGE_ORDER_TEST_MODE === "false"
        ? "Executioner is configured for live Hyperliquid exchange writes."
        : "EXCHANGE_ORDER_TEST_MODE is still enabled.",
      { exchangeOrderTestMode: env.EXCHANGE_ORDER_TEST_MODE ?? "true" }
    ),
    readinessCheck(
      "api_agent_secret",
      "Hyperliquid API Agent",
      secretDiagnostic.ok,
      secretDiagnostic.detail,
      secretDiagnostic.metadata
    ),
    readinessCheck(
      "paper_sample",
      "Paper Evidence",
      paperTradeCount >= minPaperTrades && paperNet >= minPaperPnlUsd,
      `${paperTradeCount} risk-capped paper fills, net ${round(paperNet, 4)} USD after modeled fees.`,
      {
        minPaperTrades,
        minPaperPnlUsd,
        tradeCount: paperTradeCount,
        paperNetUsd: round(paperNet, 8)
      }
    ),
    readinessCheck(
      "quote_health",
      "Quote Health",
      quoteState?.status === "ACTIVE" && quoteEligibleAssets.length > 0,
      quoteState?.status === "ACTIVE"
        ? `${quoteEligibleAssets.length} quote-eligible asset(s): ${activeAssetSymbols.join(", ") || "none"}.`
        : `Quotes are ${String(quoteState?.status ?? "UNKNOWN")}: ${String(quoteState?.reason ?? "no reason")}.`,
      {
        quoteState: quoteState?.status ?? null,
        quoteReason: quoteState?.reason ?? null,
        quoteEligibleAssets: activeAssetSymbols
      }
    ),
    readinessCheck(
      "single_asset_ramp",
      "Single Asset Ramp",
      !requireSingleAsset ||
        (quoteEligibleAssets.length === 1 && (allowHype || !activeAssetSymbols.includes("HYPE"))),
      requireSingleAsset
        ? "Live ramp must start with exactly one non-HYPE asset unless explicitly overridden by env."
        : "Single-asset live ramp requirement is disabled by env.",
      {
        requireSingleAsset,
        allowHype,
        activeAssetSymbols
      }
    ),
    readinessCheck(
      "latency_budget",
      "Latency Budget",
      Number.isFinite(averageLatency) && averageLatency > 0 && averageLatency <= latencyThreshold,
      `Engine average latency is ${round(averageLatency, 3)}ms against ${round(latencyThreshold, 3)}ms budget.`,
      { averageLatencyMs: averageLatency, latencyThresholdMs: latencyThreshold }
    ),
    readinessCheck("d1_latency", "D1 Audit Path", d1Check.ok, d1Check.detail, d1Check.metadata)
  ];
  if (cachedConfig?.STRATEGY_MODE === "BOTH_LIVE" || cachedConfig?.CASCADE_TAKER_ENABLED === true) {
    const cascadeChecks = await evaluateCascadeLiveReadinessFromState(env, topology, {
      ...(cachedConfig as Partial<GlobalRiskConfig>),
      updatedAt: String(cachedConfig?.updatedAt ?? new Date().toISOString()),
      updatedBy: String(cachedConfig?.updatedBy ?? "engine"),
      version: String(cachedConfig?.version ?? "unknown")
    } as GlobalRiskConfig);
    checks.push(...cascadeChecks.checks);
  }

  return {
    ok: checks.every((check) => check.ok),
    generatedAt,
    checks
  };
}

async function evaluateCascadeLiveReadinessFromState(
  env: Env,
  topology: EdgeTopology,
  config: GlobalRiskConfig,
  admin?: AuthenticatedAdmin
): Promise<LiveReadinessReport> {
  const [paperArmedAt, lastCascadeConfigChangeAt, readApproval, paperEvidence, backtestEvidence] =
    await Promise.all([
      env.CONFIG_STORE.get(CASCADE_PAPER_ARMED_AT_KEY),
      env.CONFIG_STORE.get(CASCADE_LAST_CONFIG_CHANGE_AT_KEY),
      readCascadeTwoPersonApproval(env),
      readCascadePaperEvidence(env, config),
      readCascadeBacktestEvidence(env)
    ]);
  const minPaperTrades = Math.max(
    1,
    Math.floor(positiveNumber(env.CASCADE_LIVE_READINESS_MIN_PAPER_TRADES, 30))
  );
  const minPaperPnlR = positiveNumber(env.CASCADE_LIVE_READINESS_MIN_PAPER_PNL_R, 10);
  const minPaperDays = positiveNumber(env.CASCADE_LIVE_READINESS_MIN_DAYS_PAPER, 30);
  const report = evaluateCascadeLiveReadiness({
    nowMs: Date.now(),
    paperArmedAt,
    minPaperDays,
    paperTradeCount: paperEvidence.tradeCount,
    minPaperTrades,
    paperPnlR: paperEvidence.pnlR,
    minPaperPnlR,
    backtestPositiveExpectancy: backtestEvidence.positiveExpectancy,
    backtestTradeCount: backtestEvidence.tradeCount,
    backtestTotalPnl: backtestEvidence.totalPnl,
    backtestReportId: backtestEvidence.reportId,
    lastCascadeConfigChangeAt,
    configFreezeHours: CASCADE_CONFIG_FREEZE_HOURS,
    readApproval,
    writeToken: admin
      ? {
          jti: admin.claims.jti,
          subject: admin.subject,
          scopes: admin.claims.scopes,
          observedAt: new Date().toISOString()
        }
      : {
          jti: "readiness-preview",
          subject: "readiness-preview",
          scopes: [],
          observedAt: new Date().toISOString()
        },
    approvalWindowMs: CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS
  });

  return {
    ok: report.ok,
    generatedAt: new Date().toISOString(),
    checks: report.checks.map((check) => ({
      ...check,
      metadata: {
        ...check.metadata,
        topologyColo: topology.colo,
        paperPnlUsd: paperEvidence.pnlUsd,
        paperRiskUnitUsd: paperEvidence.riskUnitUsd,
        backtestGeneratedAt: backtestEvidence.generatedAt
      }
    }))
  };
}

async function readCascadeBacktestEvidence(env: Env): Promise<{
  reportId: string | null;
  generatedAt: string | null;
  tradeCount: number;
  totalPnl: number;
  positiveExpectancy: boolean;
}> {
  const stored = await env.CONFIG_STORE.get<JsonRecord>(CASCADE_LAST_BACKTEST_REPORT_KEY, "json");
  if (!stored) {
    return {
      reportId: null,
      generatedAt: null,
      tradeCount: 0,
      totalPnl: 0,
      positiveExpectancy: false
    };
  }

  const tradeCount = Number(stored.tradeCount ?? 0);
  const totalPnl = Number(stored.totalPnl ?? 0);
  const validationOk = stored.validationOk === true;
  const positiveExpectancy =
    stored.positiveExpectancy === true && validationOk && tradeCount > 0 && totalPnl > 0;

  return {
    reportId: typeof stored.reportId === "string" ? stored.reportId : null,
    generatedAt: typeof stored.generatedAt === "string" ? stored.generatedAt : null,
    tradeCount: Number.isFinite(tradeCount) ? tradeCount : 0,
    totalPnl: Number.isFinite(totalPnl) ? round(totalPnl, 8) : 0,
    positiveExpectancy
  };
}

async function readCascadeTwoPersonApproval(env: Env): Promise<TwoPersonApproval | null> {
  const stored = await env.CONFIG_STORE.get<TwoPersonApproval>(
    CASCADE_TWO_PERSON_READ_APPROVAL_KEY,
    "json"
  );

  if (
    !stored ||
    typeof stored.jti !== "string" ||
    typeof stored.subject !== "string" ||
    !Array.isArray(stored.scopes) ||
    typeof stored.observedAt !== "string"
  ) {
    return null;
  }

  return stored;
}

async function readCascadePaperEvidence(
  env: Env,
  config: GlobalRiskConfig
): Promise<{ tradeCount: number; pnlUsd: number; pnlR: number; riskUnitUsd: number }> {
  const sessionStartedAt = await env.CONFIG_STORE.get(PAPER_SESSION_STARTED_AT_KEY);
  const timeFilterSql =
    sessionStartedAt && Number.isFinite(Date.parse(sessionStartedAt)) ? "AND executed_at >= ?" : "";
  const row = await env.TRADING_DB.prepare(
    `SELECT
       COUNT(*) AS trade_count,
       SUM(resulting_pnl - fees) AS pnl_usd
     FROM trades
     WHERE status = 'GHOST_FILL'
       AND ${paperTradeWhereSql()}
       AND (
         primary_driver = 'PIT_BOSS'
         OR LOWER(COALESCE(raw_execution_json, '')) LIKE '%cascade%'
       )
       ${timeFilterSql}`
  )
    .bind(...(timeFilterSql ? [sessionStartedAt] : []))
    .first<{ trade_count: number | null; pnl_usd: number | null }>();
  const tradeCount = Number(row?.trade_count ?? 0);
  const pnlUsd = Number(row?.pnl_usd ?? 0);
  const bankroll = positiveNumber(env.PAPER_BANKROLL_USD, 5_000);
  const riskPerTradePct = Number.isFinite(Number(config.RISK_PER_TRADE_PCT))
    ? Number(config.RISK_PER_TRADE_PCT)
    : 0.005;
  const riskUnitUsd = Math.max(1, bankroll * Math.max(0.0001, riskPerTradePct));

  return {
    tradeCount,
    pnlUsd: round(pnlUsd, 8),
    pnlR: round(pnlUsd / riskUnitUsd, 8),
    riskUnitUsd: round(riskUnitUsd, 8)
  };
}

async function measureD1Readiness(env: Env): Promise<LiveReadinessCheck> {
  const startedAt = performance.now();
  try {
    await env.TRADING_DB.prepare("SELECT 1 AS ok").first();
    const latencyMs = round(performance.now() - startedAt, 3);
    return readinessCheck(
      "d1_latency",
      "D1 Audit Path",
      latencyMs <= positiveNumber(env.D1_DIAGNOSTIC_MAX_LATENCY_MS, 250),
      `D1 read round-trip completed in ${latencyMs}ms.`,
      { latencyMs }
    );
  } catch (error) {
    return readinessCheck(
      "d1_latency",
      "D1 Audit Path",
      false,
      error instanceof Error ? error.message : "D1_READINESS_FAILED",
      {}
    );
  }
}

function readinessCheck(
  id: string,
  label: string,
  ok: boolean,
  detail: string,
  metadata: JsonRecord = {}
): LiveReadinessCheck {
  return { id, label, ok, detail, metadata };
}

async function updateNotificationSettings(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  admin: AuthenticatedAdmin
): Promise<Response> {
  const body = (await readJsonBody<NotificationSettingsRequest>(request)) ?? {};
  const update = body.notifications ?? (body as NotificationSettingsUpdate);
  const notifications = await writeNotificationSettings(env, update, admin.subject);
  const notifier = new Notifier(env, () => undefined);
  const alerting = await notifier.statusAsync();

  logger.warn("NOTIFICATION_SETTINGS_UPDATED", "Admin notification settings persisted", {
    actor: admin.subject,
    sourceIp: sourceIp(request),
    settings: {
      enabled: notifications.enabled,
      minPriority: notifications.minPriority,
      debounceMs: notifications.debounceMs,
      textFrequencyMs: notifications.textFrequencyMs,
      heartbeatDigestMinutes: notifications.heartbeatDigestMinutes,
      tradeAlertMode: notifications.tradeAlertMode,
      telegramEnabled: notifications.telegramEnabled,
      discordEnabled: notifications.discordEnabled,
      genericWebhookEnabled: notifications.genericWebhookEnabled,
      quietHoursEnabled: notifications.quietHoursEnabled
    },
    colo: topology.colo,
    placement: topology.placement
  });

  return json({
    ok: true,
    notifications,
    alerting: {
      ...alerting,
      configured: alerting.channels.some((channel) => channel.configured)
    }
  });
}

async function handleTopologyCalibration(
  request: Request,
  env: Env,
  logger: Logger,
  configManager: ConfigManager,
  topology: EdgeTopology,
  admin: AuthenticatedAdmin
): Promise<Response> {
  const url = new URL(request.url);
  const body =
    request.method === "POST"
      ? ((await readJsonBody<ColoCalibrationOptions & { apply?: boolean }>(request)) ?? {})
      : {};
  const currentConfig = await configManager.fetchConfig();
  const options: ColoCalibrationOptions = {
    lookbackHours: numberOption(body.lookbackHours, url.searchParams.get("lookbackHours")),
    minSamples: numberOption(body.minSamples, url.searchParams.get("minSamples")),
    maxColos: numberOption(body.maxColos, url.searchParams.get("maxColos")),
    minFreshRate: numberOption(body.minFreshRate, url.searchParams.get("minFreshRate")),
    latencyThresholdMs: numberOption(
      body.latencyThresholdMs,
      url.searchParams.get("latencyThresholdMs")
    ),
    p90Multiplier: numberOption(body.p90Multiplier, url.searchParams.get("p90Multiplier")),
    p95Multiplier: numberOption(body.p95Multiplier, url.searchParams.get("p95Multiplier")),
    rowLimit: numberOption(body.rowLimit, url.searchParams.get("rowLimit"))
  };
  const report = await calibrateGoldenColos(env.TRADING_DB, currentConfig, options);
  const reportTelemetry = JSON.parse(JSON.stringify(report)) as JsonRecord;
  const apply = request.method === "POST" && (body as Record<string, unknown>).apply !== false;
  const previousGoldenColos = currentConfig.GOLDEN_COLOS || env.GOLDEN_COLOS || "";
  let nextConfig: GlobalRiskConfig | null = null;
  let engineRefreshStatus: number | null = null;

  if (apply && report.recommendedGoldenColos.length > 0) {
    nextConfig = ConfigManager.mergeUpdate(
      currentConfig,
      {
        config: {
          GOLDEN_COLOS: report.recommendedGoldenColosCsv
        }
      },
      `topology-calibrator:${admin.subject}`
    );
    await configManager.writeConfig(nextConfig);

    const refreshResponse = await routeToEngine(
      new Request(new URL("/admin/config", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signal: "REFRESH_CONFIG" } satisfies AdminConfigUpdate)
      }),
      env,
      topology
    );
    engineRefreshStatus = refreshResponse.status;

    logger.warn("GOLDEN_COLOS_CALIBRATED", "Golden colo policy updated from telemetry", {
      actor: admin.subject,
      previousGoldenColos,
      nextGoldenColos: nextConfig.GOLDEN_COLOS,
      report: reportTelemetry,
      colo: topology.colo,
      placement: topology.placement
    });
  } else {
    logger.info("GOLDEN_COLOS_CALIBRATION_REVIEWED", "Golden colo calibration report generated", {
      actor: admin.subject,
      applied: false,
      previousGoldenColos,
      recommendedGoldenColos: report.recommendedGoldenColosCsv,
      report: reportTelemetry,
      colo: topology.colo,
      placement: topology.placement
    });
  }

  return json({
    ok: true,
    applied: Boolean(nextConfig),
    previousGoldenColos,
    nextGoldenColos: nextConfig?.GOLDEN_COLOS ?? currentConfig.GOLDEN_COLOS,
    engineRefreshStatus,
    report
  });
}

async function readAlertingStatus(env: Env): Promise<Response> {
  const notifier = new Notifier(env, () => undefined);
  const status = await notifier.statusAsync();

  return json({
    ok: true,
    alerting: {
      ...status,
      configured: status.channels.some((channel) => channel.configured)
    }
  });
}

async function sendTestAlert(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  admin: AuthenticatedAdmin
): Promise<Response> {
  const body = (await readJsonBody<AlertTestRequest>(request)) ?? {};
  const priority = normalizeAlertPriority(body.priority);
  const notifier = new Notifier(env, () => undefined);
  const result = await notifier.deliverNow(
    {
      priority,
      title: safeAlertText(body.title, "Sovereign-Sigma alert route test", 96),
      message: safeAlertText(
        body.message,
        `Manual alert-channel verification requested by ${admin.subject}.`,
        512
      ),
      dedupeKey:
        typeof body.dedupeKey === "string" && body.dedupeKey.length > 0
          ? body.dedupeKey.slice(0, 120)
          : undefined,
      metadata: {
        ...(body.metadata ?? {}),
        requestedBy: admin.subject,
        endpoint: new URL(request.url).pathname,
        sourceIp: sourceIp(request),
        colo: topology.colo,
        placement: topology.placement,
        requestId: topology.requestId
      }
    },
    { respectDebounce: false }
  );

  logger.warn("ALERT_TEST_REQUESTED", "Admin requested alert-channel test", {
    subject: admin.subject,
    priority,
    attempted: result.attempted,
    delivered: result.delivered,
    channels: result.configuredChannels
      .filter((channel) => channel.configured)
      .map((channel) => channel.channel)
      .join(","),
    sourceIp: sourceIp(request),
    colo: topology.colo,
    placement: topology.placement
  });

  return json(
    {
      ok: result.ok,
      alerting: {
        ...(await notifier.statusAsync()),
        configured: result.configuredChannels.some((channel) => channel.configured)
      },
      delivery: result
    },
    result.ok ? 200 : result.attempted === 0 ? 424 : 502
  );
}

async function routeToEngine(
  request: Request,
  env: Env,
  topology: EdgeTopology,
  options: {
    timeoutMs?: number;
    timeoutResponse?: Response;
  } = {}
): Promise<Response> {
  const engine = getTradingEngineStub(env);
  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout =
    controller && options.timeoutMs
      ? setTimeout(() => controller.abort("ENGINE_TIMEOUT"), options.timeoutMs)
      : null;

  try {
    const response = await engine.fetch(withTopologyHeaders(request, topology, controller?.signal));

    return response.status === 101 ? response : withCors(response);
  } catch (error) {
    if (controller?.signal.aborted && options.timeoutResponse) {
      return withCors(options.timeoutResponse);
    }

    throw error;
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

function remapRequestPath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}

async function readAdminLogs(env: Env, url: URL): Promise<Response> {
  const page = clampInteger(url.searchParams.get("page"), 1, 1, 10_000);
  const limit = clampInteger(
    url.searchParams.get("limit"),
    DEFAULT_ADMIN_PAGE_SIZE,
    1,
    MAX_ADMIN_PAGE_SIZE
  );
  const offset = (page - 1) * limit;
  const filters = buildLogFilters(url);
  const whereSql = filters.where.length > 0 ? `WHERE ${filters.where.join(" AND ")}` : "";
  const dataQuery = `
    SELECT
      id,
      level,
      event_type,
      source,
      message,
      correlation_id,
      telemetry_json,
      created_at
    FROM logs
    ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?`;
  const countQuery = `SELECT COUNT(*) AS total FROM logs ${whereSql}`;
  const [rows, count] = await Promise.all([
    env.TRADING_DB.prepare(dataQuery)
      .bind(...filters.bindings, limit, offset)
      .all<LogRow>(),
    env.TRADING_DB.prepare(countQuery)
      .bind(...filters.bindings)
      .first<{ total: number }>()
  ]);
  const total = Number(count?.total ?? 0);

  return json({
    ok: true,
    data: (rows.results ?? []).map(formatLogRow),
    pagination: pagination(page, limit, total),
    filters: filters.publicFilters
  });
}

async function readTradeHistory(env: Env, url: URL): Promise<Response> {
  const page = clampInteger(url.searchParams.get("page"), 1, 1, 10_000);
  const limit = clampInteger(
    url.searchParams.get("limit"),
    DEFAULT_ADMIN_PAGE_SIZE,
    1,
    MAX_ADMIN_PAGE_SIZE
  );
  const offset = (page - 1) * limit;
  const filters = buildTradeFilters(url);
  const whereSql = filters.where.length > 0 ? `WHERE ${filters.where.join(" AND ")}` : "";
  const fromSql = `
    FROM trades t
    LEFT JOIN agent_decisions d ON d.signal_id = t.signal_id`;
  const dataQuery = `
    SELECT
      t.trade_id,
      t.order_id,
      t.signal_id,
      t.venue,
      t.asset,
      t.side,
      t.order_type,
      t.price,
      t.size,
      t.notional,
      t.ev_at_execution,
      t.slippage_bps,
      t.resulting_pnl,
      t.primary_driver,
      t.fees,
      t.status,
      t.exchange_trade_id,
      t.raw_execution_json,
      t.executed_at,
      t.created_at,
      d.agent_name,
      d.trace_id
    ${fromSql}
    ${whereSql}
    ORDER BY t.executed_at DESC, t.created_at DESC
    LIMIT ? OFFSET ?`;
  const countQuery = `SELECT COUNT(*) AS total ${fromSql} ${whereSql}`;
  const paperLimit = clampInteger(
    url.searchParams.get("paperLimit") ?? url.searchParams.get("paper_limit"),
    75,
    1,
    250
  );
  const [rows, count, paperPnl, paperTrades, paperLedger, statusBreakdown] = await Promise.all([
    env.TRADING_DB.prepare(dataQuery)
      .bind(...filters.bindings, limit, offset)
      .all<TradeHistoryRow>(),
    env.TRADING_DB.prepare(countQuery)
      .bind(...filters.bindings)
      .first<{ total: number }>(),
    readPaperPnlSummary(env),
    readPaperTrades(env, paperLimit),
    readPaperLedger(env),
    readTradeStatusBreakdown(env)
  ]);
  const total = Number(count?.total ?? 0);

  return json({
    ok: true,
    data: (rows.results ?? []).map(formatTradeRow),
    paperTrades: (paperTrades.results ?? []).map(formatTradeRow),
    paperPnl,
    paperLedger,
    statusBreakdown: (statusBreakdown.results ?? []).map((row) => ({
      status: row.status,
      count: Number(row.count ?? 0),
      latestExecutedAt: row.latest_executed_at
    })),
    pagination: pagination(page, limit, total),
    filters: {
      ...filters.publicFilters,
      paperLimit
    }
  });
}

async function readPaperPnlSummary(env: Env): Promise<JsonRecord> {
  const windowHours = 24;
  const sessionStartedAt = await env.CONFIG_STORE.get(PAPER_SESSION_STARTED_AT_KEY);
  const sessionCutoff =
    sessionStartedAt && Number.isFinite(Date.parse(sessionStartedAt)) ? sessionStartedAt : null;
  const timeFilterSql = sessionCutoff
    ? "AND executed_at >= ?"
    : "AND executed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')";
  const rows = await env.TRADING_DB.prepare(
    `SELECT
       asset,
       COUNT(*) AS trade_count,
       SUM(CASE WHEN side = 'BUY' THEN 1 ELSE 0 END) AS buy_count,
       SUM(CASE WHEN side = 'SELL' THEN 1 ELSE 0 END) AS sell_count,
       SUM(CASE WHEN side = 'BUY' THEN size ELSE 0 END) AS buy_size,
       SUM(CASE WHEN side = 'SELL' THEN size ELSE 0 END) AS sell_size,
       SUM(CASE WHEN side = 'BUY' THEN notional ELSE 0 END) AS buy_notional,
       SUM(CASE WHEN side = 'SELL' THEN notional ELSE 0 END) AS sell_notional,
       SUM(ev_at_execution) AS total_ev,
       SUM(fees) AS total_fees,
       SUM(resulting_pnl) AS realized_pnl,
       MIN(executed_at) AS first_seen,
       MAX(executed_at) AS last_seen
     FROM trades
     WHERE status = 'GHOST_FILL'
       AND ${paperTradeWhereSql()}
       ${timeFilterSql}
     GROUP BY asset
     ORDER BY asset`
  )
    .bind(...(sessionCutoff ? [sessionCutoff] : []))
    .all<PaperPnlAggregateRow>();
  const assets = (rows.results ?? []).map((row) => {
    const buySize = row.buy_size ?? 0;
    const sellSize = row.sell_size ?? 0;
    const buyNotional = row.buy_notional ?? 0;
    const sellNotional = row.sell_notional ?? 0;
    const netQuantity = buySize - sellSize;
    const cashPnl = sellNotional - buyNotional;
    const grossNotional = buyNotional + sellNotional;

    return {
      asset: row.asset,
      tradeCount: row.trade_count,
      buyCount: row.buy_count,
      sellCount: row.sell_count,
      buySize: round(buySize, 8),
      sellSize: round(sellSize, 8),
      buyNotional: round(buyNotional, 8),
      sellNotional: round(sellNotional, 8),
      netQuantity: round(netQuantity, 8),
      cashPnl: round(cashPnl, 8),
      grossNotional: round(grossNotional, 8),
      realizedPnl: round(row.realized_pnl ?? 0, 8),
      totalEv: round(row.total_ev ?? 0, 8),
      totalFees: round(row.total_fees ?? 0, 8),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen
    };
  });
  const totals = assets.reduce(
    (summary, asset) => ({
      tradeCount: summary.tradeCount + Number(asset.tradeCount ?? 0),
      buyCount: summary.buyCount + Number(asset.buyCount ?? 0),
      sellCount: summary.sellCount + Number(asset.sellCount ?? 0),
      grossNotional: summary.grossNotional + Number(asset.grossNotional ?? 0),
      cashPnl: summary.cashPnl + Number(asset.cashPnl ?? 0),
      realizedPnl: summary.realizedPnl + Number(asset.realizedPnl ?? 0),
      totalEv: summary.totalEv + Number(asset.totalEv ?? 0),
      totalFees: summary.totalFees + Number(asset.totalFees ?? 0)
    }),
    {
      tradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      grossNotional: 0,
      cashPnl: 0,
      realizedPnl: 0,
      totalEv: 0,
      totalFees: 0
    }
  );

  return {
    windowHours,
    mode: sessionCutoff ? "SHADOW_CURRENT_SESSION" : "SHADOW_RISK_CAPPED_MARK_TO_MARKET",
    sessionStartedAt: sessionCutoff,
    assets,
    totals: {
      tradeCount: totals.tradeCount,
      buyCount: totals.buyCount,
      sellCount: totals.sellCount,
      grossNotional: round(totals.grossNotional, 8),
      cashPnl: round(totals.cashPnl, 8),
      realizedPnl: round(totals.realizedPnl, 8),
      totalEv: round(totals.totalEv, 8),
      totalFees: round(totals.totalFees, 8)
    },
    generatedAt: new Date().toISOString()
  };
}

async function readPaperTrades(env: Env, limit: number): Promise<D1Result<TradeHistoryRow>> {
  return env.TRADING_DB.prepare(
    `SELECT
       t.trade_id,
       t.order_id,
       t.signal_id,
       t.venue,
       t.asset,
       t.side,
       t.order_type,
       t.price,
       t.size,
       t.notional,
       t.ev_at_execution,
       t.slippage_bps,
       t.resulting_pnl,
       t.primary_driver,
       t.fees,
       t.status,
       t.exchange_trade_id,
       t.raw_execution_json,
       t.executed_at,
       t.created_at,
       d.agent_name,
       d.trace_id
     FROM trades t
     LEFT JOIN agent_decisions d ON d.signal_id = t.signal_id
     WHERE t.status = 'GHOST_FILL'
       AND ${paperTradeWhereSql("t")}
     ORDER BY t.executed_at DESC, t.created_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all<TradeHistoryRow>();
}

async function readPaperLedger(env: Env): Promise<PaperLedger> {
  const sessionStartedAt = await env.CONFIG_STORE.get(PAPER_SESSION_STARTED_AT_KEY);
  const sessionCutoff =
    sessionStartedAt && Number.isFinite(Date.parse(sessionStartedAt)) ? sessionStartedAt : null;
  const timeFilterSql = sessionCutoff
    ? "AND t.executed_at >= ?"
    : "AND t.executed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')";
  const rows = await env.TRADING_DB.prepare(
    `SELECT
       t.trade_id,
       t.order_id,
       t.signal_id,
       t.venue,
       t.asset,
       t.side,
       t.order_type,
       t.price,
       t.size,
       t.notional,
       t.ev_at_execution,
       t.slippage_bps,
       t.resulting_pnl,
       t.primary_driver,
       t.fees,
       t.status,
       t.exchange_trade_id,
       t.raw_execution_json,
       t.executed_at,
       t.created_at,
       d.agent_name,
       d.trace_id
     FROM trades t
     LEFT JOIN agent_decisions d ON d.signal_id = t.signal_id
     WHERE t.status = 'GHOST_FILL'
       AND ${paperTradeWhereSql("t")}
       ${timeFilterSql}
     ORDER BY t.executed_at ASC, t.created_at ASC, t.trade_id ASC
     LIMIT 5000`
  )
    .bind(...(sessionCutoff ? [sessionCutoff] : []))
    .all<PaperLedgerFillRow>();

  return buildPaperLedger((rows.results ?? []).map(formatPaperLedgerFill));
}

async function readTradeStatusBreakdown(env: Env): Promise<D1Result<TradeStatusBreakdownRow>> {
  return env.TRADING_DB.prepare(
    `SELECT
       status,
       COUNT(*) AS count,
       MAX(executed_at) AS latest_executed_at
     FROM trades
     GROUP BY status
     ORDER BY count DESC`
  ).all<TradeStatusBreakdownRow>();
}

function paperTradeWhereSql(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";

  return `(
    ${prefix}trade_id LIKE 'shadow-queue:%'
    OR ${prefix}order_id LIKE 'vlo:%'
    OR ${prefix}raw_execution_json LIKE '%"paperSizer":"shadowQueueKellySize"%'
  )`;
}

async function readExecutionQuality(env: Env, url: URL): Promise<Response> {
  const dateRange = parseDateRange(url);
  const where: string[] = [];
  const bindings: string[] = [];
  if (dateRange.from) {
    where.push("observed_at >= ?");
    bindings.push(dateRange.from);
  }
  if (dateRange.to) {
    where.push("observed_at <= ?");
    bindings.push(dateRange.to);
  }
  if (where.length === 0) {
    where.push("observed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')");
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const [summary, byAsset, fillStats] = await Promise.all([
    env.TRADING_DB.prepare(
      `SELECT
         COUNT(*) AS sample_count,
         AVG(slippage_bps) AS average_slippage_bps,
         AVG(CASE WHEN slippage_bps > 0 THEN slippage_bps ELSE 0 END) AS adverse_selection_bps,
         AVG(implementation_shortfall) AS average_shortfall,
         AVG(latency_ms) AS average_latency_ms,
         SUM(fees) AS total_fees
       FROM execution_quality
       ${whereSql}`
    )
      .bind(...bindings)
      .first<ExecutionQualityAggregateRow>(),
    env.TRADING_DB.prepare(
      `SELECT
         instrument_code,
         COUNT(*) AS sample_count,
         AVG(slippage_bps) AS average_slippage_bps,
         AVG(CASE WHEN slippage_bps > 0 THEN slippage_bps ELSE 0 END) AS adverse_selection_bps,
         AVG(implementation_shortfall) AS average_shortfall,
         AVG(latency_ms) AS average_latency_ms,
         SUM(fees) AS total_fees
       FROM execution_quality
       ${whereSql}
       GROUP BY instrument_code
       ORDER BY sample_count DESC
       LIMIT 20`
    )
      .bind(...bindings)
      .all<ExecutionQualityAssetRow>(),
    readFillRateStats(env, dateRange)
  ]);

  return json({
    ok: true,
    window: {
      from: dateRange.from,
      to: dateRange.to,
      fallback: dateRange.from || dateRange.to ? null : "24h"
    },
    summary: formatExecutionQualitySummary(summary),
    byAsset: (byAsset.results ?? []).map(formatExecutionQualityAsset),
    fillRate: fillStats
  });
}

async function readFillRateStats(env: Env, dateRange: DateRangeFilter): Promise<JsonRecord> {
  const where: string[] = [];
  const bindings: string[] = [];
  if (dateRange.from) {
    where.push("executed_at >= ?");
    bindings.push(dateRange.from);
  }
  if (dateRange.to) {
    where.push("executed_at <= ?");
    bindings.push(dateRange.to);
  }
  if (where.length === 0) {
    where.push("executed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')");
  }
  const rows = await env.TRADING_DB.prepare(
    `SELECT status, COUNT(*) AS count
     FROM trades
     WHERE ${where.join(" AND ")}
     GROUP BY status`
  )
    .bind(...bindings)
    .all<{ status: string; count: number }>();
  const counts = Object.fromEntries(
    (rows.results ?? []).map((row) => [row.status, Number(row.count ?? 0)])
  );
  const filled =
    Number(counts.FILLED ?? 0) + Number(counts.PARTIAL ?? 0) + Number(counts.GHOST_FILL ?? 0);
  const attempted = Object.values(counts).reduce((sum, value) => sum + Number(value), 0);

  return {
    attempted,
    filled,
    rejected: Number(counts.REJECTED ?? 0),
    cancelled: Number(counts.CANCELLED ?? 0),
    acceptedOpen: Number(counts.ACCEPTED ?? 0),
    fillRate: attempted > 0 ? round(filled / attempted, 6) : null,
    counts
  };
}

function formatExecutionQualitySummary(row: ExecutionQualityAggregateRow | null): JsonRecord {
  return {
    sampleCount: Number(row?.sample_count ?? 0),
    averageSlippageBps: nullableRound(row?.average_slippage_bps, 6),
    adverseSelectionBps: nullableRound(row?.adverse_selection_bps, 6),
    averageShortfall: nullableRound(row?.average_shortfall, 8),
    averageLatencyMs: nullableRound(row?.average_latency_ms, 6),
    totalFees: nullableRound(row?.total_fees, 8)
  };
}

function formatExecutionQualityAsset(row: ExecutionQualityAssetRow): JsonRecord {
  return {
    instrumentCode: row.instrument_code,
    ...formatExecutionQualitySummary(row)
  };
}

async function readAgentTrace(env: Env, url: URL): Promise<Response> {
  const limit = clampInteger(url.searchParams.get("limit"), 50, 1, 200);
  const agent = normalizeEnum(url.searchParams.get("agent"), AGENT_NAMES);
  const queryLimit = agent ? limit : limit * AGENT_NAMES.length;
  const dateRange = parseDateRange(url);
  const where: string[] = [];
  const bindings: string[] = [];

  if (agent) {
    where.push("agent_name = ?");
    bindings.push(agent);
  }
  if (dateRange.from) {
    where.push("created_at >= ?");
    bindings.push(dateRange.from);
  }
  if (dateRange.to) {
    where.push("created_at <= ?");
    bindings.push(dateRange.to);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const decisions = await env.TRADING_DB.prepare(
    `SELECT
       decision_id,
       signal_id,
       trace_id,
       agent_name,
       target_agent,
       instrument_code,
       action,
       confidence,
       expected_value,
       rationale,
       feature_vector_json,
       risk_snapshot_json,
       raw_signal_json,
       latency_ms,
       created_at
     FROM agent_decisions
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(...bindings, queryLimit)
    .all<AgentTraceRow>();
  const telemetry = await env.TRADING_DB.prepare(
    `SELECT id, event_type, source, message, telemetry_json, created_at
     FROM logs
     WHERE event_type IN ('AGENT_SIGNAL', 'AGENT_STATE_SNAPSHOT', 'PROFILER_ALERT', 'BAYESIAN_POSTERIOR_UPDATED')
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(Math.min(limit, 50))
    .all<TraceTelemetryRow>();
  const rows = decisions.results ?? [];
  const byAgent: Record<string, JsonRecord[]> = {};
  const scopedRows: AgentTraceRow[] = [];

  for (const row of rows) {
    const agentRows = byAgent[row.agent_name] ?? [];
    if (agentRows.length >= limit) {
      continue;
    }

    const formatted = formatAgentTraceRow(row);
    const key = row.agent_name;
    byAgent[key] = [...agentRows, formatted];
    scopedRows.push(row);
  }

  return json({
    ok: true,
    data: scopedRows.map(formatAgentTraceRow),
    byAgent,
    terminalFeed: scopedRows.map(traceTerminalLine),
    liveTelemetry: (telemetry.results ?? []).map((row) => ({
      id: row.id,
      eventType: row.event_type,
      source: row.source,
      message: row.message,
      telemetry: parseJsonRecord(row.telemetry_json),
      timestamp: row.created_at
    })),
    filters: {
      agent,
      dateRange,
      limit
    }
  });
}

async function readAttribution(env: Env, url: URL): Promise<Response> {
  const limit = clampInteger(url.searchParams.get("limit"), 1_000, 1, 10_000);
  const dateRange = parseDateRange(url);
  const where: string[] = ["t.status IN ('FILLED', 'PARTIAL', 'GHOST_FILL')"];
  const bindings: string[] = [];

  if (dateRange.from) {
    where.push("t.executed_at >= ?");
    bindings.push(dateRange.from);
  }
  if (dateRange.to) {
    where.push("t.executed_at <= ?");
    bindings.push(dateRange.to);
  }

  const rows = await env.TRADING_DB.prepare(
    `SELECT
       t.trade_id,
       t.order_id,
       t.signal_id,
       t.venue,
       t.asset,
       t.side,
       t.order_type,
       t.price,
       t.size,
       t.notional,
       t.ev_at_execution,
       t.slippage_bps,
       t.resulting_pnl,
       t.primary_driver,
       t.fees,
       t.status,
       t.exchange_trade_id,
       t.raw_execution_json,
       t.executed_at,
       t.created_at,
       d.agent_name,
       d.trace_id,
       d.rationale,
       d.confidence
     FROM trades t
     LEFT JOIN agent_decisions d ON d.signal_id = t.signal_id
     WHERE ${where.join(" AND ")}
     ORDER BY t.executed_at DESC, t.created_at DESC
     LIMIT ?`
  )
    .bind(...bindings, limit)
    .all<AttributionRow>();
  const trades = (rows.results ?? []).map(formatAttributionTrade).reverse();
  const byDriver = calculateAttributionByDriver(trades);
  const byAsset = calculateAttributionByAsset(trades);
  const byRegime = calculateAttributionByRegime(trades);
  const byAgentAsset = calculateAttributionByAgentAsset(trades);
  const timeline = calculateAttributionTimeline(trades);

  return json({
    ok: true,
    trades,
    byDriver,
    byAsset,
    byRegime,
    byAgentAsset,
    timeline,
    filters: {
      dateRange,
      limit
    }
  });
}

async function handleVaultRequest(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  admin: AuthenticatedAdmin
): Promise<Response> {
  if (request.method === "GET") {
    return json({
      ok: true,
      vault: await vaultStatus(env)
    });
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const body = await readJsonBody<VaultUpdateRequest>(request);
  const keyName = normalizeVaultKey(body?.keyName);
  const secret = typeof body?.secret === "string" ? body.secret : "";

  if (!keyName || secret.length === 0) {
    return json({ ok: false, error: "INVALID_VAULT_ROTATION_REQUEST" }, 400);
  }

  const encryptionSecret = env.VAULT_ENCRYPTION_SECRET ?? env.JWT_SECRET ?? env.ADMIN_JWT_SECRET;
  if (!encryptionSecret) {
    return json({ ok: false, error: "VAULT_ENCRYPTION_SECRET_NOT_CONFIGURED" }, 503);
  }

  const now = new Date().toISOString();
  const encrypted = await encryptSecret(secret, encryptionSecret);
  const metadata = {
    keyName,
    updatedAt: now,
    updatedBy: admin.subject,
    rotationReason: sanitizeReason(body?.rotationReason),
    colo: topology.colo,
    placement: topology.placement,
    hasMetadata: Boolean(body?.metadata)
  };

  await Promise.all([
    env.RISK_VAULT.put(`vault:secret:${keyName}`, JSON.stringify(encrypted)),
    env.RISK_VAULT.put(`vault:metadata:${keyName}`, JSON.stringify(metadata))
  ]);

  logger.warn("VAULT_SECRET_ROTATION_REQUESTED", "Admin stored encrypted credential material", {
    actor: admin.subject,
    keyName,
    rotationReason: metadata.rotationReason,
    colo: topology.colo,
    placement: topology.placement
  });

  return json({
    ok: true,
    keyName,
    stored: true,
    updatedAt: now,
    note: "Encrypted credential material is stored in RISK_VAULT; production deployments should promote long-lived secrets with wrangler secret."
  });
}

async function testVaultConnection(
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  admin: AuthenticatedAdmin
): Promise<Response> {
  if (!env.EXECUTIONER) {
    return json(
      {
        ok: false,
        error: "EXECUTIONER_SERVICE_NOT_BOUND"
      },
      503
    );
  }

  const response = await env.EXECUTIONER.fetch(
    new Request("https://executioner.internal/account/balance", {
      method: "GET",
      headers: { "x-source": "sovereign-sigma-gateway" }
    })
  );
  const payload = await safeResponseJson(response);

  logger.info("VAULT_CONNECTION_TESTED", "Admin tested exchange credential path", {
    actor: admin.subject,
    status: response.status,
    ok: response.ok,
    colo: topology.colo,
    placement: topology.placement
  });

  return json(
    {
      ok: response.ok,
      status: response.status,
      result: payload
    },
    response.ok ? 200 : 502
  );
}

function formatAgentTraceRow(row: AgentTraceRow): JsonRecord {
  return {
    decisionId: row.decision_id,
    signalId: row.signal_id,
    traceId: row.trace_id,
    agentName: row.agent_name,
    targetAgent: row.target_agent,
    instrumentCode: row.instrument_code,
    action: row.action,
    confidence: row.confidence,
    expectedValue: row.expected_value,
    rationale: row.rationale,
    featureVector: parseJsonRecord(row.feature_vector_json),
    riskSnapshot: parseJsonRecord(row.risk_snapshot_json),
    rawSignal: parseJsonRecord(row.raw_signal_json),
    latencyMs: row.latency_ms,
    timestamp: row.created_at
  };
}

function traceTerminalLine(row: AgentTraceRow): string {
  const ev =
    row.expected_value === null || row.expected_value === undefined
      ? "EV=n/a"
      : `EV=${round(row.expected_value, 6)}`;

  return `${row.created_at} [${row.agent_name}] ${row.instrument_code} ${row.action} conf=${round(row.confidence, 4)} ${ev} trace=${row.trace_id} :: ${row.rationale}`;
}

interface AttributionTrade {
  tradeId: string;
  driver: string;
  asset: string;
  regime: string;
  side: string;
  pnl: number;
  evAtExecution: number;
  confidence: number | null;
  rationale: string | null;
  executedAt: string;
}

function formatAttributionTrade(row: AttributionRow): AttributionTrade {
  const rawExecution = parseJsonRecord(row.raw_execution_json);
  const primaryDriver =
    row.primary_driver ??
    readString(rawExecution, "primaryDriver") ??
    readString(rawExecution, "primary_driver") ??
    row.agent_name ??
    "UNATTRIBUTED";
  const pnl =
    finiteNumber(row.resulting_pnl) ??
    finiteNumber(readNumberField(rawExecution, "resultingPnl")) ??
    finiteNumber(readNumberField(rawExecution, "resulting_pnl")) ??
    finiteNumber(readNumberField(rawExecution, "pnl")) ??
    0;

  return {
    tradeId: row.trade_id,
    driver: primaryDriver,
    asset: row.asset,
    regime:
      readString(rawExecution, "regime") ??
      readString(rawExecution, "oracleRegime") ??
      readString(rawExecution, "marketRegime") ??
      "UNKNOWN",
    side: row.side,
    pnl,
    evAtExecution: row.ev_at_execution,
    confidence: row.confidence ?? null,
    rationale: row.rationale,
    executedAt: row.executed_at
  };
}

function calculateAttributionByDriver(trades: AttributionTrade[]): JsonRecord[] {
  return calculateAttributionBuckets(trades, (trade) => trade.driver, "driver");
}

function calculateAttributionByAsset(trades: AttributionTrade[]): JsonRecord[] {
  return calculateAttributionBuckets(trades, (trade) => trade.asset, "asset");
}

function calculateAttributionByRegime(trades: AttributionTrade[]): JsonRecord[] {
  return calculateAttributionBuckets(trades, (trade) => trade.regime, "regime");
}

function calculateAttributionByAgentAsset(trades: AttributionTrade[]): JsonRecord[] {
  return calculateAttributionBuckets(trades, (trade) => `${trade.driver}:${trade.asset}`, "bucket");
}

function calculateAttributionBuckets(
  trades: AttributionTrade[],
  keyFn: (trade: AttributionTrade) => string,
  keyName: string
): JsonRecord[] {
  const buckets = new Map<string, AttributionTrade[]>();

  for (const trade of trades) {
    const key = keyFn(trade);
    buckets.set(key, [...(buckets.get(key) ?? []), trade]);
  }

  return [...buckets.entries()].map(([key, bucket]) => {
    const pnls = bucket.map((trade) => trade.pnl);
    const grossProfit = pnls.filter((pnl) => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
    const grossLoss = Math.abs(pnls.filter((pnl) => pnl < 0).reduce((sum, pnl) => sum + pnl, 0));
    const mean = pnls.reduce((sum, pnl) => sum + pnl, 0) / Math.max(1, pnls.length);
    const variance =
      pnls.length > 1
        ? pnls.reduce((sum, pnl) => sum + (pnl - mean) ** 2, 0) / (pnls.length - 1)
        : 0;
    const sigma = Math.sqrt(variance);

    const row: JsonRecord = {
      [keyName]: key,
      tradeCount: bucket.length,
      cumulativePnl: round(
        pnls.reduce((sum, pnl) => sum + pnl, 0),
        8
      ),
      averagePnl: round(mean, 8),
      sharpe: sigma > 0 ? round((mean / sigma) * Math.sqrt(bucket.length), 6) : null,
      profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 6) : null,
      winRate:
        bucket.length > 0
          ? round(bucket.filter((trade) => trade.pnl > 0).length / bucket.length, 6)
          : null,
      grossProfit: round(grossProfit, 8),
      grossLoss: round(grossLoss, 8),
      averageConfidence: round(
        bucket.reduce((sum, trade) => sum + (trade.confidence ?? 0), 0) /
          Math.max(1, bucket.length),
        6
      )
    };
    if (keyName === "driver") {
      row.driver = key;
    }
    return row;
  });
}

function calculateAttributionTimeline(trades: AttributionTrade[]): JsonRecord[] {
  const cumulative = new Map<string, number>();

  return trades.map((trade) => {
    cumulative.set(trade.driver, (cumulative.get(trade.driver) ?? 0) + trade.pnl);

    return {
      timestamp: trade.executedAt,
      tradeId: trade.tradeId,
      driver: trade.driver,
      pnl: round(trade.pnl, 8),
      cumulativeByDriver: Object.fromEntries(
        [...cumulative.entries()].map(([driver, pnl]) => [driver, round(pnl, 8)])
      )
    };
  });
}

async function vaultStatus(env: Env): Promise<JsonRecord> {
  const keys = [
    "EXCHANGE_API_KEY",
    "EXCHANGE_API_SECRET",
    "HL_AGENT_ADDRESS",
    "HL_AGENT_SECRET",
    "JWT_SECRET",
    "ADMIN_PASSWORD",
    "DISCORD_WEBHOOK_URL",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "ALERT_WEBHOOK_URL"
  ];
  const entries: JsonRecord = {};

  for (const keyName of keys) {
    const metadata = await env.RISK_VAULT.get<JsonRecord>(`vault:metadata:${keyName}`, "json");
    entries[keyName] = {
      envConfigured: Boolean((env as unknown as Record<string, string | undefined>)[keyName]),
      vaultConfigured: Boolean(metadata),
      masked: Boolean((env as unknown as Record<string, string | undefined>)[keyName] ?? metadata)
        ? "********"
        : null,
      updatedAt: typeof metadata?.updatedAt === "string" ? metadata.updatedAt : null,
      updatedBy: typeof metadata?.updatedBy === "string" ? metadata.updatedBy : null
    };
  }

  return {
    entries,
    rotationPolicy:
      "Use encrypted RISK_VAULT requests for short-lived rotation workflow; promote durable credentials with wrangler secret in production."
  };
}

function backendSettings(env: Env): JsonRecord {
  const dwellirTier = env.DWELLIR_SUBSCRIPTION_TIER ?? null;
  const requestedOrderbookTransport = env.DWELLIR_ORDERBOOK_TRANSPORT ?? "websocket";
  const normalizedDwellirTier = String(dwellirTier ?? "ENTERPRISE").toUpperCase();
  const grpcOrderbookEligible = normalizedDwellirTier !== "PUBLIC";
  const effectiveOrderbookTransport =
    requestedOrderbookTransport.toLowerCase() === "grpc" && grpcOrderbookEligible
      ? "grpc"
      : "websocket";
  const l4Enabled = String(env.DWELLIR_ENABLE_L4_BOOK ?? "true").toLowerCase() !== "false";
  const readMode =
    effectiveOrderbookTransport === "grpc"
      ? l4Enabled
        ? "DWELLIR_GRPC_FILLS_L4_BOOK_GRPC"
        : "DWELLIR_GRPC_FILLS_L2_BOOK_GRPC"
      : l4Enabled
        ? "DWELLIR_GRPC_FILLS_L4_BOOK_WS"
        : "DWELLIR_GRPC_FILLS_L2_BOOK_WS";

  return {
    api: {
      gatewayRoute: "https://api.yevow.co",
      adminStreamPath: "/admin/stream",
      healthPath: "/health",
      executionerBound: Boolean(env.EXECUTIONER),
      aiBound: Boolean(env.AI),
      structuredConsoleLogs: env.STRUCTURED_CONSOLE_LOGS ?? "false",
      logSinkProvider: env.LOG_SINK_PROVIDER ?? "disabled",
      logSinkConfigured: Boolean(
        env.LOG_SINK_PROVIDER &&
        env.LOG_SINK_PROVIDER !== "disabled" &&
        (env.LOG_SINK_TOKEN || env.LOG_SINK_URL)
      ),
      logSinkDataset: env.LOG_SINK_DATASET ?? env.AXIOM_DATASET ?? env.HONEYCOMB_DATASET ?? null
    },
    ingest: {
      nativeSource: "DWELLIR_HYPERLIQUID_GRPC",
      transport: env.INGEST_TRANSPORT ?? "grpc",
      readMode,
      readArchitecture:
        effectiveOrderbookTransport === "grpc"
          ? "Dwellir gRPC fills plus Dwellir gRPC order-book snapshots"
          : "Dwellir gRPC fills plus Dwellir L4 order-book WebSocket",
      providerRecommendedBookTransport:
        effectiveOrderbookTransport === "grpc"
          ? "dwellir-grpc-orderbook-snapshots"
          : "dwellir-orderbook-websocket",
      pureGrpcOrderbookActive: effectiveOrderbookTransport === "grpc",
      pureGrpcOrderbookRequirement:
        effectiveOrderbookTransport === "grpc"
          ? "Active: non-public Dwellir gRPC tier with DWELLIR_ORDERBOOK_TRANSPORT=grpc."
          : "Inactive: set DWELLIR_ORDERBOOK_TRANSPORT=grpc on a non-public Dwellir gRPC tier; public or unauthenticated routes stay on the Orderbook WebSocket.",
      dwellirGrpcUrl: redactedEndpoint(
        env.DWELLIR_GRPC_URL ?? env.DWELLIR_GRPC_ENDPOINT ?? env.RPC_GRPC_ENDPOINT
      ),
      dwellirGrpcPathConfigured: hasEndpointPath(
        env.DWELLIR_GRPC_URL ?? env.DWELLIR_GRPC_ENDPOINT ?? env.RPC_GRPC_ENDPOINT
      ),
      dwellirGrpcService: env.RPC_GRPC_SERVICE ?? null,
      dwellirGrpcStreams: env.DWELLIR_GRPC_STREAMS ?? env.RPC_GRPC_STREAM_TYPES ?? null,
      dwellirSubscriptionTier: dwellirTier,
      dwellirOrderbookDepth: stringNumber(env.DWELLIR_ORDERBOOK_DEPTH),
      dwellirOrderbookTransportRequested: requestedOrderbookTransport,
      dwellirOrderbookTransportEffective: effectiveOrderbookTransport,
      dwellirL4BookEnabled: env.DWELLIR_ENABLE_L4_BOOK ?? "true",
      hyperliquidWsUrl: env.HL_WS_URL ?? null,
      heartbeatIntervalMs: stringNumber(env.HL_HEARTBEAT_INTERVAL_MS),
      staleAfterMs: stringNumber(env.HL_STALE_AFTER_MS),
      watchdogTimeoutMs: stringNumber(env.HL_WATCHDOG_TIMEOUT_MS),
      maxBackoffMs: stringNumber(env.HL_MAX_BACKOFF_MS),
      sequenceGapMs: stringNumber(env.HL_SEQUENCE_GAP_MS),
      marketStreams: parseJsonValue(env.MARKET_STREAMS)
    },
    execution: {
      adapter: env.EXCHANGE_ADAPTER ?? null,
      baseUrl: env.EXCHANGE_BASE_URL ?? null,
      orderTestMode: env.EXCHANGE_ORDER_TEST_MODE ?? "true",
      shadowMode: env.SHADOW_MODE ?? "false",
      recvWindowMs: stringNumber(env.EXCHANGE_RECV_WINDOW_MS),
      orderAckTimeoutMs: stringNumber(env.ORDER_ACK_TIMEOUT_MS),
      slippageGuardTicks: stringNumber(env.SLIPPAGE_GUARD_TICKS),
      paperFillParticipationRate: stringNumber(env.PAPER_FILL_PARTICIPATION_RATE),
      paperFillAdverseBps: stringNumber(env.PAPER_FILL_ADVERSE_BPS),
      paperMakerFeeBps: stringNumber(env.PAPER_MAKER_FEE_BPS),
      quoteRefreshMinIntervalMs: stringNumber(env.QUOTE_REFRESH_MIN_INTERVAL_MS),
      quoteRefreshMinPriceTicks: stringNumber(env.QUOTE_REFRESH_MIN_PRICE_TICKS),
      liveReadinessMinPaperTrades: stringNumber(env.LIVE_READINESS_MIN_PAPER_TRADES),
      liveReadinessMinPaperPnlUsd: stringNumber(env.LIVE_READINESS_MIN_PAPER_PNL_USD),
      liveReadinessRequireSingleAsset: env.LIVE_READINESS_REQUIRE_SINGLE_ASSET ?? "true",
      liveReadinessAllowHype: env.LIVE_READINESS_ALLOW_HYPE ?? "false",
      cascadeLiveReadinessMinPaperTrades: stringNumber(env.CASCADE_LIVE_READINESS_MIN_PAPER_TRADES),
      cascadeLiveReadinessMinPaperPnlR: stringNumber(env.CASCADE_LIVE_READINESS_MIN_PAPER_PNL_R),
      cascadeLiveReadinessMinDaysPaper: stringNumber(env.CASCADE_LIVE_READINESS_MIN_DAYS_PAPER),
      cascadeTwoPersonApprovalWindowMs: CASCADE_TWO_PERSON_APPROVAL_WINDOW_MS,
      signatureAlgorithm: env.SIGNATURE_ALGORITHM ?? null
    },
    riskAndStrategy: {
      exchangeWeights: parseJsonValue(env.EXCHANGE_WEIGHTS),
      clockSyncAlpha: stringNumber(env.CLOCK_SYNC_ALPHA),
      clockSyncMaxOffsetMs: stringNumber(env.CLOCK_SYNC_MAX_OFFSET_MS),
      goldenColos: env.GOLDEN_COLOS ?? null,
      highLatencyColoRiskMultiplier: stringNumber(env.HIGH_LATENCY_COLO_RISK_MULTIPLIER),
      profilerBucketVolume: stringNumber(env.PROFILER_BUCKET_VOLUME),
      profilerRollingWindow: stringNumber(env.PROFILER_ROLLING_WINDOW),
      profilerAlertThreshold: stringNumber(env.PROFILER_ALERT_THRESHOLD),
      jitterThresholdMs: stringNumber(env.JITTER_THRESHOLD_MS),
      jitterSampleWindow: stringNumber(env.JITTER_SAMPLE_WINDOW),
      jitterComputeIntervalTicks: stringNumber(env.JITTER_COMPUTE_INTERVAL_TICKS)
    },
    bookAndAnomalies: {
      orderBookTickSizeDefault: stringNumber(env.ORDER_BOOK_TICK_SIZE_DEFAULT),
      orderBookTickSizes: parseJsonValue(env.ORDER_BOOK_TICK_SIZES),
      domPriceBinSizeDefault: stringNumber(env.DOM_PRICE_BIN_SIZE_DEFAULT),
      domPriceBinSizes: parseJsonValue(env.DOM_PRICE_BIN_SIZES),
      domScanRangePct: stringNumber(env.DOM_SCAN_RANGE_PCT),
      domWallHistoryLimit: stringNumber(env.DOM_WALL_HISTORY_LIMIT),
      domSpoofProximityBps: stringNumber(env.DOM_SPOOF_PROXIMITY_BPS),
      anomalyPriceZThreshold: stringNumber(env.ANOMALY_PRICE_Z_THRESHOLD),
      anomalyVolumeZThreshold: stringNumber(env.ANOMALY_VOLUME_Z_THRESHOLD),
      anomalyCancelExecRatioThreshold: stringNumber(env.ANOMALY_CANCEL_EXEC_RATIO_THRESHOLD),
      anomalyPriceWindowMs: stringNumber(env.ANOMALY_PRICE_WINDOW_MS),
      anomalyVolumeWindowMs: stringNumber(env.ANOMALY_VOLUME_WINDOW_MS),
      anomalyTopOfBookWindowMs: stringNumber(env.ANOMALY_TOP_OF_BOOK_WINDOW_MS)
    },
    operations: {
      notifierDebounceMs: stringNumber(env.NOTIFIER_DEBOUNCE_MS),
      janitorIntervalMs: stringNumber(env.JANITOR_INTERVAL_MS),
      janitorLogRetentionDays: stringNumber(env.JANITOR_LOG_RETENTION_DAYS),
      janitorTelemetryMaxRows: stringNumber(env.JANITOR_TELEMETRY_MAX_ROWS),
      marketTickJournalInterval: stringNumber(env.MARKET_TICK_JOURNAL_INTERVAL),
      marketTickMaxRows: stringNumber(env.MARKET_TICK_MAX_ROWS),
      newsFeeds: parseJsonValue(env.NEWS_FEEDS)
    }
  };
}

function gatewayHealthFallback(topology: EdgeTopology): Response {
  return json(
    {
      ok: false,
      status: "ENGINE_HEALTH_TIMEOUT",
      service: "sovereign-sigma-core",
      message: "Trading engine health did not respond within the gateway timeout",
      timeoutMs: ENGINE_HEALTH_TIMEOUT_MS,
      topology,
      observedAt: new Date().toISOString()
    },
    503
  );
}

function diagnosticCheck(
  id: string,
  label: string,
  ok: boolean,
  detail: string,
  metadata: unknown,
  overrideStatus?: "OPTIMAL" | "WARN" | "ANOMALY"
): JsonRecord {
  return {
    id,
    label,
    status: overrideStatus ?? (ok ? "OPTIMAL" : "ANOMALY"),
    detail,
    metadata: toJsonRecord(metadata)
  };
}

function hasEndpointPath(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.pathname.replace(/\//g, "").length > 0;
  } catch {
    return false;
  }
}

function redactedEndpoint(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return hasEndpointPath(value) ? `${url.origin}/<dwellir-route>` : url.origin;
  } catch {
    return "<invalid-endpoint>";
  }
}

function toJsonRecord(value: unknown): JsonRecord {
  if (isJsonRecord(value)) {
    return value;
  }

  return JSON.parse(JSON.stringify(value ?? {})) as JsonRecord;
}

export const __test__ = {
  requestsCascadeLivePromotion
};
