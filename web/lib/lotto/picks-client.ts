import { GAME_MANIFEST, isGameCode } from "./manifest";
import { possiblePairCount } from "./coverage";
import type { DigitPlayStyle, GameCode } from "./types";
import { configuredLottoApiBase, normalizeLottoApiBase } from "./status-client";

export type LottoDrawSlot = "daily" | "morning";
export type LottoSplitRiskLevel = "low" | "moderate" | "high";

export interface LottoPersistedTicket {
  readonly ordinal: number;
  readonly main: readonly number[];
  readonly bonus: readonly number[];
  readonly playStyle: DigitPlayStyle;
  readonly splitRiskScore: number;
  readonly splitRiskLevel: LottoSplitRiskLevel;
  readonly splitRiskNotes: readonly string[];
}

export interface LottoPersistedGenerationRun {
  readonly runId: string;
  readonly game: GameCode;
  readonly gameName: string;
  readonly drawDate: string;
  readonly drawSlot: LottoDrawSlot;
  readonly scheduledFor: string;
  readonly generatedAt: string;
  readonly seed: string;
  readonly observedThrough: string;
  readonly datasetDigest: string;
  readonly coverage: {
    readonly distinctPairs: number;
    readonly possiblePairs: number;
    readonly coveragePercent: number;
  };
  readonly ev: {
    readonly netCentsPerTicket: number;
    readonly assumption: string;
  };
  readonly tickets: readonly LottoPersistedTicket[];
  readonly generationLogUrl: string;
  readonly disclaimer: string;
}

export interface LottoDailyPicksResponse {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly data: {
    readonly drawDate: string;
    readonly runs: readonly LottoPersistedGenerationRun[];
  };
}

export interface ReadLottoDailyPicksOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

export class LottoPicksClientError extends Error {
  override readonly name = "LottoPicksClientError";

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

function requiredString(record: JsonRecord, key: string, maxLength = 2_000): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new LottoPicksClientError(
      `Daily-picks field ${key} must be a non-empty string of at most ${maxLength} characters.`
    );
  }
  return value;
}

function finiteNumber(record: JsonRecord, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LottoPicksClientError(`Daily-picks field ${key} must be a finite number.`);
  }
  return value;
}

function safeInteger(record: JsonRecord, key: string, minimum = 0): number {
  const value = finiteNumber(record, key);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new LottoPicksClientError(
      `Daily-picks field ${key} must be a safe integer greater than or equal to ${minimum}.`
    );
  }
  return value;
}

function dateOnly(record: JsonRecord, key: string): string {
  const value = requiredString(record, key, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new LottoPicksClientError(`Daily-picks field ${key} must be an ISO calendar date.`);
  }
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new LottoPicksClientError(`Daily-picks field ${key} is not a valid calendar date.`);
  }
  return value;
}

function dateTime(record: JsonRecord, key: string): string {
  const value = requiredString(record, key, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new LottoPicksClientError(`Daily-picks field ${key} must be an ISO date-time.`);
  }
  return value;
}

function numberArray(record: JsonRecord, key: string): readonly number[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => Number.isSafeInteger(item))) {
    throw new LottoPicksClientError(`Daily-picks field ${key} must be an integer array.`);
  }
  return value as number[];
}

function stringArray(record: JsonRecord, key: string): readonly string[] {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    !value.every((item) => typeof item === "string" && item.trim() !== "" && item.length <= 500)
  ) {
    throw new LottoPicksClientError(
      `Daily-picks field ${key} must be an array of short, non-empty strings.`
    );
  }
  return value as string[];
}

function assertPool(
  values: readonly number[],
  rule: {
    readonly count: number;
    readonly min: number;
    readonly max: number;
    readonly allowDuplicates: boolean;
  },
  field: string
): void {
  if (values.length !== rule.count) {
    throw new LottoPicksClientError(
      `Daily-picks ${field} contains ${values.length} values; ${rule.count} are required.`
    );
  }
  if (values.some((value) => value < rule.min || value > rule.max)) {
    throw new LottoPicksClientError(
      `Daily-picks ${field} contains a value outside ${rule.min}-${rule.max}.`
    );
  }
  if (!rule.allowDuplicates && new Set(values).size !== values.length) {
    throw new LottoPicksClientError(`Daily-picks ${field} contains a duplicate value.`);
  }
}

function parsePlayStyle(record: JsonRecord, game: GameCode): DigitPlayStyle {
  const value = requiredString(record, "playStyle", 40);
  const allowed = GAME_MANIFEST[game].optimizerPlayStyles as readonly string[];
  if (!allowed.includes(value)) {
    throw new LottoPicksClientError(
      `Daily-picks playStyle ${JSON.stringify(value)} is not valid for ${game}.`
    );
  }
  return value as DigitPlayStyle;
}

