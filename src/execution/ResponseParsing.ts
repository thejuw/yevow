export async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = await response.json<unknown>();
    if (Array.isArray(body)) {
      return { data: body };
    }
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

export function stringField(
  value: Record<string, unknown> | null,
  keys: string[]
): string | undefined {
  if (!value) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }

  return undefined;
}

export function numberField(
  value: Record<string, unknown> | null,
  keys: string[]
): number | undefined {
  if (!value) {
    return undefined;
  }

  for (const key of keys) {
    const parsed = Number(value[key]);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

export function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`MISSING_${field.toUpperCase()}`);
  }

  return value;
}

export function requireEndpoint(value: string | undefined, field: string): string {
  if (!value) {
    throw new Error(`MISSING_${field}`);
  }

  return value;
}
