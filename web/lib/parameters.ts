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
    key: "MARKET_MAKING_MODE",
    label: "Market-Making Mode",
    group: "Strategy",
    kind: "select",
    options: ["OFF", "PASSIVE", "BALANCED", "AGGRESSIVE", "INVENTORY_SKEW_ONLY"],
    help: "Top-level quote posture. OFF pulls quoting, PASSIVE widens, BALANCED is normal, AGGRESSIVE tightens cautiously, and INVENTORY_SKEW_ONLY only quotes the side that reduces inventory."
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
    key: "KELLY_FRACTION",
    label: "Kelly Fraction",
    group: "Pit Boss",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01
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
    return value.slice(0, 16).flatMap((item, index) => flattenState(item, `${prefix}[${index}]`, depth + 1));
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

    if (
      param.kind === "select" &&
      param.options &&
      !param.options.includes(String(value))
    ) {
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
