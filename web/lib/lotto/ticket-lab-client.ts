import { GAME_MANIFEST, isGameCode } from "./manifest";
import { configuredLottoApiBase, normalizeLottoApiBase } from "./status-client";
import type { DigitPlayStyle, GameCode } from "./types";

export type TicketLabOrigin = "system" | "random" | "user";
export type TicketLabEntryStatus = "open" | "graded" | "pending" | "won" | "lost";
export type TicketLabPurchaseStatus = "unconfirmed" | "confirmed" | "declined";
export type TicketLabPayoutStatus = "none" | "fixed" | "pending" | "settled";

export interface TicketLabBestHit {
  readonly game: GameCode;
  readonly drawDate: string;
  readonly tier: string;
  readonly prizeCents: number | null;
  readonly payoutStatus: "fixed" | "settled" | "pending";
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
  readonly bestHit: TicketLabBestHit | null;
  readonly roiPercent: number | null;
  readonly economicRoiPercent: number | null;
}

export interface TicketLabComparison extends TicketLabScorecard {
  readonly origin: TicketLabOrigin;
}

export interface TicketLabPrizeTier {
  readonly tier: string;
  readonly count: number;
  readonly wonCents: number;
}

export interface TicketLabSummaryResponse {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly data: {
    readonly filters: {
      readonly game: GameCode | null;
      readonly from: string | null;
      readonly to: string | null;
    };
    readonly totals: {
      readonly proposals: TicketLabScorecard;
      readonly confirmed: TicketLabScorecard;
    };
    readonly comparisons: readonly TicketLabComparison[];
    readonly comparisonPolicy: {
      readonly method: "shared-strata-min-ticket-count";
      readonly strata: readonly ["game", "drawDate", "targetSession"];
      readonly origins: readonly TicketLabOrigin[];
      readonly sharedStrata: number;
      readonly ticketsPerOrigin: number;
      readonly description: string;
    };
    readonly prizeTiers: readonly TicketLabPrizeTier[];
    readonly disclaimer: string;
  };
}

export interface TicketLabTicketGrade {
  readonly gradeId: string;
  readonly revision: number;
  readonly result: {
    readonly main: readonly number[];
    readonly bonus: readonly number[];
    readonly session: string;
    readonly fingerprint: string;
    readonly sourceId: string;
    readonly sourceSha256: string;
  };
  readonly mainMatches: number;
  readonly bonusMatches: number;
  readonly tier: string;
  readonly hit: boolean;
  readonly payoutStatus: TicketLabPayoutStatus;
  readonly prizeCents: number | null;
  readonly effectivePrizeCents: number | null;
  readonly pendingReason: string | null;
  readonly nonCashPrize: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly settlement: {
    readonly settlementId: string;
    readonly source: string;
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly settledAt: string;
    readonly finalPrizeCents: number;
  } | null;
  readonly gradedAt: string;
}

export interface TicketLabTicket {
  readonly ledgerTicketId: string;
  readonly ordinal: number;
  readonly main: readonly number[];
  readonly bonus: readonly number[];
  readonly playStyle: DigitPlayStyle;
  readonly wagerCents: number;
  readonly options: Readonly<Record<string, unknown>>;
  readonly splitRisk: {
    readonly score: number;
    readonly level: "low" | "moderate" | "high";
    readonly notes: readonly string[];
  };
  readonly grade: TicketLabTicketGrade | null;
}

export interface TicketLabEntry {
  readonly ledgerId: string;
  readonly origin: TicketLabOrigin;
  readonly correctionOf: string | null;
  readonly baselineFor: string | null;
  readonly runId: string | null;
  readonly game: GameCode;
  readonly gameName: string;
  readonly drawDate: string;
  readonly targetSession: string;
  readonly proposedAt: string;
  readonly status: Exclude<TicketLabEntryStatus, "graded">;
  readonly seed: string | null;
  readonly coverage: {
    readonly distinctPairs: number;
    readonly possiblePairs: number;
    readonly percent: number;
  };
  readonly ev: {
    readonly netCentsPerTicket: number;
    readonly assumption: string;
  };
  readonly ticketCostCents: number;
  readonly proposalStatus: "proposed";
  readonly purchase: {
    readonly status: TicketLabPurchaseStatus;
    readonly eventId: string | null;
    readonly at: string | null;
    readonly spendCents: number;
  };
  readonly data: {
    readonly observedThrough: string | null;
    readonly datasetDigest: string | null;
  };
  readonly spend: {
    readonly proposalCents: number;
    readonly confirmedCents: number;
  };
  readonly wonCents: number;
  readonly pendingPrizeCount: number;
  readonly resultNotificationStatus: string | null;
  readonly tickets: readonly TicketLabTicket[];
}

