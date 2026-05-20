import type {
  EngineState,
  GlobalRiskConfig,
  JsonRecord,
  MacroBias,
  ShadowQueueState
} from "../../../types";
import {
  aggregateQuoteState,
  defaultAssetQuoteStates,
  defaultCitadelState,
  defaultInventoryState,
  defaultRiskMetrics
} from "../helpers/RuntimeHelpers";

export interface AdminRecoveryRuntimePayload {
  readonly clearCitadel?: boolean;
  readonly clearQuoteState?: boolean;
  readonly clearLatency?: boolean;
  readonly resetPaperPortfolio?: boolean;
  readonly clearShadowQueue?: boolean;
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
