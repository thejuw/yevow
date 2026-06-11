import { ConfigManager } from "../ConfigManager";
import { Governor } from "../Governor";
import type { Logger } from "../Logger";
import { Notifier } from "../utils/Notifier";
import type { AdminConfigUpdate, EdgeTopology, Env } from "../types";
import type { AuthenticatedAdmin } from "./AdminModels";
import {
  configTelemetry,
  diffConfig,
  hasRiskConfigMutation,
  logSupervisorAction,
  recordCascadeConfigMetadata,
  requestsCascadeLivePromotion,
  requiresHighImpactConfirmation
} from "./AdminConfigGuards";
import { buildCostDashboard } from "./CostDashboard";
import { CASCADE_TWO_PERSON_READ_APPROVAL_KEY } from "./GatewayConstants";
import { routeToEngine } from "./GatewayEngineRouter";
import {
  evaluateCascadeLiveReadinessFromState,
  evaluateLiveReadiness
} from "./LiveReadinessGateway";
import { json } from "./ResponseHelpers";
import { sourceIp } from "./SecurityAudit";
import { normalizeEngineMode } from "./ValueCodecs";

export async function handleAdminConfig(
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
