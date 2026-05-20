import type {
  EngineState,
  GlobalRiskConfig,
  JsonRecord,
  MacroBias,
  ShadowQueueState
} from "../../../types";
import { DEFAULT_PAPER_BANKROLL_USD } from "../../../TradingEngineConstants";
import { normalizeSourceExchange } from "../helpers/NativeHyperliquidRuntime";
import { readPositiveNumber } from "../helpers/RuntimeParsing";
import { aggregateQuoteState, defaultAssetQuoteStates } from "./AssetStateRuntime";
import {
  defaultCitadelState,
  defaultInventoryState,
  maintenanceRecoveryInstruments,
  defaultRiskMetrics
} from "./EngineStateDefaults";

export interface AdminRecoveryRuntimePayload {
  readonly reason?: string;
  readonly resetInstruments?: string[] | string;
  readonly instrumentCode?: string;
  readonly source_exchange?: string;
  readonly clearCitadel?: boolean;
  readonly clearQuoteState?: boolean;
  readonly clearLatency?: boolean;
  readonly resetPaperPortfolio?: boolean;
  readonly clearShadowQueue?: boolean;
}

export interface AdminRecoveryPlan {
  readonly observedAt: string;
  readonly reason: string;
  readonly sourceExchange: string;
  readonly resetInstruments: readonly string[];
  readonly shouldClearLatency: boolean;
  readonly shouldClearShadowQueue: boolean;
  readonly shouldResetPaperPortfolio: boolean;
}

export interface AdminRecoveryStateInput {
  readonly currentState: EngineState;
  readonly payload: AdminRecoveryRuntimePayload;
  readonly cachedConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly observedAt: string;
  readonly shadowMode: boolean;
  readonly paperBankroll: number;
  readonly shadowQueue: ShadowQueueState;
  readonly reason: string;
  readonly resetInstruments: readonly string[];
  readonly sourceExchange: string;
  readonly prunedProfilerStorageKeys: readonly string[];
}

export interface AdminRecoveryStateResult {
  readonly state: EngineState;
  readonly shouldClearShadowQueue: boolean;
  readonly logMetadata: JsonRecord;
  readonly publishPayload: JsonRecord;
}

export interface AdminRecoveryStorageInput {
  readonly engineStateKey: string;
  readonly state: EngineState;
  readonly performanceHistoryKey: string;
  readonly latencyHistory: unknown;
  readonly processingLatencySamplesKey: string;
  readonly processingLatencySamples: readonly number[];
}

export interface AdminRecoveryResponseInput {
  readonly reason: string;
  readonly resetInstruments: readonly string[];
  readonly sourceExchange: string;
  readonly state: EngineState;
}

export interface AdminRecoveryCompletionArtifactsInput {
  readonly plan: AdminRecoveryPlan;
  readonly recovery: AdminRecoveryStateResult;
  readonly engineStateKey: string;
  readonly performanceHistoryKey: string;
  readonly latencyHistory: unknown;
  readonly processingLatencySamplesKey: string;
  readonly processingLatencySamples: readonly number[];
}

export interface AdminRecoveryCompletionArtifacts {
  readonly storageEntries: Record<string, unknown>;
  readonly paperSessionStartedAt: string | null;
  readonly logMetadata: JsonRecord;
  readonly publishPayload: JsonRecord;
  readonly response: JsonRecord;
}

export interface AdminRecoveryRuntimeArtifactsInput extends Omit<
  AdminRecoveryCompletionArtifactsInput,
  "recovery"
> {
  readonly currentState: EngineState;
  readonly payload: AdminRecoveryRuntimePayload;
  readonly cachedConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly shadowMode: boolean;
  readonly paperBankroll: number;
  readonly shadowQueue: ShadowQueueState;
  readonly prunedProfilerStorageKeys: readonly string[];
}

export interface AdminRecoveryRuntimeArtifacts {
  readonly recovery: AdminRecoveryStateResult;
  readonly completion: AdminRecoveryCompletionArtifacts;
}

