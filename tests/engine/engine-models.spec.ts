import { describe, expect, it } from "vitest";
import {
  AdverseSelectionModel,
  adversePenaltyForQuoteSide
} from "../../src/engine/AdverseSelectionModel";
import {
  applyExecutionAccounting,
  buildSlippagePoint,
  executionQualityFromAccounting,
  mapManagedStatusToTradeStatus,
  stateAfterExecutionAccounting
} from "../../src/engine/ExecutionAccounting";
import {
  applyExecutionReportFlow,
  applyExecutionReportSideEffects,
  buildExecutionReportRuntimeUpdate,
  type ExecutionReportFlowHandlers,
  type ExecutionReportSideEffectHandlers
} from "../../src/engine/trading/execution/ExecutionReportRuntime";
import {
  applyTradingExecutionReportForTarget,
  type TradingExecutionReportTarget
} from "../../src/engine/trading/execution/TradingExecutionReportRuntime";
import { evaluateIntentDispatchGate } from "../../src/engine/IntentGeneration";
import { countOrderBookLevels } from "../../src/engine/OrderBookState";
import { QueuePositionModel } from "../../src/engine/QueuePositionModel";
import { buildReplayAblationSummary, calculateReplaySharpe } from "../../src/engine/Replay";
import { createShadowQueue, resolveShadowQueueConfig } from "../../src/engine/ShadowQueue";
import { defaultConfig } from "../../src/ConfigManager";
import type {
  EngineState,
  ExecutionReport,
  InternalOrderBook,
  InventoryState,
  ManagedOrder,
  QuoteSignal,
  ReplayResult,
  SentimentState,
  TradeIntent
} from "../../src/types";

