import { DEFAULT_SOURCE_WEIGHT } from "../../../TradingEngineConstants";

export function hyperliquidNativeInstrumentCode(coin: string, fallback?: string | null): string {
  const fallbackCode =
    typeof fallback === "string" && fallback.trim() !== ""
      ? normalizeNativeInstrumentCode(fallback)
      : null;
  const normalizedCoin = normalizeNativeCoin(coin);

  if (fallbackCode) {
    const [fallbackBase] = splitNativeInstrument(fallbackCode).baseAsset.split("-");
    const coinBase = normalizedCoin.toLowerCase();

    if (fallbackCode.includes(coinBase) || fallbackBase === coinBase) {
      return fallbackCode;
    }
  }

  return `${normalizedCoin.toLowerCase()}-usd`;
}

export function normalizeNativeCoin(value: string): string {
  return value
    .trim()
    .replace(/-perp$/i, "")
    .replace(/-usd$/i, "")
    .replace(/-usdc$/i, "")
    .replace(/-usdt$/i, "")
    .toUpperCase();
}

export function normalizeNativeInstrumentCode(value: string): string {
  return value
    .trim()
    .replace(/_/g, "-")
    .replace(/\//g, "-")
    .replace(/-perp$/i, "")
    .toLowerCase();
}

export function normalizeInstrumentSelector(value: string): string {
  const rawInstrument = value.includes(":") ? value.split(":").slice(1).join(":") : value;
  const normalized = normalizeNativeInstrumentCode(rawInstrument);

  if (!normalized.includes("-")) {
    return `${normalizeNativeCoin(normalized).toLowerCase()}-usd`;
  }

  return normalized;
}

export function splitNativeInstrument(instrumentCode: string): {
  baseAsset: string;
  quoteAsset: string;
} {
  const normalized = normalizeNativeInstrumentCode(instrumentCode);
  const [baseAsset, ...quoteParts] = normalized.split("-");

  return {
    baseAsset: baseAsset || "unknown",
    quoteAsset: quoteParts.join("-") || "usd"
  };
}

export function baseAssetFromInstrument(instrumentCode: string): string {
  return splitNativeInstrument(instrumentCode).baseAsset.toUpperCase();
}

export function normalizeSourceExchange(value: string | null | undefined): string {
  return (value ?? "unknown").trim().toLowerCase() || "unknown";
}

export function normalizeSourceWeight(value: number | null | undefined): number {
  return Number.isFinite(value) && value !== null && value !== undefined && value > 0
    ? value
    : DEFAULT_SOURCE_WEIGHT;
}
