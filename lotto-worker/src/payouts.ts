import type { Env } from "./env";
import type { GameCode } from "./manifest";
import { appendGradeSettlement, refreshUnsentResultNotifications } from "./ticket-lab";

type PayoutGame = "lotto" | "twostep";
const ROOT = "https://www.texaslottery.com/export/sites/lottery/Games/";
const FOLDERS = { lotto: "Lotto_Texas", twostep: "Texas_Two_Step" } as const;
const NAMES = { lotto: "Lotto Texas", twostep: "Texas Two Step" } as const;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 8_000;
const RETRY_MS = 60 * 60 * 1_000;
const MAX_NETWORK_DRAWS_PER_RUN = 2;

interface PayoutSource {
  game: PayoutGame;
  draw_date: string;
  source_url: string | null;
  source_sha256: string | null;
  object_key: string | null;
  status: "pending" | "ready" | "retry" | "mismatch";
  next_attempt_at: string | null;
}

export interface VerifiedPayoutPage {
  readonly game: PayoutGame;
  readonly drawDate: string;
  readonly main: readonly number[];
  readonly bonus: readonly number[];
  readonly baseCents: Readonly<Record<string, number>>;
  readonly extraCents: Readonly<Record<string, number>>;
}

/** A layout or identity disagreement is never treated as a zero-dollar award. */
export class PayoutSchemaMismatch extends Error {
  override readonly name = "PayoutSchemaMismatch";
}

function supported(game: GameCode): game is PayoutGame {
  return game === "lotto" || game === "twostep";
}

function officialIndex(game: PayoutGame): string {
  return `${ROOT}${FOLDERS[game]}/Winning_Numbers/`;
}

function validDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new PayoutSchemaMismatch("Invalid payout draw date");
  }
  return `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;
}

function textContent(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function officialDetail(game: PayoutGame, value: string): string {
  const url = new URL(value, officialIndex(game));
  if (
    url.origin !== "https://www.texaslottery.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !new RegExp(
      `^/export/sites/lottery/Games/${FOLDERS[game]}/Winning_Numbers/details\\.html_\\d+\\.html$`
    ).test(url.pathname)
  ) {
    throw new PayoutSchemaMismatch("Payout detail link is not a dated official game resource");
  }
  return url.toString();
}

/** Resolve only the requested draw's published link; never crawl arbitrary links. */
export function resolveOfficialPayoutUrl(game: PayoutGame, drawDate: string, html: string): string {
  const date = validDate(drawDate);
  const links = [...html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .filter((match) => textContent(match[2] ?? "") === date)
    .map((match) => officialDetail(game, match[1] ?? ""));
  const unique = [...new Set(links)];
  if (unique.length !== 1)
    throw new PayoutSchemaMismatch(`No unique official payout link for ${game}/${drawDate}`);
  return unique[0] as string;
}

function money(value: string): number {
  if (!/^\$(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{2})?$/.test(value)) {
    throw new PayoutSchemaMismatch(`Unrecognized published prize amount: ${value}`);
  }
  const [whole, fraction = "00"] = value.slice(1).replaceAll(",", "").split(".");
  const cents = Number(BigInt(whole as string) * 100n + BigInt(fraction));
  if (!Number.isSafeInteger(cents) || cents <= 0)
    throw new PayoutSchemaMismatch("Published prize must be positive safe integer cents");
  return cents;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return [...left].sort((a, b) => a - b).join(",") === [...right].sort((a, b) => a - b).join(",");
}

/** Parse only audited game-specific markup and cross-check the ingested official draw. */
export function parseOfficialPayoutPage(
  game: PayoutGame,
  drawDate: string,
  main: readonly number[],
  bonus: readonly number[],
  html: string
): VerifiedPayoutPage {
  if (new TextEncoder().encode(html).byteLength > MAX_BYTES)
    throw new PayoutSchemaMismatch("Payout page exceeds size cap");
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const title = [...clean.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map((match) => textContent(match[1] ?? ""))
    .filter((value) => value.endsWith("Winning Numbers Details"));
  if (
    title.length !== 1 ||
    !title[0]?.startsWith(`${NAMES[game]}`) ||
    !title[0].endsWith("Winning Numbers Details")
  ) {
    throw new PayoutSchemaMismatch("Official payout game heading changed");
  }
  const headings = [
    ...clean.matchAll(
      /<h3\b[^>]*>\s*Winning Numbers for\s+(\d{2}\/\d{2}\/\d{4})\s+were:\s*<\/h3>/gi
    )
  ];
  if (headings.length !== 1 || headings[0]?.[1] !== validDate(drawDate))
    throw new PayoutSchemaMismatch("Official payout draw date does not match ledger");
  const balls = [
    ...clean.matchAll(/<ol\b[^>]*class=["']winningNumberBalls["'][^>]*>([\s\S]*?)<\/ol>/gi)
  ];
  if (balls.length !== 1) throw new PayoutSchemaMismatch("Winning-number layout changed");
  const cells = [...(balls[0]?.[1] ?? "").matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((match) =>
    textContent(match[1] ?? "")
  );
  if (cells.some((value) => !/^\d{1,2}$/.test(value)))
    throw new PayoutSchemaMismatch("Winning-number cells are malformed");
  const all = cells.map(Number);
  const actualMain = all.slice(0, game === "lotto" ? 6 : 4);
  const actualBonus = all.slice(game === "lotto" ? 6 : 4);
  if (
    all.length !== (game === "lotto" ? 6 : 5) ||
    new Set(actualMain).size !== actualMain.length ||
    actualMain.some((value) => value < 1 || value > (game === "lotto" ? 54 : 35)) ||
    actualBonus.some((value) => value < 1 || value > 35) ||
    !sameNumbers(actualMain, main) ||
    !sameNumbers(actualBonus, bonus)
  ) {
    throw new PayoutSchemaMismatch(
      "Published winning numbers disagree with the ingested official draw"
    );
  }
  const expectedHeaders =
    game === "lotto"
      ? [
          "Number Correct",
          "Prize Amount",
          "Total Winners",
          "Jackpot Option",
          "Total Prize w/Extra!",
          "Total Winners who chose Extra!"
        ]
      : ["Number Correct", "Prize Amount", "Winners"];
  const tables = [...clean.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
    .map((match) => match[1] ?? "")
    .filter(
      (table) =>
        [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
          .map((match) => textContent(match[1] ?? ""))
          .join("|") === expectedHeaders.join("|")
    );
  if (tables.length !== 1) throw new PayoutSchemaMismatch("Official prize table headers changed");
  const rows = [...(tables[0] ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) =>
    [...(match[1] ?? "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) =>
      textContent(cell[1] ?? "")
    )
  );
  const tiers: readonly [string, string][] =
    game === "lotto"
      ? [
          ["4 of 6", "lotto:4"],
          ["5 of 6", "lotto:5"]
        ]
      : [
          ["4 of 4", "twostep:4+0"],
          ["3 of 4 w/Bonus", "twostep:3+1"],
          ["3 of 4", "twostep:3+0"],
          ["2 of 4 w/Bonus", "twostep:2+1"]
        ];
  const baseCents: Record<string, number> = {};
  const extraCents: Record<string, number> = {};
  for (const [label, key] of tiers) {
    const matches = rows.filter((row) => row[0] === label);
    if (matches.length !== 1 || matches[0]?.length !== expectedHeaders.length)
      throw new PayoutSchemaMismatch(`Official tier ${label} layout changed`);
    const row = matches[0] as string[];
    if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(row[2] ?? ""))
      throw new PayoutSchemaMismatch(`Official tier ${label} winner count is not published`);
    // No winners may mean no realized per-ticket award; leave that tier pending.
    if (Number((row[2] ?? "").replaceAll(",", "")) === 0) continue;
    baseCents[key] = money(row[1] ?? "");
    if (game === "lotto") {
      extraCents[key] = money(row[4] ?? "");
      if (extraCents[key] !== baseCents[key] + (key === "lotto:4" ? 10_000 : 1_000_000))
        throw new PayoutSchemaMismatch("Lotto EXTRA prize does not reconcile with the base award");
    }
  }
  return { game, drawDate, main: actualMain, bonus: actualBonus, baseCents, extraCents };
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function boundedBody(body: ReadableStream<Uint8Array> | null): Promise<ArrayBuffer> {
  if (!body) throw new Error("Official payout response has no body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new PayoutSchemaMismatch("Official payout response exceeds size cap");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new Error("Official payout response is empty");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function download(url: string): Promise<ArrayBuffer> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort("Official payout request timed out"),
      TIMEOUT_MS
    );
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "text/html" }
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Official payout HTTP ${response.status}`);
      }
      if (
        !/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
          response.headers.get("content-type") ?? ""
        )
      ) {
        await response.body?.cancel();
        throw new PayoutSchemaMismatch("Official payout response is not HTML");
      }
      return await boundedBody(response.body);
    } catch (caught) {
      failure = caught;
      if (caught instanceof PayoutSchemaMismatch) throw caught;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  throw failure instanceof Error ? failure : new Error("Official payout acquisition failed");
}

