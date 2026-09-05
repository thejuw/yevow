import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { scoreSplitRisk } from "../../web/lib/lotto/risk";
import type { Ticket } from "../../web/lib/lotto/types";
import { handleRequest } from "../src/api";
import { claimDelivery } from "../src/delivery";
import { refreshSource } from "../src/ingest";
import { getSource, type GameCode, type Session } from "../src/manifest";
import {
  appendGradeSettlement,
  appendLedgerEntry,
  appendPurchaseConfirmation,
  generationLedgerStatements,
  gradeAvailableLedgerEntries,
  gradeTicket,
  listTicketLabEntries,
  readTrackRecord,
  reconcileLegacyRandomBaselines
} from "../src/ticket-lab";
import { network } from "./network";

const CASH_DRAW_DATE = "2026-09-08";
const BEFORE_CASH_DRAW = new Date("2026-09-08T12:00:00Z");
const OFFICIAL_PAYOUT_SOURCE =
  "https://www.texaslottery.com/export/sites/lottery/Documents/test-fixture.pdf";
const OFFICIAL_PAYOUT_SHA256 = "a".repeat(64);

async function insertDraw(
  game: GameCode,
  drawDate: string,
  main: readonly number[],
  bonus: readonly number[] = [],
  session: Session = "",
  metadata: Readonly<Record<string, unknown>> = {}
): Promise<void> {
  const sourceId = `fixture:${game}:${session || "pool"}`;
  const now = `${drawDate}T23:59:00.000Z`;
  await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare(
      `INSERT OR IGNORE INTO lotto_sources
         (source_id, game, name, url, session, expected_widths, last_attempt_at,
          last_success_at, last_digest, last_status, row_count, active_count,
          latest_draw_date, created_at, updated_at)
       VALUES (?1, ?2, ?1, ?3, ?4, '[1]', ?5, ?5, ?6, 'complete', 1, 1, ?7, ?5, ?5)`
    ).bind(
      sourceId,
      game,
      `https://fixture.invalid/${game}/${session || "pool"}`,
      session,
      now,
      `source-${game}-${drawDate}-${session}`,
      drawDate
    ),
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_draws
         (game, draw_date, session, ordered_numbers, canonical_numbers, bonus_numbers,
          metadata, content_fingerprint, source_id, source_url, source_sha256,
          source_line, raw_record, seen_ingestion_id, active, first_seen_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
               1, 'official fixture', 'fixture-ingest', 1, ?12, ?12)`
    ).bind(
      game,
      drawDate,
      session,
      JSON.stringify(main),
      JSON.stringify([...main].sort((left, right) => left - right)),
      JSON.stringify(bonus),
      JSON.stringify(metadata),
      `fingerprint-${game}-${drawDate}-${session || "pool"}`,
      sourceId,
      `https://fixture.invalid/${game}/${session || "pool"}`,
      `sha-${game}-${drawDate}-${session || "pool"}`,
      now
    )
  ]);
}

function cashEntry(idempotencyKey: string, main: readonly number[]) {
  return {
    origin: "user",
    game: "cash5",
    drawDate: CASH_DRAW_DATE,
    idempotencyKey,
    tickets: [{ main }]
  };
}

