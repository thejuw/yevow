import { describe, expect, it } from "vitest";
import {
  aonExposureKey,
  aonPrizeCents,
  evaluateAonPortfolio,
  exactAonPairMetrics,
  generateChallenger
} from "../../web/lib/lotto/challenger";
import { GAME_CODES, type Ticket } from "../../web/lib/lotto/types";
import { validateTicket } from "../../web/lib/lotto/validation";

function aon(main: readonly number[]): Ticket {
  return { game: "aon", main, playStyle: "straight" };
}

function complement(ticket: Ticket): Ticket {
  return aon(
    Array.from({ length: 24 }, (_, index) => index + 1).filter((n) => !ticket.main.includes(n))
  );
}

const FIRST = aon(Array.from({ length: 12 }, (_, index) => index + 1));
const OVERLAP_ELEVEN = aon([...Array.from({ length: 11 }, (_, index) => index + 1), 13]);
const OVERLAP_SIX = aon([1, 2, 3, 4, 5, 6, 13, 14, 15, 16, 17, 18]);

describe("paper-only versioned challengers", () => {
  it.each(GAME_CODES)("generates reproducible legal distinct %s tickets", (game) => {
    const input = { game, count: 16, seed: "frozen-forward-study" };
    const result = generateChallenger(input);
    expect(result).toEqual(generateChallenger(input));
    expect(result.tickets).toHaveLength(16);
    expect(new Set(result.tickets.map((ticket) => JSON.stringify(ticket))).size).toBe(16);
    for (const ticket of result.tickets) expect(validateTicket(game, ticket)).toEqual(ticket);
    expect(result.notes.join(" ")).toContain("not predicted");
  });

  it("does not exclude lucky digits or repeated digit positions", () => {
    for (const game of ["p3", "d4"] as const) {
      const result = generateChallenger({ game, count: 64, seed: "neutral-digit-regression" });
      const positions = result.tickets.flatMap((ticket) => ticket.main);
      for (let digit = 0; digit <= 9; digit += 1) expect(positions).toContain(digit);
      expect(result.tickets.some((ticket) => new Set(ticket.main).size < ticket.main.length)).toBe(
        true
      );
    }
  });

  it("keeps seed types separate and rotates only when the stored seed changes", () => {
    const input = { game: "cash5" as const, count: 4 };
    expect(generateChallenger({ ...input, seed: "7" }).tickets).not.toEqual(
      generateChallenger({ ...input, seed: 7 }).tickets
    );
    expect(generateChallenger({ ...input, seed: "2026-09-20" }).tickets).not.toEqual(
      generateChallenger({ ...input, seed: "2026-09-21" }).tickets
    );
  });

  it.each(["twostep", "pb", "mm"] as const)(
    "balances %s bonus outcomes without exclusions",
    (game) => {
      const result = generateChallenger({
        game,
        count: 4,
        seed: "bonus-trial",
        challengerId: "bonus-diversity-v1"
      });
      expect(new Set(result.tickets.map((ticket) => ticket.bonus![0])).size).toBe(4);
      expect(result.objective).toBe("balanced-bonus");
    }
  );

  it("uses legal box exposure deduplication without accepting all-same box tickets", () => {
    const result = generateChallenger({
      game: "p3",
      count: 64,
      seed: "box-neutral",
      playStyle: "box"
    });
    const keys = result.tickets.map((ticket) => [...ticket.main].sort().join(""));
    expect(new Set(keys).size).toBe(64);
    expect(result.tickets.every((ticket) => new Set(ticket.main).size > 1)).toBe(true);
  });

  it("rejects invalid versions, styles, games, seeds, and excessive search work", () => {
    expect(() => generateChallenger({ game: "cash5", count: 65, seed: 1 })).toThrow(/ticket count/);
    expect(() => generateChallenger({ game: "cash5", count: 4, seed: NaN })).toThrow(/seed/);
    expect(() =>
      generateChallenger({ game: "cash5", count: 4, seed: 1, playStyle: "box" })
    ).toThrow(/play style/);
    expect(() =>
      generateChallenger({ game: "cash5", count: 4, seed: 1, challengerId: "aon-prize-v1" })
    ).toThrow(/All or Nothing/);
    expect(() =>
      generateChallenger({ game: "cash5", count: 4, seed: 1, challengerId: "bonus-diversity-v1" })
    ).toThrow(/bonus-ball/);
    expect(() =>
      generateChallenger({
        game: "aon",
        count: 64,
        seed: 1,
        challengerId: "aon-prize-v1",
        optimizationDraws: 8192,
        candidatePoolSize: 256
      })
    ).toThrow(/budget/);
  });
});

