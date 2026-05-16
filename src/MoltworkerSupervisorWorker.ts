import type { JsonRecord } from "./types";

const SUPERVISOR_STATUS_KEY = "moltworker:supervisor:last";
const DEFAULT_GATEWAY_URL = "https://api.yevow.co";
const DEFAULT_REQUEST_TIMEOUT_MS = 2_500;
const DEFAULT_SUPERVISOR_MAX_AGE_MS = 180_000;
const DEFAULT_STATUS_TTL_SECONDS = 900;

interface SupervisorEnv {
  CONFIG_STORE: KVNamespace;
  MOLTWORKER_GATEWAY_URL?: string;
  MOLTWORKER_ADMIN_PASSWORD?: string;
  ADMIN_PASSWORD?: string;
  MOLTWORKER_SUBJECT?: string;
  MOLTWORKER_MODE?: string;
  MOLTWORKER_STRATEGIC_INTENT?: string;
  MOLTWORKER_RUNTIME?: string;
  MOLTWORKER_SUPERVISOR_DIRECTORY?: string;
  MOLTWORKER_REQUEST_TIMEOUT_MS?: string;
  MOLTWORKER_SUPERVISOR_MAX_AGE_MS?: string;
  MOLTWORKER_HEARTBEAT_STATUS_TTL_SECONDS?: string;
  MOLTWORKER_RUN_TOKEN?: string;
}

interface SupervisorRunResult extends JsonRecord {
  ok: boolean;
  status: "OK" | "ERROR";
  observedAt: string;
  trigger: string;
  gatewayUrl: string;
  loginStatus: number | null;
  heartbeatStatus: number | null;
  latencyMs: number;
  error: string | null;
}

export default {
  async fetch(
    request: Request,
    env: SupervisorEnv,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsPreflight();
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return readSupervisorHealth(env);
    }

    if (request.method === "POST" && url.pathname === "/run") {
      if (!(await isAuthorizedManualRun(request, env))) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }

      const result = await runSupervisorLoop(env, "manual");
      ctx.waitUntil(Promise.resolve());
      return json(result, result.ok ? 200 : 503);
    }

    return json({
      ok: true,
      service: "sovereign-sigma-moltworker",
      routes: ["GET /health", "POST /run (Bearer MOLTWORKER_RUN_TOKEN)"]
    });
  },

  async scheduled(
    controller: ScheduledController,
    env: SupervisorEnv,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      runSupervisorLoop(env, `cron:${controller.cron}`)
        .then((result) => {
          if (!result.ok) {
            console.error("MOLTWORKER_SUPERVISOR_LOOP_FAILED", result);
          }
        })
        .catch((error) => {
          console.error("MOLTWORKER_SUPERVISOR_LOOP_CRASHED", {
            error: error instanceof Error ? error.message : "UNKNOWN_ERROR"
          });
        })
    );
  }
} satisfies ExportedHandler<SupervisorEnv>;

