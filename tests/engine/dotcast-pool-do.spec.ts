import { afterEach, describe, expect, it, vi } from "vitest";
import { DotCastPool } from "../../src/engine/dotcast";
import type { Env } from "../../src/types";

const now = "2099-06-25T17:00:00.000Z";
const close = "2099-06-25T17:05:00.000Z";

describe("dotCast pool durable object", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates, reads, and idempotently re-reads a persistent pool", async () => {
    const object = createObject();
    const created = await jsonBody(
      await object.fetch(jsonRequest("/create", createPayload({ id: "pool-do-1" })))
    );

    expect(created).toMatchObject({
      ok: true,
      created: true,
      snapshot: {
        pool: {
          id: "pool-do-1",
          marketId: "kalshi:demo-do",
          status: "open",
          pools: { yes: 0, no: 0 }
        },
        entries: []
      },
      odds: { yes: 0.5, no: 0.5 }
    });

    const read = await jsonBody(await object.fetch(new Request("https://dotcast.pool/")));
    expect(read).toMatchObject({
      ok: true,
      snapshot: {
        pool: {
          id: "pool-do-1",
          status: "open"
        }
      }
    });

    const secondCreate = await object.fetch(
      jsonRequest("/create", createPayload({ id: "pool-do-1" }))
    );
    expect(secondCreate.status).toBe(200);
    expect(await jsonBody(secondCreate)).toMatchObject({ ok: true, created: false });
  });

  it("places entries, seeds points balances, and updates live odds", async () => {
    const object = createObject();
    await object.fetch(jsonRequest("/create", createPayload({ id: "pool-do-entry" })));

    const placed = await jsonBody(
      await object.fetch(
        jsonRequest("/entries", {
          userId: "user-1",
          side: "yes",
          amount: 250,
          entryId: "entry-1",
          now: "2099-06-25T17:01:00.000Z"
        })
      )
    );

    expect(placed).toMatchObject({
      ok: true,
      entry: {
        id: "entry-1",
        userId: "user-1",
        side: "yes",
        amount: 250
      },
      balance: {
        available: 9750,
        locked: 250
      },
      snapshot: {
        pool: {
          pools: { yes: 250, no: 0 }
        },
        entries: [{ id: "entry-1" }]
      },
      odds: { yes: 1, no: 0 }
    });

    const duplicate = await jsonBody(
      await object.fetch(
        jsonRequest("/entries", {
          userId: "user-1",
          side: "yes",
          amount: 250,
          entryId: "entry-1",
          now: "2099-06-25T17:01:00.000Z"
        })
      )
    );

    expect(duplicate).toMatchObject({
      ok: true,
      duplicate: true,
      snapshot: {
        pool: {
          pools: { yes: 250, no: 0 }
        },
        entries: [{ id: "entry-1" }]
      }
    });
  });

  it("requires E6 settlement funding reservations for USDC entries", async () => {
    const object = createObject();
    await object.fetch(
      jsonRequest("/create", createPayload({ id: "pool-do-usdc", unit: "usdc", minLiquidity: 0 }))
    );

    const unfunded = await object.fetch(
      jsonRequest("/entries", {
        userId: "user-usdc",
        side: "yes",
        amount: 250,
        entryId: "entry-usdc",
        now: "2099-06-25T17:01:00.000Z"
      })
    );
    const funded = await jsonBody(
      await object.fetch(
        jsonRequest("/entries", {
          userId: "user-usdc",
          side: "yes",
          amount: 250,
          entryId: "entry-usdc",
          now: "2099-06-25T17:01:00.000Z",
          settlementFunding: {
            rail: "solana-usdc-devnet",
            lockId: "dotcast:e6:pool-lock:pool-do-usdc:entry-usdc",
            reservedAmount: 250
          }
        })
      )
    );

    expect(unfunded.status).toBe(400);
    expect(await jsonBody(unfunded)).toMatchObject({
      ok: false,
      error: "usdc entries require an E6 settlement funding reservation"
    });
    expect(funded).toMatchObject({
      ok: true,
      entry: {
        id: "entry-usdc",
        amount: 250
      },
      balance: {
        available: 0,
        locked: 250
      },
      settlementFunding: {
        rail: "solana-usdc-devnet",
        reservedAmount: 250
      },
      snapshot: {
        pool: {
          unit: "usdc",
          pools: { yes: 250, no: 0 }
        }
      }
    });
  });

  it("exposes E3 live odds snapshots with entry counts and hypothetical payouts", async () => {
    const object = createObject();
    await object.fetch(jsonRequest("/create", createPayload({ id: "pool-do-odds" })));
    await object.fetch(
      jsonRequest("/entries", {
        userId: "yes-user",
        side: "yes",
        amount: 700,
        entryId: "yes-entry",
        now: "2099-06-25T17:01:00.000Z"
      })
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "no-user",
        side: "no",
        amount: 300,
        entryId: "no-entry",
        now: "2099-06-25T17:02:00.000Z"
      })
    );

    const odds = await jsonBody(
      await object.fetch(new Request("https://dotcast.pool/odds?amount=700"))
    );

    expect(odds).toMatchObject({
      ok: true,
      liveOdds: {
        poolId: "pool-do-odds",
        marketId: "kalshi:demo-do",
        status: "open",
        unit: "points",
        odds: { yes: 0.7, no: 0.3 },
        pools: { yes: 700, no: 300 },
        totalStaked: 1000,
        entryCount: 2,
        hypothetical: {
          amount: 700,
          payout: {
            yes: 842,
            no: 1165
          }
        }
      }
    });
  });

  it("rejects entries after close and locks when requested at the boundary", async () => {
    const object = createObject();
    await object.fetch(
      jsonRequest("/create", createPayload({ id: "pool-do-lock", minLiquidity: 0 }))
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "yes-user",
        side: "yes",
        amount: 100,
        entryId: "yes-seed",
        now: "2099-06-25T17:01:00.000Z"
      })
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "no-user",
        side: "no",
        amount: 100,
        entryId: "no-seed",
        now: "2099-06-25T17:01:00.000Z"
      })
    );

    const lateEntry = await object.fetch(
      jsonRequest("/entries", {
        userId: "user-1",
        side: "no",
        amount: 100,
        now: "2099-06-25T17:05:01.000Z"
      })
    );
    expect(lateEntry.status).toBe(400);
    expect(await jsonBody(lateEntry)).toMatchObject({ ok: false, error: "entry window is closed" });

    const locked = await jsonBody(await object.fetch(jsonRequest("/lock", { now: close })));
    expect(locked).toMatchObject({
      ok: true,
      snapshot: {
        pool: {
          status: "locked"
        }
      }
    });

    const postLockEntry = await object.fetch(
      jsonRequest("/entries", {
        userId: "user-1",
        side: "yes",
        amount: 100,
        now: close
      })
    );
    expect(postLockEntry.status).toBe(400);
  });

  it("voids one-sided pools at lock and refunds exact user stakes", async () => {
    const object = createObject();
    await object.fetch(
      jsonRequest("/create", createPayload({ id: "pool-do-void", minLiquidity: 1 }))
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "user-1",
        side: "yes",
        amount: 100,
        entryId: "entry-void",
        now: "2099-06-25T17:01:00.000Z"
      })
    );

    const locked = await jsonBody(await object.fetch(jsonRequest("/lock", { now: close })));

    expect(locked).toMatchObject({
      ok: true,
      snapshot: {
        pool: {
          status: "voided"
        },
        entries: [{ id: "entry-void", refunded: true, payout: null }],
        balances: {
          "user-1": {
            available: 10000,
            locked: 0
          }
        },
        voidReason: "ONE_SIDED_POOL"
      }
    });
  });

  it("settles locked pools idempotently through the object", async () => {
    const object = createObject();
    await object.fetch(
      jsonRequest("/create", createPayload({ id: "pool-do-settle", minLiquidity: 1 }))
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "yes-user",
        side: "yes",
        amount: 700,
        entryId: "yes-entry",
        now: "2099-06-25T17:01:00.000Z"
      })
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "no-user",
        side: "no",
        amount: 300,
        entryId: "no-entry",
        now: "2099-06-25T17:02:00.000Z"
      })
    );
    await object.fetch(jsonRequest("/lock", { now: close }));

    const settled = await jsonBody(
      await object.fetch(
        jsonRequest("/settle", { outcome: "yes", now: "2099-06-25T17:06:00.000Z" })
      )
    );
    const replayed = await jsonBody(
      await object.fetch(
        jsonRequest("/settle", { outcome: "yes", now: "2099-06-25T17:07:00.000Z" })
      )
    );

    expect(settled).toMatchObject({
      ok: true,
      snapshot: {
        pool: {
          status: "settled",
          outcome: "yes"
        },
        balances: {
          "yes-user": {
            available: 10285,
            locked: 0
          },
          "no-user": {
            available: 9700,
            locked: 0
          }
        },
        settlement: {
          payoutTotal: 985,
          rakeAmount: 15
        },
        houseLedger: [{ amount: 15, reason: "rake" }]
      }
    });
    expect(replayed.snapshot).toEqual(settled.snapshot);
  });

  it("routes invalid resolutions to void refunds", async () => {
    const object = createObject();
    await object.fetch(
      jsonRequest("/create", createPayload({ id: "pool-do-invalid", minLiquidity: 0 }))
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "yes-user",
        side: "yes",
        amount: 100,
        entryId: "yes-entry",
        now: "2099-06-25T17:01:00.000Z"
      })
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "no-user",
        side: "no",
        amount: 100,
        entryId: "no-entry",
        now: "2099-06-25T17:02:00.000Z"
      })
    );
    await object.fetch(jsonRequest("/lock", { now: close }));

    const invalid = await jsonBody(
      await object.fetch(
        jsonRequest("/settle", { outcome: "invalid", now: "2099-06-25T17:06:00.000Z" })
      )
    );

    expect(invalid).toMatchObject({
      ok: true,
      snapshot: {
        pool: {
          status: "voided",
          outcome: "invalid"
        },
        voidReason: "INVALID_RESOLUTION",
        balances: {
          "yes-user": {
            available: 10000,
            locked: 0
          },
          "no-user": {
            available: 10000,
            locked: 0
          }
        }
      }
    });
  });

  it("applies router-shaped E2 resolutions and stores last resolution state", async () => {
    const object = createObject();
    await object.fetch(
      jsonRequest("/create", createPayload({ id: "pool-do-resolution", minLiquidity: 1 }))
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "yes-user",
        side: "yes",
        amount: 700,
        entryId: "yes-entry",
        now: "2099-06-25T17:01:00.000Z"
      })
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "no-user",
        side: "no",
        amount: 300,
        entryId: "no-entry",
        now: "2099-06-25T17:02:00.000Z"
      })
    );
    await object.fetch(jsonRequest("/lock", { now: close }));

    const held = await jsonBody(
      await object.fetch(
        jsonRequest("/resolution", {
          marketId: "kalshi:demo-do",
          outcome: "pending",
          resolvedAt: null,
          fetchedAt: "2099-06-25T17:06:00.000Z",
          stale: false,
          now: "2099-06-25T17:06:00.000Z",
          maxGraceMs: 60_000
        })
      )
    );
    const settled = await jsonBody(
      await object.fetch(
        jsonRequest("/resolution", {
          marketId: "kalshi:demo-do",
          outcome: "yes",
          resolvedAt: "2099-06-25T17:06:30.000Z",
          fetchedAt: "2099-06-25T17:06:31.000Z",
          stale: false,
          source: "kalshi",
          now: "2099-06-25T17:06:31.000Z"
        })
      )
    );

    expect(held).toMatchObject({
      ok: true,
      action: "held",
      reason: "PENDING_RESOLUTION",
      snapshot: {
        pool: { status: "locked" },
        lastResolution: { outcome: "pending" }
      }
    });
    expect(settled).toMatchObject({
      ok: true,
      action: "settled",
      reason: "DEFINITIVE_OUTCOME",
      snapshot: {
        pool: { status: "settled", outcome: "yes" },
        lastResolution: { outcome: "yes", source: "kalshi" },
        settlement: { payoutTotal: 985, rakeAmount: 15 }
      }
    });
  });

  it("voids stale E2 router resolutions after grace expires", async () => {
    const object = createObject();
    await object.fetch(
      jsonRequest(
        "/create",
        createPayload({
          id: "pool-do-grace",
          minLiquidity: 1,
          market: {
            id: "kalshi:demo-do",
            venue: "kalshi",
            question: "Will the host land the next call?",
            status: "open",
            closeTime: close,
            expectedResolveAt: "2099-06-25T17:10:00.000Z"
          }
        })
      )
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "yes-user",
        side: "yes",
        amount: 100,
        entryId: "yes-entry",
        now: "2099-06-25T17:01:00.000Z"
      })
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "no-user",
        side: "no",
        amount: 100,
        entryId: "no-entry",
        now: "2099-06-25T17:02:00.000Z"
      })
    );
    await object.fetch(jsonRequest("/lock", { now: close }));

    const voided = await jsonBody(
      await object.fetch(
        jsonRequest("/resolution", {
          marketId: "kalshi:demo-do",
          outcome: "yes",
          resolvedAt: "2099-06-25T17:10:00.000Z",
          fetchedAt: "2099-06-25T17:12:00.001Z",
          stale: true,
          now: "2099-06-25T17:12:00.001Z",
          maxGraceMs: 120_000
        })
      )
    );

    expect(voided).toMatchObject({
      ok: true,
      action: "voided",
      reason: "GRACE_TIMEOUT",
      snapshot: {
        pool: { status: "voided", outcome: null },
        voidReason: "GRACE_TIMEOUT",
        balances: {
          "yes-user": { available: 10000, locked: 0 },
          "no-user": { available: 10000, locked: 0 }
        }
      }
    });
  });

  it("polls configured router resolutions and clears the E2 alarm after terminal settlement", async () => {
    const state = fakeState();
    const object = new DotCastPool(state, {
      DOTCAST_ROUTER_RESOLUTION_URL: "https://router.test/markets/{marketId}/resolution",
      DOTCAST_ROUTER_RESOLUTION_POLL_MS: "30000"
    } as Env);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          resolution: {
            marketId: "kalshi:demo-do",
            outcome: "yes",
            resolvedAt: "2099-06-25T17:06:00.000Z",
            fetchedAt: "2099-06-25T17:06:01.000Z",
            stale: false,
            source: "kalshi"
          }
        })
      )
    );

    await object.fetch(
      jsonRequest("/create", createPayload({ id: "pool-do-poll", minLiquidity: 1 }))
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "yes-user",
        side: "yes",
        amount: 700,
        entryId: "yes-entry",
        now: "2099-06-25T17:01:00.000Z"
      })
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "no-user",
        side: "no",
        amount: 300,
        entryId: "no-entry",
        now: "2099-06-25T17:02:00.000Z"
      })
    );
    await object.fetch(jsonRequest("/lock", { now: close }));

    expect(await state.storage.getAlarm()).toBe(Date.parse(close) + 30_000);

    const polled = await jsonBody(
      await object.fetch(
        jsonRequest("/poll-resolution", {
          now: "2099-06-25T17:06:01.000Z"
        })
      )
    );

    expect(polled).toMatchObject({
      ok: true,
      poll: { kind: "resolution" },
      action: "settled",
      reason: "DEFINITIVE_OUTCOME",
      snapshot: {
        pool: { status: "settled", outcome: "yes" },
        settlement: { payoutTotal: 985, rakeAmount: 15 }
      }
    });
    expect(await state.storage.getAlarm()).toBeNull();
  });

  it("reports unconfigured E2 polling without guessing a resolution", async () => {
    const state = fakeState();
    const object = new DotCastPool(state, {} as Env);
    await object.fetch(
      jsonRequest("/create", createPayload({ id: "pool-do-no-router", minLiquidity: 1 }))
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "yes-user",
        side: "yes",
        amount: 100,
        entryId: "yes-entry",
        now: "2099-06-25T17:01:00.000Z"
      })
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "no-user",
        side: "no",
        amount: 100,
        entryId: "no-entry",
        now: "2099-06-25T17:02:00.000Z"
      })
    );
    await object.fetch(jsonRequest("/lock", { now: close }));

    const response = await object.fetch(
      jsonRequest("/poll-resolution", {
        now: "2099-06-25T17:06:00.000Z"
      })
    );
    const body = await jsonBody(response);

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      poll: { kind: "not_configured" },
      snapshot: {
        pool: { status: "locked", outcome: null },
        lastResolution: null
      }
    });
    expect(await state.storage.getAlarm()).toBe(Date.parse("2099-06-25T17:06:00.000Z") + 60_000);
  });

  it("writes E2/E7 audit records for mutations and failed router polls", async () => {
    const audit = fakeAuditDb();
    const state = fakeState();
    const object = new DotCastPool(state, { TRADING_DB: audit.db } as Env);

    await object.fetch(
      jsonRequest("/create", createPayload({ id: "pool-do-audit", minLiquidity: 1 }))
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "yes-user",
        side: "yes",
        amount: 100,
        entryId: "yes-entry",
        now: "2099-06-25T17:01:00.000Z"
      })
    );
    await object.fetch(
      jsonRequest("/entries", {
        userId: "no-user",
        side: "no",
        amount: 100,
        entryId: "no-entry",
        now: "2099-06-25T17:02:00.000Z"
      })
    );
    await object.fetch(jsonRequest("/lock", { now: close }));
    await object.fetch(
      jsonRequest("/poll-resolution", {
        now: "2099-06-25T17:06:00.000Z"
      })
    );

    const eventTypes = audit.statements
      .filter((statement) => statement.query.includes("dotcast_audit_events"))
      .map((statement) => statement.params[3]);
    const balanceReasons = audit.statements
      .filter((statement) => statement.query.includes("dotcast_balance_ledger"))
      .map((statement) => statement.params[9]);

    expect(eventTypes).toEqual(
      expect.arrayContaining(["POOL_CREATED", "ENTRY_PLACED", "POOL_LOCKED", "ROUTER_POLL"])
    );
    expect(balanceReasons).toEqual(expect.arrayContaining(["ENTRY_LOCK"]));
  });
});

