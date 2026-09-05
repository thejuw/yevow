import { calculateEv } from "../../web/lib/lotto/ev";
import { calculatePairCoverage } from "../../web/lib/lotto/coverage";
import { createSeededRng, randomInteger, sampleWithoutReplacement } from "../../web/lib/lotto/rng";
import { scoreSplitRisk } from "../../web/lib/lotto/risk";
import type { DigitPlayStyle, SplitRiskResult, Ticket } from "../../web/lib/lotto/types";
import { validateTicket } from "../../web/lib/lotto/validation";

import type { Env } from "./env";
import { GAME_MANIFEST, type GameCode, type Session } from "./manifest";
import { ticketSalesWindow } from "./scheduler";

export const TICKET_LAB_DISCLAIMER =
  "Picks are optimized, not predicted. Ticket Lab records and grades every proposal; it does not predict lottery draws. " +
  "Past results do not improve future odds. Play responsibly.";

const RULE_VERSION = 1;
const MAX_LIST_LIMIT = 100;
const LEGAL_STAKES = new Set([50, 100, 200, 300, 400, 500]);
const LOTTO_EXTRA_EFFECTIVE_DATE = "2013-04-17";
const FIREBALL_EFFECTIVE_DATE = "2019-04-29";
const MM_MULTIPLIER_POOL = [
  ...Array<number>(15).fill(2),
  ...Array<number>(10).fill(3),
  ...Array<number>(4).fill(4),
  ...Array<number>(2).fill(5),
  10
] as const;

type Origin = "system" | "random" | "user";
type PurchaseStatus = "unconfirmed" | "confirmed" | "declined";
type PayoutStatus = "none" | "fixed" | "pending";
type EntryStatus = "open" | "graded" | "pending" | "won" | "lost";

interface GenerationTicketSnapshot {
  readonly ticket: Ticket;
  readonly splitRisk: SplitRiskResult;
}

export interface GenerationLedgerInput {
  readonly runId: string;
  readonly game: GameCode;
  readonly drawDate: string;
  readonly generatedAt: string;
  readonly seed: string;
  readonly tickets: readonly GenerationTicketSnapshot[];
  readonly coverage: {
    readonly distinctPairs: number;
    readonly possiblePairs: number;
    readonly coveragePercent: number;
  };
  readonly evNetCents: number;
  readonly evAssumption: string;
  readonly ticketCostCents: number;
  readonly observedThrough: string;
  readonly datasetDigest: string;
}

interface LedgerRow {
  ledger_id: string;
  run_id: string | null;
  origin: Origin;
  correction_of: string | null;
  baseline_for: string | null;
  game: GameCode;
  draw_date: string;
  target_session: Session;
  proposed_at: string;
  seed: string | null;
  coverage_distinct_pairs: number;
  coverage_possible_pairs: number;
  coverage_basis_points: number;
  ev_net_cents: number;
  ev_assumption: string;
  ticket_cost_cents: number;
  ticket_count: number;
  split_risk_model_json: string;
  observed_through: string | null;
  dataset_digest: string | null;
  created_at: string;
}

interface LedgerTicketRow {
  ledger_ticket_id: string;
  ledger_id: string;
  ordinal: number;
  main_numbers: string;
  bonus_numbers: string;
  play_style: string;
  wager_cents: number;
  ticket_options_json: string;
  split_risk_basis_points: number;
  split_risk_level: "low" | "moderate" | "high";
  split_risk_notes: string;
}

interface DrawRow {
  game: GameCode;
  draw_date: string;
  session: Session;
  ordered_numbers: string;
  bonus_numbers: string;
  metadata: string;
  content_fingerprint: string;
  source_id: string;
  source_sha256: string;
}

interface GradeHeaderRow {
  grade_id: string;
  ledger_id: string;
  revision: number;
  supersedes_grade_id: string | null;
  draw_fingerprint: string;
  result_main_numbers: string;
  result_bonus_numbers: string;
  result_session: string;
  hit_count: number;
  pending_prize_count: number;
  known_prize_cents: number;
  graded_at: string;
}

interface TicketGradeRow {
  ticket_grade_id: string;
  grade_id: string;
  ledger_ticket_id: string;
  main_matches: number;
  bonus_matches: number;
  prize_tier: string;
  hit: number;
  payout_status: PayoutStatus;
  prize_cents: number | null;
  pending_reason: string | null;
  grading_detail_json: string;
}

interface PurchaseRow {
  purchase_event_id: string;
  ledger_id: string;
  purchased: number;
  spend_cents: number;
  source: string;
  note: string | null;
  options_json: string;
  recorded_at: string;
}

interface SettlementRow {
  ticket_grade_id: string;
  settlement_id: string;
  final_prize_cents: number;
  source: string;
  note: string | null;
  evidence_json: string;
  settled_at: string;
}

interface GradeResult {
  readonly mainMatches: number;
  readonly bonusMatches: number;
  readonly tier: string;
  readonly hit: boolean;
  readonly payoutStatus: PayoutStatus;
  readonly prizeCents: number | null;
  readonly pendingReason: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface TicketLabScorecard {
  readonly entries: number;
  readonly tickets: number;
  readonly gradedTickets: number;
  readonly spentCents: number;
  readonly wonCents: number;
  readonly nonCashValueCents: number;
  readonly pendingPrizeCount: number;
  readonly longestLosingStreak: number;
  readonly bestHit: null | {
    readonly game: GameCode;
    readonly drawDate: string;
    readonly tier: string;
    readonly prizeCents: number | null;
    readonly payoutStatus: "fixed" | "settled" | "pending";
  };
  readonly roiPercent: number | null;
  readonly economicRoiPercent: number | null;
}

export interface TicketLabFilters {
  readonly game: GameCode | null;
  readonly from: string | null;
  readonly to: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeRecord(value: string, field: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(value);
  if (!isRecord(decoded)) throw new Error(`Stored ${field} is invalid`);
  return decoded;
}

function decodeIntegerArray(value: string, field: string): number[] {
  const decoded: unknown = JSON.parse(value);
  if (!Array.isArray(decoded) || !decoded.every((item) => Number.isSafeInteger(item))) {
    throw new Error(`Stored ${field} is invalid`);
  }
  return decoded as number[];
}

function decodeStringArray(value: string, field: string): string[] {
  const decoded: unknown = JSON.parse(value);
  if (!Array.isArray(decoded) || !decoded.every((item) => typeof item === "string")) {
    throw new Error(`Stored ${field} is invalid`);
  }
  return decoded as string[];
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(`${field} must be an ISO-8601 date`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${field} must be a real calendar date`);
  }
  return value;
}

function isoTimestamp(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback) return fallback;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new RangeError(`${field} must be an ISO-8601 timestamp`);
  }
  return new Date(value).toISOString();
}

function boundedString(
  value: unknown,
  field: string,
  maximum: number,
  required = false
): string | null {
  if (value === undefined || value === null) {
    if (required) throw new RangeError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new RangeError(`${field} must be a string`);
  const text = value.trim();
  if (required && text.length === 0) throw new RangeError(`${field} is required`);
  if (text.length > maximum) throw new RangeError(`${field} exceeds ${maximum} characters`);
  return text || null;
}

function safeCents(value: unknown, field: string, fallback?: number): number {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer number of cents`);
  }
  return candidate as number;
}

function signedCents(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > 100_000_000_000) {
    throw new RangeError(
      `${field} must be a safe integer number of cents between -100000000000 and 100000000000`
    );
  }
  return value as number;
}

function texasDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function defaultTargetSession(game: GameCode): Session {
  return game === "p3" || game === "d4" || game === "aon" ? "morning" : "";
}

function targetSession(game: GameCode, value: unknown): Session {
  const fallback = defaultTargetSession(game);
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !["morning", "day", "evening", "night"].includes(value)) {
    throw new RangeError("targetSession must be morning, day, evening, or night");
  }
  if (game !== "p3" && game !== "d4" && game !== "aon") {
    throw new RangeError(`${GAME_MANIFEST[game].name} has no intraday draw session`);
  }
  return value as Session;
}

function ticketKey(ticket: Ticket): string {
  return `${ticket.main.join(",")}|${(ticket.bonus ?? []).join(",")}|${ticket.playStyle ?? "straight"}`;
}

const DAILY_4_PAIR_STYLES = new Set<DigitPlayStyle>([
  "front-pair",
  "mid-pair",
  "middle-pair",
  "back-pair"
]);

/**
 * The optimizer deliberately excludes Daily 4 pair wagers, while the immutable
 * manual ledger must be able to record a legally purchased pair ticket.
 */
function validateLedgerTicket(game: GameCode, ticket: Ticket): Ticket {
  const style = (ticket.playStyle ?? "straight").trim().toLowerCase() as DigitPlayStyle;
  if (game !== "d4" || !DAILY_4_PAIR_STYLES.has(style)) return validateTicket(game, ticket);
  const config = GAME_MANIFEST.d4;
  if (!Array.isArray(ticket.main) || ticket.main.length !== config.main.count) {
    throw new RangeError(`Daily 4 main selection requires exactly ${config.main.count} digits`);
  }
  ticket.main.forEach((digit, index) => {
    if (!Number.isSafeInteger(digit) || digit < config.main.min || digit > config.main.max) {
      throw new RangeError(`Daily 4 digit at position ${index + 1} must be 0 through 9`);
    }
  });
  if (ticket.bonus !== undefined && (!Array.isArray(ticket.bonus) || ticket.bonus.length !== 0)) {
    throw new RangeError("Daily 4 does not accept a bonus selection");
  }
  return Object.freeze({
    game: "d4",
    main: Object.freeze([...ticket.main]),
    playStyle: style
  });
}

function quickPickTickets(game: GameCode, count: number, seed: string): Ticket[] {
  const config = GAME_MANIFEST[game];
  const rng = createSeededRng(`ticket-lab-random-baseline:${seed}`);
  const output: Ticket[] = [];
  const keys = new Set<string>();
  for (let attempt = 0; output.length < count && attempt < count * 100; attempt += 1) {
    const main = config.main.allowDuplicates
      ? Array.from({ length: config.main.count }, () =>
          randomInteger(rng, config.main.min, config.main.max)
        )
      : sampleWithoutReplacement(rng, config.main.min, config.main.max, config.main.count).sort(
          (left, right) => left - right
        );
    const bonus = config.bonus
      ? sampleWithoutReplacement(rng, config.bonus.min, config.bonus.max, config.bonus.count).sort(
          (left, right) => left - right
        )
      : [];
    const candidate = validateTicket(game, {
      game,
      main,
      ...(bonus.length ? { bonus } : {}),
      playStyle: "straight"
    });
    const key = ticketKey(candidate);
    if (!keys.has(key)) {
      output.push(candidate);
      keys.add(key);
    }
  }
  if (output.length !== count)
    throw new Error(`Could not generate ${count} distinct random baselines`);
  return output;
}

function modeledMegaMultiplier(seed: string, ordinal: number, label: string): number {
  const rng = createSeededRng(`ticket-lab-mm-multiplier:${label}:${seed}:${ordinal}`);
  return MM_MULTIPLIER_POOL[randomInteger(rng, 0, MM_MULTIPLIER_POOL.length - 1)] as number;
}

function baseTicketOptions(
  game: GameCode,
  seed: string,
  ordinal: number,
  label: string
): Record<string, unknown> {
  if (game === "lotto") return { extra: false };
  if (game === "pb") return { powerPlay: false };
  if (game === "mm") {
    return {
      megaMultiplier: modeledMegaMultiplier(seed, ordinal, label),
      multiplierProvenance: "modeled"
    };
  }
  if (game === "p3") return { stakeCents: 50, fireball: false };
  if (game === "d4") return { stakeCents: 50, fireball: false, pairPosition: null };
  return { basePlay: true };
}

function ledgerIdForRun(runId: string): string {
  if (!/^gen-[a-f0-9]{32}$/.test(runId)) throw new Error("generation run id is malformed");
  return `ledger-${runId.slice(4)}`;
}

