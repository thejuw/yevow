import type { AdminConfigUpdate, Env, GlobalRiskConfig, GlobalRiskConfigUpdate } from "./types";
import {
  parseCascadeAssetProfiles,
  serializedDefaultCascadeAssetProfiles
} from "./strategy/cascade/AssetProfiles";

export const GLOBAL_RISK_SETTINGS_KEY = "global_risk_settings";

export const defaultConfig: GlobalRiskConfig = {
  TRADING_ENABLED: false,
  STRATEGY_MODE: "OFF",
  ORACLE_ENABLED: true,
  SENTIMENT_ENABLED: true,
  PROFILER_ENABLED: true,
  CROUPIER_ENABLED: true,
  PIT_BOSS_ENABLED: true,
  MARKET_MAKING_MODE: "BALANCED",
  MAX_POSITION_SIZE: 0,
  MAX_POSITION_PCT: 0,
  MAX_INVENTORY_UNITS: 0,
  MAX_INVENTORY_DELTA: 1,
  MAX_DRAWDOWN_PCT: 0.15,
  LATENCY_THRESHOLD_MS: 250,
  GOLDEN_COLOS: "",
  MIN_EV_THRESHOLD: 0,
  EXCHANGE_FEE_BPS: 0,
  KELLY_FRACTION: 0.5,
  RISK_AVERSION_FACTOR: 0.01,
  FUNDING_BIAS_THRESHOLD: 0.00001,
  FUNDING_INVENTORY_BIAS: 0.25,
  HEDGE_ENABLED: false,
  HEDGE_TRIGGER_INVENTORY_PCT: 0.6,
  HEDGE_COOLDOWN_MS: 30_000,
  HEDGE_MAX_SLIPPAGE_BPS: 8,
  CASCADE_TAKER_ENABLED: false,
  CASCADE_INSTRUMENTS: "BTC,HYPE",
  CASCADE_ASSET_PROFILES: serializedDefaultCascadeAssetProfiles(),
  MAX_SPREAD_BPS_FOR_TAKER: 10,
  MAX_SINGLE_ORDER_NOTIONAL_USD: 500_000,
  SLICE_NOTIONAL_THRESHOLD_USD: 100_000,
  SLICE_NOTIONAL_PER_CHUNK: 50_000,
  SLICE_INTERVAL_MS: 30_000,
  SLICE_JITTER_MS: 10_000,
  MIN_FILL_RATIO: 0.8,
  LAYERED_QUOTE_LEVELS: 3,
  LAYERED_QUOTE_SIZE_DECAY: 0.55,
  LAYERED_QUOTE_SPREAD_STEP_BPS: 1,
  CVAR_CONFIDENCE: 0.99,
  CVAR_MAX_TAIL_LOSS_BPS: 25,
  CVAR_LOOKBACK_TRADES: 500,
  SENTIMENT_ALPHA_MODE: "EVENT_RISK_ONLY",
  TOXICITY_CLASSIFIER_ENABLED: true,
  TOXICITY_CLASSIFIER_THRESHOLD: 0.72,
  FUNDING_PRE_SETTLEMENT_WINDOW_MS: 30 * 60 * 1000,
  FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER: 2,
  QUOTE_HIBERNATE_MS: 3_000,
  VAR_CONFIDENCE_Z: 2.326,
  ORACLE_GOVERNANCE_MODE: "HYBRID",
  ORACLE_MANUAL_SKEPTICISM: 1.4,
  ORACLE_MAX_SKEPTICISM: 4,
  AM_VPIN_BUCKET_VOLUME: 10,
  AM_VPIN_ROLLING_WINDOW: 50,
  AM_VPIN_DIRECTIONAL_DECAY: 0.3,
  AM_VPIN_NORMAL_THRESHOLD: 0.65,
  AM_VPIN_TOXIC_THRESHOLD: 0.75,
  AM_VPIN_CRITICAL_THRESHOLD: 0.85,
  AM_VPIN_OBI_DEPTH: 5,
  AM_VPIN_CRITICAL_OBI: 0.8,
  AM_VPIN_CONTESTED_SPREAD_MULTIPLIER: 1,
  AM_VPIN_TOXIC_SPREAD_MULTIPLIER: 1,
  AM_VPIN_QUOTE_HALT_MS: 60_000,
  CASCADE_WINDOW_MS: 5 * 60 * 1000,
  CASCADE_NOTIONAL_THRESHOLD_USD: 50_000_000,
  CASCADE_ZSCORE_THRESHOLD: 3,
  CASCADE_LOOKBACK_HOURS: 168,
  CASCADE_DIRECTIONAL_PCT: 0.7,
  CASCADE_MIN_PRICE_MOVE_ATR: 1.5,
  ABSORPTION_WINDOW_MS: 3 * 60 * 1000,
  ABSORPTION_PRICE_BAND_BPS: 30,
  ABSORPTION_MIN_HOLD_SECONDS: 60,
  ENTRY_WINDOW_SECONDS: 5 * 60,
  IMPULSIVE_BAR_BODY_ATR: 1.5,
  IMPULSIVE_BAR_VOLUME_MULT: 1.5,
  STOP_BUFFER_ATR: 0.25,
  MIN_STOP_DISTANCE_BPS: 40,
  MAX_STOP_DISTANCE_BPS: 400,
  MIN_TIME_SINCE_LAST_CASCADE_SECONDS: 30 * 60,
  NEWS_BLACKOUT_MINUTES: 60,
  MAX_REALIZED_VOL_PERCENTILE: 0.95,
  CASCADE_TIME_STOP_HOURS: 24,
  PARTIAL_1_R: 2,
  PARTIAL_1_SIZE_PCT: 30,
  PARTIAL_2_R: 3,
  PARTIAL_2_SIZE_PCT: 30,
  TRAILING_STOP_TYPE: "ATR",
  TRAILING_STOP_PARAM: 2,
  RISK_PER_TRADE_PCT: 0.01,
  HEAT_CAP_PCT: 0.05,
  MAX_POSITION_NOTIONAL_PCT: 0.25,
  ASSET_LIQUIDITY_CAP_USD: 25_000,
  DAILY_LOSS_LIMIT_PCT: 0.03,
  WEEKLY_LOSS_LIMIT_PCT: 0.07,
  MAX_CONSECUTIVE_LOSSES: 5,
  updatedAt: "1970-01-01T00:00:00.000Z",
  updatedBy: "system-default",
  version: "fail-closed"
};

