import { describe, expect, it } from "vitest";
import { AbsorptionAnalyzer } from "../../src/strategy/cascade/AbsorptionAnalyzer";
import { CascadeDetector } from "../../src/strategy/cascade/CascadeDetector";
import {
  HyperliquidLiquidationStream,
  isHyperliquidLiquidationMessage
} from "../../src/strategy/cascade/LiquidationStream";
import type {
  AbsorptionObservation,
  CascadeDetectorConfig,
  CascadeEvent,
  LiquidationEvent
} from "../../src/strategy/cascade/types";

describe("cascade liquidation stream", () => {
  it("normalizes Hyperliquid liquidation packets into compact cascade events", () => {
    const stream = new HyperliquidLiquidationStream();
    const raw = {
      channel: "liquidations",
      data: [
        {
          type: "liquidation",
          lid: "abc",
          markPx: "100",
          liquidated_ntl_pos: "2500000",
          liquidatedPositions: [{ coin: "BTC", szi: "25" }]
        }
      ]
    };

    expect(isHyperliquidLiquidationMessage(raw)).toBe(true);

    const events = stream.ingest(raw, {
      observedAt: "2026-05-18T12:00:00.000Z",
      sourceExchange: "hyperliquid"
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: "liq:abc",
      instrumentCode: "btc-usd",
      side: "LONG",
      forcedFlowSide: "SELL",
      price: 100,
      notionalUsd: 2_500_000,
      baseSize: 25
    });
  });
});

describe("cascade detector", () => {
  it("fires on a synthetic liquidation cluster meeting all thresholds", () => {
    const detector = seededDetector();
    const cascade = pushLongFlush(detector, "2026-05-18T12:00:00.000Z");

    expect(cascade).not.toBeNull();
    expect(cascade).toMatchObject({
      instrumentCode: "btc-usd",
      direction: "LONG_LIQUIDATION",
      liquidationCount: 3,
      liquidationNotional: 3_300_000
    });
    expect(cascade?.zScore).toBeGreaterThan(2);
    expect(cascade?.priceMoveAtr).toBeGreaterThanOrEqual(1);
  });

  it("does not fire on aggregate notional without time concentration", () => {
    const detector = seededDetector();
    let cascade: CascadeEvent | null = null;

    for (let index = 0; index < 4; index += 1) {
      cascade = detector.observe(
        liquidation(
          `spread-${index}`,
          new Date(Date.parse("2026-05-18T12:00:00.000Z") + index * 70_000).toISOString(),
          100 - index,
          900_000,
          "LONG"
        ),
        {
          observedAt: new Date(
            Date.parse("2026-05-18T12:00:00.000Z") + index * 70_000
          ).toISOString(),
          atr1h: 2
        }
      );
    }

    expect(cascade).toBeNull();
  });

  it("excludes the current window from the z-score baseline", () => {
    const detector = seededDetector();
    const cascade = pushLongFlush(detector, "2026-05-18T12:00:00.000Z");

    expect(cascade?.zScore).toBeGreaterThan(10);
  });

  it("excludes mixed forced-flow events that lack directional concentration", () => {
    const detector = seededDetector();
    const base = Date.parse("2026-05-18T12:00:00.000Z");
    let cascade: CascadeEvent | null = null;

    for (let index = 0; index < 4; index += 1) {
      const side = index % 2 === 0 ? "LONG" : "SHORT";
      const observedAt = new Date(base + index * 5_000).toISOString();
      cascade = detector.observe(
        liquidation(`mixed-${index}`, observedAt, side === "LONG" ? 98 : 102, 800_000, side),
        { observedAt, atr1h: 2 }
      );
    }

    expect(cascade).toBeNull();
  });

  it("keeps separate cascade events distinct during replay-style deleveraging clusters", () => {
    const detector = seededDetector({ minCascadeSeparationMs: 60_000 });

    const first = pushLongFlush(detector, "2026-05-18T12:00:00.000Z");
    const second = pushLongFlush(detector, "2026-05-18T12:05:00.000Z", "second");

    expect(first?.cascadeId).toBeTruthy();
    expect(second?.cascadeId).toBeTruthy();
    expect(first?.cascadeId).not.toBe(second?.cascadeId);
  });

  it("does not fire before the configured baseline window count is available", () => {
    const detector = seededDetector({ minBaselineWindows: 99 });
    const cascade = pushLongFlush(detector, "2026-05-18T12:00:00.000Z");

    expect(cascade).toBeNull();
  });

  it("requires the liquidation cluster to move price by the configured ATR multiple", () => {
    const detector = seededDetector({ minPriceMoveAtr: 5 });
    const cascade = pushLongFlush(detector, "2026-05-18T12:00:00.000Z");

    expect(cascade).toBeNull();
  });

  it("fires short-liquidation cascades with forced buy flow", () => {
    const detector = seededDetector();
    const cascade = pushShortSqueeze(detector, "2026-05-18T12:00:00.000Z");

    expect(cascade).toMatchObject({
      instrumentCode: "btc-usd",
      direction: "SHORT_LIQUIDATION",
      liquidationCount: 3
    });
    expect(cascade?.priceAtPeak).toBeGreaterThan(cascade?.priceAtStart ?? 0);
  });
});

