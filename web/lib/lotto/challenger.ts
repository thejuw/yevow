/** Versioned, paper-only challengers. These never change the deployed picker. */
import { combinationCount } from "./coverage";
import { EV_RULES } from "./ev";
import { GAME_MANIFEST } from "./manifest";
import { createSeededRng, randomInteger, sampleWithoutReplacement, type SeededRng } from "./rng";
import {
  LottoValidationError,
  type DigitPlayStyle,
  type GameCode,
  type Seed,
  type Ticket
} from "./types";
import { isPurePermutationStyle, validateTicket } from "./validation";

export const CHALLENGER_IDS = ["neutral-v1", "aon-prize-v1", "bonus-diversity-v1"] as const;
export type ChallengerId = (typeof CHALLENGER_IDS)[number];
export type PortfolioObjective = "any-prize" | "profitable-draw";

const MAX_TICKETS = 64;
const MAX_OPTIMIZATION_EVALUATIONS = 8_000_000;
const AON_FULL_MASK = (1 << 24) - 1;
const AON_TOTAL_OUTCOMES = combinationCount(24, 12);
const AON_COST_CENTS = GAME_MANIFEST.aon.baseCostCents;
const AON_PRIZES = Object.freeze(
  Array.from(
    { length: 13 },
    (_, matches) =>
      EV_RULES.aon.tiers.find((tier) => tier.name === `${matches} of 12`)?.prizeCents ?? 0
  )
);

/** Integer rational: cents for return, cents squared for monetary variance. */
export interface IntegerRatio {
  readonly numerator: string;
  readonly denominator: string;
}

export interface ProbabilityEstimate {
  readonly events: number;
  readonly probability: number;
  readonly standardError: number;
  /** Wilson interval, including nonzero uncertainty when zero events are sampled. */
  readonly interval95: readonly [number, number];
}

export interface PortfolioMetrics {
  readonly method: "seeded-uniform-draw-monte-carlo";
  readonly evaluationSeed: string;
  readonly simulations: number;
  readonly ticketCount: number;
  readonly stakeCents: number;
  readonly anyPrize: ProbabilityEstimate;
  readonly profitableDraw: ProbabilityEstimate;
  readonly breakEvenDraw: ProbabilityEstimate;
  readonly sampledReturnCents: string;
  readonly sampledReturnVarianceCentsSquared: IntegerRatio;
  /** Exact nominal expectation, independent of portfolio geometry; before liability caps. */
  readonly theoreticalGrossReturnCents: IntegerRatio;
  readonly theoreticalNetReturnCents: IntegerRatio;
  readonly notes: readonly string[];
}

export interface ChallengerInput {
  readonly game: GameCode;
  readonly count: number;
  readonly seed: Seed;
  readonly playStyle?: DigitPlayStyle;
  readonly challengerId?: ChallengerId;
  readonly objective?: PortfolioObjective;
  readonly optimizationDraws?: number;
  readonly evaluationDraws?: number;
  readonly candidatePoolSize?: number;
}

