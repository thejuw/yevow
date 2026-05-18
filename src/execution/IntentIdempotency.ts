import type { TradeIntent } from "../types";

export interface StoredIntentResponse {
  status: number;
  body: unknown;
}

interface IntentLedgerEntry {
  fingerprint: string;
  response: StoredIntentResponse;
  expiresAt: number;
}

export type IdempotencyDecision =
  | { kind: "NEW"; fingerprint: string }
  | { kind: "REPLAY"; response: StoredIntentResponse }
  | { kind: "CONFLICT"; reason: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INTENT" };

const DEFAULT_TTL_MS = 5 * 60_000;

export class IntentIdempotencyLedger {
  private readonly entries = new Map<string, IntentLedgerEntry>();

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  evaluate(intent: TradeIntent, now = Date.now()): IdempotencyDecision {
    this.prune(now);
    const fingerprint = intentFingerprint(intent);
    const existing = this.entries.get(intent.intentId);

    if (!existing) {
      return { kind: "NEW", fingerprint };
    }

    if (existing.fingerprint !== fingerprint) {
      return {
        kind: "CONFLICT",
        reason: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INTENT"
      };
    }

    return {
      kind: "REPLAY",
      response: existing.response
    };
  }

  remember(
    intent: TradeIntent,
    fingerprint: string,
    response: StoredIntentResponse,
    now = Date.now()
  ): void {
    this.entries.set(intent.intentId, {
      fingerprint,
      response,
      expiresAt: now + this.ttlMs
    });
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    for (const [intentId, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(intentId);
      }
    }
  }
}

export function intentFingerprint(intent: TradeIntent): string {
  return stableStringify({
    schemaVersion: intent.schemaVersion,
    intentId: intent.intentId,
    traceId: intent.traceId,
    instrumentCode: intent.instrumentCode,
    action: intent.action,
    orderType: intent.orderType,
    postOnly: intent.postOnly,
    timeInForce: intent.timeInForce,
    expectedPrice: intent.expectedPrice,
    requestedSize: intent.requestedSize,
    approvedSize: intent.approvedSize,
    maxSlippageBps: intent.maxSlippageBps,
    targetSubaccount: intent.targetSubaccount ?? intent.target_subaccount ?? null
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
