import type {
  AdminStateResponse,
  AttributionResponse,
  GlobalRiskConfig,
  LoginResponse,
  MacroBiasDirection,
  TemporaryGovernanceOverride,
  TraceResponse
} from "./types";

export const DEFAULT_API_BASE =
  process.env.NEXT_PUBLIC_SOVEREIGN_API_BASE ?? "https://api.yevow.co";

export class SovereignApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export function normalizeApiBase(value: string): string {
  return value.replace(/\/+$/, "");
}

export function toWebSocketUrl(apiBase: string, token: string): string {
  const base = normalizeApiBase(apiBase);
  const url = new URL(`${base}/admin/stream`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("access_token", token);
  return url.toString();
}

export async function login(apiBase: string, password: string): Promise<LoginResponse> {
  return apiFetch<LoginResponse>(apiBase, "/login", "", {
    method: "POST",
    body: JSON.stringify({
      password,
      subject: "command-center",
      scopes: ["READ", "WRITE"]
    })
  });
}

export async function readState(apiBase: string, token: string): Promise<AdminStateResponse> {
  return apiFetch<AdminStateResponse>(apiBase, "/admin/state", token);
}

export async function readConfig(apiBase: string, token: string): Promise<{ ok: true; config: GlobalRiskConfig }> {
  return apiFetch<{ ok: true; config: GlobalRiskConfig }>(apiBase, "/admin/config", token);
}

export async function readTrace(apiBase: string, token: string): Promise<TraceResponse> {
  return apiFetch<TraceResponse>(apiBase, "/admin/trace?limit=50", token);
}

export async function readAttribution(apiBase: string, token: string): Promise<AttributionResponse> {
  return apiFetch<AttributionResponse>(apiBase, "/admin/attribution?limit=1000", token);
}

export async function updateConfig(
  apiBase: string,
  token: string,
  config: Partial<GlobalRiskConfig>
): Promise<unknown> {
  return apiFetch(apiBase, "/admin/config", token, {
    method: "POST",
    body: JSON.stringify({
      confirmHighImpact: true,
      config
    })
  });
}

export async function injectMoltworkerIntent(
  apiBase: string,
  token: string,
  payload: {
    direction: MacroBiasDirection;
    intensity: number;
    confidence: number;
    reason: string;
    durationMinutes: number;
    governanceMode: "MANUAL" | "AUTONOMOUS" | "HYBRID";
    manualSkepticism: number;
    maxSkepticism: number;
  }
): Promise<unknown> {
  return apiFetch(apiBase, "/admin/config", token, {
    method: "POST",
    body: JSON.stringify({
      actor: "moltworker",
      macroBias: {
        direction: payload.direction,
        intensity: payload.intensity,
        confidence: payload.confidence,
        reason: payload.reason,
        durationMinutes: payload.durationMinutes,
        source: "MOLTWORKER"
      },
      temporaryOverride: {
        source: "MOLTWORKER",
        reason: payload.reason,
        durationMinutes: payload.durationMinutes,
        ORACLE_GOVERNANCE_MODE: payload.governanceMode,
        ORACLE_MANUAL_SKEPTICISM: payload.manualSkepticism,
        ORACLE_MAX_SKEPTICISM: payload.maxSkepticism
      }
    })
  });
}

export async function clearOverride(
  apiBase: string,
  token: string,
  override: TemporaryGovernanceOverride | null
): Promise<unknown> {
  if (!override) {
    return null;
  }

  return apiFetch(apiBase, "/admin/config", token, {
    method: "POST",
    body: JSON.stringify({
      actor: "command-center",
      clearTemporaryOverride: true
    })
  });
}

export async function resetLatencyBaseline(
  apiBase: string,
  token: string
): Promise<unknown> {
  return apiFetch(apiBase, "/admin/maintenance/reset-latency", token, {
    method: "POST",
    body: JSON.stringify({})
  });
}

async function apiFetch<T>(
  apiBase: string,
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${normalizeApiBase(apiBase)}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new SovereignApiError(body?.error ?? `HTTP_${response.status}`, response.status);
  }

  return body as T;
}
