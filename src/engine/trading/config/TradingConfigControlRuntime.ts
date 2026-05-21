import type {
  AdminConfigUpdate,
  EngineState,
  Env,
  GlobalRiskConfig,
  JsonRecord,
  MacroBias,
  TemporaryGovernanceOverride
} from "../../../types";
import {
  applyAdminConfigUpdateFlow,
  applyConfigRefreshFlow,
  applyConfigRefreshSideEffects,
  applyRuntimeConfigUpdateSideEffects,
  type EffectiveGovernanceConfig
} from "./ConfigRuntime";

export interface TradingConfigRefreshInput {
  readonly source: "ALARM" | "ADMIN_SIGNAL";
  readonly cachedConfig: GlobalRiskConfig;
  readonly configSnapshot?: GlobalRiskConfig;
  readonly currentState: EngineState;
  readonly observedAt: string;
  readonly requestId: string;
  readonly env: Pick<
    Env,
    "PLACEMENT_TARGET_COLO" | "GOLDEN_COLOS" | "HIGH_LATENCY_COLO_RISK_MULTIPLIER"
  >;
}

export type TradingEngineConfigRefreshInput = Omit<
  TradingConfigRefreshInput,
  "observedAt" | "requestId"
>;

export interface TradingConfigRefreshHandlers {
  readonly fetchConfig: () => Promise<GlobalRiskConfig>;
  readonly readEffectiveConfig: (config: GlobalRiskConfig) => Promise<EffectiveGovernanceConfig>;
  readonly snapshotProfilers: () => EngineState["profilerStates"];
  readonly calculateAssetMatrix: (
    observedAt: string,
    latestInstrumentCode: string | undefined,
    latestOracle: EngineState["oracle"],
    profilerStates: EngineState["profilerStates"],
    assetQuoteStates: EngineState["assetQuoteStates"]
  ) => EngineState["assetMatrix"];
  readonly applyConfigCache: (
    config: GlobalRiskConfig,
    macroBias: MacroBias,
    temporaryOverride: TemporaryGovernanceOverride | null
  ) => void;
  readonly configureProfilers: (config: GlobalRiskConfig) => void;
  readonly setMaxLatencyMs: (maxLatencyMs: number) => void;
  readonly clearKillSwitchLog: () => void;
  readonly applyState: (state: EngineState) => void;
  readonly persistRefreshState: () => Promise<void>;
  readonly warnRefresh: (metadata: JsonRecord) => void;
}

export interface TradingEngineConfigRefreshHandlers extends TradingConfigRefreshHandlers {
  readonly nowIso: () => string;
  readonly createRequestId: () => string;
}

export interface TradingConfigUpdateInput {
  readonly update: AdminConfigUpdate;
  readonly currentState: EngineState;
  readonly cachedConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly temporaryOverride: TemporaryGovernanceOverride | null;
  readonly currentMaxLatencyMs: number;
  readonly observedAt: string;
}

export interface TradingConfigUpdateHandlers {
  readonly refreshConfig: (directConfig?: GlobalRiskConfig) => Promise<void>;
  readonly scheduleConfigRefresh: () => Promise<void>;
  readonly setMaxLatencyMs: (maxLatencyMs: number) => void;
  readonly applyState: (state: EngineState) => void;
  readonly persistAppliedState: () => Promise<void>;
  readonly warnApplied: (metadata: JsonRecord) => void;
}

export async function refreshTradingConfig(
  input: TradingConfigRefreshInput,
  handlers: TradingConfigRefreshHandlers
): Promise<void> {
  await applyConfigRefreshFlow(
    {
      source: input.source,
      previousVersion: input.cachedConfig.version,
      configSnapshot: input.configSnapshot,
      currentState: input.currentState,
      observedAt: input.observedAt,
      requestId: input.requestId,
      env: input.env
    },
    {
      fetchConfig: handlers.fetchConfig,
      readEffectiveConfig: handlers.readEffectiveConfig,
      snapshotProfilers: handlers.snapshotProfilers,
      calculateAssetMatrix: handlers.calculateAssetMatrix,
      applyRefreshSideEffects: (refresh) =>
        applyConfigRefreshSideEffects(refresh, {
          applyConfigCache: handlers.applyConfigCache,
          configureProfilers: handlers.configureProfilers,
          setMaxLatencyMs: handlers.setMaxLatencyMs,
          clearKillSwitchLog: handlers.clearKillSwitchLog,
          applyState: handlers.applyState,
          persistState: handlers.persistRefreshState,
          warnRefresh: handlers.warnRefresh
        })
    }
  );
}

export function refreshTradingEngineConfig(
  input: TradingEngineConfigRefreshInput,
  handlers: TradingEngineConfigRefreshHandlers
): Promise<void> {
  return refreshTradingConfig(
    {
      ...input,
      observedAt: handlers.nowIso(),
      requestId: handlers.createRequestId()
    },
    handlers
  );
}

export async function applyTradingConfigUpdate(
  input: TradingConfigUpdateInput,
  handlers: TradingConfigUpdateHandlers
): Promise<void> {
  await applyAdminConfigUpdateFlow(input, {
    refreshConfig: handlers.refreshConfig,
    scheduleConfigRefresh: handlers.scheduleConfigRefresh,
    applyRuntimeUpdate: (runtimeUpdate) =>
      applyRuntimeConfigUpdateSideEffects(runtimeUpdate, {
        setMaxLatencyMs: handlers.setMaxLatencyMs,
        applyState: handlers.applyState,
        persistState: handlers.persistAppliedState,
        warnApplied: handlers.warnApplied
      })
  });
}