async function runSupervisorLoop(
  env: SupervisorEnv,
  trigger: string
): Promise<SupervisorRunResult> {
  const startedAt = performance.now();
  const observedAt = new Date().toISOString();
  const gatewayUrl = normalizedGatewayUrl(env.MOLTWORKER_GATEWAY_URL);
  const password = env.MOLTWORKER_ADMIN_PASSWORD ?? env.ADMIN_PASSWORD;

  if (!password) {
    return writeSupervisorStatus(env, {
      ok: false,
      status: "ERROR",
      observedAt,
      trigger,
      gatewayUrl,
      loginStatus: null,
      heartbeatStatus: null,
      latencyMs: elapsedMs(startedAt),
      error: "MOLTWORKER_ADMIN_PASSWORD_NOT_CONFIGURED"
    });
  }

  const login = await fetchJson<{
    ok?: boolean;
    token?: string;
    expiresIn?: number;
  }>(
    `${gatewayUrl}/login`,
    env,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password,
        subject: env.MOLTWORKER_SUBJECT ?? "moltworker-supervisor",
        scopes: ["READ", "WRITE"]
      })
    },
    "LOGIN_FAILED"
  );

  if (!login.response.ok || !login.body?.token) {
    return writeSupervisorStatus(env, {
      ok: false,
      status: "ERROR",
      observedAt,
      trigger,
      gatewayUrl,
      loginStatus: login.response.status,
      heartbeatStatus: null,
      latencyMs: elapsedMs(startedAt),
      error: login.error ?? "MOLTWORKER_LOGIN_REJECTED"
    });
  }

  const heartbeat = await fetchJson<JsonRecord>(
    `${gatewayUrl}/admin/moltworker/heartbeat`,
    env,
    {
      method: "POST",
      headers: {
        "authorization": `Bearer ${login.body.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        status: "OK",
        mode: env.MOLTWORKER_MODE ?? "AUTONOMOUS",
        strategicIntent:
          env.MOLTWORKER_STRATEGIC_INTENT ??
          "Continuous external supervisor heartbeat and integrity watch.",
        metadata: {
          source: "sovereign-sigma-moltworker",
          runtime: env.MOLTWORKER_RUNTIME ?? "cloudflare-worker-supervisor",
          supervisorDirectory: env.MOLTWORKER_SUPERVISOR_DIRECTORY ?? null,
          trigger,
          tokenExpiresIn: login.body.expiresIn ?? null
        }
      })
    },
    "HEARTBEAT_POST_FAILED"
  );

  return writeSupervisorStatus(env, {
    ok: heartbeat.response.ok,
    status: heartbeat.response.ok ? "OK" : "ERROR",
    observedAt,
    trigger,
    gatewayUrl,
    loginStatus: login.response.status,
    heartbeatStatus: heartbeat.response.status,
    latencyMs: elapsedMs(startedAt),
    error: heartbeat.response.ok ? null : heartbeat.error ?? "HEARTBEAT_REJECTED"
  });
}

async function readSupervisorHealth(env: SupervisorEnv): Promise<Response> {
  const status = await env.CONFIG_STORE.get<SupervisorRunResult>(
    SUPERVISOR_STATUS_KEY,
    "json"
  );
  const maxAgeMs = readPositiveInteger(
    env.MOLTWORKER_SUPERVISOR_MAX_AGE_MS,
    DEFAULT_SUPERVISOR_MAX_AGE_MS,
    30_000,
    900_000
  );

  if (!status) {
    return json(
      {
        ok: false,
        service: "sovereign-sigma-moltworker",
        status: "MISSING_STATUS",
        detail: "Moltworker supervisor loop has not reported yet.",
        maxAgeMs
      },
      503
    );
  }

  const observedAtMs = Date.parse(status.observedAt);
  const ageMs = Number.isFinite(observedAtMs)
    ? Date.now() - observedAtMs
    : Number.POSITIVE_INFINITY;
  const ok = status.ok && ageMs <= maxAgeMs;

  return json(
    {
      ok,
      service: "sovereign-sigma-moltworker",
      status: ok ? "OK" : "STALE",
      detail: ok
        ? `Supervisor loop is fresh (${Math.max(0, Math.round(ageMs))}ms old).`
        : `Supervisor loop is stale or unhealthy (${Math.round(ageMs)}ms old).`,
      ageMs: Math.round(ageMs),
      maxAgeMs,
      lastRun: status
    },
    ok ? 200 : 503
  );
}

async function writeSupervisorStatus(
  env: SupervisorEnv,
  status: SupervisorRunResult
): Promise<SupervisorRunResult> {
  const ttl = readPositiveInteger(
    env.MOLTWORKER_HEARTBEAT_STATUS_TTL_SECONDS,
    DEFAULT_STATUS_TTL_SECONDS,
    300,
    86_400
  );

  await env.CONFIG_STORE.put(SUPERVISOR_STATUS_KEY, JSON.stringify(status), {
    expirationTtl: ttl
  });

  return status;
}

async function fetchJson<T extends JsonRecord>(
  url: string,
  env: SupervisorEnv,
  init: RequestInit,
  fallbackError: string
): Promise<{
  response: Response;
  body: T | null;
  error: string | null;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("MOLTWORKER_REQUEST_TIMEOUT"),
    readPositiveInteger(
      env.MOLTWORKER_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      500,
      15_000
    )
  );

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(init.headers ?? {})
      }
    });
    const text = await response.text();
    const parsed = text.length > 0 ? safeJsonParse<T>(text) : null;

    return {
      response,
      body: parsed,
      error:
        response.ok
          ? null
          : typeof parsed?.error === "string"
            ? parsed.error
            : fallbackError
    };
  } catch (error) {
    return {
      response: new Response(null, { status: 599 }),
      body: null,
      error: error instanceof Error ? error.message : fallbackError
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function isAuthorizedManualRun(
  request: Request,
  env: SupervisorEnv
): Promise<boolean> {
  if (!env.MOLTWORKER_RUN_TOKEN) {
    return false;
  }

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return constantTimeEqual(token, env.MOLTWORKER_RUN_TOKEN);
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const leftHash = await crypto.subtle.digest("SHA-256", encoder.encode(left));
  const rightHash = await crypto.subtle.digest("SHA-256", encoder.encode(right));
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let diff = left.length ^ right.length;

  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }

  return diff === 0;
}

function safeJsonParse<T extends JsonRecord>(text: string): T | null {
  try {
    const parsed = JSON.parse(text);
    return isJsonRecord(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedGatewayUrl(value: string | undefined): string {
  return (value ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1000) / 1000;
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.round(parsed)))
    : fallback;
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
      "cache-control": "no-store",
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

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type"
  };
}
