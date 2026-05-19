import { describe, expect, it } from "vitest";
import {
  LOW_VALUE_OPERATIONAL_EVENT_TYPES,
  emptyLogPruneReport,
  type LogRetentionD1,
  operationalEventPlaceholders,
  pruneOperationalLogsFromD1,
  resolveLogRetentionPolicy
} from "../../src/engine/LogRetention";

describe("log retention policy", () => {
  it("defaults to short-lived operational telemetry and bounded row caps", () => {
    const policy = resolveLogRetentionPolicy({}, Date.parse("2026-05-18T12:00:00.000Z"));

    expect(policy.telemetryRetentionDays).toBe(3);
    expect(policy.lowValueRetentionDays).toBe(2);
    expect(policy.marketTickRetentionDays).toBe(3);
    expect(policy.maxTelemetryRows).toBe(15_000);
    expect(policy.maxOperationalInfoRows).toBe(50_000);
    expect(policy.maxMarketTickRows).toBe(25_000);
    expect(policy.telemetryCutoff).toBe("2026-05-15T12:00:00.000Z");
    expect(policy.lowValueCutoff).toBe("2026-05-16T12:00:00.000Z");
  });

  it("clamps unsafe env values instead of creating destructive retention rules", () => {
    const policy = resolveLogRetentionPolicy(
      {
        JANITOR_LOG_RETENTION_DAYS: "0",
        JANITOR_LOW_VALUE_LOG_RETENTION_DAYS: "-9",
        JANITOR_TELEMETRY_MAX_ROWS: "5",
        JANITOR_OPERATIONAL_LOG_MAX_ROWS: "10",
        MARKET_TICK_MAX_ROWS: "1"
      },
      Date.parse("2026-05-18T12:00:00.000Z")
    );

    expect(policy.telemetryRetentionDays).toBe(1);
    expect(policy.lowValueRetentionDays).toBe(1);
    expect(policy.maxTelemetryRows).toBe(1_000);
    expect(policy.maxOperationalInfoRows).toBe(5_000);
    expect(policy.maxMarketTickRows).toBe(1_000);
  });

  it("builds SQL placeholders for every low-value operational event type", () => {
    expect(LOW_VALUE_OPERATIONAL_EVENT_TYPES).toContain("TELEMETRY");
    expect(LOW_VALUE_OPERATIONAL_EVENT_TYPES).toContain("STREAM_RECONNECT_ATTEMPT");
    expect(operationalEventPlaceholders().split(", ")).toHaveLength(
      LOW_VALUE_OPERATIONAL_EVENT_TYPES.length
    );
  });

  it("prunes D1 operational logs and aggregates changed row counts", async () => {
    const policy = resolveLogRetentionPolicy({}, Date.parse("2026-05-18T12:00:00.000Z"));
    const calls: { query: string; values: unknown[] }[] = [];
    const db = mockD1([1, 2, 3, 4, 5, 6], calls);

    const report = await pruneOperationalLogsFromD1(db, policy);

    expect(report).toEqual({
      policy,
      telemetryRows: 3,
      lowValueOperationalRows: 3,
      cappedOperationalInfoRows: 4,
      marketTickRows: 11,
      totalRows: 21
    });
    expect(calls).toHaveLength(6);
    expect(calls[0].query).toContain("DELETE FROM logs");
    expect(calls[0].values).toEqual([policy.telemetryCutoff]);
    expect(calls[2].values).toHaveLength(1 + LOW_VALUE_OPERATIONAL_EVENT_TYPES.length);
    expect(calls[4].values).toEqual([policy.marketTickCutoff]);
    expect(emptyLogPruneReport(policy).totalRows).toBe(0);
  });
});

function mockD1(changes: number[], calls: { query: string; values: unknown[] }[]): LogRetentionD1 {
  let runIndex = 0;

  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          calls.push({ query, values });

          return {
            async run() {
              const changedRows = changes[runIndex] ?? 0;
              runIndex += 1;

              return { meta: { changes: changedRows } };
            }
          };
        }
      };
    }
  };
}
