import type {
  EdgeTopology,
  EngineLocation,
  EngineState,
  Env,
  GlobalRiskConfig,
  JsonRecord,
  MacroBias,
  TemporaryGovernanceOverride
} from "../../../types";
import { toJsonValue } from "../helpers/RuntimeSerialization";
import { applyLocationRisk, resolveEngineLocation } from "../helpers/PlacementResolver";
import {
  aggregateQuoteState,
  reconcileAssetQuoteStatesForConfig
} from "../state/AssetStateRuntime";

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

export interface ConfigRefreshSideEffectsInput extends ConfigRefreshLogInput {
  readonly refreshedState: EngineState;
}

export interface EffectiveGovernanceConfig {
  readonly config: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly temporaryOverride: TemporaryGovernanceOverride | null;
}

export interface ConfigRefreshFlowInput {
  readonly source: "ALARM" | "ADMIN_SIGNAL";
  readonly previousVersion: string;
  readonly configSnapshot?: GlobalRiskConfig;
  readonly currentState: EngineState;
  readonly observedAt: string;
  readonly requestId: string;
  readonly env: Pick<
    Env,
    "PLACEMENT_TARGET_COLO" | "GOLDEN_COLOS" | "HIGH_LATENCY_COLO_RISK_MULTIPLIER"
  >;
}

export interface ConfigRefreshFlowResult extends EffectiveGovernanceConfig {
  readonly refreshedState: EngineState;
}

export interface ConfigRefreshFlowHandlers extends ConfigRefreshRuntimeStateHandlers {
  readonly fetchConfig: () => Promise<GlobalRiskConfig>;
  readonly readEffectiveConfig: (config: GlobalRiskConfig) => Promise<EffectiveGovernanceConfig>;
  readonly applyRefreshSideEffects: (input: ConfigRefreshSideEffectsInput) => Promise<void>;
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

export async function applyConfigRefreshFlow(
  input: ConfigRefreshFlowInput,
  handlers: ConfigRefreshFlowHandlers
): Promise<ConfigRefreshFlowResult> {
  const effectiveGovernance = await handlers.readEffectiveConfig(
    input.configSnapshot ?? (await handlers.fetchConfig())
  );
  const refreshedState = buildConfigRefreshRuntimeState(
    {
      currentState: input.currentState,
      nextConfig: effectiveGovernance.config,
      macroBias: effectiveGovernance.macroBias,
      temporaryOverride: effectiveGovernance.temporaryOverride,
      observedAt: input.observedAt,
      requestId: input.requestId,
      env: input.env
    },
    handlers
  );

  await handlers.applyRefreshSideEffects({
    source: input.source,
    previousVersion: input.previousVersion,
    nextConfig: effectiveGovernance.config,
    macroBias: effectiveGovernance.macroBias,
    temporaryOverride: effectiveGovernance.temporaryOverride,
    refreshedState
  });

  return {
    ...effectiveGovernance,
    refreshedState
  };
}