function parseTicket(value: unknown, game: GameCode): LottoPersistedTicket {
  if (!isRecord(value)) {
    throw new LottoPicksClientError("Each persisted ticket must be an object.");
  }
  const config = GAME_MANIFEST[game];
  const main = numberArray(value, "main");
  const bonus = numberArray(value, "bonus");
  assertPool(main, config.main, `${game} main numbers`);
  if (config.bonus) {
    assertPool(bonus, config.bonus, `${game} bonus numbers`);
  } else if (bonus.length !== 0) {
    throw new LottoPicksClientError(`Daily-picks ${game} ticket must not include bonus numbers.`);
  }

  const splitRiskLevel = requiredString(value, "splitRiskLevel", 16);
  if (splitRiskLevel !== "low" && splitRiskLevel !== "moderate" && splitRiskLevel !== "high") {
    throw new LottoPicksClientError(
      `Unknown daily-picks split-risk level ${JSON.stringify(splitRiskLevel)}.`
    );
  }
  const splitRiskScore = finiteNumber(value, "splitRiskScore");
  if (splitRiskScore < 0) {
    throw new LottoPicksClientError("Daily-picks splitRiskScore cannot be negative.");
  }

  return {
    ordinal: safeInteger(value, "ordinal", 1),
    main,
    bonus,
    playStyle: parsePlayStyle(value, game),
    splitRiskScore,
    splitRiskLevel,
    splitRiskNotes: stringArray(value, "splitRiskNotes")
  };
}

