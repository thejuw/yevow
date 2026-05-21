import { describe, expect, it } from "vitest";
import {
  currentCascadeActiveSnapshot,
  currentCascadeHeatSnapshot,
  currentCascadePositionSnapshot,
  currentCascadeSignalSnapshot,
  currentTradingCascadeActiveSnapshotForTarget,
  currentTradingCascadeHeatSnapshotForTarget,
  currentTradingCascadePositionSnapshotForTarget
} from "../../src/engine/trading/cascade/CascadeSnapshots";
import type { AgentSignal } from "../../src/types";
import type {
  AbsorptionConfirmed,
  CascadeEvent,
  CascadeOpenPosition
} from "../../src/strategy/cascade/types";

const NOW = Date.parse("2026-05-18T17:00:00.000Z");

describe("CascadeSnapshots", () => {
  it("builds active cascade rows with phase filtering", () => {
    const rows = currentCascadeActiveSnapshot({
      events: [
        cascadeEvent({ cascadeId: "old", detectedAt: "2026-05-18T16:00:00.000Z" }),
        cascadeEvent({ cascadeId: "active", detectedAt: "2026-05-18T16:59:00.000Z" }),
        cascadeEvent({ cascadeId: "open", detectedAt: "2026-05-18T15:00:00.000Z" })
      ],
      absorptionsById: new Map([["active", absorption({ cascadeId: "active" })]]),
      positions: [position({ cascadeId: "open", status: "OPEN" })],
      maxAgeMs: 5 * 60_000,
      nowMs: NOW
    });

    expect(rows.map((row) => row.cascadeId)).toEqual(["active", "open"]);
    expect(rows[0]).toMatchObject({
      phase: "ABSORPTION_CONFIRMED",
      liquidationNotional: 12500000.12,
      zScore: 3.1235
    });
    expect(rows[1].phase).toBe("POSITION_OPEN");
  });

  it("filters and maps cascade signals", () => {
    const rows = currentCascadeSignalSnapshot(
      [
        signal({ signalId: "ignore", rationale: "ordinary quote" }),
        signal({ signalId: "one", featureVector: { cascadeId: "cascade-1" } }),
        signal({ signalId: "two", riskContext: { cascadeId: "cascade-2", outcome: "FILLED" } })
      ],
      1
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      signalId: "two",
      cascadeId: "cascade-2",
      outcome: "FILLED"
    });
  });

  it("adds mark-to-market fields to cascade positions", () => {
    const rows = currentCascadePositionSnapshot({
      positions: [position({ direction: "LONG", entryPrice: 100, remainingSize: 2, rDistance: 5 })],
      nowMs: NOW,
      markPriceForInstrument: () => 112
    });

    expect(rows[0]).toMatchObject({
      markPrice: 112,
      unrealizedPnl: 24,
      unrealizedR: 2.4
    });
    expect(typeof rows[0].timeToTimeStopMs).toBe("number");
  });

  it("summarizes cascade heat", () => {
    const heat = currentCascadeHeatSnapshot({
      positions: [
        position({ remainingSize: 2, rDistance: 5, status: "OPEN" }),
        position({ remainingSize: 3, rDistance: 10, status: "CLOSED" })
      ],
      currentHeatPct: 0.02,
      heatCapPct: 0.1,
      updatedAt: "2026-05-18T17:00:00.000Z"
    });

    expect(heat).toMatchObject({
      currentHeatPct: 0.02,
      heatCapPct: 0.1,
      percentOfCap: 0.2,
      openPositionCount: 1,
      remainingRiskUsd: 10
    });
  });

  it("builds cascade snapshots from a trading runtime target", () => {
    const target = {
      cascadeEventsById: new Map([
        ["active", cascadeEvent({ cascadeId: "active", detectedAt: "2026-05-18T16:59:00.000Z" })]
      ]),
      cascadeAbsorptionsById: new Map([["active", absorption({ cascadeId: "active" })]]),
      cascadePositionManager: {
        snapshot: () => [position({ cascadeId: "active", remainingSize: 1, rDistance: 4 })]
      },
      cascadeHeatManager: {
        currentHeat: () => 0.04
      },
      cachedConfig: {
        ABSORPTION_WINDOW_MS: 120_000,
        HEAT_CAP_PCT: 0.1
      },
      orderBook: new Map(),
      engineState: {
        assetMatrix: {},
        microstructure: {
          marketKey: null,
          instrumentCode: null,
          exchangeCode: null,
          source_exchange: null,
          sourceWeight: 0,
          bestBid: null,
          bestAsk: null,
          midPrice: null,
          spread: null,
          spreadBps: null,
          bidVolume: 0,
          askVolume: 0,
          weightedImbalance: null,
          depthLevels: 0,
          lastSequence: null,
          timeToBookMs: null,
          isSynced: false,
          updatedAt: null
        }
      }
    };

    expect(currentTradingCascadeActiveSnapshotForTarget(target, NOW)).toHaveLength(1);
    expect(currentTradingCascadePositionSnapshotForTarget(target, NOW)[0]).toMatchObject({
      cascadeId: "active",
      markPrice: null
    });
    expect(
      currentTradingCascadeHeatSnapshotForTarget(target, "2026-05-18T17:00:00.000Z")
    ).toMatchObject({
      currentHeatPct: 0.04,
      heatCapPct: 0.1,
      percentOfCap: 0.4
    });
  });
});

