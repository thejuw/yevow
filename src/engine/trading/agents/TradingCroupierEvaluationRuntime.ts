import type { CroupierAgent } from "../../../agents/CroupierAgent";
import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import type { AdverseSelectionModel } from "../../AdverseSelectionModel";
import type { MultiScaleVolatilitySnapshot } from "../../MultiScaleVolatility";
import type {
  EngineState,
  Env,
  GlobalRiskConfig,
  InternalOrderBook,
  InventoryState,
  MacroBias,
  SentimentState
} from "../../../types";
import { currentFundingRate } from "../funding/FundingRuntime";
import { disabledCroupierDecision } from "../state/AgentStateDefaults";
import {
  evaluateCroupierRuntime,
  type CroupierRuntimeEvaluationResult
} from "./AgentEvaluationRuntime";

export interface TradingCroupierEvaluationInput {
  readonly croupierAgent: CroupierAgent;
  readonly adverseSelectionModel: AdverseSelectionModel;
  readonly engineState: Pick<
    EngineState,
    "engineId" | "slippage" | "fundingRates" | "liquidationHeatmap"
  >;
  readonly config: GlobalRiskConfig;
  readonly env: Env;
  readonly book: InternalOrderBook;
  readonly oracle: EngineState["oracle"];
  readonly sentiment: SentimentState;
  readonly profilerResult: ProfilerEvaluation;
  readonly inventory: InventoryState;
  readonly leadLag: EngineState["leadLag"];
  readonly volatilitySnapshot: MultiScaleVolatilitySnapshot | null;
  readonly macroBias: MacroBias;
  readonly observedAt: string;
}

export interface TradingCroupierEvaluationTarget {
  readonly croupierAgent: CroupierAgent;
  readonly adverseSelectionModel: AdverseSelectionModel;
  readonly engineState: TradingCroupierEvaluationInput["engineState"];
  readonly cachedConfig: GlobalRiskConfig;
  readonly env: Env;
  readonly macroBias: MacroBias;
}

export function evaluateTradingCroupier(
  input: TradingCroupierEvaluationInput
): CroupierRuntimeEvaluationResult {
  return evaluateCroupierRuntime({
    croupierEnabled: input.config.CROUPIER_ENABLED,
    evaluator: input.croupierAgent,
    disabledDecision: disabledCroupierDecision(input.config.MIN_EV_THRESHOLD),
    adverseSelectionModel: input.adverseSelectionModel,
    engineId: input.engineState.engineId,
    book: input.book,
    oracle: input.oracle,
    sentiment: input.sentiment,
    toxicityScore: input.profilerResult.toxicityScore,
    inventory: input.inventory,
    leadLag: input.leadLag,
    config: input.config,
    env: input.env,
    executionCostBufferBps: input.engineState.slippage.executionCostBufferBps,
    multiScaleVolatility: input.volatilitySnapshot,
    fundingRateHourly: currentFundingRate(input.engineState.fundingRates, input.book),
    liquidationHeatmap: input.engineState.liquidationHeatmap,
    profilerToxicityState: input.profilerResult.state.toxicityState,
    profilerPressureSide: input.profilerResult.state.pressureSide,
    profilerSpreadMultiplier: input.profilerResult.state.spreadMultiplier,
    profilerReservationShiftBps: input.profilerResult.state.reservationShiftBps,
    sentimentAlphaMode: input.config.SENTIMENT_ALPHA_MODE,
    macroBias: input.macroBias,
    observedAt: input.observedAt
  });
}

export function evaluateTradingCroupierForTarget(
  input: Omit<
    TradingCroupierEvaluationInput,
    "croupierAgent" | "adverseSelectionModel" | "engineState" | "config" | "env" | "macroBias"
  >,
  target: TradingCroupierEvaluationTarget
): CroupierRuntimeEvaluationResult {
  return evaluateTradingCroupier({
    croupierAgent: target.croupierAgent,
    adverseSelectionModel: target.adverseSelectionModel,
    engineState: target.engineState,
    config: target.cachedConfig,
    env: target.env,
    macroBias: target.macroBias,
    ...input
  });
}
