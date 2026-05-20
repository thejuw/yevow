import { defaultConfig } from "../../../ConfigManager";
import { AnomalyDetector } from "../../../agents/AnomalyDetector";
import { CroupierAgent } from "../../../agents/CroupierAgent";
import { HeatmapAgent } from "../../../agents/HeatmapAgent";
import type { ProfilerAgent } from "../../../agents/ProfilerAgent";
import { createProfilerAgentFromEnv } from "../../../agents/ProfilerRegistry";
import { AbsorptionAnalyzer } from "../../../strategy/cascade/AbsorptionAnalyzer";
import { CascadeDetector } from "../../../strategy/cascade/CascadeDetector";
import {
  DEFAULT_AMM_MIN_TICK_CHANGE,
  DEFAULT_ANOMALY_CANCEL_EXEC_RATIO_THRESHOLD,
  DEFAULT_ANOMALY_PRICE_WINDOW_MS,
  DEFAULT_ANOMALY_PRICE_Z_THRESHOLD,
  DEFAULT_ANOMALY_TOP_OF_BOOK_WINDOW_MS,
  DEFAULT_ANOMALY_VOLUME_WINDOW_MS,
  DEFAULT_ANOMALY_VOLUME_Z_THRESHOLD,
  DEFAULT_CASCADE_DISTANCE_PCT,
  DEFAULT_DOM_PRICE_BIN_SIZE,
  DEFAULT_DOM_SCAN_RANGE_PCT,
  DEFAULT_DOM_SPOOF_PROXIMITY_BPS,
  DEFAULT_DOM_WALL_HISTORY_LIMIT,
  DEFAULT_EXCHANGE_FEE_BPS,
  DEFAULT_HEATMAP_CLUSTER_NOTIONAL_USD,
  DEFAULT_HEATMAP_PRICE_BIN_SIZE,
  DEFAULT_JITTER_COMPUTE_INTERVAL_TICKS,
  DEFAULT_JITTER_SAMPLE_WINDOW,
  DEFAULT_JITTER_THRESHOLD_MS,
  DEFAULT_MIN_EV_THRESHOLD,
  DEFAULT_RISK_AVERSION_FACTOR
} from "../../../TradingEngineConstants";
import type { Env } from "../../../types";
import {
  readBoundedNumber,
  readNumber,
  readPositiveInteger,
  readPositiveNumber
} from "../helpers/RuntimeHelpers";

export interface EngineBootRuntimeSettings {
  readonly jitterSampleWindow: number;
  readonly jitterComputeIntervalTicks: number;
  readonly jitterThresholdMs: number;
  readonly domPriceBinSize: number;
  readonly domScanRangePct: number;
  readonly domWallHistoryLimit: number;
  readonly domSpoofProximityBps: number;
}

export function resolveEngineBootRuntimeSettings(env: Env): EngineBootRuntimeSettings {
  return {
    jitterSampleWindow: readPositiveInteger(
      env.JITTER_SAMPLE_WINDOW,
      DEFAULT_JITTER_SAMPLE_WINDOW,
      10,
      10_000
    ),
    jitterComputeIntervalTicks: readPositiveInteger(
      env.JITTER_COMPUTE_INTERVAL_TICKS,
      DEFAULT_JITTER_COMPUTE_INTERVAL_TICKS,
      1,
      10_000
    ),
    jitterThresholdMs: readPositiveNumber(
      env.JITTER_THRESHOLD_MS,
      DEFAULT_JITTER_THRESHOLD_MS
    ),
    domPriceBinSize: readPositiveNumber(
      env.DOM_PRICE_BIN_SIZE_DEFAULT,
      DEFAULT_DOM_PRICE_BIN_SIZE
    ),
    domScanRangePct: readBoundedNumber(
      env.DOM_SCAN_RANGE_PCT,
      DEFAULT_DOM_SCAN_RANGE_PCT,
      0.001,
      0.1
    ),
    domWallHistoryLimit: readPositiveInteger(
      env.DOM_WALL_HISTORY_LIMIT,
      DEFAULT_DOM_WALL_HISTORY_LIMIT,
      50,
      5_000
    ),
    domSpoofProximityBps: readPositiveNumber(
      env.DOM_SPOOF_PROXIMITY_BPS,
      DEFAULT_DOM_SPOOF_PROXIMITY_BPS
    )
  };
}

export function createBootProfilerAgent(env: Env): ProfilerAgent {
  return createProfilerAgentFromEnv(env);
}

export function createBootHeatmapAgent(env: Env): HeatmapAgent {
  const coin = env.HL_ASSET ?? "BTC";

  return new HeatmapAgent({
    coin,
    instrumentCode: `${coin.toLowerCase()}-usd`,
    sourceExchange: "hyperliquid",
    binSize: readPositiveNumber(env.HL_HEATMAP_PRICE_BIN_SIZE, DEFAULT_HEATMAP_PRICE_BIN_SIZE),
    clusterThresholdUsd: readPositiveNumber(
      env.HL_HEATMAP_CLUSTER_NOTIONAL_USD,
      DEFAULT_HEATMAP_CLUSTER_NOTIONAL_USD
    ),
    cascadeDistancePct: readPositiveNumber(
      env.HL_CASCADE_DISTANCE_PCT,
      DEFAULT_CASCADE_DISTANCE_PCT
    )
  });
}

