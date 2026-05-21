import type { OracleAgent } from "../../../agents/OracleAgent";
import type { EngineState, GlobalRiskConfig, InternalOrderBook, MarketTick } from "../../../types";
import {
  evaluateOracleRuntime,
  type OracleRuntimeEvaluationResult
} from "./AgentEvaluationRuntime";

export interface TradingOracleEvaluationInput {
  readonly oracleAgent: OracleAgent;
  readonly config: GlobalRiskConfig;
  readonly oracle: EngineState["oracle"];
  readonly tick: MarketTick;
  readonly book: InternalOrderBook;
  readonly observedAt: string;
}

export function evaluateTradingOracle(
  input: TradingOracleEvaluationInput
): OracleRuntimeEvaluationResult {
  return evaluateOracleRuntime({
    oracleEnabled: input.config.ORACLE_ENABLED,
    agent: input.oracleAgent,
    oracle: input.oracle,
    tick: input.tick,
    book: input.book,
    observedAt: input.observedAt,
    config: input.config
  });
}