async function state(env: Env, game: PayoutGame, drawDate: string): Promise<PayoutSource | null> {
  return env.LOTTO_DB.prepare(
    "SELECT * FROM lotto_payout_sources WHERE game = ?1 AND draw_date = ?2"
  )
    .bind(game, drawDate)
    .first<PayoutSource>();
}

function metadata(page: VerifiedPayoutPage, source: PayoutSource): Record<string, unknown> {
  return {
    official_payouts_certified: true,
    official_payouts_cents: page.baseCents,
    official_payouts_source: source.source_url,
    official_payouts_source_sha256: source.source_sha256
  };
}

async function cachedPage(
  env: Env,
  source: PayoutSource,
  main: readonly number[],
  bonus: readonly number[]
): Promise<VerifiedPayoutPage | null> {
  if (!source.object_key || !source.source_sha256 || !source.source_url) return null;
  officialDetail(source.game, source.source_url);
  const object = await env.LOTTO_RAW.get(source.object_key);
  if (!object) return null;
  if (object.size > MAX_BYTES) throw new PayoutSchemaMismatch("Cached payout exceeds size cap");
  const bytes = await boundedBody(object.body);
  if ((await digest(bytes)) !== source.source_sha256)
    throw new PayoutSchemaMismatch("Cached payout digest mismatch");
  return parseOfficialPayoutPage(
    source.game,
    source.draw_date,
    main,
    bonus,
    new TextDecoder().decode(bytes)
  );
}

/** Read verified historical evidence without issuing network requests. */
export async function readOfficialPayoutMetadata(
  env: Env,
  game: GameCode,
  drawDate: string,
  main: readonly number[],
  bonus: readonly number[] = []
): Promise<Record<string, unknown> | null> {
  if (!supported(game)) return null;
  const prior = await state(env, game, drawDate);
  if (!prior || prior.status !== "ready") return null;
  try {
    const page = await cachedPage(env, prior, main, bonus);
    return page ? metadata(page, prior) : null;
  } catch (caught) {
    if (!(caught instanceof PayoutSchemaMismatch)) throw caught;
    // An official draw correction invalidates old evidence. Cache-only readers
    // must leave the new grade pending, not block unrelated draws or reuse it.
    console.warn(
      JSON.stringify({
        service: "rabbitholetx",
        event: "official_payout_cache_invalid",
        game,
        drawDate,
        error: caught.message
      })
    );
    return null;
  }
}

