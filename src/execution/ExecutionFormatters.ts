export function snapPrice(value: number, tickSize: number, side: "BUY" | "SELL"): number {
  return side === "BUY" ? floorToIncrement(value, tickSize) : ceilToIncrement(value, tickSize);
}

export function floorToIncrement(value: number, increment: number): number {
  const precision = decimalPlaces(increment);
  return Number((Math.floor((value + Number.EPSILON) / increment) * increment).toFixed(precision));
}

export function ceilToIncrement(value: number, increment: number): number {
  const precision = decimalPlaces(increment);
  return Number((Math.ceil((value - Number.EPSILON) / increment) * increment).toFixed(precision));
}

export function formatDecimal(value: number, precision: number): string {
  const fixed = value.toFixed(Math.max(0, Math.min(12, precision)));
  const compact = fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
  return compact.length > 0 ? compact : "0";
}

export function decimalPlaces(value: unknown): number {
  const text = String(value ?? "");

  if (text.includes("e-")) {
    const exponent = Number(text.split("e-")[1]);
    return Number.isFinite(exponent) ? exponent : 8;
  }

  const [, decimals = ""] = text.split(".");
  return decimals.replace(/0+$/, "").length;
}

export function positive(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`INVALID_${field}`);
  }
  return parsed;
}

export function positiveOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function positiveNumberOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function roundLatency(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function shortHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function maskAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : "configured";
}
