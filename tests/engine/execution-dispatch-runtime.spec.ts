import { describe, expect, it } from "vitest";
import { evaluateExecutionDispatchGate } from "../../src/engine/trading/execution/ExecutionDispatchRuntime";
import type { TradeIntent } from "../../src/types";

describe("ExecutionDispatchRuntime", () => {
  it("blocks dispatch without executioner or enabled trading", () => {
    expect(
      evaluateExecutionDispatchGate({
        intent: tradeIntent(),
        hasExecutioner: false,
        tradingEnabled: true,
        hedgeEnabled: false,
        inventoryHedge: false,
        instrumentSelected: true
      })
    ).toEqual({ allowed: false, reason: "NO_EXECUTIONER" });
    expect(
      evaluateExecutionDispatchGate({
        intent: tradeIntent(),
        hasExecutioner: true,
        tradingEnabled: false,
        hedgeEnabled: false,
        inventoryHedge: false,
        instrumentSelected: true
      })
    ).toEqual({ allowed: false, reason: "TRADING_DISABLED" });
  });

  it("allows inventory hedges through the hedge kill switch when trading is disabled", () => {
    expect(
      evaluateExecutionDispatchGate({
        intent: tradeIntent({ orderType: "IOC", postOnly: false, timeInForce: "IOC" }),
        hasExecutioner: true,
        tradingEnabled: false,
        hedgeEnabled: true,
        inventoryHedge: true,
        instrumentSelected: false
      })
    ).toEqual({ allowed: true, reason: null });
  });

  it("blocks inactive Moltworker assets and non-post-only normal intents", () => {
    expect(
      evaluateExecutionDispatchGate({
        intent: tradeIntent(),
        hasExecutioner: true,
        tradingEnabled: true,
        hedgeEnabled: false,
        inventoryHedge: false,
        instrumentSelected: false
      })
    ).toEqual({ allowed: false, reason: "MOLTWORKER_NOT_SELECTED" });
    expect(
      evaluateExecutionDispatchGate({
        intent: tradeIntent({ orderType: "IOC", postOnly: false, timeInForce: "IOC" }),
        hasExecutioner: true,
        tradingEnabled: true,
        hedgeEnabled: false,
        inventoryHedge: false,
        instrumentSelected: true
      })
    ).toEqual({ allowed: false, reason: "TAKER_SUPPRESSED" });
  });

  it("allows selected post-only limit intents", () => {
    expect(
      evaluateExecutionDispatchGate({
        intent: tradeIntent(),
        hasExecutioner: true,
        tradingEnabled: true,
        hedgeEnabled: false,
        inventoryHedge: false,
        instrumentSelected: true
      })
    ).toEqual({ allowed: true, reason: null });
  });
});

function tradeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    schemaVersion: "trade-intent.v1",
    intentId: "intent-1",
    traceId: "trace-1",
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    source_exchange: "hyperliquid",
    direction: "LONG",
    action: "BUY",
    orderType: "LIMIT",
    postOnly: true,
    timeInForce: "ALO",
    intendedPrice: 100,
    expectedPrice: 100,
    requestedSize: 1,
    approvedSize: 1,
    probabilityWin: 0.5,
    probabilityLoss: 0.5,
    profit: 1,
    loss: 1,
    executionCosts: 0,
    adverseSelectionCost: 0,
    expectedValue: 0,
    minEvThreshold: 0,
    maxSlippageBps: 5,
    confidence: 0.5,
    rationale: "test",
    createdAt: "2026-05-18T18:00:00.000Z",
    ...overrides
  };
}
