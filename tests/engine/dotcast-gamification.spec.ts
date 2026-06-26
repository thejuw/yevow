import { describe, expect, it } from "vitest";
import {
  applyDotCastGamificationSettlement,
  readDotCastGamificationStatus,
  readDotCastGamificationUserSummary,
  type DotCastGamificationProfile,
  type DotCastGamificationSettlement,
  type DotCastGamificationSettlementPlan,
  type DotCastGamificationStore,
  type DotCastPoolSnapshot,
  type FreeEntryCredit,
  type PointsLedgerEntry
} from "../../src/engine/dotcast";

describe("dotCast E8 gamification ledger", () => {
  it("reports readiness from config and database availability", () => {
    expect(readDotCastGamificationStatus({}, true)).toMatchObject({
      enabled: true,
      ready: true,
      correctPoints: 100,
      incorrectPoints: 10,
      streakBonusPoints: 50,
      streakBonusInterval: 3,
      freeEntryStreakInterval: 5,
      maxFreeEntryCredits: 10,
      guards: []
    });
    expect(readDotCastGamificationStatus({}, false)).toMatchObject({
      ready: false,
      guards: ["gamification database not configured"]
    });
  });

  it("awards points, streak bonuses, and free-entry credits idempotently", async () => {
    const store = new InMemoryGamificationStore();
    store.profiles.set("yes-user", {
      userId: "yes-user",
      pointsBalance: 40,
      currentStreak: 2,
      longestStreak: 2,
      settledPredictions: 2,
      correctPredictions: 2,
      incorrectPredictions: 0,
      freeEntriesGranted: 0,
      freeEntriesConsumed: 0,
      lastSettledPoolId: "pool-before",
      lastSettledAt: "2099-06-25T16:00:00.000Z",
      updatedAt: "2099-06-25T16:00:00.000Z"
    });

    const applied = await applyDotCastGamificationSettlement(
      store,
      { DOTCAST_GAMIFICATION_FREE_ENTRY_STREAK_INTERVAL: "3" },
      settledPointsSnapshot(),
      { now: "2099-06-25T17:06:00.000Z" }
    );
    const replayed = await applyDotCastGamificationSettlement(
      store,
      { DOTCAST_GAMIFICATION_FREE_ENTRY_STREAK_INTERVAL: "3" },
      settledPointsSnapshot(),
      { now: "2099-06-25T17:07:00.000Z" }
    );
    const summary = await readDotCastGamificationUserSummary(
      store,
      "yes-user",
      "2099-06-25T17:08:00.000Z"
    );

    expect(applied).toMatchObject({
      applied: true,
      idempotent: false,
      settlement: {
        poolId: "pool-e8",
        outcome: "yes",
        appliedEntries: 2,
        correctEntries: 1,
        incorrectEntries: 1,
        pointsAwarded: 160,
        freeEntriesGranted: 1
      }
    });
    expect(store.profiles.get("yes-user")).toMatchObject({
      pointsBalance: 190,
      currentStreak: 3,
      longestStreak: 3,
      correctPredictions: 3,
      freeEntriesGranted: 1
    });
    expect(store.profiles.get("no-user")).toMatchObject({
      pointsBalance: 10,
      currentStreak: 0,
      incorrectPredictions: 1
    });
    expect([...store.ledger.values()].map((entry) => entry.reason)).toEqual([
      "predict_correct",
      "streak_bonus",
      "predict_incorrect"
    ]);
    expect([...store.freeEntries.values()]).toEqual([
      expect.objectContaining({
        userId: "yes-user",
        grantReason: "streak_bonus",
        poolId: "pool-e8",
        consumedAt: null
      })
    ]);
    expect(replayed).toMatchObject({
      applied: false,
      idempotent: true,
      ledger: [],
      freeEntries: []
    });
    expect(store.ledger.size).toBe(3);
    expect(summary.availableFreeEntries).toBe(1);
    expect(summary.profile).toMatchObject({
      userId: "yes-user",
      pointsBalance: 190,
      currentStreak: 3
    });
  });

  it("refuses to award E8 gamification for USDC pools", async () => {
    await expect(
      applyDotCastGamificationSettlement(
        new InMemoryGamificationStore(),
        {},
        {
          ...settledPointsSnapshot(),
          pool: {
            ...settledPointsSnapshot().pool,
            unit: "usdc"
          }
        }
      )
    ).rejects.toMatchObject({
      name: "DotCastGamificationError",
      code: "GAMIFICATION_POINTS_ONLY",
      status: 409
    });
  });
});

