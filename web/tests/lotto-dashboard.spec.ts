import { expect, test, type Page } from "@playwright/test";

test.describe("LOTTO forensic dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("sovereign.jwt", "playwright-yevow-session");
    });
    await page.goto("/lotto/");
  });

  test("opens the public forensic lab and exposes every workspace", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "LOTTO", exact: true })).toBeVisible();
    await expect(page.getByText("NOT A PREDICTION", { exact: true })).toBeVisible();

    const tabs = page.getByRole("tablist", { name: /lotto sections/i });
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(tabs.getByRole("tab", { name: "Audit" })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "Ticket Lab" })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "EV Lab" })).toBeVisible();
  });

  test("renders validated live archive freshness without changing the local labs", async ({
    page
  }) => {
    await page.route("**/api/lotto/v1/status", async (route) => {
      expect(route.request().method()).toBe("GET");
      expect(route.request().postData()).toBeNull();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          generatedAt: "2026-09-03T18:30:00.000Z",
          data: {
            games: [
              {
                code: "lotto",
                name: "Lotto Texas",
                sourceCount: 1,
                readySources: 1,
                activeDraws: 2_388,
                observedThrough: "2026-09-02",
                lastSuccessAt: "2026-09-03T18:29:00.000Z",
                status: "fresh",
                sources: [
                  {
                    id: "lotto:lottotexas",
                    name: "lottotexas",
                    session: "",
                    lastSuccessAt: "2026-09-03T18:29:00.000Z",
                    latestDrawDate: "2026-09-02",
                    activeCount: 2_388,
                    status: "ready"
                  }
                ]
              },
              {
                code: "cash5",
                name: "Cash Five",
                sourceCount: 1,
                readySources: 1,
                activeDraws: 2_487,
                observedThrough: "2026-09-02",
                lastSuccessAt: "2026-09-03T18:28:00.000Z",
                status: "fresh",
                sources: [
                  {
                    id: "cash5:cashfive",
                    name: "cashfive",
                    session: "",
                    lastSuccessAt: "2026-09-03T18:28:00.000Z",
                    latestDrawDate: "2026-09-02",
                    activeCount: 2_487,
                    status: "ready"
                  }
                ]
              }
            ]
          }
        })
      });
    });
    await page.reload();

    const panel = page.getByRole("region", { name: "Archive freshness" });
    await expect(panel.getByText("Cloud archive fresh", { exact: true })).toBeVisible();
    await expect(panel.getByText("4,875", { exact: true })).toBeVisible();
    await expect(panel.getByRole("list", { name: /freshness by game/i })).toBeVisible();

    await openTab(page, "EV Lab");
    await expect(page.getByRole("button", { name: "Calculate EV" })).toBeVisible();
  });

  test("falls back gracefully when live status has an invalid shape", async ({ page }) => {
    await page.route("**/api/lotto/v1/status", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.reload();

    const panel = page.getByRole("region", { name: "Archive freshness" });
    await expect(panel.getByText("Embedded snapshot mode", { exact: true })).toBeVisible();
    await expect(panel.getByText(/verified bundled audits/i)).toBeVisible();
    await expect(page.getByRole("tab", { name: "Ticket Lab" })).toBeEnabled();
  });

  test("keeps the local tools available when the status service is unavailable", async ({
    page
  }) => {
    await page.route("**/api/lotto/v1/status", async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
    await page.reload();

    const panel = page.getByRole("region", { name: "Archive freshness" });
    await expect(panel.getByText("Embedded snapshot mode", { exact: true })).toBeVisible();
    await openTab(page, "Ticket Lab");
    await expect(page.getByRole("button", { name: "Generate optimized set" })).toBeEnabled();
  });

  test("loads the exact persisted draw-day set without generating on page load", async ({
    page
  }) => {
    const methods: string[] = [];
    await page.route("**/api/lotto/v1/picks/today", async (route) => {
      methods.push(route.request().method());
      expect(route.request().postData()).toBeNull();
      expect(route.request().headers().authorization).toBe("Bearer playwright-yevow-session");
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 1,
          generatedAt: "2026-09-07T12:06:00.000Z",
          data: {
            drawDate: "2026-09-07",
            runs: [
              {
                runId: `gen-${"a".repeat(32)}`,
                game: "cash5",
                gameName: "Cash Five",
                drawDate: "2026-09-07",
                drawSlot: "daily",
                scheduledFor: "2026-09-07 06:00 America/Chicago",
                generatedAt: "2026-09-07T12:05:00.000Z",
                seed: "e".repeat(64),
                observedThrough: "2026-09-05",
                datasetDigest: "b".repeat(64),
                coverage: { distinctPairs: 20, possiblePairs: 595, coveragePercent: 3.36 },
                ev: {
                  netCentsPerTicket: -62,
                  assumption: "Pre-tax fixed-prize model; jackpot excluded."
                },
                tickets: [
                  {
                    ordinal: 1,
                    main: [13, 22, 29, 34, 35],
                    bonus: [],
                    playStyle: "straight",
                    splitRiskScore: 12.5,
                    splitRiskLevel: "low",
                    splitRiskNotes: ["Lower-collision shape."]
                  },
                  {
                    ordinal: 2,
                    main: [14, 23, 28, 32, 33],
                    bonus: [],
                    playStyle: "straight",
                    splitRiskScore: 14,
                    splitRiskLevel: "low",
                    splitRiskNotes: ["Lower-collision shape."]
                  }
                ],
                generationLogUrl: `/api/lotto/v1/generation-runs/gen-${"a".repeat(32)}`,
                disclaimer:
                  "Picks are optimized for coverage and lower split-risk patterns, not predicted. Lottery draws are random. Play responsibly."
              },
              {
                runId: `gen-${"c".repeat(32)}`,
                game: "p3",
                gameName: "Pick 3",
                drawDate: "2026-09-07",
                drawSlot: "daily",
                scheduledFor: "2026-09-07 06:00 America/Chicago",
                generatedAt: "2026-09-07T12:05:30.000Z",
                seed: "f".repeat(64),
                observedThrough: "2026-09-05",
                datasetDigest: "d".repeat(64),
                coverage: { distinctPairs: 6, possiblePairs: 300, coveragePercent: 2 },
                ev: {
                  netCentsPerTicket: -25,
                  assumption: "Pre-tax straight-play model."
                },
                tickets: [
                  {
                    ordinal: 1,
                    main: [0, 4, 6],
                    bonus: [],
                    playStyle: "straight",
                    splitRiskScore: 8,
                    splitRiskLevel: "low",
                    splitRiskNotes: ["No familiar date pattern."]
                  },
                  {
                    ordinal: 2,
                    main: [1, 5, 9],
                    bonus: [],
                    playStyle: "straight",
                    splitRiskScore: 9,
                    splitRiskLevel: "low",
                    splitRiskNotes: ["No familiar date pattern."]
                  }
                ],
                generationLogUrl: `/api/lotto/v1/generation-runs/gen-${"c".repeat(32)}`,
                disclaimer:
                  "Picks are optimized for coverage and lower split-risk patterns, not predicted. Lottery draws are random. Play responsibly."
              }
            ]
          }
        })
      });
    });
    await page.reload();

    const panel = page.getByRole("region", { name: "Today's optimized picks" });
    await expect(panel.getByText("2 games · 4 tickets", { exact: true })).toBeVisible();
    const cashTickets = panel.getByRole("list", { name: "Cash Five persisted tickets" });
    await expect(cashTickets.getByRole("listitem")).toHaveCount(2);
    await expect(cashTickets.getByRole("listitem").first()).toContainText("13");
    await expect(cashTickets.getByRole("listitem").first()).toContainText("35");
    const pick3Tickets = panel.getByRole("list", { name: "Pick 3 persisted tickets" });
    await expect(pick3Tickets.getByRole("listitem").first()).toContainText("0");
    await expect(pick3Tickets.getByRole("listitem").first()).toContainText("4");
    await expect(pick3Tickets.getByRole("listitem").first()).toContainText("straight");
    await expect(panel.getByText(/Exact\/box choice changes cost and EV; no digit is due/i)).toBeVisible();
    await expect(panel.getByText("3.36%", { exact: true })).toBeVisible();
    await expect(panel.getByText("-$0.62", { exact: true })).toBeVisible();
    await expect(panel.getByText("Optimized, not predicted.", { exact: true })).toBeVisible();
    await expect(
      panel.getByRole("link", { name: "Open Cash Five generation log" })
    ).toHaveAttribute("href", `#lotto-generation-gen-${"a".repeat(32)}`);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((method) => method === "GET")).toBe(true);
  });

  test("shows the immutable Ticket Lab scorecard and official-result grades", async ({ page }) => {
    const requests: string[] = [];
    await page.route("**/api/lotto/v1/ticket-lab/summary**", async (route) => {
      requests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      expect(route.request().headers().authorization).toBe("Bearer playwright-yevow-session");
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(ticketLabSummaryFixture())
      });
    });
    await page.route("**/api/lotto/v1/ticket-lab/entries**", async (route) => {
      requests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      expect(route.request().headers().authorization).toBe("Bearer playwright-yevow-session");
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(ticketLabEntriesFixture())
      });
    });

    await openTab(page, "Ticket Lab");

    const trackRecord = page.getByRole("region", { name: "Nothing forgotten. Nothing hidden." });
    await expect(trackRecord).toBeVisible();
    await expect(trackRecord.getByText("-60.0% cash ROI", { exact: true })).toBeVisible();
    await expect(trackRecord.getByText("-60.0%", { exact: true }).first()).toBeVisible();
    await expect(trackRecord.getByText("Random baseline", { exact: true })).toBeVisible();
    await expect(trackRecord.getByText("4 of 5", { exact: true }).first()).toBeVisible();
    await expect(trackRecord.getByText("$350.00", { exact: true }).first()).toBeVisible();
    await expect(trackRecord.getByRole("list", { name: "Cash Five ledger tickets" })).toBeVisible();
    await expect(trackRecord.getByText("Optimized, not predicted.", { exact: true })).toBeVisible();

    await trackRecord.getByRole("combobox", { name: "Game" }).selectOption("cash5");
    await trackRecord.getByLabel("From", { exact: true }).fill("2026-01-01");
    await trackRecord.getByLabel("To", { exact: true }).fill("2026-09-04");
    await trackRecord.getByRole("combobox", { name: "Result" }).selectOption("won");
    await trackRecord.getByRole("button", { name: "Apply filters" }).click();

    await expect.poll(() => requests.some((url) => url.includes("game=cash5"))).toBe(true);
    await expect.poll(() => requests.some((url) => url.includes("status=won"))).toBe(true);
  });

  test("shows both verified official draw archives", async ({ page }) => {
    await openTab(page, "Audit");

    const game = page.getByRole("combobox", { name: /audit game/i });
    await game.selectOption({ label: "Lotto Texas" });
    await expect(page.getByText(/verified official archive/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Lotto Texas", exact: true })).toBeVisible();

    await game.selectOption({ label: "Cash Five" });
    await expect(page.getByRole("heading", { name: "Cash Five", exact: true })).toBeVisible();
    await expect(page.getByText(/verified official archive/i).first()).toBeVisible();
  });

  test("generates a deterministic, budget-aware optimized ticket set", async ({ page }) => {
    await openTab(page, "Ticket Lab");

    await page.getByRole("combobox", { name: "Game", exact: true }).selectOption({
      label: "Lotto Texas"
    });
    await page.getByLabel("Tickets", { exact: true }).fill("4");
    await page.getByLabel("Seed", { exact: true }).fill("1836");

    const results = page.locator(".lotto-results-panel");
    await results.evaluate((resultsPanel) => {
      document.documentElement.dataset.lottoBusyObserved = "false";
      const recordBusyState = () => {
        const button = document.querySelector<HTMLButtonElement>("button.lotto-submit");
        if (
          resultsPanel.getAttribute("aria-busy") === "true" &&
          button?.disabled &&
          button.textContent?.includes("Optimizing in background")
        ) {
          document.documentElement.dataset.lottoBusyObserved = "true";
        }
      };
      new MutationObserver(recordBusyState).observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true
      });
      recordBusyState();
    });

    const generate = page.getByRole("button", { name: "Generate optimized set" });
    await generate.click();

    const output = page.getByRole("list", { name: "Optimized tickets" });
    await expect(output.getByRole("listitem")).toHaveCount(4);
    await expect
      .poll(() => page.locator("html").getAttribute("data-lotto-busy-observed"))
      .toBe("true");
    await expect(results).toHaveAttribute("aria-busy", "false");
    await expect(generate).toBeEnabled();
    await expect(page.getByText(/Coverage/i).first()).toBeVisible();

    const firstRun = await output.textContent();
    await generate.click();
    await expect(output).toHaveText(firstRun ?? "");
  });

  test("calculates expected value from explicit jackpot and sales assumptions", async ({
    page
  }) => {
    await openTab(page, "EV Lab");

    await page.getByRole("combobox", { name: "Game", exact: true }).selectOption({
      label: "Lotto Texas"
    });
    await page.getByRole("spinbutton", { name: /pre-tax cash jackpot/i }).fill("25000000");
    await page.getByLabel(/sales/i).fill("3000000");
    await page.getByLabel(/popularity/i).fill("1");
    await page.getByRole("button", { name: "Calculate EV" }).click();

    await expect(page.getByText(/Expected return/i).first()).toBeVisible();
  });

  test("defaults pick popularity to the neutral 1.0 multiplier", async ({ page }) => {
    await openTab(page, "EV Lab");

    const popularity = page.getByRole("spinbutton", {
      name: /pick popularity multiplier/i
    });
    expect(Number(await popularity.inputValue())).toBe(1);
  });

  test("interprets exponent-form ticket sales as the full play count", async ({ page }) => {
    await openTab(page, "EV Lab");

    await page.getByRole("combobox", { name: "Game", exact: true }).selectOption({
      label: "Lotto Texas"
    });
    await page.getByRole("spinbutton", { name: /pre-tax cash jackpot/i }).fill("5000000");
    await page.getByRole("spinbutton", { name: /estimated ticket sales/i }).fill("1e6");
    await page.getByRole("spinbutton", { name: /pick popularity multiplier/i }).fill("1");
    await page.getByRole("button", { name: "Calculate EV" }).click();

    await expect(page.getByText(/Expected return/i).first()).toBeVisible();
    await page.getByText("Model assumptions", { exact: true }).click();
    await expect(page.getByText(/estimated sales: 1000000 plays\./i)).toBeVisible();
  });

  test("accepts a legitimate cash jackpot that is not a round step multiple", async ({ page }) => {
    await openTab(page, "EV Lab");

    await page.getByRole("combobox", { name: "Game", exact: true }).selectOption({
      label: "Lotto Texas"
    });
    const jackpot = page.getByRole("spinbutton", { name: /pre-tax cash jackpot/i });
    await jackpot.fill("3940000");
    expect(await jackpot.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
    await page.getByRole("button", { name: "Calculate EV" }).click();

    await expect(page.getByText(/Expected return/i).first()).toBeVisible();
    await expect(page.locator(".lotto-form-error")).toHaveCount(0);
  });

  test("keeps the primary experience accessible without horizontal overflow on mobile", async ({
    page
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();

    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("tablist", { name: /lotto sections/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "LOTTO", exact: true })).toBeVisible();

    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(1);

    await openTab(page, "Ticket Lab");
    await expect(page.getByLabel("Tickets", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Seed", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate optimized set" })).toBeVisible();
  });
});

