import { AuthManager } from "./AuthManager";
import { calibrateGoldenColos, type ColoCalibrationOptions } from "./ColoCalibrator";
import { ConfigManager } from "./ConfigManager";
import { Governor } from "./Governor";
import { Logger } from "./Logger";
import {
  readNotificationSettings,
  writeNotificationSettings
} from "./NotificationSettings";
import { TradingEngine } from "./TradingEngine";
import { Notifier, type AlertPriority } from "./utils/Notifier";
import { SignatureEngine } from "./utils/SignatureEngine";
import { getTradingEngineStub, tradingEngineObjectName } from "./utils/TradingEngineStub";
import type { AdminScope, AuthClaims } from "./AuthManager";
import type {
  AdminConfigUpdate,
  EdgeTopology,
  Env,
  GlobalRiskConfig,
  JsonRecord,
  JsonValue,
  NotificationSettingsUpdate
} from "./types";

export { TradingEngine };

const TOPOLOGY_HEADER_PREFIX = "x-sovereign-topology-";
const DEFAULT_ADMIN_PAGE_SIZE = 100;
const MAX_ADMIN_PAGE_SIZE = 500;
const ENGINE_HEALTH_TIMEOUT_MS = 1_500;
const MOLTWORKER_HEARTBEAT_KEY = "moltworker:heartbeat";
const DEFAULT_MOLTWORKER_HEARTBEAT_MAX_AGE_MS = 300_000;
const PAPER_SESSION_STARTED_AT_KEY = "paper:session_started_at";
const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"] as const;
const AGENT_NAMES = [
  "ORACLE",
  "SENTIMENT",
  "PROFILER",
  "CROUPIER",
  "PIT_BOSS",
  "JANITOR",
  "EXECUTIONER",
  "MOLTWORKER",
  "RISK",
  "SYSTEM"
] as const;
const TRADE_STATUSES = [
  "ACCEPTED",
  "FILLED",
  "PARTIAL",
  "REJECTED",
  "CANCELLED",
  "GHOST_FILL"
] as const;

interface CloudflareRequestMetadata {
  colo?: unknown;
  country?: unknown;
  city?: unknown;
  region?: unknown;
  timezone?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

interface LoginRequest {
  password?: string;
  subject?: string;
  scopes?: AdminScope[] | string;
}

interface AuthenticatedAdmin {
  claims: AuthClaims;
  subject: string;
}

interface LogRow {
  id: number;
  level: string;
  event_type: string;
  source: string;
  message: string;
  correlation_id: string | null;
  telemetry_json: string | null;
  created_at: string;
}

interface TradeHistoryRow {
  trade_id: string;
  order_id: string;
  signal_id: string | null;
  venue: string;
  asset: string;
  side: string;
  order_type: string;
  price: number;
  size: number;
  notional: number;
  ev_at_execution: number;
  slippage_bps: number;
  resulting_pnl?: number | null;
  primary_driver?: string | null;
  fees: number;
  status: string;
  exchange_trade_id: string | null;
  raw_execution_json: string | null;
  executed_at: string;
  created_at: string;
  agent_name: string | null;
  trace_id: string | null;
}

interface PaperPnlAggregateRow {
  asset: string;
  trade_count: number;
  buy_count: number;
  sell_count: number;
  buy_size: number | null;
  sell_size: number | null;
  buy_notional: number | null;
  sell_notional: number | null;
  total_ev: number | null;
  total_fees: number | null;
  realized_pnl: number | null;
  first_seen: string | null;
  last_seen: string | null;
}

interface AgentTraceRow {
  decision_id: string;
  signal_id: string;
  trace_id: string;
  agent_name: string;
  target_agent: string | null;
  instrument_code: string;
  action: string;
  confidence: number;
  expected_value: number | null;
  rationale: string;
  feature_vector_json: string | null;
  risk_snapshot_json: string | null;
  raw_signal_json: string | null;
  latency_ms: number | null;
  created_at: string;
}

interface TraceTelemetryRow {
  id: number;
  event_type: string;
  source: string;
  message: string;
  telemetry_json: string | null;
  created_at: string;
}

interface AttributionRow extends TradeHistoryRow {
  rationale: string | null;
  confidence: number | null;
}

interface VaultUpdateRequest {
  keyName?: string;
  secret?: string;
  metadata?: JsonRecord;
  rotationReason?: string;
}

interface AlertTestRequest {
  priority?: AlertPriority;
  title?: string;
  message?: string;
  dedupeKey?: string;
  metadata?: JsonRecord;
}

interface NotificationSettingsRequest {
  notifications?: NotificationSettingsUpdate;
}

interface DateRangeFilter {
  from: string | null;
  to: string | null;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const logger = new Logger(
      env.TRADING_DB,
      (promise) => ctx.waitUntil(promise),
      "GatewayWorker"
    );
    const configManager = new ConfigManager(env.CONFIG_STORE);
    const topology = extractEdgeTopology(request);

    if (request.method === "OPTIONS") {
      return corsPreflight();
    }

    if (url.pathname === "/health") {
      logger.info(
        "SYSTEM_HEARTBEAT",
        "Gateway heartbeat observed at Cloudflare edge",
        topologyTelemetry(topology),
        topology.requestId
      );

      return routeToEngine(request, env, topology, {
        timeoutMs: ENGINE_HEALTH_TIMEOUT_MS,
        timeoutResponse: gatewayHealthFallback(topology)
      });
    }

    if (url.pathname === "/state") {
      const auth = await authenticateAdmin(request, env, logger, topology, "READ");
      if (auth instanceof Response) {
        return auth;
      }

      return routeToEngine(request, env, topology);
    }

    if (url.pathname === "/performance") {
      const auth = await authenticateAdmin(request, env, logger, topology, "READ");
      if (auth instanceof Response) {
        return auth;
      }

      return routeToEngine(request, env, topology);
    }

    if (url.pathname === "/metrics/performance") {
      const auth = await authenticateAdmin(request, env, logger, topology, "READ");
      if (auth instanceof Response) {
        return auth;
      }

      return routeToEngine(request, env, topology);
    }

    if (url.pathname === "/slippage") {
      const auth = await authenticateAdmin(request, env, logger, topology, "READ");
      if (auth instanceof Response) {
        return auth;
      }

      return routeToEngine(request, env, topology);
    }

    if (url.pathname === "/book/snapshot") {
      const auth = await authenticateAdmin(request, env, logger, topology, "READ");
      if (auth instanceof Response) {
        return auth;
      }

      return routeToEngine(request, env, topology);
    }

    if (url.pathname === "/dom/heatmap") {
      const auth = await authenticateAdmin(request, env, logger, topology, "READ");
      if (auth instanceof Response) {
        return auth;
      }

      return routeToEngine(request, env, topology);
    }