describe("All or Nothing nominal portfolio mathematics", () => {
  it("enforces the exact complement payoff symmetry for every match count", () => {
    for (let matches = 0; matches <= 12; matches += 1) {
      expect(aonPrizeCents(matches)).toBe(aonPrizeCents(12 - matches));
    }
    expect(aonExposureKey(OVERLAP_ELEVEN)).toBe(aonExposureKey(complement(OVERLAP_ELEVEN)));
  });

  it("exactly reproduces the pair-coverage counterexample without changing expected dollars", () => {
    const near = exactAonPairMetrics(FIRST, OVERLAP_ELEVEN);
    const flipped = exactAonPairMetrics(FIRST, complement(OVERLAP_ELEVEN));
    const balanced = exactAonPairMetrics(FIRST, OVERLAP_SIX);
    expect(near).toEqual(flipped);
    expect(near.totalOutcomes).toBe(2_704_156);
    expect(near.anyPrizeOutcomes / near.totalOutcomes).toBeCloseTo(0.300889, 6);
    expect(balanced.anyPrizeOutcomes / balanced.totalOutcomes).toBeCloseTo(0.397501, 6);
    expect(balanced.profitableDrawOutcomes).toBeGreaterThan(near.profitableDrawOutcomes);
    expect(balanced.theoreticalGrossReturnCents).toEqual(near.theoreticalGrossReturnCents);
    expect(near.payoutDistribution.reduce((sum, row) => sum + row.outcomes, 0)).toBe(
      near.totalOutcomes
    );
  });

  it("returns identical simulated distributions when any ticket is complemented", () => {
    const options = { seed: "same-evaluation-stream", draws: 4096 };
    expect(evaluateAonPortfolio([FIRST, OVERLAP_ELEVEN], options)).toEqual(
      evaluateAonPortfolio([complement(FIRST), complement(OVERLAP_ELEVEN)], options)
    );
  });

  it("agrees with exact probability within sampling uncertainty and labels uncertainty", () => {
    const exact = exactAonPairMetrics(FIRST, OVERLAP_SIX);
    const simulated = evaluateAonPortfolio([FIRST, OVERLAP_SIX], {
      seed: "independent-sanity",
      draws: 32_768
    });
    const expected = exact.anyPrizeOutcomes / exact.totalOutcomes;
    expect(Math.abs(simulated.anyPrize.probability - expected)).toBeLessThan(
      5 * simulated.anyPrize.standardError
    );
    expect(simulated.theoreticalGrossReturnCents).toEqual(exact.theoreticalGrossReturnCents);
    expect(simulated.anyPrize.interval95[0]).toBeLessThan(simulated.anyPrize.probability);
    expect(simulated.anyPrize.interval95[1]).toBeGreaterThan(simulated.anyPrize.probability);
    expect(simulated.notes.join(" ")).toContain("not predictions");
  });

  it.each(["any-prize", "profitable-draw"] as const)(
    "optimizes %s with distinct exposures and independent evaluation",
    (objective) => {
      const input = {
        game: "aon" as const,
        count: 4,
        seed: "forward-only-aon",
        challengerId: "aon-prize-v1" as const,
        objective
      };
      const result = generateChallenger(input);
      expect(result).toEqual(generateChallenger(input));
      expect(new Set(result.tickets.map(aonExposureKey)).size).toBe(4);
      expect(result.metrics).toEqual(evaluateAonPortfolio(result.tickets, { seed: input.seed }));
      expect(result.metrics!.evaluationSeed).toContain(":evaluation");
      expect(result.objective).toBe(objective);
      expect(BigInt(result.metrics!.theoreticalNetReturnCents.numerator)).toBeLessThan(0n);
    }
  );
});
