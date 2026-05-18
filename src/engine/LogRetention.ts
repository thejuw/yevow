import type { Env } from "../types";

const DAY_MS = 86_400_000;

export const LOW_VALUE_OPERATIONAL_EVENT_TYPES = [
  "SYSTEM_INIT",
  "SYSTEM_HEARTBEAT",
  "CONFIG_REFRESHED",
  "CONFIG_REFRESH_SKIPPED",
  "STREAM_RECONNECT_ATTEMPT",
  "STREAM_RECOVERED",
  "STREAM_DISCONNECT",
  "STREAM_WATCHDOG_TIMEOUT",
  "DWELLIR_WATCHDOG_TIMEOUT",
  "MARKET_STREAM_HEARTBEAT",
  "TICK_TELEMETRY_AGGREGATE",
  "TELEMETRY",
  "PERFORMANCE_SAMPLE",
  "JANITOR_CLEANUP_REQUIRED"
] as const;

export interface LogRetentionPolicy {
  generatedAt: string;
  telemetryRetentionDays: number;
  lowValueRetentionDays: number;
  marketTickRetentionDays: number;
  maxTelemetryRows: number;
  maxOperationalInfoRows: number;
  maxMarketTickRows: number;
  telemetryCutoff: string;
  lowValueCutoff: string;
  marketTickCutoff: string;
}

export interface LogPruneReport {
  policy: LogRetentionPolicy;
  telemetryRows: number;
  lowValueOperationalRows: number;
  cappedOperationalInfoRows: number;
  marketTickRows: number;
  totalRows: number;
}

export type LogRetentionEnv = Pick<
  Env,
  | "JANITOR_LOG_RETENTION_DAYS"
  | "JANITOR_LOW_VALUE_LOG_RETENTION_DAYS"
  | "JANITOR_TELEMETRY_MAX_ROWS"
  | "JANITOR_OPERATIONAL_LOG_MAX_ROWS"
  | "MARKET_TICK_MAX_ROWS"
>;

export function resolveLogRetentionPolicy(
  env: LogRetentionEnv,
  nowMs = Date.now()
): LogRetentionPolicy {
  const telemetryRetentionDays = readPositiveInteger(env.JANITOR_LOG_RETENTION_DAYS, 3, 1, 3650);
  const lowValueRetentionDays = readPositiveInteger(
    env.JANITOR_LOW_VALUE_LOG_RETENTION_DAYS,
    Math.min(telemetryRetentionDays, 2),
    1,
    3650
  );
  const marketTickRetentionDays = telemetryRetentionDays;
  const maxTelemetryRows = readPositiveInteger(
    env.JANITOR_TELEMETRY_MAX_ROWS,
    15_000,
    1_000,
    1_000_000
  );
  const maxOperationalInfoRows = readPositiveInteger(
    env.JANITOR_OPERATIONAL_LOG_MAX_ROWS,
    50_000,
    5_000,
    2_000_000
  );
  const maxMarketTickRows = readPositiveInteger(env.MARKET_TICK_MAX_ROWS, 25_000, 1_000, 1_000_000);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    telemetryRetentionDays,
    lowValueRetentionDays,
    marketTickRetentionDays,
    maxTelemetryRows,
    maxOperationalInfoRows,
    maxMarketTickRows,
    telemetryCutoff: new Date(nowMs - telemetryRetentionDays * DAY_MS).toISOString(),
    lowValueCutoff: new Date(nowMs - lowValueRetentionDays * DAY_MS).toISOString(),
    marketTickCutoff: new Date(nowMs - marketTickRetentionDays * DAY_MS).toISOString()
  };
}

export function operationalEventPlaceholders(): string {
  return LOW_VALUE_OPERATIONAL_EVENT_TYPES.map(() => "?").join(", ");
}

function readPositiveInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number.parseInt(raw ?? "", 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}