describe("cascade absorption analyzer", () => {
  it("confirms absorption through taker exhaustion", () => {
    const analyzer = analyzerWith(cascade());
    const result = observeSeries(analyzer, [
      obs("2026-05-18T12:00:00.000Z", 97, 0, 100, -100, 1_000),
      obs("2026-05-18T12:01:00.000Z", 97.1, 0, 50, -80, 1_020),
      obs("2026-05-18T12:02:00.000Z", 97.05, 0, 10, -70, 1_025)
    ]);

    expect(result?.criteria).toMatchObject({
      priceHeld: true,
      takerExhaustion: true
    });
  });

  it("confirms absorption through CVD reversal", () => {
    const analyzer = analyzerWith(cascade());
    const result = observeSeries(analyzer, [
      obs("2026-05-18T12:00:00.000Z", 97, 0, 20, -100, 1_000),
      obs("2026-05-18T12:01:00.000Z", 97.1, 0, 20, -20, 1_100),
      obs("2026-05-18T12:02:00.000Z", 97.05, 0, 20, 10, 1_200)
    ]);

    expect(result?.criteria).toMatchObject({
      priceHeld: true,
      cvdReversal: true
    });
  });

  it("confirms absorption through open-interest stabilization", () => {
    const analyzer = analyzerWith(cascade());
    const result = observeSeries(analyzer, [
      obs("2026-05-18T12:00:00.000Z", 97, 0, 20, -100, 1_000),
      obs("2026-05-18T12:01:00.000Z", 97.1, 0, 20, -90, 1_000.2),
      obs("2026-05-18T12:02:00.000Z", 97.05, 0, 20, -80, 1_000.1)
    ]);

    expect(result?.criteria).toMatchObject({
      priceHeld: true,
      openInterestStabilized: true
    });
  });

  it("does not confirm when price fails to hold the cascade extreme", () => {
    const analyzer = analyzerWith(cascade());
    const result = observeSeries(analyzer, [
      obs("2026-05-18T12:00:00.000Z", 99, 0, 100, -100, 1_000),
      obs("2026-05-18T12:01:00.000Z", 99.5, 0, 50, -80, 1_020),
      obs("2026-05-18T12:02:00.000Z", 100, 0, 10, -70, 1_025)
    ]);

    expect(result).toBeNull();
  });

  it("expires cascades after the absorption window elapses", () => {
    const analyzer = analyzerWith(cascade());

    const result = analyzer.observe(obs("2026-05-18T12:11:00.000Z", 97, 0, 10, 0, 1_000));

    expect(result).toBeNull();
    expect(analyzer.activeCascadeIds()).toEqual([]);
  });

  it("caps active cascades to the configured maximum", () => {
    const analyzer = new AbsorptionAnalyzer({
      absorptionWindowMs: 10 * 60_000,
      priceBandBps: 20,
      minHoldSeconds: 120,
      oiStabilityBps: 5,
      maxActiveCascades: 1
    });

    analyzer.trackCascade(cascade());
    analyzer.trackCascade({ ...cascade(), cascadeId: "cascade:newer" });

    expect(analyzer.activeCascadeIds()).toEqual(["cascade:newer"]);
  });
});

