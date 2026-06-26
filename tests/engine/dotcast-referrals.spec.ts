import { describe, expect, it } from "vitest";
import {
  applyDotCastReferralQualification,
  claimDotCastReferral,
  createDotCastReferralCode,
  D1DotCastReferralStore,
  readDotCastReferralStatus,
  readDotCastReferralUserSummary,
  type DotCastGamificationProfile,
  type DotCastReferral,
  type DotCastReferralAmlFlag,
  type DotCastReferralCode,
  type DotCastReferralEvent,
  type DotCastReferralIdentityBinding,
  type DotCastReferralQualificationPlan,
  type DotCastReferralReward,
  type DotCastReferralStore,
  type FreeEntryCredit
} from "../../src/engine/dotcast";

describe("dotCast E12 referrals", () => {
  it("reports deposit-gated readiness and fixed referral safeguards", () => {
    expect(readDotCastReferralStatus({}, true)).toMatchObject({
      enabled: true,
      ready: true,
      threshold: 3,
      qualifier: "first_deposit",
      rewardBoth: true,
      freeEntryReward: 1,
      maxPerPeriod: 30,
      safeguards: {
        signupOnlyQualification: false,
        cashRewards: false,
        requiresDistinctWalletIdentity: true,
        perReferrerCap: true,
        usesP6FreeEntryLedger: true,
        rewardGrantReason: "referral"
      }
    });
    expect(readDotCastReferralStatus({}, false)).toMatchObject({
      ready: false,
      guards: ["referral database not configured"]
    });
  });

  it("does not qualify on signup and grants P6 free entries after first deposits", async () => {
    const store = new InMemoryReferralStore();
    const env = referralEnv();

    await createDotCastReferralCode(store, env, {
      userId: "referrer",
      identityHash: "wallet-referrer-0001",
      code: "alpha",
      now: "2099-06-28T17:00:00.000Z"
    });

    const referrals: DotCastReferral[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const claimed = await claimDotCastReferral(store, env, {
        code: "alpha",
        referredUserId: `referred-${index}`,
        referredIdentityHash: `wallet-referred-000${index}`,
        now: `2099-06-28T17:0${index}:00.000Z`
      });
      referrals.push(claimed.referral);
    }

    await expect(
      applyDotCastReferralQualification(store, env, {
        referralId: referrals[0]?.referralId,
        eventType: "signup",
        now: "2099-06-28T17:10:00.000Z"
      })
    ).rejects.toMatchObject({
      code: "REFERRAL_SIGNUP_ONLY_NOT_QUALIFYING",
      status: 409
    });

    for (let index = 0; index < referrals.length; index += 1) {
      await applyDotCastReferralQualification(store, env, {
        referralId: referrals[index]?.referralId,
        eventType: "first_deposit",
        depositAmount: 1_000_000,
        txRef: `deposit-${index + 1}`,
        now: `2099-06-28T17:1${index}:00.000Z`
      });
    }

    const summary = await readDotCastReferralUserSummary(store, "referrer");
    expect(summary.outboundReferrals).toHaveLength(3);
    expect([...store.freeEntries.values()]).toHaveLength(4);
    expect([...store.freeEntries.values()].map((credit) => credit.grantReason)).toEqual([
      "referral",
      "referral",
      "referral",
      "referral"
    ]);
    expect(store.profiles.get("referrer")).toMatchObject({
      freeEntriesGranted: 1
    });
    expect(store.profiles.get("referred-1")).toMatchObject({
      freeEntriesGranted: 1
    });
    expect(
      store.rewards.get(`dotcast:e12:reward:${referrals[2]?.referralId}:referrer`)
    ).toMatchObject({
      role: "referrer",
      status: "granted",
      freeEntriesGranted: 1
    });
  });

  it("blocks shared and duplicate bound wallet identities", async () => {
    const store = new InMemoryReferralStore();
    const env = referralEnv();

    await createDotCastReferralCode(store, env, {
      userId: "referrer",
      identityHash: "wallet-referrer-0001",
      code: "anti-sybil",
      now: "2099-06-28T17:00:00.000Z"
    });

    await expect(
      claimDotCastReferral(store, env, {
        code: "anti-sybil",
        referredUserId: "same-wallet",
        referredIdentityHash: "wallet-referrer-0001",
        now: "2099-06-28T17:01:00.000Z"
      })
    ).rejects.toMatchObject({
      code: "REFERRAL_SYBIL_IDENTITY_MATCH",
      status: 409
    });

    await claimDotCastReferral(store, env, {
      code: "anti-sybil",
      referredUserId: "first-device",
      referredIdentityHash: "wallet-device-0001",
      now: "2099-06-28T17:02:00.000Z"
    });

    await expect(
      claimDotCastReferral(store, env, {
        code: "anti-sybil",
        referredUserId: "second-device",
        referredIdentityHash: "wallet-device-0001",
        now: "2099-06-28T17:03:00.000Z"
      })
    ).rejects.toMatchObject({
      code: "REFERRAL_DUPLICATE_BOUND_IDENTITY",
      status: 409
    });
  });

  it("enforces the per-referrer period cap", async () => {
    const store = new InMemoryReferralStore();
    const env = referralEnv({
      DOTCAST_REFERRAL_MAX_PER_PERIOD: "2"
    });

    await createDotCastReferralCode(store, env, {
      userId: "referrer-cap",
      identityHash: "wallet-referrer-cap",
      code: "cap",
      now: "2099-06-28T17:00:00.000Z"
    });

    const referrals: DotCastReferral[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const claim = await claimDotCastReferral(store, env, {
        code: "cap",
        referredUserId: `cap-user-${index}`,
        referredIdentityHash: `wallet-cap-user-${index}`,
        now: `2099-06-28T17:0${index}:00.000Z`
      });
      referrals.push(claim.referral);
    }

    await applyDotCastReferralQualification(store, env, {
      referralId: referrals[0]?.referralId,
      eventType: "first_deposit",
      depositAmount: 1,
      txRef: "cap-1",
      now: "2099-06-28T17:10:00.000Z"
    });
    await applyDotCastReferralQualification(store, env, {
      referralId: referrals[1]?.referralId,
      eventType: "first_deposit",
      depositAmount: 1,
      txRef: "cap-2",
      now: "2099-06-28T17:11:00.000Z"
    });
    const capped = await applyDotCastReferralQualification(store, env, {
      referralId: referrals[2]?.referralId,
      eventType: "first_deposit",
      depositAmount: 1,
      txRef: "cap-3",
      now: "2099-06-28T17:12:00.000Z"
    });

    expect(capped.qualified).toBe(false);
    expect(capped.referral).toMatchObject({
      status: "rejected",
      rejectedReason: "referrer_period_cap_exceeded"
    });
  });

  it("supports the KYC plus first-entry qualifier alternative", async () => {
    const store = new InMemoryReferralStore();
    const env = referralEnv({
      DOTCAST_REFERRAL_QUALIFY: "kyc_plus_first_entry"
    });

    await createDotCastReferralCode(store, env, {
      userId: "referrer-kyc",
      identityHash: "wallet-referrer-kyc",
      code: "kyc",
      now: "2099-06-28T17:00:00.000Z"
    });
    const claim = await claimDotCastReferral(store, env, {
      code: "kyc",
      referredUserId: "kyc-user",
      referredIdentityHash: "wallet-kyc-user",
      now: "2099-06-28T17:01:00.000Z"
    });

    await expect(
      applyDotCastReferralQualification(store, env, {
        referralId: claim.referral.referralId,
        eventType: "first_deposit",
        depositAmount: 1,
        txRef: "wrong-qualifier",
        now: "2099-06-28T17:02:00.000Z"
      })
    ).rejects.toMatchObject({
      code: "REFERRAL_QUALIFIER_MISMATCH"
    });

    const qualified = await applyDotCastReferralQualification(store, env, {
      referralId: claim.referral.referralId,
      eventType: "kyc_plus_first_entry",
      kycComplete: true,
      firstAdFundedEntryEarned: true,
      now: "2099-06-28T17:03:00.000Z"
    });

    expect(qualified).toMatchObject({
      qualified: true,
      referral: {
        status: "rewarded",
        qualifier: "kyc_plus_first_entry"
      }
    });
  });

  it("flags deposit-refer-withdraw rings for AML review", async () => {
    const store = new InMemoryReferralStore();
    const env = referralEnv();

    await createDotCastReferralCode(store, env, {
      userId: "referrer-ring",
      identityHash: "wallet-ring-referrer",
      code: "ring",
      now: "2099-06-28T17:00:00.000Z"
    });
    const claim = await claimDotCastReferral(store, env, {
      code: "ring",
      referredUserId: "ring-user",
      referredIdentityHash: "wallet-ring-referred",
      now: "2099-06-28T17:01:00.000Z"
    });
    const qualified = await applyDotCastReferralQualification(store, env, {
      referralId: claim.referral.referralId,
      eventType: "first_deposit",
      depositAmount: 1_000_000,
      txRef: "ring-deposit",
      withdrawalWithinHours: 6,
      relatedIdentityHashes: ["wallet-ring-a", "wallet-ring-b"],
      relatedReferralIds: ["ring-related-1", "ring-related-2"],
      now: "2099-06-28T17:02:00.000Z"
    });

    expect(qualified.amlFlags).toEqual([
      expect.objectContaining({
        reason: "deposit_refer_withdraw_ring",
        severity: "high",
        relatedReferralIds: [claim.referral.referralId, "ring-related-1", "ring-related-2"]
      })
    ]);
  });

  it("maps D1 referral rows and batches ledger writes", async () => {
    const fakeD1 = new FakeReferralD1();
    const store = new D1DotCastReferralStore(fakeD1.database());
    const code = await store.getCode("D1-Alpha");
    const codeByUser = await store.getCodeByUser("referrer-d1");
    const identity = await store.getIdentity("referrer-d1");
    const referral = await store.getReferral("referral-d1");
    const referralByUser = await store.getReferralByReferredUser("referred-d1");
    const referralByKey = await store.getReferralByIdempotencyKey("claim-d1");
    const [qualifiedCount, identityCount, outbound, rewards, rewardsByReferral, flags, profile] =
      await Promise.all([
        store.countQualifiedReferralsByReferrer(
          "referrer-d1",
          "2099-06-01T00:00:00.000Z",
          "2099-07-01T00:00:00.000Z"
        ),
        store.countReferralIdentityByReferrer("referrer-d1", "wallet-referred-d1"),
        store.listReferralsByReferrer("referrer-d1", 5),
        store.listRewardsByUser("referred-d1", 5),
        store.listRewardsByReferral("referral-d1"),
        store.listAmlFlagsByUser("referrer-d1", 5),
        store.getProfile("referred-d1")
      ]);

    expect(code).toMatchObject({
      code: "d1-alpha",
      userId: "referrer-d1",
      status: "active"
    });
    expect(codeByUser?.code).toBe("d1-alpha");
    expect(identity).toMatchObject({
      identityHash: "wallet-referrer-d1",
      kycComplete: true
    });
    expect(referral).toMatchObject({
      referralId: "referral-d1",
      status: "rewarded",
      qualifier: "first_deposit"
    });
    expect(referralByUser?.referralId).toBe(referral?.referralId);
    expect(referralByKey?.referralId).toBe(referral?.referralId);
    expect(qualifiedCount).toBe(2);
    expect(identityCount).toBe(1);
    expect(outbound).toHaveLength(1);
    expect(rewards).toEqual([
      expect.objectContaining({
        role: "referred",
        status: "granted",
        creditIds: ["credit-d1"]
      })
    ]);
    expect(rewardsByReferral).toHaveLength(1);
    expect(flags).toEqual([
      expect.objectContaining({
        reason: "deposit_refer_withdraw_ring",
        severity: "high"
      })
    ]);
    expect(profile).toMatchObject({
      userId: "referred-d1",
      freeEntriesGranted: 1
    });

    if (!code || !identity || !referral) {
      throw new Error("expected D1 fixtures to be present");
    }

    await store.createReferralCode(code, identity, referralEvent("REFERRAL_CODE_CREATED"));
    await store.claimReferral(
      referral,
      identity,
      {
        ...identity,
        userId: "referred-d1",
        identityHash: "wallet-referred-d1"
      },
      referralEvent("REFERRAL_CLAIMED")
    );
    await store.applyQualificationPlan({
      referral,
      referrerIdentity: identity,
      referredIdentity: {
        ...identity,
        userId: "referred-d1",
        identityHash: "wallet-referred-d1"
      },
      profiles: profile ? [profile] : [],
      rewards,
      freeEntries: [
        {
          id: "credit-d1",
          userId: "referred-d1",
          grantReason: "referral",
          poolId: null,
          grantedAt: "2099-06-28T17:02:00.000Z",
          expiresAt: "2099-07-28T17:02:00.000Z",
          consumedAt: null,
          consumedByEntryId: null,
          eventJson: { source: "d1-test" }
        }
      ],
      events: [referralEvent("REFERRAL_QUALIFIED"), referralEvent("REFERRAL_REWARDED")],
      amlFlags: flags
    });

    expect(fakeD1.batchSizes).toEqual([3, 4, 9]);
  });
});

