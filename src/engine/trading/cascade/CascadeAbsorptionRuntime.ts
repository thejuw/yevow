import type { GlobalRiskConfig, JsonRecord, MarketTick } from "../../../types";
import type {
  AbsorptionAnalyzerConfig,
  AbsorptionConfirmed,
  AbsorptionObservation
} from "../../../strategy/cascade/types";
import { normalizeNativeInstrumentCode } from "../helpers/NativeMarketIdentityRuntime";
import { isTradeTick } from "../state/TickClassification";
import {
  absorptionAnalyzerConfigForTarget,
  type TradingCascadeRuntimeConfigTarget
} from "./CascadeConfigRuntime";
import { isCascadeInstrumentEnabledForConfig } from "./CascadeSelectionRuntime";
import {
  emitTradingCascadeOperationalAlertForTarget,
  type TradingSignalBusTarget
} from "../telemetry/TradingSignalBusRuntime";
import { publishTradingTelemetryForTarget } from "../telemetry/TelemetryBus";

export interface CascadeAbsorptionObservationInput {
  readonly tick: Pick<MarketTick, "side" | "price" | "size" | "receivedAt" | "openInterest">;
  readonly instrumentCode: string;
  readonly cumulativeVolumeDelta: number;
}

export interface CascadeAbsorptionConfirmedSideEffectHandlers {
  readonly recordAbsorption: (confirmed: AbsorptionConfirmed) => void;
  readonly logInfo: (event: string, message: string, metadata: JsonRecord) => void;
  readonly publish: (telemetryType: "ABSORPTION_CONFIRMED", payload: JsonRecord) => void;
  readonly emitOperationalAlert: (
    eventType: "CASCADE_ABSORPTION_CONFIRMED",
    title: string,
    message: string,
    metadata: JsonRecord,
    dedupeKey: string
  ) => void;
}

export interface TradingCascadeAbsorptionInput {
  readonly tick: MarketTick;
  readonly cascadeInstruments: string;
}

export interface TradingCascadeAbsorptionHandlers extends CascadeAbsorptionConfirmedSideEffectHandlers {
  readonly readCumulativeVolumeDelta: (instrumentCode: string) => number | undefined;
  readonly writeCumulativeVolumeDelta: (
    instrumentCode: string,
    cumulativeVolumeDelta: number
  ) => void;
  readonly configureAnalyzer: () => void;
  readonly observeAbsorption: (observation: AbsorptionObservation) => AbsorptionConfirmed | null;
}

export interface TradingCascadeAbsorptionTarget {
  readonly cachedConfig: Pick<GlobalRiskConfig, "CASCADE_INSTRUMENTS">;
  readonly cascadeCvdByInstrument: Pick<Map<string, number>, "get" | "set">;
  readonly absorptionAnalyzer: {
    configure(config: AbsorptionAnalyzerConfig): void;
    observe(observation: AbsorptionObservation): AbsorptionConfirmed | null;
  };
  readonly cascadeAbsorptionsById: Pick<Map<string, AbsorptionConfirmed>, "set">;
  readonly logger: {
    info(event: string, message: string, metadata: JsonRecord): void;
  };
  publish?(telemetryType: "ABSORPTION_CONFIRMED", payload: JsonRecord): void;
  emitCascadeOperationalAlert?(
    eventType: "CASCADE_ABSORPTION_CONFIRMED",
    title: string,
    message: string,
    metadata: JsonRecord,
    dedupeKey: string
  ): void;
}

export function cascadeAbsorptionSignedNotional(
  tick: Pick<MarketTick, "side" | "price" | "size">
): number {
  if (tick.side === "buy") {
    return tick.price * tick.size;
  }

  if (tick.side === "sell") {
    return -tick.price * tick.size;
  }

  return 0;
}

export function nextCascadeCvd(
  previousCvd: number,
  tick: Pick<MarketTick, "side" | "price" | "size">
): number {
  return previousCvd + cascadeAbsorptionSignedNotional(tick);
}

export function buildCascadeAbsorptionObservation(
  input: CascadeAbsorptionObservationInput
): AbsorptionObservation {
  return {
    instrumentCode: input.instrumentCode,
    observedAt: input.tick.receivedAt,
    price: input.tick.price,
    takerBuyVolume: input.tick.side === "buy" ? Math.max(0, input.tick.size) : 0,
    takerSellVolume: input.tick.side === "sell" ? Math.max(0, input.tick.size) : 0,
    cumulativeVolumeDelta: input.cumulativeVolumeDelta,
    openInterest: typeof input.tick.openInterest === "number" ? input.tick.openInterest : null
  };
}

export function absorptionConfirmedLogMetadata(confirmed: AbsorptionConfirmed): JsonRecord {
  return {
    eventType: "ABSORPTION_CONFIRMED",
    cascadeId: confirmed.cascadeId,
    instrumentCode: confirmed.instrumentCode,
    direction: confirmed.direction,
    elapsedMs: confirmed.elapsedMs,
    price: confirmed.price,
    priceHeld: confirmed.criteria.priceHeld,
    takerExhaustion: confirmed.criteria.takerExhaustion,
    cvdReversal: confirmed.criteria.cvdReversal,
    openInterestStabilized: confirmed.criteria.openInterestStabilized,
    observations: confirmed.observations
  };
}

