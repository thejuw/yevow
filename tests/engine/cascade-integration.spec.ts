import { describe, expect, it } from "vitest";
import { Backtester, type BacktestConfig } from "../../src/strategy/cascade/Backtester";
import {
  HyperliquidLiquidationStream,
  isHyperliquidLiquidationMessage
} from "../../src/strategy/cascade/LiquidationStream";
import { CASCADE_NEWS_CALENDAR_KEY, NewsCalendar } from "../../src/strategy/cascade/NewsCalendar";
import type { Candle, LiquidationEvent, OpenInterestPoint } from "../../src/strategy/cascade/types";

describe("cascade news calendar", () => {
  it("blocks signals during scheduled high-impact blackouts", async () => {
    const calendar = new NewsCalendar(
      mockKv({
        [CASCADE_NEWS_CALENDAR_KEY]: {
          schemaVersion: "cascade.news-calendar.v1",
          updatedAt: "2026-05-18T00:00:00.000Z",
          events: [
            {
              eventId: "fomc-test",
              title: "FOMC operator blackout",
              category: "FOMC",
              impact: "HIGH",
              startsAt: "2026-05-18T18:00:00.000Z",
              endsAt: "2026-05-18T19:00:00.000Z",
              assets: ["*"],
              source: "OPERATOR",
              createdAt: "2026-05-18T00:00:00.000Z",
              createdBy: "test"
            }
          ]
        }
      })
    );

    await calendar.refresh(true);

    expect(calendar.isWithinBlackout(new Date("2026-05-18T18:30:00.000Z"), "BTC")).toMatchObject({
      blocked: true,
      reason: "FOMC operator blackout"
    });
    expect(calendar.isWithinBlackout(new Date("2026-05-18T20:00:00.000Z"), "BTC")).toEqual({
      blocked: false
    });
  });

  it("normalizes ad-hoc operator blackouts and ignores malformed calendar rows", async () => {
    const calendar = new NewsCalendar(
      mockKv({
        [CASCADE_NEWS_CALENDAR_KEY]: {
          schemaVersion: "cascade.news-calendar.v1",
          updatedAt: "2026-05-18T00:00:00.000Z",
          events: [
            {
              eventId: "bad-window",
              title: "invalid",
              category: "FOMC",
              impact: "HIGH",
              startsAt: "2026-05-18T19:00:00.000Z",
              endsAt: "2026-05-18T18:00:00.000Z",
              assets: ["BTC"],
              source: "OPERATOR",
              createdAt: "2026-05-18T00:00:00.000Z",
              createdBy: "test"
            }
          ]
        }
      })
    );

    const payload = await calendar.addAdHocBlackout({
      title: "HYPE unlock volatility",
      startsAt: "2026-05-18T18:00:00.000Z",
      endsAt: "2026-05-18T18:30:00.000Z",
      assets: ["hype", "HYPE", " "],
      createdBy: "moltworker"
    });

    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({
      title: "HYPE unlock volatility",
      impact: "HIGH",
      assets: ["HYPE"],
      createdBy: "moltworker"
    });
    expect(calendar.isWithinBlackout(new Date("2026-05-18T18:05:00.000Z"), "HYPE").blocked).toBe(
      true
    );
  });
});

describe("hyperliquid liquidation stream", () => {
  it("parses, sanitizes, and deduplicates liquidation payload shapes", () => {
    const stream = new HyperliquidLiquidationStream();
    const raw = {
      channel: "events",
      data: {
        liquidations: [
          {
            lid: "liq-1",
            coin: "BTC",
            side: "sell",
            markPx: "94.25",
            liquidated_ntl_pos: "2000000",
            time: Date.parse("2026-05-18T12:00:00.000Z")
          },
          {
            lid: "liq-1",
            coin: "BTC",
            side: "sell",
            markPx: "94.25",
            liquidated_ntl_pos: "2000000",
            time: Date.parse("2026-05-18T12:00:00.000Z")
          },
          {
            eventId: "liq-2",
            liquidatedPositions: [{ coin: "ETH", szi: "-25" }],
            price: 3_200,
            notionalUsd: 80_000,
            timestamp: "2026-05-18T12:00:01.000Z"
          }
        ]
      }
    };

    expect(isHyperliquidLiquidationMessage(raw)).toBe(true);
    const events = stream.ingest(raw, {
      observedAt: "2026-05-18T12:00:02.000Z",
      sourceExchange: "hyperliquid"
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      eventId: "liq:liq-1",
      instrumentCode: "btc-usd",
      side: "LONG",
      forcedFlowSide: "SELL",
      price: 94.25,
      notionalUsd: 2_000_000
    });
    expect(events[1]).toMatchObject({
      eventId: "liq:liq-2",
      instrumentCode: "eth-usd",
      side: "SHORT",
      forcedFlowSide: "BUY"
    });
  });

  it("rejects non-liquidation and incomplete records without throwing", () => {
    const stream = new HyperliquidLiquidationStream();

    expect(isHyperliquidLiquidationMessage({ channel: "trades", data: [] })).toBe(false);
    expect(
      stream.ingest(
        {
          data: {
            events: [
              { type: "liquidation", coin: "BTC", side: "buy", price: 0, notionalUsd: 1_000 },
              { delta: { type: "liquidation", coin: "BTC", szi: 2 } }
            ]
          }
        },
        {
          instrumentCode: "btc-usd",
          fallbackPrice: 100,
          observedAt: "2026-05-18T12:00:00.000Z"
        }
      )
    ).toHaveLength(1);
  });
});

