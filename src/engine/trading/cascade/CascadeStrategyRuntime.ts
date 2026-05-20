import {
  cascadeCloseOperationalAlert,
  cascadeEntryAgentSignal,
  cascadeEntryDecisionTrace,
  cascadeHeatCapAlertMetadata,
  cascadePositionOpenedAlertMetadata,
  cascadeSizeRejectedLogMetadata,
  cascadeSignalEmittedAlertMetadata,
  cascadeSignalRejectionAgentSignal,
  cascadeSignalRejectionLogMetadata,
  type CascadeCloseOperationalAlert
} from "../telemetry/CascadeSignalTelemetryRuntime";
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
import type {
  AgentDecisionTrace,
  AgentSignal,
  GlobalRiskConfig,
  JsonRecord,
  MarketTick,
  TradeIntent
} from "../../../types";
import type { CascadeAssetProfile } from "../../../strategy/cascade/AssetProfiles";
import { calculatePositionSize } from "../../../strategy/cascade/PositionSizer";
import type { CascadeAlertEventType } from "../../../strategy/cascade/OperationalSafeguards";

export type CascadePositionUpdateAlert = CascadeCloseOperationalAlert;

export interface CascadePositionUpdateSideEffectHandlers {
  readonly dispatchCloseIntent: (intent: CascadePositionIntent) => void;
  readonly emitOperationalAlert: (alert: CascadePositionUpdateAlert) => void;
  readonly persistPositions: () => void;
}

export interface CascadeOpenPositionSideEffectInput {
  readonly signal: CascadeRecoverySignal;
  readonly intent: TradeIntent;
  readonly engineId: string;
  readonly position: CascadeOpenPosition;
  readonly assetProfile: CascadeAssetProfile;
  readonly sizeDecision: PositionSizeDecision;
  readonly currentHeat: number;
  readonly observedAt: string;
}

export interface CascadeOpenPositionSideEffectHandlers {
  readonly recordUiSignal: (signal: AgentSignal, outcome: "TAKEN") => void;
  readonly traceDecision: (decision: AgentDecisionTrace) => void;
  readonly schedule: (work: Promise<void>) => void;
  readonly dispatchExecution: (intent: TradeIntent) => Promise<void>;
  readonly persistPositions: () => Promise<void>;
  readonly emitOperationalAlert: (
    eventType: "POSITION_OPENED",
    title: string,
    message: string,
    metadata: JsonRecord,
    dedupeKey: string
  ) => void;
}

export interface CascadeSignalRejectionSideEffectInput {
  readonly rejection: CascadeRecoverySignalRejection;
  readonly engineId: string;
  readonly observedAt: string;
  readonly entryWindowMs: number;
}

export interface CascadeSignalRejectionSideEffectHandlers {
  readonly logInfo: (event: string, message: string, metadata: JsonRecord) => void;
  readonly recordUiSignal: (signal: AgentSignal, outcome: "SKIPPED") => void;
}

export interface CascadeSizeRejectionSideEffectInput {
  readonly signal: CascadeRecoverySignal;
  readonly sizeDecision: PositionSizeDecision;
  readonly currentHeat: number;
  readonly heatCapPct: number;
}

