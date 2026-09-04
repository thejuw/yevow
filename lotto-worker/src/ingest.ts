import type { Env } from "./env";
import { SOURCES, getSource, type ExportSource } from "./manifest";
import { parseOfficialCsv, SchemaMismatchError, type ParsedDraw } from "./parser";

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const UPSERT_CHUNK_SIZE = 500;
const PARSER_VERSION = 1;

interface SourceState {
  source_id: string;
  game: string;
  name: string;
  url: string;
  session: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_digest: string | null;
  last_object_key: string | null;
  last_status: string;
  row_count: number;
  active_count: number;
  latest_draw_date: string | null;
  consecutive_failures: number;
  last_parser_version: number;
}

interface ExistingDraw {
  game: string;
  draw_date: string;
  session: string;
  source_id: string;
  content_fingerprint: string;
  active: number;
}

interface Acquisition {
  readonly bytes: ArrayBuffer;
  readonly fromCache: boolean;
  readonly fetchError: string | null;
}

interface FailureContext {
  digest: string | null;
  objectKey: string | null;
  byteCount: number;
  cacheFallback: boolean;
}

class LeaseUnavailableError extends Error {
  override readonly name = "LeaseUnavailableError";
}

export interface IngestOutcome {
  readonly ingestionId: string;
  readonly sourceId: string;
  readonly status: "complete" | "unchanged";
  readonly digest: string;
  readonly parsed: number;
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly retired: number;
  readonly quarantined: number;
  readonly cacheFallback: boolean;
}

class DownloadError extends Error {
  override readonly name = "DownloadError";
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: "rabbitholetx", event, ...fields }));
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  description: string
): Promise<ArrayBuffer> {
  if (!stream) throw new DownloadError(`${description} has no response body`);
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        await reader.cancel(`${description} exceeds the ${MAX_SOURCE_BYTES}-byte cap`);
        throw new DownloadError(`${description} exceeds the ${MAX_SOURCE_BYTES}-byte cap`);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new DownloadError(`${description} is empty`);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined.buffer;
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 2_000);
}

