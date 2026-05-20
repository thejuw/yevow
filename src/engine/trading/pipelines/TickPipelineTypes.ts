import type { AnomalyDetectionResult } from "../../../agents/AnomalyDetector";
import type { CroupierDecision } from "../../../agents/CroupierAgent";
import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import type { MultiScaleVolatilitySnapshot } from "../../MultiScaleVolatility";
import type { ApprovedExecutionPlan } from "../execution/ExecutionPlanRuntime";
import type { ShadowReplayLoopResult } from "../replay/ReplayLoopRuntime";
import type { EngineReplaySnapshot } from "../replay/ReplaySnapshotRuntime";
import type { ReplayOptions, ReplayScenario } from "../routes/ReplayAdminRoutes";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type {
  BayesianUpdateTrace,
  DomAnalysisSnapshot,
  EngineState,
  InternalOrderBook,
  InventoryState,
  LatencyMetrics,
  MarketTick,
  ReplayResult,
  SentimentState,
  ShadowQueueState
} from "../../../types";
import type { ReplayTradeRow } from "../replay/ReplayJournal";

export interface TickHandlingOptions {
  shadowReplay?: boolean;
}

export type TickBookResolution =
  | {
      kind: "BOOK";
      book: InternalOrderBook;
      orderBookUpdateMs: number;
    }
  | {
      kind: "EARLY_RETURN";
      result: TickIngestResult;
    };

export interface AcceptedTickStateCommitInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly book: InternalOrderBook;
  readonly oracle: EngineState["oracle"];
  readonly sentiment: SentimentState;
  readonly ensemble: EngineState["ensemble"];
  readonly leadLag: EngineState["leadLag"];
  readonly inventory: InventoryState;
  readonly riskMetrics: EngineState["riskMetrics"];
  readonly assetQuoteState: EngineState["quoteState"];
  readonly shadowQueueState: ShadowQueueState;
  readonly executionPlan: ApprovedExecutionPlan | null;
  readonly croupierDecision: CroupierDecision;
  readonly executionPlans: readonly ApprovedExecutionPlan[];
  readonly inventoryGuard: EngineState["inventoryGuard"];
  readonly domSnapshot: DomAnalysisSnapshot;
  readonly anomalyResult: AnomalyDetectionResult;
  readonly profilerStates: EngineState["profilerStates"];
  readonly profilerResult: ProfilerEvaluation;
  readonly oracleLatencyMs: number;
  readonly profilerLatencyMs: number;
  readonly croupierLatencyMs: number;
  readonly shadowReplay: boolean;
  readonly observedAt: string;
}

export interface PostBookTickContext {
  readonly volatilitySnapshot: MultiScaleVolatilitySnapshot | null;
  readonly shadowQueueState: ShadowQueueState;
  readonly domSnapshot: DomAnalysisSnapshot;
}

export interface TickDecisionContext {
  readonly leadLag: EngineState["leadLag"];
  readonly inventory: InventoryState;
  readonly riskMetrics: EngineState["riskMetrics"];
  readonly profilerStates: EngineState["profilerStates"];
  readonly assetMatrix: EngineState["assetMatrix"];
  readonly inventoryGuard: EngineState["inventoryGuard"];
  readonly sentimentForDecision: SentimentState;
}

export interface QuotePolicyResult {
  readonly executionPlans: ApprovedExecutionPlan[];
  readonly assetQuoteState: EngineState["quoteState"];
  readonly strategyQuoteDisableReason: string | null;
  readonly isCascadeShield: boolean;
  readonly isProfilerQuoteHalt: boolean;
}

export interface AcceptedExecutionContext {
  readonly ensemble: EngineState["ensemble"];
  readonly executionPlan: ApprovedExecutionPlan | null;
  readonly executionPlans: ApprovedExecutionPlan[];
  readonly quotePolicy: QuotePolicyResult;
}

export interface AcceptedTickSideEffectsInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly book: InternalOrderBook;
  readonly anomalyResult: AnomalyDetectionResult;
  readonly profilerResult: ProfilerEvaluation;
  readonly profilerLatencyMs: number;
  readonly croupierDecision: CroupierDecision;
  readonly executionPlans: readonly ApprovedExecutionPlan[];
  readonly inventory: InventoryState;
  readonly strategyQuoteDisableReason: string | null;
  readonly isCascadeShield: boolean;
  readonly isProfilerQuoteHalt: boolean;
  readonly oracleBayesianTrace: BayesianUpdateTrace | null;
  readonly hotPathStartedAt: number;
  readonly shadowReplay: boolean;
}

export interface AcceptedDecisionPipelineInput {
  readonly tick: MarketTick;
  readonly book: InternalOrderBook;
  readonly domSnapshot: DomAnalysisSnapshot;
  readonly volatilitySnapshot: MultiScaleVolatilitySnapshot | null;
  readonly shadowQueueState: ShadowQueueState;
  readonly anomalyResult: AnomalyDetectionResult;
  readonly metrics: LatencyMetrics;
  readonly wakeUpTimeMs: number | null;
  readonly orderBookUpdateMs: number;
  readonly hotPathStartedAt: number;
  readonly shadowReplay: boolean;
}

export interface HistoricalReplayCompletionInput {
  readonly replayId: string;
  readonly replayLoop: ShadowReplayLoopResult;
  readonly initialShadowBankroll: number;
  readonly historicalTradeCount: number;
  readonly shadowTrades: ReplayResult["shadowTrades"];
  readonly speedMultiplier: number;
  readonly replayOptions: ReplayOptions;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly startedAt: string;
  readonly ticksLength: number;
}

export interface HistoricalReplayStatusInput {
  readonly replayId: string;
  readonly ticksTotal: number;
  readonly shadowBankroll: number;
  readonly speedMultiplier: number;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly scenario: ReplayScenario;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface LoadedReplayTicks {
  readonly sourceTicks: MarketTick[];
  readonly ticks: MarketTick[];
}

export interface LoadedReplayShadowTrades {
  readonly historicalTrades: ReplayTradeRow[];
  readonly shadowTrades: ReplayResult["shadowTrades"];
}

export interface ShadowReplayWithRestoreInput {
  readonly replayId: string;
  readonly ticks: MarketTick[];
  readonly replayOptions: ReplayOptions;
  readonly speedMultiplier: number;
  readonly initialShadowBankroll: number;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  readonly startedAt: string;
  readonly liveSnapshot: EngineReplaySnapshot;
}
