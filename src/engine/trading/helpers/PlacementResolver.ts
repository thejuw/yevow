import type {
  EdgeTopology,
  EngineLocation,
  EngineState,
  Env,
  GlobalRiskConfig,
  JsonRecord,
  RiskLimits
} from "../../../types";

export const TOPOLOGY_HEADER_PREFIX = "x-sovereign-topology-";
const DEFAULT_HIGH_LATENCY_COLO_RISK_MULTIPLIER = 0.5;

export function placementColo(topology?: Partial<EdgeTopology> | null): string {
  const raw = placementCode(topology?.placement) ?? topology?.colo ?? "UNKNOWN";
  return normalizeColo(raw);
}

export function configuredPlacementColo(
  env: Pick<Env, "PLACEMENT_TARGET_COLO" | "GOLDEN_COLOS">
): string {
  const [firstGolden] = (env.GOLDEN_COLOS ?? "")
    .split(",")
    .map((colo) => normalizeColo(colo))
    .filter((colo) => colo !== "UNKNOWN");
  return normalizeColo(env.PLACEMENT_TARGET_COLO ?? firstGolden ?? "UNKNOWN");
}

export function configuredPlacementColoFromValue(value: string | undefined): string | null {
  const configured = value?.trim().toUpperCase();
  return configured && /^[A-Z0-9]{3,4}$/.test(configured) ? configured : null;
}

export function placementCode(placement: string | null | undefined): string | null {
  const match = /^(?:remote|local)-([a-z0-9]{3,4})$/i.exec(placement ?? "");
  return match?.[1]?.toUpperCase() ?? null;
}

export function isGoldenColo(
  topology: Partial<EdgeTopology> | null | undefined,
  env: Pick<Env, "GOLDEN_COLOS">
): boolean {
  const current = placementColo(topology);
  const golden = (env.GOLDEN_COLOS ?? "").split(",").map((colo) => normalizeColo(colo));
  return golden.includes(current);
}

export function parseColoSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((colo) => normalizeColo(colo))
      .filter((colo) => colo !== "UNKNOWN")
  );
}

export function defaultEngineLocation(): EngineLocation {
  return {
    colo: null,
    placement: null,
    country: null,
    city: null,
    region: null,
    timezone: null,
    latitude: null,
    longitude: null,
    lastSeenAt: null,
    isGoldenRegion: true,
    latencyRiskMultiplier: 1,
    positionSizeMultiplier: 1,
    observedLatencyMs: null,
    reason: "UNKNOWN_COLO"
  };
}

export function readTopologyHeaders(request: Request): EdgeTopology {
  const headers = request.headers;

  return {
    colo: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}colo`)),
    placement: normalizeTopologyHeader(
      headers.get(`${TOPOLOGY_HEADER_PREFIX}placement`) ?? headers.get("cf-placement")
    ),
    country: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}country`)),
    city: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}city`)),
    region: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}region`)),
    timezone: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}timezone`)),
    latitude: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}latitude`)),
    longitude: normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}longitude`)),
    requestId:
      normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}request-id`)) ??
      headers.get("cf-ray") ??
      crypto.randomUUID(),
    observedAt:
      normalizeTopologyHeader(headers.get(`${TOPOLOGY_HEADER_PREFIX}observed-at`)) ??
      new Date().toISOString()
  };
}

export function resolveEngineLocation(
  topology: EdgeTopology,
  previous: EngineLocation,
  env: Pick<Env, "PLACEMENT_TARGET_COLO" | "GOLDEN_COLOS" | "HIGH_LATENCY_COLO_RISK_MULTIPLIER">,
  config: Pick<GlobalRiskConfig, "GOLDEN_COLOS">,
  observedLatencyMs: number | null
): EngineLocation {
  const targetColo = configuredPlacementColoFromValue(env.PLACEMENT_TARGET_COLO);
  const observedColo =
    (placementCode(topology.placement) ?? topology.colo ?? targetColo)?.toUpperCase() ?? null;
  const colo = observedColo;
  const goldenColos = parseColoSet(config.GOLDEN_COLOS || env.GOLDEN_COLOS);
  const hasGoldenRegionPolicy = goldenColos.size > 0;
  const isGoldenRegion = !hasGoldenRegionPolicy || (colo !== null && goldenColos.has(colo));
  const latencyRiskMultiplier = isGoldenRegion
    ? 1
    : resolveRiskMultiplier(env.HIGH_LATENCY_COLO_RISK_MULTIPLIER);

  return {
    colo,
    placement: topology.placement ?? previous.placement,
    country: null,
    city: null,
    region: null,
    timezone: null,
    latitude: null,
    longitude: null,
    lastSeenAt: topology.observedAt,
    isGoldenRegion,
    latencyRiskMultiplier,
    positionSizeMultiplier: latencyRiskMultiplier,
    observedLatencyMs,
    reason:
      colo === null
        ? "UNKNOWN_COLO"
        : !placementCode(topology.placement) && !topology.colo && targetColo === colo
          ? "TARGET_COLO_ASSUMED"
          : isGoldenRegion
            ? "GOLDEN_REGION"
            : "NON_GOLDEN_REGION"
  };
}

export function applyLocationRisk(
  risk: RiskLimits,
  config: Pick<
    GlobalRiskConfig,
    "version" | "TRADING_ENABLED" | "MAX_POSITION_SIZE" | "MAX_DRAWDOWN_PCT"
  >,
  location: EngineLocation,
  updatedAt: string
): RiskLimits {
  return {
    ...risk,
    configVersion: config.version,
    killSwitch: !config.TRADING_ENABLED,
    maxOrderNotional: roundMetric(config.MAX_POSITION_SIZE * location.positionSizeMultiplier, 8),
    maxDrawdownPct: config.MAX_DRAWDOWN_PCT,
    updatedAt
  };
}

