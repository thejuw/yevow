import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyDotCastCreatorRakeShareSettlement,
  calculateCreatorEffectiveShareBps,
  confirmDotCastCreatorPayout,
  onboardDotCastCreator,
  planCreatorPoolNudges,
  readDotCastCreatorSummary,
  readDotCastCreatorEconomyStatus,
  recordDotCastCreatorPoolSeed,
  requestDotCastCreatorPayout,
  type DotCastCreatorEarningsBalance,
  type DotCastCreatorEvent,
  type DotCastCreatorPayout,
  type DotCastCreatorPoolSeed,
  type DotCastCreatorProfile,
  type DotCastCreatorRakeAccrual,
  type DotCastCreatorStore,
  type DotCastPoolSnapshot,
  type DotCastSettlementBalance,
  type DotCastSettlementRailEvent,
  type DotCastSettlementRailStore,
  type DotCastSettlementTransfer,
  type StakeUnit
} from "../../src/engine/dotcast";

describe("dotCast E11 creator economy", () => {
  it("reports readiness and fixed creator integrity-wall defaults", () => {
    expect(readDotCastCreatorEconomyStatus(devnetEnv(), true)).toMatchObject({
      enabled: true,
      ready: true,
      tierSharesBps: {
        casual: 1000,
        verified: 2500,
        partner: 4000
      },
      payoutSchedule: "manual",
      guards: [],
      integrityWall: {
        resolutionWriteAccess: false,
        oddsWriteAccess: false,
        userLimitBypass: false,
        urgencyTooling: false,
        separateCreatorLedger: true,
        payoutRail: "p5-solana-usdc"
      }
    });
    expect(readDotCastCreatorEconomyStatus(devnetEnv(), false)).toMatchObject({
      ready: false,
      guards: ["creator economy database not configured"]
    });
  });

  it("accrues creator rake-share from a settled attributed pool with conservation and idempotency", async () => {
    const store = new InMemoryCreatorStore();
    const env = devnetEnv();
    const onboarded = await onboardDotCastCreator(store, env, {
      creatorId: "creator-alpha",
      displayName: "Alpha Desk",
      tier: "verified",
      kycStatus: "verified",
      payoutDestination: "11111111111111111111111111111111",
      accuracyBps: 8000,
      retentionBps: 9000,
      volumeScore: 1_000_000,
      manualReviewRequired: false,
      now: "2099-06-27T17:00:00.000Z"
    });
    const settled = settledSnapshot({
      creatorId: "creator-alpha",
      unit: "usdc",
      rakeAmount: 1_000_000
    });
    const first = await applyDotCastCreatorRakeShareSettlement(
      store,
      env,
      {
        snapshot: settled,
        now: "2099-06-27T17:05:00.000Z"
      },
      true
    );
    const replay = await applyDotCastCreatorRakeShareSettlement(
      store,
      env,
      {
        snapshot: settled,
        now: "2099-06-27T17:06:00.000Z"
      },
      true
    );

    expect(first.applied).toBe(true);
    expect(first.idempotent).toBe(false);
    expect(first.accrual).toMatchObject({
      creatorId: "creator-alpha",
      poolId: "pool-e11",
      unit: "usdc",
      totalRake: 1_000_000,
      tier: "verified",
      tierShareBps: 2500
    });
    expect(first.accrual?.creatorShare).toBeGreaterThan(0);
    expect(first.accrual?.creatorShare ?? 0).toBeLessThan(first.accrual?.totalRake ?? 0);
    expect((first.accrual?.creatorShare ?? 0) + (first.accrual?.houseShare ?? 0)).toBe(
      first.accrual?.totalRake
    );
    expect(first.balance).toMatchObject({
      creatorId: "creator-alpha",
      unit: "usdc",
      available: first.accrual?.creatorShare,
      lifetimeAccrued: first.accrual?.creatorShare
    });
    expect(replay.idempotent).toBe(true);
    expect(store.accruals.size).toBe(1);
    expect(onboarded.creator.sponsorshipEligible).toBe(true);
  });

  it("weights share by accuracy and retention rather than volume alone", async () => {
    const status = readDotCastCreatorEconomyStatus(devnetEnv(), true);
    const highRetention = creatorProfile({
      creatorId: "creator-healthy",
      accuracyBps: 7500,
      retentionBps: 9000,
      volumeScore: 1_000_000,
      manualReviewRequired: false
    });
    const churnyVolume = creatorProfile({
      creatorId: "creator-churn",
      accuracyBps: 7500,
      retentionBps: 1500,
      volumeScore: 1_000_000,
      manualReviewRequired: false
    });

    expect(calculateCreatorEffectiveShareBps(highRetention, status)).toBeGreaterThan(
      calculateCreatorEffectiveShareBps(churnyVolume, status)
    );
  });

  it("suppresses creator nudges for self-limits/cooldowns and blocks urgency tooling", () => {
    const plan = planCreatorPoolNudges({
      creatorId: "creator-alpha",
      poolId: "pool-e11",
      now: "2099-06-27T17:00:00.000Z",
      recipients: [
        { userId: "allowed-user" },
        { userId: "self-limited-user", selfLimited: true },
        { userId: "cooldown-user", cooldownUntil: "2099-06-27T17:10:00.000Z" },
        { userId: "loss-limited-user", lossLimited: true }
      ]
    });

    expect(plan.allowed.map((recipient) => recipient.userId)).toEqual(["allowed-user"]);
    expect(plan.suppressed.map((recipient) => recipient.reason)).toEqual([
      "self_limit",
      "cooldown",
      "loss_limit"
    ]);
    expect(() =>
      planCreatorPoolNudges({
        creatorId: "creator-alpha",
        poolId: "pool-e11",
        recipients: [{ userId: "user" }],
        metadata: { countdownSeconds: 60 }
      })
    ).toThrow(/urgency field/);
  });

  it("releases creator payouts through the devnet mock P5 rail with KYC, caps, and idempotency", async () => {
    const store = new InMemoryCreatorStore();
    const railStore = new InMemorySettlementRailStore();
    const env = devnetEnv({
      DOTCAST_CREATOR_PAYOUT_MIN_MINOR_UNITS: "1",
      DOTCAST_CREATOR_PAYOUT_MAX_MINOR_UNITS: "1000000"
    });

    await onboardDotCastCreator(store, env, {
      creatorId: "creator-payout",
      displayName: "Payout Creator",
      tier: "partner",
      kycStatus: "verified",
      payoutDestination: "11111111111111111111111111111111",
      manualReviewRequired: true,
      now: "2099-06-27T17:00:00.000Z"
    });
    await applyDotCastCreatorRakeShareSettlement(
      store,
      env,
      {
        snapshot: settledSnapshot({
          creatorId: "creator-payout",
          unit: "usdc",
          rakeAmount: 1_000_000
        }),
        now: "2099-06-27T17:05:00.000Z"
      },
      true
    );

    const requested = await requestDotCastCreatorPayout(store, railStore, env, {
      creatorId: "creator-payout",
      amount: 250_000,
      destination: "11111111111111111111111111111111",
      idempotencyKey: "creator-payout-1",
      operatorApproved: true,
      now: "2099-06-27T17:06:00.000Z"
    });
    const replayed = await requestDotCastCreatorPayout(store, railStore, env, {
      creatorId: "creator-payout",
      amount: 250_000,
      destination: "11111111111111111111111111111111",
      idempotencyKey: "creator-payout-1",
      operatorApproved: true,
      now: "2099-06-27T17:06:01.000Z"
    });
    const confirmed = await confirmDotCastCreatorPayout(store, railStore, env, {
      payoutId: requested.payout.payoutId,
      txRef: "mock-creator-payout-finalized",
      now: "2099-06-27T17:07:00.000Z"
    });

    expect(requested).toMatchObject({
      idempotent: false,
      payout: {
        status: "signed",
        unit: "usdc",
        amount: 250_000
      },
      balance: {
        pendingPayout: 250_000
      }
    });
    expect(requested.payout.mockSignature).toMatch(/^mock-solana-devnet-/);
    expect(replayed.idempotent).toBe(true);
    expect(confirmed).toMatchObject({
      payout: {
        status: "confirmed",
        railTxRef: "mock-creator-payout-finalized"
      },
      balance: {
        pendingPayout: 0,
        lifetimePaid: 250_000
      }
    });
  });

  it("summarizes creator earnings and rejects payout requests before KYC/operator gates pass", async () => {
    const store = new InMemoryCreatorStore();
    const railStore = new InMemorySettlementRailStore();
    const env = devnetEnv({
      DOTCAST_CREATOR_PAYOUT_MIN_MINOR_UNITS: "1",
      DOTCAST_CREATOR_PAYOUT_MAX_MINOR_UNITS: "1000000"
    });

    await onboardDotCastCreator(store, env, {
      creatorId: "creator-guarded",
      displayName: "Guarded Creator",
      tier: "verified",
      kycStatus: "unverified",
      payoutDestination: "11111111111111111111111111111111",
      now: "2099-06-27T17:00:00.000Z"
    });
    await applyDotCastCreatorRakeShareSettlement(
      store,
      env,
      {
        snapshot: settledSnapshot({
          creatorId: "creator-guarded",
          unit: "usdc",
          rakeAmount: 1_000_000
        }),
        now: "2099-06-27T17:05:00.000Z"
      },
      true
    );

    const summary = await readDotCastCreatorSummary(store, "creator-guarded", 10);
    expect(summary.balances).toHaveLength(1);
    expect(summary.recentAccruals).toHaveLength(1);
    await expect(
      requestDotCastCreatorPayout(store, railStore, env, {
        creatorId: "creator-guarded",
        amount: 1,
        idempotencyKey: "kyc-blocked",
        operatorApproved: true,
        now: "2099-06-27T17:06:00.000Z"
      })
    ).rejects.toMatchObject({
      code: "CREATOR_PAYOUT_REQUIRES_KYC",
      status: 403
    });

    await onboardDotCastCreator(store, env, {
      creatorId: "creator-guarded",
      displayName: "Guarded Creator",
      tier: "verified",
      kycStatus: "verified",
      payoutDestination: "11111111111111111111111111111111",
      now: "2099-06-27T17:07:00.000Z"
    });
    await expect(
      requestDotCastCreatorPayout(store, railStore, env, {
        creatorId: "creator-guarded",
        amount: 1,
        idempotencyKey: "operator-blocked",
        operatorApproved: false,
        now: "2099-06-27T17:08:00.000Z"
      })
    ).rejects.toMatchObject({
      code: "CREATOR_PAYOUT_REQUIRES_OPERATOR_APPROVAL",
      status: 403
    });
  });

  it("gates creator seed-as-boost to oracle-bound markets and records disclosure provenance", async () => {
    const store = new InMemoryCreatorStore();
    const env = devnetEnv();

    await onboardDotCastCreator(store, env, {
      creatorId: "creator-seed",
      displayName: "Seed Creator",
      tier: "verified",
      now: "2099-06-27T17:00:00.000Z"
    });
    await expect(
      recordDotCastCreatorPoolSeed(store, env, {
        creatorId: "creator-seed",
        poolId: "pool-subjective",
        unit: "usdc",
        amount: 100_000,
        mode: "boost_winners",
        resolutionBinding: "jury",
        now: "2099-06-27T17:01:00.000Z"
      })
    ).rejects.toMatchObject({
      code: "CREATOR_SEED_REQUIRES_ORACLE_BOUND_MARKET",
      status: 409
    });

    const accepted = await recordDotCastCreatorPoolSeed(store, env, {
      creatorId: "creator-seed",
      poolId: "pool-oracle",
      unit: "usdc",
      amount: 100_000,
      mode: "boost_winners",
      resolutionBinding: "oracle_bound",
      creatorHoldsPosition: true,
      now: "2099-06-27T17:02:00.000Z"
    });

    expect(accepted.seed).toMatchObject({
      status: "accepted",
      disclosureLabel: "Creator seed",
      creatorHoldsPosition: true,
      eventJson: {
        seedAmountRaked: false,
        resolutionInfluence: false
      }
    });
    expect(store.seeds.size).toBe(1);
  });

  it("keeps E11 architecturally blocked from odds and resolution control", () => {
    const source = readFileSync("src/engine/dotcast/CreatorEconomy.ts", "utf8");

    expect(source).not.toMatch(/from "\.\/(DotCastPoolDO|PoolSettlement|Parimutuel)"/);
    expect(source).not.toContain("settlePoolSnapshot");
    expect(source).not.toContain("fetchDotCastRouterResolution");
  });
});

