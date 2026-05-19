import type { EdgeTopology, Env, JsonRecord } from "../types";

const TOPOLOGY_HEADER_PREFIX = "x-sovereign-topology-";

interface CloudflareRequestMetadata {
  colo?: unknown;
  country?: unknown;
  city?: unknown;
  region?: unknown;
  timezone?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

export function extractEdgeTopology(request: Request, env: Env): EdgeTopology {
  const cf = (request as Request & { cf?: CloudflareRequestMetadata }).cf;
  const placement =
    nullableHeader(request.headers.get("cf-placement")) ??
    configuredPlacementFallback(env.PLACEMENT_TARGET_COLO);

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

export function placementColo(placement: string | null): string | null {
  const match = /^(?:remote|local)-([a-z0-9]{3,4})$/i.exec(placement ?? "");
  return match?.[1]?.toUpperCase() ?? null;
}

export function withTopologyHeaders(
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

export function topologyTelemetry(topology: EdgeTopology): JsonRecord {
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

function configuredPlacementFallback(targetColo: string | undefined): string | null {
  const normalized = targetColo?.trim().toUpperCase();
  return normalized && /^[A-Z0-9]{3,4}$/.test(normalized) ? `remote-${normalized}` : null;
}

function setTopologyHeader(headers: Headers, key: string, value: string | null): void {
  if (value !== null) {
    headers.set(`${TOPOLOGY_HEADER_PREFIX}${key}`, value);
  }
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