    if (url.pathname === "/liquidations/heatmap") {
      const auth = await authenticateAdmin(request, env, logger, topology, "READ");
      if (auth instanceof Response) {
        return auth;
      }

      return routeToEngine(request, env, topology);
    }

    if (url.pathname === "/stream") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ ok: false, error: "WebSocket upgrade required" }, 426);
      }

      const auth = await authenticateAdmin(request, env, logger, topology, "READ");
      if (auth instanceof Response) {
        return auth;
      }

      return routeToEngine(request, env, topology);
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/tick" ||
        url.pathname === "/market/tick" ||
        url.pathname === "/hyperliquid/tick" ||
        url.pathname === "/hyperliquid/raw")
    ) {
      return routeToEngine(request, env, topology);
    }

    if (
      url.pathname === "/market/ws" &&
      request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    ) {
      return routeToEngine(request, env, topology);
    }

    if (request.method === "POST" && url.pathname === "/agent/signal") {
      return routeToEngine(request, env, topology);
    }

    if (url.pathname === "/moltworker/health") {
      if (request.method !== "GET") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }

      return readMoltworkerHealth(env);
    }

    if (url.pathname === "/login") {
      return handleLogin(request, env, logger, topology);
    }

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdminRequest(request, env, logger, configManager, topology);
    }

    return json({
      ok: true,
      service: "sovereign-sigma-core",
      singleton: tradingEngineObjectName(env),
      topology,
      routes: [
        "GET /health",
        "GET /state (READ token)",
        "GET /performance (READ token)",
        "GET /metrics/performance (READ token)",
        "GET /slippage (READ token)",
        "GET /book/snapshot (READ token)",
        "GET /dom/heatmap (READ token)",
        "GET /liquidations/heatmap (READ token)",
        "GET /stream (READ token, WebSocket)",
        "POST /tick",
        "POST /hyperliquid/raw",
        "POST /market/tick",
        "GET /market/ws",
        "POST /agent/signal",
        "GET /moltworker/health",
        "POST /login",
        "GET /admin",
        "GET /admin/ui",
        "GET|POST|PUT|PATCH /admin/config",
        "GET /admin/health",
        "GET /admin/state",
        "GET /admin/settings",
        "GET /admin/diagnostics",
        "POST /admin/moltworker/heartbeat",
        "POST /admin/settings/notifications",
        "GET|POST /admin/topology/calibrate",
        "GET /admin/performance",
        "GET /admin/metrics/performance",
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
        "GET /admin/book/snapshot",
        "GET /admin/dom/heatmap",
        "GET /admin/liquidations/heatmap",
        "GET /admin/stream",
        "GET /admin/logs"
      ]
    });
  }
} satisfies ExportedHandler<Env>;

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

  const body = await readJsonBody<LoginRequest>(request);
  const password = typeof body?.password === "string" ? body.password : "";
  const passwordOk = await authManager.verifyPassword(password);

  if (!passwordOk) {
    logSecurityEvent(
      logger,
      "LOGIN_FAILED",
      "Rejected login attempt",
      request,
      url,
      topology,
      { reason: "INVALID_PASSWORD" }
    );
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const scopes = AuthManager.normalizeScopes(body?.scopes ?? ["READ", "WRITE"]);
  const subject =
    typeof body?.subject === "string" && body.subject.length > 0
      ? body.subject
      : "admin";
  const token = await authManager.generateToken({
    sub: subject,
    scopes
  });

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
  const auth = await authenticateAdmin(
    request,
    env,
    logger,
    topology,
    requiredScope
  );

  if (auth instanceof Response) {
    return auth;
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
        "POST /admin/moltworker/heartbeat",
        "POST /admin/settings/notifications",
        "GET|POST /admin/topology/calibrate",
        "GET /admin/performance",
        "GET /admin/metrics/performance",
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
    return handleAdminConfig(
      request,
      env,
      logger,
      configManager,
      topology,
      auth
    );
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

  if (url.pathname === "/admin/diagnostics") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return runDiagnostics(env, logger, topology);
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

    return handleTopologyCalibration(
      request,
      env,
      logger,
      configManager,
      topology,
      auth
    );
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

    return routeToEngine(
      remapRequestPath(request, "/metrics/performance"),
      env,
      topology
    );
  }

  if (url.pathname === "/admin/maintenance/reset-latency") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(
      remapRequestPath(request, "/maintenance/reset-latency"),
      env,
      topology
    );
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

    return routeToEngine(
      remapRequestPath(request, "/maintenance/recover"),
      env,
      topology
    );
  }

  if (url.pathname === "/admin/slippage") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    return routeToEngine(remapRequestPath(request, "/slippage"), env, topology);
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
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
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
    typeof update.actor === "string" && update.actor.length > 0
      ? update.actor
      : admin.subject;
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

  if (
    requestedMode === "LIVE" &&
    !((update as Record<string, unknown>).confirmLive === true)
  ) {
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
    nextConfig = ConfigManager.mergeUpdate(
      currentConfig,
      update,
      actor
    );
    changedParameters = diffConfig(currentConfig, nextConfig);
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

async function readAdminSettings(
  env: Env,
  configManager: ConfigManager
): Promise<Response> {
  const notifier = new Notifier(env, () => undefined);
  const [config, alerting, vault, notifications, hyperliquidSecrets] = await Promise.all([
    configManager.fetchConfig(),
    notifier.statusAsync(),
    vaultStatus(env),
    readNotificationSettings(env),
    evaluateHyperliquidSecrets(env)
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
    backend: backendSettings(env)
  });
}

async function runDiagnostics(
  env: Env,
  logger: Logger,
  topology: EdgeTopology
): Promise<Response> {
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
  const d1DiagnosticMaxLatencyMs = positiveNumber(
    env.D1_DIAGNOSTIC_MAX_LATENCY_MS,
    250
  );
  const secretDiagnostic = await evaluateHyperliquidSecrets(env);
  const moltworker = await evaluateMoltworkerHeartbeat(env);
  const l1Sync = isJsonRecord(engineDiagnostics?.l1Sync)
    ? engineDiagnostics.l1Sync
    : null;
  const v8Memory = isJsonRecord(engineDiagnostics?.v8Memory)
    ? engineDiagnostics.v8Memory
    : null;
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
  const apply =
    request.method === "POST" &&
    ((body as Record<string, unknown>).apply !== false);
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
    const response = await engine.fetch(
      withTopologyHeaders(request, topology, controller?.signal)
    );

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

async function authenticateAdmin(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  requiredScope: AdminScope
): Promise<AuthenticatedAdmin | Response> {
  const url = new URL(request.url);
  const authManager = createAuthManager(env);

  if (!authManager) {
    logSecurityEvent(
      logger,
      "AUTH_CONFIG_MISSING",
      "Admin JWT secret is not configured",
      request,
      url,
      topology
    );
    return json({ ok: false, error: "Authentication unavailable" }, 503);
  }

  const token = bearerToken(request);

  if (!token) {
    logSecurityEvent(
      logger,
      "ADMIN_AUTH_REJECTED",
      "Rejected admin request without bearer token",
      request,
      url,
      topology,
      { reason: "MISSING_BEARER_TOKEN" }
    );
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  const claims = await authManager.verifyClaims(token);

  if (!claims) {
    logSecurityEvent(
      logger,
      "ADMIN_AUTH_REJECTED",
      "Rejected admin request with invalid JWT",
      request,
      url,
      topology,
      { reason: "INVALID_JWT" }
    );
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  if (!AuthManager.hasScope(claims, requiredScope)) {
    logSecurityEvent(
      logger,
      "ADMIN_SCOPE_REJECTED",
      "Rejected admin request with insufficient scope",
      request,
      url,
      topology,
      {
        reason: "INSUFFICIENT_SCOPE",
        requiredScope,
        subject: claims.sub,
        scopes: claims.scopes
      }
    );
    return json({ ok: false, error: "Forbidden" }, 403);
  }

  return {
    claims,
    subject: claims.sub
  };
}

function createAuthManager(env: Env): AuthManager | null {
  const jwtSecret = env.JWT_SECRET ?? env.ADMIN_JWT_SECRET;

  return jwtSecret ? new AuthManager(jwtSecret, env.ADMIN_PASSWORD) : null;
}

function requiredScopeForAdminRequest(request: Request): AdminScope {
  return request.method === "GET" || request.method === "HEAD" ? "READ" : "WRITE";
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return null;
    }

    const url = new URL(request.url);
    const queryToken = url.searchParams.get("access_token") ?? url.searchParams.get("token");
    return queryToken && queryToken.length > 0 ? queryToken : null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
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
  const [rows, count, paperPnl] = await Promise.all([
    env.TRADING_DB.prepare(dataQuery)
      .bind(...filters.bindings, limit, offset)
      .all<TradeHistoryRow>(),
    env.TRADING_DB.prepare(countQuery)
      .bind(...filters.bindings)
      .first<{ total: number }>(),
    readPaperPnlSummary(env)
  ]);
  const total = Number(count?.total ?? 0);

  return json({
    ok: true,
    data: (rows.results ?? []).map(formatTradeRow),
    paperPnl,
    pagination: pagination(page, limit, total),
    filters: filters.publicFilters
  });
}

async function readPaperPnlSummary(env: Env): Promise<JsonRecord> {
  const windowHours = 24;
  const sessionStartedAt = await env.CONFIG_STORE.get(PAPER_SESSION_STARTED_AT_KEY);
  const sessionCutoff =
    sessionStartedAt && Number.isFinite(Date.parse(sessionStartedAt))
      ? sessionStartedAt
      : null;
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
       AND raw_execution_json LIKE '%"paperSizer":"shadowQueueKellySize"%'
       ${timeFilterSql}
     GROUP BY asset
     ORDER BY asset`
  ).bind(...(sessionCutoff ? [sessionCutoff] : [])).all<PaperPnlAggregateRow>();
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
  ).bind(...bindings, queryLimit).all<AgentTraceRow>();
  const telemetry = await env.TRADING_DB.prepare(
    `SELECT id, event_type, source, message, telemetry_json, created_at
     FROM logs
     WHERE event_type IN ('AGENT_SIGNAL', 'AGENT_STATE_SNAPSHOT', 'PROFILER_ALERT', 'BAYESIAN_POSTERIOR_UPDATED')
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(Math.min(limit, 50)).all<TraceTelemetryRow>();
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
  ).bind(...bindings, limit).all<AttributionRow>();
  const trades = (rows.results ?? []).map(formatAttributionTrade).reverse();
  const byDriver = calculateAttributionByDriver(trades);
  const timeline = calculateAttributionTimeline(trades);

  return json({
    ok: true,
    trades,
    byDriver,
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
    return json({
      ok: false,
      error: "EXECUTIONER_SERVICE_NOT_BOUND"
    }, 503);
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

  return json({
    ok: response.ok,
    status: response.status,
    result: payload
  }, response.ok ? 200 : 502);
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
    side: row.side,
    pnl,
    evAtExecution: row.ev_at_execution,
    confidence: row.confidence ?? null,
    rationale: row.rationale,
    executedAt: row.executed_at
  };
}

function calculateAttributionByDriver(trades: AttributionTrade[]): JsonRecord[] {
  const buckets = new Map<string, AttributionTrade[]>();

  for (const trade of trades) {
    buckets.set(trade.driver, [...(buckets.get(trade.driver) ?? []), trade]);
  }

  return [...buckets.entries()].map(([driver, bucket]) => {
    const pnls = bucket.map((trade) => trade.pnl);
    const grossProfit = pnls.filter((pnl) => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
    const grossLoss = Math.abs(pnls.filter((pnl) => pnl < 0).reduce((sum, pnl) => sum + pnl, 0));
    const mean = pnls.reduce((sum, pnl) => sum + pnl, 0) / Math.max(1, pnls.length);
    const variance =
      pnls.length > 1
        ? pnls.reduce((sum, pnl) => sum + (pnl - mean) ** 2, 0) / (pnls.length - 1)
        : 0;
    const sigma = Math.sqrt(variance);

    return {
      driver,
      tradeCount: bucket.length,
      cumulativePnl: round(pnls.reduce((sum, pnl) => sum + pnl, 0), 8),
      averagePnl: round(mean, 8),
      sharpe: sigma > 0 ? round((mean / sigma) * Math.sqrt(bucket.length), 6) : null,
      profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 6) : null,
      grossProfit: round(grossProfit, 8),
      grossLoss: round(grossLoss, 8),
      averageConfidence: round(
        bucket.reduce((sum, trade) => sum + (trade.confidence ?? 0), 0) / Math.max(1, bucket.length),
        6
      )
    };
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
    rotationPolicy: "Use encrypted RISK_VAULT requests for short-lived rotation workflow; promote durable credentials with wrangler secret in production."
  };
}

function backendSettings(env: Env): JsonRecord {
  return {
    api: {
      gatewayRoute: "https://api.yevow.co",
      adminStreamPath: "/admin/stream",
      healthPath: "/health",
      executionerBound: Boolean(env.EXECUTIONER),
      aiBound: Boolean(env.AI)
    },
    ingest: {
      nativeSource: "DWELLIR_HYPERLIQUID_GRPC",
      transport: env.INGEST_TRANSPORT ?? "grpc",
      dwellirGrpcUrl: redactedEndpoint(
        env.DWELLIR_GRPC_URL ?? env.DWELLIR_GRPC_ENDPOINT ?? env.RPC_GRPC_ENDPOINT
      ),
      dwellirGrpcPathConfigured: hasEndpointPath(
        env.DWELLIR_GRPC_URL ?? env.DWELLIR_GRPC_ENDPOINT ?? env.RPC_GRPC_ENDPOINT
      ),
      dwellirGrpcService: env.RPC_GRPC_SERVICE ?? null,
      dwellirGrpcStreams: env.DWELLIR_GRPC_STREAMS ?? env.RPC_GRPC_STREAM_TYPES ?? null,
      dwellirSubscriptionTier: env.DWELLIR_SUBSCRIPTION_TIER ?? null,
      dwellirOrderbookDepth: stringNumber(env.DWELLIR_ORDERBOOK_DEPTH),
      dwellirOrderbookTransport: env.DWELLIR_ORDERBOOK_TRANSPORT ?? "websocket",
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

function normalizeVaultKey(value: string | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  const allowed = new Set([
    "EXCHANGE_API_KEY",
    "EXCHANGE_API_SECRET",
    "HL_AGENT_ADDRESS",
    "HL_AGENT_SECRET",
    "EXCHANGE_HMAC_SECRET",
    "EXCHANGE_ED25519_PRIVATE_KEY",
    "DISCORD_WEBHOOK_URL",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "ALERT_WEBHOOK_URL"
  ]);

  return normalized && allowed.has(normalized) ? normalized : null;
}

function sanitizeReason(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  return value.slice(0, 256).replace(/[^\w .:/@-]/g, "");
}

function normalizeAlertPriority(value: AlertPriority | undefined): AlertPriority {
  return value === "LOW" ||
    value === "MEDIUM" ||
    value === "HIGH" ||
    value === "CRITICAL"
    ? value
    : "HIGH";
}

function safeAlertText(value: string | undefined, fallback: string, maxLength: number): string {
  const text = typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
  return text.slice(0, maxLength).replace(/[^\w .,:/@()[\]#-]/g, "");
}

async function encryptSecret(secret: string, keyMaterial: string): Promise<JsonRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keyMaterial));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(secret)
  );

  return {
    alg: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    createdAt: new Date().toISOString()
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

async function safeResponseJson(response: Response): Promise<JsonRecord | null> {
  try {
    const payload = await response.json<unknown>();
    return isJsonRecord(payload) ? payload : { value: JSON.stringify(payload) };
  } catch {
    return null;
  }
}

function adminUiResponse(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Sovereign-Sigma Command Center</title>
  <style>
    body{margin:0;background:#0e1014;color:#f3efe7;font:14px/1.45 Inter,system-ui,sans-serif}
    header{padding:28px 36px;border-bottom:1px solid #2a2f39}
    h1{font-family:Bodoni 72,Didot,serif;font-size:38px;margin:0;letter-spacing:0}
    main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;padding:24px 36px}
    section{border:1px solid #2a2f39;padding:18px;background:#151922}
    h2{margin:0 0 14px;font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:#d8c596}
    label{display:grid;gap:6px;margin:12px 0;color:#bfc7d5}
    input,select,button{font:inherit;background:#0e1014;color:#f3efe7;border:1px solid #3b4352;padding:10px}
    button{cursor:pointer;background:#d8c596;color:#111317;border:0}
    pre{white-space:pre-wrap;min-height:160px;background:#090b0f;padding:14px;color:#79f2c0}
  </style>
</head>
<body>
  <header><h1>Sovereign-Sigma</h1></header>
  <main>
    <section>
      <h2>Risk Command Center</h2>
      <label>JWT <input id="token" type="password" placeholder="Bearer token" /></label>
      <label>Trading Enabled <select id="TRADING_ENABLED"><option value="false">false</option><option value="true">true</option></select></label>
      <label>Max Position Size <input id="MAX_POSITION_SIZE" type="number" step="0.0001" /></label>
      <label>Kelly Fraction <input id="KELLY_FRACTION" type="number" min="0" max="1" step="0.01" /></label>
      <label>Min EV Threshold <input id="MIN_EV_THRESHOLD" type="number" step="0.0001" /></label>
      <label>Max Latency MS <input id="LATENCY_THRESHOLD_MS" type="number" min="1" step="1" /></label>
      <button onclick="saveConfig()">Save</button>
    </section>
    <section>
      <h2>Credential Vault</h2>
      <label>Key <select id="vaultKey"><option>HL_AGENT_ADDRESS</option><option>HL_AGENT_SECRET</option><option>EXCHANGE_API_KEY</option><option>EXCHANGE_API_SECRET</option></select></label>
      <label>Secret <input id="vaultSecret" type="password" /></label>
      <button onclick="rotateVault()">Rotate</button>
      <button onclick="testVault()">Test Connection</button>
    </section>
    <section>
      <h2>Time Machine</h2>
      <label>Mode <select id="engineMode"><option>LIVE</option><option>PAPER</option></select></label>
      <label>From <input id="dateFrom" type="datetime-local" /></label>
      <label>To <input id="dateTo" type="datetime-local" /></label>
      <button onclick="startReplay()">Replay</button>
      <progress id="replayProgress" value="0" max="100"></progress>
    </section>
    <section>
      <h2>Agent CCTV</h2>
      <button onclick="loadTrace()">Refresh Trace</button>
      <pre id="output"></pre>
    </section>
  </main>
  <script>
    const out = document.getElementById('output');
    const auth = () => ({Authorization:'Bearer '+document.getElementById('token').value,'content-type':'application/json'});
    async function saveConfig(){
      if(!confirm('Apply high-impact risk settings?')) return;
      const body={confirmHighImpact:true,config:{TRADING_ENABLED:document.getElementById('TRADING_ENABLED').value==='true',MAX_POSITION_SIZE:+MAX_POSITION_SIZE.value,KELLY_FRACTION:+KELLY_FRACTION.value,MIN_EV_THRESHOLD:+MIN_EV_THRESHOLD.value,LATENCY_THRESHOLD_MS:+LATENCY_THRESHOLD_MS.value}};
      out.textContent=await (await fetch('/admin/config',{method:'POST',headers:auth(),body:JSON.stringify(body)})).text();
    }
    async function rotateVault(){out.textContent=await (await fetch('/admin/vault',{method:'POST',headers:auth(),body:JSON.stringify({keyName:vaultKey.value,secret:vaultSecret.value,rotationReason:'ui-rotation'})})).text();}
    async function testVault(){out.textContent=await (await fetch('/admin/vault/test',{method:'POST',headers:auth()})).text();}
    async function startReplay(){out.textContent=await (await fetch('/admin/replay',{method:'POST',headers:auth(),body:JSON.stringify({dateFrom:dateFrom.value,dateTo:dateTo.value,shadowBankroll:100000,speedMultiplier:20})})).text(); await replayStatus();}
    async function replayStatus(){const s=await (await fetch('/admin/replay/status',{headers:auth()})).json(); replayProgress.value=s.replay?.progressPct||0; return s;}
    async function loadTrace(){out.textContent=JSON.stringify(await (await fetch('/admin/trace',{headers:auth()})).json(),null,2);}
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html;charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}

function buildLogFilters(url: URL): {
  where: string[];
  bindings: string[];
  publicFilters: JsonRecord;
} {
  const where: string[] = [];
  const bindings: string[] = [];
  const level = normalizeEnum(url.searchParams.get("level"), LOG_LEVELS);
  const agent = normalizeEnum(url.searchParams.get("agent"), AGENT_NAMES);
  const dateRange = parseDateRange(url);

  if (level) {
    where.push("level = ?");
    bindings.push(level);
  }

  if (agent) {
    where.push("(source = ? OR telemetry_json LIKE ? OR event_type LIKE ?)");
    bindings.push(agent, `%"${agent}"%`, `%${agent}%`);
  }

  if (dateRange.from) {
    where.push("created_at >= ?");
    bindings.push(dateRange.from);
  }

  if (dateRange.to) {
    where.push("created_at <= ?");
    bindings.push(dateRange.to);
  }

  return {
    where,
    bindings,
    publicFilters: {
      level,
      agent,
      dateRange: {
        from: dateRange.from,
        to: dateRange.to
      }
    }
  };
}

function buildTradeFilters(url: URL): {
  where: string[];
  bindings: string[];
  publicFilters: JsonRecord;
} {
  const where: string[] = [];
  const bindings: string[] = [];
  const agent = normalizeEnum(url.searchParams.get("agent"), AGENT_NAMES);
  const rawStatus = url.searchParams.get("status")?.trim().toUpperCase() ?? null;
  const status =
    rawStatus === "ALL"
      ? null
      : normalizeEnum(rawStatus, TRADE_STATUSES) ?? "FILLED";
  const asset = normalizeAsset(url.searchParams.get("asset"));
  const dateRange = parseDateRange(url);

  if (status) {
    where.push("t.status = ?");
    bindings.push(status);
  }

  if (agent) {
    where.push("d.agent_name = ?");
    bindings.push(agent);
  }

  if (asset) {
    where.push("t.asset = ?");
    bindings.push(asset);
  }

  if (dateRange.from) {
    where.push("t.executed_at >= ?");
    bindings.push(dateRange.from);
  }

  if (dateRange.to) {
    where.push("t.executed_at <= ?");
    bindings.push(dateRange.to);
  }

  return {
    where,
    bindings,
    publicFilters: {
      status,
      statusMode: rawStatus === "ALL" ? "ALL" : status,
      agent,
      asset,
      dateRange: {
        from: dateRange.from,
        to: dateRange.to
      }
    }
  };
}

function formatLogRow(row: LogRow): JsonRecord {
  return {
    id: row.id,
    level: row.level,
    eventType: row.event_type,
    source: row.source,
    message: row.message,
    correlationId: row.correlation_id,
    telemetry: parseJsonRecord(row.telemetry_json),
    timestamp: row.created_at
  };
}

function formatTradeRow(row: TradeHistoryRow): JsonRecord {
  return {
    tradeId: row.trade_id,
    orderId: row.order_id,
    signalId: row.signal_id,
    venue: row.venue,
    asset: row.asset,
    side: row.side,
    orderType: row.order_type,
    price: row.price,
    size: row.size,
    notional: row.notional,
    evAtExecution: row.ev_at_execution,
    slippageBps: row.slippage_bps,
    resultingPnl: row.resulting_pnl ?? 0,
    primaryDriver: row.primary_driver ?? null,
    fees: row.fees,
    status: row.status,
    exchangeTradeId: row.exchange_trade_id,
    rawExecution: parseJsonRecord(row.raw_execution_json),
    agentName: row.agent_name,
    traceId: row.trace_id,
    executedAt: row.executed_at,
    createdAt: row.created_at
  };
}

function pagination(
  page: number,
  limit: number,
  total: number
): JsonRecord {
  const pageCount = Math.ceil(total / limit);

  return {
    page,
    limit,
    total,
    pageCount,
    hasNextPage: page < pageCount,
    hasPreviousPage: page > 1
  };
}

function normalizeEnum<T extends string>(
  value: string | null,
  allowed: readonly T[]
): T | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return allowed.includes(normalized as T) ? (normalized as T) : null;
}

function normalizeEngineMode(value: unknown): "PAPER" | "LIVE" | "HALTED" | null {
  if (value !== "PAPER" && value !== "LIVE" && value !== "HALTED") {
    return null;
  }

  return value;
}

function normalizeAsset(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9._:-]{1,64}$/.test(normalized) ? normalized : null;
}

function parseDateRange(url: URL): DateRangeFilter {
  const compactRange =
    url.searchParams.get("date_range") ?? url.searchParams.get("dateRange");
  const [rangeFrom, rangeTo] = compactRange?.split(/[|,]/, 2) ?? [];
  const from =
    normalizeIsoDate(url.searchParams.get("from")) ??
    normalizeIsoDate(url.searchParams.get("start")) ??
    normalizeIsoDate(url.searchParams.get("date_from")) ??
    normalizeIsoDate(rangeFrom);
  const to =
    normalizeIsoDate(url.searchParams.get("to")) ??
    normalizeIsoDate(url.searchParams.get("end")) ??
    normalizeIsoDate(url.searchParams.get("date_to")) ??
    normalizeIsoDate(rangeTo);

  return { from, to };
}

function normalizeIsoDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseJsonRecord(value: string | null): JsonRecord | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonValue(value: string | undefined): JsonValue | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

function stringNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readString(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumberField(record: JsonRecord | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOption(
  bodyValue: unknown,
  queryValue: string | null
): number | undefined {
  const candidate = bodyValue ?? queryValue;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function round(value: number, decimalPlaces: number): number {
  const scale = 10 ** decimalPlaces;
  return Math.round(value * scale) / scale;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logSecurityEvent(
  logger: Logger,
  eventType: string,
  message: string,
  request: Request,
  url: URL,
  topology: EdgeTopology,
  extra: JsonRecord = {}
): void {
  logger.warn(eventType, message, {
    ...extra,
    sourceIp: sourceIp(request),
    endpoint: url.pathname,
    method: request.method,
    colo: topology.colo,
    placement: topology.placement,
    requestId: topology.requestId
  });
}

function sourceIp(request: Request): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");

  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    forwardedFor?.split(",")[0]?.trim() ??
    null
  );
}

async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return await request.json<T>();
  } catch {
    return null;
  }
}

function clampInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function extractEdgeTopology(request: Request): EdgeTopology {
  const cf = (request as Request & { cf?: CloudflareRequestMetadata }).cf;
  const placement = nullableHeader(request.headers.get("cf-placement"));

  return {
    colo: normalizeCfValue(cf?.colo),
    placement,
    country: normalizeCfValue(cf?.country),
    city: normalizeCfValue(cf?.city),
    region: normalizeCfValue(cf?.region),
    timezone: normalizeCfValue(cf?.timezone),
    latitude: normalizeCfValue(cf?.latitude),
    longitude: normalizeCfValue(cf?.longitude),
    requestId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
    observedAt: new Date().toISOString()
  };
}

function placementColo(placement: string | null): string | null {
  const match = /^(?:remote|local)-([a-z0-9]{3,4})$/i.exec(placement ?? "");
  return match?.[1]?.toUpperCase() ?? null;
}

function withTopologyHeaders(
  request: Request,
  topology: EdgeTopology,
  signal?: AbortSignal
): Request {
  const headers = new Headers(request.headers);

  setTopologyHeader(headers, "colo", topology.colo);
  setTopologyHeader(headers, "placement", topology.placement);
  setTopologyHeader(headers, "country", topology.country);
  setTopologyHeader(headers, "city", topology.city);
  setTopologyHeader(headers, "region", topology.region);
  setTopologyHeader(headers, "timezone", topology.timezone);
  setTopologyHeader(headers, "latitude", topology.latitude);
  setTopologyHeader(headers, "longitude", topology.longitude);
  setTopologyHeader(headers, "request-id", topology.requestId);
  setTopologyHeader(headers, "observed-at", topology.observedAt);

  return new Request(request, { headers, signal });
}

function setTopologyHeader(
  headers: Headers,
  key: string,
  value: string | null
): void {
  if (value !== null) {
    headers.set(`${TOPOLOGY_HEADER_PREFIX}${key}`, value);
  }
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

function topologyTelemetry(topology: EdgeTopology): JsonRecord {
  return {
    colo: topology.colo,
    placement: topology.placement,
    country: topology.country,
    city: topology.city,
    region: topology.region,
    timezone: topology.timezone,
    latitude: topology.latitude,
    longitude: topology.longitude,
    requestId: topology.requestId,
    observedAt: topology.observedAt
  };
}

function nullableHeader(value: string | null): string | null {
  return value && value.length > 0 ? value : null;
}

function normalizeCfValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function diffConfig(
  before: GlobalRiskConfig,
  after: GlobalRiskConfig
): Record<string, { before: boolean | number | string; after: boolean | number | string }> {
  const fields = [
    "TRADING_ENABLED",
    "MAX_POSITION_SIZE",
    "MAX_POSITION_PCT",
    "MAX_INVENTORY_UNITS",
    "MAX_INVENTORY_DELTA",
    "MAX_DRAWDOWN_PCT",
    "LATENCY_THRESHOLD_MS",
    "GOLDEN_COLOS",
    "MIN_EV_THRESHOLD",
    "EXCHANGE_FEE_BPS",
    "KELLY_FRACTION",
    "RISK_AVERSION_FACTOR",
    "FUNDING_BIAS_THRESHOLD",
    "FUNDING_INVENTORY_BIAS",
    "QUOTE_HIBERNATE_MS",
    "VAR_CONFIDENCE_Z",
    "ORACLE_GOVERNANCE_MODE",
    "ORACLE_MANUAL_SKEPTICISM",
    "ORACLE_MAX_SKEPTICISM"
  ] as const;
  const diff: Record<string, { before: boolean | number | string; after: boolean | number | string }> = {};

  for (const field of fields) {
    if (before[field] !== after[field]) {
      diff[field] = {
        before: before[field],
        after: after[field]
      };
    }
  }

  return diff;
}

function requiresHighImpactConfirmation(
  changedParameters: Record<string, { before: boolean | number | string; after: boolean | number | string }>,
  update: AdminConfigUpdate
): boolean {
  const highImpact = new Set([
    "TRADING_ENABLED",
    "MAX_POSITION_SIZE",
    "MAX_POSITION_PCT",
    "MAX_INVENTORY_DELTA",
    "MAX_DRAWDOWN_PCT",
    "KELLY_FRACTION",
    "MIN_EV_THRESHOLD",
    "LATENCY_THRESHOLD_MS",
    "GOLDEN_COLOS"
  ]);
  const hasHighImpactChange = Object.keys(changedParameters).some((field) => highImpact.has(field));
  const updateRecord = update as Record<string, unknown>;
  const confirmed =
    updateRecord.confirmHighImpact === true ||
    updateRecord.confirm === true ||
    updateRecord.confirmation === "CONFIRM";

  return hasHighImpactChange && !confirmed;
}

function hasRiskConfigMutation(update: AdminConfigUpdate): boolean {
  return Boolean(
    update.config ||
      update.TRADING_ENABLED !== undefined ||
      update.MAX_POSITION_SIZE !== undefined ||
      update.MAX_POSITION_PCT !== undefined ||
      update.MAX_INVENTORY_UNITS !== undefined ||
      update.MAX_INVENTORY_DELTA !== undefined ||
      update.MAX_DRAWDOWN_PCT !== undefined ||
      update.LATENCY_THRESHOLD_MS !== undefined ||
      update.GOLDEN_COLOS !== undefined ||
      update.MIN_EV_THRESHOLD !== undefined ||
      update.EXCHANGE_FEE_BPS !== undefined ||
      update.KELLY_FRACTION !== undefined ||
      update.RISK_AVERSION_FACTOR !== undefined ||
      update.FUNDING_BIAS_THRESHOLD !== undefined ||
      update.FUNDING_INVENTORY_BIAS !== undefined ||
      update.QUOTE_HIBERNATE_MS !== undefined ||
      update.VAR_CONFIDENCE_Z !== undefined ||
      update.ORACLE_GOVERNANCE_MODE !== undefined ||
      update.ORACLE_MANUAL_SKEPTICISM !== undefined ||
      update.ORACLE_MAX_SKEPTICISM !== undefined
  );
}

function logSupervisorAction(
  logger: Logger,
  input: {
    actor: string;
    kind: "MACRO_BIAS" | "TEMPORARY_OVERRIDE";
    reason: string;
    confidence: number;
    payload: unknown;
    topology: EdgeTopology;
  }
): void {
  const observedAt = new Date().toISOString();
  const signalId = `supervisor:${input.kind.toLowerCase()}:${crypto.randomUUID()}`;

  logger.traceDecision({
    decisionId: `decision:${signalId}`,
    signalId,
    traceId: `moltworker:${input.kind.toLowerCase()}:${observedAt}`,
    agentName: "MOLTWORKER",
    targetAgent: "RISK",
    instrumentCode: "GLOBAL",
    action: "SUPERVISOR_ACTION",
    confidence: Math.min(1, Math.max(0, input.confidence)),
    reasoning: input.reason,
    featureVector: {
      supervisorAction: input.kind,
      actor: input.actor,
      payload: sanitizeSupervisorPayload(input.payload)
    },
    riskSnapshot: {
      colo: input.topology.colo,
      placement: input.topology.placement,
      requestId: input.topology.requestId
    },
    rawSignal: {
      supervisorAction: input.kind,
      actor: input.actor,
      source: "MOLTWORKER"
    },
    latencyMs: 0,
    createdAt: observedAt
  });
}

function sanitizeSupervisorPayload(payload: unknown): JsonRecord {
  return JSON.parse(JSON.stringify(payload)) as JsonRecord;
}

function configTelemetry(config: GlobalRiskConfig): Record<string, boolean | number | string> {
  return {
    TRADING_ENABLED: config.TRADING_ENABLED,
    MAX_POSITION_SIZE: config.MAX_POSITION_SIZE,
    MAX_POSITION_PCT: config.MAX_POSITION_PCT,
    MAX_INVENTORY_UNITS: config.MAX_INVENTORY_UNITS,
    MAX_INVENTORY_DELTA: config.MAX_INVENTORY_DELTA,
    MAX_DRAWDOWN_PCT: config.MAX_DRAWDOWN_PCT,
    LATENCY_THRESHOLD_MS: config.LATENCY_THRESHOLD_MS,
    GOLDEN_COLOS: config.GOLDEN_COLOS,
    MIN_EV_THRESHOLD: config.MIN_EV_THRESHOLD,
    EXCHANGE_FEE_BPS: config.EXCHANGE_FEE_BPS,
    KELLY_FRACTION: config.KELLY_FRACTION,
    RISK_AVERSION_FACTOR: config.RISK_AVERSION_FACTOR,
    FUNDING_BIAS_THRESHOLD: config.FUNDING_BIAS_THRESHOLD,
    FUNDING_INVENTORY_BIAS: config.FUNDING_INVENTORY_BIAS,
    QUOTE_HIBERNATE_MS: config.QUOTE_HIBERNATE_MS,
    VAR_CONFIDENCE_Z: config.VAR_CONFIDENCE_Z,
    ORACLE_GOVERNANCE_MODE: config.ORACLE_GOVERNANCE_MODE,
    ORACLE_MANUAL_SKEPTICISM: config.ORACLE_MANUAL_SKEPTICISM,
    ORACLE_MAX_SKEPTICISM: config.ORACLE_MAX_SKEPTICISM,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
    version: config.version
  };
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

async function evaluateHyperliquidSecrets(env: Env): Promise<{
  ok: boolean;
  detail: string;
  metadata: JsonRecord;
}> {
  const executionerDiagnostic = await evaluateExecutionerHyperliquidSecrets(env);
  if (executionerDiagnostic) {
    return executionerDiagnostic;
  }

  const [secret, address] = await Promise.all([
    readDiagnosticSecret(env, "HL_AGENT_SECRET"),
    readDiagnosticSecret(env, "HL_AGENT_ADDRESS")
  ]);

  if (!secret.value || !address.value) {
    return {
      ok: false,
      detail: "HL_AGENT_SECRET or HL_AGENT_ADDRESS is not available from Workers secrets or the encrypted vault.",
      metadata: {
        secretSource: secret.source,
        addressSource: address.source,
        hasSecret: Boolean(secret.value),
        hasAddress: Boolean(address.value)
      }
    };
  }

  try {
    const derivedAddress = SignatureEngine.preloadHyperliquidAgentSecret(secret.value).address;
    const configuredAddress = address.value.trim().toLowerCase();
    const ok = derivedAddress === configuredAddress;

    return {
      ok,
      detail: ok
        ? "Hyperliquid API agent private key derives the configured agent address."
        : "HL_AGENT_ADDRESS does not match the address derived from HL_AGENT_SECRET.",
      metadata: {
        secretSource: secret.source,
        addressSource: address.source,
        configuredAddress: maskAddress(configuredAddress),
        derivedAddress: maskAddress(derivedAddress)
      }
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "HL_AGENT_SECRET_VALIDATION_FAILED",
      metadata: {
        secretSource: secret.source,
        addressSource: address.source
      }
    };
  }
}

async function evaluateExecutionerHyperliquidSecrets(env: Env): Promise<{
  ok: boolean;
  detail: string;
  metadata: JsonRecord;
} | null> {
  if (!env.EXECUTIONER) {
    return null;
  }

  try {
    const response = await env.EXECUTIONER.fetch(
      new Request("https://executioner.internal/diagnostics", {
        headers: { accept: "application/json" }
      })
    );
    const body = await safeResponseJson(response);
    const secretCheck = isJsonRecord(body?.hyperliquidSecrets)
      ? body.hyperliquidSecrets
      : null;

    if (!secretCheck) {
      return {
        ok: false,
        detail: `Executioner diagnostics returned HTTP ${response.status} without Hyperliquid secret status.`,
        metadata: {
          source: "EXECUTIONER",
          status: response.status
        }
      };
    }

    const metadata = isJsonRecord(secretCheck.metadata) ? secretCheck.metadata : {};
    return {
      ok: Boolean(secretCheck.ok),
      detail:
        typeof secretCheck.detail === "string"
          ? secretCheck.detail
          : "Executioner Hyperliquid secret diagnostic completed.",
      metadata: {
        ...metadata,
        source: "EXECUTIONER",
        status: response.status
      }
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "EXECUTIONER_DIAGNOSTICS_FAILED",
      metadata: { source: "EXECUTIONER" }
    };
  }
}

async function readDiagnosticSecret(
  env: Env,
  keyName: "HL_AGENT_SECRET" | "HL_AGENT_ADDRESS"
): Promise<{ source: "ENV" | "VAULT" | "MISSING"; value: string | null }> {
  const direct = (env as unknown as Record<string, string | undefined>)[keyName];
  if (direct) {
    return { source: "ENV", value: direct };
  }

  const encryptionSecret = env.VAULT_ENCRYPTION_SECRET ?? env.JWT_SECRET ?? env.ADMIN_JWT_SECRET;
  if (!encryptionSecret) {
    return { source: "MISSING", value: null };
  }

  const encrypted = await env.RISK_VAULT.get<JsonRecord>(`vault:secret:${keyName}`, "json");
  if (!encrypted) {
    return { source: "MISSING", value: null };
  }

  return {
    source: "VAULT",
    value: await decryptDiagnosticSecret(encrypted, encryptionSecret)
  };
}

async function decryptDiagnosticSecret(
  encrypted: JsonRecord,
  keyMaterial: string
): Promise<string | null> {
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

async function readMoltworkerHealth(env: Env): Promise<Response> {
  const heartbeat = await env.CONFIG_STORE.get<JsonRecord>(
    MOLTWORKER_HEARTBEAT_KEY,
    "json"
  );
  const maxAgeMs = moltworkerHeartbeatMaxAgeMs(env);

  if (!heartbeat) {
    return json(
      {
        ok: false,
        service: "moltworker-health",
        status: "MISSING_HEARTBEAT",
        detail: "No Moltworker heartbeat has been recorded yet.",
        maxAgeMs
      },
      503,
      { "cache-control": "no-store" }
    );
  }

  const observedAt =
    typeof heartbeat.observedAt === "string" ? Date.parse(heartbeat.observedAt) : NaN;
  const ageMs = Number.isFinite(observedAt) ? Date.now() - observedAt : Number.POSITIVE_INFINITY;
  const declaredStatus =
    typeof heartbeat.status === "string" ? heartbeat.status.toUpperCase() : "UNKNOWN";
  const ok = ageMs <= maxAgeMs && declaredStatus !== "DOWN";

  return json(
    {
      ok,
      service: "moltworker-health",
      status: ok ? "OK" : "STALE",
      detail: ok
        ? `Moltworker heartbeat is fresh (${Math.max(0, Math.round(ageMs))}ms old).`
        : `Moltworker heartbeat is stale or unhealthy (${Math.round(ageMs)}ms old).`,
      heartbeat,
      ageMs: Math.round(ageMs),
      maxAgeMs
    },
    ok ? 200 : 503,
    { "cache-control": "no-store" }
  );
}

async function updateMoltworkerHeartbeat(
  request: Request,
  env: Env,
  logger: Logger,
  topology: EdgeTopology,
  auth: AuthenticatedAdmin
): Promise<Response> {
  const body = (await readJsonBody<JsonRecord>(request)) ?? {};
  const observedAt = new Date().toISOString();
  const status =
    typeof body.status === "string" && body.status.trim().length > 0
      ? body.status.trim().toUpperCase()
      : "OK";
  const mode = typeof body.mode === "string" ? body.mode.trim() : "UNKNOWN";
  const strategicIntent =
    typeof body.strategicIntent === "string" ? body.strategicIntent.trim() : null;
  const metadata = isJsonRecord(body.metadata) ? body.metadata : {};
  const maxAgeMs = moltworkerHeartbeatMaxAgeMs(env);
  const heartbeat: JsonRecord = {
    observedAt,
    status,
    mode,
    strategicIntent,
    actor: auth.subject,
    sourceIp: sourceIp(request),
    colo: topology.colo,
    placement: topology.placement,
    metadata
  };

  await env.CONFIG_STORE.put(MOLTWORKER_HEARTBEAT_KEY, JSON.stringify(heartbeat), {
    expirationTtl: Math.max(300, Math.ceil(maxAgeMs / 1000) * 4)
  });

  logger.info("MOLTWORKER_HEARTBEAT_UPDATED", "Moltworker heartbeat recorded", {
    actor: auth.subject,
    status,
    mode,
    strategicIntent,
    sourceIp: sourceIp(request),
    colo: topology.colo,
    placement: topology.placement
  });

  return json(
    {
      ok: true,
      heartbeat,
      maxAgeMs
    },
    200,
    { "cache-control": "no-store" }
  );
}

function moltworkerHeartbeatMaxAgeMs(env: Env): number {
  const parsed = Number(env.MOLTWORKER_HEARTBEAT_MAX_AGE_MS);
  return Number.isFinite(parsed) && parsed >= 30_000
    ? Math.round(parsed)
    : DEFAULT_MOLTWORKER_HEARTBEAT_MAX_AGE_MS;
}

async function evaluateMoltworkerHeartbeat(env: Env): Promise<{
  ok: boolean;
  status: "OPTIMAL" | "WARN" | "ANOMALY";
  detail: string;
  metadata: JsonRecord;
}> {
  if (!env.MOLTWORKER_HEALTH_URL) {
    return {
      ok: false,
      status: "WARN",
      detail: "MOLTWORKER_HEALTH_URL is not configured; supervisor heartbeat cannot be verified from the edge.",
      metadata: { configured: false }
    };
  }

  if (isInternalMoltworkerHealthUrl(env.MOLTWORKER_HEALTH_URL)) {
    return evaluateLocalMoltworkerHeartbeat(env);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("MOLTWORKER_TIMEOUT"), 1_200);
  const startedAt = performance.now();

  try {
    const response = await fetch(env.MOLTWORKER_HEALTH_URL, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json,text/plain;q=0.9,*/*;q=0.1" }
    });
    const latencyMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
    const body = await safeResponseJson(response);
    const lastRun = isJsonRecord(body?.lastRun) ? body.lastRun : null;
    const lastRunMetadata = isJsonRecord(lastRun?.metadata) ? lastRun.metadata : null;
    const runtime =
      typeof lastRunMetadata?.runtime === "string" ? lastRunMetadata.runtime : null;
    const source =
      typeof lastRunMetadata?.source === "string" ? lastRunMetadata.source : null;
    const supervisorOk = body?.ok !== false;

    return {
      ok: response.ok && supervisorOk,
      status: response.ok && supervisorOk ? "OPTIMAL" : "ANOMALY",
      detail: response.ok && supervisorOk
        ? `Moltworker heartbeat responded in ${latencyMs}ms${runtime ? ` from ${runtime}` : ""}.`
        : `Moltworker heartbeat returned HTTP ${response.status}.`,
      metadata: {
        configured: true,
        status: response.status,
        latencyMs,
        supervisorStatus: typeof body?.status === "string" ? body.status : null,
        runtime,
        source,
        observedAt: typeof lastRun?.observedAt === "string" ? lastRun.observedAt : null
      }
    };
  } catch (error) {
    return {
      ok: false,
      status: "ANOMALY",
      detail: error instanceof Error ? error.message : "MOLTWORKER_HEARTBEAT_FAILED",
      metadata: { configured: true }
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function evaluateLocalMoltworkerHeartbeat(env: Env): Promise<{
  ok: boolean;
  status: "OPTIMAL" | "WARN" | "ANOMALY";
  detail: string;
  metadata: JsonRecord;
}> {
  const startedAt = performance.now();
  const response = await readMoltworkerHealth(env);
  const latencyMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
  const rawPayload = await response.json().catch(() => ({}));
  const payload = isJsonRecord(rawPayload) ? rawPayload : {};
  const detail =
    typeof payload.detail === "string"
      ? payload.detail
      : response.ok
        ? "Moltworker heartbeat is fresh."
        : `Moltworker heartbeat returned HTTP ${response.status}.`;

  return {
    ok: response.ok,
    status: response.ok ? "OPTIMAL" : "ANOMALY",
    detail,
    metadata: {
      configured: true,
      localBridge: true,
      status: response.status,
      latencyMs,
      ageMs: finiteNumber(payload.ageMs),
      maxAgeMs: finiteNumber(payload.maxAgeMs)
    }
  };
}

function isInternalMoltworkerHealthUrl(value: string): boolean {
  try {
    return new URL(value).pathname === "/moltworker/health";
  } catch {
    return false;
  }
}

function maskAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : "configured";
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

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function toJsonRecord(value: unknown): JsonRecord {
  if (isJsonRecord(value)) {
    return value;
  }

  return JSON.parse(JSON.stringify(value ?? {})) as JsonRecord;
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      ...corsHeaders(),
      ...headers
    }
  });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-source",
    "access-control-max-age": "86400"
  };
}
