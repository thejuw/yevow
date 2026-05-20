export function highResolutionNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function parseTimestampMs(value: string, field: string): number {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`INVALID_${field.toUpperCase()}`);
  }

  return parsed;
}

export function roundLatency(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
