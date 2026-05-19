import { describe, expect, it } from "vitest";
import {
  buildShadowQueueTradeIntent,
  resolveShadowQueueSizingConfig,
  shadowQueueKellySize,
  shadowQueuePostOnlyPrice
} from "../../src/engine/trading/shadow/ShadowQueueRuntime";
import { defaultConfig } from "../../src/ConfigManager";
import type {
  GlobalRiskConfig,
  InternalOrderBook,
  InventoryState,
  ShadowQueueDecision
} from "../../src/types";

const OBSERVED_AT = "2026-05-18T09:00:00.000Z";

describe("ShadowQueueRuntime", () => {
  it("snaps post-only prices away from the touch", () => {
    const baseBook = book({ bestBid: 99.5, bestAsk: 100.5, tickSize: 0.5, spread: 1 });

    expect(shadowQueuePostOnlyPrice("BUY", baseBook, 100, 10)).toBe(99);
    expect(shadowQueuePostOnlyPrice("SELL", baseBook, 100, 10)).toBe(101);
    expect(shadowQueuePostOnlyPrice("BUY", book({ bestAsk: null, spread: null }), 100, 10)).toBe(
      99.5
    );
  });

  it("sizes VLO deployment by budget, queue depth, and inventory room", () => {
    const baseBook = book({
      bids: [{ price: 99, size: 10, updatedAt: OBSERVED_AT }],
      asks: [{ price: 101, size: 5, updatedAt: OBSERVED_AT }]
    });

    expect(
      shadowQueueKellySize({
        action: "BUY",
        price: 100,
        book: baseBook,
        equity: 1_000,
        maxPositionPct: 0.1,
        kellyFraction: 0.5,
        inventory: inventory({ netDelta: 0, maxInventoryUnits: 2 }),
        positionSizeMultiplier: 1
      })
    ).toBe(0.2);
    expect(
      shadowQueueKellySize({
        action: "SELL",
        price: 100,
        book: baseBook,
        equity: 1_000,
        maxPositionPct: 0.1,
        kellyFraction: 0.5,
        inventory: inventory({ netDelta: -2, maxInventoryUnits: 2 }),
        positionSizeMultiplier: 1
      })
    ).toBe(0);
    expect(
      shadowQueueKellySize({
        action: "BUY",
        price: 0,
        book: baseBook,
        equity: 1_000,
        maxPositionPct: 0.1,
        kellyFraction: 0.5,
        inventory: inventory(),
        positionSizeMultiplier: 1
      })
    ).toBe(0);
  });

  it("builds green and red light trade intents with bounded confidence", () => {
    const green = buildShadowQueueTradeIntent({
      decision: decision({ action: "GREEN_LIGHT", dispatchSide: "BUY", microDrift: 1 }),
      book: book(),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      baseSpreadBps: 4,
      exchangeFeeBps: 1,
      toxicityScore: 0.3,
      requestedSize: 0.25,
      price: 99.5
    });

    expect(green).toMatchObject({
      intentId: "vlo-intent:decision-1",
      traceId: "engine-1:shadow-queue:fill-1",
      direction: "LONG",
      action: "BUY",
      postOnly: true,
      timeInForce: "ALO",
      requestedSize: 0.25,
      probabilityWin: 0.56,
      adverseSelectionCost: 0.3,
      maxSlippageBps: 20,
      confidence: 1
    });

    const red = buildShadowQueueTradeIntent({
      decision: decision({ action: "RED_LIGHT", dispatchSide: "SELL", microDrift: -0.1 }),
      book: book({ spreadBps: null }),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      baseSpreadBps: 4,
      exchangeFeeBps: 1,
      toxicityScore: 0.3,
      requestedSize: 0.25,
      price: 100.5
    });

    expect(red).toMatchObject({
      direction: "SHORT",
      action: "SELL",
      probabilityWin: 0.53,
      adverseSelectionCost: 0,
      maxSlippageBps: 4,
      confidence: 0.2
    });

    expect(
      buildShadowQueueTradeIntent({
        decision: decision({ dispatchSide: null }),
        book: book(),
        observedAt: OBSERVED_AT,
        engineId: "engine-1",
        baseSpreadBps: 4,
        exchangeFeeBps: 1,
        toxicityScore: 0,
        requestedSize: 0.25,
        price: 99
      })
    ).toBeNull();
  });

  it("resolves sizing config from hot config with bounded env fallback", () => {
    expect(
      resolveShadowQueueSizingConfig({
        cachedConfig: { ...defaultConfig, MAX_POSITION_PCT: 0.03, KELLY_FRACTION: 0.2 },
        envMaxPositionPct: 0.1,
        envKellyFraction: 2
      })
    ).toEqual({ maxPositionPct: 0.03, kellyFraction: 0.2 });
    expect(
      resolveShadowQueueSizingConfig({
        cachedConfig: {
          ...defaultConfig,
          MAX_POSITION_PCT: 0,
          KELLY_FRACTION: 0
        } as GlobalRiskConfig,
        envMaxPositionPct: 0.1,
        envKellyFraction: 2
      })
    ).toEqual({ maxPositionPct: 0.1, kellyFraction: 1 });
  });
});

function book(overrides: Partial<InternalOrderBook> = {}): InternalOrderBook {
  return {
    marketKey: "hyperliquid:btc-usd",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceWeight: 1,
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    bids: [{ price: 99.5, size: 10, updatedAt: OBSERVED_AT }],
    asks: [{ price: 100.5, size: 10, updatedAt: OBSERVED_AT }],
    bestBid: 99.5,
    bestAsk: 100.5,
    midPrice: 100,
    spread: 1,
    spreadBps: 20,
    weightedImbalance: 0,
    lastSequence: 7,
    tickSize: 0.5,
    ttbLatencyMs: 2,
    isSynced: true,
    desyncReason: null,
    sequence: 7,
    updatedAt: OBSERVED_AT,
    ...overrides
  };
}

function inventory(overrides: Partial<InventoryState> = {}): InventoryState {
  return {
    netDelta: 0,
    current_inventory_delta: 0,
    baseAsset: "btc",
    normalization: {},
    maxInventoryUnits: 2,
    maxInventoryDelta: 2,
    inventoryPenalty: 0,
    stopBid: false,
    stopAsk: false,
    updatedAt: OBSERVED_AT,
    ...overrides
  };
}

function decision(overrides: Partial<ShadowQueueDecision> = {}): ShadowQueueDecision {
  return {
    decisionId: "decision-1",
    fillId: "fill-1",
    instrumentCode: "btc-usd",
    originalSide: "BUY",
    action: "GREEN_LIGHT",
    dispatchSide: "BUY",
    p0MidPrice: 100,
    pnMidPrice: 101,
    microDrift: 1,
    driftTrades: 3,
    tickThreshold: 0.5,
    decisionLatencyMs: 1,
    tradeIntentId: null,
    reason: "test",
    decidedAt: OBSERVED_AT,
    ...overrides
  };
}
