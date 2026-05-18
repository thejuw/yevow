import { describe, expect, it } from "vitest";
import {
  CascadeRecoverySignalEngine,
  defaultCascadeRecoverySignalConfig
} from "../../src/strategy/cascade/CascadeRecoverySignal";
import type {
  AbsorptionConfirmed,
  Candle,
  CascadeEvent,
  CascadeRecoverySignalConfig,
  CascadeRecoverySignalInput
} from "../../src/strategy/cascade/types";

describe("cascade recovery signal generation", () => {
  it("fires on a structural reclaim", () => {
    const result = engine().evaluate(baseInput());

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.signal.triggerType).toBe("STRUCTURAL_RECLAIM");
      expect(result.signal.direction).toBe("LONG");
    }
  });

  it("fires on a VWAP reclaim", () => {
    const input = baseInput({
      preCascadeSwingLow: 110,
      cascadeVwap: 97,
      recent1mCandles: [
        candle("2026-05-18T12:03:00.000Z", 96, 96.5, 95.5, 96, 10, 4, 6),
        candle("2026-05-18T12:04:00.000Z", 96, 99, 95.5, 98, 12, 8, 4)
      ]
    });

    const result = engine().evaluate(input);

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.signal.triggerType).toBe("VWAP_RECLAIM");
    }
  });

  it("fires on an impulsive reclaim bar", () => {
    const prior = Array.from({ length: 20 }, (_, index) =>
      candle(
        `2026-05-18T11:${String(40 + index).padStart(2, "0")}:00.000Z`,
        96,
        96.2,
        95.8,
        96,
        10,
        5,
        5
      )
    );
    const reclaim = candle("2026-05-18T12:04:00.000Z", 96, 101, 95.8, 100, 20, 18, 2);
    const input = baseInput({
      preCascadeSwingLow: null,
      cascadeVwap: null,
      atr1m: 2,
      recent1mCandles: [...prior, reclaim],
      reclaimCandle: reclaim
    });

    const result = engine().evaluate(input);

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.signal.triggerType).toBe("IMPULSIVE_BAR");
    }
  });

  it("vetoes every hard confirmation gate with an audit context", () => {
    const cases: [string, Partial<CascadeRecoverySignalInput>][] = [
      ["oracleRegime", { oracleRegime: "REGIME_CRISIS" }],
      ["cvdAlignment", { cvd1m: -1 }],
      ["openInterest", { openInterestDelta: -1 }],
      ["secondCascade", { recentSecondCascadeAt: "2026-05-18T12:03:30.000Z" }],
      ["newsBlackout", { majorNewsWithinBlackout: true }],
      ["realizedVolatility", { realizedVolPercentile1h: 0.99 }],
      ["dailyLossLimit", { dailyLossLimitBreached: true }],
      ["weeklyLossLimit", { weeklyLossLimitBreached: true }],
      ["entryWindow", { observedAt: "2026-05-18T14:00:00.000Z" }]
    ];

    for (const [gateName, overrides] of cases) {
      const result = engine().evaluate(baseInput(overrides));

      expect(result.accepted, gateName).toBe(false);
      if (!result.accepted) {
        expect(result.rejection.reasons).toContain(gateName);
        expect(result.rejection.context.gates).toBeTruthy();
      }
    }
  });

  it("rejects stops outside configured distance bounds", () => {
    const result = engine({ maxStopDistanceBps: 100 }).evaluate(baseInput());

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.rejection.reasons).toContain("STOP_DISTANCE_BPS");
      expect(result.rejection.context.stopGate).toBeTruthy();
    }
  });

  it("calculates R distance, 2R and 3R targets, and time stop", () => {
    const result = engine().evaluate(baseInput());

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.signal.entryPrice).toBe(98);
      expect(result.signal.stopPrice).toBe(94.5);
      expect(result.signal.rDistance).toBe(3.5);
      expect(result.signal.targets.partial1.price).toBe(105);
      expect(result.signal.targets.partial2.price).toBe(108.5);
      expect(result.signal.timeStopAt).toBe("2026-05-19T12:04:00.000Z");
    }
  });

  it("honors configured partial exits, runner size, and trailing-stop family", () => {
    const result = engine({
      partial1R: 1.5,
      partial1SizePct: 40,
      partial2R: 4,
      partial2SizePct: 25,
      runnerTrailingType: "EMA",
      runnerTrailingParam: 21,
      timeStopHours: 24
    }).evaluate(baseInput());

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.signal.targets.partial1).toEqual({
        price: 103.25,
        rMultiple: 1.5,
        sizePct: 40
      });
      expect(result.signal.targets.partial2).toEqual({ price: 112, rMultiple: 4, sizePct: 25 });
      expect(result.signal.targets.runner).toEqual({
        trailingType: "EMA",
        trailingParam: 21,
        sizePct: 35
      });
      expect(result.signal.timeStopAt).toBe("2026-05-19T12:04:00.000Z");
    }
  });

  it("constructs short-side recovery signals after short-liquidation squeezes", () => {
    const previous = candle("2026-05-18T12:03:00.000Z", 104, 104.5, 103.5, 104, 10, 6, 4);
    const reclaim = candle("2026-05-18T12:04:00.000Z", 104, 104.2, 101.5, 102, 12, 4, 8);
    const result = engine().evaluate(
      baseInput({
        cascade: {
          ...cascade(),
          cascadeId: "cascade:btc-usd:SHORT_LIQUIDATION:test",
          direction: "SHORT_LIQUIDATION",
          priceAtStart: 100,
          priceAtPeak: 105
        },
        absorption: { ...absorption(), direction: "SHORT_LIQUIDATION", price: 105 },
        reclaimCandle: reclaim,
        recent1mCandles: [previous, reclaim],
        preCascadeSwingLow: null,
        preCascadeSwingHigh: 103,
        cascadeVwap: 103,
        cvd1m: -4
      })
    );

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.signal.direction).toBe("SHORT");
      expect(result.signal.entryPrice).toBe(102);
      expect(result.signal.stopPrice).toBe(105.5);
      expect(result.signal.targets.partial1.price).toBe(95);
      expect(result.signal.targets.partial2.price).toBe(91.5);
    }
  });

  it("rejects entries when ATR makes stop placement unavailable", () => {
    const result = engine().evaluate(baseInput({ atr1h: null }));

    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.rejection.reasons).toContain("STOP_UNAVAILABLE");
      expect(result.rejection.context.stop).toBeNull();
    }
  });

  it("keeps all gate evaluations in the emitted signal context", () => {
    const result = engine().evaluate(baseInput());

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.signal.context.gates).toBeTruthy();
      expect(result.signal.context.inputs).toBeTruthy();
      expect(result.signal.context.triggers).toBeTruthy();
    }
  });
});