/** Build one atomic system ledger snapshot and an equal-size true random baseline. */
export async function generationLedgerStatements(
  database: D1Database,
  input: GenerationLedgerInput,
  options: { readonly baselineOnly?: boolean } = {}
): Promise<D1PreparedStatement[]> {
  const systemLedgerId = ledgerIdForRun(input.runId);
  const randomLedgerId = `ledger-${(await sha256(`baseline\0${input.runId}`)).slice(0, 32)}`;
  const randomSeed = await sha256(`baseline-seed\0${input.seed}`);
  const randomTickets = quickPickTickets(input.game, input.tickets.length, randomSeed);
  const randomScored = randomTickets.map((ticket) => ({
    ticket,
    splitRisk: scoreSplitRisk(input.game, ticket)
  }));
  const randomCoverage = calculatePairCoverage(input.game, randomTickets);
  const session = defaultTargetSession(input.game);
  const splitModel = (items: readonly GenerationTicketSnapshot[], model: string): string =>
    JSON.stringify({
      model,
      version: 1,
      tickets: items.map((item, index) => ({
        ordinal: index + 1,
        score: item.splitRisk.score,
        level: item.splitRisk.level
      }))
    });
  const statements: D1PreparedStatement[] = [];
  const appendEntry = (
    ledgerId: string,
    origin: "system" | "random",
    runId: string | null,
    baselineFor: string | null,
    seed: string,
    items: readonly GenerationTicketSnapshot[],
    coverage: { distinctPairs: number; possiblePairs: number; coveragePercent: number }
  ): void => {
    statements.push(
      database
        .prepare(
          `INSERT OR IGNORE INTO lotto_ticket_ledger
             (ledger_id, run_id, origin, correction_of, baseline_for, game, draw_date, target_session,
              proposed_at, seed, coverage_distinct_pairs, coverage_possible_pairs,
              coverage_basis_points, ev_net_cents, ev_assumption, ticket_cost_cents,
              ticket_count, split_risk_model_json, observed_through, dataset_digest, created_at)
           VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                   ?14, ?15, ?16, ?17, ?18, ?19, ?8)`
        )
        .bind(
          ledgerId,
          runId,
          origin,
          baselineFor,
          input.game,
          input.drawDate,
          session,
          input.generatedAt,
          seed,
          coverage.distinctPairs,
          coverage.possiblePairs,
          Math.round(coverage.coveragePercent * 100),
          input.evNetCents,
          origin === "random"
            ? `${input.evAssumption} Equal-size quick-pick random comparison baseline.`
            : input.evAssumption,
          input.ticketCostCents,
          items.length,
          splitModel(
            items,
            origin === "random"
              ? "random-baseline-observation"
              : "RabbitHoleTX split-risk heuristic"
          ),
          input.observedThrough,
          input.datasetDigest
        )
    );
    items.forEach((item, index) => {
      const ordinal = index + 1;
      statements.push(
        database
          .prepare(
            `INSERT OR IGNORE INTO lotto_ledger_tickets
               (ledger_ticket_id, ledger_id, ordinal, main_numbers, bonus_numbers,
                play_style, wager_cents, ticket_options_json, split_risk_basis_points,
                split_risk_level, split_risk_notes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
          )
          .bind(
            `lt-${ledgerId.slice(7)}-${ordinal}`,
            ledgerId,
            ordinal,
            JSON.stringify(item.ticket.main),
            JSON.stringify(item.ticket.bonus ?? []),
            item.ticket.playStyle ?? "straight",
            input.ticketCostCents,
            JSON.stringify(baseTicketOptions(input.game, seed, ordinal, origin)),
            Math.round(item.splitRisk.score * 100),
            item.splitRisk.level,
            JSON.stringify(item.splitRisk.notes),
            input.generatedAt
          )
      );
    });
  };
  if (options.baselineOnly !== true) {
    appendEntry(
      systemLedgerId,
      "system",
      input.runId,
      null,
      input.seed,
      input.tickets,
      input.coverage
    );
  }
  appendEntry(
    randomLedgerId,
    "random",
    null,
    systemLedgerId,
    randomSeed,
    randomScored,
    randomCoverage
  );
  return statements;
}

/** Idempotently attach equal-size random controls to Phase 3 runs predating schema v6. */
export async function reconcileLegacyRandomBaselines(env: Env, limit = 20): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("baseline reconciliation limit must be 1 through 100");
  const systems = await env.LOTTO_DB.prepare(
    `SELECT l.* FROM lotto_ticket_ledger l
     WHERE l.origin = 'system' AND l.run_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM lotto_ticket_ledger b WHERE b.baseline_for = l.ledger_id
       )
     ORDER BY l.created_at, l.ledger_id LIMIT ?1`
  )
    .bind(limit)
    .all<LedgerRow>();
  let created = 0;
  for (const system of systems.results) {
    const tickets = await env.LOTTO_DB.prepare(
      `SELECT ledger_ticket_id, ledger_id, ordinal, main_numbers, bonus_numbers,
              play_style, wager_cents, ticket_options_json, split_risk_basis_points,
              split_risk_level, split_risk_notes
       FROM lotto_ledger_tickets WHERE ledger_id = ?1 ORDER BY ordinal`
    )
      .bind(system.ledger_id)
      .all<LedgerTicketRow>();
    if (tickets.results.length !== system.ticket_count)
      throw new Error(`Ledger ${system.ledger_id} ticket count does not reconcile`);
    const snapshots = tickets.results.map((row) => {
      const ticket = validateTicket(system.game, {
        game: system.game,
        main: decodeIntegerArray(row.main_numbers, "ledger main numbers"),
        bonus: decodeIntegerArray(row.bonus_numbers, "ledger bonus numbers"),
        playStyle: row.play_style as DigitPlayStyle
      });
      return { ticket, splitRisk: scoreSplitRisk(system.game, ticket) };
    });
    const statements = await generationLedgerStatements(
      env.LOTTO_DB,
      {
        runId: system.run_id as string,
        game: system.game,
        drawDate: system.draw_date,
        generatedAt: system.proposed_at,
        seed: system.seed ?? (await sha256(`legacy-system\0${system.ledger_id}`)),
        tickets: snapshots,
        coverage: {
          distinctPairs: system.coverage_distinct_pairs,
          possiblePairs: system.coverage_possible_pairs,
          coveragePercent: system.coverage_basis_points / 100
        },
        evNetCents: system.ev_net_cents,
        evAssumption: system.ev_assumption,
        ticketCostCents: system.ticket_cost_cents,
        observedThrough: system.observed_through ?? system.draw_date,
        datasetDigest:
          system.dataset_digest ?? (await sha256(`legacy-dataset\0${system.ledger_id}`))
      },
      { baselineOnly: true }
    );
    const results = await env.LOTTO_DB.batch(statements);
    created += results[0]?.meta.changes ?? 0;
  }
  return created;
}

function matches(left: readonly number[], right: readonly number[]): number {
  const rightSet = new Set(right);
  return left.reduce((total, value) => total + (rightSet.has(value) ? 1 : 0), 0);
}

function exact(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function multisetKey(values: readonly number[]): string {
  return [...values].sort((left, right) => left - right).join(",");
}

function digitWays(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let factorial = values.length === 3 ? 6 : 24;
  for (const count of counts.values()) {
    if (count === 2) factorial /= 2;
    else if (count === 3) factorial /= 6;
    else if (count === 4) factorial /= 24;
  }
  return factorial;
}

function pending(
  mainMatches: number,
  bonusMatches: number,
  tier: string,
  reason: string,
  settlementKind: "official-payout" | "missing-result-evidence",
  detail: Record<string, unknown> = {}
): GradeResult {
  return {
    mainMatches,
    bonusMatches,
    tier,
    hit: true,
    payoutStatus: "pending",
    prizeCents: null,
    pendingReason: reason,
    detail: { ...detail, settlementKind }
  };
}

function fixed(
  mainMatches: number,
  bonusMatches: number,
  tier: string,
  prizeCents: number,
  detail: Record<string, unknown> = {}
): GradeResult {
  return {
    mainMatches,
    bonusMatches,
    tier,
    hit: true,
    payoutStatus: "fixed",
    prizeCents,
    pendingReason: null,
    detail
  };
}

function miss(
  mainMatches: number,
  bonusMatches: number,
  detail: Record<string, unknown> = {}
): GradeResult {
  return {
    mainMatches,
    bonusMatches,
    tier: "No prize",
    hit: false,
    payoutStatus: "none",
    prizeCents: 0,
    pendingReason: null,
    detail
  };
}

interface OfficialPayout {
  readonly cents: number;
  readonly key: string;
  readonly source: string;
  readonly sourceSha256: string;
}

interface OfficialEvidence {
  readonly source: string;
  readonly sourceSha256: string;
}

function officialHttpsSource(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 1_000) {
    throw new Error(`${field} must be an official Texas Lottery HTTPS URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be an official Texas Lottery HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    (parsed.hostname !== "texaslottery.com" && !parsed.hostname.endsWith(".texaslottery.com"))
  ) {
    throw new Error(`${field} must be an official Texas Lottery HTTPS URL`);
  }
  return parsed.toString();
}

function officialEvidence(metadata: Record<string, unknown>): OfficialEvidence {
  if (metadata.official_payouts_certified !== true) {
    throw new Error("official payout metadata must be certified");
  }
  const source = officialHttpsSource(metadata.official_payouts_source, "official_payouts_source");
  const sourceSha256 = metadata.official_payouts_source_sha256;
  if (typeof sourceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sourceSha256)) {
    throw new Error("official_payouts_source_sha256 must be a 64-hex SHA-256 digest");
  }
  return { source, sourceSha256: sourceSha256.toLowerCase() };
}

/** Read a payout only when it is part of the immutable, fingerprinted draw metadata. */
function officialPayout(
  metadata: Record<string, unknown>,
  keys: readonly string[]
): OfficialPayout | null {
  const table = metadata.official_payouts_cents;
  if (table === undefined) return null;
  if (!isRecord(table)) throw new Error("official_payouts_cents draw metadata must be an object");
  const key = keys.find((candidate) => Object.prototype.hasOwnProperty.call(table, candidate));
  if (!key) return null;
  const cents = table[key];
  if (!Number.isSafeInteger(cents) || (cents as number) < 0) {
    throw new Error(`official payout ${JSON.stringify(key)} must be non-negative integer cents`);
  }
  const evidence = officialEvidence(metadata);
  return { cents: cents as number, key, ...evidence };
}

function officialPayoutDetail(payout: OfficialPayout): Record<string, unknown> {
  return {
    payoutProvenance: "fingerprinted-official-draw-metadata",
    officialPayoutKey: payout.key,
    officialPayoutSource: payout.source,
    officialPayoutSourceSha256: payout.sourceSha256
  };
}

interface CertifiedWinnerCount {
  readonly count: number;
  readonly key: string;
  readonly source: string;
  readonly sourceSha256: string;
}

function certifiedWinnerCount(
  metadata: Record<string, unknown>,
  keys: readonly string[]
): CertifiedWinnerCount | null {
  const key = keys.find((candidate) => Object.prototype.hasOwnProperty.call(metadata, candidate));
  if (!key) return null;
  const count = metadata[key];
  if (!Number.isSafeInteger(count) || (count as number) < 1) {
    throw new Error(`${key} must be a positive safe integer`);
  }
  const evidence = officialEvidence(metadata);
  return { count: count as number, key, ...evidence };
}

function wholeDollarCapShare(capCents: number, winnerCount: number): number {
  return Math.floor(capCents / (winnerCount * 100)) * 100;
}

function gradeLotto(
  mainMatches: number,
  options: Record<string, unknown>,
  metadata: Record<string, unknown>
): GradeResult {
  const extra = options.extra === true;
  const official =
    mainMatches >= 4
      ? officialPayout(metadata, [`lotto:${mainMatches}`, String(mainMatches)])
      : null;
  const extraCents = extra ? (mainMatches === 5 ? 1_000_000 : mainMatches === 4 ? 10_000 : 0) : 0;
  const tier =
    mainMatches === 6
      ? "6 of 6 — jackpot"
      : extra
        ? `${mainMatches} of 6 with EXTRA`
        : `${mainMatches} of 6`;
  if (official) {
    return fixed(mainMatches, 0, tier, official.cents + extraCents, {
      extra,
      extraCents,
      ...officialPayoutDetail(official)
    });
  }
  if (mainMatches === 6)
    return pending(
      6,
      0,
      tier,
      "Jackpot requires the official realized per-draw pari-mutuel payout",
      "official-payout",
      { extra, manualSettlementIsAllIn: true, requiredExtraCents: 0 }
    );
  if (mainMatches === 5)
    return pending(
      5,
      0,
      tier,
      extra
        ? "Enter the official all-in pari-mutuel payout including the $10,000 EXTRA award"
        : "Lotto Texas upper tier is pari-mutuel; enter the official per-draw payout",
      "official-payout",
      {
        extra,
        guaranteedExtraCents: extraCents,
        manualSettlementIsAllIn: true,
        requiredExtraCents: extraCents
      }
    );
  if (mainMatches === 4)
    return pending(
      4,
      0,
      tier,
      extra
        ? "Enter the official all-in pari-mutuel payout including the $100 EXTRA award"
        : "Lotto Texas upper tier is pari-mutuel; enter the official per-draw payout",
      "official-payout",
      {
        extra,
        guaranteedExtraCents: extraCents,
        manualSettlementIsAllIn: true,
        requiredExtraCents: extraCents
      }
    );
  if (mainMatches === 3)
    return fixed(3, 0, extra ? "3 of 6 with EXTRA" : "3 of 6", extra ? 1_300 : 300, { extra });
  if (mainMatches === 2 && extra) return fixed(2, 0, "2 of 6 with EXTRA", 200, { extra });
  return miss(mainMatches, 0, { extra });
}

function gradeTwoStep(
  mainMatches: number,
  bonusMatches: number,
  metadata: Record<string, unknown>
): GradeResult {
  const key = `${mainMatches}+${bonusMatches}`;
  const official = officialPayout(metadata, [`twostep:${key}`, key]);
  const pendingTier = new Map<string, string>([
    ["4+1", "4 of 4 + Bonus — jackpot"],
    ["4+0", "4 of 4"],
    ["3+1", "3 of 4 + Bonus"],
    ["3+0", "3 of 4"],
    ["2+1", "2 of 4 + Bonus"]
  ]).get(key);
  if (official && pendingTier) {
    return fixed(mainMatches, bonusMatches, pendingTier, official.cents, {
      ...officialPayoutDetail(official)
    });
  }
  if (mainMatches === 4 && bonusMatches === 1)
    return pending(
      4,
      1,
      "4 of 4 + Bonus — jackpot",
      "Jackpot requires the official realized per-draw pari-mutuel payout",
      "official-payout"
    );
  if (mainMatches === 4)
    return pending(
      4,
      0,
      "4 of 4",
      "Prize is pari-mutuel; enter the official per-draw payout",
      "official-payout"
    );
  if (mainMatches === 3 && bonusMatches === 1)
    return pending(
      3,
      1,
      "3 of 4 + Bonus",
      "Prize is pari-mutuel; enter the official per-draw payout",
      "official-payout"
    );
  if (mainMatches === 3)
    return pending(
      3,
      0,
      "3 of 4",
      "Prize is pari-mutuel; enter the official per-draw payout",
      "official-payout"
    );
  if (mainMatches === 2 && bonusMatches === 1)
    return pending(
      2,
      1,
      "2 of 4 + Bonus",
      "Prize is pari-mutuel; enter the official per-draw payout",
      "official-payout"
    );
  if (mainMatches === 1 && bonusMatches === 1) return fixed(1, 1, "1 of 4 + Bonus", 700);
  if (mainMatches === 0 && bonusMatches === 1) return fixed(0, 1, "0 of 4 + Bonus", 500);
  return miss(mainMatches, bonusMatches);
}

function gradeCashFive(mainMatches: number, metadata: Record<string, unknown>): GradeResult {
  if (mainMatches === 5) {
    const winners = certifiedWinnerCount(metadata, [
      "cash5_top_prize_winner_count",
      "official_top_prize_winner_count"
    ]);
    if (winners) {
      const prizeCents =
        winners.count <= 3 ? 2_500_000 : wholeDollarCapShare(7_500_000, winners.count);
      return fixed(5, 0, "5 of 5", prizeCents, {
        nominalPrizeCents: 2_500_000,
        liabilityCapCents: 7_500_000,
        winnerCount: winners.count,
        winnerCountKey: winners.key,
        threshold: 3,
        wholeDollarRounding: "down",
        payoutProvenance: "fingerprinted-certified-winner-count",
        officialPayoutSource: winners.source,
        officialPayoutSourceSha256: winners.sourceSha256
      });
    }
    return pending(
      5,
      0,
      "5 of 5",
      "The $25,000 nominal prize is liability-capped; enter the official realized payout",
      "official-payout",
      {
        nominalPrizeCents: 2_500_000,
        liabilityCapCents: 7_500_000,
        liabilityGame: "cash5",
        maximumSettlementCents: 2_500_000,
        wholeDollarSettlement: true,
        liabilityRule: "nominal through 3 winners; above 3 divide $75,000 and round down"
      }
    );
  }
  if (mainMatches === 4) return fixed(4, 0, "4 of 5", 35_000);
  if (mainMatches === 3) return fixed(3, 0, "3 of 5", 1_500);
  if (mainMatches === 2)
    return fixed(2, 0, "2 of 5 — free Quick Pick", 0, {
      nonCashPrize: "Cash Five Quick Pick",
      faceValueCents: 100,
      cashValueCents: 0
    });
  return miss(mainMatches, 0);
}

function gradePowerball(
  mainMatches: number,
  bonusMatches: number,
  options: Record<string, unknown>,
  metadata: Record<string, unknown>
): GradeResult {
  if (mainMatches === 5 && bonusMatches === 1)
    return pending(
      5,
      1,
      "5 + Powerball — jackpot",
      "Jackpot requires the official realized per-draw pari-mutuel payout",
      "official-payout"
    );
  const base = new Map<string, [string, number]>([
    ["5:0", ["5", 100_000_000]],
    ["4:1", ["4 + Powerball", 5_000_000]],
    ["4:0", ["4", 10_000]],
    ["3:1", ["3 + Powerball", 10_000]],
    ["3:0", ["3", 700]],
    ["2:1", ["2 + Powerball", 700]],
    ["1:1", ["1 + Powerball", 400]],
    ["0:1", ["0 + Powerball", 400]]
  ]).get(`${mainMatches}:${bonusMatches}`);
  if (!base) return miss(mainMatches, bonusMatches, { powerPlay: options.powerPlay === true });
  const payoutKey = `${mainMatches}+${bonusMatches}`;
  const powerPlay = options.powerPlay === true;
  if (powerPlay) {
    if (mainMatches === 5 && bonusMatches === 0) {
      return fixed(5, 0, "5 with Power Play", 200_000_000, {
        powerPlay: true,
        powerPlayMultiplier: "fixed-2-million"
      });
    }
    const multiplier = metadata.power_play;
    if (!Number.isSafeInteger(multiplier) || ![2, 3, 4, 5, 10].includes(multiplier as number)) {
      return pending(
        mainMatches,
        bonusMatches,
        `${base[0]} with Power Play`,
        "Official Power Play result multiplier is unavailable",
        "missing-result-evidence",
        { powerPlay: true }
      );
    }
    const finalOfficial = officialPayout(metadata, [
      `pb:${payoutKey}:power-play:${multiplier as number}x`
    ]);
    const baseOfficial = finalOfficial ? null : officialPayout(metadata, [`pb:${payoutKey}:base`]);
    const prize = finalOfficial
      ? finalOfficial.cents
      : (baseOfficial?.cents ?? base[1]) * (multiplier as number);
    const payoutDetail = finalOfficial ?? baseOfficial;
    return fixed(
      mainMatches,
      bonusMatches,
      `${base[0]} with ${multiplier as number}X Power Play`,
      prize,
      {
        powerPlay: true,
        powerPlayMultiplier: multiplier,
        ...(payoutDetail ? officialPayoutDetail(payoutDetail) : {})
      }
    );
  }
  const official = officialPayout(metadata, [`pb:${payoutKey}`, payoutKey, `pb:${payoutKey}:base`]);
  return fixed(mainMatches, bonusMatches, base[0], official?.cents ?? base[1], {
    powerPlay: false,
    ...(official ? officialPayoutDetail(official) : {})
  });
}

function gradeMegaMillions(
  mainMatches: number,
  bonusMatches: number,
  options: Record<string, unknown>,
  metadata: Record<string, unknown>
): GradeResult {
  if (mainMatches === 5 && bonusMatches === 1)
    return pending(
      5,
      1,
      "5 + Mega Ball — jackpot",
      "Jackpot requires the official realized per-draw pari-mutuel payout",
      "official-payout"
    );
  const base = new Map<string, [string, number]>([
    ["5:0", ["5", 100_000_000]],
    ["4:1", ["4 + Mega Ball", 1_000_000]],
    ["4:0", ["4", 50_000]],
    ["3:1", ["3 + Mega Ball", 20_000]],
    ["3:0", ["3", 1_000]],
    ["2:1", ["2 + Mega Ball", 1_000]],
    ["1:1", ["1 + Mega Ball", 700]],
    ["0:1", ["0 + Mega Ball", 500]]
  ]).get(`${mainMatches}:${bonusMatches}`);
  if (!base)
    return miss(mainMatches, bonusMatches, { megaMultiplier: options.megaMultiplier ?? null });
  const multiplier = options.megaMultiplier;
  if (!Number.isSafeInteger(multiplier) || ![2, 3, 4, 5, 10].includes(multiplier as number)) {
    return pending(
      mainMatches,
      bonusMatches,
      base[0],
      "The ticket-assigned Mega Millions multiplier was not recorded before grading",
      "missing-result-evidence",
      { multiplierProvenance: options.multiplierProvenance ?? "missing" }
    );
  }
  const payoutKey = `${mainMatches}+${bonusMatches}`;
  const finalOfficial = officialPayout(metadata, [`mm:${payoutKey}:${multiplier as number}x`]);
  const baseOfficial = finalOfficial ? null : officialPayout(metadata, [`mm:${payoutKey}:base`]);
  const prize = finalOfficial
    ? finalOfficial.cents
    : (baseOfficial?.cents ?? base[1]) * (multiplier as number);
  const payoutDetail = finalOfficial ?? baseOfficial;
  return fixed(mainMatches, bonusMatches, `${base[0]} with ${multiplier as number}X`, prize, {
    megaMultiplier: multiplier,
    multiplierProvenance: options.multiplierProvenance ?? "modeled",
    ...(payoutDetail ? officialPayoutDetail(payoutDetail) : {})
  });
}

function digitStyle(
  value: string
): "straight" | "box" | "straight-box" | "combo" | "front-pair" | "mid-pair" | "back-pair" {
  const style = value.trim().toLowerCase();
  if (["straight", "exact", "exact-order"].includes(style)) return "straight";
  if (["box", "anybox", "any-order"].includes(style)) return "box";
  if (
    [
      "straight-box",
      "straight/box",
      "straight+box",
      "exact-any",
      "exact/any",
      "exact-any-order",
      "exact/any-order",
      "exact/anybox"
    ].includes(style)
  )
    return "straight-box";
  if (style === "combo") return "combo";
  if (style === "front-pair") return "front-pair";
  if (style === "mid-pair" || style === "middle-pair") return "mid-pair";
  if (style === "back-pair") return "back-pair";
  throw new Error(`Unsupported stored digit play style ${JSON.stringify(value)}`);
}

function isPairDigitStyle(value: string): boolean {
  const style = digitStyle(value);
  return style === "front-pair" || style === "mid-pair" || style === "back-pair";
}

function baseDigitGrade(
  game: "p3" | "d4",
  ticket: readonly number[],
  result: readonly number[],
  playStyle: string,
  stakeCents: number
): GradeResult {
  const style = digitStyle(playStyle);
  const exactMatch = exact(ticket, result);
  const anyMatch = multisetKey(ticket) === multisetKey(result);
  const positionalMatches = ticket.reduce(
    (total, digit, index) => total + (digit === result[index] ? 1 : 0),
    0
  );
  const scale = stakeCents / 50;
  if (style === "front-pair" || style === "mid-pair" || style === "back-pair") {
    if (game !== "d4") throw new Error("Pair play applies only to Daily 4");
    const offset = style === "front-pair" ? 0 : style === "mid-pair" ? 1 : 2;
    return ticket[offset] === result[offset] && ticket[offset + 1] === result[offset + 1]
      ? fixed(positionalMatches, 0, `${style} match`, 2_500 * scale, { stakeCents })
      : miss(positionalMatches, 0, { stakeCents });
  }
  const ways = digitWays(ticket);
  if (style !== "straight" && ways === 1)
    throw new Error("All-same digit ticket cannot use box or combo play");
  const straightPrize = (game === "p3" ? 25_000 : 250_000) * scale;
  const boxPrize =
    (game === "p3"
      ? ways === 3
        ? 8_000
        : 4_000
      : ways === 4
        ? 60_000
        : ways === 6
          ? 40_000
          : ways === 12
            ? 20_000
            : 10_000) * scale;
  if (style === "straight" && exactMatch)
    return fixed(positionalMatches, 0, "straight", straightPrize, { stakeCents, ways });
  if (style === "box" && anyMatch)
    return fixed(positionalMatches, 0, `${ways}-way box`, boxPrize, { stakeCents, ways });
  if (style === "straight-box" && anyMatch)
    return fixed(
      positionalMatches,
      0,
      exactMatch ? "straight + box" : "box only",
      exactMatch ? straightPrize + boxPrize : boxPrize,
      { stakeCents, ways }
    );
  if (style === "combo" && anyMatch)
    return fixed(positionalMatches, 0, `${ways}-way combo`, straightPrize, { stakeCents, ways });
  return miss(positionalMatches, 0, { stakeCents, ways });
}

function gradeDigits(
  game: "p3" | "d4",
  ticket: readonly number[],
  result: readonly number[],
  playStyle: string,
  options: Record<string, unknown>,
  metadata: Record<string, unknown>
): GradeResult {
  if (
    !Number.isSafeInteger(options.stakeCents) ||
    !LEGAL_STAKES.has(options.stakeCents as number)
  ) {
    throw new Error("digit ticket is missing a valid immutable stakeCents value");
  }
  const stake = options.stakeCents as number;
  const base = baseDigitGrade(game, ticket, result, playStyle, stake);
  if (options.fireball !== true) return { ...base, detail: { ...base.detail, fireball: false } };
  const fireball = metadata.feature_name === "fireball" ? metadata.feature_value : null;
  if (!Number.isSafeInteger(fireball) || (fireball as number) < 0 || (fireball as number) > 9) {
    return pending(
      base.mainMatches,
      0,
      base.hit ? `${base.tier} + FIREBALL review` : "FIREBALL review",
      "Official FIREBALL number is unavailable",
      "missing-result-evidence",
      { ...base.detail, basePrizeCents: base.prizeCents, fireball: true }
    );
  }
  const variants = result.map((_, index) =>
    result.map((value, position) => (position === index ? (fireball as number) : value))
  );
  const style = digitStyle(playStyle);
  const ways = digitWays(ticket);
  const anyAward =
    game === "p3"
      ? ways === 3
        ? 60
        : 30
      : ways === 4
        ? 340
        : ways === 6
          ? 224
          : ways === 12
            ? 112
            : 56;
  const straightAward = game === "p3" ? 180 : 1_350;
  const awardFor = (variant: readonly number[]): number => {
    const exactMatch = exact(ticket, variant);
    const anyMatch = multisetKey(ticket) === multisetKey(variant);
    if (style === "front-pair" || style === "mid-pair" || style === "back-pair") {
      const offset = style === "front-pair" ? 0 : style === "mid-pair" ? 1 : 2;
      return ticket[offset] === variant[offset] && ticket[offset + 1] === variant[offset + 1]
        ? 14 * stake
        : 0;
    }
    if (style === "straight") return exactMatch ? straightAward * stake : 0;
    if (style === "box") return anyMatch ? anyAward * stake : 0;
    if (style === "straight-box") {
      return anyMatch ? anyAward * stake + (exactMatch ? straightAward * stake : 0) : 0;
    }
    return anyMatch ? straightAward * stake : 0; // Combo covers every straight permutation.
  };
  const awards = variants.map(awardFor);
  const fireballWins = awards.filter((amount) => amount > 0).length;
  const fireballPrizeCents = awards.reduce((total, amount) => total + amount, 0);
  if (fireballWins === 0) {
    return {
      ...base,
      detail: {
        ...base.detail,
        fireball: true,
        fireballNumber: fireball,
        fireballWins: 0,
        fireballPrizeCents: 0
      }
    };
  }
  const basePrizeCents = base.payoutStatus === "fixed" ? (base.prizeCents ?? 0) : 0;
  return fixed(
    base.mainMatches,
    0,
    base.hit
      ? `${base.tier} + FIREBALL (${fireballWins} win${fireballWins === 1 ? "" : "s"})`
      : `FIREBALL (${fireballWins} win${fireballWins === 1 ? "" : "s"})`,
    basePrizeCents + fireballPrizeCents,
    {
      ...base.detail,
      basePrizeCents,
      fireball: true,
      fireballNumber: fireball,
      fireballWins,
      fireballPrizeCents,
      replacementAwardsCents: awards
    }
  );
}

function gradeAllOrNothing(mainMatches: number, metadata: Record<string, unknown>): GradeResult {
  const prizes = new Map<number, number>([
    [11, 50_000],
    [10, 5_000],
    [9, 1_000],
    [8, 200],
    [4, 200],
    [3, 1_000],
    [2, 5_000],
    [1, 50_000]
  ]);
  if (mainMatches === 12 || mainMatches === 0) {
    const winners = certifiedWinnerCount(metadata, [
      "aon_combined_top_prize_winner_count",
      "official_combined_top_prize_winner_count"
    ]);
    if (winners) {
      const prizeCents =
        winners.count <= 20 ? 25_000_000 : wholeDollarCapShare(500_000_000, winners.count);
      return fixed(mainMatches, 0, `${mainMatches} of 12 — top prize`, prizeCents, {
        nominalPrizeCents: 25_000_000,
        liabilityCapCents: 500_000_000,
        combinedWinnerCount: winners.count,
        winnerCountKey: winners.key,
        threshold: 20,
        wholeDollarRounding: "down",
        payoutProvenance: "fingerprinted-certified-winner-count",
        officialPayoutSource: winners.source,
        officialPayoutSourceSha256: winners.sourceSha256
      });
    }
    return pending(
      mainMatches,
      0,
      `${mainMatches} of 12 — top prize`,
      "The $250,000 nominal top prize is liability-capped; enter the official realized payout",
      "official-payout",
      {
        nominalPrizeCents: 25_000_000,
        liabilityCapCents: 500_000_000,
        liabilityGame: "aon",
        maximumSettlementCents: 25_000_000,
        wholeDollarSettlement: true,
        liabilityRule:
          "nominal through 20 combined 12-of-12/0-of-12 winners; above 20 divide $5,000,000 and round down"
      }
    );
  }
  const prize = prizes.get(mainMatches);
  return prize === undefined
    ? miss(mainMatches, 0)
    : fixed(mainMatches, 0, `${mainMatches} of 12`, prize);
}

/** Grade one immutable ticket snapshot using current official-rule tables. */
export function gradeTicket(
  game: GameCode,
  ticket: {
    readonly main: readonly number[];
    readonly bonus: readonly number[];
    readonly playStyle: string;
    readonly options: Readonly<Record<string, unknown>>;
  },
  result: {
    readonly drawDate: string;
    readonly main: readonly number[];
    readonly bonus: readonly number[];
    readonly metadata: Readonly<Record<string, unknown>>;
  }
): GradeResult {
  const drawDate = isoDate(result.drawDate, "result drawDate");
  validateLedgerTicket(game, {
    game,
    main: ticket.main,
    bonus: ticket.bonus,
    playStyle: ticket.playStyle as DigitPlayStyle
  });
  validateTicket(game, {
    game,
    main: result.main,
    bonus: result.bonus,
    playStyle: "straight"
  });
  if (drawDate < GAME_MANIFEST[game].auditStart) {
    throw new RangeError(
      `${GAME_MANIFEST[game].name} result predates the configured current-rule era`
    );
  }
  if (game === "lotto" && ticket.options.extra === true && drawDate < LOTTO_EXTRA_EFFECTIVE_DATE) {
    throw new RangeError(
      `Lotto Texas Extra was not available before ${LOTTO_EXTRA_EFFECTIVE_DATE}`
    );
  }
  if (
    (game === "p3" || game === "d4") &&
    ticket.options.fireball === true &&
    drawDate < FIREBALL_EFFECTIVE_DATE
  ) {
    throw new RangeError(`FIREBALL was not available before ${FIREBALL_EFFECTIVE_DATE}`);
  }
  const mainMatches = GAME_MANIFEST[game].kind === "digits" ? 0 : matches(ticket.main, result.main);
  const bonusMatches = GAME_MANIFEST[game].bonus ? matches(ticket.bonus, result.bonus) : 0;
  if (game === "lotto")
    return gradeLotto(mainMatches, ticket.options, result.metadata as Record<string, unknown>);
  if (game === "twostep")
    return gradeTwoStep(mainMatches, bonusMatches, result.metadata as Record<string, unknown>);
  if (game === "cash5")
    return gradeCashFive(mainMatches, result.metadata as Record<string, unknown>);
  if (game === "pb")
    return gradePowerball(
      mainMatches,
      bonusMatches,
      ticket.options,
      result.metadata as Record<string, unknown>
    );
  if (game === "mm")
    return gradeMegaMillions(
      mainMatches,
      bonusMatches,
      ticket.options,
      result.metadata as Record<string, unknown>
    );
  if (game === "p3" || game === "d4")
    return gradeDigits(
      game,
      ticket.main,
      result.main,
      ticket.playStyle,
      ticket.options,
      result.metadata as Record<string, unknown>
    );
  return gradeAllOrNothing(mainMatches, result.metadata as Record<string, unknown>);
}

function actualTicketOverrides(
  value: Record<string, unknown>,
  ordinal: number
): Record<string, unknown> {
  const ticketOptions = value.ticketOptions;
  if (Array.isArray(ticketOptions)) {
    const found = ticketOptions.find(
      (candidate) => isRecord(candidate) && candidate.ordinal === ordinal
    );
    return found && isRecord(found.options) ? found.options : {};
  }
  if (isRecord(ticketOptions)) {
    const found = ticketOptions[String(ordinal)];
    return isRecord(found) ? found : {};
  }
  return {};
}

function isJackpotTier(tier: string): boolean {
  return tier.toLowerCase().includes("jackpot") || tier.includes("top prize");
}

function displayDate(drawDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric"
  }).format(new Date(`${drawDate}T12:00:00Z`));
}

