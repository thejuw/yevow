import type { Logger } from "../Logger";
import type { AdminConfigUpdate, EdgeTopology, Env, GlobalRiskConfig, JsonRecord } from "../types";
import { CASCADE_LAST_CONFIG_CHANGE_AT_KEY, CASCADE_PAPER_ARMED_AT_KEY } from "./GatewayConstants";

export type ConfigDiff = Record<
  string,
  { before: boolean | number | string; after: boolean | number | string }
>;

export function configTelemetry(
  config: GlobalRiskConfig
): Record<string, boolean | number | string> {
  return {
    TRADING_ENABLED: config.TRADING_ENABLED,
    ORACLE_ENABLED: config.ORACLE_ENABLED,
    SENTIMENT_ENABLED: config.SENTIMENT_ENABLED,
    PROFILER_ENABLED: config.PROFILER_ENABLED,
    CROUPIER_ENABLED: config.CROUPIER_ENABLED,
    PIT_BOSS_ENABLED: config.PIT_BOSS_ENABLED,
    MARKET_MAKING_MODE: config.MARKET_MAKING_MODE,
    MAX_POSITION_SIZE: config.MAX_POSITION_SIZE,
    MAX_POSITION_PCT: config.MAX_POSITION_PCT,
    MAX_INVENTORY_UNITS: config.MAX_INVENTORY_UNITS,
    MAX_INVENTORY_DELTA: config.MAX_INVENTORY_DELTA,
    MAX_DRAWDOWN_PCT: config.MAX_DRAWDOWN_PCT,
    LATENCY_THRESHOLD_MS: config.LATENCY_THRESHOLD_MS,
    GOLDEN_COLOS: config.GOLDEN_COLOS,
    MIN_EV_THRESHOLD: config.MIN_EV_THRESHOLD,
    EXCHANGE_FEE_BPS: config.EXCHANGE_FEE_BPS,
    KELLY_FRACTION: config.KELLY_FRACTION,
    RISK_AVERSION_FACTOR: config.RISK_AVERSION_FACTOR,
    FUNDING_BIAS_THRESHOLD: config.FUNDING_BIAS_THRESHOLD,
    FUNDING_INVENTORY_BIAS: config.FUNDING_INVENTORY_BIAS,
    CASCADE_INSTRUMENTS: config.CASCADE_INSTRUMENTS,
    CASCADE_ASSET_PROFILES: config.CASCADE_ASSET_PROFILES,
    CASCADE_TAKER_ENABLED: config.CASCADE_TAKER_ENABLED,
    QUOTE_HIBERNATE_MS: config.QUOTE_HIBERNATE_MS,
    VAR_CONFIDENCE_Z: config.VAR_CONFIDENCE_Z,
    ORACLE_GOVERNANCE_MODE: config.ORACLE_GOVERNANCE_MODE,
    ORACLE_MANUAL_SKEPTICISM: config.ORACLE_MANUAL_SKEPTICISM,
    ORACLE_MAX_SKEPTICISM: config.ORACLE_MAX_SKEPTICISM,
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
    version: config.version
  };
}

export function diffConfig(before: GlobalRiskConfig, after: GlobalRiskConfig): ConfigDiff {
  const fields = [
    "TRADING_ENABLED",
    "STRATEGY_MODE",
    "ORACLE_ENABLED",
    "SENTIMENT_ENABLED",
    "PROFILER_ENABLED",
    "CROUPIER_ENABLED",
    "PIT_BOSS_ENABLED",
    "MARKET_MAKING_MODE",
    "MAX_POSITION_SIZE",
    "MAX_POSITION_PCT",
    "MAX_INVENTORY_UNITS",
    "MAX_INVENTORY_DELTA",
    "MAX_DRAWDOWN_PCT",
    "LATENCY_THRESHOLD_MS",
    "GOLDEN_COLOS",
    "MIN_EV_THRESHOLD",
    "EXCHANGE_FEE_BPS",
    "KELLY_FRACTION",
    "RISK_AVERSION_FACTOR",
    "FUNDING_BIAS_THRESHOLD",
    "FUNDING_INVENTORY_BIAS",
    "QUOTE_HIBERNATE_MS",
    "VAR_CONFIDENCE_Z",
    "ORACLE_GOVERNANCE_MODE",
    "ORACLE_MANUAL_SKEPTICISM",
    "ORACLE_MAX_SKEPTICISM",
    "HEDGE_ENABLED",
    "HEDGE_TRIGGER_INVENTORY_PCT",
    "HEDGE_COOLDOWN_MS",
    "HEDGE_MAX_SLIPPAGE_BPS",
    "CASCADE_TAKER_ENABLED",
    "CASCADE_INSTRUMENTS",
    "CASCADE_ASSET_PROFILES",
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
    "SENTIMENT_ALPHA_MODE",
    "TOXICITY_CLASSIFIER_ENABLED",
    "TOXICITY_CLASSIFIER_THRESHOLD",
    "FUNDING_PRE_SETTLEMENT_WINDOW_MS",
    "FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER",
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
    "AM_VPIN_QUOTE_HALT_MS",
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
    "TRAILING_STOP_TYPE",
    "TRAILING_STOP_PARAM",
    "RISK_PER_TRADE_PCT",
    "HEAT_CAP_PCT",
    "MAX_POSITION_NOTIONAL_PCT",
    "ASSET_LIQUIDITY_CAP_USD",
    "DAILY_LOSS_LIMIT_PCT",
    "WEEKLY_LOSS_LIMIT_PCT",
    "MAX_CONSECUTIVE_LOSSES"
  ] as const;
  const diff: ConfigDiff = {};

  for (const field of fields) {
    if (before[field] !== after[field]) {
      diff[field] = {
        before: before[field],
        after: after[field]
      };
    }
  }

  return diff;
}

