import { Hono, type Context } from "hono";
import { AuthManager } from "./AuthManager";
import { ActiveTokenStore } from "./auth/JwtRevocation";
import { ConfigManager } from "./ConfigManager";
import { Logger } from "./Logger";
import { TradingEngine } from "./TradingEngine";
import { evaluateRateLimit, ipRateLimitKey } from "./gateway/middleware/RateLimitMiddleware";
import { adminUiResponse } from "./gateway/AdminUi";
import { ACTIVE_TOKEN_PREFIX, ENGINE_HEALTH_TIMEOUT_MS } from "./gateway/GatewayConstants";
import type { AuthenticatedAdmin, LoginRequest } from "./gateway/AdminModels";
import { gatewayRuntime, type GatewayHono } from "./gateway/GatewayRuntime";
import { gatewayCatalogResponse } from "./gateway/RouteCatalog";
import { readAgentTrace, readAttribution } from "./gateway/AdminAnalyticsGateway";
import { handleAdminConfig } from "./gateway/AdminConfigGateway";
import { readCostDashboard, updateCostBudgets } from "./gateway/CostDashboard";
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
import { readAdminSettings } from "./gateway/AdminSettingsGateway";
import {
  readAlertingStatus,
  sendTestAlert,
  updateNotificationSettings
} from "./gateway/AdminNotificationsGateway";
import { handleTopologyCalibration } from "./gateway/AdminTopologyGateway";
import { readMoltworkerHealth, updateMoltworkerHeartbeat } from "./gateway/MoltworkerGateway";
import {
  readAdminLogs,
  readExecutionQuality,
  readTradeHistory
} from "./gateway/AdminHistoryQueries";
import { approveCascadeLiveReadiness, readLiveReadiness } from "./gateway/LiveReadinessGateway";
import { requestsCascadeLivePromotion } from "./gateway/AdminConfigGuards";
import { handleVaultRequest, testVaultConnection } from "./gateway/VaultGateway";
import { corsPreflight, json, readJsonBody } from "./gateway/ResponseHelpers";
import { logSecurityEvent, sourceIp } from "./gateway/SecurityAudit";
import {
  activateStrategyVersion,
  createStrategyVersion,
  readStrategyVault
} from "./gateway/StrategyVaultGateway";
import { placementColo, topologyTelemetry } from "./gateway/Topology";
import {
  backfillCongressOptions,
  handleCongressScheduled,
  ingestCongressPayload,
  readCongressFilings,
  readCongressMacroHeatmap,
  readCongressRuns,
  readCongressStatus,
  readCongressTickerHierarchy,
  readCongressTransactions,
  refreshCongressPnl,
  triggerCongressRun
} from "./gateway/CongressTrackerGateway";
import {
  enrichCongressAlphaUniverse,
  handleCongressAlphaScheduled,
  readCongressAlphaBot,
  runCongressAlphaBacktest,
  runCongressAlphaBot,
  updateCongressAlphaSettings
} from "./gateway/CongressAlphaBotGateway";
import {
  handlePrivateEquityScheduled,
  readPrivateEquityDeals
} from "./gateway/PrivateEquityDealsGateway";
import type { EdgeTopology, Env } from "./types";

export { TradingEngine };

const gatewayRouter = new Hono<GatewayHono>();

gatewayRouter.options("*", () => corsPreflight());

gatewayRouter.get("/api/equity-deals", async (c) => readPrivateEquityDeals(c.env));

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
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const topology = scheduledTopology(controller);
    const logger = new Logger(
      env.TRADING_DB,
      (promise) => ctx.waitUntil(promise),
      "gateway-scheduler"
    );

    await handleCongressScheduled(controller, env, ctx, logger, topology);
    await handleCongressAlphaScheduled(controller, env, ctx, logger, topology);
    await handlePrivateEquityScheduled(controller, env, ctx, logger, topology);
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
        "GET /admin/logs",
        "GET /admin/congress/status",
        "GET /admin/congress/runs",
        "POST /admin/congress/run",
        "POST /admin/congress/ingest",
        "GET /admin/congress/filings",
        "GET /admin/congress/tickers",
        "GET /admin/congress/macro",
        "GET /admin/congress/transactions",
        "POST /admin/congress/pnl/refresh",
        "POST /admin/congress/options/backfill",
        "GET /admin/congress/alpha",
        "POST /admin/congress/alpha/run"
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

  if (url.pathname === "/admin/congress/status") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return readCongressStatus(env);
  }

  if (url.pathname === "/admin/congress/runs") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return readCongressRuns(env, url);
  }

  if (url.pathname === "/admin/congress/run") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return triggerCongressRun(request, env, logger, topology, auth);
  }

  if (url.pathname === "/admin/congress/ingest") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return ingestCongressPayload(request, env, logger, topology, auth);
  }

  if (url.pathname === "/admin/congress/filings") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return readCongressFilings(env, url);
  }

  if (url.pathname === "/admin/congress/transactions") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return readCongressTransactions(env, url);
  }

  if (url.pathname === "/admin/congress/tickers") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return readCongressTickerHierarchy(env, url);
  }

  if (url.pathname === "/admin/congress/macro") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return readCongressMacroHeatmap(env, url);
  }

  if (url.pathname === "/admin/congress/pnl/refresh") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return refreshCongressPnl(request, env, logger, topology, auth);
  }

  if (url.pathname === "/admin/congress/options/backfill") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return backfillCongressOptions(request, env, logger, topology, auth);
  }

  if (url.pathname === "/admin/congress/alpha") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return readCongressAlphaBot(env);
  }

  if (url.pathname === "/admin/congress/alpha/run") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return runCongressAlphaBot(request, env, logger, topology, auth);
  }

  if (url.pathname === "/admin/congress/alpha/settings") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return updateCongressAlphaSettings(request, env, auth);
  }

  if (url.pathname === "/admin/congress/alpha/enrich") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return enrichCongressAlphaUniverse(env, auth);
  }

  if (url.pathname === "/admin/congress/alpha/backtest") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }
    return runCongressAlphaBacktest(env, auth);
  }

  return json({ ok: false, error: "Not found" }, 404);
}

export const __test__ = {
  requestsCascadeLivePromotion
};

function scheduledTopology(controller: ScheduledController): EdgeTopology {
  const observedAt = new Date(controller.scheduledTime).toISOString();

  return {
    colo: null,
    placement: "scheduled",
    country: null,
    city: null,
    region: null,
    timezone: null,
    latitude: null,
    longitude: null,
    requestId: `scheduled:${controller.cron}:${controller.scheduledTime}`,
    observedAt
  };
}