/** Acquire a single requested draw; failures leave prizes pending and are observable. */
export async function ensureOfficialPayoutMetadata(
  env: Env,
  game: GameCode,
  drawDate: string,
  main: readonly number[],
  bonus: readonly number[] = [],
  now = new Date()
): Promise<Record<string, unknown> | null> {
  if (!supported(game)) return null;
  validDate(drawDate);
  const prior = await state(env, game, drawDate);
  if (prior?.status === "ready") {
    try {
      const page = await cachedPage(env, prior, main, bonus);
      if (page) return metadata(page, prior);
    } catch (caught) {
      // Reacquire the exact dated resource after a corrected draw or corrupted
      // cache; the fresh page still has to pass every identity/layout check.
      console.warn(
        JSON.stringify({
          service: "rabbitholetx",
          event: "official_payout_cache_refresh",
          game,
          drawDate,
          error: caught instanceof Error ? caught.message : String(caught)
        })
      );
    }
  }
  if (prior?.next_attempt_at && prior.next_attempt_at > now.toISOString())
    throw new Error(`Official payout retry deferred until ${prior.next_attempt_at}`);
  await env.LOTTO_DB.prepare(
    `INSERT INTO lotto_payout_sources (game, draw_date, last_attempt_at, status)
    VALUES (?1, ?2, ?3, 'pending') ON CONFLICT(game, draw_date) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`
  )
    .bind(game, drawDate, now.toISOString())
    .run();
  try {
    const sourceUrl = prior?.source_url
      ? officialDetail(game, prior.source_url)
      : resolveOfficialPayoutUrl(
          game,
          drawDate,
          new TextDecoder().decode(await download(officialIndex(game)))
        );
    const bytes = await download(sourceUrl);
    const page = parseOfficialPayoutPage(
      game,
      drawDate,
      main,
      bonus,
      new TextDecoder().decode(bytes)
    );
    const sha = await digest(bytes);
    const key = `official-payouts/${game}/${drawDate}/${sha}.html`;
    await env.LOTTO_RAW.put(key, bytes, {
      httpMetadata: { contentType: "text/html; charset=utf-8" }
    });
    await env.LOTTO_DB.prepare(
      `UPDATE lotto_payout_sources SET source_url = ?3, source_sha256 = ?4,
      object_key = ?5, last_success_at = ?6, status = 'ready', error = NULL, next_attempt_at = NULL
      WHERE game = ?1 AND draw_date = ?2`
    )
      .bind(game, drawDate, sourceUrl, sha, key, now.toISOString())
      .run();
    return metadata(page, {
      game,
      draw_date: drawDate,
      source_url: sourceUrl,
      source_sha256: sha,
      object_key: key,
      status: "ready",
      next_attempt_at: null
    });
  } catch (caught) {
    const error = (
      caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
    ).slice(0, 1_000);
    const status = caught instanceof PayoutSchemaMismatch ? "mismatch" : "retry";
    await env.LOTTO_DB.prepare(
      `UPDATE lotto_payout_sources SET status = ?3, error = ?4, next_attempt_at = ?5 WHERE game = ?1 AND draw_date = ?2`
    )
      .bind(game, drawDate, status, error, new Date(now.getTime() + RETRY_MS).toISOString())
      .run();
    console.error(
      JSON.stringify({
        service: "rabbitholetx",
        event: "official_payout_failed",
        game,
        drawDate,
        status,
        error
      })
    );
    throw caught;
  }
}

interface PendingPayout {
  game: PayoutGame;
  draw_date: string;
  ticket_grade_id: string;
  main_matches: number;
  bonus_matches: number;
  draw_fingerprint: string;
  result_main_numbers: string;
  result_bonus_numbers: string;
  grading_detail_json: string;
}

export interface PayoutReconciliation {
  readonly scanned: number;
  readonly settled: number;
  readonly skipped: number;
  readonly failed: number;
  readonly reports: readonly { game: GameCode; drawDate: string; status: string; error?: string }[];
}