class InMemoryReferralStore implements DotCastReferralStore {
  readonly codes = new Map<string, DotCastReferralCode>();
  readonly identities = new Map<string, DotCastReferralIdentityBinding>();
  readonly referrals = new Map<string, DotCastReferral>();
  readonly rewards = new Map<string, DotCastReferralReward>();
  readonly freeEntries = new Map<string, FreeEntryCredit>();
  readonly profiles = new Map<string, DotCastGamificationProfile>();
  readonly amlFlags = new Map<string, DotCastReferralAmlFlag>();
  readonly events = new Map<string, DotCastReferralEvent>();

  async getCode(code: string): Promise<DotCastReferralCode | null> {
    return this.codes.get(code.toLowerCase()) ?? null;
  }

  async getCodeByUser(userId: string): Promise<DotCastReferralCode | null> {
    return [...this.codes.values()].find((code) => code.userId === userId) ?? null;
  }

  async getIdentity(userId: string): Promise<DotCastReferralIdentityBinding | null> {
    return this.identities.get(userId) ?? null;
  }

  async getReferral(referralId: string): Promise<DotCastReferral | null> {
    return this.referrals.get(referralId) ?? null;
  }

  async getReferralByReferredUser(userId: string): Promise<DotCastReferral | null> {
    return (
      [...this.referrals.values()].find((referral) => referral.referredUserId === userId) ?? null
    );
  }

