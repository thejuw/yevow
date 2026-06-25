import type {
  DotCastEntry,
  DotCastMarketSnapshot,
  DotCastPool,
  Side,
  StakeBalance,
  StakeUnit
} from "./types";

export interface CreatePoolInput {
  id?: string;
  market: DotCastMarketSnapshot;
  unit: StakeUnit;
  entryOpensAt?: string;
  entryClosesAt: string;
  rake: number;
  minLiquidity: number;
  now: string;
}

export interface PlaceEntryInput {
  pool: DotCastPool;
  balance: StakeBalance;
  userId: string;
  side: Side;
  amount: number;
  now: string;
  entryId?: string;
}

export interface PlaceEntryResult {
  pool: DotCastPool;
  entry: DotCastEntry;
  balance: StakeBalance;
}

type TransitionTarget = DotCastPool["status"];

const LEGAL_TRANSITIONS: Record<DotCastPool["status"], ReadonlySet<TransitionTarget>> = {
  open: new Set(["locked", "voided"]),
  locked: new Set(["resolving", "voided"]),
  resolving: new Set(["settled", "voided"]),
  settled: new Set(),
  voided: new Set()
};

export function createPoolFromMarket(input: CreatePoolInput): DotCastPool {
  if (input.market.status !== "open") {
    throw new Error("pool creation requires an open market");
  }

  assertIso(input.now, "now");
  const marketCloseMs = assertIso(input.market.closeTime, "market closeTime");
  const nowMs = Date.parse(input.now);

  if (marketCloseMs <= nowMs) {
    throw new Error("pool creation refused for stale market");
  }

  const entryOpensAt = input.entryOpensAt ?? input.now;
  const entryOpenMs = assertIso(entryOpensAt, "entryOpensAt");
  const entryCloseMs = assertIso(input.entryClosesAt, "entryClosesAt");

  if (entryOpenMs > entryCloseMs) {
    throw new Error("entryOpensAt must be at or before entryClosesAt");
  }

  if (entryCloseMs > marketCloseMs) {
    throw new Error("entryClosesAt cannot be after market closeTime");
  }

  assertStakeUnit(input.unit);
  assertRake(input.rake);
  assertNonNegativeInteger(input.minLiquidity, "minLiquidity");

  const createdAt = input.now;
  return {
    id: input.id ?? derivePoolId(input.market.id, createdAt),
    marketId: input.market.id,
    venue: input.market.venue,
    unit: input.unit,
    question: input.market.question,
    status: "open",
    entryOpensAt,
    entryClosesAt: input.entryClosesAt,
    expectedResolveAt: input.market.expectedResolveAt,
    rake: input.rake,
    pools: { yes: 0, no: 0 },
    minLiquidity: input.minLiquidity,
    createdAt,
    settledAt: null,
    outcome: null
  };
}

export function placeEntry(input: PlaceEntryInput): PlaceEntryResult {
  const nowMs = assertIso(input.now, "now");
  const closesMs = assertIso(input.pool.entryClosesAt, "entryClosesAt");

  if (input.pool.status !== "open") {
    throw new Error("entries can only be placed while pool is open");
  }

  if (nowMs > closesMs) {
    throw new Error("entry window is closed");
  }

  if (input.balance.userId !== input.userId) {
    throw new Error("balance user does not match entry user");
  }

  if (input.balance.unit !== input.pool.unit) {
    throw new Error("balance unit does not match pool unit");
  }

  assertPositiveInteger(input.amount, "amount");

  if (input.balance.available < input.amount) {
    throw new Error("insufficient available balance");
  }

  const pool = {
    ...input.pool,
    pools: {
      ...input.pool.pools,
      [input.side]: input.pool.pools[input.side] + input.amount
    }
  };
  const balance = {
    ...input.balance,
    available: input.balance.available - input.amount,
    locked: input.balance.locked + input.amount
  };
  const entry: DotCastEntry = {
    id: input.entryId ?? deriveEntryId(input.pool.id, input.userId, input.now),
    poolId: input.pool.id,
    userId: input.userId,
    side: input.side,
    amount: input.amount,
    funding: "user",
    placedAt: input.now,
    payout: null,
    refunded: false
  };

  return { pool, entry, balance };
}

export function transitionPool(
  pool: DotCastPool,
  nextStatus: TransitionTarget,
  now: string,
  outcome: Side | "invalid" | null = pool.outcome
): DotCastPool {
  assertIso(now, "now");

  if (!LEGAL_TRANSITIONS[pool.status].has(nextStatus)) {
    throw new Error(`illegal pool transition ${pool.status} -> ${nextStatus}`);
  }

  if (pool.status === "open" && nextStatus === "locked") {
    const nowMs = Date.parse(now);
    const closesMs = assertIso(pool.entryClosesAt, "entryClosesAt");

    if (nowMs < closesMs) {
      throw new Error("pool cannot lock before entryClosesAt");
    }
  }

  return {
    ...pool,
    status: nextStatus,
    outcome: nextStatus === "settled" || nextStatus === "voided" ? outcome : pool.outcome,
    settledAt: nextStatus === "settled" || nextStatus === "voided" ? now : pool.settledAt
  };
}

export function lockPoolIfNeeded(pool: DotCastPool, now: string): DotCastPool {
  const nowMs = assertIso(now, "now");
  const closesMs = assertIso(pool.entryClosesAt, "entryClosesAt");

  if (pool.status !== "open" || nowMs < closesMs) {
    return pool;
  }

  return transitionPool(pool, "locked", now);
}

function derivePoolId(marketId: string, createdAt: string): string {
  return `dotcast:${marketId}:${Date.parse(createdAt)}`;
}

function deriveEntryId(poolId: string, userId: string, placedAt: string): string {
  return `${poolId}:entry:${userId}:${Date.parse(placedAt)}`;
}

function assertStakeUnit(unit: StakeUnit): void {
  if (unit !== "points" && unit !== "usdc") {
    throw new Error("unsupported stake unit");
  }
}

function assertRake(rake: number): void {
  if (!Number.isFinite(rake) || rake < 0 || rake > 1) {
    throw new RangeError("rake must be a finite fraction between 0 and 1");
  }
}

function assertPositiveInteger(value: number, label: string): void {
  assertNonNegativeInteger(value, label);

  if (value <= 0) {
    throw new RangeError(`${label} must be greater than zero`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertIso(value: string, label: string): number {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }

  return parsed;
}
