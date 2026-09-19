import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { parseChallengers } from "../../web/lib/lotto/challenger-client";
import { generateTickets } from "../../web/lib/lotto/picker";
import { handleRequest } from "../src/api";
import { GAME_MANIFEST, type GameCode } from "../src/manifest";
import { captureShadowTrials, gradeShadowTrials, readShadowTrials } from "../src/shadow";
import { generationLedgerStatements, gradeTicket, readTrackRecord } from "../src/ticket-lab";
import { network } from "./network";

const DATES = [
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-05",
  "2026-10-06",
  "2026-10-09",
  "2026-10-10",
  "2026-10-12",
  "2026-10-14"
];
let sequence = 0;
let DATE = DATES[0] as string;
let BEFORE = new Date(`${DATE}T12:00:00.000Z`);
let AFTER = new Date("2026-10-02T05:00:00.000Z");
const FILTERS: { game: null; from: string; to: string } = { game: null, from: DATE, to: DATE };
beforeEach(() => {
  DATE = DATES[sequence++] as string;
  BEFORE = new Date(`${DATE}T12:00:00.000Z`);
  AFTER = new Date(new Date(`${DATE}T05:00:00.000Z`).getTime() + 24 * 60 * 60_000);
  FILTERS.from = DATE;
  FILTERS.to = DATE;
});

async function parent(id: number, game: GameCode = "cash5", date = DATE) {
  const runId = `gen-${id.toString(16).padStart(32, "0")}`;
  const seed = `shadow-fixture-${id}`;
  const picked = generateTickets({ game, count: 4, seed, playStyle: "straight" });
  await env.LOTTO_DB.batch(
    await generationLedgerStatements(env.LOTTO_DB, {
      runId,
      game,
      drawDate: date,
      generatedAt: BEFORE.toISOString(),
      seed,
      tickets: picked.tickets,
      coverage: picked.coverage,
      evNetCents: -50,
      evAssumption: "fixture only",
      ticketCostCents: GAME_MANIFEST[game].baseCostCents,
      observedThrough: "2026-09-30",
      datasetDigest: "a".repeat(64)
    })
  );
  return { runId, ledgerId: `ledger-${runId.slice(4)}` };
}

