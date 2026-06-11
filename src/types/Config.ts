import type {
  GovernanceMode,
  ISO8601,
  MarketMakingMode,
  NotificationPriority,
  SentimentAlphaMode,
  StrategyMode,
  TradeAlertMode
} from "./Core";

export interface GlobalRiskConfig {
  TRADING_ENABLED: boolean;
  STRATEGY_MODE: StrategyMode;
  ORACLE_ENABLED: boolean;
  SENTIMENT_ENABLED: boolean;
  PROFILER_ENABLED: boolean;
  CROUPIER_ENABLED: boolean;
  PIT_BOSS_ENABLED: boolean;
  MARKET_MAKING_MODE: MarketMakingMode;
  MAX_POSITION_SIZE: number;
  MAX_POSITION_PCT: number;
  MAX_INVENTORY_UNITS: number;
  MAX_INVENTORY_DELTA: number;
  MAX_DRAWDOWN_PCT: number;
  LATENCY_THRESHOLD_MS: number;
  GOLDEN_COLOS: string;
  MIN_EV_THRESHOLD: number;
  EXCHANGE_FEE_BPS: number;
  KELLY_FRACTION: number;
  RISK_AVERSION_FACTOR: number;
  FUNDING_BIAS_THRESHOLD: number;
  FUNDING_INVENTORY_BIAS: number;
  HEDGE_ENABLED: boolean;
  HEDGE_TRIGGER_INVENTORY_PCT: number;
  HEDGE_COOLDOWN_MS: number;
  HEDGE_MAX_SLIPPAGE_BPS: number;
  CASCADE_TAKER_ENABLED: boolean;
  CASCADE_INSTRUMENTS: string;
  CASCADE_ASSET_PROFILES: string;
  MAX_SPREAD_BPS_FOR_TAKER: number;
  MAX_SINGLE_ORDER_NOTIONAL_USD: number;
  SLICE_NOTIONAL_THRESHOLD_USD: number;
  SLICE_NOTIONAL_PER_CHUNK: number;
  SLICE_INTERVAL_MS: number;
  SLICE_JITTER_MS: number;
  MIN_FILL_RATIO: number;
  LAYERED_QUOTE_LEVELS: number;
  LAYERED_QUOTE_SIZE_DECAY: number;
  LAYERED_QUOTE_SPREAD_STEP_BPS: number;
  CVAR_CONFIDENCE: number;
  CVAR_MAX_TAIL_LOSS_BPS: number;
  CVAR_LOOKBACK_TRADES: number;
  SENTIMENT_ALPHA_MODE: SentimentAlphaMode;
  TOXICITY_CLASSIFIER_ENABLED: boolean;
  TOXICITY_CLASSIFIER_THRESHOLD: number;
  FUNDING_PRE_SETTLEMENT_WINDOW_MS: number;
  FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER: number;
  QUOTE_HIBERNATE_MS: number;
  VAR_CONFIDENCE_Z: number;
  ORACLE_GOVERNANCE_MODE: GovernanceMode;
  ORACLE_MANUAL_SKEPTICISM: number;
  ORACLE_MAX_SKEPTICISM: number;
  AM_VPIN_BUCKET_VOLUME: number;
  AM_VPIN_ROLLING_WINDOW: number;
  AM_VPIN_DIRECTIONAL_DECAY: number;
  AM_VPIN_NORMAL_THRESHOLD: number;
  AM_VPIN_TOXIC_THRESHOLD: number;
  AM_VPIN_CRITICAL_THRESHOLD: number;
  AM_VPIN_OBI_DEPTH: number;
  AM_VPIN_CRITICAL_OBI: number;
  AM_VPIN_CONTESTED_SPREAD_MULTIPLIER: number;
  AM_VPIN_TOXIC_SPREAD_MULTIPLIER: number;
  AM_VPIN_QUOTE_HALT_MS: number;
  CASCADE_WINDOW_MS: number;
  CASCADE_NOTIONAL_THRESHOLD_USD: number;
  CASCADE_ZSCORE_THRESHOLD: number;
  CASCADE_LOOKBACK_HOURS: number;
  CASCADE_DIRECTIONAL_PCT: number;
  CASCADE_MIN_PRICE_MOVE_ATR: number;
  ABSORPTION_WINDOW_MS: number;
  ABSORPTION_PRICE_BAND_BPS: number;
  ABSORPTION_MIN_HOLD_SECONDS: number;
  ENTRY_WINDOW_SECONDS: number;
  IMPULSIVE_BAR_BODY_ATR: number;
  IMPULSIVE_BAR_VOLUME_MULT: number;
  STOP_BUFFER_ATR: number;
  MIN_STOP_DISTANCE_BPS: number;
  MAX_STOP_DISTANCE_BPS: number;
  MIN_TIME_SINCE_LAST_CASCADE_SECONDS: number;
  NEWS_BLACKOUT_MINUTES: number;
  MAX_REALIZED_VOL_PERCENTILE: number;
  CASCADE_TIME_STOP_HOURS: number;
  PARTIAL_1_R: number;
  PARTIAL_1_SIZE_PCT: number;
  PARTIAL_2_R: number;
  PARTIAL_2_SIZE_PCT: number;
  TRAILING_STOP_TYPE: "ATR" | "EMA";
  TRAILING_STOP_PARAM: number;
  RISK_PER_TRADE_PCT: number;
  HEAT_CAP_PCT: number;
  MAX_POSITION_NOTIONAL_PCT: number;
  ASSET_LIQUIDITY_CAP_USD: number;
  DAILY_LOSS_LIMIT_PCT: number;
  WEEKLY_LOSS_LIMIT_PCT: number;
  MAX_CONSECUTIVE_LOSSES: number;
  updatedAt: ISO8601;
  updatedBy: string;
  version: string;
}

