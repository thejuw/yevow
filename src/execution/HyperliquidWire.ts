import type { TradeIntent } from "../types";

export interface HyperliquidAssetMeta {
  coin: string;
  assetIndex: number;
  szDecimals: number;
  loadedAt: number;
}

export interface HyperliquidOrderWire {
  price: string;
  size: string;
  priceRounded: boolean;
  sizeRounded: boolean;
}

export function hyperliquidOrderWire(
  price: number,
  size: number,
  side: "BUY" | "SELL",
  asset: HyperliquidAssetMeta
): HyperliquidOrderWire {
  const priceDecimals = hyperliquidPriceDecimals(price, asset.szDecimals);
  const snappedPrice =
    side === "BUY"
      ? floorToDecimalPlaces(price, priceDecimals)
      : ceilToDecimalPlaces(price, priceDecimals);
  const snappedSize = floorToDecimalPlaces(size, asset.szDecimals);

  if (snappedPrice <= 0) {
    throw new Error("HYPERLIQUID_PRICE_ROUNDED_TO_ZERO");
  }
  if (snappedSize <= 0) {
    throw new Error("HYPERLIQUID_SIZE_ROUNDED_TO_ZERO");
  }

  return {
    price: hyperliquidWireNumber(snappedPrice, priceDecimals),
    size: hyperliquidWireNumber(snappedSize, asset.szDecimals),
    priceRounded: Math.abs(snappedPrice - price) >= 1e-12,
    sizeRounded: Math.abs(snappedSize - size) >= 1e-12
  };
}

export function hyperliquidCloid(value: string): string {
  const hex = value
    .replace(/[^0-9a-fA-F]/g, "")
    .padEnd(32, "0")
    .slice(0, 32);
  return `0x${hex}`;
}

export function normalizeHyperliquidCloid(value: string): string {
  return value.startsWith("0x") ? value : hyperliquidCloid(value);
}

export function normalizeOptionalAddress(value: string | null | undefined): string | null {
  if (!value || value.trim() === "") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("INVALID_HYPERLIQUID_VAULT_ADDRESS");
  }
  return normalized;
}

export function isReduceOnlyIntent(intent: TradeIntent): boolean {
  const rationale = intent.rationale.toLowerCase();
  return rationale.includes("closeout") || rationale.includes("reduce-only");
}

export function hyperliquidPriceDecimals(value: number, szDecimals: number): number {
  const maxDecimals = Math.max(0, 6 - Math.max(0, Math.trunc(szDecimals)));
  const absolute = Math.abs(value);

  if (!Number.isFinite(absolute) || absolute === 0 || Number.isInteger(absolute)) {
    return 0;
  }

  const significantFigureDecimals = Math.max(0, 5 - Math.floor(Math.log10(absolute)) - 1);

  return Math.min(maxDecimals, significantFigureDecimals);
}

function floorToDecimalPlaces(value: number, precision: number): number {
  const scale = 10 ** Math.max(0, precision);
  return Math.floor((value + Number.EPSILON) * scale) / scale;
}

function ceilToDecimalPlaces(value: number, precision: number): number {
  const scale = 10 ** Math.max(0, precision);
  return Math.ceil((value - Number.EPSILON) * scale) / scale;
}

function hyperliquidWireNumber(value: number, precision: number): string {
  const fixed = value.toFixed(Math.max(0, Math.min(12, precision)));
  const compact = fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
  return compact === "-0" || compact.length === 0 ? "0" : compact;
}
