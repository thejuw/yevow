import type { CroupierDecision } from "../../../agents/CroupierAgent";
import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import type {
  AgentHealth,
  AgentName,
  AgentSignal,
  EngineState,
  ProfilerState
} from "../../../types";

export function defaultAgentHealth(observedAt: string): Record<AgentName, AgentHealth> {
  return Object.fromEntries(
    (
      [
        "ORACLE",
        "SENTIMENT",
        "PROFILER",
        "CROUPIER",
        "PIT_BOSS",
        "JANITOR",
        "EXECUTIONER",
        "MOLTWORKER",
        "RISK",
        "SYSTEM"
      ] as AgentName[]
    ).map((agent) => [
      agent,
      {
        status: "YELLOW",
        heartbeatAt: observedAt,
        latencyMs: 0,
        failures24h: 0
      } satisfies AgentHealth
    ])
  ) as Record<AgentName, AgentHealth>;
}

export function defaultEnsembleState(observedAt: string): EngineState["ensemble"] {
  return {
    schemaVersion: "ensemble.v1",
    confidence: 0,
    kellyMultiplier: 0,
    regimeMultiplier: 1,
    anomalyCircuitBreaker: false,
    votes: [],
    rationale: "ENSEMBLE_NOT_EVALUATED",
    updatedAt: observedAt
  };
}

export function inferSignalBias(signal: AgentSignal): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (signal.action === "BUY" || signal.expectedValue > 0) {
    return "BULLISH";
  }

  if (signal.action === "SELL" || signal.action === "REDUCE" || signal.expectedValue < 0) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

export function hawkesEvacuationSignal(signal: AgentSignal): boolean {
  return signal.action === "PAUSE" && signal.featureVector?.signalType === "HAWKES_FLOW_CLUSTER";
}

export function touchAgentHealth(
  current: Record<AgentName, AgentHealth>,
  agentName: AgentName,
  status: AgentHealth["status"],
  heartbeatAt: string,
  latencyMs: number,
  lastSignalId?: string
): Record<AgentName, AgentHealth> {
  return {
    ...current,
    [agentName]: {
      status,
      heartbeatAt,
      latencyMs,
      lastSignalId: lastSignalId ?? current[agentName].lastSignalId,
      failures24h: current[agentName].failures24h
    }
  };
}

export function disabledProfilerEvaluation(
  state: ProfilerState,
  observedAt: string
): ProfilerEvaluation {
  return {
    processed: false,
    skippedReason: "PROFILER_AGENT_DISABLED",
    closedBuckets: 0,
    toxicityScore: 0,
    state: {
      ...state,
      toxicityScore: 0,
      amVpinScore: 0,
      toxicityState: "NORMAL",
      pressureSide: "NEUTRAL",
      spreadMultiplier: 1,
      reservationShiftBps: 0,
      quoteHaltUntil: null,
      updatedAt: observedAt
    },
    signal: null
  };
}

export function disabledCroupierDecision(minEvThreshold: number): CroupierDecision {
  return {
    intent: null,
    quote: null,
    pullAllQuotes: false,
    adverseSelectionCost: 0,
    minEvThreshold: Number.isFinite(minEvThreshold) ? minEvThreshold : 0
  };
}
