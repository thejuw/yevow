import {
  cascadeCloseOperationalAlert,
  type CascadeCloseOperationalAlert
} from "../telemetry/CascadeSignalTelemetryRuntime";
import {
  emitTradingCascadeOperationalAlertForTarget,
  recordTradingCascadeUiSignalForTarget,
  type TradingSignalBusTarget
} from "../telemetry/TradingSignalBusRuntime";
import { CascadeRecoverySignalEngine } from "../../../strategy/cascade/CascadeRecoverySignal";
import { calculateAtr } from "../../../strategy/cascade/indicators/ATR";
import { cumulativeVolumeDelta } from "../../../strategy/cascade/indicators/CumulativeVolumeDelta";
import { calculateVwap } from "../../../strategy/cascade/indicators/VWAP";
import type { CascadeAlertEventType } from "../../../strategy/cascade/OperationalSafeguards";
import type {
  AbsorptionConfirmed,
  Candle,
  CascadeEvent,
  CascadeOpenPosition,
  CascadePositionIntent,
  CascadeRecoverySignal,
  CascadeRecoverySignalRejection,
  CascadeRecoverySignalResult,
  PositionSizeDecision,
  PositionManagerUpdate
} from "../../../strategy/cascade/types";
import { CASCADE_POSITIONS_KEY } from "../../../TradingEngineConstants";
import type {
  AgentDecisionTrace,
  AgentSignal,
  EngineState,
  Env,
  GlobalRiskConfig,
  JsonRecord,
  MarketRegime,
  MarketTick,
  TradeIntent
} from "../../../types";
import { baseAssetFromInstrument } from "../helpers/NativeMarketIdentityRuntime";
import {
  cascadeAssetProfileFromConfig,
  cascadeRecoverySignalConfig,
  resolveCascadeAtr1h
} from "./CascadeConfigRuntime";
import {
  buildCascadeEntryTradeIntentForTarget,
  buildCascadeExitTradeIntentForTarget
} from "./CascadeTradeIntents";
import {
  isCascadeInstrumentEnabledForConfig,
  latestAbsorptionForInstrument,
  latestCascadeAtForInstrument,
  recentSwingHigh,
  recentSwingLow
} from "./CascadeSelectionRuntime";
import {
  applyCascadeSignalRejectionSideEffects,
  processAcceptedCascadeSignalFlow,
  type CascadeAcceptedSignalFlowResult
} from "./CascadeSignalEntryRuntime";
export {
  applyCascadeOpenPositionSideEffects,
  applyCascadeSignalRejectionSideEffects,
  applyCascadeSizeRejectionSideEffects,
  processAcceptedCascadeSignalFlow,
  type CascadeAcceptedSignalFlowHandlers,
  type CascadeAcceptedSignalFlowInput,
  type CascadeAcceptedSignalFlowResult,
  type CascadeOpenPositionSideEffectHandlers,
  type CascadeOpenPositionSideEffectInput,
  type CascadeSignalRejectionSideEffectHandlers,
  type CascadeSignalRejectionSideEffectInput,
  type CascadeSizeRejectionSideEffectHandlers,
  type CascadeSizeRejectionSideEffectInput
} from "./CascadeSignalEntryRuntime";

export type CascadePositionUpdateAlert = CascadeCloseOperationalAlert;

export interface CascadePositionUpdateSideEffectHandlers {
  readonly dispatchCloseIntent: (intent: CascadePositionIntent) => void;
  readonly emitOperationalAlert: (alert: CascadePositionUpdateAlert) => void;
  readonly persistPositions: () => void;
}

export interface TradingCascadePositionUpdateTarget {
  readonly cachedConfig: GlobalRiskConfig;
  readonly engineState: Pick<EngineState, "engineId">;
  readonly cascadePositionManager: {
    onTick(input: {
      readonly instrumentCode: string;
      readonly price: number;
      readonly observedAt: string;
      readonly atr: number | null;
    }): readonly PositionManagerUpdate[];
    snapshot(): readonly CascadeOpenPosition[];
  };
  readonly candleAggregator: {
    snapshot(instrumentCode: string, timeframe: "1m", limit: number): Candle[];
  };
  readonly state: {
    waitUntil(work: Promise<void>): void;
  };
  dispatchExecution(intent: TradeIntent): Promise<void>;
  emitCascadeOperationalAlert?(
    eventType: CascadeAlertEventType,
    title: string,
    message: string,
    metadata: JsonRecord,
    dedupeKey: string
  ): void;
  safeStoragePut(key: string, value: unknown, reason: string): Promise<void>;
}

