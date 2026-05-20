import type {
  AdminConfigUpdate,
  EdgeTopology,
  EngineLocation,
  EngineState,
  GlobalRiskConfig,
  JsonRecord,
  MacroBias,
  TemporaryGovernanceOverride
} from "../../../types";
import { toJsonValue } from "../helpers/RuntimeSerialization";
import { mergeRiskLimits, resolveMaxLatencyMs } from "../state/EngineStateDefaults";
import { applyLocationRisk } from "../helpers/PlacementResolver";
import {
  aggregateQuoteState,
  reconcileAssetQuoteStatesForConfig
} from "../state/AssetStateRuntime";

export interface RuntimeConfigUpdateInput {
  readonly currentState: EngineState;
  readonly update: AdminConfigUpdate;
  readonly cachedConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly temporaryOverride: TemporaryGovernanceOverride | null;
  readonly currentMaxLatencyMs: number;
  readonly observedAt: string;
}

export interface RuntimeConfigUpdateResult {
  readonly state: EngineState;
  readonly maxLatencyMs: number;
}

export interface ConfigRefreshStateInput {
  readonly currentState: EngineState;
  readonly nextConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly temporaryOverride: TemporaryGovernanceOverride | null;
  readonly nextAssetQuoteStates: EngineState["assetQuoteStates"];
  readonly nextQuoteState: EngineState["quoteState"];
  readonly assetMatrix: EngineState["assetMatrix"];
  readonly profilerStates: EngineState["profilerStates"];
  readonly refreshedLocation: EngineLocation;
  readonly observedAt: string;
}

export interface ConfigRefreshQuoteStateInput {
  readonly assetQuoteStates: EngineState["assetQuoteStates"];
  readonly quoteState: EngineState["quoteState"];
  readonly nextConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly observedAt: string;
}

export interface ConfigRefreshQuoteStateResult {
  readonly assetQuoteStates: EngineState["assetQuoteStates"];
  readonly quoteState: EngineState["quoteState"];
}

export interface ConfigRefreshLogInput {
  readonly source: "ALARM" | "ADMIN_SIGNAL";
  readonly previousVersion: string;
  readonly nextConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly temporaryOverride: TemporaryGovernanceOverride | null;
}

export interface RuntimeConfigAppliedLogInput {
  readonly state: EngineState;
  readonly maxLatencyMs: number;
}

export function stateAfterRuntimeConfigUpdate(
  input: RuntimeConfigUpdateInput
): RuntimeConfigUpdateResult {
  const maxLatencyMs = resolveMaxLatencyMs(input.update, input.currentMaxLatencyMs);
  const nextRisk = input.update.risk
    ? mergeRiskLimits(input.currentState.risk, {
        ...input.update.risk,
        updatedAt: input.observedAt
      })
    : input.currentState.risk;

  return {
    maxLatencyMs,
    state: {
      ...input.currentState,
      mode: input.update.mode ?? input.currentState.mode,
      bankroll: {
        ...input.currentState.bankroll,
        ...input.update.bankroll,
        updatedAt: input.observedAt
      },
      risk: applyLocationRisk(
        nextRisk,
        input.cachedConfig,
        input.currentState.location,
        input.observedAt
      ),
      maxLatencyMs,
      cachedConfig: input.cachedConfig,
      macroBias: input.macroBias,
      temporaryOverride: input.temporaryOverride,
      heartbeatAt: input.observedAt,
      updatedAt: input.observedAt
    }
  };
}

export function stateAfterConfigRefresh(input: ConfigRefreshStateInput): EngineState {
  return {
    ...input.currentState,
    cachedConfig: input.nextConfig,
    macroBias: input.macroBias,
    temporaryOverride: input.temporaryOverride,
    assetQuoteStates: input.nextAssetQuoteStates,
    quoteState: input.nextQuoteState,
    assetMatrix: input.assetMatrix,
    profilerStates: input.profilerStates,
    maxLatencyMs: input.nextConfig.LATENCY_THRESHOLD_MS,
    location: input.refreshedLocation,
    risk: applyLocationRisk(
      {
        ...input.currentState.risk,
        configVersion: input.nextConfig.version,
        killSwitch: !input.nextConfig.TRADING_ENABLED,
        maxOrderNotional: input.nextConfig.MAX_POSITION_SIZE,
        maxDrawdownPct: input.nextConfig.MAX_DRAWDOWN_PCT,
        updatedAt: input.observedAt
      },
      input.nextConfig,
      input.refreshedLocation,
      input.observedAt
    ),
    updatedAt: input.observedAt
  };
}

export function configRefreshQuoteState(
  input: ConfigRefreshQuoteStateInput
): ConfigRefreshQuoteStateResult {
  const assetQuoteStates = reconcileAssetQuoteStatesForConfig(
    input.assetQuoteStates,
    input.nextConfig,
    input.macroBias,
    input.observedAt
  );

  return {
    assetQuoteStates,
    quoteState: aggregateQuoteState(assetQuoteStates, input.quoteState, input.observedAt)
  };
}

export function configRefreshTopologyFromLocation(
  location: EngineLocation,
  observedAt: string,
  requestId: string
): EdgeTopology {
  return {
    colo: location.colo,
    placement: location.placement,
    country: location.country,
    city: location.city,
    region: location.region,
    timezone: location.timezone,
    latitude: location.latitude,
    longitude: location.longitude,
    requestId,
    observedAt
  };
}

export function shouldLogConfigRefresh(input: ConfigRefreshLogInput): boolean {
  return input.source === "ADMIN_SIGNAL" || input.previousVersion !== input.nextConfig.version;
}

export function buildConfigRefreshLog(input: ConfigRefreshLogInput): JsonRecord {
  return {
    source: input.source,
    tradingEnabled: input.nextConfig.TRADING_ENABLED,
    maxPositionSize: input.nextConfig.MAX_POSITION_SIZE,
    maxDrawdownPct: input.nextConfig.MAX_DRAWDOWN_PCT,
    latencyThresholdMs: input.nextConfig.LATENCY_THRESHOLD_MS,
    goldenColos: input.nextConfig.GOLDEN_COLOS,
    configVersion: input.nextConfig.version,
    macroBias: toJsonValue(input.macroBias),
    temporaryOverride: toJsonValue(input.temporaryOverride)
  };
}

export function buildRuntimeConfigAppliedLog(input: RuntimeConfigAppliedLogInput): JsonRecord {
  return {
    mode: input.state.mode,
    riskConfigVersion: input.state.risk.configVersion,
    maxLatencyMs: input.maxLatencyMs,
    killSwitch: input.state.risk.killSwitch
  };
}
