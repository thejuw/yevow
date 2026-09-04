import { combinationCount } from "./coverage";
import { GAME_MANIFEST } from "./manifest";
import type {
  Daily4Pattern,
  DigitPattern,
  DigitPlayStyle,
  EvInput,
  EvInputsByGame,
  EvResult,
  EvTierResult,
  GameCode,
  Pick3Pattern,
  PrizeKind
} from "./types";
import { EvConfigurationError, GAME_CODES } from "./types";

interface TierRule {
  readonly name: string;
  readonly eventCount: number;
  readonly prizeCents: number;
  readonly kind: PrizeKind;
}

interface GameEvRules {
  readonly game: GameCode;
  readonly totalOutcomes: number;
  readonly tiers: readonly TierRule[];
  readonly jackpotTier?: string;
  readonly overallOddsNote?: string;
}

const FIXED: PrizeKind = "fixed";
const JACKPOT: PrizeKind = "pari-mutuel jackpot";
const PARI_ESTIMATE: PrizeKind = "pari-mutuel estimate";
const PARI_PLUS_FIXED: PrizeKind = "pari-mutuel estimate + fixed add-on";
const FREE_TICKET: PrizeKind = "free ticket";
const LIABILITY_CAPPED: PrizeKind = "liability-capped fixed prize";
const BUILT_IN_MULTIPLIER: PrizeKind = "fixed prize with built-in multiplier";
const PARI_MUTUEL_KINDS = new Set<PrizeKind>([
  JACKPOT,
  PARI_ESTIMATE,
  PARI_PLUS_FIXED,
  LIABILITY_CAPPED
]);
const MAX_MODEL_INPUT = 1_000_000_000_000_000;
const LEGAL_DIGIT_STAKES = new Set([50, 100, 200, 300, 400, 500]);
const MM_EXPECTED_MULTIPLIER = 3;

function poolEventCount(selected: number, field: number, matches: number): number {
  return (
    combinationCount(selected, matches) * combinationCount(field - selected, selected - matches)
  );
}

function bonusEventCount(
  selected: number,
  field: number,
  matches: number,
  bonusField: number,
  bonusMatch: boolean
): number {
  const main = poolEventCount(selected, field, matches);
  return bonusMatch ? main : main * (bonusField - 1);
}

const LOTTO_RULES: GameEvRules = {
  game: "lotto",
  totalOutcomes: combinationCount(54, 6),
  tiers: [
    { name: "6 of 6", eventCount: 1, prizeCents: 0, kind: JACKPOT },
    {
      name: "5 of 6",
      eventCount: poolEventCount(6, 54, 5),
      prizeCents: 200_000,
      kind: PARI_ESTIMATE
    },
    {
      name: "4 of 6",
      eventCount: poolEventCount(6, 54, 4),
      prizeCents: 5_000,
      kind: PARI_ESTIMATE
    },
    { name: "3 of 6", eventCount: poolEventCount(6, 54, 3), prizeCents: 300, kind: FIXED }
  ],
  jackpotTier: "6 of 6",
  overallOddsNote: "Official overall base-play odds are approximately 1 in 71.1."
};

const LOTTO_EXTRA_RULES: GameEvRules = {
  game: "lotto",
  totalOutcomes: combinationCount(54, 6),
  tiers: [
    { name: "6 of 6", eventCount: 1, prizeCents: 0, kind: JACKPOT },
    {
      name: "5 of 6 with EXTRA!",
      eventCount: poolEventCount(6, 54, 5),
      prizeCents: 1_200_000,
      kind: PARI_PLUS_FIXED
    },
    {
      name: "4 of 6 with EXTRA!",
      eventCount: poolEventCount(6, 54, 4),
      prizeCents: 15_000,
      kind: PARI_PLUS_FIXED
    },
    {
      name: "3 of 6 with EXTRA!",
      eventCount: poolEventCount(6, 54, 3),
      prizeCents: 1_300,
      kind: FIXED
    },
    {
      name: "2 of 6 with EXTRA!",
      eventCount: poolEventCount(6, 54, 2),
      prizeCents: 200,
      kind: FIXED
    }
  ],
  jackpotTier: "6 of 6",
  overallOddsNote:
    "Official Lotto Texas with EXTRA! overall odds are approximately 1 in 7.9, including break-even prizes."
};

