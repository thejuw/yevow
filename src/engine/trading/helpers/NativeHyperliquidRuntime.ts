import { parseTimestampMs, roundLatency } from "./RuntimeClock";
import { toJsonValue } from "./RuntimeSerialization";
import { DEFAULT_SOURCE_WEIGHT } from "../../../TradingEngineConstants";
import type {
  EngineLocation,
  JsonRecord,
  LatencyMetrics,
  MarketTick,
  OrderBookSnapshotLevel
} from "../../../types";

interface HyperliquidRawIngestPayload {
  streamId?: string;
  source?: "HYPERLIQUID";
  source_exchange?: string;
  transport?: "websocket" | "grpc";
  exchangeCode?: string;
  instrumentCode?: string;
  sourceWeight?: number;
  connectionId?: string | null;
  receivedAt?: string;
  raw?: unknown;
  messages?: unknown[];
}

export function isNativeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nativeObject(value: unknown): Record<string, unknown> | null {
  return isNativeRecord(value) ? value : null;
}

export function nativeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function requireNativeString(value: unknown, field: string): string {
  const parsed = nativeString(value);

  if (!parsed) {
    throw new Error(`MISSING_HYPERLIQUID_${field.toUpperCase()}`);
  }

  return parsed;
}

export function nativeIso(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function nativeExchangeTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(epochMillis(value)).toISOString();
  }

  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    const numeric = Number(trimmed);

    if (Number.isFinite(numeric)) {
      return new Date(epochMillis(numeric)).toISOString();
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  return null;
}

export function epochMillis(value: number): number {
  return value > 1_000_000_000_000 ? value : value * 1_000;
}

export function nativeSequence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (Number.isSafeInteger(parsed) && parsed >= 0) {
    return parsed;
  }

  return nativeHashSequence(String(value ?? Date.now()));
}

export function nativeHashSequence(value: string): number {
  let hash = 2_166_136_261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

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

export function parseHyperliquidNativeLevels(
  levels: unknown,
  receivedAt: string
): [OrderBookSnapshotLevel[], OrderBookSnapshotLevel[]] {
  if (Array.isArray(levels)) {
    return [
      nativeBookSideLevels(levels[0], receivedAt),
      nativeBookSideLevels(levels[1], receivedAt)
    ];
  }

  if (isNativeRecord(levels)) {
    return [
      nativeBookSideLevels(levels.bids ?? levels.bid, receivedAt),
      nativeBookSideLevels(levels.asks ?? levels.ask, receivedAt)
    ];
  }

  return [[], []];
}

export function nativeBookSideLevels(value: unknown, receivedAt: string): OrderBookSnapshotLevel[] {
  const rawLevels = Array.isArray(value)
    ? value
    : isNativeRecord(value) && Array.isArray(value.levels)
      ? value.levels
      : [];
  const levels: OrderBookSnapshotLevel[] = [];

  for (const rawLevel of rawLevels) {
    let price: number | null = null;
    let size: number | null = null;

    if (Array.isArray(rawLevel)) {
      price = nativeNumber(rawLevel[0]);
      size = nativeNumber(rawLevel[1]);
    } else if (isNativeRecord(rawLevel)) {
      price = nativeNumber(rawLevel.px ?? rawLevel.price ?? rawLevel.p);
      size = nativeNumber(rawLevel.sz ?? rawLevel.size ?? rawLevel.s);
    }

    if (
      price !== null &&
      size !== null &&
      Number.isFinite(price) &&
      Number.isFinite(size) &&
      price >= 0 &&
      size >= 0
    ) {
      levels.push({ price, size, updatedAt: receivedAt });
    }
  }

  return levels;
}

export function nativeNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nativeSide(value: unknown): MarketTick["side"] {
  const side = nativeString(value)?.toUpperCase();

  if (side === "B" || side === "BUY" || side === "BID") {
    return "buy";
  }

  if (side === "A" || side === "ASK" || side === "SELL") {
    return "sell";
  }

  return "unknown";
}

export function createNativeHyperliquidBookTick(input: {
  payload: HyperliquidRawIngestPayload;
  coin: string;
  instrumentCode: string;
  exchangeCode: string;
  sourceExchange: string;
  sourceWeight: number;
  sequence: number;
  exchangeTimestamp: string;
  receivedAt: string;
  price: number;
  bestBid?: number;
  bestAsk?: number;
  rawEventType: string;
}): MarketTick {
  const instrument = splitNativeInstrument(input.instrumentCode);

  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: input.sourceExchange,
    transport: input.payload.transport ?? "websocket",
    streamId: input.payload.streamId ?? null,
    connectionId: input.payload.connectionId ?? null,
    sourceChannel: input.rawEventType,
    exchangeCode: input.exchangeCode,
    instrumentCode: input.instrumentCode,
    baseAsset: instrument.baseAsset,
    quoteAsset: instrument.quoteAsset,
    price: input.price,
    size: 0,
    side: "unknown",
    sequence: input.sequence,
    providerTimestamp: input.exchangeTimestamp,
    exchangeTimestamp: input.exchangeTimestamp,
    synchronizedExchangeTimestamp: input.exchangeTimestamp,
    clockOffsetMs: 0,
    receivedAt: input.receivedAt,
    sourceWeight: input.sourceWeight,
    bestBid: input.bestBid,
    bestAsk: input.bestAsk,
    raw: toJsonValue({
      eventType: "book-snapshot",
      nativeEventType: input.rawEventType,
      commodity: "ORDER_BOOK",
      coin: input.coin,
      streamId: input.payload.streamId ?? null,
      connectionId: input.payload.connectionId ?? null
    }) as JsonRecord
  };
}