// Dated result/ticket pairs are taken from the official Texas game pages and
// prize charts cited in docs/lotto-ticket-lab.md. Numbers are preserved in draw order.
describe("official Ticket Lab prize tables", () => {
  it("grades one official-draw fixture for every supported game", () => {
    expect(
      gradeTicket(
        "lotto",
        {
          main: [7, 19, 20, 23, 25, 54],
          bonus: [],
          playStyle: "straight",
          options: { extra: false }
        },
        { drawDate: "2026-09-02", main: [7, 19, 20, 23, 25, 39], bonus: [], metadata: {} }
      )
    ).toMatchObject({ mainMatches: 5, tier: "5 of 6", payoutStatus: "pending" });
    expect(
      gradeTicket(
        "twostep",
        { main: [10, 11, 14, 35], bonus: [4], playStyle: "straight", options: {} },
        { drawDate: "2026-09-03", main: [10, 11, 14, 18], bonus: [4], metadata: {} }
      )
    ).toMatchObject({ mainMatches: 3, bonusMatches: 1, payoutStatus: "pending" });
    expect(
      gradeTicket(
        "cash5",
        { main: [1, 3, 7, 17, 35], bonus: [], playStyle: "straight", options: {} },
        { drawDate: "2026-09-02", main: [1, 3, 7, 17, 25], bonus: [], metadata: {} }
      )
    ).toMatchObject({ mainMatches: 4, prizeCents: 35_000, payoutStatus: "fixed" });
    expect(
      gradeTicket(
        "pb",
        {
          main: [3, 4, 24, 36, 50],
          bonus: [17],
          playStyle: "straight",
          options: { powerPlay: true }
        },
        {
          drawDate: "2026-09-02",
          main: [3, 4, 24, 36, 47],
          bonus: [17],
          metadata: { power_play: 4 }
        }
      )
    ).toMatchObject({ mainMatches: 4, bonusMatches: 1, prizeCents: 20_000_000 });
    expect(
      gradeTicket(
        "pb",
        {
          main: [40, 41, 42, 43, 44],
          bonus: [17],
          playStyle: "straight",
          options: { powerPlay: false }
        },
        { drawDate: "2026-09-02", main: [3, 4, 24, 36, 47], bonus: [17], metadata: {} }
      )
    ).toMatchObject({ mainMatches: 0, bonusMatches: 1, prizeCents: 400 });
    expect(
      gradeTicket(
        "pb",
        {
          main: [3, 4, 24, 36, 47],
          bonus: [1],
          playStyle: "straight",
          options: { powerPlay: true }
        },
        { drawDate: "2026-09-02", main: [3, 4, 24, 36, 47], bonus: [17], metadata: {} }
      )
    ).toMatchObject({ mainMatches: 5, bonusMatches: 0, prizeCents: 200_000_000 });
    expect(
      gradeTicket(
        "mm",
        {
          main: [1, 22, 51, 61, 70],
          bonus: [1],
          playStyle: "straight",
          options: { megaMultiplier: 4, multiplierProvenance: "actual-purchase" }
        },
        { drawDate: "2026-09-02", main: [1, 22, 51, 61, 63], bonus: [17], metadata: {} }
      )
    ).toMatchObject({ mainMatches: 4, bonusMatches: 0, prizeCents: 200_000 });
    expect(
      gradeTicket(
        "p3",
        {
          main: [2, 0, 0],
          bonus: [],
          playStyle: "straight",
          options: { stakeCents: 100, fireball: false }
        },
        {
          drawDate: "2026-09-02",
          main: [2, 0, 0],
          bonus: [],
          metadata: { feature_name: "fireball", feature_value: 9 }
        }
      )
    ).toMatchObject({ tier: "straight", prizeCents: 50_000 });
    expect(
      gradeTicket(
        "d4",
        {
          main: [2, 4, 4, 0],
          bonus: [],
          playStyle: "straight",
          options: { stakeCents: 100, fireball: false }
        },
        {
          drawDate: "2026-09-02",
          main: [2, 4, 4, 0],
          bonus: [],
          metadata: { feature_name: "fireball", feature_value: 4 }
        }
      )
    ).toMatchObject({ tier: "straight", prizeCents: 500_000 });
    expect(
      gradeTicket(
        "aon",
        {
          main: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 24],
          bonus: [],
          playStyle: "straight",
          options: {}
        },
        {
          drawDate: "2026-09-02",
          main: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 23],
          bonus: [],
          metadata: {}
        }
      )
    ).toMatchObject({ mainMatches: 11, prizeCents: 50_000 });
  });

  it("keeps non-cash Cash Five awards out of cash ROI and honors Fireball multisets", () => {
    expect(
      gradeTicket(
        "cash5",
        { main: [1, 3, 30, 31, 32], bonus: [], playStyle: "straight", options: {} },
        { drawDate: "2026-09-02", main: [1, 3, 7, 17, 25], bonus: [], metadata: {} }
      )
    ).toMatchObject({ hit: true, prizeCents: 0, detail: { nonCashPrize: "Cash Five Quick Pick" } });
    expect(
      gradeTicket(
        "p3",
        {
          main: [9, 0, 0],
          bonus: [],
          playStyle: "straight",
          options: { stakeCents: 100, fireball: true }
        },
        {
          drawDate: "2026-09-02",
          main: [2, 0, 0],
          bonus: [],
          metadata: { feature_name: "fireball", feature_value: 9 }
        }
      )
    ).toMatchObject({ prizeCents: 18_000, detail: { fireballWins: 1 } });
    expect(
      gradeTicket(
        "d4",
        {
          main: [4, 4, 4, 0],
          bonus: [],
          playStyle: "straight",
          options: { stakeCents: 100, fireball: true }
        },
        {
          drawDate: "2026-09-02",
          main: [2, 4, 4, 0],
          bonus: [],
          metadata: { feature_name: "fireball", feature_value: 4 }
        }
      )
    ).toMatchObject({ prizeCents: 135_000, detail: { fireballWins: 1 } });
    expect(
      gradeTicket(
        "p3",
        {
          main: [2, 4, 4],
          bonus: [],
          playStyle: "straight",
          options: { stakeCents: 100, fireball: true }
        },
        {
          drawDate: "2026-09-02",
          main: [2, 4, 4],
          bonus: [],
          metadata: { feature_name: "fireball", feature_value: 4 }
        }
      )
    ).toMatchObject({ prizeCents: 86_000, detail: { fireballWins: 2 } });
    expect(
      gradeTicket(
        "d4",
        {
          main: [2, 4, 4, 0],
          bonus: [],
          playStyle: "straight",
          options: { stakeCents: 100, fireball: true }
        },
        {
          drawDate: "2026-09-02",
          main: [2, 4, 4, 0],
          bonus: [],
          metadata: { feature_name: "fireball", feature_value: 4 }
        }
      )
    ).toMatchObject({ prizeCents: 770_000, detail: { fireballWins: 2 } });
    expect(
      gradeTicket(
        "d4",
        {
          main: [9, 2, 3, 9],
          bonus: [],
          playStyle: "mid-pair",
          options: { stakeCents: 50, fireball: false, pairPosition: "mid" }
        },
        { drawDate: "2026-09-02", main: [0, 2, 3, 4], bonus: [], metadata: {} }
      )
    ).toMatchObject({ mainMatches: 2, tier: "mid-pair match", prizeCents: 2_500 });
  });

  it("gates rule eras, fails closed on digit stakes, and reports positional digit matches", () => {
    expect(() =>
      gradeTicket(
        "lotto",
        {
          main: [1, 2, 3, 4, 5, 6],
          bonus: [],
          playStyle: "straight",
          options: { extra: true }
        },
        { drawDate: "2013-04-13", main: [1, 2, 3, 4, 5, 7], bonus: [], metadata: {} }
      )
    ).toThrow(/Extra was not available/);
    expect(() =>
      gradeTicket(
        "p3",
        {
          main: [1, 2, 3],
          bonus: [],
          playStyle: "straight",
          options: { stakeCents: 50, fireball: true }
        },
        { drawDate: "2019-04-27", main: [1, 2, 3], bonus: [], metadata: {} }
      )
    ).toThrow(/FIREBALL was not available/);
    expect(() =>
      gradeTicket(
        "d4",
        { main: [1, 2, 3, 4], bonus: [], playStyle: "box", options: { fireball: false } },
        { drawDate: "2026-09-02", main: [4, 3, 2, 1], bonus: [], metadata: {} }
      )
    ).toThrow(/stakeCents/);
    expect(
      gradeTicket(
        "d4",
        {
          main: [1, 2, 3, 4],
          bonus: [],
          playStyle: "box",
          options: { stakeCents: 50, fireball: false }
        },
        { drawDate: "2026-09-02", main: [4, 2, 1, 3], bonus: [], metadata: {} }
      )
    ).toMatchObject({ hit: true, mainMatches: 1, tier: "24-way box" });
    expect(
      gradeTicket(
        "lotto",
        {
          main: [1, 2, 3, 4, 5, 20],
          bonus: [],
          playStyle: "straight",
          options: { extra: true }
        },
        { drawDate: "2026-09-02", main: [1, 2, 3, 4, 5, 6], bonus: [], metadata: {} }
      )
    ).toMatchObject({
      payoutStatus: "pending",
      detail: {
        settlementKind: "official-payout",
        manualSettlementIsAllIn: true,
        requiredExtraCents: 1_000_000
      }
    });
  });

  it("uses only provenanced fingerprinted payout overrides", () => {
    expect(
      gradeTicket(
        "lotto",
        {
          main: [1, 2, 3, 4, 5, 20],
          bonus: [],
          playStyle: "straight",
          options: { extra: true }
        },
        {
          drawDate: "2026-09-02",
          main: [1, 2, 3, 4, 5, 6],
          bonus: [],
          metadata: {
            official_payouts_cents: { "lotto:5": 250_000 },
            official_payouts_source: OFFICIAL_PAYOUT_SOURCE,
            official_payouts_source_sha256: OFFICIAL_PAYOUT_SHA256,
            official_payouts_certified: true
          }
        }
      )
    ).toMatchObject({
      payoutStatus: "fixed",
      prizeCents: 1_250_000,
      detail: { extraCents: 1_000_000, payoutProvenance: "fingerprinted-official-draw-metadata" }
    });
    expect(() =>
      gradeTicket(
        "pb",
        {
          main: [1, 2, 3, 4, 40],
          bonus: [5],
          playStyle: "straight",
          options: { powerPlay: false }
        },
        {
          drawDate: "2026-09-02",
          main: [1, 2, 3, 4, 6],
          bonus: [5],
          metadata: {
            official_payouts_cents: { "pb:4+1": 6_000_000 },
            official_payouts_source: OFFICIAL_PAYOUT_SOURCE,
            official_payouts_source_sha256: OFFICIAL_PAYOUT_SHA256
          }
        }
      )
    ).toThrow(/must be certified/);
    expect(() =>
      gradeTicket(
        "pb",
        {
          main: [1, 2, 3, 4, 40],
          bonus: [5],
          playStyle: "straight",
          options: { powerPlay: false }
        },
        {
          drawDate: "2026-09-02",
          main: [1, 2, 3, 4, 6],
          bonus: [5],
          metadata: {
            official_payouts_cents: { "pb:4+1": 6_000_000 },
            official_payouts_source: "https://example.invalid/not-official",
            official_payouts_source_sha256: OFFICIAL_PAYOUT_SHA256,
            official_payouts_certified: true
          }
        }
      )
    ).toThrow(/official Texas Lottery HTTPS URL/);
    expect(() =>
      gradeTicket(
        "pb",
        {
          main: [1, 2, 3, 4, 40],
          bonus: [5],
          playStyle: "straight",
          options: { powerPlay: false }
        },
        {
          drawDate: "2026-09-02",
          main: [1, 2, 3, 4, 6],
          bonus: [5],
          metadata: {
            official_payouts_cents: { "pb:4+1": 6_000_000 },
            official_payouts_source: OFFICIAL_PAYOUT_SOURCE,
            official_payouts_certified: true
          }
        }
      )
    ).toThrow(/64-hex SHA-256/);
    expect(() =>
      gradeTicket(
        "pb",
        {
          main: [1, 2, 3, 4, 40],
          bonus: [5],
          playStyle: "straight",
          options: { powerPlay: false }
        },
        {
          drawDate: "2026-09-02",
          main: [1, 2, 3, 4, 6],
          bonus: [5],
          metadata: {
            official_payouts_cents: { "pb:4+1": 6_000_000 },
            official_payouts_source: OFFICIAL_PAYOUT_SOURCE,
            official_payouts_source_sha256: "not-a-digest",
            official_payouts_certified: true
          }
        }
      )
    ).toThrow(/64-hex SHA-256/);
    expect(
      gradeTicket(
        "pb",
        {
          main: [1, 2, 3, 4, 40],
          bonus: [5],
          playStyle: "straight",
          options: { powerPlay: true }
        },
        {
          drawDate: "2026-09-02",
          main: [1, 2, 3, 4, 6],
          bonus: [5],
          metadata: {
            power_play: 4,
            official_payouts_cents: { "pb:4+1:power-play:4x": 12_345_600 },
            official_payouts_source: OFFICIAL_PAYOUT_SOURCE,
            official_payouts_source_sha256: OFFICIAL_PAYOUT_SHA256,
            official_payouts_certified: true
          }
        }
      )
    ).toMatchObject({ prizeCents: 12_345_600 });
    expect(
      gradeTicket(
        "mm",
        {
          main: [1, 2, 3, 4, 40],
          bonus: [5],
          playStyle: "straight",
          options: { megaMultiplier: 4, multiplierProvenance: "actual-purchase" }
        },
        {
          drawDate: "2026-09-02",
          main: [1, 2, 3, 4, 6],
          bonus: [5],
          metadata: {
            official_payouts_cents: { "mm:4+1:4x": 7_654_300 },
            official_payouts_source: OFFICIAL_PAYOUT_SOURCE,
            official_payouts_source_sha256: OFFICIAL_PAYOUT_SHA256,
            official_payouts_certified: true
          }
        }
      )
    ).toMatchObject({ prizeCents: 7_654_300 });
  });

  it("applies certified liability thresholds and rounds cap shares down to dollars", () => {
    const cashTicket = {
      main: [1, 2, 3, 4, 5],
      bonus: [] as number[],
      playStyle: "straight",
      options: {}
    };
    const cashResult = {
      drawDate: "2026-09-02",
      main: [1, 2, 3, 4, 5],
      bonus: [] as number[],
      metadata: {
        cash5_top_prize_winner_count: 3,
        official_payouts_certified: true,
        official_payouts_source: OFFICIAL_PAYOUT_SOURCE,
        official_payouts_source_sha256: OFFICIAL_PAYOUT_SHA256
      }
    };
    expect(gradeTicket("cash5", cashTicket, cashResult)).toMatchObject({
      payoutStatus: "fixed",
      prizeCents: 2_500_000
    });
    expect(
      gradeTicket("cash5", cashTicket, {
        ...cashResult,
        metadata: { ...cashResult.metadata, cash5_top_prize_winner_count: 7 }
      })
    ).toMatchObject({ prizeCents: 1_071_400, detail: { wholeDollarRounding: "down" } });

    const aonTicket = {
      main: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      bonus: [] as number[],
      playStyle: "straight",
      options: {}
    };
    const aonResult = {
      drawDate: "2026-09-02",
      main: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      bonus: [] as number[],
      metadata: {
        aon_combined_top_prize_winner_count: 20,
        official_payouts_certified: true,
        official_payouts_source: OFFICIAL_PAYOUT_SOURCE,
        official_payouts_source_sha256: OFFICIAL_PAYOUT_SHA256
      }
    };
    expect(gradeTicket("aon", aonTicket, aonResult)).toMatchObject({
      payoutStatus: "fixed",
      prizeCents: 25_000_000
    });
    expect(
      gradeTicket("aon", aonTicket, {
        ...aonResult,
        metadata: { ...aonResult.metadata, aon_combined_top_prize_winner_count: 21 }
      })
    ).toMatchObject({ prizeCents: 23_809_500, detail: { wholeDollarRounding: "down" } });
  });
});

