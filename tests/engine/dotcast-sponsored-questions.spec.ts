import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createDotCastSponsoredQuestion,
  listDotCastSponsoredQuestionFeed,
  readDotCastSponsoredQuestionsStatus,
  recordDotCastSponsoredQuestionBillingEvent,
  withSponsoredQuestionDisclosure,
  type DotCastSponsoredQuestion,
  type DotCastSponsoredQuestionBillingEvent,
  type DotCastSponsoredQuestionEvent,
  type DotCastSponsoredQuestionStore
} from "../../src/engine/dotcast";

describe("dotCast E10 sponsored questions", () => {
  it("reports readiness and fixed integrity-wall defaults", () => {
    expect(readDotCastSponsoredQuestionsStatus({}, true)).toMatchObject({
      enabled: true,
      ready: true,
      disclosureLabel: "Sponsored",
      pricingModels: ["flat_fee", "cpm", "completed_prediction", "auction"],
      maxContextChars: 140,
      maxBrandNameChars: 80,
      minBudgetMinorUnits: 0,
      guards: [],
      integrityWall: {
        source: "router-market-only",
        cosmeticOnly: true,
        poolStateWriteAccess: false,
        oddsWriteAccess: false,
        settlementWriteAccess: false,
        userDataReadAccess: false
      }
    });
    expect(readDotCastSponsoredQuestionsStatus({}, false)).toMatchObject({
      ready: false,
      guards: ["sponsored questions database not configured"]
    });
  });

  it("creates a cosmetic-only sponsored placement with mandatory disclosure", async () => {
    const store = new InMemorySponsoredQuestionStore();
    const created = await createDotCastSponsoredQuestion(
      store,
      {},
      {
        sponsorId: "sponsor-neutral",
        campaignId: "campaign-open",
        market: routerMarket(),
        pricingModel: "flat_fee",
        budgetMinorUnits: 50_000,
        placementPriority: 10,
        sponsorName: "Neutral Sports Network",
        contextText: "Presented with pregame analysis",
        attestation: {
          noOutcomeInfluence: true,
          cosmeticOnly: true,
          noUserDataAccess: true
        },
        startsAt: "2099-06-26T17:00:00.000Z",
        endsAt: "2099-06-26T19:00:00.000Z",
        now: "2099-06-26T16:00:00.000Z"
      }
    );
    const unsponsoredPoolDisplay = {
      poolId: "pool-sponsored-safety",
      odds: { yes: 0.57, no: 0.43 },
      mechanics: { unit: "points", rake: 0.05, minLiquidity: 100 },
      resolution: { source: "router", marketId: "kalshi:neutral-market" }
    };
    const before = JSON.stringify(unsponsoredPoolDisplay);
    const decorated = withSponsoredQuestionDisclosure(unsponsoredPoolDisplay, created.sponsorship);
    const feed = await listDotCastSponsoredQuestionFeed(
      store,
      {},
      { now: "2099-06-26T17:30:00.000Z" }
    );

    expect(created.sponsorship).toMatchObject({
      status: "active",
      disclosureLabel: "Sponsored",
      conflictStatus: "clear",
      sponsorName: "Neutral Sports Network",
      market: routerMarket()
    });
    expect(created.display).toMatchObject({
      disclosureLabel: "Sponsored",
      integrity: {
        cosmeticOnly: true,
        poolStateWriteAccess: false,
        oddsWriteAccess: false,
        settlementWriteAccess: false,
        userDataReadAccess: false
      }
    });
    expect(created.billingEvent).toMatchObject({
      eventType: "flat_fee_reserved",
      pricingModel: "flat_fee",
      amountMinorUnits: 50_000
    });
    expect(JSON.stringify(decorated.pool)).toBe(before);
    expect(decorated.sponsorship.disclosureLabel).toBe("Sponsored");
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].display.disclosureLabel).toBe("Sponsored");
  });

  it("rejects and logs forbidden sponsor conflicts", async () => {
    const store = new InMemorySponsoredQuestionStore();

    await expect(
      createDotCastSponsoredQuestion(
        store,
        {},
        {
          sponsorId: "brandx",
          campaignId: "conflicted-campaign",
          market: {
            ...routerMarket(),
            id: "kalshi:brandx-award",
            question: "Will BrandX win the orbital launch award?"
          },
          pricingModel: "cpm",
          sponsorName: "BrandX",
          attestation: {
            noOutcomeInfluence: true,
            cosmeticOnly: true,
            noUserDataAccess: true
          },
          now: "2099-06-26T16:00:00.000Z"
        }
      )
    ).rejects.toMatchObject({
      name: "DotCastSponsoredQuestionError",
      code: "SPONSORED_QUESTION_FORBIDDEN_CONFLICT",
      status: 409
    });
    expect(store.sponsorships.size).toBe(0);
    expect([...store.events.values()]).toEqual([
      expect.objectContaining({
        eventType: "CONFLICT_REJECTED",
        sponsorId: "brandx",
        marketId: "kalshi:brandx-award"
      })
    ]);
  });

  it("records auditable billing events idempotently by pricing model", async () => {
    const store = new InMemorySponsoredQuestionStore();
    const created = await createDotCastSponsoredQuestion(
      store,
      {},
      {
        sponsorId: "sponsor-cpm",
        campaignId: "campaign-cpm",
        market: routerMarket(),
        pricingModel: "cpm",
        sponsorName: "Independent Stream Desk",
        attestation: {
          noOutcomeInfluence: true,
          cosmeticOnly: true,
          noUserDataAccess: true
        },
        now: "2099-06-26T16:00:00.000Z"
      }
    );
    const first = await recordDotCastSponsoredQuestionBillingEvent(
      store,
      {},
      {
        sponsorship: created.sponsorship,
        eventType: "impression",
        quantity: 1_000,
        amountMinorUnits: 2_500,
        idempotencyKey: "cpm-impressions-1",
        now: "2099-06-26T17:00:00.000Z"
      }
    );
    const replayed = await recordDotCastSponsoredQuestionBillingEvent(
      store,
      {},
      {
        sponsorship: created.sponsorship,
        eventType: "impression",
        quantity: 1_000,
        amountMinorUnits: 2_500,
        idempotencyKey: "cpm-impressions-1",
        now: "2099-06-26T17:01:00.000Z"
      }
    );

    await expect(
      recordDotCastSponsoredQuestionBillingEvent(
        store,
        {},
        {
          sponsorship: created.sponsorship,
          eventType: "completed_prediction",
          quantity: 1,
          amountMinorUnits: 100,
          idempotencyKey: "wrong-model",
          now: "2099-06-26T17:02:00.000Z"
        }
      )
    ).rejects.toMatchObject({
      code: "SPONSORED_QUESTION_BILLING_MODEL_MISMATCH",
      status: 409
    });
    expect(first).toMatchObject({
      idempotent: false,
      billingEvent: {
        eventType: "impression",
        quantity: 1_000,
        amountMinorUnits: 2_500
      }
    });
    expect(replayed).toMatchObject({
      idempotent: true,
      billingEvent: {
        eventType: "impression",
        quantity: 1_000,
        amountMinorUnits: 2_500
      }
    });
    expect(store.billingEvents.size).toBe(1);
  });

  it("keeps E10 architecturally isolated from pool state, odds, settlement, and users", () => {
    const source = readFileSync("src/engine/dotcast/SponsoredQuestions.ts", "utf8");

    expect(source).not.toMatch(
      /from "\.\/(DotCastPoolDO|PoolSettlement|Parimutuel|RewardedStream|SolanaUsdcSettlementRail|UsdcPoolFunding)"/
    );
    expect(source).not.toContain("DotCastEntry");
    expect(source).not.toContain("SideTotals");
  });
});

