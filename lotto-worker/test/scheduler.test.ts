import { describe, expect, it } from "vitest";

import { deriveProtectedDailySeed, deterministicDailySeed } from "../src/autonomy";
import {
  dueGames,
  isConfiguredDue,
  isGenerationTimeBeforeDeadline,
  isPastGenerationDeadline,
  officialDrawWeekdays,
  parseLocalTime,
  parseSelectedGames,
  parseWeekdays,
  previousConfiguredDrawDate,
  texasDayUtcBounds,
  texasClock
} from "../src/scheduler";
import type { GameCode } from "../src/manifest";

const ALL: readonly GameCode[] = ["lotto", "twostep", "cash5", "pb", "mm", "p3", "d4", "aon"];

describe("Central-time autonomous schedule", () => {
  it.each([
    ["2026-09-07T12:00:00Z", ["lotto", "twostep", "cash5", "p3", "d4", "aon"]],
    ["2026-09-08T12:00:00Z", ["cash5", "mm", "p3", "d4", "aon"]],
    ["2026-09-09T12:00:00Z", ["lotto", "cash5", "pb", "p3", "d4", "aon"]],
    ["2026-09-10T12:00:00Z", ["twostep", "cash5", "p3", "d4", "aon"]],
    ["2026-09-11T12:00:00Z", ["cash5", "mm", "p3", "d4", "aon"]],
    ["2026-09-12T12:00:00Z", ["cash5", "pb", "p3", "d4", "aon"]],
    ["2026-09-13T12:00:00Z", []]
  ])("returns the requested game matrix at %s", (timestamp, expected) => {
    expect(dueGames(new Date(timestamp), ALL, 7)).toEqual(expected);
  });

  it("starts at the configured minute and catches up later", () => {
    const weekdays = parseWeekdays('["Mon"]');
    expect(isConfiguredDue(texasClock(new Date("2026-09-07T11:59:00Z")), weekdays, "07:00")).toBe(
      false
    );
    expect(isConfiguredDue(texasClock(new Date("2026-09-07T12:00:00Z")), weekdays, "07:00")).toBe(
      true
    );
    expect(isConfiguredDue(texasClock(new Date("2026-09-07T20:00:00Z")), weekdays, "07:00")).toBe(
      true
    );
  });

  it("enforces the before-09:00 generation SLA while retaining catch-up", () => {
    expect(isGenerationTimeBeforeDeadline("08:59")).toBe(true);
    expect(isGenerationTimeBeforeDeadline("09:00")).toBe(false);
    expect(isPastGenerationDeadline(texasClock(new Date("2026-09-07T13:59:00Z")))).toBe(false);
    expect(isPastGenerationDeadline(texasClock(new Date("2026-09-07T14:00:00Z")))).toBe(true);
  });

  it("uses America/Chicago across DST and UTC date rollover", () => {
    expect(texasClock(new Date("2026-11-02T13:00:00Z"))).toMatchObject({
      date: "2026-11-02",
      weekday: "Mon",
      hour: 7
    });
    expect(texasClock(new Date("2026-09-08T01:00:00Z"))).toMatchObject({
      date: "2026-09-07",
      weekday: "Mon",
      hour: 20
    });
  });

  it("computes exact Texas service-day bounds across DST transitions", () => {
    expect(texasDayUtcBounds("2026-09-04")).toEqual({
      start: "2026-09-04T05:00:00.000Z",
      end: "2026-09-05T05:00:00.000Z"
    });
    expect(texasDayUtcBounds("2026-03-08")).toEqual({
      start: "2026-03-08T06:00:00.000Z",
      end: "2026-03-09T05:00:00.000Z"
    });
    expect(texasDayUtcBounds("2026-11-01")).toEqual({
      start: "2026-11-01T05:00:00.000Z",
      end: "2026-11-02T06:00:00.000Z"
    });
  });

  it("validates persisted schedule configuration", () => {
    expect(parseSelectedGames("cash5, lotto,cash5")).toEqual(["lotto", "cash5"]);
    expect(parseLocalTime("07:05")).toEqual({ hour: 7, minute: 5 });
    expect(() => parseLocalTime("7:05")).toThrow(/HH:MM/);
    expect(() => parseWeekdays('["Funday"]')).toThrow(/weekday/);
  });

  it("rotates the deterministic seed only when the natural run key changes", () => {
    const first = deterministicDailySeed("cash5", "2026-09-07", "daily");
    expect(deterministicDailySeed("cash5", "2026-09-07", "daily")).toBe(first);
    expect(deterministicDailySeed("cash5", "2026-09-08", "daily")).not.toBe(first);
    expect(deterministicDailySeed("lotto", "2026-09-07", "daily")).not.toBe(first);
  });

  it("HMAC-protects the deterministic seed namespace with an independent secret", async () => {
    const first = await deriveProtectedDailySeed(
      "a-private-seed-salt-with-at-least-32-characters",
      "cash5",
      "2026-09-07",
      "daily"
    );
    const repeated = await deriveProtectedDailySeed(
      "a-private-seed-salt-with-at-least-32-characters",
      "cash5",
      "2026-09-07",
      "daily"
    );
    const otherSecret = await deriveProtectedDailySeed(
      "a-different-private-seed-salt-over-32-chars",
      "cash5",
      "2026-09-07",
      "daily"
    );

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(repeated).toBe(first);
    expect(otherSecret).not.toBe(first);
    expect(first).not.toContain("cash5");
  });

  it("derives the last completed draw from each configured cadence", () => {
    expect(previousConfiguredDrawDate("2026-09-07", ["Mon", "Wed"])).toBe("2026-09-02");
    expect(
      previousConfiguredDrawDate("2026-09-03", ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
    ).toBe("2026-09-02");
    expect(
      previousConfiguredDrawDate("2026-09-07", ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
    ).toBe("2026-09-05");
    expect(previousConfiguredDrawDate("2026-09-07", officialDrawWeekdays("lotto"))).toBe(
      "2026-09-05"
    );
    expect(previousConfiguredDrawDate("2026-09-09", officialDrawWeekdays("pb"))).toBe("2026-09-07");
  });
});