describe("execution accounting", () => {
  it("opens a paper position, records slippage, and maps the execution report to a trade", () => {
    const observedAt = "2026-05-18T12:00:00.000Z";
    const intent = tradeIntent({
      intentId: "intent-open",
      action: "BUY",
      intendedPrice: 100,
      expectedPrice: 100,
      requestedSize: 1
    });
    const state = engineState({
      lastTradeIntent: intent,
      orderMap: {
        "order-open": managedOrder({
          clientId: "order-open",
          intentId: "intent-open",
          side: "BUY",
          price: 100,
          size: 1
        })
      }
    });
    const report: ExecutionReport = {
      clientId: "order-open",
      instrumentCode: "btc-usd",
      side: "BUY",
      status: "PARTIAL_FILL",
      filledSize: 0.5,
      achievedPrice: 101,
      expectedPrice: 100,
      fees: 0.05,
      latencyMs: 12,
      observedAt
    };

    const result = applyExecutionAccounting({
      state,
      report,
      observedAt,
      markPrice: () => 102
    });

    expect(result.fillIncrementSize).toBe(0.5);
    expect(result.openPositions["btc-usd"]).toMatchObject({
      side: "LONG",
      quantity: 0.5,
      averageEntryPrice: 101,
      markPrice: 102
    });
    expect(result.slippagePoint.slippageBps).toBe(100);
    expect(executionQualityFromAccounting(report, result)).toEqual({
      clientId: "order-open",
      instrumentCode: "btc-usd",
      expectedPrice: 100,
      achievedPrice: 101,
      slippageBps: 100,
      implementationShortfall: 1.05,
      latencyMs: 12,
      fees: 0.05,
      observedAt
    });
    expect(result.tradeExecution).toMatchObject({
      orderId: "order-open",
      status: "PARTIAL",
      primaryDriver: "CROUPIER",
      size: 0.5
    });
  });

  it("builds the execution report runtime update used by the durable object", () => {
    const observedAt = "2026-05-18T12:00:00.000Z";
    const state = engineState({
      lastTradeIntent: tradeIntent({ intentId: "intent-open" }),
      orderMap: {
        "order-open": managedOrder({
          clientId: "order-open",
          intentId: "intent-open",
          side: "BUY",
          price: 100,
          size: 1
        })
      }
    });
    state.oracle = { regime: "REGIME_RANGE" } as EngineState["oracle"];
    const inventory = inventoryState({ netDelta: 0.5, updatedAt: observedAt });
    const report: ExecutionReport = {
      clientId: "order-open",
      instrumentCode: "btc-usd",
      side: "BUY",
      status: "FILLED",
      filledSize: 0.5,
      achievedPrice: 101,
      expectedPrice: 100,
      fees: 0.05,
      latencyMs: 12,
      observedAt
    };

    const update = buildExecutionReportRuntimeUpdate({
      state,
      report,
      markPrice: () => 102,
      calculateInventory: (inventoryObservedAt, openPositions) => {
        expect(inventoryObservedAt).toBe(observedAt);
        expect(openPositions["btc-usd"]?.quantity).toBe(0.5);
        return inventory;
      }
    });

    expect(update.accounting.tradeExecution.status).toBe("FILLED");
    expect(update.executionQuality.implementationShortfall).toBe(1.05);
    expect(update.adverseSelectionMarkPrice).toBe(102);
    expect(update.nextState.inventory).toBe(inventory);
  });

  it("applies execution report side effects in engine order", async () => {
    const observedAt = "2026-05-18T12:00:00.000Z";
    const state = engineState({
      lastTradeIntent: tradeIntent({ intentId: "intent-open" }),
      orderMap: {
        "order-open": managedOrder({
          clientId: "order-open",
          intentId: "intent-open",
          side: "BUY",
          price: 100,
          size: 1
        })
      }
    });
    const report: ExecutionReport = {
      clientId: "order-open",
      instrumentCode: "btc-usd",
      side: "BUY",
      status: "FILLED",
      filledSize: 0.5,
      achievedPrice: 101,
      expectedPrice: 100,
      fees: 0.05,
      latencyMs: 12,
      observedAt
    };
    const update = buildExecutionReportRuntimeUpdate({
      state,
      report,
      markPrice: () => 102,
      calculateInventory: () => inventoryState({ netDelta: 0.5, updatedAt: observedAt })
    });
    const sideEffects = executionReportSideEffectSpy();

    await applyExecutionReportSideEffects(
      {
        report,
        update,
        oracleRegime: "REGIME_RANGE"
      },
      sideEffects.handlers
    );

    expect(sideEffects.events).toEqual([
      "adverse:order-open:102:REGIME_RANGE",
      "quality:order-open",
      "state:FILLED",
      "record:order-open",
      "publish:order-open"
    ]);
  });

  it("orchestrates execution report flow through accounting and side effects", async () => {
    const observedAt = "2026-05-18T12:00:00.000Z";
    const state = engineState({
      lastTradeIntent: tradeIntent({ intentId: "intent-open" }),
      orderMap: {
        "order-open": managedOrder({
          clientId: "order-open",
          intentId: "intent-open",
          side: "BUY",
          price: 100,
          size: 1
        })
      }
    });
    const report: ExecutionReport = {
      clientId: "order-open",
      instrumentCode: "btc-usd",
      side: "BUY",
      status: "FILLED",
      filledSize: 0.5,
      achievedPrice: 101,
      expectedPrice: 100,
      fees: 0.05,
      latencyMs: 12,
      observedAt
    };
    const flow = executionReportFlowSpy(observedAt);

    const update = await applyExecutionReportFlow(
      {
        state,
        report,
        oracleRegime: "REGIME_RANGE"
      },
      flow.handlers
    );

    expect(update.accounting.tradeExecution.status).toBe("FILLED");
    expect(update.inventory.netDelta).toBe(0.5);
    expect(flow.events).toEqual([
      "inventory:2026-05-18T12:00:00.000Z:0.5",
      "adverse:order-open:102:REGIME_RANGE",
      "quality:order-open",
      "state:FILLED",
      "record:order-open",
      "publish:order-open"
    ]);
  });

  it("applies execution reports through the trading target adapter", async () => {
    const observedAt = "2026-05-18T12:00:00.000Z";
    const calls: string[] = [];
    const state = engineState({
      lastTradeIntent: tradeIntent({ intentId: "intent-open" }),
      orderMap: {
        "order-open": managedOrder({
          clientId: "order-open",
          intentId: "intent-open",
          side: "BUY",
          price: 100,
          size: 1
        })
      }
    });
    state.oracle = { regime: "REGIME_RANGE" } as EngineState["oracle"];
    const target: TradingExecutionReportTarget = {
      engineState: state,
      orderBook: new Map(),
      adverseSelectionModel: {
        observeExecutionReport(_report, order, markPrice, oracleRegime) {
          calls.push(`adverse:${order.clientId}:${markPrice}:${oracleRegime}`);
        }
      },
      logger: {
        recordExecutionQuality(record) {
          calls.push(`quality:${record.clientId}`);
        },
        recordExecution(execution) {
          calls.push(`record:${execution.tradeId}`);
        }
      },
      calculateInventoryState(inventoryObservedAt, openPositions) {
        calls.push(
          `inventory:${inventoryObservedAt}:${openPositions["btc-usd"]?.quantity ?? "missing"}`
        );
        return inventoryState({ netDelta: 0.5, updatedAt: observedAt });
      },
      async safeStoragePut(key, _value, reason) {
        calls.push(`persist:${key}:${reason}`);
      },
      publish(type, _payload, correlationId) {
        calls.push(`publish:${type}:${correlationId ?? "none"}`);
      }
    };

    await applyTradingExecutionReportForTarget(
      {
        clientId: "order-open",
        instrumentCode: "btc-usd",
        side: "BUY",
        status: "FILLED",
        filledSize: 0.5,
        achievedPrice: 101,
        expectedPrice: 100,
        fees: 0.05,
        latencyMs: 12,
        observedAt
      },
      target
    );

    expect(target.engineState.orderMap["order-open"]?.status).toBe("FILLED");
    expect(calls).toEqual([
      "inventory:2026-05-18T12:00:00.000Z:0.5",
      "adverse:order-open:100:REGIME_RANGE",
      "quality:order-open",
      "persist:engine:state:EXECUTION_REPORT",
      "record:execution:order-open:local:FILLED:1779105600000",
      "publish:TRADE_EXECUTION_UPDATE:execution:order-open:local:FILLED:1779105600000"
    ]);
  });

  it("realizes pnl when a fill closes an existing position", () => {
    const observedAt = "2026-05-18T12:01:00.000Z";
    const state = engineState({
      bankroll: {
        currency: "USD",
        cash: 900,
        equity: 1_000,
        realizedPnl: 0,
        updatedAt: observedAt
      },
      openPositions: {
        "btc-usd": {
          instrumentCode: "btc-usd",
          side: "LONG",
          quantity: 1,
          averageEntryPrice: 100,
          markPrice: 100,
          unrealizedPnl: 0,
          realizedPnl: 0,
          updatedAt: observedAt
        }
      },
      orderMap: {
        "order-close": managedOrder({
          clientId: "order-close",
          side: "SELL",
          price: 110,
          size: 1,
          filledSize: 0
        })
      }
    });

    const result = applyExecutionAccounting({
      state,
      report: {
        clientId: "order-close",
        instrumentCode: "btc-usd",
        side: "SELL",
        status: "FILLED",
        filledSize: 1,
        achievedPrice: 110,
        expectedPrice: 109,
        fees: 0.1,
        observedAt
      },
      observedAt,
      markPrice: () => 110
    });

    expect(result.realizedPnlDelta).toBe(9.9);
    expect(result.openPositions["btc-usd"]).toBeUndefined();
    expect(result.bankroll.realizedPnl).toBe(9.9);
    expect(result.tradeExecution.resultingPnl).toBe(9.9);
  });

  it("handles rejected and accepted status mapping without mutating portfolio state", () => {
    const order = managedOrder({
      side: "SELL",
      price: 100,
      size: 1,
      filledSize: 0
    });
    const slippage = buildSlippagePoint(
      {
        clientId: order.clientId,
        status: "REJECTED",
        achievedPrice: 99,
        expectedPrice: 100,
        observedAt: "2026-05-18T12:02:00.000Z"
      },
      order
    );

    expect(slippage.slippageBps).toBe(100);
    expect(mapManagedStatusToTradeStatus("PENDING")).toBe("ACCEPTED");
    expect(mapManagedStatusToTradeStatus("OPEN")).toBe("ACCEPTED");
    expect(mapManagedStatusToTradeStatus("GHOST_FILL")).toBe("GHOST_FILL");
    expect(mapManagedStatusToTradeStatus("CANCELLED")).toBe("CANCELLED");
    expect(mapManagedStatusToTradeStatus("REJECTED")).toBe("REJECTED");
  });

  it("handles order lookup by exchange id, invalid fill data, flips, and driver inference", () => {
    const observedAt = "manual-clock";
    const baseState = engineState({
      bankroll: {
        currency: "USD",
        cash: 1_100,
        equity: 1_000,
        realizedPnl: 0,
        updatedAt: "2026-05-18T12:00:00.000Z"
      },
      openPositions: {
        "btc-usd": {
          instrumentCode: "btc-usd",
          side: "LONG",
          quantity: 1,
          averageEntryPrice: 100,
          markPrice: 100,
          unrealizedPnl: 0,
          realizedPnl: 0,
          updatedAt: "2026-05-18T12:00:00.000Z"
        }
      },
      lastTradeIntent: tradeIntent({
        intentId: "profiler-intent",
        traceId: "profiler-alert",
        rationale: "profiler toxicity exit"
      }),
      orderMap: {
        local: managedOrder({
          clientId: "local",
          exchangeOrderId: "exchange-flip",
          intentId: "profiler-intent",
          side: "SELL",
          price: 95,
          size: 2
        })
      },
      slippage: {
        schemaVersion: "slippage.v1",
        points: [
          {
            expectedPrice: 100,
            achievedPrice: 99,
            slippageBps: 100,
            implementationShortfall: 1,
            latencyMs: 1,
            observedAt: "2026-05-18T11:59:00.000Z"
          }
        ],
        averageSlippageBps: 100,
        latencyCorrelation: null,
        executionCostBufferBps: 200,
        updatedAt: "2026-05-18T11:59:00.000Z"
      }
    });

    const flipped = applyExecutionAccounting({
      state: baseState,
      report: {
        clientId: "remote-id",
        exchangeOrderId: "exchange-flip",
        instrumentCode: "btc-usd",
        status: "GHOST_FILL",
        fillIncrementSize: 2,
        filledSize: 2,
        achievedPrice: 95,
        expectedPrice: Number.POSITIVE_INFINITY,
        fees: 0,
        observedAt
      },
      observedAt,
      markPrice: () => 94
    });

    expect(flipped.openPositions["btc-usd"]).toMatchObject({
      side: "SHORT",
      quantity: 1,
      averageEntryPrice: 95
    });
    expect(flipped.tradeExecution.primaryDriver).toBe("PROFILER");
    expect(flipped.tradeExecution.tradeId).toContain("manual-clock");
    expect(flipped.tradeExecution.price).toBe(95);
    expect(flipped.slippage.executionCostBufferBps).toBe(200);

    const rejected = applyExecutionAccounting({
      state: engineState({
        orderMap: {
          "intent-1:hedge": managedOrder({
            clientId: "intent-1:hedge",
            side: "BUY",
            price: 0,
            size: 0
          })
        },
        lastTradeIntent: tradeIntent({ rationale: "inventory hedge" })
      }),
      report: {
        clientId: "intent-1:hedge",
        status: "REJECTED",
        achievedPrice: 0,
        expectedPrice: 0,
        orderSize: 0,
        reason: "risk",
        rawStatus: "nope",
        observedAt
      },
      observedAt,
      markPrice: () => 0
    });

    expect(rejected.tradeExecution.primaryDriver).toBe("RISK");
    expect(rejected.tradeExecution.status).toBe("REJECTED");
    expect(rejected.tradeExecution.price).toBe(0.00000001);

    const executioner = applyExecutionAccounting({
      state: engineState(),
      report: {
        clientId: "unknown-order",
        status: "OPEN",
        orderSize: 5,
        achievedPrice: 50,
        expectedPrice: 50,
        observedAt
      },
      observedAt,
      markPrice: () => 50
    });

    expect(executioner.tradeExecution.primaryDriver).toBe("EXECUTIONER");
    expect(executioner.tradeExecution.size).toBe(5);
  });

  it("merges execution accounting results back into engine state", () => {
    const observedAt = "2026-05-18T12:03:00.000Z";
    const state = engineState({
      orderMap: {
        "order-open": managedOrder({
          clientId: "order-open",
          side: "BUY",
          price: 100,
          size: 1
        })
      }
    });
    const accounting = applyExecutionAccounting({
      state,
      report: {
        clientId: "order-open",
        instrumentCode: "btc-usd",
        side: "BUY",
        status: "FILLED",
        filledSize: 1,
        achievedPrice: 100,
        expectedPrice: 100,
        observedAt
      },
      observedAt,
      markPrice: () => 101
    });
    const inventory = {
      ...state.inventory,
      current_inventory_delta: 1,
      updatedAt: observedAt
    };

    expect(stateAfterExecutionAccounting({ state, accounting, inventory })).toMatchObject({
      bankroll: accounting.bankroll,
      openPositions: accounting.openPositions,
      inventory,
      current_inventory_delta: 1,
      orderMap: accounting.orderMap,
      slippage: accounting.slippage,
      updatedAt: observedAt,
      heartbeatAt: observedAt
    });
  });
});

