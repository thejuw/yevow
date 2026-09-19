import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ensureOfficialPayoutMetadata,
  parseOfficialPayoutPage,
  readOfficialPayoutMetadata,
  reconcileOfficialPayouts,
  resolveOfficialPayoutUrl
} from "../src/payouts";
import {
  appendGradeSettlement,
  appendLedgerEntry,
  appendPurchaseConfirmation,
  gradeAvailableLedgerEntries,
  readTrackRecord,
  reconcileResultNotifications
} from "../src/ticket-lab";
import type { GameCode } from "../src/manifest";
import { network } from "./network";
import {
  LOTTO_MAIN,
  LOTTO_PAYOUT_HTML,
  LOTTO_PAYOUT_URL,
  TWO_STEP_MAIN,
  TWO_STEP_PAYOUT_HTML,
  TWO_STEP_PAYOUT_URL
} from "./fixtures/payout-pages";

const NOW = new Date("2026-09-19T12:00:00Z");
const INDEX =
  "https://www.texaslottery.com/export/sites/lottery/Games/Lotto_Texas/Winning_Numbers/";
const INDEX_HTML = `<a class="detailsLink" href="${LOTTO_PAYOUT_URL}">09/16/2026</a>`;
let fixtureSequence = 0;

// Workers' D1 storage is isolated per test file, not per test. Preserve ledger
// immutability while excluding prior test rows from the next test's scorecard.
beforeEach(async () => {
  fixtureSequence += 1;
  await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare(`INSERT INTO lotto_ledger_eligibility_events
      (eligibility_event_id, ledger_id, idempotency_key, eligible, reason_code, reason, evidence_json, recorded_at, created_at)
      SELECT 'payout-test-reset-' || hex(randomblob(16)), ledger_id, hex(randomblob(16)), 0,
        'manual-integrity-exclusion', 'Separate test fixture', '{}', '2026-09-19T12:00:00.000Z', '2026-09-19T12:00:00.000Z'
      FROM lotto_ticket_ledger`),
    env.LOTTO_DB.prepare("DELETE FROM lotto_lab_delivery_attempts"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_lab_delivery_outbox"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_draws"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_quarantine"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_ingestions"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_sources"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_payout_sources")
  ]);
});

function officialNetwork(html = LOTTO_PAYOUT_HTML): void {
  network.use(
    http.get(INDEX, () => HttpResponse.html(INDEX_HTML)),
    http.get(LOTTO_PAYOUT_URL, () => HttpResponse.html(html))
  );
}

async function insertResult(
  game: GameCode,
  date: string,
  main: readonly number[],
  bonus: readonly number[] = []
): Promise<void> {
  const source = `payout-fixture-${game}-${date}`;
  await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_sources (source_id, game, name, url, session, expected_widths)
      VALUES (?1, ?2, ?1, ?3, '', '[1]')`
    ).bind(source, game, INDEX),
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_draws (game, draw_date, session, ordered_numbers,
      canonical_numbers, bonus_numbers, metadata, content_fingerprint, source_id, source_url,
      source_sha256, source_line, raw_record, seen_ingestion_id, active, first_seen_at, updated_at)
      VALUES (?1, ?2, '', ?3, ?3, ?4, '{}', ?5, ?5, ?6, ?7, 1, 'official fixture', 'payout-fixture', 1, ?8, ?8)`
    ).bind(
      game,
      date,
      JSON.stringify(main),
      JSON.stringify(bonus),
      source,
      INDEX,
      "a".repeat(64),
      `${date}T23:59:00.000Z`
    )
  ]);
}

