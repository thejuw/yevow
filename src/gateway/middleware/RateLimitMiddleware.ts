export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyExtractor: (request: Request, auth: { subject: string } | null) => string;
  lockoutMs?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  key: string;
  count: number;
  remaining: number;
  resetAt: string;
  retryAfterSeconds: number;
  locked: boolean;
}

export interface RateLimitStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CounterRecord {
  count: number;
  windowStartedAt: number;
  lockedUntil?: number;
}

export async function evaluateRateLimit(
  store: RateLimitStore,
  key: string,
  config: Omit<RateLimitConfig, "keyExtractor">,
  nowMs = Date.now()
): Promise<RateLimitDecision> {
  const record = parseCounter(await store.get(key));
  const windowMs = Math.max(1, Math.floor(config.windowMs));
  const maxRequests = Math.max(1, Math.floor(config.maxRequests));

  if (record?.lockedUntil && record.lockedUntil > nowMs) {
    return decision(key, record, maxRequests, record.lockedUntil, false, true, nowMs);
  }

  const windowExpired = !record || nowMs - record.windowStartedAt >= windowMs;
  const next: CounterRecord = windowExpired ? { count: 0, windowStartedAt: nowMs } : { ...record };

  next.count += 1;

  if (next.count > maxRequests) {
    next.lockedUntil =
      config.lockoutMs && config.lockoutMs > 0 ? nowMs + config.lockoutMs : undefined;
    await persistCounter(store, key, next, windowMs, config.lockoutMs);
    return decision(
      key,
      next,
      maxRequests,
      next.lockedUntil ?? next.windowStartedAt + windowMs,
      false,
      Boolean(next.lockedUntil),
      nowMs
    );
  }

  await persistCounter(store, key, next, windowMs, config.lockoutMs);
  return decision(key, next, maxRequests, next.windowStartedAt + windowMs, true, false, nowMs);
}

export function subjectRateLimitKey(prefix: string, subject: string): string {
  return `rate:${prefix}:subject:${subject}`;
}

export function ipRateLimitKey(prefix: string, request: Request): string {
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  return `rate:${prefix}:ip:${ip}`;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly values = new Map<string, { value: string; expiresAt: number | null }>();

  get(key: string): Promise<string | null> {
    const record = this.values.get(key);

    if (!record) {
      return Promise.resolve(null);
    }

    if (record.expiresAt !== null && record.expiresAt <= Date.now()) {
      this.values.delete(key);
      return Promise.resolve(null);
    }

    return Promise.resolve(record.value);
  }

  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = options?.expirationTtl
      ? Date.now() + Math.max(1, options.expirationTtl) * 1_000
      : null;
    this.values.set(key, { value, expiresAt });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

async function persistCounter(
  store: RateLimitStore,
  key: string,
  record: CounterRecord,
  windowMs: number,
  lockoutMs?: number
): Promise<void> {
  const ttlMs = Math.max(windowMs, lockoutMs ?? 0);
  await store.put(key, JSON.stringify(record), { expirationTtl: Math.ceil(ttlMs / 1_000) });
}

function decision(
  key: string,
  record: CounterRecord,
  maxRequests: number,
  resetAtMs: number,
  allowed: boolean,
  locked: boolean,
  nowMs: number
): RateLimitDecision {
  return {
    allowed,
    key,
    count: record.count,
    remaining: Math.max(0, maxRequests - record.count),
    resetAt: new Date(resetAtMs).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000)),
    locked
  };
}

function parseCounter(raw: string | null): CounterRecord | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<CounterRecord>;
    const count = Number(parsed.count);
    const windowStartedAt = Number(parsed.windowStartedAt);
    const lockedUntil = Number(parsed.lockedUntil);
    return {
      count: Number.isFinite(count) ? count : 0,
      windowStartedAt: Number.isFinite(windowStartedAt) ? windowStartedAt : Date.now(),
      lockedUntil: Number.isFinite(lockedUntil) ? lockedUntil : undefined
    };
  } catch {
    return null;
  }
}
