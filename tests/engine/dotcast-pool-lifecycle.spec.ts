import { describe, expect, it } from "vitest";
import {
  createPoolFromMarket,
  lockPoolIfNeeded,
  placeEntry,
  transitionPool,
  type DotCastMarketSnapshot,
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

function openPool() {
  return createPoolFromMarket({
    id: "pool-1",
    market: market(),
    unit: "points",
    entryClosesAt: close,
    rake: 0.05,
    minLiquidity: 100,
    now
  });
}

function stakeBalance(
  overrides: Partial<StakeBalance> = {}
): StakeBalance {
  return {
    userId: "user-1",
    unit: "points",
    available: 250,
    locked: 0,
    ...overrides
  };
}
