import type { CroupierDecision, CroupierInput } from "../../../agents/CroupierAgent";
import type { ProfilerContext, ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import { disabledProfilerEvaluation } from "../state/AgentStateDefaults";
import type { AdverseSelectionModel } from "../../AdverseSelectionModel";
import { adversePenaltyForQuoteSide } from "../../AdverseSelectionModel";
import type {
  BayesianUpdateTrace,
  GlobalRiskConfig,
  InternalOrderBook,
  InventoryState,
  LeadLagMetrics,
  LiquidationHeatmapState,
  MacroBias,
  MarketTick,
  OracleState,
  SentimentAlphaMode,
  ProfilerState,
  SentimentState,
  ToxicityPressureSide,
  ToxicityState
} from "../../../types";
import {
  DEFAULT_FUNDING_BIAS_THRESHOLD,
  DEFAULT_FUNDING_INVENTORY_BIAS,
  DEFAULT_PREDATORY_ORDER_OFFSET_BPS
} from "../../../TradingEngineConstants";
import { readPositiveNumber } from "../helpers/RuntimeParsing";
import { highResolutionNow, roundLatency } from "../helpers/RuntimeClock";
import type { DomAnalysisSnapshot } from "../../../types";
import type { MultiScaleVolatilitySnapshot } from "../../MultiScaleVolatility";

export interface ProfilerContextInput {
  readonly engineId: string;
  readonly observedAt: string;
  readonly book: InternalOrderBook;
  readonly dom: DomAnalysisSnapshot;
  readonly liquidationHeatmap: LiquidationHeatmapState | null;
  readonly jumpDetected: boolean;
}

export interface OracleTickInput {
  readonly tick: MarketTick;
  readonly book: InternalOrderBook;
  readonly observedAt: string;
  readonly config: {
    readonly ORACLE_GOVERNANCE_MODE: GlobalRiskConfig["ORACLE_GOVERNANCE_MODE"];
    readonly ORACLE_MANUAL_SKEPTICISM: number;
    readonly ORACLE_MAX_SKEPTICISM: number;
  };
}

export interface OracleTickResult {
  readonly state: OracleState;
  readonly bayesianTrace: BayesianUpdateTrace | null;
  readonly regimeChanged: boolean;
}

export interface ProfilerRuntimeAgent {
  processTick(tick: MarketTick, context: ProfilerContext): ProfilerEvaluation;
  snapshot(): ProfilerState;
}

export interface ProfilerRuntimeEvaluationInput {
  readonly profilerEnabled: boolean;
  readonly agent: ProfilerRuntimeAgent;
  readonly tick: MarketTick;
  readonly context: ProfilerContextInput;
}

export interface ProfilerRuntimeEvaluationResult {
  readonly profilerResult: ProfilerEvaluation;
  readonly profilerLatencyMs: number;
}

export interface OracleRuntimeAgent {
  processTick(input: OracleTickInput): OracleTickResult;
}

export interface OracleRuntimeEvaluationInput {
  readonly oracleEnabled: boolean;
  readonly agent: OracleRuntimeAgent;
  readonly oracle: OracleState;
  readonly tick: MarketTick;
  readonly book: InternalOrderBook;
  readonly observedAt: string;
  readonly config: GlobalRiskConfig;
}

export interface OracleRuntimeEvaluationResult {
  readonly oracleResult: OracleTickResult;
  readonly oracleLatencyMs: number;
}

export interface CroupierEvaluationInputParams {
  readonly engineId: string;
  readonly book: InternalOrderBook;
  readonly oracle: OracleState;
  readonly sentiment: SentimentState;
  readonly toxicityScore: number;
  readonly inventory: InventoryState;
  readonly leadLag: LeadLagMetrics;
  readonly config: GlobalRiskConfig;
  readonly env: CroupierEvaluationEnv;
  readonly executionCostBufferBps: number;
  readonly bidAdversePenaltyBps: number;
  readonly askAdversePenaltyBps: number;
  readonly multiScaleVolatility: MultiScaleVolatilitySnapshot | null;
  readonly fundingRateHourly: number;
  readonly liquidationHeatmap: LiquidationHeatmapState | null;
  readonly profilerToxicityState: ToxicityState;
  readonly profilerPressureSide: ToxicityPressureSide;
  readonly profilerSpreadMultiplier: number;
  readonly profilerReservationShiftBps: number;
  readonly sentimentAlphaMode: SentimentAlphaMode;
  readonly macroBias: MacroBias;
  readonly observedAt: string;
}

export interface CroupierEvaluationEnv {
  readonly FUNDING_HORIZON_HOURS?: string;
  readonly FUNDING_BIAS_THRESHOLD?: string;
  readonly FUNDING_INVENTORY_BIAS?: string;
  readonly HL_PREDATORY_ORDER_OFFSET_BPS?: string;
}

export interface CroupierRuntimeEvaluator {
  evaluate(input: CroupierInput): CroupierDecision;
}

export interface CroupierRuntimeEvaluationInput extends Omit<
  CroupierEvaluationInputParams,
  "bidAdversePenaltyBps" | "askAdversePenaltyBps"
> {
  readonly croupierEnabled: boolean;
  readonly evaluator: CroupierRuntimeEvaluator;
  readonly disabledDecision: CroupierDecision;
  readonly adverseSelectionModel: AdverseSelectionModel;
}

export interface CroupierRuntimeEvaluationResult {
  readonly croupierDecision: CroupierDecision;
  readonly croupierLatencyMs: number;
}

export function buildProfilerContext(input: ProfilerContextInput): ProfilerContext {
  return {
    engineId: input.engineId,
    observedAt: input.observedAt,
    midPrice: input.book.midPrice,
    spreadBps: input.book.spreadBps,
    weightedImbalance: input.book.weightedImbalance,
    orderBookBids: input.book.bids,
    orderBookAsks: input.book.asks,
    liquidityWalls: input.dom.walls,
    spoofingAlerts: input.dom.pulledWalls,
    liquidationHeatmap: input.liquidationHeatmap,
    jumpDetected: input.jumpDetected
  };
}

export function buildOracleTickInput(input: {
  readonly tick: MarketTick;
  readonly book: InternalOrderBook;
  readonly observedAt: string;
  readonly config: GlobalRiskConfig;
}): OracleTickInput {
  return {
    tick: input.tick,
    book: input.book,
    observedAt: input.observedAt,
    config: {
      ORACLE_GOVERNANCE_MODE: input.config.ORACLE_GOVERNANCE_MODE,
      ORACLE_MANUAL_SKEPTICISM: input.config.ORACLE_MANUAL_SKEPTICISM,
      ORACLE_MAX_SKEPTICISM: input.config.ORACLE_MAX_SKEPTICISM
    }
  };
}

export function disabledOracleTickResult(
  oracle: OracleState,
  observedAt: string
): OracleTickResult {
  return {
    state: {
      ...oracle,
      updatedAt: observedAt
    },
    bayesianTrace: null,
    regimeChanged: false
  };
}

export function evaluateProfilerRuntime(
  input: ProfilerRuntimeEvaluationInput
): ProfilerRuntimeEvaluationResult {
  const profilerStartedAt = highResolutionNow();
  const profilerResult = input.profilerEnabled
    ? input.agent.processTick(input.tick, buildProfilerContext(input.context))
    : disabledProfilerEvaluation(input.agent.snapshot(), input.context.observedAt);

  return {
    profilerResult,
    profilerLatencyMs: input.profilerEnabled
      ? roundLatency(highResolutionNow() - profilerStartedAt)
      : 0
  };
}

export function evaluateOracleRuntime(
  input: OracleRuntimeEvaluationInput
): OracleRuntimeEvaluationResult {
  const oracleStartedAt = highResolutionNow();
  const oracleResult = input.oracleEnabled
    ? input.agent.processTick(
        buildOracleTickInput({
          tick: input.tick,
          book: input.book,
          observedAt: input.observedAt,
          config: input.config
        })
      )
    : disabledOracleTickResult(input.oracle, input.observedAt);

  return {
    oracleResult,
    oracleLatencyMs: input.oracleEnabled ? roundLatency(highResolutionNow() - oracleStartedAt) : 0
  };
}

export function buildCroupierEvaluationInput(input: CroupierEvaluationInputParams): CroupierInput {
  const config = input.config;

  return {
    engineId: input.engineId,
    book: input.book,
    oracle: input.oracle,
    sentiment: input.sentiment,
    toxicityScore: input.toxicityScore,
    inventory: input.inventory,
    leadLag: input.leadLag,
    minEvThreshold: config.MIN_EV_THRESHOLD,
    exchangeFeeBps: config.EXCHANGE_FEE_BPS,
    executionCostBufferBps: input.executionCostBufferBps,
    adverseSelectionPenaltyBps: Math.max(input.bidAdversePenaltyBps, input.askAdversePenaltyBps),
    multiScaleVolatility: input.multiScaleVolatility,
    fundingRateHourly: input.fundingRateHourly,
    fundingHorizonHours: readPositiveNumber(input.env.FUNDING_HORIZON_HOURS, 1),
    riskAversionFactor: config.RISK_AVERSION_FACTOR,
    fundingBiasThreshold:
      config.FUNDING_BIAS_THRESHOLD > 0
        ? config.FUNDING_BIAS_THRESHOLD
        : readPositiveNumber(input.env.FUNDING_BIAS_THRESHOLD, DEFAULT_FUNDING_BIAS_THRESHOLD),
    fundingInventoryBias:
      config.FUNDING_INVENTORY_BIAS > 0
        ? config.FUNDING_INVENTORY_BIAS
        : readPositiveNumber(input.env.FUNDING_INVENTORY_BIAS, DEFAULT_FUNDING_INVENTORY_BIAS),
    fundingPreSettlementWindowMs: config.FUNDING_PRE_SETTLEMENT_WINDOW_MS,
    fundingPreSettlementBiasMultiplier: config.FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER,
    liquidationHeatmap: input.liquidationHeatmap,
    predatoryOrderOffsetBps: readPositiveNumber(
      input.env.HL_PREDATORY_ORDER_OFFSET_BPS,
      DEFAULT_PREDATORY_ORDER_OFFSET_BPS
    ),
    profilerToxicityState: input.profilerToxicityState,
    profilerPressureSide: input.profilerPressureSide,
    profilerSpreadMultiplier: input.profilerSpreadMultiplier,
    profilerReservationShiftBps: input.profilerReservationShiftBps,
    layeredQuoteLevels: config.LAYERED_QUOTE_LEVELS,
    layeredQuoteSizeDecay: config.LAYERED_QUOTE_SIZE_DECAY,
    layeredQuoteSpreadStepBps: config.LAYERED_QUOTE_SPREAD_STEP_BPS,
    sentimentAlphaMode: input.sentimentAlphaMode,
    macroBias: input.macroBias,
    marketMakingMode: config.MARKET_MAKING_MODE,
    observedAt: input.observedAt
  };
}

export function evaluateCroupierRuntime(
  input: CroupierRuntimeEvaluationInput
): CroupierRuntimeEvaluationResult {
  const croupierStartedAt = highResolutionNow();
  const bidAdversePenalty = adversePenaltyForQuoteSide(
    input.adverseSelectionModel,
    input.book,
    "BID",
    input.oracle.regime,
    input.observedAt
  );
  const askAdversePenalty = adversePenaltyForQuoteSide(
    input.adverseSelectionModel,
    input.book,
    "ASK",
    input.oracle.regime,
    input.observedAt
  );
  const croupierDecision = input.croupierEnabled
    ? input.evaluator.evaluate(
        buildCroupierEvaluationInput({
          ...input,
          bidAdversePenaltyBps: bidAdversePenalty.penaltyBps,
          askAdversePenaltyBps: askAdversePenalty.penaltyBps
        })
      )
    : input.disabledDecision;

  return {
    croupierDecision,
    croupierLatencyMs: input.croupierEnabled
      ? roundLatency(highResolutionNow() - croupierStartedAt)
      : 0
  };
}
