import { ANOMALY_DETECTOR_STORAGE_KEY } from "../../../agents/AnomalyDetector";
import { PROFILER_STATE_STORAGE_KEY } from "../../../agents/ProfilerAgent";
import {
  DOM_WALL_HISTORY_KEY,
  ENGINE_STATE_KEY,
  DEFAULT_MARKET_TICK_JOURNAL_INTERVAL,
  ORDER_BOOK_PREFIX,
  PERFORMANCE_HISTORY_KEY,
  PROCESSING_LATENCY_SAMPLES_KEY
} from "../../../TradingEngineConstants";
import { profilerStorageKey } from "../book/BookRuntimeHelpers";
import {
  bayesianPosteriorUpdatedLogMetadata,
  marketTickAcceptedLogMetadata,
  shouldLogBayesianPosteriorUpdate,
  shouldLogMarketTickAccepted
} from "../telemetry/TickTelemetryRuntime";
import type {
  AnomalyDetectorState,
  BayesianUpdateTrace,
  EngineState,
  InternalOrderBook,
  JsonRecord,
  LatencyMetrics,
  LiquidityWall,
  MarketTick,
  ProfilerState
} from "../../../types";

export interface HotPathTickSnapshotWritesInput {
  readonly engineState: EngineState;
  readonly latencyHistory: LatencyMetrics[];
  readonly processingLatencySamples: number[];
  readonly domWallHistory: LiquidityWall[];
  readonly anomalyDetectorState: AnomalyDetectorState;
  readonly book: InternalOrderBook;
  readonly tick: MarketTick;
  readonly profilerProcessed: boolean;
  readonly profilerState: ProfilerState;
}

export interface HotPathTickSnapshotSideEffectHandlers {
  readonly persistSnapshot: (writes: Record<string, unknown>, reason: string) => Promise<void>;
  readonly schedule: (work: Promise<void>) => void;
}

export interface AcceptedTickJournalArtifactsInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly bayesianTrace: BayesianUpdateTrace | null;
  readonly processedTicks: number;
  readonly averageLatencyMs: number;
  readonly marketTickJournalInterval?: string | number;
  readonly bayesianSnapshotInterval: number;
}

export interface AcceptedTickJournalLog {
  readonly eventType: string;
  readonly message: string;
  readonly metadata: JsonRecord;
}

export interface AcceptedTickJournalArtifacts {
  readonly shouldRecordMarketTick: boolean;
  readonly bayesianPosteriorLog: AcceptedTickJournalLog | null;
  readonly acceptedTickLog: AcceptedTickJournalLog | null;
}

export interface AcceptedTickJournalSideEffectHandlers {
  readonly recordMarketTick: (tick: MarketTick) => void;
  readonly logInfo: (eventType: string, message: string, metadata: JsonRecord) => void;
}

export function buildHotPathTickSnapshotWrites(
  input: HotPathTickSnapshotWritesInput
): Record<string, unknown> {
  const writes: Record<string, unknown> = {
    [ENGINE_STATE_KEY]: input.engineState,
    [PERFORMANCE_HISTORY_KEY]: input.latencyHistory,
    [PROCESSING_LATENCY_SAMPLES_KEY]: input.processingLatencySamples,
    [DOM_WALL_HISTORY_KEY]: input.domWallHistory,
    [ANOMALY_DETECTOR_STORAGE_KEY]: input.anomalyDetectorState,
    [`${ORDER_BOOK_PREFIX}${input.book.marketKey}`]: input.book,
    [`lastTick:${input.book.marketKey}`]: input.tick
  };

  if (input.profilerProcessed) {
    writes[profilerStorageKey(input.tick.instrumentCode)] = input.profilerState;
    if (input.tick.instrumentCode === "btc-usd") {
      writes[PROFILER_STATE_STORAGE_KEY] = input.profilerState;
    }
  }

  return writes;
}

export function scheduleHotPathTickSnapshotSideEffects(
  input: HotPathTickSnapshotWritesInput,
  handlers: HotPathTickSnapshotSideEffectHandlers
): Record<string, unknown> {
  const writes = buildHotPathTickSnapshotWrites(input);
  handlers.schedule(handlers.persistSnapshot(writes, "HOT_PATH_TICK_SNAPSHOT"));
  return writes;
}

export function shouldJournalMarketTick(
  processedTicks: number,
  configuredInterval: string | number | undefined
): boolean {
  const parsedInterval = Number(configuredInterval);
  const interval = Number.isFinite(parsedInterval)
    ? Math.max(0, Math.floor(parsedInterval))
    : DEFAULT_MARKET_TICK_JOURNAL_INTERVAL;

  if (interval === 0) {
    return false;
  }

  return processedTicks <= 5 || processedTicks % interval === 0;
}

export function buildAcceptedTickJournalArtifacts(
  input: AcceptedTickJournalArtifactsInput
): AcceptedTickJournalArtifacts {
  const bayesianPosteriorLog =
    input.bayesianTrace &&
    shouldLogBayesianPosteriorUpdate({
      trace: input.bayesianTrace,
      processedTicks: input.processedTicks,
      interval: input.bayesianSnapshotInterval
    })
      ? {
          eventType: "BAYESIAN_POSTERIOR_UPDATED",
          message: "Oracle posterior PDF updated",
          metadata: bayesianPosteriorUpdatedLogMetadata({
            instrumentCode: input.tick.instrumentCode,
            trace: input.bayesianTrace
          })
        }
      : null;

  return {
    shouldRecordMarketTick: shouldJournalMarketTick(
      input.processedTicks,
      input.marketTickJournalInterval
    ),
    bayesianPosteriorLog,
    acceptedTickLog: shouldLogMarketTickAccepted(input.processedTicks)
      ? {
          eventType: "MARKET_TICK_ACCEPTED",
          message: "Market tick processed",
          metadata: marketTickAcceptedLogMetadata({
            tick: input.tick,
            metrics: input.metrics,
            processedTicks: input.processedTicks,
            averageLatencyMs: input.averageLatencyMs
          })
        }
      : null
  };
}

export function applyAcceptedTickJournalSideEffects(
  tick: MarketTick,
  artifacts: AcceptedTickJournalArtifacts,
  handlers: AcceptedTickJournalSideEffectHandlers
): void {
  if (artifacts.shouldRecordMarketTick) {
    handlers.recordMarketTick(tick);
  }

  if (artifacts.bayesianPosteriorLog) {
    const log = artifacts.bayesianPosteriorLog;
    handlers.logInfo(log.eventType, log.message, log.metadata);
  }

  if (artifacts.acceptedTickLog) {
    const log = artifacts.acceptedTickLog;
    handlers.logInfo(log.eventType, log.message, log.metadata);
  }
}
