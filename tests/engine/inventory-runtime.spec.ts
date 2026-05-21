import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import {
  applyInventoryHedgeSideEffects,
  buildInventoryHedgeIntent,
  calculateInventoryState,
  inventoryHedgeAuthorizedLogMetadata,
  normalizeInventoryDelta,
  referencePriceForBaseAsset,
  resolveInventoryStateConfig
} from "../../src/engine/trading/inventory/InventoryRuntime";
import {
  dispatchTradingEngineInventoryHedgeIfNeeded,
  type TradingInventoryHedgeTarget
} from "../../src/engine/trading/inventory/TradingInventoryHedgeRuntime";
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

  it("resolves inventory config from live config with environment fallbacks", () => {
    expect(
      resolveInventoryStateConfig({
        config: {
          ...defaultConfig,
          MAX_INVENTORY_UNITS: 4,
          MAX_INVENTORY_DELTA: 2,
          RISK_AVERSION_FACTOR: 0.3
        },
        maxInventoryUnitsValue: "9",
        maxInventoryDeltaValue: "8",
        riskAversionFactorValue: "0.8"
      })
    ).toEqual({
      maxInventoryUnits: 4,
      maxInventoryDelta: 2,
      riskAversionFactor: 0.3
    });
    expect(
      resolveInventoryStateConfig({
        config: {
          ...defaultConfig,
          MAX_INVENTORY_UNITS: 0,
          MAX_INVENTORY_DELTA: 0,
          RISK_AVERSION_FACTOR: 0
        },
        maxInventoryUnitsValue: "9",
        maxInventoryDeltaValue: "8",
        riskAversionFactorValue: "0.8"
      })
    ).toEqual({
      maxInventoryUnits: 9,
      maxInventoryDelta: 8,
      riskAversionFactor: 0.8
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

  it("builds reduce-only IOC inventory hedge intents after trigger and cooldown checks", () => {
    const result = buildInventoryHedgeIntent({
      book: book({ bestBid: 99.5, bestAsk: 100.5, midPrice: 100, tickSize: 0.5 }),
      inventory: inventory({ current_inventory_delta: 1.5, maxInventoryDelta: 2 }),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      config: {
        ...defaultConfig,
        HEDGE_ENABLED: true,
        MAX_INVENTORY_DELTA: 1,
        HEDGE_TRIGGER_INVENTORY_PCT: 0.6,
        HEDGE_COOLDOWN_MS: 30_000,
        HEDGE_MAX_SLIPPAGE_BPS: 8,
        EXCHANGE_FEE_BPS: 1
      },
      lastHedgeAtMs: 0,
      fallbackNowMs: 1
    });

    expect(result).toMatchObject({
      dispatchedAtMs: Date.parse(OBSERVED_AT),
      intent: {
        intentId: `inventory-hedge:btc-usd:${Date.parse(OBSERVED_AT)}`,
        traceId: `engine-1:inventory-hedge:btc-usd:${Date.parse(OBSERVED_AT)}`,
        direction: "SHORT",
        action: "SELL",
        orderType: "IOC",
        postOnly: false,
        timeInForce: "IOC",
        intendedPrice: 99,
        requestedSize: 0.7,
        approvedSize: 0.7,
        loss: 0.056,
        executionCosts: 0.063,
        maxSlippageBps: 8,
        confidence: 0.75,
        rationale:
          "INVENTORY_HEDGE reduce-only IOC limit; currentDelta=1.5 maxDelta=2 triggerPct=0.6"
      }
    });
    if (!result) {
      throw new Error("Expected inventory hedge intent");
    }
    expect(
      inventoryHedgeAuthorizedLogMetadata({
        intent: result.intent,
        inventory: inventory({ current_inventory_delta: 1.5 }),
        triggerPct: 0.6
      })
    ).toEqual({
      intentId: `inventory-hedge:btc-usd:${Date.parse(OBSERVED_AT)}`,
      instrumentCode: "btc-usd",
      action: "SELL",
      approvedSize: 0.7,
      expectedPrice: 99,
      currentInventoryDelta: 1.5,
      triggerPct: 0.6
    });
  });

  it("applies inventory hedge side effects while preserving shadow suppression", () => {
    const hedge = buildInventoryHedgeIntent({
      book: book({ bestBid: 99.5, bestAsk: 100.5, midPrice: 100, tickSize: 0.5 }),
      inventory: inventory({ current_inventory_delta: 1.5, maxInventoryDelta: 2 }),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      config: {
        ...defaultConfig,
        HEDGE_ENABLED: true,
        MAX_INVENTORY_DELTA: 1,
        HEDGE_TRIGGER_INVENTORY_PCT: 0.6,
        HEDGE_COOLDOWN_MS: 30_000,
        HEDGE_MAX_SLIPPAGE_BPS: 8,
        EXCHANGE_FEE_BPS: 1
      },
      lastHedgeAtMs: 0,
      fallbackNowMs: 1
    });
    const calls: string[] = [];
    const handlers = {
      rememberDispatchedAt(instrumentCode: string, dispatchedAtMs: number) {
        calls.push(`remember:${instrumentCode}:${dispatchedAtMs}`);
      },
      logAuthorized(metadata: Record<string, unknown>) {
        calls.push(`log:${metadata.intentId as string}`);
      },
      scheduleExecution(intent: { intentId: string }) {
        calls.push(`execute:${intent.intentId}`);
      }
    };

    const liveIntent = applyInventoryHedgeSideEffects(
      {
        hedge,
        inventory: inventory({ current_inventory_delta: 1.5 }),
        triggerPct: 0.6,
        suppressExecution: false
      },
      handlers
    );
    const shadowIntent = applyInventoryHedgeSideEffects(
      {
        hedge,
        inventory: inventory({ current_inventory_delta: 1.5 }),
        triggerPct: 0.6,
        suppressExecution: true
      },
      handlers
    );

    expect(liveIntent?.intentId).toBe(`inventory-hedge:btc-usd:${Date.parse(OBSERVED_AT)}`);
    expect(shadowIntent).toBeNull();
    expect(calls).toEqual([
      `remember:btc-usd:${Date.parse(OBSERVED_AT)}`,
      `log:inventory-hedge:btc-usd:${Date.parse(OBSERVED_AT)}`,
      `execute:inventory-hedge:btc-usd:${Date.parse(OBSERVED_AT)}`,
      `remember:btc-usd:${Date.parse(OBSERVED_AT)}`
    ]);
  });

  it("dispatches inventory hedge through the trading engine target adapter", async () => {
    const scheduled: Promise<void>[] = [];
    const calls: string[] = [];
    const target: TradingInventoryHedgeTarget = {
      engineState: { engineId: "engine-1" },
      cachedConfig: {
        ...defaultConfig,
        HEDGE_ENABLED: true,
        MAX_INVENTORY_DELTA: 1,
        HEDGE_TRIGGER_INVENTORY_PCT: 0.6,
        HEDGE_COOLDOWN_MS: 30_000,
        HEDGE_MAX_SLIPPAGE_BPS: 8,
        EXCHANGE_FEE_BPS: 1
      },
      lastHedgeDispatchedAt: new Map(),
      logger: {
        warn(eventType, _message, metadata) {
          calls.push(`log:${eventType}:${metadata?.intentId as string}`);
        }
      },
      state: {
        waitUntil(work) {
          scheduled.push(work);
        }
      },
      async dispatchExecution(intent) {
        calls.push(`execute:${intent.intentId}`);
      }
    };

    dispatchTradingEngineInventoryHedgeIfNeeded(
      book({ bestBid: 99.5, bestAsk: 100.5, midPrice: 100, tickSize: 0.5 }),
      inventory({ current_inventory_delta: 1.5, maxInventoryDelta: 2 }),
      OBSERVED_AT,
      false,
      target
    );

    await Promise.all(scheduled);

    const intentId = `inventory-hedge:btc-usd:${Date.parse(OBSERVED_AT)}`;
    expect(target.lastHedgeDispatchedAt.get("btc-usd")).toBe(Date.parse(OBSERVED_AT));
    expect(calls).toEqual([`log:INVENTORY_HEDGE_AUTHORIZED:${intentId}`, `execute:${intentId}`]);
  });

  it("rejects inventory hedge intents when gates are not satisfied", () => {
    const base = {
      book: book({ bestBid: 99.5, bestAsk: 100.5, midPrice: 100, tickSize: 0.5 }),
      inventory: inventory({ current_inventory_delta: -1.5, maxInventoryDelta: 2 }),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      config: {
        ...defaultConfig,
        HEDGE_ENABLED: true,
        HEDGE_TRIGGER_INVENTORY_PCT: 0.6,
        HEDGE_COOLDOWN_MS: 30_000
      },
      lastHedgeAtMs: 0,
      fallbackNowMs: 1
    };

    expect(
      buildInventoryHedgeIntent({ ...base, config: { ...base.config, HEDGE_ENABLED: false } })
    ).toBeNull();
    expect(
      buildInventoryHedgeIntent({
        ...base,
        inventory: inventory({ current_inventory_delta: -0.5, maxInventoryDelta: 2 })
      })
    ).toBeNull();
    expect(
      buildInventoryHedgeIntent({
        ...base,
        lastHedgeAtMs: Date.parse(OBSERVED_AT) - 1_000
      })
    ).toBeNull();
    expect(
      buildInventoryHedgeIntent({
        ...base,
        book: book({ bestAsk: null, midPrice: 100 })
      })
    ).toBeNull();

    expect(buildInventoryHedgeIntent(base)?.intent).toMatchObject({
      direction: "LONG",
      action: "BUY",
      intendedPrice: 101
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

function inventory(overrides: Partial<ReturnType<typeof calculateInventoryState>> = {}) {
  return {
    netDelta: 0,
    current_inventory_delta: 0,
    baseAsset: "BTC",
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
