import {
  cascadeCloseOperationalAlert,
  type CascadeCloseOperationalAlert
} from "../telemetry/CascadeSignalTelemetryRuntime";
import { CascadeRecoverySignalEngine } from "../../../strategy/cascade/CascadeRecoverySignal";
import { calculateAtr } from "../../../strategy/cascade/indicators/ATR";
import { cumulativeVolumeDelta } from "../../../strategy/cascade/indicators/CumulativeVolumeDelta";
import { calculateVwap } from "../../../strategy/cascade/indicators/VWAP";
import type {
  AbsorptionConfirmed,
  Candle,
  CascadeEvent,
  CascadePositionIntent,
  CascadeRecoverySignal,
  CascadeRecoverySignalRejection,
  CascadeRecoverySignalResult,
  PositionManagerUpdate
} from "../../../strategy/cascade/types";
import type { Env, GlobalRiskConfig, MarketRegime, MarketTick } from "../../../types";
import { baseAssetFromInstrument } from "../helpers/NativeMarketIdentityRuntime";
import { cascadeRecoverySignalConfig, resolveCascadeAtr1h } from "./CascadeConfigRuntime";
import {
  latestCascadeAtForInstrument,
  recentSwingHigh,
  recentSwingLow
} from "./CascadeSelectionRuntime";
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