export function createBootCascadeDetector(env: Env): CascadeDetector {
  return new CascadeDetector({
    windowMs: readPositiveInteger(
      env.CASCADE_WINDOW_MS,
      defaultConfig.CASCADE_WINDOW_MS,
      60_000,
      3_600_000
    ),
    notionalThresholdUsd: readPositiveNumber(
      env.CASCADE_NOTIONAL_THRESHOLD_USD,
      defaultConfig.CASCADE_NOTIONAL_THRESHOLD_USD
    ),
    zScoreThreshold: readPositiveNumber(
      env.CASCADE_ZSCORE_THRESHOLD,
      defaultConfig.CASCADE_ZSCORE_THRESHOLD
    ),
    lookbackHours: readPositiveInteger(
      env.CASCADE_LOOKBACK_HOURS,
      defaultConfig.CASCADE_LOOKBACK_HOURS,
      1,
      168
    ),
    directionalPct: readBoundedNumber(
      env.CASCADE_DIRECTIONAL_PCT,
      defaultConfig.CASCADE_DIRECTIONAL_PCT,
      0.5,
      1
    ),
    minPriceMoveAtr: readBoundedNumber(
      env.CASCADE_MIN_PRICE_MOVE_ATR,
      defaultConfig.CASCADE_MIN_PRICE_MOVE_ATR,
      0,
      10
    ),
    minBaselineWindows: readPositiveInteger(env.CASCADE_MIN_BASELINE_WINDOWS, 12, 0, 10_000),
    minCascadeSeparationMs: readPositiveInteger(
      env.CASCADE_MIN_SEPARATION_MS,
      defaultConfig.CASCADE_WINDOW_MS,
      0,
      6 * 3_600_000
    ),
    maxEventsPerInstrument: readPositiveInteger(
      env.CASCADE_MAX_EVENTS_PER_INSTRUMENT,
      10_000,
      100,
      100_000
    )
  });
}

export function createBootAbsorptionAnalyzer(env: Env): AbsorptionAnalyzer {
  return new AbsorptionAnalyzer({
    absorptionWindowMs: readPositiveInteger(
      env.ABSORPTION_WINDOW_MS,
      defaultConfig.ABSORPTION_WINDOW_MS,
      60_000,
      6 * 3_600_000
    ),
    priceBandBps: readPositiveNumber(
      env.ABSORPTION_PRICE_BAND_BPS,
      defaultConfig.ABSORPTION_PRICE_BAND_BPS
    ),
    minHoldSeconds: readPositiveInteger(
      env.ABSORPTION_MIN_HOLD_SECONDS,
      defaultConfig.ABSORPTION_MIN_HOLD_SECONDS,
      5,
      3_600
    ),
    oiStabilityBps: readPositiveNumber(env.ABSORPTION_OI_STABILITY_BPS, 5),
    maxActiveCascades: readPositiveInteger(env.ABSORPTION_MAX_ACTIVE_CASCADES, 24, 1, 100)
  });
}

export function createBootAnomalyDetector(env: Env): AnomalyDetector {
  return new AnomalyDetector({
    priceZThreshold: readPositiveNumber(
      env.ANOMALY_PRICE_Z_THRESHOLD,
      DEFAULT_ANOMALY_PRICE_Z_THRESHOLD
    ),
    volumeZThreshold: readPositiveNumber(
      env.ANOMALY_VOLUME_Z_THRESHOLD,
      DEFAULT_ANOMALY_VOLUME_Z_THRESHOLD
    ),
    cancelExecutionRatioThreshold: readPositiveNumber(
      env.ANOMALY_CANCEL_EXEC_RATIO_THRESHOLD,
      DEFAULT_ANOMALY_CANCEL_EXEC_RATIO_THRESHOLD
    ),
    priceWindowMs: readPositiveInteger(
      env.ANOMALY_PRICE_WINDOW_MS,
      DEFAULT_ANOMALY_PRICE_WINDOW_MS,
      5_000,
      600_000
    ),
    volumeWindowMs: readPositiveInteger(
      env.ANOMALY_VOLUME_WINDOW_MS,
      DEFAULT_ANOMALY_VOLUME_WINDOW_MS,
      60_000,
      3_600_000
    ),
    topOfBookWindowMs: readPositiveInteger(
      env.ANOMALY_TOP_OF_BOOK_WINDOW_MS,
      DEFAULT_ANOMALY_TOP_OF_BOOK_WINDOW_MS,
      60_000,
      3_600_000
    )
  });
}

export function createBootCroupierAgent(env: Env): CroupierAgent {
  return new CroupierAgent({
    minEvThreshold: readNumber(env.MIN_EV_THRESHOLD, DEFAULT_MIN_EV_THRESHOLD),
    exchangeFeeBps: readPositiveNumber(env.EXCHANGE_FEE_BPS, DEFAULT_EXCHANGE_FEE_BPS),
    riskAversionFactor: readPositiveNumber(
      env.RISK_AVERSION_FACTOR,
      DEFAULT_RISK_AVERSION_FACTOR
    ),
    minTickChange: readPositiveNumber(env.AMM_MIN_TICK_CHANGE, DEFAULT_AMM_MIN_TICK_CHANGE)
  });
}
