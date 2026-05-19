import { describe, expect, it } from "vitest";
import {
  absorptionConfirmedAlertMetadata,
  absorptionConfirmedLogMetadata,
  absorptionConfirmedTelemetryPayload,
  buildCascadeAbsorptionObservation,
  cascadeAbsorptionSignedNotional,
  nextCascadeCvd
} from "../../src/engine/trading/cascade/CascadeAbsorptionRuntime";
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
