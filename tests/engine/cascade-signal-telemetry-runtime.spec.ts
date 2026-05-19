import { describe, expect, it } from "vitest";
import { buildCascadeSignalTelemetry } from "../../src/engine/trading/telemetry/CascadeSignalTelemetryRuntime";
import type { AgentSignal } from "../../src/types";

describe("CascadeSignalTelemetryRuntime", () => {
  it("builds the dashboard cascade signal event and prefers feature cascade ids", () => {
    expect(
      buildCascadeSignalTelemetry(
        signal({
          featureVector: { cascadeId: "cascade-feature" },
          riskContext: { cascadeId: "cascade-risk" }
        }),
        "TAKEN"
      )
    ).toEqual({
      telemetryType: "CASCADE_SIGNAL",
      correlationId: "signal-1",
      payload: {
        signalId: "signal-1",
        traceId: "trace-1",
        sourceAgent: "ORACLE",
        targetAgent: "CROUPIER",
        instrumentCode: "hype-usd",
        action: "BUY",
        confidence: 0.8,
        expectedValue: 1.2,
        outcome: "TAKEN",
        cascadeId: "cascade-feature",
        createdAt: "2026-05-19T12:00:00.000Z"
      }
    });
  });

  it("falls back to risk-context cascade ids", () => {
    const event = buildCascadeSignalTelemetry(
      signal({ featureVector: {}, riskContext: { cascadeId: "cascade-risk" } }),
      "SKIPPED"
    );

    expect(event.payload).toMatchObject({
      outcome: "SKIPPED",
      cascadeId: "cascade-risk"
    });
  });
});

function signal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return {
    signalId: "signal-1",
    traceId: "trace-1",
    sourceAgent: "ORACLE",
    targetAgent: "CROUPIER",
    instrumentCode: "hype-usd",
    action: "BUY",
    confidence: 0.8,
    horizonMs: 10_000,
    expectedValue: 1.2,
    maxSlippageBps: 5,
    rationale: "cascade recovery",
    featureVector: {},
    riskContext: {},
    createdAt: "2026-05-19T12:00:00.000Z",
    ...overrides
  };
}