export function createNativeHyperliquidTradeTick(
  item: Record<string, unknown>,
  payload: HyperliquidRawIngestPayload
): MarketTick {
  const receivedAt = nativeIso(payload.receivedAt) ?? new Date().toISOString();
  const coin = requireNativeString(item.coin ?? payload.instrumentCode, "coin");
  const instrumentCode = hyperliquidNativeInstrumentCode(coin, payload.instrumentCode);
  const exchangeCode = (payload.exchangeCode ?? "hyperliquid").toLowerCase();
  const sourceExchange = normalizeSourceExchange(payload.source_exchange ?? "hyperliquid");
  const sourceWeight = normalizeSourceWeight(payload.sourceWeight);
  const price = nativeNumber(item.px ?? item.price ?? item.p);
  const size = nativeNumber(item.sz ?? item.size ?? item.s);
  const isBuy = typeof item.isBuy === "boolean" ? item.isBuy : null;
  const side = isBuy === null ? nativeSide(item.side) : isBuy ? "buy" : "sell";

  if (price === null || price < 0) {
    throw new Error("INVALID_HYPERLIQUID_TRADE_PRICE");
  }

  if (size === null || size < 0) {
    throw new Error("INVALID_HYPERLIQUID_TRADE_SIZE");
  }

  const exchangeTimestamp =
    nativeExchangeTimestamp(item.time ?? item.timestamp ?? item.T) ?? receivedAt;
  const sequence = nativeSequence(
    item.tid ??
      item.id ??
      item.hash ??
      `${coin}:${exchangeTimestamp}:${price}:${size}:${item.side ?? ""}`
  );
  const instrument = splitNativeInstrument(instrumentCode);

  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: sourceExchange,
    transport: payload.transport ?? "websocket",
    streamId: payload.streamId ?? null,
    connectionId: payload.connectionId ?? null,
    sourceChannel: "trades",
    exchangeCode,
    instrumentCode,
    baseAsset: instrument.baseAsset,
    quoteAsset: instrument.quoteAsset,
    price,
    size,
    side,
    sequence,
    providerTimestamp: exchangeTimestamp,
    exchangeTimestamp,
    synchronizedExchangeTimestamp: exchangeTimestamp,
    clockOffsetMs: 0,
    receivedAt,
    sourceWeight,
    raw: toJsonValue({
      eventType: "trade",
      commodity: "TRADE",
      coin,
      tradeId: item.tid ?? item.id ?? null,
      tradeHash: item.hash ?? null,
      aggressorSide: item.side ?? null,
      isBuy: isBuy ?? (side === "unknown" ? null : side === "buy"),
      streamId: payload.streamId ?? null,
      connectionId: payload.connectionId ?? null
    }) as JsonRecord
  };
}

