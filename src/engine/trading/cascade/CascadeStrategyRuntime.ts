import {
  cascadeCloseOperationalAlert,
  type CascadeCloseOperationalAlert
} from "../telemetry/CascadeSignalTelemetryRuntime";
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
import type { GlobalRiskConfig, MarketTick } from "../../../types";
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
