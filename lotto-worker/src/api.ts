import type { Env } from "./env";
import {
  GAME_CODES,
  GAME_MANIFEST,
  SOURCES,
  isGameCode,
  publicManifest,
  type GameCode
} from "./manifest";

const API_PREFIX = "/api/lotto/v1";
const MAX_PAGE_SIZE = 200;
const SESSION_RANK_SQL =
  "CASE session WHEN 'night' THEN 4 WHEN 'evening' THEN 3 WHEN 'day' THEN 2 WHEN 'morning' THEN 1 ELSE 0 END";

interface SourceStatusRow {
  source_id: string;
  game: GameCode;
  name: string;
  session: string;
  last_success_at: string | null;
  last_status: string;
  active_count: number;
  latest_draw_date: string | null;
  consecutive_failures: number;
}

interface DrawRow {
  game: GameCode;
  draw_date: string;
  session: string;
  ordered_numbers: string;
  canonical_numbers: string;
  bonus_numbers: string;
  metadata: string;
  source_id: string;
  source_sha256: string;
  updated_at: string;
}

interface GameStatus {
  code: GameCode;
  name: string;
  sourceCount: number;
  readySources: number;
  activeDraws: number;
  observedThrough: string | null;
  lastSuccessAt: string | null;
  status: "fresh" | "stale" | "unavailable";
  sources: Array<{
    id: string;
    name: string;
    session: string;
    lastSuccessAt: string | null;
    latestDrawDate: string | null;
    activeCount: number;
    status: string;
  }>;
}

function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return null;
    if (["https://yevow.co", "https://www.yevow.co", "https://app.yevow.co"].includes(url.origin))
      return origin;
    if (
      url.port === "" &&
      (url.hostname === "sovereign-sigma-command-center.pages.dev" ||
        url.hostname.endsWith(".sovereign-sigma-command-center.pages.dev"))
    ) {
      return origin;
    }
  } catch {
    return null;
  }
  return null;
}