/** Append non-jackpot settlements only; existing manual/automatic events always win. */
export async function reconcileOfficialPayouts(
  env: Env,
  game: GameCode | null = null,
  now = new Date()
): Promise<PayoutReconciliation> {
  const rows = await env.LOTTO_DB.prepare(
    `SELECT l.game, l.draw_date, t.ticket_grade_id, t.main_matches, t.bonus_matches,
      g.draw_fingerprint, g.result_main_numbers, g.result_bonus_numbers, t.grading_detail_json
    FROM lotto_ticket_grades t JOIN lotto_ledger_grades g ON g.grade_id = t.grade_id
    JOIN lotto_ticket_ledger l ON l.ledger_id = g.ledger_id
    JOIN lotto_draws d ON d.game = l.game AND d.draw_date = l.draw_date AND d.session = l.target_session AND d.active = 1
    WHERE (?1 IS NULL OR l.game = ?1) AND t.payout_status = 'pending'
      AND g.draw_fingerprint = d.content_fingerprint
      AND g.revision = (SELECT MAX(g2.revision) FROM lotto_ledger_grades g2 WHERE g2.ledger_id = l.ledger_id)
      AND ((l.game = 'lotto' AND t.main_matches IN (4,5)) OR (l.game = 'twostep' AND
        ((t.main_matches = 4 AND t.bonus_matches = 0) OR t.main_matches = 3 OR (t.main_matches = 2 AND t.bonus_matches = 1))))
      AND NOT EXISTS (SELECT 1 FROM lotto_grade_settlement_events s WHERE s.ticket_grade_id = t.ticket_grade_id)
      AND (SELECT CASE WHEN e.reason_code = 'schema-v7-attestation' THEN 0 ELSE e.eligible END
        FROM lotto_ledger_eligibility_events e WHERE e.ledger_id = l.ledger_id ORDER BY e.event_sequence DESC LIMIT 1) = 1
    ORDER BY l.draw_date DESC, l.game, t.ticket_grade_id LIMIT 256`
  )
    .bind(game)
    .all<PendingPayout>();
  let settled = 0;
  let skipped = 0;
  let failed = 0;
  const reports: { game: GameCode; drawDate: string; status: string; error?: string }[] = [];
  const groups = new Map<string, PendingPayout[]>();
  for (const row of rows.results) {
    const key = `${row.game}/${row.draw_date}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  let networkDraws = 0;
  for (const group of groups.values()) {
    const first = group[0] as PendingPayout;
    try {
      const main = JSON.parse(first.result_main_numbers) as number[];
      const bonus = JSON.parse(first.result_bonus_numbers) as number[];
      let official = await readOfficialPayoutMetadata(
        env,
        first.game,
        first.draw_date,
        main,
        bonus
      );
      if (!official) {
        const prior = await state(env, first.game, first.draw_date);
        if (
          networkDraws >= MAX_NETWORK_DRAWS_PER_RUN ||
          (prior?.next_attempt_at && prior.next_attempt_at > now.toISOString())
        ) {
          skipped += group.length;
          reports.push({ game: first.game, drawDate: first.draw_date, status: "deferred" });
          continue;
        }
        networkDraws += 1;
        official = await ensureOfficialPayoutMetadata(
          env,
          first.game,
          first.draw_date,
          main,
          bonus,
          now
        );
      }
      if (!official) {
        skipped += group.length;
        continue;
      }
      const payouts = official.official_payouts_cents as Record<string, number>;
      for (const row of group) {
        const detail = JSON.parse(row.grading_detail_json) as Record<string, unknown>;
        if (detail.settlementKind !== "official-payout") {
          skipped += 1;
          continue;
        }
        const key =
          row.game === "lotto"
            ? `lotto:${row.main_matches}`
            : `twostep:${row.main_matches}+${row.bonus_matches}`;
        const base = payouts[key];
        if (base === undefined) {
          skipped += 1;
          continue;
        }
        const extra =
          row.game === "lotto" && detail.extra === true
            ? row.main_matches === 4
              ? 10_000
              : 1_000_000
            : 0;
        const result = await appendGradeSettlement(
          env,
          row.ticket_grade_id,
          {
            idempotencyKey: `official-payout-v1-${row.ticket_grade_id}`,
            finalPrizeCents: base + extra,
            source: official.official_payouts_source,
            sourceSha256: official.official_payouts_source_sha256,
            note: `Automatically verified ${row.game}/${row.draw_date} lower-tier official payout; excludes jackpots.`
          },
          now,
          { expectedDrawFingerprint: row.draw_fingerprint }
        );
        if (result.created) settled += 1;
        else skipped += 1;
      }
      reports.push({ game: first.game, drawDate: first.draw_date, status: "ready" });
    } catch (caught) {
      failed += group.length;
      reports.push({
        game: first.game,
        drawDate: first.draw_date,
        status: "pending",
        error: (caught instanceof Error ? caught.message : String(caught)).slice(0, 1_000)
      });
    }
  }
  const result = { scanned: rows.results.length, settled, skipped, failed, reports };
  if (settled > 0) await refreshUnsentResultNotifications(env, game, now);
  if (rows.results.length)
    console.log(
      JSON.stringify({ service: "rabbitholetx", event: "official_payout_reconciled", ...result })
    );
  return result;
}
