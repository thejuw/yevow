import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import {
  preparePostBookTickRuntime,
  prepareTradingPostBookTickRuntimeForTarget,
  prepareTradingPostBookTickRuntime
} from "../../src/engine/trading/pipelines/PostBookTickRuntime";
import type { MultiScaleVolatilitySnapshot } from "../../src/engine/MultiScaleVolatility";
import type {
  DomAnalysisSnapshot,
  InternalOrderBook,
  MarketTick,
  ShadowQueueState
} from "../../src/types";

const OBSERVED_AT = "2026-05-18T16:00:00.000Z";

describe("PostBookTickRuntime", () => {
  it("runs post-book reactions in order and returns the assembled context", async () => {
    const events: string[] = [];
    const volatility = volatilitySnapshot();
    const shadowQueueState = { lastDecision: { decisionId: "decision-1" } } as ShadowQueueState;
    const domSnapshot = { instrumentCode: "btc-usd", walls: [] } as unknown as DomAnalysisSnapshot;
    const tick = marketTick();
    const book = orderBook();

    const context = await preparePostBookTickRuntime(
      {
        tick,
        book,
        observedAt: OBSERVED_AT,
        options: { shadowReplay: true }
      },
      {
        evaluateCascadeStrategy(currentTick, observedAt) {
          events.push(`cascade:${currentTick.instrumentCode}:${observedAt}`);
          return Promise.resolve();
        },
        updateVolatility(instrumentCode, midPrice, observedAt) {
          events.push(`volatility:${instrumentCode}:${midPrice}:${observedAt}`);
          return volatility;
        },
        maybeCancelLaggingHypeQuotes(currentTick, currentVolatility, observedAt, options) {
          events.push(
            `lead-lag:${currentTick.instrumentCode}:${currentVolatility === volatility}:${observedAt}:${options.shadowReplay}`
          );
        },
        processShadowQueueTick(currentTick, currentBook, observedAt, options) {
          events.push(
            `shadow:${currentTick.instrumentCode}:${currentBook.midPrice}:${observedAt}:${options.shadowReplay}`
          );
          return shadowQueueState;
        },
        getLiquidityWalls(instrumentCode, observedAt, currentTick) {
          events.push(`dom:${instrumentCode}:${currentTick.sequence}:${observedAt}`);
          return domSnapshot;
        }
      }
    );

    expect(context).toEqual({
      volatilitySnapshot: volatility,
      shadowQueueState,
      domSnapshot
    });
    expect(events).toEqual([
      `cascade:btc-usd:${OBSERVED_AT}`,
      `volatility:btc-usd:100:${OBSERVED_AT}`,
      `lead-lag:btc-usd:true:${OBSERVED_AT}:true`,
      `shadow:btc-usd:100:${OBSERVED_AT}:true`,
      `dom:btc-usd:42:${OBSERVED_AT}`
    ]);
  });

  it("runs trading post-book context with BTC-to-HYPE quote cancellation", async () => {
    const events: string[] = [];
    const volatility = {
      ...volatilitySnapshot(),
      ret: 0.001,
      jumpZScore: 0
    } as unknown as MultiScaleVolatilitySnapshot;
    const shadowQueueState = { lastDecision: { decisionId: "decision-1" } } as ShadowQueueState;
    const domSnapshot = { instrumentCode: "btc-usd", walls: [] } as unknown as DomAnalysisSnapshot;

    const context = await prepareTradingPostBookTickRuntime(
      {
        tick: marketTick(),
        book: orderBook(),
        observedAt: OBSERVED_AT,
        options: { shadowReplay: false },
        config: { TRADING_ENABLED: true },
        env: {
          CROSS_ASSET_CANCEL_LEAD_BPS: "5",
          CROSS_ASSET_CANCEL_COOLDOWN_MS: "1000"
        },
        lastHypeCancelAtMs: 0,
        fallbackNowMs: Date.parse(OBSERVED_AT)
      },
      {
        evaluateCascadeStrategy(currentTick) {
          events.push(`cascade:${currentTick.instrumentCode}`);
          return Promise.resolve();
        },
        updateVolatility() {
          events.push("volatility");
          return volatility;
        },
        markHypeCancelCooldown(instrumentCode) {
          events.push(`cooldown:${instrumentCode}`);
        },
        warn(eventType) {
          events.push(`warn:${eventType}`);
        },
        publishSuspend(payload) {
          events.push(`publish:${payload.instrumentCode as string}`);
        },
        schedule(work) {
          events.push("schedule");
          void work;
        },
        cancelAllQuotes(instrumentCode, reason) {
          events.push(`cancel:${instrumentCode}:${reason}`);
          return Promise.resolve();
        },
        processShadowQueueTick() {
          events.push("shadow");
          return shadowQueueState;
        },
        getLiquidityWalls() {
          events.push("dom");
          return domSnapshot;
        }
      }
    );

    expect(context).toEqual({
      volatilitySnapshot: volatility,
      shadowQueueState,
      domSnapshot
    });
    expect(events).toEqual([
      "cascade:btc-usd",
      "volatility",
      "cooldown:hype-usd",
      "warn:CROSS_ASSET_HYPE_CANCEL",
      "publish:hype-usd",
      "cancel:hype-usd:BTC_LEAD_MOVE",
      "schedule",
      "shadow",
      "dom"
    ]);
  });

  it("adapts a trading engine target into post-book handlers", async () => {
    const events: string[] = [];
    const volatility = {
      ...volatilitySnapshot(),
      ret: 0,
      jumpZScore: 0
    } as unknown as MultiScaleVolatilitySnapshot;
    const shadowQueueState = { lastDecision: { decisionId: "decision-2" } } as ShadowQueueState;
    const cooldowns = new Map<string, number>();
    const book = orderBook({
      instrumentCode: "eth-usd",
      marketKey: "hyperliquid:eth-usd"
    });

    const context = await prepareTradingPostBookTickRuntimeForTarget(
      {
        tick: marketTick({ instrumentCode: "eth-usd" }),
        book,
        observedAt: OBSERVED_AT,
        options: { shadowReplay: true }
      },
      {
        cachedConfig: {
          ...defaultConfig,
          STRATEGY_MODE: "OFF",
          TRADING_ENABLED: true
        },
        env: {
          CROSS_ASSET_CANCEL_LEAD_BPS: "5",
          CROSS_ASSET_CANCEL_COOLDOWN_MS: "1000"
        } as never,
        crossAssetCancelLogAt: cooldowns,
        engineState: defaultEngineState("post-book-target"),
        orderBook: new Map([[book.marketKey, book]]),
        bids: new Map(),
        asks: new Map(),
        domWallHistory: [],
        domWallHistoryLimit: 50,
        domScanRangePct: 0.02,
        domSpoofProximityBps: 5,
        domPriceBinSize: 1,
        orderBookReconstructor: {
          getBookSync() {
            return { isSynced: true };
          }
        },
        multiScaleVolatility: {
          update(instrumentCode, midPrice, observedAt) {
            events.push(`volatility:${instrumentCode}:${midPrice}:${observedAt}`);
            return volatility;
          }
        },
        logger: {
          warn(eventType) {
            events.push(`warn:${eventType}`);
          }
        },
        state: {
          waitUntil(work) {
            events.push("schedule");
            void work;
          }
        },
        publish(type, payload) {
          events.push(`publish:${type}:${payload.instrumentCode as string}`);
        },
        cancelAllQuotes(instrumentCode, reason) {
          events.push(`cancel:${instrumentCode}:${reason}`);
          return Promise.resolve();
        },
        processShadowQueueTick(currentTick, currentBook, observedAt, options) {
          events.push(
            `shadow:${currentTick.instrumentCode}:${currentBook.midPrice}:${observedAt}:${options.shadowReplay}`
          );
          return shadowQueueState;
        }
      }
    );

    expect(context.volatilitySnapshot).toBe(volatility);
    expect(context.shadowQueueState).toBe(shadowQueueState);
    expect(context.domSnapshot).toMatchObject({
      instrumentCode: "eth-usd",
      midPrice: 100,
      walls: []
    });
    expect(events).toEqual([
      `volatility:eth-usd:100:${OBSERVED_AT}`,
      `shadow:eth-usd:100:${OBSERVED_AT}:true`
    ]);
  });
});

