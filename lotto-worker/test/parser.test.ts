import { describe, expect, it } from "vitest";

import { GAME_MANIFEST } from "../src/manifest";
import { SchemaMismatchError, parseOfficialCsv } from "../src/parser";

const NOW = new Date("2026-09-03T18:00:00-05:00");

function parse(game: keyof typeof GAME_MANIFEST, text: string, sourceIndex = 0) {
  const source = GAME_MANIFEST[game].sources[sourceIndex];
  if (!source) throw new Error(`Missing source ${game}[${sourceIndex}]`);
  return parseOfficialCsv(text, source, NOW);
}

describe("rules-era boundaries", () => {
  it("switches Lotto Texas from 6/50 to 6/54 on 2000-07-19", () => {
    const before = parse("lotto", "Lotto Texas,7,15,2000,1,2,3,4,5,50\n");
    const boundary = parse("lotto", "Lotto Texas,7,19,2000,9,28,35,51,53,54\n");

    expect(before.draws[0]?.metadata).toMatchObject({ rules_era: "6/50" });
    expect(boundary.draws[0]).toMatchObject({
      orderedNumbers: [9, 28, 35, 51, 53, 54],
      canonicalNumbers: [9, 28, 35, 51, 53, 54],
      bonusNumbers: [],
      metadata: { rules_era: "6/54" }
    });
  });

  it("preserves the temporary Lotto Texas 5/44 plus bonus era", () => {
    const first = parse("lotto", "Lotto Texas,5,7,2003,1,2,3,4,44,43\n");
    const last = parse("lotto", "Lotto Texas,4,22,2006,8,7,6,5,4,3\n");

    expect(first.draws[0]).toMatchObject({
      orderedNumbers: [1, 2, 3, 4, 44],
      bonusNumbers: [43],
      metadata: { rules_era: "5/44-plus-bonus" }
    });
    expect(last.draws[0]?.metadata).toMatchObject({ rules_era: "5/44-plus-bonus" });
  });

  it("switches Cash Five matrices at both historical boundaries", () => {
    const legacy = parse("cash5", "Cash Five,7,26,2002,1,2,3,38,39\n");
    const thirtySeven = parse("cash5", "Cash Five,7,29,2002,1,2,3,36,37\n");
    const thirtyFive = parse("cash5", "Cash Five,9,24,2018,1,2,3,34,35\n");

    expect(legacy.draws[0]?.metadata).toMatchObject({ rules_era: "5/39" });
    expect(thirtySeven.draws[0]?.metadata).toMatchObject({ rules_era: "5/37" });
    expect(thirtyFive.draws[0]?.metadata).toMatchObject({ rules_era: "5/35" });
  });

  it("enforces date-conditioned Powerball layouts and matrices", () => {
    const old = parse("pb", "Powerball,1,14,2012,1,2,3,4,59,39,5\n");
    const nextEra = parse("pb", "Powerball,1,18,2012,1,2,3,4,59,35\n");
    const current = parse("pb", "Powerball,10,7,2015,1,2,3,4,69,26,10\n");

    expect(old.draws[0]?.metadata).toMatchObject({
      rules_era: "5/59+1/39",
      power_play: 5
    });
    expect(nextEra.draws[0]?.metadata).toEqual({ rules_era: "5/59+1/35" });
    expect(current.draws[0]).toMatchObject({
      bonusNumbers: [26],
      metadata: { rules_era: "5/69+1/26", power_play: 10 }
    });

    expect(() => parse("pb", "Powerball,1,18,2012,1,2,3,4,59,35,3\n")).toThrow(
      /expected 10 columns for 2012-01-18 through 2014-01-18 Powerball/
    );
  });

  it("switches Mega Millions width and Mega Ball range on 2025-04-08", () => {
    const before = parse("mm", "Mega Millions,4,4,2025,1,2,3,4,70,25,5\n");
    const boundary = parse("mm", "Mega Millions,4,8,2025,1,2,3,4,70,24\n");

    expect(before.draws[0]?.metadata).toMatchObject({
      rules_era: "5/70+1/25",
      megaplier: 5
    });
    expect(boundary.draws[0]).toMatchObject({
      bonusNumbers: [24],
      metadata: { rules_era: "5/70+1/24" }
    });
    expect(() => parse("mm", "Mega Millions,4,8,2025,1,2,3,4,70,24,3\n")).toThrow(
      /expected 10 columns for 2025 onward Mega Millions/
    );
  });

  it("preserves Pick 3 blank columns across base, Sum It Up, and FIREBALL eras", () => {
    const before = parse("p3", "Pick 3 Day,11,10,2007,2,0,9,,\n", 1);
    const sumItUp = parse("p3", "Pick 3 Day,11,12,2007,8,8,0,16,\n", 1);
    const fireball = parse("p3", "Pick 3 Day,4,29,2019,3,1,0,,7\n", 1);

    expect(before.draws[0]?.metadata).toEqual({});
    expect(sumItUp.draws[0]?.metadata).toMatchObject({
      feature_name: "sum_it_up",
      feature_value: 16
    });
    expect(fireball.draws[0]?.metadata).toEqual({
      feature_name: "fireball",
      feature_value: 7
    });
  });
});