async function openTab(
  page: Page,
  name: "Overview" | "Audit" | "Ticket Lab" | "EV Lab"
): Promise<void> {
  const tab = page.getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

function ticketLabScorecard(overrides: Record<string, unknown> = {}) {
  return {
    entries: 1,
    tickets: 2,
    gradedTickets: 2,
    spentCents: 200,
    wonCents: 0,
    nonCashValueCents: 0,
    pendingPrizeCount: 0,
    longestLosingStreak: 2,
    bestHit: null,
    roiPercent: -100,
    economicRoiPercent: -100,
    ...overrides
  };
}

function ticketLabSummaryFixture() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-04T15:00:00.000Z",
    data: {
      filters: { game: null, from: null, to: null },
      totals: {
        proposals: ticketLabScorecard({
          wonCents: 35000,
          longestLosingStreak: 1,
          bestHit: {
            game: "cash5",
            drawDate: "2026-06-26",
            tier: "4 of 5",
            prizeCents: 35000,
            payoutStatus: "fixed"
          },
          roiPercent: 17400,
          economicRoiPercent: 17400
        }),
        confirmed: ticketLabScorecard({
          entries: 0,
          tickets: 0,
          gradedTickets: 0,
          spentCents: 0,
          longestLosingStreak: 0,
          roiPercent: null,
          economicRoiPercent: null
        })
      },
      comparisons: [
        {
          origin: "system",
          ...ticketLabScorecard({
            wonCents: 35000,
            longestLosingStreak: 1,
            bestHit: {
              game: "cash5",
              drawDate: "2026-06-26",
              tier: "4 of 5",
              prizeCents: 35000,
              payoutStatus: "fixed"
            },
            roiPercent: 17400,
            economicRoiPercent: 17400
          })
        },
        { origin: "random", ...ticketLabScorecard({ wonCents: 80, roiPercent: -60, economicRoiPercent: -60 }) },
        {
          origin: "user",
          ...ticketLabScorecard({
            entries: 0,
            tickets: 0,
            gradedTickets: 0,
            spentCents: 0,
            longestLosingStreak: 0,
            roiPercent: null,
            economicRoiPercent: null
          })
        }
      ],
      comparisonPolicy: {
        method: "shared-strata-min-ticket-count",
        strata: ["game", "drawDate", "targetSession"],
        origins: ["system", "random", "user"],
        sharedStrata: 1,
        ticketsPerOrigin: 2,
        description: "Equal-size tickets from the same draw are compared."
      },
      prizeTiers: [{ tier: "4 of 5", count: 1, wonCents: 35000 }],
      disclaimer: "Picks are optimized, not predicted. The ledger reports every loss."
    }
  };
}