export function resolveAdminRecoveryPaperBankroll(envValue?: string): number {
  return readPositiveNumber(envValue, DEFAULT_PAPER_BANKROLL_USD);
}

export function adminRecoveryPlan(
  payload: AdminRecoveryRuntimePayload,
  observedAt = new Date().toISOString()
): AdminRecoveryPlan {
  const reason =
    typeof payload.reason === "string" && payload.reason.length > 0
      ? payload.reason
      : "ADMIN_CONTROLLED_RECOVERY";
  const sourceExchange = payload.source_exchange
    ? normalizeSourceExchange(payload.source_exchange)
    : "hyperliquid";

  return {
    observedAt,
    reason,
    sourceExchange,
    resetInstruments: maintenanceRecoveryInstruments(payload),
    shouldClearLatency: payload.clearLatency !== false,
    shouldClearShadowQueue: payload.clearShadowQueue !== false,
    shouldResetPaperPortfolio: payload.resetPaperPortfolio === true
  };
}

export function stateAfterAdminControlledRecovery(
  input: AdminRecoveryStateInput
): AdminRecoveryStateResult {
  const shouldClearShadowQueue = input.payload.clearShadowQueue !== false;
  const nextAssetQuoteStates =
    input.payload.clearQuoteState === false
      ? input.currentState.assetQuoteStates
      : defaultAssetQuoteStates(input.cachedConfig, input.macroBias, input.observedAt);
  const nextQuoteState =
    input.payload.clearQuoteState === false
      ? input.currentState.quoteState
      : aggregateQuoteState(nextAssetQuoteStates, input.currentState.quoteState, input.observedAt);
  const nextCitadel =
    input.payload.clearCitadel === false
      ? input.currentState.citadel
      : {
          ...defaultCitadelState(input.observedAt),
          shadowMode: input.shadowMode
        };
  const riskTradingEnabled =
    input.cachedConfig.TRADING_ENABLED &&
    (input.payload.resetPaperPortfolio === true ||
      input.currentState.riskMetrics.rollingDrawdownPct <= input.cachedConfig.MAX_DRAWDOWN_PCT);
  const nextBankroll =
    input.payload.resetPaperPortfolio === true
      ? {
          ...input.currentState.bankroll,
          cash: input.paperBankroll,
          equity: input.paperBankroll,
          realizedPnl: 0,
          updatedAt: input.observedAt
        }
      : input.currentState.bankroll;
  const nextOpenPositions =
    input.payload.resetPaperPortfolio === true ? {} : input.currentState.openPositions;
  const nextInventory =
    input.payload.resetPaperPortfolio === true
      ? {
          ...defaultInventoryState(
            input.cachedConfig.MAX_INVENTORY_UNITS,
            input.cachedConfig.MAX_INVENTORY_DELTA
          ),
          updatedAt: input.observedAt
        }
      : input.currentState.inventory;
  const nextRiskMetrics = {
    ...(input.payload.resetPaperPortfolio === true
      ? defaultRiskMetrics(nextBankroll.equity, input.observedAt)
      : input.currentState.riskMetrics),
    isTradingEnabled: riskTradingEnabled,
    updatedAt: input.observedAt
  };
  const nextRisk = {
    ...input.currentState.risk,
    killSwitch: !riskTradingEnabled,
    maxDrawdownPct: input.cachedConfig.MAX_DRAWDOWN_PCT,
    updatedAt: input.observedAt
  };
  const sharedTelemetry = {
    reason: input.reason,
    resetInstruments: [...input.resetInstruments],
    source_exchange: input.sourceExchange,
    clearCitadel: input.payload.clearCitadel !== false,
    clearQuoteState: input.payload.clearQuoteState !== false,
    clearLatency: input.payload.clearLatency !== false,
    resetPaperPortfolio: input.payload.resetPaperPortfolio === true,
    clearShadowQueue: shouldClearShadowQueue,
    tradingEnabled: input.cachedConfig.TRADING_ENABLED,
    observedAt: input.observedAt
  };

  return {
    shouldClearShadowQueue,
    state: {
      ...input.currentState,
      bankroll: nextBankroll,
      openPositions: nextOpenPositions,
      inventory: nextInventory,
      current_inventory_delta: nextInventory.current_inventory_delta,
      staleTickCount: 0,
      quoteState: nextQuoteState,
      assetQuoteStates: nextAssetQuoteStates,
      shadowQueue: input.shadowQueue,
      citadel: nextCitadel,
      riskMetrics: nextRiskMetrics,
      risk: nextRisk,
      executionProfile: {
        ...input.currentState.executionProfile,
        status: "STABLE",
        updatedAt: input.observedAt
      },
      heartbeatAt: input.observedAt,
      updatedAt: input.observedAt
    },
    logMetadata: {
      ...sharedTelemetry,
      prunedProfilerStorageKeys: [...input.prunedProfilerStorageKeys]
    },
    publishPayload: {
      ...sharedTelemetry,
      prunedProfilerStorageKeyCount: input.prunedProfilerStorageKeys.length
    }
  };
}

