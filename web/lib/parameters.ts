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
}

export const PARAMETER_MATRIX: ParameterDescriptor[] = [
  {
    key: "ORACLE_GOVERNANCE_MODE",
    label: "Governance",
    group: "Oracle",
    kind: "select",
    options: ["MANUAL", "AUTONOMOUS", "HYBRID"]
  },
  {
    key: "ORACLE_MANUAL_SKEPTICISM",
    label: "κ Manual",
    group: "Oracle",
    kind: "number",
    min: 1,
    max: 10,
    step: 0.05
  },
  {
    key: "ORACLE_MAX_SKEPTICISM",
    label: "κ Ceiling",
    group: "Oracle",
    kind: "number",
    min: 1,
    max: 10,
    step: 0.05
  },
  {
    key: "VAR_CONFIDENCE_Z",
    label: "VaR Z",
    group: "Oracle",
    kind: "number",
    min: 1,
    max: 4,
    step: 0.001
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
    label: "Risk λ",
    group: "Croupier",
    kind: "number",
    min: 0,
    max: 1,
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
