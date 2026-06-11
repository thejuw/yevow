import type { DateRangeFilter } from "./AdminModels";
import type { JsonRecord, JsonValue } from "../types";

export function clampInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAsset(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9._:-]{1,64}$/.test(normalized) ? normalized : null;
}

export function normalizeEngineMode(value: unknown): "PAPER" | "LIVE" | "HALTED" | null {
  if (value !== "PAPER" && value !== "LIVE" && value !== "HALTED") {
    return null;
  }

  return value;
}

export function normalizeEnum<T extends string>(
  value: string | null,
  allowed: readonly T[]
): T | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return allowed.includes(normalized as T) ? (normalized as T) : null;
}

export function nullableRound(
  value: number | null | undefined,
  decimalPlaces: number
): number | null {
  return typeof value === "number" && Number.isFinite(value) ? round(value, decimalPlaces) : null;
}

export function numberOption(bodyValue: unknown, queryValue: string | null): number | undefined {
  const candidate = bodyValue ?? queryValue;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function pagination(page: number, limit: number, total: number): JsonRecord {
  const pageCount = Math.ceil(total / limit);

  return {
    page,
    limit,
    total,
    pageCount,
    hasNextPage: page < pageCount,
    hasPreviousPage: page > 1
  };
}

export function parseDateRange(url: URL): DateRangeFilter {
  const compactRange = url.searchParams.get("date_range") ?? url.searchParams.get("dateRange");
  const [rangeFrom, rangeTo] = compactRange?.split(/[|,]/, 2) ?? [];
  const from =
    normalizeIsoDate(url.searchParams.get("from")) ??
    normalizeIsoDate(url.searchParams.get("start")) ??
    normalizeIsoDate(url.searchParams.get("date_from")) ??
    normalizeIsoDate(rangeFrom);
  const to =
    normalizeIsoDate(url.searchParams.get("to")) ??
    normalizeIsoDate(url.searchParams.get("end")) ??
    normalizeIsoDate(url.searchParams.get("date_to")) ??
    normalizeIsoDate(rangeTo);

  return { from, to };
}

export function parseJsonRecord(value: string | null): JsonRecord | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseJsonValue(value: string | undefined): JsonValue | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

export function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readNumberField(record: JsonRecord | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

export function readString(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function round(value: number, decimalPlaces: number): number {
  const scale = 10 ** decimalPlaces;
  return Math.round(value * scale) / scale;
}

export function stringNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeIsoDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
