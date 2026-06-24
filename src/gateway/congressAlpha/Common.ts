import type { JsonRecord } from "../../types";

export const DEFAULT_BANKROLL_USD = 10_000;
export const DEFAULT_MAX_POSITIONS = 10;
export const DEFAULT_MIN_SCORE = 35;
export const DEFAULT_MAX_WEIGHT_PCT = 10;
export const DEFAULT_LOOKBACK_DAYS = 180;
export const MIN_REBALANCE_NOTIONAL_USD = 25;
export const STORED_SIGNAL_LIMIT = 75;
export const PAPER_MODE = "PAPER_ONLY";
export const SETTINGS_KEY = "default";
export const DEFAULT_SCHEDULER_TIMEZONE = "America/Chicago";

export function envNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clampPositive(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return clamp(base, min, max);
}

export function nonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function parseJsonRecord(value: string | null): JsonRecord {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch {
    return {};
  }
}

export function emptyD1Result<T>(): Promise<D1Result<T>> {
  return Promise.resolve({ results: [] } as unknown as D1Result<T>);
}

export function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