export interface CascadeSizeRejectionSideEffectHandlers {
  readonly logWarn: (event: string, message: string, metadata: JsonRecord) => void;
  readonly emitOperationalAlert: (
    eventType: "HEAT_CAP_EXCEEDED",
    title: string,
    message: string,
    metadata: JsonRecord,
    dedupeKey: string
  ) => void;
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

export interface CascadeAcceptedSignalFlowInput {
  readonly signal: CascadeRecoverySignal;
  readonly observedAt: string;
  readonly engineId: string;
  readonly equity: number;
  readonly riskPerTradePct: number;
  readonly assetProfile: CascadeAssetProfile;
  readonly currentHeat: number;
  readonly heatCapPct: number;
}

export interface CascadeAcceptedSignalFlowHandlers {
  readonly emitOperationalAlert: (
    eventType: CascadeAlertEventType,
    title: string,
    message: string,
    metadata: JsonRecord,
    dedupeKey: string
  ) => void;
  readonly registerPosition: (
    signal: CascadeRecoverySignal,
    sizeDecision: PositionSizeDecision,
    observedAt: string
  ) => CascadeOpenPosition;
  readonly buildEntryIntent: (
    signal: CascadeRecoverySignal,
    size: number,
    observedAt: string
  ) => TradeIntent;
  readonly recordUiSignal: (signal: AgentSignal, outcome: "TAKEN") => void;
  readonly traceDecision: (decision: AgentDecisionTrace) => void;
  readonly schedule: (work: Promise<void>) => void;
  readonly dispatchExecution: (intent: TradeIntent) => Promise<void>;
  readonly persistPositions: () => Promise<void>;
  readonly logWarn: (event: string, message: string, metadata: JsonRecord) => void;
}

export interface CascadeAcceptedSignalFlowResult {
  readonly sizeDecision: PositionSizeDecision;
  readonly position: CascadeOpenPosition | null;
  readonly intent: TradeIntent | null;
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

export function applyCascadeOpenPositionSideEffects(
  input: CascadeOpenPositionSideEffectInput,
  handlers: CascadeOpenPositionSideEffectHandlers
): void {
  handlers.recordUiSignal(cascadeEntryAgentSignal(input), "TAKEN");
  handlers.traceDecision(cascadeEntryDecisionTrace(input));
  handlers.schedule(handlers.dispatchExecution(input.intent));
  handlers.schedule(handlers.persistPositions());
  handlers.emitOperationalAlert(
    "POSITION_OPENED",
    "Cascade position opened",
    `${input.position.instrumentCode} ${input.position.direction} cascade position opened.`,
    cascadePositionOpenedAlertMetadata(input),
    input.position.positionId
  );
}

export function applyCascadeSignalRejectionSideEffects(
  input: CascadeSignalRejectionSideEffectInput,
  handlers: CascadeSignalRejectionSideEffectHandlers
): void {
  handlers.logInfo(
    "CASCADE_SIGNAL_REJECTED",
    "Cascade recovery signal gates rejected entry",
    cascadeSignalRejectionLogMetadata(input.rejection)
  );
  handlers.recordUiSignal(cascadeSignalRejectionAgentSignal(input), "SKIPPED");
}

export function applyCascadeSizeRejectionSideEffects(
  input: CascadeSizeRejectionSideEffectInput,
  handlers: CascadeSizeRejectionSideEffectHandlers
): void {
  handlers.logWarn(
    "CASCADE_SIZE_REJECTED",
    "Cascade recovery position sizing rejected entry",
    cascadeSizeRejectedLogMetadata(input.signal, input.sizeDecision)
  );

  if (input.sizeDecision.limitingFactor !== "HEAT") {
    return;
  }

  handlers.emitOperationalAlert(
    "HEAT_CAP_EXCEEDED",
    "Cascade heat cap blocked entry",
    `${input.signal.instrumentCode} cascade entry was rejected by the heat cap.`,
    cascadeHeatCapAlertMetadata(
      input.signal,
      input.sizeDecision,
      input.currentHeat,
      input.heatCapPct
    ),
    input.signal.signalId
  );
}

export function processAcceptedCascadeSignalFlow(
  input: CascadeAcceptedSignalFlowInput,
  handlers: CascadeAcceptedSignalFlowHandlers
): CascadeAcceptedSignalFlowResult {
  handlers.emitOperationalAlert(
    "SIGNAL_EMITTED",
    "Cascade signal emitted",
    `${input.signal.instrumentCode} ${input.signal.direction} cascade recovery signal emitted.`,
    cascadeSignalEmittedAlertMetadata(input.signal),
    input.signal.signalId
  );

  const sizeDecision = calculatePositionSize({
    equity: input.equity,
    riskPerTradePct: input.riskPerTradePct,
    entryPrice: input.signal.entryPrice,
    stopPrice: input.signal.stopPrice,
    maxPositionNotionalPct: input.assetProfile.maxPositionNotionalPct,
    assetLiquidityCap: input.assetProfile.assetLiquidityCapUsd,
    currentHeat: input.currentHeat,
    heatCapPct: input.heatCapPct
  });

  if (!sizeDecision.approved) {
    applyCascadeSizeRejectionSideEffects(
      {
        signal: input.signal,
        sizeDecision,
        currentHeat: input.currentHeat,
        heatCapPct: input.heatCapPct
      },
      {
        logWarn: handlers.logWarn,
        emitOperationalAlert: (eventType, title, message, metadata, dedupeKey) => {
          handlers.emitOperationalAlert(eventType, title, message, metadata, dedupeKey);
        }
      }
    );

    return { sizeDecision, position: null, intent: null };
  }

  const position = handlers.registerPosition(input.signal, sizeDecision, input.observedAt);
  const intent = handlers.buildEntryIntent(input.signal, sizeDecision.units, input.observedAt);
  applyCascadeOpenPositionSideEffects(
    {
      signal: input.signal,
      intent,
      engineId: input.engineId,
      position,
      assetProfile: input.assetProfile,
      sizeDecision,
      currentHeat: input.currentHeat,
      observedAt: input.observedAt
    },
    {
      recordUiSignal: handlers.recordUiSignal,
      traceDecision: handlers.traceDecision,
      schedule: handlers.schedule,
      dispatchExecution: handlers.dispatchExecution,
      persistPositions: handlers.persistPositions,
      emitOperationalAlert: (eventType, title, message, metadata, dedupeKey) => {
        handlers.emitOperationalAlert(eventType, title, message, metadata, dedupeKey);
      }
    }
  );

  return { sizeDecision, position, intent };
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
