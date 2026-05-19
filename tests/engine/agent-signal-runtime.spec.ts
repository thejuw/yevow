import { describe, expect, it } from "vitest";
import { stateAfterAcceptedAgentSignal } from "../../src/engine/trading/telemetry/AgentSignalRuntime";
import { defaultEngineState } from "../../src/TradingEngineRuntimeHelpers";
import type { AgentSignal } from "../../src/types";

describe("AgentSignalRuntime", () => {
  it("updates agent health and emits the accepted signal telemetry", () => {
    const state = defaultEngineState("agent-signal");
    state.acceptedSignals = 4;

    const result = stateAfterAcceptedAgentSignal({
      engineState: state,
      signal: signal({ action: "BUY", expectedValue: 1.5 }),
      latencyMs: 7
    });

    expect(result.hawkesEvacuation).toBe(false);
    expect(result.state.acceptedSignals).toBe(5);
    expect(result.state.agentHealth.ORACLE).toMatchObject({
      status: "GREEN",
      heartbeatAt: "2026-05-19T12:00:00.000Z",
      latencyMs: 7,
      lastSignalId: "signal-1"
    });
    expect(result.telemetry).toMatchObject({
      telemetryType: "AGENT_SIGNAL",
      correlationId: "signal-1",
      payload: {
        signalId: "signal-1",
        action: "BUY",
        bias: "BULLISH",
        expectedValue: 1.5,
        latencyMs: 7
      }
    });
  });

  it("suspends the instrument quote state when a Hawkes evacuation signal arrives", () => {
    const state = defaultEngineState("agent-signal");
    state.assetQuoteStates["btc-usd"] = {
      status: "ACTIVE",
      reason: null,
      suspendedUntil: null,
      lastQuote: null,
      updatedAt: "2026-05-19T11:59:00.000Z"
    };

    const result = stateAfterAcceptedAgentSignal({
      engineState: state,
      signal: signal({
        action: "PAUSE",
        horizonMs: 60_000,
        featureVector: { signalType: "HAWKES_FLOW_CLUSTER" }
      }),
      latencyMs: 3
    });

    expect(result.hawkesEvacuation).toBe(true);
    expect(result.state.assetQuoteStates["btc-usd"]).toMatchObject({
      status: "SUSPENDED",
      reason: "HAWKES_FLOW_CLUSTER",
      suspendedUntil: "2026-05-19T12:01:00.000Z"
    });
  });
});

function signal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return {
    signalId: "signal-1",
    traceId: "trace-1",
    sourceAgent: "ORACLE",
    targetAgent: "CROUPIER",
    instrumentCode: "btc-usd",
    action: "HOLD",
    confidence: 0.8,
    horizonMs: 10_000,
    expectedValue: 0,
    maxSlippageBps: 5,
    rationale: "agent signal",
    featureVector: {},
    riskContext: {},
    createdAt: "2026-05-19T12:00:00.000Z",
    ...overrides
  };
}