const AM_VPIN_CONFIG_KEYS = [
  "AM_VPIN_BUCKET_VOLUME",
  "AM_VPIN_ROLLING_WINDOW",
  "AM_VPIN_DIRECTIONAL_DECAY",
  "AM_VPIN_NORMAL_THRESHOLD",
  "AM_VPIN_TOXIC_THRESHOLD",
  "AM_VPIN_CRITICAL_THRESHOLD",
  "AM_VPIN_OBI_DEPTH",
  "AM_VPIN_CRITICAL_OBI",
  "AM_VPIN_CONTESTED_SPREAD_MULTIPLIER",
  "AM_VPIN_TOXIC_SPREAD_MULTIPLIER",
  "AM_VPIN_QUOTE_HALT_MS"
] as const;

const STRATEGY_NUMERIC_CONFIG_KEYS = [
  "HEDGE_TRIGGER_INVENTORY_PCT",
  "HEDGE_COOLDOWN_MS",
  "HEDGE_MAX_SLIPPAGE_BPS",
  "MAX_SPREAD_BPS_FOR_TAKER",
  "MAX_SINGLE_ORDER_NOTIONAL_USD",
  "SLICE_NOTIONAL_THRESHOLD_USD",
  "SLICE_NOTIONAL_PER_CHUNK",
  "SLICE_INTERVAL_MS",
  "SLICE_JITTER_MS",
  "MIN_FILL_RATIO",
  "LAYERED_QUOTE_LEVELS",
  "LAYERED_QUOTE_SIZE_DECAY",
  "LAYERED_QUOTE_SPREAD_STEP_BPS",
  "CVAR_CONFIDENCE",
  "CVAR_MAX_TAIL_LOSS_BPS",
  "CVAR_LOOKBACK_TRADES",
  "TOXICITY_CLASSIFIER_THRESHOLD",
  "FUNDING_PRE_SETTLEMENT_WINDOW_MS",
  "FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER",
  "CASCADE_WINDOW_MS",
  "CASCADE_NOTIONAL_THRESHOLD_USD",
  "CASCADE_ZSCORE_THRESHOLD",
  "CASCADE_LOOKBACK_HOURS",
  "CASCADE_DIRECTIONAL_PCT",
  "CASCADE_MIN_PRICE_MOVE_ATR",
  "ABSORPTION_WINDOW_MS",
  "ABSORPTION_PRICE_BAND_BPS",
  "ABSORPTION_MIN_HOLD_SECONDS",
  "ENTRY_WINDOW_SECONDS",
  "IMPULSIVE_BAR_BODY_ATR",
  "IMPULSIVE_BAR_VOLUME_MULT",
  "STOP_BUFFER_ATR",
  "MIN_STOP_DISTANCE_BPS",
  "MAX_STOP_DISTANCE_BPS",
  "MIN_TIME_SINCE_LAST_CASCADE_SECONDS",
  "NEWS_BLACKOUT_MINUTES",
  "MAX_REALIZED_VOL_PERCENTILE",
  "CASCADE_TIME_STOP_HOURS",
  "PARTIAL_1_R",
  "PARTIAL_1_SIZE_PCT",
  "PARTIAL_2_R",
  "PARTIAL_2_SIZE_PCT",
  "TRAILING_STOP_PARAM",
  "RISK_PER_TRADE_PCT",
  "HEAT_CAP_PCT",
  "MAX_POSITION_NOTIONAL_PCT",
  "ASSET_LIQUIDITY_CAP_USD",
  "DAILY_LOSS_LIMIT_PCT",
  "WEEKLY_LOSS_LIMIT_PCT",
  "MAX_CONSECUTIVE_LOSSES"
] as const;

const STRATEGY_BOOLEAN_CONFIG_KEYS = [
  "HEDGE_ENABLED",
  "CASCADE_TAKER_ENABLED",
  "TOXICITY_CLASSIFIER_ENABLED"
] as const;

const STRATEGY_SELECT_CONFIG_KEYS = ["TRAILING_STOP_TYPE"] as const;
const STRATEGY_STRING_CONFIG_KEYS = ["CASCADE_INSTRUMENTS", "CASCADE_ASSET_PROFILES"] as const;

