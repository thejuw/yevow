import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSource, type GameCode, type Session } from "../src/manifest";
import {
  expectedResultDrawAt,
  readExpectedResultGaps,
  refreshExpectedResult
} from "../src/result-freshness";
import { network } from "./network";

const NOW = new Date("2026-09-19T18:40:00.000Z");
let sequence = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_ledger_eligibility_events
      (eligibility_event_id, ledger_id, idempotency_key, eligible, reason_code, reason, recorded_at, created_at)
      SELECT 'freshness-reset-' || hex(randomblob(16)), ledger_id, hex(randomblob(16)), 0,
        'manual-integrity-exclusion', 'Reset independent monitor fixture', ?1, ?1
      FROM lotto_ticket_ledger WHERE ledger_id LIKE 'freshness-%'`
    ).bind(NOW.toISOString()),
    env.LOTTO_DB.prepare("UPDATE lotto_game_config SET selected = 0"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_draws"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_quarantine"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_ingestions"),
    env.LOTTO_DB.prepare("DELETE FROM lotto_sources")
  ]);
});
afterEach(() => vi.useRealTimers());

async function fixture(
  options: {
    game?: GameCode;
    session?: Session;
    drawDate?: string;
    eligible?: boolean;
    origin?: "system" | "random" | "user";
    selected?: boolean;
    lastAttempt?: string | null;
    status?: string;
    latestDate?: string | null;
  } = {}
): Promise<string> {
  const game = options.game ?? "p3";
  const session = options.session ?? "morning";
  const date = options.drawDate ?? "2026-09-19";
  const source = getSource(
    game === "p3"
      ? `p3:pick3-${session}`
      : game === "d4"
        ? `d4:daily4-${session}`
        : game === "aon"
          ? `aon:allornothing-${session}`
          : game === "cash5"
            ? "cash5:cashfive"
            : `${game}:${game === "lotto" ? "lottotexas" : game === "pb" ? "powerball" : game === "mm" ? "megamillions" : "texastwostep"}`
  );
  const key = `freshness-${++sequence}-${crypto.randomUUID()}`;
  const proposed = `${date}T10:00:00.000Z`;
  const main = game === "p3" ? "[1,2,3]" : game === "d4" ? "[1,2,3,4]" : "[1,2,3,4,5]";
  await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare("UPDATE lotto_game_config SET selected = ?1 WHERE game = ?2").bind(
      options.selected === false ? 0 : 1,
      game
    ),
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_ticket_ledger
      (ledger_id, origin, game, draw_date, target_session, proposed_at, seed, ev_net_cents,
       ev_assumption, ticket_cost_cents, ticket_count, split_risk_model_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'freshness-seed', -25, 'test', 50, 1, '{}', ?6)`
    ).bind(key, options.origin ?? "system", game, date, session, proposed),
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_ledger_tickets
      (ledger_ticket_id, ledger_id, ordinal, main_numbers, play_style, wager_cents,
       ticket_options_json, split_risk_basis_points, split_risk_level, created_at)
      VALUES (?1, ?2, 1, ?3, 'straight', 50, '{"stakeCents":50,"fireball":false}', 0, 'low', ?4)`
    ).bind(`${key}-ticket`, key, main, proposed),
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_ledger_eligibility_events
      (eligibility_event_id, ledger_id, idempotency_key, eligible, reason_code, reason, recorded_at, created_at)
      VALUES (?1, ?2, 'initial', ?3, ?4, 'Monitor fixture', ?5, ?5)`
    ).bind(
      `${key}-eligibility`,
      key,
      options.eligible === false ? 0 : 1,
      options.eligible === false ? "manual-integrity-exclusion" : "pre-draw-capture",
      proposed
    ),
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_sources
      (source_id,game,name,url,session,expected_widths,last_attempt_at,last_status,latest_draw_date)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
      ON CONFLICT(source_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
        last_status=excluded.last_status, latest_draw_date=excluded.latest_draw_date`
    ).bind(
      source.id,
      game,
      source.name,
      source.url,
      session,
      JSON.stringify(source.expectedWidths),
      options.lastAttempt ?? null,
      options.status ?? "complete",
      options.latestDate ?? "2026-09-18"
    )
  ]);
  return key;
}

async function storedResult(sourceId: string, date = "2026-09-19", active = 1): Promise<void> {
  const source = getSource(sourceId);
  await env.LOTTO_DB.prepare(
    `INSERT INTO lotto_draws
    (game,draw_date,session,ordered_numbers,canonical_numbers,content_fingerprint,
     source_id,source_url,source_sha256,source_line,raw_record,seen_ingestion_id,
     active,first_seen_at,updated_at)
    VALUES (?1,?2,?3,'[4,5,6]','[4,5,6]','fixture',?4,?5,'fixture',1,'fixture','fixture',?6,?7,?7)`
  )
    .bind(source.game, date, source.session, source.id, source.url, active, NOW.toISOString())
    .run();
}

describe("official expected-result clocks", () => {
  it("uses actual draw times and follows daylight-saving offsets", () => {
    expect(expectedResultDrawAt("p3", "2026-01-12", "morning").toISOString()).toBe(
      "2026-01-12T16:00:00.000Z"
    );
    expect(expectedResultDrawAt("p3", "2026-09-19", "morning").toISOString()).toBe(
      "2026-09-19T15:00:00.000Z"
    );
    expect(expectedResultDrawAt("p3", "2026-03-09", "morning").toISOString()).toBe(
      "2026-03-09T15:00:00.000Z"
    );
    expect(expectedResultDrawAt("p3", "2026-11-02", "morning").toISOString()).toBe(
      "2026-11-02T16:00:00.000Z"
    );
    expect(expectedResultDrawAt("pb", "2026-09-19", "").toISOString()).toBe(
      "2026-09-20T02:59:00.000Z"
    );
    expect(expectedResultDrawAt("mm", "2026-09-18", "").toISOString()).toBe(
      "2026-09-19T03:00:00.000Z"
    );
    expect(expectedResultDrawAt("cash5", "2026-09-19", "").toISOString()).toBe(
      "2026-09-20T03:12:00.000Z"
    );
  });

  it("requires a real date and correct session identity", () => {
    expect(() => expectedResultDrawAt("p3", "2026-02-30", "morning")).toThrow(/date/);
    expect(() => expectedResultDrawAt("p3", "2026-09-19", "")).toThrow(/session/);
    expect(() => expectedResultDrawAt("cash5", "2026-09-19", "morning")).toThrow(/sessions/);
  });

  it("waits until draw time plus the full publication grace, not the sales cutoff", async () => {
    await fixture();
    expect(await readExpectedResultGaps(env, new Date("2026-09-19T14:55:00.000Z"))).toEqual([]);
    expect(await readExpectedResultGaps(env, new Date("2026-09-19T15:19:59.999Z"))).toEqual([]);
    expect(await readExpectedResultGaps(env, new Date("2026-09-19T15:20:00.000Z"))).toHaveLength(1);
  });
});

describe("session-specific result presence", () => {
  it("reports a missing morning result even when source status says complete", async () => {
    await fixture({ status: "complete", latestDate: "2026-09-18" });
    const gaps = await readExpectedResultGaps(env, NOW);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      game: "p3",
      session: "morning",
      sourceId: "p3:pick3-morning",
      drawDate: "2026-09-19",
      sourceStatus: "complete",
      refreshDue: true,
      missingDrawCount: 1,
      missingSince: "2026-09-19T15:20:00.000Z"
    });
  });

  it("does not let evening data stand in for the persisted morning target", async () => {
    await fixture();
    await fixture({ session: "evening" });
    await storedResult("p3:pick3-evening");
    const gaps = await readExpectedResultGaps(env, new Date("2026-09-20T04:00:00.000Z"));
    expect(gaps.map((gap) => gap.session)).toEqual(["morning"]);
    await storedResult("p3:pick3-morning");
    expect(await readExpectedResultGaps(env, NOW)).toEqual([]);
  });

  it("ignores retired results and aggregates unresolved dates per exact source", async () => {
    await fixture({ drawDate: "2026-09-18" });
    await fixture();
    await storedResult("p3:pick3-morning", "2026-09-19", 0);
    const gaps = await readExpectedResultGaps(env, NOW);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ drawDate: "2026-09-18", missingDrawCount: 2 });
  });

  it("excludes disabled games, excluded ledgers, controls and user entries", async () => {
    await fixture({ eligible: false });
    await fixture({ game: "d4", selected: false });
    await fixture({ origin: "random" });
    await fixture({ origin: "user" });
    expect(await readExpectedResultGaps(env, NOW)).toEqual([]);
  });

  it("uses latest eligibility events and never treats unverified legacy attestations as targets", async () => {
    const ledgerId = await fixture();
    await env.LOTTO_DB.prepare(
      `INSERT INTO lotto_ledger_eligibility_events
      (eligibility_event_id,ledger_id,idempotency_key,eligible,reason_code,reason,recorded_at,created_at)
      VALUES (?1,?2,'superseded',0,'manual-integrity-exclusion','Review',?3,?3)`
    )
      .bind(`${ledgerId}-excluded`, ledgerId, NOW.toISOString())
      .run();
    expect(await readExpectedResultGaps(env, NOW)).toEqual([]);
    const legacy = await fixture({ session: "day" });
    await env.LOTTO_DB.prepare(
      `INSERT INTO lotto_ledger_eligibility_events
      (eligibility_event_id,ledger_id,idempotency_key,eligible,reason_code,reason,recorded_at,created_at)
      VALUES (?1,?2,'legacy',1,'schema-v7-attestation','Unverified',?3,?3)`
    )
      .bind(`${legacy}-legacy`, legacy, NOW.toISOString())
      .run();
    expect(await readExpectedResultGaps(env, NOW)).toEqual([]);
  });

  it("does not invent Sunday draw obligations", async () => {
    await fixture({ drawDate: "2026-09-13" });
    expect(await readExpectedResultGaps(env, NOW)).toEqual([]);
  });
});

describe("bounded expected-result refresh", () => {
  it("fetches at most one source and uses oldest-attempt fairness rather than game order", async () => {
    await fixture({ lastAttempt: "2026-09-19T16:00:00.000Z" });
    await fixture({ game: "d4", lastAttempt: "2026-09-19T15:00:00.000Z" });
    const requests: string[] = [];
    network.use(
      http.get(getSource("d4:daily4-morning").url, () => {
        requests.push("d4");
        return HttpResponse.text("Daily 4 Morning,9,18,2026,4,5,6,7,,0\n");
      })
    );
    network.use(
      http.get(getSource("p3:pick3-morning").url, () => {
        requests.push("p3");
        return HttpResponse.text("Pick 3 Morning,9,18,2026,4,5,6,,0\n");
      })
    );
    expect((await refreshExpectedResult(env, NOW))?.sourceId).toBe("d4:daily4-morning");
    expect(requests).toEqual(["d4"]);
    expect((await refreshExpectedResult(env, NOW))?.sourceId).toBe("p3:pick3-morning");
    expect(requests).toEqual(["d4", "p3"]);
    expect(await refreshExpectedResult(env, NOW)).toBeNull();
    expect((await readExpectedResultGaps(env, NOW)).every((gap) => gap.refreshDue === false)).toBe(
      true
    );
  });

  it("heals the exact session and removes its gap after official ingestion", async () => {
    await fixture();
    network.use(
      http.get(getSource("p3:pick3-morning").url, () =>
        HttpResponse.text("Pick 3 Morning,9,19,2026,4,5,6,,0\n")
      )
    );
    const outcome = await refreshExpectedResult(env, NOW);
    expect(outcome?.inserted).toBe(1);
    expect(await readExpectedResultGaps(env, NOW)).toEqual([]);
  });

  it("retains a visible missing gap and throttle when the official export is unchanged", async () => {
    await fixture();
    network.use(
      http.get(getSource("p3:pick3-morning").url, () =>
        HttpResponse.text("Pick 3 Morning,9,18,2026,4,5,6,,0\n")
      )
    );
    await refreshExpectedResult(env, NOW);
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
    expect((await refreshExpectedResult(env, new Date()))?.status).toBe("unchanged");
    // The established ingester preserves last_status=complete on byte-identical success.
    expect((await readExpectedResultGaps(env, new Date()))[0]?.sourceStatus).toBe("complete");
    expect((await readExpectedResultGaps(env, new Date()))[0]?.refreshDue).toBe(false);
  });

  it("propagates failed downloads and honors the ten-minute retry cap after failure", async () => {
    await fixture();
    let requests = 0;
    network.use(
      http.get(getSource("p3:pick3-morning").url, () => {
        requests += 1;
        return new HttpResponse(null, { status: 503 });
      })
    );
    await expect(refreshExpectedResult(env, NOW)).rejects.toThrow(/download failed/);
    expect(requests).toBe(3);
    expect(await refreshExpectedResult(env, new Date(NOW.getTime() + 9 * 60_000))).toBeNull();
    expect(requests).toBe(3);
    expect((await readExpectedResultGaps(env, NOW))[0]).toMatchObject({
      refreshDue: false,
      sourceStatus: "failed"
    });
  });

  it("does not report cached fallback as healed when the target result is still missing", async () => {
    await fixture();
    network.use(
      http.get(getSource("p3:pick3-morning").url, () =>
        HttpResponse.text("Pick 3 Morning,9,18,2026,4,5,6,,0\n")
      )
    );
    await refreshExpectedResult(env, NOW);
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
    network.use(
      http.get(getSource("p3:pick3-morning").url, () => new HttpResponse(null, { status: 503 }))
    );
    await expect(refreshExpectedResult(env, new Date())).rejects.toThrow(
      /cached data did not resolve/
    );
    expect((await readExpectedResultGaps(env, new Date()))[0]?.sourceStatus).toBe("cache-fallback");
  });

  it("respects active ingest leases and recovers an unregistered official source", async () => {
    await fixture();
    await env.LOTTO_DB.prepare(
      "UPDATE lotto_sources SET lease_token = 'another-ingester', lease_expires_at = ?1"
    )
      .bind(new Date(NOW.getTime() + 5 * 60_000).toISOString())
      .run();
    expect(await refreshExpectedResult(env, NOW)).toBeNull();
    await env.LOTTO_DB.prepare("DELETE FROM lotto_sources").run();
    network.use(
      http.get(getSource("p3:pick3-morning").url, () =>
        HttpResponse.text("Pick 3 Morning,9,19,2026,4,5,6,,0\n")
      )
    );
    expect((await refreshExpectedResult(env, NOW))?.sourceId).toBe("p3:pick3-morning");
  });

  it("atomically prevents concurrent watchdog calls from fetching the same source twice", async () => {
    await fixture();
    let requests = 0;
    network.use(
      http.get(getSource("p3:pick3-morning").url, () => {
        requests += 1;
        return HttpResponse.text("Pick 3 Morning,9,18,2026,4,5,6,,0\n");
      })
    );
    const outcomes = await Promise.all([
      refreshExpectedResult(env, NOW),
      refreshExpectedResult(env, NOW)
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(requests).toBe(1);
  });
});