function signedPercent(value: number | null): string {
  if (value === null) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

async function notificationMessage(
  env: Env,
  ledger: LedgerRow,
  gradeResults: readonly GradeResult[]
): Promise<{ message: string; priority: number; targetRole: "primary" | "fallback" }> {
  const summary = await readTrackRecord(env, { game: null, from: null, to: null });
  const system = summary.comparisons.find((item) => item.origin === "system");
  const random = summary.comparisons.find((item) => item.origin === "random");
  const bestMatches = Math.max(...gradeResults.map((grade) => grade.mainMatches));
  const best = gradeResults
    .filter((grade) => grade.hit)
    .sort((left, right) => {
      if (isJackpotTier(left.tier) !== isJackpotTier(right.tier)) {
        return isJackpotTier(right.tier) ? 1 : -1;
      }
      if (left.payoutStatus !== right.payoutStatus) {
        if (left.payoutStatus === "pending") return -1;
        if (right.payoutStatus === "pending") return 1;
      }
      return (right.prizeCents ?? 0) - (left.prizeCents ?? 0);
    })[0];
  const jackpot = gradeResults.some((grade) => grade.hit && isJackpotTier(grade.tier));
  const nonCash = gradeResults.find(
    (grade) => grade.hit && typeof grade.detail.nonCashPrize === "string"
  );
  const result = best
    ? nonCash === best
      ? `WIN — free Cash Five Quick Pick (non-cash)`
      : `WIN — ${best.tier}${best.prizeCents === null ? " (official payout pending)" : `, $${(best.prizeCents / 100).toFixed(2)}`}`
    : `${bestMatches}/${GAME_MANIFEST[ledger.game].main.count}`;
  const claim = jackpot
    ? " PRIORITY: sign and secure the physical ticket, photograph both sides, disclose it to nobody, and contact the Texas Lottery claim center/qualified counsel."
    : "";
  return {
    message:
      `🐰 Ticket Lab — ${GAME_MANIFEST[ledger.game].name} (${displayDate(ledger.draw_date)}): ` +
      `${result}. Ledger: ${summary.totals.proposals.gradedTickets} ticket lines graded lifetime, ` +
      `cash ROI ${signedPercent(system?.roiPercent ?? null)}; random baseline cash ROI ` +
      `${signedPercent(random?.roiPercent ?? null)}. Next best-EV game: none today.${claim} ` +
      TICKET_LAB_DISCLAIMER,
    priority: jackpot ? 100 : best ? 50 : 10,
    targetRole: "primary"
  };
}

interface NotificationGradeRow {
  main_matches: number;
  bonus_matches: number;
  prize_tier: string;
  hit: number;
  payout_status: PayoutStatus;
  prize_cents: number | null;
  pending_reason: string | null;
  grading_detail_json: string;
}

/** Repair the crash seam between immutable grade commits and mutable delivery enqueueing. */
export async function reconcileResultNotifications(
  env: Env,
  game: GameCode | null = null,
  now = new Date()
): Promise<number> {
  const query = await env.LOTTO_DB.prepare(
    `WITH latest AS (
       SELECT ledger_id, MAX(revision) AS revision
       FROM lotto_ledger_grades GROUP BY ledger_id
     )
     SELECT l.*, g.grade_id
     FROM latest x
     JOIN lotto_ledger_grades g
       ON g.ledger_id = x.ledger_id AND g.revision = x.revision
     JOIN lotto_ticket_ledger l ON l.ledger_id = g.ledger_id
     WHERE l.origin <> 'random'
       AND (?1 IS NULL OR l.game = ?1)
       AND NOT EXISTS (
         SELECT 1 FROM lotto_lab_delivery_outbox o WHERE o.grade_id = g.grade_id
       )
     ORDER BY l.draw_date, l.ledger_id
     LIMIT 100`
  )
    .bind(game)
    .all<LedgerRow & { grade_id: string }>();
  let queued = 0;
  for (const candidate of query.results) {
    const rows = await env.LOTTO_DB.prepare(
      `SELECT main_matches, bonus_matches, prize_tier, hit, payout_status, prize_cents,
              pending_reason, grading_detail_json
       FROM lotto_ticket_grades WHERE grade_id = ?1 ORDER BY ticket_grade_id`
    )
      .bind(candidate.grade_id)
      .all<NotificationGradeRow>();
    const grades: GradeResult[] = rows.results.map((row) => ({
      mainMatches: Number(row.main_matches),
      bonusMatches: Number(row.bonus_matches),
      tier: row.prize_tier,
      hit: row.hit === 1,
      payoutStatus: row.payout_status,
      prizeCents: row.prize_cents === null ? null : Number(row.prize_cents),
      pendingReason: row.pending_reason,
      detail: decodeRecord(row.grading_detail_json, "grading detail")
    }));
    if (grades.length !== candidate.ticket_count) {
      throw new Error(`Grade ${candidate.grade_id} ticket count does not reconcile`);
    }
    const notification = await notificationMessage(env, candidate, grades);
    const queuedAt = now.toISOString();
    const result = await env.LOTTO_DB.prepare(
      `INSERT OR IGNORE INTO lotto_lab_delivery_outbox
         (delivery_id, grade_id, run_id, game, draw_date, delivery_kind, target_role,
          priority, message_body, status, next_attempt_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'result', ?6, ?7, ?8, 'pending', ?9, ?9, ?9)`
    )
      .bind(
        `result-${candidate.grade_id}`,
        candidate.grade_id,
        candidate.run_id ?? candidate.ledger_id,
        candidate.game,
        candidate.draw_date,
        notification.targetRole,
        notification.priority,
        notification.message,
        queuedAt
      )
      .run();
    queued += result.meta.changes ?? 0;
  }
  return queued;
}

/** Queue a high-priority fallback alert when post-ingest grading cannot complete. */
export async function queueGradingFailureAlert(
  env: Env,
  game: GameCode,
  failure: unknown,
  now = new Date()
): Promise<string> {
  const serviceDate = texasDate(now);
  const failureText = (failure instanceof Error ? failure.message : String(failure)).slice(
    0,
    1_000
  );
  const deliveryId = `lab-alert-${(await sha256(`${game}\0${serviceDate}\0${failureText}`)).slice(0, 32)}`;
  const message = (
    `🚨 RabbitHoleTX ALERT — Ticket Lab grading failed for ${GAME_MANIFEST[game].name} ` +
    `(${serviceDate}); needs attention. ${failureText} ${TICKET_LAB_DISCLAIMER}`
  ).slice(0, 2_000);
  const queuedAt = now.toISOString();
  await env.LOTTO_DB.prepare(
    `INSERT INTO lotto_lab_delivery_outbox
       (delivery_id, grade_id, run_id, game, draw_date, delivery_kind, target_role,
        priority, message_body, status, next_attempt_at, created_at, updated_at)
     VALUES (?1, NULL, ?2, ?3, ?4, 'alert', 'fallback', 100, ?5, 'pending', ?6, ?6, ?6)
     ON CONFLICT(delivery_id) DO UPDATE SET
       message_body = excluded.message_body,
       next_attempt_at = excluded.next_attempt_at,
       updated_at = excluded.updated_at
     WHERE lotto_lab_delivery_outbox.status IN ('pending', 'retry')`
  )
    .bind(deliveryId, `ticket-lab-${game}-${serviceDate}`, game, serviceDate, message, queuedAt)
    .run();
  return deliveryId;
}

/** Grade every entry whose exact official draw snapshot is now available. */
export async function gradeAvailableLedgerEntries(
  env: Env,
  game: GameCode,
  now = new Date()
): Promise<{ gradedEntries: number; gradedTickets: number }> {
  // Repair a prior crash immediately, even if a later malformed ledger blocks
  // this grading pass before it reaches the normal post-commit reconciliation.
  await reconcileResultNotifications(env, game, now);
  await reconcileLegacyRandomBaselines(env);
  const candidates = await env.LOTTO_DB.prepare(
    `WITH latest AS (
       SELECT ledger_id, MAX(revision) AS revision
       FROM lotto_ledger_grades GROUP BY ledger_id
     )
     SELECT l.*, d.game AS draw_game, d.draw_date AS result_draw_date,
            d.session AS result_session, d.ordered_numbers, d.bonus_numbers,
            d.metadata, d.content_fingerprint, d.source_id, d.source_sha256
     FROM lotto_ticket_ledger l
     JOIN lotto_draws d
       ON d.game = l.game AND d.draw_date = l.draw_date
      AND d.session = l.target_session AND d.active = 1
     LEFT JOIN latest x ON x.ledger_id = l.ledger_id
     LEFT JOIN lotto_ledger_grades prior
       ON prior.ledger_id = x.ledger_id AND prior.revision = x.revision
     WHERE l.game = ?1
       AND (prior.grade_id IS NULL OR prior.draw_fingerprint <> d.content_fingerprint)
     ORDER BY l.draw_date, l.ledger_id`
  )
    .bind(game)
    .all<LedgerRow & DrawRow>();
  let gradedEntries = 0;
  let gradedTickets = 0;
  for (const candidate of candidates.results) {
    if (candidate.draw_date < GAME_MANIFEST[candidate.game].auditStart) {
      throw new Error(
        `Ledger ${candidate.ledger_id} predates the configured ${candidate.game} rule era; use a versioned historical rule table`
      );
    }
    const tickets = await env.LOTTO_DB.prepare(
      `SELECT ledger_ticket_id, ledger_id, ordinal, main_numbers, bonus_numbers,
              play_style, wager_cents, ticket_options_json, split_risk_basis_points,
              split_risk_level, split_risk_notes
       FROM lotto_ledger_tickets WHERE ledger_id = ?1 ORDER BY ordinal`
    )
      .bind(candidate.ledger_id)
      .all<LedgerTicketRow>();
    if (tickets.results.length !== candidate.ticket_count) {
      throw new Error(`Ledger ${candidate.ledger_id} ticket count does not reconcile`);
    }
    const prior = await env.LOTTO_DB.prepare(
      `SELECT grade_id, revision FROM lotto_ledger_grades
       WHERE ledger_id = ?1 ORDER BY revision DESC LIMIT 1`
    )
      .bind(candidate.ledger_id)
      .first<{ grade_id: string; revision: number }>();
    const purchase = await env.LOTTO_DB.prepare(
      `SELECT purchase_event_id, ledger_id, purchased, spend_cents, source, note,
              options_json, recorded_at
       FROM lotto_purchase_confirmation_events
       WHERE ledger_id = ?1 ORDER BY recorded_at DESC, purchase_event_id DESC LIMIT 1`
    )
      .bind(candidate.ledger_id)
      .first<PurchaseRow>();
    const purchaseOptions =
      purchase?.purchased === 1 ? decodeRecord(purchase.options_json, "purchase options") : {};
    const resultMain = decodeIntegerArray(candidate.ordered_numbers, "result main numbers");
    const resultBonus = decodeIntegerArray(candidate.bonus_numbers, "result bonus numbers");
    const resultMetadata = decodeRecord(candidate.metadata, "result metadata");
    const results = tickets.results.map((ticket) => {
      const persistedOptions = decodeRecord(ticket.ticket_options_json, "ticket options");
      const override = actualTicketOverrides(purchaseOptions, ticket.ordinal);
      const options = { ...persistedOptions, ...override };
      if (override.megaMultiplier !== undefined) options.multiplierProvenance = "actual-purchase";
      return gradeTicket(
        candidate.game,
        {
          main: decodeIntegerArray(ticket.main_numbers, "ticket main numbers"),
          bonus: decodeIntegerArray(ticket.bonus_numbers, "ticket bonus numbers"),
          playStyle: ticket.play_style,
          options
        },
        {
          drawDate: candidate.draw_date,
          main: resultMain,
          bonus: resultBonus,
          metadata: resultMetadata
        }
      );
    });
    const revision = Number(prior?.revision ?? 0) + 1;
    const gradeId = `grade-${(await sha256(`${candidate.ledger_id}\0${candidate.content_fingerprint}`)).slice(0, 32)}`;
    const gradedAt = now.toISOString();
    const statements: D1PreparedStatement[] = [
      env.LOTTO_DB.prepare(
        `INSERT OR IGNORE INTO lotto_ledger_grades
           (grade_id, ledger_id, revision, supersedes_grade_id, draw_fingerprint,
            result_main_numbers, result_bonus_numbers, result_session, result_source_id,
            result_source_sha256, hit_count, pending_prize_count, known_prize_cents,
            rule_version, graded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
      ).bind(
        gradeId,
        candidate.ledger_id,
        revision,
        prior?.grade_id ?? null,
        candidate.content_fingerprint,
        JSON.stringify(resultMain),
        JSON.stringify(resultBonus),
        candidate.target_session,
        candidate.source_id,
        candidate.source_sha256,
        results.filter((result) => result.hit).length,
        results.filter((result) => result.payoutStatus === "pending").length,
        results.reduce(
          (total, result) =>
            total + (result.payoutStatus === "fixed" ? (result.prizeCents ?? 0) : 0),
          0
        ),
        RULE_VERSION,
        gradedAt
      )
    ];
    results.forEach((result, index) => {
      const ticket = tickets.results[index];
      if (!ticket) throw new Error("Ledger ticket ordering changed during grading");
      statements.push(
        env.LOTTO_DB.prepare(
          `INSERT OR IGNORE INTO lotto_ticket_grades
             (ticket_grade_id, grade_id, ledger_ticket_id, main_matches, bonus_matches,
              prize_tier, hit, payout_status, prize_cents, pending_reason,
              grading_detail_json, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
        ).bind(
          `tg-${gradeId.slice(6)}-${ticket.ordinal}`,
          gradeId,
          ticket.ledger_ticket_id,
          result.mainMatches,
          result.bonusMatches,
          result.tier,
          result.hit ? 1 : 0,
          result.payoutStatus,
          result.prizeCents,
          result.pendingReason,
          JSON.stringify(result.detail),
          gradedAt
        )
      );
    });
    const committed = await env.LOTTO_DB.batch(statements);
    if ((committed[0]?.meta.changes ?? 0) !== 1) continue;
    gradedEntries += 1;
    gradedTickets += results.length;
    console.log(
      JSON.stringify({
        service: "rabbitholetx",
        event: "ticket_lab_graded",
        ledgerId: candidate.ledger_id,
        gradeId,
        game,
        drawDate: candidate.draw_date,
        revision,
        hits: results.filter((result) => result.hit).length,
        pending: results.filter((result) => result.payoutStatus === "pending").length
      })
    );
  }
  await reconcileResultNotifications(env, game, now);
  return { gradedEntries, gradedTickets };
}

