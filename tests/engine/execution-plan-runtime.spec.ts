import { describe, expect, it, vi } from "vitest";
import {
  buildApprovedExecutionPlan,
  buildExecutionPlanArtifacts,
  buildManagedOrders,
  executionAckDeadline,
  executionChildrenFromRoutePlan,
  shouldSkipExecutionPlanForQuoteSuspension,
  sorResidualLiquidityShortfallLogMetadata
} from "../../src/engine/trading/execution/ExecutionPlanRuntime";
import { defaultEngineState } from "../../src/TradingEngineRuntimeHelpers";
import type { CamouflageResult } from "../../src/utils/Camouflage";
import type { SorPlan } from "../../src/utils/SOR";
import type { TradeIntent } from "../../src/types";
import type { PitBossDecision } from "../../src/agents/PitBossAgent";

const OBSERVED_AT = "2026-05-18T14:00:00.000Z";
const ACK_DEADLINE_AT = "2026-05-18T14:00:01.500Z";

describe("ExecutionPlanRuntime", () => {
  it("builds SOR child intents from routed liquidity", () => {
    const children = executionChildrenFromRoutePlan(camouflage(), {
      routes: [
        {
          marketKey: "hyperliquid:btc-usd",
          source_exchange: "hyperliquid",
          size: 0.25,
          expectedPrice: 100.25
        },
        {
          marketKey: "binance:btc-usdt",
          source_exchange: "binance",
          size: 0.15,
          expectedPrice: 100.3
        }
      ],
      bestSingleExchangePrice: 100.25,
      aggregatePrice: 100.26875,
      sorSavings: 0.01875,
      unfilledSize: 0
    });

    expect(children).toMatchObject([
      {
        intentId: "intent-1:sor:1",
        marketKey: "hyperliquid:btc-usd",
        source_exchange: "hyperliquid",
        intendedPrice: 100.25,
        expectedPrice: 100.25,
        requestedSize: 0.25,
        approvedSize: 0.25,
        rationale: "parent-intent; SOR child 1/2"
      },
      {
        intentId: "intent-1:sor:2",
        marketKey: "binance:btc-usdt",
        source_exchange: "binance",
        intendedPrice: 100.3,
        expectedPrice: 100.3,
        requestedSize: 0.15,
        approvedSize: 0.15,
        rationale: "parent-intent; SOR child 2/2"
      }
    ]);
  });

  it("falls back to iceberg chunks when no SOR route is available", () => {
    const input = camouflage({
      icebergChunks: [tradeIntent({ intentId: "intent-1:iceberg:1", approvedSize: 0.2 })]
    });

    expect(executionChildrenFromRoutePlan(input, emptySorPlan())).toBe(input.icebergChunks);
  });

  it("builds managed pending orders with the parent intent linkage", () => {
    expect(
      buildManagedOrders({
        parentIntentId: "intent-1",
        chunks: [
          tradeIntent({
            intentId: "intent-1:sor:1",
            action: "BUY",
            expectedPrice: 100,
            approvedSize: 0.1
          }),
          tradeIntent({
            intentId: "intent-1:sor:2",
            action: "SELL",
            expectedPrice: 101,
            approvedSize: null,
            requestedSize: 0.2
          })
        ],
        observedAt: OBSERVED_AT,
        ackDeadlineAt: ACK_DEADLINE_AT
      })
    ).toEqual([
      {
        clientId: "intent-1:sor:1",
        exchangeOrderId: null,
        intentId: "intent-1",
        instrumentCode: "btc-usd",
        side: "BUY",
        price: 100,
        size: 0.1,
        filledSize: 0,
        status: "PENDING",
        createdAt: OBSERVED_AT,
        updatedAt: OBSERVED_AT,
        ackDeadlineAt: ACK_DEADLINE_AT
      },
      {
        clientId: "intent-1:sor:2",
        exchangeOrderId: null,
        intentId: "intent-1",
        instrumentCode: "btc-usd",
        side: "SELL",
        price: 101,
        size: 0.2,
        filledSize: 0,
        status: "PENDING",
        createdAt: OBSERVED_AT,
        updatedAt: OBSERVED_AT,
        ackDeadlineAt: ACK_DEADLINE_AT
      }
    ]);
  });

  it("builds the routed camouflage and ack deadline together", () => {
    const artifacts = buildExecutionPlanArtifacts({
      camouflage: camouflage(),
      sorPlan: emptySorPlan(),
      observedAt: OBSERVED_AT,
      ackTimeoutMs: 1_500
    });

    expect(executionAckDeadline(OBSERVED_AT, 1_500)).toBe(ACK_DEADLINE_AT);
    expect(artifacts.camouflage.icebergChunks).toHaveLength(1);
    expect(artifacts.orders[0]).toMatchObject({
      clientId: "intent-1:iceberg:1",
      intentId: "intent-1",
      ackDeadlineAt: ACK_DEADLINE_AT
    });
  });

  it("builds approved execution plans with residual SOR metadata", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const intent = tradeIntent({ requestedSize: 1, approvedSize: 1, expectedPrice: 100 });

    try {
      const plan = buildApprovedExecutionPlan({
        pitBossDecision: pitBossDecision({ approved: true, intent }),
        orderBooks: [
          {
            marketKey: "hyperliquid:btc-usd",
            source_exchange: "hyperliquid",
            instrumentCode: "btc-usd",
            exchangeCode: "hl",
            sourceWeight: 1,
            bestBid: 99.9,
            bestAsk: 100,
            midPrice: 99.95,
            spread: 0.1,
            bids: [{ price: 99.9, size: 0.2 }],
            asks: [{ price: 100, size: 0.4 }],
            weightedImbalance: 0,
            imbalance: 0,
            depth: 2,
            sequence: 1,
            exchangeTimestamp: OBSERVED_AT,
            receivedAt: OBSERVED_AT,
            updatedAt: OBSERVED_AT
          }
        ],
        observedAt: OBSERVED_AT,
        ackTimeoutMs: 1_500
      });

      expect(plan).toMatchObject({
        intent: { intentId: "intent-1" },
        sorPlan: {
          routes: [{ marketKey: "hyperliquid:btc-usd", size: 0.4 }],
          unfilledSize: 0.6
        },
        residualLogMetadata: {
          intentId: "intent-1",
          instrumentCode: "btc-usd",
          approvedSize: 1,
          unfilledSize: 0.6
        }
      });
      expect(plan?.orders[0]).toMatchObject({
        clientId: "intent-1:sor:1",
        size: 0.4,
        ackDeadlineAt: ACK_DEADLINE_AT
      });
      expect(
        buildApprovedExecutionPlan({
          pitBossDecision: pitBossDecision({ approved: false }),
          orderBooks: [],
          observedAt: OBSERVED_AT,
          ackTimeoutMs: 1_500
        })
      ).toBeNull();
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("gates execution planning on suspended quote state unless explicitly bypassed", () => {
    const state = defaultEngineState("execution-plan-test");
    state.assetQuoteStates["btc-usd"] = {
      status: "SUSPENDED",
      reason: "PROFILER_ALERT",
      suspendedUntil: "2026-05-18T14:01:00.000Z",
      lastQuote: null,
      updatedAt: OBSERVED_AT
    };

    expect(
      shouldSkipExecutionPlanForQuoteSuspension({
        intent: tradeIntent(),
        riskState: state,
        observedAt: OBSERVED_AT
      })
    ).toBe(true);
    expect(
      shouldSkipExecutionPlanForQuoteSuspension({
        intent: tradeIntent(),
        riskState: state,
        observedAt: OBSERVED_AT,
        bypassQuoteSuspension: true
      })
    ).toBe(false);
    expect(
      shouldSkipExecutionPlanForQuoteSuspension({
        intent: null,
        riskState: state,
        observedAt: OBSERVED_AT
      })
    ).toBe(false);
  });

  it("builds SOR residual liquidity shortfall metadata", () => {
    expect(
      sorResidualLiquidityShortfallLogMetadata({
        intent: tradeIntent({ approvedSize: null, requestedSize: 0.4 }),
        unfilledSize: 0.1
      })
    ).toEqual({
      intentId: "intent-1",
      instrumentCode: "btc-usd",
      approvedSize: 0.4,
      unfilledSize: 0.1
    });
  });
});

function pitBossDecision(overrides: Partial<PitBossDecision> = {}): PitBossDecision {
  return {
    approved: true,
    intent: tradeIntent({ approvedSize: 0.4 }),
    kellyFraction: 0.1,
    cappedFraction: 0.05,
    capitalAllocationPct: 1,
    assetMaxNotional: 100,
    reason: "approved",
    ...overrides
  };
}

function emptySorPlan(): SorPlan {
  return {
    routes: [],
    bestSingleExchangePrice: null,
    aggregatePrice: null,
    sorSavings: 0,
    unfilledSize: 0
  };
}

function camouflage(overrides: Partial<CamouflageResult> = {}): CamouflageResult {
  return {
    intent: tradeIntent(),
    intendedSize: 0.4,
    camouflagedSize: 0.4,
    timingJitterMs: 10,
    icebergChunks: [tradeIntent({ intentId: "intent-1:iceberg:1", approvedSize: 0.4 })],
    ...overrides
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
    requestedSize: 0.4,
    approvedSize: 0.4,
    probabilityWin: 0.55,
    probabilityLoss: 0.45,
    profit: 1,
    loss: 1,
    executionCosts: 0.01,
    adverseSelectionCost: 0.01,
    expectedValue: 0.1,
    minEvThreshold: 0,
    maxSlippageBps: 5,
    confidence: 0.7,
    rationale: "parent-intent",
    createdAt: OBSERVED_AT,
    ...overrides
  };
}