function boundedIssue(issue: { sourceLine: number; rawRecord: string; reason: string }): {
  sourceLine: number;
  rawRecord: string;
  reason: string;
} {
  return {
    sourceLine: issue.sourceLine,
    rawRecord: issue.rawRecord.slice(0, 8_192),
    reason: issue.reason.slice(0, 2_000)
  };
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function decode(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

async function registerSources(database: D1Database): Promise<void> {
  const configured = SOURCES.map((source) => ({
    id: source.id,
    game: source.game,
    name: source.name,
    url: source.url,
    session: source.session,
    expectedWidths: source.expectedWidths
  }));
  await database.batch([
    database
      .prepare(
        `UPDATE lotto_sources SET enabled = 0, updated_at = CURRENT_TIMESTAMP
         WHERE enabled <> 0
           AND source_id NOT IN (SELECT value FROM json_each(?1))`
      )
      .bind(JSON.stringify(SOURCES.map((source) => source.id))),
    database
      .prepare(
        `INSERT INTO lotto_sources
          (source_id, game, name, url, session, expected_widths, enabled)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.game'),
                json_extract(value, '$.name'), json_extract(value, '$.url'),
                json_extract(value, '$.session'), json_extract(value, '$.expectedWidths'), 1
         FROM json_each(?1)
         WHERE 1
         ON CONFLICT(source_id) DO UPDATE SET
           game = excluded.game,
           name = excluded.name,
           url = excluded.url,
           session = excluded.session,
           expected_widths = excluded.expected_widths,
           enabled = 1,
           updated_at = CURRENT_TIMESTAMP
         WHERE lotto_sources.game <> excluded.game
            OR lotto_sources.name <> excluded.name
            OR lotto_sources.url <> excluded.url
            OR lotto_sources.session <> excluded.session
            OR lotto_sources.expected_widths <> excluded.expected_widths
            OR lotto_sources.enabled <> 1`
      )
      .bind(JSON.stringify(configured))
  ]);
}

async function acquire(env: Env, source: ExportSource, state: SourceState): Promise<Acquisition> {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(source.url, {
        headers: { Accept: "text/csv,text/plain;q=0.9,*/*;q=0.1" },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new DownloadError(`official export returned HTTP ${response.status}`);
      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_SOURCE_BYTES) {
        throw new DownloadError(`official export exceeds the ${MAX_SOURCE_BYTES}-byte cap`);
      }
      const bytes = await readBoundedStream(response.body, "official export");
      return { bytes, fromCache: false, fetchError: null };
    } catch (error) {
      failures.push(`attempt ${attempt}: ${boundedMessage(error)}`);
      if (attempt < 3) await delay(250 * 3 ** (attempt - 1));
    }
  }

  if (state.last_object_key) {
    const cached = await env.LOTTO_RAW.get(state.last_object_key);
    if (cached) {
      const expectedKey = state.last_digest
        ? `raw/${source.game}/${source.name}/${state.last_digest}.csv`
        : null;
      if (!expectedKey || state.last_object_key !== expectedKey) {
        throw new DownloadError("validated R2 pointer is inconsistent with its stored digest");
      }
      if (cached.size <= 0 || cached.size > MAX_SOURCE_BYTES) {
        throw new DownloadError("validated R2 fallback has an invalid byte length");
      }
      const metadataDigest = cached.customMetadata?.sha256;
      if (metadataDigest && metadataDigest !== state.last_digest) {
        throw new DownloadError("validated R2 fallback metadata digest does not match D1");
      }
      const bytes = await readBoundedStream(cached.body, "validated R2 fallback");
      return { bytes, fromCache: true, fetchError: failures.join("; ") };
    }
  }
  throw new DownloadError(
    `download failed and no validated R2 fallback exists: ${failures.join("; ")}`
  );
}

async function putRaw(
  env: Env,
  source: ExportSource,
  digest: string,
  bytes: ArrayBuffer,
  fetchedAt: string
): Promise<string> {
  const key = `raw/${source.game}/${source.name}/${digest}.csv`;
  const existing = await env.LOTTO_RAW.head(key);
  if (!existing || existing.customMetadata?.sha256 !== digest) {
    await env.LOTTO_RAW.put(key, bytes, {
      httpMetadata: { contentType: "text/csv; charset=utf-8" },
      customMetadata: {
        game: source.game,
        sourceId: source.id,
        sourceUrl: source.url,
        fetchedAt,
        sha256: digest,
        schemaVersion: "1",
        parserVersion: "1"
      },
      sha256: digest
    });
  }
  return key;
}

async function finishFailure(
  env: Env,
  ingestionId: string,
  source: ExportSource,
  error: unknown,
  context: FailureContext
): Promise<void> {
  const now = new Date().toISOString();
  const message = boundedMessage(error);
  const issues = error instanceof SchemaMismatchError ? error.issues : [];
  const statements: D1PreparedStatement[] = [];
  for (const issueChunk of chunks(issues.map(boundedIssue), 250)) {
    statements.push(
      env.LOTTO_DB.prepare(
        `INSERT INTO lotto_quarantine
          (ingestion_id, source_id, game, source_line, raw_record, reason, created_at)
         SELECT ?1, ?2, ?3, json_extract(value, '$.sourceLine'),
                json_extract(value, '$.rawRecord'), json_extract(value, '$.reason'), ?4
         FROM json_each(?5)`
      ).bind(ingestionId, source.id, source.game, now, JSON.stringify(issueChunk))
    );
  }
  statements.push(
    env.LOTTO_DB.prepare(
      `UPDATE lotto_ingestions
       SET completed_at = ?1, status = 'failed', error = ?2,
           digest = ?3, object_key = ?4, byte_count = ?5,
           cache_fallback = ?6, quarantined = ?7
       WHERE ingestion_id = ?8`
    ).bind(
      now,
      message,
      context.digest,
      context.objectKey,
      context.byteCount,
      context.cacheFallback ? 1 : 0,
      issues.length,
      ingestionId
    ),
    env.LOTTO_DB.prepare(
      `UPDATE lotto_sources
       SET last_status = 'failed', last_error = ?1,
           consecutive_failures = consecutive_failures + 1,
           lease_token = NULL, lease_expires_at = NULL, updated_at = ?2
       WHERE source_id = ?3 AND lease_token = ?4`
    ).bind(message, now, source.id, ingestionId)
  );
  await env.LOTTO_DB.batch(statements);
  log("ingest_failed", { ingestionId, sourceId: source.id, error: message });
}

function serializedDraw(
  candidate: ParsedDraw,
  source: ExportSource,
  digest: string,
  ingestionId: string,
  now: string
): Record<string, unknown> {
  return {
    game: candidate.game,
    drawDate: candidate.drawDate,
    session: candidate.session,
    orderedNumbers: candidate.orderedNumbers,
    canonicalNumbers: candidate.canonicalNumbers,
    bonusNumbers: candidate.bonusNumbers,
    metadata: candidate.metadata,
    fingerprint: candidate.fingerprint,
    sourceId: source.id,
    sourceUrl: source.url,
    sourceSha256: digest,
    sourceLine: candidate.sourceLine,
    rawRecord: candidate.rawRecord,
    ingestionId,
    now
  };
}

function drawStatements(
  database: D1Database,
  draws: readonly ParsedDraw[],
  source: ExportSource,
  digest: string,
  ingestionId: string,
  now: string
): D1PreparedStatement[] {
  const sql = `INSERT INTO lotto_draws (
      game, draw_date, session, ordered_numbers, canonical_numbers, bonus_numbers,
      metadata, content_fingerprint, source_id, source_url, source_sha256,
      source_line, raw_record, seen_ingestion_id, active, first_seen_at, updated_at, retired_at
    )
    SELECT
      json_extract(value, '$.game'), json_extract(value, '$.drawDate'),
      json_extract(value, '$.session'), json_extract(value, '$.orderedNumbers'),
      json_extract(value, '$.canonicalNumbers'), json_extract(value, '$.bonusNumbers'),
      json_extract(value, '$.metadata'), json_extract(value, '$.fingerprint'),
      json_extract(value, '$.sourceId'), json_extract(value, '$.sourceUrl'),
      json_extract(value, '$.sourceSha256'), json_extract(value, '$.sourceLine'),
      json_extract(value, '$.rawRecord'), json_extract(value, '$.ingestionId'),
      1, json_extract(value, '$.now'), json_extract(value, '$.now'), NULL
    FROM json_each(?1)
    WHERE EXISTS (
      SELECT 1 FROM lotto_sources
      WHERE source_id = ?2 AND lease_token = ?3 AND lease_expires_at > ?4
    )
    ON CONFLICT(game, draw_date, session) DO UPDATE SET
      ordered_numbers = excluded.ordered_numbers,
      canonical_numbers = excluded.canonical_numbers,
      bonus_numbers = excluded.bonus_numbers,
      metadata = excluded.metadata,
      content_fingerprint = excluded.content_fingerprint,
      source_id = excluded.source_id,
      source_url = excluded.source_url,
      source_sha256 = excluded.source_sha256,
      source_line = excluded.source_line,
      raw_record = excluded.raw_record,
      seen_ingestion_id = excluded.seen_ingestion_id,
      active = 1,
      updated_at = excluded.updated_at,
      retired_at = NULL`;

  return chunks(draws, UPSERT_CHUNK_SIZE).map((chunk) => {
    const payload = chunk.map((candidate) =>
      serializedDraw(candidate, source, digest, ingestionId, now)
    );
    return database.prepare(sql).bind(JSON.stringify(payload), source.id, ingestionId, now);
  });
}

function quarantineStatement(
  database: D1Database,
  ingestionId: string,
  source: ExportSource,
  issues: readonly { sourceLine: number; rawRecord: string; reason: string }[],
  now: string
): D1PreparedStatement | null {
  if (issues.length === 0) return null;
  const payload = issues.map(boundedIssue).map((issue) => ({
    ingestionId,
    sourceId: source.id,
    game: source.game,
    sourceLine: issue.sourceLine,
    rawRecord: issue.rawRecord,
    reason: issue.reason,
    now
  }));
  return database
    .prepare(
      `INSERT INTO lotto_quarantine
        (ingestion_id, source_id, game, source_line, raw_record, reason, created_at)
       SELECT json_extract(value, '$.ingestionId'), json_extract(value, '$.sourceId'),
              json_extract(value, '$.game'), json_extract(value, '$.sourceLine'),
              json_extract(value, '$.rawRecord'), json_extract(value, '$.reason'),
              json_extract(value, '$.now')
       FROM json_each(?1)
       WHERE EXISTS (
         SELECT 1 FROM lotto_sources
         WHERE source_id = ?2 AND lease_token = ?3 AND lease_expires_at > ?4
       )`
    )
    .bind(JSON.stringify(payload), source.id, ingestionId, now);
}

function guardCompleteness(
  source: ExportSource,
  candidates: readonly ParsedDraw[],
  existing: readonly ExistingDraw[]
): ExistingDraw[] {
  const active = existing.filter((row) => row.active === 1);
  if (active.length === 0) return [];
  const candidateDates = new Set(candidates.map((candidate) => candidate.drawDate));
  const missing = active.filter((row) => !candidateDates.has(row.draw_date));
  const storedLatest = active.reduce(
    (latest, row) => (row.draw_date > latest ? row.draw_date : latest),
    ""
  );
  const candidateLatest = candidates.reduce(
    (latest, row) => (row.drawDate > latest ? row.drawDate : latest),
    ""
  );
  if (candidateLatest < storedLatest) {
    throw new SchemaMismatchError(
      `Schema mismatch for ${source.id}: latest draw regressed from ${storedLatest} to ${candidateLatest}`
    );
  }
  const allowedMissing = Math.max(4, Math.floor(active.length / 200));
  if (missing.length > allowedMissing) {
    throw new SchemaMismatchError(
      `Schema mismatch for ${source.id}: candidate omits ${missing.length} of ${active.length} ` +
        `stored draws (maximum tolerated ${allowedMissing}); possible truncated export`
    );
  }
  return missing;
}

async function ingestChanged(
  env: Env,
  state: SourceState,
  source: ExportSource,
  ingestionId: string,
  acquisition: Acquisition,
  digest: string,
  objectKey: string,
  startedAt: string
): Promise<IngestOutcome> {
  const parsed = parseOfficialCsv(decode(acquisition.bytes), source);
  const existingResult = await env.LOTTO_DB.prepare(
    `SELECT game, draw_date, session, source_id, content_fingerprint, active
     FROM lotto_draws WHERE source_id = ?1`
  )
    .bind(source.id)
    .all<ExistingDraw>();
  const existing = existingResult.results;
  const missing = guardCompleteness(source, parsed.draws, existing);

  const byIdentity = new Map(
    existing.map((row) => [`${row.game}|${row.draw_date}|${row.session}`, row])
  );
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let reactivated = 0;
  const changed: ParsedDraw[] = [];
  for (const candidate of parsed.draws) {
    const prior = byIdentity.get(`${candidate.game}|${candidate.drawDate}|${candidate.session}`);
    if (!prior) {
      inserted += 1;
      changed.push(candidate);
    } else if (prior.source_id !== source.id) {
      throw new SchemaMismatchError(
        `Natural key ${candidate.game}/${candidate.drawDate}/${candidate.session} belongs to another source`
      );
    } else if (prior.active === 1 && prior.content_fingerprint === candidate.fingerprint)
      unchanged += 1;
    else {
      updated += 1;
      if (prior.active !== 1) reactivated += 1;
      changed.push(candidate);
    }
  }

  const completedAt = new Date().toISOString();
  const sourceStatus = parsed.issues.length > 0 ? "complete-with-quarantine" : "complete";
  const existingActive = existing.filter((row) => row.active === 1);
  const candidateLatest = parsed.draws.reduce(
    (latest, candidate) => (candidate.drawDate > latest ? candidate.drawDate : latest),
    ""
  );
  const existingLatest = existingActive.reduce(
    (latest, row) => (row.draw_date > latest ? row.draw_date : latest),
    ""
  );
  const finalActiveCount =
    parsed.issues.length === 0
      ? parsed.draws.length
      : existingActive.length + inserted + reactivated;
  const finalLatestDate =
    parsed.issues.length === 0
      ? candidateLatest
      : candidateLatest > existingLatest
        ? candidateLatest
        : existingLatest;
  const retired = parsed.issues.length === 0 ? missing.length : 0;
  const statements = drawStatements(
    env.LOTTO_DB,
    changed,
    source,
    digest,
    ingestionId,
    completedAt
  );
  const quarantine = quarantineStatement(
    env.LOTTO_DB,
    ingestionId,
    source,
    parsed.issues,
    completedAt
  );
  if (quarantine) statements.push(quarantine);
  if (retired > 0) {
    statements.push(
      env.LOTTO_DB.prepare(
        `UPDATE lotto_draws
         SET active = 0, retired_at = ?1, updated_at = ?1
         WHERE source_id = ?2 AND active = 1
           AND EXISTS (
             SELECT 1 FROM json_each(?3)
             WHERE json_extract(value, '$.drawDate') = lotto_draws.draw_date
               AND json_extract(value, '$.session') = lotto_draws.session
           )
           AND EXISTS (
             SELECT 1 FROM lotto_sources
             WHERE source_id = ?2 AND lease_token = ?4 AND lease_expires_at > ?1
           )`
      ).bind(
        completedAt,
        source.id,
        JSON.stringify(missing.map((row) => ({ drawDate: row.draw_date, session: row.session }))),
        ingestionId
      )
    );
  }
  statements.push(
    env.LOTTO_DB.prepare(
      `UPDATE lotto_ingestions SET
         completed_at = ?1, status = 'complete', digest = ?2, object_key = ?3,
         byte_count = ?4, total_rows = ?5, parsed = ?6, inserted = ?7,
         updated = ?8, unchanged = ?9, retired = ?10, quarantined = ?11,
         cache_fallback = ?12, error = ?13
       WHERE ingestion_id = ?14
         AND EXISTS (
           SELECT 1 FROM lotto_sources
           WHERE source_id = ?15 AND lease_token = ?16 AND lease_expires_at > ?1
         )`
    ).bind(
      completedAt,
      digest,
      objectKey,
      acquisition.bytes.byteLength,
      parsed.totalRows,
      parsed.draws.length,
      inserted,
      updated,
      unchanged,
      retired,
      parsed.issues.length,
      acquisition.fromCache ? 1 : 0,
      acquisition.fetchError,
      ingestionId,
      source.id,
      ingestionId
    ),
    env.LOTTO_DB.prepare(
      `UPDATE lotto_sources SET
         last_success_at = CASE WHEN ?1 = 0 THEN ?2 ELSE last_success_at END,
         last_digest = ?3, last_object_key = ?4, last_error = ?5, last_status = ?6,
         row_count = ?7, active_count = ?8, latest_draw_date = ?9,
         last_parser_version = ?10,
         consecutive_failures = CASE WHEN ?1 = 0 THEN 0 ELSE consecutive_failures + 1 END,
         lease_token = NULL, lease_expires_at = NULL, updated_at = ?2
       WHERE source_id = ?11 AND lease_token = ?12 AND lease_expires_at > ?2`
    ).bind(
      acquisition.fromCache ? 1 : 0,
      completedAt,
      digest,
      objectKey,
      acquisition.fetchError,
      acquisition.fromCache ? "cache-fallback" : sourceStatus,
      parsed.totalRows,
      finalActiveCount,
      finalLatestDate,
      PARSER_VERSION,
      source.id,
      ingestionId
    )
  );
  const results = await env.LOTTO_DB.batch(statements);
  if ((results.at(-1)?.meta.changes ?? 0) !== 1) {
    throw new LeaseUnavailableError(`Source lease was lost before ${source.id} could publish`);
  }
  return {
    ingestionId,
    sourceId: source.id,
    status: "complete",
    digest,
    parsed: parsed.draws.length,
    inserted,
    updated,
    unchanged,
    retired,
    quarantined: parsed.issues.length,
    cacheFallback: acquisition.fromCache
  };
}

async function markUnchanged(
  env: Env,
  state: SourceState,
  source: ExportSource,
  ingestionId: string,
  acquisition: Acquisition,
  digest: string,
  objectKey: string
): Promise<IngestOutcome> {
  const completedAt = new Date().toISOString();
  const sourceStatus = acquisition.fromCache
    ? "cache-fallback"
    : state.last_status === "complete-with-quarantine"
      ? "complete-with-quarantine"
      : "complete";
  const results = await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare(
      `UPDATE lotto_ingestions SET
         completed_at = ?1, status = 'unchanged', digest = ?2, object_key = ?3,
         byte_count = ?4, total_rows = ?5, parsed = ?6, unchanged = ?6,
         cache_fallback = ?7, error = ?8
       WHERE ingestion_id = ?9
         AND EXISTS (
           SELECT 1 FROM lotto_sources
           WHERE source_id = ?10 AND lease_token = ?11 AND lease_expires_at > ?1
         )`
    ).bind(
      completedAt,
      digest,
      objectKey,
      acquisition.bytes.byteLength,
      state.row_count,
      state.active_count,
      acquisition.fromCache ? 1 : 0,
      acquisition.fetchError,
      ingestionId,
      source.id,
      ingestionId
    ),
    env.LOTTO_DB.prepare(
      `UPDATE lotto_sources SET
         last_success_at = CASE WHEN ?1 = 0 THEN ?2 ELSE last_success_at END,
         last_error = ?3, last_status = ?4,
         consecutive_failures = CASE WHEN ?1 = 0 THEN 0 ELSE consecutive_failures + 1 END,
         lease_token = NULL, lease_expires_at = NULL, updated_at = ?2
       WHERE source_id = ?5 AND lease_token = ?6 AND lease_expires_at > ?2`
    ).bind(
      acquisition.fromCache ? 1 : 0,
      completedAt,
      acquisition.fetchError,
      sourceStatus,
      source.id,
      ingestionId
    )
  ]);
  if ((results.at(-1)?.meta.changes ?? 0) !== 1) {
    throw new LeaseUnavailableError(`Source lease was lost before ${source.id} could publish`);
  }
  return {
    ingestionId,
    sourceId: source.id,
    status: "unchanged",
    digest,
    parsed: state.active_count,
    inserted: 0,
    updated: 0,
    unchanged: state.active_count,
    retired: 0,
    quarantined: 0,
    cacheFallback: acquisition.fromCache
  };
}