function digitPattern(
  values: readonly number[]
): "aaa" | "aab" | "abc" | "aaaa" | "aaab" | "aabb" | "aabc" | "abcd" {
  const counts = [
    ...new Map(
      values.map((value) => [value, values.filter((item) => item === value).length])
    ).values()
  ].sort((left, right) => right - left);
  if (values.length === 3) return counts[0] === 3 ? "aaa" : counts[0] === 2 ? "aab" : "abc";
  if (counts[0] === 4) return "aaaa";
  if (counts[0] === 3) return "aaab";
  if (counts[0] === 2 && counts[1] === 2) return "aabb";
  if (counts[0] === 2) return "aabc";
  return "abcd";
}

function normalizeTicketOptions(
  game: GameCode,
  raw: unknown,
  seed: string,
  ordinal: number,
  provenance = "modeled"
): Record<string, unknown> {
  const record = raw === undefined ? {} : raw;
  if (!isRecord(record)) throw new RangeError(`ticket ${ordinal} options must be an object`);
  const assertKnownKeys = (allowed: readonly string[]): void => {
    const unknown = Object.keys(record).find((key) => !allowed.includes(key));
    if (unknown) {
      throw new RangeError(`ticket ${ordinal} has unsupported option ${JSON.stringify(unknown)}`);
    }
  };
  if (game === "lotto") {
    assertKnownKeys(["extra"]);
    if (record.extra !== undefined && typeof record.extra !== "boolean")
      throw new RangeError("Lotto Extra must be boolean");
    return { extra: record.extra === true };
  }
  if (game === "pb") {
    assertKnownKeys(["powerPlay"]);
    if (record.powerPlay !== undefined && typeof record.powerPlay !== "boolean")
      throw new RangeError("Power Play must be boolean");
    return { powerPlay: record.powerPlay === true };
  }
  if (game === "mm") {
    assertKnownKeys(["megaMultiplier", "multiplierProvenance"]);
    const modeled = record.megaMultiplier === undefined;
    const multiplier = record.megaMultiplier ?? modeledMegaMultiplier(seed, ordinal, provenance);
    if (!Number.isSafeInteger(multiplier) || ![2, 3, 4, 5, 10].includes(multiplier as number))
      throw new RangeError("Mega Millions multiplier must be 2, 3, 4, 5, or 10");
    const suppliedProvenance = record.multiplierProvenance;
    if (
      suppliedProvenance !== undefined &&
      (typeof suppliedProvenance !== "string" ||
        !["actual-purchase", "modeled", "manual"].includes(suppliedProvenance))
    )
      throw new RangeError("Mega Millions multiplier provenance is invalid");
    return {
      megaMultiplier: multiplier,
      multiplierProvenance: suppliedProvenance ?? (modeled ? "modeled" : provenance)
    };
  }
  if (game === "p3" || game === "d4") {
    assertKnownKeys(["stakeCents", "fireball", "pairPosition"]);
    if (provenance === "manual" && record.stakeCents === undefined) {
      throw new RangeError("manual digit tickets require an explicit stakeCents value");
    }
    const stake = record.stakeCents ?? 50;
    if (!Number.isSafeInteger(stake) || !LEGAL_STAKES.has(stake as number))
      throw new RangeError("digit stakeCents must be 50, 100, 200, 300, 400, or 500");
    if (record.fireball !== undefined && typeof record.fireball !== "boolean")
      throw new RangeError("FIREBALL must be boolean");
    const pair = record.pairPosition ?? null;
    if (pair !== null && !["front", "mid", "back"].includes(pair as string))
      throw new RangeError("Daily 4 pairPosition must be front, mid, back, or null");
    if (game === "p3" && pair !== null)
      throw new RangeError("pairPosition applies only to Daily 4");
    return {
      stakeCents: stake,
      fireball: record.fireball === true,
      ...(game === "d4" ? { pairPosition: pair } : {})
    };
  }
  assertKnownKeys(["basePlay"]);
  if (record.basePlay !== undefined && record.basePlay !== true) {
    throw new RangeError("basePlay, when supplied, must be true");
  }
  return { basePlay: true };
}

