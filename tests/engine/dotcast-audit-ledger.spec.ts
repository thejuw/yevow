import { describe, expect, it } from "vitest";
import {
  buildDotCastAuditWritePlan,
  writeDotCastAuditPlan,
  type DotCastAuditDb,
  type DotCastPoolSnapshot
} from "../../src/engine/dotcast";

describe("dotCast E2/E7 audit ledger", () => {
  it("builds an append-only pool creation audit event", () => {
    const snapshot = openSnapshot();
    const plan = buildDotCastAuditWritePlan("create", {
      ok: true,
      created: true,
      snapshot
    });

    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({
      eventId: "dotcast:audit:pool:pool-audit:created",
      poolId: "pool-audit",
      eventType: "POOL_CREATED",
      marketId: "kalshi:audit",
      unit: "points",
      status: "open",
      createdAt: "2099-06-25T17:00:00.000Z"
    });
    expect(plan.balanceLedger).toEqual([]);
    expect(plan.houseLedger).toEqual([]);
  });

  it("records entry locks with available and locked balance deltas", () => {
    const snapshot = openSnapshot({
      entries: [
        {
          id: "entry-yes",
          poolId: "pool-audit",
          userId: "user-1",
          side: "yes",
          amount: 250,
          funding: "user",
          placedAt: "2099-06-25T17:01:00.000Z",
          payout: null,
          refunded: false
        }
      ],
      balances: {
        "user-1": {
          userId: "user-1",
          unit: "points",
          available: 9750,
          locked: 250
        }
      }
    });
    const plan = buildDotCastAuditWritePlan("entry", {
      ok: true,
      entry: snapshot.entries[0],
      balance: snapshot.balances["user-1"],
      snapshot
    });

    expect(plan.events.map((event) => event.eventType)).toEqual(["ENTRY_PLACED"]);
    expect(plan.balanceLedger).toEqual([
      expect.objectContaining({
        ledgerId: "dotcast:balance:entry:entry-yes",
        userId: "user-1",
        deltaAvailable: -250,
        deltaLocked: 250,
        availableAfter: 9750,
        lockedAfter: 250,
        reason: "ENTRY_LOCK"
      })
    ]);
  });

  it("records terminal settlement payouts and rake from a router resolution", () => {
    const snapshot = settledSnapshot();
    const plan = buildDotCastAuditWritePlan("resolution", {
      ok: true,
      action: "settled",
      reason: "DEFINITIVE_OUTCOME",
      snapshot
    });

    expect(plan.events.map((event) => event.eventType)).toEqual([
      "RESOLUTION_APPLIED",
      "RAKE_RECORDED"
    ]);
    expect(plan.balanceLedger).toEqual([
      expect.objectContaining({
        ledgerId: "dotcast:balance:settlement:settlement:pool-audit:yes:entry-yes",
        userId: "yes-user",
        deltaAvailable: 985,
        deltaLocked: -700,
        reason: "SETTLEMENT_PAYOUT"
      }),
      expect.objectContaining({
        ledgerId: "dotcast:balance:settlement:settlement:pool-audit:yes:entry-no",
        userId: "no-user",
        deltaAvailable: 0,
        deltaLocked: -300,
        reason: "SETTLEMENT_PAYOUT"
      })
    ]);
    expect(plan.houseLedger).toEqual([
      expect.objectContaining({
        ledgerId: "house:rake:pool-audit:4072863960000",
        amount: 15,
        reason: "RAKE"
      })
    ]);
  });

  it("writes D1 insert-or-ignore statements as one batch", async () => {
    const db = fakeAuditDb();
    const plan = buildDotCastAuditWritePlan("resolution", {
      ok: true,
      action: "settled",
      reason: "DEFINITIVE_OUTCOME",
      snapshot: settledSnapshot()
    });

    await writeDotCastAuditPlan(db.db, plan);

    expect(db.batches).toHaveLength(1);
    expect(db.statements).toHaveLength(5);
    expect(db.statements.map((statement) => statement.params[3])).toContain("RESOLUTION_APPLIED");
    expect(
      db.statements.some((statement) => statement.query.includes("dotcast_balance_ledger"))
    ).toBe(true);
    expect(
      db.statements.some((statement) => statement.query.includes("dotcast_house_ledger"))
    ).toBe(true);
  });
});

