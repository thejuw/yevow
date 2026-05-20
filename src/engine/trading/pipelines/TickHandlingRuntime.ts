import type { AnomalyDetectionResult } from "../../../agents/AnomalyDetector";
import type { InternalOrderBook, LatencyMetrics, MarketTick } from "../../../types";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import { evaluateTickTargetPreflight } from "../state/TickPreflightRuntime";
import type {
  AcceptedDecisionPipelineInput,
  PostBookTickContext,
  TickBookResolution,
  TickHandlingOptions
} from "./TickPipelineTypes";

export interface PreparedTickLatencyDecision {
  readonly metrics: LatencyMetrics;
  readonly streamId: string | null;
  readonly hardStaleDropMs: number;
  readonly isHardStale: boolean;
}

export interface TickHandlingRuntimeInput {
  readonly tick: MarketTick;
  readonly wakeUpTimeMs: number | null;
  readonly options: TickHandlingOptions;
  readonly hotPathStartedAt: number;
  readonly tradingEnabled: boolean;
  readonly shadowModeActive: boolean;
}

export interface TickHandlingRuntimeHandlers {
  readonly maybeAutoResumeShadowMode: (tick: MarketTick, shadowReplay: boolean) => void;
  readonly resolveTradingAvailability: (
    tick: MarketTick,
    shadowReplay: boolean
  ) => TickIngestResult | null;
  readonly rememberLastTickTimestamp: (receivedAt: string) => void;
  readonly observeCascadeAbsorption: (tick: MarketTick) => void;
  readonly prepareTickLatency: (
    tick: MarketTick,
    shadowReplay: boolean
  ) => PreparedTickLatencyDecision;
  readonly handleHardStaleTickDrop: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    streamId: string | null,
    hardStaleDropMs: number
  ) => Promise<TickIngestResult>;
  readonly handleSoftStaleTick: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    hotPathStartedAt: number
  ) => Promise<TickIngestResult>;
  readonly applyFundingTick: (tick: MarketTick, observedAt: string) => void;
  readonly resolveTickBook: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    hotPathStartedAt: number
  ) => Promise<TickBookResolution>;
  readonly preparePostBookTickContext: (
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string,
    options: TickHandlingOptions
  ) => Promise<PostBookTickContext>;
  readonly evaluateAnomaly: (
    tick: MarketTick,
    book: InternalOrderBook,
    domSnapshot: PostBookTickContext["domSnapshot"],
    observedAt: string
  ) => AnomalyDetectionResult;
  readonly nowMs: () => number;
  readonly handleAnomalyEmergencyPause: (
    tick: MarketTick,
    book: InternalOrderBook,
    domSnapshot: PostBookTickContext["domSnapshot"],
    anomalyResult: AnomalyDetectionResult,
    anomalyLogicStartedAt: number,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    orderBookUpdateMs: number,
    hotPathStartedAt: number
  ) => Promise<TickIngestResult>;
  readonly processAcceptedDecisionPipeline: (input: AcceptedDecisionPipelineInput) => Promise<void>;
}

export async function handleTickRuntime(
  input: TickHandlingRuntimeInput,
  handlers: TickHandlingRuntimeHandlers
): Promise<TickIngestResult> {
  const shadowReplay = input.options.shadowReplay === true;
  const targetPreflight = evaluateTickTargetPreflight({ tick: input.tick, shadowReplay });

  if (targetPreflight.rejection) {
    return targetPreflight.rejection;
  }

  handlers.maybeAutoResumeShadowMode(input.tick, shadowReplay);
  const tradingAvailability = handlers.resolveTradingAvailability(input.tick, shadowReplay);
  if (tradingAvailability) {
    return tradingAvailability;
  }

  handlers.rememberLastTickTimestamp(input.tick.receivedAt);
  handlers.observeCascadeAbsorption(input.tick);

  const { metrics, streamId, hardStaleDropMs, isHardStale } = handlers.prepareTickLatency(
    input.tick,
    shadowReplay
  );

  if (isHardStale) {
    return handlers.handleHardStaleTickDrop(input.tick, metrics, streamId, hardStaleDropMs);
  }

  if (metrics.status === "STALE" && !shadowReplay && input.tradingEnabled) {
    return handlers.handleSoftStaleTick(
      input.tick,
      metrics,
      input.wakeUpTimeMs,
      input.hotPathStartedAt
    );
  }

  handlers.applyFundingTick(input.tick, metrics.brainTimestamp);

  const bookResolution = await handlers.resolveTickBook(
    input.tick,
    metrics,
    input.wakeUpTimeMs,
    input.hotPathStartedAt
  );
  if (bookResolution.kind === "EARLY_RETURN") {
    return bookResolution.result;
  }
  const { book, orderBookUpdateMs } = bookResolution;

  const { volatilitySnapshot, shadowQueueState, domSnapshot } =
    await handlers.preparePostBookTickContext(
      input.tick,
      book,
      metrics.brainTimestamp,
      input.options
    );
  const anomalyLogicStartedAt = handlers.nowMs();
  const anomalyResult = handlers.evaluateAnomaly(
    input.tick,
    book,
    domSnapshot,
    metrics.brainTimestamp
  );

  if (
    anomalyResult.emergencyPause &&
    input.tradingEnabled &&
    !shadowReplay &&
    !input.shadowModeActive
  ) {
    return handlers.handleAnomalyEmergencyPause(
      input.tick,
      book,
      domSnapshot,
      anomalyResult,
      anomalyLogicStartedAt,
      metrics,
      input.wakeUpTimeMs,
      orderBookUpdateMs,
      input.hotPathStartedAt
    );
  }

  await handlers.processAcceptedDecisionPipeline({
    tick: input.tick,
    metrics,
    book,
    domSnapshot,
    volatilitySnapshot,
    shadowQueueState,
    anomalyResult,
    wakeUpTimeMs: input.wakeUpTimeMs,
    orderBookUpdateMs,
    hotPathStartedAt: input.hotPathStartedAt,
    shadowReplay
  });

  return {
    accepted: true,
    status: metrics.status,
    metrics,
    book
  };
}
