import type { MarketDataSource } from "../../../types";
import type { BookSyncState } from "./BookTypes";

export interface BookSyncLookupInput {
  readonly sync: Map<string, BookSyncState>;
  readonly marketKey: string;
  readonly instrumentCode: string;
  readonly exchangeCode: string | null;
  readonly sourceExchange: string;
  readonly tickSize: number;
  readonly source: MarketDataSource;
  readonly sourceWeight: number;
}

export interface SnapshotBookSyncUpdate {
  readonly exchangeCode: string;
  readonly sourceExchange: string;
  readonly sourceWeight: number;
  readonly sequence: number;
  readonly observedAt: string;
  readonly tickSize: number;
  readonly timeToBookMs: number | null;
}

export interface DeltaBookSyncUpdate {
  readonly exchangeCode: string;
  readonly sourceExchange: string;
  readonly sourceWeight: number;
  readonly sequence: number;
  readonly observedAt: string;
  readonly wasSnapshotSeeded: boolean;
  readonly tickSize: number;
  readonly timeToBookMs: number | null;
}

export function getOrCreateBookSyncState(input: BookSyncLookupInput): BookSyncState {
  const existing = input.sync.get(input.marketKey);

  if (existing) {
    existing.exchangeCode = input.exchangeCode ?? existing.exchangeCode;
    existing.source_exchange =
      input.sourceExchange.length > 0 ? input.sourceExchange : existing.source_exchange;
    existing.tickSize = input.tickSize;
    existing.sourceWeight = input.sourceWeight;
    return existing;
  }

  const created: BookSyncState = {
    marketKey: input.marketKey,
    source: input.source,
    source_exchange: input.sourceExchange,
    sourceWeight: input.sourceWeight,
    instrumentCode: input.instrumentCode,
    exchangeCode: input.exchangeCode,
    lastSequence: null,
    lastSnapshotAt: null,
    lastDeltaAt: null,
    lastDesyncAt: null,
    desyncReason: null,
    isSynced: false,
    tickSize: input.tickSize,
    ttbLatencyMs: null,
    lastCrossCheckAt: 0
  };

  input.sync.set(input.marketKey, created);
  return created;
}

export function applySnapshotBookSyncState(
  syncState: BookSyncState,
  input: SnapshotBookSyncUpdate
): void {
  syncState.exchangeCode = input.exchangeCode;
  syncState.source_exchange = input.sourceExchange;
  syncState.sourceWeight = input.sourceWeight;
  syncState.lastSequence = input.sequence;
  syncState.lastSnapshotAt = input.observedAt;
  syncState.lastDeltaAt = null;
  syncState.lastDesyncAt = null;
  syncState.desyncReason = null;
  syncState.isSynced = true;
  syncState.tickSize = input.tickSize;
  syncState.ttbLatencyMs = input.timeToBookMs;
}

export function applyDeltaBookSyncState(
  syncState: BookSyncState,
  input: DeltaBookSyncUpdate
): void {
  syncState.exchangeCode = input.exchangeCode;
  syncState.source_exchange = input.sourceExchange;
  syncState.sourceWeight = input.sourceWeight;
  syncState.lastSequence = input.sequence;
  syncState.lastDeltaAt = input.observedAt;
  syncState.desyncReason = input.wasSnapshotSeeded ? null : "AWAITING_SNAPSHOT";
  syncState.isSynced = input.wasSnapshotSeeded;
  syncState.tickSize = input.tickSize;
  syncState.ttbLatencyMs = input.timeToBookMs;
}

export function markBookDesynced(
  syncState: BookSyncState,
  reason: string,
  observedAt: string,
  timeToBookMs: number | null
): void {
  syncState.isSynced = false;
  syncState.desyncReason = reason;
  syncState.lastDesyncAt = observedAt;
  syncState.ttbLatencyMs = timeToBookMs;
}
