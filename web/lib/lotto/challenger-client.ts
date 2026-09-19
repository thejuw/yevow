import { isGameCode } from "./manifest";
import { configuredLottoApiBase, normalizeLottoApiBase } from "./status-client";
import {
  LottoTicketLabClientError,
  type ReadTicketLabOptions,
  type TicketLabFilters
} from "./ticket-lab-client";
import type { GameCode, Ticket } from "./types";
import { validateTicket } from "./validation";

export interface ShadowScorecard {
  readonly gradedDraws: number;
  readonly gradedTickets: number;
  /** Only graded, matched trials contribute to these costs and returns. */
  readonly spentCents: number;
  readonly wonCents: number;
  readonly nonCashValueCents: number;
  readonly pendingPrizeCount: number;
  readonly roiPercent: number | null;
}

export interface ChallengerVariant extends ShadowScorecard {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly goal: string;
  readonly frozenAt: string | null;
  readonly firstEligibleDrawDate: string | null;
  readonly draws: number;
  readonly tickets: number;
  readonly status: "armed" | "collecting";
  readonly comparisons: { readonly current: ShadowScorecard; readonly random: ShadowScorecard };
}

export interface ChallengerTrial {
  readonly trialId: string;
  readonly variantId: string;
  readonly game: GameCode;
  readonly drawDate: string;
  readonly targetSession: string;
  readonly proposedAt: string;
  readonly seed: string;
  readonly configHash: string;
  readonly observedThrough: string | null;
  readonly status: "open" | "graded" | "pending" | "excluded";
  readonly tickets: readonly Ticket[];
}

export interface ChallengerResponse {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly data: {
    readonly policy: {
      readonly paperOnly: true;
      readonly forwardOnly: true;
      readonly autoPromotion: false;
      readonly matching: readonly [
        "game",
        "drawDate",
        "targetSession",
        "ticketCount",
        "wagerCents",
        "playStyle"
      ];
      readonly description: string;
      readonly reviewDate: string;
    };
    readonly variants: readonly ChallengerVariant[];
    readonly latest: readonly ChallengerTrial[];
    readonly disclaimer: string;
  };
}

type Json = Record<string, unknown>;
const MATCHING = [
  "game",
  "drawDate",
  "targetSession",
  "ticketCount",
  "wagerCents",
  "playStyle"
] as const;

function fail(field: string): never {
  throw new LottoTicketLabClientError(`Challenger response ${field} is invalid.`);
}

function record(value: unknown, field: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  return value as Json;
}

function text(value: unknown, field: string, maximum = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) fail(field);
  return value as string;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(field);
  return value as number;
}

function iso(value: unknown, field: string, calendarOnly = false): string {
  const result = text(value, field, 64);
  const candidate = calendarOnly ? `${result}T12:00:00Z` : result;
  if (
    !Number.isFinite(Date.parse(candidate)) ||
    (calendarOnly
      ? !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
        new Date(candidate).toISOString().slice(0, 10) !== result
      : !/^\d{4}-\d{2}-\d{2}T/.test(result))
  )
    fail(field);
  return result;
}

function scorecard(value: unknown, field: string): ShadowScorecard {
  const row = record(value, field);
  const result = {
    gradedDraws: integer(row.gradedDraws, `${field}.gradedDraws`),
    gradedTickets: integer(row.gradedTickets, `${field}.gradedTickets`),
    spentCents: integer(row.spentCents, `${field}.spentCents`),
    wonCents: integer(row.wonCents, `${field}.wonCents`),
    nonCashValueCents: integer(row.nonCashValueCents, `${field}.nonCashValueCents`),
    pendingPrizeCount: integer(row.pendingPrizeCount, `${field}.pendingPrizeCount`),
    roiPercent: row.roiPercent === null ? null : Number(row.roiPercent)
  };
  if (
    row.roiPercent !== null &&
    (typeof row.roiPercent !== "number" || !Number.isFinite(row.roiPercent))
  )
    fail(`${field}.roiPercent`);
  if ((result.pendingPrizeCount > 0 || result.spentCents === 0) && result.roiPercent !== null)
    fail(`${field}.unresolvedRoi`);
  if (result.pendingPrizeCount > result.gradedTickets || result.gradedDraws > result.gradedTickets)
    fail(`${field}.counts`);
  if (
    result.roiPercent !== null &&
    Math.abs(
      result.roiPercent - ((result.wonCents - result.spentCents) / result.spentCents) * 100
    ) > 0.011
  )
    fail(`${field}.roiReconciliation`);
  return result;
}