export interface TicketLabEntriesResponse {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly data: {
    readonly filters: {
      readonly game: GameCode | null;
      readonly from: string | null;
      readonly to: string | null;
      readonly status: TicketLabEntryStatus | null;
    };
    readonly entries: readonly TicketLabEntry[];
    readonly nextCursor: string | null;
    readonly disclaimer: string;
  };
}

export interface TicketLabFilters {
  readonly game?: GameCode;
  readonly from?: string;
  readonly to?: string;
  readonly status?: TicketLabEntryStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ReadTicketLabOptions {
  readonly baseUrl?: string;
  readonly token?: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

export class LottoTicketLabClientError extends Error {
  override readonly name = "LottoTicketLabClientError";

  constructor(
    message: string,
    readonly status: number | null = null
  ) {
    super(message);
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, field: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LottoTicketLabClientError(`${field} must be an object.`);
  }
  return value as JsonRecord;
}

function stringValue(value: unknown, field: string, maximum = 2_000): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new LottoTicketLabClientError(`${field} must be a non-empty string.`);
  }
  return value;
}

function nullableString(value: unknown, field: string, maximum = 2_000): string | null {
  return value === null ? null : stringValue(value, field, maximum);
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new LottoTicketLabClientError(`${field} must be a safe integer of at least ${minimum}.`);
  }
  return value as number;
}

function signedInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new LottoTicketLabClientError(`${field} must be a safe integer.`);
  }
  return value as number;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LottoTicketLabClientError(`${field} must be a finite number.`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new LottoTicketLabClientError(`${field} must be a boolean.`);
  }
  return value;
}

