import { ConfigManager } from "../ConfigManager";
import type { Logger } from "../Logger";
import { StrategyVault } from "../StrategyVault";
import type { AdminConfigUpdate, EdgeTopology, Env, GlobalRiskConfig, JsonRecord } from "../types";
import type { AuthenticatedAdmin } from "./AdminModels";
import { routeToEngine } from "./GatewayEngineRouter";
import { json, readJsonBody } from "./ResponseHelpers";

export async function readStrategyVault(env: Env): Promise<Response> {
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

export async function createStrategyVersion(
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

export async function activateStrategyVersion(
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