export function absorptionConfirmedTelemetryPayload(confirmed: AbsorptionConfirmed): JsonRecord {
  return {
    schemaVersion: confirmed.schemaVersion,
    cascadeId: confirmed.cascadeId,
    instrumentCode: confirmed.instrumentCode,
    direction: confirmed.direction,
    confirmedAt: confirmed.confirmedAt,
    elapsedMs: confirmed.elapsedMs,
    price: confirmed.price,
    priceHeld: confirmed.criteria.priceHeld,
    takerExhaustion: confirmed.criteria.takerExhaustion,
    cvdReversal: confirmed.criteria.cvdReversal,
    openInterestStabilized: confirmed.criteria.openInterestStabilized,
    observations: confirmed.observations
  };
}

export function absorptionConfirmedAlertMetadata(confirmed: AbsorptionConfirmed): JsonRecord {
  return {
    cascadeId: confirmed.cascadeId,
    instrumentCode: confirmed.instrumentCode,
    direction: confirmed.direction,
    elapsedMs: confirmed.elapsedMs,
    price: confirmed.price,
    confirmedAt: confirmed.confirmedAt
  };
}

export function applyCascadeAbsorptionConfirmedSideEffects(
  confirmed: AbsorptionConfirmed,
  handlers: CascadeAbsorptionConfirmedSideEffectHandlers
): void {
  handlers.recordAbsorption(confirmed);
  handlers.logInfo(
    "ABSORPTION_CONFIRMED",
    "Liquidation cascade absorption confirmed",
    absorptionConfirmedLogMetadata(confirmed)
  );
  handlers.publish("ABSORPTION_CONFIRMED", absorptionConfirmedTelemetryPayload(confirmed));
  handlers.emitOperationalAlert(
    "CASCADE_ABSORPTION_CONFIRMED",
    "Cascade absorption confirmed",
    `${confirmed.instrumentCode} absorption confirmed after ${confirmed.elapsedMs}ms.`,
    absorptionConfirmedAlertMetadata(confirmed),
    confirmed.cascadeId
  );
}

export function observeTradingCascadeAbsorption(
  input: TradingCascadeAbsorptionInput,
  handlers: TradingCascadeAbsorptionHandlers
): AbsorptionConfirmed | null {
  if (!isTradeTick(input.tick) || !Number.isFinite(input.tick.price) || input.tick.price <= 0) {
    return null;
  }

  const instrumentCode = normalizeNativeInstrumentCode(input.tick.instrumentCode);
  if (!isCascadeInstrumentEnabledForConfig(input.cascadeInstruments, instrumentCode)) {
    return null;
  }

  const cumulativeVolumeDelta = nextCascadeCvd(
    handlers.readCumulativeVolumeDelta(instrumentCode) ?? 0,
    input.tick
  );
  handlers.writeCumulativeVolumeDelta(instrumentCode, cumulativeVolumeDelta);

  handlers.configureAnalyzer();
  const confirmed = handlers.observeAbsorption(
    buildCascadeAbsorptionObservation({
      tick: input.tick,
      instrumentCode,
      cumulativeVolumeDelta
    })
  );

  if (!confirmed) {
    return null;
  }

  applyCascadeAbsorptionConfirmedSideEffects(confirmed, handlers);
  return confirmed;
}

export function observeTradingEngineCascadeAbsorption(
  tick: MarketTick,
  target: TradingCascadeAbsorptionTarget
): AbsorptionConfirmed | null {
  return observeTradingCascadeAbsorption(
    {
      tick,
      cascadeInstruments: target.cachedConfig.CASCADE_INSTRUMENTS
    },
    {
      readCumulativeVolumeDelta: (instrumentCode) =>
        target.cascadeCvdByInstrument.get(instrumentCode),
      writeCumulativeVolumeDelta: (instrumentCode, cumulativeVolumeDelta) => {
        target.cascadeCvdByInstrument.set(instrumentCode, cumulativeVolumeDelta);
      },
      configureAnalyzer: () => {
        target.absorptionAnalyzer.configure(
          absorptionAnalyzerConfigForTarget({
            cachedConfig: target.cachedConfig,
            env: (target as unknown as { env?: TradingCascadeRuntimeConfigTarget["env"] }).env ?? {}
          } as TradingCascadeRuntimeConfigTarget)
        );
      },
      observeAbsorption: (observation) => target.absorptionAnalyzer.observe(observation),
      recordAbsorption: (confirmedAbsorption) => {
        target.cascadeAbsorptionsById.set(confirmedAbsorption.cascadeId, confirmedAbsorption);
      },
      logInfo: (event, message, metadata) => {
        target.logger.info(event, message, metadata);
      },
      publish: (telemetryType, payload) => {
        publishTradingTelemetryForTarget(target, telemetryType, payload);
      },
      emitOperationalAlert: (eventType, title, message, metadata, dedupeKey) => {
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
    }
  );
}
