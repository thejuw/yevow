import { GAME_MANIFEST } from "./manifest";
import type { GameCode, SplitRiskResult, Ticket } from "./types";
import { isPurePermutationStyle, validateTicket } from "./validation";

const LUCKY_VALUES = new Set([3, 7, 8]);
const DISCLAIMER =
  "Behavioral heuristic only: it is not evidence about draw probability or measured Texas player choices.";

interface RawRisk {
  readonly score: number;
  readonly notes: readonly string[];
}

function roundHundredth(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function countValues(values: readonly number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function longestConsecutiveRun(values: readonly number[]): number {
  let longest = 1;
  let current = 1;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === values[index - 1]! + 1) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 1;
    }
  }
  return longest;
}

function poolPatternRisk(game: GameCode, ticket: Ticket): RawRisk {
  const config = GAME_MANIFEST[game];
  const numbers = [...ticket.main].sort((left, right) => left - right);
  const bonus = ticket.bonus ?? [];
  const count = numbers.length;
  const notes: string[] = [];
  let score = 0;

  if (game === "aon") {
    const monthValues = numbers.filter((number) => number <= 12).length;
    const imbalance = Math.abs(monthValues * 2 - count);
    if (imbalance >= 4) {
      score += imbalance * 2;
      notes.push("Calendar-shape heuristic: the selection is lopsided between 1-12 and 13-24.");
    }
  } else if (config.main.max > 31) {
    const birthdayCount = numbers.filter((number) => number <= 31).length;
    score += 46 * (birthdayCount / count) ** 2;
    if (birthdayCount === count) {
      score += 15;
      notes.push("Birthday-heavy heuristic: every main number is 31 or lower.");
    } else if (birthdayCount >= Math.ceil(count / 2)) {
      notes.push(
        `Birthday-heavy heuristic: ${birthdayCount} of ${count} main numbers are 31 or lower.`
      );
    } else if (birthdayCount > 0) {
      notes.push(
        `Birthday-number heuristic: ${birthdayCount} of ${count} main numbers are 31 or lower.`
      );
    }
  }

  let consecutivePairs = 0;
  const differences: number[] = [];
  for (let index = 1; index < numbers.length; index += 1) {
    const difference = numbers[index]! - numbers[index - 1]!;
    differences.push(difference);
    if (difference === 1) consecutivePairs += 1;
  }
  if (consecutivePairs > 0) {
    score += consecutivePairs * 5;
    const run = longestConsecutiveRun(numbers);
    if (run >= 3) score += (run - 2) * 7;
    notes.push(`Sequence heuristic: contains ${consecutivePairs} consecutive-number pair(s).`);
  }
  if (differences.length >= 2 && new Set(differences).size === 1) {
    score += 22;
    notes.push("Grid-pattern heuristic: the main numbers form an arithmetic progression.");
  }

  const decadeCounts = countValues(numbers.map((number) => Math.floor((number - 1) / 10)));
  const largestDecade = Math.max(...decadeCounts.values());
  if (largestDecade === count && count >= 3) {
    score += 20;
    notes.push("Same-decade heuristic: every main number falls in one ten-number band.");
  } else if (count >= 5 && largestDecade >= count - 1) {
    score += 10;
    notes.push("Decade-cluster heuristic: nearly every main number is in one band.");
  }

  const terminalCounts = countValues(numbers.map((number) => number % 10));
  const largestTerminal = Math.max(...terminalCounts.values());
  const terminalThreshold = count >= 8 ? 4 : 3;
  if (largestTerminal >= terminalThreshold) {
    score += (largestTerminal - terminalThreshold + 1) * 7;
    notes.push(
      "Playslip-grid heuristic: several numbers share a final digit and may form a visual column."
    );
  }

  if (
    count >= 4 &&
    (numbers.every((number) => number % 2 === 0) || numbers.every((number) => number % 2 === 1))
  ) {
    score += 11;
    notes.push("Visual-pattern heuristic: every main number has the same parity.");
  }

  const luckyHits = numbers.filter((number) => LUCKY_VALUES.has(number)).length;
  if (luckyHits > 0) {
    score += luckyHits * 4 + (luckyHits >= 2 ? 7 : 0);
    notes.push(
      "Lucky-number heuristic: includes 3, 7, or 8; this is not based on Texas sales microdata."
    );
  }

  if (count >= 4 && numbers[numbers.length - 1]! - numbers[0]! <= count + 2) {
    score += 13;
    notes.push("Cluster heuristic: the main values occupy an unusually compact interval.");
  }

  const bonusLuckyHits = bonus.filter((number) => LUCKY_VALUES.has(number)).length;
  if (bonusLuckyHits > 0) {
    score += bonusLuckyHits * 4;
    notes.push("Bonus-ball heuristic: the bonus selection uses 3, 7, or 8.");
  }
  if (config.bonus && config.bonus.max > 31 && bonus.every((number) => number <= 31)) {
    score += 8;
    notes.push("Bonus birthday heuristic: the bonus selection is 31 or lower.");
  }
  if (bonus.some((number) => numbers.includes(number))) {
    score += 4;
    notes.push("Repeat-across-pools heuristic: a bonus value repeats a main value.");
  }
  return { score, notes };
}