export interface ChallengerResult {
  readonly challengerId: ChallengerId;
  readonly version: 1;
  readonly game: GameCode;
  readonly seed: Seed;
  readonly tickets: readonly Ticket[];
  readonly objective: PortfolioObjective | "uniform-distinct" | "balanced-bonus";
  readonly metrics: PortfolioMetrics | null;
  readonly notes: readonly string[];
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new LottoValidationError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function streamSeed(seed: Seed, label: string): string {
  // Preserve the distinction between numeric 7 and string "7".
  return `challenger-v1:${typeof seed}:${String(seed)}:${label}`;
}

function maskOf(numbers: readonly number[]): number {
  return numbers.reduce((mask, number) => mask | (1 << (number - 1)), 0);
}

function popcount(value: number): number {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Complement tickets have identical nominal AON payoffs for every possible draw. */
export function aonExposureKey(ticket: Ticket): number {
  const mask = maskOf(validateTicket("aon", ticket).main);
  return Math.min(mask, AON_FULL_MASK ^ mask);
}

/** Current nominal AON award, in integer cents; top-tier liability caps are excluded. */
export function aonPrizeCents(matches: number): number {
  return AON_PRIZES[boundedInteger(matches, 0, 12, "AON match count")]!;
}

function exposureKey(ticket: Ticket): string {
  if (ticket.game === "aon") return `aon:${aonExposureKey(ticket)}`;
  const main = isPurePermutationStyle(ticket.playStyle ?? "straight")
    ? [...ticket.main].sort((a, b) => a - b)
    : ticket.main;
  return `${main.join(",")}|${(ticket.bonus ?? []).join(",")}|${ticket.playStyle}`;
}

function sampleTicket(game: GameCode, style: DigitPlayStyle, rng: SeededRng): Ticket {
  const rule = GAME_MANIFEST[game];
  return {
    game,
    main:
      rule.kind === "digits"
        ? Array.from({ length: rule.main.count }, () => randomInteger(rng, 0, 9))
        : sampleWithoutReplacement(rng, rule.main.min, rule.main.max, rule.main.count),
    ...(rule.bonus
      ? { bonus: sampleWithoutReplacement(rng, rule.bonus.min, rule.bonus.max, rule.bonus.count) }
      : {}),
    playStyle: style
  };
}

function neutralTickets(input: ChallengerInput, balancedBonus: boolean): Ticket[] {
  const rng = createSeededRng(streamSeed(input.seed, balancedBonus ? "bonus" : "neutral"));
  const rule = GAME_MANIFEST[input.game];
  const style = input.playStyle ?? "straight";
  const tickets: Ticket[] = [];
  const keys = new Set<string>();
  let bonusCycle: number[] = [];
  for (let attempt = 0; attempt < input.count * 200 && tickets.length < input.count; attempt += 1) {
    let proposed = sampleTicket(input.game, style, rng);
    if (balancedBonus && rule.bonus) {
      if (bonusCycle.length === 0) {
        bonusCycle = sampleWithoutReplacement(
          rng,
          rule.bonus.min,
          rule.bonus.max,
          rule.bonus.max - rule.bonus.min + 1
        );
      }
      proposed = { ...proposed, bonus: [bonusCycle[0]!] };
    }
    let ticket: Ticket;
    try {
      ticket = validateTicket(input.game, proposed);
    } catch (error) {
      if (!(error instanceof LottoValidationError)) throw error;
      // All-same-digit box tickets are illegal; rejection sampling remains neutral.
      continue;
    }
    const key = exposureKey(ticket);
    if (keys.has(key)) continue;
    keys.add(key);
    tickets.push(ticket);
    if (balancedBonus) bonusCycle.shift();
  }
  if (tickets.length !== input.count) {
    throw new LottoValidationError(
      "Could not produce the requested distinct challenger exposures within the bounded sampling budget"
    );
  }
  return tickets;
}

function aonDrawMasks(seed: string, count: number): Uint32Array {
  const rng = createSeededRng(seed);
  return Uint32Array.from({ length: count }, () =>
    maskOf(sampleWithoutReplacement(rng, 1, 24, 12))
  );
}

function probabilityEstimate(events: number, count: number): ProbabilityEstimate {
  const probability = events / count;
  const z = 1.959963984540054;
  const zSquared = z * z;
  const denominator = 1 + zSquared / count;
  const center = (probability + zSquared / (2 * count)) / denominator;
  const radius =
    (z * Math.sqrt((probability * (1 - probability)) / count + zSquared / (4 * count * count))) /
    denominator;
  return {
    events,
    probability,
    standardError: Math.sqrt((probability * (1 - probability)) / count),
    interval95: [Math.max(0, center - radius), Math.min(1, center + radius)]
  };
}

function theoreticalAonReturn(count: number): { gross: IntegerRatio; net: IntegerRatio } {
  const denominator = BigInt(AON_TOTAL_OUTCOMES);
  const numerator =
    BigInt(count) *
    EV_RULES.aon.tiers.reduce(
      (sum, tier) => sum + BigInt(tier.eventCount) * BigInt(tier.prizeCents),
      0n
    );
  return {
    gross: { numerator: numerator.toString(), denominator: denominator.toString() },
    net: {
      numerator: (numerator - BigInt(count * AON_COST_CENTS) * denominator).toString(),
      denominator: denominator.toString()
    }
  };
}

/** Evaluate a frozen portfolio on a separate, reproducible uniform-draw stream. */
export function evaluateAonPortfolio(
  tickets: readonly Ticket[],
  options: { readonly seed: Seed; readonly draws?: number }
): PortfolioMetrics {
  boundedInteger(tickets.length, 1, MAX_TICKETS, "ticket count");
  createSeededRng(options.seed); // Validate seed before deriving a text stream seed.
  const draws = boundedInteger(options.draws ?? 4_096, 256, 32_768, "evaluation draws");
  const evaluationSeed = streamSeed(options.seed, "evaluation");
  const masks = tickets.map((ticket) => maskOf(validateTicket("aon", ticket).main));
  const stakeCents = tickets.length * AON_COST_CENTS;
  let anyPrize = 0;
  let profitableDraw = 0;
  let breakEvenDraw = 0;
  let sum = 0n;
  let sumSquares = 0n;
  for (const draw of aonDrawMasks(evaluationSeed, draws)) {
    const returnCents = masks.reduce(
      (total, mask) => total + AON_PRIZES[popcount(mask & draw)]!,
      0
    );
    anyPrize += Number(returnCents > 0);
    profitableDraw += Number(returnCents > stakeCents);
    breakEvenDraw += Number(returnCents === stakeCents);
    sum += BigInt(returnCents);
    sumSquares += BigInt(returnCents) ** 2n;
  }
  const expectation = theoreticalAonReturn(tickets.length);
  return {
    method: "seeded-uniform-draw-monte-carlo",
    evaluationSeed,
    simulations: draws,
    ticketCount: tickets.length,
    stakeCents,
    anyPrize: probabilityEstimate(anyPrize, draws),
    profitableDraw: probabilityEstimate(profitableDraw, draws),
    breakEvenDraw: probabilityEstimate(breakEvenDraw, draws),
    sampledReturnCents: sum.toString(),
    sampledReturnVarianceCentsSquared: {
      numerator: (BigInt(draws) * sumSquares - sum * sum).toString(),
      denominator: (BigInt(draws) * BigInt(draws - 1)).toString()
    },
    theoreticalGrossReturnCents: expectation.gross,
    theoreticalNetReturnCents: expectation.net,
    notes: [
      "Simulation probabilities and 95% Wilson intervals describe uniform hypothetical draws, not predictions or forward results.",
      "Evaluation draws are independent of the optimization draw stream; the seed and simulation count are retained for reproduction.",
      "Nominal fixed prizes before liability caps, taxes, and reinvestment. Profitable means total cash return strictly exceeds this entire set's cost.",
      "Portfolio geometry changes prize probability and variance, not nominal per-ticket expected dollars. Rare jackpots make sampled dollar variance especially unstable."
    ]
  };
}

function prizeAwareAon(input: ChallengerInput, objective: PortfolioObjective): Ticket[] {
  const simulations = boundedInteger(
    input.optimizationDraws ?? 1_024,
    256,
    8_192,
    "optimization draws"
  );
  const candidatePool = boundedInteger(
    input.candidatePoolSize ?? 48,
    4,
    256,
    "candidate pool size"
  );
  if (input.count * simulations * candidatePool > MAX_OPTIMIZATION_EVALUATIONS) {
    throw new LottoValidationError(
      "Requested challenger search exceeds the bounded Worker evaluation budget"
    );
  }
  const draws = aonDrawMasks(streamSeed(input.seed, "optimization"), simulations);
  const rng = createSeededRng(streamSeed(input.seed, "candidates"));
  const cumulative = new Uint32Array(simulations);
  const tickets: Ticket[] = [];
  const keys = new Set<string>();
  for (let ordinal = 0; ordinal < input.count; ordinal += 1) {
    let chosen: Ticket | undefined;
    let chosenMask = 0;
    let bestPrimary = -1;
    let bestSecondary = -1;
    let accepted = 0;
    const candidates = new Set<string>();
    const target = ordinal === 0 ? 1 : candidatePool;
    for (let attempt = 0; attempt < target * 20 && accepted < target; attempt += 1) {
      const ticket = validateTicket("aon", sampleTicket("aon", "straight", rng));
      const key = exposureKey(ticket);
      if (keys.has(key) || candidates.has(key)) continue;
      candidates.add(key);
      accepted += 1;
      const mask = maskOf(ticket.main);
      let prizeEvents = 0;
      let profitEvents = 0;
      for (let index = 0; index < simulations; index += 1) {
        const returnCents = cumulative[index]! + AON_PRIZES[popcount(mask & draws[index]!)]!;
        prizeEvents += Number(returnCents > 0);
        profitEvents += Number(returnCents > (ordinal + 1) * AON_COST_CENTS);
      }
      const primary = objective === "any-prize" ? prizeEvents : profitEvents;
      const secondary = objective === "any-prize" ? profitEvents : prizeEvents;
      if (primary > bestPrimary || (primary === bestPrimary && secondary > bestSecondary)) {
        chosen = ticket;
        chosenMask = mask;
        bestPrimary = primary;
        bestSecondary = secondary;
      }
    }
    if (!chosen)
      throw new LottoValidationError("AON challenger exhausted its bounded candidate budget");
    tickets.push(chosen);
    keys.add(exposureKey(chosen));
    for (let index = 0; index < simulations; index += 1) {
      cumulative[index] = cumulative[index]! + AON_PRIZES[popcount(chosenMask & draws[index]!)]!;
    }
  }
  return tickets;
}

/**
 * Generate legal frozen challengers without history, heuristic lucky-number exclusions,
 * network access, mutable global state, purchases, or notifications.
 */
export function generateChallenger(input: ChallengerInput): ChallengerResult {
  if (!Object.prototype.hasOwnProperty.call(GAME_MANIFEST, input.game)) {
    throw new LottoValidationError(`Unknown challenger game ${JSON.stringify(input.game)}`);
  }
  boundedInteger(input.count, 1, MAX_TICKETS, "ticket count");
  createSeededRng(input.seed);
  const id = input.challengerId ?? "neutral-v1";
  if (!(CHALLENGER_IDS as readonly string[]).includes(id)) {
    throw new LottoValidationError(`Unknown challenger version ${JSON.stringify(id)}`);
  }
  const style = input.playStyle ?? "straight";
  if (!GAME_MANIFEST[input.game].optimizerPlayStyles.includes(style)) {
    throw new LottoValidationError(`Unsupported challenger play style ${JSON.stringify(style)}`);
  }
  const objective = input.objective ?? "any-prize";
  if (objective !== "any-prize" && objective !== "profitable-draw") {
    throw new LottoValidationError(`Unknown challenger objective ${JSON.stringify(objective)}`);
  }
  if (id === "aon-prize-v1" && input.game !== "aon") {
    throw new LottoValidationError("The AON prize challenger only supports All or Nothing");
  }
  if (id === "bonus-diversity-v1" && !GAME_MANIFEST[input.game].bonus) {
    throw new LottoValidationError("The bonus-diversity challenger requires a bonus-ball game");
  }
  const tickets =
    id === "aon-prize-v1"
      ? prizeAwareAon(input, objective)
      : neutralTickets(input, id === "bonus-diversity-v1");
  return {
    challengerId: id,
    version: 1,
    game: input.game,
    seed: input.seed,
    tickets,
    objective:
      id === "aon-prize-v1"
        ? objective
        : id === "neutral-v1"
          ? "uniform-distinct"
          : "balanced-bonus",
    metrics:
      input.game === "aon"
        ? evaluateAonPortfolio(tickets, { seed: input.seed, draws: input.evaluationDraws })
        : null,
    notes: [
      "Paper-only forward challenger. Picks are optimized, not predicted. No increase in spending is requested.",
      "Freeze version, seed, settings and tickets before the draw; do not promote a challenger on retrospective or simulated wins.",
      id === "aon-prize-v1"
        ? "Bounded greedy search on simulated nominal prizes; complementary AON tickets are the same payoff exposure and are not duplicated. The reported evaluation uses a separate simulation stream."
        : id === "bonus-diversity-v1"
          ? "Bonus values are balanced without replacement within cycles; changing prize coverage is not an increase in expected dollars."
          : "Uniform ordered-digit or main/bonus-pool sampling, conditioned on legal distinct exposures. No birthday, lucky-digit, sum, or repeat-digit exclusions.",
      "For combo digit plays, pattern-dependent prices require a separate equal-budget eligibility check; equal ticket counts alone do not establish equal spending."
    ]
  };
}

export interface ExactAonPairMetrics {
  readonly totalOutcomes: number;
  readonly stakeCents: number;
  readonly anyPrizeOutcomes: number;
  readonly profitableDrawOutcomes: number;
  readonly payoutDistribution: readonly {
    readonly returnCents: number;
    readonly outcomes: number;
  }[];
  readonly theoreticalGrossReturnCents: IntegerRatio;
}

/** Exact four-region hypergeometric enumeration of every possible two-ticket draw. */
export function exactAonPairMetrics(first: Ticket, second: Ticket): ExactAonPairMetrics {
  const firstMask = maskOf(validateTicket("aon", first).main);
  const secondMask = maskOf(validateTicket("aon", second).main);
  const overlap = popcount(firstMask & secondMask);
  const only = 12 - overlap;
  const distribution = new Map<number, number>();
  let totalOutcomes = 0;
  let anyPrizeOutcomes = 0;
  let profitableDrawOutcomes = 0;
  let grossNumerator = 0n;
  for (let both = 0; both <= overlap; both += 1) {
    for (let a = 0; a <= only; a += 1) {
      for (let b = 0; b <= only; b += 1) {
        const neither = 12 - both - a - b;
        if (neither < 0 || neither > overlap) continue;
        const outcomes =
          combinationCount(overlap, both) *
          combinationCount(only, a) *
          combinationCount(only, b) *
          combinationCount(overlap, neither);
        const returnCents = AON_PRIZES[both + a]! + AON_PRIZES[both + b]!;
        totalOutcomes += outcomes;
        anyPrizeOutcomes += outcomes * Number(returnCents > 0);
        profitableDrawOutcomes += outcomes * Number(returnCents > 2 * AON_COST_CENTS);
        grossNumerator += BigInt(outcomes) * BigInt(returnCents);
        distribution.set(returnCents, (distribution.get(returnCents) ?? 0) + outcomes);
      }
    }
  }
  if (totalOutcomes !== AON_TOTAL_OUTCOMES)
    throw new Error("AON exact enumeration failed its outcome-count invariant");
  return {
    totalOutcomes,
    stakeCents: 2 * AON_COST_CENTS,
    anyPrizeOutcomes,
    profitableDrawOutcomes,
    payoutDistribution: [...distribution]
      .sort(([left], [right]) => left - right)
      .map(([returnCents, outcomes]) => ({ returnCents, outcomes })),
    theoreticalGrossReturnCents: {
      numerator: grossNumerator.toString(),
      denominator: totalOutcomes.toString()
    }
  };
}
