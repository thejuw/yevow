import type { JsonRecord, JsonValue } from "../../types";
import type {
  CascadeForcedFlowSide,
  CascadeLiquidationSide,
  LiquidationEvent,
  LiquidationStreamContext
} from "./types";

const DEFAULT_SOURCE_EXCHANGE = "hyperliquid";
const MAX_RAW_FIELDS = 60;

export class HyperliquidLiquidationStream {
  ingest(raw: unknown, context: LiquidationStreamContext): LiquidationEvent[] {
    const records = extractLiquidationRecords(raw);
    const events: LiquidationEvent[] = [];

    for (const record of records) {
      const event = parseLiquidationRecord(record, context);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }
}

export function isHyperliquidLiquidationMessage(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false;
  }

  const channel = normalizeString(raw.channel);
  if (
    channel === "LIQUIDATIONS" ||
    channel === "LIQUIDATION" ||
    channel === "USEREVENTS" ||
    channel === "USERNONFUNDINGLEDGERUPDATES" ||
    channel === "EVENTS"
  ) {
    return true;
  }

  return extractLiquidationRecords(raw).length > 0;
}

function extractLiquidationRecords(raw: unknown): Record<string, unknown>[] {
  const root = isRecord(raw) ? raw : null;
  if (!root) {
    return [];
  }

  const data = root.data;
  const candidates: unknown[] = [];

  if (Array.isArray(data)) {
    for (const item of data as unknown[]) {
      candidates.push(item);
    }
  } else if (isRecord(data)) {
    candidates.push(data);
    pushArrayField(candidates, data, "liquidations");
    pushArrayField(candidates, data, "events");
    pushArrayField(candidates, data, "fills");
  }

  candidates.push(root);
  pushArrayField(candidates, root, "liquidations");
  pushArrayField(candidates, root, "events");

  const liquidations: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    const record = unwrapLiquidation(candidate);
    if (record) {
      liquidations.push(record);
    }
  }

  return dedupeRecords(liquidations);
}

function pushArrayField(target: unknown[], record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      target.push(item);
    }
  }
}

function unwrapLiquidation(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  if (isRecord(value.liquidation)) {
    return value.liquidation;
  }

  if (isRecord(value.delta) && normalizeString(value.delta.type) === "LIQUIDATION") {
    return value.delta;
  }

  if (normalizeString(value.type) === "LIQUIDATION" || Array.isArray(value.liquidatedPositions)) {
    return value;
  }

  if (hasDirectLiquidationShape(value)) {
    return value;
  }

  return null;
}

function hasDirectLiquidationShape(value: Record<string, unknown>): boolean {
  const hasInstrument = stringField(value, ["coin", "asset", "symbol"]) !== null;
  const hasPrice = numericField(value, ["markPx", "price", "px"]) !== null;
  const hasNotional =
    numericField(value, [
      "liquidated_ntl_pos",
      "notionalUsd",
      "notionalUSD",
      "notional",
      "accountValue"
    ]) !== null;
  const hasSide =
    stringField(value, ["side", "liquidationSide", "liqSide", "positionSide"]) !== null ||
    numericField(value, ["szi", "size", "sz"]) !== null;

  return hasInstrument && hasPrice && hasNotional && hasSide;
}

function dedupeRecords(records: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];

  for (const record of records) {
    const key =
      stringField(record, ["lid", "hash", "eventId", "id"]) ??
      JSON.stringify({
        coin: stringField(record, ["coin"]),
        time: timestampField(record, ["time", "timestamp", "T"]),
        notional: numericField(record, ["liquidated_ntl_pos", "notionalUsd", "notional"]),
        price: numericField(record, ["markPx", "price", "px"])
      });

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(record);
  }

  return unique;
}