function digitPatternRisk(values: readonly number[]): RawRisk {
  const counts = countValues(values);
  const repeatedPositions = values.length - counts.size;
  const notes: string[] = [];
  let score = 0;

  if (counts.size === 1) {
    score += 43;
    notes.push("Repeated-digit heuristic: all digits are identical.");
  } else if (repeatedPositions > 0) {
    score += repeatedPositions * 11;
    if (Math.max(...counts.values()) >= 3) score += 10;
    notes.push(
      `Repeated-digit heuristic: ${repeatedPositions} position(s) repeat an earlier digit.`
    );
  }

  const modularSteps = values.slice(1).map((value, index) => (value - values[index]! + 10) % 10);
  if (
    modularSteps.length > 0 &&
    (modularSteps.every((step) => step === 1) || modularSteps.every((step) => step === 9))
  ) {
    score += 28;
    notes.push("Sequence heuristic: the digits form an ascending or descending run.");
  }

  if (
    values.length >= 3 &&
    values.every((value, index) => value === values[values.length - 1 - index])
  ) {
    score += 18;
    notes.push("Symmetry heuristic: the digits form a palindrome.");
  }
  if (values.length === 4 && values[0] === values[2] && values[1] === values[3]) {
    score += 24;
    notes.push("Visual-pattern heuristic: the ticket repeats an ABAB pair.");
  }

  const keypadLines = new Set([
    "123",
    "321",
    "456",
    "654",
    "789",
    "987",
    "147",
    "741",
    "258",
    "852",
    "369",
    "963"
  ]);
  if (values.length === 3 && keypadLines.has(values.join(""))) {
    score += 24;
    notes.push("Keypad-grid heuristic: the digits trace a straight keypad line.");
  }

  const luckyHits = values.filter((digit) => LUCKY_VALUES.has(digit)).length;
  if (luckyHits > 0) {
    score += luckyHits * 5 + (luckyHits >= 2 ? 8 : 0);
    notes.push(
      "Lucky-digit heuristic: includes 3, 7, or 8; this is not based on Texas sales microdata."
    );
  }

  if (values.length === 3) {
    const month = values[0]!;
    const day = values[1]! * 10 + values[2]!;
    if (month >= 1 && month <= 9 && day >= 1 && day <= 31) {
      score += 30;
      notes.push("Calendar heuristic: the digits can be read as a one-digit month and day.");
    }
  } else if (values.length === 4) {
    const month = values[0]! * 10 + values[1]!;
    const day = values[2]! * 10 + values[3]!;
    const rendered = values.reduce((number, digit) => number * 10 + digit, 0);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      score += 36;
      notes.push("Birthday heuristic: the digits form a valid MMDD date.");
    }
    if (rendered >= 1900 && rendered <= 2029) {
      score += 29;
      notes.push("Year heuristic: the digits resemble a familiar birth or calendar year.");
    }
  }

  if (
    values.length >= 3 &&
    (values.every((digit) => digit % 2 === 0) || values.every((digit) => digit % 2 === 1))
  ) {
    score += 8;
    notes.push("Visual-pattern heuristic: all digits have the same parity.");
  }
  return { score, notes };
}

function permutations(values: readonly number[]): number[][] {
  const output: number[][] = [];
  const counts = countValues(values);
  const unique = [...counts.keys()].sort((left, right) => left - right);
  const current: number[] = [];
  const visit = (): void => {
    if (current.length === values.length) {
      output.push([...current]);
      return;
    }
    for (const value of unique) {
      const remaining = counts.get(value) ?? 0;
      if (remaining === 0) continue;
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

function scoreToLevel(score: number): SplitRiskResult["level"] {
  if (score >= 60) return "high";
  if (score >= 30) return "moderate";
  return "low";
}

/** Score familiar manual-pick shapes; this never changes a ticket's draw odds. */
export function scoreSplitRisk(game: GameCode, suppliedTicket: Ticket): SplitRiskResult {
  const ticket = validateTicket(game, suppliedTicket);
  let raw: RawRisk;
  let notes: string[];
  if (GAME_MANIFEST[game].kind === "digits") {
    if (isPurePermutationStyle(ticket.playStyle ?? "straight")) {
      raw = permutations(ticket.main)
        .map(digitPatternRisk)
        .sort((left, right) => right.score - left.score)[0]!;
    } else {
      raw = digitPatternRisk(ticket.main);
    }
    notes = [
      ...raw.notes,
      "Fixed-prize caveat: pattern popularity does not create a prize split for this digit game.",
      "Straight and box wagers have different odds, permutation counts, prices, and payouts."
    ];
  } else if (game === "aon") {
    const complement = Array.from({ length: 24 }, (_, index) => index + 1).filter(
      (number) => !ticket.main.includes(number)
    );
    const first = poolPatternRisk(game, ticket);
    const second = poolPatternRisk(game, { ...ticket, main: complement });
    raw = { score: (first.score + second.score) / 2, notes: [] };
    notes = [
      ...new Set([...first.notes, ...second.notes]),
      "Complement symmetry: selected and unselected 12-number sets have identical match-count prize exposure."
    ].sort();
  } else {
    raw = poolPatternRisk(game, ticket);
    notes = [...raw.notes];
  }

  const score = roundHundredth(Math.min(100, Math.max(0, raw.score)));
  return Object.freeze({
    score,
    level: scoreToLevel(score),
    notes: Object.freeze(notes),
    disclaimer: DISCLAIMER
  });
}
