import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import { nextTickAgentHealth } from "../../src/engine/trading/state/AgentHealthRuntime";
import { defaultEngineState } from "../../src/engine/trading/helpers/RuntimeHelpers";

describe("AgentHealthRuntime", () => {
  it("marks active agents from per-tick outcomes", () => {
    const observedAt = "2026-05-18T15:00:00.000Z";
    const previous = defaultEngineState("agent-health-test").agentHealth;

    const health = nextTickAgentHealth({
      previous,
      config: {
        ...defaultConfig,
        ORACLE_ENABLED: true,
        SENTIMENT_ENABLED: true,
        PROFILER_ENABLED: true,
        CROUPIER_ENABLED: true,
        PIT_BOSS_ENABLED: true,
        MARKET_MAKING_MODE: "BALANCED"
      },
      observedAt,
      oracleLatencyMs: 1.2,
      sentimentLatencyMs: 2.3,
      profilerToxicityScore: 0.2,
      profilerAlertThreshold: 0.7,
      profilerLatencyMs: 0.8,
      croupierLatencyMs: 1.1,
      croupierHasOutput: true,
      croupierSignalId: "quote-1",
      pitBossIntentId: "intent-1"
    });

    expect(health.ORACLE).toMatchObject({ status: "GREEN", latencyMs: 1.2 });
    expect(health.SENTIMENT).toMatchObject({ status: "GREEN", latencyMs: 2.3 });
    expect(health.PROFILER).toMatchObject({ status: "GREEN", latencyMs: 0.8 });
    expect(health.CROUPIER).toMatchObject({
      status: "GREEN",
      lastSignalId: "quote-1",
      latencyMs: 1.1
    });
    expect(health.PIT_BOSS).toMatchObject({
      status: "GREEN",
      lastSignalId: "intent-1",
      heartbeatAt: observedAt
    });
  });

  it("surfaces degraded and disabled agent states", () => {
    const previous = defaultEngineState("agent-health-test").agentHealth;
    const health = nextTickAgentHealth({
      previous,
      config: {
        ...defaultConfig,
        ORACLE_ENABLED: false,
        SENTIMENT_ENABLED: false,
        PROFILER_ENABLED: true,
        CROUPIER_ENABLED: true,
        PIT_BOSS_ENABLED: true,
        MARKET_MAKING_MODE: "OFF"
      },
      observedAt: "2026-05-18T15:00:00.000Z",
      oracleLatencyMs: 1,
      sentimentLatencyMs: 5,
      profilerToxicityScore: 0.9,
      profilerAlertThreshold: 0.7,
      profilerLatencyMs: 0.4,
      profilerSignalId: "profiler-alert",
      croupierLatencyMs: 0.6,
      croupierHasOutput: false
    });

    expect(health.ORACLE.status).toBe("DISABLED");
    expect(health.SENTIMENT).toMatchObject({ status: "DISABLED", latencyMs: 0 });
    expect(health.PROFILER).toMatchObject({
      status: "YELLOW",
      lastSignalId: "profiler-alert"
    });
    expect(health.CROUPIER.status).toBe("DISABLED");
    expect(health.PIT_BOSS.status).toBe("YELLOW");
  });
});
