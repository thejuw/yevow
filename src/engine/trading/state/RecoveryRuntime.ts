import type {
  EngineState,
  Env,
  GlobalRiskConfig,
  JsonRecord,
  MacroBias,
  OrderBookResetRequest,
  ShadowQueueState
} from "../../../types";
import {
  DEFAULT_PAPER_BANKROLL_USD,
  ENGINE_STATE_KEY,
  PAPER_SESSION_STARTED_AT_KEY,
  PERFORMANCE_HISTORY_KEY,
  PROCESSING_LATENCY_SAMPLES_KEY
} from "../../../TradingEngineConstants";
import { isShadowMode } from "../../../utils/CitadelProtocol";
import { readPositiveNumber } from "../helpers/RuntimeParsing";
import { aggregateQuoteState, defaultAssetQuoteStates } from "./AssetStateRuntime";
import {
  defaultCitadelState,
  defaultInventoryState,
  defaultRiskMetrics
} from "./EngineStateDefaults";
import { putTradingStorageForTargetOrHandler } from "./StorageWriteGuard";
import {
  deleteRetiredProfilerStorageForTarget,
  type TradingRetiredProfilerStorageTarget
} from "./ProfilerStorageRuntime";
import {
  resetTradingLatencyBaselineForTarget,
  type TradingLatencyStateTarget
} from "../performance/TradingLatencyStateRuntime";
import {
  resetTradingOrderBookForTarget,
  type TradingOrderBookResetTarget
} from "../book/OrderBookResetRuntime";
import { adminRecoveryPlan, applyAdminRecoveryPlanSideEffects } from "./RecoveryPlanRuntime";
import type {
  AdminRecoveryPlan,
  AdminRecoveryPlanSideEffectHandlers,
  AdminRecoveryRuntimePayload
} from "./RecoveryPlanRuntime";

export {
  adminRecoveryPlan,
  applyAdminRecoveryPlanSideEffects,
  dispatchAdminRecoveryOrderBookResets
} from "./RecoveryPlanRuntime";
export type {
  AdminRecoveryOrderBookResetDispatcherInput,
  AdminRecoveryPlan,
  AdminRecoveryPlanSideEffectHandlers,
  AdminRecoveryRuntimePayload
} from "./RecoveryPlanRuntime";

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

export interface AdminRecoveryFlowInput extends Omit<
  AdminRecoveryRuntimeArtifactsInput,
  "plan" | "prunedProfilerStorageKeys" | "shadowQueue"
> {
  readonly payload: AdminRecoveryRuntimePayload;
}

export interface TradingAdminRecoveryFlowInput {
  readonly currentState: EngineState;
  readonly payload: AdminRecoveryRuntimePayload;
  readonly cachedConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly shadowMode: boolean;
  readonly paperBankrollUsd?: string;
  readonly latencyHistory: readonly unknown[];
  readonly processingLatencySamples: readonly number[];
}

export interface TradingAdminRecoveryTarget {
  engineState: EngineState;
  readonly cachedConfig: GlobalRiskConfig;
  readonly macroBias: MacroBias;
  readonly env: Pick<Env, "CONFIG_STORE" | "PAPER_BANKROLL_USD" | "SHADOW_MODE">;
  readonly latencyHistory: readonly unknown[];
  readonly processingLatencySamples: readonly number[];
  readonly ghostBook: {
    reset(): void;
    snapshot(observedAt: string): ShadowQueueState;
  };
  readonly shadowQueueNoEdgeLogAt: {
    clear(): void;
  };
  readonly state: {
    waitUntil(work: Promise<unknown>): void;
  };
  readonly logger: {
    warn(eventType: string, message: string, metadata: JsonRecord): void;
  };
  resetOrderBook?(payload: Partial<OrderBookResetRequest>): Promise<void>;
  resetLatencyBaseline?(observedAt: string, reason: string): void;
  safeStoragePut?(entries: Record<string, unknown>, reason: string): Promise<void>;
  publish(type: string, payload: Record<string, unknown>, correlationId?: string): void;
}

export interface AdminRecoveryCompletionSideEffectHandlers {
  readonly persistStorageEntries: (entries: Record<string, unknown>) => Promise<void>;
  readonly putPaperSessionStartedAt: (observedAt: string) => void;
  readonly logRecovery: (metadata: JsonRecord) => void;
  readonly publishRecovery: (payload: JsonRecord) => void;
}

export interface AdminRecoveryFlowHandlers
  extends AdminRecoveryPlanSideEffectHandlers, AdminRecoveryCompletionSideEffectHandlers {
  readonly deleteRetiredProfilerStorage: () => Promise<string[]>;
  readonly shadowQueueSnapshot: (observedAt: string) => ShadowQueueState;
  readonly applyState: (state: EngineState) => void;
}

