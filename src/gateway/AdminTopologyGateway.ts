import { calibrateGoldenColos, type ColoCalibrationOptions } from "../ColoCalibrator";
import { ConfigManager } from "../ConfigManager";
import type { Logger } from "../Logger";
import type { AdminConfigUpdate, EdgeTopology, Env, GlobalRiskConfig, JsonRecord } from "../types";
import type { AuthenticatedAdmin } from "./AdminModels";
import { routeToEngine } from "./GatewayEngineRouter";
import { json, readJsonBody } from "./ResponseHelpers";
import { numberOption } from "./ValueCodecs";

export async function handleTopologyCalibration(
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