export function createNativeHyperliquidFundingTick(
  data: Record<string, unknown>,
  payload: HyperliquidRawIngestPayload
): MarketTick {
  const ctx = nativeObject(data.ctx) ?? data;
  const receivedAt = nativeIso(payload.receivedAt) ?? new Date().toISOString();
  const coin = requireNativeString(data.coin ?? payload.instrumentCode, "coin");
  const instrumentCode = hyperliquidNativeInstrumentCode(coin, payload.instrumentCode);
  const exchangeCode = (payload.exchangeCode ?? "hyperliquid").toLowerCase();
  const sourceExchange = normalizeSourceExchange(payload.source_exchange ?? "hyperliquid");
  const sourceWeight = normalizeSourceWeight(payload.sourceWeight);
  const markPrice = nativeNumber(ctx.markPx ?? ctx.markPrice);
  const oraclePrice = nativeNumber(ctx.oraclePx ?? ctx.oraclePrice);
  const midPrice = nativeNumber(ctx.midPx ?? ctx.midPrice);
  const price = midPrice ?? markPrice ?? oraclePrice ?? 0;
  const exchangeTimestamp =
    nativeExchangeTimestamp(data.time ?? data.timestamp ?? ctx.time) ?? receivedAt;
  const fundingRateHourly = nativeNumber(ctx.funding ?? ctx.fundingRate) ?? 0;
  const openInterest = nativeNumber(ctx.openInterest);
  const sequence = nativeSequence(`${coin}:${exchangeTimestamp}:funding`);
  const instrument = splitNativeInstrument(instrumentCode);

  return {
    schemaVersion: "universal-tick.v1",
    source: "HYPERLIQUID",
    source_exchange: sourceExchange,
    transport: payload.transport ?? "websocket",
    streamId: payload.streamId ?? null,
    connectionId: payload.connectionId ?? null,
    sourceChannel: "activeAssetCtx",
    exchangeCode,
    instrumentCode,
    baseAsset: instrument.baseAsset,
    quoteAsset: instrument.quoteAsset,
    price,
    size: 0,
    side: "unknown",
    sequence,
    providerTimestamp: exchangeTimestamp,
    exchangeTimestamp,
    synchronizedExchangeTimestamp: exchangeTimestamp,
    clockOffsetMs: 0,
    receivedAt,
    sourceWeight,
    fundingRateHourly,
    markPrice: markPrice ?? undefined,
    oraclePrice: oraclePrice ?? undefined,
    openInterest: openInterest ?? undefined,
    raw: toJsonValue({
      eventType: "funding",
      commodity: "FUNDING",
      coin,
      fundingRateHourly,
      markPrice,
      oraclePrice,
      openInterest,
      premium: ctx.premium ?? null,
      dayNtlVlm: ctx.dayNtlVlm ?? null,
      streamId: payload.streamId ?? null,
      connectionId: payload.connectionId ?? null
    }) as JsonRecord
  };
}

export function nativeHyperliquidLatencyMetrics(input: {
  instrumentCode: string;
  exchangeCode: string;
  sourceExchange: string;
  sourceWeight: number;
  sequence: number;
  exchangeTimestamp: string;
  receivedAt: string;
  brainTimestamp: string;
  totalLatencyMs: number;
  maxLatencyMs: number;
  averageLatencyMs: number;
  sampleCount: number;
  location: EngineLocation;
}): LatencyMetrics {
  const rawIngestMs = parseTimestampMs(input.receivedAt, "ingest_timestamp");
  const sourceMs = parseTimestampMs(input.exchangeTimestamp, "provider_timestamp");
  const brainMs = parseTimestampMs(input.brainTimestamp, "brain_timestamp");
  const ingestClockSkewMs = Math.max(0, rawIngestMs - brainMs);
  const ingestMs = ingestClockSkewMs > 0 ? brainMs : rawIngestMs;
  const ingestTimestamp = ingestClockSkewMs > 0 ? input.brainTimestamp : input.receivedAt;
  const totalLatencyMs = roundLatency(Math.max(0, input.totalLatencyMs));

  return {
    instrumentCode: input.instrumentCode,
    exchangeCode: input.exchangeCode,
    source: "HYPERLIQUID",
    sourceExchange: input.sourceExchange,
    sourceWeight: input.sourceWeight,
    sequence: input.sequence,
    providerTimestamp: input.exchangeTimestamp,
    sourceTimestamp: input.exchangeTimestamp,
    ingestTimestamp,
    brainTimestamp: input.brainTimestamp,
    clockOffsetMs: ingestClockSkewMs,
    networkLatencyMs: roundLatency(Math.max(0, ingestMs - sourceMs)),
    processingLatencyMs: roundLatency(Math.max(0, brainMs - ingestMs)),
    totalLatencyMs,
    maxLatencyMs: input.maxLatencyMs,
    averageLatencyMs: input.averageLatencyMs,
    sampleCount: input.sampleCount,
    status: totalLatencyMs > input.maxLatencyMs ? "STALE" : "FRESH",
    colo: input.location.colo,
    placement: input.location.placement,
    latencyRiskMultiplier: input.location.latencyRiskMultiplier,
    positionSizeMultiplier: input.location.positionSizeMultiplier,
    timeToBookMs: null
  };
}
