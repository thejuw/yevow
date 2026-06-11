import { Hono, type Context } from "hono";
import { AuthManager } from "./AuthManager";
import { ActiveTokenStore } from "./auth/JwtRevocation";
import { calibrateGoldenColos, type ColoCalibrationOptions } from "./ColoCalibrator";
import { ConfigManager } from "./ConfigManager";
import { Governor } from "./Governor";
import { Logger } from "./Logger";
import { writeNotificationSettings } from "./NotificationSettings";
import { StrategyVault } from "./StrategyVault";
import { TradingEngine } from "./TradingEngine";
import { Notifier } from "./utils/Notifier";
import { evaluateRateLimit, ipRateLimitKey } from "./gateway/middleware/RateLimitMiddleware";
import { adminUiResponse } from "./gateway/AdminUi";
import {
  ACTIVE_TOKEN_PREFIX,
  CASCADE_LAST_CONFIG_CHANGE_AT_KEY,
  CASCADE_TWO_PERSON_READ_APPROVAL_KEY,
  ENGINE_HEALTH_TIMEOUT_MS
} from "./gateway/GatewayConstants";
import type {
  AlertTestRequest,
  AuthenticatedAdmin,
  LoginRequest,
  NotificationSettingsRequest,
  VaultUpdateRequest
} from "./gateway/AdminModels";
import { gatewayRuntime, type GatewayHono } from "./gateway/GatewayRuntime";
import { gatewayCatalogResponse } from "./gateway/RouteCatalog";
import { readAgentTrace, readAttribution } from "./gateway/AdminAnalyticsGateway";
import { buildCostDashboard, readCostDashboard, updateCostBudgets } from "./gateway/CostDashboard";
import { runDiagnostics } from "./gateway/DiagnosticsGateway";
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
import {
  gatewayHealthFallback,
  remapRequestPath,
  routeToEngine
} from "./gateway/GatewayEngineRouter";
import { readAdminSettings, vaultStatus } from "./gateway/AdminSettingsGateway";
import { readMoltworkerHealth, updateMoltworkerHeartbeat } from "./gateway/MoltworkerGateway";
import {
  readAdminLogs,
  readExecutionQuality,
  readTradeHistory
} from "./gateway/AdminHistoryQueries";
import {
  approveCascadeLiveReadiness,
  evaluateCascadeLiveReadinessFromState,
  evaluateLiveReadiness,
  readLiveReadiness
} from "./gateway/LiveReadinessGateway";
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
import { corsPreflight, json, readJsonBody } from "./gateway/ResponseHelpers";
import { logSecurityEvent, sourceIp } from "./gateway/SecurityAudit";
import { placementColo, topologyTelemetry } from "./gateway/Topology";
import { normalizeEngineMode, numberOption } from "./gateway/ValueCodecs";
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

    return runDiagnostics(env, logger, topology, routeToEngine);
  }

  if (url.pathname === "/admin/live-readiness") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return readLiveReadiness(env, topology, routeToEngine);
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
    const readiness = await evaluateLiveReadiness(env, topology, routeToEngine);
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

export const __test__ = {
  requestsCascadeLivePromotion
};
