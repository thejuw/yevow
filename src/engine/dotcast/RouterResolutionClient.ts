import type { Env } from "../../types";
import type { DotCastResolutionOutcome, DotCastRouterResolution, DotCastVenue } from "./types";

export interface DotCastRouterResolutionClientEnv {
  DOTCAST_ROUTER_RESOLUTION_URL?: string;
  DOTCAST_ROUTER_RESOLUTION_TOKEN?: string;
}

export type DotCastRouterResolutionFetchResult =
  | {
      kind: "resolution";
      resolution: DotCastRouterResolution;
    }
  | {
      kind: "pending";
      resolution: DotCastRouterResolution;
    }
  | {
      kind: "not_configured";
      error: string;
    };

type ResolutionFetcher = typeof fetch;

export async function fetchDotCastRouterResolution(
  env: Pick<Env, "DOTCAST_ROUTER_RESOLUTION_URL" | "DOTCAST_ROUTER_RESOLUTION_TOKEN">,
  marketId: string,
  now: string,
  fetcher: ResolutionFetcher = fetch
): Promise<DotCastRouterResolutionFetchResult> {
  const template = env.DOTCAST_ROUTER_RESOLUTION_URL?.trim();

  if (!template) {
    return {
      kind: "not_configured",
      error: "DOTCAST_ROUTER_RESOLUTION_URL is not configured"
    };
  }

  const response = await fetcher(buildResolutionUrl(template, marketId), {
    method: "GET",
    headers: {
      accept: "application/json",
      ...(env.DOTCAST_ROUTER_RESOLUTION_TOKEN
        ? { authorization: `Bearer ${env.DOTCAST_ROUTER_RESOLUTION_TOKEN}` }
        : {})
    }
  });

  if (!response.ok) {
    throw new Error(`router resolution fetch failed with ${response.status}`);
  }

  const payload = await response.json();
  const candidate = extractResolutionCandidate(payload);

  if (!candidate) {
    return {
      kind: "pending",
      resolution: pendingResolution(marketId, now)
    };
  }

  const resolution = normalizeRouterResolution(candidate, marketId, now);

  return {
    kind: resolution.outcome === "pending" ? "pending" : "resolution",
    resolution
  };
}

export function buildResolutionUrl(template: string, marketId: string): string {
  if (template.includes("{marketId}")) {
    return template.replaceAll("{marketId}", encodeURIComponent(marketId));
  }

  const url = new URL(template);
  url.searchParams.set("marketId", marketId);
  return url.toString();
}

function extractResolutionCandidate(payload: unknown): Record<string, unknown> | null {
  if (payload === null) {
    return null;
  }

  if (!isRecord(payload)) {
    throw new Error("router resolution response must be an object or null");
  }

  if (payload.resolution === null) {
    return null;
  }

  if (isRecord(payload.resolution)) {
    return payload.resolution;
  }

  if (isRecord(payload.data) && payload.data.resolution === null) {
    return null;
  }

  if (isRecord(payload.data) && isRecord(payload.data.resolution)) {
    return payload.data.resolution;
  }

  return payload;
}

function normalizeRouterResolution(
  candidate: Record<string, unknown>,
  fallbackMarketId: string,
  now: string
): DotCastRouterResolution {
  return {
    marketId: parseString(
      candidate.marketId ?? candidate.market_id ?? fallbackMarketId,
      "marketId"
    ),
    outcome: parseOutcome(candidate.outcome),
    resolvedAt: parseNullableString(candidate.resolvedAt ?? candidate.resolved_at, "resolvedAt"),
    fetchedAt: parseString(candidate.fetchedAt ?? candidate.fetched_at ?? now, "fetchedAt"),
    stale: parseBoolean(candidate.stale, false),
    source: parseOptionalVenue(candidate.source ?? candidate.venue)
  };
}

function pendingResolution(marketId: string, now: string): DotCastRouterResolution {
  return {
    marketId,
    outcome: "pending",
    resolvedAt: null,
    fetchedAt: now,
    stale: false
  };
}

function parseOutcome(value: unknown): DotCastResolutionOutcome {
  if (value === "yes" || value === "no" || value === "invalid" || value === "pending") {
    return value;
  }

  throw new Error("router resolution outcome must be yes, no, invalid, or pending");
}

function parseOptionalVenue(value: unknown): DotCastVenue | undefined {
  if (value === "kalshi" || value === "polymarket" || value === "dotcast" || value === "unknown") {
    return value;
  }

  if (value === undefined || value === null) {
    return undefined;
  }

  throw new Error("router resolution source must be a supported venue");
}

function parseString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error(`router resolution ${label} must be a non-empty string`);
}

function parseNullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return parseString(value, label);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  throw new Error("router resolution stale must be a boolean");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