export function hasRiskConfigMutation(update: AdminConfigUpdate): boolean {
  return Boolean(
    update.config ||
    update.TRADING_ENABLED !== undefined ||
    update.ORACLE_ENABLED !== undefined ||
    update.SENTIMENT_ENABLED !== undefined ||
    update.PROFILER_ENABLED !== undefined ||
    update.CROUPIER_ENABLED !== undefined ||
    update.PIT_BOSS_ENABLED !== undefined ||
    update.MARKET_MAKING_MODE !== undefined ||
    update.MAX_POSITION_SIZE !== undefined ||
    update.MAX_POSITION_PCT !== undefined ||
    update.MAX_INVENTORY_UNITS !== undefined ||
    update.MAX_INVENTORY_DELTA !== undefined ||
    update.MAX_DRAWDOWN_PCT !== undefined ||
    update.LATENCY_THRESHOLD_MS !== undefined ||
    update.GOLDEN_COLOS !== undefined ||
    update.MIN_EV_THRESHOLD !== undefined ||
    update.EXCHANGE_FEE_BPS !== undefined ||
    update.KELLY_FRACTION !== undefined ||
    update.RISK_AVERSION_FACTOR !== undefined ||
    update.FUNDING_BIAS_THRESHOLD !== undefined ||
    update.FUNDING_INVENTORY_BIAS !== undefined ||
    update.CASCADE_TAKER_ENABLED !== undefined ||
    update.CASCADE_INSTRUMENTS !== undefined ||
    update.CASCADE_ASSET_PROFILES !== undefined ||
    update.QUOTE_HIBERNATE_MS !== undefined ||
    update.VAR_CONFIDENCE_Z !== undefined ||
    update.ORACLE_GOVERNANCE_MODE !== undefined ||
    update.ORACLE_MANUAL_SKEPTICISM !== undefined ||
    update.ORACLE_MAX_SKEPTICISM !== undefined
  );
}

export function logSupervisorAction(
  logger: Logger,
  input: {
    actor: string;
    kind: "MACRO_BIAS" | "TEMPORARY_OVERRIDE";
    reason: string;
    confidence: number;
    payload: unknown;
    topology: EdgeTopology;
  }
): void {
  const observedAt = new Date().toISOString();
  const signalId = `supervisor:${input.kind.toLowerCase()}:${crypto.randomUUID()}`;

  logger.traceDecision({
    decisionId: `decision:${signalId}`,
    signalId,
    traceId: `moltworker:${input.kind.toLowerCase()}:${observedAt}`,
    agentName: "MOLTWORKER",
    targetAgent: "RISK",
    instrumentCode: "GLOBAL",
    action: "SUPERVISOR_ACTION",
    confidence: Math.min(1, Math.max(0, input.confidence)),
    reasoning: input.reason,
    featureVector: {
      supervisorAction: input.kind,
      actor: input.actor,
      payload: sanitizeSupervisorPayload(input.payload)
    },
    riskSnapshot: {
      colo: input.topology.colo,
      placement: input.topology.placement,
      requestId: input.topology.requestId
    },
    rawSignal: {
      supervisorAction: input.kind,
      actor: input.actor,
      source: "MOLTWORKER"
    },
    latencyMs: 0,
    createdAt: observedAt
  });
}

