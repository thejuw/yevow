import type { EngineState, GlobalRiskConfig, ProfilerState, TradeIntent } from "../../../types";
import { calculateEnsembleState } from "./EnsembleRuntime";

export interface TradingEnsembleInput {
  readonly intent: TradeIntent | null;
  readonly profilerState: ProfilerState;
  readonly oracleState: EngineState["oracle"];
  readonly sentimentState: EngineState["sentiment"];
  readonly anomalyStatus: EngineState["anomaly"];
  readonly config: GlobalRiskConfig;
  readonly observedAt: string;
}

export function calculateTradingEnsembleState(
  input: TradingEnsembleInput
): EngineState["ensemble"] {
  return calculateEnsembleState(input);
}