describe("intent dispatch gate", () => {
  it("blocks inactive, halted, critical, suspended, and non-passive intents", () => {
    const intent = tradeIntent();
    const active = dispatchState();

    expect(evaluateIntentDispatchGate(active, intent)).toEqual({
      allowed: true,
      reason: "DISPATCH_ALLOWED"
    });
    expect(evaluateIntentDispatchGate({ ...active, mode: "HALTED" }, intent).reason).toBe(
      "ENGINE_HALTED"
    );
    expect(
      evaluateIntentDispatchGate(
        { ...active, cachedConfig: { ...defaultConfig, TRADING_ENABLED: false } },
        intent
      ).reason
    ).toBe("TRADING_DISABLED");
    expect(
      evaluateIntentDispatchGate(
        { ...active, citadel: { ...active.citadel, status: "CRITICAL" } },
        intent
      ).reason
    ).toBe("CITADEL_CRITICAL");
    expect(
      evaluateIntentDispatchGate(
        {
          ...active,
          quoteState: {
            status: "SUSPENDED",
            reason: "TEST_SUSPENSION",
            suspendedUntil: null,
            lastQuote: null,
            updatedAt: null
          }
        },
        intent
      ).reason
    ).toBe("TEST_SUSPENSION");
    expect(
      evaluateIntentDispatchGate(
        active,
        tradeIntent({ orderType: "IOC", timeInForce: "IOC", postOnly: false })
      ).reason
    ).toBe("PASSIVE_ONLY_PROTOCOL");
  });
});

