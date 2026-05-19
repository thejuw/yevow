import { describe, expect, it } from "vitest";
import { buildAgentStateSnapshot } from "../../src/engine/trading/telemetry/AgentSnapshotRuntime";
import { defaultEngineState } from "../../src/TradingEngineRuntimeHelpers";
import type { AgentName, AgentSignal } from "../../src/types";

describe("AgentSnapshotRuntime", () => {
  it("does not build a snapshot before the configured tick interval", () => {
    const state = defaultEngineState("agent-snapshot");
    state.processedTicks = 999;

    expect(
      buildAgentStateSnapshot({
        engineState: state,
        latestAgentSignals: new Map(),
        observedAt: "2026-05-19T12:00:00.000Z",
        snapshotIntervalTicks: 1_000
      })
    ).toBeNull();
  });

  it("builds a periodic agent state snapshot from latest signals", () => {
    const state = defaultEngineState("agent-snapshot");
    state.processedTicks = 1_000;
    state.agentHealth.ORACLE = {
      ...state.agentHealth.ORACLE,
      status: "GREEN",
      heartbeatAt: "2026-05-19T12:00:00.000Z"
    };
    const signals = new Map<AgentName, AgentSignal>([
      ["ORACLE", signal({ sourceAgent: "ORACLE", action: "BUY", expectedValue: 2 })]
    ]);

    const result = buildAgentStateSnapshot({
      engineState: state,
      latestAgentSignals: signals,
      observedAt: "2026-05-19T12:00:01.000Z",
      snapshotIntervalTicks: 1_000
    });

    expect(result).not.toBeNull();
    expect(result?.correlationId).toBe("agent-snapshot:1000");
    expect(result?.payload).toMatchObject({
      observedAt: "2026-05-19T12:00:01.000Z",
      processedTicks: 1_000
    });
    expect(result?.payload.agents).toContainEqual({
      agentName: "ORACLE",
      health: "GREEN",
      confidence: 0.75,
      bias: "BULLISH",
      action: "BUY",
      expectedValue: 2,
      lastSignalId: "signal-1",
      heartbeatAt: "2026-05-19T12:00:00.000Z"
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
    confidence: 0.75,
    horizonMs: 1_000,
    expectedValue: 0,
    maxSlippageBps: 1,
    rationale: "test",
    featureVector: {},
    riskContext: {},
    createdAt: "2026-05-19T12:00:00.000Z",
    ...overrides
  };
}
