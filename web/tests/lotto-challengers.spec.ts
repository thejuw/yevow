import { expect, test, type Page } from "@playwright/test";
import { parseChallengers, readChallengers } from "../lib/lotto/challenger-client";
import { parseTicketLabSummary } from "../lib/lotto/ticket-lab-client";

function shadowScore() {
  return {
    gradedDraws: 1,
    gradedTickets: 4,
    spentCents: 400,
    wonCents: 0,
    nonCashValueCents: 100,
    pendingPrizeCount: 0,
    roiPercent: -100
  };
}

function challengerFixture() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-21T12:00:00Z",
    data: {
      policy: {
        paperOnly: true,
        forwardOnly: true,
        autoPromotion: false,
        matching: ["game", "drawDate", "targetSession", "ticketCount", "wagerCents", "playStyle"],
        description: "Three matched, frozen arms; no historical backfill.",
        reviewDate: "2026-12-20"
      },
      variants: [
        {
          ...shadowScore(),
          id: "neutral-v1",
          version: "v1",
          label: "Neutral portfolio",
          goal: "Coverage without unmeasured lucky-number penalties",
          frozenAt: "2026-09-20T12:00:00Z",
          firstEligibleDrawDate: "2026-09-21",
          draws: 1,
          tickets: 4,
          status: "collecting",
          comparisons: { current: shadowScore(), random: shadowScore() }
        }
      ],
      latest: [
        {
          trialId: "trial-1",
          variantId: "neutral-v1",
          game: "cash5",
          drawDate: "2026-09-21",
          targetSession: "",
          proposedAt: "2026-09-21T12:00:00Z",
          seed: "frozen-seed",
          configHash: "a".repeat(64),
          observedThrough: "2026-09-19",
          status: "open",
          tickets: [{ game: "cash5", main: [1, 7, 13, 22, 34], bonus: [], playStyle: "straight" }]
        }
      ],
      disclaimer: "Optimized, not predicted. No automatic promotion."
    }
  };
}

function liveScore() {
  return {
    entries: 2,
    tickets: 8,
    gradedTickets: 4,
    spentCents: 800,
    gradedSpendCents: 400,
    openSpendCents: 400,
    knownNetCents: -300,
    netCents: null,
    modeledTickets: 1,
    modeledPrizeCents: 100,
    wonCents: 100,
    nonCashValueCents: 100,
    pendingPrizeCount: 1,
    longestLosingStreak: 3,
    bestHit: null,
    roiPercent: null,
    economicRoiPercent: null
  };
}

function summaryFixture() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-21T12:00:00Z",
    data: {
      filters: { game: null, from: null, to: null },
      totals: {
        proposals: liveScore(),
        confirmed: {
          ...liveScore(),
          entries: 0,
          tickets: 0,
          gradedTickets: 0,
          spentCents: 0,
          gradedSpendCents: 0,
          openSpendCents: 0,
          knownNetCents: 0,
          netCents: 0,
          modeledTickets: 0,
          modeledPrizeCents: 0,
          wonCents: 0,
          nonCashValueCents: 0,
          pendingPrizeCount: 0,
          longestLosingStreak: 0
        }
      },
      eligibility: { eligibleEntries: 2, excludedEntries: 0, excludedTickets: 0 },
      comparisons: [
        { origin: "system", ...liveScore() },
        { origin: "random", ...liveScore() }
      ],
      comparisonPolicy: {
        method: "shared-strata-min-ticket-count",
        strata: ["game", "drawDate", "targetSession"],
        origins: ["system", "random"],
        sharedStrata: 1,
        ticketsPerOrigin: 4,
        description: "Equal draw samples."
      },
      prizeTiers: [],
      disclaimer: "Optimized, not predicted. Every loss remains visible."
    }
  };
}

test("challenger parser requires paper-only safeguards and equal three-arm stakes", () => {
  const good = challengerFixture();
  expect(parseChallengers(good).data.variants[0].roiPercent).toBe(-100);
  const unsafe = structuredClone(good);
  unsafe.data.policy.autoPromotion = true;
  expect(() => parseChallengers(unsafe)).toThrow(/policy/);
  const unequal = structuredClone(good);
  unequal.data.variants[0].comparisons.random.spentCents = 800;
  expect(() => parseChallengers(unequal)).toThrow(/equalSample/);
  const hidden = structuredClone(good);
  hidden.data.variants[0].pendingPrizeCount = 1;
  expect(() => parseChallengers(hidden)).toThrow(/unresolvedRoi/);
});

test("challenger parser rejects malformed tickets, dates, and unknown variants", () => {
  const malformed = challengerFixture();
  malformed.data.latest[0].tickets[0].main = [1, 1, 3, 4, 5];
  expect(() => parseChallengers(malformed)).toThrow(/tickets/);
  const wrongDate = challengerFixture();
  wrongDate.data.latest[0].drawDate = "2026-02-30";
  expect(() => parseChallengers(wrongDate)).toThrow(/drawDate/);
  const unknown = challengerFixture();
  unknown.data.latest[0].variantId = "not-frozen";
  expect(() => parseChallengers(unknown)).toThrow(/variantId/);
});