function generationLogUrl(record: JsonRecord, runId: string): string {
  const value = requiredString(record, "generationLogUrl", 2_000);
  let url: URL;
  try {
    url = new URL(value, "https://rabbitholetx.invalid");
  } catch {
    throw new LottoPicksClientError("Daily-picks generationLogUrl must be a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LottoPicksClientError("Daily-picks generationLogUrl must use HTTP or HTTPS.");
  }
  if (!url.pathname.endsWith(`/generation-runs/${runId}`)) {
    throw new LottoPicksClientError("Daily-picks generationLogUrl does not match its run id.");
  }
  return value;
}

function parseRun(value: unknown, responseDrawDate: string): LottoPersistedGenerationRun {
  if (!isRecord(value)) {
    throw new LottoPicksClientError("Each persisted generation run must be an object.");
  }
  const runId = requiredString(value, "runId", 36);
  if (!/^gen-[a-f0-9]{32}$/.test(runId)) {
    throw new LottoPicksClientError("Daily-picks runId is malformed.");
  }
  const gameValue = requiredString(value, "game", 16);
  if (!isGameCode(gameValue)) {
    throw new LottoPicksClientError(`Unknown daily-picks game ${JSON.stringify(gameValue)}.`);
  }
  const game = gameValue;
  const gameName = requiredString(value, "gameName", 80);
  if (gameName !== GAME_MANIFEST[game].name) {
    throw new LottoPicksClientError(`Daily-picks gameName does not match ${game}.`);
  }
  const drawDate = dateOnly(value, "drawDate");
  if (drawDate !== responseDrawDate) {
    throw new LottoPicksClientError("Daily-picks run date does not match the response date.");
  }
  const drawSlot = requiredString(value, "drawSlot", 16);
  if (drawSlot !== "daily" && drawSlot !== "morning") {
    throw new LottoPicksClientError(`Unknown daily-picks draw slot ${JSON.stringify(drawSlot)}.`);
  }
  const scheduledFor = requiredString(value, "scheduledFor", 64);
  const scheduledMatch = scheduledFor.match(
    new RegExp(`^${drawDate} (\\d{2}):(\\d{2}) America/Chicago$`)
  );
  if (!scheduledMatch || Number(scheduledMatch[1]) > 23 || Number(scheduledMatch[2]) > 59) {
    throw new LottoPicksClientError(
      "Daily-picks scheduledFor must identify the draw date and America/Chicago time."
    );
  }
  const seed = requiredString(value, "seed", 160);
  if (!/^[a-f0-9]{64}$/.test(seed)) {
    throw new LottoPicksClientError("Daily-picks seed must be a protected SHA-256 value.");
  }
  const datasetDigest = requiredString(value, "datasetDigest", 64);
  if (!/^[a-f0-9]{64}$/.test(datasetDigest)) {
    throw new LottoPicksClientError("Daily-picks datasetDigest must be a SHA-256 digest.");
  }

  if (!isRecord(value.coverage)) {
    throw new LottoPicksClientError("Daily-picks coverage must be an object.");
  }
  const distinctPairs = safeInteger(value.coverage, "distinctPairs");
  const possiblePairs = safeInteger(value.coverage, "possiblePairs", 1);
  const expectedPossiblePairs = possiblePairCount(game);
  if (possiblePairs !== expectedPossiblePairs || distinctPairs > possiblePairs) {
    throw new LottoPicksClientError("Daily-picks coverage counts do not match the game matrix.");
  }
  const coveragePercent = finiteNumber(value.coverage, "coveragePercent");
  const expectedPercent = Math.round((distinctPairs / possiblePairs) * 10_000) / 100;
  if (
    coveragePercent < 0 ||
    coveragePercent > 100 ||
    Math.abs(coveragePercent - expectedPercent) > 0.001
  ) {
    throw new LottoPicksClientError("Daily-picks coverage percentage does not reconcile.");
  }

  if (!isRecord(value.ev)) {
    throw new LottoPicksClientError("Daily-picks EV must be an object.");
  }
  const netCentsPerTicket = finiteNumber(value.ev, "netCentsPerTicket");
  if (!Number.isSafeInteger(netCentsPerTicket)) {
    throw new LottoPicksClientError("Daily-picks EV cents must be a safe integer.");
  }

  if (!Array.isArray(value.tickets) || value.tickets.length < 1 || value.tickets.length > 50) {
    throw new LottoPicksClientError("Daily-picks tickets must contain between 1 and 50 tickets.");
  }
  const tickets = value.tickets.map((ticket) => parseTicket(ticket, game));
  tickets.forEach((ticket, index) => {
    if (ticket.ordinal !== index + 1) {
      throw new LottoPicksClientError("Daily-picks ticket ordinals must be sequential.");
    }
  });
  const ticketKeys = tickets.map(
    (ticket) => `${ticket.playStyle}:${ticket.main.join(",")}:${ticket.bonus.join(",")}`
  );
  if (new Set(ticketKeys).size !== ticketKeys.length) {
    throw new LottoPicksClientError("Daily-picks generation run contains duplicate tickets.");
  }

  const disclaimer = requiredString(value, "disclaimer", 500);
  if (!/optimized/i.test(disclaimer) || !/not predicted/i.test(disclaimer)) {
    throw new LottoPicksClientError(
      "Daily-picks disclaimer must state that picks are optimized, not predicted."
    );
  }

  return {
    runId,
    game,
    gameName,
    drawDate,
    drawSlot,
    scheduledFor,
    generatedAt: dateTime(value, "generatedAt"),
    seed,
    observedThrough: dateOnly(value, "observedThrough"),
    datasetDigest,
    coverage: { distinctPairs, possiblePairs, coveragePercent },
    ev: {
      netCentsPerTicket,
      assumption: requiredString(value.ev, "assumption", 1_000)
    },
    tickets,
    generationLogUrl: generationLogUrl(value, runId),
    disclaimer
  };
}

export function parseLottoDailyPicks(value: unknown): LottoDailyPicksResponse {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.data)) {
    throw new LottoPicksClientError("Daily-picks response has an unsupported schema.");
  }
  const generatedAt = dateTime(value, "generatedAt");
  const drawDate = dateOnly(value.data, "drawDate");
  if (!Array.isArray(value.data.runs)) {
    throw new LottoPicksClientError("Daily-picks runs must be an array.");
  }
  if (value.data.runs.length > 16) {
    throw new LottoPicksClientError("Daily-picks response contains too many generation runs.");
  }
  const runs = value.data.runs.map((run) => parseRun(run, drawDate));
  const runIds = runs.map(({ runId }) => runId);
  const gameSlots = runs.map(({ game, drawSlot }) => `${game}:${drawSlot}`);
  if (new Set(runIds).size !== runs.length || new Set(gameSlots).size !== runs.length) {
    throw new LottoPicksClientError("Daily-picks response contains duplicate generation runs.");
  }
  return { schemaVersion: 1, generatedAt, data: { drawDate, runs } };
}

function absoluteGenerationLogUrl(value: string, baseUrl: string): string {
  return new URL(value, `${new URL(baseUrl).origin}/`).toString();
}

export async function readLottoDailyPicks(
  options: ReadLottoDailyPicksOptions = {}
): Promise<LottoDailyPicksResponse> {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = normalizeLottoApiBase(options.baseUrl ?? configuredLottoApiBase());
  const token = options.token?.trim() ?? "";
  if (!token) {
    throw new LottoPicksClientError("A Yevow dashboard login is required for daily picks.", 401);
  }
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/picks/today`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-cache",
      signal: options.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new LottoPicksClientError("Today's persisted LOTTO picks could not be reached.");
  }
  if (!response.ok) {
    throw new LottoPicksClientError(
      `The daily-picks service returned HTTP ${response.status}.`,
      response.status
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new LottoPicksClientError("The daily-picks service returned invalid JSON.");
  }
  const parsed = parseLottoDailyPicks(payload);
  return {
    ...parsed,
    data: {
      ...parsed.data,
      runs: parsed.data.runs.map((run) => ({
        ...run,
        generationLogUrl: absoluteGenerationLogUrl(run.generationLogUrl, baseUrl)
      }))
    }
  };
}