function dateOnly(value: unknown, field: string): string {
  const result = stringValue(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) {
    throw new LottoTicketLabClientError(`${field} must be an ISO calendar date.`);
  }
  const parsed = new Date(`${result}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new LottoTicketLabClientError(`${field} is not a valid calendar date.`);
  }
  return result;
}

function nullableDate(value: unknown, field: string): string | null {
  return value === null ? null : dateOnly(value, field);
}

function dateTime(value: unknown, field: string): string {
  const result = stringValue(value, field, 64);
  if (!Number.isFinite(Date.parse(result)) || !/^\d{4}-\d{2}-\d{2}T/.test(result)) {
    throw new LottoTicketLabClientError(`${field} must be an ISO date-time.`);
  }
  return result;
}

function gameCode(value: unknown, field: string): GameCode {
  const result = stringValue(value, field, 16);
  if (!isGameCode(result)) {
    throw new LottoTicketLabClientError(`${field} is not a configured lottery game.`);
  }
  return result;
}

function nullableGame(value: unknown, field: string): GameCode | null {
  return value === null ? null : gameCode(value, field);
}

function integerArray(value: unknown, field: string): readonly number[] {
  if (!Array.isArray(value) || !value.every((item) => Number.isSafeInteger(item))) {
    throw new LottoTicketLabClientError(`${field} must be an integer array.`);
  }
  return value as number[];
}

function shortStringArray(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    !value.every((item) => typeof item === "string" && item.trim() !== "" && item.length <= 500)
  ) {
    throw new LottoTicketLabClientError(`${field} must be an array of short strings.`);
  }
  return value as string[];
}

function assertNumbers(
  game: GameCode,
  main: readonly number[],
  bonus: readonly number[],
  field: string
): void {
  const config = GAME_MANIFEST[game];
  if (
    main.length !== config.main.count ||
    main.some((number) => number < config.main.min || number > config.main.max) ||
    (!config.main.allowDuplicates && new Set(main).size !== main.length)
  ) {
    throw new LottoTicketLabClientError(`${field} has invalid ${game} main numbers.`);
  }
  if (config.bonus) {
    if (
      bonus.length !== config.bonus.count ||
      bonus.some((number) => number < config.bonus!.min || number > config.bonus!.max)
    ) {
      throw new LottoTicketLabClientError(`${field} has invalid ${game} bonus numbers.`);
    }
  } else if (bonus.length !== 0) {
    throw new LottoTicketLabClientError(`${field} must not contain bonus numbers.`);
  }
}

function origin(value: unknown, field: string): TicketLabOrigin {
  if (value !== "system" && value !== "random" && value !== "user") {
    throw new LottoTicketLabClientError(`${field} has an unknown ticket origin.`);
  }
  return value;
}

function scorecard(value: unknown, field: string): TicketLabScorecard {
  const input = record(value, field);
  const bestInput = input.bestHit;
  let bestHit: TicketLabBestHit | null = null;
  if (bestInput !== null) {
    const best = record(bestInput, `${field}.bestHit`);
    const payoutStatus = stringValue(
      best.payoutStatus,
      `${field}.bestHit.payoutStatus`,
      16
    );
    if (payoutStatus !== "fixed" && payoutStatus !== "settled" && payoutStatus !== "pending") {
      throw new LottoTicketLabClientError(`${field}.bestHit.payoutStatus is unknown.`);
    }
    const prizeCents =
      best.prizeCents === null
        ? null
        : integer(best.prizeCents, `${field}.bestHit.prizeCents`);
    if ((payoutStatus === "pending") !== (prizeCents === null)) {
      throw new LottoTicketLabClientError(`${field}.bestHit payout evidence is inconsistent.`);
    }
    bestHit = {
      game: gameCode(best.game, `${field}.bestHit.game`),
      drawDate: dateOnly(best.drawDate, `${field}.bestHit.drawDate`),
      tier: stringValue(best.tier, `${field}.bestHit.tier`, 160),
      prizeCents,
      payoutStatus
    };
  }
  const roiPercent = input.roiPercent === null ? null : finite(input.roiPercent, `${field}.roiPercent`);
  const economicRoiPercent =
    input.economicRoiPercent === null
      ? null
      : finite(input.economicRoiPercent, `${field}.economicRoiPercent`);
  return {
    entries: integer(input.entries, `${field}.entries`),
    tickets: integer(input.tickets, `${field}.tickets`),
    gradedTickets: integer(input.gradedTickets, `${field}.gradedTickets`),
    spentCents: integer(input.spentCents, `${field}.spentCents`),
    wonCents: integer(input.wonCents, `${field}.wonCents`),
    nonCashValueCents: integer(input.nonCashValueCents, `${field}.nonCashValueCents`),
    pendingPrizeCount: integer(input.pendingPrizeCount, `${field}.pendingPrizeCount`),
    longestLosingStreak: integer(input.longestLosingStreak, `${field}.longestLosingStreak`),
    bestHit,
    roiPercent,
    economicRoiPercent
  };
}

function envelope(value: unknown, name: string): { generatedAt: string; data: JsonRecord } {
  const input = record(value, name);
  if (input.schemaVersion !== 1) {
    throw new LottoTicketLabClientError(`${name} has an unsupported schema version.`);
  }
  return {
    generatedAt: dateTime(input.generatedAt, `${name}.generatedAt`),
    data: record(input.data, `${name}.data`)
  };
}

export function parseTicketLabSummary(value: unknown): TicketLabSummaryResponse {
  const { generatedAt, data } = envelope(value, "Ticket Lab summary");
  const filters = record(data.filters, "Ticket Lab summary filters");
  const totals = record(data.totals, "Ticket Lab summary totals");
  const comparisonPolicy = record(data.comparisonPolicy, "Ticket Lab comparison policy");
  if (!Array.isArray(data.comparisons) || !Array.isArray(data.prizeTiers)) {
    throw new LottoTicketLabClientError("Ticket Lab summary collections must be arrays.");
  }
  const comparisons = data.comparisons.map((value, index): TicketLabComparison => {
    const input = record(value, `Ticket Lab comparison ${index + 1}`);
    return {
      origin: origin(input.origin, `Ticket Lab comparison ${index + 1}.origin`),
      ...scorecard(input, `Ticket Lab comparison ${index + 1}`)
    };
  });
  if (new Set(comparisons.map((row) => row.origin)).size !== comparisons.length) {
    throw new LottoTicketLabClientError("Ticket Lab comparison origins must be unique.");
  }
  if (
    comparisonPolicy.method !== "shared-strata-min-ticket-count" ||
    !Array.isArray(comparisonPolicy.strata) ||
    comparisonPolicy.strata.length !== 3 ||
    comparisonPolicy.strata[0] !== "game" ||
    comparisonPolicy.strata[1] !== "drawDate" ||
    comparisonPolicy.strata[2] !== "targetSession" ||
    !Array.isArray(comparisonPolicy.origins)
  ) {
    throw new LottoTicketLabClientError("Ticket Lab comparison policy is unsupported.");
  }
  const policyOrigins = comparisonPolicy.origins.map((value, index) =>
    origin(value, `Ticket Lab comparison policy origins[${index}]`)
  );
  if (
    policyOrigins.length < 2 ||
    new Set(policyOrigins).size !== policyOrigins.length ||
    policyOrigins[0] !== "system" ||
    policyOrigins[1] !== "random" ||
    (policyOrigins.length === 3 && policyOrigins[2] !== "user") ||
    policyOrigins.length > 3
  ) {
    throw new LottoTicketLabClientError("Ticket Lab comparison policy origins are invalid.");
  }
  if (
    policyOrigins.length !== comparisons.length ||
    policyOrigins.some((value, index) => value !== comparisons[index]?.origin)
  ) {
    throw new LottoTicketLabClientError(
      "Ticket Lab comparison rows do not match the declared comparison policy."
    );
  }
  const prizeTiers = data.prizeTiers.map((value, index): TicketLabPrizeTier => {
    const input = record(value, `Ticket Lab prize tier ${index + 1}`);
    return {
      tier: stringValue(input.tier, `Ticket Lab prize tier ${index + 1}.tier`, 160),
      count: integer(input.count, `Ticket Lab prize tier ${index + 1}.count`),
      wonCents: integer(input.wonCents, `Ticket Lab prize tier ${index + 1}.wonCents`)
    };
  });
  return {
    schemaVersion: 1,
    generatedAt,
    data: {
      filters: {
        game: nullableGame(filters.game, "Ticket Lab summary filters.game"),
        from: nullableDate(filters.from, "Ticket Lab summary filters.from"),
        to: nullableDate(filters.to, "Ticket Lab summary filters.to")
      },
      totals: {
        proposals: scorecard(totals.proposals, "Ticket Lab proposals"),
        confirmed: scorecard(totals.confirmed, "Ticket Lab confirmed plays")
      },
      comparisons,
      comparisonPolicy: {
        method: "shared-strata-min-ticket-count",
        strata: ["game", "drawDate", "targetSession"],
        origins: policyOrigins,
        sharedStrata: integer(
          comparisonPolicy.sharedStrata,
          "Ticket Lab comparison policy.sharedStrata"
        ),
        ticketsPerOrigin: integer(
          comparisonPolicy.ticketsPerOrigin,
          "Ticket Lab comparison policy.ticketsPerOrigin"
        ),
        description: stringValue(
          comparisonPolicy.description,
          "Ticket Lab comparison policy.description",
          2_000
        )
      },
      prizeTiers,
      disclaimer: stringValue(data.disclaimer, "Ticket Lab summary disclaimer", 2_000)
    }
  };
}

function grade(value: unknown, game: GameCode, field: string): TicketLabTicketGrade | null {
  if (value === null) return null;
  const input = record(value, field);
  const result = record(input.result, `${field}.result`);
  const main = integerArray(result.main, `${field}.result.main`);
  const bonus = integerArray(result.bonus, `${field}.result.bonus`);
  assertNumbers(game, main, bonus, `${field}.result`);
  const payoutStatus = stringValue(input.payoutStatus, `${field}.payoutStatus`, 16);
  if (!(["none", "fixed", "pending", "settled"] as const).includes(payoutStatus as TicketLabPayoutStatus)) {
    throw new LottoTicketLabClientError(`${field}.payoutStatus is unknown.`);
  }
  const prizeCents = input.prizeCents === null ? null : integer(input.prizeCents, `${field}.prizeCents`);
  const effectivePrizeCents =
    input.effectivePrizeCents === null
      ? null
      : integer(input.effectivePrizeCents, `${field}.effectivePrizeCents`);
  if (payoutStatus === "none" && (prizeCents !== 0 || effectivePrizeCents !== 0)) {
    throw new LottoTicketLabClientError(`${field} miss payout must reconcile to zero.`);
  }
  if (payoutStatus === "pending" && prizeCents !== null) {
    throw new LottoTicketLabClientError(`${field} pending payout cannot claim a prize amount.`);
  }
  const detail = record(input.detail, `${field}.detail`);
  let settlement: TicketLabTicketGrade["settlement"] = null;
  if (input.settlement !== null) {
    const settlementInput = record(input.settlement, `${field}.settlement`);
    settlement = {
      settlementId: stringValue(
        settlementInput.settlementId,
        `${field}.settlement.settlementId`,
        100
      ),
      source: stringValue(settlementInput.source, `${field}.settlement.source`, 500),
      evidence: record(settlementInput.evidence, `${field}.settlement.evidence`),
      settledAt: dateTime(settlementInput.settledAt, `${field}.settlement.settledAt`),
      finalPrizeCents: integer(
        settlementInput.finalPrizeCents,
        `${field}.settlement.finalPrizeCents`
      )
    };
  }
  if ((payoutStatus === "settled") !== (settlement !== null)) {
    throw new LottoTicketLabClientError(`${field} settlement evidence is inconsistent.`);
  }
  return {
    gradeId: stringValue(input.gradeId, `${field}.gradeId`, 80),
    revision: integer(input.revision, `${field}.revision`, 1),
    result: {
      main,
      bonus,
      session: typeof result.session === "string" ? result.session : "",
      fingerprint: stringValue(result.fingerprint, `${field}.result.fingerprint`, 128),
      sourceId: stringValue(result.sourceId, `${field}.result.sourceId`, 200),
      sourceSha256: stringValue(result.sourceSha256, `${field}.result.sourceSha256`, 128)
    },
    mainMatches: integer(input.mainMatches, `${field}.mainMatches`),
    bonusMatches: integer(input.bonusMatches, `${field}.bonusMatches`),
    tier: stringValue(input.tier, `${field}.tier`, 160),
    hit: booleanValue(input.hit, `${field}.hit`),
    payoutStatus: payoutStatus as TicketLabPayoutStatus,
    prizeCents,
    effectivePrizeCents,
    pendingReason: nullableString(input.pendingReason, `${field}.pendingReason`, 500),
    nonCashPrize:
      input.nonCashPrize === undefined
        ? null
        : nullableString(input.nonCashPrize, `${field}.nonCashPrize`, 500),
    detail,
    settlement,
    gradedAt: dateTime(input.gradedAt, `${field}.gradedAt`)
  };
}

function ticket(value: unknown, game: GameCode, field: string): TicketLabTicket {
  const input = record(value, field);
  const main = integerArray(input.main, `${field}.main`);
  const bonus = integerArray(input.bonus, `${field}.bonus`);
  assertNumbers(game, main, bonus, field);
  const playStyle = stringValue(input.playStyle, `${field}.playStyle`, 40);
  // Ledger rows can include legal hand-entered wager styles (for example Daily 4
  // pair plays) that the split-avoidance optimizer intentionally does not create.
  if (!(GAME_MANIFEST[game].evPlayStyles as readonly string[]).includes(playStyle)) {
    throw new LottoTicketLabClientError(`${field}.playStyle is not valid for ${game}.`);
  }
  const splitRisk = record(input.splitRisk, `${field}.splitRisk`);
  const level = stringValue(splitRisk.level, `${field}.splitRisk.level`, 16);
  if (level !== "low" && level !== "moderate" && level !== "high") {
    throw new LottoTicketLabClientError(`${field}.splitRisk.level is unknown.`);
  }
  const options = input.options === undefined ? {} : record(input.options, `${field}.options`);
  return {
    ledgerTicketId: stringValue(input.ledgerTicketId, `${field}.ledgerTicketId`, 100),
    ordinal: integer(input.ordinal, `${field}.ordinal`, 1),
    main,
    bonus,
    playStyle: playStyle as DigitPlayStyle,
    wagerCents: integer(input.wagerCents, `${field}.wagerCents`, 1),
    options,
    splitRisk: {
      score: finite(splitRisk.score, `${field}.splitRisk.score`),
      level,
      notes: shortStringArray(splitRisk.notes, `${field}.splitRisk.notes`)
    },
    grade: grade(input.grade, game, `${field}.grade`)
  };
}

function entry(value: unknown, field: string): TicketLabEntry {
  const input = record(value, field);
  const game = gameCode(input.game, `${field}.game`);
  if (input.gameName !== GAME_MANIFEST[game].name) {
    throw new LottoTicketLabClientError(`${field}.gameName does not match ${game}.`);
  }
  const coverage = record(input.coverage, `${field}.coverage`);
  const ev = record(input.ev, `${field}.ev`);
  const evidence = record(input.data, `${field}.data`);
  const spend = record(input.spend, `${field}.spend`);
  const purchaseInput = record(input.purchase, `${field}.purchase`);
  const purchaseStatus = stringValue(purchaseInput.status, `${field}.purchase.status`, 16);
  if (
    purchaseStatus !== "unconfirmed" &&
    purchaseStatus !== "confirmed" &&
    purchaseStatus !== "declined"
  ) {
    throw new LottoTicketLabClientError(`${field}.purchase.status is unknown.`);
  }
  const purchaseEventId = nullableString(
    purchaseInput.eventId,
    `${field}.purchase.eventId`,
    100
  );
  const purchaseAt =
    purchaseInput.at === null ? null : dateTime(purchaseInput.at, `${field}.purchase.at`);
  if (
    (purchaseStatus === "unconfirmed" && (purchaseEventId !== null || purchaseAt !== null)) ||
    (purchaseStatus !== "unconfirmed" && (purchaseEventId === null || purchaseAt === null))
  ) {
    throw new LottoTicketLabClientError(`${field}.purchase evidence does not match its status.`);
  }
  const purchase: TicketLabEntry["purchase"] = {
    status: purchaseStatus,
    eventId: purchaseEventId,
    at: purchaseAt,
    spendCents: integer(purchaseInput.spendCents, `${field}.purchase.spendCents`)
  };
  if (!Array.isArray(input.tickets) || input.tickets.length === 0 || input.tickets.length > 2_000) {
    throw new LottoTicketLabClientError(`${field}.tickets must be a non-empty bounded array.`);
  }
  const tickets = input.tickets.map((value, index) => ticket(value, game, `${field}.tickets[${index}]`));
  if (new Set(tickets.map((item) => item.ordinal)).size !== tickets.length) {
    throw new LottoTicketLabClientError(`${field}.tickets contains duplicate ordinals.`);
  }
  const percent = finite(coverage.percent, `${field}.coverage.percent`);
  if (percent < 0 || percent > 100) {
    throw new LottoTicketLabClientError(`${field}.coverage.percent is outside 0-100.`);
  }
  if (input.proposalStatus !== "proposed") {
    throw new LottoTicketLabClientError(`${field}.proposalStatus is unsupported.`);
  }
  const status = stringValue(input.status, `${field}.status`, 16);
  if (status !== "open" && status !== "pending" && status !== "won" && status !== "lost") {
    throw new LottoTicketLabClientError(`${field}.status is unknown.`);
  }
  const computedStatus = tickets.every((item) => item.grade === null)
    ? "open"
    : tickets.some((item) => item.grade?.payoutStatus === "pending")
      ? "pending"
      : tickets.some((item) => item.grade?.hit)
        ? "won"
        : "lost";
  if (status !== computedStatus) {
    throw new LottoTicketLabClientError(`${field}.status does not reconcile with ticket grades.`);
  }
  return {
    ledgerId: stringValue(input.ledgerId, `${field}.ledgerId`, 100),
    origin: origin(input.origin, `${field}.origin`),
    correctionOf: nullableString(input.correctionOf, `${field}.correctionOf`, 100),
    baselineFor: nullableString(input.baselineFor, `${field}.baselineFor`, 100),
    runId: nullableString(input.runId, `${field}.runId`, 100),
    game,
    gameName: input.gameName as string,
    drawDate: dateOnly(input.drawDate, `${field}.drawDate`),
    targetSession: typeof input.targetSession === "string" ? input.targetSession : "",
    proposedAt: dateTime(input.proposedAt, `${field}.proposedAt`),
    status,
    seed: nullableString(input.seed, `${field}.seed`, 200),
    coverage: {
      distinctPairs: integer(coverage.distinctPairs, `${field}.coverage.distinctPairs`),
      possiblePairs: integer(coverage.possiblePairs, `${field}.coverage.possiblePairs`),
      percent
    },
    ev: {
      netCentsPerTicket: signedInteger(ev.netCentsPerTicket, `${field}.ev.netCentsPerTicket`),
      assumption: stringValue(ev.assumption, `${field}.ev.assumption`, 2_000)
    },
    ticketCostCents: integer(input.ticketCostCents, `${field}.ticketCostCents`, 1),
    proposalStatus: "proposed",
    purchase,
    data: {
      observedThrough: nullableDate(evidence.observedThrough, `${field}.data.observedThrough`),
      datasetDigest: nullableString(evidence.datasetDigest, `${field}.data.datasetDigest`, 128)
    },
    spend: {
      proposalCents: integer(spend.proposalCents, `${field}.spend.proposalCents`),
      confirmedCents: integer(spend.confirmedCents, `${field}.spend.confirmedCents`)
    },
    wonCents: integer(input.wonCents, `${field}.wonCents`),
    pendingPrizeCount: integer(input.pendingPrizeCount, `${field}.pendingPrizeCount`),
    resultNotificationStatus: nullableString(
      input.resultNotificationStatus,
      `${field}.resultNotificationStatus`,
      80
    ),
    tickets
  };
}

export function parseTicketLabEntries(value: unknown): TicketLabEntriesResponse {
  const { generatedAt, data } = envelope(value, "Ticket Lab entries");
  const filters = record(data.filters, "Ticket Lab entry filters");
  const status = filters.status;
  if (
    status !== null &&
    status !== "open" &&
    status !== "graded" &&
    status !== "pending" &&
    status !== "won" &&
    status !== "lost"
  ) {
    throw new LottoTicketLabClientError("Ticket Lab entry status filter is unknown.");
  }
  if (!Array.isArray(data.entries) || data.entries.length > 100) {
    throw new LottoTicketLabClientError("Ticket Lab entries must be a bounded array.");
  }
  return {
    schemaVersion: 1,
    generatedAt,
    data: {
      filters: {
        game: nullableGame(filters.game, "Ticket Lab entry filters.game"),
        from: nullableDate(filters.from, "Ticket Lab entry filters.from"),
        to: nullableDate(filters.to, "Ticket Lab entry filters.to"),
        status: status as TicketLabEntryStatus | null
      },
      entries: data.entries.map((value, index) => entry(value, `Ticket Lab entry ${index + 1}`)),
      nextCursor: nullableString(data.nextCursor, "Ticket Lab next cursor", 500),
      disclaimer: stringValue(data.disclaimer, "Ticket Lab entries disclaimer", 2_000)
    }
  };
}

function apiUrl(path: string, filters: TicketLabFilters, baseUrl?: string): string {
  const url = new URL(`${normalizeLottoApiBase(baseUrl ?? configuredLottoApiBase())}${path}`);
  if (filters.game) url.searchParams.set("game", filters.game);
  if (filters.from) url.searchParams.set("from", filters.from);
  if (filters.to) url.searchParams.set("to", filters.to);
  if (filters.status) url.searchParams.set("status", filters.status);
  if (filters.limit !== undefined) url.searchParams.set("limit", String(filters.limit));
  if (filters.cursor) url.searchParams.set("cursor", filters.cursor);
  return url.toString();
}

async function readJson(
  path: string,
  filters: TicketLabFilters,
  options: ReadTicketLabOptions
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const token = options.token?.trim() ?? "";
  const response = await fetcher(apiUrl(path, filters, options.baseUrl), {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    cache: "no-store",
    signal: options.signal
  });
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // The status code is authoritative; test streams may not be cancellable.
    }
    throw new LottoTicketLabClientError(`Ticket Lab request failed with HTTP ${response.status}.`, response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new LottoTicketLabClientError("Ticket Lab returned malformed JSON.", response.status);
  }
}

export async function readTicketLabSummary(
  filters: Omit<TicketLabFilters, "status" | "limit" | "cursor"> = {},
  options: ReadTicketLabOptions = {}
): Promise<TicketLabSummaryResponse> {
  return parseTicketLabSummary(await readJson("/ticket-lab/summary", filters, options));
}

export async function readTicketLabEntries(
  filters: TicketLabFilters = {},
  options: ReadTicketLabOptions = {}
): Promise<TicketLabEntriesResponse> {
  return parseTicketLabEntries(await readJson("/ticket-lab/entries", filters, options));
}
