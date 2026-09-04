import { isGameCode } from "./manifest";
import type { GameCode } from "./types";

export const DEFAULT_LOTTO_API_BASE = "https://lotto-api.yevow.co/api/lotto/v1";

export type LottoFreshness = "fresh" | "stale" | "unavailable";

export interface LottoSourceStatus {
  readonly id: string;
  readonly name: string;
  readonly session: string;
  readonly lastSuccessAt: string | null;
  readonly latestDrawDate: string | null;
  readonly activeCount: number;
  readonly status: string;
}

export interface LottoGameStatus {
  readonly code: GameCode;
  readonly name: string;
  readonly sourceCount: number;
  readonly readySources: number;
  readonly activeDraws: number;
  readonly observedThrough: string | null;
  readonly lastSuccessAt: string | null;
  readonly status: LottoFreshness;
  readonly sources: readonly LottoSourceStatus[];
}

export interface LottoStatusResponse {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly data: {
    readonly games: readonly LottoGameStatus[];
  };
}

export interface ReadLottoStatusOptions {
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

export class LottoStatusClientError extends Error {
  override readonly name = "LottoStatusClientError";

  constructor(
    message: string,
    readonly status: number | null = null
  ) {
    super(message);
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new LottoStatusClientError(`LOTTO status field ${key} must be a non-empty string.`);
  }
  return value;
}

function stringField(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new LottoStatusClientError(`LOTTO status field ${key} must be a string.`);
  }
  return value;
}

function nullableDateString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) {
    throw new LottoStatusClientError(`LOTTO status field ${key} must be a date string or null.`);
  }
  return value;
}

function nonNegativeInteger(record: JsonRecord, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LottoStatusClientError(
      `LOTTO status field ${key} must be a non-negative safe integer.`
    );
  }
  return value as number;
}

function parseSource(value: unknown): LottoSourceStatus {
  if (!isRecord(value)) {
    throw new LottoStatusClientError("Each LOTTO source status must be an object.");
  }

  return {
    id: requiredString(value, "id"),
    name: requiredString(value, "name"),
    session: stringField(value, "session"),
    lastSuccessAt: nullableDateString(value, "lastSuccessAt"),
    latestDrawDate: nullableDateString(value, "latestDrawDate"),
    activeCount: nonNegativeInteger(value, "activeCount"),
    status: requiredString(value, "status")
  };
}

function parseGame(value: unknown): LottoGameStatus {
  if (!isRecord(value)) {
    throw new LottoStatusClientError("Each LOTTO game status must be an object.");
  }

  const code = requiredString(value, "code");
  if (!isGameCode(code)) {
    throw new LottoStatusClientError(`Unknown LOTTO status game ${JSON.stringify(code)}.`);
  }

  const status = requiredString(value, "status");
  if (status !== "fresh" && status !== "stale" && status !== "unavailable") {
    throw new LottoStatusClientError(`Unknown LOTTO freshness state ${JSON.stringify(status)}.`);
  }

  const sourcesValue = value.sources;
  if (!Array.isArray(sourcesValue)) {
    throw new LottoStatusClientError("LOTTO game sources must be an array.");
  }
  const sources = sourcesValue.map(parseSource);
  const sourceCount = nonNegativeInteger(value, "sourceCount");
  const readySources = nonNegativeInteger(value, "readySources");
  if (sources.length !== sourceCount || readySources > sourceCount) {
    throw new LottoStatusClientError("LOTTO source counts do not reconcile.");
  }

  return {
    code,
    name: requiredString(value, "name"),
    sourceCount,
    readySources,
    activeDraws: nonNegativeInteger(value, "activeDraws"),
    observedThrough: nullableDateString(value, "observedThrough"),
    lastSuccessAt: nullableDateString(value, "lastSuccessAt"),
    status,
    sources
  };
}

export function parseLottoStatus(value: unknown): LottoStatusResponse {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.data)) {
    throw new LottoStatusClientError("LOTTO status response has an unsupported schema.");
  }
  const generatedAt = requiredString(value, "generatedAt");
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new LottoStatusClientError("LOTTO status generatedAt must be a valid date string.");
  }

  const gamesValue = value.data.games;
  if (!Array.isArray(gamesValue)) {
    throw new LottoStatusClientError("LOTTO status games must be an array.");
  }
  const games = gamesValue.map(parseGame);
  if (new Set(games.map(({ code }) => code)).size !== games.length) {
    throw new LottoStatusClientError("LOTTO status contains duplicate games.");
  }

  return { schemaVersion: 1, generatedAt, data: { games } };
}

export function normalizeLottoApiBase(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new LottoStatusClientError("LOTTO API base must be a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LottoStatusClientError("LOTTO API base must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function configuredLottoApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_LOTTO_API_BASE;
  if (!configured) return DEFAULT_LOTTO_API_BASE;
  try {
    return normalizeLottoApiBase(configured);
  } catch {
    return DEFAULT_LOTTO_API_BASE;
  }
}

export async function readLottoStatus(
  options: ReadLottoStatusOptions = {}
): Promise<LottoStatusResponse> {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = normalizeLottoApiBase(options.baseUrl ?? configuredLottoApiBase());
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/status`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-cache",
      signal: options.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new LottoStatusClientError("The live LOTTO archive could not be reached.");
  }

  if (!response.ok) {
    throw new LottoStatusClientError(
      `The live LOTTO archive returned HTTP ${response.status}.`,
      response.status
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new LottoStatusClientError("The live LOTTO archive returned invalid JSON.");
  }
  return parseLottoStatus(payload);
}
