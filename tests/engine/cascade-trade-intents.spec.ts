import { describe, expect, it } from "vitest";
import {
  buildCascadeEntryTradeIntent,
  buildCascadeExitTradeIntent
} from "../../src/engine/trading/cascade/CascadeTradeIntents";
import type {
  CascadePositionIntent,
  CascadeRecoverySignal
} from "../../src/strategy/cascade/types";

const OBSERVED_AT = "2026-05-18T18:00:00.000Z";

describe("CascadeTradeIntents", () => {
  it("builds IOC entry intents and slices large notionals", () => {
    const small = buildCascadeEntryTradeIntent({
      signal: signal({ direction: "LONG", entryPrice: 100, rDistance: 5, confidence: 0.7 }),
      size: 2,
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      exchangeFeeBps: 4,
      sliceNotionalThresholdUsd: 1_000,
      maxSlippageBps: 8
    });
    const sliced = buildCascadeEntryTradeIntent({
      signal: signal({ direction: "SHORT", entryPrice: 100, rDistance: 5, confidence: 0.7 }),
      size: 20,
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      exchangeFeeBps: 4,
      sliceNotionalThresholdUsd: 1_000,
      maxSlippageBps: 8
    });

    expect(small).toMatchObject({
      intentId: "cascade-entry-signal-1",
      traceId: "engine-1:cascade-entry:signal-1",
      action: "BUY",
      direction: "LONG",
      executionStyle: "TAKER_IOC",
      expectedValue: 5.5,
      executionCosts: 0.0004,
      maxSlippageBps: 8
    });
    expect(sliced).toMatchObject({
      action: "SELL",
      direction: "SHORT",
      executionStyle: "SLICED_TWAP"
    });
  });

  it("builds reduce-only style exit intents for partials and stops", () => {
    const partial = buildCascadeExitTradeIntent({
      intent: positionIntent({ executionStyle: "TAKER_IOC", closeReason: "FIRST_TARGET" }),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      exchangeFeeBps: 5,
      maxSlippageBps: 12
    });
    const stop = buildCascadeExitTradeIntent({
      intent: positionIntent({ executionStyle: "TAKER_MARKET", closeReason: "STOP_LOSS" }),
      observedAt: OBSERVED_AT,
      engineId: "engine-1",
      exchangeFeeBps: 5,
      maxSlippageBps: 12
    });

    expect(partial).toMatchObject({
      intentId: "cascade-exit-position-intent-1",
      orderType: "IOC",
      direction: "SHORT",
      rationale: "cascade FIRST_TARGET partial reduce-only"
    });
    expect(stop).toMatchObject({
      orderType: "MARKET",
      rationale: "cascade STOP_LOSS stop_loss reduce-only"
    });
  });
});

function signal(overrides: Partial<CascadeRecoverySignal> = {}): CascadeRecoverySignal {
  return {
    schemaVersion: "cascade.recovery-signal.v1",
    signalId: "signal-1",
    cascadeId: "cascade-1",
    instrumentCode: "btc-usd",
    direction: "LONG",
    triggerType: "VWAP_RECLAIM",
    entryPrice: 100,
    stopPrice: 95,
    rDistance: 5,
    targets: {
      partial1: { price: 110, rMultiple: 2, sizePct: 0.33 },
      partial2: { price: 115, rMultiple: 3, sizePct: 0.33 },
      runner: { trailingType: "ATR", trailingParam: 2, sizePct: 0.34 }
    },
    timeStopAt: "2026-05-18T20:00:00.000Z",
    confidence: 0.7,
    context: {},
    emittedAt: OBSERVED_AT,
    ...overrides
  };
}

function positionIntent(overrides: Partial<CascadePositionIntent> = {}): CascadePositionIntent {
  return {
    intentId: "position-intent-1",
    positionId: "position-1",
    signalId: "signal-1",
    instrumentCode: "btc-usd",
    kind: "CLOSE",
    closeReason: "FIRST_TARGET",
    action: "SELL",
    orderType: "IOC",
    executionStyle: "TAKER_IOC",
    size: 1,
    referencePrice: 110,
    createdAt: OBSERVED_AT,
    ...overrides
  };
}
