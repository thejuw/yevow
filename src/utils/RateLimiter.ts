export type RateLimitPriority = "CANCEL" | "HEDGE" | "NEW";

export interface RateLimitBucketSnapshot {
  capacity: number;
  tokens: number;
  refillPerMs: number;
  updatedAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, RateLimitBucketSnapshot>();

  configure(exchangeKey: string, capacity: number, refillPerSecond: number): void {
    this.buckets.set(exchangeKey, {
      capacity,
      tokens: capacity,
      refillPerMs: refillPerSecond / 1_000,
      updatedAt: Date.now()
    });
  }

  reserve(exchangeKey: string, priority: RateLimitPriority = "NEW"): {
    allowed: boolean;
    waitMs: number;
  } {
    const bucket = this.buckets.get(exchangeKey) ?? {
      capacity: 10,
      tokens: 10,
      refillPerMs: 10 / 1_000,
      updatedAt: Date.now()
    };
    this.refill(bucket);
    const cost = priority === "CANCEL" ? 0.25 : priority === "HEDGE" ? 0.5 : 1;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.buckets.set(exchangeKey, bucket);
      return { allowed: true, waitMs: 0 };
    }

    const waitMs = Math.ceil((cost - bucket.tokens) / bucket.refillPerMs);
    this.buckets.set(exchangeKey, bucket);
    return { allowed: false, waitMs };
  }

  snapshot(): Record<string, { tokens: number; capacity: number }> {
    return Object.fromEntries(
      [...this.buckets.entries()].map(([key, bucket]) => [
        key,
        { tokens: bucket.tokens, capacity: bucket.capacity }
      ])
    );
  }

  exportState(): Record<string, RateLimitBucketSnapshot> {
    return Object.fromEntries(
      [...this.buckets.entries()].map(([key, bucket]) => [key, { ...bucket }])
    );
  }

  hydrate(state: Record<string, RateLimitBucketSnapshot> | null | undefined): void {
    if (!state) {
      return;
    }

    this.buckets = new Map(
      Object.entries(state).filter(([, bucket]) => isValidBucket(bucket))
    );
  }

  private refill(bucket: RateLimitBucketSnapshot): void {
    const now = Date.now();
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
    bucket.updatedAt = now;
  }
}

function isValidBucket(
  bucket: RateLimitBucketSnapshot
): bucket is RateLimitBucketSnapshot {
  return (
    typeof bucket.capacity === "number" &&
    Number.isFinite(bucket.capacity) &&
    bucket.capacity > 0 &&
    typeof bucket.tokens === "number" &&
    Number.isFinite(bucket.tokens) &&
    typeof bucket.refillPerMs === "number" &&
    Number.isFinite(bucket.refillPerMs) &&
    bucket.refillPerMs > 0 &&
    typeof bucket.updatedAt === "number" &&
    Number.isFinite(bucket.updatedAt)
  );
}