export interface CascadeClosedCandleSignalHandlers {
  readonly latestAbsorptionForInstrument: (instrumentCode: string) => AbsorptionConfirmed | null;
  readonly cascadeForAbsorption: (absorption: AbsorptionConfirmed) => CascadeEvent | null;
  readonly evaluateSignal: (
    cascade: CascadeEvent,
    absorption: AbsorptionConfirmed,
    reclaimCandle: Candle,
    observedAt: string
  ) => CascadeRecoverySignalResult;
  readonly recordRejectedSignal: (
    rejection: CascadeRecoverySignalRejection,
    observedAt: string
  ) => void;
  readonly processAcceptedSignal: (
    signal: CascadeRecoverySignal,
    observedAt: string
  ) => Promise<void>;
}

export interface CascadeStrategyEvaluationInput {
  readonly strategyMode: GlobalRiskConfig["STRATEGY_MODE"];
  readonly tick: MarketTick;
  readonly observedAt: string;
}

export interface CascadeStrategyEvaluationHandlers extends CascadeClosedCandleSignalHandlers {
  readonly ingestTick: (tick: MarketTick) => readonly Candle[];
  readonly dispatchPositionUpdates: (tick: MarketTick, observedAt: string) => Promise<void>;
  readonly isInstrumentEnabled: (instrumentCode: string) => boolean;
  readonly refreshNewsCalendar: () => Promise<void>;
}

export interface CascadeStrategyEvaluationResult {
  readonly evaluated: boolean;
  readonly closedCandles: readonly Candle[];
  readonly reason: "STRATEGY_DISABLED" | "INSTRUMENT_DISABLED" | "EVALUATED";
}

export interface TradingCascadeRecoverySignalEvaluationInput {
  readonly cascade: CascadeEvent;
  readonly absorption: AbsorptionConfirmed;
  readonly reclaimCandle: Candle;
  readonly observedAt: string;
  readonly config: GlobalRiskConfig;
  readonly midPrice: number | null;
  readonly oracleRegime: MarketRegime | "UNKNOWN";
  readonly riskTradingEnabled: boolean;
  readonly cascadeEventsById: ReadonlyMap<string, CascadeEvent>;
  readonly env: Pick<Env, "CASCADE_ATR_FALLBACK_USD" | "CASCADE_ATR_FALLBACK_PCT">;
}

export interface TradingCascadeRecoverySignalEvaluationHandlers {
  readonly snapshotCandles: (instrumentCode: string, timeframe: "1m", limit: number) => Candle[];
  readonly isWithinBlackout: (observedAt: Date, baseAsset: string) => { readonly blocked: boolean };
}

export interface TradingCascadeRecoverySignalTarget {
  readonly cachedConfig: GlobalRiskConfig;
  readonly engineState: Pick<EngineState, "microstructure" | "oracle" | "riskMetrics">;
  readonly cascadeEventsById: ReadonlyMap<string, CascadeEvent>;
  readonly env: Pick<Env, "CASCADE_ATR_FALLBACK_USD" | "CASCADE_ATR_FALLBACK_PCT">;
  readonly candleAggregator: {
    snapshot(instrumentCode: string, timeframe: "1m", limit: number): Candle[];
  };
  readonly cascadeNewsCalendar: {
    isWithinBlackout(observedAt: Date, baseAsset: string): { readonly blocked: boolean };
  };
}