function baseHeaders(request: Request, cacheControl = "no-store"): Headers {
  const headers = new Headers({
    "Cache-Control": cacheControl,
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  headers.append("Vary", "Origin");
  const origin = allowedOrigin(request.headers.get("Origin"));
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Accept, Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

function json(
  request: Request,
  value: unknown,
  init: { status?: number; cacheControl?: string; etag?: string } = {}
): Response {
  const headers = baseHeaders(request, init.cacheControl);
  if (init.etag) headers.set("ETag", init.etag);
  return new Response(JSON.stringify(value), { status: init.status ?? 200, headers });
}

function error(request: Request, status: number, code: string, message: string): Response {
  return json(request, { schemaVersion: 1, error: { code, message } }, { status });
}

function isoDayInTexas(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function daysBetween(left: string, right: string): number {
  return Math.floor(
    (Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86_400_000
  );
}

function maximumFreshAge(game: GameCode): number {
  if (game === "lotto" || game === "pb") return 4;
  if (game === "twostep" || game === "mm") return 5;
  return 3;
}

async function statuses(database: D1Database): Promise<GameStatus[]> {
  const result = await database
    .prepare(
      `SELECT source_id, game, name, session, last_success_at, last_status,
              active_count, latest_draw_date, consecutive_failures
       FROM lotto_sources ORDER BY game, source_id`
    )
    .all<SourceStatusRow>();
  const rowsById = new Map(result.results.map((row) => [row.source_id, row]));
  const today = isoDayInTexas();

  return GAME_CODES.map((game) => {
    const configured = GAME_MANIFEST[game].sources;
    const sources = configured.map((source) => {
      const row = rowsById.get(source.id);
      return {
        id: source.id,
        name: source.name,
        session: source.session,
        lastSuccessAt: row?.last_success_at ?? null,
        latestDrawDate: row?.latest_draw_date ?? null,
        activeCount: row?.active_count ?? 0,
        status: row?.last_status ?? "never"
      };
    });
    const ready = sources.filter(
      (source) => source.activeCount > 0 && source.latestDrawDate !== null
    );
    const observedThrough =
      ready.length === configured.length
        ? ready.reduce<string | null>(
            (oldest, source) =>
              oldest === null || (source.latestDrawDate as string) < oldest
                ? source.latestDrawDate
                : oldest,
            null
          )
        : null;
    const successful = sources
      .map((source) => source.lastSuccessAt)
      .filter((value): value is string => value !== null)
      .sort();
    const healthyStates = sources.every((source) =>
      ["complete", "unchanged", "bootstrap"].includes(source.status)
    );
    const gameStatus: GameStatus["status"] =
      ready.length !== configured.length || observedThrough === null
        ? "unavailable"
        : !healthyStates || daysBetween(observedThrough, today) > maximumFreshAge(game)
          ? "stale"
          : "fresh";
    return {
      code: game,
      name: GAME_MANIFEST[game].name,
      sourceCount: configured.length,
      readySources: ready.length,
      activeDraws: sources.reduce((total, source) => total + source.activeCount, 0),
      observedThrough,
      lastSuccessAt: successful.at(-1) ?? null,
      status: gameStatus,
      sources
    };
  });
}

function decodeArray(value: string): readonly number[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => Number.isInteger(item))) {
    throw new Error("Stored draw array is invalid");
  }
  return parsed as number[];
}

function decodeMetadata(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored draw metadata is invalid");
  }
  return parsed as Record<string, unknown>;
}

function publicDraw(row: DrawRow): Record<string, unknown> {
  return {
    game: row.game,
    drawDate: row.draw_date,
    session: row.session,
    orderedNumbers: decodeArray(row.ordered_numbers),
    canonicalNumbers: decodeArray(row.canonical_numbers),
    bonusNumbers: decodeArray(row.bonus_numbers),
    metadata: decodeMetadata(row.metadata),
    provenance: {
      sourceId: row.source_id,
      sourceSha256: row.source_sha256,
      updatedAt: row.updated_at
    }
  };
}

function encodeCursor(drawDate: string, session: string): string {
  return btoa(`${drawDate}|${session}`)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function sessionRank(session: string): number {
  if (session === "night") return 4;
  if (session === "evening") return 3;
  if (session === "day") return 2;
  if (session === "morning") return 1;
  return 0;
}

function decodeCursor(value: string): { drawDate: string; session: string } {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new RangeError("cursor is malformed");
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw new RangeError("cursor is malformed");
  }
  const separator = decoded.indexOf("|");
  if (separator < 0) throw new RangeError("cursor is malformed");
  const drawDate = decoded.slice(0, separator);
  const session = decoded.slice(separator + 1);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(drawDate) ||
    !["", "morning", "day", "evening", "night"].includes(session)
  ) {
    throw new RangeError("cursor is malformed");
  }
  return { drawDate, session };
}

async function health(request: Request, env: Env): Promise<Response> {
  try {
    const schema = await env.LOTTO_DB.prepare(
      `SELECT value FROM schema_meta WHERE key = 'schema_version'`
    ).first<{ value: string }>();
    const counts = await env.LOTTO_DB.prepare(
      `SELECT COUNT(*) AS source_count,
              SUM(CASE WHEN last_digest IS NOT NULL AND active_count > 0 THEN 1 ELSE 0 END)
                AS ready_sources
       FROM lotto_sources WHERE enabled = 1`
    ).first<{ source_count: number; ready_sources: number }>();
    const registeredSources = Number(counts?.source_count ?? 0);
    const readySources = Number(counts?.ready_sources ?? 0);
    const ready =
      schema?.value === "4" &&
      registeredSources === SOURCES.length &&
      readySources === SOURCES.length;
    return json(
      request,
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        data: {
          status: ready ? "ok" : "degraded",
          databaseSchemaVersion: schema?.value ?? null,
          configuredSources: SOURCES.length,
          registeredSources,
          readySources
        }
      },
      { status: ready ? 200 : 503 }
    );
  } catch {
    return json(
      request,
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        data: { status: "unavailable" }
      },
      { status: 503 }
    );
  }
}

async function statusResponse(request: Request, env: Env): Promise<Response> {
  const games = await statuses(env.LOTTO_DB);
  const revision = games
    .map((game) => `${game.code}:${game.observedThrough ?? "none"}:${game.activeDraws}`)
    .join("|");
  return json(
    request,
    { schemaVersion: 1, generatedAt: new Date().toISOString(), data: { games } },
    {
      cacheControl: "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
      etag: `W/"${revision}"`
    }
  );
}

