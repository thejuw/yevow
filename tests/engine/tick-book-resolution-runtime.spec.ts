import { describe, expect, it } from "vitest";
import { resolveTickBookFlow } from "../../src/engine/trading/book/TickBookResolutionRuntime";
import { resolveTradingTickBookForTarget } from "../../src/engine/trading/book/TradingTickBookRuntime";
import type {
  AppliedBookUpdate,
  BookDeltaWithTicker
} from "../../src/engine/trading/book/BookTypes";
import type { InternalOrderBook, LatencyMetrics, MarketTick } from "../../src/types";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";

describe("TickBookResolutionRuntime", () => {
  it("returns an existing book for informational ticks without applying deltas", async () => {
    const book = orderBook();
    const metrics = latencyMetrics({ timeToBookMs: 99 });
    const events: string[] = [];

    const result = await resolveTickBookFlow(
      {
        tick: marketTick({ raw: { eventType: "trade" } }),
        metrics,
        wakeUpTimeMs: 3,
        hotPathStartedAt: 11
      },
      handlers(events, { currentBook: book })
    );

    expect(result).toEqual({ kind: "BOOK", book, orderBookUpdateMs: 0 });
    expect(metrics.timeToBookMs).toBeNull();
    expect(events).toEqual(["current:btc-usd"]);
  });

  it("returns book-not-ready early results for informational ticks without a book", async () => {
    const events: string[] = [];

    const result = await resolveTickBookFlow(
      {
        tick: marketTick({ raw: { eventType: "funding" } }),
        metrics: latencyMetrics(),
        wakeUpTimeMs: 3,
        hotPathStartedAt: 11
      },
      handlers(events, { currentBook: undefined })
    );

    expect(result).toMatchObject({
      kind: "EARLY_RETURN",
      result: {
        accepted: false,
        status: "BOOK_NOT_READY",
        reason: "missing-book"
      }
    });
    expect(events).toEqual(["current:btc-usd", "book-not-ready:3:0:11"]);
  });

  it("applies deltas, records time-to-book, and returns accepted books", async () => {
    const book = orderBook();
    const metrics = latencyMetrics();
    const events: string[] = [];
    const result = await resolveTickBookFlow(
      {
        tick: marketTick(),
        metrics,
        wakeUpTimeMs: 5,
        hotPathStartedAt: 13
      },
      handlers(events, {
        applied: {
          accepted: true,
          book,
          timeToBookMs: 17
        },
        nowMs: [100, 103.456]
      })
    );

    expect(result).toEqual({ kind: "BOOK", book, orderBookUpdateMs: 3.456 });
    expect(metrics.timeToBookMs).toBe(17);
    expect(events).toEqual(["delta:btc-usd:42:2026-05-18T12:00:00.050Z"]);
  });

  it("adapts a trading engine target into tick book handlers", async () => {
    const book = orderBook();
    const metrics = latencyMetrics();
    const events: string[] = [];
    const orderBooks = new Map<string, InternalOrderBook>([["hyperliquid:btc-usd", book]]);

    const result = await resolveTradingTickBookForTarget(
      {
        tick: marketTick(),
        metrics,
        wakeUpTimeMs: 7,
        hotPathStartedAt: 17
      },
      {
        orderBook: orderBooks,
        engineState: defaultEngineState("tick-book-target"),
        orderBookReconstructor: {
          applyDelta(delta: BookDeltaWithTicker, observedAt: string) {
            events.push(`delta:${delta.instrumentCode}:${observedAt}`);
            return {
              accepted: true,
              book,
              timeToBookMs: 9
            };
          }
        },
        handleInformationalBookNotReady(_tick, _metrics, wakeUpTimeMs) {
          events.push(`book-not-ready:${wakeUpTimeMs}`);
          return Promise.resolve({
            accepted: false,
            status: "BOOK_NOT_READY",
            reason: "missing-book"
          });
        },
        handleRejectedBookDelta(_tick, _metrics, applied: AppliedBookUpdate) {
          events.push(`rejected:${applied.reason}`);
          return Promise.resolve({
            accepted: false,
            status: "DESYNC",
            reason: applied.reason
          });
        }
      } as unknown as TradingTickBookTarget
    );

    expect(result).toMatchObject({ kind: "BOOK", book });
    expect(metrics.timeToBookMs).toBe(9);
    expect(events).toEqual(["delta:btc-usd:2026-05-18T12:00:00.050Z"]);
  });

  it("routes rejected deltas through rejected early-return handling", async () => {
    const metrics = latencyMetrics();
    const events: string[] = [];
    const result = await resolveTickBookFlow(
      {
        tick: marketTick(),
        metrics,
        wakeUpTimeMs: 5,
        hotPathStartedAt: 13
      },
      handlers(events, {
        applied: {
          accepted: false,
          reason: "SEQUENCE_GAP",
          expectedSequence: 41,
          actualSequence: 42,
          timeToBookMs: 19
        },
        nowMs: [100, 102]
      })
    );

    expect(result).toMatchObject({
      kind: "EARLY_RETURN",
      result: {
        accepted: false,
        status: "DESYNC",
        reason: "SEQUENCE_GAP"
      }
    });
    expect(metrics.timeToBookMs).toBe(19);
    expect(events).toEqual([
      "delta:btc-usd:42:2026-05-18T12:00:00.050Z",
      "rejected:SEQUENCE_GAP:5:2:13"
    ]);
  });

  it("fails fast when an accepted delta does not produce a book", async () => {
    await expect(
      resolveTickBookFlow(
        {
          tick: marketTick(),
          metrics: latencyMetrics(),
          wakeUpTimeMs: null,
          hotPathStartedAt: 0
        },
        handlers([], {
          applied: {
            accepted: true,
            timeToBookMs: 1
          },
          nowMs: [1, 2]
        })
      )
    ).rejects.toThrow("ORDER_BOOK_APPLY_FAILED");
  });
});