class InMemoryCreatorStore implements DotCastCreatorStore {
  readonly creators = new Map<string, DotCastCreatorProfile>();
  readonly balances = new Map<string, DotCastCreatorEarningsBalance>();
  readonly accruals = new Map<string, DotCastCreatorRakeAccrual>();
  readonly payouts = new Map<string, DotCastCreatorPayout>();
  readonly seeds = new Map<string, DotCastCreatorPoolSeed>();
  readonly events: DotCastCreatorEvent[] = [];

  async getCreator(creatorId: string): Promise<DotCastCreatorProfile | null> {
    return this.creators.get(creatorId) ?? null;
  }

  async upsertCreator(creator: DotCastCreatorProfile, event: DotCastCreatorEvent): Promise<void> {
    this.creators.set(creator.creatorId, { ...creator });
    this.events.push({ ...event });
  }

  async getBalance(
    creatorId: string,
    unit: StakeUnit
  ): Promise<DotCastCreatorEarningsBalance | null> {
    return this.balances.get(balanceKey(creatorId, unit)) ?? null;
  }

  async listBalances(creatorId: string): Promise<DotCastCreatorEarningsBalance[]> {
    return [...this.balances.values()].filter((balance) => balance.creatorId === creatorId);
  }

  async getAccrualByPool(poolId: string): Promise<DotCastCreatorRakeAccrual | null> {
    return [...this.accruals.values()].find((accrual) => accrual.poolId === poolId) ?? null;
  }