function createObject() {
  return new DotCastPool(fakeState(), {} as Env);
}

function fakeState(): DurableObjectState {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;

  return {
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      setAlarm: async (scheduledTime: number) => {
        alarm = scheduledTime;
      },
      getAlarm: async () => alarm,
      deleteAlarm: async () => {
        alarm = null;
      }
    },
    blockConcurrencyWhile: async <T>(callback: () => T | Promise<T>) => callback()
  } as unknown as DurableObjectState;
}

function createPayload(overrides: Record<string, unknown> = {}) {
  const payload = {
    id: "pool-do",
    market: {
      id: "kalshi:demo-do",
      venue: "kalshi",
      question: "Will the host land the next call?",
      status: "open",
      closeTime: close,
      expectedResolveAt: "2099-06-25T17:10:00.000Z"
    },
    unit: "points",
    entryClosesAt: close,
    rake: 0.05,
    minLiquidity: 100,
    now,
    ...overrides
  };

  if (payload.unit === "usdc" && !payload.resolutionRoute) {
    const payloadMarket = payload.market as { id: unknown };
    return {
      ...payload,
      resolutionRoute: lockedRoute(payload.id, String(payloadMarket.id))
    };
  }

  return payload;
}

function lockedRoute(poolId: string, marketId: string) {
  return {
    routeId: `route:${poolId}`,
    marketId,
    poolId,
    tier: "hard_oracle",
    status: "locked",
    confidenceBps: 9400,
    resolutionStatement: "Use the originating Kalshi market outcome.",
    sources: [
      {
        kind: "router_market",
        label: "Kalshi market outcome",
        url: null,
        required: true
      }
    ],
    sourceAvailable: true,
    autoResolvable: true,
    reviewRequired: false,
    pointsOnly: false,
    blockedReason: null,
    steeringPrompt: null,
    feeBps: 0,
    bondMinorUnits: 0,
    panelSize: 0,
    lockedAt: now,
    classifierVersion: "test",
    createdAt: now,
    eventJson: {}
  };
}

function jsonRequest(pathname: string, body: unknown) {
  return new Request(`https://dotcast.pool${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function jsonBody(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

function fakeAuditDb() {
  const statements: { query: string; params: unknown[] }[] = [];
  const db = {
    prepare: (query: string) =>
      ({
        bind: (...params: unknown[]) => {
          const statement = { query, params };
          statements.push(statement);
          return statement as unknown as D1PreparedStatement;
        }
      }) as D1PreparedStatement,
    batch: async () => []
  } as unknown as D1Database;

  return { db, statements };
}
