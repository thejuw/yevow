import {
  calculatePairCoverage,
  combinationCount,
  pairKeys,
  pairUniverse,
  type PairKey
} from "./coverage";
import { GAME_MANIFEST } from "./manifest";
import {
  createSeededRng,
  createUnseededSeed,
  randomInteger,
  sampleWithoutReplacement,
  type SeededRng
} from "./rng";
import { scoreSplitRisk } from "./risk";
import type {
  DigitPlayStyle,
  GameCode,
  GenerateTicketsInput,
  PickResult,
  ScoredTicket,
  Seed,
  Ticket
} from "./types";
import { LottoValidationError } from "./types";
import { isPermutationStyle, isPurePermutationStyle, validateTicket } from "./validation";

const MAX_TICKETS = 2_000;
const MAX_CANDIDATE_POOL = 8_192;
const MAX_CANDIDATE_EVALUATIONS = 5_000_000;

function compareArrays(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function ticketKey(game: GameCode, ticket: Ticket): string {
  const config = GAME_MANIFEST[game];
  let main =
    config.kind === "digits" && !isPurePermutationStyle(ticket.playStyle ?? "straight")
      ? [...ticket.main]
      : [...ticket.main].sort((left, right) => left - right);
  if (game === "aon") {
    const complement = Array.from({ length: 24 }, (_, index) => index + 1).filter(
      (number) => !main.includes(number)
    );
    if (compareArrays(complement, main) < 0) main = complement;
  }
  return `${main.join(",")}|${[...(ticket.bonus ?? [])].sort((a, b) => a - b).join(",")}|${ticket.playStyle ?? "straight"}`;
}

function legalSpaceSize(game: GameCode, playStyle: string): number {
  const config = GAME_MANIFEST[game];
  const poolSize = config.main.max - config.main.min + 1;
  if (config.kind === "digits") {
    if (isPurePermutationStyle(playStyle)) {
      return combinationCount(poolSize + config.main.count - 1, config.main.count) - poolSize;
    }
    const total = poolSize ** config.main.count;
    return isPermutationStyle(playStyle) ? total - poolSize : total;
  }
  let total = config.main.allowDuplicates
    ? combinationCount(poolSize + config.main.count - 1, config.main.count)
    : combinationCount(poolSize, config.main.count);
  if (config.bonus) {
    total *= combinationCount(config.bonus.max - config.bonus.min + 1, config.bonus.count);
  }
  return game === "aon" ? total / 2 : total;
}

function randomTicket(
  game: GameCode,
  rng: SeededRng,
  playStyle: DigitPlayStyle | "straight"
): Ticket {
  const config = GAME_MANIFEST[game];
  const main =
    config.kind === "digits"
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
  return { game, main, ...(bonus.length ? { bonus } : {}), playStyle };
}

function ticketForPair(
  game: GameCode,
  target: PairKey,
  rng: SeededRng,
  playStyle: DigitPlayStyle | "straight"
): Ticket {
  const config = GAME_MANIFEST[game];
  const parts = target.split(":");
  const tag = parts[0];
  if (tag === "digit") {
    const main = Array.from({ length: config.main.count }, () =>
      randomInteger(rng, config.main.min, config.main.max)
    );
    main[Number(parts[1])] = Number(parts[2]);
    main[Number(parts[3])] = Number(parts[4]);
    return { game, main, playStyle };
  }

  const requiredMain = new Set<number>();
  const forcedBonus = new Map<number, number>();
  if (tag === "main") {
    requiredMain.add(Number(parts[1]));
    requiredMain.add(Number(parts[2]));
  } else if (tag === "cross") {
    requiredMain.add(Number(parts[1]));
    forcedBonus.set(Number(parts[3]), Number(parts[2]));
  } else if (tag === "bonus") {
    forcedBonus.set(Number(parts[1]), Number(parts[2]));
    forcedBonus.set(Number(parts[3]), Number(parts[4]));
  } else {
    throw new LottoValidationError(`Unknown coverage pair ${JSON.stringify(target)}`);
  }

  const availableMain = Array.from(
    { length: config.main.max - config.main.min + 1 },
    (_, index) => config.main.min + index
  ).filter((value) => !requiredMain.has(value));
  const selectedMain = sampleWithoutReplacement(
    rng,
    0,
    availableMain.length - 1,
    config.main.count - requiredMain.size
  ).map((index) => availableMain[index]!);
  const main = [...requiredMain, ...selectedMain].sort((left, right) => left - right);

  if (!config.bonus) return { game, main, playStyle };
  const bonus = Array<number | undefined>(config.bonus.count).fill(undefined);
  for (const [position, value] of forcedBonus) bonus[position] = value;
  const used = new Set(bonus.filter((value): value is number => value !== undefined));
  const availableBonus = Array.from(
    { length: config.bonus.max - config.bonus.min + 1 },
    (_, index) => config.bonus!.min + index
  ).filter((value) => !used.has(value));
  for (let position = 0; position < bonus.length; position += 1) {
    if (bonus[position] !== undefined) continue;
    const selected = randomInteger(rng, 0, availableBonus.length - 1);
    bonus[position] = availableBonus.splice(selected, 1)[0]!;
  }
  return {
    game,
    main,
    bonus: bonus.filter((value): value is number => value !== undefined),
    playStyle
  };
}

function enumerateDigitTickets(
  game: "p3" | "d4",
  playStyle: DigitPlayStyle | "straight"
): Ticket[] {
  const config = GAME_MANIFEST[game];
  const output: Ticket[] = [];
  const current: number[] = [];
  const visit = (): void => {
    if (current.length === config.main.count) {
      const ticket: Ticket = { game, main: [...current], playStyle };
      try {
        output.push(validateTicket(game, ticket));
      } catch (error) {
        if (!(error instanceof LottoValidationError)) throw error;
      }
      return;
    }
    for (let digit = 0; digit <= 9; digit += 1) {
      current.push(digit);
      visit();
      current.pop();
    }
  };
  visit();
  return output;
}

function candidateBatch(
  game: GameCode,
  rng: SeededRng,
  playStyle: DigitPlayStyle | "straight",
  targetSize: number,
  selectedKeys: ReadonlySet<string>,
  uncovered: readonly PairKey[]
): Ticket[] {
  const candidates = new Map<string, Ticket>();
  const attemptLimit = Math.max(200, targetSize * 35);
  for (let attempt = 1; attempt <= attemptLimit && candidates.size < targetSize; attempt += 1) {
    const supplied =
      uncovered.length > 0 && attempt % 2 === 0
        ? ticketForPair(
            game,
            uncovered[randomInteger(rng, 0, uncovered.length - 1)]!,
            rng,
            playStyle
          )
        : randomTicket(game, rng, playStyle);
    try {
      const ticket = validateTicket(game, supplied);
      const key = ticketKey(game, ticket);
      if (!selectedKeys.has(key)) candidates.set(key, ticket);
    } catch (error) {
      if (!(error instanceof LottoValidationError)) throw error;
    }
  }

  if (candidates.size < targetSize && (game === "p3" || game === "d4")) {
    for (const ticket of enumerateDigitTickets(game, playStyle)) {
      const key = ticketKey(game, ticket);
      if (!selectedKeys.has(key)) candidates.set(key, ticket);
      if (candidates.size >= targetSize) break;
    }
  }
  return [...candidates.values()];
}

function optimizerNotes(game: GameCode): readonly string[] {
  const notes = [
    "Split-risk scores are transparent behavioral heuristics, not player-selection measurements; they do not change draw odds.",
    "Pair coverage is a portfolio-diversity measure, not a prize guarantee or an EV increase."
  ];
  if (GAME_MANIFEST[game].kind === "digits") {
    notes.push(
      "Published digit-game prizes are fixed, so a popular pattern does not split the stated prize.",
      "Straight versus box changes winning probability, permutation count, price, and payout; no digit is due."
    );
  }
  if (game === "aon") {
    notes.push(
      "All 1-24 values are birthday-range values, so birthday-number avoidance is impossible.",
      "A ticket and its exact complement have identical symmetric match-count prize exposure; complement duplicates are excluded."
    );
  }
  return Object.freeze(notes);
}

/** Greedy seeded wheel: maximize new pair units, then prefer lower split-risk shapes. */
export function generateTickets(input: GenerateTicketsInput): PickResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LottoValidationError("picker input must be a non-null object");
  }
  if (!Object.prototype.hasOwnProperty.call(GAME_MANIFEST, input.game)) {
    throw new LottoValidationError(`Unknown lottery game ${JSON.stringify(input.game)}`);
  }
  if (!Number.isSafeInteger(input.count) || input.count < 1) {
    throw new LottoValidationError("count must be a positive safe integer");
  }
  if (input.count > MAX_TICKETS) {
    throw new LottoValidationError(`count exceeds the ${MAX_TICKETS} ticket cap`);
  }
  if (
    input.seed !== undefined &&
    ((typeof input.seed !== "string" && typeof input.seed !== "number") ||
      (typeof input.seed === "number" && !Number.isFinite(input.seed)))
  ) {
    throw new LottoValidationError("seed must be a string or finite number");
  }
  const config = GAME_MANIFEST[input.game];
  if (input.playStyle !== undefined && typeof input.playStyle !== "string") {
    throw new LottoValidationError("playStyle must be a string");
  }
  const playStyle = (input.playStyle ?? "straight").trim().toLowerCase() as
    | DigitPlayStyle
    | "straight";
  if (!config.optimizerPlayStyles.includes(playStyle as DigitPlayStyle)) {
    throw new LottoValidationError(
      `${config.name} does not support optimizer play style ${JSON.stringify(playStyle)}`
    );
  }
  const totalSpace = legalSpaceSize(input.game, playStyle);
  if (input.count > totalSpace) {
    throw new LottoValidationError(
      `Requested ${input.count} tickets, but ${config.name} has only ${totalSpace} distinct legal selections for this style`
    );
  }
  const candidatePoolSize =
    input.candidatePoolSize ?? Math.max(384, Math.min(2_048, input.count * 96));
  if (
    !Number.isSafeInteger(candidatePoolSize) ||
    candidatePoolSize < 1 ||
    candidatePoolSize > MAX_CANDIDATE_POOL
  ) {
    throw new LottoValidationError(
      `candidatePoolSize must be an integer from 1 through ${MAX_CANDIDATE_POOL}`
    );
  }
  if (candidatePoolSize * input.count > MAX_CANDIDATE_EVALUATIONS) {
    throw new LottoValidationError(
      `requested wheel exceeds the ${MAX_CANDIDATE_EVALUATIONS.toLocaleString()} candidate-evaluation cap`
    );
  }

  const seed: Seed = input.seed ?? createUnseededSeed();
  const rng = createSeededRng(seed);
  const universe = [...pairUniverse(input.game)].sort();
  const covered = new Set<PairKey>();
  const selectedKeys = new Set<string>();
  const selected: ScoredTicket[] = [];

  for (let ticketIndex = 0; ticketIndex < input.count; ticketIndex += 1) {
    const uncovered = universe.filter((key) => !covered.has(key));
    const candidates = candidateBatch(
      input.game,
      rng,
      playStyle,
      Math.min(candidatePoolSize, totalSpace - selectedKeys.size),
      selectedKeys,
      uncovered
    );
    if (candidates.length === 0) {
      throw new LottoValidationError(
        `Unable to construct another distinct legal ${config.name} ticket`
      );
    }

    let best: ScoredTicket | undefined;
    let bestPairs: ReadonlySet<PairKey> | undefined;
    let bestGain = -1;
    for (const ticket of candidates) {
      const pairs = pairKeys(input.game, ticket);
      let gain = 0;
      for (const key of pairs) if (!covered.has(key)) gain += 1;
      const splitRisk = scoreSplitRisk(input.game, ticket);
      if (
        gain > bestGain ||
        (gain === bestGain && (!best || splitRisk.score < best.splitRisk.score))
      ) {
        best = { ticket, splitRisk };
        bestPairs = pairs;
        bestGain = gain;
      }
    }
    if (!best || !bestPairs) {
      throw new LottoValidationError("Candidate ranking produced no result");
    }
    selected.push(Object.freeze(best));
    selectedKeys.add(ticketKey(input.game, best.ticket));
    for (const key of bestPairs) covered.add(key);
  }

  const coverage = calculatePairCoverage(
    input.game,
    selected.map(({ ticket }) => ticket)
  );
  const averageSplitRisk =
    Math.round(
      (selected.reduce((total, item) => total + item.splitRisk.score, 0) / selected.length) * 100
    ) / 100;
  return Object.freeze({
    game: input.game,
    seed,
    tickets: Object.freeze(selected),
    coverage,
    averageSplitRisk,
    notes: optimizerNotes(input.game)
  });
}