export interface TradingAcceptedCascadeSignalTarget {
  readonly cachedConfig: GlobalRiskConfig;
  readonly engineState: Pick<EngineState, "engineId" | "bankroll">;
  readonly cascadePositionManager: {
    snapshot(): readonly CascadeOpenPosition[];
    registerFromSignal(
      signal: CascadeRecoverySignal,
      sizeDecision: PositionSizeDecision,
      observedAt: string
    ): CascadeOpenPosition;
  };
  readonly cascadeHeatManager: {
    currentHeat(positions: readonly CascadeOpenPosition[]): number;
  };
  readonly state: {
    waitUntil(work: Promise<void>): void;
  };
  readonly logger: {
    traceDecision(decision: AgentDecisionTrace): void;
    warn(eventType: string, message: string, telemetry?: JsonRecord): void;
  };
  recordCascadeUiSignal?(signal: AgentSignal, outcome: "TAKEN" | "SKIPPED" | "CLOSED"): void;
  dispatchExecution(intent: TradeIntent): Promise<void>;
  safeStoragePut(key: string, value: unknown, reason: string): Promise<void>;
  emitCascadeOperationalAlert?(
    eventType: CascadeAlertEventType,
    title: string,
    message: string,
    metadata: JsonRecord,
    dedupeKey: string
  ): void;
}

export interface TradingCascadeStrategyTarget {
  readonly cachedConfig: GlobalRiskConfig;
  readonly engineState: Pick<
    EngineState,
    "engineId" | "bankroll" | "microstructure" | "oracle" | "riskMetrics"
  >;
  readonly cascadePositionManager: {
    onTick(input: {
      readonly instrumentCode: string;
      readonly price: number;
      readonly observedAt: string;
      readonly atr: number | null;
    }): readonly PositionManagerUpdate[];
    snapshot(): readonly CascadeOpenPosition[];
    registerFromSignal(
      signal: CascadeRecoverySignal,
      sizeDecision: PositionSizeDecision,
      observedAt: string
    ): CascadeOpenPosition;
  };
  readonly cascadeHeatManager: TradingAcceptedCascadeSignalTarget["cascadeHeatManager"];
  readonly logger: TradingAcceptedCascadeSignalTarget["logger"] & {
    info(eventType: string, message: string, telemetry?: JsonRecord): void;
  };
  readonly candleAggregator: TradingCascadePositionUpdateTarget["candleAggregator"] & {
    ingestTick(tick: MarketTick): readonly Candle[];
  };
  readonly cascadeNewsCalendar: TradingCascadeRecoverySignalTarget["cascadeNewsCalendar"] & {
    refresh(): Promise<void>;
  };
  readonly state: TradingAcceptedCascadeSignalTarget["state"];
  readonly cascadeAbsorptionsById: ReadonlyMap<string, AbsorptionConfirmed>;
  readonly cascadeEventsById: ReadonlyMap<string, CascadeEvent>;
  readonly env: Pick<Env, "CASCADE_ATR_FALLBACK_USD" | "CASCADE_ATR_FALLBACK_PCT">;
  recordCascadeUiSignal?(signal: AgentSignal, outcome: "TAKEN" | "SKIPPED" | "CLOSED"): void;
  dispatchExecution(intent: TradeIntent): Promise<void>;
  safeStoragePut(key: string, value: unknown, reason: string): Promise<void>;
  emitCascadeOperationalAlert?(
    eventType: CascadeAlertEventType,
    title: string,
    message: string,
    metadata: JsonRecord,
    dedupeKey: string
  ): void;
}

export function shouldEvaluateCascadeStrategy(
  strategyMode: GlobalRiskConfig["STRATEGY_MODE"]
): boolean {
  return strategyMode !== "OFF" && strategyMode !== "MARKET_MAKING";
}

export function closedOneMinuteCandlesForTick(
  candles: readonly Candle[],
  tick: Pick<MarketTick, "instrumentCode">
): Candle[] {
  const instrumentCode = tick.instrumentCode.toLowerCase();

  return candles.filter(
    (candle) => candle.timeframe === "1m" && candle.instrumentCode.toLowerCase() === instrumentCode
  );
}

export function applyCascadePositionUpdateSideEffects(
  updates: readonly PositionManagerUpdate[],
  observedAt: string,
  handlers: CascadePositionUpdateSideEffectHandlers
): void {
  for (const update of updates) {
    for (const intent of update.intents) {
      if (intent.kind !== "CLOSE" || intent.size <= 0) {
        continue;
      }

      handlers.dispatchCloseIntent(intent);
      const closeAlert = cascadeCloseOperationalAlert(intent, observedAt);
      if (closeAlert) {
        handlers.emitOperationalAlert(closeAlert);
      }
    }
  }

  if (updates.length > 0) {
    handlers.persistPositions();
  }
}