class InMemorySponsoredQuestionStore implements DotCastSponsoredQuestionStore {
  readonly sponsorships = new Map<string, DotCastSponsoredQuestion>();
  readonly events = new Map<string, DotCastSponsoredQuestionEvent>();
  readonly billingEvents = new Map<string, DotCastSponsoredQuestionBillingEvent>();

  async getSponsorship(sponsorshipId: string): Promise<DotCastSponsoredQuestion | null> {
    const sponsorship = this.sponsorships.get(sponsorshipId);
    return sponsorship ? clone(sponsorship) : null;
  }

  async listFeed(now: string, limit: number): Promise<DotCastSponsoredQuestion[]> {
    return [...this.sponsorships.values()]
      .filter(
        (sponsorship) =>
          sponsorship.status === "active" &&
          (!sponsorship.startsAt || sponsorship.startsAt <= now) &&
          (!sponsorship.endsAt || sponsorship.endsAt > now)
      )
      .sort(
        (left, right) =>
          right.placementPriority - left.placementPriority ||
          right.updatedAt.localeCompare(left.updatedAt)
      )
      .slice(0, limit)
      .map(clone);
  }

  async listBySponsor(sponsorId: string, limit: number): Promise<DotCastSponsoredQuestion[]> {
    return [...this.sponsorships.values()]
      .filter((sponsorship) => sponsorship.sponsorId === sponsorId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map(clone);
  }

  async getBillingEventByIdempotencyKey(
    idempotencyKey: string
  ): Promise<DotCastSponsoredQuestionBillingEvent | null> {
    const event =
      [...this.billingEvents.values()].find(
        (candidate) => candidate.idempotencyKey === idempotencyKey
      ) ?? null;

    return event ? clone(event) : null;
  }

  async insertSponsorship(
    sponsorship: DotCastSponsoredQuestion,
    event: DotCastSponsoredQuestionEvent,
    billingEvent: DotCastSponsoredQuestionBillingEvent | null
  ): Promise<void> {
    this.sponsorships.set(sponsorship.sponsorshipId, clone(sponsorship));
    this.events.set(event.eventId, clone(event));

    if (billingEvent) {
      this.billingEvents.set(billingEvent.billingEventId, clone(billingEvent));
    }
  }

  async appendEvent(event: DotCastSponsoredQuestionEvent): Promise<void> {
    this.events.set(event.eventId, clone(event));
  }

  async appendBillingEvent(
    billingEvent: DotCastSponsoredQuestionBillingEvent,
    event: DotCastSponsoredQuestionEvent
  ): Promise<void> {
    this.billingEvents.set(billingEvent.billingEventId, clone(billingEvent));
    this.events.set(event.eventId, clone(event));
  }
}

function routerMarket() {
  return {
    id: "kalshi:neutral-market",
    venue: "kalshi" as const,
    question: "Will Miami beat Boston on opening night?",
    status: "open" as const,
    closeTime: "2099-06-26T18:00:00.000Z",
    expectedResolveAt: "2099-06-26T21:00:00.000Z",
    referenceUrl: "https://example.test/markets/neutral"
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
