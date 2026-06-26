import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDotCastPoolResolution,
  createDotCastPool,
  placeDotCastPoolEntry,
  pollDotCastPoolResolution,
  previewDotCastOdds,
  readDotCastSettlementRailBalance,
  readDotCastSettlementRailStatus,
  recordDotCastDevnetDeposit,
  readDotCastPoolLiveOdds,
  readDotCastHealth,
  requestDotCastDevnetWithdrawal,
  settleDotCastPool,
  simulateDotCastSettlement,
  voidDotCastPool
} from "../../src/gateway/DotCastGateway";
import type { Env } from "../../src/types";

describe("dotCast gateway handlers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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
        e3: "live-odds-reference-endpoint-ready",
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

  it("rejects public USDC pool creation until E6 funding is enabled", async () => {
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
      error: "usdc pools are disabled until the E6 pool funding rail is enabled"
    });
  });

  it("allows devnet-gated USDC pool creation once E6 funding is ready", async () => {
    const calls: string[] = [];
    const env = envWithDotCastPoolAndSettlementRail(async (request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      const body = await request.json<Record<string, unknown>>();
      return Response.json({
        ok: true,
        created: true,
        snapshot: { pool: { id: body.id, unit: body.unit } }
      });
    });
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
      env
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual(["POST /create"]);
    expect(await response.json()).toMatchObject({
      ok: true,
      snapshot: { pool: { id: "pool-usdc", unit: "usdc" } }
    });
  });

  it("handles E5 devnet USDC deposits and mock withdrawals through the gateway", async () => {
    const env = envWithSettlementRailDb();
    const statusResponse = readDotCastSettlementRailStatus(env);
    const depositResponse = await recordDotCastDevnetDeposit(
      jsonRequest("/api/dotcast/settlement-rail/deposits/devnet", {
        userId: "user-gateway",
        amount: 1_000_000,
        txRef: "gateway-devnet-deposit",
        confirmations: 1,
        now: "2099-06-25T17:00:00.000Z"
      }),
      env
    );
    const balanceResponse = await readDotCastSettlementRailBalance("user-gateway", env);
    const withdrawalResponse = await requestDotCastDevnetWithdrawal(
      jsonRequest("/api/dotcast/settlement-rail/withdrawals/devnet", {
        userId: "user-gateway",
        amount: 250_000,
        destination: "11111111111111111111111111111111",
        idempotencyKey: "gateway-withdrawal",
        now: "2099-06-25T17:01:00.000Z"
      }),
      env
    );
    const replayResponse = await requestDotCastDevnetWithdrawal(
      jsonRequest("/api/dotcast/settlement-rail/withdrawals/devnet", {
        userId: "user-gateway",
        amount: 250_000,
        destination: "11111111111111111111111111111111",
        idempotencyKey: "gateway-withdrawal",
        now: "2099-06-25T17:01:01.000Z"
      }),
      env
    );

    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      ok: true,
      milestone: "E5",
      rail: { ready: true, signerMode: "mock" },
      safeguards: {
        privateKeysInRepo: false,
        mainnetWithdrawals: "blocked-until-operator-approval"
      }
    });
    expect(depositResponse.status).toBe(200);
    expect(await depositResponse.json()).toMatchObject({
      ok: true,
      milestone: "E5",
      status: "credited",
      balance: { availableUsdc: 1_000_000 }
    });
    expect(balanceResponse.status).toBe(200);
    expect(await balanceResponse.json()).toMatchObject({
      ok: true,
      balance: { userId: "user-gateway", availableUsdc: 1_000_000 }
    });
    expect(withdrawalResponse.status).toBe(200);
    expect(await withdrawalResponse.json()).toMatchObject({
      ok: true,
      status: "signed",
      broadcast: false,
      idempotent: false,
      transfer: {
        signerMode: "mock",
        mockSignature: expect.stringMatching(/^mock-solana-devnet-/)
      },
      balance: { availableUsdc: 750_000, pendingWithdrawalUsdc: 250_000 }
    });
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toMatchObject({
      ok: true,
      idempotent: true,
      balance: { availableUsdc: 750_000, pendingWithdrawalUsdc: 250_000 }
    });
  });

  it("proxies entry placement with gateway-generated entry ids", async () => {
    const calls: string[] = [];
    const env = envWithDotCastPool(async (request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.method === "GET") {
        return Response.json({ ok: true, snapshot: { pool: { unit: "points" } } });
      }

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
    expect(calls).toEqual(["GET /", "POST /entries"]);
    expect(body.entry).toMatchObject({
      userId: "user-1",
      side: "yes",
      amount: 25
    });
    expect((body.entry as Record<string, unknown>).entryId).toEqual(
      expect.stringMatching(/^entry:/)
    );
  });

  it("reserves E6 USDC pool funding before forwarding entries", async () => {
    const calls: Array<{ route: string; body: Record<string, unknown> | null }> = [];
    const env = envWithDotCastPoolAndSettlementRail(async (request) => {
      const route = `${request.method} ${new URL(request.url).pathname}`;
      if (request.method === "GET") {
        calls.push({ route, body: null });
        return Response.json({ ok: true, snapshot: { pool: { unit: "usdc" } } });
      }

      const body = await request.json<Record<string, unknown>>();
      calls.push({ route, body });
      return Response.json({
        ok: true,
        entry: body,
        balance: { available: 0, locked: body.amount },
        snapshot: { pool: { unit: "usdc" } }
      });
    });

    await recordDotCastDevnetDeposit(
      jsonRequest("/api/dotcast/settlement-rail/deposits/devnet", {
        userId: "user-usdc-entry",
        amount: 1_000,
        txRef: "gateway-e6-deposit",
        confirmations: 1,
        now: "2099-06-25T17:00:00.000Z"
      }),
      env
    );
    const response = await placeDotCastPoolEntry(
      "pool-usdc-gateway",
      jsonRequest("/api/dotcast/pools/pool-usdc-gateway/entries", {
        userId: "user-usdc-entry",
        side: "yes",
        amount: 250,
        entryId: "entry-usdc-gateway",
        now: "2099-06-25T17:01:00.000Z"
      }),
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { route: "GET /", body: null },
      {
        route: "POST /entries",
        body: expect.objectContaining({
          userId: "user-usdc-entry",
          amount: 250,
          entryId: "entry-usdc-gateway",
          settlementFunding: {
            rail: "solana-usdc-devnet",
            lockId: "dotcast:e6:pool-lock:pool-usdc-gateway:entry-usdc-gateway",
            reservedAmount: 250
          }
        })
      }
    ]);
    expect(body).toMatchObject({
      ok: true,
      settlementFunding: {
        milestone: "E6",
        status: "locked",
        balance: {
          availableUsdc: 750,
          lockedPoolUsdc: 250
        }
      }
    });
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

  it("reads E3 live odds and enriches them with router reference price", async () => {
    const calls: string[] = [];
    const env = envWithDotCastPool(async (request) => {
      calls.push(
        `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`
      );
      return Response.json({
        ok: true,
        liveOdds: {
          poolId: "pool-gateway",
          marketId: "kalshi:gateway",
          status: "open",
          unit: "points",
          odds: { yes: 0.7, no: 0.3 },
          pools: { yes: 700, no: 300 },
          totalStaked: 1000,
          entryCount: 2,
          updatedAt: "2026-06-25T17:02:00.000Z",
          previews: {
            yes: { "25": 34 },
            no: { "25": 76 }
          },
          hypothetical: {
            amount: 25,
            payout: { yes: 34, no: 76 }
          }
        },
        snapshot: {
          pool: {
            marketId: "kalshi:gateway"
          }
        }
      });
    }) as Env & {
      DOTCAST_ROUTER_REFERENCE_PRICE_URL: string;
      DOTCAST_ROUTER_REFERENCE_PRICE_TOKEN: string;
    };
    env.DOTCAST_ROUTER_REFERENCE_PRICE_URL = "https://router.test/markets/{marketId}";
    env.DOTCAST_ROUTER_REFERENCE_PRICE_TOKEN = "token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          market: {
            id: "kalshi:gateway",
            venue: "kalshi",
            price: { yes: 0.62, no: 0.41 },
            lastUpdated: "2026-06-25T17:02:01.000Z",
            stale: false,
            referenceUrl: "https://kalshi.example/markets/gateway"
          }
        })
      )
    );

    const response = await readDotCastPoolLiveOdds(
      "pool-gateway",
      new Request("https://api.test/api/dotcast/pools/pool-gateway/odds?amount=25"),
      env
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toEqual(["GET /odds?amount=25"]);
    expect(body).toMatchObject({
      ok: true,
      liveOdds: {
        marketId: "kalshi:gateway",
        entryCount: 2,
        hypothetical: {
          amount: 25
        }
      },
      referencePrice: {
        available: true,
        kind: "reference",
        marketId: "kalshi:gateway",
        venue: "kalshi",
        price: { yes: 0.62, no: 0.41 },
        stale: false,
        referenceUrl: "https://kalshi.example/markets/gateway"
      }
    });
  });

  it("keeps E3 live odds available when router reference price is not configured", async () => {
    const env = envWithDotCastPool(async () =>
      Response.json({
        ok: true,
        liveOdds: {
          poolId: "pool-gateway",
          marketId: "kalshi:gateway",
          status: "open",
          unit: "points",
          odds: { yes: 0.5, no: 0.5 },
          pools: { yes: 0, no: 0 },
          totalStaked: 0,
          entryCount: 0,
          updatedAt: "2026-06-25T17:02:00.000Z",
          previews: { yes: {}, no: {} },
          hypothetical: null
        }
      })
    );

    const response = await readDotCastPoolLiveOdds(
      "pool-gateway",
      new Request("https://api.test/api/dotcast/pools/pool-gateway/odds"),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      referencePrice: {
        available: false,
        kind: "not_configured"
      }
    });
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

function envWithDotCastPoolAndSettlementRail(
  handler: (request: Request) => Promise<Response> | Response
): Env {
  return {
    ...envWithSettlementRailDb(),
    DOTCAST_POOL: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: () => ({ fetch: handler }) as unknown as DurableObjectStub
    } as unknown as DurableObjectNamespace
  } as Env;
}