  async getReferralByIdempotencyKey(idempotencyKey: string): Promise<DotCastReferral | null> {
    return (
      [...this.referrals.values()].find((referral) => referral.idempotencyKey === idempotencyKey) ??
      null
    );
  }

  async countQualifiedReferralsByReferrer(
    referrerUserId: string,
    periodStart: string,
    periodEnd: string
  ): Promise<number> {
    return [...this.referrals.values()].filter(
      (referral) =>
        referral.referrerUserId === referrerUserId &&
        (referral.status === "qualified" || referral.status === "rewarded") &&
        referral.qualifiedAt !== null &&
        referral.qualifiedAt >= periodStart &&
        referral.qualifiedAt < periodEnd
    ).length;
  }

  async countReferralIdentityByReferrer(
    referrerUserId: string,
    identityHash: string
  ): Promise<number> {
    return [...this.referrals.values()].filter(
      (referral) =>
        referral.referrerUserId === referrerUserId &&
        referral.referredIdentityHash === identityHash.toLowerCase()
    ).length;
  }

  async listReferralsByReferrer(referrerUserId: string, limit: number): Promise<DotCastReferral[]> {
    return [...this.referrals.values()]
      .filter((referral) => referral.referrerUserId === referrerUserId)
      .slice(0, limit);
  }

