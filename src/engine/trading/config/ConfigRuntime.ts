import type {
  AdminConfigUpdate,
  EngineState,
  GlobalRiskConfig,
  JsonRecord,
  MacroBias,
  TemporaryGovernanceOverride
} from "../../../types";
import { configFromAdminSnapshot } from "../../../ConfigManager";
import { mergeRiskLimits, resolveMaxLatencyMs } from "../state/EngineStateDefaults";
import { applyLocationRisk } from "../helpers/PlacementResolver";
import { hasRuntimeConfigUpdate } from "./RuntimeConfigUpdateDetection";
export {
  applyConfigRefreshFlow,
  applyConfigRefreshSideEffects,
  buildConfigRefreshLog,
  buildConfigRefreshRuntimeState,
  configRefreshQuoteState,
  configRefreshTopologyFromLocation,
  shouldLogConfigRefresh,
  stateAfterConfigRefresh,
  type ConfigRefreshFlowHandlers,
  type ConfigRefreshFlowInput,
  type ConfigRefreshFlowResult,
  type ConfigRefreshLogInput,
  type ConfigRefreshQuoteStateInput,
  type ConfigRefreshQuoteStateResult,
  type ConfigRefreshRuntimeStateHandlers,
  type ConfigRefreshRuntimeStateInput,
  type ConfigRefreshSideEffectHandlers,
  type ConfigRefreshSideEffectsInput,
  type ConfigRefreshStateInput,
  type EffectiveGovernanceConfig
} from "./ConfigRefreshRuntime";

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

export interface RuntimeConfigAppliedLogInput {
  readonly state: EngineState;
  readonly maxLatencyMs: number;
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

export function buildRuntimeConfigAppliedLog(input: RuntimeConfigAppliedLogInput): JsonRecord {
  return {
    mode: input.state.mode,
    riskConfigVersion: input.state.risk.configVersion,
    maxLatencyMs: input.maxLatencyMs,
    killSwitch: input.state.risk.killSwitch
  };
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
