import { describe, expect, it } from "vitest";
import {
  LOW_VALUE_OPERATIONAL_EVENT_TYPES,
  operationalEventPlaceholders,
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
});