describe("adverse selection model", () => {
  it("uses bounded samples and falls back to all-regime buckets until specific evidence matures", () => {
    const model = new AdverseSelectionModel();
    model.observe({
      instrumentCode: "btc-usd",
      side: "BUY",
      regime: "REGIME_TREND",
      expectedPrice: 0,
      achievedPrice: 100,
      markPrice: 100,
      observedAt: "2026-05-18T12:00:00.000Z"
    });
    expect(model.penaltyFor("btc-usd", "BUY", "REGIME_TREND", "not-a-date")).toMatchObject({
      penaltyBps: 0,
      sampleCount: 0
    });

    for (let index = 0; index < 9; index += 1) {
      model.observe({
        instrumentCode: "btc-usd",
        side: "BUY",
        regime: "REGIME_TREND",
        expectedPrice: 100,
        achievedPrice: 100 + index,
        markPrice: 100 + index,
        observedAt: "2026-05-18T12:00:00.000Z"
      });
    }

    const specific = model.penaltyFor("btc-usd", "BUY", "REGIME_TREND", "2026-05-18T12:15:00.000Z");
    const fallback = model.penaltyFor("btc-usd", "BUY", "REGIME_RANGE", "2026-05-18T12:15:00.000Z");

    expect(specific.sampleCount).toBe(9);
    expect(specific.penaltyBps).toBeGreaterThan(0);
    expect(fallback.bucketKey).toBe("btc-usd:BUY:ALL:ALL");
    expect(fallback.sampleCount).toBe(9);
  });

  it("maps bid and ask quote sides to execution-side penalties", () => {
    const model = new AdverseSelectionModel();
    const book = internalBook();
    model.observeExecutionReport(
      {
        clientId: "ask-fill",
        side: "SELL",
        status: "FILLED",
        achievedPrice: 99,
        expectedPrice: 100,
        observedAt: "2026-05-18T12:00:00.000Z"
      },
      managedOrder({ clientId: "ask-fill", side: "SELL", price: 100, size: 1 }),
      99,
      "REGIME_TREND"
    );

    expect(
      adversePenaltyForQuoteSide(model, book, "ASK", "REGIME_RANGE", "2026-05-18T12:00:00.000Z")
        .penaltyBps
    ).toBeGreaterThan(0);
    expect(
      adversePenaltyForQuoteSide(model, book, "BID", "REGIME_RANGE", "2026-05-18T12:00:00.000Z")
        .penaltyBps
    ).toBe(0);
  });
});

