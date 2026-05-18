import type { DraftTransportSettings, GlobalRiskConfig } from "./types";

export type ParameterKind = "boolean" | "number" | "select";
export type ParameterGroup =
  | "Strategy"
  | "Oracle"
  | "Profiler"
  | "Croupier"
  | "Pit Boss"
  | "System";

export interface ParameterDescriptor {
  key: keyof GlobalRiskConfig;
  label: string;
  group: ParameterGroup;
  kind: ParameterKind;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  help?: string;
}

export const STRATEGY_KNOBS: ParameterDescriptor[] = [
  {
    key: "STRATEGY_MODE",
    label: "Strategy Mode",
    group: "Strategy",
    kind: "select",
    options: ["OFF", "MARKET_MAKING", "CASCADE_RECOVERY", "BOTH_SHADOW", "BOTH_LIVE"],
    help: "Fail-closed strategy router. Cascade recovery remains off unless explicitly selected; BOTH_LIVE requires later live-readiness gates before taker execution can be enabled."
  },
  {
    key: "MARKET_MAKING_MODE",
    label: "Market-Making Mode",
    group: "Strategy",
    kind: "select",
    options: ["OFF", "PASSIVE", "BALANCED", "AGGRESSIVE", "INVENTORY_SKEW_ONLY"],
    help: "Top-level quote posture. OFF pulls quoting, PASSIVE widens, BALANCED is normal, AGGRESSIVE tightens cautiously, and INVENTORY_SKEW_ONLY only quotes the side that reduces inventory."
  },
  {
    key: "CASCADE_WINDOW_MS",
    label: "Cascade Window",
    group: "Strategy",
    kind: "number",
    min: 60000,
    max: 3600000,
    step: 60000,
    help: "Rolling liquidation concentration window. Cascades only trigger when notional, z-score, direction, and ATR price-impact gates all pass inside this window."
  },
  {
    key: "CASCADE_NOTIONAL_THRESHOLD_USD",
    label: "Cascade Notional",
    group: "Strategy",
    kind: "number",
    min: 100000,
    max: 100000000,
    step: 100000,
    help: "Minimum forced-liquidation notional required before the cascade detector can emit a structured cascade event."
  },
  {
    key: "CASCADE_ZSCORE_THRESHOLD",
    label: "Cascade Z",
    group: "Strategy",
    kind: "number",
    min: 0,
    max: 20,
    step: 0.1,
    help: "Required standard-deviation shock versus the historical liquidation baseline, excluding the current detection window."
  },
  {
    key: "CASCADE_LOOKBACK_HOURS",
    label: "Cascade Lookback",
    group: "Strategy",
    kind: "number",
    min: 1,
    max: 168,
    step: 1,
    help: "Historical liquidation baseline lookback used for z-score normalization."
  },
  {
    key: "CASCADE_DIRECTIONAL_PCT",
    label: "Cascade Direction %",
    group: "Strategy",
    kind: "number",
    min: 0.5,
    max: 1,
    step: 0.01,
    help: "Minimum share of liquidation notional that must be concentrated in one side before the flow is treated as directional forced selling or buying."
  },
  {
    key: "CASCADE_MIN_PRICE_MOVE_ATR",
    label: "Cascade ATR Move",
    group: "Strategy",
    kind: "number",
    min: 0,
    max: 10,
    step: 0.1,
    help: "Minimum cascade price displacement, measured in ATR units, required before recovery logic arms."
  },
  {
    key: "ABSORPTION_WINDOW_MS",
    label: "Absorption Window",
    group: "Strategy",
    kind: "number",
    min: 60000,
    max: 21600000,
    step: 60000,
    help: "Time after a detected cascade during which the engine looks for taker exhaustion, CVD reversal, OI stabilization, and price hold behavior."
  },
  {
    key: "ABSORPTION_PRICE_BAND_BPS",
    label: "Absorption Band",
    group: "Strategy",
    kind: "number",
    min: 1,
    max: 500,
    step: 1,
    help: "Maximum price drift, in basis points, allowed while testing whether forced flow is being absorbed."
  },
  {
    key: "ABSORPTION_MIN_HOLD_SECONDS",
    label: "Absorption Hold",
    group: "Strategy",
    kind: "number",
    min: 5,
    max: 3600,
    step: 5,
    help: "Minimum time price must hold after a cascade before the system treats absorption as confirmed."
  },
  {
    key: "ENTRY_WINDOW_SECONDS",
    label: "Entry Window",
    group: "Strategy",
    kind: "number",
    min: 60,
    max: 21600,
    step: 60,
    help: "Maximum time after absorption confirmation during which a reclaim candle can emit a cascade-recovery signal."
  },
  {
    key: "MIN_TIME_SINCE_LAST_CASCADE_SECONDS",
    label: "Re-Cascade Cooldown",
    group: "Strategy",
    kind: "number",
    min: 0,
    max: 86400,
    step: 60,
    help: "Minimum time since a second cascade on the same instrument before new recovery entries are allowed."
  },
  {
    key: "IMPULSIVE_BAR_BODY_ATR",
    label: "Impulse Body ATR",
    group: "Strategy",
    kind: "number",
    min: 0.1,
    max: 10,
    step: 0.1,
    help: "Minimum 1m candle body size in ATR units for the impulsive-bar reclaim trigger."
  },
  {
    key: "IMPULSIVE_BAR_VOLUME_MULT",
    label: "Impulse Volume",
    group: "Strategy",
    kind: "number",
    min: 0.1,
    max: 20,
    step: 0.1,
    help: "Required volume multiple versus the prior 20 closed 1m candles for an impulsive recovery bar."
  },
  {
    key: "STOP_BUFFER_ATR",
    label: "Stop Buffer ATR",
    group: "Strategy",
    kind: "number",
    min: 0,
    max: 5,
    step: 0.05,
    help: "ATR buffer placed beyond the cascade wick before calculating R-distance."
  },
  {
    key: "MIN_STOP_DISTANCE_BPS",
    label: "Min Stop BPS",
    group: "Strategy",
    kind: "number",
    min: 1,
    max: 2000,
    step: 1,
    help: "Minimum stop distance from entry, preventing meaningless R values that would be clipped by noise."
  },
  {
    key: "MAX_STOP_DISTANCE_BPS",
    label: "Max Stop BPS",
    group: "Strategy",
    kind: "number",
    min: 1,
    max: 5000,
    step: 1,
    help: "Maximum stop distance from entry, bounding risk per cascade-recovery trade."
  },
  {
    key: "PARTIAL_1_R",
    label: "Partial 1 R",
    group: "Strategy",
    kind: "number",
    min: 0.25,
    max: 20,
    step: 0.25,
    help: "First profit-taking target expressed as R multiple from entry."
  },
  {
    key: "PARTIAL_1_SIZE_PCT",
    label: "Partial 1 Size %",
    group: "Strategy",
    kind: "number",
    min: 0,
    max: 100,
    step: 1,
    help: "Percent of initial cascade position closed at the first R target."
  },
  {
    key: "PARTIAL_2_R",
    label: "Partial 2 R",
    group: "Strategy",
    kind: "number",
    min: 0.25,
    max: 30,
    step: 0.25,
    help: "Second profit-taking target expressed as R multiple from entry."
  },
  {
    key: "PARTIAL_2_SIZE_PCT",
    label: "Partial 2 Size %",
    group: "Strategy",
    kind: "number",
    min: 0,
    max: 100,
    step: 1,
    help: "Percent of initial cascade position closed at the second R target."
  },
  {
    key: "TRAILING_STOP_TYPE",
    label: "Trailing Stop",
    group: "Strategy",
    kind: "select",
    options: ["ATR", "EMA"],
    help: "Runner stop engine after partial exits. ATR tracks volatility distance; EMA trails trend structure."
  },
  {
    key: "TRAILING_STOP_PARAM",
    label: "Trailing Param",
    group: "Strategy",
    kind: "number",
    min: 0.1,
    max: 20,
    step: 0.1,
    help: "ATR multiplier or EMA period used by the cascade runner trailing stop."
  },
  {
    key: "CASCADE_TIME_STOP_HOURS",
    label: "Time Stop Hours",
    group: "Strategy",
    kind: "number",
    min: 0.25,
    max: 72,
    step: 0.25,
    help: "Maximum holding period for a cascade recovery that fails to reach at least 1R."
  },
  {
    key: "NEWS_BLACKOUT_MINUTES",
    label: "News Blackout",
    group: "Strategy",
    kind: "number",
    min: 0,
    max: 1440,
    step: 5,
    help: "Minutes around scheduled high-impact events during which cascade entries are blocked."
  },
  {
    key: "MAX_REALIZED_VOL_PERCENTILE",
    label: "Max Vol Percentile",
    group: "Strategy",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    help: "Upper realized-volatility percentile allowed for entries; high values block chaotic regimes."
  },
  {
    key: "ORACLE_ENABLED",
    label: "Oracle Agent",
    group: "Strategy",
    kind: "boolean",
    help: "Enables the regime and posterior-price agent. When disabled, the engine reuses the last Oracle state and marks the agent disabled."
  },
  {
    key: "SENTIMENT_ENABLED",
    label: "Sentiment Agent",
    group: "Strategy",
    kind: "boolean",
    help: "Allows Workers AI or lexical sentiment to influence ensemble confidence. Disabled mode blocks new sentiment calls and uses a neutral bias."
  },
  {
    key: "SENTIMENT_ALPHA_MODE",
    label: "Sentiment Mode",
    group: "Strategy",
    kind: "select",
    options: ["OFF", "EVENT_RISK_ONLY", "CONTINUOUS"],
    help: "Controls whether sentiment is disabled, restricted to event-risk halts, or allowed to continuously shape EV. Event-risk only is the production default for market-making latency."
  },
  {
    key: "PROFILER_ENABLED",
    label: "Profiler Agent",
    group: "Strategy",
    kind: "boolean",
    help: "Enables AM-VPIN, spoofing, whale-print, and cascade toxicity checks. Disabling removes defensive toxicity signals, so keep this on for production paper/live trading."
  },
  {
    key: "CROUPIER_ENABLED",
    label: "Croupier Agent",
    group: "Strategy",
    kind: "boolean",
    help: "Enables EV calculation and quote construction. Disabled mode keeps market data live but produces no new quotes or trade intents."
  },
  {
    key: "PIT_BOSS_ENABLED",
    label: "Pit Boss Agent",
    group: "Strategy",
    kind: "boolean",
    help: "Enables Kelly sizing and final risk approval. Disabled mode is fail-closed: quote/intent telemetry may be computed, but executable dispatch is blocked."
  },
  {
    key: "HEDGE_ENABLED",
    label: "IOC Hedge Path",
    group: "Strategy",
    kind: "boolean",
    help: "Enables the separate reduce-only IOC limit hedge path when inventory exceeds the hedge trigger. It never enables market orders."
  },
  {
    key: "CASCADE_TAKER_ENABLED",
    label: "Cascade Taker Path",
    group: "Strategy",
    kind: "boolean",
    help: "Separate fail-closed switch for cascade-recovery IOC/stop execution. Market-making quotes remain post-only."
  }
];