interface AppendLedgerResult {
  readonly ledgerId: string;
  readonly created: boolean;
}

/** Append a pre-draw user or independently random ticket set. */
export async function appendLedgerEntry(
  env: Env,
  value: unknown,
  now = new Date()
): Promise<AppendLedgerResult> {
  if (!isRecord(value)) throw new RangeError("ledger entry must be an object");
  const origin = value.origin;
  if (origin !== "user" && origin !== "random") {
    throw new RangeError(
      "origin must be user or random; system entries come only from generation runs"
    );
  }
  const game = value.game;
  if (typeof game !== "string" || !(game in GAME_MANIFEST)) throw new RangeError("game is invalid");
  const typedGame = game as GameCode;
  const drawDate = isoDate(value.drawDate, "drawDate");
  const session = targetSession(typedGame, value.targetSession);
  const proposedAt = now.toISOString();
  const clientProposedAt =
    value.proposedAt === undefined ? null : isoTimestamp(value.proposedAt, "proposedAt");
  const idempotencyKey = boundedString(value.idempotencyKey, "idempotencyKey", 120, true) as string;
  if (idempotencyKey.length < 8)
    throw new RangeError("idempotencyKey must contain at least 8 characters");
  const seed =
    boundedString(value.seed, "seed", 256) ?? (await sha256(`manual-seed\0${idempotencyKey}`));
  const correctionOf = boundedString(value.correctionOf, "correctionOf", 64);
  if (correctionOf) {
    const corrected = await env.LOTTO_DB.prepare(
      `SELECT game, draw_date, target_session FROM lotto_ticket_ledger WHERE ledger_id = ?1`
    )
      .bind(correctionOf)
      .first<{ game: GameCode; draw_date: string; target_session: Session }>();
    if (!corrected) throw new RangeError("correctionOf ledger entry was not found");
    if (
      corrected.game !== typedGame ||
      corrected.draw_date !== drawDate ||
      corrected.target_session !== session
    ) {
      throw new RangeError("a correction must keep the original game, draw date, and session");
    }
  }
  const rawTickets = value.tickets;
  if (!Array.isArray(rawTickets) || rawTickets.length < 1 || rawTickets.length > 50)
    throw new RangeError("tickets must contain 1 through 50 entries");
  const normalized = rawTickets.map((raw, index) => {
    if (!isRecord(raw)) throw new RangeError(`ticket ${index + 1} must be an object`);
    const main = raw.main;
    const bonus = raw.bonus ?? [];
    if (!Array.isArray(main) || !Array.isArray(bonus))
      throw new RangeError(`ticket ${index + 1} numbers must be arrays`);
    const playStyle = typeof raw.playStyle === "string" ? raw.playStyle : "straight";
    const ticket = validateLedgerTicket(typedGame, {
      game: typedGame,
      main: main as number[],
      bonus: bonus as number[],
      playStyle: playStyle as DigitPlayStyle
    });
    const options = normalizeTicketOptions(
      typedGame,
      raw.options,
      seed,
      index + 1,
      origin === "user" ? "manual" : "modeled"
    );
    const wagerCents =
      typedGame === "p3" || typedGame === "d4"
        ? (options.stakeCents as number)
        : GAME_MANIFEST[typedGame].baseCostCents;
    const style =
      typedGame === "p3" || typedGame === "d4"
        ? digitStyle(ticket.playStyle ?? "straight")
        : "straight";
    if (typedGame === "d4") {
      const expectedPair =
        style === "front-pair"
          ? "front"
          : style === "mid-pair"
            ? "mid"
            : style === "back-pair"
              ? "back"
              : null;
      if (options.pairPosition !== null && options.pairPosition !== expectedPair) {
        throw new RangeError("Daily 4 pairPosition must match the selected pair play style");
      }
      options.pairPosition = expectedPair;
    }
    const digitBoardCost =
      style === "straight-box"
        ? wagerCents * 2
        : style === "combo"
          ? wagerCents * digitWays(ticket.main)
          : wagerCents;
    const baseCost = typedGame === "p3" || typedGame === "d4" ? digitBoardCost : wagerCents;
    const costCents =
      baseCost +
      (typedGame === "lotto" && options.extra === true ? 100 : 0) +
      (typedGame === "pb" && options.powerPlay === true ? 100 : 0) +
      ((typedGame === "p3" || typedGame === "d4") && options.fireball === true ? baseCost : 0);
    const analyticsTicket = isPairDigitStyle(ticket.playStyle ?? "straight")
      ? ({ ...ticket, playStyle: "straight" } as Ticket)
      : ticket;
    return {
      ticket,
      analyticsTicket,
      options,
      wagerCents,
      costCents,
      splitRisk: scoreSplitRisk(typedGame, analyticsTicket)
    };
  });
  if (new Set(normalized.map((item) => ticketKey(item.ticket))).size !== normalized.length)
    throw new RangeError("ledger ticket set contains duplicates");
  const firstCost = normalized[0]?.costCents as number;
  if (normalized.some((item) => item.costCents !== firstCost))
    throw new RangeError("every ticket in one ledger entry must have the same play cost");
  const coverage = calculatePairCoverage(
    typedGame,
    normalized.map((item) => item.analyticsTicket)
  );
  let calculatedEv: number;
  let assumption: string;
  const requiresCallerEv = normalized.some(
    (item) =>
      item.options.fireball === true || (typedGame === "pb" && item.options.powerPlay === true)
  );
  if (requiresCallerEv) {
    calculatedEv = signedCents(value.evNetCents, "evNetCents");
    assumption = boundedString(value.evAssumption, "evAssumption", 2_000, true) as string;
  } else {
    const first = normalized[0] as (typeof normalized)[number];
    const ev = calculateEv({
      game: typedGame,
      jackpotCents: 0,
      ticketSales: 0,
      popularityMultiplier: 1,
      extra: typedGame === "lotto" ? first.options.extra === true : undefined,
      stakeCents:
        typedGame === "p3" || typedGame === "d4"
          ? (first.wagerCents as 50 | 100 | 200 | 300 | 400 | 500)
          : undefined,
      playStyle:
        typedGame === "p3" || typedGame === "d4"
          ? (first.ticket.playStyle as DigitPlayStyle)
          : undefined,
      digitPattern:
        (typedGame === "p3" || typedGame === "d4") &&
        !isPairDigitStyle(first.ticket.playStyle ?? "straight")
          ? digitPattern(first.ticket.main)
          : undefined
    });
    calculatedEv = Math.round(ev.netEvCents);
    assumption =
      "Pre-tax current-rule EV captured when the immutable ledger entry was appended; rollover jackpot excluded.";
  }
  const ledgerId = `ledger-${(await sha256(`manual\0${origin}\0${idempotencyKey}`)).slice(0, 32)}`;
  const observed = await env.LOTTO_DB.prepare(
    `SELECT MIN(latest_draw_date) AS observed_through,
            group_concat(COALESCE(last_digest, ''), '|') AS digests
     FROM lotto_sources WHERE game = ?1 AND enabled = 1`
  )
    .bind(typedGame)
    .first<{ observed_through: string | null; digests: string | null }>();
  const requestFingerprint = await sha256(
    JSON.stringify({
      origin,
      correctionOf,
      game: typedGame,
      drawDate,
      targetSession: session,
      clientProposedAt,
      seed,
      evNetCents: calculatedEv,
      evAssumption: assumption,
      tickets: normalized.map((item) => ({
        main: item.ticket.main,
        bonus: item.ticket.bonus ?? [],
        playStyle: item.ticket.playStyle ?? "straight",
        options: item.options,
        wagerCents: item.wagerCents,
        costCents: item.costCents
      }))
    })
  );
  const splitModel = JSON.stringify({
    model: origin === "random" ? "independent random" : "user supplied",
    version: 1,
    requestFingerprint,
    clientProposedAt
  });
  const priorEntry = await env.LOTTO_DB.prepare(
    `SELECT split_risk_model_json FROM lotto_ticket_ledger WHERE ledger_id = ?1`
  )
    .bind(ledgerId)
    .first<{ split_risk_model_json: string }>();
  if (priorEntry) {
    if (
      decodeRecord(priorEntry.split_risk_model_json, "split-risk model").requestFingerprint !==
      requestFingerprint
    ) {
      throw new RangeError(
        "idempotency key conflicts with different immutable ledger entry content"
      );
    }
    return { ledgerId, created: false };
  }
  const salesWindow = ticketSalesWindow(typedGame, drawDate, session, now);
  if (!salesWindow.isDrawDay)
    throw new RangeError(`${GAME_MANIFEST[typedGame].name} does not draw on ${drawDate}`);
  if (!salesWindow.beforeCutoff)
    throw new RangeError(
      `the pre-draw ledger closed at ${salesWindow.cutoffLocalTime} for ${drawDate}`
    );
  const existingResult = await env.LOTTO_DB.prepare(
    `SELECT 1 AS found FROM lotto_draws
     WHERE game = ?1 AND draw_date = ?2 AND session = ?3 AND active = 1 LIMIT 1`
  )
    .bind(typedGame, drawDate, session)
    .first<{ found: number }>();
  if (existingResult)
    throw new RangeError(
      "a matching official result already exists; post-draw ledger entries are forbidden"
    );
  const statements: D1PreparedStatement[] = [
    env.LOTTO_DB.prepare(
      `INSERT OR IGNORE INTO lotto_ticket_ledger
         (ledger_id, run_id, origin, correction_of, baseline_for, game, draw_date, target_session,
          proposed_at, seed, coverage_distinct_pairs, coverage_possible_pairs,
          coverage_basis_points, ev_net_cents, ev_assumption, ticket_cost_cents,
          ticket_count, split_risk_model_json, observed_through, dataset_digest, created_at)
       VALUES (?1, NULL, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
               ?14, ?15, ?16, ?17, ?18, ?7)`
    ).bind(
      ledgerId,
      origin,
      correctionOf,
      typedGame,
      drawDate,
      session,
      proposedAt,
      seed,
      coverage.distinctPairs,
      coverage.possiblePairs,
      Math.round(coverage.coveragePercent * 100),
      calculatedEv,
      assumption,
      firstCost,
      normalized.length,
      splitModel,
      observed?.observed_through ?? null,
      observed?.digests ? await sha256(observed.digests) : null
    )
  ];
  normalized.forEach((item, index) =>
    statements.push(
      env.LOTTO_DB.prepare(
        `INSERT OR IGNORE INTO lotto_ledger_tickets
         (ledger_ticket_id, ledger_id, ordinal, main_numbers, bonus_numbers, play_style,
          wager_cents, ticket_options_json, split_risk_basis_points, split_risk_level,
          split_risk_notes, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
       WHERE EXISTS (SELECT 1 FROM lotto_ticket_ledger WHERE ledger_id = ?2)`
      ).bind(
        `lt-${ledgerId.slice(7)}-${index + 1}`,
        ledgerId,
        index + 1,
        JSON.stringify(item.ticket.main),
        JSON.stringify(item.ticket.bonus ?? []),
        item.ticket.playStyle ?? "straight",
        item.wagerCents,
        JSON.stringify(item.options),
        Math.round(item.splitRisk.score * 100),
        item.splitRisk.level,
        JSON.stringify(item.splitRisk.notes),
        proposedAt
      )
    )
  );
  const result = await env.LOTTO_DB.batch(statements);
  const created = (result[0]?.meta.changes ?? 0) === 1;
  if (!created) {
    const existing = await env.LOTTO_DB.prepare(
      `SELECT split_risk_model_json FROM lotto_ticket_ledger WHERE ledger_id = ?1`
    )
      .bind(ledgerId)
      .first<{ split_risk_model_json: string }>();
    const persistedFingerprint = existing
      ? decodeRecord(existing.split_risk_model_json, "split-risk model").requestFingerprint
      : null;
    if (persistedFingerprint !== requestFingerprint) {
      throw new RangeError(
        "idempotency key conflicts with different immutable ledger entry content"
      );
    }
  }
  return { ledgerId, created };
}

