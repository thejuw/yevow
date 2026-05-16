import type { DraftTransportSettings, GlobalRiskConfig } from "./types";

export type ParameterKind = "boolean" | "number" | "select";
export type ParameterGroup = "Oracle" | "Profiler" | "Croupier" | "Pit Boss" | "System";

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
    label: "Contested Spread",
    group: "Profiler",
    kind: "number",
    min: 1,
    max: 10,
    step: 0.01
  },
  {
    key: "AM_VPIN_TOXIC_SPREAD_MULTIPLIER",
    label: "Toxic Spread",
    group: "Profiler",
    kind: "number",
    min: 1,
    max: 20,
    step: 0.01
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

    if (typeof draftValue !== "number" || typeof currentValue !== "number") {
      return [];
    }

    if (currentValue === 0) {
      return Math.abs(draftValue) > 0 ? [key] : [];
    }

    return Math.abs(draftValue - currentValue) / Math.abs(currentValue) > 0.1 ? [key] : [];
  });
}

export function parameterHelp(param: ParameterDescriptor): string {
  return (
    param.help ??
    `${param.label} feeds the ${param.group} control surface and is validated before it can alter the live hot path.`
  );
}
