import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleRequest } from "../src/api";
import worker from "../src/index";
import { refreshSource } from "../src/ingest";
import { GAME_MANIFEST, SOURCES, getSource, type ExportSource } from "../src/manifest";
import { network } from "./network";

const CASH_SOURCE = getSource("cash5:cashfive");

const CASH_THREE_ROWS = [
  "Cash Five,8,31,2026,1,2,3,4,5",
  "Cash Five,9,1,2026,6,7,8,9,10",
  "Cash Five,9,2,2026,11,12,13,14,15"
].join("\n");

const CASH_SEVEN_ROWS = [
  "Cash Five,8,26,2026,1,2,3,4,5",
  "Cash Five,8,27,2026,2,3,4,5,6",
  "Cash Five,8,28,2026,3,4,5,6,7",
  "Cash Five,8,29,2026,4,5,6,7,8",
  "Cash Five,8,31,2026,5,6,7,8,9",
  "Cash Five,9,1,2026,6,7,8,9,10",
  "Cash Five,9,2,2026,7,8,9,10,11"
].join("\n");

interface SourcePointer {
  last_digest: string | null;
  last_object_key: string | null;
  last_success_at: string | null;
  last_status: string;
  last_error: string | null;
  row_count: number;
  active_count: number;
  latest_draw_date: string | null;
  consecutive_failures: number;
  last_parser_version: number;
  lease_token: string | null;
  lease_expires_at: string | null;
}

interface StoredDraw {
  draw_date: string;
  ordered_numbers: string;
  content_fingerprint: string;
  seen_ingestion_id: string;
  active: number;
  first_seen_at: string;
  updated_at: string;
  retired_at: string | null;
}

