import { describe, expect, it } from "vitest";
import {
  applyQuoteDispatchSideEffects,
  applyQuoteRefreshThrottleSideEffects,
  buildCroupierQuoteAction,
  buildQuoteDispatchIntents,
  buildQuoteRefreshRuntimeDecision,
  dispatchCroupierQuoteActionSideEffects,
  dispatchedQuoteSnapshot,
  evaluateQuoteRefreshThrottle,
  quoteDispatchBlockedLogMetadata,
  quoteRefreshThrottleLogMetadata,
  type QuoteDispatchSideEffectHandlers,
  type QuoteRefreshThrottleSideEffectHandlers
} from "../../src/engine/trading/quotes/QuoteDispatchRuntime";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
import type { InternalOrderBook, QuoteSignal } from "../../src/types";

describe("QuoteDispatchRuntime", () => {
  it("builds risk-capped post-only trade intents from quote orders", () => {
    const result = buildQuoteDispatchIntents({
      quote: quoteSignal(),
      engineId: "engine-1",
      bankrollEquity: 1_000,
      bankrollCash: 500,
      maxPositionPct: 0.1,
      maxPositionSize: 75,
      assetAllocationPct: 0.5,
      positionSizeMultiplier: 0.8,
      fallbackSourceExchange: "hyperliquid",
      spreadBps: 2.5,
      toxicityScore: 0.2
    });

    expect(result.maxOrderNotional).toBe(40);
    expect(result.skippedOrders).toEqual([]);
    expect(result.intents).toHaveLength(2);
    expect(result.intents[0]).toMatchObject({
      intentId: "bid-1",
      traceId: "engine-1:quote:quote-1:bid-1",
      instrumentCode: "btc-usd",
      source_exchange: "hyperliquid",
      direction: "LONG",
      action: "BUY",
      orderType: "LIMIT",
      postOnly: true,
      timeInForce: "ALO",
      intendedPrice: 100,
      requestedSize: 2,
      approvedSize: 0.4,
      maxSlippageBps: 2.5,
      confidence: 0.8
    });
    expect(result.intents[1]).toMatchObject({
      action: "SELL",
      direction: "SHORT",
      approvedSize: 0.3960396
    });
    expect(result.intents[0].rationale).toContain("risk-capped notional=40");
  });

  it("reports skipped orders when risk budget is zero", () => {
    const result = buildQuoteDispatchIntents({
      quote: quoteSignal(),
      engineId: "engine-1",
      bankrollEquity: 0,
      bankrollCash: 0,
      maxPositionPct: 0.1,
      maxPositionSize: 0,
      assetAllocationPct: 1,
      positionSizeMultiplier: 1,
      fallbackSourceExchange: null,
      spreadBps: null,
      toxicityScore: 2
    });

    expect(result.intents).toEqual([]);
    expect(result.skippedOrders).toEqual([
      {
        quoteSignalId: "quote-1",
        instrumentCode: "btc-usd",
        side: "BUY",
        requestedSize: 2,
        price: 100,
        maxOrderNotional: 0
      },
      {
        quoteSignalId: "quote-1",
        instrumentCode: "btc-usd",
        side: "SELL",
        requestedSize: 2,
        price: 101,
        maxOrderNotional: 0
      }
    ]);
  });

  it("applies quote dispatch side effects for skipped and executable children", async () => {
    const quote = quoteSignal();
    const intent = buildQuoteDispatchIntents({
      quote,
      engineId: "engine-1",
      bankrollEquity: 1_000,
      bankrollCash: 1_000,
      maxPositionPct: 0.1,
      maxPositionSize: 100,
      assetAllocationPct: 1,
      positionSizeMultiplier: 1,
      fallbackSourceExchange: "hyperliquid",
      spreadBps: 2,
      toxicityScore: 0
    }).intents[0];
    const sideEffects = quoteDispatchSideEffectSpy();

    if (!intent) {
      throw new Error("missing quote dispatch fixture intent");
    }

    await applyQuoteDispatchSideEffects(
      quote,
      {
        intents: [intent],
        skippedOrders: [
          {
            quoteSignalId: "quote-1",
            instrumentCode: "btc-usd",
            side: "SELL",
            requestedSize: 2,
            price: 101,
            maxOrderNotional: 0
          }
        ],
        maxOrderNotional: 100
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual(["skip:SELL:0", "dispatch:bid-1", "remember:quote-1"]);
  });

  it("builds blocked quote dispatch metadata from asset runtime state", () => {
    const assetRuntimeState = defaultEngineState("quote-dispatch-test").assetMatrix["btc-usd"];

    if (!assetRuntimeState) {
      throw new Error("missing btc-usd asset runtime fixture");
    }

    expect(
      quoteDispatchBlockedLogMetadata({
        quote: quoteSignal(),
        assetRuntimeState: {
          ...assetRuntimeState,
          selectedByMoltworker: false,
          quoteEligible: false,
          quoteReason: "MOLTWORKER_NOT_SELECTED"
        }
      })
    ).toEqual({
      quoteSignalId: "quote-1",
      instrumentCode: "btc-usd",
      selectedByMoltworker: false,
      quoteEligible: false,
      reason: "MOLTWORKER_NOT_SELECTED"
    });
    expect(
      quoteDispatchBlockedLogMetadata({ quote: quoteSignal(), assetRuntimeState: undefined })
    ).toMatchObject({
      selectedByMoltworker: null,
      quoteEligible: null,
      reason: "MOLTWORKER_NOT_SELECTED"
    });
  });

  it("preserves liquidation absorption rationale and fallback source exchange", () => {
    const quote = quoteSignal({
      marketKey: null,
      orders: [
        {
          clientOrderId: "liq-1",
          side: "BID",
          price: 98,
          size: 0.5,
          postOnly: true,
          strategy: "LIQUIDATION_ABSORPTION",
          clusterId: "cluster-7"
        }
      ]
    });

    const result = buildQuoteDispatchIntents({
      quote,
      engineId: "engine-1",
      bankrollEquity: 10_000,
      bankrollCash: 10_000,
      maxPositionPct: 0.1,
      maxPositionSize: 0,
      assetAllocationPct: 1,
      positionSizeMultiplier: 1,
      fallbackSourceExchange: "hyperliquid",
      spreadBps: null,
      toxicityScore: -1
    });

    expect(result.intents[0]).toMatchObject({
      source_exchange: "hyperliquid",
      maxSlippageBps: 1,
      confidence: 2
    });
    expect(result.intents[0].rationale).toContain("cluster cluster-7");
  });

  it("normalizes croupier pull and post quote actions", () => {
    expect(
      buildCroupierQuoteAction({
        instrumentCode: "btc-usd",
        pullAllQuotes: true,
        quote: quoteSignal(),
        strategyQuoteDisableReason: null,
        adverseSelectionCost: 0.2,
        minEvThreshold: 0.1,
        shadowReplay: false,
        tradingEnabled: true,
        profilerQuoteHalt: false,
        cascadeShield: false
      })
    ).toEqual({
      kind: "PULL_ALL_QUOTES",
      publish: {
        type: "PULL_ALL_QUOTES",
        payload: {
          instrumentCode: "btc-usd",
          adverseSelectionCost: 0.2,
          minEvThreshold: 0.1
        }
      },
      cancelReason: "ADVERSE_SELECTION_CRITICAL"
    });

    const post = buildCroupierQuoteAction({
      instrumentCode: "btc-usd",
      pullAllQuotes: false,
      quote: quoteSignal(),
      strategyQuoteDisableReason: null,
      adverseSelectionCost: 0,
      minEvThreshold: 0,
      shadowReplay: false,
      tradingEnabled: true,
      profilerQuoteHalt: false,
      cascadeShield: true
    });

    expect(post).toMatchObject({
      kind: "POST_QUOTE",
      shouldDispatch: true,
      cascadeShieldCancelReason: "CASCADE_SHIELD",
      publish: {
        type: "POST_QUOTE",
        correlationId: "quote-1",
        payload: {
          signalId: "quote-1",
          instrumentCode: "btc-usd",
          orderCount: 2
        }
      }
    });
  });

  it("skips croupier quote actions when disabled, halted, or replaying", () => {
    expect(
      buildCroupierQuoteAction({
        instrumentCode: "btc-usd",
        pullAllQuotes: false,
        quote: quoteSignal(),
        strategyQuoteDisableReason: "STRATEGY_DISABLED",
        adverseSelectionCost: 0,
        minEvThreshold: 0,
        shadowReplay: false,
        tradingEnabled: true,
        profilerQuoteHalt: false,
        cascadeShield: false
      })
    ).toEqual({ kind: "NONE" });

    expect(
      buildCroupierQuoteAction({
        instrumentCode: "btc-usd",
        pullAllQuotes: false,
        quote: quoteSignal(),
        strategyQuoteDisableReason: null,
        adverseSelectionCost: 0,
        minEvThreshold: 0,
        shadowReplay: true,
        tradingEnabled: true,
        profilerQuoteHalt: false,
        cascadeShield: false
      })
    ).toMatchObject({ kind: "POST_QUOTE", shouldDispatch: false });
  });

  it("dispatches croupier quote action side effects through supplied handlers", async () => {
    const published: unknown[] = [];
    const scheduled: Promise<void>[] = [];
    const calls: string[] = [];
    const quote = quoteSignal();

    dispatchCroupierQuoteActionSideEffects(
      "btc-usd",
      {
        kind: "POST_QUOTE",
        quote,
        publish: { type: "POST_QUOTE", payload: { signalId: "quote-1" }, correlationId: "quote-1" },
        shouldDispatch: true,
        cascadeShieldCancelReason: "CASCADE_SHIELD"
      },
      {
        publish: (type, payload, correlationId) => published.push({ type, payload, correlationId }),
        schedule: (work) => scheduled.push(work),
        async cancelAllQuotes(instrumentCode, reason) {
          calls.push(`cancel:${instrumentCode}:${reason}`);
        },
        async dispatchQuote(dispatchedQuote) {
          calls.push(`dispatch:${dispatchedQuote.signalId}`);
        }
      }
    );

    await Promise.all(scheduled);

    expect(published).toEqual([
      { type: "POST_QUOTE", payload: { signalId: "quote-1" }, correlationId: "quote-1" }
    ]);
    expect(calls).toEqual(["cancel:btc-usd:CASCADE_SHIELD", "dispatch:quote-1"]);
  });

  it("evaluates quote refresh throttles from queue advice and log cadence", () => {
    const previousQuote = { bid: 100, ask: 101, updatedAtMs: Date.parse(quoteSignal().createdAt) };
    const quote = quoteSignal({ createdAt: "2026-05-18T17:00:00.750Z" });

    expect(
      evaluateQuoteRefreshThrottle({
        previousQuote,
        quote,
        advice: { shouldRefresh: true, reason: "MID_MOVED", queuePressure: 2 },
        minIntervalMs: 750,
        minPriceTicks: 1,
        nowMs: Date.parse(quote.createdAt),
        lastLogAtMs: 0,
        logThrottleMs: 10_000
      })
    ).toMatchObject({ shouldThrottle: false, shouldLog: false });

    expect(
      evaluateQuoteRefreshThrottle({
        previousQuote,
        quote,
        advice: { shouldRefresh: false, reason: "HOLD_FRONT_OF_QUEUE", queuePressure: 0.2 },
        minIntervalMs: 750,
        minPriceTicks: 1,
        nowMs: Date.parse(quote.createdAt),
        lastLogAtMs: 0,
        logThrottleMs: 10_000
      })
    ).toEqual({
      shouldThrottle: true,
      shouldLog: true,
      nextLogAtMs: Date.parse(quote.createdAt),
      elapsedMs: 750,
      queuePressure: 0.2,
      queueReason: "HOLD_FRONT_OF_QUEUE"
    });

    expect(
      evaluateQuoteRefreshThrottle({
        previousQuote,
        quote,
        advice: { shouldRefresh: false, reason: "UNCHANGED", queuePressure: 0.5 },
        minIntervalMs: 750,
        minPriceTicks: 1,
        nowMs: Date.parse(quote.createdAt),
        lastLogAtMs: Date.parse(quote.createdAt) - 1_000,
        logThrottleMs: 10_000
      })
    ).toMatchObject({ shouldThrottle: true, shouldLog: false });
  });

  it("builds quote refresh throttle log metadata", () => {
    const quote = quoteSignal({ createdAt: "2026-05-18T17:00:00.750Z" });
    const throttle = evaluateQuoteRefreshThrottle({
      previousQuote: { bid: 100, ask: 101, updatedAtMs: Date.parse(quoteSignal().createdAt) },
      quote,
      advice: { shouldRefresh: false, reason: "HOLD_FRONT_OF_QUEUE", queuePressure: 0.23456 },
      minIntervalMs: 750,
      minPriceTicks: 1,
      nowMs: Date.parse(quote.createdAt),
      lastLogAtMs: 0,
      logThrottleMs: 10_000
    });

    expect(
      quoteRefreshThrottleLogMetadata({
        quote,
        throttle,
        minIntervalMs: 750,
        minPriceTicks: 1
      })
    ).toEqual({
      instrumentCode: "btc-usd",
      elapsedMs: 750,
      minIntervalMs: 750,
      minPriceTicks: 1,
      signalId: "quote-1",
      queuePressure: 0.2346,
      queueReason: "HOLD_FRONT_OF_QUEUE"
    });
  });

  it("emits quote refresh throttle side effects only when logging is due", () => {
    const quote = quoteSignal({ createdAt: "2026-05-18T17:00:00.750Z" });
    const throttle = evaluateQuoteRefreshThrottle({
      previousQuote: { bid: 100, ask: 101, updatedAtMs: Date.parse(quoteSignal().createdAt) },
      quote,
      advice: { shouldRefresh: false, reason: "HOLD_FRONT_OF_QUEUE", queuePressure: 0.23456 },
      minIntervalMs: 750,
      minPriceTicks: 1,
      nowMs: Date.parse(quote.createdAt),
      lastLogAtMs: 0,
      logThrottleMs: 10_000
    });
    const sideEffects = quoteRefreshThrottleSideEffectSpy();

    applyQuoteRefreshThrottleSideEffects(
      {
        quote,
        logKey: "btc-usd",
        refresh: { throttle, minIntervalMs: 750, minPriceTicks: 1 }
      },
      sideEffects.handlers
    );
    applyQuoteRefreshThrottleSideEffects(
      {
        quote,
        logKey: "btc-usd",
        refresh: {
          throttle: { ...throttle, shouldLog: false },
          minIntervalMs: 750,
          minPriceTicks: 1
        }
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual([
      "mark:btc-usd:1779123600750",
      "log:QUOTE_REFRESH_THROTTLED:quote-1:HOLD_FRONT_OF_QUEUE"
    ]);
  });

  it("builds quote refresh runtime decisions from queue-position advice", () => {
    const previousQuote = { bid: 100, ask: 101, updatedAtMs: Date.parse(quoteSignal().createdAt) };
    const quote = quoteSignal({ createdAt: "2026-05-18T17:00:00.500Z" });
    const decision = buildQuoteRefreshRuntimeDecision({
      previousQuote,
      quote,
      book: {
        tickSize: 0.5
      } as unknown as InternalOrderBook,
      nowMs: Date.parse(quote.createdAt),
      lastLogAtMs: 0,
      logThrottleMs: 10_000,
      minIntervalMsValue: "900",
      minPriceTicksValue: "2",
      adviseRefresh: (input) => {
        expect(input.elapsedMs).toBe(500);
        expect(input.tickSize).toBe(0.5);
        expect(input.minPriceTicks).toBe(2);
        return { shouldRefresh: false, reason: "HOLD_FRONT_OF_QUEUE", queuePressure: 0.1 };
      }
    });

    expect(decision).toEqual({
      minIntervalMs: 900,
      minPriceTicks: 2,
      throttle: {
        shouldThrottle: true,
        shouldLog: true,
        nextLogAtMs: Date.parse(quote.createdAt),
        elapsedMs: 500,
        queuePressure: 0.1,
        queueReason: "HOLD_FRONT_OF_QUEUE"
      }
    });
  });

  it("captures dispatched quote snapshots with parsed and fallback timestamps", () => {
    expect(dispatchedQuoteSnapshot(quoteSignal(), 1)).toEqual({
      bid: 100,
      ask: 101,
      updatedAtMs: Date.parse("2026-05-18T17:00:00.000Z")
    });
    expect(dispatchedQuoteSnapshot(quoteSignal({ createdAt: "not-a-date" }), 42)).toEqual({
      bid: 100,
      ask: 101,
      updatedAtMs: 42
    });
  });
});

function quoteDispatchSideEffectSpy(): {
  events: string[];
  handlers: QuoteDispatchSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      logSkippedOrder(skipped) {
        events.push(`skip:${skipped.side}:${skipped.maxOrderNotional}`);
      },
      dispatchExecution(intent) {
        events.push(`dispatch:${intent.intentId}`);
        return Promise.resolve();
      },
      rememberDispatchedQuote(quote) {
        events.push(`remember:${quote.signalId}`);
      }
    }
  };
}

function quoteRefreshThrottleSideEffectSpy(): {
  events: string[];
  handlers: QuoteRefreshThrottleSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      markLogAt(logKey, loggedAtMs) {
        events.push(`mark:${logKey}:${loggedAtMs}`);
      },
      logInfo(event, _message, metadata) {
        events.push(`log:${event}:${metadata.signalId}:${metadata.queueReason}`);
      }
    }
  };
}

function quoteSignal(overrides: Partial<QuoteSignal> = {}): QuoteSignal {
  return {
    schemaVersion: "quote-signal.v1",
    signalId: "quote-1",
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    reservationPrice: 100.5,
    optimalSpread: 1,
    orders: [
      {
        clientOrderId: "bid-1",
        side: "BID",
        price: 100,
        size: 2,
        postOnly: true,
        strategy: "AMM"
      },
      {
        clientOrderId: "ask-1",
        side: "ASK",
        price: 101,
        size: 2,
        postOnly: true,
        strategy: "AMM"
      }
    ],
    createdAt: "2026-05-18T17:00:00.000Z",
    ...overrides
  };
}
