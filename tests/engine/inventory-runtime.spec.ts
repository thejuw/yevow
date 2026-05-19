import { describe, expect, it } from "vitest";
import {
  calculateInventoryState,
  normalizeInventoryDelta
} from "../../src/engine/trading/inventory/InventoryRuntime";
import type { Position } from "../../src/types";

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
