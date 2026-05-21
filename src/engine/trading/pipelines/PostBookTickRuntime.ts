import type { MultiScaleVolatilitySnapshot } from "../../MultiScaleVolatility";
import type {
  DomAnalysisSnapshot,
  Env,
  GlobalRiskConfig,
  InternalOrderBook,
  JsonRecord,
  MarketTick,
  ShadowQueueState
} from "../../../types";
import { cancelLaggingHypeQuotesForTrading } from "../leadlag/TradingCrossAssetCancelRuntime";
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

export interface TradingPostBookTickRuntimeInput extends PostBookTickRuntimeInput {
  readonly config: Pick<GlobalRiskConfig, "TRADING_ENABLED">;
  readonly env: Pick<Env, "CROSS_ASSET_CANCEL_LEAD_BPS" | "CROSS_ASSET_CANCEL_COOLDOWN_MS">;
  readonly lastHypeCancelAtMs: number;
  readonly fallbackNowMs: number;
}

export interface TradingPostBookTickRuntimeHandlers extends Omit<
  PostBookTickRuntimeHandlers,
  "maybeCancelLaggingHypeQuotes"
> {
  readonly markHypeCancelCooldown: (instrumentCode: "hype-usd", nowMs: number) => void;
  readonly warn: (eventType: string, message: string, metadata: JsonRecord) => void;
  readonly publishSuspend: (payload: JsonRecord) => void;
  readonly schedule: (work: Promise<unknown>) => void;
  readonly cancelAllQuotes: (
    instrumentCode: "hype-usd",
    reason: "BTC_LEAD_MOVE"
  ) => Promise<unknown>;
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

export async function prepareTradingPostBookTickRuntime(
  input: TradingPostBookTickRuntimeInput,
  handlers: TradingPostBookTickRuntimeHandlers
): Promise<PostBookTickContext> {
  return preparePostBookTickRuntime(input, {
    evaluateCascadeStrategy: handlers.evaluateCascadeStrategy,
    updateVolatility: handlers.updateVolatility,
    maybeCancelLaggingHypeQuotes: (tick, volatility, observedAt, options) => {
      cancelLaggingHypeQuotesForTrading(
        {
          tick,
          volatility,
          observedAt,
          options,
          config: input.config,
          env: input.env,
          lastHypeCancelAtMs: input.lastHypeCancelAtMs,
          fallbackNowMs: input.fallbackNowMs
        },
        {
          markCooldown: handlers.markHypeCancelCooldown,
          warn: handlers.warn,
          publishSuspend: handlers.publishSuspend,
          schedule: handlers.schedule,
          cancelAllQuotes: handlers.cancelAllQuotes
        }
      );
    },
    processShadowQueueTick: handlers.processShadowQueueTick,
    getLiquidityWalls: handlers.getLiquidityWalls
  });
}
