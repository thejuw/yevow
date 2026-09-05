import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { claimDelivery, completeDelivery } from "../src/delivery";
import type { Env } from "../src/env";
import { appendLedgerEntry } from "../src/ticket-lab";

const CLAIM_AT = new Date("2026-09-09T03:00:00Z");
const CREATED_AT = "2026-09-09T02:00:00Z";

async function seedResult(key: string, status: "pending" | "leased" = "pending") {
  const entry = await appendLedgerEntry(
    env,
    {
      origin: "user",
      game: "cash5",
      drawDate: "2026-09-08",
      idempotencyKey: key,
      tickets: [{ main: [1, 2, 3, 4, 5] }]
    },
    new Date("2026-09-08T12:00:00Z")
  );
  const gradeId = `grade-${entry.ledgerId.slice(7)}`;
  const deliveryId = `result-${gradeId}`;
  await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_ledger_grades
         (grade_id, ledger_id, revision, draw_fingerprint, result_main_numbers,
          result_session, result_source_id, result_source_sha256, hit_count,
          pending_prize_count, known_prize_cents, rule_version, graded_at)
       VALUES (?1, ?2, 1, ?3, '[10,11,12,13,14]', '', 'fixture', 'fixture-sha',
               0, 0, 0, 1, ?4)`
    ).bind(gradeId, entry.ledgerId, `fingerprint-${key}`, CREATED_AT),
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_lab_delivery_outbox
         (delivery_id, grade_id, run_id, game, draw_date, delivery_kind, target_role,
          priority, message_body, status, next_attempt_at, lease_token, lease_expires_at,
          created_at, updated_at)
       VALUES (?1, ?2, ?3, 'cash5', '2026-09-08', 'result', 'primary', 100,
               'Fixture result', ?4, ?5, ?6, ?7, ?5, ?5)`
    ).bind(
      deliveryId,
      gradeId,
      entry.ledgerId,
      status,
      CREATED_AT,
      status === "leased" ? "11111111-1111-4111-8111-111111111111" : null,
      status === "leased" ? "2026-09-09T02:30:00Z" : null
    )
  ]);
  return { ledgerId: entry.ledgerId, deliveryId };
}

async function appendDecision(ledgerId: string, eligible: boolean, neutral = false): Promise<void> {
  await env.LOTTO_DB.prepare(
    `INSERT INTO lotto_ledger_eligibility_events
       (eligibility_event_id, ledger_id, idempotency_key, eligible, reason_code,
        reason, evidence_json, recorded_at, created_at)
     VALUES (?1, ?2, 'delivery-test-decision', ?3, ?4, 'Delivery test evidence', '{}', ?5, ?5)`
  )
    .bind(
      `eligibility-delivery-test-${ledgerId.slice(7)}`,
      ledgerId,
      eligible ? 1 : 0,
      neutral ? "schema-v7-attestation" : "manual-integrity-exclusion",
      CREATED_AT
    )
    .run();
}

describe("Ticket Lab eligibility at delivery claim", () => {
  it("does not reclaim an excluded expired lease and still delivers its correction", async () => {
    const excluded = await seedResult("delivery-excluded-expired", "leased");
    await appendDecision(excluded.ledgerId, false);
    const correctionId = `result-grade-${"c".repeat(32)}`;
    await env.LOTTO_DB.prepare(
      `INSERT INTO lotto_lab_delivery_outbox
         (delivery_id, grade_id, run_id, game, draw_date, delivery_kind, target_role,
          priority, message_body, status, next_attempt_at, created_at, updated_at)
       VALUES (?1, NULL, 'eligibility-correction-fixture', 'cash5', '2026-09-08',
               'result', 'primary', 100, 'Fixture correction', 'pending', ?2, ?2, ?2)`
    )
      .bind(correctionId, CREATED_AT)
      .run();

    const claim = await claimDelivery(env, CLAIM_AT);
    expect(claim).toMatchObject({ deliveryId: correctionId, message: "Fixture correction" });
    if (!claim) throw new Error("Correction was not claimable");
    await completeDelivery(
      env,
      correctionId,
      { leaseToken: claim.leaseToken, status: "sent", attempts: 1, externalId: "fixture-sms" },
      CLAIM_AT
    );
    expect(await claimDelivery(env, CLAIM_AT)).toBeNull();
    expect(
      await env.LOTTO_DB.prepare(
        "SELECT status, lease_token, external_id FROM lotto_lab_delivery_outbox WHERE delivery_id = ?1"
      )
        .bind(excluded.deliveryId)
        .first()
    ).toEqual({
      status: "leased",
      lease_token: "11111111-1111-4111-8111-111111111111",
      external_id: null
    });
  });

  it("does not deliver a result with an unresolved migration attestation", async () => {
    const unresolved = await seedResult("delivery-neutral-attestation");
    await appendDecision(unresolved.ledgerId, true, true);
    expect(await claimDelivery(env, CLAIM_AT)).toBeNull();
  });

  it("rechecks eligibility atomically when exclusion arrives after candidate selection", async () => {
    const candidate = await seedResult("delivery-claim-concurrent-exclusion");
    let excludedBeforeUpdate = false;
    const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind") {
            return (...values: unknown[]) => wrapStatement(target.bind(...values));
          }
          if (property === "run") {
            return async () => {
              if (!excludedBeforeUpdate) {
                excludedBeforeUpdate = true;
                await appendDecision(candidate.ledgerId, false);
              }
              return target.run();
            };
          }
          const member: unknown = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        }
      });
    const racingEnv: Env = {
      ...env,
      LOTTO_DB: new Proxy(env.LOTTO_DB, {
        get(target, property) {
          if (property === "prepare") {
            return (query: string) => {
              const statement = target.prepare(query);
              return query.includes("UPDATE lotto_lab_delivery_outbox")
                ? wrapStatement(statement)
                : statement;
            };
          }
          const member: unknown = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        }
      })
    };

    expect(await claimDelivery(racingEnv, CLAIM_AT)).toBeNull();
    expect(excludedBeforeUpdate).toBe(true);
    expect(
      await env.LOTTO_DB.prepare(
        "SELECT status, lease_token FROM lotto_lab_delivery_outbox WHERE delivery_id = ?1"
      )
        .bind(candidate.deliveryId)
        .first()
    ).toEqual({ status: "pending", lease_token: null });
  });
});