describe("queue position model", () => {
  it("refreshes only when price motion or queue pressure justifies losing priority", () => {
    const model = new QueuePositionModel();
    const quote = quoteSignal();
    const book = internalBook();

    expect(
      model.adviseRefresh({
        previousQuote: null,
        quote,
        book,
        minPriceTicks: 2,
        elapsedMs: 0,
        tickSize: 1
      }).reason
    ).toBe("NO_PRIOR");
    expect(
      model.adviseRefresh({
        previousQuote: { bid: 98, ask: 102, updatedAtMs: 0 },
        quote,
        book,
        minPriceTicks: 1,
        elapsedMs: 100,
        tickSize: 1
      }).reason
    ).toBe("MID_MOVED");
    expect(
      model.adviseRefresh({
        previousQuote: { bid: 99, ask: 101, updatedAtMs: 0 },
        quote: quoteSignal({ size: 20 }),
        book,
        minPriceTicks: 5,
        elapsedMs: 300,
        tickSize: 1
      }).reason
    ).toBe("QUEUE_FAR_STALE");
    expect(
      model.adviseRefresh({
        previousQuote: { bid: 99, ask: 101, updatedAtMs: 0 },
        quote: quoteSignal({ size: 0.01 }),
        book,
        minPriceTicks: 5,
        elapsedMs: 300,
        tickSize: 1
      }).reason
    ).toBe("HOLD_FRONT_OF_QUEUE");
    expect(
      model.adviseRefresh({
        previousQuote: { bid: 99, ask: 101, updatedAtMs: 0 },
        quote,
        book: null,
        minPriceTicks: 5,
        elapsedMs: 100,
        tickSize: 1
      }).reason
    ).toBe("UNCHANGED");
  });
});

