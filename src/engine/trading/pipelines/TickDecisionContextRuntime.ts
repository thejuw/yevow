import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import { defaultSentimentState } from "../../../agents/SentimentAgent";
import type { EngineState, GlobalRiskConfig } from "../../../types";
import { passiveInventoryGuardStateFromInventory } from "../state/EngineStateDefaults";
import {
  calculateTradingInventoryStateForTarget,
  type TradingInventoryStateTarget
} from "../inventory/TradingInventoryStateRuntime";
import {
  updateTradingPortfolioRiskForTarget,
  type TradingPortfolioRiskTarget
} from "../risk/TradingPortfolioRiskRuntime";
import {
  calculateTradingAssetMatrixForTarget,
  type TradingAssetMatrixTarget
} from "../state/TradingAssetMatrixRuntime";
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

export interface TickDecisionContextTarget extends TradingAssetMatrixTarget {
  readonly engineState: EngineState;
  readonly cachedConfig: GlobalRiskConfig;
  readonly profilerRegistry: TradingAssetMatrixTarget["profilerRegistry"] & {
    snapshot(
      instrumentCode: string,
      profilerState: ProfilerEvaluation["state"]
    ): TickDecisionContext["profilerStates"];
  };
  calculateInventoryState?(observedAt: string): TickDecisionContext["inventory"];
  updatePortfolioRisk?(
    oracle: EngineState["oracle"],
    observedAt: string
  ): TickDecisionContext["riskMetrics"];
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

export function buildTickDecisionContextForTarget(
  tick: AcceptedDecisionPipelineInput["tick"],
  oracle: EngineState["oracle"],
  profilerResult: ProfilerEvaluation,
  observedAt: string,
  target: TickDecisionContextTarget
): TickDecisionContext {
  return buildTickDecisionContextFlow(
    {
      tick,
      oracle,
      profilerResult,
      observedAt,
      currentState: target.engineState,
      sentimentEnabled: target.cachedConfig.SENTIMENT_ENABLED
    },
    {
      calculateInventoryState: (decisionObservedAt) =>
        target.calculateInventoryState
          ? target.calculateInventoryState(decisionObservedAt)
          : calculateTradingInventoryStateForTarget(
              { observedAt: decisionObservedAt },
              target as unknown as TradingInventoryStateTarget
            ),
      updatePortfolioRisk: (currentOracle, decisionObservedAt) =>
        target.updatePortfolioRisk
          ? target.updatePortfolioRisk(currentOracle, decisionObservedAt)
          : updateTradingPortfolioRiskForTarget(
              { oracle: currentOracle, observedAt: decisionObservedAt },
              target as unknown as TradingPortfolioRiskTarget
            ),
      profilerSnapshot: (instrumentCode, profilerState) =>
        target.profilerRegistry.snapshot(instrumentCode, profilerState),
      calculateAssetMatrix: (matrixObservedAt, _instrumentCode, currentOracle, profilerStates) =>
        calculateTradingAssetMatrixForTarget(
          {
            observedAt: matrixObservedAt,
            latestOracle: currentOracle,
            profilerStates
          },
          target
        )
    }
  );
}
