import { describe, expect, it } from "vitest";
import {
  acceptedAgentSignalStorageEntries,
  agentSignalStorageKey,
  buildHawkesEvacuationDispatch,
  recordAgentSignalInBuffers,
  stateAfterAcceptedAgentSignal
} from "../../src/engine/trading/telemetry/AgentSignalRuntime";
import { defaultEngineState } from "../../src/engine/trading/helpers/RuntimeHelpers";
import type { AgentName, AgentSignal } from "../../src/types";

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

  it("builds Hawkes evacuation dispatch artifacts for quote suspension and cancellation", () => {
    const state = defaultEngineState("agent-signal");
    state.quoteState = {
      status: "SUSPENDED",
      reason: "HAWKES_FLOW_CLUSTER",
      suspendedUntil: "2026-05-19T12:01:00.000Z",
      lastQuote: null,
      updatedAt: "2026-05-19T12:00:00.000Z"
    };

    expect(buildHawkesEvacuationDispatch(signal(), state.quoteState)).toEqual({
      telemetryType: "SUSPEND_QUOTES",
      payload: {
        status: "SUSPENDED",
        reason: "HAWKES_FLOW_CLUSTER",
        suspendedUntil: "2026-05-19T12:01:00.000Z",
        updatedAt: "2026-05-19T12:00:00.000Z"
      },
      correlationId: "signal-1",
      cancelInstrumentCode: "btc-usd",
      cancelReason: "HAWKES_FLOW_CLUSTER"
    });
    expect(
      buildHawkesEvacuationDispatch(signal({ instrumentCode: "" }), state.quoteState)
        .cancelInstrumentCode
    ).toBe("ALL");
  });

  it("records signals in capped buffers and latest-agent indexes", () => {
    const signals = [
      signal({ signalId: "old-1", sourceAgent: "ORACLE" }),
      signal({ signalId: "old-2", sourceAgent: "PROFILER" })
    ];
    const latestAgentSignals = new Map<AgentName, AgentSignal>();

    recordAgentSignalInBuffers({
      signals,
      latestAgentSignals,
      signal: signal({ signalId: "new-1", sourceAgent: "ORACLE" }),
      signalBufferLimit: 2
    });

    expect(signals.map((item) => item.signalId)).toEqual(["old-2", "new-1"]);
    expect(latestAgentSignals.get("ORACLE")?.signalId).toBe("new-1");
  });

  it("builds stable storage keys and entries for accepted signals", () => {
    const state = defaultEngineState("agent-signal-storage");
    const acceptedSignal = signal({ signalId: "signal-storage-1" });

    expect(agentSignalStorageKey(acceptedSignal)).toBe("signal:signal-storage-1");
    expect(
      acceptedAgentSignalStorageEntries({
        engineStateKey: "engine:state",
        state,
        signal: acceptedSignal
      })
    ).toEqual({
      "engine:state": state,
      "signal:signal-storage-1": acceptedSignal
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