function normalizedPurchaseOptions(
  ledger: LedgerRow,
  tickets: readonly LedgerTicketRow[],
  raw: unknown,
  purchased: boolean
): Record<string, unknown> {
  if (!isRecord(raw)) throw new RangeError("options must be an object");
  const unknownKeys = Object.keys(raw).filter((key) => key !== "ticketOptions");
  if (unknownKeys.length > 0)
    throw new RangeError(`unsupported purchase option ${JSON.stringify(unknownKeys[0])}`);
  const supplied = raw.ticketOptions;
  if (supplied === undefined) {
    if (purchased && ledger.game === "mm") {
      throw new RangeError(
        "confirmed Mega Millions purchases require the actual printed multiplier for every ticket"
      );
    }
    return { ticketOptions: [] };
  }
  const entries: Array<{ ordinal: number; options: Record<string, unknown> }> = [];
  if (Array.isArray(supplied)) {
    for (const item of supplied) {
      if (!isRecord(item) || !Number.isSafeInteger(item.ordinal) || !isRecord(item.options)) {
        throw new RangeError(
          "options.ticketOptions array entries require integer ordinal and options object"
        );
      }
      entries.push({ ordinal: item.ordinal as number, options: item.options });
    }
  } else if (isRecord(supplied)) {
    for (const [key, options] of Object.entries(supplied)) {
      if (!/^\d+$/.test(key) || !isRecord(options)) {
        throw new RangeError("options.ticketOptions must use positive ticket ordinals");
      }
      entries.push({ ordinal: Number(key), options });
    }
  } else {
    throw new RangeError("options.ticketOptions must be an array or ordinal-keyed object");
  }
  if (new Set(entries.map((entry) => entry.ordinal)).size !== entries.length) {
    throw new RangeError("options.ticketOptions contains a duplicate ordinal");
  }
  const ticketByOrdinal = new Map(tickets.map((ticket) => [ticket.ordinal, ticket]));
  const normalized = entries
    .map((entry) => {
      const ticket = ticketByOrdinal.get(entry.ordinal);
      if (!ticket) throw new RangeError(`ticket ordinal ${entry.ordinal} was not found`);
      if (
        ledger.game === "mm" &&
        purchased &&
        !Number.isSafeInteger(entry.options.megaMultiplier)
      ) {
        throw new RangeError(
          `ticket ${entry.ordinal} requires its actual printed Mega Millions multiplier`
        );
      }
      const persisted = decodeRecord(ticket.ticket_options_json, "ticket options");
      const effective = normalizeTicketOptions(
        ledger.game,
        {
          ...persisted,
          ...entry.options,
          ...(ledger.game === "mm" ? { multiplierProvenance: "actual-purchase" } : {})
        },
        ledger.seed ?? ledger.ledger_id,
        entry.ordinal,
        "actual-purchase"
      );
      if (ledger.game === "d4") {
        const style = digitStyle(ticket.play_style);
        const expectedPair =
          style === "front-pair"
            ? "front"
            : style === "mid-pair"
              ? "mid"
              : style === "back-pair"
                ? "back"
                : null;
        if (effective.pairPosition !== expectedPair) {
          throw new RangeError("Daily 4 pairPosition must match the immutable play style");
        }
      }
      return { ordinal: entry.ordinal, options: effective };
    })
    .sort((left, right) => left.ordinal - right.ordinal);
  if (purchased && ledger.game === "mm" && normalized.length !== tickets.length) {
    throw new RangeError(
      "confirmed Mega Millions purchases require the actual printed multiplier for every ticket"
    );
  }
  return { ticketOptions: normalized };
}

function effectiveTicketCostCents(
  game: GameCode,
  ticket: LedgerTicketRow,
  options: Record<string, unknown>
): number {
  if (game === "lotto") return 100 + (options.extra === true ? 100 : 0);
  if (game === "pb") return 200 + (options.powerPlay === true ? 100 : 0);
  if (game !== "p3" && game !== "d4") return GAME_MANIFEST[game].baseCostCents;
  const stake = Number(options.stakeCents ?? ticket.wager_cents);
  const style = digitStyle(ticket.play_style);
  const boardCost =
    style === "straight-box"
      ? stake * 2
      : style === "combo"
        ? stake * digitWays(decodeIntegerArray(ticket.main_numbers, "ticket main numbers"))
        : stake;
  return boardCost * (options.fireball === true ? 2 : 1);
}

