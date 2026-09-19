/** Result presence is session-specific; a successful export fetch is not freshness. */
import type { Env } from "./env";
import { refreshSource, type IngestOutcome } from "./ingest";
import { GAME_MANIFEST, SOURCES, getSource, type GameCode, type Session } from "./manifest";
import { officialDrawWeekdays, texasClock } from "./scheduler";

export const RESULT_PUBLICATION_GRACE_MINUTES = 20;
export const RESULT_REFRESH_RETRY_MINUTES = 10;

/** Current draw times, not ticket-sales cutoffs or delayed Texas broadcasts. */
const INTRADAY_DRAW_MINUTES: Readonly<Record<Exclude<Session, "">, number>> = {
  morning: 10 * 60,
  day: 12 * 60 + 27,
  evening: 18 * 60,
  night: 22 * 60 + 12
};
const POOL_DRAW_MINUTES: Readonly<Record<Exclude<GameCode, "p3" | "d4" | "aon">, number>> = {
  lotto: 22 * 60 + 12,
  twostep: 22 * 60 + 12,
  cash5: 22 * 60 + 12,
  pb: 21 * 60 + 59,
  mm: 22 * 60
};

/** Primary operator sources checked September 19, 2026. */
export const RESULT_SCHEDULE_SOURCES: Readonly<Record<GameCode, string>> = {
  lotto: GAME_MANIFEST.lotto.officialPage,
  twostep: GAME_MANIFEST.twostep.officialPage,
  cash5: GAME_MANIFEST.cash5.officialPage,
  p3: GAME_MANIFEST.p3.officialPage,
  d4: GAME_MANIFEST.d4.officialPage,
  aon: GAME_MANIFEST.aon.officialPage,
  pb: "https://www.powerball.com/",
  mm: "https://www.megamillions.com/faqs"
};
const WEEKDAY_NUMBERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface ExpectedResultGap {
  readonly game: GameCode;
  /** Oldest unresolved eligible system draw for this exact official source/session. */
  readonly drawDate: string;
  readonly session: Session;
  readonly sourceId: string;
  readonly expectedAt: string;
  readonly missingSince: string;
  readonly missingDrawCount: number;
  readonly sourceStatus: string;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly latestDrawDate: string | null;
  readonly retryAt: string | null;
  readonly refreshDue: boolean;
  readonly scheduleSource: string;
}

interface GapRow {
  source_id: string;
  game: GameCode;
  session: Session;
  draw_date: string;
  missing_draw_count: number;
  enabled: number | null;
  last_status: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  latest_draw_date: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
}

function officialDrawMinutes(game: GameCode, session: Session): number {
  if (game === "p3" || game === "d4" || game === "aon") {
    if (session === "") throw new RangeError(`${game} requires a result session`);
    return INTRADAY_DRAW_MINUTES[session];
  }
  if (session !== "") throw new RangeError(`${game} does not have intraday sessions`);
  return POOL_DRAW_MINUTES[game];
}