function serveSource(source: ExportSource, body: () => string): () => number {
  let calls = 0;
  network.use(
    http.get(source.url, () => {
      calls += 1;
      return HttpResponse.text(body(), {
        headers: { "Content-Type": "text/csv; charset=utf-8" }
      });
    })
  );
  return () => calls;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function sourcePointer(sourceId = CASH_SOURCE.id): Promise<SourcePointer> {
  const row = await env.LOTTO_DB.prepare(
    `SELECT last_digest, last_object_key, last_success_at, last_status, last_error,
            row_count, active_count, latest_draw_date, consecutive_failures,
            last_parser_version, lease_token, lease_expires_at
     FROM lotto_sources WHERE source_id = ?1`
  )
    .bind(sourceId)
    .first<SourcePointer>();
  if (!row) throw new Error(`Missing source state for ${sourceId}`);
  return row;
}

async function storedDraws(): Promise<StoredDraw[]> {
  const result = await env.LOTTO_DB.prepare(
    `SELECT draw_date, ordered_numbers, content_fingerprint, seen_ingestion_id,
            active, first_seen_at, updated_at, retired_at
     FROM lotto_draws WHERE source_id = ?1 ORDER BY draw_date`
  )
    .bind(CASH_SOURCE.id)
    .all<StoredDraw>();
  return result.results;
}

async function clearR2(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.LOTTO_RAW.list({ cursor });
    const keys = page.objects.map(({ key }) => key);
    if (keys.length > 0) await env.LOTTO_RAW.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

beforeEach(async () => {
  await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare("DELETE FROM lotto_lab_delivery_attempts"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_lab_delivery_outbox"),
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
    env.LOTTO_DB.prepare("DELETE FROM lotto_audit_snapshots"),
    env.LOTTO_DB.prepare("UPDATE schema_meta SET value = '6' WHERE key = 'schema_version'")
  ]);
  await clearR2();
});

describe("D1/R2 ingestion", () => {
  it("applies the complete schema-v6 migration chain", async () => {
    const schema = await env.LOTTO_DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'"
    ).first<{ value: string }>();
    const columns = await env.LOTTO_DB.prepare("PRAGMA table_info(lotto_sources)").all<{
      name: string;
    }>();

    expect(schema?.value).toBe("6");
    expect(columns.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["last_parser_version", "lease_token", "lease_expires_at", "enabled"])
    );
  });

  it("persists an initial official export with provenance in both stores", async () => {
    const body = `${CASH_THREE_ROWS}\n`;
    const calls = serveSource(CASH_SOURCE, () => body);

    const outcome = await refreshSource(env, CASH_SOURCE.id, "test");

    expect(calls()).toBe(1);
    expect(outcome).toMatchObject({
      sourceId: CASH_SOURCE.id,
      status: "complete",
      parsed: 3,
      inserted: 3,
      updated: 0,
      unchanged: 0,
      retired: 0,
      quarantined: 0,
      cacheFallback: false
    });
    expect(outcome.digest).toMatch(/^[a-f0-9]{64}$/);

    const pointer = await sourcePointer();
    expect(pointer).toMatchObject({
      last_digest: outcome.digest,
      last_object_key: `raw/cash5/cashfive/${outcome.digest}.csv`,
      last_status: "complete",
      last_error: null,
      row_count: 3,
      active_count: 3,
      latest_draw_date: "2026-09-02",
      consecutive_failures: 0,
      last_parser_version: 1,
      lease_token: null,
      lease_expires_at: null
    });
    expect(pointer.last_success_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const draws = await storedDraws();
    expect(draws).toHaveLength(3);
    expect(draws[0]).toMatchObject({
      draw_date: "2026-08-31",
      ordered_numbers: "[1,2,3,4,5]",
      seen_ingestion_id: outcome.ingestionId,
      active: 1,
      retired_at: null
    });
    expect(draws.every((draw) => draw.content_fingerprint.length > 0)).toBe(true);

    const ingestion = await env.LOTTO_DB.prepare(
      `SELECT trigger_kind, status, digest, object_key, total_rows, parsed,
              inserted, updated, unchanged, retired, quarantined, cache_fallback
       FROM lotto_ingestions WHERE ingestion_id = ?1`
    )
      .bind(outcome.ingestionId)
      .first<Record<string, unknown>>();
    expect(ingestion).toMatchObject({
      trigger_kind: "test",
      status: "complete",
      digest: outcome.digest,
      object_key: pointer.last_object_key,
      total_rows: 3,
      parsed: 3,
      inserted: 3,
      updated: 0,
      unchanged: 0,
      retired: 0,
      quarantined: 0,
      cache_fallback: 0
    });

    const raw = await env.LOTTO_RAW.get(pointer.last_object_key as string);
    expect(raw).not.toBeNull();
    expect(await raw?.text()).toBe(body);
    expect(raw?.httpMetadata?.contentType).toBe("text/csv; charset=utf-8");
    expect(raw?.customMetadata).toMatchObject({
      game: "cash5",
      sourceId: CASH_SOURCE.id,
      sourceUrl: CASH_SOURCE.url,
      sha256: outcome.digest,
      schemaVersion: "1",
      parserVersion: "1"
    });
  });

  it("treats an identical digest as idempotent without rewriting draws or R2", async () => {
    const body = `${CASH_THREE_ROWS}\n`;
    const calls = serveSource(CASH_SOURCE, () => body);
    const initial = await refreshSource(env, CASH_SOURCE.id, "test");
    const originalDraws = await storedDraws();

    const repeated = await refreshSource(env, CASH_SOURCE.id, "test");

    expect(calls()).toBe(2);
    expect(repeated).toMatchObject({
      status: "unchanged",
      digest: initial.digest,
      parsed: 3,
      inserted: 0,
      updated: 0,
      unchanged: 3,
      retired: 0,
      quarantined: 0,
      cacheFallback: false
    });
    expect(await storedDraws()).toEqual(originalDraws);

    const ingestions = await env.LOTTO_DB.prepare(
      "SELECT status FROM lotto_ingestions ORDER BY rowid"
    ).all<{ status: string }>();
    expect(ingestions.results.map(({ status }) => status)).toEqual(["complete", "unchanged"]);
    expect((await env.LOTTO_RAW.list()).objects.map(({ key }) => key)).toEqual([
      `raw/cash5/cashfive/${initial.digest}.csv`
    ]);
  });

  it("updates a corrected draw and reactivates a draw restored by the official source", async () => {
    let body = `${CASH_THREE_ROWS}\n`;
    serveSource(CASH_SOURCE, () => body);
    await refreshSource(env, CASH_SOURCE.id, "test");
    const original = await storedDraws();
    const restoredFirstSeen = original.find(
      ({ draw_date }) => draw_date === "2026-09-01"
    )?.first_seen_at;

    body = ["Cash Five,8,31,2026,1,2,3,4,5", "Cash Five,9,2,2026,11,12,13,14,15"].join("\n");
    const retired = await refreshSource(env, CASH_SOURCE.id, "test");
    expect(retired).toMatchObject({ parsed: 2, unchanged: 2, retired: 1 });
    expect((await storedDraws()).find(({ draw_date }) => draw_date === "2026-09-01")).toMatchObject(
      {
        active: 0,
        retired_at: expect.any(String)
      }
    );

    body = [
      "Cash Five,8,31,2026,1,2,3,4,6",
      "Cash Five,9,1,2026,6,7,8,9,10",
      "Cash Five,9,2,2026,11,12,13,14,15"
    ].join("\n");
    const corrected = await refreshSource(env, CASH_SOURCE.id, "test");

    expect(corrected).toMatchObject({
      parsed: 3,
      inserted: 0,
      updated: 2,
      unchanged: 1,
      retired: 0
    });
    const finalDraws = await storedDraws();
    expect(finalDraws.find(({ draw_date }) => draw_date === "2026-08-31")).toMatchObject({
      ordered_numbers: "[1,2,3,4,6]",
      active: 1,
      seen_ingestion_id: corrected.ingestionId
    });
    expect(finalDraws.find(({ draw_date }) => draw_date === "2026-09-01")).toMatchObject({
      active: 1,
      first_seen_at: restoredFirstSeen,
      retired_at: null,
      seen_ingestion_id: corrected.ingestionId
    });
    expect((await sourcePointer()).active_count).toBe(3);
  });

  it("rejects an incomplete replacement without advancing the validated source pointer", async () => {
    let body = `${CASH_SEVEN_ROWS}\n`;
    serveSource(CASH_SOURCE, () => body);
    await refreshSource(env, CASH_SOURCE.id, "test");
    const validatedPointer = await sourcePointer();

    body = ["Cash Five,9,1,2026,6,7,8,9,10", "Cash Five,9,2,2026,7,8,9,10,11"].join("\n");
    await expect(refreshSource(env, CASH_SOURCE.id, "test")).rejects.toThrow(
      /candidate omits 5 of 7 stored draws \(maximum tolerated 4\)/
    );

    const failedPointer = await sourcePointer();
    expect(failedPointer).toMatchObject({
      last_digest: validatedPointer.last_digest,
      last_object_key: validatedPointer.last_object_key,
      last_success_at: validatedPointer.last_success_at,
      last_status: "failed",
      row_count: 7,
      active_count: 7,
      latest_draw_date: "2026-09-02",
      consecutive_failures: 1,
      last_parser_version: 1,
      lease_token: null,
      lease_expires_at: null
    });
    expect(failedPointer.last_error).toMatch(/SchemaMismatchError: Schema mismatch/);
    expect((await storedDraws()).every(({ active }) => active === 1)).toBe(true);

    const latestIngestion = await env.LOTTO_DB.prepare(
      `SELECT status, digest, object_key, parsed, retired, error
       FROM lotto_ingestions ORDER BY rowid DESC LIMIT 1`
    ).first<Record<string, unknown>>();
    expect(latestIngestion).toMatchObject({
      status: "failed",
      parsed: 0,
      retired: 0,
      error: expect.stringMatching(/possible truncated export/)
    });
    const rejectedDigest = latestIngestion?.digest;
    expect(rejectedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(rejectedDigest).not.toBe(validatedPointer.last_digest);
    expect(latestIngestion?.object_key).toBe(`raw/cash5/cashfive/${String(rejectedDigest)}.csv`);
    expect((await env.LOTTO_RAW.list()).objects).toHaveLength(2);
  });

  it("rejects a concurrent refresh of the same source while preserving the active lease", async () => {
    const fetchStarted = deferred();
    const releaseFetch = deferred();
    let fetches = 0;
    network.use(
      http.get(CASH_SOURCE.url, async () => {
        fetches += 1;
        fetchStarted.resolve();
        await releaseFetch.promise;
        return HttpResponse.text(`${CASH_THREE_ROWS}\n`, {
          headers: { "Content-Type": "text/csv; charset=utf-8" }
        });
      })
    );

    const firstRefresh = refreshSource(env, CASH_SOURCE.id, "test");
    await fetchStarted.promise;
    const running = await env.LOTTO_DB.prepare(
      `SELECT ingestion_id, status FROM lotto_ingestions
       WHERE source_id = ?1 ORDER BY rowid DESC LIMIT 1`
    )
      .bind(CASH_SOURCE.id)
      .first<{ ingestion_id: string; status: string }>();
    const claimed = await sourcePointer();
    expect(running).toMatchObject({ status: "running" });
    expect(claimed).toMatchObject({
      last_status: "never",
      lease_token: running?.ingestion_id
    });
    expect(Date.parse(claimed.lease_expires_at as string)).toBeGreaterThan(Date.now());

    try {
      await expect(refreshSource(env, CASH_SOURCE.id, "test")).rejects.toThrow(
        `Source ${CASH_SOURCE.id} is already being refreshed`
      );
      const duringLease = await sourcePointer();
      expect(duringLease.lease_token).toBe(running?.ingestion_id);
      const count = await env.LOTTO_DB.prepare(
        "SELECT COUNT(*) AS count FROM lotto_ingestions"
      ).first<{ count: number }>();
      expect(count?.count).toBe(1);
    } finally {
      releaseFetch.resolve();
    }

    const completed = await firstRefresh;
    expect(completed.status).toBe("complete");
    expect(fetches).toBe(1);
    expect(await sourcePointer()).toMatchObject({
      last_status: "complete",
      lease_token: null,
      lease_expires_at: null
    });
  });

  it("rotates scheduled ingestion through never-attempted sources in stable order", async () => {
    const daySource = GAME_MANIFEST.aon.sources.find(({ session }) => session === "day");
    const eveningSource = GAME_MANIFEST.aon.sources.find(({ session }) => session === "evening");
    if (!daySource || !eveningSource) throw new Error("Expected All or Nothing session sources");

    const numbers = "1,2,3,4,5,6,7,8,9,10,11,12";
    const dayCalls = serveSource(daySource, () => `All or Nothing Day,9,2,2026,${numbers}\n`);
    const eveningCalls = serveSource(
      eveningSource,
      () => `All or Nothing Evening,9,2,2026,${numbers}\n`
    );
    const controller = createScheduledController({
      cron: "*/10 * * * *",
      scheduledTime: new Date("2026-09-03T10:00:00Z")
    });

    await worker.scheduled(controller, env);
    await worker.scheduled(controller, env);

    expect(dayCalls()).toBe(1);
    expect(eveningCalls()).toBe(1);
    const ingestions = await env.LOTTO_DB.prepare(
      "SELECT source_id, trigger_kind, status FROM lotto_ingestions ORDER BY rowid"
    ).all<{ source_id: string; trigger_kind: string; status: string }>();
    expect(ingestions.results).toEqual([
      { source_id: "aon:allornothing-day", trigger_kind: "scheduled", status: "complete" },
      {
        source_id: "aon:allornothing-evening",
        trigger_kind: "scheduled",
        status: "complete"
      }
    ]);

    const sourceStates = await env.LOTTO_DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN last_attempt_at IS NOT NULL THEN 1 ELSE 0 END) AS attempted,
         SUM(CASE WHEN last_attempt_at IS NULL THEN 1 ELSE 0 END) AS pending
       FROM lotto_sources`
    ).first<{ total: number; attempted: number; pending: number }>();
    expect(sourceStates).toEqual({
      total: SOURCES.length,
      attempted: 2,
      pending: SOURCES.length - 2
    });
  });

  it("reports health only when schema v6, automation, and every source are ready", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T17:00:00Z"));
    try {
      const emptyResponse = await handleRequest(
        new Request("https://lotto-api.yevow.co/healthz"),
        env
      );
      expect(emptyResponse.status).toBe(503);
      await expect(emptyResponse.json()).resolves.toMatchObject({
        data: {
          status: "degraded",
          databaseSchemaVersion: "6",
          configuredSources: SOURCES.length,
          registeredSources: 0,
          readySources: 0,
          configuredGames: 8,
          selectedGames: 8,
          deliveryBridgeConfigured: true
        }
      });
      const whitespaceTokenResponse = await handleRequest(
        new Request("https://lotto-api.yevow.co/healthz"),
        { ...env, RABBITHOLETX_SERVICE_TOKEN: "   " }
      );
      expect(whitespaceTokenResponse.status).toBe(503);
      await expect(whitespaceTokenResponse.json()).resolves.toMatchObject({
        data: { deliveryBridgeConfigured: false }
      });

      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date());
      const ingestedAt = new Date().toISOString();
      await env.LOTTO_DB.batch(
        SOURCES.map((source, index) =>
          env.LOTTO_DB.prepare(
            `INSERT INTO lotto_sources
             (source_id, game, name, url, session, expected_widths,
              last_digest, active_count, last_status, last_success_at, latest_draw_date)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'bootstrap', ?9, ?10)`
          ).bind(
            source.id,
            source.game,
            source.name,
            source.url,
            source.session,
            JSON.stringify(source.expectedWidths),
            index === 0 ? null : `fixture-${index}`,
            index === 0 ? 0 : 1,
            ingestedAt,
            today
          )
        )
      );

      const partialResponse = await handleRequest(
        new Request("https://lotto-api.yevow.co/api/lotto/v1/health"),
        env
      );
      expect(partialResponse.status).toBe(503);
      await expect(partialResponse.json()).resolves.toMatchObject({
        data: {
          status: "degraded",
          databaseSchemaVersion: "6",
          registeredSources: SOURCES.length,
          readySources: SOURCES.length - 1
        }
      });

      await env.LOTTO_DB.prepare(
        "UPDATE lotto_sources SET last_digest = 'fixture-ready', active_count = 1 WHERE source_id = ?1"
      )
        .bind(SOURCES[0]?.id)
        .run();
      const readyResponse = await handleRequest(
        new Request("https://lotto-api.yevow.co/healthz"),
        env
      );
      expect(readyResponse.status).toBe(200);
      await expect(readyResponse.json()).resolves.toMatchObject({
        data: {
          status: "ok",
          databaseSchemaVersion: "6",
          registeredSources: SOURCES.length,
          readySources: SOURCES.length
        }
      });

      await env.LOTTO_DB.prepare(
        "UPDATE lotto_sources SET last_status = 'failed' WHERE source_id = ?1"
      )
        .bind(SOURCES[0]?.id)
        .run();
      const failedSourceResponse = await handleRequest(
        new Request("https://lotto-api.yevow.co/healthz"),
        env
      );
      expect(failedSourceResponse.status).toBe(503);
      await expect(failedSourceResponse.json()).resolves.toMatchObject({
        data: {
          status: "degraded",
          readySources: SOURCES.length - 1,
          unhealthySelectedGames: expect.arrayContaining([SOURCES[0]?.game])
        }
      });
      await env.LOTTO_DB.prepare("UPDATE lotto_game_config SET selected = 0 WHERE game = ?1")
        .bind(SOURCES[0]?.game)
        .run();
      const isolatedResponse = await handleRequest(
        new Request("https://lotto-api.yevow.co/healthz"),
        env
      );
      expect(isolatedResponse.status).toBe(200);
      await expect(isolatedResponse.json()).resolves.toMatchObject({
        data: {
          status: "ok",
          archiveStatus: "degraded",
          unhealthySelectedGames: [],
          degradedArchiveGames: expect.arrayContaining([SOURCES[0]?.game])
        }
      });
      await env.LOTTO_DB.prepare(
        "UPDATE lotto_sources SET last_status = 'bootstrap' WHERE source_id = ?1"
      )
        .bind(SOURCES[0]?.id)
        .run();
      await env.LOTTO_DB.prepare("UPDATE lotto_game_config SET selected = 1 WHERE game = ?1")
        .bind(SOURCES[0]?.game)
        .run();

      await env.LOTTO_DB.prepare(
        "UPDATE lotto_game_config SET selected = 0, play_style = 'box' WHERE game = 'p3'"
      ).run();
      const invalidUnselectedResponse = await handleRequest(
        new Request("https://lotto-api.yevow.co/healthz"),
        env
      );
      expect(invalidUnselectedResponse.status).toBe(200);

      await env.LOTTO_DB.prepare(
        "UPDATE lotto_game_config SET selected = 1 WHERE game = 'p3'"
      ).run();
      const invalidSelectedResponse = await handleRequest(
        new Request("https://lotto-api.yevow.co/healthz"),
        env
      );
      expect(invalidSelectedResponse.status).toBe(503);
      await expect(invalidSelectedResponse.json()).resolves.toMatchObject({
        data: { status: "degraded", invalidSelectedGames: ["p3"] }
      });
      await env.LOTTO_DB.prepare(
        "UPDATE lotto_game_config SET play_style = 'straight' WHERE game = 'p3'"
      ).run();

      await env.LOTTO_DB.prepare(
        "UPDATE lotto_game_config SET jackpot_cents = 1 WHERE game = 'cash5'"
      ).run();
      const invalidEvResponse = await handleRequest(
        new Request("https://lotto-api.yevow.co/healthz"),
        env
      );
      expect(invalidEvResponse.status).toBe(503);
      await env.LOTTO_DB.prepare(
        "UPDATE lotto_game_config SET jackpot_cents = 0 WHERE game = 'cash5'"
      ).run();

      await env.LOTTO_DB.prepare(
        "UPDATE schema_meta SET value = '3' WHERE key = 'schema_version'"
      ).run();
      try {
        const oldSchemaResponse = await handleRequest(
          new Request("https://lotto-api.yevow.co/healthz"),
          env
        );
        expect(oldSchemaResponse.status).toBe(503);
        await expect(oldSchemaResponse.json()).resolves.toMatchObject({
          data: {
            status: "degraded",
            databaseSchemaVersion: "3",
            readySources: SOURCES.length
          }
        });
      } finally {
        await env.LOTTO_DB.prepare(
          "UPDATE schema_meta SET value = '6' WHERE key = 'schema_version'"
        ).run();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