function ticketLabEntriesFixture() {
  const result = {
    main: [1, 3, 7, 17, 25],
    bonus: [],
    session: "",
    fingerprint: "f".repeat(64),
    sourceId: "fixture:cash5:pool",
    sourceSha256: "a".repeat(64)
  };
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-04T15:00:00.000Z",
    data: {
      filters: { game: null, from: null, to: null, status: null },
      entries: [
        {
          ledgerId: `ledger-${"a".repeat(32)}`,
          origin: "system",
          correctionOf: null,
          baselineFor: null,
          runId: `gen-${"a".repeat(32)}`,
          game: "cash5",
          gameName: "Cash Five",
          drawDate: "2026-06-26",
          targetSession: "",
          proposedAt: "2026-06-26T12:00:00.000Z",
          status: "won",
          seed: "b".repeat(64),
          coverage: { distinctPairs: 20, possiblePairs: 595, percent: 3.36 },
          ev: { netCentsPerTicket: -62, assumption: "Pre-tax current-era fixed prize model." },
          ticketCostCents: 100,
          proposalStatus: "proposed",
          purchase: { status: "unconfirmed", eventId: null, at: null, spendCents: 0 },
          data: { observedThrough: "2026-06-25", datasetDigest: "c".repeat(64) },
          spend: { proposalCents: 200, confirmedCents: 0 },
          wonCents: 35000,
          pendingPrizeCount: 0,
          resultNotificationStatus: "sent",
          tickets: [
            {
              ledgerTicketId: `lt-${"a".repeat(32)}-1`,
              ordinal: 1,
              main: [1, 3, 7, 17, 35],
              bonus: [],
              playStyle: "straight",
              wagerCents: 100,
              options: { freeQuickPickCashValueCents: 0 },
              splitRisk: { score: 12.5, level: "low", notes: ["Lower-collision shape."] },
              grade: {
                gradeId: `grade-${"d".repeat(32)}`,
                revision: 1,
                result,
                mainMatches: 4,
                bonusMatches: 0,
                tier: "4 of 5",
                hit: true,
                payoutStatus: "fixed",
                prizeCents: 35000,
                effectivePrizeCents: 35000,
                pendingReason: null,
                nonCashPrize: null,
                detail: {},
                settlement: null,
                gradedAt: "2026-06-27T04:00:00.000Z"
              }
            },
            {
              ledgerTicketId: `lt-${"a".repeat(32)}-2`,
              ordinal: 2,
              main: [2, 4, 8, 19, 34],
              bonus: [],
              playStyle: "straight",
              wagerCents: 100,
              options: { freeQuickPickCashValueCents: 0 },
              splitRisk: { score: 14, level: "low", notes: ["Lower-collision shape."] },
              grade: {
                gradeId: `grade-${"e".repeat(32)}`,
                revision: 1,
                result,
                mainMatches: 0,
                bonusMatches: 0,
                tier: "No prize",
                hit: false,
                payoutStatus: "none",
                prizeCents: 0,
                effectivePrizeCents: 0,
                pendingReason: null,
                nonCashPrize: null,
                detail: {},
                settlement: null,
                gradedAt: "2026-06-27T04:00:00.000Z"
              }
            }
          ]
        }
      ],
      nextCursor: null,
      disclaimer: "Picks are optimized, not predicted. The ledger reports every loss."
    }
  };
}
