import { touchAgentHealth } from "./AgentStateDefaults";
import type { EngineState, GlobalRiskConfig } from "../../../types";

export interface TickAgentHealthInput {
  readonly previous: EngineState["agentHealth"];
  readonly config: Pick<
    GlobalRiskConfig,
    | "ORACLE_ENABLED"
    | "SENTIMENT_ENABLED"
    | "PROFILER_ENABLED"
    | "CROUPIER_ENABLED"
    | "PIT_BOSS_ENABLED"
    | "MARKET_MAKING_MODE"
  >;
  readonly observedAt: string;
  readonly oracleLatencyMs: number;
  readonly sentimentLatencyMs: number;
  readonly profilerToxicityScore: number;
  readonly profilerAlertThreshold: number;
  readonly profilerLatencyMs: number;
  readonly profilerSignalId?: string;
  readonly croupierLatencyMs: number;
  readonly croupierHasOutput: boolean;
  readonly croupierSignalId?: string;
  readonly pitBossIntentId?: string;
}

export function nextTickAgentHealth(input: TickAgentHealthInput): EngineState["agentHealth"] {
  let agentHealth = input.previous;
  agentHealth = touchAgentHealth(
    agentHealth,
    "ORACLE",
    input.config.ORACLE_ENABLED ? "GREEN" : "DISABLED",
    input.observedAt,
    input.oracleLatencyMs
  );
  agentHealth = touchAgentHealth(
    agentHealth,
    "SENTIMENT",
    input.config.SENTIMENT_ENABLED ? "GREEN" : "DISABLED",
    input.observedAt,
    input.config.SENTIMENT_ENABLED ? input.sentimentLatencyMs : 0
  );
  agentHealth = touchAgentHealth(
    agentHealth,
    "PROFILER",
    input.config.PROFILER_ENABLED
      ? input.profilerToxicityScore > input.profilerAlertThreshold
        ? "YELLOW"
        : "GREEN"
      : "DISABLED",
    input.observedAt,
    input.profilerLatencyMs,
    input.profilerSignalId
  );
  agentHealth = touchAgentHealth(
    agentHealth,
    "CROUPIER",
    input.config.CROUPIER_ENABLED && input.config.MARKET_MAKING_MODE !== "OFF"
      ? input.croupierHasOutput
        ? "GREEN"
        : "YELLOW"
      : "DISABLED",
    input.observedAt,
    input.croupierLatencyMs,
    input.croupierSignalId
  );
  agentHealth = touchAgentHealth(
    agentHealth,
    "PIT_BOSS",
    input.config.PIT_BOSS_ENABLED ? (input.pitBossIntentId ? "GREEN" : "YELLOW") : "DISABLED",
    input.observedAt,
    0,
    input.pitBossIntentId
  );

  return agentHealth;
}
