import { GAME_MANIFEST } from "./manifest";
import type { CoverageResult, GameCode, Ticket } from "./types";
import { LottoValidationError } from "./types";
import { isPermutationStyle, validateTicket } from "./validation";

export type PairKey = string;

export function combinationCount(total: number, selected: number): number {
  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(selected) ||
    total < 0 ||
    selected < 0
  ) {
    throw new RangeError("combination arguments must be non-negative safe integers");
  }
  if (selected > total) return 0;
  const k = Math.min(selected, total - selected);
  let result = 1;
  for (let index = 1; index <= k; index += 1) {
    result = (result * (total - k + index)) / index;
  }
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("combination result exceeds safe integer precision");
  }
  return result;
}

function uniquePermutations(values: readonly number[]): number[][] {
  const output: number[][] = [];
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const choices = [...counts.keys()].sort((left, right) => left - right);
  const current: number[] = [];
  const visit = (): void => {
    if (current.length === values.length) {
      output.push([...current]);
      return;
    }
    for (const value of choices) {
      const remaining = counts.get(value) ?? 0;
      if (remaining < 1) continue;
      counts.set(value, remaining - 1);
      current.push(value);
      visit();
      current.pop();
      counts.set(value, remaining);
    }
  };
  visit();
  return output;
}

/** Pair units represented by one legal ticket. */
export function pairKeys(game: GameCode, suppliedTicket: Ticket): ReadonlySet<PairKey> {
  const ticket = validateTicket(game, suppliedTicket);
  const config = GAME_MANIFEST[game];
  const keys = new Set<PairKey>();
  if (config.kind === "digits") {
    const orderings = isPermutationStyle(ticket.playStyle ?? "straight")
      ? uniquePermutations(ticket.main)
      : [[...ticket.main]];
    for (const ordering of orderings) {
      for (let left = 0; left < ordering.length; left += 1) {
        for (let right = left + 1; right < ordering.length; right += 1) {
          keys.add(`digit:${left}:${ordering[left]}:${right}:${ordering[right]}`);
        }
      }
    }
    return keys;
  }

  const main = [...ticket.main].sort((left, right) => left - right);
  for (let left = 0; left < main.length; left += 1) {
    for (let right = left + 1; right < main.length; right += 1) {
      keys.add(`main:${main[left]}:${main[right]}`);
    }
  }
  for (const [bonusPosition, bonus] of (ticket.bonus ?? []).entries()) {
    for (const mainValue of main) {
      keys.add(`cross:${mainValue}:${bonus}:${bonusPosition}`);
    }
  }
  const bonus = ticket.bonus ?? [];
  for (let left = 0; left < bonus.length; left += 1) {
    for (let right = left + 1; right < bonus.length; right += 1) {
      keys.add(`bonus:${left}:${bonus[left]}:${right}:${bonus[right]}`);
    }
  }
  return keys;
}

/** Materialize all two-factor coverage units for a current game matrix. */
export function pairUniverse(game: GameCode): ReadonlySet<PairKey> {
  const config = GAME_MANIFEST[game];
  const keys = new Set<PairKey>();
  if (config.kind === "digits") {
    for (let left = 0; left < config.main.count; left += 1) {
      for (let right = left + 1; right < config.main.count; right += 1) {
        for (let leftValue = config.main.min; leftValue <= config.main.max; leftValue += 1) {
          for (let rightValue = config.main.min; rightValue <= config.main.max; rightValue += 1) {
            keys.add(`digit:${left}:${leftValue}:${right}:${rightValue}`);
          }
        }
      }
    }
    return keys;
  }

  for (let left = config.main.min; left <= config.main.max; left += 1) {
    for (let right = left + 1; right <= config.main.max; right += 1) {
      keys.add(`main:${left}:${right}`);
    }
  }
  if (!config.bonus) return keys;
  for (let position = 0; position < config.bonus.count; position += 1) {
    for (let main = config.main.min; main <= config.main.max; main += 1) {
      for (let bonus = config.bonus.min; bonus <= config.bonus.max; bonus += 1) {
        keys.add(`cross:${main}:${bonus}:${position}`);
      }
    }
  }
  for (let leftPosition = 0; leftPosition < config.bonus.count; leftPosition += 1) {
    for (
      let rightPosition = leftPosition + 1;
      rightPosition < config.bonus.count;
      rightPosition += 1
    ) {
      for (let left = config.bonus.min; left <= config.bonus.max; left += 1) {
        for (let right = config.bonus.min; right <= config.bonus.max; right += 1) {
          keys.add(`bonus:${leftPosition}:${left}:${rightPosition}:${right}`);
        }
      }
    }
  }
  return keys;
}

export function possiblePairCount(game: GameCode): number {
  const config = GAME_MANIFEST[game];
  const mainPoolSize = config.main.max - config.main.min + 1;
  if (config.kind === "digits") {
    return combinationCount(config.main.count, 2) * mainPoolSize ** 2;
  }
  let total = combinationCount(mainPoolSize, 2);
  if (config.bonus) {
    const bonusPoolSize = config.bonus.max - config.bonus.min + 1;
    total += config.bonus.count * mainPoolSize * bonusPoolSize;
    total += combinationCount(config.bonus.count, 2) * bonusPoolSize * bonusPoolSize;
  }
  return total;
}

function compareArrays(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function aonExposure(numbers: readonly number[]): string {
  const selected = [...numbers].sort((left, right) => left - right);
  const complement = Array.from({ length: 24 }, (_, index) => index + 1).filter(
    (number) => !selected.includes(number)
  );
  return (compareArrays(selected, complement) <= 0 ? selected : complement).join(",");
}

export function coverageDefinition(game: GameCode): string {
  const config = GAME_MANIFEST[game];
  if (config.kind === "digits") {
    return "Position-aware digit-pair coverage over the full digit-pair universe.";
  }
  if (config.bonus) {
    return "Unordered main/main plus main/bonus pair coverage over the full pair universe.";
  }
  return "Unordered main-number pair coverage over the full pair universe.";
}

/** Summarize pair coverage for legal tickets from exactly one game. */
export function calculatePairCoverage(game: GameCode, tickets: readonly Ticket[]): CoverageResult {
  if (tickets.length === 0) {
    throw new LottoValidationError("Coverage requires at least one ticket");
  }
  const covered = new Set<PairKey>();
  const aonExposures = new Set<string>();
  for (const supplied of tickets) {
    const ticket = validateTicket(game, supplied);
    if (game === "aon") {
      const exposure = aonExposure(ticket.main);
      if (aonExposures.has(exposure)) continue;
      aonExposures.add(exposure);
    }
    for (const key of pairKeys(game, ticket)) covered.add(key);
  }
  const possiblePairs = possiblePairCount(game);
  return Object.freeze({
    distinctPairs: covered.size,
    possiblePairs,
    coveragePercent: Math.round((covered.size / possiblePairs) * 10_000) / 100,
    definition: coverageDefinition(game)
  });
}