export function resolveAdminRecoveryPaperBankroll(envValue?: string): number {
  return readPositiveNumber(envValue, DEFAULT_PAPER_BANKROLL_USD);
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

export async function applyAdminRecoveryCompletionSideEffects(
  completion: AdminRecoveryCompletionArtifacts,
  handlers: AdminRecoveryCompletionSideEffectHandlers
): Promise<void> {
  await handlers.persistStorageEntries(completion.storageEntries);

  if (completion.paperSessionStartedAt) {
    handlers.putPaperSessionStartedAt(completion.paperSessionStartedAt);
  }

  handlers.logRecovery(completion.logMetadata);
  handlers.publishRecovery(completion.publishPayload);
}

export async function applyAdminRecoveryFlow(
  input: AdminRecoveryFlowInput,
  handlers: AdminRecoveryFlowHandlers
): Promise<JsonRecord> {
  const plan = adminRecoveryPlan(input.payload);

  await applyAdminRecoveryPlanSideEffects(plan, handlers);

  const prunedProfilerStorageKeys = await handlers.deleteRetiredProfilerStorage();
  const artifacts = adminRecoveryRuntimeArtifacts({
    ...input,
    plan,
    shadowQueue: handlers.shadowQueueSnapshot(plan.observedAt),
    prunedProfilerStorageKeys
  });
  handlers.applyState(artifacts.recovery.state);

  await applyAdminRecoveryCompletionSideEffects(artifacts.completion, handlers);

  return artifacts.completion.response;
}

export function applyTradingAdminRecoveryFlow(
  input: TradingAdminRecoveryFlowInput,
  handlers: AdminRecoveryFlowHandlers
): Promise<JsonRecord> {
  return applyAdminRecoveryFlow(
    {
      currentState: input.currentState,
      payload: input.payload,
      cachedConfig: input.cachedConfig,
      macroBias: input.macroBias,
      shadowMode: input.shadowMode,
      paperBankroll: resolveAdminRecoveryPaperBankroll(input.paperBankrollUsd),
      engineStateKey: ENGINE_STATE_KEY,
      performanceHistoryKey: PERFORMANCE_HISTORY_KEY,
      latencyHistory: input.latencyHistory,
      processingLatencySamplesKey: PROCESSING_LATENCY_SAMPLES_KEY,
      processingLatencySamples: input.processingLatencySamples
    },
    handlers
  );
}

export async function recoverTradingEngineStateForTarget(
  payload: AdminRecoveryRuntimePayload,
  target: TradingAdminRecoveryTarget
): Promise<JsonRecord> {
  return applyTradingAdminRecoveryFlow(
    {
      currentState: target.engineState,
      payload,
      cachedConfig: target.cachedConfig,
      macroBias: target.macroBias,
      shadowMode: isShadowMode(target.env),
      paperBankrollUsd: target.env.PAPER_BANKROLL_USD,
      latencyHistory: target.latencyHistory,
      processingLatencySamples: target.processingLatencySamples
    },
    {
      resetOrderBook: (resetPayload) =>
        target.resetOrderBook
          ? target.resetOrderBook(resetPayload)
          : resetTradingOrderBookForTarget(
              resetPayload,
              target as unknown as TradingOrderBookResetTarget
            ).then(() => undefined),
      resetLatencyBaseline: (observedAt, reason) => {
        if (target.resetLatencyBaseline) {
          target.resetLatencyBaseline(observedAt, reason);
          return;
        }
        resetTradingLatencyBaselineForTarget(
          observedAt,
          reason,
          target as unknown as TradingLatencyStateTarget
        );
      },
      clearShadowQueue: () => {
        target.ghostBook.reset();
        target.shadowQueueNoEdgeLogAt.clear();
      },
      deleteRetiredProfilerStorage: () =>
        deleteRetiredProfilerStorageForTarget(
          target as unknown as TradingRetiredProfilerStorageTarget
        ),
      shadowQueueSnapshot: (observedAt) => target.ghostBook.snapshot(observedAt),
      applyState: (state) => {
        target.engineState = state;
      },
      persistStorageEntries: (entries) =>
        putTradingStorageForTargetOrHandler(target, entries, "ADMIN_CONTROLLED_RECOVERY"),
      putPaperSessionStartedAt: (observedAt) => {
        target.state.waitUntil(
          target.env.CONFIG_STORE.put(PAPER_SESSION_STARTED_AT_KEY, observedAt)
        );
      },
      logRecovery: (metadata) => {
        target.logger.warn("ADMIN_CONTROLLED_RECOVERY", "Admin controlled recovery applied", {
          ...metadata
        });
      },
      publishRecovery: (publishPayload) => {
        target.publish("ADMIN_CONTROLLED_RECOVERY", publishPayload);
      }
    }
  );
}
