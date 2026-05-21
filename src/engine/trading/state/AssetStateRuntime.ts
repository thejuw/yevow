import { TARGET_ASSET_MATRIX } from "../../../TradingEngineConstants";
import {
  DEFAULT_ORDER_BOOK_TICK_SIZE,
  normalizePriceToTick,
  roundMetric
} from "../book/SortedBookSide";
import type { AssetRuntimeState, GlobalRiskConfig, MacroBias } from "../../../types";
import {
  selectedMoltworkerInstruments,
  targetAssetSelectedByMoltworker
} from "./AssetSelectionRuntime";
export {
  aggregateQuoteState,
  defaultAssetQuoteStates,
  defaultQuoteState,
  isQuoteSuspendedAt,
  normalizeAssetQuoteStates,
  quoteStateForInstrumentState,
  reconcileAssetQuoteStatesForConfig,
  resumeExpiredAssetQuoteStates,
  suspendAssetQuoteStates
} from "./AssetQuoteStateRuntime";
export {
  filterTargetOrderBooks,
  isInstrumentSelectedByMoltworker,
  isTargetInstrument,
  selectedMoltworkerInstruments,
  targetAssetSelectedByMoltworker
} from "./AssetSelectionRuntime";

export function normalizeAssetMatrix(
  stored: Record<string, AssetRuntimeState> | undefined,
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): Record<string, AssetRuntimeState> {
  const defaults = defaultAssetMatrix(config, macroBias, observedAt);

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const existing = stored?.[asset.instrumentCode];
      return [
        asset.instrumentCode,
        existing
          ? {
              ...defaults[asset.instrumentCode],
              ...existing,
              instrumentCode: asset.instrumentCode,
              coin: asset.coin,
              updatedAt: existing.updatedAt ?? observedAt
            }
          : defaults[asset.instrumentCode]
      ];
    })
  );
}

export function defaultAssetMatrix(
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): Record<string, AssetRuntimeState> {
  const selected = selectedMoltworkerInstruments(macroBias);
  const selectedCount =
    selected.size > 0
      ? TARGET_ASSET_MATRIX.filter(
          (asset) =>
            selected.has(asset.instrumentCode) ||
            selected.has(asset.coin.toLowerCase()) ||
            selected.has(`${asset.coin.toLowerCase()}-perp`)
        ).length
      : TARGET_ASSET_MATRIX.length;
  const allocation = selectedCount > 0 ? 1 / selectedCount : 0;

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const selectedByMoltworker = targetAssetSelectedByMoltworker(asset, selected);

      return [
        asset.instrumentCode,
        {
          instrumentCode: asset.instrumentCode,
          coin: asset.coin,
          selectedByMoltworker,
          active: false,
          isSynced: false,
          lastSequence: null,
          midPrice: null,
          volatility: 0.01,
          capitalAllocationPct: selectedByMoltworker ? roundMetric(allocation, 8) : 0,
          maxNotional: 0,
          toxicityState: "NORMAL",
          amVpin: 0,
          obi: null,
          quoteStatus: config.TRADING_ENABLED ? "ACTIVE" : "SUSPENDED",
          quoteReason: config.TRADING_ENABLED ? null : "TRADING_DISABLED",
          quoteSuspendedUntil: null,
          quoteEligible: config.TRADING_ENABLED && selectedByMoltworker,
          lastQuoteAt: null,
          updatedAt: observedAt
        } satisfies AssetRuntimeState
      ];
    })
  );
}

export function quotePriceMovedTicks(
  previous: number | null,
  next: number | null,
  tickSize: number
): number {
  if (previous === null || next === null) {
    return previous === next ? 0 : Number.POSITIVE_INFINITY;
  }

  const safeTick = Math.max(tickSize, DEFAULT_ORDER_BOOK_TICK_SIZE);
  return Math.abs(next - previous) / safeTick;
}

export function adverseAdjustedPaperFillPrice(
  side: "BUY" | "SELL",
  price: number,
  adverseBps: number,
  tickSize: number
): number {
  const adjusted =
    side === "BUY" ? price * (1 + adverseBps / 10_000) : price * (1 - adverseBps / 10_000);

  return normalizePriceToTick(
    Math.max(tickSize, adjusted),
    Math.max(tickSize, DEFAULT_ORDER_BOOK_TICK_SIZE),
    side === "BUY" ? "CEIL" : "FLOOR"
  );
}

export function normalizeMarketKey(value: string): string {
  return value.toLowerCase();
}
