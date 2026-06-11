import type { DwellirGrpcPayload } from "../grpc/DwellirHyperliquidGrpcClient";
import { aggregateDwellirOrders } from "./DwellirL4Book";
import type { ResolvedExchangeStreamConfig } from "./IngestConfigPrimitives";
import { coerceTimestamp } from "./IngestRecordAccess";
import { isRecord, parseJson, stringifyOrNull } from "./IngestRuntimeUtils";

export function dwellirPayloadToHyperliquidRawMessages(
  update: DwellirGrpcPayload,
  config: ResolvedExchangeStreamConfig,
  coins: string[],
  maxAgeMs: number
): Record<string, unknown>[] {
  if (update.kind === "BLOCK") {
    return [];
  }

  if (update.kind === "ORDERBOOK_SNAPSHOT") {
    return dwellirOrderbookSnapshotMessagesFromBytes(
      update.data,
      coins,
      update.receivedAt,
      maxAgeMs
    );
  }

  const decoded = decodeDwellirJsonBytes(update.data);
  if (decoded === null) {
    return [];
  }

  if (update.kind === "FILLS") {
    return dwellirFillMessages(decoded, config, coins, update.receivedAt, maxAgeMs);
  }

  return [];
}

export function classifyDwellirMalformedPayload(update: DwellirGrpcPayload): string | null {
  if (update.kind === "BLOCK") {
    return null;
  }

  const text = new TextDecoder().decode(update.data);
  const decoded = parseJson<unknown>(text);

  if (decoded === null) {
    return "INVALID_DWELLIR_PROTO_JSON_PAYLOAD";
  }

  if (update.kind === "FILLS") {
    const hasFillContainer =
      Array.isArray(decoded) ||
      (isRecord(decoded) &&
        (Array.isArray(decoded.data) ||
          Array.isArray(decoded.fills) ||
          Array.isArray(decoded.events) ||
          typeof decoded.channel === "string"));
    return hasFillContainer ? null : "UNSUPPORTED_DWELLIR_FILLS_PAYLOAD";
  }

  if (update.kind === "ORDERBOOK_SNAPSHOT") {
    const hasBookContainer =
      isRecord(decoded) &&
      (Array.isArray(decoded.data) ||
        Array.isArray(decoded.levels) ||
        Array.isArray(decoded.bids) ||
        typeof decoded.channel === "string");
    return hasBookContainer ? null : "UNSUPPORTED_DWELLIR_ORDERBOOK_PAYLOAD";
  }

  return null;
}

export function dwellirOrderbookSnapshotMessagesFromBytes(
  bytes: Uint8Array,
  coins: string[],
  receivedAt: string,
  maxAgeMs: number
): Record<string, unknown>[] {
  const text = new TextDecoder().decode(bytes);
  const timestamp = extractDwellirTopLevelField(text, "timestamp") ?? receivedAt;
  const block = extractDwellirTopLevelField(text, "block");
  const messages: Record<string, unknown>[] = [];

  if (!isDwellirPacketFresh(timestamp, receivedAt, maxAgeMs)) {
    return [];
  }

  for (const coin of coins) {
    const tupleJson = extractDwellirMarketTupleJson(text, coin.toUpperCase());
    if (!tupleJson) {
      continue;
    }

    const market = parseJson<unknown[]>(tupleJson);
    if (!Array.isArray(market) || typeof market[0] !== "string" || !Array.isArray(market[1])) {
      continue;
    }

    messages.push({
      channel: "l2Book",
      data: {
        coin: market[0].toUpperCase(),
        time: timestamp,
        sequence: block,
        levels: [
          aggregateDwellirOrders(market[1][0], receivedAt),
          aggregateDwellirOrders(market[1][1], receivedAt)
        ]
      }
    });
  }

  if (messages.length > 0) {
    return messages;
  }

  const decoded = parseJson<unknown>(text);
  return decoded === null
    ? []
    : dwellirOrderbookSnapshotMessages(decoded, coins, receivedAt, maxAgeMs);
}

export function extractDwellirMarketTupleJson(text: string, coin: string): string | null {
  const compactNeedle = `["${coin}",`;
  let start = text.indexOf(compactNeedle);

  if (start < 0) {
    const looseNeedle = `"${coin}"`;
    const coinAt = text.indexOf(looseNeedle);
    if (coinAt < 0) {
      return null;
    }
    start = text.lastIndexOf("[", coinAt);
  }

  if (start < 0 || text[start] !== "[") {
    return null;
  }

  return extractJsonArrayAt(text, start);
}

export function extractJsonArrayAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

