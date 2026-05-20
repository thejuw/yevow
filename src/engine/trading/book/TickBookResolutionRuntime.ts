import type { InternalOrderBook, LatencyMetrics, MarketTick } from "../../../types";
import type { TickIngestResult } from "../TradingEngineRouteTypes";
import type { TickBookResolution } from "../pipelines/TickPipelineTypes";
import type { AppliedBookUpdate, BookDeltaWithTicker } from "./BookTypes";
import { highResolutionNow, roundLatency } from "../helpers/RuntimeClock";
import { isInformationalTick } from "../state/TickClassification";
import { tickToDelta } from "./BookRuntimeHelpers";

export interface TickBookResolutionFlowInput {
  readonly tick: MarketTick;
  readonly metrics: LatencyMetrics;
  readonly wakeUpTimeMs: number | null;
  readonly hotPathStartedAt: number;
}

export interface TickBookResolutionFlowHandlers {
  readonly currentBookForMarketTick: (tick: MarketTick) => InternalOrderBook | undefined;
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
  readonly nowMs?: () => number;
}

export async function resolveTickBookFlow(
  input: TickBookResolutionFlowInput,
  handlers: TickBookResolutionFlowHandlers
): Promise<TickBookResolution> {
  let orderBookUpdateMs = 0;

  if (isInformationalTick(input.tick)) {
    input.metrics.timeToBookMs = null;
    const book = handlers.currentBookForMarketTick(input.tick);

    if (!book) {
      return {
        kind: "EARLY_RETURN",
        result: await handlers.handleInformationalBookNotReady(
          input.tick,
          input.metrics,
          input.wakeUpTimeMs,
          orderBookUpdateMs,
          input.hotPathStartedAt
        )
      };
    }

    return { kind: "BOOK", book, orderBookUpdateMs };
  }

  const startedAt = handlers.nowMs?.() ?? highResolutionNow();
  const applied = await handlers.applyDelta(tickToDelta(input.tick), input.metrics.brainTimestamp);
  orderBookUpdateMs = roundLatency((handlers.nowMs?.() ?? highResolutionNow()) - startedAt);
  input.metrics.timeToBookMs = applied.timeToBookMs;

  if (!applied.accepted) {
    return {
      kind: "EARLY_RETURN",
      result: await handlers.handleRejectedBookDelta(
        input.tick,
        input.metrics,
        applied,
        input.wakeUpTimeMs,
        orderBookUpdateMs,
        input.hotPathStartedAt
      )
    };
  }

  const book = applied.book;
  if (!book) {
    throw new Error("ORDER_BOOK_APPLY_FAILED");
  }

  return { kind: "BOOK", book, orderBookUpdateMs };
}