test("challenger reader sends authenticated read-only no-store requests", async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  await readChallengers(
    { game: "cash5", from: "2026-09-20" },
    {
      baseUrl: "https://example.com/api/lotto/v1",
      token: " private-token ",
      fetcher: (async (input, options) => {
        calls.push({ url: String(input), options });
        return Response.json(challengerFixture());
      }) as typeof fetch
    }
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toContain("/ticket-lab/challengers?game=cash5&from=2026-09-20");
  expect(calls[0].options?.method).toBe("GET");
  expect(calls[0].options?.cache).toBe("no-store");
  expect(calls[0].options?.headers).toEqual({
    Accept: "application/json",
    Authorization: "Bearer private-token"
  });
  expect(calls[0].options?.body).toBeUndefined();
});

test("ledger accounting separates open costs and rejects a final ROI while payouts are pending", () => {
  const summary = summaryFixture();
  expect(parseTicketLabSummary(summary).data.totals.proposals.knownNetCents).toBe(-300);
  const bad = structuredClone(summary);
  bad.data.totals.proposals.gradedSpendCents = 800;
  expect(() => parseTicketLabSummary(bad)).toThrow(/accounting/);
  const pending = {
    ...summary,
    data: {
      ...summary.data,
      totals: {
        ...summary.data.totals,
        proposals: { ...liveScore(), roiPercent: -75 }
      }
    }
  };
  expect(() => parseTicketLabSummary(pending)).toThrow(/accounting/);
});

async function mockLedger(page: Page) {
  await page.addInitScript(() => window.localStorage.setItem("sovereign.jwt", "test-session"));
  await page.route("**/api/lotto/v1/status", (route) => route.fulfill({ status: 503, body: "{}" }));
  await page.route("**/api/lotto/v1/picks/today", (route) =>
    route.fulfill({ status: 503, body: "{}" })
  );
  await page.route("**/api/lotto/v1/ticket-lab/summary**", (route) =>
    route.fulfill({ json: summaryFixture() })
  );
  await page.route("**/api/lotto/v1/ticket-lab/entries**", (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        generatedAt: "2026-09-21T12:00:00Z",
        data: {
          filters: { game: null, from: null, to: null, status: null },
          entries: [],
          nextCursor: null,
          disclaimer: "Optimized, not predicted."
        }
      }
    })
  );
}

test("dashboard keeps paper challengers separate and displays losses, pending payouts, and saved tickets", async ({
  page
}) => {
  await mockLedger(page);
  const methods: string[] = [];
  await page.route("**/api/lotto/v1/ticket-lab/challengers**", async (route) => {
    methods.push(route.request().method());
    expect(route.request().headers().authorization).toBe("Bearer test-session");
    await route.fulfill({ json: challengerFixture() });
  });
  await page.goto("/lotto/");
  await page.getByRole("tab", { name: "Ticket Lab", exact: true }).click();
  const panel = page.getByRole("region", { name: "Challenger trials", exact: true });
  await expect(panel.getByText(/never enter live ROI/)).toBeVisible();
  await expect(panel.getByText("-100.0% cash ROI", { exact: true })).toHaveCount(3);
  await expect(
    panel.getByText("Frozen goal: Coverage without unmeasured lucky-number penalties")
  ).toBeVisible();
  await panel
    .getByText("Latest saved challenger tickets and frozen evidence", { exact: true })
    .click();
  await expect(panel.getByText("01-07-13-22-34 · straight", { exact: true })).toBeVisible();
  await expect(
    page.getByText("lower bound — official payout pending; free plays excluded", { exact: true })
  ).toBeVisible();
  await expect(page.getByText(/1 graded tickets use modeled multipliers/).first()).toBeVisible();
  await expect(page.getByText("$4.00 awaiting grading", { exact: false }).first()).toBeVisible();
  expect(methods).toEqual(["GET"]);
});

test("dashboard shows honest future-only empty state and does not invent challenger results", async ({
  page
}) => {
  await mockLedger(page);
  const fixture = challengerFixture();
  fixture.data.variants = [];
  fixture.data.latest = [];
  await page.route("**/api/lotto/v1/ticket-lab/challengers**", (route) =>
    route.fulfill({ json: fixture })
  );
  await page.goto("/lotto/");
  await page.getByRole("tab", { name: "Ticket Lab", exact: true }).click();
  const panel = page.getByRole("region", { name: "Challenger trials", exact: true });
  await expect(panel.getByText(/No forward trial results yet/)).toBeVisible();
  await expect(panel.getByText(/Historical winning days are not reused/)).toBeVisible();
  await expect(panel.getByRole("article")).toHaveCount(0);
});

test("challenger service failure leaves live ledger visible", async ({ page }) => {
  await mockLedger(page);
  await page.route("**/api/lotto/v1/ticket-lab/challengers**", (route) =>
    route.fulfill({ status: 503, body: "{}" })
  );
  await page.goto("/lotto/");
  await page.getByRole("tab", { name: "Ticket Lab", exact: true }).click();
  await expect(page.getByText(/Challenger results unavailable/)).toBeVisible();
  await expect(page.getByText("Proposal cash net", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry challenger results" })).toBeVisible();
});