export async function appendPurchaseConfirmation(
  env: Env,
  ledgerId: string,
  value: unknown,
  now = new Date()
): Promise<{ eventId: string; created: boolean }> {
  if (!/^ledger-[a-f0-9]{32}$/.test(ledgerId)) throw new RangeError("ledger id is malformed");
  if (!isRecord(value)) throw new RangeError("purchase confirmation must be an object");
  const ledger = await env.LOTTO_DB.prepare(
    `SELECT * FROM lotto_ticket_ledger WHERE ledger_id = ?1`
  )
    .bind(ledgerId)
    .first<LedgerRow>();
  if (!ledger) throw new RangeError("ledger entry was not found");
  if (typeof value.purchased !== "boolean") throw new RangeError("purchased must be boolean");
  const key = boundedString(value.idempotencyKey, "idempotencyKey", 120, true) as string;
  if (key.length < 8) throw new RangeError("idempotencyKey must contain at least 8 characters");
  if (value.recordedAt !== undefined) isoTimestamp(value.recordedAt, "recordedAt");
  const recordedAt = now.toISOString();
  const tickets = await env.LOTTO_DB.prepare(
    `SELECT ledger_ticket_id, ledger_id, ordinal, main_numbers, bonus_numbers,
            play_style, wager_cents, ticket_options_json, split_risk_basis_points,
            split_risk_level, split_risk_notes
     FROM lotto_ledger_tickets WHERE ledger_id = ?1 ORDER BY ordinal`
  )
    .bind(ledgerId)
    .all<LedgerTicketRow>();
  if (tickets.results.length !== ledger.ticket_count)
    throw new Error(`Ledger ${ledgerId} ticket count does not reconcile`);
  const options = normalizedPurchaseOptions(
    ledger,
    tickets.results,
    value.options ?? {},
    value.purchased
  );
  const optionOverrides = new Map(
    (
      (options.ticketOptions as Array<{ ordinal: number; options: Record<string, unknown> }>) ?? []
    ).map((entry) => [entry.ordinal, entry.options])
  );
  const expectedSpend = tickets.results.reduce((total, ticket) => {
    const persisted = decodeRecord(ticket.ticket_options_json, "ticket options");
    return (
      total +
      effectiveTicketCostCents(
        ledger.game,
        ticket,
        optionOverrides.get(ticket.ordinal) ?? persisted
      )
    );
  }, 0);
  const spend = safeCents(value.spendCents, "spendCents", value.purchased ? expectedSpend : 0);
  const source = boundedString(value.source, "source", 100, true) as string;
  const note = boundedString(value.note, "note", 1_000);
  const eventId = `purchase-${(await sha256(`${ledgerId}\0${key}`)).slice(0, 32)}`;
  const priorEvent = await env.LOTTO_DB.prepare(
    `SELECT purchased, spend_cents, source, note, options_json
     FROM lotto_purchase_confirmation_events WHERE purchase_event_id = ?1`
  )
    .bind(eventId)
    .first<{
      purchased: number;
      spend_cents: number;
      source: string;
      note: string | null;
      options_json: string;
    }>();
  if (priorEvent) {
    if (
      priorEvent.purchased !== (value.purchased ? 1 : 0) ||
      Number(priorEvent.spend_cents) !== spend ||
      priorEvent.source !== source ||
      priorEvent.note !== note ||
      priorEvent.options_json !== JSON.stringify(options)
    ) {
      throw new RangeError(
        "idempotency key conflicts with different purchase confirmation content"
      );
    }
    return { eventId, created: false };
  }
  if (value.purchased && spend !== expectedSpend) {
    throw new RangeError(`confirmed spendCents must equal the official play cost ${expectedSpend}`);
  }
  if (!value.purchased && spend !== 0) {
    throw new RangeError("a declined purchase must have zero spend");
  }
  const salesWindow = ticketSalesWindow(ledger.game, ledger.draw_date, ledger.target_session, now);
  if (!salesWindow.isDrawDay || !salesWindow.beforeCutoff) {
    throw new RangeError(
      `purchase confirmation closed at ${salesWindow.cutoffLocalTime} for ${ledger.draw_date}`
    );
  }
  const existingResult = await env.LOTTO_DB.prepare(
    `SELECT 1 AS found FROM lotto_draws
     WHERE game = ?1 AND draw_date = ?2 AND session = ?3 AND active = 1 LIMIT 1`
  )
    .bind(ledger.game, ledger.draw_date, ledger.target_session)
    .first<{ found: number }>();
  if (existingResult) {
    throw new RangeError(
      "a matching official result already exists; purchase confirmation is closed"
    );
  }
  const result = await env.LOTTO_DB.prepare(
    `INSERT OR IGNORE INTO lotto_purchase_confirmation_events
       (purchase_event_id, ledger_id, idempotency_key, purchased, spend_cents,
        source, note, options_json, recorded_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  )
    .bind(
      eventId,
      ledgerId,
      key,
      value.purchased ? 1 : 0,
      spend,
      source,
      note,
      JSON.stringify(options),
      recordedAt,
      now.toISOString()
    )
    .run();
  const created = (result.meta.changes ?? 0) === 1;
  if (!created) {
    const existing = await env.LOTTO_DB.prepare(
      `SELECT purchased, spend_cents, source, note, options_json
       FROM lotto_purchase_confirmation_events WHERE purchase_event_id = ?1`
    )
      .bind(eventId)
      .first<{
        purchased: number;
        spend_cents: number;
        source: string;
        note: string | null;
        options_json: string;
      }>();
    if (
      !existing ||
      existing.purchased !== (value.purchased ? 1 : 0) ||
      Number(existing.spend_cents) !== spend ||
      existing.source !== source ||
      existing.note !== note ||
      existing.options_json !== JSON.stringify(options)
    ) {
      throw new RangeError(
        "idempotency key conflicts with different purchase confirmation content"
      );
    }
  }
  return { eventId, created };
}

export async function appendGradeSettlement(
  env: Env,
  ticketGradeId: string,
  value: unknown,
  now = new Date()
): Promise<{ settlementId: string; created: boolean }> {
  if (!/^tg-[a-f0-9]{32}-\d+$/.test(ticketGradeId))
    throw new RangeError("ticket grade id is malformed");
  if (!isRecord(value)) throw new RangeError("grade settlement must be an object");
  const grade = await env.LOTTO_DB.prepare(
    `SELECT payout_status, grading_detail_json
     FROM lotto_ticket_grades WHERE ticket_grade_id = ?1`
  )
    .bind(ticketGradeId)
    .first<{ payout_status: PayoutStatus; grading_detail_json: string }>();
  if (!grade) throw new RangeError("ticket grade was not found");
  if (grade.payout_status !== "pending")
    throw new RangeError("only a pending prize can be settled");
  const gradingDetail = decodeRecord(grade.grading_detail_json, "grading detail");
  if (gradingDetail.settlementKind !== "official-payout") {
    throw new RangeError(
      "missing result evidence cannot be manually settled; correct the official draw and regrade"
    );
  }
  const key = boundedString(value.idempotencyKey, "idempotencyKey", 120, true) as string;
  if (key.length < 8) throw new RangeError("idempotencyKey must contain at least 8 characters");
  const finalPrizeCents = safeCents(value.finalPrizeCents, "finalPrizeCents");
  if (gradingDetail.wholeDollarSettlement === true && finalPrizeCents % 100 !== 0) {
    throw new RangeError("liability-capped settlements must be rounded down to whole dollars");
  }
  let source: string;
  try {
    source = officialHttpsSource(value.source, "source");
  } catch (caught) {
    throw new RangeError(caught instanceof Error ? caught.message : "source is invalid");
  }
  const sourceSha256 = boundedString(value.sourceSha256, "sourceSha256", 64, true) as string;
  if (!/^[a-f0-9]{64}$/i.test(sourceSha256)) {
    throw new RangeError("sourceSha256 must be a 64-hex SHA-256 digest");
  }
  const liabilityGame = gradingDetail.liabilityGame;
  let settlementEvidence: Record<string, unknown> = {
    settlementKind: "official-payout",
    officialSourceSha256: sourceSha256.toLowerCase()
  };
  if (liabilityGame === "cash5" || liabilityGame === "aon") {
    if (
      !Number.isSafeInteger(value.certifiedWinnerCount) ||
      (value.certifiedWinnerCount as number) < 1
    ) {
      throw new RangeError("certifiedWinnerCount must be a positive safe integer");
    }
    const winnerCount = value.certifiedWinnerCount as number;
    const threshold = liabilityGame === "cash5" ? 3 : 20;
    const nominalPrizeCents = liabilityGame === "cash5" ? 2_500_000 : 25_000_000;
    const liabilityCapCents = liabilityGame === "cash5" ? 7_500_000 : 500_000_000;
    const expectedPrizeCents =
      winnerCount <= threshold
        ? nominalPrizeCents
        : wholeDollarCapShare(liabilityCapCents, winnerCount);
    if (finalPrizeCents !== expectedPrizeCents) {
      throw new RangeError(
        `finalPrizeCents must equal ${expectedPrizeCents} for ${winnerCount} certified winner(s)`
      );
    }
    settlementEvidence = {
      ...settlementEvidence,
      liabilityGame,
      certifiedWinnerCount: winnerCount,
      threshold,
      nominalPrizeCents,
      liabilityCapCents,
      wholeDollarRounding: "down",
      expectedPrizeCents
    };
  } else if (value.certifiedWinnerCount !== undefined) {
    throw new RangeError("certifiedWinnerCount applies only to conditional top-prize settlements");
  }
  const requiredExtraCents = gradingDetail.requiredExtraCents;
  if (
    Number.isSafeInteger(requiredExtraCents) &&
    finalPrizeCents < (requiredExtraCents as number)
  ) {
    throw new RangeError(
      `the all-in Lotto Texas settlement must include at least ${requiredExtraCents as number} cents of EXTRA award`
    );
  }
  const maximumSettlementCents = gradingDetail.maximumSettlementCents;
  if (
    Number.isSafeInteger(maximumSettlementCents) &&
    finalPrizeCents > (maximumSettlementCents as number)
  ) {
    throw new RangeError(
      `settlement exceeds the official maximum of ${maximumSettlementCents as number} cents`
    );
  }
  const note = boundedString(value.note, "note", 1_000);
  const requestedSettledAt =
    value.settledAt === undefined ? null : isoTimestamp(value.settledAt, "settledAt");
  const settledAt = requestedSettledAt ?? now.toISOString();
  if (Date.parse(settledAt) > now.getTime() + 5_000)
    throw new RangeError("settledAt cannot be in the future");
  const settlementId = `settlement-${(await sha256(`${ticketGradeId}\0${key}`)).slice(0, 32)}`;
  const result = await env.LOTTO_DB.prepare(
    `INSERT OR IGNORE INTO lotto_grade_settlement_events
       (settlement_id, ticket_grade_id, idempotency_key, final_prize_cents,
        source, note, evidence_json, settled_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  )
    .bind(
      settlementId,
      ticketGradeId,
      key,
      finalPrizeCents,
      source,
      note,
      JSON.stringify(settlementEvidence),
      settledAt,
      now.toISOString()
    )
    .run();
  const created = (result.meta.changes ?? 0) === 1;
  if (!created) {
    const existing = await env.LOTTO_DB.prepare(
      `SELECT final_prize_cents, source, note, evidence_json, settled_at
       FROM lotto_grade_settlement_events WHERE settlement_id = ?1`
    )
      .bind(settlementId)
      .first<{
        final_prize_cents: number;
        source: string;
        note: string | null;
        evidence_json: string;
        settled_at: string;
      }>();
    if (
      !existing ||
      Number(existing.final_prize_cents) !== finalPrizeCents ||
      existing.source !== source ||
      existing.note !== note ||
      existing.evidence_json !== JSON.stringify(settlementEvidence) ||
      (requestedSettledAt !== null && existing.settled_at !== requestedSettledAt)
    ) {
      throw new RangeError("idempotency key conflicts with different grade settlement content");
    }
  }
  return { settlementId, created };
}

interface JoinedTrackRow extends LedgerRow, LedgerTicketRow {
  purchase_event_id: string | null;
  purchased: number | null;
  purchase_spend_cents: number | null;
  purchase_recorded_at: string | null;
  grade_id: string | null;
  revision: number | null;
  draw_fingerprint: string | null;
  result_main_numbers: string | null;
  result_bonus_numbers: string | null;
  result_session: string | null;
  result_source_id: string | null;
  result_source_sha256: string | null;
  graded_at: string | null;
  ticket_grade_id: string | null;
  main_matches: number | null;
  bonus_matches: number | null;
  prize_tier: string | null;
  hit: number | null;
  payout_status: PayoutStatus | null;
  prize_cents: number | null;
  pending_reason: string | null;
  grading_detail_json: string | null;
  settlement_id: string | null;
  final_prize_cents: number | null;
  settlement_source: string | null;
  settlement_evidence_json: string | null;
  settled_at: string | null;
  notification_status: string | null;
}

function filteredWhere(filters: TicketLabFilters): { sql: string; values: Array<string> } {
  const clauses: string[] = [];
  const values: string[] = [];
  if (filters.from !== null) isoDate(filters.from, "from");
  if (filters.to !== null) isoDate(filters.to, "to");
  if (filters.from !== null && filters.to !== null && filters.from > filters.to) {
    throw new RangeError("from must not be after to");
  }
  if (filters.game) {
    values.push(filters.game);
    clauses.push(`l.game = ?${values.length}`);
  }
  if (filters.from) {
    values.push(filters.from);
    clauses.push(`l.draw_date >= ?${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    clauses.push(`l.draw_date <= ?${values.length}`);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

const JOINED_TRACK_SELECT = `
  SELECT l.*, t.*,
         p.purchase_event_id, p.purchased, p.spend_cents AS purchase_spend_cents,
         p.recorded_at AS purchase_recorded_at,
         g.grade_id, g.revision, g.draw_fingerprint, g.result_main_numbers,
         g.result_bonus_numbers, g.result_session, g.result_source_id,
         g.result_source_sha256, g.graded_at,
         tg.ticket_grade_id, tg.main_matches, tg.bonus_matches, tg.prize_tier,
         tg.hit, tg.payout_status, tg.prize_cents, tg.pending_reason,
         tg.grading_detail_json,
         s.settlement_id, s.final_prize_cents, s.source AS settlement_source,
         s.evidence_json AS settlement_evidence_json, s.settled_at,
         o.status AS notification_status
  FROM lotto_ticket_ledger l
  JOIN lotto_ledger_tickets t ON t.ledger_id = l.ledger_id
  LEFT JOIN lotto_purchase_confirmation_events p
    ON p.purchase_event_id = (
      SELECT p2.purchase_event_id FROM lotto_purchase_confirmation_events p2
      WHERE p2.ledger_id = l.ledger_id
      ORDER BY p2.recorded_at DESC, p2.purchase_event_id DESC LIMIT 1
    )
  LEFT JOIN lotto_ledger_grades g
    ON g.grade_id = (
      SELECT g2.grade_id FROM lotto_ledger_grades g2
      WHERE g2.ledger_id = l.ledger_id ORDER BY g2.revision DESC LIMIT 1
    )
  LEFT JOIN lotto_ticket_grades tg
    ON tg.grade_id = g.grade_id AND tg.ledger_ticket_id = t.ledger_ticket_id
  LEFT JOIN lotto_grade_settlement_events s
    ON s.settlement_id = (
      SELECT s2.settlement_id FROM lotto_grade_settlement_events s2
      WHERE s2.ticket_grade_id = tg.ticket_grade_id
      ORDER BY s2.settled_at DESC, s2.settlement_id DESC LIMIT 1
    )
  LEFT JOIN lotto_lab_delivery_outbox o ON o.grade_id = g.grade_id`;

function effectivePrize(row: JoinedTrackRow): number {
  if (row.final_prize_cents !== null) return Number(row.final_prize_cents);
  return row.payout_status === "fixed" ? Number(row.prize_cents ?? 0) : 0;
}

function effectiveNonCashValue(row: JoinedTrackRow): number {
  if (row.hit !== 1 || row.grading_detail_json === null) return 0;
  const detail = decodeRecord(row.grading_detail_json, "grading detail");
  const faceValue = detail.faceValueCents;
  return Number.isSafeInteger(faceValue) && (faceValue as number) >= 0 ? (faceValue as number) : 0;
}

function scorecard(
  rows: readonly JoinedTrackRow[],
  confirmedOnly = false,
  ticketLevelSpend = false
): TicketLabScorecard {
  const eligible = confirmedOnly ? rows.filter((row) => row.purchased === 1) : [...rows];
  const ledgers = new Map<string, JoinedTrackRow>();
  const tickets = new Map<string, JoinedTrackRow>();
  for (const row of eligible) {
    ledgers.set(row.ledger_id, row);
    tickets.set(row.ledger_ticket_id, row);
  }
  const ordered = [...tickets.values()]
    .filter((row) => row.ticket_grade_id !== null)
    .sort((left, right) =>
      `${left.draw_date}|${left.proposed_at}|${String(left.ordinal).padStart(5, "0")}|${left.ledger_id}`.localeCompare(
        `${right.draw_date}|${right.proposed_at}|${String(right.ordinal).padStart(5, "0")}|${right.ledger_id}`
      )
    );
  let currentLosingStreak = 0;
  let longestLosingStreak = 0;
  for (const row of ordered) {
    if (row.hit === 1) currentLosingStreak = 0;
    else {
      currentLosingStreak += 1;
      longestLosingStreak = Math.max(longestLosingStreak, currentLosingStreak);
    }
  }
  const winning = ordered.filter((row) => row.hit === 1);
  const unresolved = (row: JoinedTrackRow): boolean =>
    row.payout_status === "pending" && row.final_prize_cents === null;
  const best = winning.sort((left, right) => {
    if (unresolved(left) !== unresolved(right)) return unresolved(right) ? 1 : -1;
    return effectivePrize(right) - effectivePrize(left);
  })[0];
  const spentCents = confirmedOnly
    ? [...ledgers.values()].reduce((total, row) => total + Number(row.purchase_spend_cents ?? 0), 0)
    : ticketLevelSpend
      ? [...tickets.values()].reduce((total, row) => total + Number(row.ticket_cost_cents), 0)
      : [...ledgers.values()].reduce(
          (total, row) => total + row.ticket_count * row.ticket_cost_cents,
          0
        );
  const wonCents = ordered.reduce((total, row) => total + effectivePrize(row), 0);
  const nonCashValueCents = ordered.reduce((total, row) => total + effectiveNonCashValue(row), 0);
  return {
    entries: ledgers.size,
    tickets: tickets.size,
    gradedTickets: ordered.length,
    spentCents,
    wonCents,
    nonCashValueCents,
    pendingPrizeCount: ordered.filter(
      (row) => row.payout_status === "pending" && row.final_prize_cents === null
    ).length,
    longestLosingStreak,
    bestHit: best
      ? {
          game: best.game,
          drawDate: best.draw_date,
          tier: best.prize_tier ?? "Prize",
          prizeCents: unresolved(best) ? null : effectivePrize(best),
          payoutStatus: unresolved(best)
            ? "pending"
            : best.settlement_id === null
              ? "fixed"
              : "settled"
        }
      : null,
    roiPercent:
      spentCents === 0
        ? null
        : Math.round(((wonCents - spentCents) / spentCents) * 100 * 100) / 100,
    economicRoiPercent:
      spentCents === 0
        ? null
        : Math.round(((wonCents + nonCashValueCents - spentCents) / spentCents) * 100 * 100) / 100
  };
}

export interface TicketLabTrackRecord {
  readonly filters: TicketLabFilters;
  readonly totals: {
    readonly proposals: TicketLabScorecard;
    readonly confirmed: TicketLabScorecard;
  };
  readonly comparisons: readonly (TicketLabScorecard & { readonly origin: Origin })[];
  readonly comparisonPolicy: {
    readonly method: "shared-strata-min-ticket-count";
    readonly strata: readonly ["game", "drawDate", "targetSession"];
    readonly origins: readonly Origin[];
    readonly sharedStrata: number;
    readonly ticketsPerOrigin: number;
    readonly description: string;
  };
  readonly prizeTiers: readonly {
    readonly tier: string;
    readonly count: number;
    readonly wonCents: number;
  }[];
  readonly disclaimer: string;
}

function matchedComparisonRows(rows: readonly JoinedTrackRow[]): {
  origins: readonly Origin[];
  byOrigin: ReadonlyMap<Origin, readonly JoinedTrackRow[]>;
  sharedStrata: number;
  ticketsPerOrigin: number;
} {
  const graded = rows.filter((row) => row.ticket_grade_id !== null);
  const origins: readonly Origin[] = graded.some((row) => row.origin === "user")
    ? ["system", "random", "user"]
    : ["system", "random"];
  const strata = new Map<string, Map<Origin, JoinedTrackRow[]>>();
  for (const row of graded) {
    if (!origins.includes(row.origin)) continue;
    const key = `${row.game}|${row.draw_date}|${row.target_session}`;
    const byOrigin = strata.get(key) ?? new Map<Origin, JoinedTrackRow[]>();
    const bucket = byOrigin.get(row.origin) ?? [];
    bucket.push(row);
    byOrigin.set(row.origin, bucket);
    strata.set(key, byOrigin);
  }
  const selected = new Map<Origin, JoinedTrackRow[]>(origins.map((origin) => [origin, []]));
  let sharedStrata = 0;
  for (const key of [...strata.keys()].sort()) {
    const cohort = strata.get(key) as Map<Origin, JoinedTrackRow[]>;
    if (!origins.every((origin) => (cohort.get(origin)?.length ?? 0) > 0)) continue;
    const count = Math.min(...origins.map((origin) => cohort.get(origin)?.length ?? 0));
    if (count < 1) continue;
    sharedStrata += 1;
    for (const origin of origins) {
      const deterministic = [...(cohort.get(origin) ?? [])].sort((left, right) =>
        `${left.ledger_id}|${String(left.ordinal).padStart(6, "0")}`.localeCompare(
          `${right.ledger_id}|${String(right.ordinal).padStart(6, "0")}`
        )
      );
      (selected.get(origin) as JoinedTrackRow[]).push(...deterministic.slice(0, count));
    }
  }
  const ticketsPerOrigin = selected.get(origins[0] as Origin)?.length ?? 0;
  return { origins, byOrigin: selected, sharedStrata, ticketsPerOrigin };
}

export async function readTrackRecord(
  env: Env,
  filters: TicketLabFilters
): Promise<TicketLabTrackRecord> {
  const where = filteredWhere(filters);
  const statement = env.LOTTO_DB.prepare(
    `${JOINED_TRACK_SELECT} ${where.sql} ORDER BY l.draw_date, l.ledger_id, t.ordinal`
  );
  const rows = (
    where.values.length ? statement.bind(...where.values) : statement
  ).all<JoinedTrackRow>();
  const result = await rows;
  const proposals = result.results.filter((row) => row.origin !== "random");
  const matched = matchedComparisonRows(result.results);
  const histogram = new Map<string, { count: number; wonCents: number }>();
  for (const row of proposals) {
    if (row.hit !== 1 || row.prize_tier === null) continue;
    const prior = histogram.get(row.prize_tier) ?? { count: 0, wonCents: 0 };
    prior.count += 1;
    prior.wonCents += effectivePrize(row);
    histogram.set(row.prize_tier, prior);
  }
  return {
    filters,
    totals: { proposals: scorecard(proposals), confirmed: scorecard(proposals, true) },
    comparisons: matched.origins.map((origin) => ({
      origin,
      ...scorecard(matched.byOrigin.get(origin) ?? [], false, true)
    })),
    comparisonPolicy: {
      method: "shared-strata-min-ticket-count",
      strata: ["game", "drawDate", "targetSession"],
      origins: matched.origins,
      sharedStrata: matched.sharedStrata,
      ticketsPerOrigin: matched.ticketsPerOrigin,
      description:
        "Only graded tickets in shared game/draw-date/session strata are compared; each origin contributes the same deterministic minimum ticket count per stratum."
    },
    prizeTiers: [...histogram.entries()]
      .map(([tier, values]) => ({ tier, ...values }))
      .sort((left, right) => right.count - left.count || left.tier.localeCompare(right.tier)),
    disclaimer: TICKET_LAB_DISCLAIMER
  };
}

function encodeListCursor(drawDate: string, ledgerId: string): string {
  return btoa(`${drawDate}|${ledgerId}`)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeListCursor(value: string): { drawDate: string; ledgerId: string } {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new RangeError("cursor is malformed");
  let decoded: string;
  try {
    decoded = atob(
      value
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=")
    );
  } catch {
    throw new RangeError("cursor is malformed");
  }
  const separator = decoded.indexOf("|");
  const drawDate = decoded.slice(0, separator);
  const ledgerId = decoded.slice(separator + 1);
  if (
    separator < 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(drawDate) ||
    !/^ledger-[a-f0-9]{32}$/.test(ledgerId)
  )
    throw new RangeError("cursor is malformed");
  isoDate(drawDate, "cursor date");
  return { drawDate, ledgerId };
}

function publicPurchase(row: JoinedTrackRow): {
  status: PurchaseStatus;
  eventId: string | null;
  at: string | null;
  spendCents: number;
} {
  return {
    status:
      row.purchase_event_id === null
        ? "unconfirmed"
        : row.purchased === 1
          ? "confirmed"
          : "declined",
    eventId: row.purchase_event_id,
    at: row.purchase_recorded_at,
    spendCents: Number(row.purchase_spend_cents ?? 0)
  };
}

function entryStatus(rows: readonly JoinedTrackRow[]): EntryStatus {
  if (rows.every((row) => row.grade_id === null)) return "open";
  if (rows.some((row) => row.payout_status === "pending" && row.final_prize_cents === null))
    return "pending";
  return rows.some((row) => row.hit === 1) ? "won" : "lost";
}

export interface ListTicketLabInput extends TicketLabFilters {
  readonly status: EntryStatus | "graded" | null;
  readonly limit: number;
  readonly cursor: string | null;
}

export async function listTicketLabEntries(
  env: Env,
  input: ListTicketLabInput
): Promise<{
  readonly filters: {
    readonly game: GameCode | null;
    readonly from: string | null;
    readonly to: string | null;
    readonly status: string | null;
  };
  readonly entries: readonly Record<string, unknown>[];
  readonly nextCursor: string | null;
  readonly disclaimer: string;
}> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIST_LIMIT)
    throw new RangeError(`limit must be an integer from 1 through ${MAX_LIST_LIMIT}`);
  const where = filteredWhere(input);
  const cursor = input.cursor ? decodeListCursor(input.cursor) : null;
  const values = [...where.values];
  const clauses = where.sql ? [where.sql.slice(6)] : [];
  if (cursor) {
    values.push(cursor.drawDate, cursor.ledgerId);
    clauses.push(
      `(l.draw_date < ?${values.length - 1} OR (l.draw_date = ?${values.length - 1} AND l.ledger_id < ?${values.length}))`
    );
  }
  if (input.status) {
    const gradeExists = `EXISTS (SELECT 1 FROM lotto_ledger_grades gx WHERE gx.ledger_id = l.ledger_id)`;
    const latestGrade = `(SELECT gx.grade_id FROM lotto_ledger_grades gx WHERE gx.ledger_id = l.ledger_id ORDER BY gx.revision DESC LIMIT 1)`;
    const pendingExists = `EXISTS (SELECT 1 FROM lotto_ticket_grades tx LEFT JOIN lotto_grade_settlement_events sx ON sx.ticket_grade_id = tx.ticket_grade_id WHERE tx.grade_id = ${latestGrade} AND tx.payout_status = 'pending' AND sx.settlement_id IS NULL)`;
    if (input.status === "open") clauses.push(`NOT ${gradeExists}`);
    else if (input.status === "graded") clauses.push(gradeExists);
    else if (input.status === "pending") clauses.push(pendingExists);
    else if (input.status === "won")
      clauses.push(
        `EXISTS (SELECT 1 FROM lotto_ticket_grades tx WHERE tx.grade_id = ${latestGrade} AND tx.hit = 1) AND NOT ${pendingExists}`
      );
    else
      clauses.push(
        `${gradeExists} AND NOT EXISTS (SELECT 1 FROM lotto_ticket_grades tx WHERE tx.grade_id = ${latestGrade} AND tx.hit = 1)`
      );
  }
  values.push(String(input.limit + 1));
  const ledgerQuery = `SELECT l.* FROM lotto_ticket_ledger l ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY l.draw_date DESC, l.ledger_id DESC LIMIT ?${values.length}`;
  const ledgersResult = await env.LOTTO_DB.prepare(ledgerQuery)
    .bind(...values)
    .all<LedgerRow>();
  const hasMore = ledgersResult.results.length > input.limit;
  const ledgers = ledgersResult.results.slice(0, input.limit);
  if (ledgers.length === 0)
    return {
      filters: { game: input.game, from: input.from, to: input.to, status: input.status },
      entries: [],
      nextCursor: null,
      disclaimer: TICKET_LAB_DISCLAIMER
    };
  const ids = ledgers.map((row) => row.ledger_id);
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(",");
  const joined = await env.LOTTO_DB.prepare(
    `${JOINED_TRACK_SELECT} WHERE l.ledger_id IN (${placeholders}) ORDER BY l.draw_date DESC, l.ledger_id DESC, t.ordinal`
  )
    .bind(...ids)
    .all<JoinedTrackRow>();
  const rowsByLedger = new Map<string, JoinedTrackRow[]>();
  for (const row of joined.results) {
    const bucket = rowsByLedger.get(row.ledger_id) ?? [];
    bucket.push(row);
    rowsByLedger.set(row.ledger_id, bucket);
  }
  const entries = ledgers.map((ledger) => {
    const rows = rowsByLedger.get(ledger.ledger_id) ?? [];
    if (rows.length !== ledger.ticket_count)
      throw new Error(`Ledger ${ledger.ledger_id} ticket count does not reconcile`);
    const first = rows[0] as JoinedTrackRow;
    const wonCents = rows.reduce((total, row) => total + effectivePrize(row), 0);
    const pendingPrizeCount = rows.filter(
      (row) => row.payout_status === "pending" && row.final_prize_cents === null
    ).length;
    const purchase = publicPurchase(first);
    return {
      ledgerId: ledger.ledger_id,
      origin: ledger.origin,
      correctionOf: ledger.correction_of,
      baselineFor: ledger.baseline_for,
      runId: ledger.run_id,
      game: ledger.game,
      gameName: GAME_MANIFEST[ledger.game].name,
      drawDate: ledger.draw_date,
      targetSession: ledger.target_session,
      proposedAt: ledger.proposed_at,
      seed: ledger.seed,
      status: entryStatus(rows),
      coverage: {
        distinctPairs: ledger.coverage_distinct_pairs,
        possiblePairs: ledger.coverage_possible_pairs,
        percent: ledger.coverage_basis_points / 100
      },
      ev: { netCentsPerTicket: ledger.ev_net_cents, assumption: ledger.ev_assumption },
      ticketCostCents: ledger.ticket_cost_cents,
      proposalStatus: "proposed",
      purchase,
      data: { observedThrough: ledger.observed_through, datasetDigest: ledger.dataset_digest },
      spend: {
        proposalCents: ledger.ticket_count * ledger.ticket_cost_cents,
        confirmedCents: purchase.status === "confirmed" ? purchase.spendCents : 0
      },
      wonCents,
      pendingPrizeCount,
      resultNotificationStatus: first.notification_status,
      tickets: rows.map((row) => ({
        ledgerTicketId: row.ledger_ticket_id,
        ordinal: row.ordinal,
        main: decodeIntegerArray(row.main_numbers, "ledger main numbers"),
        bonus: decodeIntegerArray(row.bonus_numbers, "ledger bonus numbers"),
        playStyle: row.play_style,
        wagerCents: row.wager_cents,
        options: decodeRecord(row.ticket_options_json, "ticket options"),
        splitRisk: {
          score: row.split_risk_basis_points / 100,
          level: row.split_risk_level,
          notes: decodeStringArray(row.split_risk_notes, "split risk notes")
        },
        grade:
          row.grade_id === null
            ? null
            : (() => {
                const detail = decodeRecord(row.grading_detail_json as string, "grading detail");
                return {
                  gradeId: row.ticket_grade_id,
                  revision: row.revision,
                  result: {
                    main: decodeIntegerArray(
                      row.result_main_numbers as string,
                      "result main numbers"
                    ),
                    bonus: decodeIntegerArray(
                      row.result_bonus_numbers as string,
                      "result bonus numbers"
                    ),
                    session: row.result_session,
                    fingerprint: row.draw_fingerprint,
                    sourceId: row.result_source_id,
                    sourceSha256: row.result_source_sha256
                  },
                  mainMatches: row.main_matches,
                  bonusMatches: row.bonus_matches,
                  tier: row.prize_tier,
                  hit: row.hit === 1,
                  payoutStatus: row.settlement_id !== null ? "settled" : row.payout_status,
                  prizeCents: row.prize_cents,
                  effectivePrizeCents:
                    row.payout_status === "pending" && row.settlement_id === null
                      ? null
                      : effectivePrize(row),
                  pendingReason: row.settlement_id === null ? row.pending_reason : null,
                  nonCashPrize:
                    typeof detail.nonCashPrize === "string" ? detail.nonCashPrize : null,
                  detail,
                  settlement:
                    row.settlement_id === null
                      ? null
                      : {
                          settlementId: row.settlement_id,
                          source: row.settlement_source,
                          evidence: decodeRecord(
                            row.settlement_evidence_json as string,
                            "settlement evidence"
                          ),
                          settledAt: row.settled_at,
                          finalPrizeCents: row.final_prize_cents
                        },
                  gradedAt: row.graded_at
                };
              })()
      }))
    };
  });
  const last = ledgers.at(-1);
  return {
    filters: { game: input.game, from: input.from, to: input.to, status: input.status },
    entries,
    nextCursor: hasMore && last ? encodeListCursor(last.draw_date, last.ledger_id) : null,
    disclaimer: TICKET_LAB_DISCLAIMER
  };
}
