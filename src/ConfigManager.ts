import type { AdminConfigUpdate, GlobalRiskConfig, GlobalRiskConfigUpdate } from "./types";

export const GLOBAL_RISK_SETTINGS_KEY = "global_risk_settings";

export const defaultConfig: GlobalRiskConfig = {
  TRADING_ENABLED: false,
  MAX_POSITION_SIZE: 0,
  MAX_POSITION_PCT: 0,
  MAX_INVENTORY_UNITS: 0,
  MAX_INVENTORY_DELTA: 1,
  MAX_DRAWDOWN_PCT: 0,
  LATENCY_THRESHOLD_MS: 250,
  GOLDEN_COLOS: "",
  MIN_EV_THRESHOLD: 0,
  EXCHANGE_FEE_BPS: 0,
  KELLY_FRACTION: 0.5,
  RISK_AVERSION_FACTOR: 0.01,
  FUNDING_BIAS_THRESHOLD: 0.00001,
  FUNDING_INVENTORY_BIAS: 0.25,
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

export class ConfigManager {
  constructor(private readonly configStore: KVNamespace) {}

  async fetchConfig(): Promise<GlobalRiskConfig> {
    try {
      const stored = await this.configStore.get<Partial<GlobalRiskConfig>>(
        GLOBAL_RISK_SETTINGS_KEY,
        "json"
      );

      return normalizeConfig(stored ?? defaultConfig);
    } catch (error) {
      console.error(
        "[Sovereign-Sigma] CONFIG_STORE read failed; fail-closed config active",
        error instanceof Error ? error.message : error
      );
      return { ...defaultConfig };
    }
  }

  async writeConfig(config: GlobalRiskConfig): Promise<GlobalRiskConfig> {
    const normalized = normalizeConfig(config);

    await this.configStore.put(
      GLOBAL_RISK_SETTINGS_KEY,
      JSON.stringify(normalized)
    );

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
  const nested = "config" in update ? update.config ?? {} : {};
  const direct: GlobalRiskConfigUpdate = { ...nested };
  const tradingEnabled =
    "TRADING_ENABLED" in update ? update.TRADING_ENABLED : nested.TRADING_ENABLED;
  const maxPositionSize =
    "MAX_POSITION_SIZE" in update
      ? update.MAX_POSITION_SIZE
      : nested.MAX_POSITION_SIZE;
  const maxPositionPct =
    "MAX_POSITION_PCT" in update
      ? update.MAX_POSITION_PCT
      : nested.MAX_POSITION_PCT;
  const maxInventoryUnits =
    "MAX_INVENTORY_UNITS" in update
      ? update.MAX_INVENTORY_UNITS
      : nested.MAX_INVENTORY_UNITS;
  const maxInventoryDelta =
    "MAX_INVENTORY_DELTA" in update
      ? update.MAX_INVENTORY_DELTA
      : nested.MAX_INVENTORY_DELTA;
  const maxDrawdownPct =
    "MAX_DRAWDOWN_PCT" in update
      ? update.MAX_DRAWDOWN_PCT
      : nested.MAX_DRAWDOWN_PCT;
  const latencyThresholdMs =
    "LATENCY_THRESHOLD_MS" in update
      ? update.LATENCY_THRESHOLD_MS
      : nested.LATENCY_THRESHOLD_MS;
  const goldenColos =
    "GOLDEN_COLOS" in update ? update.GOLDEN_COLOS : nested.GOLDEN_COLOS;
  const minEvThreshold =
    "MIN_EV_THRESHOLD" in update
      ? update.MIN_EV_THRESHOLD
      : nested.MIN_EV_THRESHOLD;
  const exchangeFeeBps =
    "EXCHANGE_FEE_BPS" in update
      ? update.EXCHANGE_FEE_BPS
      : nested.EXCHANGE_FEE_BPS;
  const kellyFraction =
    "KELLY_FRACTION" in update
      ? update.KELLY_FRACTION
      : nested.KELLY_FRACTION;
  const riskAversionFactor =
    "RISK_AVERSION_FACTOR" in update
      ? update.RISK_AVERSION_FACTOR
      : nested.RISK_AVERSION_FACTOR;
  const fundingBiasThreshold =
    "FUNDING_BIAS_THRESHOLD" in update
      ? update.FUNDING_BIAS_THRESHOLD
      : nested.FUNDING_BIAS_THRESHOLD;
  const fundingInventoryBias =
    "FUNDING_INVENTORY_BIAS" in update
      ? update.FUNDING_INVENTORY_BIAS
      : nested.FUNDING_INVENTORY_BIAS;
  const quoteHibernateMs =
    "QUOTE_HIBERNATE_MS" in update
      ? update.QUOTE_HIBERNATE_MS
      : nested.QUOTE_HIBERNATE_MS;
  const varConfidenceZ =
    "VAR_CONFIDENCE_Z" in update
      ? update.VAR_CONFIDENCE_Z
      : nested.VAR_CONFIDENCE_Z;
  const oracleGovernanceMode =
    "ORACLE_GOVERNANCE_MODE" in update
      ? update.ORACLE_GOVERNANCE_MODE
      : nested.ORACLE_GOVERNANCE_MODE;
  const oracleManualSkepticism =
    "ORACLE_MANUAL_SKEPTICISM" in update
      ? update.ORACLE_MANUAL_SKEPTICISM
      : nested.ORACLE_MANUAL_SKEPTICISM;
  const oracleMaxSkepticism =
    "ORACLE_MAX_SKEPTICISM" in update
      ? update.ORACLE_MAX_SKEPTICISM
      : nested.ORACLE_MAX_SKEPTICISM;

  if (tradingEnabled !== undefined) {
    direct.TRADING_ENABLED = tradingEnabled;
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
    const value = key in update ? update[key] : nested[key];
    if (value !== undefined) {
      direct[key] = value as number;
    }
  }

  return direct;
}

function normalizeConfig(value: Partial<GlobalRiskConfig>): GlobalRiskConfig {
  return {
    TRADING_ENABLED: value.TRADING_ENABLED === true,
    MAX_POSITION_SIZE: nonNegativeNumber(value.MAX_POSITION_SIZE),
    MAX_POSITION_PCT: boundedNumber(value.MAX_POSITION_PCT, 0, 1, defaultConfig.MAX_POSITION_PCT),
    MAX_INVENTORY_UNITS: nonNegativeNumber(value.MAX_INVENTORY_UNITS),
    MAX_INVENTORY_DELTA: nonNegativeNumberWithFallback(
      value.MAX_INVENTORY_DELTA,
      defaultConfig.MAX_INVENTORY_DELTA
    ),
    MAX_DRAWDOWN_PCT: nonNegativeNumber(value.MAX_DRAWDOWN_PCT),
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
    QUOTE_HIBERNATE_MS: positiveInteger(
      value.QUOTE_HIBERNATE_MS,
      defaultConfig.QUOTE_HIBERNATE_MS
    ),
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
    AM_VPIN_CONTESTED_SPREAD_MULTIPLIER: 1,
    AM_VPIN_TOXIC_SPREAD_MULTIPLIER: 1,
    AM_VPIN_QUOTE_HALT_MS: positiveInteger(
      value.AM_VPIN_QUOTE_HALT_MS,
      defaultConfig.AM_VPIN_QUOTE_HALT_MS
    ),
    updatedAt:
      typeof value.updatedAt === "string" ? value.updatedAt : defaultConfig.updatedAt,
    updatedBy:
      typeof value.updatedBy === "string" ? value.updatedBy : defaultConfig.updatedBy,
    version: typeof value.version === "string" ? value.version : defaultConfig.version
  };
}

function normalizeGovernanceMode(value: unknown): GlobalRiskConfig["ORACLE_GOVERNANCE_MODE"] {
  return value === "MANUAL" || value === "AUTONOMOUS" || value === "HYBRID"
    ? value
    : defaultConfig.ORACLE_GOVERNANCE_MODE;
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
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
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
