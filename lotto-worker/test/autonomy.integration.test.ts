import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateForGame,
  generationRunById,
  listGeneratedRuns,
  PICKS_DISCLAIMER,
  readServiceStatus,
  runScheduledGeneration
} from "../src/autonomy";
import { claimDelivery, completeDelivery } from "../src/delivery";
import { handleRequest } from "../src/api";
import { GAME_MANIFEST, getSource } from "../src/manifest";
import { network } from "./network";

const SOURCE = getSource("cash5:cashfive");
const LOTTO_SOURCE = getSource("lotto:lottotexas");
const POWERBALL_SOURCE = getSource("pb:powerball");
const CASH_EXPORT = [
  "Cash Five,9,1,2026,1,9,17,25,33",
  "Cash Five,9,2,2026,2,10,18,26,34",
  "Cash Five,9,3,2026,3,11,19,27,35"
].join("\n");

async function clearR2(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.LOTTO_RAW.list({ cursor });
    if (page.objects.length) await env.LOTTO_RAW.delete(page.objects.map(({ key }) => key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

beforeEach(async () => {
  await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare("DELETE FROM lotto_delivery_attempts"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_delivery_outbox"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_generated_tickets"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_generation_runs"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_generation_leases"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_daily_summaries"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_quarantine"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_draws"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_ingestions"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_sources"),
    env.LOTTO_DB.prepare("UPDATE lotto_game_config SET play_style = 'straight'"),
    env.LOTTO_DB.prepare("UPDATE schema_meta SET value = '5' WHERE key = 'schema_version'")
  ]);
  await clearR2();
});

function serve(body: string): () => number {
  let calls = 0;
  network.use(
    http.get(SOURCE.url, () => {
      calls += 1;
      return HttpResponse.text(body, { headers: { "Content-Type": "text/csv" } });
    })
  );
  return () => calls;
}

describe("autonomous generation and delivery", () => {
  it("publishes one deterministic run and delivery per game/date", async () => {
    const calls = serve(`${CASH_EXPORT}\n`);
    const now = new Date("2026-09-03T12:00:00Z");

    const first = await generateForGame(env, "cash5", now);
    expect(first.kind).toBe("generated");
    if (first.kind !== "generated") throw new Error("expected a generated run");
    expect(first.run).toMatchObject({
      game: "cash5",
      drawDate: "2026-09-03",
      drawSlot: "daily",
      observedThrough: "2026-09-03",
      disclaimer: PICKS_DISCLAIMER
    });
    expect(first.run.tickets).toHaveLength(4);
    expect(first.run.coverage.distinctPairs).toBeGreaterThan(0);
    expect(first.run.ev.assumption).toContain("Pre-tax liability-cap model");
    expect(first.run.ev.assumption).toContain("0 estimated plays");
    expect(calls()).toBe(1);

    const repeated = await generateForGame(env, "cash5", now);
    expect(repeated.kind).toBe("reused");
    if (repeated.kind !== "reused") throw new Error("expected an existing run");
    expect(repeated.run).toEqual(first.run);
    expect(calls()).toBe(1);

    const counts = await env.LOTTO_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM lotto_generation_runs) AS runs,
         (SELECT COUNT(*) FROM lotto_generated_tickets) AS tickets,
         (SELECT COUNT(*) FROM lotto_delivery_outbox) AS deliveries`
    ).first<{ runs: number; tickets: number; deliveries: number }>();
    expect(counts).toEqual({ runs: 1, tickets: 4, deliveries: 1 });
    expect(await listGeneratedRuns(env, "2026-09-03")).toEqual([first.run]);
    expect(await generationRunById(env, first.run.runId)).toEqual(first.run);

    const response = await handleRequest(
      new Request(`https://lotto-api.yevow.co/api/lotto/v1/generation-runs/${first.run.runId}`, {
        headers: { Authorization: "Bearer test-service-token" }
      }),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const document = (await response.json()) as {
      data: { run: { generationLogUrl: string; tickets: readonly unknown[] } };
    };
    expect(document.data.run.generationLogUrl).toBe(
      `https://lotto-api.yevow.co/api/lotto/v1/generation-runs/${first.run.runId}`
    );
    expect(document.data.run.tickets).toHaveLength(4);
  });

  it("claims once, logs the receipt, and never offers a sent delivery again", async () => {
    serve(`${CASH_EXPORT}\n`);
    const generated = await generateForGame(env, "cash5", new Date("2026-09-03T12:00:00Z"));
    expect(generated.kind).toBe("generated");

    const deliveryNow = new Date(Date.now() + 60_000);
    const claim = await claimDelivery(env, deliveryNow);
    expect(claim).toMatchObject({ game: "cash5", drawDate: "2026-09-03", priorAttempts: 0 });
    expect(claim?.message).toContain("Optimized, not predicted");
    if (!claim) throw new Error("expected a delivery claim");
    const completed = await completeDelivery(
      env,
      claim.deliveryId,
      {
        leaseToken: claim.leaseToken,
        status: "sent",
        attempts: 1,
        externalId: "mock-42",
        alertStatus: "sent",
        alertExternalId: "alert-42"
      },
      new Date(deliveryNow.getTime() + 2_000)
    );
    expect(completed).toMatchObject({ status: "sent", attempts: 1 });
    const repeatedAck = await completeDelivery(
      env,
      claim.deliveryId,
      {
        leaseToken: claim.leaseToken,
        status: "sent",
        attempts: 1,
        externalId: "mock-42",
        alertStatus: "sent",
        alertExternalId: "alert-42"
      },
      new Date(deliveryNow.getTime() + 3_000)
    );
    expect(repeatedAck).toEqual(completed);
    expect(await claimDelivery(env, new Date(deliveryNow.getTime() + 60_000))).toBeNull();
    const attempts = await env.LOTTO_DB.prepare(
      `SELECT result, local_attempts, external_id, alert_status, alert_external_id
       FROM lotto_delivery_attempts`
    ).all<{
      result: string;
      local_attempts: number;
      external_id: string;
      alert_status: string;
      alert_external_id: string;
    }>();
    expect(attempts.results).toEqual([
      {
        result: "sent",
        local_attempts: 1,
        external_id: "mock-42",
        alert_status: "sent",
        alert_external_id: "alert-42"
      }
    ]);
  });

  it("dead-letters a non-retryable bridge preflight rejection", async () => {
    serve(`${CASH_EXPORT}\n`);
    await generateForGame(env, "cash5", new Date("2026-09-03T12:00:00Z"));
    const deliveryNow = new Date(Date.now() + 60_000);
    const claim = await claimDelivery(env, deliveryNow);
    if (!claim) throw new Error("expected a delivery claim");

    const completed = await completeDelivery(
      env,
      claim.deliveryId,
      {
        leaseToken: claim.leaseToken,
        status: "failed",
        attempts: 0,
        error: "payload failed the optimized-not-predicted policy check",
        alertStatus: "sent",
        alertExternalId: "alert-preflight"
      },
      new Date(deliveryNow.getTime() + 1_000)
    );

    expect(completed).toMatchObject({ status: "dead", attempts: 0 });
    expect(await claimDelivery(env, new Date(deliveryNow.getTime() + 24 * 60 * 60_000))).toBeNull();
  });

  it("records terminal generation failure and queues one fallback alert", async () => {
    serve("<!doctype html><title>maintenance</title>");
    const now = new Date("2026-09-03T12:00:00Z");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const outcome = await generateForGame(
        env,
        "cash5",
        new Date(now.getTime() + attempt * 60_000)
      );
      expect(outcome).toMatchObject({ kind: "failed", attempts: attempt, terminal: attempt === 3 });
    }
    const rows = await env.LOTTO_DB.prepare(
      "SELECT delivery_kind, target_role, status, message_body FROM lotto_delivery_outbox"
    ).all<{ delivery_kind: string; target_role: string; status: string; message_body: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      delivery_kind: "alert",
      target_role: "fallback",
      status: "pending",
      message_body: expect.stringContaining("generation failed for Cash Five")
    });
  });

  it("recovers from a transient failure with one stable run and protected seed", async () => {
    let body = "<!doctype html><title>maintenance</title>";
    network.use(
      http.get(SOURCE.url, () =>
        HttpResponse.text(body, { headers: { "Content-Type": "text/csv" } })
      )
    );
    const first = await generateForGame(env, "cash5", new Date("2026-09-03T12:00:00Z"));
    expect(first).toMatchObject({ kind: "failed", attempts: 1, terminal: false });

    body = `${CASH_EXPORT}\n`;
    const recovered = await generateForGame(env, "cash5", new Date("2026-09-03T12:02:00Z"));
    expect(recovered.kind).toBe("generated");
    if (recovered.kind !== "generated") throw new Error("expected recovery");
    expect(recovered.run.seed).toMatch(/^[a-f0-9]{64}$/);

    const counts = await env.LOTTO_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM lotto_generation_runs) AS runs,
         (SELECT COUNT(*) FROM lotto_generated_tickets) AS tickets,
         (SELECT COUNT(*) FROM lotto_delivery_outbox WHERE delivery_kind = 'picks') AS picks,
         (SELECT COUNT(*) FROM lotto_delivery_outbox WHERE delivery_kind = 'alert') AS alerts`
    ).first<{ runs: number; tickets: number; picks: number; alerts: number }>();
    expect(counts).toEqual({ runs: 1, tickets: 4, picks: 1, alerts: 0 });
  });

  it("refuses to publish from a stale archive even when the download validates", async () => {
    serve("Cash Five,8,1,2026,1,9,17,25,33\n");
    const outcome = await generateForGame(env, "cash5", new Date("2026-09-03T12:00:00Z"));

    expect(outcome).toMatchObject({ kind: "failed", attempts: 1, terminal: false });
    if (outcome.kind !== "failed") throw new Error("expected stale generation failure");
    expect(outcome.error).toContain("source freshness check failed");
    const published = await env.LOTTO_DB.prepare(
      "SELECT COUNT(*) AS count FROM lotto_generated_tickets"
    ).first<{ count: number }>();
    expect(published?.count).toBe(0);
  });

  it("requires the intervening official Saturday Lotto draw on Monday", async () => {
    network.use(
      http.get(LOTTO_SOURCE.url, () =>
        HttpResponse.text("Lotto Texas,8,29,2026,5,18,32,41,49,54\n", {
          headers: { "Content-Type": "text/csv" }
        })
      )
    );

    const outcome = await generateForGame(env, "lotto", new Date("2026-08-31T12:00:00Z"));

    expect(outcome.kind).toBe("generated");
    if (outcome.kind !== "generated") throw new Error("expected normal Monday generation");
    expect(outcome.run.observedThrough).toBe("2026-08-29");
  });

  it("requires the intervening official Monday Powerball draw on Wednesday", async () => {
    network.use(
      http.get(POWERBALL_SOURCE.url, () =>
        HttpResponse.text("Powerball,8,31,2026,1,2,3,4,69,26,2\n", {
          headers: { "Content-Type": "text/csv" }
        })
      )
    );

    const outcome = await generateForGame(env, "pb", new Date("2026-09-02T12:00:00Z"));

    expect(outcome.kind).toBe("generated");
    if (outcome.kind !== "generated") throw new Error("expected Wednesday generation");
    expect(outcome.run.observedThrough).toBe("2026-08-31");
  });

  it("rejects a same-age archive that missed intervening scheduled draws", async () => {
    serve("Cash Five,8,31,2026,1,9,17,25,33\n");

    const outcome = await generateForGame(env, "cash5", new Date("2026-09-03T12:00:00Z"));

    expect(outcome).toMatchObject({ kind: "failed", attempts: 1 });
    if (outcome.kind !== "failed") throw new Error("expected missed-draw freshness failure");
    expect(outcome.error).toContain("expected at least 2026-09-02");
  });

  it("labels digit play style and due-digit warning in the persisted message", async () => {
    for (const source of GAME_MANIFEST.p3.sources) {
      const session = source.session.charAt(0).toUpperCase() + source.session.slice(1);
      network.use(
        http.get(source.url, () =>
          HttpResponse.text(`Pick 3 ${session},9,2,2026,1,2,3,,4\n`, {
            headers: { "Content-Type": "text/csv" }
          })
        )
      );
    }

    const outcome = await generateForGame(env, "p3", new Date("2026-09-03T12:00:00Z"));

    expect(outcome.kind).toBe("generated");
    const message = await env.LOTTO_DB.prepare(
      "SELECT message_body FROM lotto_generation_runs WHERE game = 'p3'"
    ).first<{ message_body: string }>();
    expect(message?.message_body).toContain("straight play");
    expect(message?.message_body).toContain("exact/box choice changes EV; no digit is due");
  });

  it("rejects autonomous digit styles whose EV varies with digit multiplicity", async () => {
    await env.LOTTO_DB.prepare(
      "UPDATE lotto_game_config SET play_style = 'box' WHERE game = 'p3'"
    ).run();

    await expect(generateForGame(env, "p3", new Date("2026-09-03T12:00:00Z"))).rejects.toThrow(
      /must be straight/
    );
  });

  it("queues one missed-deadline alert when a run crosses 09:00 CT", async () => {
    serve(`${CASH_EXPORT}\n`);
    const late = await generateForGame(
      env,
      "cash5",
      new Date("2026-09-03T13:50:00Z"),
      "/api/lotto/v1",
      () => new Date("2026-09-03T14:05:00Z")
    );

    expect(late.kind).toBe("generated");
    const deliveries = await env.LOTTO_DB.prepare(
      `SELECT delivery_kind, target_role, message_body
       FROM lotto_delivery_outbox ORDER BY delivery_kind`
    ).all<{ delivery_kind: string; target_role: string; message_body: string }>();
    expect(deliveries.results).toHaveLength(2);
    expect(deliveries.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ delivery_kind: "picks", target_role: "primary" }),
        expect.objectContaining({
          delivery_kind: "alert",
          target_role: "fallback",
          message_body: expect.stringContaining("completed after 09:00 CT")
        })
      ])
    );
  });

  it("replaces an unsent missed-deadline failure alert after recovery", async () => {
    let body = "<!doctype html><title>maintenance</title>";
    network.use(
      http.get(SOURCE.url, () =>
        HttpResponse.text(body, { headers: { "Content-Type": "text/csv" } })
      )
    );
    const failedAt = new Date("2026-09-03T14:01:00Z");
    const failed = await generateForGame(env, "cash5", failedAt, "/api/lotto/v1", () => failedAt);
    expect(failed).toMatchObject({ kind: "failed", attempts: 1 });

    body = `${CASH_EXPORT}\n`;
    const recoveredAt = new Date("2026-09-03T14:03:00Z");
    const recovered = await generateForGame(
      env,
      "cash5",
      recoveredAt,
      "/api/lotto/v1",
      () => recoveredAt
    );
    expect(recovered.kind).toBe("generated");

    const alert = await env.LOTTO_DB.prepare(
      "SELECT status, message_body FROM lotto_delivery_outbox WHERE delivery_kind = 'alert'"
    ).first<{ status: string; message_body: string }>();
    expect(alert).toMatchObject({
      status: "pending",
      message_body: expect.stringContaining("completed after 09:00 CT")
    });
    expect(alert?.message_body).not.toContain("automatic retries continue");
  });

  it("requeues a failed delivery and quarantines an ambiguous result", async () => {
    serve(`${CASH_EXPORT}\n`);
    await generateForGame(env, "cash5", new Date("2026-09-03T12:00:00Z"));
    const deliveryNow = new Date(Date.now() + 60_000);
    const first = await claimDelivery(env, deliveryNow);
    if (!first) throw new Error("expected first delivery claim");
    const failed = await completeDelivery(
      env,
      first.deliveryId,
      {
        leaseToken: first.leaseToken,
        status: "failed",
        attempts: 4,
        error: "mock transport down",
        alertStatus: "sent",
        alertExternalId: "alert-first"
      },
      new Date(deliveryNow.getTime() + 5_000)
    );
    expect(failed).toMatchObject({ status: "retry", attempts: 4 });
    expect(await claimDelivery(env, new Date(deliveryNow.getTime() + 20 * 60_000))).toBeNull();

    const second = await claimDelivery(env, new Date(deliveryNow.getTime() + 32 * 60_000));
    if (!second) throw new Error("expected retry claim");
    const ambiguous = await completeDelivery(
      env,
      second.deliveryId,
      {
        leaseToken: second.leaseToken,
        status: "ambiguous",
        attempts: 1,
        error: "process ended during provider call",
        alertStatus: "sent",
        alertExternalId: "alert-second"
      },
      new Date(deliveryNow.getTime() + 32 * 60_000 + 1_000)
    );
    expect(ambiguous).toMatchObject({ status: "ambiguous", attempts: 5 });
    expect(await claimDelivery(env, new Date(deliveryNow.getTime() + 24 * 60 * 60_000))).toBeNull();
    const summary = await env.LOTTO_DB.prepare(
      "SELECT summary_json FROM lotto_daily_summaries WHERE service_date = '2026-09-03'"
    ).first<{ summary_json: string }>();
    expect(JSON.parse(summary?.summary_json ?? "{}")).toMatchObject({
      pendingDeliveries: 0,
      sentDeliveries: 0,
      failedDeliveries: 1,
      alertDeliveries: 1,
      sentAlerts: 1,
      failedAlerts: 0
    });
  });

  it("reports missing and stale official archives as non-null degraded ingest state", async () => {
    const now = new Date("2026-09-03T13:00:00Z");
    const missing = await readServiceStatus(env, now);
    expect(missing.games.find((game) => game.game === "cash5")?.lastIngest).toEqual({
      at: null,
      observedThrough: null,
      readySources: 0,
      sourceCount: 1,
      activeDraws: 0,
      status: "degraded"
    });

    await env.LOTTO_DB.prepare(
      `INSERT INTO lotto_sources
         (source_id, game, name, url, session, expected_widths, last_digest, active_count,
          last_status, last_success_at, latest_draw_date)
       VALUES (?1, 'cash5', ?2, ?3, '', '[9]', 'stale-digest', 10,
               'complete', ?4, '2026-08-31')`
    )
      .bind(SOURCE.id, SOURCE.name, SOURCE.url, now.toISOString())
      .run();

    const stale = await readServiceStatus(env, now);
    expect(stale.games.find((game) => game.game === "cash5")?.lastIngest).toMatchObject({
      observedThrough: "2026-08-31",
      readySources: 1,
      sourceCount: 1,
      status: "degraded"
    });
  });

  it("uses the official Saturday Lotto cadence when assessing Monday freshness", async () => {
    const now = new Date("2026-08-31T13:00:00Z");
    await env.LOTTO_DB.prepare(
      `INSERT INTO lotto_sources
         (source_id, game, name, url, session, expected_widths, last_digest, active_count,
          last_status, last_success_at, latest_draw_date)
       VALUES (?1, 'lotto', ?2, ?3, '', '[10]', 'lotto-digest', 10,
               'complete', ?4, '2026-08-26')`
    )
      .bind(LOTTO_SOURCE.id, LOTTO_SOURCE.name, LOTTO_SOURCE.url, now.toISOString())
      .run();

    const stale = await readServiceStatus(env, now);
    expect(stale.games.find((game) => game.game === "lotto")?.lastIngest.status).toBe("degraded");

    await env.LOTTO_DB.prepare(
      "UPDATE lotto_sources SET latest_draw_date = '2026-08-29' WHERE source_id = ?1"
    )
      .bind(LOTTO_SOURCE.id)
      .run();
    const fresh = await readServiceStatus(env, now);
    expect(fresh.games.find((game) => game.game === "lotto")?.lastIngest).toMatchObject({
      observedThrough: "2026-08-29",
      status: "ready"
    });
  });

  it("surfaces delivery, unresolved-alert, quarantine, and current error state per game", async () => {
    serve(`${CASH_EXPORT}\n`);
    const now = new Date("2026-09-03T12:00:00Z");
    const generated = await generateForGame(env, "cash5", now);
    expect(generated.kind).toBe("generated");

    await env.LOTTO_DB.prepare(
      `UPDATE lotto_delivery_outbox
       SET status = 'ambiguous', last_error = 'provider confirmation was ambiguous',
           alert_status = 'failed', alert_error = 'fallback transport failed'
       WHERE delivery_kind = 'picks'`
    ).run();
    await env.LOTTO_DB.prepare(
      `INSERT INTO lotto_quarantine
         (ingestion_id, source_id, game, source_line, raw_record, reason, created_at)
       SELECT ingestion_id, source_id, game, 99, 'bad fixture', 'fixture malformed', ?1
       FROM lotto_ingestions WHERE game = 'cash5' ORDER BY started_at DESC LIMIT 1`
    )
      .bind(now.toISOString())
      .run();

    const status = await readServiceStatus(env, now);
    expect(status.games.find((game) => game.game === "cash5")).toMatchObject({
      pendingDeliveries: 0,
      failedDeliveries: 1,
      unresolvedAlerts: 1,
      quarantinedRecords: 1,
      lastError: "provider confirmation was ambiguous",
      attentionRequired: true
    });

    const nextServiceDay = await readServiceStatus(env, new Date("2026-09-04T12:00:00Z"));
    expect(nextServiceDay.games.find((game) => game.game === "cash5")?.quarantinedRecords).toBe(0);
  });

  it("keeps invalid disabled configuration visible without breaking service status", async () => {
    await env.LOTTO_DB.prepare(
      "UPDATE lotto_game_config SET selected = 0, play_style = 'box' WHERE game = 'p3'"
    ).run();

    const status = await readServiceStatus(env, new Date("2026-09-06T17:00:00Z"));
    expect(status.games.find((game) => game.game === "p3")).toMatchObject({
      selected: false,
      configurationValid: false,
      configurationError: expect.stringContaining("must be straight"),
      generationDue: false,
      generationMissed: false
    });
  });

  it("records and alerts a malformed selected configuration without aborting the scheduler", async () => {
    await env.LOTTO_DB.prepare("UPDATE lotto_game_config SET selected = 0").run();
    await env.LOTTO_DB.prepare(
      "UPDATE lotto_game_config SET selected = 1, play_style = 'box' WHERE game = 'p3'"
    ).run();
    const now = new Date("2026-09-03T15:00:00Z");

    const outcome = await runScheduledGeneration(env, now);

    expect(outcome).toMatchObject({
      kind: "failed",
      game: "p3",
      drawDate: "2026-09-03",
      attempts: 1,
      error: expect.stringContaining("configuration is invalid")
    });
    const run = await env.LOTTO_DB.prepare(
      "SELECT status, seed, error FROM lotto_generation_runs WHERE game = 'p3'"
    ).first<{ status: string; seed: string; error: string }>();
    expect(run).toMatchObject({
      status: "failed",
      seed: "unavailable",
      error: expect.stringContaining("must be straight")
    });
    const alert = await env.LOTTO_DB.prepare(
      "SELECT delivery_kind, target_role, status FROM lotto_delivery_outbox"
    ).first<{ delivery_kind: string; target_role: string; status: string }>();
    expect(alert).toEqual({ delivery_kind: "alert", target_role: "fallback", status: "pending" });
  });

  it("marks a selected due game missing after the 09:00 CT SLA in status and health", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T15:00:00Z"));
    try {
      await env.LOTTO_DB.prepare("UPDATE lotto_game_config SET selected = 0").run();
      await env.LOTTO_DB.prepare(
        "UPDATE lotto_game_config SET selected = 1 WHERE game = 'cash5'"
      ).run();
      await env.LOTTO_DB.prepare(
        `INSERT INTO lotto_sources
           (source_id, game, name, url, session, expected_widths, last_digest, active_count,
            last_status, last_success_at, latest_draw_date)
         VALUES (?1, 'cash5', ?2, ?3, '', '[9]', 'ready-digest', 10,
                 'complete', ?4, '2026-09-02')`
      )
        .bind(SOURCE.id, SOURCE.name, SOURCE.url, new Date().toISOString())
        .run();

      const service = await readServiceStatus(env, new Date());
      expect(service.missedGenerationGames).toEqual(["cash5"]);
      expect(service.games.find((game) => game.game === "cash5")).toMatchObject({
        generationDue: true,
        generationMissed: true,
        attentionRequired: true,
        lastError: expect.stringContaining("no generated picks")
      });

      const response = await handleRequest(new Request("https://lotto-api.yevow.co/healthz"), env);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        data: {
          status: "degraded",
          missedGenerationGames: ["cash5"],
          attentionRequiredGames: ["cash5"]
        }
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