export function extractDwellirTopLevelField(text: string, field: string): string | number | null {
  const match = new RegExp(`"${field}"\\s*:\\s*("([^"]+)"|[0-9]+)`).exec(text.slice(0, 512));
  if (!match) {
    return null;
  }

  if (match[2] !== undefined) {
    return match[2];
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function dwellirOrderbookSnapshotMessages(
  decoded: unknown,
  coins: string[],
  receivedAt: string,
  maxAgeMs: number
): Record<string, unknown>[] {
  if (isRecord(decoded) && typeof decoded.channel === "string") {
    return [decoded];
  }

  if (isRecord(decoded) && Array.isArray(decoded.data)) {
    const targets = new Set(coins.map((coin) => coin.toUpperCase()));
    const messages: Record<string, unknown>[] = [];
    const timestamp = decoded.timestamp ?? receivedAt;
    const block = decoded.block;

    if (!isDwellirPacketFresh(timestamp, receivedAt, maxAgeMs)) {
      return [];
    }

    for (const market of decoded.data) {
      if (!Array.isArray(market) || typeof market[0] !== "string" || !Array.isArray(market[1])) {
        continue;
      }

      const coin = market[0].toUpperCase();
      if (!targets.has(coin)) {
        continue;
      }

      messages.push({
        channel: "l2Book",
        data: {
          coin,
          time: timestamp,
          sequence: block,
          levels: [
            aggregateDwellirOrders(market[1][0], receivedAt),
            aggregateDwellirOrders(market[1][1], receivedAt)
          ]
        }
      });
    }

    return messages;
  }

  if (isRecord(decoded) && (Array.isArray(decoded.levels) || Array.isArray(decoded.bids))) {
    return [
      {
        channel: "l2Book",
        data: decoded
      }
    ];
  }

  return [];
}

export function dwellirFillMessages(
  decoded: unknown,
  config: ResolvedExchangeStreamConfig,
  coins: string[],
  receivedAt: string,
  maxAgeMs: number
): Record<string, unknown>[] {
  if (isRecord(decoded) && typeof decoded.channel === "string") {
    return [decoded];
  }

  const targetCoins = new Set(coins.map((coin) => coin.toUpperCase()));
  const fills = Array.isArray(decoded)
    ? decoded
    : isRecord(decoded) && Array.isArray(decoded.data)
      ? decoded.data
      : isRecord(decoded) && Array.isArray(decoded.fills)
        ? decoded.fills
        : isRecord(decoded) && Array.isArray(decoded.events)
          ? decoded.events
          : [];
  const byTradeId = new Map<string, Record<string, unknown>>();

  for (const entry of fills) {
    const fill =
      Array.isArray(entry) && isRecord(entry[1]) ? entry[1] : isRecord(entry) ? entry : null;

    if (!fill) {
      continue;
    }

    const coin =
      stringifyOrNull(fill.coin) ?? config.instrumentCode?.replace(/-usd$/i, "").toUpperCase();
    const normalizedCoin = coin?.toUpperCase();
    if (!normalizedCoin || (targetCoins.size > 0 && !targetCoins.has(normalizedCoin))) {
      continue;
    }

    if (!isDwellirPacketFresh(fill.time ?? fill.timestamp, receivedAt, maxAgeMs)) {
      continue;
    }

    const tradeId =
      stringifyOrNull(fill.tid ?? fill.id ?? fill.hash ?? fill.oid) ??
      `${normalizedCoin}:${fill.time ?? fill.timestamp ?? ""}:${fill.px ?? fill.price ?? fill.limitPx ?? ""}:${fill.sz ?? fill.size ?? ""}`;
    const normalized: Record<string, unknown> = {
      coin: normalizedCoin,
      px: fill.px ?? fill.price ?? fill.limitPx,
      sz: fill.sz ?? fill.size,
      side: fill.side,
      isBuy:
        typeof fill.isBuy === "boolean"
          ? fill.isBuy
          : typeof fill.side === "string"
            ? fill.side.toUpperCase() === "B" || fill.side.toLowerCase() === "buy"
            : undefined,
      time: fill.time ?? fill.timestamp,
      tid: fill.tid ?? fill.id ?? fill.hash ?? fill.oid,
      hash: fill.hash,
      crossed: fill.crossed,
      liquidation: fill.liquidation ?? null
    };
    const existing = byTradeId.get(tradeId);

    if (!existing || fill.crossed === true) {
      byTradeId.set(tradeId, normalized);
    }
  }

  const normalized = [...byTradeId.values()].filter(
    (fill) => fill.coin && fill.px !== undefined && fill.sz !== undefined
  );

  return normalized.length > 0 ? [{ channel: "trades", data: normalized }] : [];
}

export function isDwellirPacketFresh(
  timestampValue: unknown,
  receivedAt: string,
  maxAgeMs: number
): boolean {
  const exchangeTimestamp = coerceDwellirPayloadTime(timestampValue);
  if (!exchangeTimestamp) {
    return true;
  }

  const exchangeMs = Date.parse(exchangeTimestamp);
  const receivedMs = Date.parse(receivedAt);

  if (!Number.isFinite(exchangeMs) || !Number.isFinite(receivedMs)) {
    return true;
  }

  return Math.max(0, receivedMs - exchangeMs) <= maxAgeMs;
}

export function decodeDwellirJsonBytes(bytes: Uint8Array): unknown | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function coerceDwellirPayloadTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1_000;
    return new Date(millis).toISOString();
  }

  if (typeof value === "string") {
    const numeric = Number(value);

    if (Number.isFinite(numeric)) {
      return coerceDwellirPayloadTime(numeric);
    }
  }

  return coerceTimestamp(value);
}
