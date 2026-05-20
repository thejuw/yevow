import { defaultCascadeRecoverySignalConfig } from "../../../strategy/cascade/CascadeRecoverySignal";
import {
  resolveCascadeAssetProfile,
  type CascadeAssetProfile
} from "../../../strategy/cascade/AssetProfiles";
import type { GlobalRiskConfig } from "../../../types";
import type {
  AbsorptionAnalyzerConfig,
  CascadeDetectorConfig,
  LiquidationEvent,
  CascadeRecoverySignalConfig
} from "../../../strategy/cascade/types";
import {
  readBoundedNumber,
  readPositiveInteger,
  readPositiveNumber
} from "../helpers/RuntimeParsing";

export function cascadeAssetProfileFromConfig(
  instrumentCode: string,
  config: GlobalRiskConfig
): CascadeAssetProfile {
  return resolveCascadeAssetProfile(instrumentCode, config.CASCADE_ASSET_PROFILES, {
    notionalThresholdUsd: config.CASCADE_NOTIONAL_THRESHOLD_USD,
    zScoreThreshold: config.CASCADE_ZSCORE_THRESHOLD,
    minPriceMoveAtr: config.CASCADE_MIN_PRICE_MOVE_ATR,
    maxPositionNotionalPct: config.MAX_POSITION_NOTIONAL_PCT,
    assetLiquidityCapUsd: config.ASSET_LIQUIDITY_CAP_USD,
    maxSlippageBps: config.HEDGE_MAX_SLIPPAGE_BPS
  });
}

export interface CascadeDetectorRuntimeConfigInput {
  readonly config: GlobalRiskConfig;
  readonly profile: CascadeAssetProfile;
  readonly minBaselineWindows: number;
  readonly minCascadeSeparationMs: number;
  readonly maxEventsPerInstrument: number;
}

export interface CascadeDetectorRuntimeEnvInput {
  readonly config: GlobalRiskConfig;
  readonly instrumentCode: string;
  readonly minBaselineWindowsValue?: string;
  readonly minCascadeSeparationMsValue?: string;
  readonly maxEventsPerInstrumentValue?: string;
}

export function cascadeDetectorConfig(
  input: CascadeDetectorRuntimeConfigInput
): CascadeDetectorConfig {
  return {
    windowMs: input.config.CASCADE_WINDOW_MS,
    notionalThresholdUsd: input.profile.notionalThresholdUsd,
    zScoreThreshold: input.profile.zScoreThreshold,
    lookbackHours: input.config.CASCADE_LOOKBACK_HOURS,
    directionalPct: input.config.CASCADE_DIRECTIONAL_PCT,
    minPriceMoveAtr: input.profile.minPriceMoveAtr,
    minBaselineWindows: input.minBaselineWindows,
    minCascadeSeparationMs: input.minCascadeSeparationMs,
    maxEventsPerInstrument: input.maxEventsPerInstrument
  };
}

export function cascadeDetectorConfigFromRuntime(
  input: CascadeDetectorRuntimeEnvInput
): CascadeDetectorConfig {
  return cascadeDetectorConfig({
    config: input.config,
    profile: cascadeAssetProfileFromConfig(input.instrumentCode, input.config),
    minBaselineWindows: readPositiveInteger(input.minBaselineWindowsValue, 12, 0, 10_000),
    minCascadeSeparationMs: readPositiveInteger(
      input.minCascadeSeparationMsValue,
      input.config.CASCADE_WINDOW_MS,
      0,
      6 * 3_600_000
    ),
    maxEventsPerInstrument: readPositiveInteger(
      input.maxEventsPerInstrumentValue,
      10_000,
      100,
      100_000
    )
  });
}

export interface AbsorptionAnalyzerRuntimeConfigInput {
  readonly config: GlobalRiskConfig;
  readonly oiStabilityBps: number;
  readonly maxActiveCascades: number;
}

export interface AbsorptionAnalyzerRuntimeEnvInput {
  readonly config: GlobalRiskConfig;
  readonly oiStabilityBpsValue?: string;
  readonly maxActiveCascadesValue?: string;
}

export interface CascadeAtrFallbackInput {
  readonly event: LiquidationEvent;
  readonly midPrice: number | null;
  readonly fallbackUsdValue?: string;
  readonly fallbackPctValue?: string;
}

export function absorptionAnalyzerConfig(
  input: AbsorptionAnalyzerRuntimeConfigInput
): AbsorptionAnalyzerConfig {
  return {
    absorptionWindowMs: input.config.ABSORPTION_WINDOW_MS,
    priceBandBps: input.config.ABSORPTION_PRICE_BAND_BPS,
    minHoldSeconds: input.config.ABSORPTION_MIN_HOLD_SECONDS,
    oiStabilityBps: input.oiStabilityBps,
    maxActiveCascades: input.maxActiveCascades
  };
}

export function absorptionAnalyzerConfigFromRuntime(
  input: AbsorptionAnalyzerRuntimeEnvInput
): AbsorptionAnalyzerConfig {
  return absorptionAnalyzerConfig({
    config: input.config,
    oiStabilityBps: readPositiveNumber(input.oiStabilityBpsValue, 5),
    maxActiveCascades: readPositiveInteger(input.maxActiveCascadesValue, 24, 1, 100)
  });
}

export function resolveCascadeAtr1h(input: CascadeAtrFallbackInput): number | null {
  const fallback = readPositiveNumber(input.fallbackUsdValue, 0);
  if (fallback > 0) {
    return fallback;
  }

  const price = input.event.price > 0 ? input.event.price : input.midPrice;
  const fallbackPct = readBoundedNumber(input.fallbackPctValue, 0, 0, 0.2);
  return price && price > 0 && fallbackPct > 0 ? price * fallbackPct : null;
}

export function cascadeRecoverySignalConfig(config: GlobalRiskConfig): CascadeRecoverySignalConfig {
  return {
    ...defaultCascadeRecoverySignalConfig,
    entryWindowSeconds: config.ENTRY_WINDOW_SECONDS,
    impulsiveBarBodyAtr: config.IMPULSIVE_BAR_BODY_ATR,
    impulsiveBarVolumeMult: config.IMPULSIVE_BAR_VOLUME_MULT,
    stopBufferAtr: config.STOP_BUFFER_ATR,
    minStopDistanceBps: config.MIN_STOP_DISTANCE_BPS,
    maxStopDistanceBps: config.MAX_STOP_DISTANCE_BPS,
    minTimeSinceLastCascadeSeconds: config.MIN_TIME_SINCE_LAST_CASCADE_SECONDS,
    newsBlackoutMinutes: config.NEWS_BLACKOUT_MINUTES,
    maxRealizedVolPercentile: config.MAX_REALIZED_VOL_PERCENTILE,
    timeStopHours: config.CASCADE_TIME_STOP_HOURS,
    partial1R: config.PARTIAL_1_R,
    partial1SizePct: config.PARTIAL_1_SIZE_PCT,
    partial2R: config.PARTIAL_2_R,
    partial2SizePct: config.PARTIAL_2_SIZE_PCT,
    runnerTrailingType: config.TRAILING_STOP_TYPE,
    runnerTrailingParam: config.TRAILING_STOP_PARAM
  };
}