describe("cascade backtester", () => {
  it("replays liquidation evidence without inventing missing source data", async () => {
    const backtester = new Backtester(mockD1());
    const fixture = replayFixture();

    const report = await backtester.run({
      fromDate: "2025-10-10T00:00:00.000Z",
      toDate: "2025-10-11T00:00:00.000Z",
      instruments: ["btc-usd"],
      startingEquity: 10_000,
      candles: fixture.candles,
      liquidations: fixture.liquidations,
      openInterest: fixture.openInterest,
      config: replayConfig()
    });

    expect(report.dataQuality).toMatchObject({
      source: "REQUEST_PAYLOAD",
      liquidationCount: fixture.liquidations.length,
      openInterestCount: fixture.openInterest.length
    });
    expect(report.cascades.length).toBeGreaterThanOrEqual(1);
    expect(report.signals.length).toBeGreaterThanOrEqual(1);
    expect(report.trades.some((trade) => trade.status === "ENTRY")).toBe(true);
    expect(report.validation.checks.find((check) => check.id === "liquidations_present")?.ok).toBe(
      true
    );
  });

  it("honors the strategy mode gate", async () => {
    const backtester = new Backtester(mockD1());
    const fixture = replayFixture();

    const report = await backtester.run({
      fromDate: "2025-10-10T00:00:00.000Z",
      toDate: "2025-10-11T00:00:00.000Z",
      instruments: ["btc-usd"],
      startingEquity: 10_000,
      candles: fixture.candles,
      liquidations: fixture.liquidations,
      openInterest: fixture.openInterest,
      config: { strategyMode: "MARKET_MAKING" }
    });

    expect(report.trades).toHaveLength(0);
    expect(report.totalPnl).toBe(0);
  });

  it("emits parameter sensitivity rows for walk-forward tuning review", async () => {
    const backtester = new Backtester(mockD1());
    const fixture = replayFixture();

    const report = await backtester.run({
      fromDate: "2025-10-10T00:00:00.000Z",
      toDate: "2025-10-11T00:00:00.000Z",
      instruments: ["btc-usd"],
      startingEquity: 10_000,
      candles: fixture.candles,
      liquidations: fixture.liquidations,
      openInterest: fixture.openInterest,
      config: replayConfig({ riskPerTradePct: 0.01 })
    });

    expect(report.parameterSensitivity.map((row) => row.value)).toEqual([0.005, 0.01, 0.015]);
    expect(report.metadata.safetyGatesHonored).toBe(true);
  });

  it("marks candle-only runs as non-final instead of hallucinating cascades", async () => {
    const backtester = new Backtester(mockD1());
    const fixture = replayFixture();

    const report = await backtester.run({
      fromDate: "2025-10-10T00:00:00.000Z",
      toDate: "2025-10-11T00:00:00.000Z",
      instruments: ["btc-usd"],
      startingEquity: 10_000,
      candles: fixture.candles,
      config: replayConfig()
    });

    expect(report.cascades).toHaveLength(0);
    expect(report.signals).toHaveLength(0);
    expect(report.validation.ok).toBe(false);
    expect(report.validation.checks.find((check) => check.id === "liquidations_present")?.ok).toBe(
      false
    );
  });
});

function mockKv(seed: Record<string, unknown>): KVNamespace {
  const store = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    get: async (key: string, type?: "text" | "json") => {
      const value = store.get(key) ?? null;
      return type === "json" && value ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    }
  } as unknown as KVNamespace;
}

