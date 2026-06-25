import type { Env } from "../../types";
import type { DotCastReferencePrice, DotCastVenue, SideTotals } from "./types";

export interface DotCastRouterReferencePriceClientEnv {
  DOTCAST_ROUTER_REFERENCE_PRICE_URL?: string;
  DOTCAST_ROUTER_REFERENCE_PRICE_TOKEN?: string;
  DOTCAST_ROUTER_REFERENCE_PRICE_STALE_MS?: string;
}

export type DotCastReferencePriceFetchResult =
  | {
      kind: "reference";
      referencePrice: DotCastReferencePrice;
    }
  | {
      kind: "not_configured";
      error: string;
    }
  | {
      kind: "unavailable";
      error: string;
      status?: number;
    };

type ReferencePriceFetcher = typeof fetch;

export async function fetchDotCastReferencePrice(
  env: Pick<
    Env,
    | "DOTCAST_ROUTER_REFERENCE_PRICE_URL"
    | "DOTCAST_ROUTER_REFERENCE_PRICE_TOKEN"
    | "DOTCAST_ROUTER_REFERENCE_PRICE_STALE_MS"
  >,
  marketId: string,
  now: string,
  fetcher: ReferencePriceFetcher = fetch
): Promise<DotCastReferencePriceFetchResult> {
  const template = env.DOTCAST_ROUTER_REFERENCE_PRICE_URL?.trim();

  if (!template) {
    return {
      kind: "not_configured",
      error: "DOTCAST_ROUTER_REFERENCE_PRICE_URL is not configured"
    };
  }

  const response = await fetcher(buildReferencePriceUrl(template, marketId), {
    method: "GET",
    headers: {
      accept: "application/json",
      ...(env.DOTCAST_ROUTER_REFERENCE_PRICE_TOKEN
        ? {
            authorization: `Bearer ${env.DOTCAST_ROUTER_REFERENCE_PRICE_TOKEN}`,
            "x-api-key": env.DOTCAST_ROUTER_REFERENCE_PRICE_TOKEN
          }
        : {})
    }
  });

  if (!response.ok) {
    return {
      kind: "unavailable",
      status: response.status,
      error: `router reference price fetch failed with ${response.status}`
    };
  }

  const payload = await response.json();
  const candidate = extractMarketCandidate(payload);

  if (!candidate) {
    return {
      kind: "unavailable",
      error: "router reference price response did not include a market"
    };
  }

  return {
    kind: "reference",
    referencePrice: normalizeReferencePrice(
      candidate,
      marketId,
      now,
      parseOptionalNonNegativeInteger(
        env.DOTCAST_ROUTER_REFERENCE_PRICE_STALE_MS,
        "DOTCAST_ROUTER_REFERENCE_PRICE_STALE_MS"
      )
    )
  };
}

export function buildReferencePriceUrl(template: string, marketId: string): string {
  if (template.includes("{marketId}")) {
    return template.replaceAll("{marketId}", encodeURIComponent(marketId));
  }

  const url = new URL(template);
  url.searchParams.set("marketId", marketId);
  return url.toString();
}

function extractMarketCandidate(payload: unknown): Record<string, unknown> | null {
  if (payload === null) {
    return null;
  }

  if (!isRecord(payload)) {
    throw new Error("router reference price response must be an object or null");
  }

  if (isRecord(payload.market)) {
    return payload.market;
  }

  if (isRecord(payload.data) && isRecord(payload.data.market)) {
    return payload.data.market;
  }

  if (isRecord(payload.data)) {
    return payload.data;
  }

  return payload;
}

function normalizeReferencePrice(
  candidate: Record<string, unknown>,
  fallbackMarketId: string,
  now: string,
  staleAfterMs?: number
): DotCastReferencePrice {
  const marketId = parseString(
    candidate.id ?? candidate.marketId ?? candidate.market_id ?? fallbackMarketId,
    "id"
  );
  const venue = parseVenue(candidate.venue);
  const price = parsePrice(candidate.price);
  const lastUpdated = parseString(
    candidate.lastUpdated ??
      candidate.last_updated ??
      candidate.updatedAt ??
      candidate.updated_at ??
      now,
    "lastUpdated"
  );
  const routerStale = parseBoolean(candidate.stale, false);
  const ageStale =
    staleAfterMs !== undefined ? Date.parse(now) - Date.parse(lastUpdated) > staleAfterMs : false;

  return {
    marketId,
    venue,
    price,
    lastUpdated,
    stale: routerStale || ageStale,
    sourceLabel: parseOptionalString(candidate.sourceLabel ?? candidate.source_label) ?? venue,
    referenceUrl: parseNullableString(
      candidate.referenceUrl ??
        candidate.reference_url ??
        candidate.url ??
        candidate.marketUrl ??
        candidate.market_url,
      "referenceUrl"
    ),
    fetchedAt: now
  };
}

function parsePrice(value: unknown): SideTotals {
  const price = isRecord(value) ? value : null;

  if (!price) {
    throw new Error("router reference price must include a price object");
  }

  return {
    yes: parseProbability(price.yes, "price.yes"),
    no: parseProbability(price.no, "price.no")
  };
}

function parseProbability(value: unknown, label: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;

  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new Error(`router reference ${label} must be a number`);
  }

  return Math.min(1, Math.max(0, parsed));
}

function parseVenue(value: unknown): DotCastVenue {
  if (value === "kalshi" || value === "polymarket" || value === "dotcast" || value === "unknown") {
    return value;
  }

  throw new Error("router reference venue must be a supported venue");
}

function parseString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new Error(`router reference ${label} must be a non-empty string`);
}

function parseOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return parseString(value, "optional string");
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

  throw new Error("router reference stale must be a boolean");
}

function parseOptionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = typeof value === "string" ? Number(value) : value;

  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