  async listAccruals(creatorId: string, limit: number): Promise<DotCastCreatorRakeAccrual[]> {
    return [...this.accruals.values()]
      .filter((accrual) => accrual.creatorId === creatorId)
      .slice(0, limit);
  }

  async listPayouts(creatorId: string, limit: number): Promise<DotCastCreatorPayout[]> {
    return [...this.payouts.values()]
      .filter((payout) => payout.creatorId === creatorId)
      .slice(0, limit);
  }

  async applyAccrual(
    accrual: DotCastCreatorRakeAccrual,
    balance: DotCastCreatorEarningsBalance,
    event: DotCastCreatorEvent
  ): Promise<void> {
    this.accruals.set(accrual.accrualId, { ...accrual });
    this.balances.set(balanceKey(balance.creatorId, balance.unit), { ...balance });
    this.events.push({ ...event });
  }

  async getPayout(payoutId: string): Promise<DotCastCreatorPayout | null> {
    return this.payouts.get(payoutId) ?? null;
  }

  async getPayoutByIdempotencyKey(idempotencyKey: string): Promise<DotCastCreatorPayout | null> {
    return (
      [...this.payouts.values()].find((payout) => payout.idempotencyKey === idempotencyKey) ?? null
    );
  }

  async insertPayout(
    payout: DotCastCreatorPayout,
    balance: DotCastCreatorEarningsBalance,
    event: DotCastCreatorEvent
  ): Promise<void> {
    this.payouts.set(payout.payoutId, { ...payout });
    this.balances.set(balanceKey(balance.creatorId, balance.unit), { ...balance });
    this.events.push({ ...event });
  }

