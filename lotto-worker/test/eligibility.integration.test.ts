import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { handleRequest } from "../src/api";
import type { GameCode, Session } from "../src/manifest";
import {
  appendLedgerEligibilityEvent,
  appendLedgerEntry,
  gradeAvailableLedgerEntries,
  listTicketLabEntries,
  readTrackRecord,
  reconcileLedgerEligibility
} from "../src/ticket-lab";

const DRAW_DATE = "2026-09-16";
const RECONCILED_AT = new Date("2026-09-17T05:00:00.000Z");

interface LegacyFixture {
  readonly key: number;
  readonly origin: "system" | "random" | "user";
  readonly proposedAt: string;
  readonly game?: GameCode;
  readonly session?: Session;
  readonly drawDate?: string;
  readonly gradePrizeCents?: number;
  readonly purchased?: boolean;
  readonly notificationStatus?: "pending" | "sent";
}

/** Recreate schema-six evidence directly, without bypassing live write validation. */
async function legacyLedger(input: LegacyFixture): Promise<string> {
  const suffix = input.key.toString(16).padStart(32, "0");
  const ledgerId = `ledger-${suffix}`;
  const ticketId = `lt-${suffix}-1`;
  const game = input.game ?? "cash5";
  const drawDate = input.drawDate ?? DRAW_DATE;
  const session = input.session ?? "";
  const main = game === "d4" ? "[1,2,3,4]" : "[1,2,3,4,30]";
  const options = game === "d4" ? '{"stakeCents":100,"fireball":false}' : "{}";
  const statements = [
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_ticket_ledger
         (ledger_id, run_id, origin, game, draw_date, target_session, proposed_at,
          seed, ev_net_cents, ev_assumption, ticket_cost_cents, ticket_count,
          split_risk_model_json, created_at)
       VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, 'legacy-seed', -50,
               'Legacy fixture EV snapshot', 100, 1, '{}', ?6)`
    ).bind(ledgerId, input.origin, game, drawDate, session, input.proposedAt),
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_ledger_tickets
         (ledger_ticket_id, ledger_id, ordinal, main_numbers, play_style, wager_cents,
          ticket_options_json, split_risk_basis_points, split_risk_level, created_at)
       VALUES (?1, ?2, 1, ?3, 'straight', 100, ?4, 0, 'low', ?5)`
    ).bind(ticketId, ledgerId, main, options, input.proposedAt)
  ];
  if (input.purchased) {
    statements.push(
      env.LOTTO_DB.prepare(
        `INSERT INTO lotto_purchase_confirmation_events
           (purchase_event_id, ledger_id, idempotency_key, purchased, spend_cents,
            source, recorded_at, created_at)
         VALUES (?1, ?2, 'legacy-purchase', 1, 100, 'budget-tracker', ?3, ?3)`
      ).bind(`purchase-${suffix}`, ledgerId, input.proposedAt)
    );
  }
  if (input.gradePrizeCents !== undefined) {
    const prizeCents = input.gradePrizeCents;
    const gradeId = `grade-${suffix}`;
    statements.push(
      env.LOTTO_DB.prepare(
        `INSERT INTO lotto_ledger_grades
           (grade_id, ledger_id, revision, draw_fingerprint, result_main_numbers,
            result_session, result_source_id, result_source_sha256, hit_count,
            pending_prize_count, known_prize_cents, rule_version, graded_at)
         VALUES (?1, ?2, 1, ?3, '[1,2,3,4,5]', ?4, 'eligibility-fixture',
                 'fixture-sha256', ?5, 0, ?6, 1, ?7)`
      ).bind(
        gradeId,
        ledgerId,
        `eligibility-${game}-${drawDate}-${session}`,
        session,
        prizeCents > 0 ? 1 : 0,
        prizeCents,
        RECONCILED_AT.toISOString()
      ),
      env.LOTTO_DB.prepare(
        `INSERT INTO lotto_ticket_grades
           (ticket_grade_id, grade_id, ledger_ticket_id, main_matches, bonus_matches,
            prize_tier, hit, payout_status, prize_cents, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9)`
      ).bind(
        `ticket-grade-${suffix}`,
        gradeId,
        ticketId,
        prizeCents > 0 ? 4 : 0,
        prizeCents > 0 ? "4 of 5" : "No prize",
        prizeCents > 0 ? 1 : 0,
        prizeCents > 0 ? "fixed" : "none",
        prizeCents,
        RECONCILED_AT.toISOString()
      )
    );
    if (input.notificationStatus) {
      statements.push(
        env.LOTTO_DB.prepare(
          `INSERT INTO lotto_lab_delivery_outbox
             (delivery_id, grade_id, run_id, game, draw_date, delivery_kind, target_role,
              message_body, status, external_id, next_attempt_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'result', 'primary', 'Legacy result message',
                   ?6, ?7, ?8, ?8, ?8)`
        ).bind(
          `result-grade-${suffix}`,
          gradeId,
          `legacy-${suffix}`,
          game,
          drawDate,
          input.notificationStatus,
          input.notificationStatus === "sent" ? "hermes-original-confirmation" : null,
          RECONCILED_AT.toISOString()
        )
      );
    }
  }
  await env.LOTTO_DB.batch(statements);
  return ledgerId;
}

