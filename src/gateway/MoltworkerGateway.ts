import type { Logger } from "../Logger";
import type { AuthenticatedAdmin } from "./AdminModels";
import type { EdgeTopology, Env, JsonRecord } from "../types";
import {
  DEFAULT_MOLTWORKER_HEARTBEAT_MAX_AGE_MS,
  MOLTWORKER_HEARTBEAT_KEY
} from "./GatewayConstants";
import { safeResponseJson } from "./AdminValidation";
import { json, readJsonBody } from "./ResponseHelpers";
import { sourceIp } from "./SecurityAudit";
import { finiteNumber, isJsonRecord } from "./ValueCodecs";

export async function evaluateMoltworkerHeartbeat(env: Env): Promise<{
  ok: boolean;
  status: "OPTIMAL" | "WARN" | "ANOMALY";
  detail: string;
  metadata: JsonRecord;
}> {
  if (!env.MOLTWORKER_HEALTH_URL) {
    return {
      ok: false,
      status: "WARN",
      detail:
        "MOLTWORKER_HEALTH_URL is not configured; supervisor heartbeat cannot be verified from the edge.",
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
    const runtime = typeof lastRunMetadata?.runtime === "string" ? lastRunMetadata.runtime : null;
    const source = typeof lastRunMetadata?.source === "string" ? lastRunMetadata.source : null;
    const supervisorOk = body?.ok !== false;

    return {
      ok: response.ok && supervisorOk,
      status: response.ok && supervisorOk ? "OPTIMAL" : "ANOMALY",
      detail:
        response.ok && supervisorOk
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

export async function readMoltworkerHealth(env: Env): Promise<Response> {
  const heartbeat = await env.CONFIG_STORE.get<JsonRecord>(MOLTWORKER_HEARTBEAT_KEY, "json");
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

export async function updateMoltworkerHeartbeat(
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

function moltworkerHeartbeatMaxAgeMs(env: Env): number {
  const parsed = Number(env.MOLTWORKER_HEARTBEAT_MAX_AGE_MS);
  return Number.isFinite(parsed) && parsed >= 30_000
    ? Math.round(parsed)
    : DEFAULT_MOLTWORKER_HEARTBEAT_MAX_AGE_MS;
}