  async updatePayout(
    payout: DotCastCreatorPayout,
    balance: DotCastCreatorEarningsBalance,
    event: DotCastCreatorEvent
  ): Promise<void> {
    this.payouts.set(payout.payoutId, { ...payout });
    this.balances.set(balanceKey(balance.creatorId, balance.unit), { ...balance });
    this.events.push({ ...event });
  }

  async insertSeed(seed: DotCastCreatorPoolSeed, event: DotCastCreatorEvent): Promise<void> {
    this.seeds.set(seed.seedId, { ...seed });
    this.events.push({ ...event });
  }

  async appendEvent(event: DotCastCreatorEvent): Promise<void> {
    this.events.push({ ...event });
  }
}

class InMemorySettlementRailStore implements DotCastSettlementRailStore {
  readonly balances = new Map<string, DotCastSettlementBalance>();
  readonly transfers = new Map<string, DotCastSettlementTransfer>();
  readonly events: DotCastSettlementRailEvent[] = [];

  async getBalance(userId: string): Promise<DotCastSettlementBalance | null> {
    return this.balances.get(userId) ?? null;
  }

  async saveBalance(balance: DotCastSettlementBalance): Promise<void> {
    this.balances.set(balance.userId, { ...balance });
  }

  async listBalances(): Promise<DotCastSettlementBalance[]> {
    return [...this.balances.values()];
  }

  async getTransfer(transferId: string): Promise<DotCastSettlementTransfer | null> {
    return this.transfers.get(transferId) ?? null;
  }

  async getTransferByTxRef(txRef: string): Promise<DotCastSettlementTransfer | null> {
    return [...this.transfers.values()].find((transfer) => transfer.txRef === txRef) ?? null;
  }