export interface TopologyObservationInput {
  readonly state: EngineState;
  readonly topology: EdgeTopology;
  readonly env: Pick<
    Env,
    "PLACEMENT_TARGET_COLO" | "GOLDEN_COLOS" | "HIGH_LATENCY_COLO_RISK_MULTIPLIER"
  >;
  readonly config: Pick<
    GlobalRiskConfig,
    "version" | "TRADING_ENABLED" | "MAX_POSITION_SIZE" | "MAX_DRAWDOWN_PCT" | "GOLDEN_COLOS"
  >;
}

export interface TopologyObservationResult {
  readonly state: EngineState;
  readonly previousLocation: EngineLocation;
  readonly nextLocation: EngineLocation;
  readonly changed: boolean;
  readonly placementChanged: boolean;
  readonly riskAdjustedForNonGoldenRegion: boolean;
}

export interface TopologyObservationLogInput {
  readonly observation: TopologyObservationResult;
  readonly maxOrderNotional: number;
  readonly baseMaxPositionSize: number;
}

export interface TopologyObservationLogEvent {
  readonly eventType: "COLO_TOPOLOGY_CHANGED" | "PIT_BOSS_RISK_ADJUSTED";
  readonly message: string;
  readonly metadata: JsonRecord;
}

export function stateAfterTopologyObservation(
  input: TopologyObservationInput
): TopologyObservationResult {
  const previousLocation = input.state.location;
  const nextLocation = resolveEngineLocation(
    input.topology,
    previousLocation,
    input.env,
    input.config,
    previousLocation.observedLatencyMs
  );
  const changed = locationChanged(previousLocation, nextLocation);

  return {
    previousLocation,
    nextLocation,
    changed,
    placementChanged:
      previousLocation.colo !== nextLocation.colo ||
      previousLocation.placement !== nextLocation.placement,
    riskAdjustedForNonGoldenRegion: changed && !nextLocation.isGoldenRegion,
    state: changed
      ? {
          ...input.state,
          location: nextLocation,
          risk: applyLocationRisk(
            input.state.risk,
            input.config,
            nextLocation,
            input.topology.observedAt
          ),
          updatedAt: input.topology.observedAt
        }
      : {
          ...input.state,
          location: nextLocation
        }
  };
}

export function buildTopologyObservationLogEvents(
  input: TopologyObservationLogInput
): TopologyObservationLogEvent[] {
  if (!input.observation.changed) {
    return [];
  }

  const events: TopologyObservationLogEvent[] = [];

  if (input.observation.placementChanged) {
    events.push({
      eventType: "COLO_TOPOLOGY_CHANGED",
      message: "Trading engine observed a Cloudflare placement change",
      metadata: locationTelemetry(input.observation.nextLocation)
    });
  }

  if (input.observation.riskAdjustedForNonGoldenRegion) {
    events.push({
      eventType: "PIT_BOSS_RISK_ADJUSTED",
      message: "Pit Boss reduced max order notional for execution-location risk",
      metadata: {
        ...locationTelemetry(input.observation.nextLocation),
        maxOrderNotional: input.maxOrderNotional,
        baseMaxPositionSize: input.baseMaxPositionSize
      }
    });
  }

  return events;
}

export interface LocationLatencyInput {
  readonly state: EngineState;
  readonly totalLatencyMs: number;
  readonly observedAt: string;
  readonly config: Pick<
    GlobalRiskConfig,
    "version" | "TRADING_ENABLED" | "MAX_POSITION_SIZE" | "MAX_DRAWDOWN_PCT"
  >;
}

export function stateAfterLocationLatency(input: LocationLatencyInput): EngineState {
  const location = {
    ...input.state.location,
    observedLatencyMs: roundMetric(input.totalLatencyMs, 3),
    lastSeenAt: input.observedAt
  };

  return {
    ...input.state,
    location,
    risk: applyLocationRisk(input.state.risk, input.config, location, input.observedAt)
  };
}

export function locationChanged(previous: EngineLocation, next: EngineLocation): boolean {
  return (
    previous.colo !== next.colo ||
    previous.placement !== next.placement ||
    previous.isGoldenRegion !== next.isGoldenRegion ||
    previous.latencyRiskMultiplier !== next.latencyRiskMultiplier ||
    previous.positionSizeMultiplier !== next.positionSizeMultiplier
  );
}

export function locationTelemetry(
  location: EngineLocation
): Record<string, string | number | boolean | null> {
  return {
    colo: location.colo,
    placement: location.placement,
    country: location.country,
    city: location.city,
    region: location.region,
    timezone: location.timezone,
    latitude: location.latitude,
    longitude: location.longitude,
    isGoldenRegion: location.isGoldenRegion,
    latencyRiskMultiplier: location.latencyRiskMultiplier,
    positionSizeMultiplier: location.positionSizeMultiplier,
    observedLatencyMs: location.observedLatencyMs,
    reason: location.reason,
    lastSeenAt: location.lastSeenAt
  };
}

export function resolveRiskMultiplier(value: string | undefined): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return DEFAULT_HIGH_LATENCY_COLO_RISK_MULTIPLIER;
  }

  return roundMetric(parsed, 4);
}

function normalizeTopologyHeader(value: string | null): string | null {
  return value && value.length > 0 ? value : null;
}

function roundMetric(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizeColo(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";

  if (!raw) {
    return "UNKNOWN";
  }

  return raw.includes("-") ? (raw.split("-").pop()?.toUpperCase() ?? "UNKNOWN") : raw.toUpperCase();
}