function cascadeEvent(overrides: Partial<CascadeEvent> = {}): CascadeEvent {
  return {
    schemaVersion: "cascade.event.v1",
    cascadeId: "cascade-1",
    instrumentCode: "btc-usd",
    direction: "LONG_LIQUIDATION",
    detectedAt: "2026-05-18T16:59:00.000Z",
    windowStartAt: "2026-05-18T16:58:00.000Z",
    windowEndAt: "2026-05-18T16:59:00.000Z",
    liquidationNotional: 12_500_000.123,
    liquidationCount: 7,
    zScore: 3.12345,
    priceAtStart: 100,
    priceAtPeak: 90,
    priceMoveAtr: 1.23456,
    directionalPct: 0.87555,
    rawEvents: [],
    ...overrides
  };
}

function absorption(overrides: Partial<AbsorptionConfirmed> = {}): AbsorptionConfirmed {
  return {
    schemaVersion: "cascade.absorption-confirmed.v1",
    cascadeId: "cascade-1",
    instrumentCode: "btc-usd",
    direction: "LONG_LIQUIDATION",
    confirmedAt: "2026-05-18T16:59:30.000Z",
    elapsedMs: 30_000,
    price: 101,
    criteria: {
      priceHeld: true,
      takerExhaustion: true,
      cvdReversal: true,
      openInterestStabilized: true
    },
    observations: 10,
    ...overrides
  };
}

function position(overrides: Partial<CascadeOpenPosition> = {}): CascadeOpenPosition {
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
    totalSize: 2,
    remainingSize: 2,
    initialRiskPct: 0.01,
    rDistance: 5,
    targets: {
      partial1: { price: 110, rMultiple: 2, sizePct: 0.33 },
      partial2: { price: 115, rMultiple: 3, sizePct: 0.33 },
      runner: { trailingType: "ATR", trailingParam: 2, sizePct: 0.34 }
    },
    timeStopAt: "2026-05-18T17:05:00.000Z",
    firstTargetTaken: false,
    secondTargetTaken: false,
    enteredAt: "2026-05-18T16:59:00.000Z",
    updatedAt: "2026-05-18T16:59:00.000Z",
    ...overrides
  };
}

function signal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return {
    signalId: "signal-1",
    traceId: "trace-1",
    sourceAgent: "CROUPIER",
    targetAgent: "PIT_BOSS",
    instrumentCode: "btc-usd",
    action: "EXECUTE",
    confidence: 0.8,
    horizonMs: 1_000,
    expectedValue: 1,
    maxSlippageBps: 5,
    rationale: "cascade recovery",
    featureVector: {},
    riskContext: {},
    createdAt: "2026-05-18T17:00:00.000Z",
    ...overrides
  };
}