describe("engine support utilities", () => {
  it("counts order book levels across book sides", () => {
    expect(
      countOrderBookLevels(
        [new Map([["99", 1]])],
        [
          new Map([
            ["101", 1],
            ["102", 2]
          ])
        ]
      )
    ).toBe(3);
  });

  it("clamps shadow queue configuration and creates a typed-array backed queue", () => {
    const config = resolveShadowQueueConfig({
      SHADOW_VLO_CAPACITY: "2",
      SHADOW_VLO_DRIFT_TRADES: "1000",
      SHADOW_VLO_QUEUE_DEPTH_MULTIPLIER: "12",
      SHADOW_VLO_BASE_SPREAD_BPS: "-1",
      SHADOW_VLO_LATENCY_BUDGET_MS: "0",
      SHADOW_VLO_MIN_SIZE: "0"
    } as unknown as Parameters<typeof resolveShadowQueueConfig>[0]);
    const queue = createShadowQueue({ SHADOW_VLO_CAPACITY: "128" } as unknown as Parameters<
      typeof createShadowQueue
    >[0]);

    expect(config).toMatchObject({
      capacity: 128,
      driftTradeDelay: 100,
      queueDepthMultiplier: 10,
      baseSpreadBps: 1,
      latencyBudgetMs: 5,
      minSize: 0.00000001
    });
    expect(queue.snapshot().capacity).toBe(128);
  });

  it("summarizes replay sharpe and sentiment ablation without hidden state", () => {
    const trades: ReplayResult["shadowTrades"] = [
      shadowTrade("one", 3, "SENTIMENT"),
      shadowTrade("two", -1, "CROUPIER"),
      shadowTrade("three", 2, "SENTIMENT")
    ];
    const sentiment = {
      schemaVersion: "sentiment.v1",
      score: 0.4,
      bias: "BULLISH",
      confidence: 0.8,
      headline: "test",
      model: "lexical",
      estimatedCostUsd: 0.25,
      updatedAt: "2026-05-18T12:00:00.000Z"
    } satisfies SentimentState;

    expect(calculateReplaySharpe([1, -1, 2, 3])).toBeGreaterThan(0);
    expect(calculateReplaySharpe([1])).toBeNull();
    expect(buildReplayAblationSummary(trades, sentiment)).toMatchObject({
      sentimentEnabledPnl: 5,
      sentimentDisabledPnl: -1,
      deltaPnl: 5,
      estimatedAiCostUsd: 0.25,
      netEdgeAfterCosts: 4.75
    });
  });
});

