import { describe, expect, it } from "vitest";
import {
  buildCascadeOperationalAlertTelemetry,
  buildCascadeSignalTelemetry
} from "../../src/engine/trading/telemetry/CascadeSignalTelemetryRuntime";
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

  it("builds dashboard-only operational alerts without external notifications", () => {
    const event = buildCascadeOperationalAlertTelemetry(
      "CASCADE_DETECTED",
      "Cascade detected",
      "Large liquidation wave detected",
      { cascadeId: "cascade-1", instrumentCode: "btc-usd" },
      "cascade-1"
    );

    expect(event).toEqual({
      telemetryType: "CASCADE_ALERT",
      correlationId: "cascade-1",
      notification: null,
      payload: {
        eventType: "CASCADE_DETECTED",
        priority: "LOW",
        routes: ["DASHBOARD"],
        externalDelivery: false,
        cascadeId: "cascade-1",
        instrumentCode: "btc-usd"
      }
    });
  });

  it("builds externally delivered operational alerts with notifier metadata", () => {
    const event = buildCascadeOperationalAlertTelemetry(
      "POSITION_OPENED",
      "Cascade position opened",
      "Paper cascade entry opened",
      { positionId: "position-1", instrumentCode: "hype-usd" },
      "position-1"
    );

    expect(event).toMatchObject({
      telemetryType: "CASCADE_ALERT",
      correlationId: "position-1",
      payload: {
        eventType: "POSITION_OPENED",
        priority: "HIGH",
        routes: ["DASHBOARD", "LOG", "ALL_CHANNELS"],
        externalDelivery: true,
        positionId: "position-1",
        instrumentCode: "hype-usd"
      },
      notification: {
        priority: "HIGH",
        title: "Cascade position opened",
        message: "Paper cascade entry opened",
        dedupeKey: "cascade:POSITION_OPENED:position-1",
        metadata: {
          positionId: "position-1"
        }
      }
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