export function configDefaultsFromEnv(env: Env): GlobalRiskConfigUpdate {
  const defaults: GlobalRiskConfigUpdate = {};

  if (env.STRATEGY_MODE !== undefined) {
    defaults.STRATEGY_MODE = env.STRATEGY_MODE as GlobalRiskConfig["STRATEGY_MODE"];
  }
  if (env.MARKET_MAKING_MODE !== undefined) {
    defaults.MARKET_MAKING_MODE = env.MARKET_MAKING_MODE as GlobalRiskConfig["MARKET_MAKING_MODE"];
  }
  if (env.SENTIMENT_ALPHA_MODE !== undefined) {
    defaults.SENTIMENT_ALPHA_MODE =
      env.SENTIMENT_ALPHA_MODE as GlobalRiskConfig["SENTIMENT_ALPHA_MODE"];
  }
  if (env.ORACLE_GOVERNANCE_MODE !== undefined) {
    defaults.ORACLE_GOVERNANCE_MODE =
      env.ORACLE_GOVERNANCE_MODE as GlobalRiskConfig["ORACLE_GOVERNANCE_MODE"];
  }

  for (const key of AM_VPIN_CONFIG_KEYS) {
    copyNumberEnv(defaults, env, key);
  }
  for (const key of STRATEGY_NUMERIC_CONFIG_KEYS) {
    copyNumberEnv(defaults, env, key);
  }
  for (const key of STRATEGY_BOOLEAN_CONFIG_KEYS) {
    copyBooleanEnv(defaults, env, key);
  }
  for (const key of STRATEGY_SELECT_CONFIG_KEYS) {
    if (env[key] !== undefined) {
      defaults[key] = env[key] as GlobalRiskConfig[typeof key];
    }
  }
  for (const key of STRATEGY_STRING_CONFIG_KEYS) {
    if (env[key] !== undefined) {
      defaults[key] = env[key] as GlobalRiskConfig[typeof key];
    }
  }

  copyNumberEnv(defaults, env, "MAX_POSITION_SIZE");
  copyNumberEnv(defaults, env, "MAX_POSITION_PCT");
  copyNumberEnv(defaults, env, "MAX_INVENTORY_UNITS");
  copyNumberEnv(defaults, env, "MAX_INVENTORY_DELTA");
  copyNumberEnv(defaults, env, "MAX_DRAWDOWN_PCT");
  copyNumberEnv(defaults, env, "LATENCY_THRESHOLD_MS");
  copyNumberEnv(defaults, env, "MIN_EV_THRESHOLD");
  copyNumberEnv(defaults, env, "EXCHANGE_FEE_BPS");
  copyNumberEnv(defaults, env, "KELLY_FRACTION");
  copyNumberEnv(defaults, env, "RISK_AVERSION_FACTOR");
  copyNumberEnv(defaults, env, "FUNDING_BIAS_THRESHOLD");
  copyNumberEnv(defaults, env, "FUNDING_INVENTORY_BIAS");
  copyNumberEnv(defaults, env, "QUOTE_HIBERNATE_MS");
  copyNumberEnv(defaults, env, "VAR_CONFIDENCE_Z");
  copyNumberEnv(defaults, env, "ORACLE_MANUAL_SKEPTICISM");
  copyNumberEnv(defaults, env, "ORACLE_MAX_SKEPTICISM");

  if (env.GOLDEN_COLOS !== undefined) {
    defaults.GOLDEN_COLOS = env.GOLDEN_COLOS;
  }

  return defaults;
}

function copyNumberEnv<K extends keyof GlobalRiskConfigUpdate>(
  target: GlobalRiskConfigUpdate,
  env: Env,
  key: K
): void {
  const value = (env as unknown as Record<string, string | undefined>)[String(key)];
  if (typeof value === "string" && value.trim().length > 0) {
    (target as Record<string, unknown>)[key] = Number(value);
  }
}

function copyBooleanEnv<K extends keyof GlobalRiskConfigUpdate>(
  target: GlobalRiskConfigUpdate,
  env: Env,
  key: K
): void {
  const value = (env as unknown as Record<string, string | undefined>)[String(key)];
  if (typeof value === "string") {
    (target as Record<string, unknown>)[key] = value.toLowerCase() === "true";
  }
}

export class ConfigManager {
  constructor(
    private readonly configStore: KVNamespace,
    private readonly envDefaults: GlobalRiskConfigUpdate = {}
  ) {}

  async fetchConfig(): Promise<GlobalRiskConfig> {
    try {
      const stored = await this.configStore.get<Partial<GlobalRiskConfig>>(
        GLOBAL_RISK_SETTINGS_KEY,
        "json"
      );

      return normalizeConfig({
        ...this.envDefaults,
        ...(stored ?? {})
      });
    } catch (error) {
      console.error(
        "[Sovereign-Sigma] CONFIG_STORE read failed; fail-closed config active",
        error instanceof Error ? error.message : error
      );
      return normalizeConfig(this.envDefaults);
    }
  }

  async writeConfig(config: GlobalRiskConfig): Promise<GlobalRiskConfig> {
    const normalized = normalizeConfig(config);

    await this.configStore.put(GLOBAL_RISK_SETTINGS_KEY, JSON.stringify(normalized));

    return normalized;
  }

  static mergeUpdate(
    current: GlobalRiskConfig,
    update: AdminConfigUpdate | GlobalRiskConfigUpdate,
    updatedBy: string
  ): GlobalRiskConfig {
    const direct = extractConfigUpdate(update);

    return normalizeConfig({
      ...current,
      ...direct,
      updatedAt: new Date().toISOString(),
      updatedBy,
      version: crypto.randomUUID()
    });
  }
}