const TWOSTEP_RULES: GameEvRules = {
  game: "twostep",
  totalOutcomes: combinationCount(35, 4) * 35,
  tiers: [
    { name: "4 of 4 + Bonus", eventCount: 1, prizeCents: 0, kind: JACKPOT },
    {
      name: "4 of 4",
      eventCount: bonusEventCount(4, 35, 4, 35, false),
      prizeCents: 150_100,
      kind: PARI_ESTIMATE
    },
    {
      name: "3 of 4 + Bonus",
      eventCount: bonusEventCount(4, 35, 3, 35, true),
      prizeCents: 5_000,
      kind: PARI_ESTIMATE
    },
    {
      name: "3 of 4",
      eventCount: bonusEventCount(4, 35, 3, 35, false),
      prizeCents: 2_000,
      kind: PARI_ESTIMATE
    },
    {
      name: "2 of 4 + Bonus",
      eventCount: bonusEventCount(4, 35, 2, 35, true),
      prizeCents: 2_000,
      kind: PARI_ESTIMATE
    },
    {
      name: "1 of 4 + Bonus",
      eventCount: bonusEventCount(4, 35, 1, 35, true),
      prizeCents: 700,
      kind: FIXED
    },
    {
      name: "0 of 4 + Bonus",
      eventCount: bonusEventCount(4, 35, 0, 35, true),
      prizeCents: 500,
      kind: FIXED
    }
  ],
  jackpotTier: "4 of 4 + Bonus",
  overallOddsNote:
    "Official overall odds are approximately 1 in 32.4; jackpot odds are 1 in 1,832,600."
};

const CASH5_RULES: GameEvRules = {
  game: "cash5",
  totalOutcomes: combinationCount(35, 5),
  tiers: [
    { name: "5 of 5", eventCount: 1, prizeCents: 2_500_000, kind: LIABILITY_CAPPED },
    { name: "4 of 5", eventCount: poolEventCount(5, 35, 4), prizeCents: 35_000, kind: FIXED },
    { name: "3 of 5", eventCount: poolEventCount(5, 35, 3), prizeCents: 1_500, kind: FIXED },
    { name: "2 of 5", eventCount: poolEventCount(5, 35, 2), prizeCents: 100, kind: FREE_TICKET }
  ],
  overallOddsNote:
    "Official overall odds are approximately 1 in 7.2; top-prize odds are 1 in 324,632."
};

const PB_RULES: GameEvRules = {
  game: "pb",
  totalOutcomes: combinationCount(69, 5) * 26,
  tiers: [
    { name: "5 + Powerball", eventCount: 1, prizeCents: 0, kind: JACKPOT },
    {
      name: "5",
      eventCount: bonusEventCount(5, 69, 5, 26, false),
      prizeCents: 100_000_000,
      kind: FIXED
    },
    {
      name: "4 + Powerball",
      eventCount: bonusEventCount(5, 69, 4, 26, true),
      prizeCents: 5_000_000,
      kind: FIXED
    },
    {
      name: "4",
      eventCount: bonusEventCount(5, 69, 4, 26, false),
      prizeCents: 10_000,
      kind: FIXED
    },
    {
      name: "3 + Powerball",
      eventCount: bonusEventCount(5, 69, 3, 26, true),
      prizeCents: 10_000,
      kind: FIXED
    },
    { name: "3", eventCount: bonusEventCount(5, 69, 3, 26, false), prizeCents: 700, kind: FIXED },
    {
      name: "2 + Powerball",
      eventCount: bonusEventCount(5, 69, 2, 26, true),
      prizeCents: 700,
      kind: FIXED
    },
    {
      name: "1 + Powerball",
      eventCount: bonusEventCount(5, 69, 1, 26, true),
      prizeCents: 400,
      kind: FIXED
    },
    {
      name: "0 + Powerball",
      eventCount: bonusEventCount(5, 69, 0, 26, true),
      prizeCents: 400,
      kind: FIXED
    }
  ],
  jackpotTier: "5 + Powerball"
};