export function dispatchTradingCascadePositionUpdates(
  tick: MarketTick,
  observedAt: string,
  target: TradingCascadePositionUpdateTarget
): Promise<void> {
  const updates = target.cascadePositionManager.onTick({
    instrumentCode: tick.instrumentCode,
    price: tick.price,
    observedAt,
    atr: calculateAtr(target.candleAggregator.snapshot(tick.instrumentCode, "1m", 32), 14)
  });

  applyCascadePositionUpdateSideEffects(updates, observedAt, {
    dispatchCloseIntent: (intent) => {
      target.state.waitUntil(
        target.dispatchExecution(buildCascadeExitTradeIntentForTarget(target, intent, observedAt))
      );
    },
    emitOperationalAlert: (alert) => {
      emitCascadeOperationalAlertForTarget(
        target,
        alert.eventType,
        alert.title,
        alert.message,
        alert.metadata,
        alert.dedupeKey
      );
    },
    persistPositions: () => {
      target.state.waitUntil(
        target.safeStoragePut(
          CASCADE_POSITIONS_KEY,
          target.cascadePositionManager.snapshot(),
          "CASCADE_POSITION_UPDATE"
        )
      );
    }
  });

  return Promise.resolve();
}

export async function processCascadeClosedCandleSignals(
  closedCandles: readonly Candle[],
  tick: Pick<MarketTick, "instrumentCode">,
  observedAt: string,
  handlers: CascadeClosedCandleSignalHandlers
): Promise<void> {
  const closed1m = closedOneMinuteCandlesForTick(closedCandles, tick);
  if (closed1m.length === 0) {
    return;
  }

  for (const reclaimCandle of closed1m) {
    const absorption = handlers.latestAbsorptionForInstrument(reclaimCandle.instrumentCode);
    if (!absorption) {
      continue;
    }

    const cascade = handlers.cascadeForAbsorption(absorption);
    if (!cascade) {
      continue;
    }

    const signalResult = handlers.evaluateSignal(cascade, absorption, reclaimCandle, observedAt);
    if (!signalResult.accepted) {
      handlers.recordRejectedSignal(signalResult.rejection, observedAt);
      continue;
    }

    await handlers.processAcceptedSignal(signalResult.signal, observedAt);
  }
}

export async function evaluateCascadeStrategyFlow(
  input: CascadeStrategyEvaluationInput,
  handlers: CascadeStrategyEvaluationHandlers
): Promise<CascadeStrategyEvaluationResult> {
  if (!shouldEvaluateCascadeStrategy(input.strategyMode)) {
    return {
      evaluated: false,
      closedCandles: [],
      reason: "STRATEGY_DISABLED"
    };
  }

  const closedCandles = handlers.ingestTick(input.tick);
  await handlers.dispatchPositionUpdates(input.tick, input.observedAt);

  if (!handlers.isInstrumentEnabled(input.tick.instrumentCode)) {
    return {
      evaluated: false,
      closedCandles,
      reason: "INSTRUMENT_DISABLED"
    };
  }

  await handlers.refreshNewsCalendar();
  await processCascadeClosedCandleSignals(closedCandles, input.tick, input.observedAt, handlers);

  return {
    evaluated: true,
    closedCandles,
    reason: "EVALUATED"
  };
}

export function recordTradingRejectedCascadeSignal(
  rejection: CascadeRecoverySignalRejection,
  observedAt: string,
  target: TradingCascadeStrategyTarget
): void {
  applyCascadeSignalRejectionSideEffects(
    {
      rejection,
      engineId: target.engineState.engineId,
      observedAt,
      entryWindowMs: target.cachedConfig.ENTRY_WINDOW_SECONDS * 1_000
    },
    {
      logInfo: (event, message, metadata) => {
        target.logger.info(event, message, metadata);
      },
      recordUiSignal: (signal, outcome) => {
        recordCascadeUiSignalForTarget(target, signal, outcome);
      }
    }
  );
}

