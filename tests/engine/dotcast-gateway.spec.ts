import { describe, expect, it } from "vitest";
import {
  applyDotCastPoolResolution,
  createDotCastPool,
  placeDotCastPoolEntry,
  pollDotCastPoolResolution,
  previewDotCastOdds,
  readDotCastHealth,
  settleDotCastPool,
  simulateDotCastSettlement,
  voidDotCastPool
} from "../../src/gateway/DotCastGateway";
import type { Env } from "../../src/types";

describe("dotCast gateway handlers", () => {
  it("reports milestone health without requiring funds or persistence", async () => {
    const response = readDotCastHealth();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      product: "dotCast",
      engine: "live-parimutuel",
      milestones: {
        e0: "parimutuel-core-ready",
        e1: "pool-lifecycle-core-ready",
        e2: "router-resolution-polling-ready",
        e13: "resolution-router-not-started"
      }
    });
  });

  it("previews live odds and payout from integer minor-unit pools", async () => {
    const response = await previewDotCastOdds(
      jsonRequest("/api/dotcast/preview", {
        pools: { yes: 7000, no: 3000 },
        side: "yes",
        amount: 700,
        rake: 0.05
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      odds: { yes: 0.7, no: 0.3 },
      preview: { side: "yes", amount: 700, payout: 959 },
      rake: 0.05
    });
  });

  it("rejects malformed preview requests", async () => {
    const response = await previewDotCastOdds(
      jsonRequest("/api/dotcast/preview", {
        pools: { yes: 1, no: 0 },
        side: "maybe",
        amount: 10
      })
    );

    expect(response.status).toBe(400);
  });

  it("simulates deterministic settlement and reports conservation", async () => {
    const response = await simulateDotCastSettlement(
      jsonRequest("/api/dotcast/settlement/simulate", {
        entries: [
          { id: "yes-target", side: "yes", amount: 700 },
          { id: "yes-rest", side: "yes", amount: 6300 },
          { id: "no-pool", side: "no", amount: 3000 }
        ],
        outcome: "yes",
        rake: 0.05
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      conservation: {
        payoutTotal: 9850,
        rakeAmount: 150,
        totalStaked: 10000,
        conserved: true
      }
    });
  });

  it("proxies persistent pool creation through the Durable Object binding", async () => {
    const calls: string[] = [];
    const env = envWithDotCastPool(async (request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      const body = await request.json<Record<string, unknown>>();
      return Response.json({ ok: true, created: true, snapshot: { pool: { id: body.id } } });
    });
    const response = await createDotCastPool(
      jsonRequest("/api/dotcast/pools", {
        id: "pool-gateway",
        market: {
          id: "kalshi:gateway",
          venue: "kalshi",
          question: "Will gateway creation work?",
          status: "open",
          closeTime: "2026-06-25T17:05:00.000Z",
          expectedResolveAt: null
        },
        unit: "points",
        entryClosesAt: "2026-06-25T17:05:00.000Z",
        now: "2026-06-25T17:00:00.000Z"
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual(["POST /create"]);
    expect(await response.json()).toMatchObject({
      ok: true,
      snapshot: {
        pool: {
          id: "pool-gateway"
        }
      }
    });
  });

  it("rejects public USDC pool creation until the settlement rail exists", async () => {
    const response = await createDotCastPool(
      jsonRequest("/api/dotcast/pools", {
        id: "pool-usdc",
        market: {
          id: "kalshi:gateway",
          venue: "kalshi",
          question: "Will gateway creation work?",
          status: "open",
          closeTime: "2026-06-25T17:05:00.000Z",
          expectedResolveAt: null
        },
        unit: "usdc",
        entryClosesAt: "2026-06-25T17:05:00.000Z",
        now: "2026-06-25T17:00:00.000Z"
      }),
      envWithDotCastPool(async () => Response.json({ ok: true }))
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "usdc pools are disabled until the settlement rail is enabled"
    });
  });

  it("proxies entry placement with gateway-generated entry ids", async () => {
    const calls: string[] = [];
    const env = envWithDotCastPool(async (request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      const body = await request.json<Record<string, unknown>>();
      return Response.json({ ok: true, entry: body });
    });
    const response = await placeDotCastPoolEntry(
      "pool-gateway",
      jsonRequest("/api/dotcast/pools/pool-gateway/entries", {
        userId: "user-1",
        side: "yes",
        amount: 25,
        now: "2026-06-25T17:00:00.000Z"
      }),
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toEqual(["POST /entries"]);
    expect(body.entry).toMatchObject({
      userId: "user-1",
      side: "yes",
      amount: 25
    });
    expect((body.entry as Record<string, unknown>).entryId).toEqual(
      expect.stringMatching(/^entry:/)
    );
  });

  it("proxies settlement and admin void requests through the pool object", async () => {
    const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
    const env = envWithDotCastPool(async (request) => {
      calls.push({
        route: `${request.method} ${new URL(request.url).pathname}`,
        body: await request.json<Record<string, unknown>>()
      });
      return Response.json({ ok: true });
    });

    const settled = await settleDotCastPool(
      "pool-gateway",
      jsonRequest("/api/dotcast/pools/pool-gateway/settle", {
        outcome: "yes",
        now: "2026-06-25T17:06:00.000Z"
      }),
      env
    );
    const voided = await voidDotCastPool(
      "pool-gateway",
      jsonRequest("/api/dotcast/pools/pool-gateway/void", {
        reason: "ADMIN_VOID",
        now: "2026-06-25T17:07:00.000Z"
      }),
      env
    );

    expect(settled.status).toBe(200);
    expect(voided.status).toBe(200);
    expect(calls).toEqual([
      {
        route: "POST /settle",
        body: {
          outcome: "yes",
          now: "2026-06-25T17:06:00.000Z"
        }
      },
      {
        route: "POST /void",
        body: {
          reason: "ADMIN_VOID",
          now: "2026-06-25T17:07:00.000Z"
        }
      }
    ]);
  });

  it("proxies E2 router resolution intake through the pool object", async () => {
    const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
    const env = envWithDotCastPool(async (request) => {
      calls.push({
        route: `${request.method} ${new URL(request.url).pathname}`,
        body: await request.json<Record<string, unknown>>()
      });
      return Response.json({ ok: true, action: "settled" });
    });

    const response = await applyDotCastPoolResolution(
      "pool-gateway",
      jsonRequest("/api/dotcast/pools/pool-gateway/resolution", {
        marketId: "kalshi:gateway",
        outcome: "yes",
        resolvedAt: "2026-06-25T17:06:00.000Z",
        fetchedAt: "2026-06-25T17:06:01.000Z",
        stale: false,
        source: "kalshi",
        now: "2026-06-25T17:06:01.000Z",
        maxGraceMs: 60000
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        route: "POST /resolution",
        body: {
          marketId: "kalshi:gateway",
          outcome: "yes",
          resolvedAt: "2026-06-25T17:06:00.000Z",
          fetchedAt: "2026-06-25T17:06:01.000Z",
          stale: false,
          source: "kalshi",
          now: "2026-06-25T17:06:01.000Z",
          maxGraceMs: 60000
        }
      }
    ]);
  });

  it("proxies E2 router polling through the pool object", async () => {
    const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
    const env = envWithDotCastPool(async (request) => {
      calls.push({
        route: `${request.method} ${new URL(request.url).pathname}`,
        body: await request.json<Record<string, unknown>>()
      });
      return Response.json({ ok: true, poll: { kind: "pending" } });
    });

    const response = await pollDotCastPoolResolution(
      "pool-gateway",
      jsonRequest("/api/dotcast/pools/pool-gateway/poll-resolution", {
        now: "2026-06-25T17:06:01.000Z"
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        route: "POST /poll-resolution",
        body: {
          now: "2026-06-25T17:06:01.000Z"
        }
      }
    ]);
  });
});

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://api.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function envWithDotCastPool(handler: (request: Request) => Promise<Response> | Response): Env {
  return {
    DOTCAST_POOL: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: () => ({ fetch: handler }) as unknown as DurableObjectStub
    } as unknown as DurableObjectNamespace
  } as Env;
}