const MM_RULES: GameEvRules = {
  game: "mm",
  totalOutcomes: combinationCount(70, 5) * 24,
  tiers: [
    { name: "5 + Mega Ball", eventCount: 1, prizeCents: 0, kind: JACKPOT },
    {
      name: "5",
      eventCount: bonusEventCount(5, 70, 5, 24, false),
      prizeCents: 100_000_000,
      kind: BUILT_IN_MULTIPLIER
    },
    {
      name: "4 + Mega Ball",
      eventCount: bonusEventCount(5, 70, 4, 24, true),
      prizeCents: 1_000_000,
      kind: BUILT_IN_MULTIPLIER
    },
    {
      name: "4",
      eventCount: bonusEventCount(5, 70, 4, 24, false),
      prizeCents: 50_000,
      kind: BUILT_IN_MULTIPLIER
    },
    {
      name: "3 + Mega Ball",
      eventCount: bonusEventCount(5, 70, 3, 24, true),
      prizeCents: 20_000,
      kind: BUILT_IN_MULTIPLIER
    },
    {
      name: "3",
      eventCount: bonusEventCount(5, 70, 3, 24, false),
      prizeCents: 1_000,
      kind: BUILT_IN_MULTIPLIER
    },
    {
      name: "2 + Mega Ball",
      eventCount: bonusEventCount(5, 70, 2, 24, true),
      prizeCents: 1_000,
      kind: BUILT_IN_MULTIPLIER
    },
    {
      name: "1 + Mega Ball",
      eventCount: bonusEventCount(5, 70, 1, 24, true),
      prizeCents: 700,
      kind: BUILT_IN_MULTIPLIER
    },
    {
      name: "0 + Mega Ball",
      eventCount: bonusEventCount(5, 70, 0, 24, true),
      prizeCents: 500,
      kind: BUILT_IN_MULTIPLIER
    }
  ],
  jackpotTier: "5 + Mega Ball"
};

const AON_PRIZES_CENTS: Readonly<Record<number, number>> = {
  12: 25_000_000,
  11: 50_000,
  10: 5_000,
  9: 1_000,
  8: 200,
  4: 200,
  3: 1_000,
  2: 5_000,
  1: 50_000,
  0: 25_000_000
};

const AON_RULES: GameEvRules = {
  game: "aon",
  totalOutcomes: combinationCount(24, 12),
  tiers: [12, 11, 10, 9, 8, 4, 3, 2, 1, 0].map((matches) => ({
    name: `${matches} of 12`,
    eventCount: combinationCount(12, matches) * combinationCount(12, 12 - matches),
    prizeCents: AON_PRIZES_CENTS[matches]!,
    kind: matches === 0 || matches === 12 ? LIABILITY_CAPPED : FIXED
  }))
};

export const EV_RULES = Object.freeze({
  lotto: LOTTO_RULES,
  twostep: TWOSTEP_RULES,
  cash5: CASH5_RULES,
  pb: PB_RULES,
  mm: MM_RULES,
  aon: AON_RULES
});

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_MODEL_INPUT) {
    throw new EvConfigurationError(`${name} must be finite and between 0 and ${MAX_MODEL_INPUT}`);
  }
  return value;
}