function seededDetector(overrides: Partial<CascadeDetectorConfig> = {}): CascadeDetector {
  const detector = new CascadeDetector({
    windowMs: 60_000,
    notionalThresholdUsd: 2_000_000,
    zScoreThreshold: 2,
    lookbackHours: 1,
    directionalPct: 0.75,
    minPriceMoveAtr: 1,
    minBaselineWindows: 10,
    minCascadeSeparationMs: 60_000,
    maxEventsPerInstrument: 1_000,
    ...overrides
  });

  for (let index = 0; index < 12; index += 1) {
    const observedAt = new Date(
      Date.parse("2026-05-18T11:00:00.000Z") + index * 5 * 60_000
    ).toISOString();
    detector.observe(liquidation(`baseline-${index}`, observedAt, 100, 100_000, "LONG"), {
      observedAt,
      atr1h: 2
    });
  }

  return detector;
}

function pushLongFlush(
  detector: CascadeDetector,
  startAt: string,
  prefix = "cluster"
): CascadeEvent | null {
  const base = Date.parse(startAt);
  let cascade: CascadeEvent | null = null;

  for (let index = 0; index < 3; index += 1) {
    const observedAt = new Date(base + index * 10_000).toISOString();
    cascade = detector.observe(
      liquidation(`${prefix}-${index}`, observedAt, 100 - index * 1.5, 1_100_000, "LONG"),
      { observedAt, atr1h: 2 }
    );
  }

  return cascade;
}

function pushShortSqueeze(detector: CascadeDetector, startAt: string): CascadeEvent | null {
  const base = Date.parse(startAt);
  let cascadeEvent: CascadeEvent | null = null;

  for (let index = 0; index < 3; index += 1) {
    const observedAt = new Date(base + index * 10_000).toISOString();
    cascadeEvent = detector.observe(
      liquidation(`short-${index}`, observedAt, 100 + index * 1.5, 1_100_000, "SHORT"),
      { observedAt, atr1h: 2 }
    );
  }

  return cascadeEvent;
}

function analyzerWith(cascadeEvent: CascadeEvent): AbsorptionAnalyzer {
  const analyzer = new AbsorptionAnalyzer({
    absorptionWindowMs: 10 * 60_000,
    priceBandBps: 20,
    minHoldSeconds: 120,
    oiStabilityBps: 5,
    maxActiveCascades: 4
  });
  analyzer.trackCascade(cascadeEvent);
  return analyzer;
}

function observeSeries(
  analyzer: AbsorptionAnalyzer,
  observations: AbsorptionObservation[]
): ReturnType<AbsorptionAnalyzer["observe"]> {
  let result: ReturnType<AbsorptionAnalyzer["observe"]> = null;
  for (const observation of observations) {
    result = analyzer.observe(observation) ?? result;
  }
  return result;
}

function cascade(): CascadeEvent {
  return {
    schemaVersion: "cascade.event.v1",
    cascadeId: "cascade:test",
    instrumentCode: "btc-usd",
    direction: "LONG_LIQUIDATION",
    detectedAt: "2026-05-18T12:00:00.000Z",
    windowStartAt: "2026-05-18T11:59:00.000Z",
    windowEndAt: "2026-05-18T12:00:00.000Z",
    liquidationNotional: 3_000_000,
    liquidationCount: 3,
    zScore: 5,
    priceAtStart: 100,
    priceAtPeak: 97,
    priceMoveAtr: 1.5,
    directionalPct: 1,
    rawEvents: []
  };
}

function obs(
  observedAt: string,
  price: number,
  takerBuyVolume: number,
  takerSellVolume: number,
  cumulativeVolumeDelta: number,
  openInterest: number
): AbsorptionObservation {
  return {
    instrumentCode: "btc-usd",
    observedAt,
    price,
    takerBuyVolume,
    takerSellVolume,
    cumulativeVolumeDelta,
    openInterest
  };
}

function liquidation(
  eventId: string,
  observedAt: string,
  price: number,
  notionalUsd: number,
  side: "LONG" | "SHORT"
): LiquidationEvent {
  return {
    schemaVersion: "cascade.liquidation-event.v1",
    eventId,
    instrumentCode: "btc-usd",
    sourceExchange: "hyperliquid",
    side,
    forcedFlowSide: side === "LONG" ? "SELL" : "BUY",
    price,
    notionalUsd,
    baseSize: notionalUsd / price,
    exchangeTimestamp: observedAt,
    observedAt,
    raw: {}
  };
}
