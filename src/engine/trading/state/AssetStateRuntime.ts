import { TARGET_ASSET_MATRIX } from "../../../TradingEngineConstants";
import { normalizeNativeInstrumentCode } from "../helpers/NativeMarketIdentityRuntime";
import {
  DEFAULT_ORDER_BOOK_TICK_SIZE,
  normalizePriceToTick,
  roundMetric
} from "../book/SortedBookSide";
import type { AssetRuntimeState, EngineState, GlobalRiskConfig, MacroBias } from "../../../types";
import {
  isTargetInstrument,
  selectedMoltworkerInstruments,
  targetAssetSelectedByMoltworker
} from "./AssetSelectionRuntime";
export {
  filterTargetOrderBooks,
  isInstrumentSelectedByMoltworker,
  isTargetInstrument,
  selectedMoltworkerInstruments,
  targetAssetSelectedByMoltworker
} from "./AssetSelectionRuntime";

export function defaultQuoteState(): EngineState["quoteState"] {
  return {
    status: "ACTIVE",
    reason: null,
    suspendedUntil: null,
    lastQuote: null,
    updatedAt: null
  };
}

export function defaultAssetQuoteStates(
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): EngineState["assetQuoteStates"] {
  const selected = selectedMoltworkerInstruments(macroBias);

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const selectedByMoltworker = targetAssetSelectedByMoltworker(asset, selected);
      const active = config.TRADING_ENABLED && selectedByMoltworker;

      return [
        asset.instrumentCode,
        {
          ...defaultQuoteState(),
          status: active ? "ACTIVE" : "SUSPENDED",
          reason: active
            ? null
            : selectedByMoltworker
              ? "TRADING_DISABLED"
              : "MOLTWORKER_NOT_SELECTED",
          updatedAt: observedAt
        } satisfies EngineState["quoteState"]
      ];
    })
  );
}

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

export function normalizeAssetQuoteStates(
  stored: EngineState["assetQuoteStates"] | undefined,
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): EngineState["assetQuoteStates"] {
  const defaults = defaultAssetQuoteStates(config, macroBias, observedAt);

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const existing = stored?.[asset.instrumentCode];
      return [
        asset.instrumentCode,
        existing
          ? {
              ...defaults[asset.instrumentCode],
              ...existing,
              lastQuote: existing.lastQuote ?? defaults[asset.instrumentCode].lastQuote,
              updatedAt: existing.updatedAt ?? observedAt
            }
          : defaults[asset.instrumentCode]
      ];
    })
  );
}

export function reconcileAssetQuoteStatesForConfig(
  current: EngineState["assetQuoteStates"],
  config: GlobalRiskConfig,
  macroBias: MacroBias,
  observedAt: string
): EngineState["assetQuoteStates"] {
  const defaults = defaultAssetQuoteStates(config, macroBias, observedAt);
  const selected = selectedMoltworkerInstruments(macroBias);

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const existing = current[asset.instrumentCode] ?? defaults[asset.instrumentCode];
      const selectedByMoltworker = targetAssetSelectedByMoltworker(asset, selected);

      if (!config.TRADING_ENABLED || !selectedByMoltworker) {
        return [asset.instrumentCode, defaults[asset.instrumentCode]];
      }

      if (existing.reason === "TRADING_DISABLED" || existing.reason === "MOLTWORKER_NOT_SELECTED") {
        return [
          asset.instrumentCode,
          {
            ...existing,
            status: "ACTIVE" as const,
            reason: null,
            suspendedUntil: null,
            updatedAt: observedAt
          }
        ];
      }

      return [asset.instrumentCode, existing];
    })
  );
}

export function quoteStateForInstrumentState(
  states: EngineState["assetQuoteStates"] | undefined,
  instrumentCode: string,
  fallback: EngineState["quoteState"]
): EngineState["quoteState"] {
  const normalized = normalizeNativeInstrumentCode(instrumentCode);
  return states?.[normalized] ?? fallback;
}

