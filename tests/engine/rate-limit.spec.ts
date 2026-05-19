import { describe, expect, it } from "vitest";
import {
  MemoryRateLimitStore,
  evaluateRateLimit,
  ipRateLimitKey,
  subjectRateLimitKey
} from "../../src/gateway/middleware/RateLimitMiddleware";

describe("gateway rate limiting", () => {
  it("allows requests under the limit", async () => {
    const store = new MemoryRateLimitStore();
    const decision = await evaluateRateLimit(store, "k", { windowMs: 1_000, maxRequests: 2 }, 0);

    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(1);
  });

  it("blocks requests above the limit", async () => {
    const store = new MemoryRateLimitStore();
    await evaluateRateLimit(store, "k", { windowMs: 1_000, maxRequests: 1 }, 0);
    const blocked = await evaluateRateLimit(store, "k", { windowMs: 1_000, maxRequests: 1 }, 10);

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
  });

  it("rolls windows forward", async () => {
    const store = new MemoryRateLimitStore();
    await evaluateRateLimit(store, "k", { windowMs: 1_000, maxRequests: 1 }, 0);
    const decision = await evaluateRateLimit(
      store,
      "k",
      { windowMs: 1_000, maxRequests: 1 },
      1_001
    );

    expect(decision.allowed).toBe(true);
    expect(decision.count).toBe(1);
  });

  it("locks out when configured", async () => {
    const store = new MemoryRateLimitStore();
    await evaluateRateLimit(store, "k", { windowMs: 1_000, maxRequests: 1, lockoutMs: 9_000 }, 0);
    const blocked = await evaluateRateLimit(
      store,
      "k",
      { windowMs: 1_000, maxRequests: 1, lockoutMs: 9_000 },
      1
    );

    expect(blocked.locked).toBe(true);
    expect(blocked.retryAfterSeconds).toBe(9);
  });

  it("keeps lockout active after the short window expires", async () => {
    const store = new MemoryRateLimitStore();
    await evaluateRateLimit(store, "k", { windowMs: 1_000, maxRequests: 1, lockoutMs: 9_000 }, 0);
    await evaluateRateLimit(store, "k", { windowMs: 1_000, maxRequests: 1, lockoutMs: 9_000 }, 1);
    const blocked = await evaluateRateLimit(
      store,
      "k",
      { windowMs: 1_000, maxRequests: 1, lockoutMs: 9_000 },
      2_000
    );

    expect(blocked.allowed).toBe(false);
    expect(blocked.locked).toBe(true);
  });

  it("extracts an IP based key", () => {
    const request = new Request("https://example.test", {
      headers: { "cf-connecting-ip": "203.0.113.10" }
    });

    expect(ipRateLimitKey("login", request)).toBe("rate:login:ip:203.0.113.10");
  });

  it("extracts a subject based key", () => {
    expect(subjectRateLimitKey("admin", "operator")).toBe("rate:admin:subject:operator");
  });

  it("handles corrupt counter values by starting a fresh window", async () => {
    const store = new MemoryRateLimitStore();
    await store.put("k", "{bad");

    const decision = await evaluateRateLimit(store, "k", { windowMs: 1_000, maxRequests: 1 }, 0);
    expect(decision.allowed).toBe(true);
  });
});