function engine(overrides: Partial<CascadeRecoverySignalConfig> = {}): CascadeRecoverySignalEngine {
  return new CascadeRecoverySignalEngine({
    ...defaultCascadeRecoverySignalConfig,
    maxStopDistanceBps: 600,
    ...overrides
  });
}

function baseInput(
  overrides: Partial<CascadeRecoverySignalInput> = {}
): CascadeRecoverySignalInput {
  const previous = candle("2026-05-18T12:03:00.000Z", 96, 97, 95.5, 96, 10, 4, 6);
  const reclaim = candle("2026-05-18T12:04:00.000Z", 96, 99, 95.5, 98, 12, 8, 4);

  return {
    cascade: cascade(),
    absorption: absorption(),
    reclaimCandle: reclaim,
    recent1mCandles: [previous, reclaim],
    atr1m: 1,
    atr1h: 2,
    preCascadeSwingLow: 97,
    preCascadeSwingHigh: null,
    cascadeVwap: 97,
    cvd1m: 4,
    openInterestDelta: 1,
    oracleRegime: "REGIME_RANGE",
    recentSecondCascadeAt: null,
    majorNewsWithinBlackout: false,
    realizedVolPercentile1h: 0.5,
    dailyLossLimitBreached: false,
    weeklyLossLimitBreached: false,
    observedAt: "2026-05-18T12:04:00.000Z",
    ...overrides
  };
}

function cascade(): CascadeEvent {
  return {
    schemaVersion: "cascade.event.v1",
    cascadeId: "cascade:btc-usd:LONG_LIQUIDATION:test",
    instrumentCode: "btc-usd",
    direction: "LONG_LIQUIDATION",
    detectedAt: "2026-05-18T12:00:00.000Z",
    windowStartAt: "2026-05-18T11:59:00.000Z",
    windowEndAt: "2026-05-18T12:00:00.000Z",
    liquidationNotional: 3_000_000,
    liquidationCount: 3,
    zScore: 5,
    priceAtStart: 100,
    priceAtPeak: 95,
    priceMoveAtr: 2.5,
    directionalPct: 1,
    rawEvents: []
  };
}

function absorption(): AbsorptionConfirmed {
  return {
    schemaVersion: "cascade.absorption-confirmed.v1",
    cascadeId: "cascade:btc-usd:LONG_LIQUIDATION:test",
    instrumentCode: "btc-usd",
    direction: "LONG_LIQUIDATION",
    confirmedAt: "2026-05-18T12:02:00.000Z",
    elapsedMs: 120_000,
    price: 95,
    criteria: {
      priceHeld: true,
      takerExhaustion: true,
      cvdReversal: true,
      openInterestStabilized: false
    },
    observations: 3
  };
}

function candle(
  openedAt: string,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  buyVolume: number,
  sellVolume: number
): Candle {
  return {
    instrumentCode: "btc-usd",
    timeframe: "1m",
    openedAt,
    closedAt: new Date(Date.parse(openedAt) + 60_000).toISOString(),
    open,
    high,
    low,
    close,
    volume,
    notionalVolume: close * volume,
    buyVolume,
    sellVolume,
    trades: 1,
    isClosed: true
  };
}