export function evaluateTradingCascadeStrategy(
  tick: MarketTick,
  observedAt: string,
  target: TradingCascadeStrategyTarget
): Promise<CascadeStrategyEvaluationResult> {
  return evaluateCascadeStrategyFlow(
    {
      strategyMode: target.cachedConfig.STRATEGY_MODE,
      tick,
      observedAt
    },
    {
      ingestTick: (currentTick) => target.candleAggregator.ingestTick(currentTick),
      dispatchPositionUpdates: (currentTick, updateObservedAt) =>
        dispatchTradingCascadePositionUpdates(currentTick, updateObservedAt, target),
      isInstrumentEnabled: (instrumentCode) =>
        isCascadeInstrumentEnabledForConfig(
          target.cachedConfig.CASCADE_INSTRUMENTS,
          instrumentCode
        ),
      refreshNewsCalendar: async () => {
        await target.cascadeNewsCalendar.refresh();
      },
      latestAbsorptionForInstrument: (instrumentCode) =>
        latestAbsorptionForInstrument(target.cascadeAbsorptionsById, instrumentCode),
      cascadeForAbsorption: (absorption) =>
        target.cascadeEventsById.get(absorption.cascadeId) ?? null,
      evaluateSignal: (cascade, absorption, reclaimCandle, signalObservedAt) =>
        evaluateTradingEngineCascadeRecoverySignal(
          cascade,
          absorption,
          reclaimCandle,
          signalObservedAt,
          target
        ),
      recordRejectedSignal: (rejection, rejectedAt) => {
        recordTradingRejectedCascadeSignal(rejection, rejectedAt, target);
      },
      processAcceptedSignal: (signal, acceptedAt) =>
        processTradingAcceptedCascadeSignal(signal, acceptedAt, target).then(() => undefined)
    }
  );
}

export function evaluateTradingCascadeRecoverySignal(
  input: TradingCascadeRecoverySignalEvaluationInput,
  handlers: TradingCascadeRecoverySignalEvaluationHandlers
): CascadeRecoverySignalResult {
  const recent1mCandles = handlers.snapshotCandles(input.reclaimCandle.instrumentCode, "1m", 64);
  const latestRawEvent = input.cascade.rawEvents.at(-1) ?? null;
  const blackout = handlers.isWithinBlackout(
    new Date(input.observedAt),
    baseAssetFromInstrument(input.reclaimCandle.instrumentCode)
  );
  const engine = new CascadeRecoverySignalEngine(cascadeRecoverySignalConfig(input.config));

  return engine.evaluate({
    cascade: input.cascade,
    absorption: input.absorption,
    reclaimCandle: input.reclaimCandle,
    recent1mCandles,
    atr1m: calculateAtr(recent1mCandles, 14),
    atr1h: latestRawEvent
      ? resolveCascadeAtr1h({
          event: latestRawEvent,
          midPrice: input.midPrice,
          fallbackUsdValue: input.env.CASCADE_ATR_FALLBACK_USD,
          fallbackPctValue: input.env.CASCADE_ATR_FALLBACK_PCT
        })
      : null,
    preCascadeSwingLow: recentSwingLow(recent1mCandles),
    preCascadeSwingHigh: recentSwingHigh(recent1mCandles),
    cascadeVwap: calculateVwap(recent1mCandles),
    cvd1m: cumulativeVolumeDelta(recent1mCandles),
    openInterestDelta: 0,
    oracleRegime: input.oracleRegime,
    recentSecondCascadeAt: latestCascadeAtForInstrument(input.cascadeEventsById, input.cascade),
    majorNewsWithinBlackout: blackout.blocked,
    realizedVolPercentile1h: 0.5,
    dailyLossLimitBreached: !input.riskTradingEnabled,
    weeklyLossLimitBreached: false,
    observedAt: input.observedAt
  });
}

