import { describe, expect, it } from "vitest";
import {
  absorptionConfirmedAlertMetadata,
  absorptionConfirmedLogMetadata,
  absorptionConfirmedTelemetryPayload,
  applyCascadeAbsorptionConfirmedSideEffects,
  buildCascadeAbsorptionObservation,
  cascadeAbsorptionSignedNotional,
  nextCascadeCvd,
  observeTradingEngineCascadeAbsorption,
  observeTradingCascadeAbsorption,
  type CascadeAbsorptionConfirmedSideEffectHandlers,
  type TradingCascadeAbsorptionTarget
} from "../../src/engine/trading/cascade/CascadeAbsorptionRuntime";
import { defaultAbsorptionAnalyzerConfig } from "../../src/strategy/cascade/AbsorptionAnalyzer";
import type { AbsorptionConfirmed } from "../../src/strategy/cascade/types";
import type { MarketTick } from "../../src/types";

const OBSERVED_AT = "2026-05-18T18:00:00.000Z";

describe("CascadeAbsorptionRuntime", () => {
  it("builds signed CVD and absorption observations from trade ticks", () => {
    expect(cascadeAbsorptionSignedNotional(tick({ side: "buy", price: 100, size: 2 }))).toBe(200);
    expect(cascadeAbsorptionSignedNotional(tick({ side: "sell", price: 100, size: 2 }))).toBe(-200);
    expect(cascadeAbsorptionSignedNotional(tick({ side: "unknown", price: 100, size: 2 }))).toBe(0);
    expect(nextCascadeCvd(50, tick({ side: "sell", price: 10, size: 3 }))).toBe(20);

    expect(
      buildCascadeAbsorptionObservation({
        tick: tick({ side: "buy", price: 100, size: 2, openInterest: 1_000 }),
        instrumentCode: "btc-usd",
        cumulativeVolumeDelta: 250
      })
    ).toEqual({
      instrumentCode: "btc-usd",
      observedAt: OBSERVED_AT,
      price: 100,
      takerBuyVolume: 2,
      takerSellVolume: 0,
      cumulativeVolumeDelta: 250,
      openInterest: 1_000
    });
  });

  it("builds confirmed absorption log, telemetry, and alert payloads", () => {
    const confirmed = absorptionConfirmed();

    expect(absorptionConfirmedLogMetadata(confirmed)).toEqual({
      eventType: "ABSORPTION_CONFIRMED",
      cascadeId: "cascade-1",
      instrumentCode: "btc-usd",
      direction: "LONG_LIQUIDATION",
      elapsedMs: 3_000,
      price: 96,
      priceHeld: true,
      takerExhaustion: true,
      cvdReversal: false,
      openInterestStabilized: true,
      observations: 12
    });
    expect(absorptionConfirmedTelemetryPayload(confirmed)).toMatchObject({
      schemaVersion: "cascade.absorption-confirmed.v1",
      cascadeId: "cascade-1",
      confirmedAt: OBSERVED_AT,
      priceHeld: true
    });
    expect(absorptionConfirmedAlertMetadata(confirmed)).toEqual({
      cascadeId: "cascade-1",
      instrumentCode: "btc-usd",
      direction: "LONG_LIQUIDATION",
      elapsedMs: 3_000,
      price: 96,
      confirmedAt: OBSERVED_AT
    });
  });

  it("emits confirmed absorption side effects in order", () => {
    const sideEffects = absorptionConfirmedSideEffectSpy();

    applyCascadeAbsorptionConfirmedSideEffects(absorptionConfirmed(), sideEffects.handlers);

    expect(sideEffects.events).toEqual([
      "record:cascade-1",
      "log:ABSORPTION_CONFIRMED:cascade-1",
      "publish:ABSORPTION_CONFIRMED:cascade-1",
      "alert:CASCADE_ABSORPTION_CONFIRMED:cascade-1:cascade-1"
    ]);
  });

  it("observes trading cascade absorption with CVD accounting and analyzer side effects", () => {
    const sideEffects = absorptionConfirmedSideEffectSpy();
    const events: string[] = [];
    const cvd = new Map<string, number>([["btc", 50]]);
    const confirmed = absorptionConfirmed();

    const result = observeTradingCascadeAbsorption(
      {
        tick: tick({
          instrumentCode: "BTC-PERP",
          side: "buy",
          price: 100,
          size: 2,
          raw: { eventType: "trade" }
        }),
        cascadeInstruments: "btc"
      },
      {
        ...sideEffects.handlers,
        readCumulativeVolumeDelta: (instrumentCode) => {
          events.push(`read:${instrumentCode}`);
          return cvd.get(instrumentCode);
        },
        writeCumulativeVolumeDelta: (instrumentCode, cumulativeVolumeDelta) => {
          events.push(`write:${instrumentCode}:${cumulativeVolumeDelta}`);
          cvd.set(instrumentCode, cumulativeVolumeDelta);
        },
        configureAnalyzer: () => events.push("configure"),
        observeAbsorption: (observation) => {
          events.push(`observe:${observation.instrumentCode}:${observation.cumulativeVolumeDelta}`);
          return confirmed;
        }
      }
    );

    expect(result).toBe(confirmed);
    expect(events).toEqual(["read:btc", "write:btc:250", "configure", "observe:btc:250"]);
    expect(sideEffects.events).toEqual([
      "record:cascade-1",
      "log:ABSORPTION_CONFIRMED:cascade-1",
      "publish:ABSORPTION_CONFIRMED:cascade-1",
      "alert:CASCADE_ABSORPTION_CONFIRMED:cascade-1:cascade-1"
    ]);
  });

  it("observes cascade absorption through the trading engine target adapter", () => {
    const events: string[] = [];
    const cvd = new Map<string, number>([["btc", 50]]);
    const absorptions = new Map<string, AbsorptionConfirmed>();
    const confirmed = absorptionConfirmed();
    const target: TradingCascadeAbsorptionTarget = {
      cachedConfig: { CASCADE_INSTRUMENTS: "btc" },
      cascadeCvdByInstrument: cvd,
      absorptionAnalyzer: {
        configure() {
          events.push("configure");
        },
        observe(observation) {
          events.push(`observe:${observation.instrumentCode}:${observation.cumulativeVolumeDelta}`);
          return confirmed;
        }
      },
      cascadeAbsorptionsById: absorptions,
      logger: {
        info(event, _message, metadata) {
          events.push(`log:${event}:${String(metadata.cascadeId)}`);
        }
      },
      currentAbsorptionAnalyzerConfig() {
        return defaultAbsorptionAnalyzerConfig;
      },
      publish(telemetryType, payload) {
        events.push(`publish:${telemetryType}:${String(payload.cascadeId)}`);
      },
      emitCascadeOperationalAlert(eventType, _title, _message, _metadata, dedupeKey) {
        events.push(`alert:${eventType}:${dedupeKey}`);
      }
    };

    const result = observeTradingEngineCascadeAbsorption(
      tick({
        instrumentCode: "BTC-PERP",
        side: "buy",
        price: 100,
        size: 2,
        raw: { eventType: "trade" }
      }),
      target
    );

    expect(result).toBe(confirmed);
    expect(cvd.get("btc")).toBe(250);
    expect(absorptions.get("cascade-1")).toBe(confirmed);
    expect(events).toEqual([
      "configure",
      "observe:btc:250",
      "log:ABSORPTION_CONFIRMED:cascade-1",
      "publish:ABSORPTION_CONFIRMED:cascade-1",
      "alert:CASCADE_ABSORPTION_CONFIRMED:cascade-1"
    ]);
  });

  it("skips cascade absorption for non-trades, bad prices, or disabled instruments", () => {
    const result = observeTradingCascadeAbsorption(
      {
        tick: tick({ sourceChannel: "l2Book", price: 0 }),
        cascadeInstruments: "eth-usd"
      },
      {
        ...absorptionConfirmedSideEffectSpy().handlers,
        readCumulativeVolumeDelta: () => {
          throw new Error("unexpected read");
        },
        writeCumulativeVolumeDelta: () => {
          throw new Error("unexpected write");
        },
        configureAnalyzer: () => {
          throw new Error("unexpected configure");
        },
        observeAbsorption: () => {
          throw new Error("unexpected observe");
        }
      }
    );

    expect(result).toBeNull();
  });
});