function executionReportSideEffectSpy(): {
  events: string[];
  handlers: ExecutionReportSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      observeAdverseSelection(_report, order, markPrice, oracleRegime) {
        events.push(`adverse:${order.clientId}:${markPrice}:${oracleRegime}`);
      },
      recordExecutionQuality(record) {
        events.push(`quality:${record.clientId}`);
      },
      applyState(state) {
        events.push(`state:${state.orderMap["order-open"]?.status ?? "MISSING"}`);
        return Promise.resolve();
      },
      recordExecution(tradeExecution) {
        events.push(`record:${tradeExecution.orderId}`);
      },
      publishTradeExecution(tradeExecution) {
        events.push(`publish:${tradeExecution.orderId}`);
      }
    }
  };
}

function executionReportFlowSpy(observedAt: string): {
  events: string[];
  handlers: ExecutionReportFlowHandlers;
} {
  const sideEffects = executionReportSideEffectSpy();
  const events = sideEffects.events;

  return {
    events,
    handlers: {
      ...sideEffects.handlers,
      markPrice() {
        return 102;
      },
      calculateInventory(inventoryObservedAt, openPositions) {
        events.push(
          `inventory:${inventoryObservedAt}:${openPositions["btc-usd"]?.quantity ?? "missing"}`
        );
        return inventoryState({ netDelta: 0.5, updatedAt: observedAt });
      }
    }
  };
}

function engineState(overrides: Partial<EngineState> = {}): EngineState {
  const now = "2026-05-18T12:00:00.000Z";
  return {
    engineId: "test-engine",
    mode: "PAPER",
    bankroll: {
      currency: "USD",
      cash: 1_000,
      equity: 1_000,
      realizedPnl: 0,
      updatedAt: now
    },
    openPositions: {},
    orderMap: {},
    lastTradeIntent: null,
    slippage: {
      schemaVersion: "slippage.v1",
      points: [],
      averageSlippageBps: 0,
      latencyCorrelation: null,
      executionCostBufferBps: 0,
      updatedAt: null
    },
    microstructure: {
      marketKey: "hyperliquid:btc-usd",
      instrumentCode: "btc-usd",
      exchangeCode: "BTC",
      source_exchange: "hyperliquid",
      sourceWeight: 1,
      bestBid: 99,
      bestAsk: 101,
      midPrice: 100,
      spread: 2,
      spreadBps: 200,
      bidVolume: 5,
      askVolume: 5,
      weightedImbalance: 0,
      depthLevels: 2,
      lastSequence: 1,
      timeToBookMs: 1,
      isSynced: true,
      updatedAt: now
    },
    ...overrides
  } as EngineState;
}

function dispatchState(): Pick<EngineState, "mode" | "cachedConfig" | "citadel" | "quoteState"> {
  return {
    mode: "PAPER",
    cachedConfig: {
      ...defaultConfig,
      TRADING_ENABLED: true
    },
    citadel: {
      status: "NOMINAL",
      reason: null,
      shadowMode: true,
      lastEvacuationAt: null,
      updatedAt: null
    },
    quoteState: {
      status: "ACTIVE",
      reason: null,
      suspendedUntil: null,
      lastQuote: null,
      updatedAt: null
    }
  };
}