export interface NotificationSettings {
  schemaVersion: "notification-settings.v1";
  enabled: boolean;
  minPriority: NotificationPriority;
  debounceMs: number;
  textFrequencyMs: number;
  heartbeatDigestMinutes: number;
  tradeAlertMode: TradeAlertMode;
  telegramEnabled: boolean;
  discordEnabled: boolean;
  genericWebhookEnabled: boolean;
  quietHoursEnabled: boolean;
  quietHoursStartUtc: string;
  quietHoursEndUtc: string;
  updatedAt: ISO8601;
  updatedBy: string;
  version: string;
}

export type NotificationSettingsUpdate = Partial<
  Pick<
    NotificationSettings,
    | "enabled"
    | "minPriority"
    | "debounceMs"
    | "textFrequencyMs"
    | "heartbeatDigestMinutes"
    | "tradeAlertMode"
    | "telegramEnabled"
    | "discordEnabled"
    | "genericWebhookEnabled"
    | "quietHoursEnabled"
    | "quietHoursStartUtc"
    | "quietHoursEndUtc"
  >
>;

export type MacroBiasDirection = "BULLISH" | "BEARISH" | "RISK_ON" | "RISK_OFF" | "NEUTRAL";
export type SupervisorSource = "MOLTWORKER" | "ADMIN" | "SYSTEM";

export interface MacroBias {
  schemaVersion: "macro-bias.v1";
  direction: MacroBiasDirection;
  intensity: number;
  confidence: number;
  instruments: string[];
  reason: string;
  source: SupervisorSource;
  createdBy: string;
  createdAt: ISO8601;
  expiresAt: ISO8601 | null;
}

export interface MacroBiasUpdate {
  direction?: MacroBiasDirection;
  intensity?: number;
  confidence?: number;
  instruments?: string[];
  reason?: string;
  source?: SupervisorSource;
  expiresAt?: ISO8601 | null;
  durationMs?: number;
  durationMinutes?: number;
}

export interface TemporaryGovernanceOverride {
  schemaVersion: "governor.override.v1";
  overrideId: string;
  source: SupervisorSource;
  createdBy: string;
  reason: string;
  createdAt: ISO8601;
  expiresAt: ISO8601;
  durationMs: number;
  configPatch: Partial<
    Pick<
      GlobalRiskConfig,
      | "TRADING_ENABLED"
      | "MIN_EV_THRESHOLD"
      | "LATENCY_THRESHOLD_MS"
      | "ORACLE_MANUAL_SKEPTICISM"
      | "ORACLE_MAX_SKEPTICISM"
      | "ORACLE_GOVERNANCE_MODE"
    >
  >;
}

export interface TemporaryGovernanceOverrideUpdate {
  source?: SupervisorSource;
  reason?: string;
  durationMs?: number;
  durationMinutes?: number;
  expiresAt?: ISO8601;
  configPatch?: TemporaryGovernanceOverride["configPatch"];
  TRADING_ENABLED?: boolean;
  MIN_EV_THRESHOLD?: number;
  LATENCY_THRESHOLD_MS?: number;
  ORACLE_MANUAL_SKEPTICISM?: number;
  ORACLE_MAX_SKEPTICISM?: number;
  ORACLE_GOVERNANCE_MODE?: GovernanceMode;
}