export async function refreshSource(
  env: Env,
  sourceId: string,
  triggerKind: "scheduled" | "test" = "scheduled"
): Promise<IngestOutcome> {
  await registerSources(env.LOTTO_DB);
  const source = getSource(sourceId);
  const ingestionId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const startResults = await env.LOTTO_DB.batch([
    env.LOTTO_DB.prepare(
      `UPDATE lotto_sources
       SET lease_token = ?1, lease_expires_at = ?2, last_attempt_at = ?3,
           updated_at = ?3
       WHERE source_id = ?4 AND enabled = 1
         AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?3)`
    ).bind(ingestionId, leaseExpiresAt, startedAt, source.id),
    env.LOTTO_DB.prepare(
      `INSERT INTO lotto_ingestions
        (ingestion_id, source_id, game, trigger_kind, started_at, status)
       SELECT ?1, ?2, ?3, ?4, ?5, 'running'
       WHERE EXISTS (
         SELECT 1 FROM lotto_sources WHERE source_id = ?2 AND lease_token = ?1
       )`
    ).bind(ingestionId, source.id, source.game, triggerKind, startedAt)
  ]);
  if ((startResults[0]?.meta.changes ?? 0) !== 1 || (startResults[1]?.meta.changes ?? 0) !== 1) {
    throw new LeaseUnavailableError(`Source ${source.id} is already being refreshed`);
  }

  const failureContext: FailureContext = {
    digest: null,
    objectKey: null,
    byteCount: 0,
    cacheFallback: false
  };
  try {
    const state = await env.LOTTO_DB.prepare(`SELECT * FROM lotto_sources WHERE source_id = ?1`)
      .bind(source.id)
      .first<SourceState>();
    if (!state) throw new Error(`Source registration failed for ${source.id}`);
    const acquisition = await acquire(env, source, state);
    failureContext.byteCount = acquisition.bytes.byteLength;
    failureContext.cacheFallback = acquisition.fromCache;
    const digest = await sha256(acquisition.bytes);
    failureContext.digest = digest;
    if (acquisition.fromCache && digest !== state.last_digest) {
      throw new DownloadError("validated R2 fallback content digest does not match D1");
    }
    const objectKey = acquisition.fromCache
      ? (state.last_object_key as string)
      : await putRaw(env, source, digest, acquisition.bytes, startedAt);
    failureContext.objectKey = objectKey;
    const outcome =
      state.last_digest === digest &&
      state.last_object_key !== null &&
      state.last_parser_version === PARSER_VERSION
        ? await markUnchanged(env, state, source, ingestionId, acquisition, digest, objectKey)
        : await ingestChanged(
            env,
            state,
            source,
            ingestionId,
            acquisition,
            digest,
            objectKey,
            startedAt
          );
    log("ingest_complete", outcome as unknown as Record<string, unknown>);
    return outcome;
  } catch (error) {
    await finishFailure(env, ingestionId, source, error, failureContext);
    throw error;
  }
}

export async function refreshNextSource(env: Env): Promise<IngestOutcome> {
  await registerSources(env.LOTTO_DB);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = new Date().toISOString();
    const next = await env.LOTTO_DB.prepare(
      `SELECT source_id FROM lotto_sources
       WHERE enabled = 1
         AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?1)
       ORDER BY CASE WHEN last_attempt_at IS NULL THEN 0 ELSE 1 END,
                last_attempt_at ASC, source_id ASC
       LIMIT 1`
    )
      .bind(now)
      .first<{ source_id: string }>();
    if (!next)
      throw new LeaseUnavailableError("Every lottery source currently has an active lease");
    try {
      return await refreshSource(env, next.source_id, "scheduled");
    } catch (error) {
      if (!(error instanceof LeaseUnavailableError)) throw error;
    }
  }
  throw new LeaseUnavailableError("Could not claim a lottery source after three attempts");
}