function managedOrder(overrides: Partial<ManagedOrder> = {}): ManagedOrder {
  return {
    clientId: "order-1",
    exchangeOrderId: null,
    intentId: "intent-1",
    instrumentCode: "btc-usd",
    side: "BUY",
    price: 100,
    size: 1,
    filledSize: 0,
    status: "PENDING",
    createdAt: "2026-05-18T12:00:00.000Z",
    updatedAt: "2026-05-18T12:00:00.000Z",
    ackDeadlineAt: "2026-05-18T12:00:05.000Z",
    ...overrides
  };
}

function inventoryState(overrides: Partial<InventoryState> = {}): InventoryState {
  return {
    netDelta: 0,
    current_inventory_delta: 0,
    baseAsset: "BTC",
    normalization: {},
    maxInventoryUnits: 1,
    maxInventoryDelta: 1,
    inventoryPenalty: 0,
    stopBid: false,
    stopAsk: false,
    updatedAt: null,
    ...overrides
  };
}

function tradeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    schemaVersion: "trade-intent.v1",
    intentId: "intent-1",
    traceId: "trace-croupier",
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    source_exchange: "hyperliquid",
    direction: "LONG",
    executionStyle: "POST_ONLY_QUOTE",
    action: "BUY",
    orderType: "LIMIT",
    postOnly: true,
    timeInForce: "ALO",
    intendedPrice: 100,
    expectedPrice: 100,
    requestedSize: 1,
    approvedSize: null,
    probabilityWin: 0.55,
    probabilityLoss: 0.45,
    profit: 2,
    loss: 1,
    executionCosts: 0.1,
    adverseSelectionCost: 0.1,
    expectedValue: 0.2,
    minEvThreshold: 0.01,
    maxSlippageBps: 5,
    confidence: 0.7,
    rationale: "croupier quote",
    createdAt: "2026-05-18T12:00:00.000Z",
    ...overrides
  };
}

function internalBook(): InternalOrderBook {
  return {
    marketKey: "hyperliquid:btc-usd",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceWeight: 1,
    instrumentCode: "btc-usd",
    exchangeCode: "BTC",
    bids: [
      { price: 99, size: 1, updatedAt: "2026-05-18T12:00:00.000Z" },
      { price: 98, size: 2, updatedAt: "2026-05-18T12:00:00.000Z" }
    ],
    asks: [
      { price: 101, size: 1, updatedAt: "2026-05-18T12:00:00.000Z" },
      { price: 102, size: 2, updatedAt: "2026-05-18T12:00:00.000Z" }
    ],
    bestBid: 99,
    bestAsk: 101,
    midPrice: 100,
    spread: 2,
    spreadBps: 200,
    weightedImbalance: 0,
    lastSequence: 1,
    tickSize: 1,
    ttbLatencyMs: 1,
    isSynced: true,
    sequence: 1,
    updatedAt: "2026-05-18T12:00:00.000Z"
  };
}

function quoteSignal(overrides: { size?: number } = {}): QuoteSignal {
  const size = overrides.size ?? 1;
  return {
    schemaVersion: "quote-signal.v1",
    signalId: "quote-1",
    instrumentCode: "btc-usd",
    marketKey: "hyperliquid:btc-usd",
    reservationPrice: 100,
    optimalSpread: 2,
    orders: [
      {
        clientOrderId: "bid-1",
        side: "BID",
        price: 99,
        size,
        postOnly: true
      },
      {
        clientOrderId: "ask-1",
        side: "ASK",
        price: 101,
        size,
        postOnly: true
      }
    ],
    createdAt: "2026-05-18T12:00:00.000Z"
  };
}

function shadowTrade(
  tradeId: string,
  theoreticalPnl: number,
  driver: ReplayResult["shadowTrades"][number]["driver"]
): ReplayResult["shadowTrades"][number] {
  return {
    tradeId,
    instrumentCode: "btc-usd",
    side: "BUY",
    entryPrice: 100,
    exitPrice: 101,
    size: 1,
    theoreticalPnl,
    driver,
    openedAt: "2026-05-18T12:00:00.000Z",
    closedAt: "2026-05-18T12:01:00.000Z"
  };
}
