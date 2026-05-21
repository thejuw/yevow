import { AGENT_SNAPSHOT_TICK_INTERVAL } from "../../../TradingEngineConstants";
import type { AgentName, AgentSignal, EngineState } from "../../../types";
import { emitAgentStateSnapshot } from "./AgentSnapshotRuntime";

export interface TradingAgentSnapshotInput {
  readonly engineState: EngineState;
  readonly latestAgentSignals: ReadonlyMap<AgentName, AgentSignal>;
  readonly observedAt: string;
}

export interface TradingAgentSnapshotHandlers {
  readonly publish: (
    type: "AGENT_STATE_SNAPSHOT",
    payload: Record<string, unknown>,
    correlationId: string
  ) => void;
}

export function maybePublishTradingAgentSnapshot(
  input: TradingAgentSnapshotInput,
  handlers: TradingAgentSnapshotHandlers
): void {
  emitAgentStateSnapshot(
    {
      engineState: input.engineState,
      latestAgentSignals: input.latestAgentSignals,
      observedAt: input.observedAt,
      snapshotIntervalTicks: AGENT_SNAPSHOT_TICK_INTERVAL
    },
    handlers
  );
}
