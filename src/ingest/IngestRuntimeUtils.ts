import type { Env, JsonRecord, MarketDataSource } from "../types";

export function heartbeatPayload(source: MarketDataSource): JsonRecord {
  if (source === "HYPERLIQUID") {
    return { method: "ping" };
  }

  return { type: "ping", ts: new Date().toISOString() };
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

export function websocketFetchUrl(url: string): string {
  if (url.startsWith("wss://")) {
    return `https://${url.slice("wss://".length)}`;
  }

  if (url.startsWith("ws://")) {
    return `http://${url.slice("ws://".length)}`;
  }

  return url;
}

export function isAuthorizedControlRequest(request: Request, env: Env): boolean {
  if (!env.INGESTOR_CONTROL_TOKEN) {
    return false;
  }

  const header = request.headers.get("authorization");
  return header === `Bearer ${env.INGESTOR_CONTROL_TOKEN}`;
}

export function calculateBackoffMs(
  backoffCounter: number,
  baseBackoffMs: number,
  maxBackoffMs: number
): number {
  const exponential = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, backoffCounter));
  const jitter = Math.floor(Math.random() * Math.min(baseBackoffMs, exponential));
  return Math.min(maxBackoffMs, exponential + jitter);
}

export function closeSocket(socket: WebSocket | null, code: number, reason: string): void {
  try {
    socket?.close(code, reason);
  } catch {
    // Closing is best-effort in Workers; stale sockets are discarded by the runtime.
  }
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, parsed));
}

export function readOptionalNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function booleanEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`MISSING_${field}`);
  }

  return value;
}

export function requireFiniteNumber(value: unknown, field: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`INVALID_${field.toUpperCase()}`);
  }

  return parsed;
}

export function finiteOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function finiteOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeString(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toUpperCase() : null;
}

export function stringifyOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function readResponseJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json<T>()) ?? null;
  } catch {
    return null;
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8"
    }
  });
}