function safeNonNegativeInteger(value: number, name: string): number {
  finiteNonNegative(value, name);
  if (!Number.isSafeInteger(value)) {
    throw new EvConfigurationError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

/** E[1/(1+K)] for a Poisson count K of competing winners. */
export function expectedSplitShare(splitLambda: number): number {
  finiteNonNegative(splitLambda, "splitLambda");
  if (splitLambda === 0) return 1;
  return -Math.expm1(-splitLambda) / splitLambda;
}

function logFactorial(value: number): number {
  if (value < 2) return 0;
  if (value < 256) {
    let result = 0;
    for (let number = 2; number <= value; number += 1) result += Math.log(number);
    return result;
  }
  const n = value;
  const inverse = 1 / n;
  return (
    (n + 0.5) * Math.log(n) -
    n +
    0.5 * Math.log(2 * Math.PI) +
    inverse / 12 -
    inverse ** 3 / 360 +
    inverse ** 5 / 1_260
  );
}

function expectedCappedPrizeCents(
  basePrizeCents: number,
  liabilityCapCents: number,
  fullPrizeWinnerLimit: number,
  lambda: number
): number {
  if (lambda === 0) return basePrizeCents;
  const maximumPaidOtherWinners = Math.floor(liabilityCapCents / 100) - 1;
  if (lambda > (maximumPaidOtherWinners + 1) * 2) return 0;

  const spread = Math.ceil(14 * Math.sqrt(lambda) + 100);
  const lower = Math.max(0, Math.floor(lambda) - spread);
  const upper = Math.min(maximumPaidOtherWinners, Math.floor(lambda) + spread);
  if (upper < lower) return 0;
  const center = Math.min(upper, Math.max(lower, Math.floor(lambda)));
  const centerProbability = Math.exp(-lambda + center * Math.log(lambda) - logFactorial(center));
  if (centerProbability === 0) return 0;

  const payout = (otherWinners: number): number =>
    otherWinners < fullPrizeWinnerLimit
      ? basePrizeCents
      : Math.floor(liabilityCapCents / (otherWinners + 1) / 100) * 100;

  let expected = payout(center) * centerProbability;
  let probability = centerProbability;
  for (let otherWinners = center - 1; otherWinners >= lower; otherWinners -= 1) {
    probability *= (otherWinners + 1) / lambda;
    expected += payout(otherWinners) * probability;
  }
  probability = centerProbability;
  for (let otherWinners = center + 1; otherWinners <= upper; otherWinners += 1) {
    probability *= lambda / otherWinners;
    expected += payout(otherWinners) * probability;
  }
  return expected;
}

const STYLE_ALIASES: Readonly<
  Record<string, "straight" | "box" | "straight-box" | "combo" | "pair">
> = {
  exact: "straight",
  straight: "straight",
  "exact-order": "straight",
  any: "box",
  anybox: "box",
  "any-order": "box",
  box: "box",
  "straight-box": "straight-box",
  "straight/box": "straight-box",
  "straight+box": "straight-box",
  "exact-any": "straight-box",
  "exact/any": "straight-box",
  "exact-any-order": "straight-box",
  "exact/any-order": "straight-box",
  "exact/anybox": "straight-box",
  combo: "combo",
  "front-pair": "pair",
  "mid-pair": "pair",
  "middle-pair": "pair",
  "back-pair": "pair"
};

function digitRules(input: EvInput): { rules: GameEvRules; ticketCostCents: number } {
  const game = input.game;
  if (game !== "p3" && game !== "d4") {
    throw new EvConfigurationError("digit rules require Pick 3 or Daily 4");
  }
  const stake = input.stakeCents ?? 50;
  if (!LEGAL_DIGIT_STAKES.has(stake)) {
    throw new EvConfigurationError(
      "digit-game stakeCents must be exactly 50, 100, 200, 300, 400, or 500"
    );
  }
  const styleKey = (input.playStyle ?? "straight").trim().toLowerCase();
  const style = STYLE_ALIASES[styleKey];
  if (!style || (style === "pair" && game !== "d4")) {
    throw new EvConfigurationError(`unsupported ${game} play style ${JSON.stringify(styleKey)}`);
  }
  const scale = stake / 50;
  if (style === "pair") {
    if (input.digitPattern !== undefined) {
      throw new EvConfigurationError(
        "digitPattern does not apply to Daily 4 front/mid/back-pair plays"
      );
    }
    return {
      rules: {
        game,
        totalOutcomes: 100,
        tiers: [
          { name: `${styleKey} match`, eventCount: 1, prizeCents: 2_500 * scale, kind: FIXED }
        ]
      },
      ticketCostCents: stake
    };
  }

  const pattern = input.digitPattern ?? (game === "p3" ? "abc" : "abcd");
  let ways: number;
  let boxPrizeCents: number;
  let straightPrizeCents: number;
  let combinedPrizeCents: number;
  if (game === "p3") {
    const valid = new Set<DigitPattern>(["aaa", "aab", "abc"]);
    if (!valid.has(pattern)) {
      throw new EvConfigurationError(`invalid Pick 3 digit pattern ${JSON.stringify(pattern)}`);
    }
    const typed = pattern as Pick3Pattern;
    ways = { aaa: 1, aab: 3, abc: 6 }[typed];
    boxPrizeCents = { aaa: 25_000, aab: 8_000, abc: 4_000 }[typed];
    straightPrizeCents = 25_000;
    combinedPrizeCents = { aaa: 25_000, aab: 33_000, abc: 29_000 }[typed];
  } else {
    const valid = new Set<DigitPattern>(["aaaa", "aaab", "aabb", "aabc", "abcd"]);
    if (!valid.has(pattern)) {
      throw new EvConfigurationError(`invalid Daily 4 digit pattern ${JSON.stringify(pattern)}`);
    }
    const typed = pattern as Daily4Pattern;
    ways = { aaaa: 1, aaab: 4, aabb: 6, aabc: 12, abcd: 24 }[typed];
    boxPrizeCents = { aaaa: 250_000, aaab: 60_000, aabb: 40_000, aabc: 20_000, abcd: 10_000 }[
      typed
    ];
    straightPrizeCents = 250_000;
    combinedPrizeCents = {
      aaaa: 250_000,
      aaab: 310_000,
      aabb: 290_000,
      aabc: 270_000,
      abcd: 260_000
    }[typed];
  }
  if (ways === 1 && style !== "straight") {
    throw new EvConfigurationError(
      `${style} is not a distinct official play for an all-same digit pattern`
    );
  }

  let tiers: readonly TierRule[];
  let ticketCostCents: number;
  if (style === "straight") {
    tiers = [
      { name: "straight", eventCount: 1, prizeCents: straightPrizeCents * scale, kind: FIXED }
    ];
    ticketCostCents = stake;
  } else if (style === "box") {
    tiers = [
      { name: `${ways}-way box`, eventCount: ways, prizeCents: boxPrizeCents * scale, kind: FIXED }
    ];
    ticketCostCents = stake;
  } else if (style === "straight-box") {
    tiers = [
      {
        name: "straight + box",
        eventCount: 1,
        prizeCents: combinedPrizeCents * scale,
        kind: FIXED
      },
      { name: "box only", eventCount: ways - 1, prizeCents: boxPrizeCents * scale, kind: FIXED }
    ];
    ticketCostCents = stake * 2;
  } else {
    tiers = [
      {
        name: `${ways}-way combo`,
        eventCount: ways,
        prizeCents: straightPrizeCents * scale,
        kind: FIXED
      }
    ];
    ticketCostCents = stake * ways;
  }
  return {
    rules: { game, totalOutcomes: game === "p3" ? 1_000 : 10_000, tiers },
    ticketCostCents
  };
}

function resolveRules(input: EvInput): { rules: GameEvRules; ticketCostCents: number } {
  const config = GAME_MANIFEST[input.game];
  if (config.kind === "digits") {
    if (input.extra) throw new EvConfigurationError("EXTRA is available only for Lotto Texas");
    return digitRules(input);
  }
  if (input.playStyle !== undefined && input.playStyle !== "straight") {
    throw new EvConfigurationError(
      `playStyle applies only to Pick 3 and Daily 4, not ${config.name}`
    );
  }
  if (input.digitPattern !== undefined) {
    throw new EvConfigurationError(
      `digitPattern applies only to Pick 3 and Daily 4, not ${config.name}`
    );
  }
  if (input.stakeCents !== undefined && input.stakeCents !== 50) {
    throw new EvConfigurationError("stakeCents is configurable only for Pick 3 and Daily 4");
  }
  if (input.extra) {
    if (input.game !== "lotto") {
      throw new EvConfigurationError("EXTRA is available only for Lotto Texas");
    }
    return { rules: LOTTO_EXTRA_RULES, ticketCostCents: 200 };
  }
  return {
    rules: EV_RULES[input.game as keyof typeof EV_RULES],
    ticketCostCents: config.baseCostCents
  };
}

/** Calculate pre-tax long-run EV using integer-cent inputs and exact event counts. */
export function calculateEv(input: EvInput): EvResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EvConfigurationError("EV input must be a non-null object");
  }
  if (!Object.prototype.hasOwnProperty.call(GAME_MANIFEST, input.game)) {
    throw new EvConfigurationError(`Unknown lottery game ${JSON.stringify(input.game)}`);
  }
  if (input.extra !== undefined && typeof input.extra !== "boolean") {
    throw new EvConfigurationError("extra must be a boolean");
  }
  const jackpotCents = safeNonNegativeInteger(input.jackpotCents ?? 0, "jackpotCents");
  const ticketSales = safeNonNegativeInteger(input.ticketSales ?? 0, "ticketSales");
  const popularityMultiplier = finiteNonNegative(
    input.popularityMultiplier ?? 1,
    "popularityMultiplier"
  );
  const config = GAME_MANIFEST[input.game];
  const { rules, ticketCostCents } = resolveRules(input);
  const hasCappedPrize = rules.tiers.some((tier) => tier.kind === LIABILITY_CAPPED);
  const competitionModeled = Boolean(rules.jackpotTier) || hasCappedPrize;
  if (!competitionModeled && ticketSales !== 0) {
    throw new EvConfigurationError(`ticketSales does not affect fixed ${config.name} prizes`);
  }
  if (!competitionModeled && popularityMultiplier !== 1) {
    throw new EvConfigurationError(
      `popularityMultiplier does not affect fixed ${config.name} prizes`
    );
  }
  if (!rules.jackpotTier && jackpotCents !== 0) {
    throw new EvConfigurationError(`${config.name} has no rollover jackpot input`);
  }

  const competingPlays = Math.max(ticketSales - 1, 0);
  const jackpotProbability = 1 / rules.totalOutcomes;
  const splitLambda = rules.jackpotTier
    ? competingPlays * jackpotProbability * popularityMultiplier
    : 0;
  const jackpotShare = rules.jackpotTier ? expectedSplitShare(splitLambda) : 0;
  const tiers: EvTierResult[] = rules.tiers.map((tier) => {
    const probability = tier.eventCount / rules.totalOutcomes;
    const nominalPrizeCents = tier.kind === JACKPOT ? jackpotCents : tier.prizeCents;
    let adjustedPrizeCents = nominalPrizeCents;
    let tierLambda = 0;
    const notes: string[] = [];
    if (tier.kind === JACKPOT) {
      adjustedPrizeCents *= jackpotShare;
      tierLambda = splitLambda;
      notes.push("Cash jackpot adjusted for expected competing winning plays.");
    } else if (tier.kind === BUILT_IN_MULTIPLIER) {
      adjustedPrizeCents *= MM_EXPECTED_MULTIPLIER;
      notes.push(
        "Expected built-in multiplier is exactly 3x from the official 32-part distribution."
      );
    } else if (tier.kind === FREE_TICKET) {
      notes.push("Non-cash Quick Pick valued at its $1 face cost; it cannot be taken as cash.");
    } else if (tier.kind === PARI_ESTIMATE) {
      notes.push(
        "Official estimated prize; the realized pari-mutuel amount depends on sales and winners."
      );
    } else if (tier.kind === PARI_PLUS_FIXED) {
      notes.push(
        "Includes the estimated pari-mutuel base prize plus the guaranteed EXTRA addition."
      );
    } else if (tier.kind === LIABILITY_CAPPED && input.game === "cash5") {
      tierLambda = competingPlays * probability * popularityMultiplier;
      adjustedPrizeCents = expectedCappedPrizeCents(2_500_000, 7_500_000, 3, tierLambda);
      notes.push(
        "$25,000 unless more than three top plays win; then $75,000 is divided and rounded down to whole dollars."
      );
    } else if (tier.kind === LIABILITY_CAPPED && input.game === "aon") {
      const topProbability = 2 / rules.totalOutcomes;
      tierLambda = competingPlays * topProbability * popularityMultiplier;
      adjustedPrizeCents = expectedCappedPrizeCents(25_000_000, 500_000_000, 20, tierLambda);
      notes.push(
        "$250,000 unless more than 20 top plays win; then $5 million is divided and rounded down to whole dollars."
      );
    }
    return Object.freeze({
      tier: tier.name,
      eventCount: tier.eventCount,
      totalOutcomes: rules.totalOutcomes,
      probability,
      nominalPrizeCents,
      adjustedPrizeCents,
      expectedValueCents: probability * adjustedPrizeCents,
      prizeKind: tier.kind,
      pariMutuel: PARI_MUTUEL_KINDS.has(tier.kind),
      splitLambda: tierLambda,
      notes: Object.freeze(notes)
    });
  });
  const grossEvCents = tiers.reduce((total, tier) => total + tier.expectedValueCents, 0);
  const netEvCents = grossEvCents - ticketCostCents;
  const assumptions = [
    "Probabilities use exact combinatorial event counts under a uniform certified draw.",
    "EV is before federal tax, discount-rate changes, travel, and claim costs."
  ];
  if (rules.jackpotTier) {
    assumptions.push(
      "Jackpot input is the pre-tax cash value in cents, not the advertised annuity.",
      "Competing jackpot wins follow a Poisson model; ticket popularity scales its mean."
    );
  }
  if (hasCappedPrize) {
    assumptions.push(
      "Liability-cap adjustments use a Poisson competing-winner model and official whole-dollar rounding."
    );
  }
  if (competitionModeled) {
    assumptions.push(
      `Popularity multiplier: ${popularityMultiplier}; estimated sales: ${ticketSales} plays.`
    );
  }
  if (input.game === "mm") {
    assumptions.push(
      "Mega Millions non-jackpot prizes use the built-in multiplier's exact 3x expectation."
    );
  }
  if (input.game === "pb" || input.game === "mm") {
    assumptions.push(
      "Published set prizes assume sufficient prize-pool and reserve funding; official rules permit reductions if insufficient."
    );
  }
  if (rules.tiers.some((tier) => tier.kind === PARI_ESTIMATE)) {
    assumptions.push(
      "Non-jackpot pari-mutuel tiers use official estimated prizes; realized amounts can vary."
    );
  }
  if (input.extra) {
    assumptions.push(
      "Lotto EXTRA adds $1, adds $10,000/$100/$10 at 5/4/3 matches, pays $2 at two matches, and does not enhance the jackpot."
    );
  }
  if (config.kind === "digits") {
    assumptions.push(
      "Digits are not due; play style changes cost and payout, not draw likelihood."
    );
  }
  if (rules.overallOddsNote) assumptions.push(rules.overallOddsNote);

  return Object.freeze({
    game: input.game,
    gameName: input.extra ? `${config.name} with EXTRA!` : config.name,
    ticketCostCents,
    grossEvCents,
    netEvCents,
    returnPercent: (grossEvCents / ticketCostCents) * 100,
    evPerTwoDollarsCents: (netEvCents * 200) / ticketCostCents,
    jackpotCents,
    ticketSales,
    popularityMultiplier,
    splitLambda,
    expectedJackpotShare: jackpotShare,
    tiers: Object.freeze(tiers),
    assumptions: Object.freeze(assumptions)
  });
}

