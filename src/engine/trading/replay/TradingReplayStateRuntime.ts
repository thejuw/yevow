import {
  DEFAULT_MAX_INVENTORY_UNITS,
  DEFAULT_MAX_POSITION_PCT
} from "../../../TradingEngineConstants";
import {
  applyShadowReplayPreparation,
  type PreparedShadowReplayState
} from "./ReplayPreparationRuntime";
import {
  captureEngineReplaySnapshot,
  restoreReplaySnapshotSideEffects,
  type CaptureEngineReplaySnapshotInput,
  type EngineReplaySnapshot,
  type HydratedReplayOrderBooks,
  type ReplaySnapshotRestoreHandlers
} from "./ReplaySnapshotRuntime";
import type {
  AgentName,
  AgentSignal,
  EngineState,
  GlobalRiskConfig,
  LatencyMetrics,
  LiquidityWall
} from "../../../types";
import type { RateLimitBucketSnapshot } from "../../../utils/RateLimiter";
import type { BookSyncState } from "../book/BookTypes";
import type { SortedBookSide } from "../book/SortedBookSide";

export type { EngineReplaySnapshot } from "./ReplaySnapshotRuntime";

export interface TradingReplaySnapshotTarget {
  engineState: EngineState;
  orderBook: HydratedReplayOrderBooks["snapshots"];
  bids: Map<string, SortedBookSide>;
  asks: Map<string, SortedBookSide>;
  bookSync: Map<string, BookSyncState>;
  latencyHistory: LatencyMetrics[];
  processingLatencySamples: number[];
  domWallHistory: LiquidityWall[];
  leadLagSamples: Map<string, { price: number; observedAt: string }[]>;
  cachedConfig: GlobalRiskConfig;
  maxLatencyMs: number;
  lastTickTimestamp: string | null;
  signals: AgentSignal[];
  latestAgentSignals: Map<AgentName, AgentSignal>;
  profilerRegistry: {
    hydrate(
      legacyState: EngineReplaySnapshot["profilerState"],
      states: Map<string, EngineReplaySnapshot["profilerState"]>
    ): void;
  };
  anomalyDetector: { hydrate(state: EngineReplaySnapshot["anomalyState"]): void };
  oracleAgent: { hydrate(state: EngineReplaySnapshot["oracleState"]): void };
  sentimentAgent: { hydrate(state: EngineReplaySnapshot["sentimentState"]): void };
  rateLimiter: { hydrate(snapshot: Record<string, RateLimitBucketSnapshot>): void };
  rebindOrderBookReconstructor(): void;
}

export interface TradingShadowReplayStateInput {
  readonly currentConfig: GlobalRiskConfig;
  readonly liveState: EngineState;
  readonly initialShadowBankroll: number;
  readonly startedAt: string;
  readonly replayId: string;
}

export interface TradingShadowReplayStateHandlers {
  readonly clearMarketState: () => void;
  readonly resetRuntimeSamples: () => void;
  readonly applyPreparedState: (preparedState: PreparedShadowReplayState) => void;
  readonly resetAgents: () => void;
}

export function prepareTradingShadowReplayState(
  input: TradingShadowReplayStateInput,
  handlers: TradingShadowReplayStateHandlers
): void {
  applyShadowReplayPreparation(
    {
      currentConfig: input.currentConfig,
      liveState: input.liveState,
      initialShadowBankroll: input.initialShadowBankroll,
      defaultMaxPositionPct: DEFAULT_MAX_POSITION_PCT,
      defaultMaxInventoryUnits: DEFAULT_MAX_INVENTORY_UNITS,
      startedAt: input.startedAt,
      replayId: input.replayId
    },
    handlers
  );
}

export function captureTradingReplaySnapshot(
  input: CaptureEngineReplaySnapshotInput
): EngineReplaySnapshot {
  return captureEngineReplaySnapshot(input);
}

export function restoreTradingReplaySnapshot(
  snapshot: EngineReplaySnapshot,
  handlers: ReplaySnapshotRestoreHandlers
): Promise<void> {
  return restoreReplaySnapshotSideEffects(snapshot, handlers);
}

export function applyTradingReplaySnapshotToTarget(
  target: TradingReplaySnapshotTarget,
  replaySnapshot: EngineReplaySnapshot,
  hydratedBooks: HydratedReplayOrderBooks
): void {
  target.engineState = replaySnapshot.engineState;
  target.orderBook = hydratedBooks.snapshots;
  target.bids = hydratedBooks.bids;
  target.asks = hydratedBooks.asks;
  target.bookSync = hydratedBooks.sync;
  target.rebindOrderBookReconstructor();
  target.latencyHistory = replaySnapshot.latencyHistory;
  target.processingLatencySamples = replaySnapshot.processingLatencySamples;
  target.domWallHistory = replaySnapshot.domWallHistory;
  target.leadLagSamples = new Map(replaySnapshot.leadLagSamples);
  target.cachedConfig = replaySnapshot.cachedConfig;
  target.maxLatencyMs = replaySnapshot.maxLatencyMs;
  target.lastTickTimestamp = replaySnapshot.lastTickTimestamp;
  target.signals = replaySnapshot.signals;
  target.latestAgentSignals = new Map(replaySnapshot.latestAgentSignals);
  target.profilerRegistry.hydrate(
    replaySnapshot.profilerState,
    new Map(replaySnapshot.profilerStates)
  );
  target.anomalyDetector.hydrate(replaySnapshot.anomalyState);
  target.oracleAgent.hydrate(replaySnapshot.oracleState);
  target.sentimentAgent.hydrate(replaySnapshot.sentimentState);
  target.rateLimiter.hydrate(replaySnapshot.rateLimits);
}