export const PARAMETER_MATRIX: ParameterDescriptor[] = [
  {
    key: "ORACLE_GOVERNANCE_MODE",
    label: "Governance",
    group: "Oracle",
    kind: "select",
    options: ["MANUAL", "AUTONOMOUS", "HYBRID"],
    help: "Controls whether System 2 governance, manual operator input, or a hybrid policy controls Oracle skepticism."
  },
  {
    key: "ORACLE_MANUAL_SKEPTICISM",
    label: "κ Manual",
    group: "Oracle",
    kind: "number",
    min: 1,
    max: 10,
    step: 0.05,
    help: "Manual skepticism multiplier applied to probability updates when governance is in manual or hybrid intervention."
  },
  {
    key: "ORACLE_MAX_SKEPTICISM",
    label: "κ Ceiling",
    group: "Oracle",
    kind: "number",
    min: 1,
    max: 10,
    step: 0.05,
    help: "Upper bound on the Oracle skepticism multiplier during regime stress or manual overrides."
  },
  {
    key: "VAR_CONFIDENCE_Z",
    label: "VaR Z",
    group: "Oracle",
    kind: "number",
    min: 1,
    max: 4,
    step: 0.001,
    help: "Z-score used by the Pit Boss risk model for one-hour value-at-risk estimation."
  },
  {
    key: "MIN_EV_THRESHOLD",
    label: "Min EV",
    group: "Croupier",
    kind: "number",
    min: -1000,
    max: 1000,
    step: 0.0001
  },
  {
    key: "EXCHANGE_FEE_BPS",
    label: "Fee BPS",
    group: "Croupier",
    kind: "number",
    min: 0,
    max: 100,
    step: 0.01
  },
  {
    key: "RISK_AVERSION_FACTOR",
    label: "Risk Aversion (γ)",
    group: "Croupier",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.0001,
    help: "Avellaneda-Stoikov coefficient determining how aggressively the bot skews its quotes away from its reservation price to defend its delta inventory."
  },
  {
    key: "FUNDING_BIAS_THRESHOLD",
    label: "Funding Bias Trigger",
    group: "Croupier",
    kind: "number",
    min: 0,
    max: 0.01,
    step: 0.000001
  },
  {
    key: "FUNDING_INVENTORY_BIAS",
    label: "Funding Target Δ",
    group: "Croupier",
    kind: "number",
    min: 0,
    max: 100,
    step: 0.0001
  },
  {
    key: "FUNDING_PRE_SETTLEMENT_WINDOW_MS",
    label: "Funding Window",
    group: "Croupier",
    kind: "number",
    min: 0,
    max: 3600000,
    step: 60000,
    help: "Milliseconds before the hourly Hyperliquid funding event where inventory bias can be amplified to collect favorable funding while staying risk-capped."
  },
  {
    key: "FUNDING_PRE_SETTLEMENT_BIAS_MULTIPLIER",
    label: "Funding Bias ×",
    group: "Croupier",
    kind: "number",
    min: 1,
    max: 10,
    step: 0.1,
    help: "Multiplier applied to the funding-aligned inventory target during the pre-settlement funding window."
  },
  {
    key: "LAYERED_QUOTE_LEVELS",
    label: "Quote Layers",
    group: "Croupier",
    kind: "number",
    min: 1,
    max: 5,
    step: 1,
    help: "Number of post-only quote levels per side. Layering captures sweeps and reduces queue churn compared with a single top-level quote."
  },
  {
    key: "LAYERED_QUOTE_SIZE_DECAY",
    label: "Layer Size Decay",
    group: "Croupier",
    kind: "number",
    min: 0.1,
    max: 1,
    step: 0.05,
    help: "Per-level size decay for layered quotes. Lower values place smaller size farther from the touch."
  },
  {
    key: "LAYERED_QUOTE_SPREAD_STEP_BPS",
    label: "Layer Step BPS",
    group: "Croupier",
    kind: "number",
    min: 0,
    max: 25,
    step: 0.1,
    help: "Additional distance, in basis points, between each quote layer."
  },
  {
    key: "QUOTE_HIBERNATE_MS",
    label: "Quote Hibernate",
    group: "Profiler",
    kind: "number",
    min: 100,
    max: 60000,
    step: 100
  },
  {
    key: "AM_VPIN_BUCKET_VOLUME",
    label: "AM-VPIN Bucket",
    group: "Profiler",
    kind: "number",
    min: 0.001,
    max: 10000,
    step: 0.001
  },
  {
    key: "AM_VPIN_ROLLING_WINDOW",
    label: "AM-VPIN Window (N)",
    group: "Profiler",
    kind: "number",
    min: 5,
    max: 500,
    step: 1,
    help: "The number of rolling volume buckets analyzed to calculate order flow toxicity. Higher values smooth out noise; lower values react faster."
  },
  {
    key: "AM_VPIN_DIRECTIONAL_DECAY",
    label: "Directional Decay (α)",
    group: "Profiler",
    kind: "number",
    min: 0,
    max: 0.999,
    step: 0.001,
    help: "The exponential memory factor applied to net-volume imbalances. Dampens false alarms from back-and-forth choppy execution."
  },
  {
    key: "AM_VPIN_NORMAL_THRESHOLD",
    label: "Normal Ceiling",
    group: "Profiler",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.001
  },
  {
    key: "AM_VPIN_TOXIC_THRESHOLD",
    label: "Toxic Trigger",
    group: "Profiler",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.001
  },
  {
    key: "AM_VPIN_CRITICAL_THRESHOLD",
    label: "Critical Trigger",
    group: "Profiler",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.001
  },
  {
    key: "AM_VPIN_OBI_DEPTH",
    label: "OBI Level Depth (M)",
    group: "Profiler",
    kind: "number",
    min: 1,
    max: 50,
    step: 1,
    help: "The depth level of the L2 order book delta tracked to verify liquidity resilience against aggressive market trades."
  },
  {
    key: "AM_VPIN_CRITICAL_OBI",
    label: "Critical OBI",
    group: "Profiler",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.001
  },
  {
    key: "AM_VPIN_CONTESTED_SPREAD_MULTIPLIER",
    label: "Contested Width",
    group: "Profiler",
    kind: "number",
    min: 1,
    max: 10,
    step: 0.05,
    help: "Spread multiplier applied when AM-VPIN is elevated but L2 liquidity is absorbing the flow. Keeps quotes live while charging more for adverse selection."
  },
  {
    key: "AM_VPIN_TOXIC_SPREAD_MULTIPLIER",
    label: "Toxic Width",
    group: "Profiler",
    kind: "number",
    min: 1,
    max: 10,
    step: 0.05,
    help: "Spread multiplier applied when AM-VPIN and OBI agree that flow is toxic. Raises the price of liquidity before the critical quote-halt threshold."
  },
  {
    key: "AM_VPIN_QUOTE_HALT_MS",
    label: "Critical Halt",
    group: "Profiler",
    kind: "number",
    min: 1000,
    max: 300000,
    step: 1000
  },
  {
    key: "TOXICITY_CLASSIFIER_ENABLED",
    label: "Classifier Gate",
    group: "Profiler",
    kind: "boolean",
    help: "Enables the lightweight learned-toxicity runtime overlay that combines AM-VPIN, OBI, spread stress, and jump state before escalating quote protection."
  },
  {
    key: "TOXICITY_CLASSIFIER_THRESHOLD",
    label: "Classifier Trigger",
    group: "Profiler",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    help: "Probability threshold for the learned-toxicity overlay. Higher values reduce false positives; lower values evacuate sooner."
  },
  {
    key: "KELLY_FRACTION",
    label: "Kelly Fraction",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01
  },
  {
    key: "RISK_PER_TRADE_PCT",
    label: "Cascade Risk %",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 0.05,
    step: 0.0005,
    help: "Maximum equity risk allocated to a single cascade-recovery position before notional, liquidity, and heat caps are applied."
  },
  {
    key: "HEAT_CAP_PCT",
    label: "Portfolio Heat Cap",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 0.25,
    step: 0.001,
    help: "Maximum correlated open R-risk allowed across cascade-recovery positions. Same-direction BTC/ETH/SOL exposure is correlation-adjusted before new entries are approved."
  },
  {
    key: "MAX_POSITION_NOTIONAL_PCT",
    label: "Cascade Notional %",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.001,
    help: "Per-position notional cap as a fraction of account equity for cascade-recovery entries."
  },
  {
    key: "ASSET_LIQUIDITY_CAP_USD",
    label: "Liquidity Cap USD",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 10000000,
    step: 100,
    help: "Absolute per-asset notional ceiling used to avoid oversizing into thin recovery liquidity."
  },
  {
    key: "DAILY_LOSS_LIMIT_PCT",
    label: "Daily Loss Limit",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.001,
    help: "UTC-day realized loss threshold that blocks new cascade-recovery entries until the next midnight reset."
  },
  {
    key: "WEEKLY_LOSS_LIMIT_PCT",
    label: "Weekly Loss Limit",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.001,
    help: "Monday-UTC weekly realized loss threshold that blocks new cascade-recovery entries until the next weekly reset."
  },
  {
    key: "MAX_CONSECUTIVE_LOSSES",
    label: "Loss Streak Halt",
    group: "Pit Boss",
    kind: "number",
    min: 1,
    max: 100,
    step: 1,
    help: "Consecutive realized losing trades that require manual review before cascade-recovery entries resume."
  },
  {
    key: "CVAR_CONFIDENCE",
    label: "CVaR Confidence",
    group: "Pit Boss",
    kind: "number",
    min: 0.9,
    max: 0.999,
    step: 0.001,
    help: "Tail-loss confidence used to cap Kelly sizing from empirical execution shortfall instead of relying on average fill behavior."
  },
  {
    key: "CVAR_MAX_TAIL_LOSS_BPS",
    label: "CVaR Tail BPS",
    group: "Pit Boss",
    kind: "number",
    min: 1,
    max: 1000,
    step: 1,
    help: "Maximum tolerated tail execution loss in basis points before the Pit Boss scales down approved size."
  },
  {
    key: "CVAR_LOOKBACK_TRADES",
    label: "CVaR Lookback",
    group: "Pit Boss",
    kind: "number",
    min: 25,
    max: 5000,
    step: 25,
    help: "Number of recent execution-quality samples used for CVaR sizing."
  },
  {
    key: "HEDGE_TRIGGER_INVENTORY_PCT",
    label: "Hedge Trigger %",
    group: "Pit Boss",
    kind: "number",
    min: 0.1,
    max: 1,
    step: 0.01,
    help: "Fraction of max inventory delta that activates the reduce-only IOC hedge path."
  },
  {
    key: "HEDGE_COOLDOWN_MS",
    label: "Hedge Cooldown",
    group: "Pit Boss",
    kind: "number",
    min: 1000,
    max: 300000,
    step: 1000,
    help: "Minimum time between inventory hedge attempts per instrument."
  },
  {
    key: "HEDGE_MAX_SLIPPAGE_BPS",
    label: "Hedge Slip BPS",
    group: "Pit Boss",
    kind: "number",
    min: 0.1,
    max: 100,
    step: 0.1,
    help: "IOC limit slippage guard for inventory hedges. The hedge still uses a limit price and cannot become a market order."
  },
  {
    key: "MAX_SPREAD_BPS_FOR_TAKER",
    label: "Taker Max Spread",
    group: "Pit Boss",
    kind: "number",
    min: 0.1,
    max: 500,
    step: 0.1,
    help: "Maximum BBO spread allowed before cascade IOC entries defer instead of crossing impaired liquidity."
  },
  {
    key: "MAX_SINGLE_ORDER_NOTIONAL_USD",
    label: "Max Taker Notional",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 10000000,
    step: 100,
    help: "Absolute notional cap for any single cascade taker child order."
  },
  {
    key: "SLICE_NOTIONAL_THRESHOLD_USD",
    label: "TWAP Threshold",
    group: "Pit Boss",
    kind: "number",
    min: 1,
    max: 10000000,
    step: 100,
    help: "Cascade entry notional above which the executioner decomposes the order into IOC slices."
  },
  {
    key: "SLICE_NOTIONAL_PER_CHUNK",
    label: "TWAP Chunk",
    group: "Pit Boss",
    kind: "number",
    min: 1,
    max: 1000000,
    step: 100,
    help: "Target notional per IOC child order in sliced cascade entries."
  },
  {
    key: "SLICE_INTERVAL_MS",
    label: "TWAP Interval",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 60000,
    step: 50,
    help: "Base delay between sliced cascade IOC chunks."
  },
  {
    key: "SLICE_JITTER_MS",
    label: "TWAP Jitter",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 60000,
    step: 50,
    help: "Randomized delay envelope around the TWAP interval to avoid predictable slicing."
  },
  {
    key: "MIN_FILL_RATIO",
    label: "Min Slice Fill",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    help: "Minimum fill ratio per TWAP child before the executioner pauses remaining slices for signal revalidation."
  },
  {
    key: "MAX_POSITION_SIZE",
    label: "Max Position",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 100000000,
    step: 0.0001
  },
  {
    key: "MAX_POSITION_PCT",
    label: "Max Position %",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.001
  },
  {
    key: "MAX_INVENTORY_UNITS",
    label: "Max Inventory",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 1000000,
    step: 0.0001
  },
  {
    key: "MAX_INVENTORY_DELTA",
    label: "Max Δ BTC",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 1000000,
    step: 0.0001
  },
  {
    key: "MAX_DRAWDOWN_PCT",
    label: "Max Drawdown",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.001
  },
  {
    key: "TRADING_ENABLED",
    label: "Master Kill",
    group: "System",
    kind: "boolean"
  },
  {
    key: "LATENCY_THRESHOLD_MS",
    label: "Max Latency",
    group: "System",
    kind: "number",
    min: 1,
    max: 5000,
    step: 1
  }
];

