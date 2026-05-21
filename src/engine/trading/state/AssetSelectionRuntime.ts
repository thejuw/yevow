import { TARGET_INSTRUMENTS } from "../../../TradingEngineConstants";
import type { TARGET_ASSET_MATRIX } from "../../../TradingEngineConstants";
import type { InternalOrderBook, MacroBias } from "../../../types";
import { normalizeNativeInstrumentCode } from "../helpers/NativeMarketIdentityRuntime";

export function selectedMoltworkerInstruments(macroBias: MacroBias): Set<string> {
  return new Set(
    (macroBias.instruments ?? [])
      .filter((instrument) => typeof instrument === "string" && instrument.trim().length > 0)
      .map((instrument) => normalizeNativeInstrumentCode(instrument))
  );
}

export function isTargetInstrument(instrumentCode: string): boolean {
  return TARGET_INSTRUMENTS.has(normalizeNativeInstrumentCode(instrumentCode));
}

export function isInstrumentSelectedByMoltworker(
  instrumentCode: string,
  macroBias: MacroBias
): boolean {
  const selected = selectedMoltworkerInstruments(macroBias);
  const normalized = normalizeNativeInstrumentCode(instrumentCode);
  const coin = normalized.split("-")[0];

  return (
    selected.size === 0 ||
    selected.has(normalized) ||
    selected.has(coin) ||
    selected.has(`${coin}-perp`)
  );
}

export function filterTargetOrderBooks(
  books: Map<string, InternalOrderBook>
): Map<string, InternalOrderBook> {
  return new Map(
    [...books.entries()].filter(([, book]) => isTargetInstrument(book.instrumentCode))
  );
}

export function targetAssetSelectedByMoltworker(
  asset: (typeof TARGET_ASSET_MATRIX)[number],
  selected: ReadonlySet<string>
): boolean {
  return (
    selected.size === 0 ||
    selected.has(asset.instrumentCode) ||
    selected.has(asset.coin.toLowerCase()) ||
    selected.has(`${asset.coin.toLowerCase()}-perp`)
  );
}
