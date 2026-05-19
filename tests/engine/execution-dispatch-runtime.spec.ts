import { describe, expect, it } from "vitest";
import {
  buildExecutionDispatchBlockLog,
  dispatchTradeIntentToExecutioner,
  type ExecutionDispatchLogger,
  evaluateExecutionDispatchGate
} from "../../src/engine/trading/execution/ExecutionDispatchRuntime";
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

  it("builds dispatch-block telemetry for inactive Moltworker instruments", () => {
    expect(
      buildExecutionDispatchBlockLog({
        decision: { allowed: false, reason: "MOLTWORKER_NOT_SELECTED" },
        intent: tradeIntent({ instrumentCode: "sol-usd", action: "SELL" }),
        selectedInstruments: ["btc-usd", "hype-usd"]
      })
    ).toEqual({
      level: "INFO",
      eventType: "EXECUTION_DISPATCH_BLOCKED",
      message: "Skipped execution intent for inactive Moltworker asset",
      metadata: {
        intentId: "intent-1",
        instrumentCode: "sol-usd",
        action: "SELL",
        orderType: "LIMIT",
        selectedInstruments: ["btc-usd", "hype-usd"]
      }
    });
  });

  it("builds dispatch-block telemetry for suppressed taker intents", () => {
    expect(
      buildExecutionDispatchBlockLog({
        decision: { allowed: false, reason: "TAKER_SUPPRESSED" },
        intent: tradeIntent({
          orderType: "IOC",
          postOnly: false,
          timeInForce: "IOC",
          rationale: "hedge attempt"
        }),
        selectedInstruments: ["btc-usd"]
      })
    ).toEqual({
      level: "WARN",
      eventType: "TAKER_EXECUTION_SUPPRESSED",
      message: "Non-post-only execution suppressed by passive inventory protocol",
      metadata: {
        intentId: "intent-1",
        instrumentCode: "btc-usd",
        orderType: "IOC",
        postOnly: false,
        timeInForce: "IOC",
        rationale: "hedge attempt"
      }
    });
  });

  it("does not emit dispatch-block telemetry for terminal non-loggable reasons", () => {
    expect(
      buildExecutionDispatchBlockLog({
        decision: { allowed: false, reason: "NO_EXECUTIONER" },
        intent: tradeIntent(),
        selectedInstruments: ["btc-usd"]
      })
    ).toBeNull();
    expect(
      buildExecutionDispatchBlockLog({
        decision: { allowed: true, reason: null },
        intent: tradeIntent(),
        selectedInstruments: ["btc-usd"]
      })
    ).toBeNull();
  });

  it("dispatches trade intents to the executioner binding", async () => {
    const requests: Request[] = [];
    const { logger } = loggerSpy();
    const executioner = {
      async fetch(request: Request) {
        requests.push(request);
        return Response.json({ ok: true });
      }
    };

    await dispatchTradeIntentToExecutioner({ executioner, logger, intent: tradeIntent() });

    expect(requests[0].url).toBe("https://executioner.internal/execute");
    expect(requests[0].method).toBe("POST");
    await expect(requests[0].json()).resolves.toMatchObject({
      intentId: "intent-1",
      instrumentCode: "btc-usd",
      orderType: "LIMIT"
    });
  });

  it("logs execution dispatch failures without throwing", async () => {
    const { logger, errors } = loggerSpy();
    const executioner = {
      async fetch() {
        throw new Error("executioner unreachable");
      }
    };

    await dispatchTradeIntentToExecutioner({ executioner, logger, intent: tradeIntent() });

    expect(errors[0]).toMatchObject({
      eventType: "EXECUTION_DISPATCH_FAILED",
      telemetry: {
        intentId: "intent-1",
        error: "executioner unreachable"
      }
    });
  });
});

function loggerSpy(): {
  logger: ExecutionDispatchLogger;
  errors: { eventType: string; message: string; telemetry?: Record<string, unknown> }[];
} {
  const errors: { eventType: string; message: string; telemetry?: Record<string, unknown> }[] = [];
  return {
    logger: {
      error(eventType, message, telemetry) {
        errors.push({ eventType, message, telemetry });
      }
    },
    errors
  };
}

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