async function fixture(
  extra = false,
  confirmed = false
): Promise<{ ledgerId: string; ticketGradeId: string }> {
  const ledger = await appendLedgerEntry(
    env,
    {
      origin: "user",
      game: "lotto",
      drawDate: "2026-09-16",
      idempotencyKey: `payout-fixture-${extra}-${fixtureSequence}`,
      tickets: [{ main: [14, 35, 37, 41, 47, 51], options: { extra } }]
    },
    new Date("2026-09-16T12:00:00Z")
  );
  if (confirmed)
    await appendPurchaseConfirmation(
      env,
      ledger.ledgerId,
      {
        idempotencyKey: "confirmed-first-payout",
        purchased: true,
        spendCents: extra ? 200 : 100,
        source: "user"
      },
      new Date("2026-09-16T12:01:00Z")
    );
  await insertResult("lotto", "2026-09-16", LOTTO_MAIN);
  await gradeAvailableLedgerEntries(env, "lotto", NOW);
  const row = await env.LOTTO_DB.prepare(
    `SELECT t.ticket_grade_id FROM lotto_ticket_grades t
    JOIN lotto_ledger_grades g ON g.grade_id=t.grade_id WHERE g.ledger_id=?1`
  )
    .bind(ledger.ledgerId)
    .first<{ ticket_grade_id: string }>();
  return { ledgerId: ledger.ledgerId, ticketGradeId: row?.ticket_grade_id as string };
}

describe("official dated payout parser", () => {
  it("verifies the real September 16 Lotto $60 award and EXTRA all-in award", () => {
    expect(resolveOfficialPayoutUrl("lotto", "2026-09-16", INDEX_HTML)).toBe(LOTTO_PAYOUT_URL);
    expect(
      parseOfficialPayoutPage("lotto", "2026-09-16", LOTTO_MAIN, [], LOTTO_PAYOUT_HTML)
    ).toMatchObject({
      baseCents: { "lotto:4": 6_000, "lotto:5": 202_700 },
      extraCents: { "lotto:4": 16_000, "lotto:5": 1_202_700 }
    });
    expect(
      parseOfficialPayoutPage(
        "lotto",
        "2026-09-16",
        LOTTO_MAIN,
        [],
        `<h1>Player Area</h1>${LOTTO_PAYOUT_HTML}<h1 class="footTitle">Games</h1>`
      ).baseCents["lotto:4"]
    ).toBe(6_000);
  });

  it("verifies all four real September 17 Two Step pari-mutuel lower tiers", () => {
    expect(
      parseOfficialPayoutPage("twostep", "2026-09-17", TWO_STEP_MAIN, [12], TWO_STEP_PAYOUT_HTML)
        .baseCents
    ).toEqual({
      "twostep:4+0": 213_700,
      "twostep:3+1": 5_100,
      "twostep:3+0": 2_100,
      "twostep:2+1": 1_800
    });
  });

  it.each([
    LOTTO_PAYOUT_HTML.replace("09/16/2026", "09/14/2026"),
    LOTTO_PAYOUT_HTML.replace("<span>14</span>", "<span>15</span>"),
    LOTTO_PAYOUT_HTML.replace("Lotto Texas", "Powerball"),
    LOTTO_PAYOUT_HTML.replace("Prize Amount", "Award"),
    LOTTO_PAYOUT_HTML.replace("$160", "$161"),
    LOTTO_PAYOUT_HTML.replace("$60", "$6,0"),
    LOTTO_PAYOUT_HTML.replace("4 of 6", "4-of-6")
  ])("fails closed for a source, date, numbers, or prize-layout mismatch", (html) => {
    expect(() => parseOfficialPayoutPage("lotto", "2026-09-16", LOTTO_MAIN, [], html)).toThrow();
  });

  it("does not substitute the latest page or accept foreign/ambiguous links", () => {
    expect(() => resolveOfficialPayoutUrl("lotto", "2026-09-15", INDEX_HTML)).toThrow();
    expect(() =>
      resolveOfficialPayoutUrl(
        "lotto",
        "2026-09-16",
        INDEX_HTML.replace("www.texaslottery.com", "evil.invalid")
      )
    ).toThrow();
    expect(() =>
      resolveOfficialPayoutUrl(
        "lotto",
        "2026-09-16",
        INDEX_HTML + INDEX_HTML.replace("9731", "9732")
      )
    ).toThrow();
    expect(() =>
      parseOfficialPayoutPage("twostep", "2026-09-17", TWO_STEP_MAIN, [11], TWO_STEP_PAYOUT_HTML)
    ).toThrow(/winning numbers/);
  });
});

