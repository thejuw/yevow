import { describe, expect, it } from "vitest";
import {
  createPoolFromMarket,
  lockSnapshotIfNeeded,
  lockPoolIfNeeded,
  placeEntry,
  settlePoolSnapshot,
  transitionPool,
  voidPoolSnapshot,
  type DotCastMarketSnapshot,
  type DotCastPoolSnapshot,
  type StakeBalance
} from "../../src/engine/dotcast";

const now = "2026-06-25T17:00:00.000Z";
const close = "2026-06-25T17:05:00.000Z";

describe("dotCast pool lifecycle", () => {
  it("creates an open points pool from an open router market snapshot", () => {
    const pool = createPoolFromMarket({
      id: "pool-1",
      market: market(),
      unit: "points",
      entryClosesAt: close,
      rake: 0.05,
      minLiquidity: 100,
      now
    });

    expect(pool).toMatchObject({
      id: "pool-1",
      marketId: "kalshi:demo",
      venue: "kalshi",
      unit: "points",
      question: "Will the host land the next call?",
      status: "open",
      pools: { yes: 0, no: 0 }
    });
  });

  it("rejects non-open, stale, and late-lock market pools", () => {
    expect(() =>
      createPoolFromMarket({
        market: { ...market(), status: "closed" },
        unit: "points",
        entryClosesAt: close,
        rake: 0,
        minLiquidity: 0,
        now
      })
    ).toThrow(/open market/);

    expect(() =>
      createPoolFromMarket({
        market: { ...market(), closeTime: "2026-06-25T16:59:59.000Z" },
        unit: "points",
        entryClosesAt: close,
        rake: 0,
        minLiquidity: 0,
        now
      })
    ).toThrow(/stale market/);

    expect(() =>
      createPoolFromMarket({
        market: market(),
        unit: "points",
        entryClosesAt: "2026-06-25T17:06:00.000Z",
        rake: 0,
        minLiquidity: 0,
        now
      })
    ).toThrow(/cannot be after market closeTime/);
  });

  it("places entries during open window and debits available balance into locked", () => {
    const pool = openPool();
    const balance = stakeBalance({ available: 250, locked: 0 });
    const result = placeEntry({
      pool,
      balance,
      userId: "user-1",
      side: "yes",
      amount: 75,
      now: "2026-06-25T17:02:00.000Z",
      entryId: "entry-1"
    });

    expect(result.pool.pools).toEqual({ yes: 75, no: 0 });
    expect(result.balance).toMatchObject({ available: 175, locked: 75 });
    expect(result.entry).toMatchObject({
      id: "entry-1",
      poolId: "pool-1",
      userId: "user-1",
      side: "yes",
      amount: 75,
      funding: "user",
      payout: null,
      refunded: false
    });
  });

  it("rejects entries after close, locked pools, unit mismatches, and insufficient balances", () => {
    const pool = openPool();

    expect(() =>
      placeEntry({
        pool: { ...pool, entryOpensAt: "2026-06-25T17:01:00.000Z" },
        balance: stakeBalance(),
        userId: "user-1",
        side: "yes",
        amount: 10,
        now
      })
    ).toThrow(/not open/);

    expect(() =>
      placeEntry({
        pool,
        balance: stakeBalance(),
        userId: "user-1",
        side: "yes",
        amount: 10,
        now: "2026-06-25T17:05:01.000Z"
      })
    ).toThrow(/entry window is closed/);

    expect(() =>
      placeEntry({
        pool: transitionPool(pool, "locked", close),
        balance: stakeBalance(),
        userId: "user-1",
        side: "yes",
        amount: 10,
        now: close
      })
    ).toThrow(/only be placed while pool is open/);

    expect(() =>
      placeEntry({
        pool,
        balance: stakeBalance({ unit: "usdc" }),
        userId: "user-1",
        side: "yes",
        amount: 10,
        now
      })
    ).toThrow(/unit does not match/);

    expect(() =>
      placeEntry({
        pool,
        balance: stakeBalance({ available: 5 }),
        userId: "user-1",
        side: "yes",
        amount: 10,
        now
      })
    ).toThrow(/insufficient/);
  });

  it("enforces legal state transitions and terminal status boundaries", () => {
    const pool = openPool();

    expect(() => transitionPool(pool, "resolving", close)).toThrow(/illegal/);
    expect(() => transitionPool(pool, "locked", "2026-06-25T17:04:59.000Z")).toThrow(/before/);

    const locked = transitionPool(pool, "locked", close);
    expect(locked.status).toBe("locked");

    const resolving = transitionPool(locked, "resolving", "2026-06-25T17:06:00.000Z");
    expect(resolving.status).toBe("resolving");

    const settled = transitionPool(resolving, "settled", "2026-06-25T17:07:00.000Z", "yes");
    expect(settled).toMatchObject({
      status: "settled",
      outcome: "yes",
      settledAt: "2026-06-25T17:07:00.000Z"
    });
    expect(() => transitionPool(settled, "voided", "2026-06-25T17:08:00.000Z")).toThrow(/illegal/);
  });

  it("serializes a lock-boundary sequence as accepted-before-lock and rejected-after-lock", () => {
    const first = placeEntry({
      pool: openPool(),
      balance: stakeBalance(),
      userId: "user-1",
      side: "yes",
      amount: 100,
      now: close,
      entryId: "boundary-entry"
    });
    const locked = lockPoolIfNeeded(first.pool, close);

    expect(locked.status).toBe("locked");
    expect(locked.pools.yes).toBe(100);
    expect(() =>
      placeEntry({
        pool: locked,
        balance: first.balance,
        userId: "user-1",
        side: "no",
        amount: 25,
        now: close
      })
    ).toThrow(/only be placed while pool is open/);
  });

  it("voids and refunds one-sided or under-liquidity pools at lock", () => {
    const placed = placeEntry({
      pool: openPool({ minLiquidity: 100 }),
      balance: stakeBalance({ available: 250, locked: 0 }),
      userId: "user-1",
      side: "yes",
      amount: 100,
      now: "2026-06-25T17:02:00.000Z",
      entryId: "entry-1"
    });
    const snapshot = snapshotFromPlacement(placed.pool, [placed.entry], {
      "user-1": placed.balance
    });

    const locked = lockSnapshotIfNeeded(snapshot, close);

    expect(locked.pool.status).toBe("voided");
    expect(locked.voidReason).toBe("ONE_SIDED_POOL");
    expect(locked.entries[0]).toMatchObject({ refunded: true, payout: null });
    expect(locked.balances["user-1"]).toMatchObject({ available: 250, locked: 0 });
  });

  it("settles a locked pool, credits winners, zeroes losers, and records rake once", () => {
    const pool = openPool({ minLiquidity: 1 });
    const yes = placeEntry({
      pool,
      balance: stakeBalance({ userId: "yes-user", available: 1000, locked: 0 }),
      userId: "yes-user",
      side: "yes",
      amount: 700,
      now: "2026-06-25T17:01:00.000Z",
      entryId: "yes-entry"
    });
    const no = placeEntry({
      pool: yes.pool,
      balance: stakeBalance({ userId: "no-user", available: 1000, locked: 0 }),
      userId: "no-user",
      side: "no",
      amount: 300,
      now: "2026-06-25T17:02:00.000Z",
      entryId: "no-entry"
    });
    const locked = lockSnapshotIfNeeded(
      snapshotFromPlacement(no.pool, [yes.entry, no.entry], {
        "yes-user": yes.balance,
        "no-user": no.balance
      }),
      close
    );

    const settled = settlePoolSnapshot(locked, "yes", "2026-06-25T17:06:00.000Z");
    const replayed = settlePoolSnapshot(settled, "yes", "2026-06-25T17:07:00.000Z");

    expect(settled.pool).toMatchObject({
      status: "settled",
      outcome: "yes",
      settledAt: "2026-06-25T17:06:00.000Z"
    });
    expect(settled.entries.find((entry) => entry.id === "yes-entry")).toMatchObject({
      payout: 985
    });
    expect(settled.entries.find((entry) => entry.id === "no-entry")).toMatchObject({ payout: 0 });
    expect(settled.balances["yes-user"]).toMatchObject({ available: 1285, locked: 0 });
    expect(settled.balances["no-user"]).toMatchObject({ available: 700, locked: 0 });
    expect(settled.settlement).toMatchObject({
      totalStaked: 1000,
      payoutTotal: 985,
      rakeAmount: 15
    });
    expect(settled.houseLedger).toHaveLength(1);
    expect(replayed).toEqual(settled);
  });

  it("routes invalid resolutions and no-winner books to void refunds", () => {
    const pool = openPool({ minLiquidity: 1 });
    const no = placeEntry({
      pool,
      balance: stakeBalance({ available: 500, locked: 0 }),
      userId: "user-1",
      side: "no",
      amount: 200,
      now: "2026-06-25T17:01:00.000Z",
      entryId: "no-only"
    });
    const locked = {
      ...snapshotFromPlacement(no.pool, [no.entry], { "user-1": no.balance }),
      pool: transitionPool(no.pool, "locked", close)
    };

    const invalid = settlePoolSnapshot(locked, "invalid", "2026-06-25T17:06:00.000Z");
    const noWinner = settlePoolSnapshot(locked, "yes", "2026-06-25T17:06:00.000Z");

    expect(invalid).toMatchObject({
      pool: { status: "voided", outcome: "invalid" },
      voidReason: "INVALID_RESOLUTION",
      balances: { "user-1": { available: 500, locked: 0 } }
    });
    expect(noWinner).toMatchObject({
      pool: { status: "voided" },
      voidReason: "NO_WINNING_ENTRIES",
      balances: { "user-1": { available: 500, locked: 0 } }
    });
  });

  it("admin voids are idempotent and do not double-refund", () => {
    const placed = placeEntry({
      pool: openPool(),
      balance: stakeBalance({ available: 300, locked: 0 }),
      userId: "user-1",
      side: "yes",
      amount: 100,
      now: "2026-06-25T17:01:00.000Z",
      entryId: "entry-void"
    });
    const snapshot = snapshotFromPlacement(placed.pool, [placed.entry], {
      "user-1": placed.balance
    });

    const voided = voidPoolSnapshot(snapshot, "ADMIN_VOID", "2026-06-25T17:02:00.000Z");
    const replayed = voidPoolSnapshot(voided, "ADMIN_VOID", "2026-06-25T17:03:00.000Z");

    expect(voided.balances["user-1"]).toMatchObject({ available: 300, locked: 0 });
    expect(replayed).toEqual(voided);
  });
});

function market(overrides: Partial<DotCastMarketSnapshot> = {}): DotCastMarketSnapshot {
  return {
    id: "kalshi:demo",
    venue: "kalshi",
    question: "Will the host land the next call?",
    status: "open",
    closeTime: close,
    expectedResolveAt: "2026-06-25T17:10:00.000Z",
    ...overrides
  };
}

function openPool(overrides: { minLiquidity?: number } = {}) {
  return createPoolFromMarket({
    id: "pool-1",
    market: market(),
    unit: "points",
    entryClosesAt: close,
    rake: 0.05,
    minLiquidity: overrides.minLiquidity ?? 100,
    now
  });
}

function stakeBalance(overrides: Partial<StakeBalance> = {}): StakeBalance {
  return {
    userId: "user-1",
    unit: "points",
    available: 250,
    locked: 0,
    ...overrides
  };
}

function snapshotFromPlacement(
  pool: DotCastPoolSnapshot["pool"],
  entries: DotCastPoolSnapshot["entries"],
  balances: DotCastPoolSnapshot["balances"]
): DotCastPoolSnapshot {
  return {
    pool,
    entries,
    balances,
    houseLedger: [],
    settlement: null,
    voidReason: null,
    updatedAt: now
  };
}