function envWithSettlementRailDb(): Env {
  const d1 = new FakeSettlementRailD1();

  return {
    TRADING_DB: d1 as unknown as D1Database,
    DOTCAST_SETTLEMENT_RAIL_MODE: "devnet",
    DOTCAST_SOLANA_CLUSTER: "devnet",
    DOTCAST_SETTLEMENT_SIGNER_MODE: "mock",
    DOTCAST_DEPOSIT_CONFIRMATIONS_REQUIRED: "1",
    DOTCAST_WITHDRAWAL_MAX_MINOR_UNITS: "1000000",
    DOTCAST_USDC_POOLS_ENABLED: "true"
  } as Env;
}

class FakeSettlementRailD1 {
  readonly balances = new Map<string, Record<string, unknown>>();
  readonly transfers = new Map<string, Record<string, unknown>>();
  readonly events = new Map<string, Record<string, unknown>>();
  readonly poolLocks = new Map<string, Record<string, unknown>>();
  readonly poolEvents = new Map<string, Record<string, unknown>>();

  prepare(query: string) {
    return {
      bind: (...params: unknown[]) => ({
        first: async () => this.first(query, params),
        all: async () => ({ results: this.all(query) }),
        run: async () => {
          this.run(query, params);
          return { success: true };
        }
      })
    };
  }