function isoDate(value: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`Invalid result-monitor draw date ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** Resolve a scheduled draw through America/Chicago, respecting winter/summer offsets. */
export function expectedResultDrawAt(game: GameCode, date: string, session: Session): Date {
  const midnight = isoDate(date);
  const minute = officialDrawMinutes(game, session);
  for (const offsetHours of [5, 6]) {
    const candidate = new Date(midnight.getTime() + (minute + offsetHours * 60) * 60_000);
    const clock = texasClock(candidate);
    if (clock.date === date && clock.hour * 60 + clock.minute === minute) return candidate;
  }
  throw new RangeError(
    `Could not resolve the official Texas draw time for ${game}/${date}/${session}`
  );
}

function validatedTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`Invalid source-monitor timestamp ${JSON.stringify(value)}`);
  return parsed;
}

/**
 * Read missing result identities, never infer a loss from a missing result.
 * The indexed query returns at most one aggregate per each of the 17 manifest sources;
 * it does not fetch the historical ledger into Worker memory or scan draw payloads.
 */
export async function readExpectedResultGaps(
  env: Env,
  now = new Date()
): Promise<readonly ExpectedResultGap[]> {
  const clock = texasClock(now);
  const yesterday = isoDate(clock.date);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const candidates = SOURCES.map((source) => ({
    sourceId: source.id,
    game: source.game,
    session: source.session,
    dueThrough:
      clock.hour * 60 + clock.minute >=
      officialDrawMinutes(source.game, source.session) + RESULT_PUBLICATION_GRACE_MINUTES
        ? clock.date
        : yesterday.toISOString().slice(0, 10),
    weekdayNumbers: officialDrawWeekdays(source.game).map((weekday) =>
      String(WEEKDAY_NUMBERS.indexOf(weekday))
    )
  }));
  const rows = await env.LOTTO_DB.prepare(
    `WITH expected_sources AS (
       SELECT json_extract(value, '$.sourceId') AS source_id,
              json_extract(value, '$.game') AS game,
              json_extract(value, '$.session') AS session,
              json_extract(value, '$.dueThrough') AS due_through,
              json_extract(value, '$.weekdayNumbers') AS weekdays
       FROM json_each(?1)
     )
     SELECT x.source_id, x.game, x.session, MIN(l.draw_date) AS draw_date,
            COUNT(DISTINCT l.draw_date) AS missing_draw_count,
            s.enabled, s.last_status, s.last_attempt_at, s.last_success_at,
            s.latest_draw_date, s.lease_token, s.lease_expires_at
     FROM expected_sources x
     JOIN lotto_game_config c ON c.game = x.game AND c.selected = 1
     JOIN lotto_ticket_ledger l ON l.game = x.game AND l.target_session = x.session
       AND l.draw_date <= x.due_through AND l.origin = 'system'
     JOIN lotto_ledger_eligibility_events e ON e.event_sequence = (
       SELECT event_sequence FROM lotto_ledger_eligibility_events
       WHERE ledger_id = l.ledger_id ORDER BY event_sequence DESC LIMIT 1
     )
     LEFT JOIN lotto_sources s ON s.source_id = x.source_id
     WHERE e.eligible = 1 AND e.reason_code <> 'schema-v7-attestation'
       AND EXISTS (SELECT 1 FROM json_each(x.weekdays) WHERE value = strftime('%w', l.draw_date))
       AND NOT EXISTS (
         SELECT 1 FROM lotto_draws d WHERE d.game = l.game AND d.draw_date = l.draw_date
           AND d.session = l.target_session AND d.source_id = x.source_id AND d.active = 1
       )
     GROUP BY x.source_id, x.game, x.session
     ORDER BY CASE WHEN s.last_attempt_at IS NULL THEN 0 ELSE 1 END,
              s.last_attempt_at ASC, x.source_id ASC
     LIMIT 17`
  )
    .bind(JSON.stringify(candidates))
    .all<GapRow>();
  return rows.results.map((row) => {
    const expectedAt = expectedResultDrawAt(row.game, row.draw_date, row.session);
    const lastAttempt = validatedTimestamp(row.last_attempt_at);
    const leaseEnd = row.lease_token ? validatedTimestamp(row.lease_expires_at) : null;
    const retryMilliseconds = Math.max(
      lastAttempt === null ? 0 : lastAttempt + RESULT_REFRESH_RETRY_MINUTES * 60_000,
      leaseEnd ?? 0
    );
    return {
      game: row.game,
      drawDate: row.draw_date,
      session: row.session,
      sourceId: row.source_id,
      expectedAt: expectedAt.toISOString(),
      missingSince: new Date(
        expectedAt.getTime() + RESULT_PUBLICATION_GRACE_MINUTES * 60_000
      ).toISOString(),
      missingDrawCount: row.missing_draw_count,
      sourceStatus: row.last_status ?? "unregistered",
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      latestDrawDate: row.latest_draw_date,
      retryAt: retryMilliseconds === 0 ? null : new Date(retryMilliseconds).toISOString(),
      refreshDue: row.enabled !== 0 && retryMilliseconds <= now.getTime(),
      scheduleSource: RESULT_SCHEDULE_SOURCES[row.game]
    };
  });
}

/**
 * Prioritize one overdue ledger source, atomically throttled for ten minutes even
 * when acquisition fails. The established ingester still owns its lease, retry,
 * provenance, parser quarantine, and grading hook. Errors propagate to operations.
 */
export async function refreshExpectedResult(
  env: Env,
  now = new Date()
): Promise<IngestOutcome | null> {
  const gaps = await readExpectedResultGaps(env, now);
  for (const gap of gaps) {
    if (!gap.refreshDue) continue;
    const source = getSource(gap.sourceId);
    if (gap.sourceStatus === "unregistered") {
      await env.LOTTO_DB.prepare(
        `INSERT OR IGNORE INTO lotto_sources (source_id, game, name, url, session, expected_widths, enabled)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)`
      )
        .bind(
          source.id,
          source.game,
          source.name,
          source.url,
          source.session,
          JSON.stringify(source.expectedWidths)
        )
        .run();
    }
    const claimed = await env.LOTTO_DB.prepare(
      `UPDATE lotto_sources SET last_attempt_at = ?1, updated_at = ?1
       WHERE source_id = ?2 AND enabled = 1
         AND (last_attempt_at IS NULL OR last_attempt_at <= ?3)
         AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?1)`
    )
      .bind(
        now.toISOString(),
        source.id,
        new Date(now.getTime() - RESULT_REFRESH_RETRY_MINUTES * 60_000).toISOString()
      )
      .run();
    if (claimed.meta.changes !== 1) continue;
    const outcome = await refreshSource(env, source.id);
    const unresolved = (await readExpectedResultGaps(env, now)).find(
      (item) => item.sourceId === source.id
    );
    console.log(
      JSON.stringify({
        service: "rabbitholetx",
        event: "expected_result_refresh",
        sourceId: source.id,
        requestedDrawDate: gap.drawDate,
        session: gap.session,
        stillMissing: unresolved !== undefined,
        missingDrawCount: unresolved?.missingDrawCount ?? 0,
        status: outcome.status,
        cacheFallback: outcome.cacheFallback
      })
    );
    if (outcome.cacheFallback && unresolved) {
      throw new Error(
        `Expected result ${source.id}/${gap.drawDate} is still missing: official download failed and cached data did not resolve it`
      );
    }
    return outcome;
  }
  return null;
}
