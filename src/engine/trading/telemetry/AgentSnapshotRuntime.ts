import { inferSignalBias } from "../state/EngineStateDefaults";
import type { AgentName, AgentSignal, EngineState } from "../../../types";

export interface AgentStateSnapshotInput {
  readonly engineState: EngineState;
  readonly latestAgentSignals: ReadonlyMap<AgentName, AgentSignal>;
  readonly observedAt: string;
  readonly snapshotIntervalTicks: number;
}

export interface AgentStateSnapshotResult {
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

export interface AgentStateSnapshotPublishHandlers {
  readonly publish: (
    type: "AGENT_STATE_SNAPSHOT",
    payload: AgentStateSnapshotResult["payload"],
    correlationId: string
  ) => void;
}

export function buildAgentStateSnapshot(
  input: AgentStateSnapshotInput
): AgentStateSnapshotResult | null {
  const processedTicks = input.engineState.processedTicks;

  if (processedTicks === 0 || processedTicks % input.snapshotIntervalTicks !== 0) {
    return null;
  }

  const agents = (Object.keys(input.engineState.agentHealth) as AgentName[]).map((agentName) => {
    const latestSignal = input.latestAgentSignals.get(agentName);

    return {
      agentName,
      health: input.engineState.agentHealth[agentName].status,
      confidence: latestSignal?.confidence ?? null,
      bias: latestSignal ? inferSignalBias(latestSignal) : "NEUTRAL",
      action: latestSignal?.action ?? null,
      expectedValue: latestSignal?.expectedValue ?? null,
      lastSignalId: latestSignal?.signalId ?? null,
      heartbeatAt: input.engineState.agentHealth[agentName].heartbeatAt
    };
  });

  return {
    payload: {
      observedAt: input.observedAt,
      processedTicks,
      agents
    },
    correlationId: `agent-snapshot:${processedTicks}`
  };
}

export function emitAgentStateSnapshot(
  input: AgentStateSnapshotInput,
  handlers: AgentStateSnapshotPublishHandlers
): AgentStateSnapshotResult | null {
  const snapshot = buildAgentStateSnapshot(input);

  if (!snapshot) {
    return null;
  }

  handlers.publish("AGENT_STATE_SNAPSHOT", snapshot.payload, snapshot.correlationId);
  return snapshot;
}