function handlers(
  events: string[],
  options: {
    currentBook?: InternalOrderBook;
    applied?: AppliedBookUpdate;
    nowMs?: number[];
  } = {}
): Parameters<typeof resolveTickBookFlow>[1] {
  const nowMs = [...(options.nowMs ?? [])];

  return {
    currentBookForMarketTick(tick) {
      events.push(`current:${tick.instrumentCode}`);
      return options.currentBook;
    },
    applyDelta(delta, observedAt) {
      events.push(`delta:${delta.instrumentCode}:${delta.sequence}:${observedAt}`);
      return Promise.resolve(
        options.applied ?? {
          accepted: true,
          book: orderBook(),
          timeToBookMs: 7
        }
      );
    },
    handleInformationalBookNotReady(_tick, _metrics, wakeUpTimeMs, orderBookUpdateMs, startedAt) {
      events.push(`book-not-ready:${wakeUpTimeMs}:${orderBookUpdateMs}:${startedAt}`);
      return Promise.resolve({
        accepted: false,
        status: "BOOK_NOT_READY",
        reason: "missing-book"
      });
    },
    handleRejectedBookDelta(_tick, _metrics, applied, wakeUpTimeMs, orderBookUpdateMs, startedAt) {
      events.push(`rejected:${applied.reason}:${wakeUpTimeMs}:${orderBookUpdateMs}:${startedAt}`);
      return Promise.resolve({
        accepted: false,
        status: "DESYNC",
        reason: applied.reason
      });
    },
    nowMs() {
      return nowMs.shift() ?? 0;
    }
  };
}

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

function latencyMetrics(overrides: Partial<LatencyMetrics> = {}): LatencyMetrics {
  return {
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    source: "HYPERLIQUID",
    sourceExchange: "hyperliquid",
    sourceWeight: 1,
    sequence: 42,
    providerTimestamp: "2026-05-18T12:00:00.000Z",
    sourceTimestamp: "2026-05-18T12:00:00.000Z",
    ingestTimestamp: "2026-05-18T12:00:00.010Z",
    brainTimestamp: "2026-05-18T12:00:00.050Z",
    clockOffsetMs: 0,
    networkLatencyMs: 10,
    processingLatencyMs: 40,
    totalLatencyMs: 50,
    maxLatencyMs: 150,
    averageLatencyMs: 20,
    sampleCount: 3,
    status: "FRESH",
    colo: "NRT",
    placement: "remote-nrt",
    latencyRiskMultiplier: 1,
    positionSizeMultiplier: 1,
    ...overrides
  };
}

function orderBook(): InternalOrderBook {
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
    updatedAt: "2026-05-18T12:00:00.050Z"
  } as unknown as InternalOrderBook;
}