function tick(overrides: Partial<MarketTick> = {}): MarketTick {
  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: "hyperliquid",
    sourceChannel: "trades",
    exchangeCode: "hyperliquid",
    instrumentCode: "btc-usd",
    baseAsset: "BTC",
    quoteAsset: "USD",
    price: 100,
    size: 1,
    side: "buy",
    sequence: 1,
    providerTimestamp: OBSERVED_AT,
    exchangeTimestamp: OBSERVED_AT,
    synchronizedExchangeTimestamp: OBSERVED_AT,
    clockOffsetMs: 0,
    receivedAt: OBSERVED_AT,
    sourceWeight: 1,
    raw: {},
    ...overrides
  };
}

function absorptionConfirmed(): AbsorptionConfirmed {
  return {
    schemaVersion: "cascade.absorption-confirmed.v1",
    cascadeId: "cascade-1",
    instrumentCode: "btc-usd",
    direction: "LONG_LIQUIDATION",
    confirmedAt: OBSERVED_AT,
    elapsedMs: 3_000,
    price: 96,
    criteria: {
      priceHeld: true,
      takerExhaustion: true,
      cvdReversal: false,
      openInterestStabilized: true
    },
    observations: 12
  };
}

function absorptionConfirmedSideEffectSpy(): {
  events: string[];
  handlers: CascadeAbsorptionConfirmedSideEffectHandlers;
} {
  const events: string[] = [];

  return {
    events,
    handlers: {
      recordAbsorption(confirmed) {
        events.push(`record:${confirmed.cascadeId}`);
      },
      logInfo(event, _message, metadata) {
        events.push(`log:${event}:${metadata.cascadeId}`);
      },
      publish(telemetryType, payload) {
        events.push(`publish:${telemetryType}:${payload.cascadeId}`);
      },
      emitOperationalAlert(eventType, _title, _message, metadata, dedupeKey) {
        events.push(`alert:${eventType}:${dedupeKey}:${metadata.cascadeId}`);
      }
    }
  };
}
