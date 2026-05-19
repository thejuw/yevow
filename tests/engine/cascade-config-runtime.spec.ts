import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/ConfigManager";
import {
  absorptionAnalyzerConfig,
  cascadeAssetProfileFromConfig,
  cascadeDetectorConfig,
  cascadeRecoverySignalConfig
} from "../../src/engine/trading/cascade/CascadeConfigRuntime";

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
});
