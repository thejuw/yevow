import type { MultiScaleVolatilitySnapshot } from "../../MultiScaleVolatility";
import type {
  DomAnalysisSnapshot,
  InternalOrderBook,
  MarketTick,
  ShadowQueueState
} from "../../../types";
import type { PostBookTickContext, TickHandlingOptions } from "./TickPipelineTypes";

export interface PostBookTickRuntimeInput {
  readonly tick: MarketTick;
  readonly book: InternalOrderBook;
  readonly observedAt: string;
  readonly options: TickHandlingOptions;
}

export interface PostBookTickRuntimeHandlers {
  readonly evaluateCascadeStrategy: (tick: MarketTick, observedAt: string) => Promise<void>;
  readonly updateVolatility: (
    instrumentCode: string,
    midPrice: number | null,
    observedAt: string
  ) => MultiScaleVolatilitySnapshot | null;
  readonly maybeCancelLaggingHypeQuotes: (
    tick: MarketTick,
    volatility: MultiScaleVolatilitySnapshot | null,
    observedAt: string,
    options: TickHandlingOptions
  ) => void;
  readonly processShadowQueueTick: (
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string,
    options: TickHandlingOptions
  ) => ShadowQueueState;
  readonly getLiquidityWalls: (
    instrumentCode: string,
    observedAt: string,
    tick: MarketTick
  ) => DomAnalysisSnapshot;
}

export async function preparePostBookTickRuntime(
  input: PostBookTickRuntimeInput,
  handlers: PostBookTickRuntimeHandlers
): Promise<PostBookTickContext> {
  await handlers.evaluateCascadeStrategy(input.tick, input.observedAt);

  const volatilitySnapshot = handlers.updateVolatility(
    input.tick.instrumentCode,
    input.book.midPrice,
    input.observedAt
  );
  handlers.maybeCancelLaggingHypeQuotes(
    input.tick,
    volatilitySnapshot,
    input.observedAt,
    input.options
  );

  const shadowQueueState = handlers.processShadowQueueTick(
    input.tick,
    input.book,
    input.observedAt,
    input.options
  );
  const domSnapshot = handlers.getLiquidityWalls(
    input.tick.instrumentCode,
    input.observedAt,
    input.tick
  );

  return {
    volatilitySnapshot,
    shadowQueueState,
    domSnapshot
  };
}
