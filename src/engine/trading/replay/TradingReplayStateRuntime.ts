import {
  DEFAULT_MAX_INVENTORY_UNITS,
  DEFAULT_MAX_POSITION_PCT,
  ORDER_BOOK_PREFIX
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
  InternalOrderBook,
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
  anomalyDetector: { hydrate(state: EngineReplaySnapshot["anomalyState"] | null): void };
  oracleAgent: { hydrate(state: EngineReplaySnapshot["oracleState"] | null): void };
  sentimentAgent: { hydrate(state: EngineReplaySnapshot["sentimentState"] | null): void };
  rateLimiter: { hydrate(snapshot: Record<string, RateLimitBucketSnapshot>): void };
  rebindOrderBookReconstructor(): void;
}

export interface TradingReplaySnapshotSource {
  readonly engineState: EngineState;
  readonly orderBook: HydratedReplayOrderBooks["snapshots"];
  readonly latencyHistory: readonly LatencyMetrics[];
  readonly processingLatencySamples: readonly number[];
  readonly domWallHistory: readonly LiquidityWall[];
  readonly leadLagSamples: Map<string, { price: number; observedAt: string }[]>;
  readonly cachedConfig: GlobalRiskConfig;
  readonly maxLatencyMs: number;
  readonly lastTickTimestamp: string | null;
  readonly profilerAgent: { snapshot(): EngineReplaySnapshot["profilerState"] };
  readonly profilerRegistry: {
    entries(): Iterable<[string, { snapshot(): EngineReplaySnapshot["profilerState"] }]>;
  };
  readonly anomalyDetector: { snapshot(): EngineReplaySnapshot["anomalyState"] };
  readonly oracleAgent: { snapshot(): EngineReplaySnapshot["oracleState"] };
  readonly sentimentAgent: { snapshot(): EngineReplaySnapshot["sentimentState"] };
  readonly rateLimiter: { exportState(): Record<string, RateLimitBucketSnapshot> };
  readonly signals: readonly AgentSignal[];
  readonly latestAgentSignals: Map<AgentName, AgentSignal>;
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

export interface TradingShadowReplayStateTarget {
  cachedConfig: GlobalRiskConfig;
  engineState: EngineState;
  orderBook: HydratedReplayOrderBooks["snapshots"];
  bids: Map<string, SortedBookSide>;
  asks: Map<string, SortedBookSide>;
  bookSync: Map<string, BookSyncState>;
  latencyHistory: LatencyMetrics[];
  processingLatencySamples: number[];
  domWallHistory: LiquidityWall[];
  leadLagSamples: Map<string, { price: number; observedAt: string }[]>;
  profilerRegistry: {
    reset(): void;
  };
  anomalyDetector: { hydrate(state: EngineReplaySnapshot["anomalyState"] | null): void };
  oracleAgent: { hydrate(state: EngineReplaySnapshot["oracleState"] | null): void };
  sentimentAgent: { hydrate(state: EngineReplaySnapshot["sentimentState"] | null): void };
}

export interface TradingReplayRestoreTarget extends TradingReplaySnapshotTarget {
  readonly state: {
    readonly storage: {
      list<T>(options: { prefix: string }): Promise<Map<string, T>>;
    };
  };
  handleStorageWriteFailure(reason: string, error: unknown): void;
  safeStorageDelete(keys: string[], reason: string): Promise<void>;
  safeStoragePut(entries: Record<string, unknown>, reason: string): Promise<void>;
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

export function prepareTradingShadowReplayStateForTarget(
  input: Omit<TradingShadowReplayStateInput, "currentConfig" | "liveState">,
  target: TradingShadowReplayStateTarget
): void {
  prepareTradingShadowReplayState(
    {
      ...input,
      currentConfig: target.cachedConfig,
      liveState: target.engineState
    },
    {
      clearMarketState: () => {
        target.orderBook.clear();
        target.bids.clear();
        target.asks.clear();
        target.bookSync.clear();
      },
      resetRuntimeSamples: () => {
        target.latencyHistory = [];
        target.processingLatencySamples = [];
        target.domWallHistory = [];
        target.leadLagSamples = new Map();
      },
      applyPreparedState: (preparedState) => {
        target.cachedConfig = preparedState.cachedConfig;
        target.engineState = preparedState.engineState;
      },
      resetAgents: () => {
        target.profilerRegistry.reset();
        target.anomalyDetector.hydrate(null);
        target.oracleAgent.hydrate(null);
        target.sentimentAgent.hydrate(null);
      }
    }
  );
}

export function captureTradingReplaySnapshot(
  input: CaptureEngineReplaySnapshotInput
): EngineReplaySnapshot {
  return captureEngineReplaySnapshot(input);
}

export function captureTradingReplaySnapshotFromSource(
  source: TradingReplaySnapshotSource
): EngineReplaySnapshot {
  return captureTradingReplaySnapshot({
    engineState: source.engineState,
    orderBooks: source.orderBook.values(),
    latencyHistory: source.latencyHistory,
    processingLatencySamples: source.processingLatencySamples,
    domWallHistory: source.domWallHistory,
    leadLagSamples: source.leadLagSamples.entries(),
    cachedConfig: source.cachedConfig,
    maxLatencyMs: source.maxLatencyMs,
    lastTickTimestamp: source.lastTickTimestamp,
    profilerState: source.profilerAgent.snapshot(),
    profilerStates: [...source.profilerRegistry.entries()].map(([instrumentCode, agent]) => [
      instrumentCode,
      agent.snapshot()
    ]),
    anomalyState: source.anomalyDetector.snapshot(),
    oracleState: source.oracleAgent.snapshot(),
    sentimentState: source.sentimentAgent.snapshot(),
    rateLimits: source.rateLimiter.exportState(),
    signals: source.signals,
    latestAgentSignals: source.latestAgentSignals.entries()
  });
}

export function restoreTradingReplaySnapshot(
  snapshot: EngineReplaySnapshot,
  handlers: ReplaySnapshotRestoreHandlers
): Promise<void> {
  return restoreReplaySnapshotSideEffects(snapshot, handlers);
}

export function restoreTradingReplaySnapshotForTarget(
  snapshot: EngineReplaySnapshot,
  target: TradingReplayRestoreTarget
): Promise<void> {
  return restoreTradingReplaySnapshot(snapshot, {
    listPersistedBookKeys: async () =>
      (
        await target.state.storage.list<InternalOrderBook>({
          prefix: ORDER_BOOK_PREFIX
        })
      ).keys(),
    onListPersistedBookKeysFailure: (error) => {
      target.handleStorageWriteFailure("REPLAY_RESTORE_LIST_BOOKS", error);
    },
    applyRuntimeSnapshot: (replaySnapshot, hydratedBooks) => {
      applyTradingReplaySnapshotToTarget(target, replaySnapshot, hydratedBooks);
    },
    deletePersistedBookKeys: (keys) =>
      target.safeStorageDelete([...keys], "REPLAY_RESTORE_DELETE_BOOKS"),
    writeRestoreState: (writes) => target.safeStoragePut(writes, "REPLAY_RESTORE")
  });
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
