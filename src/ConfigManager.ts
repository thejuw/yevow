import type { AdminConfigUpdate, GlobalRiskConfig, GlobalRiskConfigUpdate } from "./types";

export const GLOBAL_RISK_SETTINGS_KEY = "global_risk_settings";

export const defaultConfig: GlobalRiskConfig = {
  TRADING_ENABLED: false,
  MAX_POSITION_SIZE: 0,
  MAX_POSITION_PCT: 0,
  MAX_INVENTORY_UNITS: 0,
  MAX_DRAWDOWN_PCT: 0,
  LATENCY_THRESHOLD_MS: 250,
  MIN_EV_THRESHOLD: 0,
  EXCHANGE_FEE_BPS: 0,
  KELLY_FRACTION: 0.5,
  RISK_AVERSION_FACTOR: 0.01,
  QUOTE_HIBERNATE_MS: 3_000,
  VAR_CONFIDENCE_Z: 2.326,
  ORACLE_GOVERNANCE_MODE: "HYBRID",
  ORACLE_MANUAL_SKEPTICISM: 1.4,
  ORACLE_MAX_SKEPTICISM: 4,
  updatedAt: "1970-01-01T00:00:00.000Z",
  updatedBy: "system-default",
  version: "fail-closed"
};

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
  const maxDrawdownPct =
    "MAX_DRAWDOWN_PCT" in update
      ? update.MAX_DRAWDOWN_PCT
      : nested.MAX_DRAWDOWN_PCT;
  const latencyThresholdMs =
    "LATENCY_THRESHOLD_MS" in update
      ? update.LATENCY_THRESHOLD_MS
      : nested.LATENCY_THRESHOLD_MS;
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
  if (maxDrawdownPct !== undefined) {
    direct.MAX_DRAWDOWN_PCT = maxDrawdownPct;
  }
  if (latencyThresholdMs !== undefined) {
    direct.LATENCY_THRESHOLD_MS = latencyThresholdMs;
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

  return direct;
}

function normalizeConfig(value: Partial<GlobalRiskConfig>): GlobalRiskConfig {
  return {
    TRADING_ENABLED: value.TRADING_ENABLED === true,
    MAX_POSITION_SIZE: nonNegativeNumber(value.MAX_POSITION_SIZE),
    MAX_POSITION_PCT: boundedNumber(value.MAX_POSITION_PCT, 0, 1, defaultConfig.MAX_POSITION_PCT),
    MAX_INVENTORY_UNITS: nonNegativeNumber(value.MAX_INVENTORY_UNITS),
    MAX_DRAWDOWN_PCT: nonNegativeNumber(value.MAX_DRAWDOWN_PCT),
    LATENCY_THRESHOLD_MS: positiveInteger(
      value.LATENCY_THRESHOLD_MS,
      defaultConfig.LATENCY_THRESHOLD_MS
    ),
    MIN_EV_THRESHOLD: finiteNumber(value.MIN_EV_THRESHOLD, defaultConfig.MIN_EV_THRESHOLD),
    EXCHANGE_FEE_BPS: nonNegativeNumber(value.EXCHANGE_FEE_BPS),
    KELLY_FRACTION: boundedNumber(value.KELLY_FRACTION, 0, 1, defaultConfig.KELLY_FRACTION),
    RISK_AVERSION_FACTOR: positiveNumber(
      value.RISK_AVERSION_FACTOR,
      defaultConfig.RISK_AVERSION_FACTOR
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

function nonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
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
