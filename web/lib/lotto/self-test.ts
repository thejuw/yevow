import {
  AUDIT_SNAPSHOTS,
  calculateAllEv,
  calculateEv,
  calculatePairCoverage,
  createSeededRng,
  expectedSplitShare,
  formatMoneyCents,
  GAME_CODES,
  GAME_MANIFEST,
  generateTickets,
  DEFAULT_LOTTO_API_BASE,
  LottoPicksClientError,
  LottoStatusClientError,
  LottoTicketLabClientError,
  LottoValidationError,
  normalizeLottoApiBase,
  parseLottoDailyPicks,
  parseLottoStatus,
  parseTicketLabEntries,
  parseTicketLabSummary,
  scoreSplitRisk,
  validateTicket,
  breakEvenJackpotCents
} from "./index";
import type { DigitPlayStyle, Ticket } from "./index";

let assertionCount = 0;

function assert(condition: unknown, message: string): asserts condition {
  assertionCount += 1;
  if (!condition) throw new Error(`Self-test failed: ${message}`);
}

function close(actual: number, expected: number, tolerance: number, message: string): void {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${message}: got ${actual}, expected ${expected}`
  );
}

function expectValidationError(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch (error) {
    assert(error instanceof LottoValidationError, message);
    return;
  }
  throw new Error(`Self-test failed: ${message} did not throw`);
}

function expectStatusError(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch (error) {
    assert(error instanceof LottoStatusClientError, message);
    return;
  }
  throw new Error(`Self-test failed: ${message} did not throw`);
}

function expectPicksError(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch (error) {
    assert(error instanceof LottoPicksClientError, message);
    return;
  }
  throw new Error(`Self-test failed: ${message} did not throw`);
}

function expectTicketLabError(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch (error) {
    assert(error instanceof LottoTicketLabClientError, message);
    return;
  }
  throw new Error(`Self-test failed: ${message} did not throw`);
}

assert(GAME_CODES.length === 8, "manifest exposes all eight game codes");
assert(Object.keys(GAME_MANIFEST).length === 8, "manifest has eight entries");
assert(GAME_MANIFEST.lotto.outcomeCount === 25_827_165, "Lotto denominator");
assert(GAME_MANIFEST.twostep.outcomeCount === 1_832_600, "Two Step denominator");
assert(GAME_MANIFEST.cash5.outcomeCount === 324_632, "Cash Five denominator");
assert(GAME_MANIFEST.pb.outcomeCount === 292_201_338, "Powerball denominator");
assert(GAME_MANIFEST.mm.bonus?.max === 24, "current Mega Ball field");
assert(GAME_MANIFEST.mm.baseCostCents === 500, "current Mega Millions cost");
assert(GAME_MANIFEST.aon.main.count === 12, "All or Nothing matrix");

assert(
  DEFAULT_LOTTO_API_BASE === "https://lotto-api.yevow.co/api/lotto/v1",
  "status client defaults to the isolated LOTTO API"
);
assert(
  normalizeLottoApiBase("https://lotto-api.yevow.co/api/lotto/v1///") === DEFAULT_LOTTO_API_BASE,
  "status client normalizes trailing slashes"
);
const parsedStatus = parseLottoStatus({
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
      }
    ]
  }
});
assert(parsedStatus.data.games[0]?.activeDraws === 2_388, "status response validates");
expectStatusError(
  () =>
    parseLottoStatus({
      schemaVersion: 1,
      generatedAt: "2026-09-03T18:30:00.000Z",
      data: {
        games: [
          {
            code: "lotto",
            name: "Lotto Texas",
            sourceCount: 2,
            readySources: 1,
            activeDraws: 1,
            observedThrough: null,
            lastSuccessAt: null,
            status: "fresh",
            sources: []
          }
        ]
      }
    }),
  "status response rejects irreconcilable source counts"
);

const dailyPicksFixture = {
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
          "Picks are optimized for coverage and lower split-risk patterns, not predicted. Play responsibly."
      }
    ]
  }
};
const parsedDailyPicks = parseLottoDailyPicks(dailyPicksFixture);
assert(parsedDailyPicks.data.runs[0]?.tickets.length === 2, "persisted picks response validates");
expectPicksError(
  () =>
    parseLottoDailyPicks({
      ...dailyPicksFixture,
      data: {
        ...dailyPicksFixture.data,
        runs: dailyPicksFixture.data.runs.map((run) => ({
          ...run,
          coverage: { ...run.coverage, coveragePercent: 99 }
        }))
      }
    }),
  "persisted picks response rejects unreconciled coverage"
);

const ticketLabScorecard = {
  entries: 1,
  tickets: 1,
  gradedTickets: 1,
  spentCents: 100,
  wonCents: 35000,
  nonCashValueCents: 0,
  pendingPrizeCount: 0,
  longestLosingStreak: 0,
  bestHit: {
    game: "cash5",
    drawDate: "2026-06-26",
    tier: "4 of 5",
    prizeCents: 35000,
    payoutStatus: "fixed"
  },
  roiPercent: 34900,
  economicRoiPercent: 34900
};
const ticketLabSummaryFixture = {
  schemaVersion: 1,
  generatedAt: "2026-09-04T15:00:00.000Z",
  data: {
    filters: { game: "cash5", from: "2026-01-01", to: "2026-09-04" },
    totals: {
      proposals: ticketLabScorecard,
      confirmed: {
        ...ticketLabScorecard,
        tickets: 0,
        gradedTickets: 0,
        spentCents: 0,
        wonCents: 0,
        roiPercent: null,
        economicRoiPercent: null,
        bestHit: null
      }
    },
    eligibility: { eligibleEntries: 2, excludedEntries: 1, excludedTickets: 1 },
    comparisons: [
      { origin: "system", ...ticketLabScorecard },
      {
        origin: "random",
        ...ticketLabScorecard,
        wonCents: 0,
        roiPercent: -100,
        economicRoiPercent: -100,
        bestHit: null
      }
    ],
    comparisonPolicy: {
      method: "shared-strata-min-ticket-count",
      strata: ["game", "drawDate", "targetSession"],
      origins: ["system", "random"],
      sharedStrata: 1,
      ticketsPerOrigin: 1,
      description: "Equal-size tickets from the same draw are compared."
    },
    prizeTiers: [{ tier: "4 of 5", count: 1, wonCents: 35000 }],
    disclaimer: "Picks are optimized, not predicted."
  }
};
assert(
  parseTicketLabSummary(ticketLabSummaryFixture).data.comparisons[1]?.roiPercent === -100,
  "Ticket Lab summary preserves bad-news ROI"
);
assert(
  parseTicketLabSummary({
    ...ticketLabSummaryFixture,
    data: {
      ...ticketLabSummaryFixture.data,
      totals: {
        ...ticketLabSummaryFixture.data.totals,
        proposals: {
          ...ticketLabScorecard,
          bestHit: {
            game: "lotto",
            drawDate: "2026-09-02",
            tier: "6 of 6 — jackpot",
            prizeCents: null,
            payoutStatus: "pending"
          }
        }
      }
    }
  }).data.totals.proposals.bestHit?.prizeCents === null,
  "Ticket Lab summary never renders an unresolved jackpot as a zero-dollar prize"
);
expectTicketLabError(
  () =>
    parseTicketLabSummary({
      ...ticketLabSummaryFixture,
      data: {
        ...ticketLabSummaryFixture.data,
        comparisons: [
          { origin: "system", ...ticketLabScorecard },
          { origin: "system", ...ticketLabScorecard }
        ]
      }
    }),
  "Ticket Lab summary rejects duplicate comparison origins"
);

const ticketLabEntriesFixture = {
  schemaVersion: 1,
  generatedAt: "2026-09-04T15:00:00.000Z",
  data: {
    filters: { game: "cash5", from: null, to: null, status: "won" },
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
        trackRecordEligible: true,
        eligibility: {
          eligible: true,
          eventId: null,
          reason: null,
          evidence: {},
          recordedAt: null
        },
        seed: "b".repeat(64),
        coverage: { distinctPairs: 10, possiblePairs: 595, percent: 1.68 },
        ev: { netCentsPerTicket: -62, assumption: "Pre-tax current-era model." },
        ticketCostCents: 100,
        proposalStatus: "proposed",
        purchase: { status: "unconfirmed", eventId: null, at: null, spendCents: 0 },
        data: { observedThrough: "2026-06-25", datasetDigest: "c".repeat(64) },
        spend: { proposalCents: 100, confirmedCents: 0 },
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
              result: {
                main: [1, 3, 7, 17, 25],
                bonus: [],
                session: "",
                fingerprint: "e".repeat(64),
                sourceId: "fixture:cash5:pool",
                sourceSha256: "a".repeat(64)
              },
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
          }
        ]
      }
    ],
    nextCursor: null,
    disclaimer: "Picks are optimized, not predicted."
  }
};
assert(
  parseTicketLabEntries(ticketLabEntriesFixture).data.entries[0]?.tickets[0]?.grade?.tier ===
    "4 of 5",
  "Ticket Lab entries validate exact ticket and official result arrays"
);
const excludedTicketLabEntriesFixture = {
  ...ticketLabEntriesFixture,
  data: {
    ...ticketLabEntriesFixture.data,
    filters: { ...ticketLabEntriesFixture.data.filters, status: "excluded" },
    entries: ticketLabEntriesFixture.data.entries.map((entry) => ({
      ...entry,
      status: "excluded",
      trackRecordEligible: false,
      eligibility: {
        eligible: false,
        eventId: `eligibility-${"f".repeat(32)}`,
        reason: "Official result existed before this legacy proposal was recorded.",
        evidence: {
          proposedAt: entry.proposedAt,
          resultFirstSeenAt: "2026-06-26T04:00:00.000Z"
        },
        recordedAt: "2026-09-04T15:00:00.000Z"
      }
    }))
  }
};
assert(
  parseTicketLabEntries(excludedTicketLabEntriesFixture).data.entries[0]?.status === "excluded",
  "Ticket Lab entries retain post-result legacy proposals as excluded rows"
);
assert(
  parseTicketLabEntries(excludedTicketLabEntriesFixture).data.entries[0]?.eligibility.reason ===
    "Official result existed before this legacy proposal was recorded.",
  "Ticket Lab entries preserve immutable exclusion evidence"
);
expectTicketLabError(
  () =>
    parseTicketLabEntries({
      ...excludedTicketLabEntriesFixture,
      data: {
        ...excludedTicketLabEntriesFixture.data,
        entries: excludedTicketLabEntriesFixture.data.entries.map((entry) => ({
          ...entry,
          trackRecordEligible: true
        }))
      }
    }),
  "Ticket Lab entries reject eligibility flag and evidence mismatches"
);
assert(
  parseTicketLabEntries({
    ...excludedTicketLabEntriesFixture,
    data: {
      ...excludedTicketLabEntriesFixture.data,
      entries: excludedTicketLabEntriesFixture.data.entries.map((entry) => ({
        ...entry,
        wonCents: 0,
        pendingPrizeCount: 0,
        resultNotificationStatus: null,
        tickets: entry.tickets.map((ticket) => ({ ...ticket, grade: null }))
      }))
    }
  }).data.entries[0]?.tickets[0]?.grade === null,
  "Ticket Lab entries retain excluded proposals that must never be graded"
);
expectTicketLabError(
  () =>
    parseTicketLabEntries({
      ...ticketLabEntriesFixture,
      data: {
        ...ticketLabEntriesFixture.data,
        entries: ticketLabEntriesFixture.data.entries.map((entry) => ({
          ...entry,
          tickets: entry.tickets.map((ticket) => ({ ...ticket, main: [1, 1, 3, 7, 17] }))
        }))
      }
    }),
  "Ticket Lab entries reject an impossible stored ticket"
);

const firstRng = createSeededRng("operation-lone-star");
const secondRng = createSeededRng("operation-lone-star");
for (let index = 0; index < 20; index += 1) {
  assert(firstRng() === secondRng(), "same seed reproduces the RNG stream");
}

const legalPowerball = validateTicket("pb", {
  game: "pb",
  main: [69, 1, 42, 33, 55],
  bonus: [26]
});
assert(legalPowerball.main.join(",") === "1,33,42,55,69", "pool tickets canonicalize");
expectValidationError(
  () => validateTicket("cash5", { game: "cash5", main: [1, 1, 2, 3, 4] }),
  "duplicates are rejected in pool games"
);
expectValidationError(
  () => validateTicket("p3", { game: "p3", main: [7, 7, 7], playStyle: "box" }),
  "all-same box is rejected"
);
expectValidationError(
  () => validateTicket("lotto", null as unknown as Ticket),
  "null ticket payload is normalized to a domain error"
);
expectValidationError(
  () =>
    validateTicket("lotto", {
      game: "lotto",
      main: [1, 2, 3, 4, 5, 6],
      bonus: "" as unknown as readonly number[]
    }),
  "non-array bonus payload is rejected"
);
const normalizedBox = generateTickets({
  game: "p3",
  count: 1,
  seed: "normalize-style",
  candidatePoolSize: 24,
  playStyle: " BOX " as unknown as DigitPlayStyle
});
assert(normalizedBox.tickets[0]?.ticket.playStyle === "box", "picker normalizes play style");

const birthdayRisk = scoreSplitRisk("lotto", {
  game: "lotto",
  main: [1, 7, 14, 21, 28, 31]
});
const dispersedRisk = scoreSplitRisk("lotto", {
  game: "lotto",
  main: [13, 32, 37, 43, 48, 54]
});
assert(birthdayRisk.score > dispersedRisk.score, "birthday-heavy Lotto shape ranks riskier");
assert(
  scoreSplitRisk("d4", { game: "d4", main: [1, 2, 1, 2] }).score >= 24,
  "Daily 4 ABAB visual pattern is detected"
);

const cashCoverage = calculatePairCoverage("cash5", [{ game: "cash5", main: [1, 2, 3, 4, 5] }]);
assert(cashCoverage.distinctPairs === 10, "one Cash Five ticket has ten pairs");
assert(cashCoverage.possiblePairs === 595, "Cash Five pair universe");
const powerballCoverage = calculatePairCoverage("pb", [legalPowerball]);
assert(powerballCoverage.distinctPairs === 15, "Powerball includes main and cross pairs");
assert(powerballCoverage.possiblePairs === 4_140, "Powerball pair universe");

const pickOne = generateTickets({ game: "lotto", count: 8, seed: "1836", candidatePoolSize: 256 });
const pickTwo = generateTickets({ game: "lotto", count: 8, seed: "1836", candidatePoolSize: 256 });
assert(JSON.stringify(pickOne) === JSON.stringify(pickTwo), "seeded picker is reproducible");
assert(pickOne.tickets.length === 8, "picker returns requested ticket count");
assert(
  new Set(pickOne.tickets.map(({ ticket }) => ticket.main.join(","))).size === 8,
  "picker tickets are distinct"
);
assert(pickOne.coverage.distinctPairs > 15, "wheel expands pair coverage");
for (const { ticket } of pickOne.tickets) validateTicket("lotto", ticket);

close(expectedSplitShare(0), 1, 0, "zero-lambda split share");
close(expectedSplitShare(1), 1 - Math.exp(-1), 1e-15, "unit-lambda split share");
const lottoEv = calculateEv({ game: "lotto" });
close(lottoEv.grossEvCents, 9.52, 0.01, "Lotto baseline gross EV cents");
assert(lottoEv.ticketCostCents === 100, "Lotto costs one dollar");
const extraEv = calculateEv({ game: "lotto", extra: true });
assert(extraEv.ticketCostCents === 200, "Lotto EXTRA total cost");
assert(
  extraEv.tiers.some((tier) => tier.tier.includes("2 of 6")),
  "EXTRA adds two-match tier"
);
close(calculateEv({ game: "p3" }).grossEvCents, 25, 1e-12, "Pick 3 straight EV");
close(
  calculateEv({ game: "d4", playStyle: "front-pair" }).grossEvCents,
  25,
  1e-12,
  "Daily 4 pair EV"
);
assert(
  calculateEv({ game: "cash5", ticketSales: 5_000_000 }).grossEvCents <
    calculateEv({ game: "cash5" }).grossEvCents,
  "liability model responds to sales"
);
const breakEven = breakEvenJackpotCents({ game: "lotto", ticketSales: 1_000_000 });
assert(
  Number.isSafeInteger(breakEven) && breakEven > 0,
  "break-even cash jackpot is integer cents"
);

const ranking = calculateAllEv();
assert(ranking.length === 8, "all-game EV returns eight rows");
for (let index = 1; index < ranking.length; index += 1) {
  assert(
    ranking[index - 1]!.evPerTwoDollarsCents <= ranking[index]!.evPerTwoDollarsCents,
    "EV ranking is ordered"
  );
}
assert(formatMoneyCents(123_456) === "$1,234.56", "money formatting uses cents");

for (const snapshot of Object.values(AUDIT_SNAPSHOTS)) {
  assert(
    snapshot.findings.every((finding) => finding.pValue > snapshot.bonferroniThreshold),
    `${snapshot.game} findings agree with no-flag verdicts`
  );
  assert(
    snapshot.frequencies.reduce((sum, row) => sum + row.appearances, 0) ===
      snapshot.frequencySampleSize,
    `${snapshot.game} frequency counts reconcile`
  );
  assert(
    snapshot.source.recordsRepresented === snapshot.drawsAnalyzed,
    `${snapshot.game} provenance count reconciles`
  );
}
assert(AUDIT_SNAPSHOTS.cash5.drawsAnalyzed === 2_488, "Cash Five audit draw count");
assert(AUDIT_SNAPSHOTS.cash5.observedThrough === "2026-09-03", "Cash Five audit observation date");
assert(
  AUDIT_SNAPSHOTS.cash5.source.sha256 ===
    "600b797b71e3a9493358b549aa51e5aaaa7e7c6141b871d2b596a766403727d0",
  "Cash Five audit source digest"
);

console.log(`RabbitHoleTX TypeScript core self-test: ${assertionCount} assertions passed.`);
