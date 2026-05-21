import type { InternalOrderBook, LatencyMetrics, MarketTick } from "../../../types";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { TickBookResolution } from "../pipelines/TickPipelineTypes";
import type { AppliedBookUpdate, BookDeltaWithTicker } from "./BookTypes";
import { currentBookForMarketTick } from "./BookViews";
import { resolveTickBookFlow } from "./TickBookResolutionRuntime";
import {
  applyTradingBookDeltaForTarget,
  type TradingBookApplicationTarget
} from "./TradingBookApplicationRuntime";
import {
  handleTradingEngineInformationalBookNotReady,
  handleTradingEngineRejectedBookDelta,
  type TradingBookEarlyReturnTarget
} from "./TradingBookEarlyReturnRuntime";

export interface TradingTickBookInput {
  readonly orderBook: Map<string, InternalOrderBook>;
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly wakeUpTimeMs: number | null;
  readonly hotPathStartedAt: number;
}

export interface TradingTickBookHandlers {
  readonly applyDelta: (
    delta: BookDeltaWithTicker,
    observedAt: string
  ) => Promise<AppliedBookUpdate>;
  readonly handleInformationalBookNotReady: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    wakeUpTimeMs: number | null,
    orderBookUpdateMs: number,
    hotPathStartedAt: number
  ) => Promise<TickIngestResult>;
  readonly handleRejectedBookDelta: (
    tick: MarketTick,
    metrics: LatencyMetrics,
    applied: AppliedBookUpdate,
    wakeUpTimeMs: number | null,
    orderBookUpdateMs: number,
    hotPathStartedAt: number
  ) => Promise<TickIngestResult>;
}

export interface TradingTickBookTarget
  extends TradingBookApplicationTarget, TradingBookEarlyReturnTarget {
  readonly orderBook: Map<string, InternalOrderBook>;
}

export function resolveTradingTickBook(
  input: TradingTickBookInput,
  handlers: TradingTickBookHandlers
): Promise<TickBookResolution> {
  return resolveTickBookFlow(
    {
      tick: input.tick,
      metrics: input.metrics,
      wakeUpTimeMs: input.wakeUpTimeMs,
      hotPathStartedAt: input.hotPathStartedAt
    },
    {
      currentBookForMarketTick: (tick) => currentBookForMarketTick(input.orderBook, tick),
      applyDelta: handlers.applyDelta,
      handleInformationalBookNotReady: handlers.handleInformationalBookNotReady,
      handleRejectedBookDelta: handlers.handleRejectedBookDelta
    }
  );
}

export function resolveTradingTickBookForTarget(
  input: Omit<TradingTickBookInput, "orderBook">,
  target: TradingTickBookTarget
): Promise<TickBookResolution> {
  return resolveTradingTickBook(
    {
      ...input,
      orderBook: target.orderBook
    },
    {
      applyDelta: (delta, observedAt) => applyTradingBookDeltaForTarget(delta, observedAt, target),
      handleInformationalBookNotReady: (
        tick,
        metrics,
        wakeUpTimeMs,
        orderBookUpdateMs,
        hotPathStartedAt
      ) =>
        handleTradingEngineInformationalBookNotReady(
          tick,
          metrics,
          wakeUpTimeMs,
          orderBookUpdateMs,
          hotPathStartedAt,
          target
        ),
      handleRejectedBookDelta: (
        tick,
        metrics,
        applied,
        wakeUpTimeMs,
        orderBookUpdateMs,
        hotPathStartedAt
      ) =>
        handleTradingEngineRejectedBookDelta(
          tick,
          metrics,
          applied,
          wakeUpTimeMs,
          orderBookUpdateMs,
          hotPathStartedAt,
          target
        )
    }
  );
}
