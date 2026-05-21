import type { AnomalyDetectionResult } from "../../../agents/AnomalyDetector";
import { AGENT_SNAPSHOT_TICK_INTERVAL } from "../../../TradingEngineConstants";
import type {
  BayesianUpdateTrace,
  EngineState,
  InternalOrderBook,
  JsonRecord,
  LatencyMetrics,
  LiquidityWall,
  MarketTick
} from "../../../types";
import type { ProfilerEvaluation } from "../../../agents/ProfilerAgent";
import {
  recordAcceptedTickJournalSideEffects,
  scheduleHotPathTickSnapshotSideEffects
} from "./TickPersistenceRuntime";

export interface TradingAcceptedTickSnapshotInput {
  readonly engineState: EngineState;
  readonly latencyHistory: LatencyMetrics[];
  readonly processingLatencySamples: number[];
  readonly domWallHistory: LiquidityWall[];
  readonly tick: MarketTick;
  readonly book: InternalOrderBook;
  readonly anomalyResult: AnomalyDetectionResult;
  readonly profilerResult: ProfilerEvaluation;
}

export interface TradingAcceptedTickSnapshotHandlers {
  readonly persistSnapshot: (writes: Record<string, unknown>, reason: string) => Promise<void>;
  readonly schedule: (work: Promise<void>) => void;
}

export interface TradingAcceptedTickJournalInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly bayesianTrace: BayesianUpdateTrace | null;
  readonly engineState: Pick<EngineState, "processedTicks" | "averageLatency">;
  readonly marketTickJournalInterval?: string | number;
}

export interface TradingAcceptedTickJournalHandlers {
  readonly recordMarketTick: (tick: MarketTick) => void;
  readonly logInfo: (eventType: string, message: string, metadata: JsonRecord) => void;
}

export function scheduleTradingAcceptedTickSnapshot(
  input: TradingAcceptedTickSnapshotInput,
  handlers: TradingAcceptedTickSnapshotHandlers
): void {
  scheduleHotPathTickSnapshotSideEffects(
    {
      engineState: input.engineState,
      latencyHistory: input.latencyHistory,
      processingLatencySamples: input.processingLatencySamples,
      domWallHistory: input.domWallHistory,
      anomalyDetectorState: input.anomalyResult.state,
      book: input.book,
      tick: input.tick,
      profilerProcessed: input.profilerResult.processed,
      profilerState: input.profilerResult.state
    },
    handlers
  );
}

export function recordTradingAcceptedTickJournal(
  input: TradingAcceptedTickJournalInput,
  handlers: TradingAcceptedTickJournalHandlers
): void {
  recordAcceptedTickJournalSideEffects(
    {
      tick: input.tick,
      metrics: input.metrics,
      bayesianTrace: input.bayesianTrace,
      processedTicks: input.engineState.processedTicks,
      averageLatencyMs: input.engineState.averageLatency,
      marketTickJournalInterval: input.marketTickJournalInterval,
      bayesianSnapshotInterval: AGENT_SNAPSHOT_TICK_INTERVAL
    },
    handlers
  );
}