export function evaluateTradingEngineCascadeRecoverySignal(
  cascade: CascadeEvent,
  absorption: AbsorptionConfirmed,
  reclaimCandle: Candle,
  observedAt: string,
  target: TradingCascadeRecoverySignalTarget
): CascadeRecoverySignalResult {
  return evaluateTradingCascadeRecoverySignal(
    {
      cascade,
      absorption,
      reclaimCandle,
      observedAt,
      config: target.cachedConfig,
      midPrice: target.engineState.microstructure.midPrice,
      oracleRegime: target.engineState.oracle.regime ?? "UNKNOWN",
      riskTradingEnabled: target.engineState.riskMetrics.isTradingEnabled,
      cascadeEventsById: target.cascadeEventsById,
      env: target.env
    },
    {
      snapshotCandles: (instrumentCode, timeframe, limit) =>
        target.candleAggregator.snapshot(instrumentCode, timeframe, limit),
      isWithinBlackout: (blackoutObservedAt, baseAsset) =>
        target.cascadeNewsCalendar.isWithinBlackout(blackoutObservedAt, baseAsset)
    }
  );
}

export function processTradingAcceptedCascadeSignal(
  signal: CascadeRecoverySignal,
  observedAt: string,
  target: TradingAcceptedCascadeSignalTarget
): Promise<CascadeAcceptedSignalFlowResult> {
  const currentHeat = target.cascadeHeatManager.currentHeat(
    target.cascadePositionManager.snapshot()
  );
  const result = processAcceptedCascadeSignalFlow(
    {
      signal,
      observedAt,
      engineId: target.engineState.engineId,
      equity: target.engineState.bankroll.equity,
      riskPerTradePct: target.cachedConfig.RISK_PER_TRADE_PCT,
      assetProfile: cascadeAssetProfileFromConfig(signal.instrumentCode, target.cachedConfig),
      currentHeat,
      heatCapPct: target.cachedConfig.HEAT_CAP_PCT
    },
    {
      emitOperationalAlert: (eventType, title, message, metadata, dedupeKey) => {
        emitCascadeOperationalAlertForTarget(
          target,
          eventType,
          title,
          message,
          metadata,
          dedupeKey
        );
      },
      registerPosition: (acceptedSignal, sizeDecision, acceptedAt) =>
        target.cascadePositionManager.registerFromSignal(acceptedSignal, sizeDecision, acceptedAt),
      buildEntryIntent: (acceptedSignal, size, acceptedAt) =>
        buildCascadeEntryTradeIntentForTarget(target, acceptedSignal, size, acceptedAt),
      recordUiSignal: (agentSignal, outcome) => {
        recordCascadeUiSignalForTarget(target, agentSignal, outcome);
      },
      traceDecision: (decision) => {
        target.logger.traceDecision(decision);
      },
      schedule: (work) => {
        target.state.waitUntil(work);
      },
      dispatchExecution: (tradeIntent) => target.dispatchExecution(tradeIntent),
      persistPositions: () =>
        target.safeStoragePut(
          CASCADE_POSITIONS_KEY,
          target.cascadePositionManager.snapshot(),
          "CASCADE_POSITION_OPENED"
        ),
      logWarn: (event, message, metadata) => {
        target.logger.warn(event, message, metadata);
      }
    }
  );

  return Promise.resolve(result);
}

function emitCascadeOperationalAlertForTarget(
  target:
    | TradingCascadePositionUpdateTarget
    | TradingAcceptedCascadeSignalTarget
    | TradingCascadeStrategyTarget,
  eventType: CascadeAlertEventType,
  title: string,
  message: string,
  metadata: JsonRecord,
  dedupeKey: string
): void {
  if (target.emitCascadeOperationalAlert) {
    target.emitCascadeOperationalAlert(eventType, title, message, metadata, dedupeKey);
    return;
  }

  emitTradingCascadeOperationalAlertForTarget(
    eventType,
    title,
    message,
    metadata,
    dedupeKey,
    target as unknown as TradingSignalBusTarget
  );
}

function recordCascadeUiSignalForTarget(
  target: TradingAcceptedCascadeSignalTarget | TradingCascadeStrategyTarget,
  signal: AgentSignal,
  outcome: "TAKEN" | "SKIPPED" | "CLOSED"
): void {
  if (target.recordCascadeUiSignal) {
    target.recordCascadeUiSignal(signal, outcome);
    return;
  }

  recordTradingCascadeUiSignalForTarget(
    signal,
    outcome,
    target as unknown as TradingSignalBusTarget
  );
}