function openSnapshot(overrides: Partial<DotCastPoolSnapshot> = {}): DotCastPoolSnapshot {
  return {
    pool: {
      id: "pool-audit",
      marketId: "kalshi:audit",
      venue: "kalshi",
      unit: "points",
      question: "Will audit records work?",
      status: "open",
      entryOpensAt: "2099-06-25T17:00:00.000Z",
      entryClosesAt: "2099-06-25T17:05:00.000Z",
      expectedResolveAt: "2099-06-25T17:10:00.000Z",
      rake: 0.05,
      pools: { yes: 0, no: 0 },
      minLiquidity: 0,
      createdAt: "2099-06-25T17:00:00.000Z",
      settledAt: null,
      outcome: null
    },
    entries: [],
    balances: {},
    houseLedger: [],
    settlement: null,
    voidReason: null,
    lastResolution: null,
    updatedAt: "2099-06-25T17:00:00.000Z",
    ...overrides
  };
}

function settledSnapshot(): DotCastPoolSnapshot {
  return openSnapshot({
    pool: {
      ...openSnapshot().pool,
      status: "settled",
      pools: { yes: 700, no: 300 },
      settledAt: "2099-06-25T17:06:00.000Z",
      outcome: "yes"
    },
    entries: [
      {
        id: "entry-yes",
        poolId: "pool-audit",
        userId: "yes-user",
        side: "yes",
        amount: 700,
        funding: "user",
        placedAt: "2099-06-25T17:01:00.000Z",
        payout: 985,
        refunded: false
      },
      {
        id: "entry-no",
        poolId: "pool-audit",
        userId: "no-user",
        side: "no",
        amount: 300,
        funding: "user",
        placedAt: "2099-06-25T17:02:00.000Z",
        payout: 0,
        refunded: false
      }
    ],
    balances: {
      "yes-user": {
        userId: "yes-user",
        unit: "points",
        available: 10285,
        locked: 0
      },
      "no-user": {
        userId: "no-user",
        unit: "points",
        available: 9700,
        locked: 0
      }
    },
    houseLedger: [
      {
        id: "house:rake:pool-audit:4072863960000",
        poolId: "pool-audit",
        unit: "points",
        amount: 15,
        reason: "rake",
        createdAt: "2099-06-25T17:06:00.000Z"
      }
    ],
    settlement: {
      id: "settlement:pool-audit:yes",
      poolId: "pool-audit",
      outcome: "yes",
      totalStaked: 1000,
      payoutTotal: 985,
      rakeAmount: 15,
      createdAt: "2099-06-25T17:06:00.000Z"
    },
    lastResolution: {
      marketId: "kalshi:audit",
      outcome: "yes",
      resolvedAt: "2099-06-25T17:06:00.000Z",
      fetchedAt: "2099-06-25T17:06:01.000Z",
      stale: false,
      source: "kalshi"
    },
    updatedAt: "2099-06-25T17:06:00.000Z"
  });
}

function fakeAuditDb() {
  const statements: { query: string; params: unknown[] }[] = [];
  const batches: unknown[][] = [];
  const db = {
    prepare: (query: string) =>
      ({
        bind: (...params: unknown[]) => {
          const statement = { query, params };
          statements.push(statement);
          return statement as unknown as D1PreparedStatement;
        }
      }) as D1PreparedStatement,
    batch: async (batch: D1PreparedStatement[]) => {
      batches.push(batch);
      return [];
    }
  } as DotCastAuditDb;

  return { db, statements, batches };
}
