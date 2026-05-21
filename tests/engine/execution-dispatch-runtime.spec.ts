import { describe, expect, it } from "vitest";
import {
  buildExecutionDispatchBlockLog,
  buildExecutionDispatchRuntimeDecision,
  emitExecutionDispatchBlockLog,
  type ExecutionDispatchBlockLogger,
  evaluateExecutionDispatchGate
} from "../../src/engine/trading/execution/ExecutionDispatchGateRuntime";
import {
  buildExecutionPlanDispatchAction,
  dispatchExecutionPlanSideEffects,
  dispatchTradingExecutionPlans,
  shadowTradeIntentAuthorizedLogMetadata,
  type TradingExecutionPlanDispatchTarget,
  tradeIntentAuthorizedLogMetadata,
  tradeIntentDispatchBlockedLogMetadata
} from "../../src/engine/trading/execution/ExecutionPlanDispatchRuntime";
import {
  dispatchTradeIntentToExecutioner,
  dispatchTradeIntentSideEffects,
  type ExecutionDispatchLogger,
  type TradeIntentDispatchSideEffectHandlers
} from "../../src/engine/trading/execution/TradeIntentDispatchRuntime";
import { defaultEngineState } from "../../src/engine/trading/state/EngineStateDefaults";
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

  it("assembles dispatch runtime gate and block log together", () => {
    const decision = buildExecutionDispatchRuntimeDecision({
      intent: tradeIntent({ instrumentCode: "eth-usd" }),
      hasExecutioner: true,
      tradingEnabled: true,
      hedgeEnabled: false,
      inventoryHedge: false,
      instrumentSelected: false,
      selectedInstruments: ["btc-usd", "hype-usd"]
    });

    expect(decision.gate).toEqual({ allowed: false, reason: "MOLTWORKER_NOT_SELECTED" });
    expect(decision.blockLog).toMatchObject({
      level: "INFO",
      eventType: "EXECUTION_DISPATCH_BLOCKED",
      metadata: {
        instrumentCode: "eth-usd",
        selectedInstruments: ["btc-usd", "hype-usd"]
      }
    });
  });

  it("emits execution dispatch block logs at the declared severity", () => {
    const { logger, events } = blockLoggerSpy();

    emitExecutionDispatchBlockLog(logger, {
      level: "INFO",
      eventType: "EXECUTION_DISPATCH_BLOCKED",
      message: "blocked",
      metadata: { intentId: "intent-1" }
    });
    emitExecutionDispatchBlockLog(logger, {
      level: "WARN",
      eventType: "TAKER_EXECUTION_SUPPRESSED",
      message: "suppressed",
      metadata: { intentId: "intent-2" }
    });

    expect(events).toEqual([
      {
        level: "INFO",
        eventType: "EXECUTION_DISPATCH_BLOCKED",
        message: "blocked",
        telemetry: { intentId: "intent-1" }
      },
      {
        level: "WARN",
        eventType: "TAKER_EXECUTION_SUPPRESSED",
        message: "suppressed",
        telemetry: { intentId: "intent-2" }
      }
    ]);
  });

  it("builds execution plan dispatch log metadata", () => {
    const intent = tradeIntent({ expectedValue: 0.42, approvedSize: 0.3 });

    expect(
      tradeIntentAuthorizedLogMetadata({
        intent,
        sorSavings: 0.12,
        intendedSize: 0.4,
        camouflagedSize: 0.3,
        icebergChildCount: 3,
        timingJitterMs: 25
      })
    ).toEqual({
      intentId: "intent-1",
      instrumentCode: "btc-usd",
      expectedValue: 0.42,
      approvedSize: 0.3,
      sorSavings: 0.12,
      intendedSize: 0.4,
      camouflagedSize: 0.3,
      icebergChildCount: 3,
      timingJitterMs: 25
    });
    expect(
      tradeIntentDispatchBlockedLogMetadata({
        intent,
        reason: "RISK_LIMIT"
      })
    ).toEqual({
      intentId: "intent-1",
      instrumentCode: "btc-usd",
      reason: "RISK_LIMIT"
    });
    expect(
      shadowTradeIntentAuthorizedLogMetadata({
        intent,
        icebergChildCount: 2
      })
    ).toEqual({
      intentId: "intent-1",
      instrumentCode: "btc-usd",
      expectedValue: 0.42,
      approvedSize: 0.3,
      icebergChildCount: 2
    });
  });

  it("builds executable dispatch actions for live, blocked, shadow, and inert plans", () => {
    const plan = executionPlan();

    expect(
      buildExecutionPlanDispatchAction({
        plan,
        dispatchGate: { allowed: true, reason: "DISPATCH_ALLOWED" },
        shadowReplay: false,
        tradingEnabled: true
      })
    ).toMatchObject({
      kind: "AUTHORIZED",
      metadata: {
        intentId: "intent-1",
        sorSavings: 0.12,
        icebergChildCount: 2,
        timingJitterMs: 25
      },
      childIntents: [{ intentId: "intent-child-1" }, { intentId: "intent-child-2" }],
      timingJitterMs: 25
    });
    expect(
      buildExecutionPlanDispatchAction({
        plan,
        dispatchGate: { allowed: false, reason: "RISK_LIMIT" },
        shadowReplay: false,
        tradingEnabled: true
      })
    ).toEqual({
      kind: "BLOCKED",
      metadata: {
        intentId: "intent-1",
        instrumentCode: "btc-usd",
        reason: "RISK_LIMIT"
      }
    });
    expect(
      buildExecutionPlanDispatchAction({
        plan,
        dispatchGate: { allowed: false, reason: "TRADING_DISABLED" },
        shadowReplay: true,
        tradingEnabled: false
      })
    ).toEqual({
      kind: "SHADOW",
      metadata: {
        intentId: "intent-1",
        instrumentCode: "btc-usd",
        expectedValue: 0,
        approvedSize: 1,
        icebergChildCount: 2
      }
    });
    expect(
      buildExecutionPlanDispatchAction({
        plan,
        dispatchGate: { allowed: false, reason: "TRADING_DISABLED" },
        shadowReplay: false,
        tradingEnabled: false
      })
    ).toEqual({ kind: "NONE" });
  });

  it("dispatches execution plan side effects through supplied handlers", async () => {
    const riskState = defaultEngineState("execution-dispatch-runtime-test");
    riskState.cachedConfig.TRADING_ENABLED = true;
    const scheduled: Promise<void>[] = [];
    const dispatched: string[] = [];
    const logs: {
      level: "INFO" | "WARN";
      eventType: string;
      telemetry?: Record<string, unknown>;
    }[] = [];

    dispatchExecutionPlanSideEffects({
      executionPlans: [executionPlan()],
      riskState,
      shadowReplay: false,
      tradingEnabled: true,
      handlers: {
        logger: {
          info(eventType, _message, telemetry) {
            logs.push({ level: "INFO", eventType, telemetry });
          },
          warn(eventType, _message, telemetry) {
            logs.push({ level: "WARN", eventType, telemetry });
          }
        },
        schedule(work) {
          scheduled.push(work);
        },
        async dispatchExecution(intent, timingJitterMs) {
          dispatched.push(`${intent.intentId}:${timingJitterMs}`);
        }
      }
    });

    await Promise.all(scheduled);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "INFO",
      eventType: "TRADE_INTENT_AUTHORIZED"
    });
    expect(logs[0]?.telemetry).toMatchObject({
      intentId: "intent-1",
      timingJitterMs: 25
    });
    expect(dispatched).toEqual(["intent-child-1:25", "intent-child-2:25"]);
  });

  it("dispatches execution plans through the trading engine target adapter", async () => {
    const engineState = defaultEngineState("execution-target-adapter");
    engineState.cachedConfig.TRADING_ENABLED = true;
    const scheduled: Promise<void>[] = [];
    const dispatched: string[] = [];
    const logs: string[] = [];
    const target: TradingExecutionPlanDispatchTarget = {
      engineState,
      cachedConfig: { TRADING_ENABLED: true },
      logger: {
        info(eventType, _message, telemetry) {
          logs.push(`info:${eventType}:${String(telemetry?.intentId)}`);
        },
        warn(eventType, _message, telemetry) {
          logs.push(`warn:${eventType}:${String(telemetry?.intentId)}`);
        }
      },
      state: {
        waitUntil(work) {
          scheduled.push(work);
        }
      },
      async dispatchExecution(intent, timingJitterMs) {
        dispatched.push(`${intent.intentId}:${timingJitterMs}`);
      }
    };

    dispatchTradingExecutionPlans([executionPlan()], false, target);

    await Promise.all(scheduled);

    expect(logs).toEqual(["info:TRADE_INTENT_AUTHORIZED:intent-1"]);
    expect(dispatched).toEqual(["intent-child-1:25", "intent-child-2:25"]);
  });

  it("emits block logs and skips trade intent dispatch side effects", async () => {
    const sideEffects = tradeDispatchSideEffectSpy();

    const decision = await dispatchTradeIntentSideEffects(
      {
        intent: tradeIntent({ instrumentCode: "eth-usd" }),
        hasExecutioner: true,
        tradingEnabled: true,
        hedgeEnabled: false,
        inventoryHedge: false,
        instrumentSelected: false,
        selectedInstruments: ["btc-usd"],
        initialDelayMs: 0
      },
      sideEffects.handlers
    );

    expect(decision.gate).toEqual({ allowed: false, reason: "MOLTWORKER_NOT_SELECTED" });
    expect(sideEffects.events).toEqual(["info:EXECUTION_DISPATCH_BLOCKED"]);
  });

  it("skips dispatch when the paper execution budget rejects the intent", async () => {
    const sideEffects = tradeDispatchSideEffectSpy({ paperBudgetAllowed: false });

    const decision = await dispatchTradeIntentSideEffects(
      {
        intent: tradeIntent(),
        hasExecutioner: true,
        tradingEnabled: true,
        hedgeEnabled: false,
        inventoryHedge: false,
        instrumentSelected: true,
        selectedInstruments: ["btc-usd"],
        initialDelayMs: 0
      },
      sideEffects.handlers
    );

    expect(decision.gate).toEqual({ allowed: true, reason: null });
    expect(sideEffects.events).toEqual(["paper:intent-1"]);
  });

  it("waits, persists rate limits, and dispatches allowed trade intents", async () => {
    const sideEffects = tradeDispatchSideEffectSpy();

    await dispatchTradeIntentSideEffects(
      {
        intent: tradeIntent({ source_exchange: "hyperliquid" }),
        hasExecutioner: true,
        tradingEnabled: true,
        hedgeEnabled: false,
        inventoryHedge: false,
        instrumentSelected: true,
        selectedInstruments: ["btc-usd"],
        initialDelayMs: 25
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual([
      "paper:intent-1",
      "wait:25",
      "reserve:hyperliquid:NEW",
      "persist",
      "dispatch:intent-1"
    ]);
  });

  it("enqueues trade intents when execution rate limits are exhausted", async () => {
    const sideEffects = tradeDispatchSideEffectSpy({
      reservation: { allowed: false, waitMs: 375 }
    });

    await dispatchTradeIntentSideEffects(
      {
        intent: tradeIntent({ source_exchange: undefined }),
        hasExecutioner: true,
        tradingEnabled: true,
        hedgeEnabled: false,
        inventoryHedge: false,
        instrumentSelected: true,
        selectedInstruments: ["btc-usd"],
        initialDelayMs: 0
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual([
      "paper:intent-1",
      "reserve:default:NEW",
      "persist",
      "enqueue:intent-1:NEW:375"
    ]);
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

function tradeDispatchSideEffectSpy(
  options: {
    paperBudgetAllowed?: boolean;
    reservation?: { allowed: boolean; waitMs: number };
  } = {}
): {
  events: string[];
  handlers: TradeIntentDispatchSideEffectHandlers;
} {
  const events: string[] = [];
  const paperBudgetAllowed = options.paperBudgetAllowed ?? true;
  const reservation = options.reservation ?? { allowed: true, waitMs: 0 };

  return {
    events,
    handlers: {
      logger: {
        info(eventType) {
          events.push(`info:${eventType}`);
        },
        warn(eventType) {
          events.push(`warn:${eventType}`);
        }
      },
      reservePaperExecutionBudget(intent) {
        events.push(`paper:${intent.intentId}`);
        return paperBudgetAllowed;
      },
      wait(ms) {
        events.push(`wait:${ms}`);
        return Promise.resolve();
      },
      reserveExecutionCapacity(exchangeKey, priority) {
        events.push(`reserve:${exchangeKey}:${priority}`);
        return reservation;
      },
      persistRateLimitState() {
        events.push("persist");
      },
      enqueueExecutionIntent(intent, priority, waitMs) {
        events.push(`enqueue:${intent.intentId}:${priority}:${waitMs}`);
        return Promise.resolve();
      },
      dispatchTradeIntent(intent) {
        events.push(`dispatch:${intent.intentId}`);
        return Promise.resolve();
      }
    }
  };
}

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

function blockLoggerSpy(): {
  logger: ExecutionDispatchBlockLogger;
  events: {
    level: "INFO" | "WARN";
    eventType: string;
    message: string;
    telemetry?: Record<string, unknown>;
  }[];
} {
  const events: {
    level: "INFO" | "WARN";
    eventType: string;
    message: string;
    telemetry?: Record<string, unknown>;
  }[] = [];
  return {
    logger: {
      info(eventType, message, telemetry) {
        events.push({ level: "INFO", eventType, message, telemetry });
      },
      warn(eventType, message, telemetry) {
        events.push({ level: "WARN", eventType, message, telemetry });
      }
    },
    events
  };
}

function executionPlan() {
  return {
    intent: tradeIntent(),
    sorPlan: {
      sorSavings: 0.12
    },
    camouflage: {
      intendedSize: 1,
      camouflagedSize: 0.75,
      timingJitterMs: 25,
      icebergChunks: [
        tradeIntent({ intentId: "intent-child-1" }),
        tradeIntent({ intentId: "intent-child-2" })
      ]
    }
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