function mockD1(): D1Database {
  return {
    prepare: () =>
      ({
        bind: () =>
          ({
            all: async () => ({ results: [] })
          }) as D1PreparedStatement
      }) as D1PreparedStatement
  } as unknown as D1Database;
}

function candle(
  openedAt: string,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  buyVolume = volume / 2,
  sellVolume = volume / 2
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
    trades: 10,
    isClosed: true
  };
}

function liquidation(observedAt: string, price: number, notionalUsd: number): LiquidationEvent {
  return {
    schemaVersion: "cascade.liquidation-event.v1",
    eventId: `liq-${observedAt}`,
    instrumentCode: "btc-usd",
    sourceExchange: "hyperliquid",
    side: "LONG",
    forcedFlowSide: "SELL",
    price,
    notionalUsd,
    baseSize: notionalUsd / price,
    exchangeTimestamp: observedAt,
    observedAt,
    raw: {}
  };
}

function openInterest(observedAt: string, value = 10_000): OpenInterestPoint {
  return {
    instrumentCode: "btc-usd",
    observedAt,
    openInterest: value,
    delta: 0
  };
}

function replayConfig(overrides: Partial<BacktestConfig> = {}): Partial<BacktestConfig> {
  return {
    strategyMode: "CASCADE_RECOVERY",
    feeBps: 1,
    slippageBps: 1,
    adverseSelectionMinBps: 1,
    adverseSelectionMaxBps: 2,
    riskPerTradePct: 0.01,
    cascadeWindowMs: 300_000,
    cascadeNotionalThresholdUsd: 1_000_000,
    cascadeZScoreThreshold: 1,
    cascadeAssetProfiles: JSON.stringify({
      BTC: {
        notionalThresholdUsd: 1_000_000,
        zScoreThreshold: 1,
        minPriceMoveAtr: 1,
        maxPositionNotionalPct: 0.2,
        assetLiquidityCapUsd: 50_000,
        maxSlippageBps: 8,
        rationale: "unit test cascade profile"
      }
    }),
    cascadeLookbackHours: 1,
    cascadeDirectionalPct: 0.7,
    cascadeMinPriceMoveAtr: 1,
    cascadeMinBaselineWindows: 0,
    cascadeMinSeparationMs: 0,
    absorptionWindowMs: 900_000,
    absorptionPriceBandBps: 300,
    absorptionMinHoldSeconds: 60,
    oiStabilityBps: 10,
    entryWindowSeconds: 900,
    impulsiveBarBodyAtr: 0.25,
    impulsiveBarVolumeMult: 1.05,
    stopBufferAtr: 0.1,
    minStopDistanceBps: 1,
    maxStopDistanceBps: 1_000,
    minTimeSinceLastCascadeSeconds: 0,
    maxRealizedVolPercentile: 0.99,
    timeStopHours: 1,
    maxPositionNotionalPct: 0.2,
    assetLiquidityCapUsd: 50_000,
    heatCapPct: 0.05,
    missingOpenInterestPolicy: "ASSUME_STABLE",
    ...overrides
  };
}

function replayFixture(): {
  candles: Candle[];
  liquidations: LiquidationEvent[];
  openInterest: OpenInterestPoint[];
} {
  const candles: Candle[] = [];
  const startMs = Date.parse("2025-10-10T11:30:00.000Z");
  for (let index = 0; index < 30; index += 1) {
    candles.push(
      candle(new Date(startMs + index * 60_000).toISOString(), 100, 100.2, 99.8, 100, 1)
    );
  }

  candles.push(candle("2025-10-10T12:01:00.000Z", 94.1, 94.5, 93.9, 94.2, 9, 1, 8));
  candles.push(candle("2025-10-10T12:02:00.000Z", 94.2, 94.6, 94.0, 94.4, 7, 2, 5));
  candles.push(candle("2025-10-10T12:03:00.000Z", 94.1, 96.1, 94.0, 96, 40, 35, 5));
  candles.push(candle("2025-10-10T12:04:00.000Z", 96, 100.5, 95.8, 100.2, 25, 20, 5));
  candles.push(candle("2025-10-10T12:05:00.000Z", 100.2, 103.2, 100, 103, 18, 14, 4));

  return {
    candles,
    liquidations: [liquidation("2025-10-10T12:00:30.000Z", 94, 2_000_000)],
    openInterest: [
      openInterest("2025-10-10T12:01:30.000Z"),
      openInterest("2025-10-10T12:02:30.000Z"),
      openInterest("2025-10-10T12:03:30.000Z")
    ]
  };
}