function marketTick(overrides: Partial<MarketTick> = {}): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    baseAsset: "BTC",
    quoteAsset: "USD",
    price: 100,
    size: 1,
    side: "buy",
    sequence: 42,
    exchangeTimestamp: "2026-05-18T12:00:00.000Z",
    synchronizedExchangeTimestamp: "2026-05-18T12:00:00.000Z",
    clockOffsetMs: 0,
    receivedAt: "2026-05-18T12:00:00.010Z",
    sourceWeight: 1,
    raw: {},
    ...overrides
  };
}

function orderBook(overrides: Partial<InternalOrderBook> = {}): InternalOrderBook {
  return {
    marketKey: "hyperliquid:btc-usd",
    instrumentCode: "btc-usd",
    source_exchange: "hyperliquid",
    exchangeCode: "hyperliquid",
    bestBid: 99,
    bestAsk: 101,
    midPrice: 100,
    spread: 2,
    weightedImbalance: 0,
    bids: [],
    asks: [],
    updatedAt: OBSERVED_AT,
    ...overrides
  } as unknown as InternalOrderBook;
}

function volatilitySnapshot(): MultiScaleVolatilitySnapshot {
  return {
    instrumentCode: "btc-usd",
    observedAt: OBSERVED_AT,
    horizons: {
      oneMinute: { realizedVol: 0.1, sampleCount: 10 },
      fiveMinute: { realizedVol: 0.2, sampleCount: 20 },
      thirtyMinute: { realizedVol: 0.3, sampleCount: 30 }
    },
    maxRealizedVol: 0.3,
    jumpDetected: false,
    jumpScore: 0
  } as unknown as MultiScaleVolatilitySnapshot;
}