async function result(
  game: GameCode = "cash5",
  date = DATE,
  fingerprint = "shadow-result-v1",
  main = [1, 2, 3, 4, 5],
  bonus: number[] = []
) {
  const sourceId = `shadow-fixture-${game}`;
  const session = ["p3", "d4", "aon"].includes(game) ? "morning" : "";
  await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare(
      `INSERT OR IGNORE INTO lotto_sources(source_id,game,name,url,session,expected_widths,enabled)
      VALUES(?1,?2,?1,?4,?3,'[1]',1)`
    ).bind(sourceId, game, session, `https://www.texaslottery.com/fixture/${game}`),
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_draws(game,draw_date,session,ordered_numbers,canonical_numbers,bonus_numbers,metadata,
      content_fingerprint,source_id,source_url,source_sha256,source_line,raw_record,seen_ingestion_id,active,first_seen_at,updated_at)
      VALUES(?1,?2,?3,?4,?4,?5,'{}',?6,?7,'https://www.texaslottery.com/fixture',?8,1,'fixture','fixture',1,?9,?9)
      ON CONFLICT(game,draw_date,session) DO UPDATE SET ordered_numbers=excluded.ordered_numbers,canonical_numbers=excluded.canonical_numbers,
      bonus_numbers=excluded.bonus_numbers,content_fingerprint=excluded.content_fingerprint,active=1,updated_at=excluded.updated_at`
    ).bind(
      game,
      date,
      session,
      JSON.stringify(main),
      JSON.stringify(bonus),
      fingerprint,
      sourceId,
      "b".repeat(64),
      AFTER.toISOString()
    )
  ]);
}

async function exclude(ledgerId: string) {
  await env.LOTTO_DB.prepare(
    `INSERT INTO lotto_ledger_eligibility_events
    (eligibility_event_id,ledger_id,idempotency_key,eligible,reason_code,reason,evidence_json,recorded_at,created_at)
    VALUES(?1,?2,?1,0,'manual-integrity-exclusion','test exclusion','{}',?3,?3)`
  )
    .bind(`exclude-${ledgerId}`, ledgerId, AFTER.toISOString())
    .run();
}

describe("paper-only forward challenger lifecycle", () => {
  it("persists three equal-cost arms once without changing live ledger or messaging", async () => {
    const p = await parent(1);
    const liveBefore = await readTrackRecord(env, FILTERS);
    expect(await captureShadowTrials(env, p.runId, () => BEFORE)).toBe(1);
    expect(await captureShadowTrials(env, p.runId, () => BEFORE)).toBe(0);
    const stored = await env.LOTTO_DB.prepare(
      "SELECT * FROM lotto_shadow_trials WHERE draw_date=?1"
    )
      .bind(DATE)
      .all<{ arms_json: string; config_hash: string; seed: string }>();
    expect(stored.results).toHaveLength(1);
    expect(stored.results[0]?.config_hash).toMatch(/^[a-f0-9]{64}$/);
    const arms = JSON.parse(stored.results[0]?.arms_json ?? "{}");
    expect(Object.values(arms).map((value) => (Array.isArray(value) ? value.length : 0))).toEqual([
      4, 4, 4
    ]);
    expect(await readTrackRecord(env, FILTERS)).toEqual(liveBefore);
    expect(
      await env.LOTTO_DB.prepare("SELECT COUNT(*) AS n FROM lotto_lab_delivery_outbox").first("n")
    ).toBe(0);
    expect(
      await env.LOTTO_DB.prepare(
        "SELECT COUNT(*) AS n FROM lotto_purchase_confirmation_events"
      ).first("n")
    ).toBe(0);
    const data = await readShadowTrials(env, FILTERS);
    expect(() =>
      parseChallengers({ schemaVersion: 1, generatedAt: BEFORE.toISOString(), data })
    ).not.toThrow();
    expect(data.variants[0]).toMatchObject({
      draws: 1,
      gradedDraws: 0,
      spentCents: 0,
      roiPercent: null
    });
    await expect(
      env.LOTTO_DB.prepare("UPDATE lotto_shadow_trials SET seed='changed' WHERE draw_date=?1")
        .bind(DATE)
        .run()
    ).rejects.toThrow(/immutable/);
    await expect(
      env.LOTTO_DB.prepare("DELETE FROM lotto_shadow_trials WHERE draw_date=?1").bind(DATE).run()
    ).rejects.toThrow(/immutable/);
  });

  it("rejects result-known, closed-sales, and elapsed review-window captures", async () => {
    const p = await parent(2);
    expect(await captureShadowTrials(env, p.runId, () => AFTER)).toBe(0);
    let clockCalls = 0;
    expect(
      await captureShadowTrials(env, p.runId, () => (++clockCalls === 1 ? BEFORE : AFTER))
    ).toBe(0);
    await result();
    expect(await captureShadowTrials(env, p.runId, () => BEFORE)).toBe(0);
    const future = await parent(3, "cash5", "2026-12-21");
    expect(await captureShadowTrials(env, future.runId, () => BEFORE)).toBe(0);
  });

  it("grades all frozen arms identically to official grader and never sends challenger texts", async () => {
    const p = await parent(4);
    await captureShadowTrials(env, p.runId, () => BEFORE);
    await result();
    expect(await gradeShadowTrials(env, "cash5", AFTER)).toBe(1);
    expect(await gradeShadowTrials(env, "cash5", AFTER)).toBe(0);
    const trial = await env.LOTTO_DB.prepare(
      "SELECT arms_json FROM lotto_shadow_trials WHERE draw_date=?1"
    )
      .bind(DATE)
      .first<{ arms_json: string }>();
    const graded = await env.LOTTO_DB.prepare(
      "SELECT g.arms_json FROM lotto_shadow_grades g JOIN lotto_shadow_trials t USING(trial_id) WHERE t.draw_date=?1"
    )
      .bind(DATE)
      .first<{ arms_json: string }>();
    const arms = JSON.parse(trial?.arms_json ?? "{}");
    const outcomes = JSON.parse(graded?.arms_json ?? "{}");
    for (const arm of ["challenger", "current", "random"]) {
      expect(outcomes[arm].tickets).toEqual(
        arms[arm].map((ticket: Parameters<typeof gradeTicket>[1]) =>
          gradeTicket("cash5", ticket, {
            drawDate: DATE,
            main: [1, 2, 3, 4, 5],
            bonus: [],
            metadata: {}
          })
        )
      );
    }
    const data = await readShadowTrials(env, FILTERS);
    const parsed = parseChallengers({ schemaVersion: 1, generatedAt: AFTER.toISOString(), data });
    expect(parsed.data.variants[0]).toMatchObject({
      gradedDraws: 1,
      gradedTickets: 4,
      spentCents: 400
    });
    expect(parsed.data.variants[0]?.comparisons.current.spentCents).toBe(400);
    expect(parsed.data.variants[0]?.comparisons.random.spentCents).toBe(400);
    expect(
      await env.LOTTO_DB.prepare("SELECT COUNT(*) AS n FROM lotto_lab_delivery_outbox").first("n")
    ).toBe(0);
    await expect(
      env.LOTTO_DB.prepare("UPDATE lotto_shadow_grades SET status='excluded'").run()
    ).rejects.toThrow(/append-only/);
  });

  it("immediately removes newly excluded parents without awaiting asynchronous grade maintenance", async () => {
    const p = await parent(5);
    await captureShadowTrials(env, p.runId, () => BEFORE);
    await result();
    await gradeShadowTrials(env, "cash5", AFTER);
    await exclude(p.ledgerId);
    const data = await readShadowTrials(env, FILTERS);
    expect(data.variants[0]).toMatchObject({ draws: 0, gradedDraws: 0, spentCents: 0 });
    expect(data.latest[0]?.status).toBe("excluded");
    expect(await gradeShadowTrials(env, "cash5", new Date(AFTER.getTime() + 31 * 60_000))).toBe(1);
    expect(
      await env.LOTTO_DB.prepare(
        "SELECT COUNT(*) AS n FROM lotto_shadow_grades g JOIN lotto_shadow_trials t USING(trial_id) WHERE t.draw_date=?1"
      )
        .bind(DATE)
        .first("n")
    ).toBe(2);
  });

  it("suppresses stale grades immediately and appends result correction revisions", async () => {
    const p = await parent(6);
    await captureShadowTrials(env, p.runId, () => BEFORE);
    await result();
    await gradeShadowTrials(env, "cash5", AFTER);
    await result("cash5", DATE, "shadow-result-v2", [11, 12, 13, 14, 15]);
    expect((await readShadowTrials(env, FILTERS)).variants[0]?.gradedDraws).toBe(0);
    expect(await gradeShadowTrials(env, "cash5", new Date(AFTER.getTime() + 31 * 60_000))).toBe(1);
    expect(
      await env.LOTTO_DB.prepare(
        "SELECT COUNT(*) AS n FROM lotto_shadow_grades g JOIN lotto_shadow_trials t USING(trial_id) WHERE t.draw_date=?1"
      )
        .bind(DATE)
        .first("n")
    ).toBe(2);
  });

  it("matches frozen Mega Millions multiplier options across all three arms", async () => {
    const p = await parent(7, "mm");
    expect(await captureShadowTrials(env, p.runId, () => BEFORE)).toBe(2);
    const trials = await env.LOTTO_DB.prepare(
      "SELECT arms_json FROM lotto_shadow_trials WHERE draw_date=?1"
    )
      .bind(DATE)
      .all<{ arms_json: string }>();
    for (const trial of trials.results) {
      const arms = JSON.parse(trial.arms_json);
      for (let i = 0; i < 4; i++) {
        expect(arms.challenger[i].options).toEqual(arms.current[i].options);
        expect(arms.random[i].options).toEqual(arms.current[i].options);
        expect(arms.current[i].options.multiplierProvenance).toBe("modeled");
      }
    }
  });

  it("keeps pending jackpot work fair so later pending rows are not starved", async () => {
    for (let i = 0; i < 35; i++) {
      const p = await parent(100 + i, "cash5");
      await captureShadowTrials(env, p.runId, () => BEFORE);
    }
    const trials = await env.LOTTO_DB.prepare(
      "SELECT trial_id FROM lotto_shadow_trials WHERE draw_date=?1 ORDER BY trial_id"
    )
      .bind(DATE)
      .all<{ trial_id: string }>();
    const initialGrades = trials.results.map((t, i) =>
      env.LOTTO_DB.prepare(
        `INSERT INTO lotto_shadow_grades
      (grade_id,trial_id,outcome_hash,draw_fingerprint,status,evidence_json,arms_json,graded_at)
      VALUES(?1,?2,'pending','shadow-result-v1','pending','{}','{}','2026-10-01T05:00:00Z')`
      ).bind(`pending-${i}`, t.trial_id)
    );
    await env.LOTTO_DB.batch(initialGrades);
    await result();
    await gradeShadowTrials(env, "cash5", AFTER);
    await gradeShadowTrials(env, "cash5", new Date(AFTER.getTime() + 1_000));
    expect(
      await env.LOTTO_DB.prepare(
        "SELECT COUNT(*) AS n FROM lotto_shadow_work w JOIN lotto_shadow_trials t USING(trial_id) WHERE t.draw_date=?1"
      )
        .bind(DATE)
        .first("n")
    ).toBe(35);
  });

  it("protects exact challenger tickets behind private read access", async () => {
    const path = `https://lotto-api.yevow.co/api/lotto/v1/ticket-lab/challengers?from=${DATE}&to=${DATE}`;
    expect((await handleRequest(new Request(path), env)).status).toBe(401);
    const response = await handleRequest(
      new Request(path, { headers: { Authorization: "Bearer test-service-token" } }),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(() => parseChallengers(JSON.parse("{}"))).toThrow();
    expect(parseChallengers(await response.json()).data.latest).toEqual([]);
  });

  it("rotates the two-fetch payout budget past permanently unavailable earlier draws", async () => {
    const dates = ["2026-10-14", "2026-10-17", "2026-10-19"];
    network.use(
      http.get(
        "https://www.texaslottery.com/export/sites/lottery/Games/Lotto_Texas/Winning_Numbers/",
        () => new HttpResponse(null, { status: 503 })
      )
    );
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i] as string;
      const p = await parent(200 + i, "lotto", date);
      await captureShadowTrials(env, p.runId, () => BEFORE);
      const row = await env.LOTTO_DB.prepare(
        "SELECT main_numbers FROM lotto_ledger_tickets WHERE ledger_id=?1 AND ordinal=1"
      )
        .bind(p.ledgerId)
        .first<{ main_numbers: string }>();
      const main = JSON.parse(row?.main_numbers ?? "[]") as number[];
      const other = Array.from({ length: 54 }, (_, j) => j + 1).filter((n) => !main.includes(n));
      await result("lotto", date, `lotto-pending-${i}`, [
        ...main.slice(0, 4),
        ...other.slice(0, 2)
      ]);
    }
    const afterAll = new Date("2026-10-20T05:00:00Z");
    await gradeShadowTrials(env, "lotto", afterAll);
    expect(
      await env.LOTTO_DB.prepare(
        "SELECT COUNT(*) AS n FROM lotto_payout_sources WHERE game='lotto'"
      ).first("n")
    ).toBe(2);
    await gradeShadowTrials(env, "lotto", new Date(afterAll.getTime() + 31 * 60_000));
    expect(
      await env.LOTTO_DB.prepare(
        "SELECT COUNT(*) AS n FROM lotto_payout_sources WHERE game='lotto'"
      ).first("n")
    ).toBe(3);
  }, 15_000);
});