export const DEFAULT_TRANSPORT_SETTINGS: DraftTransportSettings = {
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  watchdogMs: 5000,
  rateLimitCapacity: 10,
  rateLimitRefillPerSecond: 10
};

export function flattenState(value: unknown, prefix = "state", depth = 0): Array<[string, string]> {
  if (depth > 5) {
    return [[prefix, "[depth-limit]"]];
  }

  if (value === null || value === undefined) {
    return [[prefix, String(value)]];
  }

  if (typeof value !== "object") {
    return [[prefix, String(value)]];
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 16)
      .flatMap((item, index) => flattenState(item, `${prefix}[${index}]`, depth + 1));
  }

  return Object.entries(value as Record<string, unknown>)
    .slice(0, 240)
    .flatMap(([key, item]) => flattenState(item, `${prefix}.${key}`, depth + 1));
}

export function changedMoreThanTenPercent(
  current: Partial<GlobalRiskConfig>,
  draft: Partial<GlobalRiskConfig>
): string[] {
  return Object.entries(draft).flatMap(([key, draftValue]) => {
    const currentValue = current[key as keyof GlobalRiskConfig];

    if (
      draftValue !== undefined &&
      currentValue !== undefined &&
      typeof draftValue !== "number" &&
      draftValue !== currentValue
    ) {
      return [key];
    }

    if (typeof draftValue !== "number" || typeof currentValue !== "number") {
      return [];
    }

    if (currentValue === 0) {
      return Math.abs(draftValue) > 0 ? [key] : [];
    }

    return Math.abs(draftValue - currentValue) / Math.abs(currentValue) > 0.1 ? [key] : [];
  });
}

export function validateParameterDraft(draft: Partial<GlobalRiskConfig>): string[] {
  return [...STRATEGY_KNOBS, ...PARAMETER_MATRIX].flatMap((param) => {
    const value = draft[param.key];
    if (value === undefined || value === null) {
      return [];
    }

    if (param.kind === "number") {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return [`${param.label} must be a finite number.`];
      }
      if (param.min !== undefined && numeric < param.min) {
        return [`${param.label} must be greater than or equal to ${param.min}.`];
      }
      if (param.max !== undefined && numeric > param.max) {
        return [`${param.label} must be less than or equal to ${param.max}.`];
      }
    }

    if (param.kind === "select" && param.options && !param.options.includes(String(value))) {
      return [`${param.label} must be one of ${param.options.join(", ")}.`];
    }

    return [];
  });
}

export function parameterHelp(param: ParameterDescriptor): string {
  return (
    param.help ??
    `${param.label} feeds the ${param.group} control surface and is validated before it can alter the live hot path.`
  );
}