describe("immutable Ticket Lab ledger", () => {
  it("uses server time, rejects idempotency collisions, and appends corrections", async () => {
    const first = await appendLedgerEntry(
      env,
      {
        ...cashEntry("manual-canonical-0001", [1, 2, 3, 4, 5]),
        proposedAt: "2001-01-01T00:00:00Z"
      },
      BEFORE_CASH_DRAW
    );
    expect(first.created).toBe(true);
    const row = await env.LOTTO_DB.prepare(
      "SELECT proposed_at FROM lotto_ticket_ledger WHERE ledger_id = ?1"
    )
      .bind(first.ledgerId)
      .first<{ proposed_at: string }>();
    expect(row?.proposed_at).toBe(BEFORE_CASH_DRAW.toISOString());

    const replay = await appendLedgerEntry(
      env,
      {
        ...cashEntry("manual-canonical-0001", [1, 2, 3, 4, 5]),
        proposedAt: "2001-01-01T00:00:00Z"
      },
      new Date("2026-09-09T03:03:00Z")
    );
    expect(replay).toEqual({ ledgerId: first.ledgerId, created: false });
    await expect(
      appendLedgerEntry(env, cashEntry("manual-canonical-0001", [6, 7, 8, 9, 10]), BEFORE_CASH_DRAW)
    ).rejects.toThrow(/idempotency key conflicts/);

    const correction = await appendLedgerEntry(
      env,
      {
        ...cashEntry("manual-correction-0002", [6, 7, 8, 9, 10]),
        correctionOf: first.ledgerId
      },
      BEFORE_CASH_DRAW
    );
    expect(correction.created).toBe(true);
    await expect(
      env.LOTTO_DB.prepare("UPDATE lotto_ticket_ledger SET seed = 'tampered' WHERE ledger_id = ?1")
        .bind(first.ledgerId)
        .run()
    ).rejects.toThrow(/immutable/);
    await expect(
      env.LOTTO_DB.prepare(
        "UPDATE lotto_ledger_tickets SET main_numbers = '[9,10,11,12,13]' WHERE ledger_id = ?1"
      )
        .bind(first.ledgerId)
        .run()
    ).rejects.toThrow(/immutable/);
    await expect(
      appendLedgerEntry(
        env,
        { ...cashEntry("manual-sunday-0003", [11, 12, 13, 14, 15]), drawDate: "2026-09-13" },
        new Date("2026-09-13T12:00:00Z")
      )
    ).rejects.toThrow(/does not draw/);

    await expect(
      appendLedgerEntry(
        env,
        {
          origin: "user",
          game: "d4",
          drawDate: CASH_DRAW_DATE,
          targetSession: "morning",
          idempotencyKey: "daily-four-pair-entry-0001",
          tickets: [
            {
              main: [1, 2, 3, 4],
              playStyle: "mid-pair",
              options: { stakeCents: 50, fireball: false, pairPosition: "mid" }
            }
          ]
        },
        BEFORE_CASH_DRAW
      )
    ).resolves.toMatchObject({ created: true });
    await expect(
      appendLedgerEntry(
        env,
        {
          origin: "user",
          game: "p3",
          drawDate: CASH_DRAW_DATE,
          targetSession: "morning",
          idempotencyKey: "pick-three-missing-stake-0001",
          tickets: [{ main: [1, 2, 3], playStyle: "straight", options: { fireball: false } }]
        },
        BEFORE_CASH_DRAW
      )
    ).rejects.toThrow(/explicit stakeCents/);
  });

  it("locks purchase evidence at the result/cutoff and validates actual ticket options", async () => {
    const entry = await appendLedgerEntry(
      env,
      cashEntry("purchase-entry-0001", [1, 2, 3, 4, 5]),
      BEFORE_CASH_DRAW
    );
    const purchase = {
      purchased: true,
      idempotencyKey: "purchase-event-0001",
      source: "budget-tracker",
      options: {}
    };
    const created = await appendPurchaseConfirmation(
      env,
      entry.ledgerId,
      purchase,
      BEFORE_CASH_DRAW
    );
    expect(created.created).toBe(true);
    expect(
      await appendPurchaseConfirmation(
        env,
        entry.ledgerId,
        purchase,
        new Date("2026-09-09T03:03:00Z")
      )
    ).toEqual({ eventId: created.eventId, created: false });
    await expect(
      appendPurchaseConfirmation(
        env,
        entry.ledgerId,
        { ...purchase, spendCents: 999 },
        BEFORE_CASH_DRAW
      )
    ).rejects.toThrow(/idempotency key conflicts/);

    await insertDraw("cash5", CASH_DRAW_DATE, [1, 2, 3, 4, 5]);
    await expect(
      appendPurchaseConfirmation(
        env,
        entry.ledgerId,
        { ...purchase, idempotencyKey: "purchase-event-0002" },
        BEFORE_CASH_DRAW
      )
    ).rejects.toThrow(/official result already exists/);
    await expect(
      env.LOTTO_DB.prepare(
        "UPDATE lotto_purchase_confirmation_events SET spend_cents = 0 WHERE purchase_event_id = ?1"
      )
        .bind(created.eventId)
        .run()
    ).rejects.toThrow(/append-only/);

    const mm = await appendLedgerEntry(
      env,
      {
        origin: "user",
        game: "mm",
        drawDate: CASH_DRAW_DATE,
        idempotencyKey: "mm-purchase-entry-0001",
        tickets: [{ main: [1, 2, 3, 4, 5], bonus: [1] }]
      },
      BEFORE_CASH_DRAW
    );
    await expect(
      appendPurchaseConfirmation(
        env,
        mm.ledgerId,
        { purchased: true, idempotencyKey: "mm-purchase-0001", source: "budget", options: {} },
        BEFORE_CASH_DRAW
      )
    ).rejects.toThrow(/actual printed multiplier/);
    await expect(
      appendPurchaseConfirmation(
        env,
        mm.ledgerId,
        {
          purchased: true,
          idempotencyKey: "mm-purchase-0002",
          source: "budget",
          options: { ticketOptions: [{ ordinal: 1, options: { megaMultiplier: 4 } }] }
        },
        BEFORE_CASH_DRAW
      )
    ).resolves.toMatchObject({ created: true });
    await expect(
      appendPurchaseConfirmation(
        env,
        mm.ledgerId,
        {
          purchased: true,
          idempotencyKey: "mm-purchase-0003",
          source: "budget",
          spendCents: 499,
          options: { ticketOptions: [{ ordinal: 1, options: { megaMultiplier: 4 } }] }
        },
        BEFORE_CASH_DRAW
      )
    ).rejects.toThrow(/official play cost 500/);
  });

  it("requires explicit bounded EV evidence for Power Play proposals", async () => {
    const input = {
      origin: "user",
      game: "pb",
      drawDate: "2026-09-09",
      idempotencyKey: "power-play-entry-0001",
      tickets: [{ main: [1, 2, 3, 4, 5], bonus: [1], options: { powerPlay: true } }]
    };
    await expect(appendLedgerEntry(env, input, new Date("2026-09-09T12:00:00Z"))).rejects.toThrow(
      /evNetCents/
    );
    await expect(
      appendLedgerEntry(
        env,
        {
          ...input,
          evNetCents: -250,
          evAssumption: "Caller-supplied official multiplier-weighted EV."
        },
        new Date("2026-09-09T12:00:00Z")
      )
    ).resolves.toMatchObject({ created: true });
  });
});