async function officialResult(
  firstSeenAt: string,
  game: GameCode = "cash5",
  drawDate = DRAW_DATE,
  session: Session = ""
): Promise<void> {
  const main = game === "d4" ? "[1,2,3,4]" : "[1,2,3,4,5]";
  await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare(
      `INSERT OR IGNORE INTO lotto_sources
         (source_id, game, name, url, session, expected_widths, created_at, updated_at)
       VALUES ('eligibility-fixture', ?1, 'Official result fixture',
               'https://www.texaslottery.com/fixture.csv', ?2, '[1]', ?3, ?3)`
    ).bind(game, session, firstSeenAt),
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_draws
         (game, draw_date, session, ordered_numbers, canonical_numbers, bonus_numbers,
          metadata, content_fingerprint, source_id, source_url, source_sha256,
          source_line, raw_record, seen_ingestion_id, active, first_seen_at, updated_at)
       VALUES (?1, ?2, ?3, ?6, ?6, '[]', '{}', ?4,
               'eligibility-fixture', 'https://www.texaslottery.com/fixture.csv',
               'fixture-sha256', 1, 'fixture', 'fixture-ingest', 1, ?5, ?5)`
    ).bind(game, drawDate, session, `eligibility-${game}-${drawDate}-${session}`, firstSeenAt, main)
  ]);
}

async function eventCount(): Promise<number> {
  return Number(
    (
      await env.LOTTO_DB.prepare(
        "SELECT COUNT(*) AS count FROM lotto_ledger_eligibility_events"
      ).first<{ count: number }>()
    )?.count
  );
}

describe("Ticket Lab eligibility evidence", () => {
  it("excludes post-result legacy winnings from every aggregate while preserving graded evidence", async () => {
    const validProposal = "2026-09-16T12:00:00.000Z";
    const lateProposal = "2026-09-17T03:02:00.000Z";
    const excludedIds: string[] = [];
    for (const [offset, origin] of (["system", "random", "user"] as const).entries()) {
      await legacyLedger({
        key: 100 + offset,
        origin,
        proposedAt: validProposal,
        gradePrizeCents: 0,
        purchased: origin === "system"
      });
      excludedIds.push(
        await legacyLedger({
          key: 110 + offset,
          origin,
          proposedAt: lateProposal,
          gradePrizeCents: 35_000,
          purchased: origin !== "random",
          ...(origin === "system" ? { notificationStatus: "sent" as const } : {}),
          ...(origin === "user" ? { notificationStatus: "pending" as const } : {})
        })
      );
    }
    await officialResult("2026-09-17T03:00:00.000Z");
    const beforeEvents = await eventCount();
    const filters = { game: "cash5" as const, from: DRAW_DATE, to: DRAW_DATE };
    const before = await readTrackRecord(env, filters);
    expect(before.totals.proposals.wonCents).toBe(0);
    expect(before.eligibility).toEqual({
      eligibleEntries: 0,
      excludedEntries: 6,
      excludedTickets: 6
    });
    await expect(
      listTicketLabEntries(env, {
        ...filters,
        status: null,
        limit: 100,
        cursor: null
      })
    ).rejects.toThrow(/no eligibility attestation/);
    expect(await eventCount()).toBe(beforeEvents);
    expect(
      (
        await env.LOTTO_DB.prepare(
          "SELECT COUNT(*) AS count FROM lotto_lab_delivery_outbox WHERE run_id LIKE 'ticket-lab-eligibility-%'"
        ).first<{ count: number }>()
      )?.count
    ).toBe(0);

    const first = await reconcileLedgerEligibility(env, "cash5", RECONCILED_AT);
    expect(first).toMatchObject({ excludedEntries: 3, correctionNotifications: 1 });
    const eventsAfter = await eventCount();
    expect(await reconcileLedgerEligibility(env, "cash5", RECONCILED_AT)).toEqual({
      attestedEntries: 0,
      excludedEntries: 0,
      correctionNotifications: 0
    });
    expect(await eventCount()).toBe(eventsAfter);

    const summary = await readTrackRecord(env, filters);
    expect(summary.eligibility).toEqual({
      eligibleEntries: 3,
      excludedEntries: 3,
      excludedTickets: 3
    });
    expect(summary.totals.proposals).toMatchObject({
      entries: 2,
      tickets: 2,
      gradedTickets: 2,
      spentCents: 200,
      wonCents: 0,
      roiPercent: -100,
      longestLosingStreak: 2,
      bestHit: null
    });
    expect(summary.totals.confirmed).toMatchObject({
      spentCents: 100,
      wonCents: 0,
      roiPercent: -100
    });
    expect(summary.prizeTiers).toEqual([]);
    expect(summary.comparisonPolicy.ticketsPerOrigin).toBe(1);
    expect(
      summary.comparisons.map((row) => [
        row.origin,
        row.gradedTickets,
        row.spentCents,
        row.wonCents
      ])
    ).toEqual([
      ["system", 1, 100, 0],
      ["random", 1, 100, 0],
      ["user", 1, 100, 0]
    ]);
    const excluded = await listTicketLabEntries(env, {
      ...filters,
      status: "excluded",
      limit: 100,
      cursor: null
    });
    expect(excluded.entries).toHaveLength(3);
    expect(excluded.entries.map((row) => row.ledgerId)).toEqual(
      expect.arrayContaining(excludedIds)
    );
    for (const entry of excluded.entries) {
      expect(entry).toMatchObject({
        status: "excluded",
        trackRecordEligible: false,
        wonCents: 35_000,
        eligibility: {
          eligible: false,
          reason: expect.stringContaining("already present"),
          evidence: { officialResultFirstSeenAt: "2026-09-17T03:00:00.000Z" }
        },
        tickets: [{ grade: { prizeCents: 35_000 } }]
      });
    }
    const outbox = await env.LOTTO_DB.prepare(
      "SELECT grade_id, status, external_id, priority, message_body FROM lotto_lab_delivery_outbox ORDER BY delivery_id"
    ).all<{
      grade_id: string | null;
      status: string;
      external_id: string | null;
      priority: number;
      message_body: string;
    }>();
    expect(
      outbox.results.find((row) => row.external_id === "hermes-original-confirmation")?.status
    ).toBe("sent");
    expect(
      outbox.results.find((row) => row.grade_id === `grade-${(112).toString(16).padStart(32, "0")}`)
        ?.status
    ).toBe("dead");
    expect(outbox.results.filter((row) => row.grade_id === null)).toEqual([
      expect.objectContaining({
        status: "pending",
        priority: 100,
        message_body: expect.stringContaining("Ticket Lab CORRECTION")
      })
    ]);
    expect(outbox.results.find((row) => row.grade_id === null)?.message_body).toContain(
      "Picks are optimized, not predicted."
    );
    expect(
      (
        await env.LOTTO_DB.prepare("SELECT COUNT(*) AS count FROM lotto_ledger_grades").first<{
          count: number;
        }>()
      )?.count
    ).toBe(6);
  });

  it("excludes an ungraded after-cutoff legacy entry even when result ingestion is delayed", async () => {
    const drawDate = "2026-09-17";
    const ledgerId = await legacyLedger({
      key: 201,
      origin: "system",
      game: "d4",
      drawDate,
      session: "morning",
      proposedAt: "2026-09-17T16:00:00.000Z"
    });
    const filters = { game: "d4" as const, from: drawDate, to: drawDate };
    await expect(
      listTicketLabEntries(env, {
        ...filters,
        status: null,
        limit: 10,
        cursor: null
      })
    ).rejects.toThrow(/no eligibility attestation/);
    // Migration seven gives legacy rows a neutral event; it cannot establish
    // eligibility until the Chicago-time cutoff has been evaluated by the worker.
    await env.LOTTO_DB.prepare(
      `INSERT INTO lotto_ledger_eligibility_events
         (eligibility_event_id, ledger_id, idempotency_key, eligible, reason_code,
          reason, evidence_json, recorded_at, created_at)
       VALUES (?1, ?2, 'schema-v7-initial-attestation', 1, 'schema-v7-attestation',
               'Legacy ledger requires cutoff evaluation', '{}', ?3, ?3)`
    )
      .bind(`eligibility-attest-${ledgerId.slice(7)}`, ledgerId, RECONCILED_AT.toISOString())
      .run();
    const beforeEvents = await eventCount();
    const response = await handleRequest(
      new Request(
        `https://lotto-api.yevow.co/api/lotto/v1/ticket-lab/entries?game=d4&from=${drawDate}&to=${drawDate}&status=excluded`,
        { headers: { Authorization: "Bearer test-service-token" } }
      ),
      env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        entries: [
          { ledgerId, status: "excluded", trackRecordEligible: false, tickets: [{ grade: null }] }
        ]
      }
    });
    expect(await eventCount()).toBe(beforeEvents);
    const neutralSummary = await readTrackRecord(env, filters);
    expect(neutralSummary.eligibility).toEqual({
      eligibleEntries: 0,
      excludedEntries: 1,
      excludedTickets: 1
    });
    expect(neutralSummary.totals.proposals).toMatchObject({
      tickets: 0,
      spentCents: 0,
      gradedTickets: 0,
      roiPercent: null
    });
    expect(await reconcileLedgerEligibility(env, "d4", RECONCILED_AT)).toMatchObject({
      excludedEntries: 1,
      correctionNotifications: 1
    });
    const event = await env.LOTTO_DB.prepare(
      "SELECT eligible, reason_code FROM lotto_ledger_eligibility_events WHERE ledger_id = ?1 ORDER BY event_sequence DESC LIMIT 1"
    )
      .bind(ledgerId)
      .first();
    expect(event).toEqual({ eligible: 0, reason_code: "proposal-not-before-sales-cutoff" });
    await officialResult("2026-09-17T16:10:00.000Z", "d4", drawDate, "morning");
    expect(await gradeAvailableLedgerEntries(env, "d4", RECONCILED_AT)).toEqual({
      gradedEntries: 0,
      gradedTickets: 0
    });
    expect(
      (await listTicketLabEntries(env, { ...filters, status: "open", limit: 10, cursor: null }))
        .entries
    ).toEqual([]);
  });

  it("requires service authorization and makes append-only eligibility decisions idempotent", async () => {
    const entry = await appendLedgerEntry(
      env,
      {
        origin: "user",
        game: "cash5",
        drawDate: "2026-09-18",
        idempotencyKey: "eligibility-service-fixture",
        tickets: [{ main: [1, 2, 3, 4, 5] }]
      },
      new Date("2026-09-18T12:00:00.000Z")
    );
    const payload = {
      eligible: false,
      idempotencyKey: "service-exclusion-1",
      reason: "Source integrity investigation",
      evidence: { audit: "case-1", check: "reviewed" }
    };
    const send = (body: unknown, bearer?: string) =>
      handleRequest(
        new Request(
          `https://lotto-api.yevow.co/api/lotto/v1/ticket-lab/entries/${entry.ledgerId}/eligibility-events`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
            },
            body: JSON.stringify(body)
          }
        ),
        env
      );
    expect((await send(payload)).status).toBe(401);
    expect((await send(payload, "yevow-dashboard-session")).status).toBe(401);
    const first = await send(payload, "test-service-token");
    expect(first.status).toBe(201);
    const document = (await first.json()) as {
      data: { eventId: string; created: boolean; eligible: boolean };
    };
    expect(document.data).toMatchObject({ created: true, eligible: false });
    const repeated = await send(
      { ...payload, evidence: { check: "reviewed", audit: "case-1" } },
      "test-service-token"
    );
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({
      data: { ...document.data, created: false }
    });
    const conflict = await send({ ...payload, reason: "Different decision" }, "test-service-token");
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" }
    });
    for (const statement of [
      "UPDATE lotto_ledger_eligibility_events SET eligible = 1 WHERE eligibility_event_id = ?1",
      "DELETE FROM lotto_ledger_eligibility_events WHERE eligibility_event_id = ?1"
    ]) {
      await expect(
        env.LOTTO_DB.prepare(statement).bind(document.data.eventId).run()
      ).rejects.toThrow(/append-only/);
    }
    await appendLedgerEligibilityEvent(
      env,
      entry.ledgerId,
      {
        eligible: true,
        idempotencyKey: "service-reinstatement-2",
        reason: "Investigation resolved with preserved original evidence",
        evidence: { audit: "case-1" }
      },
      new Date("2000-01-01T00:00:00.000Z")
    );
    expect(
      (
        await listTicketLabEntries(env, {
          game: "cash5",
          from: "2026-09-18",
          to: "2026-09-18",
          status: "open",
          limit: 10,
          cursor: null
        })
      ).entries[0]
    ).toMatchObject({ ledgerId: entry.ledgerId, trackRecordEligible: true, status: "open" });
  });

  it("refuses reinstatement that contradicts an observed result or official sales cutoff", async () => {
    const resultViolation = await legacyLedger({
      key: 301,
      origin: "user",
      drawDate: "2026-09-19",
      proposedAt: "2026-09-19T12:00:00.000Z"
    });
    await officialResult("2026-09-19T11:00:00.000Z", "cash5", "2026-09-19");
    const cutoffViolation = await legacyLedger({
      key: 302,
      origin: "user",
      game: "d4",
      session: "morning",
      drawDate: "2026-09-18",
      proposedAt: "2026-09-18T16:00:00.000Z"
    });
    for (const [ledgerId, expected] of [
      [resultViolation, /already present/],
      [cutoffViolation, /sales cutoff/]
    ] as const) {
      const response = await handleRequest(
        new Request(
          `https://lotto-api.yevow.co/api/lotto/v1/ticket-lab/entries/${ledgerId}/eligibility-events`,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer test-service-token",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              eligible: true,
              idempotencyKey: "invalid-reinstatement",
              reason: "Operator requests inclusion",
              evidence: {}
            })
          }
        ),
        env
      );
      expect(response.status).toBe(400);
      const document = (await response.json()) as { error: { code: string; message: string } };
      expect(document.error.code).toBe("invalid_eligibility_event");
      expect(document.error.message).toMatch(expected);
    }
  });

  it("does not overwrite a concurrent manual exclusion with a stale cutoff attestation", async () => {
    const ledgerId = await legacyLedger({
      key: 401,
      origin: "user",
      drawDate: "2026-09-21",
      proposedAt: "2026-09-21T12:00:00.000Z"
    });
    let cutoffPrepared = false;
    let injected = false;
    const database = new Proxy(env.LOTTO_DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string): D1PreparedStatement => {
            if (sql.includes("'schema-v7-cutoff-evaluation-v1'")) cutoffPrepared = true;
            return target.prepare(sql);
          };
        }
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
            if (cutoffPrepared && !injected) {
              injected = true;
              await appendLedgerEligibilityEvent(env, ledgerId, {
                eligible: false,
                idempotencyKey: "concurrent-manual-exclusion",
                reason: "Concurrent integrity exclusion takes precedence",
                evidence: { case: "concurrent-evidence" }
              });
            }
            return target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    await reconcileLedgerEligibility({ ...env, LOTTO_DB: database }, "cash5", RECONCILED_AT);
    expect(injected).toBe(true);
    expect(
      await env.LOTTO_DB.prepare(
        "SELECT eligible, reason_code FROM lotto_ledger_eligibility_events WHERE ledger_id = ?1 ORDER BY event_sequence DESC LIMIT 1"
      )
        .bind(ledgerId)
        .first()
    ).toEqual({ eligible: 0, reason_code: "manual-integrity-exclusion" });
    expect(
      (
        await env.LOTTO_DB.prepare(
          "SELECT COUNT(*) AS count FROM lotto_ledger_eligibility_events WHERE ledger_id = ?1 AND idempotency_key = 'schema-v7-cutoff-evaluation-v1'"
        )
          .bind(ledgerId)
          .first<{ count: number }>()
      )?.count
    ).toBe(0);
    expect(
      (
        await readTrackRecord(env, {
          game: "cash5",
          from: "2026-09-21",
          to: "2026-09-21"
        })
      ).eligibility
    ).toEqual({ eligibleEntries: 0, excludedEntries: 1, excludedTickets: 1 });
  });
});