function extractConfigUpdate(
  update: AdminConfigUpdate | GlobalRiskConfigUpdate
): GlobalRiskConfigUpdate {
  const nested = "config" in update ? (update.config ?? {}) : {};
  const direct: GlobalRiskConfigUpdate = { ...nested };
  const directUpdate = update as GlobalRiskConfigUpdate;
  const tradingEnabled =
    "TRADING_ENABLED" in update ? update.TRADING_ENABLED : nested.TRADING_ENABLED;
  const strategyMode = "STRATEGY_MODE" in update ? update.STRATEGY_MODE : nested.STRATEGY_MODE;
  const oracleEnabled = "ORACLE_ENABLED" in update ? update.ORACLE_ENABLED : nested.ORACLE_ENABLED;
  const sentimentEnabled =
    "SENTIMENT_ENABLED" in update ? update.SENTIMENT_ENABLED : nested.SENTIMENT_ENABLED;
  const profilerEnabled =
    "PROFILER_ENABLED" in update ? update.PROFILER_ENABLED : nested.PROFILER_ENABLED;
  const croupierEnabled =
    "CROUPIER_ENABLED" in update ? update.CROUPIER_ENABLED : nested.CROUPIER_ENABLED;
  const pitBossEnabled =
    "PIT_BOSS_ENABLED" in update ? update.PIT_BOSS_ENABLED : nested.PIT_BOSS_ENABLED;
  const marketMakingMode =
    "MARKET_MAKING_MODE" in update ? update.MARKET_MAKING_MODE : nested.MARKET_MAKING_MODE;
  const maxPositionSize =
    "MAX_POSITION_SIZE" in update ? update.MAX_POSITION_SIZE : nested.MAX_POSITION_SIZE;
  const maxPositionPct =
    "MAX_POSITION_PCT" in update ? update.MAX_POSITION_PCT : nested.MAX_POSITION_PCT;
  const maxInventoryUnits =
    "MAX_INVENTORY_UNITS" in update ? update.MAX_INVENTORY_UNITS : nested.MAX_INVENTORY_UNITS;
  const maxInventoryDelta =
    "MAX_INVENTORY_DELTA" in update ? update.MAX_INVENTORY_DELTA : nested.MAX_INVENTORY_DELTA;
  const maxDrawdownPct =
    "MAX_DRAWDOWN_PCT" in update ? update.MAX_DRAWDOWN_PCT : nested.MAX_DRAWDOWN_PCT;
  const latencyThresholdMs =
    "LATENCY_THRESHOLD_MS" in update ? update.LATENCY_THRESHOLD_MS : nested.LATENCY_THRESHOLD_MS;
  const goldenColos = "GOLDEN_COLOS" in update ? update.GOLDEN_COLOS : nested.GOLDEN_COLOS;
  const minEvThreshold =
    "MIN_EV_THRESHOLD" in update ? update.MIN_EV_THRESHOLD : nested.MIN_EV_THRESHOLD;
  const exchangeFeeBps =
    "EXCHANGE_FEE_BPS" in update ? update.EXCHANGE_FEE_BPS : nested.EXCHANGE_FEE_BPS;
  const kellyFraction = "KELLY_FRACTION" in update ? update.KELLY_FRACTION : nested.KELLY_FRACTION;
  const riskAversionFactor =
    "RISK_AVERSION_FACTOR" in update ? update.RISK_AVERSION_FACTOR : nested.RISK_AVERSION_FACTOR;
  const fundingBiasThreshold =
    "FUNDING_BIAS_THRESHOLD" in update
      ? update.FUNDING_BIAS_THRESHOLD
      : nested.FUNDING_BIAS_THRESHOLD;
  const fundingInventoryBias =
    "FUNDING_INVENTORY_BIAS" in update
      ? update.FUNDING_INVENTORY_BIAS
      : nested.FUNDING_INVENTORY_BIAS;
  const quoteHibernateMs =
    "QUOTE_HIBERNATE_MS" in update ? update.QUOTE_HIBERNATE_MS : nested.QUOTE_HIBERNATE_MS;
  const varConfidenceZ =
    "VAR_CONFIDENCE_Z" in update ? update.VAR_CONFIDENCE_Z : nested.VAR_CONFIDENCE_Z;
  const oracleGovernanceMode =
    "ORACLE_GOVERNANCE_MODE" in update
      ? update.ORACLE_GOVERNANCE_MODE
      : nested.ORACLE_GOVERNANCE_MODE;
  const oracleManualSkepticism =
    "ORACLE_MANUAL_SKEPTICISM" in update
      ? update.ORACLE_MANUAL_SKEPTICISM
      : nested.ORACLE_MANUAL_SKEPTICISM;
  const oracleMaxSkepticism =
    "ORACLE_MAX_SKEPTICISM" in update ? update.ORACLE_MAX_SKEPTICISM : nested.ORACLE_MAX_SKEPTICISM;

  if (tradingEnabled !== undefined) {
    direct.TRADING_ENABLED = tradingEnabled;
  }
  if (strategyMode !== undefined) {
    direct.STRATEGY_MODE = strategyMode;
  }
  if (oracleEnabled !== undefined) {
    direct.ORACLE_ENABLED = oracleEnabled;
  }
  if (sentimentEnabled !== undefined) {
    direct.SENTIMENT_ENABLED = sentimentEnabled;
  }
  if (profilerEnabled !== undefined) {
    direct.PROFILER_ENABLED = profilerEnabled;
  }
  if (croupierEnabled !== undefined) {
    direct.CROUPIER_ENABLED = croupierEnabled;
  }
  if (pitBossEnabled !== undefined) {
    direct.PIT_BOSS_ENABLED = pitBossEnabled;
  }
  if (marketMakingMode !== undefined) {
    direct.MARKET_MAKING_MODE = marketMakingMode;
  }
  if (maxPositionSize !== undefined) {
    direct.MAX_POSITION_SIZE = maxPositionSize;
  }
  if (maxPositionPct !== undefined) {
    direct.MAX_POSITION_PCT = maxPositionPct;
  }
  if (maxInventoryUnits !== undefined) {
    direct.MAX_INVENTORY_UNITS = maxInventoryUnits;
  }
  if (maxInventoryDelta !== undefined) {
    direct.MAX_INVENTORY_DELTA = maxInventoryDelta;
  }
  if (maxDrawdownPct !== undefined) {
    direct.MAX_DRAWDOWN_PCT = maxDrawdownPct;
  }
  if (latencyThresholdMs !== undefined) {
    direct.LATENCY_THRESHOLD_MS = latencyThresholdMs;
  }
  if (goldenColos !== undefined) {
    direct.GOLDEN_COLOS = goldenColos;
  }
  if (minEvThreshold !== undefined) {
    direct.MIN_EV_THRESHOLD = minEvThreshold;
  }
  if (exchangeFeeBps !== undefined) {
    direct.EXCHANGE_FEE_BPS = exchangeFeeBps;
  }
  if (kellyFraction !== undefined) {
    direct.KELLY_FRACTION = kellyFraction;
  }
  if (riskAversionFactor !== undefined) {
    direct.RISK_AVERSION_FACTOR = riskAversionFactor;
  }
  if (fundingBiasThreshold !== undefined) {
    direct.FUNDING_BIAS_THRESHOLD = fundingBiasThreshold;
  }
  if (fundingInventoryBias !== undefined) {
    direct.FUNDING_INVENTORY_BIAS = fundingInventoryBias;
  }
  if (quoteHibernateMs !== undefined) {
    direct.QUOTE_HIBERNATE_MS = quoteHibernateMs;
  }
  if (varConfidenceZ !== undefined) {
    direct.VAR_CONFIDENCE_Z = varConfidenceZ;
  }
  if (oracleGovernanceMode !== undefined) {
    direct.ORACLE_GOVERNANCE_MODE = oracleGovernanceMode;
  }
  if (oracleManualSkepticism !== undefined) {
    direct.ORACLE_MANUAL_SKEPTICISM = oracleManualSkepticism;
  }
  if (oracleMaxSkepticism !== undefined) {
    direct.ORACLE_MAX_SKEPTICISM = oracleMaxSkepticism;
  }
  for (const key of AM_VPIN_CONFIG_KEYS) {
    const value = directUpdate[key] !== undefined ? directUpdate[key] : nested[key];
    if (value !== undefined) {
      direct[key] = value as number;
    }
  }
  for (const key of STRATEGY_NUMERIC_CONFIG_KEYS) {
    const value = directUpdate[key] !== undefined ? directUpdate[key] : nested[key];
    if (value !== undefined) {
      direct[key] = value as number;
    }
  }
  for (const key of STRATEGY_BOOLEAN_CONFIG_KEYS) {
    const value = directUpdate[key] !== undefined ? directUpdate[key] : nested[key];
    if (value !== undefined) {
      direct[key] = value as boolean;
    }
  }
  for (const key of STRATEGY_SELECT_CONFIG_KEYS) {
    const value = directUpdate[key] !== undefined ? directUpdate[key] : nested[key];
    if (value !== undefined) {
      direct[key] = value as GlobalRiskConfig[typeof key];
    }
  }
  for (const key of STRATEGY_STRING_CONFIG_KEYS) {
    const value = directUpdate[key] !== undefined ? directUpdate[key] : nested[key];
    if (value !== undefined) {
      direct[key] = value as GlobalRiskConfig[typeof key];
    }
  }

  const sentimentAlphaMode =
    "SENTIMENT_ALPHA_MODE" in update ? update.SENTIMENT_ALPHA_MODE : nested.SENTIMENT_ALPHA_MODE;
  if (sentimentAlphaMode !== undefined) {
    direct.SENTIMENT_ALPHA_MODE = sentimentAlphaMode;
  }

  return direct;
}