export async function recordCascadeConfigMetadata(
  env: Env,
  current: GlobalRiskConfig,
  next: GlobalRiskConfig,
  changedParameters: ConfigDiff
): Promise<void> {
  const observedAt = new Date().toISOString();

  if (current.STRATEGY_MODE !== "CASCADE_RECOVERY" && next.STRATEGY_MODE === "CASCADE_RECOVERY") {
    await env.CONFIG_STORE.put(CASCADE_PAPER_ARMED_AT_KEY, observedAt);
  } else if (next.STRATEGY_MODE === "OFF" || next.STRATEGY_MODE === "MARKET_MAKING") {
    await env.CONFIG_STORE.delete(CASCADE_PAPER_ARMED_AT_KEY);
  }

  if (Object.keys(changedParameters).some(isCascadeConfigKey)) {
    await env.CONFIG_STORE.put(CASCADE_LAST_CONFIG_CHANGE_AT_KEY, observedAt);
  }
}

export function requestsCascadeLivePromotion(
  current: GlobalRiskConfig,
  next: GlobalRiskConfig
): boolean {
  return (
    (current.STRATEGY_MODE !== "BOTH_LIVE" && next.STRATEGY_MODE === "BOTH_LIVE") ||
    (current.CASCADE_TAKER_ENABLED !== true && next.CASCADE_TAKER_ENABLED === true) ||
    (current.TRADING_ENABLED !== true &&
      next.TRADING_ENABLED === true &&
      next.STRATEGY_MODE === "CASCADE_RECOVERY")
  );
}

export function requiresHighImpactConfirmation(
  changedParameters: ConfigDiff,
  update: AdminConfigUpdate
): boolean {
  const highImpact = new Set([
    "TRADING_ENABLED",
    "STRATEGY_MODE",
    "ORACLE_ENABLED",
    "SENTIMENT_ENABLED",
    "PROFILER_ENABLED",
    "CROUPIER_ENABLED",
    "PIT_BOSS_ENABLED",
    "MARKET_MAKING_MODE",
    "MAX_POSITION_SIZE",
    "MAX_POSITION_PCT",
    "MAX_INVENTORY_DELTA",
    "MAX_DRAWDOWN_PCT",
    "KELLY_FRACTION",
    "MIN_EV_THRESHOLD",
    "LATENCY_THRESHOLD_MS",
    "GOLDEN_COLOS",
    "CASCADE_TAKER_ENABLED",
    "CASCADE_INSTRUMENTS",
    "CASCADE_ASSET_PROFILES",
    "RISK_PER_TRADE_PCT",
    "HEAT_CAP_PCT",
    "DAILY_LOSS_LIMIT_PCT",
    "WEEKLY_LOSS_LIMIT_PCT",
    "MAX_CONSECUTIVE_LOSSES"
  ]);
  const hasHighImpactChange = Object.keys(changedParameters).some((field) => highImpact.has(field));
  const updateRecord = update as Record<string, unknown>;
  const confirmed =
    updateRecord.confirmHighImpact === true ||
    updateRecord.confirm === true ||
    updateRecord.confirmation === "CONFIRM";

  return hasHighImpactChange && !confirmed;
}

function isCascadeConfigKey(key: string): boolean {
  return (
    key === "STRATEGY_MODE" ||
    key.startsWith("CASCADE_") ||
    key.startsWith("ABSORPTION_") ||
    key.startsWith("IMPULSIVE_") ||
    key.startsWith("PARTIAL_") ||
    key.startsWith("TRAILING_") ||
    key === "ENTRY_WINDOW_SECONDS" ||
    key === "STOP_BUFFER_ATR" ||
    key === "MIN_STOP_DISTANCE_BPS" ||
    key === "MAX_STOP_DISTANCE_BPS" ||
    key === "MIN_TIME_SINCE_LAST_CASCADE_SECONDS" ||
    key === "NEWS_BLACKOUT_MINUTES" ||
    key === "MAX_REALIZED_VOL_PERCENTILE" ||
    key === "RISK_PER_TRADE_PCT" ||
    key === "HEAT_CAP_PCT" ||
    key === "MAX_POSITION_NOTIONAL_PCT" ||
    key === "ASSET_LIQUIDITY_CAP_USD" ||
    key === "DAILY_LOSS_LIMIT_PCT" ||
    key === "WEEKLY_LOSS_LIMIT_PCT" ||
    key === "MAX_CONSECUTIVE_LOSSES" ||
    key === "MAX_SPREAD_BPS_FOR_TAKER" ||
    key === "MAX_SINGLE_ORDER_NOTIONAL_USD" ||
    key.startsWith("SLICE_") ||
    key === "MIN_FILL_RATIO"
  );
}

function sanitizeSupervisorPayload(payload: unknown): JsonRecord {
  return JSON.parse(JSON.stringify(payload)) as JsonRecord;
}