describe("grading, scoreboards, and delivery reconciliation", () => {
  it("grades equalized cohorts, aggregates whole-entry status, and repairs a lost outbox", async () => {
    const matchedDate = "2026-09-12";
    const beforeMatchedDraw = new Date("2026-09-12T12:00:00Z");
    const systemTickets: Ticket[] = [
      { game: "cash5", main: [1, 2, 3, 4, 5], playStyle: "straight" },
      { game: "cash5", main: [10, 11, 12, 30, 31], playStyle: "straight" }
    ];
    await env.LOTTO_DB.batch(
      await generationLedgerStatements(env.LOTTO_DB, {
        runId: "gen-11111111111111111111111111111111",
        game: "cash5",
        drawDate: matchedDate,
        generatedAt: beforeMatchedDraw.toISOString(),
        seed: "system-seed",
        tickets: systemTickets.map((ticket) => ({
          ticket,
          splitRisk: scoreSplitRisk("cash5", ticket)
        })),
        coverage: { distinctPairs: 20, possiblePairs: 20, coveragePercent: 100 },
        evNetCents: -50,
        evAssumption: "Test-time official EV snapshot.",
        ticketCostCents: 100,
        observedThrough: "2026-09-07",
        datasetDigest: "fixture-digest"
      })
    );
    const user = await appendLedgerEntry(
      env,
      { ...cashEntry("matched-user-entry-0001", [10, 11, 20, 21, 22]), drawDate: matchedDate },
      beforeMatchedDraw
    );
    const open = await appendLedgerEntry(
      env,
      { ...cashEntry("open-user-entry-0002", [20, 21, 22, 23, 24]), drawDate: "2026-09-14" },
      beforeMatchedDraw
    );
    await insertDraw("cash5", matchedDate, [10, 11, 12, 13, 14]);

    const grading = await gradeAvailableLedgerEntries(
      env,
      "cash5",
      new Date("2026-09-13T04:00:00Z")
    );
    expect(grading.gradedEntries).toBeGreaterThanOrEqual(3);
    expect(grading.gradedTickets).toBeGreaterThanOrEqual(5);
    const summary = await readTrackRecord(env, {
      game: "cash5",
      from: matchedDate,
      to: matchedDate
    });
    expect(summary.comparisonPolicy).toMatchObject({
      method: "shared-strata-min-ticket-count",
      origins: ["system", "random", "user"],
      sharedStrata: 1,
      ticketsPerOrigin: 1
    });
    expect(
      summary.comparisons.map((row) => [row.origin, row.gradedTickets, row.spentCents])
    ).toEqual([
      ["system", 1, 100],
      ["random", 1, 100],
      ["user", 1, 100]
    ]);
    expect(summary.comparisons.find((row) => row.origin === "user")).toMatchObject({
      wonCents: 0,
      nonCashValueCents: 100,
      roiPercent: -100,
      economicRoiPercent: 0
    });

    const system = await listTicketLabEntries(env, {
      game: "cash5",
      from: matchedDate,
      to: matchedDate,
      status: "won",
      limit: 20,
      cursor: null
    });
    expect(system.entries.find((entry) => entry.origin === "system")).toMatchObject({
      status: "won"
    });
    const userEntry = (
      await listTicketLabEntries(env, {
        game: "cash5",
        from: matchedDate,
        to: matchedDate,
        status: null,
        limit: 20,
        cursor: null
      })
    ).entries.find((entry) => entry.ledgerId === user.ledgerId) as Record<string, unknown>;
    const userTickets = userEntry.tickets as Array<{
      grade: { nonCashPrize: string; prizeCents: number };
    }>;
    expect(userTickets[0]?.grade).toMatchObject({
      nonCashPrize: "Cash Five Quick Pick",
      prizeCents: 0
    });
    expect((userEntry.purchase as { status: string; eventId: null }).status).toBe("unconfirmed");
    const entriesResponse = await handleRequest(
      new Request(
        `https://lotto-api.yevow.co/api/lotto/v1/ticket-lab/entries?game=cash5&from=${matchedDate}&to=${matchedDate}&limit=20`,
        { headers: { Authorization: "Bearer test-service-token" } }
      ),
      env
    );
    expect(entriesResponse.status).toBe(200);
    const entriesDocument = (await entriesResponse.json()) as {
      schemaVersion: number;
      data: { entries: Array<Record<string, unknown>> };
    };
    expect(entriesDocument.schemaVersion).toBe(1);
    const apiUser = entriesDocument.data.entries.find(
      (entry) => entry.ledgerId === user.ledgerId
    ) as Record<string, unknown>;
    expect(apiUser.purchase).toEqual({
      status: "unconfirmed",
      eventId: null,
      at: null,
      spendCents: 0
    });
    expect(apiUser).toMatchObject({
      origin: "user",
      baselineFor: null,
      status: "won",
      ticketCostCents: 100,
      wonCents: 0,
      pendingPrizeCount: 0,
      resultNotificationStatus: "pending"
    });
    const apiGrade = (
      apiUser.tickets as Array<{
        grade: {
          nonCashPrize: string | null;
          result: { sourceId: string; sourceSha256: string };
        };
      }>
    )[0]?.grade;
    expect(apiGrade?.nonCashPrize).toBe("Cash Five Quick Pick");
    expect(apiGrade?.result).toMatchObject({
      sourceId: "fixture:cash5:pool",
      sourceSha256: `sha-cash5-${matchedDate}-pool`
    });

    const lost = await listTicketLabEntries(env, {
      game: "cash5",
      from: null,
      to: null,
      status: "lost",
      limit: 100,
      cursor: null
    });
    expect(lost.entries.some((entry) => entry.ledgerId === open.ledgerId)).toBe(false);

    const beforeDelete = await env.LOTTO_DB.prepare(
      "SELECT COUNT(*) AS count FROM lotto_lab_delivery_outbox WHERE draw_date = ?1"
    )
      .bind(matchedDate)
      .first<{ count: number }>();
    expect(Number(beforeDelete?.count)).toBe(2);
    await env.LOTTO_DB.prepare("DELETE FROM lotto_lab_delivery_outbox WHERE draw_date = ?1")
      .bind(matchedDate)
      .run();
    expect(
      await gradeAvailableLedgerEntries(env, "cash5", new Date("2026-09-13T04:01:00Z"))
    ).toEqual({
      gradedEntries: 0,
      gradedTickets: 0
    });
    const repaired = await env.LOTTO_DB.prepare(
      "SELECT message_body FROM lotto_lab_delivery_outbox WHERE draw_date = ?1 ORDER BY delivery_id"
    )
      .bind(matchedDate)
      .all<{ message_body: string }>();
    expect(repaired.results).toHaveLength(2);
    expect(
      repaired.results.some((row) =>
        row.message_body.includes("free Cash Five Quick Pick (non-cash)")
      )
    ).toBe(true);
    expect(
      repaired.results.every((row) => row.message_body.includes("Next best-EV game: none today."))
    ).toBe(true);
    expect(
      repaired.results.every((row) =>
        row.message_body.includes("Picks are optimized, not predicted.")
      )
    ).toBe(true);

    await expect(
      env.LOTTO_DB.prepare("UPDATE lotto_ticket_grades SET hit = 0").run()
    ).rejects.toThrow(/immutable/);
  });

  it("settles pari-mutuel grades append-only and routes jackpot alerts to primary", async () => {
    const now = new Date("2026-09-07T12:00:00Z");
    const entry = await appendLedgerEntry(
      env,
      {
        origin: "user",
        game: "lotto",
        drawDate: "2026-09-07",
        idempotencyKey: "lotto-jackpot-entry-0001",
        tickets: [{ main: [1, 2, 3, 4, 5, 6], options: { extra: false } }]
      },
      now
    );
    await insertDraw("lotto", "2026-09-07", [1, 2, 3, 4, 5, 6]);
    await gradeAvailableLedgerEntries(env, "lotto", new Date("2026-09-08T04:00:00Z"));
    expect(
      (
        await readTrackRecord(env, {
          game: "lotto",
          from: "2026-09-07",
          to: "2026-09-07"
        })
      ).totals.proposals.bestHit
    ).toMatchObject({ prizeCents: null, payoutStatus: "pending" });
    const pendingSummaryResponse = await handleRequest(
      new Request(
        "https://lotto-api.yevow.co/api/lotto/v1/ticket-lab/summary?game=lotto&from=2026-09-07&to=2026-09-07",
        { headers: { Authorization: "Bearer test-service-token" } }
      ),
      env
    );
    expect(pendingSummaryResponse.status).toBe(200);
    await expect(pendingSummaryResponse.json()).resolves.toMatchObject({
      schemaVersion: 1,
      data: {
        totals: {
          proposals: {
            nonCashValueCents: 0,
            bestHit: { prizeCents: null, payoutStatus: "pending" }
          }
        },
        comparisonPolicy: {
          method: "shared-strata-min-ticket-count",
          strata: ["game", "drawDate", "targetSession"]
        }
      }
    });
    const listed = await listTicketLabEntries(env, {
      game: "lotto",
      from: null,
      to: null,
      status: "pending",
      limit: 10,
      cursor: null
    });
    const ticket = (listed.entries[0] as { tickets: Array<{ grade: { gradeId: string } }> })
      .tickets[0];
    const ticketGradeId = ticket?.grade.gradeId as string;
    const settlement = {
      idempotencyKey: "official-payout-0001",
      finalPrizeCents: 1_234_567_800,
      source: OFFICIAL_PAYOUT_SOURCE,
      sourceSha256: OFFICIAL_PAYOUT_SHA256,
      note: "Claim value fixture"
    };
    const first = await appendGradeSettlement(
      env,
      ticketGradeId,
      settlement,
      new Date("2026-09-08T12:00:00Z")
    );
    expect(first.created).toBe(true);
    await expect(
      env.LOTTO_DB.prepare(
        "UPDATE lotto_grade_settlement_events SET final_prize_cents = 1 WHERE settlement_id = ?1"
      )
        .bind(first.settlementId)
        .run()
    ).rejects.toThrow(/append-only/);
    expect(
      await appendGradeSettlement(env, ticketGradeId, settlement, new Date("2026-09-09T12:00:00Z"))
    ).toEqual({ settlementId: first.settlementId, created: false });
    await expect(
      appendGradeSettlement(
        env,
        ticketGradeId,
        { ...settlement, finalPrizeCents: 1 },
        new Date("2026-09-09T12:00:00Z")
      )
    ).rejects.toThrow(/idempotency key conflicts/);
    await expect(
      appendPurchaseConfirmation(
        env,
        entry.ledgerId,
        { purchased: true, idempotencyKey: "late-purchase-0001", source: "budget", options: {} },
        now
      )
    ).rejects.toThrow(/official result already exists/);

    const settled = await listTicketLabEntries(env, {
      game: "lotto",
      from: null,
      to: null,
      status: "won",
      limit: 10,
      cursor: null
    });
    expect(settled.entries[0]).toMatchObject({
      wonCents: 1_234_567_800,
      pendingPrizeCount: 0,
      tickets: [
        {
          grade: {
            settlement: {
              source: OFFICIAL_PAYOUT_SOURCE,
              evidence: {
                settlementKind: "official-payout",
                officialSourceSha256: OFFICIAL_PAYOUT_SHA256
              }
            }
          }
        }
      ]
    });
    expect(
      (
        await readTrackRecord(env, {
          game: "lotto",
          from: "2026-09-07",
          to: "2026-09-07"
        })
      ).totals.proposals.bestHit
    ).toMatchObject({ prizeCents: 1_234_567_800, payoutStatus: "settled" });
    const outbox = await env.LOTTO_DB.prepare(
      `SELECT target_role, priority FROM lotto_lab_delivery_outbox
       WHERE game = 'lotto' AND draw_date = '2026-09-07'`
    ).first<{ target_role: string; priority: number }>();
    expect(outbox).toEqual({ target_role: "primary", priority: 100 });
  });

  it("requires corrected official evidence instead of settling a missing multiplier", async () => {
    const drawDate = "2026-09-12";
    const entry = await appendLedgerEntry(
      env,
      {
        origin: "user",
        game: "pb",
        drawDate,
        idempotencyKey: "pb-missing-multiplier-entry-0001",
        evNetCents: -250,
        evAssumption: "Official multiplier-weighted EV supplied by the service caller.",
        tickets: [
          {
            main: [1, 2, 3, 4, 40],
            bonus: [5],
            options: { powerPlay: true }
          }
        ]
      },
      new Date("2026-09-12T12:00:00Z")
    );
    await insertDraw("pb", drawDate, [1, 2, 3, 4, 6], [5]);
    await gradeAvailableLedgerEntries(env, "pb", new Date("2026-09-13T04:00:00Z"));
    const listed = await listTicketLabEntries(env, {
      game: "pb",
      from: drawDate,
      to: drawDate,
      status: "pending",
      limit: 10,
      cursor: null
    });
    const selected = listed.entries.find((candidate) => candidate.ledgerId === entry.ledgerId) as {
      tickets: Array<{ grade: { gradeId: string; detail: { settlementKind: string } } }>;
    };
    expect(selected.tickets[0]?.grade.detail.settlementKind).toBe("missing-result-evidence");
    await expect(
      appendGradeSettlement(
        env,
        selected.tickets[0]?.grade.gradeId as string,
        {
          idempotencyKey: "invalid-multiplier-settlement-0001",
          finalPrizeCents: 20_000_000,
          source: "manual guess"
        },
        new Date("2026-09-13T12:00:00Z")
      )
    ).rejects.toThrow(/correct the official draw and regrade/);

    await env.LOTTO_DB.prepare(
      `UPDATE lotto_draws
       SET metadata = '{"power_play":4}',
           content_fingerprint = 'fingerprint-pb-2026-09-12-corrected',
           source_sha256 = 'sha-pb-2026-09-12-corrected'
       WHERE game = 'pb' AND draw_date = ?1 AND session = ''`
    )
      .bind(drawDate)
      .run();
    await expect(
      gradeAvailableLedgerEntries(env, "pb", new Date("2026-09-13T12:05:00Z"))
    ).resolves.toMatchObject({ gradedEntries: 1, gradedTickets: 1 });
    const corrected = await listTicketLabEntries(env, {
      game: "pb",
      from: drawDate,
      to: drawDate,
      status: "won",
      limit: 10,
      cursor: null
    });
    const correctedEntry = corrected.entries.find(
      (candidate) => candidate.ledgerId === entry.ledgerId
    ) as { tickets: Array<{ grade: { revision: number; prizeCents: number } }> };
    expect(correctedEntry.tickets[0]?.grade).toMatchObject({
      revision: 2,
      prizeCents: 20_000_000
    });
  });

  it("enforces whole-dollar, capped manual liability settlements", async () => {
    const drawDate = "2026-09-10";
    const entry = await appendLedgerEntry(
      env,
      {
        ...cashEntry("cash-five-cap-settlement-entry-0001", [1, 2, 3, 4, 5]),
        drawDate
      },
      new Date("2026-09-10T12:00:00Z")
    );
    await insertDraw("cash5", drawDate, [1, 2, 3, 4, 5]);
    await gradeAvailableLedgerEntries(env, "cash5", new Date("2026-09-11T04:00:00Z"));
    const listed = await listTicketLabEntries(env, {
      game: "cash5",
      from: drawDate,
      to: drawDate,
      status: "pending",
      limit: 10,
      cursor: null
    });
    const selected = listed.entries.find((candidate) => candidate.ledgerId === entry.ledgerId) as {
      tickets: Array<{ grade: { gradeId: string } }>;
    };
    const ticketGradeId = selected.tickets[0]?.grade.gradeId as string;
    await expect(
      appendGradeSettlement(
        env,
        ticketGradeId,
        {
          idempotencyKey: "cash-cap-invalid-source-0001",
          finalPrizeCents: 1_071_400,
          certifiedWinnerCount: 7,
          source: "https://example.invalid/not-official",
          sourceSha256: OFFICIAL_PAYOUT_SHA256
        },
        new Date("2026-09-11T12:00:00Z")
      )
    ).rejects.toThrow(/official Texas Lottery HTTPS URL/);
    await expect(
      appendGradeSettlement(
        env,
        ticketGradeId,
        {
          idempotencyKey: "cash-cap-missing-sha-0002",
          finalPrizeCents: 1_071_400,
          certifiedWinnerCount: 7,
          source: OFFICIAL_PAYOUT_SOURCE
        },
        new Date("2026-09-11T12:00:00Z")
      )
    ).rejects.toThrow(/sourceSha256 is required/);
    await expect(
      appendGradeSettlement(
        env,
        ticketGradeId,
        {
          idempotencyKey: "cash-cap-invalid-sha-0003",
          finalPrizeCents: 1_071_400,
          certifiedWinnerCount: 7,
          source: OFFICIAL_PAYOUT_SOURCE,
          sourceSha256: "not-a-digest"
        },
        new Date("2026-09-11T12:00:00Z")
      )
    ).rejects.toThrow(/64-hex SHA-256/);
    await expect(
      appendGradeSettlement(
        env,
        ticketGradeId,
        {
          idempotencyKey: "cash-cap-invalid-cents-0001",
          finalPrizeCents: 1_071_450,
          certifiedWinnerCount: 7,
          source: OFFICIAL_PAYOUT_SOURCE,
          sourceSha256: OFFICIAL_PAYOUT_SHA256
        },
        new Date("2026-09-11T12:00:00Z")
      )
    ).rejects.toThrow(/whole dollars/);
    await expect(
      appendGradeSettlement(
        env,
        ticketGradeId,
        {
          idempotencyKey: "cash-cap-missing-count-0002",
          finalPrizeCents: 1_071_400,
          source: OFFICIAL_PAYOUT_SOURCE,
          sourceSha256: OFFICIAL_PAYOUT_SHA256
        },
        new Date("2026-09-11T12:00:00Z")
      )
    ).rejects.toThrow(/certifiedWinnerCount/);
    await expect(
      appendGradeSettlement(
        env,
        ticketGradeId,
        {
          idempotencyKey: "cash-cap-mismatched-count-0003",
          finalPrizeCents: 1_000_000,
          certifiedWinnerCount: 7,
          source: OFFICIAL_PAYOUT_SOURCE,
          sourceSha256: OFFICIAL_PAYOUT_SHA256
        },
        new Date("2026-09-11T12:00:00Z")
      )
    ).rejects.toThrow(/must equal 1071400/);
    await expect(
      appendGradeSettlement(
        env,
        ticketGradeId,
        {
          idempotencyKey: "cash-cap-valid-settlement-0004",
          finalPrizeCents: 1_071_400,
          certifiedWinnerCount: 7,
          source: OFFICIAL_PAYOUT_SOURCE,
          sourceSha256: OFFICIAL_PAYOUT_SHA256
        },
        new Date("2026-09-11T12:00:00Z")
      )
    ).resolves.toMatchObject({ created: true });
    const settled = await listTicketLabEntries(env, {
      game: "cash5",
      from: drawDate,
      to: drawDate,
      status: "won",
      limit: 10,
      cursor: null
    });
    expect(settled.entries).toContainEqual(
      expect.objectContaining({
        ledgerId: entry.ledgerId,
        tickets: [
          expect.objectContaining({
            grade: expect.objectContaining({
              settlement: expect.objectContaining({
                evidence: {
                  settlementKind: "official-payout",
                  officialSourceSha256: OFFICIAL_PAYOUT_SHA256,
                  liabilityGame: "cash5",
                  certifiedWinnerCount: 7,
                  threshold: 3,
                  nominalPrizeCents: 2_500_000,
                  liabilityCapCents: 7_500_000,
                  wholeDollarRounding: "down",
                  expectedPrizeCents: 1_071_400
                }
              })
            })
          })
        ]
      })
    );
  });

  it("derives both All or Nothing liability settlement branches from certified counts", async () => {
    const nominalDate = "2026-09-10";
    const cappedDate = "2026-09-11";
    const ticket = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const nominal = await appendLedgerEntry(
      env,
      {
        origin: "user",
        game: "aon",
        drawDate: nominalDate,
        targetSession: "morning",
        idempotencyKey: "aon-nominal-settlement-entry-0001",
        tickets: [{ main: ticket }]
      },
      new Date("2026-09-10T12:00:00Z")
    );
    const capped = await appendLedgerEntry(
      env,
      {
        origin: "user",
        game: "aon",
        drawDate: cappedDate,
        targetSession: "morning",
        idempotencyKey: "aon-capped-settlement-entry-0002",
        tickets: [{ main: ticket }]
      },
      new Date("2026-09-11T12:00:00Z")
    );
    await insertDraw("aon", nominalDate, ticket, [], "morning");
    await insertDraw("aon", cappedDate, ticket, [], "morning");
    await gradeAvailableLedgerEntries(env, "aon", new Date("2026-09-12T04:00:00Z"));
    const pending = await listTicketLabEntries(env, {
      game: "aon",
      from: nominalDate,
      to: cappedDate,
      status: "pending",
      limit: 10,
      cursor: null
    });
    const gradeId = (ledgerId: string): string => {
      const entry = pending.entries.find((candidate) => candidate.ledgerId === ledgerId) as {
        tickets: Array<{ grade: { gradeId: string } }>;
      };
      return entry.tickets[0]?.grade.gradeId as string;
    };
    await expect(
      appendGradeSettlement(
        env,
        gradeId(nominal.ledgerId),
        {
          idempotencyKey: "aon-nominal-settlement-0001",
          finalPrizeCents: 25_000_000,
          certifiedWinnerCount: 20,
          source: OFFICIAL_PAYOUT_SOURCE,
          sourceSha256: OFFICIAL_PAYOUT_SHA256
        },
        new Date("2026-09-12T12:00:00Z")
      )
    ).resolves.toMatchObject({ created: true });
    await expect(
      appendGradeSettlement(
        env,
        gradeId(capped.ledgerId),
        {
          idempotencyKey: "aon-capped-missing-count-0002",
          finalPrizeCents: 23_809_500,
          source: OFFICIAL_PAYOUT_SOURCE,
          sourceSha256: OFFICIAL_PAYOUT_SHA256
        },
        new Date("2026-09-12T12:00:00Z")
      )
    ).rejects.toThrow(/certifiedWinnerCount/);
    await expect(
      appendGradeSettlement(
        env,
        gradeId(capped.ledgerId),
        {
          idempotencyKey: "aon-capped-mismatch-0003",
          finalPrizeCents: 23_809_600,
          certifiedWinnerCount: 21,
          source: OFFICIAL_PAYOUT_SOURCE,
          sourceSha256: OFFICIAL_PAYOUT_SHA256
        },
        new Date("2026-09-12T12:00:00Z")
      )
    ).rejects.toThrow(/must equal 23809500/);
    await expect(
      appendGradeSettlement(
        env,
        gradeId(capped.ledgerId),
        {
          idempotencyKey: "aon-capped-settlement-0004",
          finalPrizeCents: 23_809_500,
          certifiedWinnerCount: 21,
          source: OFFICIAL_PAYOUT_SOURCE,
          sourceSha256: OFFICIAL_PAYOUT_SHA256
        },
        new Date("2026-09-12T12:00:00Z")
      )
    ).resolves.toMatchObject({ created: true });
    const settled = await listTicketLabEntries(env, {
      game: "aon",
      from: nominalDate,
      to: cappedDate,
      status: "won",
      limit: 10,
      cursor: null
    });
    const cappedEntry = settled.entries.find(
      (candidate) => candidate.ledgerId === capped.ledgerId
    ) as { tickets: Array<{ grade: { settlement: { evidence: Record<string, unknown> } } }> };
    expect(cappedEntry.tickets[0]?.grade.settlement.evidence).toMatchObject({
      liabilityGame: "aon",
      certifiedWinnerCount: 21,
      threshold: 20,
      expectedPrizeCents: 23_809_500,
      wholeDollarRounding: "down"
    });
  });

  it("reconciles random controls for already-backfilled Phase 3 system ledgers", async () => {
    const ledgerId = "ledger-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await env.LOTTO_DB.batch([
      env.LOTTO_DB.prepare(
        `INSERT INTO lotto_ticket_ledger
           (ledger_id, run_id, origin, correction_of, baseline_for, game, draw_date,
            target_session, proposed_at, seed, coverage_distinct_pairs,
            coverage_possible_pairs, coverage_basis_points, ev_net_cents, ev_assumption,
            ticket_cost_cents, ticket_count, split_risk_model_json, observed_through,
            dataset_digest, created_at)
         VALUES (?1, 'gen-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'system', NULL, NULL,
                 'cash5', ?2, '', ?3, 'legacy-seed', 10, 10, 10000, -50,
                 'Legacy Phase 3 snapshot', 100, 1, '{"model":"legacy"}',
                 '2026-09-07', 'legacy-digest', ?3)`
      ).bind(ledgerId, CASH_DRAW_DATE, BEFORE_CASH_DRAW.toISOString()),
      env.LOTTO_DB.prepare(
        `INSERT INTO lotto_ledger_tickets
           (ledger_ticket_id, ledger_id, ordinal, main_numbers, bonus_numbers,
            play_style, wager_cents, ticket_options_json, split_risk_basis_points,
            split_risk_level, split_risk_notes, created_at)
         VALUES ('lt-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-1', ?1, 1, '[1,2,3,4,5]',
                 '[]', 'straight', 100, '{"basePlay":true}', 2500, 'moderate',
                 '["legacy"]', ?2)`
      ).bind(ledgerId, BEFORE_CASH_DRAW.toISOString())
    ]);

    expect(await reconcileLegacyRandomBaselines(env)).toBe(1);
    expect(await reconcileLegacyRandomBaselines(env)).toBe(0);
    const baseline = await env.LOTTO_DB.prepare(
      `SELECT origin, baseline_for, ticket_count FROM lotto_ticket_ledger
       WHERE baseline_for = ?1`
    )
      .bind(ledgerId)
      .first<{ origin: string; baseline_for: string; ticket_count: number }>();
    expect(baseline).toEqual({ origin: "random", baseline_for: ledgerId, ticket_count: 1 });
  });

  it("turns a post-ingest grading failure into a deliverable unhealthy alert", async () => {
    const source = getSource("cash5:cashfive");
    const ledgerId = "ledger-cccccccccccccccccccccccccccccccc";
    await env.LOTTO_DB.batch([
      env.LOTTO_DB.prepare(
        `INSERT INTO lotto_ticket_ledger
           (ledger_id, run_id, origin, correction_of, baseline_for, game, draw_date,
            target_session, proposed_at, seed, coverage_distinct_pairs,
            coverage_possible_pairs, coverage_basis_points, ev_net_cents, ev_assumption,
            ticket_cost_cents, ticket_count, split_risk_model_json, observed_through,
            dataset_digest, created_at)
         VALUES (?1, NULL, 'user', NULL, NULL, 'cash5', '2026-09-04', '',
                 '2026-09-04T12:00:00.000Z', 'corrupt-fixture', 10, 10, 10000, -50,
                 'Integrity failure fixture', 100, 2, '{"model":"fixture"}', NULL, NULL,
                 '2026-09-04T12:00:00.000Z')`
      ).bind(ledgerId),
      env.LOTTO_DB.prepare(
        `INSERT INTO lotto_ledger_tickets
           (ledger_ticket_id, ledger_id, ordinal, main_numbers, bonus_numbers,
            play_style, wager_cents, ticket_options_json, split_risk_basis_points,
            split_risk_level, split_risk_notes, created_at)
         VALUES ('lt-cccccccccccccccccccccccccccccccc-1', ?1, 1, '[1,2,3,4,5]',
                 '[]', 'straight', 100, '{"basePlay":true}', 2500, 'moderate', '[]',
                 '2026-09-04T12:00:00.000Z')`
      ).bind(ledgerId)
    ]);
    network.use(
      http.get(source.url, () =>
        HttpResponse.text("Cash Five,9,4,2026,1,2,3,4,5\n", {
          headers: { "Content-Type": "text/csv" }
        })
      )
    );

    await expect(refreshSource(env, source.id, "test")).rejects.toThrow(/ticket count/);
    const alert = await env.LOTTO_DB.prepare(
      `SELECT delivery_id, grade_id, delivery_kind, target_role, priority, status
       FROM lotto_lab_delivery_outbox WHERE delivery_kind = 'alert' ORDER BY created_at DESC LIMIT 1`
    ).first<{
      delivery_id: string;
      grade_id: string | null;
      delivery_kind: string;
      target_role: string;
      priority: number;
      status: string;
    }>();
    expect(alert).toMatchObject({
      grade_id: null,
      delivery_kind: "alert",
      target_role: "fallback",
      priority: 100,
      status: "pending"
    });
    const claim = await claimDelivery(env, new Date(Date.now() + 1_000));
    expect(claim).toMatchObject({ deliveryId: alert?.delivery_id, kind: "alert" });
    const health = await handleRequest(new Request("https://lotto-api.yevow.co/healthz"), env);
    expect(health.status).toBe(503);
    await expect(health.json()).resolves.toMatchObject({
      data: { status: "degraded", unresolvedTicketLabAlerts: 1 }
    });
  });

  it("authenticates and validates service ledger and purchase POST contracts", async () => {
    const endpoint = "https://lotto-api.yevow.co/api/lotto/v1/ticket-lab/entries";
    const input = {
      origin: "user",
      game: "cash5",
      drawDate: "2099-01-05",
      idempotencyKey: "api-ledger-entry-0001",
      tickets: [{ main: [1, 2, 3, 4, 5] }]
    };
    const post = (url: string, body: unknown, authorized = true): Promise<Response> =>
      handleRequest(
        new Request(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authorized ? { Authorization: "Bearer test-service-token" } : {})
          },
          body: JSON.stringify(body)
        }),
        env
      );

    expect((await post(endpoint, input, false)).status).toBe(401);
    expect(
      (
        await post(endpoint, {
          ...input,
          drawDate: "2099-01-04",
          idempotencyKey: "api-ledger-invalid-day-0002"
        })
      ).status
    ).toBe(400);
    const created = await post(endpoint, input);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      schemaVersion: number;
      data: { ledgerId: string; created: boolean };
    };
    expect(createdBody).toMatchObject({ schemaVersion: 1, data: { created: true } });
    expect((await post(endpoint, input)).status).toBe(200);
    const conflict = await post(endpoint, {
      ...input,
      tickets: [{ main: [6, 7, 8, 9, 10] }]
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" }
    });

    const purchaseEndpoint = `${endpoint}/${createdBody.data.ledgerId}/purchase-confirmations`;
    const purchase = {
      purchased: true,
      idempotencyKey: "api-purchase-event-0001",
      source: "budget-tracker",
      options: {}
    };
    expect((await post(purchaseEndpoint, purchase, false)).status).toBe(401);
    expect(
      (
        await post(purchaseEndpoint, {
          ...purchase,
          idempotencyKey: "api-purchase-invalid-spend-0002",
          spendCents: 999
        })
      ).status
    ).toBe(400);
    const purchased = await post(purchaseEndpoint, purchase);
    expect(purchased.status).toBe(201);
    await expect(purchased.json()).resolves.toMatchObject({
      schemaVersion: 1,
      data: { created: true }
    });
    expect((await post(purchaseEndpoint, purchase)).status).toBe(200);
    const purchaseConflict = await post(purchaseEndpoint, { ...purchase, spendCents: 999 });
    expect(purchaseConflict.status).toBe(409);
    await expect(purchaseConflict.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" }
    });
  });

  it("authenticates and validates the service settlement POST contract", async () => {
    const entry = await appendLedgerEntry(
      env,
      {
        origin: "user",
        game: "lotto",
        drawDate: "2026-09-02",
        idempotencyKey: "api-settlement-ledger-0001",
        tickets: [{ main: [1, 2, 3, 4, 5, 6], options: { extra: false } }]
      },
      new Date("2026-09-02T12:00:00Z")
    );
    await insertDraw("lotto", "2026-09-02", [1, 2, 3, 4, 5, 6]);
    await gradeAvailableLedgerEntries(env, "lotto", new Date("2026-09-03T04:00:00Z"));
    const listed = await listTicketLabEntries(env, {
      game: "lotto",
      from: "2026-09-02",
      to: "2026-09-02",
      status: "pending",
      limit: 10,
      cursor: null
    });
    const pending = listed.entries.find((candidate) => candidate.ledgerId === entry.ledgerId) as {
      tickets: Array<{ grade: { gradeId: string } }>;
    };
    const endpoint = `https://lotto-api.yevow.co/api/lotto/v1/ticket-lab/grades/${pending.tickets[0]?.grade.gradeId}/settlement`;
    const settlement = {
      idempotencyKey: "api-grade-settlement-0001",
      finalPrizeCents: 100_000_000,
      source: OFFICIAL_PAYOUT_SOURCE,
      sourceSha256: OFFICIAL_PAYOUT_SHA256
    };
    const post = (body: unknown, authorized = true): Promise<Response> =>
      handleRequest(
        new Request(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authorized ? { Authorization: "Bearer test-service-token" } : {})
          },
          body: JSON.stringify(body)
        }),
        env
      );

    expect((await post(settlement, false)).status).toBe(401);
    expect(
      (
        await post({
          ...settlement,
          idempotencyKey: "api-grade-invalid-source-0002",
          source: "https://example.invalid/not-official"
        })
      ).status
    ).toBe(400);
    const created = await post(settlement);
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      schemaVersion: 1,
      data: { created: true }
    });
    expect((await post(settlement)).status).toBe(200);
    const conflict = await post({ ...settlement, finalPrizeCents: 100_000_100 });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" }
    });
  });

  it("protects Ticket Lab reads with dashboard auth", async () => {
    const denied = await handleRequest(
      new Request("https://lotto-api.yevow.co/api/lotto/v1/ticket-lab/summary"),
      env
    );
    expect(denied.status).toBe(401);
    const allowed = await handleRequest(
      new Request("https://lotto-api.yevow.co/api/lotto/v1/ticket-lab/entries?limit=5", {
        headers: { Authorization: "Bearer test-service-token" }
      }),
      env
    );
    expect(allowed.status).toBe(200);
    const document = (await allowed.json()) as {
      schemaVersion: number;
      data: { entries: unknown[] };
    };
    expect(document.schemaVersion).toBe(1);
    expect(Array.isArray(document.data.entries)).toBe(true);
  });
});