function normalizeConfig(value: Partial<GlobalRiskConfig>): GlobalRiskConfig {
  return {
    TRADING_ENABLED: value.TRADING_ENABLED === true,
    STRATEGY_MODE: normalizeStrategyMode(value.STRATEGY_MODE),
    ORACLE_ENABLED: value.ORACLE_ENABLED !== false,
    SENTIMENT_ENABLED: value.SENTIMENT_ENABLED !== false,
    PROFILER_ENABLED: value.PROFILER_ENABLED !== false,
    CROUPIER_ENABLED: value.CROUPIER_ENABLED !== false,
    PIT_BOSS_ENABLED: value.PIT_BOSS_ENABLED !== false,
    MARKET_MAKING_MODE: normalizeMarketMakingMode(value.MARKET_MAKING_MODE),
    MAX_POSITION_SIZE: nonNegativeNumber(value.MAX_POSITION_SIZE),
    MAX_POSITION_PCT: percentFraction(value.MAX_POSITION_PCT, 0, 1, defaultConfig.MAX_POSITION_PCT),
    MAX_INVENTORY_UNITS: nonNegativeNumber(value.MAX_INVENTORY_UNITS),
    MAX_INVENTORY_DELTA: nonNegativeNumberWithFallback(
      value.MAX_INVENTORY_DELTA,
      defaultConfig.MAX_INVENTORY_DELTA
    ),
    MAX_DRAWDOWN_PCT: percentFraction(value.MAX_DRAWDOWN_PCT, 0, 1, defaultConfig.MAX_DRAWDOWN_PCT),
    LATENCY_THRESHOLD_MS: positiveInteger(
      value.LATENCY_THRESHOLD_MS,
      defaultConfig.LATENCY_THRESHOLD_MS
    ),
    GOLDEN_COLOS: normalizeColoCsv(value.GOLDEN_COLOS),
    MIN_EV_THRESHOLD: finiteNumber(value.MIN_EV_THRESHOLD, defaultConfig.MIN_EV_THRESHOLD),
    EXCHANGE_FEE_BPS: nonNegativeNumber(value.EXCHANGE_FEE_BPS),
    KELLY_FRACTION: boundedNumber(value.KELLY_FRACTION, 0, 1, defaultConfig.KELLY_FRACTION),
    RISK_AVERSION_FACTOR: positiveNumber(
      value.RISK_AVERSION_FACTOR,
      defaultConfig.RISK_AVERSION_FACTOR
    ),
    FUNDING_BIAS_THRESHOLD: nonNegativeNumberWithFallback(
      value.FUNDING_BIAS_THRESHOLD,
      defaultConfig.FUNDING_BIAS_THRESHOLD
    ),
    FUNDING_INVENTORY_BIAS: nonNegativeNumberWithFallback(
      value.FUNDING_INVENTORY_BIAS,
      defaultConfig.FUNDING_INVENTORY_BIAS
    ),
    HEDGE_ENABLED: value.HEDGE_ENABLED === true,
    HEDGE_TRIGGER_INVENTORY_PCT: boundedNumber(
      value.HEDGE_TRIGGER_INVENTORY_PCT,
      0.1,
      1,
      defaultConfig.HEDGE_TRIGGER_INVENTORY_PCT
    ),
    HEDGE_COOLDOWN_MS: boundedInteger(
      value.HEDGE_COOLDOWN_MS,
      1_000,
      300_000,
      defaultConfig.HEDGE_COOLDOWN_MS
    ),
    HEDGE_MAX_SLIPPAGE_BPS: boundedNumber(
      value.HEDGE_MAX_SLIPPAGE_BPS,
      0.1,
      100,
      defaultConfig.HEDGE_MAX_SLIPPAGE_BPS
    ),
    CASCADE_TAKER_ENABLED: value.CASCADE_TAKER_ENABLED === true,
    CASCADE_INSTRUMENTS: normalizeInstrumentCsv(value.CASCADE_INSTRUMENTS),
    CASCADE_ASSET_PROFILES: normalizeCascadeAssetProfiles(value.CASCADE_ASSET_PROFILES),
    MAX_SPREAD_BPS_FOR_TAKER: boundedNumber(
      value.MAX_SPREAD_BPS_FOR_TAKER,
      0.1,
      500,
      defaultConfig.MAX_SPREAD_BPS_FOR_TAKER
    ),
    MAX_SINGLE_ORDER_NOTIONAL_USD: nonNegativeNumberWithFallback(
      value.MAX_SINGLE_ORDER_NOTIONAL_USD,
      defaultConfig.MAX_SINGLE_ORDER_NOTIONAL_USD
    ),
    SLICE_NOTIONAL_THRESHOLD_USD: positiveNumber(
      value.SLICE_NOTIONAL_THRESHOLD_USD,
      defaultConfig.SLICE_NOTIONAL_THRESHOLD_USD
    ),
    SLICE_NOTIONAL_PER_CHUNK: positiveNumber(
      value.SLICE_NOTIONAL_PER_CHUNK,
      defaultConfig.SLICE_NOTIONAL_PER_CHUNK
    ),
    SLICE_INTERVAL_MS: boundedInteger(
      value.SLICE_INTERVAL_MS,
      0,
      60_000,
      defaultConfig.SLICE_INTERVAL_MS
    ),
    SLICE_JITTER_MS: boundedInteger(
      value.SLICE_JITTER_MS,
      0,
      60_000,
      defaultConfig.SLICE_JITTER_MS
    ),
    MIN_FILL_RATIO: boundedNumber(value.MIN_FILL_RATIO, 0, 1, defaultConfig.MIN_FILL_RATIO),
    LAYERED_QUOTE_LEVELS: boundedInteger(
      value.LAYERED_QUOTE_LEVELS,
      1,
      5,
      defaultConfig.LAYERED_QUOTE_LEVELS
    ),
    LAYERED_QUOTE_SIZE_DECAY: boundedNumber(
      value.LAYERED_QUOTE_SIZE_DECAY,
      0.1,
      1,
      defaultConfig.LAYERED_QUOTE_SIZE_DECAY
    ),
    LAYERED_QUOTE_SPREAD_STEP_BPS: boundedNumber(
      value.LAYERED_QUOTE_SPREAD_STEP_BPS,
      0,
      25,
      defaultConfig.LAYERED_QUOTE_SPREAD_STEP_BPS
    ),
    CVAR_CONFIDENCE: boundedNumber(
      value.CVAR_CONFIDENCE,
      0.9,
      0.999,
      defaultConfig.CVAR_CONFIDENCE
    ),
    CVAR_MAX_TAIL_LOSS_BPS: boundedNumber(
      value.CVAR_MAX_TAIL_LOSS_BPS,
      1,
      1_000,
      defaultConfig.CVAR_MAX_TAIL_LOSS_BPS
    ),
    CVAR_LOOKBACK_TRADES: boundedInteger(
      value.CVAR_LOOKBACK_TRADES,
      25,
      5_000,
      defaultConfig.CVAR_LOOKBACK_TRADES
    ),
    SENTIMENT_ALPHA_MODE: normalizeSentimentAlphaMode(value.SENTIMENT_ALPHA_MODE),
    TOXICITY_CLASSIFIER_ENABLED: value.TOXICITY_CLASSIFIER_ENABLED !== false,
    TOXICITY_CLASSIFIER_THRESHOLD: boundedNumber(
      value.TOXICITY_CLASSIFIER_THRESHOLD,
      0,
      1,
      defaultConfig.TOXICITY_CLASSIFIER_THRESHOLD
    ),
    FUNDING_PRE_SETTLEMENT_WINDOW_MS: boundedInteger(
      value.FUNDING_PRE_SETTLEMENT_WINDOW_MS,
      0,
      3_600_000,
      defaultConfig.FUNDING_PRE_SETTLEMENT_WINDOW_MS
    ),
    FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER: boundedNumber(
      value.FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER,
      1,
      10,
      defaultConfig.FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER
    ),
    QUOTE_HIBERNATE_MS: positiveInteger(value.QUOTE_HIBERNATE_MS, defaultConfig.QUOTE_HIBERNATE_MS),
    VAR_CONFIDENCE_Z: positiveNumber(value.VAR_CONFIDENCE_Z, defaultConfig.VAR_CONFIDENCE_Z),
    ORACLE_GOVERNANCE_MODE: normalizeGovernanceMode(value.ORACLE_GOVERNANCE_MODE),
    ORACLE_MANUAL_SKEPTICISM: boundedNumber(
      value.ORACLE_MANUAL_SKEPTICISM,
      1,
      10,
      defaultConfig.ORACLE_MANUAL_SKEPTICISM
    ),
    ORACLE_MAX_SKEPTICISM: boundedNumber(
      value.ORACLE_MAX_SKEPTICISM,
      1,
      10,
      defaultConfig.ORACLE_MAX_SKEPTICISM
    ),
    AM_VPIN_BUCKET_VOLUME: positiveNumber(
      value.AM_VPIN_BUCKET_VOLUME,
      defaultConfig.AM_VPIN_BUCKET_VOLUME
    ),
    AM_VPIN_ROLLING_WINDOW: boundedInteger(
      value.AM_VPIN_ROLLING_WINDOW,
      5,
      500,
      defaultConfig.AM_VPIN_ROLLING_WINDOW
    ),
    AM_VPIN_DIRECTIONAL_DECAY: boundedNumber(
      value.AM_VPIN_DIRECTIONAL_DECAY,
      0,
      0.999,
      defaultConfig.AM_VPIN_DIRECTIONAL_DECAY
    ),
    AM_VPIN_NORMAL_THRESHOLD: boundedNumber(
      value.AM_VPIN_NORMAL_THRESHOLD,
      0,
      1,
      defaultConfig.AM_VPIN_NORMAL_THRESHOLD
    ),
    AM_VPIN_TOXIC_THRESHOLD: boundedNumber(
      value.AM_VPIN_TOXIC_THRESHOLD,
      0,
      1,
      defaultConfig.AM_VPIN_TOXIC_THRESHOLD
    ),
    AM_VPIN_CRITICAL_THRESHOLD: boundedNumber(
      value.AM_VPIN_CRITICAL_THRESHOLD,
      0,
      1,
      defaultConfig.AM_VPIN_CRITICAL_THRESHOLD
    ),
    AM_VPIN_OBI_DEPTH: boundedInteger(
      value.AM_VPIN_OBI_DEPTH,
      1,
      50,
      defaultConfig.AM_VPIN_OBI_DEPTH
    ),
    AM_VPIN_CRITICAL_OBI: boundedNumber(
      value.AM_VPIN_CRITICAL_OBI,
      0,
      1,
      defaultConfig.AM_VPIN_CRITICAL_OBI
    ),
    AM_VPIN_CONTESTED_SPREAD_MULTIPLIER: boundedNumber(
      value.AM_VPIN_CONTESTED_SPREAD_MULTIPLIER,
      1,
      10,
      defaultConfig.AM_VPIN_CONTESTED_SPREAD_MULTIPLIER
    ),
    AM_VPIN_TOXIC_SPREAD_MULTIPLIER: boundedNumber(
      value.AM_VPIN_TOXIC_SPREAD_MULTIPLIER,
      1,
      10,
      defaultConfig.AM_VPIN_TOXIC_SPREAD_MULTIPLIER
    ),
    AM_VPIN_QUOTE_HALT_MS: positiveInteger(
      value.AM_VPIN_QUOTE_HALT_MS,
      defaultConfig.AM_VPIN_QUOTE_HALT_MS
    ),
    CASCADE_WINDOW_MS: boundedInteger(
      value.CASCADE_WINDOW_MS,
      60_000,
      3_600_000,
      defaultConfig.CASCADE_WINDOW_MS
    ),
    CASCADE_NOTIONAL_THRESHOLD_USD: positiveNumber(
      value.CASCADE_NOTIONAL_THRESHOLD_USD,
      defaultConfig.CASCADE_NOTIONAL_THRESHOLD_USD
    ),
    CASCADE_ZSCORE_THRESHOLD: boundedNumber(
      value.CASCADE_ZSCORE_THRESHOLD,
      0,
      20,
      defaultConfig.CASCADE_ZSCORE_THRESHOLD
    ),
    CASCADE_LOOKBACK_HOURS: boundedInteger(
      value.CASCADE_LOOKBACK_HOURS,
      1,
      168,
      defaultConfig.CASCADE_LOOKBACK_HOURS
    ),
    CASCADE_DIRECTIONAL_PCT: boundedNumber(
      value.CASCADE_DIRECTIONAL_PCT,
      0.5,
      1,
      defaultConfig.CASCADE_DIRECTIONAL_PCT
    ),
    CASCADE_MIN_PRICE_MOVE_ATR: boundedNumber(
      value.CASCADE_MIN_PRICE_MOVE_ATR,
      0,
      10,
      defaultConfig.CASCADE_MIN_PRICE_MOVE_ATR
    ),
    ABSORPTION_WINDOW_MS: boundedInteger(
      value.ABSORPTION_WINDOW_MS,
      60_000,
      6 * 3_600_000,
      defaultConfig.ABSORPTION_WINDOW_MS
    ),
    ABSORPTION_PRICE_BAND_BPS: boundedNumber(
      value.ABSORPTION_PRICE_BAND_BPS,
      1,
      500,
      defaultConfig.ABSORPTION_PRICE_BAND_BPS
    ),
    ABSORPTION_MIN_HOLD_SECONDS: boundedInteger(
      value.ABSORPTION_MIN_HOLD_SECONDS,
      5,
      3_600,
      defaultConfig.ABSORPTION_MIN_HOLD_SECONDS
    ),
    ENTRY_WINDOW_SECONDS: boundedInteger(
      value.ENTRY_WINDOW_SECONDS,
      60,
      6 * 3_600,
      defaultConfig.ENTRY_WINDOW_SECONDS
    ),
    IMPULSIVE_BAR_BODY_ATR: boundedNumber(
      value.IMPULSIVE_BAR_BODY_ATR,
      0.1,
      10,
      defaultConfig.IMPULSIVE_BAR_BODY_ATR
    ),
    IMPULSIVE_BAR_VOLUME_MULT: boundedNumber(
      value.IMPULSIVE_BAR_VOLUME_MULT,
      0.1,
      20,
      defaultConfig.IMPULSIVE_BAR_VOLUME_MULT
    ),
    STOP_BUFFER_ATR: boundedNumber(value.STOP_BUFFER_ATR, 0, 5, defaultConfig.STOP_BUFFER_ATR),
    MIN_STOP_DISTANCE_BPS: boundedNumber(
      value.MIN_STOP_DISTANCE_BPS,
      1,
      2_000,
      defaultConfig.MIN_STOP_DISTANCE_BPS
    ),
    MAX_STOP_DISTANCE_BPS: boundedNumber(
      value.MAX_STOP_DISTANCE_BPS,
      1,
      5_000,
      defaultConfig.MAX_STOP_DISTANCE_BPS
    ),
    MIN_TIME_SINCE_LAST_CASCADE_SECONDS: boundedInteger(
      value.MIN_TIME_SINCE_LAST_CASCADE_SECONDS,
      0,
      24 * 3_600,
      defaultConfig.MIN_TIME_SINCE_LAST_CASCADE_SECONDS
    ),
    NEWS_BLACKOUT_MINUTES: boundedInteger(
      value.NEWS_BLACKOUT_MINUTES,
      0,
      24 * 60,
      defaultConfig.NEWS_BLACKOUT_MINUTES
    ),
    MAX_REALIZED_VOL_PERCENTILE: percentFraction(
      value.MAX_REALIZED_VOL_PERCENTILE,
      0,
      1,
      defaultConfig.MAX_REALIZED_VOL_PERCENTILE
    ),
    CASCADE_TIME_STOP_HOURS: boundedNumber(
      value.CASCADE_TIME_STOP_HOURS,
      0.25,
      72,
      defaultConfig.CASCADE_TIME_STOP_HOURS
    ),
    PARTIAL_1_R: boundedNumber(value.PARTIAL_1_R, 0.25, 20, defaultConfig.PARTIAL_1_R),
    PARTIAL_1_SIZE_PCT: boundedNumber(
      value.PARTIAL_1_SIZE_PCT,
      0,
      100,
      defaultConfig.PARTIAL_1_SIZE_PCT
    ),
    PARTIAL_2_R: boundedNumber(value.PARTIAL_2_R, 0.25, 30, defaultConfig.PARTIAL_2_R),
    PARTIAL_2_SIZE_PCT: boundedNumber(
      value.PARTIAL_2_SIZE_PCT,
      0,
      100,
      defaultConfig.PARTIAL_2_SIZE_PCT
    ),
    TRAILING_STOP_TYPE: normalizeTrailingStopType(value.TRAILING_STOP_TYPE),
    TRAILING_STOP_PARAM: boundedNumber(
      value.TRAILING_STOP_PARAM,
      0.1,
      20,
      defaultConfig.TRAILING_STOP_PARAM
    ),
    RISK_PER_TRADE_PCT: percentFraction(
      value.RISK_PER_TRADE_PCT,
      0,
      0.05,
      defaultConfig.RISK_PER_TRADE_PCT
    ),
    HEAT_CAP_PCT: percentFraction(value.HEAT_CAP_PCT, 0, 0.25, defaultConfig.HEAT_CAP_PCT),
    MAX_POSITION_NOTIONAL_PCT: percentFraction(
      value.MAX_POSITION_NOTIONAL_PCT,
      0,
      1,
      defaultConfig.MAX_POSITION_NOTIONAL_PCT
    ),
    ASSET_LIQUIDITY_CAP_USD: nonNegativeNumberWithFallback(
      value.ASSET_LIQUIDITY_CAP_USD,
      defaultConfig.ASSET_LIQUIDITY_CAP_USD
    ),
    DAILY_LOSS_LIMIT_PCT: percentFraction(
      value.DAILY_LOSS_LIMIT_PCT,
      0,
      1,
      defaultConfig.DAILY_LOSS_LIMIT_PCT
    ),
    WEEKLY_LOSS_LIMIT_PCT: percentFraction(
      value.WEEKLY_LOSS_LIMIT_PCT,
      0,
      1,
      defaultConfig.WEEKLY_LOSS_LIMIT_PCT
    ),
    MAX_CONSECUTIVE_LOSSES: boundedInteger(
      value.MAX_CONSECUTIVE_LOSSES,
      1,
      100,
      defaultConfig.MAX_CONSECUTIVE_LOSSES
    ),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : defaultConfig.updatedAt,
    updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : defaultConfig.updatedBy,
    version: typeof value.version === "string" ? value.version : defaultConfig.version
  };
}

