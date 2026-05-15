import { ConfigManager } from "./ConfigManager";
import type {
  GlobalRiskConfig,
  MacroBias,
  MacroBiasDirection,
  MacroBiasUpdate,
  SupervisorSource,
  TemporaryGovernanceOverride,
  TemporaryGovernanceOverrideUpdate
} from "./types";

export const MACRO_BIAS_KEY = "MACRO_BIAS";
export const TEMPORARY_OVERRIDE_KEY = "governor:temporary_override";

const DEFAULT_OVERRIDE_MINUTES = 60;

export interface EffectiveGovernance {
  config: GlobalRiskConfig;
  macroBias: MacroBias;
  temporaryOverride: TemporaryGovernanceOverride | null;
}

export class Governor {
  constructor(private readonly configStore: KVNamespace) {}

  async readEffectiveConfig(baseConfig: GlobalRiskConfig): Promise<EffectiveGovernance> {
    const [macroBias, temporaryOverride] = await Promise.all([
      this.readMacroBias(),
      this.readTemporaryOverride()
    ]);
    const config = temporaryOverride
      ? ConfigManager.mergeUpdate(
          baseConfig,
          temporaryOverride.configPatch,
          temporaryOverride.createdBy
        )
      : baseConfig;

    return {
      config: temporaryOverride
        ? {
            ...config,
            updatedAt: temporaryOverride.createdAt,
            updatedBy: temporaryOverride.createdBy,
            version: `${baseConfig.version}:override:${temporaryOverride.overrideId}`
          }
        : config,
      macroBias,
      temporaryOverride
    };
  }

  async readMacroBias(now = new Date()): Promise<MacroBias> {
    try {
      const stored = await this.configStore.get<Partial<MacroBias>>(MACRO_BIAS_KEY, "json");
      const bias = normalizeMacroBias(stored, now);

      if (bias.expiresAt && Date.parse(bias.expiresAt) <= now.getTime()) {
        return neutralMacroBias(now);
      }

      return bias;
    } catch (error) {
      console.error(
        "[Sovereign-Sigma] MACRO_BIAS read failed; neutral macro bias active",
        error instanceof Error ? error.message : error
      );
      return neutralMacroBias(now);
    }
  }

  async writeMacroBias(
    update: MacroBiasUpdate,
    actor: string,
    now = new Date()
  ): Promise<MacroBias> {
    const bias = normalizeMacroBias(
      {
        ...update,
        source: normalizeSource(update.source),
        createdBy: actor,
        createdAt: now.toISOString(),
        expiresAt: resolveExpiry(update, now)
      },
      now
    );

    await this.configStore.put(MACRO_BIAS_KEY, JSON.stringify(bias));
    return bias;
  }

  async clearMacroBias(now = new Date()): Promise<MacroBias> {
    await this.configStore.delete(MACRO_BIAS_KEY);
    return neutralMacroBias(now);
  }