  async listRewardsByUser(userId: string, limit: number): Promise<DotCastReferralReward[]> {
    return [...this.rewards.values()].filter((reward) => reward.userId === userId).slice(0, limit);
  }

  async listRewardsByReferral(referralId: string): Promise<DotCastReferralReward[]> {
    return [...this.rewards.values()].filter((reward) => reward.referralId === referralId);
  }

  async listAmlFlagsByUser(userId: string, limit: number): Promise<DotCastReferralAmlFlag[]> {
    return [...this.amlFlags.values()]
      .filter((flag) => flag.referrerUserId === userId || flag.referredUserId === userId)
      .slice(0, limit);
  }

  async getProfile(userId: string): Promise<DotCastGamificationProfile | null> {
    return this.profiles.get(userId) ?? null;
  }

  async createReferralCode(
    code: DotCastReferralCode,
    identity: DotCastReferralIdentityBinding,
    event: DotCastReferralEvent
  ): Promise<void> {
    this.codes.set(code.code, code);
    this.identities.set(identity.userId, identity);
    this.events.set(event.eventId, event);
  }

  async claimReferral(
    referral: DotCastReferral,
    referrerIdentity: DotCastReferralIdentityBinding,
    referredIdentity: DotCastReferralIdentityBinding,
    event: DotCastReferralEvent
  ): Promise<void> {
    this.referrals.set(referral.referralId, referral);
    this.identities.set(referrerIdentity.userId, referrerIdentity);
    this.identities.set(referredIdentity.userId, referredIdentity);
    this.events.set(event.eventId, event);
  }