/** Fail closed if paper-only safeguards or equal-sample accounting are missing. */
export function parseChallengers(value: unknown): ChallengerResponse {
  const input = record(value, "envelope");
  if (input.schemaVersion !== 1) fail("schemaVersion");
  const data = record(input.data, "data");
  const policy = record(data.policy, "policy");
  const matching = policy.matching;
  if (
    policy.paperOnly !== true ||
    policy.forwardOnly !== true ||
    policy.autoPromotion !== false ||
    !Array.isArray(matching) ||
    matching.length !== MATCHING.length ||
    MATCHING.some((key, index) => matching[index] !== key)
  )
    fail("policy");
  if (
    !Array.isArray(data.variants) ||
    data.variants.length > 32 ||
    !Array.isArray(data.latest) ||
    data.latest.length > 20
  )
    fail("collections");
  const variants = data.variants.map((value, index): ChallengerVariant => {
    const field = `variants[${index}]`;
    const row = record(value, field);
    const own = scorecard(row, field);
    const comparisons = record(row.comparisons, `${field}.comparisons`);
    const current = scorecard(comparisons.current, `${field}.current`);
    const random = scorecard(comparisons.random, `${field}.random`);
    for (const comparison of [current, random]) {
      if (
        comparison.gradedDraws !== own.gradedDraws ||
        comparison.gradedTickets !== own.gradedTickets ||
        comparison.spentCents !== own.spentCents
      )
        fail(`${field}.equalSample`);
    }
    const draws = integer(row.draws, `${field}.draws`);
    const tickets = integer(row.tickets, `${field}.tickets`);
    if (
      own.gradedDraws > draws ||
      own.gradedTickets > tickets ||
      (row.status !== "armed" && row.status !== "collecting")
    )
      fail(`${field}.status`);
    return {
      ...own,
      id: text(row.id, `${field}.id`, 120),
      version: text(row.version, `${field}.version`, 120),
      label: text(row.label, `${field}.label`, 200),
      goal: text(row.goal, `${field}.goal`),
      frozenAt: row.frozenAt === null ? null : iso(row.frozenAt, `${field}.frozenAt`),
      firstEligibleDrawDate:
        row.firstEligibleDrawDate === null
          ? null
          : iso(row.firstEligibleDrawDate, `${field}.firstEligibleDrawDate`, true),
      draws,
      tickets,
      status: row.status,
      comparisons: { current, random }
    };
  });
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length)
    fail("duplicateVariants");
  const latest = data.latest.map((value, index): ChallengerTrial => {
    const field = `latest[${index}]`;
    const row = record(value, field);
    const game = text(row.game, `${field}.game`, 16);
    if (
      !isGameCode(game) ||
      !Array.isArray(row.tickets) ||
      row.tickets.length === 0 ||
      row.tickets.length > 2_000
    )
      fail(`${field}.tickets`);
    const variantId = text(row.variantId, `${field}.variantId`, 120);
    if (!variants.some((variant) => variant.id === variantId)) fail(`${field}.variantId`);
    if (
      row.status !== "open" &&
      row.status !== "graded" &&
      row.status !== "pending" &&
      row.status !== "excluded"
    )
      fail(`${field}.status`);
    let tickets: readonly Ticket[];
    try {
      tickets = (row.tickets as unknown[]).map((ticket) =>
        validateTicket(game as GameCode, ticket as Ticket)
      );
    } catch {
      fail(`${field}.tickets`);
    }
    return {
      trialId: text(row.trialId, `${field}.trialId`, 120),
      variantId,
      game: game as GameCode,
      drawDate: iso(row.drawDate, `${field}.drawDate`, true),
      targetSession:
        typeof row.targetSession === "string" && row.targetSession.length <= 40
          ? row.targetSession
          : fail(`${field}.targetSession`),
      proposedAt: iso(row.proposedAt, `${field}.proposedAt`),
      seed: text(row.seed, `${field}.seed`, 200),
      configHash: text(row.configHash, `${field}.configHash`, 128),
      observedThrough:
        row.observedThrough === null
          ? null
          : iso(row.observedThrough, `${field}.observedThrough`, true),
      status: row.status,
      tickets
    };
  });
  return {
    schemaVersion: 1,
    generatedAt: iso(input.generatedAt, "generatedAt"),
    data: {
      policy: {
        paperOnly: true,
        forwardOnly: true,
        autoPromotion: false,
        matching: MATCHING,
        description: text(policy.description, "policy.description"),
        reviewDate: iso(policy.reviewDate, "policy.reviewDate", true)
      },
      variants,
      latest,
      disclaimer: text(data.disclaimer, "disclaimer")
    }
  };
}

/** Read saved forward trials; never generates tickets or records a purchase. */
export async function readChallengers(
  filters: Pick<TicketLabFilters, "game" | "from" | "to"> = {},
  options: ReadTicketLabOptions = {}
): Promise<ChallengerResponse> {
  const url = new URL(
    `${normalizeLottoApiBase(options.baseUrl ?? configuredLottoApiBase())}/ticket-lab/challengers`
  );
  for (const key of ["game", "from", "to"] as const)
    if (filters[key]) url.searchParams.set(key, filters[key]!);
  const token = options.token?.trim();
  const response = await (options.fetcher ?? fetch)(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    cache: "no-store",
    signal: options.signal
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new LottoTicketLabClientError(
      `Challenger request failed with HTTP ${response.status}.`,
      response.status
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new LottoTicketLabClientError(
      "Challenger service returned malformed JSON.",
      response.status
    );
  }
  return parseChallengers(payload);
}