/** Return the smallest integer-cent cash jackpot whose modeled net EV is non-negative. */
export function breakEvenJackpotCents(input: Omit<EvInput, "jackpotCents">): number {
  const baseline = calculateEv({ ...input, jackpotCents: 0 });
  if (baseline.expectedJackpotShare <= 0) {
    throw new EvConfigurationError(
      `${GAME_MANIFEST[input.game].name} has no variable rollover jackpot`
    );
  }
  if (baseline.grossEvCents >= baseline.ticketCostCents) return 0;
  const jackpotTier = baseline.tiers.find((tier) => tier.prizeKind === JACKPOT);
  if (!jackpotTier) {
    throw new EvConfigurationError(
      `${GAME_MANIFEST[input.game].name} has no variable rollover jackpot`
    );
  }
  return Math.ceil(
    (baseline.ticketCostCents - baseline.grossEvCents) /
      (jackpotTier.probability * baseline.expectedJackpotShare)
  );
}

/** Rank default base plays from worst to least-worst/best EV per $2 spent. */
export function calculateAllEv(inputs: EvInputsByGame = {}): readonly EvResult[] {
  return Object.freeze(
    GAME_CODES.map((game) => calculateEv({ game, ...(inputs[game] ?? {}) })).sort(
      (left, right) => left.evPerTwoDollarsCents - right.evPerTwoDollarsCents
    )
  );
}

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function formatMoneyCents(cents: number): string {
  if (!Number.isFinite(cents)) throw new RangeError("cents must be finite");
  return moneyFormatter.format(cents / 100);
}