describe("malformed-row isolation and schema drift", () => {
  it("quarantines one malformed physical row without discarding surrounding draws", () => {
    const result = parse(
      "cash5",
      [
        "Cash Five,8,31,2026,1,2,3,4,5",
        'Cash Five,9,1,2026,"1,2,3,4,5',
        "Cash Five,9,2,2026,28,15,13,31,5"
      ].join("\n")
    );

    expect(result).toMatchObject({ totalRows: 3, observedWidths: { "9": 2 } });
    expect(result.draws).toHaveLength(2);
    expect(result.issues).toEqual([
      expect.objectContaining({
        sourceLine: 2,
        rawRecord: 'Cash Five,9,1,2026,"1,2,3,4,5',
        reason: "unterminated CSV quote"
      })
    ]);
  });

  it("fails loudly when malformed rows dominate instead of accepting a changed layout", () => {
    let thrown: unknown;
    try {
      parse(
        "cash5",
        [
          "Cash Five,8,31,2026,1,2,3,4,5",
          "Cash Five,9,1,2026,1,2,3,4,5,6",
          "Cash Five,9,2,2026,1,2,3,4,5,6"
        ].join("\n")
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SchemaMismatchError);
    expect(thrown).toMatchObject({
      issues: [
        expect.objectContaining({ sourceLine: 2 }),
        expect.objectContaining({ sourceLine: 3 })
      ]
    });
    expect((thrown as Error).message).toMatch(/Consecutive invalid tail detected=true/);
    expect((thrown as Error).message).toMatch(/official file layout may have changed/);
  });

  it("reports observed widths when every row violates the source schema", () => {
    expect(() =>
      parse("cash5", ["Cash Five,9,1,2026,1,2,3,4", "Cash Five,9,2,2026,1,2,3,4"].join("\n"))
    ).toThrow(/Expected column counts 9; observed \{"8":2\}/);
  });

  it("rejects HTML maintenance responses before row parsing", () => {
    expect(() => parse("cash5", "\uFEFF  <!doctype html><title>Maintenance</title>")).toThrowError(
      new SchemaMismatchError(
        "Schema mismatch for cash5:cashfive: received HTML, not the documented Texas Lottery CSV"
      )
    );
  });

  it("rejects pre-launch dates and impossible session history", () => {
    expect(() => parse("cash5", "Cash Five,10,12,1995,1,2,3,4,5\n")).toThrow(
      /did not launch until 1995-10-13/
    );
    expect(() => parse("p3", "Pick 3 Morning,1,1,2010,1,2,3\n", 0)).toThrow(
      /morning did not launch until 2013-09-09/
    );
  });

  it("rejects future dates using Texas civil time", () => {
    expect(() => parse("cash5", "Cash Five,9,4,2026,1,2,3,4,5\n")).toThrow(
      /draw date 2026-09-04 is in the future/
    );
  });
});
