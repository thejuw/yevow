import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import {
  absorptionAnalyzerConfig,
  absorptionAnalyzerConfigFromRuntime,
  cascadeAssetProfileFromConfig,
  cascadeDetectorConfig,
  cascadeDetectorConfigFromRuntime,
  cascadeRecoverySignalConfig,
  resolveCascadeAtr1h
} from "../../src/engine/trading/cascade/CascadeConfigRuntime";
import type { LiquidationEvent } from "../../src/strategy/cascade/types";

describe("CascadeConfigRuntime", () => {
  it("resolves configured per-asset profiles with global fallbacks", () => {
    const profile = cascadeAssetProfileFromConfig("hype-usd", {
      ...defaultConfig,
      CASCADE_ASSET_PROFILES: JSON.stringify({
        HYPE: {
          asset: "HYPE",
          notionalThresholdUsd: 2_000_000,
          zScoreThreshold: 4,
          minPriceMoveAtr: 2.5,
          maxPositionNotionalPct: 0.05,
          assetLiquidityCapUsd: 2_500,
          maxSlippageBps: 20,
          rationale: "unit-test override"
        }
      })
    });

    expect(profile).toMatchObject({
      asset: "HYPE",
      notionalThresholdUsd: 2_000_000,
      zScoreThreshold: 4,
      minPriceMoveAtr: 2.5,
      maxPositionNotionalPct: 0.05,
      assetLiquidityCapUsd: 2_500,
      maxSlippageBps: 20
    });
  });

  it("builds detector and absorption analyzer configs from runtime inputs", () => {
    const profile = cascadeAssetProfileFromConfig("btc-usd", defaultConfig);

    expect(
      cascadeDetectorConfig({
        config: defaultConfig,
        profile,
        minBaselineWindows: 12,
        minCascadeSeparationMs: 60_000,
        maxEventsPerInstrument: 500
      })
    ).toMatchObject({
      windowMs: defaultConfig.CASCADE_WINDOW_MS,
      notionalThresholdUsd: profile.notionalThresholdUsd,
      zScoreThreshold: profile.zScoreThreshold,
      lookbackHours: defaultConfig.CASCADE_LOOKBACK_HOURS,
      minBaselineWindows: 12,
      minCascadeSeparationMs: 60_000,
      maxEventsPerInstrument: 500
    });

    expect(
      absorptionAnalyzerConfig({
        config: defaultConfig,
        oiStabilityBps: 7,
        maxActiveCascades: 18
      })
    ).toEqual({
      absorptionWindowMs: defaultConfig.ABSORPTION_WINDOW_MS,
      priceBandBps: defaultConfig.ABSORPTION_PRICE_BAND_BPS,
      minHoldSeconds: defaultConfig.ABSORPTION_MIN_HOLD_SECONDS,
      oiStabilityBps: 7,
      maxActiveCascades: 18
    });
  });

  it("builds detector and absorption analyzer configs from env-backed runtime values", () => {
    expect(
      cascadeDetectorConfigFromRuntime({
        config: defaultConfig,
        instrumentCode: "btc-usd",
        minBaselineWindowsValue: "20",
        minCascadeSeparationMsValue: "90000",
        maxEventsPerInstrumentValue: "250"
      })
    ).toMatchObject({
      windowMs: defaultConfig.CASCADE_WINDOW_MS,
      minBaselineWindows: 20,
      minCascadeSeparationMs: 90_000,
      maxEventsPerInstrument: 250
    });

    expect(
      absorptionAnalyzerConfigFromRuntime({
        config: defaultConfig,
        oiStabilityBpsValue: "9",
        maxActiveCascadesValue: "12"
      })
    ).toMatchObject({
      absorptionWindowMs: defaultConfig.ABSORPTION_WINDOW_MS,
      oiStabilityBps: 9,
      maxActiveCascades: 12
    });
  });

  it("builds recovery signal config from live risk settings", () => {
    expect(
      cascadeRecoverySignalConfig({
        ...defaultConfig,
        ENTRY_WINDOW_SECONDS: 45,
        PARTIAL_1_R: 1.25,
        TRAILING_STOP_TYPE: "EMA",
        TRAILING_STOP_PARAM: 21
      })
    ).toMatchObject({
      entryWindowSeconds: 45,
      partial1R: 1.25,
      runnerTrailingType: "EMA",
      runnerTrailingParam: 21
    });
  });

  it("resolves cascade ATR fallbacks from explicit USD, event price, or mid-price", () => {
    expect(
      resolveCascadeAtr1h({
        event: liquidationEvent({ price: 10_000 }),
        midPrice: 9_500,
        fallbackUsdValue: "250",
        fallbackPctValue: "0.05"
      })
    ).toBe(250);

    expect(
      resolveCascadeAtr1h({
        event: liquidationEvent({ price: 10_000 }),
        midPrice: 9_500,
        fallbackPctValue: "0.05"
      })
    ).toBe(500);

    expect(
      resolveCascadeAtr1h({
        event: liquidationEvent({ price: 0 }),
        midPrice: 9_500,
        fallbackPctValue: "0.02"
      })
    ).toBe(190);

    expect(
      resolveCascadeAtr1h({
        event: liquidationEvent({ price: 0 }),
        midPrice: null,
        fallbackPctValue: "0.02"
      })
    ).toBeNull();
  });
});

function liquidationEvent(overrides: { price?: number } = {}): LiquidationEvent {
  return {
    schemaVersion: "cascade.liquidation-event.v1",
    eventId: "liq-1",
    instrumentCode: "btc-usd",
    sourceExchange: "hyperliquid",
    side: "LONG",
    forcedFlowSide: "SELL",
    price: overrides.price ?? 10_000,
    notionalUsd: 10_000,
    baseSize: 1,
    exchangeTimestamp: "2026-05-18T12:00:00.000Z",
    observedAt: "2026-05-18T12:00:00.100Z",
    raw: {}
  };
}