describe("automatic payout settlements and source resilience", () => {
  it("appends $60 once, persists verified evidence, reads cache offline, never resends win SMS", async () => {
    const item = await fixture();
    officialNetwork();
    const before = await env.LOTTO_DB.prepare(
      "SELECT COUNT(*) AS count FROM lotto_lab_delivery_outbox"
    ).first<{ count: number }>();
    expect(await reconcileOfficialPayouts(env, "lotto", NOW)).toMatchObject({
      scanned: 1,
      settled: 1,
      failed: 0
    });
    expect(await reconcileOfficialPayouts(env, "lotto", NOW)).toMatchObject({
      scanned: 0,
      settled: 0
    });
    const settlement = await env.LOTTO_DB.prepare(
      "SELECT * FROM lotto_grade_settlement_events WHERE ticket_grade_id=?1"
    )
      .bind(item.ticketGradeId)
      .first<{ final_prize_cents: number; source: string; evidence_json: string }>();
    expect(settlement).toMatchObject({ final_prize_cents: 6_000, source: LOTTO_PAYOUT_URL });
    expect(JSON.parse(settlement?.evidence_json ?? "{}")).toMatchObject({
      settlementMethod: "automatic-official-resource-v1"
    });
    network.use(http.get("*", () => HttpResponse.error()));
    expect(
      await ensureOfficialPayoutMetadata(env, "lotto", "2026-09-16", LOTTO_MAIN, [], NOW)
    ).toMatchObject({ official_payouts_cents: { "lotto:4": 6_000 } });
    expect(await readOfficialPayoutMetadata(env, "lotto", "2026-09-16", LOTTO_MAIN)).not.toBeNull();
    await reconcileResultNotifications(env, "lotto", NOW);
    expect(
      await env.LOTTO_DB.prepare("SELECT COUNT(*) AS count FROM lotto_lab_delivery_outbox").first()
    ).toEqual(before);
    expect(
      await env.LOTTO_DB.prepare(
        "SELECT message_body FROM lotto_lab_delivery_outbox WHERE grade_id IS NOT NULL"
      ).first()
    ).toMatchObject({
      message_body: expect.stringContaining("cash return $60.00, cost $1.00, net $59.00")
    });
    const card = (await readTrackRecord(env, { game: "lotto", from: null, to: null })).totals
      .proposals;
    expect(card).toMatchObject({
      gradedSpendCents: 100,
      wonCents: 6000,
      netCents: 5900,
      pendingPrizeCount: 0,
      roiPercent: 5900
    });
  });

  it("settles EXTRA at its published all-in $160, not base only", async () => {
    const item = await fixture(true);
    officialNetwork();
    expect(await reconcileOfficialPayouts(env, "lotto", NOW)).toMatchObject({ settled: 1 });
    expect(
      await env.LOTTO_DB.prepare(
        "SELECT final_prize_cents FROM lotto_grade_settlement_events WHERE ticket_grade_id=?1"
      )
        .bind(item.ticketGradeId)
        .first()
    ).toEqual({ final_prize_cents: 16_000 });
  });

  it("preserves manual settlement and rejects a concurrent automatic overwrite", async () => {
    const item = await fixture();
    await appendGradeSettlement(
      env,
      item.ticketGradeId,
      {
        idempotencyKey: "manual-payout-event",
        finalPrizeCents: 6_100,
        source: LOTTO_PAYOUT_URL,
        sourceSha256: "a".repeat(64)
      },
      NOW
    );
    expect(await reconcileOfficialPayouts(env, "lotto", NOW)).toMatchObject({
      scanned: 0,
      settled: 0
    });
    expect(
      await appendGradeSettlement(
        env,
        item.ticketGradeId,
        {
          idempotencyKey: "automatic-after-manual",
          finalPrizeCents: 6_000,
          source: LOTTO_PAYOUT_URL,
          sourceSha256: "b".repeat(64)
        },
        NOW,
        { expectedDrawFingerprint: "payout-fixture-lotto-2026-09-16" }
      )
    ).toMatchObject({ created: false });
    expect(
      await env.LOTTO_DB.prepare(
        "SELECT COUNT(*) AS count, SUM(final_prize_cents) AS cents FROM lotto_grade_settlement_events WHERE ticket_grade_id = ?1"
      )
        .bind(item.ticketGradeId)
        .first()
    ).toEqual({ count: 1, cents: 6_100 });
  });

  it("atomically rejects stale result fingerprints and newly excluded grades", async () => {
    const item = await fixture();
    const value = {
      idempotencyKey: "automatic-stale-test",
      finalPrizeCents: 6000,
      source: LOTTO_PAYOUT_URL,
      sourceSha256: "a".repeat(64)
    };
    await expect(
      appendGradeSettlement(env, item.ticketGradeId, value, NOW, {
        expectedDrawFingerprint: "superseded-result"
      })
    ).rejects.toThrow(/target changed/);
    await env.LOTTO_DB.prepare(
      `INSERT INTO lotto_ledger_eligibility_events
      (eligibility_event_id, ledger_id, idempotency_key, eligible, reason_code, reason, evidence_json, recorded_at, created_at)
      VALUES ('payout-stale-exclusion', ?1, 'payout-stale-exclusion', 0, 'manual-integrity-exclusion', 'Fixture exclusion', '{}', ?2, ?2)`
    )
      .bind(item.ledgerId, NOW.toISOString())
      .run();
    await expect(
      appendGradeSettlement(env, item.ticketGradeId, value, NOW, {
        expectedDrawFingerprint: "payout-fixture-lotto-2026-09-16"
      })
    ).rejects.toThrow(/target changed/);
    expect(await reconcileOfficialPayouts(env, "lotto", NOW)).toMatchObject({
      scanned: 0,
      settled: 0
    });
  });

  it("retries transient failures, then caches success", async () => {
    let requests = 0;
    network.use(
      http.get(INDEX, () => HttpResponse.html(INDEX_HTML)),
      http.get(LOTTO_PAYOUT_URL, () => {
        requests += 1;
        return requests < 3
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.html(LOTTO_PAYOUT_HTML);
      })
    );
    expect(
      await ensureOfficialPayoutMetadata(env, "lotto", "2026-09-16", LOTTO_MAIN, [], NOW)
    ).not.toBeNull();
    expect(requests).toBe(3);
  });

  it("retains pending payout on outage with observable retry state and backoff", async () => {
    await fixture();
    let requests = 0;
    network.use(
      http.get(INDEX, () => {
        requests += 1;
        return new HttpResponse(null, { status: 503 });
      })
    );
    expect(await reconcileOfficialPayouts(env, "lotto", NOW)).toMatchObject({
      settled: 0,
      failed: 1
    });
    expect(requests).toBe(3);
    expect(await reconcileOfficialPayouts(env, "lotto", NOW)).toMatchObject({
      settled: 0,
      skipped: 1,
      failed: 0
    });
    expect(requests).toBe(3);
    expect(
      await env.LOTTO_DB.prepare("SELECT status, error FROM lotto_payout_sources").first()
    ).toMatchObject({ status: "retry", error: "Error: Official payout HTTP 503" });
  });

  it("records schema mismatches and never creates a financial event", async () => {
    const item = await fixture();
    officialNetwork(LOTTO_PAYOUT_HTML.replace("09/16/2026", "09/14/2026"));
    expect(await reconcileOfficialPayouts(env, "lotto", NOW)).toMatchObject({
      settled: 0,
      failed: 1
    });
    expect(await env.LOTTO_DB.prepare("SELECT status FROM lotto_payout_sources").first()).toEqual({
      status: "mismatch"
    });
    expect(
      await env.LOTTO_DB.prepare(
        "SELECT COUNT(*) AS count FROM lotto_grade_settlement_events WHERE ticket_grade_id = ?1"
      )
        .bind(item.ticketGradeId)
        .first()
    ).toEqual({ count: 0 });
  });

  it("does not automatically settle jackpots or fixed-tier games", async () => {
    await appendLedgerEntry(
      env,
      {
        origin: "user",
        game: "lotto",
        drawDate: "2026-09-16",
        idempotencyKey: "jackpot-do-not-autosettle",
        tickets: [{ main: LOTTO_MAIN }]
      },
      new Date("2026-09-16T12:00:00Z")
    );
    await insertResult("lotto", "2026-09-16", LOTTO_MAIN);
    await gradeAvailableLedgerEntries(env, "lotto", NOW);
    expect(await reconcileOfficialPayouts(env, null, NOW)).toMatchObject({
      scanned: 0,
      settled: 0
    });
    expect(
      await ensureOfficialPayoutMetadata(env, "cash5", "2026-09-16", [1, 2, 3, 4, 5], [], NOW)
    ).toBeNull();
  });

  it("can acquire a Two Step page for a shadow-only win without a live ledger", async () => {
    const index =
      "https://www.texaslottery.com/export/sites/lottery/Games/Texas_Two_Step/Winning_Numbers/";
    network.use(
      http.get(index, () => HttpResponse.html(`<a href="${TWO_STEP_PAYOUT_URL}">09/17/2026</a>`)),
      http.get(TWO_STEP_PAYOUT_URL, () => HttpResponse.html(TWO_STEP_PAYOUT_HTML))
    );
    expect(
      await ensureOfficialPayoutMetadata(env, "twostep", "2026-09-17", TWO_STEP_MAIN, [12], NOW)
    ).toMatchObject({ official_payouts_cents: { "twostep:3+1": 5100 } });
  });

  it("invalidates a corrected draw's cached evidence and fetches a matching replacement", async () => {
    officialNetwork();
    await ensureOfficialPayoutMetadata(env, "lotto", "2026-09-16", LOTTO_MAIN, [], NOW);
    const corrected = [15, 26, 37, 46, 47, 51];
    expect(await readOfficialPayoutMetadata(env, "lotto", "2026-09-16", corrected)).toBeNull();
    officialNetwork(LOTTO_PAYOUT_HTML.replace("<span>14</span>", "<span>15</span>"));
    expect(
      await ensureOfficialPayoutMetadata(env, "lotto", "2026-09-16", corrected, [], NOW)
    ).not.toBeNull();
    expect(await readOfficialPayoutMetadata(env, "lotto", "2026-09-16", corrected)).not.toBeNull();
    expect(await readOfficialPayoutMetadata(env, "lotto", "2026-09-16", LOTTO_MAIN)).toBeNull();
  });

  it.each(["sent", "leased", "ambiguous"])(
    "never changes or resends an already attempted %s result",
    async (status) => {
      await fixture();
      await env.LOTTO_DB.prepare(
        "UPDATE lotto_lab_delivery_outbox SET status=?1, attempt_count=1, lease_token='attempted' WHERE grade_id IS NOT NULL"
      )
        .bind(status)
        .run();
      const before = await env.LOTTO_DB.prepare(
        "SELECT delivery_id, message_body, status FROM lotto_lab_delivery_outbox WHERE grade_id IS NOT NULL"
      ).first();
      officialNetwork();
      expect(await reconcileOfficialPayouts(env, "lotto", NOW)).toMatchObject({ settled: 1 });
      expect(
        await env.LOTTO_DB.prepare(
          "SELECT delivery_id, message_body, status FROM lotto_lab_delivery_outbox WHERE grade_id IS NOT NULL"
        ).first()
      ).toEqual(before);
      expect(
        await env.LOTTO_DB.prepare(
          "SELECT COUNT(*) AS count FROM lotto_lab_delivery_outbox WHERE grade_id IS NOT NULL"
        ).first()
      ).toEqual({ count: 1 });
    }
  );

  it("rejects oversized remote evidence without caching or settling it", async () => {
    await fixture();
    officialNetwork(LOTTO_PAYOUT_HTML + " ".repeat(512 * 1024));
    expect(await reconcileOfficialPayouts(env, "lotto", NOW)).toMatchObject({
      settled: 0,
      failed: 1
    });
    expect(
      await env.LOTTO_DB.prepare("SELECT status, object_key FROM lotto_payout_sources").first()
    ).toEqual({ status: "mismatch", object_key: null });
  });
});

