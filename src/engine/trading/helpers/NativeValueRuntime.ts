import type { MarketTick } from "../../../types";

export function isNativeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nativeObject(value: unknown): Record<string, unknown> | null {
  return isNativeRecord(value) ? value : null;
}

export function nativeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function requireNativeString(value: unknown, field: string): string {
  const parsed = nativeString(value);

  if (!parsed) {
    throw new Error(`MISSING_HYPERLIQUID_${field.toUpperCase()}`);
  }

  return parsed;
}

export function nativeIso(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function nativeExchangeTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(epochMillis(value)).toISOString();
  }

  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    const numeric = Number(trimmed);

    if (Number.isFinite(numeric)) {
      return new Date(epochMillis(numeric)).toISOString();
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  return null;
}

export function epochMillis(value: number): number {
  return value > 1_000_000_000_000 ? value : value * 1_000;
}

export function nativeNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nativeSequence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (Number.isSafeInteger(parsed) && parsed >= 0) {
    return parsed;
  }

  return nativeHashSequence(String(value ?? Date.now()));
}

export function nativeHashSequence(value: string): number {
  let hash = 2_166_136_261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

export function nativeSide(value: unknown): MarketTick["side"] {
  const side = nativeString(value)?.toUpperCase();

  if (side === "B" || side === "BUY" || side === "BID") {
    return "buy";
  }

  if (side === "A" || side === "ASK" || side === "SELL") {
    return "sell";
  }

  return "unknown";
}
