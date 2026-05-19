import { describe, expect, it } from "vitest";
import {
  calculateInventoryState,
  normalizeInventoryDelta,
  referencePriceForBaseAsset
} from "../../src/engine/trading/inventory/InventoryRuntime";
import type { InternalOrderBook, Position } from "../../src/types";

const OBSERVED_AT = "2026-05-18T11:00:00.000Z";

describe("InventoryRuntime", () => {
  it("normalizes multi-asset inventory against BTC reference prices", () => {
    const normalized = normalizeInventoryDelta({
      positions: {
        "btc-usd": position("btc-usd", "LONG", 0.1, 100_000),
        "hype-usd": position("hype-usd", "SHORT", 20, 5)
      },
      baseAsset: "BTC",
      baseReferencePrice: 100_000,
      configuredWeights: {},
      markPrice: (instrumentCode, fallback) => (instrumentCode === "hype-usd" ? 5 : fallback)
    });

    expect(normalized).toEqual({
      current_inventory_delta: 0.099,
      baseAsset: "BTC",
      normalization: {
        "btc-usd": 1,
        "hype-usd": 0.00005
      }
    });
  });

  it("uses configured weights and emits stop flags for hard caps", () => {
    const state = calculateInventoryState({
      positions: {
        "btc-usd": position("btc-usd", "LONG", 1.2, 100_000),
        "eth-usd": position("eth-usd", "LONG", 2, 5_000)
      },
      observedAt: OBSERVED_AT,
      maxInventoryUnits: 1,
      maxInventoryDelta: 1.5,
      riskAversionFactor: 0.2,
      baseAsset: "BTC",
      baseReferencePrice: 100_000,
      configuredWeights: { "eth-usd": 0.2 },
      markPrice: (_instrumentCode, fallback) => fallback
    });

    expect(state).toMatchObject({
      netDelta: 3.2,
      current_inventory_delta: 1.6,
      normalization: {
        "btc-usd": 1,
        "eth-usd": 0.2
      },
      inventoryPenalty: 0.32000000000000006,
      stopBid: true,
      stopAsk: false,
      updatedAt: OBSERVED_AT
    });
  });

  it("falls back to neutral weights when reference and mark prices are unusable", () => {
    expect(
      normalizeInventoryDelta({
        positions: {
          "sol-usd": position("sol-usd", "SHORT", 3, 0)
        },
        baseAsset: "BTC",
        baseReferencePrice: 0,
        configuredWeights: {},
        markPrice: () => 0
      })
    ).toMatchObject({
      current_inventory_delta: -3,
      normalization: { "sol-usd": 1 }
    });
  });

  it("resolves base reference prices from books, positions, microstructure, then neutral fallback", () => {
    expect(
      referencePriceForBaseAsset({
        baseAsset: "BTC",
        orderBooks: [book({ midPrice: 100_100 })],
        positions: {
          "btc-usd": position("btc-usd", "LONG", 1, 99_000)
        },
        microstructureMidPrice: 98_000
      })
    ).toBe(100_100);
    expect(
      referencePriceForBaseAsset({
        baseAsset: "BTC",
        orderBooks: [book({ instrumentCode: "eth-usd", midPrice: 5_000 })],
        positions: {
          "btc-usd": position("btc-usd", "LONG", 1, 99_000)
        },
        microstructureMidPrice: 98_000
      })
    ).toBe(99_000);
    expect(
      referencePriceForBaseAsset({
        baseAsset: "BTC",
        orderBooks: [],
        positions: {},
        microstructureMidPrice: 98_000
      })
    ).toBe(98_000);
    expect(
      referencePriceForBaseAsset({
        baseAsset: "BTC",
        orderBooks: [],
        positions: {},
        microstructureMidPrice: null
      })
    ).toBe(1);
  });
});

function position(
  instrumentCode: string,
  side: "LONG" | "SHORT",
  quantity: number,
  markPrice: number
): Position {
  return {
    instrumentCode,
    side,
    quantity,
    averageEntryPrice: markPrice,
    markPrice,
    unrealizedPnl: 0,
    realizedPnl: 0,
    updatedAt: OBSERVED_AT
  };
}

function book(overrides: Partial<InternalOrderBook> = {}): InternalOrderBook {
  return {
    marketKey: "hyperliquid:btc-usd",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceWeight: 1,
    instrumentCode: "btc-usd",
    exchangeCode: "hyperliquid",
    bids: [],
    asks: [],
    bestBid: null,
    bestAsk: null,
    midPrice: 100_000,
    spread: null,
    spreadBps: null,
    weightedImbalance: null,
    lastSequence: 1,
    tickSize: 1,
    ttbLatencyMs: null,
    isSynced: true,
    desyncReason: null,
    sequence: 1,
    updatedAt: OBSERVED_AT,
    ...overrides
  };
}