describe("honest result accounting", () => {
  it("separates free-ticket face value from cash and explicitly reports a losing net", async () => {
    await appendLedgerEntry(
      env,
      {
        origin: "user",
        game: "cash5",
        drawDate: "2026-09-18",
        idempotencyKey: "cash-noncash-accounting",
        tickets: [{ main: [1, 2, 8, 9, 10] }]
      },
      new Date("2026-09-18T12:00:00Z")
    );
    await insertResult("cash5", "2026-09-18", [1, 2, 3, 4, 5]);
    await gradeAvailableLedgerEntries(env, "cash5", NOW);
    expect(
      (await readTrackRecord(env, { game: "cash5", from: null, to: null })).totals.proposals
    ).toMatchObject({
      wonCents: 0,
      gradedSpendCents: 100,
      nonCashValueCents: 100,
      netCents: -100,
      roiPercent: -100,
      economicRoiPercent: 0
    });
    const message = await env.LOTTO_DB.prepare(
      "SELECT message_body FROM lotto_lab_delivery_outbox WHERE grade_id IS NOT NULL"
    ).first<{ message_body: string }>();
    expect(message?.message_body).toContain("cash return $0.00, cost $1.00, net -$1.00");
    expect(message?.message_body).toContain("noncash ticket face value $1.00 (not cash)");
  });

  it("counts modeled Mega Millions multipliers on wins and misses", async () => {
    await appendLedgerEntry(
      env,
      {
        origin: "user",
        game: "mm",
        drawDate: "2026-09-18",
        idempotencyKey: "mm-modeled-accounting",
        tickets: [
          {
            main: [1, 2, 3, 4, 5],
            bonus: [12],
            options: { megaMultiplier: 3, multiplierProvenance: "modeled" }
          },
          {
            main: [1, 2, 3, 4, 5],
            bonus: [13],
            options: { megaMultiplier: 3, multiplierProvenance: "modeled" }
          }
        ]
      },
      new Date("2026-09-18T12:00:00Z")
    );
    await insertResult("mm", "2026-09-18", [10, 20, 30, 40, 50], [12]);
    await gradeAvailableLedgerEntries(env, "mm", NOW);
    expect(
      (await readTrackRecord(env, { game: "mm", from: null, to: null })).totals.proposals
    ).toMatchObject({
      modeledTickets: 2,
      modeledPrizeCents: 1500,
      wonCents: 1500,
      gradedSpendCents: 1000,
      netCents: 500
    });
    const message = await env.LOTTO_DB.prepare(
      "SELECT message_body FROM lotto_lab_delivery_outbox WHERE grade_id IS NOT NULL"
    ).first<{ message_body: string }>();
    expect(message?.message_body).toContain("multiplier/return modeled, not verified purchase");
  });
  it("excludes open ticket cost from graded ROI and labels incomplete payouts", async () => {
    await fixture();
    await appendLedgerEntry(
      env,
      {
        origin: "user",
        game: "lotto",
        drawDate: "2026-09-19",
        idempotencyKey: "future-open-cost",
        tickets: [{ main: [1, 2, 3, 4, 5, 6] }]
      },
      new Date("2026-09-19T12:00:00Z")
    );
    expect(
      (await readTrackRecord(env, { game: "lotto", from: null, to: null })).totals.proposals
    ).toMatchObject({
      spentCents: 200,
      gradedSpendCents: 100,
      openSpendCents: 100,
      knownNetCents: -100,
      netCents: null,
      roiPercent: null,
      economicRoiPercent: null
    });
    const message = await env.LOTTO_DB.prepare(
      "SELECT message_body FROM lotto_lab_delivery_outbox WHERE grade_id IS NOT NULL"
    ).first<{ message_body: string }>();
    expect(message?.message_body).toContain(
      "Paper set: known cash return $0.00, cost $1.00, known net -$1.00"
    );
    expect(message?.message_body).toContain("payout(s) pending, net/ROI incomplete");
    officialNetwork();
    await reconcileOfficialPayouts(env, "lotto", NOW);
    expect(
      (await readTrackRecord(env, { game: "lotto", from: null, to: null })).totals.proposals
    ).toMatchObject({
      spentCents: 200,
      gradedSpendCents: 100,
      openSpendCents: 100,
      roiPercent: 5900
    });
  });

  it("allocates confirmed costs to graded sets and keeps future confirmed spending open", async () => {
    await fixture(false, true);
    const open = await appendLedgerEntry(
      env,
      {
        origin: "user",
        game: "lotto",
        drawDate: "2026-09-19",
        idempotencyKey: "future-confirmed-cost",
        tickets: [{ main: [1, 2, 3, 4, 5, 6] }]
      },
      new Date("2026-09-19T12:00:00Z")
    );
    await appendPurchaseConfirmation(
      env,
      open.ledgerId,
      { idempotencyKey: "confirmed-open-payout", purchased: true, spendCents: 100, source: "user" },
      NOW
    );
    expect(
      (await readTrackRecord(env, { game: "lotto", from: null, to: null })).totals.confirmed
    ).toMatchObject({
      spentCents: 200,
      gradedSpendCents: 100,
      openSpendCents: 100,
      roiPercent: null
    });
  });
});