export type GlobalRiskConfigUpdate = Partial<
  Pick<
    GlobalRiskConfig,
    | "TRADING_ENABLED"
    | "STRATEGY_MODE"
    | "ORACLE_ENABLED"
    | "SENTIMENT_ENABLED"
    | "PROFILER_ENABLED"
    | "CROUPIER_ENABLED"
    | "PIT_BOSS_ENABLED"
    | "MARKET_MAKING_MODE"
    | "MAX_POSITION_SIZE"
    | "MAX_POSITION_PCT"
    | "MAX_INVENTORY_UNITS"
    | "MAX_INVENTORY_DELTA"
    | "MAX_DRAWDOWN_PCT"
    | "LATENCY_THRESHOLD_MS"
    | "GOLDEN_COLOS"
    | "MIN_EV_THRESHOLD"
    | "EXCHANGE_FEE_BPS"
    | "KELLY_FRACTION"
    | "RISK_AVERSION_FACTOR"
    | "FUNDING_BIAS_THRESHOLD"
    | "FUNDING_INVENTORY_BIAS"
    | "HEDGE_ENABLED"
    | "HEDGE_TRIGGER_INVENTORY_PCT"
    | "HEDGE_COOLDOWN_MS"
    | "HEDGE_MAX_SLIPPAGE_BPS"
    | "CASCADE_TAKER_ENABLED"
    | "CASCADE_INSTRUMENTS"
    | "CASCADE_ASSET_PROFILES"
    | "MAX_SPREAD_BPS_FOR_TAKER"
    | "MAX_SINGLE_ORDER_NOTIONAL_USD"
    | "SLICE_NOTIONAL_THRESHOLD_USD"
    | "SLICE_NOTIONAL_PER_CHUNK"
    | "SLICE_INTERVAL_MS"
    | "SLICE_JITTER_MS"
    | "MIN_FILL_RATIO"
    | "LAYERED_QUOTE_LEVELS"
    | "LAYERED_QUOTE_SIZE_DECAY"
    | "LAYERED_QUOTE_SPREAD_STEP_BPS"
    | "CVAR_CONFIDENCE"
    | "CVAR_MAX_TAIL_LOSS_BPS"
    | "CVAR_LOOKBACK_TRADES"
    | "SENTIMENT_ALPHA_MODE"
    | "TOXICITY_CLASSIFIER_ENABLED"
    | "TOXICITY_CLASSIFIER_THRESHOLD"
    | "FUNDING_PRE_SETTLEMENT_WINDOW_MS"
    | "FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER"
    | "QUOTE_HIBERNATE_MS"
    | "VAR_CONFIDENCE_Z"
    | "ORACLE_GOVERNANCE_MODE"
    | "ORACLE_MANUAL_SKEPTICISM"
    | "ORACLE_MAX_SKEPTICISM"
    | "AM_VPIN_BUCKET_VOLUME"
    | "AM_VPIN_ROLLING_WINDOW"
    | "AM_VPIN_DIRECTIONAL_DECAY"
    | "AM_VPIN_NORMAL_THRESHOLD"
    | "AM_VPIN_TOXIC_THRESHOLD"
    | "AM_VPIN_CRITICAL_THRESHOLD"
    | "AM_VPIN_OBI_DEPTH"
    | "AM_VPIN_CRITICAL_OBI"
    | "AM_VPIN_CONTESTED_SPREAD_MULTIPLIER"
    | "AM_VPIN_TOXIC_SPREAD_MULTIPLIER"
    | "AM_VPIN_QUOTE_HALT_MS"
    | "CASCADE_WINDOW_MS"
    | "CASCADE_NOTIONAL_THRESHOLD_USD"
    | "CASCADE_ZSCORE_THRESHOLD"
    | "CASCADE_LOOKBACK_HOURS"
    | "CASCADE_DIRECTIONAL_PCT"
    | "CASCADE_MIN_PRICE_MOVE_ATR"
    | "ABSORPTION_WINDOW_MS"
    | "ABSORPTION_PRICE_BAND_BPS"
    | "ABSORPTION_MIN_HOLD_SECONDS"
    | "ENTRY_WINDOW_SECONDS"
    | "IMPULSIVE_BAR_BODY_ATR"
    | "IMPULSIVE_BAR_VOLUME_MULT"
    | "STOP_BUFFER_ATR"
    | "MIN_STOP_DISTANCE_BPS"
    | "MAX_STOP_DISTANCE_BPS"
    | "MIN_TIME_SINCE_LAST_CASCADE_SECONDS"
    | "NEWS_BLACKOUT_MINUTES"
    | "MAX_REALIZED_VOL_PERCENTILE"
    | "CASCADE_TIME_STOP_HOURS"
    | "PARTIAL_1_R"
    | "PARTIAL_1_SIZE_PCT"
    | "PARTIAL_2_R"
    | "PARTIAL_2_SIZE_PCT"
    | "TRAILING_STOP_TYPE"
    | "TRAILING_STOP_PARAM"
    | "RISK_PER_TRADE_PCT"
    | "HEAT_CAP_PCT"
    | "MAX_POSITION_NOTIONAL_PCT"
    | "ASSET_LIQUIDITY_CAP_USD"
    | "DAILY_LOSS_LIMIT_PCT"
    | "WEEKLY_LOSS_LIMIT_PCT"
    | "MAX_CONSECUTIVE_LOSSES"
  >
>;