  async applyQualificationPlan(plan: DotCastReferralQualificationPlan): Promise<void> {
    this.referrals.set(plan.referral.referralId, plan.referral);
    this.identities.set(plan.referrerIdentity.userId, plan.referrerIdentity);
    this.identities.set(plan.referredIdentity.userId, plan.referredIdentity);

    for (const profile of plan.profiles) {
      this.profiles.set(profile.userId, profile);
    }

    for (const reward of plan.rewards) {
      this.rewards.set(reward.rewardId, reward);
    }

    for (const credit of plan.freeEntries) {
      this.freeEntries.set(credit.id, credit);
    }

    for (const flag of plan.amlFlags) {
      this.amlFlags.set(flag.flagId, flag);
    }

    for (const event of plan.events) {
      this.events.set(event.eventId, event);
    }
  }
}

function referralEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DOTCAST_REFERRALS_ENABLED: "true",
    DOTCAST_REFERRAL_THRESHOLD: "3",
    DOTCAST_REFERRAL_QUALIFY: "first_deposit",
    DOTCAST_REFERRAL_REWARD_BOTH: "true",
    DOTCAST_REFERRAL_MAX_PER_PERIOD: "30",
    DOTCAST_REFERRAL_PERIOD_DAYS: "30",
    DOTCAST_REFERRAL_FREE_ENTRY_REWARD: "1",
    DOTCAST_REFERRAL_FREE_ENTRY_TTL_DAYS: "30",
    DOTCAST_REFERRAL_AML_MIN_RING_SIZE: "3",
    DOTCAST_GAMIFICATION_MAX_FREE_ENTRY_CREDITS: "10",
    ...overrides
  };
}

class FakeReferralD1 {
  readonly batchSizes: number[] = [];

  database(): D1Database {
    return this as unknown as D1Database;
  }

  prepare(sql: string): FakeReferralD1Statement {
    return new FakeReferralD1Statement(this, sql);
  }

  async batch(statements: unknown[]): Promise<unknown[]> {
    this.batchSizes.push(statements.length);
    return [];
  }

  first(sql: string): Record<string, unknown> | null {
    if (sql.includes("COUNT(*)")) {
      return { count: sql.includes("qualified_at") ? 2 : 1 };
    }

    if (sql.includes("FROM dotcast_referral_codes")) {
      return referralCodeRow();
    }

    if (sql.includes("FROM dotcast_referral_identity_bindings")) {
      return referralIdentityRow();
    }

    if (sql.includes("FROM dotcast_referrals")) {
      return referralRow();
    }

    if (sql.includes("FROM dotcast_gamification_profiles")) {
      return referralProfileRow();
    }

    return null;
  }

  all(sql: string): Record<string, unknown>[] {
    if (sql.includes("FROM dotcast_referrals")) {
      return [referralRow()];
    }

    if (sql.includes("FROM dotcast_referral_rewards")) {
      return [referralRewardRow()];
    }

    if (sql.includes("FROM dotcast_referral_aml_flags")) {
      return [referralAmlFlagRow()];
    }

    return [];
  }
}