export function adminRecoveryStorageEntries(
  input: AdminRecoveryStorageInput
): Record<string, unknown> {
  return {
    [input.engineStateKey]: input.state,
    [input.performanceHistoryKey]: input.latencyHistory,
    [input.processingLatencySamplesKey]: input.processingLatencySamples
  };
}

export function adminRecoveryResponse(input: AdminRecoveryResponseInput): JsonRecord {
  return {
    ok: true,
    reason: input.reason,
    resetInstruments: [...input.resetInstruments],
    source_exchange: input.sourceExchange,
    state: input.state as unknown as JsonRecord
  };
}

export function adminRecoveryCompletionArtifacts(
  input: AdminRecoveryCompletionArtifactsInput
): AdminRecoveryCompletionArtifacts {
  return {
    storageEntries: adminRecoveryStorageEntries({
      engineStateKey: input.engineStateKey,
      state: input.recovery.state,
      performanceHistoryKey: input.performanceHistoryKey,
      latencyHistory: input.latencyHistory,
      processingLatencySamplesKey: input.processingLatencySamplesKey,
      processingLatencySamples: input.processingLatencySamples
    }),
    paperSessionStartedAt: input.plan.shouldResetPaperPortfolio ? input.plan.observedAt : null,
    logMetadata: input.recovery.logMetadata,
    publishPayload: input.recovery.publishPayload,
    response: adminRecoveryResponse({
      reason: input.plan.reason,
      resetInstruments: input.plan.resetInstruments,
      sourceExchange: input.plan.sourceExchange,
      state: input.recovery.state
    })
  };
}

export function adminRecoveryRuntimeArtifacts(
  input: AdminRecoveryRuntimeArtifactsInput
): AdminRecoveryRuntimeArtifacts {
  const recovery = stateAfterAdminControlledRecovery({
    currentState: input.currentState,
    payload: input.payload,
    cachedConfig: input.cachedConfig,
    macroBias: input.macroBias,
    observedAt: input.plan.observedAt,
    shadowMode: input.shadowMode,
    paperBankroll: input.paperBankroll,
    shadowQueue: input.shadowQueue,
    reason: input.plan.reason,
    resetInstruments: input.plan.resetInstruments,
    sourceExchange: input.plan.sourceExchange,
    prunedProfilerStorageKeys: input.prunedProfilerStorageKeys
  });

  return {
    recovery,
    completion: adminRecoveryCompletionArtifacts({
      plan: input.plan,
      recovery,
      engineStateKey: input.engineStateKey,
      performanceHistoryKey: input.performanceHistoryKey,
      latencyHistory: input.latencyHistory,
      processingLatencySamplesKey: input.processingLatencySamplesKey,
      processingLatencySamples: input.processingLatencySamples
    })
  };
}