export function isQuoteSuspendedAt(
  quoteState: EngineState["quoteState"],
  observedAt: string
): boolean {
  if (quoteState.status !== "SUSPENDED") {
    return false;
  }

  return (
    !quoteState.suspendedUntil || Date.parse(quoteState.suspendedUntil) > Date.parse(observedAt)
  );
}

export function suspendAssetQuoteStates(
  states: EngineState["assetQuoteStates"],
  reason: string,
  observedAt: string,
  options: {
    instrumentCode?: string;
    suspendedUntil?: string | null;
    lastQuote?: EngineState["quoteState"]["lastQuote"];
  } = {}
): EngineState["assetQuoteStates"] {
  const targets = options.instrumentCode
    ? new Set([normalizeNativeInstrumentCode(options.instrumentCode)])
    : new Set(TARGET_ASSET_MATRIX.map((asset) => asset.instrumentCode));

  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const current = states[asset.instrumentCode] ?? defaultQuoteState();
      if (!targets.has(asset.instrumentCode)) {
        return [asset.instrumentCode, current];
      }

      return [
        asset.instrumentCode,
        {
          status: "SUSPENDED" as const,
          reason,
          suspendedUntil: options.suspendedUntil ?? null,
          lastQuote: options.lastQuote ?? current.lastQuote,
          updatedAt: observedAt
        }
      ];
    })
  );
}

export function resumeExpiredAssetQuoteStates(
  states: EngineState["assetQuoteStates"],
  observedAt: string
): EngineState["assetQuoteStates"] {
  return Object.fromEntries(
    TARGET_ASSET_MATRIX.map((asset) => {
      const current = states[asset.instrumentCode] ?? defaultQuoteState();
      if (!isQuoteSuspendedAt(current, observedAt)) {
        return [
          asset.instrumentCode,
          current.status === "SUSPENDED"
            ? {
                ...current,
                status: "ACTIVE" as const,
                reason: null,
                suspendedUntil: null,
                updatedAt: observedAt
              }
            : current
        ];
      }

      return [asset.instrumentCode, current];
    })
  );
}

export function aggregateQuoteState(
  states: EngineState["assetQuoteStates"],
  previous: EngineState["quoteState"],
  observedAt: string
): EngineState["quoteState"] {
  const values = Object.values(states);
  const suspended = values.filter((state) => isQuoteSuspendedAt(state, observedAt));
  const active = values.filter((state) => !isQuoteSuspendedAt(state, observedAt));
  const previousLastQuote =
    previous.lastQuote && isTargetInstrument(previous.lastQuote.instrumentCode)
      ? previous.lastQuote
      : null;
  const lastQuote =
    values
      .map((state) => state.lastQuote)
      .filter((quote) => !quote || isTargetInstrument(quote.instrumentCode))
      .filter((quote): quote is NonNullable<EngineState["quoteState"]["lastQuote"]> =>
        Boolean(quote)
      )
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ??
    previousLastQuote;

  if (values.length > 0 && active.length === 0 && suspended.length > 0) {
    const indefinite = suspended.find((state) => !state.suspendedUntil);
    const longest = [...suspended].sort(
      (left, right) =>
        Date.parse(right.suspendedUntil ?? "9999-12-31T23:59:59.999Z") -
        Date.parse(left.suspendedUntil ?? "9999-12-31T23:59:59.999Z")
    )[0];

    return {
      status: "SUSPENDED",
      reason: indefinite?.reason ?? longest?.reason ?? "ALL_ASSET_QUOTES_SUSPENDED",
      suspendedUntil: indefinite ? null : (longest?.suspendedUntil ?? null),
      lastQuote,
      updatedAt: observedAt
    };
  }

  return {
    status: "ACTIVE",
    reason: suspended.length > 0 ? "PARTIAL_ASSET_SUSPENSION" : null,
    suspendedUntil: null,
    lastQuote,
    updatedAt: observedAt
  };
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
