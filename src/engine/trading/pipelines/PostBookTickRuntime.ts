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
import {
  evaluateTradingCascadeStrategy,
  type TradingCascadeStrategyTarget
} from "../cascade/CascadeStrategyRuntime";
import {
  buildTradingDomAnalysisForTarget,
  type TradingBookViewTarget
} from "../book/TradingBookViewRuntime";
import { cancelLaggingHypeQuotesForTrading } from "../leadlag/TradingCrossAssetCancelRuntime";
import {
  processTradingShadowQueueTickForTarget,
  type TradingShadowQueueTarget
} from "../shadow/TradingShadowQueueRuntime";
import {
  cancelAllTradingQuotesForTarget,
  type TradingQuoteCancelAllTarget
} from "../quotes/QuoteCancelRuntime";
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

export interface TradingPostBookTickRuntimeTarget {
  readonly cachedConfig: GlobalRiskConfig;
  readonly env: Pick<Env, "CROSS_ASSET_CANCEL_LEAD_BPS" | "CROSS_ASSET_CANCEL_COOLDOWN_MS">;
  readonly crossAssetCancelLogAt: Map<string, number>;
  readonly multiScaleVolatility: {
    update(
      instrumentCode: string,
      midPrice: number | null,
      observedAt: string
    ): MultiScaleVolatilitySnapshot | null;
  };
  readonly logger: {
    warn(eventType: string, message: string, metadata: JsonRecord): void;
  };
  readonly state: {
    waitUntil(work: Promise<unknown>): void;
  };
  publish(type: "SUSPEND_QUOTES", payload: JsonRecord): void;
  cancelAllQuotes?(instrumentCode: "hype-usd", reason: "BTC_LEAD_MOVE"): Promise<unknown>;
  processShadowQueueTick?(
    tick: MarketTick,
    book: InternalOrderBook,
    observedAt: string,
    options: TickHandlingOptions
  ): ShadowQueueState;
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

export function prepareTradingPostBookTickRuntimeForTarget(
  input: PostBookTickRuntimeInput,
  target: TradingPostBookTickRuntimeTarget
): Promise<PostBookTickContext> {
  return prepareTradingPostBookTickRuntime(
    {
      ...input,
      config: target.cachedConfig,
      env: target.env,
      lastHypeCancelAtMs: target.crossAssetCancelLogAt.get("hype-usd") ?? 0,
      fallbackNowMs: Date.now()
    },
    {
      evaluateCascadeStrategy: (tick, observedAt) =>
        evaluateTradingCascadeStrategy(
          tick,
          observedAt,
          target as unknown as TradingCascadeStrategyTarget
        ).then(() => undefined),
      updateVolatility: (instrumentCode, midPrice, observedAt) =>
        target.multiScaleVolatility.update(instrumentCode, midPrice, observedAt),
      markHypeCancelCooldown: (instrumentCode, nowMs) => {
        target.crossAssetCancelLogAt.set(instrumentCode, nowMs);
      },
      warn: (eventType, message, metadata) => {
        target.logger.warn(eventType, message, metadata);
      },
      publishSuspend: (payload) => {
        target.publish("SUSPEND_QUOTES", payload);
      },
      schedule: (work) => {
        target.state.waitUntil(work);
      },
      cancelAllQuotes: (instrumentCode, reason) =>
        target.cancelAllQuotes
          ? target.cancelAllQuotes(instrumentCode, reason)
          : cancelAllTradingQuotesForTarget(
              instrumentCode,
              reason,
              target as unknown as TradingQuoteCancelAllTarget
            ),
      processShadowQueueTick: (tick, book, observedAt, options) =>
        target.processShadowQueueTick
          ? target.processShadowQueueTick(tick, book, observedAt, options)
          : processTradingShadowQueueTickForTarget(
              tick,
              book,
              observedAt,
              options,
              target as unknown as TradingShadowQueueTarget
            ),
      getLiquidityWalls: (instrumentCode, observedAt, tick) =>
        buildTradingDomAnalysisForTarget(
          target as unknown as TradingBookViewTarget,
          instrumentCode,
          observedAt,
          tick,
          true
        )
    }
  );
}
