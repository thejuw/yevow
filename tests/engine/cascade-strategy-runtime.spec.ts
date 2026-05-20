import { describe, expect, it } from "vitest";
import {
  applyCascadePositionUpdateSideEffects,
  closedOneMinuteCandlesForTick,
  shouldEvaluateCascadeStrategy
} from "../../src/engine/trading/cascade/CascadeStrategyRuntime";
import type {
  Candle,
  CascadeOpenPosition,
  CascadePositionIntent
} from "../../src/strategy/cascade/types";

describe("CascadeStrategyRuntime", () => {
  it("gates cascade evaluation by strategy mode", () => {
    expect(shouldEvaluateCascadeStrategy("OFF")).toBe(false);
    expect(shouldEvaluateCascadeStrategy("MARKET_MAKING")).toBe(false);
    expect(shouldEvaluateCascadeStrategy("CASCADE_RECOVERY")).toBe(true);
  });

  it("selects only closed one-minute candles for the active tick instrument", () => {
    const btc = candle({ instrumentCode: "BTC-USD", timeframe: "1m" });
    const btcFiveMinute = candle({ instrumentCode: "btc-usd", timeframe: "5m" });
    const hype = candle({ instrumentCode: "hype-usd", timeframe: "1m" });

    expect(
      closedOneMinuteCandlesForTick([btcFiveMinute, hype, btc], { instrumentCode: "btc-usd" })
    ).toEqual([btc]);
  });

  it("dispatches cascade position close updates and persists changed positions", () => {
    const close = positionIntent("close", "STOP_LOSS", 1);
    const zeroClose = positionIntent("zero", "STOP_LOSS", 0);
    const stopUpdate = positionIntent("stop-update", undefined, 1, "STOP_UPDATE");
    const calls: string[] = [];

    applyCascadePositionUpdateSideEffects(
      [
        {
          position: position(),
          intents: [stopUpdate, zeroClose, close]
        }
      ],
      "2026-05-18T20:01:00.000Z",
      {
        dispatchCloseIntent(intent) {
          calls.push(`dispatch:${intent.intentId}`);
        },
        emitOperationalAlert(alert) {
          calls.push(`alert:${alert.eventType}:${alert.dedupeKey}`);
        },
        persistPositions() {
          calls.push("persist");
        }
      }
    );

    expect(calls).toEqual(["dispatch:close", "alert:STOP_HIT:position-1", "persist"]);
  });
});

function candle(overrides: Partial<Candle> = {}): Candle {
  return {
    instrumentCode: "btc-usd",
    timeframe: "1m",
    openedAt: "2026-05-18T20:00:00.000Z",
    closedAt: "2026-05-18T20:01:00.000Z",
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
    notionalVolume: 1_000,
    buyVolume: 6,
    sellVolume: 4,
    trades: 12,
    isClosed: true,
    ...overrides
  };
}

function position(): CascadeOpenPosition {
  return {
    positionId: "position-1",
    signalId: "signal-1",
    cascadeId: "cascade-1",
    instrumentCode: "btc-usd",
    direction: "LONG",
    status: "OPEN",
    entryPrice: 100,
    currentStopPrice: 95,
    initialStopPrice: 95,
    totalSize: 1,
    remainingSize: 1,
    initialRiskPct: 0.01,
    rDistance: 5,
    targets: {
      partial1: { price: 110, rMultiple: 2, sizePct: 0.5 },
      partial2: { price: 115, rMultiple: 3, sizePct: 0.25 },
      runner: { trailingType: "ATR", trailingParam: 2, sizePct: 0.25 }
    },
    timeStopAt: "2026-05-18T21:00:00.000Z",
    firstTargetTaken: false,
    secondTargetTaken: false,
    enteredAt: "2026-05-18T20:00:00.000Z",
    updatedAt: "2026-05-18T20:00:00.000Z"
  };
}

function positionIntent(
  intentId: string,
  closeReason: CascadePositionIntent["closeReason"],
  size: number,
  kind: CascadePositionIntent["kind"] = "CLOSE"
): CascadePositionIntent {
  return {
    intentId,
    positionId: "position-1",
    signalId: "signal-1",
    instrumentCode: "btc-usd",
    kind,
    closeReason,
    action: "SELL",
    orderType: "IOC",
    executionStyle: "TAKER_IOC",
    size,
    referencePrice: 99,
    createdAt: "2026-05-18T20:01:00.000Z"
  };
}