function parseLiquidationRecord(
  liquidation: Record<string, unknown>,
  context: LiquidationStreamContext
): LiquidationEvent | null {
  const position = firstRecord(liquidation.liquidatedPositions);
  const coin =
    stringField(position, ["coin", "asset"]) ??
    stringField(liquidation, ["coin", "asset", "symbol"]);
  const price =
    numericField(liquidation, ["markPx", "price", "px"]) ??
    numericField(position, ["markPx", "price", "px"]) ??
    context.fallbackPrice ??
    null;
  const signedSize =
    numericField(position, ["szi", "size", "sz"]) ??
    numericField(liquidation, ["szi", "size", "sz"]);
  const side = parseLiquidationSide(liquidation, signedSize);
  const notional =
    numericField(liquidation, [
      "liquidated_ntl_pos",
      "notionalUsd",
      "notionalUSD",
      "notional",
      "accountValue"
    ]) ?? (price !== null && signedSize !== null ? Math.abs(price * signedSize) : null);

  if (!coin && !context.instrumentCode) {
    return null;
  }

  if (side === "UNKNOWN" || price === null || price <= 0 || notional === null || notional <= 0) {
    return null;
  }

  const baseSize =
    signedSize !== null && signedSize !== 0 ? Math.abs(signedSize) : Math.abs(notional / price);
  const observedAt = normalizeIso(context.observedAt) ?? new Date().toISOString();
  const exchangeTimestamp = timestampField(liquidation, ["time", "timestamp", "T", "createdAt"]);
  const instrumentCode = (
    context.instrumentCode ?? (coin ? `${coin.toLowerCase()}-usd` : null)
  )?.toLowerCase();

  if (!instrumentCode) {
    return null;
  }

  return {
    schemaVersion: "cascade.liquidation-event.v1",
    eventId: liquidationEventId(liquidation, instrumentCode, side, price, notional, observedAt),
    instrumentCode,
    sourceExchange: normalizeSourceExchange(context.sourceExchange),
    side,
    forcedFlowSide: forcedFlowSide(side),
    price: round(price, 8),
    notionalUsd: round(Math.abs(notional), 2),
    baseSize: round(baseSize, 8),
    exchangeTimestamp,
    observedAt,
    raw: sanitizeRecord(liquidation)
  };
}

function parseLiquidationSide(
  liquidation: Record<string, unknown>,
  signedSize: number | null
): CascadeLiquidationSide {
  const direct = normalizeString(
    stringField(liquidation, ["side", "liquidationSide", "liqSide", "positionSide"])
  );

  if (direct.includes("LONG")) {
    return "LONG";
  }

  if (direct.includes("SHORT")) {
    return "SHORT";
  }

  if (direct === "SELL") {
    return "LONG";
  }

  if (direct === "BUY") {
    return "SHORT";
  }

  if (signedSize !== null) {
    if (signedSize > 0) {
      return "LONG";
    }
    if (signedSize < 0) {
      return "SHORT";
    }
  }

  return "UNKNOWN";
}

function forcedFlowSide(side: CascadeLiquidationSide): CascadeForcedFlowSide {
  if (side === "LONG") {
    return "SELL";
  }

  if (side === "SHORT") {
    return "BUY";
  }

  return "UNKNOWN";
}

function liquidationEventId(
  liquidation: Record<string, unknown>,
  instrumentCode: string,
  side: CascadeLiquidationSide,
  price: number,
  notionalUsd: number,
  observedAt: string
): string {
  const direct = stringField(liquidation, ["lid", "hash", "eventId", "id"]);
  if (direct) {
    return `liq:${direct}`;
  }

  return `liq:${hashString(`${instrumentCode}:${side}:${price}:${notionalUsd}:${observedAt}`)}`;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) ? (value.find(isRecord) ?? null) : null;
}

function stringField(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

function numericField(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed === "number" && Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function timestampField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    const parsed =
      typeof value === "number"
        ? new Date(value).toISOString()
        : typeof value === "string"
          ? normalizeIso(value)
          : null;
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function normalizeIso(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeSourceExchange(value: string | null | undefined): string {
  return value?.trim() ? value.trim().toLowerCase() : DEFAULT_SOURCE_EXCHANGE;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function sanitizeRecord(record: Record<string, unknown>): JsonRecord {
  const sanitized: JsonRecord = {};
  let copied = 0;

  for (const [key, value] of Object.entries(record)) {
    if (copied >= MAX_RAW_FIELDS) {
      break;
    }

    sanitized[key] = sanitizeJsonValue(value);
    copied += 1;
  }

  return sanitized;
}

function sanitizeJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map(sanitizeJsonValue);
  }

  if (isRecord(value)) {
    return sanitizeRecord(value);
  }

  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function hashString(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16);
}
