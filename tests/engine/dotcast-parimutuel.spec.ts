import { describe, expect, it } from "vitest";
import {
  calculatePoolTotals,
  impliedProb,
  previewPayout,
  settleParimutuel,
  type SettlementEntry
} from "../../src/engine/dotcast";

describe("dotCast parimutuel core", () => {
  it("settles the no-rake worked example exactly in minor units", () => {
    const result = settleParimutuel(
      [
        entry("yes-target", "yes", units(70)),
        entry("yes-rest", "yes", units(630)),
        entry("no-pool", "no", units(300))
      ],
      "yes",
      0
    );

    expect(result.kind).toBe("settled");
    expect(payout(result.payouts, "yes-target")).toBe(units(100));
    expect(result.rakeAmount).toBe(0);
    expect(sumPayouts(result.payouts) + result.rakeAmount).toBe(result.totalStaked);
  });

  it("settles a smaller proportional winner in the worked example", () => {
    const result = settleParimutuel(
      [
        entry("yes-small", "yes", units(7)),
        entry("yes-rest", "yes", units(693)),
        entry("no-pool", "no", units(300))
      ],
      "yes",
      0
    );

    expect(result.kind).toBe("settled");
    expect(payout(result.payouts, "yes-small")).toBe(units(10));
  });

  it("takes rake from the losing pool only and conserves every minor unit", () => {
    const result = settleParimutuel(
      [
        entry("yes-target", "yes", units(70)),
        entry("yes-rest", "yes", units(630)),
        entry("no-pool", "no", units(300))
      ],
      "yes",
      0.05
    );

    expect(result.kind).toBe("settled");
    expect(result.rakeAmount).toBe(units(15));
    expect(result.prizePool).toBe(units(285));
    expect(payout(result.payouts, "yes-target")).toBe(units(98.5));
    expect(sumPayouts(result.payouts) + result.rakeAmount).toBe(result.totalStaked);
  });

  it("uses largest remainder allocation with stable tie-breaking", () => {
    const result = settleParimutuel(
      [
        entry("winner-b", "yes", 1, "2026-06-25T00:00:01.000Z"),
        entry("winner-a", "yes", 1, "2026-06-25T00:00:00.000Z"),
        entry("loser", "no", 1)
      ],
      "yes",
      0
    );

    expect(result.kind).toBe("settled");
    expect(payout(result.payouts, "winner-a")).toBe(2);
    expect(payout(result.payouts, "winner-b")).toBe(1);
    expect(sumPayouts(result.payouts)).toBe(3);
  });

  it("refunds principal when everyone is on the winning side", () => {
    const result = settleParimutuel(
      [entry("yes-1", "yes", 100), entry("yes-2", "yes", 200)],
      "yes",
      0.05
    );

    expect(result.kind).toBe("settled");
    expect(result.rakeAmount).toBe(0);
    expect(result.prizePool).toBe(0);
    expect(payout(result.payouts, "yes-1")).toBe(100);
    expect(payout(result.payouts, "yes-2")).toBe(200);
  });

  it("requires void handling when no entry is on the winning side", () => {
    const result = settleParimutuel(
      [entry("no-1", "no", 100), entry("no-2", "no", 200)],
      "yes",
      0.05
    );

    expect(result.kind).toBe("void_required");
    expect(result.rakeAmount).toBe(0);
    expect(result.payouts.every((candidate) => candidate.payout === 0)).toBe(true);
  });

  it("calculates implied probability and preview payout for live display", () => {
    const totals = calculatePoolTotals([
      entry("yes-1", "yes", units(700)),
      entry("no-1", "no", units(300))
    ]);

    expect(impliedProb(totals)).toEqual({ yes: 0.7, no: 0.3 });
    expect(impliedProb({ yes: 0, no: 0 })).toEqual({ yes: 0.5, no: 0.5 });
    expect(previewPayout({ yes: units(700), no: units(300) }, "yes", units(70), 0.05)).toBe(959);
  });

  it("conserves value and never taxes winner principal across randomized books", () => {
    let seed = 12_345;

    for (let run = 0; run < 300; run += 1) {
      const yesCount = 1 + nextInt(8);
      const noCount = 1 + nextInt(8);
      const entries: SettlementEntry[] = [];

      for (let index = 0; index < yesCount; index += 1) {
        entries.push(entry(`run-${run}-yes-${index}`, "yes", 1 + nextInt(10_000)));
      }
      for (let index = 0; index < noCount; index += 1) {
        entries.push(entry(`run-${run}-no-${index}`, "no", 1 + nextInt(10_000)));
      }

      const outcome = nextInt(2) === 0 ? "yes" : "no";
      const rake = nextInt(1_001) / 10_000;
      const result = settleParimutuel(entries, outcome, rake);

      expect(result.kind).toBe("settled");
      expect(sumPayouts(result.payouts) + result.rakeAmount).toBe(result.totalStaked);

      for (const candidate of result.payouts) {
        if (candidate.side === outcome) {
          expect(candidate.payout).toBeGreaterThanOrEqual(candidate.stake);
        } else {
          expect(candidate.payout).toBe(0);
        }
      }
    }

    function nextInt(maxExclusive: number) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed % maxExclusive;
    }
  });
});

function entry(
  id: string,
  side: "yes" | "no",
  amount: number,
  placedAt = "2026-06-25T00:00:00.000Z"
): SettlementEntry {
  return { id, side, amount, placedAt };
}

function payout(payouts: { entryId: string; payout: number }[], entryId: string) {
  const found = payouts.find((candidate) => candidate.entryId === entryId);
  expect(found).toBeDefined();
  return found?.payout;
}

function sumPayouts(payouts: { payout: number }[]) {
  return payouts.reduce((sum, candidate) => sum + candidate.payout, 0);
}

function units(amount: number) {
  return Math.round(amount * 10);
}
