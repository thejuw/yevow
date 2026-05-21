import type {
  AdminConfigUpdate,
  EngineState,
  Env,
  GlobalRiskConfig,
  JsonRecord,
  MacroBias,
  TemporaryGovernanceOverride
} from "../../../types";
import { CONFIG_ALARM_INTERVAL_MS, ENGINE_STATE_KEY } from "../../../TradingEngineConstants";
import {
  calculateTradingAssetMatrixForTarget,
  type TradingAssetMatrixTarget
} from "../state/TradingAssetMatrixRuntime";
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

export type TradingEngineConfigUpdateInput = Omit<TradingConfigUpdateInput, "observedAt">;

export interface TradingConfigUpdateHandlers {
  readonly refreshConfig: (directConfig?: GlobalRiskConfig) => Promise<void>;
  readonly scheduleConfigRefresh: () => Promise<void>;
  readonly setMaxLatencyMs: (maxLatencyMs: number) => void;
  readonly applyState: (state: EngineState) => void;
  readonly persistAppliedState: () => Promise<void>;
  readonly warnApplied: (metadata: JsonRecord) => void;
}

export interface TradingEngineConfigUpdateHandlers extends TradingConfigUpdateHandlers {
  readonly nowIso: () => string;
}

export interface TradingEngineConfigControlTarget {
  cachedConfig: GlobalRiskConfig;
  macroBias: MacroBias;
  activeTemporaryOverride: TemporaryGovernanceOverride | null;
  maxLatencyMs: number;
  killSwitchLogged: boolean;
  engineState: EngineState;
  readonly env: Pick<
    Env,
    | "PLACEMENT_TARGET_COLO"
    | "GOLDEN_COLOS"
    | "HIGH_LATENCY_COLO_RISK_MULTIPLIER"
    | "MAX_POSITION_PCT"
  >;
  readonly orderBook: TradingAssetMatrixTarget["orderBook"];
  readonly configManager: {
    fetchConfig(): Promise<GlobalRiskConfig>;
  };
  readonly governor: {
    readEffectiveConfig(config: GlobalRiskConfig): Promise<EffectiveGovernanceConfig>;
  };
  readonly profilerRegistry: {
    snapshot(): EngineState["profilerStates"];
    configure(config: GlobalRiskConfig): void;
  } & TradingAssetMatrixTarget["profilerRegistry"];
  readonly logger: {
    warn(eventType: string, message: string, telemetry?: JsonRecord): void;
  };
  safeStoragePut(key: string, value: unknown, reason: string): Promise<void>;
  safeSetAlarm(timestamp: number, reason: string): Promise<void>;
}

export interface TradingConfigRefreshCadenceTarget {
  lastConfigRefreshAttemptAt: number;
  refreshConfig(source: "ALARM" | "ADMIN_SIGNAL"): Promise<void>;
  safeSetAlarm(timestamp: number, reason: string): Promise<void>;
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

export function applyTradingEngineConfigUpdate(
  input: TradingEngineConfigUpdateInput,
  handlers: TradingEngineConfigUpdateHandlers
): Promise<void> {
  return applyTradingConfigUpdate(
    {
      ...input,
      observedAt: handlers.nowIso()
    },
    handlers
  );
}

export function refreshTradingEngineConfigForTarget(
  input: Pick<TradingEngineConfigRefreshInput, "source" | "configSnapshot">,
  target: TradingEngineConfigControlTarget
): Promise<void> {
  return refreshTradingEngineConfig(
    {
      source: input.source,
      cachedConfig: target.cachedConfig,
      configSnapshot: input.configSnapshot,
      currentState: target.engineState,
      env: target.env
    },
    {
      nowIso: () => new Date().toISOString(),
      createRequestId: () => crypto.randomUUID(),
      fetchConfig: () => target.configManager.fetchConfig(),
      readEffectiveConfig: (config) => target.governor.readEffectiveConfig(config),
      snapshotProfilers: () => target.profilerRegistry.snapshot(),
      calculateAssetMatrix: (
        observedAt,
        _latestInstrumentCode,
        latestOracle,
        profilerStates,
        assetQuoteStates
      ) =>
        calculateTradingAssetMatrixForTarget(
          {
            observedAt,
            latestOracle,
            profilerStates,
            assetQuoteStates
          },
          target
        ),
      applyConfigCache: (config, macroBias, temporaryOverride) => {
        target.cachedConfig = config;
        target.macroBias = macroBias;
        target.activeTemporaryOverride = temporaryOverride;
      },
      configureProfilers: (config) => {
        target.profilerRegistry.configure(config);
      },
      setMaxLatencyMs: (maxLatencyMs) => {
        target.maxLatencyMs = maxLatencyMs;
      },
      clearKillSwitchLog: () => {
        target.killSwitchLogged = false;
      },
      applyState: (state) => {
        target.engineState = state;
      },
      persistRefreshState: () =>
        target.safeStoragePut(ENGINE_STATE_KEY, target.engineState, "CONFIG_REFRESH"),
      warnRefresh: (metadata) => {
        target.logger.warn("CONFIG_REFRESHED", "Trading engine config cache refreshed", metadata);
      }
    }
  );
}

export async function refreshTradingConfigIfDueForTarget(
  source: "ALARM" | "ADMIN_SIGNAL",
  target: TradingConfigRefreshCadenceTarget,
  nowMs = Date.now()
): Promise<boolean> {
  if (nowMs - target.lastConfigRefreshAttemptAt < CONFIG_ALARM_INTERVAL_MS) {
    return false;
  }

  target.lastConfigRefreshAttemptAt = nowMs;
  await target.refreshConfig(source);
  return true;
}

export async function scheduleTradingConfigRefreshForTarget(
  target: Pick<TradingConfigRefreshCadenceTarget, "safeSetAlarm">,
  nowMs = Date.now()
): Promise<void> {
  await target.safeSetAlarm(nowMs + CONFIG_ALARM_INTERVAL_MS, "CONFIG_REFRESH_ALARM");
}

export function applyTradingEngineConfigUpdateForTarget(
  update: AdminConfigUpdate,
  target: TradingEngineConfigControlTarget
): Promise<void> {
  return applyTradingEngineConfigUpdate(
    {
      update,
      currentState: target.engineState,
      cachedConfig: target.cachedConfig,
      macroBias: target.macroBias,
      temporaryOverride: target.activeTemporaryOverride,
      currentMaxLatencyMs: target.maxLatencyMs
    },
    {
      nowIso: () => new Date().toISOString(),
      refreshConfig: (directConfig) =>
        refreshTradingEngineConfigForTarget(
          { source: "ADMIN_SIGNAL", configSnapshot: directConfig },
          target
        ),
      scheduleConfigRefresh: () => scheduleTradingConfigRefreshForTarget(target),
      setMaxLatencyMs: (maxLatencyMs) => {
        target.maxLatencyMs = maxLatencyMs;
      },
      applyState: (state) => {
        target.engineState = state;
      },
      persistAppliedState: () =>
        target.safeStoragePut(ENGINE_STATE_KEY, target.engineState, "ADMIN_CONFIG_APPLIED"),
      warnApplied: (metadata) => {
        target.logger.warn("ADMIN_CONFIG_APPLIED", "Runtime configuration updated", metadata);
      }
    }
  );
}
