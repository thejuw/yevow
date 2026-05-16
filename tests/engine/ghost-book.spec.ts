import { describe, expect, it } from "vitest";
import { GhostBook } from "../../src/utils/GhostBook";
import type { InternalOrderBook, MarketTick } from "../../src/types";

describe("GhostBook shadow queue matrix", () => {
  it("registers a queue-consumed ghost fill and green-lights favorable drift", () => {
    const ghostBook = new GhostBook({
      capacity: 16,
      driftTradeDelay: 3,
      queueDepthMultiplier: 1,
      baseSpreadBps: 1,
      latencyBudgetMs: 5,
      minSize: 0.00000001
    });
    const book = sampleBook({ midPrice: 100.5, bestBid: 100, bestAsk: 101 });

    ghostBook.injectBbo(book, "2026-05-16T00:00:00.000Z");

    const fillObservation = ghostBook.observeTrade(
      sampleTrade({ sequence: 2, side: "sell", price: 100, size: 12 }),
      book,
      "2026-05-16T00:00:00.001Z"
    );

    expect(fillObservation.fills).toHaveLength(1);
    expect(fillObservation.fills[0]?.side).toBe("BUY");
    expect(fillObservation.decisions).toHaveLength(0);

    ghostBook.observeTrade(
      sampleTrade({ sequence: 3, side: "buy", price: 101, size: 1 }),
      sampleBook({ midPrice: 100.5, bestBid: 100, bestAsk: 101 }),
      "2026-05-16T00:00:00.002Z"
    );
    ghostBook.observeTrade(
      sampleTrade({ sequence: 4, side: "buy", price: 101.5, size: 1 }),
      sampleBook({ midPrice: 101, bestBid: 100.5, bestAsk: 101.5 }),
      "2026-05-16T00:00:00.003Z"
    );
    const decisionObservation = ghostBook.observeTrade(
      sampleTrade({ sequence: 5, side: "buy", price: 102, size: 1 }),
      sampleBook({ midPrice: 101.5, bestBid: 101, bestAsk: 102 }),
      "2026-05-16T00:00:00.004Z"
    );

    expect(decisionObservation.decisions).toHaveLength(1);
    expect(decisionObservation.decisions[0]).toMatchObject({
      originalSide: "BUY",
      action: "GREEN_LIGHT",
      dispatchSide: "BUY"
    });
  });

  it("red-lights adverse drift and inverts the dispatch side", () => {
    const ghostBook = new GhostBook({
      capacity: 16,
      driftTradeDelay: 1,
      queueDepthMultiplier: 0,
      baseSpreadBps: 1,
      latencyBudgetMs: 5,
      minSize: 0.00000001
    });
    const book = sampleBook({ midPrice: 100.5, bestBid: 100, bestAsk: 101 });

    ghostBook.injectBbo(book, "2026-05-16T00:00:00.000Z");
    ghostBook.observeTrade(
      sampleTrade({ sequence: 2, side: "sell", price: 100, size: 1 }),
      book,
      "2026-05-16T00:00:00.001Z"
    );
    const observation = ghostBook.observeTrade(
      sampleTrade({ sequence: 3, side: "sell", price: 99.5, size: 1 }),
      sampleBook({ midPrice: 99.5, bestBid: 99, bestAsk: 100 }),
      "2026-05-16T00:00:00.002Z"
    );

    expect(observation.decisions[0]).toMatchObject({
      originalSide: "BUY",
      action: "RED_LIGHT",
      dispatchSide: "SELL"
    });
  });
});

function sampleBook(input: {
  midPrice: number;
  bestBid: number;
  bestAsk: number;
}): InternalOrderBook {
  return {
    marketKey: "hyperliquid:btc-usd",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceWeight: 1,
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    bids: [{ price: input.bestBid, size: 10, updatedAt: "2026-05-16T00:00:00.000Z" }],
    asks: [{ price: input.bestAsk, size: 10, updatedAt: "2026-05-16T00:00:00.000Z" }],
    bestBid: input.bestBid,
    bestAsk: input.bestAsk,
    midPrice: input.midPrice,
    spread: input.bestAsk - input.bestBid,
    spreadBps: ((input.bestAsk - input.bestBid) / input.midPrice) * 10_000,
    weightedImbalance: 0,
    lastSequence: 1,
    tickSize: 0.5,
    ttbLatencyMs: 1,
    isSynced: true,
    desyncReason: null,
    sequence: 1,
    updatedAt: "2026-05-16T00:00:00.000Z"
  };
}

function sampleTrade(input: {
  sequence: number;
  side: "buy" | "sell";
  price: number;
  size: number;
}): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    transport: "grpc",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    baseAsset: "btc",
    quoteAsset: "usd",
    price: input.price,
    size: input.size,
    side: input.side,
    sequence: input.sequence,
    providerTimestamp: "2026-05-16T00:00:00.000Z",
    exchangeTimestamp: "2026-05-16T00:00:00.000Z",
    synchronizedExchangeTimestamp: "2026-05-16T00:00:00.000Z",
    clockOffsetMs: 0,
    receivedAt: "2026-05-16T00:00:00.000Z",
    sourceWeight: 1,
    raw: {
      eventType: "trade",
      commodity: "TRADE"
    }
  };
}
