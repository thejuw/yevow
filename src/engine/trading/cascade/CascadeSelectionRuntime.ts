import {
  baseAssetFromInstrument,
  normalizeNativeInstrumentCode
} from "../helpers/NativeMarketIdentityRuntime";
import type {
  AbsorptionConfirmed,
  CascadeEvent,
  CascadeOpenPosition
} from "../../../strategy/cascade/types";

export function cascadeInstrumentSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((asset) => asset.trim().toUpperCase())
      .filter((asset) => /^[A-Z0-9]{2,12}$/.test(asset))
  );
}

export function isCascadeInstrumentEnabledForConfig(
  cascadeInstruments: string,
  instrumentCode: string
): boolean {
  const enabled = cascadeInstrumentSet(cascadeInstruments);
  if (enabled.size === 0) {
    return false;
  }

  return enabled.has(baseAssetFromInstrument(instrumentCode));
}

export function latestAbsorptionForInstrument(
  absorptions: ReadonlyMap<string, AbsorptionConfirmed>,
  instrumentCode: string
): AbsorptionConfirmed | null {
  let selected: AbsorptionConfirmed | null = null;
  for (const absorption of absorptions.values()) {
    if (absorption.instrumentCode !== instrumentCode.toLowerCase()) {
      continue;
    }
    if (!selected || Date.parse(absorption.confirmedAt) > Date.parse(selected.confirmedAt)) {
      selected = absorption;
    }
  }
  return selected;
}

export function latestCascadeAtForInstrument(
  cascades: ReadonlyMap<string, CascadeEvent>,
  currentCascade: CascadeEvent
): string | null {
  let selected: string | null = null;
  for (const cascade of cascades.values()) {
    if (
      cascade.cascadeId === currentCascade.cascadeId ||
      cascade.instrumentCode !== currentCascade.instrumentCode
    ) {
      continue;
    }
    if (!selected || Date.parse(cascade.detectedAt) > Date.parse(selected)) {
      selected = cascade.detectedAt;
    }
  }
  return selected;
}

export function isOpenCascadePosition(position: CascadeOpenPosition): boolean {
  return (
    position.remainingSize > 0 &&
    position.status !== "CLOSED" &&
    position.status !== "STOPPED_OUT" &&
    position.status !== "TIME_STOPPED"
  );
}

export function recentSwingLow(candles: readonly { low: number }[]): number | null {
  if (candles.length === 0) {
    return null;
  }
  let low = Number.POSITIVE_INFINITY;
  for (const candle of candles.slice(-20)) {
    low = Math.min(low, candle.low);
  }
  return Number.isFinite(low) ? low : null;
}

export function recentSwingHigh(candles: readonly { high: number }[]): number | null {
  if (candles.length === 0) {
    return null;
  }
  let high = Number.NEGATIVE_INFINITY;
  for (const candle of candles.slice(-20)) {
    high = Math.max(high, candle.high);
  }
  return Number.isFinite(high) ? high : null;
}

export function normalizeCascadeInstrument(instrumentCode: string): string {
  return normalizeNativeInstrumentCode(instrumentCode);
}
