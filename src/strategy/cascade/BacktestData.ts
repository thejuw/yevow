import type { JsonRecord } from "../../types";
import type { BacktestReport, CandleRow, LiquidationRow, TimelineEvent } from "./BacktestTypes";
import type { Candle, LiquidationEvent, OpenInterestPoint } from "./types";

export function rowToCandle(row: CandleRow): Candle {
  return {
    instrumentCode: row.instrument_code.toLowerCase(),
    timeframe: "1m",
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    open: numeric(row.open),
    high: numeric(row.high),
    low: numeric(row.low),
    close: numeric(row.close),
    volume: numeric(row.volume),
    notionalVolume: numeric(row.notional_volume),
    buyVolume: numeric(row.buy_volume),
    sellVolume: numeric(row.sell_volume),
    trades: Math.round(numeric(row.trades)),
    isClosed: numeric(row.is_closed) === 1
  };
}

export function rowToLiquidation(row: LiquidationRow): LiquidationEvent | null {
  const side = row.side === "LONG" || row.side === "SHORT" ? row.side : "UNKNOWN";
  const forcedFlowSide =
    row.forced_flow_side === "BUY" || row.forced_flow_side === "SELL"
      ? row.forced_flow_side
      : "UNKNOWN";
  const price = numeric(row.price);
  const notionalUsd = numeric(row.notional_usd);
  if (side === "UNKNOWN" || price <= 0 || notionalUsd <= 0) {
    return null;
  }

  return {
    schemaVersion: "cascade.liquidation-event.v1",
    eventId: row.event_id,
    instrumentCode: row.instrument_code.toLowerCase(),
    sourceExchange: row.source_exchange,
    side,
    forcedFlowSide,
    price,
    notionalUsd,
    baseSize: numeric(row.base_size),
    exchangeTimestamp: row.exchange_timestamp,
    observedAt: row.observed_at,
    raw: parseRawJson(row.raw_json)
  };
}

export function isLiquidationEvent(value: LiquidationEvent | null): value is LiquidationEvent {
  return value !== null;
}

export function sanitizeCandles(
  candles: readonly Candle[],
  instruments: readonly string[]
): Candle[] {
  const allowed = new Set(instruments);
  return candles
    .filter((candle) => allowed.has(candle.instrumentCode.toLowerCase()) && candle.isClosed)
    .map((candle) => ({ ...candle, instrumentCode: candle.instrumentCode.toLowerCase() }));
}

export function sanitizeLiquidations(
  liquidations: readonly LiquidationEvent[],
  instruments: readonly string[]
): LiquidationEvent[] {
  const allowed = new Set(instruments);
  return liquidations
    .filter((event) => allowed.has(event.instrumentCode.toLowerCase()))
    .map((event) => ({ ...event, instrumentCode: event.instrumentCode.toLowerCase() }));
}

export function sanitizeOpenInterest(
  points: readonly OpenInterestPoint[],
  instruments: readonly string[]
): OpenInterestPoint[] {
  const allowed = new Set(instruments);
  return points
    .filter((point) => allowed.has(point.instrumentCode.toLowerCase()))
    .map((point) => ({ ...point, instrumentCode: point.instrumentCode.toLowerCase() }));
}

export function sortCandles(candles: readonly Candle[]): Candle[] {
  return [...candles].sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt));
}

export function sortLiquidations(liquidations: readonly LiquidationEvent[]): LiquidationEvent[] {
  return [...liquidations].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)
  );
}

export function sortOpenInterest(points: readonly OpenInterestPoint[]): OpenInterestPoint[] {
  return [...points].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)
  );
}

export function groupCandles(candles: readonly Candle[]): Map<string, Candle[]> {
  const grouped = new Map<string, Candle[]>();
  for (const candle of candles) {
    const key = candle.instrumentCode.toLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), candle]);
  }
  return grouped;
}

export function groupOpenInterest(
  points: readonly OpenInterestPoint[]
): Map<string, OpenInterestPoint[]> {
  const grouped = new Map<string, OpenInterestPoint[]>();
  for (const point of points) {
    const key = point.instrumentCode.toLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), point]);
  }
  return grouped;
}

export function timeline(
  candles: readonly Candle[],
  liquidations: readonly LiquidationEvent[]
): TimelineEvent[] {
  return [
    ...liquidations.map((liquidation) => ({
      kind: "LIQUIDATION" as const,
      observedAt: liquidation.observedAt,
      liquidation
    })),
    ...candles.map((candle) => ({
      kind: "CANDLE" as const,
      observedAt: candle.closedAt,
      candle
    }))
  ].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
}

export function normalizeInstruments(instruments: readonly string[]): string[] {
  return [
    ...new Set(instruments.map((instrument) => instrument.trim().toLowerCase()).filter(Boolean))
  ];
}

export function dataSource(
  requestRows: number,
  d1Rows: number
): BacktestReport["dataQuality"]["source"] {
  if (requestRows > 0 && d1Rows > 0) {
    return "MIXED";
  }
  if (requestRows > 0) {
    return "REQUEST_PAYLOAD";
  }
  if (d1Rows > 0) {
    return "D1";
  }
  return "INSUFFICIENT";
}

export function parseRawJson(value: string | null): JsonRecord {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch {
    return {};
  }
}

export function numeric(value: number | string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