  async readTemporaryOverride(now = new Date()): Promise<TemporaryGovernanceOverride | null> {
    try {
      const stored = await this.configStore.get<Partial<TemporaryGovernanceOverride>>(
        TEMPORARY_OVERRIDE_KEY,
        "json"
      );
      const override = normalizeTemporaryOverride(stored);

      if (!override) {
        return null;
      }

      if (Date.parse(override.expiresAt) <= now.getTime()) {
        await this.configStore.delete(TEMPORARY_OVERRIDE_KEY);
        return null;
      }

      return override;
    } catch (error) {
      console.error(
        "[Sovereign-Sigma] temporary governance override read failed",
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  async writeTemporaryOverride(
    update: TemporaryGovernanceOverrideUpdate,
    actor: string,
    now = new Date()
  ): Promise<TemporaryGovernanceOverride> {
    const durationMs = resolveDurationMs(update);
    const expiresAt = update.expiresAt
      ? new Date(Date.parse(update.expiresAt)).toISOString()
      : new Date(now.getTime() + durationMs).toISOString();
    const override: TemporaryGovernanceOverride = {
      schemaVersion: "governor.override.v1",
      overrideId: crypto.randomUUID(),
      source: normalizeSource(update.source),
      createdBy: actor,
      reason: sanitizeReason(update.reason ?? "Temporary supervisor override"),
      createdAt: now.toISOString(),
      expiresAt,
      durationMs,
      configPatch: normalizeConfigPatch(update)
    };

    await this.configStore.put(TEMPORARY_OVERRIDE_KEY, JSON.stringify(override), {
      expirationTtl: Math.max(60, Math.ceil((Date.parse(expiresAt) - now.getTime()) / 1000))
    });
    return override;
  }

  async clearTemporaryOverride(): Promise<TemporaryGovernanceOverride | null> {
    const existing = await this.readTemporaryOverride();
    await this.configStore.delete(TEMPORARY_OVERRIDE_KEY);
    return existing;
  }
}

export function neutralMacroBias(now = new Date()): MacroBias {
  return {
    schemaVersion: "macro-bias.v1",
    direction: "NEUTRAL",
    intensity: 0,
    confidence: 0,
    instruments: [],
    reason: "No active external macro bias",
    source: "SYSTEM",
    createdBy: "system",
    createdAt: now.toISOString(),
    expiresAt: null
  };
}

function normalizeMacroBias(value: Partial<MacroBias> | null | undefined, now: Date): MacroBias {
  if (!value || value.schemaVersion !== "macro-bias.v1") {
    return neutralMacroBias(now);
  }

  return {
    schemaVersion: "macro-bias.v1",
    direction: normalizeDirection(value.direction),
    intensity: boundedNumber(value.intensity, 0, 1, 0),
    confidence: boundedNumber(value.confidence, 0, 1, 0),
    instruments: Array.isArray(value.instruments)
      ? value.instruments
          .filter((instrument): instrument is string => typeof instrument === "string")
          .map((instrument) => instrument.toLowerCase())
          .slice(0, 100)
      : [],
    reason: sanitizeReason(value.reason ?? "External macro bias"),
    source: normalizeSource(value.source),
    createdBy: typeof value.createdBy === "string" ? value.createdBy : "unknown",
    createdAt: normalizeDate(value.createdAt) ?? now.toISOString(),
    expiresAt: normalizeDate(value.expiresAt)
  };
}

function normalizeTemporaryOverride(
  value: Partial<TemporaryGovernanceOverride> | null | undefined
): TemporaryGovernanceOverride | null {
  if (!value || value.schemaVersion !== "governor.override.v1") {
    return null;
  }

  const expiresAt = normalizeDate(value.expiresAt);
  const createdAt = normalizeDate(value.createdAt);

  if (!expiresAt || !createdAt || typeof value.overrideId !== "string") {
    return null;
  }

  return {
    schemaVersion: "governor.override.v1",
    overrideId: value.overrideId,
    source: normalizeSource(value.source),
    createdBy: typeof value.createdBy === "string" ? value.createdBy : "unknown",
    reason: sanitizeReason(value.reason ?? "Temporary supervisor override"),
    createdAt,
    expiresAt,
    durationMs: Math.max(60_000, Math.round(Number(value.durationMs) || DEFAULT_OVERRIDE_MINUTES * 60_000)),
    configPatch: normalizeConfigPatch(value.configPatch ?? {})
  };
}

function normalizeConfigPatch(
  update: TemporaryGovernanceOverrideUpdate | TemporaryGovernanceOverride["configPatch"]
): TemporaryGovernanceOverride["configPatch"] {
  const nested = "configPatch" in update ? update.configPatch ?? {} : update;
  const patch: TemporaryGovernanceOverride["configPatch"] = {};
  const tradingEnabled =
    "TRADING_ENABLED" in update ? update.TRADING_ENABLED : nested.TRADING_ENABLED;
  const minEvThreshold =
    "MIN_EV_THRESHOLD" in update ? update.MIN_EV_THRESHOLD : nested.MIN_EV_THRESHOLD;
  const latencyThresholdMs =
    "LATENCY_THRESHOLD_MS" in update
      ? update.LATENCY_THRESHOLD_MS
      : nested.LATENCY_THRESHOLD_MS;
  const manualSkepticism =
    "ORACLE_MANUAL_SKEPTICISM" in update
      ? update.ORACLE_MANUAL_SKEPTICISM
      : nested.ORACLE_MANUAL_SKEPTICISM;
  const maxSkepticism =
    "ORACLE_MAX_SKEPTICISM" in update
      ? update.ORACLE_MAX_SKEPTICISM
      : nested.ORACLE_MAX_SKEPTICISM;
  const governanceMode =
    "ORACLE_GOVERNANCE_MODE" in update
      ? update.ORACLE_GOVERNANCE_MODE
      : nested.ORACLE_GOVERNANCE_MODE;

  if (typeof tradingEnabled === "boolean") {
    patch.TRADING_ENABLED = tradingEnabled;
  }
  if (Number.isFinite(minEvThreshold)) {
    patch.MIN_EV_THRESHOLD = Number(minEvThreshold);
  }
  if (Number.isFinite(latencyThresholdMs) && Number(latencyThresholdMs) > 0) {
    patch.LATENCY_THRESHOLD_MS = Math.round(Number(latencyThresholdMs));
  }
  if (Number.isFinite(manualSkepticism)) {
    patch.ORACLE_MANUAL_SKEPTICISM = boundedNumber(manualSkepticism, 1, 10, 1);
  }
  if (Number.isFinite(maxSkepticism)) {
    patch.ORACLE_MAX_SKEPTICISM = boundedNumber(maxSkepticism, 1, 10, 4);
  }
  if (governanceMode === "MANUAL" || governanceMode === "AUTONOMOUS" || governanceMode === "HYBRID") {
    patch.ORACLE_GOVERNANCE_MODE = governanceMode;
  }

  return patch;
}

function resolveDurationMs(update: TemporaryGovernanceOverrideUpdate): number {
  if (Number.isFinite(update.durationMs) && Number(update.durationMs) > 0) {
    return Math.round(Number(update.durationMs));
  }

  if (Number.isFinite(update.durationMinutes) && Number(update.durationMinutes) > 0) {
    return Math.round(Number(update.durationMinutes) * 60_000);
  }

  if (update.expiresAt) {
    const parsed = Date.parse(update.expiresAt);
    if (Number.isFinite(parsed)) {
      return Math.max(60_000, parsed - Date.now());
    }
  }

  return DEFAULT_OVERRIDE_MINUTES * 60_000;
}

function resolveExpiry(update: MacroBiasUpdate, now: Date): string | null {
  const explicit = normalizeDate(update.expiresAt);
  if (explicit) {
    return explicit;
  }

  if (Number.isFinite(update.durationMs) && Number(update.durationMs) > 0) {
    return new Date(now.getTime() + Math.round(Number(update.durationMs))).toISOString();
  }

  if (Number.isFinite(update.durationMinutes) && Number(update.durationMinutes) > 0) {
    return new Date(now.getTime() + Math.round(Number(update.durationMinutes) * 60_000)).toISOString();
  }

  return null;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeDirection(value: unknown): MacroBiasDirection {
  return value === "BULLISH" ||
    value === "BEARISH" ||
    value === "RISK_ON" ||
    value === "RISK_OFF" ||
    value === "NEUTRAL"
    ? value
    : "NEUTRAL";
}

function normalizeSource(value: unknown): SupervisorSource {
  return value === "MOLTWORKER" || value === "ADMIN" || value === "SYSTEM"
    ? value
    : "MOLTWORKER";
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function sanitizeReason(value: string): string {
  return value.slice(0, 512).replace(/[^\w\s.,:;@/()+-]/g, "").trim() || "Supervisor override";
}