  async insertTransfer(transfer: DotCastSettlementTransfer): Promise<void> {
    this.transfers.set(transfer.transferId, { ...transfer });
  }

  async updateTransfer(transfer: DotCastSettlementTransfer): Promise<void> {
    this.transfers.set(transfer.transferId, { ...transfer });
  }

  async appendEvent(event: DotCastSettlementRailEvent): Promise<void> {
    if (!this.events.some((candidate) => candidate.eventId === event.eventId)) {
      this.events.push({ ...event });
    }
  }
}

function devnetEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DOTCAST_CREATOR_ECONOMY_ENABLED: "true",
    DOTCAST_CREATOR_RAKE_SHARE_CASUAL_BPS: "1000",
    DOTCAST_CREATOR_RAKE_SHARE_VERIFIED_BPS: "2500",
    DOTCAST_CREATOR_RAKE_SHARE_PARTNER_BPS: "4000",
    DOTCAST_CREATOR_PAYOUT_MIN_MINOR_UNITS: "500000",
    DOTCAST_CREATOR_PAYOUT_MAX_MINOR_UNITS: "1000000",
    DOTCAST_CREATOR_PAYOUT_SCHEDULE: "manual",
    DOTCAST_CREATOR_MIN_RETENTION_BPS: "2500",
    DOTCAST_SETTLEMENT_RAIL_MODE: "devnet",
    DOTCAST_SOLANA_CLUSTER: "devnet",
    DOTCAST_SETTLEMENT_SIGNER_MODE: "mock",
    DOTCAST_OPERATOR_WITHDRAWALS_APPROVED: "false",
    DOTCAST_WITHDRAWAL_MAX_MINOR_UNITS: "1000000",
    DOTCAST_DEPOSIT_CONFIRMATIONS_REQUIRED: "1",
    ...overrides
  };
}

function settledSnapshot(input: {
  creatorId: string;
  unit: StakeUnit;
  rakeAmount: number;
}): DotCastPoolSnapshot {
  return {
    pool: {
      id: "pool-e11",
      marketId: "kalshi:e11",
      venue: "kalshi",
      unit: input.unit,
      question: "Will E11 credit creators?",
      status: "settled",
      entryOpensAt: "2099-06-27T17:00:00.000Z",
      entryClosesAt: "2099-06-27T17:01:00.000Z",
      expectedResolveAt: "2099-06-27T17:04:00.000Z",
      rake: 0.05,
      pools: { yes: 7_000_000, no: 3_000_000 },
      minLiquidity: 0,
      createdAt: "2099-06-27T17:00:00.000Z",
      settledAt: "2099-06-27T17:05:00.000Z",
      outcome: "yes",
      originatingCreatorId: input.creatorId,
      creatorBrand: {
        creatorId: input.creatorId,
        displayName: "Creator",
        disclosureLabel: "Creator-originated"
      }
    },
    entries: [],
    balances: {},
    houseLedger: [
      {
        id: "house:rake:pool-e11",
        poolId: "pool-e11",
        unit: input.unit,
        amount: input.rakeAmount,
        reason: "rake",
        createdAt: "2099-06-27T17:05:00.000Z"
      }
    ],
    settlement: {
      id: "settlement:pool-e11:yes",
      poolId: "pool-e11",
      outcome: "yes",
      totalStaked: 10_000_000,
      payoutTotal: 10_000_000 - input.rakeAmount,
      rakeAmount: input.rakeAmount,
      createdAt: "2099-06-27T17:05:00.000Z"
    },
    voidReason: null,
    lastResolution: null,
    updatedAt: "2099-06-27T17:05:00.000Z"
  };
}

function creatorProfile(overrides: Partial<DotCastCreatorProfile>): DotCastCreatorProfile {
  return {
    creatorId: "creator",
    displayName: "Creator",
    tier: "verified",
    status: "active",
    kycStatus: "verified",
    payoutDestination: "11111111111111111111111111111111",
    accuracyBps: 5000,
    retentionBps: 5000,
    volumeScore: 0,
    manualReviewRequired: true,
    sponsorshipEligible: false,
    metadata: {},
    createdAt: "2099-06-27T17:00:00.000Z",
    updatedAt: "2099-06-27T17:00:00.000Z",
    ...overrides
  };
}

function balanceKey(creatorId: string, unit: StakeUnit): string {
  return `${creatorId}:${unit}`;
}