export function formatProbability(probability: number): string {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("probability must be finite and between zero and one");
  }
  if (probability === 0) return "0";
  return probability < 0.001
    ? probability.toExponential(6)
    : probability.toLocaleString("en-US", { maximumFractionDigits: 9 });
}

function verifyRuleTables(): void {
  const expected: Readonly<Record<keyof typeof EV_RULES, readonly [number, readonly number[]]>> = {
    lotto: [25_827_165, [1, 288, 16_920, 345_920]],
    twostep: [1_832_600, [1, 34, 124, 4_216, 2_790, 17_980, 31_465]],
    cash5: [324_632, [1, 150, 4_350, 40_600]],
    pb: [292_201_338, [1, 25, 320, 8_000, 20_160, 504_000, 416_640, 3_176_880, 7_624_512]],
    mm: [290_472_336, [1, 23, 325, 7_475, 20_800, 478_400, 436_800, 3_385_200, 8_259_888]],
    aon: [2_704_156, [1, 144, 4_356, 48_400, 245_025, 245_025, 48_400, 4_356, 144, 1]]
  };
  for (const [game, [denominator, counts]] of Object.entries(expected) as [
    keyof typeof EV_RULES,
    readonly [number, readonly number[]]
  ][]) {
    const rules = EV_RULES[game];
    if (
      rules.totalOutcomes !== denominator ||
      rules.tiers.length !== counts.length ||
      rules.tiers.some((tier, index) => tier.eventCount !== counts[index])
    ) {
      throw new Error(`Internal ${game} EV rule table failed verification`);
    }
  }
  const extraCounts = [1, 288, 16_920, 345_920, 2_918_700];
  if (LOTTO_EXTRA_RULES.tiers.some((tier, index) => tier.eventCount !== extraCounts[index])) {
    throw new Error("Internal Lotto EXTRA event counts failed verification");
  }
}

verifyRuleTables();
