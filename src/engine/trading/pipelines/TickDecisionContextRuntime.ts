import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import { defaultSentimentState } from "../../../agents/SentimentAgent";
import type { EngineState } from "../../../types";
import { passiveInventoryGuardStateFromInventory } from "../state/EngineStateDefaults";
import type { AcceptedDecisionPipelineInput, TickDecisionContext } from "./TickPipelineTypes";

export interface TickDecisionContextFlowInput {
  readonly tick: AcceptedDecisionPipelineInput["tick"];
  readonly oracle: EngineState["oracle"];
  readonly profilerResult: ProfilerEvaluation;
  readonly observedAt: string;
  readonly currentState: EngineState;
  readonly sentimentEnabled: boolean;
}

export interface TickDecisionContextFlowHandlers {
  readonly calculateInventoryState: (observedAt: string) => TickDecisionContext["inventory"];
  readonly updatePortfolioRisk: (
    oracle: EngineState["oracle"],
    observedAt: string
  ) => TickDecisionContext["riskMetrics"];
  readonly profilerSnapshot: (
    instrumentCode: string,
    profilerState: ProfilerEvaluation["state"]
  ) => TickDecisionContext["profilerStates"];
  readonly calculateAssetMatrix: (
    observedAt: string,
    instrumentCode: string,
    oracle: EngineState["oracle"],
    profilerStates: TickDecisionContext["profilerStates"]
  ) => TickDecisionContext["assetMatrix"];
}

export function buildTickDecisionContextFlow(
  input: TickDecisionContextFlowInput,
  handlers: TickDecisionContextFlowHandlers
): TickDecisionContext {
  const leadLag = input.currentState.leadLag;
  const inventory = handlers.calculateInventoryState(input.observedAt);
  const riskMetrics = handlers.updatePortfolioRisk(input.oracle, input.observedAt);
  const profilerStates = handlers.profilerSnapshot(
    input.tick.instrumentCode,
    input.profilerResult.state
  );
  const assetMatrix = handlers.calculateAssetMatrix(
    input.observedAt,
    input.tick.instrumentCode,
    input.oracle,
    profilerStates
  );
  const inventoryGuard = passiveInventoryGuardStateFromInventory(inventory, input.observedAt);
  const sentimentForDecision = input.sentimentEnabled
    ? input.currentState.sentiment
    : {
        ...defaultSentimentState(),
        updatedAt: input.observedAt
      };

  return {
    leadLag,
    inventory,
    riskMetrics,
    profilerStates,
    assetMatrix,
    inventoryGuard,
    sentimentForDecision
  };
}