async function drawsResponse(
  request: Request,
  env: Env,
  game: GameCode,
  latestOnly: boolean
): Promise<Response> {
  const url = new URL(request.url);
  let limit = latestOnly ? 1 : 50;
  const rawLimit = url.searchParams.get("limit");
  if (!latestOnly && rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit))
      return error(request, 400, "invalid_limit", "limit must be an integer from 1 through 200");
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_PAGE_SIZE)
      return error(request, 400, "invalid_limit", "limit must be an integer from 1 through 200");
  }
  const rawCursor = latestOnly ? null : url.searchParams.get("cursor");
  let cursor: { drawDate: string; session: string } | null = null;
  if (rawCursor) {
    try {
      cursor = decodeCursor(rawCursor);
    } catch (cursorError) {
      return error(
        request,
        400,
        "invalid_cursor",
        cursorError instanceof Error ? cursorError.message : "cursor is malformed"
      );
    }
  }

  const selection = `SELECT game, draw_date, session, ordered_numbers, canonical_numbers,
                            bonus_numbers, metadata, source_id, source_sha256, updated_at
                     FROM lotto_draws
                     WHERE game = ?1 AND active = 1`;
  const query = cursor
    ? `${selection} AND (draw_date < ?2 OR (draw_date = ?2 AND ${SESSION_RANK_SQL} < ?3))
       ORDER BY draw_date DESC, ${SESSION_RANK_SQL} DESC LIMIT ?4`
    : `${selection} ORDER BY draw_date DESC, ${SESSION_RANK_SQL} DESC LIMIT ?2`;
  const statement = cursor
    ? env.LOTTO_DB.prepare(query).bind(
        game,
        cursor.drawDate,
        sessionRank(cursor.session),
        limit + 1
      )
    : env.LOTTO_DB.prepare(query).bind(game, limit + 1);
  const result = await statement.all<DrawRow>();
  const hasMore = result.results.length > limit;
  const selected = result.results.slice(0, limit);
  if (latestOnly && selected.length === 0)
    return error(request, 404, "no_draws", `No active draws are available for ${game}`);
  const last = selected.at(-1);
  return json(
    request,
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      data: {
        game,
        draws: selected.map(publicDraw),
        nextCursor: hasMore && last ? encodeCursor(last.draw_date, last.session) : null
      }
    },
    { cacheControl: "public, max-age=60, s-maxage=120, stale-while-revalidate=600" }
  );
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    const origin = request.headers.get("Origin");
    if (origin && !allowedOrigin(origin))
      return error(request, 403, "origin_denied", "Origin is not permitted");
    return new Response(null, { status: 204, headers: baseHeaders(request) });
  }
  if (request.method !== "GET")
    return error(request, 405, "method_not_allowed", "Only GET is supported");

  const pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  try {
    if (pathname === "/healthz" || pathname === `${API_PREFIX}/health`) return health(request, env);
    if (pathname === `${API_PREFIX}/manifest`) {
      return json(
        request,
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          data: { games: publicManifest() }
        },
        { cacheControl: "public, max-age=3600, s-maxage=86400", etag: 'W/"manifest-2026-09-03-v1"' }
      );
    }
    if (pathname === `${API_PREFIX}/status`) return statusResponse(request, env);
    if (pathname === `${API_PREFIX}/games`) {
      const gameStatuses = await statuses(env.LOTTO_DB);
      return json(
        request,
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          data: {
            games: publicManifest().map((game) => ({
              ...game,
              live: gameStatuses.find((status) => status.code === game.code)
            }))
          }
        },
        { cacheControl: "public, max-age=60, s-maxage=300" }
      );
    }

    const match = pathname.match(/^\/api\/lotto\/v1\/games\/([^/]+)\/(draws|latest)$/);
    if (match) {
      const game = match[1] ?? "";
      if (!isGameCode(game))
        return error(request, 404, "unknown_game", `Unknown lottery game ${JSON.stringify(game)}`);
      return drawsResponse(request, env, game, match[2] === "latest");
    }
    return error(request, 404, "not_found", "Route not found");
  } catch (caught) {
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    console.error(
      JSON.stringify({
        service: "rabbitholetx",
        event: "request_failed",
        requestId,
        path: pathname,
        error:
          caught instanceof Error
            ? `${caught.name}: ${caught.message}`.slice(0, 2_000)
            : String(caught)
      })
    );
    return json(
      request,
      { schemaVersion: 1, error: { code: "internal_error", message: "Request failed", requestId } },
      { status: 500 }
    );
  }
}
