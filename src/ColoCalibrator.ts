import type { GlobalRiskConfig } from "./types";

const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_MIN_SAMPLES = 50;
const DEFAULT_MAX_COLOS = 3;
const DEFAULT_MIN_FRESH_RATE = 0.9;
const DEFAULT_P90_MULTIPLIER = 1;
const DEFAULT_P95_MULTIPLIER = 1.25;
const DEFAULT_ROW_LIMIT = 20_000;

interface ColoLatencyRow {
  created_at: string;
  colo: string | null;
  latency_ms: number | null;
  event_type: string;
}

export interface ColoCalibrationOptions {
  lookbackHours?: number;
  minSamples?: number;
  maxColos?: number;
  minFreshRate?: number;
  latencyThresholdMs?: number;
  p90Multiplier?: number;
  p95Multiplier?: number;
  rowLimit?: number;
}

export interface ColoScore {
  colo: string;
  samples: number;
  freshSamples: number;
  freshRate: number;
  staleRate: number;
  minLatencyMs: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p90LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  score: number;
  eligible: boolean;
  reason: string;
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface ColoCalibrationReport {
  ok: true;
  lookbackHours: number;
  latencyThresholdMs: number;
  minSamples: number;
  minFreshRate: number;
  p90LimitMs: number;
  p95LimitMs: number;
  rowLimit: number;
  generatedAt: string;
  observedRows: number;
  scoredColos: ColoScore[];
  recommendedGoldenColos: string[];
  recommendedGoldenColosCsv: string;
}

export async function calibrateGoldenColos(
  db: D1Database,
  config: GlobalRiskConfig,
  options: ColoCalibrationOptions = {}
): Promise<ColoCalibrationReport> {
  const now = Date.now();
  const lookbackHours = boundedInteger(
    options.lookbackHours,
    DEFAULT_LOOKBACK_HOURS,
    1,
    168
  );
  const minSamples = boundedInteger(options.minSamples, DEFAULT_MIN_SAMPLES, 1, 10_000);
  const maxColos = boundedInteger(options.maxColos, DEFAULT_MAX_COLOS, 1, 10);
  const minFreshRate = boundedNumber(
    options.minFreshRate,
    DEFAULT_MIN_FRESH_RATE,
    0,
    1
  );
  const latencyThresholdMs = boundedInteger(
    options.latencyThresholdMs,
    config.LATENCY_THRESHOLD_MS,
    1,
    60_000
  );
  const p90Multiplier = boundedNumber(
    options.p90Multiplier,
    DEFAULT_P90_MULTIPLIER,
    0.1,
    10
  );
  const p95Multiplier = boundedNumber(
    options.p95Multiplier,
    DEFAULT_P95_MULTIPLIER,
    0.1,
    10
  );
  const rowLimit = boundedInteger(options.rowLimit, DEFAULT_ROW_LIMIT, 100, 100_000);
  const since = new Date(now - lookbackHours * 60 * 60 * 1_000).toISOString();

  const result = await db
    .prepare(
      `SELECT
         created_at,
         COALESCE(
           json_extract(telemetry_json, '$.auditContext.colo'),
           json_extract(telemetry_json, '$.colo'),
           json_extract(telemetry_json, '$.location.colo'),
           json_extract(telemetry_json, '$.latestColo')
         ) AS colo,
         COALESCE(
           CAST(json_extract(telemetry_json, '$.totalLatencyMs') AS REAL),
           CAST(json_extract(telemetry_json, '$.averageTotalLatencyMs') AS REAL),
           CAST(json_extract(telemetry_json, '$.observedLatencyMs') AS REAL),
           CAST(json_extract(telemetry_json, '$.averageLatencyMs') AS REAL),
           CAST(json_extract(telemetry_json, '$.networkLatencyMs') AS REAL)
         ) AS latency_ms,
         event_type
       FROM logs
       WHERE created_at >= ?
         AND telemetry_json IS NOT NULL
         AND COALESCE(
           json_extract(telemetry_json, '$.auditContext.colo'),
           json_extract(telemetry_json, '$.colo'),
           json_extract(telemetry_json, '$.location.colo'),
           json_extract(telemetry_json, '$.latestColo')
         ) IS NOT NULL
         AND COALESCE(
           json_extract(telemetry_json, '$.totalLatencyMs'),
           json_extract(telemetry_json, '$.averageTotalLatencyMs'),
           json_extract(telemetry_json, '$.observedLatencyMs'),
           json_extract(telemetry_json, '$.averageLatencyMs'),
           json_extract(telemetry_json, '$.networkLatencyMs')
         ) IS NOT NULL
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(since, rowLimit)
    .all<ColoLatencyRow>();

  const buckets = new Map<string, Array<{ latencyMs: number; observedAt: string }>>();

  for (const row of result.results ?? []) {
    const colo = normalizeColo(row.colo);
    const latencyMs = finiteLatency(row.latency_ms);

    if (!colo || latencyMs === null) {
      continue;
    }

    const bucket = buckets.get(colo) ?? [];
    bucket.push({
      latencyMs,
      observedAt: row.created_at
    });
    buckets.set(colo, bucket);
  }

  const p90LimitMs = latencyThresholdMs * p90Multiplier;
  const p95LimitMs = latencyThresholdMs * p95Multiplier;
  const scoredColos = [...buckets.entries()]
    .map(([colo, samples]) =>
      scoreColo(colo, samples, {
        latencyThresholdMs,
        minSamples,
        minFreshRate,
        p90LimitMs,
        p95LimitMs
      })
    )
    .sort((a, b) => a.score - b.score || b.samples - a.samples);
  const recommendedGoldenColos = scoredColos
    .filter((score) => score.eligible)
    .slice(0, maxColos)
    .map((score) => score.colo);

  return {
    ok: true,
    lookbackHours,
    latencyThresholdMs,
    minSamples,
    minFreshRate,
    p90LimitMs,
    p95LimitMs,
    rowLimit,
    generatedAt: new Date(now).toISOString(),
    observedRows: result.results?.length ?? 0,
    scoredColos,
    recommendedGoldenColos,
    recommendedGoldenColosCsv: recommendedGoldenColos.join(",")
  };
}

function scoreColo(
  colo: string,
  samples: Array<{ latencyMs: number; observedAt: string }>,
  policy: {
    latencyThresholdMs: number;
    minSamples: number;
    minFreshRate: number;
    p90LimitMs: number;
    p95LimitMs: number;
  }
): ColoScore {
  const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const freshSamples = latencies.filter(
    (latencyMs) => latencyMs <= policy.latencyThresholdMs
  ).length;
  const averageLatencyMs =
    latencies.reduce((sum, latencyMs) => sum + latencyMs, 0) / latencies.length;
  const freshRate = freshSamples / latencies.length;
  const staleRate = 1 - freshRate;
  const p50LatencyMs = percentile(latencies, 0.5);
  const p90LatencyMs = percentile(latencies, 0.9);
  const p95LatencyMs = percentile(latencies, 0.95);
  const p99LatencyMs = percentile(latencies, 0.99);
  const reasons: string[] = [];

  if (latencies.length < policy.minSamples) {
    reasons.push("INSUFFICIENT_SAMPLES");
  }
  if (freshRate < policy.minFreshRate) {
    reasons.push("FRESH_RATE_BELOW_POLICY");
  }
  if (p90LatencyMs > policy.p90LimitMs) {
    reasons.push("P90_ABOVE_POLICY");
  }
  if (p95LatencyMs > policy.p95LimitMs) {
    reasons.push("P95_ABOVE_POLICY");
  }

  const score =
    p50LatencyMs * 0.35 +
    p90LatencyMs * 0.35 +
    p95LatencyMs * 0.2 +
    staleRate * policy.latencyThresholdMs * 2;

  return {
    colo,
    samples: latencies.length,
    freshSamples,
    freshRate: roundMetric(freshRate),
    staleRate: roundMetric(staleRate),
    minLatencyMs: roundMetric(latencies[0]),
    averageLatencyMs: roundMetric(averageLatencyMs),
    p50LatencyMs: roundMetric(p50LatencyMs),
    p90LatencyMs: roundMetric(p90LatencyMs),
    p95LatencyMs: roundMetric(p95LatencyMs),
    p99LatencyMs: roundMetric(p99LatencyMs),
    maxLatencyMs: roundMetric(latencies[latencies.length - 1]),
    score: roundMetric(score),
    eligible: reasons.length === 0,
    reason: reasons.length > 0 ? reasons.join(",") : "ELIGIBLE",
    firstObservedAt: samples
      .map((sample) => sample.observedAt)
      .sort((a, b) => a.localeCompare(b))[0],
    lastObservedAt: samples
      .map((sample) => sample.observedAt)
      .sort((a, b) => b.localeCompare(a))[0]
  };
}

function normalizeColo(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{3,4}$/.test(normalized) ? normalized : null;
}

function finiteLatency(value: number | null): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * percentileValue) - 1)
  );
  return values[index];
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.round(parsed)))
    : fallback;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