function normalizeGovernanceMode(value: unknown): GlobalRiskConfig["ORACLE_GOVERNANCE_MODE"] {
  return value === "MANUAL" || value === "AUTONOMOUS" || value === "HYBRID"
    ? value
    : defaultConfig.ORACLE_GOVERNANCE_MODE;
}

function normalizeMarketMakingMode(value: unknown): GlobalRiskConfig["MARKET_MAKING_MODE"] {
  return value === "OFF" ||
    value === "PASSIVE" ||
    value === "BALANCED" ||
    value === "AGGRESSIVE" ||
    value === "INVENTORY_SKEW_ONLY"
    ? value
    : defaultConfig.MARKET_MAKING_MODE;
}

function normalizeStrategyMode(value: unknown): GlobalRiskConfig["STRATEGY_MODE"] {
  return value === "OFF" ||
    value === "MARKET_MAKING" ||
    value === "CASCADE_RECOVERY" ||
    value === "BOTH_SHADOW" ||
    value === "BOTH_LIVE"
    ? value
    : defaultConfig.STRATEGY_MODE;
}

function normalizeSentimentAlphaMode(value: unknown): GlobalRiskConfig["SENTIMENT_ALPHA_MODE"] {
  return value === "OFF" || value === "EVENT_RISK_ONLY" || value === "CONTINUOUS"
    ? value
    : defaultConfig.SENTIMENT_ALPHA_MODE;
}