  private first(query: string, params: unknown[]): Record<string, unknown> | null {
    if (query.includes("FROM dotcast_settlement_balances")) {
      return this.balances.get(String(params[0])) ?? null;
    }

    if (query.includes("WHERE transfer_id = ?")) {
      return this.transfers.get(String(params[0])) ?? null;
    }

    if (query.includes("FROM dotcast_usdc_pool_locks")) {
      return this.poolLocks.get(String(params[0])) ?? null;
    }

    if (query.includes("WHERE tx_ref = ?")) {
      return (
        [...this.transfers.values()].find(
          (transfer) => transfer.kind === "deposit" && transfer.tx_ref === params[0]
        ) ?? null
      );
    }

    return null;
  }

  private all(query: string): Record<string, unknown>[] {
    if (query.includes("FROM dotcast_settlement_balances")) {
      return [...this.balances.values()];
    }

    return [];
  }

  private run(query: string, params: unknown[]): void {
    if (query.includes("INSERT INTO dotcast_settlement_balances")) {
      this.balances.set(String(params[0]), {
        user_id: params[0],
        available_usdc: params[1],
        pending_deposit_usdc: params[2],
        pending_withdrawal_usdc: params[3],
        locked_pool_usdc: params[4],
        updated_at: params[5]
      });
      return;
    }

    if (query.includes("INSERT INTO dotcast_settlement_transfers")) {
      this.transfers.set(String(params[0]), {
        transfer_id: params[0],
        user_id: params[1],
        kind: params[2],
        status: params[3],
        network: params[4],
        cluster: params[5],
        mint: params[6],
        amount: params[7],
        tx_ref: params[8],
        destination: params[9],
        signer_mode: params[10],
        mock_signature: params[11],
        requested_at: params[12],
        updated_at: params[13],
        event_json: params[14]
      });
      return;
    }

    if (query.includes("UPDATE dotcast_settlement_transfers")) {
      const transferId = String(params[7]);
      const existing = this.transfers.get(transferId) ?? {};
      this.transfers.set(transferId, {
        ...existing,
        status: params[0],
        tx_ref: params[1],
        destination: params[2],
        signer_mode: params[3],
        mock_signature: params[4],
        updated_at: params[5],
        event_json: params[6]
      });
      return;
    }

    if (query.includes("INSERT OR IGNORE INTO dotcast_settlement_rail_events")) {
      this.events.set(String(params[0]), {
        event_id: params[0],
        user_id: params[1],
        event_type: params[2],
        network: params[3],
        cluster: params[4],
        mint: params[5],
        amount: params[6],
        tx_ref: params[7],
        withdrawal_id: params[8],
        status: params[9],
        reason: params[10],
        event_json: params[11],
        created_at: params[12]
      });
      return;
    }

    if (query.includes("INSERT INTO dotcast_usdc_pool_locks")) {
      this.poolLocks.set(String(params[0]), {
        lock_id: params[0],
        pool_id: params[1],
        entry_id: params[2],
        user_id: params[3],
        amount: params[4],
        status: params[5],
        payout: params[6],
        created_at: params[7],
        updated_at: params[8],
        event_json: params[9]
      });
      return;
    }

    if (query.includes("UPDATE dotcast_usdc_pool_locks")) {
      const lockId = String(params[4]);
      const existing = this.poolLocks.get(lockId) ?? {};
      this.poolLocks.set(lockId, {
        ...existing,
        status: params[0],
        payout: params[1],
        updated_at: params[2],
        event_json: params[3]
      });
      return;
    }

    if (query.includes("INSERT OR IGNORE INTO dotcast_usdc_pool_events")) {
      this.poolEvents.set(String(params[0]), {
        event_id: params[0],
        lock_id: params[1],
        pool_id: params[2],
        entry_id: params[3],
        user_id: params[4],
        event_type: params[5],
        amount: params[6],
        payout: params[7],
        status: params[8],
        event_json: params[9],
        created_at: params[10]
      });
    }
  }
}
