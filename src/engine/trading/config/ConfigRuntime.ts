import type {
  AdminConfigUpdate,
  EdgeTopology,
  EngineLocation,
  EngineState,
  Env,
  GlobalRiskConfig,
  JsonRecord,
  MacroBias,
  TemporaryGovernanceOverride
} from "../../../types";
import { configFromAdminSnapshot } from "../../../ConfigManager";
import { toJsonValue } from "../helpers/RuntimeSerialization";
import { mergeRiskLimits, resolveMaxLatencyMs } from "../state/EngineStateDefaults";
import { applyLocationRisk, resolveEngineLocation } from "../helpers/PlacementResolver";
import {
  aggregateQuoteState,
  reconcileAssetQuoteStatesForConfig
} from "../state/AssetStateRuntime";
import { hasRuntimeConfigUpdate } from "./RuntimeConfigUpdateDetection";

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

export interface ConfigRefreshRuntimeStateInput {
  readonly currentState: EngineState;
  readonly nextConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly temporaryOverride: TemporaryGovernanceOverride | null;
  readonly observedAt: string;
  readonly requestId: string;
  readonly env: Pick<
    Env,
    "PLACEMENT_TARGET_COLO" | "GOLDEN_COLOS" | "HIGH_LATENCY_COLO_RISK_MULTIPLIER"
  >;
}

export interface ConfigRefreshRuntimeStateHandlers {
  readonly snapshotProfilers: () => EngineState["profilerStates"];
  readonly calculateAssetMatrix: (
    observedAt: string,
    latestInstrumentCode: string | undefined,
    latestOracle: EngineState["oracle"],
    profilerStates: EngineState["profilerStates"],
    assetQuoteStates: EngineState["assetQuoteStates"]
  ) => EngineState["assetMatrix"];
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

export interface ConfigRefreshSideEffectsInput extends ConfigRefreshLogInput {
  readonly refreshedState: EngineState;
}

export interface ConfigRefreshSideEffectHandlers {
  readonly applyConfigCache: (
    config: GlobalRiskConfig,
    macroBias: MacroBias,
    temporaryOverride: TemporaryGovernanceOverride | null
  ) => void;
  readonly configureProfilers: (config: GlobalRiskConfig) => void;
  readonly setMaxLatencyMs: (maxLatencyMs: number) => void;
  readonly clearKillSwitchLog: () => void;
  readonly applyState: (state: EngineState) => void;
  readonly persistState: () => Promise<void>;
  readonly warnRefresh: (metadata: JsonRecord) => void;
}

export type RuntimeConfigUpdateSideEffectsInput = RuntimeConfigUpdateResult;

export interface RuntimeConfigUpdateSideEffectHandlers {
  readonly setMaxLatencyMs: (maxLatencyMs: number) => void;
  readonly applyState: (state: EngineState) => void;
  readonly persistState: () => Promise<void>;
  readonly warnApplied: (metadata: JsonRecord) => void;
}

export interface AdminConfigUpdateFlowInput {
  readonly update: AdminConfigUpdate;
  readonly currentState: EngineState;
  readonly cachedConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly temporaryOverride: TemporaryGovernanceOverride | null;
  readonly currentMaxLatencyMs: number;
  readonly observedAt: string;
}

export interface AdminConfigUpdateFlowHandlers {
  readonly refreshConfig: (directConfig?: GlobalRiskConfig) => Promise<void>;
  readonly scheduleConfigRefresh: () => Promise<void>;
  readonly applyRuntimeUpdate: (runtimeUpdate: RuntimeConfigUpdateResult) => Promise<void>;
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

export function buildConfigRefreshRuntimeState(
  input: ConfigRefreshRuntimeStateInput,
  handlers: ConfigRefreshRuntimeStateHandlers
): EngineState {
  const quoteRefresh = configRefreshQuoteState({
    assetQuoteStates: input.currentState.assetQuoteStates,
    quoteState: input.currentState.quoteState,
    nextConfig: input.nextConfig,
    macroBias: input.macroBias,
    observedAt: input.observedAt
  });
  const profilerStates = handlers.snapshotProfilers();
  const refreshedLocation = resolveEngineLocation(
    configRefreshTopologyFromLocation(
      input.currentState.location,
      input.observedAt,
      input.requestId
    ),
    input.currentState.location,
    input.env,
    input.nextConfig,
    input.currentState.location.observedLatencyMs
  );

  return stateAfterConfigRefresh({
    currentState: input.currentState,
    nextConfig: input.nextConfig,
    macroBias: input.macroBias,
    temporaryOverride: input.temporaryOverride,
    nextAssetQuoteStates: quoteRefresh.assetQuoteStates,
    nextQuoteState: quoteRefresh.quoteState,
    assetMatrix: handlers.calculateAssetMatrix(
      input.observedAt,
      input.currentState.microstructure.instrumentCode ?? undefined,
      input.currentState.oracle,
      profilerStates,
      quoteRefresh.assetQuoteStates
    ),
    profilerStates,
    refreshedLocation,
    observedAt: input.observedAt
  });
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

export async function applyConfigRefreshSideEffects(
  input: ConfigRefreshSideEffectsInput,
  handlers: ConfigRefreshSideEffectHandlers
): Promise<void> {
  handlers.applyConfigCache(input.nextConfig, input.macroBias, input.temporaryOverride);
  handlers.configureProfilers(input.nextConfig);
  handlers.setMaxLatencyMs(input.nextConfig.LATENCY_THRESHOLD_MS);

  if (input.nextConfig.TRADING_ENABLED) {
    handlers.clearKillSwitchLog();
  }

  handlers.applyState(input.refreshedState);
  await handlers.persistState();

  if (shouldLogConfigRefresh(input)) {
    handlers.warnRefresh(buildConfigRefreshLog(input));
  }
}

export async function applyRuntimeConfigUpdateSideEffects(
  input: RuntimeConfigUpdateSideEffectsInput,
  handlers: RuntimeConfigUpdateSideEffectHandlers
): Promise<void> {
  handlers.setMaxLatencyMs(input.maxLatencyMs);
  handlers.applyState(input.state);
  await handlers.persistState();
  handlers.warnApplied(buildRuntimeConfigAppliedLog(input));
}

export async function applyAdminConfigUpdateFlow(
  input: AdminConfigUpdateFlowInput,
  handlers: AdminConfigUpdateFlowHandlers
): Promise<RuntimeConfigUpdateResult | null> {
  if (input.update.signal === "REFRESH_CONFIG" || input.update.config) {
    const directConfig = input.update.config
      ? configFromAdminSnapshot({
          currentConfig: input.cachedConfig,
          snapshot: input.update.config
        })
      : undefined;

    await handlers.refreshConfig(directConfig);
    await handlers.scheduleConfigRefresh();

    if (!hasRuntimeConfigUpdate(input.update)) {
      return null;
    }
  }

  const runtimeUpdate = stateAfterRuntimeConfigUpdate({
    currentState: input.currentState,
    update: input.update,
    cachedConfig: input.cachedConfig,
    macroBias: input.macroBias,
    temporaryOverride: input.temporaryOverride,
    currentMaxLatencyMs: input.currentMaxLatencyMs,
    observedAt: input.observedAt
  });

  await handlers.applyRuntimeUpdate(runtimeUpdate);
  return runtimeUpdate;
}