function normalizeTrailingStopType(value: unknown): GlobalRiskConfig["TRAILING_STOP_TYPE"] {
  return value === "ATR" || value === "EMA" ? value : defaultConfig.TRAILING_STOP_TYPE;
}

function normalizeColoCsv(value: unknown): string {
  if (typeof value !== "string") {
    return defaultConfig.GOLDEN_COLOS;
  }

  return value
    .split(",")
    .map((colo) => colo.trim().toUpperCase())
    .filter((colo) => /^[A-Z0-9]{3,4}$/.test(colo))
    .filter((colo, index, colos) => colos.indexOf(colo) === index)
    .join(",");
}

function normalizeInstrumentCsv(value: unknown): string {
  if (typeof value !== "string") {
    return defaultConfig.CASCADE_INSTRUMENTS;
  }

  const instruments = value
    .split(",")
    .map((asset) => asset.trim().toUpperCase())
    .filter((asset) => /^[A-Z0-9]{2,12}$/.test(asset))
    .filter((asset, index, assets) => assets.indexOf(asset) === index);

  return instruments.length > 0 ? instruments.join(",") : defaultConfig.CASCADE_INSTRUMENTS;
}

function normalizeCascadeAssetProfiles(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(parseCascadeAssetProfiles(value));
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(parseCascadeAssetProfiles(JSON.stringify(value)));
  }

  return defaultConfig.CASCADE_ASSET_PROFILES;
}

function nonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nonNegativeNumberWithFallback(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function percentFraction(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const fraction = parsed >= 1 ? parsed / 100 : parsed;
  return fraction >= minimum && fraction <= maximum ? fraction : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? Math.round(parsed)
    : fallback;
}
