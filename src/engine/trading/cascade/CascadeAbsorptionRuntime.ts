import type { JsonRecord, MarketTick } from "../../../types";
import type { AbsorptionConfirmed, AbsorptionObservation } from "../../../strategy/cascade/types";

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