class InMemoryGamificationStore implements DotCastGamificationStore {
  readonly profiles = new Map<string, DotCastGamificationProfile>();
  readonly settlements = new Map<string, DotCastGamificationSettlement>();
  readonly ledger = new Map<string, PointsLedgerEntry>();
  readonly freeEntries = new Map<string, FreeEntryCredit>();

  async getProfile(userId: string): Promise<DotCastGamificationProfile | null> {
    const profile = this.profiles.get(userId);
    return profile ? { ...profile } : null;
  }

  async getSettlement(poolId: string): Promise<DotCastGamificationSettlement | null> {
    const settlement = this.settlements.get(poolId);
    return settlement ? { ...settlement } : null;
  }

  async listLedger(userId: string, limit: number): Promise<PointsLedgerEntry[]> {
    return [...this.ledger.values()]
      .filter((entry) => entry.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  async listFreeEntries(userId: string, limit: number): Promise<FreeEntryCredit[]> {
    return [...this.freeEntries.values()]
      .filter((entry) => entry.userId === userId)
      .sort((left, right) => right.grantedAt.localeCompare(left.grantedAt))
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  async applySettlementPlan(plan: DotCastGamificationSettlementPlan): Promise<void> {
    for (const profile of plan.profiles) {
      this.profiles.set(profile.userId, { ...profile });
    }

    for (const entry of plan.ledger) {
      if (!this.ledger.has(entry.id)) {
        this.ledger.set(entry.id, { ...entry });
      }
    }

    for (const credit of plan.freeEntries) {
      if (!this.freeEntries.has(credit.id)) {
        this.freeEntries.set(credit.id, { ...credit });
      }
    }

    if (!this.settlements.has(plan.settlement.poolId)) {
      this.settlements.set(plan.settlement.poolId, { ...plan.settlement });
    }
  }
}

function settledPointsSnapshot(): DotCastPoolSnapshot {
  return {
    pool: {
      id: "pool-e8",
      marketId: "kalshi:e8",
      venue: "kalshi",
      unit: "points",
      question: "Will E8 reward settled predictions?",
      status: "settled",
      entryOpensAt: "2099-06-25T17:00:00.000Z",
      entryClosesAt: "2099-06-25T17:05:00.000Z",
      expectedResolveAt: "2099-06-25T17:10:00.000Z",
      rake: 0.05,
      pools: { yes: 700, no: 300 },
      minLiquidity: 1,
      createdAt: "2099-06-25T17:00:00.000Z",
      settledAt: "2099-06-25T17:06:00.000Z",
      outcome: "yes"
    },
    entries: [
      {
        id: "yes-entry",
        poolId: "pool-e8",
        userId: "yes-user",
        side: "yes",
        amount: 700,
        funding: "user",
        placedAt: "2099-06-25T17:01:00.000Z",
        payout: 985,
        refunded: false
      },
      {
        id: "no-entry",
        poolId: "pool-e8",
        userId: "no-user",
        side: "no",
        amount: 300,
        funding: "user",
        placedAt: "2099-06-25T17:02:00.000Z",
        payout: 0,
        refunded: false
      }
    ],
    balances: {},
    houseLedger: [],
    settlement: {
      id: "settlement:pool-e8:yes",
      poolId: "pool-e8",
      outcome: "yes",
      totalStaked: 1_000,
      payoutTotal: 985,
      rakeAmount: 15,
      createdAt: "2099-06-25T17:06:00.000Z"
    },
    voidReason: null,
    lastResolution: null,
    updatedAt: "2099-06-25T17:06:00.000Z"
  };
}