class FakeReferralD1Statement {
  private params: unknown[] = [];

  constructor(
    private readonly db: FakeReferralD1,
    private readonly sql: string
  ) {}

  bind(...params: unknown[]): this {
    this.params = params;
    return this;
  }

  async first(): Promise<Record<string, unknown> | null> {
    void this.params;
    return this.db.first(this.sql);
  }

  async all(): Promise<{ results: Record<string, unknown>[] }> {
    void this.params;
    return { results: this.db.all(this.sql) };
  }
}

function referralEvent(eventType: DotCastReferralEvent["eventType"]): DotCastReferralEvent {
  return {
    eventId: `event-${eventType}`,
    referralId: "referral-d1",
    referrerUserId: "referrer-d1",
    referredUserId: "referred-d1",
    eventType,
    eventJson: { source: "d1-test" },
    createdAt: "2099-06-28T17:02:00.000Z"
  };
}

function referralCodeRow(): Record<string, unknown> {
  return {
    code: "d1-alpha",
    user_id: "referrer-d1",
    identity_hash: "wallet-referrer-d1",
    status: "active",
    created_at: "2099-06-28T17:00:00.000Z",
    updated_at: "2099-06-28T17:00:00.000Z"
  };
}

function referralIdentityRow(): Record<string, unknown> {
  return {
    user_id: "referrer-d1",
    identity_hash: "wallet-referrer-d1",
    wallet_address: "wallet-address-d1",
    kyc_complete: 1,
    first_entry_earned: 1,
    first_deposit_at: "2099-06-28T17:01:00.000Z",
    last_withdrawal_at: "2099-06-28T18:01:00.000Z",
    updated_at: "2099-06-28T18:01:00.000Z"
  };
}

function referralRow(): Record<string, unknown> {
  return {
    referral_id: "referral-d1",
    code: "d1-alpha",
    referrer_user_id: "referrer-d1",
    referred_user_id: "referred-d1",
    referrer_identity_hash: "wallet-referrer-d1",
    referred_identity_hash: "wallet-referred-d1",
    qualifier: "first_deposit",
    status: "rewarded",
    qualified_at: "2099-06-28T17:02:00.000Z",
    rejected_reason: null,
    reward_batch_id: "batch-d1",
    idempotency_key: "claim-d1",
    event_json: JSON.stringify({ source: "d1-test" }),
    created_at: "2099-06-28T17:00:00.000Z",
    updated_at: "2099-06-28T17:02:00.000Z"
  };
}

function referralRewardRow(): Record<string, unknown> {
  return {
    reward_id: "reward-d1",
    referral_id: "referral-d1",
    reward_batch_id: "batch-d1",
    user_id: "referred-d1",
    role: "referred",
    status: "granted",
    free_entries_granted: 1,
    suppressed_reason: null,
    credit_ids_json: JSON.stringify(["credit-d1"]),
    idempotency_key: "reward-d1",
    event_json: JSON.stringify({ source: "d1-test" }),
    created_at: "2099-06-28T17:02:00.000Z"
  };
}

function referralAmlFlagRow(): Record<string, unknown> {
  return {
    flag_id: "flag-d1",
    referrer_user_id: "referrer-d1",
    referred_user_id: "referred-d1",
    cluster_key: "cluster-d1",
    reason: "deposit_refer_withdraw_ring",
    severity: "high",
    related_referral_ids_json: JSON.stringify(["referral-d1"]),
    related_identity_hashes_json: JSON.stringify(["wallet-referrer-d1", "wallet-referred-d1"]),
    event_json: JSON.stringify({ source: "d1-test" }),
    created_at: "2099-06-28T17:02:00.000Z"
  };
}

function referralProfileRow(): Record<string, unknown> {
  return {
    user_id: "referred-d1",
    points_balance: 0,
    current_streak: 0,
    longest_streak: 0,
    settled_predictions: 0,
    correct_predictions: 0,
    incorrect_predictions: 0,
    free_entries_granted: 1,
    free_entries_consumed: 0,
    last_settled_pool_id: null,
    last_settled_at: null,
    updated_at: "2099-06-28T17:02:00.000Z"
  };
}
