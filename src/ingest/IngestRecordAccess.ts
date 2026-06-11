import type { MarketTick } from "../types";
import { isRecord, normalizeString, parseJson } from "./IngestRuntimeUtils";

export function readField(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }

  return undefined;
}

export function readStringField(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  const value = readField(record, keys);
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function inferSubscriptionField(
  subscription: string | undefined,
  field: "code" | "exchange"
): string | null {
  if (!subscription) {
    return null;
  }

  const parsed = parseJson<{ instrumentCriteria?: Record<string, unknown> }>(subscription);
  const value = parsed?.instrumentCriteria?.[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function normalizeSide(
  side: string | undefined,
  updateType: string | null
): MarketTick["side"] {
  const normalizedSide = normalizeString(side);

  if (normalizedSide === "BUY") {
    return "buy";
  }

  if (normalizedSide === "SELL") {
    return "sell";
  }

  if (updateType === "BEST_BID") {
    return "buy";
  }

  if (updateType === "BEST_ASK") {
    return "sell";
  }

  return "unknown";
}

export function splitInstrumentCode(instrumentCode: string): {
  baseAsset: string;
  quoteAsset: string;
} {
  const [baseAsset, ...quoteParts] = instrumentCode.split("-");

  return {
    baseAsset: baseAsset || "unknown",
    quoteAsset: quoteParts.join("-") || "unknown"
  };
}

export function coerceSequence(
  sequenceId: string | undefined,
  additionalProperties: Record<string, unknown> | null | undefined
): number {
  const additionalSequence = additionalProperties?.sequence;
  const numericSequence = Number(additionalSequence ?? sequenceId);

  if (Number.isSafeInteger(numericSequence) && numericSequence >= 0) {
    return numericSequence;
  }

  return hashSequenceId(sequenceId ?? JSON.stringify(additionalProperties ?? {}));
}

export function hashSequenceId(value: string): number {
  let hash = 2_166_136_261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

export function coerceTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value) && typeof value.value === "string") {
    return value.value;
  }

  return null;
}

export function isPong(raw: unknown): boolean {
  if (Array.isArray(raw)) {
    return false;
  }

  if (!isRecord(raw)) {
    return false;
  }

  const eventType = normalizeString(raw.type ?? raw.event);
  const channel = normalizeString(raw.channel);
  return eventType === "PONG" || eventType === "HEARTBEAT" || channel === "PONG";
}

export function isHyperliquidControlMessage(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false;
  }

  const channel = normalizeString(raw.channel);
  return channel === "SUBSCRIPTIONRESPONSE" || channel === "PONG";
}

export function extractHeartbeatLatencyMs(raw: unknown): number {
  if (!isRecord(raw)) {
    return 0;
  }

  const sentAt = coerceTimestamp(raw.ts ?? raw.sentAt ?? raw.pingTs);
  if (!sentAt) {
    return 0;
  }

  const parsed = Date.parse(sentAt);
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : 0;
}
