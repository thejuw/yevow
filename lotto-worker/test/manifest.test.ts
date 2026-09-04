import { describe, expect, it } from "vitest";

import {
  GAME_CODES,
  GAME_MANIFEST,
  SOURCES,
  getSource,
  isGameCode,
  publicManifest
} from "../src/manifest";

describe("game manifest", () => {
  it("contains the complete supported game inventory in stable API order", () => {
    expect(GAME_CODES).toEqual(["lotto", "twostep", "cash5", "pb", "mm", "p3", "d4", "aon"]);
    expect(Object.keys(GAME_MANIFEST)).toEqual(GAME_CODES);
  });

  it("encodes current matrices, costs, and audit-era boundaries", () => {
    expect(GAME_MANIFEST.lotto).toMatchObject({
      kind: "pool",
      main: { count: 6, min: 1, max: 54, allowDuplicates: false },
      baseCostCents: 100,
      auditStart: "2006-04-26"
    });
    expect(GAME_MANIFEST.twostep).toMatchObject({
      kind: "bonus",
      main: { count: 4, min: 1, max: 35, allowDuplicates: false },
      bonus: { count: 1, min: 1, max: 35 },
      baseCostCents: 100,
      auditStart: "2001-05-18"
    });
    expect(GAME_MANIFEST.cash5).toMatchObject({
      kind: "pool",
      main: { count: 5, min: 1, max: 35, allowDuplicates: false },
      baseCostCents: 100,
      auditStart: "2018-09-24"
    });
    expect(GAME_MANIFEST.pb).toMatchObject({
      kind: "bonus",
      main: { count: 5, min: 1, max: 69, allowDuplicates: false },
      bonus: { count: 1, min: 1, max: 26 },
      baseCostCents: 200,
      auditStart: "2015-10-07"
    });
    expect(GAME_MANIFEST.mm).toMatchObject({
      kind: "bonus",
      main: { count: 5, min: 1, max: 70, allowDuplicates: false },
      bonus: { count: 1, min: 1, max: 24 },
      baseCostCents: 500,
      auditStart: "2025-04-08"
    });
    expect(GAME_MANIFEST.p3.main).toEqual({
      count: 3,
      min: 0,
      max: 9,
      allowDuplicates: true
    });
    expect(GAME_MANIFEST.d4.main).toEqual({
      count: 4,
      min: 0,
      max: 9,
      allowDuplicates: true
    });
    expect(GAME_MANIFEST.aon.main).toEqual({
      count: 12,
      min: 1,
      max: 24,
      allowDuplicates: false
    });
  });

  it("has a unique and complete official source inventory", () => {
    expect(SOURCES).toHaveLength(17);
    expect(new Set(SOURCES.map(({ id }) => id)).size).toBe(SOURCES.length);
    expect(
      Object.fromEntries(
        GAME_CODES.map((game) => [game, SOURCES.filter((source) => source.game === game).length])
      )
    ).toEqual({ lotto: 1, twostep: 1, cash5: 1, pb: 1, mm: 1, p3: 4, d4: 4, aon: 4 });

    for (const source of SOURCES) {
      expect(source.url).toMatch(
        /^https:\/\/www\.texaslottery\.com\/export\/sites\/lottery\/Games\//
      );
      expect(source.url).toMatch(/\.csv$/);
      expect(source.expectedWidths.length).toBeGreaterThan(0);
      expect(source.expectedWidths.every((width) => Number.isInteger(width) && width > 0)).toBe(
        true
      );
      expect(getSource(source.id)).toBe(source);
    }
  });

  it("requires all four named sessions for four-draw games", () => {
    for (const game of ["p3", "d4", "aon"] as const) {
      expect(GAME_MANIFEST[game].sources.map(({ session }) => session)).toEqual([
        "morning",
        "day",
        "evening",
        "night"
      ]);
    }
  });

  it("exposes strict game and source lookups", () => {
    expect(isGameCode("lotto")).toBe(true);
    expect(isGameCode("LOTTO")).toBe(false);
    expect(isGameCode("__proto__")).toBe(false);
    expect(() => getSource("lotto:missing")).toThrow(RangeError);
  });

  it("does not expose ingestion source URLs in the public manifest", () => {
    const output = publicManifest();
    expect(output).toHaveLength(GAME_CODES.length);
    expect(output.map(({ code }) => code)).toEqual(GAME_CODES);
    expect(output.every((config) => !("sources" in config))).toBe(true);
  });
});
